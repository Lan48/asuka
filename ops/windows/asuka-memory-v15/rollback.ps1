[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [bool]$PreservePostCutoverData = $true,
  [int]$TaskStopTimeoutSeconds = 30,
  [int]$GatewayReadyTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")
$env:GIT_TERMINAL_PROMPT = "0"

$operation = "rollback"
$lockStream = $null
$gatewaySnapshot = $null
$syncSnapshot = $null
$failedStatePath = $null
$failedRuntimePath = $null
$runtimeRestored = $false
$tasksRestored = $false
$tasksTouched = $false
$gatewayReady = $null
$gatewayPort = 0
$gatewayLog = ""
$projectionOutboxBeforeStop = $null
$projectionOutboxAfterStop = $null

function Restore-AsukaFileAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Rollback source file is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temporary = "$Destination.rollback.next"
  Copy-Item -LiteralPath $Source -Destination $temporary -Force
  if ((Get-AsukaSha256 -Path $temporary) -ne (Get-AsukaSha256 -Path $Source)) {
    throw "Rollback file staging hash mismatch: $Destination"
  }
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    [IO.File]::Replace($temporary, $Destination, $null)
  } else {
    Move-Item -LiteralPath $temporary -Destination $Destination
  }
}

function Get-AsukaBackupSource {
  param([Parameter(Mandatory = $true)][string]$Relative)

  $normalized = $Relative.Replace("/", "\")
  if ($normalized.StartsWith("home\.openclaw\", [StringComparison]::OrdinalIgnoreCase)) {
    return Join-Path $BackupPath (
      "home\.openclaw\" + $normalized.Substring("home\.openclaw\".Length)
    )
  }
  if ($normalized.StartsWith("obsidian-vault\", [StringComparison]::OrdinalIgnoreCase)) {
    return Join-Path $BackupPath (
      "vault\" + $normalized.Substring("obsidian-vault\".Length)
    )
  }
  throw "Rollback source is outside the backup map: $Relative"
}

function Restore-AsukaGeneratedCache {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentMemoryRoot,
    [Parameter(Mandatory = $true)][string]$BackupMemoryRoot,
    [Parameter(Mandatory = $true)][string]$FailureRoot
  )

  $currentCache = Join-Path $CurrentMemoryRoot ".openclaw-wiki"
  $backupCache = Join-Path $BackupMemoryRoot ".openclaw-wiki"
  $failedCache = Join-Path $FailureRoot "vault-generated-cache"
  if (Test-Path -LiteralPath $currentCache) {
    Move-Item -LiteralPath $currentCache -Destination $failedCache
  }
  if (Test-Path -LiteralPath $backupCache -PathType Container) {
    Copy-AsukaTree -Source $backupCache -Destination $currentCache
  }
  $pendingMarker = Join-Path $CurrentMemoryRoot ".asuka-memory-pending"
  if (Test-Path -LiteralPath $pendingMarker) {
    Move-Item -LiteralPath $pendingMarker -Destination (
      Join-Path $FailureRoot ".asuka-memory-pending"
    )
  }
}

function Restore-AsukaLegacyFileIfInvalid {
  param(
    [Parameter(Mandatory = $true)][string]$Relative,
    [ValidateSet("json", "jsonl")][string]$Format = "json",
    [switch]$Required
  )

  $current = Resolve-AsukaChildPath -Root $AppRoot -Relative $Relative
  $backup = Get-AsukaBackupSource -Relative $Relative
  $valid = if ($Format -eq "jsonl") {
    Test-AsukaJsonLinesFile -Path $current
  } else {
    Test-AsukaJsonFile -Path $current
  }
  $preserved = $PreservePostCutoverData -and $valid
  if (-not $preserved) {
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
      if ($Required) {
        throw "Neither a valid post-cutover file nor its backup is available: $Relative"
      }
      return [pscustomobject]@{
        path = $Relative
        validPostCutover = $valid
        preservedPostCutover = $false
        restoredFromBackup = $false
        unavailable = $true
      }
    }
    if (
      -not $valid -and
      (Test-Path -LiteralPath $current -PathType Leaf) -and
      -not [string]::IsNullOrWhiteSpace($failedStatePath)
    ) {
      $corruptRoot = Join-Path $failedStatePath "legacy-invalid"
      New-Item -ItemType Directory -Force -Path $corruptRoot | Out-Null
      Copy-Item -LiteralPath $current -Destination (
        Join-Path $corruptRoot ([IO.Path]::GetFileName($current))
      ) -Force
    }
    Restore-AsukaFileAtomic -Source $backup -Destination $current
  }
  return [pscustomobject]@{
    path = $Relative
    validPostCutover = $valid
    preservedPostCutover = $preserved
    restoredFromBackup = (-not $preserved)
  }
}

function Invoke-AsukaProjectionOutboxGate {
  param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$VerifierPath,
    [Parameter(Mandatory = $true)][string]$PluginRoot,
    [Parameter(Mandatory = $true)][string]$DatabasePath
  )

  $result = Invoke-AsukaNative -FilePath $NodePath -Arguments @(
    $VerifierPath,
    $PluginRoot,
    $DatabasePath,
    "--outbox-only"
  )
  if ($result.ExitCode -ne 0) {
    throw "Rollback projection outbox verification failed: $($result.Output)"
  }
  $jsonLines = @(
    $result.Output -split "\r?\n" |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  if ($jsonLines.Count -eq 0) {
    throw "Rollback projection outbox verification returned no JSON result."
  }
  try {
    $report = $jsonLines[-1] | ConvertFrom-Json
  } catch {
    throw "Rollback projection outbox verification returned invalid JSON."
  }
  if (
    -not ($report.PSObject.Properties.Name -contains "ok") -or
    -not ($report.ok -is [bool]) -or
    -not ([bool]$report.ok) -or
    -not ($report.PSObject.Properties.Name -contains "projectionOutbox") -or
    $null -eq $report.projectionOutbox
  ) {
    throw "Rollback projection outbox verification is missing its result contract."
  }
  $outbox = $report.projectionOutbox
  [long]$pending = 0
  [long]$failed = 0
  if (
    $null -eq $outbox.pendingCount -or
    -not ([long]::TryParse([string]$outbox.pendingCount, [ref]$pending)) -or
    $pending -lt 0 -or
    $null -eq $outbox.failedCount -or
    -not ([long]::TryParse([string]$outbox.failedCount, [ref]$failed)) -or
    $failed -lt 0 -or
    $failed -gt $pending -or
    -not ($outbox.degraded -is [bool]) -or
    $pending -ne 0 -or
    $failed -ne 0 -or
    [bool]$outbox.degraded
  ) {
    throw "Rollback projection outbox is not clean."
  }
  return [pscustomobject]@{
    degraded = [bool]$outbox.degraded
    pendingCount = $pending
    failedCount = $failed
  }
}

try {
  $appRootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $allowedBackupRoot = [IO.Path]::GetFullPath(
    (Join-Path $appRootFull "backups")
  ).TrimEnd("\")
  $BackupPath = [IO.Path]::GetFullPath($BackupPath)
  if (
    -not $BackupPath.StartsWith(
      "$allowedBackupRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "BackupPath must be a child of '$allowedBackupRoot'."
  }
  $backupIntegrity = Test-AsukaBackupIntegrity -BackupPath $BackupPath
  $manifest = Read-AsukaManifest -Path (Join-Path $BackupPath "manifest.json")
  if (
    -not ([IO.Path]::GetFullPath([string]$manifest.appRoot)).Equals(
      $appRootFull,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Rollback manifest appRoot does not match the requested AppRoot."
  }
  $backupSummary = Get-Content -LiteralPath (Join-Path $BackupPath "backup.json") `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  $backupManifestHash = Get-AsukaSha256 -Path (Join-Path $BackupPath "manifest.json")
  if ($backupManifestHash -ne [string]$backupSummary.sourceManifestSha256) {
    throw "Rollback manifest hash does not match the completed backup."
  }
  $requiredGatewayTask = [string]$manifest.requirements.tasks.gateway
  $requiredSyncTask = [string]$manifest.requirements.tasks.sync
  foreach ($required in @(
    (Join-Path $BackupPath "manifest.json"),
    (Join-Path $BackupPath "backup.json"),
    (Join-Path $BackupPath "tasks\state.json"),
    (Join-Path $BackupPath "tasks\$requiredGatewayTask.xml"),
    (Join-Path $BackupPath "tasks\$requiredSyncTask.xml"),
    (Join-Path $BackupPath "runtime\qqbot"),
    (Join-Path $BackupPath "vault\Asuka\Memory"),
    (Join-Path $BackupPath "acl.json"),
    (Join-Path $BackupPath "config\openclaw.json"),
    (Join-Path $BackupPath "scripts\asuka-gateway-task.ps1"),
    (Join-Path $BackupPath "scripts\asuka-memory-sync.ps1")
  )) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Required rollback asset is missing: $required"
    }
  }

  $releaseId = [string]$manifest.releaseId
  $taskState = Get-Content -LiteralPath (Join-Path $BackupPath "tasks\state.json") `
    -Raw -Encoding UTF8 | ConvertFrom-Json
  $gatewaySnapshot = $taskState.gateway
  $syncSnapshot = $taskState.sync
  $gatewayTaskName = [string]$gatewaySnapshot.name
  $syncTaskName = [string]$syncSnapshot.name
  $gatewayPort = [int]$manifest.requirements.gatewayPort
  $activePlugin = Join-Path $AppRoot "home\.openclaw\extensions\qqbot"
  $vault = Join-Path $AppRoot "obsidian-vault"
  $memoryRoot = Join-Path $vault "Asuka\Memory"
  $backupMemoryRoot = Join-Path $BackupPath "vault\Asuka\Memory"
  $node = Join-Path $AppRoot (
    "tools\node-{0}\node.exe" -f [string]$manifest.requirements.nodeVersion
  )
  $gatewayLog = Join-Path $AppRoot "logs\gateway.task.out.log"
  $syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  $deployLock = Join-Path $AppRoot "run\asuka-memory-v15-deploy.lock"
  $currentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"
  $deploymentStatePath = Join-Path $BackupPath "deployment-state.json"
  $previousRuntimePath = "$activePlugin.v15.previous.$releaseId"
  if (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf) {
    $deploymentState = Get-Content -LiteralPath $deploymentStatePath -Raw -Encoding UTF8 |
      ConvertFrom-Json
    if (
      -not [string]::IsNullOrWhiteSpace([string]$deploymentState.previousRuntimePath) -and
      -not ([IO.Path]::GetFullPath([string]$deploymentState.previousRuntimePath)).Equals(
        [IO.Path]::GetFullPath($previousRuntimePath),
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Deployment state contains an unexpected previous runtime path."
    }
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.migration.database)
  $ledgerVerifier = Join-Path $PSScriptRoot "verify-ledger.mjs"
  $projectionOutboxBeforeStop = Invoke-AsukaProjectionOutboxGate `
    -NodePath $node -VerifierPath $ledgerVerifier -PluginRoot $activePlugin `
    -DatabasePath $ledger

  New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot "run") | Out-Null
  try {
    $lockStream = [IO.File]::Open(
      $deployLock,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "Another Asuka v1.5 deployment or rollback is already running."
  }

  $tasksTouched = $true
  Disable-AndStopAsukaTask -Name $syncTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  if (-not (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
    throw "Memory sync lock remained owned after stopping $syncTaskName."
  }
  Disable-AndStopAsukaTask -Name $gatewayTaskName -TimeoutSeconds $TaskStopTimeoutSeconds
  Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort
  Assert-AsukaNoGitOperation -Repository $vault
  $projectionOutboxAfterStop = Invoke-AsukaProjectionOutboxGate `
    -NodePath $node -VerifierPath $ledgerVerifier -PluginRoot $activePlugin `
    -DatabasePath $ledger

  $failedTimestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $failedStatePath = Join-Path $BackupPath "failed-cutover\$failedTimestamp"
  New-Item -ItemType Directory -Force -Path $failedStatePath | Out-Null
  if (Test-Path -LiteralPath $memoryRoot -PathType Container) {
    Copy-AsukaTree -Source $memoryRoot -Destination (
      Join-Path $failedStatePath "vault-memory-before-rollback"
    )
  }
  foreach ($snapshotFile in @(
    $currentStatePath,
    (Join-Path $AppRoot "run\asuka-memory-sync-status.json"),
    (Join-Path $AppRoot "logs\gateway.task.out.log"),
    (Join-Path $AppRoot "logs\asuka-memory-sync.log")
  )) {
    if (Test-Path -LiteralPath $snapshotFile -PathType Leaf) {
      Copy-Item -LiteralPath $snapshotFile -Destination $failedStatePath
    }
  }
  $vaultHeadBefore = Invoke-AsukaGit -Repository $vault -Arguments @("rev-parse", "HEAD")
  $vaultStatusBefore = Invoke-AsukaGit -Repository $vault -Arguments @(
    "status", "--porcelain=v1", "--", "Asuka/Memory"
  )
  if ($vaultHeadBefore.ExitCode -ne 0 -or $vaultStatusBefore.ExitCode -ne 0) {
    throw "Unable to capture the pre-rollback Vault state."
  }
  Write-AsukaJsonFile -Path (Join-Path $failedStatePath "vault-state.json") -Value ([ordered]@{
    head = $vaultHeadBefore.Output.Trim()
    status = @(
      $vaultStatusBefore.Output -split "\r?\n" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
  })

  $legacyResults = @()
  $memorySource = [string]$manifest.migration.sources.memory
  $legacyResults += Restore-AsukaLegacyFileIfInvalid `
    -Relative $memorySource -Format "json" -Required
  foreach ($propertyName in @("state", "digest", "sessionsIndex")) {
    if (
      $manifest.migration.sources.PSObject.Properties.Name -contains $propertyName -and
      -not [string]::IsNullOrWhiteSpace([string]$manifest.migration.sources.$propertyName)
    ) {
      $legacyResults += Restore-AsukaLegacyFileIfInvalid `
        -Relative ([string]$manifest.migration.sources.$propertyName) -Format "json"
    }
  }
  if (
    $manifest.migration.sources.PSObject.Properties.Name -contains "refIndex" -and
    -not [string]::IsNullOrWhiteSpace([string]$manifest.migration.sources.refIndex)
  ) {
    $legacyResults += Restore-AsukaLegacyFileIfInvalid `
      -Relative ([string]$manifest.migration.sources.refIndex) -Format "jsonl"
  }

  if (-not (Test-Path -LiteralPath $activePlugin -PathType Container)) {
    throw "Active QQBot runtime is missing before rollback: $activePlugin"
  }
  $failedRuntimePath = Join-Path $failedStatePath "runtime\qqbot-v15"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $failedRuntimePath) | Out-Null
  Move-Item -LiteralPath $activePlugin -Destination $failedRuntimePath
  try {
    if (Test-Path -LiteralPath $previousRuntimePath -PathType Container) {
      Move-Item -LiteralPath $previousRuntimePath -Destination $activePlugin
    } else {
      $runtimeRestoreNext = "$activePlugin.rollback.next"
      Copy-AsukaTree -Source (Join-Path $BackupPath "runtime\qqbot") `
        -Destination $runtimeRestoreNext
      Move-Item -LiteralPath $runtimeRestoreNext -Destination $activePlugin
    }
    $runtimeRestored = $true
  } catch {
    if (
      -not (Test-Path -LiteralPath $activePlugin) -and
      (Test-Path -LiteralPath $failedRuntimePath)
    ) {
      Move-Item -LiteralPath $failedRuntimePath -Destination $activePlugin
    }
    throw
  }

  $failedLedgerRoot = Join-Path $failedStatePath "ledger"
  New-Item -ItemType Directory -Force -Path $failedLedgerRoot | Out-Null
  $preexistingLedgerRoot = Join-Path $BackupPath "preexisting-ledger"
  $activationReached = Test-Path -LiteralPath $preexistingLedgerRoot -PathType Container
  foreach ($suffix in @(".next", ".next-wal", ".next-shm")) {
    $stagedLedgerFile = "$ledger$suffix"
    if (Test-Path -LiteralPath $stagedLedgerFile) {
      Move-Item -LiteralPath $stagedLedgerFile -Destination (
        Join-Path $failedLedgerRoot ([IO.Path]::GetFileName($stagedLedgerFile))
      )
    }
  }
  if ($activationReached) {
    foreach ($suffix in @("", "-wal", "-shm")) {
      $activeLedgerFile = "$ledger$suffix"
      if (Test-Path -LiteralPath $activeLedgerFile) {
        Move-Item -LiteralPath $activeLedgerFile -Destination (
          Join-Path $failedLedgerRoot ([IO.Path]::GetFileName($activeLedgerFile))
        )
      }
    }
  }
  $preexistingLedger = Join-Path $preexistingLedgerRoot ([IO.Path]::GetFileName($ledger))
  $hadPreexistingLedger = Test-Path -LiteralPath $preexistingLedger -PathType Leaf
  foreach ($suffix in @("", "-wal", "-shm")) {
    $backupLedgerFile = Join-Path $preexistingLedgerRoot (
      [IO.Path]::GetFileName("$ledger$suffix")
    )
    if (Test-Path -LiteralPath $backupLedgerFile -PathType Leaf) {
      Restore-AsukaFileAtomic -Source $backupLedgerFile -Destination "$ledger$suffix"
    }
  }

  Restore-AsukaFileAtomic -Source (Join-Path $BackupPath "config\openclaw.json") `
    -Destination (Join-Path $AppRoot "home\.openclaw\openclaw.json")
  Restore-AsukaFileAtomic -Source (Join-Path $BackupPath "scripts\asuka-gateway-task.ps1") `
    -Destination (Join-Path $AppRoot "asuka-gateway-task.ps1")
  Restore-AsukaFileAtomic -Source (Join-Path $BackupPath "scripts\asuka-memory-sync.ps1") `
    -Destination (Join-Path $AppRoot "asuka-memory-sync.ps1")

  $vaultRestore = Invoke-AsukaNative -FilePath $node -Arguments @(
    (Join-Path $PSScriptRoot "restore-vault-generated.mjs"),
    $memoryRoot,
    $backupMemoryRoot
  )
  if ($vaultRestore.ExitCode -ne 0) {
    throw "Vault generated-content restoration failed: $($vaultRestore.Output)"
  }
  Restore-AsukaGeneratedCache -CurrentMemoryRoot $memoryRoot `
    -BackupMemoryRoot $backupMemoryRoot -FailureRoot $failedStatePath
  Assert-AsukaNoGitOperation -Repository $vault

  $gitAdd = Invoke-AsukaGit -Repository $vault -Arguments @("add", "--", "Asuka/Memory")
  if ($gitAdd.ExitCode -ne 0) {
    throw "Unable to stage compensating Vault changes: $($gitAdd.Output)"
  }
  $staged = Invoke-AsukaGit -Repository $vault -Arguments @(
    "diff", "--cached", "--quiet", "--", "Asuka/Memory"
  )
  $compensationCommit = $null
  if ($staged.ExitCode -eq 1) {
    $commit = Invoke-AsukaGit -Repository $vault -Arguments @(
      "commit",
      "--only",
      "-m", "revert(memory): compensate Asuka v1.5 rollback $releaseId",
      "--",
      "Asuka/Memory"
    )
    if ($commit.ExitCode -ne 0) {
      throw "Unable to create compensating Vault commit: $($commit.Output)"
    }
    $commitId = Invoke-AsukaGit -Repository $vault -Arguments @("rev-parse", "HEAD")
    if ($commitId.ExitCode -ne 0) {
      throw "Unable to read compensating commit id: $($commitId.Output)"
    }
    $compensationCommit = $commitId.Output.Trim()
  } elseif ($staged.ExitCode -ne 0) {
    throw "Unable to inspect staged compensating changes: $($staged.Output)"
  }

  $pushState = "not_needed"
  $pushDetail = ""
  $ahead = Invoke-AsukaGit -Repository $vault -Arguments @(
    "rev-list", "--count", "@{upstream}..HEAD"
  )
  if ($ahead.ExitCode -eq 0 -and [int]($ahead.Output.Trim()) -gt 0) {
    $push = Invoke-AsukaGit -Repository $vault -Arguments @("push")
    if ($push.ExitCode -eq 0) {
      $pushState = "pushed"
    } else {
      $pushState = "queued"
      $pushDetail = $push.Output
    }
  } elseif ($ahead.ExitCode -ne 0) {
    $pushState = "queued"
    $pushDetail = $ahead.Output
  }

  Set-AsukaTaskFromSnapshot -Snapshot $gatewaySnapshot -XmlPath (
    Join-Path $BackupPath "tasks\$gatewayTaskName.xml"
  )
  Set-AsukaTaskFromSnapshot -Snapshot $syncSnapshot -XmlPath (
    Join-Path $BackupPath "tasks\$syncTaskName.xml"
  )
  $tasksRestored = $true
  $aclRecords = @(
    Get-Content -LiteralPath (Join-Path $BackupPath "acl.json") -Raw -Encoding UTF8 |
      ConvertFrom-Json
  )
  foreach ($aclRecord in $aclRecords) {
    $aclPath = [IO.Path]::GetFullPath([string]$aclRecord.path)
    if (
      -not $aclPath.Equals($appRootFull, [StringComparison]::OrdinalIgnoreCase) -and
      -not $aclPath.StartsWith(
        "$appRootFull\",
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "ACL backup contains a path outside AppRoot."
    }
  }
  Restore-AsukaAclRecords -Records $aclRecords

  if ([bool]$gatewaySnapshot.wasRunning) {
    $gatewayLogOffset = Get-AsukaLogLength -Path $gatewayLog
    Start-ScheduledTask -TaskName $gatewayTaskName
    $gatewayReady = Wait-AsukaGatewayReady -TaskName $gatewayTaskName -AppRoot $AppRoot `
      -Port $gatewayPort -LogPath $gatewayLog -LogOffset $gatewayLogOffset `
      -TimeoutSeconds $GatewayReadyTimeoutSeconds
  }
  if ([bool]$syncSnapshot.wasRunning) {
    Start-ScheduledTask -TaskName $syncTaskName
    Wait-AsukaTaskRunning -Name $syncTaskName -TimeoutSeconds 30
    $lockDeadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $lockDeadline -and (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
      Start-Sleep -Milliseconds 500
    }
    if (Test-AsukaExclusiveFileAccess -Path $syncLock) {
      throw "$syncTaskName is running but did not acquire its process lock."
    }
  }

  $rolledBackState = [ordered]@{
    schemaVersion = 1
    phase = "rolled_back"
    releaseId = $releaseId
    backupPath = $BackupPath
    failedStatePath = $failedStatePath
    rolledBackAt = (Get-Date).ToUniversalTime().ToString("o")
    runtimeRestored = $runtimeRestored
    preexistingLedgerRestored = $hadPreexistingLedger
    legacy = $legacyResults
    vaultCompensationCommit = $compensationCommit
    vaultPushState = $pushState
  }
  Write-AsukaJsonFile -Path (Join-Path $BackupPath "rollback-state.json") `
    -Value $rolledBackState
  Write-AsukaJsonFile -Path $currentStatePath -Value $rolledBackState

  if ($null -ne $lockStream) {
    $lockStream.Dispose()
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    releaseId = $releaseId
    backupPath = $BackupPath
    failedStatePath = $failedStatePath
    runtimeRestored = $runtimeRestored
    preexistingLedgerRestored = $hadPreexistingLedger
    legacy = $legacyResults
    vault = [ordered]@{
      restore = $vaultRestore.Output.Trim()
      compensationCommit = $compensationCommit
      pushState = $pushState
      pushDetail = $pushDetail
    }
    gateway = $gatewayReady
    syncTask = [string](Get-ScheduledTask -TaskName $syncTaskName).State
    projectionOutbox = [ordered]@{
      beforeStop = $projectionOutboxBeforeStop
      afterStop = $projectionOutboxAfterStop
    }
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  $recoveryErrors = @()

  if (
    -not (Test-Path -LiteralPath (Join-Path $AppRoot "home\.openclaw\extensions\qqbot")) -and
    -not [string]::IsNullOrWhiteSpace($failedRuntimePath) -and
    (Test-Path -LiteralPath $failedRuntimePath)
  ) {
    try {
      Move-Item -LiteralPath $failedRuntimePath `
        -Destination (Join-Path $AppRoot "home\.openclaw\extensions\qqbot")
    } catch {
      $recoveryErrors += $_.Exception.Message
    }
  }

  if (
    $tasksTouched -and
    $null -ne $gatewaySnapshot -and
    $null -ne $syncSnapshot
  ) {
    try {
      if (-not $tasksRestored) {
        Set-AsukaTaskFromSnapshot -Snapshot $gatewaySnapshot -XmlPath (
          Join-Path $BackupPath "tasks\$([string]$gatewaySnapshot.name).xml"
        )
        Set-AsukaTaskFromSnapshot -Snapshot $syncSnapshot -XmlPath (
          Join-Path $BackupPath "tasks\$([string]$syncSnapshot.name).xml"
        )
      }
      if ([bool]$gatewaySnapshot.wasRunning) {
        $recoveryLogOffset = Get-AsukaLogLength -Path $gatewayLog
        Start-ScheduledTask -TaskName ([string]$gatewaySnapshot.name)
        [void](Wait-AsukaGatewayReady -TaskName ([string]$gatewaySnapshot.name) `
          -AppRoot $AppRoot -Port $gatewayPort -LogPath $gatewayLog `
          -LogOffset $recoveryLogOffset -TimeoutSeconds $GatewayReadyTimeoutSeconds)
      }
      if ([bool]$syncSnapshot.wasRunning) {
        Start-ScheduledTask -TaskName ([string]$syncSnapshot.name)
      }
    } catch {
      $recoveryErrors += $_.Exception.Message
    }
  }

  if ($null -ne $lockStream) {
    $lockStream.Dispose()
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    backupPath = $BackupPath
    failedStatePath = $failedStatePath
    runtimeRestored = $runtimeRestored
    recoveryErrors = @($recoveryErrors | ForEach-Object { Protect-AsukaText $_ })
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    $lockStream.Dispose()
  }
}
