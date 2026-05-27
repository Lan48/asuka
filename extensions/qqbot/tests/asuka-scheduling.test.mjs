import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-scheduling-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.OPENCLAW_STATE_DIR = tmpHome;
delete process.env.OPENCLAW_CONFIG_PATH;
delete process.env.OPENCLAW_SCRIPT;
delete process.env.OPENCLAW_WRAPPER;

const tmpBin = path.join(tmpHome, "bin");
const cronLog = path.join(tmpHome, "cron-log.jsonl");
const cronSeq = path.join(tmpHome, "cron-seq.txt");
fs.mkdirSync(tmpBin, { recursive: true });
const openclawStub = path.join(tmpBin, "openclaw.cjs");
fs.writeFileSync(openclawStub, `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.QQBOT_TEST_CRON_LOG;
const seqFile = process.env.QQBOT_TEST_CRON_SEQ;
const previous = fs.existsSync(seqFile) ? Number(fs.readFileSync(seqFile, "utf-8")) : 0;
const next = previous + 1;
fs.writeFileSync(seqFile, String(next));
if (log) fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(JSON.stringify({ id: \`job-\${next}\` }));
`);
fs.chmodSync(openclawStub, 0o755);
process.env.OPENCLAW_WRAPPER = openclawStub;
process.env.PATH = `${tmpBin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.QQBOT_TEST_CRON_LOG = cronLog;
process.env.QQBOT_TEST_CRON_SEQ = cronSeq;

const base = Date.UTC(2026, 3, 26, 0, 0, 0);
const stateFile = path.join(tmpHome, ".openclaw", "qqbot", "data", "asuka-state", "state.json");
const scheduledDeliveryFile = path.join(tmpHome, ".openclaw", "qqbot", "data", "scheduled-deliveries.json");

const direct = {
  accountId: "acct-test",
  peerKind: "direct",
  peerId: "user-scheduling",
  senderId: "user-scheduling",
  target: "c2c:user-scheduling",
  messageId: "schedule-m-1",
};

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

function readCronInvocations() {
  if (!fs.existsSync(cronLog)) return [];
  return fs.readFileSync(cronLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function readScheduledDeliveries() {
  if (!fs.existsSync(scheduledDeliveryFile)) return { version: 1, jobs: [] };
  return JSON.parse(fs.readFileSync(scheduledDeliveryFile, "utf-8"));
}

try {
  const { parseAssistantPromises } = await import("../dist/src/promise-parser.js");
  const { scheduleAmbientLifeJobs } = await import("../dist/src/ambient-scheduler.js");
  const { schedulePromiseJobs } = await import("../dist/src/promise-scheduler.js");
  const { setQQBotCronService } = await import("../dist/src/runtime.js");
  const { removeCronJobDirect, removeCronJobLive } = await import("../dist/src/utils/openclaw-command.js");
  const {
    appendPromiseFollowUpJob,
    buildAsukaStatePrompt,
    cancelPromisesFromUserMessage,
    markPromiseDelivered,
    markPromiseDeliveryFallback,
    markPromiseDeliveryFailed,
    markPromiseScheduled,
    markPromiseScheduleFailed,
    prepareRepairDelivery,
    recordAssistantReply,
    recordInboundInteraction,
    shouldScheduleAmbientForPeer,
    shouldSendPromiseDelivery,
    shouldSendPromiseFollowUp,
  } = await import("../dist/src/asuka-state.js");

  const parse = (text) => parseAssistantPromises(text, {
    now: new Date(base),
    timeZone: "Asia/Shanghai",
  });

  function createPromise(text, offsetMs) {
    const parsed = parse(text);
    assert.equal(parsed.length, 1, `${text} should parse one promise`);
    const created = recordAssistantReply(
      { ...direct, messageId: `schedule-m-${offsetMs}` },
      text,
      parsed,
      base + offsetMs,
    );
    assert.equal(created.length, 1, `${text} should persist one promise`);
    return created[0];
  }

  const atPromise = createPromise("拉钩，明天早上九点我来找你说早安。", 1_000);
  assert.equal(atPromise.schedule?.kind, "at", "hard promise should have an at schedule");
  const atJobs = await schedulePromiseJobs(atPromise);
  assert.ok("primaryJobId" in atJobs, "at scheduling should succeed through QQBot scheduled delivery");
  assert.match(atJobs.primaryJobId, /^[0-9a-f-]{36}$/i, "at scheduling should return an internal scheduled delivery id");
  assert.equal(atJobs.followUpJobIds.length, 3, "at scheduling should return three follow-up job ids");

  markPromiseScheduled(atPromise.id, atJobs.primaryJobId, base + 2_000);
  for (const jobId of atJobs.followUpJobIds) {
    appendPromiseFollowUpJob(atPromise.id, jobId);
  }
  const stateAfterSchedule = readState();
  const persistedAt = stateAfterSchedule.promises[atPromise.id];
  assert.equal(persistedAt.cronJobId, atJobs.primaryJobId, "primary job id should persist separately");
  assert.equal(persistedAt.followUpJobIds.length, 3, "follow-up job ids should persist separately");
  assert.equal(persistedAt.state, "scheduled", "scheduled promise should have scheduled state");
  assert.equal(typeof persistedAt.scheduledAt, "number", "scheduled promise should expose scheduledAt");

  const atInvocations = readCronInvocations();
  assert.equal(atInvocations.length, 0, "QQBot cron payloads should not invoke OpenClaw cron");
  let scheduledDeliveries = readScheduledDeliveries();
  assert.equal(scheduledDeliveries.jobs.length, 4, "at promise should create one primary and three follow-up scheduled deliveries");
  assert.ok(scheduledDeliveries.jobs.every((job) => job.message.startsWith("QQBOT_CRON:")), "scheduled deliveries should store raw QQBOT_CRON payloads");
  assert.ok(scheduledDeliveries.jobs.every((job) => !job.message.includes("纯转发任务")), "scheduled deliveries should not store agent-turn wrapper prompts");
  assert.ok(scheduledDeliveries.jobs.some((job) => job.name.includes("asuka-hard-followup-1")), "scheduled jobs should include followup-1 job name");
  assert.ok(scheduledDeliveries.jobs.some((job) => job.name.includes("asuka-hard-followup-2")), "scheduled jobs should include followup-2 job name");
  assert.ok(scheduledDeliveries.jobs.some((job) => job.name.includes("asuka-hard-followup-3")), "scheduled jobs should include followup-3 job name");

  const cronPromise = createPromise("我会每天早上九点给你发早安。", 10_000);
  assert.equal(cronPromise.schedule?.kind, "cron", "daily promise should have a cron schedule");
  const cronJobs = await schedulePromiseJobs(cronPromise);
  assert.ok("primaryJobId" in cronJobs, "cron scheduling should succeed through QQBot scheduled delivery");
  assert.match(cronJobs.primaryJobId, /^[0-9a-f-]{36}$/i, "cron scheduling should return an internal scheduled delivery id");
  assert.equal(cronJobs.followUpJobIds.length, 0, "cron scheduling should not create follow-up jobs");
  const allInvocations = readCronInvocations();
  assert.equal(allInvocations.length, 0, "cron promise should not invoke OpenClaw cron");
  scheduledDeliveries = readScheduledDeliveries();
  assert.equal(scheduledDeliveries.jobs.length, 5, "cron promise should add one more scheduled delivery");
  assert.equal(
    scheduledDeliveries.jobs.find((job) => job.id === cronJobs.primaryJobId)?.schedule?.kind,
    "cron",
    "cron scheduling should persist a recurring scheduled delivery",
  );

  const directCliLog = path.join(tmpHome, "direct-cli-should-not-run.log");
  const failingOpenClawScript = path.join(tmpBin, "openclaw-fail.cjs");
  fs.writeFileSync(failingOpenClawScript, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(directCliLog)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(42);
`);
  fs.chmodSync(failingOpenClawScript, 0o755);

  const originalArgv = process.argv.slice();
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalCwd = process.cwd();
  try {
    delete process.env.OPENCLAW_WRAPPER;
    process.env.OPENCLAW_SCRIPT = failingOpenClawScript;
    process.argv.push("openclaw.mjs", "gateway");
    const shadowCwd = path.join(tmpHome, "shadow-cwd");
    fs.mkdirSync(path.join(shadowCwd, "cron"), { recursive: true });
    fs.writeFileSync(path.join(shadowCwd, "cron", "jobs.json"), JSON.stringify({ version: 1, jobs: [] }));
    process.chdir(shadowCwd);
    const liveCronAdds = [];
    setQQBotCronService({
      add: async (input) => {
        const id = `live-job-${liveCronAdds.length + 1}`;
        liveCronAdds.push(input);
        return { id, ...input, state: { nextRunAtMs: base + 99_000 } };
      },
      remove: async (jobId) => {
        liveCronAdds.push({ removed: jobId });
        return { id: jobId };
      },
    });
    const liveCronPromise = createPromise("约定，明天早上十点我来找你说早安。", 15_000);
    const liveCronJobs = await schedulePromiseJobs(liveCronPromise);
    assert.ok("primaryJobId" in liveCronJobs, "gateway scheduling should use QQBot scheduled delivery before live CronService");
    assert.match(liveCronJobs.primaryJobId, /^[0-9a-f-]{36}$/i, "gateway scheduling should return an internal scheduled delivery id");
    assert.equal(liveCronJobs.followUpJobIds.length, 3, "gateway scheduling should schedule follow-up jobs too");
    assert.equal(liveCronAdds.length, 0, "QQBot internal cron payloads should not enter live CronService agentTurn routing");
    assert.equal(readCronInvocations().length, 0, "live gateway scheduling should not invoke openclaw CLI");
    assert.equal(fs.existsSync(directCliLog), false, "live CronService scheduling should not run OPENCLAW_SCRIPT");
    const beforeLiveRemove = readScheduledDeliveries().jobs.length;
    const liveRemove = await removeCronJobLive(liveCronJobs.primaryJobId);
    assert.ok("removed" in liveRemove, "live removal should remove internal scheduled delivery jobs");
    assert.equal(readScheduledDeliveries().jobs.length, beforeLiveRemove - 1, "live removal should delete the internal scheduled delivery");
    const cronStorePath = path.join(tmpHome, "cron", "jobs.json");
    let directStore = fs.existsSync(cronStorePath)
      ? JSON.parse(fs.readFileSync(cronStorePath, "utf-8"))
      : { jobs: [] };
    assert.equal(directStore.jobs.length, 0, "QQBot scheduled delivery should not write directly to the OpenClaw cron store");

    setQQBotCronService(null);
    const directStorePromise = createPromise("约定，明天上午十一点我来找你说早安。", 16_000);
    const directStoreJobs = await schedulePromiseJobs(directStorePromise);
    assert.ok("primaryJobId" in directStoreJobs, "gateway scheduling should still use QQBot scheduled delivery without live CronService");
    assert.equal(readCronInvocations().length, 0, "internal scheduled delivery should not invoke openclaw CLI");
    assert.equal(fs.existsSync(directCliLog), false, "internal scheduled delivery should not run OPENCLAW_SCRIPT");
    directStore = fs.existsSync(cronStorePath)
      ? JSON.parse(fs.readFileSync(cronStorePath, "utf-8"))
      : { jobs: [] };
    assert.equal(directStore.jobs.length, 0, "internal scheduled delivery should not write OpenClaw cron jobs");
    const directRemove = await removeCronJobDirect(directStoreJobs.primaryJobId, { env: process.env });
    assert.ok("removedCount" in directRemove, "direct cron store removal should return a removal count");
    assert.equal(directRemove.removedCount, 1, "direct removal should remove the matching scheduled delivery");
    const shadowStore = JSON.parse(fs.readFileSync(path.join(shadowCwd, "cron", "jobs.json"), "utf-8"));
    assert.equal(shadowStore.jobs.length, 0, "internal scheduled delivery should not write a cwd shadow store when state dir is set");
  } finally {
    process.chdir(originalCwd);
    process.argv.splice(0, process.argv.length, ...originalArgv);
    process.env.OPENCLAW_WRAPPER = openclawStub;
    delete process.env.OPENCLAW_SCRIPT;
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }

  markPromiseDelivered(atPromise.id, { at: base + 20_000, content: "早安" });
  assert.equal(shouldSendPromiseDelivery(atPromise.id), false, "delivered promise should not allow repeated primary delivery");
  assert.equal(
    shouldSendPromiseFollowUp(atPromise.id, base, base + 21_000),
    true,
    "delivered promise should still allow guarded follow-up before user reply",
  );

  recordInboundInteraction(direct, "我看到了", base + 22_000);
  assert.equal(
    shouldSendPromiseFollowUp(atPromise.id, base, base + 23_000),
    false,
    "follow-up should stop after user reply",
  );

  const selfiePromise = createPromise("晚点我给你发自拍。", 30_000);
  markPromiseScheduled(selfiePromise.id, "job-selfie-primary", base + 31_000);
  appendPromiseFollowUpJob(selfiePromise.id, "job-selfie-follow");
  const cancelled = cancelPromisesFromUserMessage(direct, "不用发自拍了", base + 32_000);
  assert.equal(cancelled.cancelledPromises.length, 1, "selfie promise should be cancelled");
  assert.equal(shouldSendPromiseDelivery(selfiePromise.id), false, "cancelled promise should not allow primary delivery");
  assert.equal(shouldSendPromiseFollowUp(selfiePromise.id, base, base + 33_000), false, "cancelled promise should not allow follow-up");

  const ambientDirect = {
    ...direct,
    peerId: "user-ambient-rebase",
    senderId: "user-ambient-rebase",
    target: "c2c:user-ambient-rebase",
    messageId: "schedule-ambient-rebase",
  };
  recordInboundInteraction(ambientDirect, "你醒了吗", base + 90_000);
  recordAssistantReply(ambientDirect, "醒了，我在。", [], base + 91_000);
  const firstAmbientJobs = await scheduleAmbientLifeJobs(ambientDirect, base + 91_000);
  assert.equal(firstAmbientJobs.length, 1, "first ambient schedule should create one internal scheduled delivery");
  let ambientDeliveries = readScheduledDeliveries();
  assert.ok(
    ambientDeliveries.jobs.some((job) => job.id === firstAmbientJobs[0]),
    "first ambient job should be present before newer chat arrives",
  );

  recordInboundInteraction(ambientDirect, "我又回你一句", base + 92_000);
  recordAssistantReply(ambientDirect, "嗯，我接住了。", [], base + 93_000);
  assert.equal(
    shouldScheduleAmbientForPeer(ambientDirect, base + 93_000),
    false,
    "a user reply newer than the previous ambient guard should not duplicate an already scheduled ambient job",
  );
  const duplicateAmbientJobs = await scheduleAmbientLifeJobs(ambientDirect, base + 93_000);
  assert.equal(duplicateAmbientJobs.length, 0, "new chat should not create a replacement delivery while the original job is still pending");
  ambientDeliveries = readScheduledDeliveries();
  assert.ok(
    ambientDeliveries.jobs.some((job) => job.id === firstAmbientJobs[0]),
    "the pending ambient job should remain scheduled so delivery can render against latest context",
  );

  const failedSchedulePromise = createPromise("约定，明天晚上我给你发消息。", 40_000);
  markPromiseScheduleFailed(failedSchedulePromise.id, "cron add failed", base + 41_000);
  const failedDeliveryPromise = createPromise("约定，今晚我来找你说晚安。", 50_000);
  markPromiseDeliveryFailed(failedDeliveryPromise.id, "send failed", base + 51_000);
  const failedState = readState();
  assert.equal(failedState.promises[failedSchedulePromise.id].state, "schedule_failed", "schedule failures should persist state");
  assert.equal(failedState.promises[failedSchedulePromise.id].lastError, "cron add failed", "schedule failures should persist error");
  assert.equal(typeof failedState.promises[failedSchedulePromise.id].scheduleFailedAt, "number", "schedule failures should expose timestamp");
  assert.equal(failedState.promises[failedDeliveryPromise.id].state, "delivery_failed", "delivery failures should persist state");
  assert.equal(failedState.promises[failedDeliveryPromise.id].lastError, "send failed", "delivery failures should persist error");
  assert.equal(typeof failedState.promises[failedDeliveryPromise.id].deliveryFailedAt, "number", "delivery failures should expose timestamp");

  const prompt = buildAsukaStatePrompt(direct, base + 52_000);
  assert.match(prompt, /你需要温柔补上的失约|还没法确认是否送达|还没落成具体动作/, "prompt should expose repairable failed promises");
  const repair = prepareRepairDelivery(direct, base + 53_000);
  assert.ok(repair, "repair payload should be available for failed promises");
  assert.ok(
    [failedSchedulePromise.id, failedDeliveryPromise.id].includes(repair.promiseId),
    "repair payload should target a failed promise",
  );

  const selfieSkippedFallbackPromise = createPromise("约定，今晚我给你补一张自拍。", 60_000);
  markPromiseDeliveryFailed(
    selfieSkippedFallbackPromise.id,
    "selfie skill api key missing",
    base + 61_000,
    { failureKind: "selfie" },
  );
  markPromiseDeliveryFallback(selfieSkippedFallbackPromise.id, {
    state: "skipped",
    skipReason: "duplicate",
    at: base + 61_500,
  });
  const selfieFailedFallbackPromise = createPromise("约定，明天我给你发照片。", 70_000);
  markPromiseDeliveryFailed(
    selfieFailedFallbackPromise.id,
    "selfie script not found",
    base + 71_000,
    { failureKind: "selfie" },
  );
  markPromiseDeliveryFallback(selfieFailedFallbackPromise.id, {
    state: "failed",
    error: "QQBot not configured (missing appId or clientSecret)",
    at: base + 71_500,
  });
  const selfieSentFallbackPromise = createPromise("约定，后天我给你发一张图。", 80_000);
  markPromiseDeliveryFailed(
    selfieSentFallbackPromise.id,
    "image upload failed",
    base + 81_000,
    { failureKind: "media" },
  );
  markPromiseDeliveryFallback(selfieSentFallbackPromise.id, {
    state: "sent",
    at: base + 81_500,
  });
  const fallbackState = readState();
  const skippedFallback = fallbackState.promises[selfieSkippedFallbackPromise.id];
  assert.equal(skippedFallback.state, "delivery_failed", "fallback metadata should not hide original selfie failure");
  assert.equal(skippedFallback.lastError, "selfie skill api key missing", "original selfie failure should remain visible");
  assert.equal(skippedFallback.deliveryFailureKind, "selfie", "selfie failure kind should persist");
  assert.equal(skippedFallback.lastFallbackState, "skipped", "skipped fallback should persist");
  assert.equal(skippedFallback.lastFallbackSkipReason, "duplicate", "fallback skip reason should persist");
  const failedFallback = fallbackState.promises[selfieFailedFallbackPromise.id];
  assert.equal(failedFallback.lastError, "selfie script not found", "fallback failure should not overwrite original selfie failure");
  assert.equal(failedFallback.lastFallbackState, "failed", "failed fallback should persist");
  assert.equal(failedFallback.lastFallbackError, "QQBot not configured (missing appId or clientSecret)", "fallback error should persist separately");
  const sentFallback = fallbackState.promises[selfieSentFallbackPromise.id];
  assert.equal(sentFallback.deliveryFailureKind, "media", "media failure kind should persist");
  assert.equal(sentFallback.lastFallbackState, "sent", "sent fallback should persist");
  assert.equal(sentFallback.lastFallbackError, undefined, "sent fallback should not carry fallback error");

  console.log("[qqbot:test] asuka-scheduling fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
