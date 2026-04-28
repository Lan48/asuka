import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-runtime-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  buildLocalRuntimeHealthReport,
  formatLocalRuntimeHealthReport,
  validateCronPatchText,
  validateRuntimeCronPatch,
} = await import("../dist/src/runtime-diagnostics.js");

const goodPatch = `
const EXACT_FORWARD_HEADER_LINES = ["这是一次纯转发任务。"];
const CRON_PAYLOAD_PREFIX = "QQBOT_CRON:";
function validateCronPayloadText(text) { return text.includes(CRON_PAYLOAD_PREFIX) ? null : "bad"; }
function extractExactForwardMessage(message) { return { matched: true, text: message }; }
async function runCronIsolatedAgentTurn(params) {
  const exactForward = extractExactForwardMessage(params.message);
  if (exactForward.matched) {
    const outputText = exactForward.text ?? "";
    await deliverOutboundPayloads({ payloads: [{ text: outputText }] });
    return { status: "ok", outputText };
  }
}
`;

const badPatch = `
const CRON_PAYLOAD_PREFIX = "QQBOT_CRON:";
async function runCronIsolatedAgentTurn() {
  return { status: "ok" };
}
`;

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-runtime-patch-"));
const vendoredGood = path.join(fixtureDir, "vendored-good.js");
const vendoredBad = path.join(fixtureDir, "vendored-bad.js");
const installedGood = path.join(fixtureDir, "gateway-cli-good.js");
const installedBad = path.join(fixtureDir, "gateway-cli-bad.js");
fs.writeFileSync(vendoredGood, goodPatch);
fs.writeFileSync(vendoredBad, badPatch);
fs.writeFileSync(installedGood, goodPatch);
fs.writeFileSync(installedBad, badPatch);

assert.deepEqual(validateCronPatchText(goodPatch), [], "good patch text should pass snippet validation");
assert.ok(
  validateCronPatchText(badPatch).includes("exact-forward-header"),
  "bad patch text should identify missing exact-forward header"
);

const allGood = validateRuntimeCronPatch({
  vendoredRunnerPath: vendoredGood,
  installedGatewayPaths: [installedGood],
  includeInstalled: true,
  now: new Date("2026-04-26T00:00:00Z"),
});
assert.equal(allGood.status, "pass", "good vendored and installed patch files should pass");
assert.equal(allGood.targets.length, 2, "report should include vendored and installed targets");
assert.equal(allGood.targets[0].status, "pass", "vendored fixture should pass");
assert.equal(allGood.targets[1].status, "pass", "installed fixture should pass");

const requiredMissing = validateRuntimeCronPatch({
  vendoredRunnerPath: path.join(fixtureDir, "missing-runner.js"),
  includeInstalled: false,
});
assert.equal(requiredMissing.status, "fail", "missing required vendored runner should fail");
assert.equal(requiredMissing.targets[0].status, "missing", "missing vendored runner should be reported");

const optionalInstalledMissing = validateRuntimeCronPatch({
  vendoredRunnerPath: vendoredGood,
  installedGatewayPaths: [],
  includeInstalled: true,
  homeDir: tmpHome,
});
assert.equal(optionalInstalledMissing.status, "pass", "missing optional installed bundle should not fail");
assert.equal(optionalInstalledMissing.targets[1].status, "missing", "optional installed bundle should be reported missing");

const installedBadReport = validateRuntimeCronPatch({
  vendoredRunnerPath: vendoredGood,
  installedGatewayPaths: [installedBad],
  includeInstalled: true,
});
assert.equal(installedBadReport.status, "fail", "present installed bundle missing patch should fail");
assert.equal(installedBadReport.targets[1].status, "fail", "bad installed bundle should be reported as failed");
assert.ok(
  installedBadReport.targets[1].reasons.some((reason) => reason.startsWith("missing-snippet:")),
  "bad installed bundle should include missing snippet reasons"
);

const realVendored = validateRuntimeCronPatch({ includeInstalled: false });
assert.equal(realVendored.status, "pass", "current vendored clawdbot cron runner should preserve QQBOT_CRON patch");

const configPath = path.join(fixtureDir, "openclaw.json");
const qqbotDataDir = path.join(fixtureDir, "qqbot");
const promiseStateDir = path.join(qqbotDataDir, "data", "asuka-state");
const selfieScriptPath = path.join(fixtureDir, "asuka-selfie.sh");
fs.mkdirSync(promiseStateDir, { recursive: true });
fs.writeFileSync(selfieScriptPath, "#!/usr/bin/env bash\n");
fs.writeFileSync(configPath, JSON.stringify({
  channels: {
    qqbot: {
      appId: "app-id",
      clientSecret: "super-secret-client-secret",
      imageServerBaseUrl: "https://images.example.test",
    },
  },
  skills: {
    entries: {
      "asuka-selfie": {
        env: {
          DASHSCOPE_API_KEY: "super-secret-dashscope-key",
          DASHSCOPE_MODEL: "wan2.6-image",
        },
      },
    },
  },
}, null, 2));
fs.writeFileSync(path.join(promiseStateDir, "state.json"), JSON.stringify({
  promises: {
    scheduled: { state: "scheduled", cronJobId: "job-1", followUpJobIds: ["job-2"], lastFallbackState: "sent" },
    scheduleFailed: { state: "schedule_failed" },
    deliveryFailed: { state: "delivery_failed" },
  },
}, null, 2));

const health = buildLocalRuntimeHealthReport({
  vendoredRunnerPath: vendoredGood,
  includeInstalled: false,
  openClawConfigPath: configPath,
  qqbotDataDir,
  selfieScriptPath,
  env: {},
  now: new Date("2026-04-26T00:00:00Z"),
});
assert.equal(health.status, "pass", "configured local runtime health should pass");
assert.equal(health.qqDelivery.configExists, true, "runtime health should report config presence");
assert.equal(health.qqDelivery.configuredAccountCount, 1, "runtime health should count configured QQ account without exposing secrets");
assert.equal(health.promiseState.total, 3, "runtime health should count promises");
assert.equal(health.promiseState.cronJobIds, 2, "runtime health should count primary and follow-up cron job ids");
assert.equal(health.promiseState.fallbackTracked, 1, "runtime health should count fallback metadata");
assert.equal(health.media.selfieScript.exists, true, "runtime health should report selfie script presence");
assert.equal(health.media.dashscopeApiKeyConfigured, true, "runtime health should report DashScope key presence as a boolean");
const healthText = formatLocalRuntimeHealthReport(health);
assert.ok(healthText.includes("QQBot runtime health: pass"), "formatted health should include overall status");
assert.equal(healthText.includes("super-secret"), false, "formatted health should not leak secret values");
assert.equal(JSON.stringify(health).includes("super-secret"), false, "structured health should not leak secret values");

const missingHealth = buildLocalRuntimeHealthReport({
  vendoredRunnerPath: path.join(fixtureDir, "missing-vendored.js"),
  includeInstalled: false,
  openClawConfigPath: path.join(fixtureDir, "missing-openclaw.json"),
  qqbotDataDir: path.join(fixtureDir, "missing-qqbot"),
  selfieScriptPath: path.join(fixtureDir, "missing-selfie.sh"),
  env: {},
});
assert.equal(missingHealth.status, "fail", "missing required cron patch should fail runtime health");
assert.equal(missingHealth.qqDelivery.configExists, false, "missing config should be reported clearly");
assert.equal(missingHealth.cronPatch.targets[0].status, "missing", "missing vendored runner should be reported clearly");
assert.equal(missingHealth.media.selfieScript.exists, false, "missing selfie script should be reported clearly");

console.log("asuka-runtime tests passed");
