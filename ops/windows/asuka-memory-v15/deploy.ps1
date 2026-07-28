[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$FrozenBackupPath = "",
  [string]$TaskNormalizationAttestationPath = "",
  [switch]$SkipVaultRemoteGate,
  [int]$TaskStopTimeoutSeconds = 30,
  [int]$GatewayReadyTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")
$env:GIT_TERMINAL_PROMPT = "0"

$operation = "deploy"
$lockStream = $null
$backupPath = $null
$snapshotPath = $null
$deploymentRunRoot = $null
$backupComplete = $false
$gatewayTaskTouched = $false
$syncTaskTouched = $false
$gatewaySnapshot = $null
$syncSnapshot = $null

function Get-MigrationBackupSource {
  param(
    [Parameter(Mandatory = $true)][string]$Relative,
    [Parameter(Mandatory = $true)][string]$Backup
  )

  $normalized = $Relative.Replace("/", "\")
  if ($normalized.StartsWith("home\.openclaw\", [StringComparison]::OrdinalIgnoreCase)) {
    return Join-Path $Backup ("home\.openclaw\" + $normalized.Substring("home\.openclaw\".Length))
  }
  if ($normalized.StartsWith("obsidian-vault\", [StringComparison]::OrdinalIgnoreCase)) {
    $suffix = $normalized.Substring("obsidian-vault\".Length)
    $frozenLayout = Join-Path $Backup ("obsidian-vault\" + $suffix)
    if (Test-Path -LiteralPath $frozenLayout) {
      return $frozenLayout
    }
    return Join-Path $Backup ("vault\" + $suffix)
  }
  throw "Migration source is outside the frozen backup map: $Relative"
}

function Add-MigrationSourceArgument {
  param(
    [Parameter(Mandatory = $true)][System.Collections.ArrayList]$Arguments,
    [Parameter(Mandatory = $true)][string]$Flag,
    [AllowNull()][string]$Path,
    [switch]$Directory
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }
  $exists = if ($Directory) {
    Test-Path -LiteralPath $Path -PathType Container
  } else {
    Test-Path -LiteralPath $Path -PathType Leaf
  }
  if ($exists) {
    [void]$Arguments.Add($Flag)
    [void]$Arguments.Add($Path)
  }
}

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $PSScriptRoot
  }
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $ReleaseRoot "manifest.json"
  }

  $preflightParameters = @{
    AppRoot = $AppRoot
    ReleaseRoot = $ReleaseRoot
    ManifestPath = $ManifestPath
  }
  if ($SkipVaultRemoteGate) {
    $preflightParameters["SkipVaultRemoteGate"] = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($FrozenBackupPath)) {
    $preflightParameters["FrozenBackupPath"] = $FrozenBackupPath
  }
  $preflight = Invoke-AsukaLockedScript -Lease $lockStream `
    -ScriptPath (Join-Path $PSScriptRoot "preflight.ps1") `
    -Parameters $preflightParameters
  if ($preflight.ExitCode -ne 0) {
    throw "Preflight failed: $($preflight.Output)"
  }

  $manifest = Read-AsukaManifest -Path $ManifestPath
  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $releaseId = [string]$manifest.releaseId
  $deploymentRunRoot = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\deployments\{0}" -f $releaseId)
  if (Test-Path -LiteralPath $deploymentRunRoot) {
    throw "Deployment sidecar already exists and requires rollback or manual inspection: $deploymentRunRoot"
  }
  $gatewayTaskName = [string]$manifest.requirements.tasks.gateway
  $syncTaskName = [string]$manifest.requirements.tasks.sync
  $packagedSyncScript = Resolve-AsukaChildPath -Root $ReleaseRoot `
    -Relative ([string]$manifest.syncWorker.source)
  $syncScript = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.syncWorker.destination)
  $expectedSyncScriptHash = ([string]$manifest.syncWorker.sha256).ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($FrozenBackupPath)) {
    throw "FrozenBackupPath is required for an attested fail-closed deployment."
  }
  $frozenBackup = Read-AsukaFrozenBackup -Path $FrozenBackupPath -AppRoot $AppRoot `
    -GatewayTaskName $gatewayTaskName -SyncTaskName $syncTaskName `
    -VerifyCurrentHashes
  $releaseManifestSha256 = Get-AsukaSha256 -Path $ManifestPath
  if (
    ([string]$frozenBackup.manifest.releaseManifestSha256).ToLowerInvariant() -cne
      $releaseManifestSha256 -or
    [int]$frozenBackup.manifest.gatewayPort -ne
      [int]$manifest.requirements.gatewayPort -or
    [string]$frozenBackup.manifest.nodeVersion -cne
      [string]$manifest.requirements.nodeVersion
  ) {
    throw "Frozen backup does not match the release manifest."
  }
  $taskAttestation = if (
    [string]::IsNullOrWhiteSpace($TaskNormalizationAttestationPath)
  ) {
    Find-AsukaTaskNormalizationAttestation -AppRoot $AppRoot `
      -ManifestPath $ManifestPath -Manifest $manifest `
      -FrozenBackupPath $FrozenBackupPath -VerifyCurrentTasks
  } else {
    Read-AsukaTaskNormalizationAttestation `
      -Path $TaskNormalizationAttestationPath -AppRoot $AppRoot `
      -ManifestPath $ManifestPath -Manifest $manifest `
      -FrozenBackupPath $FrozenBackupPath -VerifyCurrentTasks
  }
  New-Item -ItemType Directory -Path $deploymentRunRoot | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $deploymentRunRoot "migration") |
    Out-Null
  $gatewayPort = [int]$manifest.requirements.gatewayPort
  $node = Resolve-AsukaNodePath -AppRoot $AppRoot `
    -NodeVersion ([string]$manifest.requirements.nodeVersion)
  $openClawEntry = Join-Path $AppRoot "tools\node_modules\openclaw\openclaw.mjs"
  $openClawRoot = Join-Path $AppRoot "tools\node_modules\openclaw"
  $openClawHome = Join-Path $AppRoot "home"
  $projectRoot = Join-Path $AppRoot "project"
  $activePlugin = Join-Path $AppRoot "home\.openclaw\extensions\qqbot"
  $openClawConfig = Join-Path $AppRoot "home\.openclaw\openclaw.json"
  $runtimeNext = "$activePlugin.v15.next"
  $runtimePrevious = "$activePlugin.v15.previous.$releaseId"
  $vault = Join-Path $AppRoot "obsidian-vault"
  $memoryRoot = Join-Path $vault "Asuka\Memory"
  $gatewayScript = Join-Path $AppRoot "asuka-gateway-task.ps1"
  $gatewayLog = Join-Path $AppRoot "logs\gateway.task.out.log"
  $syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  $currentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $AppRoot "backups\v15-$timestamp-$releaseId"
  if (Test-Path -LiteralPath $backupPath) {
    throw "Backup path already exists: $backupPath"
  }
  $snapshotPath = Join-Path $backupPath "snapshot"
  New-Item -ItemType Directory -Force -Path (Join-Path $snapshotPath "tasks") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $snapshotPath "scripts") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $snapshotPath "config") | Out-Null

  $currentGatewaySnapshot = Get-AsukaTaskSnapshot -Name $gatewayTaskName `
    -TaskPath ([string]$taskAttestation.gateway.taskPath)
  $currentSyncSnapshot = Get-AsukaTaskSnapshot -Name $syncTaskName `
    -TaskPath ([string]$taskAttestation.sync.taskPath)
  $gatewaySnapshot = [pscustomobject]@{
    name = $gatewayTaskName
    taskPath = [string]$taskAttestation.gateway.taskPath
    enabled = $true
    state = "Running"
    wasRunning = $true
    actions = @($currentGatewaySnapshot.actions)
  }
  $syncSnapshot = [pscustomobject]@{
    name = $syncTaskName
    taskPath = [string]$taskAttestation.sync.taskPath
    enabled = $true
    state = "Running"
    wasRunning = $true
    actions = @($currentSyncSnapshot.actions)
  }
  Write-AsukaUtf8TextFile `
    -Path (Join-Path $snapshotPath "tasks\$gatewayTaskName.xml") `
    -Value ([string]$taskAttestation.gateway.canonicalXml)
  Write-AsukaUtf8TextFile `
    -Path (Join-Path $snapshotPath "tasks\$syncTaskName.xml") `
    -Value ([string]$taskAttestation.sync.canonicalXml)
  Copy-Item -LiteralPath ([string]$taskAttestation.path) `
    -Destination (Join-Path $snapshotPath "tasks\attestation.json")
  Write-AsukaJsonFile -Path (Join-Path $snapshotPath "tasks\state.json") -Value ([ordered]@{
    gateway = $gatewaySnapshot
    sync = $syncSnapshot
  })
  Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $snapshotPath "manifest.json")
  Copy-Item -LiteralPath $gatewayScript -Destination (Join-Path $snapshotPath "scripts\asuka-gateway-task.ps1")
  Copy-Item -LiteralPath $syncScript -Destination (Join-Path $snapshotPath "scripts\asuka-memory-sync.ps1")
  Copy-Item -LiteralPath $openClawConfig `
    -Destination (Join-Path $snapshotPath "config\openclaw.json")
  $aclRecords = Export-AsukaAclRecords -Paths @(
    $openClawConfig,
    $gatewayScript,
    $syncScript,
    (Join-Path $AppRoot "ssh"),
    (Join-Path $AppRoot "ssh\obsidian-memory-ed25519"),
    (Join-Path $AppRoot "ssh\known_hosts"),
    (Join-Path $vault ".git")
  )
  Write-AsukaJsonFile -Path (Join-Path $snapshotPath "acl.json") -Value $aclRecords

  # Freeze writers in dependency order: sync first, then the Gateway.
  $syncTaskTouched = $true
  Disable-AndStopAsukaTask -Name $syncTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  if (-not (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
    throw "Memory sync lock remained owned after stopping $syncTaskName."
  }
  $gatewayTaskTouched = $true
  Disable-AndStopAsukaTask -Name $gatewayTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort

  Copy-AsukaTree -Source (Join-Path $AppRoot "home\.openclaw") `
    -Destination (Join-Path $snapshotPath "home\.openclaw")
  Copy-AsukaTree -Source $activePlugin -Destination (Join-Path $snapshotPath "runtime\qqbot")
  Copy-AsukaTree -Source $vault -Destination (Join-Path $snapshotPath "vault")
  Copy-AsukaTree -Source (Join-Path $AppRoot "ssh") -Destination (Join-Path $snapshotPath "ssh")
  Copy-AsukaTree -Source $projectRoot -Destination (Join-Path $snapshotPath "project")
  Copy-AsukaTree -Source $openClawRoot -Destination (Join-Path $snapshotPath "openclaw")

  $backupTrees = @(
    [pscustomobject]@{
      name = "home"
      source = (Join-Path $AppRoot "home\.openclaw")
      backup = (Join-Path $snapshotPath "home\.openclaw")
    },
    [pscustomobject]@{
      name = "runtime"
      source = $activePlugin
      backup = (Join-Path $snapshotPath "runtime\qqbot")
    },
    [pscustomobject]@{
      name = "vault"
      source = $vault
      backup = (Join-Path $snapshotPath "vault")
    },
    [pscustomobject]@{
      name = "ssh"
      source = (Join-Path $AppRoot "ssh")
      backup = (Join-Path $snapshotPath "ssh")
    },
    [pscustomobject]@{
      name = "project"
      source = $projectRoot
      backup = (Join-Path $snapshotPath "project")
    },
    [pscustomobject]@{
      name = "openclaw"
      source = $openClawRoot
      backup = (Join-Path $snapshotPath "openclaw")
    }
  )
  $backupTreeChecks = @($backupTrees | ForEach-Object {
    $sourceIntegrity = Get-AsukaDirectoryIntegrity -Path ([string]$_.source) `
      -ExcludeReparsePoints
    $backupIntegrity = Get-AsukaDirectoryIntegrity -Path ([string]$_.backup)
    if (
      [int]$sourceIntegrity.fileCount -ne [int]$backupIntegrity.fileCount -or
      [int64]$sourceIntegrity.bytes -ne [int64]$backupIntegrity.bytes -or
      [string]$sourceIntegrity.sha256 -ne [string]$backupIntegrity.sha256
    ) {
      throw "Backup tree integrity mismatch for $([string]$_.name)."
    }
    [pscustomobject]@{
      name = [string]$_.name
      fileCount = [int]$sourceIntegrity.fileCount
      bytes = [int64]$sourceIntegrity.bytes
      sha256 = [string]$sourceIntegrity.sha256
    }
  })

  $backupSummary = [ordered]@{
    releaseId = $releaseId
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    appRoot = $AppRoot
    snapshotPath = $snapshotPath
    frozenBackupPath = $frozenBackup.path
    taskAttestationSha256 = [string]$taskAttestation.sha256
    vaultHead = (
      Invoke-AsukaGit -Repository $vault -Arguments @("rev-parse", "HEAD")
    ).Output.Trim()
    gatewayPort = $gatewayPort
    gatewayTask = $gatewaySnapshot
    syncTask = $syncSnapshot
    sourceManifestSha256 = Get-AsukaSha256 -Path $ManifestPath
    homeBytes = Get-AsukaDirectoryBytes -Path (Join-Path $snapshotPath "home\.openclaw")
    runtimeBytes = Get-AsukaDirectoryBytes -Path (Join-Path $snapshotPath "runtime\qqbot")
    vaultBytes = Get-AsukaDirectoryBytes -Path (Join-Path $snapshotPath "vault")
    projectBytes = Get-AsukaDirectoryBytes -Path (Join-Path $snapshotPath "project")
    openClawBytes = Get-AsukaDirectoryBytes -Path (Join-Path $snapshotPath "openclaw")
    trees = $backupTreeChecks
  }
  Write-AsukaJsonFile -Path (Join-Path $snapshotPath "backup.json") -Value $backupSummary
  $backupIntegrity = Write-AsukaBackupIntegrity -BackupPath $snapshotPath
  $backupComplete = $true

  $deploymentStatePath = Join-Path $deploymentRunRoot "deployment-state.json"
  $deploymentState = [ordered]@{
    schemaVersion = 1
    phase = "backup_sealed"
    releaseId = $releaseId
    backupPath = $backupPath
    snapshotPath = $snapshotPath
    manifestPath = $ManifestPath
    manifestSha256 = $releaseManifestSha256
    frozenBackupPath = [string]$frozenBackup.path
    taskAttestation = [ordered]@{
      snapshotPath = "tasks/attestation.json"
      sha256 = [string]$taskAttestation.sha256
    }
    activePlugin = $activePlugin
    gatewayTask = $gatewaySnapshot
    syncTask = $syncSnapshot
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  Copy-Item -LiteralPath $packagedSyncScript -Destination $syncScript -Force
  if (
    (Get-AsukaSha256 -Path $syncScript) -ne $expectedSyncScriptHash -or
    [int64](Get-Item -LiteralPath $syncScript).Length -ne
      [int64]$manifest.syncWorker.bytes
  ) {
    throw "Installed sync worker does not match the release integrity contract."
  }

  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $memoryConfigScript = Join-Path $ReleaseRoot "ops\configure-memory-kernel.mjs"
  $memoryConfigRun = Invoke-AsukaNative -FilePath $node -Arguments @(
    $memoryConfigScript,
    "--config", $openClawConfig,
    "--manifest", $ManifestPath
  )
  if ($memoryConfigRun.ExitCode -ne 0) {
    throw "Memory kernel configuration failed: $($memoryConfigRun.Output)"
  }
  $env:OPENCLAW_HOME = $openClawHome
  $env:USERPROFILE = $openClawHome
  $env:OPENCLAW_STATE_DIR = Join-Path $AppRoot "home\.openclaw"
  $env:OPENCLAW_CONFIG_PATH = $openClawConfig
  $configuredValidation = Invoke-AsukaNative -FilePath $node -Arguments @(
    $openClawEntry,
    "config",
    "validate"
  )
  if ($configuredValidation.ExitCode -ne 0) {
    throw "Configured OpenClaw configuration is invalid: $($configuredValidation.Output)"
  }

  [void](Test-AsukaRuntimeDependencyTree -Manifest $manifest `
    -PluginRoot $activePlugin)
  if (Test-Path -LiteralPath $runtimeNext) {
    throw "Staged runtime path already exists: $runtimeNext"
  }
  New-Item -ItemType Directory -Path $runtimeNext | Out-Null
  foreach ($preservedDirectory in @($manifest.runtimePreservedDirectories)) {
    $preservedSource = Resolve-AsukaChildPath -Root $activePlugin `
      -Relative ([string]$preservedDirectory)
    if (Test-Path -LiteralPath $preservedSource -PathType Container) {
      $preservedDestination = Resolve-AsukaChildPath -Root $runtimeNext `
        -Relative ([string]$preservedDirectory)
      Copy-AsukaTree -Source $preservedSource -Destination $preservedDestination
    }
  }
  foreach ($entry in @($manifest.runtimeFiles)) {
    $source = Resolve-AsukaChildPath -Root $ReleaseRoot -Relative ([string]$entry.source)
    $activeDestination = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$entry.destination)
    if (-not $activeDestination.StartsWith("$activePlugin\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "Runtime destination is outside the active QQBot plugin: $($entry.destination)"
    }
    $pluginRelative = $activeDestination.Substring($activePlugin.Length).TrimStart("\")
    $stagedDestination = Join-Path $runtimeNext $pluginRelative
    $stagedParent = Split-Path -Parent $stagedDestination
    New-Item -ItemType Directory -Force -Path $stagedParent | Out-Null
    Copy-Item -LiteralPath $source -Destination $stagedDestination -Force
    if ((Get-AsukaSha256 -Path $stagedDestination) -ne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Staged runtime hash mismatch: $($entry.destination)"
    }
  }
  $expectedRuntimePaths = @($manifest.runtimeFiles | ForEach-Object {
    $destination = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$_.destination)
    $destination.Substring($activePlugin.Length).TrimStart("\").Replace("\", "/")
  })
  foreach ($stagedFile in @(Get-ChildItem -LiteralPath $runtimeNext -File -Recurse -Force)) {
    $stagedRelative = $stagedFile.FullName.Substring($runtimeNext.Length).TrimStart("\").Replace("\", "/")
    $isPreservedDependency = @($manifest.runtimePreservedDirectories | Where-Object {
      $stagedRelative.StartsWith("$($_)/", [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    if (-not $isPreservedDependency -and $expectedRuntimePaths -notcontains $stagedRelative) {
      throw "Staged runtime contains an unexpected file: $stagedRelative"
    }
  }
  $stagedDependencyIntegrity = Test-AsukaRuntimeDependencyTree `
    -Manifest $manifest -PluginRoot $runtimeNext

  if (Test-Path -LiteralPath $runtimePrevious) {
    throw "Previous runtime path already exists: $runtimePrevious"
  }
  $deploymentState["phase"] = "runtime_swap_pending"
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState
  Move-Item -LiteralPath $activePlugin -Destination $runtimePrevious
  try {
    Move-Item -LiteralPath $runtimeNext -Destination $activePlugin
  } catch {
    Move-Item -LiteralPath $runtimePrevious -Destination $activePlugin
    throw
  }
  [void](Test-AsukaRuntimeDependencyTree -Manifest $manifest `
    -PluginRoot $activePlugin)
  $deploymentState["phase"] = "runtime_active"
  $deploymentState["previousRuntimePath"] = $runtimePrevious
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  $ledger = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.database)
  $ledgerNext = "$ledger.next"
  $migrationScript = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.script)
  if (-not (Test-Path -LiteralPath $migrationScript -PathType Leaf)) {
    throw "Activated migration script is missing: $migrationScript"
  }

  $sourceArguments = New-Object System.Collections.ArrayList
  $migrationSources = $manifest.migration.sources
  $migrationBackupPath = if ($null -eq $frozenBackup) {
    $backupPath
  } else {
    [string]$frozenBackup.path
  }
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--memory" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.memory) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--claims" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.claims) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--state" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.state) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--digest" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.digest) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--ref-index" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.refIndex) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--sessions-index" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.sessionsIndex) -Backup $migrationBackupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--sessions-dir" -Directory `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.sessionsDirectory) -Backup $migrationBackupPath)

  if (-not (@($sourceArguments) -contains "--memory")) {
    throw "Frozen legacy memory.json is required for migration."
  }
  $scopeArguments = @(
    "--account", [string]$manifest.migration.accountId,
    "--peer", [string]$manifest.migration.peerId
  )
  if (
    $manifest.migration.PSObject.Properties.Name -contains "identityId" -and
    -not [string]::IsNullOrWhiteSpace([string]$manifest.migration.identityId)
  ) {
    $scopeArguments += @("--identity", [string]$manifest.migration.identityId)
  }

  $dryReportPath = Join-Path $deploymentRunRoot "migration\dry-run.json"
  $dryArguments = @($migrationScript) + $scopeArguments + @($sourceArguments) + @(
    "--dry-run", "--report", $dryReportPath
  )
  $dryRun = Invoke-AsukaNative -FilePath $node -Arguments $dryArguments
  if ($dryRun.ExitCode -ne 0) {
    throw "Migration dry-run failed: $($dryRun.Output)"
  }
  $dryReport = Get-Content -LiteralPath $dryReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [int]$dryReport.discoveredRecords -le 0 -or
    @($dryReport.sourceMap).Count -ne [int]$dryReport.discoveredRecords
  ) {
    throw "Migration dry-run source traceability gate failed."
  }

  $migrationReportPath = Join-Path $deploymentRunRoot "migration\migration.json"
  $migrationArguments = @($migrationScript) + $scopeArguments + @($sourceArguments) + @(
    "--database", $ledgerNext,
    "--report", $migrationReportPath,
    "--rejudge",
    "--config", $openClawConfig,
    "--retry-failed"
  )
  $migrationRun = Invoke-AsukaNative -FilePath $node -Arguments $migrationArguments
  if ($migrationRun.ExitCode -ne 0) {
    throw "Migration failed: $($migrationRun.Output)"
  }
  $migrationReport = Get-Content -LiteralPath $migrationReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $migration = $migrationReport.migration
  if (
    -not (
      Assert-AsukaJsonBoolean -Object $migrationReport.integrity `
        -Property "ok"
    )
  ) {
    throw "Migrated ledger integrity gate failed."
  }
  if ($null -eq $migrationReport.rejudgement) {
    throw "Migration did not execute legacy LLM rejudgement."
  }
  $rejudgementGate = $migrationReport.rejudgementGate
  if (
    -not (
      Assert-AsukaJsonBoolean -Object $migrationReport.migrationGate `
        -Property "passed"
    ) -or
    -not (
      Assert-AsukaJsonBoolean -Object $rejudgementGate -Property "passed"
    )
  ) {
    throw "Migration or legacy rejudgement gate did not return boolean true."
  }
  $consolidationStatus = [string]$rejudgementGate.consolidation.status
  $consolidationComplete = (
    $consolidationStatus -eq "completed" -or
    $consolidationStatus -eq "not_required"
  )
  $missingRequiredConsolidation = (
    [int]$rejudgementGate.extractions.withClaims -gt 0 -and
    $consolidationStatus -ne "completed"
  )
  if (
    [int]$rejudgementGate.jobs.pending -ne 0 -or
    [int]$rejudgementGate.jobs.running -ne 0 -or
    [int]$rejudgementGate.jobs.failed -ne 0 -or
    [int]$rejudgementGate.claims.provisionalOpen -ne 0 -or
    [int]$rejudgementGate.extractions.completed -ne [int]$rejudgementGate.events.eligible -or
    -not $consolidationComplete -or
    $missingRequiredConsolidation -or
    [int]$rejudgementGate.coverage.coveredSourceEvents -ne
      [int]$rejudgementGate.coverage.sourceEvents
  ) {
    $rejudgementBlockers = @($rejudgementGate.blockers) -join "; "
    throw "Legacy rejudgement gate failed: $rejudgementBlockers"
  }
  if ([int]$migration.skippedRecords -ne 0) {
    throw "Migration skipped $($migration.skippedRecords) legacy record(s)."
  }
  if (
    @($migration.sourceMap).Count -ne [int]$migration.discoveredRecords -or
    ([int]$migration.importedEvents + [int]$migration.duplicateEvents) -ne [int]$migration.discoveredRecords
  ) {
    throw "Migration did not preserve 100 percent source traceability."
  }
  if (-not (Test-Path -LiteralPath $ledgerNext -PathType Leaf)) {
    throw "Migration did not create the staged ledger."
  }
  $ledgerWal = "$ledgerNext-wal"
  $ledgerShm = "$ledgerNext-shm"
  if ((Test-Path -LiteralPath $ledgerWal) -and (Get-Item -LiteralPath $ledgerWal).Length -gt 0) {
    throw "Staged ledger retained a non-empty WAL after migration."
  }
  foreach ($companion in @($ledgerWal, $ledgerShm)) {
    if (Test-Path -LiteralPath $companion) {
      Remove-Item -LiteralPath $companion -Force
    }
  }

  $preexistingLedgerDirectory = Join-Path $deploymentRunRoot "preexisting-ledger"
  New-Item -ItemType Directory -Path $preexistingLedgerDirectory | Out-Null
  $hadPreexistingLedger = Test-Path -LiteralPath $ledger -PathType Leaf
  $preexistingLedgerFiles = @()
  $deploymentState["phase"] = "ledger_activation_pending"
  $deploymentState["ledgerPath"] = $ledger
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState
  foreach ($suffix in @("", "-wal", "-shm")) {
    $existing = "$ledger$suffix"
    if (Test-Path -LiteralPath $existing) {
      $stored = Join-Path $preexistingLedgerDirectory (
        [IO.Path]::GetFileName($existing)
      )
      Move-Item -LiteralPath $existing -Destination $stored
      $preexistingLedgerFiles += [pscustomobject]@{
        suffix = $suffix
        path = $stored
        bytes = [int64](Get-Item -LiteralPath $stored).Length
        sha256 = Get-AsukaSha256 -Path $stored
      }
    }
  }
  foreach ($entry in @($preexistingLedgerFiles)) {
    if (
      Test-Path -LiteralPath ("$ledger$([string]$entry.suffix)")
    ) {
      throw "Pre-existing ledger was not completely moved before activation."
    }
  }
  Move-Item -LiteralPath $ledgerNext -Destination $ledger
  if (-not (Test-Path -LiteralPath $ledger -PathType Leaf)) {
    throw "Staged ledger did not become the active ledger."
  }
  $activationJournal = [ordered]@{
    schemaVersion = 1
    completed = $true
    releaseId = $releaseId
    ledgerPath = $ledger
    activatedLedger = [ordered]@{
      bytes = [int64](Get-Item -LiteralPath $ledger).Length
      sha256 = Get-AsukaSha256 -Path $ledger
    }
    hadPreexistingLedger = [bool]$hadPreexistingLedger
    preexistingLedgerFiles = $preexistingLedgerFiles
    activatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $activationJournalPath = Join-Path $deploymentRunRoot "activation-journal.json"
  Write-AsukaJsonFile -Path $activationJournalPath -Value $activationJournal
  $activationJournalSha256 = Get-AsukaSha256 -Path $activationJournalPath
  $deploymentState["phase"] = "ledger_active"
  $deploymentState["activationJournal"] = [ordered]@{
    path = $activationJournalPath
    sha256 = $activationJournalSha256
  }
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $ledgerVerifier = Join-Path $ReleaseRoot "ops\verify-ledger.mjs"
  $verifyLedger = Invoke-AsukaNative -FilePath $node -Arguments @(
    $ledgerVerifier,
    $activePlugin,
    $ledger,
    $migrationReportPath
  )
  if ($verifyLedger.ExitCode -ne 0) {
    throw "Activated ledger verification failed: $($verifyLedger.Output)"
  }
  $ledgerActivation = $verifyLedger.Output.Trim() | ConvertFrom-Json
  if (
    -not (Assert-AsukaJsonBoolean -Object $ledgerActivation -Property "ok") -or
    $null -eq $ledgerActivation.cohort
  ) {
    throw "Activated ledger verification returned an invalid contract."
  }

  $env:OPENCLAW_HOME = $openClawHome
  $env:USERPROFILE = $openClawHome
  $env:OPENCLAW_STATE_DIR = Join-Path $AppRoot "home\.openclaw"
  $env:OPENCLAW_CONFIG_PATH = $openClawConfig
  $compile = Invoke-AsukaNative -FilePath $node -Arguments @($openClawEntry, "wiki", "compile")
  if ($compile.ExitCode -ne 0) {
    throw "Memory Wiki compile failed: $($compile.Output)"
  }
  $lint = Invoke-AsukaNative -FilePath $node -Arguments @($openClawEntry, "wiki", "lint")
  if ($lint.ExitCode -ne 0) {
    throw "Memory Wiki lint failed: $($lint.Output)"
  }

  $gatewayLogOffset = Get-AsukaLogLength -Path $gatewayLog
  $deploymentState["phase"] = "starting_gateway"
  $deploymentState["hadPreexistingLedger"] = [bool]$hadPreexistingLedger
  $deploymentState["gatewayLogOffset"] = $gatewayLogOffset
  $deploymentState["runtimeDependencyTree"] = $stagedDependencyIntegrity
  $deploymentState["syncWorker"] = [ordered]@{
    destination = [string]$manifest.syncWorker.destination
    sha256 = $expectedSyncScriptHash
  }
  $deploymentState["migration"] = [ordered]@{
    reportPath = $migrationReportPath
    discoveredRecords = [int]$migration.discoveredRecords
    importedEvents = [int]$migration.importedEvents
    duplicateEvents = [int]$migration.duplicateEvents
    pendingRejudgements = [int]$migration.pendingRejudgements
    rejudgement = $migrationReport.rejudgement
    rejudgementGate = $rejudgementGate
    integrity = $migrationReport.integrity
    stats = $migrationReport.stats
    reportSha256 = Get-AsukaSha256 -Path $migrationReportPath
    cohort = $ledgerActivation.cohort
  }
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  Enable-ScheduledTask -TaskName $gatewayTaskName `
    -TaskPath ([string]$gatewaySnapshot.taskPath) | Out-Null
  Start-ScheduledTask -TaskName $gatewayTaskName `
    -TaskPath ([string]$gatewaySnapshot.taskPath)
  $gatewayReady = Wait-AsukaGatewayReady -TaskName $gatewayTaskName -AppRoot $AppRoot `
    -Port $gatewayPort -LogPath $gatewayLog -LogOffset $gatewayLogOffset `
    -TimeoutSeconds $GatewayReadyTimeoutSeconds

  Enable-ScheduledTask -TaskName $syncTaskName `
    -TaskPath ([string]$syncSnapshot.taskPath) | Out-Null
  Start-ScheduledTask -TaskName $syncTaskName `
    -TaskPath ([string]$syncSnapshot.taskPath)
  $syncDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $syncDeadline) {
    if (
      [string](Get-ScheduledTask -TaskName $syncTaskName `
        -TaskPath ([string]$syncSnapshot.taskPath)).State -eq "Running"
    ) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (
    [string](Get-ScheduledTask -TaskName $syncTaskName `
      -TaskPath ([string]$syncSnapshot.taskPath)).State -ne "Running"
  ) {
    throw "$syncTaskName did not return to Running."
  }
  $syncLockDeadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $syncLockDeadline -and (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-AsukaExclusiveFileAccess -Path $syncLock) {
    throw "$syncTaskName is running but did not acquire its process lock."
  }

  $deploymentState["phase"] = "active"
  $deploymentState["completedAt"] = (Get-Date).ToUniversalTime().ToString("o")
  $deploymentState["gatewayReady"] = $gatewayReady
  Write-AsukaJsonFile -Path $deploymentStatePath -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  $successData = [ordered]@{
    releaseId = $releaseId
    backupPath = $backupPath
    gateway = $gatewayReady
    syncTask = [string](Get-ScheduledTask -TaskName $syncTaskName `
      -TaskPath ([string]$syncSnapshot.taskPath)).State
    ledger = $deploymentState.migration
    vaultPushRequiredForRuntime = $false
    verifyCommand = "powershell -NoProfile -File `"$PSScriptRoot\verify.ps1`" -AppRoot `"$AppRoot`" -ReleaseRoot `"$ReleaseRoot`""
  }
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data $successData `
    -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message

  $rollbackOutput = $null
  $recoveryError = $null
  if (
    $null -ne $lockStream -and
    -not [string]::IsNullOrWhiteSpace($backupPath) -and
    $backupComplete -and
    -not [string]::IsNullOrWhiteSpace($snapshotPath) -and
    (Test-Path -LiteralPath (Join-Path $snapshotPath "backup-complete.marker"))
  ) {
    $rollback = Invoke-AsukaLockedScript -Lease $lockStream `
      -ScriptPath (Join-Path $PSScriptRoot "rollback.ps1") `
      -Parameters @{
        AppRoot = $AppRoot
        BackupPath = $backupPath
      }
    $rollbackOutput = [ordered]@{
      exitCode = $rollback.ExitCode
      output = $rollback.Output
    }
  } elseif ($gatewayTaskTouched -or $syncTaskTouched) {
    try {
      if ($null -ne $syncSnapshot) {
        Disable-AndStopAsukaTask -Name ([string]$syncSnapshot.name) `
          -TaskPath ([string]$syncSnapshot.taskPath) `
          -TimeoutSeconds $TaskStopTimeoutSeconds
      }
      if ($null -ne $gatewaySnapshot) {
        Disable-AndStopAsukaTask -Name ([string]$gatewaySnapshot.name) `
          -TaskPath ([string]$gatewaySnapshot.taskPath) `
          -TimeoutSeconds $TaskStopTimeoutSeconds
      }
    } catch {
      $recoveryError = Protect-AsukaText $_.Exception.Message
    }
  }

  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    backupPath = $backupPath
    rollback = $rollbackOutput
    recoveryError = $recoveryError
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
