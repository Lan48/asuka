import assert from "node:assert/strict";
import {
  createOpenAICompatibleMemoryModelClient,
} from "../dist/src/asuka-memory-kernel/model-client.js";
import {
  parseMemoryJudgement,
  parseRerankResult,
} from "../dist/src/asuka-memory-kernel/model-tasks.js";

const primaryKey = "PRIMARY_TEST_KEY_123";
const fallbackKey = "FALLBACK_TEST_KEY_456";
const embeddingKey = "EMBEDDING_TEST_KEY_789";

const primary = {
  baseUrl: "https://primary.example/v1",
  apiKey: primaryKey,
  model: "primary-model",
};
const fallback = {
  baseUrl: "https://fallback.example/v1",
  apiKey: fallbackKey,
  model: "fallback-model",
};

function completionResponse(content, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(task = "adjudicate", timeoutMs = 100, maxTokens) {
  return {
    task,
    prompt: "fixture prompt",
    timeoutMs,
    schemaVersion: 1,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

{
  const calls = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return completionResponse('{"proposals":[]}');
    },
  });
  const result = await client.complete(request());
  assert.equal(result, '{"proposals":[]}');
  assert.equal(calls.length, 1, "a successful primary must not call the fallback");
  assert.equal(calls[0].url, "https://primary.example/v1/chat/completions");
  assert.equal(client.status.completion, "ready");
  assert.equal(client.status.completionModels, 2);
  assert.equal(client.status.embedding, "degraded");
  assert.equal(client.status.embeddingReason, "not_configured");
  assert.equal(client.embed, undefined, "degraded embedding must not expose a fake adapter");
}

{
  const calls = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response("", { status: 503 });
      return completionResponse('{"proposals":[],"noMemoryReason":"fallback"}');
    },
  });
  const result = await client.complete(request());
  assert.match(result, /fallback/);
  assert.equal(calls.length, 2, "an HTTP failure must fall back");
}

{
  const calls = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (calls.length > 1) return completionResponse('{"proposals":[]}');
      return await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error(`Authorization: Bearer ${primaryKey}`));
        }, { once: true });
      });
    },
  });
  assert.equal(await client.complete(request("adjudicate", 5)), '{"proposals":[]}');
  assert.equal(calls.length, 2, "a timed-out primary must use a fresh fallback attempt");
}

for (const invalidContent of ["not JSON", "{}"]) {
  const calls = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    fetchImpl: async () => {
      calls.push(calls.length);
      return calls.length === 1
        ? completionResponse(invalidContent)
        : completionResponse('{"proposals":[]}');
    },
  });
  assert.equal(await client.complete(request()), '{"proposals":[]}');
  assert.equal(calls.length, 2, "invalid model JSON/schema must fall back");
}

{
  const calls = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return calls.length === 1
        ? completionResponse('{"proposals":[]}')
        : completionResponse('{"proposals":[],"noMemoryReason":"fixture"}');
    },
  });
  assert.equal(
    await client.complete(request("legacy_extract")),
    '{"proposals":[],"noMemoryReason":"fixture"}',
  );
  assert.equal(
    calls.length,
    2,
    "an invalid legacy extraction response must fall back",
  );
}

for (const [requested, expected] of [[5_000, 5_000], [99_999, 16_000]]) {
  let body;
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return completionResponse('{"proposals":[]}');
    },
  });
  await client.complete(request("adjudicate", 100, requested));
  assert.equal(
    body.max_tokens,
    expected,
    "the configured output budget must be passed through with a deterministic cap",
  );
}

{
  const warnings = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    fallback,
    log: { warn: (message) => warnings.push(message) },
    fetchImpl: async (url) => {
      if (String(url).includes("primary")) {
        return new Response(`raw response ${primaryKey}`, { status: 500 });
      }
      throw new Error(`apiKey=${fallbackKey} Authorization: Bearer ${primaryKey}`);
    },
  });
  let failure;
  try {
    await client.complete(request());
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const diagnostics = `${failure.message}\n${warnings.join("\n")}`;
  assert.doesNotMatch(diagnostics, /PRIMARY_TEST_KEY|FALLBACK_TEST_KEY/);
  assert.doesNotMatch(diagnostics, /Authorization|apiKey=/i);
  assert.doesNotMatch(diagnostics, /raw response/);
}

{
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    embedding: {
      endpoint: "https://embedding.example/v1/embeddings",
      apiKey: embeddingKey,
      model: "embedding-model",
      timeoutMs: 80,
      expectedDimensions: 2,
    },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://embedding.example/v1/embeddings");
      assert.equal(JSON.parse(init.body).model, "embedding-model");
      return new Response(JSON.stringify({
        model: "embedding-model",
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      }));
    },
  });
  assert.equal(client.status.embedding, "ready");
  assert.equal(typeof client.embed, "function");
  assert.deepEqual(await client.embed(["first", "second"], 100), {
    model: "embedding-model",
    dimensions: 2,
    vectors: [[1, 2], [3, 4]],
  });
}

for (const data of [
  [
    { embedding: [1, 2] },
    { index: 1, embedding: [3, 4] },
  ],
  [
    { index: 0, embedding: [1, 2] },
    { index: 0, embedding: [3, 4] },
  ],
  [
    { index: -1, embedding: [1, 2] },
    { index: 1, embedding: [3, 4] },
  ],
  [
    { index: 0, embedding: [1, 2] },
    { index: 2, embedding: [3, 4] },
  ],
]) {
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    embedding: {
      endpoint: "https://embedding.example/v1/embeddings",
      apiKey: embeddingKey,
      model: "embedding-model",
      timeoutMs: 80,
      expectedDimensions: 2,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      model: "embedding-model",
      data,
    })),
  });
  await assert.rejects(
    client.embed(["first", "second"], 100),
    /invalid vector index/,
  );
}

{
  const warnings = [];
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    embedding: {
      endpoint: "https://embedding.example/v1/embeddings",
      apiKey: embeddingKey,
      model: "embedding-model",
      timeoutMs: 80,
    },
    log: { warn: (message) => warnings.push(message) },
    fetchImpl: async () => new Response(JSON.stringify({
      model: "embedding-model",
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 1, embedding: [3] },
      ],
    })),
  });
  await assert.rejects(
    client.embed(["first", "second"], 100),
    /inconsistent dimensions/,
  );
  assert.doesNotMatch(warnings.join("\n"), /EMBEDDING_TEST_KEY/);
}

for (const payload of [
  {
    data: [{ index: 0, embedding: [1, 2] }],
  },
  {
    model: "wrong-embedding-model",
    data: [{ index: 0, embedding: [1, 2] }],
  },
]) {
  const client = createOpenAICompatibleMemoryModelClient({
    primary,
    embedding: {
      endpoint: "https://embedding.example/v1/embeddings",
      apiKey: embeddingKey,
      model: "embedding-model",
      timeoutMs: 80,
      expectedDimensions: 2,
    },
    fetchImpl: async () => new Response(JSON.stringify(payload)),
  });
  await assert.rejects(
    client.embed(["first"], 100),
    /embedding provider returned an unexpected model/,
  );
}

{
  const invalidEmbedding = createOpenAICompatibleMemoryModelClient({
    primary,
    embedding: {
      endpoint: "",
      apiKey: embeddingKey,
      model: "embedding-model",
      timeoutMs: 80,
    },
  });
  assert.equal(invalidEmbedding.status.embedding, "degraded");
  assert.equal(invalidEmbedding.status.embeddingReason, "invalid_configuration");
  assert.equal(invalidEmbedding.embed, undefined);
}

const fixtureEvent = {
  eventId: "event-1",
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  actor: "user",
  kind: "user_message",
  text: "fixture",
  identityId: "identity-1",
  visibility: "private",
  occurredAt: Date.now(),
  recordedAt: Date.now(),
  evidence: {},
  metadata: {},
  generatedFromClaimIds: [],
  dedupeKey: "fixture",
};
assert.throws(
  () => parseMemoryJudgement("[]", fixtureEvent),
  /JSON object/,
  "judgement parser must reject a non-object result",
);
assert.throws(
  () => parseRerankResult("[]", new Set()),
  /JSON object/,
  "rerank parser must reject a non-object result",
);

console.log("asuka-memory-model-client tests passed");
