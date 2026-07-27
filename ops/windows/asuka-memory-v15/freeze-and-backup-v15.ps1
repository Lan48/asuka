[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseId = "v15-preimplementation",
  [string]$SealExistingBackupPath = "",
  [string]$GatewayTaskName = "AsukaGateway",
  [string]$SyncTaskName = "AsukaMemorySync"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

. (Join-Path $PSScriptRoot "common.ps1")

$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
if ($ReleaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
  throw "ReleaseId contains unsafe characters."
}
foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
  if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
    throw "Scheduled-task name contains unsafe characters."
  }
}

if (-not [string]::IsNullOrWhiteSpace($SealExistingBackupPath)) {
  $sealedPath = [IO.Path]::GetFullPath($SealExistingBackupPath).TrimEnd("\")
  $allowedBackupsRoot = [IO.Path]::GetFullPath(
    (Join-Path $AppRoot "backups")
  ).TrimEnd("\")
  if (
    -not $sealedPath.StartsWith(
      "$allowedBackupsRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Existing frozen backup must be a child of the Asuka backups directory."
  }
  $legacyManifestPath = Join-Path $sealedPath "backup-manifest.json"
  $legacyMarkerPath = Join-Path $sealedPath "BACKUP_COMPLETE"
  foreach ($required in @($legacyManifestPath, $legacyMarkerPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Existing frozen backup is incomplete: $required"
    }
  }
  $legacyManifest = Get-Content -LiteralPath $legacyManifestPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $verifiedCopies = @(
    Test-AsukaFrozenCopyIntegrity -Manifest $legacyManifest -AppRoot $AppRoot `
      -BackupPath $sealedPath
  )
  $legacyManifestHash = Get-AsukaSha256 -Path $legacyManifestPath
  [void](Write-AsukaBackupIntegrity -BackupPath $sealedPath)
  $sealed = Read-AsukaFrozenBackup -Path $sealedPath -AppRoot $AppRoot `
    -GatewayTaskName $GatewayTaskName -SyncTaskName $SyncTaskName
  if ((Get-AsukaSha256 -Path $legacyManifestPath) -ne $legacyManifestHash) {
    throw "Sealing changed the existing frozen backup manifest."
  }
  [pscustomobject]@{
    Success = $true
    Mode = "seal-existing"
    BackupRoot = $sealed.path
    Manifest = $sealed.manifestPath
    FileCount = $sealed.backupIntegrity.fileCount
    Bytes = $sealed.backupIntegrity.bytes
    TreeSha256 = $sealed.backupIntegrity.treeSha256
    VerifiedCopies = $verifiedCopies.Count
    TasksBeforePreserved = $true
  } | ConvertTo-Json -Compress
  return
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $AppRoot "backups\v15-$timestamp-$ReleaseId"
$vault = Join-Path $AppRoot "obsidian-vault"
$tasksDirectory = Join-Path $backupRoot "scheduled-tasks"
$manifestPath = Join-Path $backupRoot "backup-manifest.json"
$taskNames = @(
  $GatewayTaskName,
  $SyncTaskName,
  "AsukaXmapiProxy",
  "AsukaXmapiProxyWatchdog"
)

function Invoke-BackupRobocopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$CopyAll
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    return [pscustomobject]@{ Source = $Source; Destination = $Destination; Skipped = $true }
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $copyMode = if ($CopyAll) { "/COPYALL" } else { "/COPY:DAT" }
  & robocopy $Source $Destination /E $copyMode /DCOPY:DAT /R:2 /W:1 /XJ /NP /NFL /NDL |
    Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "robocopy failed ($exitCode): $Source -> $Destination"
  }
  return [pscustomobject]@{
    Source = $Source
    Destination = $Destination
    ExitCode = $exitCode
  }
}

function Wait-BackupTaskStopped {
  param([Parameter(Mandatory = $true)][string]$Name)

  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task -or [string]$task.State -ne "Running") {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Scheduled task did not stop: $Name"
}

function Get-BackupCriticalHashes {
  $paths = @(
    (Join-Path $AppRoot "asuka-gateway-task.ps1"),
    (Join-Path $AppRoot "asuka-memory-sync.ps1"),
    (Join-Path $AppRoot "home\.openclaw\openclaw.json"),
    (Join-Path $AppRoot "home\.openclaw\extensions\qqbot\dist\src\asuka-memory.js"),
    (Join-Path $AppRoot "home\.openclaw\extensions\qqbot\dist\src\gateway.js"),
    (Join-Path $AppRoot "tools\node_modules\openclaw\package.json")
  )
  return @($paths | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
    [pscustomobject]@{
      Path = $_
      Sha256 = Get-AsukaSha256 -Path $_
    }
  })
}

function Get-VaultGitValue {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $result = Invoke-AsukaGit -Repository $vault -Arguments $Arguments
  if ($result.ExitCode -ne 0) {
    throw "Vault Git command failed: git $($Arguments -join ' ')"
  }
  return $result.Output.Trim()
}

if (Test-Path -LiteralPath $backupRoot) {
  throw "Backup destination already exists: $backupRoot"
}
if (-not (Test-Path -LiteralPath $vault -PathType Container)) {
  throw "Vault does not exist: $vault"
}

$vaultHead = Get-VaultGitValue -Arguments @("rev-parse", "HEAD")
$vaultBranch = Get-VaultGitValue -Arguments @("branch", "--show-current")
$vaultUpstream = Get-VaultGitValue -Arguments @(
  "rev-parse",
  "--abbrev-ref",
  "--symbolic-full-name",
  "@{upstream}"
)
$vaultStatus = Get-VaultGitValue -Arguments @(
  "status",
  "--porcelain=v1",
  "--untracked-files=all"
)
$vaultDirty = -not [string]::IsNullOrWhiteSpace($vaultStatus)
$vaultAhead = [int](Get-VaultGitValue -Arguments @(
  "rev-list",
  "--count",
  "@{upstream}..HEAD"
))
$vaultBehind = [int](Get-VaultGitValue -Arguments @(
  "rev-list",
  "--count",
  "HEAD..@{upstream}"
))
if (
  [string]::IsNullOrWhiteSpace($vaultBranch) -or
  [string]::IsNullOrWhiteSpace($vaultUpstream) -or
  $vaultDirty -or
  $vaultAhead -ne 0 -or
  $vaultBehind -ne 0
) {
  throw (
    "Vault is not clean and converged: branch=$vaultBranch upstream=$vaultUpstream " +
    "dirty=$vaultDirty ahead=$vaultAhead behind=$vaultBehind"
  )
}

$taskSnapshot = @($taskNames | ForEach-Object {
  $task = Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue
  if ($task) {
    [pscustomobject]@{
      Name = $_
      State = [string]$task.State
      Enabled = [string]$task.State -ne "Disabled"
    }
  }
})
$criticalHashesBefore = Get-BackupCriticalHashes

New-Item -ItemType Directory -Force -Path $tasksDirectory | Out-Null
foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Export-ScheduledTask -TaskName $taskName |
      Set-Content -LiteralPath (Join-Path $tasksDirectory "$taskName.xml") -Encoding Unicode
  }
}

foreach ($taskName in @($SyncTaskName, $GatewayTaskName)) {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Wait-BackupTaskStopped -Name $taskName
}

if (Get-NetTCPConnection -LocalPort 19001 -State Listen -ErrorAction SilentlyContinue) {
  throw "Gateway port 19001 remained open after task stop"
}

$gatewayProcesses = @(Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match "^(node|powershell)\.exe$" -and
    $_.CommandLine -match [regex]::Escape($AppRoot) -and
    $_.CommandLine -match "(openclaw\.mjs.*gateway|asuka-gateway-task\.ps1)"
  } |
  Select-Object ProcessId, Name, CommandLine)
if ($gatewayProcesses.Count -gt 0) {
  throw "Gateway process remained after task stop: $($gatewayProcesses.ProcessId -join ',')"
}

$copies = @()
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "home") `
  -Destination (Join-Path $backupRoot "home")
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "project") `
  -Destination (Join-Path $backupRoot "project")
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "obsidian-vault") `
  -Destination (Join-Path $backupRoot "obsidian-vault")
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "tools\node_modules\openclaw") `
  -Destination (Join-Path $backupRoot "tools\node_modules\openclaw")
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "tools\node-v24.18.0") `
  -Destination (Join-Path $backupRoot "tools\node-v24.18.0")
$copies += Invoke-BackupRobocopy -Source (Join-Path $AppRoot "ssh") `
  -Destination (Join-Path $backupRoot "ssh") -CopyAll

$rootFiles = @(
  "asuka-gateway-task.ps1",
  "asuka-memory-sync.ps1",
  "asuka-xmapi-proxy-task.ps1",
  "asuka-xmapi-proxy-watchdog.ps1"
)
New-Item -ItemType Directory -Force -Path (Join-Path $backupRoot "root-files") | Out-Null
foreach ($name in $rootFiles) {
  $source = Join-Path $AppRoot $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $backupRoot "root-files\$name")
  }
}

$bundleResult = Invoke-AsukaGit -Repository $vault -Arguments @(
  "bundle",
  "create",
  (Join-Path $backupRoot "obsidian-vault.bundle"),
  "--all"
)
if ($bundleResult.ExitCode -ne 0) {
  throw "Git bundle creation failed."
}

$manifest = [ordered]@{
  schemaVersion = 1
  releaseId = $ReleaseId
  backupRoot = $backupRoot
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  appRoot = $AppRoot
  vault = [ordered]@{
    branch = $vaultBranch
    upstream = $vaultUpstream
    head = $vaultHead
    dirty = $vaultDirty
    ahead = $vaultAhead
    behind = $vaultBehind
  }
  tasksBefore = $taskSnapshot
  tasksAfter = @(@($GatewayTaskName, $SyncTaskName) | ForEach-Object {
    $task = Get-ScheduledTask -TaskName $_
    [pscustomobject]@{
      Name = $_
      State = [string]$task.State
      Enabled = [string]$task.State -ne "Disabled"
    }
  })
  port19001After = [bool](
    Get-NetTCPConnection -LocalPort 19001 -State Listen -ErrorAction SilentlyContinue
  )
  criticalHashesBefore = $criticalHashesBefore
  copies = $copies
}
Write-AsukaJsonFile -Path $manifestPath -Value $manifest
Set-Content -LiteralPath (Join-Path $backupRoot "BACKUP_COMPLETE") `
  -Value $manifest.createdAt -Encoding ASCII
[void](Write-AsukaBackupIntegrity -BackupPath $backupRoot)
$frozen = Read-AsukaFrozenBackup -Path $backupRoot -AppRoot $AppRoot `
  -GatewayTaskName $GatewayTaskName -SyncTaskName $SyncTaskName -VerifyCurrentHashes

[pscustomobject]@{
  Success = $true
  Mode = "freeze"
  BackupRoot = $backupRoot
  VaultHead = $vaultHead
  VaultUpstream = $vaultUpstream
  GatewayState = [string](Get-ScheduledTask -TaskName $GatewayTaskName).State
  GatewayEnabled = [string](Get-ScheduledTask -TaskName $GatewayTaskName).State -ne "Disabled"
  MemorySyncState = [string](Get-ScheduledTask -TaskName $SyncTaskName).State
  MemorySyncEnabled = [string](Get-ScheduledTask -TaskName $SyncTaskName).State -ne "Disabled"
  Port19001 = [bool](
    Get-NetTCPConnection -LocalPort 19001 -State Listen -ErrorAction SilentlyContinue
  )
  Manifest = $manifestPath
  FileCount = $frozen.backupIntegrity.fileCount
  Bytes = $frozen.backupIntegrity.bytes
  TreeSha256 = $frozen.backupIntegrity.treeSha256
} | ConvertTo-Json -Compress
