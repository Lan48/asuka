import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-memory-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const dayMs = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 3, 26, 0, 0, 0);
const memoryFile = path.join(tmpHome, ".openclaw", "qqbot", "data", "asuka-memory", "memory.json");

const direct = {
  accountId: "acct-test",
  peerKind: "direct",
  peerId: "user-a",
  senderId: "user-a",
  senderName: "User A",
  target: "c2c:user-a",
  messageId: "m-1",
};

const group = {
  ...direct,
  peerKind: "group",
  peerId: "group-a",
  target: "group:group-a",
};

function assertIncludes(value, fragment, label) {
  assert.match(value, new RegExp(fragment), label);
}

function assertExcludes(value, fragment, label) {
  assert.doesNotMatch(value, new RegExp(fragment), label);
}

function readMemoryState() {
  return JSON.parse(fs.readFileSync(memoryFile, "utf-8"));
}

try {
  const {
    buildAsukaLongTermMemoryPrompt,
    buildAsukaProactiveMemoryPrompt,
    handleAsukaMemoryControlMessage,
    recordAsukaLongTermMemoryFromAssistantReply,
    recordAsukaLongTermMemoryFromUserMessage,
  } = await import("../dist/src/asuka-memory.js");

  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢晚上喝热美式。", base),
    true,
    "direct explicit preference should be captured",
  );

  const directPrompt = buildAsukaLongTermMemoryPrompt(direct, "我晚上喝什么比较提神", base + 1_000);
  assertIncludes(directPrompt, "Asuka 长期记忆", "direct prompt should include memory section");
  assertIncludes(directPrompt, "热美式", "direct prompt should include captured preference");
  assert.equal(
    buildAsukaLongTermMemoryPrompt(group, "我晚上喝什么比较提神", base + 1_000),
    "",
    "group prompt must not include direct memory",
  );

  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "记住我的 token 是 sk-test-secret", base + 2_000),
    false,
    "secret-like text should not be captured",
  );
  assertExcludes(
    buildAsukaLongTermMemoryPrompt(direct, "", base + 3_000),
    "sk-test-secret|token",
    "secret-like text should not appear in prompts",
  );

  const listReply = handleAsukaMemoryControlMessage(direct, "你都记得我什么", base + 4_000);
  assert.equal(listReply.handled, true, "memory list command should be handled");
  assert.equal(listReply.action, "list", "memory list command should report list action");
  assertIncludes(listReply.replyText ?? "", "热美式", "memory list should show captured preference");

  assert.equal(
    handleAsukaMemoryControlMessage(direct, "长期记忆怎么做比较好", base + 5_000).handled,
    false,
    "bare long-term memory discussion should not trigger list control",
  );
  assert.equal(
    handleAsukaMemoryControlMessage(direct, "我忘了今天吃药", base + 6_000).handled,
    false,
    "plain user narration with 忘了 should not trigger forget control",
  );

  const forgetReply = handleAsukaMemoryControlMessage(direct, "忘记关于热美式的记忆", base + 7_000);
  assert.equal(forgetReply.handled, true, "specific forget command should be handled");
  assert.equal(forgetReply.action, "forget", "specific forget command should report forget action");
  assert.ok((forgetReply.changed ?? 0) > 0, "specific forget command should delete at least one memory");
  assertExcludes(
    buildAsukaLongTermMemoryPrompt(direct, "", base + 8_000),
    "热美式",
    "forgotten memory should not be recalled",
  );

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我住在杭州。", base + 9_000), true);
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我住在上海。", base + 10_000), true);
  const locationPrompt = buildAsukaLongTermMemoryPrompt(direct, "你还记得我住哪吗", base + 11_000);
  assertIncludes(locationPrompt, "上海", "newer location should be recalled");
  assertExcludes(locationPrompt, "杭州", "superseded location should not be recalled");

  const categoryReply = handleAsukaMemoryControlMessage(direct, "看看记忆分类", base + 11_200);
  assert.equal(categoryReply.handled, true, "memory category command should be handled");
  assert.equal(categoryReply.action, "list", "memory category command should report list action");
  assertIncludes(categoryReply.replyText ?? "", "关于你|偏好和边界|我们聊过的事", "memory category reply should stay user-facing");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢晚上喝乌龙茶。", base + 11_400), true);
  const importantReply = handleAsukaMemoryControlMessage(direct, "把乌龙茶标为重要", base + 11_600);
  assert.equal(importantReply.handled, true, "important marker should be handled");
  assert.equal(importantReply.action, "mark_important", "important marker should report action");
  assert.ok((importantReply.changed ?? 0) > 0, "important marker should update at least one memory");
  const importantState = readMemoryState();
  const teaMemory = Object.values(importantState.memories).find((item) => item.text.includes("乌龙茶"));
  assert.ok(teaMemory, "important memory target should exist");
  assert.equal(teaMemory.importance, "important", "important marker should persist");
  assert.ok(teaMemory.salience >= 10, "important marker should raise salience");
  const importantListReply = handleAsukaMemoryControlMessage(direct, "你都记得我什么", base + 11_800);
  assertIncludes(importantListReply.replyText ?? "", "乌龙茶.*重要", "list reply should show important flag naturally");

  const clearImportantReply = handleAsukaMemoryControlMessage(direct, "乌龙茶不重要了", base + 12_000);
  assert.equal(clearImportantReply.handled, true, "clear importance command should be handled");
  assert.equal(clearImportantReply.action, "clear_importance", "clear importance should report action");
  const normalState = readMemoryState();
  const normalTeaMemory = Object.values(normalState.memories).find((item) => item.text.includes("乌龙茶"));
  assert.equal(normalTeaMemory.importance, "normal", "clear importance should persist normal importance");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "今天准备整理签证材料", base + 12_200), true);
  const temporaryReply = handleAsukaMemoryControlMessage(direct, "把签证材料标为临时", base + 12_400);
  assert.equal(temporaryReply.handled, true, "temporary marker should be handled");
  assert.equal(temporaryReply.action, "mark_temporary", "temporary marker should report action");
  assert.ok((temporaryReply.changed ?? 0) > 0, "temporary marker should update at least one memory");
  const temporaryState = readMemoryState();
  const visaMemory = Object.values(temporaryState.memories).find((item) => item.text.includes("签证材料"));
  assert.equal(visaMemory.temporary, true, "temporary marker should persist");
  assert.ok(visaMemory.expiresAt <= base + 12_400 + 8 * dayMs, "temporary marker should bound expiry");
  assertIncludes(
    buildAsukaLongTermMemoryPrompt(direct, "签证材料", base + 12_500),
    "签证材料",
    "temporary memory should remain available before expiry",
  );
  assertExcludes(
    buildAsukaLongTermMemoryPrompt(direct, "签证材料", base + 9 * dayMs),
    "签证材料",
    "temporary memory should expire predictably",
  );

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "今天准备去咖啡店写东西", base + 12_000), true);
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "明天计划看电影", base + 13_000), true);
  const thesisPrompt = buildAsukaLongTermMemoryPrompt(direct, "论文答辩我该怎么准备", base + 8 * dayMs);
  assertExcludes(thesisPrompt, "咖啡店|电影", "stale unrelated transient memories should be filtered");

  assert.equal(
    recordAsukaLongTermMemoryFromAssistantReply(direct, "我今天准备在西湖边拍照，晚点再给你看。", base + 14_000),
    true,
    "assistant self-thread should be captured when concrete and current",
  );
  const selfThreadPrompt = buildAsukaLongTermMemoryPrompt(direct, "你今天做什么", base + 15_000);
  assertIncludes(selfThreadPrompt, "西湖边拍照", "recent assistant self-thread should be recalled");
  const selfThreadState = readMemoryState();
  const selfThread = Object.values(selfThreadState.memories).find((item) => item.text.includes("西湖边拍照"));
  assert.ok(selfThread, "assistant self-thread should be persisted");
  assert.equal(selfThread.type, "asuka_self_thread", "assistant self-thread should have a dedicated type");
  assert.equal(selfThread.source, "assistant_self_thread", "assistant self-thread should preserve source");
  assert.equal(selfThread.lifeEventKind, "media_work", "assistant self-thread should derive a life event kind");
  assert.equal(typeof selfThread.confidence, "number", "assistant self-thread should expose confidence");
  assert.ok(selfThread.freshnessUntil > selfThread.updatedAt, "assistant self-thread should expose freshness metadata");
  assert.ok(selfThread.expiresAt > selfThread.freshnessUntil, "assistant self-thread should expose expiry metadata");

  assert.equal(
    recordAsukaLongTermMemoryFromAssistantReply(direct, "我其实一直更喜欢安静一点地靠近你，会认真对你。", base + 15_500),
    true,
    "assistant self signal should be captured when stable and bounded",
  );
  const selfSignalState = readMemoryState();
  const selfSignal = Object.values(selfSignalState.memories).find((item) => item.type === "asuka_self_signal");
  assert.ok(selfSignal, "assistant self signal should be persisted");
  assert.equal(selfSignal.source, "assistant_self_signal", "assistant self signal should preserve source");
  assert.equal(selfSignal.continuityKind, "preference", "assistant self signal should derive continuity kind");
  assert.match(selfSignal.key, /asuka:preference:closeness/, "assistant self signal should derive a stable key");
  assert.ok(selfSignal.expiresAt > selfSignal.updatedAt, "assistant self signal should stay bounded by expiry");
  const selfhoodPrompt = buildAsukaLongTermMemoryPrompt(direct, "你喜欢怎么靠近我", base + 15_600);
  assertIncludes(selfhoodPrompt, "Asuka 自我生活线和稳定偏好", "direct prompt should label selfhood context explicitly");
  assertIncludes(selfhoodPrompt, "靠近你", "direct prompt should include relevant self signal");
  assertIncludes(selfhoodPrompt, "自我生活线只作为轻量连续性线索", "direct prompt should bound selfhood usage");
  assertIncludes(selfhoodPrompt, "承诺/补救", "direct prompt should preserve promise repair priority guidance");

  assert.equal(
    recordAsukaLongTermMemoryFromAssistantReply(group, "我今天在学校拍视频素材，晚点整理镜头。", base + 15_800),
    false,
    "group context should not persist assistant self-life state",
  );

  for (let i = 0; i < 20; i++) {
    assert.equal(
      recordAsukaLongTermMemoryFromAssistantReply(
        direct,
        `我今天在学校拍视频素材 ${i}，晚点整理镜头。`,
        base + 16_000 + i,
      ),
      true,
      "assistant self-thread cap fixture should capture concrete events",
    );
  }
  const cappedSelfState = readMemoryState();
  const activeSelfThreads = Object.values(cappedSelfState.memories)
    .filter((item) => item.type === "asuka_self_thread" && (item.status ?? "active") === "active");
  assert.ok(activeSelfThreads.length <= 12, "assistant self-thread records should stay capped per peer");

  const proactivePrompt = buildAsukaProactiveMemoryPrompt(direct, "上海天气", base + 16_000);
  assertIncludes(proactivePrompt, "主动触达", "proactive prompt should include proactive guidance");
  assertIncludes(proactivePrompt, "ambient/self_thread", "proactive prompt should include selfhood-specific guidance");
  assertIncludes(proactivePrompt, "承诺/补救优先", "proactive prompt should keep promise repair priority");
  assertIncludes(proactivePrompt, "上海", "proactive prompt should include safe direct memory context");
  assert.equal(
    buildAsukaProactiveMemoryPrompt(group, "上海天气", base + 16_000),
    "",
    "group proactive prompt must not include direct memory",
  );

  console.log("[qqbot:test] asuka-memory fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
