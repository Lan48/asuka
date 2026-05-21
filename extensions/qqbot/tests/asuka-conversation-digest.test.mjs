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
  resolveDailyConversationDigestConfig,
  resolveMiniMaxDigestConfig,
  runDailyConversationDigestUpdate,
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
const dailyDigestConfig = resolveDailyConversationDigestConfig(rootConfig);
assert.ok(dailyDigestConfig, "daily digest scheduler should resolve when MiniMax digest is configured");
assert.equal(dailyDigestConfig.enabled, true, "daily digest scheduler should default to enabled");
assert.equal(dailyDigestConfig.hour, 4, "daily digest scheduler should default to early local maintenance hour");

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
for (let day = 0; day < 7; day++) {
  setRefIndex(`REFIDX_DIGEST_DAY_${day}`, {
    content: `第 ${day} 天的自然日连续性，包含场景、情绪和未闭环事项`,
    senderId: "user-digest",
    peerId: "user-digest",
    senderName: "用户",
    timestamp: now - day * 24 * 60 * 60 * 1000,
    isBot: false,
  });
}
setRefIndex("REFIDX_DIGEST_TTS", {
  content: "",
  senderId: "bot",
  peerId: "user-digest",
  senderName: "Asuka",
  timestamp: now - 5_000,
  isBot: true,
  attachments: [{
    type: "voice",
    transcript: "这是已经成功发出的语音回复",
    transcriptSource: "tts",
  }],
});

const recentTranscript = buildRecentConversationTranscript("user-digest", "当前消息", now);
assert.ok(recentTranscript.length <= 18_080, "main reply recent transcript should be capped near 18k chars");
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
        weekly: {
          relationshipContinuity: "用户希望 Asuka 自然理解意图，不要像命令机器人。",
          recentEmotionalArc: "用户在意回复质量和连续性。",
          currentOpenLoops: ["继续优化主回复上下文负担", "迟到愧疚感已经聊开，只需避免重复"],
          userPreferences: ["不要显式命令", "保持中文自然陪伴"],
          temporaryDirectives: ["接下来十轮用语音回答（需外部计数，完成后移除）"],
          asukaSelfContinuity: "Asuka 仍维持杭州校园生活线。",
          sceneContinuity: "不要在校园、睡觉、校园之间无铺垫跳转。",
          importantRecentFacts: ["主回复上下文需要降到短上下文"],
          thingsToAvoid: ["不要复述内部工具和 API 细节"],
          lastSalientTurns: ["用户接受用大模型管理近一周摘要"],
          evidenceNotes: ["明确说过: 用户要求不要像命令机器人", "近轮推断: 用户更在意连续性"],
        },
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
  assert.equal(capturedBody.max_tokens, 4000, "weekly digest curator should leave room for MiniMax text");
  assert.deepEqual(capturedBody.thinking, { type: "disabled" }, "digest curator should disable provider thinking output");
  assert.equal(capturedBody.system.includes("不能生成用户可见回复"), true, "digest curator must be explicitly non-user-facing");
  assert.equal(capturedBody.system.includes("不要生成 daily 日摘要"), true, "digest curator should be weekly-only");
  assert.equal(capturedBody.system.includes("完整摘要"), true, "digest curator should rewrite the whole digest, not append only");
  assert.equal(capturedBody.system.includes("旧摘要只是草稿"), true, "digest curator should treat previous digest as editable context");
  assert.equal(String(capturedBody.messages[0].content).includes("### 2026-05-15"), true, "digest prompt should group history by local day");
  assert.equal(String(capturedBody.messages[0].content).includes("长期记忆/关系记忆节选"), false, "digest prompt should only use raw dialogue and previous weekly digest");
  assert.equal(String(capturedBody.messages[0].content).includes("QQBOT_PAYLOAD"), false, "digest prompt should remove structured payload artifacts");
  assert.equal(String(capturedBody.messages[0].content).includes("用户:"), false, "digest prompt should avoid third-person user labels");
  assert.equal(String(capturedBody.messages[0].content).includes("Asuka:"), false, "digest prompt should avoid third-person bot labels");
  assert.equal(String(capturedBody.messages[0].content).includes("完整替换版 digest"), true, "digest prompt should require full replacement updates");
  assert.equal(String(capturedBody.messages[0].content).includes("如果旧摘要被新原文纠正、补全、完成或过期"), true, "digest prompt should require revising stale prior summaries");
  assert.equal(String(capturedBody.messages[0].content).includes("已经成功发出的语音回复"), true, "digest prompt should include outbound TTS voice transcripts for counting temporary voice directives");
  assert.equal(digest.version, 2);
  assert.equal(JSON.stringify(digest).includes("用户"), false, "stored digest should normalize user perspective");
  assert.equal(JSON.stringify(digest).includes("Asuka"), false, "stored digest should normalize bot perspective");
  assert.equal(digest.weekly.currentOpenLoops[0], "继续优化主回复上下文负担");
  assert.equal(digest.weekly.currentOpenLoops.some((item) => item.includes("愧疚")), false, "resolved emotional topics should not remain open loops");
  assert.equal(digest.weekly.userPreferences.some((item) => item.includes("十轮")), false, "temporary directives should not remain stable weekly preferences");
  assert.equal(digest.weekly.temporaryDirectives[0].includes("十轮"), true, "temporary directives should be kept separately from stable preferences");
  assert.equal(digest.weekly.evidenceNotes.length > 0, true, "digest should keep evidence notes");
  assert.equal(digest.daily.length, 0, "stored digest should be weekly-only");

  const prompt = buildConversationDigestPrompt(context);
  assert.match(prompt, /【近一周会话摘要】/);
  assert.match(prompt, /七天关系连续性/);
  assert.match(prompt, /当前未闭环事项/);
  assert.match(prompt, /临时指令\/待过期偏好/);
  assert.match(prompt, /证据\/置信度/);
  assert.doesNotMatch(prompt, /【每日摘要】/, "main digest prompt should not contain daily summaries");

  setRefIndex("REFIDX_DIGEST_DAILY_MAINT", {
    content: "今晚继续把上下文整理成精简摘要，后续回复要自然承接。",
    senderId: "daily-peer",
    peerId: "daily-peer",
    senderName: "用户",
    timestamp: Date.parse("2026-05-15T23:30:00+08:00"),
    isBot: false,
  });
  capturedBody = {};
  const dailyResult = await runDailyConversationDigestUpdate({
    accountId: "default",
    rootConfig: {
      ...rootConfig,
      channels: {
        qqbot: {
          minimax: {
            ...rootConfig.channels.qqbot.minimax,
            digest: {
              ...rootConfig.channels.qqbot.minimax.digest,
              dailyUpdate: { hour: 4, maxPeers: 10 },
            },
          },
        },
      },
    },
    now: Date.parse("2026-05-16T05:00:00+08:00"),
  });
  assert.ok(dailyResult.checked >= 1, "daily digest maintenance should scan active peers");
  assert.ok(dailyResult.updated >= 1, "daily digest maintenance should update peers not refreshed today");
  assert.equal(String(capturedBody.messages[0].content).includes("本次维护目标日期: 2026-05-15"), true, "daily maintenance should target the last completed local day");
  assert.equal(String(capturedBody.messages[0].content).includes("每日 digest 维护"), false, "daily maintenance should not pollute weekly digest with synthetic task text");
  assert.equal(String(capturedBody.messages[0].content).includes("长期记忆/关系记忆节选"), false, "daily maintenance should only use raw dialogue and previous weekly digest");

  const beforeHourResult = await runDailyConversationDigestUpdate({
    accountId: "default",
    rootConfig,
    now: Date.parse("2026-05-17T03:30:00+08:00"),
  });
  assert.deepEqual(beforeHourResult, { checked: 0, updated: 0, skipped: 0 }, "daily digest maintenance should wait for the configured local hour");

  const fixedPrompt = formatConversationDigestForPrompt({
    version: 2,
    peerKey: "default:direct:user-digest",
    window: "7d",
    updatedAt: now,
    coveredUntil: now,
    timeZone: "Asia/Shanghai",
    weekly: {
      relationshipContinuity: "",
      recentEmotionalArc: "",
      currentOpenLoops: [],
      userPreferences: [],
      temporaryDirectives: [],
      asukaSelfContinuity: "",
      sceneContinuity: "",
      importantRecentFacts: [],
      thingsToAvoid: [],
      lastSalientTurns: [],
      evidenceNotes: [],
    },
    daily: [],
  });
  assert.match(fixedPrompt, /你的偏好\/边界: 无/, "empty digest fields should keep a stable prompt shape");
  assert.match(fixedPrompt, /临时指令\/待过期偏好: 无/, "empty temporary directive field should keep a stable prompt shape");

  const upgradedPrompt = formatConversationDigestForPrompt({
    version: 2,
    peerKey: "default:direct:user-digest",
    window: "7d",
    updatedAt: now,
    coveredUntil: now,
    timeZone: "Asia/Shanghai",
    weekly: {
      relationshipContinuity: "旧 v2 摘要没有新增字段。",
      recentEmotionalArc: "",
      currentOpenLoops: ["旧问题已解决"],
      userPreferences: [],
      asukaSelfContinuity: "",
      sceneContinuity: "",
      importantRecentFacts: [],
      thingsToAvoid: [],
      lastSalientTurns: [],
    },
    daily: [{
      date: "2026-05-12",
      detailLevel: "brief",
      relationshipContinuity: "普通日常，细节未记录。",
      emotionalArc: "日常",
      openLoops: [],
      userPreferences: [],
      asukaSelfContinuity: "日常在家",
      sceneContinuity: "普通日常，无特殊事件记录。",
      importantFacts: [],
      thingsToAvoid: [],
      salientTurns: [],
    }],
  });
  assert.match(upgradedPrompt, /临时指令\/待过期偏好: 无/, "old v2 digests should format without missing-field crashes");
  assert.doesNotMatch(upgradedPrompt, /2026-05-12/, "old daily summaries should be ignored during weekly-only upgrade");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log("[qqbot:test] asuka conversation digest fixtures passed");
