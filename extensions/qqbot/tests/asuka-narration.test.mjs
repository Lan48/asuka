import assert from "node:assert/strict";

const {
  isAsukaNarrationSegment,
  splitAsukaNarrationSegments,
  splitAsukaSpokenSegments,
  stripAsukaNarrationForSpeech,
} = await import("../dist/src/utils/narration-segments.js");

assert.deepEqual(
  splitAsukaNarrationSegments("（低头看你）早安（轻轻笑了一下）今天也在。"),
  ["（低头看你）", "早安", "（轻轻笑了一下）", "今天也在。"],
  "mixed stage directions and spoken text should be sent as separate segments",
);

assert.deepEqual(
  splitAsukaNarrationSegments("早安，我在。"),
  ["早安，我在。"],
  "plain text should stay as one segment",
);

assert.deepEqual(
  splitAsukaNarrationSegments("早安，我在。\n今天会好好陪你。"),
  ["早安，我在。", "今天会好好陪你。"],
  "newline-separated text should be sent as separate segments",
);

assert.deepEqual(
  splitAsukaNarrationSegments("（坐到你旁边）我在。\n先抱一下你。"),
  ["（坐到你旁边）", "我在。", "先抱一下你。"],
  "stage directions and newline-separated text should both split in order",
);

assert.deepEqual(
  splitAsukaNarrationSegments("QQBOT_CRON:payload（不要拆）"),
  ["QQBOT_CRON:payload（不要拆）"],
  "structured cron payloads must not be split",
);

assert.deepEqual(
  splitAsukaNarrationSegments("（看向镜头）<qqimg>/tmp/asuka.png</qqimg>给你。"),
  ["（看向镜头）<qqimg>/tmp/asuka.png</qqimg>给你。"],
  "media-tag messages must keep the media parser path intact",
);

assert.equal(isAsukaNarrationSegment("（气息顿了一下，嘴角弯起来）"), true);
assert.equal(isAsukaNarrationSegment("（气息顿了一下，嘴角弯起来"), true);
assert.equal(isAsukaNarrationSegment("我在呢。"), false);

assert.deepEqual(
  splitAsukaNarrationSegments("（低头看你（指尖停了一下））我在。"),
  ["（低头看你（指尖停了一下））", "我在。"],
  "nested full-width narration should stay out of spoken text",
);

assert.deepEqual(
  splitAsukaNarrationSegments("（低头看你\n我在。"),
  ["（低头看你", "我在。"],
  "unclosed full-width narration should stop at newline instead of being spoken",
);

assert.equal(
  stripAsukaNarrationForSpeech("（低头看你）我在。<#0.4#>抱一下你。"),
  "我在。<#0.4#>抱一下你。",
  "TTS speech text should exclude full-width narration while keeping spoken pause markers",
);

assert.equal(
  stripAsukaNarrationForSpeech("（低头看了一眼自己还剩小半杯的酒杯，没忍住笑出来）"),
  "",
  "pure narration should never be sent to TTS",
);

assert.deepEqual(
  splitAsukaSpokenSegments("我在。先抱一下你。你慢慢说。", 40),
  ["我在。", "先抱一下你。", "你慢慢说。"],
  "spoken TTS text should split every sentence into its own voice item",
);

assert.deepEqual(
  splitAsukaSpokenSegments("这句很长很长，已经超过限制，所以需要在逗号附近拆开继续说。", 18),
  ["这句很长很长，已经超过限制，", "所以需要在逗号附近拆开继续说。"],
  "long spoken sentences should be chunked before TTS length validation",
);

console.log("[qqbot:test] asuka-narration fixtures passed");
