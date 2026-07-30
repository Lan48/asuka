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
  const { scheduleAmbientLifeJobs, schedulePlannedAmbientDelivery } = await import("../dist/src/ambient-scheduler.js");
  const { deferCronMessageUntilQuietEnds } = await import("../dist/src/outbound.js");
  const { schedulePromiseJobs } = await import("../dist/src/promise-scheduler.js");
  const { addScheduledDeliveryJob, removeScheduledDeliveryJobsByMode, removeScheduledDeliveryJobsForPeer, retryScheduledDeliveryJob } = await import("../dist/src/scheduled-delivery-store.js");
  const { buildScheduledDeliveryExecutions } = await import("../dist/src/scheduled-delivery-runner.js");
  const { setQQBotCronService } = await import("../dist/src/runtime.js");
  const { decodeCronPayload, encodePayloadForCron } = await import("../dist/src/utils/payload.js");
  const { removeCronJobDirect, removeCronJobLive } = await import("../dist/src/utils/openclaw-command.js");
  const {
    appendPromiseFollowUpJob,
    buildAsukaStatePrompt,
    cancelPromisesFromUserMessage,
    clearAmbientScheduledJobs,
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
  assert.equal(atJobs.followUpJobIds.length, 0, "one-shot scheduling should not create fixed follow-up jobs");

  markPromiseScheduled(atPromise.id, atJobs.primaryJobId, base + 2_000);
  for (const jobId of atJobs.followUpJobIds) {
    appendPromiseFollowUpJob(atPromise.id, jobId);
  }
  const stateAfterSchedule = readState();
  const persistedAt = stateAfterSchedule.promises[atPromise.id];
  assert.equal(persistedAt.cronJobId, atJobs.primaryJobId, "primary job id should persist separately");
  assert.equal(persistedAt.followUpJobIds?.length ?? 0, 0, "one-shot promise should persist without follow-up jobs");
  assert.equal(persistedAt.state, "scheduled", "scheduled promise should have scheduled state");
  assert.equal(typeof persistedAt.scheduledAt, "number", "scheduled promise should expose scheduledAt");

  const atInvocations = readCronInvocations();
  assert.equal(atInvocations.length, 0, "QQBot cron payloads should not invoke OpenClaw cron");
  let scheduledDeliveries = readScheduledDeliveries();
  assert.equal(scheduledDeliveries.jobs.length, 1, "at promise should create only one primary scheduled delivery");
  assert.ok(scheduledDeliveries.jobs.every((job) => job.message.startsWith("QQBOT_CRON:")), "scheduled deliveries should store raw QQBOT_CRON payloads");
  assert.ok(scheduledDeliveries.jobs.every((job) => !job.message.includes("纯转发任务")), "scheduled deliveries should not store agent-turn wrapper prompts");
  assert.ok(!scheduledDeliveries.jobs.some((job) => job.name.includes("followup")), "scheduled jobs should contain no fixed follow-up");

  const cronPromise = createPromise("我会每天早上九点给你发早安。", 10_000);
  assert.equal(cronPromise.schedule?.kind, "cron", "daily promise should have a cron schedule");
  const cronJobs = await schedulePromiseJobs(cronPromise);
  assert.ok("primaryJobId" in cronJobs, "cron scheduling should succeed through QQBot scheduled delivery");
  assert.match(cronJobs.primaryJobId, /^[0-9a-f-]{36}$/i, "cron scheduling should return an internal scheduled delivery id");
  assert.equal(cronJobs.followUpJobIds.length, 0, "cron scheduling should not create follow-up jobs");
  const allInvocations = readCronInvocations();
  assert.equal(allInvocations.length, 0, "cron promise should not invoke OpenClaw cron");
  scheduledDeliveries = readScheduledDeliveries();
  assert.equal(scheduledDeliveries.jobs.length, 2, "cron promise should add one more scheduled delivery");
  assert.equal(
    scheduledDeliveries.jobs.find((job) => job.id === cronJobs.primaryJobId)?.schedule?.kind,
    "cron",
    "cron scheduling should persist a recurring scheduled delivery",
  );

  const quietPayloadA = encodePayloadForCron({
    type: "cron_reminder",
    mode: "promise",
    content: "早上来找你说早安",
    targetType: "c2c",
    targetAddress: direct.senderId,
    promiseId: atPromise.id,
    peerKey: `${direct.accountId}:${direct.peerKind}:${direct.peerId}`,
  });
  const quietPromiseB = createPromise("约定，明天早上我给你发一张自拍。", 12_000);
  const quietPayloadB = encodePayloadForCron({
    type: "cron_reminder",
    mode: "promise",
    content: "兑现答应的自拍",
    targetType: "c2c",
    targetAddress: direct.senderId,
    promiseId: quietPromiseB.id,
    peerKey: `${direct.accountId}:${direct.peerKind}:${direct.peerId}`,
    selfiePrompt: "生成符合当前上下文的自拍",
    selfieCaption: "答应你的这张，我带来了。",
  });
  const quietBatchKey = `${direct.accountId}:${direct.accountId}:${direct.peerKind}:${direct.peerId}`;
  const quietJobA = await addScheduledDeliveryJob({
    name: "asuka-quiet-a",
    accountId: direct.accountId,
    to: direct.target,
    message: quietPayloadA,
    schedule: { kind: "at", at: new Date(base + 60_000).toISOString() },
    quietBatchKey,
    deferredAtMs: base,
  });
  const quietJobB = await addScheduledDeliveryJob({
    name: "asuka-quiet-b",
    accountId: direct.accountId,
    to: direct.target,
    message: quietPayloadB,
    schedule: { kind: "at", at: new Date(base + 60_000).toISOString() },
    quietBatchKey,
    deferredAtMs: base,
  });
  assert.ok("job" in quietJobA && "job" in quietJobB, "quiet inbox jobs should persist directly");
  const quietExecutions = buildScheduledDeliveryExecutions([quietJobA.job, quietJobB.job]);
  assert.equal(quietExecutions.length, 1, "same-peer quiet inbox jobs should produce one flush");
  const mergedQuietPayload = decodeCronPayload(quietExecutions[0].message).payload;
  assert.equal(mergedQuietPayload.quietBatch, true, "quiet flush should identify its no-static-fallback policy");
  assert.deepEqual(
    new Set(mergedQuietPayload.mergedPromiseIds),
    new Set([atPromise.id, quietPromiseB.id]),
    "quiet flush should retain every included promise id",
  );
  assert.match(mergedQuietPayload.content, /早安/);
  assert.match(mergedQuietPayload.content, /自拍/);
  markPromiseDelivered(quietPromiseB.id, { at: base + 13_000, content: "答应你的自拍已经带来了" });

  const currentUtcHour = new Date().getUTCHours();
  const directQuietDeferred = await deferCronMessageUntilQuietEnds(
    {
      accountId: direct.accountId,
      config: {
        proactiveQuietHours: {
          enabled: true,
          startHour: currentUtcHour,
          endHour: (currentUtcHour + 1) % 24,
          timezone: "UTC",
        },
      },
    },
    direct.target,
    quietPayloadA,
    new Date().toISOString(),
    decodeCronPayload(quietPayloadA).payload,
  );
  assert.equal(directQuietDeferred, true, "quiet deferral should enqueue instead of sending");
  const quietDeferredStore = readScheduledDeliveries();
  const deferredJob = quietDeferredStore.jobs.find((job) => job.name.startsWith("asuka-quiet-promise-"));
  assert.ok(deferredJob, "quiet deferral should persist a named Quiet Inbox job");
  assert.equal(deferredJob.message, quietPayloadA, "quiet deferral should persist the raw payload without an agent wrapper");
  assert.equal(typeof deferredJob.quietBatchKey, "string", "quiet deferral should persist its per-peer batch key");
  assert.equal(readCronInvocations().length, 0, "quiet deferral should never invoke the OpenClaw CLI");

  const plainQuietDeferred = await deferCronMessageUntilQuietEnds(
    {
      accountId: direct.accountId,
      config: {
        proactiveQuietHours: {
          enabled: true,
          startHour: currentUtcHour,
          endHour: (currentUtcHour + 1) % 24,
          timezone: "UTC",
        },
      },
    },
    direct.target,
    "普通静默消息",
    new Date().toISOString(),
  );
  assert.equal(plainQuietDeferred, true, "plain quiet messages should also enter the direct queue");
  const plainDeferredJob = readScheduledDeliveries().jobs.find((job) => job.name.startsWith("asuka-quiet-resume-"));
  assert.ok(plainDeferredJob, "plain quiet deferral should persist a resume job");
  assert.equal(decodeCronPayload(plainDeferredJob.message).payload.content, "普通静默消息");
  assert.equal(plainDeferredJob.quietBatchKey, deferredJob.quietBatchKey, "plain and structured messages for one peer should merge");
  assert.equal(readCronInvocations().length, 0, "plain quiet deferral should not invoke the OpenClaw CLI");

  const legacyFollowUp = await addScheduledDeliveryJob({
    name: "asuka-soft-followup-legacy",
    accountId: direct.accountId,
    to: direct.target,
    message: encodePayloadForCron({
      type: "cron_reminder",
      mode: "followup",
      content: "旧固定追发",
      targetType: "c2c",
      targetAddress: direct.senderId,
      promiseId: atPromise.id,
      peerKey: `${direct.accountId}:${direct.peerKind}:${direct.peerId}`,
    }),
    schedule: { kind: "at", at: new Date(base + 120_000).toISOString() },
  });
  assert.ok("job" in legacyFollowUp, "legacy follow-up fixture should persist");
  const removedLegacyFollowUps = await removeScheduledDeliveryJobsByMode({
    accountId: direct.accountId,
    modes: ["followup"],
  });
  assert.ok("removedCount" in removedLegacyFollowUps);
  assert.equal(removedLegacyFollowUps.removedCount, 1, "startup cleanup should remove legacy fixed follow-ups");

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
    assert.equal(liveCronJobs.followUpJobIds.length, 0, "gateway scheduling should not create fixed follow-up jobs");
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
  assert.equal(firstAmbientJobs.length, 1, "first ambient schedule should create one internal planner delivery");
  let ambientDeliveries = readScheduledDeliveries();
  const firstAmbientJob = ambientDeliveries.jobs.find((job) => job.id === firstAmbientJobs[0]);
  assert.ok(firstAmbientJob, "first ambient planner job should be present before newer chat arrives");
  const firstAmbientPayload = decodeCronPayload(firstAmbientJob.message).payload;
  assert.equal(firstAmbientPayload.mode, "ambient_plan", "assistant reply should schedule a 10-minute planner first");
  assert.match(firstAmbientPayload.content, /判断下一条主动消息的发送时间/, "planner payload should not contain a user-visible proactive message");
  assert.equal(
    firstAmbientJob.state.nextRunAtMs,
    base + 91_000 + 10 * 60 * 1000,
    "planner should run ten minutes after the last assistant message",
  );
  const retryAmbient = await retryScheduledDeliveryJob(
    firstAmbientJobs[0],
    "ambient_timing_plan_unavailable",
    base + 91_500,
    { delayMs: 10 * 60 * 1000, maxRetries: 3 },
  );
  assert.equal(retryAmbient.retried, true, "transient ambient planner failure should retry instead of consuming the job");
  ambientDeliveries = readScheduledDeliveries();
  const retriedAmbientJob = ambientDeliveries.jobs.find((job) => job.id === firstAmbientJobs[0]);
  assert.ok(retriedAmbientJob, "retried ambient job should remain in the scheduled delivery store");
  assert.equal(retriedAmbientJob.state.retryCount, 1, "ambient retry should persist retry count");
  assert.equal(retriedAmbientJob.state.lastError, "ambient_timing_plan_unavailable", "ambient retry should persist reason");
  assert.ok(
    retriedAmbientJob.state.nextRunAtMs > base + 91_500,
    "ambient retry should move nextRunAtMs forward",
  );

  recordInboundInteraction(ambientDirect, "我又回你一句", base + 92_000);
  const removedAmbient = await removeScheduledDeliveryJobsForPeer({
    accountId: ambientDirect.accountId,
    peerKey: `${ambientDirect.accountId}:${ambientDirect.peerKind}:${ambientDirect.peerId}`,
    modes: ["ambient_plan", "ambient"],
  });
  assert.ok("removedCount" in removedAmbient, "peer ambient cancellation should succeed");
  assert.equal(removedAmbient.removedCount, 1, "user reply should cancel the pending planner before it can schedule a proactive message");
  clearAmbientScheduledJobs(ambientDirect);
  recordAssistantReply(ambientDirect, "嗯，我接住了。", [], base + 93_000);
  assert.equal(shouldScheduleAmbientForPeer(ambientDirect, base + 93_000), true, "after cancelling the stale pending job, the latest assistant reply may schedule a fresh planner");
  const duplicateAmbientJobs = await scheduleAmbientLifeJobs(ambientDirect, base + 93_000);
  assert.equal(duplicateAmbientJobs.length, 1, "new chat should create a fresh planner tied to the latest assistant reply");
  ambientDeliveries = readScheduledDeliveries();
  assert.ok(
    !ambientDeliveries.jobs.some((job) => job.id === firstAmbientJobs[0]),
    "the stale pending ambient planner should be removed after user reply",
  );
  process.env.ASUKA_PROACTIVE_TIMING_TEST_PLAN = JSON.stringify({
    delayMinutes: 27,
    intent: "等厨房里的饭差不多做好后，再轻轻接上刚才的语境",
    topicAnchor: "厨房里的晚饭收尾",
    sceneBeat: "从做饭转到饭做好后的摆盘和招呼",
    noveltyGoal: "推进到饭做好后的下一动作，不再停留在锅里还在煮",
    blockedAnchors: ["锅里还在煮", "继续催饭快好"],
    reason: "最近对话显示 Asuka 在做饭，适合等完成后再续",
  });
  const plannedDelivery = await schedulePlannedAmbientDelivery(ambientDirect, base + 93_000);
  delete process.env.ASUKA_PROACTIVE_TIMING_TEST_PLAN;
  assert.equal(plannedDelivery.jobIds.length, 1, "planner should create one delivery after model timing verdict");
  ambientDeliveries = readScheduledDeliveries();
  const plannedDeliveryJob = ambientDeliveries.jobs.find((job) => job.id === plannedDelivery.jobIds[0]);
  assert.ok(plannedDeliveryJob, "planned delivery should be persisted");
  const plannedDeliveryPayload = decodeCronPayload(plannedDeliveryJob.message).payload;
  assert.equal(plannedDeliveryPayload.mode, "ambient", "planner-created job should be the actual ambient delivery");
  assert.match(plannedDeliveryPayload.content, /^PROACTIVE_BEAT:/, "delivery payload should carry a structured proactive beat");
  assert.match(plannedDeliveryPayload.content, /厨房里的晚饭收尾/, "delivery payload should persist the planned topic anchor");
  assert.match(plannedDeliveryPayload.content, /饭做好后的下一动作/, "delivery payload should persist the novelty goal");
  assert.doesNotMatch(plannedDeliveryPayload.content, /我现在更想离你近一点。|我刚刚又想到你了。/, "delivery payload should not persist static proactive fallback text");
  const stateAfterBeatPlan = readState();
  const beatLedger = stateAfterBeatPlan.peers[`${ambientDirect.accountId}:${ambientDirect.peerKind}:${ambientDirect.peerId}`].ambient.proactiveBeatLedger;
  assert.match(beatLedger.recentBeats[0].topicAnchor, /厨房里的晚饭收尾/, "planned beat should be written to ambient beat ledger");
  assert.match(beatLedger.recentBeats[0].noveltyGoal, /饭做好后的下一动作/, "planned beat ledger should preserve novelty goal");

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
