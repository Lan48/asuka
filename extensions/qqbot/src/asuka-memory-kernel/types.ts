export type MemoryPeerKind = "direct" | "group";
export type MemoryVisibility = "private" | "public";
export type MemoryActor = "user" | "asuka" | "system";

export type MemoryEventKind =
  | "user_message"
  | "assistant_reply"
  | "proactive_message"
  | "media_summary"
  | "human_override"
  | "memory_control"
  | "legacy_import"
  | "reflection";

export type MemoryTopLevelType =
  | "fact"
  | "event"
  | "belief"
  | "self_narrative"
  | "working_memory"
  | "procedural";

export type MemoryEpistemicStatus = "explicit" | "inferred";
export type MemoryClaimState =
  | "candidate"
  | "active"
  | "superseded"
  | "refuted"
  | "forgotten";

export type MemoryAuthority =
  | "human_override"
  | "user_correction"
  | "user_explicit"
  | "mutual_agreement"
  | "observed_pattern"
  | "inferred"
  | "summary";

export type EvidenceStance = "supports" | "opposes" | "neutral" | "ignored";
export type MemoryJobKind = "adjudicate" | "legacy_rejudge" | "reflect" | "embed";
export type MemoryJobStatus = "pending" | "running" | "completed" | "failed";

export interface MemoryEvidencePayload {
  excerpt?: string;
  transcript?: string;
  imageSummary?: string;
  mediaType?: "text" | "voice" | "image" | "mixed";
  sourcePath?: string;
  [key: string]: unknown;
}

export interface MemoryEventInput {
  accountId: string;
  peerKind: MemoryPeerKind;
  peerId: string;
  actor: MemoryActor;
  kind: MemoryEventKind;
  text: string;
  occurredAt?: number;
  sourceId?: string;
  sourceMessageId?: string;
  identityId?: string;
  visibility?: MemoryVisibility;
  evidence?: MemoryEvidencePayload;
  metadata?: Record<string, unknown>;
  generatedFromClaimIds?: string[];
  dedupeKey?: string;
}

export interface MemoryEvent extends Required<Pick<
  MemoryEventInput,
  "accountId" | "peerKind" | "peerId" | "actor" | "kind" | "text"
>> {
  eventId: string;
  identityId: string;
  visibility: MemoryVisibility;
  occurredAt: number;
  recordedAt: number;
  sourceId?: string;
  sourceMessageId?: string;
  evidence: MemoryEvidencePayload;
  metadata: Record<string, unknown>;
  generatedFromClaimIds: string[];
  dedupeKey: string;
}

export interface MemoryEventReceipt {
  eventId: string;
  identityId: string;
  inserted: boolean;
}

export interface MemoryIngestResult {
  accepted: boolean;
  redacted: boolean;
  receipt?: MemoryEventReceipt;
  reason?: string;
}

export interface IdentityLinkInput {
  identityId: string;
  accountId: string;
  peerKind: MemoryPeerKind;
  peerId: string;
  visibility?: MemoryVisibility;
}

export interface ClaimProposal {
  semanticKey?: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  canonicalText: string;
  topLevelType: MemoryTopLevelType;
  epistemicStatus: MemoryEpistemicStatus;
  authority: MemoryAuthority;
  confidence: number;
  action?: "add" | "revise" | "refute" | "forget" | "delete";
  targetClaimId?: string;
  validFrom?: number;
  validTo?: number;
  topic?: string;
  entityIds?: string[];
  supportingEventIds?: string[];
  opposingEventIds?: string[];
  lifecycle?: "stable" | "bounded" | "episodic" | "working";
  metadata?: Record<string, unknown>;
}

export interface MemoryClaim {
  claimId: string;
  rootClaimId: string;
  identityId: string;
  semanticKey: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  canonicalText: string;
  topLevelType: MemoryTopLevelType;
  epistemicStatus: MemoryEpistemicStatus;
  authority: MemoryAuthority;
  confidence: number;
  state: MemoryClaimState;
  visibility: MemoryVisibility;
  validFrom?: number;
  validTo?: number;
  topic?: string;
  entityIds: string[];
  supersedesClaimId?: string;
  sourceEventId: string;
  supportingEvidenceCount: number;
  opposingEvidenceCount: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface ApplyClaimResult {
  claimId?: string;
  rootClaimId?: string;
  state?: MemoryClaimState;
  deletedClaimIds?: string[];
  ignoredReason?: string;
}

export interface MemoryJudgement {
  eventId: string;
  proposals: ClaimProposal[];
  noMemoryReason?: string;
  modelRunId?: string;
}

export interface LegacyExtraction {
  eventId: string;
  identityId: string;
  visibility: MemoryVisibility;
  disposition: "claims" | "no_memory";
  candidateClaimIds: string[];
  noMemoryReason?: string;
  extractedAt: number;
  updatedAt: number;
}

export interface LegacyConsolidationClaim {
  semanticKey: string;
  sourceCandidateIds: string[];
  subjectId: string;
  predicate: string;
  value: unknown;
  canonicalText: string;
  topLevelType: MemoryTopLevelType;
  epistemicStatus: MemoryEpistemicStatus;
  confidence: number;
  validFrom?: number;
  validTo?: number;
  topic?: string;
  entityIds: string[];
  lifecycle?: "stable" | "bounded" | "episodic" | "working";
  supportingEventIds: string[];
  opposingEventIds: string[];
}

export interface LegacyConsolidationDiscard {
  sourceCandidateIds: string[];
  reason: string;
}

export type LegacyConsolidationStatus = "running" | "completed" | "failed";

export interface LegacyConsolidationRun {
  runId: string;
  identityId: string;
  visibility: MemoryVisibility;
  inputHash: string;
  status: LegacyConsolidationStatus;
  inputCandidateCount: number;
  coveredCandidateCount: number;
  sourceEventCount: number;
  coveredSourceEventCount: number;
  outputClaimIds: string[];
  discardedCandidateIds: string[];
  audit: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryJob {
  jobId: string;
  eventId: string;
  kind: MemoryJobKind;
  status: MemoryJobStatus;
  attempts: number;
  availableAt: number;
  leaseUntil?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchCandidate {
  claim: MemoryClaim;
  lexicalScore: number;
  vectorScore: number;
  recencyScore: number;
  authorityScore: number;
  localScore: number;
}

export interface MemoryRetrievalRequest {
  accountId: string;
  peerKind: MemoryPeerKind;
  peerId: string;
  query: string;
  identityId?: string;
  now?: number;
  maxCandidates?: number;
  maxPromptChars?: number;
  includeCandidates?: boolean;
}

export interface MemoryContextResult {
  prompt: string;
  claims: MemoryClaim[];
  claimIds: string[];
  sourceEventIds: string[];
  usedFallback: boolean;
  rerankRunId?: string;
  elapsedMs: number;
}

export interface MemoryJobBatchResult {
  processed: number;
  completed: number;
  failed: number;
  remaining: number;
}

export interface MemoryModelRequest {
  task:
    | "adjudicate"
    | "rerank"
    | "reflect"
    | "normalize"
    | "legacy_extract"
    | "legacy_consolidate";
  prompt: string;
  timeoutMs: number;
  schemaVersion: number;
  maxTokens?: number;
}

export interface MemoryModelAdapter {
  complete(request: MemoryModelRequest): Promise<string>;
  embed?(texts: string[], timeoutMs: number): Promise<{
    model: string;
    dimensions: number;
    vectors: number[][];
  }>;
}

export interface MemoryEngineOptions {
  judgementTimeoutMs?: number;
  rerankDeadlineMs?: number;
  rerankTaskTimeoutMs?: number;
  inferencePromotionConfidence?: number;
  maxJobAttempts?: number;
  legacyExtractionMaxInputChars?: number;
  legacyExtractionMaxProposals?: number;
  legacyExtractionMaxTokens?: number;
  legacyConsolidationMaxInputChars?: number;
  legacyConsolidationMaxClaimsPerBatch?: number;
  legacyConsolidationMaxTokens?: number;
  model?: MemoryModelAdapter;
  onProjectionChanged?: () => void;
}

export interface MemoryProjectionEventSummary {
  eventId: string;
  identityId: string;
  visibility: MemoryVisibility;
  actor: MemoryActor;
  kind: MemoryEventKind;
  occurredAt: number;
  source: string;
  excerpt: string;
}

export interface MemoryProjectionClaimEvidence {
  claimId: string;
  eventId: string;
  stance: "supports" | "opposes";
}

export interface MemoryProjectionSnapshot {
  generatedAt: number;
  claims: MemoryClaim[];
  history: MemoryClaim[];
  claimEvidence: MemoryProjectionClaimEvidence[];
  eventSummaries: MemoryProjectionEventSummary[];
}
