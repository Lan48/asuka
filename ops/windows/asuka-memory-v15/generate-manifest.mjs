#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(projectRoot, args) {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-C", projectRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const directoryName = entry.name.toLowerCase();
    if (
      entry.isDirectory()
      && ["node_modules", "test", "tests", "__tests__", ".git"].includes(directoryName)
    ) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const values = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(required(values, "project-root"));
const releaseRoot = path.resolve(required(values, "release-root"));
const accountId = required(values, "account");
const peerId = required(values, "peer");
const identityId = values.get("identity") || undefined;
const appRoot = values.get("app-root") || String.raw`D:\app\asuka`;
const gitHead = git(projectRoot, ["rev-parse", "HEAD"]);
const gitBranch = git(projectRoot, ["branch", "--show-current"]);
const gitStatus = git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
const releaseId = values.get("release-id")
  || `${gitHead.ok ? gitHead.output.slice(0, 12) : "worktree"}-${Date.now()}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId)) {
  throw new Error("releaseId must contain only letters, numbers, dot, underscore, or hyphen");
}
if (
  releaseRoot === path.parse(releaseRoot).root
  || isSameOrInside(projectRoot, releaseRoot)
  || isSameOrInside(releaseRoot, projectRoot)
) {
  throw new Error("release root must be a dedicated directory outside the project tree");
}
if (fs.existsSync(releaseRoot)) {
  throw new Error("release root already exists; choose a new dedicated directory");
}
const expectedOpenClawVersion = values.get("openclaw-version") || "2026.7.1-2";
const expectedNodeVersion = values.get("node-version") || "v24.18.0";
const gatewayPort = Number(values.get("gateway-port") || "19001");
const gatewayTask = values.get("gateway-task") || "AsukaGateway";
const syncTask = values.get("sync-task") || "AsukaMemorySync";
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  throw new Error("gateway port must be an integer between 1 and 65535");
}
for (const [label, taskName] of [["gateway", gatewayTask], ["sync", syncTask]]) {
  if (!/^[A-Za-z0-9_.-]+$/.test(taskName)) {
    throw new Error(`${label} task name contains unsafe characters`);
  }
}

const qqbotRoot = path.join(projectRoot, "extensions", "qqbot");
const requiredDirectories = ["bin", "dist", "scripts", "skills", "src"];
const optionalRootFiles = [
  "clawdbot.plugin.json",
  "index.ts",
  "LICENSE",
  "moltbot.plugin.json",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
  "README.zh.md",
  "tsconfig.json",
];
for (const directory of requiredDirectories) {
  const directoryPath = path.join(qqbotRoot, directory);
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    throw new Error(`required QQBot directory is missing: ${directory}`);
  }
}
const migrationRelative = path.join("scripts", "migrate-asuka-memory-v15.mjs");
if (!fs.existsSync(path.join(qqbotRoot, migrationRelative))) {
  throw new Error(`migration script is missing: ${migrationRelative}`);
}

fs.mkdirSync(releaseRoot, { recursive: true });
const payloadRoot = path.join(releaseRoot, "payload", "qqbot");
for (const directory of requiredDirectories) {
  for (const source of walkFiles(path.join(qqbotRoot, directory))) {
    const relative = path.relative(qqbotRoot, source);
    copyFile(source, path.join(payloadRoot, relative));
  }
}
for (const file of optionalRootFiles) {
  const source = path.join(qqbotRoot, file);
  if (fs.existsSync(source)) copyFile(source, path.join(payloadRoot, file));
}

const opsSource = path.dirname(fileURLToPath(import.meta.url));
const opsRoot = path.join(releaseRoot, "ops");
for (const source of walkFiles(opsSource)) {
  const name = path.basename(source);
  if (
    (name.startsWith("test-") && name.endsWith(".mjs"))
    || name === "release-manifest.json"
    || name.startsWith(".")
  ) {
    continue;
  }
  copyFile(source, path.join(opsRoot, path.relative(opsSource, source)));
}

const runtimeFiles = walkFiles(payloadRoot)
  .map((file) => {
    const relative = relativePosix(payloadRoot, file);
    return {
      source: `payload/qqbot/${relative}`,
      destination: `home/.openclaw/extensions/qqbot/${relative}`,
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    };
  })
  .sort((left, right) => (
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0
  ));
const opsFiles = walkFiles(opsRoot)
  .map((file) => ({
    source: `ops/${relativePosix(opsRoot, file)}`,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  }))
  .sort((left, right) => (
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0
  ));
const syncWorkerSource = "ops/asuka-memory-sync.ps1";
const syncWorkerEntry = opsFiles.find((entry) => entry.source === syncWorkerSource);
if (!syncWorkerEntry) {
  throw new Error(`sync worker is missing from the release: ${syncWorkerSource}`);
}

const gitProbeOk = gitHead.ok && gitBranch.ok && gitStatus.ok;
const status = gitStatus.ok ? gitStatus.output : "";
const manifest = {
  schemaVersion: 1,
  releaseId,
  generatedAt: new Date().toISOString(),
  appRoot,
  source: {
    provenance: gitProbeOk ? "git" : "unknown",
    gitCommit: gitHead.ok ? gitHead.output : "unknown",
    gitBranch: gitBranch.ok ? gitBranch.output : "unknown",
    worktreeDirty: !gitProbeOk || status.length > 0,
    worktreeStatus: gitProbeOk
      ? (status ? status.split(/\r?\n/) : [])
      : ["git provenance unavailable; release must be treated as dirty"],
    runtimeTreeSha256: createHash("sha256")
      .update(runtimeFiles.map((entry) => `${entry.sha256}  ${entry.destination}`).join("\n"))
      .digest("hex"),
  },
  requirements: {
    openClawVersion: expectedOpenClawVersion,
    nodeVersion: expectedNodeVersion,
    minimumFreeBytes: 12 * 1024 * 1024 * 1024,
    gatewayPort,
    tasks: {
      gateway: gatewayTask,
      sync: syncTask,
    },
    requiredModules: ["sqlite-vec"],
  },
  runtimeFiles,
  runtimePreservedDirectories: ["node_modules"],
  opsFiles,
  syncWorker: {
    source: syncWorkerEntry.source,
    destination: "asuka-memory-sync.ps1",
    bytes: syncWorkerEntry.bytes,
    sha256: syncWorkerEntry.sha256,
  },
  migration: {
    script: "home/.openclaw/extensions/qqbot/scripts/migrate-asuka-memory-v15.mjs",
    database: "home/.openclaw/qqbot/data/asuka-memory/memory-ledger.sqlite",
    accountId,
    peerId,
    ...(identityId ? { identityId } : {}),
    sources: {
      memory: "home/.openclaw/qqbot/data/asuka-memory/memory.json",
      claims: "obsidian-vault/Asuka/Memory/.openclaw-wiki/cache/claims.jsonl",
      state: "home/.openclaw/qqbot/data/asuka-state/state.json",
      digest: "home/.openclaw/qqbot/data/asuka-conversation-digest/digest.json",
      refIndex: "home/.openclaw/qqbot/data/ref-index.jsonl",
      sessionsIndex: "home/.openclaw/agents/main/sessions/sessions.json",
      sessionsDirectory: "home/.openclaw/agents/main/sessions",
    },
  },
};

fs.writeFileSync(
  path.join(releaseRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify({
  ok: true,
  operation: "generate-manifest",
  releaseRoot,
  releaseId,
  runtimeFiles: runtimeFiles.length,
  worktreeDirty: manifest.source.worktreeDirty,
  runtimeTreeSha256: manifest.source.runtimeTreeSha256,
})}\n`);
