import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeCronPatchTargetKind =
  | "vendored_clawdbot"
  | "tools_openclaw"
  | "home_lib_openclaw"
  | "installed_openclaw";
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
  env?: Record<string, string | undefined>;
  execPath?: string;
  now?: Date;
}

export interface InstalledOpenClawCronTarget {
  kind: Exclude<RuntimeCronPatchTargetKind, "vendored_clawdbot">;
  label: string;
  packageRoot: string;
  bundlePaths: string[];
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
  studioApiKeyConfigured: boolean;
  studioModel: string;
}

export type LocalRuntimeMiniMaxCapabilityKind = "text" | "image" | "voice" | "vision" | "search";

export interface LocalRuntimeMiniMaxCapabilitySummary {
  configured: boolean;
  implemented: boolean;
  source: string;
  model: string;
  baseUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  notes: string[];
}

export interface LocalRuntimeMiniMaxSummary {
  providerConfigured: boolean;
  providerBaseUrlConfigured: boolean;
  providerApiKeyConfigured: boolean;
  capabilities: Record<LocalRuntimeMiniMaxCapabilityKind, LocalRuntimeMiniMaxCapabilitySummary>;
}

export interface LocalRuntimeHealthReport {
  status: LocalRuntimeHealthStatus;
  checkedAt: string;
  qqDelivery: LocalRuntimeQQDeliverySummary;
  cronPatch: RuntimeCronPatchReport;
  promiseState: LocalRuntimePromiseStateSummary;
  memoryState: LocalRuntimeHealthFileSummary;
  media: LocalRuntimeMediaSummary;
  minimax: LocalRuntimeMiniMaxSummary;
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
  { id: "cron-prefix-tolerant", pattern: /CRON_EXACT_FORWARD_PROMPT_PREFIX_RE|stripCronPromptPrefix/ },
  { id: "payload-validator", pattern: /validateCronPayloadText/ },
  { id: "exact-forward-extractor", pattern: /extractExactForwardMessage/ },
  { id: "direct-forward-branch", pattern: /exactForward\.matched/ },
  {
    id: "direct-output-delivery",
    pattern: /(?:deliveryPayloads|payloads):\s*\[\{\s*text:\s*outputText\s*\}\]/,
  },
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

const OPENCLAW_PACKAGE_RELATIVE_PATHS = [
  ["lib", "node_modules", "openclaw"],
  ["node_modules", "openclaw"],
];
const OPENCLAW_BUNDLE_NAME_RE = /^(?:gateway-cli|isolated-agent)-.*\.js$/;
const OPENCLAW_RUN_FUNCTION_RE = /(?:export\s+)?async function runCronIsolatedAgentTurn\(params\) \{/;

function addOpenClawRootsUnderTools(roots: Set<string>, toolsDir: string): void {
  if (!fs.existsSync(toolsDir)) return;
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

function findCronImplementationBundles(packageRootPath: string): string[] {
  const distDir = path.join(packageRootPath, "dist");
  if (!fs.existsSync(distDir)) return [];
  return fs.readdirSync(distDir)
    .filter((entry) => OPENCLAW_BUNDLE_NAME_RE.test(entry))
    .sort()
    .map((entry) => path.join(distDir, entry))
    .filter((bundlePath) => {
      try {
        return OPENCLAW_RUN_FUNCTION_RE.test(fs.readFileSync(bundlePath, "utf8"));
      } catch {
        return false;
      }
    });
}

export function getDefaultInstalledOpenClawCronTargets(
  homeDir = os.homedir(),
  env: Record<string, string | undefined> = process.env,
  execPath = process.execPath
): InstalledOpenClawCronTarget[] {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(homeDir, ".openclaw");
  const homeLibRoot = path.join(stateDir, "lib", "node_modules", "openclaw");
  const toolsRoots = new Set<string>();
  addOpenClawRootsUnderTools(toolsRoots, env.OPENCLAW_TOOLS_DIR?.trim() || path.join(stateDir, "tools"));

  const executableDir = path.dirname(execPath);
  for (const relativeParts of OPENCLAW_PACKAGE_RELATIVE_PATHS) {
    toolsRoots.add(path.join(executableDir, ...relativeParts));
  }
  toolsRoots.add(path.resolve(executableDir, "..", "lib", "node_modules", "openclaw"));

  const explicitRoots = String(env.OPENCLAW_RUNTIME_ROOTS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);

  const candidates: Array<{
    kind: InstalledOpenClawCronTarget["kind"];
    label: string;
    packageRoot: string;
  }> = [
    { kind: "home_lib_openclaw", label: "OpenClaw compatibility home runtime", packageRoot: homeLibRoot },
    ...[...toolsRoots].map((packageRoot) => ({
      kind: "tools_openclaw" as const,
      label: "OpenClaw tools runtime",
      packageRoot,
    })),
    ...explicitRoots.map((packageRoot) => ({
      kind: "installed_openclaw" as const,
      label: "Explicit OpenClaw runtime",
      packageRoot,
    })),
  ];

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => fs.existsSync(path.join(candidate.packageRoot, "package.json")))
    .filter((candidate) => {
      const normalized = path.resolve(candidate.packageRoot);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .map((candidate) => ({
      ...candidate,
      bundlePaths: findCronImplementationBundles(candidate.packageRoot),
    }))
    .sort((left, right) => left.packageRoot.localeCompare(right.packageRoot));
}

export function getDefaultInstalledGatewayBundlePaths(homeDir = os.homedir()): string[] {
  return getDefaultInstalledOpenClawCronTargets(homeDir)
    .flatMap((target) => target.bundlePaths);
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
    const content = fs.readFileSync(targetPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(content);
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
  const skillEnv = skillCfg?.env || {};
  const model = String(
    skillEnv.STUDIO_IMAGE_EDIT_MODEL
    || skillEnv.STUDIO_IMAGE_MODEL
    || skillEnv.STUDIO_MODEL
    || env.STUDIO_IMAGE_EDIT_MODEL
    || env.STUDIO_IMAGE_MODEL
    || env.STUDIO_MODEL
    || skillEnv.DASHSCOPE_MODEL
    || env.DASHSCOPE_MODEL
    || "third_party_media:gemini-3-pro-image-preview"
  ).trim();
  return {
    selfieScript: summarizeFile(selfieScriptPath),
    imageDataDir: summarizeFile(path.join(qqbotDataDir, "images")),
    studioApiKeyConfigured: hasConfiguredSecret(skillCfg?.apiKey)
      || hasConfiguredSecret(skillEnv.STUDIO_API_KEY)
      || hasConfiguredSecret(skillEnv.STUDIO_AUTH_PROFILE)
      || hasConfiguredSecret(env.STUDIO_API_KEY)
      || hasConfiguredSecret(env.STUDIO_AUTH_PROFILE)
      || hasConfiguredSecret(skillEnv.DASHSCOPE_API_KEY)
      || hasConfiguredSecret(env.DASHSCOPE_API_KEY),
    studioModel: model || "third_party_media:gemini-3-pro-image-preview",
  };
}

function getObject(root: any, pathParts: string[]): Record<string, any> | undefined {
  let current = root;
  for (const part of pathParts) {
    current = current?.[part];
    if (!current || typeof current !== "object") return undefined;
  }
  return current as Record<string, any>;
}

function getStringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function isEnabledBlock(block: Record<string, any> | undefined): boolean {
  return Boolean(block) && block?.enabled !== false;
}

function makeMiniMaxCapabilitySummary(input: {
  configured: boolean;
  implemented: boolean;
  source: string;
  model: string;
  baseUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  notes?: string[];
}): LocalRuntimeMiniMaxCapabilitySummary {
  return {
    configured: input.configured,
    implemented: input.implemented,
    source: input.source,
    model: input.model,
    baseUrlConfigured: input.baseUrlConfigured,
    apiKeyConfigured: input.apiKeyConfigured,
    notes: input.notes ?? [],
  };
}

function summarizeMiniMaxReadiness(
  configPath: string,
  env: Record<string, string | undefined>
): LocalRuntimeMiniMaxSummary {
  const root = readJsonObject(configPath);
  const provider = getObject(root, ["models", "providers", "minimax"]);
  const providerBaseUrlConfigured = hasConfiguredSecret(provider?.baseUrl);
  const providerApiKeyConfigured = hasConfiguredSecret(provider?.apiKey)
    || hasConfiguredSecret(env.MINIMAX_API_KEY);
  const providerConfigured = providerBaseUrlConfigured && providerApiKeyConfigured;
  const providerModel = getStringValue(provider?.models?.[0]?.id, provider?.model, "MiniMax-M2.7");

  const primaryModel = getStringValue(root?.agents?.defaults?.model?.primary);
  const textModel = primaryModel.toLowerCase().startsWith("minimax/")
    ? primaryModel.replace(/^minimax\//i, "")
    : providerModel;
  const textConfigured = providerConfigured && (
    primaryModel.toLowerCase().startsWith("minimax/")
    || providerModel.toLowerCase().startsWith("minimax-")
  );

  const skillCfg = root?.skills?.entries?.["asuka-selfie"];
  const skillEnv = skillCfg?.env || {};
  const imageModel = getStringValue(
    skillEnv.STUDIO_IMAGE_EDIT_MODEL,
    skillEnv.STUDIO_IMAGE_MODEL,
    skillEnv.STUDIO_MODEL,
    env.STUDIO_IMAGE_EDIT_MODEL,
    env.STUDIO_IMAGE_MODEL,
    env.STUDIO_MODEL,
    "image-01"
  );
  const imageBaseUrlConfigured = hasConfiguredSecret(skillEnv.STUDIO_API_BASE_URL)
    || hasConfiguredSecret(env.STUDIO_API_BASE_URL)
    || providerBaseUrlConfigured;
  const imageApiKeyConfigured = hasConfiguredSecret(skillCfg?.apiKey)
    || hasConfiguredSecret(skillEnv.STUDIO_API_KEY)
    || hasConfiguredSecret(skillEnv.STUDIO_AUTH_PROFILE)
    || hasConfiguredSecret(env.STUDIO_API_KEY)
    || hasConfiguredSecret(env.STUDIO_AUTH_PROFILE)
    || providerApiKeyConfigured;
  const imageConfigured = imageBaseUrlConfigured && imageApiKeyConfigured && /^image-01(?:$|-)/i.test(imageModel);

  const channelTts = getObject(root, ["channels", "qqbot", "tts"]);
  const messagesTts = getObject(root, ["messages", "tts"]);
  const messagesProviderId = getStringValue(messagesTts?.provider);
  const messagesProviderBlock = messagesProviderId ? getObject(messagesTts, [messagesProviderId]) : undefined;
  const ttsBlock = isEnabledBlock(channelTts) ? channelTts : isEnabledBlock(messagesTts) ? messagesProviderBlock : undefined;
  const ttsProviderId = getStringValue(channelTts?.provider, messagesProviderId);
  const ttsProvider = ttsProviderId ? getObject(root, ["models", "providers", ttsProviderId]) : undefined;
  const voiceModel = getStringValue(ttsBlock?.model, env.MINIMAX_TTS_MODEL);
  const voiceBaseUrlConfigured = hasConfiguredSecret(ttsBlock?.baseUrl)
    || hasConfiguredSecret(ttsProvider?.baseUrl)
    || (ttsProviderId === "minimax" && providerBaseUrlConfigured);
  const voiceApiKeyConfigured = hasConfiguredSecret(ttsBlock?.apiKey)
    || hasConfiguredSecret(ttsProvider?.apiKey)
    || (ttsProviderId === "minimax" && providerApiKeyConfigured);
  const voiceConfigured = voiceBaseUrlConfigured
    && voiceApiKeyConfigured
    && (ttsProviderId === "minimax" || /^minimax/i.test(voiceModel) || hasConfiguredSecret(env.MINIMAX_TTS_MODEL));

  const miniMaxBlock = getObject(root, ["channels", "qqbot", "minimax"]);
  const visionBlock = getObject(miniMaxBlock, ["vision"]);
  const visionModel = getStringValue(visionBlock?.model, env.MINIMAX_VISION_MODEL);
  const visionConfigured = isEnabledBlock(visionBlock)
    && providerConfigured
    && Boolean(visionModel);

  const searchBlock = getObject(miniMaxBlock, ["search"]);
  const searchModel = getStringValue(searchBlock?.model, env.MINIMAX_SEARCH_MODEL);
  const searchEnvEnabled = /^(1|true|yes|on)$/i.test(getStringValue(env.MINIMAX_SEARCH_ENABLED));
  const searchConfigured = (isEnabledBlock(searchBlock) || searchEnvEnabled)
    && providerConfigured
    && Boolean(searchModel || searchEnvEnabled);

  return {
    providerConfigured,
    providerBaseUrlConfigured,
    providerApiKeyConfigured,
    capabilities: {
      text: makeMiniMaxCapabilitySummary({
        configured: textConfigured,
        implemented: true,
        source: textConfigured ? "models.providers.minimax" : "not-configured",
        model: textConfigured ? textModel : "",
        baseUrlConfigured: providerBaseUrlConfigured,
        apiKeyConfigured: providerApiKeyConfigured,
        notes: textConfigured ? [] : ["primary-model-not-minimax-or-provider-missing"],
      }),
      image: makeMiniMaxCapabilitySummary({
        configured: imageConfigured,
        implemented: true,
        source: imageConfigured ? "skills.entries.asuka-selfie" : "not-configured",
        model: imageConfigured ? imageModel : "",
        baseUrlConfigured: imageBaseUrlConfigured,
        apiKeyConfigured: imageApiKeyConfigured,
        notes: imageConfigured ? [] : ["image-01-skill-config-missing"],
      }),
      voice: makeMiniMaxCapabilitySummary({
        configured: voiceConfigured,
        implemented: true,
        source: voiceConfigured ? "channels.qqbot.tts" : "not-configured",
        model: voiceConfigured ? voiceModel : "",
        baseUrlConfigured: voiceBaseUrlConfigured,
        apiKeyConfigured: voiceApiKeyConfigured,
        notes: voiceConfigured ? [] : ["tts-config-missing"],
      }),
      vision: makeMiniMaxCapabilitySummary({
        configured: visionConfigured,
        implemented: true,
        source: visionConfigured ? "channels.qqbot.minimax.vision" : "not-configured",
        model: visionConfigured ? visionModel : "",
        baseUrlConfigured: providerBaseUrlConfigured,
        apiKeyConfigured: providerApiKeyConfigured,
        notes: visionConfigured ? [] : ["vision-config-missing"],
      }),
      search: makeMiniMaxCapabilitySummary({
        configured: searchConfigured,
        implemented: true,
        source: searchConfigured ? (isEnabledBlock(searchBlock) ? "channels.qqbot.minimax.search" : "env.MINIMAX_SEARCH_ENABLED") : "not-configured",
        model: searchConfigured ? (searchModel || providerModel) : "",
        baseUrlConfigured: providerBaseUrlConfigured,
        apiKeyConfigured: providerApiKeyConfigured,
        notes: searchConfigured ? [] : ["search-config-missing"],
      }),
    },
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
    const explicitInstalledPaths = options.installedGatewayPaths;
    const discoveredTargets = explicitInstalledPaths !== undefined
      ? explicitInstalledPaths.length > 0
        ? [{
            kind: "installed_openclaw" as const,
            label: "Installed OpenClaw gateway bundle",
            packageRoot: "",
            bundlePaths: explicitInstalledPaths,
          }]
        : []
      : getDefaultInstalledOpenClawCronTargets(
          options.homeDir,
          options.env ?? process.env,
          options.execPath ?? process.execPath
        );
    if (discoveredTargets.length === 0) {
      targets.push({
        kind: "installed_openclaw",
        label: "Installed OpenClaw cron bundle",
        path: path.join(
          options.homeDir ?? os.homedir(),
          ".openclaw",
          "{tools,lib}",
          "**",
          "node_modules",
          "openclaw",
          "dist",
          "{gateway-cli,isolated-agent}-*.js"
        ),
        required: installedRequired,
        status: "missing",
        reasons: ["optional-installed-bundle-missing"],
      });
    } else {
      for (const discovered of discoveredTargets) {
        if (discovered.bundlePaths.length === 0) {
          targets.push({
            kind: discovered.kind,
            label: discovered.label,
            path: path.join(discovered.packageRoot, "dist", "{gateway-cli,isolated-agent}-*.js"),
            required: true,
            status: "fail",
            reasons: ["cron-implementation-bundle-not-found"],
          });
          continue;
        }
        for (const bundlePath of discovered.bundlePaths) {
          targets.push(validateCronPatchFile(
            discovered.kind,
            discovered.label,
            bundlePath,
            installedRequired
          ));
        }
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
  const minimax = summarizeMiniMaxReadiness(configPath, env);

  const hasWarnings = !qqDelivery.configExists
    || !qqDelivery.qqbotConfigPresent
    || qqDelivery.configuredAccountCount === 0
    || !media.selfieScript.exists
    || !media.studioApiKeyConfigured;

  return {
    status: cronPatch.status === "fail" ? "fail" : hasWarnings ? "warn" : "pass",
    checkedAt: (options.now ?? new Date()).toISOString(),
    qqDelivery,
    cronPatch,
    promiseState,
    memoryState,
    media,
    minimax,
  };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatLocalRuntimeHealthReport(report: LocalRuntimeHealthReport): string {
  const cronTargets = report.cronPatch.targets
    .map((target) => `${target.kind}:${target.status}`)
    .join(", ");
  const minimaxCapabilities = (["text", "image", "voice", "vision", "search"] as LocalRuntimeMiniMaxCapabilityKind[])
    .map((kind) => {
      const capability = report.minimax.capabilities[kind];
      const modelSuffix = capability.model ? `:${capability.model}` : "";
      const implementedSuffix = capability.implemented ? "" : ":pending";
      return `${kind}=${yesNo(capability.configured)}${modelSuffix}${implementedSuffix}`;
    })
    .join(", ");
  return [
    `QQBot runtime health: ${report.status}`,
    `checkedAt: ${report.checkedAt}`,
    `openclaw config: ${report.qqDelivery.configExists ? "present" : "missing"} (${report.qqDelivery.configPath})`,
    `qq delivery: qqbotConfig=${yesNo(report.qqDelivery.qqbotConfigPresent)}, configuredAccounts=${report.qqDelivery.configuredAccountCount}, imageServer=${yesNo(report.qqDelivery.imageServerConfigured)}`,
    `cron patch: ${report.cronPatch.status} (${cronTargets})`,
    `promise state: exists=${yesNo(report.promiseState.exists)}, total=${report.promiseState.total}, scheduled=${report.promiseState.scheduled}, scheduleFailed=${report.promiseState.scheduleFailed}, deliveryFailed=${report.promiseState.deliveryFailed}, cronJobIds=${report.promiseState.cronJobIds}, fallbackTracked=${report.promiseState.fallbackTracked}`,
    `memory state: exists=${yesNo(report.memoryState.exists)} (${report.memoryState.path})`,
    `selfie/media: script=${yesNo(report.media.selfieScript.exists)}, studioKey=${yesNo(report.media.studioApiKeyConfigured)}, model=${report.media.studioModel}, imageDataDir=${yesNo(report.media.imageDataDir.exists)} (${report.media.imageDataDir.path})`,
    `minimax: provider=${yesNo(report.minimax.providerConfigured)}, ${minimaxCapabilities}`,
  ].join("\n");
}
