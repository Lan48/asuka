import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-scheduling-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const tmpBin = path.join(tmpHome, "bin");
const cronLog = path.join(tmpHome, "cron-log.jsonl");
const cronSeq = path.join(tmpHome, "cron-seq.txt");
fs.mkdirSync(tmpBin, { recursive: true });
const openclawStub = path.join(tmpBin, "openclaw");
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
process.env.PATH = `${tmpBin}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.QQBOT_TEST_CRON_LOG = cronLog;
process.env.QQBOT_TEST_CRON_SEQ = cronSeq;

const base = Date.UTC(2026, 3, 26, 0, 0, 0);
const stateFile = path.join(tmpHome, ".openclaw", "qqbot", "data", "asuka-state", "state.json");

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
  return fs.readFileSync(cronLog, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

try {
  const { parseAssistantPromises } = await import("../dist/src/promise-parser.js");
  const { schedulePromiseJobs } = await import("../dist/src/promise-scheduler.js");
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
  assert.ok("primaryJobId" in atJobs, "at scheduling should succeed through stubbed openclaw");
  assert.equal(atJobs.primaryJobId, "job-1", "at scheduling should return primary job id");
  assert.deepEqual(atJobs.followUpJobIds, ["job-2", "job-3", "job-4"], "at scheduling should return three follow-up job ids");

  markPromiseScheduled(atPromise.id, atJobs.primaryJobId, base + 2_000);
  for (const jobId of atJobs.followUpJobIds) {
    appendPromiseFollowUpJob(atPromise.id, jobId);
  }
  const stateAfterSchedule = readState();
  const persistedAt = stateAfterSchedule.promises[atPromise.id];
  assert.equal(persistedAt.cronJobId, "job-1", "primary job id should persist separately");
  assert.equal(persistedAt.followUpJobIds.length, 3, "follow-up job ids should persist separately");
  assert.equal(persistedAt.state, "scheduled", "scheduled promise should have scheduled state");
  assert.equal(typeof persistedAt.scheduledAt, "number", "scheduled promise should expose scheduledAt");

  const atInvocations = readCronInvocations();
  assert.equal(atInvocations.length, 4, "at promise should create one primary and three follow-up cron jobs");
  assert.ok(atInvocations.some((args) => args.some((arg) => arg.includes("asuka-hard-followup-1"))), "cron args should include followup-1 job name");
  assert.ok(atInvocations.some((args) => args.some((arg) => arg.includes("asuka-hard-followup-2"))), "cron args should include followup-2 job name");
  assert.ok(atInvocations.some((args) => args.some((arg) => arg.includes("asuka-hard-followup-3"))), "cron args should include followup-3 job name");

  const cronPromise = createPromise("我会每天早上九点给你发早安。", 10_000);
  assert.equal(cronPromise.schedule?.kind, "cron", "daily promise should have a cron schedule");
  const cronJobs = await schedulePromiseJobs(cronPromise);
  assert.ok("primaryJobId" in cronJobs, "cron scheduling should succeed through stubbed openclaw");
  assert.equal(cronJobs.primaryJobId, "job-5", "cron scheduling should return primary job id");
  assert.equal(cronJobs.followUpJobIds.length, 0, "cron scheduling should not create follow-up jobs");
  const allInvocations = readCronInvocations();
  assert.equal(allInvocations.length, 5, "cron promise should add one more cron invocation");
  assert.ok(allInvocations[4].includes("--cron"), "cron scheduling args should include --cron");

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
