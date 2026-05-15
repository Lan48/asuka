import fs from "node:fs";
import path from "node:path";

const DEFAULT_MINIMAX_VISION_MODEL = "MiniMax-VLM";
const DEFAULT_MINIMAX_VISION_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MINIMAX_VISION_MAX_IMAGES = 3;
const DEFAULT_MINIMAX_VISION_MAX_SUMMARY_CHARS = 700;
const DEFAULT_MINIMAX_VISION_TIMEOUT_MS = 45_000;
const DEFAULT_MINIMAX_VISION_PROMPT = [
  "请用简体中文简洁描述这张图片。",
  "重点提取用户可能在聊天里关心的可见内容、文字、人物动作、场景和情绪。",
  "不要编造看不见的信息；不确定就说不确定。",
  "控制在 120 字以内。",
].join("\n");

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const DEFAULT_SUPPORTED_CONTENT_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXT));

export interface MiniMaxVisionConfig {
  enabled: boolean;
  provider: "minimax";
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxInputBytes: number;
  maxImagesPerMessage: number;
  maxSummaryChars: number;
  timeoutMs: number;
  supportedContentTypes: Set<string>;
}

export interface VisionImageInput {
  pathOrUrl: string;
  contentType?: string;
  filename?: string;
}

export type VisionImageStatus = "summarized" | "skipped" | "failed";

export interface VisionImageResult {
  status: VisionImageStatus;
  label: string;
  contentType: string;
  summary?: string;
  reason?: string;
}

function getObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function getStringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getNumberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function isEnabledBlock(block: Record<string, any> | undefined): boolean {
  if (!block) return false;
  return block.enabled !== false;
}

function normalizeContentType(contentType?: string): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() || "";
}

function inferImageContentType(input: VisionImageInput): string {
  const declared = normalizeContentType(input.contentType);
  if (declared) return declared;
  const ext = path.extname(input.filename || input.pathOrUrl).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || "";
}

function buildMiniMaxCodingPlanEndpoint(baseUrl: string, endpoint: "vlm" | "search"): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const root = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${root}/coding_plan/${endpoint}`;
}

function extractVisionContent(response: unknown): string {
  const body = getObject(response);
  const content = getStringValue(
    body?.content,
    body?.data?.content,
    body?.result,
    body?.message
  );
  if (content) return content;
  throw new Error("MiniMax vision response did not contain content");
}

function stripSecret(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function imageToDataUri(input: VisionImageInput, contentType: string, maxInputBytes: number): string {
  if (/^https:\/\//i.test(input.pathOrUrl)) {
    return input.pathOrUrl;
  }
  if (/^data:image\//i.test(input.pathOrUrl)) {
    return input.pathOrUrl;
  }
  if (!path.isAbsolute(input.pathOrUrl)) {
    throw new Error("image-source-not-local-absolute-path");
  }
  const stat = fs.statSync(input.pathOrUrl);
  if (!stat.isFile()) throw new Error("image-source-not-file");
  if (stat.size > maxInputBytes) throw new Error("image-too-large");
  const data = fs.readFileSync(input.pathOrUrl);
  return `data:${contentType};base64,${data.toString("base64")}`;
}

export function resolveMiniMaxVisionConfig(rootConfig: Record<string, unknown>): MiniMaxVisionConfig | undefined {
  const provider = getObject(rootConfig.models)?.providers?.minimax
    ? getObject(getObject(rootConfig.models)?.providers?.minimax)
    : undefined;
  const qqbot = getObject(getObject(rootConfig.channels)?.qqbot);
  const block = getObject(getObject(qqbot?.minimax)?.vision);
  if (!isEnabledBlock(block)) return undefined;

  const baseUrl = getStringValue(block?.baseUrl, provider?.baseUrl, process.env.MINIMAX_BASE_URL, "https://api.minimaxi.com/v1");
  const apiKey = getStringValue(block?.apiKey, provider?.apiKey, process.env.MINIMAX_API_KEY);
  if (!baseUrl || !apiKey) return undefined;

  const supportedContentTypes = new Set(
    Array.isArray(block?.supportedContentTypes)
      ? block.supportedContentTypes.map((item: unknown) => normalizeContentType(String(item))).filter(Boolean)
      : DEFAULT_SUPPORTED_CONTENT_TYPES
  );

  return {
    enabled: true,
    provider: "minimax",
    baseUrl,
    apiKey,
    model: getStringValue(block?.model, provider?.models?.[0]?.id, provider?.model, DEFAULT_MINIMAX_VISION_MODEL),
    prompt: getStringValue(block?.prompt, DEFAULT_MINIMAX_VISION_PROMPT),
    maxInputBytes: getNumberValue(block?.maxInputBytes, DEFAULT_MINIMAX_VISION_MAX_INPUT_BYTES),
    maxImagesPerMessage: Math.max(1, Math.floor(getNumberValue(block?.maxImagesPerMessage, DEFAULT_MINIMAX_VISION_MAX_IMAGES))),
    maxSummaryChars: Math.max(80, Math.floor(getNumberValue(block?.maxSummaryChars, DEFAULT_MINIMAX_VISION_MAX_SUMMARY_CHARS))),
    timeoutMs: Math.max(1_000, Math.floor(getNumberValue(block?.timeoutMs, DEFAULT_MINIMAX_VISION_TIMEOUT_MS))),
    supportedContentTypes,
  };
}

export function validateVisionImage(input: VisionImageInput, config: MiniMaxVisionConfig): { ok: true; contentType: string } | { ok: false; contentType: string; reason: string } {
  const contentType = inferImageContentType(input);
  if (!contentType || !config.supportedContentTypes.has(contentType)) {
    return { ok: false, contentType: contentType || "unknown", reason: "unsupported-image-type" };
  }
  if (/^https?:\/\//i.test(input.pathOrUrl) && !/^https:\/\//i.test(input.pathOrUrl)) {
    return { ok: false, contentType, reason: "insecure-image-url" };
  }
  if (!/^https:\/\//i.test(input.pathOrUrl) && !/^data:image\//i.test(input.pathOrUrl)) {
    if (!path.isAbsolute(input.pathOrUrl)) {
      return { ok: false, contentType, reason: "image-source-not-local-absolute-path" };
    }
    try {
      const stat = fs.statSync(input.pathOrUrl);
      if (!stat.isFile()) return { ok: false, contentType, reason: "image-source-not-file" };
      if (stat.size > config.maxInputBytes) return { ok: false, contentType, reason: "image-too-large" };
    } catch {
      return { ok: false, contentType, reason: "image-file-unavailable" };
    }
  }
  return { ok: true, contentType };
}

export async function describeImageWithMiniMax(input: VisionImageInput, config: MiniMaxVisionConfig): Promise<string> {
  const validation = validateVisionImage(input, config);
  if (!validation.ok) throw new Error(validation.reason);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(buildMiniMaxCodingPlanEndpoint(config.baseUrl, "vlm"), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: config.prompt,
        image_url: imageToDataUri(input, validation.contentType, config.maxInputBytes),
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const detail = stripSecret(await response.text().catch(() => ""), config.apiKey);
      throw new Error(`MiniMax vision failed: HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const body = await response.json();
    const baseResp = getObject(body?.base_resp);
    if (baseResp && Number(baseResp.status_code ?? 0) !== 0) {
      const message = stripSecret(getStringValue(baseResp.status_msg, "provider-error"), config.apiKey);
      throw new Error(`MiniMax vision failed: ${message.slice(0, 300)}`);
    }

    return truncate(extractVisionContent(body), config.maxSummaryChars);
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new Error("MiniMax vision timed out");
    }
    throw error;
  }
}

export async function summarizeImagesForPrompt(
  images: VisionImageInput[],
  config: MiniMaxVisionConfig | undefined,
): Promise<VisionImageResult[]> {
  if (!config || images.length === 0) return [];
  const results: VisionImageResult[] = [];
  const limitedImages = images.slice(0, config.maxImagesPerMessage);

  for (let i = 0; i < limitedImages.length; i++) {
    const image = limitedImages[i]!;
    const validation = validateVisionImage(image, config);
    const label = image.filename || path.basename(image.pathOrUrl) || `image-${i + 1}`;
    if (!validation.ok) {
      results.push({
        status: "skipped",
        label,
        contentType: validation.contentType,
        reason: validation.reason,
      });
      continue;
    }
    try {
      results.push({
        status: "summarized",
        label,
        contentType: validation.contentType,
        summary: await describeImageWithMiniMax(image, config),
      });
    } catch (error) {
      results.push({
        status: "failed",
        label,
        contentType: validation.contentType,
        reason: error instanceof Error ? stripSecret(error.message, config.apiKey) : "provider-error",
      });
    }
  }

  const skippedCount = images.length - limitedImages.length;
  if (skippedCount > 0) {
    results.push({
      status: "skipped",
      label: `${skippedCount} image(s)`,
      contentType: "unknown",
      reason: "max-images-per-message-exceeded",
    });
  }

  return results;
}

export function formatImageUnderstandingForPrompt(results: VisionImageResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((result, index) => {
    const prefix = `- 图片${index + 1} (${result.contentType}, ${result.label})`;
    if (result.status === "summarized") {
      return `${prefix}: ${result.summary}`;
    }
    return `${prefix}: 未分析（${result.reason ?? result.status}）`;
  });
  return [
    "【图片理解】",
    "以下图片摘要只用于当前这轮回复；不要自动写入长期记忆。只有用户明确要求记住时，才可依据用户文字意图记录必要、非敏感的信息。",
    ...lines,
  ].join("\n");
}
