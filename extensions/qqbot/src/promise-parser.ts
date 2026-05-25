import {
  getOpenAICompletionsThinkingParams,
  resolveQQBotPromiseInferenceConfig,
  type OpenAICompletionsModelConfig,
} from "./config.js";

export type PromiseTriggerKind = "hard" | "soft";

export interface ParsedPromiseScheduleAt {
  kind: "at";
  atIso: string;
  humanLabel: string;
}

export interface ParsedPromiseScheduleCron {
  kind: "cron";
  cronExpr: string;
  tz: string;
  humanLabel: string;
}

export type ParsedPromiseSchedule = ParsedPromiseScheduleAt | ParsedPromiseScheduleCron;

export interface ParsedPromise {
  triggerKind: PromiseTriggerKind;
  triggerPhrase: string;
  promiseText: string;
  normalizedText: string;
  relationNote: string;
  deliveryKind?: "text" | "selfie";
  schedule?: ParsedPromiseSchedule;
  followUpIntent: string;
}

interface PromiseParseOptions {
  now?: Date;
  timeZone?: string;
  userText?: string;
  accountId?: string | null;
  modelConfig?: OpenAICompletionsModelConfig | null;
  fetchImpl?: typeof fetch;
  log?: { warn?: (message: string) => void; info?: (message: string) => void };
  timeoutMs?: number;
}

const PROMISE_INFERENCE_TIMEOUT_MS = 5_000;
const HARD_TRIGGERS = ["拉钩", "约定", "约好了", "发誓"] as const;
const SOFT_TRIGGER_PATTERNS: Array<{ phrase: string; regex: RegExp }> = [
  { phrase: "我会记得", regex: /我会记得/ },
  { phrase: "明天我来找你", regex: /明天.*我来找你|我明天来找你/ },
  { phrase: "等我一下", regex: /等我一下|等我一会|等等我/ },
  { phrase: "回头继续", regex: /回头继续|晚点继续|下次继续|之后继续/ },
  { phrase: "我来找你", regex: /(?:明天|今晚|今夜|稍后|待会|一会|晚点|回头|之后|下次).*(?:我来找你|我去找你|我再来找你)|(?:我来找你|我去找你|我再来找你).*(?:明天|今晚|今夜|稍后|待会|一会|晚点|回头|之后|下次)/ },
  { phrase: "我会给你发早安", regex: /我会.*给你发.*早安|给你发.*早安/ },
  { phrase: "我会给你发晚安", regex: /我会.*给你发.*晚安|给你发.*晚安/ },
  { phrase: "我会给你发消息", regex: /我会.*给你发.*消息|主动给你发消息/ },
  { phrase: "我会给你发自拍", regex: /我会.*给你发.*自拍|给你发.*自拍/ },
  { phrase: "我会叫你起床", regex: /我会.*(?:叫你|喊你|叫醒你|喊醒你).*(?:起床|起来|醒)|(?:明天|明早|明天早上|明天早晨).*(?:叫你|喊你|叫醒你|喊醒你).*(?:起床|起来|醒)/ },
  { phrase: "我会准时", regex: /我.*会.*准时|你会收到/ },
];

function stripPayloadArtifacts(text: string): string {
  return text
    .replace(/Q{1,2}BOT_(?:PAYLOAD|CRON):[\s\S]*$/gi, "")
    .replace(/<qq(?:img|voice|video|file)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimModelField(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = stripPayloadArtifacts(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > limit ? cleaned.slice(0, limit).trimEnd() : cleaned;
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/[\n。！？!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const char = raw[index];
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
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function extractTextFromCompletionPayload(raw: any): string {
  const messageContent = raw?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") return messageContent.trim();
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function isStandaloneTriggerSentence(sentence: string): boolean {
  return /^(?:嗯|嗯嗯|好|好呀|好的|行|那就)?[，,\s~～]*?(?:拉钩|约定|约好了|发誓)[！!～~]*$/.test(sentence.trim());
}

function inferContextHint(texts: Array<string | undefined>): "selfie" | "photo" | "message" | "greeting" | "chat" | undefined {
  const merged = texts.filter(Boolean).join(" ");
  if (!merged) return undefined;
  if (/(自拍|照片|图片|发一张|再发一张|发张图|发一张图|本人照片)/.test(merged)) return "selfie";
  if (/(早安|早上好|晚安)/.test(merged)) return "greeting";
  if (/(消息|发消息|联系你|联系我)/.test(merged)) return "message";
  if (/(聊天|说话|聊聊|继续聊|接着聊)/.test(merged)) return "chat";
  if (/(发图|图片|照片)/.test(merged)) return "photo";
  return undefined;
}

function enrichSentenceWithContext(sentence: string, contextHint?: string): string {
  let enriched = sentence;
  if (contextHint === "selfie" && /(发一张|再给你发一张|再发一张|发给你一张|发给你|再给你发|发一张给你)/.test(enriched) && !/(自拍|照片|图片)/.test(enriched)) {
    enriched = `${enriched} 自拍`;
  }
  if ((contextHint === "greeting" || contextHint === "message") && /发给你|给你发/.test(enriched) && !/(早安|晚安|消息)/.test(enriched)) {
    enriched = `${enriched} ${contextHint === "greeting" ? "早安" : "消息"}`;
  }
  if (contextHint === "chat" && /(来找你|找你|继续|接上|说话)/.test(enriched) && !/(聊天|说话|继续聊|接着聊)/.test(enriched)) {
    enriched = `${enriched} 说话`;
  }
  return enriched;
}

function hasActionIntent(sentence: string, contextHint?: string): boolean {
  const enriched = enrichSentenceWithContext(sentence, contextHint);
  if (/(给你发.*(早安|晚安|消息|自拍|照片|图片)|发.*(早安|晚安|消息|自拍|照片|图片).*给你|来找你|找你说话|陪着你|继续聊|接着聊|续上|接上|叫你起床|喊你起床|叫醒你|喊醒你|喊你醒|叫你起来|喊你起来)/.test(enriched)) {
    return true;
  }
  if (/(发一张|再发一张|再给你发一张|发给你一张|十分钟后发给你|准时发给你|再给你发|发给你)/.test(sentence)) {
    return true;
  }
  if (contextHint === "selfie" && /(发一张|再发一张|再给你发一张|发给你一张|十分钟后发给你)/.test(sentence)) {
    return true;
  }
  return false;
}

function clampMinute(value: number): number {
  return Math.max(0, Math.min(59, value));
}

function parseChineseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (raw === "十") return 10;
  if (raw.startsWith("十")) {
    const ones = digits[raw.slice(1)] ?? 0;
    return 10 + ones;
  }
  if (raw.includes("十")) {
    const [tensRaw, onesRaw] = raw.split("十");
    const tens = digits[tensRaw] ?? 0;
    const ones = onesRaw ? (digits[onesRaw] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return digits[raw] ?? null;
}

function buildAtSchedule(target: Date, humanLabel: string): ParsedPromiseScheduleAt {
  return {
    kind: "at",
    atIso: target.toISOString(),
    humanLabel,
  };
}

function buildCronSchedule(hour: number, minute: number, tz: string, humanLabel: string): ParsedPromiseScheduleCron {
  return {
    kind: "cron",
    cronExpr: `${clampMinute(minute)} ${Math.max(0, Math.min(23, hour))} * * *`,
    tz,
    humanLabel,
  };
}

function parseExplicitTime(text: string): { hour: number; minute: number } | null {
  const match = text.match(/([0-2]?\d|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十|二十一|二十二|二十三|一|二|三|四|五|六|七|八|九)\s*点(?:\s*([0-5]?\d|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十|二十一|二十二|二十三|二十四|二十五|二十六|二十七|二十八|二十九|三十|三十一|三十二|三十三|三十四|三十五|三十六|三十七|三十八|三十九|四十|四十一|四十二|四十三|四十四|四十五|四十六|四十七|四十八|四十九|五十|五十一|五十二|五十三|五十四|五十五|五十六|五十七|五十八|五十九)\s*分?)?/);
  if (!match) return null;
  const hour = parseChineseNumber(match[1]);
  const minute = match[2] ? parseChineseNumber(match[2]) : 0;
  if (hour === null || minute === null) return null;
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return null;
  if (Number.isNaN(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatHumanLabel(date: Date, prefix: string): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${prefix} ${hh}:${mm}`;
}

function buildNextDayDate(now: Date, hour: number, minute: number): Date {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(hour, minute, 0, 0);
  return target;
}

function buildTodayDate(now: Date, hour: number, minute: number): Date {
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function resolveTimeZone(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return local || process.env.TZ || "Asia/Shanghai";
}

function isTentativeSentence(sentence: string): boolean {
  return /(要不要|想不想|可以吗|能不能|是不是|如果你想|要是你想)/.test(sentence);
}

function isActionableUnscheduledSoftPromise(sentence: string, contextHint?: string): boolean {
  const enriched = enrichSentenceWithContext(sentence, contextHint);
  return /(给你发.*(早安|晚安|消息|自拍|照片|图片)|发.*(早安|晚安|消息|自拍|照片|图片).*给你|等我一下|等我一会|等等我|待会|一会|一会儿|等会|稍后|晚点|回头|明天|今晚|今天晚上|今夜|夜里|每天|之后|下次|分钟后|小时后|马上|立刻|这就|现在就)/.test(enriched);
}

function deriveSchedule(sentence: string, now: Date, timeZone?: string): ParsedPromiseSchedule | undefined {
  const explicitTime = parseExplicitTime(sentence);
  const tz = resolveTimeZone(timeZone);

  if (/每天/.test(sentence) && /(晚上|晚安|夜里|睡觉)/.test(sentence)) {
    const hour = explicitTime?.hour ?? 22;
    const minute = explicitTime?.minute ?? 0;
    return buildCronSchedule(hour, minute, tz, `每天 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  if (/每天/.test(sentence) && /(早上|早晨|早安)/.test(sentence)) {
    const hour = explicitTime?.hour ?? 9;
    const minute = explicitTime?.minute ?? 0;
    return buildCronSchedule(hour, minute, tz, `每天 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  if (/每天/.test(sentence) && explicitTime) {
    const hour = explicitTime.hour;
    const minute = explicitTime.minute;
    return buildCronSchedule(hour, minute, tz, `每天 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }

  const durationMatch = sentence.match(/(?:过|再过)?\s*(\d+|一|二|两|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十|二十一|二十二|二十三|二十四|二十五|二十六|二十七|二十八|二十九|三十)\s*(分钟|小时)后?|(?:过|再过)(\d+|一|二|两|三|四|五|六|七|八|九|十|十一|十二|十三|十四|十五|十六|十七|十八|十九|二十|二十一|二十二|二十三|二十四|二十五|二十六|二十七|二十八|二十九|三十)\s*(分钟|小时)/);
  if (durationMatch) {
    const amount = parseChineseNumber(durationMatch[1] ?? durationMatch[3]);
    const unit = durationMatch[2] ?? durationMatch[4];
    if (amount === null) return undefined;
    const target = new Date(now);
    target.setMilliseconds(0);
    if (unit === "分钟") {
      target.setMinutes(target.getMinutes() + amount);
    } else {
      target.setHours(target.getHours() + amount);
    }
    return buildAtSchedule(target, `${amount}${unit}后`);
  }

  if (/明早|明天早上|明天早晨|明天上午/.test(sentence)) {
    const target = buildNextDayDate(now, explicitTime?.hour ?? 9, explicitTime?.minute ?? 0);
    return buildAtSchedule(target, formatHumanLabel(target, "明天"));
  }

  if (/明晚|明天晚上|明天夜里|明天夜晚/.test(sentence)) {
    const target = buildNextDayDate(now, explicitTime?.hour ?? 21, explicitTime?.minute ?? 0);
    return buildAtSchedule(target, formatHumanLabel(target, "明天"));
  }

  if (/明天/.test(sentence)) {
    const target = buildNextDayDate(now, explicitTime?.hour ?? 10, explicitTime?.minute ?? 0);
    return buildAtSchedule(target, formatHumanLabel(target, "明天"));
  }

  if (/今晚|今天晚上|今夜|夜里/.test(sentence)) {
    const target = buildTodayDate(now, explicitTime?.hour ?? 21, explicitTime?.minute ?? 0);
    return buildAtSchedule(target, formatHumanLabel(target, "今晚"));
  }

  if (/午饭时间|中午/.test(sentence)) {
    const target = buildTodayDate(now, explicitTime?.hour ?? 12, explicitTime?.minute ?? 30);
    return buildAtSchedule(target, formatHumanLabel(target, "中午"));
  }

  if (/待会|一会|一会儿|等会|稍后/.test(sentence)) {
    const target = new Date(now);
    target.setHours(target.getHours() + 1, target.getMinutes(), 0, 0);
    return buildAtSchedule(target, "1小时后");
  }

  if (/晚点|回头/.test(sentence)) {
    const target = new Date(now);
    target.setHours(target.getHours() + 2, target.getMinutes(), 0, 0);
    return buildAtSchedule(target, "2小时后");
  }

  if (/等我一下|等我一会|等等我/.test(sentence)) {
    const target = new Date(now);
    target.setMinutes(target.getMinutes() + 5, 0, 0);
    return buildAtSchedule(target, "5分钟后");
  }

  if (/马上|立刻|这就|现在就/.test(sentence)) {
    const target = new Date(now);
    target.setMinutes(target.getMinutes() + 3, 0, 0);
    return buildAtSchedule(target, "3分钟后");
  }

  return undefined;
}

function deriveFollowUpIntent(sentence: string, contextHint?: string): string {
  const enriched = enrichSentenceWithContext(sentence, contextHint);
  if (/(叫你起床|喊你起床|叫醒你|喊醒你|喊你醒|叫你起来|喊你起来)/.test(enriched)) {
    return "主动按约定叫对方起床，语气轻一点，不要像闹钟。";
  }
  if (/早安|早上好/.test(enriched)) {
    return "主动来道早安，并自然让对方感到你记得之前的约定。";
  }
  if (/晚安/.test(enriched)) {
    return "主动来道晚安，语气温柔一点，让对方感觉你没有忘记。";
  }
  if (/自拍|照片|图片/.test(enriched)) {
    return "主动把答应过的自拍或照片发给对方，不要像临时忘掉了一样。";
  }
  if (/继续聊|接着聊|续上|接上/.test(enriched)) {
    return "主动把你们上次没聊完的话题接上，不要像刚认识一样重新开始。";
  }
  if (/找你|陪你|想你/.test(enriched)) {
    return "主动来找对方，不是为了任务，而是因为你自己惦记着这段关系。";
  }
  return "主动兑现你之前亲口答应过的事，像真人一样自然开口。";
}

function deriveDeliveryKind(sentence: string, contextHint?: string): "text" | "selfie" {
  const enriched = enrichSentenceWithContext(sentence, contextHint);
  if (/(自拍|照片|图片|发一张|再发一张|发给你一张|发张图)/.test(enriched)) {
    return "selfie";
  }
  if (contextHint === "selfie" && /(发给你|给你发|准时发给你|来一张)/.test(enriched)) {
    return "selfie";
  }
  return "text";
}

function inferImplicitSoftPromise(sentence: string, contextHint?: string): { phrase: string } | null {
  const hasCommitmentTone = /(我会|我一定会|我会准时|你会收到|从明天开始|以后每一天|以后每天|我就立刻|我都会|那我|我这就|我过十分钟)/.test(sentence);
  const hasFutureCue = /(明天|今晚|今天晚上|今夜|每天|以后|之后|下次|早上|晚上|午饭时间|十分钟|分钟后|小时后|7点|8点|9点|10点|11点|12点|点)/.test(sentence);
  const hasAction = hasActionIntent(sentence, contextHint);
  const isTentative = /(要不要|想不想|可以|能不能|是不是|如果你想)/.test(sentence) && !hasCommitmentTone;

  if (isTentative) return null;
  if (hasCommitmentTone && hasAction) {
    return { phrase: "未来动作承诺" };
  }
  if (hasFutureCue && hasAction && /(一定|准时|会|都会)/.test(sentence)) {
    return { phrase: "未来动作承诺" };
  }
  return null;
}

function buildRelationNote(sentence: string, triggerKind: PromiseTriggerKind, contextHint?: string): string {
  const enriched = enrichSentenceWithContext(sentence, contextHint);
  if (triggerKind === "hard") {
    return "这是你亲口说过要算数的承诺，后续必须延续。";
  }
  if (/给你发.*(早安|晚安|消息|自拍|照片|图片)|发.*(早安|晚安|消息|自拍|照片|图片).*给你/.test(enriched)) {
    return "这是一次明确的未来联系承诺，需要按说好的时间主动出现。";
  }
  if (/(发一张|再发一张|再给你发一张|发给你一张|准时发给你|发给你)/.test(sentence)) {
    return "这是一次明确的未来发送承诺，需要在说好的时间兑现。";
  }
  if (/继续聊|接着聊|续上/.test(enriched)) {
    return "这是一次未完话题的延续承诺。";
  }
  return "这是一次轻度承诺，最好在后续自然接上。";
}

function resolvePromiseInferenceModels(options?: PromiseParseOptions): OpenAICompletionsModelConfig[] {
  if (Object.prototype.hasOwnProperty.call(options ?? {}, "modelConfig")) {
    return options?.modelConfig ? [options.modelConfig] : [];
  }
  const resolved = resolveQQBotPromiseInferenceConfig(options?.accountId);
  if (!resolved.enabled) return [];
  const models = [resolved.primary, resolved.fallback].filter((item): item is OpenAICompletionsModelConfig => Boolean(item));
  const seen = new Set<string>();
  return models.filter((item) => {
    const key = `${item.baseUrl}\n${item.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPromiseInferencePrompt(replyText: string, userText: string | undefined, now: Date, timeZone?: string): string {
  return [
    "你是 Asuka 的承诺判断器，只能输出一个 JSON 对象，不要解释。",
    "任务: 判断 Asuka 这次回复里是否亲自承诺了未来要对用户做某件可兑现的事。",
    "承诺必须满足: 说话者是 Asuka/我；动作发生在未来；用户能合理期待她之后主动兑现。",
    "不要把安慰、态度、愿望、提议、询问、条件句、角色设定、已经完成的动作、只是复述用户的话当承诺。",
    "可以借助用户上一句补全省略对象，例如用户在要自拍，Asuka 说“晚点发给你”，可以理解为发自拍。",
    "如果只是“如果你想/可以吗/要不要/我可以”这类未确认提议，输出空数组。",
    "triggerKind: 出现拉钩/约定/约好了/发誓等强约束时为 hard，否则为 soft。",
    "deliveryKind: 承诺发自拍、照片、图片时为 selfie，否则为 text。",
    "promiseText 要是简短中文句子，保留时间和动作；可以补全明确省略的对象，但不要编造新时间或新动作。",
    "输出格式: {\"promises\":[{\"promiseText\":\"一会儿我来陪你继续聊。\",\"triggerKind\":\"soft\",\"triggerPhrase\":\"LLM语义判断\",\"deliveryKind\":\"text\",\"followUpIntent\":\"主动回来陪对方把话接上。\",\"relationNote\":\"这是一次明确的未来联系承诺。\",\"confidence\":0.86}]}",
    "最多输出 3 条，按最需要兑现的顺序排列。",
    `当前时间: ${now.toISOString()}`,
    `时区: ${resolveTimeZone(timeZone)}`,
    userText?.trim() ? `用户上一句:\n${stripPayloadArtifacts(userText).slice(0, 800)}` : "用户上一句: none",
    `Asuka 回复:\n${stripPayloadArtifacts(replyText).slice(0, 1600)}`,
  ].join("\n");
}

function parseLlmPromiseOutput(rawText: string, options?: PromiseParseOptions): ParsedPromise[] | null {
  const jsonText = extractFirstJsonObject(rawText) ?? rawText.trim();
  if (!jsonText) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const items = Array.isArray(parsed?.promises) ? parsed.promises : [];
  const now = options?.now ?? new Date();
  const contextHint = inferContextHint([options?.userText, items.map((item: any) => item?.promiseText).join(" ")]);
  const seen = new Set<string>();
  const results: ParsedPromise[] = [];

  for (const item of items) {
    const confidence = typeof item?.confidence === "number" ? item.confidence : undefined;
    if (confidence !== undefined && confidence < 0.55) continue;
    const promiseText = trimModelField(item?.promiseText, 180);
    if (!promiseText) continue;
    const normalizedText = promiseText.replace(/\s+/g, " ").trim();
    if (!normalizedText || seen.has(normalizedText)) continue;

    const triggerKind: PromiseTriggerKind = item?.triggerKind === "hard" ? "hard" : "soft";
    const triggerPhrase = trimModelField(item?.triggerPhrase, 40) ?? "LLM语义判断";
    const detectionText = enrichSentenceWithContext(promiseText, contextHint);
    const deliveryKind = item?.deliveryKind === "selfie" || item?.deliveryKind === "text"
      ? item.deliveryKind
      : deriveDeliveryKind(detectionText, contextHint);
    const relationNote = trimModelField(item?.relationNote, 120) ?? buildRelationNote(detectionText, triggerKind, contextHint);
    const followUpIntent = trimModelField(item?.followUpIntent, 160) ?? deriveFollowUpIntent(detectionText, contextHint);

    seen.add(normalizedText);
    results.push({
      triggerKind,
      triggerPhrase,
      promiseText,
      normalizedText,
      relationNote,
      deliveryKind,
      schedule: deriveSchedule(detectionText, now, options?.timeZone),
      followUpIntent,
    });
    if (results.length >= 3) break;
  }

  return results;
}

async function requestPromiseInference(
  replyText: string,
  modelConfig: OpenAICompletionsModelConfig,
  options?: PromiseParseOptions,
): Promise<ParsedPromise[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? PROMISE_INFERENCE_TIMEOUT_MS);
  try {
    const fetchImpl = options?.fetchImpl ?? fetch;
    const now = options?.now ?? new Date();
    const response = await fetchImpl(`${modelConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelConfig.model,
        ...getOpenAICompletionsThinkingParams(modelConfig.model, "off"),
        temperature: 0.1,
        max_tokens: 420,
        messages: [
          {
            role: "system",
            content: "你只负责判断 Asuka 回复中的未来承诺，必须只输出 JSON 对象。",
          },
          {
            role: "user",
            content: buildPromiseInferencePrompt(replyText, options?.userText, now, options?.timeZone),
          },
        ],
      }),
    });
    const detail = await response.text();
    if (!response.ok) {
      options?.log?.warn?.(`[asuka-promise] LLM promise inference failed: HTTP ${response.status}`);
      return null;
    }
    return parseLlmPromiseOutput(extractTextFromCompletionPayload(JSON.parse(detail)), options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options?.log?.warn?.(`[asuka-promise] LLM promise inference unavailable: ${message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseAssistantPromisesWithLlm(replyText: string, options?: PromiseParseOptions): Promise<ParsedPromise[]> {
  const cleaned = stripPayloadArtifacts(replyText);
  if (!cleaned) return [];

  const models = resolvePromiseInferenceModels(options);
  for (const modelConfig of models) {
    const parsed = await requestPromiseInference(replyText, modelConfig, options);
    if (parsed) return parsed;
  }

  return parseAssistantPromises(replyText, options);
}

export function parseAssistantPromises(replyText: string, options?: PromiseParseOptions): ParsedPromise[] {
  const cleaned = stripPayloadArtifacts(replyText);
  if (!cleaned) return [];

  const now = options?.now ?? new Date();
  const sentences = splitIntoSentences(cleaned);
  const contextHint = inferContextHint([options?.userText, cleaned]);
  const candidates: Array<{ text: string; start: number; end: number; merged: boolean }> = [];
  for (let index = 0; index < sentences.length; index++) {
    candidates.push({ text: sentences[index], start: index, end: index, merged: false });
    if (index + 1 < sentences.length) {
      candidates.push({
        text: `${sentences[index]}，${sentences[index + 1]}`,
        start: index,
        end: index + 1,
        merged: true,
      });
    }
    if (index + 2 < sentences.length && isStandaloneTriggerSentence(sentences[index])) {
      candidates.push({
        text: `${sentences[index]}，${sentences[index + 1]}，${sentences[index + 2]}`,
        start: index,
        end: index + 2,
        merged: true,
      });
    }
  }

  const parsedCandidates: Array<ParsedPromise & { start: number; end: number; score: number }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const sentence = candidate.text.trim();
    const detectionText = enrichSentenceWithContext(sentence, contextHint);
    const hardTrigger = HARD_TRIGGERS.find((phrase) => detectionText.includes(phrase));
    if (!hardTrigger && isTentativeSentence(detectionText)) continue;
    const softTrigger = SOFT_TRIGGER_PATTERNS.find((item) => item.regex.test(detectionText));
    const implicitSoft = !hardTrigger && !softTrigger ? inferImplicitSoftPromise(detectionText, contextHint) : null;
    const triggerKind: PromiseTriggerKind | null = hardTrigger ? "hard" : softTrigger || implicitSoft ? "soft" : null;
    if (!triggerKind) continue;

    const triggerPhrase = hardTrigger ?? softTrigger?.phrase ?? implicitSoft?.phrase ?? "承诺";
    const normalizedText = sentence.replace(/\s+/g, " ").trim();
    if (!normalizedText || seen.has(normalizedText)) continue;
    const schedule = deriveSchedule(detectionText, now, options?.timeZone);
    const actionIntent = hasActionIntent(detectionText, contextHint);
    if (!schedule && !actionIntent && triggerPhrase === "我会记得") {
      continue;
    }
    if (!schedule && triggerKind === "soft" && !isActionableUnscheduledSoftPromise(detectionText, contextHint)) {
      continue;
    }

    const score =
      (triggerKind === "hard" ? 5 : 2) +
      (schedule ? 3 : 0) +
      (actionIntent ? 2 : 0) +
      (candidate.merged ? 1 : 0);

    parsedCandidates.push({
      triggerKind,
      triggerPhrase,
      promiseText: sentence.trim(),
      normalizedText,
      relationNote: buildRelationNote(detectionText, triggerKind, contextHint),
      deliveryKind: deriveDeliveryKind(detectionText, contextHint),
      schedule,
      followUpIntent: deriveFollowUpIntent(detectionText, contextHint),
      start: candidate.start,
      end: candidate.end,
      score,
    });
  }

  parsedCandidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const results: ParsedPromise[] = [];
  const occupied = new Set<number>();
  for (const candidate of parsedCandidates) {
    let overlaps = false;
    for (let index = candidate.start; index <= candidate.end; index++) {
      if (occupied.has(index)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    seen.add(candidate.normalizedText);
    for (let index = candidate.start; index <= candidate.end; index++) {
      occupied.add(index);
    }
    results.push({
      triggerKind: candidate.triggerKind,
      triggerPhrase: candidate.triggerPhrase,
      promiseText: candidate.promiseText,
      normalizedText: candidate.normalizedText,
      relationNote: candidate.relationNote,
      deliveryKind: candidate.deliveryKind,
      schedule: candidate.schedule,
      followUpIntent: candidate.followUpIntent,
    });
    if (results.length >= 3) break;
  }

  return results;
}
