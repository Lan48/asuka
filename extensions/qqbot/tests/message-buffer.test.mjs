import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-message-buffer-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { looksLikeInternalProcessLeak, mergeBufferedQueuedMessages, parseVoiceReplySuffix } = await import("../dist/src/gateway.js");
const { looksLikeInternalDeliveryLeak } = await import("../dist/src/outbound.js");

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

assert.deepEqual(
  parseVoiceReplySuffix("想听你说晚安~"),
  { text: "想听你说晚安", forceVoiceReply: true },
  "ASCII tilde suffix should request a voice reply and be stripped from user text",
);

assert.deepEqual(
  parseVoiceReplySuffix("普通波浪号～"),
  { text: "普通波浪号～", forceVoiceReply: false },
  "fullwidth wave dash should remain normal text",
);

assert.throws(
  () => mergeBufferedQueuedMessages([]),
  /empty message buffer/,
  "empty buffers should be rejected",
);

const selfieReply = `QQBOT_PAYLOAD: {"type":"selfie","caption":"被太阳抓到了……"}

（眯着眼睛，拿手挡了一下从窗帘缝钻进来的光线）

……哪有晒屁股……明明离窗边还有半米远。你就是想叫我起床吧。`;

assert.equal(
  looksLikeInternalProcessLeak(selfieReply),
  false,
  "valid QQBOT_PAYLOAD with natural visible text should not be treated as an internal leak",
);

assert.equal(
  looksLikeInternalProcessLeak('QQBOT_PAYLOAD: {"internal":true}'),
  true,
  "invalid payload artifacts should still be treated as internal leaks",
);

assert.equal(
  looksLikeInternalProcessLeak('QQBOT_PAYLOAD: {"type":"selfie"}\n\n现在让我调用 API 发送图片。'),
  true,
  "valid payloads should not hide actual internal-process wording in visible text",
);

assert.equal(
  looksLikeInternalProcessLeak(`# 2026-05-15 周五

## 日常
- 早上睡醒黏在一起

## 记忆整理
- 用户说过一些需要长期保留的事

## 待办
- 明天继续整理`),
  true,
  "memory maintenance markdown should be suppressed as an internal leak",
);

assert.equal(
  looksLikeInternalProcessLeak("写入 memory/2026-05-15.md"),
  true,
  "memory write status should be suppressed as an internal leak",
);

assert.equal(
  looksLikeInternalDeliveryLeak('QQBOT_PAYLOAD: {"type":"media","mediaType":"audio","source":"file","path":"我在呢。","tts":{"emotion":"soft"}}'),
  false,
  "valid structured payloads should be routed as media instead of suppressed as delivery leaks",
);

assert.equal(
  looksLikeInternalDeliveryLeak('QQBOT_PAYLOAD: {"internal":true}'),
  true,
  "invalid structured payload artifacts should still be suppressed in outbound delivery",
);

for (const leakedOutboundText of [
  'Reasoning:\n_The user is reacting with "?" to my previous silent acknowledgement._',
  "⏳ 已收到，正在处理中…",
  "I need to exec to write a file",
]) {
  assert.equal(
    looksLikeInternalDeliveryLeak(leakedOutboundText),
    true,
    `outbound should suppress internal leak text: ${leakedOutboundText.slice(0, 40)}`,
  );
}

console.log("message-buffer tests passed");
