const DEFAULT_MINIMAX_SEARCH_MAX_RESULTS = 5;
const DEFAULT_MINIMAX_SEARCH_QUERY_MAX_CHARS = 120;
const DEFAULT_MINIMAX_SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_MINIMAX_SEARCH_RESULT_MAX_CHARS = 1600;
const DEFAULT_MINIMAX_SEARCH_INTENT_TIMEOUT_MS = 45_000;
const DEFAULT_MINIMAX_SEARCH_INTENT_MODEL = "MiniMax-M2.7";

const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-cp-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g;
const TOKEN_ASSIGNMENT_RE = /\b(?:api[_-]?key|token|secret|password|passwd|clientSecret|Authorization|Bearer)\s*[:=]\s*\S+/gi;

export interface MiniMaxSearchConfig {
  enabled: boolean;
  provider: "minimax";
  baseUrl: string;
  apiKey: string;
  intentModel: string;
  maxResults: number;
  queryMaxChars: number;
  resultMaxChars: number;
  timeoutMs: number;
  intentTimeoutMs: number;
}

export interface MiniMaxSearchIntentInput {
  userText: string;
  recentContext?: string;
  currentLocalTime?: string;
  isProactive?: boolean;
}

export interface MiniMaxSearchTrigger {
  shouldSearch: boolean;
  reason: "llm" | "private" | "empty" | "offline" | "intent-failed";
  query: string;
  confidence?: number;
}

export interface MiniMaxSearchResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
}

export interface MiniMaxSearchSummary {
  query: string;
  results: MiniMaxSearchResult[];
  failed?: boolean;
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

function normalizeMiniMaxApiRoot(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

function buildMiniMaxSearchEndpoint(baseUrl: string): string {
  return `${normalizeMiniMaxApiRoot(baseUrl)}/v1/coding_plan/search`;
}

function buildMiniMaxIntentEndpoint(baseUrl: string): string {
  return `${normalizeMiniMaxApiRoot(baseUrl)}/anthropic/v1/messages`;
}

function stripSecret(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

function extractTextFromMiniMaxMessage(response: unknown): string {
  const body = getObject(response);
  if (typeof body?.content === "string") return body.content;
  if (Array.isArray(body?.content)) {
    return body.content
      .map((part: unknown) => getObject(part)?.text)
      .filter((text: unknown): text is string => typeof text === "string")
      .join("");
  }
  return getStringValue(body?.text, body?.message, body?.choices?.[0]?.message?.content);
}

function extractJsonObject(text: string): Record<string, any> | undefined {
  const trimmed = text.trim();
  const raw = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function resolveMiniMaxSearchConfig(rootConfig: Record<string, unknown>): MiniMaxSearchConfig | undefined {
  const provider = getObject(rootConfig.models)?.providers?.minimax
    ? getObject(getObject(rootConfig.models)?.providers?.minimax)
    : undefined;
  const qqbot = getObject(getObject(rootConfig.channels)?.qqbot);
  const block = getObject(getObject(qqbot?.minimax)?.search);
  if (!isEnabledBlock(block)) return undefined;

  const baseUrl = getStringValue(block?.baseUrl, provider?.baseUrl, process.env.MINIMAX_BASE_URL, "https://api.minimaxi.com/v1");
  const apiKey = getStringValue(block?.apiKey, provider?.apiKey, process.env.MINIMAX_API_KEY);
  if (!baseUrl || !apiKey) return undefined;

  return {
    enabled: true,
    provider: "minimax",
    baseUrl,
    apiKey,
    intentModel: getStringValue(block?.intentModel, block?.model, provider?.models?.[0]?.id, provider?.model, DEFAULT_MINIMAX_SEARCH_INTENT_MODEL),
    maxResults: Math.max(1, Math.min(8, Math.floor(getNumberValue(block?.maxResults, DEFAULT_MINIMAX_SEARCH_MAX_RESULTS)))),
    queryMaxChars: Math.max(20, Math.floor(getNumberValue(block?.queryMaxChars ?? block?.maxQueryChars, DEFAULT_MINIMAX_SEARCH_QUERY_MAX_CHARS))),
    resultMaxChars: Math.max(300, Math.floor(getNumberValue(block?.resultMaxChars, DEFAULT_MINIMAX_SEARCH_RESULT_MAX_CHARS))),
    timeoutMs: Math.max(1_000, Math.floor(getNumberValue(block?.timeoutMs, DEFAULT_MINIMAX_SEARCH_TIMEOUT_MS))),
    intentTimeoutMs: Math.max(1_000, Math.floor(getNumberValue(block?.intentTimeoutMs, DEFAULT_MINIMAX_SEARCH_INTENT_TIMEOUT_MS))),
  };
}

export function sanitizeSearchQuery(text: string, maxChars: number = DEFAULT_MINIMAX_SEARCH_QUERY_MAX_CHARS): string {
  return truncate(
    text
      .replace(/<qq(?:img|voice|video|file)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi, " ")
      .replace(TOKEN_ASSIGNMENT_RE, "[redacted]")
      .replace(SECRET_RE, "[redacted]")
      .replace(/\b\d{11,}\b/g, "[number]")
      .replace(/[“”"']/g, "")
      .replace(/\s+/g, " "),
    maxChars,
  );
}

export async function analyzeMiniMaxSearchIntent(
  input: MiniMaxSearchIntentInput,
  config: MiniMaxSearchConfig,
): Promise<MiniMaxSearchTrigger> {
  const sanitizedUserText = sanitizeSearchQuery(input.userText, 800);
  if (!sanitizedUserText) return { shouldSearch: false, reason: "empty", query: "" };
  if (input.isProactive) return { shouldSearch: false, reason: "offline", query: "" };

  const system = [
    "你是陪伴型聊天 agent 的联网搜索意图门控。",
    "用户不会也不应该学习命令；不要因为某个关键词本身就判定要搜索。",
    "你必须结合用户话语、上下文和当前时间，判断如果不联网是否会无法可靠回答。",
    "只有在需要当前、最近、外部可验证的信息，或用户自然表达了想让你查证外部信息时，才 shouldSearch=true。",
    "日常陪伴、亲密互动、情绪安抚、关系记忆、私密对话、用户个人信息、角色扮演和不需要外部事实的问题都 shouldSearch=false。",
    "输出严格 JSON，不要解释。",
  ].join("\n");
  const user = [
    `当前本地时间: ${input.currentLocalTime || new Date().toISOString()}`,
    input.recentContext ? `最近上下文:\n${truncate(input.recentContext, 1200)}` : "最近上下文: （无）",
    `用户当前消息:\n${sanitizedUserText}`,
    "",
    "返回 JSON schema:",
    '{"shouldSearch":boolean,"query":"适合联网搜索的脱敏查询；不搜索则空字符串","reason":"一句很短的中文理由","confidence":0到1}',
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.intentTimeoutMs);
  try {
    const response = await fetch(buildMiniMaxIntentEndpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.intentModel,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const detail = stripSecret(await response.text().catch(() => ""), config.apiKey);
      return { shouldSearch: false, reason: "intent-failed", query: truncate(detail, 120) };
    }

    const text = extractTextFromMiniMaxMessage(await response.json());
    const parsed = extractJsonObject(text);
    const shouldSearch = parsed?.shouldSearch === true;
    const rawQuery = shouldSearch ? getStringValue(parsed?.query, sanitizedUserText) : "";
    const query = sanitizeSearchQuery(rawQuery, config.queryMaxChars);
    const confidence = typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;
    return {
      shouldSearch: shouldSearch && Boolean(query),
      reason: shouldSearch && query ? "llm" : "offline",
      query,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  } catch (error) {
    clearTimeout(timeout);
    const reason = error instanceof Error ? stripSecret(error.message, config.apiKey) : "intent-failed";
    return { shouldSearch: false, reason: "intent-failed", query: truncate(reason, 120) };
  }
}

export async function queryMiniMaxSearch(query: string, config: MiniMaxSearchConfig): Promise<MiniMaxSearchSummary> {
  const sanitizedQuery = sanitizeSearchQuery(query, config.queryMaxChars);
  if (!sanitizedQuery) return { query: "", results: [], failed: true, reason: "empty-query" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(buildMiniMaxSearchEndpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: sanitizedQuery }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const detail = stripSecret(await response.text().catch(() => ""), config.apiKey);
      return { query: sanitizedQuery, results: [], failed: true, reason: `HTTP ${response.status}: ${detail.slice(0, 240)}` };
    }

    const body = await response.json();
    const baseResp = getObject(body?.base_resp);
    if (baseResp && Number(baseResp.status_code ?? 0) !== 0) {
      const message = stripSecret(getStringValue(baseResp.status_msg, "provider-error"), config.apiKey);
      return { query: sanitizedQuery, results: [], failed: true, reason: message.slice(0, 240) };
    }

    const rawResults = Array.isArray(body?.organic) ? body.organic : [];
    const results = rawResults.slice(0, config.maxResults).map((item: unknown): MiniMaxSearchResult => {
      const row = getObject(item) ?? {};
      return {
        title: getStringValue(row.title, "Untitled"),
        link: getStringValue(row.link, row.url),
        ...(getStringValue(row.snippet) ? { snippet: getStringValue(row.snippet) } : {}),
        ...(getStringValue(row.date) ? { date: getStringValue(row.date) } : {}),
      };
    }).filter((item: MiniMaxSearchResult) => item.title || item.link);

    return { query: sanitizedQuery, results };
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return { query: sanitizedQuery, results: [], failed: true, reason: "MiniMax search timed out" };
    }
    return {
      query: sanitizedQuery,
      results: [],
      failed: true,
      reason: error instanceof Error ? stripSecret(error.message, config.apiKey).slice(0, 240) : "provider-error",
    };
  }
}

export function formatSearchSummaryForPrompt(summary: MiniMaxSearchSummary | undefined, checkedAt: string): string {
  if (!summary) return "";
  if (summary.failed) {
    return [
      "【联网搜索】",
      `- 查询: ${summary.query}`,
      `- 搜索失败: ${summary.reason ?? "provider-error"}`,
      "- 只用于当前这轮回复；不要把搜索结果自动写入长期记忆。若信息关键，应告诉用户搜索暂时不可用或建议稍后再确认。",
    ].join("\n");
  }

  const lines = summary.results.length > 0
    ? summary.results.map((result, index) => {
        const snippet = result.snippet ? ` — ${truncate(result.snippet, 180)}` : "";
        const date = result.date ? ` (${result.date})` : "";
        const link = result.link ? ` ${result.link}` : "";
        return `  ${index + 1}. ${result.title}${date}${snippet}${link}`;
      })
    : ["  无结果"];

  return truncate([
    "【联网搜索】",
    `- 查询: ${summary.query}`,
    `- 搜索时间: ${checkedAt}`,
    "- 以下结果只用于当前这轮回复；不要把搜索结果自动写入长期记忆。回答需要体现来源/时间不确定性。",
    ...lines,
  ].join("\n"), DEFAULT_MINIMAX_SEARCH_RESULT_MAX_CHARS);
}
