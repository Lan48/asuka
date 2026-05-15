import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-conversation-digest-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  buildConversationDigestPrompt,
  formatConversationDigestForPrompt,
  resolveMiniMaxDigestConfig,
  updateConversationDigest,
} = await import("../dist/src/asuka-conversation-digest.js");
const { setRefIndex } = await import("../dist/src/ref-index-store.js");
const { buildRecentConversationTranscript } = await import("../dist/src/gateway.js");

const rootConfig = {
  models: {
    providers: {
      minimax: {
        baseUrl: "https://api.minimaxi.com/anthropic",
        apiKey: "provider-secret",
        models: [{ id: "MiniMax-M2.7" }],
      },
    },
  },
  channels: {
    qqbot: {
      minimax: {
        search: {
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "search-secret",
          model: "MiniMax-M2.7",
        },
        digest: {
          enabled: true,
          maxHistoryChars: 8000,
          maxDigestChars: 1800,
          minUpdateIntervalMs: 0,
        },
      },
    },
  },
};

const digestConfig = resolveMiniMaxDigestConfig(rootConfig);
assert.ok(digestConfig, "MiniMax digest config should resolve from qqbot.minimax config");
assert.equal(digestConfig.model, "MiniMax-M2.7");
assert.equal(digestConfig.apiKey, "search-secret", "digest should prefer channel MiniMax key over provider fallback");

const context = {
  accountId: "default",
  peerKind: "direct",
  peerId: "user-digest",
  senderId: "user-digest",
  target: "qqbot:c2c:user-digest",
  messageId: "msg-digest",
};

const now = Date.parse("2026-05-15T20:00:00+08:00");
for (let i = 0; i < 80; i++) {
  setRefIndex(`REFIDX_DIGEST_${i}`, {
    content: `第 ${i} 条近一周上下文 ${"很长的日常聊天".repeat(30)}`,
    senderId: i % 2 === 0 ? "user-digest" : "bot",
    peerId: "user-digest",
    senderName: i % 2 === 0 ? "用户" : "Asuka",
    timestamp: now - (80 - i) * 60_000,
    isBot: i % 2 === 1,
  });
}

const recentTranscript = buildRecentConversationTranscript("user-digest", "当前消息", now);
assert.ok(recentTranscript.length <= 12_080, "main reply recent transcript should be capped near 12k chars");
assert.ok(!recentTranscript.includes("第 0 条"), "main reply transcript should keep the latest entries instead of full week history");

let capturedUrl = "";
let capturedBody = {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    content: [{
      type: "text",
      text: JSON.stringify({
        relationshipContinuity: "用户希望 Asuka 自然理解意图，不要像命令机器人。",
        recentEmotionalArc: "用户在意回复质量和连续性。",
        currentOpenLoops: ["继续优化主回复上下文负担"],
        userPreferences: ["不要显式命令", "保持中文自然陪伴"],
        asukaSelfContinuity: "Asuka 仍维持杭州校园生活线。",
        sceneContinuity: "不要在校园、睡觉、校园之间无铺垫跳转。",
        importantRecentFacts: ["主回复上下文需要降到短上下文"],
        thingsToAvoid: ["不要复述内部工具和 API 细节"],
        lastSalientTurns: ["用户接受用大模型管理近一周摘要"],
      }),
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const digest = await updateConversationDigest(context, {
    rootConfig,
    userText: "就按照这个方案实现。",
    assistantText: 'QQBOT_PAYLOAD: {"type":"media","mediaType":"audio","path":"内部载荷"}\n\n我会改。',
    now,
  });
  assert.ok(digest, "digest update should write normalized digest");
  assert.equal(capturedUrl, "https://api.minimaxi.com/anthropic/v1/messages");
  assert.equal(capturedBody.model, "MiniMax-M2.7");
  assert.equal(capturedBody.system.includes("不能生成用户可见回复"), true, "digest curator must be explicitly non-user-facing");
  assert.equal(String(capturedBody.messages[0].content).includes("QQBOT_PAYLOAD"), false, "digest prompt should remove structured payload artifacts");
  assert.equal(digest.currentOpenLoops[0], "继续优化主回复上下文负担");

  const prompt = buildConversationDigestPrompt(context);
  assert.match(prompt, /【近一周会话摘要】/);
  assert.match(prompt, /关系连续性/);
  assert.match(prompt, /当前未闭环事项/);

  const fixedPrompt = formatConversationDigestForPrompt({
    version: 1,
    peerKey: "default:direct:user-digest",
    window: "7d",
    updatedAt: now,
    coveredUntil: now,
    relationshipContinuity: "",
    recentEmotionalArc: "",
    currentOpenLoops: [],
    userPreferences: [],
    asukaSelfContinuity: "",
    sceneContinuity: "",
    importantRecentFacts: [],
    thingsToAvoid: [],
    lastSalientTurns: [],
  });
  assert.match(fixedPrompt, /用户偏好\/边界: 无/, "empty digest fields should keep a stable prompt shape");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log("[qqbot:test] asuka conversation digest fixtures passed");
