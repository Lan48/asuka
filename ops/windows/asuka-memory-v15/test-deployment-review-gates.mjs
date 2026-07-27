#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const common = read("common.ps1");
const deploy = read("deploy.ps1");
const freeze = read("freeze-and-backup-v15.ps1");
const generateManifest = read("generate-manifest.mjs");
const normalize = read("normalize-task-actions.ps1");
const preflight = read("preflight.ps1");
const rollback = read("rollback.ps1");
const verify = read("verify.ps1");

const index = (source, marker, label) => {
  const value = source.indexOf(marker);
  assert.notEqual(value, -1, `${label}: missing ${marker}`);
  return value;
};

const deployLock = index(deploy, "Enter-AsukaDeploymentLock", "deploy lock");
const deployPreflight = index(deploy, "$preflight = Invoke-AsukaNative", "deploy preflight");
assert.ok(
  deployLock < deployPreflight,
  "deploy must acquire the shared lock before preflight and trusted-input validation",
);
assert.match(preflight, /Enter-AsukaDeploymentLock/);
assert.match(freeze, /Enter-AsukaDeploymentLock/);
assert.match(normalize, /Enter-AsukaDeploymentLock/);
assert.match(rollback, /Enter-AsukaDeploymentLock/);

assert.match(deploy, /run\\deployments/);
assert.match(rollback, /run\\deployments/);
assert.doesNotMatch(deploy, /Join-Path \$backupPath "migration/);
assert.doesNotMatch(deploy, /Join-Path \$backupPath "deployment-state\.json"/);
assert.doesNotMatch(rollback, /Join-Path \$BackupPath "failed-cutover/);
assert.doesNotMatch(rollback, /Join-Path \$BackupPath "rollback-state\.json"/);

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
assert.match(common, /nodeVersion[\s\S]*\^v\[0-9\]\+/);
assert.match(common, /required release helper/i);
assert.match(common, /runtimeDependencyTree/);
assert.match(common, /unmanifested release file/i);

assert.match(generateManifest, /buildAttestation/);
assert.match(generateManifest, /runtimeDependencyTree/);
assert.match(generateManifest, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/);
assert.match(generateManifest, /linked worktree/i);

assert.match(preflight, /\$PSVersionTable\.PSEdition[\s\S]*Desktop/);
assert.match(preflight, /\$PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/);
assert.match(preflight, /\$PSVersionTable\.PSVersion\.Minor[\s\S]*-ne 1/);
assert.match(preflight, /\[Environment\]::Is64BitProcess/);

assert.match(rollback, /pre-existing Asuka\/Memory changes/i);
assert.match(rollback, /activation-journal\.json/);
assert.match(rollback, /rollback\.next\.[^"]*NewGuid/);
assert.match(rollback, /gateway snapshot task name does not match/i);
assert.match(rollback, /sync snapshot task name does not match/i);
assert.match(rollback, /Quarantine-AsukaInvalidLegacyFile/);

assert.match(deploy, /Assert-AsukaJsonBoolean[\s\S]*rejudgementGate/);
assert.match(verify, /Assert-AsukaJsonBoolean[\s\S]*gate/);
assert.match(verify, /reportSha256[\s\S]*Get-AsukaSha256/);

process.stdout.write("Asuka Memory v1.5 review regression gates passed.\n");
