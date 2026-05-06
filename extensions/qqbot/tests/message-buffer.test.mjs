import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-message-buffer-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { mergeBufferedQueuedMessages } = await import("../dist/src/gateway.js");

const first = {
  type: "c2c",
  senderId: "user-1",
  content: "第一句",
  messageId: "msg-1",
  timestamp: "2026-05-06T14:00:00+08:00",
  msgIdx: "REFIDX_1",
};

const second = {
  type: "c2c",
  senderId: "user-1",
  content: "第二句",
  messageId: "msg-2",
  timestamp: "2026-05-06T14:00:03+08:00",
  attachments: [{ content_type: "image/png", url: "https://example.test/a.png", filename: "a.png" }],
  refMsgIdx: "REFIDX_QUOTED",
  msgIdx: "REFIDX_2",
};

const merged = mergeBufferedQueuedMessages([first, second]);

assert.equal(merged.content, "第一句\n第二句", "buffered text should preserve order and concatenate with newlines");
assert.equal(merged.messageId, "msg-2", "merged event should reply to the latest platform message");
assert.equal(merged.timestamp, second.timestamp, "merged event should keep the latest timestamp");
assert.equal(merged.refMsgIdx, "REFIDX_QUOTED", "merged event should keep the latest quote reference");
assert.equal(merged.msgIdx, "REFIDX_2", "merged event should keep the latest message index");
assert.equal(merged.attachments.length, 1, "merged event should carry attachments from buffered messages");
assert.equal(merged.bufferedMessages.length, 2, "merged event should keep source messages for ref-index caching");
assert.equal(merged.bufferedMessages[0].msgIdx, "REFIDX_1");
assert.equal(merged.bufferedMessages[1].msgIdx, "REFIDX_2");

assert.throws(
  () => mergeBufferedQueuedMessages([]),
  /empty message buffer/,
  "empty buffers should be rejected",
);

console.log("message-buffer tests passed");
