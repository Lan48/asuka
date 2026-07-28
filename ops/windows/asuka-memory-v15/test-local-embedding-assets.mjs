#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(root, "local-embedding-contract.json"), "utf8"),
);
const install = fs.readFileSync(
  path.join(root, "install-local-embedding.ps1"),
  "utf8",
);
const start = fs.readFileSync(
  path.join(root, "start-local-embedding.ps1"),
  "utf8",
);
const generateManifest = fs.readFileSync(
  path.join(root, "generate-manifest.mjs"),
  "utf8",
);
const common = fs.readFileSync(path.join(root, "common.ps1"), "utf8");

assert.equal(contract.schemaVersion, 1);
assert.deepEqual(contract.ollama, {
  version: "0.32.5",
  signerOrganization: "Ollama Inc.",
  executableBytes: 36512648,
  executableSha256: "82e3b496c059720fa1c40a09af7803778f4bb40f32fb459a1d799c822a217843",
});
assert.equal(contract.task.name, "AsukaEmbedding");
assert.equal(contract.api.endpoint, "http://127.0.0.1:11434/v1/embeddings");
assert.equal(contract.model.name, "asuka-jina-v5-text-small:2026-02-25-q4km");
assert.equal(contract.model.task, "retrieval");
assert.equal(contract.model.quantization, "Q4_K_M");
assert.equal(contract.model.dimensions, 1024);
assert.equal(contract.model.sourceRevision, "78b0ebcb4c870fdfef409e578b65288b49a4fa90");
assert.equal(contract.model.sourceBytes, 396705152);
assert.equal(
  contract.model.sourceSha256,
  "9440cf89f3e8a7a31a42e11b87e106dd5b344af4e0e3b6b21a96136cc8686e21",
);
assert.deepEqual(contract.model.runtime, {
  manifestBytes: 415,
  manifestSha256: "434bad391068826cb0565d7b96cf0456886149f7ae60a00eab590f01beac6945",
  config: {
    mediaType: "application/vnd.docker.container.image.v1+json",
    digest: "sha256:f1922a92413bac87dda32999c8808fd16d68b16acae46db14a1581a951167f3c",
    size: 268,
  },
  layers: [
    {
      mediaType: "application/vnd.ollama.image.model",
      digest: "sha256:741faa04ffc97e4c2ebe124c4e7fc4092170c3ebdb5957f7ab9088bea25c02ee",
      size: 396705152,
    },
  ],
});
assert.match(contract.model.sourceUrl, new RegExp(contract.model.sourceRevision));
assert.ok(!contract.model.sourceUrl.includes("latest"));

for (const [name, source] of [
  ["install", install],
  ["start", start],
]) {
  assert.match(source, /Set-StrictMode -Version 2\.0/);
  assert.match(source, /local-embedding-contract\.json/);
  assert.match(source, /OLLAMA_HOST = "127\.0\.0\.1:11434"/);
  assert.match(
    source,
    name === "install"
      ? /OLLAMA_MODELS = \$modelNext/
      : /OLLAMA_MODELS = \$modelRoot/,
  );
  assert.match(source, /Get-FileHash -Algorithm SHA256/);
  assert.match(
    source,
    /GetPathRoot\(\$rootFull\)[\s\S]*AppRoot contains a reparse point/,
  );
  assert.match(
    source,
    /\$ollamaItem = Get-Item[\s\S]*\$libItem = Get-Item[\s\S]*\$ollamaItem\.Attributes[\s\S]*\$libItem\.Attributes[\s\S]*ReparsePoint/,
  );
  assert.doesNotMatch(source, /qwen3-embedding|639150592|06507c7b/);
  assert.doesNotMatch(source, /\b(?:latest|0\.0\.0\.0)\b/i);
  assert.doesNotMatch(source, /\?\?|\?\.|ForEach-Object\s+-Parallel|\bpwsh\b/);
}

assert.match(install, /\[switch\]\$VerifyOnly/);
assert.match(install, /function Assert-SupportedPowerShell/);
assert.match(install, /\$PSVersionTable\.PSEdition[\s\S]*Desktop/);
assert.match(install, /\$PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/);
assert.match(install, /\$PSVersionTable\.PSVersion\.Minor[\s\S]*-ne 1/);
assert.match(install, /\[Environment\]::Is64BitProcess/);
assert.match(install, /WindowsPrincipal[\s\S]*WindowsBuiltInRole\]::Administrator/);
assert.match(install, /function Assert-CurlCapability/);
assert.match(install, /curl\.exe[\s\S]*--version[\s\S]*--help[\s\S]*--proxy/);
assert.match(install, /"--disable"[\s\S]*"--proto"[\s\S]*"--proto-redir"/);
assert.match(
  install,
  /"--max-filesize"[\s\S]*"--continue-at"[\s\S]*"--silent"[\s\S]*"--show-error"[\s\S]*"--speed-limit"[\s\S]*"--speed-time"[\s\S]*"--write-out"/,
);
assert.match(install, /"--speed-limit", "1024", "--speed-time", "30"/);
assert.match(
  install,
  /"--max-filesize", \(\[string\]\$contract\.model\.sourceBytes\)/,
);
assert.match(install, /"--write-out", "%\{http_code\}"/);
assert.match(install, /\$arguments \+= @\("--continue-at", "-"\)/);
assert.match(
  install,
  /\$partialItem\.Length -gt \[int64\]\$contract\.model\.sourceBytes[\s\S]*Remove-Item -LiteralPath \$sourceModelPartial -Force -ErrorAction Stop/,
);
assert.match(
  install,
  /\$downloadExitCode -eq 33 -or \$httpStatus -ceq "416"[\s\S]*rejected the partial range/,
);
assert.match(
  install,
  /Assert-SourceModel -Path \$sourceModelPartial[\s\S]*catch \{[\s\S]*Remove-Item -LiteralPath \$sourceModelPartial -Force -ErrorAction Stop[\s\S]*throw \$validationFailure/,
);
assert.match(
  install,
  /\$downloadExitCode -eq 63[\s\S]*\$failedPartial\.Attributes[\s\S]*Remove-Item -LiteralPath \$sourceModelPartial -Force -ErrorAction Stop/,
);
assert.match(install, /"--noproxy", "\*"/);
assert.match(install, /"--proxy", \$proxy, "--noproxy", ""/);
assert.match(install, /Windows proxy settings could not be read safely/);
assert.match(install, /Get-AuthenticodeSignature/);
assert.match(install, /sourceSha256/);
assert.match(install, /--proxy/);
assert.match(install, /ProxyUri must be a loopback HTTP proxy/);
assert.match(
  install,
  /Relative "embedding\\runtime\\ollama\.exe"/,
);
assert.match(
  install,
  /Copy-Item -LiteralPath \$OllamaExe -Destination \$runtimePartial -Force/,
);
assert.match(
  install,
  /Copy-Item -LiteralPath \(Join-Path \$sourceRuntimeRoot "lib"\)[\s\S]*-Recurse -Force/,
);
assert.match(install, /Get-OllamaRuntimeIntegrity/);
assert.match(install, /AllowAdditionalRootItems/);
assert.match(install, /embedding\\runtime\.next\.\{0\}/);
assert.match(install, /\$modelNext[\s\S]*\.next\.\{1\}/);
assert.doesNotMatch(install, /Ollama app\.exe|Uninstall\.exe/i);
assert.match(install, /Assert-PinnedOllama -Path \$installedOllama/);
assert.match(
  install,
  /function Assert-PinnedOllama[\s\S]*\$item\.Attributes[\s\S]*ReparsePoint/,
);
assert.match(install, /ollamaExe = \$installedOllama/);
assert.doesNotMatch(
  install,
  /ollamaExe = \$OllamaExe/,
  "installation state must never retain the user-profile executable",
);
assert.match(install, /function Set-ProtectedAssetAcl/);
assert.match(install, /function Assert-ProtectedAssetAcl/);
assert.match(
  install,
  /function Invoke-ProtectedAssetTree[\s\S]*\$rootItem\.Attributes[\s\S]*ReparsePoint[\s\S]*Get-ChildItem/,
);
assert.match(install, /S-1-5-18/);
assert.match(install, /S-1-5-32-544/);
assert.match(install, /SetOwner\(\$administratorsSid\)/);
assert.match(install, /AreAccessRulesProtected/);
assert.match(
  install,
  /GetOwner\(\s*\[Security\.Principal\.SecurityIdentifier\]\s*\)/,
);
assert.doesNotMatch(
  install,
  /WindowsIdentity\]::GetCurrent\(\)\.User[\s\S]{0,500}FileSystemAccessRule/,
  "the installing user must not receive a persistent runtime ACL",
);
assert.match(install, /New-ScheduledTaskPrincipal -UserId "SYSTEM"/);
assert.match(install, /Register-ScheduledTask -TaskName \$taskName/);
assert.match(install, /-File "\{0\}" -AppRoot "\{1\}"/);
assert.match(install, /\$installedStart,\s*\$AppRoot/);
assert.match(
  install,
  /IsNullOrWhiteSpace\(\[string\]\$actions\[0\]\.Execute\)/,
);
assert.match(
  install,
  /IsNullOrWhiteSpace\(\[string\]\$actions\[0\]\.WorkingDirectory\)/,
);
assert.match(
  install,
  /IsPathRooted\(\[string\]\$actions\[0\]\.Execute\)[\s\S]*IsPathRooted\([\s\S]*\$actions\[0\]\.WorkingDirectory/,
);
assert.match(
  install,
  /Invoke-ProtectedAssetTree -Root \$embeddingRoot -Operation "(?:Set|Assert)"/,
);
assert.match(
  install,
  /\$state\.appRoot[\s\S]*\.Equals\([\s\S]*\$AppRoot/,
);
assert.match(
  install,
  /IsPathRooted\(\[string\]\$state\.appRoot\)[\s\S]*IsPathRooted\(\[string\]\$state\.ollamaExe\)/,
);
assert.match(install, /\$task\.Principal\.UserId[\s\S]*SYSTEM/);
assert.match(install, /\$task\.Principal\.RunLevel[\s\S]*Highest/);
assert.match(install, /Get-NetTCPConnection -LocalPort 11434 -State Listen/);
assert.match(install, /listener is not owned by the pinned Ollama executable/);
assert.match(install, /runtime\.manifestSha256/);
assert.match(install, /runtime\.config/);
assert.match(install, /runtime\.layers/);
assert.match(install, /response\.model/);
assert.match(install, /Contract\.model\.dimensions/);
assert.match(
  install,
  /& \$runtimePartial "create" \(\[string\]\$contract\.model\.name\) "-f" \$modelfile/,
);
assert.match(
  install,
  /\$candidateListeners[\s\S]*\$candidateOwner\.ExecutablePath[\s\S]*\$runtimePartial[\s\S]*& \$runtimePartial "create"/,
);
assert.doesNotMatch(install, /ollama\.exe "pull"|OllamaSetup\.exe/);
assert.doesNotMatch(install, /https:\/\//);
assert.doesNotMatch(
  install,
  /& \$runtimePartial "rm"/,
  "candidate import must not remove the active model",
);

const producerBlock = install.match(
  /\[pscustomobject\]@\{\s*ok = \$true[\s\S]*?\}\s*\|\s*ConvertTo-Json -Compress/,
);
assert.ok(producerBlock, "VerifyOnly producer result block is missing");
const producerProperties = [...producerBlock[0].matchAll(
  /^\s{4}([A-Za-z][A-Za-z0-9]+)\s*=/gm,
)].map((match) => match[1]);
const consumerStart = common.indexOf(
  "function ConvertFrom-AsukaLocalEmbeddingVerification",
);
const consumerEnd = common.indexOf("\nfunction ", consumerStart + 1);
assert.ok(consumerStart >= 0 && consumerEnd > consumerStart);
const consumer = common.slice(consumerStart, consumerEnd);
const consumerPropertiesBlock = consumer.match(
  /Assert-AsukaExactJsonProperties[\s\S]*?-Properties @\(([\s\S]*?)\)\s+-Context/,
);
assert.ok(consumerPropertiesBlock, "shared consumer property contract is missing");
const consumerProperties = [...consumerPropertiesBlock[1].matchAll(
  /"([A-Za-z][A-Za-z0-9]+)"/g,
)].map((match) => match[1]);
assert.deepEqual(
  consumerProperties,
  producerProperties,
  "VerifyOnly producer and shared consumer must use the same exact schema",
);
assert.deepEqual(producerProperties, [
  "ok",
  "operation",
  "task",
  "ollamaVersion",
  "model",
  "dimensions",
  "sourceSha256",
  "runtimeSha256",
]);
assert.match(consumer, /\$runtimeSha256 -cnotmatch "\^\[a-f0-9\]\{64\}\$"/);
assert.match(consumer, /runtimeSha256 = \$runtimeSha256/);

const taskSnapshot = install.indexOf("$existingTaskXml = [string](Export-ScheduledTask");
const stopExisting = install.indexOf("Stop-ScheduledTask", taskSnapshot);
const candidateModel = install.indexOf("$env:OLLAMA_MODELS = $modelNext", stopExisting);
const candidateModelGate = install.indexOf(
  "Assert-OllamaModel -ModelRoot $modelNext",
  candidateModel,
);
const runtimeSwap = install.indexOf(
  "Move-Item -LiteralPath $runtimeNext -Destination $runtimeRoot",
  candidateModelGate,
);
const modelSwap = install.indexOf(
  "Move-Item -LiteralPath $modelNext -Destination $modelRoot",
  runtimeSwap,
);
const finalVerification = install.indexOf(
  "$verificationOutput = Invoke-InstalledEmbeddingVerification",
  modelSwap,
);
const successCleanup = install.indexOf("$cleanupErrors = @()", finalVerification);
assert.ok(
  taskSnapshot >= 0
    && taskSnapshot < stopExisting
    && stopExisting < candidateModel
    && candidateModel < candidateModelGate
    && candidateModelGate < runtimeSwap
    && runtimeSwap < modelSwap
    && modelSwap < finalVerification
    && finalVerification < successCleanup,
  "task snapshot, candidate validation, root swaps, final verification, and cleanup must be ordered transactionally",
);
assert.match(
  install,
  /runtime\.previous\.\{0\}[\s\S]*\.previous\.\{1\}/,
);
assert.match(
  install,
  /Copy-Item -LiteralPath \(\[string\]\$snapshot\.Backup\)[\s\S]*-Destination \(\[string\]\$snapshot\.Path\)/,
);
assert.match(
  install,
  /Register-ScheduledTask -TaskName \$taskName -TaskPath "\\"[\s\S]*-Xml \$existingTaskXml -Force/,
);
assert.match(
  install,
  /\$existingTaskRunning[\s\S]*Start-ScheduledTask[\s\S]*Wait-EmbeddingApi[\s\S]*Assert-EmbeddingApi/,
);
assert.match(
  install,
  /\$restoredAssetsVerified[\s\S]*if \(-not \$restoredAssetsVerified\)[\s\S]*Start-ScheduledTask[\s\S]*Assert-EmbeddingApi -Contract \$restoredContract[\s\S]*\$runningTask\.State -cne "Running"[\s\S]*\$restoredOwner\.ExecutablePath[\s\S]*\$restoredOllama[\s\S]*if \(\$existingTaskEnabled\)/,
);
assert.match(
  install,
  /\(\[string\]\$restoredTask\.State -ceq "Running"\) -ne[\s\S]*\$existingTaskRunning/,
);
assert.match(
  install,
  /\$existingTaskEnabled[\s\S]*Enable-ScheduledTask[\s\S]*Disable-ScheduledTask/,
);

const hostGate = install.indexOf("Assert-SupportedPowerShell\n$contract");
const proxyGate = install.indexOf("$proxy = Resolve-Proxy -Requested $ProxyUri");
const curlGate = install.indexOf("$curlPath = Assert-CurlCapability");
const sourceRuntimeGate = install.indexOf(
  "$sourceRuntimeIntegrity = Get-OllamaRuntimeIntegrity",
);
const existingRuntimeGate = install.indexOf(
  'Invoke-ProtectedAssetTree -Root $runtimeRoot -Operation "Assert"',
  sourceRuntimeGate,
);
const firstInstallWrite = install.indexOf(
  "New-Item -ItemType Directory -Path $AppRoot",
);
assert.ok(hostGate >= 0 && hostGate < proxyGate);
assert.ok(proxyGate < curlGate && curlGate < sourceRuntimeGate);
assert.ok(
  sourceRuntimeGate < existingRuntimeGate
    && existingRuntimeGate < firstInstallWrite,
  "all install host, proxy, download, and source runtime gates must precede writes",
);

assert.match(start, /Port 11434 is already occupied/);
assert.match(start, /Relative "embedding\\runtime\\ollama\.exe"/);
assert.match(start, /function Assert-StartupHost/);
assert.match(start, /\$PSVersionTable\.PSEdition[\s\S]*Desktop/);
assert.match(start, /\$PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/);
assert.match(start, /\$PSVersionTable\.PSVersion\.Minor[\s\S]*-ne 1/);
assert.match(start, /\[Environment\]::Is64BitProcess/);
assert.match(start, /Local embedding startup must run as SYSTEM/);
assert.match(start, /Get-AuthenticodeSignature/);
assert.match(start, /signerOrganization/);
assert.doesNotMatch(start, /NotSigned/);
assert.doesNotMatch(install, /NotSigned/);
assert.match(start, /sourceBytes/);
assert.match(start, /runtime\.manifestSha256/);
assert.match(start, /runtime\.config/);
assert.match(start, /runtime\.layers/);
assert.match(start, /Assert-OllamaModel/);
assert.match(start, /Assert-PinnedOllama/);
assert.match(
  start,
  /function Assert-PinnedOllama[\s\S]*\$item\.Attributes[\s\S]*ReparsePoint/,
);
assert.match(start, /function Assert-ProtectedAssetAcl/);
assert.match(start, /function Assert-ProtectedAssetTree/);
assert.match(start, /AreAccessRulesProtected/);
assert.match(start, /S-1-5-18/);
assert.match(start, /S-1-5-32-544/);
assert.match(start, /Assert-ProtectedAssetTree -Root \$embeddingRoot/);
assert.match(start, /Assert-ProtectedAssetTree -Root \$modelRoot/);
assert.match(start, /function Assert-CanonicalTask/);
assert.match(start, /Get-ScheduledTask -TaskName \$TaskName -TaskPath "\\"/);
assert.match(start, /\$task\.Principal\.UserId[\s\S]*SYSTEM/);
assert.match(start, /\$task\.Principal\.RunLevel[\s\S]*Highest/);
assert.match(start, /-File "\{0\}" -AppRoot "\{1\}"/);
assert.match(start, /\$StartScript,\s*\$Root/);
assert.match(start, /\$state\.appRoot[\s\S]*\.Equals\([\s\S]*\$AppRoot/);
assert.match(
  start,
  /IsPathRooted\(\[string\]\$state\.appRoot\)[\s\S]*IsPathRooted\(\[string\]\$state\.ollamaExe\)/,
);
assert.match(
  start,
  /IsPathRooted\(\[string\]\$actions\[0\]\.Execute\)[\s\S]*IsPathRooted\([\s\S]*\$actions\[0\]\.WorkingDirectory/,
);
assert.match(start, /IsPathRooted\(\$PSCommandPath\)/);
assert.match(
  start,
  /\$server = Start-Process -FilePath \$ollamaExe[\s\S]*-RedirectStandardOutput \$standardOutput[\s\S]*-RedirectStandardError \$standardError[\s\S]*-PassThru/,
);
assert.match(start, /function Wait-LoopbackListener/);
assert.match(
  start,
  /Get-NetTCPConnection -State Listen -ErrorAction Stop[\s\S]*LocalPort -eq 11434[\s\S]*\$listeners\.Count -ne 1[\s\S]*LocalAddress -notin @\("127\.0\.0\.1", "::1"\)/,
);
assert.match(
  start,
  /Win32_Process[\s\S]*OwningProcess[\s\S]*\$owner\.ExecutablePath[\s\S]*\$Executable/,
);
assert.match(
  start,
  /Local embedding listener is not owned by the pinned Ollama executable/,
);
assert.doesNotMatch(start, /& \$ollamaExe "serve"/);
assert.doesNotMatch(
  start,
  /\$ollamaExe\s*=\s*\[IO\.Path\]::GetFullPath\(\[string\]\$state\.ollamaExe\)/,
  "the task must derive its executable from the protected AppRoot",
);

const startupHostGate = start.indexOf("$trustedPowerShell = Assert-StartupHost");
const startupAclGate = start.indexOf(
  "Assert-ProtectedAssetAcl -Path $AppRoot",
);
const startupTaskGate = start.indexOf(
  "Assert-CanonicalTask -TaskName",
);
const startupRuntimeGate = start.indexOf(
  "$runtimeIntegrity = Get-OllamaRuntimeIntegrity",
);
const startupModelGate = start.indexOf(
  "Assert-OllamaModel -ModelRoot $modelRoot",
);
const startupProcessWrite = start.indexOf(
  "$server = Start-Process -FilePath $ollamaExe",
);
const startupListenerGate = start.indexOf(
  "Wait-LoopbackListener -Executable $ollamaExe",
);
assert.ok(
  startupHostGate >= 0
    && startupHostGate < startupAclGate
    && startupAclGate < startupTaskGate
    && startupTaskGate < startupRuntimeGate
    && startupRuntimeGate < startupModelGate
    && startupModelGate < startupProcessWrite
    && startupProcessWrite < startupListenerGate,
  "startup must validate host, ACLs, task, runtime, model, and listener in order",
);

for (const pinnedRuntimeValue of [
  contract.model.runtime.manifestSha256,
  contract.model.runtime.config.digest,
  contract.model.runtime.layers[0].digest,
]) {
  assert.match(generateManifest, new RegExp(pinnedRuntimeValue.replace(":", "\\:")));
}

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powershellProbe = spawnSync(
  powershell,
  ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
  { encoding: "utf8" },
);
if (powershellProbe.status === 0) {
  const commonPath = path.join(root, "common.ps1").replaceAll("'", "''");
  const contractPath = path.join(
    root,
    "local-embedding-contract.json",
  ).replaceAll("'", "''");
  const contractScript = [
    '$ErrorActionPreference = "Stop"',
    "Set-StrictMode -Version 2.0",
    `. '${commonPath}'`,
    `$contract = Get-Content -LiteralPath '${contractPath}' -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop`,
    "$manifest = [pscustomobject]@{ requirements = [pscustomobject]@{ embedding = $contract } }",
    '$runtimeSha256 = "a" * 64',
    "$producerJson = [pscustomobject][ordered]@{ ok = $true; operation = 'verify-local-embedding'; task = [string]$contract.task.name; ollamaVersion = [string]$contract.ollama.version; model = [string]$contract.model.name; dimensions = [int]$contract.model.dimensions; sourceSha256 = [string]$contract.model.sourceSha256; runtimeSha256 = $runtimeSha256 } | ConvertTo-Json -Compress",
    "$producerResult = $producerJson | ConvertFrom-Json -ErrorAction Stop",
    "$consumed = ConvertFrom-AsukaLocalEmbeddingVerification -Verification $producerResult -Manifest $manifest",
    "if ([string]$consumed.runtimeSha256 -cne $runtimeSha256 -or @($consumed.PSObject.Properties).Count -ne 8) { throw 'Complete producer result was not preserved by the shared consumer.' }",
    "foreach ($invalid in @(('A' * 64), ('a' * 63), ('g' * 64))) { $candidate = $producerJson | ConvertFrom-Json -ErrorAction Stop; $candidate.runtimeSha256 = $invalid; $rejected = $false; try { [void](ConvertFrom-AsukaLocalEmbeddingVerification -Verification $candidate -Manifest $manifest) } catch { $rejected = $true }; if (-not $rejected) { throw \"Invalid runtimeSha256 was accepted: $invalid\" } }",
    "$extra = $producerJson | ConvertFrom-Json -ErrorAction Stop",
    "$extra | Add-Member -NotePropertyName unexpected -NotePropertyValue $true",
    "$extraRejected = $false",
    "try { [void](ConvertFrom-AsukaLocalEmbeddingVerification -Verification $extra -Manifest $manifest) } catch { $extraRejected = $true }",
    "if (-not $extraRejected) { throw 'Producer-consumer contract accepted an unexpected property.' }",
    "$missing = $producerJson | ConvertFrom-Json -ErrorAction Stop",
    "$missing.PSObject.Properties.Remove('runtimeSha256')",
    "$missingRejected = $false",
    "try { [void](ConvertFrom-AsukaLocalEmbeddingVerification -Verification $missing -Manifest $manifest) } catch { $missingRejected = $true }",
    "if (-not $missingRejected) { throw 'Producer-consumer contract accepted a missing runtimeSha256.' }",
    "Write-Output 'local embedding producer-consumer contract tests: ok'",
  ].join("\n");
  const contractTest = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      contractScript,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    contractTest.status,
    0,
    `PowerShell producer-consumer contract test failed:\n${contractTest.stderr}${contractTest.stdout}`,
  );
} else {
  process.stdout.write(
    "PowerShell producer-consumer contract test skipped: pwsh/powershell is unavailable.\n",
  );
}

console.log("local embedding asset tests: ok");
