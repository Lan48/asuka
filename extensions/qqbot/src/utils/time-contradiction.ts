import { getZonedDateParts, normalizePromptHour } from "./time-context.js";

const DAYTIME_NIGHT_SCENE_RE = /(睡了吗|睡了没|睡前|睡觉|睡吧|晚安|今晚|晚上见|关灯|做个好梦|洗完澡|擦头发|准备睡|明天早上叫你|明早叫你)/;
const MORNING_WAKE_SCENE_RE = /(我起床了|刚起床|刚醒|刚睡醒|刚醒没多久|被窝|窝在被子|床上|枕头|早安|早上好|早餐|早饭|醒了[？?]|起床了|……早[。！!，,]?)/;
const STALE_DAYTIME_PROMISE_RE = /(忙完这阵子后?来找你|等我忙完.{0,12}来找你|忙完.{0,12}再来找你)/;
const TIME_AWARE_NEGATION_RE = /(不是|别|不再|不重演|不继续|不要|没必要).{0,12}(刚醒|起床|早安|早上|白天|旧场景)/;

export function getPromptHour(timeZone = "Asia/Shanghai", timestampMs = Date.now()): number {
  return normalizePromptHour(getZonedDateParts(new Date(timestampMs), timeZone).hour);
}

export function isTimeContradictoryDeliveryText(
  text: string,
  timeZone = "Asia/Shanghai",
  timestampMs = Date.now(),
): boolean {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (TIME_AWARE_NEGATION_RE.test(normalized)) return false;

  const hour = getPromptHour(timeZone, timestampMs);
  if (hour >= 8 && hour < 18) {
    if (DAYTIME_NIGHT_SCENE_RE.test(normalized)) return true;
    if (hour >= 10 && MORNING_WAKE_SCENE_RE.test(normalized)) return true;
  }
  if (hour >= 22 || hour < 5) {
    if (MORNING_WAKE_SCENE_RE.test(normalized)) return true;
    if (STALE_DAYTIME_PROMISE_RE.test(normalized)) return true;
  }
  return false;
}

export function buildTimeAwareDeliveryFallback(
  userText: string,
  options?: { forceImage?: boolean },
): string {
  const requestText = (userText || "").replace(/\s+/g, " ").trim();
  if (options?.forceImage) {
    return requestText
      ? "好，我按你刚刚说的画面来。"
      : "好，我按刚刚的语境给你发一张。";
  }
  return "这个点我不重演白天那段了。我在这里，顺着刚才的话继续陪你。";
}
