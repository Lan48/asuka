import { getZonedDateParts, normalizePromptHour } from "./time-context.js";

const DAYTIME_NIGHT_SCENE_RE = /(睡了吗|睡了没|睡前|睡觉|睡吧|晚安|今晚|晚上见|关灯|做个好梦|洗完澡|擦头发|准备睡|明天早上叫你|明早叫你)/;
const MORNING_WAKE_SCENE_RE = /(我起床了|刚起床|刚醒|刚睡醒|刚醒没多久|被窝|窝在被子|床上|枕头|早安|早上好|早餐|早饭|醒了[？?]|起床了|……早[。！!，,]?)/;
const STALE_DAYTIME_PROMISE_RE = /(忙完这阵子后?来找你|等我忙完.{0,12}来找你|忙完.{0,12}再来找你)/;
const TIME_AWARE_NEGATION_RE = /(不是|别|不再|不重演|不继续|不要|没必要|不说|不提|不硬拉).{0,16}(刚醒|起床|早安|早上|上午|中午|午后|下午|晚上|夜里|深夜|凌晨|白天|旧场景)/;
const RECENT_MORNING_CONTEXT_RE = /(刚刚|分钟前|小时前|今天|最近|当前|刚才|早安|早上好|刚醒|刚睡醒|刚起床|醒了吗|醒了|起来没|起床|床边|卧室|被窝|窝在被子|枕头|窗帘|还在睡|你还在睡|我还在)/;
const STALE_CONTEXT_TIME_RE = /(昨天|前天|\d+天前|\d+周前|\d+个月前)/;
const EXPLICIT_MORNING_TIME_RE = /(早安|早上好|早上|上午|清晨|一早|早餐|早饭|刚醒|刚起床|刚睡醒|起床了)/;
const EXPLICIT_NOON_TIME_RE = /(中午|午饭|午餐|午休)/;
const EXPLICIT_AFTERNOON_TIME_RE = /(下午|午后)/;
const EXPLICIT_NIGHT_TIME_RE = /(今晚|晚上|傍晚|夜里|深夜|凌晨|天黑|睡前|晚安|关灯|睡吧|做个好梦)/;

export interface TimeContradictionOptions {
  recentContextText?: string;
}

export function getPromptHour(timeZone = "Asia/Shanghai", timestampMs = Date.now()): number {
  return normalizePromptHour(getZonedDateParts(new Date(timestampMs), timeZone).hour);
}

export function isTimeContradictoryDeliveryText(
  text: string,
  timeZone = "Asia/Shanghai",
  timestampMs = Date.now(),
  options: TimeContradictionOptions = {},
): boolean {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (TIME_AWARE_NEGATION_RE.test(normalized)) return false;

  const hour = getPromptHour(timeZone, timestampMs);
  const recentContext = (options.recentContextText || "").replace(/\s+/g, " ").trim();
  const hasRecentMorningContinuity = RECENT_MORNING_CONTEXT_RE.test(recentContext)
    && (!STALE_CONTEXT_TIME_RE.test(recentContext) || /(刚刚|分钟前|小时前|今天|当前|最近|刚才)/.test(recentContext));
  const hasMorningTime = EXPLICIT_MORNING_TIME_RE.test(normalized);
  const hasNoonTime = EXPLICIT_NOON_TIME_RE.test(normalized);
  const hasAfternoonTime = EXPLICIT_AFTERNOON_TIME_RE.test(normalized);
  const hasNightTime = EXPLICIT_NIGHT_TIME_RE.test(normalized);

  if (hour >= 22 || hour < 5) {
    if (hasMorningTime || hasNoonTime || hasAfternoonTime) return true;
    if (MORNING_WAKE_SCENE_RE.test(normalized)) return true;
    if (STALE_DAYTIME_PROMISE_RE.test(normalized)) return true;
  }
  if (hour >= 18 && hour < 22) {
    if (hasMorningTime || hasNoonTime || hasAfternoonTime) return true;
  }
  if (hour >= 8 && hour < 18) {
    if (DAYTIME_NIGHT_SCENE_RE.test(normalized) || hasNightTime) return true;
    if (hour >= 14 && (hasMorningTime || hasNoonTime) && !hasRecentMorningContinuity) return true;
    if (hour >= 10 && MORNING_WAKE_SCENE_RE.test(normalized) && !hasRecentMorningContinuity) return true;
  }
  return false;
}

export function buildTimeAwareDeliveryFallback(
  userText: string,
  options?: { forceImage?: boolean },
): string {
  if (options?.forceImage) {
    return "";
  }
  return "这个点我不重演白天那段了。我在这里，顺着刚才的话继续陪你。";
}
