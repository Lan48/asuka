import assert from "node:assert/strict";

const {
  isAsukaNarrationSegment,
  splitAsukaNarrationSegments,
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
assert.equal(isAsukaNarrationSegment("我在呢。"), false);

console.log("[qqbot:test] asuka-narration fixtures passed");
