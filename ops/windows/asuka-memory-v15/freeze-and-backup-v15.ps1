[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$ReleaseId = "",
  [string]$GatewayTaskName = "",
  [string]$SyncTaskName = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

. (Join-Path $PSScriptRoot "common.ps1")

$operation = "freeze-and-backup-v15"
$lockStream = $null
$backupRoot = $null

try {
$lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
  $ReleaseRoot = Split-Path -Parent $PSScriptRoot
}
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
  $ManifestPath = Join-Path $ReleaseRoot "manifest.json"
}
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
$manifest = Read-AsukaManifest -Path $ManifestPath
[void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
if (
  -not [string]::IsNullOrWhiteSpace([string]$manifest.appRoot) -and
  -not ([IO.Path]::GetFullPath([string]$manifest.appRoot)).Equals(
    $AppRoot,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Manifest appRoot does not match requested AppRoot."
}

$manifestReleaseId = [string]$manifest.releaseId
if (
  -not [string]::IsNullOrWhiteSpace($ReleaseId) -and
  $ReleaseId -cne $manifestReleaseId
) {
  throw "ReleaseId does not match the release manifest."
}
$ReleaseId = $manifestReleaseId
if ($ReleaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
  throw "ReleaseId contains unsafe characters."
}

$manifestGatewayTaskName = [string]$manifest.requirements.tasks.gateway
$manifestSyncTaskName = [string]$manifest.requirements.tasks.sync
if (
  -not [string]::IsNullOrWhiteSpace($GatewayTaskName) -and
  $GatewayTaskName -cne $manifestGatewayTaskName
) {
  throw "Gateway task name does not match the release manifest."
}
if (
  -not [string]::IsNullOrWhiteSpace($SyncTaskName) -and
  $SyncTaskName -cne $manifestSyncTaskName
) {
  throw "Sync task name does not match the release manifest."
}
$GatewayTaskName = $manifestGatewayTaskName
$SyncTaskName = $manifestSyncTaskName
foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
  if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
    throw "Release manifest contains an unsafe scheduled-task name."
  }
}
$gatewayPort = [int]$manifest.requirements.gatewayPort
$nodeVersion = [string]$manifest.requirements.nodeVersion
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
  throw "Release manifest has an invalid Gateway port."
}
if (
  [string]$PSVersionTable.PSEdition -ne "Desktop" -or
  [int]$PSVersionTable.PSVersion.Major -ne 5 -or
  [int]$PSVersionTable.PSVersion.Minor -ne 1 -or
  -not [Environment]::Is64BitProcess
) {
  throw "Native 64-bit Windows PowerShell 5.1 Desktop is required."
}
$releaseManifestSha256 = Get-AsukaSha256 -Path $ManifestPath

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $AppRoot "backups\v15-$timestamp-$ReleaseId"
$vault = Join-Path $AppRoot "obsidian-vault"
$syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
$gatewayScript = Join-Path $AppRoot "asuka-gateway-task.ps1"
$syncScript = Resolve-AsukaChildPath -Root $AppRoot `
  -Relative ([string]$manifest.syncWorker.destination)
$nodeRuntime = Join-Path $AppRoot (
  "tools\node-{0}" -f [string]$manifest.requirements.nodeVersion
)
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
if (-not (Test-Path -LiteralPath $nodeRuntime -PathType Container)) {
  throw "Manifest-selected Node.js runtime does not exist: $nodeRuntime"
}

Assert-AsukaNoGitOperation -Repository $vault
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

$trustedPowerShell = [IO.Path]::GetFullPath(
  (Join-Path $PSHOME "powershell.exe")
)
$manifestTasks = @(
  [pscustomobject]@{
    name = $GatewayTaskName
    script = $gatewayScript
  },
  [pscustomobject]@{
    name = $SyncTaskName
    script = $syncScript
  }
)
foreach ($expectedTask in $manifestTasks) {
  $snapshot = Get-AsukaTaskSnapshot -Name ([string]$expectedTask.name)
  if ([string]$snapshot.name -cne [string]$expectedTask.name) {
    throw "Scheduled-task state name does not match the release manifest."
  }
  $actions = @($snapshot.actions)
  if ($actions.Count -ne 1) {
    throw "$($expectedTask.name) must have exactly one action."
  }
  $rawExecute = ([string]$actions[0].execute).Trim()
  $canonicalExecute = $false
  if ([IO.Path]::IsPathRooted($rawExecute)) {
    $canonicalExecute = (
      [IO.Path]::GetFullPath($rawExecute)
    ).Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase)
  }
  if (
    -not $canonicalExecute -and
    -not $rawExecute.Equals(
      "powershell.exe",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "$($expectedTask.name) executable does not match the release contract."
  }
  $validatedAction = [pscustomobject]@{
    execute = $trustedPowerShell
    arguments = [string]$actions[0].arguments
    workingDirectory = [string]$actions[0].workingDirectory
  }
  if (
    -not (
      Test-AsukaPowerShellFileAction -Action $validatedAction `
        -ScriptPath ([string]$expectedTask.script) `
        -AllowedWorkingDirectory $AppRoot
    )
  ) {
    throw "$($expectedTask.name) action does not match the release contract."
  }
}

$taskSnapshot = @($taskNames | ForEach-Object {
  $tasks = @(Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue)
  if ($tasks.Count -gt 1) {
    throw "Scheduled-task lookup is ambiguous: $_"
  }
  if ($tasks.Count -eq 1) {
    $task = $tasks[0]
    [pscustomobject]@{
      Name = [string]$task.TaskName
      TaskPath = [string]$task.TaskPath
      State = [string]$task.State
      Enabled = [string]$task.State -ne "Disabled"
    }
  }
})
foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
  $taskMatches = @(
    $taskSnapshot |
      Where-Object { [string]$_.Name -ceq $taskName }
  )
  if (
    $taskMatches.Count -ne 1 -or
    [string]$taskMatches[0].State -ne "Running" -or
    -not [bool]$taskMatches[0].Enabled
  ) {
    throw "Frozen backup requires a running, enabled baseline: $taskName"
  }
}
$criticalHashesBefore = Get-BackupCriticalHashes

foreach ($taskName in @($SyncTaskName, $GatewayTaskName)) {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Wait-BackupTaskStopped -Name $taskName
}
if (-not (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
  throw "Memory sync lock remained owned after stopping $SyncTaskName."
}
Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort
Assert-AsukaNoGitOperation -Repository $vault

New-Item -ItemType Directory -Force -Path $tasksDirectory | Out-Null
$taskXml = @()
foreach ($taskName in $taskNames) {
  $tasks = @(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
  if ($tasks.Count -gt 1) {
    throw "Scheduled-task lookup is ambiguous: $taskName"
  }
  if ($tasks.Count -eq 1) {
    $task = $tasks[0]
    $taskXmlPath = Join-Path $tasksDirectory "$taskName.xml"
    Export-ScheduledTask -TaskName ([string]$task.TaskName) `
      -TaskPath ([string]$task.TaskPath) |
      Set-Content -LiteralPath $taskXmlPath -Encoding Unicode
    if (@($GatewayTaskName, $SyncTaskName) -ccontains $taskName) {
      $taskXml += [pscustomobject]@{
        Name = $taskName
        Path = "scheduled-tasks\$taskName.xml"
        Sha256 = Get-AsukaSha256 -Path $taskXmlPath
      }
    }
  }
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
$copies += Invoke-BackupRobocopy -Source $nodeRuntime `
  -Destination (Join-Path $backupRoot "tools\node-$nodeVersion")
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

Assert-AsukaNoGitOperation -Repository $vault
$vaultHeadAfter = Get-VaultGitValue -Arguments @("rev-parse", "HEAD")
$vaultBranchAfter = Get-VaultGitValue -Arguments @("branch", "--show-current")
$vaultUpstreamAfter = Get-VaultGitValue -Arguments @(
  "rev-parse",
  "--abbrev-ref",
  "--symbolic-full-name",
  "@{upstream}"
)
$vaultStatusAfter = Get-VaultGitValue -Arguments @(
  "status",
  "--porcelain=v1",
  "--untracked-files=all"
)
$vaultAheadAfter = [int](Get-VaultGitValue -Arguments @(
  "rev-list",
  "--count",
  "@{upstream}..HEAD"
))
$vaultBehindAfter = [int](Get-VaultGitValue -Arguments @(
  "rev-list",
  "--count",
  "HEAD..@{upstream}"
))
if (
  $vaultHeadAfter -cne $vaultHead -or
  $vaultBranchAfter -cne $vaultBranch -or
  $vaultUpstreamAfter -cne $vaultUpstream -or
  -not [string]::IsNullOrWhiteSpace($vaultStatusAfter) -or
  $vaultAheadAfter -ne $vaultAhead -or
  $vaultBehindAfter -ne $vaultBehind
) {
  throw "Vault changed while the frozen backup was being copied."
}

$criticalHashesAfter = @(Get-BackupCriticalHashes)
if ($criticalHashesAfter.Count -ne $criticalHashesBefore.Count) {
  throw "Critical source files changed while the frozen backup was being copied."
}
$criticalHashesByPath = @{}
foreach ($entry in $criticalHashesBefore) {
  $criticalHashesByPath[[string]$entry.Path] = [string]$entry.Sha256
}
foreach ($entry in $criticalHashesAfter) {
  if (
    -not $criticalHashesByPath.ContainsKey([string]$entry.Path) -or
    [string]$entry.Sha256 -ne $criticalHashesByPath[[string]$entry.Path]
  ) {
    throw "Critical source files changed while the frozen backup was being copied."
  }
}

$backupManifest = [ordered]@{
  schemaVersion = 1
  releaseId = $ReleaseId
  releaseManifestSha256 = $releaseManifestSha256
  backupRoot = $backupRoot
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  appRoot = $AppRoot
  gatewayPort = $gatewayPort
  nodeVersion = $nodeVersion
  vault = [ordered]@{
    branch = $vaultBranch
    upstream = $vaultUpstream
    head = $vaultHead
    dirty = $vaultDirty
    ahead = $vaultAhead
    behind = $vaultBehind
  }
  tasksBefore = $taskSnapshot
  taskXml = $taskXml
  tasksAfter = @(@($GatewayTaskName, $SyncTaskName) | ForEach-Object {
    $task = Get-ScheduledTask -TaskName $_
    [pscustomobject]@{
      Name = $_
      State = [string]$task.State
      Enabled = [string]$task.State -ne "Disabled"
    }
  })
  gatewayPortAfter = [bool](
    Get-NetTCPConnection -LocalPort $gatewayPort -State Listen `
      -ErrorAction SilentlyContinue
  )
  criticalHashesBefore = $criticalHashesBefore
  copies = $copies
}
$verifiedCopies = @(
  Test-AsukaFrozenCopyIntegrity -Manifest $backupManifest -AppRoot $AppRoot `
    -BackupPath $backupRoot
)
Write-AsukaJsonFile -Path $manifestPath -Value $backupManifest
Set-Content -LiteralPath (Join-Path $backupRoot "BACKUP_COMPLETE") `
  -Value $backupManifest.createdAt -Encoding ASCII
$sealedIntegrity = Write-AsukaBackupIntegrity -BackupPath $backupRoot
$frozen = Test-AsukaFrozenBackupSemantics -Path $backupRoot -AppRoot $AppRoot `
  -GatewayTaskName $GatewayTaskName -SyncTaskName $SyncTaskName `
  -BackupIntegrity $sealedIntegrity -VerifyCurrentHashes

if ($null -ne $lockStream) {
  Exit-AsukaDeploymentLock -Lease $lockStream
  $lockStream = $null
}
Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
  Success = $true
  Mode = "freeze"
  BackupRoot = $backupRoot
  VaultHead = $vaultHead
  VaultUpstream = $vaultUpstream
  GatewayState = [string](Get-ScheduledTask -TaskName $GatewayTaskName).State
  GatewayEnabled = [string](Get-ScheduledTask -TaskName $GatewayTaskName).State -ne "Disabled"
  MemorySyncState = [string](Get-ScheduledTask -TaskName $SyncTaskName).State
  MemorySyncEnabled = [string](Get-ScheduledTask -TaskName $SyncTaskName).State -ne "Disabled"
  GatewayPort = $gatewayPort
  GatewayPortListening = [bool](
    Get-NetTCPConnection -LocalPort $gatewayPort -State Listen `
      -ErrorAction SilentlyContinue
  )
  Manifest = $manifestPath
  VerifiedCopies = $verifiedCopies.Count
  FileCount = $frozen.backupIntegrity.fileCount
  Bytes = $frozen.backupIntegrity.bytes
  TreeSha256 = $frozen.backupIntegrity.treeSha256
}) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    backupRoot = $backupRoot
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
