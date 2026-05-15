import fs from "node:fs";
import path from "node:path";
import type { AsukaPeerContext } from "./asuka-state.js";
import { makePeerKey } from "./asuka-state.js";
import { getEntriesForPeerSince } from "./ref-index-store.js";
import { getQQBotDataDir } from "./utils/platform.js";

const DIGEST_DIR = getQQBotDataDir("data", "asuka-conversation-digest");
const DIGEST_FILE = path.join(DIGEST_DIR, "digest.json");
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_DAILY_DAYS = 7;
const DEFAULT_DIGEST_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_DIGEST_MODEL = "MiniMax-M2.7";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_HISTORY_CHARS = 30_000;
const DEFAULT_MAX_DIGEST_CHARS = 5_200;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 20_000;
const DEFAULT_MAX_HISTORY_ENTRIES = 512;
const MAX_FIELD_CHARS = 420;
const MAX_ARRAY_ITEMS = 10;
const runningUpdates = new Set<string>();
const cache: { state: ConversationDigestStateFile | null } = { state: null };

export interface ConversationWeeklyDigest {
  relationshipContinuity: string;
  recentEmotionalArc: string;
  currentOpenLoops: string[];
  userPreferences: string[];
  asukaSelfContinuity: string;
  sceneContinuity: string;
  importantRecentFacts: string[];
  thingsToAvoid: string[];
  lastSalientTurns: string[];
}

export interface ConversationDailyDigest {
  date: string;
  detailLevel: "detailed" | "balanced" | "brief";
  relationshipContinuity: string;
  emotionalArc: string;
  openLoops: string[];
  userPreferences: string[];
  asukaSelfContinuity: string;
  sceneContinuity: string;
  importantFacts: string[];
  thingsToAvoid: string[];
  salientTurns: string[];
}

export interface LegacyConversationDigest extends ConversationWeeklyDigest {
  version: 1;
  peerKey: string;
  window: "7d";
  updatedAt: number;
  coveredUntil: number;
}

export interface ConversationDigest {
  version: 2;
  peerKey: string;
  window: "7d";
  updatedAt: number;
  coveredUntil: number;
  timeZone: string;
  weekly: ConversationWeeklyDigest;
  daily: ConversationDailyDigest[];
}

interface ConversationDigestStateFile {
  version: 1 | 2;
  digests: Record<string, ConversationDigest | LegacyConversationDigest>;
}

interface MiniMaxDigestConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxHistoryChars: number;
  maxDigestChars: number;
  minUpdateIntervalMs: number;
  maxHistoryEntries: number;
}

interface ConversationDigestUpdateInput {
  rootConfig: Record<string, unknown>;
  userText: string;
  assistantText: string;
  now?: number;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

function emptyState(): ConversationDigestStateFile {
  return { version: 2, digests: {} };
}

function loadState(): ConversationDigestStateFile {
  if (cache.state) return cache.state;
  try {
    if (!fs.existsSync(DIGEST_FILE)) {
      cache.state = emptyState();
      return cache.state;
    }
    const parsed = JSON.parse(fs.readFileSync(DIGEST_FILE, "utf-8")) as Partial<ConversationDigestStateFile>;
    cache.state = {
      version: parsed.version === 2 ? 2 : 1,
      digests: parsed.digests ?? {},
    };
    return cache.state;
  } catch (error) {
    console.error(`[asuka-digest] Failed to load digest: ${error}`);
    cache.state = emptyState();
    return cache.state;
  }
}

function saveState(): void {
  if (!cache.state) return;
  try {
    fs.mkdirSync(DIGEST_DIR, { recursive: true });
    fs.writeFileSync(DIGEST_FILE, JSON.stringify(cache.state, null, 2), "utf-8");
  } catch (error) {
    console.error(`[asuka-digest] Failed to save digest: ${error}`);
  }
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
  if (!block) return true;
  return block.enabled !== false;
}

function normalizeMiniMaxApiRoot(baseUrl: string): string {
  let normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/anthropic/v1")) normalized = normalized.slice(0, -13);
  if (normalized.endsWith("/anthropic")) normalized = normalized.slice(0, -10);
  if (normalized.endsWith("/v1")) normalized = normalized.slice(0, -3);
  return normalized;
}

function buildMiniMaxMessagesEndpoint(baseUrl: string): string {
  return `${normalizeMiniMaxApiRoot(baseUrl)}/anthropic/v1/messages`;
}

export function resolveMiniMaxDigestConfig(rootConfig: Record<string, unknown>): MiniMaxDigestConfig | undefined {
  const root = rootConfig as Record<string, any>;
  const provider = getObject(root.models)?.providers?.minimax
    ? getObject(getObject(root.models)?.providers?.minimax)
    : undefined;
  const qqbot = getObject(getObject(root.channels)?.qqbot);
  const minimax = getObject(qqbot?.minimax);
  const block = getObject(minimax?.digest);
  if (!isEnabledBlock(block)) return undefined;

  const search = getObject(minimax?.search);
  const vision = getObject(minimax?.vision);
  const baseUrl = getStringValue(
    block?.baseUrl,
    search?.baseUrl,
    vision?.baseUrl,
    provider?.baseUrl,
    process.env.MINIMAX_BASE_URL,
    "https://api.minimaxi.com/v1",
  );
  const apiKey = getStringValue(
    block?.apiKey,
    search?.apiKey,
    vision?.apiKey,
    provider?.apiKey,
    process.env.MINIMAX_API_KEY,
  );
  if (!baseUrl || !apiKey) return undefined;

  return {
    enabled: true,
    baseUrl,
    apiKey,
    model: getStringValue(block?.model, search?.intentModel, search?.model, provider?.models?.[0]?.id, provider?.model, DEFAULT_DIGEST_MODEL),
    timeoutMs: Math.max(1_000, Math.floor(getNumberValue(block?.timeoutMs, DEFAULT_TIMEOUT_MS))),
    maxHistoryChars: Math.max(4_000, Math.floor(getNumberValue(block?.maxHistoryChars, DEFAULT_MAX_HISTORY_CHARS))),
    maxDigestChars: Math.max(800, Math.floor(getNumberValue(block?.maxDigestChars, DEFAULT_MAX_DIGEST_CHARS))),
    minUpdateIntervalMs: Math.max(0, Math.floor(getNumberValue(block?.minUpdateIntervalMs, DEFAULT_MIN_UPDATE_INTERVAL_MS))),
    maxHistoryEntries: Math.max(20, Math.floor(getNumberValue(block?.maxHistoryEntries, DEFAULT_MAX_HISTORY_ENTRIES))),
  };
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeDigestText(text: string | undefined, maxChars = MAX_FIELD_CHARS): string {
  if (!text) return "";
  const sanitized = text
    .replace(/QQBOT_(?:PAYLOAD|CRON):[\s\S]*?(?=\n\n|$)/gi, " ")
    .replace(/<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi, " ")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-cp-[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|clientSecret|Authorization|Bearer)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (/工具调用|调试信息|API 调用|脚本|进程状态|通道规则/i.test(sanitized)) return "";
  return truncate(sanitized, maxChars);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeDigestText(typeof item === "string" ? item : "", MAX_FIELD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ARRAY_ITEMS);
}

function normalizeDetailLevel(value: unknown, fallback: ConversationDailyDigest["detailLevel"]): ConversationDailyDigest["detailLevel"] {
  return value === "detailed" || value === "balanced" || value === "brief" ? value : fallback;
}

function normalizeWeeklyDigest(value: unknown): ConversationWeeklyDigest {
  const input = getObject(value) ?? {};
  return {
    relationshipContinuity: sanitizeDigestText(input.relationshipContinuity, 520),
    recentEmotionalArc: sanitizeDigestText(input.recentEmotionalArc, 420),
    currentOpenLoops: normalizeStringArray(input.currentOpenLoops),
    userPreferences: normalizeStringArray(input.userPreferences),
    asukaSelfContinuity: sanitizeDigestText(input.asukaSelfContinuity, 420),
    sceneContinuity: sanitizeDigestText(input.sceneContinuity, 420),
    importantRecentFacts: normalizeStringArray(input.importantRecentFacts),
    thingsToAvoid: normalizeStringArray(input.thingsToAvoid),
    lastSalientTurns: normalizeStringArray(input.lastSalientTurns),
  };
}

function dailyFieldLimit(level: ConversationDailyDigest["detailLevel"]): number {
  if (level === "detailed") return 520;
  if (level === "balanced") return 360;
  return 220;
}

function dailyArrayLimit(level: ConversationDailyDigest["detailLevel"]): number {
  if (level === "detailed") return 8;
  if (level === "balanced") return 5;
  return 3;
}

function normalizeDailyDigest(value: unknown, fallbackDate: string, fallbackLevel: ConversationDailyDigest["detailLevel"]): ConversationDailyDigest | null {
  const input = getObject(value);
  if (!input) return null;
  const date = getStringValue(input.date, fallbackDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const detailLevel = normalizeDetailLevel(input.detailLevel, fallbackLevel);
  const fieldLimit = dailyFieldLimit(detailLevel);
  const arrayLimit = dailyArrayLimit(detailLevel);
  const clampArray = (arrayValue: unknown): string[] => normalizeStringArray(arrayValue).slice(0, arrayLimit);
  return {
    date,
    detailLevel,
    relationshipContinuity: sanitizeDigestText(input.relationshipContinuity, fieldLimit),
    emotionalArc: sanitizeDigestText(input.emotionalArc ?? input.recentEmotionalArc, fieldLimit),
    openLoops: clampArray(input.openLoops ?? input.currentOpenLoops),
    userPreferences: clampArray(input.userPreferences),
    asukaSelfContinuity: sanitizeDigestText(input.asukaSelfContinuity, fieldLimit),
    sceneContinuity: sanitizeDigestText(input.sceneContinuity, fieldLimit),
    importantFacts: clampArray(input.importantFacts ?? input.importantRecentFacts),
    thingsToAvoid: clampArray(input.thingsToAvoid),
    salientTurns: clampArray(input.salientTurns ?? input.lastSalientTurns),
  };
}

function fallbackDetailLevelForIndex(index: number, total: number): ConversationDailyDigest["detailLevel"] {
  const ageFromNewest = total - index - 1;
  if (ageFromNewest <= 1) return "detailed";
  if (ageFromNewest <= 3) return "balanced";
  return "brief";
}

function normalizeDailyDigests(value: unknown): ConversationDailyDigest[] {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw
    .map((item, index) => normalizeDailyDigest(item, "", fallbackDetailLevelForIndex(index, raw.length)))
    .filter((item): item is ConversationDailyDigest => Boolean(item))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-DIGEST_DAILY_DAYS);

  const total = normalized.length;
  return normalized.map((item, index) => ({
    ...item,
    detailLevel: normalizeDetailLevel(item.detailLevel, fallbackDetailLevelForIndex(index, total)),
  }));
}

function normalizeDigest(value: unknown, peerKey: string, now: number, maxDigestChars: number, coveredUntil: number): ConversationDigest {
  const input = getObject(value) ?? {};
  const weeklyInput = getObject(input.weekly) ?? input;
  const digest: ConversationDigest = {
    version: 2,
    peerKey,
    window: "7d",
    updatedAt: now,
    coveredUntil,
    timeZone: getStringValue(input.timeZone, DEFAULT_DIGEST_TIME_ZONE),
    weekly: normalizeWeeklyDigest(weeklyInput),
    daily: normalizeDailyDigests(input.daily),
  };
  return trimDigestToBudget(digest, maxDigestChars);
}

function digestPromptSize(digest: ConversationDigest): number {
  return formatConversationDigestForPrompt(digest).length;
}

function trimDigestToBudget(digest: ConversationDigest, maxChars: number): ConversationDigest {
  const next: ConversationDigest = {
    ...digest,
    weekly: { ...digest.weekly },
    daily: digest.daily.map((item) => ({ ...item })),
  };
  for (const day of next.daily) {
    while (digestPromptSize(next) > maxChars && day.salientTurns.length > 0) day.salientTurns.pop();
    while (digestPromptSize(next) > maxChars && day.importantFacts.length > 0) day.importantFacts.pop();
    while (digestPromptSize(next) > maxChars && day.openLoops.length > 0 && day.detailLevel !== "detailed") day.openLoops.pop();
  }
  while (digestPromptSize(next) > maxChars && next.weekly.lastSalientTurns.length > 0) next.weekly.lastSalientTurns.pop();
  while (digestPromptSize(next) > maxChars && next.weekly.importantRecentFacts.length > 0) next.weekly.importantRecentFacts.pop();
  while (digestPromptSize(next) > maxChars && next.weekly.currentOpenLoops.length > 0) next.weekly.currentOpenLoops.pop();
  while (digestPromptSize(next) > maxChars && next.daily.length > 2) next.daily.shift();
  return next;
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

function trimHistoryLines(lines: string[], maxChars: number): string {
  const selected: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const nextTotal = total + line.length + (selected.length > 0 ? 1 : 0);
    if (nextTotal > maxChars) break;
    selected.unshift(line);
    total = nextTotal;
  }
  return selected.join("\n");
}

function formatLocalDate(timestamp: number, timeZone = DEFAULT_DIGEST_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function formatDailyHistory(entries: ReturnType<typeof getEntriesForPeerSince>, maxChars: number, timeZone = DEFAULT_DIGEST_TIME_ZONE): string {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const content = sanitizeDigestText(entry.content, 500);
    if (!content) continue;
    const date = formatLocalDate(entry.timestamp, timeZone);
    const lines = groups.get(date) ?? [];
    lines.push(`${entry.isBot ? "Asuka" : "用户"}: ${content}`);
    groups.set(date, lines);
  }

  const sections = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, lines], index, all) => {
      const detailLevel = fallbackDetailLevelForIndex(index, all.length);
      const budget = detailLevel === "detailed" ? 8_000 : detailLevel === "balanced" ? 4_000 : 2_000;
      return [
        `### ${date} (${detailLevel})`,
        trimHistoryLines(lines, budget),
      ].join("\n");
    });
  return trimHistoryLines(sections, maxChars);
}

function buildHistoryForDigest(peerId: string, now: number, config: MiniMaxDigestConfig): { text: string; coveredUntil: number } {
  const since = now - DIGEST_WINDOW_MS;
  const entries = getEntriesForPeerSince(peerId, since, config.maxHistoryEntries);
  const coveredUntil = entries.reduce((max, entry) => Math.max(max, entry.timestamp), 0);
  return {
    text: formatDailyHistory(entries, config.maxHistoryChars),
    coveredUntil,
  };
}

function buildDigestPrompt(input: {
  previous?: ConversationDigest | LegacyConversationDigest;
  history: string;
  userText: string;
  assistantText: string;
  now: number;
}): string {
  const previousJson = input.previous ? JSON.stringify(input.previous, null, 2) : "{}";
  return [
    `当前时间(ms): ${input.now}`,
    "上一版 digest JSON:",
    previousJson,
    "",
    "近一周对话节选（越靠后越新）:",
    input.history || "（无历史）",
    "",
    "本轮新增:",
    `用户: ${sanitizeDigestText(input.userText, 700) || "（空）"}`,
    `Asuka: ${sanitizeDigestText(input.assistantText, 700) || "（空）"}`,
    "",
    "输出 JSON schema:",
    JSON.stringify({
      weekly: {
        relationshipContinuity: "七天总体关系连续性，保留会影响下一轮陪伴回复的关系事实",
        recentEmotionalArc: "七天情绪变化和当前情绪，不要复述长对话",
        currentOpenLoops: ["仍未完成的承诺、待接住的问题、用户刚提出的期待"],
        userPreferences: ["用户近期表达的偏好、边界、交互方式要求"],
        asukaSelfContinuity: "Asuka 自己近几天生活线，只保留下一轮可能需要承接的部分",
        sceneContinuity: "当前场景/时间线连续性，过期场景要标注自然过渡",
        importantRecentFacts: ["重要事实，避免流水账"],
        thingsToAvoid: ["下一轮应避免的说法、重复、误触发"],
        lastSalientTurns: ["最多保留几条极重要原话摘要"],
      },
      daily: [{
        date: "YYYY-MM-DD",
        detailLevel: "detailed | balanced | brief，越新的日期越 detailed，越远越 brief",
        relationshipContinuity: "当天关系进展；brief 日期只写真正影响当前回复的部分",
        emotionalArc: "当天情绪线",
        openLoops: ["当天留下且仍可能影响后续的未闭环事项"],
        userPreferences: ["当天出现的新偏好或边界"],
        asukaSelfContinuity: "当天 Asuka 自己生活线",
        sceneContinuity: "当天场景/时间线，不要把早晚和睡醒弄混",
        importantFacts: ["当天重要事实"],
        thingsToAvoid: ["当天得出的避免项"],
        salientTurns: ["当天极少量关键原话摘要；旧日期要少"],
      }],
    }),
    "",
    "daily 只保留最近 7 个本地自然日；今天和昨天要详细，前 2-3 天适中，更早日期简略。weekly 必须从 daily 汇总，不要和 daily 互相矛盾。",
  ].join("\n");
}

async function requestDigestFromMiniMax(prompt: string, config: MiniMaxDigestConfig): Promise<Record<string, any> | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(buildMiniMaxMessagesEndpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 6000,
        thinking: { type: "disabled" },
        system: [
          "你是陪伴型 agent 的近一周记忆摘要 curator。",
          "你只能维护内部摘要 JSON，不能生成用户可见回复，不能调用任何外部消息发送能力。",
          "保留会影响下一轮自然陪伴、关系连续性、场景连续性和用户偏好的信息；删除闲聊噪声。",
          "摘要要分为 weekly 总览和 daily 日摘要；越近的 daily 越详细，越远越简略。",
          "字段顺序和 schema 必须稳定；只输出一个 JSON 对象。",
        ].join("\n"),
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) return undefined;
    const text = extractTextFromMiniMaxMessage(await response.json());
    return extractJsonObject(text);
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

export function getConversationDigest(context: AsukaPeerContext): ConversationDigest | null {
  const digest = loadState().digests[makePeerKey(context)];
  if (!digest) return null;
  return upgradeLegacyDigest(digest);
}

function upgradeLegacyDigest(digest: ConversationDigest | LegacyConversationDigest): ConversationDigest {
  if (digest.version === 2) return digest;
  return {
    version: 2,
    peerKey: digest.peerKey,
    window: digest.window,
    updatedAt: digest.updatedAt,
    coveredUntil: digest.coveredUntil,
    timeZone: DEFAULT_DIGEST_TIME_ZONE,
    weekly: normalizeWeeklyDigest(digest),
    daily: [],
  };
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join("；") : "无";
}

export function formatConversationDigestForPrompt(digest: ConversationDigest | LegacyConversationDigest): string {
  const normalized = upgradeLegacyDigest(digest);
  const weekly = normalized.weekly;
  const lines = [
    "【近一周会话摘要】",
    `- 摘要窗口: ${normalized.window}（滚动最近七天，按 ${normalized.timeZone} 自然日分日摘要）`,
    `- 七天关系连续性: ${weekly.relationshipContinuity || "无"}`,
    `- 七天情绪线: ${weekly.recentEmotionalArc || "无"}`,
    `- 当前未闭环事项: ${formatList(weekly.currentOpenLoops)}`,
    `- 用户偏好/边界: ${formatList(weekly.userPreferences)}`,
    `- Asuka 自我生活线: ${weekly.asukaSelfContinuity || "无"}`,
    `- 场景连续性: ${weekly.sceneContinuity || "无"}`,
    `- 重要近期事实: ${formatList(weekly.importantRecentFacts)}`,
    `- 下一轮避免: ${formatList(weekly.thingsToAvoid)}`,
    `- 关键近轮: ${formatList(weekly.lastSalientTurns)}`,
  ];

  if (normalized.daily.length > 0) {
    lines.push("【每日摘要】");
    for (const day of normalized.daily) {
      const dayLines = [
        `- ${day.date}（${day.detailLevel}）`,
        `  关系: ${day.relationshipContinuity || "无"}`,
        `  情绪: ${day.emotionalArc || "无"}`,
        `  未闭环: ${formatList(day.openLoops)}`,
        `  场景: ${day.sceneContinuity || "无"}`,
        `  Asuka 生活线: ${day.asukaSelfContinuity || "无"}`,
        `  重要事实: ${formatList(day.importantFacts)}`,
      ];
      if (day.userPreferences.length > 0) dayLines.push(`  偏好/边界: ${formatList(day.userPreferences)}`);
      if (day.thingsToAvoid.length > 0) dayLines.push(`  避免: ${formatList(day.thingsToAvoid)}`);
      if (day.salientTurns.length > 0) dayLines.push(`  关键近轮: ${formatList(day.salientTurns)}`);
      lines.push(dayLines.join("\n"));
    }
  }

  return lines.join("\n");
}

export function buildConversationDigestPrompt(context: AsukaPeerContext): string {
  const digest = getConversationDigest(context);
  return digest ? formatConversationDigestForPrompt(digest) : "";
}

export async function updateConversationDigest(context: AsukaPeerContext, input: ConversationDigestUpdateInput): Promise<ConversationDigest | null> {
  const config = resolveMiniMaxDigestConfig(input.rootConfig);
  if (!config) return null;
  const now = input.now ?? Date.now();
  const peerKey = makePeerKey(context);
  const state = loadState();
  const previous = state.digests[peerKey];
  if (previous && now - previous.updatedAt < config.minUpdateIntervalMs) {
    return upgradeLegacyDigest(previous);
  }
  const history = buildHistoryForDigest(context.peerId, now, config);
  const prompt = buildDigestPrompt({
    previous,
    history: history.text,
    userText: input.userText,
    assistantText: input.assistantText,
    now,
  });
  const parsed = await requestDigestFromMiniMax(prompt, config);
  if (!parsed) return previous ? upgradeLegacyDigest(previous) : null;
  const digest = normalizeDigest(parsed, peerKey, now, config.maxDigestChars, Math.max(history.coveredUntil, now));
  state.version = 2;
  state.digests[peerKey] = digest;
  saveState();
  input.log?.info?.(`[asuka-digest] updated peer=${context.peerId}, chars=${formatConversationDigestForPrompt(digest).length}`);
  return digest;
}

export function scheduleConversationDigestUpdate(context: AsukaPeerContext, input: ConversationDigestUpdateInput): void {
  const peerKey = makePeerKey(context);
  if (runningUpdates.has(peerKey)) return;
  runningUpdates.add(peerKey);
  void updateConversationDigest(context, input)
    .catch((error) => {
      input.log?.error?.(`[asuka-digest] update failed for ${context.peerId}: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      runningUpdates.delete(peerKey);
    });
}
