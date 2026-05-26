import type { ResolvedQQBotAccount } from "./types.js";
import { sendCronMessage } from "./outbound.js";
import {
  listDueScheduledDeliveryJobs,
  markScheduledDeliveryFailed,
  markScheduledDeliverySucceeded,
} from "./scheduled-delivery-store.js";

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

interface ScheduledDeliveryRunnerOptions {
  intervalMs?: number;
  log?: LoggerLike;
  abortSignal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 15_000;

export function startScheduledDeliveryRunner(
  account: ResolvedQQBotAccount,
  options: ScheduledDeliveryRunnerOptions = {},
): () => void {
  const intervalMs = Math.max(5_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const nowMs = Date.now();
    try {
      const dueJobs = await listDueScheduledDeliveryJobs(account.accountId, nowMs);
      if (dueJobs.length > 0) {
        options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery runner found ${dueJobs.length} due job(s)`);
      }
      for (const job of dueJobs) {
        if (stopped) break;
        try {
          const result = await sendCronMessage(account, job.to, job.message);
          if (result.error) {
            await markScheduledDeliveryFailed(job.id, result.error, Date.now());
            options.log?.error?.(`[qqbot:${account.accountId}] Scheduled delivery ${job.id} failed: ${result.error}`);
          } else {
            await markScheduledDeliverySucceeded(job.id, Date.now());
            options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery ${job.id} completed`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await markScheduledDeliveryFailed(job.id, message, Date.now());
          options.log?.error?.(`[qqbot:${account.accountId}] Scheduled delivery ${job.id} crashed: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn?.(`[qqbot:${account.accountId}] Scheduled delivery runner tick failed: ${message}`);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  options.abortSignal?.addEventListener("abort", stop, { once: true });
  setTimeout(() => {
    void tick();
  }, 1_000).unref?.();
  options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery runner started (interval=${intervalMs}ms)`);

  return stop;
}
