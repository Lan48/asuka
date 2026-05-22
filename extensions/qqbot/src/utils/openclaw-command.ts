import { execFile, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface OpenClawInvocation {
  command: string;
  prefixArgs: string[];
}

interface LoggerLike {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

interface ParsedCronAddArgs {
  accountId?: string;
  name: string;
  at?: string;
  cron?: string;
  tz?: string;
  deleteAfterRun: boolean;
  channel?: string;
  model?: string;
  to?: string;
  message: string;
}

interface DirectCronStore {
  version: 1;
  jobs: DirectCronJob[];
}

type DirectCronJob = Record<string, unknown> & { id?: unknown };

function isWindows(): boolean {
  return process.platform === "win32";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldAvoidOpenClawCliRecursion(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.QQBOT_ALLOW_OPENCLAW_CLI_REENTRY === "1") return false;
  if (env.OPENCLAW_WRAPPER?.trim()) return false;
  const argv = process.argv.map((item) => item.toLowerCase());
  return argv.some((item) => item === "gateway")
    && argv.some((item) => item.includes("openclaw"));
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH || env.Path || env.path || "";
  return rawPath.split(path.delimiter).filter(Boolean);
}

function executableCandidates(command: string): string[] {
  if (!isWindows()) return [command];
  const ext = path.extname(command);
  if (ext) return [command];
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [command, ...pathext.map((item) => `${command}${item}`)];
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  for (const dir of pathEntries(env)) {
    for (const candidate of executableCandidates(command)) {
      const resolved = path.join(dir, candidate);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  return null;
}

function normalizeInvocation(command: string): OpenClawInvocation {
  const ext = path.extname(command).toLowerCase();
  if (isWindows()) {
    if (ext === ".cmd" || ext === ".bat") {
      return {
        command: process.env.ComSpec || "cmd.exe",
        prefixArgs: ["/d", "/s", "/c", command],
      };
    }
    if (!ext || ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return {
        command: process.execPath,
        prefixArgs: [command],
      };
    }
  }
  return { command, prefixArgs: [] };
}

export function resolveOpenClawInvocation(env: NodeJS.ProcessEnv = process.env): OpenClawInvocation {
  const script = env.OPENCLAW_SCRIPT?.trim();
  if (script) {
    return { command: process.execPath, prefixArgs: [script] };
  }

  const wrapper = env.OPENCLAW_WRAPPER?.trim();
  if (wrapper) {
    return normalizeInvocation(wrapper);
  }

  const fromPath = findOnPath("openclaw", env);
  if (fromPath) {
    return normalizeInvocation(fromPath);
  }

  return { command: "openclaw", prefixArgs: [] };
}

export async function execOpenClaw(args: string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const env = options.env ?? process.env;
  const invocation = resolveOpenClawInvocation(env);
  const result = await execFileAsync(invocation.command, [...invocation.prefixArgs, ...args], options) as {
    stdout: string | Buffer;
    stderr: string | Buffer;
  };
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function parseCronAddArgs(args: string[]): ParsedCronAddArgs | null {
  if (args[0] !== "cron" || args[1] !== "add") return null;
  const name = readFlagValue(args, "--name")?.trim();
  const message = readFlagValue(args, "--message");
  if (!name || !message) return null;
  const at = readFlagValue(args, "--at")?.trim();
  const cron = readFlagValue(args, "--cron")?.trim();
  if (!at && !cron) return null;
  return {
    accountId: readFlagValue(args, "--account")?.trim() || undefined,
    name,
    at,
    cron,
    tz: readFlagValue(args, "--tz")?.trim() || undefined,
    deleteAfterRun: args.includes("--delete-after-run"),
    channel: readFlagValue(args, "--channel")?.trim() || undefined,
    model: readFlagValue(args, "--model")?.trim() || undefined,
    to: readFlagValue(args, "--to")?.trim() || undefined,
    message,
  };
}

function resolveHomeRelative(input: string, env: NodeJS.ProcessEnv): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveCronStoreCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || (configPath ? path.dirname(configPath) : undefined);
  let hasConfiguredStore = false;

  if (configPath && fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { cron?: { store?: unknown } };
      const configuredStore = typeof config.cron?.store === "string" ? config.cron.store.trim() : "";
      if (configuredStore) {
        const resolved = path.isAbsolute(configuredStore)
          ? configuredStore
          : path.resolve(resolveHomeRelative(configuredStore, env));
        candidates.push(resolved);
        hasConfiguredStore = true;
      }
    } catch {
      // Ignore optional config parsing here; the normal CLI path already reports config errors.
    }
  }

  if (hasConfiguredStore) {
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  }

  if (stateDir) {
    candidates.push(path.resolve(resolveHomeRelative(stateDir, env), "cron", "jobs.json"));
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  }

  const cwdStore = path.resolve(process.cwd(), "cron", "jobs.json");
  if (fs.existsSync(cwdStore)) {
    candidates.push(cwdStore);
  }

  const homeStore = path.resolve(os.homedir(), ".openclaw", "cron", "jobs.json");
  if (fs.existsSync(homeStore)) {
    candidates.push(homeStore);
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

async function loadCronStore(storePath: string): Promise<DirectCronStore> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(storePath, "utf-8")) as { version?: unknown; jobs?: unknown };
    return {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs.filter(Boolean) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw error;
  }
}

async function saveCronStore(storePath: string, store: DirectCronStore): Promise<void> {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, storePath);
  await fs.promises.chmod(storePath, 0o600).catch(() => undefined);
}

async function acquireCronStoreLock(storePath: string): Promise<() => Promise<void>> {
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();
  const timeoutMs = 5_000;
  const staleAfterMs = 30_000;

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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          await fs.promises.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for cron store lock: ${lockPath}`);
      }
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }
}

export async function addCronJobDirectFromArgs(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; log?: LoggerLike } = {}
): Promise<{ jobId: string; storePaths: string[] } | { error: string }> {
  try {
    const parsed = parseCronAddArgs(args);
    if (!parsed) return { error: "unsupported cron add args" };
    const storePaths = resolveCronStoreCandidates(options.env ?? process.env);
    if (storePaths.length === 0) return { error: "no cron store path resolved" };

    const jobId = randomUUID();
    const createdAtMs = Date.now();
    const job = {
      id: jobId,
      name: parsed.name,
      enabled: true,
      deleteAfterRun: parsed.deleteAfterRun || Boolean(parsed.at),
      createdAtMs,
      schedule: parsed.at
        ? { kind: "at", at: parsed.at }
        : { kind: "cron", expr: parsed.cron, ...(parsed.tz ? { tz: parsed.tz } : {}) },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: parsed.message,
        ...(parsed.model ? { model: parsed.model } : {}),
      },
      delivery: {
        mode: "announce",
        ...(parsed.channel ? { channel: parsed.channel } : {}),
        ...(parsed.to ? { to: parsed.to } : {}),
        ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
      },
      state: {},
    };

    const written: string[] = [];
    for (const storePath of storePaths) {
      const release = await acquireCronStoreLock(storePath);
      try {
        const store = await loadCronStore(storePath);
        store.jobs = store.jobs.filter((existing) => existing?.id !== jobId);
        store.jobs.push(job);
        await saveCronStore(storePath, store);
        written.push(storePath);
      } finally {
        await release();
      }
    }
    options.log?.info?.(`[openclaw-command] cron add wrote directly to store: ${written.join(", ")}`);
    return { jobId, storePaths: written };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}
