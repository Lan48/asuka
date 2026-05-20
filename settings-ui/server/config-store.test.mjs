import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFeatureMap,
  createTempConfigFixture,
  isMaskLike,
  prepareConfigForWrite,
  readRedactedConfig,
  saveConfigPayload,
} from "./config-store.mjs";

function fixtureConfig() {
  return {
    models: {
      providers: {
        minimax: {
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "super-secret-minimax-key",
          api: "openai-completions",
          models: [{ id: "MiniMax-M2.7", name: "MiniMax M2.7" }],
        },
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "deepseek-secret-key",
          api: "openai-completions",
          models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        },
      },
    },
    agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
    channels: {
      qqbot: {
        enabled: true,
        allowFrom: ["*"],
        appId: "app-id",
        clientSecret: "qq-client-secret",
        proactiveQuietHours: { enabled: true, startHour: 0, endHour: 8, timezone: "Asia/Shanghai" },
        tts: { enabled: true, provider: "minimax", model: "speech-2.8-hd" },
        minimax: {
          vision: { enabled: true, model: "MiniMax-VLM" },
          search: { enabled: true, model: "MiniMax-M2.7" },
        },
      },
    },
    gateway: { port: 17697, bind: "127.0.0.1", auth: { mode: "token", token: "gateway-token" } },
    skills: {
      entries: {
        "asuka-selfie": {
          enabled: true,
          env: {
            STUDIO_API_KEY: "studio-secret-key",
            STUDIO_API_BASE_URL: "https://api.minimaxi.com/v1",
            STUDIO_IMAGE_MODEL: "image-01",
          },
        },
      },
    },
  };
}

test("读取配置时掩码敏感字段，但保留非敏感字段", () => {
  const { configPath } = createTempConfigFixture(fixtureConfig());
  const result = readRedactedConfig({ configPath });
  assert.equal(result.config.models.providers.minimax.apiKey, "••••••••-key");
  assert.equal(result.config.channels.qqbot.clientSecret, "••••••••cret");
  assert.equal(result.config.gateway.auth.token, "••••••••oken");
  assert.equal(result.config.channels.qqbot.appId, "app-id");
  assert.equal(result.secrets["models.providers.minimax.apiKey"].configured, true);
});

test("OAuth access 和 refresh 字段会脱敏", () => {
  const config = fixtureConfig();
  config.auth = {
    profiles: {
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "access-token-value",
        refresh: "refresh-token-value",
      },
    },
  };
  const { configPath } = createTempConfigFixture(config);
  const result = readRedactedConfig({ configPath });
  const profile = result.config.auth.profiles["openai-codex:default"];
  assert.equal(profile.access, "••••••••alue");
  assert.equal(profile.refresh, "••••••••alue");
  assert.equal(result.secrets["auth.profiles.openai-codex:default.access"].configured, true);
});

test("保存掩码值时保留原始 secret", () => {
  const original = fixtureConfig();
  const { configPath } = createTempConfigFixture(original);
  const redacted = readRedactedConfig({ configPath }).config;
  redacted.channels.qqbot.systemPrompt = "新的提示词";
  const prepared = prepareConfigForWrite(redacted, { configPath });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.config.models.providers.minimax.apiKey, "super-secret-minimax-key");
  assert.equal(prepared.config.channels.qqbot.clientSecret, "qq-client-secret");
  assert.equal(prepared.config.channels.qqbot.systemPrompt, "新的提示词");
});

test("空敏感值表示清除，新值会覆盖", () => {
  const original = fixtureConfig();
  const { configPath } = createTempConfigFixture(original);
  const redacted = readRedactedConfig({ configPath }).config;
  redacted.channels.qqbot.clientSecret = "";
  redacted.models.providers.minimax.apiKey = "new-minimax-key";
  const prepared = prepareConfigForWrite(redacted, { configPath });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.config.channels.qqbot.clientSecret, undefined);
  assert.equal(prepared.config.models.providers.minimax.apiKey, "new-minimax-key");
});

test("新增敏感字段不能写入伪掩码", () => {
  const original = fixtureConfig();
  const { configPath } = createTempConfigFixture(original);
  const redacted = readRedactedConfig({ configPath }).config;
  redacted.channels.qqbot.minimax.vision.apiKey = "********";
  const prepared = prepareConfigForWrite(redacted, { configPath });
  assert.equal(prepared.ok, false);
  assert.match(prepared.errors.join("\n"), /掩码占位符/);
  assert.equal(isMaskLike("********"), true);
});

test("功能矩阵解析每个功能的 provider、model 和 key 来源", () => {
  const features = buildFeatureMap(fixtureConfig());
  const text = features.find((item) => item.name === "文本模型");
  const selfie = features.find((item) => item.name === "Asuka 自拍");
  const qqbot = features.find((item) => item.name === "QQBot 发送");
  assert.equal(text.provider, "minimax");
  assert.equal(text.keySource, "models.providers.minimax.apiKey");
  assert.equal(selfie.keySource, "skills.entries.asuka-selfie.env.STUDIO_API_KEY");
  assert.equal(qqbot.keyConfigured, true);
});

test("功能矩阵优先显示自拍 OAuth profile 来源", () => {
  const config = fixtureConfig();
  delete config.skills.entries["asuka-selfie"].env.STUDIO_API_KEY;
  config.skills.entries["asuka-selfie"].env.STUDIO_AUTH_PROFILE = "openai-codex:zhueshun@gmail.com";
  config.skills.entries["asuka-selfie"].env.STUDIO_API_BASE_URL = "https://api.openai.com/v1";
  config.skills.entries["asuka-selfie"].env.STUDIO_IMAGE_MODEL = "chatgpt-image-latest";

  const selfie = buildFeatureMap(config).find((item) => item.name === "Asuka 自拍");
  assert.equal(selfie.provider, "openai-codex");
  assert.equal(selfie.model, "chatgpt-image-latest");
  assert.equal(selfie.keySource, "skills.entries.asuka-selfie.env.STUDIO_AUTH_PROFILE");
  assert.equal(selfie.keyConfigured, true);
});

test("功能矩阵优先显示 OpenClaw 官方图片模型", () => {
  const config = fixtureConfig();
  config.agents.defaults.imageGenerationModel = { primary: "openai-codex/chatgpt-image-latest", timeoutMs: 240000 };
  config.models.providers["openai-codex"] = {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    api: "openai-codex-responses",
    request: { allowPrivateNetwork: true, proxy: { mode: "env-proxy" } },
  };

  const selfie = buildFeatureMap(config).find((item) => item.name === "Asuka 自拍");
  assert.equal(selfie.provider, "openai-codex");
  assert.equal(selfie.model, "chatgpt-image-latest");
  assert.equal(selfie.keySource, "OpenClaw OAuth profile store");
  assert.equal(selfie.keyConfigured, true);
});

test("保存会写入新配置并创建备份", () => {
  const original = fixtureConfig();
  const { configPath } = createTempConfigFixture(original);
  const redacted = readRedactedConfig({ configPath }).config;
  redacted.channels.qqbot.messageBufferMs = 1200;
  const result = saveConfigPayload(redacted, { configPath });
  assert.equal(result.saved, true);
  assert.equal(Boolean(result.backupPath), true);
  assert.equal(result.config.channels.qqbot.messageBufferMs, 1200);
});
