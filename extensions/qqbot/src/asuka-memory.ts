import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AsukaPeerContext } from "./asuka-state.js";
import { makePeerKey } from "./asuka-state.js";
import { getOpenAICompletionsThinkingParams, resolveQQBotSceneInferenceConfig, type OpenAICompletionsModelConfig } from "./config.js";
import { getQQBotDataDir } from "./utils/platform.js";
import { isAsukaMemoryWikiPrimary, syncAsukaMemoryWiki } from "./asuka-memory-wiki.js";

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
type AsukaSelfSignalCategory =
  | "attachment_style"
  | "care_style"
  | "communication_style"
  | "commitment_style"
  | "temperament"
  | "boundaries"
  | "vulnerabilities"
  | "aesthetic_taste";
type AsukaSelfSignalAction = "add" | "update" | "replace" | "ignore";
type AsukaUserMemoryAction = "add" | "update" | "replace" | "ignore";
type AsukaUserMemoryType = "user_profile" | "preference" | "boundary" | "relationship" | "active_thread" | "explicit";
type AsukaUserMemorySlot =
  | "name"
  | "birthday"
  | "anniversary"
  | "timezone"
  | "residence_home"
  | "residence_temporary"
  | "current_location"
  | "residence_plan"
  | "workplace"
  | "school"
  | "preference_address"
  | "preference_reply_style"
  | "preference_image"
  | "preference_voice"
  | "preference_timing"
  | "boundary_address"
  | "boundary_image"
  | "boundary_voice"
  | "boundary_topic"
  | "relationship_status"
  | "active_commitment"
  | "other";

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
  personalityCategory?: AsukaSelfSignalCategory;
  importance?: AsukaMemoryImportance;
  temporary?: boolean;
  importanceUpdatedAt?: number;
  privacy: AsukaMemoryPrivacy;
  key?: string;
  userMemorySlot?: AsukaUserMemorySlot;
  userMemoryEvidence?: string;
  extractionVersion?: 2;
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
const MAX_ASUKA_SELF_SIGNAL_PER_PEER = 24;
const MAX_ASUKA_SELF_SIGNAL_PER_CATEGORY = 3;
const MAX_PROMPT_CHARS = 1100;
const MAX_LIST_MEMORIES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_THREAD_TTL_MS = 21 * DAY_MS;
const SELF_THREAD_TTL_MS = 10 * DAY_MS;
const SELF_SIGNAL_TTL_MS = 180 * DAY_MS;
const TEMPORARY_MEMORY_TTL_MS = 7 * DAY_MS;
const ACTIVE_THREAD_COMPACT_AFTER_MS = 7 * DAY_MS;
const RECENT_ACTIVE_PROMPT_MS = 3 * DAY_MS;
const RECENT_SELF_THREAD_PROMPT_MS = 2 * DAY_MS;
const SELF_THREAD_FRESHNESS_MS = RECENT_SELF_THREAD_PROMPT_MS;
const cache: { state: AsukaMemoryStateFile | null } = { state: null };

const STRUCTURED_ARTIFACT_RE = /Q{1,2}BOT_(?:PAYLOAD|CRON):[\s\S]*$/gi;
const MEDIA_TAG_RE = /<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
const INTERNAL_LEAK_RE = /(asuka-selfie|Q{1,2}BOT_(?:PAYLOAD|CRON)|任务完成总结[:：]|提醒已发送|根据任务描述|工具调用|调试信息|API 调用|脚本|进程状态|通道规则|读取\s*(?:skill|技能)\s*文件|skill\s*文件|(?:imagegen|asuka-selfie|qqbot-media)\s+skill|⚠️?\s*Cron job\s+"[^"]+"\s+failed|cron:\s*job interrupted by gateway restart)/i;
const SECRET_RE = /(密码|口令|验证码|token|api[_-]?key|secret|密钥|身份证|银行卡|信用卡|私钥|助记词|cookie|authorization)/i;
const EXPLICIT_MEMORY_COMMAND_RE = /^(?:(?:请|麻烦)(?:你)?[，,:：\s]*)?(?:(?:你)?帮我记(?:一下)?|记住|记下|记好|记得(?=(?:我|我们|以后|明天|后天|下周|下月|每))|别忘(?:了|记)?|你要记(?:住|得)|以后(?:你)?(?:要)?记得)/;
const EXPLICIT_REMINDER_RE = /^(?:(?:请|麻烦)(?:你)?|你)[，,:：\s]*记得/;
const EXPLICIT_IMPORTANCE_RE = /(?:这点|这个|这件事)(?:真的|非常)?很?重要(?=[，,:：。！!\s]|$)/;
const LOW_INFORMATION_MEMORY_REPLY_RE = /^(?:[嗯哦噢啊诶唉哈]+[，,\s]*)?(?:不(?:太)?记得(?:了)?|记不(?:太)?清(?:了)?|没有(?:吧|啊|呢)?|没(?:有)?(?:吧|呢)?|不知道|不清楚)[。！？!?~～…\s]*$/;
const USER_PROFILE_RE = /(我叫|叫我|我的名字|我的生日|生日是|纪念日是|我的时区|我的城市|我住在|我的住所|我家在|我在[^。！？!?]{0,40}(?:工作|上学))/;
const PREFERENCE_RE = /(我喜欢|我偏好|我更喜欢|我习惯|我希望(?:你|以后|回复)|对我来说[^。！？!?]{0,40}重要)/;
const BOUNDARY_RE = /(我不喜欢|我讨厌|我不想被|我介意|我的雷点|让我不舒服|别再|不要再|别叫我)/;
const RELATIONSHIP_RE = /(同居|恋人|情侣|夫妻|结婚|在一起|分手|和好|我们约定|我们拉钩|纪念日|我爱你|我喜欢你)/;
const ACTIVE_THREAD_RE = /(最近|这几天|这周|今天|明天|回头|继续|下次|等会|一会|待会|正在|准备|计划)/;
const RESIDENCE_RE = /(住在|住所|家在|宿舍|暂住|临时住|短住|借住|搬到|搬家|现在在|目前在|此刻在)/;
const ASUKA_SELF_THREAD_RE = /(我(最近|这几天|这周|今天|明天|现在|刚刚|等会|准备|正在).*(上课|自习|作业|课题|拍照|拍视频|剪视频|咖啡|宿舍|学校|校园|西湖|湖滨|运河|雨|散步|电影|音乐|练舞|整理|复习|画面|镜头|照片))/;
const ASUKA_SELF_SIGNAL_RE = /我(其实|还是|一直|会|更|不太|有点|真的)?[^。！？!?]{0,80}(喜欢|更喜欢|愿意|更愿意|不喜欢|习惯|在意|怕|介意|想靠近|想离你近|会想你|想陪着你|不想敷衍|想认真对你)/;
const ASUKA_SELF_SIGNAL_STABLE_RE = /(一直|总是|通常|习惯|更喜欢|不喜欢|不太喜欢|不想|不会|会认真|不想敷衍|认真对你|慢慢|稳定|每次|以后)/;
const SELF_SIGNAL_MODEL_TIMEOUT_MS = 8000;
const USER_MEMORY_MODEL_TIMEOUT_MS = Math.max(10, Number(process.env.ASUKA_USER_MEMORY_TEST_TIMEOUT_MS) || 8000);
const MAX_USER_MEMORY_VERDICTS = 3;
const MAX_USER_MEMORY_CANONICAL_LENGTH = 140;
const MAX_USER_MEMORY_EVIDENCE_LENGTH = 160;
const USER_MEMORY_TYPES = new Set<AsukaUserMemoryType>([
  "user_profile",
  "preference",
  "boundary",
  "relationship",
  "active_thread",
  "explicit",
]);
const USER_MEMORY_SLOTS = new Set<AsukaUserMemorySlot>([
  "name",
  "birthday",
  "anniversary",
  "timezone",
  "residence_home",
  "residence_temporary",
  "current_location",
  "residence_plan",
  "workplace",
  "school",
  "preference_address",
  "preference_reply_style",
  "preference_image",
  "preference_voice",
  "preference_timing",
  "boundary_address",
  "boundary_image",
  "boundary_voice",
  "boundary_topic",
  "relationship_status",
  "active_commitment",
  "other",
]);
const SELF_SIGNAL_CATEGORIES = new Set<AsukaSelfSignalCategory>([
  "attachment_style",
  "care_style",
  "communication_style",
  "commitment_style",
  "temperament",
  "boundaries",
  "vulnerabilities",
  "aesthetic_taste",
]);
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
  syncAsukaMemoryWiki(Object.values(cache.state.memories));
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

function isExplicitMemoryRequest(text: string): boolean {
  const normalized = text.trim().replace(/^(?:Asuka|明日香)[，,:：\s]*/i, "");
  return EXPLICIT_MEMORY_COMMAND_RE.test(normalized)
    || EXPLICIT_REMINDER_RE.test(normalized)
    || (!/[?？]/.test(normalized) && EXPLICIT_IMPORTANCE_RE.test(normalized));
}

function classifyUserMemory(text: string, at: number): {
  type: AsukaMemoryType;
  source: AsukaMemorySource;
  salience: number;
  confidence: number;
  expiresAt?: number;
} | null {
  const explicit = isExplicitMemoryRequest(text);
  if (!explicit && /[?？]|(?:还记得|记不记得|知道不知道|你知道).*(?:吗|呢|么)/.test(text)) {
    return null;
  }
  if (BOUNDARY_RE.test(text)) {
    return { type: "boundary", source: explicit ? "user_explicit" : "user_inferred", salience: explicit ? 10 : 8, confidence: explicit ? 0.95 : 0.78 };
  }
  if (USER_PROFILE_RE.test(text) || RESIDENCE_RE.test(text)) {
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

function deriveSelfSignalCategory(text: string): AsukaSelfSignalCategory | null {
  if (/(照片|自拍|图片|画面|镜头|构图|氛围|生活感|自然一点)/.test(text)) return "aesthetic_taste";
  if (/(敷衍|认真|补上|答应|约定|承诺|说到做到)/.test(text)) return "commitment_style";
  if (/(靠近|离你近|距离|黏|想你|依赖|慢慢来|拉近)/.test(text)) return "attachment_style";
  if (/(陪着你|惦记|照顾|留意|担心你|哄你|撑着)/.test(text)) return "care_style";
  if (/(语气|说话|表达|直白|温柔|克制|解释|机械|撒娇)/.test(text)) return "communication_style";
  if (/(安静|慢热|敏感|心软|要强|别扭|热闹)/.test(text)) return "temperament";
  if (/(不舒服|不接受|不想被|别把我|当工具|强迫|营业)/.test(text)) return "boundaries";
  if (/(怕被忽略|怕打扰|怕你不理|怕显得|软肋|不安)/.test(text)) return "vulnerabilities";
  return null;
}

interface AsukaSelfSignalVerdict {
  action: AsukaSelfSignalAction;
  continuityKind: AsukaContinuityKind;
  personalityCategory: AsukaSelfSignalCategory;
  canonicalText: string;
  confidence: number;
  targetMemoryIds: string[];
  reason: string;
  source: "model" | "fallback_model" | "mock" | "rule_fallback" | "invalid" | "unavailable";
}

interface AsukaUserMemoryVerdict {
  action: AsukaUserMemoryAction;
  type: AsukaUserMemoryType;
  slot: AsukaUserMemorySlot;
  canonicalText: string;
  explicitIntent: boolean;
  importance: AsukaMemoryImportance;
  temporary: boolean;
  confidence: number;
  targetMemoryIds: string[];
  evidence: string;
  source: "model" | "fallback_model" | "mock";
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
  personalityCategory?: AsukaSelfSignalCategory;
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
    const personalityCategory = deriveSelfSignalCategory(text);
    return {
      type: "asuka_self_signal",
      source: "assistant_self_signal",
      salience: 7,
      confidence: 0.64,
      expiresAt: at + SELF_SIGNAL_TTL_MS,
      continuityKind: deriveContinuityKind(text),
      personalityCategory: personalityCategory ?? "communication_style",
    };
  }
  return null;
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i]!;
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
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function extractTextFromCompletionPayload(raw: any): string {
  const choice = raw?.choices?.[0];
  const messageContent = choice?.message?.content;
  if (typeof messageContent === "string") return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => typeof part?.text === "string" ? part.text : typeof part === "string" ? part : "")
      .join("")
      .trim();
  }
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

function sanitizeSelfSignalCanonicalText(text: string): string {
  const sanitized = sanitizeMemoryText(text);
  if (!sanitized || shouldSkipMemory(sanitized)) return "";
  return sanitized;
}

function normalizeContinuityKind(value: unknown): AsukaContinuityKind | null {
  if (value === "preference" || value === "boundary" || value === "emotional_continuity") return value;
  return null;
}

function normalizeSelfSignalCategory(value: unknown): AsukaSelfSignalCategory | null {
  return typeof value === "string" && SELF_SIGNAL_CATEGORIES.has(value as AsukaSelfSignalCategory)
    ? value as AsukaSelfSignalCategory
    : null;
}

function normalizeSelfSignalAction(value: unknown): AsukaSelfSignalAction | null {
  if (value === "add" || value === "update" || value === "replace" || value === "ignore") return value;
  return null;
}

function parseSelfSignalVerdict(rawText: string, source: AsukaSelfSignalVerdict["source"]): AsukaSelfSignalVerdict | null {
  const jsonText = extractFirstJsonObject(rawText) ?? rawText.trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as {
      action?: unknown;
      continuityKind?: unknown;
      personalityCategory?: unknown;
      canonicalText?: unknown;
      confidence?: unknown;
      targetMemoryIds?: unknown;
      reason?: unknown;
    };
    const action = normalizeSelfSignalAction(parsed.action);
    const continuityKind = normalizeContinuityKind(parsed.continuityKind);
    const personalityCategory = normalizeSelfSignalCategory(parsed.personalityCategory);
    const canonicalText = sanitizeSelfSignalCanonicalText(String(parsed.canonicalText ?? ""));
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence)));
    if (!action || !continuityKind || !personalityCategory || !Number.isFinite(confidence)) return null;
    if (action !== "ignore" && !canonicalText) return null;
    const targetMemoryIds = Array.isArray(parsed.targetMemoryIds)
      ? parsed.targetMemoryIds.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 5)
      : [];
    return {
      action,
      continuityKind,
      personalityCategory,
      canonicalText,
      confidence,
      targetMemoryIds,
      reason: sanitizeMemoryText(String(parsed.reason ?? "")),
      source,
    };
  } catch {
    return null;
  }
}

function normalizeUserMemoryAction(value: unknown): AsukaUserMemoryAction | null {
  return value === "add" || value === "update" || value === "replace" || value === "ignore" ? value : null;
}

function normalizeUserMemoryType(value: unknown): AsukaUserMemoryType | null {
  return typeof value === "string" && USER_MEMORY_TYPES.has(value as AsukaUserMemoryType)
    ? value as AsukaUserMemoryType
    : null;
}

function normalizeUserMemorySlot(value: unknown): AsukaUserMemorySlot | null {
  return typeof value === "string" && USER_MEMORY_SLOTS.has(value as AsukaUserMemorySlot)
    ? value as AsukaUserMemorySlot
    : null;
}

function isUserMemorySlotCompatible(type: AsukaUserMemoryType, slot: AsukaUserMemorySlot): boolean {
  if (slot === "other") return type === "explicit";
  if (slot === "relationship_status") return type === "relationship";
  if (slot === "active_commitment") return type === "active_thread";
  if (slot.startsWith("preference_")) return type === "preference";
  if (slot.startsWith("boundary_")) return type === "boundary";
  return type === "user_profile";
}

function parseUserMemoryVerdicts(
  rawText: string,
  originalText: string,
  source: AsukaUserMemoryVerdict["source"],
): AsukaUserMemoryVerdict[] | null {
  const jsonText = extractFirstJsonObject(rawText) ?? rawText.trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as { memories?: unknown };
    if (!Array.isArray(parsed.memories) || parsed.memories.length > MAX_USER_MEMORY_VERDICTS) return null;
    const verdicts: AsukaUserMemoryVerdict[] = [];
    for (const raw of parsed.memories) {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;
      const action = normalizeUserMemoryAction(item.action);
      const type = normalizeUserMemoryType(item.type);
      const slot = normalizeUserMemorySlot(item.slot);
      const confidence = item.confidence;
      const canonicalText = typeof item.canonicalText === "string" ? sanitizeMemoryText(item.canonicalText) : "";
      const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
      const evidenceTokens = new Set(tokenize(evidence).filter((token) => token.length >= 2));
      const hasGroundedContent = tokenize(canonicalText)
        .some((token) => token.length >= 2 && evidenceTokens.has(token));
      const hasCanonicalPerspective = type === "relationship"
        ? /^用户(?:与|和)\s*Asuka\b/i.test(canonicalText)
        : /^用户/.test(canonicalText);
      if (
        !action ||
        !type ||
        !slot ||
        !isUserMemorySlotCompatible(type, slot) ||
        typeof item.explicitIntent !== "boolean" ||
        (item.importance !== "normal" && item.importance !== "important") ||
        typeof item.temporary !== "boolean" ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        canonicalText.length > MAX_USER_MEMORY_CANONICAL_LENGTH ||
        evidence.length === 0 ||
        evidence.replace(/[，。！？,.!?\s]/g, "").length < 2 ||
        evidence.length > MAX_USER_MEMORY_EVIDENCE_LENGTH ||
        !originalText.includes(evidence) ||
        !hasGroundedContent ||
        !hasCanonicalPerspective
      ) {
        return null;
      }
      const targetMemoryIds = Array.isArray(item.targetMemoryIds) &&
          item.targetMemoryIds.every((id) => typeof id === "string" && id.trim().length > 0)
        ? item.targetMemoryIds.map((id) => (id as string).trim())
        : null;
      if (!targetMemoryIds || targetMemoryIds.length > 5 || new Set(targetMemoryIds).size !== targetMemoryIds.length) return null;
      if (action !== "ignore" && (!canonicalText || shouldSkipMemory(canonicalText))) return null;
      if (action === "add" && targetMemoryIds.length !== 0) return null;
      if (action === "update" && targetMemoryIds.length !== 1) return null;
      if (action === "replace" && targetMemoryIds.length === 0) return null;
      if (action === "ignore" && targetMemoryIds.length !== 0) return null;
      verdicts.push({
        action,
        type,
        slot,
        canonicalText,
        explicitIntent: item.explicitIntent && isExplicitMemoryRequest(originalText),
        importance: item.importance,
        temporary: item.temporary,
        confidence,
        targetMemoryIds,
        evidence,
        source,
      });
    }
    return verdicts;
  } catch {
    return null;
  }
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？,.!?\s]/g, "")
    .slice(0, 80);
}

function deriveSelfSignalCategoryFromKey(key: string | undefined): AsukaSelfSignalCategory | null {
  if (!key) return null;
  const last = key.split(":").pop();
  return normalizeSelfSignalCategory(last);
}

function getMemoryStatus(item: AsukaMemoryItem): AsukaMemoryStatus {
  return item.status ?? "active";
}

function isActiveMemory(item: AsukaMemoryItem, now: number): boolean {
  return getMemoryStatus(item) === "active" && (!item.expiresAt || item.expiresAt > now);
}

function deriveMemoryKey(type: AsukaMemoryType, text: string): string | undefined {
  if (type === "asuka_self_signal") {
    return undefined;
  }
  if (type === "user_profile") {
    if (/(我叫|叫我|我的名字|别叫)/.test(text)) return "user:name";
    if (/生日/.test(text)) return "user:birthday";
    if (/纪念日/.test(text)) return "user:anniversary";
    if (/时区/.test(text)) return "user:timezone";
    if (/(计划|准备|打算|将要|未来|下月|之后).*(搬|住)/.test(text)) return "user:residence:plan";
    if (/(暂住|临时住|短住|借住|住一阵|暑假.*住)/.test(text)) return "user:residence:temporary-stay";
    if (/(?:现在|目前|此刻|刚刚?)在(?!.*(?:住|宿舍|家))/.test(text)) return "user:residence:current-presence";
    if (/(住在|住所|家在|搬到|宿舍)/.test(text)) return "user:residence:home-base";
    if (/(城市|在.*工作|在.*上学|学校|公司)/.test(text)) return "user:location";
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

function supersedeMemory(item: AsukaMemoryItem, newId: string, at: number): void {
  item.status = "superseded";
  item.supersededBy = newId;
  item.supersededAt = at;
  item.updatedAt = at;
  item.confidence = Math.min(item.confidence, 0.25);
  item.salience = Math.min(item.salience, 1);
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
  pruneAsukaSelfSignalsByCategory(state, peerKey);
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
  personalityCategory?: AsukaSelfSignalCategory;
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
    existing.personalityCategory = input.personalityCategory ?? existing.personalityCategory;
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
    personalityCategory: input.personalityCategory,
    importance: input.importance,
    temporary: input.temporary,
    importanceUpdatedAt: input.importance ? input.at : undefined,
    privacy: "direct_only",
    key,
    status: "active",
  };
  if (input.type !== "asuka_self_signal") {
    supersedeConflictingMemories(state, peerKey, key, id, text, input.at);
  }
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

function pruneAsukaSelfSignalsByCategory(state: AsukaMemoryStateFile, peerKey: string): void {
  const grouped = new Map<AsukaSelfSignalCategory, AsukaMemoryItem[]>();
  for (const item of Object.values(state.memories)) {
    if (item.peerKey !== peerKey || item.type !== "asuka_self_signal" || getMemoryStatus(item) !== "active") continue;
    const category = item.personalityCategory ?? deriveSelfSignalCategory(item.text) ?? deriveSelfSignalCategoryFromKey(item.key);
    if (!category) continue;
    item.personalityCategory = category;
    item.key = item.key ?? `asuka:${category}:${item.id}`;
    const items = grouped.get(category) ?? [];
    items.push(item);
    grouped.set(category, items);
  }
  for (const items of grouped.values()) {
    const sorted = items.sort((a, b) => {
      const aScore = a.salience * 1000000000000 + a.confidence * 1000000000 + a.updatedAt;
      const bScore = b.salience * 1000000000000 + b.confidence * 1000000000 + b.updatedAt;
      return bScore - aScore;
    });
    for (const item of sorted.slice(MAX_ASUKA_SELF_SIGNAL_PER_CATEGORY)) {
      delete state.memories[item.id];
    }
  }
}

function keyForUserMemorySlot(slot: AsukaUserMemorySlot): string | undefined {
  switch (slot) {
    case "name": return "user:name";
    case "birthday": return "user:birthday";
    case "anniversary": return "user:anniversary";
    case "timezone": return "user:timezone";
    case "residence_home": return "user:residence:home-base";
    case "residence_temporary": return "user:residence:temporary-stay";
    case "current_location": return "user:residence:current-presence";
    case "residence_plan": return "user:residence:plan";
    case "workplace": return "user:workplace";
    case "school": return "user:school";
    case "preference_address": return "preference:address";
    case "preference_reply_style": return "preference:reply_style";
    case "preference_image": return "preference:image";
    case "preference_voice": return "preference:voice";
    case "preference_timing": return "preference:timing";
    case "boundary_address": return "boundary:address";
    case "boundary_image": return "boundary:image";
    case "boundary_voice": return "boundary:voice";
    case "boundary_topic": return "boundary:topic";
    case "relationship_status": return "relationship:status";
    case "active_commitment": return "thread:commitment";
    case "other": return undefined;
  }
}

function isSingleValueUserMemorySlot(slot: AsukaUserMemorySlot): boolean {
  return [
    "name",
    "birthday",
    "timezone",
    "residence_home",
    "residence_temporary",
    "current_location",
    "residence_plan",
    "workplace",
    "school",
    "relationship_status",
  ].includes(slot);
}

function formatUserMemoryCandidates(items: AsukaMemoryItem[]): string {
  if (items.length === 0) return "none";
  return items
    .slice()
    .sort((a, b) => (b.salience - a.salience) || (b.updatedAt - a.updatedAt))
    .slice(0, 30)
    .map((item) => `- id=${item.id} type=${item.type} slot=${item.userMemorySlot ?? "legacy"} slotKey=${item.key ?? "none"} text=${item.text}`)
    .join("\n");
}

function buildUserMemoryJudgePrompt(text: string, existing: AsukaMemoryItem[]): string {
  return [
    "你是用户长期记忆提取器，只能输出一个 JSON 对象，不要解释。",
    "从当前用户原话提取 0 到 3 条值得跨会话保留的结构化事实。一次消息可提取多条。",
    "只记录说话者本人或用户与 Asuka 的关系；第三人的事实、提问、试探你是否记得、否定掉的旧事实、随口聊天和低信息回复不要记录。",
    "区分常住地、暂住地、当前位置和未来搬家计划。更新同一事实用 update；明确冲突并替代旧事实用 replace；新侧面用 add。",
    "type 只能选 user_profile, preference, boundary, relationship, active_thread, explicit。",
    "slot 只能选 name, birthday, anniversary, timezone, residence_home, residence_temporary, current_location, residence_plan, workplace, school, preference_address, preference_reply_style, preference_image, preference_voice, preference_timing, boundary_address, boundary_image, boundary_voice, boundary_topic, relationship_status, active_commitment, other。",
    "other 只能搭配 explicit；relationship_status 只能搭配 relationship；active_commitment 只能搭配 active_thread；preference_* 和 boundary_* 必须搭配对应 type；其余 slot 搭配 user_profile。",
    "canonicalText 是自然、独立、无歧义的中文事实句，不超过 140 字。evidence 必须逐字复制用户原话中的一个连续片段，不超过 160 字。",
    "explicitIntent 仅在用户明确要求记住时为 true。importance 只能 normal 或 important。temporary 必须是布尔值。",
    "置信度门槛: 明确要求记住至少 0.55；普通隐式事实至少 0.82；replace 至少 0.88。不够就返回空数组。",
    "update 必须指定恰好一个当前记忆 id；replace 至少一个；add 和 ignore 不得指定 id。不要编造 id。",
    "输出格式: {\"memories\":[{\"action\":\"add|update|replace|ignore\",\"type\":\"...\",\"slot\":\"...\",\"canonicalText\":\"...\",\"explicitIntent\":false,\"importance\":\"normal|important\",\"temporary\":false,\"confidence\":0.0,\"targetMemoryIds\":[],\"evidence\":\"用户原文连续片段\"}]}",
    `用户原话: ${text}`,
    `当前有效用户记忆:\n${formatUserMemoryCandidates(existing)}`,
  ].join("\n");
}

function userMemoryVerdictMeetsThreshold(verdict: AsukaUserMemoryVerdict): boolean {
  if (verdict.action === "ignore") return false;
  if (verdict.action === "replace") return verdict.confidence >= 0.88;
  return verdict.confidence >= (verdict.explicitIntent ? 0.55 : 0.82);
}

async function requestUserMemoryVerdicts(
  context: AsukaPeerContext,
  text: string,
  existing: AsukaMemoryItem[],
): Promise<AsukaUserMemoryVerdict[] | null> {
  const mock = process.env.ASUKA_USER_MEMORY_TEST_VERDICT?.trim();
  if (mock) {
    if (mock === "__UNAVAILABLE__") return null;
    return parseUserMemoryVerdicts(mock, text, "mock");
  }

  const resolved = resolveQQBotSceneInferenceConfig(context.accountId);
  const models = [
    { config: resolved.primary, source: "model" as const },
    { config: resolved.fallback, source: "fallback_model" as const },
  ].filter((item): item is { config: OpenAICompletionsModelConfig; source: "model" | "fallback_model" } => Boolean(item.config));
  if (models.length === 0) return null;

  const prompt = buildUserMemoryJudgePrompt(text, existing);
  for (const model of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), USER_MEMORY_MODEL_TIMEOUT_MS);
    try {
      const response = await fetch(`${model.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${model.config.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: model.config.model,
          ...getOpenAICompletionsThinkingParams(model.config.model, "off"),
          temperature: 0.1,
          max_tokens: 700,
          messages: [
            {
              role: "system",
              content: "你只负责提取用户长期记忆，必须只输出符合约束的 JSON 对象。",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });
      const detail = await response.text();
      if (!response.ok) continue;
      const verdicts = parseUserMemoryVerdicts(extractTextFromCompletionPayload(JSON.parse(detail)), text, model.source);
      if (verdicts) return verdicts;
    } catch {
      // Try fallback model below.
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

function applyUserMemoryVerdicts(
  context: AsukaPeerContext,
  verdicts: AsukaUserMemoryVerdict[],
  at: number,
): boolean {
  const accepted = verdicts.filter(userMemoryVerdictMeetsThreshold);
  if (accepted.length === 0) return false;
  const state = loadState();
  const peerKey = makePeerKey(context);
  maintainPeerMemories(state, peerKey, at);
  const activeById = new Map(
    getActivePeerMemories(state, peerKey, at)
      .filter((item) => item.source === "user_explicit" || item.source === "user_inferred")
      .map((item) => [item.id, item]),
  );
  const matchesSlot = (item: AsukaMemoryItem, verdict: AsukaUserMemoryVerdict): boolean => {
    const key = keyForUserMemorySlot(verdict.slot);
    if (item.userMemorySlot) return item.userMemorySlot === verdict.slot;
    if (key) return item.key === key;
    return verdict.slot === "other" && item.type === "explicit" && !item.key;
  };
  let changed = false;
  for (const verdict of accepted) {
    const targets = verdict.targetMemoryIds.map((id) => activeById.get(id));
    if (targets.some((item) => !item || !matchesSlot(item, verdict))) continue;
    if (
      verdict.action === "add"
      && [...activeById.values()].some((item) =>
        matchesSlot(item, verdict)
        && (
          isSingleValueUserMemorySlot(verdict.slot)
          || normalizeForDedup(item.text) === normalizeForDedup(verdict.canonicalText)
        )
      )
    ) continue;
    const source: AsukaMemorySource = verdict.explicitIntent ? "user_explicit" : "user_inferred";
    const key = keyForUserMemorySlot(verdict.slot);
    const temporary = verdict.temporary
      || verdict.slot === "current_location"
      || verdict.slot === "residence_temporary";
    const expiresAt = temporary
      ? at + TEMPORARY_MEMORY_TTL_MS
      : verdict.type === "active_thread"
        ? at + ACTIVE_THREAD_TTL_MS
        : undefined;
    if (verdict.action === "update") {
      const target = activeById.get(verdict.targetMemoryIds[0]!)!;
      target.type = verdict.type;
      target.text = verdict.canonicalText;
      target.source = source;
      target.sourceMessageId = context.messageId;
      target.updatedAt = at;
      target.salience = verdict.importance === "important" ? 10 : Math.max(target.salience, verdict.explicitIntent ? 9 : 7);
      target.confidence = verdict.confidence;
      target.expiresAt = expiresAt;
      target.importance = verdict.importance;
      target.temporary = temporary || undefined;
      target.importanceUpdatedAt = verdict.importance === "important" ? at : undefined;
      target.key = key;
      target.userMemorySlot = verdict.slot;
      target.userMemoryEvidence = verdict.evidence;
      target.extractionVersion = 2;
      target.status = "active";
      changed = true;
      continue;
    }

    const id = randomUUID();
    state.memories[id] = {
      id,
      accountId: context.accountId,
      peerKey,
      peerKind: context.peerKind,
      peerId: context.peerId,
      type: verdict.type,
      text: verdict.canonicalText,
      source,
      sourceMessageId: context.messageId,
      createdAt: at,
      updatedAt: at,
      salience: verdict.importance === "important" ? 10 : verdict.explicitIntent ? 9 : 7,
      confidence: verdict.confidence,
      expiresAt,
      importance: verdict.importance,
      temporary: temporary || undefined,
      importanceUpdatedAt: verdict.importance === "important" ? at : undefined,
      privacy: "direct_only",
      key,
      userMemorySlot: verdict.slot,
      userMemoryEvidence: verdict.evidence,
      extractionVersion: 2,
      status: "active",
    };
    if (verdict.action === "replace") {
      for (const targetId of verdict.targetMemoryIds) {
        supersedeMemory(activeById.get(targetId)!, id, at);
        activeById.delete(targetId);
      }
    }
    activeById.set(id, state.memories[id]!);
    changed = true;
  }
  if (!changed) return false;
  maintainPeerMemories(state, peerKey, at);
  saveState();
  return true;
}

export function recordAsukaLongTermMemoryFromUserMessage(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now(),
): boolean {
  const text = sanitizeMemoryText(userText);
  if (shouldSkipMemory(text)) return false;
  if (LOW_INFORMATION_MEMORY_REPLY_RE.test(text)) return false;
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

const userMemoryModelQueue = new Map<string, Promise<boolean>>();
const userMemoryQueueDepth = new Map<string, number>();
const userMemoryMutationGeneration = new Map<string, number>();

function invalidatePendingUserMemoryExtraction(peerKey: string): void {
  userMemoryMutationGeneration.set(peerKey, (userMemoryMutationGeneration.get(peerKey) ?? 0) + 1);
}

async function recordAsukaLongTermMemoryFromUserMessageWithModelOnce(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now(),
  expectedGeneration = 0,
): Promise<boolean> {
  if (context.peerKind !== "direct") return false;
  const peerKey = makePeerKey(context);
  if ((userMemoryMutationGeneration.get(peerKey) ?? 0) !== expectedGeneration) return false;
  const text = sanitizeMemoryText(userText);
  if (shouldSkipMemory(text) || LOW_INFORMATION_MEMORY_REPLY_RE.test(text)) return false;
  const state = loadState();
  maintainPeerMemories(state, peerKey, at);
  const existing = getActivePeerMemories(state, peerKey, at)
    .filter((item) => item.source === "user_explicit" || item.source === "user_inferred");
  const verdicts = await requestUserMemoryVerdicts(context, text, existing);
  if ((userMemoryMutationGeneration.get(peerKey) ?? 0) !== expectedGeneration) return false;
  if (verdicts) return applyUserMemoryVerdicts(context, verdicts, at);
  if (!isExplicitMemoryRequest(text)) return false;
  return recordAsukaLongTermMemoryFromUserMessage(context, text, at);
}

export async function recordAsukaLongTermMemoryFromUserMessageWithModel(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now(),
): Promise<boolean> {
  const peerKey = makePeerKey(context);
  const depth = userMemoryQueueDepth.get(peerKey) ?? 0;
  const explicit = isExplicitMemoryRequest(sanitizeMemoryText(userText));
  if (depth >= (explicit ? 6 : 3)) return false;
  userMemoryQueueDepth.set(peerKey, depth + 1);
  const generation = userMemoryMutationGeneration.get(peerKey) ?? 0;
  const previous = userMemoryModelQueue.get(peerKey) ?? Promise.resolve(false);
  const queued = previous
    .catch(() => false)
    .then(() => recordAsukaLongTermMemoryFromUserMessageWithModelOnce(context, userText, at, generation));
  userMemoryModelQueue.set(peerKey, queued);
  try {
    return await queued;
  } finally {
    if (userMemoryModelQueue.get(peerKey) === queued) userMemoryModelQueue.delete(peerKey);
    const remaining = (userMemoryQueueDepth.get(peerKey) ?? 1) - 1;
    if (remaining > 0) userMemoryQueueDepth.set(peerKey, remaining);
    else userMemoryQueueDepth.delete(peerKey);
  }
}

function getActiveSelfSignalsForPeer(state: AsukaMemoryStateFile, peerKey: string, now: number): AsukaMemoryItem[] {
  return getActivePeerMemories(state, peerKey, now)
    .filter((item) => item.type === "asuka_self_signal")
    .sort((a, b) => scoreMemory(b, new Set(), now) - scoreMemory(a, new Set(), now));
}

function applySelfSignalVerdict(
  context: AsukaPeerContext,
  text: string,
  classified: NonNullable<ReturnType<typeof classifyAssistantMemory>>,
  verdict: AsukaSelfSignalVerdict,
  at: number,
): boolean {
  if (verdict.action === "ignore") return false;
  const canonicalText = sanitizeSelfSignalCanonicalText(verdict.canonicalText || text);
  if (!canonicalText) return false;

  const state = loadState();
  const peerKey = makePeerKey(context);
  const activeSelfSignals = getActiveSelfSignalsForPeer(state, peerKey, at);
  const targets = activeSelfSignals.filter((item) => verdict.targetMemoryIds.includes(item.id));

  if ((verdict.action === "update" || verdict.action === "replace") && targets.length === 0) {
    return false;
  }

  if (verdict.action === "update" && targets.length > 0) {
    const target = targets[0]!;
    target.text = canonicalText;
    target.updatedAt = at;
    target.salience = Math.max(target.salience, 8);
    target.confidence = Math.max(target.confidence, verdict.confidence, classified.confidence);
    target.expiresAt = at + SELF_SIGNAL_TTL_MS;
    target.continuityKind = verdict.continuityKind;
    target.personalityCategory = verdict.personalityCategory;
    target.key = target.key ?? `asuka:${verdict.personalityCategory}:${target.id}`;
    target.status = "active";
    maintainPeerMemories(state, peerKey, at);
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
    type: "asuka_self_signal",
    text: canonicalText,
    source: "assistant_self_signal",
    sourceMessageId: context.messageId,
    createdAt: at,
    updatedAt: at,
    salience: Math.max(classified.salience, 8),
    confidence: Math.max(classified.confidence, verdict.confidence),
    expiresAt: at + SELF_SIGNAL_TTL_MS,
    continuityKind: verdict.continuityKind,
    personalityCategory: verdict.personalityCategory,
    privacy: "direct_only",
    key: `asuka:${verdict.personalityCategory}:${id}`,
    status: "active",
  };

  if (verdict.action === "replace") {
    for (const target of targets) {
      supersedeMemory(target, id, at);
    }
  }

  maintainPeerMemories(state, peerKey, at);
  saveState();
  return true;
}

export async function recordAsukaLongTermMemoryFromAssistantReply(
  context: AsukaPeerContext,
  assistantText: string,
  at = Date.now(),
): Promise<boolean> {
  const text = sanitizeMemoryText(assistantText);
  if (shouldSkipMemory(text)) return false;
  if (context.peerKind !== "direct") return false;
  const selfThreadClassified = classifyAssistantMemory(text, at);
  if (selfThreadClassified?.type === "asuka_self_thread") {
    return upsertMemory(context, {
      ...selfThreadClassified,
      text,
      at,
    });
  }
  const state = loadState();
  const peerKey = makePeerKey(context);
  maintainPeerMemories(state, peerKey, at);
  const existing = getActiveSelfSignalsForPeer(state, peerKey, at);
  const verdict = await requestSelfSignalVerdict(context, text, existing);
  if (!verdict) return false;
  const classified = classifyAssistantMemory(text, at) ?? {
    type: "asuka_self_signal" as const,
    source: "assistant_self_signal" as const,
    salience: 7,
    confidence: 0.64,
    expiresAt: at + SELF_SIGNAL_TTL_MS,
    continuityKind: verdict.continuityKind,
    personalityCategory: verdict.personalityCategory,
  };
  return applySelfSignalVerdict(context, text, classified, verdict, at);
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

function formatSelfSignalCandidatesForJudge(items: AsukaMemoryItem[]): string {
  if (items.length === 0) return "none";
  return items
    .slice(0, 12)
    .map((item) => `- id=${item.id} category=${item.personalityCategory ?? deriveSelfSignalCategory(item.text) ?? "unknown"} kind=${item.continuityKind ?? deriveContinuityKind(item.text)} text=${normalizePromptPerspective(item.text)}`)
    .join("\n");
}

function buildSelfSignalJudgePrompt(text: string, existing: AsukaMemoryItem[]): string {
  return [
    "你是 Asuka 长期人格记忆裁决器，只能输出一个 JSON 对象，不要解释。",
    "任务: 判断这句 Asuka 自己说过的话是否体现稳定人格、相处气质、边界或长期偏好。",
    "不要记录一次性情绪、当前场景台词、承诺具体事项、工具/接口/payload、用户画像或临时玩笑。",
    "固定 personalityCategory 只能选: attachment_style, care_style, communication_style, commitment_style, temperament, boundaries, vulnerabilities, aesthetic_taste。",
    "continuityKind 只能选: preference, boundary, emotional_continuity。",
    "action 语义: add=同类新侧面; update=和某条旧记忆同一侧面，改写旧记忆; replace=和旧记忆冲突，覆盖旧记忆; ignore=不值得沉淀。",
    "如果 action 是 update 或 replace，targetMemoryIds 必须包含要处理的旧记忆 id。",
    "canonicalText 要写成第一人称自然人格记忆句，避免标签化，不超过 80 字。",
    "输出格式: {\"action\":\"add|update|replace|ignore\",\"continuityKind\":\"preference|boundary|emotional_continuity\",\"personalityCategory\":\"...\",\"canonicalText\":\"...\",\"confidence\":0.0,\"targetMemoryIds\":[\"...\"],\"reason\":\"...\"}",
    `候选文本: ${normalizePromptPerspective(text)}`,
    `已有 Asuka 人格记忆:\n${formatSelfSignalCandidatesForJudge(existing)}`,
  ].join("\n");
}

function buildRuleFallbackSelfSignalVerdict(text: string): AsukaSelfSignalVerdict | null {
  if (!ASUKA_SELF_SIGNAL_RE.test(text) || !ASUKA_SELF_SIGNAL_STABLE_RE.test(text)) return null;
  const category = deriveSelfSignalCategory(text);
  if (!category) return null;
  const continuityKind = deriveContinuityKind(text);
  return {
    action: "add",
    continuityKind,
    personalityCategory: category,
    canonicalText: text,
    confidence: 0.62,
    targetMemoryIds: [],
    reason: "strict rule fallback accepted stable self signal",
    source: "rule_fallback",
  };
}

async function requestSelfSignalVerdict(
  context: AsukaPeerContext,
  text: string,
  existing: AsukaMemoryItem[],
): Promise<AsukaSelfSignalVerdict | null> {
  const mock = process.env.ASUKA_SELF_SIGNAL_TEST_VERDICT?.trim();
  if (mock) {
    return parseSelfSignalVerdict(mock, "mock") ?? {
      action: "ignore",
      continuityKind: "emotional_continuity",
      personalityCategory: "communication_style",
      canonicalText: "",
      confidence: 0,
      targetMemoryIds: [],
      reason: "invalid mock self signal verdict",
      source: "invalid",
    };
  }

  const resolved = resolveQQBotSceneInferenceConfig(context.accountId);
  const models = [
    { config: resolved.primary, source: "model" as const },
    { config: resolved.fallback, source: "fallback_model" as const },
  ].filter((item): item is { config: OpenAICompletionsModelConfig; source: "model" | "fallback_model" } => Boolean(item.config));
  if (models.length === 0) return buildRuleFallbackSelfSignalVerdict(text);

  const prompt = buildSelfSignalJudgePrompt(text, existing);
  for (const model of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SELF_SIGNAL_MODEL_TIMEOUT_MS);
    try {
      const response = await fetch(`${model.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${model.config.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: model.config.model,
          ...getOpenAICompletionsThinkingParams(model.config.model, "off"),
          temperature: 0.1,
          max_tokens: 260,
          messages: [
            {
              role: "system",
              content: "你只负责判断 Asuka 自己的长期人格记忆，必须只输出 JSON 对象。",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });
      const detail = await response.text();
      if (!response.ok) continue;
      const parsed = parseSelfSignalVerdict(extractTextFromCompletionPayload(JSON.parse(detail)), model.source);
      if (parsed) return parsed;
    } catch {
      // Try fallback model below.
    } finally {
      clearTimeout(timeout);
    }
  }

  return buildRuleFallbackSelfSignalVerdict(text);
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

function getSelfSignalCategory(item: AsukaMemoryItem): AsukaSelfSignalCategory | null {
  return item.personalityCategory ?? deriveSelfSignalCategory(item.text) ?? deriveSelfSignalCategoryFromKey(item.key);
}

function formatSelfSignalCategoryLabel(category: AsukaSelfSignalCategory | null): string {
  switch (category) {
    case "attachment_style": return "亲近方式";
    case "care_style": return "关心方式";
    case "communication_style": return "说话气质";
    case "commitment_style": return "认真感";
    case "temperament": return "性情底色";
    case "boundaries": return "自我边界";
    case "vulnerabilities": return "脆弱点";
    case "aesthetic_taste": return "审美倾向";
    default: return "长期性格";
  }
}

function formatSelfSignalMemoryGroup(title: string, items: AsukaMemoryItem[], limit: number): string[] {
  const selected = items.slice(0, limit);
  if (selected.length === 0) return [];
  return [
    `${title}:`,
    ...selected.map((item) => `- ${formatSelfSignalCategoryLabel(getSelfSignalCategory(item))}: ${normalizePromptPerspective(item.text)}${formatMemoryFlags(item)}`),
  ];
}

function formatMemoryFlags(item: AsukaMemoryItem): string {
  const flags: string[] = [];
  if (item.importance === "important") flags.push("重要");
  if (item.temporary) flags.push("临时");
  return flags.length > 0 ? `（${flags.join("，")}）` : "";
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

function formatMemoryGroup(title: string, items: AsukaMemoryItem[], limit: number): string[] {
  const selected = items.slice(0, limit);
  if (selected.length === 0) return [];
  return [
    `${title}:`,
    ...selected.map((item) => `- ${normalizePromptPerspective(item.text)}${formatMemoryFlags(item)}`),
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
  const active = sorted.filter((item) => item.type === "active_thread" || item.type === "asuka_self_thread");
  const personality = sorted.filter((item) => item.type === "asuka_self_signal");
  const lines = [
    "我现在记得这些：",
    ...formatMemoryGroup("关于你", profile, 4),
    ...formatMemoryGroup("偏好和边界", preferences, 4),
    ...formatMemoryGroup("我们聊过的事", relationship, 3),
    ...formatMemoryGroup("最近还没收尾的话题", active, 3),
    ...formatMemoryGroup("我的长期性格和相处方式", personality, 4),
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
    item.status = "forgotten";
    item.forgottenAt = now;
    item.updatedAt = now;
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
  if (intent.action !== "list") invalidatePendingUserMemoryExtraction(peerKey);
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
      item.status = "forgotten";
      item.forgottenAt = at;
      item.updatedAt = at;
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
  if (isAsukaMemoryWikiPrimary()) return "";
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
  const selfThreads = memories.filter((item) => item.type === "asuka_self_thread");
  const selfSignals = memories.filter((item) => item.type === "asuka_self_signal" && getSelfSignalCategory(item));
  const lines = [
    "【Asuka 长期记忆】",
    "- 这些记忆只用于当前私聊；不要在群聊或其他人面前透露。",
    "- 使用原则: 只在和本轮自然相关时轻轻带上，不要像背档案，也不要逐条复述。",
    "- 自我生活线只作为轻量连续性线索；不要把它扩写成完整履历、固定日程或无关新设定。",
    "- 长期性格只用于语气、选择和关系连续性；不要把它当成固定人设强行表演。",
    "- 如果本轮涉及承诺/补救/用户明确请求，以承诺/补救/请求优先，自我生活线和长期性格只能辅助。",
    ...formatMemoryGroup("关于你", userFacts, 5),
    ...formatMemoryGroup("关系里的事", relationship, 3),
    ...formatMemoryGroup("未完话题", active, 2),
    ...formatMemoryGroup("我的最近生活线", selfThreads, 2),
    ...formatSelfSignalMemoryGroup("我的长期性格和相处方式", selfSignals, 5),
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
    "- 主动触达时可以自然承接多条相关记忆，像真的记得彼此近况一样组织语气；不要说你查看了记忆。",
    "- ambient/self_thread 主动触达应更积极延续最近自我生活线，让时间、动作、地点或情绪自然往前走；如果存在承诺/补救内容，承诺/补救优先。",
  ].join("\n");
}
