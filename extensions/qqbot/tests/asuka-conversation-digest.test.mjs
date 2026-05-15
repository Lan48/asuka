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
        daily: [
          {
            date: "2026-05-10",
            detailLevel: "brief",
            relationshipContinuity: "普通日常，细节未记录。",
            emotionalArc: "日常",
            openLoops: [],
            userPreferences: [],
            temporaryDirectives: [],
            asukaSelfContinuity: "日常在家",
            sceneContinuity: "普通日常，无特殊事件记录。",
            importantFacts: [],
            thingsToAvoid: [],
            salientTurns: [],
            evidenceNotes: [],
          },
          {
            date: "2026-05-09",
            detailLevel: "brief",
            relationshipContinuity: "较早前保持轻陪伴。",
            emotionalArc: "平稳。",
            openLoops: ["旧事项只保留摘要"],
            userPreferences: [],
            temporaryDirectives: [],
            asukaSelfContinuity: "",
            sceneContinuity: "旧场景只作背景。",
            importantFacts: ["旧事实简略"],
            thingsToAvoid: [],
            salientTurns: ["旧关键句"],
            evidenceNotes: ["旧摘要继承: 置信度较低"],
          },
          {
            date: "2026-05-14",
            detailLevel: "detailed",
            relationshipContinuity: "昨天用户强调不要像命令机器人。",
            emotionalArc: "对连续性更敏感。",
            openLoops: ["继续优化主回复上下文负担", "迟到愧疚情绪已和解"],
            userPreferences: ["保持中文自然陪伴"],
            temporaryDirectives: [],
            asukaSelfContinuity: "Asuka 延续杭州校园生活线。",
            sceneContinuity: "昨天场景不能跳回睡前。",
            importantFacts: ["昨天确定使用近一周摘要"],
            thingsToAvoid: ["不要暴露内部工具"],
            salientTurns: ["用户接受用大模型管理近一周摘要"],
            evidenceNotes: ["明确说过: 用户接受近一周摘要方案"],
          },
          {
            date: "2026-05-15",
            detailLevel: "detailed",
            relationshipContinuity: "今天继续确认摘要结构。",
            emotionalArc: "用户希望保留更多细节。",
            openLoops: ["实现 daily + weekly 摘要"],
            userPreferences: ["最近摘要更详细，远的摘要更简略"],
            temporaryDirectives: ["接下来十轮用语音回答（从今天请求开始，需外部计数）"],
            asukaSelfContinuity: "Asuka 当前生活线要承接今天。",
            sceneContinuity: "今天是当前场景优先。",
            importantFacts: ["摘要同文件保存"],
            thingsToAvoid: ["不要把远日细节塞满 prompt"],
            salientTurns: ["这样会不会太省略？"],
            evidenceNotes: ["明确说过: 用户要求最近详细、远的简略"],
          },
        ],
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
  assert.equal(capturedBody.max_tokens, 6000, "digest curator should leave room for MiniMax text after thinking blocks");
  assert.deepEqual(capturedBody.thinking, { type: "disabled" }, "digest curator should disable provider thinking output");
  assert.equal(capturedBody.system.includes("不能生成用户可见回复"), true, "digest curator must be explicitly non-user-facing");
  assert.equal(capturedBody.system.includes("daily 日摘要"), true, "digest curator should produce daily summaries");
  assert.equal(String(capturedBody.messages[0].content).includes("### 2026-05-15"), true, "digest prompt should group history by local day");
  assert.equal(String(capturedBody.messages[0].content).includes("QQBOT_PAYLOAD"), false, "digest prompt should remove structured payload artifacts");
  assert.equal(digest.version, 2);
  assert.equal(digest.weekly.currentOpenLoops[0], "继续优化主回复上下文负担");
  assert.equal(digest.weekly.currentOpenLoops.some((item) => item.includes("愧疚")), false, "resolved emotional topics should not remain open loops");
  assert.equal(digest.weekly.temporaryDirectives[0].includes("十轮"), true, "temporary directives should be kept separately from stable preferences");
  assert.equal(digest.weekly.evidenceNotes.length > 0, true, "digest should keep evidence notes");
  assert.equal(digest.daily.some((day) => day.date === "2026-05-10"), false, "empty no-record daily placeholders should be pruned");
  assert.equal(digest.daily.at(-1).date, "2026-05-15");
  assert.equal(digest.daily.at(-1).detailLevel, "detailed");
  assert.equal(digest.daily[0].detailLevel, "brief");

  const prompt = buildConversationDigestPrompt(context);
  assert.match(prompt, /【近一周会话摘要】/);
  assert.match(prompt, /七天关系连续性/);
  assert.match(prompt, /当前未闭环事项/);
  assert.match(prompt, /临时指令\/待过期偏好/);
  assert.match(prompt, /证据\/置信度/);
  assert.match(prompt, /【每日摘要】/);
  assert.match(prompt, /2026-05-15（detailed）/);
  assert.doesNotMatch(prompt, /2026-05-10（brief）/);

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
  assert.match(fixedPrompt, /用户偏好\/边界: 无/, "empty digest fields should keep a stable prompt shape");
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
  assert.doesNotMatch(upgradedPrompt, /2026-05-12/, "old empty daily placeholders should be pruned during upgrade");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log("[qqbot:test] asuka conversation digest fixtures passed");
