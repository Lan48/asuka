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

## Build the release locally

Build QQBot first so `dist` matches `src`, then generate a release from the
current working tree:

```text
node ops/windows/asuka-memory-v15/generate-manifest.mjs ^
  --project-root C:\path\to\openclaw-clawra ^
  --release-root C:\path\to\asuka-memory-v15-release ^
  --release-id asuka-memory-v15-YYYYMMDD ^
  --account default ^
  --peer USER_ID
```

Add `--identity IDENTITY_ID` when the same person is linked across channels.
The generator copies the current working-tree runtime, not Git `HEAD`, and
writes SHA-256 entries for every packaged runtime and operational file.
`node_modules`, tests, symlinks, and `.git` are excluded.

The known host defaults can be overridden without changing scripts:
`--app-root`, `--openclaw-version`, `--node-version`, `--gateway-port`,
`--gateway-task`, and `--sync-task`. All operational scripts consume these
values from the hashed release inventory instead of repeating them.

Transfer the generated directory to a release directory below
`D:\app\asuka`, preserving `manifest.json`, `payload`, and `ops`.

## Freeze and seal the backup

For a new maintenance window, freeze both writers and create the full backup
from an elevated 64-bit Windows PowerShell 5.1 session:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\freeze-and-backup-v15.ps1" `
  -AppRoot "D:\app\asuka" -ReleaseId "adaptive-memory-kernel"
```

The current remote frozen backup predates the complete file inventory. Seal it
once before preflight:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$frozen = "D:\app\asuka\backups\v15-20260727-124326-adaptive-memory-kernel"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\freeze-and-backup-v15.ps1" `
  -AppRoot "D:\app\asuka" -SealExistingBackupPath $frozen
```

Seal mode adds and verifies `backup-files.json` and
`backup-complete.marker`. It preserves `backup-manifest.json`, including its
original `tasksBefore` rollback intent, and neither inspects nor changes the
current Scheduled Task state.

## Preflight and deploy

Run from an elevated 64-bit Windows PowerShell 5.1 session:

```powershell
$release = "D:\app\asuka\releases\asuka-memory-v15-YYYYMMDD"
$frozen = "D:\app\asuka\backups\v15-TIMESTAMP-adaptive-memory-kernel"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "$release\ops\normalize-task-actions.ps1" `
  -AppRoot "D:\app\asuka" -FrozenBackupPath $frozen
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\preflight.ps1" `
  -ReleaseRoot $release -FrozenBackupPath $frozen
powershell -NoProfile -ExecutionPolicy Bypass -File "$release\ops\deploy.ps1" `
  -ReleaseRoot $release -FrozenBackupPath $frozen
```

`normalize-task-actions.ps1` is required when an existing task uses the
ambiguous bare `powershell.exe` command. It first validates the frozen backup,
the stopped task state, and the unchanged `-File` arguments, exports the
original task XML under `D:\app\asuka\run\task-action-normalization`, and then
changes only `Execute` to the absolute `$PSHOME\powershell.exe` path. It never
starts a task and restores the exported XML if normalization fails.

Preflight validates release hashes, pinned Node/OpenClaw versions, free space,
task actions and state, Gateway health, the sync lock, Vault cleanliness, and
Vault convergence with the current branch's configured upstream. It resolves the configured completion
model through the packaged runtime without making a model request. Before
stopping either task, it also uses the Windows PowerShell parser to reject any
packaged `.ps1` with syntax errors.

`-FrozenBackupPath` is the normal path for this rollout because the maintenance
window stopped Gateway and Memory Sync before local implementation began. It
requires the tasks and port to remain stopped, validates the complete frozen
backup plus its critical hashes, and carries the pre-freeze running/enabled
task intent into rollback and post-cutover startup. Omitting it retains the
live-baseline mode for a future deployment that has not already been frozen.

If GitHub is temporarily unreachable but the operator has independently
confirmed that the remote and local Vault are at the same commit, pass
`-SkipVaultRemoteGate` to both commands. This bypasses only the remote
convergence check. It does not bypass local cleanliness or conflict checks.

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
4. Migrates frozen legacy sources into `memory-ledger.sqlite.next`, extracts
   candidates from every eligible record, then globally consolidates all
   candidates in each identity/visibility scope with the configured LLM.
5. Requires SQLite integrity, foreign-key integrity, zero skipped records, a
   source map for every discovered legacy record, zero pending/running/failed
   extraction jobs, complete source/evidence coverage, exactly one consolidated
   result or audited discard reason for every candidate, and zero open
   provisional migration claims. A fully audited all-discard result is valid.
6. Atomically activates the staged QQBot runtime and ledger only after the
   extraction and consolidation gate passes.
7. Compiles and lints Memory Wiki.
8. Starts and verifies Gateway before Memory Sync is allowed to start.

Choice A is a one-time full reorganization: legacy facts, inferred material,
state, digests, reference indexes, and session evidence enter the new ledger
with provenance. Candidate extraction and global consolidation finish
synchronously on the staged ledger. Neither the formal ledger nor Gateway is
activated while an extraction job, unaccounted evidence item, incomplete
consolidation run, or provisional migration claim remains open.

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
