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
import {
  getAsukaMemoryRuntime,
  initializeAsukaMemoryRuntime,
  type AsukaLegacyMemoryWriter,
  type AsukaMemoryMessageInput,
  type AsukaMemoryRuntimeLogger,
} from "./runtime.js";
import type {
  MemoryContextResult,
  MemoryEvidencePayload,
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
  const kernel = getKernelConfig(rootConfig);
  if (kernel.enabled !== true) return undefined;
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

function capture(
  kind: "user" | "assistant" | "proactive",
  context: AsukaPeerContext,
  input: QQBotMemoryCaptureInput,
  logger?: AsukaMemoryRuntimeLogger,
): MemoryIngestResult | undefined {
  const runtime = getAsukaMemoryRuntime();
  if (!runtime) {
    queueLegacyCapture(kind, context, input, logger);
    return undefined;
  }
  try {
    const event = eventInput(context, input);
    if (kind === "user") return runtime.ingestUserMessage(event);
    if (kind === "assistant") return runtime.ingestAssistantReply(event);
    return runtime.ingestProactiveMessage(event);
  } catch (error) {
    logger?.error?.(
      `[asuka-memory] ${kind} event capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    queueLegacyCapture(kind, context, input, logger);
    return undefined;
  }
}

function queueLegacyCapture(
  kind: "user" | "assistant" | "proactive",
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

export async function retrieveQQBotAsukaMemory(
  context: AsukaPeerContext,
  query: string,
  logger?: AsukaMemoryRuntimeLogger,
): Promise<MemoryContextResult | undefined> {
  const runtime = getAsukaMemoryRuntime();
  if (!runtime) return undefined;
  try {
    return await runtime.retrieveMemoryContext({
      accountId: context.accountId,
      peerKind: context.peerKind,
      peerId: context.peerId,
      query,
    });
  } catch (error) {
    logger?.warn?.(
      `[asuka-memory] retrieval failed, using legacy fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
