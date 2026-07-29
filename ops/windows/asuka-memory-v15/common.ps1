Set-StrictMode -Version 2.0

function Protect-AsukaText {
  param([AllowNull()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return ""
  }

  $safe = $Text
  $safe = $safe -replace "(?i)(https?://[^:/@\s]+:)[^@\s]+@", '$1***@'
  $safe = $safe -replace "(?i)((?:api[_-]?key|token|secret|password|passwd|authorization)\s*['""]?\s*[:=]\s*['""]?)[^'""\s,;}]+", '$1***'
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

  $json = $envelope | ConvertTo-Json -Depth 24 -Compress
  Write-Output $json
  $invocationVariable = Get-Variable -Name AsukaLockedScriptInvocation `
    -Scope Global -ErrorAction SilentlyContinue
  $lockStateVariable = Get-Variable -Name AsukaDeploymentLockState `
    -Scope Global -ErrorAction SilentlyContinue
  if (
    $null -ne $invocationVariable -and
    $null -ne $lockStateVariable -and
    $null -ne $invocationVariable.Value -and
    $null -ne $lockStateVariable.Value -and
    $invocationVariable.Value.PSObject.Properties.Name -contains "LockToken" -and
    [string]$invocationVariable.Value.LockToken -cne "" -and
    [string]$invocationVariable.Value.LockToken -ceq
      [string]$lockStateVariable.Value.Token
  ) {
    $invocation = $invocationVariable.Value
    $invocation.Envelope = [pscustomobject]@{
      ExitCode = [int]$ExitCode
      Json = $json
    }
    return
  }
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

function Write-AsukaUtf8TextFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][string]$Value
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [IO.File]::WriteAllText(
    $Path,
    $Value,
    (New-Object Text.UTF8Encoding($false))
  )
}

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

function Enter-AsukaDeploymentLock {
  param([Parameter(Mandatory = $true)][string]$AppRoot)

  $appRootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $stateVariable = Get-Variable -Name AsukaDeploymentLockState `
    -Scope Global -ErrorAction SilentlyContinue
  if ($null -ne $stateVariable) {
    $state = $stateVariable.Value
    if (
      $null -eq $state -or
      [int]$state.ProcessId -ne [Diagnostics.Process]::GetCurrentProcess().Id -or
      -not ([string]$state.AppRoot).Equals(
        $appRootFull,
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      $null -eq $state.Stream -or
      $state.Stream.SafeFileHandle.IsClosed
    ) {
      throw "The in-process Asuka deployment lock lease is invalid."
    }
    $lease = [pscustomobject]@{
      Id = [Guid]::NewGuid().ToString("N")
      Token = [string]$state.Token
      Released = $false
    }
    $lease.PSObject.TypeNames.Insert(0, "Asuka.DeploymentLockLease")
    $state.Leases[[string]$lease.Id] = $lease
    return $lease
  }

  $runRoot = Join-Path $appRootFull "run"
  New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
  [void](Assert-AsukaNoReparsePointPath -Root $appRootFull -Path $runRoot)
  $lockPath = Join-Path $runRoot "asuka-memory-v15-deploy.lock"
  try {
    $stream = [IO.File]::Open(
      $lockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
  } catch {
    throw "Another Asuka v1.5 deployment operation is already running."
  }
  $token = [Guid]::NewGuid().ToString("N")
  $lease = [pscustomobject]@{
    Id = [Guid]::NewGuid().ToString("N")
    Token = $token
    Released = $false
  }
  $lease.PSObject.TypeNames.Insert(0, "Asuka.DeploymentLockLease")
  $leases = @{}
  $leases[[string]$lease.Id] = $lease
  $global:AsukaDeploymentLockState = [pscustomobject]@{
    AppRoot = $appRootFull
    LockPath = $lockPath
    ProcessId = [Diagnostics.Process]::GetCurrentProcess().Id
    Token = $token
    Stream = $stream
    Leases = $leases
  }
  return $lease
}

function Assert-AsukaDeploymentLockLease {
  param([Parameter(Mandatory = $true)][object]$Lease)

  $stateVariable = Get-Variable -Name AsukaDeploymentLockState `
    -Scope Global -ErrorAction SilentlyContinue
  if (
    $null -eq $stateVariable -or
    $null -eq $Lease -or
    $Lease.PSObject.TypeNames[0] -cne "Asuka.DeploymentLockLease"
  ) {
    throw "A valid in-process Asuka deployment lock lease is required."
  }
  $state = $stateVariable.Value
  $leaseId = [string]$Lease.Id
  if (
    $null -eq $state -or
    [int]$state.ProcessId -ne [Diagnostics.Process]::GetCurrentProcess().Id -or
    $null -eq $state.Stream -or
    $state.Stream.SafeFileHandle.IsClosed -or
    [bool]$Lease.Released -or
    [string]$Lease.Token -cne [string]$state.Token -or
    -not $state.Leases.ContainsKey($leaseId) -or
    -not [object]::ReferenceEquals($state.Leases[$leaseId], $Lease)
  ) {
    throw "A valid in-process Asuka deployment lock lease is required."
  }
  return $state
}

function Exit-AsukaDeploymentLock {
  param([Parameter(Mandatory = $true)][object]$Lease)

  $state = Assert-AsukaDeploymentLockLease -Lease $Lease
  [void]$state.Leases.Remove([string]$Lease.Id)
  $Lease.Released = $true
  if ($state.Leases.Count -eq 0) {
    try {
      $state.Stream.Dispose()
    } finally {
      Remove-Variable -Name AsukaDeploymentLockState -Scope Global `
        -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-AsukaLockedScript {
  param(
    [Parameter(Mandatory = $true)][object]$Lease,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [hashtable]$Parameters = @{}
  )

  $lockState = Assert-AsukaDeploymentLockLease -Lease $Lease
  $opsRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\")
  $scriptFull = [IO.Path]::GetFullPath($ScriptPath)
  if (
    -not $scriptFull.StartsWith(
      "$opsRoot\",
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [IO.Path]::GetExtension($scriptFull) -cne ".ps1" -or
    -not (Test-Path -LiteralPath $scriptFull -PathType Leaf)
  ) {
    throw "Locked deployment script path is not trusted: $ScriptPath"
  }
  [void](Assert-AsukaNoReparsePointPath -Root $opsRoot -Path $scriptFull)

  $previousVariable = Get-Variable -Name AsukaLockedScriptInvocation `
    -Scope Global -ErrorAction SilentlyContinue
  $invocation = [pscustomobject]@{
    Id = [Guid]::NewGuid().ToString("N")
    LockToken = [string]$lockState.Token
    Envelope = $null
  }
  $global:AsukaLockedScriptInvocation = $invocation
  try {
    $output = @(& $scriptFull @Parameters)
    if ($null -eq $invocation.Envelope) {
      throw "Locked deployment script returned without an envelope: $scriptFull"
    }
    return [pscustomobject]@{
      ExitCode = [int]$invocation.Envelope.ExitCode
      Output = Protect-AsukaText (@($output) -join [Environment]::NewLine)
    }
  } finally {
    if ($null -ne $previousVariable) {
      $global:AsukaLockedScriptInvocation = $previousVariable.Value
    } else {
      Remove-Variable -Name AsukaLockedScriptInvocation -Scope Global `
        -ErrorAction SilentlyContinue
    }
  }
}

function Assert-AsukaNoReparsePointPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  $pathFull = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  if (
    -not $pathFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and
    -not $pathFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Path escapes its allowed root: $Path"
  }

  $current = $rootFull
  $relative = $pathFull.Substring($rootFull.Length).TrimStart("\")
  $components = @()
  if (-not [string]::IsNullOrWhiteSpace($relative)) {
    $components = @($relative -split "\\")
  }
  foreach ($component in @("") + $components) {
    if (-not [string]::IsNullOrWhiteSpace($component)) {
      $current = Join-Path $current $component
    }
    if (-not (Test-Path -LiteralPath $current)) {
      break
    }
    $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Path contains an unsupported reparse point: $current"
    }
  }
  return $pathFull
}

function Assert-AsukaJsonBoolean {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Property,
    [bool]$Expected = $true
  )

  if (
    $null -eq $Object -or
    -not ($Object.PSObject.Properties.Name -contains $Property) -or
    -not ($Object.$Property -is [bool]) -or
    [bool]$Object.$Property -ne $Expected
  ) {
    throw "JSON field '$Property' must be the boolean '$($Expected.ToString().ToLowerInvariant())'."
  }
  return [bool]$Object.$Property
}

function Assert-AsukaJsonInteger {
  param(
    [Parameter(Mandatory = $true)][object]$Object,
    [Parameter(Mandatory = $true)][string]$Property,
    [long]$Minimum = [long]::MinValue,
    [long]$Maximum = [long]::MaxValue
  )

  if (
    $null -eq $Object -or
    -not ($Object.PSObject.Properties.Name -contains $Property)
  ) {
    throw "JSON field '$Property' must be an integer."
  }
  $value = $Object.$Property
  if (
    -not (
      $value -is [byte] -or
      $value -is [sbyte] -or
      $value -is [int16] -or
      $value -is [uint16] -or
      $value -is [int32] -or
      $value -is [uint32] -or
      $value -is [int64]
    )
  ) {
    throw "JSON field '$Property' must be an integer."
  }
  $integer = [long]$value
  if ($integer -lt $Minimum -or $integer -gt $Maximum) {
    throw "JSON field '$Property' is outside its allowed range."
  }
  return $integer
}

function Sort-AsukaRecordsOrdinal {
  param(
    [Parameter(Mandatory = $true)][object[]]$Records,
    [Parameter(Mandatory = $true)][string]$Property
  )

  $sorted = [object[]]@($Records)
  $keys = New-Object "string[]" $sorted.Count
  for ($index = 0; $index -lt $sorted.Count; $index += 1) {
    $keys[$index] = [string]$sorted[$index].$Property
  }
  [Array]::Sort(
    [Array]$keys,
    [Array]$sorted,
    [Collections.IComparer][StringComparer]::Ordinal
  )
  return @($sorted)
}

function Get-AsukaDeploymentRunRoot {
  param(
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseId
  )

  if ($ReleaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
    throw "Deployment releaseId is unsafe."
  }
  return Resolve-AsukaChildPath -Root $AppRoot `
    -Relative ("run\deployments\{0}" -f $ReleaseId)
}

function Resolve-AsukaNodePath {
  param(
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$NodeVersion
  )

  if ($NodeVersion -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+$") {
    throw "Node.js version is unsafe."
  }
  return Resolve-AsukaChildPath -Root (Join-Path $AppRoot "tools") `
    -Relative ("node-{0}\node.exe" -f $NodeVersion)
}

function Assert-AsukaNoReparsePointsInTree {
  param([Parameter(Mandatory = $true)][string]$Path)

  $root = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  [void](Assert-AsukaNoReparsePointPath -Root $root -Path $root)
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Directory does not exist: $root"
  }

  $pending = New-Object System.Collections.Stack
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Directory tree contains an unsupported reparse point: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      }
    }
  }
}

function Test-AsukaRuntimeDependencyTree {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$PluginRoot
  )

  $dependencyRoot = Resolve-AsukaChildPath -Root $PluginRoot `
    -Relative ([string]$Manifest.runtimeDependencyTree.path)
  $integrity = Get-AsukaDirectoryIntegrity -Path $dependencyRoot
  if (
    [int]$integrity.fileCount -ne
      [int]$Manifest.runtimeDependencyTree.fileCount -or
    [int64]$integrity.bytes -ne
      [int64]$Manifest.runtimeDependencyTree.bytes -or
    [string]$integrity.sha256 -ne
      ([string]$Manifest.runtimeDependencyTree.sha256).ToLowerInvariant()
  ) {
    throw "Runtime dependency tree does not match the release integrity contract."
  }
  return $integrity
}

function Resolve-AsukaLexicalChildPath {
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

function Resolve-AsukaChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Relative
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  $candidate = Resolve-AsukaLexicalChildPath -Root $rootFull `
    -Relative $Relative
  [void](Assert-AsukaNoReparsePointPath -Root $rootFull -Path $candidate)
  return $candidate
}

function Get-AsukaSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "File does not exist: $Path"
  }
  return (
    Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop
  ).Hash.ToLowerInvariant()
}

function Get-AsukaDirectoryIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$ExcludePaths = @(),
    [switch]$ExcludeReparsePoints
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Directory does not exist: $Path"
  }
  $root = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  $excluded = @{}
  foreach ($relative in $ExcludePaths) {
    $key = ([string]$relative).Replace("\", "/").ToLowerInvariant()
    $excluded[$key] = $true
  }
  $records = New-Object System.Collections.ArrayList
  $pending = New-Object System.Collections.Stack
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($ExcludeReparsePoints) {
          continue
        }
        throw "Directory tree contains an unsupported reparse point: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
        continue
      }
      $relative = $item.FullName.Substring($root.Length).TrimStart("\").Replace("\", "/")
      if (-not $excluded.ContainsKey($relative.ToLowerInvariant())) {
        [void]$records.Add([pscustomobject]@{
          path = $relative
          bytes = [int64]$item.Length
          sha256 = Get-AsukaSha256 -Path $item.FullName
        })
      }
    }
  }
  $files = @(Sort-AsukaRecordsOrdinal -Records @($records) -Property "path")
  $payload = [Text.Encoding]::UTF8.GetBytes(
    (($files | ForEach-Object {
      "{0}`t{1}`t{2}" -f $_.sha256, $_.bytes, $_.path
    }) -join "`n")
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $treeSha256 = ([BitConverter]::ToString($sha256.ComputeHash($payload))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  return [pscustomobject]@{
    path = $root
    files = $files
    fileCount = $files.Count
    bytes = [int64](($files | Measure-Object -Property bytes -Sum).Sum)
    sha256 = $treeSha256
  }
}

function Write-AsukaBackupIntegrity {
  param([Parameter(Mandatory = $true)][string]$BackupPath)

  $backupRoot = [IO.Path]::GetFullPath($BackupPath).TrimEnd("\")
  [void](Assert-AsukaNoReparsePointPath -Root $backupRoot -Path $backupRoot)
  $manifestPath = Join-Path $backupRoot "backup-files.json"
  $markerPath = Join-Path $backupRoot "backup-complete.marker"
  $pendingMarkerPath = "$markerPath.pending"
  foreach ($path in @($manifestPath, $markerPath, $pendingMarkerPath)) {
    if (Test-Path -LiteralPath $path) {
      throw "Backup directory already contains an integrity artifact and cannot be re-signed: $path"
    }
  }
  $integrity = Get-AsukaDirectoryIntegrity -Path $backupRoot
  $manifest = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    fileCount = [int]$integrity.fileCount
    bytes = [int64]$integrity.bytes
    treeSha256 = [string]$integrity.sha256
    files = @($integrity.files)
  }
  Write-AsukaJsonFile -Path $manifestPath -Value $manifest
  $marker = [ordered]@{
    schemaVersion = 1
    manifest = "backup-files.json"
    manifestSha256 = Get-AsukaSha256 -Path $manifestPath
    fileCount = [int]$integrity.fileCount
    bytes = [int64]$integrity.bytes
    treeSha256 = [string]$integrity.sha256
  }
  Write-AsukaJsonFile -Path $pendingMarkerPath -Value $marker
  try {
    [void](Test-AsukaBackupIntegrity -BackupPath $backupRoot -PendingMarker)
    Move-Item -LiteralPath $pendingMarkerPath -Destination $markerPath
  } catch {
    if (Test-Path -LiteralPath $pendingMarkerPath) {
      Remove-Item -LiteralPath $pendingMarkerPath -Force
    }
    throw
  }
  return $marker
}

function Test-AsukaBackupIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$BackupPath,
    [switch]$PendingMarker
  )

  $backupRoot = [IO.Path]::GetFullPath($BackupPath).TrimEnd("\")
  [void](Assert-AsukaNoReparsePointPath -Root $backupRoot -Path $backupRoot)
  $manifestPath = Join-Path $backupRoot "backup-files.json"
  $finalMarkerPath = Join-Path $backupRoot "backup-complete.marker"
  $markerPath = if ($PendingMarker) {
    "$finalMarkerPath.pending"
  } else {
    $finalMarkerPath
  }
  if ($PendingMarker -and (Test-Path -LiteralPath $finalMarkerPath)) {
    throw "Final backup marker exists before pending verification."
  }
  $integrityFiles = if ($PendingMarker) {
    @("backup-files.json", "backup-complete.marker.pending")
  } else {
    @("backup-files.json", "backup-complete.marker")
  }
  foreach ($path in @($manifestPath, $markerPath)) {
    [void](Assert-AsukaNoReparsePointPath -Root $backupRoot -Path $path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Backup integrity artifact is missing: $path"
    }
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [int]$marker.schemaVersion -ne 1 -or
    [string]$marker.manifest -ne "backup-files.json" -or
    [string]$marker.manifestSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    [int]$marker.fileCount -lt 0 -or
    [int64]$marker.bytes -lt 0 -or
    [string]$marker.treeSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    (Get-AsukaSha256 -Path $manifestPath) -ne
      ([string]$marker.manifestSha256).ToLowerInvariant()
  ) {
    throw "Backup integrity marker does not match its file manifest."
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    [int]$manifest.schemaVersion -ne 1 -or
    $null -eq $manifest.files -or
    [int]$manifest.fileCount -lt 0 -or
    [int64]$manifest.bytes -lt 0 -or
    [string]$manifest.treeSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    @($manifest.files).Count -ne [int]$manifest.fileCount -or
    [int]$marker.fileCount -ne [int]$manifest.fileCount -or
    [int64]$marker.bytes -ne [int64]$manifest.bytes -or
    ([string]$marker.treeSha256).ToLowerInvariant() -ne
      ([string]$manifest.treeSha256).ToLowerInvariant()
  ) {
    throw "Backup file manifest and marker have inconsistent totals."
  }
  $records = New-Object System.Collections.ArrayList
  $recordPaths = @{}
  foreach ($entry in @($manifest.files)) {
    $relative = ([string]$entry.path).Replace("\", "/")
    if (
      [string]::IsNullOrWhiteSpace($relative) -or
      $relative -ieq "backup-files.json" -or
      $relative -ieq "backup-complete.marker" -or
      -not ($entry.PSObject.Properties.Name -contains "bytes") -or
      [int64]$entry.bytes -lt 0 -or
      [string]$entry.sha256 -notmatch "^[a-fA-F0-9]{64}$"
    ) {
      throw "Backup file manifest contains an invalid protected path."
    }
    $pathKey = $relative.ToLowerInvariant()
    if ($recordPaths.ContainsKey($pathKey)) {
      throw "Backup file manifest contains a duplicate protected path: $relative"
    }
    $recordPaths[$pathKey] = $true
    $file = Resolve-AsukaLexicalChildPath -Root $backupRoot `
      -Relative $relative
    $canonicalRelative = $file.Substring($backupRoot.Length).TrimStart("\").Replace("\", "/")
    if (-not $canonicalRelative.Equals($relative, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Backup file manifest contains a non-canonical protected path: $relative"
    }
    [void]$records.Add([pscustomobject]@{
      path = $relative
      bytes = [int64]$entry.bytes
      sha256 = ([string]$entry.sha256).ToLowerInvariant()
    })
  }
  $recordBytes = [int64](($records | Measure-Object -Property bytes -Sum).Sum)
  if ($recordBytes -ne [int64]$manifest.bytes) {
    throw "Backup file manifest byte total is invalid."
  }
  $payload = [Text.Encoding]::UTF8.GetBytes(
    ((Sort-AsukaRecordsOrdinal -Records @($records) -Property "path" | ForEach-Object {
      "{0}`t{1}`t{2}" -f $_.sha256, $_.bytes, $_.path
    }) -join "`n")
  )
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $treeSha256 = ([BitConverter]::ToString($sha256.ComputeHash($payload))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($treeSha256 -ne ([string]$manifest.treeSha256).ToLowerInvariant()) {
    throw "Backup file manifest tree hash is invalid."
  }
  $actual = Get-AsukaDirectoryIntegrity -Path $backupRoot -ExcludePaths $integrityFiles
  $actualPaths = @{}
  foreach ($entry in @($actual.files)) {
    $pathKey = ([string]$entry.path).ToLowerInvariant()
    $actualPaths[$pathKey] = $entry
    if (-not $recordPaths.ContainsKey($pathKey)) {
      throw "Backup directory contains an unmanifested protected file: $($entry.path)"
    }
  }
  foreach ($record in $records) {
    $pathKey = ([string]$record.path).ToLowerInvariant()
    if (-not $actualPaths.ContainsKey($pathKey)) {
      throw "Protected backup file is missing: $($record.path)"
    }
    $entry = $actualPaths[$pathKey]
    if (
      [int64]$entry.bytes -ne [int64]$record.bytes -or
      [string]$entry.sha256 -ne [string]$record.sha256
    ) {
      throw "Protected backup file failed integrity verification: $($record.path)"
    }
  }
  if (
    [int]$actual.fileCount -ne [int]$manifest.fileCount -or
    [int64]$actual.bytes -ne [int64]$manifest.bytes -or
    [string]$actual.sha256 -ne $treeSha256
  ) {
    throw "Backup directory contains missing, extra, or modified protected files."
  }
  return [pscustomobject]@{
    fileCount = [int]$actual.fileCount
    bytes = [int64]$actual.bytes
    treeSha256 = $treeSha256
    manifestSha256 = ([string]$marker.manifestSha256).ToLowerInvariant()
  }
}

function Assert-AsukaExactJsonProperties {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string[]]$Properties,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -eq $Object) {
    throw "$Context must contain exactly the required properties."
  }
  $actual = @($Object.PSObject.Properties.Name)
  if ($actual.Count -ne $Properties.Count) {
    throw "$Context must contain exactly the required properties."
  }
  foreach ($property in $Properties) {
    if (-not ($actual -ccontains $property)) {
      throw "$Context must contain exactly the required properties."
    }
  }
}

function Assert-AsukaLocalEmbeddingContract {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Contract,
    [switch]$ManifestEmbedding
  )

  $topProperties = @(
    "schemaVersion",
    "ollama",
    "task",
    "api",
    "model",
    "paths"
  )
  if ($ManifestEmbedding) {
    $topProperties = @("contractSource", "contractSha256") + $topProperties
  }
  Assert-AsukaExactJsonProperties -Object $Contract `
    -Properties $topProperties -Context "Local embedding contract"
  Assert-AsukaExactJsonProperties -Object $Contract.ollama -Properties @(
    "version",
    "signerOrganization",
    "executableBytes",
    "executableSha256"
  ) -Context "Local embedding Ollama contract"
  Assert-AsukaExactJsonProperties -Object $Contract.task `
    -Properties @("name") -Context "Local embedding task contract"
  Assert-AsukaExactJsonProperties -Object $Contract.api `
    -Properties @("endpoint", "apiKey") `
    -Context "Local embedding API contract"
  Assert-AsukaExactJsonProperties -Object $Contract.model -Properties @(
    "name",
    "family",
    "task",
    "quantization",
    "dimensions",
    "license",
    "sourceRepository",
    "sourceRevision",
    "sourceFile",
    "sourcePath",
    "sourceUrl",
    "sourceBytes",
    "sourceSha256",
    "ollamaManifest",
    "runtime"
  ) -Context "Local embedding model contract"
  Assert-AsukaExactJsonProperties -Object $Contract.model.runtime -Properties @(
    "manifestBytes",
    "manifestSha256",
    "config",
    "layers"
  ) -Context "Local embedding runtime contract"
  Assert-AsukaExactJsonProperties -Object $Contract.model.runtime.config `
    -Properties @("mediaType", "digest", "size") `
    -Context "Local embedding runtime config descriptor"
  $runtimeLayers = @($Contract.model.runtime.layers)
  if (
    -not ($Contract.model.runtime.layers -is [Array]) -or
    $runtimeLayers.Count -ne 1
  ) {
    throw "Local embedding runtime contract must contain one layer descriptor."
  }
  Assert-AsukaExactJsonProperties -Object $runtimeLayers[0] `
    -Properties @("mediaType", "digest", "size") `
    -Context "Local embedding runtime layer descriptor"
  Assert-AsukaExactJsonProperties -Object $Contract.paths -Properties @(
    "ollamaModels",
    "contract",
    "startScript",
    "state",
    "modelfile"
  ) -Context "Local embedding path contract"

  $schemaVersion = Assert-AsukaJsonInteger -Object $Contract `
    -Property "schemaVersion" -Minimum 1 -Maximum 1
  $executableBytes = Assert-AsukaJsonInteger -Object $Contract.ollama `
    -Property "executableBytes" -Minimum 1
  $dimensions = Assert-AsukaJsonInteger -Object $Contract.model `
    -Property "dimensions" -Minimum 1
  $sourceBytes = Assert-AsukaJsonInteger -Object $Contract.model `
    -Property "sourceBytes" -Minimum 1
  $runtimeManifestBytes = Assert-AsukaJsonInteger `
    -Object $Contract.model.runtime -Property "manifestBytes" -Minimum 1
  $runtimeConfigBytes = Assert-AsukaJsonInteger `
    -Object $Contract.model.runtime.config -Property "size" -Minimum 1
  $runtimeLayerBytes = Assert-AsukaJsonInteger -Object $runtimeLayers[0] `
    -Property "size" -Minimum 1
  if (
    $schemaVersion -ne 1 -or
    $executableBytes -ne 36512648 -or
    $dimensions -ne 1024 -or
    $sourceBytes -ne 396705152 -or
    $runtimeManifestBytes -ne 415 -or
    $runtimeConfigBytes -ne 268 -or
    $runtimeLayerBytes -ne 396705152
  ) {
    throw "Local embedding contract contains an unexpected integer value."
  }
  if (
    [string]$Contract.ollama.version -cne "0.32.5" -or
    [string]$Contract.ollama.signerOrganization -cne "Ollama Inc." -or
    [string]$Contract.ollama.executableSha256 -cne
      "82e3b496c059720fa1c40a09af7803778f4bb40f32fb459a1d799c822a217843"
  ) {
    throw "Local embedding Ollama contract does not match production."
  }
  if (
    [string]$Contract.task.name -cne "AsukaEmbedding" -or
    [string]$Contract.api.endpoint -cne
      "http://127.0.0.1:11434/v1/embeddings" -or
    [string]$Contract.api.apiKey -cne "ollama-local"
  ) {
    throw "Local embedding service contract does not match production."
  }
  if (
    [string]$Contract.model.name -cne
      "asuka-jina-v5-text-small:2026-02-25-q4km" -or
    [string]$Contract.model.family -cne
      "jina-embeddings-v5-text-small" -or
    [string]$Contract.model.task -cne "retrieval" -or
    [string]$Contract.model.quantization -cne "Q4_K_M" -or
    [string]$Contract.model.license -cne "CC-BY-NC-4.0" -or
    [string]$Contract.model.sourceRepository -cne
      "jinaai/jina-embeddings-v5-text-small-retrieval-GGUF" -or
    [string]$Contract.model.sourceRevision -cne
      "78b0ebcb4c870fdfef409e578b65288b49a4fa90" -or
    [string]$Contract.model.sourceFile -cne
      "v5-small-retrieval-Q4_K_M.gguf" -or
    [string]$Contract.model.sourcePath -cne
      "models/jina-v5-text-small/v5-small-retrieval-Q4_K_M.gguf" -or
    [string]$Contract.model.sourceUrl -cne
      "https://huggingface.co/jinaai/jina-embeddings-v5-text-small-retrieval-GGUF/resolve/78b0ebcb4c870fdfef409e578b65288b49a4fa90/v5-small-retrieval-Q4_K_M.gguf?download=true" -or
    [string]$Contract.model.sourceSha256 -cne
      "9440cf89f3e8a7a31a42e11b87e106dd5b344af4e0e3b6b21a96136cc8686e21" -or
    [string]$Contract.model.ollamaManifest -cne
      "manifests/registry.ollama.ai/library/asuka-jina-v5-text-small/2026-02-25-q4km"
  ) {
    throw "Local embedding model contract does not match production."
  }
  if (
    [string]$Contract.model.runtime.manifestSha256 -cne
      "434bad391068826cb0565d7b96cf0456886149f7ae60a00eab590f01beac6945" -or
    [string]$Contract.model.runtime.config.mediaType -cne
      "application/vnd.docker.container.image.v1+json" -or
    [string]$Contract.model.runtime.config.digest -cne
      "sha256:f1922a92413bac87dda32999c8808fd16d68b16acae46db14a1581a951167f3c" -or
    [string]$runtimeLayers[0].mediaType -cne
      "application/vnd.ollama.image.model" -or
    [string]$runtimeLayers[0].digest -cne
      "sha256:741faa04ffc97e4c2ebe124c4e7fc4092170c3ebdb5957f7ab9088bea25c02ee"
  ) {
    throw "Local embedding runtime contract does not match production."
  }
  if (
    [string]$Contract.paths.ollamaModels -cne "models/ollama" -or
    [string]$Contract.paths.contract -cne
      "embedding/local-embedding-contract.json" -or
    [string]$Contract.paths.startScript -cne
      "embedding/start-local-embedding.ps1" -or
    [string]$Contract.paths.state -cne "embedding/install-state.json" -or
    [string]$Contract.paths.modelfile -cne
      "models/jina-v5-text-small/Modelfile"
  ) {
    throw "Local embedding path contract does not match production."
  }
  if (
    $ManifestEmbedding -and (
      [string]$Contract.contractSource -cne
        "ops/local-embedding-contract.json" -or
      [string]$Contract.contractSha256 -notmatch "^[a-f0-9]{64}$"
    )
  ) {
    throw "Release manifest has invalid local embedding contract metadata."
  }
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
  if (
    -not ($manifest.PSObject.Properties.Name -contains "source") -or
    $null -eq $manifest.source
  ) {
    throw "Release manifest source provenance must be git."
  }
  $sourceProperties = @($manifest.source.PSObject.Properties.Name)
  if (
    -not ($sourceProperties -contains "provenance") -or
    [string]$manifest.source.provenance -ne "git"
  ) {
    throw "Release manifest source provenance must be git."
  }
  if (
    -not ($sourceProperties -contains "gitBranch") -or
    [string]::IsNullOrWhiteSpace([string]$manifest.source.gitBranch)
  ) {
    throw "Release manifest source branch is empty."
  }
  if (
    -not ($sourceProperties -contains "gitCommit") -or
    [string]$manifest.source.gitCommit -notmatch "^[a-fA-F0-9]{40}$"
  ) {
    throw "Release manifest source commit must be a full 40-character Git commit."
  }
  if (
    -not ($sourceProperties -contains "worktreeDirty") -or
    -not ($manifest.source.worktreeDirty -is [bool]) -or
    [bool]$manifest.source.worktreeDirty -or
    -not ($sourceProperties -contains "worktreeStatus") -or
    @($manifest.source.worktreeStatus).Count -ne 0
  ) {
    throw "Release manifest source worktree must be clean."
  }
  if (
    $null -eq $manifest.requirements -or
    [string]$manifest.requirements.nodeVersion -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+$"
  ) {
    throw "Release manifest has an invalid Node.js version."
  }
  $gatewayPort = Assert-AsukaJsonInteger -Object $manifest.requirements `
    -Property "gatewayPort" -Minimum 1 -Maximum 65535
  if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "Release manifest has an invalid Gateway port."
  }
  $embedding = $manifest.requirements.embedding
  Assert-AsukaLocalEmbeddingContract -Contract $embedding -ManifestEmbedding
  if (
    [string]$embedding.task.name -eq
      [string]$manifest.requirements.tasks.gateway -or
    [string]$embedding.task.name -eq
      [string]$manifest.requirements.tasks.sync
  ) {
    throw "Release manifest task names must be distinct."
  }
  foreach ($relative in @(
    [string]$embedding.model.sourcePath,
    [string]$embedding.model.ollamaManifest,
    [string]$embedding.paths.ollamaModels,
    [string]$embedding.paths.contract,
    [string]$embedding.paths.startScript,
    [string]$embedding.paths.state,
    [string]$embedding.paths.modelfile
  )) {
    if (
      [string]::IsNullOrWhiteSpace($relative) -or
      [IO.Path]::IsPathRooted($relative) -or
      $relative.Replace("\", "/") -match "(^|/)\.\.?(/|$)"
    ) {
      throw "Release manifest contains an unsafe local embedding path."
    }
  }
  $contractPath = Resolve-AsukaChildPath `
    -Root (Split-Path -Parent $Path) `
    -Relative ([string]$embedding.contractSource)
  if (
    -not (Test-Path -LiteralPath $contractPath -PathType Leaf) -or
    (Get-AsukaSha256 -Path $contractPath) -cne
      ([string]$embedding.contractSha256).ToLowerInvariant()
  ) {
    throw "Release local embedding contract failed integrity verification."
  }
  try {
    $releaseEmbedding = Get-Content -LiteralPath $contractPath -Raw `
      -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Release local embedding contract is invalid JSON."
  }
  Assert-AsukaLocalEmbeddingContract -Contract $releaseEmbedding

  $buildAttestation = $manifest.source.buildAttestation
  if (
    $null -eq $buildAttestation -or
    [int]$buildAttestation.schemaVersion -ne 1 -or
    [string]$buildAttestation.kind -ne "release_build" -or
    [string]$buildAttestation.mode -ne "clean_linked_worktree" -or
    [string]$buildAttestation.gitCommit -cne [string]$manifest.source.gitCommit -or
    [string]$buildAttestation.gitBranch -cne [string]$manifest.source.gitBranch -or
    [string]::IsNullOrWhiteSpace([string]$buildAttestation.platform) -or
    [string]::IsNullOrWhiteSpace([string]$buildAttestation.architecture) -or
    [string]$buildAttestation.nodeVersion -cne
      [string]$manifest.requirements.nodeVersion -or
    [string]$buildAttestation.npmVersion -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:[-+].+)?$" -or
    [string]$buildAttestation.lockfilePath -ne
      "extensions/qqbot/package-lock.json" -or
    [string]$buildAttestation.lockfileSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    [string]$buildAttestation.runtimeTreeSha256 -notmatch "^[a-fA-F0-9]{64}$"
  ) {
    throw "Release manifest has no valid clean linked-worktree build attestation."
  }
  $buildCommands = @($buildAttestation.commands)
  if (
    $buildCommands.Count -ne 3 -or
    [string]$buildCommands[0] -cne "npm ci --ignore-scripts" -or
    [string]$buildCommands[1] -cne
      "node scripts/patch-runtime-cron.mjs --vendored-only" -or
    [string]$buildCommands[2] -cne "npm test"
  ) {
    throw "Release build attestation has an unexpected command sequence."
  }

  $dependencyAttestation = $manifest.source.windowsDependencyAttestation
  if (
    $null -eq $dependencyAttestation -or
    [int]$dependencyAttestation.schemaVersion -ne 1 -or
    [string]$dependencyAttestation.kind -ne "windows_runtime_dependencies" -or
    [string]$dependencyAttestation.mode -ne "clean_linked_worktree" -or
    [string]$dependencyAttestation.gitCommit -cne
      [string]$manifest.source.gitCommit -or
    [string]$dependencyAttestation.gitBranch -cne
      [string]$manifest.source.gitBranch -or
    [string]$dependencyAttestation.platform -ne "win32" -or
    [string]$dependencyAttestation.architecture -ne "x64" -or
    [string]$dependencyAttestation.nodeVersion -cne
      [string]$manifest.requirements.nodeVersion -or
    [string]$dependencyAttestation.npmVersion -cne
      [string]$buildAttestation.npmVersion -or
    [string]$dependencyAttestation.lockfilePath -ne
      "extensions/qqbot/package-lock.json" -or
    [string]$dependencyAttestation.lockfileSha256 -cne
      [string]$buildAttestation.lockfileSha256
  ) {
    throw "Release manifest has no valid Windows dependency attestation."
  }
  $dependencyCommands = @($dependencyAttestation.commands)
  if (
    $dependencyCommands.Count -ne 2 -or
    [string]$dependencyCommands[0] -cne "npm ci --ignore-scripts" -or
    [string]$dependencyCommands[1] -cne
      "node scripts/patch-runtime-cron.mjs --vendored-only"
  ) {
    throw "Windows dependency attestation has an unexpected command sequence."
  }
  $attestedDependencyTree = $dependencyAttestation.runtimeDependencyTree
  $runtimeDependencyTree = $manifest.runtimeDependencyTree
  if (
    $null -eq $attestedDependencyTree -or
    $null -eq $runtimeDependencyTree -or
    [string]$attestedDependencyTree.path -ne "node_modules" -or
    [string]$runtimeDependencyTree.path -ne "node_modules" -or
    [string]$runtimeDependencyTree.platform -ne "win32" -or
    [string]$runtimeDependencyTree.architecture -ne "x64" -or
    [string]$attestedDependencyTree.sha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    [string]$runtimeDependencyTree.sha256 -cne
      [string]$attestedDependencyTree.sha256
  ) {
    throw "Release manifest has no valid runtimeDependencyTree contract."
  }
  $attestedDependencyFiles = Assert-AsukaJsonInteger `
    -Object $attestedDependencyTree -Property "fileCount" -Minimum 1
  $attestedDependencyBytes = Assert-AsukaJsonInteger `
    -Object $attestedDependencyTree -Property "bytes" -Minimum 1
  $declaredDependencyFiles = Assert-AsukaJsonInteger `
    -Object $runtimeDependencyTree -Property "fileCount" -Minimum 1
  $declaredDependencyBytes = Assert-AsukaJsonInteger `
    -Object $runtimeDependencyTree -Property "bytes" -Minimum 1
  if (
    $attestedDependencyFiles -ne $declaredDependencyFiles -or
    $attestedDependencyBytes -ne $declaredDependencyBytes
  ) {
    throw "Runtime dependency tree does not match its Windows attestation."
  }

  if ($null -eq $manifest.runtimeFiles -or @($manifest.runtimeFiles).Count -eq 0) {
    throw "Release manifest has no runtimeFiles."
  }
  $preservedRuntimeDirectories = @($manifest.runtimePreservedDirectories)
  if (
    $preservedRuntimeDirectories.Count -ne 1 -or
    [string]$preservedRuntimeDirectories[0] -ne "node_modules"
  ) {
    throw "Release manifest has an unsupported runtime dependency allowlist."
  }
  if ($null -eq $manifest.opsFiles -or @($manifest.opsFiles).Count -eq 0) {
    throw "Release manifest has no opsFiles."
  }
  $requiredReleaseHelpers = @(
    "ops/asuka-memory-sync.ps1",
    "ops/common.ps1",
    "ops/configure-memory-kernel.mjs",
    "ops/create-recovery-baseline.ps1",
    "ops/deploy.ps1",
    "ops/freeze-and-backup-v15.ps1",
    "ops/install-local-embedding.ps1",
    "ops/local-embedding-contract.json",
    "ops/normalize-task-actions.ps1",
    "ops/preflight.ps1",
    "ops/recover-v15-baseline.ps1",
    "ops/restore-vault-generated.mjs",
    "ops/rollback.ps1",
    "ops/start-local-embedding.ps1",
    "ops/verify-ledger.mjs",
    "ops/verify-model-config.mjs",
    "ops/verify.ps1"
  )
  $declaredRequiredHelpers = @($manifest.requiredExecutableHelpers)
  if ($declaredRequiredHelpers.Count -ne $requiredReleaseHelpers.Count) {
    throw "Release manifest required helper contract is incomplete."
  }
  for ($index = 0; $index -lt $requiredReleaseHelpers.Count; $index += 1) {
    if (
      [string]$declaredRequiredHelpers[$index] -cne
        [string]$requiredReleaseHelpers[$index]
    ) {
      throw "Release manifest required helper contract is not canonical."
    }
  }

  $runtimeDestinations = @{}
  $runtimeSources = @{}
  $runtimeTreeLines = @()
  $sortedRuntimeFiles = Sort-AsukaRecordsOrdinal `
    -Records @($manifest.runtimeFiles) -Property "destination"
  foreach ($entry in @($sortedRuntimeFiles)) {
    $source = ([string]$entry.source).Replace("\", "/")
    $destination = ([string]$entry.destination).Replace("\", "/")
    if (
      -not $source.StartsWith(
        "payload/qqbot/",
        [StringComparison]::Ordinal
      ) -or
      -not $destination.StartsWith(
        "home/.openclaw/extensions/qqbot/",
        [StringComparison]::Ordinal
      ) -or
      $source -match "(^|/)\.\.?(/|$)" -or
      $destination -match "(^|/)\.\.?(/|$)" -or
      [string]$entry.sha256 -notmatch "^[a-fA-F0-9]{64}$"
    ) {
      throw "Release manifest contains an unsafe runtime file entry."
    }
    [void](Assert-AsukaJsonInteger -Object $entry -Property "bytes" -Minimum 1)
    foreach ($pair in @(
      [pscustomobject]@{ table = $runtimeSources; key = $source },
      [pscustomobject]@{ table = $runtimeDestinations; key = $destination }
    )) {
      $key = ([string]$pair.key).ToLowerInvariant()
      if ($pair.table.ContainsKey($key)) {
        throw "Release manifest contains a duplicate runtime path: $($pair.key)"
      }
      $pair.table[$key] = $true
    }
    $runtimeTreeLines += "{0}  {1}" -f (
      [string]$entry.sha256
    ).ToLowerInvariant(), $destination
  }
  $runtimeTreeSha256 = Get-AsukaStringSha256 -Value ($runtimeTreeLines -join "`n")
  if (
    [string]$manifest.source.runtimeTreeSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    $runtimeTreeSha256 -cne
      ([string]$manifest.source.runtimeTreeSha256).ToLowerInvariant() -or
    $runtimeTreeSha256 -cne
      ([string]$buildAttestation.runtimeTreeSha256).ToLowerInvariant()
  ) {
    throw "Release manifest runtime tree does not match its build attestation."
  }

  $opsSources = @{}
  foreach ($entry in @($manifest.opsFiles)) {
    $source = ([string]$entry.source).Replace("\", "/")
    if (
      -not $source.StartsWith("ops/", [StringComparison]::Ordinal) -or
      $source -match "(^|/)\.\.?(/|$)" -or
      [string]$entry.sha256 -notmatch "^[a-fA-F0-9]{64}$"
    ) {
      throw "Release manifest contains an unsafe ops file entry."
    }
    [void](Assert-AsukaJsonInteger -Object $entry -Property "bytes" -Minimum 1)
    if ($opsSources.ContainsKey($source.ToLowerInvariant())) {
      throw "Release manifest contains a duplicate ops source: $source"
    }
    $opsSources[$source.ToLowerInvariant()] = $true
  }
  foreach ($requiredHelper in $requiredReleaseHelpers) {
    if (-not $opsSources.ContainsKey($requiredHelper.ToLowerInvariant())) {
      throw "Release manifest is missing a required release helper: $requiredHelper"
    }
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
  if (
    [string]$manifest.requirements.tasks.gateway -ceq
      [string]$manifest.requirements.tasks.sync
  ) {
    throw "Release manifest scheduled-task names must be distinct."
  }
  return $manifest
}

function Test-AsukaScheduledTaskPath {
  param([AllowNull()][string]$Path)

  if ($Path -ceq "\") {
    return $true
  }
  if (
    [string]::IsNullOrWhiteSpace($Path) -or
    -not $Path.StartsWith("\", [StringComparison]::Ordinal) -or
    -not $Path.EndsWith("\", [StringComparison]::Ordinal) -or
    $Path.IndexOf([char]0) -ge 0
  ) {
    return $false
  }
  foreach ($component in @($Path.Trim("\") -split "\\")) {
    if (
      [string]::IsNullOrWhiteSpace($component) -or
      $component -eq "." -or
      $component -eq ".." -or
      $component.IndexOfAny([char[]]'/:*?"<>|') -ge 0
    ) {
      return $false
    }
  }
  return $true
}

function Get-AsukaComparableTaskXml {
  [CmdletBinding(DefaultParameterSetName = "Path")]
  param(
    [Parameter(Mandatory = $true, ParameterSetName = "Path")]
    [string]$Path,
    [Parameter(Mandatory = $true, ParameterSetName = "Text")]
    [string]$XmlText,
    [string]$Command = "",
    [switch]$SetCommand,
    [bool]$Enabled = $false,
    [switch]$SetEnabled
  )

  [xml]$document = if ($PSCmdlet.ParameterSetName -eq "Path") {
    Get-Content -LiteralPath $Path -Raw -Encoding Unicode
  } else {
    $XmlText
  }
  $execNodes = @($document.SelectNodes(
    "/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']"
  ))
  if ($execNodes.Count -ne 1) {
    throw "Scheduled-task XML must contain exactly one Exec action."
  }
  $commandNodes = @($execNodes[0].SelectNodes(
    "./*[local-name()='Command']"
  ))
  if ($commandNodes.Count -ne 1) {
    throw "Scheduled-task XML must contain exactly one Command element."
  }
  if ($SetCommand) {
    $commandNodes[0].InnerText = $Command
  }
  if ($SetEnabled) {
    $enabledNodes = @($document.SelectNodes(
      "/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']"
    ))
    if ($enabledNodes.Count -ne 1) {
      throw "Scheduled-task XML must contain exactly one Enabled element."
    }
    $enabledNodes[0].InnerText = $Enabled.ToString().ToLowerInvariant()
  }
  return [string]$document.OuterXml
}

function Read-AsukaTaskNormalizationAttestation {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$FrozenBackupPath,
    [string]$SealedSnapshotPath = "",
    [switch]$VerifyCurrentTasks,
    [ValidateSet("Disabled", "Running")]
    [string]$ExpectedCurrentState = "Disabled"
  )

  $attestationPath = [IO.Path]::GetFullPath($Path)
  if ([string]::IsNullOrWhiteSpace($SealedSnapshotPath)) {
    $normalizationRoot = [IO.Path]::GetFullPath(
      (Join-Path $AppRoot "run\task-action-normalization")
    ).TrimEnd("\")
    if (
      -not $attestationPath.StartsWith(
        "$normalizationRoot\",
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      [IO.Path]::GetFileName($attestationPath) -cne "attestation.json"
    ) {
      throw "Task normalization attestation must be an attestation.json sidecar."
    }
  } else {
    $sealedSnapshotFull = [IO.Path]::GetFullPath(
      $SealedSnapshotPath
    ).TrimEnd("\")
    [void](Test-AsukaBackupIntegrity -BackupPath $sealedSnapshotFull)
    $normalizationRoot = Join-Path $sealedSnapshotFull "tasks"
    $expectedAttestationPath = Join-Path $normalizationRoot "attestation.json"
    if (-not $attestationPath.Equals(
      $expectedAttestationPath,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw "Sealed task normalization attestation path is not canonical."
    }
  }
  [void](Assert-AsukaNoReparsePointPath -Root $normalizationRoot `
    -Path $attestationPath)
  if (-not (Test-Path -LiteralPath $attestationPath -PathType Leaf)) {
    throw "Task normalization attestation is missing: $attestationPath"
  }

  $attestation = Get-Content -LiteralPath $attestationPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $manifestSha256 = Get-AsukaSha256 -Path $ManifestPath
  $frozenManifestPath = Join-Path $FrozenBackupPath "backup-manifest.json"
  $frozenIntegrity = Test-AsukaBackupIntegrity -BackupPath $FrozenBackupPath
  $windowsRoot = [Environment]::GetFolderPath("Windows")
  $trustedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $windowsRoot `
      "System32\WindowsPowerShell\v1.0\powershell.exe")
  )
  if (
    [int]$attestation.schemaVersion -ne 1 -or
    [string]$attestation.kind -ne "asuka-task-normalization" -or
    [string]$attestation.releaseId -cne [string]$Manifest.releaseId -or
    [string]$attestation.releaseManifestSha256 -notmatch
      "^[a-fA-F0-9]{64}$" -or
    ([string]$attestation.releaseManifestSha256).ToLowerInvariant() -cne
      $manifestSha256 -or
    -not ([IO.Path]::GetFullPath(
      [string]$attestation.releaseManifestPath
    )).Equals(
      [IO.Path]::GetFullPath($ManifestPath),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not ([IO.Path]::GetFullPath([string]$attestation.appRoot)).TrimEnd("\").Equals(
      ([IO.Path]::GetFullPath($AppRoot)).TrimEnd("\"),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    -not ([IO.Path]::GetFullPath(
      [string]$attestation.frozenBackup.path
    )).TrimEnd("\").Equals(
      ([IO.Path]::GetFullPath($FrozenBackupPath)).TrimEnd("\"),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    ([string]$attestation.frozenBackup.manifestSha256).ToLowerInvariant() -cne
      (Get-AsukaSha256 -Path $frozenManifestPath) -or
    ([string]$attestation.frozenBackup.integrityManifestSha256).ToLowerInvariant() -cne
      ([string]$frozenIntegrity.manifestSha256).ToLowerInvariant() -or
    ([string]$attestation.frozenBackup.treeSha256).ToLowerInvariant() -cne
      ([string]$frozenIntegrity.treeSha256).ToLowerInvariant() -or
    -not ([IO.Path]::GetFullPath(
      [string]$attestation.trustedPowerShell
    )).Equals(
      $trustedPowerShell,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Task normalization attestation does not match this deployment."
  }

  $expectedTasks = [ordered]@{
    gateway = [string]$Manifest.requirements.tasks.gateway
    sync = [string]$Manifest.requirements.tasks.sync
  }
  $tasks = @($attestation.tasks)
  if ($tasks.Count -ne $expectedTasks.Count) {
    throw "Task normalization attestation must contain exactly two tasks."
  }
  $validated = [ordered]@{}
  foreach ($role in @($expectedTasks.Keys)) {
    $roleMatches = @($tasks | Where-Object { [string]$_.role -ceq $role })
    if ($roleMatches.Count -ne 1) {
      throw "Task normalization attestation has no unique '$role' task."
    }
    $task = $roleMatches[0]
    $expectedName = [string]$expectedTasks[$role]
    if (
      [string]$task.taskName -cne $expectedName -or
      -not (Test-AsukaScheduledTaskPath -Path ([string]$task.taskPath)) -or
      [string]$task.state -ne "Disabled" -or
      (
        Assert-AsukaJsonBoolean -Object $task `
          -Property "enabled" -Expected $false
      ) -or
      -not (
        Assert-AsukaJsonBoolean -Object $task `
          -Property "argumentsPreserved"
      ) -or
      -not (
        Assert-AsukaJsonBoolean -Object $task `
          -Property "workingDirectoryPreserved"
      ) -or
      [string]::IsNullOrWhiteSpace([string]$task.canonicalXml) -or
      [string]$task.canonicalXmlSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
      [string]$task.backupXmlSha256 -notmatch "^[a-fA-F0-9]{64}$"
    ) {
      throw "Task normalization attestation has an invalid '$role' contract."
    }
    $canonicalHash = Get-AsukaStringSha256 -Value ([string]$task.canonicalXml)
    if (
      $canonicalHash -cne
        ([string]$task.canonicalXmlSha256).ToLowerInvariant()
    ) {
      throw "Task normalization canonical XML hash does not match: $expectedName"
    }
    try {
      [xml]$canonicalDocument = [string]$task.canonicalXml
    } catch {
      throw "Task normalization canonical XML is invalid: $expectedName"
    }
    $execNodes = @($canonicalDocument.SelectNodes(
      "/*[local-name()='Task']/*[local-name()='Actions']/*[local-name()='Exec']"
    ))
    if ($execNodes.Count -ne 1) {
      throw "Task normalization canonical XML must contain one Exec action: $expectedName"
    }

    $backupXmlPath = Join-Path $FrozenBackupPath (
      "scheduled-tasks\$expectedName.xml"
    )
    if (
      (Get-AsukaSha256 -Path $backupXmlPath) -cne
        ([string]$task.backupXmlSha256).ToLowerInvariant()
    ) {
      throw "Task normalization backup XML hash does not match: $expectedName"
    }
    $expectedXml = Get-AsukaComparableTaskXml -Path $backupXmlPath `
      -Command ([string]$attestation.trustedPowerShell) -SetCommand
    $attestedXml = Get-AsukaComparableTaskXml `
      -XmlText ([string]$task.canonicalXml)
    if (-not $attestedXml.Equals(
      $expectedXml,
      [StringComparison]::Ordinal
    )) {
      throw "Task normalization XML changed outside the trusted host: $expectedName"
    }
    if ($VerifyCurrentTasks) {
      $currentXml = [string](Export-ScheduledTask -TaskName $expectedName `
        -TaskPath ([string]$task.taskPath) -ErrorAction Stop)
      $currentComparableXml = Get-AsukaComparableTaskXml -XmlText $currentXml
      $attestedComparableXml = Get-AsukaComparableTaskXml `
        -XmlText ([string]$task.canonicalXml)
      if ($ExpectedCurrentState -eq "Running") {
        $currentComparableXml = Get-AsukaComparableTaskXml `
          -XmlText $currentComparableXml -Enabled $false -SetEnabled
        $attestedComparableXml = Get-AsukaComparableTaskXml `
          -XmlText $attestedComparableXml -Enabled $false -SetEnabled
      }
      if (
        -not $currentComparableXml.Equals(
          $attestedComparableXml,
          [StringComparison]::Ordinal
        )
      ) {
        throw "Current scheduled task XML does not match the canonical attestation: $expectedName"
      }
      $current = Get-AsukaTaskSnapshot -Name $expectedName `
        -TaskPath ([string]$task.taskPath)
      $expectedEnabled = $ExpectedCurrentState -eq "Running"
      if (
        [string]$current.name -cne $expectedName -or
        [string]$current.taskPath -cne [string]$task.taskPath -or
        [string]$current.state -ne $ExpectedCurrentState -or
        [bool]$current.enabled -ne $expectedEnabled -or
        [bool]$current.wasRunning -ne $expectedEnabled
      ) {
        throw "Current scheduled task state does not match the canonical attestation: $expectedName"
      }
    }
    $validated[$role] = $task
  }

  return [pscustomobject]@{
    path = $attestationPath
    sha256 = Get-AsukaSha256 -Path $attestationPath
    manifestSha256 = $manifestSha256
    gateway = $validated.gateway
    sync = $validated.sync
    raw = $attestation
  }
}

function Find-AsukaTaskNormalizationAttestation {
  param(
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$FrozenBackupPath,
    [switch]$VerifyCurrentTasks
  )

  $normalizationRoot = Join-Path $AppRoot "run\task-action-normalization"
  $candidates = @(
    Get-ChildItem -LiteralPath $normalizationRoot -Filter "attestation.json" `
      -File -Recurse -Force -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending
  )
  $errors = @()
  foreach ($candidate in $candidates) {
    try {
      return Read-AsukaTaskNormalizationAttestation -Path $candidate.FullName `
        -AppRoot $AppRoot -ManifestPath $ManifestPath -Manifest $Manifest `
        -FrozenBackupPath $FrozenBackupPath `
        -VerifyCurrentTasks:$VerifyCurrentTasks
    } catch {
      $errors += Protect-AsukaText $_.Exception.Message
    }
  }
  if ($errors.Count -gt 0) {
    throw "No matching task normalization attestation was found. $($errors -join '; ')"
  }
  throw "No task normalization attestation was found."
}

function Test-AsukaFrozenCopyIntegrity {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$BackupPath
  )

  $appRootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $backupFull = [IO.Path]::GetFullPath($BackupPath).TrimEnd("\")
  $copies = @($Manifest.copies)
  if ($copies.Count -eq 0) {
    throw "Frozen backup manifest has no copy records."
  }

  $destinations = @{}
  $verified = @()
  foreach ($copy in $copies) {
    $sourceText = [string]$copy.Source
    $destinationText = [string]$copy.Destination
    if (
      [string]::IsNullOrWhiteSpace($sourceText) -or
      [string]::IsNullOrWhiteSpace($destinationText)
    ) {
      throw "Frozen backup manifest contains an incomplete copy record."
    }
    $source = [IO.Path]::GetFullPath($sourceText).TrimEnd("\")
    $destination = [IO.Path]::GetFullPath($destinationText).TrimEnd("\")
    if (-not $source.StartsWith("$appRootFull\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "Frozen backup copy source is outside AppRoot: $source"
    }
    if (-not $destination.StartsWith("$backupFull\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "Frozen backup copy destination is outside the backup: $destination"
    }
    $destinationKey = $destination.ToLowerInvariant()
    if ($destinations.ContainsKey($destinationKey)) {
      throw "Frozen backup manifest contains a duplicate copy destination: $destination"
    }
    $destinations[$destinationKey] = $true

    $copyProperties = @($copy.PSObject.Properties.Name)
    $skipped = $false
    if ($copyProperties -contains "Skipped") {
      if (-not ($copy.Skipped -is [bool])) {
        throw "Frozen backup copy record has a non-boolean Skipped field."
      }
      $skipped = [bool]$copy.Skipped
    }
    if ($skipped) {
      if (
        (Test-Path -LiteralPath $source) -or
        (Test-Path -LiteralPath $destination)
      ) {
        throw "Frozen backup skipped copy record no longer matches disk: $source"
      }
      continue
    }
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
      throw "Frozen backup copy source is missing: $source"
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
      throw "Frozen backup copy destination is missing: $destination"
    }
    $sourceIntegrity = Get-AsukaDirectoryIntegrity -Path $source `
      -ExcludeReparsePoints
    $destinationIntegrity = Get-AsukaDirectoryIntegrity -Path $destination
    if (
      [int]$sourceIntegrity.fileCount -ne [int]$destinationIntegrity.fileCount -or
      [int64]$sourceIntegrity.bytes -ne [int64]$destinationIntegrity.bytes -or
      [string]$sourceIntegrity.sha256 -ne [string]$destinationIntegrity.sha256
    ) {
      throw "Frozen backup copy tree does not match its source: $source"
    }
    $verified += [pscustomobject]@{
      source = $source
      destination = $destination
      fileCount = [int]$sourceIntegrity.fileCount
      bytes = [int64]$sourceIntegrity.bytes
      treeSha256 = [string]$sourceIntegrity.sha256
    }
  }
  return $verified
}

function Test-AsukaFrozenBackupSemantics {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$GatewayTaskName,
    [Parameter(Mandatory = $true)][string]$SyncTaskName,
    [Parameter(Mandatory = $true)][object]$BackupIntegrity,
    [switch]$VerifyCurrentHashes
  )

  $appRootFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
  $backupsRoot = [IO.Path]::GetFullPath((Join-Path $appRootFull "backups")).TrimEnd("\")
  $backupFull = [IO.Path]::GetFullPath($Path).TrimEnd("\")
  if (-not $backupFull.StartsWith("$backupsRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Frozen backup must be a child of the Asuka backups directory."
  }
  [void](Assert-AsukaNoReparsePointPath -Root $backupsRoot -Path $backupFull)

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
  [void](Assert-AsukaJsonInteger -Object $manifest -Property "gatewayPort" `
    -Minimum 1 -Maximum 65535)
  [void](Assert-AsukaJsonBoolean -Object $manifest `
    -Property "gatewayPortAfter" -Expected $false)
  if (
    [string]$manifest.releaseManifestSha256 -notmatch "^[a-fA-F0-9]{64}$" -or
    [string]$manifest.nodeVersion -notmatch "^v[0-9]+\.[0-9]+\.[0-9]+$"
  ) {
    throw "Frozen backup has an invalid release, Node.js, or Gateway contract."
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
  [void](Assert-AsukaJsonBoolean -Object $manifest.vault `
    -Property "dirty" -Expected $false)
  if (
    [int]$manifest.vault.ahead -ne 0 -or
    [int]$manifest.vault.behind -ne 0
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
    -not (
      Assert-AsukaJsonBoolean -Object $gatewayBefore[0] `
        -Property "Enabled"
    ) -or
    [string]$gatewayBefore[0].State -ne "Running"
  ) {
    throw "Frozen backup does not record a running, enabled $GatewayTaskName baseline."
  }
  if (
    $syncBefore.Count -ne 1 -or
    -not (
      Assert-AsukaJsonBoolean -Object $syncBefore[0] `
        -Property "Enabled"
    ) -or
    [string]$syncBefore[0].State -ne "Running"
  ) {
    throw "Frozen backup does not record a running, enabled $SyncTaskName baseline."
  }

  $taskXmlEntries = @($manifest.taskXml)
  if ($taskXmlEntries.Count -ne 2) {
    throw "Frozen backup must contain exactly two scheduled-task XML records."
  }
  foreach ($taskName in @($GatewayTaskName, $SyncTaskName)) {
    $taskXmlMatches = @(
      $taskXmlEntries |
        Where-Object { [string]$_.Name -ceq $taskName }
    )
    $expectedRelative = "scheduled-tasks\$taskName.xml"
    if (
      $taskXmlMatches.Count -ne 1 -or
      [string]$taskXmlMatches[0].Path -cne $expectedRelative -or
      [string]$taskXmlMatches[0].Sha256 -notmatch "^[a-fA-F0-9]{64}$"
    ) {
      throw "Frozen backup task XML record is invalid: $taskName"
    }
    $taskXmlPath = Resolve-AsukaChildPath -Root $backupFull `
      -Relative $expectedRelative
    if (
      (Get-AsukaSha256 -Path $taskXmlPath) -cne
        ([string]$taskXmlMatches[0].Sha256).ToLowerInvariant()
    ) {
      throw "Frozen backup task XML hash is invalid: $taskName"
    }
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
    backupIntegrity = $BackupIntegrity
  }
}

function Read-AsukaFrozenBackup {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$GatewayTaskName,
    [Parameter(Mandatory = $true)][string]$SyncTaskName,
    [switch]$VerifyCurrentHashes
  )

  $backupIntegrity = Test-AsukaBackupIntegrity -BackupPath $Path
  return Test-AsukaFrozenBackupSemantics -Path $Path -AppRoot $AppRoot `
    -GatewayTaskName $GatewayTaskName -SyncTaskName $SyncTaskName `
    -BackupIntegrity $backupIntegrity -VerifyCurrentHashes:$VerifyCurrentHashes
}

function Test-AsukaReleaseFiles {
  param(
    [Parameter(Mandatory = $true)][object]$Manifest,
    [Parameter(Mandatory = $true)][string]$ReleaseRoot
  )

  Assert-AsukaNoReparsePointsInTree -Path $ReleaseRoot
  $entries = @($Manifest.runtimeFiles)
  if ($Manifest.PSObject.Properties.Name -contains "opsFiles") {
    $entries += @($Manifest.opsFiles)
  }
  $verified = @()
  $declaredSources = @{}
  foreach ($entry in $entries) {
    $sourceKey = ([string]$entry.source).Replace("\", "/").ToLowerInvariant()
    if ($declaredSources.ContainsKey($sourceKey)) {
      throw "Release manifest contains a duplicate source: $($entry.source)"
    }
    $declaredSources[$sourceKey] = $true
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
  $opsRoot = Resolve-AsukaChildPath -Root $ReleaseRoot -Relative "ops"
  foreach ($file in @(Get-ChildItem -LiteralPath $opsRoot -File -Recurse -Force)) {
    $relative = $file.FullName.Substring(
      [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\").Length
    ).TrimStart("\").Replace("\", "/").ToLowerInvariant()
    if (-not $declaredSources.ContainsKey($relative)) {
      throw "Release contains an unmanifested release file: $relative"
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

function ConvertFrom-AsukaLocalEmbeddingVerification {
  param(
    [Parameter(Mandatory = $true)][object]$Verification,
    [Parameter(Mandatory = $true)][object]$Manifest
  )

  Assert-AsukaExactJsonProperties -Object $Verification -Properties @(
    "ok",
    "operation",
    "task",
    "ollamaVersion",
    "model",
    "dimensions",
    "sourceSha256",
    "runtimeSha256"
  ) -Context "Local embedding verification"
  $dimensions = Assert-AsukaJsonInteger -Object $Verification `
    -Property "dimensions" -Minimum 1
  $runtimeSha256 = [string]$Verification.runtimeSha256
  if (
    -not (Assert-AsukaJsonBoolean -Object $Verification -Property "ok") -or
    [string]$Verification.operation -cne "verify-local-embedding" -or
    [string]$Verification.task -cne
      [string]$Manifest.requirements.embedding.task.name -or
    [string]$Verification.ollamaVersion -cne
      [string]$Manifest.requirements.embedding.ollama.version -or
    [string]$Verification.model -cne
      [string]$Manifest.requirements.embedding.model.name -or
    $dimensions -ne
      [int]$Manifest.requirements.embedding.model.dimensions -or
    [string]$Verification.sourceSha256 -cne
      [string]$Manifest.requirements.embedding.model.sourceSha256 -or
    $runtimeSha256 -cnotmatch "^[a-f0-9]{64}$"
  ) {
    throw "Local embedding verification failed."
  }
  return [pscustomobject][ordered]@{
    ok = $true
    operation = "verify-local-embedding"
    task = [string]$Verification.task
    ollamaVersion = [string]$Verification.ollamaVersion
    model = [string]$Verification.model
    dimensions = [int]$dimensions
    sourceSha256 = [string]$Verification.sourceSha256
    runtimeSha256 = $runtimeSha256
  }
}

function Invoke-AsukaLocalEmbeddingVerification {
  param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$TrustedPowerShell,
    [Parameter(Mandatory = $true)][object]$Manifest
  )

  try {
    if ([string]::IsNullOrWhiteSpace([string]$Manifest.appRoot)) {
      throw "Local embedding verification failed."
    }
    $expectedPowerShell = [IO.Path]::GetFullPath(
      (Join-Path $env:SystemRoot `
        "System32\WindowsPowerShell\v1.0\powershell.exe")
    )
    $trustedPowerShellFull = [IO.Path]::GetFullPath($TrustedPowerShell)
    if (
      -not $trustedPowerShellFull.Equals(
        $expectedPowerShell,
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      -not (Test-Path -LiteralPath $trustedPowerShellFull -PathType Leaf)
    ) {
      throw "Local embedding verification failed."
    }
    $verifier = Resolve-AsukaChildPath -Root $ReleaseRoot `
      -Relative "ops\install-local-embedding.ps1"
    if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
      throw "Local embedding verification failed."
    }
    $result = Invoke-AsukaNative -FilePath $trustedPowerShellFull -Arguments @(
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $verifier,
      "-AppRoot",
      [string]$Manifest.appRoot,
      "-VerifyOnly"
    )
    if ($result.ExitCode -ne 0) {
      throw "Local embedding verification failed."
    }
    $output = [string]$result.Output
    if (
      [string]::IsNullOrWhiteSpace($output) -or
      $output.Contains("`r") -or
      $output.Contains("`n")
    ) {
      throw "Local embedding verification failed."
    }
    try {
      $verification = $output | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw "Local embedding verification failed."
    }
    return ConvertFrom-AsukaLocalEmbeddingVerification `
      -Verification $verification -Manifest $Manifest
  } catch {
    throw "Local embedding verification failed."
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
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$TaskPath = ""
  )

  $parameters = @{
    TaskName = $Name
    ErrorAction = "Stop"
  }
  if (-not [string]::IsNullOrWhiteSpace($TaskPath)) {
    if (-not (Test-AsukaScheduledTaskPath -Path $TaskPath)) {
      throw "Scheduled-task path is unsafe: $TaskPath"
    }
    $parameters["TaskPath"] = $TaskPath
  }
  $tasks = @(Get-ScheduledTask @parameters)
  if ($tasks.Count -ne 1) {
    throw "Scheduled-task lookup must resolve exactly one task: $Name"
  }
  $task = $tasks[0]
  $infoParameters = @{
    TaskName = $Name
    TaskPath = [string]$task.TaskPath
    ErrorAction = "Stop"
  }
  $info = Get-ScheduledTaskInfo @infoParameters
  return [pscustomobject]@{
    name = [string]$task.TaskName
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

function ConvertFrom-AsukaTaskArguments {
  param([AllowEmptyString()][string]$Arguments)

  if ($Arguments.IndexOf([char]0) -ge 0) {
    throw "Scheduled-task action contains a null character."
  }
  if (-not ("Asuka.NativeCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Asuka {
  public static class NativeCommandLine {
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr memory);
  }
}
'@ | Out-Null
  }

  $commandLine = '"C:\AsukaTaskActionValidator.exe"'
  if (-not [string]::IsNullOrWhiteSpace($Arguments)) {
    $commandLine += " $Arguments"
  }
  $argumentCount = 0
  $argumentsPointer = [Asuka.NativeCommandLine]::CommandLineToArgvW(
    $commandLine,
    [ref]$argumentCount
  )
  if ($argumentsPointer -eq [IntPtr]::Zero -or $argumentCount -lt 1) {
    throw "Windows could not parse the scheduled-task action."
  }

  $tokens = New-Object System.Collections.Generic.List[string]
  try {
    for ($index = 1; $index -lt $argumentCount; $index += 1) {
      $tokenPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr(
        $argumentsPointer,
        $index * [IntPtr]::Size
      )
      $tokens.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($tokenPointer))
    }
  } finally {
    [void][Asuka.NativeCommandLine]::LocalFree($argumentsPointer)
  }
  return $tokens.ToArray()
}

function Test-AsukaFullyQualifiedWindowsPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $false
  }
  return [bool](
    $Path -match '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))'
  )
}

function Test-AsukaPowerShellFileAction {
  param(
    [Parameter(Mandatory = $true)][object]$Action,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string]$AllowedWorkingDirectory = ""
  )

  try {
    $rawExecute = [string]$Action.execute
    $execute = $rawExecute.Trim()
    if (
      -not $rawExecute.Equals($execute, [StringComparison]::Ordinal) -or
      -not (Test-AsukaFullyQualifiedWindowsPath -Path $execute)
    ) {
      return $false
    }
    $trustedPowerShell = [IO.Path]::GetFullPath(
      (Join-Path $PSHOME "powershell.exe")
    )
    if (
      -not ([IO.Path]::GetFullPath($execute)).Equals(
        $trustedPowerShell,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      return $false
    }
    $rawWorkingDirectory = if (
      $Action.PSObject.Properties.Name -contains "workingDirectory"
    ) {
      [string]$Action.workingDirectory
    } else {
      ""
    }
    $workingDirectory = $rawWorkingDirectory.Trim()
    if (
      -not $rawWorkingDirectory.Equals(
        $workingDirectory,
        [StringComparison]::Ordinal
      )
    ) {
      return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($workingDirectory)) {
      if (
        [string]::IsNullOrWhiteSpace($AllowedWorkingDirectory) -or
        -not (
          Test-AsukaFullyQualifiedWindowsPath -Path $workingDirectory
        ) -or
        -not (
          Test-AsukaFullyQualifiedWindowsPath -Path $AllowedWorkingDirectory
        ) -or
        -not ([IO.Path]::GetFullPath($workingDirectory)).TrimEnd("\").Equals(
          ([IO.Path]::GetFullPath($AllowedWorkingDirectory)).TrimEnd("\"),
          [StringComparison]::OrdinalIgnoreCase
        )
      ) {
        return $false
      }
    }

    $tokens = @(ConvertFrom-AsukaTaskArguments -Arguments ([string]$Action.arguments))
    $fileIndexes = @()
    for ($index = 0; $index -lt $tokens.Count; $index += 1) {
      if ([string]$tokens[$index] -ieq "-File") {
        $fileIndexes += $index
      }
    }
    if ($fileIndexes.Count -ne 1) {
      return $false
    }

    $fileIndex = [int]$fileIndexes[0]
    if ($fileIndex + 1 -ne $tokens.Count - 1) {
      return $false
    }
    $actualScript = [string]$tokens[$fileIndex + 1]
    if (
      -not (Test-AsukaFullyQualifiedWindowsPath -Path $actualScript) -or
      -not $actualScript.Equals(
        [IO.Path]::GetFullPath($ScriptPath),
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      return $false
    }

    $cursor = 0
    $seenOptions = @{}
    while ($cursor -lt $fileIndex) {
      $option = [string]$tokens[$cursor]
      $optionKey = $option.ToLowerInvariant()
      if ($seenOptions.ContainsKey($optionKey)) {
        return $false
      }
      $seenOptions[$optionKey] = $true
      if (@("-NoProfile", "-NonInteractive") -contains $option) {
        $cursor += 1
        continue
      }
      if ($option -ieq "-ExecutionPolicy") {
        if (
          $cursor + 1 -ge $fileIndex -or
          [string]$tokens[$cursor + 1] -ine "Bypass"
        ) {
          return $false
        }
        $cursor += 2
        continue
      }
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

function Wait-AsukaTaskStopped {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$TaskPath = "",
    [int]$TimeoutSeconds = 30
  )

  $parameters = @{
    TaskName = $Name
    ErrorAction = "SilentlyContinue"
  }
  if (-not [string]::IsNullOrWhiteSpace($TaskPath)) {
    $parameters["TaskPath"] = $TaskPath
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $tasks = @(Get-ScheduledTask @parameters)
    if (
      $tasks.Count -eq 0 -or
      ($tasks.Count -eq 1 -and [string]$tasks[0].State -ne "Running")
    ) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Scheduled task did not stop within $TimeoutSeconds seconds: $Name"
}

function Wait-AsukaTaskRunning {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$TaskPath = "",
    [int]$TimeoutSeconds = 30
  )

  $parameters = @{
    TaskName = $Name
    ErrorAction = "SilentlyContinue"
  }
  if (-not [string]::IsNullOrWhiteSpace($TaskPath)) {
    $parameters["TaskPath"] = $TaskPath
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $tasks = @(Get-ScheduledTask @parameters)
    if ($tasks.Count -eq 1 -and [string]$tasks[0].State -eq "Running") {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Scheduled task did not start within $TimeoutSeconds seconds: $Name"
}

function Disable-AndStopAsukaTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$TaskPath = "",
    [int]$TimeoutSeconds = 30
  )

  $parameters = @{
    TaskName = $Name
  }
  if (-not [string]::IsNullOrWhiteSpace($TaskPath)) {
    if (-not (Test-AsukaScheduledTaskPath -Path $TaskPath)) {
      throw "Scheduled-task path is unsafe: $TaskPath"
    }
    $parameters["TaskPath"] = $TaskPath
  }
  Disable-ScheduledTask @parameters -ErrorAction Stop | Out-Null
  Stop-ScheduledTask @parameters -ErrorAction SilentlyContinue
  Wait-AsukaTaskStopped -Name $Name -TaskPath $TaskPath `
    -TimeoutSeconds $TimeoutSeconds
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
    $gatewayReady = $lastText -match "(?i)Gateway ready|\[gateway\] ready"
    $connectedMatches = [regex]::Matches(
      $lastText,
      "(?i)WebSocket connected|Session resumed|Ready with .* session:"
    )
    $disconnectedMatches = [regex]::Matches(
      $lastText,
      "(?i)WebSocket closed|WebSocket error|Invalid session|Connection failed|Server requested reconnect"
    )
    $lastConnectedIndex = if ($connectedMatches.Count -eq 0) {
      -1
    } else {
      $connectedMatches[$connectedMatches.Count - 1].Index
    }
    $lastDisconnectedIndex = if ($disconnectedMatches.Count -eq 0) {
      -1
    } else {
      $disconnectedMatches[$disconnectedMatches.Count - 1].Index
    }
    $socketReady = (
      $lastConnectedIndex -ge 0 -and
      $lastConnectedIndex -gt $lastDisconnectedIndex
    )
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
  if (
    -not (Test-AsukaScheduledTaskPath -Path ([string]$Snapshot.taskPath)) -or
    -not ($Snapshot.enabled -is [bool]) -or
    -not ($Snapshot.wasRunning -is [bool])
  ) {
    throw "Scheduled task snapshot has an invalid path or lifecycle contract."
  }
  $xml = [IO.File]::ReadAllText($XmlPath)
  Register-ScheduledTask -TaskName ([string]$Snapshot.name) `
    -TaskPath ([string]$Snapshot.taskPath) -Xml $xml -Force | Out-Null
  if ([bool]$Snapshot.enabled) {
    Enable-ScheduledTask -TaskName ([string]$Snapshot.name) `
      -TaskPath ([string]$Snapshot.taskPath) | Out-Null
  } else {
    Disable-ScheduledTask -TaskName ([string]$Snapshot.name) `
      -TaskPath ([string]$Snapshot.taskPath) | Out-Null
  }
}
