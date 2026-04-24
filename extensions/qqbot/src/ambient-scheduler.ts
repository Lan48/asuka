import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import { encodePayloadForCron, wrapExactMessageForAgentTurn } from "./utils/payload.js";
import type { AsukaPeerContext } from "./asuka-state.js";
import { markAmbientScheduled, prepareAmbientLifePayload, shouldScheduleAmbientForPeer } from "./asuka-state.js";

const execFileAsync = promisify(execFile);

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
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: getQQBotLocalOpenClawEnv(),
      maxBuffer: 1024 * 1024,
    });
    if (stderr?.trim()) {
      log?.warn?.(`[asuka-ambient] cron add stderr: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout) as { id?: string };
    return parsed.id ?? null;
  } catch (error) {
    log?.warn?.(`[asuka-ambient] Failed to add ambient job: ${error instanceof Error ? error.message : String(error)}`);
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
  }
  return jobIds;
}
