import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-time-context-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const direct = {
  accountId: "acct-test",
  peerKind: "direct",
  peerId: "user-time-context",
  senderId: "user-time-context",
  target: "c2c:user-time-context",
  messageId: "time-m-1",
};

try {
  const {
    buildAsukaStatePrompt,
    makePeerKey,
    markProactiveDelivered,
    recordAssistantReply,
    recordInboundInteraction,
  } = await import("../dist/src/asuka-state.js");

  const morning = Date.UTC(2026, 4, 11, 1, 0, 0); // 09:00 Asia/Shanghai
  const afternoon = Date.UTC(2026, 4, 11, 6, 50, 0); // 14:50 Asia/Shanghai

  recordInboundInteraction(direct, "早上吃早餐吗", morning);
  recordAssistantReply(
    direct,
    "（坐在早餐桌边，用筷子蘸了蘸醋碟，然后抬眼看你）嗯，还想和你多待一会儿。",
    [],
    morning + 1_000,
  );
  markProactiveDelivered(makePeerKey(direct), {
    content: "（放下筷子，把椅子往你那边挪了挪，胳膊肘轻轻搭在桌沿上）突然又想到你。",
    at: afternoon - 50 * 60 * 1000,
  });
  recordInboundInteraction(direct, "那？", afternoon - 9_000);
  recordAssistantReply(
    direct,
    "（被你一个“那？”问得笑了一下，筷子在醋碟里戳了戳，然后抬眼看你）……那什么那。",
    [],
    afternoon - 1_000,
  );

  const prompt = buildAsukaStatePrompt(direct, afternoon);
  assert.match(prompt, /当前本地时间: 2026-05-11 .*14:50.*下午/, "state prompt should expose local afternoon time");
  assert.doesNotMatch(prompt, /筷子|醋碟|桌沿/, "stale concrete meal actions should not be reinjected in the afternoon");
  assert.match(prompt, /生活动作线索，只作已经发生过的背景/, "stale concrete actions should decay to background guidance");
  assert.match(prompt, /旧的早餐、上午或具体生活动作/, "prompt should include a time-boundary principle");

  const lunchPeer = {
    ...direct,
    peerId: "user-time-context-lunch",
    senderId: "user-time-context-lunch",
    target: "c2c:user-time-context-lunch",
    messageId: "time-m-2",
  };
  recordInboundInteraction(lunchPeer, "午饭你在吃什么", afternoon - 2_000);
  recordAssistantReply(
    lunchPeer,
    "（把筷子放下，偏头看你）刚刚夹了一口。",
    [],
    afternoon - 1_000,
  );
  const freshPrompt = buildAsukaStatePrompt(lunchPeer, afternoon);
  assert.match(freshPrompt, /把筷子放下/, "fresh physical context should remain when the current user turn invokes the meal scene");

  console.log("[qqbot:test] asuka time-context fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
