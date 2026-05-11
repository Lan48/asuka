import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway.ts"), "utf-8");

const stableIndex = source.indexOf("const stablePromptSections");
const dynamicIndex = source.indexOf("const dynamicContextSections");
const agentBodyIndex = source.indexOf("const agentBody = userContent.startsWith");

assert.ok(stableIndex >= 0, "gateway should build a stable prompt section");
assert.ok(dynamicIndex >= 0, "gateway should build a dynamic context section");
assert.ok(agentBodyIndex >= 0, "gateway should assemble agentBody explicitly");
assert.ok(stableIndex < dynamicIndex, "stable prompt section should be constructed before dynamic context");

const agentBodySnippet = source.slice(agentBodyIndex, agentBodyIndex + 600);
assert.match(agentBodySnippet, /stablePromptSections\.join/, "agentBody should put stable prompt before dynamic context");
assert.match(agentBodySnippet, /dynamicContextSections\.join/, "agentBody should include dynamic context after stable prompt");
assert.ok(
  agentBodySnippet.indexOf("stablePromptSections.join") < agentBodySnippet.indexOf("dynamicContextSections.join"),
  "agentBody should keep stable prompt before dynamic context for prefix cache locality",
);

assert.equal(source.includes("- 消息ID: ${event.messageId}"), false, "LLM prompt should not include per-message id");
assert.equal(source.includes("- 当前时间戳(ms): ${nowMs}"), false, "LLM prompt should not include millisecond timestamp");

console.log("[qqbot:test] gateway prompt order fixtures passed");
