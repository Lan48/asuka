import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-oauth-profile-"));
const authProfilesPath = path.join(fixtureDir, "auth-profiles.json");
const originalAuthProfilesPath = process.env.OPENCLAW_AUTH_PROFILES_PATH;

process.env.OPENCLAW_AUTH_PROFILES_PATH = authProfilesPath;

try {
  fs.writeFileSync(
    authProfilesPath,
    `\uFEFF${JSON.stringify({
      version: 1,
      profiles: {
        "openai-codex:test@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 3_600_000,
        },
      },
    })}\n`,
    "utf8",
  );

  const { resolveOAuthProfileToken } = await import("../dist/src/utils/oauth-profile.js");
  const resolved = await resolveOAuthProfileToken("openai-codex:test@example.com");
  assert.equal(resolved.token, "test-access-token");
  assert.equal(resolved.provider, "openai-codex");
  assert.equal(resolved.refreshed, false);
} finally {
  if (originalAuthProfilesPath === undefined) {
    delete process.env.OPENCLAW_AUTH_PROFILES_PATH;
  } else {
    process.env.OPENCLAW_AUTH_PROFILES_PATH = originalAuthProfilesPath;
  }
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
