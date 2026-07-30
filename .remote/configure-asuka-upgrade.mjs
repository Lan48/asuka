import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [configPath, memoryPath, openClawRoot] = process.argv.slice(2);
if (!configPath || !memoryPath || !openClawRoot) {
  throw new Error("usage: node configure-asuka-upgrade.mjs <openclaw.json> <memory-path> <openclaw-root>");
}

const require = createRequire(import.meta.url);
const JSON5 = require(path.join(openClawRoot, "node_modules", "json5"));
const config = JSON5.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));

function migrateModelReferences(value) {
  if (Array.isArray(value)) return value.map(migrateModelReferences);
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const migratedKey = key.startsWith("openai-codex/")
        ? `openai/${key.slice("openai-codex/".length)}`
        : key;
      const migratedValue = migrateModelReferences(child);
      if (migratedKey !== key) delete value[key];
      value[migratedKey] = migratedValue;
    }
    return value;
  }
  if (typeof value === "string" && value.startsWith("openai-codex/")) {
    return `openai/${value.slice("openai-codex/".length)}`;
  }
  return value;
}

if (config.models?.providers?.["openai-codex"]) {
  const legacyProvider = config.models.providers["openai-codex"];
  if (legacyProvider.api === "openai-codex-responses") {
    legacyProvider.api = "openai-chatgpt-responses";
  }
  config.models.providers.openai = {
    ...legacyProvider,
    ...(config.models.providers.openai ?? {}),
  };
  delete config.models.providers["openai-codex"];
}
migrateModelReferences(config);

config.plugins ??= {};
if (config.plugins.allow && config.plugins.bundledDiscovery === undefined) {
  config.plugins.bundledDiscovery = "compat";
}
if (Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [
    ...new Set([
      ...config.plugins.allow,
      "memory-core",
      "active-memory",
      "memory-wiki",
    ]),
  ];
}
config.plugins.entries ??= {};
config.plugins.entries["memory-core"] = {
  ...(config.plugins.entries["memory-core"] ?? {}),
  enabled: true,
};
config.plugins.entries["active-memory"] = {
  enabled: true,
  config: {
    enabled: true,
    agents: ["main"],
    allowedChatTypes: ["direct"],
    queryMode: "recent",
    promptStyle: "balanced",
    timeoutMs: 15000,
    maxSummaryChars: 220,
    persistTranscripts: false,
    logging: true,
  },
};
config.plugins.entries["memory-wiki"] = {
  enabled: true,
  config: {
    vaultMode: "isolated",
    vault: {
      path: memoryPath,
      renderMode: "obsidian",
    },
    obsidian: {
      enabled: false,
      useOfficialCli: false,
      openAfterWrites: false,
    },
    ingest: {
      autoCompile: true,
      maxConcurrentJobs: 1,
      allowUrlIngest: false,
    },
    search: {
      backend: "shared",
      corpus: "all",
    },
    context: {
      includeCompiledDigestPrompt: true,
    },
    render: {
      preserveHumanBlocks: true,
      createBacklinks: true,
      createDashboards: true,
    },
  },
};

const temporaryPath = `${configPath}.asuka-upgrade.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, configPath);
