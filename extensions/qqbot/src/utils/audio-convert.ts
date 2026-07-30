import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { decode, encode, isSilk } from "silk-wasm";
import { detectFfmpeg, isWindows } from "./platform.js";

/**
 * 检查文件是否为 SILK 格式（QQ/微信语音常用格式）
 * QQ 语音文件通常以 .amr 扩展名保存，但实际编码可能是 SILK v3
 * SILK 文件头部标识: 0x02 "#!SILK_V3"
 */
function isSilkFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

/**
 * 将 PCM (s16le) 数据封装为 WAV 文件格式
 * WAV = 44 字节 RIFF 头 + PCM 原始数据
 */
function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);         // sub-chunk size
  buffer.writeUInt16LE(1, 20);          // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * 去除 QQ 语音文件的 AMR 头（如果存在）
 * QQ 的 .amr 文件可能在 SILK 数据前有 "#!AMR\n" 头（6 字节）
 * 需要去除后才能被 silk-wasm 正确解码
 */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式
 *
 * @param inputPath 输入文件路径（.amr / .silk / .slk）
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 WAV 文件路径，失败返回 null
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);

  // 去除可能的 AMR 头
  const strippedBuf = stripAmrHeader(fileBuf);

  // 转为 Uint8Array 以兼容 silk-wasm 类型要求
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  // 验证是否为 SILK 格式
  if (!isSilk(rawData)) {
    return null;
  }

  // SILK 解码为 PCM (s16le)
  // QQ 语音通常采样率为 24000Hz
  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);

  // PCM → WAV
  const wavBuffer = pcmToWav(result.data, sampleRate);

  // 写入 WAV 文件
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

/**
 * 判断是否为语音附件（根据 content_type 或文件扩展名）
 */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk", ".slac"].includes(ext);
}

/**
 * 格式化语音时长为可读字符串
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

export function isAudioFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".silk", ".slk", ".amr", ".wav", ".mp3", ".ogg", ".opus", ".aac", ".flac", ".m4a", ".wma", ".pcm"].includes(ext);
}

// ============ TTS（文字转语音）============

export interface TTSConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  provider?: string;
  /** Azure OpenAI 风格：使用 api-key header 而非 Bearer token */
  authStyle?: "bearer" | "api-key";
  /** 附加在 URL 后的查询参数，如 Azure 的 api-version */
  queryParams?: Record<string, string>;
  /** 自定义速度（默认不传） */
  speed?: number;
  /** MiniMax T2A 音量，默认不传 */
  vol?: number;
  /** MiniMax T2A 音高，默认不传 */
  pitch?: number;
  /** MiniMax T2A voice_modify 参数，由单轮 payload 可选覆盖 */
  voiceModify?: MiniMaxVoiceModify;
  /** MiniMax T2A 语言增强，如 Chinese/Japanese/auto */
  languageBoost?: string;
  /** MiniMax T2A 读音控制，格式为 text/tone */
  pronunciationTone?: string[];
  /** 期望音频格式；MiniMax 默认使用 wav 以便本地直接解析为 PCM */
  audioFormat?: "pcm" | "mp3" | "wav" | "flac";
  /** 输出采样率 */
  sampleRate?: number;
  /** 输出码率 */
  bitrate?: number;
  /** 输出声道数 */
  channel?: number;
  /** 单次 TTS 最大文本长度 */
  maxInputChars?: number;
  /** 单进程 TTS 请求冷却时间 */
  cooldownMs?: number;
  /** TTS 返回音频最大字节数 */
  maxOutputBytes?: number;
}

export interface MiniMaxVoiceModify {
  pitch?: number;
  intensity?: number;
  timbre?: number;
  soundEffects?: string[];
}

export interface TTSRuntimeOverrides {
  voice?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  languageBoost?: string;
  emotion?: "neutral" | "gentle" | "soft" | "happy" | "amused" | "shy" | "sleepy" | "relieved" | "serious";
  pause?: "none" | "light" | "normal" | "long";
  pauseBeforeSeconds?: number;
  pauseAfterSeconds?: number;
  voiceModify?: MiniMaxVoiceModify;
  pronunciationTone?: string[];
}

const DEFAULT_TTS_MAX_INPUT_CHARS = 240;
const DEFAULT_TTS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MINIMAX_TTS_MODEL = "speech-2.8-hd";
const DEFAULT_MINIMAX_VOICE_ID = "Chinese (Mandarin)_Laid_BackGirl";
const ttsLastRequestByKey = new Map<string, number>();

function resolveTTSFromBlock(
  block: Record<string, any>,
  providerCfg: Record<string, any> | undefined,
  providerId: string = "openai",
): TTSConfig | null {
  const baseUrl: string | undefined = block?.baseUrl || providerCfg?.baseUrl;
  const apiKey: string | undefined = block?.apiKey || providerCfg?.apiKey;
  const isMiniMax = providerId === "minimax" || /minimax/i.test(String(baseUrl ?? ""));
  const model: string = block?.model || (isMiniMax ? DEFAULT_MINIMAX_TTS_MODEL : "tts-1");
  const voice: string = block?.voice || block?.voiceId || (isMiniMax ? DEFAULT_MINIMAX_VOICE_ID : "alloy");
  if (!baseUrl || !apiKey) return null;

  const authStyle = (block?.authStyle || providerCfg?.authStyle) === "api-key" ? "api-key" as const : "bearer" as const;
  const queryParams: Record<string, string> = { ...(providerCfg?.queryParams ?? {}), ...(block?.queryParams ?? {}) };
  const speed: number | undefined = block?.speed;
  const vol: number | undefined = block?.vol;
  const pitch: number | undefined = block?.pitch;
  const voiceModify = normalizeMiniMaxVoiceModify(block?.voiceModify ?? block?.voice_modify);
  const sampleRate: number | undefined = block?.sampleRate ?? block?.sample_rate;
  const bitrate: number | undefined = block?.bitrate;
  const channel: number | undefined = block?.channel;
  const maxInputChars: number | undefined = block?.maxInputChars ?? block?.max_input_chars;
  const cooldownMs: number | undefined = block?.cooldownMs ?? block?.cooldown_ms;
  const maxOutputBytes: number | undefined = block?.maxOutputBytes ?? block?.max_output_bytes;
  const languageBoost: string | undefined = block?.languageBoost ?? block?.language_boost;
  const pronunciationTone = normalizeRuntimePronunciationTone(block?.pronunciationTone ?? block?.pronunciation_tone);
  const audioFormat: TTSConfig["audioFormat"] | undefined = block?.audioFormat ?? block?.audio_format ?? (isMiniMax ? "wav" : undefined);

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    voice,
    provider: providerId,
    authStyle,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(vol !== undefined ? { vol } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(voiceModify ? { voiceModify } : {}),
    ...(languageBoost ? { languageBoost } : {}),
    ...(pronunciationTone ? { pronunciationTone } : {}),
    ...(audioFormat ? { audioFormat } : {}),
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(maxInputChars !== undefined ? { maxInputChars } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  };
}

export function resolveTTSConfig(cfg: Record<string, unknown>): TTSConfig | null {
  const c = cfg as any;

  // 优先使用 channels.qqbot.tts（插件专属配置）
  const channelTts = c?.channels?.qqbot?.tts;
  if (channelTts && channelTts.enabled !== false) {
    const providerId: string = channelTts?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(channelTts, providerCfg, providerId);
    if (result) return result;
  }

  // 回退到 messages.tts（openclaw 框架级 TTS 配置）
  const msgTts = c?.messages?.tts;
  if (msgTts && msgTts.auto !== "disabled") {
    const providerId: string = msgTts?.provider || "openai";
    const providerBlock = msgTts?.[providerId];
    const providerCfg = c?.models?.providers?.[providerId];
    const result = resolveTTSFromBlock(providerBlock ?? {}, providerCfg, providerId);
    if (result) return result;
  }

  return null;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const numberValue = asFiniteNumber(value);
  if (numberValue === undefined) return undefined;
  return Math.min(max, Math.max(min, numberValue));
}

function clampInteger(value: unknown, min: number, max: number): number | undefined {
  const numberValue = asFiniteNumber(value);
  if (numberValue === undefined) return undefined;
  return Math.trunc(Math.min(max, Math.max(min, numberValue)));
}

function normalizeMiniMaxVoiceModify(value: unknown): MiniMaxVoiceModify | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: MiniMaxVoiceModify = {};
  const pitch = clampInteger(input.pitch, -12, 12);
  const intensity = clampInteger(input.intensity, -10, 10);
  const timbre = clampInteger(input.timbre, -10, 10);
  const rawSoundEffects = input.soundEffects ?? input.sound_effects;
  const soundEffects = Array.isArray(rawSoundEffects)
    ? rawSoundEffects
        .map((item) => typeof item === "string" ? item.trim() : "")
        .filter(Boolean)
        .slice(0, 4)
    : undefined;
  if (pitch !== undefined) result.pitch = pitch;
  if (intensity !== undefined) result.intensity = intensity;
  if (timbre !== undefined) result.timbre = timbre;
  if (soundEffects && soundEffects.length > 0) result.soundEffects = soundEffects;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRuntimeVoiceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  return trimmed.replace(/^minimax/i, "").trim();
}

function normalizeRuntimeLanguageBoost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[a-zA-Z_ -]{2,40}$/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeRuntimePronunciationTone(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tones = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 12);
  return tones.length > 0 ? tones : undefined;
}

function defaultsForTTSEmotion(emotion: TTSRuntimeOverrides["emotion"]): Partial<Pick<TTSConfig, "speed" | "pitch" | "vol">> {
  switch (emotion) {
    case "happy":
    case "amused":
      return { speed: 1.08, pitch: 1, vol: 1 };
    case "sleepy":
      return { speed: 0.86, pitch: -1, vol: 0.9 };
    case "shy":
    case "soft":
    case "gentle":
      return { speed: 0.94, pitch: 0, vol: 0.95 };
    case "relieved":
      return { speed: 0.92, pitch: 0, vol: 0.95 };
    case "serious":
      return { speed: 0.92, pitch: -1, vol: 1 };
    default:
      return {};
  }
}

export function applyTTSRuntimeOverrides(base: TTSConfig, overrides?: TTSRuntimeOverrides | null): TTSConfig {
  if (!overrides || typeof overrides !== "object") return base;
  const emotionDefaults = defaultsForTTSEmotion(overrides.emotion);
  const voice = normalizeRuntimeVoiceId(overrides.voice);
  const speed = clampNumber(overrides.speed ?? emotionDefaults.speed, 0.5, 2);
  const vol = clampNumber(overrides.vol ?? emotionDefaults.vol, 0, 10);
  const pitch = clampNumber(overrides.pitch ?? emotionDefaults.pitch, -12, 12);
  const languageBoost = normalizeRuntimeLanguageBoost(overrides.languageBoost);
  const voiceModify = normalizeMiniMaxVoiceModify(overrides.voiceModify);
  const pronunciationTone = normalizeRuntimePronunciationTone(overrides.pronunciationTone);

  return {
    ...base,
    ...(voice ? { voice } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(vol !== undefined ? { vol } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(languageBoost ? { languageBoost } : {}),
    ...(voiceModify ? { voiceModify } : {}),
    ...(pronunciationTone ? { pronunciationTone } : {}),
  };
}

/**
 * 构建 TTS 请求 URL 和 Headers
 * 支持 OpenAI 标准和 Azure OpenAI 两种风格
 */
function buildTTSRequest(ttsCfg: TTSConfig): { url: string; headers: Record<string, string> } {
  // 构建 URL：baseUrl + /audio/speech + 可选 queryParams
  let url = `${ttsCfg.baseUrl}/audio/speech`;
  if (ttsCfg.queryParams && Object.keys(ttsCfg.queryParams).length > 0) {
    const qs = new URLSearchParams(ttsCfg.queryParams).toString();
    url += `?${qs}`;
  }

  // 构建认证 Header
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ttsCfg.authStyle === "api-key") {
    headers["api-key"] = ttsCfg.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${ttsCfg.apiKey}`;
  }

  return { url, headers };
}

function isMiniMaxTTSConfig(ttsCfg: TTSConfig): boolean {
  return ttsCfg.provider === "minimax"
    || /minimax/i.test(ttsCfg.baseUrl)
    || /^speech-/i.test(ttsCfg.model);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceTTSRequestLimits(text: string, ttsCfg: TTSConfig): Promise<void> {
  const maxInputChars = ttsCfg.maxInputChars ?? DEFAULT_TTS_MAX_INPUT_CHARS;
  if (text.length > maxInputChars) {
    throw new Error(`TTS input too long: ${text.length}/${maxInputChars} chars`);
  }

  const cooldownMs = Math.max(0, ttsCfg.cooldownMs ?? 0);
  if (cooldownMs <= 0) return;

  const key = `${ttsCfg.provider ?? "default"}:${ttsCfg.model}:${ttsCfg.voice}`;
  const now = Date.now();
  const last = ttsLastRequestByKey.get(key) ?? 0;
  const remainingMs = cooldownMs - (now - last);
  if (remainingMs > 0) {
    console.log(`[tts] Cooldown wait: ${remainingMs}ms for ${ttsCfg.model}/${ttsCfg.voice}`);
    await sleep(remainingMs);
  }
  ttsLastRequestByKey.set(key, Date.now());
}

function normalizeMiniMaxSpeed(speed?: number): number {
  if (speed === undefined || Number.isNaN(speed)) return 1;
  return Math.min(2, Math.max(0.5, speed));
}

function normalizeMiniMaxPitch(pitch?: number): number {
  if (pitch === undefined || Number.isNaN(pitch)) return 0;
  return Math.trunc(Math.min(12, Math.max(-12, pitch)));
}

function decodeMiniMaxAudioHex(response: any): Buffer {
  const audio = response?.data?.audio ?? response?.audio ?? response?.data?.audio_hex;
  if (typeof audio !== "string" || !audio.trim()) {
    throw new Error(`MiniMax TTS response did not contain audio`);
  }
  const normalized = audio.trim().replace(/\s+/g, "");
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`MiniMax TTS audio was not valid hex`);
  }
  return Buffer.from(normalized, "hex");
}

async function textToSpeechPCMMiniMax(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  const sampleRate = ttsCfg.sampleRate ?? 24000;
  const maxOutputBytes = ttsCfg.maxOutputBytes ?? DEFAULT_TTS_MAX_OUTPUT_BYTES;
  const url = `${ttsCfg.baseUrl}/t2a_v2`;
  const controller = new AbortController();
  const ttsTimeout = setTimeout(() => controller.abort(), 120000);
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    model: ttsCfg.model || DEFAULT_MINIMAX_TTS_MODEL,
    text,
    stream: false,
    output_format: "hex",
    voice_setting: {
      voice_id: ttsCfg.voice,
      speed: normalizeMiniMaxSpeed(ttsCfg.speed),
      vol: ttsCfg.vol ?? 1,
      pitch: normalizeMiniMaxPitch(ttsCfg.pitch),
    },
    audio_setting: {
      sample_rate: sampleRate,
      bitrate: ttsCfg.bitrate ?? 128000,
      format: ttsCfg.audioFormat ?? "wav",
      channel: ttsCfg.channel ?? 1,
    },
  };
  if (ttsCfg.languageBoost) {
    body.language_boost = ttsCfg.languageBoost;
  }
  if (ttsCfg.pronunciationTone && ttsCfg.pronunciationTone.length > 0) {
    body.pronunciation_dict = ttsCfg.pronunciationTone.map((item) => {
      const [textPart, tonePart] = item.split("/");
      return {
        text: textPart?.trim() || item,
        tone: tonePart?.trim() || item,
      };
    });
  }
  if (ttsCfg.voiceModify) {
    body.voice_modify = {
      ...(ttsCfg.voiceModify.pitch !== undefined ? { pitch: ttsCfg.voiceModify.pitch } : {}),
      ...(ttsCfg.voiceModify.intensity !== undefined ? { intensity: ttsCfg.voiceModify.intensity } : {}),
      ...(ttsCfg.voiceModify.timbre !== undefined ? { timbre: ttsCfg.voiceModify.timbre } : {}),
      ...(ttsCfg.voiceModify.soundEffects ? { sound_effects: ttsCfg.voiceModify.soundEffects } : {}),
    };
  }

  try {
    console.log(`[tts] MiniMax request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, url=${url}`);
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ttsCfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(ttsTimeout));

    const detail = await resp.text();
    let parsed: any = {};
    try {
      parsed = detail ? JSON.parse(detail) : {};
    } catch {
      parsed = { text: detail };
    }

    const statusCode = Number(parsed?.base_resp?.status_code ?? 0);
    if (!resp.ok || statusCode !== 0) {
      const message = parsed?.base_resp?.status_msg
        || parsed?.error?.message
        || parsed?.message
        || parsed?.text
        || detail
        || resp.statusText;
      throw new Error(`MiniMax TTS failed (HTTP ${resp.status}): ${String(message).slice(0, 300)}`);
    }

    const audioBuffer = decodeMiniMaxAudioHex(parsed);
    if (audioBuffer.length > maxOutputBytes) {
      throw new Error(`MiniMax TTS audio too large: ${audioBuffer.length}/${maxOutputBytes} bytes`);
    }

    const format = (ttsCfg.audioFormat ?? "wav").toLowerCase();
    if (format === "wav") {
      const pcmBuffer = parseWavFallback(audioBuffer);
      if (!pcmBuffer) throw new Error("MiniMax TTS wav response could not be parsed as PCM");
      console.log(`[tts] MiniMax done: wav→PCM ${pcmBuffer.length} bytes, total=${Date.now() - startTime}ms`);
      return { pcmBuffer, sampleRate: 24000 };
    }

    if (format === "mp3") {
      const ffmpegCmd = await checkFfmpeg();
      if (ffmpegCmd) {
        const tmpDir = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tts-")));
        const tmpMp3 = path.join(tmpDir, "tts.mp3");
        fs.writeFileSync(tmpMp3, audioBuffer);
        try {
          const pcmBuffer = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          return { pcmBuffer, sampleRate };
        } finally {
          try { fs.unlinkSync(tmpMp3); fs.rmdirSync(tmpDir); } catch {}
        }
      }
      const pcmBuffer = await wasmDecodeMp3ToPCM(audioBuffer, sampleRate);
      if (pcmBuffer) return { pcmBuffer, sampleRate };
    }

    throw new Error(`MiniMax TTS audio format is not supported locally: ${format}`);
  } catch (err) {
    clearTimeout(ttsTimeout);
    throw err;
  }
}

export async function textToSpeechPCM(
  text: string,
  ttsCfg: TTSConfig,
): Promise<{ pcmBuffer: Buffer; sampleRate: number }> {
  await enforceTTSRequestLimits(text, ttsCfg);
  if (isMiniMaxTTSConfig(ttsCfg)) {
    return textToSpeechPCMMiniMax(text, ttsCfg);
  }

  const sampleRate = 24000;
  const { url, headers } = buildTTSRequest(ttsCfg);

  console.log(`[tts] Request: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, url=${url}`);
  console.log(`[tts] Input text (${text.length} chars): "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`);

  // 先尝试 PCM 格式（最高质量，无需二次转码）
  const formats: Array<{ format: string; needsDecode: boolean }> = [
    { format: "pcm", needsDecode: false },
    { format: "mp3", needsDecode: true },
  ];

  let lastError: Error | null = null;
  const startTime = Date.now();

  for (const { format, needsDecode } of formats) {
    const controller = new AbortController();
    const ttsTimeout = setTimeout(() => controller.abort(), 120000);

    try {
      const body: Record<string, unknown> = {
        model: ttsCfg.model,
        input: text,
        voice: ttsCfg.voice,
        response_format: format,
        ...(format === "pcm" ? { sample_rate: sampleRate } : {}),
        ...(ttsCfg.speed !== undefined ? { speed: ttsCfg.speed } : {}),
      };

      console.log(`[tts] Trying format=${format}...`);
      const fetchStart = Date.now();
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }).finally(() => clearTimeout(ttsTimeout));

      const fetchMs = Date.now() - fetchStart;

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        console.log(`[tts] HTTP ${resp.status} for format=${format} (${fetchMs}ms): ${detail.slice(0, 200)}`);
        // 如果 PCM 不支持（Azure 等），回退到 mp3
        if (format === "pcm" && (resp.status === 400 || resp.status === 422)) {
          console.log(`[tts] PCM format not supported, falling back to mp3`);
          lastError = new Error(`TTS PCM not supported: ${detail.slice(0, 200)}`);
          continue;
        }
        throw new Error(`TTS failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);
      console.log(`[tts] Response OK: format=${format}, size=${rawBuffer.length} bytes, latency=${fetchMs}ms`);

      if (!needsDecode) {
        console.log(`[tts] Done: PCM direct, ${rawBuffer.length} bytes, total=${Date.now() - startTime}ms`);
        return { pcmBuffer: rawBuffer, sampleRate };
      }

      // mp3 需要解码为 PCM
      console.log(`[tts] Decoding mp3 response (${rawBuffer.length} bytes) to PCM...`);
      const tmpDir = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "tts-")));
      const tmpMp3 = path.join(tmpDir, "tts.mp3");
      fs.writeFileSync(tmpMp3, rawBuffer);

      try {
        // 优先用 ffmpeg
        const ffmpegCmd = await checkFfmpeg();
        if (ffmpegCmd) {
          const pcmBuf = await ffmpegToPCM(ffmpegCmd, tmpMp3, sampleRate);
          console.log(`[tts] Done: mp3→PCM (ffmpeg), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        // WASM fallback
        const pcmBuf = await wasmDecodeMp3ToPCM(rawBuffer, sampleRate);
        if (pcmBuf) {
          console.log(`[tts] Done: mp3→PCM (wasm), ${pcmBuf.length} bytes, total=${Date.now() - startTime}ms`);
          return { pcmBuffer: pcmBuf, sampleRate };
        }
        throw new Error("No decoder available for mp3 (install ffmpeg for best compatibility)");
      } finally {
        try { fs.unlinkSync(tmpMp3); fs.rmdirSync(tmpDir); } catch {}
      }
    } catch (err) {
      clearTimeout(ttsTimeout);
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[tts] Error for format=${format}: ${lastError.message.slice(0, 200)}`);
      if (format === "pcm") {
        // PCM 失败时不立即抛出，尝试 mp3
        continue;
      }
      throw lastError;
    }
  }

  console.log(`[tts] All formats exhausted after ${Date.now() - startTime}ms`);
  throw lastError ?? new Error("TTS failed: all formats exhausted");
}

export async function pcmToSilk(
  pcmBuffer: Buffer,
  sampleRate: number,
): Promise<{ silkBuffer: Buffer; duration: number }> {
  const pcmData = new Uint8Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength);
  const result = await encode(pcmData, sampleRate);
  return {
    silkBuffer: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength),
    duration: result.duration,
  };
}

export async function textToSilk(
  text: string,
  ttsCfg: TTSConfig,
  outputDir: string,
): Promise<{ silkPath: string; silkBase64: string; duration: number }> {
  const { pcmBuffer, sampleRate } = await textToSpeechPCM(text, ttsCfg);
  const { silkBuffer, duration } = await pcmToSilk(pcmBuffer, sampleRate);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const silkPath = path.join(outputDir, `tts-${Date.now()}.silk`);
  fs.writeFileSync(silkPath, silkBuffer);

  return { silkPath, silkBase64: silkBuffer.toString("base64"), duration };
}

// ============ 核心：任意音频 → SILK Base64 ============

/** QQ Bot API 原生支持上传的音频格式（无需转换为 SILK） */
const QQ_NATIVE_UPLOAD_FORMATS = [".wav", ".mp3", ".silk"];

/**
 * 将本地音频文件转换为 QQ Bot 可上传的 Base64
 *
 * QQ Bot API 支持直传 WAV、MP3、SILK 三种格式，其他格式仍需转换。
 * 转换策略（参考 NapCat/go-cqhttp/Discord/Telegram 的做法）：
 *
 * 1. WAV / MP3 / SILK → 直传（跳过转换）
 * 2. 有 ffmpeg → ffmpeg 万能解码为 PCM → silk-wasm 编码
 *    支持: ogg, opus, aac, flac, wma, m4a, pcm 等所有 ffmpeg 支持的格式
 * 3. 无 ffmpeg → WASM fallback（仅支持 pcm, wav）
 *
 * @param directUploadFormats - 自定义直传格式列表，覆盖默认值。传 undefined 使用 QQ_NATIVE_UPLOAD_FORMATS
 */
export async function audioFileToSilkBase64(filePath: string, directUploadFormats?: string[]): Promise<string | null> {
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) {
    console.error(`[audio-convert] file is empty: ${filePath}`);
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();

  // 0. 直传判断：QQ Bot API 原生支持 WAV/MP3/SILK，可通过配置覆盖
  const uploadFormats = directUploadFormats ? normalizeFormats(directUploadFormats) : QQ_NATIVE_UPLOAD_FORMATS;
  if (uploadFormats.includes(ext)) {
    console.log(`[audio-convert] direct upload (QQ native format): ${ext} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  // 1. .slk / .amr 扩展名 → 检测 SILK 魔数，是 SILK 则直传
  if ([".slk", ".slac"].includes(ext)) {
    const stripped = stripAmrHeader(buf);
    const raw = new Uint8Array(stripped.buffer, stripped.byteOffset, stripped.byteLength);
    if (isSilk(raw)) {
      console.log(`[audio-convert] SILK file, direct use: ${filePath} (${buf.length} bytes)`);
      return buf.toString("base64");
    }
  }

  // 按文件头检测 SILK（不依赖扩展名）
  const rawCheck = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const strippedCheck = stripAmrHeader(buf);
  const strippedRaw = new Uint8Array(strippedCheck.buffer, strippedCheck.byteOffset, strippedCheck.byteLength);
  if (isSilk(rawCheck) || isSilk(strippedRaw)) {
    console.log(`[audio-convert] SILK detected by header: ${filePath} (${buf.length} bytes)`);
    return buf.toString("base64");
  }

  const targetRate = 24000;

  // 2. 优先使用 ffmpeg（业界标准做法，跨平台检测）
  const ffmpegCmd = await checkFfmpeg();
  if (ffmpegCmd) {
    try {
      console.log(`[audio-convert] ffmpeg (${ffmpegCmd}): converting ${ext} (${buf.length} bytes) → PCM s16le ${targetRate}Hz`);
      const pcmBuf = await ffmpegToPCM(ffmpegCmd, filePath, targetRate);
      if (pcmBuf.length === 0) {
        console.error(`[audio-convert] ffmpeg produced empty PCM output`);
        return null;
      }
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] ffmpeg: ${ext} → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    } catch (err) {
      console.error(`[audio-convert] ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`);
      // ffmpeg 失败后不 return，继续尝试 WASM fallback
    }
  }

  // 3. WASM fallback（无 ffmpeg 时的降级方案）
  console.log(`[audio-convert] fallback: trying WASM decoders for ${ext}`);

  // 3a. PCM：视为 s16le 24000Hz 单声道
  if (ext === ".pcm") {
    const pcmBuf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
    return silkBuffer.toString("base64");
  }

  // 3b. WAV：手动解析（仅支持标准 PCM WAV）
  if (ext === ".wav" || (buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF")) {
    const wavInfo = parseWavFallback(buf);
    if (wavInfo) {
      const { silkBuffer } = await pcmToSilk(wavInfo, targetRate);
      return silkBuffer.toString("base64");
    }
  }

  // 3c. MP3：WASM 解码
  if (ext === ".mp3" || ext === ".mpeg") {
    const pcmBuf = await wasmDecodeMp3ToPCM(buf, targetRate);
    if (pcmBuf) {
      const { silkBuffer } = await pcmToSilk(pcmBuf, targetRate);
      console.log(`[audio-convert] WASM: MP3 → SILK done (${silkBuffer.length} bytes)`);
      return silkBuffer.toString("base64");
    }
  }

  const installHint = isWindows()
    ? "安装方式: choco install ffmpeg 或 scoop install ffmpeg 或从 https://ffmpeg.org 下载"
    : process.platform === "darwin"
      ? "安装方式: brew install ffmpeg"
      : "安装方式: sudo apt install ffmpeg 或 sudo yum install ffmpeg";
  console.error(`[audio-convert] unsupported format: ${ext} (no ffmpeg available). ${installHint}`);
  return null;
}

/**
 * 等待文件就绪（轮询直到文件出现且大小稳定）
 * 用于 TTS 生成后等待文件写入完成
 *
 * @param filePath 文件路径
 * @param timeoutMs 最大等待时间（默认 2 分钟）
 * @param pollMs 轮询间隔（默认 500ms）
 * @returns 文件大小（字节），超时或文件始终为空返回 0
 */
export async function waitForFile(filePath: string, timeoutMs: number = 120000, pollMs: number = 500): Promise<number> {
  const start = Date.now();
  let lastSize = -1;
  let stableCount = 0;
  let fileExists = false;
  let pollCount = 0;

  while (Date.now() - start < timeoutMs) {
    pollCount++;
    try {
      const stat = fs.statSync(filePath);
      if (!fileExists) {
        fileExists = true;
        console.log(`[audio-convert] waitForFile: file appeared (${stat.size} bytes, after ${Date.now() - start}ms): ${path.basename(filePath)}`);
      }
      if (stat.size > 0) {
        if (stat.size === lastSize) {
          stableCount++;
          if (stableCount >= 2) {
            console.log(`[audio-convert] waitForFile: ready (${stat.size} bytes, waited ${Date.now() - start}ms, polls=${pollCount})`);
            return stat.size;
          }
        } else {
          stableCount = 0;
        }
        lastSize = stat.size;
      }
    } catch {
      // 文件可能还不存在，继续等
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // 超时后最后检查一次
  try {
    const finalStat = fs.statSync(filePath);
    if (finalStat.size > 0) {
      console.warn(`[audio-convert] waitForFile: timeout but file has data (${finalStat.size} bytes), using it`);
      return finalStat.size;
    }
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file exists but empty (0 bytes): ${path.basename(filePath)}`);
  } catch {
    console.error(`[audio-convert] waitForFile: timeout after ${timeoutMs}ms, file never appeared: ${path.basename(filePath)}`);
  }
  return 0;
}

// ============ ffmpeg 跨平台调用 ============

/**
 * 检测 ffmpeg 是否可用（委托给 platform.ts 跨平台检测）
 * @returns ffmpeg 可执行路径或 null
 */
async function checkFfmpeg(): Promise<string | null> {
  return detectFfmpeg();
}

/**
 * 使用 ffmpeg 将任意音频文件转换为 PCM s16le 单声道 24kHz
 *
 * 跨平台注意:
 * - Windows 上 pipe:1 需要 encoding: "buffer" 防止 BOM 问题
 * - 使用 detectFfmpeg() 返回的完整路径，兼容非 PATH 安装
 */
function ffmpegToPCM(ffmpegCmd: string, inputPath: string, sampleRate: number = 24000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", inputPath,
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-acodec", "pcm_s16le",
      "-v", "error",
      "pipe:1",
    ];
    execFile(ffmpegCmd, args, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: "buffer",
      // Windows: 隐藏弹出的 cmd 窗口
      ...(isWindows() ? { windowsHide: true } : {}),
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${err.message}`));
        return;
      }
      resolve(stdout as unknown as Buffer);
    });
  });
}

// ============ WASM fallback: MP3 解码 ============

/**
 * 使用 mpg123-decoder (WASM) 解码 MP3 为 PCM
 * 仅在 ffmpeg 不可用时作为 fallback
 */
async function wasmDecodeMp3ToPCM(buf: Buffer, targetRate: number): Promise<Buffer | null> {
  try {
    const { MPEGDecoder } = await import("mpg123-decoder");
    console.log(`[audio-convert] WASM MP3 decode: size=${buf.length} bytes`);
    const decoder = new MPEGDecoder();
    await decoder.ready;

    const decoded = decoder.decode(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    decoder.free();

    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      console.error(`[audio-convert] WASM MP3 decode: no samples (samplesDecoded=${decoded.samplesDecoded})`);
      return null;
    }

    console.log(`[audio-convert] WASM MP3 decode: samples=${decoded.samplesDecoded}, sampleRate=${decoded.sampleRate}, channels=${decoded.channelData.length}`);

    // Float32 多声道混缩为单声道
    let floatMono: Float32Array;
    if (decoded.channelData.length === 1) {
      floatMono = decoded.channelData[0];
    } else {
      floatMono = new Float32Array(decoded.samplesDecoded);
      const channels = decoded.channelData.length;
      for (let i = 0; i < decoded.samplesDecoded; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) {
          sum += decoded.channelData[ch][i];
        }
        floatMono[i] = sum / channels;
      }
    }

    // Float32 → s16le
    const s16 = new Uint8Array(floatMono.length * 2);
    const view = new DataView(s16.buffer);
    for (let i = 0; i < floatMono.length; i++) {
      const clamped = Math.max(-1, Math.min(1, floatMono[i]));
      const val = clamped < 0 ? clamped * 32768 : clamped * 32767;
      view.setInt16(i * 2, Math.round(val), true);
    }

    // 简单线性插值重采样
    let pcm: Uint8Array = s16;
    if (decoded.sampleRate !== targetRate) {
      const inputSamples = s16.length / 2;
      const outputSamples = Math.round(inputSamples * targetRate / decoded.sampleRate);
      const output = new Uint8Array(outputSamples * 2);
      const inView = new DataView(s16.buffer, s16.byteOffset, s16.byteLength);
      const outView = new DataView(output.buffer, output.byteOffset, output.byteLength);
      for (let i = 0; i < outputSamples; i++) {
        const srcIdx = i * decoded.sampleRate / targetRate;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, inputSamples - 1);
        const frac = srcIdx - idx0;
        const s0 = inView.getInt16(idx0 * 2, true);
        const s1 = inView.getInt16(idx1 * 2, true);
        const sample = Math.round(s0 + (s1 - s0) * frac);
        outView.setInt16(i * 2, Math.max(-32768, Math.min(32767, sample)), true);
      }
      pcm = output;
    }

    return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  } catch (err) {
    console.error(`[audio-convert] WASM MP3 decode failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(`[audio-convert] stack: ${err.stack}`);
    }
    return null;
  }
}

/**
 * 规范化格式列表（确保以 . 开头，小写）
 */
function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith(".") ? lower : `.${lower}`;
  });
}

/**
 * WAV fallback 解析（无 ffmpeg 时使用）
 * 仅支持标准 PCM WAV (format=1, 16bit)
 */
function parseWavFallback(buf: Buffer): Buffer | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;
  if (buf.toString("ascii", 12, 16) !== "fmt ") return null;

  const audioFormat = buf.readUInt16LE(20);
  if (audioFormat !== 1) return null;

  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) return null;

  // 找 data chunk
  let offset = 36;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const dataStart = offset + 8;
      const dataEnd = Math.min(dataStart + chunkSize, buf.length);
      let pcm = new Uint8Array(buf.buffer, buf.byteOffset + dataStart, dataEnd - dataStart);

      // 多声道混缩
      if (channels > 1) {
        const samplesPerCh = pcm.length / (2 * channels);
        const mono = new Uint8Array(samplesPerCh * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
        for (let i = 0; i < samplesPerCh; i++) {
          let sum = 0;
          for (let ch = 0; ch < channels; ch++) sum += inV.getInt16((i * channels + ch) * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / channels))), true);
        }
        pcm = mono;
      }

      // 简单线性插值重采样
      const targetRate = 24000;
      if (sampleRate !== targetRate) {
        const inSamples = pcm.length / 2;
        const outSamples = Math.round(inSamples * targetRate / sampleRate);
        const out = new Uint8Array(outSamples * 2);
        const inV = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const outV = new DataView(out.buffer, out.byteOffset, out.byteLength);
        for (let i = 0; i < outSamples; i++) {
          const src = i * sampleRate / targetRate;
          const i0 = Math.floor(src);
          const i1 = Math.min(i0 + 1, inSamples - 1);
          const f = src - i0;
          const s0 = inV.getInt16(i0 * 2, true);
          const s1 = inV.getInt16(i1 * 2, true);
          outV.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), true);
        }
        pcm = out;
      }

      return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    offset += 8 + chunkSize;
  }

  return null;
}
