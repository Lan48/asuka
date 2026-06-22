import type { ResolvedQQBotAccount } from "./types.js";
import { getCronDeliveryBatchSemanticKey, sendCronMessage, type CronDeliveryBatchJobContext } from "./outbound.js";
import {
  type ScheduledDeliveryJob,
  listDueScheduledDeliveryJobs,
  markScheduledDeliveryFailed,
  markScheduledDeliverySucceeded,
  retryScheduledDeliveryJob,
} from "./scheduled-delivery-store.js";
import { decodeCronPayload } from "./utils/payload.js";

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
const TRANSIENT_DELIVERY_RETRY_DELAY_MS = 10 * 60 * 1000;
const TRANSIENT_DELIVERY_MAX_RETRIES = 3;
const DELIVERY_JOB_TIMEOUT_MS = 120_000;
const TRANSIENT_SKIP_REASONS = new Set([
  "ambient_shared_session_unavailable",
  "ambient_scene_continuity_unavailable",
  "ambient_scene_continuity_rejected",
  "ambient_scene_continuity_duplicate",
  "ambient_timing_plan_unavailable",
  "scheduled_delivery_timeout",
  "scene_continuity_unavailable",
  "scene_continuity_rejected",
  "scene_continuity_duplicate",
]);

function shouldRetrySkippedDelivery(skipReason: string | undefined): boolean {
  return Boolean(skipReason && TRANSIENT_SKIP_REASONS.has(skipReason));
}

function buildDueBatchContext(dueJobs: ScheduledDeliveryJob[]): CronDeliveryBatchJobContext[] {
  return dueJobs.map((job) => {
    const decoded = decodeCronPayload(job.message);
    const payload = decoded.payload;
    return {
      jobId: job.id,
      to: job.to,
      mode: payload?.mode,
      promiseId: payload?.promiseId,
      peerKey: payload?.peerKey,
      targetType: payload?.targetType,
      targetAddress: payload?.targetAddress,
      nextRunAtMs: job.state?.nextRunAtMs,
      semanticKey: payload ? getCronDeliveryBatchSemanticKey(payload) : undefined,
    };
  });
}

async function withDeliveryTimeout<T>(jobId: string, promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`scheduled_delivery_timeout:${jobId}:${DELIVERY_JOB_TIMEOUT_MS}ms`));
    }, DELIVERY_JOB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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
      const dueBatch = buildDueBatchContext(dueJobs);
      for (const job of dueJobs) {
        if (stopped) break;
        try {
          const result = await withDeliveryTimeout(job.id, sendCronMessage(account, job.to, job.message, {
              currentJobId: job.id,
              dueBatch,
              runnerNowMs: nowMs,
            }));
          if (result.error) {
            await markScheduledDeliveryFailed(job.id, result.error, Date.now());
            options.log?.error?.(`[qqbot:${account.accountId}] Scheduled delivery ${job.id} failed: ${result.error}`);
          } else if (result.skipped && shouldRetrySkippedDelivery(result.skipReason)) {
            const retry = await retryScheduledDeliveryJob(job.id, result.skipReason ?? "transient_skip", Date.now(), {
              delayMs: result.retryAfterMs ?? TRANSIENT_DELIVERY_RETRY_DELAY_MS,
              maxRetries: TRANSIENT_DELIVERY_MAX_RETRIES,
            });
            if (retry.retried) {
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery ${job.id} skipped transiently (${result.skipReason}); retry ${retry.retryCount}/${TRANSIENT_DELIVERY_MAX_RETRIES} at ${new Date(retry.nextRunAtMs ?? Date.now()).toISOString()}`
              );
            } else {
              await markScheduledDeliverySucceeded(job.id, Date.now());
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery ${job.id} skipped transiently (${result.skipReason}) but retry limit was reached; consuming without user-facing fallback`
              );
            }
          } else {
            await markScheduledDeliverySucceeded(job.id, Date.now());
            options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery ${job.id} completed`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("scheduled_delivery_timeout:")) {
            const retry = await retryScheduledDeliveryJob(job.id, "scheduled_delivery_timeout", Date.now(), {
              delayMs: TRANSIENT_DELIVERY_RETRY_DELAY_MS,
              maxRetries: TRANSIENT_DELIVERY_MAX_RETRIES,
            });
            if (retry.retried) {
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery ${job.id} timed out; retry ${retry.retryCount}/${TRANSIENT_DELIVERY_MAX_RETRIES} at ${new Date(retry.nextRunAtMs ?? Date.now()).toISOString()}`
              );
            } else {
              await markScheduledDeliverySucceeded(job.id, Date.now());
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery ${job.id} timed out but retry limit was reached; consuming without user-facing fallback`
              );
            }
            continue;
          }
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
