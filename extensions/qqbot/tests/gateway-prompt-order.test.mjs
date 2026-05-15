import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway.ts"), "utf-8");

const stableIndex = source.indexOf("const stablePromptSections");
const dynamicIndex = source.indexOf("const dynamicContextSections");
const agentBodyIndex = source.indexOf("const agentBody = userContent.startsWith");
const ctxPayloadIndex = source.indexOf("const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext");

assert.ok(stableIndex >= 0, "gateway should build a stable prompt section");
assert.ok(dynamicIndex >= 0, "gateway should build a dynamic context section");
assert.ok(agentBodyIndex >= 0, "gateway should assemble agentBody explicitly");
assert.ok(ctxPayloadIndex >= 0, "gateway should assemble ctxPayload explicitly");
assert.ok(stableIndex < dynamicIndex, "stable prompt section should be constructed before dynamic context");

const agentBodySnippet = source.slice(agentBodyIndex, agentBodyIndex + 600);
assert.doesNotMatch(agentBodySnippet, /stablePromptSections\.join/, "agentBody should not repeat stable prompt behind dynamic message metadata");
assert.match(agentBodySnippet, /dynamicContextSections\.join/, "agentBody should include dynamic per-message context");

const ctxPayloadSnippet = source.slice(ctxPayloadIndex, ctxPayloadIndex + 1200);
assert.match(ctxPayloadSnippet, /GroupSystemPrompt: stableSystemPrompt/, "stable prompt should be passed as system context before user-message metadata");

assert.equal(source.includes("- 消息ID: ${event.messageId}"), false, "LLM prompt should not include per-message id");
assert.equal(source.includes("- 当前时间戳(ms): ${nowMs}"), false, "LLM prompt should not include millisecond timestamp");

const clearModeIndex = source.indexOf("async function clearCompanionSessionModeOverrides");
const clearModeCallIndex = source.indexOf("await clearCompanionSessionModeOverrides");
assert.ok(clearModeIndex >= 0, "gateway should clear companion session mode overrides");
assert.ok(clearModeCallIndex > clearModeIndex, "natural companion messages should clear persisted mode overrides");
const clearModeSnippet = source.slice(clearModeIndex, clearModeIndex + 1200);
assert.match(clearModeSnippet, /"thinkingLevel"/, "companion mode reset should clear persisted thinking mode");
assert.match(clearModeSnippet, /"reasoningLevel"/, "companion mode reset should clear persisted reasoning mode");
assert.match(clearModeSnippet, /"verboseLevel"/, "companion mode reset should clear persisted verbose mode");

console.log("[qqbot:test] gateway prompt order fixtures passed");
