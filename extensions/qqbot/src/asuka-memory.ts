import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AsukaPeerContext } from "./asuka-state.js";
import { makePeerKey } from "./asuka-state.js";
import { getQQBotDataDir } from "./utils/platform.js";

type AsukaMemoryType =
  | "user_profile"
  | "preference"
  | "boundary"
  | "relationship"
  | "active_thread"
  | "asuka_self_thread"
  | "asuka_self_signal"
  | "explicit";

type AsukaMemorySource = "user_explicit" | "user_inferred" | "assistant_self_thread" | "assistant_self_signal";
type AsukaMemoryPrivacy = "direct_only" | "group_safe";
type AsukaMemoryStatus = "active" | "superseded" | "forgotten";
type AsukaMemoryImportance = "normal" | "important";
type AsukaLifeEventKind = "study" | "media_work" | "outing" | "home" | "weather" | "daily";
type AsukaContinuityKind = "preference" | "boundary" | "emotional_continuity";

interface AsukaMemoryItem {
  id: string;
  accountId: string;
  peerKey: string;
  peerKind: "direct" | "group";
  peerId: string;
  type: AsukaMemoryType;
  text: string;
  source: AsukaMemorySource;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  salience: number;
  confidence: number;
  expiresAt?: number;
  freshnessUntil?: number;
  lifeEventKind?: AsukaLifeEventKind;
  continuityKind?: AsukaContinuityKind;
  importance?: AsukaMemoryImportance;
  temporary?: boolean;
  importanceUpdatedAt?: number;
  privacy: AsukaMemoryPrivacy;
  key?: string;
  status?: AsukaMemoryStatus;
  supersededBy?: string;
  supersededAt?: number;
  forgottenAt?: number;
}

interface AsukaMemoryStateFile {
  version: 1;
  memories: Record<string, AsukaMemoryItem>;
}

const MEMORY_DIR = getQQBotDataDir("data", "asuka-memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memory.json");
const MAX_MEMORY_TEXT_LENGTH = 180;
const MAX_MEMORY_COUNT_PER_PEER = 120;
const MAX_ASUKA_SELF_THREAD_PER_PEER = 12;
const MAX_ASUKA_SELF_SIGNAL_PER_PEER = 8;
const MAX_PROMPT_CHARS = 1100;
const MAX_LIST_MEMORIES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_THREAD_TTL_MS = 21 * DAY_MS;
const SELF_THREAD_TTL_MS = 10 * DAY_MS;
const SELF_SIGNAL_TTL_MS = 60 * DAY_MS;
const TEMPORARY_MEMORY_TTL_MS = 7 * DAY_MS;
const ACTIVE_THREAD_COMPACT_AFTER_MS = 7 * DAY_MS;
const RECENT_ACTIVE_PROMPT_MS = 3 * DAY_MS;
const RECENT_SELF_THREAD_PROMPT_MS = 2 * DAY_MS;
const SELF_THREAD_FRESHNESS_MS = RECENT_SELF_THREAD_PROMPT_MS;
const cache: { state: AsukaMemoryStateFile | null } = { state: null };

const STRUCTURED_ARTIFACT_RE = /QQBOT_(?:PAYLOAD|CRON):[\s\S]*$/gi;
const MEDIA_TAG_RE = /<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
const INTERNAL_LEAK_RE = /(asuka-selfie|QQBOT_(?:PAYLOAD|CRON)|任务完成总结[:：]|提醒已发送|根据任务描述|工具调用|调试信息|API 调用|脚本|进程状态|通道规则)/i;
const SECRET_RE = /(密码|口令|验证码|token|api[_-]?key|secret|密钥|身份证|银行卡|信用卡|私钥|助记词|cookie|authorization)/i;
const EXPLICIT_MEMORY_RE = /(记住|记得|别忘|帮我记|你要记|以后你要记得|以后记得|这点很重要|这个很重要)/;
const USER_PROFILE_RE = /(我叫|叫我|我的名字|我是|生日|纪念日|时区|城市|住在|在.*工作|在.*上学)/;
const PREFERENCE_RE = /(我喜欢|我偏好|我更喜欢|我希望|我想要|我习惯|对我来说.*重要|可以多|最好)/;
const BOUNDARY_RE = /(我不喜欢|我讨厌|不要|别再|别叫|不想|雷点|介意|不舒服|别提|不要再)/;
const RELATIONSHIP_RE = /(我们|上次|那次|之前|一起|约定|拉钩|纪念|吵架|和好|想你|喜欢你|爱你)/;
const ACTIVE_THREAD_RE = /(最近|这几天|这周|今天|明天|回头|继续|下次|等会|一会|待会|正在|准备|计划)/;
const ASUKA_SELF_THREAD_RE = /(我(最近|这几天|这周|今天|明天|现在|刚刚|等会|准备|正在).*(上课|自习|作业|课题|拍照|拍视频|剪视频|咖啡|宿舍|学校|校园|西湖|湖滨|运河|雨|散步|电影|音乐|练舞|整理|复习|画面|镜头|照片))/;
const ASUKA_SELF_SIGNAL_RE = /我(其实|还是|一直|会|更|不太|有点|真的)?[^。！？!?]{0,80}(喜欢|更喜欢|不喜欢|习惯|在意|怕|介意|想靠近|想离你近|会想你|想陪着你|不想敷衍|想认真对你)/;
const MEMORY_LIST_RE = /(你(都)?(还)?记得我(什么|哪些)|你(都)?记住了我(什么|哪些)|你(都)?记着我(什么|哪些)|看看(你)?(的)?记忆|查看(你)?(的)?记忆|列出(你)?(的)?记忆|记忆列表|记忆分类|记忆类别|重要(的)?记忆)/;
const MEMORY_FORGET_RE = /(忘了|忘掉|忘记|别记|不要记|删掉|删除|清除|清空|抹掉)/;
const MEMORY_MARK_IMPORTANT_RE = /(标为重要|设为重要|当成重要|标记为重要|这点很重要|这个很重要|特别重要|重点记|一定记住)/;
const MEMORY_MARK_TEMPORARY_RE = /(标为临时|设为临时|当成临时|临时记|暂时记|短期记|只是临时|先记一阵)/;
const MEMORY_CLEAR_IMPORTANCE_RE = /(取消重要|不重要了|不用特别记|别当成重要|不算重要|不是重点)/;
const MEMORY_CONTROL_PREFIX_RE = /^sudo(?:\s+|[：:]\s*)([\s\S]*)$/i;
const LOW_SIGNAL_RETRIEVAL_TOKENS = new Set([
  "今天",
  "明天",
  "最近",
  "这周",
  "这个",
  "那个",
  "一下",
  "什么",
  "怎么",
  "准备",
  "继续",
  "正在",
  "时候",
  "消息",
  "主动",
  "ambient",
  "promise",
  "followup",
  "repair",
]);

function emptyState(): AsukaMemoryStateFile {
  return {
    version: 1,
    memories: {},
  };
}

function loadState(): AsukaMemoryStateFile {
  if (cache.state) return cache.state;
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      cache.state = emptyState();
      return cache.state;
    }
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8")) as Partial<AsukaMemoryStateFile>;
    cache.state = {
      version: 1,
      memories: parsed.memories ?? {},
    };
    return cache.state;
  } catch (error) {
    console.error(`[asuka-memory] Failed to load memory: ${error}`);
    cache.state = emptyState();
    return cache.state;
  }
}

function saveState(): void {
  if (!cache.state) return;
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(cache.state, null, 2), "utf-8");
  } catch (error) {
    console.error(`[asuka-memory] Failed to save memory: ${error}`);
  }
}

function sanitizeMemoryText(text: string | undefined): string {
  if (!text) return "";
  const normalized = text
    .replace(MEDIA_TAG_RE, "")
    .replace(STRUCTURED_ARTIFACT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (INTERNAL_LEAK_RE.test(normalized)) return "";
  return normalized.length > MAX_MEMORY_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_MEMORY_TEXT_LENGTH).trimEnd()}...`
    : normalized;
}

function shouldSkipMemory(text: string): boolean {
  if (!text) return true;
  if (SECRET_RE.test(text)) return true;
  if (/^(\/|QQBOT_|<qq)/i.test(text.trim())) return true;
  return false;
}

function classifyUserMemory(text: string, at: number): {
  type: AsukaMemoryType;
  source: AsukaMemorySource;
  salience: number;
  confidence: number;
  expiresAt?: number;
} | null {
  const explicit = EXPLICIT_MEMORY_RE.test(text);
  if (BOUNDARY_RE.test(text)) {
    return { type: "boundary", source: explicit ? "user_explicit" : "user_inferred", salience: explicit ? 10 : 8, confidence: explicit ? 0.95 : 0.78 };
  }
  if (USER_PROFILE_RE.test(text)) {
    return { type: "user_profile", source: explicit ? "user_explicit" : "user_inferred", salience: explicit ? 10 : 8, confidence: explicit ? 0.95 : 0.76 };
  }
  if (PREFERENCE_RE.test(text)) {
    return { type: "preference", source: explicit ? "user_explicit" : "user_inferred", salience: explicit ? 9 : 7, confidence: explicit ? 0.92 : 0.72 };
  }
  if (RELATIONSHIP_RE.test(text) && (explicit || text.length <= 120)) {
    return { type: "relationship", source: explicit ? "user_explicit" : "user_inferred", salience: explicit ? 9 : 6, confidence: explicit ? 0.9 : 0.65 };
  }
  if (explicit) {
    return { type: "explicit", source: "user_explicit", salience: 8, confidence: 0.9 };
  }
  if (ACTIVE_THREAD_RE.test(text) && text.length <= 140) {
    return {
      type: "active_thread",
      source: "user_inferred",
      salience: 5,
      confidence: 0.58,
      expiresAt: at + ACTIVE_THREAD_TTL_MS,
    };
  }
  return null;
}

function deriveInlineSteering(text: string, at: number): {
  importance?: AsukaMemoryImportance;
  temporary?: boolean;
  expiresAt?: number;
} {
  const important = MEMORY_MARK_IMPORTANT_RE.test(text);
  const temporary = MEMORY_MARK_TEMPORARY_RE.test(text);
  return {
    importance: important ? "important" : undefined,
    temporary: temporary || undefined,
    expiresAt: temporary ? at + TEMPORARY_MEMORY_TTL_MS : undefined,
  };
}

function deriveLifeEventKind(text: string): AsukaLifeEventKind {
  if (/(上课|自习|作业|课题|复习|学校|校园)/.test(text)) return "study";
  if (/(拍照|拍视频|剪视频|分镜|镜头|数字媒体|画面|照片)/.test(text)) return "media_work";
  if (/(西湖|湖滨|运河|散步|电影|音乐|咖啡)/.test(text)) return "outing";
  if (/(宿舍|家里|房间|整理)/.test(text)) return "home";
  if (/(雨|晴|天气|风|冷|热)/.test(text)) return "weather";
  return "daily";
}

function deriveContinuityKind(text: string): AsukaContinuityKind {
  if (/(不喜欢|不要|不想|介意|怕|不舒服)/.test(text)) return "boundary";
  if (/(喜欢|更喜欢|习惯|偏好)/.test(text)) return "preference";
  return "emotional_continuity";
}

function classifyAssistantMemory(text: string, at: number): {
  type: AsukaMemoryType;
  source: AsukaMemorySource;
  salience: number;
  confidence: number;
  expiresAt: number;
  freshnessUntil?: number;
  lifeEventKind?: AsukaLifeEventKind;
  continuityKind?: AsukaContinuityKind;
} | null {
  if (ASUKA_SELF_THREAD_RE.test(text)) {
    return {
      type: "asuka_self_thread",
      source: "assistant_self_thread",
      salience: 5,
      confidence: 0.56,
      expiresAt: at + SELF_THREAD_TTL_MS,
      freshnessUntil: at + SELF_THREAD_FRESHNESS_MS,
      lifeEventKind: deriveLifeEventKind(text),
    };
  }
  if (ASUKA_SELF_SIGNAL_RE.test(text)) {
    return {
      type: "asuka_self_signal",
      source: "assistant_self_signal",
      salience: 7,
      confidence: 0.64,
      expiresAt: at + SELF_SIGNAL_TTL_MS,
      continuityKind: deriveContinuityKind(text),
    };
  }
  return null;
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？,.!?\s]/g, "")
    .slice(0, 80);
}

function deriveAsukaSelfSignalKey(text: string): string {
  const kind = deriveContinuityKind(text);
  if (/(照片|自拍|图片|画面|镜头)/.test(text)) return `asuka:${kind}:image`;
  if (/(靠近|离你近|陪着你|想你|认真对你|敷衍)/.test(text)) return `asuka:${kind}:closeness`;
  if (/(热闹|安静|催|急)/.test(text)) return `asuka:${kind}:pace`;
  return `asuka:${kind}:general`;
}

function getMemoryStatus(item: AsukaMemoryItem): AsukaMemoryStatus {
  return item.status ?? "active";
}

function isActiveMemory(item: AsukaMemoryItem, now: number): boolean {
  return getMemoryStatus(item) === "active" && (!item.expiresAt || item.expiresAt > now);
}

function deriveMemoryKey(type: AsukaMemoryType, text: string): string | undefined {
  if (type === "asuka_self_signal") {
    return deriveAsukaSelfSignalKey(text);
  }
  if (type === "user_profile") {
    if (/(我叫|叫我|我的名字|别叫)/.test(text)) return "user:name";
    if (/生日/.test(text)) return "user:birthday";
    if (/纪念日/.test(text)) return "user:anniversary";
    if (/时区/.test(text)) return "user:timezone";
    if (/(城市|住在|在.*工作|在.*上学|学校|公司)/.test(text)) return "user:location";
  }
  if (type === "preference") {
    if (/(称呼|叫我|名字)/.test(text)) return "preference:address";
    if (/(回复|说话|语气|风格|聊天)/.test(text)) return "preference:reply_style";
    if (/(照片|自拍|图片|画面)/.test(text)) return "preference:image";
    if (/(语音|声音)/.test(text)) return "preference:voice";
    if (/(时间|提醒|主动|消息)/.test(text)) return "preference:timing";
  }
  if (type === "boundary") {
    if (/(称呼|叫我|名字|别叫)/.test(text)) return "boundary:address";
    if (/(照片|自拍|图片|画面)/.test(text)) return "boundary:image";
    if (/(语音|声音|电话)/.test(text)) return "boundary:voice";
    if (/(话题|别提|不要.*聊|别聊)/.test(text)) return "boundary:topic";
  }
  return undefined;
}

function getActivePeerMemories(state: AsukaMemoryStateFile, peerKey: string, now: number): AsukaMemoryItem[] {
  return Object.values(state.memories)
    .filter((item) => item.peerKey === peerKey)
    .filter((item) => isActiveMemory(item, now));
}

function supersedeConflictingMemories(
  state: AsukaMemoryStateFile,
  peerKey: string,
  key: string | undefined,
  newId: string,
  newText: string,
  at: number,
): void {
  if (!key) return;
  const normalized = normalizeForDedup(newText);
  for (const item of Object.values(state.memories)) {
    if (
      item.id !== newId &&
      item.peerKey === peerKey &&
      item.key === key &&
      getMemoryStatus(item) === "active" &&
      normalizeForDedup(item.text) !== normalized
    ) {
      item.status = "superseded";
      item.supersededBy = newId;
      item.supersededAt = at;
      item.updatedAt = at;
      item.confidence = Math.min(item.confidence, 0.25);
      item.salience = Math.min(item.salience, 1);
    }
  }
}

function compactMemoryText(text: string): string {
  return text
    .replace(/^(记住|记得|别忘|帮我记|你要记|以后你要记得|以后记得)[，,:：\s]*/g, "")
    .trim()
    .slice(0, 44);
}

function compactStaleActiveThreads(state: AsukaMemoryStateFile, peerKey: string, now: number): void {
  const staleThreads = getActivePeerMemories(state, peerKey, now)
    .filter((item) => item.type === "active_thread" && item.updatedAt <= now - ACTIVE_THREAD_COMPACT_AFTER_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt);

  if (staleThreads.length < 3) return;

  const summaryParts = staleThreads
    .slice(0, 4)
    .map((item) => compactMemoryText(item.text))
    .filter(Boolean);
  if (summaryParts.length < 2) return;

  const first = staleThreads[0];
  const text = sanitizeMemoryText(`近期未完话题: ${summaryParts.join("；")}`);
  if (!text || shouldSkipMemory(text)) return;

  const existing = getActivePeerMemories(state, peerKey, now).find((item) => item.key === "thread:summary");
  if (existing) {
    existing.text = text;
    existing.updatedAt = now;
    existing.salience = Math.max(existing.salience, 6);
    existing.confidence = Math.max(existing.confidence, 0.62);
  } else {
    const id = randomUUID();
    state.memories[id] = {
      id,
      accountId: first.accountId,
      peerKey,
      peerKind: first.peerKind,
      peerId: first.peerId,
      type: "relationship",
      text,
      source: "user_inferred",
      createdAt: now,
      updatedAt: now,
      salience: 6,
      confidence: 0.62,
      privacy: "direct_only",
      key: "thread:summary",
      status: "active",
    };
  }

  for (const item of staleThreads) {
    delete state.memories[item.id];
  }
}

function maintainPeerMemories(state: AsukaMemoryStateFile, peerKey: string, now: number): void {
  prunePeerMemories(state, peerKey, now);
  compactStaleActiveThreads(state, peerKey, now);
  pruneActiveMemoriesByType(state, peerKey, "asuka_self_thread", MAX_ASUKA_SELF_THREAD_PER_PEER);
  pruneActiveMemoriesByType(state, peerKey, "asuka_self_signal", MAX_ASUKA_SELF_SIGNAL_PER_PEER);
  prunePeerMemories(state, peerKey, now);
}

function upsertMemory(context: AsukaPeerContext, input: {
  type: AsukaMemoryType;
  text: string;
  source: AsukaMemorySource;
  salience: number;
  confidence: number;
  expiresAt?: number;
  freshnessUntil?: number;
  lifeEventKind?: AsukaLifeEventKind;
  continuityKind?: AsukaContinuityKind;
  importance?: AsukaMemoryImportance;
  temporary?: boolean;
  at: number;
}): boolean {
  if (context.peerKind !== "direct") return false;
  const text = sanitizeMemoryText(input.text);
  if (shouldSkipMemory(text)) return false;

  const state = loadState();
  const peerKey = makePeerKey(context);
  const normalized = normalizeForDedup(text);
  const key = deriveMemoryKey(input.type, text);
  const existing = Object.values(state.memories).find((item) =>
    item.peerKey === peerKey &&
    item.type === input.type &&
    isActiveMemory(item, input.at) &&
    normalizeForDedup(item.text) === normalized
  );

  if (existing) {
    existing.text = text.length > existing.text.length ? text : existing.text;
    existing.updatedAt = input.at;
    existing.salience = Math.max(existing.salience, input.salience);
    existing.confidence = Math.max(existing.confidence, input.confidence);
    existing.expiresAt = input.expiresAt ?? existing.expiresAt;
    existing.freshnessUntil = input.freshnessUntil ?? existing.freshnessUntil;
    existing.lifeEventKind = input.lifeEventKind ?? existing.lifeEventKind;
    existing.continuityKind = input.continuityKind ?? existing.continuityKind;
    if (input.importance) {
      existing.importance = input.importance;
      existing.importanceUpdatedAt = input.at;
      if (input.importance === "important") {
        existing.salience = Math.max(existing.salience, 10);
      }
    }
    if (input.temporary) {
      existing.temporary = true;
      const temporaryExpiresAt = input.expiresAt ?? input.at + TEMPORARY_MEMORY_TTL_MS;
      existing.expiresAt = existing.expiresAt ? Math.min(existing.expiresAt, temporaryExpiresAt) : temporaryExpiresAt;
    }
    existing.key = existing.key ?? key;
    existing.status = "active";
    saveState();
    return true;
  }

  const id = randomUUID();
  state.memories[id] = {
    id,
    accountId: context.accountId,
    peerKey,
    peerKind: context.peerKind,
    peerId: context.peerId,
    type: input.type,
    text,
    source: input.source,
    sourceMessageId: context.messageId,
    createdAt: input.at,
    updatedAt: input.at,
    salience: input.importance === "important" ? Math.max(input.salience, 10) : input.salience,
    confidence: input.confidence,
    expiresAt: input.expiresAt,
    freshnessUntil: input.freshnessUntil,
    lifeEventKind: input.lifeEventKind,
    continuityKind: input.continuityKind,
    importance: input.importance,
    temporary: input.temporary,
    importanceUpdatedAt: input.importance ? input.at : undefined,
    privacy: "direct_only",
    key,
    status: "active",
  };
  supersedeConflictingMemories(state, peerKey, key, id, text, input.at);
  maintainPeerMemories(state, peerKey, input.at);
  saveState();
  return true;
}

function prunePeerMemories(state: AsukaMemoryStateFile, peerKey: string, now: number): void {
  for (const [id, item] of Object.entries(state.memories)) {
    if (item.expiresAt && item.expiresAt <= now) {
      delete state.memories[id];
    }
  }
  const peerItems = Object.values(state.memories)
    .filter((item) => item.peerKey === peerKey)
    .sort((a, b) => {
      const aScore = a.salience * 1000000000000 + a.updatedAt;
      const bScore = b.salience * 1000000000000 + b.updatedAt;
      return bScore - aScore;
    });
  for (const item of peerItems.slice(MAX_MEMORY_COUNT_PER_PEER)) {
    delete state.memories[item.id];
  }
}

function pruneActiveMemoriesByType(
  state: AsukaMemoryStateFile,
  peerKey: string,
  type: AsukaMemoryType,
  limit: number,
): void {
  const active = Object.values(state.memories)
    .filter((item) => item.peerKey === peerKey && item.type === type && getMemoryStatus(item) === "active")
    .sort((a, b) => {
      const aScore = a.salience * 1000000000000 + a.updatedAt;
      const bScore = b.salience * 1000000000000 + b.updatedAt;
      return bScore - aScore;
    });
  for (const item of active.slice(limit)) {
    delete state.memories[item.id];
  }
}

export function recordAsukaLongTermMemoryFromUserMessage(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now(),
): boolean {
  const text = sanitizeMemoryText(userText);
  if (shouldSkipMemory(text)) return false;
  const classified = classifyUserMemory(text, at);
  if (!classified) return false;
  const steering = deriveInlineSteering(text, at);
  return upsertMemory(context, {
    ...classified,
    ...steering,
    expiresAt: steering.expiresAt ?? classified.expiresAt,
    text,
    at,
  });
}

export function recordAsukaLongTermMemoryFromAssistantReply(
  context: AsukaPeerContext,
  assistantText: string,
  at = Date.now(),
): boolean {
  const text = sanitizeMemoryText(assistantText);
  if (shouldSkipMemory(text)) return false;
  const classified = classifyAssistantMemory(text, at);
  if (!classified) return false;
  return upsertMemory(context, {
    ...classified,
    text,
    at,
  });
}

function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, " ")
    .trim();
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams: string[] = [];
  for (let i = 0; i < han.length - 1; i++) {
    bigrams.push(`${han[i]}${han[i + 1]}`);
  }
  return [...new Set([...latin, ...bigrams])].filter((token) => !LOW_SIGNAL_RETRIEVAL_TOKENS.has(token));
}

function countTokenOverlap(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  return tokenize(text).reduce((count, token) => count + (queryTokens.has(token) ? 1 : 0), 0);
}

function hasTokenOverlap(text: string, queryTokens: Set<string>): boolean {
  return countTokenOverlap(text, queryTokens) > 0;
}

function isStablePromptMemory(item: AsukaMemoryItem): boolean {
  return item.type === "user_profile" || item.type === "boundary" || item.type === "preference" || item.type === "explicit";
}

function shouldIncludeMemoryInPrompt(item: AsukaMemoryItem, queryTokens: Set<string>, now: number): boolean {
  if (queryTokens.size === 0) return true;
  if (isStablePromptMemory(item)) return true;
  if (hasTokenOverlap(item.text, queryTokens)) return true;
  if (item.type === "active_thread" && now - item.updatedAt <= RECENT_ACTIVE_PROMPT_MS) return true;
  if (item.type === "asuka_self_thread" && now - item.updatedAt <= RECENT_SELF_THREAD_PROMPT_MS) return true;
  return false;
}

function scoreMemory(item: AsukaMemoryItem, queryTokens: Set<string>, now: number): number {
  const overlap = countTokenOverlap(item.text, queryTokens);
  const ageDays = Math.max(0, (now - item.updatedAt) / (24 * 60 * 60 * 1000));
  const recency = Math.max(0, 2 - ageDays / 14);
  const typeBoost = item.type === "boundary" || item.type === "user_profile" ? 3
    : item.type === "preference" || item.type === "relationship" ? 2
      : item.type === "asuka_self_signal" ? 1.5
      : 0;
  const importanceBoost = item.importance === "important" ? 4 : 0;
  return item.salience + typeBoost + overlap * 2 + recency + item.confidence + importanceBoost;
}

function formatMemoryFlags(item: AsukaMemoryItem): string {
  const flags: string[] = [];
  if (item.importance === "important") flags.push("重要");
  if (item.temporary) flags.push("临时");
  return flags.length > 0 ? `（${flags.join("，")}）` : "";
}

function formatMemoryGroup(title: string, items: AsukaMemoryItem[], limit: number): string[] {
  const selected = items.slice(0, limit);
  if (selected.length === 0) return [];
  return [
    `${title}:`,
    ...selected.map((item) => `- ${item.text}${formatMemoryFlags(item)}`),
  ];
}

function extractMemoryControlText(text: string): string | null {
  const match = text.trim().match(MEMORY_CONTROL_PREFIX_RE);
  const commandText = match?.[1]?.trim() ?? "";
  return commandText ? commandText : null;
}

function extractMemorySteeringQuery(text: string): string {
  return text
    .replace(/^(请|麻烦|帮我|你)?(把|将)?/g, "")
    .replace(/(你)?(的)?(长期)?记忆/g, "")
    .replace(/(关于|有关|这件事|这个|这些|一下|吧|了|我说的)/g, "")
    .replace(MEMORY_MARK_IMPORTANT_RE, "")
    .replace(MEMORY_MARK_TEMPORARY_RE, "")
    .replace(MEMORY_CLEAR_IMPORTANCE_RE, "")
    .replace(/[：:，,。.!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMemoryControlIntent(text: string):
  | { action: "list" }
  | { action: "forget"; all: boolean; query: string }
  | { action: "mark_important"; query: string }
  | { action: "mark_temporary"; query: string }
  | { action: "clear_importance"; query: string }
  | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  if (MEMORY_LIST_RE.test(trimmed)) {
    return { action: "list" };
  }
  if (MEMORY_CLEAR_IMPORTANCE_RE.test(trimmed)) {
    return { action: "clear_importance", query: extractMemorySteeringQuery(trimmed) };
  }
  if (MEMORY_MARK_IMPORTANT_RE.test(trimmed) && /(把|将|关于|有关|标为|设为|当成|标记)/.test(trimmed)) {
    return { action: "mark_important", query: extractMemorySteeringQuery(trimmed) };
  }
  if (MEMORY_MARK_TEMPORARY_RE.test(trimmed) && /(把|将|关于|有关|标为|设为|当成|标记|临时|暂时)/.test(trimmed)) {
    return { action: "mark_temporary", query: extractMemorySteeringQuery(trimmed) };
  }
  if (!MEMORY_FORGET_RE.test(trimmed)) {
    return null;
  }
  const deleteLike = /(别记|不要记|删掉|删除|清除|清空|抹掉)/.test(trimmed);
  const forgetLike = /(忘了|忘掉|忘记)/.test(trimmed);
  const forgetCommandLike = /^(请|麻烦)?\s*(帮我)?\s*(把|将)?\s*(忘了|忘掉|忘记)/.test(trimmed)
    || /^(请|麻烦)?\s*帮我.*(忘了|忘掉|忘记)/.test(trimmed);
  if (forgetLike && !deleteLike && !forgetCommandLike) {
    return null;
  }

  const all = /(全部|所有|清空|清除.*记忆|删掉.*记忆|删除.*记忆|都忘|全忘)/.test(trimmed);
  let query = trimmed
    .replace(/^(请|麻烦|帮我|你)?(把|将)?/g, "")
    .replace(MEMORY_FORGET_RE, "")
    .replace(/(你)?(的)?(长期)?记忆/g, "")
    .replace(/(关于|有关|这件事|这个|这些|一下|吧|掉|了|我说的)/g, "")
    .replace(/[：:，,。.!！?？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (all) {
    query = "";
  }
  return { action: "forget", all, query };
}

function formatListReply(memories: AsukaMemoryItem[]): string {
  if (memories.length === 0) {
    return "我现在没有可列出的长期记忆。";
  }

  const sorted = memories
    .slice()
    .sort((a, b) => {
      const aScore = a.salience * 1000000000000 + a.updatedAt;
      const bScore = b.salience * 1000000000000 + b.updatedAt;
      return bScore - aScore;
    })
    .slice(0, MAX_LIST_MEMORIES);

  const profile = sorted.filter((item) => item.type === "user_profile" || item.type === "explicit");
  const preferences = sorted.filter((item) => item.type === "preference" || item.type === "boundary");
  const relationship = sorted.filter((item) => item.type === "relationship");
  const active = sorted.filter((item) => item.type === "active_thread" || item.type === "asuka_self_thread" || item.type === "asuka_self_signal");
  const lines = [
    "我现在记得这些：",
    ...formatMemoryGroup("关于你", profile, 4),
    ...formatMemoryGroup("偏好和边界", preferences, 4),
    ...formatMemoryGroup("我们聊过的事", relationship, 3),
    ...formatMemoryGroup("最近还没收尾的话题", active, 3),
  ];
  return lines.join("\n");
}

function scoreForgetCandidate(item: AsukaMemoryItem, query: string, queryTokens: Set<string>): number {
  const normalizedItem = normalizeForDedup(item.text);
  const normalizedQuery = normalizeForDedup(query);
  if (!normalizedQuery) return 0;

  let score = 0;
  if (normalizedItem.includes(normalizedQuery) || normalizedQuery.includes(normalizedItem)) {
    score += 10;
  }
  const itemTokens = tokenize(item.text);
  for (const token of itemTokens) {
    if (queryTokens.has(token)) {
      score += token.length >= 2 ? 3 : 1;
    }
  }
  if (item.key && tokenize(item.key).some((token) => queryTokens.has(token))) {
    score += 2;
  }
  return score;
}

function forgetMatchingMemories(state: AsukaMemoryStateFile, peerKey: string, query: string, now: number): number {
  const queryTokens = new Set(tokenize(query));
  const matches = getActivePeerMemories(state, peerKey, now)
    .map((item) => ({ item, score: scoreForgetCandidate(item, query, queryTokens) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  for (const { item } of matches) {
    delete state.memories[item.id];
  }
  return matches.length;
}

function updateMatchingMemories(
  state: AsukaMemoryStateFile,
  peerKey: string,
  query: string,
  now: number,
  update: (item: AsukaMemoryItem) => void,
): number {
  const queryTokens = new Set(tokenize(query));
  const matches = getActivePeerMemories(state, peerKey, now)
    .map((item) => ({ item, score: scoreForgetCandidate(item, query, queryTokens) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  for (const { item } of matches) {
    update(item);
    item.updatedAt = now;
  }
  return matches.length;
}

export function handleAsukaMemoryControlMessage(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now(),
): {
  handled: boolean;
  replyText?: string;
  action?: "list" | "forget" | "mark_important" | "mark_temporary" | "clear_importance";
  changed?: number;
} {
  if (context.peerKind !== "direct") return { handled: false };
  const text = sanitizeMemoryText(userText);
  if (shouldSkipMemory(text)) return { handled: false };
  const controlText = extractMemoryControlText(text);
  if (!controlText) return { handled: false };
  const intent = parseMemoryControlIntent(controlText);
  if (!intent) return { handled: false };

  const state = loadState();
  const peerKey = makePeerKey(context);
  maintainPeerMemories(state, peerKey, at);

  if (intent.action === "list") {
    const memories = getActivePeerMemories(state, peerKey, at);
    saveState();
    return {
      handled: true,
      action: "list",
      replyText: formatListReply(memories),
    };
  }

  if (intent.action === "mark_important") {
    const changed = intent.query
      ? updateMatchingMemories(state, peerKey, intent.query, at, (item) => {
        item.importance = "important";
        item.importanceUpdatedAt = at;
        item.salience = Math.max(item.salience, 10);
      })
      : 0;
    saveState();
    return {
      handled: true,
      action: "mark_important",
      changed,
      replyText: changed > 0
        ? "我会把相关记忆当作重要记忆。"
        : `我没找到和“${intent.query.slice(0, 40)}”匹配的长期记忆。`,
    };
  }

  if (intent.action === "mark_temporary") {
    const changed = intent.query
      ? updateMatchingMemories(state, peerKey, intent.query, at, (item) => {
        item.temporary = true;
        item.importanceUpdatedAt = at;
        const temporaryExpiresAt = at + TEMPORARY_MEMORY_TTL_MS;
        item.expiresAt = item.expiresAt ? Math.min(item.expiresAt, temporaryExpiresAt) : temporaryExpiresAt;
      })
      : 0;
    saveState();
    return {
      handled: true,
      action: "mark_temporary",
      changed,
      replyText: changed > 0
        ? "我会把相关记忆当作临时记忆，过一段时间它会自动淡掉。"
        : `我没找到和“${intent.query.slice(0, 40)}”匹配的长期记忆。`,
    };
  }

  if (intent.action === "clear_importance") {
    const changed = intent.query
      ? updateMatchingMemories(state, peerKey, intent.query, at, (item) => {
        item.importance = "normal";
        item.importanceUpdatedAt = at;
        item.salience = Math.min(item.salience, 6);
      })
      : 0;
    saveState();
    return {
      handled: true,
      action: "clear_importance",
      changed,
      replyText: changed > 0
        ? "好，我不会再把相关记忆当作特别重要。"
        : `我没找到和“${intent.query.slice(0, 40)}”匹配的长期记忆。`,
    };
  }

  if (intent.all) {
    const active = getActivePeerMemories(state, peerKey, at);
    for (const item of active) {
      delete state.memories[item.id];
    }
    saveState();
    return {
      handled: true,
      action: "forget",
      changed: active.length,
      replyText: active.length > 0 ? "我已经把这段私聊里的长期记忆清空了。" : "我这里本来就没有可清空的长期记忆。",
    };
  }

  if (!intent.query) {
    saveState();
    return {
      handled: true,
      action: "forget",
      changed: 0,
      replyText: "你具体想让我忘掉哪件事？可以直接说“忘记关于……的记忆”。",
    };
  }

  const changed = forgetMatchingMemories(state, peerKey, intent.query, at);
  saveState();
  return {
    handled: true,
    action: "forget",
    changed,
    replyText: changed > 0
      ? "我已经把相关记忆删掉了。"
      : `我没找到和“${intent.query.slice(0, 40)}”匹配的长期记忆。`,
  };
}

export function buildAsukaLongTermMemoryPrompt(
  context: AsukaPeerContext,
  currentUserText = "",
  now = Date.now(),
): string {
  if (context.peerKind !== "direct") return "";
  const state = loadState();
  const peerKey = makePeerKey(context);
  maintainPeerMemories(state, peerKey, now);
  const queryTokens = new Set(tokenize(currentUserText));
  const memories = getActivePeerMemories(state, peerKey, now)
    .filter((item) => shouldIncludeMemoryInPrompt(item, queryTokens, now))
    .sort((a, b) => scoreMemory(b, queryTokens, now) - scoreMemory(a, queryTokens, now));

  if (memories.length === 0) {
    saveState();
    return "";
  }

  const userFacts = memories.filter((item) => item.type === "user_profile" || item.type === "boundary" || item.type === "preference" || item.type === "explicit");
  const relationship = memories.filter((item) => item.type === "relationship");
  const active = memories.filter((item) => item.type === "active_thread");
  const selfThreads = memories.filter((item) => item.type === "asuka_self_thread" || item.type === "asuka_self_signal");
  const lines = [
    "【Asuka 长期记忆】",
    "- 这些记忆只用于当前私聊；不要在群聊或其他人面前透露。",
    "- 使用原则: 只在和本轮自然相关时轻轻带上，不要像背档案，也不要逐条复述。",
    "- 自我生活线只作为轻量连续性线索；不要把它扩写成完整履历、固定日程或无关新设定。",
    "- 如果本轮涉及承诺/补救/用户明确请求，以承诺/补救/请求优先，自我生活线只能辅助语气。",
    ...formatMemoryGroup("关于对方", userFacts, 5),
    ...formatMemoryGroup("关系里的事", relationship, 3),
    ...formatMemoryGroup("未完话题", active, 2),
    ...formatMemoryGroup("Asuka 自我生活线和稳定偏好", selfThreads, 2),
  ];

  for (const item of memories.slice(0, 10)) {
    item.lastUsedAt = now;
  }
  saveState();

  const prompt = lines.join("\n");
  return prompt.length > MAX_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_PROMPT_CHARS).trimEnd()}...`
    : prompt;
}

export function buildAsukaProactiveMemoryPrompt(
  context: AsukaPeerContext,
  cueText = "",
  now = Date.now(),
): string {
  if (context.peerKind !== "direct") return "";
  const prompt = buildAsukaLongTermMemoryPrompt(context, cueText, now);
  if (!prompt) return "";
  return [
    prompt,
    "- 主动触达时最多借用一条最相关的记忆作为温度；不要主动盘点、追问、复述档案，也不要说你查看了记忆。",
    "- ambient/self_thread 主动触达可以轻轻延续一条最近自我生活线；如果存在承诺/补救内容，承诺/补救优先。",
  ].join("\n");
}
