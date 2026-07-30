import type { ResolvedQQBotAccount } from "./types.js";
import { getCronDeliveryBatchSemanticKey, sendCronMessage, type CronDeliveryBatchJobContext } from "./outbound.js";
import {
  getPromiseRenderContext,
  markPromiseDeliveryFailed,
  markPromiseDuplicateSuppressed,
  shouldSendAmbient,
  shouldSendPromiseDelivery,
} from "./asuka-state.js";
import {
  type ScheduledDeliveryJob,
  listDueScheduledDeliveryJobs,
  markScheduledDeliveryFailed,
  markScheduledDeliverySucceeded,
  removeScheduledDeliveryJobsByMode,
  retryScheduledDeliveryJob,
} from "./scheduled-delivery-store.js";
import { decodeCronPayload, encodePayloadForCron, type CronReminderPayload } from "./utils/payload.js";

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
  "quiet_batch_render_unavailable",
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

interface ScheduledDeliveryExecution {
  jobs: ScheduledDeliveryJob[];
  to: string;
  message: string;
  quietBatch: boolean;
}

function quietPayloadPriority(payload: CronReminderPayload): number {
  if (payload.selfiePrompt) return 0;
  if (payload.mode === "promise" || payload.mode === "repair") return 1;
  if (payload.mode === "reminder") return 2;
  return 3;
}

function buildQuietBatchExecution(jobs: ScheduledDeliveryJob[]): ScheduledDeliveryExecution | null {
  const decoded = jobs
    .map((job) => ({ job, payload: decodeCronPayload(job.message).payload }))
    .filter((item): item is { job: ScheduledDeliveryJob; payload: CronReminderPayload } => Boolean(item.payload))
    .sort((left, right) => quietPayloadPriority(left.payload) - quietPayloadPriority(right.payload));
  if (decoded.length === 0) return null;
  const primary = decoded[0];
  const promiseIds = [...new Set(decoded
    .flatMap((item) => [item.payload.promiseId, ...(item.payload.mergedPromiseIds ?? [])])
    .filter((id): id is string => Boolean(id)))];
  const intents = decoded
    .map((item) => item.payload.content || item.payload.selfieCaption || "")
    .map((text) => text.trim())
    .filter(Boolean);
  const payload: CronReminderPayload = {
    ...primary.payload,
    quietBatch: true,
    mergedPromiseIds: promiseIds,
    content: intents.length <= 1
      ? (intents[0] || primary.payload.content)
      : [
        "把下面这些仍然有效的事项自然合并成一条消息；不要列清单，不要提到提醒、任务或合并过程。",
        ...intents.map((intent) => `- ${intent}`),
      ].join("\n"),
    advancePolicy: "hold",
  };
  return {
    jobs: decoded.map((item) => item.job),
    to: primary.job.to,
    message: encodePayloadForCron(payload),
    quietBatch: true,
  };
}

export function buildScheduledDeliveryExecutions(
  dueJobs: ScheduledDeliveryJob[],
): ScheduledDeliveryExecution[] {
  const executions: ScheduledDeliveryExecution[] = [];
  const quietGroups = new Map<string, ScheduledDeliveryJob[]>();
  for (const job of dueJobs) {
    if (!job.quietBatchKey) {
      executions.push({ jobs: [job], to: job.to, message: job.message, quietBatch: false });
      continue;
    }
    const grouped = quietGroups.get(job.quietBatchKey) ?? [];
    grouped.push(job);
    quietGroups.set(job.quietBatchKey, grouped);
  }
  for (const jobs of quietGroups.values()) {
    const execution = buildQuietBatchExecution(jobs);
    if (execution) executions.push(execution);
  }
  return executions;
}

function shouldConsumeScheduledJob(job: ScheduledDeliveryJob, nowMs: number): boolean {
  const payload = decodeCronPayload(job.message).payload;
  if (!payload) return true;
  if (payload.mode === "followup") return true;
  if ((payload.mode === "promise" || payload.mode === "repair") && payload.promiseId) {
    return !shouldSendPromiseDelivery(payload.promiseId);
  }
  if (payload.mode === "ambient" && payload.peerKey && typeof job.deferredAtMs === "number") {
    const context = payload.promiseId ? getPromiseRenderContext(payload.promiseId) : null;
    if (context?.peer?.lastUserMessageAt && context.peer.lastUserMessageAt > job.deferredAtMs) return true;
    return !shouldSendAmbient(payload.peerKey, payload.guardNoReplySince, nowMs);
  }
  return false;
}

function settleAbandonedQuietPromises(jobs: ScheduledDeliveryJob[], reason: string): void {
  const promiseIds = [...new Set(jobs
    .flatMap((job) => {
      const payload = decodeCronPayload(job.message).payload;
      return payload ? [payload.promiseId, ...(payload.mergedPromiseIds ?? [])] : [];
    })
    .filter((id): id is string => Boolean(id)))];
  for (const promiseId of promiseIds) {
    const context = getPromiseRenderContext(promiseId);
    if (context?.promise.triggerKind === "hard") {
      markPromiseDeliveryFailed(promiseId, reason);
    } else {
      markPromiseDuplicateSuppressed(promiseId);
    }
  }
}

function markExecutionPromisesFailed(jobs: ScheduledDeliveryJob[], reason: string): void {
  const promiseIds = [...new Set(jobs
    .flatMap((job) => {
      const payload = decodeCronPayload(job.message).payload;
      return payload ? [payload.promiseId, ...(payload.mergedPromiseIds ?? [])] : [];
    })
    .filter((id): id is string => Boolean(id)))];
  for (const promiseId of promiseIds) {
    markPromiseDeliveryFailed(promiseId, reason);
  }
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
  let legacyFollowUpsCleaned = false;
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
      if (!legacyFollowUpsCleaned) {
        const cleanup = await removeScheduledDeliveryJobsByMode({
          accountId: account.accountId,
          modes: ["followup"],
        });
        if ("removedCount" in cleanup && cleanup.removedCount > 0) {
          options.log?.info?.(
            `[qqbot:${account.accountId}] Removed ${cleanup.removedCount} legacy fixed follow-up delivery job(s)`
          );
        }
        if (!("error" in cleanup)) legacyFollowUpsCleaned = true;
      }
      const dueJobs = await listDueScheduledDeliveryJobs(account.accountId, nowMs);
      if (dueJobs.length > 0) {
        options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery runner found ${dueJobs.length} due job(s)`);
      }
      const dueBatch = buildDueBatchContext(dueJobs);
      const executions = buildScheduledDeliveryExecutions(dueJobs);
      for (const pendingExecution of executions) {
        if (stopped) break;
        const consumedJobs = pendingExecution.jobs.filter((job) => shouldConsumeScheduledJob(job, nowMs));
        for (const job of consumedJobs) {
          await markScheduledDeliverySucceeded(job.id, Date.now());
        }
        const activeJobs = pendingExecution.jobs.filter((job) => !consumedJobs.includes(job));
        if (activeJobs.length === 0) continue;
        const execution = pendingExecution.quietBatch
          ? buildQuietBatchExecution(activeJobs)
          : pendingExecution;
        if (!execution) continue;
        const primaryJob = execution.jobs[0];
        try {
          const delivery = sendCronMessage(account, execution.to, execution.message, {
              currentJobId: primaryJob.id,
              dueBatch,
              runnerNowMs: nowMs,
            });
          const result = execution.quietBatch
            ? await delivery
            : await withDeliveryTimeout(primaryJob.id, delivery);
          if (result.error) {
            markExecutionPromisesFailed(execution.jobs, result.error);
            for (const job of execution.jobs) {
              await markScheduledDeliveryFailed(job.id, result.error, Date.now());
            }
            options.log?.error?.(`[qqbot:${account.accountId}] Scheduled delivery ${primaryJob.id} failed: ${result.error}`);
          } else if (result.skipped && shouldRetrySkippedDelivery(result.skipReason)) {
            const maxRetries = execution.quietBatch ? 1 : TRANSIENT_DELIVERY_MAX_RETRIES;
            let retryScheduled = false;
            const exhausted: ScheduledDeliveryJob[] = [];
            for (const job of execution.jobs) {
              const retry = await retryScheduledDeliveryJob(job.id, result.skipReason ?? "transient_skip", Date.now(), {
                delayMs: result.retryAfterMs ?? TRANSIENT_DELIVERY_RETRY_DELAY_MS,
                maxRetries,
              });
              if (retry.retried) {
                retryScheduled = true;
              } else {
                exhausted.push(job);
                await markScheduledDeliverySucceeded(job.id, Date.now());
              }
            }
            if (retryScheduled) {
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} skipped transiently (${result.skipReason}); retry scheduled`
              );
            }
            if (exhausted.length > 0) {
              if (execution.quietBatch) {
                settleAbandonedQuietPromises(exhausted, result.skipReason ?? "quiet_batch_render_unavailable");
              }
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} reached retry limit; consuming without user-facing fallback`
              );
            }
          } else {
            if (result.skipped && execution.quietBatch) {
              settleAbandonedQuietPromises(execution.jobs, result.skipReason ?? "quiet_batch_cancelled");
            }
            for (const job of execution.jobs) {
              await markScheduledDeliverySucceeded(job.id, Date.now());
            }
            options.log?.info?.(`[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} completed`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("scheduled_delivery_timeout:")) {
            let retryScheduled = false;
            const exhausted: ScheduledDeliveryJob[] = [];
            for (const job of execution.jobs) {
              const retry = await retryScheduledDeliveryJob(job.id, "scheduled_delivery_timeout", Date.now(), {
                delayMs: TRANSIENT_DELIVERY_RETRY_DELAY_MS,
                maxRetries: execution.quietBatch ? 1 : TRANSIENT_DELIVERY_MAX_RETRIES,
              });
              if (retry.retried) retryScheduled = true;
              else {
                exhausted.push(job);
                await markScheduledDeliverySucceeded(job.id, Date.now());
              }
            }
            if (retryScheduled) {
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} timed out; retry scheduled`
              );
            }
            if (exhausted.length > 0) {
              if (execution.quietBatch) {
                settleAbandonedQuietPromises(exhausted, "scheduled_delivery_timeout");
              }
              options.log?.warn?.(
                `[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} timed out after retry; consuming without user-facing fallback`
              );
            }
            continue;
          }
          markExecutionPromisesFailed(execution.jobs, message);
          for (const job of execution.jobs) {
            await markScheduledDeliveryFailed(job.id, message, Date.now());
          }
          options.log?.error?.(`[qqbot:${account.accountId}] Scheduled delivery batch ${primaryJob.id} crashed: ${message}`);
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
