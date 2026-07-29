import type {
  ClaimProposal,
  MemoryAuthority,
  MemoryClaim,
  MemoryEpistemicStatus,
  MemoryEvent,
  MemoryJudgement,
  MemoryReflectionDecision,
  MemoryReflectionResult,
  MemoryTopLevelType,
} from "./types.js";

const TOP_LEVEL_TYPES = new Set<MemoryTopLevelType>([
  "fact",
  "event",
  "belief",
  "self_narrative",
  "working_memory",
  "procedural",
]);
const EPISTEMIC_STATUSES = new Set<MemoryEpistemicStatus>(["explicit", "inferred"]);
const ACTIONS = new Set(["add", "revise", "refute", "forget", "delete"]);
const DISPOSITIONS = new Set(["active", "candidate"]);
const REFLECTION_ACTIONS = new Set(["retain", "revise", "refute", "expire"]);
const LIFECYCLES = new Set(["stable", "bounded", "episodic", "working"]);
const LEGACY_PROPOSAL_STRING_LIMITS = {
  subjectId: 200,
  predicate: 200,
  canonicalText: 500,
  topic: 160,
} as const;

interface RawProposal {
  semanticKey?: unknown;
  subjectId?: unknown;
  predicate?: unknown;
  value?: unknown;
  canonicalText?: unknown;
  topLevelType?: unknown;
  epistemicStatus?: unknown;
  sourceKind?: unknown;
  confidence?: unknown;
  disposition?: unknown;
  rationale?: unknown;
  action?: unknown;
  targetClaimId?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
  topic?: unknown;
  entityIds?: unknown;
  supportingEventIds?: unknown;
  opposingEventIds?: unknown;
  lifecycle?: unknown;
  metadata?: unknown;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("model result did not contain a JSON object");
    return JSON.parse(unfenced.slice(start, end + 1));
  }
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function stringValue(value: unknown, maxLength: number): string | undefined {
  return normalizedString(value)?.slice(0, maxLength);
}

function strictRequiredModelString(
  value: unknown,
  maxLength: number,
  errorMessage: string,
): string {
  const normalized = normalizedString(value);
  if (!normalized || normalized.length > maxLength) {
    throw new Error(errorMessage);
  }
  return normalized;
}

function strictOptionalModelString(
  value: unknown,
  maxLength: number,
  errorMessage: string,
): string | undefined {
  if (value === undefined) return undefined;
  return strictRequiredModelString(value, maxLength, errorMessage);
}

function stringArray(value: unknown, maxItems = 32): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => stringValue(item, 200))
    .filter((item): item is string => Boolean(item)))]
    .slice(0, maxItems);
}

function timestampValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseValidityInterval(
  value: { validFrom?: unknown; validTo?: unknown },
  errorMessage: string,
): { validFrom?: number; validTo?: number } {
  const hasValidFrom = Object.prototype.hasOwnProperty.call(value, "validFrom");
  const hasValidTo = Object.prototype.hasOwnProperty.call(value, "validTo");
  const validFrom = timestampValue(value.validFrom);
  const validTo = timestampValue(value.validTo);
  if (
    (hasValidFrom && validFrom === undefined)
    || (hasValidTo && validTo === undefined)
    || (validFrom !== undefined && validTo !== undefined && validTo <= validFrom)
  ) {
    throw new Error(errorMessage);
  }
  return { validFrom, validTo };
}

function authorityFor(
  event: MemoryEvent,
  epistemicStatus: MemoryEpistemicStatus,
  sourceKind: string | undefined,
): MemoryAuthority {
  if (epistemicStatus === "inferred") {
    return "inferred";
  }
  if (event.actor === "user" && event.kind === "human_override") return "human_override";
  if (
    event.actor === "user"
    && (event.kind === "memory_control" || sourceKind === "correction")
  ) {
    return "user_correction";
  }
  if (
    sourceKind === "agreement"
    && event.metadata.mutualAgreement === true
  ) {
    return "mutual_agreement";
  }
  if (event.actor === "user" && epistemicStatus === "explicit") return "user_explicit";
  return "summary";
}

function validateProposal(
  event: MemoryEvent,
  raw: unknown,
  index: number,
): ClaimProposal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`memory proposal ${index} must be an object`);
  }
  const value = raw as RawProposal;
  const subjectId = strictRequiredModelString(
    value.subjectId,
    200,
    `memory proposal ${index} has an invalid claim identity`,
  );
  const predicate = strictRequiredModelString(
    value.predicate,
    200,
    `memory proposal ${index} has an invalid claim identity`,
  );
  const canonicalText = strictRequiredModelString(
    value.canonicalText,
    500,
    `memory proposal ${index} has an invalid claim identity`,
  );
  if (!Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error(`memory proposal ${index} is missing value`);
  }
  if (!TOP_LEVEL_TYPES.has(value.topLevelType as MemoryTopLevelType)) {
    throw new Error(`memory proposal ${index} has an invalid topLevelType`);
  }
  if (!EPISTEMIC_STATUSES.has(value.epistemicStatus as MemoryEpistemicStatus)) {
    throw new Error(`memory proposal ${index} has an invalid epistemicStatus`);
  }
  if (
    typeof value.confidence !== "number"
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new Error(`memory proposal ${index} has an invalid confidence`);
  }
  const epistemicStatus = value.epistemicStatus as MemoryEpistemicStatus;
  if (value.action !== undefined && !ACTIONS.has(value.action as string)) {
    throw new Error(`memory proposal ${index} has an invalid action`);
  }
  const action = (value.action ?? "add") as ClaimProposal["action"];
  const targetClaimId = strictOptionalModelString(
    value.targetClaimId,
    200,
    `memory proposal ${index} has an invalid targetClaimId`,
  );
  if (
    (action === "add" && value.targetClaimId !== undefined)
    || (action !== "add" && !targetClaimId)
  ) {
    throw new Error(`memory proposal ${index} has fields incompatible with ${action}`);
  }
  if (value.lifecycle !== undefined && !LIFECYCLES.has(value.lifecycle as string)) {
    throw new Error(`memory proposal ${index} has an invalid lifecycle`);
  }
  const lifecycle = value.lifecycle as ClaimProposal["lifecycle"];
  const sourceKind = strictOptionalModelString(
    value.sourceKind,
    40,
    `memory proposal ${index} has an invalid sourceKind`,
  );
  const rationale = strictOptionalModelString(
    value.rationale,
    500,
    `memory proposal ${index} has an invalid rationale`,
  );
  if (value.disposition !== undefined && !DISPOSITIONS.has(value.disposition as string)) {
    throw new Error(`memory proposal ${index} has an invalid disposition`);
  }
  const disposition = value.disposition as ClaimProposal["disposition"];
  if (
    action !== "add"
    && action !== "revise"
    && value.disposition !== undefined
  ) {
    throw new Error(`memory proposal ${index} has fields incompatible with ${action}`);
  }
  const humanOverride = event.actor === "user" && event.kind === "human_override";
  if (
    (action === "add" || action === "revise")
    && !humanOverride
    && (!disposition || !rationale)
  ) {
    throw new Error(`memory proposal ${index} is missing disposition or rationale`);
  }
  if (
    epistemicStatus === "inferred"
    && (
      !Array.isArray(value.supportingEventIds)
      || value.supportingEventIds.length === 0
    )
  ) {
    throw new Error(`memory proposal ${index} is missing inferred evidence`);
  }
  if (
    !validOptionalStringArray(value.entityIds)
    || !validOptionalStringArray(value.supportingEventIds)
    || !validOptionalStringArray(value.opposingEventIds)
  ) {
    throw new Error(`memory proposal ${index} has invalid evidence or entity IDs`);
  }
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? value.metadata as Record<string, unknown>
    : {};
  if (value.metadata !== undefined && Object.keys(metadata).length === 0 && (
    !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)
  )) {
    throw new Error(`memory proposal ${index} has invalid metadata`);
  }
  const validity = parseValidityInterval(
    value,
    `memory proposal ${index} has an invalid validity interval`,
  );
  return {
    semanticKey: strictOptionalModelString(
      value.semanticKey,
      240,
      `memory proposal ${index} has an invalid semanticKey`,
    ),
    subjectId,
    predicate,
    value: value.value,
    canonicalText,
    topLevelType: value.topLevelType as MemoryTopLevelType,
    epistemicStatus,
    authority: authorityFor(event, epistemicStatus, sourceKind),
    confidence: value.confidence,
    disposition,
    rationale,
    action,
    targetClaimId,
    validFrom: validity.validFrom,
    validTo: validity.validTo,
    topic: strictOptionalModelString(
      value.topic,
      160,
      `memory proposal ${index} has an invalid topic`,
    ),
    entityIds: stringArray(value.entityIds),
    supportingEventIds: stringArray(value.supportingEventIds),
    opposingEventIds: stringArray(value.opposingEventIds),
    lifecycle,
    metadata: {
      ...metadata,
      sourceKind,
    },
  };
}

function presentString(value: unknown, maximum: number): boolean {
  return typeof value === "string"
    && value.replace(/\s+/g, " ").trim().length > 0
    && value.replace(/\s+/g, " ").trim().length <= maximum;
}

function validOptionalTimestamp(value: unknown): boolean {
  return value === undefined || timestampValue(value) !== undefined;
}

function validOptionalStringArray(value: unknown, maximum = 32): boolean {
  return value === undefined
    || (
      Array.isArray(value)
      && value.length <= maximum
      && value.every((item) => presentString(item, 200))
    );
}

function validateLegacyProposal(event: MemoryEvent, value: unknown, index: number): ClaimProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`legacy extraction proposal ${index} must be an object`);
  }
  const proposal = value as RawProposal;
  if (!presentString(proposal.subjectId, LEGACY_PROPOSAL_STRING_LIMITS.subjectId)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid subjectId`);
  }
  if (!presentString(proposal.predicate, LEGACY_PROPOSAL_STRING_LIMITS.predicate)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid predicate`);
  }
  if (!presentString(proposal.canonicalText, LEGACY_PROPOSAL_STRING_LIMITS.canonicalText)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid canonicalText`);
  }
  if (!Object.prototype.hasOwnProperty.call(proposal, "value")) {
    throw new Error(`legacy extraction proposal ${index} is missing value`);
  }
  if (!TOP_LEVEL_TYPES.has(proposal.topLevelType as MemoryTopLevelType)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid topLevelType`);
  }
  if (!EPISTEMIC_STATUSES.has(proposal.epistemicStatus as MemoryEpistemicStatus)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid epistemicStatus`);
  }
  if (
    typeof proposal.confidence !== "number"
    || !Number.isFinite(proposal.confidence)
    || proposal.confidence < 0
    || proposal.confidence > 1
  ) {
    throw new Error(`legacy extraction proposal ${index} has an invalid confidence`);
  }
  if (
    proposal.action !== undefined
    && proposal.action !== "add"
  ) {
    throw new Error(`legacy extraction proposal ${index} cannot mutate final claims`);
  }
  if (
    proposal.lifecycle !== undefined
    && !LIFECYCLES.has(proposal.lifecycle as string)
  ) {
    throw new Error(`legacy extraction proposal ${index} has an invalid lifecycle`);
  }
  if (!validOptionalTimestamp(proposal.validFrom) || !validOptionalTimestamp(proposal.validTo)) {
    throw new Error(`legacy extraction proposal ${index} has an invalid validity interval`);
  }
  const validFrom = timestampValue(proposal.validFrom);
  const validTo = timestampValue(proposal.validTo);
  if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
    throw new Error(`legacy extraction proposal ${index} has an invalid validity interval`);
  }
  if (
    proposal.topic !== undefined
    && !presentString(proposal.topic, LEGACY_PROPOSAL_STRING_LIMITS.topic)
  ) {
    throw new Error(`legacy extraction proposal ${index} has an invalid topic`);
  }
  if (
    !validOptionalStringArray(proposal.entityIds)
    || !validOptionalStringArray(proposal.supportingEventIds)
    || !validOptionalStringArray(proposal.opposingEventIds)
  ) {
    throw new Error(`legacy extraction proposal ${index} has an invalid identifier list`);
  }
  const validated = validateProposal(event, {
    ...proposal,
    action: proposal.action ?? "add",
    supportingEventIds: [event.eventId],
    opposingEventIds: [],
    disposition: "candidate",
    rationale: "Pending legacy consolidation",
  }, index);
  if (!validated) {
    throw new Error(`legacy extraction proposal ${index} is invalid`);
  }
  return {
    ...validated,
    action: "add",
    targetClaimId: undefined,
    supportingEventIds: [event.eventId],
    opposingEventIds: [],
    metadata: {
      ...validated.metadata,
      migrationPendingConsolidation: true,
    },
  };
}

export function parseMemoryJudgement(
  text: string,
  event: MemoryEvent,
  maxProposals = 12,
): MemoryJudgement {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("memory judgement must be a JSON object");
  }
  const result = parsed as {
    proposals?: unknown;
    noMemoryReason?: unknown;
  };
  if (!Array.isArray(result.proposals)) {
    throw new Error("memory judgement is missing proposals");
  }
  if (Array.isArray(result.proposals) && result.proposals.length > maxProposals) {
    throw new Error(
      `memory judgement returned ${result.proposals.length} proposals; maximum is ${maxProposals}`,
    );
  }
  const proposals = result.proposals
    .map((proposal, index) => validateProposal(event, proposal, index));
  return {
    eventId: event.eventId,
    proposals,
    noMemoryReason: strictOptionalModelString(
      result.noMemoryReason,
      500,
      "memory judgement has an invalid noMemoryReason",
    ),
  };
}

export function parseLegacyExtraction(
  text: string,
  event: MemoryEvent,
  maxProposals: number,
): MemoryJudgement {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy extraction must be a JSON object");
  }
  const result = parsed as {
    proposals?: unknown;
    noMemoryReason?: unknown;
  };
  if (!Array.isArray(result.proposals)) {
    throw new Error("legacy extraction is missing proposals");
  }
  if (result.proposals.length > maxProposals) {
    throw new Error(
      `legacy extraction returned ${result.proposals.length} proposals; maximum is ${maxProposals}`,
    );
  }
  const noMemoryReason = strictOptionalModelString(
    result.noMemoryReason === null ? undefined : result.noMemoryReason,
    500,
    "legacy extraction has an invalid noMemoryReason",
  );
  if (result.proposals.length === 0 && !noMemoryReason) {
    throw new Error("empty legacy extraction requires noMemoryReason");
  }
  return {
    eventId: event.eventId,
    proposals: result.proposals.map((proposal, index) =>
      validateLegacyProposal(event, proposal, index)
    ),
    noMemoryReason,
  };
}

function legacyPromptMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const omitted = new Set([
    "legacyRecord",
    "legacyClaim",
    "legacyRefIndex",
    "snapshot",
  ]);
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !omitted.has(key)),
  );
}

export function buildLegacyExtractionPrompt(event: MemoryEvent): string {
  const payload = {
    event: {
      eventId: event.eventId,
      identityId: event.identityId,
      visibility: event.visibility,
      actor: event.actor,
      occurredAt: new Date(event.occurredAt).toISOString(),
      text: event.text,
      evidence: event.evidence,
      metadata: legacyPromptMetadata(event.metadata),
    },
  };
  return [
    "你是 Asuka 旧记忆迁移的证据提取器。只返回一个 JSON 对象，不要 Markdown。",
    "这一阶段只从单个原始事件提取原子候选，不合并、不覆盖、不删除最终声明。",
    "",
    "规则：",
    "1. subjectId、predicate、topic、entityIds 按语义动态生成，不使用固定领域枚举。",
    "2. 用户原话可标 explicit；摘要、模型自述、行为模式或上下文推导标 inferred。",
    "3. 提问、引用、否定对象、寒暄和没有长期价值的瞬时内容不得提取为事实。",
    "4. 不输出 revise/refute/forget/delete，也不引用其他事件；代码会绑定当前证据。",
    "5. 没有候选时 proposals 必须为空，并给出具体 noMemoryReason。",
    "",
    "输出结构：",
    JSON.stringify({
      proposals: [{
        subjectId: "动态主体 ID",
        predicate: "动态语义属性",
        value: "JSON value",
        canonicalText: "紧凑、无歧义的声明",
        topLevelType: "fact|event|belief|self_narrative|working_memory|procedural",
        epistemicStatus: "explicit|inferred",
        sourceKind: "statement|correction|agreement|behavior|inference|summary",
        confidence: 0.9,
        validFrom: "可选 ISO 时间",
        validTo: "可选 ISO 时间",
        topic: "可选动态主题",
        entityIds: [],
        lifecycle: "stable|bounded|episodic|working",
      }],
      noMemoryReason: "proposals 为空时必填",
    }),
    "",
    `LEGACY_EXTRACTION_INPUT=${JSON.stringify(payload)}`,
  ].join("\n");
}

export interface LegacyConsolidationPromptItem {
  itemId: string;
  sourceCandidateIds: string[];
  subjectId: string;
  predicate: string;
  value: unknown;
  canonicalText: string;
  topLevelType: MemoryTopLevelType;
  epistemicStatus: MemoryEpistemicStatus;
  confidence: number;
  disposition: "active" | "candidate";
  rationale: string;
  validFrom?: number;
  validTo?: number;
  topic?: string;
  entityIds: string[];
  lifecycle?: ClaimProposal["lifecycle"];
  evidence: Array<{
    eventId: string;
    actor: MemoryEvent["actor"];
    kind: MemoryEvent["kind"];
    occurredAt: number;
    text?: string;
  }>;
}

export interface LegacyConsolidationDecisionClaim {
  semanticKey: string;
  sourceItemIds: string[];
  subjectId: string;
  predicate: string;
  value: unknown;
  canonicalText: string;
  topLevelType: MemoryTopLevelType;
  epistemicStatus: MemoryEpistemicStatus;
  confidence: number;
  disposition: "active" | "candidate";
  rationale: string;
  validFrom?: number;
  validTo?: number;
  topic?: string;
  entityIds: string[];
  lifecycle?: ClaimProposal["lifecycle"];
}

export interface LegacyConsolidationDecision {
  claims: LegacyConsolidationDecisionClaim[];
  discarded: Array<{
    sourceItemIds: string[];
    reason: string;
  }>;
}

function representativeLegacyEvidence(
  evidence: LegacyConsolidationPromptItem["evidence"],
): LegacyConsolidationPromptItem["evidence"] {
  if (evidence.length <= 4) return evidence;
  return [evidence[0], evidence[1], evidence.at(-2)!, evidence.at(-1)!];
}

export function buildLegacyConsolidationPrompt(
  items: LegacyConsolidationPromptItem[],
): string {
  const promptItems = items.map((item) => ({
    itemId: item.itemId,
    subjectId: item.subjectId,
    predicate: item.predicate,
    value: item.value,
    canonicalText: item.canonicalText,
    topLevelType: item.topLevelType,
    epistemicStatus: item.epistemicStatus,
    confidence: item.confidence,
    disposition: item.disposition,
    rationale: item.rationale,
    validFrom: item.validFrom,
    validTo: item.validTo,
    topic: item.topic,
    entityIds: item.entityIds,
    lifecycle: item.lifecycle,
    evidenceCount: item.evidence.length,
    evidence: representativeLegacyEvidence(item.evidence),
  }));
  return [
    "你是 Asuka 旧记忆迁移的全局语义归并器。只返回一个 JSON 对象，不要 Markdown。",
    "输入项已经逐事件提取；你要合并同义候选、区分并存事实，并为随时间变化的事实建立版本链。",
    "",
    "规则：",
    "1. semanticKey 表示一条版本链，必须动态、稳定；同义 predicate 使用同一 semanticKey。",
    "2. 同一事实的重复证据合成一个 claim；时间变化生成多个 claim，但 semanticKey 相同。",
    "3. 可并存的集合事实使用不同 semanticKey，不能因为 predicate 相同就相互覆盖。",
    "4. 每个输入 itemId 必须且只能出现一次：放入某个 claim.sourceItemIds，或 discarded.sourceItemIds。",
    "5. discarded 只用于噪声、误提取或无长期价值内容，必须给具体 reason。",
    "6. 不得发明 itemId、事件或证据；权限、权威、时间顺序和证据绑定由代码复核。",
    "7. subjectId、predicate、semanticKey、topic、entityIds 按内容生成，不依赖固定用户领域枚举。",
    "",
    "输出结构：",
    JSON.stringify({
      claims: [{
        semanticKey: "动态稳定版本链键",
        sourceItemIds: ["输入 itemId"],
        subjectId: "动态主体 ID",
        predicate: "规范化动态属性",
        value: "JSON value",
        canonicalText: "规范化声明",
        topLevelType: "fact|event|belief|self_narrative|working_memory|procedural",
        epistemicStatus: "explicit|inferred",
        confidence: 0.9,
        disposition: "active|candidate",
        rationale: "为什么该声明应当 active 或留在 candidate",
        validFrom: "可选 ISO 时间",
        validTo: "可选 ISO 时间",
        topic: "可选动态主题",
        entityIds: [],
        lifecycle: "stable|bounded|episodic|working",
      }],
      discarded: [{
        sourceItemIds: ["输入 itemId"],
        reason: "具体丢弃理由",
      }],
    }),
    "",
    `LEGACY_CONSOLIDATION_INPUT=${JSON.stringify({ items: promptItems })}`,
  ].join("\n");
}

function strictString(
  value: unknown,
  field: string,
  index: number,
  maximum: number,
): string {
  if (!presentString(value, maximum)) {
    throw new Error(`legacy consolidation claim ${index} has an invalid ${field}`);
  }
  return (value as string).replace(/\s+/g, " ").trim();
}

function strictStringList(value: unknown, field: string, index: number): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => !presentString(item, 200))
  ) {
    throw new Error(`legacy consolidation item ${index} has an invalid ${field}`);
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`legacy consolidation item ${index} repeats ${field}`);
  }
  return normalized;
}

export function parseLegacyConsolidation(
  text: string,
  inputItemIds: Set<string>,
  maxClaims: number,
): LegacyConsolidationDecision {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy consolidation must be a JSON object");
  }
  const result = parsed as { claims?: unknown; discarded?: unknown };
  if (!Array.isArray(result.claims) || !Array.isArray(result.discarded)) {
    throw new Error("legacy consolidation requires claims and discarded arrays");
  }
  if (result.claims.length > maxClaims) {
    throw new Error(
      `legacy consolidation returned ${result.claims.length} claims; maximum is ${maxClaims}`,
    );
  }
  const claims = result.claims.map((raw, index): LegacyConsolidationDecisionClaim => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`legacy consolidation claim ${index} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(value, "value")) {
      throw new Error(`legacy consolidation claim ${index} is missing value`);
    }
    if (!TOP_LEVEL_TYPES.has(value.topLevelType as MemoryTopLevelType)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid topLevelType`);
    }
    if (!EPISTEMIC_STATUSES.has(value.epistemicStatus as MemoryEpistemicStatus)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid epistemicStatus`);
    }
    if (
      typeof value.confidence !== "number"
      || !Number.isFinite(value.confidence)
      || value.confidence < 0
      || value.confidence > 1
    ) {
      throw new Error(`legacy consolidation claim ${index} has an invalid confidence`);
    }
    if (!DISPOSITIONS.has(value.disposition as string)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid disposition`);
    }
    if (!presentString(value.rationale, 500)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid rationale`);
    }
    if (
      value.lifecycle !== undefined
      && !LIFECYCLES.has(value.lifecycle as string)
    ) {
      throw new Error(`legacy consolidation claim ${index} has an invalid lifecycle`);
    }
    if (!validOptionalTimestamp(value.validFrom) || !validOptionalTimestamp(value.validTo)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid validity interval`);
    }
    const validFrom = timestampValue(value.validFrom);
    const validTo = timestampValue(value.validTo);
    if (validFrom !== undefined && validTo !== undefined && validTo <= validFrom) {
      throw new Error(`legacy consolidation claim ${index} has an invalid validity interval`);
    }
    if (value.topic !== undefined && !presentString(value.topic, 160)) {
      throw new Error(`legacy consolidation claim ${index} has an invalid topic`);
    }
    if (!validOptionalStringArray(value.entityIds)) {
      throw new Error(`legacy consolidation claim ${index} has invalid entityIds`);
    }
    return {
      semanticKey: strictString(value.semanticKey, "semanticKey", index, 240),
      sourceItemIds: strictStringList(value.sourceItemIds, "sourceItemIds", index),
      subjectId: strictString(value.subjectId, "subjectId", index, 200),
      predicate: strictString(value.predicate, "predicate", index, 200),
      value: value.value,
      canonicalText: strictString(value.canonicalText, "canonicalText", index, 500),
      topLevelType: value.topLevelType as MemoryTopLevelType,
      epistemicStatus: value.epistemicStatus as MemoryEpistemicStatus,
      confidence: value.confidence,
      disposition: value.disposition as "active" | "candidate",
      rationale: normalizedString(value.rationale)!,
      validFrom,
      validTo,
      topic: stringValue(value.topic, 160),
      entityIds: stringArray(value.entityIds),
      lifecycle: value.lifecycle as ClaimProposal["lifecycle"],
    };
  });
  const discarded = result.discarded.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`legacy consolidation discard ${index} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    return {
      sourceItemIds: strictStringList(value.sourceItemIds, "sourceItemIds", index),
      reason: strictString(value.reason, "reason", index, 500),
    };
  });
  const seen = new Set<string>();
  for (const itemId of [
    ...claims.flatMap((claim) => claim.sourceItemIds),
    ...discarded.flatMap((item) => item.sourceItemIds),
  ]) {
    if (!inputItemIds.has(itemId)) {
      throw new Error(`legacy consolidation invented input item ${itemId}`);
    }
    if (seen.has(itemId)) {
      throw new Error(`legacy consolidation covered input item ${itemId} more than once`);
    }
    seen.add(itemId);
  }
  const missing = [...inputItemIds].filter((itemId) => !seen.has(itemId));
  if (missing.length > 0) {
    throw new Error(
      `legacy consolidation coverage missing ${missing.length} input item(s): ${missing.slice(0, 5).join(", ")}`,
    );
  }
  return { claims, discarded };
}

function claimForPrompt(claim: MemoryClaim): Record<string, unknown> {
  return {
    claimId: claim.claimId,
    rootClaimId: claim.rootClaimId,
    semanticKey: claim.semanticKey,
    subjectId: claim.subjectId,
    predicate: claim.predicate,
    value: claim.value,
    canonicalText: claim.canonicalText,
    topLevelType: claim.topLevelType,
    epistemicStatus: claim.epistemicStatus,
    authority: claim.authority,
    confidence: claim.confidence,
    disposition: claim.metadata.disposition,
    rationale: claim.metadata.rationale,
    state: claim.state,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    topic: claim.topic,
    sourceEventId: claim.sourceEventId,
  };
}

export interface MemoryJudgementContextCoverage {
  availableClaimCount: number;
  includedClaimCount: number;
  omittedClaimCount: number;
  requiredClaimIds: string[];
  includedRequiredClaimIds: string[];
  missingRequiredReferences: string[];
  includedEvidenceCount: number;
  omittedEvidenceCount: number;
  evidenceByClaimId: Record<string, {
    supportingEventIds: string[];
    opposingEventIds: string[];
  }>;
}

export function buildMemoryJudgementPrompt(
  event: MemoryEvent,
  currentClaims: MemoryClaim[],
  coverage: MemoryJudgementContextCoverage,
): string {
  const migrationRules = event.kind === "legacy_import"
    ? [
      "11. 当前事件来自旧记忆系统：原始文本和 metadata 只是待重裁决证据，旧 type/slot/predicate 不是新结构约束。",
      "12. 对重复或等价事实合并证据；对同一语义随时间变化的事实使用稳定 predicate 和 revise；不要机械复制旧分类。",
      "13. 摘要、Asuka 自述、会话片段和推断必须按真实证据强度降权；无法形成可靠声明时返回空 proposals。",
    ]
    : [];
  const eventPayload = {
    eventId: event.eventId,
    actor: event.actor,
    kind: event.kind,
    occurredAt: new Date(event.occurredAt).toISOString(),
    text: event.text,
    evidence: event.evidence,
    metadata: event.metadata,
    generatedFromClaimIds: event.generatedFromClaimIds,
  };
  const {
    evidenceByClaimId,
    ...coverageSummary
  } = coverage;
  const promptClaims = currentClaims.map((claim) => ({
    ...claimForPrompt(claim),
    ...(evidenceByClaimId[claim.claimId] ?? {
      supportingEventIds: [],
      opposingEventIds: [],
    }),
  }));
  return [
    "你是 Asuka 记忆系统的语义裁决器。只返回一个 JSON 对象，不要 Markdown。",
    "目标不是保存每句话，而是提出可审计的记忆声明 proposal；代码会独立验证权限、权威和证据。",
    "",
    "规则：",
    "1. 顶层类型只能是 fact/event/belief/self_narrative/working_memory/procedural。",
    "2. semanticKey 表示稳定版本链；同义 predicate 必须使用同一 semanticKey。semanticKey、predicate、topic、entityIds 都按语义动态生成，不依赖预设领域枚举。",
    "3. 用户明确说出的事实标 explicit；从行为、语气或多轮模式推导的内容标 inferred。",
    "4. inferred 必须给出 supportingEventIds、证据化 canonicalText 和保守 confidence。",
    "4a. 每个 add/revise proposal 都必须给 disposition=active|candidate 和具体 rationale；active 表示模型判定它可参与召回，代码仍会执行证据、作用域和明确事实优先门禁。",
    "5. 提问、引用、否定对象、角色动作、一次性情绪和寒暄不能误当成用户事实。",
    "6. Asuka 自己生成的说法只能作为候选；generatedFromClaimIds 中的自我召回不能成为新证据。",
    "7. 新内容与 currentClaims 冲突时，使用 revise/refute 并给 targetClaimId；不能让推断覆盖明确事实。",
    "8. stable 只用于不会自然随时间失效的事实；随时间变化的状态使用 bounded/working，并在可推断时给 validTo。",
    "9. 用户要求忘记用 forget；只有用户明确要求彻底删除时才用 delete。",
    "10. 若没有值得进入长期或候选记忆的内容，proposals 返回空数组并说明 noMemoryReason。",
    ...migrationRules,
    "",
    "输出结构：",
    JSON.stringify({
      proposals: [{
        semanticKey: "动态、稳定的版本链键",
        subjectId: "动态主体 ID",
        predicate: "动态、稳定的语义属性",
        value: "JSON value",
        canonicalText: "第三人称、无歧义的紧凑声明",
        topLevelType: "fact",
        epistemicStatus: "explicit",
        sourceKind: "statement|correction|agreement|behavior|inference|summary",
        confidence: 0.9,
        disposition: "active|candidate",
        rationale: "该 proposal 当前应 active 或 candidate 的证据化理由",
        action: "add|revise|refute|forget|delete",
        targetClaimId: "可选",
        validFrom: "可选 ISO 时间",
        validTo: "可选 ISO 时间",
        topic: "动态主题",
        entityIds: ["动态实体"],
        supportingEventIds: [event.eventId],
        opposingEventIds: [],
        lifecycle: "stable|bounded|episodic|working",
        metadata: {},
      }],
      noMemoryReason: "可选",
    }),
    "",
    `当前事件：${JSON.stringify(eventPayload)}`,
    `上下文覆盖：${JSON.stringify(coverageSummary)}`,
    `当前相关声明：${JSON.stringify(promptClaims)}`,
  ].join("\n");
}

export function buildRerankPrompt(
  query: string,
  candidates: MemoryClaim[],
  maxPromptChars: number,
): string {
  return [
    "你是记忆召回重排器。只返回 JSON，不要解释。",
    "根据本轮真实意图选择自然相关、仍有效且不互相矛盾的声明。",
    "明确事实优先于推断；推断可以使用，但表达时必须保留不确定性。",
    "不要仅因词面重合选择无关旧记录。不要修改任何声明。",
    `可用记忆上下文预算约 ${maxPromptChars} 字符；按信息价值动态分配，不按类型固定条数。`,
    `本轮：${JSON.stringify(query)}`,
    `候选：${JSON.stringify(candidates.map(claimForPrompt))}`,
    '输出：{"claimIds":["按相关性排序的 claimId"],"reason":"短说明"}',
  ].join("\n");
}

export function parseRerankResult(text: string, allowedClaimIds: Set<string>): {
  claimIds: string[];
  reason?: string;
} {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rerank result must be a JSON object");
  }
  const result = parsed as { claimIds?: unknown; reason?: unknown };
  return {
    claimIds: stringArray(result.claimIds, 100).filter((id) => allowedClaimIds.has(id)),
    reason: stringValue(result.reason, 500),
  };
}

export function buildReflectionPrompt(
  claims: Array<{
    claim: MemoryClaim;
    evidence: MemoryEvent[];
  }>,
  now = Date.now(),
): string {
  return [
    "你是 Asuka 记忆系统的反思裁决器。只返回一个 JSON 对象，不要 Markdown。",
    "逐条复核输入中的非 stable 声明，决定 retain、revise、refute 或 expire；不得遗漏、重复或发明 claimId。",
    "retain 保留现有内容；revise 只在同一语义事实发生变化时给 revision；refute 表示证据否定推断；expire 表示临时状态不再有效。",
    "每条决定必须给具体 rationale 和 confidence。所有 retain/revise 都必须给 disposition=active|candidate。",
    "明确事实不得被间接推断覆盖；证据、作用域、版本链和显式优先由代码再次校验。",
    `当前时间：${new Date(now).toISOString()}`,
    `输入：${JSON.stringify(claims.map(({ claim, evidence }) => ({
      claim: claimForPrompt(claim),
      lifecycle: claim.metadata.lifecycle,
      evidence: evidence.map((event) => ({
        eventId: event.eventId,
        actor: event.actor,
        kind: event.kind,
        occurredAt: event.occurredAt,
        text: event.text,
      })),
    })))}`,
    "输出结构：",
    JSON.stringify({
      decisions: [{
        claimId: "输入 claimId",
        action: "retain|revise|refute|expire",
        disposition: "active|candidate（retain/revise 必填）",
        confidence: 0.7,
        rationale: "基于哪些证据作出决定",
        revision: {
          value: "revise 时的新 JSON value",
          canonicalText: "revise 时的新声明",
          validFrom: "可选 ISO 时间",
          validTo: "可选 ISO 时间",
          topic: "可选动态主题",
          entityIds: [],
          lifecycle: "stable|bounded|episodic|working",
        },
      }],
    }),
  ].join("\n");
}

export function parseReflectionResult(
  text: string,
  allowedClaimIds: Set<string>,
): MemoryReflectionResult {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("reflection result must be a JSON object");
  }
  const rawDecisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(rawDecisions)) {
    throw new Error("reflection result is missing decisions");
  }
  const seen = new Set<string>();
  const decisions = rawDecisions.map((raw, index): MemoryReflectionDecision => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`reflection decision ${index} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    const claimId = strictRequiredModelString(
      value.claimId,
      200,
      `reflection decision ${index} has an invalid claimId`,
    );
    if (!allowedClaimIds.has(claimId)) {
      throw new Error(`reflection decision ${index} has an invalid claimId`);
    }
    if (seen.has(claimId)) {
      throw new Error(`reflection decision repeats claim ${claimId}`);
    }
    seen.add(claimId);
    if (!REFLECTION_ACTIONS.has(value.action as string)) {
      throw new Error(`reflection decision ${index} has an invalid action`);
    }
    const action = value.action as MemoryReflectionDecision["action"];
    if (
      typeof value.confidence !== "number"
      || !Number.isFinite(value.confidence)
      || value.confidence < 0
      || value.confidence > 1
    ) {
      throw new Error(`reflection decision ${index} has an invalid confidence`);
    }
    const rationale = strictRequiredModelString(
      value.rationale,
      500,
      `reflection decision ${index} has an invalid rationale`,
    );
    if (
      value.disposition !== undefined
      && !DISPOSITIONS.has(value.disposition as string)
    ) {
      throw new Error(`reflection decision ${index} has an invalid disposition`);
    }
    const disposition = value.disposition as MemoryReflectionDecision["disposition"];
    if (
      (action === "retain" || action === "revise")
      && !disposition
    ) {
      throw new Error(`reflection decision ${index} is missing disposition`);
    }
    if (
      (action === "refute" || action === "expire")
      && value.disposition !== undefined
    ) {
      throw new Error(`reflection decision ${index} has fields incompatible with ${action}`);
    }
    let revision: MemoryReflectionDecision["revision"];
    if (action === "revise") {
      if (!value.revision || typeof value.revision !== "object" || Array.isArray(value.revision)) {
        throw new Error(`reflection decision ${index} is missing revision`);
      }
      const rawRevision = value.revision as Record<string, unknown>;
      const canonicalText = strictRequiredModelString(
        rawRevision.canonicalText,
        500,
        `reflection decision ${index} has an invalid revision`,
      );
      if (
        !Object.prototype.hasOwnProperty.call(rawRevision, "value")
      ) {
        throw new Error(`reflection decision ${index} has an invalid revision`);
      }
      if (
        rawRevision.lifecycle !== undefined
        && !LIFECYCLES.has(rawRevision.lifecycle as string)
      ) {
        throw new Error(`reflection decision ${index} has an invalid lifecycle`);
      }
      const validity = parseValidityInterval(
        rawRevision,
        `reflection decision ${index} has an invalid validity interval`,
      );
      if (!validOptionalStringArray(rawRevision.entityIds)) {
        throw new Error(`reflection decision ${index} has invalid entityIds`);
      }
      revision = {
        value: rawRevision.value,
        canonicalText,
        validFrom: validity.validFrom,
        validTo: validity.validTo,
        topic: strictOptionalModelString(
          rawRevision.topic,
          160,
          `reflection decision ${index} has an invalid topic`,
        ),
        entityIds: stringArray(rawRevision.entityIds),
        lifecycle: rawRevision.lifecycle as ClaimProposal["lifecycle"],
      };
    } else if (value.revision !== undefined) {
      throw new Error(`reflection decision ${index} cannot include revision`);
    }
    return {
      claimId,
      action,
      disposition,
      confidence: value.confidence,
      rationale,
      revision,
    };
  });
  const missing = [...allowedClaimIds].filter((claimId) => !seen.has(claimId));
  if (missing.length > 0) {
    throw new Error(`reflection coverage missing ${missing.length} claim(s)`);
  }
  return { decisions };
}
