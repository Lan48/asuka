param(
  [string]$Root = "D:\app\asuka",
  [string]$Repository = "git@github.com:Lan48/obsidian-notes.git"
)

$ErrorActionPreference = "Stop"
$vault = Join-Path $Root "obsidian-vault"
$key = Join-Path $Root "ssh\obsidian-memory-ed25519"
$knownHosts = Join-Path $Root "ssh\known_hosts"
$sshCommand = "ssh -i $($key -replace '\\','/') -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$($knownHosts -replace '\\','/')"

New-Item -ItemType Directory -Force -Path $vault | Out-Null

function Invoke-Git {
  param([string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git -C $vault @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) {
    throw "git $($Arguments -join ' ') failed: $output"
  }
  return $output.Trim()
}

if (-not (Test-Path -LiteralPath (Join-Path $vault ".git"))) {
  Invoke-Git -Arguments @("init", "--initial-branch=main") | Out-Null
}
Invoke-Git -Arguments @("config", "core.sshCommand", $sshCommand) | Out-Null
Invoke-Git -Arguments @("config", "core.autocrlf", "false") | Out-Null
Invoke-Git -Arguments @("config", "user.name", "Asuka Memory") | Out-Null
Invoke-Git -Arguments @("config", "user.email", "asuka-memory@local") | Out-Null

$remoteResult = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& git -C $vault remote get-url origin 2>$null | Out-Null
$hasOrigin = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $remoteResult
if ($hasOrigin) {
  Invoke-Git -Arguments @("remote", "set-url", "origin", $Repository) | Out-Null
} else {
  Invoke-Git -Arguments @("remote", "add", "origin", $Repository) | Out-Null
}

Invoke-Git -Arguments @("sparse-checkout", "init", "--cone") | Out-Null
Invoke-Git -Arguments @("sparse-checkout", "set", "Asuka/Memory") | Out-Null
Invoke-Git -Arguments @("fetch", "origin", "main") | Out-Null
Invoke-Git -Arguments @("checkout", "-B", "main", "origin/main") | Out-Null
Invoke-Git -Arguments @("branch", "--set-upstream-to=origin/main", "main") | Out-Null

New-Item -ItemType Directory -Force -Path (Join-Path $vault "Asuka\Memory") | Out-Null
[ordered]@{
  branch = Invoke-Git -Arguments @("branch", "--show-current")
  upstream = Invoke-Git -Arguments @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
  remote = Invoke-Git -Arguments @("remote", "get-url", "origin")
  sparse = @((Invoke-Git -Arguments @("sparse-checkout", "list")) -split "\r?\n")
} | ConvertTo-Json -Depth 3 -Compress
