import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedQQBotAccount, QQBotAccountConfig, SceneInferenceConfig } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export const DEFAULT_ACCOUNT_ID = "default";
const FALLBACK_CRON_MODEL = "deepseek/deepseek-v4-flash";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIGHTWEIGHT_MODEL_HINT_RE = /(mini|small|lite|flash|nano|tiny)/i;
let localOpenClawConfigCache: any | undefined;

export type QQBotDeepSeekThinkingLevel = "off" | "high";

interface OpenAICompletionsModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ResolvedSceneInferenceConfig {
  enabledOnInbound: boolean;
  enabledOnProactive: boolean;
  primary: OpenAICompletionsModelConfig | null;
  fallback: OpenAICompletionsModelConfig | null;
  raw: SceneInferenceConfig;
}

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
}

function resolveLocalOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  return path.resolve(MODULE_DIR, "../../../../openclaw.json");
}

function loadLocalOpenClawConfig(): any {
  if (localOpenClawConfigCache !== undefined) {
    return localOpenClawConfigCache;
  }

  const candidatePaths = [
    process.env.OPENCLAW_CONFIG_PATH?.trim(),
    process.env.OPENCLAW_STATE_DIR?.trim()
      ? path.resolve(process.env.OPENCLAW_STATE_DIR.trim(), "openclaw.json")
      : undefined,
    resolveLocalOpenClawConfigPath(),
    path.resolve(MODULE_DIR, "../../../../../openclaw.json"),
  ].filter((item): item is string => Boolean(item));

  for (const configPath of candidatePaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      localOpenClawConfigCache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return localOpenClawConfigCache;
    } catch {
      // ignore malformed optional config path and keep searching
    }
  }

  localOpenClawConfigCache = null;
  return localOpenClawConfigCache;
}

export function getQQBotLocalOpenClawEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configPath = resolveLocalOpenClawConfigPath();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.dirname(configPath);
  return {
    ...process.env,
    ...extraEnv,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

export function getQQBotLocalPrimaryModel(): string {
  try {
    const parsed = loadLocalOpenClawConfig() as {
      agents?: {
        defaults?: {
          model?: {
            primary?: string;
          };
        };
      };
    } | null;
    if (!parsed) return FALLBACK_CRON_MODEL;
    const primary = parsed.agents?.defaults?.model?.primary?.trim();
    return primary || FALLBACK_CRON_MODEL;
  } catch {
    return FALLBACK_CRON_MODEL;
  }
}

export function getOpenAICompletionsThinkingParams(
  modelId: string,
  level: QQBotDeepSeekThinkingLevel
): Record<string, unknown> {
  const normalizedModel = modelId.trim().toLowerCase();
  if (!normalizedModel.startsWith("deepseek-v4-")) {
    return {};
  }

  if (level === "high") {
    return {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    };
  }

  return {
    thinking: { type: "disabled" },
  };
}

function getQQBotChannelConfigFromRoot(root: any): QQBotChannelConfig | undefined {
  return root?.channels?.qqbot as QQBotChannelConfig | undefined;
}

function getInheritedSceneInferenceConfig(qqbot: QQBotChannelConfig | undefined, accountId?: string | null): SceneInferenceConfig {
  if (!qqbot) return {};
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...(qqbot.sceneInference ?? {}),
    };
  }
  return {
    ...(qqbot.sceneInference ?? {}),
    ...(qqbot.accounts?.[accountId]?.sceneInference ?? {}),
  };
}

function resolveFirstSupportedModel(root: any): OpenAICompletionsModelConfig | null {
  const providers = root?.models?.providers;
  if (!providers || typeof providers !== "object") return null;
  for (const candidateProvider of Object.values<any>(providers)) {
    if (!candidateProvider?.baseUrl || !candidateProvider?.apiKey) continue;
    if (candidateProvider.api && candidateProvider.api !== "openai-completions") continue;
    const modelId = String(candidateProvider?.models?.[0]?.id || "").trim();
    if (!modelId) continue;
    return {
      baseUrl: String(candidateProvider.baseUrl).replace(/\/+$/, ""),
      apiKey: String(candidateProvider.apiKey),
      model: modelId,
    };
  }
  return null;
}

function resolveOpenAICompletionsModel(
  root: any,
  modelRef?: string,
  preferredProviderId?: string
): OpenAICompletionsModelConfig | null {
  const providers = root?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }

  const tryResolve = (providerId: string, modelId: string): OpenAICompletionsModelConfig | null => {
    const provider = providers?.[providerId];
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    if (provider.api && provider.api !== "openai-completions") return null;
    if (!modelId) {
      modelId = String(provider?.models?.[0]?.id || "").trim();
    }
    if (!modelId) return null;
    return {
      baseUrl: String(provider.baseUrl).replace(/\/+$/, ""),
      apiKey: String(provider.apiKey),
      model: modelId,
    };
  };

  const normalizedRef = String(modelRef || "").trim();
  if (normalizedRef) {
    const parts = normalizedRef.split("/");
    if (parts.length > 1) {
      const providerId = parts[0]!;
      const modelId = parts.slice(1).join("/");
      return tryResolve(providerId, modelId) ?? resolveFirstSupportedModel(root);
    }

    if (preferredProviderId) {
      const preferred = tryResolve(preferredProviderId, normalizedRef);
      if (preferred) return preferred;
    }

    for (const [providerId, provider] of Object.entries<any>(providers)) {
      if (!provider?.baseUrl || !provider?.apiKey) continue;
      if (provider.api && provider.api !== "openai-completions") continue;
      const matchedModel = (provider.models ?? []).find((item: any) => String(item?.id || "").trim() === normalizedRef);
      if (!matchedModel) continue;
      return tryResolve(providerId, normalizedRef);
    }
  }

  return resolveFirstSupportedModel(root);
}

function pickScenePrimaryModelRef(root: any, fallbackRef: string): string {
  const providers = root?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return fallbackRef;
  }

  const [fallbackProviderId, ...fallbackModelParts] = String(fallbackRef).split("/");
  const fallbackModelId = fallbackModelParts.join("/");
  const searchCandidates: Array<[string, any]> = [];

  if (fallbackProviderId && providers[fallbackProviderId]) {
    searchCandidates.push([fallbackProviderId, providers[fallbackProviderId]]);
  }
  for (const entry of Object.entries<any>(providers)) {
    if (entry[0] === fallbackProviderId) continue;
    searchCandidates.push(entry);
  }

  for (const [providerId, provider] of searchCandidates) {
    if (!provider?.baseUrl || !provider?.apiKey) continue;
    if (provider.api && provider.api !== "openai-completions") continue;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const candidate = models.find((item: any) => {
      const modelId = String(item?.id || "").trim();
      if (!modelId) return false;
      if (providerId === fallbackProviderId && modelId === fallbackModelId) return false;
      return LIGHTWEIGHT_MODEL_HINT_RE.test(modelId);
    });
    if (candidate?.id) {
      return `${providerId}/${String(candidate.id).trim()}`;
    }
  }

  return fallbackRef;
}

export function resolveQQBotSceneInferenceConfig(accountId?: string | null): ResolvedSceneInferenceConfig {
  const root = loadLocalOpenClawConfig();
  if (!root) {
    return {
      enabledOnInbound: true,
      enabledOnProactive: true,
      primary: null,
      fallback: null,
      raw: {},
    };
  }

  const qqbot = getQQBotChannelConfigFromRoot(root);
  const raw = getInheritedSceneInferenceConfig(qqbot, accountId);
  const fallbackRef = String(raw.fallbackModel || getQQBotLocalPrimaryModel()).trim();
  const primaryRef = String(raw.primaryModel || pickScenePrimaryModelRef(root, fallbackRef)).trim();
  const [fallbackProviderId] = fallbackRef.split("/");

  return {
    enabledOnInbound: raw.enabledOnInbound !== false,
    enabledOnProactive: raw.enabledOnProactive !== false,
    primary: resolveOpenAICompletionsModel(root, primaryRef, fallbackProviderId),
    fallback: resolveOpenAICompletionsModel(root, fallbackRef, fallbackProviderId),
    raw,
  };
}

function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  // 如果有默认账户配置，返回 default
  if (qqbot?.appId) {
    return DEFAULT_ACCOUNT_ID;
  }
  // 否则返回第一个配置的账户
  if (qqbot?.accounts) {
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户从顶层读取
    accountConfig = {
      enabled: qqbot?.enabled,
      name: qqbot?.name,
      appId: qqbot?.appId,
      clientSecret: qqbot?.clientSecret,
      clientSecretFile: qqbot?.clientSecretFile,
      dmPolicy: qqbot?.dmPolicy,
      allowFrom: qqbot?.allowFrom,
      systemPrompt: qqbot?.systemPrompt,
      imageServerBaseUrl: qqbot?.imageServerBaseUrl,
      markdownSupport: qqbot?.markdownSupport ?? true,
      proactiveQuietHours: qqbot?.proactiveQuietHours,
      sceneInference: qqbot?.sceneInference,
      messageBufferMs: qqbot?.messageBufferMs,
      messageBufferMaxMs: qqbot?.messageBufferMaxMs,
    };
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    const inheritedQuietHours =
      qqbot?.proactiveQuietHours || account?.proactiveQuietHours
        ? {
            ...qqbot?.proactiveQuietHours,
            ...account?.proactiveQuietHours,
          }
        : undefined;
    const inheritedSceneInference =
      qqbot?.sceneInference || account?.sceneInference
        ? {
            ...qqbot?.sceneInference,
            ...account?.sceneInference,
          }
        : undefined;
    const inheritedMessageBufferMs = account?.messageBufferMs ?? qqbot?.messageBufferMs;
    const inheritedMessageBufferMaxMs = account?.messageBufferMaxMs ?? qqbot?.messageBufferMaxMs;
    accountConfig = {
      ...(account ?? {}),
      ...(inheritedQuietHours ? { proactiveQuietHours: inheritedQuietHours } : {}),
      ...(inheritedSceneInference ? { sceneInference: inheritedSceneInference } : {}),
      ...(inheritedMessageBufferMs !== undefined ? { messageBufferMs: inheritedMessageBufferMs } : {}),
      ...(inheritedMessageBufferMaxMs !== undefined ? { messageBufferMaxMs: inheritedMessageBufferMaxMs } : {}),
    };
    appId = normalizeAppId(account?.appId);
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(process.env.QQBOT_APP_ID);
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    imageServerBaseUrl: accountConfig.imageServerBaseUrl || process.env.QQBOT_IMAGE_SERVER_BASE_URL,
    markdownSupport: accountConfig.markdownSupport !== false,
    config: accountConfig,
  };
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string; imageServerBaseUrl?: string }
): OpenClawConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingConfig = (next.channels?.qqbot as QQBotChannelConfig) || {};
    const allowFrom = existingConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        allowFrom,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile }
            : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
      },
    };
  } else {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingAccountConfig = (next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        accounts: {
          ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {}),
          [accountId]: {
            ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {}),
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.imageServerBaseUrl ? { imageServerBaseUrl: input.imageServerBaseUrl } : {}),
          },
        },
      },
    };
  }

  return next;
}
