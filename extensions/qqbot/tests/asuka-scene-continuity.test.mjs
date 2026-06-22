import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-scene-continuity-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const base = Date.UTC(2026, 5, 7, 0, 0, 0); // 08:00 Asia/Shanghai
const peerKey = "acct-test:direct:user-scene-continuity";
const stateDir = path.join(tmpHome, ".openclaw", "qqbot", "data", "asuka-state");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "state.json"),
  JSON.stringify({
    version: 1,
    peers: {
      [peerKey]: {
        accountId: "acct-test",
        peerKey,
        peerKind: "direct",
        peerId: "user-scene-continuity",
        senderId: "user-scene-continuity",
        target: "c2c:user-scene-continuity",
        scene: {
          kind: "activity",
          label: "activity_context",
          lifePhase: "meal",
          activity: "late_night_noodles",
          place: "home",
          owner: "shared",
          timeContinuity: "same_moment",
          summary: "凌晨还在吃面，Asuka 让用户趁热吃。",
          confidence: 0.82,
          startedAt: base - 7 * 60 * 60 * 1000,
          lastObservedAt: base - 7 * 60 * 60 * 1000,
          lastInferredAt: base - 7 * 60 * 60 * 1000,
          transitionHint: "如果已经到早上，应让吃面动作自然过去。",
          version: 1,
          source: "scene_model",
        },
        relationship: {
          warmth: 70,
          intimacy: 65,
          phase: "亲密",
          label: "很亲近",
          lastUserMessageAt: base - 7 * 60 * 60 * 1000,
          lastUserText: "我吃一口就睡",
          lastAssistantMessageAt: base - 7 * 60 * 60 * 1000 + 1_000,
          lastAssistantText: "快吃吧，再不吃真的要糊了。吃完好接着睡。",
          recentPromiseIds: [],
        },
        ambient: {
          styleVersion: 2,
          currentThreadId: "conversation",
          currentStage: 0,
          currentMood: "warm",
          currentPresence: "你还在惦记对方醒来后的状态。",
          currentAttention: "gentle_check",
          lastSentAt: base - 60 * 60 * 1000,
          lastTopicPreview: "（我擦头发的动作慢下来，毛巾搭在肩上）……那姐姐现在可以抱你一下吗。抱完就去吹头发。",
          jobIds: [],
          proactiveDedup: {},
        },
      },
    },
    promises: {},
  }, null, 2),
  "utf-8",
);

try {
  const {
    buildAsukaStatePrompt,
    getSceneContinuityTextViolation,
    judgeProactiveDeliveryFreshness,
    recordProactiveBeatSuppressed,
  } = await import("../dist/src/asuka-state.js");

  const direct = {
    accountId: "acct-test",
    peerKind: "direct",
    peerId: "user-scene-continuity",
    senderId: "user-scene-continuity",
    target: "c2c:user-scene-continuity",
  };
  const fadedVerdict = {
    sceneStatus: "faded",
    transitionInstruction: "把凌晨吃面的动作自然带过去，转成早上的轻量陪伴。",
    staleElements: ["面", "筷子", "凉了", "快吃"],
    allowedContinuity: "可以保留关心对方有没有睡醒、有没有好好休息的情绪。",
    reason: "从凌晨吃面到早上八点，具体吃面动作已经不自然。",
    source: "mock",
  };

  const prompt = buildAsukaStatePrompt(direct, base, fadedVerdict);
  assert.match(prompt, /主动场景连续性裁决/, "state prompt should include scene continuity verdict");
  assert.match(prompt, /裁决: faded/, "state prompt should expose faded verdict");
  assert.match(prompt, /不要复用旧动作\/物件: 面、筷子、凉了、快吃/, "state prompt should expose model-provided stale elements");

  assert.equal(
    getSceneContinuityTextViolation("（我低头夹了一筷子面）快吃吧，凉了就不好吃了。", fadedVerdict),
    "scene_continuity_stale_element:面",
    "faded verdict should block stale scene elements",
  );
  assert.equal(
    getSceneContinuityTextViolation("（我把声音放轻）早上醒了的话，先慢慢缓一下。", fadedVerdict),
    null,
    "faded verdict should allow natural transition text",
  );
  assert.equal(
    getSceneContinuityTextViolation("快吃吧，面凉了。", { ...fadedVerdict, sceneStatus: "current" }),
    null,
    "current verdict should not force scene advancement",
  );

  process.env.ASUKA_PROACTIVE_DELIVERY_FRESHNESS_TEST_VERDICT = JSON.stringify({
    status: "duplicate",
    reason: "候选仍在重复上一条擦头发和抱完去吹头发的动作。",
    requiredShift: "改成已经吹完头发后的自然陪伴，不要复读上一条动作。",
  });
  const duplicateVerdict = await judgeProactiveDeliveryFreshness(
    direct,
    "（我擦头发的动作慢下来，毛巾搭在肩上）……那姐姐现在可以抱你一下吗。就一下。抱完就去吹头发。",
    { at: base, sceneVerdict: fadedVerdict },
  );
  assert.equal(duplicateVerdict.status, "duplicate", "mock freshness judge should mark repeated proactive action as duplicate");
  assert.match(duplicateVerdict.requiredShift, /不要复读上一条动作/, "freshness judge should return retry guidance");
  delete process.env.ASUKA_PROACTIVE_DELIVERY_FRESHNESS_TEST_VERDICT;

  recordProactiveBeatSuppressed(peerKey, {
    reason: "候选仍在重复蛋白归你、蛋黄归我的分工。",
    requiredShift: "推进到收拾碗筷或早餐结束后的下一动作。",
    payloadContent: "PROACTIVE_BEAT:{\"topicAnchor\":\"早餐\",\"blockedAnchors\":[\"蛋白蛋黄分工\"]}",
    at: base + 1_000,
  });
  const stateAfterSuppression = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf-8"));
  const suppressedBeat = stateAfterSuppression.peers[peerKey].ambient.proactiveBeatLedger.recentBeats[0];
  assert.match(suppressedBeat.suppressedReason, /蛋白归你/, "semantic duplicate suppression should persist reason");
  assert.match(suppressedBeat.noveltyGoal, /收拾碗筷/, "semantic duplicate suppression should persist required shift as novelty goal");
  assert.ok(
    suppressedBeat.blockedAnchors.some((anchor) => /蛋白/.test(anchor)),
    "semantic duplicate suppression should add repeated semantic anchor to blocked anchors",
  );

  const source = fs.readFileSync(path.join(process.cwd(), "src", "asuka-state.ts"), "utf-8");
  assert.match(source, /不要使用固定分钟阈值/, "scene continuity judge should instruct model not to use fixed minute thresholds");
  assert.doesNotMatch(source, /MEAL_.*(?:TTL|TIMEOUT|DURATION)|HAIR_.*(?:TTL|TIMEOUT|DURATION)/, "scene continuity should not add hard-coded meal or hair duration constants");

  console.log("[qqbot:test] asuka scene continuity fixtures passed");
} finally {
  delete process.env.ASUKA_PROACTIVE_DELIVERY_FRESHNESS_TEST_VERDICT;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
