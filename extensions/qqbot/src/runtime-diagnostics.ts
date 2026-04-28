import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeCronPatchTargetKind = "vendored_clawdbot" | "installed_openclaw";
export type RuntimeCronPatchStatus = "pass" | "fail" | "missing";
export type RuntimeCronPatchOverallStatus = "pass" | "fail";

export interface RuntimeCronPatchTargetResult {
  kind: RuntimeCronPatchTargetKind;
  label: string;
  path: string;
  required: boolean;
  status: RuntimeCronPatchStatus;
  reasons: string[];
}

export interface RuntimeCronPatchReport {
  status: RuntimeCronPatchOverallStatus;
  checkedAt: string;
  targets: RuntimeCronPatchTargetResult[];
}

export interface RuntimeCronPatchOptions {
  vendoredRunnerPath?: string;
  installedGatewayPaths?: string[];
  includeInstalled?: boolean;
  installedRequired?: boolean;
  homeDir?: string;
  now?: Date;
}

export type LocalRuntimeHealthStatus = "pass" | "warn" | "fail";

export interface LocalRuntimeHealthFileSummary {
  path: string;
  exists: boolean;
  sizeBytes?: number;
}

export interface LocalRuntimePromiseStateSummary {
  path: string;
  exists: boolean;
  total: number;
  scheduled: number;
  scheduleFailed: number;
  deliveryFailed: number;
  cronJobIds: number;
  fallbackTracked: number;
}

export interface LocalRuntimeQQDeliverySummary {
  configPath: string;
  configExists: boolean;
  qqbotConfigPresent: boolean;
  configuredAccountCount: number;
  imageServerConfigured: boolean;
}

export interface LocalRuntimeMediaSummary {
  selfieScript: LocalRuntimeHealthFileSummary;
  imageDataDir: LocalRuntimeHealthFileSummary;
  dashscopeApiKeyConfigured: boolean;
  dashscopeModel: string;
}

export interface LocalRuntimeHealthReport {
  status: LocalRuntimeHealthStatus;
  checkedAt: string;
  qqDelivery: LocalRuntimeQQDeliverySummary;
  cronPatch: RuntimeCronPatchReport;
  promiseState: LocalRuntimePromiseStateSummary;
  memoryState: LocalRuntimeHealthFileSummary;
  media: LocalRuntimeMediaSummary;
}

export interface LocalRuntimeHealthOptions extends RuntimeCronPatchOptions {
  openClawConfigPath?: string;
  qqbotDataDir?: string;
  selfieScriptPath?: string;
  env?: Record<string, string | undefined>;
}

interface PatchSnippet {
  id: string;
  pattern: RegExp;
}

const REQUIRED_CRON_PATCH_SNIPPETS: PatchSnippet[] = [
  { id: "cron-payload-prefix", pattern: /QQBOT_CRON:/ },
  { id: "exact-forward-header", pattern: /这是一次纯转发任务。/ },
  { id: "payload-validator", pattern: /validateCronPayloadText/ },
  { id: "exact-forward-extractor", pattern: /extractExactForwardMessage/ },
  { id: "direct-forward-branch", pattern: /exactForward\.matched/ },
  { id: "direct-output-delivery", pattern: /payloads:\s*\[\{\s*text:\s*outputText\s*\}\]/ },
];

function getPackageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(path.dirname(moduleDir)) === "dist") {
    return path.resolve(moduleDir, "../..");
  }
  return path.resolve(moduleDir, "..");
}

function getRepoRoot(): string {
  return path.resolve(getPackageRoot(), "../..");
}

export function getDefaultVendoredCronRunnerPath(): string {
  return path.join(
    getPackageRoot(),
    "node_modules",
    "clawdbot",
    "dist",
    "cron",
    "isolated-agent",
    "run.js"
  );
}

export function getDefaultInstalledGatewayBundlePaths(homeDir = os.homedir()): string[] {
  const distDir = path.join(homeDir, ".openclaw", "lib", "node_modules", "openclaw", "dist");
  if (!fs.existsSync(distDir)) return [];
  return fs.readdirSync(distDir)
    .filter((entry) => /^gateway-cli-.*\.js$/.test(entry))
    .sort()
    .map((entry) => path.join(distDir, entry));
}

function getDefaultOpenClawConfigCandidatePaths(env: Record<string, string | undefined>): string[] {
  return [
    env.OPENCLAW_CONFIG_PATH?.trim(),
    env.OPENCLAW_STATE_DIR?.trim() ? path.resolve(env.OPENCLAW_STATE_DIR.trim(), "openclaw.json") : undefined,
    path.join(getRepoRoot(), "openclaw.json"),
    path.join(path.dirname(getRepoRoot()), "openclaw.json"),
  ].filter((item): item is string => Boolean(item));
}

function resolveDefaultOpenClawConfigPath(env: Record<string, string | undefined>): string {
  const candidates = getDefaultOpenClawConfigCandidatePaths(env);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? path.join(getRepoRoot(), "openclaw.json");
}

function getDefaultQQBotDataDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "qqbot");
}

function getDefaultSelfieScriptPath(): string {
  return path.join(getRepoRoot(), "skills", "asuka-selfie", "skill", "scripts", "asuka-selfie.sh");
}

function summarizeFile(targetPath: string): LocalRuntimeHealthFileSummary {
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, exists: false };
  }
  const stat = fs.statSync(targetPath);
  return {
    path: targetPath,
    exists: true,
    sizeBytes: stat.isFile() ? stat.size : undefined,
  };
}

function readJsonObject(targetPath: string): Record<string, any> | null {
  if (!fs.existsSync(targetPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasConfiguredSecret(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeQQDeliveryConfig(
  configPath: string,
  env: Record<string, string | undefined>
): LocalRuntimeQQDeliverySummary {
  const root = readJsonObject(configPath);
  const qqbot = root?.channels?.qqbot;
  const accounts = qqbot?.accounts && typeof qqbot.accounts === "object" ? Object.values<any>(qqbot.accounts) : [];
  const candidates = [qqbot, ...accounts].filter(Boolean);
  const configuredAccountCount = candidates.filter((account) => {
    const hasAppId = hasConfiguredSecret(account?.appId) || hasConfiguredSecret(env.QQBOT_APP_ID);
    const hasSecret = hasConfiguredSecret(account?.clientSecret)
      || hasConfiguredSecret(account?.clientSecretFile)
      || hasConfiguredSecret(env.QQBOT_CLIENT_SECRET);
    return hasAppId && hasSecret;
  }).length;

  return {
    configPath,
    configExists: Boolean(root),
    qqbotConfigPresent: Boolean(qqbot),
    configuredAccountCount,
    imageServerConfigured: candidates.some((account) => hasConfiguredSecret(account?.imageServerBaseUrl))
      || hasConfiguredSecret(env.QQBOT_IMAGE_SERVER_BASE_URL),
  };
}

function summarizePromiseState(qqbotDataDir: string): LocalRuntimePromiseStateSummary {
  const statePath = path.join(qqbotDataDir, "data", "asuka-state", "state.json");
  const root = readJsonObject(statePath);
  const promises = root?.promises && typeof root.promises === "object" ? Object.values<any>(root.promises) : [];
  return {
    path: statePath,
    exists: Boolean(root),
    total: promises.length,
    scheduled: promises.filter((promise) => (promise.state ?? promise.status) === "scheduled").length,
    scheduleFailed: promises.filter((promise) => (promise.state ?? promise.status) === "schedule_failed").length,
    deliveryFailed: promises.filter((promise) => (promise.state ?? promise.status) === "delivery_failed").length,
    cronJobIds: promises.reduce((count, promise) => {
      const followUps = Array.isArray(promise.followUpJobIds) ? promise.followUpJobIds.length : 0;
      return count + (promise.cronJobId ? 1 : 0) + followUps;
    }, 0),
    fallbackTracked: promises.filter((promise) => typeof promise.lastFallbackState === "string").length,
  };
}

function summarizeMediaReadiness(
  configPath: string,
  qqbotDataDir: string,
  selfieScriptPath: string,
  env: Record<string, string | undefined>
): LocalRuntimeMediaSummary {
  const root = readJsonObject(configPath);
  const skillCfg = root?.skills?.entries?.["asuka-selfie"];
  const model = String(skillCfg?.env?.DASHSCOPE_MODEL || env.DASHSCOPE_MODEL || "wan2.6-image").trim();
  return {
    selfieScript: summarizeFile(selfieScriptPath),
    imageDataDir: summarizeFile(path.join(qqbotDataDir, "images")),
    dashscopeApiKeyConfigured: hasConfiguredSecret(skillCfg?.apiKey)
      || hasConfiguredSecret(skillCfg?.env?.DASHSCOPE_API_KEY)
      || hasConfiguredSecret(env.DASHSCOPE_API_KEY),
    dashscopeModel: model || "wan2.6-image",
  };
}

export function validateCronPatchText(text: string): string[] {
  return REQUIRED_CRON_PATCH_SNIPPETS
    .filter((snippet) => !snippet.pattern.test(text))
    .map((snippet) => snippet.id);
}

function validateCronPatchFile(
  kind: RuntimeCronPatchTargetKind,
  label: string,
  targetPath: string,
  required: boolean
): RuntimeCronPatchTargetResult {
  if (!fs.existsSync(targetPath)) {
    return {
      kind,
      label,
      path: targetPath,
      required,
      status: "missing",
      reasons: ["file-missing"],
    };
  }

  let text = "";
  try {
    text = fs.readFileSync(targetPath, "utf-8");
  } catch (err) {
    return {
      kind,
      label,
      path: targetPath,
      required,
      status: "fail",
      reasons: [`read-failed:${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const missingSnippets = validateCronPatchText(text);
  return {
    kind,
    label,
    path: targetPath,
    required,
    status: missingSnippets.length === 0 ? "pass" : "fail",
    reasons: missingSnippets.length === 0 ? [] : missingSnippets.map((id) => `missing-snippet:${id}`),
  };
}

function isBlockingRuntimePatchResult(result: RuntimeCronPatchTargetResult): boolean {
  if (result.status === "fail") return true;
  return result.required && result.status === "missing";
}

export function validateRuntimeCronPatch(options: RuntimeCronPatchOptions = {}): RuntimeCronPatchReport {
  const includeInstalled = options.includeInstalled ?? true;
  const installedRequired = options.installedRequired ?? false;
  const targets: RuntimeCronPatchTargetResult[] = [
    validateCronPatchFile(
      "vendored_clawdbot",
      "Vendored clawdbot cron runner",
      options.vendoredRunnerPath ?? getDefaultVendoredCronRunnerPath(),
      true
    ),
  ];

  if (includeInstalled) {
    const installedPaths = options.installedGatewayPaths ?? getDefaultInstalledGatewayBundlePaths(options.homeDir);
    if (installedPaths.length === 0) {
      targets.push({
        kind: "installed_openclaw",
        label: "Installed OpenClaw gateway bundle",
        path: path.join(
          options.homeDir ?? os.homedir(),
          ".openclaw",
          "lib",
          "node_modules",
          "openclaw",
          "dist",
          "gateway-cli-*.js"
        ),
        required: installedRequired,
        status: "missing",
        reasons: ["optional-installed-bundle-missing"],
      });
    } else {
      for (const gatewayPath of installedPaths) {
        targets.push(validateCronPatchFile(
          "installed_openclaw",
          "Installed OpenClaw gateway bundle",
          gatewayPath,
          installedRequired
        ));
      }
    }
  }

  return {
    status: targets.some(isBlockingRuntimePatchResult) ? "fail" : "pass",
    checkedAt: (options.now ?? new Date()).toISOString(),
    targets,
  };
}

export function buildLocalRuntimeHealthReport(options: LocalRuntimeHealthOptions = {}): LocalRuntimeHealthReport {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const qqbotDataDir = options.qqbotDataDir ?? getDefaultQQBotDataDir(homeDir);
  const configPath = options.openClawConfigPath ?? resolveDefaultOpenClawConfigPath(env);
  const selfieScriptPath = options.selfieScriptPath ?? getDefaultSelfieScriptPath();
  const cronPatch = validateRuntimeCronPatch(options);
  const qqDelivery = summarizeQQDeliveryConfig(configPath, env);
  const promiseState = summarizePromiseState(qqbotDataDir);
  const memoryState = summarizeFile(path.join(qqbotDataDir, "data", "asuka-memory", "memory.json"));
  const media = summarizeMediaReadiness(configPath, qqbotDataDir, selfieScriptPath, env);

  const hasWarnings = !qqDelivery.configExists
    || !qqDelivery.qqbotConfigPresent
    || qqDelivery.configuredAccountCount === 0
    || !media.selfieScript.exists
    || !media.dashscopeApiKeyConfigured;

  return {
    status: cronPatch.status === "fail" ? "fail" : hasWarnings ? "warn" : "pass",
    checkedAt: (options.now ?? new Date()).toISOString(),
    qqDelivery,
    cronPatch,
    promiseState,
    memoryState,
    media,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatLocalRuntimeHealthReport(report: LocalRuntimeHealthReport): string {
  const cronTargets = report.cronPatch.targets
    .map((target) => `${target.kind}:${target.status}`)
    .join(", ");
  return [
    `QQBot runtime health: ${report.status}`,
    `checkedAt: ${report.checkedAt}`,
    `openclaw config: ${report.qqDelivery.configExists ? "present" : "missing"} (${report.qqDelivery.configPath})`,
    `qq delivery: qqbotConfig=${yesNo(report.qqDelivery.qqbotConfigPresent)}, configuredAccounts=${report.qqDelivery.configuredAccountCount}, imageServer=${yesNo(report.qqDelivery.imageServerConfigured)}`,
    `cron patch: ${report.cronPatch.status} (${cronTargets})`,
    `promise state: exists=${yesNo(report.promiseState.exists)}, total=${report.promiseState.total}, scheduled=${report.promiseState.scheduled}, scheduleFailed=${report.promiseState.scheduleFailed}, deliveryFailed=${report.promiseState.deliveryFailed}, cronJobIds=${report.promiseState.cronJobIds}, fallbackTracked=${report.promiseState.fallbackTracked}`,
    `memory state: exists=${yesNo(report.memoryState.exists)} (${report.memoryState.path})`,
    `selfie/media: script=${yesNo(report.media.selfieScript.exists)}, dashscopeKey=${yesNo(report.media.dashscopeApiKeyConfigured)}, model=${report.media.dashscopeModel}, imageDataDir=${yesNo(report.media.imageDataDir.exists)} (${report.media.imageDataDir.path})`,
  ].join("\n");
}
