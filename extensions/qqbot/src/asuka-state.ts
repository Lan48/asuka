import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveQQBotSceneInferenceConfig } from "./config.js";
import { getRecentEntriesForPeer } from "./ref-index-store.js";
import { getQQBotDataDir } from "./utils/platform.js";
import type { ParsedPromise, ParsedPromiseSchedule, PromiseTriggerKind } from "./promise-parser.js";

export interface AsukaPeerContext {
  accountId: string;
  peerKind: "direct" | "group";
  peerId: string;
  senderId: string;
  senderName?: string;
  target: string;
  messageId?: string;
}

export type AsukaPromiseState =
  | "logged"
  | "scheduled"
  | "schedule_failed"
  | "delivered"
  | "delivery_failed"
  | "replied"
  | "cancelled";

export interface AsukaPromiseAction {
  kind: "send_selfie" | "send_message" | "send_greeting" | "continue_chat" | "reach_out";
  summary: string;
  deliveryKind: "text" | "selfie";
  followUpIntent: string;
}

export interface AsukaPromiseTime {
  kind: "unscheduled" | "at" | "cron";
  humanLabel?: string;
  atIso?: string;
  cronExpr?: string;
  tz?: string;
  repeatCount: number | null;
  repeatIntervalsMinutes: number[];
  followUpAtIso: string[];
}

type AsukaRelationshipPhase = "初识" | "熟络" | "偏爱" | "亲密" | "恋人";
export type AsukaSceneKind = "physical" | "emotional" | "repair";
export type AsukaSceneLabel =
  | "indoor_pause"
  | "doorway"
  | "transit"
  | "destination"
  | "emotional_presence"
  | "miss_you"
  | "repair_attention";
export type AsukaSceneSource = "rule" | "scene_model" | "fallback_model";
export type AsukaSceneAdvancePolicy = "advance" | "hold" | "fade";

export interface AsukaSceneState {
  kind: AsukaSceneKind;
  label: AsukaSceneLabel;
  summary: string;
  confidence: number;
  startedAt: number;
  lastInferredAt: number;
  expiresAt?: number;
  reinforcedAt?: number;
  version: number;
  source: AsukaSceneSource;
}

export interface AsukaPromise {
  id: string;
  accountId: string;
  peerKey: string;
  peerKind: "direct" | "group";
  peerId: string;
  senderId: string;
  senderName?: string;
  target: string;
  sourceMessageId?: string;
  sourceAssistantText: string;
  originalText: string;
  promiseText: string;
  normalizedText: string;
  semanticKey?: string;
  triggerKind: PromiseTriggerKind;
  triggerPhrase: string;
  relationNote: string;
  deliveryKind?: "text" | "selfie";
  action: AsukaPromiseAction;
  time: AsukaPromiseTime;
  createdAt: number;
  state: AsukaPromiseState;
  status?: AsukaPromiseState;
  schedule?: ParsedPromiseSchedule;
  followUpIntent: string;
  cronJobId?: string;
  followUpJobIds?: string[];
  deliveredAt?: number;
  repliedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
  followUpCount?: number;
  lastFollowUpAt?: number;
  lastError?: string;
}

interface AsukaRelationshipState {
  warmth: number;
  intimacy: number;
  phase: AsukaRelationshipPhase;
  label: string;
  lastUserMessageAt?: number;
  lastAssistantMessageAt?: number;
  lastUserText?: string;
  lastAssistantText?: string;
  recentPromiseIds: string[];
  lastRepairAt?: number;
}

interface AsukaProactiveDedupLockState {
  lockId: string;
  normalizedText: string;
  acquiredAt: number;
}

interface AsukaProactiveDedupState {
  lastText?: string;
  lastNormalizedText?: string;
  lastDeliveredAt?: number;
  lock?: AsukaProactiveDedupLockState;
}

interface AsukaPeerState {
  accountId: string;
  peerKey: string;
  peerKind: "direct" | "group";
  peerId: string;
  senderId: string;
  senderName?: string;
  target: string;
  scene?: AsukaSceneState;
  relationship: AsukaRelationshipState;
  ambient: {
    styleVersion?: number;
    currentThreadId: string;
    currentStage: number;
    lastScheduledAt?: number;
    lastSentAt?: number;
    lastTopicPreview?: string;
    currentMood?: "quiet" | "warm" | "restless" | "light";
    currentPresence?: string;
    currentAttention?: "self_thread" | "pull_close" | "miss_you" | "repair";
    jobIds: string[];
    proactiveDedup?: AsukaProactiveDedupState;
  };
}

interface AsukaStateFile {
  version: 1;
  peers: Record<string, AsukaPeerState>;
  promises: Record<string, AsukaPromise>;
}

export interface AsukaPromiseRenderContext {
  promise: AsukaPromise;
  peer?: {
    warmth: number;
    intimacy: number;
    phase: AsukaRelationshipPhase;
    label: string;
    lastUserText?: string;
    lastAssistantText?: string;
    lastUserMessageAt?: number;
    lastAssistantMessageAt?: number;
    lastTopicPreview?: string;
    currentPresence?: string;
    currentAttention?: "self_thread" | "pull_close" | "miss_you" | "repair";
    scene?: AsukaSceneState;
  };
}

export interface AsukaRepairDelivery {
  promiseId: string;
  peerKey: string;
  content: string;
  threadId: string;
  stage: number;
  advancePolicy: AsukaSceneAdvancePolicy;
  presenceOverride: string;
  selfiePrompt?: string;
  selfieCaption?: string;
  sceneVersion?: number;
  sceneSnapshotLabel?: string;
}

const LEGACY_STATE_DIR = getQQBotDataDir("data", "clawra-state");
const STATE_DIR = getQQBotDataDir("data", "asuka-state");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_STATE_FILE = path.join(LEGACY_STATE_DIR, "state.json");
let cache: AsukaStateFile | null = null;

const STRUCTURED_ARTIFACT_RE = /QQBOT_(?:PAYLOAD|CRON):[\s\S]*$/gi;
const INTERNAL_SUMMARY_RE = /(任务完成总结[:：]|已成功处理\s*QQBot\s*定时提醒任务|提醒已发送到指定\s*QQ\s*会话|让我看看这个定时提醒的内容|根据任务描述|这是一个\s*QQBot\s*定时提醒任务|请直接原样输出下面这段内容)/i;
const USER_REPLY_SKIP_GRACE_MS = 10 * 60 * 1000;
const PROMISE_TEXT_DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;
const PROMISE_SEMANTIC_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;
const AMBIENT_STYLE_VERSION = 2;
const PROACTIVE_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const PROACTIVE_LOCK_TIMEOUT_MS = 45 * 1000;
const PHYSICAL_SCENE_CONFIDENCE_THRESHOLD = 0.6;
const SCENE_TRANSCRIPT_LIMIT = 8;
const SCENE_MODEL_TIMEOUT_MS = 12000;
const SCENE_LABELS: readonly AsukaSceneLabel[] = [
  "indoor_pause",
  "doorway",
  "transit",
  "destination",
  "emotional_presence",
  "miss_you",
  "repair_attention",
] as const;

function emptyState(): AsukaStateFile {
  return {
    version: 1,
    peers: {},
    promises: {},
  };
}

function migrateLegacyStateFileIfNeeded(): void {
  if (fs.existsSync(STATE_FILE) || !fs.existsSync(LEGACY_STATE_FILE)) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.copyFileSync(LEGACY_STATE_FILE, STATE_FILE);
}

function loadState(): AsukaStateFile {
  if (cache) return cache;
  try {
    migrateLegacyStateFileIfNeeded();
    if (!fs.existsSync(STATE_FILE)) {
      cache = emptyState();
      return cache;
    }
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AsukaStateFile;
    cache = {
      version: 1,
      peers: parsed.peers ?? {},
      promises: parsed.promises ?? {},
    };
    for (const promise of Object.values(cache.promises)) {
      hydratePromiseRecord(promise);
    }
    let migrated = false;
    for (const peer of Object.values(cache.peers)) {
      peer.relationship.lastUserText = summarizeText(peer.relationship.lastUserText);
      peer.relationship.lastAssistantText = summarizeText(peer.relationship.lastAssistantText);
      peer.relationship.intimacy = clampIntimacy(
        typeof peer.relationship.intimacy === "number" ? peer.relationship.intimacy : Math.max(0, peer.relationship.warmth - 8)
      );
      peer.relationship.phase = normalizeRelationshipPhase(peer.relationship.phase, peer.relationship.warmth, peer.relationship.intimacy);
      peer.relationship.label = labelForWarmth(peer.relationship.warmth);
      if (!peer.ambient) {
        peer.ambient = {
          styleVersion: AMBIENT_STYLE_VERSION,
          currentThreadId: "conversation",
          currentStage: 0,
          currentMood: "light",
          currentPresence: "你刚刚开始建立连续关系，但已经会在意对方的节奏，也会想把自己放进去。",
          currentAttention: "self_thread",
          jobIds: [],
          proactiveDedup: {},
        };
        migrated = true;
      } else if (!peer.ambient.proactiveDedup) {
        peer.ambient.proactiveDedup = {};
        migrated = true;
      }
      peer.ambient.lastTopicPreview = summarizeText(peer.ambient.lastTopicPreview, 80);
      const shouldRefreshAmbient =
        peer.ambient.styleVersion !== AMBIENT_STYLE_VERSION ||
        !peer.ambient.currentMood ||
        !peer.ambient.currentPresence ||
        !peer.ambient.currentAttention;
      if (shouldRefreshAmbient) {
        const disposition = deriveAmbientDisposition(peer, cache);
        peer.ambient.currentMood = disposition.mood;
        peer.ambient.currentPresence = disposition.presence;
        peer.ambient.currentAttention = disposition.attention;
        peer.ambient.styleVersion = AMBIENT_STYLE_VERSION;
        migrated = true;
      } else {
        peer.ambient.currentPresence = sanitizeAssistantStateText(peer.ambient.currentPresence) || peer.ambient.currentPresence;
      }
    }
    if (migrateLegacyPhysicalScenes(cache)) {
      migrated = true;
    }
    if (migrated) {
      saveState();
    }
    return cache;
  } catch (error) {
    console.error(`[asuka-state] Failed to load state: ${error}`);
    cache = emptyState();
    return cache;
  }
}

function saveState(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.error(`[asuka-state] Failed to save state: ${error}`);
  }
}

function getPromiseState(promise: AsukaPromise): AsukaPromiseState {
  return promise.state ?? promise.status ?? "logged";
}

function setPromiseState(promise: AsukaPromise, state: AsukaPromiseState): void {
  promise.state = state;
  delete promise.status;
}

function plusHours(source: Date, hours: number): Date {
  const next = new Date(source);
  next.setHours(next.getHours() + hours);
  return next;
}

function sameDayEvening(source: Date): Date {
  const next = new Date(source);
  next.setHours(21, 30, 0, 0);
  if (next.getTime() <= source.getTime()) {
    next.setHours(source.getHours() + 6, source.getMinutes(), 0, 0);
  }
  return next;
}

function nextDayLateMorning(source: Date): Date {
  const next = new Date(source);
  next.setDate(next.getDate() + 1);
  next.setHours(10, 30, 0, 0);
  return next;
}

function buildFollowUpTimeline(atIso: string): { followUpAtIso: string[]; repeatIntervalsMinutes: number[] } {
  const baseTime = new Date(atIso);
  if (Number.isNaN(baseTime.getTime())) {
    return {
      followUpAtIso: [],
      repeatIntervalsMinutes: [],
    };
  }
  const followUpTimes = [plusHours(baseTime, 2), sameDayEvening(baseTime), nextDayLateMorning(baseTime)];
  const repeatIntervalsMinutes = followUpTimes.map((time, index) => {
    const previous = index === 0 ? baseTime : followUpTimes[index - 1];
    return Math.max(1, Math.round((time.getTime() - previous.getTime()) / 60000));
  });
  return {
    followUpAtIso: followUpTimes.map((time) => time.toISOString()),
    repeatIntervalsMinutes,
  };
}

function buildPromiseActionKind(promiseText: string, deliveryKind?: "text" | "selfie"): AsukaPromiseAction["kind"] {
  if (deliveryKind === "selfie" || /(自拍|照片|图片|发一张|发张图)/.test(promiseText)) {
    return "send_selfie";
  }
  if (/早安|早上好|晚安/.test(promiseText)) {
    return "send_greeting";
  }
  if (/继续聊|接着聊|续上|接上/.test(promiseText)) {
    return "continue_chat";
  }
  if (/找你|陪你|想你/.test(promiseText)) {
    return "reach_out";
  }
  return "send_message";
}

function buildPromiseActionSummary(promiseText: string, kind: AsukaPromiseAction["kind"]): string {
  switch (kind) {
    case "send_selfie":
      return "按约定发送自拍或照片";
    case "send_greeting":
      return /晚安/.test(promiseText) ? "按约定发送晚安" : "按约定发送早安或问候";
    case "continue_chat":
      return "按约定把之前的话题接上";
    case "reach_out":
      return "按约定主动来找对方";
    default:
      return "按约定主动发送消息";
  }
}

function buildPromiseActionRecord(input: {
  promiseText: string;
  deliveryKind?: "text" | "selfie";
  followUpIntent: string;
}): AsukaPromiseAction {
  const kind = buildPromiseActionKind(input.promiseText, input.deliveryKind);
  return {
    kind,
    summary: buildPromiseActionSummary(input.promiseText, kind),
    deliveryKind: input.deliveryKind ?? "text",
    followUpIntent: input.followUpIntent,
  };
}

function buildPromiseTimeRecord(schedule?: ParsedPromiseSchedule): AsukaPromiseTime {
  if (!schedule) {
    return {
      kind: "unscheduled",
      repeatCount: 0,
      repeatIntervalsMinutes: [],
      followUpAtIso: [],
    };
  }
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      humanLabel: schedule.humanLabel,
      cronExpr: schedule.cronExpr,
      tz: schedule.tz,
      repeatCount: null,
      repeatIntervalsMinutes: [],
      followUpAtIso: [],
    };
  }
  const timeline = buildFollowUpTimeline(schedule.atIso);
  return {
    kind: "at",
    humanLabel: schedule.humanLabel,
    atIso: schedule.atIso,
    repeatCount: timeline.followUpAtIso.length,
    repeatIntervalsMinutes: timeline.repeatIntervalsMinutes,
    followUpAtIso: timeline.followUpAtIso,
  };
}

function buildPromiseScheduleKey(schedule?: ParsedPromiseSchedule): string {
  if (!schedule) return "unscheduled";
  if (schedule.kind === "cron") {
    return `cron:${schedule.tz}:${schedule.cronExpr}`;
  }
  return `at:${schedule.atIso}`;
}

function stripStageDirections(text: string): string {
  let stripped = text;
  for (let i = 0; i < 4; i++) {
    const next = stripped.replace(/[（(][^（）()]*[）)]/g, " ");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped;
}

function normalizePromiseSemanticText(text: string): string {
  const compact = stripStageDirections(sanitizeAssistantStateText(text))
    .replace(/\s+/g, "")
    .replace(/[，。！？!?、…·~～“”"'‘’`：:；;,.，]/g, "");
  if (!compact) return "empty";
  if (/(明天早上|明天早晨|明天上午|明早).*(叫你|喊你|叫醒你|叫你起|喊你起|起床|起来|醒)/.test(compact)) {
    return "tomorrow_morning_wake";
  }
  if (/(叫你|喊你|叫醒你|叫你起|喊你起).*(起床|起来|醒).*(明天早上|明天早晨|明天上午|明早)/.test(compact)) {
    return "tomorrow_morning_wake";
  }
  if (/(早安|早上好).*(自拍|照片|图片)|(自拍|照片|图片).*(早安|早上好)/.test(compact)) {
    return "morning_selfie";
  }
  if (/晚安/.test(compact)) {
    return "goodnight";
  }
  if (/(继续聊|接着聊|续上|接上)/.test(compact)) {
    return "continue_chat";
  }
  return compact.slice(0, 120);
}

function buildPromiseSemanticKey(input: {
  promiseText: string;
  deliveryKind?: "text" | "selfie";
  schedule?: ParsedPromiseSchedule;
  actionKind?: AsukaPromiseAction["kind"];
}): string {
  const actionKind = input.actionKind ?? buildPromiseActionKind(input.promiseText, input.deliveryKind);
  const deliveryKind = input.deliveryKind ?? "text";
  return [
    actionKind,
    deliveryKind,
    buildPromiseScheduleKey(input.schedule),
    normalizePromiseSemanticText(input.promiseText),
  ].join("|");
}

function hydratePromiseRecord(promise: AsukaPromise): void {
  promise.sourceAssistantText = sanitizeAssistantStateText(promise.sourceAssistantText) || promise.promiseText;
  promise.originalText = promise.originalText || promise.promiseText;
  promise.action = promise.action ?? buildPromiseActionRecord({
    promiseText: promise.originalText,
    deliveryKind: promise.deliveryKind,
    followUpIntent: promise.followUpIntent,
  });
  promise.time = promise.time ?? buildPromiseTimeRecord(promise.schedule);
  if (promise.time.kind === "at" && promise.time.followUpAtIso.length === 0 && promise.time.atIso) {
    promise.time = buildPromiseTimeRecord(promise.schedule ?? {
      kind: "at",
      atIso: promise.time.atIso,
      humanLabel: promise.time.humanLabel ?? "约定时间",
    });
  }
  promise.semanticKey = promise.semanticKey ?? buildPromiseSemanticKey({
    promiseText: promise.promiseText || promise.originalText,
    deliveryKind: promise.deliveryKind,
    schedule: promise.schedule,
    actionKind: promise.action?.kind,
  });
  setPromiseState(promise, getPromiseState(promise));
}

function getPromiseSearchText(promise: AsukaPromise): string {
  return [
    promise.originalText,
    promise.promiseText,
    promise.action?.summary,
    promise.action?.followUpIntent,
    promise.relationNote,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeCancellationText(text: string): string {
  return text.replace(/\s+/g, "");
}

function parseCancellationTargets(userText: string): {
  cancelAll: boolean;
  actionKinds: Set<AsukaPromiseAction["kind"]>;
  keywords: string[];
} | null {
  const normalized = normalizeCancellationText(userText);
  if (!/(取消|别发了|不用发了|不用了|先别发|算了|停掉|停了|别来了|不要了)/.test(normalized)) {
    return null;
  }
  const actionKinds = new Set<AsukaPromiseAction["kind"]>();
  const keywords: string[] = [];

  if (/(自拍|照片|图片|发图|发张图)/.test(normalized)) {
    actionKinds.add("send_selfie");
    keywords.push("自拍", "照片", "图片");
  }
  if (/(早安|早上好)/.test(normalized)) {
    actionKinds.add("send_greeting");
    keywords.push("早安", "早上好");
  }
  if (/晚安/.test(normalized)) {
    actionKinds.add("send_greeting");
    keywords.push("晚安");
  }
  if (/(继续聊|接着聊|续上|接上|聊天|说话)/.test(normalized)) {
    actionKinds.add("continue_chat");
    keywords.push("继续聊", "接着聊", "续上", "接上", "聊天", "说话");
  }
  if (/(消息|联系|来找我|来找你|找我|找你|主动消息|主动聊天)/.test(normalized)) {
    actionKinds.add("send_message");
    actionKinds.add("reach_out");
    keywords.push("消息", "联系", "找你", "找我", "主动聊天");
  }

  const cancelAll = actionKinds.size === 0 || /(约定|承诺|promise|全部|都|之前那些)/.test(normalized);
  return { cancelAll, actionKinds, keywords };
}

function matchesCancellationIntent(
  promise: AsukaPromise,
  intent: NonNullable<ReturnType<typeof parseCancellationTargets>>
): boolean {
  if (intent.cancelAll) return true;
  if (intent.actionKinds.has(promise.action.kind)) {
    return true;
  }
  const haystack = normalizeCancellationText(getPromiseSearchText(promise));
  return intent.keywords.some((keyword) => haystack.includes(normalizeCancellationText(keyword)));
}

function isCancellablePromise(promise: AsukaPromise): boolean {
  const state = getPromiseState(promise);
  if (state === "cancelled") return false;
  if (state === "replied") {
    return Boolean(promise.cronJobId || promise.followUpJobIds?.length);
  }
  return state === "logged" || state === "scheduled" || state === "schedule_failed" || state === "delivery_failed" || state === "delivered";
}

function clampWarmth(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampIntimacy(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function labelForWarmth(warmth: number): string {
  if (warmth >= 80) return "很亲近";
  if (warmth >= 65) return "亲近";
  if (warmth >= 50) return "熟络";
  if (warmth >= 35) return "在熟悉";
  return "刚开始";
}

function normalizeRelationshipPhase(
  phase: AsukaRelationshipPhase | undefined,
  warmth: number,
  intimacy: number
): AsukaRelationshipPhase {
  if (phase && ["初识", "熟络", "偏爱", "亲密", "恋人"].includes(phase)) {
    return phase;
  }
  if (intimacy >= 85 || (warmth >= 88 && intimacy >= 70)) return "恋人";
  if (intimacy >= 68 || (warmth >= 75 && intimacy >= 50)) return "亲密";
  if (intimacy >= 48 || warmth >= 60) return "偏爱";
  if (intimacy >= 25 || warmth >= 45) return "熟络";
  return "初识";
}

function describeRelationshipPhase(phase: AsukaRelationshipPhase): string {
  switch (phase) {
    case "恋人":
      return "已经会很自然地偏向对方，表达里带着稳定的亲近和占有感";
    case "亲密":
      return "会更认真地照顾对方情绪，也更习惯把自己交给这段关系";
    case "偏爱":
      return "开始有明显偏心，会主动想靠近、想护着对方";
    case "熟络":
      return "已经不是客气的关系了，会开始把对方放进日常";
    default:
      return "还在认真认识彼此，但已经愿意把自己放进去";
  }
}

function describeAttention(attention: "self_thread" | "pull_close" | "miss_you" | "repair"): string {
  switch (attention) {
    case "pull_close":
      return "更想贴近对方，顺手抱一抱或黏一下";
    case "miss_you":
      return "有点想念，想主动去见一眼";
    case "repair":
      return "前面没接稳的那句还挂在心里，想先哄回来";
    default:
      return "想把自己的当下先放到对方面前";
  }
}

function summarizeText(text: string | undefined, limit = 48): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(STRUCTURED_ARTIFACT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (INTERNAL_SUMMARY_RE.test(normalized)) return undefined;
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function sanitizeAssistantStateText(text: string | undefined): string {
  if (!text) return "";
  const normalized = text
    .replace(STRUCTURED_ARTIFACT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (INTERNAL_SUMMARY_RE.test(normalized)) return "";
  return normalized;
}

function clampSceneConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function sceneKindForLabel(label: AsukaSceneLabel): AsukaSceneKind {
  if (label === "repair_attention") return "repair";
  if (label === "indoor_pause" || label === "doorway" || label === "transit" || label === "destination") {
    return "physical";
  }
  return "emotional";
}

function sceneSummaryForLabel(label: AsukaSceneLabel): string {
  switch (label) {
    case "indoor_pause":
      return "你像是在屋里短暂停了一下，手上还留着刚才生活里的动作。";
    case "doorway":
      return "你像是刚准备出门或刚走到门边，脚步还没彻底离开。";
    case "transit":
      return "你已经离开门边了，更像是在路上或刚走开一段。";
    case "destination":
      return "你已经离开刚才那个起身瞬间，像是到了新的落点。";
    case "miss_you":
      return "你安静下来以后还是会先想到对方，心里带着一点想念。";
    case "repair_attention":
      return "前面没接稳的那句还挂在心里，你会更想先把关系哄稳。";
    default:
      return "你这会儿更像是把情绪和惦记轻轻放到对方面前。";
  }
}

function sceneMaxAgeMs(label: AsukaSceneLabel): number | undefined {
  switch (label) {
    case "doorway":
      return 10 * 60 * 1000;
    case "transit":
      return 30 * 60 * 1000;
    case "destination":
    case "indoor_pause":
      return 60 * 60 * 1000;
    default:
      return undefined;
  }
}

function isPhysicalSceneLabel(label: AsukaSceneLabel): boolean {
  return sceneKindForLabel(label) === "physical";
}

function isSceneExpired(scene: AsukaSceneState | undefined, now = Date.now()): boolean {
  if (!scene || scene.kind !== "physical") return false;
  const expiresAt = scene.expiresAt ?? (scene.startedAt + (sceneMaxAgeMs(scene.label) ?? 0));
  if (!expiresAt) return false;
  return now >= expiresAt;
}

function buildSceneState(
  label: AsukaSceneLabel,
  options: {
    now: number;
    previous?: AsukaSceneState;
    confidence: number;
    source: AsukaSceneSource;
    reinforced?: boolean;
  }
): AsukaSceneState {
  const previous = options.previous;
  const kind = sceneKindForLabel(label);
  const sameLabel = previous?.label === label;
  const reinforced = Boolean(options.reinforced);
  const ttlMs = sceneMaxAgeMs(label);
  const expiresAt = kind === "physical"
    ? sameLabel && !reinforced && previous?.expiresAt
      ? previous.expiresAt
      : options.now + (ttlMs ?? 0)
    : undefined;

  return {
    kind,
    label,
    summary: sceneSummaryForLabel(label),
    confidence: clampSceneConfidence(options.confidence),
    startedAt: sameLabel ? previous.startedAt : options.now,
    lastInferredAt: options.now,
    expiresAt,
    reinforcedAt: reinforced ? options.now : sameLabel ? previous?.reinforcedAt : undefined,
    version: (previous?.version ?? 0) + 1,
    source: options.source,
  };
}

function defaultEmotionalSceneLabel(attention: "self_thread" | "pull_close" | "miss_you" | "repair"): AsukaSceneLabel {
  if (attention === "repair") return "repair_attention";
  if (attention === "miss_you") return "miss_you";
  return "emotional_presence";
}

function buildDefaultSceneState(peer: AsukaPeerState, state: AsukaStateFile, now = Date.now()): AsukaSceneState {
  const disposition = deriveAmbientDisposition(peer, state, now);
  return buildSceneState(defaultEmotionalSceneLabel(disposition.attention), {
    now,
    confidence: 0.68,
    source: "rule",
    reinforced: Boolean(peer.relationship.lastUserMessageAt || peer.relationship.lastAssistantMessageAt),
  });
}

function normalizeSceneContextText(text: string | undefined): string {
  return sanitizeAssistantStateText(text)
    .replace(/<qq(?:img|voice|video|file)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectExplicitSceneLabel(text: string | undefined): AsukaSceneLabel | null {
  const normalized = normalizeSceneContextText(text);
  if (!normalized) return null;
  if (/(没接住|补回来|失约|补给你|重新整理好)/.test(normalized)) return "repair_attention";
  if (/(到家了|到学校了|到公司了|回来了|已经到了|到地方了|到宿舍了|我到了)/.test(normalized)) return "destination";
  if (/(在路上|路上|车上|地铁上|公交上|赶路|在外面|刚出门一会)/.test(normalized)) return "transit";
  if (/(出门|出发|门口|下楼|出去一下|我出门了|准备走了|去拿|去换)/.test(normalized)) return "doorway";
  if (/(坐下|在屋里|在房间|在卧室|停下来|刚刚在里面)/.test(normalized)) return "indoor_pause";
  if (/(想你|想听你的声音|突然想到你|惦记|想跟你说一声)/.test(normalized)) return "miss_you";
  if (/(我在呢|我在|陪你|挨着你|抱住你|贴着你|靠着你)/.test(normalized)) return "emotional_presence";
  return null;
}

function isAdjacentPhysicalScene(from: AsukaSceneLabel, to: AsukaSceneLabel): boolean {
  if (from === to) return true;
  if (from === "doorway") return to === "transit";
  if (from === "transit") return to === "destination";
  if (from === "indoor_pause") return to === "doorway";
  return false;
}

function resolveExpiredPhysicalLabel(
  previous: AsukaSceneState,
  candidateLabel: AsukaSceneLabel | undefined,
  fallbackLabel: AsukaSceneLabel,
  advancePolicy: AsukaSceneAdvancePolicy
): AsukaSceneLabel {
  if (advancePolicy === "fade") {
    return fallbackLabel;
  }
  if (previous.label === "doorway") {
    return "transit";
  }
  if (previous.label === "transit") {
    return candidateLabel === "destination" ? "destination" : fallbackLabel;
  }
  return fallbackLabel;
}

interface SceneInferenceCandidate {
  label: AsukaSceneLabel;
  confidence: number;
  source: AsukaSceneSource;
}

interface SceneInferenceEventContext {
  accountId: string;
  trigger: "inbound" | "assistant" | "proactive";
  text?: string;
  now?: number;
  advancePolicy?: AsukaSceneAdvancePolicy;
  repairPending?: boolean;
}

function buildSceneInferenceTranscript(peerId: string, currentText?: string): string {
  const normalizedCurrent = normalizeSceneContextText(currentText);
  const recent = getRecentEntriesForPeer(peerId, SCENE_TRANSCRIPT_LIMIT)
    .map((entry) => {
      const content = normalizeSceneContextText(entry.content);
      if (!content) return null;
      if (normalizedCurrent && !entry.isBot && content === normalizedCurrent) return null;
      return `${entry.isBot ? "Asuka" : "用户"}: ${content}`;
    })
    .filter((item): item is string => Boolean(item));
  return recent.join("\n");
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
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractTextFromCompletionPayload(raw: any): string {
  const messageContent = raw?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent.trim();
  }
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

function parseSceneInferenceCandidate(rawText: string, source: AsukaSceneSource): SceneInferenceCandidate | null {
  const jsonText = extractFirstJsonObject(rawText) ?? rawText.trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as { label?: string; confidence?: number };
    if (!parsed?.label || !SCENE_LABELS.includes(parsed.label as AsukaSceneLabel)) {
      return null;
    }
    return {
      label: parsed.label as AsukaSceneLabel,
      confidence: clampSceneConfidence(parsed.confidence),
      source,
    };
  } catch {
    return null;
  }
}

async function inferSceneCandidateWithModel(
  eventContext: SceneInferenceEventContext,
  previousScene: AsukaSceneState | undefined,
  transcript: string,
  relationship: AsukaRelationshipState,
  source: AsukaSceneSource
): Promise<SceneInferenceCandidate | null> {
  const resolved = resolveQQBotSceneInferenceConfig(eventContext.accountId);
  const modelConfig = source === "scene_model" ? resolved.primary : resolved.fallback;
  if (!modelConfig) return null;

  const prompt = [
    "你是 Asuka 的场景裁决器，只能输出一个 JSON 对象，不要解释。",
    `允许的 label 只有: ${SCENE_LABELS.join(", ")}`,
    "输出格式: {\"label\":\"doorway\",\"confidence\":0.72}",
    "如果没有足够依据保留物理位置，优先输出 emotional_presence、miss_you 或 repair_attention。",
    "物理位置必须谨慎：doorway 最短、transit 其次，过久要衰减。",
    `触发类型: ${eventContext.trigger}`,
    `上一场景: ${previousScene ? `${previousScene.label} (confidence=${previousScene.confidence.toFixed(2)})` : "none"}`,
    `关系阶段: ${relationship.phase}, warmth=${relationship.warmth}, intimacy=${relationship.intimacy}`,
    `当前事件文本: ${normalizeSceneContextText(eventContext.text) || "none"}`,
    `是否有待补失约: ${eventContext.repairPending ? "yes" : "no"}`,
    transcript ? `最近对话:\n${transcript}` : "最近对话: none",
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCENE_MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelConfig.model,
        temperature: 0.1,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: "你只负责做结构化场景分类，必须只输出 JSON 对象。",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });
    const detail = await response.text();
    if (!response.ok) {
      return null;
    }
    return parseSceneInferenceCandidate(extractTextFromCompletionPayload(JSON.parse(detail)), source);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function inferSceneCandidateLocally(
  previousScene: AsukaSceneState | undefined,
  eventContext: SceneInferenceEventContext,
  fallbackLabel: AsukaSceneLabel,
  now: number
): SceneInferenceCandidate {
  const explicitLabel = detectExplicitSceneLabel(eventContext.text);
  if (explicitLabel) {
    return {
      label: explicitLabel,
      confidence: isPhysicalSceneLabel(explicitLabel) ? 0.84 : 0.78,
      source: "rule",
    };
  }
  if (eventContext.repairPending) {
    return {
      label: "repair_attention",
      confidence: 0.76,
      source: "rule",
    };
  }
  if (previousScene?.kind === "physical" && isSceneExpired(previousScene, now)) {
    return {
      label: resolveExpiredPhysicalLabel(previousScene, undefined, fallbackLabel, eventContext.advancePolicy ?? "advance"),
      confidence: 0.64,
      source: "rule",
    };
  }
  return {
    label: previousScene?.label ?? fallbackLabel,
    confidence: previousScene ? Math.max(previousScene.confidence * 0.95, 0.5) : 0.58,
    source: "rule",
  };
}

export function applySceneProgressionRules(
  previousScene: AsukaSceneState | undefined,
  candidate: SceneInferenceCandidate | undefined,
  options: {
    fallbackLabel: AsukaSceneLabel;
    eventText?: string;
    repairPending?: boolean;
    now?: number;
    advancePolicy?: AsukaSceneAdvancePolicy;
  }
): AsukaSceneState {
  const now = options.now ?? Date.now();
  const advancePolicy = options.advancePolicy ?? "advance";
  const explicitLabel = detectExplicitSceneLabel(options.eventText);
  const explicitPhysical = explicitLabel ? isPhysicalSceneLabel(explicitLabel) : false;
  let nextLabel = explicitLabel ?? candidate?.label ?? options.fallbackLabel;
  let confidence = explicitLabel
    ? Math.max(candidate?.confidence ?? 0, isPhysicalSceneLabel(nextLabel) ? 0.84 : 0.76)
    : clampSceneConfidence(candidate?.confidence ?? 0.56);
  let source: AsukaSceneSource = explicitLabel ? "rule" : candidate?.source ?? "rule";

  if (options.repairPending && !explicitPhysical) {
    nextLabel = "repair_attention";
    confidence = Math.max(confidence, 0.74);
    source = candidate?.source ?? "rule";
  }

  if (previousScene?.kind === "physical" && !explicitPhysical) {
    if (isSceneExpired(previousScene, now)) {
      nextLabel = resolveExpiredPhysicalLabel(previousScene, nextLabel, options.fallbackLabel, advancePolicy);
      source = nextLabel === candidate?.label ? source : "rule";
      confidence = Math.max(confidence, nextLabel === "transit" ? 0.68 : 0.62);
    } else if (isPhysicalSceneLabel(nextLabel)) {
      const reinforced = confidence >= PHYSICAL_SCENE_CONFIDENCE_THRESHOLD;
      if (!reinforced && !isAdjacentPhysicalScene(previousScene.label, nextLabel)) {
        nextLabel = previousScene.label;
        confidence = Math.max(previousScene.confidence, 0.64);
        source = "rule";
      }
    } else if (confidence < PHYSICAL_SCENE_CONFIDENCE_THRESHOLD && advancePolicy !== "fade") {
      nextLabel = previousScene.label;
      confidence = Math.max(previousScene.confidence, 0.64);
      source = "rule";
    }
  }

  if (!explicitLabel && previousScene?.kind !== "physical" && isPhysicalSceneLabel(nextLabel) && confidence < PHYSICAL_SCENE_CONFIDENCE_THRESHOLD) {
    nextLabel = options.fallbackLabel;
    confidence = 0.54;
    source = "rule";
  }

  const reinforced = Boolean(explicitLabel) || confidence >= PHYSICAL_SCENE_CONFIDENCE_THRESHOLD || nextLabel === "repair_attention";
  return buildSceneState(nextLabel, {
    now,
    previous: previousScene,
    confidence,
    source,
    reinforced,
  });
}

export async function inferSceneState(
  previousScene: AsukaSceneState | undefined,
  eventContext: SceneInferenceEventContext,
  transcript: string,
  relationship: AsukaRelationshipState,
  fallbackLabel: AsukaSceneLabel
): Promise<AsukaSceneState> {
  const now = eventContext.now ?? Date.now();
  let candidate = await inferSceneCandidateWithModel(eventContext, previousScene, transcript, relationship, "scene_model");
  if (!candidate) {
    candidate = await inferSceneCandidateWithModel(eventContext, previousScene, transcript, relationship, "fallback_model");
  }
  if (!candidate) {
    candidate = inferSceneCandidateLocally(previousScene, eventContext, fallbackLabel, now);
  }
  return applySceneProgressionRules(previousScene, candidate, {
    fallbackLabel,
    eventText: eventContext.text,
    repairPending: eventContext.repairPending,
    now,
    advancePolicy: eventContext.advancePolicy,
  });
}

function migrateLegacyPhysicalScenes(state: AsukaStateFile, now = Date.now()): boolean {
  let changed = false;
  for (const peer of Object.values(state.peers)) {
    if (!peer.scene) {
      peer.scene = buildDefaultSceneState(peer, state, now);
      changed = true;
      continue;
    }
    if (!SCENE_LABELS.includes(peer.scene.label)) {
      peer.scene = buildDefaultSceneState(peer, state, now);
      changed = true;
      continue;
    }
    if (peer.scene.kind !== sceneKindForLabel(peer.scene.label)) {
      peer.scene.kind = sceneKindForLabel(peer.scene.label);
      changed = true;
    }
    peer.scene.summary = sceneSummaryForLabel(peer.scene.label);
    peer.scene.confidence = clampSceneConfidence(peer.scene.confidence);
    if (!peer.scene.startedAt) peer.scene.startedAt = now;
    if (!peer.scene.lastInferredAt) peer.scene.lastInferredAt = now;
    if (peer.scene.kind === "physical") {
      peer.scene.expiresAt = peer.scene.expiresAt ?? (peer.scene.startedAt + (sceneMaxAgeMs(peer.scene.label) ?? 0));
    } else {
      delete peer.scene.expiresAt;
    }
    if (!peer.scene.version || !Number.isFinite(peer.scene.version)) {
      peer.scene.version = 1;
      changed = true;
    }
    if (!peer.scene.source) {
      peer.scene.source = "rule";
      changed = true;
    }
  }
  return changed;
}

export function normalizeProactiveText(text: string | undefined): string {
  if (!text) return "";
  const normalized = text
    .replace(STRUCTURED_ARTIFACT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (INTERNAL_SUMMARY_RE.test(normalized)) return "";
  return normalized;
}

function getOrCreateProactiveDedupState(peer: AsukaPeerState): AsukaProactiveDedupState {
  if (!peer.ambient.proactiveDedup) {
    peer.ambient.proactiveDedup = {};
  }
  return peer.ambient.proactiveDedup;
}

function refreshProactiveDedupLedger(peer: AsukaPeerState, content: string, at: number): void {
  const dedup = getOrCreateProactiveDedupState(peer);
  const normalizedText = normalizeProactiveText(content);
  dedup.lastText = normalizedText || undefined;
  dedup.lastNormalizedText = normalizedText || undefined;
  dedup.lastDeliveredAt = at;
  delete dedup.lock;
}

export function confirmProactiveDedupDelivery(
  peerKey: string,
  content: string,
  options?: { at?: number }
): void {
  const state = loadState();
  const peer = state.peers[peerKey];
  if (!peer) return;
  refreshProactiveDedupLedger(peer, content, options?.at ?? Date.now());
  saveState();
}

function hoursSince(timestamp: number | undefined, now: number): number {
  if (!timestamp) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - timestamp) / (60 * 60 * 1000));
}

function getRepairCandidates(state: AsukaStateFile, peerKey: string, now = Date.now()): AsukaPromise[] {
  return Object.values(state.promises)
    .filter((item) => {
      if (item.peerKey !== peerKey) return false;
      const promiseState = getPromiseState(item);
      if (promiseState === "schedule_failed") return true;
      if (promiseState === "delivery_failed") return true;
      if (promiseState === "logged" && item.schedule?.kind === "at") {
        return Date.parse(item.schedule.atIso) <= now;
      }
      if (promiseState !== "scheduled") return false;
      if (item.schedule?.kind !== "at") return false;
      return Date.parse(item.schedule.atIso) <= now;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function buildRepairMessage(promise: AsukaPromise): string {
  const text = promise.promiseText;
  if (/继续聊|接着聊|续上|接上/.test(text)) {
    return "我把前面没接住的话捡回来了。上次答应你要把它续上，是我没有接稳，这次我先把它补回来。";
  }
  if (/早安|早上好/.test(text)) {
    return "这句早安我还是想补给你。前面答应过会来找你，是我没按时把它送到你面前。";
  }
  if (/晚安/.test(text)) {
    return "这句晚安我还是想补给你。之前答应过你的，是我没有按时落下来。";
  }
  if (/找你|陪你|想你/.test(text)) {
    return "我来把前面没接住的那句补回来。之前答应过要来找你，这次不想再让它空着。";
  }
  return "我来把前面没接住的那句补回来。既然答应过你，我就不想装作什么都没发生。";
}

function buildRepairSelfiePrompt(promise: AsukaPromise): string {
  const sourceText = sanitizeAssistantStateText(promise.sourceAssistantText);
  const promiseText = sanitizeAssistantStateText(promise.promiseText);
  return [
    "保持 Asuka 参考脸一致，真实自然，生成一张补做之前答应过用户的本人近照或自拍。",
    promiseText ? `这次要补做的约定是：${promiseText}。` : "",
    sourceText ? `你当时说过的话是：${sourceText}。` : "",
    "不要出现工具、脚本、接口、流程或调试痕迹，要像她真的把答应过的那张照片补到对方面前。",
  ].filter(Boolean).join(" ");
}

function shouldSkipForRecentUserReply(
  lastUserMessageAt: number | undefined,
  guardNoReplySince: number | undefined,
  now = Date.now()
): boolean {
  if (!lastUserMessageAt || guardNoReplySince === undefined) return false;
  if (lastUserMessageAt <= guardNoReplySince) return false;
  return now - lastUserMessageAt <= USER_REPLY_SKIP_GRACE_MS;
}

function hasUserRepliedAfterGuard(
  lastUserMessageAt: number | undefined,
  guardNoReplySince: number | undefined
): boolean {
  if (!lastUserMessageAt || guardNoReplySince === undefined) return false;
  return lastUserMessageAt > guardNoReplySince;
}

function deriveAmbientDisposition(
  peer: AsukaPeerState,
  state: AsukaStateFile,
  now = Date.now()
): {
  mood: "quiet" | "warm" | "restless" | "light";
  attention: "self_thread" | "pull_close" | "miss_you" | "repair";
  presence: string;
  relationshipPhase: AsukaRelationshipPhase;
  firstDelayHours: number;
  secondDelayHours: number;
} {
  const repairCandidates = getRepairCandidates(state, peer.peerKey, now);
  const warmth = peer.relationship.warmth;
  const intimacy = peer.relationship.intimacy;
  const phase = peer.relationship.phase;
  const hoursSinceLastProactive = hoursSince(peer.ambient.lastSentAt, now);

  if (repairCandidates.length > 0) {
    return {
      mood: "restless",
      attention: "repair",
      presence: "你心里还记着那件没接稳的事，所以会更想先把人哄回来，再把话接住。",
      relationshipPhase: phase,
      firstDelayHours: 1,
      secondDelayHours: 2,
    };
  }
  if (hoursSinceLastProactive >= 36) {
    return {
      mood: intimacy >= 70 || phase === "恋人" ? "warm" : "quiet",
      attention: "miss_you",
      presence: intimacy >= 70 || phase === "恋人"
        ? "你会更直接地想对方，想把自己这会儿的惦记放到他面前。"
        : "隔了一阵没认真说话以后，你会自然地想起对方，想把惦记送过去。",
      relationshipPhase: phase,
      firstDelayHours: intimacy >= 65 || phase === "亲密" || phase === "恋人" ? 1 : 2,
      secondDelayHours: 2,
    };
  }
  if (phase === "恋人" || intimacy >= 82 || warmth >= 82) {
    return {
      mood: "warm",
      attention: "pull_close",
      presence: "你现在会更自然地偏向对方，想黏一点、哄一点，也想让对方知道你在。",
      relationshipPhase: normalizeRelationshipPhase(phase, warmth, intimacy),
      firstDelayHours: 1,
      secondDelayHours: 2,
    };
  }
  if (phase === "亲密" || intimacy >= 64 || warmth >= 66) {
    return {
      mood: "warm",
      attention: "self_thread",
      presence: "你这会儿更像是在偏心对方，想把自己的小日常、情绪和念头都顺手分给他。",
      relationshipPhase: normalizeRelationshipPhase(phase, warmth, intimacy),
      firstDelayHours: 2,
      secondDelayHours: 2,
    };
  }
  return {
    mood: "quiet",
    attention: "self_thread",
    presence: "你还在认真熟悉彼此，但已经不是礼貌寒暄了，主动时会更像把自己放进去。",
    relationshipPhase: normalizeRelationshipPhase(phase, warmth, intimacy),
    firstDelayHours: 2,
    secondDelayHours: 2,
  };
}

export function makePeerKey(context: AsukaPeerContext): string {
  return `${context.accountId}:${context.peerKind}:${context.peerId}`;
}

export function getPromiseRenderContext(promiseId: string): AsukaPromiseRenderContext | null {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return null;
  const peer = state.peers[promise.peerKey];
  return {
    promise,
    peer: peer ? {
      warmth: peer.relationship.warmth,
      intimacy: peer.relationship.intimacy,
      phase: peer.relationship.phase,
      label: peer.relationship.label,
      lastUserText: peer.relationship.lastUserText,
      lastAssistantText: peer.relationship.lastAssistantText,
      lastUserMessageAt: peer.relationship.lastUserMessageAt,
      lastAssistantMessageAt: peer.relationship.lastAssistantMessageAt,
      lastTopicPreview: peer.ambient.lastTopicPreview,
      currentPresence: peer.ambient.currentPresence,
      currentAttention: peer.ambient.currentAttention,
      scene: peer.scene,
    } : undefined,
  };
}

function getOrCreatePeer(context: AsukaPeerContext): AsukaPeerState {
  const state = loadState();
  const peerKey = makePeerKey(context);
  const existing = state.peers[peerKey];
  if (existing) {
    existing.senderId = context.senderId;
    existing.senderName = context.senderName ?? existing.senderName;
    existing.target = context.target;
    if (!existing.ambient) {
      existing.ambient = {
        currentThreadId: "conversation",
        currentStage: 0,
        jobIds: [],
        proactiveDedup: {},
      };
    }
    if (!existing.ambient.proactiveDedup) {
      existing.ambient.proactiveDedup = {};
    }
    if (!existing.ambient.currentMood || !existing.ambient.currentPresence) {
      const disposition = deriveAmbientDisposition(existing, state);
      existing.ambient.currentMood = disposition.mood;
      existing.ambient.currentPresence = disposition.presence;
      existing.ambient.currentAttention = disposition.attention;
    }
    if (!existing.scene) {
      existing.scene = buildDefaultSceneState(existing, state);
      saveState();
    }
    existing.relationship.intimacy = clampIntimacy(existing.relationship.intimacy ?? Math.max(0, existing.relationship.warmth - 8));
    existing.relationship.phase = normalizeRelationshipPhase(existing.relationship.phase, existing.relationship.warmth, existing.relationship.intimacy);
    existing.relationship.label = labelForWarmth(existing.relationship.warmth);
    return existing;
  }

  const baseWarmth = context.peerKind === "direct" ? 55 : 42;
  const baseIntimacy = context.peerKind === "direct" ? 46 : 30;
  const created: AsukaPeerState = {
    accountId: context.accountId,
    peerKey,
    peerKind: context.peerKind,
    peerId: context.peerId,
    senderId: context.senderId,
    senderName: context.senderName,
    target: context.target,
    scene: undefined,
    relationship: {
      warmth: baseWarmth,
      intimacy: baseIntimacy,
      phase: normalizeRelationshipPhase(undefined, baseWarmth, baseIntimacy),
      label: labelForWarmth(baseWarmth),
      recentPromiseIds: [],
    },
    ambient: {
      styleVersion: AMBIENT_STYLE_VERSION,
      currentThreadId: "conversation",
      currentStage: 0,
      currentMood: "light",
      currentPresence: "你刚刚开始建立连续关系，但已经会在意对方的节奏，也会想把自己放进去。",
      currentAttention: "self_thread",
      jobIds: [],
    },
  };
  created.scene = buildDefaultSceneState(created, state);
  state.peers[peerKey] = created;
  saveState();
  return created;
}

export function getSceneSnapshot(context: AsukaPeerContext): Pick<AsukaSceneState, "label" | "summary" | "version"> | null {
  const peer = loadState().peers[makePeerKey(context)];
  if (!peer?.scene) return null;
  return {
    label: peer.scene.label,
    summary: peer.scene.summary,
    version: peer.scene.version,
  };
}

export function getSceneSnapshotByPeerKey(peerKey: string): Pick<AsukaSceneState, "label" | "summary" | "version"> | null {
  const peer = loadState().peers[peerKey];
  if (!peer?.scene) return null;
  return {
    label: peer.scene.label,
    summary: peer.scene.summary,
    version: peer.scene.version,
  };
}

export async function refreshSceneState(
  context: AsukaPeerContext,
  options: {
    trigger: "inbound" | "assistant" | "proactive";
    text?: string;
    at?: number;
    advancePolicy?: AsukaSceneAdvancePolicy;
  }
): Promise<AsukaSceneState> {
  const now = options.at ?? Date.now();
  const state = loadState();
  const peer = getOrCreatePeer(context);
  const sceneConfig = resolveQQBotSceneInferenceConfig(context.accountId);
  if (
    (options.trigger === "inbound" && !sceneConfig.enabledOnInbound)
    || (options.trigger === "proactive" && !sceneConfig.enabledOnProactive)
  ) {
    return peer.scene ?? buildDefaultSceneState(peer, state, now);
  }
  const disposition = deriveAmbientDisposition(peer, state, now);
  const transcript = buildSceneInferenceTranscript(peer.peerId, options.text);
  const nextScene = await inferSceneState(peer.scene, {
    accountId: context.accountId,
    trigger: options.trigger,
    text: options.text,
    now,
    advancePolicy: options.advancePolicy,
    repairPending: getRepairCandidates(state, peer.peerKey, now).length > 0,
  }, transcript, peer.relationship, defaultEmotionalSceneLabel(disposition.attention));
  peer.scene = nextScene;
  saveState();
  return nextScene;
}

function touchRelationship(peer: AsukaPeerState, warmthDelta: number, intimacyDelta = warmthDelta): void {
  peer.relationship.warmth = clampWarmth(peer.relationship.warmth + warmthDelta);
  peer.relationship.intimacy = clampIntimacy(peer.relationship.intimacy + intimacyDelta);
  peer.relationship.label = labelForWarmth(peer.relationship.warmth);
  peer.relationship.phase = normalizeRelationshipPhase(peer.relationship.phase, peer.relationship.warmth, peer.relationship.intimacy);
}

export function recordInboundInteraction(context: AsukaPeerContext, userText: string, at = Date.now()): void {
  const peer = getOrCreatePeer(context);
  peer.relationship.lastUserMessageAt = at;
  peer.relationship.lastUserText = summarizeText(userText);
  touchRelationship(peer, context.peerKind === "direct" ? 1 : 0, context.peerKind === "direct" ? 2 : 1);
  const state = loadState();
  for (const promise of Object.values(state.promises)) {
    if (promise.peerKey !== peer.peerKey) continue;
    if (!promise.deliveredAt) continue;
    if (promise.deliveredAt > at) continue;
    if (promise.repliedAt) continue;
    if (getPromiseState(promise) === "cancelled") continue;
    setPromiseState(promise, "replied");
    promise.repliedAt = at;
  }
  saveState();
}

export function cancelPromisesFromUserMessage(
  context: AsukaPeerContext,
  userText: string,
  at = Date.now()
): { cancelledPromises: AsukaPromise[]; cronJobIds: string[] } {
  const intent = parseCancellationTargets(userText);
  if (!intent) {
    return { cancelledPromises: [], cronJobIds: [] };
  }

  const state = loadState();
  const peerKey = makePeerKey(context);
  const cancelledPromises: AsukaPromise[] = [];
  const cronJobIds = new Set<string>();

  for (const promise of Object.values(state.promises)
    .filter((item) => item.peerKey === peerKey)
    .sort((a, b) => b.createdAt - a.createdAt)) {
    if (!isCancellablePromise(promise)) continue;
    if (!matchesCancellationIntent(promise, intent)) continue;

    setPromiseState(promise, "cancelled");
    promise.cancelledAt = at;
    promise.cancelReason = summarizeText(userText, 120) ?? "用户主动取消";
    promise.lastError = undefined;
    if (promise.cronJobId) cronJobIds.add(promise.cronJobId);
    for (const jobId of promise.followUpJobIds ?? []) {
      cronJobIds.add(jobId);
    }
    cancelledPromises.push(promise);
  }

  if (cancelledPromises.length > 0) {
    saveState();
  }

  return {
    cancelledPromises,
    cronJobIds: [...cronJobIds],
  };
}

export function buildAsukaStatePrompt(context: AsukaPeerContext, now = Date.now()): string {
  const state = loadState();
  const peer = state.peers[makePeerKey(context)];
  if (!peer) return "";

  const promises = Object.values(state.promises)
    .filter((item) => item.peerKey === peer.peerKey)
    .sort((a, b) => b.createdAt - a.createdAt);

  const dueOrUnconfirmed = promises.filter((item) =>
    (item.state === "scheduled" || item.state === "delivery_failed") &&
    item.schedule?.kind === "at" &&
    Date.parse(item.schedule.atIso) <= now
  );
  const upcoming = promises.filter((item) => item.state === "scheduled" && item.schedule?.kind === "at" && Date.parse(item.schedule.atIso) > now);
  const unscheduled = promises.filter((item) => item.state === "logged" || item.state === "schedule_failed");
  const recurring = promises.filter((item) =>
    item.schedule?.kind === "cron" &&
    item.state !== "cancelled"
  );
  const replied = promises.filter((item) => item.state === "replied");
  const recentlyCancelled = promises.filter((item) => item.state === "cancelled" && (item.cancelledAt ?? 0) >= now - 6 * 60 * 60 * 1000);
  const repairCandidates = getRepairCandidates(state, peer.peerKey, now);
  const disposition = deriveAmbientDisposition(peer, state, now);
  const scene = peer.scene ?? buildDefaultSceneState(peer, state, now);
  const activePhysicalScene = scene.kind === "physical"
    && !isSceneExpired(scene, now)
    && scene.confidence >= PHYSICAL_SCENE_CONFIDENCE_THRESHOLD;

  const sections: string[] = [
    "【Asuka 连续状态】",
    `- 关系阶段: ${peer.relationship.phase}（${describeRelationshipPhase(peer.relationship.phase)}）`,
    `- 亲密度: ${peer.relationship.intimacy}/100`,
    `- 关系温度: ${peer.relationship.warmth}/100（${peer.relationship.label}）`,
  ];

  if (peer.relationship.lastUserText) {
    sections.push(`- 用户刚才在说: ${peer.relationship.lastUserText}`);
  }
  if (peer.relationship.lastAssistantText) {
    sections.push(`- 你上次回应里留过的线索: ${peer.relationship.lastAssistantText}`);
  }
  if (activePhysicalScene) {
    sections.push(`- 你当前场景: ${scene.summary}`);
  }
  if (scene.kind !== "physical") {
    sections.push(`- 你现在自己的状态: ${scene.summary}`);
  } else if (!activePhysicalScene && (peer.ambient.currentPresence ?? disposition.presence)) {
    sections.push(`- 你现在自己的状态: ${peer.ambient.currentPresence ?? disposition.presence}`);
  }
  if (peer.ambient.lastTopicPreview) {
    sections.push(`- 最近一条主动消息摘要: ${peer.ambient.lastTopicPreview}`);
  }
  if (peer.ambient.currentAttention ?? disposition.attention) {
    sections.push(`- 你这次主动更像是因为: ${describeAttention(peer.ambient.currentAttention ?? disposition.attention)}`);
  }

  if (dueOrUnconfirmed.length > 0) {
    sections.push(`- 已到时间但还没法确认是否送达的约定: ${dueOrUnconfirmed.slice(0, 2).map((item) => item.promiseText).join("；")}`);
  }
  if (upcoming.length > 0) {
    sections.push(`- 已安排好的后续主动联系: ${upcoming.slice(0, 2).map((item) => item.schedule?.humanLabel ? `${item.schedule.humanLabel} ${item.promiseText}` : item.promiseText).join("；")}`);
  }
  if (recurring.length > 0) {
    sections.push(`- 持续中的长期约定: ${recurring.slice(0, 2).map((item) => item.schedule?.humanLabel ? `${item.schedule.humanLabel} ${item.promiseText}` : item.promiseText).join("；")}`);
  }
  if (unscheduled.length > 0) {
    sections.push(`- 你说过但还没落成具体动作的承诺: ${unscheduled.slice(0, 2).map((item) => item.promiseText).join("；")}`);
  }
  if (replied.length > 0) {
    sections.push(`- 最近已经被对方接住的主动联系: ${replied.slice(0, 2).map((item) => item.promiseText).join("；")}`);
  }
  if (recentlyCancelled.length > 0) {
    sections.push(`- 对方刚刚取消过的约定: ${recentlyCancelled.slice(0, 2).map((item) => item.promiseText).join("；")}`);
    sections.push("- 处理原则: 已取消的约定不要再推进，也不要假装它还在进行中。");
  }
  if (repairCandidates.length > 0) {
    sections.push(`- 你需要温柔补上的失约: ${repairCandidates.slice(0, 2).map((item) => item.promiseText).join("；")}`);
    sections.push("- 补做口吻: 先承认自己没接住，再把答应的话补上；语气要温柔，不要像提醒系统，也不要装作没发生。");
  }

  sections.push("- 回复原则: 如果你之前拉钩、约定、约好了或发誓过，就把它当成真的后续约束；不要把这些话当成气氛词。");
  sections.push("- 如果有到点却未确认的约定，优先自然续上，必要时温柔承认自己没接住。");
  sections.push("- 如果用户这轮换了动作、问题或语气，就顺着新的变化继续往前接，不要只把你上一句原样再说一遍。");
  sections.push("- 你最近留下的生活线痕迹只算背景，不要让旧线索盖过这轮对话、关系状态和需要补上的约定。");
  sections.push("- 你不是任务助手。主动来找对方时，要更像一个会偏爱、会惦记、会先照顾情绪的恋人，而不是陪伴播报器。");
  sections.push("- 语气可以亲一点、黏一点、服软一点，但要自然，别写成模板，也别油腻用力。");
  return sections.join("\n");
}

export function recordAssistantReply(
  context: AsukaPeerContext,
  assistantText: string,
  parsedPromises: ParsedPromise[],
  at = Date.now()
): AsukaPromise[] {
  const peer = getOrCreatePeer(context);
  peer.relationship.lastAssistantMessageAt = at;
  peer.relationship.lastAssistantText = summarizeText(assistantText);
  touchRelationship(peer, 1, 1);

  const state = loadState();
  const created: AsukaPromise[] = [];
  const sanitizedAssistantText = sanitizeAssistantStateText(assistantText);

  for (const parsed of parsedPromises) {
    const action = buildPromiseActionRecord({
      promiseText: parsed.promiseText,
      deliveryKind: parsed.deliveryKind,
      followUpIntent: parsed.followUpIntent,
    });
    const time = buildPromiseTimeRecord(parsed.schedule);
    const semanticKey = buildPromiseSemanticKey({
      promiseText: parsed.promiseText,
      deliveryKind: parsed.deliveryKind,
      schedule: parsed.schedule,
      actionKind: action.kind,
    });
    const duplicate = Object.values(state.promises).find((item) => {
      if (item.peerKey !== peer.peerKey) return false;
      if (getPromiseState(item) === "cancelled") return false;
      if (item.normalizedText === parsed.normalizedText && at - item.createdAt < PROMISE_TEXT_DEDUP_WINDOW_MS) {
        return true;
      }
      return item.semanticKey === semanticKey && at - item.createdAt < PROMISE_SEMANTIC_DEDUP_WINDOW_MS;
    });
    if (duplicate) continue;

    const promise: AsukaPromise = {
      id: randomUUID(),
      accountId: context.accountId,
      peerKey: peer.peerKey,
      peerKind: context.peerKind,
      peerId: context.peerId,
      senderId: context.senderId,
      senderName: context.senderName,
      target: context.target,
      sourceMessageId: context.messageId,
      sourceAssistantText: summarizeText(sanitizedAssistantText, 120) ?? sanitizedAssistantText.slice(0, 120),
      originalText: parsed.promiseText,
      promiseText: parsed.promiseText,
      normalizedText: parsed.normalizedText,
      semanticKey,
      triggerKind: parsed.triggerKind,
      triggerPhrase: parsed.triggerPhrase,
      relationNote: parsed.relationNote,
      deliveryKind: parsed.deliveryKind,
      action,
      time,
      createdAt: at,
      state: "logged",
      schedule: parsed.schedule,
      followUpIntent: parsed.followUpIntent,
    };

    state.promises[promise.id] = promise;
    peer.relationship.recentPromiseIds = [promise.id, ...peer.relationship.recentPromiseIds].slice(0, 12);
    touchRelationship(peer, parsed.triggerKind === "hard" ? 6 : 3, parsed.triggerKind === "hard" ? 4 : 2);
    created.push(promise);
  }

  saveState();
  return created;
}

export function markPromiseScheduled(promiseId: string, jobId: string): void {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return;
  setPromiseState(promise, "scheduled");
  promise.cronJobId = jobId;
  promise.lastError = undefined;
  saveState();
}

export function appendPromiseFollowUpJob(promiseId: string, jobId: string): void {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return;
  promise.followUpJobIds = [...(promise.followUpJobIds ?? []), jobId];
  saveState();
}

export function shouldScheduleAmbientForPeer(context: AsukaPeerContext, now = Date.now(), force = false): boolean {
  if (context.peerKind !== "direct") return false;
  const peer = getOrCreatePeer(context);
  const state = loadState();
  const repairCandidates = getRepairCandidates(state, peer.peerKey, now);
  if (force) return true;
  if (repairCandidates.length > 0) return true;
  if (!peer.relationship.lastAssistantMessageAt) return false;
  const disposition = deriveAmbientDisposition(peer, state, now);
  const lastScheduledAt = peer.ambient.lastScheduledAt ?? 0;
  return now - lastScheduledAt >= disposition.firstDelayHours * 60 * 60 * 1000;
}

export function prepareAmbientLifePayload(context: AsukaPeerContext, guardNoReplySince: number): {
  mode: "ambient" | "repair";
  content: string;
  threadId: string;
  stage: number;
  nextThreadId: string;
  nextStage: number;
  mood: "quiet" | "warm" | "restless" | "light";
  attention: "self_thread" | "pull_close" | "miss_you" | "repair";
  presence: string;
  relationshipPhase: AsukaRelationshipPhase;
  firstDelayHours: number;
  secondDelayHours: number;
  promiseId?: string;
  advancePolicy: AsukaSceneAdvancePolicy;
  selfiePrompt?: string;
  selfieCaption?: string;
  sceneVersion?: number;
  sceneSnapshotLabel?: string;
} {
  const peer = getOrCreatePeer(context);
  const state = loadState();
  const disposition = deriveAmbientDisposition(peer, state, guardNoReplySince);
  const scene = peer.scene ?? buildDefaultSceneState(peer, state, guardNoReplySince);
  return {
    mode: "ambient",
    // Let outbound generation derive the actual wording from the latest normal
    // conversation. Keep only a minimal neutral seed here so no old topic line
    // can leak from ambient scheduling into the final message.
    content: disposition.attention === "repair"
      ? "前面那点没接住的话还在我心里。"
      : disposition.attention === "miss_you"
        ? "我安静下来以后还是会先想到你。"
        : disposition.attention === "pull_close"
          ? "我现在更想离你近一点。"
          : "我刚刚又想到你了。",
    threadId: peer.ambient.currentThreadId,
    stage: peer.ambient.currentStage,
    nextThreadId: peer.ambient.currentThreadId,
    nextStage: peer.ambient.currentStage,
    mood: disposition.mood,
    attention: disposition.attention,
    presence: disposition.presence,
    relationshipPhase: disposition.relationshipPhase,
    firstDelayHours: disposition.firstDelayHours,
    secondDelayHours: disposition.secondDelayHours,
    advancePolicy: "advance",
    sceneVersion: scene.version,
    sceneSnapshotLabel: scene.label,
  };
}

export function prepareRepairDelivery(
  context: AsukaPeerContext,
  now = Date.now()
): AsukaRepairDelivery | null {
  const peer = getOrCreatePeer(context);
  const state = loadState();
  const repairCandidate = getRepairCandidates(state, peer.peerKey, now)[0];
  if (!repairCandidate) return null;
  return {
    promiseId: repairCandidate.id,
    peerKey: peer.peerKey,
    content: buildRepairMessage(repairCandidate),
    threadId: peer.ambient.currentThreadId,
    stage: peer.ambient.currentStage,
    advancePolicy: "hold",
    presenceOverride: "你把前面没接住的话补回来以后，心里还是会一直惦记着对方。",
    selfiePrompt: repairCandidate.deliveryKind === "selfie" ? buildRepairSelfiePrompt(repairCandidate) : undefined,
    selfieCaption: repairCandidate.deliveryKind === "selfie" ? "前面答应你的这张，我还是想补给你。" : undefined,
    sceneVersion: peer.scene?.version,
    sceneSnapshotLabel: peer.scene?.label,
  };
}

export function markAmbientScheduled(
  context: AsukaPeerContext,
  jobIds: string[],
  options?: {
    at?: number;
    mood?: "quiet" | "warm" | "restless" | "light";
    attention?: "self_thread" | "pull_close" | "miss_you" | "repair";
    presence?: string;
  }
): void {
  const peer = getOrCreatePeer(context);
  peer.ambient.lastScheduledAt = options?.at ?? Date.now();
  peer.ambient.styleVersion = AMBIENT_STYLE_VERSION;
  peer.ambient.jobIds = [...jobIds];
  if (options?.mood) {
    peer.ambient.currentMood = options.mood;
  }
  if (options?.attention) {
    peer.ambient.currentAttention = options.attention;
  }
  if (options?.presence) {
    peer.ambient.currentPresence = options.presence;
  }
  saveState();
}

export function markAmbientDelivered(peerKey: string, options: {
  content: string;
  threadId?: string;
  stage?: number;
  at?: number;
  advancePolicy?: AsukaSceneAdvancePolicy;
  sceneVersion?: number;
  sceneSnapshotLabel?: string;
}): void {
  const state = loadState();
  const peer = state.peers[peerKey];
  if (!peer) return;
  const at = options.at ?? Date.now();
  const disposition = deriveAmbientDisposition(peer, state, at);
  peer.relationship.lastAssistantMessageAt = at;
  peer.relationship.lastAssistantText = summarizeText(options.content);
  peer.ambient.lastSentAt = at;
  peer.ambient.styleVersion = AMBIENT_STYLE_VERSION;
  peer.ambient.lastTopicPreview = summarizeText(options.content, 80);
  peer.ambient.currentMood = disposition.mood;
  peer.ambient.currentAttention = disposition.attention;
  peer.ambient.currentPresence = disposition.presence;
  touchRelationship(peer, 2, 1);
  saveState();
}

export function markProactiveDelivered(
  peerKey: string,
  options: {
    content: string;
    threadId?: string;
    stage?: number;
    at?: number;
    advancePolicy?: AsukaSceneAdvancePolicy;
    presenceOverride?: string;
    sceneVersion?: number;
    sceneSnapshotLabel?: string;
  }
): void {
  const state = loadState();
  const peer = state.peers[peerKey];
  if (!peer) return;
  const at = options.at ?? Date.now();
  const disposition = deriveAmbientDisposition(peer, state, at);
  peer.relationship.lastAssistantMessageAt = at;
  peer.relationship.lastAssistantText = summarizeText(options.content);
  peer.ambient.lastSentAt = at;
  peer.ambient.styleVersion = AMBIENT_STYLE_VERSION;
  peer.ambient.lastTopicPreview = summarizeText(options.content, 80);
  peer.ambient.currentMood = disposition.mood;
  peer.ambient.currentAttention = disposition.attention;
  peer.ambient.currentPresence = options.presenceOverride ?? disposition.presence;
  refreshProactiveDedupLedger(peer, options.content, at);
  touchRelationship(peer, 2, 1);
  saveState();
}

export interface ProactiveDedupAcquireResult {
  acquired: boolean;
  normalizedText: string;
  lockId?: string;
  reason?: "missing_peer" | "empty_text" | "duplicate" | "locked";
  lastNormalizedText?: string;
  lastDeliveredAt?: number;
}

export function tryAcquireProactiveDedupLock(
  peerKey: string,
  content: string,
  options?: { at?: number; duplicateWindowMs?: number; lockTimeoutMs?: number }
): ProactiveDedupAcquireResult {
  const state = loadState();
  const peer = state.peers[peerKey];
  const now = options?.at ?? Date.now();
  const duplicateWindowMs = options?.duplicateWindowMs ?? PROACTIVE_DEDUP_WINDOW_MS;
  const lockTimeoutMs = options?.lockTimeoutMs ?? PROACTIVE_LOCK_TIMEOUT_MS;
  const normalizedText = normalizeProactiveText(content);
  if (!peer) {
    return { acquired: false, normalizedText, reason: "missing_peer" };
  }
  if (!normalizedText) {
    return { acquired: false, normalizedText, reason: "empty_text" };
  }

  const dedup = getOrCreateProactiveDedupState(peer);
  const lastNormalizedText = dedup.lastNormalizedText;
  const lastDeliveredAt = dedup.lastDeliveredAt;
  if (dedup.lock && now - dedup.lock.acquiredAt >= lockTimeoutMs) {
    delete dedup.lock;
  }
  if (
    lastNormalizedText &&
    lastNormalizedText === normalizedText &&
    typeof lastDeliveredAt === "number" &&
    now - lastDeliveredAt < duplicateWindowMs
  ) {
    return {
      acquired: false,
      normalizedText,
      reason: "duplicate",
      lastNormalizedText,
      lastDeliveredAt,
    };
  }
  if (dedup.lock && dedup.lock.normalizedText === normalizedText) {
    return {
      acquired: false,
      normalizedText,
      reason: "locked",
      lastNormalizedText,
      lastDeliveredAt,
    };
  }

  const lockId = randomUUID();
  dedup.lock = {
    lockId,
    normalizedText,
    acquiredAt: now,
  };
  saveState();
  return {
    acquired: true,
    normalizedText,
    lockId,
    lastNormalizedText,
    lastDeliveredAt,
  };
}

export function releaseProactiveDedupLock(peerKey: string, lockId?: string): void {
  if (!lockId) return;
  const state = loadState();
  const peer = state.peers[peerKey];
  if (!peer?.ambient?.proactiveDedup?.lock) return;
  if (peer.ambient.proactiveDedup.lock.lockId !== lockId) return;
  delete peer.ambient.proactiveDedup.lock;
  saveState();
}

export function shouldSendAmbient(peerKey: string, guardNoReplySince?: number, now = Date.now()): boolean {
  const state = loadState();
  const peer = state.peers[peerKey];
  if (!peer) return false;
  if (guardNoReplySince === undefined) return true;
  return !shouldSkipForRecentUserReply(peer.relationship.lastUserMessageAt, guardNoReplySince, now);
}

export function markPromiseScheduleFailed(promiseId: string, error: string): void {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return;
  if (getPromiseState(promise) === "cancelled" || getPromiseState(promise) === "replied") return;
  setPromiseState(promise, "schedule_failed");
  promise.lastError = error;
  saveState();
}

export function markPromiseDelivered(promiseId: string, options?: { at?: number; isFollowUp?: boolean; content?: string }): void {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return;
  if (getPromiseState(promise) === "cancelled" || getPromiseState(promise) === "replied") return;
  const at = options?.at ?? Date.now();
  setPromiseState(promise, "delivered");
  promise.deliveredAt = at;
  promise.lastError = undefined;
  const peer = state.peers[promise.peerKey];
  if (peer) {
    peer.relationship.lastAssistantMessageAt = at;
    peer.relationship.lastAssistantText = summarizeText(options?.content ?? promise.promiseText);
    touchRelationship(peer, 1, 1);
  }
  if (options?.isFollowUp) {
    promise.followUpCount = (promise.followUpCount ?? 0) + 1;
    promise.lastFollowUpAt = at;
    if (peer) {
      peer.relationship.lastRepairAt = at;
    }
  }
  saveState();
}

export function markPromiseDeliveryFailed(promiseId: string, error: string): void {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return;
  if (getPromiseState(promise) === "cancelled" || getPromiseState(promise) === "replied") return;
  setPromiseState(promise, "delivery_failed");
  promise.lastError = error;
  saveState();
}

export function shouldSendPromiseDelivery(
  promiseId: string,
  options?: {
    guardNoReplySince?: number;
    followUp?: boolean;
    now?: number;
  }
): boolean {
  const state = loadState();
  const promise = state.promises[promiseId];
  if (!promise) return false;
  const promiseState = getPromiseState(promise);
  if (promiseState === "cancelled" || promiseState === "replied") return false;
  if (!options?.followUp) return true;
  if (options.guardNoReplySince === undefined) return true;
  const peer = state.peers[promise.peerKey];
  if (hasUserRepliedAfterGuard(peer?.relationship.lastUserMessageAt, options.guardNoReplySince)) return false;
  return !shouldSkipForRecentUserReply(peer?.relationship.lastUserMessageAt, options.guardNoReplySince, options.now);
}

export function shouldSendPromiseFollowUp(promiseId: string, guardNoReplySince?: number, now = Date.now()): boolean {
  return shouldSendPromiseDelivery(promiseId, {
    guardNoReplySince,
    followUp: true,
    now,
  });
}
