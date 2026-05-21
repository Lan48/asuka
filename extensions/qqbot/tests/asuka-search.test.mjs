import assert from "node:assert/strict";

const {
  resolveMiniMaxSearchConfig,
  sanitizeSearchQuery,
  analyzeMiniMaxSearchIntent,
  queryMiniMaxSearch,
  formatSearchSummaryForPrompt,
} = await import("../dist/src/utils/minimax-search.js");

const config = {
  models: {
    providers: {
      minimax: {
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "super-secret-minimax-key",
        models: [{ id: "MiniMax-M2.7" }],
      },
    },
  },
  channels: {
    qqbot: {
      minimax: {
        search: {
          enabled: true,
          model: "MiniMax-M2.7",
          queryMaxChars: 80,
          maxResults: 2,
          timeoutMs: 5000,
        },
      },
    },
  },
};

const searchConfig = resolveMiniMaxSearchConfig(config);
assert.ok(searchConfig, "MiniMax search config should resolve");
assert.equal(searchConfig.baseUrl, "https://api.minimaxi.com/v1");
assert.equal(searchConfig.apiKey, "super-secret-minimax-key");
assert.equal(searchConfig.maxResults, 2);

assert.equal(
  sanitizeSearchQuery("查一下 sk-cp-thisShouldBeRedacted1234567890 MiniMax"),
  "查一下 [redacted] MiniMax",
  "search query sanitizer should redact secrets",
);

let capturedUrl = "";
let capturedHeaders = {};
let capturedBody = {};
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers ?? {};
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({
      shouldSearch: true,
      query: "MiniMax 最新模型",
      reason: "用户需要外部最新信息",
      confidence: 0.91,
    }) }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const intent = await analyzeMiniMaxSearchIntent({
    userText: "MiniMax M2.7 现在是不是最新的？",
    recentContext: "用户正在选择 Asuka 的模型能力。",
    currentLocalTime: "2026-05-15 12:00:00 Asia/Shanghai",
  }, searchConfig);
  assert.equal(capturedUrl, "https://api.minimaxi.com/anthropic/v1/messages");
  assert.equal(capturedHeaders["x-api-key"], "super-secret-minimax-key");
  assert.equal(capturedBody.model, "MiniMax-M2.7");
  assert.equal(intent.shouldSearch, true);
  assert.equal(intent.reason, "llm");
  assert.equal(intent.query, "MiniMax 最新模型");
  assert.equal(intent.confidence, 0.91);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => new Response(JSON.stringify({
  content: [{ type: "text", text: JSON.stringify({
    shouldSearch: false,
    query: "",
    reason: "这是情绪陪伴，不需要外部信息",
    confidence: 0.88,
  }) }],
}), {
  status: 200,
  headers: { "content-type": "application/json" },
});

try {
  const intent = await analyzeMiniMaxSearchIntent({
    userText: "抱抱我，我要睡觉了",
    recentContext: "用户刚刚说很累。",
  }, searchConfig);
  assert.equal(intent.shouldSearch, false, "ordinary intimate chat should stay offline when LLM gate says no");
  assert.equal(intent.reason, "offline");
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers ?? {};
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    organic: [
      { title: "MiniMax Docs", link: "https://platform.minimax.io/docs", snippet: "Official docs", date: "2026-05-15" },
      { title: "MiniMax API", link: "https://api.minimax.io", snippet: "API endpoint" },
      { title: "Extra", link: "https://example.test/extra" },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const summary = await queryMiniMaxSearch("MiniMax 最新模型", searchConfig);
  assert.equal(capturedUrl, "https://api.minimaxi.com/v1/coding_plan/search");
  assert.equal(capturedHeaders.Authorization, "Bearer super-secret-minimax-key");
  assert.equal(capturedBody.q, "MiniMax 最新模型");
  assert.equal(summary.results.length, 2, "search should respect configured maxResults");
  assert.equal(summary.results[0].title, "MiniMax Docs");
} finally {
  globalThis.fetch = originalFetch;
}

const promptSection = formatSearchSummaryForPrompt({
  query: "MiniMax 最新模型",
  results: [{
    title: "MiniMax Docs",
    link: "https://platform.minimax.io/docs",
    snippet: "Official docs",
    date: "2026-05-15",
  }],
}, new Date("2026-05-15T10:00:00+08:00").toISOString());
assert.match(promptSection, /联网搜索/);
assert.match(promptSection, /搜索时间/);
assert.match(promptSection, /不要把搜索结果自动写入长期记忆/);
assert.match(promptSection, /https:\/\/platform\.minimax\.io\/docs/);

console.log("[qqbot:test] asuka-search fixtures passed");
