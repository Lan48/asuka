[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [Parameter(Mandatory = $true)][string]$FrozenBackupPath,
  [string]$GatewayTaskName = "AsukaGateway",
  [string]$SyncTaskName = "AsukaMemorySync"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot "common.ps1")

$operation = "normalize-task-actions"
$auditRoot = $null
$snapshots = @()
$changed = @()

function Get-AsukaStringSha256 {
  param([AllowEmptyString()][string]$Value)

  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace(
      "-",
      ""
    ).ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

try {
  $AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
    if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
      throw "Scheduled-task name contains unsafe characters."
    }
  }
  [void](Read-AsukaFrozenBackup -Path $FrozenBackupPath -AppRoot $AppRoot `
    -GatewayTaskName $GatewayTaskName -SyncTaskName $SyncTaskName `
    -VerifyCurrentHashes)

  $trustedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $PSHOME "powershell.exe")
  )
  $targets = @(
    [pscustomobject]@{
      name = $GatewayTaskName
      script = Join-Path $AppRoot "asuka-gateway-task.ps1"
    },
    [pscustomobject]@{
      name = $SyncTaskName
      script = Join-Path $AppRoot "asuka-memory-sync.ps1"
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
    if ($snapshot.enabled -or $snapshot.wasRunning) {
      throw "$($target.name) must remain disabled and stopped during normalization."
    }
    $actions = @($snapshot.actions)
    if ($actions.Count -ne 1) {
      throw "$($target.name) must have exactly one action."
    }
    $validatedAction = [pscustomobject]@{
      execute = $trustedPowerShell
      arguments = [string]$actions[0].arguments
      workingDirectory = [string]$actions[0].workingDirectory
    }
    if (
      -not (
        Test-AsukaPowerShellFileAction -Action $validatedAction `
          -ScriptPath $target.script
      )
    ) {
      throw "$($target.name) arguments do not reference the audited script."
    }

    $xmlPath = Join-Path $auditRoot "$($target.name).xml"
    Export-ScheduledTask -TaskName $target.name -TaskPath $snapshot.taskPath |
      Set-Content -LiteralPath $xmlPath -Encoding Unicode
    $snapshots += [pscustomobject]@{
      target = $target
      snapshot = $snapshot
      xmlPath = $xmlPath
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
      $newAction = New-ScheduledTaskAction -Execute $trustedPowerShell `
        -Argument ([string]$action.arguments)
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
    if (
      $after.enabled -or
      $after.wasRunning -or
      $actions.Count -ne 1 -or
      -not (
        Test-AsukaPowerShellFileAction -Action $actions[0] `
          -ScriptPath ([string]$entry.target.script)
      )
    ) {
      throw "$($entry.snapshot.name) failed post-normalization validation."
    }
    $beforeAction = @($entry.snapshot.actions)[0]
    $afterAction = $actions[0]
    $results += [pscustomobject]@{
      name = [string]$entry.snapshot.name
      changed = $changed -contains [string]$entry.snapshot.name
      beforeExecute = [string]$beforeAction.execute
      afterExecute = [string]$afterAction.execute
      argumentsSha256 = Get-AsukaStringSha256 -Value ([string]$afterAction.arguments)
      argumentsPreserved = (
        [string]$beforeAction.arguments -ceq [string]$afterAction.arguments
      )
      enabled = [bool]$after.enabled
      running = [bool]$after.wasRunning
      backupXmlSha256 = Get-AsukaSha256 -Path ([string]$entry.xmlPath)
    }
  }
  if (@($results | Where-Object { -not $_.argumentsPreserved }).Count -gt 0) {
    throw "Scheduled-task arguments changed during normalization."
  }

  $audit = [ordered]@{
    schemaVersion = 1
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    appRoot = $AppRoot
    frozenBackupPath = [IO.Path]::GetFullPath($FrozenBackupPath)
    trustedPowerShell = $trustedPowerShell
    tasks = $results
  }
  Write-AsukaJsonFile -Path (Join-Path $auditRoot "audit.json") -Value $audit
  Write-AsukaEnvelope -Ok $true -Operation $operation -Data ([ordered]@{
    auditPath = Join-Path $auditRoot "audit.json"
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
  Write-AsukaEnvelope -Ok $false -Operation $operation -Data ([ordered]@{
    auditRoot = $auditRoot
    restoredTasks = @($snapshots | ForEach-Object { [string]$_.snapshot.name })
  }) -ErrorMessage $failure -ExitCode 1
}
