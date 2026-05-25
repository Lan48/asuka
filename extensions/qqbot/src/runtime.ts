import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;
let cronService: QQBotCronServiceLike | null = null;

export interface QQBotCronServiceLike {
  add: (input: Record<string, unknown>) => Promise<unknown>;
  list?: (opts?: Record<string, unknown>) => Promise<unknown>;
  update?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  remove?: (id: string) => Promise<unknown>;
}

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}

function isCronServiceLike(value: unknown): value is QQBotCronServiceLike {
  return Boolean(value && typeof value === "object" && typeof (value as { add?: unknown }).add === "function");
}

export function setQQBotCronService(next: unknown): boolean {
  if (!isCronServiceLike(next)) {
    cronService = null;
    return false;
  }
  cronService = next;
  return true;
}

export function getQQBotCronService(): QQBotCronServiceLike | null {
  return cronService;
}
