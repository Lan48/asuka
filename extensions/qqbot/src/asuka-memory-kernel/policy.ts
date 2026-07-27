import type {
  MemoryAuthority,
  MemoryClaim,
  MemoryEpistemicStatus,
  MemoryEvent,
  MemoryVisibility,
} from "./types.js";

const AUTHORITY_WEIGHT: Record<MemoryAuthority, number> = {
  human_override: 600,
  user_correction: 600,
  user_explicit: 500,
  mutual_agreement: 400,
  observed_pattern: 300,
  inferred: 200,
  summary: 100,
};

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const ASSIGNED_SECRET_RE = /\b(?:password|passwd|api[_-]?key|secret|token|authorization|cookie)\b\s*[:=]\s*\S+/i;
const TOKEN_PREFIX_RE = /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i;
const VERIFICATION_CODE_RE = /(?:验证码|校验码|动态码|一次性密码|otp)\D{0,8}\d{4,8}/i;
const BANK_CARD_RE = /(?:银行卡|信用卡|借记卡|card)\D{0,12}(?:\d[ -]?){15,19}/i;
const ID_NUMBER_RE = /(?:身份证|证件号|id\s*(?:number|no\.?))\D{0,12}\d{6}(?:19|20)\d{2}[01]\d[0-3]\d\d{3}[\dXx]/i;

export function memoryAuthorityWeight(authority: MemoryAuthority): number {
  return AUTHORITY_WEIGHT[authority];
}

export function containsDeterministicSecret(text: string): boolean {
  return PRIVATE_KEY_RE.test(text)
    || ASSIGNED_SECRET_RE.test(text)
    || TOKEN_PREFIX_RE.test(text)
    || VERIFICATION_CODE_RE.test(text)
    || BANK_CARD_RE.test(text)
    || ID_NUMBER_RE.test(text);
}

export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function shouldIgnoreSelfReinforcingEvidence(
  event: MemoryEvent,
  claim: Pick<MemoryClaim, "claimId" | "rootClaimId">,
): boolean {
  return event.actor === "asuka"
    && event.generatedFromClaimIds.some((id) => id === claim.claimId || id === claim.rootClaimId);
}

export function defaultVisibility(peerKind: "direct" | "group"): MemoryVisibility {
  return peerKind === "direct" ? "private" : "public";
}

export function defaultEpistemicAuthority(
  event: Pick<MemoryEvent, "actor" | "kind">,
  epistemicStatus: MemoryEpistemicStatus,
): MemoryAuthority {
  if (event.kind === "human_override") return "human_override";
  if (event.kind === "memory_control") return "user_correction";
  if (event.actor === "user" && epistemicStatus === "explicit") return "user_explicit";
  if (epistemicStatus === "inferred") return "inferred";
  return event.actor === "asuka" ? "summary" : "observed_pattern";
}
