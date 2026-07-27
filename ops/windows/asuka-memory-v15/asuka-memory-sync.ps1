<#
.SYNOPSIS
Synchronizes generated Asuka memory pages from a remote Windows host.

.DESCRIPTION
Watches <Project>\Asuka\Memory, debounces changes, rebases from the configured
Git upstream, compiles and lints Memory Wiki, then commits only Asuka/Memory.
Network failures are retried. Rebase/merge conflicts are left untouched for
manual resolution.

.PARAMETER AppRoot
Application root containing tools\node_modules\openclaw. Alias: Root.

.PARAMETER OpenClawHome
OpenClaw service home containing the .openclaw state directory. Alias: Home.

.PARAMETER VaultProject
Git working tree containing Asuka\Memory. Alias: Project.

.PARAMETER Once
Runs one cycle immediately. Exit codes: 0 success, 1 retryable failure,
2 conflict or unfinished Git operation.

.EXAMPLE
powershell -NoProfile -File D:\app\asuka\asuka-memory-sync.ps1 -Once
#>
[CmdletBinding()]
param(
  [Alias("Root")]
  [string]$AppRoot = "D:\app\asuka",

  [Alias("Home")]
  [string]$OpenClawHome = "D:\app\asuka\home",

  [Alias("Project")]
  [string]$VaultProject = "D:\app\asuka\obsidian-vault",

  [ValidateRange(1, 3600)]
  [int]$DebounceSeconds = 60,

  [ValidateRange(1, 300)]
  [int]$PollSeconds = 5,

  [switch]$Once
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$memoryPath = "Asuka/Memory"
$memoryDirectory = Join-Path $VaultProject ($memoryPath -replace "/", "\")
$openClawEntry = Join-Path $AppRoot "tools\node_modules\openclaw\openclaw.mjs"
$stateDirectory = Join-Path $OpenClawHome ".openclaw"
$logDirectory = Join-Path $AppRoot "logs"
$runtimeDirectory = Join-Path $AppRoot "run"
$logPath = Join-Path $logDirectory "asuka-memory-sync.log"
$statusPath = Join-Path $runtimeDirectory "asuka-memory-sync-status.json"
$lockPath = Join-Path $runtimeDirectory "asuka-memory-sync.lock"
$script:lockStream = $null

function Protect-LogText {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrEmpty($Text)) {
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

function Write-SyncLog {
  param(
    [ValidateSet("INFO", "WARN", "ERROR")]
    [string]$Level,
    [string]$Message
  )

  if ((Test-Path -LiteralPath $logPath) -and
      (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
  }

  $line = "{0} [{1}] {2}" -f (
    Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
  ), $Level, (Protect-LogText $Message)
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Output $line
}

function Write-SyncStatus {
  param(
    [string]$State,
    [string]$Detail = "",
    [string[]]$Conflicts = @()
  )

  $status = [ordered]@{
    state = $State
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    detail = Protect-LogText $Detail
    conflicts = @($Conflicts | ForEach-Object { Protect-LogText $_ })
  }
  $temporaryPath = "$statusPath.tmp"
  $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $statusPath -Force
}

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $commandOutput = & $FilePath @Arguments 2>&1 | Out-String
    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{
    ExitCode = $commandExitCode
    Output = Protect-LogText $commandOutput
  }
}

function Invoke-Git {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  return Invoke-NativeCommand -FilePath $script:gitPath -Arguments (
    @("-c", "safe.directory=$($VaultProject -replace '\\', '/')", "-C", $VaultProject) + $Arguments
  )
}

function Get-RepositoryOperation {
  $operationPaths = @(
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD"
  )

  foreach ($operationName in $operationPaths) {
    $result = Invoke-Git -Arguments @("rev-parse", "--git-path", $operationName)
    if ($result.ExitCode -ne 0) {
      continue
    }
    $operationPath = $result.Output
    if (-not [IO.Path]::IsPathRooted($operationPath)) {
      $operationPath = Join-Path $VaultProject $operationPath
    }
    if (Test-Path -LiteralPath $operationPath) {
      return $operationName
    }
  }
  return ""
}

function Get-ConflictState {
  $conflictResult = Invoke-Git -Arguments @("diff", "--name-only", "--diff-filter=U")
  if ($conflictResult.ExitCode -ne 0) {
    throw "Unable to inspect Git conflict state: $($conflictResult.Output)"
  }

  $conflicts = @(
    $conflictResult.Output -split "\r?\n" |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  $operation = Get-RepositoryOperation
  return [pscustomobject]@{
    IsPaused = ($conflicts.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($operation))
    Conflicts = $conflicts
    Operation = $operation
  }
}

function Get-NodePath {
  $versionedNodes = @(
    Get-ChildItem -LiteralPath (Join-Path $AppRoot "tools") -Directory -Filter "node-v*" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "node.exe" }
  )
  $candidates = @($versionedNodes)
  $candidates += (Join-Path $AppRoot "tools\node.exe")

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($null -ne $nodeCommand) {
    return $nodeCommand.Source
  }
  throw "Node.js executable was not found under '$AppRoot\tools' or PATH."
}

function Get-WikiFingerprint {
  if (-not (Test-Path -LiteralPath $memoryDirectory -PathType Container)) {
    return "missing"
  }

  $records = @(
    Get-ChildItem -LiteralPath $memoryDirectory -File -Recurse -Force |
      Sort-Object FullName |
      ForEach-Object {
        $relativePath = $_.FullName.Substring($memoryDirectory.Length).TrimStart("\")
        "{0}|{1}|{2}" -f $relativePath, $_.Length, $_.LastWriteTimeUtc.Ticks
      }
  )
  $payload = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($payload))).Replace("-", "")
  } finally {
    $sha256.Dispose()
  }
}

function Get-AheadCount {
  $upstream = Invoke-Git -Arguments @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
  if ($upstream.ExitCode -ne 0) {
    return 0
  }

  $ahead = Invoke-Git -Arguments @("rev-list", "--count", "@{upstream}..HEAD")
  if ($ahead.ExitCode -ne 0) {
    throw "Unable to inspect pending commits: $($ahead.Output)"
  }

  $count = 0
  if (-not [int]::TryParse($ahead.Output.Trim(), [ref]$count)) {
    throw "Unexpected pending commit count: $($ahead.Output)"
  }
  return $count
}

function Test-WikiDirty {
  $status = Invoke-Git -Arguments @("status", "--porcelain", "--", $memoryPath)
  if ($status.ExitCode -ne 0) {
    throw "Unable to inspect memory changes: $($status.Output)"
  }
  return (-not [string]::IsNullOrWhiteSpace($status.Output))
}

function Invoke-WikiCommand {
  param([Parameter(Mandatory = $true)][string]$Command)

  $result = Invoke-NativeCommand -FilePath $script:nodePath -Arguments @(
    $openClawEntry,
    "wiki",
    $Command
  )
  if ($result.ExitCode -ne 0) {
    throw "openclaw wiki $Command failed: $($result.Output)"
  }
  if (-not [string]::IsNullOrWhiteSpace($result.Output)) {
    Write-SyncLog -Level "INFO" -Message "openclaw wiki $Command completed."
  }
}

function Invoke-SyncCycle {
  Write-SyncStatus -State "syncing" -Detail "Memory sync cycle started."
  Write-SyncLog -Level "INFO" -Message "Starting memory sync cycle."

  $conflictState = Get-ConflictState
  if ($conflictState.IsPaused) {
    $detail = "Git operation '$($conflictState.Operation)' or unresolved conflicts require manual completion."
    Write-SyncStatus -State "conflict" -Detail $detail -Conflicts $conflictState.Conflicts
    Write-SyncLog -Level "WARN" -Message $detail
    return "conflict"
  }

  $fetch = Invoke-Git -Arguments @("fetch", "--prune")
  if ($fetch.ExitCode -ne 0) {
    throw "git fetch failed; local memory remains available and will be retried: $($fetch.Output)"
  }

  $pull = Invoke-Git -Arguments @("pull", "--rebase", "--autostash")
  $conflictState = Get-ConflictState
  if ($conflictState.IsPaused) {
    $detail = "git pull --rebase paused for manual conflict resolution."
    Write-SyncStatus -State "conflict" -Detail $detail -Conflicts $conflictState.Conflicts
    Write-SyncLog -Level "WARN" -Message $detail
    return "conflict"
  }
  if ($pull.ExitCode -ne 0) {
    throw "git pull --rebase failed; local memory remains available and will be retried: $($pull.Output)"
  }

  Invoke-WikiCommand -Command "compile"
  Invoke-WikiCommand -Command "lint"
  $pendingMarker = Join-Path $memoryDirectory ".asuka-memory-pending"
  if (Test-Path -LiteralPath $pendingMarker) {
    Remove-Item -LiteralPath $pendingMarker -Force
  }

  $add = Invoke-Git -Arguments @("add", "--", $memoryPath)
  if ($add.ExitCode -ne 0) {
    throw "git add failed: $($add.Output)"
  }

  $staged = Invoke-Git -Arguments @("diff", "--cached", "--quiet", "--", $memoryPath)
  if ($staged.ExitCode -eq 1) {
    $commitMessage = "chore(memory): sync Asuka memory {0}" -f (
      Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
    )
    $commit = Invoke-Git -Arguments @("commit", "--only", "-m", $commitMessage, "--", $memoryPath)
    if ($commit.ExitCode -ne 0) {
      throw "git commit failed; staged memory changes were preserved: $($commit.Output)"
    }
    Write-SyncLog -Level "INFO" -Message "Committed staged Asuka/Memory changes."
  } elseif ($staged.ExitCode -ne 0) {
    throw "Unable to inspect staged memory changes: $($staged.Output)"
  } else {
    Write-SyncLog -Level "INFO" -Message "No staged Asuka/Memory changes."
  }

  $aheadCount = Get-AheadCount
  if ($aheadCount -gt 0) {
    $push = Invoke-Git -Arguments @("push")
    if ($push.ExitCode -ne 0) {
      throw "git push failed; $aheadCount local commit(s) remain queued for retry: $($push.Output)"
    }
    Write-SyncLog -Level "INFO" -Message "Pushed queued memory commit(s)."
  }

  Write-SyncStatus -State "idle" -Detail "Last memory sync cycle completed successfully."
  Write-SyncLog -Level "INFO" -Message "Memory sync cycle completed."
  return "success"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

try {
  $script:lockStream = [IO.File]::Open(
    $lockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch {
  throw "Another asuka-memory-sync process is already running."
}

try {
  if (-not (Test-Path -LiteralPath $VaultProject -PathType Container)) {
    throw "Vault project does not exist: $VaultProject"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $VaultProject ".git"))) {
    throw "Vault project is not a Git working tree: $VaultProject"
  }
  if (-not (Test-Path -LiteralPath $memoryDirectory -PathType Container)) {
    throw "Memory directory does not exist: $memoryDirectory"
  }
  if (-not (Test-Path -LiteralPath $openClawEntry -PathType Leaf)) {
    throw "OpenClaw entry does not exist: $openClawEntry"
  }

  $script:gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if ([string]::IsNullOrWhiteSpace($script:gitPath)) {
    $gitCommand = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $gitCommand) {
      $script:gitPath = $gitCommand.Source
    }
  }
  if ([string]::IsNullOrWhiteSpace($script:gitPath)) {
    throw "Git executable was not found in PATH."
  }

  $script:nodePath = Get-NodePath
  $env:OPENCLAW_HOME = $OpenClawHome
  $env:OPENCLAW_STATE_DIR = $stateDirectory
  $env:OPENCLAW_CONFIG_PATH = Join-Path $stateDirectory "openclaw.json"
  $env:GIT_TERMINAL_PROMPT = "0"

  Write-SyncLog -Level "INFO" -Message "Memory sync initialized for '$memoryPath'."

  if ($Once) {
    try {
      $onceResult = Invoke-SyncCycle
      if ($onceResult -eq "conflict") {
        exit 2
      }
      exit 0
    } catch {
      Write-SyncStatus -State "retry" -Detail $_.Exception.Message
      Write-SyncLog -Level "ERROR" -Message $_.Exception.Message
      exit 1
    }
  }

  $lastFingerprint = Get-WikiFingerprint
  $pendingSince = $null
  $retryAt = $null
  if ((Test-WikiDirty) -or (Get-AheadCount) -gt 0) {
    $pendingSince = Get-Date
    Write-SyncStatus -State "debouncing" -Detail "Pending memory changes detected at startup."
    Write-SyncLog -Level "INFO" -Message "Pending memory changes detected at startup; waiting $DebounceSeconds seconds."
  } else {
    Write-SyncStatus -State "idle" -Detail "Watching Asuka/Memory for changes."
  }

  while ($true) {
    $conflictState = Get-ConflictState
    if ($conflictState.IsPaused) {
      $detail = "Git operation '$($conflictState.Operation)' or unresolved conflicts require manual completion."
      Write-SyncStatus -State "conflict" -Detail $detail -Conflicts $conflictState.Conflicts
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    $fingerprint = Get-WikiFingerprint
    if ($fingerprint -ne $lastFingerprint) {
      $lastFingerprint = $fingerprint
      $pendingSince = Get-Date
      $retryAt = $null
      Write-SyncStatus -State "debouncing" -Detail "Memory changes detected."
      Write-SyncLog -Level "INFO" -Message "Memory changes detected; waiting $DebounceSeconds seconds."
    }

    $now = Get-Date
    $debounceElapsed = (
      $null -ne $pendingSince -and
      ($now - $pendingSince).TotalSeconds -ge $DebounceSeconds
    )
    $retryDue = ($null -ne $retryAt -and $now -ge $retryAt)
    if ($debounceElapsed -or $retryDue) {
      try {
        $cycleResult = Invoke-SyncCycle
        if ($cycleResult -eq "success") {
          $lastFingerprint = Get-WikiFingerprint
          $pendingSince = $null
          $retryAt = $null
        }
      } catch {
        Write-SyncStatus -State "retry" -Detail $_.Exception.Message
        Write-SyncLog -Level "ERROR" -Message $_.Exception.Message
        $pendingSince = $null
        $retryAt = (Get-Date).AddSeconds($DebounceSeconds)
      }
    }

    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  if ($null -ne $script:lockStream) {
    $script:lockStream.Dispose()
  }
}
