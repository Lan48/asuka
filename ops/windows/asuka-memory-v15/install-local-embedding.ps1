[CmdletBinding()]
param(
  [string]$AppRoot = "D:\app\asuka",
  [string]$OllamaExe = "",
  [string]$ProxyUri = "",
  [int]$ReadyTimeoutSeconds = 120,
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0

function Read-EmbeddingContract {
  $path = Join-Path $PSScriptRoot "local-embedding-contract.json"
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Local embedding contract is missing."
  }
  try {
    return Get-Content -LiteralPath $path -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Local embedding contract is invalid."
  }
}

function Assert-SupportedPowerShell {
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
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (
    [string]$identity.User.Value -cne "S-1-5-18" -and
    -not $principal.IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator
    )
  ) {
    throw "Local embedding installation requires an elevated administrator."
  }
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
      throw "AppRoot contains a reparse point: $current"
    }
  }
  $candidate = [IO.Path]::GetFullPath(
    (Join-Path $rootFull $Relative.Replace("/", "\"))
  )
  if (-not $candidate.StartsWith(
    "$rootFull\",
    [StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Path escapes AppRoot: $Relative"
  }
  $current = $rootFull
  foreach ($part in @($candidate.Substring($rootFull.Length).TrimStart("\") -split "\\")) {
    if (
      (Test-Path -LiteralPath $current) -and
      (Get-Item -LiteralPath $current -Force).Attributes -band
        [IO.FileAttributes]::ReparsePoint
    ) {
      throw "AppRoot child contains a reparse point: $current"
    }
    $current = Join-Path $current $part
  }
  if (
    (Test-Path -LiteralPath $current) -and
    (Get-Item -LiteralPath $current -Force).Attributes -band
      [IO.FileAttributes]::ReparsePoint
  ) {
    throw "AppRoot child contains a reparse point: $current"
  }
  return $candidate
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-PinnedOllama {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Contract,
    [switch]$SkipVersionCheck
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
  if (-not $SkipVersionCheck) {
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
    throw "Ollama runtime has an invalid Authenticode signature."
  }
}

function Assert-SourceModel {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Contract
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Pinned Jina GGUF is missing."
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (
    [int64]$item.Length -ne [int64]$Contract.model.sourceBytes -or
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
  if ($digest -notmatch "^sha256:[a-f0-9]{64}$") {
    throw "Ollama model manifest contains an invalid digest."
  }
  [int64]$bytes = 0
  if (
    $null -eq $Descriptor.size -or
    -not [int64]::TryParse([string]$Descriptor.size, [ref]$bytes) -or
    $bytes -lt 0
  ) {
    throw "Ollama model manifest contains an invalid size."
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
  return $path
}

function Assert-OllamaModel {
  param(
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [Parameter(Mandatory = $true)][object]$Contract
  )

  $manifestPath = Resolve-AppChildPath -Root $ModelRoot `
    -Relative ([string]$Contract.model.ollamaManifest)
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Pinned Ollama model manifest is missing."
  }
  if (
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
  [void](Assert-Blob -ModelRoot $ModelRoot -Descriptor $expectedConfig)
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
    [void](Assert-Blob -ModelRoot $ModelRoot -Descriptor $expectedLayer)
  }
  return $manifestPath
}

function Get-OllamaRuntimeIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$AllowAdditionalRootItems
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
    throw "Ollama runtime directory is missing."
  }
  $rootItem = Get-Item -LiteralPath $rootFull -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Ollama runtime contains a reparse point."
  }
  if (-not $AllowAdditionalRootItems) {
    foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force)) {
      if ($item.Name -notin @("ollama.exe", "lib")) {
        throw "Ollama runtime contains an unexpected root item."
      }
    }
  }
  $ollamaExe = Join-Path $rootFull "ollama.exe"
  $libRoot = Join-Path $rootFull "lib"
  if (
    -not (Test-Path -LiteralPath $ollamaExe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $libRoot -PathType Container)
  ) {
    throw "Ollama runtime is incomplete."
  }
  $ollamaItem = Get-Item -LiteralPath $ollamaExe -Force
  $libItem = Get-Item -LiteralPath $libRoot -Force
  if (
    $ollamaItem.Attributes -band [IO.FileAttributes]::ReparsePoint -or
    $libItem.Attributes -band [IO.FileAttributes]::ReparsePoint
  ) {
    throw "Ollama runtime contains a reparse point."
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
        throw "Ollama runtime contains a reparse point."
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

function Get-ApiVersion {
  try {
    return [string](Invoke-RestMethod -Method Get `
      -Uri "http://127.0.0.1:11434/api/version" -TimeoutSec 2).version
  } catch {
    return ""
  }
}

function Assert-EmbeddingApi {
  param(
    [Parameter(Mandatory = $true)][object]$Contract,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $body = [ordered]@{
    model = [string]$Contract.model.name
    input = "asuka memory retrieval health check"
  } | ConvertTo-Json -Compress
  try {
    $response = Invoke-RestMethod -Method Post `
      -Uri ([string]$Contract.api.endpoint) -ContentType "application/json" `
      -Body $body -TimeoutSec $TimeoutSeconds
  } catch {
    throw "Local Jina embedding request failed."
  }
  $data = @($response.data)
  if (
    [string]$response.model -cne [string]$Contract.model.name -or
    $data.Count -ne 1
  ) {
    throw "Local Jina embedding response model is invalid."
  }
  $vector = @($data[0].embedding)
  if ($vector.Count -ne [int]$Contract.model.dimensions) {
    throw "Local Jina embedding dimension is invalid."
  }
  foreach ($value in $vector) {
    [double]$number = 0
    if (
      -not [double]::TryParse(
        [string]$value,
        [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
      ) -or
      [double]::IsNaN($number) -or
      [double]::IsInfinity($number)
    ) {
      throw "Local Jina embedding contains a non-finite value."
    }
  }
}

function Wait-EmbeddingApi {
  param(
    [Parameter(Mandatory = $true)][object]$Contract,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-ApiVersion) -ceq [string]$Contract.ollama.version) {
      try {
        Assert-EmbeddingApi -Contract $Contract -TimeoutSeconds 10
        return
      } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Local Jina embedding service did not become ready."
}

function Resolve-Proxy {
  param([string]$Requested)

  $selected = $Requested
  if ([string]::IsNullOrWhiteSpace($selected)) {
    try {
      $settings = Get-ItemProperty `
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" `
        -ErrorAction Stop
      $proxyEnabled = $settings.PSObject.Properties["ProxyEnable"]
      $proxyServer = $settings.PSObject.Properties["ProxyServer"]
    } catch {
      throw "Windows proxy settings could not be read safely."
    }
    if ($null -ne $proxyEnabled -and [int]$proxyEnabled.Value -eq 1) {
      if ($null -eq $proxyServer) {
        throw "Windows proxy settings could not be read safely."
      }
      $selected = [string]$proxyServer.Value
      if ($selected -notmatch "^[a-z]+://") {
        $selected = "http://$selected"
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($selected)) {
    return ""
  }
  try {
    $uri = New-Object Uri($selected)
  } catch {
    throw "ProxyUri is invalid."
  }
  if (
    $uri.Scheme -cne "http" -or
    $uri.Host -notin @("127.0.0.1", "localhost") -or
    $uri.Port -lt 1 -or
    $uri.Port -gt 65535 -or
    -not [string]::IsNullOrWhiteSpace($uri.UserInfo) -or
    $uri.AbsolutePath -cne "/" -or
    -not [string]::IsNullOrWhiteSpace($uri.Query) -or
    -not [string]::IsNullOrWhiteSpace($uri.Fragment)
  ) {
    throw "ProxyUri must be a loopback HTTP proxy."
  }
  return $uri.AbsoluteUri.TrimEnd("/")
}

function Assert-CurlCapability {
  $curlPath = Join-Path $env:SystemRoot "System32\curl.exe"
  if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) {
    throw "The trusted Windows curl.exe is unavailable."
  }
  $signature = Get-AuthenticodeSignature -FilePath $curlPath
  if (
    [string]$signature.Status -cne "Valid" -or
    $null -eq $signature.SignerCertificate
  ) {
    throw "The trusted Windows curl.exe signature is invalid."
  }
  $versionOutput = @(& $curlPath "--version" 2>&1) -join "`n"
  if (
    $LASTEXITCODE -ne 0 -or
    $versionOutput -notmatch "(?im)^Protocols:.*\bhttps\b"
  ) {
    throw "curl.exe does not provide HTTPS download capability."
  }
  $helpOutput = @(& $curlPath "--help" "all" 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe capability discovery failed."
  }
  foreach ($option in @(
    "--disable",
    "--fail",
    "--location",
    "--max-filesize",
    "--proto",
    "--proto-redir",
    "--retry",
    "--retry-all-errors",
    "--connect-timeout",
    "--continue-at",
    "--silent",
    "--show-error",
    "--speed-limit",
    "--speed-time",
    "--noproxy",
    "--output",
    "--proxy",
    "--write-out"
  )) {
    if (
      $helpOutput -notmatch (
        "(?m)(?:^|\s)" + [regex]::Escape($option) + "(?:[,\s=]|$)"
      )
    ) {
      throw "curl.exe does not provide the required download options."
    }
  }
  return $curlPath
}

function Stop-InstalledOllama {
  param([Parameter(Mandatory = $true)][string[]]$Executable)

  $roots = @($Executable | ForEach-Object {
    [IO.Path]::GetFullPath((Split-Path -Parent $_)).TrimEnd("\")
  } | Select-Object -Unique)
  foreach ($process in @(Get-CimInstance Win32_Process)) {
    if (
      [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
      [IO.Path]::GetExtension([string]$process.ExecutablePath) -ine ".exe"
    ) {
      continue
    }
    $processPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
    foreach ($root in $roots) {
      if ($processPath.StartsWith(
        "$root\",
        [StringComparison]::OrdinalIgnoreCase
      )) {
        Stop-Process -Id ([int]$process.ProcessId) -Force
        break
      }
    }
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not [string]::IsNullOrWhiteSpace((Get-ApiVersion))) {
    Start-Sleep -Milliseconds 250
  }
  if (-not [string]::IsNullOrWhiteSpace((Get-ApiVersion))) {
    throw "Existing Ollama service did not stop."
  }
}

function Set-ProtectedAssetAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Protected local embedding assets cannot contain reparse points."
  }
  $acl = if ($item.PSIsContainer) {
    New-Object Security.AccessControl.DirectorySecurity
  } else {
    New-Object Security.AccessControl.FileSecurity
  }
  $administratorsSid = New-Object `
    Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $systemSid = New-Object `
    Security.Principal.SecurityIdentifier("S-1-5-18")
  $acl.SetOwner($administratorsSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($sid in @($systemSid, $administratorsSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
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

function Invoke-ProtectedAssetTree {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet("Set", "Assert")]
      [string]$Operation
  )

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
    if ($Operation -ceq "Set") {
      Set-ProtectedAssetAcl -Path $directory
    } else {
      Assert-ProtectedAssetAcl -Path $directory
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Protected local embedding assets cannot contain reparse points."
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } elseif ($Operation -ceq "Set") {
        Set-ProtectedAssetAcl -Path $item.FullName
      } else {
        Assert-ProtectedAssetAcl -Path $item.FullName
      }
    }
  }
}

function Invoke-InstalledEmbeddingVerification {
  param(
    [Parameter(Mandatory = $true)][string]$TrustedPowerShell,
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )

  $arguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $Installer,
    "-AppRoot",
    $Root,
    "-ReadyTimeoutSeconds",
    [string]$TimeoutSeconds,
    "-VerifyOnly"
  )
  $output = @(& $TrustedPowerShell @arguments 2>&1)
  if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) {
    throw "Final local embedding verification failed."
  }
  $text = [string]$output[0]
  try {
    $verification = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Final local embedding verification returned invalid JSON."
  }
  if (
    $null -eq $verification -or
    -not ($verification.ok -is [bool]) -or
    -not [bool]$verification.ok -or
    [string]$verification.operation -cne "verify-local-embedding" -or
    [string]$verification.runtimeSha256 -cnotmatch "^[a-f0-9]{64}$"
  ) {
    throw "Final local embedding verification returned an invalid result."
  }
  return $text
}

Assert-SupportedPowerShell
$contract = Read-EmbeddingContract
if ([int]$contract.schemaVersion -ne 1) {
  throw "Unsupported local embedding contract."
}
if ($ReadyTimeoutSeconds -lt 10 -or $ReadyTimeoutSeconds -gt 600) {
  throw "ReadyTimeoutSeconds must be between 10 and 600."
}
$AppRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd("\")
if ($AppRoot.Equals(
  [IO.Path]::GetPathRoot($AppRoot).TrimEnd("\"),
  [StringComparison]::OrdinalIgnoreCase
)) {
  throw "AppRoot cannot be a volume root."
}
$embeddingRoot = Resolve-AppChildPath -Root $AppRoot -Relative "embedding"
$modelsRoot = Resolve-AppChildPath -Root $AppRoot -Relative "models"
$statePath = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.paths.state)
$sourceModel = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.model.sourcePath)
$sourceModelPartial = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("{0}.partial" -f [string]$contract.model.sourcePath)
$modelRoot = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.paths.ollamaModels)
$runtimeRoot = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\runtime"
$installedOllama = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\runtime\ollama.exe"
$installedStart = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.paths.startScript)
$installedContract = Resolve-AppChildPath -Root $AppRoot `
  -Relative ([string]$contract.paths.contract)
$logRoot = Resolve-AppChildPath -Root $AppRoot -Relative "embedding\logs"
$standardOutput = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\logs\ollama-embedding.out.log"
$standardError = Resolve-AppChildPath -Root $AppRoot `
  -Relative "embedding\logs\ollama-embedding.error.log"
$sourceStart = Join-Path $PSScriptRoot "start-local-embedding.ps1"
$sourceContract = Join-Path $PSScriptRoot "local-embedding-contract.json"
$taskName = [string]$contract.task.name
$trustedPowerShell = Join-Path $env:SystemRoot `
  "System32\WindowsPowerShell\v1.0\powershell.exe"
$taskArguments = (
  '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -AppRoot "{1}"' -f
  $installedStart,
  $AppRoot
)

if ($VerifyOnly) {
  Assert-ProtectedAssetAcl -Path $AppRoot
  Invoke-ProtectedAssetTree -Root $embeddingRoot -Operation "Assert"
  Invoke-ProtectedAssetTree -Root $modelsRoot -Operation "Assert"
  foreach ($path in @($standardOutput, $standardError)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Protected local embedding log is missing."
    }
  }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Local embedding installation state is invalid."
  }
  if (
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
      $installedOllama,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Local embedding installation state does not match AppRoot."
  }
  $runtimeIntegrity = Get-OllamaRuntimeIntegrity -Root $runtimeRoot
  if (
    [int]$state.runtime.fileCount -ne [int]$runtimeIntegrity.fileCount -or
    [int64]$state.runtime.bytes -ne [int64]$runtimeIntegrity.bytes -or
    [string]$state.runtime.sha256 -cne [string]$runtimeIntegrity.sha256
  ) {
    throw "Protected Ollama runtime failed its integrity manifest."
  }
  Assert-PinnedOllama -Path $installedOllama -Contract $contract
  Assert-SourceModel -Path $sourceModel -Contract $contract
  [void](Assert-OllamaModel -ModelRoot $modelRoot -Contract $contract)
  if (
    -not (Test-Path -LiteralPath $installedStart -PathType Leaf) -or
    -not (Test-Path -LiteralPath $installedContract -PathType Leaf) -or
    (Get-Sha256 -Path $installedStart) -cne (Get-Sha256 -Path $sourceStart) -or
    (Get-Sha256 -Path $installedContract) -cne (Get-Sha256 -Path $sourceContract)
  ) {
    throw "Installed local embedding runtime assets do not match the release."
  }
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
    -ErrorAction SilentlyContinue
  if (
    $null -eq $task -or
    [string]$task.State -ne "Running" -or
    [string]$task.Principal.UserId -notin @("SYSTEM", "S-1-5-18") -or
    [string]$task.Principal.LogonType -cne "ServiceAccount" -or
    [string]$task.Principal.RunLevel -cne "Highest"
  ) {
    throw "$taskName principal or runtime state is invalid."
  }
  $actions = @($task.Actions)
  if (
    $actions.Count -ne 1 -or
    [string]::IsNullOrWhiteSpace([string]$actions[0].Execute) -or
    -not [IO.Path]::IsPathRooted([string]$actions[0].Execute) -or
    -not ([IO.Path]::GetFullPath([string]$actions[0].Execute)).Equals(
      [IO.Path]::GetFullPath($trustedPowerShell),
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    [string]$actions[0].Arguments -cne $taskArguments -or
    [string]::IsNullOrWhiteSpace([string]$actions[0].WorkingDirectory) -or
    -not [IO.Path]::IsPathRooted(
      [string]$actions[0].WorkingDirectory
    ) -or
    -not ([IO.Path]::GetFullPath([string]$actions[0].WorkingDirectory)).Equals(
      $AppRoot,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "$taskName action does not match the canonical runtime."
  }
  $listeners = @(Get-NetTCPConnection -LocalPort 11434 -State Listen)
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
    -not ([IO.Path]::GetFullPath([string]$owner.ExecutablePath)).Equals(
      $installedOllama,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Local embedding listener is not owned by the pinned Ollama executable."
  }
  if ((Get-ApiVersion) -cne [string]$contract.ollama.version) {
    throw "Local Ollama API version does not match the contract."
  }
  Assert-EmbeddingApi -Contract $contract -TimeoutSeconds 10
  [pscustomobject]@{
    ok = $true
    operation = "verify-local-embedding"
    task = $taskName
    ollamaVersion = [string]$contract.ollama.version
    model = [string]$contract.model.name
    dimensions = [int]$contract.model.dimensions
    sourceSha256 = [string]$contract.model.sourceSha256
    runtimeSha256 = [string]$runtimeIntegrity.sha256
  } | ConvertTo-Json -Compress
  exit 0
}

$proxy = Resolve-Proxy -Requested $ProxyUri
$curlPath = Assert-CurlCapability
if ([string]::IsNullOrWhiteSpace($OllamaExe)) {
  $OllamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
}
$OllamaExe = [IO.Path]::GetFullPath($OllamaExe)
Assert-PinnedOllama -Path $OllamaExe -Contract $contract -SkipVersionCheck
$sourceRuntimeRoot = Split-Path -Parent $OllamaExe
$sourceRuntimeIntegrity = Get-OllamaRuntimeIntegrity `
  -Root $sourceRuntimeRoot -AllowAdditionalRootItems
if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
  Invoke-ProtectedAssetTree -Root $runtimeRoot -Operation "Assert"
}

if (-not (Test-Path -LiteralPath $AppRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $AppRoot | Out-Null
}
Set-ProtectedAssetAcl -Path $AppRoot
Assert-ProtectedAssetAcl -Path $AppRoot
foreach ($directory in @(
  $embeddingRoot,
  $logRoot,
  $modelsRoot,
  (Split-Path -Parent $sourceModel)
)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
Invoke-ProtectedAssetTree -Root $embeddingRoot -Operation "Set"
Invoke-ProtectedAssetTree -Root $modelsRoot -Operation "Set"

if (-not (Test-Path -LiteralPath $sourceModel -PathType Leaf)) {
  $resumeDownload = Test-Path -LiteralPath $sourceModelPartial -PathType Leaf
  if (Test-Path -LiteralPath $sourceModelPartial) {
    $partialItem = Get-Item -LiteralPath $sourceModelPartial -Force
    if (
      $partialItem.PSIsContainer -or
      $partialItem.Attributes -band [IO.FileAttributes]::ReparsePoint
    ) {
      throw "Pinned Jina GGUF partial download is invalid."
    }
    if ([int64]$partialItem.Length -gt [int64]$contract.model.sourceBytes) {
      Remove-Item -LiteralPath $sourceModelPartial -Force -ErrorAction Stop
      throw "Pinned Jina GGUF partial download exceeded its size limit."
    }
  }
  $arguments = @(
    "--disable", "--fail", "--location", "--silent", "--show-error",
    "--proto", "=https", "--proto-redir", "=https",
    "--retry", "3", "--retry-all-errors",
    "--connect-timeout", "20",
    "--max-filesize", ([string]$contract.model.sourceBytes),
    "--speed-limit", "1024", "--speed-time", "30",
    "--output", $sourceModelPartial,
    "--write-out", "%{http_code}"
  )
  if ($resumeDownload) {
    $arguments += @("--continue-at", "-")
  }
  if (-not [string]::IsNullOrWhiteSpace($proxy)) {
    $arguments += @("--proxy", $proxy, "--noproxy", "")
  } else {
    $arguments += @("--noproxy", "*")
  }
  $arguments += @([string]$contract.model.sourceUrl)
  $httpStatus = [string](& $curlPath @arguments)
  $downloadExitCode = $LASTEXITCODE
  if (
    $resumeDownload -and
    ($downloadExitCode -eq 33 -or $httpStatus -ceq "416")
  ) {
    Write-Warning "The server rejected the partial range; restarting this download."
    Remove-Item -LiteralPath $sourceModelPartial -Force
    $arguments = @($arguments | Where-Object {
      [string]$_ -cne "--continue-at" -and [string]$_ -cne "-"
    })
    $httpStatus = [string](& $curlPath @arguments)
    $downloadExitCode = $LASTEXITCODE
  }
  if ($downloadExitCode -ne 0) {
    if (
      $downloadExitCode -eq 63 -and
      (Test-Path -LiteralPath $sourceModelPartial -PathType Leaf)
    ) {
      $failedPartial = Get-Item -LiteralPath $sourceModelPartial -Force
      if (-not (
        $failedPartial.Attributes -band [IO.FileAttributes]::ReparsePoint
      )) {
        Remove-Item -LiteralPath $sourceModelPartial -Force -ErrorAction Stop
      }
    }
    throw "Pinned Jina GGUF download failed."
  }
  try {
    Assert-SourceModel -Path $sourceModelPartial -Contract $contract
  } catch {
    $validationFailure = $_
    try {
      Remove-Item -LiteralPath $sourceModelPartial -Force -ErrorAction Stop
    } catch {
      throw "Pinned Jina GGUF partial download could not be discarded."
    }
    throw $validationFailure
  }
  Move-Item -LiteralPath $sourceModelPartial -Destination $sourceModel
}
Assert-SourceModel -Path $sourceModel -Contract $contract

$existingTasks = @(Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
  -ErrorAction SilentlyContinue)
if ($existingTasks.Count -gt 1) {
  throw "Local embedding task lookup returned more than one task."
}
$hadExistingTask = $existingTasks.Count -eq 1
$existingTaskXml = ""
$existingTaskEnabled = $false
$existingTaskRunning = $false
if ($hadExistingTask) {
  $existingTask = $existingTasks[0]
  $existingTaskXml = [string](Export-ScheduledTask -TaskName $taskName `
    -TaskPath "\" -ErrorAction Stop)
  if ([string]::IsNullOrWhiteSpace($existingTaskXml)) {
    throw "Existing local embedding task could not be exported."
  }
  $existingTaskEnabled = [bool]$existingTask.Settings.Enabled
  $existingTaskRunning = [string]$existingTask.State -ceq "Running"
}

foreach ($path in @($runtimeRoot, $modelRoot)) {
  if (
    (Test-Path -LiteralPath $path) -and
    -not (Test-Path -LiteralPath $path -PathType Container)
  ) {
    throw "Local embedding active root is not a directory: $path"
  }
}
$hadRuntimeRoot = Test-Path -LiteralPath $runtimeRoot -PathType Container
$hadModelRoot = Test-Path -LiteralPath $modelRoot -PathType Container
$hadInstalledStart = Test-Path -LiteralPath $installedStart -PathType Leaf
$hadInstalledContract = Test-Path -LiteralPath $installedContract -PathType Leaf
$hadState = Test-Path -LiteralPath $statePath -PathType Leaf
$hadStandardOutput = Test-Path -LiteralPath $standardOutput -PathType Leaf
$hadStandardError = Test-Path -LiteralPath $standardError -PathType Leaf
foreach ($path in @($installedStart, $installedContract, $statePath)) {
  if (
    (Test-Path -LiteralPath $path) -and
    -not (Test-Path -LiteralPath $path -PathType Leaf)
  ) {
    throw "Local embedding installed asset is not a file: $path"
  }
}

$transactionId = [Guid]::NewGuid().ToString("N")
$transactionRoot = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("embedding\transaction.{0}" -f $transactionId)
$runtimeNext = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("embedding\runtime.next.{0}" -f $transactionId)
$runtimePrevious = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("embedding\runtime.previous.{0}" -f $transactionId)
$modelNext = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("{0}.next.{1}" -f [string]$contract.paths.ollamaModels, $transactionId)
$modelPrevious = Resolve-AppChildPath -Root $AppRoot `
  -Relative ("{0}.previous.{1}" -f [string]$contract.paths.ollamaModels, $transactionId)
$runtimePartial = Join-Path $runtimeNext "ollama.exe"
$fileSnapshots = @(
  [pscustomobject]@{
    Path = $installedStart
    Backup = Join-Path $transactionRoot "start-local-embedding.ps1"
    Existed = $hadInstalledStart
  },
  [pscustomobject]@{
    Path = $installedContract
    Backup = Join-Path $transactionRoot "local-embedding-contract.json"
    Existed = $hadInstalledContract
  },
  [pscustomobject]@{
    Path = $statePath
    Backup = Join-Path $transactionRoot "install-state.json"
    Existed = $hadState
  }
)
$verificationOutput = ""
$installedFilesMutated = $false
$logsTouched = $false

try {
  if ($hadExistingTask) {
    Stop-ScheduledTask -TaskName $taskName -TaskPath "\" `
      -ErrorAction SilentlyContinue
  }
  Stop-InstalledOllama -Executable @($OllamaExe, $installedOllama)

  New-Item -ItemType Directory -Path $transactionRoot | Out-Null
  foreach ($snapshot in $fileSnapshots) {
    if ([bool]$snapshot.Existed) {
      Copy-Item -LiteralPath ([string]$snapshot.Path) `
        -Destination ([string]$snapshot.Backup) -Force
    }
  }

  New-Item -ItemType Directory -Path $runtimeNext | Out-Null
  Copy-Item -LiteralPath $OllamaExe -Destination $runtimePartial -Force
  Copy-Item -LiteralPath (Join-Path $sourceRuntimeRoot "lib") `
    -Destination (Join-Path $runtimeNext "lib") -Recurse -Force
  Invoke-ProtectedAssetTree -Root $runtimeNext -Operation "Set"
  $copiedRuntimeIntegrity = Get-OllamaRuntimeIntegrity -Root $runtimeNext
  if (
    [int]$copiedRuntimeIntegrity.fileCount -ne
      [int]$sourceRuntimeIntegrity.fileCount -or
    [int64]$copiedRuntimeIntegrity.bytes -ne
      [int64]$sourceRuntimeIntegrity.bytes -or
    [string]$copiedRuntimeIntegrity.sha256 -cne
      [string]$sourceRuntimeIntegrity.sha256
  ) {
    throw "Protected Ollama runtime copy failed its integrity check."
  }
  Assert-PinnedOllama -Path $runtimePartial -Contract $contract

  New-Item -ItemType Directory -Path $modelNext | Out-Null
  Set-ProtectedAssetAcl -Path $modelNext
  $modelfile = Join-Path $transactionRoot "Modelfile"
  [IO.File]::WriteAllText(
    $modelfile,
    "FROM `"$sourceModel`"`r`n",
    (New-Object Text.UTF8Encoding($false))
  )
  $previousModels = [Environment]::GetEnvironmentVariable(
    "OLLAMA_MODELS",
    [EnvironmentVariableTarget]::Process
  )
  $previousHost = [Environment]::GetEnvironmentVariable(
    "OLLAMA_HOST",
    [EnvironmentVariableTarget]::Process
  )
  $previousNoCloud = [Environment]::GetEnvironmentVariable(
    "OLLAMA_NO_CLOUD",
    [EnvironmentVariableTarget]::Process
  )
  $candidateServer = $null
  try {
    $env:OLLAMA_MODELS = $modelNext
    $env:OLLAMA_HOST = "127.0.0.1:11434"
    $env:OLLAMA_NO_CLOUD = "1"
    $candidateServer = Start-Process -FilePath $runtimePartial `
      -ArgumentList @("serve") -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    while (
      (Get-Date) -lt $deadline -and
      (Get-ApiVersion) -cne [string]$contract.ollama.version
    ) {
      if ($candidateServer.HasExited) {
        throw "Temporary Ollama server exited before becoming ready."
      }
      Start-Sleep -Milliseconds 500
    }
    if ((Get-ApiVersion) -cne [string]$contract.ollama.version) {
      throw "Temporary Ollama server did not become ready."
    }
    if ($candidateServer.HasExited) {
      throw "Temporary Ollama server exited before model import."
    }
    $candidateListeners = @(
      Get-NetTCPConnection -LocalPort 11434 -State Listen
    )
    if (
      $candidateListeners.Count -ne 1 -or
      [string]$candidateListeners[0].LocalAddress -notin @("127.0.0.1", "::1")
    ) {
      throw "Temporary Ollama listener is not exclusively loopback."
    }
    $candidateOwner = Get-CimInstance Win32_Process -Filter (
      "ProcessId={0}" -f [int]$candidateListeners[0].OwningProcess
    )
    if (
      $null -eq $candidateOwner -or
      [string]::IsNullOrWhiteSpace([string]$candidateOwner.ExecutablePath) -or
      -not ([IO.Path]::GetFullPath(
        [string]$candidateOwner.ExecutablePath
      )).Equals(
        [IO.Path]::GetFullPath($runtimePartial),
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Temporary Ollama listener is not owned by the candidate runtime."
    }
    & $runtimePartial "create" ([string]$contract.model.name) "-f" $modelfile
    if ($LASTEXITCODE -ne 0) {
      throw "Pinned Jina Ollama import failed."
    }
    [void](Assert-OllamaModel -ModelRoot $modelNext -Contract $contract)
    Assert-EmbeddingApi -Contract $contract -TimeoutSeconds $ReadyTimeoutSeconds
  } finally {
    try {
      if ($null -ne $candidateServer -and -not $candidateServer.HasExited) {
        Stop-Process -Id $candidateServer.Id -Force
        $candidateServer.WaitForExit()
      }
    } finally {
      [Environment]::SetEnvironmentVariable(
        "OLLAMA_MODELS",
        $previousModels,
        [EnvironmentVariableTarget]::Process
      )
      [Environment]::SetEnvironmentVariable(
        "OLLAMA_HOST",
        $previousHost,
        [EnvironmentVariableTarget]::Process
      )
      [Environment]::SetEnvironmentVariable(
        "OLLAMA_NO_CLOUD",
        $previousNoCloud,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
  Invoke-ProtectedAssetTree -Root $modelNext -Operation "Set"
  [void](Assert-OllamaModel -ModelRoot $modelNext -Contract $contract)

  if ($hadRuntimeRoot) {
    Move-Item -LiteralPath $runtimeRoot -Destination $runtimePrevious
  }
  Move-Item -LiteralPath $runtimeNext -Destination $runtimeRoot
  if ($hadModelRoot) {
    Move-Item -LiteralPath $modelRoot -Destination $modelPrevious
  }
  Move-Item -LiteralPath $modelNext -Destination $modelRoot

  $runtimeIntegrity = Get-OllamaRuntimeIntegrity -Root $runtimeRoot
  Assert-PinnedOllama -Path $installedOllama -Contract $contract
  $installedFilesMutated = $true
  Copy-Item -LiteralPath $sourceStart -Destination $installedStart -Force
  Copy-Item -LiteralPath $sourceContract -Destination $installedContract -Force
  $state = [ordered]@{
    schemaVersion = 2
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    appRoot = $AppRoot
    ollamaExe = $installedOllama
    ollamaSha256 = Get-Sha256 -Path $installedOllama
    runtime = [ordered]@{
      fileCount = [int]$runtimeIntegrity.fileCount
      bytes = [int64]$runtimeIntegrity.bytes
      sha256 = [string]$runtimeIntegrity.sha256
    }
    model = [string]$contract.model.name
    sourceSha256 = [string]$contract.model.sourceSha256
  }
  $stateNext = Join-Path $transactionRoot "install-state.next.json"
  [IO.File]::WriteAllText(
    $stateNext,
    ($state | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $stateNext -Destination $statePath -Force
  $logsTouched = $true
  foreach ($path in @($standardOutput, $standardError)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      New-Item -ItemType File -Path $path | Out-Null
    }
  }
  Invoke-ProtectedAssetTree -Root $embeddingRoot -Operation "Set"
  Invoke-ProtectedAssetTree -Root $modelsRoot -Operation "Set"

  $action = New-ScheduledTaskAction -Execute $trustedPowerShell `
    -Argument $taskArguments -WorkingDirectory $AppRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" `
    -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -TaskPath "\" -Action $action `
    -Trigger $trigger -Principal $principal -Settings $settings -Force |
    Out-Null
  Start-ScheduledTask -TaskName $taskName -TaskPath "\"
  Wait-EmbeddingApi -Contract $contract -TimeoutSeconds $ReadyTimeoutSeconds
  $verificationOutput = Invoke-InstalledEmbeddingVerification `
    -TrustedPowerShell $trustedPowerShell -Installer $PSCommandPath `
    -Root $AppRoot -TimeoutSeconds $ReadyTimeoutSeconds
} catch {
  $installationFailure = $_
  $rollbackErrors = @()

  try {
    $currentTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
      -ErrorAction SilentlyContinue
    if ($null -ne $currentTask) {
      Stop-ScheduledTask -TaskName $taskName -TaskPath "\" `
        -ErrorAction SilentlyContinue
    }
    Stop-InstalledOllama -Executable @(
      $OllamaExe,
      $installedOllama,
      $runtimePartial
    )
  } catch {
    $rollbackErrors += "stop: $($_.Exception.Message)"
  }

  foreach ($rootKind in @("runtime", "model")) {
    try {
      $activeRoot = if ($rootKind -ceq "runtime") {
        $runtimeRoot
      } else {
        $modelRoot
      }
      $previousRoot = if ($rootKind -ceq "runtime") {
        $runtimePrevious
      } else {
        $modelPrevious
      }
      $nextRoot = if ($rootKind -ceq "runtime") {
        $runtimeNext
      } else {
        $modelNext
      }
      $hadActiveRoot = if ($rootKind -ceq "runtime") {
        $hadRuntimeRoot
      } else {
        $hadModelRoot
      }
      if (Test-Path -LiteralPath $previousRoot -PathType Container) {
        if (Test-Path -LiteralPath $activeRoot) {
          Remove-Item -LiteralPath $activeRoot -Recurse -Force
        }
        Move-Item -LiteralPath $previousRoot -Destination $activeRoot
      } elseif (-not $hadActiveRoot -and (Test-Path -LiteralPath $activeRoot)) {
        Remove-Item -LiteralPath $activeRoot -Recurse -Force
      }
      if (Test-Path -LiteralPath $nextRoot) {
        Remove-Item -LiteralPath $nextRoot -Recurse -Force
      }
    } catch {
      $rollbackErrors += "$($rootKind) root: $($_.Exception.Message)"
    }
  }

  if ($installedFilesMutated) {
    foreach ($snapshot in $fileSnapshots) {
      try {
        if ([bool]$snapshot.Existed) {
          if (-not (Test-Path -LiteralPath ([string]$snapshot.Backup) -PathType Leaf)) {
            throw "Installed asset backup is missing: $($snapshot.Path)"
          }
          Copy-Item -LiteralPath ([string]$snapshot.Backup) `
            -Destination ([string]$snapshot.Path) -Force
        } elseif (Test-Path -LiteralPath ([string]$snapshot.Path)) {
          Remove-Item -LiteralPath ([string]$snapshot.Path) -Force
        }
      } catch {
        $rollbackErrors += "file $($snapshot.Path): $($_.Exception.Message)"
      }
    }
  }
  try {
    if ($logsTouched) {
      if (-not $hadStandardOutput -and (Test-Path -LiteralPath $standardOutput)) {
        Remove-Item -LiteralPath $standardOutput -Force
      }
      if (-not $hadStandardError -and (Test-Path -LiteralPath $standardError)) {
        Remove-Item -LiteralPath $standardError -Force
      }
    }
  } catch {
    $rollbackErrors += "transaction files: $($_.Exception.Message)"
  }

  try {
    Set-ProtectedAssetAcl -Path $AppRoot
    if (Test-Path -LiteralPath $embeddingRoot -PathType Container) {
      Invoke-ProtectedAssetTree -Root $embeddingRoot -Operation "Set"
    }
    if (Test-Path -LiteralPath $modelsRoot -PathType Container) {
      Invoke-ProtectedAssetTree -Root $modelsRoot -Operation "Set"
    }
  } catch {
    $rollbackErrors += "acl: $($_.Exception.Message)"
  }

  $restoredContract = $null
  $restoredOllama = ""
  $restoredAssetsVerified = $false
  try {
    if ($hadExistingTask) {
      if (
        -not $hadRuntimeRoot -or
        -not $hadInstalledStart -or
        -not $hadInstalledContract -or
        -not $hadState
      ) {
        throw "The previous local embedding installation was incomplete."
      }
      $restoredContract = Get-Content -LiteralPath $installedContract `
        -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
      $restoredState = Get-Content -LiteralPath $statePath `
        -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
      $restoredRuntimeIntegrity = Get-OllamaRuntimeIntegrity -Root $runtimeRoot
      if (
        [int]$restoredState.runtime.fileCount -ne
          [int]$restoredRuntimeIntegrity.fileCount -or
        [int64]$restoredState.runtime.bytes -ne
          [int64]$restoredRuntimeIntegrity.bytes -or
        [string]$restoredState.runtime.sha256 -cne
          [string]$restoredRuntimeIntegrity.sha256
      ) {
        throw "Restored Ollama runtime failed its integrity manifest."
      }
      $restoredOllama = Join-Path $runtimeRoot "ollama.exe"
      $restoredSourceModel = Resolve-AppChildPath -Root $AppRoot `
        -Relative ([string]$restoredContract.model.sourcePath)
      $restoredModelRoot = Resolve-AppChildPath -Root $AppRoot `
        -Relative ([string]$restoredContract.paths.ollamaModels)
      Assert-PinnedOllama -Path $restoredOllama `
        -Contract $restoredContract
      Assert-SourceModel -Path $restoredSourceModel `
        -Contract $restoredContract
      [void](Assert-OllamaModel -ModelRoot $restoredModelRoot `
        -Contract $restoredContract)
      $restoredAssetsVerified = $true
    }
  } catch {
    $rollbackErrors += "verification: $($_.Exception.Message)"
  }

  try {
    if ($hadExistingTask) {
      Register-ScheduledTask -TaskName $taskName -TaskPath "\" `
        -Xml $existingTaskXml -Force | Out-Null
      if ($existingTaskRunning) {
        if (-not $restoredAssetsVerified) {
          throw "Restored local embedding assets are not verified."
        }
        Enable-ScheduledTask -TaskName $taskName -TaskPath "\" | Out-Null
        Start-ScheduledTask -TaskName $taskName -TaskPath "\"
        Wait-EmbeddingApi -Contract $restoredContract `
          -TimeoutSeconds $ReadyTimeoutSeconds
        Assert-EmbeddingApi -Contract $restoredContract `
          -TimeoutSeconds $ReadyTimeoutSeconds
        $runningTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
          -ErrorAction Stop
        if ([string]$runningTask.State -cne "Running") {
          throw "Restored local embedding task did not remain running."
        }
        $restoredListeners = @(
          Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction Stop
        )
        if (
          $restoredListeners.Count -ne 1 -or
          [string]$restoredListeners[0].LocalAddress -notin @(
            "127.0.0.1",
            "::1"
          )
        ) {
          throw "Restored local embedding listener is not exclusively loopback."
        }
        $restoredOwner = Get-CimInstance Win32_Process -Filter (
          "ProcessId={0}" -f [int]$restoredListeners[0].OwningProcess
        )
        if (
          $null -eq $restoredOwner -or
          [string]::IsNullOrWhiteSpace(
            [string]$restoredOwner.ExecutablePath
          ) -or
          -not ([IO.Path]::GetFullPath(
            [string]$restoredOwner.ExecutablePath
          )).Equals(
            [IO.Path]::GetFullPath($restoredOllama),
            [StringComparison]::OrdinalIgnoreCase
          )
        ) {
          throw "Restored local embedding listener has the wrong owner."
        }
      }
      if ($existingTaskEnabled) {
        Enable-ScheduledTask -TaskName $taskName -TaskPath "\" | Out-Null
      } else {
        Disable-ScheduledTask -TaskName $taskName -TaskPath "\" | Out-Null
      }
      $restoredTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
        -ErrorAction Stop
      if (
        [bool]$restoredTask.Settings.Enabled -ne $existingTaskEnabled -or
        (
          ([string]$restoredTask.State -ceq "Running") -ne
            $existingTaskRunning
        )
      ) {
        throw "Restored local embedding task lifecycle does not match."
      }
    } else {
      $currentTask = Get-ScheduledTask -TaskName $taskName -TaskPath "\" `
        -ErrorAction SilentlyContinue
      if ($null -ne $currentTask) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath "\" `
          -Confirm:$false
      }
    }
  } catch {
    $rollbackErrors += "task: $($_.Exception.Message)"
  }

  if ($rollbackErrors.Count -eq 0 -and (Test-Path -LiteralPath $transactionRoot)) {
    try {
      Remove-Item -LiteralPath $transactionRoot -Recurse -Force
    } catch {
      $rollbackErrors += "transaction cleanup: $($_.Exception.Message)"
    }
  }
  if ($rollbackErrors.Count -gt 0) {
    throw (
      "Local embedding upgrade failed and rollback was incomplete: " +
      ($rollbackErrors -join " | ")
    )
  }
  throw $installationFailure
}

$cleanupErrors = @()
foreach ($path in @(
  $runtimePrevious,
  $modelPrevious,
  $runtimeNext,
  $modelNext,
  $transactionRoot
)) {
  if (Test-Path -LiteralPath $path) {
    try {
      Remove-Item -LiteralPath $path -Recurse -Force
    } catch {
      $cleanupErrors += $_.Exception.Message
    }
  }
}
if ($cleanupErrors.Count -gt 0) {
  Write-Warning "Local embedding retained-asset cleanup requires attention."
}
Write-Output $verificationOutput
exit 0
