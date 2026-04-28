import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-promise-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const base = Date.UTC(2026, 3, 26, 0, 0, 0);
const stateFile = path.join(tmpHome, ".openclaw", "qqbot", "data", "asuka-state", "state.json");

const direct = {
  accountId: "acct-test",
  peerKind: "direct",
  peerId: "user-promise",
  senderId: "user-promise",
  target: "c2c:user-promise",
  messageId: "promise-m-1",
};

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

function assertNoPayloadArtifacts(value, label) {
  assert.doesNotMatch(value, /QQBOT_(?:PAYLOAD|CRON)/, label);
}

try {
  const { parseAssistantPromises } = await import("../dist/src/promise-parser.js");
  const {
    appendPromiseFollowUpJob,
    buildAsukaStatePrompt,
    cancelPromisesFromUserMessage,
    markPromiseScheduled,
    recordAssistantReply,
  } = await import("../dist/src/asuka-state.js");

  const parse = (text) => parseAssistantPromises(text, {
    now: new Date(base),
    timeZone: "Asia/Shanghai",
  });

  const hardText = "拉钩，明天早上九点我来找你说早安。";
  const hardParsed = parse(hardText);
  assert.equal(hardParsed.length, 1, "hard trigger should parse one durable promise");
  assert.equal(hardParsed[0].triggerKind, "hard", "hard trigger should keep trigger kind");
  assert.equal(hardParsed[0].schedule?.kind, "at", "hard promise should derive an at schedule");

  const hardCreated = recordAssistantReply(direct, hardText, hardParsed, base + 1_000);
  assert.equal(hardCreated.length, 1, "hard trigger should persist one promise");

  const softText = "晚点我给你发自拍。";
  const softParsed = parse(softText);
  assert.equal(softParsed.length, 1, "actionable soft promise should parse one record");
  assert.equal(softParsed[0].triggerKind, "soft", "soft promise should keep trigger kind");
  assert.equal(softParsed[0].deliveryKind, "selfie", "selfie promise should infer selfie delivery");
  assert.equal(softParsed[0].schedule?.kind, "at", "soft promise should derive an at schedule");

  const softCreated = recordAssistantReply(direct, softText, softParsed, base + 2_000);
  assert.equal(softCreated.length, 1, "actionable soft promise should persist one record");

  assert.equal(
    parse("如果你想的话，我明天给你发早安可以吗？").length,
    0,
    "tentative soft phrasing should not create promises",
  );

  const duplicateText = "约定，明天早上九点我来找你说早安。";
  const duplicateParsed = parse(duplicateText);
  assert.equal(duplicateParsed.length, 1, "semantic duplicate text should still parse");
  const duplicateCreated = recordAssistantReply(direct, duplicateText, duplicateParsed, base + 60_000);
  assert.equal(duplicateCreated.length, 0, "semantic duplicate should not be returned for rescheduling");

  const stateAfterDuplicate = readState();
  const morningPromises = Object.values(stateAfterDuplicate.promises).filter((promise) =>
    promise.peerKey === "acct-test:direct:user-promise" && promise.semanticKey?.includes("good_morning")
  );
  assert.equal(morningPromises.length, 1, "duplicate semantic promise should leave one persisted active record");
  assert.ok((morningPromises[0].duplicateCount ?? 0) >= 1, "duplicate record should expose duplicate metadata");

  markPromiseScheduled(softCreated[0].id, "job-primary");
  appendPromiseFollowUpJob(softCreated[0].id, "job-follow-1");
  const cancelled = cancelPromisesFromUserMessage(direct, "不用发自拍了", base + 120_000);
  assert.equal(cancelled.cancelledPromises.length, 1, "selfie cancellation should cancel the matching promise");
  assert.equal(cancelled.cancelledPromises[0].id, softCreated[0].id, "selfie cancellation should target the selfie promise");
  assert.deepEqual(
    cancelled.cronJobIds,
    ["job-primary", "job-follow-1"],
    "cancellation should return primary and follow-up cron job IDs",
  );

  for (const artifactText of [
    '拉钩，明天晚上我给你发消息。 QQBOT_PAYLOAD: {"internal":true}',
    "约定，今晚我给你发消息。 QQBOT_CRON: */5 * * * *",
  ]) {
    const parsed = parse(artifactText);
    assert.equal(parsed.length, 1, "payload-bearing promise text should still parse after sanitization");
    const created = recordAssistantReply(direct, artifactText, parsed, base + 180_000);
    assert.equal(created.length, 1, "payload-bearing promise text should persist sanitized content");
    assertNoPayloadArtifacts(created[0].promiseText, "persisted promise text should not include payload artifacts");
    assertNoPayloadArtifacts(created[0].sourceAssistantText, "persisted source text should not include payload artifacts");
  }

  assertNoPayloadArtifacts(
    buildAsukaStatePrompt(direct, base + 240_000),
    "state prompt should not expose payload artifacts",
  );

  console.log("[qqbot:test] asuka-promise fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
