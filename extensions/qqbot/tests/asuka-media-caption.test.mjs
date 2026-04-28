import assert from "node:assert/strict";

const {
  dedupeCaptionAgainstVisibleText,
  mergeVisibleTextAndCaption,
} = await import("../dist/src/utils/media-caption.js");

assert.equal(
  dedupeCaptionAgainstVisibleText("我马上拍给你看。", "我马上拍给你看。"),
  "",
  "exact duplicate caption should be suppressed after visible text was already sent",
);

assert.equal(
  dedupeCaptionAgainstVisibleText("（低头笑）我马上拍给你看。", "我马上拍给你看。"),
  "",
  "caption contained in visible text should be suppressed",
);

assert.equal(
  dedupeCaptionAgainstVisibleText("我马上拍给你看。", "给你看一眼刚拍的。"),
  "给你看一眼刚拍的。",
  "distinct image caption should be kept",
);

assert.equal(
  mergeVisibleTextAndCaption("我马上拍给你看。", "我马上拍给你看。"),
  "我马上拍给你看。",
  "media payload caption merge should not duplicate visible text",
);

assert.equal(
  mergeVisibleTextAndCaption("我马上拍给你看。", "给你看一眼刚拍的。"),
  "我马上拍给你看。\n\n给你看一眼刚拍的。",
  "media payload caption merge should keep distinct visible text and caption",
);

console.log("[qqbot:test] asuka-media-caption fixtures passed");
