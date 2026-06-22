import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeCronPayload } from "./utils/payload.js";

export interface ScheduledDeliveryScheduleAt {
  kind: "at";
  at: string;
}

export interface ScheduledDeliveryScheduleCron {
  kind: "cron";
  expr: string;
  tz?: string;
}

export type ScheduledDeliverySchedule = ScheduledDeliveryScheduleAt | ScheduledDeliveryScheduleCron;

export interface ScheduledDeliveryJob {
  id: string;
  name: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  createdAtMs: number;
  accountId?: string;
  to: string;
  message: string;
  schedule: ScheduledDeliverySchedule;
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    runCount?: number;
    retryCount?: number;
    lastError?: string;
    updatedAtMs?: number;
  };
}

export interface ScheduledDeliveryCreateInput {
  name: string;
  accountId?: string;
  to: string;
  message: string;
  schedule: ScheduledDeliverySchedule;
  deleteAfterRun?: boolean;
  nowMs?: number;
}

interface ScheduledDeliveryStore {
  version: 1;
  jobs: ScheduledDeliveryJob[];
}

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

const CRON_PREFIX = "QQBOT_CRON:";
const STORE_FILE_NAME = "scheduled-deliveries.json";
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_AFTER_MS = 30_000;
const DEFAULT_TIMEZONE = "Asia/Shanghai";

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir() || os.tmpdir();
}

export function getScheduledDeliveryStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHome(env), ".openclaw", "qqbot", "data", STORE_FILE_NAME);
}

export function extractRawQQBotCronMessage(text: string): string | null {
  const prefixIndex = text.indexOf(CRON_PREFIX);
  if (prefixIndex < 0) return null;
  const remainder = text.slice(prefixIndex + CRON_PREFIX.length).trim();
  const base64 = remainder.match(/^([A-Za-z0-9+/=]+)/)?.[1] ?? "";
  if (!base64) return null;
  const raw = `${CRON_PREFIX}${base64}`;
  const decoded = decodeCronPayload(raw);
  return decoded.isCronPayload && decoded.payload && !decoded.error ? raw : null;
}

function normalizeStore(raw: unknown): ScheduledDeliveryStore {
  if (!raw || typeof raw !== "object") return { version: 1, jobs: [] };
  const jobs = Array.isArray((raw as { jobs?: unknown }).jobs)
    ? (raw as { jobs: unknown[] }).jobs.filter(isScheduledDeliveryJob)
    : [];
  return { version: 1, jobs };
}

function isScheduledDeliveryJob(value: unknown): value is ScheduledDeliveryJob {
  if (!value || typeof value !== "object") return false;
  const job = value as ScheduledDeliveryJob;
  return typeof job.id === "string"
    && typeof job.name === "string"
    && typeof job.to === "string"
    && typeof job.message === "string"
    && Boolean(job.schedule)
    && typeof job.schedule === "object";
}

async function loadStore(storePath: string): Promise<ScheduledDeliveryStore> {
  try {
    return normalizeStore(JSON.parse(await fs.promises.readFile(storePath, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw error;
  }
}

async function saveStore(storePath: string, store: ScheduledDeliveryStore): Promise<void> {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, storePath);
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
}

async function acquireStoreLock(storePath: string): Promise<() => Promise<void>> {
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf-8");
      await handle.close();
      return async () => {
        await fs.promises.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_AFTER_MS) {
          await fs.promises.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for scheduled delivery store lock: ${lockPath}`);
      }
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }
}

async function mutateStore<T>(
  env: NodeJS.ProcessEnv,
  mutator: (store: ScheduledDeliveryStore, storePath: string) => Promise<T> | T,
): Promise<T> {
  const storePath = getScheduledDeliveryStorePath(env);
  const release = await acquireStoreLock(storePath);
  try {
    const store = await loadStore(storePath);
    const result = await mutator(store, storePath);
    await saveStore(storePath, store);
    return result;
  } finally {
    await release();
  }
}

function parseCronField(field: string, min: number, max: number, aliases?: Record<string, number>): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) return null;
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [left, right] = rangePart.split("-");
      start = parseCronValue(left, aliases);
      end = parseCronValue(right, aliases);
    } else {
      start = parseCronValue(rangePart, aliases);
      end = start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      return null;
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function parseCronValue(value: string, aliases?: Record<string, number>): number {
  if (aliases?.[value] !== undefined) return aliases[value];
  return Number(value);
}

function isWildcardCronField(field: string): boolean {
  return field.trim() === "*";
}

function getZonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zonedFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  zonedFormatterCache.set(timeZone, formatter);
  return formatter;
}

function getZonedParts(date: Date, timeZone: string): {
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const parts = getZonedFormatter(timeZone).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = pick("weekday").slice(0, 3).toLowerCase();
  const dayOfWeek = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekday);
  return {
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    dayOfWeek: dayOfWeek >= 0 ? dayOfWeek : date.getUTCDay(),
  };
}

function computeNextCronRunAtMs(expr: string, timeZone: string | undefined, fromMs: number): number | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const monthAliases = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const dowAliases = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const days = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12, monthAliases);
  const weekdaysRaw = parseCronField(fields[4], 0, 7, dowAliases);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return undefined;
  const weekdays = new Set([...weekdaysRaw].map((value) => value === 7 ? 0 : value));
  const dayFieldWildcard = isWildcardCronField(fields[2]);
  const weekdayFieldWildcard = isWildcardCronField(fields[4]);
  const tz = timeZone?.trim() || DEFAULT_TIMEZONE;
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const maxIterations = 366 * 24 * 60;

  for (let index = 0; index < maxIterations; index++) {
    const candidateMs = start + index * 60_000;
    const parts = getZonedParts(new Date(candidateMs), tz);
    if (!minutes.has(parts.minute) || !hours.has(parts.hour) || !months.has(parts.month)) continue;
    const dayMatches = days.has(parts.day);
    const weekdayMatches = weekdays.has(parts.dayOfWeek);
    const calendarMatches = dayFieldWildcard && weekdayFieldWildcard
      ? true
      : dayFieldWildcard
        ? weekdayMatches
        : weekdayFieldWildcard
          ? dayMatches
          : dayMatches || weekdayMatches;
    if (calendarMatches) return candidateMs;
  }
  return undefined;
}

export function computeScheduledDeliveryNextRunAtMs(
  schedule: ScheduledDeliverySchedule,
  fromMs = Date.now(),
): number | undefined {
  if (schedule.kind === "at") {
    const atMs = new Date(schedule.at).getTime();
    return Number.isFinite(atMs) && atMs >= 0 ? atMs : undefined;
  }
  return computeNextCronRunAtMs(schedule.expr, schedule.tz, fromMs);
}

export async function addScheduledDeliveryJob(
  input: ScheduledDeliveryCreateInput,
  options: { env?: NodeJS.ProcessEnv; log?: LoggerLike } = {},
): Promise<{ jobId: string; job: ScheduledDeliveryJob; storePath: string } | { error: string }> {
  try {
    const rawMessage = extractRawQQBotCronMessage(input.message);
    if (!rawMessage) return { error: "message does not contain a valid QQBOT_CRON payload" };
    const nowMs = input.nowMs ?? Date.now();
    const nextRunAtMs = computeScheduledDeliveryNextRunAtMs(input.schedule, nowMs);
    if (nextRunAtMs === undefined) return { error: `unsupported scheduled delivery schedule: ${JSON.stringify(input.schedule)}` };
    const job: ScheduledDeliveryJob = {
      id: randomUUID(),
      name: input.name,
      enabled: true,
      deleteAfterRun: input.deleteAfterRun || input.schedule.kind === "at",
      createdAtMs: nowMs,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      to: input.to,
      message: rawMessage,
      schedule: input.schedule,
      state: { nextRunAtMs, updatedAtMs: nowMs },
    };
    const storePath = await mutateStore(options.env ?? process.env, (store, currentStorePath) => {
      store.jobs = store.jobs.filter((existing) => existing.id !== job.id);
      store.jobs.push(job);
      return currentStorePath;
    });
    return { jobId: job.id, job, storePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.warn?.(`[scheduled-delivery] failed to add job: ${message}`);
    return { error: message };
  }
}

export async function removeScheduledDeliveryJob(
  jobId: string,
  options: { env?: NodeJS.ProcessEnv; log?: LoggerLike } = {},
): Promise<{ removedCount: number; storePath: string } | { error: string }> {
  const id = jobId.trim();
  if (!id) return { error: "missing scheduled delivery job id" };
  try {
    let removedCount = 0;
    const storePath = await mutateStore(options.env ?? process.env, (store, currentStorePath) => {
      const before = store.jobs.length;
      store.jobs = store.jobs.filter((job) => job.id !== id);
      removedCount = before - store.jobs.length;
      return currentStorePath;
    });
    return { removedCount, storePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.warn?.(`[scheduled-delivery] failed to remove job ${id}: ${message}`);
    return { error: message };
  }
}

export async function removeScheduledDeliveryJobsForPeer(
  input: {
    accountId?: string;
    peerKey: string;
    modes?: string[];
  },
  options: { env?: NodeJS.ProcessEnv; log?: LoggerLike } = {},
): Promise<{ removedCount: number; jobIds: string[]; storePath: string } | { error: string }> {
  const peerKey = input.peerKey.trim();
  if (!peerKey) return { error: "missing scheduled delivery peerKey" };
  const modes = new Set((input.modes ?? []).map((mode) => mode.trim()).filter(Boolean));
  try {
    let removedCount = 0;
    const jobIds: string[] = [];
    const storePath = await mutateStore(options.env ?? process.env, (store, currentStorePath) => {
      const kept: ScheduledDeliveryJob[] = [];
      for (const job of store.jobs) {
        if (input.accountId && job.accountId && job.accountId !== input.accountId) {
          kept.push(job);
          continue;
        }
        const decoded = decodeCronPayload(job.message);
        const payload = decoded.payload;
        const matchesPeer = decoded.isCronPayload && payload?.peerKey === peerKey;
        const matchesMode = modes.size === 0 || (payload?.mode ? modes.has(payload.mode) : false);
        if (matchesPeer && matchesMode) {
          removedCount += 1;
          jobIds.push(job.id);
        } else {
          kept.push(job);
        }
      }
      store.jobs = kept;
      return currentStorePath;
    });
    return { removedCount, jobIds, storePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.warn?.(`[scheduled-delivery] failed to remove peer jobs ${peerKey}: ${message}`);
    return { error: message };
  }
}

export async function listDueScheduledDeliveryJobs(
  accountId: string,
  nowMs = Date.now(),
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ScheduledDeliveryJob[]> {
  const store = await loadStore(getScheduledDeliveryStorePath(options.env ?? process.env));
  return store.jobs.filter((job) => {
    if (!job.enabled) return false;
    if (job.accountId && job.accountId !== accountId) return false;
    const nextRunAtMs = job.state?.nextRunAtMs;
    return typeof nextRunAtMs === "number" && nextRunAtMs <= nowMs;
  });
}

export async function markScheduledDeliverySucceeded(
  jobId: string,
  nowMs = Date.now(),
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await mutateStore(options.env ?? process.env, (store) => {
    const index = store.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) return;
    const job = store.jobs[index];
    if (job.deleteAfterRun || job.schedule.kind === "at") {
      store.jobs.splice(index, 1);
      return;
    }
    const nextRunAtMs = computeScheduledDeliveryNextRunAtMs(job.schedule, nowMs + 1_000);
    job.state = {
      ...job.state,
      nextRunAtMs,
      lastRunAtMs: nowMs,
      runCount: (job.state?.runCount ?? 0) + 1,
      retryCount: undefined,
      lastError: undefined,
      updatedAtMs: nowMs,
    };
  });
}

export async function retryScheduledDeliveryJob(
  jobId: string,
  reason: string,
  nowMs = Date.now(),
  options: { env?: NodeJS.ProcessEnv; delayMs?: number; maxRetries?: number } = {},
): Promise<{ retried: boolean; retryCount: number; nextRunAtMs?: number }> {
  let result = { retried: false, retryCount: 0, nextRunAtMs: undefined as number | undefined };
  const delayMs = Math.max(60_000, options.delayMs ?? 10 * 60 * 1000);
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  await mutateStore(options.env ?? process.env, (store) => {
    const job = store.jobs.find((existing) => existing.id === jobId);
    if (!job) return;
    const retryCount = (job.state?.retryCount ?? 0) + 1;
    result = { retried: retryCount <= maxRetries, retryCount, nextRunAtMs: undefined };
    if (!result.retried) return;
    const nextRunAtMs = nowMs + delayMs * Math.min(4, 2 ** (retryCount - 1));
    job.enabled = true;
    job.state = {
      ...job.state,
      nextRunAtMs,
      lastRunAtMs: nowMs,
      runCount: (job.state?.runCount ?? 0) + 1,
      retryCount,
      lastError: reason,
      updatedAtMs: nowMs,
    };
    result.nextRunAtMs = nextRunAtMs;
  });
  return result;
}

export async function markScheduledDeliveryFailed(
  jobId: string,
  error: string,
  nowMs = Date.now(),
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await mutateStore(options.env ?? process.env, (store) => {
    const job = store.jobs.find((existing) => existing.id === jobId);
    if (!job) return;
    const nextRunAtMs = job.schedule.kind === "cron" && !job.deleteAfterRun
      ? computeScheduledDeliveryNextRunAtMs(job.schedule, nowMs + 1_000)
      : undefined;
    job.enabled = Boolean(nextRunAtMs);
    job.state = {
      ...job.state,
      nextRunAtMs,
      lastRunAtMs: nowMs,
      runCount: (job.state?.runCount ?? 0) + 1,
      lastError: error,
      updatedAtMs: nowMs,
    };
  });
}
