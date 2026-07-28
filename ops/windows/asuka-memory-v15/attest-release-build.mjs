#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RUNTIME_DIRECTORIES = ["bin", "dist", "scripts", "skills", "src"];
const OPTIONAL_RUNTIME_FILES = [
  "clawdbot.plugin.json",
  "index.ts",
  "LICENSE",
  "moltbot.plugin.json",
  "openclaw.plugin.json",
  "package.json",
  "README.md",
  "README.zh.md",
  "tsconfig.json",
];
const VENDORED_CRON_PATCH_COMMAND = "node scripts/patch-runtime-cron.mjs --vendored-only";
const BUILD_COMMANDS = [
  "npm ci --ignore-scripts",
  VENDORED_CRON_PATCH_COMMAND,
  "npm test",
];
const WINDOWS_DEPENDENCY_COMMANDS = [
  "npm ci --ignore-scripts",
  VENDORED_CRON_PATCH_COMMAND,
];
const RUNTIME_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "test",
  "tests",
  "__tests__",
  ".git",
]);

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`duplicate argument: ${key}`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function git(projectRoot, args) {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertRegularFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`);
  const entry = fs.lstatSync(file);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a regular file: ${file}`);
  }
}

function resolveNpmCli() {
  const configured = process.env.npm_execpath;
  const candidate = configured === undefined
    ? path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    )
    : configured;
  const binRoot = path.dirname(candidate);
  const npmRoot = path.dirname(binRoot);
  const nodeModulesRoot = path.dirname(npmRoot);
  if (
    !path.isAbsolute(candidate)
    || path.basename(candidate) !== "npm-cli.js"
    || path.basename(binRoot) !== "bin"
    || path.basename(npmRoot) !== "npm"
    || path.basename(nodeModulesRoot) !== "node_modules"
  ) {
    throw new Error("npm_execpath must identify a trusted npm CLI path");
  }
  const npmCli = path.resolve(candidate);
  assertRegularFile(npmCli, "npm CLI");
  return npmCli;
}

function walkFiles(root, excludedDirectories = new Set()) {
  const files = [];
  if (!fs.existsSync(root)) {
    throw new Error(`required directory is missing: ${root}`);
  }
  const rootEntry = fs.lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`release build input must be a regular directory: ${root}`);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `symbolic links are not allowed in a release build: ${path.join(root, entry.name)}`,
      );
    }
    const name = entry.name.toLowerCase();
    if (entry.isDirectory() && excludedDirectories.has(name)) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, excludedDirectories));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeTreeSha256(qqbotRoot) {
  const files = [
    ...RUNTIME_DIRECTORIES.flatMap((directory) => (
      walkFiles(path.join(qqbotRoot, directory), RUNTIME_EXCLUDED_DIRECTORIES)
    )),
    ...OPTIONAL_RUNTIME_FILES
      .map((file) => path.join(qqbotRoot, file))
      .filter((file) => {
        if (!fs.existsSync(file)) return false;
        assertRegularFile(file, "runtime source");
        return true;
      }),
  ]
    .map((file) => {
      const relative = path.relative(qqbotRoot, file).split(path.sep).join("/");
      return {
        destination: `home/.openclaw/extensions/qqbot/${relative}`,
        sha256: sha256(file),
      };
    })
    .sort((left, right) => compareText(left.destination, right.destination));
  return createHash("sha256")
    .update(files.map((entry) => `${entry.sha256}  ${entry.destination}`).join("\n"))
    .digest("hex");
}

function directoryIntegrity(root) {
  const files = walkFiles(root)
    .map((file) => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    }))
    .sort((left, right) => compareText(left.path, right.path));
  return {
    fileCount: files.length,
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    sha256: createHash("sha256")
      .update(files.map((entry) => `${entry.sha256}\t${entry.bytes}\t${entry.path}`).join("\n"))
      .digest("hex"),
  };
}

const values = parseArgs(process.argv.slice(2));
for (const name of values.keys()) {
  if (!["kind", "project-root", "output"].includes(name)) {
    throw new Error(`unsupported argument: --${name}`);
  }
}
const kind = required(values, "kind");
if (kind !== "build" && kind !== "windows-dependencies") {
  throw new Error("--kind must be build or windows-dependencies");
}
if (
  kind === "windows-dependencies"
  && (process.platform !== "win32" || process.arch !== "x64")
) {
  throw new Error("Windows dependency attestations require win32/x64");
}
const projectRoot = path.resolve(required(values, "project-root"));
const output = path.resolve(required(values, "output"));
const qqbotRoot = path.join(projectRoot, "extensions", "qqbot");
const distRoot = path.join(qqbotRoot, "dist");
const dependencyRoot = path.join(qqbotRoot, "node_modules");
const lockfile = path.join(qqbotRoot, "package-lock.json");
if (isSameOrInside(output, projectRoot)) {
  throw new Error("build attestation output must be outside the linked worktree");
}
if (fs.existsSync(output)) {
  throw new Error("build attestation output already exists");
}
const gitDirectory = path.resolve(
  git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
);
const commonDirectory = path.resolve(
  git(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
);
if (gitDirectory === commonDirectory) {
  throw new Error("release builds require a linked worktree");
}
const gitCommit = git(projectRoot, ["rev-parse", "HEAD"]);
const gitBranch = git(projectRoot, ["branch", "--show-current"]);
if (!/^[a-f0-9]{40}$/.test(gitCommit) || !gitBranch) {
  throw new Error("linked worktree must have a named branch at a full Git commit");
}
if (git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) {
  throw new Error("linked worktree must be clean before the release build");
}
if (fs.existsSync(distRoot)) {
  throw new Error("dist must not exist before the release build");
}
if (fs.existsSync(dependencyRoot)) {
  throw new Error("node_modules must not exist before the release build");
}
if (
  git(projectRoot, [
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=all",
    "--",
    "extensions/qqbot",
  ])
) {
  throw new Error("linked worktree must not contain pre-existing ignored QQBot files");
}
assertRegularFile(lockfile, "QQBot package lockfile");
git(projectRoot, [
  "ls-files",
  "--error-unmatch",
  "--",
  "extensions/qqbot/package-lock.json",
]);
const lockfileSha256 = sha256(lockfile);

const npmCli = resolveNpmCli();
const npmVersion = execFileSync(
  process.execPath,
  [npmCli, "--version"],
  { encoding: "utf8" },
).trim();
if (
  !/^v\d+\.\d+\.\d+$/.test(process.version)
  || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion)
) {
  throw new Error("release build requires canonical Node.js and npm versions");
}
execFileSync(process.execPath, [npmCli, "ci", "--ignore-scripts"], {
  cwd: qqbotRoot,
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [path.join(qqbotRoot, "scripts", "patch-runtime-cron.mjs"), "--vendored-only"],
  {
    cwd: qqbotRoot,
    stdio: "inherit",
  },
);
if (kind === "build") {
  execFileSync(process.execPath, [npmCli, "test"], {
    cwd: qqbotRoot,
    stdio: "inherit",
  });
}
if (kind === "build" && !fs.existsSync(path.join(distRoot, "index.js"))) {
  throw new Error("release build did not produce dist/index.js");
}
if (kind === "windows-dependencies" && fs.existsSync(distRoot)) {
  throw new Error("Windows dependency installation unexpectedly produced dist");
}
if (
  git(projectRoot, ["rev-parse", "HEAD"]) !== gitCommit
  || git(projectRoot, ["branch", "--show-current"]) !== gitBranch
  || git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
) {
  throw new Error("release build changed the linked worktree source or Git identity");
}
if (sha256(lockfile) !== lockfileSha256) {
  throw new Error("release build changed the package lockfile");
}
const attestation = {
  schemaVersion: 1,
  kind: kind === "build" ? "release_build" : "windows_runtime_dependencies",
  mode: "clean_linked_worktree",
  gitCommit,
  gitBranch,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  npmVersion,
  lockfilePath: "extensions/qqbot/package-lock.json",
  lockfileSha256,
  commands: kind === "build" ? BUILD_COMMANDS : WINDOWS_DEPENDENCY_COMMANDS,
};
if (kind === "build") {
  attestation.runtimeTreeSha256 = runtimeTreeSha256(qqbotRoot);
} else {
  const runtimeDependencyTree = directoryIntegrity(dependencyRoot);
  if (runtimeDependencyTree.fileCount < 1 || runtimeDependencyTree.bytes < 1) {
    throw new Error("release build produced an empty runtime dependency tree");
  }
  attestation.runtimeDependencyTree = {
    path: "node_modules",
    ...runtimeDependencyTree,
  };
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(attestation, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(`${JSON.stringify({ ok: true, output, ...attestation })}\n`);
