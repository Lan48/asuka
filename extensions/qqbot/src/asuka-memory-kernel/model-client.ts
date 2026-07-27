import {
  getOpenAICompletionsThinkingParams,
  type OpenAICompletionsModelConfig,
} from "../config.js";
import type { MemoryModelAdapter, MemoryModelRequest } from "./types.js";

const COMPLETION_TEMPERATURE = 0.1;
const DEFAULT_COMPLETION_MAX_TOKENS = 2_400;
const MAX_COMPLETION_MAX_TOKENS = 16_000;
const MAX_ERROR_CHARS = 320;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MemoryEmbeddingModelConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  expectedDimensions?: number;
}

export interface MemoryModelClientOptions {
  primary?: OpenAICompletionsModelConfig | null;
  fallback?: OpenAICompletionsModelConfig | null;
  embedding?: MemoryEmbeddingModelConfig | null;
  fetchImpl?: FetchLike;
  log?: {
    warn?: (message: string) => void;
  };
}

export interface MemoryModelClientStatus {
  completion: "ready" | "unavailable";
  completionModels: number;
  embedding: "ready" | "degraded";
  embeddingReason?: "not_configured" | "invalid_configuration";
}

export interface AsukaMemoryModelClient extends MemoryModelAdapter {
  readonly status: Readonly<MemoryModelClientStatus>;
}

interface CompletionCandidate {
  role: "primary" | "fallback";
  config: OpenAICompletionsModelConfig;
}

function normalizeCompletionConfig(
  value: OpenAICompletionsModelConfig | null | undefined,
): OpenAICompletionsModelConfig | undefined {
  const baseUrl = value?.baseUrl?.trim().replace(/\/+$/, "");
  const apiKey = value?.apiKey?.trim();
  const model = value?.model?.trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  return { baseUrl, apiKey, model };
}

function completionCandidates(options: MemoryModelClientOptions): CompletionCandidate[] {
  const candidates: CompletionCandidate[] = [];
  const primary = normalizeCompletionConfig(options.primary);
  const fallback = normalizeCompletionConfig(options.fallback);
  if (primary) candidates.push({ role: "primary", config: primary });
  if (fallback) candidates.push({ role: "fallback", config: fallback });

  const seen = new Set<string>();
  return candidates.filter(({ config }) => {
    const key = `${config.baseUrl}\n${config.model}\n${config.apiKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeEmbeddingConfig(
  value: MemoryEmbeddingModelConfig | null | undefined,
): MemoryEmbeddingModelConfig | undefined {
  const endpoint = value?.endpoint?.trim();
  const apiKey = value?.apiKey?.trim();
  const model = value?.model?.trim();
  const timeoutMs = Number(value?.timeoutMs);
  const expectedDimensions = Number(value?.expectedDimensions);
  if (
    !endpoint
    || !apiKey
    || !model
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
  ) {
    return undefined;
  }
  if (
    value?.expectedDimensions !== undefined
    && (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0)
  ) {
    return undefined;
  }
  return {
    endpoint,
    apiKey,
    model,
    timeoutMs: Math.floor(timeoutMs),
    expectedDimensions: value?.expectedDimensions === undefined
      ? undefined
      : expectedDimensions,
  };
}

function redactError(value: unknown, secrets: string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|clientSecret|Authorization)\s*[:=]\s*\S+/gi,
      "[credential redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "[credential redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS) || "provider request failed";
}

function warn(
  log: MemoryModelClientOptions["log"],
  message: string,
): void {
  try {
    log?.warn?.(message);
  } catch {
    // Diagnostics must not change memory processing behavior.
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(unfenced);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("model output must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Some compatible providers wrap the requested object in a short preamble.
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < unfenced.length; index += 1) {
    const char = unfenced[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      const parsed = JSON.parse(unfenced.slice(start, index + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue scanning in case a later object is valid.
    }
    start = -1;
  }
  throw new Error("model output did not contain a valid JSON object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPresentString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isPresentStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isPresentString);
}

function isLegacyExtractionProposal(value: unknown): boolean {
  return isRecord(value)
    && isPresentString(value.subjectId)
    && isPresentString(value.predicate)
    && Object.prototype.hasOwnProperty.call(value, "value")
    && isPresentString(value.canonicalText)
    && isPresentString(value.topLevelType)
    && isPresentString(value.epistemicStatus)
    && typeof value.confidence === "number"
    && Number.isFinite(value.confidence);
}

function validateTaskOutput(text: string, task: MemoryModelRequest["task"]): void {
  const parsed = parseJsonObject(text);
  if (task === "adjudicate" || task === "legacy_extract") {
    const label = task === "legacy_extract"
      ? "legacy extraction"
      : "memory judgement";
    if (!Array.isArray(parsed.proposals)) {
      throw new Error(`${label} is missing proposals`);
    }
    if (parsed.proposals.some((proposal) => (
      task === "legacy_extract"
        ? !isLegacyExtractionProposal(proposal)
        : !isRecord(proposal)
    ))) {
      throw new Error(`${label} contains an invalid proposal`);
    }
    if (
      task === "legacy_extract"
      && parsed.noMemoryReason !== undefined
      && typeof parsed.noMemoryReason !== "string"
    ) {
      throw new Error("legacy extraction contains an invalid noMemoryReason");
    }
    if (
      task === "legacy_extract"
      && parsed.proposals.length === 0
      && (typeof parsed.noMemoryReason !== "string" || !parsed.noMemoryReason.trim())
    ) {
      throw new Error("empty legacy extraction requires noMemoryReason");
    }
  }
  if (task === "rerank") {
    if (
      !Array.isArray(parsed.claimIds)
      || parsed.claimIds.some((claimId) => typeof claimId !== "string")
    ) {
      throw new Error("memory rerank is missing valid claimIds");
    }
  }
  if (task === "legacy_consolidate") {
    if (!Array.isArray(parsed.claims) || !Array.isArray(parsed.discarded)) {
      throw new Error("legacy consolidation requires claims and discarded arrays");
    }
    if (parsed.claims.some((item) => (
      !isRecord(item)
      || !isPresentString(item.semanticKey)
      || !isPresentStringArray(item.sourceItemIds)
      || !isPresentString(item.subjectId)
      || !isPresentString(item.predicate)
      || !Object.prototype.hasOwnProperty.call(item, "value")
      || !isPresentString(item.canonicalText)
      || !isPresentString(item.topLevelType)
      || !isPresentString(item.epistemicStatus)
      || typeof item.confidence !== "number"
      || !Number.isFinite(item.confidence)
    ))) {
      throw new Error("legacy consolidation contains an invalid claim");
    }
    if (parsed.discarded.some((item) => (
      !isRecord(item)
      || !isPresentStringArray(item.sourceItemIds)
      || !isPresentString(item.reason)
    ))) {
      throw new Error("legacy consolidation contains an invalid discard");
    }
  }
}

function extractCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choice = (payload as {
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
    }>;
  }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const item = part as { text?: unknown; content?: unknown };
        if (typeof item.text === "string") return item.text;
        return typeof item.content === "string" ? item.content : "";
      })
      .join("")
      .trim();
  }
  return typeof choice?.text === "string" ? choice.text.trim() : "";
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("provider returned invalid JSON");
  }
}

function effectiveTimeout(requestedMs: number, configuredMs?: number): number {
  const requested = Number.isFinite(requestedMs) && requestedMs > 0
    ? Math.floor(requestedMs)
    : 1;
  if (configuredMs === undefined) return requested;
  return Math.max(1, Math.min(requested, configuredMs));
}

function effectiveMaxTokens(requested?: number): number {
  if (!Number.isFinite(requested) || Number(requested) <= 0) {
    return DEFAULT_COMPLETION_MAX_TOKENS;
  }
  return Math.min(MAX_COMPLETION_MAX_TOKENS, Math.floor(Number(requested)));
}

async function requestCompletion(
  candidate: CompletionCandidate,
  request: MemoryModelRequest,
  fetchImpl: FetchLike,
): Promise<string> {
  const timeoutMs = effectiveTimeout(request.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${candidate.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${candidate.config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: candidate.config.model,
        ...getOpenAICompletionsThinkingParams(candidate.config.model, "off"),
        temperature: COMPLETION_TEMPERATURE,
        max_tokens: effectiveMaxTokens(request.maxTokens),
        messages: [
          {
            role: "system",
            content: "严格按用户提示只返回一个 JSON 对象，不要输出 Markdown 或解释。",
          },
          {
            role: "user",
            content: request.prompt,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = extractCompletionText(await readJsonResponse(response));
    if (!content) throw new Error("provider returned no completion text");
    validateTaskOutput(content, request.task);
    return content;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseEmbeddingVectors(
  payload: unknown,
  expectedCount: number,
  expectedDimensions?: number,
): { dimensions: number; vectors: number[][] } {
  if (!payload || typeof payload !== "object") {
    throw new Error("embedding provider returned an invalid payload");
  }
  const data = (payload as {
    data?: Array<{ index?: unknown; embedding?: unknown }>;
  }).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error("embedding provider returned an invalid vector count");
  }
  const ordered = data.every((item) => Number.isInteger(item?.index))
    ? [...data].sort((left, right) => Number(left.index) - Number(right.index))
    : data;
  const vectors = ordered.map((item) => {
    if (
      !Array.isArray(item?.embedding)
      || item.embedding.length === 0
      || item.embedding.some((value) => (
        typeof value !== "number" || !Number.isFinite(value)
      ))
    ) {
      throw new Error("embedding provider returned an invalid vector");
    }
    return item.embedding as number[];
  });
  const dimensions = vectors[0]?.length ?? 0;
  if (
    dimensions === 0
    || vectors.some((vector) => vector.length !== dimensions)
    || (expectedDimensions !== undefined && dimensions !== expectedDimensions)
  ) {
    throw new Error("embedding provider returned inconsistent dimensions");
  }
  return { dimensions, vectors };
}

async function requestEmbeddings(
  config: MemoryEmbeddingModelConfig,
  texts: string[],
  requestedTimeoutMs: number,
  fetchImpl: FetchLike,
): Promise<{ model: string; dimensions: number; vectors: number[][] }> {
  if (texts.length === 0) {
    return {
      model: config.model,
      dimensions: config.expectedDimensions ?? 0,
      vectors: [],
    };
  }
  const timeoutMs = effectiveTimeout(requestedTimeoutMs, config.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        input: texts,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseEmbeddingVectors(
      await readJsonResponse(response),
      texts.length,
      config.expectedDimensions,
    );
    return {
      model: config.model,
      ...parsed,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createOpenAICompatibleMemoryModelClient(
  options: MemoryModelClientOptions,
): AsukaMemoryModelClient {
  const candidates = completionCandidates(options);
  const embedding = normalizeEmbeddingConfig(options.embedding);
  const secrets = [
    ...candidates.map((candidate) => candidate.config.apiKey),
    options.embedding?.apiKey ?? "",
  ];
  const fetchImpl = options.fetchImpl ?? fetch;
  const status: Readonly<MemoryModelClientStatus> = Object.freeze({
    completion: candidates.length > 0 ? "ready" : "unavailable",
    completionModels: candidates.length,
    embedding: embedding ? "ready" : "degraded",
    embeddingReason: embedding
      ? undefined
      : options.embedding
        ? "invalid_configuration"
        : "not_configured",
  });

  const client: AsukaMemoryModelClient = {
    status,
    async complete(request): Promise<string> {
      if (candidates.length === 0) {
        throw new Error("memory completion unavailable: no valid model configuration");
      }
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          return await requestCompletion(candidate, request, fetchImpl);
        } catch (error) {
          const reason = redactError(error, secrets);
          failures.push(`${candidate.role}: ${reason}`);
          warn(
            options.log,
            `[asuka-memory:model] ${candidate.role} model request failed: ${reason}`,
          );
        }
      }
      throw new Error(`memory completion failed (${failures.join("; ")})`);
    },
  };

  if (embedding) {
    client.embed = async (texts, timeoutMs) => {
      try {
        return await requestEmbeddings(embedding, texts, timeoutMs, fetchImpl);
      } catch (error) {
        const reason = redactError(error, secrets);
        warn(options.log, `[asuka-memory:model] embedding request failed: ${reason}`);
        throw new Error(`memory embedding failed: ${reason}`);
      }
    };
  }

  return client;
}
