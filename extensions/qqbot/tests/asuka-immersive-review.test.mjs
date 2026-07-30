import assert from "node:assert/strict";
import {
  generateLocalImmersiveFallback,
  prewarmImmersiveModel,
  resolveImmersiveReviewConfig,
  reviewImmersiveEnvelope,
  reviewImmersiveText,
} from "../dist/src/immersive-review.js";
import { parseQQBotPayload } from "../dist/src/utils/payload.js";

const config = resolveImmersiveReviewConfig({
  enabled: true,
  endpoint: "http://127.0.0.1:11434/",
  model: "fixture-immersive-model",
  timeoutMs: 500,
  keepAlive: "30m",
  contextTokens: 2048,
  fallbackGeneration: true,
});

function ollamaResponse(content, status = 200) {
  return new Response(JSON.stringify({
    message: { content },
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reviewJson(action, visibleText, issues = ["none"], confidence = 0.98) {
  return JSON.stringify({ action, visibleText, issues, confidence });
}

{
  let called = false;
  const result = await reviewImmersiveText(
    { enabled: false },
    { candidateText: "自然回复", userText: "你好" },
    { fetchImpl: async () => { called = true; throw new Error("must not call"); } },
  );
  assert.equal(result.action, "pass");
  assert.equal(result.visibleText, "自然回复");
  assert.equal(called, false);
}

{
  let body;
  const original = "（揉揉眼睛站起来）饿了？我去给你做点吃的。";
  const result = await reviewImmersiveText(config, {
    candidateText: original,
    userText: "我饿了",
    sceneContext: "中午，双方在家",
  }, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return ollamaResponse(reviewJson("pass", "模型不应修改这句话"));
    },
  });
  assert.equal(result.action, "pass");
  assert.equal(result.visibleText, original, "pass must preserve the original bytes");
  assert.equal(body.think, false);
  assert.equal(body.format.additionalProperties, false);
  assert.equal(body.options.num_ctx, 2048);
}

{
  const original = "（揉揉眼睛站起来）饿了？";
  const result = await reviewImmersiveText(config, {
    candidateText: original,
    userText: "我饿了",
  }, {
    fetchImpl: async () => ollamaResponse(reviewJson("pass", "模型改过的版本", [])),
  });
  assert.equal(result.action, "pass");
  assert.equal(result.visibleText, original);
  assert.deepEqual(result.issues, ["none"]);
}

{
  const leaked = [
    "看上下文，这是从昨晚亲密入睡后直接跳到今天中午了。",
    "",
    "（揉揉眼睛站起来）饿了？我先把蜂蜜水补上。",
  ].join("\n");
  const rewritten = "（揉揉眼睛站起来）饿了？我先把蜂蜜水补上。";
  const result = await reviewImmersiveText(config, {
    candidateText: leaked,
    userText: "我饿了",
    sceneContext: "中午，双方在家",
  }, {
    fetchImpl: async () => ollamaResponse(
      reviewJson("rewrite", rewritten, ["meta_reasoning", "outside_shared_scene"]),
    ),
  });
  assert.equal(result.action, "rewrite");
  assert.equal(result.visibleText, rewritten);
}

{
  let calls = 0;
  const result = await reviewImmersiveText(config, {
    candidateText: "候选正文",
    userText: "用户话语",
  }, {
    fetchImpl: async () => {
      calls += 1;
      return ollamaResponse(calls === 1 ? "{}" : reviewJson("pass", "被模型改写"));
    },
  });
  assert.equal(calls, 2, "invalid structured output should retry once");
  assert.equal(result.action, "pass");
  assert.equal(result.visibleText, "候选正文");
  assert.equal(result.attempts, 2);
}

{
  let calls = 0;
  const result = await reviewImmersiveText(config, {
    candidateText: "候选正文",
    userText: "用户话语",
  }, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.action, "unavailable");
  assert.equal(result.visibleText, "", "unreviewed candidate must never escape");
}

{
  const raw = [
    "我先把幕后判断说一下。",
    'QQBOT_PAYLOAD: {"type":"media","mediaType":"audio","source":"file","path":"根据聊天记录，我觉得你饿了。","caption":"给你听。"}',
  ].join("\n");
  const responses = [
    reviewJson("rewrite", "（牵住你的手）我先给你弄点吃的。", ["meta_reasoning"]),
    reviewJson("rewrite", "饿了？我陪你去吃饭。", ["transcript_framing"]),
    reviewJson("pass", "这段不会替换原 caption"),
  ];
  const result = await reviewImmersiveEnvelope(config, {
    candidateText: raw,
    userText: "我饿了",
    sceneContext: "中午，双方在家",
  }, {
    fetchImpl: async () => ollamaResponse(responses.shift()),
  });
  assert.equal(result.action, "rewrite");
  const parsed = parseQQBotPayload(result.visibleText);
  assert.equal(parsed.isPayload, true);
  assert.equal(parsed.leadingText, "（牵住你的手）我先给你弄点吃的。");
  assert.equal(parsed.payload.path, "饿了？我陪你去吃饭。");
  assert.equal(parsed.payload.caption, "给你听。");
}

{
  const raw = 'QQBOT_PAYLOAD: {"type":"media","mediaType":"image","source":"url","path":"https://example.test/a.jpg","caption":"分析上下文后，我决定发这张图。"}';
  const result = await reviewImmersiveEnvelope(config, {
    candidateText: raw,
    userText: "给我看看",
  }, {
    fetchImpl: async () => ollamaResponse(
      reviewJson("rewrite", "给你看。", ["meta_reasoning"]),
    ),
  });
  const parsed = parseQQBotPayload(result.visibleText);
  assert.equal(result.action, "rewrite");
  assert.equal(parsed.payload.caption, "给你看。");
}

{
  let body;
  const candidate = await generateLocalImmersiveFallback(config, {
    userText: "我饿了",
    sceneContext: "中午，双方在家",
    recentContext: "你：刚醒。\n我：嗯。",
  }, {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return ollamaResponse("（起身牵住你）我给你做饭。");
    },
  });
  assert.equal(candidate, "（起身牵住你）我给你做饭。");
  assert.equal(body.think, false);
  assert.equal(body.format, undefined, "fallback generation is a separate free-text call");
}

{
  let calls = 0;
  assert.equal(await prewarmImmersiveModel(config, {
    fetchImpl: async () => {
      calls += 1;
      return ollamaResponse("好");
    },
  }), true);
  assert.equal(calls, 1);
}

console.log("[qqbot:test] asuka immersive review fixtures passed");
