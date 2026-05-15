import assert from "node:assert/strict";

const {
  resolveTTSConfig,
  applyTTSRuntimeOverrides,
  textToSpeechPCM,
} = await import("../dist/src/utils/audio-convert.js");

function makePcmWavHex() {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(900, 2);
  pcm.writeInt16LE(-900, 4);
  pcm.writeInt16LE(0, 6);

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(24000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("hex");
}

const config = {
  models: {
    providers: {
      minimax: {
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "super-secret-minimax-key",
      },
    },
  },
  channels: {
    qqbot: {
      tts: {
        enabled: true,
        provider: "minimax",
        model: "speech-2.8-hd",
        voice: "Chinese (Mandarin)_Laid_BackGirl",
        speed: 1.08,
        vol: 1,
        pitch: 0,
        languageBoost: "Chinese",
        audioFormat: "wav",
        sampleRate: 24000,
        bitrate: 128000,
        channel: 1,
        maxInputChars: 40,
        cooldownMs: 0,
        maxOutputBytes: 1024 * 1024,
      },
    },
  },
};

const ttsConfig = resolveTTSConfig(config);
assert.ok(ttsConfig, "MiniMax TTS config should resolve");
assert.equal(ttsConfig.provider, "minimax");
assert.equal(ttsConfig.model, "speech-2.8-hd");
assert.equal(ttsConfig.voice, "Chinese (Mandarin)_Laid_BackGirl");
assert.equal(ttsConfig.audioFormat, "wav");
assert.equal(ttsConfig.maxInputChars, 40);

let capturedUrl = "";
let capturedHeaders = {};
let capturedBody = {};
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers ?? {};
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    data: {
      audio: makePcmWavHex(),
    },
    base_resp: {
      status_code: 0,
      status_msg: "success",
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const result = await textToSpeechPCM("轻轻说一句测试", ttsConfig);
  assert.equal(capturedUrl, "https://api.minimaxi.com/v1/t2a_v2", "MiniMax TTS should use t2a_v2");
  assert.equal(capturedHeaders.Authorization, "Bearer super-secret-minimax-key");
  assert.equal(capturedBody.model, "speech-2.8-hd");
  assert.equal(capturedBody.text, "轻轻说一句测试");
  assert.equal(capturedBody.output_format, "hex");
  assert.equal(capturedBody.voice_setting.voice_id, "Chinese (Mandarin)_Laid_BackGirl");
  assert.equal(capturedBody.audio_setting.format, "wav");
  assert.equal(result.sampleRate, 24000);
  assert.ok(result.pcmBuffer.length > 0, "MiniMax wav response should decode to PCM");
} finally {
  globalThis.fetch = originalFetch;
}

const dynamicTtsConfig = applyTTSRuntimeOverrides(ttsConfig, {
  voice: "minimaxChinese (Mandarin)_Soft_Girl",
  emotion: "soft",
  pause: "normal",
  vol: 1.2,
  languageBoost: "Chinese",
  pronunciationTone: ["Asuka/阿斯卡"],
  voiceModify: {
    intensity: -1,
    timbre: 1,
    soundEffects: ["soft"],
  },
});

globalThis.fetch = async (url, init) => {
  capturedUrl = String(url);
  capturedHeaders = init?.headers ?? {};
  capturedBody = JSON.parse(String(init?.body ?? "{}"));
  return new Response(JSON.stringify({
    data: {
      audio: makePcmWavHex(),
    },
    base_resp: {
      status_code: 0,
      status_msg: "success",
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  await textToSpeechPCM("带一点停顿<#0.4#>和语气", dynamicTtsConfig);
  assert.equal(capturedBody.voice_setting.voice_id, "Chinese (Mandarin)_Soft_Girl");
  assert.equal(capturedBody.voice_setting.speed, 0.94);
  assert.equal(capturedBody.voice_setting.pitch, 0.3);
  assert.equal(capturedBody.voice_setting.vol, 1.2);
  assert.equal(capturedBody.language_boost, "Chinese");
  assert.deepEqual(capturedBody.pronunciation_dict, [{ text: "Asuka", tone: "阿斯卡" }]);
  assert.equal(capturedBody.voice_modify.intensity, -1);
  assert.equal(capturedBody.voice_modify.timbre, 1);
  assert.deepEqual(capturedBody.voice_modify.sound_effects, ["soft"]);
} finally {
  globalThis.fetch = originalFetch;
}

await assert.rejects(
  () => textToSpeechPCM("这是一段肯定会超过四十个字符的文本，用来验证 TTS 长度限制会在请求前生效。".repeat(3), ttsConfig),
  /TTS input too long/,
  "TTS should reject overlong text before calling provider"
);

globalThis.fetch = async () => new Response(JSON.stringify({
  base_resp: {
    status_code: 1001,
    status_msg: "quota exhausted",
  },
}), { status: 200, headers: { "content-type": "application/json" } });

try {
  await assert.rejects(
    () => textToSpeechPCM("额度失败测试", ttsConfig),
    (error) => {
      assert.match(String(error), /MiniMax TTS failed/);
      assert.equal(String(error).includes("super-secret"), false, "TTS errors should not leak API keys");
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("[qqbot:test] asuka-tts fixtures passed");
