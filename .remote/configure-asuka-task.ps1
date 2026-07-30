param(
  [string]$TaskScript = "D:\app\asuka\asuka-gateway-task.ps1",
  [string]$NodePath = "D:\app\asuka\tools\node-v24.18.0\node.exe",
  [string]$MemoryPath = "D:\app\asuka\obsidian-vault\Asuka\Memory"
)

$ErrorActionPreference = "Stop"
$content = Get-Content -LiteralPath $TaskScript -Raw
$content = [regex]::Replace(
  $content,
  '(?m)^\$Node\s*=.*$',
  ('$Node = "' + $NodePath + '"')
)
$content = [regex]::Replace(
  $content,
  '(?ms)^# ASUKA_MEMORY_BEGIN\r?\n.*?^# ASUKA_MEMORY_END\r?\n?',
  ""
)
$memoryBlock = @"
# ASUKA_MEMORY_BEGIN
`$env:ASUKA_MEMORY_WIKI_DIR = "$MemoryPath"
`$env:ASUKA_MEMORY_WIKI_PRIMARY = "1"
# ASUKA_MEMORY_END
"@
$content = "$memoryBlock`r`n$content"
$temporaryPath = "$TaskScript.asuka-upgrade.tmp"
[IO.File]::WriteAllText($temporaryPath, $content, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporaryPath -Destination $TaskScript -Force
