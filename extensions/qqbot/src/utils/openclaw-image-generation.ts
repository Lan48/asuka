import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const IMAGE_RUNTIME_MODULE_RELATIVE = path.join("dist", "plugin-sdk", "image-generation-runtime.js");
let cachedRuntimeModule: Promise<GenerateImageRuntimeModule | null> | undefined;

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

function buildPrompt(options: OfficialOpenClawImageOptions): string {
  return [options.identityPrompt, options.prompt].filter(Boolean).join("\n");
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

async function loadRuntimeModule(): Promise<GenerateImageRuntimeModule | null> {
  if (!cachedRuntimeModule) {
    cachedRuntimeModule = (async () => {
      for (const candidate of candidateRuntimeModulePaths()) {
        if (!fs.existsSync(candidate)) continue;
        try {
          const mod = await dynamicImport(pathToFileURL(candidate).href);
          if (typeof mod?.generateImage === "function") return mod as GenerateImageRuntimeModule;
        } catch {
          // Keep trying the next known OpenClaw installation.
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

async function generateWithRuntime(options: OfficialOpenClawImageOptions, modelRef: string): Promise<string> {
  const runtime = await loadRuntimeModule();
  if (!runtime) throw new Error("OpenClaw image generation runtime is not available");
  const imageBytes = fs.readFileSync(options.referenceImagePath);
  const result = await runtime.generateImage({
    cfg: buildEffectiveConfig(options.cfg, modelRef),
    prompt: buildPrompt(options),
    agentDir: resolveOpenClawAgentDir(),
    modelOverride: options.modelOverride || modelRef,
    count: 1,
    size: normalizeSize(options.size),
    quality: normalizeOpenClawQuality(options.quality),
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

  const modelRef = options.modelOverride?.trim() || resolveOpenClawImageGenerationModelRef(options.cfg) || DEFAULT_OPENCLAW_IMAGE_MODEL;
  try {
    return await generateWithRuntime(options, modelRef);
  } catch (error) {
    const runtimeMessage = error instanceof Error ? error.message : String(error);
    try {
      return await generateWithCli(options, modelRef);
    } catch (cliError) {
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      throw new Error(`OpenClaw official image generation failed: runtime=${runtimeMessage}; cli=${cliMessage}`);
    }
  }
}
