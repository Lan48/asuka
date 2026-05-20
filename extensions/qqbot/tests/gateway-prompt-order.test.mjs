import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway.ts"), "utf-8");
const outboundSource = fs.readFileSync(path.join(process.cwd(), "src", "outbound.ts"), "utf-8");
const configSource = fs.readFileSync(path.join(process.cwd(), "src", "config.ts"), "utf-8");
const imageGenerationSource = fs.readFileSync(path.join(process.cwd(), "src", "utils", "openclaw-image-generation.ts"), "utf-8");

const stableIndex = source.indexOf("const stablePromptSections");
const dynamicIndex = source.indexOf("const dynamicContextSections");
const agentBodyIndex = source.indexOf("const agentBody = userContent.startsWith");
const ctxPayloadIndex = source.indexOf("const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext");

assert.ok(stableIndex >= 0, "gateway should build a stable prompt section");
assert.ok(dynamicIndex >= 0, "gateway should build a dynamic context section");
assert.ok(agentBodyIndex >= 0, "gateway should assemble agentBody explicitly");
assert.ok(ctxPayloadIndex >= 0, "gateway should assemble ctxPayload explicitly");
assert.ok(stableIndex < dynamicIndex, "stable prompt section should be constructed before dynamic context");
assert.ok(
  source.includes("当前场景是两个人正在私聊，不是在写第三人称故事或摘要"),
  "private chat persona should softly anchor replies as direct two-person conversation"
);
assert.match(
  source,
  /fileURLToPath\(import\.meta\.url\)/,
  "gateway should define an ESM-safe module directory before resolving bundled files"
);
assert.match(
  outboundSource,
  /fileURLToPath\(import\.meta\.url\)/,
  "proactive outbound sends should define an ESM-safe module directory before resolving bundled files"
);
assert.match(
  configSource,
  /stateDir,\s*"\.\.",\s*"\.\.",\s*"tools",\s*"node_modules",\s*"openclaw",\s*"openclaw\.mjs"/,
  "runtime config should find the host OpenClaw CLI from a nested .openclaw state dir"
);
assert.match(
  imageGenerationSource,
  /stateDir,\s*"\.\.",\s*"\.\.",\s*"tools",\s*"node_modules",\s*"openclaw",\s*IMAGE_RUNTIME_MODULE_RELATIVE/,
  "image generation should prefer the host OpenClaw runtime before bundled plugin dependencies"
);
assert.match(
  imageGenerationSource,
  /execOpenClaw\(args,[\s\S]{0,120}env: getQQBotLocalOpenClawEnv\(\)/,
  "image generation CLI fallback should run with the resolved local OpenClaw environment"
);
assert.ok(
  source.includes("优先用自然口语里的“我/你/我们”"),
  "chat persona should prefer first/second-person wording without hard rejection rules"
);

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
  /No response within timeout[\s\S]{0,2000}sendErrorMessage/,
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
  /parseProactiveNudge[\s\S]*用户只发送了一个主动续聊触发符/,
  "standalone punctuation nudges should be interpreted as proactive turns, not literal message content"
);
assert.match(
  outboundSource,
  /主动消息可以像普通回复一样自行判断文字或语音/,
  "proactive cron rendering should allow Asuka to choose text or voice"
);
assert.match(
  outboundSource,
  /sendCronMessage[\s\S]{0,4500}sendText\(\{[\s\S]{0,600}replyToId: null/,
  "cron proactive delivery should route through sendText so structured audio payloads use the same sender as replies"
);
assert.match(
  source,
  /Treating <qqvoice> content as TTS text/,
  "legacy qqvoice text should be spoken through TTS instead of being treated as a file path"
);
assert.match(
  source,
  /sendMixedTTSReplySegments\(item\.content\)/,
  "legacy qqvoice text should use the same mixed TTS sender as structured audio replies"
);
assert.match(
  source,
  /isAsukaNarrationSegment\(visibleSegment\)[\s\S]{0,160}sendReplyTextSegments\(visibleSegment\)/,
  "mixed voice replies should send full-width narration as text instead of TTS"
);
assert.match(
  source,
  /sendMixedTTSReplySegments\(ttsText, parsedPayload\.tts\)/,
  "structured audio payloads should split narration text from spoken TTS"
);
assert.match(
  source,
  /userRequestedVoiceReply[\s\S]{0,220}sendMixedTTSReplySegments\(textWithoutImages/,
  "forced voice replies should also split narration text from spoken TTS"
);
assert.match(
  source,
  /const speechText = stripAsukaNarrationForSpeech\(rawTtsText\)/,
  "low-level TTS sends should strip full-width narration as a final safety guard"
);
assert.ok(
  source.includes("普通说出口的话直接写，不要用英文双引号或中文弯引号包起来"),
  "voice prompt should forbid wrapping spoken dialogue in quotes"
);
assert.match(
  source,
  /function cleanOutgoingTextSegment[\s\S]{0,220}stripWrappingDialogueQuotes/,
  "outgoing text cleanup should remove unnecessary wrapping dialogue quotes"
);
assert.match(
  source,
  /for \(const segment of segments\)[\s\S]{0,140}const visibleSegment = cleanOutgoingTextSegment\(segment\)/,
  "split outgoing text segments should also remove wrapping dialogue quotes"
);
assert.match(
  source,
  /function stabilizeQQBotTTSOverrides[\s\S]{0,180}voiceModify/,
  "QQBot TTS should ignore model-provided voice and voiceModify overrides to keep one stable timbre"
);
assert.ok(
  source.includes("禁止覆盖 voice 或使用 voiceModify"),
  "voice prompt should forbid model-driven voice/timbre switching"
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
  /MINIMAX_TTS_INTERJECTION_TAGS[\s\S]{0,220}sighs[\s\S]{0,120}emm/,
  "MiniMax TTS interjection markers should be recognized for visible-text cleanup"
);
assert.match(
  source,
  /ASUKA_TTS_INTERJECTION_RE[\s\S]{0,220}MINIMAX_TTS_INTERJECTION_TAGS/,
  "Japanese corner-bracket TTS markers should be recognized before MiniMax conversion"
);
assert.match(
  source,
  /normalizeTTSControlMarkersForSpeech[\s\S]{0,180}tag\.toLowerCase\(\)/,
  "Japanese corner-bracket TTS markers should be converted to MiniMax parentheses only for speech"
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
  source.includes("（气息轻轻顿了一下）我在呢。<#0.4#>「breath」轻轻抱你一下。"),
  "voice prompt examples should teach narration splitting plus Japanese-bracket MiniMax TTS controls inside audio payload path"
);
assert.ok(
  source.includes("不要直接输出 (breath)"),
  "voice prompt should avoid direct MiniMax parentheses in model output"
);
assert.ok(
  source.includes("不是 TTS 朗读文本"),
  "voice prompt should clarify full-width narration is text, not TTS input"
);
assert.match(
  source,
  /sendQueue\.push\(\{ type: hasTTS \? "voiceText" : "text", content: mediaPath \}\)/,
  "legacy qqvoice text should never be treated as an audio file path"
);
assert.match(
  source,
  /const isTextualVoiceTag[\s\S]{0,520}sendQueue\.push\(\{ type: isTextualVoiceTag && hasTTS \? "voiceText" : "text", content: textBefore \}\)/,
  "text before a textual <qqvoice> tag should also be routed through mixed TTS"
);
assert.match(
  source,
  /sawTextualVoiceTag && hasTTS \? "voiceText" : "text", content: textAfter/,
  "text after a textual <qqvoice> tag should also be routed through mixed TTS"
);
assert.match(
  source,
  /function resolveDirectSelfieRuntimeConfig[\s\S]{0,900}models\?\.providers\?\.minimax/,
  "direct selfie flow should resolve MiniMax provider config when skill-level image config is incomplete"
);
assert.match(
  source,
  /skillCfg\.apiKey[\s\S]{0,180}skillEnv\.STUDIO_API_KEY[\s\S]{0,180}providerApiKey/,
  "direct selfie flow should use the unified MiniMax provider key if asuka-selfie key fields are absent"
);
assert.match(
  source,
  /shouldUseMiniMaxDefaults[\s\S]{0,260}DEFAULT_MINIMAX_IMAGE_MODEL/,
  "direct selfie flow should default MiniMax provider-backed images to image-01"
);
assert.match(
  source,
  /SELFIE_TRAILING_DASH_RE[\s\S]{0,260}\\u2014[\s\S]{0,260}\\uff0d[\s\S]{0,520}function shouldForceSelfieFromTrailingDash\(content: string\)[\s\S]{0,180}SELFIE_TRAILING_DASH_RE\.test\(trimSelfieTriggerTail\(content\)\)/,
  "gateway should recognize half-width, full-width, and unicode dash suffixes as explicit selfie triggers"
);
assert.match(
  source,
  /SELFIE_TRAILING_IGNORABLE_RE[\s\S]{0,260}\\u200b[\s\S]{0,520}function stripTrailingSelfieTrigger\(content: string\)[\s\S]{0,180}replace\(SELFIE_TRAILING_DASH_RE, ""\)/,
  "gateway should strip trailing dash triggers without preserving invisible tail characters"
);
const trailingDashTriggerIndex = source.indexOf("Trailing dash selfie trigger detected");
const modelRequestIndex = source.indexOf("const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig");
assert.ok(trailingDashTriggerIndex >= 0, "gateway should log explicit trailing dash selfie triggers");
assert.ok(modelRequestIndex >= 0, "gateway should resolve message config before agent dispatch");
assert.ok(
  trailingDashTriggerIndex < modelRequestIndex,
  "trailing dash selfie trigger should be detected before the agent/model turn"
);
const trailingDashInstructionIndex = source.indexOf("- 本轮回复方式: 用户输入以 `-` 结尾");
assert.ok(trailingDashInstructionIndex >= 0, "gateway should add a model-facing trailing dash instruction");
const trailingDashInstruction = source.slice(trailingDashInstructionIndex, trailingDashInstructionIndex + 900);
assert.match(
  trailingDashInstruction,
  /不要说“我去拍一张，等我一下”[\s\S]{0,900}QQBOT_PAYLOAD selfie[\s\S]{0,120}不能只输出载荷/,
  "trailing dash selfie trigger should instruct the model to generate visible text plus a selfie payload"
);
assert.doesNotMatch(
  source,
  /sendVisibleReplyText\("我去拍一张，等我一下。"\)/,
  "trailing dash selfie trigger should not send a fixed waiting message"
);
assert.ok(
  !/if \(shouldForceSelfieFromTrailingDash\(event\.content\)\)[\s\S]{0,1400}return;/.test(source),
  "trailing dash selfie trigger should not short-circuit before the agent/model turn"
);
assert.match(
  source,
  /interface DirectSelfiePromptContext[\s\S]{0,520}recentChatTranscript[\s\S]{0,520}asukaStatePrompt[\s\S]{0,520}asukaConversationDigestPrompt[\s\S]{0,260}modelSelfiePrompt/,
  "direct selfie prompt should accept the same dynamic context plus the model-generated image intent"
);
assert.match(
  source,
  /const directSelfieContext: DirectSelfiePromptContext = \{[\s\S]{0,820}currentLocalTime[\s\S]{0,820}recentChatTranscript[\s\S]{0,820}asukaStatePrompt[\s\S]{0,820}asukaMemoryPrompt[\s\S]{0,820}asukaConversationDigestPrompt[\s\S]{0,820}currentTurnContext/,
  "gateway should build a reusable direct selfie context from the normal reply context"
);
assert.match(
  source,
  /const payloadSelfieContext: DirectSelfiePromptContext = \{[\s\S]{0,180}\.\.\.directSelfieContext[\s\S]{0,180}modelSelfiePrompt: parsedPayload\.prompt[\s\S]{0,420}buildDirectSelfiePromptFromContext\([\s\S]{0,240}payloadSelfieContext/,
  "selfie payload handling should keep model-generated image prompts separate from visible reply text"
);
assert.match(
  source,
  /function resolveSelfieVisiblePayloadText\([\s\S]{0,900}const visibleText = cleanOutgoingTextSegment\(resolveVisiblePayloadText[\s\S]{0,900}const captionText = cleanOutgoingTextSegment\(caption \|\| ""\)[\s\S]{0,900}return "好，我按刚刚的语境给你发一张。"/,
  "selfie payload handling should recover a safe visible reply when the model emits only a payload"
);
assert.match(
  source,
  /const selfieVisibleText = resolveSelfieVisiblePayloadText\([\s\S]{0,420}parsedPayload\.caption[\s\S]{0,420}await sendVisibleReplyText\(selfieVisibleText\)[\s\S]{0,700}dedupeCaptionAgainstVisibleText\(selfieVisibleText, parsedPayload\.caption\)/,
  "selfie payload should send visible text separately and avoid duplicating it as the image caption"
);
const directSelfiePromptBuilderIndex = source.indexOf("function buildDirectSelfiePromptFromContext");
assert.ok(directSelfiePromptBuilderIndex >= 0, "gateway should define direct selfie prompt builder");
const directSelfiePromptBuilder = source.slice(directSelfiePromptBuilderIndex, directSelfiePromptBuilderIndex + 2600);
assert.match(
  directSelfiePromptBuilder,
  /formatSelfiePromptContextSection\("最近一周对话", context\.recentChatTranscript[\s\S]{0,520}formatSelfiePromptContextSection\("关系与场景状态", context\.asukaStatePrompt[\s\S]{0,520}formatSelfiePromptContextSection\("会话摘要", context\.asukaConversationDigestPrompt[\s\S]{0,760}formatSelfiePromptContextSection\("当前轮次", context\.currentTurnContext/,
  "direct selfie prompt should serialize conversation transcript, state, digest, and current turn sections"
);
const visualAnchorIndex = source.indexOf("function loadAsukaVisualIdentityAnchor");
assert.ok(visualAnchorIndex >= 0, "gateway should define a visual identity anchor loader");
const visualAnchorSnippet = source.slice(visualAnchorIndex, visualAnchorIndex + 2800);
assert.ok(
  visualAnchorSnippet.includes("collectBulletBlocks") && visualAnchorSnippet.includes("/^\\s{2,}\\S/"),
  "gateway visual identity loader should parse multiline markdown bullets, body descriptors, and prose appearance lines"
);
assert.ok(
  visualAnchorSnippet.includes('path.resolve(process.cwd(), "workspace/IDENTITY.md")') &&
    visualAnchorSnippet.includes('path.resolve(__dirname, "../../../../workspace/IDENTITY.md")'),
  "gateway visual identity loader should find workspace files from project cwd and compiled dist/src"
);
assert.match(
  visualAnchorSnippet,
  /Body[\s\S]{0,900}Her\|Your[\s\S]{0,900}figure\|curves\|bust\|skin/,
  "gateway visual identity loader should include body descriptors and prose appearance lines"
);
const outboundVisualAnchorIndex = outboundSource.indexOf("function loadAsukaVisualIdentityAnchor");
assert.ok(outboundVisualAnchorIndex >= 0, "outbound should define a visual identity anchor loader");
const outboundVisualAnchorSnippet = outboundSource.slice(outboundVisualAnchorIndex, outboundVisualAnchorIndex + 2800);
assert.ok(
  outboundVisualAnchorSnippet.includes("collectBulletBlocks") && outboundVisualAnchorSnippet.includes("/^\\s{2,}\\S/"),
  "cron selfie visual identity loader should parse multiline markdown bullets"
);
assert.ok(
  outboundVisualAnchorSnippet.includes('path.resolve(process.cwd(), "workspace/IDENTITY.md")') &&
    outboundVisualAnchorSnippet.includes('path.resolve(__dirname, "../../../../workspace/IDENTITY.md")'),
  "cron selfie visual identity loader should find workspace files from project cwd and compiled dist/src"
);
assert.match(
  outboundVisualAnchorSnippet,
  /Body[\s\S]{0,900}Her\|Your[\s\S]{0,900}figure\|curves\|bust\|skin/,
  "cron selfie visual identity loader should match direct message behavior"
);
assert.match(
  source,
  /const responseTimeout = forceSelfieFromTrailingDash \? 210000 : 120000/,
  "trailing dash selfie requests should wait longer for the model to produce natural visible text plus selfie payload"
);
assert.match(
  source,
  /No response within timeout[\s\S]{0,900}forceSelfieFromTrailingDash[\s\S]{0,900}resolveSelfieVisiblePayloadText[\s\S]{0,900}buildDirectSelfiePromptFromContext[\s\S]{0,900}runDirectSelfieFlow/,
  "trailing dash selfie requests should fall back to visible text plus selfie generation when the model turn times out"
);
assert.match(
  outboundSource,
  /function buildCronSelfiePrompt\(\s*account: ResolvedQQBotAccount[\s\S]{0,1300}buildAsukaStatePrompt\(peerContext\)[\s\S]{0,1300}buildConversationDigestPrompt\(peerContext\)[\s\S]{0,1300}resolveRecentTranscriptFromNormalSession\(peerId\)/,
  "cron selfie prompt should include proactive state, digest, and normal-session transcript context"
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
  /let userFacingDeliverClaimed = false[\s\S]{0,360}Skipping duplicate user-facing deliver/,
  "QQBot should suppress duplicate final/user-facing delivers for the same inbound turn"
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
