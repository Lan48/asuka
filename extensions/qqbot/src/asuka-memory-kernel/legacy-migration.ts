import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  legacyConsolidationInputHash,
  type AsukaMemoryEngine,
} from "./engine.js";
import type {
  MemoryActor,
  MemoryEventInput,
  MemoryJobBatchResult,
  MemoryPeerKind,
  MemoryTopLevelType,
} from "./types.js";

export interface LegacyMigrationScope {
  accountId: string;
  peerId: string;
  peerKind?: MemoryPeerKind;
  identityId?: string;
}

export interface LegacyMigrationSources {
  memoryJson?: string;
  claimsJsonl?: string;
  stateJson?: string;
  digestJson?: string;
  refIndexJsonl?: string;
  sessionsIndexJson?: string;
  sessionsDirectory?: string;
}

export interface LegacyMigrationRecord {
  sourceKind: "memory" | "claim" | "state" | "digest" | "ref_index" | "session";
  sourcePath: string;
  sourceRecordId?: string;
  sourceContent?: string;
  legacyId: string;
  actor: MemoryActor;
  text: string;
  occurredAt: number;
  metadata: Record<string, unknown>;
  auditedNonImport?: {
    code: LegacyAuditedNonImportCode;
    reason: string;
  };
  provisional?: {
    legacyType: string;
    topLevelType: MemoryTopLevelType;
    epistemicStatus: "explicit" | "inferred";
  };
}

const LEGACY_AUDITED_NON_IMPORT_REASONS = {
  empty_record: "source record is empty",
  no_supported_text: "source record has no supported text field",
  unsupported_record_shape: "source record has an unsupported parsed shape",
  unsupported_session_record: "session row is not a supported user or assistant message",
  filtered_system_record: "session row is an internal system record",
} as const;

type LegacyAuditedNonImportCode = keyof typeof LEGACY_AUDITED_NON_IMPORT_REASONS;

function auditedNonImport(
  code: LegacyAuditedNonImportCode,
): LegacyMigrationRecord["auditedNonImport"] {
  return {
    code,
    reason: LEGACY_AUDITED_NON_IMPORT_REASONS[code],
  };
}

function isAuditedNonImport(value: unknown): boolean {
  const record = objectRecord(value);
  if (!record || typeof record.code !== "string" || typeof record.reason !== "string") {
    return false;
  }
  const expected = LEGACY_AUDITED_NON_IMPORT_REASONS[
    record.code as LegacyAuditedNonImportCode
  ];
  return typeof expected === "string" && record.reason === expected;
}

class LegacyContentHashMismatchError extends Error {}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJsonValue(item)]),
  );
}

function legacyContentHash(input: {
  sourceKind: LegacyMigrationRecord["sourceKind"];
  actor: MemoryActor;
  text: string;
  sourceContent?: string;
  metadata: Record<string, unknown>;
  provisional?: LegacyMigrationRecord["provisional"];
}): string {
  const material = input.sourceContent === undefined
    ? {
      sourceKind: input.sourceKind,
      actor: input.actor,
      text: input.text.replace(/\s+/g, " ").trim(),
      metadata: input.metadata,
      provisional: input.provisional,
    }
    : {
      sourceKind: input.sourceKind,
      sourceContent: input.sourceContent,
    };
  return createHash("sha256")
    .update(JSON.stringify(stableJsonValue(material)))
    .digest("hex");
}

function storedLegacyContentHash(event: ReturnType<AsukaMemoryEngine["ledger"]["getEvent"]>): string | undefined {
  if (!event) return undefined;
  const stored = event.metadata.legacyContentHash;
  if (typeof stored === "string" && stored) return stored;
  const sourceKind = event.metadata.legacySourceKind;
  if (
    sourceKind !== "memory"
    && sourceKind !== "claim"
    && sourceKind !== "state"
    && sourceKind !== "digest"
    && sourceKind !== "ref_index"
    && sourceKind !== "session"
  ) {
    return undefined;
  }
  const {
    legacyContentHash: _legacyContentHash,
    legacySourceKind: _legacySourceKind,
    legacyId: _legacyId,
    legacySourceRecordId: _legacySourceRecordId,
    provisional,
    ...metadata
  } = event.metadata;
  return legacyContentHash({
    sourceKind,
    actor: event.actor,
    text: event.text,
    sourceContent: typeof event.metadata.legacySourceContent === "string"
      ? event.metadata.legacySourceContent
      : undefined,
    metadata,
    provisional: provisional as LegacyMigrationRecord["provisional"],
  });
}

export interface LegacyMigrationReport {
  generatedAt: string;
  sourceCounts: Record<LegacyMigrationRecord["sourceKind"], number>;
  discoveredRecords: number;
  importedEvents: number;
  duplicateEvents: number;
  provisionalCandidates: number;
  pendingRejudgements: number;
  auditedNonImportRecords: number;
  skippedRecords: number;
  sourceMap: Array<{
    sourceKind: LegacyMigrationRecord["sourceKind"];
    sourcePath: string;
    sourceRecordId: string;
    legacyId: string;
    legacyContentHash: string;
    eventId?: string;
    claimId?: string;
    status: "discovered" | "imported" | "duplicate" | "audited_non_import" | "skipped";
    reason?: string;
  }>;
}

export interface LegacyRejudgementGate {
  passed: boolean;
  blockers: string[];
  events: {
    total: number;
    eligible: number;
    untracked: number;
  };
  jobs: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    attempts: number;
  };
  extractions: {
    completed: number;
    withClaims: number;
    noMemory: number;
  };
  consolidation: {
    status: "not_started" | "not_required" | "running" | "completed" | "failed";
    runs: number;
    outputClaims: number;
  };
  coverage: {
    sourceEvents: number;
    coveredSourceEvents: number;
  };
  claims: {
    provisionalOpen: number;
    active: number;
    candidate: number;
    historical: number;
    versionRoots: number;
  };
}

export interface LegacyRejudgementExecutionOptions {
  batchSize?: number;
  maxBatches?: number;
  retryDelayMs?: number;
  retryFailed?: boolean;
}

export interface LegacyRejudgementExecutionReport {
  startedAt: string;
  finishedAt: string;
  batchSize: number;
  batches: number;
  retriedFailedJobs: number;
  reconciledProvisionalClaims: number;
  processed: number;
  completed: number;
  failed: number;
  batchResults: MemoryJobBatchResult[];
  gateBefore: LegacyRejudgementGate;
  gateAfter: LegacyRejudgementGate;
}

function readJson(file: string | undefined): unknown {
  if (!file) return undefined;
  if (!fs.existsSync(file)) throw new Error(`legacy source does not exist: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot parse legacy JSON source ${file}: ${detail}`);
  }
}

interface LegacyJsonLine {
  value: unknown;
  lineNumber: number;
}

function readJsonLines(file: string | undefined): LegacyJsonLine[] {
  if (!file) return [];
  if (!fs.existsSync(file)) throw new Error(`legacy source does not exist: ${file}`);
  const values: LegacyJsonLine[] = [];
  for (const [index, rawLine] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      values.push({
        value: JSON.parse(line) as unknown,
        lineNumber: index + 1,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot parse legacy JSONL source ${file}:${index + 1}: ${detail}`);
    }
  }
  return values;
}

function canonicalSourceContent(value: unknown): string {
  const serialized = JSON.stringify(stableJsonValue(value));
  return serialized === undefined ? String(value) : serialized;
}

function textValue(value: unknown, maxLength = 8_000): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  if (value === undefined || value === null) return "";
  try {
    return canonicalSourceContent(value).slice(0, maxLength);
  } catch {
    return "";
  }
}

function modelText(value: unknown, preferredText?: string): string {
  const preferred = textValue(preferredText);
  if (preferred) return preferred;
  return canonicalSourceContent(value).slice(0, 8_000);
}

function sourceRecordId(record: LegacyMigrationRecord): string {
  return record.sourceRecordId?.trim() || record.legacyId;
}

function sourceMapBase(
  record: LegacyMigrationRecord,
  contentHash: string,
): Pick<
  LegacyMigrationReport["sourceMap"][number],
  "sourceKind" | "sourcePath" | "sourceRecordId" | "legacyId" | "legacyContentHash"
> {
  return {
    sourceKind: record.sourceKind,
    sourcePath: record.sourcePath,
    sourceRecordId: sourceRecordId(record),
    legacyId: record.legacyId,
    legacyContentHash: contentHash,
  };
}

function timestampValue(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function legacyTopLevelType(type: string): MemoryTopLevelType {
  if (type === "active_thread") return "working_memory";
  if (type.includes("self_signal")) return "self_narrative";
  if (type.includes("self_thread")) return "event";
  if (type.includes("procedure")) return "procedural";
  return "fact";
}

function actorFromLegacySource(source: unknown): MemoryActor {
  if (typeof source !== "string") return "system";
  const normalized = source.trim().toLowerCase();
  if (normalized === "user" || normalized.startsWith("user_")) return "user";
  if (
    normalized === "assistant"
    || normalized === "asuka"
    || normalized.startsWith("assistant_")
    || normalized.startsWith("asuka_")
  ) {
    return "asuka";
  }
  return "system";
}

function scopePeerKind(scope: LegacyMigrationScope): MemoryPeerKind {
  return scope.peerKind ?? "direct";
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function matchesScope(
  value: unknown,
  scope: LegacyMigrationScope,
): boolean {
  const record = objectRecord(value);
  if (!record) return true;
  const accountId = textValue(record.accountId, 200);
  const peerKind = textValue(record.peerKind ?? record.chatType, 50);
  const peerId = textValue(record.peerId, 300);
  return (!accountId || accountId === scope.accountId)
    && (!peerKind || peerKind === scopePeerKind(scope))
    && (!peerId || peerId.toLowerCase() === scope.peerId.toLowerCase());
}

function collectMemoryRecords(
  file: string | undefined,
  scope: LegacyMigrationScope,
): LegacyMigrationRecord[] {
  const parsed = readJson(file) as {
    memories?: Record<string, unknown>;
  } | undefined;
  if (!parsed?.memories || !file) return [];
  return Object.entries(parsed.memories).flatMap(([id, item]) => {
    if (!matchesScope(item, scope)) return [];
    const record = objectRecord(item);
    const preferredText = record ? textValue(record.text) : "";
    const legacyType = record ? textValue(record.type, 100) || "unknown" : "unknown";
    const source = record?.source;
    const sourceContent = canonicalSourceContent(item);
    return [{
      sourceKind: "memory" as const,
      sourcePath: file,
      sourceRecordId: `memory:${id}`,
      sourceContent,
      legacyId: id,
      actor: actorFromLegacySource(source),
      text: modelText(item, preferredText),
      occurredAt: timestampValue(record?.createdAt ?? record?.updatedAt),
      metadata: {
        legacyRecord: item,
        legacyStatus: record?.status,
        legacySource: source,
      },
      auditedNonImport: !record
        ? auditedNonImport("unsupported_record_shape")
        : preferredText
          ? undefined
          : auditedNonImport("no_supported_text"),
      provisional: preferredText ? {
        legacyType,
        topLevelType: legacyTopLevelType(legacyType),
        epistemicStatus: source === "user_explicit" ? "explicit" as const : "inferred" as const,
      } : undefined,
    }];
  });
}

function collectClaimRecords(
  file: string | undefined,
  scope: LegacyMigrationScope,
): LegacyMigrationRecord[] {
  if (!file) return [];
  return readJsonLines(file).flatMap(({ value, lineNumber }) => {
    if (!matchesScope(value, scope)) return [];
    const claim = objectRecord(value);
    const preferredText = claim
      ? textValue(claim.value ?? claim.text ?? claim.canonicalText)
      : "";
    const legacyId = claim
      ? textValue(claim.id ?? claim.claimId, 200) || `line-${lineNumber}`
      : `line-${lineNumber}`;
    const memoryType = claim
      ? textValue(claim.memoryType ?? claim.type, 100) || "claim"
      : "claim";
    const sourceContent = canonicalSourceContent(value);
    return [{
      sourceKind: "claim" as const,
      sourcePath: file,
      sourceRecordId: `claim:line-${lineNumber}`,
      sourceContent,
      legacyId,
      actor: actorFromLegacySource(
        claim?.actor ?? claim?.role ?? claim?.sourceKind ?? claim?.source,
      ),
      text: modelText(value, preferredText),
      occurredAt: timestampValue(
        claim?.observedAt ?? claim?.createdAt ?? claim?.updatedAt,
      ),
      metadata: { legacyClaim: value },
      auditedNonImport: value === null
        ? auditedNonImport("empty_record")
        : !claim
          ? auditedNonImport("unsupported_record_shape")
          : preferredText
            ? undefined
            : auditedNonImport("no_supported_text"),
      provisional: preferredText ? {
        legacyType: memoryType,
        topLevelType: legacyTopLevelType(memoryType),
        epistemicStatus: claim?.sourceKind === "user_explicit"
          ? "explicit" as const
          : "inferred" as const,
      } : undefined,
    }];
  });
}

function collectSnapshotRecord(
  file: string | undefined,
  sourceKind: "state" | "digest",
): LegacyMigrationRecord[] {
  const value = readJson(file);
  if (!file || value === undefined) return [];
  const sourceContent = canonicalSourceContent(value);
  return [{
    sourceKind,
    sourcePath: file,
    sourceRecordId: `${sourceKind}:snapshot`,
    sourceContent,
    legacyId: path.basename(file),
    actor: "system",
    text: modelText(value),
    occurredAt: fs.statSync(file).mtimeMs,
    metadata: {
      snapshot: value,
      migrationRole: sourceKind === "state"
        ? "relationship_commitment_scene_projection"
        : "conversation_digest_projection",
    },
    auditedNonImport: value === null
      ? auditedNonImport("empty_record")
      : undefined,
  }];
}

function inferRefActor(record: Record<string, unknown>, scope: LegacyMigrationScope): MemoryActor {
  if (record.isBot === true || record.role === "assistant" || record.direction === "outbound") return "asuka";
  if (record.role === "user" || record.direction === "inbound") return "user";
  const senderId = textValue(record.senderId, 300);
  return senderId && senderId.toLowerCase() === scope.peerId.toLowerCase() ? "user" : "system";
}

function collectRefIndexRecords(
  file: string | undefined,
  scope: LegacyMigrationScope,
): LegacyMigrationRecord[] {
  if (!file) return [];
  return readJsonLines(file).flatMap(({ value, lineNumber }) => {
    if (!matchesScope(value, scope)) return [];
    const record = objectRecord(value);
    const text = record
      ? textValue(record.content ?? record.text ?? record.summary)
      : "";
    const attachments = Array.isArray(record?.attachments) ? record.attachments : [];
    const attachmentText = attachments
      .map((attachment) => textValue(attachment, 1_000))
      .filter(Boolean)
      .join(" ");
    const combined = textValue([text, attachmentText].filter(Boolean).join(" "));
    const sourceContent = canonicalSourceContent(value);
    return [{
      sourceKind: "ref_index" as const,
      sourcePath: file,
      sourceRecordId: `ref_index:line-${lineNumber}`,
      sourceContent,
      legacyId: record
        ? textValue(record.msgIdx ?? record.id, 300) || `line-${lineNumber}`
        : `line-${lineNumber}`,
      actor: record ? inferRefActor(record, scope) : "system",
      text: modelText(value, combined),
      occurredAt: timestampValue(record?.timestamp),
      metadata: { legacyRefIndex: value },
      auditedNonImport: value === null
        ? auditedNonImport("empty_record")
        : !record
          ? auditedNonImport("unsupported_record_shape")
          : combined
            ? undefined
            : auditedNonImport("no_supported_text"),
    }];
  });
}

function sessionText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return textValue(message.content);
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const item = part as Record<string, unknown>;
      return item.type === "text" ? [textValue(item.text)] : [];
    })
    .filter(Boolean)
    .join(" ");
}

function qqDirectSessionIds(
  indexFile: string | undefined,
  scope: LegacyMigrationScope,
): string[] {
  const parsed = readJson(indexFile);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.includes(`:qqbot:${scopePeerKind(scope)}:`)) continue;
    if (!key.toLowerCase().endsWith(`:${scope.peerId.toLowerCase()}`)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const session = value as Record<string, unknown>;
    if (!matchesScope(session, scope)) continue;
    const sessionId = textValue(session.sessionId, 200);
    if (sessionId) ids.push(sessionId);
  }
  return [...new Set(ids)];
}

function collectSessionRecords(
  indexFile: string | undefined,
  sessionsDirectory: string | undefined,
  scope: LegacyMigrationScope,
): LegacyMigrationRecord[] {
  if (!sessionsDirectory) return [];
  if (!fs.existsSync(sessionsDirectory)) {
    throw new Error(`legacy sessions directory does not exist: ${sessionsDirectory}`);
  }
  const sessionIds = qqDirectSessionIds(indexFile, scope);
  const records: LegacyMigrationRecord[] = [];
  for (const sessionId of sessionIds) {
    const file = path.join(sessionsDirectory, `${sessionId}.jsonl`);
    for (const { value, lineNumber } of readJsonLines(file)) {
      const row = objectRecord(value);
      const message = row?.type === "message"
        ? objectRecord(row.message)
        : undefined;
      const role = message?.role;
      const preferredText = message ? sessionText(message) : "";
      const sourceContent = canonicalSourceContent(value);
      const internalSystemRecord = /^\[(?:cron|system):/i.test(preferredText);
      records.push({
        sourceKind: "session",
        sourcePath: file,
        sourceRecordId: `${sessionId}:line-${lineNumber}`,
        sourceContent,
        legacyId: row
          ? textValue(row.id, 200) || `${sessionId}:${lineNumber}`
          : `${sessionId}:${lineNumber}`,
        actor: role === "assistant" ? "asuka" : role === "user" ? "user" : "system",
        text: modelText(value, preferredText),
        occurredAt: timestampValue(message?.timestamp ?? row?.timestamp),
        metadata: {
          legacyRecord: value,
          sessionId,
          sourceLine: lineNumber,
          messageId: row?.id,
          role,
        },
        auditedNonImport: internalSystemRecord
          ? auditedNonImport("filtered_system_record")
          : !message || (role !== "user" && role !== "assistant")
            ? auditedNonImport("unsupported_session_record")
            : preferredText
              ? undefined
              : auditedNonImport("no_supported_text"),
      });
    }
  }
  return records;
}

export function collectLegacyMigrationRecords(
  sources: LegacyMigrationSources,
  scope: LegacyMigrationScope,
): LegacyMigrationRecord[] {
  return [
    ...collectMemoryRecords(sources.memoryJson, scope),
    ...collectClaimRecords(sources.claimsJsonl, scope),
    ...collectSnapshotRecord(sources.stateJson, "state"),
    ...collectSnapshotRecord(sources.digestJson, "digest"),
    ...collectRefIndexRecords(sources.refIndexJsonl, scope),
    ...collectSessionRecords(
      sources.sessionsIndexJson,
      sources.sessionsDirectory,
      scope,
    ),
  ];
}

function eventInputForRecord(
  record: LegacyMigrationRecord,
  scope: LegacyMigrationScope,
): MemoryEventInput {
  const contentHash = legacyContentHash(record);
  const physicalRecordId = sourceRecordId(record);
  const boundedText = textValue(record.text);
  return {
    accountId: scope.accountId,
    peerKind: scopePeerKind(scope),
    peerId: scope.peerId,
    identityId: scope.identityId,
    actor: record.actor,
    kind: "legacy_import",
    text: boundedText,
    occurredAt: record.occurredAt,
    sourceId: `${record.sourceKind}:${physicalRecordId}`,
    dedupeKey: `legacy:${JSON.stringify([
      scope.accountId,
      scopePeerKind(scope),
      scope.peerId,
      record.sourceKind,
      physicalRecordId,
    ])}`,
    evidence: {
      excerpt: boundedText.slice(0, 2_000),
      sourcePath: record.sourcePath,
      mediaType: "text",
    },
    metadata: {
      ...record.metadata,
      legacySourceKind: record.sourceKind,
      legacyId: record.legacyId,
      legacySourceRecordId: physicalRecordId,
      legacyContentHash: contentHash,
      legacyAuditedNonImport: record.auditedNonImport,
      provisional: record.provisional,
    },
  };
}

export function migrateLegacyRecords(
  engine: AsukaMemoryEngine,
  records: LegacyMigrationRecord[],
  scope: LegacyMigrationScope,
): LegacyMigrationReport {
  const sourceCounts: LegacyMigrationReport["sourceCounts"] = {
    memory: 0,
    claim: 0,
    state: 0,
    digest: 0,
    ref_index: 0,
    session: 0,
  };
  const report: LegacyMigrationReport = {
    generatedAt: new Date().toISOString(),
    sourceCounts,
    discoveredRecords: records.length,
    importedEvents: 0,
    duplicateEvents: 0,
    provisionalCandidates: 0,
    pendingRejudgements: 0,
    auditedNonImportRecords: 0,
    skippedRecords: 0,
    sourceMap: [],
  };
  for (const record of records) {
    sourceCounts[record.sourceKind] += 1;
    const input = eventInputForRecord(record, scope);
    try {
      const result = engine.ingestMemoryEvent(input, {
        enqueue: record.auditedNonImport ? false : undefined,
        jobKind: "legacy_rejudge",
      });
      if (!result.receipt) {
        report.skippedRecords += 1;
        report.sourceMap.push({
          ...sourceMapBase(record, input.metadata?.legacyContentHash as string),
          status: "skipped",
          reason: result.reason ?? "missing_receipt",
        });
        continue;
      }
      if (result.receipt.inserted) report.importedEvents += 1;
      else {
        const storedHash = storedLegacyContentHash(
          engine.ledger.getEvent(result.receipt.eventId),
        );
        const incomingHash = input.metadata?.legacyContentHash;
        if (storedHash !== incomingHash) {
          throw new LegacyContentHashMismatchError(
            `legacy content hash mismatch for ${record.sourceKind}:${record.legacyId}`,
          );
        }
        report.duplicateEvents += 1;
      }
      if (record.auditedNonImport) {
        report.auditedNonImportRecords += 1;
        report.sourceMap.push({
          ...sourceMapBase(record, input.metadata?.legacyContentHash as string),
          eventId: result.receipt.eventId,
          status: "audited_non_import",
          reason: record.auditedNonImport.reason,
        });
        continue;
      }
      report.pendingRejudgements += result.accepted && result.receipt.inserted ? 1 : 0;
      let claimId: string | undefined;
      if (record.provisional && result.accepted && result.receipt.inserted) {
        const candidate = engine.ledger.applyClaimProposal(result.receipt.eventId, {
          subjectId: record.actor,
          predicate: `legacy.${record.provisional.legacyType.replace(/[^a-zA-Z0-9_.-]+/g, "_")}`,
          value: record.text,
          canonicalText: record.text,
          topLevelType: record.provisional.topLevelType,
          epistemicStatus: record.provisional.epistemicStatus,
          authority: "summary",
          confidence: 0.2,
          supportingEventIds: [result.receipt.eventId],
          topic: "migration-pending",
          metadata: {
            migrationPendingRejudge: true,
            legacyType: record.provisional.legacyType,
            legacyId: record.legacyId,
          },
        });
        claimId = candidate.claimId;
        if (claimId) report.provisionalCandidates += 1;
      }
      report.sourceMap.push({
        ...sourceMapBase(record, input.metadata?.legacyContentHash as string),
        eventId: result.receipt.eventId,
        claimId,
        status: result.receipt.inserted ? "imported" : "duplicate",
      });
    } catch (error) {
      if (error instanceof LegacyContentHashMismatchError) throw error;
      report.skippedRecords += 1;
      report.sourceMap.push({
        ...sourceMapBase(record, input.metadata?.legacyContentHash as string),
        status: "skipped",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

export function getLegacyRejudgementGate(
  engine: AsukaMemoryEngine,
): LegacyRejudgementGate {
  const events = engine.ledger.listEvents()
    .filter((event) => event.kind === "legacy_import");
  const eligibleEvents = events
    .filter((event) =>
      event.metadata.secretRedacted !== true
      && !isAuditedNonImport(event.metadata.legacyAuditedNonImport)
    );
  const eligibleEventIds = new Set(eligibleEvents.map((event) => event.eventId));
  const jobs = engine.ledger.listJobs()
    .filter((job) =>
      job.kind === "legacy_rejudge"
      && eligibleEventIds.has(job.eventId)
    );
  const trackedEventIds = new Set(jobs.map((job) => job.eventId));
  const eventIds = new Set(events.map((event) => event.eventId));
  const extractions = engine.ledger.listLegacyExtractions()
    .filter((extraction) => eligibleEventIds.has(extraction.eventId));
  const claims = engine.ledger.listClaims()
    .filter((claim) => eventIds.has(claim.sourceEventId));
  const provisionalOpen = claims.filter((claim) =>
    claim.state === "candidate"
    && (
      claim.metadata.migrationPendingRejudge === true
      || claim.metadata.migrationPendingConsolidation === true
    )
  ).length;
  const adjudicatedClaims = claims.filter((claim) =>
    claim.metadata.migrationPendingRejudge !== true
    && claim.metadata.migrationPendingConsolidation !== true
  );
  const statusCount = (status: "pending" | "running" | "completed" | "failed"): number =>
    jobs.filter((job) => job.status === status).length;
  const untracked = eligibleEvents.filter((event) => !trackedEventIds.has(event.eventId)).length;
  const pending = statusCount("pending");
  const running = statusCount("running");
  const failed = statusCount("failed");
  const completed = statusCount("completed");
  const extractionWithClaims = extractions
    .filter((extraction) => extraction.disposition === "claims").length;
  const extractionNoMemory = extractions
    .filter((extraction) => extraction.disposition === "no_memory").length;
  const jobsSettled = untracked === 0
    && pending === 0
    && running === 0
    && failed === 0
    && completed === eligibleEvents.length
    && extractions.length === eligibleEvents.length;
  const extractionGroups = new Map<string, typeof extractions>();
  for (const extraction of extractions) {
    const key = JSON.stringify([extraction.identityId, extraction.visibility]);
    const group = extractionGroups.get(key) ?? [];
    group.push(extraction);
    extractionGroups.set(key, group);
  }
  const applicableRuns = [...extractionGroups.values()].flatMap((group) => {
    const candidateIds = group.flatMap((extraction) => extraction.candidateClaimIds);
    if (candidateIds.length === 0) return [];
    const { identityId, visibility } = group[0];
    const run = engine.ledger.getLegacyConsolidationRun(
      identityId,
      visibility,
      legacyConsolidationInputHash(identityId, visibility, candidateIds),
    );
    return run ? [run] : [];
  });
  const candidateCount = extractions.reduce(
    (total, extraction) => total + extraction.candidateClaimIds.length,
    0,
  );
  const requiredGroupCount = [...extractionGroups.values()]
    .filter((group) => group.some((extraction) => extraction.candidateClaimIds.length > 0))
    .length;
  let consolidationStatus: LegacyRejudgementGate["consolidation"]["status"] = "not_started";
  if (jobsSettled && candidateCount === 0) {
    consolidationStatus = "not_required";
  } else if (jobsSettled && applicableRuns.some((run) => run.status === "failed")) {
    consolidationStatus = "failed";
  } else if (jobsSettled && applicableRuns.some((run) => run.status === "running")) {
    consolidationStatus = "running";
  } else if (
    jobsSettled
    && requiredGroupCount > 0
    && applicableRuns.length === requiredGroupCount
    && applicableRuns.every((run) => run.status === "completed")
  ) {
    consolidationStatus = "completed";
  }
  const coveredSourceEvents = jobsSettled
    ? [...extractionGroups.values()].reduce((total, group) => {
        const groupCandidateCount = group.reduce(
          (sum, extraction) => sum + extraction.candidateClaimIds.length,
          0,
        );
        if (groupCandidateCount === 0) return total + group.length;
        const run = applicableRuns.find((candidate) =>
          candidate.identityId === group[0].identityId
          && candidate.visibility === group[0].visibility
          && candidate.status === "completed"
        );
        return total + (run?.coveredSourceEventCount ?? 0);
      }, 0)
    : 0;
  const blockers: string[] = [];
  if (untracked > 0) blockers.push(`${untracked} eligible legacy event(s) have no rejudgement job`);
  if (pending > 0) blockers.push(`${pending} legacy rejudgement job(s) are pending`);
  if (running > 0) blockers.push(`${running} legacy rejudgement job(s) are running`);
  if (failed > 0) blockers.push(`${failed} legacy rejudgement job(s) failed`);
  if (completed > extractions.length) {
    blockers.push(`${completed - extractions.length} completed legacy extraction job(s) have no disposition`);
  }
  if (jobsSettled && candidateCount > 0 && consolidationStatus !== "completed") {
    const failedRuns = applicableRuns.filter((run) => run.status === "failed");
    if (failedRuns.length > 0) {
      blockers.push(
        ...failedRuns.map((run) =>
          `legacy consolidation failed: ${run.error ?? "unknown error"}`
        ),
      );
    } else if (consolidationStatus === "running") {
      blockers.push("legacy consolidation is still running");
    } else {
      blockers.push("legacy consolidation has not started for every extraction scope");
    }
  }
  for (const run of applicableRuns.filter((candidate) => candidate.status === "completed")) {
    const group = extractionGroups.get(
      JSON.stringify([run.identityId, run.visibility]),
    ) ?? [];
    const expectedCandidateIds = group.flatMap((extraction) =>
      extraction.candidateClaimIds
    );
    const expectedCandidateSet = new Set(expectedCandidateIds);
    const outputCandidateIds: string[] = [];
    const coveredSourceEventIds = new Set(
      group
        .filter((extraction) => extraction.candidateClaimIds.length === 0)
        .map((extraction) => extraction.eventId),
    );
    if (
      run.inputCandidateCount !== expectedCandidateIds.length
      || run.sourceEventCount !== group.length
      || run.coveredCandidateCount !== expectedCandidateIds.length
      || run.coveredSourceEventCount !== group.length
    ) {
      blockers.push("legacy consolidation coverage does not match its extraction input");
    }

    const candidateEvidence = new Map<string, string[]>();
    for (const candidateId of expectedCandidateIds) {
      const candidate = engine.ledger.getClaim(candidateId);
      if (!candidate) {
        blockers.push(`legacy consolidation source candidate ${candidateId} is missing`);
        continue;
      }
      if (
        candidate.identityId !== run.identityId
        || candidate.visibility !== run.visibility
      ) {
        blockers.push(`legacy consolidation source candidate ${candidateId} has invalid scope`);
        continue;
      }
      if (candidate.state !== "refuted") {
        blockers.push(
          `legacy consolidation source candidate ${candidateId} has invalid state ${candidate.state}`,
        );
      }
      const eventIds = engine.ledger.listClaimEvidence(candidateId, "supports")
        .map((link) => link.eventId);
      if (eventIds.length === 0) {
        blockers.push(`legacy consolidation source candidate ${candidateId} has no evidence`);
        continue;
      }
      for (const eventId of eventIds) {
        const event = engine.ledger.getEvent(eventId);
        if (
          !event
          || event.kind !== "legacy_import"
          || event.identityId !== run.identityId
          || event.visibility !== run.visibility
        ) {
          blockers.push(`legacy consolidation source candidate ${candidateId} has invalid evidence`);
          continue;
        }
        coveredSourceEventIds.add(eventId);
      }
      candidateEvidence.set(candidateId, [...new Set(eventIds)].sort());
    }

    for (const claimId of run.outputClaimIds) {
      const claim = engine.ledger.getClaim(claimId);
      if (!claim) {
        blockers.push(`legacy consolidation output claim ${claimId} is missing`);
        continue;
      }
      if (
        claim.identityId !== run.identityId
        || claim.visibility !== run.visibility
      ) {
        blockers.push(`legacy consolidation output claim ${claimId} has invalid scope`);
      }
      if (claim.metadata.legacyConsolidationRunId !== run.runId) {
        blockers.push(`legacy consolidation output claim ${claimId} has the wrong run ID`);
      }
      if (
        claim.state !== "active"
        && claim.state !== "candidate"
        && claim.state !== "superseded"
      ) {
        blockers.push(`legacy consolidation output claim ${claimId} has invalid state ${claim.state}`);
      }
      if (
        claim.metadata.migrationPendingRejudge === true
        || claim.metadata.migrationPendingConsolidation === true
      ) {
        blockers.push(`legacy consolidation output claim ${claimId} is still migration-pending`);
      }
      if (!claim.semanticKey.trim()) {
        blockers.push(`legacy consolidation output claim ${claimId} has no semantic key`);
      }
      const sourceCandidateIds = Array.isArray(claim.metadata.sourceCandidateIds)
        ? claim.metadata.sourceCandidateIds.filter(
          (candidateId): candidateId is string => typeof candidateId === "string",
        )
        : [];
      if (
        sourceCandidateIds.length === 0
        || sourceCandidateIds.some((candidateId) => !expectedCandidateSet.has(candidateId))
      ) {
        blockers.push(`legacy consolidation output claim ${claimId} has invalid source candidates`);
      }
      outputCandidateIds.push(...sourceCandidateIds);

      const supportLinks = engine.ledger.listClaimEvidence(claimId, "supports");
      const opposeLinks = engine.ledger.listClaimEvidence(claimId, "opposes");
      const allLinks = engine.ledger.listClaimEvidence(claimId);
      const expectedSupportIds = [...new Set(sourceCandidateIds.flatMap((candidateId) =>
        candidateEvidence.get(candidateId) ?? []
      ))].sort();
      const actualSupportIds = [...new Set(supportLinks.map((link) => link.eventId))].sort();
      if (
        expectedSupportIds.length !== actualSupportIds.length
        || expectedSupportIds.some((eventId, index) => eventId !== actualSupportIds[index])
        || !actualSupportIds.includes(claim.sourceEventId)
        || claim.supportingEvidenceCount !== supportLinks.length
        || claim.opposingEvidenceCount !== opposeLinks.length
        || allLinks.length !== supportLinks.length + opposeLinks.length
      ) {
        blockers.push(`legacy consolidation output claim ${claimId} has invalid evidence links`);
      }
      for (const link of [...supportLinks, ...opposeLinks]) {
        const event = engine.ledger.getEvent(link.eventId);
        if (
          !event
          || event.identityId !== run.identityId
          || event.visibility !== run.visibility
        ) {
          blockers.push(`legacy consolidation output claim ${claimId} has cross-scope evidence`);
        }
      }
    }

    const auditDiscards = Array.isArray(run.audit.discarded)
      ? run.audit.discarded
      : [];
    const auditedDiscardIds: string[] = [];
    for (const raw of auditDiscards) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        blockers.push("legacy consolidation discard audit is malformed");
        continue;
      }
      const item = raw as Record<string, unknown>;
      const sourceCandidateIds = Array.isArray(item.sourceCandidateIds)
        ? item.sourceCandidateIds.filter(
          (candidateId): candidateId is string => typeof candidateId === "string",
        )
        : [];
      if (
        sourceCandidateIds.length === 0
        || typeof item.reason !== "string"
        || !item.reason.trim()
      ) {
        blockers.push("legacy consolidation discard audit lacks exact coverage or reason");
      }
      auditedDiscardIds.push(...sourceCandidateIds);
    }
    const sortedAuditedDiscardIds = [...auditedDiscardIds].sort();
    const sortedStoredDiscardIds = [...run.discardedCandidateIds].sort();
    if (
      sortedAuditedDiscardIds.length !== sortedStoredDiscardIds.length
      || sortedAuditedDiscardIds.some(
        (candidateId, index) => candidateId !== sortedStoredDiscardIds[index],
      )
    ) {
      blockers.push("legacy consolidation discard audit does not match stored coverage");
    }
    const coveredCandidateIds = [
      ...outputCandidateIds,
      ...run.discardedCandidateIds,
    ];
    if (
      coveredCandidateIds.length !== expectedCandidateIds.length
      || new Set(coveredCandidateIds).size !== coveredCandidateIds.length
      || coveredCandidateIds.some((candidateId) => !expectedCandidateSet.has(candidateId))
    ) {
      blockers.push("legacy consolidation candidate coverage is incomplete or duplicated");
    }
    const expectedSourceEventIds = [...new Set(group.map((extraction) => extraction.eventId))]
      .sort();
    const actualSourceEventIds = [...coveredSourceEventIds].sort();
    if (
      expectedSourceEventIds.length !== actualSourceEventIds.length
      || expectedSourceEventIds.some(
        (eventId, index) => eventId !== actualSourceEventIds[index],
      )
    ) {
      blockers.push("legacy consolidation source event coverage is incomplete");
    }
    if (
      run.coveredCandidateCount !== run.inputCandidateCount
      || run.coveredSourceEventCount !== run.sourceEventCount
    ) {
      blockers.push("legacy consolidation coverage does not match its extraction input");
    }
  }
  if (jobsSettled && coveredSourceEvents !== eligibleEvents.length) {
    blockers.push(
      `legacy consolidation covered ${coveredSourceEvents} of ${eligibleEvents.length} source event(s)`,
    );
  }
  if (provisionalOpen > 0) {
    blockers.push(`${provisionalOpen} provisional migration claim(s) remain open`);
  }
  return {
    passed: blockers.length === 0,
    blockers,
    events: {
      total: events.length,
      eligible: eligibleEvents.length,
      untracked,
    },
    jobs: {
      total: jobs.length,
      pending,
      running,
      completed,
      failed,
      attempts: jobs.reduce((total, job) => total + job.attempts, 0),
    },
    extractions: {
      completed: extractions.length,
      withClaims: extractionWithClaims,
      noMemory: extractionNoMemory,
    },
    consolidation: {
      status: consolidationStatus,
      runs: applicableRuns.length,
      outputClaims: applicableRuns.reduce(
        (total, run) => total + run.outputClaimIds.length,
        0,
      ),
    },
    coverage: {
      sourceEvents: eligibleEvents.length,
      coveredSourceEvents,
    },
    claims: {
      provisionalOpen,
      active: adjudicatedClaims.filter((claim) => claim.state === "active").length,
      candidate: adjudicatedClaims.filter((claim) => claim.state === "candidate").length,
      historical: adjudicatedClaims.filter((claim) =>
        claim.state === "superseded"
        || claim.state === "refuted"
        || claim.state === "forgotten"
      ).length,
      versionRoots: new Set(adjudicatedClaims.map((claim) => claim.rootClaimId)).size,
    },
  };
}

function reconcileCompletedLegacyCandidates(engine: AsukaMemoryEngine): number {
  const completedEventIds = new Set(engine.ledger.listJobs("completed")
    .filter((job) => job.kind === "legacy_rejudge")
    .map((job) => job.eventId));
  if (completedEventIds.size === 0) return 0;
  const claims = engine.ledger.listClaims();
  let reconciled = 0;
  for (const eventId of completedEventIds) {
    const hasAdjudicatedClaim = claims.some((claim) =>
      claim.sourceEventId === eventId
      && claim.metadata.migrationPendingRejudge !== true
      && claim.metadata.migrationPendingConsolidation !== true
    );
    reconciled += engine.ledger.settleLegacyMigrationCandidates(
      eventId,
      hasAdjudicatedClaim ? "superseded" : "refuted",
    ).length;
  }
  return reconciled;
}

export async function executeLegacyRejudgements(
  engine: AsukaMemoryEngine,
  options: LegacyRejudgementExecutionOptions = {},
): Promise<LegacyRejudgementExecutionReport> {
  const startedAt = new Date();
  const batchSize = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? 25)));
  const maxBatches = Math.max(
    1,
    Math.min(1_000_000, Math.floor(options.maxBatches ?? 1_000_000)),
  );
  const gateBefore = getLegacyRejudgementGate(engine);
  const retriedFailedJobs = options.retryFailed
    ? engine.ledger.retryFailedJobs("legacy_rejudge")
    : 0;
  const reconciledProvisionalClaims = reconcileCompletedLegacyCandidates(engine);
  const batchResults: MemoryJobBatchResult[] = [];
  let processed = 0;
  let completed = 0;
  let failed = 0;
  while (batchResults.length < maxBatches) {
    const result = await engine.processPendingMemoryJobs({
      maxJobs: batchSize,
      kinds: ["legacy_rejudge"],
      retryDelayMs: options.retryDelayMs,
    });
    if (result.processed === 0) break;
    batchResults.push(result);
    processed += result.processed;
    completed += result.completed;
    failed += result.failed;
  }
  const extractionGate = getLegacyRejudgementGate(engine);
  const allExtractionsCompleted = extractionGate.events.untracked === 0
    && extractionGate.jobs.pending === 0
    && extractionGate.jobs.running === 0
    && extractionGate.jobs.failed === 0
    && extractionGate.jobs.completed === extractionGate.events.eligible
    && extractionGate.extractions.completed === extractionGate.events.eligible;
  if (allExtractionsCompleted && extractionGate.extractions.withClaims > 0) {
    await engine.consolidateLegacyExtractions();
  }
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    batchSize,
    batches: batchResults.length,
    retriedFailedJobs,
    reconciledProvisionalClaims,
    processed,
    completed,
    failed,
    batchResults,
    gateBefore,
    gateAfter: getLegacyRejudgementGate(engine),
  };
}
