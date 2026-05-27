import { getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import { addCronJobDirectFromArgs, addCronJobLiveFromArgs, execOpenClaw, removeCronJobDirect, removeCronJobLive, shouldAvoidOpenClawCliRecursion } from "./utils/openclaw-command.js";
import { encodePayloadForCron, wrapExactMessageForAgentTurn } from "./utils/payload.js";
import type { AsukaPeerContext } from "./asuka-state.js";
import { getInvalidatedAmbientJobIdsForPeer, markAmbientScheduled, prepareAmbientLifePayload, shouldScheduleAmbientForPeer } from "./asuka-state.js";

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

function plusHours(source: Date, hours: number): Date {
  const next = new Date(source);
  next.setHours(next.getHours() + hours);
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

async function removeInvalidatedAmbientJobs(jobIds: string[], log?: LoggerLike): Promise<void> {
  if (jobIds.length === 0) return;
  const env = getQQBotLocalOpenClawEnv();
  for (const jobId of jobIds) {
    const live = await removeCronJobLive(jobId, { log });
    if ("removed" in live) {
      log?.info?.(`[asuka-ambient] Removed invalidated ambient job: ${jobId}`);
      continue;
    }
    const direct = await removeCronJobDirect(jobId, { env, log });
    if ("removedCount" in direct && direct.removedCount > 0) {
      log?.info?.(`[asuka-ambient] Removed invalidated ambient job through direct store: ${jobId}`);
      continue;
    }
    const error = "error" in direct ? direct.error : live.error;
    log?.warn?.(`[asuka-ambient] Failed to remove invalidated ambient job ${jobId}: ${error}`);
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

  const invalidatedJobIds = getInvalidatedAmbientJobIdsForPeer(context);
  const nextMessage = prepareAmbientLifePayload(context, guardNoReplySince);
  const baseTime = new Date(guardNoReplySince);
  const runAt = plusHours(baseTime, nextMessage.firstDelayHours);
  const jobIds: string[] = [];
  const model = getQQBotLocalPrimaryModel();

  const encoded = wrapExactMessageForAgentTurn(encodePayloadForCron({
    type: "cron_reminder",
    mode: nextMessage.mode,
    content: nextMessage.content,
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
    await removeInvalidatedAmbientJobs(
      invalidatedJobIds.filter((jobId) => !jobIds.includes(jobId)),
      log
    );
  }
  return jobIds;
}
