/**
 * Wan 2.6 image edit to OpenClaw integration.
 *
 * Edits Asuka's bundled selfie reference set with Alibaba Cloud Bailian / DashScope
 * wan2.6-image and sends the result through OpenClaw.
 */

import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_REFERENCE_IMAGE =
  "https://cdn.jsdelivr.net/gh/SumeLabs/asuka@main/assets/asuka.png";
const DEFAULT_DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_MODEL = "wan2.6-image";

interface WanImageContent {
  type?: string;
  text?: string;
  image?: string;
}

interface WanImageResponse {
  request_id?: string;
  output?: {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        role?: string;
        content?: WanImageContent[];
      };
    }>;
    finished?: boolean;
  };
  usage?: {
    image_count?: number;
    size?: string;
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
    const base64 = readFileSync(localPath).toString("base64");
    return `data:image/png;base64,${base64}`;
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

    const base64 = readFileSync(extraPath).toString("base64");
    references.push(`data:image/png;base64,${base64}`);
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
      `[WARN] Wan image edit supports up to 4 reference images, truncating ${deduped.length} inputs to 4`
    );
  }

  return limited;
}

function getDashScopeUrl(): string {
  return process.env.DASHSCOPE_API_URL || DEFAULT_DASHSCOPE_URL;
}

function getModelId(): string {
  return process.env.DASHSCOPE_MODEL || DEFAULT_MODEL;
}

function extractImageUrl(response: WanImageResponse): string {
  const choices = response.output?.choices || [];
  for (const choice of choices) {
    const content = choice.message?.content || [];
    for (const item of content) {
      if (item.image) {
        return item.image;
      }
    }
  }
  throw new Error(
    `Failed to extract image URL from DashScope response: ${JSON.stringify(response)}`
  );
}

async function generateImageEdit(input: {
  prompt: string;
  size?: string;
  referenceImageUrl?: string;
  referenceImagePath?: string;
  extraReferenceImageUrls?: string[];
  extraReferenceImagePaths?: string[];
}): Promise<WanImageResponse> {
  const apiKey = process.env.DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "DASHSCOPE_API_KEY environment variable not set. Configure your Bailian / DashScope API key first."
    );
  }

  const referenceImages = getReferenceImageInputs({
    referenceImageUrl: input.referenceImageUrl,
    referenceImagePath: input.referenceImagePath,
    extraReferenceImageUrls: input.extraReferenceImageUrls,
    extraReferenceImagePaths: input.extraReferenceImagePaths,
  });

  const response = await fetch(getDashScopeUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getModelId(),
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                text: input.prompt,
              },
              ...referenceImages.map((image) => ({
                image,
              })),
            ],
          },
        ],
      },
      parameters: {
        prompt_extend: true,
        watermark: false,
        n: 1,
        enable_interleave: false,
        size: input.size || "1K",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DashScope image edit failed: ${errorText}`);
  }

  return (await response.json()) as WanImageResponse;
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
    size = "1K",
    useOpenClawCLI = true,
    referenceImageUrl,
    referenceImagePath,
    extraReferenceImageUrls,
    extraReferenceImagePaths,
  } = options;

  console.log("[INFO] Editing Asuka reference image with wan2.6-image...");
  console.log(`[INFO] Prompt: ${prompt}`);
  console.log(`[INFO] Size: ${size}`);

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
    requestId: imageResult.request_id,
    size: imageResult.usage?.size,
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
  size     - Output size (default: 1K; also supports 2K or WxH)

Environment:
  DASHSCOPE_API_KEY  - Alibaba Cloud Bailian / DashScope API key
  DASHSCOPE_API_URL  - Optional full endpoint override
  DASHSCOPE_MODEL    - Optional model override, default wan2.6-image
  OPENCLAW_PROFILE   - Optional OpenClaw profile used for CLI sends
  ASUKA_EXTRA_REFERENCE_IMAGE_PATHS - Optional comma-separated extra local reference image paths
  ASUKA_EXTRA_REFERENCE_IMAGE_URLS  - Optional comma-separated extra reference image URLs

Example:
  DASHSCOPE_API_KEY=sk-xxx OPENCLAW_PROFILE=asuka \\
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
