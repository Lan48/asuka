import fs from "node:fs";
import path from "node:path";
import type { AsukaPeerContext } from "./asuka-state.js";
import { makePeerKey } from "./asuka-state.js";
import { formatRefEntryForAgent, getActivePeerIdsSince, getEntriesForPeerSince } from "./ref-index-store.js";
import { getQQBotDataDir } from "./utils/platform.js";

const DIGEST_DIR = getQQBotDataDir("data", "asuka-conversation-digest");
const DIGEST_FILE = path.join(DIGEST_DIR, "digest.json");
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DIGEST_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_DIGEST_MODEL = "MiniMax-M2.7";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_HISTORY_CHARS = 120_000;
const DEFAULT_MAX_DIGEST_CHARS = 3_800;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 20_000;
const DEFAULT_MAX_HISTORY_ENTRIES = 2_048;
const DEFAULT_DAILY_DIGEST_HOUR = 4;
const DEFAULT_DAILY_DIGEST_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_DIGEST_STARTUP_DELAY_MS = 90_000;
const DEFAULT_DAILY_DIGEST_MAX_PEERS = 60;
const MAX_FIELD_CHARS = 420;
const MAX_ARRAY_ITEMS = 10;
const runningUpdates = new Set<string>();
const cache: { state: ConversationDigestStateFile | null } = { state: null };
const dailySchedulers = new Map<string, { timer: ReturnType<typeof setInterval>; startupTimer: ReturnType<typeof setTimeout> }>();

export interface ConversationWeeklyDigest {
  relationshipContinuity: string;
  recentEmotionalArc: string;
  currentOpenLoops: string[];
  userPreferences: string[];
  temporaryDirectives: string[];
  asukaSelfContinuity: string;
  sceneContinuity: string;
  importantRecentFacts: string[];
  thingsToAvoid: string[];
  lastSalientTurns: string[];
  evidenceNotes: string[];
}

export interface ConversationDailyDigest {
  date: string;
  detailLevel: "detailed" | "balanced" | "brief";
  relationshipContinuity: string;
  emotionalArc: string;
  openLoops: string[];
  userPreferences: string[];
  temporaryDirectives: string[];
  asukaSelfContinuity: string;
  sceneContinuity: string;
  importantFacts: string[];
  thingsToAvoid: string[];
  salientTurns: string[];
  evidenceNotes: string[];
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
  historyTargetDate?: string;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}

interface DailyConversationDigestConfig {
  enabled: boolean;
  hour: number;
  timeZone: string;
  checkIntervalMs: number;
  startupDelayMs: number;
  maxPeers: number;
}

interface DailyConversationDigestInput {
  accountId: string;
  rootConfig: Record<string, unknown>;
  now?: number;
  force?: boolean;
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

function getBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(?:true|1|yes|on)$/i.test(value.trim())) return true;
    if (/^(?:false|0|no|off)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function clampHour(value: unknown, fallback: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : fallback;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(23, Math.max(0, Math.floor(numeric)));
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

export function resolveDailyConversationDigestConfig(rootConfig: Record<string, unknown>): DailyConversationDigestConfig | undefined {
  if (!resolveMiniMaxDigestConfig(rootConfig)) return undefined;
  const root = rootConfig as Record<string, any>;
  const qqbot = getObject(getObject(root.channels)?.qqbot);
  const minimax = getObject(qqbot?.minimax);
  const digest = getObject(minimax?.digest);
  const daily = getObject(digest?.dailyUpdate ?? digest?.daily);
  const timeZone = getStringValue(
    daily?.timeZone,
    daily?.timezone,
    digest?.timeZone,
    digest?.timezone,
    qqbot?.proactiveQuietHours?.timezone,
    DEFAULT_DIGEST_TIME_ZONE,
  );

  return {
    enabled: getBooleanValue(daily?.enabled, true),
    hour: clampHour(daily?.hour ?? daily?.localHour, DEFAULT_DAILY_DIGEST_HOUR),
    timeZone,
    checkIntervalMs: Math.max(60_000, Math.floor(getNumberValue(daily?.checkIntervalMs, DEFAULT_DAILY_DIGEST_CHECK_INTERVAL_MS))),
    startupDelayMs: Math.max(0, Math.floor(getNumberValue(daily?.startupDelayMs, DEFAULT_DAILY_DIGEST_STARTUP_DELAY_MS))),
    maxPeers: Math.max(1, Math.floor(getNumberValue(daily?.maxPeers, DEFAULT_DAILY_DIGEST_MAX_PEERS))),
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
    .replace(/Q{1,2}BOT_(?:PAYLOAD|CRON):[\s\S]*?(?=\n\n|$)/gi, " ")
    .replace(/<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi, " ")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|sk-cp-[A-Za-z0-9_-]{16,})\b/g, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|clientSecret|Authorization|Bearer)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (/工具调用|调试信息|API 调用|脚本|进程状态|通道规则/i.test(sanitized)) return "";
  return truncate(sanitized, maxChars);
}

function sanitizeDigestPerspectiveText(text: string | undefined, maxChars = MAX_FIELD_CHARS): string {
  const sanitized = sanitizeDigestText(text, maxChars);
  return sanitized ? normalizePromptPerspective(sanitized) : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeDigestPerspectiveText(typeof item === "string" ? item : "", MAX_FIELD_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ARRAY_ITEMS);
}

function isTemporaryDirectiveText(text: string): boolean {
  return /(临时|暂时|接下来|后面\s*\d*\s*轮|[一二三四五六七八九十百\d]+\s*轮|直到|本轮|这轮|下一轮|今晚|今天.*语音|语音回答|用语音回答)/i.test(text);
}

function normalizeStablePreferences(value: unknown): string[] {
  return normalizeStringArray(value)
    .filter((item) => !isTemporaryDirectiveText(item))
    .slice(0, MAX_ARRAY_ITEMS);
}

function normalizeTemporaryDirectives(...values: unknown[]): string[] {
  const items: string[] = [];
  for (const value of values) {
    for (const item of normalizeStringArray(value)) {
      if (Array.isArray(value) || isTemporaryDirectiveText(item)) items.push(item);
    }
  }
  return [...new Set(items)].slice(0, MAX_ARRAY_ITEMS);
}

function normalizeOpenLoops(value: unknown): string[] {
  return normalizeStringArray(value)
    .map((item) => {
      if (/(愧疚|抱歉|迟到).*(语音|声音|voice)|(?:语音|声音|voice).*(愧疚|抱歉|迟到)/i.test(item)) {
        return "语音回答问题仍需稳定承接";
      }
      return item;
    })
    .filter((item) => !/(已完成|已解决|已兑现|已和解|已经聊开|不要再提|别再提|不需要再|只需避免)/.test(item))
    .filter((item) => !/(愧疚感?|迟到).*(话题|情绪)/.test(item))
    .slice(0, MAX_ARRAY_ITEMS);
}

function normalizeWeeklyDigest(value: unknown): ConversationWeeklyDigest {
  const input = getObject(value) ?? {};
  return {
    relationshipContinuity: sanitizeDigestPerspectiveText(input.relationshipContinuity, 520),
    recentEmotionalArc: sanitizeDigestPerspectiveText(input.recentEmotionalArc, 420),
    currentOpenLoops: normalizeOpenLoops(input.currentOpenLoops),
    userPreferences: normalizeStablePreferences(input.userPreferences),
    temporaryDirectives: normalizeTemporaryDirectives(input.temporaryDirectives ?? input.temporaryPreferences, normalizeStringArray(input.userPreferences).filter(isTemporaryDirectiveText)),
    asukaSelfContinuity: sanitizeDigestPerspectiveText(input.asukaSelfContinuity, 420),
    sceneContinuity: sanitizeDigestPerspectiveText(input.sceneContinuity, 420),
    importantRecentFacts: normalizeStringArray(input.importantRecentFacts),
    thingsToAvoid: normalizeStringArray(input.thingsToAvoid),
    lastSalientTurns: normalizeStringArray(input.lastSalientTurns),
    evidenceNotes: normalizeStringArray(input.evidenceNotes ?? input.evidence),
  };
}

function fallbackDetailLevelForIndex(index: number, total: number): ConversationDailyDigest["detailLevel"] {
  const ageFromNewest = total - index - 1;
  if (ageFromNewest <= 1) return "detailed";
  if (ageFromNewest <= 3) return "balanced";
  return "brief";
}

function addDays(timestamp: number, days: number): number {
  return timestamp + days * 24 * 60 * 60 * 1000;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateAliases(date: string): string[] {
  const shortDate = date.slice(5);
  return [date, shortDate];
}

function replaceDateAliases(text: string, aliases: string[], replacement: string): string {
  let next = text;
  for (const alias of aliases) {
    next = next.replace(new RegExp(escapeRegExp(alias), "g"), replacement);
  }
  return next;
}

function normalizeFutureDateReferences(text: string, now: number): string {
  if (!text) return text;
  const tomorrow = formatLocalDate(addDays(now, 1), DEFAULT_DIGEST_TIME_ZONE);
  const dayAfterTomorrow = formatLocalDate(addDays(now, 2), DEFAULT_DIGEST_TIME_ZONE);
  return replaceDateAliases(
    replaceDateAliases(text, dateAliases(dayAfterTomorrow), "后续"),
    dateAliases(tomorrow),
    "明天",
  );
}

function normalizeFutureDateArray(items: string[], now: number): string[] {
  return items.map((item) => normalizeFutureDateReferences(item, now));
}

function constrainDigestDates(digest: ConversationDigest, now: number): ConversationDigest {
  const weekly = digest.weekly;
  return {
    ...digest,
    weekly: {
      relationshipContinuity: normalizeFutureDateReferences(weekly.relationshipContinuity, now),
      recentEmotionalArc: normalizeFutureDateReferences(weekly.recentEmotionalArc, now),
      currentOpenLoops: normalizeFutureDateArray(weekly.currentOpenLoops, now),
      userPreferences: normalizeFutureDateArray(weekly.userPreferences, now),
      temporaryDirectives: normalizeFutureDateArray(weekly.temporaryDirectives, now),
      asukaSelfContinuity: normalizeFutureDateReferences(weekly.asukaSelfContinuity, now),
      sceneContinuity: normalizeFutureDateReferences(weekly.sceneContinuity, now),
      importantRecentFacts: normalizeFutureDateArray(weekly.importantRecentFacts, now),
      thingsToAvoid: normalizeFutureDateArray(weekly.thingsToAvoid, now),
      lastSalientTurns: normalizeFutureDateArray(weekly.lastSalientTurns, now),
      evidenceNotes: normalizeFutureDateArray(weekly.evidenceNotes, now),
    },
    daily: [],
  };
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
    daily: [],
  };
  return trimDigestToBudget(constrainDigestDates(digest, now), maxDigestChars);
}

function digestPromptSize(digest: ConversationDigest): number {
  return formatConversationDigestForPrompt(digest).length;
}

function trimDigestToBudget(digest: ConversationDigest, maxChars: number): ConversationDigest {
  const next: ConversationDigest = {
    ...digest,
    weekly: { ...digest.weekly },
    daily: [],
  };
  while (digestPromptSize(next) > maxChars && next.weekly.lastSalientTurns.length > 0) next.weekly.lastSalientTurns.pop();
  while (digestPromptSize(next) > maxChars && next.weekly.importantRecentFacts.length > 0) next.weekly.importantRecentFacts.pop();
  while (digestPromptSize(next) > maxChars && next.weekly.currentOpenLoops.length > 0) next.weekly.currentOpenLoops.pop();
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

function formatLocalHour(timestamp: number, timeZone = DEFAULT_DIGEST_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const raw = parts.find((part) => part.type === "hour")?.value ?? "0";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

function formatDailyHistory(entries: ReturnType<typeof getEntriesForPeerSince>, maxChars: number, timeZone = DEFAULT_DIGEST_TIME_ZONE): string {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const content = sanitizeDigestText(formatRefEntryForAgent(entry), 500);
    if (!content) continue;
    const date = formatLocalDate(entry.timestamp, timeZone);
    const lines = groups.get(date) ?? [];
    lines.push(`${entry.isBot ? "我" : "你"}: ${normalizePromptPerspective(content)}`);
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

function buildHistoryForDigest(peerId: string, now: number, config: MiniMaxDigestConfig, targetDate?: string): { text: string; coveredUntil: number } {
  const since = now - DIGEST_WINDOW_MS;
  const entries = getEntriesForPeerSince(peerId, since, config.maxHistoryEntries)
    .filter((entry) => !targetDate || formatLocalDate(entry.timestamp, DEFAULT_DIGEST_TIME_ZONE) === targetDate);
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
  historyTargetDate?: string;
}): string {
  const previousJson = input.previous ? JSON.stringify(upgradeLegacyDigest(input.previous), null, 2) : "{}";
  const currentLocalDate = formatLocalDate(input.now, DEFAULT_DIGEST_TIME_ZONE);
  const targetLine = input.historyTargetDate
    ? `本次维护目标日期: ${input.historyTargetDate}（只使用该自然日的原始对话）`
    : "本次维护目标范围: 最近七天原始对话";
  const currentTurnLines = input.userText || input.assistantText
    ? [
        "",
        "本轮新增原文:",
        `你: ${sanitizeDigestPerspectiveText(input.userText, 700) || "（空）"}`,
        `我: ${sanitizeDigestPerspectiveText(input.assistantText, 700) || "（空）"}`,
      ]
    : [];
  return [
    `当前时间(ms): ${input.now}`,
    `当前本地日期: ${currentLocalDate}（${DEFAULT_DIGEST_TIME_ZONE}）`,
    targetLine,
    "上一版 digest JSON（只是可修改草稿，不是事实来源；不要机械继承）:",
    previousJson,
    "",
    "对话原文（只包含用户输入和已经发出的模型回复；不包含模型运行时收到的上下文信息；越靠后越新）:",
    input.history || "（无历史）",
    ...currentTurnLines,
    "",
    "更新方式:",
    "- 输出必须是完整替换版 digest，不是 patch，也不是只追加本轮新增。",
    "- 对话原文和本轮新增优先级高于上一版 digest；如果旧摘要被新原文纠正、补全、完成或过期，必须改写 weekly。",
    "- 日期必须严格来自对话原文的 ### YYYY-MM-DD 分组和当前本地日期；不要自行把今天改成明天，也不要把用户话里的“明天”换算成没有证据的后天日期。",
    "- 如果要记录“明天/早上/中午”等相对时间，优先保留相对说法；只有在当前本地日期能直接换算时才写绝对日期，且不能超过当前日期 + 1 天。",
    "- 临时指令必须按当前上下文更新状态；如果已经满足、被用户取消、超过轮数/时段、或最近历史能证明已完成，就从 temporaryDirectives 和 thingsToAvoid 中移除，而不是继续写'仍在生效'。",
    "- 不要因为上一版 digest 里有某条信息就继续保留；保留每条重要信息都要能从近一周历史、本轮新增或明确证据说明中得到支持。",
    "- 不要输出 daily 字段；每天的原文只用于滚动修正 weekly。",
    "",
    "输出 JSON schema:",
    JSON.stringify({
      weekly: {
        relationshipContinuity: "七天总体关系连续性，保留会影响下一轮陪伴回复的关系事实",
        recentEmotionalArc: "七天情绪变化和当前情绪，不要复述长对话",
        currentOpenLoops: ["仍未完成的承诺、待接住的问题、用户刚提出的期待；已解决或只需避免的旧情绪不要放这里"],
        userPreferences: ["稳定偏好和边界；不要把只持续几轮的临时要求放这里"],
        temporaryDirectives: ["有明确持续时间、计数或触发条件的临时交互要求，例如'接下来十轮用语音回答（剩余/起点未知时标注需外部计数）'"],
        asukaSelfContinuity: "Asuka 自己近几天生活线，只保留下一轮可能需要承接的部分",
        sceneContinuity: "当前场景/时间线连续性，过期场景要标注自然过渡",
        importantRecentFacts: ["重要事实，避免流水账"],
        thingsToAvoid: ["下一轮应避免的说法、重复、误触发"],
        lastSalientTurns: ["最多保留几条极重要原话摘要"],
        evidenceNotes: ["证据强度/来源说明：明确说过、近轮推断、Asuka 自述、旧摘要继承；不确定就标注不确定"],
      },
    }),
    "",
    "weekly 必须基于上一版 weekly 和本次目标日期原文重新修正。已完成、已和解、只需避免的事项不要进入 openLoops；临时要求必须进入 temporaryDirectives，并写明过期条件或计数状态；已过期/已满足的临时要求必须删除。",
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
        max_tokens: 4000,
        thinking: { type: "disabled" },
        system: [
          "你是陪伴型 agent 的 weekly 记忆摘要 curator。",
          "你只能维护内部摘要 JSON，不能生成用户可见回复，不能调用任何外部消息发送能力。",
          "保留会影响下一轮自然陪伴、关系连续性、场景连续性和用户偏好的信息；删除闲聊噪声。",
          "摘要只维护 weekly 总览；不要生成 daily 日摘要。",
          "每次更新都要基于旧摘要、近一周历史和本轮新增重新生成完整摘要；旧摘要只是草稿，不能只追加最新内容。",
          "如果当天原始对话修正、完成或废弃了旧摘要里的内容，要同步改写 weekly，而不是继续继承旧说法。",
          "openLoops 只放仍需继续承接的事项；已解决旧话题放 thingsToAvoid 或省略。",
          "有轮数、时段、直到某事件为止且仍在生效的临时要求放 temporaryDirectives，不要混入稳定偏好；已满足、已过期或被取消的临时要求必须移除。",
          "重要事实、偏好和推断要用 evidenceNotes 标出证据强度或来源。",
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
  if (digest.version === 2) {
    return {
      version: 2,
      peerKey: digest.peerKey,
      window: digest.window,
      updatedAt: digest.updatedAt,
      coveredUntil: digest.coveredUntil,
      timeZone: getStringValue(digest.timeZone, DEFAULT_DIGEST_TIME_ZONE),
      weekly: normalizeWeeklyDigest(digest.weekly),
      daily: [],
    };
  }
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

function formatList(items: string[] | undefined): string {
  return items && items.length > 0 ? items.join("；") : "无";
}

function normalizePromptPerspective(text: string): string {
  return text
    .replace(/Asuka\s*自己/g, "我")
    .replace(/Asuka/g, "我")
    .replace(/用户/g, "你")
    .replace(/对方/g, "你")
    .replace(/(?<!其)他/g, "你")
    .replace(/她/g, "我");
}

function formatPromptText(text: string | undefined): string {
  return text ? normalizePromptPerspective(text) : "无";
}

function formatPromptList(items: string[] | undefined): string {
  return items && items.length > 0 ? items.map(normalizePromptPerspective).join("；") : "无";
}

export function formatConversationDigestForPrompt(digest: ConversationDigest | LegacyConversationDigest): string {
  const normalized = upgradeLegacyDigest(digest);
  const weekly = normalized.weekly;
  const lines = [
    "【近一周会话摘要】",
    `- 摘要窗口: ${normalized.window}（滚动最近七天，按 ${normalized.timeZone} 自然日分日摘要）`,
    `- 七天关系连续性: ${formatPromptText(weekly.relationshipContinuity)}`,
    `- 七天情绪线: ${formatPromptText(weekly.recentEmotionalArc)}`,
    `- 当前未闭环事项: ${formatPromptList(weekly.currentOpenLoops)}`,
    `- 你的偏好/边界: ${formatPromptList(weekly.userPreferences)}`,
    `- 临时指令/待过期偏好: ${formatPromptList(weekly.temporaryDirectives)}`,
    `- 我的生活线: ${formatPromptText(weekly.asukaSelfContinuity)}`,
    `- 场景连续性: ${formatPromptText(weekly.sceneContinuity)}`,
    `- 重要近期事实: ${formatPromptList(weekly.importantRecentFacts)}`,
    `- 下一轮避免: ${formatPromptList(weekly.thingsToAvoid)}`,
    `- 关键近轮: ${formatPromptList(weekly.lastSalientTurns)}`,
    `- 证据/置信度: ${formatPromptList(weekly.evidenceNotes)}`,
  ];

  return lines.join("\n");
}

export function buildConversationDigestPrompt(context: AsukaPeerContext): string {
  const digest = getConversationDigest(context);
  return digest ? formatConversationDigestForPrompt(digest) : "";
}

function parseDigestPeerKey(peerKey: string): Pick<AsukaPeerContext, "accountId" | "peerKind" | "peerId" | "senderId" | "target"> | null {
  const parts = peerKey.split(":");
  if (parts.length < 3) return null;
  const accountId = parts.shift() || "";
  const peerKind = parts.shift() === "group" ? "group" : "direct";
  const peerId = parts.join(":");
  if (!accountId || !peerId) return null;
  return {
    accountId,
    peerKind,
    peerId,
    senderId: peerId,
    target: peerKind === "group" ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
  };
}

function buildDigestContext(accountId: string, peerKind: "direct" | "group", peerId: string): AsukaPeerContext {
  return {
    accountId,
    peerKind,
    peerId,
    senderId: peerId,
    target: peerKind === "group" ? `qqbot:group:${peerId}` : `qqbot:c2c:${peerId}`,
  };
}

function collectDailyDigestContexts(accountId: string, now: number, config: DailyConversationDigestConfig): AsukaPeerContext[] {
  const state = loadState();
  const byKey = new Map<string, AsukaPeerContext>();

  for (const peerKey of Object.keys(state.digests)) {
    const parsed = parseDigestPeerKey(peerKey);
    if (!parsed || parsed.accountId !== accountId) continue;
    byKey.set(peerKey, buildDigestContext(parsed.accountId, parsed.peerKind, parsed.peerId));
  }

  const since = now - 2 * 24 * 60 * 60 * 1000;
  for (const peerId of getActivePeerIdsSince(since, config.maxPeers)) {
    const context = buildDigestContext(accountId, "direct", peerId);
    byKey.set(makePeerKey(context), context);
  }

  return [...byKey.values()].slice(0, config.maxPeers);
}

function shouldSkipDailyDigest(context: AsukaPeerContext, now: number, timeZone: string, force: boolean | undefined): boolean {
  if (force) return false;
  const digest = getConversationDigest(context);
  if (!digest) return false;
  return formatLocalDate(digest.updatedAt, timeZone) === formatLocalDate(now, timeZone);
}

export async function runDailyConversationDigestUpdate(input: DailyConversationDigestInput): Promise<{ checked: number; updated: number; skipped: number }> {
  const config = resolveDailyConversationDigestConfig(input.rootConfig);
  if (!config?.enabled) return { checked: 0, updated: 0, skipped: 0 };
  const now = input.now ?? Date.now();
  if (!input.force && formatLocalHour(now, config.timeZone) < config.hour) {
    return { checked: 0, updated: 0, skipped: 0 };
  }

  const contexts = collectDailyDigestContexts(input.accountId, now, config);
  const targetDate = formatLocalDate(now - 24 * 60 * 60 * 1000, config.timeZone);
  let updated = 0;
  let skipped = 0;
  for (const context of contexts) {
    if (shouldSkipDailyDigest(context, now, config.timeZone, input.force)) {
      skipped++;
      continue;
    }
    const before = getConversationDigest(context)?.updatedAt ?? 0;
    const digest = await updateConversationDigest(context, {
      rootConfig: input.rootConfig,
      userText: "",
      assistantText: "",
      now,
      historyTargetDate: targetDate,
      log: input.log,
    });
    if (digest && digest.updatedAt !== before) updated++;
  }
  input.log?.info?.(`[asuka-digest] daily weekly maintenance account=${input.accountId}, targetDate=${targetDate}, checked=${contexts.length}, updated=${updated}, skipped=${skipped}`);
  return { checked: contexts.length, updated, skipped };
}

export function startDailyConversationDigestScheduler(input: Omit<DailyConversationDigestInput, "now" | "force">): () => void {
  const config = resolveDailyConversationDigestConfig(input.rootConfig);
  const key = input.accountId;
  const existing = dailySchedulers.get(key);
  if (existing) {
    clearInterval(existing.timer);
    clearTimeout(existing.startupTimer);
    dailySchedulers.delete(key);
  }
  if (!config?.enabled) {
    input.log?.info?.(`[asuka-digest] daily scheduler disabled for account=${input.accountId}`);
    return () => {};
  }

  const run = () => {
    void runDailyConversationDigestUpdate(input).catch((error) => {
      input.log?.error?.(`[asuka-digest] daily maintenance failed for ${input.accountId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const startupTimer = setTimeout(run, config.startupDelayMs);
  const timer = setInterval(run, config.checkIntervalMs);
  dailySchedulers.set(key, { timer, startupTimer });
  input.log?.info?.(`[asuka-digest] daily weekly scheduler started account=${input.accountId}, hour=${config.hour}, timeZone=${config.timeZone}, checkIntervalMs=${config.checkIntervalMs}`);

  return () => {
    clearInterval(timer);
    clearTimeout(startupTimer);
    if (dailySchedulers.get(key)?.timer === timer) dailySchedulers.delete(key);
  };
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
  const history = buildHistoryForDigest(context.peerId, now, config, input.historyTargetDate);
  if (input.historyTargetDate && !history.text.trim()) {
    return previous ? upgradeLegacyDigest(previous) : null;
  }
  const prompt = buildDigestPrompt({
    previous,
    history: history.text,
    userText: input.userText,
    assistantText: input.assistantText,
    now,
    historyTargetDate: input.historyTargetDate,
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
