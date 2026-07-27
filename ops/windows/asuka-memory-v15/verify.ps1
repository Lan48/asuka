[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$CurrentStatePath = "",
  [switch]$RequireVaultPushed,
  [int]$GatewayReadyTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")
$env:GIT_TERMINAL_PROMPT = "0"

try {
  if ([string]::IsNullOrWhiteSpace($CurrentStatePath)) {
    $CurrentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"
  }
  if (-not (Test-Path -LiteralPath $CurrentStatePath -PathType Leaf)) {
    throw "Deployment state is missing: $CurrentStatePath"
  }
  $currentState = Get-Content -LiteralPath $CurrentStatePath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if ([string]$currentState.phase -ne "active") {
    throw "Asuka v1.5 is not active; current phase is '$($currentState.phase)'."
  }

  if (
    [string]::IsNullOrWhiteSpace($ManifestPath) -and
    $currentState.PSObject.Properties.Name -contains "manifestPath" -and
    -not [string]::IsNullOrWhiteSpace([string]$currentState.manifestPath)
  ) {
    $ManifestPath = [string]$currentState.manifestPath
  }
  if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
      $ReleaseRoot = Split-Path -Parent $ManifestPath
    } else {
      $ReleaseRoot = Split-Path -Parent $PSScriptRoot
    }
  }
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $ReleaseRoot "manifest.json"
  }

  $manifest = Read-AsukaManifest -Path $ManifestPath
  if ([string]$currentState.releaseId -ne [string]$manifest.releaseId) {
    throw "Deployment state and manifest releaseId do not match."
  }
  $releaseFiles = @(Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $syncScript = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.syncWorker.destination)
  $expectedSyncScriptHash = ([string]$manifest.syncWorker.sha256).ToLowerInvariant()
  if (
    -not ($currentState.PSObject.Properties.Name -contains "syncWorker") -or
    [string]$currentState.syncWorker.destination -ne
      [string]$manifest.syncWorker.destination -or
    ([string]$currentState.syncWorker.sha256).ToLowerInvariant() -ne
      $expectedSyncScriptHash
  ) {
    throw "Deployment state does not contain the active sync worker integrity contract."
  }
  $installedSyncScriptHash = Get-AsukaSha256 -Path $syncScript
  if (
    $installedSyncScriptHash -ne $expectedSyncScriptHash -or
    [int64](Get-Item -LiteralPath $syncScript).Length -ne
      [int64]$manifest.syncWorker.bytes
  ) {
    throw "Installed sync worker does not match the release integrity contract."
  }
  if (
    -not (Test-Path -LiteralPath ([string]$currentState.backupPath) -PathType Container) -or
    -not (
      Test-Path -LiteralPath (
        Join-Path ([string]$currentState.backupPath) "backup-complete.marker"
      ) -PathType Leaf
    )
  ) {
    throw "The active deployment no longer has a complete rollback backup."
  }
  if (
    -not ($currentState.PSObject.Properties.Name -contains "migration") -or
    $null -eq $currentState.migration
  ) {
    throw "Deployment state has no persisted migration result."
  }
  $persistedMigration = $currentState.migration
  if (
    -not ($persistedMigration.PSObject.Properties.Name -contains "reportPath") -or
    [string]::IsNullOrWhiteSpace([string]$persistedMigration.reportPath) -or
    -not (Test-Path -LiteralPath ([string]$persistedMigration.reportPath) -PathType Leaf)
  ) {
    throw "Persisted migration report is missing."
  }
  $migrationReport = Get-Content -LiteralPath ([string]$persistedMigration.reportPath) `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    -not ($migrationReport.PSObject.Properties.Name -contains "rejudgement") -or
    $null -eq $migrationReport.rejudgement
  ) {
    throw "Persisted migration report has no legacy rejudgement result."
  }
  foreach ($gate in @(
    $persistedMigration.rejudgementGate,
    $migrationReport.rejudgementGate
  )) {
    $consolidationStatus = [string]$gate.consolidation.status
    $consolidationComplete = (
      $consolidationStatus -eq "completed" -or
      $consolidationStatus -eq "not_required"
    )
    $missingRequiredConsolidation = (
      [int]$gate.extractions.withClaims -gt 0 -and
      $consolidationStatus -ne "completed"
    )
    if (
      $null -eq $gate -or
      -not [bool]$gate.passed -or
      [int]$gate.jobs.pending -ne 0 -or
      [int]$gate.jobs.running -ne 0 -or
      [int]$gate.jobs.failed -ne 0 -or
      [int]$gate.claims.provisionalOpen -ne 0 -or
      [int]$gate.extractions.completed -ne [int]$gate.events.eligible -or
      -not $consolidationComplete -or
      $missingRequiredConsolidation -or
      [int]$gate.coverage.coveredSourceEvents -ne [int]$gate.coverage.sourceEvents
    ) {
      throw "Persisted legacy rejudgement gate is missing or has blockers."
    }
  }

  $activePlugin = Join-Path $AppRoot "home\.openclaw\extensions\qqbot"
  $activeHashes = @()
  foreach ($entry in @($manifest.runtimeFiles)) {
    $destination = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$entry.destination)
    if (
      -not $destination.StartsWith(
        "$activePlugin\",
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Runtime manifest destination is outside the active QQBot plugin."
    }
    $actualHash = Get-AsukaSha256 -Path $destination
    if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Active runtime hash mismatch: $($entry.destination)"
    }
    if ([int64](Get-Item -LiteralPath $destination).Length -ne [int64]$entry.bytes) {
      throw "Active runtime size mismatch: $($entry.destination)"
    }
    $activeHashes += [pscustomobject]@{
      destination = [string]$entry.destination
      sha256 = $actualHash
    }
  }

  $node = Join-Path $AppRoot (
    "tools\node-{0}\node.exe" -f [string]$manifest.requirements.nodeVersion
  )
  $nodeVersionResult = Invoke-AsukaNative -FilePath $node -Arguments @("--version")
  if (
    $nodeVersionResult.ExitCode -ne 0 -or
    $nodeVersionResult.Output.Trim() -ne [string]$manifest.requirements.nodeVersion
  ) {
    throw "Bundled Node.js does not match the release requirement."
  }
  $openClawPackage = Join-Path $AppRoot "tools\node_modules\openclaw\package.json"
  $openClawPackageJson = Get-Content -LiteralPath $openClawPackage -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if ([string]$openClawPackageJson.version -ne [string]$manifest.requirements.openClawVersion) {
    throw "OpenClaw does not match the release requirement."
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.database)
  $ledgerVerifier = Join-Path $ReleaseRoot "ops\verify-ledger.mjs"
  $ledgerResult = Invoke-AsukaNative -FilePath $node -Arguments @(
    $ledgerVerifier,
    $activePlugin,
    $ledger
  )
  if ($ledgerResult.ExitCode -ne 0) {
    throw "Memory ledger verification failed: $($ledgerResult.Output)"
  }
  $ledgerReport = $ledgerResult.Output.Trim()
  try {
    $ledgerReport = $ledgerReport | ConvertFrom-Json
  } catch {
    # Keep sanitized native output when a module warning precedes the JSON result.
  }

  $gatewayTaskName = [string]$manifest.requirements.tasks.gateway
  $syncTaskName = [string]$manifest.requirements.tasks.sync
  $gatewayTask = Get-AsukaTaskSnapshot -Name $gatewayTaskName
  $syncTask = Get-AsukaTaskSnapshot -Name $syncTaskName
  if (-not $gatewayTask.enabled -or -not $gatewayTask.wasRunning) {
    throw "$gatewayTaskName is not enabled and running."
  }
  if (-not $syncTask.enabled -or -not $syncTask.wasRunning) {
    throw "$syncTaskName is not enabled and running."
  }

  $gatewayScript = Join-Path $AppRoot "asuka-gateway-task.ps1"
  $gatewayActions = @($gatewayTask.actions)
  $syncActions = @($syncTask.actions)
  if (
    $gatewayActions.Count -ne 1 -or
    -not (Test-AsukaPowerShellFileAction -Action $gatewayActions[0] -ScriptPath $gatewayScript)
  ) {
    throw "$gatewayTaskName action does not reference the audited gateway script."
  }
  if (
    $syncActions.Count -ne 1 -or
    -not (Test-AsukaPowerShellFileAction -Action $syncActions[0] -ScriptPath $syncScript)
  ) {
    throw "$syncTaskName action does not reference the audited sync script."
  }

  $gatewayPort = [int]$manifest.requirements.gatewayPort
  $gatewayLogOffset = [int64]$currentState.gatewayLogOffset
  $gatewayReady = Wait-AsukaGatewayReady -TaskName $gatewayTaskName -AppRoot $AppRoot `
    -Port $gatewayPort -LogPath (Join-Path $AppRoot "logs\gateway.task.out.log") `
    -LogOffset $gatewayLogOffset -TimeoutSeconds $GatewayReadyTimeoutSeconds

  $syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  if (Test-AsukaExclusiveFileAccess -Path $syncLock) {
    throw "$syncTaskName is running but does not own its process lock."
  }
  $syncStatusPath = Join-Path $AppRoot "run\asuka-memory-sync-status.json"
  $syncStatusDeadline = (Get-Date).AddSeconds(10)
  while (
    -not (Test-Path -LiteralPath $syncStatusPath -PathType Leaf) -and
    (Get-Date) -lt $syncStatusDeadline
  ) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-AsukaJsonFile -Path $syncStatusPath)) {
    throw "Memory sync status is missing or invalid."
  }
  $syncStatus = Get-Content -LiteralPath $syncStatusPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if ([string]$syncStatus.state -eq "conflict") {
    throw "Memory sync is paused on a Git conflict."
  }

  $vault = Join-Path $AppRoot "obsidian-vault"
  Assert-AsukaNoGitOperation -Repository $vault
  $memoryStatus = Invoke-AsukaGit -Repository $vault -Arguments @(
    "status", "--porcelain=v1", "--", "Asuka/Memory"
  )
  if ($memoryStatus.ExitCode -ne 0) {
    throw "Unable to inspect Vault changes: $($memoryStatus.Output)"
  }
  $aheadResult = Invoke-AsukaGit -Repository $vault -Arguments @(
    "rev-list", "--count", "@{upstream}..HEAD"
  )
  $behindResult = Invoke-AsukaGit -Repository $vault -Arguments @(
    "rev-list", "--count", "HEAD..@{upstream}"
  )
  $ahead = $null
  $behind = $null
  if ($aheadResult.ExitCode -eq 0) {
    $ahead = [int]($aheadResult.Output.Trim())
  }
  if ($behindResult.ExitCode -eq 0) {
    $behind = [int]($behindResult.Output.Trim())
  }

  $remoteChecked = $false
  if ($RequireVaultPushed) {
    $fetch = Invoke-AsukaGit -Repository $vault -Arguments @("fetch", "--prune")
    if ($fetch.ExitCode -ne 0) {
      throw "Vault push verification could not reach the remote: $($fetch.Output)"
    }
    $remoteChecked = $true
    Assert-AsukaNoGitOperation -Repository $vault
    $aheadResult = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-list", "--count", "@{upstream}..HEAD"
    )
    $behindResult = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-list", "--count", "HEAD..@{upstream}"
    )
    if ($aheadResult.ExitCode -ne 0 -or $behindResult.ExitCode -ne 0) {
      throw "Unable to compare the Vault with its upstream."
    }
    $ahead = [int]($aheadResult.Output.Trim())
    $behind = [int]($behindResult.Output.Trim())
    if (
      -not [string]::IsNullOrWhiteSpace($memoryStatus.Output) -or
      $ahead -ne 0 -or
      $behind -ne 0
    ) {
      throw "Vault memory is not fully pushed: dirty=$(-not [string]::IsNullOrWhiteSpace($memoryStatus.Output)) ahead=$ahead behind=$behind"
    }
  }

  Write-AsukaEnvelope -Ok $true -Operation "verify" -Data ([ordered]@{
    releaseId = [string]$manifest.releaseId
    releaseFiles = $releaseFiles.Count
    activeRuntimeFiles = $activeHashes.Count
    node = $nodeVersionResult.Output.Trim()
    openClaw = [string]$openClawPackageJson.version
    ledger = $ledgerReport
    migration = $persistedMigration
    gateway = $gatewayReady
    gatewayTask = [string]$gatewayTask.state
    syncTask = [string]$syncTask.state
    syncWorker = [ordered]@{
      destination = [string]$manifest.syncWorker.destination
      sha256 = $installedSyncScriptHash
      bytes = [int64](Get-Item -LiteralPath $syncScript).Length
    }
    syncStatus = $syncStatus
    vault = [ordered]@{
      dirty = (-not [string]::IsNullOrWhiteSpace($memoryStatus.Output))
      ahead = $ahead
      behind = $behind
      remoteChecked = $remoteChecked
      pushRequired = [bool]$RequireVaultPushed
      networkRetryIsRuntimeFailure = $false
    }
    backupPath = [string]$currentState.backupPath
  }) -ErrorMessage $null -ExitCode 0
} catch {
  Write-AsukaEnvelope -Ok $false -Operation "verify" -Data $null `
    -ErrorMessage $_.Exception.Message -ExitCode 1
}
