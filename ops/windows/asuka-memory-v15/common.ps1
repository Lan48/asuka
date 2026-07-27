Set-StrictMode -Version 2.0

function Protect-AsukaText {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ""
  }

  $safe = $Text
  $safe = $safe -replace "(?i)(https?://[^:/@\s]+:)[^@\s]+@", '$1***@'
  $safe = $safe -replace "(?i)((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)[^\s,;]+", '$1***'
  $safe = $safe -replace "(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+", '$1***'
  $safe = $safe -replace "(?i)\bgh[pousr]_[A-Za-z0-9_]+\b", "***"
  $safe = $safe -replace "(?i)\bsk-[A-Za-z0-9_-]{12,}\b", "***"
  return $safe.Trim()
}

function Write-AsukaEnvelope {
  param(
    [Parameter(Mandatory = $true)][bool]$Ok,
    [Parameter(Mandatory = $true)][string]$Operation,
    [AllowNull()][object]$Data,
    [AllowNull()][string]$ErrorMessage,
    [int]$ExitCode = 0
  )

  $envelope = [ordered]@{
    ok = $Ok
    operation = $Operation
    at = (Get-Date).ToUniversalTime().ToString("o")
  }
  if ($null -ne $Data) {
    $envelope["data"] = $Data
  }
  if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) {
    $envelope["error"] = Protect-AsukaText $ErrorMessage
  }

  Write-Output ($envelope | ConvertTo-Json -Depth 24 -Compress)
  exit $ExitCode
}

function Write-AsukaJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $temporary = "$Path.tmp"
  $Value | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Resolve-AsukaChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Relative
  )

  if ([IO.Path]::IsPathRooted($Relative)) {
    throw "Manifest path must be relative: $Relative"
  }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  $normalized = $Relative.Replace("/", "\")
  $candidate = [IO.Path]::GetFullPath((Join-Path $rootFull $normalized))
  if (
    -not $candidate.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and
    -not $candidate.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Path escapes its allowed root: $Relative"
  }
  return $candidate
}

function Get-AsukaSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "File does not exist: $Path"
  }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Read-AsukaManifest {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Release manifest does not exist: $Path"
  }
  $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1) {
    throw "Unsupported release manifest schema: $($manifest.schemaVersion)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$manifest.releaseId)) {
    throw "Release manifest has no releaseId."
  }
  if ([string]$manifest.releaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
    throw "Release manifest has an unsafe releaseId."
  }
  if ($null -eq $manifest.runtimeFiles -or @($manifest.runtimeFiles).Count -eq 0) {
    throw "Release manifest has no runtimeFiles."
  }
  if ($null -eq $manifest.opsFiles -or @($manifest.opsFiles).Count -eq 0) {
    throw "Release manifest has no opsFiles."
  }
  if (-not ($manifest.PSObject.Properties.Name -contains "syncWorker")) {
    throw "Release manifest has no syncWorker integrity contract."
  }
  $syncWorker = $manifest.syncWorker
  if (
    [string]$syncWorker.source -ne "ops/asuka-memory-sync.ps1" -or
    [string]$syncWorker.destination -ne "asuka-memory-sync.ps1"
  ) {
    throw "Release manifest has an unsafe syncWorker source or destination."
  }
  if (
    [int64]$syncWorker.bytes -le 0 -or
    [string]$syncWorker.sha256 -notmatch "^[a-fA-F0-9]{64}$"
  ) {
    throw "Release manifest has an invalid syncWorker size or SHA-256."
  }
  $syncWorkerOpsEntries = @(
    $manifest.opsFiles |
      Where-Object { [string]$_.source -eq [string]$syncWorker.source }
  )
  if (
    $syncWorkerOpsEntries.Count -ne 1 -or
    [int64]$syncWorkerOpsEntries[0].bytes -ne [int64]$syncWorker.bytes -or
    ([string]$syncWorkerOpsEntries[0].sha256).ToLowerInvariant() -ne
      ([string]$syncWorker.sha256).ToLowerInvariant()
  ) {
    throw "Release manifest syncWorker does not match its opsFiles entry."
  }
  foreach ($taskName in @(
    [string]$manifest.requirements.tasks.gateway,
    [string]$manifest.requirements.tasks.sync
  )) {
    if ($taskName -notmatch "^[A-Za-z0-9_.-]+$") {
      throw "Release manifest has an unsafe scheduled-task name."
    }
  }
  return $manifest
}

function Read-AsukaFrozenBackup {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$GatewayTaskName,
    [Parameter(Mandatory = $true)][string]$SyncTaskName,
    [switch]$VerifyCurrentHashes
  )

  $appRootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $backupsRoot = [IO.Path]::GetFullPath((Join-Path $appRootFull "backups")).TrimEnd("\")
  $backupFull = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  if (-not $backupFull.StartsWith("$backupsRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Frozen backup must be a child of the Asuka backups directory."
  }

  $manifestPath = Join-Path $backupFull "backup-manifest.json"
  $completeMarker = Join-Path $backupFull "BACKUP_COMPLETE"
  foreach ($required in @($manifestPath, $completeMarker)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Frozen backup is incomplete: $required"
    }
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1) {
    throw "Unsupported frozen backup schema: $($manifest.schemaVersion)"
  }
  if (
    -not ([IO.Path]::GetFullPath([string]$manifest.appRoot)).Equals(
      $appRootFull,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not ([IO.Path]::GetFullPath([string]$manifest.backupRoot)).Equals(
      $backupFull,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Frozen backup path or appRoot does not match its manifest."
  }
  if (
    [bool]$manifest.vault.dirty -or
    [int]$manifest.vault.ahead -ne 0 -or
    [int]$manifest.vault.behind -ne 0 -or
    [bool]$manifest.port19001After
  ) {
    throw "Frozen backup was not captured from a clean, converged, stopped baseline."
  }

  $gatewayBefore = @(
    $manifest.tasksBefore |
      Where-Object { [string]$_.Name -eq $GatewayTaskName }
  )
  $syncBefore = @(
    $manifest.tasksBefore |
      Where-Object { [string]$_.Name -eq $SyncTaskName }
  )
  if (
    $gatewayBefore.Count -ne 1 -or
    -not [bool]$gatewayBefore[0].Enabled -or
    [string]$gatewayBefore[0].State -ne "Running"
  ) {
    throw "Frozen backup does not record a running, enabled $GatewayTaskName baseline."
  }
  if (
    $syncBefore.Count -ne 1 -or
    -not [bool]$syncBefore[0].Enabled -or
    [string]$syncBefore[0].State -ne "Running"
  ) {
    throw "Frozen backup does not record a running, enabled $SyncTaskName baseline."
  }

  foreach ($required in @(
    (Join-Path $backupFull "home\.openclaw\openclaw.json"),
    (Join-Path $backupFull "project"),
    (Join-Path $backupFull "obsidian-vault\.git"),
    (Join-Path $backupFull "tools\node_modules\openclaw\package.json"),
    (Join-Path $backupFull "ssh"),
    (Join-Path $backupFull "scheduled-tasks\$GatewayTaskName.xml"),
    (Join-Path $backupFull "scheduled-tasks\$SyncTaskName.xml"),
    (Join-Path $backupFull "root-files\asuka-gateway-task.ps1"),
    (Join-Path $backupFull "root-files\asuka-memory-sync.ps1"),
    (Join-Path $backupFull "obsidian-vault.bundle")
  )) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Frozen backup is missing a required artifact: $required"
    }
  }

  $verifiedHashes = 0
  if ($VerifyCurrentHashes) {
    $criticalHashes = @($manifest.criticalHashesBefore)
    if ($criticalHashes.Count -eq 0) {
      throw "Frozen backup has no critical file hashes."
    }
    foreach ($entry in $criticalHashes) {
      $currentPath = [IO.Path]::GetFullPath([string]$entry.Path)
      if (
        -not $currentPath.Equals($appRootFull, [StringComparison]::OrdinalIgnoreCase) -and
        -not $currentPath.StartsWith("$appRootFull\", [StringComparison]::OrdinalIgnoreCase)
      ) {
        throw "Frozen backup critical hash points outside AppRoot."
      }
      $actual = Get-AsukaSha256 -Path $currentPath
      if ($actual -ne ([string]$entry.Sha256).ToLowerInvariant()) {
        throw "Current file changed after freeze: $currentPath"
      }
      $verifiedHashes += 1
    }
  }

  return [pscustomobject]@{
    path = $backupFull
    manifestPath = $manifestPath
    manifest = $manifest
    gatewayTask = $gatewayBefore[0]
    syncTask = $syncBefore[0]
    verifiedCriticalHashes = $verifiedHashes
  }
}

function Test-AsukaReleaseFiles {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot
  )

  $entries = @($Manifest.runtimeFiles)
  if ($Manifest.PSObject.Properties.Name -contains "opsFiles") {
    $entries += @($Manifest.opsFiles)
  }
  $verified = @()
  foreach ($entry in $entries) {
    $source = Resolve-AsukaChildPath -Root $ReleaseRoot -Relative ([string]$entry.source)
    $actual = Get-AsukaSha256 -Path $source
    $expected = ([string]$entry.sha256).ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Release hash mismatch: $($entry.source)"
    }
    if ([int64](Get-Item -LiteralPath $source).Length -ne [int64]$entry.bytes) {
      throw "Release size mismatch: $($entry.source)"
    }
    $verified += [pscustomobject]@{
      source = [string]$entry.source
      sha256 = $actual
    }
  }
  return $verified
}

function Invoke-AsukaNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $exitCode = 1
  try {
    $output = & $FilePath @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{
    ExitCode = [int]$exitCode
    Output = Protect-AsukaText $output
  }
}

function Invoke-AsukaGit {
  param(
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
  $git = if ($null -eq $gitCommand) { "" } else { [string]$gitCommand.Source }
  if ([string]::IsNullOrWhiteSpace($git)) {
    $command = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      $git = $command.Source
    }
  }
  if ([string]::IsNullOrWhiteSpace($git)) {
    throw "Git executable was not found."
  }
  return Invoke-AsukaNative -FilePath $git -Arguments (
    @("-c", "safe.directory=$($Repository.Replace('\', '/'))", "-C", $Repository) + $Arguments
  )
}

function Get-AsukaTaskSnapshot {
  param([Parameter(Mandatory = $true)][string]$Name)

  $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction Stop
  return [pscustomobject]@{
    name = $Name
    taskPath = [string]$task.TaskPath
    enabled = [bool]$task.Settings.Enabled
    state = [string]$task.State
    wasRunning = ([string]$task.State -eq "Running")
    lastRunTime = $info.LastRunTime
    lastTaskResult = $info.LastTaskResult
    actions = @($task.Actions | ForEach-Object {
      [pscustomobject]@{
        execute = [string]$_.Execute
        arguments = [string]$_.Arguments
        workingDirectory = [string]$_.WorkingDirectory
      }
    })
  }
}

function Wait-AsukaTaskStopped {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -eq $task -or [string]$task.State -ne "Running") {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Scheduled task did not stop within $TimeoutSeconds seconds: $Name"
}

function Wait-AsukaTaskRunning {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -ne $task -and [string]$task.State -eq "Running") {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Scheduled task did not start within $TimeoutSeconds seconds: $Name"
}

function Disable-AndStopAsukaTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutSeconds = 30
  )

  Disable-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  Wait-AsukaTaskStopped -Name $Name -TimeoutSeconds $TimeoutSeconds
}

function Get-AsukaGatewayProcesses {
  param([Parameter(Mandatory = $true)][string]$AppRoot)

  $escapedRoot = [regex]::Escape($AppRoot)
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match "^(node|node\.exe)$" -and
        $_.CommandLine -match "openclaw\.mjs.*\bgateway\b" -and
        $_.CommandLine -match $escapedRoot
      } |
      Select-Object ProcessId, Name, ExecutablePath, CommandLine
  )
}

function Test-AsukaPortListening {
  param([Parameter(Mandatory = $true)][int]$Port)

  return [bool](
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
  )
}

function Assert-AsukaGatewayStopped {
  param(
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][int]$Port
  )

  if (Test-AsukaPortListening -Port $Port) {
    throw "Gateway port remained open after stop: $Port"
  }
  $processes = @(Get-AsukaGatewayProcesses -AppRoot $AppRoot)
  if ($processes.Count -gt 0) {
    throw "Gateway process remained alive after stop: $($processes.ProcessId -join ',')"
  }
}

function Test-AsukaExclusiveFileAccess {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $true
  }
  $stream = $null
  try {
    $stream = [IO.File]::Open(
      $Path,
      [IO.FileMode]::Open,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Get-AsukaDirectoryBytes {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return [int64]0
  }
  $measure = Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction Stop |
    Measure-Object -Property Length -Sum
  if ($null -eq $measure.Sum) {
    return [int64]0
  }
  return [int64]$measure.Sum
}

function Copy-AsukaTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Backup source directory does not exist: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($null -ne $robocopy) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $exitCode = 16
    try {
      & $robocopy.Source $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($exitCode -ge 8) {
      throw "robocopy failed with exit code $exitCode for '$Source'."
    }
    return
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
    Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
  }
}

function Export-AsukaAclRecords {
  param([Parameter(Mandatory = $true)][string[]]$Paths)

  return @($Paths | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
      $item = Get-Item -LiteralPath $_ -Force
      $acl = Get-Acl -LiteralPath $_
      [pscustomobject]@{
        path = $item.FullName
        isDirectory = [bool]$item.PSIsContainer
        sddl = [string]$acl.Sddl
        owner = [string]$acl.Owner
      }
    }
  })
}

function Restore-AsukaAclRecords {
  param([Parameter(Mandatory = $true)][object[]]$Records)

  foreach ($record in @($Records)) {
    $path = [string]$record.path
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $acl = Get-Acl -LiteralPath $path
    $acl.SetSecurityDescriptorSddlForm([string]$record.sddl)
    Set-Acl -LiteralPath $path -AclObject $acl
  }
}

function Test-AsukaJsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  try {
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-AsukaJsonLinesFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  try {
    foreach ($line in @(Get-Content -LiteralPath $Path -Encoding UTF8)) {
      if (-not [string]::IsNullOrWhiteSpace($line)) {
        $line | ConvertFrom-Json | Out-Null
      }
    }
    return $true
  } catch {
    return $false
  }
}

function Get-AsukaLogLength {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [int64]0
  }
  return [int64](Get-Item -LiteralPath $Path).Length
}

function Read-AsukaLogFromOffset {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int64]$Offset,
    [int64]$MaximumBytes = 2000000
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return ""
  }
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::ReadWrite
  )
  try {
    $start = [Math]::Min([Math]::Max([int64]0, $Offset), $stream.Length)
    if (($stream.Length - $start) -gt $MaximumBytes) {
      $start = $stream.Length - $MaximumBytes
    }
    [void]$stream.Seek($start, [IO.SeekOrigin]::Begin)
    $length = [int]($stream.Length - $start)
    $bytes = New-Object byte[] $length
    $read = $stream.Read($bytes, 0, $length)
    return [Text.Encoding]::UTF8.GetString($bytes, 0, $read).Replace("`0", "")
  } finally {
    $stream.Dispose()
  }
}

function Wait-AsukaGatewayReady {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][int64]$LogOffset,
    [int]$TimeoutSeconds = 90
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastText = ""
  while ((Get-Date) -lt $deadline) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $portReady = Test-AsukaPortListening -Port $Port
    $processReady = @(Get-AsukaGatewayProcesses -AppRoot $AppRoot).Count -gt 0
    $lastText = Read-AsukaLogFromOffset -Path $LogPath -Offset $LogOffset
    $gatewayReady = $lastText -match "(?i)Gateway ready"
    $socketReady = $lastText -match "(?i)WebSocket connected|session resumed"
    if (
      $null -ne $task -and
      [string]$task.State -eq "Running" -and
      $portReady -and
      $processReady -and
      $gatewayReady -and
      $socketReady
    ) {
      return [pscustomobject]@{
        taskState = [string]$task.State
        port = $portReady
        process = $processReady
        gatewayReady = $gatewayReady
        websocketReady = $socketReady
      }
    }
    Start-Sleep -Seconds 1
  }
  throw "Gateway did not become ready within $TimeoutSeconds seconds. Recent log: $(Protect-AsukaText $lastText)"
}

function Assert-AsukaNoGitOperation {
  param([Parameter(Mandatory = $true)][string]$Repository)

  $conflicts = Invoke-AsukaGit -Repository $Repository -Arguments @(
    "diff", "--name-only", "--diff-filter=U"
  )
  if ($conflicts.ExitCode -ne 0) {
    throw "Unable to inspect Vault conflicts: $($conflicts.Output)"
  }
  if (-not [string]::IsNullOrWhiteSpace($conflicts.Output)) {
    throw "Vault has unresolved conflicts: $($conflicts.Output)"
  }
  foreach ($operation in @("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD")) {
    $gitPath = Invoke-AsukaGit -Repository $Repository -Arguments @("rev-parse", "--git-path", $operation)
    if ($gitPath.ExitCode -ne 0) {
      continue
    }
    $operationPath = $gitPath.Output
    if (-not [IO.Path]::IsPathRooted($operationPath)) {
      $operationPath = Join-Path $Repository $operationPath
    }
    if (Test-Path -LiteralPath $operationPath) {
      throw "Vault has an unfinished Git operation: $operation"
    }
  }
}

function Set-AsukaTaskFromSnapshot {
  param(
    [Parameter(Mandatory = $true)][object]$Snapshot,
    [Parameter(Mandatory = $true)][string]$XmlPath
  )

  if (-not (Test-Path -LiteralPath $XmlPath -PathType Leaf)) {
    throw "Scheduled task backup is missing: $XmlPath"
  }
  $xml = Get-Content -LiteralPath $XmlPath -Raw -Encoding Unicode
  Register-ScheduledTask -TaskName ([string]$Snapshot.name) `
    -TaskPath ([string]$Snapshot.taskPath) -Xml $xml -Force | Out-Null
  if ([bool]$Snapshot.enabled) {
    Enable-ScheduledTask -TaskName ([string]$Snapshot.name) | Out-Null
  } else {
    Disable-ScheduledTask -TaskName ([string]$Snapshot.name) | Out-Null
  }
}
