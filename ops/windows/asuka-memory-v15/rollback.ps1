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
$snapshotPath = $null
$deploymentRunRoot = $null
$failedStatePath = $null
$gatewayTaskName = ""
$gatewayTaskPath = ""
$syncTaskName = ""
$syncTaskPath = ""
$rollbackStage = "acquiring_lock"
$runtimeRestored = $false
$ledgerRestored = $false
$configRestored = $false
$vaultRestored = $false
$aclRestored = $false
$tasksRestored = $false
$gatewayReady = $null
$projectionOutboxAfterStop = $null
$deploymentState = $null
$activationReached = $false
$vaultUpstream = ""
$preRollbackAheadCommits = @()
$vaultPushBlockingCommits = @()
$vaultPushAllowed = $false
$pushDetail = ""

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
  $temporary = "$Destination.rollback.next.$([Guid]::NewGuid().ToString('N'))"
  if (Test-Path -LiteralPath $temporary) {
    throw "Unique rollback staging path already exists: $temporary"
  }
  Copy-Item -LiteralPath $Source -Destination $temporary
  if (
    [int64](Get-Item -LiteralPath $temporary).Length -ne
      [int64](Get-Item -LiteralPath $Source).Length -or
    (Get-AsukaSha256 -Path $temporary) -cne (Get-AsukaSha256 -Path $Source)
  ) {
    throw "Rollback file staging integrity mismatch: $Destination"
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
    return Resolve-AsukaChildPath -Root $snapshotPath -Relative (
      "home\.openclaw\" + $normalized.Substring("home\.openclaw\".Length)
    )
  }
  if ($normalized.StartsWith("obsidian-vault\", [StringComparison]::OrdinalIgnoreCase)) {
    return Resolve-AsukaChildPath -Root $snapshotPath -Relative (
      "vault\" + $normalized.Substring("obsidian-vault\".Length)
    )
  }
  throw "Rollback source is outside the immutable snapshot map: $Relative"
}

function Test-AsukaLegacyFileStructure {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet("memory", "state", "digest", "sessions", "ref-index")]
    [string]$Kind
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  try {
    if ($Kind -eq "ref-index") {
      foreach ($line in @(Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
          continue
        }
        $row = $line | ConvertFrom-Json
        if (
          $null -eq $row -or
          [string]::IsNullOrWhiteSpace([string]$row.k) -or
          -not ($row.PSObject.Properties.Name -contains "t") -or
          $null -eq $row.v -or
          $row.v -is [array]
        ) {
          return $false
        }
      }
      return $true
    }

    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 |
      ConvertFrom-Json
    if ($null -eq $value -or $value -is [array]) {
      return $false
    }
    switch ($Kind) {
      "memory" {
        return (
          $value.PSObject.Properties.Name -contains "memories" -and
          $null -ne $value.memories -and
          -not ($value.memories -is [array])
        )
      }
      "state" {
        return (
          $value.PSObject.Properties.Name -contains "peers" -and
          $null -ne $value.peers -and
          -not ($value.peers -is [array]) -and
          $value.PSObject.Properties.Name -contains "promises" -and
          $null -ne $value.promises -and
          -not ($value.promises -is [array])
        )
      }
      "digest" {
        return (
          $value.PSObject.Properties.Name -contains "digests" -and
          $null -ne $value.digests -and
          -not ($value.digests -is [array])
        )
      }
      "sessions" {
        return $true
      }
    }
  }
  catch {
    return $false
  }
  return $false
}

function Quarantine-AsukaInvalidLegacyFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$FailureRoot
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  $quarantineRoot = Join-Path $FailureRoot "legacy-invalid"
  New-Item -ItemType Directory -Force -Path $quarantineRoot | Out-Null
  $destination = "{0}.{1}" -f (
    (Join-Path $quarantineRoot ([IO.Path]::GetFileName($Path))),
    [Guid]::NewGuid().ToString("N")
  )
  Move-Item -LiteralPath $Path -Destination $destination
  return $destination
}

function Restore-AsukaLegacyFileIfInvalid {
  param(
    [Parameter(Mandatory = $true)][string]$Relative,
    [Parameter(Mandatory = $true)]
    [ValidateSet("memory", "state", "digest", "sessions", "ref-index")]
    [string]$Kind,
    [switch]$Required
  )

  $current = Resolve-AsukaChildPath -Root $AppRoot -Relative $Relative
  $backup = Get-AsukaBackupSource -Relative $Relative
  $validCurrent = Test-AsukaLegacyFileStructure -Path $current -Kind $Kind
  if ($PreservePostCutoverData -and $validCurrent) {
    return [pscustomobject]@{
      path = $Relative
      validPostCutover = $true
      preservedPostCutover = $true
      restoredFromBackup = $false
      quarantined = $null
    }
  }

  $quarantined = $null
  if (Test-Path -LiteralPath $current -PathType Leaf) {
    if (-not $validCurrent) {
      $quarantined = Quarantine-AsukaInvalidLegacyFile -Path $current `
        -FailureRoot $failedStatePath
    } else {
      $replacedRoot = Join-Path $failedStatePath "legacy-replaced"
      New-Item -ItemType Directory -Force -Path $replacedRoot | Out-Null
      $quarantined = Join-Path $replacedRoot (
        "{0}.{1}" -f (
          [IO.Path]::GetFileName($current),
          [Guid]::NewGuid().ToString("N")
        )
      )
      Move-Item -LiteralPath $current -Destination $quarantined
    }
  }

  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    if ($Required) {
      throw "No schema-valid rollback source is available: $Relative"
    }
    return [pscustomobject]@{
      path = $Relative
      validPostCutover = $validCurrent
      preservedPostCutover = $false
      restoredFromBackup = $false
      quarantined = $quarantined
      unavailable = $true
    }
  }
  if (-not (Test-AsukaLegacyFileStructure -Path $backup -Kind $Kind)) {
    throw "Immutable backup has an invalid legacy '$Kind' structure: $Relative"
  }
  Restore-AsukaFileAtomic -Source $backup -Destination $current
  if (-not (Test-AsukaLegacyFileStructure -Path $current -Kind $Kind)) {
    throw "Restored legacy file failed structural validation: $Relative"
  }
  return [pscustomobject]@{
    path = $Relative
    validPostCutover = $validCurrent
    preservedPostCutover = $false
    restoredFromBackup = $true
    quarantined = $quarantined
  }
}

function Restore-AsukaGeneratedCache {
  param(
    [Parameter(Mandatory = $true)][string]$CurrentMemoryRoot,
    [Parameter(Mandatory = $true)][string]$BackupMemoryRoot,
    [Parameter(Mandatory = $true)][string]$FailureRoot
  )

  $currentCache = Join-Path $CurrentMemoryRoot ".openclaw-wiki"
  $backupCache = Join-Path $BackupMemoryRoot ".openclaw-wiki"
  if (Test-Path -LiteralPath $currentCache) {
    Move-Item -LiteralPath $currentCache `
      -Destination (Join-Path $FailureRoot "vault-generated-cache")
  }
  if (Test-Path -LiteralPath $backupCache -PathType Container) {
    Copy-AsukaTree -Source $backupCache -Destination $currentCache
    $sourceIntegrity = Get-AsukaDirectoryIntegrity -Path $backupCache
    $restoredIntegrity = Get-AsukaDirectoryIntegrity -Path $currentCache
    if (
      [string]$sourceIntegrity.sha256 -cne [string]$restoredIntegrity.sha256 -or
      [int]$sourceIntegrity.fileCount -ne [int]$restoredIntegrity.fileCount -or
      [int64]$sourceIntegrity.bytes -ne [int64]$restoredIntegrity.bytes
    ) {
      throw "Restored generated cache does not match the immutable snapshot."
    }
  }
  $pendingMarker = Join-Path $CurrentMemoryRoot ".asuka-memory-pending"
  if (Test-Path -LiteralPath $pendingMarker) {
    Move-Item -LiteralPath $pendingMarker -Destination (
      Join-Path $FailureRoot ".asuka-memory-pending"
    )
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
  }
  catch {
    throw "Rollback projection outbox verification returned invalid JSON."
  }
  if (
    -not (Assert-AsukaJsonBoolean -Object $report -Property "ok") -or
    $null -eq $report.projectionOutbox
  ) {
    throw "Rollback projection outbox verification is missing its result contract."
  }
  $outbox = $report.projectionOutbox
  $pending = Assert-AsukaJsonInteger -Object $outbox `
    -Property "pendingCount" -Minimum 0
  $failed = Assert-AsukaJsonInteger -Object $outbox `
    -Property "failedCount" -Minimum 0
  [void](Assert-AsukaJsonBoolean -Object $outbox `
    -Property "degraded" -Expected $false)
  if ($pending -ne 0 -or $failed -ne 0) {
    throw "Rollback projection outbox is not clean."
  }
  return [pscustomobject]@{
    degraded = $false
    pendingCount = $pending
    failedCount = $failed
  }
}

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  $rollbackStage = "validating_inputs"
  $AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $allowedBackupRoot = [IO.Path]::GetFullPath(
    (Join-Path $AppRoot "backups")
  ).TrimEnd("\")
  $BackupPath = [IO.Path]::GetFullPath($BackupPath).TrimEnd("\")
  if (
    -not $BackupPath.StartsWith(
      "$allowedBackupRoot\",
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "BackupPath must be a child of '$allowedBackupRoot'."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $allowedBackupRoot `
    -Path $BackupPath)
  $snapshotPath = Resolve-AsukaChildPath -Root $BackupPath -Relative "snapshot"
  $backupIntegrity = Test-AsukaBackupIntegrity -BackupPath $snapshotPath

  $snapshotManifestPath = Join-Path $snapshotPath "manifest.json"
  $manifest = Read-AsukaManifest -Path $snapshotManifestPath
  $releaseId = [string]$manifest.releaseId
  $deploymentRunRoot = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\deployments\{0}" -f $releaseId)
  if (-not (Test-Path -LiteralPath $deploymentRunRoot -PathType Container)) {
    throw "Deployment sidecar is missing: $deploymentRunRoot"
  }
  Assert-AsukaNoReparsePointsInTree -Path $deploymentRunRoot

  $releaseRoot = Split-Path -Parent $PSScriptRoot
  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $releaseRoot)
  $backupSummaryPath = Join-Path $snapshotPath "backup.json"
  $backupSummary = Get-Content -LiteralPath $backupSummaryPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if (
    -not ([IO.Path]::GetFullPath([string]$backupSummary.snapshotPath)).TrimEnd("\").Equals(
      $snapshotPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    ([string]$backupSummary.sourceManifestSha256).ToLowerInvariant() -cne
      (Get-AsukaSha256 -Path $snapshotManifestPath)
  ) {
    throw "Rollback snapshot summary does not match the immutable snapshot."
  }

  $requiredGatewayTask = [string]$manifest.requirements.tasks.gateway
  $requiredSyncTask = [string]$manifest.requirements.tasks.sync
  foreach ($required in @(
    $snapshotManifestPath,
    $backupSummaryPath,
    (Join-Path $snapshotPath "tasks\state.json"),
    (Join-Path $snapshotPath "tasks\attestation.json"),
    (Join-Path $snapshotPath "tasks\$requiredGatewayTask.xml"),
    (Join-Path $snapshotPath "tasks\$requiredSyncTask.xml"),
    (Join-Path $snapshotPath "runtime\qqbot"),
    (Join-Path $snapshotPath "vault\Asuka\Memory"),
    (Join-Path $snapshotPath "acl.json"),
    (Join-Path $snapshotPath "config\openclaw.json"),
    (Join-Path $snapshotPath "scripts\asuka-gateway-task.ps1"),
    (Join-Path $snapshotPath "scripts\asuka-memory-sync.ps1")
  )) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Required rollback asset is missing: $required"
    }
  }

  $taskState = Get-Content -LiteralPath (
    Join-Path $snapshotPath "tasks\state.json"
  ) -Raw -Encoding UTF8 | ConvertFrom-Json
  $gatewaySnapshot = $taskState.gateway
  $syncSnapshot = $taskState.sync
  if (
    [string]$gatewaySnapshot.name -cne $requiredGatewayTask -or
    [string]$syncSnapshot.name -cne $requiredSyncTask
  ) {
    if ([string]$gatewaySnapshot.name -cne $requiredGatewayTask) {
      throw "Gateway snapshot task name does not match the release manifest."
    }
    throw "Sync snapshot task name does not match the release manifest."
  }
  foreach ($snapshot in @($gatewaySnapshot, $syncSnapshot)) {
    if (
      -not (Test-AsukaScheduledTaskPath -Path ([string]$snapshot.taskPath)) -or
      -not (Assert-AsukaJsonBoolean -Object $snapshot -Property "enabled") -or
      -not (Assert-AsukaJsonBoolean -Object $snapshot -Property "wasRunning") -or
      [string]$snapshot.state -ne "Running"
    ) {
      throw "Rollback task snapshot has an invalid lifecycle contract."
    }
  }
  $gatewayTaskName = $requiredGatewayTask
  $gatewayTaskPath = [string]$gatewaySnapshot.taskPath
  $syncTaskName = $requiredSyncTask
  $syncTaskPath = [string]$syncSnapshot.taskPath
  if (
    $gatewayTaskName -ceq $syncTaskName -and
    $gatewayTaskPath -ceq $syncTaskPath
  ) {
    throw "Rollback task snapshots must identify distinct scheduled tasks."
  }

  $attestationPath = Join-Path $snapshotPath "tasks\attestation.json"
  if (
    [string]$backupSummary.taskAttestationSha256 -notmatch
      "^[a-fA-F0-9]{64}$" -or
    (Get-AsukaSha256 -Path $attestationPath) -cne
      ([string]$backupSummary.taskAttestationSha256).ToLowerInvariant()
  ) {
    throw "Rollback task attestation does not match the sealed snapshot."
  }
  $taskAttestation = Get-Content -LiteralPath $attestationPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  if (
    [int]$taskAttestation.schemaVersion -ne 1 -or
    [string]$taskAttestation.kind -ne "asuka-task-normalization" -or
    [string]$taskAttestation.releaseId -cne $releaseId -or
    ([string]$taskAttestation.releaseManifestSha256).ToLowerInvariant() -cne
      (Get-AsukaSha256 -Path $snapshotManifestPath)
  ) {
    throw "Rollback task attestation is not bound to the release manifest."
  }
  foreach ($taskContract in @(
    [pscustomobject]@{
      role = "gateway"
      name = $gatewayTaskName
      taskPath = $gatewayTaskPath
      xmlPath = Join-Path $snapshotPath "tasks\$gatewayTaskName.xml"
    },
    [pscustomobject]@{
      role = "sync"
      name = $syncTaskName
      taskPath = $syncTaskPath
      xmlPath = Join-Path $snapshotPath "tasks\$syncTaskName.xml"
    }
  )) {
    $matches = @(
      $taskAttestation.tasks |
        Where-Object { [string]$_.role -ceq [string]$taskContract.role }
    )
    if (
      $matches.Count -ne 1 -or
      [string]$matches[0].taskName -cne [string]$taskContract.name -or
      [string]$matches[0].taskPath -cne [string]$taskContract.taskPath -or
      [string]$matches[0].canonicalXmlSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
      (Get-AsukaStringSha256 -Value ([string]$matches[0].canonicalXml)) -cne
        ([string]$matches[0].canonicalXmlSha256).ToLowerInvariant() -or
      (Get-AsukaStringSha256 -Value (
        [IO.File]::ReadAllText([string]$taskContract.xmlPath)
      )) -cne ([string]$matches[0].canonicalXmlSha256).ToLowerInvariant()
    ) {
      throw "Rollback task XML does not match its canonical attestation."
    }
  }

  $gatewayPort = [int]$manifest.requirements.gatewayPort
  $activePlugin = Join-Path $AppRoot "home\.openclaw\extensions\qqbot"
  $vault = Join-Path $AppRoot "obsidian-vault"
  $memoryRoot = Join-Path $vault "Asuka\Memory"
  $backupMemoryRoot = Join-Path $snapshotPath "vault\Asuka\Memory"
  $node = Resolve-AsukaNodePath -AppRoot $AppRoot `
    -NodeVersion ([string]$manifest.requirements.nodeVersion)
  $gatewayLog = Join-Path $AppRoot "logs\gateway.task.out.log"
  $syncLock = Join-Path $AppRoot "run\asuka-memory-sync.lock"
  $currentStatePath = Join-Path $AppRoot "run\asuka-memory-v15-current.json"
  $deploymentStatePath = Join-Path $deploymentRunRoot "deployment-state.json"
  if (Test-Path -LiteralPath $deploymentStatePath -PathType Leaf) {
    $deploymentState = Get-Content -LiteralPath $deploymentStatePath `
      -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      [string]$deploymentState.releaseId -cne $releaseId -or
      -not ([IO.Path]::GetFullPath(
        [string]$deploymentState.snapshotPath
      )).TrimEnd("\").Equals(
        $snapshotPath,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Deployment state does not match the rollback snapshot."
    }
  }

  $ledger = Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ([string]$manifest.migration.database)
  $activationJournalPath = Join-Path $deploymentRunRoot "activation-journal.json"
  $activationJournalExists = Test-Path -LiteralPath $activationJournalPath `
    -PathType Leaf
  $activationJournalBound = (
    $null -ne $deploymentState -and
    $deploymentState.PSObject.Properties.Name -contains "activationJournal" -and
    $null -ne $deploymentState.activationJournal
  )
  if ($activationJournalExists -and -not $activationJournalBound) {
    throw (
      "Activation journal exists without a completed deployment-state binding; " +
      "ledger files are preserved and rollback requires the dedicated recovery workflow."
    )
  }
  if ($activationJournalBound) {
    if (
      -not ($deploymentState.activationJournal.PSObject.Properties.Name -contains
        "path") -or
      -not ($deploymentState.activationJournal.PSObject.Properties.Name -contains
        "sha256") -or
      [string]$deploymentState.activationJournal.sha256 -notmatch
        "^[a-fA-F0-9]{64}$" -or
      -not ([IO.Path]::GetFullPath(
        [string]$deploymentState.activationJournal.path
      )).Equals(
        $activationJournalPath,
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      -not $activationJournalExists -or
      (Get-AsukaSha256 -Path $activationJournalPath) -cne
        ([string]$deploymentState.activationJournal.sha256).ToLowerInvariant()
    ) {
      throw "Activation journal path or SHA-256 does not match deployment state."
    }
  }
  $activationReached = $activationJournalBound
  $backupLedgerMain = Get-AsukaBackupSource `
    -Relative ([string]$manifest.migration.database
  )
  if ($activationReached) {
    $activationJournal = Get-Content -LiteralPath $activationJournalPath `
      -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      [int]$activationJournal.schemaVersion -ne 1 -or
      -not (
        Assert-AsukaJsonBoolean -Object $activationJournal `
          -Property "completed"
      ) -or
      [string]$activationJournal.releaseId -cne $releaseId -or
      -not ([IO.Path]::GetFullPath(
        [string]$activationJournal.ledgerPath
      )).Equals(
        [IO.Path]::GetFullPath($ledger),
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      [string]$activationJournal.activatedLedger.sha256 -notmatch
        "^[a-fA-F0-9]{64}$"
    ) {
      throw "Activation journal is missing, incomplete, or inconsistent."
    }
    [void](Assert-AsukaJsonInteger `
      -Object $activationJournal.activatedLedger -Property "bytes" -Minimum 1
    )
    if (
      -not (
        $activationJournal.PSObject.Properties.Name -contains
          "hadPreexistingLedger"
      ) -or
      -not ($activationJournal.hadPreexistingLedger -is [bool])
    ) {
      throw "Activation journal hadPreexistingLedger must be a boolean."
    }
    $journalHadPreexisting = [bool]$activationJournal.hadPreexistingLedger
    if ($journalHadPreexisting -ne (
      Test-Path -LiteralPath $backupLedgerMain -PathType Leaf
    )) {
      throw "Activation journal pre-existing ledger intent is inconsistent."
    }
    $journalSuffixes = @{}
    foreach ($entry in @($activationJournal.preexistingLedgerFiles)) {
      $suffix = [string]$entry.suffix
      if (
        @("", "-wal", "-shm") -notcontains $suffix -or
        $journalSuffixes.ContainsKey($suffix) -or
        [string]$entry.sha256 -notmatch "^[a-fA-F0-9]{64}$"
      ) {
        throw "Activation journal contains an invalid pre-existing ledger record."
      }
      $journalSuffixes[$suffix] = $true
      $expectedStored = Join-Path (
        Join-Path $deploymentRunRoot "preexisting-ledger"
      ) ([IO.Path]::GetFileName("$ledger$suffix"))
      if (
        -not ([IO.Path]::GetFullPath([string]$entry.path)).Equals(
          [IO.Path]::GetFullPath($expectedStored),
          [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not (Test-Path -LiteralPath $expectedStored -PathType Leaf) -or
        (Get-AsukaSha256 -Path $expectedStored) -cne
          ([string]$entry.sha256).ToLowerInvariant()
      ) {
        throw "Activation journal pre-existing ledger evidence is inconsistent."
      }
      $journalBytes = Assert-AsukaJsonInteger -Object $entry `
        -Property "bytes" -Minimum 0
      if (
        $journalBytes -ne
          [int64](Get-Item -LiteralPath $expectedStored).Length
      ) {
        throw "Activation journal pre-existing ledger byte count is inconsistent."
      }
    }
  } else {
    foreach ($suffix in @("", "-wal", "-shm")) {
      $activeFile = "$ledger$suffix"
      $backupFile = Get-AsukaBackupSource `
        -Relative ("{0}{1}" -f [string]$manifest.migration.database, $suffix)
      if (
        (Test-Path -LiteralPath $activeFile -PathType Leaf) -and
        -not (Test-Path -LiteralPath $backupFile -PathType Leaf)
      ) {
        throw "Ledger exists without a completed activation journal."
      }
      if (
        (Test-Path -LiteralPath $activeFile -PathType Leaf) -and
        (Get-AsukaSha256 -Path $activeFile) -cne
          (Get-AsukaSha256 -Path $backupFile)
      ) {
        throw "Ledger changed without a completed activation journal."
      }
    }
  }

  $rollbackStage = "stopping_writers"
  Disable-AndStopAsukaTask -Name $syncTaskName -TaskPath $syncTaskPath `
    -TimeoutSeconds $TaskStopTimeoutSeconds
  if (-not (Test-AsukaExclusiveFileAccess -Path $syncLock)) {
    throw "Memory sync lock remained owned after stopping $syncTaskName."
  }
  Disable-AndStopAsukaTask -Name $gatewayTaskName -TaskPath $gatewayTaskPath `
    -TimeoutSeconds $TaskStopTimeoutSeconds
  Assert-AsukaGatewayStopped -AppRoot $AppRoot -Port $gatewayPort

  $rollbackStage = "checking_vault"
  Assert-AsukaNoGitOperation -Repository $vault
  $vaultStatusBefore = Invoke-AsukaGit -Repository $vault -Arguments @(
    "status", "--porcelain=v1", "--", "Asuka/Memory"
  )
  if ($vaultStatusBefore.ExitCode -ne 0) {
    throw "Unable to inspect the pre-rollback Vault state."
  }
  if (-not [string]::IsNullOrWhiteSpace($vaultStatusBefore.Output)) {
    throw "Rollback refused pre-existing Asuka/Memory changes."
  }

  $vaultMemoryPath = "Asuka/Memory"
  $upstreamResult = Invoke-AsukaGit -Repository $vault -Arguments @(
    "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"
  )
  if (
    $upstreamResult.ExitCode -ne 0 -or
    [string]::IsNullOrWhiteSpace($upstreamResult.Output)
  ) {
    $pushDetail = (
      "Vault branch has no readable upstream before rollback; " +
      "the compensation commit will remain queued."
    )
  } else {
    $vaultUpstream = $upstreamResult.Output.Trim()
    $fetch = Invoke-AsukaGit -Repository $vault -Arguments @("fetch", "--prune")
    if ($fetch.ExitCode -ne 0) {
      $pushDetail = (
        "Vault upstream fetch failed before rollback; " +
        "the compensation commit will remain queued: $($fetch.Output)"
      )
    } else {
      $aheadResult = Invoke-AsukaGit -Repository $vault -Arguments @(
        "rev-list", "--reverse", "$vaultUpstream..HEAD"
      )
      if ($aheadResult.ExitCode -ne 0) {
        $pushDetail = (
          "Unable to inspect pre-rollback ahead commits; " +
          "the compensation commit will remain queued: $($aheadResult.Output)"
        )
      } else {
        $aheadInspectionFailed = $false
        foreach ($aheadCommit in @(
          $aheadResult.Output -split "\r?\n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )) {
          $aheadCommit = $aheadCommit.Trim()
          $preRollbackAheadCommits += $aheadCommit
          $scopeGate = Invoke-AsukaGit -Repository $vault -Arguments @(
            "diff-tree",
            "--quiet",
            "--exit-code",
            "--root",
            "-m",
            "-r",
            "--no-renames",
            $aheadCommit,
            "--",
            ".",
            ":(top,exclude)Asuka/Memory",
            ":(top,exclude)Asuka/Memory/**"
          )
          if ($scopeGate.ExitCode -gt 1) {
            $pushDetail = (
              "Unable to inspect pre-rollback commit $aheadCommit; " +
              "the compensation commit will remain queued: $($scopeGate.Output)"
            )
            $aheadInspectionFailed = $true
            break
          }
          if ($scopeGate.ExitCode -eq 1) {
            $outsideResult = Invoke-AsukaGit -Repository $vault -Arguments @(
              "diff-tree",
              "--root",
              "-m",
              "--no-commit-id",
              "--name-only",
              "-z",
              "-r",
              "--no-renames",
              $aheadCommit,
              "--",
              ".",
              ":(top,exclude)Asuka/Memory",
              ":(top,exclude)Asuka/Memory/**"
            )
            if ($outsideResult.ExitCode -ne 0) {
              $pushDetail = (
                "Unable to report paths for pre-rollback commit $aheadCommit; " +
                "the compensation commit will remain queued: $($outsideResult.Output)"
              )
              $aheadInspectionFailed = $true
              break
            }
            $outsidePaths = @(
              $outsideResult.Output -split "`0" |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                ForEach-Object { ([string]$_).Replace("\", "/") } |
                Sort-Object -Unique
            )
            $vaultPushBlockingCommits += [pscustomobject]@{
              commit = $aheadCommit
              paths = @($outsidePaths)
            }
          }
        }
        if (-not $aheadInspectionFailed) {
          if ($vaultPushBlockingCommits.Count -eq 0) {
            $vaultPushAllowed = $true
          } else {
            $blockingDetails = @(
              $vaultPushBlockingCommits | ForEach-Object {
                "{0}: {1}" -f [string]$_.commit, (@($_.paths) -join ", ")
              }
            )
            $pushDetail = (
              "Pre-rollback ahead commits touch paths outside Asuka/Memory; " +
              "the compensation commit will remain queued: " +
              ($blockingDetails -join "; ")
            )
          }
        }
      }
    }
  }

  $ledgerVerifier = Join-Path $releaseRoot "ops\verify-ledger.mjs"
  if ($activationReached) {
    $projectionOutboxAfterStop = Invoke-AsukaProjectionOutboxGate `
      -NodePath $node -VerifierPath $ledgerVerifier -PluginRoot $activePlugin `
      -DatabasePath $ledger
  }

  $rollbackStage = "capturing_failure_evidence"
  $failedStatePath = Join-Path $deploymentRunRoot (
    "failed-cutover\{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff")
  )
  New-Item -ItemType Directory -Path $failedStatePath | Out-Null
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

  $rollbackStage = "restoring_legacy"
  $legacyResults = @()
  $memorySource = [string]$manifest.migration.sources.memory
  $legacyResults += Restore-AsukaLegacyFileIfInvalid `
    -Relative $memorySource -Kind "memory" -Required
  foreach ($legacySource in @(
    [pscustomobject]@{ property = "state"; kind = "state" },
    [pscustomobject]@{ property = "digest"; kind = "digest" },
    [pscustomobject]@{ property = "sessionsIndex"; kind = "sessions" },
    [pscustomobject]@{ property = "refIndex"; kind = "ref-index" }
  )) {
    if (
      $manifest.migration.sources.PSObject.Properties.Name -contains
        [string]$legacySource.property -and
      -not [string]::IsNullOrWhiteSpace(
        [string]$manifest.migration.sources.(
          [string]$legacySource.property
        )
      )
    ) {
      $legacyResults += Restore-AsukaLegacyFileIfInvalid `
        -Relative ([string]$manifest.migration.sources.(
          [string]$legacySource.property
        )) -Kind ([string]$legacySource.kind)
    }
  }

  $rollbackStage = "restoring_runtime"
  if (-not (Test-Path -LiteralPath $activePlugin -PathType Container)) {
    throw "Active QQBot runtime is missing before rollback: $activePlugin"
  }
  $failedRuntimePath = Join-Path $failedStatePath "runtime\qqbot-v15"
  New-Item -ItemType Directory -Force -Path (
    Split-Path -Parent $failedRuntimePath
  ) | Out-Null
  Move-Item -LiteralPath $activePlugin -Destination $failedRuntimePath
  $runtimeRestoreNext = "$activePlugin.rollback.next.$([Guid]::NewGuid().ToString('N'))"
  if (Test-Path -LiteralPath $runtimeRestoreNext) {
    throw "Unique rollback runtime staging path already exists."
  }
  $backupRuntime = Join-Path $snapshotPath "runtime\qqbot"
  Copy-AsukaTree -Source $backupRuntime -Destination $runtimeRestoreNext
  $backupRuntimeIntegrity = Get-AsukaDirectoryIntegrity -Path $backupRuntime
  $stagedRuntimeIntegrity = Get-AsukaDirectoryIntegrity -Path $runtimeRestoreNext
  if (
    [int]$backupRuntimeIntegrity.fileCount -ne
      [int]$stagedRuntimeIntegrity.fileCount -or
    [int64]$backupRuntimeIntegrity.bytes -ne
      [int64]$stagedRuntimeIntegrity.bytes -or
    [string]$backupRuntimeIntegrity.sha256 -cne
      [string]$stagedRuntimeIntegrity.sha256
  ) {
    throw "Rollback runtime staging does not match the exact snapshot tree."
  }
  Move-Item -LiteralPath $runtimeRestoreNext -Destination $activePlugin
  $runtimeRestored = $true

  $rollbackStage = "restoring_ledger"
  $failedLedgerRoot = Join-Path $failedStatePath "ledger"
  New-Item -ItemType Directory -Path $failedLedgerRoot | Out-Null
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
  foreach ($suffix in @("", "-wal", "-shm")) {
    $backupLedgerFile = Get-AsukaBackupSource `
      -Relative ("{0}{1}" -f [string]$manifest.migration.database, $suffix)
    $activeLedgerFile = "$ledger$suffix"
    if (Test-Path -LiteralPath $backupLedgerFile -PathType Leaf) {
      if (-not (Test-Path -LiteralPath $activeLedgerFile -PathType Leaf)) {
        Restore-AsukaFileAtomic -Source $backupLedgerFile `
          -Destination $activeLedgerFile
      } elseif (
        (Get-AsukaSha256 -Path $activeLedgerFile) -cne
          (Get-AsukaSha256 -Path $backupLedgerFile)
      ) {
        throw "Pre-activation ledger does not match the immutable snapshot."
      }
    } elseif (Test-Path -LiteralPath $activeLedgerFile) {
      throw "Rollback left an unexpected ledger companion without a backup."
    }
  }
  $ledgerRestored = $true

  $rollbackStage = "restoring_config"
  Restore-AsukaFileAtomic -Source (
    Join-Path $snapshotPath "config\openclaw.json"
  ) -Destination (Join-Path $AppRoot "home\.openclaw\openclaw.json")
  Restore-AsukaFileAtomic -Source (
    Join-Path $snapshotPath "scripts\asuka-gateway-task.ps1"
  ) -Destination (Join-Path $AppRoot "asuka-gateway-task.ps1")
  Restore-AsukaFileAtomic -Source (
    Join-Path $snapshotPath "scripts\asuka-memory-sync.ps1"
  ) -Destination (Join-Path $AppRoot "asuka-memory-sync.ps1")
  $configRestored = $true

  $rollbackStage = "restoring_vault"
  [void](Test-AsukaReleaseFiles -Manifest $manifest -ReleaseRoot $releaseRoot)
  $vaultRestore = Invoke-AsukaNative -FilePath $node -Arguments @(
    (Join-Path $releaseRoot "ops\restore-vault-generated.mjs"),
    $memoryRoot,
    $backupMemoryRoot
  )
  if ($vaultRestore.ExitCode -ne 0) {
    throw "Vault generated-content restoration failed: $($vaultRestore.Output)"
  }
  $vaultRestoreReport = $vaultRestore.Output.Trim() | ConvertFrom-Json
  if (-not (Assert-AsukaJsonBoolean -Object $vaultRestoreReport -Property "ok")) {
    throw "Vault generated-content restoration returned an invalid contract."
  }
  Restore-AsukaGeneratedCache -CurrentMemoryRoot $memoryRoot `
    -BackupMemoryRoot $backupMemoryRoot -FailureRoot $failedStatePath
  Assert-AsukaNoGitOperation -Repository $vault
  $vaultRestored = $true

  $rollbackStage = "committing_vault_compensation"
  $gitAdd = Invoke-AsukaGit -Repository $vault -Arguments @(
    "add", "--", "Asuka/Memory"
  )
  if ($gitAdd.ExitCode -ne 0) {
    throw "Unable to stage compensating Vault changes: $($gitAdd.Output)"
  }
  $stagedPaths = Invoke-AsukaGit -Repository $vault -Arguments @(
    "diff", "--cached", "--name-only", "--", "Asuka/Memory"
  )
  if ($stagedPaths.ExitCode -ne 0) {
    throw "Unable to inspect staged compensating paths: $($stagedPaths.Output)"
  }
  foreach ($path in @(
    $stagedPaths.Output -split "\r?\n" |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )) {
    if (
      [string]$path -cne "Asuka/Memory" -and
      -not ([string]$path).StartsWith(
        "Asuka/Memory/",
        [StringComparison]::Ordinal
      )
    ) {
      throw "Rollback staged a path outside Asuka/Memory: $path"
    }
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
    $commitId = Invoke-AsukaGit -Repository $vault -Arguments @(
      "rev-parse", "HEAD"
    )
    if ($commitId.ExitCode -ne 0) {
      throw "Unable to read compensating commit id."
    }
    $compensationCommit = $commitId.Output.Trim()
  } elseif ($staged.ExitCode -ne 0) {
    throw "Unable to inspect staged compensating changes: $($staged.Output)"
  }

  $pushState = "not_needed"
  if (-not [string]::IsNullOrWhiteSpace($compensationCommit)) {
    if ($vaultPushAllowed) {
      $push = Invoke-AsukaGit -Repository $vault -Arguments @("push")
      if ($push.ExitCode -eq 0) {
        $pushState = "pushed"
      } else {
        $pushState = "queued"
        $pushDetail = $push.Output
      }
    } else {
      $pushState = "queued"
    }
  }

  $rollbackStage = "restoring_acls_and_tasks"
  $aclRecords = @(
    Get-Content -LiteralPath (Join-Path $snapshotPath "acl.json") `
      -Raw -Encoding UTF8 | ConvertFrom-Json
  )
  foreach ($aclRecord in $aclRecords) {
    $aclPath = [IO.Path]::GetFullPath([string]$aclRecord.path)
    if (
      -not $aclPath.Equals($AppRoot, [StringComparison]::OrdinalIgnoreCase) -and
      -not $aclPath.StartsWith(
        "$AppRoot\",
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "ACL backup contains a path outside AppRoot."
    }
    [void](Assert-AsukaNoReparsePointPath -Root $AppRoot -Path $aclPath)
  }
  Restore-AsukaAclRecords -Records $aclRecords
  $aclRestored = $true

  $gatewayDisabledSnapshot = [pscustomobject]@{
    name = $gatewayTaskName
    taskPath = $gatewayTaskPath
    enabled = $false
    wasRunning = $false
  }
  $syncDisabledSnapshot = [pscustomobject]@{
    name = $syncTaskName
    taskPath = $syncTaskPath
    enabled = $false
    wasRunning = $false
  }
  Set-AsukaTaskFromSnapshot -Snapshot $gatewayDisabledSnapshot -XmlPath (
    Join-Path $snapshotPath "tasks\$gatewayTaskName.xml"
  )
  Set-AsukaTaskFromSnapshot -Snapshot $syncDisabledSnapshot -XmlPath (
    Join-Path $snapshotPath "tasks\$syncTaskName.xml"
  )
  $tasksRestored = $true

  if (
    -not $runtimeRestored -or
    -not $ledgerRestored -or
    -not $configRestored -or
    -not $vaultRestored -or
    -not $aclRestored -or
    -not $tasksRestored
  ) {
    throw "Rollback restore stages are incomplete; writers remain disabled."
  }

  $rollbackStage = "starting_writers"
  Enable-ScheduledTask -TaskName $gatewayTaskName `
    -TaskPath $gatewayTaskPath | Out-Null
  $gatewayLogOffset = Get-AsukaLogLength -Path $gatewayLog
  Start-ScheduledTask -TaskName $gatewayTaskName -TaskPath $gatewayTaskPath
  $gatewayReady = Wait-AsukaGatewayReady -TaskName $gatewayTaskName `
    -AppRoot $AppRoot -Port $gatewayPort -LogPath $gatewayLog `
    -LogOffset $gatewayLogOffset -TimeoutSeconds $GatewayReadyTimeoutSeconds

  Enable-ScheduledTask -TaskName $syncTaskName -TaskPath $syncTaskPath |
    Out-Null
  Start-ScheduledTask -TaskName $syncTaskName -TaskPath $syncTaskPath
  Wait-AsukaTaskRunning -Name $syncTaskName -TaskPath $syncTaskPath `
    -TimeoutSeconds 30
  $lockDeadline = (Get-Date).AddSeconds(10)
  while (
    (Get-Date) -lt $lockDeadline -and
    (Test-AsukaExclusiveFileAccess -Path $syncLock)
  ) {
    Start-Sleep -Milliseconds 500
  }
  if (Test-AsukaExclusiveFileAccess -Path $syncLock) {
    throw "$syncTaskName is running but did not acquire its process lock."
  }

  $rollbackStage = "completed"
  $rolledBackState = [ordered]@{
    schemaVersion = 1
    phase = "rolled_back"
    releaseId = $releaseId
    backupPath = $BackupPath
    snapshotPath = $snapshotPath
    failedStatePath = $failedStatePath
    rolledBackAt = (Get-Date).ToUniversalTime().ToString("o")
    runtimeRestored = $runtimeRestored
    ledgerRestored = $ledgerRestored
    configRestored = $configRestored
    vaultRestored = $vaultRestored
    aclRestored = $aclRestored
    tasksRestored = $tasksRestored
    activationReached = $activationReached
    legacy = $legacyResults
    vaultCompensationCommit = $compensationCommit
    vaultPushState = $pushState
    vaultPublication = [ordered]@{
      upstream = $vaultUpstream
      preRollbackAheadCommits = @($preRollbackAheadCommits)
      pushBlockingCommits = @($vaultPushBlockingCommits)
      pushState = $pushState
      pushDetail = $pushDetail
    }
  }
  Write-AsukaJsonFile -Path (
    Join-Path $deploymentRunRoot "rollback-state.json"
  ) -Value $rolledBackState
  Write-AsukaJsonFile -Path $currentStatePath -Value $rolledBackState

  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    releaseId = $releaseId
    backupPath = $BackupPath
    snapshotPath = $snapshotPath
    failedStatePath = $failedStatePath
    activationReached = $activationReached
    runtimeRestored = $runtimeRestored
    ledgerRestored = $ledgerRestored
    legacy = $legacyResults
    vault = [ordered]@{
      restore = $vaultRestoreReport
      compensationCommit = $compensationCommit
      pushState = $pushState
      pushDetail = $pushDetail
      upstream = $vaultUpstream
      preRollbackAheadCommits = @($preRollbackAheadCommits)
      pushBlockingCommits = @($vaultPushBlockingCommits)
    }
    gateway = $gatewayReady
    syncTask = [string](Get-ScheduledTask -TaskName $syncTaskName `
      -TaskPath $syncTaskPath).State
    projectionOutbox = [ordered]@{
      afterStop = $projectionOutboxAfterStop
    }
    backupIntegrity = $backupIntegrity
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  $recoveryErrors = @()
  if (-not [string]::IsNullOrWhiteSpace($syncTaskName)) {
    try {
      Disable-AndStopAsukaTask -Name $syncTaskName `
        -TaskPath $syncTaskPath -TimeoutSeconds $TaskStopTimeoutSeconds
    }
    catch {
      $recoveryErrors += "${syncTaskName}: $($_.Exception.Message)"
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($gatewayTaskName)) {
    try {
      Disable-AndStopAsukaTask -Name $gatewayTaskName `
        -TaskPath $gatewayTaskPath -TimeoutSeconds $TaskStopTimeoutSeconds
    }
    catch {
      $recoveryErrors += "${gatewayTaskName}: $($_.Exception.Message)"
    }
  }
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    backupPath = $BackupPath
    snapshotPath = $snapshotPath
    deploymentRunRoot = $deploymentRunRoot
    failedStatePath = $failedStatePath
    failedStage = $rollbackStage
    runtimeRestored = $runtimeRestored
    ledgerRestored = $ledgerRestored
    configRestored = $configRestored
    vaultRestored = $vaultRestored
    aclRestored = $aclRestored
    tasksRestored = $tasksRestored
    recoveryErrors = @($recoveryErrors | ForEach-Object {
      Protect-AsukaText $_
    })
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
