#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const opsRoot = path.dirname(fileURLToPath(import.meta.url));
const localEmbeddingContractPath = path.join(
  opsRoot,
  "local-embedding-contract.json",
);
const localEmbeddingContract = JSON.parse(
  fs.readFileSync(localEmbeddingContractPath, "utf8"),
);
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-v15-assets-"));
const projectRoot = path.join(fixtureRoot, "project");
const buildRoot = path.join(fixtureRoot, "build-worktree");
const qqbotRoot = path.join(projectRoot, "extensions", "qqbot");
const releaseOne = path.join(fixtureRoot, "release-one");
const releaseTwo = path.join(fixtureRoot, "release-two");
const releaseUnknown = path.join(fixtureRoot, "release-unknown");
const releaseTampered = path.join(fixtureRoot, "release-tampered");
const occupiedRelease = path.join(fixtureRoot, "release-occupied");
const buildAttestationPath = path.join(fixtureRoot, "build-attestation.json");
const windowsDependencyAttestationPath = path.join(
  fixtureRoot,
  "windows-dependency-attestation.json",
);
const npmCliPath = (root) => path.join(
  root,
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const configuredNpmCli = npmCliPath(path.join(fixtureRoot, "configured-npm"));
const baseEnvironment = { ...process.env };
for (const name of Object.keys(baseEnvironment)) {
  if (name.toLowerCase() === "npm_execpath") delete baseEnvironment[name];
}
const npmEnvironment = {
  ...baseEnvironment,
  npm_execpath: configuredNpmCli,
};

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
    env: npmEnvironment,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runFailure(command, args, pattern, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: npmEnvironment,
    ...options,
  });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} must fail`);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern);
  return result;
}

function generate(releaseRoot, sourceRoot = buildRoot) {
  run(process.execPath, [
    path.join(opsRoot, "generate-manifest.mjs"),
    "--project-root", sourceRoot,
    "--release-root", releaseRoot,
    "--release-id", "test-release",
    "--account", "default",
    "--peer", "user-1",
    "--node-version", process.version,
    "--build-attestation", buildAttestationPath,
    "--windows-dependency-attestation", windowsDependencyAttestationPath,
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

function assertInstalledWorker(appRoot, worker) {
  const destination = path.join(appRoot, ...worker.destination.split("/"));
  assert.equal(fs.existsSync(destination), true, "installed sync worker is missing");
  assert.equal(fs.statSync(destination).size, worker.bytes, "installed sync worker size mismatch");
  assert.equal(sha256(destination), worker.sha256, "installed sync worker hash mismatch");
}

try {
  const npmCliFixture = [
    'import path from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "const command = process.argv[2];",
    "if (command === \"--version\") {",
    '  process.stdout.write("11.16.0\\n");',
    "} else if (command === \"test\") {",
    '  await import(pathToFileURL(path.resolve("scripts/build-fixture.mjs")).href);',
    "} else if (command !== \"ci\") {",
    "  throw new Error(`unexpected npm fixture command: ${command}`);",
    "}",
    "",
  ].join("\n");
  writeAbsolute(configuredNpmCli, npmCliFixture);

  const fallbackNode = path.join(
    fixtureRoot,
    "node-with-npm",
    path.basename(process.execPath),
  );
  fs.mkdirSync(path.dirname(fallbackNode), { recursive: true });
  fs.copyFileSync(process.execPath, fallbackNode);
  fs.chmodSync(fallbackNode, fs.statSync(process.execPath).mode);
  writeAbsolute(npmCliPath(path.dirname(fallbackNode)), npmCliFixture);

  for (const directory of ["bin", "scripts", "skills", "src"]) {
    write(`${directory}/fixture-${directory}.txt`, `${directory}-current-worktree\n`);
  }
  write(
    "scripts/migrate-asuka-memory-v15.mjs",
    "process.stdout.write('current-worktree-migrator');\n",
  );
  write(
    "scripts/build-fixture.mjs",
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'if (!fs.existsSync(path.resolve("node_modules", ".vendored-cron-patched"))) {',
      '  throw new Error("vendored cron patch must run before tests");',
      "}",
      'const root = path.resolve("dist");',
      'fs.mkdirSync(path.join(root, "src", "asuka-memory-kernel"), { recursive: true });',
      'fs.writeFileSync(path.join(root, "index.js"), "export {};\\n");',
      'fs.writeFileSync(path.join(root, "src", "config.js"), "export {};\\n");',
      'fs.writeFileSync(',
      '  path.join(root, "src", "asuka-memory-kernel", "model-client.js"),',
      '  "export {};\\n",',
      ");",
      "",
    ].join("\n"),
  );
  write(
    "scripts/patch-runtime-cron.mjs",
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'if (process.argv.length !== 3 || process.argv[2] !== "--vendored-only") {',
      '  throw new Error("fixture patch must be vendored-only");',
      "}",
      'fs.mkdirSync(path.resolve("node_modules"), { recursive: true });',
      'fs.writeFileSync(path.resolve("node_modules", ".vendored-cron-patched"), "ok\\n");',
      "",
    ].join("\n"),
  );
  write("src/node_modules/excluded.js", "must-not-ship\n");
  write("src/tests/excluded.test.js", "must-not-ship\n");
  write(
    "package.json",
    `${JSON.stringify({
      name: "fixture-qqbot",
      version: "1.0.0",
      scripts: { test: "node scripts/build-fixture.mjs" },
    }, null, 2)}\n`,
  );
  write(
    "package-lock.json",
    `${JSON.stringify({
      name: "fixture-qqbot",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture-qqbot",
          version: "1.0.0",
        },
      },
    }, null, 2)}\n`,
  );
  writeAbsolute(path.join(projectRoot, ".gitignore"), "**/dist/\n**/node_modules/\n");
  fs.cpSync(
    opsRoot,
    path.join(projectRoot, "ops", "windows", "asuka-memory-v15"),
    { recursive: true },
  );

  run("git", ["init"]);
  run("git", ["config", "core.autocrlf", "false"]);
  run("git", ["add", "."]);
  run("git", [
    "-c", "user.name=Asuka Fixture",
    "-c", "user.email=asuka-fixture.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-m", "fixture",
  ]);
  run("git", ["worktree", "add", "-b", "fixture-release", buildRoot, "HEAD"]);
  const attestationArgs = (output) => [
    path.join(opsRoot, "attest-release-build.mjs"),
    "--kind", "build",
    "--project-root", buildRoot,
    "--output", output,
  ];
  const invalidNpmCliDirectory = npmCliPath(path.join(fixtureRoot, "directory-npm"));
  fs.mkdirSync(invalidNpmCliDirectory, { recursive: true });
  runFailure(
    process.execPath,
    attestationArgs(path.join(fixtureRoot, "directory-attestation.json")),
    /npm CLI must be a regular file/i,
    {
      env: { ...baseEnvironment, npm_execpath: invalidNpmCliDirectory },
    },
  );
  const linkedNpmCli = npmCliPath(path.join(fixtureRoot, "linked-npm"));
  fs.mkdirSync(path.dirname(linkedNpmCli), { recursive: true });
  const linkedNpmCliTarget = path.join(fixtureRoot, "linked-npm-target");
  fs.mkdirSync(linkedNpmCliTarget);
  fs.symlinkSync(linkedNpmCliTarget, linkedNpmCli, "junction");
  runFailure(
    process.execPath,
    attestationArgs(path.join(fixtureRoot, "linked-attestation.json")),
    /npm CLI must be a regular file/i,
    {
      env: { ...baseEnvironment, npm_execpath: linkedNpmCli },
    },
  );
  const untrustedNpmCli = path.join(fixtureRoot, "untrusted-npm-cli.js");
  fs.writeFileSync(untrustedNpmCli, npmCliFixture);
  runFailure(
    process.execPath,
    attestationArgs(path.join(fixtureRoot, "untrusted-attestation.json")),
    /npm_execpath must identify a trusted npm CLI path/i,
    {
      env: { ...baseEnvironment, npm_execpath: untrustedNpmCli },
    },
  );
  runFailure(
    process.execPath,
    attestationArgs(path.join(fixtureRoot, "missing-attestation.json")),
    /npm CLI is missing/i,
    {
      env: {
        ...baseEnvironment,
        npm_execpath: npmCliPath(path.join(fixtureRoot, "missing-npm")),
      },
    },
  );
  run(fallbackNode, attestationArgs(buildAttestationPath), {
    env: baseEnvironment,
  });
  const buildAttestation = JSON.parse(
    fs.readFileSync(buildAttestationPath, "utf8"),
  );
  writeAbsolute(
    windowsDependencyAttestationPath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "windows_runtime_dependencies",
      mode: "clean_linked_worktree",
      gitCommit: buildAttestation.gitCommit,
      gitBranch: buildAttestation.gitBranch,
      platform: "win32",
      architecture: "x64",
      nodeVersion: buildAttestation.nodeVersion,
      npmVersion: buildAttestation.npmVersion,
      lockfilePath: buildAttestation.lockfilePath,
      lockfileSha256: buildAttestation.lockfileSha256,
      commands: [
        "npm ci --ignore-scripts",
        "node scripts/patch-runtime-cron.mjs --vendored-only",
      ],
      runtimeDependencyTree: {
        path: "node_modules",
        fileCount: 1,
        bytes: 1,
        sha256: "0".repeat(64),
      },
    }, null, 2)}\n`,
  );

  const first = generate(releaseOne);
  const second = generate(releaseTwo);
  const {
    contractSource: embeddingContractSource,
    contractSha256: embeddingContractSha256,
    ...manifestEmbeddingContract
  } = first.requirements.embedding;
  assert.equal(first.source.provenance, "git");
  assert.match(first.source.gitCommit, /^[a-f0-9]{40}$/);
  assert.ok(first.source.gitBranch.length > 0);
  assert.equal(first.source.buildAttestation.runtimeTreeSha256, first.source.runtimeTreeSha256);
  assert.equal(first.source.windowsDependencyAttestation.platform, "win32");
  assert.equal(first.runtimeDependencyTree.architecture, "x64");
  assert.equal(embeddingContractSource, "ops/local-embedding-contract.json");
  assert.equal(
    embeddingContractSha256,
    sha256(path.join(
      buildRoot,
      "ops",
      "windows",
      "asuka-memory-v15",
      "local-embedding-contract.json",
    )),
  );
  assert.deepEqual(manifestEmbeddingContract, localEmbeddingContract);
  assert.equal(
    manifestEmbeddingContract.model.family,
    "jina-embeddings-v5-text-small",
  );
  assert.equal(manifestEmbeddingContract.model.task, "retrieval");
  assert.equal(manifestEmbeddingContract.model.dimensions, 1_024);
  assert.equal(manifestEmbeddingContract.model.license, "CC-BY-NC-4.0");
  assert.equal(
    manifestEmbeddingContract.api.endpoint,
    "http://127.0.0.1:11434/v1/embeddings",
  );

  fs.mkdirSync(occupiedRelease);
  const sentinel = path.join(occupiedRelease, "do-not-delete.txt");
  fs.writeFileSync(sentinel, "preserve-me\n");
  runFailure(process.execPath, [
    path.join(opsRoot, "generate-manifest.mjs"),
    "--project-root", buildRoot,
    "--release-root", occupiedRelease,
    "--release-id", "occupied-release",
    "--account", "default",
    "--peer", "user-1",
    "--node-version", process.version,
    "--build-attestation", buildAttestationPath,
    "--windows-dependency-attestation", windowsDependencyAttestationPath,
  ], /release root already exists/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve-me\n");
  assert.equal(fs.existsSync(path.join(occupiedRelease, "manifest.json")), false);

  runFailure(process.execPath, [
    path.join(opsRoot, "generate-manifest.mjs"),
    "--project-root", fixtureRoot,
    "--release-root", path.join(fixtureRoot, "release-no-git"),
    "--release-id", "unknown-release",
    "--account", "default",
    "--peer", "user-1",
    "--node-version", process.version,
    "--build-attestation", buildAttestationPath,
    "--windows-dependency-attestation", windowsDependencyAttestationPath,
  ], /unable to read source commit from Git/i);

  const distIndex = path.join(buildRoot, "extensions", "qqbot", "dist", "index.js");
  const distBeforeTamper = fs.readFileSync(distIndex);
  fs.appendFileSync(distIndex, "// ignored tamper\n");
  runFailure(process.execPath, [
    path.join(opsRoot, "generate-manifest.mjs"),
    "--project-root", buildRoot,
    "--release-root", releaseTampered,
    "--release-id", "tampered-release",
    "--account", "default",
    "--peer", "user-1",
    "--node-version", process.version,
    "--build-attestation", buildAttestationPath,
    "--windows-dependency-attestation", windowsDependencyAttestationPath,
  ], /build attestation does not match/i);
  fs.writeFileSync(distIndex, distBeforeTamper);

  const unknown = structuredClone(first);
  unknown.source.provenance = "unknown";
  fs.mkdirSync(releaseUnknown);
  fs.writeFileSync(
    path.join(releaseUnknown, "manifest.json"),
    `${JSON.stringify(unknown, null, 2)}\n`,
  );

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
    first.opsFiles.every((entry) => !/\/test-[^/]+\.mjs$/.test(entry.source)),
    "release must exclude executable test fixtures",
  );
  const requiredExecutableHelpers = [
    "ops/asuka-memory-sync.ps1",
    "ops/common.ps1",
    "ops/configure-memory-kernel.mjs",
    "ops/create-recovery-baseline.ps1",
    "ops/deploy.ps1",
    "ops/freeze-and-backup-v15.ps1",
    "ops/install-local-embedding.ps1",
    "ops/local-embedding-contract.json",
    "ops/normalize-task-actions.ps1",
    "ops/preflight.ps1",
    "ops/recover-v15-baseline.ps1",
    "ops/restore-vault-generated.mjs",
    "ops/rollback.ps1",
    "ops/start-local-embedding.ps1",
    "ops/verify-ledger.mjs",
    "ops/verify-model-config.mjs",
    "ops/verify.ps1",
  ];
  assert.deepEqual(first.requiredExecutableHelpers, requiredExecutableHelpers);
  for (const required of requiredExecutableHelpers) {
    assert.ok(first.opsFiles.some((entry) => entry.source === required), `${required} not packaged`);
  }

  assertManifestFiles(releaseOne, [...first.runtimeFiles, ...first.opsFiles]);
  const syncWorkerEntry = first.opsFiles.find(
    (entry) => entry.source === "ops/asuka-memory-sync.ps1",
  );
  assert.deepEqual(first.syncWorker, {
    source: syncWorkerEntry.source,
    destination: "asuka-memory-sync.ps1",
    bytes: syncWorkerEntry.bytes,
    sha256: syncWorkerEntry.sha256,
  });
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
  assert.deepEqual(first.syncWorker, second.syncWorker);
  assert.equal(first.source.runtimeTreeSha256, second.source.runtimeTreeSha256);

  const secondWorker = path.join(releaseTwo, ...second.syncWorker.source.split("/"));
  const mutatedPackagedWorker = fs.readFileSync(secondWorker);
  mutatedPackagedWorker[0] ^= 1;
  fs.writeFileSync(secondWorker, mutatedPackagedWorker);
  assert.throws(
    () => assertManifestFiles(releaseTwo, [second.syncWorker]),
    /hash mismatch: ops\/asuka-memory-sync\.ps1/,
  );
  fs.rmSync(secondWorker);
  assert.throws(
    () => assertManifestFiles(releaseTwo, [second.syncWorker]),
    /missing release file: ops\/asuka-memory-sync\.ps1/,
  );

  const installedRoot = path.join(fixtureRoot, "installed");
  const installedWorker = path.join(
    installedRoot,
    ...first.syncWorker.destination.split("/"),
  );
  fs.mkdirSync(path.dirname(installedWorker), { recursive: true });
  fs.copyFileSync(
    path.join(releaseOne, ...first.syncWorker.source.split("/")),
    installedWorker,
  );
  assertInstalledWorker(installedRoot, first.syncWorker);
  const mutatedInstalledWorker = fs.readFileSync(installedWorker);
  mutatedInstalledWorker[0] ^= 1;
  fs.writeFileSync(installedWorker, mutatedInstalledWorker);
  assert.throws(
    () => assertInstalledWorker(installedRoot, first.syncWorker),
    /installed sync worker hash mismatch/,
  );
  fs.rmSync(installedWorker);
  assert.throws(
    () => assertInstalledWorker(installedRoot, first.syncWorker),
    /installed sync worker is missing/,
  );

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
  const freeze = fs.readFileSync(
    path.join(opsRoot, "freeze-and-backup-v15.ps1"),
    "utf8",
  );
  const preflight = fs.readFileSync(path.join(opsRoot, "preflight.ps1"), "utf8");
  const rollback = fs.readFileSync(path.join(opsRoot, "rollback.ps1"), "utf8");
  const verify = fs.readFileSync(path.join(opsRoot, "verify.ps1"), "utf8");
  const createRecoveryBaseline = fs.readFileSync(
    path.join(opsRoot, "create-recovery-baseline.ps1"),
    "utf8",
  );
  const recoverBaseline = fs.readFileSync(
    path.join(opsRoot, "recover-v15-baseline.ps1"),
    "utf8",
  );
  const verifyLedger = fs.readFileSync(path.join(opsRoot, "verify-ledger.mjs"), "utf8");
  const normalizeTaskActions = fs.readFileSync(
    path.join(opsRoot, "normalize-task-actions.ps1"),
    "utf8",
  );
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
      "  getLegacyProjectionStatus() {",
      "    return this.gate.projectionOutbox",
      "      ?? { degraded: false, pendingCount: 0, failedCount: 0 };",
      "  }",
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
  const runLedgerGateCase = (
    name,
    gate,
    expectedSuccess,
    expectedError = /legacy rejudgement gate failed/i,
  ) => {
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
      expectedError,
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
    true,
  );
  runLedgerGateCase(
    "duplicated-candidate",
    rejectedGate("legacy consolidation candidate coverage is incomplete or duplicated"),
    true,
  );
  runLedgerGateCase(
    "reasonless-discard",
    rejectedGate("legacy consolidation discard audit lacks exact coverage or reason"),
    true,
  );
  runLedgerGateCase(
    "invalid-evidence",
    rejectedGate("legacy consolidation output claim has invalid evidence links"),
    true,
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
    true,
  );
  runLedgerGateCase(
    "projection-pending",
    {
      ...completeAllDiscardGate,
      projectionOutbox: { degraded: false, pendingCount: 1, failedCount: 0 },
    },
    false,
    /legacy projection outbox is not drained/i,
  );
  runLedgerGateCase(
    "projection-failed",
    {
      ...completeAllDiscardGate,
      projectionOutbox: { degraded: true, pendingCount: 1, failedCount: 1 },
    },
    false,
    /legacy projection outbox is not drained/i,
  );
  const syncStop = deploy.indexOf("Disable-AndStopAsukaTask -Name $syncTaskName");
  const gatewayStop = deploy.indexOf("Disable-AndStopAsukaTask -Name $gatewayTaskName");
  const gatewayStart = deploy.indexOf("Start-ScheduledTask -TaskName $gatewayTaskName");
  const syncStart = deploy.indexOf("Start-ScheduledTask -TaskName $syncTaskName");
  const preflightRun = deploy.indexOf("$preflight = Invoke-AsukaLockedScript");
  const rejudgementGate = deploy.indexOf("$rejudgementGate = $migrationReport.rejudgementGate");
  const memoryConfigRun = deploy.indexOf("$memoryConfigRun = Invoke-AsukaNative");
  const backupComplete = deploy.indexOf("$backupComplete = $true");
  const syncWorkerInstall = deploy.indexOf(
    "Copy-Item -LiteralPath $packagedSyncScript -Destination $syncScript -Force",
  );
  const ledgerActivation = deploy.indexOf(
    "Move-Item -LiteralPath $ledgerNext -Destination $ledger",
  );
  const activeState = deploy.indexOf('$deploymentState["phase"] = "active"');
  assert.ok(
    preflightRun >= 0 && preflightRun < syncStop,
    "model-aware preflight must finish before deployment stops writers",
  );
  assert.ok(syncStop >= 0 && syncStop < gatewayStop, "deploy must stop Sync before Gateway");
  assert.ok(
    gatewayStop < syncWorkerInstall && syncWorkerInstall < gatewayStart,
    "deploy must install the packaged sync worker only while both tasks are stopped",
  );
  assert.ok(
    backupComplete >= 0
      && backupComplete < memoryConfigRun
      && memoryConfigRun < ledgerActivation,
    "memory kernel config must change only after backup and before migration",
  );
  assert.ok(
    rejudgementGate >= 0
      && rejudgementGate < ledgerActivation
      && ledgerActivation < gatewayStart,
    "legacy rejudgement state must be recorded before ledger activation and Gateway startup",
  );
  assert.ok(
    gatewayStart >= 0 && gatewayStart < syncStart,
    "deploy must start Gateway before Sync",
  );
  assert.ok(
    gatewayStart < activeState && activeState < syncStart,
    "deploy must publish active state after Gateway readiness and before Sync starts",
  );
  for (const synchronousFlag of ['"--rejudge"', '"--retry-failed"']) {
    assert.doesNotMatch(
      deploy,
      new RegExp(synchronousFlag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(deploy, /rejudgement\s*=\s*\$null/);
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
  assert.match(
    deploy,
    /\$preflightParameters\["FrozenBackupPath"\] = \$FrozenBackupPath/,
  );
  assert.match(deploy, /FrozenBackupPath is required for an attested fail-closed deployment/);
  assert.match(deploy, /Read-AsukaFrozenBackup[\s\S]*-VerifyCurrentHashes/);
  assert.match(deploy, /\[string\]\$TaskNormalizationAttestationPath/);
  assert.match(
    deploy,
    /Read-AsukaTaskNormalizationAttestation[\s\S]*-VerifyCurrentTasks/,
  );
  assert.match(
    deploy,
    /\$gatewaySnapshot = \[pscustomobject\]@\{[\s\S]*?enabled = \$true[\s\S]*?state = "Running"[\s\S]*?wasRunning = \$true/,
  );
  assert.match(
    deploy,
    /\$syncSnapshot = \[pscustomobject\]@\{[\s\S]*?enabled = \$true[\s\S]*?state = "Running"[\s\S]*?wasRunning = \$true/,
  );
  assert.match(deploy, /frozenBackupPath = \$frozenBackup\.path/);
  assert.match(deploy, /Configured OpenClaw configuration is invalid/);
  assert.match(deploy, /Installed sync worker does not match the release integrity contract/);
  assert.doesNotMatch(freeze, /SealExistingBackupPath/);
  assert.match(freeze, /@\{upstream\}/);
  assert.doesNotMatch(freeze, /origin\/main/);
  assert.match(freeze, /Test-AsukaFrozenCopyIntegrity/);
  assert.match(common, /function Read-AsukaFrozenBackup/);
  assert.match(common, /function Test-AsukaFrozenCopyIntegrity/);
  assert.match(
    common,
    /Read-AsukaFrozenBackup[\s\S]*Test-AsukaBackupIntegrity -BackupPath \$Path/,
  );
  assert.match(common, /source provenance must be git/);
  assert.match(common, /source branch is empty/);
  assert.match(common, /full 40-character Git commit/);
  assert.match(common, /source worktree must be clean/);
  assert.match(
    common,
    /function Sort-AsukaRecordsOrdinal[\s\S]*?\[StringComparer\]::Ordinal/,
  );
  const ordinalSorter = common.match(
    /function Sort-AsukaRecordsOrdinal[\s\S]*?function Get-AsukaDeploymentRunRoot/,
  )?.[0] ?? "";
  assert.match(
    ordinalSorter,
    /\[Array\]::Sort\([\s\S]*?\[Collections\.IComparer\]\[StringComparer\]::Ordinal/,
  );
  assert.doesNotMatch(ordinalSorter, /\.Insert\(/);
  assert.match(
    common,
    /function Get-AsukaDirectoryIntegrity[\s\S]*?\$files = @\(Sort-AsukaRecordsOrdinal -Records @\(\$records\) -Property "path"\)[\s\S]*?function Write-AsukaBackupIntegrity/,
  );
  assert.match(
    common,
    /function Get-AsukaDirectoryIntegrity[\s\S]*?Get-ChildItem -LiteralPath \$directory -Force -ErrorAction Stop[\s\S]*?\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint[\s\S]*?if \(\$ExcludeReparsePoints\)[\s\S]*?continue[\s\S]*?Directory tree contains an unsupported reparse point/,
  );
  const dependencyVerifier = common.match(
    /function Test-AsukaRuntimeDependencyTree[\s\S]*?function Resolve-AsukaChildPath/,
  )?.[0] ?? "";
  assert.doesNotMatch(
    dependencyVerifier,
    /Assert-AsukaNoReparsePointsInTree/,
  );
  assert.match(
    common,
    /\$sourceIntegrity = Get-AsukaDirectoryIntegrity -Path \$source\s+`?\s*-ExcludeReparsePoints/,
  );
  assert.match(
    deploy,
    /\$sourceIntegrity = Get-AsukaDirectoryIntegrity -Path \(\[string\]\$_\.source\)\s+`?\s*-ExcludeReparsePoints/,
  );
  assert.match(
    deploy,
    /\$backupIntegrity = Get-AsukaDirectoryIntegrity -Path \(\[string\]\$_\.backup\)/,
  );
  assert.match(common, /unmanifested protected file/);
  assert.match(common, /byte total is invalid/);
  assert.match(common, /tree hash is invalid/);
  const backupVerifier = common.match(
    /function Test-AsukaBackupIntegrity[\s\S]*?function Read-AsukaManifest/,
  )?.[0] ?? "";
  assert.doesNotMatch(backupVerifier, /Assert-AsukaNoReparsePointsInTree/);
  assert.doesNotMatch(backupVerifier, /Resolve-AsukaChildPath -Root \$backupRoot/);
  assert.match(
    backupVerifier,
    /Resolve-AsukaLexicalChildPath -Root \$backupRoot[\s\S]*?\$actual = Get-AsukaDirectoryIntegrity -Path \$backupRoot/,
  );
  assert.match(
    backupVerifier,
    /foreach \(\$path in @\(\$manifestPath, \$markerPath\)\) \{[\s\S]*?Assert-AsukaNoReparsePointPath -Root \$backupRoot -Path \$path[\s\S]*?Get-Content -LiteralPath \$markerPath/,
  );
  assert.doesNotMatch(backupVerifier, /Get-AsukaSha256 -Path \$file/);
  assert.doesNotMatch(backupVerifier, /\$records \+=/);
  assert.match(backupVerifier, /\$actualPaths\[\$pathKey\] = \$entry/);
  assert.match(backupVerifier, /Protected backup file is missing/);
  assert.match(backupVerifier, /Protected backup file failed integrity verification/);
  assert.match(common, /backup-complete\.marker\.pending/);
  assert.match(
    common,
    /Test-AsukaBackupIntegrity -BackupPath \$backupRoot -PendingMarker[\s\S]*?Move-Item -LiteralPath \$pendingMarkerPath -Destination \$markerPath/,
  );
  assert.match(
    freeze,
    /Frozen backup requires a running, enabled baseline/,
  );
  for (const script of [common, freeze, rollback, createRecoveryBaseline]) {
    assert.doesNotMatch(script, /\$matches\b/i);
  }
  assert.match(
    freeze,
    /\$sealedIntegrity = Write-AsukaBackupIntegrity -BackupPath \$backupRoot/,
  );
  assert.match(
    freeze,
    /Write-AsukaBackupIntegrity -BackupPath \$backupRoot[\s\S]*?Test-AsukaFrozenBackupSemantics[\s\S]*?-BackupIntegrity \$sealedIntegrity -VerifyCurrentHashes/,
  );
  assert.doesNotMatch(
    freeze,
    /Write-AsukaBackupIntegrity -BackupPath \$backupRoot[\s\S]*?Read-AsukaFrozenBackup/,
  );
  assert.doesNotMatch(
    deploy,
    /Write-AsukaBackupIntegrity -BackupPath \$backupPath\s*\r?\n\s*\[void\]\(Test-AsukaBackupIntegrity/,
  );
  assert.match(common, /Current file changed after freeze/);
  assert.match(common, /scheduled-tasks\\\$GatewayTaskName\.xml/);
  assert.match(common, /syncWorker integrity contract/);
  assert.match(common, /syncWorker does not match its opsFiles entry/);
  assert.match(common, /function ConvertFrom-AsukaTaskArguments/);
  assert.match(common, /function Test-AsukaFullyQualifiedWindowsPath/);
  assert.match(common, /function Test-AsukaPowerShellFileAction/);
  assert.match(common, /\$rawWorkingDirectory\.Equals/);
  assert.match(common, /CommandLineToArgvW/);
  assert.match(common, /LocalFree/);
  assert.doesNotMatch(common, /ExpandEnvironmentVariables/);
  assert.match(preflight, /Packaged sync worker does not match the release integrity contract/);
  assert.match(preflight, /expectedInstalledSha256\s*=\s*\$expectedSyncScriptHash/);
  assert.match(
    preflight,
    /Test-AsukaPowerShellFileAction -Action \$gatewayActions\[0\][\s\S]*?-ScriptPath \$gatewayScript -AllowedWorkingDirectory \$AppRoot/,
  );
  assert.match(
    preflight,
    /Test-AsukaPowerShellFileAction -Action \$syncActions\[0\][\s\S]*?-ScriptPath \$syncScript -AllowedWorkingDirectory \$AppRoot/,
  );
  assert.match(verify, /Persisted migration report is missing/);
  assert.match(verify, /Installed sync worker does not match the release integrity contract/);
  assert.match(verify, /\$installedSyncScriptHash\s+-ne\s+\$expectedSyncScriptHash/);
  assert.match(
    verify,
    /Test-AsukaPowerShellFileAction -Action \$gatewayActions\[0\][\s\S]*?-ScriptPath \$gatewayScript -AllowedWorkingDirectory \$AppRoot/,
  );
  assert.match(
    verify,
    /Test-AsukaPowerShellFileAction -Action \$syncActions\[0\][\s\S]*?-ScriptPath \$syncScript -AllowedWorkingDirectory \$AppRoot/,
  );
  assert.doesNotMatch(preflight, /syncScriptArgumentPattern/);
  assert.doesNotMatch(verify, /syncScriptArgumentPattern/);
  assert.match(verify, /\$migrationReport\.rejudgementGate/);
  assert.match(verifyLedger, /getLegacyRejudgementGate/);
  assert.doesNotMatch(verifyLedger, /legacy rejudgement gate failed/);
  assert.match(configureMemory, /current\.model !== undefined/);
  assert.match(configureMemory, /retrievalMs:\s*1_500/);
  assert.match(configureMemory, /plugins\.active-memory\.config\.timeoutMs/);
  assert.match(configureMemory, /actualActiveMemoryConfig\.timeoutMs !== 1_500/);
  assert.match(configureMemory, /debounceMs:\s*currentWiki\.debounceMs \?\? 60_000/);
  assert.match(configureMemory, /migration\.identityId \?\? `private:/);
  assert.match(configureMemory, /const peerKind = "direct"/);
  assert.match(configureMemory, /const visibility = "private"/);
  assert.match(configureMemory, /mismatches\.push\("wiki\.peerKind"\)/);
  assert.match(configureMemory, /mismatches\.push\("wiki\.visibility"\)/);
  assert.match(configureMemory, /requireEmbeddings:\s*true/);
  assert.match(configureMemory, /object\(manifest\.requirements\)\.embedding/);
  assert.match(configureMemory, /endpoint:\s*embeddingApi\.endpoint/);
  assert.match(configureMemory, /apiKey:\s*embeddingApi\.apiKey/);
  assert.match(configureMemory, /model:\s*embeddingModel\.name/);
  assert.match(configureMemory, /expectedDimensions:\s*embeddingModel\.dimensions/);
  assert.doesNotMatch(configureMemory, /qwen3-embedding/);
  assert.match(configureMemory, /intervalMs:\s*86_400_000/);
  assert.match(configureMemory, /batchSize:\s*24/);
  assert.match(configureMemory, /eventDelayMs:\s*5_000/);
  assert.match(readme, /LLM rejudgement continues in the background/i);
  const prerequisiteStep = readme.indexOf("## Install the local embedding prerequisite");
  const baselineStep = readme.indexOf("## Create and use the immutable recovery baseline");
  const normalizeStep = readme.indexOf("## Normalize scheduled task actions");
  const preflightStep = readme.indexOf("## Preflight");
  const deployStep = readme.indexOf("## Deploy");
  const verifyStep = readme.indexOf("## Verify");
  assert.ok(
    prerequisiteStep >= 0
      && prerequisiteStep < baselineStep
      && baselineStep < normalizeStep
      && normalizeStep < preflightStep
      && preflightStep < deployStep
      && deployStep < verifyStep,
    "operator runbook must order prerequisite, baseline, normalize, preflight, deploy, verify",
  );
  assert.match(readme, /existing Authenticode-signed Ollama executable on the C drive/);
  assert.match(readme, /CC-BY-NC-4\.0/);
  assert.match(readme, /Clash HTTP or mixed listener on[\s\S]*loopback/);
  assert.match(readme, /D:\\app\\asuka\\models\\jina-v5-text-small/);
  assert.match(readme, /D:\\app\\asuka\\models\\ollama/);
  assert.match(readme, /D:\\app\\asuka\\embedding/);
  assert.match(readme, /C:\\Users\\<user>\\AppData\\Local\\Programs\\Ollama\\ollama\.exe/);
  assert.match(readme, /install-local-embedding\.ps1[\s\S]*-VerifyOnly/);
  assert.match(
    readme,
    /Application rollback deliberately[\s\S]*does not uninstall, stop, unregister, remove, or downgrade Ollama/,
  );
  assert.doesNotMatch(readme, /qwen3-embedding/);
  assert.match(readme, /Create a release-bound frozen backup/);
  assert.match(readme, /worktree add -b "\$release_branch" "\$build_root" "\$release_commit"/);
  assert.match(readme, /npm@11\.16\.0/);
  assert.match(readme, /test "\$\(node --version\)" = "v24\.18\.0"/);
  assert.match(readme, /\$env:Path = "\$toolBin;\$env:Path"/);
  assert.match(
    readme,
    /\$toolBin = "D:\\app\\asuka\\tools\\node-v24\.18\.0"/,
  );
  assert.doesNotMatch(readme, /node-v24\.18\.0-npm-11\.16\.0/);
  assert.match(readme, /\(npm --version\) -ne "11\.16\.0"/);
  assert.match(readme, /-ReleaseRoot \$release/);
  assert.match(readme, /-TaskNormalizationAttestationPath \$taskAttestation/);
  assert.doesNotMatch(readme, /-SealExistingBackupPath/);
  assert.match(readme, /upgrade-20260727-001932/);
  assert.match(readme, /create-recovery-baseline\.ps1/);
  assert.match(readme, /recover-v15-baseline\.ps1/);
  assert.match(readme, /v15-20260727-124326-adaptive-memory-kernel/);
  assert.match(readme, /Do not use it as this deployment's[\s\S]*frozen input/);
  assert.match(normalizeTaskActions, /Read-AsukaFrozenBackup[\s\S]*-VerifyCurrentHashes/);
  assert.match(normalizeTaskActions, /Export-ScheduledTask/);
  assert.match(normalizeTaskActions, /Test-AsukaPowerShellFileAction/);
  assert.match(normalizeTaskActions, /Set-AsukaTaskFromSnapshot/);
  assert.match(normalizeTaskActions, /argumentsPreserved/);
  assert.match(normalizeTaskActions, /workingDirectoryPreserved/);
  assert.doesNotMatch(
    [
      deploy,
      freeze,
      normalizeTaskActions,
      preflight,
      rollback,
      verify,
      createRecoveryBaseline,
      recoverBaseline,
    ].join("\n"),
    /DeploymentLockHeld/,
  );

  const configuredOpenClaw = path.join(fixtureRoot, "configured-openclaw.json");
  writeAbsolute(
    configuredOpenClaw,
    `${JSON.stringify({
      untouchedRoot: "keep-root",
      plugins: {
        untouchedPluginRoot: "keep-plugin-root",
        entries: {
          "memory-core": {
            enabled: false,
            untouched: "keep-memory-core",
          },
          "active-memory": {
            enabled: true,
            untouched: "keep-active-memory",
            config: {
              timeoutMs: 15_000,
              untouched: "keep-active-config",
            },
          },
          "memory-wiki": {
            enabled: false,
            untouched: "keep-memory-wiki",
          },
        },
      },
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
              endpoint: "https://embedding.invalid/v1/embeddings",
              apiKey: "embedding-secret",
              model: "embedding-model",
              timeoutMs: 15_000,
              expectedDimensions: 3,
              untouched: "keep-embedding",
            },
            requireEmbeddings: false,
            enableVector: false,
            reflection: {
              enabled: false,
              intervalMs: 1_000,
              batchSize: 1,
              eventDelayMs: 0,
              untouched: "keep-reflection",
            },
            timeouts: {
              judgementMs: 45_000,
              rerankTaskMs: 90_000,
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
  assert.doesNotMatch(
    configureRun.stdout,
    /memory-secret|embedding-secret|memory-model|embedding-model/,
  );
  assert.equal(configureRun.stdout.includes(first.requirements.embedding.api.apiKey), false);
  assert.equal(configureRun.stdout.includes(first.requirements.embedding.model.name), false);
  assert.equal(configured.untouchedRoot, "keep-root");
  assert.equal(configured.plugins.untouchedPluginRoot, "keep-plugin-root");
  assert.equal(configured.plugins.entries["memory-core"].enabled, true);
  assert.equal(configured.plugins.entries["memory-core"].untouched, "keep-memory-core");
  assert.equal(configured.plugins.entries["active-memory"].enabled, true);
  assert.equal(configured.plugins.entries["active-memory"].untouched, "keep-active-memory");
  assert.equal(configured.plugins.entries["active-memory"].config.timeoutMs, 1_500);
  assert.equal(
    configured.plugins.entries["active-memory"].config.untouched,
    "keep-active-config",
  );
  assert.equal(configured.plugins.entries["memory-wiki"].enabled, true);
  assert.equal(configured.plugins.entries["memory-wiki"].untouched, "keep-memory-wiki");
  assert.equal(configured.channels.qqbot.untouchedChannel, "keep-channel");
  assert.equal(configuredKernel.enabled, true);
  assert.equal(
    configuredKernel.databasePath,
    String.raw`D:\app\asuka\home\.openclaw\qqbot\data\asuka-memory\memory-ledger.sqlite`,
  );
  assert.equal(configuredKernel.model.primary.apiKey, "memory-secret");
  assert.equal(configuredKernel.model.primary.model, "memory-model");
  assert.deepEqual(configuredKernel.embedding, {
    endpoint: first.requirements.embedding.api.endpoint,
    apiKey: first.requirements.embedding.api.apiKey,
    model: first.requirements.embedding.model.name,
    timeoutMs: 15_000,
    expectedDimensions: first.requirements.embedding.model.dimensions,
    untouched: "keep-embedding",
  });
  assert.equal(configuredKernel.enableVector, true);
  assert.equal(configuredKernel.requireEmbeddings, true);
  assert.deepEqual(configuredKernel.reflection, {
    enabled: true,
    intervalMs: 1_000,
    batchSize: 1,
    eventDelayMs: 0,
    untouched: "keep-reflection",
  });
  assert.equal(configuredKernel.timeouts.judgementMs, 45_000);
  assert.equal(configuredKernel.timeouts.retrievalMs, 1_500);
  assert.equal(configuredKernel.timeouts.rerankTaskMs, 90_000);
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
  assert.equal(configuredKernel.wiki.peerKind, "direct");
  assert.equal(configuredKernel.wiki.visibility, "private");
  assert.equal(configuredKernel.wiki.debounceMs, 60_000);
  assert.equal(configuredKernel.wiki.overrideImportIntervalMs, 60_000);

  const configuredBeforeVerify = fs.readFileSync(configuredOpenClaw, "utf8");
  const verifyOnlyRun = run(process.execPath, [
    path.join(opsRoot, "configure-memory-kernel.mjs"),
    "--config", configuredOpenClaw,
    "--manifest", path.join(releaseOne, "manifest.json"),
    "--verify-only", "true",
  ]);
  const verifyOnlyReport = JSON.parse(verifyOnlyRun.stdout);
  assert.equal(verifyOnlyReport.ok, true);
  assert.equal(verifyOnlyReport.peerKind, "direct");
  assert.equal(verifyOnlyReport.visibility, "private");
  assert.doesNotMatch(
    verifyOnlyRun.stdout,
    /memory-secret|embedding-secret|memory-model|embedding-model/,
  );
  assert.equal(verifyOnlyRun.stdout.includes(first.requirements.embedding.api.apiKey), false);
  assert.equal(verifyOnlyRun.stdout.includes(first.requirements.embedding.model.name), false);
  assert.equal(fs.readFileSync(configuredOpenClaw, "utf8"), configuredBeforeVerify);

  const productionMismatchCases = [
    ["enabled", ["channels", "qqbot", "memoryKernel", "enabled"], false],
    ["databasePath", ["channels", "qqbot", "memoryKernel", "databasePath"], "D:\\wrong.sqlite"],
    ["enableVector", ["channels", "qqbot", "memoryKernel", "enableVector"], false],
    ["requireEmbeddings", ["channels", "qqbot", "memoryKernel", "requireEmbeddings"], false],
    [
      "embedding.endpoint",
      ["channels", "qqbot", "memoryKernel", "embedding", "endpoint"],
      `${first.requirements.embedding.api.endpoint}-wrong`,
    ],
    [
      "embedding.apiKey",
      ["channels", "qqbot", "memoryKernel", "embedding", "apiKey"],
      "wrong-embedding-secret",
    ],
    [
      "embedding.model",
      ["channels", "qqbot", "memoryKernel", "embedding", "model"],
      `${first.requirements.embedding.model.name}-wrong`,
    ],
    [
      "embedding.expectedDimensions",
      ["channels", "qqbot", "memoryKernel", "embedding", "expectedDimensions"],
      first.requirements.embedding.model.dimensions + 1,
    ],
    [
      "reflection.enabled",
      ["channels", "qqbot", "memoryKernel", "reflection", "enabled"],
      false,
    ],
  ];
  for (const [label, segments, invalidValue] of productionMismatchCases) {
    const invalidConfig = JSON.parse(configuredBeforeVerify);
    const field = segments.at(-1);
    const parent = segments.slice(0, -1).reduce(
      (value, segment) => value[segment],
      invalidConfig,
    );
    parent[field] = invalidValue;
    const invalidConfigPath = path.join(
      fixtureRoot,
      `invalid-${label.replaceAll(".", "-")}.json`,
    );
    writeAbsolute(invalidConfigPath, `${JSON.stringify(invalidConfig, null, 2)}\n`);
    const failure = runFailure(process.execPath, [
      path.join(opsRoot, "configure-memory-kernel.mjs"),
      "--config", invalidConfigPath,
      "--manifest", path.join(releaseOne, "manifest.json"),
      "--verify-only", "true",
    ], new RegExp(label.replaceAll(".", "\\.")));
    assert.doesNotMatch(
      `${failure.stderr}\n${failure.stdout}`,
      /memory-secret|embedding-secret|memory-model|embedding-model|wrong-embedding-secret/,
    );
    assert.equal(
      `${failure.stderr}\n${failure.stdout}`.includes(
        first.requirements.embedding.api.apiKey,
      ),
      false,
    );
    assert.equal(
      `${failure.stderr}\n${failure.stdout}`.includes(
        first.requirements.embedding.model.name,
      ),
      false,
    );
  }
  const baseUrlOnlyEmbedding = JSON.parse(configuredBeforeVerify);
  const baseUrlOnlyEmbeddingConfig = baseUrlOnlyEmbedding.channels.qqbot.memoryKernel.embedding;
  delete baseUrlOnlyEmbeddingConfig.endpoint;
  baseUrlOnlyEmbeddingConfig.baseUrl = first.requirements.embedding.api.endpoint;
  const baseUrlOnlyEmbeddingPath = path.join(
    fixtureRoot,
    "invalid-embedding-base-url-only.json",
  );
  writeAbsolute(
    baseUrlOnlyEmbeddingPath,
    `${JSON.stringify(baseUrlOnlyEmbedding, null, 2)}\n`,
  );
  runFailure(process.execPath, [
    path.join(opsRoot, "configure-memory-kernel.mjs"),
    "--config", baseUrlOnlyEmbeddingPath,
    "--manifest", path.join(releaseOne, "manifest.json"),
    "--verify-only", "true",
  ], /embedding\.endpoint/);

  for (const [field, invalidValue] of [
    ["peerKind", "group"],
    ["visibility", "public"],
  ]) {
    const invalidConfig = JSON.parse(configuredBeforeVerify);
    invalidConfig.channels.qqbot.memoryKernel.wiki[field] = invalidValue;
    const invalidConfigPath = path.join(fixtureRoot, `invalid-${field}.json`);
    writeAbsolute(invalidConfigPath, `${JSON.stringify(invalidConfig, null, 2)}\n`);
    runFailure(process.execPath, [
      path.join(opsRoot, "configure-memory-kernel.mjs"),
      "--config", invalidConfigPath,
      "--manifest", path.join(releaseOne, "manifest.json"),
      "--verify-only", "true",
    ], new RegExp(`wiki\\.${field}`));
  }
  const invalidActiveTimeout = JSON.parse(configuredBeforeVerify);
  invalidActiveTimeout.plugins.entries["active-memory"].config.timeoutMs = 15_000;
  const invalidActiveTimeoutPath = path.join(
    fixtureRoot,
    "invalid-active-memory-timeout.json",
  );
  writeAbsolute(
    invalidActiveTimeoutPath,
    `${JSON.stringify(invalidActiveTimeout, null, 2)}\n`,
  );
  runFailure(process.execPath, [
    path.join(opsRoot, "configure-memory-kernel.mjs"),
    "--config", invalidActiveTimeoutPath,
    "--manifest", path.join(releaseOne, "manifest.json"),
    "--verify-only", "true",
  ], /plugins\.active-memory\.config\.timeoutMs/);

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
  run(process.execPath, [path.join(opsRoot, "test-deployment-review-gates.mjs")]);

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
    if (process.platform === "win32") {
      const commonScript = path.join(opsRoot, "common.ps1").replace(/'/g, "''");
      const unknownManifest = path.join(releaseUnknown, "manifest.json").replace(/'/g, "''");
      const dirtyManifestPath = path.join(fixtureRoot, "dirty-manifest.json");
      const dirtyManifest = JSON.parse(
        fs.readFileSync(path.join(releaseOne, "manifest.json"), "utf8"),
      );
      dirtyManifest.source.worktreeDirty = true;
      fs.writeFileSync(dirtyManifestPath, `${JSON.stringify(dirtyManifest, null, 2)}\n`);
      const dirtyManifestPowerShell = dirtyManifestPath.replace(/'/g, "''");
      const actionValidation = [
        `. '${commonScript}'`,
        "$target = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'Asuka Memory\\asuka-memory-sync.ps1'))",
        "$trustedHost = Join-Path $PSHOME 'powershell.exe'",
        "$driveRelativeHost = $trustedHost.Substring(0, 2) + $trustedHost.Substring(3)",
        "$rootRelativeHost = '\\' + $trustedHost.Substring(3)",
        "$validArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $target + '\"'",
        "$cases = @(",
        "  @{ Name = 'bare host'; Expected = $false; Execute = 'powershell.exe'; Arguments = $validArguments },",
        "  @{ Name = 'valid absolute host'; Expected = $true; Execute = $trustedHost; Arguments = $validArguments },",
        "  @{ Name = 'valid absolute case difference'; Expected = $true; Execute = $trustedHost.ToUpperInvariant(); Arguments = '-File \"' + $target.ToUpperInvariant() + '\"' },",
        "  @{ Name = 'working directory'; Expected = $false; Execute = $trustedHost; Arguments = $validArguments; WorkingDirectory = 'C:\\Temp' },",
        "  @{ Name = 'drive-relative host'; Expected = $false; Execute = $driveRelativeHost; Arguments = $validArguments },",
        "  @{ Name = 'root-relative host'; Expected = $false; Execute = $rootRelativeHost; Arguments = $validArguments },",
        "  @{ Name = 'whitespace host'; Expected = $false; Execute = ' ' + $trustedHost + ' '; Arguments = $validArguments },",
        "  @{ Name = 'evil executable'; Expected = $false; Execute = 'evilpowershell.exe'; Arguments = $validArguments },",
        "  @{ Name = 'alternate executable'; Expected = $false; Execute = 'C:\\Temp\\powershell.exe'; Arguments = $validArguments },",
        "  @{ Name = 'relative executable'; Expected = $false; Execute = '.\\powershell.exe'; Arguments = $validArguments },",
        "  @{ Name = 'extensionless executable'; Expected = $false; Execute = 'powershell'; Arguments = $validArguments },",
        "  @{ Name = 'pwsh executable'; Expected = $false; Execute = 'pwsh.exe'; Arguments = $validArguments },",
        "  @{ Name = 'environment executable'; Expected = $false; Execute = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; Arguments = $validArguments },",
        "  @{ Name = 'decoy file first'; Expected = $false; Execute = $trustedHost; Arguments = '-File \"C:\\evil.ps1\" -File \"' + $target + '\"' },",
        "  @{ Name = 'command before file'; Expected = $false; Execute = $trustedHost; Arguments = '-Command \"Write-Output bad\" -File \"' + $target + '\"' },",
        "  @{ Name = 'encoded command before file'; Expected = $false; Execute = $trustedHost; Arguments = '-EncodedCommand ZQB2AGkAbAA= -File \"' + $target + '\"' },",
        "  @{ Name = 'command abbreviation'; Expected = $false; Execute = $trustedHost; Arguments = '-c bad -File \"' + $target + '\"' },",
        "  @{ Name = 'encoded abbreviation'; Expected = $false; Execute = $trustedHost; Arguments = '-enc ZQB2AGkAbAA= -File \"' + $target + '\"' },",
        "  @{ Name = 'file contains arguments'; Expected = $false; Execute = $trustedHost; Arguments = '-File \"' + $target + ' -Once\"' },",
        "  @{ Name = 'file suffix'; Expected = $false; Execute = $trustedHost; Arguments = '-File \"' + $target + '.evil\"' },",
        "  @{ Name = 'relative file'; Expected = $false; Execute = $trustedHost; Arguments = '-File .\\asuka-memory-sync.ps1' },",
        "  @{ Name = 'alternate stream'; Expected = $false; Execute = $trustedHost; Arguments = '-File \"' + $target + ':evil\"' },",
        "  @{ Name = 'missing file value'; Expected = $false; Execute = $trustedHost; Arguments = '-File' },",
        "  @{ Name = 'second file after script'; Expected = $false; Execute = $trustedHost; Arguments = $validArguments + ' -File \"C:\\evil.ps1\"' },",
        "  @{ Name = 'unexpected script argument'; Expected = $false; Execute = $trustedHost; Arguments = $validArguments + ' -Once' }",
        ")",
        "foreach ($case in $cases) {",
        "  $workingDirectory = if ($case.ContainsKey('WorkingDirectory')) { $case.WorkingDirectory } else { '' }",
        "  $action = [pscustomobject]@{ execute = $case.Execute; arguments = $case.Arguments; workingDirectory = $workingDirectory }",
        "  $actual = Test-AsukaPowerShellFileAction -Action $action -ScriptPath $target",
        "  if ($actual -ne $case.Expected) { throw \"Task action validation case failed: $($case.Name)\" }",
        "}",
        "$allowedWorkingDirectory = Split-Path -Parent $target",
        "$allowedWorkingAction = [pscustomobject]@{ execute = $trustedHost; arguments = $validArguments; workingDirectory = $allowedWorkingDirectory }",
        "if (-not (Test-AsukaPowerShellFileAction -Action $allowedWorkingAction -ScriptPath $target -AllowedWorkingDirectory $allowedWorkingDirectory)) { throw 'Allowed working directory was rejected.' }",
        "if (Test-AsukaPowerShellFileAction -Action $allowedWorkingAction -ScriptPath $target -AllowedWorkingDirectory 'C:\\Temp') { throw 'Unexpected working directory was accepted.' }",
        "$driveRelativeWorkingDirectory = $allowedWorkingDirectory.Substring(0, 2) + $allowedWorkingDirectory.Substring(3)",
        "$rootRelativeWorkingDirectory = '\\' + $allowedWorkingDirectory.Substring(3)",
        "foreach ($invalidWorkingDirectory in @($driveRelativeWorkingDirectory, $rootRelativeWorkingDirectory, (' ' + $allowedWorkingDirectory + ' '))) {",
        "  $invalidWorkingAction = [pscustomobject]@{ execute = $trustedHost; arguments = $validArguments; workingDirectory = $invalidWorkingDirectory }",
        "  if (Test-AsukaPowerShellFileAction -Action $invalidWorkingAction -ScriptPath $target -AllowedWorkingDirectory $allowedWorkingDirectory) { throw \"Invalid working directory was accepted: $invalidWorkingDirectory\" }",
        "}",
        "$trailingWorkingDirectory = $allowedWorkingDirectory.TrimEnd('\\') + '\\'",
        "$trailingWorkingAction = [pscustomobject]@{ execute = $trustedHost; arguments = $validArguments; workingDirectory = $trailingWorkingDirectory }",
        "if (-not (Test-AsukaPowerShellFileAction -Action $trailingWorkingAction -ScriptPath $target -AllowedWorkingDirectory $allowedWorkingDirectory)) { throw 'Equivalent trailing working directory was rejected.' }",
        "$uncWorkingDirectory = '\\\\server\\share\\Asuka'",
        "$uncWorkingAction = [pscustomobject]@{ execute = $trustedHost; arguments = $validArguments; workingDirectory = $uncWorkingDirectory }",
        "if (-not (Test-AsukaPowerShellFileAction -Action $uncWorkingAction -ScriptPath $target -AllowedWorkingDirectory $uncWorkingDirectory)) { throw 'Fully qualified UNC working directory was rejected.' }",
        "$parsed = @(ConvertFrom-AsukaTaskArguments -Arguments '  -NoProfile   -File \"C:\\Asuka Memory\\worker.ps1\"  ')",
        "if ($parsed.Count -ne 3 -or $parsed[2] -ne 'C:\\Asuka Memory\\worker.ps1') { throw 'Quoted path parsing failed.' }",
        "$escaped = @(ConvertFrom-AsukaTaskArguments -Arguments 'one\\\\\\\"two')",
        "if ($escaped.Count -ne 1 -or $escaped[0] -ne 'one\\\"two') { throw 'Backslash-quote parsing failed.' }",
        "function Assert-AsukaFailure {",
        "  param([scriptblock]$Script, [string]$Pattern, [string]$Name)",
        "  $sentinel = \"Expected failure was not observed: $Name\"",
        "  try {",
        "    & $Script",
        "    throw $sentinel",
        "  } catch {",
        "    if ($_.Exception.Message -eq $sentinel) { throw }",
        "    if ($_.Exception.Message -notmatch $Pattern) {",
        "      throw \"$Name failed with an unexpected error: $($_.Exception.Message)\"",
        "    }",
        "  }",
        "}",
        "$ordinalRecords = @(Sort-AsukaRecordsOrdinal -Records @(",
        "  [pscustomobject]@{ path = 'a' },",
        "  [pscustomobject]@{ path = 'B' },",
        "  [pscustomobject]@{ path = 'A' },",
        "  [pscustomobject]@{ path = 'b' }",
        ") -Property 'path')",
        "if (($ordinalRecords.path -join ',') -cne 'A,B,a,b') { throw 'Ordinal record sorting failed.' }",
        `Assert-AsukaFailure { Read-AsukaManifest -Path '${unknownManifest}' | Out-Null } 'source provenance must be git' 'unknown provenance'`,
        `Assert-AsukaFailure { Read-AsukaManifest -Path '${dirtyManifestPowerShell}' | Out-Null } 'source worktree must be clean' 'dirty provenance'`,
        "$integrityRoot = Join-Path ([IO.Path]::GetTempPath()) ('asuka-backup-integrity-' + [guid]::NewGuid().ToString('N'))",
        "$baseline = Join-Path $integrityRoot 'baseline'",
        "try {",
        "  New-Item -ItemType Directory -Force -Path (Join-Path $baseline 'payload') | Out-Null",
        "  New-Item -ItemType Directory -Force -Path (Join-Path $baseline 'a') | Out-Null",
        "  [IO.File]::WriteAllBytes((Join-Path $baseline 'payload\\data.bin'), [byte[]](1, 2, 3, 4))",
        "  [IO.File]::WriteAllBytes((Join-Path $baseline 'a\\child.bin'), [byte[]](5))",
        "  [IO.File]::WriteAllBytes((Join-Path $baseline 'a0.bin'), [byte[]](6))",
        "  $hiddenSystem = Join-Path $baseline 'hidden-system.bin'",
        "  [IO.File]::WriteAllBytes($hiddenSystem, [byte[]](7))",
        "  [IO.File]::SetAttributes($hiddenSystem, [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)",
        "  Set-Content -LiteralPath (Join-Path $baseline 'backup-manifest.json') -Value '{}' -Encoding UTF8",
        "  Set-Content -LiteralPath (Join-Path $baseline 'BACKUP_COMPLETE') -Value 'complete' -Encoding ASCII",
        "  [void](Write-AsukaBackupIntegrity -BackupPath $baseline)",
        "  if (Test-Path -LiteralPath (Join-Path $baseline 'backup-complete.marker.pending')) { throw 'pending backup marker remained after finalization' }",
        "  [void](Test-AsukaBackupIntegrity -BackupPath $baseline)",
        "  function Copy-IntegrityFixture {",
        "    param([string]$Name)",
        "    $copy = Join-Path $integrityRoot $Name",
        "    Copy-Item -LiteralPath $baseline -Destination $copy -Recurse",
        "    return $copy",
        "  }",
        "  $missing = Copy-IntegrityFixture -Name 'missing'",
        "  Remove-Item -LiteralPath (Join-Path $missing 'payload\\data.bin') -Force",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $missing | Out-Null } 'file is missing' 'missing protected file'",
        "  $extra = Copy-IntegrityFixture -Name 'extra'",
        "  Set-Content -LiteralPath (Join-Path $extra 'payload\\extra.txt') -Value 'extra' -Encoding ASCII",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $extra | Out-Null } 'unmanifested protected file' 'extra protected file'",
        "  $junctionTarget = Join-Path $integrityRoot 'junction-target'",
        "  New-Item -ItemType Directory -Force -Path $junctionTarget | Out-Null",
        "  $junction = Copy-IntegrityFixture -Name 'junction'",
        "  New-Item -ItemType Junction -Path (Join-Path $junction 'payload\\linked') -Target $junctionTarget | Out-Null",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $junction | Out-Null } 'unsupported reparse point' 'nested reparse point'",
        "  $sameSize = Copy-IntegrityFixture -Name 'same-size-hash'",
        "  $sameSizeFile = Join-Path $sameSize 'payload\\data.bin'",
        "  $sameSizeBytes = [IO.File]::ReadAllBytes($sameSizeFile)",
        "  $sameSizeBytes[0] = [byte]($sameSizeBytes[0] -bxor 255)",
        "  [IO.File]::WriteAllBytes($sameSizeFile, $sameSizeBytes)",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $sameSize | Out-Null } 'failed integrity verification' 'same-size hash mutation'",
        "  $changedSize = Copy-IntegrityFixture -Name 'changed-size'",
        "  [IO.File]::WriteAllBytes((Join-Path $changedSize 'payload\\data.bin'), [byte[]](1, 2, 3, 4, 5))",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $changedSize | Out-Null } 'failed integrity verification' 'size mutation'",
        "  $badTree = Copy-IntegrityFixture -Name 'bad-tree'",
        "  $badTreeManifestPath = Join-Path $badTree 'backup-files.json'",
        "  $badTreeMarkerPath = Join-Path $badTree 'backup-complete.marker'",
        "  $badTreeManifest = Get-Content -LiteralPath $badTreeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json",
        "  $badTreeManifest.treeSha256 = '0' * 64",
        "  $badTreeManifest | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $badTreeManifestPath -Encoding UTF8",
        "  $badTreeMarker = Get-Content -LiteralPath $badTreeMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json",
        "  $badTreeMarker.treeSha256 = '0' * 64",
        "  $badTreeMarker.manifestSha256 = Get-AsukaSha256 -Path $badTreeManifestPath",
        "  $badTreeMarker | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $badTreeMarkerPath -Encoding UTF8",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $badTree | Out-Null } 'tree hash is invalid' 'manifest tree mismatch'",
        "  $badBytes = Copy-IntegrityFixture -Name 'bad-bytes'",
        "  $badBytesMarkerPath = Join-Path $badBytes 'backup-complete.marker'",
        "  $badBytesMarker = Get-Content -LiteralPath $badBytesMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json",
        "  $badBytesMarker.bytes = [int64]$badBytesMarker.bytes + 1",
        "  $badBytesMarker | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath $badBytesMarkerPath -Encoding UTF8",
        "  Assert-AsukaFailure { Test-AsukaBackupIntegrity -BackupPath $badBytes | Out-Null } 'inconsistent totals' 'manifest marker bytes mismatch'",
        "  $copyApp = Join-Path $integrityRoot 'copy-app'",
        "  $copyBackup = Join-Path $integrityRoot 'copy-backup'",
        "  $copySource = Join-Path $copyApp 'home'",
        "  $copyDestination = Join-Path $copyBackup 'home'",
        "  New-Item -ItemType Directory -Force -Path $copySource | Out-Null",
        "  Set-Content -LiteralPath (Join-Path $copySource 'source.txt') -Value 'same' -Encoding ASCII",
        "  Copy-Item -LiteralPath $copySource -Destination $copyDestination -Recurse",
        "  $copyManifest = [pscustomobject]@{ copies = @([pscustomobject]@{ Source = $copySource; Destination = $copyDestination; Skipped = $false }) }",
        "  $verifiedCopies = @(Test-AsukaFrozenCopyIntegrity -Manifest $copyManifest -AppRoot $copyApp -BackupPath $copyBackup)",
        "  if ($verifiedCopies.Count -ne 1) { throw 'frozen copy verification did not return one tree' }",
        "  Set-Content -LiteralPath (Join-Path $copyDestination 'source.txt') -Value 'evil' -Encoding ASCII",
        "  Assert-AsukaFailure { Test-AsukaFrozenCopyIntegrity -Manifest $copyManifest -AppRoot $copyApp -BackupPath $copyBackup | Out-Null } 'copy tree does not match' 'frozen copy corruption'",
        "} finally {",
        "  if (Test-Path -LiteralPath $integrityRoot) { Remove-Item -LiteralPath $integrityRoot -Recurse -Force }",
        "}",
      ].join("\n");
      run(parser[0], [...parser.slice(1), actionValidation], { cwd: opsRoot });
    }
    process.stdout.write("PowerShell parser validation passed.\n");
  } else {
    process.stdout.write("PowerShell parser validation skipped: pwsh/powershell is unavailable.\n");
  }

  process.stdout.write("Asuka Memory v1.5 deployment asset tests passed.\n");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
