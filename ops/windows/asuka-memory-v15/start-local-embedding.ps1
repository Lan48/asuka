[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0

function Assert-StartupHost {
  if (
    [string]$PSVersionTable.PSEdition -cne "Desktop" -or
    [int]$PSVersionTable.PSVersion.Major -ne 5 -or
    [int]$PSVersionTable.PSVersion.Minor -ne 1 -or
    -not [Environment]::Is64BitProcess
  ) {
    throw "Use 64-bit Windows PowerShell 5.1."
  }
  $trustedPowerShell = Join-Path $env:SystemRoot `
    "System32\WindowsPowerShell\v1.0\powershell.exe"
  $currentPowerShell = (
    [Diagnostics.Process]::GetCurrentProcess()
  ).MainModule.FileName
  if (-not ([IO.Path]::GetFullPath($currentPowerShell)).Equals(
    [IO.Path]::GetFullPath($trustedPowerShell),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Use the trusted Windows PowerShell executable."
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ([string]$identity.User.Value -cne "S-1-5-18") {
    throw "Local embedding startup must run as SYSTEM."
  }
  return $trustedPowerShell
}

function Resolve-AppChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Relative
  )

  if ([IO.Path]::IsPathRooted($Relative)) {
    throw "AppRoot child path must be relative."
  }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  $pathRoot = [IO.Path]::GetPathRoot($rootFull)
  $current = $pathRoot
  foreach ($part in @($rootFull.Substring($pathRoot.Length).Trim("\") -split "\\")) {
    if (-not [string]::IsNullOrWhiteSpace($part)) {
      $current = Join-Path $current $part
    }
    if (
      (Test-Path -LiteralPath $current) -and
      (Get-Item -LiteralPath $current -Force).Attributes -band
        [IO.FileAttributes]::ReparsePoint
    ) {
      throw "AppRoot contains a reparse point."
    }
  }
  $candidate = [IO.Path]::GetFullPath(
    (Join-Path $rootFull $Relative.Replace("/", "\"))
  )
  if (-not $candidate.StartsWith(
    "$rootFull\",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Path escapes AppRoot."
  }
  $current = $rootFull
  foreach ($part in @($candidate.Substring($rootFull.Length).TrimStart("\") -split "\\")) {
    if (
      (Test-Path -LiteralPath $current) -and
      (Get-Item -LiteralPath $current -Force).Attributes -band
        [IO.FileAttributes]::ReparsePoint
    ) {
      throw "AppRoot child contains a reparse point."
    }
    $current = Join-Path $current $part
  }
  if (
    (Test-Path -LiteralPath $current) -and
    (Get-Item -LiteralPath $current -Force).Attributes -band
      [IO.FileAttributes]::ReparsePoint
  ) {
    throw "AppRoot child contains a reparse point."
  }
  return $candidate
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-ApplicableAuthenticode {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([IO.Path]::GetExtension($Path) -notin @(".exe", ".dll", ".sys")) {
    return
  }
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if (
    [string]$signature.Status -cne "Valid" -or
    $null -eq $signature.SignerCertificate
  ) {
    throw "Local embedding runtime has an invalid Authenticode signature."
  }
}

function Assert-PinnedOllama {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Contract
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Pinned Ollama executable is missing."
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (
    $item.Attributes -band [IO.FileAttributes]::ReparsePoint -or
    [int64]$item.Length -ne [int64]$Contract.ollama.executableBytes -or
    (Get-Sha256 -Path $Path) -cne [string]$Contract.ollama.executableSha256
  ) {
    throw "Ollama executable does not match the pinned release."
  }
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if (
    [string]$signature.Status -cne "Valid" -or
    $null -eq $signature.SignerCertificate -or
    [string]$signature.SignerCertificate.Subject -notmatch (
      "(^|,\s*)O=" +
      [regex]::Escape([string]$Contract.ollama.signerOrganization) +
      "(,|$)"
    )
  ) {
    throw "Ollama executable signer is not trusted."
  }
  $versionOutput = @(& $Path "--version" 2>&1) -join " "
  if (
    $LASTEXITCODE -ne 0 -or
    $versionOutput -notmatch (
      "(^|[^0-9.])" +
      [regex]::Escape([string]$Contract.ollama.version) +
      "([^0-9.]|$)"
    )
  ) {
    throw "Ollama executable version does not match the contract."
  }
}

function Assert-SourceModel {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Contract
  )

  if (
    -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
    [int64](Get-Item -LiteralPath $Path).Length -ne
      [int64]$Contract.model.sourceBytes -or
    (Get-Sha256 -Path $Path) -cne [string]$Contract.model.sourceSha256
  ) {
    throw "Pinned Jina GGUF failed its content contract."
  }
}

function Assert-Blob {
  param(
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [Parameter(Mandatory = $true)][object]$Descriptor
  )

  $digest = ([string]$Descriptor.digest).ToLowerInvariant()
  [int64]$bytes = 0
  if (
    $digest -notmatch "^sha256:[a-f0-9]{64}$" -or
    $null -eq $Descriptor.size -or
    -not [int64]::TryParse([string]$Descriptor.size, [ref]$bytes) -or
    $bytes -lt 0
  ) {
    throw "Ollama model manifest contains an invalid descriptor."
  }
  $sha = $digest.Substring(7)
  $path = Resolve-AppChildPath -Root $ModelRoot `
    -Relative ("blobs\sha256-{0}" -f $sha)
  if (
    -not (Test-Path -LiteralPath $path -PathType Leaf) -or
    [int64](Get-Item -LiteralPath $path).Length -ne $bytes -or
    (Get-Sha256 -Path $path) -cne $sha
  ) {
    throw "Ollama model blob failed its content-addressed integrity check."
  }
}

function Assert-OllamaModel {
  param(
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [Parameter(Mandatory = $true)][object]$Contract
  )

  $manifestPath = Resolve-AppChildPath -Root $ModelRoot `
    -Relative ([string]$Contract.model.ollamaManifest)
  if (
    -not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    [int64](Get-Item -LiteralPath $manifestPath).Length -ne
      [int64]$Contract.model.runtime.manifestBytes -or
    (Get-Sha256 -Path $manifestPath) -cne
      [string]$Contract.model.runtime.manifestSha256
  ) {
    throw "Pinned Ollama model manifest failed its content contract."
  }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Pinned Ollama model manifest is invalid."
  }
  if (
    [int]$manifest.schemaVersion -ne 2 -or
    [string]$manifest.mediaType -cne
      "application/vnd.docker.distribution.manifest.v2+json"
  ) {
    throw "Pinned Ollama model manifest schema is invalid."
  }
  $expectedConfig = $Contract.model.runtime.config
  if (
    [string]$manifest.config.mediaType -cne
      [string]$expectedConfig.mediaType -or
    [string]$manifest.config.digest -cne [string]$expectedConfig.digest -or
    [int64]$manifest.config.size -ne [int64]$expectedConfig.size
  ) {
    throw "Pinned Ollama model config descriptor is invalid."
  }
  Assert-Blob -ModelRoot $ModelRoot -Descriptor $expectedConfig
  $layers = @($manifest.layers)
  $expectedLayers = @($Contract.model.runtime.layers)
  if ($layers.Count -ne $expectedLayers.Count -or $layers.Count -lt 1) {
    throw "Pinned Ollama model manifest has an invalid layer count."
  }
  for ($index = 0; $index -lt $layers.Count; $index += 1) {
    $layer = $layers[$index]
    $expectedLayer = $expectedLayers[$index]
    if (
      [string]$layer.mediaType -cne [string]$expectedLayer.mediaType -or
      [string]$layer.digest -cne [string]$expectedLayer.digest -or
      [int64]$layer.size -ne [int64]$expectedLayer.size
    ) {
      throw "Pinned Ollama model layer descriptor is invalid."
    }
    Assert-Blob -ModelRoot $ModelRoot -Descriptor $expectedLayer
  }
}

function Get-OllamaRuntimeIntegrity {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
    throw "Protected Ollama runtime is missing."
  }
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Protected Ollama runtime contains a reparse point."
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force)) {
    if ($item.Name -notin @("ollama.exe", "lib")) {
      throw "Protected Ollama runtime contains an unexpected root item."
    }
  }
  $ollamaExe = Join-Path $rootFull "ollama.exe"
  $libRoot = Join-Path $rootFull "lib"
  if (
    -not (Test-Path -LiteralPath $ollamaExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $libRoot -PathType Container)
  ) {
    throw "Protected Ollama runtime is incomplete."
  }
  $ollamaItem = Get-Item -LiteralPath $ollamaExe -Force
  $libItem = Get-Item -LiteralPath $libRoot -Force
  if (
    $ollamaItem.Attributes -band [IO.FileAttributes]::ReparsePoint -or
    $libItem.Attributes -band [IO.FileAttributes]::ReparsePoint
  ) {
    throw "Protected Ollama runtime contains a reparse point."
  }
  $records = New-Object System.Collections.ArrayList
  [int64]$totalBytes = 0
  $pending = New-Object System.Collections.Stack
  $pending.Push($libRoot)
  $files = New-Object System.Collections.ArrayList
  [void]$files.Add($ollamaItem)
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Protected Ollama runtime contains a reparse point."
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } else {
        [void]$files.Add($item)
      }
    }
  }
  foreach ($file in @($files)) {
    Assert-ApplicableAuthenticode -Path $file.FullName
    $relative = $file.FullName.Substring($rootFull.Length).TrimStart("\").
      Replace("\", "/")
    $sha = Get-Sha256 -Path $file.FullName
    [void]$records.Add(("{0}`t{1}`t{2}" -f $sha, $file.Length, $relative))
    $totalBytes += [int64]$file.Length
  }
  [string[]]$sorted = @($records)
  [Array]::Sort($sorted, [StringComparer]::Ordinal)
  $payload = [Text.Encoding]::UTF8.GetBytes(($sorted -join "`n"))
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $treeSha256 = ([BitConverter]::ToString(
      $hasher.ComputeHash($payload)
    )).Replace("-", "").ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  return [pscustomobject]@{
    fileCount = $sorted.Count
    bytes = $totalBytes
    sha256 = $treeSha256
  }
}

function Assert-ProtectedAssetAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Protected local embedding assets cannot contain reparse points."
  }
  $acl = Get-Acl -LiteralPath $Path
  $administratorsSid = New-Object `
    Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $ownerSid = $acl.GetOwner(
    [Security.Principal.SecurityIdentifier]
  )
  if (
    -not $acl.AreAccessRulesProtected -or
    [string]$ownerSid.Value -cne [string]$administratorsSid.Value
  ) {
    throw "Protected local embedding asset owner or inheritance is unsafe."
  }
  $rules = @($acl.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))
  if ($rules.Count -ne 2) {
    throw "Protected local embedding asset DACL is not canonical."
  }
  $expectedInheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $seen = @{}
  foreach ($rule in $rules) {
    $sid = [string]$rule.IdentityReference.Value
    if (
      $sid -notin @("S-1-5-18", "S-1-5-32-544") -or
      $seen.ContainsKey($sid) -or
      $rule.AccessControlType -ne
        [Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne
        [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne $expectedInheritance -or
      $rule.PropagationFlags -ne
        [Security.AccessControl.PropagationFlags]::None -or
      $rule.IsInherited
    ) {
      throw "Protected local embedding asset DACL is not canonical."
    }
    $seen[$sid] = $true
  }
}

function Assert-ProtectedAssetTree {
  param([Parameter(Mandatory = $true)][string]$Root)

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Protected local embedding asset root is missing."
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Protected local embedding assets cannot contain reparse points."
  }
  $pending = New-Object System.Collections.Stack
  $pending.Push([IO.Path]::GetFullPath($Root))
  while ($pending.Count -gt 0) {
    $directory = [string]$pending.Pop()
    Assert-ProtectedAssetAcl -Path $directory
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Protected local embedding assets cannot contain reparse points."
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } else {
        Assert-ProtectedAssetAcl -Path $item.FullName
      }
    }
  }
}

function Assert-CanonicalTask {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$TrustedPowerShell,
    [Parameter(Mandatory = $true)][string]$StartScript,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $taskArguments = (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AppRoot "{1}"' -f
    $StartScript,
    $Root
  )
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath "\" `
    -ErrorAction SilentlyContinue
  if (
    $null -eq $task -or
    [string]$task.State -ne "Running" -or
    [string]$task.Principal.UserId -notin @("SYSTEM", "S-1-5-18") -or
    [string]$task.Principal.LogonType -cne "ServiceAccount" -or
    [string]$task.Principal.RunLevel -cne "Highest"
  ) {
    throw "$TaskName principal or runtime state is invalid."
  }
  $actions = @($task.Actions)
  if (
    $actions.Count -ne 1 -or
    [string]::IsNullOrWhiteSpace([string]$actions[0].Execute) -or
    -not [IO.Path]::IsPathRooted([string]$actions[0].Execute) -or
    -not ([IO.Path]::GetFullPath([string]$actions[0].Execute)).Equals(
      [IO.Path]::GetFullPath($TrustedPowerShell),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$actions[0].Arguments -cne $taskArguments -or
    [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or
    -not [IO.Path]::IsPathRooted(
      [string]$actions[0].WorkingDirectory
    ) -or
    -not ([IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory)).Equals(
      $Root,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "$TaskName action does not match the canonical runtime."
  }
}

function Wait-LoopbackListener {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process.HasExited) {
      throw "Pinned Ollama server exited before opening its listener."
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { [int]$_.LocalPort -eq 11434 })
    if ($listeners.Count -eq 0) {
      Start-Sleep -Milliseconds 250
      continue
    }
    if (
      $listeners.Count -ne 1 -or
      [string]$listeners[0].LocalAddress -notin @("127.0.0.1", "::1")
    ) {
      throw "Local embedding listener is not exclusively loopback."
    }
    $owner = Get-CimInstance Win32_Process -Filter (
      "ProcessId={0}" -f [int]$listeners[0].OwningProcess
    )
    if (
      $null -eq $owner -or
      [string]::IsNullOrWhiteSpace([string]$owner.ExecutablePath) -or
      [int]$listeners[0].OwningProcess -ne [int]$Process.Id -or
      -not ([IO.Path]::GetFullPath([string]$owner.ExecutablePath)).Equals(
        $Executable,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Local embedding listener is not owned by the pinned Ollama executable."
    }
    return
  }
  throw "Pinned Ollama server did not open its loopback listener."
}

$trustedPowerShell = Assert-StartupHost
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
if ($AppRoot.Equals(
  [IO.Path]::GetPathRoot($AppRoot).TrimEnd("\"),
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "AppRoot cannot be a volume root."
}
$embeddingRoot = Resolve-AppChildPath -Root $AppRoot -Relative "embedding"
$contractPath = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\local-embedding-contract.json"
$statePath = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\install-state.json"
$runtimeRoot = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\runtime"
$ollamaExe = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\runtime\ollama.exe"
$installedStart = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\start-local-embedding.ps1"
$logRoot = Resolve-AppChildPath -Root $AppRoot -Relative "embedding\logs"
$standardOutput = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\logs\ollama-embedding.out.log"
$standardError = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\logs\ollama-embedding.error.log"
Assert-ProtectedAssetAcl -Path $AppRoot
Assert-ProtectedAssetTree -Root $embeddingRoot
foreach ($path in @($standardOutput, $standardError)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Protected local embedding log is missing."
  }
}
try {
  $contract = Get-Content -LiteralPath $contractPath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
    ConvertFrom-Json -ErrorAction Stop
} catch {
  throw "Local embedding runtime state is invalid."
}
if (
  [int]$contract.schemaVersion -ne 1 -or
  [int]$state.schemaVersion -ne 2 -or
  [string]::IsNullOrWhiteSpace([string]$state.appRoot) -or
  -not [IO.Path]::IsPathRooted([string]$state.appRoot) -or
  -not ([IO.Path]::GetFullPath([string]$state.appRoot)).Equals(
    $AppRoot,
    [StringComparison]::OrdinalIgnoreCase
  ) -or
  [string]::IsNullOrWhiteSpace([string]$state.ollamaExe) -or
  -not [IO.Path]::IsPathRooted([string]$state.ollamaExe) -or
  -not ([IO.Path]::GetFullPath([string]$state.ollamaExe)).Equals(
    $ollamaExe,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Local embedding runtime state does not match AppRoot."
}
if (
  [string]::IsNullOrWhiteSpace($PSCommandPath) -or
  -not [IO.Path]::IsPathRooted($PSCommandPath) -or
  -not ([IO.Path]::GetFullPath($PSCommandPath)).Equals(
    $installedStart,
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Local embedding startup script is not the installed protected copy."
}
Assert-CanonicalTask -TaskName ([string]$contract.task.name) `
  -TrustedPowerShell $trustedPowerShell -StartScript $installedStart `
  -Root $AppRoot
$runtimeIntegrity = Get-OllamaRuntimeIntegrity -Root $runtimeRoot
if (
  [int]$state.runtime.fileCount -ne [int]$runtimeIntegrity.fileCount -or
  [int64]$state.runtime.bytes -ne [int64]$runtimeIntegrity.bytes -or
  [string]$state.runtime.sha256 -cne [string]$runtimeIntegrity.sha256
) {
  throw "Protected Ollama runtime failed its integrity manifest."
}
Assert-PinnedOllama -Path $ollamaExe -Contract $contract
$sourceModel = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.model.sourcePath)
$modelRoot = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.paths.ollamaModels)
Assert-ProtectedAssetTree -Root $modelRoot
Assert-SourceModel -Path $sourceModel -Contract $contract
Assert-OllamaModel -ModelRoot $modelRoot -Contract $contract
if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop |
  Where-Object { [int]$_.LocalPort -eq 11434 }).Count -ne 0) {
  throw "Port 11434 is already occupied."
}

$env:OLLAMA_MODELS = $modelRoot
$env:OLLAMA_HOST = "127.0.0.1:11434"
$env:OLLAMA_NO_CLOUD = "1"
$server = Start-Process -FilePath $ollamaExe -ArgumentList @("serve") `
  -RedirectStandardOutput $standardOutput -RedirectStandardError $standardError `
  -PassThru -WindowStyle Hidden
try {
  Wait-LoopbackListener -Executable $ollamaExe -Process $server `
    -TimeoutSeconds 30
  $server.WaitForExit()
  if ($server.ExitCode -ne 0) {
    throw "Pinned Ollama server failed."
  }
  throw "Pinned Ollama server exited unexpectedly."
} finally {
  if (-not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
    $server.WaitForExit()
  }
}
