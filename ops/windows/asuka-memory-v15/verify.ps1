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
$lockStream = $null

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  $AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  if ([string]::IsNullOrWhiteSpace($CurrentStatePath)) {
    $CurrentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"
  }
  $CurrentStatePath = [IO.Path]::GetFullPath($CurrentStatePath)
  [void](Assert-AsukaNoReparsePointPath -Root $AppRoot `
    -Path $CurrentStatePath)
  if (-not (Test-Path -LiteralPath $CurrentStatePath -PathType Leaf)) {
    throw "Deployment state is missing: $CurrentStatePath"
  }
  $currentState = Get-Content -LiteralPath $CurrentStatePath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $stateSchemaVersion = Assert-AsukaJsonInteger -Object $currentState `
    -Property "schemaVersion" -Minimum 1 -Maximum 1
  if (
    $stateSchemaVersion -ne 1 -or
    [string]$currentState.phase -cne "active" -or
    [string]$currentState.releaseId -notmatch
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"
  ) {
    throw "Asuka v1.5 is not active; current phase is '$($currentState.phase)'."
  }
  foreach ($taskState in @(
    $currentState.gatewayTask,
    $currentState.syncTask
  )) {
    [void](Assert-AsukaJsonBoolean -Object $taskState -Property "enabled")
    [void](Assert-AsukaJsonBoolean -Object $taskState `
      -Property "wasRunning")
    if ([string]$taskState.state -cne "Running") {
      throw "Deployment state contains an invalid scheduled-task lifecycle."
    }
  }
  foreach ($readyProperty in @(
    "port",
    "process",
    "gatewayReady",
    "websocketReady"
  )) {
    [void](Assert-AsukaJsonBoolean -Object $currentState.gatewayReady `
      -Property $readyProperty)
  }
  if (
    -not (
      $currentState.PSObject.Properties.Name -contains
        "hadPreexistingLedger"
    ) -or
    -not ($currentState.hadPreexistingLedger -is [bool])
  ) {
    throw "Deployment state hadPreexistingLedger must be a boolean."
  }
  $hadPreexistingLedger = [bool]$currentState.hadPreexistingLedger

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
  $ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\")
  $ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
  $expectedManifestPath = Resolve-AsukaChildPath -Root $ReleaseRoot `
    -Relative "manifest.json"
  if (
    -not $ManifestPath.Equals(
      $expectedManifestPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not ([IO.Path]::GetFullPath(
      [string]$currentState.manifestPath
    )).Equals(
      $ManifestPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$currentState.manifestSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    (Get-AsukaSha256 -Path $ManifestPath) -cne
      ([string]$currentState.manifestSha256).ToLowerInvariant()
  ) {
    throw "Deployment state is not bound to the selected release manifest."
  }

  $manifest = Read-AsukaManifest -Path $ManifestPath
  if (
    [string]::IsNullOrWhiteSpace([string]$manifest.appRoot) -or
    -not ([IO.Path]::GetFullPath(
      [string]$manifest.appRoot
    )).TrimEnd("\").Equals(
      $AppRoot,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Manifest appRoot does not match requested AppRoot."
  }
  if ([string]$currentState.releaseId -cne [string]$manifest.releaseId) {
    throw "Deployment state and manifest releaseId do not match."
  }
  $releaseId = [string]$manifest.releaseId
  $deploymentRunRoot = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\deployments\{0}" -f $releaseId)
  if (-not (Test-Path -LiteralPath $deploymentRunRoot -PathType Container)) {
    throw "Deployment sidecar directory is missing: $deploymentRunRoot"
  }
  $deploymentStatePath = Join-Path $deploymentRunRoot "deployment-state.json"
  if (
    -not (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf) -or
    (Get-AsukaSha256 -Path $deploymentStatePath) -cne
      (Get-AsukaSha256 -Path $CurrentStatePath)
  ) {
    throw "Current deployment state does not match its release sidecar."
  }
  $releaseFiles = @(Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $trustedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $env:SystemRoot `
      "System32\WindowsPowerShell\v1.0\powershell.exe")
  )
  $embeddingVerification = Invoke-AsukaLocalEmbeddingVerification `
    -ReleaseRoot $ReleaseRoot -TrustedPowerShell $trustedPowerShell `
    -Manifest $manifest
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

  $backupsRoot = [IO.Path]::GetFullPath(
    (Join-Path $AppRoot "backups")
  ).TrimEnd("\")
  $backupPath = [IO.Path]::GetFullPath(
    [string]$currentState.backupPath
  ).TrimEnd("\")
  $snapshotPath = [IO.Path]::GetFullPath(
    [string]$currentState.snapshotPath
  ).TrimEnd("\")
  if (
    -not $backupPath.StartsWith(
      "$backupsRoot\",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not $snapshotPath.Equals(
      (Join-Path $backupPath "snapshot"),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not (Test-Path -LiteralPath $snapshotPath -PathType Container)
  ) {
    throw "The active deployment no longer has a complete rollback backup."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $backupsRoot -Path $backupPath)
  $backupIntegrity = Test-AsukaBackupIntegrity -BackupPath $snapshotPath
  $snapshotManifestPath = Join-Path $snapshotPath "manifest.json"
  $backupSummaryPath = Join-Path $snapshotPath "backup.json"
  $backupSummary = Get-Content -LiteralPath $backupSummaryPath `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    (Get-AsukaSha256 -Path $snapshotManifestPath) -cne
      ([string]$currentState.manifestSha256).ToLowerInvariant() -or
    ([string]$backupSummary.sourceManifestSha256).ToLowerInvariant() -cne
      ([string]$currentState.manifestSha256).ToLowerInvariant() -or
    -not ([IO.Path]::GetFullPath(
      [string]$backupSummary.snapshotPath
    )).TrimEnd("\").Equals(
      $snapshotPath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Rollback snapshot is not bound to the active release manifest."
  }

  if (
    -not ($currentState.PSObject.Properties.Name -contains "taskAttestation") -or
    [string]$currentState.taskAttestation.snapshotPath -cne
      "tasks/attestation.json" -or
    [string]$currentState.taskAttestation.sha256 -notmatch
      "^[a-fA-F0-9]{64}$"
  ) {
    throw "Deployment state has no sealed task normalization attestation."
  }
  $sealedTaskAttestationPath = Resolve-AsukaChildPath -Root $snapshotPath `
    -Relative "tasks\attestation.json"
  if (
    (Get-AsukaSha256 -Path $sealedTaskAttestationPath) -cne
      ([string]$currentState.taskAttestation.sha256).ToLowerInvariant() -or
    ([string]$backupSummary.taskAttestationSha256).ToLowerInvariant() -cne
      ([string]$currentState.taskAttestation.sha256).ToLowerInvariant()
  ) {
    throw "Sealed task normalization attestation hash does not match deployment state."
  }
  $frozenBackupPath = [IO.Path]::GetFullPath(
    [string]$currentState.frozenBackupPath
  ).TrimEnd("\")
  if (-not $frozenBackupPath.StartsWith(
    "$backupsRoot\",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Deployment state has an invalid frozen backup path."
  }
  $taskAttestation = Read-AsukaTaskNormalizationAttestation `
    -Path $sealedTaskAttestationPath -AppRoot $AppRoot `
    -ManifestPath $ManifestPath -Manifest $manifest `
    -FrozenBackupPath $frozenBackupPath -SealedSnapshotPath $snapshotPath `
    -VerifyCurrentTasks -ExpectedCurrentState "Running"
  if (
    [string]$taskAttestation.sha256 -cne
      ([string]$currentState.taskAttestation.sha256).ToLowerInvariant() -or
    [string]$currentState.gatewayTask.taskPath -cne
      [string]$taskAttestation.gateway.taskPath -or
    [string]$currentState.syncTask.taskPath -cne
      [string]$taskAttestation.sync.taskPath
  ) {
    throw "Active scheduled tasks are not bound to the sealed attestation."
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.migration.database)
  $activationJournalPath = Join-Path $deploymentRunRoot `
    "activation-journal.json"
  [void](Assert-AsukaNoReparsePointPath -Root $deploymentRunRoot `
    -Path $activationJournalPath)
  if (
    -not ($currentState.PSObject.Properties.Name -contains
      "activationJournal") -or
    -not ([IO.Path]::GetFullPath(
      [string]$currentState.activationJournal.path
    )).Equals(
      $activationJournalPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$currentState.activationJournal.sha256 -notmatch
      "^[a-fA-F0-9]{64}$" -or
    -not (Test-Path -LiteralPath $activationJournalPath -PathType Leaf) -or
    (Get-AsukaSha256 -Path $activationJournalPath) -cne
      ([string]$currentState.activationJournal.sha256).ToLowerInvariant()
  ) {
    throw "Activation journal path or SHA-256 does not match deployment state."
  }
  $activationJournal = Get-Content -LiteralPath $activationJournalPath `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  $activationSchemaVersion = Assert-AsukaJsonInteger `
    -Object $activationJournal -Property "schemaVersion" `
    -Minimum 1 -Maximum 1
  $activatedLedgerBytes = Assert-AsukaJsonInteger `
    -Object $activationJournal.activatedLedger -Property "bytes" -Minimum 1
  $activationCompleted = Assert-AsukaJsonBoolean `
    -Object $activationJournal -Property "completed"
  $activationHadPreexistingLedger = Assert-AsukaJsonBoolean `
    -Object $activationJournal -Property "hadPreexistingLedger" `
    -Expected $hadPreexistingLedger
  if (
    $activationSchemaVersion -ne 1 -or
    -not $activationCompleted -or
    [string]$activationJournal.releaseId -cne $releaseId -or
    -not ([IO.Path]::GetFullPath(
      [string]$activationJournal.ledgerPath
    )).Equals($ledger, [StringComparison]::OrdinalIgnoreCase) -or
    [string]$activationJournal.activatedLedger.sha256 -notmatch
      "^[a-fA-F0-9]{64}$" -or
    $activatedLedgerBytes -lt 1 -or
    [bool]$activationHadPreexistingLedger -ne
      $hadPreexistingLedger
  ) {
    throw "Activation journal schema does not match the active deployment."
  }

  if (
    -not ($currentState.PSObject.Properties.Name -contains "migration") -or
    $null -eq $currentState.migration
  ) {
    throw "Deployment state has no persisted migration result."
  }
  $persistedMigration = $currentState.migration
  $migrationRoot = Resolve-AsukaChildPath -Root $deploymentRunRoot `
    -Relative "migration"
  $migrationReportPath = [IO.Path]::GetFullPath(
    [string]$persistedMigration.reportPath
  )
  if (
    -not ($persistedMigration.PSObject.Properties.Name -contains "reportPath") -or
    [string]::IsNullOrWhiteSpace([string]$persistedMigration.reportPath) -or
    -not $migrationReportPath.StartsWith(
      "$migrationRoot\",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not (Test-Path -LiteralPath $migrationReportPath -PathType Leaf) -or
    [string]$persistedMigration.reportSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    (Get-AsukaSha256 -Path $migrationReportPath) -cne
      ([string]$persistedMigration.reportSha256).ToLowerInvariant()
  ) {
    throw "Persisted migration report is missing."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $migrationRoot `
    -Path $migrationReportPath)
  $migrationReport = Get-Content -LiteralPath $migrationReportPath `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  [void](Assert-AsukaJsonBoolean -Object $persistedMigration.integrity `
    -Property "ok")
  [void](Assert-AsukaJsonBoolean -Object $migrationReport.integrity `
    -Property "ok")
  [void](Assert-AsukaJsonBoolean -Object $migrationReport.migrationGate `
    -Property "passed")
  foreach ($migrationCounter in @(
    "discoveredRecords",
    "importedEvents",
    "duplicateEvents",
    "pendingRejudgements"
  )) {
    $persistedCount = Assert-AsukaJsonInteger -Object $persistedMigration `
      -Property $migrationCounter -Minimum 0
    $reportCount = Assert-AsukaJsonInteger -Object $migrationReport.migration `
      -Property $migrationCounter -Minimum 0
    if ($persistedCount -ne $reportCount) {
      throw "Persisted migration counts do not match the sealed report."
    }
  }
  foreach ($duplicatedField in @(
    [pscustomobject]@{
      persisted = $persistedMigration.rejudgementGate
      report = $migrationReport.rejudgementGate
    },
    [pscustomobject]@{
      persisted = $persistedMigration.integrity
      report = $migrationReport.integrity
    },
    [pscustomobject]@{
      persisted = $persistedMigration.stats
      report = $migrationReport.stats
    }
  )) {
    if (
      ($duplicatedField.persisted | ConvertTo-Json -Depth 24 -Compress) -cne
        ($duplicatedField.report | ConvertTo-Json -Depth 24 -Compress)
    ) {
      throw "Persisted migration result does not match the sealed report."
    }
  }
  if (
    -not ($persistedMigration.PSObject.Properties.Name -contains "cohort") -or
    $null -eq $persistedMigration.cohort -or
    [string]$persistedMigration.cohort.sha256 -notmatch
      "^[a-fA-F0-9]{64}$"
  ) {
    throw "Persisted migration cohort SHA-256 is missing."
  }
  foreach ($gate in @(
    $persistedMigration.rejudgementGate,
    $migrationReport.rejudgementGate
  )) {
    if ($null -eq $gate) {
      throw "Persisted legacy rejudgement gate is missing or has blockers."
    }
    [void](Assert-AsukaJsonBoolean -Object $gate -Property "passed")
    foreach ($counter in @(
      [pscustomobject]@{ target = $gate.jobs; property = "pending" },
      [pscustomobject]@{ target = $gate.jobs; property = "running" },
      [pscustomobject]@{ target = $gate.jobs; property = "failed" },
      [pscustomobject]@{ target = $gate.claims; property = "provisionalOpen" },
      [pscustomobject]@{ target = $gate.extractions; property = "completed" },
      [pscustomobject]@{ target = $gate.extractions; property = "withClaims" },
      [pscustomobject]@{ target = $gate.events; property = "eligible" },
      [pscustomobject]@{ target = $gate.coverage; property = "sourceEvents" },
      [pscustomobject]@{
        target = $gate.coverage
        property = "coveredSourceEvents"
      }
    )) {
      [void](Assert-AsukaJsonInteger -Object $counter.target `
        -Property ([string]$counter.property) -Minimum 0)
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
  $expectedRuntimePaths = @($manifest.runtimeFiles | ForEach-Object {
    $destination = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$_.destination)
    $destination.Substring($activePlugin.Length).TrimStart("\").Replace("\", "/")
  })
  foreach ($activeFile in @(Get-ChildItem -LiteralPath $activePlugin -File -Recurse -Force)) {
    $activeRelative = $activeFile.FullName.Substring($activePlugin.Length).TrimStart("\").Replace("\", "/")
    $isPreservedDependency = @($manifest.runtimePreservedDirectories | Where-Object {
      $activeRelative.StartsWith("$($_)/", [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    if (-not $isPreservedDependency -and $expectedRuntimePaths -notcontains $activeRelative) {
      throw "Active runtime contains an unexpected file: $activeRelative"
    }
  }
  $activeDependencyIntegrity = Test-AsukaRuntimeDependencyTree `
    -Manifest $manifest -PluginRoot $activePlugin
  if (
    -not ($currentState.PSObject.Properties.Name -contains
      "runtimeDependencyTree") -or
    [int]$currentState.runtimeDependencyTree.fileCount -ne
      [int]$activeDependencyIntegrity.fileCount -or
    [int64]$currentState.runtimeDependencyTree.bytes -ne
      [int64]$activeDependencyIntegrity.bytes -or
    [string]$currentState.runtimeDependencyTree.sha256 -cne
      [string]$activeDependencyIntegrity.sha256
  ) {
    throw "Active runtime dependency tree does not match deployment state."
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
  $openClawHome = Join-Path $AppRoot "home"
  $openClawConfig = Join-Path $AppRoot "home\.openclaw\openclaw.json"
  $openClawEntry = Join-Path $AppRoot "tools\node_modules\openclaw\openclaw.mjs"
  $env:OPENCLAW_HOME = $openClawHome
  $env:USERPROFILE = $openClawHome
  $env:OPENCLAW_STATE_DIR = Join-Path $AppRoot "home\.openclaw"
  $env:OPENCLAW_CONFIG_PATH = $openClawConfig
  $configValidation = Invoke-AsukaNative -FilePath $node -Arguments @(
    $openClawEntry,
    "config",
    "validate"
  )
  if ($configValidation.ExitCode -ne 0) {
    throw "Active OpenClaw configuration is invalid: $($configValidation.Output)"
  }
  $kernelConfigProbe = Invoke-AsukaNative -FilePath $node -Arguments @(
    (Join-Path $ReleaseRoot "ops\configure-memory-kernel.mjs"),
    "--config", $openClawConfig,
    "--manifest", $ManifestPath,
    "--verify-only", "true"
  )
  if ($kernelConfigProbe.ExitCode -ne 0) {
    throw "Active memory kernel configuration does not match the release: $($kernelConfigProbe.Output)"
  }
  $modelConfigProbe = Invoke-AsukaNative -FilePath $node -Arguments @(
    (Join-Path $ReleaseRoot "ops\verify-model-config.mjs"),
    $activePlugin,
    $openClawConfig,
    [string]$manifest.migration.accountId
  )
  if ($modelConfigProbe.ExitCode -ne 0) {
    throw "Active memory model configuration is not ready: $($modelConfigProbe.Output)"
  }

  $ledgerVerifier = Join-Path $ReleaseRoot "ops\verify-ledger.mjs"
  $ledgerResult = Invoke-AsukaNative -FilePath $node -Arguments @(
    $ledgerVerifier,
    $activePlugin,
    $ledger,
    [string]$persistedMigration.reportPath,
    [string]$persistedMigration.cohort.sha256
  )
  if ($ledgerResult.ExitCode -ne 0) {
    throw "Memory ledger verification failed: $($ledgerResult.Output)"
  }
  $ledgerJsonLines = @(
    $ledgerResult.Output -split "\r?\n" |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  if ($ledgerJsonLines.Count -eq 0) {
    throw "Memory ledger verification returned no JSON result."
  }
  try {
    $ledgerReport = $ledgerJsonLines[-1] | ConvertFrom-Json
  } catch {
    throw "Memory ledger verification returned invalid JSON."
  }
  if (
    -not ($ledgerReport.PSObject.Properties.Name -contains "ok") -or
    -not ($ledgerReport.ok -is [bool]) -or
    -not ([bool]$ledgerReport.ok) -or
    -not ($ledgerReport.PSObject.Properties.Name -contains "projectionOutbox") -or
    $null -eq $ledgerReport.projectionOutbox
  ) {
    throw "Memory ledger verification result is missing its outbox contract."
  }
  $projectionOutbox = $ledgerReport.projectionOutbox
  [long]$projectionPending = 0
  [long]$projectionFailed = 0
  if (
    $null -eq $projectionOutbox.pendingCount -or
    -not ([long]::TryParse(
      [string]$projectionOutbox.pendingCount,
      [ref]$projectionPending
    )) -or
    $projectionPending -lt 0 -or
    $null -eq $projectionOutbox.failedCount -or
    -not ([long]::TryParse(
      [string]$projectionOutbox.failedCount,
      [ref]$projectionFailed
    )) -or
    $projectionFailed -lt 0 -or
    $projectionFailed -gt $projectionPending -or
    -not ($projectionOutbox.degraded -is [bool]) -or
    $projectionPending -ne 0 -or
    $projectionFailed -ne 0 -or
    [bool]$projectionOutbox.degraded
  ) {
    throw "Memory ledger projection outbox is not clean."
  }

  $gatewayTaskName = [string]$manifest.requirements.tasks.gateway
  $syncTaskName = [string]$manifest.requirements.tasks.sync
  $gatewayTask = Get-AsukaTaskSnapshot -Name $gatewayTaskName `
    -TaskPath ([string]$taskAttestation.gateway.taskPath)
  $syncTask = Get-AsukaTaskSnapshot -Name $syncTaskName `
    -TaskPath ([string]$taskAttestation.sync.taskPath)
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
    -not (
      Test-AsukaPowerShellFileAction -Action $gatewayActions[0] `
        -ScriptPath $gatewayScript -AllowedWorkingDirectory $AppRoot
    )
  ) {
    throw "$gatewayTaskName action does not reference the audited gateway script."
  }
  if (
    $syncActions.Count -ne 1 -or
    -not (
      Test-AsukaPowerShellFileAction -Action $syncActions[0] `
        -ScriptPath $syncScript -AllowedWorkingDirectory $AppRoot
    )
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

  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation "verify" -Data ([ordered]@{
    releaseId = [string]$manifest.releaseId
    releaseFiles = $releaseFiles.Count
    activeRuntimeFiles = $activeHashes.Count
    node = $nodeVersionResult.Output.Trim()
    openClaw = [string]$openClawPackageJson.version
    localEmbedding = $embeddingVerification
    kernelConfig = ($kernelConfigProbe.Output.Trim() | ConvertFrom-Json)
    modelConfig = ($modelConfigProbe.Output.Trim() | ConvertFrom-Json)
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
    backupIntegrity = $backupIntegrity
  }) -ErrorMessage $null -ExitCode 0
} catch {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation "verify" -Data $null `
    -ErrorMessage $_.Exception.Message -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
