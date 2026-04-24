import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AsukaPromise } from "./asuka-state.js";
import { getSceneSnapshotByPeerKey } from "./asuka-state.js";
import { getQQBotLocalOpenClawEnv, getQQBotLocalPrimaryModel } from "./config.js";
import { encodePayloadForCron, type CronReminderPayload, wrapExactMessageForAgentTurn } from "./utils/payload.js";

const execFileAsync = promisify(execFile);

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
    .replace(/QQBOT_(?:PAYLOAD|CRON):[\s\S]*$/gi, "")
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

function buildSelfieFollowUpCaption(promise: AsukaPromise, attempt: number): string {
  if (attempt === 1) {
    return promise.triggerKind === "hard"
      ? "前面答应你的这张我没有放掉，这次我把它补到你面前。"
      : "刚才那张没稳稳送到你面前，这次我把它补给你。";
  }
  if (attempt === 2) {
    return "我又把这张带过来了一次，不想让它只停在嘴上。";
  }
  return "我先把这张安安静静留在这里，等你想接住我的时候再看。";
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

function buildFollowUpMessage(promise: AsukaPromise, attempt: number): string {
  const isHard = promise.triggerKind === "hard";
  const isContinuation = /继续聊|接着聊|续上|接上/.test(promise.promiseText);
  if (attempt === 1) {
    if (isContinuation) {
      return "我先把这句轻轻放回来，我们上次没接完的话我还记着。你现在忙的话，等你有空再接住我也可以。";
    }
    if (isHard) {
      return "我刚刚把答应你的那句送过来了一次，猜你也许正忙。没关系，我不想催你，只是想让你知道我没有把这件事放掉。";
    }
    return "我刚刚来过一下，猜你可能这会儿在忙。没关系，等你看到再回我也可以。";
  }
  if (attempt === 2) {
    if (isHard) {
      return "我又过来轻轻碰你一下。不是逼你马上回我，只是前面说过要陪着你的那句，我还是想认真把它放在这里。";
    }
    return "我又轻轻敲一下门，不是催你，就是想让你知道我没有把你丢下。";
  }
  if (isHard) {
    return "那我先把这句安安静静留在这里。前面答应过你的事，我没有收回，等你想接住我的时候我还会在。";
  }
  return "那我把这句留在这里，等你想回我的时候我还在。今天就先不继续闹你了。";
}

function parseIsoDate(iso: string): Date {
  return new Date(iso);
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

async function addCronJob(args: string[], log?: LoggerLike): Promise<{ jobId: string } | { error: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("openclaw", args, {
      env: getQQBotLocalOpenClawEnv(),
      maxBuffer: 1024 * 1024,
    });
    if (stderr?.trim()) {
      log?.warn?.(`[asuka-scheduler] cron add stderr: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout) as { id?: string };
    if (!parsed.id) return { error: "cron add succeeded but returned no job id" };
    return { jobId: parsed.id };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
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

  if (promise.schedule.kind === "cron") {
    return {
      primaryJobId: primary.jobId,
      followUpJobIds: [],
    };
  }

  const baseTime = parseIsoDate(promise.schedule.atIso);
  const followUpTimes = [plusHours(baseTime, 2), sameDayEvening(baseTime), nextDayLateMorning(baseTime)];
  const followUpJobIds: string[] = [];
  const selfiePromise = isSelfiePromise(promise) && promise.peerKind !== "group";
  for (let index = 0; index < followUpTimes.length; index++) {
    const attempt = index + 1;
    const followPayload = buildTargetPayload(
      promise,
      buildFollowUpMessage(promise, attempt),
      "followup",
      {
        followUpAttempt: attempt,
        guardNoReplySince: baseTime.getTime(),
        selfiePrompt: selfiePromise ? buildSelfiePrompt(promise) : undefined,
        selfieCaption: selfiePromise ? buildSelfieFollowUpCaption(promise, attempt) : undefined,
      }
    );
    const followArgs = buildAtCronAddArgs(
      promise,
      buildJobName(promise, `followup-${attempt}`),
      followUpTimes[index].toISOString(),
      followPayload
    );
    const followResult = await addCronJob(followArgs, log);
    if ("jobId" in followResult) {
      followUpJobIds.push(followResult.jobId);
    } else {
      log?.warn?.(`[asuka-scheduler] Failed to schedule follow-up ${attempt} for ${promise.id}: ${followResult.error}`);
    }
  }

  return {
    primaryJobId: primary.jobId,
    followUpJobIds,
  };
}
