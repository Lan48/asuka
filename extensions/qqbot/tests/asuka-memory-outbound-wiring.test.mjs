import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src", "outbound.ts"), "utf8");

function requiredSlice(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const recorder = requiredSlice(
  "function recordDeliveredProactiveMemory",
  "function buildOutboundMemoryPeerContext",
);
assert.match(
  recorder,
  /!result\.messageId\s*\|\|\s*result\.error\s*\|\|\s*result\.skipped/,
  "proactive memory must require a delivered QQ message id",
);

const captionSender = requiredSlice(
  "async function sendMediaCaption",
  "function normalizeQuietHour",
);
assert.match(
  captionSender,
  /await sendC2CMessage[\s\S]*await sendGroupMessage[\s\S]*recordDeliveredProactiveMemory/,
  "media captions must be recorded only after their own text send succeeds",
);
assert.match(
  captionSender,
  /if \(!ctx\.replyToId\)/,
  "passive media replies must not be captured as proactive events",
);

for (const deliveryPath of [
  "send_media_image_caption",
  "send_media_voice_caption",
  "send_media_video_url_caption",
  "send_media_video_file_caption",
  "send_media_file_caption",
]) {
  assert.ok(source.includes(`sendMediaCaption(accessToken, target, ctx, "${deliveryPath}")`));
}

const structured = requiredSlice(
  "async function sendStructuredPayloadFromOutbound",
  "function looksLikeDebugProbeText",
);
assert.match(
  structured,
  /runProactiveGuardedSend\([\s\S]*"sendStructuredTts"/,
  "structured proactive TTS must use the proactive dedup guard",
);
assert.match(
  structured,
  /structured_tts_narration[\s\S]*structured_tts_voice/,
  "each actually delivered TTS text or voice segment must be captured",
);
assert.match(
  structured,
  /structured_audio_no_safe_fallback/,
  "an undeliverable structured audio payload must return an explicit skipped result",
);

const cronSender = source.slice(source.indexOf("export async function sendCronMessage"));
assert.doesNotMatch(
  cronSender,
  /recordDeliveredProactiveMemory\(/,
  "cron must not infer caption delivery from an image result at a higher layer",
);
assert.match(
  source,
  /runDirectSelfieFlowForCron[\s\S]*memoryClaimIds:\s*renderContext\.memoryClaimIds/,
  "selfie caption events must retain the claims used to generate them",
);

console.log("asuka memory outbound wiring tests passed");
