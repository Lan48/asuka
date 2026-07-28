[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [Parameter(Mandatory = $true)][string]$BaselinePath,
  [string]$GatewayTaskName = "AsukaGateway",
  [string]$SyncTaskName = "AsukaMemorySync",
  [int]$TaskStopTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")

$operation = "recover-v15-baseline"
$expectedOpenClawVersion = "2026.5.4"
$lockStream = $null
$stageRoot = $null
$failureRoot = $null
$restored = @()

function Assert-AsukaRecoveryTree {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $expectedIntegrity = Get-AsukaDirectoryIntegrity -Path $Expected
  $actualIntegrity = Get-AsukaDirectoryIntegrity -Path $Actual
  if (
    [int]$expectedIntegrity.fileCount -ne [int]$actualIntegrity.fileCount -or
    [int64]$expectedIntegrity.bytes -ne [int64]$actualIntegrity.bytes -or
    [string]$expectedIntegrity.sha256 -cne [string]$actualIntegrity.sha256
  ) {
    throw "Recovery $Name tree failed integrity verification."
  }
  return $actualIntegrity
}

function Move-AsukaRecoveryDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Staged,
    [Parameter(Mandatory = $true)][string]$Active,
    [Parameter(Mandatory = $true)][string]$Quarantine
  )

  New-Item -ItemType Directory -Force `
    -Path (Split-Path -Parent $Active) | Out-Null
  New-Item -ItemType Directory -Force `
    -Path (Split-Path -Parent $Quarantine) | Out-Null
  if (Test-Path -LiteralPath $Active) {
    Move-Item -LiteralPath $Active -Destination $Quarantine
  }
  Move-Item -LiteralPath $Staged -Destination $Active
}

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  $AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  foreach ($taskName in @($SyncTaskName, $GatewayTaskName)) {
    if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
      throw "Recovery scheduled-task name is unsafe."
    }
  }
  $runId = (Get-Date -Format "yyyyMMdd-HHmmss-fff") +
    "-$([Guid]::NewGuid().ToString('N'))"
  $failureRoot = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\recovery-failures\{0}" -f $runId)
  New-Item -ItemType Directory -Path $failureRoot | Out-Null
  Disable-AndStopAsukaTask -Name $SyncTaskName `
    -TimeoutSeconds $TaskStopTimeoutSeconds
  Disable-AndStopAsukaTask -Name $GatewayTaskName `
    -TimeoutSeconds $TaskStopTimeoutSeconds

  $baselineRoot = [IO.Path]::GetFullPath(
    (Join-Path $AppRoot "backups\recovery-baselines")
  ).TrimEnd("\")
  $baselineFull = [IO.Path]::GetFullPath($BaselinePath).TrimEnd("\")
  $baselineName = [IO.Path]::GetFileName($baselineFull)
  if (
    -not $baselineFull.StartsWith(
      "$baselineRoot\",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $baselineName -notmatch "^sha256-[a-f0-9]{64}$"
  ) {
    throw "BaselinePath must identify a content-addressed recovery baseline."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $baselineRoot `
    -Path $baselineFull)
  $baselineIntegrity = Test-AsukaBackupIntegrity -BackupPath $baselineFull
  $metadataPath = Join-Path $baselineFull "recovery.json"
  $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $payloadIntegrity = Get-AsukaDirectoryIntegrity -Path $baselineFull `
    -ExcludePaths @(
      "recovery.json",
      "backup-files.json",
      "backup-complete.marker"
    )
  if (
    [int]$metadata.schemaVersion -ne 1 -or
    [string]$metadata.kind -cne "asuka-v15-recovery-baseline" -or
    [string]$metadata.baselineId -cne $baselineName -or
    [string]$metadata.expectedOpenClawVersion -cne
      $expectedOpenClawVersion -or
    [string]$metadata.payload.sha256 -cne
      [string]$payloadIntegrity.sha256 -or
    $baselineName -cne "sha256-$([string]$payloadIntegrity.sha256)"
  ) {
    throw "Recovery baseline metadata does not match its content address."
  }

  $baselineHome = Join-Path $baselineFull "home"
  $baselineProject = Join-Path $baselineFull "project"
  $baselineOpenClaw = Join-Path $baselineFull `
    "tools\node_modules\openclaw"
  $baselineGateway = Join-Path $baselineFull `
    "root-files\asuka-gateway-task.ps1"
  $baselineVaultMemory = Join-Path $baselineFull "vault\Asuka\Memory"
  foreach ($required in @(
    $baselineHome,
    $baselineProject,
    $baselineOpenClaw,
    $baselineGateway,
    $baselineVaultMemory
  )) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Recovery baseline artifact is missing: $required"
    }
  }
  $baselineOpenClawPackage = Get-Content `
    -LiteralPath (Join-Path $baselineOpenClaw "package.json") `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [string]$baselineOpenClawPackage.version -cne
      $expectedOpenClawVersion
  ) {
    throw "Recovery baseline OpenClaw version is not $expectedOpenClawVersion."
  }

  $stageRoot = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\recovery-staging\{0}" -f $runId)
  New-Item -ItemType Directory -Path $stageRoot | Out-Null

  $stagedHome = Join-Path $stageRoot "home"
  $stagedProject = Join-Path $stageRoot "project"
  $stagedOpenClaw = Join-Path $stageRoot `
    "tools\node_modules\openclaw"
  $stagedGateway = Join-Path $stageRoot `
    "root-files\asuka-gateway-task.ps1"
  Copy-AsukaTree -Source $baselineHome -Destination $stagedHome
  Copy-AsukaTree -Source $baselineProject -Destination $stagedProject
  Copy-AsukaTree -Source $baselineOpenClaw -Destination $stagedOpenClaw
  New-Item -ItemType Directory -Force `
    -Path (Split-Path -Parent $stagedGateway) | Out-Null
  Copy-Item -LiteralPath $baselineGateway -Destination $stagedGateway
  [void](Assert-AsukaRecoveryTree -Expected $baselineHome `
    -Actual $stagedHome -Name "home staging")
  [void](Assert-AsukaRecoveryTree -Expected $baselineProject `
    -Actual $stagedProject -Name "project staging")
  [void](Assert-AsukaRecoveryTree -Expected $baselineOpenClaw `
    -Actual $stagedOpenClaw -Name "OpenClaw staging")
  if (
    (Get-AsukaSha256 -Path $baselineGateway) -cne
      (Get-AsukaSha256 -Path $stagedGateway)
  ) {
    throw "Recovery Gateway script failed staging verification."
  }

  $activeHome = Join-Path $AppRoot "home"
  $activeProject = Join-Path $AppRoot "project"
  $activeOpenClaw = Join-Path $AppRoot "tools\node_modules\openclaw"
  $activeGateway = Join-Path $AppRoot "asuka-gateway-task.ps1"
  Move-AsukaRecoveryDirectory -Staged $stagedHome -Active $activeHome `
    -Quarantine (Join-Path $failureRoot "active\home")
  $restored += "home"
  Move-AsukaRecoveryDirectory -Staged $stagedProject -Active $activeProject `
    -Quarantine (Join-Path $failureRoot "active\project")
  $restored += "project"
  Move-AsukaRecoveryDirectory -Staged $stagedOpenClaw `
    -Active $activeOpenClaw `
    -Quarantine (Join-Path $failureRoot `
      "active\tools\node_modules\openclaw")
  $restored += "tools\node_modules\openclaw"
  if (Test-Path -LiteralPath $activeGateway -PathType Leaf) {
    $gatewayQuarantine = Join-Path $failureRoot `
      "active\root-files\asuka-gateway-task.ps1"
    New-Item -ItemType Directory -Force `
      -Path (Split-Path -Parent $gatewayQuarantine) | Out-Null
    Move-Item -LiteralPath $activeGateway -Destination $gatewayQuarantine
  }
  Move-Item -LiteralPath $stagedGateway -Destination $activeGateway
  $restored += "asuka-gateway-task.ps1"

  [void](Assert-AsukaRecoveryTree -Expected $baselineHome `
    -Actual $activeHome -Name "home")
  [void](Assert-AsukaRecoveryTree -Expected $baselineProject `
    -Actual $activeProject -Name "project")
  [void](Assert-AsukaRecoveryTree -Expected $baselineOpenClaw `
    -Actual $activeOpenClaw -Name "OpenClaw")
  if (
    (Get-AsukaSha256 -Path $baselineGateway) -cne
      (Get-AsukaSha256 -Path $activeGateway)
  ) {
    throw "Recovered Gateway script failed integrity verification."
  }

  $node = Resolve-AsukaNodePath -AppRoot $AppRoot `
    -NodeVersion "v24.18.0"
  $vaultRestore = Invoke-AsukaNative -FilePath $node -Arguments @(
    (Join-Path $PSScriptRoot "restore-vault-generated.mjs"),
    (Join-Path $AppRoot "obsidian-vault\Asuka\Memory"),
    $baselineVaultMemory
  )
  if ($vaultRestore.ExitCode -ne 0) {
    throw "Vault generated-content recovery failed: $($vaultRestore.Output)"
  }
  $vaultReport = $vaultRestore.Output.Trim() | ConvertFrom-Json

  Disable-AndStopAsukaTask -Name $SyncTaskName `
    -TimeoutSeconds $TaskStopTimeoutSeconds
  Disable-AndStopAsukaTask -Name $GatewayTaskName `
    -TimeoutSeconds $TaskStopTimeoutSeconds
  Write-AsukaJsonFile -Path (Join-Path $failureRoot "recovery-state.json") `
    -Value ([ordered]@{
      schemaVersion = 1
      completed = $true
      completedAt = (Get-Date).ToUniversalTime().ToString("o")
      baselinePath = $baselineFull
      baselineIntegrity = $baselineIntegrity
      restored = $restored
      vault = $vaultReport
      writersEnabled = $false
    })

  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    baselinePath = $baselineFull
    failureEvidence = $failureRoot
    restored = $restored
    vault = $vaultReport
    gatewayTask = "Disabled"
    syncTask = "Disabled"
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  $disableErrors = @()
  try {
    Disable-AndStopAsukaTask -Name $SyncTaskName `
      -TimeoutSeconds $TaskStopTimeoutSeconds
  } catch {
    $disableErrors += Protect-AsukaText $_.Exception.Message
  }
  try {
    Disable-AndStopAsukaTask -Name $GatewayTaskName `
      -TimeoutSeconds $TaskStopTimeoutSeconds
  } catch {
    $disableErrors += Protect-AsukaText $_.Exception.Message
  }
  if (-not [string]::IsNullOrWhiteSpace($failureRoot)) {
    try {
      New-Item -ItemType Directory -Force -Path $failureRoot | Out-Null
      Write-AsukaJsonFile -Path (
        Join-Path $failureRoot "recovery-failure.json"
      ) -Value ([ordered]@{
        schemaVersion = 1
        completed = $false
        failedAt = (Get-Date).ToUniversalTime().ToString("o")
        error = Protect-AsukaText $failure
        restored = $restored
        disableErrors = $disableErrors
      })
    } catch {
      $disableErrors += Protect-AsukaText $_.Exception.Message
    }
  }
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    failureEvidence = $failureRoot
    restored = $restored
    disableErrors = $disableErrors
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
