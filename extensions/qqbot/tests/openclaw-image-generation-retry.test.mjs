import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "openclaw-image-generation.ts"), "utf-8");

assert.match(
  source,
  /function isTransientOpenClawImageDisconnect\([\s\S]*other side closed[\s\S]*und_err_socket[\s\S]*fetch failed/,
  "OpenClaw image generation should recognize proxy/SSE disconnects as transient",
);
assert.match(
  source,
  /fetch timeout after\|request timed out\|timed out after 240000ms/,
  "OpenClaw image generation should not retry full 240s timeouts by default",
);
assert.match(
  source,
  /runWithTransientOpenClawImageRetry\("cli"[\s\S]{0,260}execOpenClaw/,
  "OpenClaw CLI image fallback should retry transient disconnects before external fallbacks",
);
assert.match(
  source,
  /QQBOT_OPENCLAW_IMAGE_TRANSIENT_RETRIES/,
  "OpenClaw image retry count should be configurable for remote tuning",
);
