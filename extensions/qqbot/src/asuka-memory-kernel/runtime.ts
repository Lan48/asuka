import path from "node:path";
import { AsukaMemoryEngine } from "./engine.js";
import { AsukaMemoryLedger, getDefaultMemoryLedgerPath } from "./ledger.js";
import { importWikiOverrides, projectMemoryWiki } from "./wiki.js";
import type {
  MemoryContextResult,
  MemoryEvent,
  MemoryEventInput,
  MemoryIngestResult,
  MemoryJobBatchResult,
  MemoryModelAdapter,
  MemoryProjectionSnapshot,
  MemoryRetrievalRequest,
} from "./types.js";

const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_MAX_JOBS = 25;
const DEFAULT_WIKI_DEBOUNCE_MS = 60_000;
const DEFAULT_WIKI_IMPORT_INTERVAL_MS = 60_000;
const MIN_MIGRATION_INPUT_CHARS = 512;
const MAX_MIGRATION_INPUT_CHARS = 1_000_000;
const MAX_MIGRATION_ITEMS = 1_000;
const MIN_MODEL_OUTPUT_TOKENS = 64;
const MAX_MODEL_OUTPUT_TOKENS = 16_000;

type UnknownRecord = Record<string, unknown>;

export interface ResolvedAsukaMemoryKernelConfig {
  enabled: boolean;
  databasePath: string;
  enableVector: boolean;
  inferencePromotionConfidence?: number;
  maxJobAttempts?: number;
  model: unknown;
  timeouts: {
    judgementMs?: number;
    retrievalMs?: number;
    rerankTaskMs?: number;
  };
  migration: {
    extractionMaxInputChars?: number;
    extractionMaxProposals?: number;
    extractionMaxTokens?: number;
    consolidationMaxInputChars?: number;
    consolidationMaxClaimsPerBatch?: number;
    consolidationMaxTokens?: number;
  };
  worker: {
    enabled: boolean;
    intervalMs: number;
    maxJobs: number;
  };
  wiki: {
    enabled: boolean;
    memoryRoot?: string;
    title?: string;
    identityId?: string;
    accountId?: string;
    peerId?: string;
    debounceMs: number;
    overrideImportIntervalMs: number;
  };
}

export interface AsukaMemoryRuntimeLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface AsukaMemoryRuntimeDependencies {
  model?: MemoryModelAdapter;
  createModelAdapter?(settings: unknown): MemoryModelAdapter | undefined;
  logger?: AsukaMemoryRuntimeLogger;
}

export interface AsukaLegacyMemoryWriteContext {
  reason: "event_ingested" | "claims_changed";
  occurredAt: number;
  event?: MemoryEvent;
  scope?: {
    identityId: string;
    accountId: string;
    peerKind: MemoryEvent["peerKind"];
    peerId: string;
  };
  snapshot: MemoryProjectionSnapshot;
}

export type AsukaLegacyMemoryWriter = (
  context: AsukaLegacyMemoryWriteContext,
) => void | Promise<void>;

export type AsukaMemoryMessageInput = Omit<MemoryEventInput, "actor" | "kind">;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalNumber(
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function configuredPath(value: string | undefined, fallback?: string): string | undefined {
  const selected = value ?? fallback;
  if (!selected || selected === ":memory:") return selected;
  return path.resolve(selected);
}

export function resolveAsukaMemoryKernelConfig(
  rootConfig: unknown,
): ResolvedAsukaMemoryKernelConfig {
  const channels = asRecord(asRecord(rootConfig).channels);
  const qqbot = asRecord(channels.qqbot);
  const kernel = asRecord(qqbot.memoryKernel);
  const paths = asRecord(kernel.paths);
  const timeouts = asRecord(kernel.timeouts);
  const migration = asRecord(kernel.migration);
  const worker = asRecord(kernel.worker);
  const wiki = asRecord(kernel.wiki);
  const enabled = kernel.enabled === true;
  const memoryRoot = configuredPath(
    optionalString(wiki.memoryRoot) ?? optionalString(paths.wiki),
  );
  if (enabled && wiki.enabled === true && !memoryRoot) {
    throw new Error(
      "channels.qqbot.memoryKernel.wiki.memoryRoot is required when Memory Wiki is enabled",
    );
  }

  return {
    enabled,
    databasePath: configuredPath(
      optionalString(kernel.databasePath) ?? optionalString(paths.ledger),
      getDefaultMemoryLedgerPath(),
    )!,
    enableVector: kernel.enableVector !== false,
    inferencePromotionConfidence: typeof kernel.inferencePromotionConfidence === "number"
      && Number.isFinite(kernel.inferencePromotionConfidence)
      ? Math.max(0, Math.min(1, kernel.inferencePromotionConfidence))
      : undefined,
    maxJobAttempts: optionalNumber(kernel.maxJobAttempts, 1, 100),
    model: kernel.model,
    timeouts: {
      judgementMs: optionalNumber(
        timeouts.judgementMs ?? kernel.judgementTimeoutMs,
        100,
      ),
      retrievalMs: optionalNumber(
        timeouts.retrievalMs ?? kernel.rerankDeadlineMs,
        10,
      ),
      rerankTaskMs: optionalNumber(
        timeouts.rerankTaskMs ?? kernel.rerankTaskTimeoutMs,
        100,
      ),
    },
    migration: {
      extractionMaxInputChars: optionalNumber(
        migration.extractionMaxInputChars
          ?? migration.legacyExtractionMaxInputChars
          ?? kernel.legacyExtractionMaxInputChars,
        MIN_MIGRATION_INPUT_CHARS,
        MAX_MIGRATION_INPUT_CHARS,
      ),
      extractionMaxProposals: optionalNumber(
        migration.extractionMaxProposals
          ?? migration.legacyExtractionMaxProposals
          ?? kernel.legacyExtractionMaxProposals,
        1,
        MAX_MIGRATION_ITEMS,
      ),
      extractionMaxTokens: optionalNumber(
        migration.extractionMaxTokens
          ?? migration.legacyExtractionMaxTokens
          ?? kernel.legacyExtractionMaxTokens,
        MIN_MODEL_OUTPUT_TOKENS,
        MAX_MODEL_OUTPUT_TOKENS,
      ),
      consolidationMaxInputChars: optionalNumber(
        migration.consolidationMaxInputChars
          ?? migration.legacyConsolidationMaxInputChars
          ?? kernel.legacyConsolidationMaxInputChars,
        MIN_MIGRATION_INPUT_CHARS,
        MAX_MIGRATION_INPUT_CHARS,
      ),
      consolidationMaxClaimsPerBatch: optionalNumber(
        migration.consolidationMaxClaimsPerBatch
          ?? migration.legacyConsolidationMaxClaimsPerBatch
          ?? kernel.legacyConsolidationMaxClaimsPerBatch,
        1,
        MAX_MIGRATION_ITEMS,
      ),
      consolidationMaxTokens: optionalNumber(
        migration.consolidationMaxTokens
          ?? migration.legacyConsolidationMaxTokens
          ?? kernel.legacyConsolidationMaxTokens,
        MIN_MODEL_OUTPUT_TOKENS,
        MAX_MODEL_OUTPUT_TOKENS,
      ),
    },
    worker: {
      enabled: worker.enabled !== false,
      intervalMs: optionalNumber(worker.intervalMs, 10, 3_600_000)
        ?? DEFAULT_WORKER_INTERVAL_MS,
      maxJobs: optionalNumber(worker.maxJobs, 1, 500) ?? DEFAULT_WORKER_MAX_JOBS,
    },
    wiki: {
      enabled: wiki.enabled === true,
      memoryRoot,
      title: optionalString(wiki.title),
      identityId: optionalString(wiki.identityId),
      accountId: optionalString(wiki.accountId),
      peerId: optionalString(wiki.peerId),
      debounceMs: optionalNumber(wiki.debounceMs, 10, 3_600_000)
        ?? DEFAULT_WIKI_DEBOUNCE_MS,
      overrideImportIntervalMs: optionalNumber(
        wiki.overrideImportIntervalMs,
        10,
        3_600_000,
      ) ?? DEFAULT_WIKI_IMPORT_INTERVAL_MS,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AsukaMemoryRuntime {
  readonly ledger: AsukaMemoryLedger;
  readonly engine: AsukaMemoryEngine;
  readonly config: ResolvedAsukaMemoryKernelConfig;

  private readonly logger: AsukaMemoryRuntimeLogger;
  private readonly legacyWriters = new Set<AsukaLegacyMemoryWriter>();
  private readonly pendingLegacyWrites = new Set<Promise<void>>();
  private workerTimer?: NodeJS.Timeout;
  private wikiTimer?: NodeJS.Timeout;
  private activeWorker?: Promise<MemoryJobBatchResult>;
  private workerRerunRequested = false;
  private lastOverrideImportAt = 0;
  private closing = false;
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(
    config: ResolvedAsukaMemoryKernelConfig,
    dependencies: AsukaMemoryRuntimeDependencies = {},
  ) {
    if (!config.enabled) {
      throw new Error("cannot create Asuka memory runtime while memoryKernel is disabled");
    }
    this.config = config;
    this.logger = dependencies.logger ?? console;
    const model = dependencies.model
      ?? dependencies.createModelAdapter?.(config.model);
    this.ledger = new AsukaMemoryLedger(config.databasePath, {
      enableVector: config.enableVector,
      inferencePromotionConfidence: config.inferencePromotionConfidence,
    });
    this.engine = new AsukaMemoryEngine(this.ledger, {
      judgementTimeoutMs: config.timeouts.judgementMs,
      rerankDeadlineMs: config.timeouts.retrievalMs,
      rerankTaskTimeoutMs: config.timeouts.rerankTaskMs,
      maxJobAttempts: config.maxJobAttempts,
      legacyExtractionMaxInputChars: config.migration.extractionMaxInputChars,
      legacyExtractionMaxProposals: config.migration.extractionMaxProposals,
      legacyExtractionMaxTokens: config.migration.extractionMaxTokens,
      legacyConsolidationMaxInputChars: config.migration.consolidationMaxInputChars,
      legacyConsolidationMaxClaimsPerBatch:
        config.migration.consolidationMaxClaimsPerBatch,
      legacyConsolidationMaxTokens: config.migration.consolidationMaxTokens,
      model,
      onProjectionChanged: (identityId) => {
        this.scheduleWikiProjection();
        this.notifyLegacyWriters("claims_changed", undefined, identityId);
      },
    });
    this.start();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private start(): void {
    if (this.config.worker.enabled) {
      this.workerTimer = setInterval(() => {
        void this.processPendingMemoryJobs();
      }, this.config.worker.intervalMs);
      this.workerTimer.unref?.();
      this.kickWorker();
    }
    this.scheduleWikiProjection();
  }

  private ensureOpen(): void {
    if (this.closing || this.closed) {
      throw new Error("Asuka memory runtime is closed");
    }
  }

  private kickWorker(): void {
    if (!this.config.worker.enabled || this.closing || this.closed) return;
    if (this.activeWorker) {
      this.workerRerunRequested = true;
      return;
    }
    queueMicrotask(() => {
      void this.processPendingMemoryJobs();
    });
  }

  private importOverrides(force: boolean): void {
    const wiki = this.config.wiki;
    if (
      !wiki.enabled
      || !wiki.memoryRoot
      || !wiki.accountId
      || !wiki.peerId
    ) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastOverrideImportAt < wiki.overrideImportIntervalMs) return;
    this.lastOverrideImportAt = now;
    try {
      const result = importWikiOverrides(this.engine, {
        memoryRoot: wiki.memoryRoot,
        accountId: wiki.accountId,
        peerId: wiki.peerId,
        identityId: wiki.identityId,
      });
      if (result.imported > 0) {
        this.logger.info?.(
          `[asuka-memory] imported ${result.imported} Memory Wiki override(s)`,
        );
      }
    } catch (error) {
      this.logger.warn?.(
        `[asuka-memory] Memory Wiki override import failed: ${errorMessage(error)}`,
      );
    }
  }

  async processPendingMemoryJobs(): Promise<MemoryJobBatchResult> {
    if (this.closing || this.closed) {
      return {
        processed: 0,
        completed: 0,
        failed: 0,
        remaining: 0,
      };
    }
    if (this.activeWorker) return this.activeWorker;
    const worker = (async () => {
      this.importOverrides(false);
      return this.engine.processPendingMemoryJobs({
        maxJobs: this.config.worker.maxJobs,
      });
    })();
    this.activeWorker = worker;
    try {
      return await worker;
    } finally {
      if (this.activeWorker === worker) this.activeWorker = undefined;
      if (this.workerRerunRequested) {
        this.workerRerunRequested = false;
        this.kickWorker();
      }
    }
  }

  private scheduleWikiProjection(): void {
    if (
      !this.config.wiki.enabled
      || !this.config.wiki.memoryRoot
      || this.closing
      || this.closed
    ) {
      return;
    }
    if (this.wikiTimer) clearTimeout(this.wikiTimer);
    this.wikiTimer = setTimeout(() => {
      this.wikiTimer = undefined;
      void this.flushWiki().catch((error) => {
        this.logger.warn?.(
          `[asuka-memory] Memory Wiki projection failed: ${errorMessage(error)}`,
        );
      });
    }, this.config.wiki.debounceMs);
    this.wikiTimer.unref?.();
  }

  async flushWiki(): Promise<ReturnType<typeof projectMemoryWiki> | undefined> {
    if (this.closed) throw new Error("Asuka memory runtime is closed");
    const wiki = this.config.wiki;
    if (!wiki.enabled || !wiki.memoryRoot) return undefined;
    this.importOverrides(true);
    return projectMemoryWiki(
      this.ledger.getProjectionSnapshot(wiki.identityId),
      {
        memoryRoot: wiki.memoryRoot,
        title: wiki.title,
      },
    );
  }

  private notifyLegacyWriters(
    reason: AsukaLegacyMemoryWriteContext["reason"],
    event?: MemoryEvent,
    identityId?: string,
  ): void {
    if (this.legacyWriters.size === 0) return;
    const scopedIdentityId = event?.identityId ?? identityId;
    const snapshot = this.ledger.getProjectionSnapshot(scopedIdentityId);
    const scopeEvent = event ?? (
      scopedIdentityId
        ? this.ledger.listEvents(scopedIdentityId)[0]
        : undefined
    );
    const context: AsukaLegacyMemoryWriteContext = {
      reason,
      occurredAt: Date.now(),
      event,
      scope: scopeEvent
        ? {
          identityId: scopeEvent.identityId,
          accountId: scopeEvent.accountId,
          peerKind: scopeEvent.peerKind,
          peerId: scopeEvent.peerId,
        }
        : undefined,
      snapshot,
    };
    for (const writer of this.legacyWriters) {
      const task = (async () => {
        try {
          await writer(context);
        } catch (error) {
          this.logger.warn?.(
            `[asuka-memory] legacy memory dual-write failed: ${errorMessage(error)}`,
          );
        }
      })();
      this.pendingLegacyWrites.add(task);
      void task.finally(() => {
        this.pendingLegacyWrites.delete(task);
      });
    }
  }

  registerLegacyWriter(writer: AsukaLegacyMemoryWriter): () => void {
    this.ensureOpen();
    this.legacyWriters.add(writer);
    return () => {
      this.legacyWriters.delete(writer);
    };
  }

  ingestMemoryEvent(input: MemoryEventInput): MemoryIngestResult {
    this.ensureOpen();
    const result = this.engine.ingestMemoryEvent(input);
    if (result.receipt?.inserted) {
      this.notifyLegacyWriters(
        "event_ingested",
        this.ledger.getEvent(result.receipt.eventId),
      );
      this.kickWorker();
    }
    return result;
  }

  ingestUserMessage(input: AsukaMemoryMessageInput): MemoryIngestResult {
    return this.ingestMemoryEvent({
      ...input,
      actor: "user",
      kind: "user_message",
    });
  }

  ingestAssistantReply(input: AsukaMemoryMessageInput): MemoryIngestResult {
    return this.ingestMemoryEvent({
      ...input,
      actor: "asuka",
      kind: "assistant_reply",
    });
  }

  ingestProactiveMessage(input: AsukaMemoryMessageInput): MemoryIngestResult {
    return this.ingestMemoryEvent({
      ...input,
      actor: "asuka",
      kind: "proactive_message",
    });
  }

  retrieveMemoryContext(
    request: MemoryRetrievalRequest,
  ): Promise<MemoryContextResult> {
    this.ensureOpen();
    return this.engine.retrieveMemoryContext(request);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.closing = true;
      if (this.workerTimer) {
        clearInterval(this.workerTimer);
        this.workerTimer = undefined;
      }
      if (this.wikiTimer) {
        clearTimeout(this.wikiTimer);
        this.wikiTimer = undefined;
      }
      if (this.activeWorker) {
        try {
          await this.activeWorker;
        } catch (error) {
          this.logger.warn?.(
            `[asuka-memory] background worker failed during shutdown: ${errorMessage(error)}`,
          );
        }
      }
      try {
        await this.flushWiki();
      } catch (error) {
        this.logger.warn?.(
          `[asuka-memory] Memory Wiki flush failed during shutdown: ${errorMessage(error)}`,
        );
      }
      await Promise.allSettled(this.pendingLegacyWrites);
      this.legacyWriters.clear();
      this.ledger.close();
      this.closed = true;
    })();
    return this.shutdownPromise;
  }

  close(): Promise<void> {
    return this.shutdown();
  }
}

let singletonRuntime: AsukaMemoryRuntime | undefined;

export function initializeAsukaMemoryRuntime(
  rootConfig: unknown,
  dependencies: AsukaMemoryRuntimeDependencies = {},
): AsukaMemoryRuntime | undefined {
  const config = resolveAsukaMemoryKernelConfig(rootConfig);
  if (!config.enabled) return undefined;
  if (singletonRuntime && !singletonRuntime.isClosed) return singletonRuntime;
  singletonRuntime = new AsukaMemoryRuntime(config, dependencies);
  return singletonRuntime;
}

export function getAsukaMemoryRuntime(): AsukaMemoryRuntime | undefined {
  return singletonRuntime && !singletonRuntime.isClosed
    ? singletonRuntime
    : undefined;
}

export async function shutdownAsukaMemoryRuntime(): Promise<void> {
  const runtime = singletonRuntime;
  singletonRuntime = undefined;
  await runtime?.shutdown();
}

export async function resetAsukaMemoryRuntime(): Promise<void> {
  await shutdownAsukaMemoryRuntime();
}
