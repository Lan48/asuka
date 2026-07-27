#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { resolveQQBotSceneInferenceConfig } from "../dist/src/config.js";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";
import {
  collectLegacyMigrationRecords,
  executeLegacyRejudgements,
  getLegacyRejudgementGate,
  migrateLegacyRecords,
} from "../dist/src/asuka-memory-kernel/legacy-migration.js";
import { createOpenAICompatibleMemoryModelClient } from "../dist/src/asuka-memory-kernel/model-client.js";

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (
      name === "dry-run"
      || name === "resume"
      || name === "rejudge"
      || name === "retry-failed"
    ) {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`expected a positive number, received: ${value}`);
  }
  return Math.min(maximum, Math.floor(parsed));
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative number, received: ${value}`);
  }
  return Math.floor(parsed);
}

function configuredValue(values, name, config, legacyName, fallbackConfig) {
  const configName = name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  return values.get(name)
    ?? config[configName]
    ?? config[legacyName]
    ?? fallbackConfig[legacyName];
}

function completionConfig(value) {
  const config = asRecord(value);
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : undefined;
}

function embeddingConfig(value) {
  const config = asRecord(value);
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const timeoutMs = Number(config.timeoutMs);
  if (!endpoint || !apiKey || !model || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  const expectedDimensions = config.expectedDimensions === undefined
    ? undefined
    : positiveInteger(config.expectedDimensions);
  return { endpoint, apiKey, model, timeoutMs, expectedDimensions };
}

function loadRejudgementConfig(file, accountId, values, flags) {
  const configPath = path.resolve(file);
  const root = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const qqbot = asRecord(asRecord(asRecord(root).channels).qqbot);
  const kernel = asRecord(qqbot.memoryKernel);
  const migration = asRecord(kernel.migration);
  const model = asRecord(kernel.model);
  const timeouts = asRecord(kernel.timeouts);
  const scene = resolveQQBotSceneInferenceConfig(accountId);
  const client = createOpenAICompatibleMemoryModelClient({
    primary: completionConfig(model.primary) ?? scene.primary,
    fallback: completionConfig(model.fallback) ?? scene.fallback,
    embedding: embeddingConfig(kernel.embedding ?? model.embedding),
    log: {
      warn(message) {
        process.stderr.write(`${message}\n`);
      },
    },
  });
  if (client.status.completion !== "ready") {
    throw new Error(
      "legacy rejudgement requires a configured completion model in memoryKernel.model or sceneInference",
    );
  }
  return {
    client,
    engine: {
      judgementTimeoutMs: positiveInteger(
        timeouts.judgementMs ?? kernel.judgementTimeoutMs,
        undefined,
      ),
      maxJobAttempts: positiveInteger(
        migration.maxJobAttempts ?? kernel.maxJobAttempts,
        undefined,
        100,
      ),
      legacyExtractionMaxInputChars: positiveInteger(
        configuredValue(
          values,
          "extraction-max-input-chars",
          migration,
          "legacyExtractionMaxInputChars",
          kernel,
        ),
        undefined,
        1_000_000,
      ),
      legacyExtractionMaxProposals: positiveInteger(
        configuredValue(
          values,
          "extraction-max-proposals",
          migration,
          "legacyExtractionMaxProposals",
          kernel,
        ),
        undefined,
        1_000,
      ),
      legacyExtractionMaxTokens: positiveInteger(
        configuredValue(
          values,
          "extraction-max-tokens",
          migration,
          "legacyExtractionMaxTokens",
          kernel,
        ),
        undefined,
        16_000,
      ),
      legacyConsolidationMaxInputChars: positiveInteger(
        configuredValue(
          values,
          "consolidation-max-input-chars",
          migration,
          "legacyConsolidationMaxInputChars",
          kernel,
        ),
        undefined,
        1_000_000,
      ),
      legacyConsolidationMaxClaimsPerBatch: positiveInteger(
        configuredValue(
          values,
          "consolidation-max-claims-per-batch",
          migration,
          "legacyConsolidationMaxClaimsPerBatch",
          kernel,
        ),
        undefined,
        1_000,
      ),
      legacyConsolidationMaxTokens: positiveInteger(
        configuredValue(
          values,
          "consolidation-max-tokens",
          migration,
          "legacyConsolidationMaxTokens",
          kernel,
        ),
        undefined,
        16_000,
      ),
    },
    execution: {
      batchSize: positiveInteger(
        values.get("batch-size") ?? migration.batchSize,
        25,
        500,
      ),
      maxBatches: positiveInteger(
        values.get("max-batches") ?? migration.maxBatches,
        1_000_000,
        1_000_000,
      ),
      retryDelayMs: nonNegativeInteger(
        values.get("retry-delay-ms") ?? migration.retryDelayMs,
        undefined,
      ),
      retryFailed: flags.has("retry-failed") || migration.retryFailed === true,
    },
  };
}

const { values, flags } = parseArgs(process.argv.slice(2));
const scope = {
  accountId: required(values, "account"),
  peerId: required(values, "peer"),
  identityId: values.get("identity"),
};
const sources = {
  memoryJson: values.get("memory"),
  claimsJsonl: values.get("claims"),
  stateJson: values.get("state"),
  digestJson: values.get("digest"),
  refIndexJsonl: values.get("ref-index"),
  sessionsIndexJson: values.get("sessions-index"),
  sessionsDirectory: values.get("sessions-dir"),
};
const records = collectLegacyMigrationRecords(sources, scope);
const sourceCounts = {
  memory: 0,
  claim: 0,
  state: 0,
  digest: 0,
  ref_index: 0,
  session: 0,
};
for (const record of records) sourceCounts[record.sourceKind] += 1;

if (flags.has("dry-run")) {
  const report = {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    scope,
    sources,
    sourceCounts,
    discoveredRecords: records.length,
    sourceMap: records.map((record) => ({
      sourceKind: record.sourceKind,
      sourcePath: record.sourcePath,
      legacyId: record.legacyId,
      status: "discovered",
    })),
  };
  if (values.get("report")) {
    atomicWrite(values.get("report"), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(0);
}

const database = required(values, "database");
if (fs.existsSync(database) && !flags.has("resume")) {
  throw new Error(`database already exists; pass --resume to reuse it: ${database}`);
}
const rejudgement = flags.has("rejudge")
  ? loadRejudgementConfig(
    required(values, "config"),
    scope.accountId,
    values,
    flags,
  )
  : undefined;
const ledger = new AsukaMemoryLedger(database);
try {
  const engine = new AsukaMemoryEngine(ledger, {
    ...rejudgement?.engine,
    model: rejudgement?.client,
  });
  const migration = migrateLegacyRecords(engine, records, scope);
  const migrationGate = {
    passed: migration.skippedRecords === 0
      && migration.importedEvents + migration.duplicateEvents === migration.discoveredRecords,
    blockers: [
      ...(migration.skippedRecords > 0
        ? [`${migration.skippedRecords} legacy record(s) could not be imported`]
        : []),
      ...(migration.importedEvents + migration.duplicateEvents !== migration.discoveredRecords
        ? ["legacy record accounting does not match discovered records"]
        : []),
    ],
  };
  const execution = rejudgement
    ? await executeLegacyRejudgements(engine, rejudgement.execution)
    : undefined;
  const integrity = ledger.integrityCheck();
  const rejudgementGate = execution?.gateAfter ?? getLegacyRejudgementGate(engine);
  const report = {
    mode: flags.has("resume") ? "resume" : "migrate",
    database,
    scope,
    sources,
    migration,
    migrationGate,
    rejudgement: execution,
    rejudgementGate,
    integrity,
    stats: ledger.getStats(),
  };
  if (!integrity.ok) throw new Error(`ledger integrity gate failed: ${JSON.stringify(integrity)}`);
  if (values.get("report")) {
    atomicWrite(values.get("report"), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!migrationGate.passed || (rejudgement && !rejudgementGate.passed)) {
    process.exitCode = 2;
  }
} finally {
  ledger.close();
}
