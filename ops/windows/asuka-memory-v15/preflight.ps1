[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$FrozenBackupPath = "",
  [switch]$SkipVaultRemoteGate
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")
$env:GIT_TERMINAL_PROMPT = "0"

try {
  if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $PSScriptRoot
  }
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $ReleaseRoot "manifest.json"
  }

  $manifest = Read-AsukaManifest -Path $ManifestPath
  if (
    -not [string]::IsNullOrWhiteSpace([string]$manifest.appRoot) -and
    -not ([IO.Path]::GetFullPath([string]$manifest.appRoot)).Equals(
      [IO.Path]::GetFullPath($AppRoot),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Manifest appRoot does not match requested AppRoot."
  }
  $verifiedReleaseFiles = @(Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $packagedSyncScript = Resolve-AsukaChildPath -Root $ReleaseRoot `
    -Relative ([string]$manifest.syncWorker.source)
  $syncScript = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.syncWorker.destination)
  $expectedSyncScriptHash = ([string]$manifest.syncWorker.sha256).ToLowerInvariant()
  if (
    (Get-AsukaSha256 -Path $packagedSyncScript) -ne $expectedSyncScriptHash -or
    [int64](Get-Item -LiteralPath $packagedSyncScript).Length -ne
      [int64]$manifest.syncWorker.bytes
  ) {
    throw "Packaged sync worker does not match the release integrity contract."
  }
  $parsedPowerShellScripts = @()
  foreach ($entry in @($manifest.opsFiles)) {
    if (-not ([string]$entry.source).EndsWith(".ps1", [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $scriptPath = Resolve-AsukaChildPath -Root $ReleaseRoot -Relative ([string]$entry.source)
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
      $scriptPath,
      [ref]$tokens,
      [ref]$parseErrors
    )
    if (@($parseErrors).Count -gt 0) {
      $parseSummary = @($parseErrors | ForEach-Object { $_.Message }) -join "; "
      throw "PowerShell parser rejected '$($entry.source)': $parseSummary"
    }
    $parsedPowerShellScripts += [string]$entry.source
  }

  if ($PSVersionTable.PSVersion.Major -lt 5) {
    throw "PowerShell 5.1 or newer is required."
  }
  $os = Get-CimInstance Win32_OperatingSystem
  if ([string]$os.OSArchitecture -notmatch "64") {
    throw "A 64-bit Windows runtime is required."
  }

  $node = Join-Path $AppRoot (
    "tools\node-{0}\node.exe" -f [string]$manifest.requirements.nodeVersion
  )
  $openClawEntry = Join-Path $AppRoot "tools\node_modules\openclaw\openclaw.mjs"
  $openClawPackage = Join-Path $AppRoot "tools\node_modules\openclaw\package.json"
  $openClawRoot = Join-Path $AppRoot "tools\node_modules\openclaw"
  $projectRoot = Join-Path $AppRoot "project"
  $activePlugin = Join-Path $AppRoot "home\.openclaw\extensions\qqbot"
  $packagedPlugin = Join-Path $ReleaseRoot "payload\qqbot"
  $openClawHome = Join-Path $AppRoot "home"
  $homeState = Join-Path $AppRoot "home\.openclaw"
  $openClawConfig = Join-Path $homeState "openclaw.json"
  $vault = Join-Path $AppRoot "obsidian-vault"
  $memoryRoot = Join-Path $vault "Asuka\Memory"
  $gatewayScript = Join-Path $AppRoot "asuka-gateway-task.ps1"
  $syncStatusPath = Join-Path $AppRoot "run\asuka-memory-sync-status.json"
  $syncLockPath = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  $deployLockPath = Join-Path $AppRoot "run\asuka-memory-v15-deploy.lock"

  foreach ($requiredPath in @(
    $node,
    $openClawEntry,
    $openClawPackage,
    $openClawRoot,
    $projectRoot,
    $activePlugin,
    (Join-Path $packagedPlugin "dist\src\config.js"),
    (Join-Path $packagedPlugin "dist\src\asuka-memory-kernel\model-client.js"),
    $homeState,
    $vault,
    (Join-Path $vault ".git"),
    $memoryRoot,
    $gatewayScript,
    $packagedSyncScript,
    $syncScript,
    $openClawConfig,
    (Join-Path $AppRoot "home\.openclaw\qqbot\data\asuka-memory\memory.json"),
    (Join-Path $AppRoot "ssh\obsidian-memory-ed25519"),
    (Join-Path $AppRoot "ssh\known_hosts")
  )) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Required remote path is missing: $requiredPath"
    }
  }

  $nodeVersionResult = Invoke-AsukaNative -FilePath $node -Arguments @("--version")
  if ($nodeVersionResult.ExitCode -ne 0) {
    throw "Unable to run bundled Node.js: $($nodeVersionResult.Output)"
  }
  $nodeVersion = $nodeVersionResult.Output.Trim()
  if ($nodeVersion -ne [string]$manifest.requirements.nodeVersion) {
    throw "Bundled Node.js version mismatch: expected=$($manifest.requirements.nodeVersion) actual=$nodeVersion"
  }

  $openClawPackageJson = Get-Content -LiteralPath $openClawPackage -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $openClawVersion = [string]$openClawPackageJson.version
  if ($openClawVersion -ne [string]$manifest.requirements.openClawVersion) {
    throw "OpenClaw version mismatch: expected=$($manifest.requirements.openClawVersion) actual=$openClawVersion"
  }

  $env:OPENCLAW_HOME = $openClawHome
  $env:USERPROFILE = $openClawHome
  $env:OPENCLAW_STATE_DIR = $homeState
  $env:OPENCLAW_CONFIG_PATH = $openClawConfig
  $configValidation = Invoke-AsukaNative -FilePath $node -Arguments @(
    $openClawEntry,
    "config",
    "validate"
  )
  if ($configValidation.ExitCode -ne 0) {
    throw "Existing OpenClaw configuration is invalid: $($configValidation.Output)"
  }

  $modelProbeScript = Join-Path $ReleaseRoot "ops\verify-model-config.mjs"
  $modelProbeResult = Invoke-AsukaNative -FilePath $node -Arguments @(
    $modelProbeScript,
    $packagedPlugin,
    $openClawConfig,
    [string]$manifest.migration.accountId
  )
  if ($modelProbeResult.ExitCode -ne 0) {
    throw "Legacy rejudgement model configuration is not resolvable: $($modelProbeResult.Output)"
  }
  $modelProbe = $modelProbeResult.Output.Trim() | ConvertFrom-Json
  if (
    -not [bool]$modelProbe.ok -or
    [string]$modelProbe.completion -ne "ready" -or
    [int]$modelProbe.completionModels -lt 1 -or
    [int]$modelProbe.networkCalls -ne 0
  ) {
    throw "Legacy rejudgement model configuration probe returned an invalid result."
  }

  foreach ($module in @($manifest.requirements.requiredModules)) {
    $modulePackage = Join-Path $activePlugin "node_modules\$module\package.json"
    if (-not (Test-Path -LiteralPath $modulePackage -PathType Leaf)) {
      throw "Required Windows runtime module is missing: $module"
    }
  }
  if ($null -eq (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git for Windows was not found."
  }
  if ($null -eq (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "OpenSSH for Windows was not found."
  }

  $gatewayTaskName = [string]$manifest.requirements.tasks.gateway
  $syncTaskName = [string]$manifest.requirements.tasks.sync
  $frozenBackup = $null
  if (-not [string]::IsNullOrWhiteSpace($FrozenBackupPath)) {
    $frozenBackup = Read-AsukaFrozenBackup -Path $FrozenBackupPath -AppRoot $AppRoot `
      -GatewayTaskName $gatewayTaskName -SyncTaskName $syncTaskName -VerifyCurrentHashes
  }
  $gatewayTask = Get-AsukaTaskSnapshot -Name $gatewayTaskName
  $syncTask = Get-AsukaTaskSnapshot -Name $syncTaskName
  $gatewayActions = @($gatewayTask.actions)
  $syncActions = @($syncTask.actions)
  $escapedSyncScript = [regex]::Escape($syncScript)
  $syncScriptArgumentPattern = "(?i)(?:^|\s)-File\s+`"?${escapedSyncScript}`"?(?:\s|$)"
  if (
    $gatewayActions.Count -ne 1 -or
    [string]$gatewayActions[0].execute -notmatch "(?i)powershell(\.exe)?$" -or
    [string]$gatewayActions[0].arguments -notmatch ([regex]::Escape($gatewayScript))
  ) {
    throw "$gatewayTaskName action does not reference the audited gateway script."
  }
  if (
    $syncActions.Count -ne 1 -or
    [string]$syncActions[0].execute -notmatch "(?i)powershell(\.exe)?$" -or
    [string]$syncActions[0].arguments -notmatch $syncScriptArgumentPattern
  ) {
    throw "$syncTaskName action does not reference the audited sync script."
  }

  $gatewayPort = [int]$manifest.requirements.gatewayPort
  if ($null -eq $frozenBackup) {
    if (-not $gatewayTask.enabled -or -not $gatewayTask.wasRunning) {
      throw "$gatewayTaskName must be enabled and running before cutover."
    }
    if (-not $syncTask.enabled -or -not $syncTask.wasRunning) {
      throw "$syncTaskName must be enabled and running before cutover."
    }
    if (-not (Test-AsukaPortListening -Port $gatewayPort)) {
      throw "Gateway baseline is unhealthy: port $gatewayPort is not listening."
    }
    if (@(Get-AsukaGatewayProcesses -AppRoot $AppRoot).Count -eq 0) {
      throw "Gateway baseline is unhealthy: no matching Node.js process was found."
    }
    if (Test-AsukaExclusiveFileAccess -Path $syncLockPath) {
      throw "Memory sync task is running but does not own its process lock."
    }
  } else {
    if (
      $gatewayTask.enabled -or
      $gatewayTask.wasRunning -or
      [string]$gatewayTask.state -ne "Disabled"
    ) {
      throw "$gatewayTaskName must remain disabled and stopped after the frozen backup."
    }
    if (
      $syncTask.enabled -or
      $syncTask.wasRunning -or
      [string]$syncTask.state -ne "Disabled"
    ) {
      throw "$syncTaskName must remain disabled and stopped after the frozen backup."
    }
    Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort
    if (-not (Test-AsukaExclusiveFileAccess -Path $syncLockPath)) {
      throw "Memory sync lock is still owned in frozen deployment mode."
    }
  }
  if (Test-Path -LiteralPath $syncStatusPath -PathType Leaf) {
    $syncStatus = Get-Content -LiteralPath $syncStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$syncStatus.state -eq "conflict") {
      throw "Memory sync is paused on a Git conflict."
    }
  } else {
    $syncStatus = $null
  }
  if (-not (Test-AsukaExclusiveFileAccess -Path $deployLockPath)) {
    throw "Another Asuka v1.5 deployment is already running."
  }

  Assert-AsukaNoGitOperation -Repository $vault
  $dirty = Invoke-AsukaGit -Repository $vault -Arguments @(
    "status", "--porcelain", "--", "Asuka/Memory"
  )
  if ($dirty.ExitCode -ne 0) {
    throw "Unable to inspect Vault status: $($dirty.Output)"
  }
  if (-not [string]::IsNullOrWhiteSpace($dirty.Output)) {
    throw "Vault has uncommitted Asuka/Memory changes."
  }

  $remoteReachable = $false
  $upstream = $null
  if (-not $SkipVaultRemoteGate) {
    $upstreamResult = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
    )
    if ($upstreamResult.ExitCode -ne 0) {
      throw "Vault branch has no configured upstream: $($upstreamResult.Output)"
    }
    $upstream = $upstreamResult.Output.Trim()
    $fetch = Invoke-AsukaGit -Repository $vault -Arguments @("fetch", "--prune")
    if ($fetch.ExitCode -ne 0) {
      throw "Vault convergence gate could not reach its upstream: $($fetch.Output)"
    }
    $remoteReachable = $true
    $aheadResult = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-list", "--count", "$upstream..HEAD"
    )
    $behindResult = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-list", "--count", "HEAD..$upstream"
    )
    if ($aheadResult.ExitCode -ne 0 -or $behindResult.ExitCode -ne 0) {
      throw "Unable to compare Vault with its upstream."
    }
    if ([int]$aheadResult.Output -ne 0 -or [int]$behindResult.Output -ne 0) {
      throw "Vault is not converged with ${upstream}: ahead=$($aheadResult.Output) behind=$($behindResult.Output)"
    }
  }

  $homeBytes = Get-AsukaDirectoryBytes -Path $homeState
  $vaultBytes = Get-AsukaDirectoryBytes -Path $vault
  $pluginBytes = Get-AsukaDirectoryBytes -Path $activePlugin
  $projectBytes = Get-AsukaDirectoryBytes -Path $projectRoot
  $openClawBytes = Get-AsukaDirectoryBytes -Path $openClawRoot
  $calculatedMinimum = [int64](
    $homeBytes + $vaultBytes + $pluginBytes + $projectBytes + $openClawBytes + 2GB
  )
  $manifestMinimum = [int64]$manifest.requirements.minimumFreeBytes
  $requiredFree = [Math]::Max($calculatedMinimum, $manifestMinimum)
  $driveName = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($AppRoot)).Substring(0, 1)
  $drive = Get-PSDrive -Name $driveName
  if ([int64]$drive.Free -lt $requiredFree) {
    throw "Insufficient free space: required=$requiredFree available=$($drive.Free)"
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.database)
  $runtimeNext = "$activePlugin.v15.next"
  $runtimePrevious = "$activePlugin.v15.previous.$([string]$manifest.releaseId)"
  foreach ($stalePath in @(
    "$ledger.next",
    "$ledger.next-wal",
    "$ledger.next-shm",
    $runtimeNext,
    $runtimePrevious
  )) {
    if (Test-Path -LiteralPath $stalePath) {
      throw "Stale deployment artifact requires rollback or manual inspection: $stalePath"
    }
  }

  $head = Invoke-AsukaGit -Repository $vault -Arguments @("rev-parse", "HEAD")
  if ($head.ExitCode -ne 0) {
    throw "Unable to read Vault HEAD: $($head.Output)"
  }
  Write-AsukaEnvelope -Ok $true -Operation "preflight" -Data ([ordered]@{
    releaseId = [string]$manifest.releaseId
    releaseFiles = $verifiedReleaseFiles.Count
    parsedPowerShellScripts = $parsedPowerShellScripts
    os = [string]$os.Caption
    osVersion = [string]$os.Version
    powershell = $PSVersionTable.PSVersion.ToString()
    node = $nodeVersion
    openClaw = $openClawVersion
    configValidation = $configValidation.Output.Trim()
    rejudgementModel = $modelProbe
    baselineMode = if ($null -eq $frozenBackup) { "live" } else { "frozen" }
    frozenBackupPath = if ($null -eq $frozenBackup) { $null } else { $frozenBackup.path }
    frozenCriticalHashes = if ($null -eq $frozenBackup) {
      0
    } else {
      [int]$frozenBackup.verifiedCriticalHashes
    }
    gatewayTask = $gatewayTask
    syncTask = $syncTask
    syncWorker = [ordered]@{
      source = [string]$manifest.syncWorker.source
      destination = [string]$manifest.syncWorker.destination
      packagedSha256 = Get-AsukaSha256 -Path $packagedSyncScript
      installedSha256 = Get-AsukaSha256 -Path $syncScript
      expectedInstalledSha256 = $expectedSyncScriptHash
    }
    gatewayPort = $gatewayPort
    syncStatus = $syncStatus
    vaultHead = $head.Output.Trim()
    vaultUpstream = $upstream
    vaultRemoteReachable = $remoteReachable
    sourceBytes = [int64](
      $homeBytes + $vaultBytes + $pluginBytes + $projectBytes + $openClawBytes
    )
    requiredFreeBytes = [int64]$requiredFree
    availableFreeBytes = [int64]$drive.Free
  }) -ErrorMessage $null -ExitCode 0
} catch {
  Write-AsukaEnvelope -Ok $false -Operation "preflight" -Data $null `
    -ErrorMessage $_.Exception.Message -ExitCode 1
}
