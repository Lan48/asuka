#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const opsRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-v15-assets-"));
const projectRoot = path.join(fixtureRoot, "project");
const qqbotRoot = path.join(projectRoot, "extensions", "qqbot");
const releaseOne = path.join(fixtureRoot, "release-one");
const releaseTwo = path.join(fixtureRoot, "release-two");

function write(relative, content) {
  const destination = path.join(qqbotRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeAbsolute(destination, content) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function generate(releaseRoot) {
  run(process.execPath, [
    path.join(opsRoot, "generate-manifest.mjs"),
    "--project-root", projectRoot,
    "--release-root", releaseRoot,
    "--release-id", "test-release",
    "--account", "default",
    "--peer", "user-1",
  ]);
  return JSON.parse(fs.readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
}

function assertManifestFiles(releaseRoot, entries) {
  for (const entry of entries) {
    const source = path.join(releaseRoot, ...entry.source.split("/"));
    assert.equal(fs.existsSync(source), true, `missing release file: ${entry.source}`);
    assert.equal(fs.statSync(source).size, entry.bytes, `size mismatch: ${entry.source}`);
    assert.equal(sha256(source), entry.sha256, `hash mismatch: ${entry.source}`);
  }
}

try {
  for (const directory of ["bin", "dist", "scripts", "skills", "src"]) {
    write(`${directory}/fixture-${directory}.txt`, `${directory}-current-worktree\n`);
  }
  write(
    "scripts/migrate-asuka-memory-v15.mjs",
    "process.stdout.write('current-worktree-migrator');\n",
  );
  write("src/node_modules/excluded.js", "must-not-ship\n");
  write("src/tests/excluded.test.js", "must-not-ship\n");
  write("package.json", "{\"name\":\"fixture-qqbot\"}\n");

  const first = generate(releaseOne);
  const second = generate(releaseTwo);

  assert.equal(first.appRoot, String.raw`D:\app\asuka`);
  assert.equal(first.releaseId, "test-release");
  assert.ok(first.runtimeFiles.length > 0);
  assert.ok(first.opsFiles.length > 0);
  assert.equal(
    fs.readFileSync(
      path.join(releaseOne, "payload", "qqbot", "scripts", "migrate-asuka-memory-v15.mjs"),
      "utf8",
    ),
    "process.stdout.write('current-worktree-migrator');\n",
  );
  assert.ok(
    first.runtimeFiles.every(
      (entry) => !entry.source.includes("/node_modules/") && !entry.source.includes("/tests/"),
    ),
    "runtime release must exclude node_modules and tests",
  );
  assert.ok(
    first.opsFiles.every((entry) => !entry.source.endsWith("/test-deployment-assets.mjs")),
    "release must exclude its self-test",
  );
  for (const required of [
    "ops/common.ps1",
    "ops/configure-memory-kernel.mjs",
    "ops/deploy.ps1",
    "ops/preflight.ps1",
    "ops/rollback.ps1",
    "ops/verify.ps1",
    "ops/restore-vault-generated.mjs",
    "ops/verify-ledger.mjs",
    "ops/verify-model-config.mjs",
  ]) {
    assert.ok(first.opsFiles.some((entry) => entry.source === required), `${required} not packaged`);
  }

  assertManifestFiles(releaseOne, [...first.runtimeFiles, ...first.opsFiles]);
  assert.deepEqual(
    first.runtimeFiles.map((entry) => entry.destination),
    [...first.runtimeFiles.map((entry) => entry.destination)].sort(),
    "runtime files must be sorted deterministically",
  );
  assert.deepEqual(
    first.opsFiles.map((entry) => entry.source),
    [...first.opsFiles.map((entry) => entry.source)].sort(),
    "ops files must be sorted deterministically",
  );
  assert.deepEqual(first.runtimeFiles, second.runtimeFiles);
  assert.deepEqual(first.opsFiles, second.opsFiles);
  assert.equal(first.source.runtimeTreeSha256, second.source.runtimeTreeSha256);

  const currentMemory = path.join(fixtureRoot, "vault-current", "Asuka", "Memory");
  const backupMemory = path.join(fixtureRoot, "vault-backup", "Asuka", "Memory");
  const generated = "<!-- ASUKA_MEMORY_V15_GENERATED -->";
  const notesStart = "<!-- ASUKA_MEMORY_NOTES_START -->";
  const notesEnd = "<!-- ASUKA_MEMORY_NOTES_END -->";
  const overridesStart = "<!-- ASUKA_MEMORY_OVERRIDES_START -->";
  const overridesEnd = "<!-- ASUKA_MEMORY_OVERRIDES_END -->";
  writeAbsolute(
    path.join(backupMemory, "entities", "home.md"),
    [
      generated,
      "# Backup generated home",
      notesStart,
      "backup note",
      notesEnd,
      overridesStart,
      "backup correction",
      overridesEnd,
      "",
    ].join("\n"),
  );
  writeAbsolute(
    path.join(currentMemory, "entities", "home.md"),
    [
      generated,
      "# V1.5 generated home",
      notesStart,
      "post-cutover user note",
      notesEnd,
      overridesStart,
      "post-cutover user correction",
      overridesEnd,
      "",
    ].join("\n"),
  );
  writeAbsolute(
    path.join(currentMemory, "entities", "generated-only.md"),
    `${generated}\n# Generated only\n`,
  );
  writeAbsolute(
    path.join(currentMemory, "entities", "manual-only.md"),
    `${generated}\n# Manual only\n${notesStart}\nkeep this note\n${notesEnd}\n`,
  );
  writeAbsolute(path.join(currentMemory, "user-page.md"), "# User page\nDo not remove.\n");
  const vaultRestore = run(process.execPath, [
    path.join(opsRoot, "restore-vault-generated.mjs"),
    currentMemory,
    backupMemory,
  ]);
  const vaultRestoreReport = JSON.parse(vaultRestore.stdout);
  const restoredHome = fs.readFileSync(
    path.join(currentMemory, "entities", "home.md"),
    "utf8",
  );
  assert.match(restoredHome, /Backup generated home/);
  assert.doesNotMatch(restoredHome, /V1\.5 generated home/);
  assert.match(restoredHome, /post-cutover user note/);
  assert.match(restoredHome, /post-cutover user correction/);
  assert.equal(fs.existsSync(path.join(currentMemory, "entities", "generated-only.md")), false);
  assert.match(
    fs.readFileSync(path.join(currentMemory, "entities", "manual-only.md"), "utf8"),
    /keep this note/,
  );
  assert.match(fs.readFileSync(path.join(currentMemory, "user-page.md"), "utf8"), /Do not remove/);
  assert.ok(vaultRestoreReport.removed.includes(path.join("entities", "generated-only.md")));
  assert.ok(vaultRestoreReport.retainedManualOnly.includes(path.join("entities", "manual-only.md")));

  const deploy = fs.readFileSync(path.join(opsRoot, "deploy.ps1"), "utf8");
  const preflight = fs.readFileSync(path.join(opsRoot, "preflight.ps1"), "utf8");
  const rollback = fs.readFileSync(path.join(opsRoot, "rollback.ps1"), "utf8");
  const verify = fs.readFileSync(path.join(opsRoot, "verify.ps1"), "utf8");
  const verifyLedger = fs.readFileSync(path.join(opsRoot, "verify-ledger.mjs"), "utf8");
  const common = fs.readFileSync(path.join(opsRoot, "common.ps1"), "utf8");
  const configureMemory = fs.readFileSync(
    path.join(opsRoot, "configure-memory-kernel.mjs"),
    "utf8",
  );
  const readme = fs.readFileSync(path.join(opsRoot, "README.md"), "utf8");
  const gatePlugin = path.join(fixtureRoot, "gate-plugin");
  writeAbsolute(path.join(gatePlugin, "package.json"), '{"type":"module"}\n');
  writeAbsolute(
    path.join(gatePlugin, "dist", "src", "asuka-memory-kernel", "ledger.js"),
    [
      'import fs from "node:fs";',
      "export class AsukaMemoryLedger {",
      "  constructor(database) {",
      '    this.gate = JSON.parse(fs.readFileSync(database, "utf8"));',
      "  }",
      "  integrityCheck() { return { ok: true, errors: [] }; }",
      "  getStats() { return { memory_events: 3 }; }",
      "  close() {}",
      "}",
      "",
    ].join("\n"),
  );
  writeAbsolute(
    path.join(gatePlugin, "dist", "src", "asuka-memory-kernel", "engine.js"),
    [
      "export class AsukaMemoryEngine {",
      "  constructor(ledger) { this.ledger = ledger; }",
      "}",
      "",
    ].join("\n"),
  );
  writeAbsolute(
    path.join(gatePlugin, "dist", "src", "asuka-memory-kernel", "legacy-migration.js"),
    [
      "export function getLegacyRejudgementGate(engine) {",
      "  return engine.ledger.gate;",
      "}",
      "",
    ].join("\n"),
  );
  const completeAllDiscardGate = {
    passed: true,
    blockers: [],
    events: { total: 3, eligible: 3, untracked: 0 },
    jobs: {
      total: 3,
      pending: 0,
      running: 0,
      completed: 3,
      failed: 0,
      attempts: 3,
    },
    extractions: { completed: 3, withClaims: 3, noMemory: 0 },
    consolidation: { status: "completed", runs: 1, outputClaims: 0 },
    coverage: { sourceEvents: 3, coveredSourceEvents: 3 },
    claims: {
      provisionalOpen: 0,
      active: 0,
      candidate: 0,
      historical: 3,
      versionRoots: 0,
    },
  };
  const runLedgerGateCase = (name, gate, expectedSuccess) => {
    const database = path.join(fixtureRoot, `gate-${name}.json`);
    writeAbsolute(database, `${JSON.stringify(gate)}\n`);
    const result = spawnSync(process.execPath, [
      path.join(opsRoot, "verify-ledger.mjs"),
      gatePlugin,
      database,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (expectedSuccess) {
      assert.equal(
        result.status,
        0,
        `${name} gate should pass: ${result.stderr || result.stdout}`,
      );
      return JSON.parse(result.stdout);
    }
    assert.notEqual(result.status, 0, `${name} gate must fail`);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /legacy rejudgement gate failed/i,
    );
    return undefined;
  };
  const rejectedGate = (blocker) => ({
    ...completeAllDiscardGate,
    passed: false,
    blockers: [blocker],
  });
  const allDiscardVerification = runLedgerGateCase(
    "complete-all-discard",
    completeAllDiscardGate,
    true,
  );
  assert.equal(allDiscardVerification.rejudgementGate.consolidation.outputClaims, 0);
  runLedgerGateCase(
    "missing-candidate",
    rejectedGate("legacy consolidation candidate coverage is incomplete or duplicated"),
    false,
  );
  runLedgerGateCase(
    "duplicated-candidate",
    rejectedGate("legacy consolidation candidate coverage is incomplete or duplicated"),
    false,
  );
  runLedgerGateCase(
    "reasonless-discard",
    rejectedGate("legacy consolidation discard audit lacks exact coverage or reason"),
    false,
  );
  runLedgerGateCase(
    "invalid-evidence",
    rejectedGate("legacy consolidation output claim has invalid evidence links"),
    false,
  );
  runLedgerGateCase(
    "missing-required-consolidation",
    {
      ...completeAllDiscardGate,
      consolidation: {
        ...completeAllDiscardGate.consolidation,
        status: "not_required",
      },
    },
    false,
  );
  const syncStop = deploy.indexOf("Disable-AndStopAsukaTask -Name $syncTaskName");
  const gatewayStop = deploy.indexOf("Disable-AndStopAsukaTask -Name $gatewayTaskName");
  const gatewayStart = deploy.indexOf("Start-ScheduledTask -TaskName $gatewayTaskName");
  const syncStart = deploy.indexOf("Start-ScheduledTask -TaskName $syncTaskName");
  const preflightRun = deploy.indexOf("$preflight = Invoke-AsukaNative");
  const rejudgementRun = deploy.indexOf('"--rejudge"');
  const rejudgementGate = deploy.indexOf("$rejudgementGate = $migrationReport.rejudgementGate");
  const memoryConfigRun = deploy.indexOf("$memoryConfigRun = Invoke-AsukaNative");
  const backupComplete = deploy.indexOf("$backupComplete = $true");
  const ledgerActivation = deploy.indexOf(
    "Move-Item -LiteralPath $ledgerNext -Destination $ledger",
  );
  assert.ok(
    preflightRun >= 0 && preflightRun < syncStop,
    "model-aware preflight must finish before deployment stops writers",
  );
  assert.ok(syncStop >= 0 && syncStop < gatewayStop, "deploy must stop Sync before Gateway");
  assert.ok(
    backupComplete >= 0
      && backupComplete < memoryConfigRun
      && memoryConfigRun < rejudgementRun,
    "memory kernel config must change only after backup and before migration",
  );
  assert.ok(
    rejudgementRun >= 0
      && rejudgementRun < rejudgementGate
      && rejudgementGate < ledgerActivation
      && ledgerActivation < gatewayStart,
    "legacy rejudgement gate must pass before ledger activation and Gateway startup",
  );
  assert.ok(
    gatewayStart >= 0 && gatewayStart < syncStart,
    "deploy must start Gateway before Sync",
  );
  for (const requiredFlag of ['"--rejudge"', '"--config"', '"--retry-failed"']) {
    assert.match(deploy, new RegExp(requiredFlag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(deploy, /\$rejudgementGate\.jobs\.pending\s+-ne 0/);
  assert.match(deploy, /\$rejudgementGate\.jobs\.running\s+-ne 0/);
  assert.match(deploy, /\$rejudgementGate\.jobs\.failed\s+-ne 0/);
  assert.match(deploy, /\$rejudgementGate\.claims\.provisionalOpen\s+-ne 0/);
  assert.match(deploy, /\$rejudgementGate\.extractions\.completed\s+-ne/);
  assert.match(deploy, /\$rejudgementGate\.consolidation\.status/);
  assert.match(deploy, /\$missingRequiredConsolidation/);
  assert.doesNotMatch(deploy, /consolidation\.outputClaims\s+-le 0/);
  assert.match(deploy, /\$rejudgementGate\.coverage\.coveredSourceEvents\s+-ne/);
  assert.match(deploy, /rejudgement\s*=\s*\$migrationReport\.rejudgement/);
  assert.match(deploy, /rejudgementGate\s*=\s*\$rejudgementGate/);
  assert.match(preflight, /verify-model-config\.mjs/);
  assert.match(preflight, /Existing OpenClaw configuration is invalid/);
  assert.match(preflight, /\$packagedPlugin/);
  assert.match(preflight, /networkCalls\s+-ne 0/);
  assert.match(preflight, /\[string\]\$FrozenBackupPath/);
  assert.match(preflight, /Read-AsukaFrozenBackup[\s\S]*-VerifyCurrentHashes/);
  assert.match(preflight, /must remain disabled and stopped after the frozen backup/);
  assert.match(preflight, /@\{upstream\}/);
  assert.doesNotMatch(preflight, /origin\/main/);
  assert.match(deploy, /\[string\]\$FrozenBackupPath/);
  assert.match(deploy, /\$preflightArguments \+= @\("-FrozenBackupPath"/);
  assert.match(deploy, /\$gatewaySnapshot\.wasRunning = \(/);
  assert.match(deploy, /frozenBackupPath = if \(\$null -eq \$frozenBackup\)/);
  assert.match(deploy, /Configured OpenClaw configuration is invalid/);
  assert.match(common, /function Read-AsukaFrozenBackup/);
  assert.match(common, /Current file changed after freeze/);
  assert.match(common, /scheduled-tasks\\\$GatewayTaskName\.xml/);
  assert.match(verify, /Persisted migration report is missing/);
  assert.match(verify, /\$migrationReport\.rejudgementGate/);
  assert.match(verify, /\$gate\.jobs\.pending\s+-ne 0/);
  assert.match(verify, /\$gate\.jobs\.running\s+-ne 0/);
  assert.match(verify, /\$gate\.jobs\.failed\s+-ne 0/);
  assert.match(verify, /\$gate\.claims\.provisionalOpen\s+-ne 0/);
  assert.match(verify, /\$gate\.extractions\.completed\s+-ne/);
  assert.match(verify, /\$gate\.consolidation\.status/);
  assert.match(verify, /\$missingRequiredConsolidation/);
  assert.doesNotMatch(verify, /consolidation\.outputClaims\s+-le 0/);
  assert.match(verify, /\$gate\.coverage\.coveredSourceEvents\s+-ne/);
  assert.match(verifyLedger, /getLegacyRejudgementGate/);
  assert.match(verifyLedger, /consolidationComplete/);
  assert.match(verifyLedger, /missingRequiredConsolidation/);
  assert.doesNotMatch(verifyLedger, /consolidation\.outputClaims\s*<\s*1/);
  assert.match(verifyLedger, /coverage\.coveredSourceEvents/);
  assert.match(configureMemory, /current\.model !== undefined/);
  assert.match(configureMemory, /retrievalMs:\s*1_500/);
  assert.match(configureMemory, /debounceMs:\s*currentWiki\.debounceMs \?\? 60_000/);
  assert.match(configureMemory, /migration\.identityId \?\? `private:/);
  assert.doesNotMatch(configureMemory, /apiKey\s*:/);
  assert.doesNotMatch(readme, /background LLM rejudgement/i);

  const configuredOpenClaw = path.join(fixtureRoot, "configured-openclaw.json");
  writeAbsolute(
    configuredOpenClaw,
    `${JSON.stringify({
      untouchedRoot: "keep-root",
      channels: {
        qqbot: {
          untouchedChannel: "keep-channel",
          memoryKernel: {
            model: {
              primary: {
                baseUrl: "https://memory.invalid",
                apiKey: "memory-secret",
                model: "memory-model",
              },
            },
            embedding: {
              baseUrl: "https://embedding.invalid",
              apiKey: "embedding-secret",
              model: "embedding-model",
            },
            enableVector: false,
            timeouts: {
              judgementMs: 45_000,
            },
            migration: {
              extractionMaxTokens: 7_000,
            },
            worker: {
              maxJobs: 10,
            },
            wiki: {
              title: "Existing Asuka",
            },
          },
        },
      },
    }, null, 2)}\n`,
  );
  const configureRun = run(process.execPath, [
    path.join(opsRoot, "configure-memory-kernel.mjs"),
    "--config", configuredOpenClaw,
    "--manifest", path.join(releaseOne, "manifest.json"),
  ]);
  const configureReport = JSON.parse(configureRun.stdout);
  const configured = JSON.parse(fs.readFileSync(configuredOpenClaw, "utf8"));
  const configuredKernel = configured.channels.qqbot.memoryKernel;
  assert.equal(configureReport.ok, true);
  assert.equal(configureReport.modelConfigurationPreserved, true);
  assert.doesNotMatch(configureRun.stdout, /memory-secret|embedding-secret/);
  assert.equal(configured.untouchedRoot, "keep-root");
  assert.equal(configured.channels.qqbot.untouchedChannel, "keep-channel");
  assert.equal(configuredKernel.enabled, true);
  assert.equal(
    configuredKernel.databasePath,
    String.raw`D:\app\asuka\home\.openclaw\qqbot\data\asuka-memory\memory-ledger.sqlite`,
  );
  assert.equal(configuredKernel.model.primary.apiKey, "memory-secret");
  assert.equal(configuredKernel.embedding.apiKey, "embedding-secret");
  assert.equal(configuredKernel.enableVector, false);
  assert.equal(configuredKernel.timeouts.judgementMs, 45_000);
  assert.equal(configuredKernel.timeouts.retrievalMs, 1_500);
  assert.equal(configuredKernel.timeouts.rerankTaskMs, 60_000);
  assert.equal(configuredKernel.migration.extractionMaxTokens, 7_000);
  assert.equal(configuredKernel.migration.consolidationMaxTokens, 9_000);
  assert.equal(configuredKernel.worker.enabled, true);
  assert.equal(configuredKernel.worker.maxJobs, 10);
  assert.equal(configuredKernel.worker.intervalMs, 1_000);
  assert.equal(configuredKernel.wiki.enabled, true);
  assert.equal(
    configuredKernel.wiki.memoryRoot,
    String.raw`D:\app\asuka\obsidian-vault\Asuka\Memory`,
  );
  assert.equal(configuredKernel.wiki.title, "Existing Asuka");
  assert.equal(configuredKernel.wiki.identityId, "private:default:user-1");
  assert.equal(configuredKernel.wiki.accountId, "default");
  assert.equal(configuredKernel.wiki.peerId, "user-1");
  assert.equal(configuredKernel.wiki.debounceMs, 60_000);
  assert.equal(configuredKernel.wiki.overrideImportIntervalMs, 60_000);

  const rollbackSyncStop = rollback.indexOf("Disable-AndStopAsukaTask -Name $syncTaskName");
  const rollbackGatewayStop = rollback.indexOf("Disable-AndStopAsukaTask -Name $gatewayTaskName");
  const rollbackGatewayStart = rollback.indexOf("Start-ScheduledTask -TaskName $gatewayTaskName");
  const rollbackSyncStart = rollback.indexOf("Start-ScheduledTask -TaskName $syncTaskName");
  assert.ok(
    rollbackSyncStop >= 0 && rollbackSyncStop < rollbackGatewayStop,
    "rollback must stop Sync before Gateway",
  );
  assert.ok(
    rollbackGatewayStart >= 0 && rollbackGatewayStart < rollbackSyncStart,
    "rollback must start Gateway before Sync",
  );
  assert.match(rollback, /restore-vault-generated\.mjs/);
  assert.match(rollback, /compensate Asuka v1\.5 rollback/);
  assert.match(rollback, /ASUKA_MEMORY_NOTES_START|Restore-AsukaGeneratedCache/);

  const probePlugin = path.join(fixtureRoot, "probe-plugin");
  const probeConfig = path.join(fixtureRoot, "probe-openclaw.json");
  writeAbsolute(path.join(probePlugin, "package.json"), '{"type":"module"}\n');
  writeAbsolute(
    path.join(probePlugin, "dist", "src", "config.js"),
    [
      "export function resolveQQBotSceneInferenceConfig() {",
      "  return {",
      "    primary: { baseUrl: 'https://scene.invalid', apiKey: 'scene', model: 'scene-model' },",
      "    fallback: null,",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  writeAbsolute(
    path.join(probePlugin, "dist", "src", "asuka-memory-kernel", "model-client.js"),
    [
      "export function createOpenAICompatibleMemoryModelClient(options) {",
      "  const candidates = [options.primary, options.fallback].filter((item) =>",
      "    item && item.baseUrl && item.apiKey && item.model",
      "  );",
      "  return { status: {",
      "    completion: candidates.length ? 'ready' : 'unavailable',",
      "    completionModels: candidates.length,",
      "  } };",
      "}",
      "",
    ].join("\n"),
  );
  writeAbsolute(
    probeConfig,
    JSON.stringify({
      channels: {
        qqbot: {
          memoryKernel: {
            model: {
              primary: {
                baseUrl: "https://kernel.invalid",
                apiKey: "kernel",
                model: "kernel-model",
              },
            },
          },
        },
      },
    }),
  );
  const modelProbe = run(process.execPath, [
    path.join(opsRoot, "verify-model-config.mjs"),
    probePlugin,
    probeConfig,
    "default",
  ]);
  const modelProbeReport = JSON.parse(modelProbe.stdout);
  assert.equal(modelProbeReport.completion, "ready");
  assert.equal(modelProbeReport.primary.source, "memoryKernel.model.primary");
  assert.equal(modelProbeReport.primary.model, "kernel-model");
  assert.equal(modelProbeReport.networkCalls, 0);

  const powershellSources = fs.readdirSync(opsRoot)
    .filter((name) => name.endsWith(".ps1"))
    .map((name) => fs.readFileSync(path.join(opsRoot, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(powershellSources, /\bgit\s+reset\b/i);
  assert.doesNotMatch(powershellSources, /\bgit\s+revert\s+HEAD\b/i);
  assert.doesNotMatch(powershellSources, /\bpush\b[^\r\n]*--force(?:-with-lease)?\b/i);

  for (const script of [
    "configure-memory-kernel.mjs",
    "generate-manifest.mjs",
    "restore-vault-generated.mjs",
    "verify-ledger.mjs",
    "verify-model-config.mjs",
  ]) {
    run(process.execPath, ["--check", path.join(opsRoot, script)]);
  }

  const parser = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
    : ["pwsh", "-NoProfile", "-NonInteractive", "-Command"];
  const parserProbe = spawnSync(parser[0], ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8",
  });
  if (parserProbe.status === 0) {
    for (const name of fs.readdirSync(opsRoot).filter((entry) => entry.endsWith(".ps1"))) {
      const script = path.join(opsRoot, name).replace(/'/g, "''");
      const command = [
        "$tokens = $null",
        "$errors = $null",
        `$null = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$tokens, [ref]$errors)`,
        "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
      ].join("; ");
      run(parser[0], [...parser.slice(1), command], { cwd: opsRoot });
    }
    process.stdout.write("PowerShell parser validation passed.\n");
  } else {
    process.stdout.write("PowerShell parser validation skipped: pwsh/powershell is unavailable.\n");
  }

  process.stdout.write("Asuka Memory v1.5 deployment asset tests passed.\n");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
