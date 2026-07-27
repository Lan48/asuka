#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [pluginRootArgument, configPathArgument, accountId] = process.argv.slice(2);
if (!pluginRootArgument || !configPathArgument || !accountId) {
  throw new Error(
    "usage: node verify-model-config.mjs <packaged-qqbot-root> <openclaw-config> [account]",
  );
}

const pluginRoot = path.resolve(pluginRootArgument);
const configPath = path.resolve(configPathArgument);
const configModulePath = path.join(pluginRoot, "dist", "src", "config.js");
const modelClientModulePath = path.join(
  pluginRoot,
  "dist",
  "src",
  "asuka-memory-kernel",
  "model-client.js",
);
for (const requiredPath of [configPath, configModulePath, modelClientModulePath]) {
  if (!fs.existsSync(requiredPath) || !fs.statSync(requiredPath).isFile()) {
    throw new Error(`model configuration probe dependency is missing: ${requiredPath}`);
  }
}

const rootConfig = JSON.parse(
  fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
);
process.env.OPENCLAW_CONFIG_PATH = configPath;

const { resolveQQBotSceneInferenceConfig } = await import(
  pathToFileURL(configModulePath).href
);
const { createOpenAICompatibleMemoryModelClient } = await import(
  pathToFileURL(modelClientModulePath).href
);

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isCompletionReady(value) {
  return createOpenAICompatibleMemoryModelClient({ primary: value })
    .status.completion === "ready";
}

const qqbot = asRecord(asRecord(asRecord(rootConfig).channels).qqbot);
const kernel = asRecord(qqbot.memoryKernel);
const model = asRecord(kernel.model);
const scene = resolveQQBotSceneInferenceConfig(accountId);
const primaryFromKernel = isCompletionReady(model.primary);
const fallbackFromKernel = isCompletionReady(model.fallback);
const primary = primaryFromKernel ? model.primary : scene.primary;
const fallback = fallbackFromKernel ? model.fallback : scene.fallback;
let networkCalls = 0;
const client = createOpenAICompatibleMemoryModelClient({
  primary,
  fallback,
  fetchImpl: async () => {
    networkCalls += 1;
    throw new Error("model configuration probe must not perform network requests");
  },
});

if (client.status.completion !== "ready") {
  throw new Error(
    "legacy rejudgement requires a completion model in memoryKernel.model or sceneInference",
  );
}
if (networkCalls !== 0) {
  throw new Error("model configuration probe unexpectedly performed a network request");
}

const describe = (value, source) => ({
  source,
  model: typeof value?.model === "string" ? value.model : null,
});
process.stdout.write(`${JSON.stringify({
  ok: true,
  operation: "verify-model-config",
  accountId,
  completion: client.status.completion,
  completionModels: client.status.completionModels,
  primary: describe(primary, primaryFromKernel ? "memoryKernel.model.primary" : "sceneInference"),
  fallback: describe(
    fallback,
    fallbackFromKernel ? "memoryKernel.model.fallback" : "sceneInference",
  ),
  networkCalls,
})}\n`);
