import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");

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

function patchRuntimeFile(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, required, status: "missing" };
  }
  let source = fs.readFileSync(filePath, "utf8");
  if (source.includes("extractExactForwardMessage") && source.includes("payloads: [{ text: outputText }]")) {
    return { path: filePath, required, status: "already-patched" };
  }
  if (!source.includes(runFunctionAnchor)) {
    return { path: filePath, required, status: "unsupported", reason: "run function anchor not found" };
  }
  if (!source.includes(branchAnchor)) {
    return { path: filePath, required, status: "unsupported", reason: "delivery anchor not found" };
  }
  source = source.replace(runFunctionAnchor, helperBlock + runFunctionAnchor);
  source = source.replace(branchAnchor, branchAnchor + directForwardBranch);
  fs.writeFileSync(filePath, source);
  return { path: filePath, required, status: "patched" };
}

function getInstalledGatewayBundlePaths(homeDir = os.homedir()) {
  const distDir = path.join(homeDir, ".openclaw", "lib", "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return [];
  return fs.readdirSync(distDir)
    .filter((entry) => /^gateway-cli-.*\\.js$/.test(entry))
    .sort()
    .map((entry) => path.join(distDir, entry));
}

const targets = [
  { path: path.join(packageRoot, "node_modules", "clawdbot", "dist", "cron", "isolated-agent", "run.js"), required: true },
  ...getInstalledGatewayBundlePaths().map((targetPath) => ({ path: targetPath, required: false })),
];

const results = targets.map((target) => patchRuntimeFile(target.path, target.required));
const blocking = results.find((result) => result.required && (result.status === "unsupported" || result.status === "missing"));
for (const result of results) {
  if (result.status === "patched" || result.status === "unsupported") {
    const suffix = result.reason ? ": " + result.reason : "";
    console.log("[qqbot] runtime cron patch " + result.status + ": " + result.path + suffix);
  }
}
if (blocking) {
  process.exitCode = 1;
}
