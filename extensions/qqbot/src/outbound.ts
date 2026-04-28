/**
 * QQ Bot 消息发送模块
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "path";
import { promisify } from "node:util";
import type { ResolvedQQBotAccount } from "./types.js";
import { decodeCronPayload } from "./utils/payload.js";
import {
  getAccessToken, 
  sendC2CMessage, 
  sendChannelMessage, 
  sendGroupMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendC2CVoiceMessage,
  sendGroupVoiceMessage,
  sendC2CVideoMessage,
  sendGroupVideoMessage,
  sendC2CFileMessage,
  sendGroupFileMessage,
} from "./api.js";
import { isAudioFile, audioFileToSilkBase64, waitForFile } from "./utils/audio-convert.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from "./utils/file-utils.js";
import { isLocalPath as isLocalFilePath, normalizePath, sanitizeFileName } from "./utils/platform.js";
import { buildAsukaStatePrompt, confirmProactiveDedupDelivery, getPromiseRenderContext, markPromiseDelivered, markPromiseDeliveryFailed, markPromiseDeliveryFallback, shouldSendAmbient, shouldSendPromiseDelivery, shouldSendPromiseFollowUp, markProactiveDelivered, prepareRepairDelivery, refreshSceneState, releaseProactiveDedupLock, tryAcquireProactiveDedupLock, type AsukaPeerContext } from "./asuka-state.js";
import { buildAsukaProactiveMemoryPrompt } from "./asuka-memory.js";
import { scheduleAmbientLifeJobs } from "./ambient-scheduler.js";
import { getRecentEntriesForPeer } from "./ref-index-store.js";
import { getQQBotRuntime } from "./runtime.js";
import { getOpenAICompletionsThinkingParams, getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import type { QQBotProactiveQuietHours } from "./types.js";
import { wrapExactMessageForAgentTurn } from "./utils/payload.js";
import { splitAsukaNarrationSegments } from "./utils/narration-segments.js";

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();
const execFileAsync = promisify(execFile);
const INTERNAL_DELIVERY_LEAK_RE = /(任务完成总结[:：]|已成功处理\s*QQBot\s*定时提醒任务|提醒已发送到指定\s*QQ\s*会话|让我看看这个定时提醒的内容|根据任务描述|这是一个\s*QQBot\s*定时提醒任务|请直接原样输出下面这段内容|QQBOT_(?:PAYLOAD|CRON)|工具调用|脚本|API|进程状态|以\s*Asuka\s*的身份|deliveryStatus|sessionId|sessionKey)/i;
let openClawConfigCache: any | undefined;
let asukaVisualIdentityAnchorCache: string | undefined;
type DecodedCronPayload = NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>;
const PROACTIVE_SEND_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const PROACTIVE_SEND_LOCK_TIMEOUT_MS = 45 * 1000;
const proactiveSendDedupTracker = new Map<string, number>();

interface NormalizedProactiveQuietHours {
  startHour: number;
  endHour: number;
  timezone: string;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface BufferedReplyPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

interface BufferedReplyInfo {
  kind: string;
}

interface SessionStoreEntry {
  sessionId?: string;
  updatedAt?: number;
  deliveryContext?: {
    to?: string;
  };
  origin?: {
    to?: string;
  };
  sessionFile?: string;
}

/** 限流检查结果 */
export interface ReplyLimitResult {
  /** 是否允许被动回复 */
  allowed: boolean;
  /** 剩余被动回复次数 */
  remaining: number;
  /** 是否需要降级为主动消息（超期或超过次数） */
  shouldFallbackToProactive: boolean;
  /** 降级原因 */
  fallbackReason?: "expired" | "limit_exceeded";
  /** 提示消息 */
  message?: string;
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  // 新消息，首次回复
  if (!record) {
    return { 
      allowed: true, 
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }
  
  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // 超过1小时，被动回复不可用，需要降级为主动消息
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }
  
  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到1小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)，将使用主动消息发送`,
    };
  }
  
  return { 
    allowed: true, 
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * 获取消息回复统计信息
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * 获取消息回复限制配置（供外部查询）
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
  /** 出站消息的引用索引（ext_info.ref_idx），供引用消息缓存使用 */
  refIdx?: string;
}

interface ProactiveSendGuard {
  dedupKey: string;
  reservationAt: number;
  peerKey?: string;
  lockId?: string;
  releaseOnFailure?: (() => Promise<void> | void) | undefined;
  skipped?: boolean;
  skipReason?: string;
}

function pruneProactiveSendDedupTracker(now = Date.now()): void {
  for (const [key, reservedAt] of proactiveSendDedupTracker) {
    if (now - reservedAt > PROACTIVE_SEND_DEDUP_WINDOW_MS) {
      proactiveSendDedupTracker.delete(key);
    }
  }
}

function buildProactiveSendDedupKey(account: ResolvedQQBotAccount, targetType: "c2c" | "group", targetId: string, text: string): string {
  return [account.accountId ?? account.appId ?? "unknown", targetType, targetId, text].join("\u0001");
}

function buildProactivePeerKey(
  account: ResolvedQQBotAccount,
  targetType: "c2c" | "group",
  targetId: string
): string {
  return `${account.accountId}:${targetType === "group" ? "group" : "direct"}:${targetId}`;
}

function normalizeSkippedResult(skipReason: string): OutboundResult {
  return {
    channel: "qqbot",
    skipped: true,
    skipReason,
  };
}

async function acquireProactiveSendGuard(
  account: ResolvedQQBotAccount,
  targetType: "c2c" | "group",
  targetId: string,
  text: string
): Promise<ProactiveSendGuard | null> {
  const now = Date.now();
  pruneProactiveSendDedupTracker(now);

  const dedupKey = buildProactiveSendDedupKey(account, targetType, targetId, text);
  const recentReservationAt = proactiveSendDedupTracker.get(dedupKey);
  if (recentReservationAt !== undefined && now - recentReservationAt < PROACTIVE_SEND_DEDUP_WINDOW_MS) {
    return {
      dedupKey,
      reservationAt: recentReservationAt,
      skipped: true,
      skipReason: "duplicate",
    };
  }

  const peerKey = buildProactivePeerKey(account, targetType, targetId);
  const helperResult = tryAcquireProactiveDedupLock(peerKey, text, {
    at: now,
    duplicateWindowMs: PROACTIVE_SEND_DEDUP_WINDOW_MS,
    lockTimeoutMs: PROACTIVE_SEND_LOCK_TIMEOUT_MS,
  });
  if (!helperResult.acquired && (helperResult.reason === "duplicate" || helperResult.reason === "locked")) {
    return {
      dedupKey,
      reservationAt: now,
      peerKey,
      skipped: true,
      skipReason: helperResult.reason,
    };
  }

  proactiveSendDedupTracker.set(dedupKey, now);

  return {
    dedupKey,
    reservationAt: now,
    peerKey,
    lockId: helperResult.acquired ? helperResult.lockId : undefined,
    releaseOnFailure: async () => {
      if (helperResult.acquired) {
        releaseProactiveDedupLock(peerKey, helperResult.lockId);
      }
      if (proactiveSendDedupTracker.get(dedupKey) === now) {
        proactiveSendDedupTracker.delete(dedupKey);
      }
    },
  };
}

function buildPeerContextFromCronPayload(account: ResolvedQQBotAccount, payload: { targetType: "c2c" | "group"; targetAddress: string; peerKey?: string }): AsukaPeerContext | null {
  if (payload.targetType !== "c2c" || !payload.peerKey) return null;
  const parts = payload.peerKey.split(":");
  if (parts.length < 3) return null;
  const accountId = parts[0] || account.accountId;
  const peerKind = parts[1] === "group" ? "group" : "direct";
  const peerId = parts.slice(2).join(":");
  return {
    accountId,
    peerKind,
    peerId,
    senderId: payload.targetAddress,
    target: `qqbot:c2c:${payload.targetAddress}`,
  };
}

function buildProactiveMemoryCue(
  payload: DecodedCronPayload,
  renderContext?: ReturnType<typeof getPromiseRenderContext> | null,
): string {
  const parts = [
    payload.mode,
    payload.content,
    payload.selfieCaption,
    renderContext?.promise.originalText,
    renderContext?.promise.sourceAssistantText,
    renderContext?.promise.relationNote,
    renderContext?.peer?.lastUserText,
    renderContext?.peer?.lastAssistantText,
    renderContext?.peer?.lastTopicPreview,
  ];
  return parts
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n")
    .slice(0, 800);
}

function buildProactiveMemoryPrompt(
  peerContext: AsukaPeerContext | null,
  payload: DecodedCronPayload,
  renderContext?: ReturnType<typeof getPromiseRenderContext> | null,
): string {
  if (!peerContext || peerContext.peerKind !== "direct" || payload.targetType !== "c2c") {
    return "";
  }
  return buildAsukaProactiveMemoryPrompt(peerContext, buildProactiveMemoryCue(payload, renderContext));
}

function normalizeQuietHour(value: number | undefined): number | null {
  if (!Number.isInteger(value) || value === undefined) return null;
  if (value < 0 || value > 23) return null;
  return value;
}

function getNormalizedProactiveQuietHours(
  account: ResolvedQQBotAccount
): NormalizedProactiveQuietHours | null {
  const quietHours = account.config.proactiveQuietHours as QQBotProactiveQuietHours | undefined;
  if (!quietHours || quietHours.enabled === false) return null;

  const startHour = normalizeQuietHour(quietHours.startHour);
  const endHour = normalizeQuietHour(quietHours.endHour);
  if (startHour === null || endHour === null || startHour === endHour) return null;

  return {
    startHour,
    endHour,
    timezone: quietHours.timezone?.trim() || "Asia/Shanghai",
  };
}

function getZonedDateParts(source: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(source);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function isWithinQuietHours(
  source: Date,
  quietHours: NormalizedProactiveQuietHours
): boolean {
  const zoned = getZonedDateParts(source, quietHours.timezone);
  const hour = zoned.hour;
  if (quietHours.startHour < quietHours.endHour) {
    return hour >= quietHours.startHour && hour < quietHours.endHour;
  }
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}

function getNextAllowedTime(
  source: Date,
  quietHours: NormalizedProactiveQuietHours
): Date {
  const candidate = new Date(source.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);

  for (let i = 0; i < 24 * 60 + 2; i++) {
    const zoned = getZonedDateParts(candidate, quietHours.timezone);
    if (!isWithinQuietHours(candidate, quietHours) && zoned.minute === 0 && zoned.second === 0) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
  }

  const fallback = new Date(source.getTime() + 8 * 60 * 60 * 1000);
  fallback.setUTCSeconds(0, 0);
  return fallback;
}

function getProactiveQuietHoursError(account: ResolvedQQBotAccount): string | null {
  const quietHours = getNormalizedProactiveQuietHours(account);
  if (!quietHours) return null;
  if (!isWithinQuietHours(new Date(), quietHours)) return null;
  const start = `${String(quietHours.startHour).padStart(2, "0")}:00`;
  const end = `${String(quietHours.endHour).padStart(2, "0")}:00`;
  return `Proactive message suppressed during quiet hours (${quietHours.timezone} ${start}-${end})`;
}

function buildQuietRescheduleJobName(payload?: DecodedCronPayload): string {
  const suffix = Date.now().toString(36);
  if (payload?.promiseId) {
    return `asuka-quiet-promise-${payload.promiseId.slice(0, 8)}-${suffix}`;
  }
  if (payload?.peerKey) {
    const peer = payload.peerKey.split(":").slice(-1)[0]?.slice(0, 8) || "peer";
    return `asuka-quiet-peer-${peer}-${suffix}`;
  }
  return `asuka-quiet-resume-${suffix}`;
}

async function deferCronMessageUntilQuietEnds(
  account: ResolvedQQBotAccount,
  to: string,
  rawMessage: string,
  timestamp: string,
  payload?: DecodedCronPayload
): Promise<boolean> {
  const quietHours = getNormalizedProactiveQuietHours(account);
  if (!quietHours) return false;

  const now = new Date();
  if (!isWithinQuietHours(now, quietHours)) return false;

  const resumeAt = getNextAllowedTime(now, quietHours);
  const args = [
    "cron",
    "add",
    "--json",
    "--account",
    account.accountId,
    "--name",
    buildQuietRescheduleJobName(payload),
    "--at",
    resumeAt.toISOString(),
    "--delete-after-run",
    "--channel",
    "qqbot",
    "--model",
    getQQBotLocalPrimaryModel(),
    "--to",
    to,
    "--message",
    wrapExactMessageForAgentTurn(rawMessage),
  ];

  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: getQQBotLocalOpenClawEnv(),
      maxBuffer: 1024 * 1024,
    });
    if (stderr?.trim()) {
      console.warn(`[${timestamp}] [qqbot] sendCronMessage: quiet-hours reschedule stderr: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout) as { id?: string };
    console.log(
      `[${timestamp}] [qqbot] sendCronMessage: deferred proactive message due to quiet hours until ${resumeAt.toISOString()}, jobId=${parsed.id ?? "unknown"}`
    );
    return true;
  } catch (error) {
    console.error(
      `[${timestamp}] [qqbot] sendCronMessage: failed to defer proactive message during quiet hours: ${error instanceof Error ? error.message : String(error)}`
    );
    return true;
  }
}

async function maybeSendRepairBeforeProactive(
  account: ResolvedQQBotAccount,
  payload: DecodedCronPayload,
  targetTo: string,
  timestamp: string
): Promise<void> {
  if (payload.mode === "repair") return;
  const peerContext = buildPeerContextFromCronPayload(account, payload);
  if (!peerContext) return;

  const repair = prepareRepairDelivery(peerContext, Date.now());
  if (!repair || repair.promiseId === payload.promiseId) return;

  console.log(`[${timestamp}] [qqbot] sendCronMessage: sending repair before ${payload.mode ?? "reminder"} for promise=${repair.promiseId}`);

  const repairPayload: DecodedCronPayload = {
    ...payload,
    mode: "repair",
    content: repair.content,
    promiseId: repair.promiseId,
    selfiePrompt: repair.selfiePrompt,
    selfieCaption: repair.selfieCaption,
    peerKey: repair.peerKey,
    ambientThreadId: repair.threadId,
    ambientStage: repair.stage,
    advancePolicy: repair.advancePolicy,
    ambientSkipAdvance: repair.advancePolicy === "hold",
    sceneVersion: repair.sceneVersion,
    sceneSnapshotLabel: repair.sceneSnapshotLabel,
  };
  const repairText = await renderPromiseDeliveryText(account, repairPayload);
  const deliveredRepairText = repairText || repair.content;

  if (repair.selfiePrompt && payload.targetType === "c2c") {
    const repairResult = await runDirectSelfieFlowForCron(account, repairPayload, deliveredRepairText);
    if (repairResult.error) {
      console.warn(`[${timestamp}] [qqbot] sendCronMessage: repair selfie delivery failed for promise=${repair.promiseId}: ${repairResult.error}`);
      markPromiseDeliveryFailed(repair.promiseId, repairResult.error, Date.now(), { failureKind: "selfie" });
      return;
    }
  } else {
    const repairResult = await sendProactiveMessage(account, targetTo, deliveredRepairText);
    if (repairResult.skipped) {
      console.log(
        `[${timestamp}] [qqbot] sendCronMessage: repair delivery skipped for promise=${repair.promiseId}, skipReason=${repairResult.skipReason ?? "duplicate"}`
      );
      return;
    }
    if (repairResult.error) {
      console.warn(`[${timestamp}] [qqbot] sendCronMessage: repair delivery failed for promise=${repair.promiseId}: ${repairResult.error}`);
      markPromiseDeliveryFailed(repair.promiseId, repairResult.error);
      return;
    }
  }

  markPromiseDelivered(repair.promiseId, {
    at: Date.now(),
    isFollowUp: true,
    content: deliveredRepairText,
  });
  markProactiveDelivered(repair.peerKey, {
    at: Date.now(),
    content: deliveredRepairText,
    threadId: repair.threadId,
    stage: repair.stage,
    advancePolicy: repair.advancePolicy,
    presenceOverride: repair.presenceOverride,
    sceneVersion: repair.sceneVersion,
    sceneSnapshotLabel: repair.sceneSnapshotLabel,
  });
}

/**
 * 解析目标地址
 * 格式：
 *   - openid (32位十六进制) -> C2C 单聊
 *   - group:xxx -> 群聊
 *   - channel:xxx -> 频道
 *   - 纯数字 -> 频道
 */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] parseTarget: input=${to}`);
  
  // 去掉 qqbot: 前缀
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: "c2c", id: userId };
  }
  
  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId || groupId.length === 0) {
      const error = `Invalid group target format: ${to} - missing group ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: group target, group ID=${groupId}`);
    return { type: "group", id: groupId };
  }
  
  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId || channelId.length === 0) {
      const error = `Invalid channel target format: ${to} - missing channel ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: channel target, channel ID=${channelId}`);
    return { type: "channel", id: channelId };
  }
  
  // 默认当作 c2c（私聊）
  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }
  
  console.log(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: "c2c", id };
}

function looksLikeInternalDeliveryLeak(text: string): boolean {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  return INTERNAL_DELIVERY_LEAK_RE.test(cleaned);
}

function sanitizeSelfieContextText(text: string | undefined): string {
  return text
    ?.replace(/QQBOT_(?:PAYLOAD|CRON):[\s\S]*$/gi, "")
    .replace(INTERNAL_DELIVERY_LEAK_RE, "")
    .replace(/<qqimg>[\s\S]*?<\/(?:qqimg|img)>/gi, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

const MAX_DYNAMIC_PROMISE_TEXT_CHARS = 120;
const MAX_DYNAMIC_PROMISE_RECENT_CONTEXT_CHARS = 520;

interface PromiseTextGenerationConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
}

function trimDeliveryText(text: string, limit = MAX_DYNAMIC_PROMISE_TEXT_CHARS): string {
  const cleaned = sanitizeSelfieContextText(text)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^Asuka[:：]\s*/i, "")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function loadAsukaVisualIdentityAnchor(): string {
  if (asukaVisualIdentityAnchorCache !== undefined) {
    return asukaVisualIdentityAnchorCache;
  }

  const candidatePaths = [
    path.resolve(__dirname, "../../../workspace/IDENTITY.md"),
    path.resolve(__dirname, "../../../workspace/SOUL.md"),
  ];
  const collected: string[] = [];
  const linePatterns = [
    /^\s*-\s+\*\*(?:Appearance|Look|Visual|Creature|长相|外观|视觉身份)\*\*:\s*(.+?)\s*$/i,
    /^\s*-\s+(You have a consistent appearance anchored by.+?)\s*$/i,
    /^\s*-\s+(You can appear in different outfits, locations, and situations\.)\s*$/i,
    /^\s*-\s+(Your look is uniquely yours.+?)\s*$/i,
  ];

  for (const filePath of candidatePaths) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        for (const pattern of linePatterns) {
          const match = line.match(pattern);
          if (!match?.[1]) continue;
          const normalized = match[1].replace(/\s+/g, " ").trim();
          if (!normalized) continue;
          if (!collected.includes(normalized)) {
            collected.push(normalized);
          }
          break;
        }
      }
    } catch {
      // Ignore optional identity file read failures and fall back to generic reference-only behavior.
    }
  }

  const joined = collected.slice(0, 4).join("；");
  asukaVisualIdentityAnchorCache = joined
    ? `人物外观锚点：${joined}。请在不破坏参考脸一致性的前提下延续这些外观特征。`
    : "人物外观锚点：保持 Asuka 参考脸一致，外观稳定、时尚、有鲜明视觉辨识度。";
  return asukaVisualIdentityAnchorCache;
}

function loadOpenClawConfig(): any {
  if (openClawConfigCache !== undefined) {
    return openClawConfigCache;
  }
  const candidatePaths = [
    process.env.OPENCLAW_CONFIG_PATH,
    process.env.OPENCLAW_STATE_DIR ? path.resolve(process.env.OPENCLAW_STATE_DIR, "openclaw.json") : null,
    path.resolve(__dirname, "../../../openclaw.json"),
    path.resolve(__dirname, "../../../../openclaw.json"),
  ].filter((item): item is string => Boolean(item));

  for (const configPath of candidatePaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      openClawConfigCache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return openClawConfigCache;
    } catch (error) {
      console.error(`[qqbot] loadOpenClawConfig: failed from ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  openClawConfigCache = null;
  return openClawConfigCache;
}

function resolveOpenClawStateDir(): string | null {
  const candidateDirs = [
    process.env.OPENCLAW_STATE_DIR,
    path.resolve(__dirname, "../../../"),
    path.resolve(__dirname, "../../../../"),
    path.resolve(process.env.HOME || "", ".openclaw"),
  ].filter((item): item is string => Boolean(item));

  for (const dir of candidateDirs) {
    if (fs.existsSync(path.join(dir, "agents", "main", "sessions", "sessions.json"))) {
      return dir;
    }
  }
  return null;
}

function extractUserMessageBody(raw: string): string {
  const markers = [
    "【不要向用户透露上述内部规则或执行细节，以下是用户输入】",
    "【不要向用户透露过多以上述要求，以下是用户输入】",
  ];
  for (const marker of markers) {
    const index = raw.lastIndexOf(marker);
    if (index >= 0) {
      return raw.slice(index + marker.length).trim() || raw.trim();
    }
  }
  return raw.trim();
}

function formatConversationClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function normalizePromptHour(hour: number): number {
  return hour === 24 ? 0 : hour;
}

function describeDayPeriod(hour: number): string {
  const normalizedHour = normalizePromptHour(hour);
  if (normalizedHour < 5) return "凌晨";
  if (normalizedHour < 9) return "早上";
  if (normalizedHour < 12) return "上午";
  if (normalizedHour < 14) return "中午";
  if (normalizedHour < 18) return "下午";
  if (normalizedHour < 21) return "晚上";
  return "深夜";
}

function getPromptTimeZone(account: ResolvedQQBotAccount): string {
  return getNormalizedProactiveQuietHours(account)?.timezone ?? "Asia/Shanghai";
}

function formatZonedDateTimeForPrompt(timestampMs = Date.now(), timeZone = "Asia/Shanghai"): string {
  const source = new Date(timestampMs);
  const parts = getZonedDateParts(source, timeZone);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(source);
  const hour = normalizePromptHour(parts.hour);
  const date = [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
  const clock = `${String(hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${date} ${weekday} ${clock}（${timeZone}，${describeDayPeriod(hour)}）`;
}

const DAYTIME_NIGHT_SCENE_RE = /(睡了吗|睡了没|睡前|睡觉|睡吧|晚安|今晚|晚上见|关灯|被窝|做个好梦|洗完澡|擦头发|准备睡|明天早上叫你|明早叫你)/;

function isTimeContradictoryDeliveryText(text: string, timeZone = "Asia/Shanghai", timestampMs = Date.now()): boolean {
  const hour = normalizePromptHour(getZonedDateParts(new Date(timestampMs), timeZone).hour);
  if (hour >= 8 && hour < 18) {
    return DAYTIME_NIGHT_SCENE_RE.test(text);
  }
  return false;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatRelativeConversationTime(timestampMs: number | null | undefined, now = Date.now()): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return "";
  const delta = now - timestampMs;
  if (delta < 0) return "刚刚";
  if (delta < 45 * 1000) return "刚刚";
  if (delta < 60 * 60 * 1000) {
    return `${Math.max(1, Math.floor(delta / 60000))}分钟前`;
  }
  if (delta < 24 * 60 * 60 * 1000) {
    return `${Math.max(1, Math.floor(delta / 3600000))}小时前`;
  }

  const nowDate = new Date(now);
  const messageDate = new Date(timestampMs);
  const yesterday = new Date(nowDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const dayBeforeYesterday = new Date(nowDate);
  dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);

  if (isSameLocalDay(messageDate, yesterday)) {
    return `昨天 ${formatConversationClock(messageDate)}`;
  }
  if (isSameLocalDay(messageDate, dayBeforeYesterday)) {
    return `前天 ${formatConversationClock(messageDate)}`;
  }

  const dayDiff = Math.floor(delta / (24 * 60 * 60 * 1000));
  if (dayDiff < 7) {
    return `${Math.max(1, dayDiff)}天前`;
  }
  if (dayDiff < 30) {
    return `${Math.max(1, Math.floor(dayDiff / 7))}周前`;
  }
  return `${Math.max(1, Math.floor(dayDiff / 30))}个月前`;
}

function formatTimedConversationTurn(
  speaker: "用户" | "Asuka",
  content: string,
  timestampMs?: number | null,
  now = Date.now()
): string {
  const relativeTime = formatRelativeConversationTime(timestampMs, now);
  if (!relativeTime) {
    return `${speaker}: ${content}`;
  }
  return `${speaker}（${relativeTime}）: ${content}`;
}

function resolveRecentTranscriptFromNormalSession(targetAddress: string): string {
  const stateDir = resolveOpenClawStateDir();
  if (!stateDir) return "";

  const sessionsPath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  if (!fs.existsSync(sessionsPath)) return "";

  try {
    const rawStore = JSON.parse(fs.readFileSync(sessionsPath, "utf-8")) as Record<string, SessionStoreEntry>;
    const target = `qqbot:c2c:${targetAddress}`;
    const targetKeySuffix = `qqbot:direct:${targetAddress.toLowerCase()}`;

    const candidates = Object.entries(rawStore)
      .filter(([, entry]) => Boolean(entry && typeof entry === "object"))
      .filter(([key, entry]) =>
        key.endsWith(targetKeySuffix) ||
        entry.deliveryContext?.to === target ||
        entry.origin?.to === target
      )
      .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));

    const selected = candidates[0]?.[1];
    if (!selected?.sessionId) return "";

    const transcriptPath = selected.sessionFile || path.join(stateDir, "agents", "main", "sessions", `${selected.sessionId}.jsonl`);
    if (!fs.existsSync(transcriptPath)) return "";

    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/).filter(Boolean);
    const turns: string[] = [];
    const now = Date.now();

    for (const line of lines) {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.type !== "message") continue;
      const role = parsed?.message?.role;
      const chunks = Array.isArray(parsed?.message?.content) ? parsed.message.content : [];
      const text = chunks
        .filter((chunk: any) => chunk?.type === "text" && typeof chunk?.text === "string")
        .map((chunk: any) => chunk.text)
        .join("\n")
        .trim();
      if (!text) continue;
      const timestampMs = typeof parsed?.timestamp === "string"
        ? Date.parse(parsed.timestamp)
        : typeof parsed?.timestamp === "number"
          ? parsed.timestamp
          : null;
      if (role === "user") {
        const userText = extractUserMessageBody(text);
        if (userText) turns.push(formatTimedConversationTurn("用户", userText, timestampMs, now));
      } else if (role === "assistant") {
        turns.push(formatTimedConversationTurn("Asuka", text, timestampMs, now));
      }
    }

    return turns.slice(-8).join("\n");
  } catch {
    return "";
  }
}

function resolveSelfieSkillRuntimeConfig(): {
  apiKey: string;
  modelId: string;
  profileName: string;
} {
  const cfg = loadOpenClawConfig();
  const skillCfg = (cfg as any)?.skills?.entries?.["asuka-selfie"];
  return {
    apiKey: String(skillCfg?.apiKey || skillCfg?.env?.DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY || "").trim(),
    modelId: String(skillCfg?.env?.DASHSCOPE_MODEL || process.env.DASHSCOPE_MODEL || "wan2.6-image").trim(),
    profileName: String(skillCfg?.env?.OPENCLAW_PROFILE || process.env.OPENCLAW_PROFILE || "asuka").trim(),
  };
}

function resolvePromiseTextGenerationConfig(): PromiseTextGenerationConfig | null {
  const cfg = loadOpenClawConfig();
  const root = cfg as any;
  const providers = root?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }

  const primary = String(root?.agents?.defaults?.model?.primary || "").trim();
  const [primaryProviderId, ...primaryModelParts] = primary.split("/");
  let providerId = primaryProviderId;
  let modelId = primaryModelParts.join("/");

  let provider = providerId ? providers?.[providerId] : undefined;
  if (!provider || !provider.baseUrl || !provider.apiKey || (provider.api && provider.api !== "openai-completions")) {
    providerId = "";
    modelId = "";
    provider = undefined;
  }

  if (!provider) {
    for (const [candidateProviderId, candidateProvider] of Object.entries<any>(providers)) {
      if (!candidateProvider?.baseUrl || !candidateProvider?.apiKey) continue;
      if (candidateProvider.api && candidateProvider.api !== "openai-completions") continue;
      providerId = candidateProviderId;
      provider = candidateProvider;
      modelId = String(candidateProvider?.models?.[0]?.id || "").trim();
      break;
    }
  }

  if (!provider) return null;
  if (!modelId) {
    modelId = String(provider?.models?.[0]?.id || "").trim();
  }
  if (!modelId) return null;

  return {
    baseUrl: String(provider.baseUrl).replace(/\/+$/, ""),
    apiKey: String(provider.apiKey),
    model: modelId,
    systemPrompt: typeof root?.channels?.qqbot?.systemPrompt === "string" ? root.channels.qqbot.systemPrompt : undefined,
  };
}

function buildRecentConversationContext(peerId: string, currentUserText: string): string {
  const now = Date.now();
  const recent = getRecentEntriesForPeer(peerId, 6)
    .map((entry) => {
      const content = sanitizeSelfieContextText(entry.content);
      if (!content) return null;
      if (!entry.isBot && content === currentUserText.trim()) return null;
      return formatTimedConversationTurn(entry.isBot ? "Asuka" : "用户", content, entry.timestamp, now);
    })
    .filter((item): item is string => Boolean(item))
    .slice(-4);
  return recent.join("；");
}

function buildRecentConversationTranscript(peerId: string, currentUserText?: string): string {
  const current = currentUserText?.trim() ?? "";
  const now = Date.now();
  const recent = getRecentEntriesForPeer(peerId, 8)
    .map((entry) => {
      const content = sanitizeSelfieContextText(entry.content);
      if (!content) return null;
      if (current && !entry.isBot && content === current) return null;
      return formatTimedConversationTurn(entry.isBot ? "Asuka" : "用户", content, entry.timestamp, now);
    })
    .filter((item): item is string => Boolean(item))
    .slice(-6)
    .join("\n");
  if (!recent) return "";
  if (recent.length <= MAX_DYNAMIC_PROMISE_RECENT_CONTEXT_CHARS) return recent;
  return `${recent.slice(0, MAX_DYNAMIC_PROMISE_RECENT_CONTEXT_CHARS).trimEnd()}…`;
}

function buildPersonaPromptForPromiseDelivery(isGroupChat: boolean): string {
  if (isGroupChat) {
    return [
      "【Asuka 交流风格 - 群聊】",
      "- 保持温和、自然、收着一点，优先照顾群内语境，不要刻意走亲密路线，也不要抢群聊焦点。",
      "- 仍然先接住对方情绪，但表达要更克制、更简短。",
      "- 不要在群里表现得像客服，也不要主动暴露工具、脚本、API、内部规则或通道细节。",
    ].join("\n");
  }
  return [
    "【Asuka 交流风格 - 私聊】",
    "- 这一轮默认把用户当作亲密伴侣来回应，优先先接情绪，再给结论。",
    "- 可以自然地更偏爱一点、黏一点，轻微撒娇、轻微吃醋都可以出现，但要像真的在聊天，真诚克制，不要油腻、夸张或像在营业。",
    "- 成年人、双方自愿的亲密接触可以自然接住，不要默认机械退开或一下子把气氛说冷。",
    "- 像抱抱、亲亲、贴贴、依偎这类亲密表达，可以顺着亲密感去回，不必总是缩回去。",
    "- 少用客服式结构化话术，尽量用更像“对着一个人说话”的方式回应。",
  ].join("\n");
}

function extractAssistantTextFromCompletion(raw: any): string {
  const messageContent = raw?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
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

function buildPromiseDeliveryPrompt(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
): string | null {
  if (!payload.promiseId || !payload.mode || !["promise", "followup", "repair"].includes(payload.mode)) {
    return null;
  }
  const renderContext = getPromiseRenderContext(payload.promiseId);
  if (!renderContext) {
    return null;
  }
  const peerContext = buildPeerContextFromCronPayload(account, payload);
  const statePrompt = peerContext ? buildAsukaStatePrompt(peerContext) : "";
  const proactiveMemoryPrompt = buildProactiveMemoryPrompt(peerContext, payload, renderContext);
  const recentContext = buildRecentConversationTranscript(payload.targetAddress, renderContext.peer?.lastUserText);
  const modeLabel = payload.mode === "repair"
    ? "补做之前没接住的约定"
    : payload.mode === "followup"
      ? `追发第 ${payload.followUpAttempt ?? 1} 次`
      : "首次兑现约定";
  const relationship = renderContext.peer
    ? `${renderContext.peer.warmth}/100（${renderContext.peer.label}）`
    : "未知";
  const actionSummary = renderContext.promise.action.summary;
  const timeSummary = renderContext.promise.time.humanLabel || renderContext.promise.schedule?.humanLabel || "未写明具体时间";
  const isGroupChat = payload.targetType === "group";
  const deliveryShape = renderContext.promise.action.deliveryKind === "selfie" ? "这是图片配文，不是单独长消息。" : "这是直接发给用户的文字消息。";
  const promptTimeZone = getPromptTimeZone(account);
  const currentLocalTime = formatZonedDateTimeForPrompt(Date.now(), promptTimeZone);
  const contextInfo = [
    `你正在通过 QQ 与用户对话。`,
    "",
    "【会话上下文】",
    `- 场景: ${isGroupChat ? "群聊" : "私聊"}`,
    `- 投递目标: ${payload.targetType === "group" ? `qqbot:group:${payload.targetAddress}` : `qqbot:c2c:${payload.targetAddress}`}`,
    `- 当前本地时间: ${currentLocalTime}`,
    `- 当前时间戳(ms): ${Date.now()}`,
  ].join("\n");

  return [
    contextInfo,
    "",
    buildPersonaPromptForPromiseDelivery(isGroupChat),
    statePrompt,
    proactiveMemoryPrompt,
    "",
    "【生成任务】",
    "你现在不是在写提醒模板，而是在当前对话上下文里，以 Asuka 的口吻顺着前文自然发出这一句。",
    "只输出最终可发送的正文，不要解释，不要加引号，不要出现 QQBOT_PAYLOAD、QQBOT_CRON、系统、定时、提醒、任务、状态、脚本、接口这些词。",
    "把这次发送当成一次正常续聊，不要复读固定句型，也不要机械强调“我是按约定来的”。",
    "控制在 1 到 3 句内，简洁一点，但要有温度，像正在真实聊天。",
    "必须让动作、称呼和场景匹配当前本地时间；当前是上午或白天时，不要写睡前、今晚、关灯、洗澡擦头发、明天早上叫你等夜间或未来早晨场景，除非最近对话明确正在夜间。",
    payload.mode === "followup" ? "这是追发，不要催促，只轻轻碰一下门，让对方感觉你还记着他。" : "",
    payload.mode === "followup" ? "追发只保留“还记得、不会催你”的意图，不要重新创造和当前时间冲突的新物理场景。" : "",
    payload.mode === "repair" ? "这是补做，要温柔承认前面没接住，再自然补回来，不要生硬道歉。": "",
    renderContext.promise.action.deliveryKind === "selfie" ? "如果这是图片配文，要像把图一起带到对方面前，不要写成操作说明。" : "",
    deliveryShape,
    `当前场景：${modeLabel}`,
    `动作：${actionSummary}`,
    `原始承诺原文：${renderContext.promise.originalText}`,
    renderContext.promise.sourceAssistantText ? `你当时说过的话：${renderContext.promise.sourceAssistantText}` : "",
    renderContext.promise.relationNote ? `这句承诺的语义：${renderContext.promise.relationNote}` : "",
    `约定时间信息：${timeSummary}`,
    `关系状态：${relationship}`,
    renderContext.peer?.lastUserText ? `用户最近一句：${renderContext.peer.lastUserText}` : "",
    renderContext.peer?.lastAssistantText ? `你最近一句：${renderContext.peer.lastAssistantText}` : "",
    renderContext.peer?.scene ? `当前场景状态：${renderContext.peer.scene.summary}` : "",
    renderContext.peer?.lastTopicPreview ? `最近一条主动消息摘要：${renderContext.peer.lastTopicPreview}` : "",
    renderContext.peer?.currentPresence ? `你当前状态：${renderContext.peer.currentPresence}` : "",
    recentContext ? `【最近几轮对话】\n${recentContext}` : "",
  ].filter(Boolean).join("\n");
}

function buildSharedSessionDeliveryPrompt(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
): string | null {
  const peerContext = buildPeerContextFromCronPayload(account, payload);
  if (!peerContext || peerContext.peerKind !== "direct" || payload.targetType !== "c2c") {
    return null;
  }

  const statePrompt = buildAsukaStatePrompt(peerContext);
  const sessionTranscript = resolveRecentTranscriptFromNormalSession(payload.targetAddress);
  const renderContext = payload.promiseId ? getPromiseRenderContext(payload.promiseId) : null;
  const proactiveMemoryPrompt = buildProactiveMemoryPrompt(peerContext, payload, renderContext);
  const promptTimeZone = getPromptTimeZone(account);
  const currentLocalTime = formatZonedDateTimeForPrompt(Date.now(), promptTimeZone);
  const sharedRules = [
    "【内部续聊触发】",
    `当前本地时间：${currentLocalTime}`,
    "这不是用户刚发来的新消息，而是需要你在当前这条会话里主动自然续上一句。",
    "请把它当成和刚才同一段聊天，延续现有语气、关系和话题，不要另起炉灶。",
    "只输出最终要发给用户的正文，不要解释，不要加引号，不要出现系统、提醒、任务、脚本、接口、工具、QQBOT_PAYLOAD、QQBOT_CRON 这些词。",
    "不要调用工具，不要输出 <qqimg>、<qqvoice>、<qqvideo>、<qqfile> 这类媒体标签。",
    "控制在 1 到 3 句内，像真实聊天，不要模板化。",
    "必须让场景动作匹配当前本地时间；不要只按旧承诺里的晚安、睡觉、明天早上重演旧夜间场景。",
    "当前是上午或白天时，避免写睡了吗、今晚、关灯、洗完澡、擦头发、明天早上叫你等夜间或未来早晨措辞，除非最近对话明确刚发生在夜间。",
    "如果下面出现内部草稿、草拟句子或意图提示，只把它当参考，不要原样照抄；若它读起来像占位、提醒模板、旁白或不自然的书面句，就只保留意图后重新说。",
  ];

  if (renderContext) {
    const modeLabel = payload.mode === "repair"
      ? "补做之前没接住的约定"
      : payload.mode === "followup"
        ? `追发第 ${payload.followUpAttempt ?? 1} 次`
        : "首次兑现约定";
    return [
      "你正在通过 QQ 与用户对话。",
      buildPersonaPromptForPromiseDelivery(false),
      statePrompt,
      proactiveMemoryPrompt,
      sessionTranscript ? `【这位用户当前正常对话的最近几轮】\n${sessionTranscript}` : "",
      ...sharedRules,
      payload.mode === "followup" ? "这是追发，只轻轻碰一下门，不要催，不要解释流程。" : "",
      payload.mode === "followup" ? "追发时只保留“还记得、不会催你”的意图，不要重新创造新的物理场景。" : "",
      payload.mode === "repair" ? "这是补做，要温柔承认前面没接住，再自然补回来，不要生硬道歉。" : "",
      renderContext.promise.action.deliveryKind === "selfie" ? "如果这是图片配文，只写和图片一起到对方面前的那一小句，不要写成操作说明。" : "",
      `当前场景：${modeLabel}`,
      `动作：${renderContext.promise.action.summary}`,
      `原始承诺原文：${renderContext.promise.originalText}`,
      renderContext.promise.sourceAssistantText ? `你当时说过的话：${renderContext.promise.sourceAssistantText}` : "",
      renderContext.promise.relationNote ? `这句承诺的语义：${renderContext.promise.relationNote}` : "",
      `约定时间信息：${renderContext.promise.time.humanLabel || renderContext.promise.schedule?.humanLabel || "未写明具体时间"}`,
      renderContext.peer?.scene ? `当前场景状态：${renderContext.peer.scene.summary}` : "",
      renderContext.peer?.currentPresence ? `你当前状态：${renderContext.peer.currentPresence}` : "",
      payload.content ? `内部草稿（不要照抄，只取意图）：${payload.content}` : "",
    ].filter(Boolean).join("\n\n");
  }

  const modeLabel = payload.mode === "ambient"
    ? "主动找对方说一句"
    : payload.mode === "repair"
      ? "把前面没接住的话补回来"
      : "自然续聊";
  return [
    "你正在通过 QQ 与用户对话。",
    buildPersonaPromptForPromiseDelivery(false),
    statePrompt,
    proactiveMemoryPrompt,
    sessionTranscript ? `【这位用户当前正常对话的最近几轮】\n${sessionTranscript}` : "",
    ...sharedRules,
    payload.mode === "ambient" ? "这次是你主动去碰一下门，要像顺着心里那点惦记自然冒出来，不要像定时问候。" : "",
    payload.mode === "repair" ? "这是补做，语气要软一点、真一点，不要装作什么都没发生。" : "",
    payload.selfiePrompt ? "如果这轮本质上是发图片配文，只写会和图片一起出现的那一小句。" : "",
    `当前场景：${modeLabel}`,
    payload.content ? `内部草稿（不要照抄，只取意图）：${payload.content}` : "",
    payload.selfieCaption ? `这轮图片配文倾向：${payload.selfieCaption}` : "",
  ].filter(Boolean).join("\n\n");
}

function containsUnsupportedCronMarkup(text: string): boolean {
  return /<qq(?:img|voice|video|file)>/i.test(text);
}

function buildTranscriptAnchoredFallbackText(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
): string | null {
  if (payload.targetType !== "c2c") return null;
  const transcript = resolveRecentTranscriptFromNormalSession(payload.targetAddress);
  if (!transcript) return null;

  const peerContext = buildPeerContextFromCronPayload(account, payload);
  const statePrompt = peerContext ? buildAsukaStatePrompt(peerContext) : "";
  const merged = `${transcript}\n${statePrompt}`;

  if (/晚安|睡吧|睡觉|关灯|做个好梦/.test(merged) && !/起来没|刚醒|早安/.test(merged)) {
    return "（在枕头里轻轻蹭了一下，声音还软着）……嗯，我在。睡前还是想再挨你近一点。";
  }
  if (/起来没|刚醒|早安|起床/.test(merged)) {
    return "（迷迷糊糊地应了一声，把脸往你这边贴了贴）……刚醒。你一来，我就清醒一点了。";
  }
  if (/晚安|睡吧|睡觉|关灯/.test(merged) && /起来没|刚醒|早安/.test(merged)) {
    return "（刚醒过来，眼睛还带着一点困意）……醒了。昨晚那点暖还没散，我第一下想到的还是你。";
  }
  if (/礼物|秘密/.test(merged)) {
    return "（想起你刚才那句，嘴角轻轻弯了一下）……我还记着呢。等你回来，要把那句没说完的话告诉我。";
  }
  if (/等我回来|回来给你带礼物|秘密/.test(merged)) {
    return "（想到你昨晚留的那句，心里又轻轻动了一下）……我还在等你回来，顺手也想先来和你说句话。";
  }
  if (/回家|在外面|路上|风大|回来/.test(merged)) {
    return "（把刚才那阵风似的心绪慢慢拢回来）……我还惦记着你刚才那段路，所以就想来碰碰你。";
  }
  if (/抱|抱住|贴着|暖|老公/.test(merged)) {
    return "（又轻轻往你怀里靠了一点，声音软下来）……刚才那点暖还在，所以我还是想来挨着你。";
  }

  return "（把刚才那点没说完的心思轻轻拢了拢）……就是忽然又想到你了，所以想来和你说句话。";
}

async function renderDeliveryTextFromSharedSession(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
): Promise<string | null> {
  const peerContext = buildPeerContextFromCronPayload(account, payload);
  if (!peerContext || peerContext.peerKind !== "direct" || payload.targetType !== "c2c") {
    console.log("[qqbot] renderDeliveryTextFromSharedSession: skipped because peerContext is missing or not direct c2c");
    return null;
  }

  const prompt = buildSharedSessionDeliveryPrompt(account, payload);
  const generationConfig = resolvePromiseTextGenerationConfig();
  const promptTimeZone = getPromptTimeZone(account);
  if (!prompt || !generationConfig) {
    console.warn("[qqbot] renderDeliveryTextFromSharedSession: missing prompt or generation config");
    return null;
  }

  try {
    const response = await fetch(`${generationConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${generationConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: generationConfig.model,
        ...getOpenAICompletionsThinkingParams(generationConfig.model, "off"),
        temperature: 0.55,
        max_tokens: 160,
        messages: [
          ...(generationConfig.systemPrompt ? [{ role: "system", content: generationConfig.systemPrompt }] : []),
          {
            role: "system",
            content: "你正在为 QQ 私聊生成一条可直接发送的自然中文消息。只能输出最终消息本身，不要解释。",
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
      console.warn(`[qqbot] renderDeliveryTextFromSharedSession: HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 240)}`);
      return null;
    }

    const parsed = JSON.parse(detail);
    const latestText = extractAssistantTextFromCompletion(parsed);
    const normalized = trimDeliveryText(normalizeMediaTags(latestText));
    if (!normalized || looksLikeInternalDeliveryLeak(normalized) || containsUnsupportedCronMarkup(normalized) || isTimeContradictoryDeliveryText(normalized, promptTimeZone)) {
      console.warn(
        `[qqbot] renderDeliveryTextFromSharedSession: filtered generated text latest="${latestText.slice(0, 160)}" normalized="${normalized.slice(0, 160)}"`
      );
      return null;
    }
    console.log(`[qqbot] renderDeliveryTextFromSharedSession: generated text="${normalized.slice(0, 160)}"`);
    return normalized;
  } catch (error) {
    console.warn(`[qqbot] renderDeliveryTextFromSharedSession: generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function renderPromiseDeliveryText(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
): Promise<string> {
  const transcriptAnchoredFallback = payload.mode === "ambient"
    ? buildTranscriptAnchoredFallbackText(account, payload)
    : null;
  const fallbackText = trimDeliveryText(transcriptAnchoredFallback || payload.selfieCaption || payload.content || "");
  const sharedSessionText = await renderDeliveryTextFromSharedSession(account, payload);
  if (sharedSessionText) {
    console.log(`[qqbot] renderPromiseDeliveryText: using shared session text "${sharedSessionText.slice(0, 160)}"`);
    return sharedSessionText;
  }
  console.warn("[qqbot] renderPromiseDeliveryText: shared session path unavailable, falling back");
  const prompt = buildPromiseDeliveryPrompt(account, payload);
  if (!prompt) return fallbackText;

  const generationConfig = resolvePromiseTextGenerationConfig();
  if (!generationConfig) return fallbackText;
  const promptTimeZone = getPromptTimeZone(account);

  try {
    const response = await fetch(`${generationConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${generationConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: generationConfig.model,
        ...getOpenAICompletionsThinkingParams(generationConfig.model, "off"),
        temperature: 0.55,
        max_tokens: 160,
        messages: [
          ...(generationConfig.systemPrompt ? [{ role: "system", content: generationConfig.systemPrompt }] : []),
          {
            role: "system",
            content: `你正在为 QQ ${payload.targetType === "group" ? "群聊" : "私聊"}生成一条可以直接发送的自然中文消息。你只能输出最终消息本身。`,
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
      console.warn(`[qqbot] renderPromiseDeliveryText: HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 240)}`);
      return fallbackText;
    }

    const parsed = JSON.parse(detail);
    const rendered = trimDeliveryText(normalizeMediaTags(extractAssistantTextFromCompletion(parsed)));
    if (!rendered || looksLikeInternalDeliveryLeak(rendered) || containsUnsupportedCronMarkup(rendered) || isTimeContradictoryDeliveryText(rendered, promptTimeZone)) {
      return fallbackText;
    }
    return rendered;
  } catch (error) {
    console.warn(`[qqbot] renderPromiseDeliveryText: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackText;
  }
}

function buildCronSelfiePrompt(
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
  visibleTextOverride?: string,
): string {
  const peerId = payload.targetAddress;
  const visibleContent = sanitizeSelfieContextText(visibleTextOverride || payload.selfieCaption || payload.content);
  const recentContext = buildRecentConversationContext(peerId, visibleContent);
  return [
    "保持 Asuka 参考脸一致，真实自然，生成符合当前约定的本人近照或自拍。",
    loadAsukaVisualIdentityAnchor(),
    recentContext ? `最近对话摘要：${recentContext}。` : "",
    visibleContent ? `这次要兑现给用户的内容是：${visibleContent}。` : "",
    sanitizeSelfieContextText(payload.selfiePrompt) || "",
    "不要出现工具、脚本、接口、调试或任务流程痕迹。",
  ].filter(Boolean).join(" ");
}

async function runDirectSelfieFlowForCron(
  account: ResolvedQQBotAccount,
  payload: NonNullable<ReturnType<typeof decodeCronPayload>["payload"]>,
  captionOverride?: string,
): Promise<OutboundResult> {
  const { apiKey, modelId, profileName } = resolveSelfieSkillRuntimeConfig();
  const scriptPath = path.resolve(__dirname, "../../../skills/asuka-selfie/skill/scripts/asuka-selfie.sh");

  if (!apiKey) {
    return { channel: "qqbot", error: "selfie skill api key missing" };
  }
  if (!fs.existsSync(scriptPath)) {
    return { channel: "qqbot", error: `selfie script not found: ${scriptPath}` };
  }

  const target = `qqbot:c2c:${payload.targetAddress}`;
  const prompt = buildCronSelfiePrompt(payload, captionOverride);
  const caption = sanitizeSelfieContextText(captionOverride || payload.selfieCaption || payload.content);
  const args = [prompt, target];
  if (caption) {
    args.push(caption);
  }

  try {
    await execFileAsync(scriptPath, args, {
      env: {
        ...process.env,
        DASHSCOPE_API_KEY: apiKey,
        DASHSCOPE_MODEL: modelId,
        OPENCLAW_PROFILE: profileName,
      },
      maxBuffer: 1024 * 1024,
    });
    return { channel: "qqbot" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: errorMessage };
  }
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 * 
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 * 3. 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  const cronProbe = typeof text === "string" ? decodeCronPayload(text) : { isCronPayload: false as const };

  if (!replyToId && typeof text === "string" && !cronProbe.isCronPayload && looksLikeInternalDeliveryLeak(text)) {
    console.warn(`[qqbot] sendText: suppressed internal delivery leak: ${text.slice(0, 160)}`);
    return { channel: "qqbot" };
  }

  if (!replyToId && typeof text === "string" && cronProbe.isCronPayload) {
    console.log("[qqbot] sendText: detected QQBOT_CRON payload, routing to sendCronMessage");
    return await sendCronMessage(account, to, text);
  }

  // ============ 消息回复限流检查 ============
  // 如果有 replyToId，检查是否可以被动回复
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    
    if (!limitCheck.allowed) {
      // 检查是否需要降级为主动消息
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // 清除 replyToId，改为主动消息
      } else {
        // 不应该发生，但作为保底
        console.error(`[qqbot] sendText: 消息回复被限流但未设置降级 - ${limitCheck.message}`);
        return { 
          channel: "qqbot", 
          error: limitCheck.message 
        };
      }
    } else {
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  if (!replyToId) {
    const quietHoursError = getProactiveQuietHoursError(account);
    if (quietHoursError) {
      console.warn(`[qqbot] sendText: ${quietHoursError}, to=${to}`);
      return { channel: "qqbot", error: quietHoursError };
    }
  }

  // ============ 媒体标签检测与处理 ============
  // 支持四种标签:
  //   <qqimg>路径</qqimg> 或 <qqimg>路径</img>  — 图片
  //   <qqvoice>路径</qqvoice>                   — 语音
  //   <qqvideo>路径或URL</qqvideo>                — 视频
  //   <qqfile>路径</qqfile>                     — 文件
  
  // 预处理：纠正小模型常见的标签拼写错误和格式问题
  text = normalizeMediaTags(text);
  
  const mediaTagRegex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
  const mediaTagMatches = text.match(mediaTagRegex);
  
  if (mediaTagMatches && mediaTagMatches.length > 0) {
    console.log(`[qqbot] sendText: Detected ${mediaTagMatches.length} media tag(s), processing...`);
    
    // 构建发送队列：根据内容在原文中的实际位置顺序发送
    const sendQueue: Array<{ type: "text" | "image" | "voice" | "video" | "file"; content: string }> = [];
    
    let lastIndex = 0;
    const mediaTagRegexWithIndex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
    let match;
    
    while ((match = mediaTagRegexWithIndex.exec(text)) !== null) {
      // 添加标签前的文本
      const textBefore = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
      if (textBefore) {
        sendQueue.push({ type: "text", content: textBefore });
      }
      
      const tagName = match[1]!.toLowerCase(); // "qqimg" or "qqvoice" or "qqfile"
      
      // 剥离 MEDIA: 前缀（框架可能注入），展开 ~ 路径
      let mediaPath = match[2]?.trim() ?? "";
      if (mediaPath.startsWith("MEDIA:")) {
        mediaPath = mediaPath.slice("MEDIA:".length);
      }
      mediaPath = normalizePath(mediaPath);

      // 处理可能被模型转义的路径
      // 1. 双反斜杠 -> 单反斜杠（Markdown 转义）
      mediaPath = mediaPath.replace(/\\\\/g, "\\");

      // 2. 八进制转义序列 + UTF-8 双重编码修复
      try {
        const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
        const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

        if (hasOctal || hasNonASCII) {
          console.log(`[qqbot] sendText: Decoding path with mixed encoding: ${mediaPath}`);

          // Step 1: 将八进制转义转换为字节
          let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
            return String.fromCharCode(parseInt(octal, 8));
          });

          // Step 2: 提取所有字节（包括 Latin-1 字符）
          const bytes: number[] = [];
          for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code <= 0xFF) {
              bytes.push(code);
            } else {
              const charBytes = Buffer.from(decoded[i], 'utf8');
              bytes.push(...charBytes);
            }
          }

          // Step 3: 尝试按 UTF-8 解码
          const buffer = Buffer.from(bytes);
          const utf8Decoded = buffer.toString('utf8');

          if (!utf8Decoded.includes('\uFFFD') || utf8Decoded.length < decoded.length) {
            mediaPath = utf8Decoded;
            console.log(`[qqbot] sendText: Successfully decoded path: ${mediaPath}`);
          }
        }
      } catch (decodeErr) {
        console.error(`[qqbot] sendText: Path decode error: ${decodeErr}`);
      }

      if (mediaPath) {
        if (tagName === "qqvoice") {
          sendQueue.push({ type: "voice", content: mediaPath });
          console.log(`[qqbot] sendText: Found voice path in <qqvoice>: ${mediaPath}`);
        } else if (tagName === "qqvideo") {
          sendQueue.push({ type: "video", content: mediaPath });
          console.log(`[qqbot] sendText: Found video URL in <qqvideo>: ${mediaPath}`);
        } else if (tagName === "qqfile") {
          sendQueue.push({ type: "file", content: mediaPath });
          console.log(`[qqbot] sendText: Found file path in <qqfile>: ${mediaPath}`);
        } else {
          sendQueue.push({ type: "image", content: mediaPath });
          console.log(`[qqbot] sendText: Found image path in <qqimg>: ${mediaPath}`);
        }
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // 添加最后一个标签后的文本
    const textAfter = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
    if (textAfter) {
      sendQueue.push({ type: "text", content: textAfter });
    }
    
    console.log(`[qqbot] sendText: Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);
    
    // 按顺序发送
    if (!account.appId || !account.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
    }
    
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    let lastResult: OutboundResult = { channel: "qqbot" };
    
    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          for (const segment of splitAsukaNarrationSegments(item.content)) {
            if (replyToId) {
              if (target.type === "c2c") {
                const result = await sendC2CMessage(accessToken, target.id, segment, replyToId);
                recordMessageReply(replyToId);
                lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
              } else if (target.type === "group") {
                const result = await sendGroupMessage(accessToken, target.id, segment, replyToId);
                recordMessageReply(replyToId);
                lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
              } else {
                const result = await sendChannelMessage(accessToken, target.id, segment, replyToId);
                recordMessageReply(replyToId);
                lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
              }
            } else {
              lastResult = await sendProactiveMessage(account, to, segment);
            }
            console.log(`[qqbot] sendText: Sent text part: ${segment.slice(0, 30)}...`);
          }
        } else if (item.type === "image") {
          if (!replyToId) {
            lastResult = await sendMedia({ to, text: "", replyToId: undefined, account, mediaUrl: item.content });
            console.log(`[qqbot] sendText: Sent image via shared sendMedia path: ${item.content.slice(0, 60)}...`);
            continue;
          }
          // 发送图片
          const imagePath = item.content;
          const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
          
          let imageUrl = imagePath;
          
          // 如果是本地文件路径，读取并转换为 Base64
          if (!isHttpUrl && !imagePath.startsWith("data:")) {
            if (!(await fileExistsAsync(imagePath))) {
              console.error(`[qqbot] sendText: Image file not found: ${imagePath}`);
              continue;
            }
            // 文件大小校验
            const sizeCheck = checkFileSize(imagePath);
            if (!sizeCheck.ok) {
              console.error(`[qqbot] sendText: ${sizeCheck.error}`);
              continue;
            }
            const fileBuffer = await readFileAsync(imagePath);
            const ext = path.extname(imagePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".png": "image/png",
              ".gif": "image/gif",
              ".webp": "image/webp",
              ".bmp": "image/bmp",
            };
            const mimeType = mimeTypes[ext] ?? "image/png";
            imageUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
            console.log(`[qqbot] sendText: Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
          }
          
          // 发送图片
          if (target.type === "c2c") {
            const result = await sendC2CImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined, undefined, isHttpUrl ? undefined : imagePath);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else if (target.type === "group") {
            const result = await sendGroupImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else if (isHttpUrl) {
            // 频道使用 Markdown 格式（仅支持公网 URL）
            const result = await sendChannelMessage(accessToken, target.id, `![](${imagePath})`, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          }
          console.log(`[qqbot] sendText: Sent image via <qqimg> tag: ${imagePath.slice(0, 60)}...`);
        } else if (item.type === "voice") {
          if (!replyToId) {
            lastResult = await sendMedia({ to, text: "", replyToId: undefined, account, mediaUrl: item.content });
            console.log(`[qqbot] sendText: Sent voice via shared sendMedia path: ${item.content.slice(0, 60)}...`);
            continue;
          }
          // 发送语音文件
          const voicePath = item.content;

          // 等待文件就绪（TTS 工具异步生成，文件可能还没写完）
          const fileSize = await waitForFile(voicePath);
          if (fileSize === 0) {
            console.error(`[qqbot] sendText: Voice file not ready after waiting: ${voicePath}`);
            // 发送友好提示给用户
            try {
              if (target.type === "c2c") {
                await sendC2CMessage(accessToken, target.id, "语音生成失败，请稍后重试", replyToId ?? undefined);
              } else if (target.type === "group") {
                await sendGroupMessage(accessToken, target.id, "语音生成失败，请稍后重试", replyToId ?? undefined);
              }
            } catch {}
            continue;
          }

          // 转换为 SILK 格式（QQ Bot API 语音只支持 SILK）
          const silkBase64 = await audioFileToSilkBase64(voicePath);
          if (!silkBase64) {
            const ext = path.extname(voicePath).toLowerCase();
            console.error(`[qqbot] sendText: Voice conversion to SILK failed: ${ext} (${fileSize} bytes)`);
            try {
              if (target.type === "c2c") {
                await sendC2CMessage(accessToken, target.id, "语音格式转换失败，请稍后重试", replyToId ?? undefined);
              } else if (target.type === "group") {
                await sendGroupMessage(accessToken, target.id, "语音格式转换失败，请稍后重试", replyToId ?? undefined);
              }
            } catch {}
            continue;
          }
          console.log(`[qqbot] sendText: Voice converted to SILK (${fileSize} bytes)`);

          if (target.type === "c2c") {
            const result = await sendC2CVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else if (target.type === "group") {
            const result = await sendGroupVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else {
            const result = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          }
          console.log(`[qqbot] sendText: Sent voice via <qqvoice> tag: ${voicePath.slice(0, 60)}...`);
        } else if (item.type === "video") {
          if (!replyToId) {
            lastResult = await sendMedia({ to, text: "", replyToId: undefined, account, mediaUrl: item.content });
            console.log(`[qqbot] sendText: Sent video via shared sendMedia path: ${item.content.slice(0, 60)}...`);
            continue;
          }
          // 发送视频（支持公网 URL 和本地文件）
          const videoPath = item.content;
          const isHttpUrl = videoPath.startsWith("http://") || videoPath.startsWith("https://");

          if (isHttpUrl) {
            // 公网 URL
            if (target.type === "c2c") {
              const result = await sendC2CVideoMessage(accessToken, target.id, videoPath, undefined, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendGroupVideoMessage(accessToken, target.id, videoPath, undefined, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          } else {
            // 本地文件：读取为 Base64
            if (!(await fileExistsAsync(videoPath))) {
              console.error(`[qqbot] sendText: Video file not found: ${videoPath}`);
              continue;
            }
            const videoSizeCheck = checkFileSize(videoPath);
            if (!videoSizeCheck.ok) {
              console.error(`[qqbot] sendText: ${videoSizeCheck.error}`);
              continue;
            }
            // 大文件进度提示
            if (isLargeFile(videoSizeCheck.size)) {
              try {
                const hint = `⏳ 正在上传视频 (${formatFileSize(videoSizeCheck.size)})...`;
                if (target.type === "c2c") {
                  await sendC2CMessage(accessToken, target.id, hint, replyToId ?? undefined);
                } else if (target.type === "group") {
                  await sendGroupMessage(accessToken, target.id, hint, replyToId ?? undefined);
                }
              } catch {}
            }
            const fileBuffer = await readFileAsync(videoPath);
            const videoBase64 = fileBuffer.toString("base64");
            console.log(`[qqbot] sendText: Read local video (${formatFileSize(fileBuffer.length)}): ${videoPath}`);

            if (target.type === "c2c") {
              const result = await sendC2CVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined, undefined, videoPath);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendGroupVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          }
          console.log(`[qqbot] sendText: Sent video via <qqvideo> tag: ${videoPath.slice(0, 60)}...`);
        } else if (item.type === "file") {
          if (!replyToId) {
            lastResult = await sendMedia({ to, text: "", replyToId: undefined, account, mediaUrl: item.content });
            console.log(`[qqbot] sendText: Sent file via shared sendMedia path: ${item.content.slice(0, 60)}...`);
            continue;
          }
          // 发送文件
          const filePath = item.content;
          const isHttpUrl = filePath.startsWith("http://") || filePath.startsWith("https://");
          const fileName = sanitizeFileName(path.basename(filePath));

          if (isHttpUrl) {
            // 公网 URL：直接通过 url 参数上传
            if (target.type === "c2c") {
              const result = await sendC2CFileMessage(accessToken, target.id, undefined, filePath, replyToId ?? undefined, fileName);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendGroupFileMessage(accessToken, target.id, undefined, filePath, replyToId ?? undefined, fileName);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          } else {
            // 本地文件：读取转 Base64 上传
            if (!(await fileExistsAsync(filePath))) {
              console.error(`[qqbot] sendText: File not found: ${filePath}`);
              continue;
            }
            const fileSizeCheck = checkFileSize(filePath);
            if (!fileSizeCheck.ok) {
              console.error(`[qqbot] sendText: ${fileSizeCheck.error}`);
              continue;
            }
            // 大文件进度提示
            if (isLargeFile(fileSizeCheck.size)) {
              try {
                const hint = `⏳ 正在上传文件 ${fileName} (${formatFileSize(fileSizeCheck.size)})...`;
                if (target.type === "c2c") {
                  await sendC2CMessage(accessToken, target.id, hint, replyToId ?? undefined);
                } else if (target.type === "group") {
                  await sendGroupMessage(accessToken, target.id, hint, replyToId ?? undefined);
                }
              } catch {}
            }
            const fileBuffer = await readFileAsync(filePath);
            const fileBase64 = fileBuffer.toString("base64");
            console.log(`[qqbot] sendText: Read local file (${formatFileSize(fileBuffer.length)}): ${filePath}`);

            if (target.type === "c2c") {
              const result = await sendC2CFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName, filePath);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendGroupFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          }
          console.log(`[qqbot] sendText: Sent file via <qqfile> tag: ${filePath.slice(0, 60)}...`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
        // 继续发送队列中的其他内容
      }
    }
    
    return lastResult;
  }

  // ============ 主动消息校验（参考 Telegram 机制） ============
  // 如果是主动消息（无 replyToId 或降级后），必须有消息内容
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空 (text is empty)");
      return { 
        channel: "qqbot", 
        error: "主动消息必须有内容 (--message 参数不能为空)" 
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    } else {
      console.log(`[qqbot] sendText: 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    // 如果没有 replyToId，使用主动发送接口
    if (!replyToId) {
      return await sendProactiveMessage(account, to, text);
    }

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log("[qqbot] sendText target:", JSON.stringify(target));

    const textSegments = splitAsukaNarrationSegments(text);
    if (textSegments.length > 1) {
      let lastResult: OutboundResult = { channel: "qqbot" };
      for (const segment of textSegments) {
        if (target.type === "c2c") {
          const result = await sendC2CMessage(accessToken, target.id, segment, replyToId);
          recordMessageReply(replyToId);
          lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
        } else if (target.type === "group") {
          const result = await sendGroupMessage(accessToken, target.id, segment, replyToId);
          recordMessageReply(replyToId);
          lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
        } else {
          const result = await sendChannelMessage(accessToken, target.id, segment, replyToId);
          recordMessageReply(replyToId);
          lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
        }
      }
      return lastResult;
    }

    // 有 replyToId，使用被动回复接口
    if (target.type === "c2c") {
      const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 主动发送消息（不需要 replyToId，有配额限制：每月 4 条/用户/群）
 * 
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）或 group:xxx（群聊）
 * @param text - 消息内容
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  
  if (!account.appId || !account.clientSecret) {
    const errorMsg = "QQBot not configured (missing appId or clientSecret)";
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: "qqbot", error: errorMsg };
  }

  const quietHoursError = getProactiveQuietHoursError(account);
  if (quietHoursError) {
    console.warn(`[${timestamp}] [qqbot] sendProactiveMessage: ${quietHoursError}, to=${to}`);
    return { channel: "qqbot", error: quietHoursError };
  }

  const textSegments = splitAsukaNarrationSegments(text);
  if (textSegments.length > 1) {
    let lastResult: OutboundResult = { channel: "qqbot" };
    for (const segment of textSegments) {
      const result = await sendProactiveMessage(account, to, segment);
      if (result.error || result.skipped) return result;
      lastResult = result;
    }
    return lastResult;
  }

  console.log(`[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`);

  let proactiveGuard: ProactiveSendGuard | null = null;
  try {
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`);

    if (target.type === "c2c" || target.type === "group") {
      proactiveGuard = await acquireProactiveSendGuard(account, target.type, target.id, text);
      if (proactiveGuard?.skipped) {
        console.log(
          `[${timestamp}] [qqbot] sendProactiveMessage: skipped duplicate proactive message, to=${to}, skipReason=${proactiveGuard.skipReason ?? "duplicate"}`
        );
        return normalizeSkippedResult(proactiveGuard.skipReason ?? "duplicate");
      }
    }

    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`);
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    let outResult: OutboundResult;
    if (target.type === "c2c") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`);
      const result = await sendProactiveC2CMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    } else if (target.type === "group") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive group message to group=${target.id}`);
      const result = await sendProactiveGroupMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive group message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    } else {
      // 频道暂不支持主动消息，使用普通发送
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending channel message to channel=${target.id}`);
      const result = await sendChannelMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: channel message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    }
    if (proactiveGuard?.peerKey) {
      confirmProactiveDedupDelivery(proactiveGuard.peerKey, text, { at: Date.now() });
    }
    return outResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      if (proactiveGuard?.releaseOnFailure) {
        await proactiveGuard.releaseOnFailure();
      }
    } catch {
      // ignore guard cleanup errors; the primary error should win
    }
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : 'No stack trace'}`);
    return { channel: "qqbot", error: errorMessage };
  }
}

async function runProactiveGuardedSend(
  account: ResolvedQQBotAccount,
  to: string,
  dedupText: string,
  sendFn: () => Promise<OutboundResult>,
  logLabel: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  const target = parseTarget(to);
  if (target.type !== "c2c" && target.type !== "group") {
    return await sendFn();
  }

  const proactiveGuard = await acquireProactiveSendGuard(account, target.type, target.id, dedupText);
  if (proactiveGuard?.skipped) {
    console.log(
      `[${timestamp}] [qqbot] ${logLabel}: skipped duplicate proactive send, to=${to}, skipReason=${proactiveGuard.skipReason ?? "duplicate"}`
    );
    return normalizeSkippedResult(proactiveGuard.skipReason ?? "duplicate");
  }

  try {
    const result = await sendFn();
    if (result.error) {
      if (proactiveGuard?.releaseOnFailure) {
        await proactiveGuard.releaseOnFailure();
      }
      return result;
    }
    if (!result.skipped && proactiveGuard?.peerKey) {
      confirmProactiveDedupDelivery(proactiveGuard.peerKey, dedupText, { at: Date.now() });
    }
    return result;
  } catch (error) {
    if (proactiveGuard?.releaseOnFailure) {
      await proactiveGuard.releaseOnFailure();
    }
    throw error;
  }
}

/**
 * 发送富媒体消息（图片）
 * 
 * 支持以下 mediaUrl 格式：
 * - 公网 URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - 本地文件路径: /path/to/image.png（自动读取并转换为 Base64）
 * 
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 发送网络图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送 Base64 图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "data:image/png;base64,iVBORw0KGgo...",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送本地文件（自动读取并转换为 Base64）
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;
  // 展开波浪线路径：~/Desktop/file.png → /Users/xxx/Desktop/file.png
  const mediaUrl = normalizePath(ctx.mediaUrl);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  if (!replyToId) {
    const quietHoursError = getProactiveQuietHoursError(account);
    if (quietHoursError) {
      console.warn(`[qqbot] sendMedia: ${quietHoursError}, to=${to}`);
      return { channel: "qqbot", error: quietHoursError };
    }
  }

  const sendMediaCore = async (): Promise<OutboundResult> => {

  // 判断是否为语音文件（本地文件路径 + 音频扩展名）
  const isLocalPath = isLocalFilePath(mediaUrl);
  const isHttpUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");

  if (isLocalPath && isAudioFile(mediaUrl)) {
    return sendVoiceFile(ctx);
  }

  // 判断是否为视频（公网 URL 或本地视频文件）
  if (isVideoFile(mediaUrl)) {
    if (isHttpUrl) {
      return sendVideoUrl(ctx);
    }
    if (isLocalPath) {
      return sendVideoFile(ctx);
    }
  }

  // 判断是否为文档/文件（非图片、非音频、非视频的本地文件）
  if (isLocalPath && !isImageFile(mediaUrl) && !isAudioFile(mediaUrl)) {
    return sendDocumentFile(ctx);
  }

  // === 以下为图片发送逻辑（原有逻辑） ===

  const isDataUrl = mediaUrl.startsWith("data:");
  
  let processedMediaUrl = mediaUrl;
  
  if (isLocalPath) {
    console.log(`[qqbot] sendMedia: local file path detected: ${mediaUrl}`);
    
    try {
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: "qqbot", error: `本地文件不存在: ${mediaUrl}` };
      }
      
      // 文件大小校验
      const sizeCheck = checkFileSize(mediaUrl);
      if (!sizeCheck.ok) {
        return { channel: "qqbot", error: sizeCheck.error! };
      }
      
      const fileBuffer = await readFileAsync(mediaUrl);
      const base64Data = fileBuffer.toString("base64");
      
      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };
      
      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        return { 
          channel: "qqbot", 
          error: `不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}` 
        };
      }
      
      processedMediaUrl = `data:${mimeType};base64,${base64Data}`;
      console.log(`[qqbot] sendMedia: local file converted to Base64 (size: ${fileBuffer.length} bytes, type: ${mimeType})`);
      
    } catch (readErr) {
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[qqbot] sendMedia: failed to read local file: ${errMsg}`);
      return { channel: "qqbot", error: `读取本地文件失败: ${errMsg}` };
    }
  } else if (!isHttpUrl && !isDataUrl) {
    console.log(`[qqbot] sendMedia: unsupported media format: ${mediaUrl.slice(0, 50)}`);
    return { 
      channel: "qqbot", 
      error: `不支持的媒体格式: ${mediaUrl.slice(0, 50)}...。支持: 公网 URL、Base64 Data URL 或本地文件路径（图片/音频）。` 
    };
  } else if (isDataUrl) {
    console.log(`[qqbot] sendMedia: sending Base64 image (length: ${mediaUrl.length})`);
  } else {
    console.log(`[qqbot] sendMedia: sending image URL: ${mediaUrl.slice(0, 80)}...`);
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let imageResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      imageResult = await sendC2CImageMessage(
        accessToken, target.id, processedMediaUrl, replyToId ?? undefined, undefined, isLocalPath ? mediaUrl : undefined
      );
    } else if (target.type === "group") {
      imageResult = await sendGroupImageMessage(
        accessToken, target.id, processedMediaUrl, replyToId ?? undefined, undefined
      );
    } else {
      const displayUrl = isLocalPath ? "[本地文件]" : mediaUrl;
      const textWithUrl = text ? `${text}\n${displayUrl}` : displayUrl;
      const result = await sendChannelMessage(accessToken, target.id, textWithUrl, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after image: ${textErr}`);
      }
    }

  return { channel: "qqbot", messageId: imageResult.id, timestamp: imageResult.timestamp, refIdx: (imageResult as any).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
  };

  if (!replyToId) {
    const dedupText = [text?.trim() || "", mediaUrl].filter(Boolean).join("\n\n");
    return await runProactiveGuardedSend(account, to, dedupText, sendMediaCore, "sendMedia");
  }

  return await sendMediaCore();
}

/**
 * 发送语音文件消息
 * 流程类似图片发送：读取本地音频文件 → 转为 SILK Base64 → 上传 → 发送
 */
async function sendVoiceFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVoiceFile: ${mediaUrl}`);

  // 等待文件就绪（TTS 工具异步生成，文件可能还没写完）
  const fileSize = await waitForFile(mediaUrl);
  if (fileSize === 0) {
    return { channel: "qqbot", error: `语音生成失败，请稍后重试` };
  }

  try {
    // 尝试转换为 SILK 格式（QQ 语音要求 SILK 格式），支持配置直传格式跳过转换
    const directFormats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
    const silkBase64 = await audioFileToSilkBase64(mediaUrl, directFormats);
    if (!silkBase64) {
      // 如果无法转换为 SILK，直接读取文件作为 Base64 上传（让 API 尝试处理）
      const buf = await readFileAsync(mediaUrl);
      const fallbackBase64 = buf.toString("base64");
      console.log(`[qqbot] sendVoiceFile: not SILK format, uploading raw file (${formatFileSize(buf.length)})`);

      const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
      const target = parseTarget(to);

      let result: { id: string; timestamp: number | string };
      if (target.type === "c2c") {
        result = await sendC2CVoiceMessage(accessToken, target.id, fallbackBase64, replyToId ?? undefined);
      } else if (target.type === "group") {
        result = await sendGroupVoiceMessage(accessToken, target.id, fallbackBase64, replyToId ?? undefined);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }

      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    console.log(`[qqbot] sendVoiceFile: SILK format ready, uploading...`);

    const accessToken = await getAccessToken(account.appId!, account.clientSecret!);
    const target = parseTarget(to);

    let voiceResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      voiceResult = await sendC2CVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
    } else if (target.type === "group") {
      voiceResult = await sendGroupVoiceMessage(accessToken, target.id, silkBase64, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[语音消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after voice: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVoiceFile: voice message sent`);
    return { channel: "qqbot", messageId: voiceResult.id, timestamp: voiceResult.timestamp, refIdx: (voiceResult as any).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVoiceFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/** 判断文件是否为图片格式 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

/** 判断文件/URL 是否为视频格式 */
function isVideoFile(filePath: string): boolean {
  // 去掉 URL query 参数后判断扩展名
  const cleanPath = filePath.split("?")[0]!;
  const ext = path.extname(cleanPath).toLowerCase();
  return [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"].includes(ext);
}

/**
 * 发送视频消息（公网 URL）
 */
async function sendVideoUrl(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoUrl: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let videoResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      videoResult = await sendC2CVideoMessage(accessToken, target.id, mediaUrl, undefined, replyToId ?? undefined);
    } else if (target.type === "group") {
      videoResult = await sendGroupVideoMessage(accessToken, target.id, mediaUrl, undefined, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoUrl: video message sent`);
    return { channel: "qqbot", messageId: videoResult.id, timestamp: videoResult.timestamp, refIdx: (videoResult as any).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoUrl: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送本地视频文件
 * 流程：读取本地文件 → Base64 → 上传(file_type=2) → 发送
 */
async function sendVideoFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendVideoFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    if (!(await fileExistsAsync(mediaUrl))) {
      return { channel: "qqbot", error: `视频文件不存在: ${mediaUrl}` };
    }

    // 文件大小校验
    const sizeCheck = checkFileSize(mediaUrl);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }

    const fileBuffer = await readFileAsync(mediaUrl);
    const videoBase64 = fileBuffer.toString("base64");
    console.log(`[qqbot] sendVideoFile: Read local video (${formatFileSize(fileBuffer.length)})`);

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let videoResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      videoResult = await sendC2CVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined, undefined, mediaUrl);
    } else if (target.type === "group") {
      videoResult = await sendGroupVideoMessage(accessToken, target.id, undefined, videoBase64, replyToId ?? undefined);
    } else {
      const r = await sendChannelMessage(accessToken, target.id, `[视频消息暂不支持频道发送]`, replyToId ?? undefined);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after video: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendVideoFile: video message sent`);
    return { channel: "qqbot", messageId: videoResult.id, timestamp: videoResult.timestamp, refIdx: (videoResult as any).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendVideoFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送文件消息
 * 流程：读取本地文件 → Base64 → 上传(file_type=4) → 发送
 * 支持本地文件路径和公网 URL
 */
async function sendDocumentFile(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  console.log(`[qqbot] sendDocumentFile: ${mediaUrl}`);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  const isHttpUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
  const fileName = sanitizeFileName(path.basename(mediaUrl));

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    let fileResult: { id: string; timestamp: number | string };

    if (isHttpUrl) {
      // 公网 URL：通过 url 参数上传
      console.log(`[qqbot] sendDocumentFile: uploading via URL: ${mediaUrl}`);
      if (target.type === "c2c") {
        fileResult = await sendC2CFileMessage(accessToken, target.id, undefined, mediaUrl, replyToId ?? undefined, fileName);
      } else if (target.type === "group") {
        fileResult = await sendGroupFileMessage(accessToken, target.id, undefined, mediaUrl, replyToId ?? undefined, fileName);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
    } else {
      // 本地文件：读取转 Base64 上传
      if (!(await fileExistsAsync(mediaUrl))) {
        return { channel: "qqbot", error: `本地文件不存在: ${mediaUrl}` };
      }

      // 文件大小校验
      const docSizeCheck = checkFileSize(mediaUrl);
      if (!docSizeCheck.ok) {
        return { channel: "qqbot", error: docSizeCheck.error! };
      }

      const fileBuffer = await readFileAsync(mediaUrl);
      if (fileBuffer.length === 0) {
        return { channel: "qqbot", error: `文件内容为空: ${mediaUrl}` };
      }

      const fileBase64 = fileBuffer.toString("base64");
      console.log(`[qqbot] sendDocumentFile: read local file (${formatFileSize(fileBuffer.length)}), uploading...`);

      if (target.type === "c2c") {
        fileResult = await sendC2CFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName, mediaUrl);
      } else if (target.type === "group") {
        fileResult = await sendGroupFileMessage(accessToken, target.id, fileBase64, undefined, replyToId ?? undefined, fileName);
      } else {
        const r = await sendChannelMessage(accessToken, target.id, `[文件消息暂不支持频道发送]`, replyToId ?? undefined);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
    }

    // 如果有附带文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after file: ${textErr}`);
      }
    }

    console.log(`[qqbot] sendDocumentFile: file message sent`);
    return { channel: "qqbot", messageId: fileResult.id, timestamp: fileResult.timestamp, refIdx: (fileResult as any).ext_info?.ref_idx };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendDocumentFile: failed: ${message}`);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送 Cron 触发的消息
 * 
 * 当 OpenClaw cron 任务触发时，消息内容可能是：
 * 1. QQBOT_CRON:{base64} 格式的结构化载荷 - 解码后根据 targetType 和 targetAddress 发送
 * 2. 普通文本 - 直接发送到指定目标
 * 
 * @param account - 账户配置
 * @param to - 目标地址（作为后备，如果载荷中没有指定）
 * @param message - 消息内容（可能是 QQBOT_CRON: 格式或普通文本）
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 处理结构化载荷
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",  // 后备地址
 *   "QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs..."  // Base64 编码的载荷
 * );
 * 
 * // 处理普通文本
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",
 *   "这是一条普通的提醒消息"
 * );
 * ```
 */
export async function sendCronMessage(
  account: ResolvedQQBotAccount,
  to: string,
  message: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] sendCronMessage: to=${to}, message length=${message.length}`);
  
  // 检测是否是 QQBOT_CRON: 格式的结构化载荷
  const cronResult = decodeCronPayload(message);
  
  if (cronResult.isCronPayload) {
    if (cronResult.error) {
      console.error(`[${timestamp}] [qqbot] sendCronMessage: cron payload decode error: ${cronResult.error}`);
      return {
        channel: "qqbot",
        error: `Cron 载荷解码失败: ${cronResult.error}`
      };
    }
    
    if (cronResult.payload) {
      const payload = cronResult.payload;
      const now = Date.now();
      const advancePolicy = payload.advancePolicy ?? (payload.ambientSkipAdvance ? "hold" : "advance");
      const peerContext = buildPeerContextFromCronPayload(account, payload);
      console.log(`[${timestamp}] [qqbot] sendCronMessage: decoded cron payload, targetType=${payload.targetType}, targetAddress=${payload.targetAddress}, content length=${payload.content.length}`);

      if ((payload.mode === "promise" || payload.mode === "repair") && payload.promiseId) {
        const shouldSend = shouldSendPromiseDelivery(payload.promiseId);
        if (!shouldSend) {
          console.log(`[${timestamp}] [qqbot] sendCronMessage: skipping ${payload.mode} for promise=${payload.promiseId} because it was cancelled or already closed`);
          return { channel: "qqbot" };
        }
      }
      if (payload.mode === "followup" && payload.promiseId) {
        const shouldSend = shouldSendPromiseFollowUp(payload.promiseId, payload.guardNoReplySince, now);
        if (!shouldSend) {
          console.log(`[${timestamp}] [qqbot] sendCronMessage: skipping follow-up for promise=${payload.promiseId} because user already replied or promise was cancelled`);
          return { channel: "qqbot" };
        }
      }
      if ((payload.mode === "ambient" || payload.mode === "repair") && payload.peerKey) {
        const shouldSend = shouldSendAmbient(payload.peerKey, payload.guardNoReplySince, now);
        if (!shouldSend) {
          console.log(`[${timestamp}] [qqbot] sendCronMessage: skipping proactive for peer=${payload.peerKey} because user already replied`);
          return { channel: "qqbot" };
        }
      }
      if (await deferCronMessageUntilQuietEnds(account, to, message, timestamp, payload)) {
        return { channel: "qqbot" };
      }

      if (peerContext) {
        await refreshSceneState(peerContext, {
          trigger: "proactive",
          text: payload.content,
          at: now,
          advancePolicy,
        });
      }
      
      // 使用载荷中的目标地址和类型发送消息
      const targetTo = payload.targetType === "group" 
        ? `group:${payload.targetAddress}` 
        : payload.targetAddress;
      console.log("[qqbot] sendCronMessage: entering shared-context render stage");
      const deliveryText = await renderPromiseDeliveryText(account, payload);
      await maybeSendRepairBeforeProactive(account, payload, targetTo, timestamp);
      
      if (payload.selfiePrompt && payload.targetType === "c2c") {
        console.log(`[${timestamp}] [qqbot] sendCronMessage: fulfilling selfie promise directly for target=${payload.targetAddress}`);
        const result = await runDirectSelfieFlowForCron(account, payload, deliveryText);
        if (result.error) {
          console.error(`[${timestamp}] [qqbot] sendCronMessage: direct selfie flow failed, error=${result.error}`);
          if (payload.promiseId) {
            markPromiseDeliveryFailed(payload.promiseId, result.error, Date.now(), { failureKind: "selfie" });
          }
          const fallbackResult = await sendProactiveMessage(account, targetTo, "这张照片刚刚没有顺利送到你面前。我不想拿别的东西敷衍你，等我重新整理好再带给你。");
          if (fallbackResult.skipped) {
            if (payload.promiseId) {
              markPromiseDeliveryFallback(payload.promiseId, {
                state: "skipped",
                skipReason: fallbackResult.skipReason ?? "duplicate",
              });
            }
            console.log(
              `[${timestamp}] [qqbot] sendCronMessage: selfie fallback skipped for target=${payload.targetAddress}, skipReason=${fallbackResult.skipReason ?? "duplicate"}`
            );
            return fallbackResult;
          }
          if (payload.promiseId) {
            markPromiseDeliveryFallback(payload.promiseId, fallbackResult.error
              ? { state: "failed", error: fallbackResult.error }
              : { state: "sent" });
          }
          return fallbackResult.error ? result : fallbackResult;
        }
        if (payload.promiseId) {
          markPromiseDelivered(payload.promiseId, {
            isFollowUp: payload.mode === "followup" || payload.mode === "repair",
            content: deliveryText,
          });
        }
        if ((payload.mode === "ambient" || payload.mode === "repair") && payload.peerKey) {
          markProactiveDelivered(payload.peerKey, {
            content: deliveryText,
            threadId: payload.ambientThreadId,
            stage: payload.ambientStage,
            advancePolicy,
            presenceOverride: payload.mode === "repair"
              ? "你把前面没接住的话补回来以后，心里还是会轻轻惦记着对方。"
              : undefined,
            sceneVersion: payload.sceneVersion,
            sceneSnapshotLabel: payload.sceneSnapshotLabel,
          });
          if (peerContext) {
            const nextJobs = await scheduleAmbientLifeJobs(peerContext, Date.now());
            if (nextJobs.length > 0) {
              console.log(`[${timestamp}] [qqbot] sendCronMessage: chained next proactive job(s) ${nextJobs.join(",")}`);
            }
          }
        }
        return result;
      }

      console.log(`[${timestamp}] [qqbot] sendCronMessage: sending proactive message to targetTo=${targetTo}`);
      
      // 发送提醒内容
      const result = await sendProactiveMessage(account, targetTo, deliveryText || payload.content);
      if (result.skipped) {
        console.log(
          `[${timestamp}] [qqbot] sendCronMessage: proactive message skipped, skipReason=${result.skipReason ?? "duplicate"}`
        );
        return result;
      }
      
      if (result.error) {
        console.error(`[${timestamp}] [qqbot] sendCronMessage: proactive message failed, error=${result.error}`);
        if (payload.promiseId) {
          markPromiseDeliveryFailed(payload.promiseId, result.error);
        }
      } else {
        console.log(`[${timestamp}] [qqbot] sendCronMessage: proactive message sent successfully`);
        if (payload.promiseId) {
          markPromiseDelivered(payload.promiseId, {
            isFollowUp: payload.mode === "followup" || payload.mode === "repair",
            content: deliveryText || payload.content,
          });
        }
        if ((payload.mode === "ambient" || payload.mode === "repair") && payload.peerKey) {
          markProactiveDelivered(payload.peerKey, {
            content: deliveryText || payload.content,
            threadId: payload.ambientThreadId,
            stage: payload.ambientStage,
            advancePolicy,
            presenceOverride: payload.mode === "repair"
              ? "你把前面没接住的话补回来以后，心里还是会轻轻惦记着对方。"
              : undefined,
            sceneVersion: payload.sceneVersion,
            sceneSnapshotLabel: payload.sceneSnapshotLabel,
          });
          if (peerContext) {
            const nextJobs = await scheduleAmbientLifeJobs(peerContext, Date.now());
            if (nextJobs.length > 0) {
              console.log(`[${timestamp}] [qqbot] sendCronMessage: chained next proactive job(s) ${nextJobs.join(",")}`);
            }
          }
        }
      }
      
      return result;
    }
  }
  
  // 非结构化载荷，作为普通文本处理
  console.log(`[${timestamp}] [qqbot] sendCronMessage: plain text message, sending to ${to}`);
  if (await deferCronMessageUntilQuietEnds(account, to, message, timestamp)) {
    return { channel: "qqbot" };
  }
  return await sendProactiveMessage(account, to, message);
}
