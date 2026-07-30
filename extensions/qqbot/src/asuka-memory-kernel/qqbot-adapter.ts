import fs from "node:fs";
import path from "node:path";
import type { AsukaPeerContext } from "../asuka-state.js";
import {
  recordAsukaLongTermMemoryFromAssistantReply,
  recordAsukaLongTermMemoryFromUserMessageWithModel,
  writeAsukaLegacyMemoryProjection,
} from "../asuka-memory.js";
import {
  resolveQQBotSceneInferenceConfig,
  type OpenAICompletionsModelConfig,
} from "../config.js";
import {
  createOpenAICompatibleMemoryModelClient,
  type MemoryEmbeddingModelConfig,
} from "./model-client.js";
import { containsDeterministicSecretValue } from "./policy.js";
import {
  getAsukaMemoryRuntime,
  initializeAsukaMemoryRuntime,
  resolveAsukaMemoryKernelConfig,
  type AsukaMemoryRuntime,
  type AsukaLegacyMemoryWriter,
  type AsukaMemoryMessageInput,
  type AsukaMemoryRuntimeLogger,
} from "./runtime.js";
import type {
  MemoryContextResult,
  MemoryEvidencePayload,
  MemoryEventInput,
  MemoryIngestResult,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface QQBotMemoryCaptureInput {
  text: string;
  occurredAt?: number;
  sourceId?: string;
  sourceMessageId?: string;
  evidence?: MemoryEvidencePayload;
  metadata?: Record<string, unknown>;
  generatedFromClaimIds?: string[];
  dedupeKey?: string;
}

export interface QQBotLegacyProjectionWriterOptions {
  memoryFile?: string;
}

export interface QQBotMemoryInitializationOptions {
  legacyWriter?: QQBotLegacyProjectionWriterOptions;
}

const registeredProjectionWriters = new WeakSet<object>();
const kernelAccounts = new Map<string, { spoolPath: string; logger?: AsukaMemoryRuntimeLogger }>();
const retryTimers = new Map<string, NodeJS.Timeout>();
const drainingAccounts = new Set<string>();

type CaptureKind = "user" | "assistant" | "proactive" | "control";

interface QueuedCanonicalCapture {
  schemaVersion: 1;
  kind: CaptureKind;
  event: AsukaMemoryMessageInput;
  queuedAt: number;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function completionConfig(value: unknown): OpenAICompletionsModelConfig | undefined {
  const config = asRecord(value);
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : undefined;
}

function embeddingConfig(value: unknown): MemoryEmbeddingModelConfig | undefined {
  const config = asRecord(value);
  const endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const timeoutMs = Number(config.timeoutMs);
  const expectedDimensions = config.expectedDimensions === undefined
    ? undefined
    : Number(config.expectedDimensions);
  if (!endpoint || !apiKey || !model || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  if (
    expectedDimensions !== undefined
    && (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0)
  ) {
    return undefined;
  }
  return {
    endpoint,
    apiKey,
    model,
    timeoutMs,
    expectedDimensions,
  };
}

function getKernelConfig(rootConfig: unknown): UnknownRecord {
  const channels = asRecord(asRecord(rootConfig).channels);
  const qqbot = asRecord(channels.qqbot);
  return asRecord(qqbot.memoryKernel);
}

export function initializeQQBotAsukaMemory(
  rootConfig: unknown,
  accountId: string,
  logger?: AsukaMemoryRuntimeLogger,
  options: QQBotMemoryInitializationOptions = {},
): ReturnType<typeof initializeAsukaMemoryRuntime> {
  const resolvedKernel = resolveAsukaMemoryKernelConfig(rootConfig);
  const kernel = getKernelConfig(rootConfig);
  if (!resolvedKernel.enabled) {
    kernelAccounts.delete(accountId);
    return undefined;
  }
  kernelAccounts.set(accountId, {
    spoolPath: `${resolvedKernel.databasePath}.ingest-spool.jsonl`,
    logger,
  });
  const modelSettings = asRecord(kernel.model);
  const scene = resolveQQBotSceneInferenceConfig(accountId);
  const client = createOpenAICompatibleMemoryModelClient({
    primary: completionConfig(modelSettings.primary) ?? scene.primary,
    fallback: completionConfig(modelSettings.fallback) ?? scene.fallback,
    embedding: embeddingConfig(kernel.embedding ?? modelSettings.embedding),
    log: {
      warn: (message) => {
        if (logger?.warn) logger.warn(message);
        else logger?.info?.(message);
      },
    },
  });
  const runtime = initializeAsukaMemoryRuntime(rootConfig, {
    model: client.status.completion === "ready" ? client : undefined,
    logger,
  });
  if (runtime && !registeredProjectionWriters.has(runtime)) {
    runtime.registerLegacyWriter(
      createQQBotLegacyProjectionWriter(options.legacyWriter),
    );
    registeredProjectionWriters.add(runtime);
  }
  logger?.info?.(
    `[asuka-memory] runtime enabled; completion=${client.status.completion}, embedding=${client.status.embedding}`,
  );
  drainCanonicalCaptures(accountId);
  scheduleCanonicalDrain(accountId, 0);
  return runtime;
}

export function createQQBotLegacyProjectionWriter(
  options: QQBotLegacyProjectionWriterOptions = {},
): AsukaLegacyMemoryWriter {
  return (context) => {
    if (context.reason !== "claims_changed" || !context.scope) return;
    writeAsukaLegacyMemoryProjection(
      context.scope,
      context.snapshot,
      { memoryFile: options.memoryFile },
    );
  };
}

function eventInput(
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
): AsukaMemoryMessageInput {
  return {
    accountId: context.accountId,
    peerKind: context.peerKind,
    peerId: context.peerId,
    text: input.text,
    occurredAt: input.occurredAt,
    sourceId: input.sourceId,
    sourceMessageId: input.sourceMessageId ?? context.messageId,
    evidence: input.evidence,
    metadata: input.metadata,
    generatedFromClaimIds: input.generatedFromClaimIds,
    dedupeKey: input.dedupeKey,
  };
}

function ingestCanonicalCapture(
  runtime: AsukaMemoryRuntime,
  kind: CaptureKind,
  event: AsukaMemoryMessageInput,
): MemoryIngestResult {
  if (kind === "user") return runtime.ingestUserMessage(event);
  if (kind === "assistant") return runtime.ingestAssistantReply(event);
  if (kind === "proactive") return runtime.ingestProactiveMessage(event);
  return runtime.ingestMemoryEvent({
    ...event,
    actor: "user",
    kind: "memory_control",
    metadata: {
      ...(event.metadata ?? {}),
      requestedOperation: "llm_memory_control",
    },
  });
}

function appendCanonicalCapture(
  accountId: string,
  kind: CaptureKind,
  event: AsukaMemoryMessageInput,
  logger?: AsukaMemoryRuntimeLogger,
): void {
  if (containsDeterministicSecretValue({
    text: event.text,
    evidence: event.evidence,
    metadata: event.metadata,
  })) {
    logger?.warn?.(
      `[asuka-memory] canonical ${kind} retry was not persisted because it contains secret-bearing content`,
    );
    return;
  }
  const account = kernelAccounts.get(accountId);
  if (!account) {
    logger?.error?.(
      `[asuka-memory] canonical ${kind} capture could not be queued because the account has no kernel spool`,
    );
    return;
  }
  const record: QueuedCanonicalCapture = {
    schemaVersion: 1,
    kind,
    event,
    queuedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(account.spoolPath), { recursive: true });
    const descriptor = fs.openSync(account.spoolPath, "a", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    scheduleCanonicalDrain(accountId, 5_000);
  } catch (error) {
    logger?.error?.(
      `[asuka-memory] canonical ${kind} retry spool failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function drainCanonicalCaptures(accountId: string): number {
  if (drainingAccounts.has(accountId)) return 0;
  const account = kernelAccounts.get(accountId);
  const runtime = getAsukaMemoryRuntime();
  if (!account || !runtime || !fs.existsSync(account.spoolPath)) return 0;
  drainingAccounts.add(accountId);
  try {
    const lines = fs.readFileSync(account.spoolPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const remaining: string[] = [];
    let drained = 0;
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as QueuedCanonicalCapture;
        if (
          record.schemaVersion !== 1
          || !["user", "assistant", "proactive", "control"].includes(record.kind)
          || !record.event
          || record.event.accountId !== accountId
        ) {
          throw new Error("invalid canonical retry record");
        }
        ingestCanonicalCapture(runtime, record.kind, record.event);
        drained += 1;
      } catch (error) {
        remaining.push(line);
        account.logger?.warn?.(
          `[asuka-memory] canonical retry remains queued: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (remaining.length === 0) {
      fs.rmSync(account.spoolPath, { force: true });
    } else {
      const temporary = `${account.spoolPath}.tmp`;
      fs.writeFileSync(temporary, `${remaining.join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, account.spoolPath);
    }
    return drained;
  } finally {
    drainingAccounts.delete(accountId);
  }
}

function scheduleCanonicalDrain(accountId: string, delayMs: number): void {
  if (retryTimers.has(accountId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(accountId);
    const account = kernelAccounts.get(accountId);
    if (!account) return;
    drainCanonicalCaptures(accountId);
    if (fs.existsSync(account.spoolPath)) {
      scheduleCanonicalDrain(accountId, 5_000);
    }
  }, delayMs);
  timer.unref?.();
  retryTimers.set(accountId, timer);
}

function capture(
  kind: CaptureKind,
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  const runtime = getAsukaMemoryRuntime();
  const event = eventInput(context, input);
  if (!runtime) {
    if (kernelAccounts.has(context.accountId)) {
      appendCanonicalCapture(context.accountId, kind, event, logger);
    } else if (kind !== "control") {
      queueLegacyCapture(kind, context, input, logger);
    }
    return undefined;
  }
  try {
    return ingestCanonicalCapture(runtime, kind, event);
  } catch (error) {
    logger?.error?.(
      `[asuka-memory] ${kind} event capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (kernelAccounts.has(context.accountId)) {
      appendCanonicalCapture(context.accountId, kind, event, logger);
    } else if (kind !== "control") {
      queueLegacyCapture(kind, context, input, logger);
    }
    return undefined;
  }
}

function queueLegacyCapture(
  kind: Exclude<CaptureKind, "control">,
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): void {
  if (kind === "user" && /^sudo(?:\s+|[：:])/i.test(input.text.trim())) return;
  const task = kind === "user"
    ? recordAsukaLongTermMemoryFromUserMessageWithModel(
      context,
      input.text,
      input.occurredAt,
    )
    : recordAsukaLongTermMemoryFromAssistantReply(
      context,
      input.text,
      input.occurredAt,
    );
  void task.catch((error) => {
    logger?.warn?.(
      `[asuka-memory] legacy ${kind} capture failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

export function captureAsukaUserMemory(
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  return capture("user", context, input, logger);
}

export function captureAsukaAssistantMemory(
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  return capture("assistant", context, input, logger);
}

export function captureAsukaProactiveMemory(
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  return capture("proactive", context, input, logger);
}

export function captureAsukaMemoryControl(
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  return capture("control", context, input, logger);
}

function unavailableMemoryContext(startedAt: number): MemoryContextResult {
  return {
    prompt: "",
    claims: [],
    claimIds: [],
    sourceEventIds: [],
    usedFallback: true,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function retrieveQQBotAsukaMemory(
  context: AsukaPeerContext,
  query: string,
  logger?: AsukaMemoryRuntimeLogger,
): Promise<MemoryContextResult | undefined> {
  const startedAt = Date.now();
  const runtime = getAsukaMemoryRuntime();
  if (!runtime) {
    return kernelAccounts.has(context.accountId)
      ? unavailableMemoryContext(startedAt)
      : undefined;
  }
  try {
    return await runtime.retrieveMemoryContext({
      accountId: context.accountId,
      peerKind: context.peerKind,
      peerId: context.peerId,
      query,
    });
  } catch (error) {
    logger?.warn?.(
      `[asuka-memory] canonical retrieval unavailable; legacy fallback is disabled: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return kernelAccounts.has(context.accountId)
      ? unavailableMemoryContext(startedAt)
      : undefined;
  }
}
