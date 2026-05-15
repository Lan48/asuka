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
  assert.match(prompt, /当前结构化场景: lifePhase=meal, activity=dinner/, "state prompt should expose structured activity fields");
  assert.match(prompt, /距离场景开始: 约 1-2 小时/, "state prompt should expose bucketed relative scene age");
  assert.match(prompt, /场景过渡建议: 如果已经过去一两个小时/, "state prompt should expose transition guidance");
  assert.doesNotMatch(prompt, /startedAt|lastInferredAt|lastObservedAt/, "state prompt should not leak raw scene timestamps");

  const continued = applySceneProgressionRules({
    kind: "activity",
    label: "activity_context",
    lifePhase: "meal",
    activity: "dinner",
    place: "home",
    owner: "user",
    timeContinuity: "same_moment",
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
    lifePhase: "school_day",
    activity: "after_class",
    place: "campus",
    owner: "asuka",
    timeContinuity: "advanced_from_morning",
    summary: "Asuka 上午刚下课，准备关心用户下午考试",
    confidence: 0.7,
    source: "scene_model",
    startPolicy: "reuse",
  }, {
    fallbackLabel: "emotional_presence",
    now: base + 30 * 60 * 1000,
  });

  assert.equal(continued.kind, "activity", "activity_context should render as an activity scene");
  assert.equal(continued.startedAt, base + 30 * 60 * 1000, "changed structured scene identity should reset scene start time even when the coarse label is reused");
  assert.equal(continued.lifePhase, "school_day", "candidate lifePhase should be retained as structured scene state");
  assert.equal(continued.activity, "after_class", "candidate activity should be retained as structured scene state");
  assert.equal(continued.place, "campus", "candidate place should be retained as structured scene state");
  assert.equal(continued.owner, "asuka", "candidate owner should be retained as structured scene state");
  assert.equal(continued.timeContinuity, "advanced_from_morning", "candidate continuity should be retained as structured scene state");

  const stillDinner = applySceneProgressionRules({
    kind: "activity",
    label: "activity_context",
    lifePhase: "meal",
    activity: "dinner",
    place: "home",
    owner: "user",
    timeContinuity: "same_moment",
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
    lifePhase: "meal",
    activity: "dinner",
    place: "home",
    owner: "user",
    timeContinuity: "same_moment",
    summary: "用户还在饭后聊刚才那顿晚饭。",
    confidence: 0.7,
    source: "scene_model",
    startPolicy: "reuse",
  }, {
    fallbackLabel: "emotional_presence",
    now: base + 45 * 60 * 1000,
  });

  assert.equal(stillDinner.startedAt, base, "unchanged structured scene identity should preserve original scene start time");

  console.log("[qqbot:test] asuka scene-v2 fixtures passed");
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
