import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-ref-index-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  getEntriesForPeerSince,
  getRecentEntriesForPeer,
  setRefIndex,
} = await import("../dist/src/ref-index-store.js");

try {
  const dayMs = 24 * 60 * 60 * 1000;
  const base = Date.now();

  setRefIndex("old", {
    content: "八天前",
    senderId: "user-1",
    peerId: "peer-1",
    timestamp: base - 8 * dayMs,
  });
  setRefIndex("week-start", {
    content: "七天内第一条",
    senderId: "user-1",
    peerId: "peer-1",
    timestamp: base - 7 * dayMs + 1_000,
  });
  setRefIndex("assistant-latest", {
    content: "最新回复",
    senderId: "bot",
    peerId: "peer-1",
    timestamp: base + 1_000,
    isBot: true,
  });
  setRefIndex("other-peer", {
    content: "其他会话",
    senderId: "user-2",
    peerId: "peer-2",
    timestamp: base + 2_000,
  });

  const weekEntries = getEntriesForPeerSince("peer-1", base - 7 * dayMs);
  assert.deepEqual(
    weekEntries.map((entry) => entry.content),
    ["七天内第一条", "最新回复"],
    "按时间窗口读取时应包含最近一周同会话消息并排除更旧消息",
  );

  const limitedEntries = getEntriesForPeerSince("peer-1", base - 7 * dayMs, 1);
  assert.deepEqual(
    limitedEntries.map((entry) => entry.content),
    ["最新回复"],
    "maxEntries 超限时应保留最新消息",
  );

  const recentEntries = getRecentEntriesForPeer("peer-1", 2);
  assert.deepEqual(
    recentEntries.map((entry) => entry.content),
    ["七天内第一条", "最新回复"],
    "原有按数量读取接口行为应保持不变",
  );
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
