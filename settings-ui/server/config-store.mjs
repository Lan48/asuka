import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MASK_PREFIX = "••••••••";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.resolve(MODULE_DIR, "..");
const PROJECT_ROOT = process.env.SETTINGS_UI_PROJECT_ROOT
  ? path.resolve(process.env.SETTINGS_UI_PROJECT_ROOT)
  : path.resolve(SETTINGS_DIR, "..");
const DEFAULT_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  ? path.resolve(process.env.OPENCLAW_CONFIG_PATH)
  : path.join(PROJECT_ROOT, "openclaw.json");
const DEFAULT_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR
  ? path.resolve(process.env.OPENCLAW_WORKSPACE_DIR)
  : process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR, "workspace")
    : path.join(PROJECT_ROOT, "workspace");
const WORKSPACE_DOCS = new Set(["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "USER.md"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeSecretKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isSensitiveKey(key) {
  const normalized = normalizeSecretKey(key);
  if (!normalized) return false;
  if (normalized.includes("apikey") || normalized.includes("oauthkey")) return true;
  if (normalized.includes("clientsecret")) return true;
  if (normalized === "secret" || normalized.endsWith("secret")) return true;
  if (normalized === "token" || normalized.endsWith("token")) return true;
  if (["access", "refresh", "password", "passwd", "credential", "authorization", "cookie"].includes(normalized)) return true;
  return false;
}

export function isMaskLike(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(MASK_PREFIX)) return true;
  return /^[*•●xX_-]{4,}[a-zA-Z0-9_-]{0,8}$/.test(trimmed);
}

export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  const tail = text.slice(-4);
  return `${MASK_PREFIX}${tail}`;
}

function pathKey(parts) {
  return parts.join(".");
}

function getAt(root, parts) {
  let current = root;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function setAt(root, parts, value) {
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function deleteAt(root, parts) {
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current?.[parts[i]];
    if (!current || typeof current !== "object") return;
  }
  if (current && typeof current === "object") delete current[parts.at(-1)];
}

function walk(value, visitor, parts = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, parts.concat(String(index))));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = parts.concat(key);
    visitor(key, child, nextPath);
    if (child && typeof child === "object") walk(child, visitor, nextPath);
  }
}

export function redactConfig(config) {
  const redacted = clone(config);
  const secrets = {};
  walk(redacted, (key, value, parts) => {
    if (!isSensitiveKey(key)) return;
    if (typeof value !== "string" || !value) return;
    const mask = maskSecret(value);
    setAt(redacted, parts, mask);
    secrets[pathKey(parts)] = {
      path: parts,
      configured: true,
      last4: value.slice(-4),
      mask,
    };
  });
  return { config: redacted, secrets };
}

export function readConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

export function readRedactedConfig(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const config = readConfig(configPath);
  const { config: redacted, secrets } = redactConfig(config);
  return {
    config: redacted,
    secrets,
    meta: {
      configPath,
      projectRoot: PROJECT_ROOT,
      workspaceDir: options.workspaceDir || DEFAULT_WORKSPACE_DIR,
      loadedAt: new Date().toISOString(),
    },
  };
}

function normalizePayload(payload) {
  if (typeof payload === "string") return JSON.parse(payload);
  if (payload && typeof payload === "object" && payload.config) return payload.config;
  return payload;
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["配置必须是 JSON object"], warnings };
  }
  if (!config.models?.providers || typeof config.models.providers !== "object") {
    errors.push("缺少 models.providers，至少需要一个模型 provider。");
  }
  if (!config.channels?.qqbot || typeof config.channels.qqbot !== "object") {
    warnings.push("缺少 channels.qqbot，QQBot 功能会不可用。");
  }
  if (!config.gateway || typeof config.gateway !== "object") {
    warnings.push("缺少 gateway，本地网关状态页只能显示未配置。");
  }
  if (config.channels?.qqbot?.proactiveQuietHours) {
    const quiet = config.channels.qqbot.proactiveQuietHours;
    for (const key of ["startHour", "endHour"]) {
      if (quiet[key] !== undefined && (!Number.isFinite(Number(quiet[key])) || Number(quiet[key]) < 0 || Number(quiet[key]) > 23)) {
        errors.push(`channels.qqbot.proactiveQuietHours.${key} 必须在 0-23 之间。`);
      }
    }
  }
  walk(config, (key, value, parts) => {
    if (!isSensitiveKey(key)) return;
    if (typeof value === "string" && isMaskLike(value)) {
      errors.push(`${pathKey(parts)} 仍是掩码占位符，不能直接写入配置。`);
    }
  });
  return { ok: errors.length === 0, errors, warnings };
}

export function mergeSecretValues(original, incoming) {
  const next = clone(incoming);
  const originalSecretPaths = new Set();
  walk(original, (key, value, parts) => {
    if (isSensitiveKey(key) && typeof value === "string" && value) originalSecretPaths.add(pathKey(parts));
  });

  for (const keyPath of originalSecretPaths) {
    const parts = keyPath.split(".");
    const originalValue = getAt(original, parts);
    const incomingValue = getAt(next, parts);
    if (incomingValue === undefined) continue;
    if (incomingValue === null || incomingValue === "") {
      deleteAt(next, parts);
      continue;
    }
    if (typeof incomingValue === "string" && isMaskLike(incomingValue)) {
      setAt(next, parts, originalValue);
    }
  }

  const maskErrors = [];
  walk(next, (key, value, parts) => {
    if (!isSensitiveKey(key)) return;
    if (typeof value === "string" && isMaskLike(value)) {
      maskErrors.push(`${pathKey(parts)} 是掩码占位符，无法判断真实值。`);
    }
  });

  return { config: next, errors: maskErrors };
}

export function prepareConfigForWrite(payload, options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const original = options.original || (fs.existsSync(configPath) ? readConfig(configPath) : {});
  const incoming = normalizePayload(payload);
  const { config, errors: mergeErrors } = mergeSecretValues(original, incoming);
  const validation = validateConfig(config);
  return {
    config,
    ok: mergeErrors.length === 0 && validation.ok,
    errors: mergeErrors.concat(validation.errors),
    warnings: validation.warnings,
  };
}

export function saveConfigPayload(payload, options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const prepared = prepareConfigForWrite(payload, options);
  if (!prepared.ok) return { ...prepared, saved: false };

  const dir = path.dirname(configPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${path.basename(configPath)}.bak.settings-ui-${stamp}`);
  const tmpPath = path.join(dir, `${path.basename(configPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(tmpPath, `${JSON.stringify(prepared.config, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, configPath);
  return {
    ...prepared,
    saved: true,
    backupPath,
    writtenAt: new Date().toISOString(),
  };
}

function providerForModelRef(config, modelRef) {
  const ref = String(modelRef || "");
  const [providerId, ...modelParts] = ref.split("/");
  if (modelParts.length > 0) {
    return { providerId, model: modelParts.join("/") };
  }
  const providers = config.models?.providers || {};
  for (const [id, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    if (models.some((item) => item?.id === ref)) return { providerId: id, model: ref };
  }
  return { providerId: "", model: ref };
}

function secretStatus(config, parts) {
  const value = getAt(config, parts);
  return {
    sourcePath: parts.join("."),
    configured: typeof value === "string" && value.length > 0,
    last4: typeof value === "string" && value ? value.slice(-4) : "",
  };
}

function providerKeyStatus(config, providerId) {
  if (!providerId) return { sourcePath: "", configured: false, last4: "" };
  return secretStatus(config, ["models", "providers", providerId, "apiKey"]);
}

function feature(name, kind, provider, model, key, enabled = true) {
  return {
    name,
    kind,
    enabled,
    provider: provider || "未指定",
    model: model || "未指定",
    keySource: key.sourcePath || "未指定",
    keyConfigured: Boolean(key.configured),
    keyLast4: key.last4 || "",
  };
}

export function buildFeatureMap(config) {
  const qqbot = config.channels?.qqbot || {};
  const providers = config.models?.providers || {};
  const primaryRef = config.agents?.defaults?.model?.primary || "";
  const primary = providerForModelRef(config, primaryRef);
  const imageGenerationRef = config.agents?.defaults?.imageGenerationModel?.primary || "";
  const imageGeneration = providerForModelRef(config, imageGenerationRef);
  const tts = qqbot.tts || {};
  const stt = qqbot.stt || config.tools?.media?.audio?.models?.[0] || {};
  const vision = qqbot.minimax?.vision || {};
  const search = qqbot.minimax?.search || {};
  const digest = qqbot.minimax?.digest || {};
  const selfie = config.skills?.entries?.["asuka-selfie"] || {};
  const selfieEnv = selfie.env || {};
  const selfieAuth = selfieEnv.STUDIO_AUTH_PROFILE
    ? {
        sourcePath: "skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE",
        configured: true,
        last4: String(selfieEnv.STUDIO_AUTH_PROFILE).slice(-4),
      }
    : selfie.apiKey
      ? secretStatus(config, ["skills", "entries", "asuka-selfie", "apiKey"])
      : selfieEnv.STUDIO_API_KEY
        ? secretStatus(config, ["skills", "entries", "asuka-selfie", "env", "STUDIO_API_KEY"])
        : providerKeyStatus(config, "minimax");
  const officialSelfieAuth = imageGenerationRef
    ? imageGeneration.providerId === "openai-codex"
      ? { sourcePath: "OpenClaw OAuth profile store", configured: true, last4: "OAuth" }
      : providerKeyStatus(config, imageGeneration.providerId)
    : selfieAuth;

  const ttsProvider = tts.provider || "openai";
  const sttProvider = stt.provider || "openai";
  const visionKey = vision.apiKey
    ? secretStatus(config, ["channels", "qqbot", "minimax", "vision", "apiKey"])
    : providerKeyStatus(config, "minimax");
  const searchKey = search.apiKey
    ? secretStatus(config, ["channels", "qqbot", "minimax", "search", "apiKey"])
    : providerKeyStatus(config, "minimax");
  const digestKey = digest.apiKey
    ? secretStatus(config, ["channels", "qqbot", "minimax", "digest", "apiKey"])
    : search.apiKey
      ? secretStatus(config, ["channels", "qqbot", "minimax", "search", "apiKey"])
      : providerKeyStatus(config, "minimax");

  return [
    feature("文本模型", "text", primary.providerId, primary.model, providerKeyStatus(config, primary.providerId), Boolean(primaryRef)),
    feature("TTS 语音", "voice", ttsProvider, tts.model, tts.apiKey ? secretStatus(config, ["channels", "qqbot", "tts", "apiKey"]) : providerKeyStatus(config, ttsProvider), tts.enabled !== false && Boolean(tts.model || providers[ttsProvider])),
    feature("STT 语音识别", "audio", sttProvider, stt.model || "whisper-1", stt.apiKey ? secretStatus(config, ["channels", "qqbot", "stt", "apiKey"]) : providerKeyStatus(config, sttProvider), stt.enabled !== false && Boolean(stt.model || providers[sttProvider])),
    feature("图片理解", "vision", "minimax", vision.model, visionKey, vision.enabled !== false),
    feature("联网搜索", "search", "minimax", search.intentModel || search.model, searchKey, search.enabled !== false),
    feature("对话 Digest", "digest", "minimax", digest.model || search.model, digestKey, digest.enabled !== false),
    feature("Asuka 自拍", "image", imageGeneration.providerId || (selfieEnv.STUDIO_AUTH_PROFILE ? "openai-codex" : (selfieEnv.STUDIO_API_BASE_URL ? "studio" : "minimax")), imageGeneration.model || selfieEnv.STUDIO_IMAGE_MODEL, officialSelfieAuth, selfie.enabled !== false),
    feature("QQBot 发送", "qqbot", "qqbot", qqbot.appId ? `appId ${qqbot.appId}` : "", secretStatus(config, ["channels", "qqbot", "clientSecret"]), qqbot.enabled !== false),
  ];
}

export function buildTemplate(existing = {}) {
  const current = clone(existing);
  const template = {
    meta: {
      lastTouchedVersion: "settings-ui",
      lastTouchedAt: new Date().toISOString(),
    },
    models: {
      mode: "custom",
      providers: {
        minimax: {
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "",
          api: "openai-completions",
          models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7", reasoning: true, contextWindow: 204800, maxTokens: 8192 }],
        },
        deepseek: {
          baseUrl: "",
          apiKey: "",
          api: "openai-completions",
          models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, contextWindow: 1048576, maxTokens: 8192 }],
        },
        "openai-codex": {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          api: "openai-codex-responses",
          models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
          request: { allowPrivateNetwork: true, proxy: { mode: "env-proxy" } },
        },
      },
    },
    agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" }, imageGenerationModel: { primary: "openai-codex/chatgpt-image-latest", timeoutMs: 240000 }, thinkingDefault: "off", workspace: "workspace" } },
    channels: {
      qqbot: {
        enabled: true,
        allowFrom: ["*"],
        appId: "",
        clientSecret: "",
        proactiveQuietHours: { enabled: true, startHour: 0, endHour: 8, timezone: "Asia/Shanghai" },
        tts: {
          enabled: true,
          provider: "minimax",
          model: "speech-2.8-hd",
          voice: "Chinese (Mandarin)_Laid_BackGirl",
          speed: 1,
          vol: 1,
          pitch: 0,
          languageBoost: "Chinese",
          audioFormat: "wav",
          sampleRate: 24000,
        },
        minimax: {
          vision: { enabled: true, model: "MiniMax-VLM", maxImagesPerMessage: 3, timeoutMs: 30000 },
          search: { enabled: true, model: "MiniMax-M2.7", intentModel: "MiniMax-M2.7", maxResults: 4, timeoutMs: 30000 },
          digest: { enabled: true, model: "MiniMax-M2.7", maxHistoryChars: 120000, maxDigestChars: 3800, dailyUpdate: { enabled: true, hour: 4 } },
        },
      },
    },
    gateway: { port: 17697, bind: "127.0.0.1", auth: { mode: "token", token: "" } },
    skills: { entries: { "asuka-selfie": { enabled: true, env: { STUDIO_API_KEY: "", STUDIO_AUTH_PROFILE: "", STUDIO_API_BASE_URL: "https://api.minimaxi.com/v1", STUDIO_IMAGE_MODEL: "image-01", STUDIO_IMAGE_QUALITY: "standard" } } } },
    plugins: { entries: { qqbot: { enabled: true } } },
  };
  return deepMerge(template, current);
}

function deepMerge(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay)) return clone(overlay ?? base);
  if (!base || typeof base !== "object" || !overlay || typeof overlay !== "object") return clone(overlay ?? base);
  const next = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = deepMerge(next[key], value);
  }
  return next;
}

export function getStatus(config, configPath = DEFAULT_CONFIG_PATH) {
  const providers = Object.entries(config.models?.providers || {}).map(([id, provider]) => ({
    id,
    configured: Boolean(provider?.apiKey && provider?.baseUrl),
    modelCount: Array.isArray(provider?.models) ? provider.models.length : 0,
    baseUrl: provider?.baseUrl || "",
  }));
  const qqbot = config.channels?.qqbot || {};
  return {
    configPath,
    projectRoot: PROJECT_ROOT,
    host: "127.0.0.1",
    gateway: {
      configured: Boolean(config.gateway),
      bind: config.gateway?.bind || "",
      port: config.gateway?.port || "",
      tokenConfigured: Boolean(config.gateway?.auth?.token),
    },
    qqbot: {
      enabled: qqbot.enabled !== false,
      appIdConfigured: Boolean(qqbot.appId),
      clientSecretConfigured: Boolean(qqbot.clientSecret || qqbot.clientSecretFile),
    },
    providers,
    skills: Object.entries(config.skills?.entries || {}).map(([id, skill]) => ({
      id,
      enabled: skill?.enabled !== false,
      apiKeyConfigured: Boolean(skill?.apiKey || skill?.env?.STUDIO_API_KEY || skill?.env?.STUDIO_AUTH_PROFILE),
    })),
  };
}

export function listWorkspaceDocs(options = {}) {
  const workspaceDir = options.workspaceDir || DEFAULT_WORKSPACE_DIR;
  return [...WORKSPACE_DOCS].map((name) => {
    const filePath = path.join(workspaceDir, name);
    return {
      name,
      path: filePath,
      exists: fs.existsSync(filePath),
      content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "",
    };
  });
}

export function saveWorkspaceDoc(name, content, options = {}) {
  if (!WORKSPACE_DOCS.has(name)) throw new Error("不允许编辑这个文件。");
  const workspaceDir = options.workspaceDir || DEFAULT_WORKSPACE_DIR;
  const filePath = path.join(workspaceDir, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(workspaceDir) + path.sep)) throw new Error("文件路径越界。");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak.settings-ui-${stamp}`);
  }
  fs.writeFileSync(filePath, String(content ?? ""), "utf8");
  return { name, path: filePath, savedAt: new Date().toISOString() };
}

export function createTempConfigFixture(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-ui-"));
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { dir, configPath };
}
