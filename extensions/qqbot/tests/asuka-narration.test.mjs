import assert from "node:assert/strict";

const { splitAsukaNarrationSegments } = await import("../dist/src/utils/narration-segments.js");

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
  splitAsukaNarrationSegments("QQBOT_CRON:payload（不要拆）"),
  ["QQBOT_CRON:payload（不要拆）"],
  "structured cron payloads must not be split",
);

assert.deepEqual(
  splitAsukaNarrationSegments("（看向镜头）<qqimg>/tmp/asuka.png</qqimg>给你。"),
  ["（看向镜头）<qqimg>/tmp/asuka.png</qqimg>给你。"],
  "media-tag messages must keep the media parser path intact",
);

console.log("[qqbot:test] asuka-narration fixtures passed");
