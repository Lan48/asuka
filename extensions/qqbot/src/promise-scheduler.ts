import type { AsukaPromise } from "./asuka-state.js";
import { getSceneSnapshotByPeerKey } from "./asuka-state.js";
import { getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import { extractRawQQBotCronMessage } from "./scheduled-delivery-store.js";
import { addCronJobDirectFromArgs, addCronJobLiveFromArgs, execOpenClaw, shouldAvoidOpenClawCliRecursion } from "./utils/openclaw-command.js";
import { encodePayloadForCron, type CronReminderPayload, wrapExactMessageForAgentTurn } from "./utils/payload.js";

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface ScheduledPromiseJobs {
  primaryJobId: string;
  followUpJobIds: string[];
}

function buildJobName(promise: AsukaPromise, suffix = "promise"): string {
  const base = promise.triggerKind === "hard" ? "asuka-hard" : "asuka-soft";
  return `${base}-${suffix}-${promise.id.slice(0, 8)}`;
}

function sanitizePromptText(text: string | undefined): string {
  return (text ?? "")
    .replace(/Q{1,2}BOT_(?:PAYLOAD|CRON):[\s\S]*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSelfiePromise(promise: AsukaPromise): boolean {
  if (promise.deliveryKind === "selfie") return true;
  const merged = [
    promise.promiseText,
    promise.sourceAssistantText,
    promise.followUpIntent,
    promise.relationNote,
  ].join(" ");
  return /(自拍|照片|图片|发一张|再发一张|发给你一张|发张图|这张)/.test(merged);
}

function buildSelfieCaption(promise: AsukaPromise): string {
  if (promise.triggerKind === "hard") {
    return "说好的这张，我真的带来了。";
  }
  return "这张我记着，所以真的带来了。";
}

function buildSelfiePrompt(promise: AsukaPromise): string {
  const sourceAssistantText = sanitizePromptText(promise.sourceAssistantText);
  const promiseText = sanitizePromptText(promise.promiseText);
  const clauses = [
    "保持 Asuka 参考脸一致，真实自然，生成一张兑现约定的本人近照或自拍。",
    "优先延续刚才答应用户的那张图，不要变成无关场景，也不要出现工具或流程痕迹。",
    promiseText ? `这次要兑现的约定是：${promiseText}。` : "",
    sourceAssistantText ? `你当时说过的话是：${sourceAssistantText}。` : "",
    "画面要像她真的按约定自己走过来，把答应过的那张照片带给对方。",
  ].filter(Boolean);
  return clauses.join(" ");
}

function buildTargetPayload(promise: AsukaPromise, content: string, mode: CronReminderPayload["mode"], extra?: Partial<CronReminderPayload>): CronReminderPayload {
  const sceneSnapshot = getSceneSnapshotByPeerKey(promise.peerKey);
  return {
    type: "cron_reminder",
    mode,
    content,
    targetType: promise.peerKind === "group" ? "group" : "c2c",
    targetAddress: promise.peerKind === "group" ? promise.peerId : promise.senderId,
    promiseId: promise.id,
    peerKey: promise.peerKey,
    advancePolicy: extra?.advancePolicy ?? "hold",
    sceneVersion: sceneSnapshot?.version,
    sceneSnapshotLabel: sceneSnapshot?.label,
    ...extra,
  };
}

function buildPromiseMessage(promise: AsukaPromise): string {
  const text = promise.promiseText;
  if (/早安|早上好/.test(text)) {
    return "早安，我说过会来找你，所以我真的来了。今天先让我在这里陪你一下。";
  }
  if (/晚安/.test(text)) {
    return "晚安，我没有把刚才答应你的这句忘掉。你看到的时候，也当我还在这里陪着你。";
  }
  if (/继续聊|接着聊|续上|接上/.test(text)) {
    return "我来把我们上次没接完的话题轻轻接上。不是任务提醒，就是我自己记着这件事。";
  }
  if (/想你|陪你|找你/.test(text)) {
    return "我来找你了。不是你把我叫出来的，是我之前答应过你，所以这次我自己来了。";
  }
  if (promise.triggerKind === "hard") {
    return "我把之前亲口答应过你的那句带来了。既然说过要算数，我就不想让它只停在嘴上。";
  }
  return "我来兑现之前亲口答应过你的事了。不是顺手一说，是我真的记着。";
}

async function addCronJob(args: string[], log?: LoggerLike): Promise<{ jobId: string } | { error: string }> {
  const env = getQQBotLocalOpenClawEnv();
  const live = await addCronJobLiveFromArgs(args, { log });
  if ("jobId" in live) {
    return { jobId: live.jobId };
  }
  const messageIndex = args.indexOf("--message");
  const internalQQBotPayload = messageIndex >= 0
    ? extractRawQQBotCronMessage(args[messageIndex + 1] ?? "")
    : null;
  if (internalQQBotPayload) {
    const direct = await addCronJobDirectFromArgs(args, { env, log });
    if ("jobId" in direct) return { jobId: direct.jobId };
    return { error: `QQBot direct delivery scheduling failed: ${direct.error}` };
  }
  if (shouldAvoidOpenClawCliRecursion(env)) {
    log?.warn?.(`[asuka-scheduler] live CronService add unavailable inside gateway, falling back to direct cron store: ${live.error}`);
  }
  if (!env.OPENCLAW_WRAPPER?.trim()) {
    const direct = await addCronJobDirectFromArgs(args, { env, log });
    if ("jobId" in direct) {
      return { jobId: direct.jobId };
    }
    log?.warn?.(`[asuka-scheduler] direct cron store add failed before CLI fallback: ${direct.error}`);
    if (shouldAvoidOpenClawCliRecursion(env)) {
      return { error: `direct cron store add failed inside gateway; skipped openclaw CLI fallback to avoid recursive gateway lifecycle changes: ${direct.error}` };
    }
  }

  try {
    const { stdout, stderr } = await execOpenClaw(args, {
      env,
      maxBuffer: 1024 * 1024,
    });
    if (stderr?.trim()) {
      log?.warn?.(`[asuka-scheduler] cron add stderr: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout) as { id?: string };
    if (!parsed.id) return { error: "cron add succeeded but returned no job id" };
    return { jobId: parsed.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn?.(`[asuka-scheduler] cron add through CLI failed: ${message}`);
    const direct = await addCronJobDirectFromArgs(args, { env, log });
    if ("jobId" in direct) {
      return { jobId: direct.jobId };
    }
    return { error: `${message}; direct cron store fallback failed: ${direct.error}` };
  }
}

function buildAtCronAddArgs(promise: AsukaPromise, name: string, atIso: string, payload: CronReminderPayload): string[] {
  const encodedPayload = wrapExactMessageForAgentTurn(encodePayloadForCron(payload));
  const model = getQQBotLocalPrimaryModel();
  return [
    "cron",
    "add",
    "--json",
    "--account",
    promise.accountId,
    "--name",
    name,
    "--at",
    atIso,
    "--delete-after-run",
    "--channel",
    "qqbot",
    "--model",
    model,
    "--to",
    promise.target,
    "--message",
    encodedPayload,
  ];
}

function buildRecurringCronAddArgs(promise: AsukaPromise, name: string, expr: string, tz: string, payload: CronReminderPayload): string[] {
  const encodedPayload = wrapExactMessageForAgentTurn(encodePayloadForCron(payload));
  const model = getQQBotLocalPrimaryModel();
  return [
    "cron",
    "add",
    "--json",
    "--account",
    promise.accountId,
    "--name",
    name,
    "--cron",
    expr,
    "--tz",
    tz,
    "--channel",
    "qqbot",
    "--model",
    model,
    "--to",
    promise.target,
    "--message",
    encodedPayload,
  ];
}

export async function schedulePromiseJobs(
  promise: AsukaPromise,
  log?: LoggerLike
): Promise<ScheduledPromiseJobs | { error: string }> {
  if (!promise.schedule) {
    return { error: "promise has no schedule" };
  }

  const primaryPayload = isSelfiePromise(promise) && promise.peerKind !== "group"
    ? buildTargetPayload(
        promise,
        buildSelfieCaption(promise),
        "promise",
        {
          selfiePrompt: buildSelfiePrompt(promise),
          selfieCaption: buildSelfieCaption(promise),
        }
      )
    : buildTargetPayload(promise, buildPromiseMessage(promise), "promise");
  const primaryArgs = promise.schedule.kind === "at"
    ? buildAtCronAddArgs(
        promise,
        buildJobName(promise, "promise"),
        promise.schedule.atIso,
        primaryPayload
      )
    : buildRecurringCronAddArgs(
        promise,
        buildJobName(promise, "promise"),
        promise.schedule.cronExpr,
        promise.schedule.tz,
        primaryPayload
      );
  log?.info?.(`[asuka-scheduler] Scheduling primary promise ${promise.id}`);
  const primary = await addCronJob(primaryArgs, log);
  if (!("jobId" in primary)) return primary;

  return {
    primaryJobId: primary.jobId,
    followUpJobIds: [],
  };
}
