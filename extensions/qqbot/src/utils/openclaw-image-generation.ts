import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getQQBotLocalOpenClawEnv } from "../config.js";
import { execOpenClaw } from "./openclaw-command.js";

type OpenClawConfigLike = Record<string, any>;

type GenerateImageRuntimeModule = {
  generateImage: (params: Record<string, any>) => Promise<{
    images: Array<{
      buffer: Buffer | Uint8Array;
      mimeType?: string;
      fileName?: string;
    }>;
    provider?: string;
    model?: string;
  }>;
};

export type OfficialOpenClawImageOptions = {
  cfg: OpenClawConfigLike;
  prompt: string;
  referenceImagePath: string;
  size?: string;
  quality?: string;
  modelOverride?: string;
  identityPrompt?: string;
};

const DEFAULT_OPENCLAW_IMAGE_MODEL = "openai-codex/chatgpt-image-latest";
const DEFAULT_OPENCLAW_IMAGE_SIZE = "1024x1024";
const DEFAULT_OPENCLAW_OUTPUT_FORMAT = "png";
const OPENCLAW_IMAGE_RUNTIME_UNAVAILABLE_MESSAGE = "OpenClaw image generation runtime is not available";
const IMAGE_RUNTIME_MODULE_RELATIVE = path.join("dist", "plugin-sdk", "image-generation-runtime.js");
const DEFAULT_OFFICIAL_IMAGE_RUNTIME_TIMEOUT_MS = 240_000;
const OFFICIAL_IMAGE_CIRCUIT_FAILURE_THRESHOLD = Number(process.env.QQBOT_OFFICIAL_IMAGE_CIRCUIT_FAILURE_THRESHOLD || 1);
const OFFICIAL_IMAGE_CIRCUIT_COOLDOWN_MS = Number(process.env.QQBOT_OFFICIAL_IMAGE_CIRCUIT_COOLDOWN_MS || 30 * 60 * 1000);
const OFFICIAL_IMAGE_LOG_PREFIX = "[qqbot] [official-image]";
const MAX_CHILD_LOG_CHARS = 6_000;
let cachedRuntimeModule: Promise<GenerateImageRuntimeModule | null> | undefined;
let officialImageCircuitState: {
  consecutiveTimeouts: number;
  openUntilMs: number;
  lastReason: string;
} = {
  consecutiveTimeouts: 0,
  openUntilMs: 0,
  lastReason: "",
};

function dynamicImport(specifier: string): Promise<any> {
  return new Function("specifier", "return import(specifier)")(specifier);
}

function getString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function resolveModelPrimary(modelConfig: unknown): string {
  if (typeof modelConfig === "string") return modelConfig.trim();
  if (modelConfig && typeof modelConfig === "object") {
    const primary = (modelConfig as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary.trim() : "";
  }
  return "";
}

export function resolveOpenClawImageGenerationModelRef(cfg: OpenClawConfigLike): string {
  const defaults = cfg?.agents?.defaults || {};
  const configured = resolveModelPrimary(defaults.imageGenerationModel);
  if (configured) return configured;

  const skillEnv = cfg?.skills?.entries?.["asuka-selfie"]?.env || {};
  const authProfile = getString(skillEnv.STUDIO_AUTH_PROFILE, skillEnv.OPENCLAW_AUTH_PROFILE);
  const baseUrl = getString(skillEnv.STUDIO_API_BASE_URL, skillEnv.STUDIO_BASE_URL);
  const model = getString(
    skillEnv.OPENCLAW_IMAGE_GENERATION_MODEL,
    skillEnv.STUDIO_IMAGE_EDIT_MODEL,
    skillEnv.STUDIO_IMAGE_MODEL,
    "chatgpt-image-latest",
  );

  if (/^openai-codex:/i.test(authProfile) || /^https:\/\/api\.openai\.com\/v1\/?$/i.test(baseUrl)) {
    return `openai-codex/${model.replace(/^[^/]+\//, "")}`;
  }

  return "";
}

export function hasOfficialOpenClawImageGenerationConfig(cfg: OpenClawConfigLike): boolean {
  return Boolean(resolveOpenClawImageGenerationModelRef(cfg));
}

function buildEffectiveConfig(cfg: OpenClawConfigLike, modelRef: string): OpenClawConfigLike {
  const next = {
    ...cfg,
    agents: {
      ...(cfg?.agents || {}),
      defaults: {
        ...(cfg?.agents?.defaults || {}),
        imageGenerationModel: cfg?.agents?.defaults?.imageGenerationModel || { primary: modelRef },
      },
    },
  };
  return next;
}

function resolveOpenClawAgentDir(): string | undefined {
  const explicit = process.env.OPENCLAW_AGENT_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return path.resolve(stateDir, "agents", process.env.OPENCLAW_AGENT_ID?.trim() || "main", "agent");
  return undefined;
}

function getImageMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function toDataUrl(buffer: Buffer | Uint8Array, mimeType = "image/png"): string {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}

function normalizeOpenClawQuality(quality?: string): "low" | "medium" | "high" | "auto" | undefined {
  const normalized = quality?.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "auto") return normalized;
  return undefined;
}

function normalizeSize(size?: string): string {
  const raw = (size || DEFAULT_OPENCLAW_IMAGE_SIZE).trim();
  if (/^1k$/i.test(raw)) return "1024x1024";
  if (/^2k$/i.test(raw)) return "2048x2048";
  return raw;
}

function getFinitePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function resolveOfficialImageRuntimeTimeoutMs(cfg?: OpenClawConfigLike): number {
  return Math.floor(
    getFinitePositiveNumber(process.env.QQBOT_OFFICIAL_IMAGE_RUNTIME_TIMEOUT_MS)
    ?? getFinitePositiveNumber(cfg?.agents?.defaults?.imageGenerationModel?.timeoutMs)
    ?? DEFAULT_OFFICIAL_IMAGE_RUNTIME_TIMEOUT_MS,
  );
}

function buildPrompt(options: OfficialOpenClawImageOptions): string {
  return [options.identityPrompt, options.prompt].filter(Boolean).join("\n");
}

function getEnvProxyValue(): string {
  return getString(process.env.HTTPS_PROXY, process.env.https_proxy, process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy);
}

function describeProxyForLog(proxy: string): string {
  if (!proxy) return "none";
  try {
    const parsed = new URL(proxy);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return proxy.replace(/\/\/[^@\s]+@/, "//***@");
  }
}

function resolveOfficialImageRequestDiagnostics(cfg: OpenClawConfigLike): {
  provider: string;
  api: string;
  baseUrl: string;
  proxyMode: string;
  proxy: string;
  targetHost: string;
} {
  const providerConfig = cfg?.models?.providers?.["openai-codex"] || {};
  const baseUrl = getString(providerConfig.baseUrl, "https://chatgpt.com/backend-api/codex");
  let targetHost = "";
  try {
    targetHost = new URL(baseUrl).hostname;
  } catch {
    targetHost = baseUrl;
  }
  return {
    provider: "openai-codex",
    api: getString(providerConfig.api, "openai-codex-responses"),
    baseUrl,
    proxyMode: getString(providerConfig.request?.proxy?.mode, "unset"),
    proxy: describeProxyForLog(getEnvProxyValue()),
    targetHost,
  };
}

function classifyOfficialImageFailure(message: string): string {
  const normalized = message.toLowerCase();
  if (/usage[_ -]?limit|429/.test(normalized)) return "usage_limit";
  if (/safety|policy|rejected|sexual/.test(normalized)) return "safety_rejected";
  if (/proxy|econnrefused|127\.0\.0\.1:7897|connect refused/.test(normalized)) return "proxy_unreachable";
  if (/connection reset|econnreset|socket hang up|direct_reset/.test(normalized)) return "direct_reset";
  if (/terminated|other side closed|premature close|closed/i.test(message)) return "upstream_terminated";
  if (/timed?\s*out|timeout|aborted|abort/i.test(message)) return "official_timeout";
  return "unknown";
}

function shouldOpenOfficialImageCircuit(message: string): boolean {
  const classification = classifyOfficialImageFailure(message);
  return classification === "official_timeout" || classification === "upstream_terminated" || classification === "usage_limit";
}

function assertOfficialImageCircuitClosed(): void {
  const now = Date.now();
  if (officialImageCircuitState.openUntilMs <= now) return;
  const remainingMs = Math.max(0, officialImageCircuitState.openUntilMs - now);
  throw new Error(`official image circuit open after repeated timeouts; retryAfterMs=${remainingMs}; lastReason=${officialImageCircuitState.lastReason}`);
}

function recordOfficialImageSuccess(): void {
  officialImageCircuitState = {
    consecutiveTimeouts: 0,
    openUntilMs: 0,
    lastReason: "",
  };
}

function recordOfficialImageFailure(message: string): void {
  if (!shouldOpenOfficialImageCircuit(message)) {
    officialImageCircuitState = {
      consecutiveTimeouts: 0,
      openUntilMs: 0,
      lastReason: "",
    };
    return;
  }

  const consecutiveTimeouts = officialImageCircuitState.consecutiveTimeouts + 1;
  officialImageCircuitState = {
    consecutiveTimeouts,
    openUntilMs: consecutiveTimeouts >= OFFICIAL_IMAGE_CIRCUIT_FAILURE_THRESHOLD
      ? Date.now() + OFFICIAL_IMAGE_CIRCUIT_COOLDOWN_MS
      : officialImageCircuitState.openUntilMs,
    lastReason: message.slice(0, 240),
  };
}

async function withOfficialImageTimeout<T>(operationFactory: (signal: AbortSignal) => Promise<T>, label: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const operation = operationFactory(controller.signal);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    operation.catch(() => undefined);
  }
}

function candidateRuntimeModulePaths(): string[] {
  const candidates = [
    process.env.OPENCLAW_IMAGE_RUNTIME_MODULE?.trim(),
  ].filter((item): item is string => Boolean(item));

  const execDir = path.dirname(process.execPath);
  candidates.push(path.resolve(execDir, "..", "lib", "node_modules", "openclaw", IMAGE_RUNTIME_MODULE_RELATIVE));

  const configuredStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  const stateDirs = [
    configuredStateDir,
    path.join(os.homedir(), ".openclaw"),
  ].filter((item): item is string => Boolean(item));

  for (const stateDir of stateDirs) {
    candidates.push(path.join(stateDir, "tools", "node-v22.22.0", "lib", "node_modules", "openclaw", IMAGE_RUNTIME_MODULE_RELATIVE));
    candidates.push(path.join(stateDir, "lib", "node_modules", "openclaw", IMAGE_RUNTIME_MODULE_RELATIVE));
    candidates.push(path.join(stateDir, "..", "tools", "node_modules", "openclaw", IMAGE_RUNTIME_MODULE_RELATIVE));
    candidates.push(path.join(stateDir, "..", "..", "tools", "node_modules", "openclaw", IMAGE_RUNTIME_MODULE_RELATIVE));
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveRuntimeModulePath(): string | null {
  return candidateRuntimeModulePaths().find((candidate) => fs.existsSync(candidate)) || null;
}

async function loadRuntimeModule(): Promise<GenerateImageRuntimeModule | null> {
  if (!cachedRuntimeModule) {
    cachedRuntimeModule = (async () => {
      const runtimePath = resolveRuntimeModulePath();
      if (runtimePath) {
        try {
          const mod = await dynamicImport(pathToFileURL(runtimePath).href);
          if (typeof mod?.generateImage === "function") return mod as GenerateImageRuntimeModule;
        } catch {
          // Fall through to package resolution.
        }
      }

      try {
        const mod = await dynamicImport("openclaw/dist/plugin-sdk/image-generation-runtime.js");
        if (typeof mod?.generateImage === "function") return mod as GenerateImageRuntimeModule;
      } catch {
        // No compatible runtime found through package resolution either.
      }
      return null;
    })();
  }
  return cachedRuntimeModule;
}

function appendLimitedLog(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_CHILD_LOG_CHARS) return next;
  return next.slice(next.length - MAX_CHILD_LOG_CHARS);
}

function buildRuntimeChildScript(): string {
  return `
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

function toDataUrl(buffer, mimeType = "image/png") {
  return \`data:\${mimeType};base64,\${Buffer.from(buffer).toString("base64")}\`;
}

const [requestPath, resultPath] = process.argv.slice(2);
try {
  const request = JSON.parse(fs.readFileSync(requestPath, "utf-8"));
  const runtime = await import(pathToFileURL(request.runtimeModulePath).href);
  if (typeof runtime.generateImage !== "function") {
    throw new Error("OpenClaw image generation runtime does not export generateImage");
  }
  const imageBytes = fs.readFileSync(request.referenceImagePath);
  const result = await runtime.generateImage({
    cfg: request.cfg,
    prompt: request.prompt,
    agentDir: request.agentDir,
    modelOverride: request.modelOverride,
    count: 1,
    size: request.size,
    quality: request.quality,
    timeoutMs: request.timeoutMs,
    outputFormat: request.outputFormat,
    inputImages: [{
      buffer: imageBytes,
      mimeType: request.mimeType,
      fileName: request.fileName,
    }],
    autoProviderFallback: true,
  });
  const image = result.images?.[0];
  if (!image?.buffer) throw new Error("OpenClaw image generation returned no image");
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true,
    dataUrl: toDataUrl(image.buffer, image.mimeType || "image/png"),
    provider: result.provider,
    model: result.model,
  }));
} catch (error) {
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : "",
  }));
  process.exitCode = 1;
}
`;
}

async function generateWithRuntimeChildProcess(options: OfficialOpenClawImageOptions, modelRef: string, timeoutMs: number): Promise<string> {
  const runtimeModulePath = resolveRuntimeModulePath();
  if (!runtimeModulePath) throw new Error(OPENCLAW_IMAGE_RUNTIME_UNAVAILABLE_MESSAGE);

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asuka-openclaw-runtime-"));
  const requestPath = path.join(tempDir, "request.json");
  const resultPath = path.join(tempDir, "result.json");
  const scriptPath = path.join(tempDir, "runtime-child.mjs");
  let childStdout = "";
  let childStderr = "";

  try {
    await fs.promises.writeFile(scriptPath, buildRuntimeChildScript(), "utf-8");
    await fs.promises.writeFile(requestPath, JSON.stringify({
      runtimeModulePath,
      cfg: buildEffectiveConfig(options.cfg, modelRef),
      prompt: buildPrompt(options),
      agentDir: resolveOpenClawAgentDir(),
      modelOverride: options.modelOverride || modelRef,
      size: normalizeSize(options.size),
      quality: normalizeOpenClawQuality(options.quality),
      timeoutMs,
      outputFormat: DEFAULT_OPENCLAW_OUTPUT_FORMAT,
      referenceImagePath: options.referenceImagePath,
      mimeType: getImageMimeType(options.referenceImagePath),
      fileName: path.basename(options.referenceImagePath),
    }), "utf-8");

    console.log(`${OFFICIAL_IMAGE_LOG_PREFIX} runtime child start module=${runtimeModulePath} timeoutMs=${timeoutMs}`);
    const child = spawn(process.execPath, [scriptPath, requestPath, resultPath], {
      env: getQQBotLocalOpenClawEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk) => {
      childStdout = appendLimitedLog(childStdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      childStderr = appendLimitedLog(childStderr, chunk);
    });

    let timedOut = false;
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
        reject(new Error(`OpenClaw official image runtime child timed out after ${timeoutMs}ms and was killed`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    }).catch((error) => {
      if (timedOut) {
        console.warn(`${OFFICIAL_IMAGE_LOG_PREFIX} runtime child killed after timeout stdout=${childStdout.slice(-1000)} stderr=${childStderr.slice(-1000)}`);
      }
      throw error;
    });

    const resultRaw = fs.existsSync(resultPath) ? await fs.promises.readFile(resultPath, "utf-8") : "";
    let parsed: any = null;
    if (resultRaw) {
      try {
        parsed = JSON.parse(resultRaw);
      } catch {
        // Include the raw text below.
      }
    }
    if (exit.code !== 0 || parsed?.ok === false) {
      const message = parsed?.message || `OpenClaw image runtime child exited code=${exit.code} signal=${exit.signal}`;
      throw new Error(`${message}; stdout=${childStdout.slice(-1000)}; stderr=${childStderr.slice(-1000)}`);
    }
    if (!parsed?.dataUrl) throw new Error(`OpenClaw image runtime child returned no image; stdout=${childStdout.slice(-1000)}; stderr=${childStderr.slice(-1000)}; result=${resultRaw.slice(0, 1000)}`);
    console.log(`${OFFICIAL_IMAGE_LOG_PREFIX} runtime child success provider=${parsed.provider || "unknown"} model=${parsed.model || modelRef}`);
    return parsed.dataUrl;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function generateWithRuntime(options: OfficialOpenClawImageOptions, modelRef: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const runtime = await loadRuntimeModule();
  if (!runtime) throw new Error(OPENCLAW_IMAGE_RUNTIME_UNAVAILABLE_MESSAGE);
  const imageBytes = fs.readFileSync(options.referenceImagePath);
  const result = await runtime.generateImage({
    cfg: buildEffectiveConfig(options.cfg, modelRef),
    prompt: buildPrompt(options),
    agentDir: resolveOpenClawAgentDir(),
    modelOverride: options.modelOverride || modelRef,
    count: 1,
    size: normalizeSize(options.size),
    quality: normalizeOpenClawQuality(options.quality),
    timeoutMs,
    signal,
    outputFormat: DEFAULT_OPENCLAW_OUTPUT_FORMAT,
    inputImages: [{
      buffer: imageBytes,
      mimeType: getImageMimeType(options.referenceImagePath),
      fileName: path.basename(options.referenceImagePath),
    }],
    autoProviderFallback: true,
  });
  const image = result.images?.[0];
  if (!image?.buffer) throw new Error("OpenClaw image generation returned no image");
  return toDataUrl(image.buffer, image.mimeType || "image/png");
}

async function generateWithCli(options: OfficialOpenClawImageOptions, modelRef: string): Promise<string> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "asuka-openclaw-image-"));
  const outputPath = path.join(tempDir, `selfie.${DEFAULT_OPENCLAW_OUTPUT_FORMAT}`);
  try {
    const args = [
      "capability",
      "image",
      "edit",
      "--file",
      options.referenceImagePath,
      "--prompt",
      buildPrompt(options),
      "--size",
      normalizeSize(options.size),
      "--output-format",
      DEFAULT_OPENCLAW_OUTPUT_FORMAT,
      "--output",
      outputPath,
      "--model",
      options.modelOverride || modelRef,
      "--json",
    ];
    await execOpenClaw(args, {
      env: getQQBotLocalOpenClawEnv(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 240_000,
    });
    const imageBytes = await fs.promises.readFile(outputPath);
    return toDataUrl(imageBytes, "image/png");
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateOfficialOpenClawImageDataUrl(options: OfficialOpenClawImageOptions): Promise<string> {
  if (!fs.existsSync(options.referenceImagePath)) {
    throw new Error(`reference image not found: ${options.referenceImagePath}`);
  }

  assertOfficialImageCircuitClosed();
  const modelRef = options.modelOverride?.trim() || resolveOpenClawImageGenerationModelRef(options.cfg) || DEFAULT_OPENCLAW_IMAGE_MODEL;
  const diagnostic = resolveOfficialImageRequestDiagnostics(options.cfg);
  const timeoutMs = resolveOfficialImageRuntimeTimeoutMs(options.cfg);
  const startedAt = Date.now();
  console.log(`${OFFICIAL_IMAGE_LOG_PREFIX} request start provider=${diagnostic.provider} api=${diagnostic.api} model=${modelRef} targetHost=${diagnostic.targetHost} proxyMode=${diagnostic.proxyMode} envProxy=${diagnostic.proxy} timeoutMs=${timeoutMs}`);
  try {
    const result = await generateWithRuntimeChildProcess(options, modelRef, timeoutMs);
    recordOfficialImageSuccess();
    console.log(`${OFFICIAL_IMAGE_LOG_PREFIX} request success provider=${diagnostic.provider} model=${modelRef} elapsedMs=${Date.now() - startedAt} bytes=${Buffer.byteLength(result)}`);
    return result;
  } catch (error) {
    const runtimeMessage = error instanceof Error ? error.message : String(error);
    const classification = classifyOfficialImageFailure(runtimeMessage);
    console.warn(`${OFFICIAL_IMAGE_LOG_PREFIX} request failed provider=${diagnostic.provider} model=${modelRef} class=${classification} elapsedMs=${Date.now() - startedAt} message=${runtimeMessage.slice(0, 500)}`);
    recordOfficialImageFailure(runtimeMessage);
    if (runtimeMessage !== OPENCLAW_IMAGE_RUNTIME_UNAVAILABLE_MESSAGE) {
      throw new Error(`OpenClaw official image generation failed: class=${classification}; runtime=${runtimeMessage}`);
    }
    try {
      const result = await generateWithCli(options, modelRef);
      recordOfficialImageSuccess();
      return result;
    } catch (cliError) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      recordOfficialImageFailure(cliMessage);
      throw new Error(`OpenClaw official image generation failed: runtime=${runtimeMessage}; cli=${cliMessage}`);
    }
  }
}
