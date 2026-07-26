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
const memoryWikiDir = path.join(tmpHome, "Asuka", "Memory");
const compiledResidenceFile = path.join(memoryWikiDir, "entities", "residence-location-timeline.md");
const compiledRelationshipFile = path.join(memoryWikiDir, "entities", "relationship-state.md");
const compiledSourceFile = path.join(memoryWikiDir, "sources", "asuka-memory-jsonl.md");
process.env.ASUKA_MEMORY_WIKI_DIR = memoryWikiDir;

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

function readWikiClaims() {
  return fs.readFileSync(path.join(memoryWikiDir, "claims.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function setSelfSignalVerdict(verdict) {
  process.env.ASUKA_SELF_SIGNAL_TEST_VERDICT = JSON.stringify(verdict);
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

  const memoryCountBeforeLowSignal = Object.keys(readMemoryState().memories).length;
  for (const [index, lowSignal] of [
    "不记得了",
    "没有吧",
    "我看看你还记不记得",
    "只记得昨天喝了很多，后面忘了",
    "你还记得我住在哪里吗？",
    "你知道我喜欢什么吗？",
  ].entries()) {
    assert.equal(
      recordAsukaLongTermMemoryFromUserMessage(direct, lowSignal, base + 3_100 + index),
      false,
      `low-information recollection should not become durable memory: ${lowSignal}`,
    );
  }
  assert.equal(
    Object.keys(readMemoryState().memories).length,
    memoryCountBeforeLowSignal,
    "low-information recollection must not change the memory store",
  );
  assert.doesNotMatch(
    readWikiClaims().map((claim) => claim.value).join("\n"),
    /不记得了|没有吧|还记不记得|只记得昨天/,
    "low-information recollection must not enter Memory Wiki claims",
  );
  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "请记得我不喜欢被叫老板。", base + 3_200),
    true,
    "clear positive memory instruction should still be captured",
  );
  const explicitBoundary = Object.values(readMemoryState().memories)
    .find((item) => item.text.includes("不喜欢被叫老板"));
  assert.equal(explicitBoundary?.type, "boundary", "explicit stable boundary should retain its semantic type");
  assert.equal(explicitBoundary?.source, "user_explicit", "positive memory instruction should remain explicit");
  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "明日香，记得我的项目代号是 Aurora。", base + 3_300),
    true,
    "sentence-initial 记得 command should be captured",
  );
  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "别忘了我下周要复诊。", base + 3_400),
    true,
    "别忘了 command should be captured",
  );

  assert.equal(
    handleAsukaMemoryControlMessage(direct, "你都记得我什么", base + 4_000).handled,
    false,
    "bare memory list wording should stay ordinary chat without sudo",
  );
  const listReply = handleAsukaMemoryControlMessage(direct, "sudo 你都记得我什么", base + 4_100);
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
  assert.equal(
    handleAsukaMemoryControlMessage(direct, "这你怎么忍心删掉？", base + 6_500).handled,
    false,
    "daily chat with 删除-like wording should not trigger memory control without sudo",
  );
  const sudoDailyDeleteReply = handleAsukaMemoryControlMessage(direct, "sudo 这你怎么忍心删掉？", base + 6_600);
  assert.equal(sudoDailyDeleteReply.handled, true, "sudo should opt into memory control parsing");
  assert.equal(sudoDailyDeleteReply.action, "forget", "sudo delete-like wording should report forget action");
  assert.equal(sudoDailyDeleteReply.changed, 0, "unmatched sudo delete-like wording should not change memory");
  assertIncludes(
    sudoDailyDeleteReply.replyText ?? "",
    "这你怎么忍心",
    "sudo delete-like fallback should use the stripped command query",
  );
  assertIncludes(
    buildAsukaLongTermMemoryPrompt(direct, "", base + 6_700),
    "热美式",
    "unmatched sudo delete-like wording should not delete unrelated memory",
  );

  assert.equal(
    handleAsukaMemoryControlMessage(direct, "忘记关于热美式的记忆", base + 7_000).handled,
    false,
    "bare forget command should stay ordinary chat without sudo",
  );
  const forgetReply = handleAsukaMemoryControlMessage(direct, "sudo 忘记关于热美式的记忆", base + 7_100);
  assert.equal(forgetReply.handled, true, "specific forget command should be handled");
  assert.equal(forgetReply.action, "forget", "specific forget command should report forget action");
  assert.ok((forgetReply.changed ?? 0) > 0, "specific forget command should delete at least one memory");
  assertExcludes(
    buildAsukaLongTermMemoryPrompt(direct, "", base + 8_000),
    "热美式",
    "forgotten memory should not be recalled",
  );
  const forgottenCoffee = readWikiClaims().find((claim) => claim.value.includes("热美式"));
  assert.equal(forgottenCoffee?.status, "forgotten", "forgotten memory should be retained as a wiki claim");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我住在杭州。", base + 9_000), true);
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我住在上海。", base + 10_000), true);
  const locationPrompt = buildAsukaLongTermMemoryPrompt(direct, "你还记得我住哪吗", base + 11_000);
  assertIncludes(locationPrompt, "上海", "newer location should be recalled");
  assertExcludes(locationPrompt, "杭州", "superseded location should not be recalled");
  const residenceClaims = readWikiClaims().filter((claim) => claim.property === "residence");
  const hangzhouClaim = residenceClaims.find((claim) => claim.value.includes("杭州"));
  const shanghaiClaim = residenceClaims.find((claim) => claim.value.includes("上海"));
  assert.equal(hangzhouClaim?.scope, "home-base", "ordinary residence should use home-base scope");
  assert.equal(hangzhouClaim?.status, "superseded", "old home-base should remain in residence history");
  assert.equal(shanghaiClaim?.status, "current", "new home-base should be current");
  assert.deepEqual(shanghaiClaim?.supersedes, [hangzhouClaim?.id], "new home-base should link to the superseded claim");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我暑假暂住苏州。", base + 10_100), true);
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我现在在南京。", base + 10_200), true);
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我计划下月搬到北京。", base + 10_300), true);
  const scopedResidenceClaims = readWikiClaims().filter((claim) => claim.property === "residence");
  assert.equal(
    scopedResidenceClaims.find((claim) => claim.value.includes("苏州"))?.scope,
    "temporary-stay",
    "temporary residence should not replace home-base",
  );
  assert.equal(
    scopedResidenceClaims.find((claim) => claim.value.includes("南京"))?.scope,
    "current-presence",
    "current presence should stay separate from residence",
  );
  assert.equal(
    scopedResidenceClaims.find((claim) => claim.value.includes("北京"))?.status,
    "planned",
    "future move should be a planned claim",
  );
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我们已经开始同居。", base + 10_350), true);
  const compiledResidence = fs.readFileSync(compiledResidenceFile, "utf-8");
  const compiledRelationshipBeforeNotes = fs.readFileSync(compiledRelationshipFile, "utf-8");
  assertIncludes(compiledResidence, "pageType: entity", "wiki bridge should write compilable topic pages");
  assertIncludes(compiledResidence, "claims:", "wiki claims must live in structured frontmatter");
  assertIncludes(compiledResidence, "source\\.asuka-memory-jsonl", "compiled topics should declare page-level provenance");
  assertIncludes(compiledResidence, "user\\.residence \\[home-base\\].*上海", "residence topic should expose the current residence claim");
  assertIncludes(compiledRelationshipBeforeNotes, "relationship\\.relationship \\[general\\].*同居", "relationship topic should expose the cohabitation claim");
  assertIncludes(compiledRelationshipBeforeNotes, "evidence:", "compiled claims should retain structured evidence");
  assertIncludes(fs.readFileSync(compiledSourceFile, "utf-8"), "pageType: source", "wiki bridge should write the referenced source page");

  const claimsMarkdown = path.join(memoryWikiDir, "Claims.md");
  const withManualNotes = fs.readFileSync(claimsMarkdown, "utf-8").replace(
    "<!-- ASUKA_MEMORY_NOTES_START -->\n",
    "<!-- ASUKA_MEMORY_NOTES_START -->\n这段人工笔记必须保留。\n",
  );
  fs.writeFileSync(claimsMarkdown, withManualNotes, "utf-8");
  fs.writeFileSync(
    compiledRelationshipFile,
    compiledRelationshipBeforeNotes.replace(
      "<!-- openclaw:human:start -->\n",
      "<!-- openclaw:human:start -->\n这段 OpenClaw 人工笔记也必须保留。\n",
    ),
    "utf-8",
  );
  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢茉莉花茶。", base + 10_400), true);
  assertIncludes(fs.readFileSync(claimsMarkdown, "utf-8"), "这段人工笔记必须保留", "wiki sync must preserve manual Notes");
  assertIncludes(
    fs.readFileSync(compiledRelationshipFile, "utf-8"),
    "这段 OpenClaw 人工笔记也必须保留",
    "compilable Wiki page must preserve OpenClaw human Notes",
  );

  assert.equal(
    handleAsukaMemoryControlMessage(direct, "看看记忆分类", base + 11_200).handled,
    false,
    "bare memory category command should stay ordinary chat without sudo",
  );
  const categoryReply = handleAsukaMemoryControlMessage(direct, "sudo 看看记忆分类", base + 11_300);
  assert.equal(categoryReply.handled, true, "memory category command should be handled");
  assert.equal(categoryReply.action, "list", "memory category command should report list action");
  assertIncludes(categoryReply.replyText ?? "", "关于你|偏好和边界|我们聊过的事", "memory category reply should stay user-facing");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢晚上喝乌龙茶。", base + 11_400), true);
  assert.equal(
    handleAsukaMemoryControlMessage(direct, "把乌龙茶标为重要", base + 11_600).handled,
    false,
    "bare important marker should stay ordinary chat without sudo",
  );
  const importantReply = handleAsukaMemoryControlMessage(direct, "sudo 把乌龙茶标为重要", base + 11_700);
  assert.equal(importantReply.handled, true, "important marker should be handled");
  assert.equal(importantReply.action, "mark_important", "important marker should report action");
  assert.ok((importantReply.changed ?? 0) > 0, "important marker should update at least one memory");
  const importantState = readMemoryState();
  const teaMemory = Object.values(importantState.memories).find((item) => item.text.includes("乌龙茶"));
  assert.ok(teaMemory, "important memory target should exist");
  assert.equal(teaMemory.importance, "important", "important marker should persist");
  assert.ok(teaMemory.salience >= 10, "important marker should raise salience");
  const importantListReply = handleAsukaMemoryControlMessage(direct, "sudo 你都记得我什么", base + 11_800);
  assertIncludes(importantListReply.replyText ?? "", "乌龙茶.*重要", "list reply should show important flag naturally");

  assert.equal(
    handleAsukaMemoryControlMessage(direct, "乌龙茶不重要了", base + 12_000).handled,
    false,
    "bare clear-important marker should stay ordinary chat without sudo",
  );
  const clearImportantReply = handleAsukaMemoryControlMessage(direct, "sudo 乌龙茶不重要了", base + 12_100);
  assert.equal(clearImportantReply.handled, true, "clear importance command should be handled");
  assert.equal(clearImportantReply.action, "clear_importance", "clear importance should report action");
  const normalState = readMemoryState();
  const normalTeaMemory = Object.values(normalState.memories).find((item) => item.text.includes("乌龙茶"));
  assert.equal(normalTeaMemory.importance, "normal", "clear importance should persist normal importance");

  assert.equal(recordAsukaLongTermMemoryFromUserMessage(direct, "今天准备整理签证材料", base + 12_200), true);
  assert.equal(
    handleAsukaMemoryControlMessage(direct, "把签证材料标为临时", base + 12_400).handled,
    false,
    "bare temporary marker should stay ordinary chat without sudo",
  );
  const temporaryReply = handleAsukaMemoryControlMessage(direct, "sudo 把签证材料标为临时", base + 12_500);
  assert.equal(temporaryReply.handled, true, "temporary marker should be handled");
  assert.equal(temporaryReply.action, "mark_temporary", "temporary marker should report action");
  assert.ok((temporaryReply.changed ?? 0) > 0, "temporary marker should update at least one memory");
  const temporaryState = readMemoryState();
  const visaMemory = Object.values(temporaryState.memories).find((item) => item.text.includes("签证材料"));
  assert.equal(visaMemory.temporary, true, "temporary marker should persist");
  assert.ok(visaMemory.expiresAt <= base + 12_500 + 8 * dayMs, "temporary marker should bound expiry");
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
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我今天准备在西湖边拍照，晚点再给你看。", base + 14_000),
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

  setSelfSignalVerdict({
    action: "ignore",
    continuityKind: "emotional_continuity",
    personalityCategory: "communication_style",
    canonicalText: "",
    confidence: 0.1,
    targetMemoryIds: [],
    reason: "ordinary reply",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "好，我知道了。", base + 14_500),
    false,
    "ordinary direct assistant reply should go through personality verdict and be ignored when it has no stable signal",
  );

  setSelfSignalVerdict({
    action: "add",
    continuityKind: "emotional_continuity",
    personalityCategory: "attachment_style",
    canonicalText: "我更习惯慢慢靠近你，不想把距离拉得太硬。",
    confidence: 0.86,
    targetMemoryIds: [],
    reason: "stable attachment style",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我其实一直更喜欢安静一点地靠近你，会认真对你。", base + 15_500),
    true,
    "assistant self signal should be captured when stable and bounded",
  );
  const selfSignalState = readMemoryState();
  const selfSignal = Object.values(selfSignalState.memories).find((item) => item.type === "asuka_self_signal");
  assert.ok(selfSignal, "assistant self signal should be persisted");
  assert.equal(selfSignal.source, "assistant_self_signal", "assistant self signal should preserve source");
  assert.equal(selfSignal.continuityKind, "emotional_continuity", "assistant self signal should preserve verdict continuity kind");
  assert.equal(selfSignal.personalityCategory, "attachment_style", "assistant self signal should preserve personality category");
  assert.equal(selfSignal.key, `asuka:attachment_style:${selfSignal.id}`, "assistant self signal should use per-entry personality key");
  assert.ok(selfSignal.expiresAt >= base + 15_500 + 179 * dayMs, "assistant self signal should use long personality TTL");
  const selfhoodPrompt = buildAsukaLongTermMemoryPrompt(direct, "你喜欢怎么靠近我", base + 15_600);
  assertIncludes(selfhoodPrompt, "我的长期性格和相处方式", "direct prompt should label personality context explicitly");
  assertIncludes(selfhoodPrompt, "慢慢靠近你", "direct prompt should include relevant self signal");
  assertIncludes(selfhoodPrompt, "自我生活线只作为轻量连续性线索", "direct prompt should bound selfhood usage");
  assertIncludes(selfhoodPrompt, "承诺/补救", "direct prompt should preserve promise repair priority guidance");

  setSelfSignalVerdict({
    action: "add",
    continuityKind: "preference",
    personalityCategory: "communication_style",
    canonicalText: "我更喜欢把话说得自然一点，不想像机械回复。",
    confidence: 0.82,
    targetMemoryIds: [],
    reason: "stable communication style",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我一直更喜欢把话说得自然一点，不想像机械回复。", base + 15_650),
    true,
    "same category should allow multiple non-conflicting personality memories",
  );
  const multiSignalState = readMemoryState();
  const activeSignalsAfterAdd = Object.values(multiSignalState.memories)
    .filter((item) => item.type === "asuka_self_signal" && (item.status ?? "active") === "active");
  assert.ok(activeSignalsAfterAdd.length >= 2, "personality memory should allow multiple active entries");

  setSelfSignalVerdict({
    action: "ignore",
    continuityKind: "emotional_continuity",
    personalityCategory: "vulnerabilities",
    canonicalText: "",
    confidence: 0.2,
    targetMemoryIds: [],
    reason: "temporary mood",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我现在有点怕你不理我。", base + 15_700),
    false,
    "temporary self emotion should not be persisted",
  );

  const beforeUpdateState = readMemoryState();
  const attachmentBeforeUpdate = Object.values(beforeUpdateState.memories)
    .find((item) => item.type === "asuka_self_signal" && item.personalityCategory === "attachment_style" && (item.status ?? "active") === "active");
  assert.ok(attachmentBeforeUpdate, "attachment personality target should exist before update");
  setSelfSignalVerdict({
    action: "update",
    continuityKind: "emotional_continuity",
    personalityCategory: "attachment_style",
    canonicalText: "我习惯慢慢靠近你，也会认真照顾我们之间的距离。",
    confidence: 0.9,
    targetMemoryIds: [attachmentBeforeUpdate.id],
    reason: "same attachment facet",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我还是习惯慢慢靠近你，也会认真照顾距离。", base + 15_800),
    true,
    "update verdict should merge an existing personality memory",
  );
  const afterUpdateState = readMemoryState();
  const attachmentAfterUpdate = afterUpdateState.memories[attachmentBeforeUpdate.id];
  assert.match(attachmentAfterUpdate.text, /认真照顾/, "update verdict should rewrite target memory");
  assert.ok(attachmentAfterUpdate.expiresAt >= base + 15_800 + 179 * dayMs, "update verdict should refresh TTL");

  setSelfSignalVerdict({
    action: "replace",
    continuityKind: "emotional_continuity",
    personalityCategory: "attachment_style",
    canonicalText: "我现在更愿意保持一点距离，把靠近放慢。",
    confidence: 0.88,
    targetMemoryIds: [attachmentBeforeUpdate.id],
    reason: "conflicting attachment style",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我一直更愿意保持一点距离，把靠近放慢。", base + 15_900),
    true,
    "replace verdict should supersede conflicting personality memory",
  );
  const afterReplaceState = readMemoryState();
  assert.equal(afterReplaceState.memories[attachmentBeforeUpdate.id].status, "superseded", "replace verdict should supersede old target");
  assert.ok(
    Object.values(afterReplaceState.memories).some((item) => item.type === "asuka_self_signal" && item.text.includes("保持一点距离") && (item.status ?? "active") === "active"),
    "replace verdict should add the new active personality memory",
  );

  setSelfSignalVerdict({
    action: "update",
    continuityKind: "preference",
    personalityCategory: "communication_style",
    canonicalText: "我会更新一条不存在的记忆。",
    confidence: 0.7,
    targetMemoryIds: ["missing-memory-id"],
    reason: "invalid target",
  });
  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(direct, "我一直更喜欢更新一条不存在的记忆。", base + 15_950),
    false,
    "update verdict without a valid target should not create a new personality memory",
  );

  for (let i = 0; i < 5; i++) {
    setSelfSignalVerdict({
      action: "add",
      continuityKind: "preference",
      personalityCategory: "communication_style",
      canonicalText: `我更喜欢自然一点说话的第 ${i} 个稳定侧面。`,
      confidence: 0.7 + i / 100,
      targetMemoryIds: [],
      reason: "category cap fixture",
    });
    assert.equal(
      await recordAsukaLongTermMemoryFromAssistantReply(direct, `我一直更喜欢自然一点说话的第 ${i} 个稳定侧面。`, base + 16_000 + i),
      true,
      "category cap fixture should add candidate personality memory",
    );
  }
  const cappedSignalState = readMemoryState();
  const activeCommunicationSignals = Object.values(cappedSignalState.memories)
    .filter((item) => item.type === "asuka_self_signal" && item.personalityCategory === "communication_style" && (item.status ?? "active") === "active");
  assert.ok(activeCommunicationSignals.length <= 3, "personality memories should be capped per category");

  assert.equal(
    await recordAsukaLongTermMemoryFromAssistantReply(group, "我今天在学校拍视频素材，晚点整理镜头。", base + 15_800),
    false,
    "group context should not persist assistant self-life state",
  );

  for (let i = 0; i < 20; i++) {
    assert.equal(
      await recordAsukaLongTermMemoryFromAssistantReply(
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
  delete process.env.ASUKA_SELF_SIGNAL_TEST_VERDICT;

  const proactivePrompt = buildAsukaProactiveMemoryPrompt(direct, "上海天气", base + 16_000);
  assertIncludes(proactivePrompt, "主动触达", "proactive prompt should include proactive guidance");
  assertIncludes(proactivePrompt, "多条相关记忆", "proactive prompt should allow naturally combining relevant memories");
  assertIncludes(proactivePrompt, "ambient/self_thread", "proactive prompt should include selfhood-specific guidance");
  assertIncludes(proactivePrompt, "更积极延续最近自我生活线", "proactive prompt should strengthen selfhood continuity");
  assertIncludes(proactivePrompt, "承诺/补救优先", "proactive prompt should keep promise repair priority");
  assertExcludes(proactivePrompt, "最多借用一条|主动盘点", "proactive prompt should not over-limit memory usage");
  assertIncludes(proactivePrompt, "上海", "proactive prompt should include safe direct memory context");
  assert.equal(
    buildAsukaProactiveMemoryPrompt(group, "上海天气", base + 16_000),
    "",
    "group proactive prompt must not include direct memory",
  );

  process.env.ASUKA_MEMORY_WIKI_PRIMARY = "1";
  assertIncludes(
    buildAsukaLongTermMemoryPrompt(direct, "上海天气", base + 16_500),
    "上海",
    "pending Wiki compilation should keep the legacy prompt as an immediate fallback",
  );
  fs.mkdirSync(path.join(memoryWikiDir, ".openclaw-wiki", "cache"), { recursive: true });
  fs.writeFileSync(
    path.join(memoryWikiDir, ".openclaw-wiki", "cache", "agent-digest.json"),
    "{}\n",
    "utf-8",
  );
  fs.rmSync(path.join(memoryWikiDir, ".asuka-memory-pending"));
  assert.equal(
    buildAsukaLongTermMemoryPrompt(direct, "上海天气", base + 16_500),
    "",
    "primary Memory Wiki mode should suppress legacy reply prompt injection",
  );
  assert.equal(
    buildAsukaProactiveMemoryPrompt(direct, "上海天气", base + 16_500),
    "",
    "primary Memory Wiki mode should suppress legacy proactive prompt injection",
  );
  assert.equal(
    recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢白桃乌龙。", base + 16_600),
    true,
    "primary Memory Wiki mode should keep writing legacy memory",
  );
  assert.ok(
    Object.values(readMemoryState().memories).some((item) => item.text.includes("白桃乌龙")),
    "primary Memory Wiki mode should retain the legacy memory.json rollback copy",
  );
  assert.ok(
    readWikiClaims().some((claim) => claim.value.includes("白桃乌龙")),
    "primary Memory Wiki mode should continue writing Wiki claims",
  );
  assertIncludes(
    buildAsukaLongTermMemoryPrompt(direct, "白桃乌龙", base + 16_650),
    "白桃乌龙",
    "a new pending Wiki write should immediately fall back to legacy recall until compile",
  );
  delete process.env.ASUKA_MEMORY_WIKI_PRIMARY;

  const invalidWikiTarget = path.join(tmpHome, "wiki-target-is-a-file");
  fs.writeFileSync(invalidWikiTarget, "not a directory", "utf-8");
  process.env.ASUKA_MEMORY_WIKI_DIR = invalidWikiTarget;
  process.env.ASUKA_MEMORY_WIKI_PRIMARY = "1";
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assertIncludes(
      buildAsukaLongTermMemoryPrompt(direct, "白桃乌龙", base + 16_700),
      "白桃乌龙",
      "invalid Wiki directory should fall back to legacy prompt injection",
    );
    assert.equal(
      recordAsukaLongTermMemoryFromUserMessage(direct, "记住我喜欢桂花茶。", base + 17_000),
      true,
      "wiki write failure must not block the legacy memory write or QQ reply path",
    );
  } finally {
    console.error = originalConsoleError;
    process.env.ASUKA_MEMORY_WIKI_DIR = memoryWikiDir;
    delete process.env.ASUKA_MEMORY_WIKI_PRIMARY;
  }

  console.log("[qqbot:test] asuka-memory fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
