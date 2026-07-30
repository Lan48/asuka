[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [Parameter(Mandatory = $true)][string]$FrozenBackupPath,
  [string]$ReleaseRoot = "",
  [string]$ManifestPath = "",
  [string]$GatewayTaskName = "",
  [string]$SyncTaskName = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")

$operation = "normalize-task-actions"
$lockStream = $null
$auditRoot = $null
$attestationPath = $null
$snapshots = @()
$changed = @()

try {
  $lockStream = Enter-AsukaDeploymentLock -AppRoot $AppRoot
  function Get-AsukaComparableTaskXml {
    param(
      [Parameter(Mandatory = $true)][string]$Path,
      [string]$Command = "",
      [switch]$SetCommand
    )

    [xml]$document = Get-Content -LiteralPath $Path -Raw -Encoding Unicode
    $execNodes = @($document.SelectNodes(
      "/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']"
    ))
    if ($execNodes.Count -ne 1) {
      throw "Scheduled-task XML must contain exactly one Exec action: $Path"
    }
    $commandNodes = @($execNodes[0].SelectNodes("./*[local-name()='Command']"))
    if ($commandNodes.Count -ne 1) {
      throw "Scheduled-task XML must contain exactly one Command element: $Path"
    }
    if ($SetCommand) {
      $commandNodes[0].InnerText = $Command
    }
    return [string]$document.OuterXml
  }

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

  $frozenBackup = Read-AsukaFrozenBackup -Path $FrozenBackupPath `
    -AppRoot $AppRoot -GatewayTaskName $GatewayTaskName `
    -SyncTaskName $SyncTaskName -VerifyCurrentHashes
  if (
    [string]$frozenBackup.gatewayTask.Name -cne $GatewayTaskName -or
    [string]$frozenBackup.syncTask.Name -cne $SyncTaskName
  ) {
    throw "Frozen task state name does not match the release manifest."
  }
  $releaseManifestSha256 = Get-AsukaSha256 -Path $ManifestPath
  $frozenManifestProperties = @(
    $frozenBackup.manifest.PSObject.Properties.Name
  )
  if (
    $frozenManifestProperties -contains "releaseManifestSha256" -and
    ([string]$frozenBackup.manifest.releaseManifestSha256).ToLowerInvariant() -ne
      $releaseManifestSha256
  ) {
    throw "Frozen backup does not match the release manifest."
  }
  foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
    if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
      throw "Release manifest contains an unsafe scheduled-task name."
    }
  }
  if (
    [string]$PSVersionTable.PSEdition -ne "Desktop" -or
    [int]$PSVersionTable.PSVersion.Major -ne 5 -or
    [int]$PSVersionTable.PSVersion.Minor -ne 1 -or
    -not [Environment]::Is64BitProcess
  ) {
    throw "Native 64-bit Windows PowerShell 5.1 Desktop is required."
  }

  $trustedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $PSHOME "powershell.exe")
  )
  $targets = @(
    [pscustomobject]@{
      role = "gateway"
      name = $GatewayTaskName
      script = Join-Path $AppRoot "asuka-gateway-task.ps1"
    },
    [pscustomobject]@{
      role = "sync"
      name = $SyncTaskName
      script = Resolve-AsukaChildPath -Root $AppRoot `
        -Relative ([string]$manifest.syncWorker.destination)
    }
  )
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $auditRoot = Join-Path $AppRoot "run\task-action-normalization\$timestamp"
  if (Test-Path -LiteralPath $auditRoot) {
    throw "Task-action audit directory already exists: $auditRoot"
  }
  New-Item -ItemType Directory -Force -Path $auditRoot | Out-Null

  foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target.script -PathType Leaf)) {
      throw "Audited scheduled-task script is missing: $($target.script)"
    }
    $snapshot = Get-AsukaTaskSnapshot -Name $target.name
    if ([string]$snapshot.name -cne [string]$target.name) {
      throw "Scheduled-task state name does not match the release manifest."
    }
    if (
      [string]$snapshot.state -ne "Disabled" -or
      $snapshot.enabled -or
      $snapshot.wasRunning
    ) {
      throw "$($target.name) must remain disabled and stopped during normalization."
    }
    $actions = @($snapshot.actions)
    if ($actions.Count -ne 1) {
      throw "$($target.name) must have exactly one action."
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
      throw "$($target.name) executable does not match the release manifest."
    }
    $validatedAction = [pscustomobject]@{
      execute = $trustedPowerShell
      arguments = [string]$actions[0].arguments
      workingDirectory = [string]$actions[0].workingDirectory
    }
    if (
      -not (
        Test-AsukaPowerShellFileAction -Action $validatedAction `
          -ScriptPath $target.script -AllowedWorkingDirectory $AppRoot
      )
    ) {
      throw "$($target.name) action does not match the release manifest."
    }

    $xmlPath = Join-Path $auditRoot "before-$($target.name).xml"
    Export-ScheduledTask -TaskName $target.name -TaskPath $snapshot.taskPath |
      Set-Content -LiteralPath $xmlPath -Encoding Unicode
    $frozenXmlPath = Join-Path $frozenBackup.path (
      "scheduled-tasks\$($target.name).xml"
    )
    if ($frozenManifestProperties -contains "taskXml") {
      $taskXmlRecords = @(
        $frozenBackup.manifest.taskXml |
          Where-Object { [string]$_.Name -ceq [string]$target.name }
      )
      if (
        $taskXmlRecords.Count -ne 1 -or
        ([string]$taskXmlRecords[0].Sha256).ToLowerInvariant() -ne
          (Get-AsukaSha256 -Path $frozenXmlPath)
      ) {
        throw "$($target.name) frozen XML does not match its backup manifest."
      }
    }
    $snapshots += [pscustomobject]@{
      target = $target
      snapshot = $snapshot
      xmlPath = $xmlPath
      frozenXmlPath = $frozenXmlPath
    }
    if (
      (Get-AsukaSha256 -Path $xmlPath) -ne
        (Get-AsukaSha256 -Path $frozenXmlPath)
    ) {
      $expectedXml = Get-AsukaComparableTaskXml -Path $frozenXmlPath `
        -Command $trustedPowerShell -SetCommand
      $currentXml = Get-AsukaComparableTaskXml -Path $xmlPath
      if (
        -not $canonicalExecute -or
        -not $currentXml.Equals($expectedXml, [StringComparison]::Ordinal)
      ) {
        throw "$($target.name) task XML changed after the frozen backup."
      }
    }
  }

  foreach ($entry in $snapshots) {
    $action = @($entry.snapshot.actions)[0]
    $alreadyCanonical = (
      [IO.Path]::IsPathRooted(([string]$action.execute).Trim()) -and
      ([IO.Path]::GetFullPath(([string]$action.execute).Trim())).Equals(
        $trustedPowerShell,
        [StringComparison]::OrdinalIgnoreCase
      )
    )
    if (-not $alreadyCanonical) {
      $actionParameters = @{
        Execute = $trustedPowerShell
        Argument = [string]$action.arguments
      }
      if (-not [string]::IsNullOrWhiteSpace([string]$action.workingDirectory)) {
        $actionParameters["WorkingDirectory"] = [string]$action.workingDirectory
      }
      $newAction = New-ScheduledTaskAction @actionParameters
      Set-ScheduledTask -TaskName ([string]$entry.snapshot.name) `
        -TaskPath ([string]$entry.snapshot.taskPath) -Action $newAction |
        Out-Null
      Disable-ScheduledTask -TaskName ([string]$entry.snapshot.name) `
        -TaskPath ([string]$entry.snapshot.taskPath) | Out-Null
      $changed += [string]$entry.snapshot.name
    }
  }

  $results = @()
  foreach ($entry in $snapshots) {
    $after = Get-AsukaTaskSnapshot -Name ([string]$entry.snapshot.name)
    $actions = @($after.actions)
    $normalizedXmlPath = Join-Path $auditRoot (
      "normalized-$([string]$entry.snapshot.name).xml"
    )
    $canonicalXml = [string](Export-ScheduledTask `
      -TaskName ([string]$entry.snapshot.name) `
      -TaskPath ([string]$entry.snapshot.taskPath))
    $canonicalXml |
      Set-Content -LiteralPath $normalizedXmlPath -Encoding Unicode
    if ([string]$after.name -cne [string]$entry.target.name) {
      throw "Scheduled-task state name does not match the release manifest."
    }
    if (
      [string]$after.state -ne "Disabled" -or
      $after.enabled -or
      $after.wasRunning -or
      $actions.Count -ne 1 -or
      -not ([IO.Path]::GetFullPath(
        ([string]$actions[0].execute).Trim()
      )).Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase) -or
      -not (
        Test-AsukaPowerShellFileAction -Action $actions[0] `
          -ScriptPath ([string]$entry.target.script) `
          -AllowedWorkingDirectory $AppRoot
      )
    ) {
      throw "$($entry.snapshot.name) failed post-normalization validation."
    }
    $expectedXml = Get-AsukaComparableTaskXml `
      -Path ([string]$entry.frozenXmlPath) -Command $trustedPowerShell `
      -SetCommand
    $normalizedXml = Get-AsukaComparableTaskXml -Path $normalizedXmlPath
    if (-not $normalizedXml.Equals($expectedXml, [StringComparison]::Ordinal)) {
      throw "$($entry.snapshot.name) changed outside the allowed Command normalization."
    }
    $beforeAction = @($entry.snapshot.actions)[0]
    $afterAction = $actions[0]
    $results += [pscustomobject]@{
      role = [string]$entry.target.role
      taskName = [string]$entry.snapshot.name
      taskPath = [string]$entry.snapshot.taskPath
      state = [string]$after.state
      changed = $changed -contains [string]$entry.snapshot.name
      beforeExecute = [string]$beforeAction.execute
      afterExecute = [string]$afterAction.execute
      argumentsSha256 = Get-AsukaStringSha256 -Value ([string]$afterAction.arguments)
      argumentsPreserved = (
        [string]$beforeAction.arguments -ceq [string]$afterAction.arguments
      )
      workingDirectoryPreserved = (
        [string]$beforeAction.workingDirectory -ceq
          [string]$afterAction.workingDirectory
      )
      enabled = [bool]$after.enabled
      canonicalXml = $canonicalXml
      canonicalXmlSha256 = Get-AsukaStringSha256 -Value $canonicalXml
      backupXmlSha256 = Get-AsukaSha256 -Path ([string]$entry.frozenXmlPath)
    }
  }
  if (
    @($results | Where-Object {
      -not $_.argumentsPreserved -or -not $_.workingDirectoryPreserved
    }).Count -gt 0
  ) {
    throw "Scheduled-task arguments or working directory changed during normalization."
  }

  $attestation = [ordered]@{
    schemaVersion = 1
    kind = "asuka-task-normalization"
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    releaseId = [string]$manifest.releaseId
    releaseManifestPath = $ManifestPath
    releaseManifestSha256 = $releaseManifestSha256
    appRoot = $AppRoot
    frozenBackup = [ordered]@{
      path = [string]$frozenBackup.path
      manifestSha256 = Get-AsukaSha256 -Path ([string]$frozenBackup.manifestPath)
      integrityManifestSha256 = [string](
        $frozenBackup.backupIntegrity.manifestSha256
      )
      treeSha256 = [string]$frozenBackup.backupIntegrity.treeSha256
    }
    trustedPowerShell = $trustedPowerShell
    tasks = $results
  }
  $attestationPath = Join-Path $auditRoot "attestation.json"
  Write-AsukaJsonFile -Path $attestationPath -Value $attestation
  $attestationSha256 = Get-AsukaSha256 -Path $attestationPath
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    auditPath = $attestationPath
    attestationPath = $attestationPath
    attestationSha256 = $attestationSha256
    changedTasks = $changed
    tasks = $results
  }) -ErrorMessage $null -ExitCode 0
} catch {
  $failure = $_.Exception.Message
  $restoreErrors = @()
  foreach ($entry in $snapshots) {
    try {
      Set-AsukaTaskFromSnapshot -Snapshot $entry.snapshot -XmlPath $entry.xmlPath
    } catch {
      $restoreErrors += "$($entry.snapshot.name): $($_.Exception.Message)"
    }
  }
  if ($restoreErrors.Count -gt 0) {
    $failure += " Restore failures: $($restoreErrors -join '; ')"
  }
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
    $lockStream = $null
  }
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    auditRoot = $auditRoot
    attestationPath = $attestationPath
    restoredTasks = @($snapshots | ForEach-Object { [string]$_.snapshot.name })
  }) -ErrorMessage $failure -ExitCode 1
} finally {
  if ($null -ne $lockStream) {
    Exit-AsukaDeploymentLock -Lease $lockStream
  }
}
