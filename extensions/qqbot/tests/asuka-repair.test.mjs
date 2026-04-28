import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-repair-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const base = Date.UTC(2026, 3, 26, 0, 0, 0);

function directContext(peerId, messageId) {
  return {
    accountId: "acct-test",
    peerKind: "direct",
    peerId,
    senderId: peerId,
    target: `c2c:${peerId}`,
    messageId,
  };
}

try {
  const { parseAssistantPromises } = await import("../dist/src/promise-parser.js");
  const { recordAsukaLongTermMemoryFromAssistantReply } = await import("../dist/src/asuka-memory.js");
  const {
    appendPromiseFollowUpJob,
    cancelPromisesFromUserMessage,
    markPromiseDelivered,
    markPromiseScheduled,
    markPromiseScheduleFailed,
    prepareAmbientLifePayload,
    prepareRepairDelivery,
    recordAssistantReply,
    recordInboundInteraction,
    shouldSendPromiseFollowUp,
  } = await import("../dist/src/asuka-state.js");

  const parse = (text) => parseAssistantPromises(text, {
    now: new Date(base),
    timeZone: "Asia/Shanghai",
  });

  function createPromise(context, text, offsetMs) {
    const parsed = parse(text);
    assert.equal(parsed.length, 1, `${text} should parse one promise`);
    const created = recordAssistantReply(
      { ...context, messageId: `${context.messageId}-${offsetMs}` },
      text,
      parsed,
      base + offsetMs,
    );
    assert.equal(created.length, 1, `${text} should persist one promise`);
    return created[0];
  }

  const repairContext = directContext("user-repair", "repair-m-1");
  assert.equal(
    recordAsukaLongTermMemoryFromAssistantReply(repairContext, "我今天在学校拍视频素材，晚点整理镜头。", base + 500),
    true,
    "self-life memory should be available before repair priority check",
  );
  const failedPromise = createPromise(repairContext, "约定，明天早上九点我来找你说早安。", 1_000);
  markPromiseScheduleFailed(failedPromise.id, "cron add failed", base + 1_500);
  const repair = prepareRepairDelivery(repairContext, base + 2_000);
  assert.ok(repair, "repair payload should exist for a schedule-failed promise");
  assert.equal(repair.promiseId, failedPromise.id, "repair should target the failed promise");
  assert.equal(repair.advancePolicy, "hold", "repair should hold scene advancement");
  assert.match(repair.content, /没接住|补/, "repair content should acknowledge the miss lightly");
  const ambientRepair = prepareAmbientLifePayload(repairContext, base + 2_000);
  assert.equal(ambientRepair.mode, "repair", "ambient payload should directly surface repair candidates");
  assert.equal(ambientRepair.promiseId, failedPromise.id, "ambient repair should keep the promise id");
  assert.equal(ambientRepair.advancePolicy, "hold", "ambient repair should hold scene advancement");
  assert.match(ambientRepair.content, /没接住|补/, "ambient repair content should stay repair-oriented");

  const followContext = directContext("user-follow-limit", "repair-m-2");
  const followPromise = createPromise(followContext, "拉钩，明天早上九点我来找你说早安。", 10_000);
  markPromiseScheduled(followPromise.id, "job-follow-primary", base + 10_500);
  appendPromiseFollowUpJob(followPromise.id, "job-follow-1");
  appendPromiseFollowUpJob(followPromise.id, "job-follow-2");
  appendPromiseFollowUpJob(followPromise.id, "job-follow-3");
  markPromiseDelivered(followPromise.id, { at: base + 11_000, content: "早安" });
  assert.equal(shouldSendPromiseFollowUp(followPromise.id, base, base + 11_500), true, "first follow-up should be allowed");
  markPromiseDelivered(followPromise.id, { at: base + 12_000, isFollowUp: true, content: "早安，还在吗" });
  assert.equal(shouldSendPromiseFollowUp(followPromise.id, base, base + 12_500), true, "second follow-up should be allowed");
  markPromiseDelivered(followPromise.id, { at: base + 13_000, isFollowUp: true, content: "我再轻轻补一句" });
  assert.equal(shouldSendPromiseFollowUp(followPromise.id, base, base + 13_500), true, "third follow-up should be allowed");
  markPromiseDelivered(followPromise.id, { at: base + 14_000, isFollowUp: true, content: "最后提醒一次" });
  assert.equal(shouldSendPromiseFollowUp(followPromise.id, base, base + 14_500), false, "follow-up should stop after three successful attempts");

  const replyContext = directContext("user-follow-reply", "repair-m-3");
  const replyPromise = createPromise(replyContext, "拉钩，明天晚上我来找你说晚安。", 20_000);
  markPromiseScheduled(replyPromise.id, "job-reply-primary", base + 20_500);
  appendPromiseFollowUpJob(replyPromise.id, "job-reply-follow");
  markPromiseDelivered(replyPromise.id, { at: base + 21_000, content: "晚安" });
  recordInboundInteraction(replyContext, "我看到了", base + 22_000);
  assert.equal(shouldSendPromiseFollowUp(replyPromise.id, base, base + 23_000), false, "follow-up should stop after user reply");

  const cancelContext = directContext("user-follow-cancel", "repair-m-4");
  const selfiePromise = createPromise(cancelContext, "晚点我给你发自拍。", 30_000);
  markPromiseScheduled(selfiePromise.id, "job-selfie-primary", base + 30_500);
  appendPromiseFollowUpJob(selfiePromise.id, "job-selfie-follow");
  const cancelled = cancelPromisesFromUserMessage(cancelContext, "不用发自拍了", base + 31_000);
  assert.equal(cancelled.cancelledPromises.length, 1, "selfie promise should be cancelled");
  assert.equal(shouldSendPromiseFollowUp(selfiePromise.id, base, base + 32_000), false, "follow-up should stop after cancellation");

  console.log("[qqbot:test] asuka-repair fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
