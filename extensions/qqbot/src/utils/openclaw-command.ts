import { execFile, type ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface OpenClawInvocation {
  command: string;
  prefixArgs: string[];
}

function isWindows(): boolean {
  return process.platform === "win32";
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
