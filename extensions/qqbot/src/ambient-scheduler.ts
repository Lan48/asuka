import { getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import { addCronJobDirectFromArgs, addCronJobLiveFromArgs, execOpenClaw, shouldAvoidOpenClawCliRecursion } from "./utils/openclaw-command.js";
import { encodePayloadForCron, wrapExactMessageForAgentTurn } from "./utils/payload.js";
import type { AsukaPeerContext } from "./asuka-state.js";
import { markAmbientScheduled, planNextProactiveTiming, prepareAmbientLifePayload, recordProactiveBeatPlanned, shouldScheduleAmbientForPeer } from "./asuka-state.js";

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

const PROACTIVE_BEAT_PREFIX = "PROACTIVE_BEAT:";

function plusMinutes(source: Date, minutes: number): Date {
  const next = new Date(source);
  next.setMinutes(next.getMinutes() + minutes);
  return next;
}

async function addAmbientJob(args: string[], log?: LoggerLike): Promise<string | null> {
  const env = getQQBotLocalOpenClawEnv();
  const live = await addCronJobLiveFromArgs(args, { log });
  if ("jobId" in live) {
    log?.info?.(`[asuka-ambient] Added ambient job through live CronService: ${live.jobId}`);
    return live.jobId;
  }
  if (shouldAvoidOpenClawCliRecursion(env)) {
    log?.warn?.(`[asuka-ambient] Live CronService add unavailable inside gateway, falling back to direct cron store: ${live.error}`);
  }
  if (!env.OPENCLAW_WRAPPER?.trim()) {
    const direct = await addCronJobDirectFromArgs(args, { env, log });
    if ("jobId" in direct) {
      log?.info?.(`[asuka-ambient] Added ambient job through direct cron store: ${direct.jobId}`);
      return direct.jobId;
    }
    log?.warn?.(`[asuka-ambient] Direct cron store add failed before CLI fallback: ${direct.error}`);
    if (shouldAvoidOpenClawCliRecursion(env)) {
      log?.warn?.(`[asuka-ambient] Skipped openclaw CLI fallback inside gateway to avoid recursive gateway lifecycle changes: ${direct.error}`);
      return null;
    }
  }

  try {
    const { stdout, stderr } = await execOpenClaw(args, {
      env,
      maxBuffer: 1024 * 1024,
    });
    if (stderr?.trim()) {
      log?.warn?.(`[asuka-ambient] cron add stderr: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout) as { id?: string };
    return parsed.id ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn?.(`[asuka-ambient] Failed to add ambient job through CLI: ${message}`);
    const direct = await addCronJobDirectFromArgs(args, { env, log });
    if ("jobId" in direct) {
      log?.info?.(`[asuka-ambient] Added ambient job through direct cron store fallback: ${direct.jobId}`);
      return direct.jobId;
    }
    log?.warn?.(`[asuka-ambient] Direct cron store fallback failed: ${direct.error}`);
    return null;
  }
}

export async function scheduleAmbientLifeJobs(
  context: AsukaPeerContext,
  guardNoReplySince: number,
  log?: LoggerLike,
  force = false
): Promise<string[]> {
  if (!shouldScheduleAmbientForPeer(context, guardNoReplySince, force)) {
    return [];
  }

  const nextMessage = prepareAmbientLifePayload(context, guardNoReplySince);
  const baseTime = new Date(guardNoReplySince);
  const runAt = plusMinutes(baseTime, 10);
  const jobIds: string[] = [];
  const model = getQQBotLocalPrimaryModel();

  const encoded = wrapExactMessageForAgentTurn(encodePayloadForCron({
    type: "cron_reminder",
    mode: "ambient_plan",
    content: "根据最新上下文判断下一条主动消息的发送时间；不要生成给用户的正文。",
    targetType: "c2c",
    targetAddress: context.senderId,
    peerKey: `${context.accountId}:${context.peerKind}:${context.peerId}`,
    guardNoReplySince,
    ambientThreadId: nextMessage.threadId,
    ambientStage: nextMessage.stage,
    advancePolicy: nextMessage.advancePolicy,
    ambientSkipAdvance: nextMessage.advancePolicy === "hold",
    promiseId: nextMessage.promiseId,
    selfiePrompt: nextMessage.selfiePrompt,
    selfieCaption: nextMessage.selfieCaption,
    sceneVersion: nextMessage.sceneVersion,
    sceneSnapshotLabel: nextMessage.sceneSnapshotLabel,
  }));
  const args = [
    "cron",
    "add",
    "--json",
    "--account",
    context.accountId,
    "--name",
    `asuka-${nextMessage.mode}-${context.senderId.slice(0, 8)}-${Date.now()}`,
    "--at",
    runAt.toISOString(),
    "--delete-after-run",
    "--channel",
    "qqbot",
    "--model",
    model,
    "--to",
    context.target,
    "--message",
    encoded,
  ];
  const jobId = await addAmbientJob(args, log);
  if (jobId) {
    jobIds.push(jobId);
  }

  if (jobIds.length > 0) {
    markAmbientScheduled(context, jobIds, {
      at: guardNoReplySince,
      mood: nextMessage.mood,
      attention: nextMessage.attention,
      presence: nextMessage.presence,
    });
  }
  return jobIds;
}

export async function schedulePlannedAmbientDelivery(
  context: AsukaPeerContext,
  guardNoReplySince: number,
  log?: LoggerLike,
): Promise<{ jobIds: string[]; reason?: string; retryAfterMs?: number }> {
  const plan = await planNextProactiveTiming(context, guardNoReplySince);
  if (!plan) {
    log?.warn?.(`[asuka-ambient] Proactive timing planner unavailable for peer=${context.peerId}`);
    return { jobIds: [], reason: "ambient_timing_plan_unavailable", retryAfterMs: 10 * 60 * 1000 };
  }

  const nextMessage = prepareAmbientLifePayload(context, guardNoReplySince);
  const runAt = plusMinutes(new Date(), plan.delayMinutes);
  const jobIds: string[] = [];
  const model = getQQBotLocalPrimaryModel();
  const content = `${PROACTIVE_BEAT_PREFIX}${JSON.stringify({
    intent: plan.intent,
    topicAnchor: plan.topicAnchor,
    sceneBeat: plan.sceneBeat,
    noveltyGoal: plan.noveltyGoal,
    blockedAnchors: plan.blockedAnchors,
    reason: plan.reason,
  })}`;
  const encoded = wrapExactMessageForAgentTurn(encodePayloadForCron({
    type: "cron_reminder",
    mode: nextMessage.mode,
    content,
    targetType: "c2c",
    targetAddress: context.senderId,
    peerKey: `${context.accountId}:${context.peerKind}:${context.peerId}`,
    guardNoReplySince,
    ambientThreadId: nextMessage.threadId,
    ambientStage: nextMessage.stage,
    advancePolicy: nextMessage.advancePolicy,
    ambientSkipAdvance: nextMessage.advancePolicy === "hold",
    promiseId: nextMessage.promiseId,
    selfiePrompt: nextMessage.selfiePrompt,
    selfieCaption: nextMessage.selfieCaption,
    sceneVersion: nextMessage.sceneVersion,
    sceneSnapshotLabel: nextMessage.sceneSnapshotLabel,
  }));
  const args = [
    "cron",
    "add",
    "--json",
    "--account",
    context.accountId,
    "--name",
    `asuka-${nextMessage.mode}-delivery-${context.senderId.slice(0, 8)}-${Date.now()}`,
    "--at",
    runAt.toISOString(),
    "--delete-after-run",
    "--channel",
    "qqbot",
    "--model",
    model,
    "--to",
    context.target,
    "--message",
    encoded,
  ];
  const jobId = await addAmbientJob(args, log);
  if (jobId) jobIds.push(jobId);
  if (jobIds.length > 0) {
    recordProactiveBeatPlanned(context, plan, {
      plannedAt: Date.now(),
      deliveryDueAt: runAt.getTime(),
    });
    markAmbientScheduled(context, jobIds, {
      at: Date.now(),
      mood: nextMessage.mood,
      attention: nextMessage.attention,
      presence: nextMessage.presence,
    });
    log?.info?.(`[asuka-ambient] Planned next proactive delivery in ${plan.delayMinutes} minute(s), source=${plan.source}, reason=${plan.reason}`);
  }
  return { jobIds };
}
