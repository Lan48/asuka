# Asuka Memory v1.5 Windows deployment

This directory builds and operates a PowerShell 5.1-compatible, one-time
migration of the Asuka QQBot memory runtime on the private Windows host.
Runtime files, backups, the Vault, and deployment state remain under
`D:\app\asuka`.

## User actions before maintenance

Complete these items before an operator runs `deploy.ps1`:

1. In the local Obsidian Vault, commit and push `Asuka/Memory`.
2. Confirm the direct-chat `account`, `peer`, and optional cross-channel
   `identity` used to build the migration manifest.
3. Confirm a maintenance window. The Gateway and Memory Sync tasks are stopped
   during the frozen backup, migration, and health gate.
4. Resolve any existing Vault Git conflict. The scripts never force-push,
   reset, or discard either side of a conflict.

The remote host does not need Obsidian or `gh`. It needs the pinned Node.js and
OpenClaw installations, Git for Windows, OpenSSH, the existing deploy key, and
the `AsukaGateway` and `AsukaMemorySync` scheduled tasks.

## Build and attest the release

The release requires two independent attestations. Both must identify the same
full Git commit and the same named branch. Use fresh linked worktrees and keep
both attestation files outside those worktrees.

First, create the runtime build attestation on the local build host. The named
release branch must not be checked out elsewhere in the same clone.

```bash
repo=/path/to/openclaw-clawra
release_branch=codex/asuka-memory-v15-YYYYMMDD
release_commit=$(git -C "$repo" rev-parse HEAD)
build_root=/tmp/asuka-memory-v15-build-YYYYMMDD
attestation_root=/tmp/asuka-memory-v15-attestations-YYYYMMDD
release_root=/tmp/asuka-memory-v15-release-YYYYMMDD
tool_root=/tmp/asuka-memory-v15-tools-YYYYMMDD

git -C "$repo" worktree add -b "$release_branch" "$build_root" "$release_commit"
npm install --global --prefix "$tool_root" npm@11.16.0
export PATH="$tool_root/bin:$PATH"
test "$(node --version)" = "v24.18.0"
test "$(npm --version)" = "11.16.0"
node "$build_root/ops/windows/asuka-memory-v15/attest-release-build.mjs" \
  --kind build \
  --project-root "$build_root" \
  --output "$attestation_root/build.json"
```

The command requires a clean, named linked worktree with no existing QQBot
`dist`, `node_modules`, or ignored build files. It runs
`npm ci --ignore-scripts`, the vendored-only QQBot cron patch, and `npm test`,
then records the built runtime tree.

Next, create the dependency attestation on native `win32/x64`. The Windows
linked worktree must start clean at the same named branch and commit, with no
existing `dist` or `node_modules`. Use the pinned Node.js version and the same
npm version as the local build.

```powershell
$repo = "D:\app\asuka\source\openclaw-clawra"
$releaseBranch = "codex/asuka-memory-v15-YYYYMMDD"
$windowsBuildRoot = "D:\app\asuka\build\asuka-memory-v15-windows-YYYYMMDD"
$attestationRoot = "D:\app\asuka\attestations\asuka-memory-v15-YYYYMMDD"
$toolBin = "D:\app\asuka\tools\node-v24.18.0"

git -C $repo worktree add $windowsBuildRoot $releaseBranch
$env:Path = "$toolBin;$env:Path"
if ((node --version) -ne "v24.18.0" -or (npm --version) -ne "11.16.0") {
  throw "Pinned Node.js/npm toolchain is not active."
}
node "$windowsBuildRoot\ops\windows\asuka-memory-v15\attest-release-build.mjs" `
  --kind windows-dependencies `
  --project-root $windowsBuildRoot `
  --output "$attestationRoot\windows-dependencies.json"
```

This command runs `npm ci --ignore-scripts`, applies only the vendored QQBot
cron patch, and records the complete Windows `node_modules` tree. Copy
`windows-dependencies.json` back beside `build.json` without editing either
file.

Generate the release from the same local linked worktree:

```bash
node "$build_root/ops/windows/asuka-memory-v15/generate-manifest.mjs" \
  --project-root "$build_root" \
  --release-root "$release_root" \
  --release-id asuka-memory-v15-YYYYMMDD \
  --account default \
  --peer USER_ID \
  --build-attestation "$attestation_root/build.json" \
  --windows-dependency-attestation \
    "$attestation_root/windows-dependencies.json"
```

Add `--identity IDENTITY_ID` when the same person is linked across channels.
The generator rejects missing, reused, or in-worktree attestation files. It
also rejects any commit, branch, lockfile, Node.js, npm, or runtime-tree
mismatch.

The generator copies the attested runtime and writes SHA-256 entries for every
packaged runtime and operational file. Tests, symlinks, `.git`, and
`node_modules` are excluded from the release payload.

The active Windows QQBot dependency directory at
`D:\app\asuka\home\.openclaw\extensions\qqbot\node_modules` must exactly match
the Windows attested tree. Preflight compares its file count, byte count, and
tree SHA-256. Any mismatch fails preflight, so deployment does not start.
Deployment preserves this directory; it does not install or repair
dependencies.

The known host defaults can be overridden without changing scripts:
`--app-root`, `--openclaw-version`, `--node-version`, `--gateway-port`,
`--gateway-task`, and `--sync-task`. All operational scripts consume these
values from the hashed release inventory instead of repeating them.

Transfer the generated directory to a release directory below
`D:\app\asuka`, preserving `manifest.json`, `payload`, and `ops`.

## Install the local embedding prerequisite

Complete this prerequisite before creating the recovery baseline or frozen
backup. Reuse the existing Authenticode-signed Ollama executable on the C drive;
the installer verifies its pinned version, size, SHA-256, and `Ollama Inc.`
signer and does not download or replace Ollama itself.

The pinned retrieval model is
`jina-embeddings-v5-text-small-retrieval-GGUF` under `CC-BY-NC-4.0`. Confirm
that this non-commercial license fits the deployment. The source GGUF, Ollama
model store, generated Modelfile, installed start script, contract, state, and
verified `ollama.exe + lib` runtime copy all live below `D:\app\asuka`. The
existing C-drive installation is only the signed source used to build that
protected copy; the SYSTEM task never executes from the user profile. The
source model is under
`D:\app\asuka\models\jina-v5-text-small`, Ollama's managed blobs and manifest
are under `D:\app\asuka\models\ollama`, and the installed management contract,
start script, and state are under `D:\app\asuka\embedding`. `$ollamaExe` must
resolve to the existing
`C:\Users\<user>\AppData\Local\Programs\Ollama\ollama.exe`.

Run the prerequisite installer from an elevated 64-bit Windows PowerShell 5.1
session. Point `-ProxyUri` at the active Clash HTTP or mixed listener on
loopback; change the example port when the local Clash configuration differs.

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$clashProxy = "http://127.0.0.1:7890"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\install-local-embedding.ps1" `
  -AppRoot "D:\app\asuka" `
  -OllamaExe $ollamaExe `
  -ProxyUri $clashProxy
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\install-local-embedding.ps1" `
  -AppRoot "D:\app\asuka" `
  -VerifyOnly
```

The installer is the only deployment asset allowed to download the pinned
Jina GGUF, and it does so only when the content-addressed source is absent. It
rejects a non-loopback proxy, validates the pinned byte count and SHA-256 before
publication, imports the model into `D:\app\asuka\models\ollama`, and registers
the root `\AsukaEmbedding` task as `SYSTEM`, `AtStartup`, and `Highest`. The
service listens only on `127.0.0.1:11434`; verification requires one loopback
listener owned by the pinned Ollama executable, the canonical task action, the
pinned API version, the manifest-selected model, and a 1024-dimensional finite
health vector.

`preflight.ps1`, `deploy.ps1`, and `verify.ps1` never download, import, repair,
or register this prerequisite. Preflight and verify invoke the installer only
with `-VerifyOnly` and fail closed if any task, listener, owner, executable,
model, manifest, or health check differs. Application rollback deliberately
does not uninstall, stop, unregister, remove, or downgrade Ollama,
`AsukaEmbedding`, the Jina model, or its management assets; prerequisite
lifecycle remains separate.

## Create and use the immutable recovery baseline

Import the selected pre-v1.5 backup once. `-SourceBackupPath` is mandatory so
each maintenance window names its recovery source explicitly. The importer
verifies OpenClaw `2026.5.4`, normalizes the allowlisted legacy layout, and
creates an immutable content-addressed baseline:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$baselineResult = powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\create-recovery-baseline.ps1" `
  -AppRoot "D:\app\asuka" `
  -SourceBackupPath "D:\app\asuka\backups\upgrade-20260727-001932" |
    ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $baselineResult.ok) {
  throw $baselineResult.error
}
$recoveryBaseline = [string]$baselineResult.data.baselinePath
```

For emergency full recovery, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\recover-v15-baseline.ps1" `
  -AppRoot "D:\app\asuka" `
  -BaselinePath $recoveryBaseline
```

Recovery restores the old home, project, pinned OpenClaw installation, and
Gateway script. It uses `restore-vault-generated.mjs` so post-cutover Notes and
Overrides remain intact. `AsukaGateway` and `AsukaMemorySync` remain Disabled
after both successful and failed recovery; inspect the retained recovery
evidence before any separate operator-controlled restart.

## Create a release-bound frozen backup

For each maintenance window, create a new backup bound to the transferred
release manifest. Run from an elevated 64-bit Windows PowerShell 5.1 session:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$freeze = powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\freeze-and-backup-v15.ps1" `
  -AppRoot "D:\app\asuka" `
  -ReleaseRoot $release | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $freeze.ok) {
  throw $freeze.error
}
$frozen = [string]$freeze.data.BackupRoot
```

The script derives the release ID, task names, Node.js version, and Gateway port
from the hashed manifest. It freezes both writers, creates a new timestamped
backup, verifies every copied tree, and seals the file inventory.

Retain
`D:\app\asuka\backups\v15-20260727-124326-adaptive-memory-kernel` only for
historical audit and rollback recovery. Do not use it as this deployment's
frozen input, and do not seal it as a substitute for a new release-bound
backup. Only the new `$frozen` path continues into normalization, preflight,
and deployment.

## Normalize scheduled task actions

Run from an elevated 64-bit Windows PowerShell 5.1 session:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$normalize = powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\normalize-task-actions.ps1" `
  -AppRoot "D:\app\asuka" `
  -ReleaseRoot $release `
  -FrozenBackupPath $frozen | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $normalize.ok) {
  throw $normalize.error
}
$taskAttestation = [string]$normalize.data.attestationPath
```

`normalize-task-actions.ps1` is required for this rollout. It validates the
release-bound backup and stopped task state, then emits the task attestation
consumed by deployment. For a bare `powershell.exe` action, it changes only
`Execute` to the absolute `$PSHOME\powershell.exe` path. Arguments and working
directory must remain unchanged. It never starts a task and restores the
exported XML if normalization fails.

## Preflight

Run the fail-closed checks before deployment:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\preflight.ps1" `
  -AppRoot "D:\app\asuka" `
  -ReleaseRoot $release `
  -FrozenBackupPath $frozen
```

Preflight validates release hashes, pinned Node/OpenClaw versions, free space,
the exact Windows dependency tree, task actions and state, Gateway shutdown,
the sync lock, Vault cleanliness, and Vault convergence with the configured
upstream. It resolves the configured completion model through the packaged
runtime without making a model request, invokes local embedding verification
only in `-VerifyOnly` mode, and makes no prerequisite download or mutation. It
also uses the Windows PowerShell parser to reject packaged `.ps1` files with
syntax errors.

If GitHub is temporarily unreachable but the operator has independently
confirmed that the remote and local Vault are at the same commit, pass
`-SkipVaultRemoteGate` to preflight and deploy. This bypasses only the remote
convergence check. It does not bypass local cleanliness or conflict checks.

## Deploy

Only after preflight succeeds, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\deploy.ps1" `
  -AppRoot "D:\app\asuka" `
  -ReleaseRoot $release `
  -FrozenBackupPath $frozen `
  -TaskNormalizationAttestationPath $taskAttestation
```

`deploy.ps1` requires `-FrozenBackupPath` and fails closed when it is missing.
The path must identify the fresh backup bound to this release manifest. The
tasks and Gateway port must remain stopped after freezing. Deployment validates
the complete backup, re-runs fail-closed preflight without installing or
downloading embedding assets, and carries the pre-freeze task intent into
rollback and post-cutover startup.

Deployment then:

1. Saves scheduled-task XML and state, ACL records, scripts, configuration,
   complete OpenClaw home, active QQBot, project, Vault including `.git`, SSH
   material, and the pinned OpenClaw installation.
2. Stops Memory Sync, then Gateway, and verifies writers are frozen.
3. Enables `memory-core`, `active-memory`, `memory-wiki`, and
   `channels.qqbot.memoryKernel` with manifest-derived ledger, Vault, identity,
   and peer paths while preserving explicit model settings. Both foreground
   retrieval and `active-memory` are fixed to 1500 ms; late LLM reranking has a
   separate 60-second background budget.
4. Migrates every frozen legacy source into `memory-ledger.sqlite.next` with
   exact provenance and queues candidate extraction and consolidation jobs.
5. Requires SQLite integrity, foreign-key integrity, zero skipped records, and
   a source map for every discovered legacy record before activation.
6. Atomically activates the staged QQBot runtime and ledger, then lets the
   Gateway process legacy LLM rejudgement in bounded background batches.
7. Compiles and lints Memory Wiki.
8. Starts and verifies Gateway before Memory Sync is allowed to start.

Choice A remains a one-time full reorganization: legacy facts, inferred
material, state, digests, reference indexes, and session evidence enter the new
ledger with provenance. LLM rejudgement continues in the background after
Gateway startup, so provider throttling cannot block normal Asuka use.

GitHub push completion is not a runtime success gate. Memory Sync debounces the
generated Vault changes and retries a queued push without blocking Asuka.

## Verify

The default check verifies the active release hashes, ledger integrity,
Gateway process/port/startup/WebSocket logs, scheduled tasks, sync lock and
status, and Git conflict state:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\verify.ps1" `
  -ReleaseRoot $release
```

A `retry` sync state caused by network failure is reported but does not fail
runtime verification. To require a clean Vault that is fully converged with
the upstream, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\verify.ps1" `
  -ReleaseRoot $release -RequireVaultPushed
```

Every command emits one JSON envelope. `ok: true` exits `0`; a failed gate emits
`ok: false` and exits nonzero.

## Rollback

`deploy.ps1` automatically invokes rollback after a complete backup exists and
a later gate fails. An operator can also invoke it explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\rollback.ps1" `
  -BackupPath "D:\app\asuka\backups\v15-TIMESTAMP-RELEASE"
```

Rollback freezes Sync before Gateway, saves the failed runtime, ledger, logs,
status, and Vault memory, restores the previous runtime or complete runtime
backup, and restores configuration, task XML/state, and ACLs. Valid legacy
dual-write files produced after cutover are retained; only missing or invalid
ones are restored from backup.

Generated Vault content returns through a compensating commit. Current Notes,
Corrections/Overrides, and legacy human blocks are carried into the restored
pages. Rollback never uses `git reset`, force-push, or `git revert HEAD`.
Push failure leaves the compensation commit queued. Gateway must pass the same
startup gate before Memory Sync restarts.

Backups and `failed-cutover` evidence are intentionally retained for manual
audit and recovery.
