[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourceBackupPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")

$operation = "create-recovery-baseline"
$expectedOpenClawVersion = "2026.5.4"
$lockStream = $null
$stagingPath = $null
$targetPath = $null

function Resolve-AsukaUniqueRecoverySource {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$Candidates,
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$File
  )

  $matches = @()
  foreach ($relative in $Candidates) {
    $candidate = Resolve-AsukaChildPath -Root $Root -Relative $relative
    $pathType = if ($File) { "Leaf" } else { "Container" }
    if (Test-Path -LiteralPath $candidate -PathType $pathType) {
      $matches += $candidate
    }
  }
  if ($matches.Count -eq 0) {
    throw "Legacy recovery source has no allowlisted $Name layout."
  }
  if ($matches.Count -ne 1) {
    throw "Legacy recovery source has an ambiguous $Name layout."
  }
  if ($File) {
    [void](Assert-AsukaNoReparsePointPath -Root $Root -Path $matches[0])
  } else {
    Assert-AsukaNoReparsePointsInTree -Path $matches[0]
  }
  return [string]$matches[0]
}

function Copy-AsukaRecoveryTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Name
  )

  Copy-AsukaTree -Source $Source -Destination $Destination
  $sourceIntegrity = Get-AsukaDirectoryIntegrity -Path $Source
  $stagedIntegrity = Get-AsukaDirectoryIntegrity -Path $Destination
  if (
    [int]$sourceIntegrity.fileCount -ne [int]$stagedIntegrity.fileCount -or
    [int64]$sourceIntegrity.bytes -ne [int64]$stagedIntegrity.bytes -or
    [string]$sourceIntegrity.sha256 -cne [string]$stagedIntegrity.sha256
  ) {
    throw "Staged recovery $Name tree does not match its legacy source."
  }
  return [pscustomobject]@{
    fileCount = [int]$stagedIntegrity.fileCount
    bytes = [int64]$stagedIntegrity.bytes
    sha256 = [string]$stagedIntegrity.sha256
  }
}

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  $AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $backupRoot = [IO.Path]::GetFullPath(
    (Join-Path $AppRoot "backups")
  ).TrimEnd("\")
  $sourceRoot = [IO.Path]::GetFullPath($SourceBackupPath).TrimEnd("\")
  if (
    -not $sourceRoot.StartsWith(
      "$backupRoot\",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not (Test-Path -LiteralPath $sourceRoot -PathType Container)
  ) {
    throw "SourceBackupPath must be an existing child of the Asuka backups directory."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $backupRoot -Path $sourceRoot)

  $sources = [ordered]@{
    home = Resolve-AsukaUniqueRecoverySource -Root $sourceRoot `
      -Name "home" -Candidates @("home", "snapshot\home")
    project = Resolve-AsukaUniqueRecoverySource -Root $sourceRoot `
      -Name "project" -Candidates @("project", "snapshot\project")
    openClaw = Resolve-AsukaUniqueRecoverySource -Root $sourceRoot `
      -Name "OpenClaw" -Candidates @(
        "tools\node_modules\openclaw",
        "openclaw",
        "snapshot\tools\node_modules\openclaw",
        "snapshot\openclaw"
      )
    gatewayScript = Resolve-AsukaUniqueRecoverySource -Root $sourceRoot `
      -Name "Gateway script" -File -Candidates @(
        "asuka-gateway-task.ps1",
        "root-files\asuka-gateway-task.ps1",
        "scripts\asuka-gateway-task.ps1",
        "snapshot\root-files\asuka-gateway-task.ps1",
        "snapshot\scripts\asuka-gateway-task.ps1"
      )
    vaultMemory = Resolve-AsukaUniqueRecoverySource -Root $sourceRoot `
      -Name "Vault memory" -Candidates @(
        "obsidian-vault\Asuka\Memory",
        "vault\Asuka\Memory",
        "snapshot\obsidian-vault\Asuka\Memory",
        "snapshot\vault\Asuka\Memory"
      )
  }
  $openClawPackagePath = Join-Path $sources.openClaw "package.json"
  if (-not (Test-Path -LiteralPath $openClawPackagePath -PathType Leaf)) {
    throw "Legacy recovery source has no OpenClaw package manifest."
  }
  $openClawPackage = Get-Content -LiteralPath $openClawPackagePath `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$openClawPackage.version -cne $expectedOpenClawVersion) {
    throw "Legacy recovery source must contain OpenClaw $expectedOpenClawVersion."
  }

  $baselineRoot = Join-Path $backupRoot "recovery-baselines"
  New-Item -ItemType Directory -Force -Path $baselineRoot | Out-Null
  $stagingPath = Join-Path $baselineRoot (
    ".import-{0}" -f [Guid]::NewGuid().ToString("N")
  )
  New-Item -ItemType Directory -Path $stagingPath | Out-Null

  $treeIntegrity = [ordered]@{
    home = Copy-AsukaRecoveryTree -Source $sources.home `
      -Destination (Join-Path $stagingPath "home") -Name "home"
    project = Copy-AsukaRecoveryTree -Source $sources.project `
      -Destination (Join-Path $stagingPath "project") -Name "project"
    openClaw = Copy-AsukaRecoveryTree -Source $sources.openClaw `
      -Destination (Join-Path $stagingPath "tools\node_modules\openclaw") `
      -Name "OpenClaw"
    vaultMemory = Copy-AsukaRecoveryTree -Source $sources.vaultMemory `
      -Destination (Join-Path $stagingPath "vault\Asuka\Memory") `
      -Name "Vault memory"
  }
  $stagedGatewayPath = Join-Path $stagingPath `
    "root-files\asuka-gateway-task.ps1"
  New-Item -ItemType Directory -Force `
    -Path (Split-Path -Parent $stagedGatewayPath) | Out-Null
  Copy-Item -LiteralPath $sources.gatewayScript `
    -Destination $stagedGatewayPath
  if (
    (Get-AsukaSha256 -Path $sources.gatewayScript) -cne
      (Get-AsukaSha256 -Path $stagedGatewayPath) -or
    [int64](Get-Item -LiteralPath $sources.gatewayScript).Length -ne
      [int64](Get-Item -LiteralPath $stagedGatewayPath).Length
  ) {
    throw "Staged recovery Gateway script does not match its legacy source."
  }

  $payloadIntegrity = Get-AsukaDirectoryIntegrity -Path $stagingPath
  $baselineId = "sha256-$([string]$payloadIntegrity.sha256)"
  $targetPath = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative (
      "backups\recovery-baselines\sha256-{0}" -f
        [string]$payloadIntegrity.sha256
    )
  $sourceLayout = [ordered]@{}
  foreach ($name in @($sources.Keys)) {
    $sourceLayout[$name] = ([string]$sources[$name]).Substring(
      $sourceRoot.Length
    ).TrimStart("\").Replace("\", "/")
  }
  Write-AsukaJsonFile -Path (Join-Path $stagingPath "recovery.json") `
    -Value ([ordered]@{
      schemaVersion = 1
      kind = "asuka-v15-recovery-baseline"
      baselineId = $baselineId
      importedAt = (Get-Date).ToUniversalTime().ToString("o")
      sourceBackupPath = $sourceRoot
      expectedOpenClawVersion = $expectedOpenClawVersion
      sourceLayout = $sourceLayout
      payload = [ordered]@{
        fileCount = [int]$payloadIntegrity.fileCount
        bytes = [int64]$payloadIntegrity.bytes
        sha256 = [string]$payloadIntegrity.sha256
      }
      trees = $treeIntegrity
      gatewayScript = [ordered]@{
        bytes = [int64](Get-Item -LiteralPath $stagedGatewayPath).Length
        sha256 = Get-AsukaSha256 -Path $stagedGatewayPath
      }
    })

  if (Test-Path -LiteralPath $targetPath) {
    [void](Test-AsukaBackupIntegrity -BackupPath $targetPath)
    $existingMetadata = Get-Content `
      -LiteralPath (Join-Path $targetPath "recovery.json") `
      -Raw -Encoding UTF8 | ConvertFrom-Json
    $existingPayload = Get-AsukaDirectoryIntegrity -Path $targetPath `
      -ExcludePaths @(
        "recovery.json",
        "backup-files.json",
        "backup-complete.marker"
      )
    if (
      [int]$existingMetadata.schemaVersion -ne 1 -or
      [string]$existingMetadata.kind -cne "asuka-v15-recovery-baseline" -or
      [string]$existingMetadata.baselineId -cne $baselineId -or
      [string]$existingMetadata.expectedOpenClawVersion -cne
        $expectedOpenClawVersion -or
      [string]$existingMetadata.payload.sha256 -cne
        [string]$payloadIntegrity.sha256 -or
      [string]$existingPayload.sha256 -cne
        [string]$payloadIntegrity.sha256
    ) {
      throw "Existing content-addressed recovery baseline is invalid."
    }
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
    $stagingPath = $null
  } else {
    [void](Write-AsukaBackupIntegrity -BackupPath $stagingPath)
    [void](Test-AsukaBackupIntegrity -BackupPath $stagingPath)
    Move-Item -LiteralPath $stagingPath -Destination $targetPath
    $stagingPath = $null
    [void](Test-AsukaBackupIntegrity -BackupPath $targetPath)
  }

  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    baselinePath = $targetPath
    baselineId = $baselineId
    payload = [ordered]@{
      fileCount = [int]$payloadIntegrity.fileCount
      bytes = [int64]$payloadIntegrity.bytes
      sha256 = [string]$payloadIntegrity.sha256
    }
    openClaw = $expectedOpenClawVersion
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  if (
    -not [string]::IsNullOrWhiteSpace($stagingPath) -and
    (Test-Path -LiteralPath $stagingPath)
  ) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
  }
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    baselinePath = $targetPath
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
