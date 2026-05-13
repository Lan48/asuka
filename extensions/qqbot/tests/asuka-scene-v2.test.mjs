import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-asuka-scene-v2-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const base = Date.UTC(2026, 4, 12, 10, 0, 0); // 18:00 Asia/Shanghai
const peerKey = "acct-test:direct:user-scene-v2";
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
        peerId: "user-scene-v2",
        senderId: "user-scene-v2",
        target: "c2c:user-scene-v2",
        scene: {
          kind: "activity",
          label: "activity_context",
          summary: "用户刚才像是在吃晚饭，语境偏日常陪伴。",
          confidence: 0.74,
          startedAt: base,
          lastObservedAt: base,
          lastInferredAt: base,
          transitionHint: "如果已经过去一两个小时，应自然过渡到饭后休息、收拾或普通聊天，不要断言仍在吃。",
          version: 1,
          source: "scene_model",
        },
        relationship: {
          warmth: 55,
          intimacy: 48,
          phase: "熟络",
          label: "慢慢熟起来",
          lastUserMessageAt: base,
          lastUserText: "我先吃晚饭",
          recentPromiseIds: [],
        },
        ambient: {
          styleVersion: 2,
          currentThreadId: "conversation",
          currentStage: 0,
          currentMood: "warm",
          currentPresence: "你还在认真陪着对方。",
          currentAttention: "pull_close",
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
    applySceneProgressionRules,
    buildAsukaStatePrompt,
  } = await import("../dist/src/asuka-state.js");

  const prompt = buildAsukaStatePrompt({
    accountId: "acct-test",
    peerKind: "direct",
    peerId: "user-scene-v2",
    senderId: "user-scene-v2",
    target: "c2c:user-scene-v2",
  }, base + 110 * 60 * 1000);

  assert.match(prompt, /当前场景线索: 用户刚才像是在吃晚饭/, "state prompt should expose summarized activity scene");
  assert.match(prompt, /距离场景开始: 约 1-2 小时/, "state prompt should expose bucketed relative scene age");
  assert.match(prompt, /场景过渡建议: 如果已经过去一两个小时/, "state prompt should expose transition guidance");
  assert.doesNotMatch(prompt, /startedAt|lastInferredAt|lastObservedAt/, "state prompt should not leak raw scene timestamps");

  const continued = applySceneProgressionRules({
    kind: "activity",
    label: "activity_context",
    summary: "用户刚才像是在吃晚饭，语境偏日常陪伴。",
    confidence: 0.74,
    startedAt: base,
    lastObservedAt: base,
    lastInferredAt: base,
    transitionHint: "如果已经过去一两个小时，应自然过渡到饭后休息、收拾或普通聊天，不要断言仍在吃。",
    version: 1,
    source: "scene_model",
  }, {
    label: "activity_context",
    summary: "用户刚才像是在吃晚饭，语境偏日常陪伴。",
    confidence: 0.7,
    source: "scene_model",
    startPolicy: "reuse",
  }, {
    fallbackLabel: "emotional_presence",
    now: base + 30 * 60 * 1000,
  });

  assert.equal(continued.kind, "activity", "activity_context should render as an activity scene");
  assert.equal(continued.startedAt, base, "reuse start policy should preserve original scene start time");
  assert.equal(continued.transitionHint?.includes("饭后休息"), true, "continued scene should preserve transition hint");

  console.log("[qqbot:test] asuka scene-v2 fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
