import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  getInstalledOpenClawBundlePaths,
  getInstalledOpenClawPackageRoots,
  patchRuntimeFile,
} = await import("../scripts/patch-runtime-cron.mjs");

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-runtime-cron-patch-"));
const stateDir = path.join(fixtureDir, ".openclaw");
const homePackageRoot = path.join(stateDir, "lib", "node_modules", "openclaw");
const toolsPackageRoot = path.join(stateDir, "tools", "node-v22.22.0", "lib", "node_modules", "openclaw");

for (const packageRoot of [homePackageRoot, toolsPackageRoot]) {
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "openclaw",
    version: "2026.7.1-2",
  }));
}

const modernBundle = `
async function loadCronDeliveryRuntime() {}
async function prepareCronRunContext() {}
async function runCronIsolatedAgentTurn(params) {
\tconst abortSignal = params.abortSignal ?? params.signal;
\tconst isAborted = () => abortSignal?.aborted === true;
\tconst abortReason = () => "aborted";
\tconst prepared = await prepareCronRunContext({
\t\tinput: params,
\t\tisFastTestEnv: process.env.OPENCLAW_TEST_FAST === "1"
\t});
\tif (!prepared.ok) return prepared.result;
\treturn prepared.context;
}
`;
const modernBundlePath = path.join(toolsPackageRoot, "dist", "isolated-agent-modern.js");
fs.writeFileSync(modernBundlePath, modernBundle);
fs.writeFileSync(
  path.join(toolsPackageRoot, "dist", "isolated-agent-wrapper.js"),
  'export { runCronIsolatedAgentTurn } from "./isolated-agent-modern.js";\n'
);

const legacyBundle = `
async function resolveDeliveryTarget() {}
export async function runCronIsolatedAgentTurn(params) {
    const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
        channel: agentPayload?.channel ?? "last",
        to: agentPayload?.to,
    });
    return params;
}
`;
const legacyBundlePath = path.join(homePackageRoot, "dist", "gateway-cli-legacy.js");
fs.writeFileSync(legacyBundlePath, legacyBundle);

const discoveryOptions = {
  homeDir: fixtureDir,
  env: { OPENCLAW_STATE_DIR: stateDir },
  execPath: path.join(fixtureDir, "unrelated-bin", "node"),
};
assert.deepEqual(
  getInstalledOpenClawPackageRoots(discoveryOptions),
  [homePackageRoot, toolsPackageRoot].sort(),
  "patch discovery should include both home/lib and versioned tools runtimes"
);
assert.deepEqual(
  getInstalledOpenClawBundlePaths(discoveryOptions),
  [legacyBundlePath, modernBundlePath].sort(),
  "patch discovery should select implementation bundles and ignore re-export wrappers"
);

const legacyResult = patchRuntimeFile(legacyBundlePath, true);
assert.equal(legacyResult.status, "patched", "legacy gateway bundle should be patched");
assert.match(fs.readFileSync(legacyBundlePath, "utf8"), /extractExactForwardMessage/);
assert.equal(
  patchRuntimeFile(legacyBundlePath, true).status,
  "already-patched",
  "legacy patching should be idempotent"
);

const modernResult = patchRuntimeFile(modernBundlePath, true);
assert.equal(modernResult.status, "patched", "modern isolated-agent bundle should be patched");
const patchedModern = fs.readFileSync(modernBundlePath, "utf8");
assert.match(patchedModern, /dispatchCronDelivery/);
assert.match(patchedModern, /deliveryPayloads: \[\{ text: outputText \}\]/);
assert.equal(
  patchRuntimeFile(modernBundlePath, true).status,
  "already-patched",
  "modern patching should be idempotent"
);

const lifecycleBundlePath = path.join(fixtureDir, "isolated-agent-2026.7.1.js");
const lifecycleBundle = `
function resolveCronAgentTurnMessage(input) { return input.message; }
function resolveSourceDeliveryOutcome() { return {}; }
async function loadCronDeliveryRuntime() {}
async function prepareCronRunContext() {}
async function runCronIsolatedAgentTurn(params) {
\tconst abortSignal = params.abortSignal ?? params.signal;
\tconst isAborted = () => abortSignal?.aborted ?? false;
\tconst abortReason = () => "aborted";
\tconst prepared = await prepareCronRunContext({ input: params });
\tif (!prepared.ok) return prepared.result;
\tlet cronRunSessionCleanupAttempted = false;
\ttry {
\t\tconst { executeCronRun } = await loadCronExecutorRuntime();
\t\treturn executeCronRun();
\t} finally {
\t\tcronRunSessionCleanupAttempted = true;
\t}
}
`;
fs.writeFileSync(lifecycleBundlePath, lifecycleBundle);
const lifecycleResult = patchRuntimeFile(lifecycleBundlePath, true);
assert.equal(lifecycleResult.status, "patched", "OpenClaw 2026.7 lifecycle bundle should be patched");
const patchedLifecycle = fs.readFileSync(lifecycleBundlePath, "utf8");
assert.match(patchedLifecycle, /sourceDeliveryOutcome/);
assert.match(patchedLifecycle, /cronRunSessionCleanupAttempted/);
assert.match(patchedLifecycle, /deliveryPayloads: \[\{ text: outputText \}\]/);
assert.equal(
  patchRuntimeFile(lifecycleBundlePath, true).status,
  "already-patched",
  "OpenClaw 2026.7 lifecycle patching should be idempotent"
);

const unsupportedBundlePath = path.join(fixtureDir, "isolated-agent-future.js");
const unsupportedBundle = "async function runCronIsolatedAgentTurn(params) { return params; }\n";
fs.writeFileSync(unsupportedBundlePath, unsupportedBundle);
const unsupportedResult = patchRuntimeFile(unsupportedBundlePath, true);
assert.equal(unsupportedResult.status, "unsupported", "unknown bundle anchors should fail closed");
assert.match(unsupportedResult.reason, /missing anchor/);
assert.equal(
  fs.readFileSync(unsupportedBundlePath, "utf8"),
  unsupportedBundle,
  "unsupported bundles must remain unchanged"
);

console.log("runtime cron patch tests passed");
