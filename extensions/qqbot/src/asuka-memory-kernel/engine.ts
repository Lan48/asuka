import { createHash, randomUUID } from "node:crypto";
import { AsukaMemoryLedger } from "./ledger.js";
import {
  buildLegacyConsolidationPrompt,
  buildLegacyExtractionPrompt,
  buildMemoryJudgementPrompt,
  buildRerankPrompt,
  parseLegacyConsolidation,
  parseLegacyExtraction,
  parseMemoryJudgement,
  parseRerankResult,
  type LegacyConsolidationDecision,
  type LegacyConsolidationDecisionClaim,
  type LegacyConsolidationPromptItem,
} from "./model-tasks.js";
import { containsDeterministicSecret } from "./policy.js";
import type {
  LegacyConsolidationClaim,
  LegacyConsolidationDiscard,
  LegacyConsolidationRun,
  MemoryClaim,
  MemoryContextResult,
  MemoryEngineOptions,
  MemoryEvent,
  MemoryEventInput,
  MemoryIngestResult,
  MemoryJob,
  MemoryJobBatchResult,
  MemoryJudgement,
  MemoryModelAdapter,
  MemoryRetrievalRequest,
  MemorySearchCandidate,
  MemoryVisibility,
} from "./types.js";

const JUDGEMENT_PROMPT_VERSION = 2;
const RERANK_PROMPT_VERSION = 1;
const LEGACY_EXTRACTION_PROMPT_VERSION = 1;
const LEGACY_CONSOLIDATION_PROMPT_VERSION = 1;
const DEFAULT_JUDGEMENT_TIMEOUT_MS = 12_000;
const DEFAULT_RERANK_DEADLINE_MS = 1_500;
const DEFAULT_RERANK_TASK_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_JOB_ATTEMPTS = 8;
const DEFAULT_LEGACY_EXTRACTION_MAX_INPUT_CHARS = 12_000;
const DEFAULT_LEGACY_EXTRACTION_MAX_PROPOSALS = 12;
const DEFAULT_LEGACY_EXTRACTION_MAX_TOKENS = 3_200;
const DEFAULT_LEGACY_CONSOLIDATION_MAX_INPUT_CHARS = 12_000;
const DEFAULT_LEGACY_CONSOLIDATION_MAX_CLAIMS_PER_BATCH = 32;
const DEFAULT_LEGACY_CONSOLIDATION_MAX_TOKENS = 4_000;
const MAX_LEGACY_CONSOLIDATION_ROUNDS = 8;
const MAX_CURRENT_CLAIMS_FOR_JUDGEMENT = 40;

interface AdjudicateResult {
  eventId: string;
  judgement: MemoryJudgement;
  claimIds: string[];
}

interface LocalRetrieval {
  identityId: string;
  maxPromptChars: number;
  candidates: MemorySearchCandidate[];
  result: MemoryContextResult;
}

interface LegacyConsolidationRound {
  round: number;
  inputItems: number;
  batches: number;
  outputItems: number;
  discardedCandidates: number;
  coveredCandidates: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function legacyConsolidationInputHash(
  identityId: string,
  visibility: MemoryVisibility,
  candidateIds: string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      identityId,
      visibility,
      candidateIds: [...candidateIds].sort(),
    }))
    .digest("hex");
}

function deadlineTimeout(ms: number): {
  promise: Promise<"timeout">;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dynamicPromptBudget(query: string, requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(600, Math.min(4_000, Math.floor(requested)));
  }
  const normalizedLength = query.replace(/\s+/g, "").length;
  return Math.max(1_000, Math.min(2_400, 1_050 + normalizedLength * 10));
}

function candidateLimit(promptBudget: number, requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(4, Math.min(80, Math.floor(requested)));
  }
  return Math.max(12, Math.min(36, Math.ceil(promptBudget / 90)));
}

function visibilityForRequest(request: MemoryRetrievalRequest): MemoryVisibility {
  return request.peerKind === "direct" ? "private" : "public";
}

function reorderCandidates(
  candidates: MemorySearchCandidate[],
  claimIds: string[],
): MemorySearchCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.claim.claimId, candidate]));
  const ordered: MemorySearchCandidate[] = [];
  for (const claimId of claimIds) {
    const candidate = byId.get(claimId);
    if (!candidate) continue;
    ordered.push(candidate);
    byId.delete(claimId);
  }
  ordered.push(...[...byId.values()].sort((a, b) => b.localScore - a.localScore));
  return ordered;
}

function renderMemoryPrompt(
  candidates: MemorySearchCandidate[],
  maxPromptChars: number,
): { prompt: string; claims: MemoryClaim[] } {
  if (candidates.length === 0) return { prompt: "", claims: [] };
  const header = [
    "【Asuka 相关记忆】",
    "- 只在与本轮自然相关时使用，不要逐条背诵或暴露内部记忆结构。",
    "- [明确事实] 可以自然使用；[推断] 必须保留“我感觉/我记得好像”等不确定表达。",
    "- 明确事实与推断冲突时，以明确事实为准；当前有效声明优先于历史摘要。",
    "- 这些内容遵守当前会话权限，禁止转述到其他用户或不相干群聊。",
  ];
  const lines = [...header];
  const selected: MemoryClaim[] = [];
  for (const candidate of candidates) {
    const claim = candidate.claim;
    const label = claim.epistemicStatus === "explicit" ? "明确事实" : "推断";
    const validity = claim.validTo !== undefined
      ? `，有效至 ${new Date(claim.validTo).toISOString()}`
      : "";
    const line = `- [${label}] ${claim.canonicalText}${validity}`;
    const next = [...lines, line].join("\n");
    if (next.length > maxPromptChars) continue;
    lines.push(line);
    selected.push(claim);
  }
  return selected.length > 0
    ? { prompt: lines.join("\n"), claims: selected }
    : { prompt: "", claims: [] };
}

export class AsukaMemoryEngine {
  private readonly judgementTimeoutMs: number;
  private readonly rerankDeadlineMs: number;
  private readonly rerankTaskTimeoutMs: number;
  private readonly maxJobAttempts: number;
  private readonly legacyExtractionMaxInputChars: number;
  private readonly legacyExtractionMaxProposals: number;
  private readonly legacyExtractionMaxTokens: number;
  private readonly legacyConsolidationMaxInputChars: number;
  private readonly legacyConsolidationMaxClaimsPerBatch: number;
  private readonly legacyConsolidationMaxTokens: number;
  private readonly model?: MemoryModelAdapter;
  private readonly onProjectionChanged?: () => void;

  constructor(
    readonly ledger: AsukaMemoryLedger,
    options: MemoryEngineOptions = {},
  ) {
    this.judgementTimeoutMs = Math.max(100, options.judgementTimeoutMs ?? DEFAULT_JUDGEMENT_TIMEOUT_MS);
    this.rerankDeadlineMs = Math.max(10, options.rerankDeadlineMs ?? DEFAULT_RERANK_DEADLINE_MS);
    this.rerankTaskTimeoutMs = Math.max(100, options.rerankTaskTimeoutMs ?? DEFAULT_RERANK_TASK_TIMEOUT_MS);
    this.maxJobAttempts = Math.max(1, options.maxJobAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS);
    this.legacyExtractionMaxInputChars = boundedInteger(
      options.legacyExtractionMaxInputChars,
      DEFAULT_LEGACY_EXTRACTION_MAX_INPUT_CHARS,
      512,
      1_000_000,
    );
    this.legacyExtractionMaxProposals = boundedInteger(
      options.legacyExtractionMaxProposals,
      DEFAULT_LEGACY_EXTRACTION_MAX_PROPOSALS,
      1,
      1_000,
    );
    this.legacyExtractionMaxTokens = boundedInteger(
      options.legacyExtractionMaxTokens,
      DEFAULT_LEGACY_EXTRACTION_MAX_TOKENS,
      64,
      16_000,
    );
    this.legacyConsolidationMaxInputChars = boundedInteger(
      options.legacyConsolidationMaxInputChars,
      DEFAULT_LEGACY_CONSOLIDATION_MAX_INPUT_CHARS,
      512,
      1_000_000,
    );
    this.legacyConsolidationMaxClaimsPerBatch = boundedInteger(
      options.legacyConsolidationMaxClaimsPerBatch,
      DEFAULT_LEGACY_CONSOLIDATION_MAX_CLAIMS_PER_BATCH,
      1,
      1_000,
    );
    this.legacyConsolidationMaxTokens = boundedInteger(
      options.legacyConsolidationMaxTokens,
      DEFAULT_LEGACY_CONSOLIDATION_MAX_TOKENS,
      64,
      16_000,
    );
    this.model = options.model;
    this.onProjectionChanged = options.onProjectionChanged;
  }

  ingestMemoryEvent(
    input: MemoryEventInput,
    options: {
      enqueue?: boolean;
      jobKind?: "adjudicate" | "legacy_rejudge";
    } = {},
  ): MemoryIngestResult {
    const normalizedText = input.text.replace(/\s+/g, " ").trim();
    const containsSecret = containsDeterministicSecret([
      normalizedText,
      input.evidence?.excerpt,
      input.evidence?.transcript,
      input.evidence?.imageSummary,
    ].filter(Boolean).join("\n"));
    const safeInput: MemoryEventInput = containsSecret
      ? {
        ...input,
        text: "[secret-bearing content omitted]",
        evidence: {},
        metadata: {
          ...(input.metadata ?? {}),
          secretRedacted: true,
        },
      }
      : {
        ...input,
        text: normalizedText,
      };
    const receipt = this.ledger.appendEvent(safeInput);
    if (!containsSecret && receipt.inserted && options.enqueue !== false) {
      this.ledger.enqueueJob(receipt.eventId, options.jobKind ?? "adjudicate");
    }
    return {
      accepted: !containsSecret,
      redacted: containsSecret,
      receipt,
      reason: containsSecret ? "deterministic_secret_filter" : undefined,
    };
  }

  applyHumanOverride(input: Omit<MemoryEventInput, "actor" | "kind">): MemoryIngestResult {
    return this.ingestMemoryEvent({
      ...input,
      actor: "user",
      kind: "human_override",
    });
  }

  forgetMemory(input: Omit<MemoryEventInput, "actor" | "kind">): MemoryIngestResult {
    return this.ingestMemoryEvent({
      ...input,
      actor: "user",
      kind: "memory_control",
      metadata: {
        ...(input.metadata ?? {}),
        requestedOperation: "forget_or_delete",
      },
    });
  }

  async adjudicateEvent(
    eventId: string,
    options: { runTask?: "adjudicate" | "legacy_rejudge" } = {},
  ): Promise<AdjudicateResult> {
    if (options.runTask === "legacy_rejudge") {
      return this.extractLegacyEvent(eventId);
    }
    if (!this.model) throw new Error("memory judgement model is not configured");
    const event = this.ledger.getEvent(eventId);
    if (!event) throw new Error(`memory event not found: ${eventId}`);
    const currentClaims = this.ledger.listClaims({
      identityId: event.identityId,
      states: ["active", "candidate"],
      visibility: event.visibility,
      now: event.occurredAt,
    }).filter((claim) =>
      claim.metadata.migrationPendingRejudge !== true
      && claim.metadata.migrationPendingConsolidation !== true
    ).slice(0, MAX_CURRENT_CLAIMS_FOR_JUDGEMENT);
    const prompt = buildMemoryJudgementPrompt(event, currentClaims);
    const startedAt = Date.now();
    let raw = "";
    try {
      raw = await this.model.complete({
        task: "adjudicate",
        prompt,
        timeoutMs: this.judgementTimeoutMs,
        schemaVersion: JUDGEMENT_PROMPT_VERSION,
      });
      const judgement = parseMemoryJudgement(raw, event);
      const claimIds: string[] = [];
      for (const proposal of judgement.proposals) {
        const result = this.ledger.applyClaimProposal(eventId, proposal);
        if (result.claimId) claimIds.push(result.claimId);
      }
      this.ledger.recordModelRun({
        task: "adjudicate",
        promptVersion: JUDGEMENT_PROMPT_VERSION,
        status: "completed",
        elapsedMs: Date.now() - startedAt,
        inputEventId: eventId,
        resultSummary: JSON.stringify({
          proposalCount: judgement.proposals.length,
          claimIds,
          noMemoryReason: judgement.noMemoryReason,
        }),
      });
      if (claimIds.length > 0) {
        this.onProjectionChanged?.();
        if (claimIds.length > 0 && this.model.embed) {
          this.ledger.enqueueJob(eventId, "embed");
        }
      }
      return { eventId, judgement, claimIds };
    } catch (error) {
      this.ledger.recordModelRun({
        task: "adjudicate",
        promptVersion: JUDGEMENT_PROMPT_VERSION,
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        inputEventId: eventId,
        resultSummary: raw.slice(0, 500),
        error: safeError(error),
      });
      throw error;
    }
  }

  private async extractLegacyEvent(eventId: string): Promise<AdjudicateResult> {
    if (!this.model) throw new Error("legacy extraction model is not configured");
    const event = this.ledger.getEvent(eventId);
    if (!event || event.kind !== "legacy_import") {
      throw new Error(`legacy extraction source event not found: ${eventId}`);
    }
    const existing = this.ledger.getLegacyExtraction(eventId);
    if (existing) {
      return {
        eventId,
        judgement: {
          eventId,
          proposals: [],
          noMemoryReason: existing.noMemoryReason,
        },
        claimIds: existing.candidateClaimIds,
      };
    }

    const prompt = buildLegacyExtractionPrompt(event);
    const startedAt = Date.now();
    let raw = "";
    try {
      if (prompt.length > this.legacyExtractionMaxInputChars) {
        throw new Error(
          `legacy extraction input exceeds configured budget: ${prompt.length} > ${this.legacyExtractionMaxInputChars}`,
        );
      }
      raw = await this.model.complete({
        task: "legacy_extract",
        prompt,
        timeoutMs: this.judgementTimeoutMs,
        schemaVersion: LEGACY_EXTRACTION_PROMPT_VERSION,
        maxTokens: this.legacyExtractionMaxTokens,
      });
      const judgement = parseLegacyExtraction(
        raw,
        event,
        this.legacyExtractionMaxProposals,
      );
      const extraction = this.ledger.recordLegacyExtraction(eventId, judgement);
      this.ledger.recordModelRun({
        task: "legacy_extract",
        promptVersion: LEGACY_EXTRACTION_PROMPT_VERSION,
        status: "completed",
        elapsedMs: Date.now() - startedAt,
        inputEventId: eventId,
        resultSummary: JSON.stringify({
          disposition: extraction.disposition,
          candidateClaimIds: extraction.candidateClaimIds,
          noMemoryReason: extraction.noMemoryReason,
        }),
      });
      this.onProjectionChanged?.();
      return {
        eventId,
        judgement,
        claimIds: extraction.candidateClaimIds,
      };
    } catch (error) {
      this.ledger.recordModelRun({
        task: "legacy_extract",
        promptVersion: LEGACY_EXTRACTION_PROMPT_VERSION,
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        inputEventId: eventId,
        resultSummary: raw.slice(0, 500),
        error: safeError(error),
      });
      throw error;
    }
  }

  private partitionLegacyConsolidationItems(
    items: LegacyConsolidationPromptItem[],
  ): LegacyConsolidationPromptItem[][] {
    const batches: LegacyConsolidationPromptItem[][] = [];
    let current: LegacyConsolidationPromptItem[] = [];
    for (const item of items) {
      const singlePromptLength = buildLegacyConsolidationPrompt([item]).length;
      if (singlePromptLength > this.legacyConsolidationMaxInputChars) {
        throw new Error(
          `legacy consolidation item exceeds configured input budget: ${item.itemId}`,
        );
      }
      const proposed = [...current, item];
      const overItemLimit = proposed.length > this.legacyConsolidationMaxClaimsPerBatch;
      const overCharacterLimit =
        buildLegacyConsolidationPrompt(proposed).length
        > this.legacyConsolidationMaxInputChars;
      if (current.length > 0 && (overItemLimit || overCharacterLimit)) {
        batches.push(current);
        current = [item];
      } else {
        current = proposed;
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  private legacyEvidenceExcerptChars(evidenceCount: number): number {
    const perItemBudget = Math.floor(
      this.legacyConsolidationMaxInputChars
      / Math.max(1, this.legacyConsolidationMaxClaimsPerBatch)
      / 4,
    );
    return Math.max(32, Math.min(1_000, Math.floor(
      perItemBudget / Math.max(1, evidenceCount),
    )));
  }

  private async consolidateLegacyBatch(
    run: LegacyConsolidationRun,
    items: LegacyConsolidationPromptItem[],
    round: number,
    batch: number,
  ): Promise<LegacyConsolidationDecision> {
    if (!this.model) throw new Error("legacy consolidation model is not configured");
    const prompt = buildLegacyConsolidationPrompt(items);
    if (prompt.length > this.legacyConsolidationMaxInputChars) {
      throw new Error(
        `legacy consolidation batch exceeds configured budget: ${prompt.length} > ${this.legacyConsolidationMaxInputChars}`,
      );
    }
    const startedAt = Date.now();
    let raw = "";
    try {
      raw = await this.model.complete({
        task: "legacy_consolidate",
        prompt,
        timeoutMs: this.judgementTimeoutMs,
        schemaVersion: LEGACY_CONSOLIDATION_PROMPT_VERSION,
        maxTokens: this.legacyConsolidationMaxTokens,
      });
      const decision = parseLegacyConsolidation(
        raw,
        new Set(items.map((item) => item.itemId)),
        this.legacyConsolidationMaxClaimsPerBatch,
      );
      this.ledger.recordModelRun({
        task: "legacy_consolidate",
        promptVersion: LEGACY_CONSOLIDATION_PROMPT_VERSION,
        status: "completed",
        elapsedMs: Date.now() - startedAt,
        resultSummary: JSON.stringify({
          consolidationRunId: run.runId,
          round,
          batch,
          inputItems: items.length,
          claims: decision.claims.length,
          discarded: decision.discarded.length,
        }),
      });
      return decision;
    } catch (error) {
      this.ledger.recordModelRun({
        task: "legacy_consolidate",
        promptVersion: LEGACY_CONSOLIDATION_PROMPT_VERSION,
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        resultSummary: raw.slice(0, 500),
        error: safeError(error),
      });
      throw error;
    }
  }

  private legacyDecisionClaimToPromptItem(
    decision: LegacyConsolidationDecisionClaim,
    sourceItems: Map<string, LegacyConsolidationPromptItem>,
    round: number,
    index: number,
  ): LegacyConsolidationPromptItem {
    const sources = decision.sourceItemIds.map((itemId) => {
      const item = sourceItems.get(itemId);
      if (!item) throw new Error(`legacy consolidation source item not found: ${itemId}`);
      return item;
    });
    const sourceCandidateIds = unique(sources.flatMap((item) => item.sourceCandidateIds));
    const evidence = new Map<string, LegacyConsolidationPromptItem["evidence"][number]>();
    for (const item of sources) {
      for (const itemEvidence of item.evidence) {
        evidence.set(itemEvidence.eventId, {
          eventId: itemEvidence.eventId,
          actor: itemEvidence.actor,
          kind: itemEvidence.kind,
          occurredAt: itemEvidence.occurredAt,
          text: itemEvidence.text,
        });
      }
    }
    const excerptChars = this.legacyEvidenceExcerptChars(evidence.size);
    const itemId = `legacy-consolidated-${createHash("sha256")
      .update(JSON.stringify({
        round,
        index,
        semanticKey: decision.semanticKey,
        sourceCandidateIds: [...sourceCandidateIds].sort(),
      }))
      .digest("hex")
      .slice(0, 24)}`;
    return {
      itemId,
      sourceCandidateIds,
      subjectId: decision.subjectId,
      predicate: decision.predicate,
      value: decision.value,
      canonicalText: decision.canonicalText,
      topLevelType: decision.topLevelType,
      epistemicStatus: decision.epistemicStatus,
      confidence: decision.confidence,
      validFrom: decision.validFrom,
      validTo: decision.validTo,
      topic: decision.topic,
      entityIds: decision.entityIds,
      lifecycle: decision.lifecycle,
      evidence: [...evidence.values()]
        .map((item) => ({
          ...item,
          text: item.text?.slice(0, excerptChars),
        }))
        .sort((left, right) =>
          left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId)
        ),
    };
  }

  private legacyDecisionClaimToFinal(
    decision: LegacyConsolidationDecisionClaim,
    sourceItems: Map<string, LegacyConsolidationPromptItem>,
  ): LegacyConsolidationClaim {
    const sources = decision.sourceItemIds.map((itemId) => {
      const item = sourceItems.get(itemId);
      if (!item) throw new Error(`legacy consolidation source item not found: ${itemId}`);
      return item;
    });
    return {
      semanticKey: decision.semanticKey,
      sourceCandidateIds: unique(sources.flatMap((item) => item.sourceCandidateIds)),
      subjectId: decision.subjectId,
      predicate: decision.predicate,
      value: decision.value,
      canonicalText: decision.canonicalText,
      topLevelType: decision.topLevelType,
      epistemicStatus: decision.epistemicStatus,
      confidence: decision.confidence,
      validFrom: decision.validFrom,
      validTo: decision.validTo,
      topic: decision.topic,
      entityIds: decision.entityIds,
      lifecycle: decision.lifecycle,
      supportingEventIds: unique(
        sources.flatMap((item) => item.evidence.map((evidence) => evidence.eventId)),
      ),
      opposingEventIds: [],
    };
  }

  private legacyDecisionDiscardToFinal(
    sourceItemIds: string[],
    reason: string,
    sourceItems: Map<string, LegacyConsolidationPromptItem>,
  ): LegacyConsolidationDiscard {
    return {
      sourceCandidateIds: unique(sourceItemIds.flatMap((itemId) => {
        const item = sourceItems.get(itemId);
        if (!item) throw new Error(`legacy consolidation source item not found: ${itemId}`);
        return item.sourceCandidateIds;
      })),
      reason,
    };
  }

  async consolidateLegacyExtractions(): Promise<LegacyConsolidationRun[]> {
    const extractionGroups = new Map<string, ReturnType<AsukaMemoryLedger["listLegacyExtractions"]>>();
    for (const extraction of this.ledger.listLegacyExtractions()) {
      const key = `${extraction.identityId}\u0000${extraction.visibility}`;
      const group = extractionGroups.get(key) ?? [];
      group.push(extraction);
      extractionGroups.set(key, group);
    }

    const results: LegacyConsolidationRun[] = [];
    for (const extractions of extractionGroups.values()) {
      const candidateIds = extractions.flatMap((extraction) => extraction.candidateClaimIds);
      if (candidateIds.length === 0) continue;
      const { identityId, visibility } = extractions[0];
      const inputHash = legacyConsolidationInputHash(identityId, visibility, candidateIds);
      const run = this.ledger.beginLegacyConsolidation({
        identityId,
        visibility,
        inputHash,
        inputCandidateCount: candidateIds.length,
        sourceEventCount: extractions.length,
      });
      if (run.status === "completed") {
        results.push(run);
        continue;
      }

      const rounds: LegacyConsolidationRound[] = [];
      const discarded: LegacyConsolidationDiscard[] = [];
      try {
        if (!this.model) throw new Error("legacy consolidation model is not configured");
        let currentItems = candidateIds.map((candidateId): LegacyConsolidationPromptItem => {
          const candidate = this.ledger.getClaim(candidateId);
          if (
            !candidate
            || candidate.state !== "candidate"
            || candidate.metadata.migrationPendingConsolidation !== true
          ) {
            throw new Error(`legacy extraction candidate is invalid: ${candidateId}`);
          }
          const event = this.ledger.getEvent(candidate.sourceEventId);
          if (
            !event
            || event.kind !== "legacy_import"
            || event.identityId !== identityId
            || event.visibility !== visibility
          ) {
            throw new Error(`legacy extraction evidence is invalid: ${candidateId}`);
          }
          return {
            itemId: candidate.claimId,
            sourceCandidateIds: [candidate.claimId],
            subjectId: candidate.subjectId,
            predicate: candidate.predicate,
            value: candidate.value,
            canonicalText: candidate.canonicalText,
            topLevelType: candidate.topLevelType,
            epistemicStatus: candidate.epistemicStatus,
            confidence: candidate.confidence,
            validFrom: candidate.validFrom,
            validTo: candidate.validTo,
            topic: candidate.topic,
            entityIds: candidate.entityIds,
            lifecycle: candidate.metadata.lifecycle as
              | "stable"
              | "bounded"
              | "episodic"
              | "working"
              | undefined,
            evidence: [{
              eventId: event.eventId,
              actor: event.actor,
              kind: event.kind,
              occurredAt: event.occurredAt,
              text: event.text.slice(0, this.legacyEvidenceExcerptChars(1)),
            }],
          };
        }).sort((left, right) =>
          (left.evidence[0]?.occurredAt ?? 0) - (right.evidence[0]?.occurredAt ?? 0)
          || left.itemId.localeCompare(right.itemId)
        );

        for (let round = 1; round <= MAX_LEGACY_CONSOLIDATION_ROUNDS; round += 1) {
          const batches = this.partitionLegacyConsolidationItems(currentItems);
          const nextItems: LegacyConsolidationPromptItem[] = [];
          let finalClaims: LegacyConsolidationClaim[] | undefined;
          let discardedThisRound = 0;

          for (const [batchIndex, batchItems] of batches.entries()) {
            const sourceItems = new Map(batchItems.map((item) => [item.itemId, item]));
            const decision = await this.consolidateLegacyBatch(
              run,
              batchItems,
              round,
              batchIndex + 1,
            );
            for (const item of decision.discarded) {
              const finalDiscard = this.legacyDecisionDiscardToFinal(
                item.sourceItemIds,
                item.reason,
                sourceItems,
              );
              discarded.push(finalDiscard);
              discardedThisRound += finalDiscard.sourceCandidateIds.length;
            }
            if (batches.length === 1) {
              finalClaims = decision.claims.map((claim) =>
                this.legacyDecisionClaimToFinal(claim, sourceItems)
              );
            } else {
              nextItems.push(...decision.claims.map((claim, index) =>
                this.legacyDecisionClaimToPromptItem(
                  claim,
                  sourceItems,
                  round,
                  index,
                )
              ));
            }
          }

          const coveredCandidates = unique([
            ...discarded.flatMap((item) => item.sourceCandidateIds),
            ...(finalClaims ?? nextItems).flatMap((item) => item.sourceCandidateIds),
          ]).length;
          if (
            !finalClaims
            && nextItems.length === 0
            && coveredCandidates === candidateIds.length
          ) {
            finalClaims = [];
          }
          rounds.push({
            round,
            inputItems: currentItems.length,
            batches: batches.length,
            outputItems: finalClaims?.length ?? nextItems.length,
            discardedCandidates: discardedThisRound,
            coveredCandidates,
          });
          const audit = {
            promptVersion: LEGACY_CONSOLIDATION_PROMPT_VERSION,
            inputCandidateCount: candidateIds.length,
            sourceEventCount: extractions.length,
            noMemoryExtractions: extractions.filter((item) =>
              item.disposition === "no_memory"
            ).length,
            rounds,
          };
          this.ledger.updateLegacyConsolidationAudit(run.runId, audit);

          if (finalClaims) {
            const completed = this.ledger.commitLegacyConsolidation({
              runId: run.runId,
              claims: finalClaims,
              discarded,
              audit,
            });
            if (this.model.embed) {
              for (const eventId of unique(completed.outputClaimIds
                .map((claimId) => this.ledger.getClaim(claimId)?.sourceEventId)
                .filter((eventId): eventId is string => Boolean(eventId)))) {
                this.ledger.enqueueJob(eventId, "embed");
              }
            }
            this.onProjectionChanged?.();
            results.push(completed);
            break;
          }

          if (nextItems.length === 0) {
            throw new Error("legacy consolidation produced no claims for migratable material");
          }
          const nextBatchCount = this.partitionLegacyConsolidationItems(nextItems).length;
          if (
            nextItems.length >= currentItems.length
            && nextBatchCount >= batches.length
          ) {
            throw new Error(
              "legacy consolidation did not converge under the configured input budget",
            );
          }
          currentItems = nextItems;
        }
        if (!results.some((result) => result.runId === run.runId)) {
          throw new Error(
            `legacy consolidation did not converge within ${MAX_LEGACY_CONSOLIDATION_ROUNDS} rounds`,
          );
        }
      } catch (error) {
        const audit = {
          promptVersion: LEGACY_CONSOLIDATION_PROMPT_VERSION,
          inputCandidateCount: candidateIds.length,
          sourceEventCount: extractions.length,
          rounds,
        };
        this.ledger.failLegacyConsolidation(run.runId, safeError(error), audit);
        const failed = this.ledger.getLegacyConsolidationRun(
          identityId,
          visibility,
          inputHash,
        );
        if (failed) results.push(failed);
      }
    }
    return results;
  }

  private async embedClaimsForEvent(eventId: string): Promise<number> {
    if (!this.model?.embed) return 0;
    const claims = this.ledger.listClaims({
      states: ["active", "candidate"],
    }).filter((claim) => claim.sourceEventId === eventId);
    if (claims.length === 0) return 0;
    const result = await this.model.embed(
      claims.map((claim) => claim.canonicalText),
      this.judgementTimeoutMs,
    );
    if (
      result.vectors.length !== claims.length
      || result.vectors.some((vector) => vector.length !== result.dimensions)
    ) {
      throw new Error("embedding adapter returned an invalid vector batch");
    }
    let indexed = 0;
    for (let index = 0; index < claims.length; index += 1) {
      if (this.ledger.upsertEmbedding(claims[index].claimId, result.model, result.vectors[index])) {
        indexed += 1;
      }
    }
    return indexed;
  }

  private async processJob(job: MemoryJob): Promise<void> {
    if (job.kind === "adjudicate") {
      await this.adjudicateEvent(job.eventId);
      return;
    }
    if (job.kind === "legacy_rejudge") {
      await this.extractLegacyEvent(job.eventId);
      return;
    }
    if (job.kind === "embed") {
      await this.embedClaimsForEvent(job.eventId);
      return;
    }
    if (job.kind === "reflect") {
      throw new Error("reflection jobs require an explicit reflection batch");
    }
  }

  async processPendingMemoryJobs(options: {
    maxJobs?: number;
    kinds?: MemoryJob["kind"][];
    retryDelayMs?: number;
  } = {}): Promise<MemoryJobBatchResult> {
    const maxJobs = Math.max(1, Math.min(500, options.maxJobs ?? 25));
    if (!this.model) {
      return {
        processed: 0,
        completed: 0,
        failed: 0,
        remaining: this.ledger.listJobs("pending").length,
      };
    }
    let processed = 0;
    let completed = 0;
    let failed = 0;
    while (processed < maxJobs) {
      const job = this.ledger.claimNextJob({
        kinds: options.kinds,
        maxAttempts: this.maxJobAttempts,
      });
      if (!job) break;
      processed += 1;
      try {
        await this.processJob(job);
        this.ledger.completeJob(job.jobId);
        completed += 1;
      } catch (error) {
        this.ledger.failJob(job.jobId, safeError(error), {
          maxAttempts: this.maxJobAttempts,
          retryAt: options.retryDelayMs === undefined
            ? undefined
            : Date.now() + Math.max(0, Math.floor(options.retryDelayMs)),
        });
        failed += 1;
      }
    }
    return {
      processed,
      completed,
      failed,
      remaining: this.ledger.listJobs("pending").length,
    };
  }

  private async queryEmbedding(query: string, deadlineAt: number): Promise<{
    model: string;
    vector: number[];
  } | undefined> {
    if (!this.model?.embed || !query.trim()) return undefined;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return undefined;
    const timeoutMs = Math.max(1, Math.min(remainingMs, 800));
    const timeout = deadlineTimeout(timeoutMs);
    try {
      const result = await Promise.race([
        this.model.embed([query], timeoutMs),
        timeout.promise,
      ]);
      if (result === "timeout" || !result.vectors[0]) return undefined;
      return { model: result.model, vector: result.vectors[0] };
    } catch {
      return undefined;
    } finally {
      timeout.cancel();
    }
  }

  private async rerank(
    identityId: string,
    query: string,
    candidates: MemorySearchCandidate[],
    maxPromptChars: number,
  ): Promise<{ candidates: MemorySearchCandidate[]; runId: string }> {
    if (!this.model) throw new Error("memory rerank model is not configured");
    const runId = randomUUID();
    const startedAt = Date.now();
    try {
      const raw = await this.model.complete({
        task: "rerank",
        prompt: buildRerankPrompt(
          query,
          candidates.map((candidate) => candidate.claim),
          maxPromptChars,
        ),
        timeoutMs: this.rerankTaskTimeoutMs,
        schemaVersion: RERANK_PROMPT_VERSION,
      });
      const result = parseRerankResult(
        raw,
        new Set(candidates.map((candidate) => candidate.claim.claimId)),
      );
      const ordered = reorderCandidates(candidates, result.claimIds);
      this.ledger.recordModelRun({
        runId,
        task: "rerank",
        promptVersion: RERANK_PROMPT_VERSION,
        status: "completed",
        elapsedMs: Date.now() - startedAt,
        resultSummary: JSON.stringify({
          identityId,
          claimIds: result.claimIds,
          reason: result.reason,
        }),
      });
      return { candidates: ordered, runId };
    } catch (error) {
      this.ledger.recordModelRun({
        runId,
        task: "rerank",
        promptVersion: RERANK_PROMPT_VERSION,
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        error: safeError(error),
      });
      throw error;
    }
  }

  private retrieveLocal(
    request: MemoryRetrievalRequest,
    embedding?: { model: string; vector: number[] },
  ): LocalRetrieval {
    const startedAt = Date.now();
    const identityId = this.ledger.resolveIdentity(
      request.accountId,
      request.peerKind,
      request.peerId,
      request.identityId,
    );
    const maxPromptChars = dynamicPromptBudget(request.query, request.maxPromptChars);
    const candidates = this.ledger.searchLocal({
      identityId,
      visibility: visibilityForRequest(request),
      query: request.query,
      now: request.now,
      limit: candidateLimit(maxPromptChars, request.maxCandidates),
      vector: embedding?.vector,
      embeddingModel: embedding?.model,
    });
    const cached = this.ledger.readRerankCache(identityId, request.query, request.now);
    const ordered = cached ? reorderCandidates(candidates, cached.claimIds) : candidates;
    const rendered = renderMemoryPrompt(ordered, maxPromptChars);
    return {
      identityId,
      maxPromptChars,
      candidates,
      result: {
        prompt: rendered.prompt,
        claims: request.includeCandidates === false ? [] : rendered.claims,
        claimIds: rendered.claims.map((claim) => claim.claimId),
        sourceEventIds: [...new Set(rendered.claims.map((claim) => claim.sourceEventId))],
        usedFallback: !cached,
        rerankRunId: cached?.modelRunId,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  private revalidatedFallback(
    request: MemoryRetrievalRequest,
    local: LocalRetrieval,
    startedAt: number,
  ): MemoryContextResult {
    const ordered = reorderCandidates(local.candidates, local.result.claimIds);
    const liveCandidates = this.ledger.revalidateSearchCandidates(
      ordered,
      visibilityForRequest(request),
      request.now,
    );
    const rendered = renderMemoryPrompt(liveCandidates, local.maxPromptChars);
    return {
      prompt: rendered.prompt,
      claims: request.includeCandidates === false ? [] : rendered.claims,
      claimIds: rendered.claims.map((claim) => claim.claimId),
      sourceEventIds: [...new Set(rendered.claims.map((claim) => claim.sourceEventId))],
      usedFallback: true,
      rerankRunId: local.result.rerankRunId,
      elapsedMs: Date.now() - startedAt,
    };
  }

  retrieveMemoryContextLocal(
    request: MemoryRetrievalRequest,
    embedding?: { model: string; vector: number[] },
  ): MemoryContextResult {
    return this.retrieveLocal(request, embedding).result;
  }

  async retrieveMemoryContext(request: MemoryRetrievalRequest): Promise<MemoryContextResult> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + this.rerankDeadlineMs;
    if (request.peerKind === "group") {
      const local = this.retrieveMemoryContextLocal(request);
      return { ...local, elapsedMs: Date.now() - startedAt };
    }
    const embedding = await this.queryEmbedding(request.query, deadlineAt);
    const local = this.retrieveLocal(request, embedding);
    if (!this.model || local.result.claimIds.length === 0) {
      return { ...local.result, elapsedMs: Date.now() - startedAt };
    }
    const rerankPromise = this.rerank(
      local.identityId,
      request.query,
      local.candidates,
      local.maxPromptChars,
    );
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs > 0) {
      const timeout = deadlineTimeout(remainingMs);
      const raced = await Promise.race([
        rerankPromise.then(
          (value) => ({ type: "reranked" as const, value }),
          (error: unknown) => ({ type: "failed" as const, error }),
        ),
        timeout.promise.then(() => ({ type: "timeout" as const })),
      ]).finally(timeout.cancel);
      if (raced.type === "reranked") {
        const liveCandidates = this.ledger.revalidateSearchCandidates(
          raced.value.candidates,
          visibilityForRequest(request),
          request.now,
        );
        const rendered = renderMemoryPrompt(liveCandidates, local.maxPromptChars);
        this.ledger.writeRerankCache(
          local.identityId,
          request.query,
          rendered.claims.map((claim) => claim.claimId),
          raced.value.runId,
        );
        this.ledger.recordRetrievalFeedback({
          identityId: local.identityId,
          query: request.query,
          claimIds: rendered.claims.map((claim) => claim.claimId),
          outcome: "foreground_rerank",
        });
        return {
          prompt: rendered.prompt,
          claims: request.includeCandidates === false ? [] : rendered.claims,
          claimIds: rendered.claims.map((claim) => claim.claimId),
          sourceEventIds: [...new Set(rendered.claims.map((claim) => claim.sourceEventId))],
          usedFallback: false,
          rerankRunId: raced.value.runId,
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (raced.type === "failed") {
        const fallback = this.revalidatedFallback(request, local, startedAt);
        this.ledger.recordRetrievalFeedback({
          identityId: local.identityId,
          query: request.query,
          claimIds: fallback.claimIds,
          outcome: "foreground_rerank_failed",
          detail: { error: safeError(raced.error) },
        });
        return fallback;
      }
    }

    void rerankPromise.then((background) => {
      const liveCandidates = this.ledger.revalidateSearchCandidates(
        background.candidates,
        visibilityForRequest(request),
        request.now,
      );
      const rendered = renderMemoryPrompt(liveCandidates, local.maxPromptChars);
      const claimIds = rendered.claims.map((claim) => claim.claimId);
      this.ledger.writeRerankCache(
        local.identityId,
        request.query,
        claimIds,
        background.runId,
      );
      this.ledger.recordRetrievalFeedback({
        identityId: local.identityId,
        query: request.query,
        claimIds,
        outcome: "background_rerank_after_deadline",
        detail: { deadlineMs: this.rerankDeadlineMs },
      });
    }).catch((error) => {
      const fallback = this.revalidatedFallback(request, local, startedAt);
      this.ledger.recordRetrievalFeedback({
        identityId: local.identityId,
        query: request.query,
        claimIds: fallback.claimIds,
        outcome: "background_rerank_failed",
        detail: { error: safeError(error) },
      });
    });
    const fallback = this.revalidatedFallback(request, local, startedAt);
    this.ledger.recordRetrievalFeedback({
      identityId: local.identityId,
      query: request.query,
      claimIds: fallback.claimIds,
      outcome: "local_fallback_deadline",
      detail: { deadlineMs: this.rerankDeadlineMs },
    });
    return fallback;
  }

  recordMemoryFeedback(input: {
    accountId: string;
    peerKind: "direct" | "group";
    peerId: string;
    identityId?: string;
    query: string;
    claimIds: string[];
    outcome: "accepted" | "corrected" | "rejected" | "unused";
    detail?: Record<string, unknown>;
  }): void {
    const identityId = this.ledger.resolveIdentity(
      input.accountId,
      input.peerKind,
      input.peerId,
      input.identityId,
    );
    this.ledger.recordRetrievalFeedback({
      identityId,
      query: input.query,
      claimIds: input.claimIds,
      outcome: input.outcome,
      detail: input.detail,
    });
  }
}
