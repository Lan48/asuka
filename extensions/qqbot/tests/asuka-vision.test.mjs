import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  resolveMiniMaxVisionConfig,
  summarizeImagesForPrompt,
  formatImageUnderstandingForPrompt,
} = await import("../dist/src/utils/minimax-vision.js");

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-vision-"));
const tinyPng = path.join(fixtureDir, "tiny.png");
fs.writeFileSync(tinyPng, Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
));

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
        vision: {
          enabled: true,
          model: "MiniMax-VLM",
          maxInputBytes: 1024,
          maxImagesPerMessage: 2,
          maxSummaryChars: 80,
          timeoutMs: 5000,
          supportedContentTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        },
      },
    },
  },
};

const visionConfig = resolveMiniMaxVisionConfig(config);
assert.ok(visionConfig, "MiniMax vision config should resolve");
assert.equal(visionConfig.model, "MiniMax-VLM");
assert.equal(visionConfig.maxInputBytes, 1024);

let capturedUrl = "";
let capturedHeaders = {};
let capturedBody = {};
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers ?? {};
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    content: "图片里是一张很小的测试图，用于验证当前轮图片理解。",
    base_resp: {
      status_code: 0,
      status_msg: "success",
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const results = await summarizeImagesForPrompt([
    { pathOrUrl: tinyPng, contentType: "image/png", filename: "tiny.png" },
  ], visionConfig);
  assert.equal(capturedUrl, "https://api.minimaxi.com/v1/coding_plan/vlm");
  assert.equal(capturedHeaders.Authorization, "Bearer super-secret-minimax-key");
  assert.ok(capturedBody.image_url.startsWith("data:image/png;base64,"), "local image should be sent as data URI");
  assert.equal(results[0].status, "summarized");
  assert.match(results[0].summary, /测试图/);

  const prompt = formatImageUnderstandingForPrompt(results);
  assert.match(prompt, /只用于当前这轮回复/);
  assert.match(prompt, /不要自动写入长期记忆/);
  assert.match(prompt, /测试图/);
} finally {
  globalThis.fetch = originalFetch;
}

const skipped = await summarizeImagesForPrompt([
  { pathOrUrl: tinyPng, contentType: "application/pdf", filename: "bad.pdf" },
], visionConfig);
assert.equal(skipped[0].status, "skipped");
assert.equal(skipped[0].reason, "unsupported-image-type");

const largePng = path.join(fixtureDir, "large.png");
fs.writeFileSync(largePng, Buffer.alloc(2048));
const oversized = await summarizeImagesForPrompt([
  { pathOrUrl: largePng, contentType: "image/png", filename: "large.png" },
], visionConfig);
assert.equal(oversized[0].status, "skipped");
assert.equal(oversized[0].reason, "image-too-large");

globalThis.fetch = async () => new Response(JSON.stringify({
  base_resp: {
    status_code: 1001,
    status_msg: "quota exhausted super-secret-minimax-key",
  },
}), { status: 200, headers: { "content-type": "application/json" } });

try {
  const failed = await summarizeImagesForPrompt([
    { pathOrUrl: tinyPng, contentType: "image/png", filename: "tiny.png" },
  ], visionConfig);
  assert.equal(failed[0].status, "failed");
  assert.equal(String(failed[0].reason).includes("super-secret"), false, "vision errors should not leak API keys");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("[qqbot:test] asuka-vision fixtures passed");
