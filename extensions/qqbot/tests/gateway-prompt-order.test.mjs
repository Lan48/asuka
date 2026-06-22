import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src", "gateway.ts"), "utf-8");
const outboundSource = fs.readFileSync(path.join(process.cwd(), "src", "outbound.ts"), "utf-8");
const configSource = fs.readFileSync(path.join(process.cwd(), "src", "config.ts"), "utf-8");
const asukaStateSource = fs.readFileSync(path.join(process.cwd(), "src", "asuka-state.ts"), "utf-8");
const imageGenerationSource = fs.readFileSync(path.join(process.cwd(), "src", "utils", "openclaw-image-generation.ts"), "utf-8");
const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf-8");

function requiredSlice(text, label, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert.ok(start >= 0, `${label} should contain ${startNeedle}`);
  const end = text.indexOf(endNeedle, start);
  assert.ok(end > start, `${label} should contain ${endNeedle} after ${startNeedle}`);
  return text.slice(start, end);
}

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
assert.match(
  imageGenerationSource,
  /runtimeMessage !== OPENCLAW_IMAGE_RUNTIME_UNAVAILABLE_MESSAGE[\s\S]{0,260}OpenClaw official image generation failed: class=\$\{classification\}; runtime=\$\{runtimeMessage\}/,
  "OpenClaw image generation should fall back externally after one classified official runtime failure"
);
assert.match(
  imageGenerationSource,
  /runtime-child\.mjs[\s\S]{0,2400}spawn\(process\.execPath,/,
  "OpenClaw official image runtime should run in an isolated child process"
);
assert.match(
  imageGenerationSource,
  /setTimeout\([\s\S]{0,220}child\.kill\(\)[\s\S]{0,220}timed out after \$\{timeoutMs\}ms and was killed/,
  "OpenClaw official image runtime timeout should kill the child process"
);
assert.match(
  imageGenerationSource,
  /request start provider=\$\{diagnostic\.provider\}[\s\S]{0,260}proxyMode=\$\{diagnostic\.proxyMode\}[\s\S]{0,120}envProxy=\$\{diagnostic\.proxy\}/,
  "OpenClaw official image runtime should log proxy and request diagnostics"
);
assert.match(
  apiSource,
  /return url\.protocol === "http:" \|\| url\.protocol === "https:";/,
  "QQ image uploads should localize every remote HTTP(S) image URL before /files upload"
);
assert.match(
  apiSource,
  /throw new Error\(`remote image localization failed for \$\{host\}: \$\{message\}`\);/,
  "QQ image uploads should fail clearly instead of falling back to brittle remote URL uploads"
);
assert.match(
  asukaStateSource,
  /function orderProactiveTimingModels[\s\S]{0,260}isDeepSeekModelConfig/,
  "proactive timing planner should explicitly order DeepSeek-capable models first"
);
assert.match(
  asukaStateSource,
  /const models = orderProactiveTimingModels\(/,
  "proactive timing planner should apply DeepSeek-first ordering without changing shared scene resolver behavior"
);
assert.match(
  asukaStateSource,
  /只能输出一个 JSON object[\s\S]{0,160}不能解释[\s\S]{0,160}不能使用 markdown[\s\S]{0,160}不能输出 JSON 之外的任何文字/,
  "proactive timing planner prompt should strictly require JSON-only output"
);
assert.match(
  asukaStateSource,
  /proactive timing planner plan_parse_failed[\s\S]{0,180}getProactiveTimingPlanRejectReason/,
  "proactive timing planner should log parse failure reasons"
);
assert.doesNotMatch(
  asukaStateSource,
  /proactive timing planner[\s\S]{0,240}apiKey/,
  "proactive timing planner logs should not include raw apiKey fields"
);
for (const [label, text] of [["gateway", source], ["outbound", outboundSource]]) {
  assert.match(
    text,
    /buildStudioMediaApiUrlCandidates\(config\.baseUrl,\s*"images\/generations"\)/,
    `${label} Studio Media fallback should use xmapi's documented image generation endpoint candidates`
  );
  assert.match(
    text,
    /const requestBody = JSON\.stringify\([\s\S]{0,700}image_url:\s*buildImageDataUrlFromFile\(referenceImagePath\)[\s\S]{0,900}"Content-Type":\s*"application\/json"/,
    `${label} Studio Media fallback should send the reference image as JSON image_url`
  );
  assert.doesNotMatch(
    text,
    /function generateStudioMediaSelfieImageUrl[\s\S]{0,900}images\/edits/,
    `${label} Studio Media fallback should not call the multipart edit endpoint for gpt-image-2`
  );
  assert.match(
    text,
    /STUDIO_MEDIA_IMAGE_CLIENT_ABORT_MS\s*=\s*180_000/,
    `${label} Studio Media image generation should use a client abort guard constant`
  );
  assert.match(
    text,
    /function generateStudioMediaSelfieImageUrl[\s\S]{0,2400}AbortController/,
    `${label} Studio Media image generation should use AbortController`
  );
  assert.match(
    text,
    /Studio Media image generation fetch failed:[\s\S]{0,240}clientAbortMs=\$\{STUDIO_MEDIA_IMAGE_CLIENT_ABORT_MS\}/,
    `${label} Studio Media image generation should fail with a client-side abort guard with diagnosable errors`
  );
  const envProxyFunction = requiredSlice(text, label, "function getEnvProxyUrl", "function getProxySource");
  assert.match(envProxyFunction, /HTTPS_PROXY[\s\S]{0,220}ALL_PROXY/, `${label} Studio Media image generation should honor env proxy variables`);
  const loopbackPreflightFunctions = requiredSlice(text, label, "function getLoopbackProxyProbeTarget", "async function buildProxyDispatcherInit");
  assert.match(
    loopbackPreflightFunctions,
    /LOCAL_STUDIO_PROXY_PREFLIGHT_TIMEOUT_MS[\s\S]{0,1200}Studio override proxy preflight failed/,
    `${label} Studio Media image generation should fail fast when a loopback override proxy is down`
  );
  const dispatcherFunction = requiredSlice(text, label, "async function buildProxyDispatcherInit", "function describeFetchFailure");
  assert.match(
    dispatcherFunction,
    /const proxyUrl = getEnvProxyUrl\(overrideProxyUrl\)[\s\S]{0,220}await assertLoopbackProxyReachable\(overrideProxyUrl\)[\s\S]{0,240}new undici\.ProxyAgent\(proxyUrl\)/,
    `${label} Studio Media image generation should preflight loopback overrides before building a proxy dispatcher`
  );
  assert.match(
    text,
    /STUDIO_IMAGE_PROXY_URL[\s\S]{0,140}STUDIO_PROXY_URL/,
    `${label} Studio Media image generation should allow a dedicated Studio proxy override`
  );
}
assert.match(
  source.slice(source.indexOf("const runDirectSelfieFlow = async"), source.indexOf("const sendDirectMediaPayload")),
  /preferOfficialImageGeneration[\s\S]*officialImageConfigured[\s\S]*if \(preferOfficialImageGeneration\)[\s\S]*generateOfficialOpenClawImageDataUrl[\s\S]*falling back to Studio-compatible path/,
  "direct selfie flow should prefer official OpenClaw image generation before Studio-compatible fallback"
);
assert.match(
  source.slice(source.indexOf("export function resolveDirectSelfieRuntimeConfig"), source.indexOf("const SELFIE_IDENTITY_LOCK_PROMPT")),
  /STUDIO_IMAGE_PROXY_URL[\s\S]{0,120}process\.env\.STUDIO_IMAGE_PROXY_URL[\s\S]{0,180}STUDIO_PROXY_URL[\s\S]{0,120}process\.env\.STUDIO_PROXY_URL/,
  "direct selfie flow should fall back to process env Studio proxy overrides when OpenClaw passes a narrowed channel config"
);
assert.match(
  source,
  /Direct selfie image config:[\s\S]{0,260}preferOfficial=\$\{preferOfficialImageGeneration\}[\s\S]{0,180}proxySource=\$\{getProxySource\(proxyUrl\)\}[\s\S]{0,120}proxy=\$\{describeProxyForLog\(proxyUrl\)\}/,
  "direct selfie flow should log the effective proxy source without exposing credentials"
);
assert.match(
  outboundSource.slice(outboundSource.indexOf("async function runDirectSelfieFlowForCron"), outboundSource.indexOf("async function refreshProactiveSceneAfterDelivery")),
  /preferOfficialImageGeneration[\s\S]*officialImageConfigured[\s\S]*if \(preferOfficialImageGeneration\)[\s\S]*generateOfficialOpenClawImageDataUrl[\s\S]*falling back to Studio-compatible path/,
  "cron selfie flow should prefer official OpenClaw image generation before Studio-compatible fallback"
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
assert.match(
  source,
  /function resolveHeartbeatAckTimeoutMs\(intervalMs: number\)[\s\S]{0,500}Math\.max/,
  "gateway should compute a bounded heartbeat ACK timeout"
);
assert.match(
  source,
  /Heartbeat ACK timeout after[\s\S]{0,500}reconnecting WebSocket/,
  "gateway should reconnect when heartbeat ACKs stop arriving"
);
assert.match(
  source,
  /case 11:[\s\S]{0,250}clearHeartbeatAckWatchdog/,
  "heartbeat ACK should clear the pending heartbeat watchdog"
);
assert.match(
  source,
  /suppressNextCloseReconnect = true;[\s\S]{0,200}cleanup\(4000, "heartbeat ack timeout"\);[\s\S]{0,120}scheduleReconnect/,
  "heartbeat timeout reconnect should avoid duplicate close-triggered reconnect scheduling"
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
assert.equal(
  source.includes("我在。刚才那句没接稳，我重新接你。"),
  false,
  "QQBot fallbacks should not train repeated repair catchphrases into conversation context"
);
assert.match(
  source,
  /const responseTimeout = forceSelfieFromTrailingDash \? 20 \* 60 \* 1000 : 5 \* 60 \* 1000/,
  "normal replies should wait long enough to avoid premature timeout fallbacks during compaction/model latency"
);
assert.match(
  source,
  /const metaText = String\(meta\.text \|\| ""\);[\s\S]{0,240}if \(!meta\.mediaType && \(looksLikeTransportFallbackText\(metaText\) \|\| looksLikeInternalProcessLeak\(metaText\)\)\)[\s\S]{0,180}Skipped caching internal\/system refIdx/,
  "transport fallbacks and internal/system notices should not be cached as recent conversation context"
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
  /continuing proactive[\s\S]{0,220}latest normal conversation context/,
  "stale proactive cron jobs should continue instead of being skipped"
);
assert.match(
  outboundSource,
  /最新普通对话上下文/,
  "proactive cron rendering should include latest normal conversation context"
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
const internalMarkerFilterSnippet = requiredSlice(source, "gateway", "function filterInternalMarkers", "export function stripWrappingDialogueQuotes");
assert.match(
  internalMarkerFilterSnippet,
  /MODEL_THINKING_BLOCK_RE[\s\S]{0,180}\\\\\?\\\[\\\\\?\\\[/,
  "internal marker filtering should remove model thinking blocks and escaped/unescaped bracket markers"
);
assert.match(
  source,
  /const resolveTimeSafeVisibleReplyText = \(text: string[\s\S]{0,220}cleanOutgoingTextSegment\(text\)/,
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
  /不要说“我去拍一张，等我一下”[\s\S]{0,900}只输出一段自然[\s\S]{0,900}文本发送后[\s\S]{0,900}刚刚生成的可见回复生成图片 prompt/,
  "trailing dash selfie trigger should make the model generate normal text before the post-reply image prompt stage"
);
assert.match(
  trailingDashInstruction,
  /不要输出任何 QQBOT_PAYLOAD[\s\S]{0,120}<qqimg> 标签[\s\S]{0,120}本地图片路径/,
  "trailing dash selfie trigger should forbid model-authored media tags and local image paths"
);
assert.doesNotMatch(
  trailingDashInstruction,
  /QQBOT_PAYLOAD selfie/,
  "trailing dash selfie trigger should not ask the main reply model to produce the image payload"
);
assert.match(
  trailingDashInstruction,
  /Asuka 主角图片[\s\S]{0,900}不一定是手持自拍[\s\S]{0,900}不要把所有请求都写成固定自拍/,
  "trailing dash image generation should keep Asuka as the subject without forcing a fixed selfie composition"
);
assert.doesNotMatch(
  source,
  /sendVisibleReplyText\("我去拍一张，等我一下。"\)/,
  "trailing dash selfie trigger should not send a fixed waiting message"
);
assert.doesNotMatch(
  source,
  /好，我按你刚刚说的画面来。|好，我按刚刚的语境给你发一张。/,
  "trailing dash selfie trigger should not contain fixed visible image-confirmation replies"
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
  /function resolveSelfieVisiblePayloadText\([\s\S]{0,900}const visibleText = cleanOutgoingTextSegment\(resolveVisiblePayloadText[\s\S]{0,900}const captionText = cleanOutgoingTextSegment\(caption \|\| ""\)[\s\S]{0,900}return "";/,
  "selfie payload handling should not fabricate a fixed visible reply when the model emits only a payload"
);
assert.match(
  source,
  /const selfieVisibleText = resolveSelfieVisiblePayloadText\([\s\S]{0,420}parsedPayload\.caption[\s\S]{0,520}const sentSelfieVisibleText = await sendVisibleReplyTextAndReturn[\s\S]{0,520}const selfieFlowText = resolveSelfieFlowContextText\([\s\S]{0,260}sentSelfieVisibleText \|\| selfieVisibleText[\s\S]{0,260}parsedPayload\.caption[\s\S]{0,900}buildDirectSelfiePromptFromContext\([\s\S]{0,180}selfieFlowText[\s\S]{0,420}runDirectSelfieFlow\(selfiePrompt,\s*\{\s*background:\s*true\s*\}\)/,
  "selfie payload should try visible text first, then continue image flow with fallback context when visible text is not sent"
);
const directSelfiePromptBuilderIndex = source.indexOf("function buildDirectSelfiePromptFromContext");
assert.ok(directSelfiePromptBuilderIndex >= 0, "gateway should define direct selfie prompt builder");
const directSelfiePromptBuilder = source.slice(directSelfiePromptBuilderIndex, directSelfiePromptBuilderIndex + 2600);
assert.match(
  directSelfiePromptBuilder,
  /formatSelfiePromptContextSection\("最近一周对话", context\.recentChatTranscript[\s\S]{0,520}formatSelfiePromptContextSection\("关系与场景状态", context\.asukaStatePrompt[\s\S]{0,520}formatSelfiePromptContextSection\("会话摘要", context\.asukaConversationDigestPrompt[\s\S]{0,760}formatSelfiePromptContextSection\("当前轮次", context\.currentTurnContext/,
  "direct selfie prompt should serialize conversation transcript, state, digest, and current turn sections"
);
assert.match(
  directSelfiePromptBuilder,
  /SELFIE_IDENTITY_LOCK_PROMPT[\s\S]{0,260}Asuka 主角图片[\s\S]{0,120}不要固定成手持自拍/,
  "direct image prompts should always retain Asuka identity while allowing non-selfie compositions"
);
assert.match(
  source,
  /SELFIE_SUMMER_WARDROBE_STRATEGY_PROMPT[\s\S]{0,1200}夏季日系校园极简风[\s\S]{0,1200}泳装、内衣感或过度暴露造型/,
  "gateway should define a summer wardrobe strategy for image generation"
);
for (const [label, text] of [["gateway", source], ["outbound", outboundSource]]) {
  assert.match(
    text,
    /小而紧致的鹅蛋脸[\s\S]{0,260}略圆的杏眼[\s\S]{0,260}轻薄空气刘海[\s\S]{0,260}不要中韩网红化/,
    `${label} identity lock should preserve the configured reference face traits instead of drifting into a generic influencer face`
  );
  assert.match(
    text,
    /不要在生图提示里命名、暗示或声称任何真实公众人物/,
    `${label} identity lock should avoid naming real public figures while using the reference image as the face anchor`
  );
}
assert.match(
  directSelfiePromptBuilder,
  /loadAsukaVisualIdentityAnchor\(\)[\s\S]{0,160}SELFIE_SUMMER_WARDROBE_STRATEGY_PROMPT/,
  "direct image prompts should include the summer wardrobe strategy after the visual identity anchor"
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
assert.match(
  visualAnchorSnippet,
  /Reference Face\|Face\|Facial Anchor[\s\S]{0,2400}collected\.slice\(0,\s*6\)/,
  "gateway visual identity loader should include the explicit reference-face bullet from IDENTITY.md"
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
  outboundVisualAnchorSnippet,
  /Reference Face\|Face\|Facial Anchor[\s\S]{0,2400}collected\.slice\(0,\s*6\)/,
  "cron selfie visual identity loader should include the explicit reference-face bullet from IDENTITY.md"
);
assert.match(
  source,
  /const responseTimeout = forceSelfieFromTrailingDash \? 20 \* 60 \* 1000 : 5 \* 60 \* 1000/,
  "trailing dash image requests should wait up to 20 minutes and normal replies should avoid premature fallback"
);
assert.match(
  source,
  /No response within timeout[\s\S]{0,900}forceSelfieFromTrailingDash[\s\S]{0,900}timed out before a natural visible reply; generating image from existing context[\s\S]{0,900}buildDirectSelfiePromptFromContext\([\s\S]{0,220}userContent,\s*""[\s\S]{0,900}runDirectSelfieFlow/,
  "trailing dash selfie requests should generate from existing context when the model turn times out"
);
const mediaTagGuardIndex = source.indexOf("Ignored model media tags in forced trailing-dash image turn");
const parsePromisesIndex = source.indexOf("deliver postprocess parse-promises start");
assert.ok(mediaTagGuardIndex >= 0, "forced trailing-dash image turns should ignore model-authored media tags");
assert.ok(parsePromisesIndex >= 0, "gateway should still parse assistant promises after normalizing send text");
assert.ok(
  mediaTagGuardIndex < parsePromisesIndex,
  "forced trailing-dash media tag guard should run before assistant reply postprocessing and send queue construction"
);
const mediaTagGuardSnippet = source.slice(mediaTagGuardIndex - 900, mediaTagGuardIndex + 500);
assert.match(
  mediaTagGuardSnippet,
  /hasQQBotMediaTag\(replyText\)[\s\S]{0,520}stripMediaTagsForVisibleText[\s\S]{0,520}resolveTimeSafeVisibleReplyText\(selfieVisibleText,\s*\{\s*forceImage:\s*true\s*\}\)[\s\S]{0,520}Ignored model media tags/,
  "forced trailing-dash media tag guard should strip fake paths without applying a second safe-natural-text gate"
);
assert.ok(
  !/resolveTimeSafeVisibleReplyText[\s\S]{0,800}isTimeContradictoryDeliveryText[\s\S]{0,800}buildTimeAwareDeliveryFallback/.test(source),
  "ordinary visible reply sends should not apply post-generation time-contradiction replacement after prompt-side constraints"
);
assert.match(
  source,
  /Forced trailing-dash image turn produced normal text[\s\S]{0,900}sendVisibleReplyText[\s\S]{0,900}Building post-reply image prompt[\s\S]{0,900}buildDirectSelfiePromptFromContext[\s\S]{0,900}runDirectSelfieFlow/,
  "forced trailing-dash image turns should generate the image prompt after the visible reply is sent"
);
assert.match(
  source,
  /Sending generated selfie image[\s\S]{0,420}sendC2CImageMessage\(token,\s*event\.senderId,\s*imageUrl,\s*event\.messageId,\s*undefined\)/,
  "generated selfie images should be sent without repeating the visible reply as image content"
);
assert.match(
  source,
  /const sentSelfieVisibleText = await sendVisibleReplyTextAndReturn\([\s\S]{0,180}selfieVisibleText[\s\S]{0,180}\{\s*forceImage:\s*true\s*\}[\s\S]{0,420}const selfieFlowText = resolveSelfieFlowContextText\([\s\S]{0,260}sentSelfieVisibleText \|\| selfieVisibleText[\s\S]{0,720}buildDirectSelfiePromptFromContext\([\s\S]{0,180}selfieFlowText/,
  "forced image prompt should prefer sent visible text and continue with fallback context if no visible text was sent"
);
const cronSelfiePromptSlice = requiredSlice(outboundSource, "outbound", "function buildCronSelfiePrompt", "async function runDirectSelfieFlowForCron");
assert.match(
  cronSelfiePromptSlice,
  /buildAsukaStatePrompt\(peerContext,\s*deliveryContext\.nowMs[\s\S]{0,120}deliveryContext\.sceneVerdict\)/,
  "cron selfie prompt should include proactive state with scene continuity verdict"
);
assert.match(
  cronSelfiePromptSlice,
  /buildConversationDigestPrompt\(peerContext\)/,
  "cron selfie prompt should include conversation digest context"
);
assert.match(
  cronSelfiePromptSlice,
  /resolveRecentTranscriptFromNormalSession\(peerId\)/,
  "cron selfie prompt should include normal-session transcript context"
);
assert.match(
  outboundSource,
  /SELFIE_SUMMER_WARDROBE_STRATEGY_PROMPT[\s\S]{0,1200}夏季日系校园极简风[\s\S]{0,1200}泳装、内衣感或过度暴露造型/,
  "cron image delivery should define the same summer wardrobe strategy"
);
assert.match(
  outboundSource,
  /function buildCronSelfiePrompt[\s\S]{0,1600}loadAsukaVisualIdentityAnchor\(\)[\s\S]{0,160}SELFIE_SUMMER_WARDROBE_STRATEGY_PROMPT/,
  "cron image prompts should include the summer wardrobe strategy after the visual identity anchor"
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
  /const pendingDispatchIds = \[\.\.\.new Set\(messages\.flatMap\(\(msg\) => msg\.pendingDispatchIds \?\? \[\]\)\)\]/,
  "buffered message merges should preserve pending dispatch ids"
);
assert.match(
  source,
  /recoverPendingDispatches\(account\.accountId, gatewayStartTimeMs, log\)[\s\S]{0,260}Re-enqueueing pending dispatch through normal queue[\s\S]{0,120}enqueueMessage\(recoveredMessage\)/,
  "gateway restart recovery should re-enter the normal message queue"
);
const handleMessageForPendingIndex = source.indexOf("const handleMessage = async (event: QueuedMessage)");
const pendingStartedIndex = source.indexOf("markPendingDispatchesStarted(account.accountId, pendingIdsForEvent, log)", handleMessageForPendingIndex);
const pendingClearedIndex = source.indexOf("clearPendingDispatches(account.accountId, pendingIdsForEvent, \"message processing completed\", log)", pendingStartedIndex);
assert.ok(handleMessageForPendingIndex >= 0, "gateway should define the normal handleMessage path");
assert.ok(pendingStartedIndex > handleMessageForPendingIndex, "pending dispatch records should be marked when normal handleMessage starts");
assert.ok(pendingClearedIndex > pendingStartedIndex, "pending dispatch records should clear after normal handleMessage completes");
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
assert.match(
  source,
  /pending-dispatches\.json/,
  "gateway should persist inbound messages until their reply path completes"
);
assert.match(
  source,
  /function recoverPendingDispatches[\s\S]{0,900}createdBeforeMs/,
  "pending dispatch recovery should only recover work from a previous gateway process"
);
assert.doesNotMatch(
  source,
  /PENDING_DISPATCH_MAX_ATTEMPTS|attempts\s*>=/,
  "pending dispatch recovery should not drop user messages just because repeated gateway restarts consumed retry attempts"
);
assert.match(
  source,
  /function findPendingDispatchIdsForMessage[\s\S]{0,500}messageId/,
  "QQ replayed messages should reuse existing pending dispatch ids instead of duplicating recovery work"
);
assert.match(
  source,
  /export function mergeBufferedQueuedMessages[\s\S]{0,1200}pendingDispatchIds/,
  "buffered message merging should preserve pending dispatch ids"
);
assert.match(
  source,
  /const ensurePendingDispatch[\s\S]{0,700}recordPendingDispatch/,
  "new inbound messages should be recorded as pending before buffering or dispatch"
);
assert.match(
  source,
  /schedulePendingDispatchRecovery\("READY"\)/,
  "gateway should schedule pending dispatch recovery after a ready QQ session"
);
assert.match(
  source,
  /schedulePendingDispatchRecovery\("RESUMED"\)/,
  "gateway should schedule pending dispatch recovery after a resumed QQ session"
);
assert.match(
  source,
  /const pendingIdsForEvent = event\.pendingDispatchIds[\s\S]{0,200}markPendingDispatchesStarted/,
  "message processing should mark pending dispatch ids as started"
);
assert.match(
  source,
  /finally \{[\s\S]{0,220}clearPendingDispatches\(account\.accountId, pendingIdsForEvent, "message processing completed", log\)/,
  "message processing should clear pending dispatch ids in its final cleanup"
);

console.log("[qqbot:test] gateway prompt order fixtures passed");
