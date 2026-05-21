/**
 * Studio Media image edit to OpenClaw integration.
 *
 * Edits Asuka's bundled selfie reference with a Studio OpenAI-compatible
 * image API and sends the result through OpenClaw.
 */

import { execFile } from "child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_REFERENCE_IMAGE =
  "https://cdn.jsdelivr.net/gh/SumeLabs/asuka@main/assets/asuka.png";
const DEFAULT_STUDIO_BASE_URL = "https://api.awnjkankwik.asia/studio/v1";
const DEFAULT_MODEL = "third_party_media:gemini-3-pro-image-preview";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "standard";
const SELFIE_IDENTITY_LOCK_PROMPT = [
  "必须严格以提供的单张参考图 identity.jpg 作为唯一人物身份锚点。",
  "优先保持参考图里的脸型、五官比例、眼睛形状、鼻梁、嘴唇、肤色、发色发量、发际线、年龄感和整体气质。",
  "可以改变场景、构图、姿势、服装和光线，但不要换脸、不要欧美化、不要网红化、不要二次元化、不要改变种族或年龄。",
  "身份和外貌一致性优先级高于场景创意；生成结果应像同一个人在当前语境里的真实自拍或近照。",
].join(" ");

interface StudioMediaItem {
  url?: string;
  b64_json?: string;
}

interface StudioImageResponse {
  id?: string;
  data?: StudioMediaItem[];
  result_urls?: string[];
  error?: {
    code?: string;
    type?: string;
    message?: string;
  };
}

interface OpenClawMessage {
  action: "send";
  channel: string;
  message: string;
  media?: string;
}

interface GenerateAndSendOptions {
  prompt: string;
  channel: string;
  caption?: string;
  size?: string;
  useOpenClawCLI?: boolean;
  referenceImageUrl?: string;
  referenceImagePath?: string;
  extraReferenceImageUrls?: string[];
  extraReferenceImagePaths?: string[];
}

interface Result {
  success: boolean;
  imageUrl: string;
  channel: string;
  prompt: string;
  requestId?: string;
  size?: string;
}

function getBundledReferenceImagePath(): string | null {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const identityCandidates = [
    process.env.ASUKA_REFERENCE_IMAGE_PATH,
    process.env.OPENCLAW_STATE_DIR ? path.resolve(process.env.OPENCLAW_STATE_DIR, "identity.jpg") : undefined,
    configPath ? path.resolve(path.dirname(configPath), "identity.jpg") : undefined,
    path.resolve(process.cwd(), "identity.jpg"),
    path.resolve(__dirname, "../../../../identity.jpg"),
    path.resolve(__dirname, "../../../identity.jpg"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of identityCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const candidates = [
    path.resolve(__dirname, "../assets/1.jpg"),
    path.resolve(__dirname, "../assets/1.jpeg"),
    path.resolve(__dirname, "../assets/1.png"),
    path.resolve(__dirname, "../assets/1.webp"),
    path.resolve(__dirname, "../../assets/1.jpg"),
    path.resolve(__dirname, "../../assets/1.jpeg"),
    path.resolve(__dirname, "../../assets/1.png"),
    path.resolve(__dirname, "../../assets/1.webp"),
    path.resolve(__dirname, "../assets/asuka.png"),
    path.resolve(__dirname, "../../assets/asuka.png"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildStudioSelfiePrompt(prompt: string): string {
  return [SELFIE_IDENTITY_LOCK_PROMPT, prompt].filter(Boolean).join("\n");
}

function getBundledExtraReferenceImagePaths(): string[] {
  const roots = [
    path.resolve(__dirname, "../assets"),
    path.resolve(__dirname, "../../assets"),
  ];
  const extensions = ["jpg", "jpeg", "png", "webp"];
  const results: string[] = [];

  for (const index of [2, 3, 4]) {
    let matched: string | null = null;
    for (const root of roots) {
      for (const ext of extensions) {
        const candidate = path.join(root, `${index}.${ext}`);
        if (existsSync(candidate)) {
          matched = candidate;
          break;
        }
      }
      if (matched) {
        break;
      }
    }

    if (matched) {
      results.push(matched);
    }
  }

  return results;
}

function normalizeList(input?: string | string[]): string[] {
  if (!input) {
    return [];
  }

  const values = Array.isArray(input) ? input : input.split(",");
  return values.map((value) => value.trim()).filter(Boolean);
}

function getPrimaryReferenceImageInput(opts?: {
  referenceImageUrl?: string;
  referenceImagePath?: string;
}): string {
  const explicitPath =
    opts?.referenceImagePath || process.env.ASUKA_REFERENCE_IMAGE_PATH;
  const localPath = explicitPath || getBundledReferenceImagePath();

  if (localPath && existsSync(localPath)) {
    return localPath;
  }

  return (
    opts?.referenceImageUrl ||
    process.env.ASUKA_REFERENCE_IMAGE_URL ||
    DEFAULT_REFERENCE_IMAGE
  );
}

function getReferenceImageInputs(opts?: {
  referenceImageUrl?: string;
  referenceImagePath?: string;
  extraReferenceImageUrls?: string[];
  extraReferenceImagePaths?: string[];
}): string[] {
  const references: string[] = [
    getPrimaryReferenceImageInput({
      referenceImageUrl: opts?.referenceImageUrl,
      referenceImagePath: opts?.referenceImagePath,
    }),
  ];

  const extraPaths = [
    ...getBundledExtraReferenceImagePaths(),
    ...normalizeList(process.env.ASUKA_EXTRA_REFERENCE_IMAGE_PATHS),
    ...(opts?.extraReferenceImagePaths || []),
  ];

  for (const extraPath of extraPaths) {
    if (!existsSync(extraPath)) {
      console.warn(
        `[WARN] Extra reference image path not found, skipping: ${extraPath}`
      );
      continue;
    }

    references.push(extraPath);
  }

  const extraUrls = [
    ...normalizeList(process.env.ASUKA_EXTRA_REFERENCE_IMAGE_URLS),
    ...(opts?.extraReferenceImageUrls || []),
  ];

  references.push(...extraUrls);

  const deduped = Array.from(new Set(references));
  const limited = deduped.slice(0, 4);

  if (deduped.length > limited.length) {
    console.warn(
      `[WARN] Studio image edit currently uses the first 4 reference candidates only, truncating ${deduped.length} inputs to 4`
    );
  }

  return limited;
}

function getStudioBaseUrl(): string {
  return (process.env.STUDIO_API_BASE_URL || DEFAULT_STUDIO_BASE_URL).replace(/\/+$/, "");
}

function getStudioApiKey(): string {
  return process.env.STUDIO_API_KEY || process.env.DASHSCOPE_API_KEY || "";
}

function getStudioAuthProfile(): string {
  return process.env.STUDIO_AUTH_PROFILE || process.env.OPENCLAW_AUTH_PROFILE || "";
}

function resolveAuthProfilesPath(): string {
  if (process.env.OPENCLAW_AUTH_PROFILES_PATH) return path.resolve(process.env.OPENCLAW_AUTH_PROFILES_PATH);
  if (process.env.OPENCLAW_AGENT_DIR) return path.resolve(process.env.OPENCLAW_AGENT_DIR, "auth-profiles.json");
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const agentId = process.env.OPENCLAW_AGENT_ID || "main";
  return path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json");
}

function getAccountId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const auth = JSON.parse(decoded)?.["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

async function refreshOpenAICodexProfile(credential: Record<string, any>): Promise<Record<string, any>> {
  if (!credential.refresh) throw new Error("OAuth profile is missing refresh token");
  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(credential.refresh),
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Codex OAuth refresh failed: HTTP ${response.status}`);
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI Codex OAuth refresh response missing token fields");
  }
  return {
    ...credential,
    type: "oauth",
    provider: "openai-codex",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: getAccountId(json.access_token) || credential.accountId,
  };
}

async function resolveStudioBearerToken(): Promise<string> {
  const authProfile = getStudioAuthProfile().trim();
  if (!authProfile) return getStudioApiKey();

  const authProfilesPath = resolveAuthProfilesPath();
  if (!existsSync(authProfilesPath)) throw new Error(`OAuth profile store not found: ${authProfilesPath}`);
  const store = JSON.parse(readFileSync(authProfilesPath, "utf8"));
  const credential = store?.profiles?.[authProfile];
  if (!credential) throw new Error(`OAuth profile not found: ${authProfile}`);
  if (credential.type !== "oauth") throw new Error(`Auth profile ${authProfile} is not OAuth`);
  if (!credential.access) throw new Error(`OAuth profile ${authProfile} is missing access token`);

  if (typeof credential.expires === "number" && credential.expires > Date.now() + 60_000) {
    return credential.access;
  }
  if (credential.provider !== "openai-codex") {
    throw new Error(`OAuth refresh is not supported for provider ${credential.provider || "(missing)"}`);
  }

  const refreshed = await refreshOpenAICodexProfile(credential);
  store.profiles[authProfile] = refreshed;
  const tmpPath = `${authProfilesPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmpPath, authProfilesPath);
  try {
    chmodSync(authProfilesPath, 0o600);
  } catch {
    // Best effort on Windows filesystems.
  }
  return refreshed.access;
}

function getModelId(): string {
  return process.env.STUDIO_IMAGE_EDIT_MODEL
    || process.env.STUDIO_IMAGE_MODEL
    || process.env.STUDIO_MODEL
    || process.env.DASHSCOPE_MODEL
    || DEFAULT_MODEL;
}

function getQuality(): string {
  return process.env.STUDIO_IMAGE_QUALITY || DEFAULT_QUALITY;
}

function normalizeStudioSize(size?: string): string {
  const raw = (size || DEFAULT_SIZE).trim();
  if (/^1k$/i.test(raw)) return "1024x1024";
  if (/^2k$/i.test(raw)) return "2048x2048";
  return raw;
}

function getMimeType(input: string): string {
  const ext = path.extname(input.split("?")[0] || "").toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".png":
    default:
      return "image/png";
  }
}

function dataUrlToImagePart(dataUrl: string): { blob: Blob; filename: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL reference image");
  }
  const mimeType = match[1] || "image/png";
  const extension = mimeType.split("/")[1] || "png";
  const buffer = Buffer.from(match[2] || "", "base64");
  return {
    blob: new Blob([buffer], { type: mimeType }),
    filename: `reference.${extension}`,
  };
}

async function resolveImagePart(input: string): Promise<{ blob: Blob; filename: string }> {
  if (input.startsWith("data:")) {
    return dataUrlToImagePart(input);
  }

  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch reference image: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || getMimeType(input);
    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = path.basename(new URL(input).pathname) || "reference.png";
    return {
      blob: new Blob([buffer], { type: contentType }),
      filename,
    };
  }

  if (!existsSync(input)) {
    throw new Error(`Reference image file does not exist: ${input}`);
  }

  return {
    blob: new Blob([readFileSync(input)], { type: getMimeType(input) }),
    filename: path.basename(input),
  };
}

function extractImageUrl(response: StudioImageResponse): string {
  for (const item of response.data || []) {
    if (item?.url) return item.url;
    if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  }

  for (const url of response.result_urls || []) {
    if (url) return url;
  }

  throw new Error(
    `Failed to extract image URL from Studio response: ${JSON.stringify(response)}`
  );
}

async function parseStudioResponse(response: Awaited<ReturnType<typeof fetch>>): Promise<StudioImageResponse> {
  let data: StudioImageResponse;
  try {
    data = (await response.json()) as StudioImageResponse;
  } catch (error) {
    const body = await response.text().catch(() => "");
    throw new Error(`Studio image edit failed: HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  if (!response.ok) {
    const error = data.error;
    const code = error?.code || error?.type || "api_error";
    const message = error?.message || JSON.stringify(data);
    throw new Error(`Studio image edit failed: HTTP ${response.status} ${code}: ${message}`);
  }

  return data;
}

async function generateImageEdit(input: {
  prompt: string;
  size?: string;
  referenceImageUrl?: string;
  referenceImagePath?: string;
  extraReferenceImageUrls?: string[];
  extraReferenceImagePaths?: string[];
}): Promise<StudioImageResponse> {
  const apiKey = await resolveStudioBearerToken();

  if (!apiKey) {
    throw new Error(
      "STUDIO_API_KEY or STUDIO_AUTH_PROFILE environment variable not set. Configure your Studio media API key or OpenClaw OAuth profile first."
    );
  }

  const referenceImages = getReferenceImageInputs({
    referenceImageUrl: input.referenceImageUrl,
    referenceImagePath: input.referenceImagePath,
    extraReferenceImageUrls: input.extraReferenceImageUrls,
    extraReferenceImagePaths: input.extraReferenceImagePaths,
  });

  if (referenceImages.length > 1) {
    console.warn(
      `[WARN] Studio image edit API accepts a single multipart image; using primary reference and ignoring ${referenceImages.length - 1} extra reference(s)`
    );
  }

  const image = await resolveImagePart(referenceImages[0] || DEFAULT_REFERENCE_IMAGE);
  const form = new FormData();
  form.append("model", getModelId());
  form.append("prompt", buildStudioSelfiePrompt(input.prompt));
  form.append("size", normalizeStudioSize(input.size));
  form.append("n", "1");
  form.append("quality", getQuality());
  form.append("response_format", "url");
  form.append("image", image.blob, image.filename);

  const response = await fetch(`${getStudioBaseUrl()}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  return parseStudioResponse(response);
}

async function sendViaOpenClaw(
  message: OpenClawMessage,
  useCLI: boolean = true
): Promise<void> {
  if (useCLI) {
    const profile = process.env.OPENCLAW_PROFILE?.trim();
    const args = profile
      ? ["--profile", profile, "message", "send"]
      : ["message", "send"];

    if (message.channel.startsWith("qqbot:")) {
      args.push("--channel", "qqbot", "--target", message.channel);
    } else {
      args.push("--channel", message.channel);
    }

    args.push("--message", message.message);

    if (message.media) {
      args.push("--media", message.media);
    }

    await execFileAsync("openclaw", args);
    return;
  }

  const gatewayUrl =
    process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (gatewayToken) {
    headers.Authorization = `Bearer ${gatewayToken}`;
  }

  const response = await fetch(`${gatewayUrl}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenClaw send failed: ${error}`);
  }
}

async function generateAndSend(options: GenerateAndSendOptions): Promise<Result> {
  const {
    prompt,
    channel,
    caption = "Asuka 自拍来啦",
    size = DEFAULT_SIZE,
    useOpenClawCLI = true,
    referenceImageUrl,
    referenceImagePath,
    extraReferenceImageUrls,
    extraReferenceImagePaths,
  } = options;

  console.log("[INFO] Editing Asuka reference image with Studio media API...");
  console.log(`[INFO] Prompt: ${prompt}`);
  console.log(`[INFO] Model: ${getModelId()}`);
  console.log(`[INFO] Size: ${normalizeStudioSize(size)}`);

  const imageResult = await generateImageEdit({
    prompt,
    size,
    referenceImageUrl,
    referenceImagePath,
    extraReferenceImageUrls,
    extraReferenceImagePaths,
  });

  const imageUrl = extractImageUrl(imageResult);
  console.log(`[INFO] Image generated: ${imageUrl}`);

  await sendViaOpenClaw(
    {
      action: "send",
      channel,
      message: caption,
      media: imageUrl,
    },
    useOpenClawCLI
  );

  console.log(`[INFO] Done! Image sent to ${channel}`);

  return {
    success: true,
    imageUrl,
    channel,
    prompt,
    requestId: imageResult.id,
    size: normalizeStudioSize(size),
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
Usage: npx ts-node asuka-selfie.ts <prompt> <channel> [caption] [size]

Arguments:
  prompt   - Edit prompt for Asuka's reference image
  channel  - Target channel (e.g. qqbot:c2c:<id>, #general, @user)
  caption  - Optional message caption
  size     - Output size (default: 1024x1024; legacy 1K maps to 1024x1024)

Environment:
  STUDIO_API_KEY       - Studio media API key
  STUDIO_AUTH_PROFILE  - Optional OpenClaw OAuth profile id, for example openai-codex:zhueshun@gmail.com
  STUDIO_API_BASE_URL  - Optional base URL, default ${DEFAULT_STUDIO_BASE_URL}
  STUDIO_IMAGE_MODEL   - Optional image edit model override, default ${DEFAULT_MODEL}
  STUDIO_IMAGE_QUALITY - Optional quality, default ${DEFAULT_QUALITY}
  OPENCLAW_PROFILE   - Optional OpenClaw profile used for CLI sends
  ASUKA_EXTRA_REFERENCE_IMAGE_PATHS - Optional comma-separated extra local reference image paths
  ASUKA_EXTRA_REFERENCE_IMAGE_URLS  - Optional comma-separated extra reference image URLs

Example:
  STUDIO_API_KEY=sk-xxx OPENCLAW_PROFILE=asuka \\
    npx ts-node asuka-selfie.ts "给她加一顶牛仔帽，镜子自拍，真实自然" "qqbot:c2c:12345"
`);
    process.exit(1);
  }

  const [prompt, channel, caption, size] = args;

  try {
    const result = await generateAndSend({
      prompt,
      channel,
      caption,
      size,
    });
    console.log("\n--- Result ---");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { generateImageEdit, sendViaOpenClaw, generateAndSend };
