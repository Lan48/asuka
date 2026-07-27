[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$FrozenBackupPath = "",
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
$backupComplete = $false
$tasksStopped = $false
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
    return Join-Path $Backup ("vault\" + $normalized.Substring("obsidian-vault\".Length))
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
  if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $ReleaseRoot = Split-Path -Parent $PSScriptRoot
  }
  if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $ReleaseRoot "manifest.json"
  }

  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $preflightArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $PSScriptRoot "preflight.ps1"),
    "-AppRoot", $AppRoot,
    "-ReleaseRoot", $ReleaseRoot,
    "-ManifestPath", $ManifestPath
  )
  if ($SkipVaultRemoteGate) {
    $preflightArguments += "-SkipVaultRemoteGate"
  }
  if (-not [string]::IsNullOrWhiteSpace($FrozenBackupPath)) {
    $preflightArguments += @("-FrozenBackupPath", $FrozenBackupPath)
  }
  $preflight = Invoke-AsukaNative -FilePath $powershell -Arguments $preflightArguments
  if ($preflight.ExitCode -ne 0) {
    throw "Preflight failed: $($preflight.Output)"
  }

  $manifest = Read-AsukaManifest -Path $ManifestPath
  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $ReleaseRoot)
  $releaseId = [string]$manifest.releaseId
  $gatewayTaskName = [string]$manifest.requirements.tasks.gateway
  $syncTaskName = [string]$manifest.requirements.tasks.sync
  $frozenBackup = $null
  if (-not [string]::IsNullOrWhiteSpace($FrozenBackupPath)) {
    $frozenBackup = Read-AsukaFrozenBackup -Path $FrozenBackupPath -AppRoot $AppRoot `
      -GatewayTaskName $gatewayTaskName -SyncTaskName $syncTaskName
  }
  $gatewayPort = [int]$manifest.requirements.gatewayPort
  $node = Join-Path $AppRoot (
    "tools\node-{0}\node.exe" -f [string]$manifest.requirements.nodeVersion
  )
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
  $syncScript = Join-Path $AppRoot "asuka-memory-sync.ps1"
  $gatewayLog = Join-Path $AppRoot "logs\gateway.task.out.log"
  $syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  $deployLock = Join-Path $AppRoot "run\asuka-memory-v15-deploy.lock"
  $currentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"

  New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot "run") | Out-Null
  try {
    $lockStream = [IO.File]::Open(
      $deployLock,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "Another Asuka v1.5 deployment is already running."
  }

  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = Join-Path $AppRoot "backups\v15-$timestamp-$releaseId"
  if (Test-Path -LiteralPath $backupPath) {
    throw "Backup path already exists: $backupPath"
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $backupPath "tasks") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $backupPath "scripts") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $backupPath "config") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $backupPath "migration") | Out-Null

  $gatewaySnapshot = Get-AsukaTaskSnapshot -Name $gatewayTaskName
  $syncSnapshot = Get-AsukaTaskSnapshot -Name $syncTaskName
  if ($null -ne $frozenBackup) {
    $gatewaySnapshot.enabled = [bool]$frozenBackup.gatewayTask.Enabled
    $gatewaySnapshot.wasRunning = (
      [string]$frozenBackup.gatewayTask.State -eq "Running"
    )
    $gatewaySnapshot.state = [string]$frozenBackup.gatewayTask.State
    $syncSnapshot.enabled = [bool]$frozenBackup.syncTask.Enabled
    $syncSnapshot.wasRunning = (
      [string]$frozenBackup.syncTask.State -eq "Running"
    )
    $syncSnapshot.state = [string]$frozenBackup.syncTask.State
  }
  Export-ScheduledTask -TaskName $gatewayTaskName |
    Set-Content -LiteralPath (Join-Path $backupPath "tasks\$gatewayTaskName.xml") -Encoding Unicode
  Export-ScheduledTask -TaskName $syncTaskName |
    Set-Content -LiteralPath (Join-Path $backupPath "tasks\$syncTaskName.xml") -Encoding Unicode
  Write-AsukaJsonFile -Path (Join-Path $backupPath "tasks\state.json") -Value ([ordered]@{
    gateway = $gatewaySnapshot
    sync = $syncSnapshot
  })
  Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $backupPath "manifest.json")
  Copy-Item -LiteralPath $gatewayScript -Destination (Join-Path $backupPath "scripts\asuka-gateway-task.ps1")
  Copy-Item -LiteralPath $syncScript -Destination (Join-Path $backupPath "scripts\asuka-memory-sync.ps1")
  Copy-Item -LiteralPath $openClawConfig `
    -Destination (Join-Path $backupPath "config\openclaw.json")
  $aclRecords = Export-AsukaAclRecords -Paths @(
    $openClawConfig,
    $gatewayScript,
    $syncScript,
    (Join-Path $AppRoot "ssh"),
    (Join-Path $AppRoot "ssh\obsidian-memory-ed25519"),
    (Join-Path $AppRoot "ssh\known_hosts"),
    (Join-Path $vault ".git")
  )
  Write-AsukaJsonFile -Path (Join-Path $backupPath "acl.json") -Value $aclRecords

  # Freeze writers in dependency order: sync first, then the Gateway.
  Disable-AndStopAsukaTask -Name $syncTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  if (-not (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
    throw "Memory sync lock remained owned after stopping $syncTaskName."
  }
  Disable-AndStopAsukaTask -Name $gatewayTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort
  $tasksStopped = $true

  Copy-AsukaTree -Source (Join-Path $AppRoot "home\.openclaw") `
    -Destination (Join-Path $backupPath "home\.openclaw")
  Copy-AsukaTree -Source $activePlugin -Destination (Join-Path $backupPath "runtime\qqbot")
  Copy-AsukaTree -Source $vault -Destination (Join-Path $backupPath "vault")
  Copy-AsukaTree -Source (Join-Path $AppRoot "ssh") -Destination (Join-Path $backupPath "ssh")
  Copy-AsukaTree -Source $projectRoot -Destination (Join-Path $backupPath "project")
  Copy-AsukaTree -Source $openClawRoot -Destination (Join-Path $backupPath "openclaw")

  $backupTrees = @(
    [pscustomobject]@{
      name = "home"
      source = (Join-Path $AppRoot "home\.openclaw")
      backup = (Join-Path $backupPath "home\.openclaw")
    },
    [pscustomobject]@{
      name = "runtime"
      source = $activePlugin
      backup = (Join-Path $backupPath "runtime\qqbot")
    },
    [pscustomobject]@{
      name = "vault"
      source = $vault
      backup = (Join-Path $backupPath "vault")
    },
    [pscustomobject]@{
      name = "ssh"
      source = (Join-Path $AppRoot "ssh")
      backup = (Join-Path $backupPath "ssh")
    },
    [pscustomobject]@{
      name = "project"
      source = $projectRoot
      backup = (Join-Path $backupPath "project")
    },
    [pscustomobject]@{
      name = "openclaw"
      source = $openClawRoot
      backup = (Join-Path $backupPath "openclaw")
    }
  )
  $backupTreeChecks = @($backupTrees | ForEach-Object {
    $sourceBytes = Get-AsukaDirectoryBytes -Path ([string]$_.source)
    $backupBytes = Get-AsukaDirectoryBytes -Path ([string]$_.backup)
    if ($sourceBytes -ne $backupBytes) {
      throw "Backup byte-count mismatch for $([string]$_.name): source=$sourceBytes backup=$backupBytes"
    }
    [pscustomobject]@{
      name = [string]$_.name
      sourceBytes = $sourceBytes
      backupBytes = $backupBytes
    }
  })

  $backupSummary = [ordered]@{
    releaseId = $releaseId
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    appRoot = $AppRoot
    frozenBackupPath = if ($null -eq $frozenBackup) { $null } else { $frozenBackup.path }
    vaultHead = (
      Invoke-AsukaGit -Repository $vault -Arguments @("rev-parse", "HEAD")
    ).Output.Trim()
    gatewayPort = $gatewayPort
    gatewayTask = $gatewaySnapshot
    syncTask = $syncSnapshot
    sourceManifestSha256 = Get-AsukaSha256 -Path $ManifestPath
    homeBytes = Get-AsukaDirectoryBytes -Path (Join-Path $backupPath "home\.openclaw")
    runtimeBytes = Get-AsukaDirectoryBytes -Path (Join-Path $backupPath "runtime\qqbot")
    vaultBytes = Get-AsukaDirectoryBytes -Path (Join-Path $backupPath "vault")
    projectBytes = Get-AsukaDirectoryBytes -Path (Join-Path $backupPath "project")
    openClawBytes = Get-AsukaDirectoryBytes -Path (Join-Path $backupPath "openclaw")
    trees = $backupTreeChecks
  }
  Write-AsukaJsonFile -Path (Join-Path $backupPath "backup.json") -Value $backupSummary
  Set-Content -LiteralPath (Join-Path $backupPath "backup-complete.marker") `
    -Value $backupSummary.createdAt -Encoding ASCII
  $backupComplete = $true

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

  Copy-AsukaTree -Source $activePlugin -Destination $runtimeNext
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

  if (Test-Path -LiteralPath $runtimePrevious) {
    throw "Previous runtime path already exists: $runtimePrevious"
  }
  Move-Item -LiteralPath $activePlugin -Destination $runtimePrevious
  try {
    Move-Item -LiteralPath $runtimeNext -Destination $activePlugin
  } catch {
    Move-Item -LiteralPath $runtimePrevious -Destination $activePlugin
    throw
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.database)
  $ledgerNext = "$ledger.next"
  $migrationScript = Resolve-AsukaChildPath -Root $AppRoot -Relative ([string]$manifest.migration.script)
  if (-not (Test-Path -LiteralPath $migrationScript -PathType Leaf)) {
    throw "Activated migration script is missing: $migrationScript"
  }

  $sourceArguments = New-Object System.Collections.ArrayList
  $migrationSources = $manifest.migration.sources
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--memory" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.memory) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--claims" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.claims) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--state" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.state) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--digest" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.digest) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--ref-index" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.refIndex) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--sessions-index" `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.sessionsIndex) -Backup $backupPath)
  Add-MigrationSourceArgument -Arguments $sourceArguments -Flag "--sessions-dir" -Directory `
    -Path (Get-MigrationBackupSource -Relative ([string]$migrationSources.sessionsDirectory) -Backup $backupPath)

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

  $dryReportPath = Join-Path $backupPath "migration\dry-run.json"
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

  $migrationReportPath = Join-Path $backupPath "migration\migration.json"
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
  if (-not [bool]$migrationReport.integrity.ok) {
    throw "Migrated ledger integrity gate failed."
  }
  if ($null -eq $migrationReport.rejudgement) {
    throw "Migration did not execute legacy LLM rejudgement."
  }
  $rejudgementGate = $migrationReport.rejudgementGate
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
    -not [bool]$rejudgementGate.passed -or
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

  $preexistingLedgerDirectory = Join-Path $backupPath "preexisting-ledger"
  New-Item -ItemType Directory -Force -Path $preexistingLedgerDirectory | Out-Null
  $hadPreexistingLedger = Test-Path -LiteralPath $ledger -PathType Leaf
  foreach ($suffix in @("", "-wal", "-shm")) {
    $existing = "$ledger$suffix"
    if (Test-Path -LiteralPath $existing) {
      Move-Item -LiteralPath $existing -Destination (
        Join-Path $preexistingLedgerDirectory ([IO.Path]::GetFileName($existing))
      )
    }
  }
  Move-Item -LiteralPath $ledgerNext -Destination $ledger

  $ledgerVerifier = Join-Path $ReleaseRoot "ops\verify-ledger.mjs"
  $verifyLedger = Invoke-AsukaNative -FilePath $node -Arguments @(
    $ledgerVerifier,
    $activePlugin,
    $ledger
  )
  if ($verifyLedger.ExitCode -ne 0) {
    throw "Activated ledger verification failed: $($verifyLedger.Output)"
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
  $deploymentState = [ordered]@{
    schemaVersion = 1
    phase = "starting_gateway"
    releaseId = $releaseId
    backupPath = $backupPath
    manifestPath = $ManifestPath
    frozenBackupPath = if ($null -eq $frozenBackup) { $null } else { $frozenBackup.path }
    activePlugin = $activePlugin
    previousRuntimePath = $runtimePrevious
    ledgerPath = $ledger
    hadPreexistingLedger = $hadPreexistingLedger
    gatewayLogOffset = $gatewayLogOffset
    gatewayTask = $gatewaySnapshot
    syncTask = $syncSnapshot
    migration = [ordered]@{
      reportPath = $migrationReportPath
      discoveredRecords = [int]$migration.discoveredRecords
      importedEvents = [int]$migration.importedEvents
      duplicateEvents = [int]$migration.duplicateEvents
      pendingRejudgements = [int]$migration.pendingRejudgements
      rejudgement = $migrationReport.rejudgement
      rejudgementGate = $rejudgementGate
      integrity = $migrationReport.integrity
      stats = $migrationReport.stats
    }
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-AsukaJsonFile -Path (Join-Path $backupPath "deployment-state.json") -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  Enable-ScheduledTask -TaskName $gatewayTaskName | Out-Null
  Start-ScheduledTask -TaskName $gatewayTaskName
  $gatewayReady = Wait-AsukaGatewayReady -TaskName $gatewayTaskName -AppRoot $AppRoot `
    -Port $gatewayPort -LogPath $gatewayLog -LogOffset $gatewayLogOffset `
    -TimeoutSeconds $GatewayReadyTimeoutSeconds

  Enable-ScheduledTask -TaskName $syncTaskName | Out-Null
  Start-ScheduledTask -TaskName $syncTaskName
  $syncDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $syncDeadline) {
    if ([string](Get-ScheduledTask -TaskName $syncTaskName).State -eq "Running") {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if ([string](Get-ScheduledTask -TaskName $syncTaskName).State -ne "Running") {
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
  Write-AsukaJsonFile -Path (Join-Path $backupPath "deployment-state.json") -Value $deploymentState
  Write-AsukaJsonFile -Path $currentStatePath -Value $deploymentState

  if ($null -ne $lockStream) {
    $lockStream.Dispose()
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    releaseId = $releaseId
    backupPath = $backupPath
    gateway = $gatewayReady
    syncTask = [string](Get-ScheduledTask -TaskName $syncTaskName).State
    ledger = $deploymentState.migration
    vaultPushRequiredForRuntime = $false
    verifyCommand = "powershell -NoProfile -File `"$PSScriptRoot\verify.ps1`" -AppRoot `"$AppRoot`" -ReleaseRoot `"$ReleaseRoot`""
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
    $lockStream = $null
  }

  $rollbackOutput = $null
  $recoveryError = $null
  if (
    -not [string]::IsNullOrWhiteSpace($backupPath) -and
    $backupComplete -and
    (Test-Path -LiteralPath (Join-Path $backupPath "backup-complete.marker"))
  ) {
    $rollback = Invoke-AsukaNative -FilePath (Get-Command powershell.exe).Source -Arguments @(
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $PSScriptRoot "rollback.ps1"),
      "-AppRoot", $AppRoot,
      "-BackupPath", $backupPath
    )
    $rollbackOutput = [ordered]@{
      exitCode = $rollback.ExitCode
      output = $rollback.Output
    }
  } elseif ($tasksStopped -and $null -ne $gatewaySnapshot -and $null -ne $syncSnapshot) {
    try {
      if ([bool]$gatewaySnapshot.enabled) {
        Enable-ScheduledTask -TaskName ([string]$gatewaySnapshot.name) | Out-Null
        if ([bool]$gatewaySnapshot.wasRunning) {
          $recoveryLogOffset = Get-AsukaLogLength -Path $gatewayLog
          Start-ScheduledTask -TaskName ([string]$gatewaySnapshot.name)
          [void](Wait-AsukaGatewayReady -TaskName ([string]$gatewaySnapshot.name) `
            -AppRoot $AppRoot -Port $gatewayPort -LogPath $gatewayLog `
            -LogOffset $recoveryLogOffset -TimeoutSeconds $GatewayReadyTimeoutSeconds)
        }
      }
      if ([bool]$syncSnapshot.enabled) {
        Enable-ScheduledTask -TaskName ([string]$syncSnapshot.name) | Out-Null
        if ([bool]$syncSnapshot.wasRunning) {
          Start-ScheduledTask -TaskName ([string]$syncSnapshot.name)
        }
      }
    } catch {
      $recoveryError = Protect-AsukaText $_.Exception.Message
    }
  }

  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    backupPath = $backupPath
    rollback = $rollbackOutput
    recoveryError = $recoveryError
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
}
