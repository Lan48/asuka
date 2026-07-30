#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const attestReleaseBuild = read("attest-release-build.mjs");
const common = read("common.ps1");
const createRecoveryBaseline = read("create-recovery-baseline.ps1");
const deploy = read("deploy.ps1");
const freeze = read("freeze-and-backup-v15.ps1");
const generateManifest = read("generate-manifest.mjs");
const installLocalEmbedding = read("install-local-embedding.ps1");
const normalize = read("normalize-task-actions.ps1");
const preflight = read("preflight.ps1");
const recoverBaseline = read("recover-v15-baseline.ps1");
const rollback = read("rollback.ps1");
const verify = read("verify.ps1");
for (const [name, source] of [
  ["common.ps1", common],
  ["deploy.ps1", deploy],
  ["rollback.ps1", rollback],
  ["verify.ps1", verify],
]) {
  assert.doesNotMatch(
    source,
    /"\$[A-Za-z_][A-Za-z0-9_]*:/,
    `${name} must delimit interpolated variables before a colon for Windows PowerShell 5.1`,
  );
}

const index = (source, marker, label) => {
  const value = source.indexOf(marker);
  assert.notEqual(value, -1, `${label}: missing ${marker}`);
  return value;
};

const deployLock = index(deploy, "Enter-AsukaDeploymentLock", "deploy lock");
const deployPreflight = index(
  deploy,
  "$preflight = Invoke-AsukaLockedScript",
  "deploy preflight",
);
assert.ok(
  deployLock < deployPreflight,
  "deploy must acquire the shared lock before preflight and trusted-input validation",
);
assert.match(preflight, /Enter-AsukaDeploymentLock/);
assert.match(freeze, /Enter-AsukaDeploymentLock/);
assert.match(normalize, /Enter-AsukaDeploymentLock/);
assert.match(rollback, /Enter-AsukaDeploymentLock/);
assert.match(verify, /Enter-AsukaDeploymentLock/);
assert.match(common, /function Invoke-AsukaLockedScript/);
assert.match(deploy, /\$rollback = Invoke-AsukaLockedScript/);
assert.doesNotMatch(
  [
    deploy,
    freeze,
    normalize,
    preflight,
    rollback,
    verify,
    createRecoveryBaseline,
    recoverBaseline,
  ].join("\n"),
  /DeploymentLockHeld/,
  "no public script may trust a caller-supplied lock-held switch",
);
assert.doesNotMatch(
  freeze,
  /SealExistingBackupPath|Write-AsukaBackupIntegrity -BackupPath \$sealedPath/,
  "a completed backup must never be re-signed in place",
);

assert.match(deploy, /run\\deployments/);
assert.match(rollback, /run\\deployments/);
assert.doesNotMatch(deploy, /Join-Path \$backupPath "migration/);
assert.doesNotMatch(deploy, /Join-Path \$backupPath "deployment-state\.json"/);
assert.doesNotMatch(rollback, /Join-Path \$BackupPath "failed-cutover/);
assert.doesNotMatch(rollback, /Join-Path \$BackupPath "rollback-state\.json"/);
const deploySuccessTaskRead = deploy.lastIndexOf(
  "Get-ScheduledTask -TaskName $syncTaskName",
);
const deploySuccessLockRelease = deploy.indexOf(
  "Exit-AsukaDeploymentLock -Lease $lockStream",
  deploySuccessTaskRead,
);
assert.ok(
  deploySuccessTaskRead >= 0 && deploySuccessLockRelease > deploySuccessTaskRead,
  "deploy must build all success data before releasing its lock lease",
);

const rollbackCatch = rollback.slice(index(rollback, "} catch {", "rollback catch"));
assert.doesNotMatch(
  rollbackCatch,
  /Start-ScheduledTask/,
  "rollback failures must never restart either writer",
);
assert.match(rollbackCatch, /Disable-AndStopAsukaTask[\s\S]*Disable-AndStopAsukaTask/);

assert.match(freeze, /Test-AsukaFrozenCopyIntegrity[\s\S]*Write-AsukaBackupIntegrity/);
assert.match(freeze, /Assert-AsukaNoGitOperation/);
assert.match(freeze, /Write-AsukaEnvelope/);
assert.match(freeze, /\$manifest\.requirements\.gatewayPort/);
assert.match(freeze, /\$manifest\.requirements\.nodeVersion/);

assert.match(common, /function Assert-AsukaNoReparsePointPath/);
assert.match(common, /function Assert-AsukaJsonBoolean/);
assert.match(common, /function Enter-AsukaDeploymentLock/);
assert.match(common, /function Exit-AsukaDeploymentLock/);
assert.match(common, /nodeVersion[\s\S]*\^v\[0-9\]\+/);
assert.match(common, /required release helper/i);
assert.match(common, /runtimeDependencyTree/);
assert.match(common, /unmanifested release file/i);
const taskAttestationReader = common.slice(
  index(
    common,
    "function Read-AsukaTaskNormalizationAttestation",
    "task attestation reader",
  ),
  index(
    common,
    "function Find-AsukaTaskNormalizationAttestation",
    "task attestation finder",
  ),
);
assert.match(taskAttestationReader, /Get-AsukaComparableTaskXml/);
assert.match(
  taskAttestationReader,
  /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/,
);

assert.match(generateManifest, /buildAttestation/);
assert.match(generateManifest, /runtimeDependencyTree/);
assert.match(generateManifest, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/);
assert.match(generateManifest, /linked worktree/i);
for (const [name, source] of [
  ["attest-release-build.mjs", attestReleaseBuild],
  ["generate-manifest.mjs", generateManifest],
]) {
  assert.doesNotMatch(source, /npm\.cmd/);
  assert.doesNotMatch(source, /shell\s*:/);
  assert.match(source, /process\.env\.npm_execpath/);
  assert.match(source, /node_modules[\s\S]*npm[\s\S]*bin[\s\S]*npm-cli\.js/);
  assert.match(source, /execFileSync\(\s*process\.execPath/);
}

assert.match(preflight, /\$PSVersionTable\.PSEdition[\s\S]*Desktop/);
assert.match(preflight, /\$PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/);
assert.match(preflight, /\$PSVersionTable\.PSVersion\.Minor[\s\S]*-ne 1/);
assert.match(preflight, /\[Environment\]::Is64BitProcess/);
assert.match(preflight, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
assert.match(preflight, /GetCurrentProcess\(\)\.MainModule\.FileName/);
assert.match(
  preflight,
  /releaseManifestSha256[\s\S]*gatewayPort[\s\S]*nodeVersion[\s\S]*Frozen backup does not match the release manifest/,
);
assert.match(preflight, /function Assert-AsukaJsonInteger/);
assert.match(
  preflight,
  /Assert-AsukaJsonInteger[\s\S]*completionModels[\s\S]*Assert-AsukaJsonInteger[\s\S]*networkCalls/,
);
for (const [name, source] of [
  ["deploy.ps1", deploy],
  ["preflight.ps1", preflight],
]) {
  assert.doesNotMatch(
    source,
    /Invoke-WebRequest|Start-BitsTransfer|curl\.exe|DownloadFile|DownloadString|ollama(?:\.exe)?["']?\s+(?:create|pull)|Register-ScheduledTask/i,
    `${name} must not download or install the local embedding prerequisite`,
  );
}

const embeddingVerifierStart = index(
  common,
  "function Invoke-AsukaLocalEmbeddingVerification",
  "local embedding verifier",
);
const embeddingVerifierNext = common.indexOf("\nfunction ", embeddingVerifierStart + 1);
const embeddingVerifier = common.slice(
  embeddingVerifierStart,
  embeddingVerifierNext < 0 ? undefined : embeddingVerifierNext,
);
assert.match(embeddingVerifier, /install-local-embedding\.ps1/);
assert.match(
  embeddingVerifier,
  /"-AppRoot",\s*\[string\]\$Manifest\.appRoot,\s*"-VerifyOnly"/,
);
assert.match(embeddingVerifier, /\$result\.ExitCode\s+-ne\s+0/);
assert.match(embeddingVerifier, /throw "Local embedding verification failed\."/);
assert.doesNotMatch(
  embeddingVerifier,
  /throw[^\r\n]*(?:\$result\.Output|\$result\.Error|stderr|stdout)/i,
  "embedding verification failure must not disclose helper output",
);
for (const [name, source] of [
  ["preflight.ps1", preflight],
  ["verify.ps1", verify],
]) {
  assert.match(
    source,
    /\$embeddingVerification\s*=\s*Invoke-AsukaLocalEmbeddingVerification/,
    `${name} must fail closed through the shared local embedding verifier`,
  );
  assert.match(
    source,
    /localEmbedding\s*=\s*\$embeddingVerification/,
    `${name} must report the verified prerequisite`,
  );
}

assert.match(installLocalEmbedding, /\[switch\]\$VerifyOnly/);
assert.match(
  installLocalEmbedding,
  /New-ScheduledTaskAction -Execute \$trustedPowerShell[\s\S]*-WorkingDirectory \$AppRoot/,
);
assert.match(installLocalEmbedding, /New-ScheduledTaskTrigger -AtStartup/);
assert.match(
  installLocalEmbedding,
  /New-ScheduledTaskPrincipal -UserId "SYSTEM"[\s\S]*-RunLevel Highest/,
);
assert.match(
  installLocalEmbedding,
  /Get-ScheduledTask -TaskName \$taskName -TaskPath "\\"[\s\S]*\$task\.State -ne "Running"/,
);
assert.match(
  installLocalEmbedding,
  /\$actions\.Count -ne 1[\s\S]*\$trustedPowerShell[\s\S]*\$taskArguments[\s\S]*\$AppRoot/,
);
assert.match(
  installLocalEmbedding,
  /Get-NetTCPConnection -LocalPort 11434 -State Listen[\s\S]*\$listeners\.Count -ne 1[\s\S]*LocalAddress -notin @\("127\.0\.0\.1", "::1"\)/,
);
assert.match(
  installLocalEmbedding,
  /Win32_Process[\s\S]*OwningProcess[\s\S]*\$owner\.ExecutablePath[\s\S]*\$OllamaExe/,
);
assert.match(
  installLocalEmbedding,
  /Local embedding listener is not owned by the pinned Ollama executable\./,
);
assert.match(
  installLocalEmbedding,
  /Local Ollama API version does not match the contract\./,
);
assert.doesNotMatch(installLocalEmbedding, /qwen3-embedding/);

assert.match(rollback, /pre-existing Asuka\/Memory changes/i);
assert.match(rollback, /activation-journal\.json/);
const rollbackActivationJournalPath = index(
  rollback,
  "$activationJournalPath = Join-Path $deploymentRunRoot",
  "rollback activation journal path",
);
const rollbackActivationBinding = index(
  rollback,
  "$activationJournalBound =",
  "rollback activation journal binding",
);
const rollbackActivationJournalRead = index(
  rollback,
  "$activationJournal = Get-Content",
  "rollback activation journal read",
);
assert.ok(
  rollbackActivationJournalPath < rollbackActivationBinding
    && rollbackActivationBinding < rollbackActivationJournalRead,
  "rollback must validate the deployment-state binding before reading the activation journal",
);
const rollbackActivationBindingGuard = rollback.slice(
  rollbackActivationBinding,
  rollbackActivationJournalRead,
);
assert.match(
  rollbackActivationBindingGuard,
  /GetFullPath[\s\S]*\$deploymentState\.activationJournal\.path[\s\S]*Equals\([\s\S]*\$activationJournalPath/,
);
assert.match(
  rollbackActivationBindingGuard,
  /\$deploymentState\.activationJournal\.sha256[\s\S]*\^\[a-fA-F0-9\]\{64\}\$[\s\S]*Get-AsukaSha256 -Path \$activationJournalPath/,
);
assert.match(
  rollbackActivationBindingGuard,
  /without a completed deployment-state binding[\s\S]*ledger files are preserved[\s\S]*dedicated recovery/i,
  "an unbound activation journal must fail closed without mutating ledger files",
);
assert.match(rollback, /\$activationReached = \$activationJournalBound/);
assert.doesNotMatch(
  rollback,
  /\$activationReached\s*=\s*Test-Path[^\r\n]*\$activationJournalPath/,
);
const activatedRollbackValidation = rollback.slice(
  index(rollback, "  if ($activationReached) {", "activated rollback validation"),
  index(
    rollback,
    "  } else {\n    foreach ($suffix in @(\"\", \"-wal\", \"-shm\"))",
    "pre-activation rollback validation",
  ),
);
assert.doesNotMatch(
  activatedRollbackValidation,
  /Get-AsukaSha256 -Path \$ledger/,
  "post-cutover ledger content is mutable and must not be compared with its activation hash",
);
assert.doesNotMatch(
  activatedRollbackValidation,
  /Get-Item -LiteralPath \$ledger/,
    "post-cutover ledger size is mutable and must not be compared with its activation size",
);
const rollbackUpstreamResolve = index(
  rollback,
  '"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"',
  "rollback upstream resolution",
);
const rollbackUpstreamFetch = index(
  rollback,
  '@("fetch", "--prune")',
  "rollback upstream fetch",
);
const rollbackAheadRead = index(
  rollback,
  '"rev-list", "--reverse", "$vaultUpstream..HEAD"',
  "rollback pre-existing ahead commits",
);
const rollbackCompensationCommit = index(
  rollback,
  '"commit",',
  "rollback compensation commit",
);
const rollbackWriterStop = index(
  rollback,
  "Disable-AndStopAsukaTask -Name $syncTaskName",
  "rollback writer stop",
);
assert.ok(
  rollbackWriterStop < rollbackUpstreamResolve
    && rollbackUpstreamResolve < rollbackUpstreamFetch
    && rollbackUpstreamFetch < rollbackAheadRead
    && rollbackAheadRead < rollbackCompensationCommit,
  "rollback must stop writers, then fetch and inspect the complete pre-existing ahead range before committing compensation",
);
assert.match(
  rollback,
  /diff-tree[\s\S]*--root[\s\S]*-m[\s\S]*--name-only[\s\S]*-z[\s\S]*\$aheadCommit/,
);
assert.match(
  rollback,
  /\$scopeGate\.ExitCode -eq 1[\s\S]*:\(top,exclude\)Asuka\/Memory[\s\S]*\$vaultPushBlockingCommits/,
  "rollback must let Git classify every outside-Memory path before blocking a commit",
);
assert.match(
  rollback,
  /\$vaultPushBlockingCommits[\s\S]*commit = \$aheadCommit[\s\S]*paths = @\(\$outsidePaths\)/,
  "rollback must retain exact blocking commit ids and paths",
);
assert.match(
  rollback,
  /if \(\$vaultPushAllowed\) \{[\s\S]*Invoke-AsukaGit -Repository \$vault -Arguments @\("push"\)/,
  "rollback must not push unless every pre-existing ahead commit is Memory-scoped",
);
assert.match(
  rollback,
  /preRollbackAheadCommits = @\(\$preRollbackAheadCommits\)[\s\S]*pushBlockingCommits = @\(\$vaultPushBlockingCommits\)/,
);
const rollbackFetchFailure = rollback.slice(
  index(
    rollback,
    "if ($fetch.ExitCode -ne 0) {",
    "rollback fetch failure",
  ),
  rollbackAheadRead,
);
assert.match(rollbackFetchFailure, /compensation commit will remain queued/i);
assert.doesNotMatch(
  rollbackFetchFailure,
  /throw/,
  "an offline upstream must queue compensation without aborting local rollback",
);
const rollbackOutboxGate = index(
  rollback,
  "$projectionOutboxAfterStop = Invoke-AsukaProjectionOutboxGate",
  "rollback projection outbox gate",
);
assert.ok(
  rollbackWriterStop < rollbackOutboxGate,
  "rollback must stop writers before validating the mutable projection outbox",
);
assert.match(rollback, /rollback\.next\.[^"]*NewGuid/);
assert.match(rollback, /gateway snapshot task name does not match/i);
assert.match(rollback, /sync snapshot task name does not match/i);
assert.match(rollback, /Quarantine-AsukaInvalidLegacyFile/);
assert.doesNotMatch(
  rollback,
  /Unregister-ScheduledTask|Stop-InstalledOllama|Remove-Item[^\r\n]*(?:embedding|ollama|jina)/i,
  "application rollback must retain the local embedding prerequisite",
);
assert.doesNotMatch(
  rollback,
  /(?:Disable-AndStopAsukaTask|Disable-ScheduledTask|Stop-ScheduledTask)[\s\S]{0,160}(?:requirements\.embedding|AsukaEmbedding)/i,
  "application rollback must not stop or disable the embedding task",
);

assert.match(deploy, /Assert-AsukaJsonBoolean[\s\S]*rejudgementGate/);
assert.match(verify, /Assert-AsukaJsonBoolean[\s\S]*gate/);
assert.match(verify, /reportSha256[\s\S]*Get-AsukaSha256/);
assert.match(
  verify,
  /Test-AsukaRuntimeDependencyTree[\s\S]*runtimeDependencyTree/,
);
assert.match(
  verify,
  /Read-AsukaTaskNormalizationAttestation[\s\S]*-VerifyCurrentTasks/,
);
assert.match(verify, /activation-journal\.json/);
assert.match(
  verify,
  /activationJournal[\s\S]*sha256[\s\S]*completed[\s\S]*hadPreexistingLedger/,
);
assert.match(
  verify,
  /cohort[\s\S]*sha256[\s\S]*\^\[a-fA-F0-9\]\{64\}\$/,
);
assert.match(
  verify,
  /rejudgement[\s\S]*rejudgementGate[\s\S]*integrity[\s\S]*stats[\s\S]*Persisted migration result does not match the sealed report/,
);

assert.match(
  createRecoveryBaseline,
  /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$SourceBackupPath/,
);
assert.doesNotMatch(
  createRecoveryBaseline,
  /SourceBackupPath\s*=\s*"D:\\app\\asuka\\backups\\upgrade-/,
);
assert.match(createRecoveryBaseline, /2026\.5\.4/);
assert.match(createRecoveryBaseline, /recovery-baselines\\sha256-/);
assert.match(createRecoveryBaseline, /Write-AsukaBackupIntegrity/);
const recoverySeal = index(
  createRecoveryBaseline,
  "Write-AsukaBackupIntegrity -BackupPath $stagingPath",
  "recovery staging seal",
);
const recoveryPublish = index(
  createRecoveryBaseline,
  "Move-Item -LiteralPath $stagingPath -Destination $targetPath",
  "recovery baseline publish",
);
assert.ok(
  recoverySeal < recoveryPublish,
  "a content-addressed baseline must be sealed before its atomic publish",
);
assert.doesNotMatch(
  createRecoveryBaseline,
  /Write-AsukaBackupIntegrity -BackupPath \$targetPath/,
);
assert.doesNotMatch(
  createRecoveryBaseline,
  /Write-AsukaBackupIntegrity[\s\S]*\$SourceBackupPath/,
  "the legacy source must never be sealed or rewritten in place",
);
assert.match(recoverBaseline, /Test-AsukaBackupIntegrity/);
assert.match(recoverBaseline, /home/);
assert.match(recoverBaseline, /project/);
assert.match(recoverBaseline, /tools\\node_modules\\openclaw/);
assert.match(recoverBaseline, /asuka-gateway-task\.ps1/);
assert.match(recoverBaseline, /restore-vault-generated\.mjs/);
assert.doesNotMatch(recoverBaseline, /Enable-ScheduledTask|Start-ScheduledTask/);
assert.match(
  recoverBaseline,
  /catch[\s\S]*Disable-AndStopAsukaTask[\s\S]*Disable-AndStopAsukaTask/,
);

const freezeWriterStop = index(
  freeze,
  "foreach ($taskName in @($SyncTaskName, $GatewayTaskName))",
  "freeze writer stop",
);
const freezeTaskXml = index(
  freeze,
  "Export-ScheduledTask -TaskName ([string]$task.TaskName)",
  "freeze task XML",
);
assert.ok(
  freezeWriterStop < freezeTaskXml,
  "fresh freeze must export canonical disabled task XML after stopping both writers",
);

process.stdout.write("Asuka Memory v1.5 review regression gates passed.\n");
