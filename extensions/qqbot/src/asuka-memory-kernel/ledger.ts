import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { getQQBotDataDir } from "../utils/platform.js";
import {
  defaultVisibility,
  memoryAuthorityWeight,
  normalizeConfidence,
  shouldIgnoreSelfReinforcingEvidence,
} from "./policy.js";
import type {
  ApplyClaimResult,
  ClaimProposal,
  EvidenceStance,
  IdentityLinkInput,
  LegacyConsolidationClaim,
  LegacyConsolidationDiscard,
  LegacyConsolidationRun,
  LegacyExtraction,
  MemoryClaim,
  MemoryClaimState,
  MemoryEvent,
  MemoryEventInput,
  MemoryEventReceipt,
  MemoryJob,
  MemoryJobKind,
  MemoryJudgement,
  MemoryProjectionClaimEvidence,
  MemoryProjectionEventSummary,
  MemoryProjectionSnapshot,
  MemorySearchCandidate,
  MemoryVisibility,
} from "./types.js";

const SCHEMA_VERSION = 2;
const DEFAULT_INFERENCE_PROMOTION_CONFIDENCE = 0.74;
const DEFAULT_JOB_LEASE_MS = 60_000;
const DEFAULT_MAX_JOB_ATTEMPTS = 8;
const MAX_PROJECTION_EVIDENCE_PER_STANCE = 4;
const MAX_PROJECTION_EVIDENCE_CHARS = 280;

interface LedgerOptions {
  enableVector?: boolean;
  inferencePromotionConfidence?: number;
}

interface EventRow {
  event_id: string;
  identity_id: string;
  account_id: string;
  peer_kind: "direct" | "group";
  peer_id: string;
  actor: MemoryEvent["actor"];
  kind: MemoryEvent["kind"];
  visibility: MemoryVisibility;
  text: string;
  source_id: string | null;
  source_message_id: string | null;
  occurred_at: number;
  recorded_at: number;
  evidence_json: string;
  metadata_json: string;
  generated_from_claim_ids_json: string;
  dedupe_key: string;
}

interface ClaimRow {
  claim_id: string;
  root_claim_id: string;
  identity_id: string;
  semantic_key: string | null;
  subject_id: string;
  predicate: string;
  value_json: string;
  canonical_text: string;
  top_level_type: MemoryClaim["topLevelType"];
  epistemic_status: MemoryClaim["epistemicStatus"];
  authority: MemoryClaim["authority"];
  confidence: number;
  state: MemoryClaimState;
  visibility: MemoryVisibility;
  valid_from: number | null;
  valid_to: number | null;
  topic: string | null;
  entity_ids_json: string;
  supersedes_claim_id: string | null;
  source_event_id: string;
  supporting_evidence_count: number;
  opposing_evidence_count: number;
  created_at: number;
  updated_at: number;
  metadata_json: string;
}

interface JobRow {
  job_id: string;
  event_id: string;
  kind: MemoryJobKind;
  status: MemoryJob["status"];
  attempts: number;
  available_at: number;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface LegacyExtractionRow {
  event_id: string;
  identity_id: string;
  visibility: MemoryVisibility;
  disposition: LegacyExtraction["disposition"];
  candidate_claim_ids_json: string;
  no_memory_reason: string | null;
  extracted_at: number;
  updated_at: number;
}

interface LegacyConsolidationRunRow {
  run_id: string;
  identity_id: string;
  visibility: MemoryVisibility;
  input_hash: string;
  status: LegacyConsolidationRun["status"];
  input_candidate_count: number;
  covered_candidate_count: number;
  source_event_count: number;
  covered_source_event_count: number;
  output_claim_ids_json: string;
  discarded_candidate_ids_json: string;
  audit_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asEvent(row: EventRow): MemoryEvent {
  return {
    eventId: row.event_id,
    identityId: row.identity_id,
    accountId: row.account_id,
    peerKind: row.peer_kind,
    peerId: row.peer_id,
    actor: row.actor,
    kind: row.kind,
    visibility: row.visibility,
    text: row.text,
    sourceId: row.source_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    evidence: parseJson(row.evidence_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    generatedFromClaimIds: parseJson(row.generated_from_claim_ids_json, []),
    dedupeKey: row.dedupe_key,
  };
}

function asClaim(row: ClaimRow): MemoryClaim {
  return {
    claimId: row.claim_id,
    rootClaimId: row.root_claim_id,
    identityId: row.identity_id,
    semanticKey: row.semantic_key ?? `${row.subject_id}.${row.predicate}`,
    subjectId: row.subject_id,
    predicate: row.predicate,
    value: parseJson(row.value_json, null),
    canonicalText: row.canonical_text,
    topLevelType: row.top_level_type,
    epistemicStatus: row.epistemic_status,
    authority: row.authority,
    confidence: row.confidence,
    state: row.state,
    visibility: row.visibility,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    topic: row.topic ?? undefined,
    entityIds: parseJson(row.entity_ids_json, []),
    supersedesClaimId: row.supersedes_claim_id ?? undefined,
    sourceEventId: row.source_event_id,
    supportingEvidenceCount: row.supporting_evidence_count,
    opposingEvidenceCount: row.opposing_evidence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function asJob(row: JobRow): MemoryJob {
  return {
    jobId: row.job_id,
    eventId: row.event_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseUntil: row.lease_until ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asLegacyExtraction(row: LegacyExtractionRow): LegacyExtraction {
  return {
    eventId: row.event_id,
    identityId: row.identity_id,
    visibility: row.visibility,
    disposition: row.disposition,
    candidateClaimIds: parseJson(row.candidate_claim_ids_json, []),
    noMemoryReason: row.no_memory_reason ?? undefined,
    extractedAt: row.extracted_at,
    updatedAt: row.updated_at,
  };
}

function asLegacyConsolidationRun(row: LegacyConsolidationRunRow): LegacyConsolidationRun {
  return {
    runId: row.run_id,
    identityId: row.identity_id,
    visibility: row.visibility,
    inputHash: row.input_hash,
    status: row.status,
    inputCandidateCount: row.input_candidate_count,
    coveredCandidateCount: row.covered_candidate_count,
    sourceEventCount: row.source_event_count,
    coveredSourceEventCount: row.covered_source_event_count,
    outputClaimIds: parseJson(row.output_claim_ids_json, []),
    discardedCandidateIds: parseJson(row.discarded_candidate_ids_json, []),
    audit: parseJson(row.audit_json, {}),
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function projectionEventSummary(event: MemoryEvent): MemoryProjectionEventSummary {
  const excerpt = [
    event.evidence.excerpt,
    event.evidence.transcript,
    event.evidence.imageSummary,
    event.text,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    eventId: event.eventId,
    identityId: event.identityId,
    visibility: event.visibility,
    actor: event.actor,
    kind: event.kind,
    occurredAt: event.occurredAt,
    source: event.evidence.sourcePath?.trim()
      || event.sourceId?.trim()
      || event.sourceMessageId?.trim()
      || event.kind,
    excerpt: normalizeText(excerpt).slice(0, MAX_PROJECTION_EVIDENCE_CHARS),
  };
}

function safeTopic(value: string | undefined): string {
  return normalizeText(value ?? "").slice(0, 160);
}

function semanticKeyFor(
  value: string | undefined,
  subjectId: string,
  predicate: string,
): string {
  return normalizeText(value ?? `${subjectId}.${predicate}`).slice(0, 240);
}

function makeDefaultIdentityId(
  accountId: string,
  peerKind: "direct" | "group",
  peerId: string,
): string {
  return `${peerKind === "direct" ? "private" : "public"}:${accountId}:${peerId}`;
}

function makeDedupeKey(input: MemoryEventInput, occurredAt: number): string {
  if (input.dedupeKey?.trim()) return input.dedupeKey.trim();
  const stableSource = input.sourceMessageId?.trim() || input.sourceId?.trim();
  if (stableSource) {
    return `${input.accountId}:${input.peerKind}:${input.peerId}:${input.kind}:${stableSource}`;
  }
  return createHash("sha256")
    .update([
      input.accountId,
      input.peerKind,
      input.peerId,
      input.actor,
      input.kind,
      normalizeText(input.text),
      String(occurredAt),
    ].join("\u0000"))
    .digest("hex");
}

function makeFtsQuery(query: string): string {
  const normalized = normalizeText(query).replace(/["*:^(){}\[\]]/g, " ");
  return `"${normalized.replace(/"/g, '""')}"`;
}

function recencyScore(updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / 86_400_000;
  return 1 / (1 + ageDays / 30);
}

export function getDefaultMemoryLedgerPath(): string {
  return path.join(getQQBotDataDir("data", "asuka-memory"), "memory-ledger.sqlite");
}

export class AsukaMemoryLedger {
  readonly databasePath: string;
  readonly vectorAvailable: boolean;
  private readonly db: DatabaseSync;
  private readonly inferencePromotionConfidence: number;

  constructor(databasePath = getDefaultMemoryLedgerPath(), options: LedgerOptions = {}) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = new DatabaseSync(databasePath, {
      allowExtension: options.enableVector !== false,
      timeout: 5_000,
    });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    this.migrate();
    this.vectorAvailable = options.enableVector === false ? false : this.tryLoadVectorExtension();
    this.inferencePromotionConfidence = Math.max(
      0,
      Math.min(1, options.inferencePromotionConfidence ?? DEFAULT_INFERENCE_PROMOTION_CONFIDENCE),
    );
  }

  close(): void {
    this.db.close();
  }

  private tryLoadVectorExtension(): boolean {
    try {
      loadSqliteVec(this.db);
      this.db.enableLoadExtension(false);
      return true;
    } catch (error) {
      console.warn(`[asuka-memory] sqlite-vec unavailable; FTS fallback remains active: ${error instanceof Error ? error.message : String(error)}`);
      try {
        this.db.enableLoadExtension(false);
      } catch {
        // The database remains usable even when extension loading cannot be toggled.
      }
      return false;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_links (
        identity_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_kind TEXT NOT NULL CHECK (peer_kind IN ('direct', 'group')),
        peer_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, peer_kind, peer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_links_identity
        ON identity_links(identity_id, visibility);

      CREATE TABLE IF NOT EXISTS memory_events (
        event_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        peer_kind TEXT NOT NULL CHECK (peer_kind IN ('direct', 'group')),
        peer_id TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'asuka', 'system')),
        kind TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        text TEXT NOT NULL,
        source_id TEXT,
        source_message_id TEXT,
        occurred_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        generated_from_claim_ids_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_identity_time
        ON memory_events(identity_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_memory_events_scope
        ON memory_events(account_id, peer_kind, peer_id, occurred_at);

      CREATE TABLE IF NOT EXISTS memory_claims (
        claim_id TEXT PRIMARY KEY,
        root_claim_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        semantic_key TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_json TEXT NOT NULL,
        canonical_text TEXT NOT NULL,
        top_level_type TEXT NOT NULL,
        epistemic_status TEXT NOT NULL CHECK (epistemic_status IN ('explicit', 'inferred')),
        authority TEXT NOT NULL,
        confidence REAL NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('candidate', 'active', 'superseded', 'refuted', 'forgotten')),
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        valid_from INTEGER,
        valid_to INTEGER,
        topic TEXT,
        entity_ids_json TEXT NOT NULL,
        supersedes_claim_id TEXT,
        source_event_id TEXT NOT NULL REFERENCES memory_events(event_id),
        supporting_evidence_count INTEGER NOT NULL DEFAULT 0,
        opposing_evidence_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_claims_current
        ON memory_claims(identity_id, state, visibility, valid_to);
      CREATE INDEX IF NOT EXISTS idx_memory_claims_semantic
        ON memory_claims(identity_id, subject_id, predicate, state);
      CREATE INDEX IF NOT EXISTS idx_memory_claims_root
        ON memory_claims(root_claim_id, updated_at);

      CREATE TABLE IF NOT EXISTS claim_evidence (
        claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES memory_events(event_id) ON DELETE CASCADE,
        stance TEXT NOT NULL CHECK (stance IN ('supports', 'opposes', 'neutral', 'ignored')),
        weight REAL NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (claim_id, event_id, stance)
      );
      CREATE INDEX IF NOT EXISTS idx_claim_evidence_event
        ON claim_evidence(event_id);

      CREATE TABLE IF NOT EXISTS memory_jobs (
        job_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES memory_events(event_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(event_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready
        ON memory_jobs(status, available_at, lease_until, created_at);

      CREATE TABLE IF NOT EXISTS legacy_extractions (
        event_id TEXT PRIMARY KEY REFERENCES memory_events(event_id) ON DELETE CASCADE,
        identity_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        disposition TEXT NOT NULL CHECK (disposition IN ('claims', 'no_memory')),
        candidate_claim_ids_json TEXT NOT NULL,
        no_memory_reason TEXT,
        extracted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_legacy_extractions_scope
        ON legacy_extractions(identity_id, visibility, disposition);

      CREATE TABLE IF NOT EXISTS legacy_consolidation_runs (
        run_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        input_candidate_count INTEGER NOT NULL,
        covered_candidate_count INTEGER NOT NULL DEFAULT 0,
        source_event_count INTEGER NOT NULL,
        covered_source_event_count INTEGER NOT NULL DEFAULT 0,
        output_claim_ids_json TEXT NOT NULL,
        discarded_candidate_ids_json TEXT NOT NULL,
        audit_json TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(identity_id, visibility, input_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_legacy_consolidation_scope
        ON legacy_consolidation_runs(identity_id, visibility, updated_at);

      CREATE TABLE IF NOT EXISTS projection_cursors (
        projection TEXT PRIMARY KEY,
        event_cursor INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        model TEXT,
        prompt_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        input_event_id TEXT,
        result_summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retrieval_feedback (
        feedback_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        claim_ids_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rerank_cache (
        identity_id TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        claim_ids_json TEXT NOT NULL,
        model_run_id TEXT,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(identity_id, query_hash)
      );

      CREATE TABLE IF NOT EXISTS claim_embedding_meta (
        claim_id TEXT NOT NULL REFERENCES memory_claims(claim_id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        table_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(claim_id, model)
      );

    `);

    const claimColumns = this.db.prepare("PRAGMA table_info(memory_claims)")
      .all() as unknown as Array<{ name: string }>;
    if (!claimColumns.some((column) => column.name === "semantic_key")) {
      this.db.exec("ALTER TABLE memory_claims ADD COLUMN semantic_key TEXT");
    }
    const missingSemanticKeys = this.db.prepare(`
      SELECT claim_id, subject_id, predicate, metadata_json
      FROM memory_claims
      WHERE semantic_key IS NULL OR trim(semantic_key) = ''
    `).all() as unknown as Array<{
      claim_id: string;
      subject_id: string;
      predicate: string;
      metadata_json: string;
    }>;
    const updateSemanticKey = this.db.prepare(`
      UPDATE memory_claims SET semantic_key = ? WHERE claim_id = ?
    `);
    for (const row of missingSemanticKeys) {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      updateSemanticKey.run(
        semanticKeyFor(
          typeof metadata.semanticKey === "string" ? metadata.semanticKey : undefined,
          row.subject_id,
          row.predicate,
        ),
        row.claim_id,
      );
    }
    const semanticIndexColumns = this.db
      .prepare("PRAGMA index_info(idx_memory_claims_semantic_key)")
      .all() as unknown as Array<{ seqno: number; name: string }>;
    const expectedSemanticIndex = ["identity_id", "visibility", "semantic_key", "state"];
    if (
      semanticIndexColumns
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
        .join("\u0000") !== expectedSemanticIndex.join("\u0000")
    ) {
      this.db.exec("DROP INDEX IF EXISTS idx_memory_claims_semantic_key");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_claims_semantic_key
        ON memory_claims(identity_id, visibility, semantic_key, state);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (${SCHEMA_VERSION}, unixepoch('now') * 1000);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
          claim_id UNINDEXED,
          identity_id UNINDEXED,
          canonical_text,
          predicate,
          topic,
          tokenize='trigram'
        )
      `);
    } catch {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
          claim_id UNINDEXED,
          identity_id UNINDEXED,
          canonical_text,
          predicate,
          topic,
          tokenize='unicode61'
        )
      `);
    }
  }

  linkIdentity(input: IdentityLinkInput, at = Date.now()): void {
    const visibility = input.visibility ?? defaultVisibility(input.peerKind);
    this.db.prepare(`
      INSERT INTO identity_links(
        identity_id, account_id, peer_kind, peer_id, visibility, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, peer_kind, peer_id) DO UPDATE SET
        identity_id = excluded.identity_id,
        visibility = excluded.visibility,
        updated_at = excluded.updated_at
    `).run(
      input.identityId,
      input.accountId,
      input.peerKind,
      input.peerId,
      visibility,
      at,
      at,
    );
  }

  resolveIdentity(
    accountId: string,
    peerKind: "direct" | "group",
    peerId: string,
    requestedIdentityId?: string,
  ): string {
    if (requestedIdentityId?.trim()) return requestedIdentityId.trim();
    const row = this.db.prepare(`
      SELECT identity_id
      FROM identity_links
      WHERE account_id = ? AND peer_kind = ? AND peer_id = ?
    `).get(accountId, peerKind, peerId) as { identity_id?: string } | undefined;
    return row?.identity_id ?? makeDefaultIdentityId(accountId, peerKind, peerId);
  }

  appendEvent(input: MemoryEventInput): MemoryEventReceipt {
    const text = normalizeText(input.text);
    const occurredAt = input.occurredAt ?? Date.now();
    const recordedAt = Date.now();
    const identityId = this.resolveIdentity(
      input.accountId,
      input.peerKind,
      input.peerId,
      input.identityId,
    );
    const visibility = input.visibility ?? defaultVisibility(input.peerKind);
    if (input.peerKind === "group" && visibility === "private") {
      throw new Error("Private memory events cannot be written into a group scope");
    }
    const dedupeKey = makeDedupeKey(input, occurredAt);
    const eventId = randomUUID();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.linkIdentity({
        identityId,
        accountId: input.accountId,
        peerKind: input.peerKind,
        peerId: input.peerId,
        visibility,
      }, recordedAt);
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO memory_events(
          event_id, identity_id, account_id, peer_kind, peer_id, actor, kind,
          visibility, text, source_id, source_message_id, occurred_at, recorded_at,
          evidence_json, metadata_json, generated_from_claim_ids_json, dedupe_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        identityId,
        input.accountId,
        input.peerKind,
        input.peerId,
        input.actor,
        input.kind,
        visibility,
        text,
        input.sourceId ?? null,
        input.sourceMessageId ?? null,
        occurredAt,
        recordedAt,
        JSON.stringify(input.evidence ?? {}),
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.generatedFromClaimIds ?? []),
        dedupeKey,
      );
      const inserted = result.changes > 0;
      const storedEventId = inserted
        ? eventId
        : (this.db.prepare("SELECT event_id FROM memory_events WHERE dedupe_key = ?")
          .get(dedupeKey) as { event_id: string }).event_id;
      this.db.exec("COMMIT");
      return { eventId: storedEventId, identityId, inserted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getEvent(eventId: string): MemoryEvent | undefined {
    const row = this.db.prepare("SELECT * FROM memory_events WHERE event_id = ?")
      .get(eventId) as EventRow | undefined;
    return row ? asEvent(row) : undefined;
  }

  listEvents(identityId?: string): MemoryEvent[] {
    const rows = identityId
      ? this.db.prepare("SELECT * FROM memory_events WHERE identity_id = ? ORDER BY occurred_at, recorded_at")
        .all(identityId)
      : this.db.prepare("SELECT * FROM memory_events ORDER BY occurred_at, recorded_at").all();
    return (rows as unknown as EventRow[]).map(asEvent);
  }

  enqueueJob(eventId: string, kind: MemoryJobKind, availableAt = Date.now()): MemoryJob {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memory_jobs(
        job_id, event_id, kind, status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(event_id, kind) DO UPDATE SET
        status = CASE WHEN memory_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
        available_at = CASE
          WHEN memory_jobs.status = 'completed' THEN memory_jobs.available_at
          ELSE excluded.available_at
        END,
        lease_until = NULL,
        updated_at = excluded.updated_at
    `).run(randomUUID(), eventId, kind, availableAt, now, now);
    const row = this.db.prepare("SELECT * FROM memory_jobs WHERE event_id = ? AND kind = ?")
      .get(eventId, kind) as unknown as JobRow;
    return asJob(row);
  }

  claimNextJob(options: {
    kinds?: MemoryJobKind[];
    now?: number;
    leaseMs?: number;
    maxAttempts?: number;
  } = {}): MemoryJob | undefined {
    const now = options.now ?? Date.now();
    const leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
    const kinds = options.kinds?.length ? options.kinds : undefined;
    const placeholders = kinds?.map(() => "?").join(", ");
    const kindClause = kinds ? `AND kind IN (${placeholders})` : "";
    const parameters: SQLInputValue[] = [now, now, maxAttempts, ...(kinds ?? [])];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT *
        FROM memory_jobs
        WHERE (
          status = 'pending'
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
        )
          AND available_at <= ?
          AND attempts < ?
          AND (
            kind <> 'legacy_rejudge'
            OR job_id = (
              SELECT older.job_id
              FROM memory_jobs AS older
              JOIN memory_events AS older_event ON older_event.event_id = older.event_id
              WHERE older.kind = 'legacy_rejudge'
                AND older.status <> 'completed'
                AND older_event.identity_id = (
                  SELECT current_event.identity_id
                  FROM memory_events AS current_event
                  WHERE current_event.event_id = memory_jobs.event_id
                )
              ORDER BY older_event.occurred_at, older.created_at, older.job_id
              LIMIT 1
            )
          )
          ${kindClause}
        ORDER BY
          CASE WHEN kind = 'legacy_rejudge' THEN 1 ELSE 0 END,
          CASE
            WHEN kind = 'legacy_rejudge' THEN (
              SELECT occurred_at
              FROM memory_events
              WHERE event_id = memory_jobs.event_id
            )
            ELSE created_at
          END,
          created_at,
          job_id
        LIMIT 1
      `).get(...parameters) as JobRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db.prepare(`
        UPDATE memory_jobs
        SET status = 'running',
            attempts = attempts + 1,
            lease_until = ?,
            updated_at = ?
        WHERE job_id = ?
      `).run(now + leaseMs, now, row.job_id);
      const claimed = this.db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?")
        .get(row.job_id) as unknown as JobRow;
      this.db.exec("COMMIT");
      return asJob(claimed);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeJob(jobId: string, at = Date.now()): void {
    this.db.prepare(`
      UPDATE memory_jobs
      SET status = 'completed', lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE job_id = ?
    `).run(at, jobId);
  }

  failJob(jobId: string, error: string, options: {
    retryAt?: number;
    maxAttempts?: number;
  } = {}): void {
    const now = Date.now();
    const row = this.db.prepare("SELECT attempts FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { attempts: number } | undefined;
    if (!row) return;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_JOB_ATTEMPTS;
    const terminal = row.attempts >= maxAttempts;
    this.db.prepare(`
      UPDATE memory_jobs
      SET status = ?,
          available_at = ?,
          lease_until = NULL,
          last_error = ?,
          updated_at = ?
      WHERE job_id = ?
    `).run(
      terminal ? "failed" : "pending",
      options.retryAt ?? now + Math.min(3_600_000, 15_000 * 2 ** Math.max(0, row.attempts - 1)),
      error.slice(0, 1_000),
      now,
      jobId,
    );
  }

  listJobs(status?: MemoryJob["status"]): MemoryJob[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM memory_jobs WHERE status = ? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM memory_jobs ORDER BY created_at").all();
    return (rows as unknown as JobRow[]).map(asJob);
  }

  retryFailedJobs(kind: MemoryJobKind, availableAt = Date.now()): number {
    const result = this.db.prepare(`
      UPDATE memory_jobs
      SET status = 'pending',
          attempts = 0,
          available_at = ?,
          lease_until = NULL,
          last_error = NULL,
          updated_at = ?
      WHERE kind = ? AND status = 'failed'
    `).run(availableAt, Date.now(), kind);
    return Number(result.changes);
  }

  getLegacyExtraction(eventId: string): LegacyExtraction | undefined {
    const row = this.db.prepare("SELECT * FROM legacy_extractions WHERE event_id = ?")
      .get(eventId) as LegacyExtractionRow | undefined;
    return row ? asLegacyExtraction(row) : undefined;
  }

  listLegacyExtractions(identityId?: string): LegacyExtraction[] {
    const rows = identityId
      ? this.db.prepare(`
          SELECT * FROM legacy_extractions
          WHERE identity_id = ?
          ORDER BY extracted_at, event_id
        `).all(identityId)
      : this.db.prepare(`
          SELECT * FROM legacy_extractions
          ORDER BY identity_id, extracted_at, event_id
        `).all();
    return (rows as unknown as LegacyExtractionRow[]).map(asLegacyExtraction);
  }

  recordLegacyExtraction(eventId: string, judgement: MemoryJudgement): LegacyExtraction {
    const existing = this.getLegacyExtraction(eventId);
    if (existing) return existing;
    const event = this.getEvent(eventId);
    if (!event || event.kind !== "legacy_import") {
      throw new Error(`legacy extraction source event not found: ${eventId}`);
    }
    if (judgement.eventId !== eventId) {
      throw new Error("legacy extraction judgement event does not match its source");
    }
    if (judgement.proposals.length === 0 && !judgement.noMemoryReason?.trim()) {
      throw new Error("empty legacy extraction requires a no-memory disposition");
    }
    const now = Date.now();
    const candidateClaimIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.db.prepare("SELECT * FROM legacy_extractions WHERE event_id = ?")
        .get(eventId) as LegacyExtractionRow | undefined;
      if (raced) {
        this.db.exec("COMMIT");
        return asLegacyExtraction(raced);
      }
      for (const [index, proposal] of judgement.proposals.entries()) {
        const claimId = randomUUID();
        const assistantOnly = event.actor !== "user";
        candidateClaimIds.push(claimId);
        this.db.prepare(`
          INSERT INTO memory_claims(
            claim_id, root_claim_id, identity_id, semantic_key, subject_id, predicate, value_json,
            canonical_text, top_level_type, epistemic_status, authority, confidence,
            state, visibility, valid_from, valid_to, topic, entity_ids_json,
            supersedes_claim_id, source_event_id, supporting_evidence_count,
            opposing_evidence_count, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?, ?)
        `).run(
          claimId,
          claimId,
          event.identityId,
          semanticKeyFor(proposal.semanticKey, proposal.subjectId, proposal.predicate),
          proposal.subjectId,
          proposal.predicate,
          JSON.stringify(proposal.value),
          proposal.canonicalText,
          proposal.topLevelType,
          assistantOnly ? "inferred" : proposal.epistemicStatus,
          assistantOnly ? "summary" : proposal.authority,
          normalizeConfidence(proposal.confidence),
          event.visibility,
          proposal.validFrom ?? event.occurredAt,
          proposal.validTo ?? null,
          safeTopic(proposal.topic) || null,
          JSON.stringify(proposal.entityIds ?? []),
          eventId,
          now,
          now,
          JSON.stringify({
            ...(proposal.metadata ?? {}),
            lifecycle: proposal.lifecycle,
            migrationPendingConsolidation: true,
            legacyExtractionIndex: index,
          }),
        );
        this.db.prepare(`
          INSERT INTO claim_evidence(
            claim_id, event_id, stance, weight, reason, created_at
          ) VALUES (?, ?, 'supports', 1, 'legacy_extraction_source', ?)
        `).run(claimId, eventId, now);
      }
      const provisionalRows = this.db.prepare(`
        SELECT *
        FROM memory_claims
        WHERE source_event_id = ? AND state = 'candidate'
      `).all(eventId) as unknown as ClaimRow[];
      for (const row of provisionalRows) {
        const claim = asClaim(row);
        if (claim.metadata.migrationPendingRejudge !== true) continue;
        this.removeClaimFromIndexes(claim.claimId);
        this.db.prepare(`
          UPDATE memory_claims
          SET state = 'refuted', updated_at = ?
          WHERE claim_id = ?
        `).run(now, claim.claimId);
      }
      this.db.prepare(`
        INSERT INTO legacy_extractions(
          event_id, identity_id, visibility, disposition, candidate_claim_ids_json,
          no_memory_reason, extracted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        event.identityId,
        event.visibility,
        candidateClaimIds.length > 0 ? "claims" : "no_memory",
        JSON.stringify(candidateClaimIds),
        judgement.noMemoryReason ?? null,
        now,
        now,
      );
      this.db.exec("COMMIT");
      return this.getLegacyExtraction(eventId)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listLegacyExtractionCandidates(
    identityId?: string,
    visibility?: MemoryVisibility,
  ): MemoryClaim[] {
    return this.listClaims({
      identityId,
      states: ["candidate"],
      visibility,
    }).filter((claim) => claim.metadata.migrationPendingConsolidation === true);
  }

  getLegacyConsolidationRun(
    identityId: string,
    visibility: MemoryVisibility,
    inputHash?: string,
  ): LegacyConsolidationRun | undefined {
    const row = inputHash
      ? this.db.prepare(`
          SELECT * FROM legacy_consolidation_runs
          WHERE identity_id = ? AND visibility = ? AND input_hash = ?
          LIMIT 1
        `).get(identityId, visibility, inputHash)
      : this.db.prepare(`
          SELECT * FROM legacy_consolidation_runs
          WHERE identity_id = ? AND visibility = ?
          ORDER BY updated_at DESC, run_id
          LIMIT 1
        `).get(identityId, visibility);
    return row
      ? asLegacyConsolidationRun(row as unknown as LegacyConsolidationRunRow)
      : undefined;
  }

  listLegacyConsolidationRuns(): LegacyConsolidationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM legacy_consolidation_runs
      ORDER BY created_at, run_id
    `).all() as unknown as LegacyConsolidationRunRow[];
    return rows.map(asLegacyConsolidationRun);
  }

  beginLegacyConsolidation(input: {
    identityId: string;
    visibility: MemoryVisibility;
    inputHash: string;
    inputCandidateCount: number;
    sourceEventCount: number;
  }): LegacyConsolidationRun {
    const existing = this.getLegacyConsolidationRun(
      input.identityId,
      input.visibility,
      input.inputHash,
    );
    if (existing?.status === "completed") return existing;
    const now = Date.now();
    const runId = existing?.runId ?? randomUUID();
    this.db.prepare(`
      INSERT INTO legacy_consolidation_runs(
        run_id, identity_id, visibility, input_hash, status, input_candidate_count,
        covered_candidate_count, source_event_count, covered_source_event_count,
        output_claim_ids_json, discarded_candidate_ids_json, audit_json,
        error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'running', ?, 0, ?, 0, '[]', '[]', '{}', NULL, ?, ?)
      ON CONFLICT(identity_id, visibility, input_hash) DO UPDATE SET
        status = 'running',
        input_candidate_count = excluded.input_candidate_count,
        source_event_count = excluded.source_event_count,
        covered_candidate_count = 0,
        covered_source_event_count = 0,
        output_claim_ids_json = '[]',
        discarded_candidate_ids_json = '[]',
        audit_json = '{}',
        error = NULL,
        updated_at = excluded.updated_at
    `).run(
      runId,
      input.identityId,
      input.visibility,
      input.inputHash,
      input.inputCandidateCount,
      input.sourceEventCount,
      now,
      now,
    );
    return this.getLegacyConsolidationRun(
      input.identityId,
      input.visibility,
      input.inputHash,
    )!;
  }

  failLegacyConsolidation(
    runId: string,
    error: string,
    audit: Record<string, unknown> = {},
  ): void {
    this.db.prepare(`
      UPDATE legacy_consolidation_runs
      SET status = 'failed', error = ?, audit_json = ?, updated_at = ?
      WHERE run_id = ?
    `).run(error.slice(0, 1_000), JSON.stringify(audit), Date.now(), runId);
  }

  updateLegacyConsolidationAudit(
    runId: string,
    audit: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      UPDATE legacy_consolidation_runs
      SET audit_json = ?, updated_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(JSON.stringify(audit), Date.now(), runId);
  }

  private deriveLegacyClaimPolicy(
    events: MemoryEvent[],
    sourceCandidates: MemoryClaim[],
    requestedEpistemicStatus: MemoryClaim["epistemicStatus"],
    confidence: number,
  ): {
    authority: MemoryClaim["authority"];
    epistemicStatus: MemoryClaim["epistemicStatus"];
    state: "active" | "candidate";
  } {
    const userEvents = events.filter((event) => event.actor === "user");
    const hasHumanOverride = events.some((event) => event.kind === "human_override");
    const hasUserCorrection = events.some((event) =>
      event.kind === "memory_control" || event.metadata.sourceKind === "correction"
    );
    const hasMutualAgreement = events.some((event) =>
      event.metadata.mutualAgreement === true
    );
    const assistantOnly = userEvents.length === 0;
    const hasExplicitSource = sourceCandidates.some((candidate) =>
      candidate.epistemicStatus === "explicit"
    );
    const epistemicStatus = assistantOnly || !hasExplicitSource
      ? "inferred"
      : requestedEpistemicStatus;
    const authority: MemoryClaim["authority"] = hasHumanOverride
      ? "human_override"
      : hasUserCorrection
        ? "user_correction"
        : hasMutualAgreement
          ? "mutual_agreement"
          : assistantOnly
            ? "summary"
            : epistemicStatus === "explicit"
              ? "user_explicit"
              : "inferred";
    const state = assistantOnly
      || (
        epistemicStatus === "inferred"
        && (
          confidence < this.inferencePromotionConfidence
          || new Set(userEvents.map((event) => event.eventId)).size < 2
        )
      )
      ? "candidate"
      : "active";
    return { authority, epistemicStatus, state };
  }

  commitLegacyConsolidation(input: {
    runId: string;
    claims: LegacyConsolidationClaim[];
    discarded: LegacyConsolidationDiscard[];
    audit: Record<string, unknown>;
  }): LegacyConsolidationRun {
    const runRow = this.db.prepare(`
      SELECT * FROM legacy_consolidation_runs WHERE run_id = ?
    `).get(input.runId) as LegacyConsolidationRunRow | undefined;
    if (!runRow) throw new Error(`legacy consolidation run not found: ${input.runId}`);
    const run = asLegacyConsolidationRun(runRow);
    if (run.status === "completed") return run;
    const extractions = this.listLegacyExtractions(run.identityId)
      .filter((extraction) => extraction.visibility === run.visibility);
    const expectedCandidateIds = extractions.flatMap((extraction) =>
      extraction.candidateClaimIds
    );
    if (
      expectedCandidateIds.length !== run.inputCandidateCount
      || extractions.length !== run.sourceEventCount
    ) {
      throw new Error("legacy consolidation input set changed while the run was active");
    }
    const expectedSet = new Set(expectedCandidateIds);
    const coveredIds = [
      ...input.claims.flatMap((claim) => claim.sourceCandidateIds),
      ...input.discarded.flatMap((item) => item.sourceCandidateIds),
    ];
    if (
      coveredIds.length !== expectedSet.size
      || new Set(coveredIds).size !== coveredIds.length
      || coveredIds.some((candidateId) => !expectedSet.has(candidateId))
    ) {
      throw new Error("legacy consolidation candidate coverage is incomplete or duplicated");
    }
    if (input.discarded.some((item) =>
      item.sourceCandidateIds.length === 0 || !item.reason.trim()
    )) {
      throw new Error("legacy consolidation discard requires covered candidates and a reason");
    }

    const evidenceByCandidate = new Map<string, MemoryEvent[]>();
    for (const candidateId of expectedCandidateIds) {
      const candidate = this.getClaim(candidateId);
      if (
        !candidate
        || candidate.state !== "candidate"
        || candidate.identityId !== run.identityId
        || candidate.visibility !== run.visibility
        || candidate.metadata.migrationPendingConsolidation !== true
      ) {
        throw new Error(`invalid legacy extraction candidate: ${candidateId}`);
      }
      const rows = this.db.prepare(`
        SELECT event_id
        FROM claim_evidence
        WHERE claim_id = ? AND stance = 'supports'
        ORDER BY created_at, event_id
      `).all(candidateId) as unknown as Array<{ event_id: string }>;
      const events = rows
        .map((row) => this.getEvent(row.event_id))
        .filter((event): event is MemoryEvent => Boolean(event));
      if (
        events.length === 0
        || events.some((event) =>
          event.identityId !== run.identityId
          || event.visibility !== run.visibility
          || event.kind !== "legacy_import"
        )
      ) {
        throw new Error(`legacy candidate ${candidateId} has invalid evidence scope`);
      }
      evidenceByCandidate.set(candidateId, events);
    }

    const mergedClaims = new Map<string, LegacyConsolidationClaim>();
    for (const claim of input.claims) {
      if (claim.sourceCandidateIds.length === 0) {
        throw new Error("legacy consolidated claim has no source candidates");
      }
      const derivedEventIds = [...new Set(claim.sourceCandidateIds.flatMap((candidateId) =>
        (evidenceByCandidate.get(candidateId) ?? []).map((event) => event.eventId)
      ))].sort();
      const declaredEventIds = [...new Set(claim.supportingEventIds)].sort();
      if (
        derivedEventIds.length !== declaredEventIds.length
        || derivedEventIds.some((eventId, index) => eventId !== declaredEventIds[index])
      ) {
        throw new Error("legacy consolidated claim evidence does not match its source candidates");
      }
      const mergeKey = [
        claim.semanticKey,
        claim.canonicalText,
        JSON.stringify(claim.value),
      ].join("\u0000");
      const existing = mergedClaims.get(mergeKey);
      if (existing) {
        existing.sourceCandidateIds = [...new Set([
          ...existing.sourceCandidateIds,
          ...claim.sourceCandidateIds,
        ])];
        existing.supportingEventIds = [...new Set([
          ...existing.supportingEventIds,
          ...claim.supportingEventIds,
        ])];
        existing.opposingEventIds = [...new Set([
          ...existing.opposingEventIds,
          ...claim.opposingEventIds,
        ])];
        existing.entityIds = [...new Set([...existing.entityIds, ...claim.entityIds])];
        existing.confidence = Math.max(existing.confidence, claim.confidence);
      } else {
        mergedClaims.set(mergeKey, {
          ...claim,
          sourceCandidateIds: [...new Set(claim.sourceCandidateIds)],
          supportingEventIds: [...new Set(claim.supportingEventIds)],
          opposingEventIds: [...new Set(claim.opposingEventIds)],
          entityIds: [...new Set(claim.entityIds)],
        });
      }
    }

    const prepared = [...mergedClaims.values()].map((claim) => {
      const events = claim.supportingEventIds.map((eventId) => this.getEvent(eventId)!);
      const sourceCandidates = claim.sourceCandidateIds
        .map((candidateId) => this.getClaim(candidateId))
        .filter((candidate): candidate is MemoryClaim => Boolean(candidate));
      if (sourceCandidates.length !== claim.sourceCandidateIds.length) {
        throw new Error("legacy consolidated claim source candidate is missing");
      }
      const evidenceTime = Math.min(...events.map((event) => event.occurredAt));
      const policy = this.deriveLegacyClaimPolicy(
        events,
        sourceCandidates,
        claim.epistemicStatus,
        normalizeConfidence(claim.confidence),
      );
      return {
        claim,
        events,
        evidenceTime,
        effectiveFrom: claim.validFrom ?? evidenceTime,
        policy,
      };
    });
    const groups = new Map<string, typeof prepared>();
    for (const item of prepared) {
      const group = groups.get(item.claim.semanticKey) ?? [];
      group.push(item);
      groups.set(item.claim.semanticKey, group);
    }
    for (const [semanticKey, versions] of groups) {
      if (new Set(versions.map((version) => version.claim.subjectId)).size !== 1) {
        throw new Error(
          `legacy consolidation semantic key spans multiple subjects: ${semanticKey}`,
        );
      }
    }

    const outputClaimIds: string[] = [];
    const storedAudit = {
      ...input.audit,
      discarded: input.discarded.map((item) => ({
        sourceCandidateIds: [...item.sourceCandidateIds],
        reason: item.reason.trim(),
      })),
    };
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidateId of expectedCandidateIds) {
        const candidate = this.getClaim(candidateId);
        if (
          !candidate
          || candidate.state !== "candidate"
          || candidate.identityId !== run.identityId
          || candidate.visibility !== run.visibility
          || candidate.metadata.migrationPendingConsolidation !== true
        ) {
          throw new Error(`legacy extraction candidate changed state: ${candidateId}`);
        }
      }
      for (const [semanticKey, versions] of groups) {
        versions.sort((left, right) =>
          left.effectiveFrom - right.effectiveFrom
          || left.claim.canonicalText.localeCompare(right.claim.canonicalText)
        );
        const existingVersions = this.listClaims({
          identityId: run.identityId,
          visibility: run.visibility,
        }).filter((claim) =>
          claim.semanticKey === semanticKey
          && !expectedSet.has(claim.claimId)
          && claim.metadata.migrationPendingRejudge !== true
          && claim.metadata.migrationPendingConsolidation !== true
        );
        const existingRoot = [...existingVersions].sort((left, right) =>
          Number(right.state === "active") - Number(left.state === "active")
          || right.updatedAt - left.updatedAt
        )[0];
        const rootClaimId = existingRoot?.rootClaimId ?? randomUUID();
        const plannedClaimIds = versions.map((_, index) =>
          index === 0 && !existingRoot ? rootClaimId : randomUUID()
        );
        const hasExplicitDurableVersion = [
          ...existingVersions.filter((claim) => claim.state === "active")
            .map((claim) => claim.epistemicStatus),
          ...versions.filter((version) => version.policy.state === "active")
            .map((version) => version.policy.epistemicStatus),
        ].includes("explicit");
        const durableEntries: Array<{
          key: string;
          claimId: string;
          effectiveFrom: number;
          validTo?: number;
          canonicalText: string;
        }> = [
          ...existingVersions.flatMap((claim) =>
            claim.state === "active"
            && (!hasExplicitDurableVersion || claim.epistemicStatus === "explicit")
              ? [{
                  key: `existing:${claim.claimId}`,
                  claimId: claim.claimId,
                  effectiveFrom: claim.validFrom ?? claim.createdAt,
                  validTo: claim.validTo,
                  canonicalText: claim.canonicalText,
                }]
              : []
          ),
          ...versions.flatMap((version, index) =>
            version.policy.state === "active"
            && (
              !hasExplicitDurableVersion
              || version.policy.epistemicStatus === "explicit"
            )
              ? [{
                  key: `new:${index}`,
                  claimId: plannedClaimIds[index],
                  effectiveFrom: version.effectiveFrom,
                  validTo: version.claim.validTo,
                  canonicalText: version.claim.canonicalText,
                }]
              : []
          ),
        ].sort((left, right) =>
          left.effectiveFrom - right.effectiveFrom
          || left.canonicalText.localeCompare(right.canonicalText)
          || left.claimId.localeCompare(right.claimId)
        );
        const activeEntryKeys = new Set(
          durableEntries
            .filter((entry) => entry.effectiveFrom > now)
            .map((entry) => entry.key),
        );
        const currentEntry = durableEntries.filter((entry) =>
          entry.effectiveFrom <= now
          && (entry.validTo === undefined || entry.validTo > now)
        ).at(-1);
        if (currentEntry) {
          activeEntryKeys.add(currentEntry.key);
        } else if (activeEntryKeys.size === 0 && durableEntries.length > 0) {
          activeEntryKeys.add(durableEntries.at(-1)!.key);
        }
        const nextEffectiveFrom = new Map<string, number>();
        for (const [entryIndex, entry] of durableEntries.entries()) {
          const next = durableEntries
            .slice(entryIndex + 1)
            .find((candidate) => candidate.effectiveFrom > entry.effectiveFrom);
          if (next) nextEffectiveFrom.set(entry.key, next.effectiveFrom);
        }
        for (const existing of existingVersions) {
          this.db.prepare(`
            UPDATE memory_claims SET root_claim_id = ? WHERE claim_id = ?
          `).run(rootClaimId, existing.claimId);
          if (existing.state !== "active") continue;
          const key = `existing:${existing.claimId}`;
          if (!activeEntryKeys.has(key)) {
            this.removeClaimFromIndexes(existing.claimId);
            this.db.prepare(`
              UPDATE memory_claims
              SET state = 'superseded', updated_at = ?
              WHERE claim_id = ? AND state = 'active'
            `).run(now, existing.claimId);
            continue;
          }
          const next = nextEffectiveFrom.get(key);
          if (next !== undefined) {
            this.db.prepare(`
              UPDATE memory_claims
              SET valid_to = CASE
                    WHEN valid_to IS NULL OR valid_to > ? THEN ?
                    ELSE valid_to
                  END,
                  updated_at = ?
              WHERE claim_id = ? AND state = 'active'
            `).run(next, next, now, existing.claimId);
            this.indexClaim(this.getClaim(existing.claimId)!);
          }
        }
        let previousCandidateId: string | undefined;
        for (const [index, version] of versions.entries()) {
          const claimId = plannedClaimIds[index];
          outputClaimIds.push(claimId);
          const state: MemoryClaimState = version.policy.state === "candidate"
            || (
              hasExplicitDurableVersion
              && version.policy.epistemicStatus === "inferred"
            )
              ? "candidate"
            : activeEntryKeys.has(`new:${index}`)
              ? "active"
              : "superseded";
          const next = nextEffectiveFrom.get(`new:${index}`);
          const validTo = next === undefined
            ? version.claim.validTo
            : Math.min(
              version.claim.validTo ?? next,
              next,
            );
          const durableIndex = durableEntries.findIndex((entry) =>
            entry.key === `new:${index}`
          );
          const supersedesClaimId = durableIndex > 0
            ? durableEntries[durableIndex - 1].claimId
            : version.policy.state === "candidate"
              ? previousCandidateId ?? existingRoot?.claimId
              : undefined;
          const sourceEvent = [...version.events]
            .sort((left, right) => left.occurredAt - right.occurredAt)[0];
          this.db.prepare(`
            INSERT INTO memory_claims(
              claim_id, root_claim_id, identity_id, semantic_key, subject_id, predicate, value_json,
              canonical_text, top_level_type, epistemic_status, authority, confidence,
              state, visibility, valid_from, valid_to, topic, entity_ids_json,
              supersedes_claim_id, source_event_id, supporting_evidence_count,
              opposing_evidence_count, created_at, updated_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            claimId,
            rootClaimId,
            run.identityId,
            semanticKey,
            version.claim.subjectId,
            version.claim.predicate,
            JSON.stringify(version.claim.value),
            version.claim.canonicalText,
            version.claim.topLevelType,
            version.policy.epistemicStatus,
            version.policy.authority,
            normalizeConfidence(version.claim.confidence),
            state,
            run.visibility,
            version.effectiveFrom,
            validTo ?? null,
            safeTopic(version.claim.topic) || null,
            JSON.stringify(version.claim.entityIds),
            supersedesClaimId ?? null,
            sourceEvent.eventId,
            version.claim.supportingEventIds.length,
            version.claim.opposingEventIds.length,
            now,
            now,
            JSON.stringify({
              lifecycle: version.claim.lifecycle,
              legacyConsolidationRunId: run.runId,
              semanticKey,
              sourceCandidateIds: version.claim.sourceCandidateIds,
            }),
          );
          for (const eventId of version.claim.supportingEventIds) {
            this.db.prepare(`
              INSERT INTO claim_evidence(
                claim_id, event_id, stance, weight, reason, created_at
              ) VALUES (?, ?, 'supports', 1, 'legacy_consolidation', ?)
            `).run(claimId, eventId, now);
          }
          for (const eventId of version.claim.opposingEventIds) {
            const event = this.getEvent(eventId);
            if (
              !event
              || event.identityId !== run.identityId
              || event.visibility !== run.visibility
            ) {
              throw new Error(`legacy consolidated claim has invalid opposing evidence: ${eventId}`);
            }
            this.db.prepare(`
              INSERT INTO claim_evidence(
                claim_id, event_id, stance, weight, reason, created_at
              ) VALUES (?, ?, 'opposes', 1, 'legacy_consolidation', ?)
            `).run(claimId, eventId, now);
          }
          this.indexClaim(this.getClaim(claimId)!);
          previousCandidateId = claimId;
        }
      }
      for (const candidateId of expectedCandidateIds) {
        this.removeClaimFromIndexes(candidateId);
        this.db.prepare(`
          UPDATE memory_claims
          SET state = 'refuted', updated_at = ?
          WHERE claim_id = ? AND state = 'candidate'
        `).run(now, candidateId);
      }
      const discardedCandidateIds = input.discarded.flatMap((item) =>
        item.sourceCandidateIds
      );
      this.db.prepare(`
        UPDATE legacy_consolidation_runs
        SET status = 'completed',
            covered_candidate_count = ?,
            covered_source_event_count = ?,
            output_claim_ids_json = ?,
            discarded_candidate_ids_json = ?,
            audit_json = ?,
            error = NULL,
            updated_at = ?
        WHERE run_id = ?
      `).run(
        expectedCandidateIds.length,
        extractions.length,
        JSON.stringify(outputClaimIds),
        JSON.stringify(discardedCandidateIds),
        JSON.stringify(storedAudit),
        now,
        run.runId,
      );
      this.db.exec("COMMIT");
      return this.getLegacyConsolidationRun(
        run.identityId,
        run.visibility,
        run.inputHash,
      )!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getClaimRow(claimId: string): ClaimRow | undefined {
    return this.db.prepare("SELECT * FROM memory_claims WHERE claim_id = ?")
      .get(claimId) as ClaimRow | undefined;
  }

  getClaim(claimId: string): MemoryClaim | undefined {
    const row = this.getClaimRow(claimId);
    return row ? asClaim(row) : undefined;
  }

  settleLegacyMigrationCandidates(
    eventId: string,
    state: "superseded" | "refuted",
    at = Date.now(),
  ): string[] {
    const candidates = this.listClaims({ states: ["candidate"] })
      .filter((claim) =>
        claim.sourceEventId === eventId
        && claim.metadata.migrationPendingRejudge === true
      );
    if (candidates.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const claim of candidates) {
        this.removeClaimFromIndexes(claim.claimId);
        this.db.prepare(`
          UPDATE memory_claims
          SET state = ?, updated_at = ?
          WHERE claim_id = ? AND state = 'candidate'
        `).run(state, at, claim.claimId);
      }
      this.db.exec("COMMIT");
      return candidates.map((claim) => claim.claimId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private currentSemanticClaim(
    identityId: string,
    visibility: MemoryVisibility,
    semanticKey: string,
    at: number,
  ): MemoryClaim | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM memory_claims
      WHERE identity_id = ?
        AND visibility = ?
        AND semantic_key = ?
        AND state IN ('active', 'candidate')
      ORDER BY
        CASE
          WHEN state = 'active'
            AND (valid_from IS NULL OR valid_from <= ?)
            AND (valid_to IS NULL OR valid_to > ?)
            THEN 0
          WHEN state = 'active' THEN 1
          ELSE 2
        END,
        COALESCE(valid_from, -9223372036854775808) DESC,
        updated_at DESC
      LIMIT 1
    `).get(identityId, visibility, semanticKey, at, at) as ClaimRow | undefined;
    return row ? asClaim(row) : undefined;
  }

  private evidenceScopeError(
    eventIds: string[],
    source: MemoryEvent,
    label: "supporting" | "opposing",
  ): string | undefined {
    for (const eventId of [...new Set(eventIds)]) {
      const evidence = this.getEvent(eventId);
      if (!evidence) return `${label}_evidence_not_found`;
      if (
        evidence.identityId !== source.identityId
        || evidence.visibility !== source.visibility
      ) {
        return `${label}_evidence_scope_mismatch`;
      }
    }
    return undefined;
  }

  private countUsableEvidence(eventIds: string[], existing?: MemoryClaim): number {
    const unique = [...new Set(eventIds)];
    let count = 0;
    for (const eventId of unique) {
      const event = this.getEvent(eventId);
      if (!event) continue;
      if (existing && shouldIgnoreSelfReinforcingEvidence(event, existing)) continue;
      count += 1;
    }
    return count;
  }

  private insertEvidence(
    claimId: string,
    eventIds: string[],
    stance: EvidenceStance,
    existing?: MemoryClaim,
  ): number {
    const now = Date.now();
    let inserted = 0;
    for (const eventId of [...new Set(eventIds)]) {
      const event = this.getEvent(eventId);
      if (!event) continue;
      const effectiveStance = existing && shouldIgnoreSelfReinforcingEvidence(event, existing)
        ? "ignored"
        : stance;
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO claim_evidence(
          claim_id, event_id, stance, weight, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        claimId,
        eventId,
        effectiveStance,
        effectiveStance === "ignored" ? 0 : 1,
        effectiveStance === "ignored" ? "self_recall_is_not_independent_evidence" : null,
        now,
      );
      if (result.changes > 0 && effectiveStance === stance) inserted += 1;
    }
    return inserted;
  }

  listClaimEvidence(
    claimId: string,
    stance?: EvidenceStance,
  ): Array<{ eventId: string; stance: EvidenceStance }> {
    const rows = stance
      ? this.db.prepare(`
          SELECT event_id, stance
          FROM claim_evidence
          WHERE claim_id = ? AND stance = ?
          ORDER BY created_at, event_id
        `).all(claimId, stance)
      : this.db.prepare(`
          SELECT event_id, stance
          FROM claim_evidence
          WHERE claim_id = ?
          ORDER BY created_at, event_id, stance
        `).all(claimId);
    return (rows as unknown as Array<{
      event_id: string;
      stance: EvidenceStance;
    }>).map((row) => ({
      eventId: row.event_id,
      stance: row.stance,
    }));
  }

  private isRecallableClaim(
    claim: MemoryClaim | undefined,
    visibility: MemoryVisibility,
    now: number,
  ): claim is MemoryClaim {
    return Boolean(
      claim
      && claim.state === "active"
      && claim.visibility === visibility
      && (claim.validFrom === undefined || claim.validFrom <= now)
      && (claim.validTo === undefined || claim.validTo > now)
      && claim.metadata.migrationPendingRejudge !== true
      && claim.metadata.migrationPendingConsolidation !== true,
    );
  }

  revalidateSearchCandidates(
    candidates: MemorySearchCandidate[],
    visibility: MemoryVisibility,
    now = Date.now(),
  ): MemorySearchCandidate[] {
    return candidates.flatMap((candidate) => {
      const claim = this.getClaim(candidate.claim.claimId);
      if (
        !this.isRecallableClaim(claim, visibility, now)
        || claim.identityId !== candidate.claim.identityId
      ) {
        return [];
      }
      return [{ ...candidate, claim }];
    });
  }

  private removeClaimFromIndexes(claimId: string): void {
    this.db.prepare("DELETE FROM claims_fts WHERE claim_id = ?").run(claimId);
    const embeddings = this.db.prepare(`
      SELECT table_name
      FROM claim_embedding_meta
      WHERE claim_id = ?
    `).all(claimId) as unknown as Array<{ table_name: string }>;
    for (const embedding of embeddings) {
      if (!/^claim_vec_\d+$/.test(embedding.table_name)) continue;
      this.db.prepare(`DELETE FROM ${embedding.table_name} WHERE claim_id = ?`).run(claimId);
    }
    this.db.prepare("DELETE FROM claim_embedding_meta WHERE claim_id = ?").run(claimId);
  }

  private indexClaim(claim: MemoryClaim): void {
    this.db.prepare("DELETE FROM claims_fts WHERE claim_id = ?").run(claim.claimId);
    if (claim.state !== "active" && claim.state !== "candidate") return;
    this.db.prepare(`
      INSERT INTO claims_fts(claim_id, identity_id, canonical_text, predicate, topic)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      claim.claimId,
      claim.identityId,
      claim.canonicalText,
      claim.predicate,
      claim.topic ?? "",
    );
  }

  private purgeClaim(rootOrClaimId: string): string[] {
    const rows = this.db.prepare(`
      SELECT claim_id
      FROM memory_claims
      WHERE root_claim_id = (
        SELECT root_claim_id FROM memory_claims WHERE claim_id = ?
      )
         OR root_claim_id = ?
    `).all(rootOrClaimId, rootOrClaimId) as unknown as Array<{ claim_id: string }>;
    const claimIds = rows.map((row) => row.claim_id);
    const migrationCandidateIds = [...new Set(claimIds.flatMap((claimId) => {
      const claim = this.getClaim(claimId);
      return Array.isArray(claim?.metadata.sourceCandidateIds)
        ? claim.metadata.sourceCandidateIds.filter(
          (candidateId): candidateId is string => typeof candidateId === "string",
        )
        : [];
    }))].filter((candidateId) => {
      const candidate = this.getClaim(candidateId);
      return candidate?.metadata.migrationPendingConsolidation === true;
    });
    claimIds.push(...migrationCandidateIds.filter((claimId) => !claimIds.includes(claimId)));
    if (claimIds.length === 0) return [];
    const eventIds = new Set<string>();
    for (const claimId of claimIds) {
      const evidenceRows = this.db.prepare("SELECT event_id FROM claim_evidence WHERE claim_id = ?")
        .all(claimId) as unknown as Array<{ event_id: string }>;
      for (const row of evidenceRows) eventIds.add(row.event_id);
      this.removeClaimFromIndexes(claimId);
    }
    const placeholders = claimIds.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM memory_claims WHERE claim_id IN (${placeholders})`).run(...claimIds);
    for (const eventId of eventIds) {
      const remaining = this.db.prepare("SELECT 1 FROM claim_evidence WHERE event_id = ? LIMIT 1")
        .get(eventId);
      const event = this.getEvent(eventId);
      if (!remaining && event?.kind !== "legacy_import") {
        this.db.prepare("DELETE FROM memory_events WHERE event_id = ?").run(eventId);
      }
    }
    return claimIds;
  }

  applyClaimProposal(eventId: string, proposal: ClaimProposal): ApplyClaimResult {
    const event = this.getEvent(eventId);
    if (!event) return { ignoredReason: "source_event_not_found" };
    const canonicalText = normalizeText(proposal.canonicalText);
    const predicate = normalizeText(proposal.predicate);
    const subjectId = normalizeText(proposal.subjectId);
    if (!canonicalText || !predicate || !subjectId) {
      return { ignoredReason: "invalid_empty_claim" };
    }
    const action = proposal.action ?? "add";
    const target = proposal.targetClaimId ? this.getClaim(proposal.targetClaimId) : undefined;
    if (proposal.targetClaimId && !target) {
      return { ignoredReason: `${action}_target_not_found` };
    }
    if (
      target
      && (
        target.identityId !== event.identityId
        || target.visibility !== event.visibility
      )
    ) {
      return { ignoredReason: "target_scope_mismatch" };
    }
    const userControlAuthority =
      event.actor === "user"
      && (event.kind === "memory_control" || event.kind === "human_override")
      && (
        proposal.authority === "user_correction"
        || proposal.authority === "human_override"
      );
    if (action === "delete") {
      if (!target) return { ignoredReason: "delete_target_not_found" };
      if (!userControlAuthority) {
        return { ignoredReason: "delete_requires_user_control_authority" };
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const deletedClaimIds = this.purgeClaim(target.rootClaimId);
        this.db.exec("COMMIT");
        return { deletedClaimIds };
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const requestedSemanticKey = semanticKeyFor(proposal.semanticKey, subjectId, predicate);
    const semanticKey = target?.semanticKey ?? requestedSemanticKey;
    const current = target ?? this.currentSemanticClaim(
      event.identityId,
      event.visibility,
      semanticKey,
      event.occurredAt,
    );
    const supportIds = [...new Set([eventId, ...(proposal.supportingEventIds ?? [])])];
    const opposeIds = [...new Set(proposal.opposingEventIds ?? [])];
    const supportError = this.evidenceScopeError(supportIds, event, "supporting");
    if (supportError) return { ignoredReason: supportError };
    const opposeError = this.evidenceScopeError(opposeIds, event, "opposing");
    if (opposeError) return { ignoredReason: opposeError };
    const usableSupportCount = this.countUsableEvidence(supportIds, current);
    const confidence = normalizeConfidence(proposal.confidence);
    const proposedAuthorityWeight = memoryAuthorityWeight(proposal.authority);
    const currentAuthorityWeight = current ? memoryAuthorityWeight(current.authority) : -1;
    const assistantOrigin = event.actor === "asuka"
      || event.kind === "assistant_reply"
      || event.kind === "proactive_message";
    let state: MemoryClaimState;
    if (
      event.kind === "legacy_import"
      && proposal.metadata?.migrationPendingRejudge === true
    ) {
      state = "candidate";
    } else if (action === "forget") {
      if (!current) return { ignoredReason: "forget_target_not_found" };
      if (!userControlAuthority) {
        return { ignoredReason: "forget_requires_user_control_authority" };
      }
      state = "forgotten";
    } else if (action === "refute") {
      if (!current) return { ignoredReason: "refute_target_not_found" };
      if (proposedAuthorityWeight < currentAuthorityWeight) {
        return { ignoredReason: "lower_authority_cannot_refute" };
      }
      state = "refuted";
    } else if (assistantOrigin) {
      state = "candidate";
    } else if (
      proposal.epistemicStatus === "inferred"
      && (
        confidence < this.inferencePromotionConfidence
        || usableSupportCount < 2
      )
    ) {
      state = "candidate";
    } else if (current && proposedAuthorityWeight < currentAuthorityWeight) {
      state = "candidate";
    } else {
      state = "active";
    }
    const effectiveFrom = proposal.validFrom ?? event.occurredAt;

    if (
      current
      && state === "active"
      && current.canonicalText === canonicalText
      && current.authority === proposal.authority
      && (proposal.validFrom === undefined || current.validFrom === effectiveFrom)
      && (proposal.validTo === undefined || current.validTo === proposal.validTo)
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.insertEvidence(current.claimId, supportIds, "supports", current);
        this.insertEvidence(current.claimId, opposeIds, "opposes", current);
        this.db.prepare(`
          UPDATE memory_claims
          SET supporting_evidence_count = (
                SELECT COUNT(*) FROM claim_evidence
                WHERE claim_id = ? AND stance = 'supports'
              ),
              opposing_evidence_count = (
                SELECT COUNT(*) FROM claim_evidence
                WHERE claim_id = ? AND stance = 'opposes'
              )
          WHERE claim_id = ?
        `).run(current.claimId, current.claimId, current.claimId);
        this.db.exec("COMMIT");
        return {
          claimId: current.claimId,
          rootClaimId: current.rootClaimId,
          state: current.state,
        };
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const now = Date.now();
    const claimId = randomUUID();
    const rootClaimId = current?.rootClaimId ?? claimId;
    const supersedesClaimId = current?.claimId;
    const preservesCurrentValidity = Boolean(
      current
      && current.state === "active"
      && state === "active"
      && effectiveFrom > event.occurredAt
      && (current.validFrom === undefined || current.validFrom <= event.occurredAt)
      && (current.validTo === undefined || current.validTo > event.occurredAt),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current && state !== "candidate" && !preservesCurrentValidity) {
        this.db.prepare(`
          UPDATE memory_claims
          SET state = 'superseded', updated_at = ?
          WHERE claim_id = ? AND state IN ('active', 'candidate')
        `).run(now, current.claimId);
        this.removeClaimFromIndexes(current.claimId);
      } else if (current && preservesCurrentValidity) {
        this.db.prepare(`
          UPDATE memory_claims
          SET valid_to = CASE
                WHEN valid_to IS NULL OR valid_to > ? THEN ?
                ELSE valid_to
              END,
              updated_at = ?
          WHERE claim_id = ? AND state = 'active'
        `).run(effectiveFrom, effectiveFrom, now, current.claimId);
        this.indexClaim(this.getClaim(current.claimId)!);
      }
      this.db.prepare(`
        INSERT INTO memory_claims(
          claim_id, root_claim_id, identity_id, semantic_key, subject_id, predicate, value_json,
          canonical_text, top_level_type, epistemic_status, authority, confidence,
          state, visibility, valid_from, valid_to, topic, entity_ids_json,
          supersedes_claim_id, source_event_id, supporting_evidence_count,
          opposing_evidence_count, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      `).run(
        claimId,
        rootClaimId,
        event.identityId,
        semanticKey,
        subjectId,
        predicate,
        JSON.stringify(proposal.value),
        canonicalText,
        proposal.topLevelType,
        proposal.epistemicStatus,
        proposal.authority,
        confidence,
        state,
        event.visibility,
        effectiveFrom,
        proposal.validTo ?? null,
        safeTopic(proposal.topic) || null,
        JSON.stringify(proposal.entityIds ?? []),
        supersedesClaimId ?? null,
        eventId,
        now,
        now,
        JSON.stringify({
          ...(proposal.metadata ?? {}),
          lifecycle: proposal.lifecycle,
        }),
      );
      const supportCount = this.insertEvidence(claimId, supportIds, "supports", current);
      const opposeCount = this.insertEvidence(claimId, opposeIds, "opposes", current);
      this.db.prepare(`
        UPDATE memory_claims
        SET supporting_evidence_count = ?, opposing_evidence_count = ?
        WHERE claim_id = ?
      `).run(supportCount, opposeCount, claimId);
      const inserted = this.getClaim(claimId)!;
      this.indexClaim(inserted);
      this.db.exec("COMMIT");
      return { claimId, rootClaimId, state };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listClaims(options: {
    identityId?: string;
    states?: MemoryClaimState[];
    visibility?: MemoryVisibility;
    now?: number;
  } = {}): MemoryClaim[] {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (options.identityId) {
      conditions.push("identity_id = ?");
      parameters.push(options.identityId);
    }
    if (options.states?.length) {
      conditions.push(`state IN (${options.states.map(() => "?").join(", ")})`);
      parameters.push(...options.states);
    }
    if (options.visibility) {
      conditions.push("visibility = ?");
      parameters.push(options.visibility);
    }
    if (options.now !== undefined) {
      conditions.push("(valid_from IS NULL OR valid_from <= ?)");
      parameters.push(options.now);
      conditions.push("(valid_to IS NULL OR valid_to > ?)");
      parameters.push(options.now);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT * FROM memory_claims
      ${where}
      ORDER BY updated_at DESC, claim_id
    `).all(...parameters) as unknown as ClaimRow[];
    return rows.map(asClaim);
  }

  getProjectionSnapshot(identityId?: string, now = Date.now()): MemoryProjectionSnapshot {
    const claims = this.listClaims({
      identityId,
      states: ["active"],
      now,
    });
    const history = this.listClaims({
      identityId,
      states: ["candidate", "superseded", "refuted", "forgotten"],
    });
    const claimEvidence: MemoryProjectionClaimEvidence[] = [];
    const eventSummaries = new Map<string, MemoryProjectionEventSummary>();
    for (const claim of [...claims, ...history]) {
      const linked = this.listClaimEvidence(claim.claimId)
        .filter((item): item is { eventId: string; stance: "supports" | "opposes" } =>
          item.stance === "supports" || item.stance === "opposes"
        )
        .map((item) => ({ ...item, event: this.getEvent(item.eventId) }))
        .filter((item): item is typeof item & { event: MemoryEvent } =>
          item.event !== undefined
          && item.event.identityId === claim.identityId
          && item.event.visibility === claim.visibility
        );
      for (const stance of ["supports", "opposes"] as const) {
        const bounded = linked
          .filter((item) => item.stance === stance)
          .sort((left, right) =>
            right.event.occurredAt - left.event.occurredAt
            || left.event.eventId.localeCompare(right.event.eventId)
          )
          .slice(0, MAX_PROJECTION_EVIDENCE_PER_STANCE);
        for (const item of bounded) {
          claimEvidence.push({
            claimId: claim.claimId,
            eventId: item.eventId,
            stance,
          });
          if (!eventSummaries.has(item.eventId)) {
            eventSummaries.set(item.eventId, projectionEventSummary(item.event));
          }
        }
      }
    }
    return {
      generatedAt: now,
      claims,
      history,
      claimEvidence,
      eventSummaries: [...eventSummaries.values()].sort((left, right) =>
        right.occurredAt - left.occurredAt
        || left.eventId.localeCompare(right.eventId)
      ),
    };
  }

  searchLocal(options: {
    identityId: string;
    visibility: MemoryVisibility;
    query: string;
    now?: number;
    limit?: number;
    vector?: number[];
    embeddingModel?: string;
  }): MemorySearchCandidate[] {
    const now = options.now ?? Date.now();
    const limit = Math.max(1, Math.min(100, options.limit ?? 24));
    const claims = new Map<string, MemorySearchCandidate>();
    const query = normalizeText(options.query);

    if (query.length >= 3) {
      try {
        const ftsRows = this.db.prepare(`
          SELECT claim_id, bm25(claims_fts, 0.0, 0.0, 1.0, 0.5, 0.25) AS rank
          FROM claims_fts
          WHERE claims_fts MATCH ? AND identity_id = ?
          ORDER BY rank
          LIMIT ?
        `).all(makeFtsQuery(query), options.identityId, limit) as unknown as Array<{
          claim_id: string;
          rank: number;
        }>;
        for (const row of ftsRows) {
          const claim = this.getClaim(row.claim_id);
          if (!this.isRecallableClaim(claim, options.visibility, now)) continue;
          const lexicalScore = 1 / (1 + Math.max(0, Math.abs(row.rank)));
          claims.set(claim.claimId, {
            claim,
            lexicalScore,
            vectorScore: 0,
            recencyScore: recencyScore(claim.updatedAt, now),
            authorityScore: memoryAuthorityWeight(claim.authority) / 600,
            localScore: 0,
          });
        }
      } catch {
        // Invalid or unsupported FTS input falls through to recent active claims.
      }
    }

    if (options.vector?.length && options.embeddingModel && this.vectorAvailable) {
      for (const result of this.searchVector(
        options.identityId,
        options.embeddingModel,
        options.vector,
        limit,
      )) {
        const claim = this.getClaim(result.claimId);
        if (!this.isRecallableClaim(claim, options.visibility, now)) continue;
        const existing = claims.get(claim.claimId);
        const vectorScore = 1 / (1 + Math.max(0, result.distance));
        claims.set(claim.claimId, {
          claim,
          lexicalScore: existing?.lexicalScore ?? 0,
          vectorScore,
          recencyScore: existing?.recencyScore ?? recencyScore(claim.updatedAt, now),
          authorityScore: existing?.authorityScore ?? memoryAuthorityWeight(claim.authority) / 600,
          localScore: 0,
        });
      }
    }

    if (claims.size < Math.min(8, limit)) {
      for (const claim of this.listClaims({
        identityId: options.identityId,
        states: ["active"],
        visibility: options.visibility,
        now,
      }).slice(0, limit)) {
        if (!this.isRecallableClaim(claim, options.visibility, now)) continue;
        if (claims.has(claim.claimId)) continue;
        claims.set(claim.claimId, {
          claim,
          lexicalScore: 0,
          vectorScore: 0,
          recencyScore: recencyScore(claim.updatedAt, now),
          authorityScore: memoryAuthorityWeight(claim.authority) / 600,
          localScore: 0,
        });
      }
    }

    for (const candidate of claims.values()) {
      candidate.localScore =
        candidate.lexicalScore * 0.38
        + candidate.vectorScore * 0.38
        + candidate.authorityScore * 0.16
        + candidate.recencyScore * 0.08;
    }
    return [...claims.values()]
      .sort((a, b) => b.localScore - a.localScore || b.claim.updatedAt - a.claim.updatedAt)
      .slice(0, limit);
  }

  upsertEmbedding(claimId: string, model: string, vector: number[], at = Date.now()): boolean {
    if (!this.vectorAvailable || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
      return false;
    }
    const dimensions = vector.length;
    const tableName = `claim_vec_${dimensions}`;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
        claim_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM ${tableName} WHERE claim_id = ?`).run(claimId);
      this.db.prepare(`INSERT INTO ${tableName}(claim_id, embedding) VALUES (?, ?)`)
        .run(claimId, new Float32Array(vector));
      this.db.prepare(`
        INSERT INTO claim_embedding_meta(claim_id, model, dimensions, table_name, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(claim_id, model) DO UPDATE SET
          dimensions = excluded.dimensions,
          table_name = excluded.table_name,
          updated_at = excluded.updated_at
      `).run(claimId, model, dimensions, tableName, at);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      console.warn(`[asuka-memory] Failed to index claim vector: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private searchVector(
    identityId: string,
    model: string,
    vector: number[],
    limit: number,
  ): Array<{ claimId: string; distance: number }> {
    const dimensions = vector.length;
    const tableName = `claim_vec_${dimensions}`;
    const exists = this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName);
    if (!exists) return [];
    try {
      const rows = this.db.prepare(`
        SELECT vectors.claim_id AS claim_id, vectors.distance AS distance
        FROM ${tableName} AS vectors
        JOIN claim_embedding_meta AS meta
          ON meta.claim_id = vectors.claim_id
         AND meta.model = ?
         AND meta.dimensions = ?
        JOIN memory_claims AS claims
          ON claims.claim_id = vectors.claim_id
         AND claims.identity_id = ?
        WHERE vectors.embedding MATCH ?
          AND k = ?
        ORDER BY vectors.distance
      `).all(
        model,
        dimensions,
        identityId,
        new Float32Array(vector),
        limit,
      ) as unknown as Array<{ claim_id: string; distance: number }>;
      return rows.map((row) => ({ claimId: row.claim_id, distance: row.distance }));
    } catch {
      return [];
    }
  }

  writeRerankCache(
    identityId: string,
    query: string,
    claimIds: string[],
    modelRunId?: string,
    ttlMs = 300_000,
  ): void {
    const now = Date.now();
    const queryHash = createHash("sha256").update(normalizeText(query)).digest("hex");
    this.db.prepare(`
      INSERT INTO rerank_cache(
        identity_id, query_hash, claim_ids_json, model_run_id, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_id, query_hash) DO UPDATE SET
        claim_ids_json = excluded.claim_ids_json,
        model_run_id = excluded.model_run_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(identityId, queryHash, JSON.stringify(claimIds), modelRunId ?? null, now + ttlMs, now);
  }

  readRerankCache(identityId: string, query: string, at = Date.now()): {
    claimIds: string[];
    modelRunId?: string;
  } | undefined {
    const queryHash = createHash("sha256").update(normalizeText(query)).digest("hex");
    const row = this.db.prepare(`
      SELECT claim_ids_json, model_run_id
      FROM rerank_cache
      WHERE identity_id = ? AND query_hash = ? AND expires_at > ?
    `).get(identityId, queryHash, at) as {
      claim_ids_json: string;
      model_run_id: string | null;
    } | undefined;
    return row ? {
      claimIds: parseJson(row.claim_ids_json, []),
      modelRunId: row.model_run_id ?? undefined,
    } : undefined;
  }

  recordModelRun(input: {
    runId?: string;
    task: string;
    model?: string;
    promptVersion: number;
    status: string;
    elapsedMs: number;
    inputEventId?: string;
    resultSummary?: string;
    error?: string;
  }): string {
    const runId = input.runId ?? randomUUID();
    this.db.prepare(`
      INSERT INTO model_runs(
        run_id, task, model, prompt_version, status, elapsed_ms, input_event_id,
        result_summary, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      input.task,
      input.model ?? null,
      input.promptVersion,
      input.status,
      input.elapsedMs,
      input.inputEventId ?? null,
      input.resultSummary?.slice(0, 1_000) ?? null,
      input.error?.slice(0, 1_000) ?? null,
      Date.now(),
    );
    return runId;
  }

  recordRetrievalFeedback(input: {
    identityId: string;
    query: string;
    claimIds: string[];
    outcome: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO retrieval_feedback(
        feedback_id, identity_id, query_hash, claim_ids_json, outcome, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.identityId,
      createHash("sha256").update(normalizeText(input.query)).digest("hex"),
      JSON.stringify(input.claimIds),
      input.outcome,
      JSON.stringify(input.detail ?? {}),
      Date.now(),
    );
  }

  setProjectionCursor(
    projection: string,
    eventCursor: number,
    contentHash?: string,
    at = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO projection_cursors(projection, event_cursor, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(projection) DO UPDATE SET
        event_cursor = excluded.event_cursor,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(projection, eventCursor, contentHash ?? null, at);
  }

  getProjectionCursor(projection: string): {
    eventCursor: number;
    contentHash?: string;
    updatedAt: number;
  } | undefined {
    const row = this.db.prepare(`
      SELECT event_cursor, content_hash, updated_at
      FROM projection_cursors
      WHERE projection = ?
    `).get(projection) as {
      event_cursor: number;
      content_hash: string | null;
      updated_at: number;
    } | undefined;
    return row ? {
      eventCursor: row.event_cursor,
      contentHash: row.content_hash ?? undefined,
      updatedAt: row.updated_at,
    } : undefined;
  }

  integrityCheck(): {
    ok: boolean;
    integrity: string;
    foreignKeyViolations: number;
    schemaVersion: number;
  } {
    const integrityRow = this.db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
    const integrity = Object.values(integrityRow)[0] ?? "unknown";
    const foreignKeys = this.db.prepare("PRAGMA foreign_key_check").all();
    const version = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return {
      ok: integrity === "ok" && foreignKeys.length === 0 && version.version === SCHEMA_VERSION,
      integrity,
      foreignKeyViolations: foreignKeys.length,
      schemaVersion: version.version ?? 0,
    };
  }

  getStats(): Record<string, number> {
    const tables = [
      "identity_links",
      "memory_events",
      "memory_claims",
      "claim_evidence",
      "memory_jobs",
      "model_runs",
      "retrieval_feedback",
    ];
    return Object.fromEntries(tables.map((table) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, row.count];
    }));
  }
}
