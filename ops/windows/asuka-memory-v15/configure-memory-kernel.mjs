#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return path.resolve(value);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaults(current, fallback) {
  return Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => [key, current[key] ?? value]),
  );
}

function childPath(root, relative) {
  const normalizedRoot = path.win32.resolve(root);
  const candidate = path.win32.resolve(
    normalizedRoot,
    String(relative).replaceAll("/", "\\"),
  );
  const prefix = `${normalizedRoot.replace(/[\\]+$/, "")}\\`;
  if (
    candidate.toLowerCase() !== normalizedRoot.toLowerCase()
    && !candidate.toLowerCase().startsWith(prefix.toLowerCase())
  ) {
    throw new Error(`path escapes appRoot: ${relative}`);
  }
  return candidate;
}

const values = parseArgs(process.argv.slice(2));
const configPath = required(values, "config");
const manifestPath = required(values, "manifest");
const verifyOnly = values.get("verify-only") === "true";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const migration = object(manifest.migration);
const appRoot = String(manifest.appRoot ?? "").trim();
const accountId = String(migration.accountId ?? "").trim();
const peerId = String(migration.peerId ?? "").trim();
if (!appRoot || !accountId || !peerId || !migration.database) {
  throw new Error("manifest is missing the memory kernel scope or database path");
}
const identityId = String(
  migration.identityId ?? `private:${accountId}:${peerId}`,
).trim();
const peerKind = "direct";
const visibility = "private";
const root = object(config);
const channels = object(root.channels);
const qqbot = object(channels.qqbot);
const current = object(qqbot.memoryKernel);
const currentTimeouts = object(current.timeouts);
const currentMigration = object(current.migration);
const currentWorker = object(current.worker);
const currentWiki = object(current.wiki);
const plugins = object(root.plugins);
const pluginEntries = object(plugins.entries);
const memoryCorePlugin = object(pluginEntries["memory-core"]);
const activeMemoryPlugin = object(pluginEntries["active-memory"]);
const activeMemoryConfig = object(activeMemoryPlugin.config);
const memoryWikiPlugin = object(pluginEntries["memory-wiki"]);
const databasePath = childPath(appRoot, migration.database);
const memoryRoot = childPath(appRoot, "obsidian-vault/Asuka/Memory");

const memoryKernel = {
  ...current,
  enabled: true,
  databasePath,
  enableVector: current.enableVector !== false,
  timeouts: {
    ...currentTimeouts,
    judgementMs: currentTimeouts.judgementMs ?? 30_000,
    retrievalMs: 1_500,
    rerankTaskMs: 60_000,
  },
  migration: {
    ...currentMigration,
    ...defaults(currentMigration, {
      extractionMaxInputChars: 48_000,
      extractionMaxProposals: 120,
      extractionMaxTokens: 9_000,
      consolidationMaxInputChars: 48_000,
      consolidationMaxClaimsPerBatch: 120,
      consolidationMaxTokens: 9_000,
    }),
  },
  worker: {
    ...currentWorker,
    ...defaults(currentWorker, {
      intervalMs: 1_000,
      maxJobs: 25,
    }),
    enabled: true,
  },
  wiki: {
    ...currentWiki,
    enabled: true,
    memoryRoot,
    title: currentWiki.title ?? "Asuka",
    identityId,
    accountId,
    peerId,
    peerKind,
    visibility,
    debounceMs: currentWiki.debounceMs ?? 60_000,
    overrideImportIntervalMs: currentWiki.overrideImportIntervalMs ?? 60_000,
  },
};
const updated = {
  ...root,
  plugins: {
    ...plugins,
    entries: {
      ...pluginEntries,
      "memory-core": {
        ...memoryCorePlugin,
        enabled: true,
      },
      "active-memory": {
        ...activeMemoryPlugin,
        enabled: true,
        config: {
          ...activeMemoryConfig,
          timeoutMs: 1_500,
        },
      },
      "memory-wiki": {
        ...memoryWikiPlugin,
        enabled: true,
      },
    },
  },
  channels: {
    ...channels,
    qqbot: {
      ...qqbot,
      memoryKernel,
    },
  },
};
if (verifyOnly) {
  const actual = object(object(object(config).channels).qqbot).memoryKernel;
  const actualKernel = object(actual);
  const actualTimeouts = object(actualKernel.timeouts);
  const actualWorker = object(actualKernel.worker);
  const actualWiki = object(actualKernel.wiki);
  const actualPluginEntries = object(object(object(config).plugins).entries);
  const actualMemoryCore = object(actualPluginEntries["memory-core"]);
  const actualActiveMemory = object(actualPluginEntries["active-memory"]);
  const actualActiveMemoryConfig = object(actualActiveMemory.config);
  const actualMemoryWiki = object(actualPluginEntries["memory-wiki"]);
  const sameWindowsPath = (left, right) => (
    path.win32.resolve(String(left ?? "")).toLowerCase()
      === path.win32.resolve(String(right ?? "")).toLowerCase()
  );
  const mismatches = [];
  if (actualKernel.enabled !== true) mismatches.push("enabled");
  if (!sameWindowsPath(actualKernel.databasePath, databasePath)) mismatches.push("databasePath");
  if (actualTimeouts.retrievalMs !== 1_500) mismatches.push("timeouts.retrievalMs");
  if (actualTimeouts.rerankTaskMs !== 60_000) mismatches.push("timeouts.rerankTaskMs");
  if (actualWorker.enabled !== true) mismatches.push("worker.enabled");
  if (actualWiki.enabled !== true) mismatches.push("wiki.enabled");
  if (!sameWindowsPath(actualWiki.memoryRoot, memoryRoot)) mismatches.push("wiki.memoryRoot");
  if (String(actualWiki.identityId ?? "") !== identityId) mismatches.push("wiki.identityId");
  if (String(actualWiki.accountId ?? "") !== accountId) mismatches.push("wiki.accountId");
  if (String(actualWiki.peerId ?? "") !== peerId) mismatches.push("wiki.peerId");
  if (String(actualWiki.peerKind ?? "") !== peerKind) mismatches.push("wiki.peerKind");
  if (String(actualWiki.visibility ?? "") !== visibility) mismatches.push("wiki.visibility");
  if (actualMemoryCore.enabled !== true) mismatches.push("plugins.memory-core.enabled");
  if (actualActiveMemory.enabled !== true) mismatches.push("plugins.active-memory.enabled");
  if (actualActiveMemoryConfig.timeoutMs !== 1_500) {
    mismatches.push("plugins.active-memory.config.timeoutMs");
  }
  if (actualMemoryWiki.enabled !== true) mismatches.push("plugins.memory-wiki.enabled");
  if (mismatches.length > 0) {
    throw new Error(`active memory kernel configuration mismatch: ${mismatches.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation: "verify-memory-kernel-config",
    databasePath,
    memoryRoot,
    identityId,
    accountId,
    peerId,
    peerKind,
    visibility,
    foregroundRetrievalMs: 1_500,
  })}\n`);
  process.exit(0);
}
const serialized = `${JSON.stringify(updated, null, 2)}\n`;
JSON.parse(serialized);
fs.writeFileSync(configPath, serialized, "utf8");
const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
const persistedKernel = persisted.channels?.qqbot?.memoryKernel;
if (
  persistedKernel?.enabled !== true
  || persistedKernel.wiki?.peerKind !== peerKind
  || persistedKernel.wiki?.visibility !== visibility
  || persistedKernel.timeouts?.retrievalMs !== 1_500
  || persisted.plugins?.entries?.["memory-core"]?.enabled !== true
  || persisted.plugins?.entries?.["active-memory"]?.enabled !== true
  || persisted.plugins?.entries?.["active-memory"]?.config?.timeoutMs !== 1_500
  || persisted.plugins?.entries?.["memory-wiki"]?.enabled !== true
) {
  throw new Error("memory kernel configuration was not persisted");
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  databasePath,
  memoryRoot,
  identityId,
  peerKind,
  visibility,
  modelConfigurationPreserved: current.model !== undefined,
})}\n`);
