import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { qqbotPlugin } from "./src/channel.js";
import { shutdownAsukaMemoryRuntime } from "./src/asuka-memory-kernel/runtime.js";
import { setQQBotCronService, setQQBotRuntime } from "./src/runtime.js";

type GatewayHookContext = {
  getCron?: () => unknown;
};

type HookRegistrar = {
  on?: (hookName: string, handler: (event: unknown, ctx: GatewayHookContext) => void | Promise<void>) => void;
};

function installCronServiceCapture(api: HookRegistrar) {
  if (typeof api.on !== "function") return;
  const capture = (_event: unknown, ctx: GatewayHookContext) => {
    setQQBotCronService(ctx?.getCron?.());
  };
  api.on("gateway_start", capture);
  api.on("cron_changed", capture);
  api.on("gateway_stop", async (_event: unknown, _ctx: GatewayHookContext) => {
    setQQBotCronService(null);
    await shutdownAsukaMemoryRuntime();
  });
}

const plugin = {
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setQQBotRuntime(api.runtime);
    installCronServiceCapture(api);
    api.registerChannel({ plugin: qqbotPlugin });
  },
};

export default plugin;

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export { qqbotOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
