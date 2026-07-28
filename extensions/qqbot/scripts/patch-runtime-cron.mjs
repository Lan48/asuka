import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const OPENCLAW_PACKAGE_RELATIVE_PATHS = [
  ["lib", "node_modules", "openclaw"],
  ["node_modules", "openclaw"],
];
const OPENCLAW_BUNDLE_NAME_RE = /^(?:gateway-cli|isolated-agent)-.*\.js$/;

const helperBlock = [
  "const EXACT_FORWARD_HEADER_LINES = [",
  "    \"这是一次纯转发任务。\",",
  "    \"你只能回复下面这段内容本身，从第一个字符到最后一个字符完全一致。\",",
  "    \"不要解释，不要总结，不要改写，不要加引号，不要加代码块，不要调用任何工具，不要再输出任何第二段内容。\",",
  "    \"输出完这段内容后立刻停止。\",",
  "];",
  "const CRON_PAYLOAD_PREFIX = \"QQBOT_CRON:\";",
  "const CRON_EXACT_FORWARD_PROMPT_PREFIX_RE = /^\\\\[cron:[^\\\\]]+\\\\]\\\\s*/;",
  "function stripCronPromptPrefix(message) {",
  "    return String(message ?? \"\").replace(CRON_EXACT_FORWARD_PROMPT_PREFIX_RE, \"\").trim();",
  "}",
  "function validateCronPayloadText(text) {",
  "    return String(text ?? \"\").startsWith(CRON_PAYLOAD_PREFIX) ? null : \"message does not contain a valid QQBOT_CRON payload\";",
  "}",
  "function extractExactForwardMessage(message) {",
  "    const stripped = stripCronPromptPrefix(message);",
  "    if (!stripped)",
  "        return { matched: false, text: \"\" };",
  "    if (stripped.startsWith(CRON_PAYLOAD_PREFIX))",
  "        return { matched: true, text: stripped };",
  "    const lines = stripped.split(/\\\\r?\\\\n/);",
  "    const matchesHeader = EXACT_FORWARD_HEADER_LINES.every((line, index) => lines[index]?.trim() === line);",
  "    if (!matchesHeader)",
  "        return { matched: false, text: \"\" };",
  "    return { matched: true, text: lines.slice(EXACT_FORWARD_HEADER_LINES.length).join(\"\\\\n\").trim() };",
  "}",
  "",
].join("\n");

const directForwardBranch = [
  "    const exactForward = extractExactForwardMessage(params.message);",
  "    if (exactForward.matched) {",
  "        const outputText = exactForward.text ?? \"\";",
  "        if (outputText.startsWith(CRON_PAYLOAD_PREFIX)) {",
  "            const validationError = validateCronPayloadText(outputText);",
  "            if (validationError) {",
  "                return { status: \"error\", outputText, error: validationError };",
  "            }",
  "        }",
  "        if (deliveryRequested) {",
  "            if (!resolvedDelivery.to) {",
  "                const reason = resolvedDelivery.error?.message ?? \"Cron delivery requires a recipient (--to).\";",
  "                if (!bestEffortDeliver) {",
  "                    return { status: \"error\", outputText, error: reason };",
  "                }",
  "                return { status: \"skipped\", summary: \"Delivery skipped (\" + reason + \").\", outputText };",
  "            }",
  "            try {",
  "                await deliverOutboundPayloads({",
  "                    cfg: cfgWithAgentDefaults,",
  "                    channel: resolvedDelivery.channel,",
  "                    to: resolvedDelivery.to,",
  "                    accountId: resolvedDelivery.accountId,",
  "                    payloads: [{ text: outputText }],",
  "                    bestEffort: bestEffortDeliver,",
  "                    deps: createOutboundSendDeps(params.deps),",
  "                });",
  "            }",
  "            catch (err) {",
  "                if (!bestEffortDeliver) {",
  "                    return { status: \"error\", outputText, error: String(err) };",
  "                }",
  "            }",
  "        }",
  "        return { status: \"ok\", summary: outputText, outputText };",
  "    }",
  "",
].join("\n");

const branchAnchor = [
  "    const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {",
  "        channel: agentPayload?.channel ?? \"last\",",
  "        to: agentPayload?.to,",
  "    });",
  "",
].join("\n");
const runFunctionAnchor = "export async function runCronIsolatedAgentTurn(params) {";
const bundledRunFunctionAnchor = "async function runCronIsolatedAgentTurn(params) {";
const modernPreparedAnchor = [
  "\tconst prepared = await prepareCronRunContext({",
  "\t\tinput: params,",
  "\t\tisFastTestEnv: process.env.OPENCLAW_TEST_FAST === \"1\"",
  "\t});",
  "\tif (!prepared.ok) return prepared.result;",
  "",
].join("\n");
const modernDirectForwardBranch = [
  "\tconst exactForward = extractExactForwardMessage(params.message);",
  "\tif (exactForward.matched) {",
  "\t\tconst outputText = exactForward.text ?? \"\";",
  "\t\tif (exactForward.error) return prepared.context.withRunSession({",
  "\t\t\tstatus: \"error\",",
  "\t\t\tsummary: exactForward.error,",
  "\t\t\toutputText,",
  "\t\t\terror: exactForward.error",
  "\t\t});",
  "\t\tif (!prepared.context.deliveryRequested) return prepared.context.withRunSession({",
  "\t\t\tstatus: \"ok\",",
  "\t\t\tsummary: outputText,",
  "\t\t\toutputText",
  "\t\t});",
  "\t\tconst { dispatchCronDelivery, resolveCronDeliveryBestEffort } = await loadCronDeliveryRuntime();",
  "\t\tconst directForwardAt = Date.now();",
  "\t\treturn await dispatchCronDelivery({",
  "\t\t\tcfg: prepared.context.input.cfg,",
  "\t\t\tcfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,",
  "\t\t\tdeps: prepared.context.input.deps,",
  "\t\t\tjob: prepared.context.input.job,",
  "\t\t\tagentId: prepared.context.agentId,",
  "\t\t\tagentSessionKey: prepared.context.agentSessionKey,",
  "\t\t\trunSessionKey: prepared.context.runSessionKey,",
  "\t\t\tsessionId: prepared.context.runSessionId,",
  "\t\t\trunStartedAt: directForwardAt,",
  "\t\t\trunEndedAt: directForwardAt,",
  "\t\t\ttimeoutMs: prepared.context.timeoutMs,",
  "\t\t\tresolvedDelivery: prepared.context.resolvedDelivery,",
  "\t\t\tdeliveryRequested: prepared.context.deliveryRequested,",
  "\t\t\tskipHeartbeatDelivery: false,",
  "\t\t\tskipMessagingToolDelivery: false,",
  "\t\t\tunverifiedMessagingToolDelivery: false,",
  "\t\t\tdeliveryBestEffort: resolveCronDeliveryBestEffort(prepared.context.input.job),",
  "\t\t\tdeliveryPayloadHasStructuredContent: false,",
  "\t\t\tdeliveryPayloads: [{ text: outputText }],",
  "\t\t\tsynthesizedText: outputText,",
  "\t\t\tttsAuto: prepared.context.cronSession.sessionEntry.ttsAuto,",
  "\t\t\tsummary: outputText,",
  "\t\t\toutputText,",
  "\t\t\ttelemetry: {},",
  "\t\t\tabortSignal,",
  "\t\t\tisAborted,",
  "\t\t\tabortReason,",
  "\t\t\twithRunSession: prepared.context.withRunSession",
  "\t\t});",
  "\t}",
  "",
].join("\n");
const modernLifecycleExecuteAnchor = "\t\tconst { executeCronRun } = await loadCronExecutorRuntime();";
const modernLifecycleDirectForwardBranch = [
  "\t\tconst exactForward = extractExactForwardMessage(resolveCronAgentTurnMessage(params));",
  "\t\tif (exactForward.matched) {",
  "\t\t\tconst outputText = exactForward.text ?? \"\";",
  "\t\t\tif (exactForward.error) return prepared.context.withRunSession({",
  "\t\t\t\tstatus: \"error\",",
  "\t\t\t\tsummary: exactForward.error,",
  "\t\t\t\toutputText,",
  "\t\t\t\terror: exactForward.error",
  "\t\t\t});",
  "\t\t\tif (!prepared.context.deliveryRequested) return prepared.context.withRunSession({",
  "\t\t\t\tstatus: \"ok\",",
  "\t\t\t\tsummary: outputText,",
  "\t\t\t\toutputText",
  "\t\t\t});",
  "\t\t\tconst { dispatchCronDelivery, resolveCronDeliveryBestEffort } = await loadCronDeliveryRuntime();",
  "\t\t\tconst directForwardAt = Date.now();",
  "\t\t\tconst sourceDeliveryOutcome = resolveSourceDeliveryOutcome(prepared.context.sourceDelivery, {",
  "\t\t\t\tdidSendViaMessageTool: false,",
  "\t\t\t\tmessageToolSentTargets: []",
  "\t\t\t});",
  "\t\t\tconst directForwardResult = await dispatchCronDelivery({",
  "\t\t\t\tcfg: prepared.context.input.cfg,",
  "\t\t\t\tcfgWithAgentDefaults: prepared.context.cfgWithAgentDefaults,",
  "\t\t\t\tdeps: prepared.context.input.deps,",
  "\t\t\t\tjob: prepared.context.input.job,",
  "\t\t\t\tagentId: prepared.context.agentId,",
  "\t\t\t\tagentSessionKey: prepared.context.agentSessionKey,",
  "\t\t\t\trunSessionKey: prepared.context.runSessionKey,",
  "\t\t\t\tsessionId: prepared.context.currentRunSessionId(),",
  "\t\t\t\tlifecycleRevision: prepared.context.cronSession.lifecycleRevision,",
  "\t\t\t\tsessionUpdatedAt: prepared.context.cronSession.sessionEntry.updatedAt,",
  "\t\t\t\tbeforeSessionDelete: prepared.context.sessionWorkAdmission.release,",
  "\t\t\t\trunStartedAt: directForwardAt,",
  "\t\t\t\trunEndedAt: directForwardAt,",
  "\t\t\t\ttimeoutMs: prepared.context.timeoutMs,",
  "\t\t\t\tresolvedDelivery: prepared.context.resolvedDelivery,",
  "\t\t\t\tdeliveryRequested: prepared.context.deliveryRequested,",
  "\t\t\t\tskipHeartbeatDelivery: false,",
  "\t\t\t\tsourceDeliveryOutcome,",
  "\t\t\t\tdeliveryBestEffort: resolveCronDeliveryBestEffort(prepared.context.input.job),",
  "\t\t\t\tdeliveryPayloadHasStructuredContent: false,",
  "\t\t\t\tdeliveryPayloads: [{ text: outputText }],",
  "\t\t\t\tsynthesizedText: outputText,",
  "\t\t\t\tttsAuto: prepared.context.cronSession.sessionEntry.ttsAuto,",
  "\t\t\t\tsummary: outputText,",
  "\t\t\t\toutputText,",
  "\t\t\t\ttelemetry: {},",
  "\t\t\t\tabortSignal,",
  "\t\t\t\tisAborted,",
  "\t\t\t\tabortReason,",
  "\t\t\t\twithRunSession: prepared.context.withRunSession",
  "\t\t\t});",
  "\t\t\tif (directForwardResult.cronRunSessionCleanupAttempted) cronRunSessionCleanupAttempted = true;",
  "\t\t\treturn directForwardResult;",
  "\t\t}",
  "",
].join("\n");

export function patchRuntimeFile(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, required, status: "missing" };
  }
  let source = fs.readFileSync(filePath, "utf8");
  if (
    source.includes("extractExactForwardMessage")
    && (
      source.includes("payloads: [{ text: outputText }]")
      || source.includes("deliveryPayloads: [{ text: outputText }]")
    )
  ) {
    return { path: filePath, required, status: "already-patched" };
  }
  if (source.includes(runFunctionAnchor) && source.includes(branchAnchor)) {
    source = source.replace(runFunctionAnchor, helperBlock + runFunctionAnchor);
    source = source.replace(branchAnchor, branchAnchor + directForwardBranch);
  } else if (
    source.includes(bundledRunFunctionAnchor)
    && source.includes(modernLifecycleExecuteAnchor)
    && source.includes("resolveCronAgentTurnMessage")
    && source.includes("resolveSourceDeliveryOutcome")
  ) {
    source = source.replace(bundledRunFunctionAnchor, helperBlock + bundledRunFunctionAnchor);
    source = source.replace(
      modernLifecycleExecuteAnchor,
      modernLifecycleDirectForwardBranch + modernLifecycleExecuteAnchor
    );
  } else if (source.includes(bundledRunFunctionAnchor) && source.includes(modernPreparedAnchor)) {
    source = source.replace(bundledRunFunctionAnchor, helperBlock + bundledRunFunctionAnchor);
    source = source.replace(modernPreparedAnchor, modernPreparedAnchor + modernDirectForwardBranch);
  } else {
    const missingAnchors = [
      !source.includes(runFunctionAnchor) && !source.includes(bundledRunFunctionAnchor) ? "run-function" : null,
      !source.includes(branchAnchor)
        && !source.includes(modernPreparedAnchor)
        && !source.includes(modernLifecycleExecuteAnchor)
        ? "delivery-or-prepared-context"
        : null,
    ].filter(Boolean);
    return {
      path: filePath,
      required,
      status: "unsupported",
      reason: `unsupported OpenClaw cron bundle; missing anchor(s): ${missingAnchors.join(", ") || "compatible anchor pair"}`,
    };
  }
  fs.writeFileSync(filePath, source);
  return { path: filePath, required, status: "patched" };
}

function addOpenClawRootsUnderTools(roots, toolsDir) {
  if (!toolsDir || !fs.existsSync(toolsDir)) return;
  for (const relativeParts of OPENCLAW_PACKAGE_RELATIVE_PATHS) {
    roots.add(path.join(toolsDir, ...relativeParts));
  }
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const relativeParts of OPENCLAW_PACKAGE_RELATIVE_PATHS) {
      roots.add(path.join(toolsDir, entry.name, ...relativeParts));
    }
  }
}

export function getInstalledOpenClawPackageRoots({
  homeDir = os.homedir(),
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const roots = new Set();
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(homeDir, ".openclaw");
  roots.add(path.join(stateDir, "lib", "node_modules", "openclaw"));
  roots.add(path.join(stateDir, "tools", "node_modules", "openclaw"));
  addOpenClawRootsUnderTools(roots, env.OPENCLAW_TOOLS_DIR?.trim() || path.join(stateDir, "tools"));

  const executableDir = path.dirname(execPath);
  for (const relativeParts of OPENCLAW_PACKAGE_RELATIVE_PATHS) {
    roots.add(path.join(executableDir, ...relativeParts));
  }
  roots.add(path.resolve(executableDir, "..", "lib", "node_modules", "openclaw"));

  for (const explicitRoot of String(env.OPENCLAW_RUNTIME_ROOTS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)) {
    roots.add(explicitRoot);
  }

  return [...roots].filter((root) => fs.existsSync(path.join(root, "package.json"))).sort();
}

export function getInstalledOpenClawBundlePaths(options = {}) {
  const bundlePaths = [];
  for (const packageRootPath of getInstalledOpenClawPackageRoots(options)) {
    const distDir = path.join(packageRootPath, "dist");
    if (!fs.existsSync(distDir)) continue;
    for (const entry of fs.readdirSync(distDir).filter((name) => OPENCLAW_BUNDLE_NAME_RE.test(name)).sort()) {
      const bundlePath = path.join(distDir, entry);
      const source = fs.readFileSync(bundlePath, "utf8");
      if (source.includes(runFunctionAnchor) || source.includes(bundledRunFunctionAnchor)) {
        bundlePaths.push(bundlePath);
      }
    }
  }
  return [...new Set(bundlePaths)].sort();
}

export function runRuntimeCronPatch(options = {}) {
  const includeInstalled = options.includeInstalled ?? true;
  const installedRoots = includeInstalled ? getInstalledOpenClawPackageRoots(options) : [];
  const installedBundlePaths = includeInstalled ? getInstalledOpenClawBundlePaths(options) : [];
  const targets = [
    {
      path: path.join(packageRoot, "node_modules", "clawdbot", "dist", "cron", "isolated-agent", "run.js"),
      required: true,
    },
    ...installedBundlePaths.map((targetPath) => ({ path: targetPath, required: true })),
  ];

  const results = targets.map((target) => patchRuntimeFile(target.path, target.required));
  for (const installedRoot of installedRoots) {
    if (!installedBundlePaths.some((bundlePath) => bundlePath.startsWith(path.join(installedRoot, "dist") + path.sep))) {
      results.push({
        path: path.join(installedRoot, "dist", "{gateway-cli,isolated-agent}-*.js"),
        required: true,
        status: "unsupported",
        reason: "OpenClaw package found but no cron implementation bundle was discovered",
      });
    }
  }

  const blocking = results.find((result) =>
    result.required && (result.status === "unsupported" || result.status === "missing")
  );
  for (const result of results) {
    if (result.status === "patched" || result.status === "unsupported") {
      const suffix = result.reason ? ": " + result.reason : "";
      console.log("[qqbot] runtime cron patch " + result.status + ": " + result.path + suffix);
    }
  }
  if (blocking) process.exitCode = 1;
  return results;
}

if (
  process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--vendored-only") || args.length > 1) {
    throw new Error("usage: patch-runtime-cron.mjs [--vendored-only]");
  }
  runRuntimeCronPatch({ includeInstalled: !args.includes("--vendored-only") });
}
