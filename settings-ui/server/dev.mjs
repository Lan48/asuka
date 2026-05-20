import { spawn } from "node:child_process";
import process from "node:process";

const children = [];
const isWindows = process.platform === "win32";

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: options.shell ?? false,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`[settings-ui] ${label} exited with ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (child.killed) continue;
    if (isWindows) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: true });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", process.execPath, ["server/server.mjs"]);
start("vite", isWindows ? "npm.cmd" : "npm", ["run", "web", "--", "--host", process.env.SETTINGS_UI_HOST || "127.0.0.1"], { shell: isWindows });
