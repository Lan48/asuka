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

assert.equal(
  source.includes("Timeout fallback kept silent"),
  false,
  "QQBot response timeout must not stay silent"
);
assert.match(
  source,
  /No response within timeout[\s\S]{0,500}sendErrorMessage/,
  "QQBot response timeout should send a user-facing fallback"
);
assert.equal(
  source.includes("消息没有稳稳发出去"),
  false,
  "QQBot timeout fallback should not expose delivery mechanics"
);
assert.equal(
  source.includes("内部错误发出来"),
  false,
  "QQBot fallbacks should not mention suppressed internal errors"
);
assert.match(
  source,
  /parsedPayload\.mediaType === "audio"[\s\S]{0,300}const ttsText = parsedPayload\.path/,
  "structured audio should speak the model-generated payload path, not the caption"
);
assert.match(
  source,
  /sendC2CVoiceMessage\(token, event\.senderId, silkBase64, event\.messageId, visibleTtsText\)/,
  "structured audio should persist the visible spoken TTS text for voice refs"
);
assert.match(
  source,
  /"audioAsVoice" in payload[\s\S]{0,160}hasResponse = true/,
  "internal media final deliver should count as a response by payload shape and avoid transcript fallback"
);
assert.match(
  source,
  /Treating <qqvoice> content as TTS text/,
  "legacy qqvoice text should be spoken through TTS instead of being treated as a file path"
);
assert.match(
  source,
  /sendTTSReplyText\(item\.content\)/,
  "legacy qqvoice text should use the same TTS sender as structured audio replies"
);
assert.ok(
  source.includes(String.raw`text.replace(/\\?\[\\?\[[a-z_][a-z0-9_]*(?::\s*[^\]\r\n]*)?\]\\?\]/gi, "")`),
  "internal marker filtering should remove escaped and unescaped bracket markers"
);
assert.match(
  source,
  /const sendVisibleReplyText = async[\s\S]{0,160}cleanOutgoingTextSegment\(text\)/,
  "visible text sends should strip internal markers at the final send boundary"
);
assert.match(
  source,
  /function cleanOutgoingTextSegment[\s\S]{0,220}\^\\\\\+\$/,
  "outgoing text cleanup should drop lone markdown escape artifacts"
);
assert.match(
  source,
  /function stripTTSControlMarkers[\s\S]{0,260}<#\\s\*/,
  "TTS pause markers should be stripped from visible text and transcript context"
);
assert.match(
  source,
  /MINIMAX_TTS_INTERJECTION_RE[\s\S]{0,220}sighs[\s\S]{0,120}emm/,
  "MiniMax TTS interjection markers should be recognized for visible-text cleanup"
);
assert.match(
  source,
  /function stripStructuredPayloadForVisibleText[\s\S]{0,320}parseQQBotPayload/,
  "final visible text cleanup should strip structured payload artifacts before sending transcript fallbacks"
);
assert.match(
  source,
  /attachment\.transcript = visibleTtsText/,
  "saved voice transcripts should not contain raw TTS control markers"
);
assert.ok(
  source.includes("(sighs)我在呢。<#0.4#>轻轻抱你一下。"),
  "voice prompt examples should teach MiniMax TTS controls only inside audio payload path"
);
assert.match(
  source,
  /sendQueue\.push\(\{ type: hasTTS \? "voiceText" : "text", content: mediaPath \}\)/,
  "legacy qqvoice text should never be treated as an audio file path"
);
assert.ok(
  !source.includes("shouldForceFreshSession"),
  "reply loop correction should not strip conversation context or force /new sessions"
);
assert.match(
  source,
  /adding correction while preserving context/,
  "reply loop correction should preserve context when adding anti-loop guidance"
);
assert.match(
  source,
  /disableBlockStreaming:\s*true/,
  "QQBot should wait for final text instead of relying on block streaming"
);
assert.match(
  source,
  /Dispatch completed without deliver[\s\S]{0,800}readLatestAssistantTextFromSessionTranscript/,
  "QQBot should recover generated text when dispatch completes without deliver"
);
assert.match(
  source,
  /const flushAllBufferedMessages[\s\S]{0,500}flushBufferedMessage/,
  "gateway should provide a way to flush buffered messages"
);
assert.match(
  source,
  /abortSignal\.addEventListener\("abort"[\s\S]{0,500}flushAllBufferedMessages/,
  "channel abort should flush buffered messages before cleanup"
);
assert.match(
  source,
  /onStatus\?: \(status: Record<string, unknown>\) => void/,
  "gateway should expose runtime status patches to the channel host"
);
assert.match(
  source,
  /const publishRuntimeStatus[\s\S]{0,500}connected: true/,
  "runtime status activity patches should mark the channel connected"
);
assert.match(
  source,
  /const publishQueueStatus[\s\S]{0,900}publishRuntimeStatus/,
  "buffered and queued messages should keep the runtime channel status connected"
);
assert.match(
  source,
  /t === "RESUMED"[\s\S]{0,500}publishRuntimeStatus/,
  "resumed gateway sessions should refresh connected runtime status"
);

console.log("[qqbot:test] gateway prompt order fixtures passed");
