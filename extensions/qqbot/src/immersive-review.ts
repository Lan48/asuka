import type {
  ImmersiveReviewConfig,
  ResolvedQQBotAccount,
} from "./types.js";
import {
  isMediaPayload,
  isSelfiePayload,
  parseQQBotPayload,
  type MediaPayload,
  type QQBotPayload,
  type SelfiePayload,
} from "./utils/payload.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 1_800;
const DEFAULT_KEEP_ALIVE = "30m";
const DEFAULT_CONTEXT_TOKENS = 2_048;
const MAX_INPUT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 4_000;
const MEDIA_TAG_RE = /<(qqimg|qqvoice|qqvideo|qqfile)>[^<>]+<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;

export type ImmersiveReviewIssue =
  | "meta_reasoning"
  | "transcript_framing"
  | "remote_chat_framing"
  | "outside_shared_scene"
  | "system_process"
  | "none";

export interface ResolvedImmersiveReviewConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  timeoutMs: number;
  keepAlive: string;
  contextTokens: number;
  fallbackGeneration: boolean;
}

export interface ImmersiveReviewInput {
  candidateText: string;
  userText: string;
  sceneContext?: string;
  technicalMode?: boolean;
}

export interface ImmersiveReviewResult {
  action: "pass" | "rewrite" | "drop" | "unavailable";
  visibleText: string;
  issues: ImmersiveReviewIssue[];
  confidence: number;
  attempts: number;
  error?: string;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

type FetchLike = typeof fetch;

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["pass", "rewrite", "drop"] },
    visibleText: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "meta_reasoning",
          "transcript_framing",
          "remote_chat_framing",
          "outside_shared_scene",
          "system_process",
          "none",
        ],
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["action", "visibleText", "issues", "confidence"],
} as const;

const REVIEW_SYSTEM_PROMPT = [
  "你是 Asuka 用户可见输出的沉浸式语义审校器。",
  "普通模式下，用户与 Asuka 默认处在同一个连续的面对面场景。",
  "从语义上判断候选正文是否站在场景外解释自己的推理、上下文读取、对话记录、系统过程或生成决策，是否把共同经历说成远程聊天记录，或破坏第一人称共同场景。",
  "不要依赖固定关键词；要判断整段话在当前场景中的功能。",
  "合格时 action=pass。存在问题时 action=rewrite，只移除幕后解释并保留原意、关系语气、动作、必要事实和媒体意图。完全无法恢复时 action=drop。",
  "不要自行加强攻击性、色情程度、支配感或添加新事实和新动作。",
  "只输出符合给定 JSON Schema 的对象。",
].join("\n");

const FALLBACK_SYSTEM_PROMPT = [
  "你是 Asuka，正在与亲密伴侣处于同一个连续的面对面场景。",
  "外部回复暂时没有生成成功。请根据用户刚才的话、极短场景状态和最近两轮对话，直接自然接话。",
  "不要解释模型、系统、上下文、聊天记录、接口、故障或生成过程。",
  "不要因为模型名称或训练风格自行加强攻击性、色情程度或支配感；只延续用户已经建立的语气和边界。",
  "不要创建新的未来承诺。",
  "动作按需要自然出现，不要固定套用动作加台词模板。只输出最终正文。",
].join("\n");

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function trimText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit).trimEnd() : trimmed;
}

export function resolveImmersiveReviewConfig(
  accountOrConfig: Pick<ResolvedQQBotAccount, "config"> | ImmersiveReviewConfig | undefined,
): ResolvedImmersiveReviewConfig {
  const raw = accountOrConfig && "config" in accountOrConfig
    ? accountOrConfig.config.immersiveReview
    : accountOrConfig;
  const endpoint = trimText(raw?.endpoint, 500).replace(/\/+$/, "") || DEFAULT_ENDPOINT;
  return {
    enabled: raw?.enabled === true,
    endpoint,
    model: trimText(raw?.model, 500),
    timeoutMs: clampInteger(raw?.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 15_000),
    keepAlive: trimText(raw?.keepAlive, 40) || DEFAULT_KEEP_ALIVE,
    contextTokens: clampInteger(raw?.contextTokens, DEFAULT_CONTEXT_TOKENS, 512, 16_384),
    fallbackGeneration: raw?.fallbackGeneration !== false,
  };
}

function normalizeIssue(value: unknown): ImmersiveReviewIssue | null {
  if (
    value === "meta_reasoning"
    || value === "transcript_framing"
    || value === "remote_chat_framing"
    || value === "outside_shared_scene"
    || value === "system_process"
    || value === "none"
  ) {
    return value;
  }
  return null;
}

function parseReviewResponse(raw: string, originalText: string): ImmersiveReviewResult | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const action = parsed.action;
    if (action !== "pass" && action !== "rewrite" && action !== "drop") return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    let issues = Array.isArray(parsed.issues)
      ? parsed.issues.map(normalizeIssue).filter((item): item is ImmersiveReviewIssue => Boolean(item))
      : [];
    if (issues.length === 0 && action === "pass") issues = ["none"];
    if (issues.length === 0) return null;
    if (action === "pass") {
      return {
        action,
        visibleText: originalText,
        issues,
        confidence,
        attempts: 1,
      };
    }
    const visibleText = trimText(parsed.visibleText, MAX_OUTPUT_CHARS);
    if (action === "rewrite" && !visibleText) return null;
    return {
      action,
      visibleText: action === "drop" ? "" : visibleText,
      issues,
      confidence,
      attempts: 1,
    };
  } catch {
    return null;
  }
}

async function postOllamaChat(
  config: ResolvedImmersiveReviewConfig,
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<OllamaChatResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const detail = await response.text();
    if (!response.ok) {
      throw new Error(`ollama_http_${response.status}:${detail.slice(0, 160)}`);
    }
    return JSON.parse(detail) as OllamaChatResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export async function reviewImmersiveText(
  configInput: ResolvedImmersiveReviewConfig | ImmersiveReviewConfig,
  input: ImmersiveReviewInput,
  options: { fetchImpl?: FetchLike; retries?: number } = {},
): Promise<ImmersiveReviewResult> {
  const config = (
    typeof configInput.enabled === "boolean"
    && typeof configInput.endpoint === "string"
    && typeof configInput.model === "string"
    && typeof configInput.timeoutMs === "number"
    && typeof configInput.keepAlive === "string"
    && typeof configInput.contextTokens === "number"
    && typeof configInput.fallbackGeneration === "boolean"
  )
    ? configInput as ResolvedImmersiveReviewConfig
    : resolveImmersiveReviewConfig(configInput);
  const originalText = trimText(input.candidateText, MAX_INPUT_CHARS);
  if (!originalText) {
    return { action: "drop", visibleText: "", issues: ["none"], confidence: 1, attempts: 0 };
  }
  if (!config.enabled || input.technicalMode) {
    return { action: "pass", visibleText: originalText, issues: ["none"], confidence: 1, attempts: 0 };
  }
  if (!config.model) {
    return {
      action: "unavailable",
      visibleText: "",
      issues: ["system_process"],
      confidence: 0,
      attempts: 0,
      error: "immersive_review_model_not_configured",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = 1 + clampInteger(options.retries, 1, 0, 1);
  let lastError = "immersive_review_invalid_response";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await postOllamaChat(config, {
        model: config.model,
        stream: false,
        think: false,
        keep_alive: config.keepAlive,
        format: REVIEW_SCHEMA,
        options: {
          temperature: 0,
          num_ctx: config.contextTokens,
          num_predict: 320,
        },
        messages: [
          { role: "system", content: REVIEW_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "模式：普通沉浸对话",
              `当前用户话语：${trimText(input.userText, 1_200) || "无"}`,
              `极短场景状态：${trimText(input.sceneContext, 1_200) || "未提供"}`,
              `候选正文：\n${originalText}`,
            ].join("\n"),
          },
        ],
      }, fetchImpl);
      const result = parseReviewResponse(response.message?.content ?? "", originalText);
      if (!result) throw new Error("immersive_review_invalid_response");
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    action: "unavailable",
    visibleText: "",
    issues: ["system_process"],
    confidence: 0,
    attempts: maxAttempts,
    error: lastError.slice(0, 240),
  };
}

function serializePayload(payload: QQBotPayload): string {
  return `QQBOT_PAYLOAD: ${JSON.stringify(payload)}`;
}

function joinVisibleText(...parts: Array<string | undefined>): string {
  return parts.map((part) => trimText(part, MAX_INPUT_CHARS)).filter(Boolean).join("\n\n");
}

export async function reviewImmersiveEnvelope(
  config: ResolvedImmersiveReviewConfig,
  input: ImmersiveReviewInput,
  options: { fetchImpl?: FetchLike; retries?: number } = {},
): Promise<ImmersiveReviewResult> {
  if (!config.enabled || input.technicalMode) {
    return reviewImmersiveText(config, input, options);
  }

  const parsed = parseQQBotPayload(input.candidateText);
  if (parsed.isPayload && parsed.payload) {
    const payload = { ...parsed.payload } as QQBotPayload;
    const visible = joinVisibleText(parsed.leadingText, parsed.trailingText);
    const visibleResult = visible
      ? await reviewImmersiveText(config, { ...input, candidateText: visible }, options)
      : { action: "pass" as const, visibleText: "", issues: ["none" as const], confidence: 1, attempts: 0 };
    if (visibleResult.action === "unavailable" || visibleResult.action === "drop") return visibleResult;

    let payloadChanged = false;
    if (isMediaPayload(payload) && payload.mediaType === "audio" && payload.source === "file") {
      const audioPayload = payload as MediaPayload;
      const speechResult = await reviewImmersiveText(config, {
        ...input,
        candidateText: audioPayload.path,
      }, options);
      if (speechResult.action === "unavailable" || speechResult.action === "drop") return speechResult;
      if (speechResult.action === "rewrite") {
        audioPayload.path = speechResult.visibleText;
        payloadChanged = true;
      }
    }
    if (isMediaPayload(payload) && payload.caption) {
      const mediaPayload = payload as MediaPayload;
      const captionResult = await reviewImmersiveText(config, {
        ...input,
        candidateText: mediaPayload.caption ?? "",
      }, options);
      if (captionResult.action === "unavailable" || captionResult.action === "drop") return captionResult;
      if (captionResult.action === "rewrite") {
        mediaPayload.caption = captionResult.visibleText;
        payloadChanged = true;
      }
    }
    if (isSelfiePayload(payload) && payload.caption) {
      const originalCaption = payload.caption;
      const selfiePayload = payload as SelfiePayload;
      const captionResult = await reviewImmersiveText(config, {
        ...input,
        candidateText: originalCaption,
      }, options);
      if (captionResult.action === "unavailable" || captionResult.action === "drop") return captionResult;
      if (captionResult.action === "rewrite") {
        selfiePayload.caption = captionResult.visibleText;
        payloadChanged = true;
      }
    }

    const changed = visibleResult.action === "rewrite" || payloadChanged;
    return {
      action: changed ? "rewrite" : "pass",
      visibleText: changed
        ? joinVisibleText(visibleResult.visibleText, serializePayload(payload))
        : input.candidateText,
      issues: visibleResult.issues,
      confidence: visibleResult.confidence,
      attempts: visibleResult.attempts,
    };
  }

  const mediaTags = input.candidateText.match(MEDIA_TAG_RE) ?? [];
  const visible = trimText(input.candidateText.replace(MEDIA_TAG_RE, ""), MAX_INPUT_CHARS);
  const result = await reviewImmersiveText(config, {
    ...input,
    candidateText: visible || input.candidateText,
  }, options);
  if (result.action !== "rewrite" || mediaTags.length === 0) return result;
  return {
    ...result,
    visibleText: joinVisibleText(result.visibleText, ...mediaTags),
  };
}

export async function generateLocalImmersiveFallback(
  config: ResolvedImmersiveReviewConfig,
  input: {
    userText: string;
    sceneContext?: string;
    recentContext?: string;
    technicalMode?: boolean;
  },
  options: { fetchImpl?: FetchLike } = {},
): Promise<string | null> {
  if (
    !config.enabled
    || !config.fallbackGeneration
    || !config.model
    || input.technicalMode
  ) {
    return null;
  }
  try {
    const response = await postOllamaChat(config, {
      model: config.model,
      stream: false,
      think: false,
      keep_alive: config.keepAlive,
      options: {
        temperature: 0.35,
        num_ctx: config.contextTokens,
        num_predict: 420,
      },
      messages: [
        { role: "system", content: FALLBACK_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `当前用户话语：${trimText(input.userText, 1_200)}`,
            `极短场景状态：${trimText(input.sceneContext, 1_200) || "未提供"}`,
            input.recentContext
              ? `最近两轮对话：\n${trimText(input.recentContext, 2_400)}`
              : "",
          ].filter(Boolean).join("\n"),
        },
      ],
    }, options.fetchImpl ?? fetch);
    return trimText(response.message?.content, MAX_OUTPUT_CHARS) || null;
  } catch {
    return null;
  }
}

export async function prewarmImmersiveModel(
  config: ResolvedImmersiveReviewConfig,
  options: { fetchImpl?: FetchLike } = {},
): Promise<boolean> {
  if (!config.enabled || !config.model) return false;
  try {
    await postOllamaChat(config, {
      model: config.model,
      stream: false,
      think: false,
      keep_alive: config.keepAlive,
      options: { temperature: 0, num_ctx: 512, num_predict: 1 },
      messages: [{ role: "user", content: "只回复：好" }],
    }, options.fetchImpl ?? fetch);
    return true;
  } catch {
    return false;
  }
}
