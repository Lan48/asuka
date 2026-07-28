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
const BUILD_COMMANDS = ["npm ci --ignore-scripts", "npm test"];
const WINDOWS_DEPENDENCY_COMMANDS = ["npm ci --ignore-scripts"];
const RUNTIME_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "test",
  "tests",
  "__tests__",
  ".git",
]);
const REQUIRED_EXECUTABLE_HELPERS = [
  "ops/asuka-memory-sync.ps1",
  "ops/common.ps1",
  "ops/configure-memory-kernel.mjs",
  "ops/create-recovery-baseline.ps1",
  "ops/deploy.ps1",
  "ops/freeze-and-backup-v15.ps1",
  "ops/install-local-embedding.ps1",
  "ops/local-embedding-contract.json",
  "ops/normalize-task-actions.ps1",
  "ops/preflight.ps1",
  "ops/recover-v15-baseline.ps1",
  "ops/restore-vault-generated.mjs",
  "ops/rollback.ps1",
  "ops/start-local-embedding.ps1",
  "ops/verify-ledger.mjs",
  "ops/verify-model-config.mjs",
  "ops/verify.ps1",
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    const name = argument.slice(2);
    if (values.has(name)) throw new Error(`duplicate argument: ${argument}`);
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

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function treeSha256(entries, pathKey) {
  return createHash("sha256")
    .update(entries.map((entry) => `${entry.sha256}  ${entry[pathKey]}`).join("\n"))
    .digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function git(projectRoot, args) {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-C", projectRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireGit(projectRoot, args, label) {
  const result = git(projectRoot, args);
  if (!result.ok) throw new Error(`unable to read ${label} from Git`);
  return result.output;
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
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

function walkFiles(root, excludedDirectories = RUNTIME_EXCLUDED_DIRECTORIES) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const rootEntry = fs.lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`release input must be a regular directory: ${root}`);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `symbolic links are not allowed in release inputs: ${path.join(root, entry.name)}`,
      );
    }
    const directoryName = entry.name.toLowerCase();
    if (entry.isDirectory() && excludedDirectories.has(directoryName)) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, excludedDirectories));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function relativePosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const values = parseArgs(process.argv.slice(2));
const allowedArguments = new Set([
  "project-root",
  "release-root",
  "account",
  "peer",
  "identity",
  "app-root",
  "release-id",
  "openclaw-version",
  "node-version",
  "gateway-port",
  "gateway-task",
  "sync-task",
  "build-attestation",
  "windows-dependency-attestation",
]);
for (const name of values.keys()) {
  if (!allowedArguments.has(name)) throw new Error(`unsupported argument: --${name}`);
}
const projectRoot = path.resolve(required(values, "project-root"));
const releaseRoot = path.resolve(required(values, "release-root"));
const accountId = required(values, "account");
const peerId = required(values, "peer");
const identityId = values.get("identity") || undefined;
const appRoot = values.get("app-root") || String.raw`D:\app\asuka`;
const gitHead = requireGit(projectRoot, ["rev-parse", "HEAD"], "source commit");
const gitBranch = requireGit(projectRoot, ["branch", "--show-current"], "source branch");
const gitStatus = requireGit(
  projectRoot,
  ["status", "--porcelain=v1", "--untracked-files=all"],
  "worktree status",
);
const gitDirectory = path.resolve(requireGit(
  projectRoot,
  ["rev-parse", "--path-format=absolute", "--git-dir"],
  "worktree Git directory",
));
const commonDirectory = path.resolve(requireGit(
  projectRoot,
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  "common Git directory",
));
if (
  gitDirectory === commonDirectory
  || !/^[a-f0-9]{40}$/.test(gitHead)
  || !gitBranch
  || gitStatus
) {
  throw new Error("release generation requires a clean named linked worktree at a full Git commit");
}
if (requireGit(
  projectRoot,
  [
    "status",
    "--porcelain=v1",
    "--ignored",
    "--untracked-files=all",
    "--",
    "ops/windows/asuka-memory-v15",
  ],
  "ignored release-helper status",
)) {
  throw new Error("release helper tree contains ignored files outside the trusted Git source");
}
const releaseId = values.get("release-id")
  || `${gitHead.slice(0, 12)}-${Date.now()}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId)) {
  throw new Error("releaseId must contain only letters, numbers, dot, underscore, or hyphen");
}
if (
  releaseRoot === path.parse(releaseRoot).root
  || isSameOrInside(projectRoot, releaseRoot)
  || isSameOrInside(releaseRoot, projectRoot)
) {
  throw new Error("release root must be a dedicated directory outside the project tree");
}
if (fs.existsSync(releaseRoot)) {
  throw new Error("release root already exists; choose a new dedicated directory");
}
const expectedOpenClawVersion = values.get("openclaw-version") || "2026.7.1-2";
const expectedNodeVersion = values.get("node-version") || "v24.18.0";
if (!/^v\d+\.\d+\.\d+$/.test(expectedNodeVersion)) {
  throw new Error("node version must use the form vMAJOR.MINOR.PATCH");
}
const gatewayPort = Number(values.get("gateway-port") || "19001");
const gatewayTask = values.get("gateway-task") || "AsukaGateway";
const syncTask = values.get("sync-task") || "AsukaMemorySync";
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
  throw new Error("gateway port must be an integer between 1 and 65535");
}
for (const [label, taskName] of [["gateway", gatewayTask], ["sync", syncTask]]) {
  if (!/^[A-Za-z0-9_.-]+$/.test(taskName)) {
    throw new Error(`${label} task name contains unsafe characters`);
  }
}
if (gatewayTask === syncTask) {
  throw new Error("gateway and sync task names must be distinct");
}

const qqbotRoot = path.join(projectRoot, "extensions", "qqbot");
for (const directory of RUNTIME_DIRECTORIES) {
  const directoryPath = path.join(qqbotRoot, directory);
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    throw new Error(`required QQBot directory is missing: ${directory}`);
  }
}
const migrationRelative = path.join("scripts", "migrate-asuka-memory-v15.mjs");
assertRegularFile(path.join(qqbotRoot, migrationRelative), "migration script");
const lockfile = path.join(qqbotRoot, "package-lock.json");
assertRegularFile(lockfile, "QQBot package lockfile");
const sourceRuntimeFiles = [
  ...RUNTIME_DIRECTORIES.flatMap((directory) => (
    walkFiles(path.join(qqbotRoot, directory))
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
    const relative = relativePosix(qqbotRoot, file);
    return {
      destination: `home/.openclaw/extensions/qqbot/${relative}`,
      sha256: sha256(file),
    };
  })
  .sort((left, right) => compareText(left.destination, right.destination));
const attestedRuntimeTreeSha256 = treeSha256(sourceRuntimeFiles, "destination");
const buildAttestationPath = path.resolve(required(values, "build-attestation"));
const windowsDependencyAttestationPath = path.resolve(
  required(values, "windows-dependency-attestation"),
);
if (
  buildAttestationPath === windowsDependencyAttestationPath
  || isSameOrInside(buildAttestationPath, projectRoot)
  || isSameOrInside(windowsDependencyAttestationPath, projectRoot)
) {
  throw new Error("distinct build attestations must be stored outside the linked worktree");
}
assertRegularFile(buildAttestationPath, "build attestation");
assertRegularFile(windowsDependencyAttestationPath, "Windows dependency attestation");
const buildAttestation = JSON.parse(fs.readFileSync(buildAttestationPath, "utf8"));
const windowsDependencyAttestation = JSON.parse(
  fs.readFileSync(windowsDependencyAttestationPath, "utf8"),
);
const npmCli = resolveNpmCli();
const npmVersion = execFileSync(
  process.execPath,
  [npmCli, "--version"],
  { encoding: "utf8" },
).trim();
const lockfileSha256 = sha256(lockfile);
if (
  !hasExactKeys(buildAttestation, [
    "schemaVersion",
    "kind",
    "mode",
    "gitCommit",
    "gitBranch",
    "platform",
    "architecture",
    "nodeVersion",
    "npmVersion",
    "lockfilePath",
    "lockfileSha256",
    "commands",
    "runtimeTreeSha256",
  ])
  || buildAttestation.schemaVersion !== 1
  || buildAttestation.kind !== "release_build"
  || buildAttestation.mode !== "clean_linked_worktree"
  || buildAttestation.gitCommit !== gitHead
  || buildAttestation.gitBranch !== gitBranch
  || buildAttestation.platform !== process.platform
  || buildAttestation.architecture !== process.arch
  || buildAttestation.nodeVersion !== process.version
  || buildAttestation.nodeVersion !== expectedNodeVersion
  || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(buildAttestation.npmVersion)
  || buildAttestation.npmVersion !== npmVersion
  || buildAttestation.lockfilePath !== "extensions/qqbot/package-lock.json"
  || buildAttestation.lockfileSha256 !== lockfileSha256
  || !Array.isArray(buildAttestation.commands)
  || buildAttestation.commands.length !== BUILD_COMMANDS.length
  || buildAttestation.commands.some((command, index) => command !== BUILD_COMMANDS[index])
  || !/^[a-f0-9]{64}$/.test(buildAttestation.runtimeTreeSha256)
  || buildAttestation.runtimeTreeSha256 !== attestedRuntimeTreeSha256
) {
  throw new Error("build attestation does not match the clean linked-worktree release build");
}
const runtimeDependencyTree = windowsDependencyAttestation?.runtimeDependencyTree;
if (
  !hasExactKeys(windowsDependencyAttestation, [
    "schemaVersion",
    "kind",
    "mode",
    "gitCommit",
    "gitBranch",
    "platform",
    "architecture",
    "nodeVersion",
    "npmVersion",
    "lockfilePath",
    "lockfileSha256",
    "commands",
    "runtimeDependencyTree",
  ])
  || windowsDependencyAttestation.schemaVersion !== 1
  || windowsDependencyAttestation.kind !== "windows_runtime_dependencies"
  || windowsDependencyAttestation.mode !== "clean_linked_worktree"
  || windowsDependencyAttestation.gitCommit !== gitHead
  || windowsDependencyAttestation.gitBranch !== gitBranch
  || windowsDependencyAttestation.platform !== "win32"
  || windowsDependencyAttestation.architecture !== "x64"
  || windowsDependencyAttestation.nodeVersion !== expectedNodeVersion
  || windowsDependencyAttestation.npmVersion !== buildAttestation.npmVersion
  || windowsDependencyAttestation.lockfilePath !== "extensions/qqbot/package-lock.json"
  || windowsDependencyAttestation.lockfileSha256 !== lockfileSha256
  || !Array.isArray(windowsDependencyAttestation.commands)
  || windowsDependencyAttestation.commands.length !== WINDOWS_DEPENDENCY_COMMANDS.length
  || windowsDependencyAttestation.commands.some(
    (command, index) => command !== WINDOWS_DEPENDENCY_COMMANDS[index],
  )
  || !hasExactKeys(runtimeDependencyTree, ["path", "fileCount", "bytes", "sha256"])
  || runtimeDependencyTree.path !== "node_modules"
  || !Number.isSafeInteger(runtimeDependencyTree.fileCount)
  || runtimeDependencyTree.fileCount < 1
  || !Number.isSafeInteger(runtimeDependencyTree.bytes)
  || runtimeDependencyTree.bytes < 1
  || !/^[a-f0-9]{64}$/.test(runtimeDependencyTree.sha256)
) {
  throw new Error("Windows dependency attestation does not match the release source");
}

const opsSource = path.join(projectRoot, "ops", "windows", "asuka-memory-v15");
if (!fs.existsSync(opsSource) || !fs.statSync(opsSource).isDirectory()) {
  throw new Error("release helper directory is missing from the linked worktree");
}
const embeddingContractPath = path.join(opsSource, "local-embedding-contract.json");
assertRegularFile(embeddingContractPath, "local embedding contract");
const embeddingContract = JSON.parse(fs.readFileSync(embeddingContractPath, "utf8"));
const embeddingRuntime = embeddingContract.model?.runtime;
const embeddingRuntimeLayers = embeddingRuntime?.layers;
if (
  !hasExactKeys(embeddingContract, [
    "schemaVersion",
    "ollama",
    "task",
    "api",
    "model",
    "paths",
  ])
  || embeddingContract.schemaVersion !== 1
  || embeddingContract.ollama?.version !== "0.32.5"
  || embeddingContract.ollama?.signerOrganization !== "Ollama Inc."
  || !Number.isSafeInteger(embeddingContract.ollama?.executableBytes)
  || embeddingContract.ollama.executableBytes < 1
  || !/^[a-f0-9]{64}$/.test(embeddingContract.ollama?.executableSha256 ?? "")
  || embeddingContract.task?.name !== "AsukaEmbedding"
  || embeddingContract.api?.endpoint !== "http://127.0.0.1:11434/v1/embeddings"
  || typeof embeddingContract.api?.apiKey !== "string"
  || embeddingContract.api.apiKey.length < 1
  || typeof embeddingContract.model?.name !== "string"
  || !/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/.test(
    embeddingContract.model.name,
  )
  || embeddingContract.model.task !== "retrieval"
  || !Number.isSafeInteger(embeddingContract.model.dimensions)
  || embeddingContract.model.dimensions < 1
  || !/^[a-f0-9]{40}$/.test(embeddingContract.model.sourceRevision ?? "")
  || !Number.isSafeInteger(embeddingContract.model.sourceBytes)
  || embeddingContract.model.sourceBytes < 1
  || !/^[a-f0-9]{64}$/.test(embeddingContract.model.sourceSha256 ?? "")
  || !String(embeddingContract.model.sourceUrl ?? "").includes(
    embeddingContract.model.sourceRevision,
  )
  || !String(embeddingContract.model.sourceUrl ?? "").startsWith(
    "https://huggingface.co/jinaai/",
  )
  || !hasExactKeys(embeddingRuntime, [
    "manifestBytes",
    "manifestSha256",
    "config",
    "layers",
  ])
  || embeddingRuntime.manifestBytes !== 415
  || embeddingRuntime.manifestSha256
    !== "434bad391068826cb0565d7b96cf0456886149f7ae60a00eab590f01beac6945"
  || !hasExactKeys(embeddingRuntime.config, ["mediaType", "digest", "size"])
  || embeddingRuntime.config.mediaType
    !== "application/vnd.docker.container.image.v1+json"
  || embeddingRuntime.config.digest
    !== "sha256:f1922a92413bac87dda32999c8808fd16d68b16acae46db14a1581a951167f3c"
  || embeddingRuntime.config.size !== 268
  || !Array.isArray(embeddingRuntimeLayers)
  || embeddingRuntimeLayers.length !== 1
  || !hasExactKeys(embeddingRuntimeLayers[0], ["mediaType", "digest", "size"])
  || embeddingRuntimeLayers[0].mediaType
    !== "application/vnd.ollama.image.model"
  || embeddingRuntimeLayers[0].digest
    !== "sha256:741faa04ffc97e4c2ebe124c4e7fc4092170c3ebdb5957f7ab9088bea25c02ee"
  || embeddingRuntimeLayers[0].size !== 396705152
) {
  throw new Error("local embedding contract is not production-safe");
}
for (const requiredHelper of REQUIRED_EXECUTABLE_HELPERS) {
  assertRegularFile(
    path.join(opsSource, requiredHelper.slice("ops/".length)),
    "required release helper",
  );
}

fs.mkdirSync(releaseRoot, { recursive: true });
const payloadRoot = path.join(releaseRoot, "payload", "qqbot");
for (const directory of RUNTIME_DIRECTORIES) {
  for (const source of walkFiles(path.join(qqbotRoot, directory))) {
    const relative = path.relative(qqbotRoot, source);
    copyFile(source, path.join(payloadRoot, relative));
  }
}
for (const file of OPTIONAL_RUNTIME_FILES) {
  const source = path.join(qqbotRoot, file);
  if (fs.existsSync(source)) copyFile(source, path.join(payloadRoot, file));
}

const opsRoot = path.join(releaseRoot, "ops");
for (const source of walkFiles(opsSource)) {
  const name = path.basename(source);
  if (
    (name.startsWith("test-") && name.endsWith(".mjs"))
    || name === "release-manifest.json"
    || name.startsWith(".")
  ) {
    continue;
  }
  copyFile(source, path.join(opsRoot, path.relative(opsSource, source)));
}

const runtimeFiles = walkFiles(payloadRoot)
  .map((file) => {
    const relative = relativePosix(payloadRoot, file);
    return {
      source: `payload/qqbot/${relative}`,
      destination: `home/.openclaw/extensions/qqbot/${relative}`,
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    };
  })
  .sort((left, right) => (
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0
  ));
const runtimeTreeSha256 = treeSha256(runtimeFiles, "destination");
const opsFiles = walkFiles(opsRoot)
  .map((file) => ({
    source: `ops/${relativePosix(opsRoot, file)}`,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  }))
  .sort((left, right) => (
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0
  ));
const syncWorkerSource = "ops/asuka-memory-sync.ps1";
const syncWorkerEntry = opsFiles.find((entry) => entry.source === syncWorkerSource);
if (!syncWorkerEntry) {
  throw new Error(`sync worker is missing from the release: ${syncWorkerSource}`);
}
if (runtimeTreeSha256 !== attestedRuntimeTreeSha256) {
  throw new Error("copied runtime tree does not match the build attestation");
}
for (const requiredHelper of REQUIRED_EXECUTABLE_HELPERS) {
  if (opsFiles.filter((entry) => entry.source === requiredHelper).length !== 1) {
    throw new Error(`required executable helper is not uniquely listed: ${requiredHelper}`);
  }
}
if (
  requireGit(projectRoot, ["rev-parse", "HEAD"], "source commit") !== gitHead
  || requireGit(projectRoot, ["branch", "--show-current"], "source branch") !== gitBranch
  || requireGit(
    projectRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "worktree status",
  )
  || requireGit(
    projectRoot,
    [
      "status",
      "--porcelain=v1",
      "--ignored",
      "--untracked-files=all",
      "--",
      "ops/windows/asuka-memory-v15",
    ],
    "ignored release-helper status",
  )
) {
  throw new Error("release source changed while the manifest was generated");
}
const manifest = {
  schemaVersion: 1,
  releaseId,
  generatedAt: new Date().toISOString(),
  appRoot,
  source: {
    provenance: "git",
    gitCommit: gitHead,
    gitBranch,
    worktreeDirty: false,
    worktreeStatus: [],
    runtimeTreeSha256,
    buildAttestation,
    windowsDependencyAttestation,
  },
  requirements: {
    openClawVersion: expectedOpenClawVersion,
    nodeVersion: expectedNodeVersion,
    minimumFreeBytes: 12 * 1024 * 1024 * 1024,
    gatewayPort,
    tasks: {
      gateway: gatewayTask,
      sync: syncTask,
    },
    embedding: {
      contractSource: "ops/local-embedding-contract.json",
      contractSha256: sha256(embeddingContractPath),
      ...embeddingContract,
    },
    requiredModules: ["sqlite-vec"],
  },
  runtimeFiles,
  runtimePreservedDirectories: ["node_modules"],
  runtimeDependencyTree: {
    path: "node_modules",
    platform: windowsDependencyAttestation.platform,
    architecture: windowsDependencyAttestation.architecture,
    fileCount: runtimeDependencyTree.fileCount,
    bytes: runtimeDependencyTree.bytes,
    sha256: runtimeDependencyTree.sha256,
  },
  opsFiles,
  requiredExecutableHelpers: REQUIRED_EXECUTABLE_HELPERS,
  syncWorker: {
    source: syncWorkerEntry.source,
    destination: "asuka-memory-sync.ps1",
    bytes: syncWorkerEntry.bytes,
    sha256: syncWorkerEntry.sha256,
  },
  migration: {
    script: "home/.openclaw/extensions/qqbot/scripts/migrate-asuka-memory-v15.mjs",
    database: "home/.openclaw/qqbot/data/asuka-memory/memory-ledger.sqlite",
    accountId,
    peerId,
    ...(identityId ? { identityId } : {}),
    sources: {
      memory: "home/.openclaw/qqbot/data/asuka-memory/memory.json",
      claims: "obsidian-vault/Asuka/Memory/.openclaw-wiki/cache/claims.jsonl",
      state: "home/.openclaw/qqbot/data/asuka-state/state.json",
      digest: "home/.openclaw/qqbot/data/asuka-conversation-digest/digest.json",
      refIndex: "home/.openclaw/qqbot/data/ref-index.jsonl",
      sessionsIndex: "home/.openclaw/agents/main/sessions/sessions.json",
      sessionsDirectory: "home/.openclaw/agents/main/sessions",
    },
  },
};

fs.writeFileSync(
  path.join(releaseRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  {
    encoding: "utf8",
    flag: "wx",
  },
);
process.stdout.write(`${JSON.stringify({
  ok: true,
  operation: "generate-manifest",
  releaseRoot,
  releaseId,
  runtimeFiles: runtimeFiles.length,
  worktreeDirty: manifest.source.worktreeDirty,
  runtimeTreeSha256: manifest.source.runtimeTreeSha256,
})}\n`);
