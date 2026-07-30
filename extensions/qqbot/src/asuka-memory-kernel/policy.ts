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

const DETERMINISTIC_SECRET_SCAN_MAX_NODES = 10_000;
const DETERMINISTIC_SECRET_SCAN_MAX_DEPTH = 128;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const ASSIGNED_SECRET_RE = /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret|token|authorization|cookie)\b["']?\s*[:=]\s*["']?\S+/i;
const TOKEN_PREFIX_RE = /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i;
const VERIFICATION_CODE_RE = /(?:验证码|校验码|动态码|一次性密码|otp)\D{0,8}\d{4,8}/i;
const BANK_CARD_RE = /(?:银行卡|信用卡|借记卡|card)\D{0,12}(?:\d[ -]?){15,19}/i;
const ID_NUMBER_RE = /(?:身份证|证件号|id\s*(?:number|no\.?))\D{0,12}\d{6}(?:19|20)\d{2}[01]\d[0-3]\d\d{3}[\dXx]/i;
const SECRET_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "apikey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "secret",
  "token",
  "authorization",
  "cookie",
]);

export type DeterministicSecretScanResult = "clear" | "secret" | "limit_exceeded";

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

function isSensitiveField(key: string | undefined): boolean {
  if (!key) return false;
  return SECRET_FIELD_NAMES.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

function structuredJsonValue(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function scanDeterministicSecretValue(
  value: unknown,
): DeterministicSecretScanResult {
  const pending: Array<{ depth: number; key?: string; value: unknown }> = [{
    depth: 0,
    value,
  }];
  const seen = new WeakSet<object>();
  let scheduled = 1;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > DETERMINISTIC_SECRET_SCAN_MAX_DEPTH) {
      return "limit_exceeded";
    }

    if (typeof current.value === "string") {
      if (
        containsDeterministicSecret(current.value)
        || (isSensitiveField(current.key) && current.value.trim().length > 0)
      ) {
        return "secret";
      }
      const structured = structuredJsonValue(current.value);
      if (structured !== undefined) {
        if (scheduled >= DETERMINISTIC_SECRET_SCAN_MAX_NODES) {
          return "limit_exceeded";
        }
        scheduled += 1;
        pending.push({
          depth: current.depth + 1,
          key: current.key,
          value: structured,
        });
      }
      continue;
    }
    if (
      isSensitiveField(current.key)
      && (
        typeof current.value === "number"
        || typeof current.value === "bigint"
      )
    ) {
      return "secret";
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (
        current.value.length
        > DETERMINISTIC_SECRET_SCAN_MAX_NODES - scheduled
      ) {
        return "limit_exceeded";
      }
      scheduled += current.value.length;
      for (const item of current.value) {
        pending.push({
          depth: current.depth + 1,
          key: current.key,
          value: item,
        });
      }
      continue;
    }

    try {
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        if (scheduled >= DETERMINISTIC_SECRET_SCAN_MAX_NODES) {
          return "limit_exceeded";
        }
        scheduled += 1;
        pending.push({
          depth: current.depth + 1,
          key,
          value: (current.value as Record<string, unknown>)[key],
        });
      }
    } catch {
      return "limit_exceeded";
    }
  }
  return "clear";
}

export function containsDeterministicSecretValue(value: unknown): boolean {
  return scanDeterministicSecretValue(value) !== "clear";
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
