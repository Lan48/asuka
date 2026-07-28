#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const memoryPath = "Asuka/Memory";
const opsRoot = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(opsRoot, "asuka-memory-sync.ps1");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-sync-"));
const origin = path.join(fixtureRoot, "origin.git");
const worker = path.join(fixtureRoot, "worker");
const peer = path.join(fixtureRoot, "peer");
const statusPath = path.join(fixtureRoot, "asuka-memory-sync-status.json");
const operations = [];

function write(repo, relativePath, content) {
  const destination = path.join(repo, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function read(repo, relativePath) {
  return fs.readFileSync(path.join(repo, ...relativePath.split("/")), "utf8");
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  operations.push({ type: "git", cwd, args: [...args] });
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function gitOutput(cwd, args) {
  return runGit(cwd, args).stdout.trim();
}

function configureClone(repo, name) {
  runGit(repo, ["config", "core.autocrlf", "false"]);
  runGit(repo, ["config", "user.name", name]);
  runGit(repo, ["config", "user.email", `${name.toLowerCase()}@example.invalid`]);
}

function writeStatus(state, detail = "", conflicts = []) {
  const status = {
    state,
    detail,
    conflicts,
  };
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  operations.push({ type: "status", state });
  return status;
}

function getConflictState(repo) {
  operations.push({ type: "conflict-check" });
  const conflictResult = runGit(repo, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  const conflicts = conflictResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  let operation = "";
  for (const operationName of [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    const operationResult = runGit(repo, [
      "rev-parse",
      "--git-path",
      operationName,
    ]);
    const operationPath = operationResult.stdout.trim();
    const absolutePath = path.isAbsolute(operationPath)
      ? operationPath
      : path.join(repo, operationPath);
    if (fs.existsSync(absolutePath)) {
      operation = operationName;
      break;
    }
  }
  return {
    isPaused: conflicts.length > 0 || operation !== "",
    conflicts,
    operation,
  };
}

function claimsFile(repo) {
  return path.join(repo, "Asuka", "Memory", "local-claims.json");
}

function ingest(repo, id, text) {
  const file = claimsFile(repo);
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.claims = store.claims.filter((claim) => claim.id !== id);
  store.claims.push({ id, text });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function recall(repo, query) {
  const normalized = query.toLowerCase();
  return JSON.parse(fs.readFileSync(claimsFile(repo), "utf8")).claims.filter(
    (claim) => claim.text.toLowerCase().includes(normalized),
  );
}

function invokeWiki(repo, command) {
  operations.push({ type: "wiki", command });
  const store = JSON.parse(fs.readFileSync(claimsFile(repo), "utf8"));
  if (command === "compile") {
    assert.ok(Array.isArray(store.claims), "compile requires a claims array");
    return;
  }
  if (command === "lint") {
    const ids = new Set();
    for (const claim of store.claims) {
      assert.equal(typeof claim.id, "string");
      assert.ok(claim.id.length > 0, "claim id must not be empty");
      assert.equal(typeof claim.text, "string");
      assert.ok(claim.text.length > 0, "claim text must not be empty");
      assert.equal(ids.has(claim.id), false, `duplicate claim id: ${claim.id}`);
      ids.add(claim.id);
    }
    return;
  }
  throw new Error(`unsupported wiki command: ${command}`);
}

function syncCycle(repo) {
  const operationStart = operations.length;
  let pullExitCode = null;
  const finish = (state, detail, conflicts = []) => {
    writeStatus(state, detail, conflicts);
    return {
      state,
      conflicts,
      pullExitCode,
      operations: operations.slice(operationStart),
    };
  };

  writeStatus("syncing", "Memory sync cycle started.");
  let conflictState = getConflictState(repo);
  if (conflictState.isPaused) {
    return finish(
      "conflict",
      "Unresolved Git state requires manual completion.",
      conflictState.conflicts,
    );
  }

  const fetch = runGit(repo, ["fetch", "--prune"], { allowFailure: true });
  if (fetch.status !== 0) {
    return finish(
      "retry",
      "git fetch failed; local memory remains available and will be retried.",
    );
  }

  const pull = runGit(repo, ["pull", "--rebase", "--autostash"], {
    allowFailure: true,
  });
  pullExitCode = pull.status;

  // This check is intentionally unconditional: Git can exit zero after an
  // autostash application leaves unresolved files.
  conflictState = getConflictState(repo);
  if (conflictState.isPaused) {
    return finish(
      "conflict",
      "git pull --rebase paused for manual conflict resolution.",
      conflictState.conflicts,
    );
  }
  if (pull.status !== 0) {
    return finish(
      "retry",
      "git pull --rebase failed; local memory remains available and will be retried.",
    );
  }

  invokeWiki(repo, "compile");
  invokeWiki(repo, "lint");

  runGit(repo, ["add", "--", memoryPath]);
  const staged = runGit(
    repo,
    ["diff", "--cached", "--quiet", "--", memoryPath],
    { allowFailure: true },
  );
  if (staged.status === 1) {
    runGit(repo, [
      "commit",
      "--only",
      "-m",
      "chore(memory): fixture sync",
      "--",
      memoryPath,
    ]);
  } else if (staged.status !== 0) {
    throw new Error(`unable to inspect staged memory changes: ${staged.stderr}`);
  }

  const upstream = runGit(
    repo,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  let aheadCount = 0;
  if (upstream.status === 0) {
    aheadCount = Number.parseInt(
      gitOutput(repo, ["rev-list", "--count", "@{upstream}..HEAD"]),
      10,
    );
  }
  if (aheadCount > 0) {
    const push = runGit(repo, ["push"], { allowFailure: true });
    if (push.status !== 0) {
      return finish(
        "retry",
        `git push failed; ${aheadCount} local commit(s) remain queued.`,
      );
    }
  }

  return finish("idle", "Last memory sync cycle completed successfully.");
}

function sameArgs(operation, expected) {
  return (
    operation.type === "git" &&
    operation.args.length === expected.length &&
    operation.args.every((argument, index) => argument === expected[index])
  );
}

function assertOperationOrder(actual, expectations) {
  let cursor = 0;
  for (const [label, predicate] of expectations) {
    const index = actual.findIndex(
      (operation, operationIndex) => operationIndex >= cursor && predicate(operation),
    );
    assert.notEqual(index, -1, `missing ordered operation: ${label}`);
    cursor = index + 1;
  }
}

function assertWorkerContract() {
  assert.equal(
    fs.existsSync(workerPath),
    true,
    "release-owned asuka-memory-sync.ps1 is missing",
  );
  const source = fs.readFileSync(workerPath, "utf8").replace(/\r\n/g, "\n");
  const cycleStart = source.indexOf("function Invoke-SyncCycle");
  const cycleEnd = source.indexOf("\nNew-Item -ItemType Directory", cycleStart);
  assert.ok(cycleStart >= 0 && cycleEnd > cycleStart, "Invoke-SyncCycle was not found");
  const cycle = source.slice(cycleStart, cycleEnd);
  const codeOnly = cycle
    .replace(/<#[\s\S]*?#>/g, "")
    .replace(/^\s*#.*$/gm, "");
  const compact = codeOnly.replace(/\s+/g, "");
  const tokens = [
    '$conflictState=Get-ConflictState',
    '$fetch=Invoke-Git-Arguments@("fetch","--prune")',
    '$pull=Invoke-Git-Arguments@("pull","--rebase","--autostash")',
    '$conflictState=Get-ConflictState',
    'if($conflictState.IsPaused)',
    'if($pull.ExitCode-ne0)',
    'Invoke-WikiCommand-Command"compile"',
    'Invoke-WikiCommand-Command"lint"',
    'Invoke-Git-Arguments@("add","--",$memoryPath)',
    'Invoke-Git-Arguments@("diff","--cached","--quiet","--",$memoryPath)',
    'Invoke-Git-Arguments@("commit","--only","-m",$commitMessage,"--",$memoryPath)',
    'Invoke-Git-Arguments@("push")',
  ];
  const positions = [];
  let cursor = 0;
  for (const token of tokens) {
    const index = compact.indexOf(token, cursor);
    assert.notEqual(index, -1, `sync worker is missing ordered source contract: ${token}`);
    positions.push(index);
    cursor = index + token.length;
  }

  const pullTokenIndex = 2;
  assert.equal(
    positions[pullTokenIndex] + tokens[pullTokenIndex].length,
    positions[pullTokenIndex + 1],
    "Get-ConflictState must run unconditionally immediately after pull",
  );
  assert.equal(
    compact.split('Invoke-Git-Arguments@("add"').length - 1,
    1,
    "sync worker must have exactly one scoped git add",
  );
  assert.match(source, /\$memoryPath\s*=\s*["']Asuka\/Memory["']/);
  assert.doesNotMatch(cycle, /["']--force(?:-with-lease)?["']/i);
  assert.doesNotMatch(cycle, /["']-f["']/i);
}

try {
  assertWorkerContract();

  runGit(fixtureRoot, ["init", "--bare", "--initial-branch=main", origin]);
  runGit(fixtureRoot, ["-c", "core.autocrlf=false", "clone", origin, worker]);
  configureClone(worker, "Worker");
  write(worker, "Asuka/Memory/topic.md", "shared topic\n");
  write(worker, "Asuka/Memory/local-claims.json", '{"claims":[]}\n');
  write(worker, "outside.txt", "outside base\n");
  runGit(worker, [
    "add",
    "--",
    "Asuka/Memory/topic.md",
    "Asuka/Memory/local-claims.json",
    "outside.txt",
  ]);
  runGit(worker, ["commit", "-m", "fixture: initialize memory vault"]);
  runGit(worker, ["push", "-u", "origin", "main"]);
  runGit(fixtureRoot, ["-c", "core.autocrlf=false", "clone", origin, peer]);
  configureClone(peer, "Peer");

  ingest(worker, "happy", "scoped memory reaches the origin");
  fs.appendFileSync(path.join(worker, "Asuka", "Memory", "topic.md"), "happy sync\n");
  write(worker, "outside.txt", "outside must remain local\n");
  const happy = syncCycle(worker);
  assert.equal(happy.state, "idle");
  assertOperationOrder(happy.operations, [
    ["initial conflict check", (operation) => operation.type === "conflict-check"],
    ["fetch", (operation) => sameArgs(operation, ["fetch", "--prune"])],
    [
      "pull/rebase/autostash",
      (operation) => sameArgs(operation, ["pull", "--rebase", "--autostash"]),
    ],
    ["post-pull conflict check", (operation) => operation.type === "conflict-check"],
    [
      "compile",
      (operation) => operation.type === "wiki" && operation.command === "compile",
    ],
    ["lint", (operation) => operation.type === "wiki" && operation.command === "lint"],
    ["scoped add", (operation) => sameArgs(operation, ["add", "--", memoryPath])],
    [
      "scoped staged diff",
      (operation) =>
        sameArgs(operation, ["diff", "--cached", "--quiet", "--", memoryPath]),
    ],
    [
      "scoped commit",
      (operation) =>
        operation.type === "git" &&
        operation.args[0] === "commit" &&
        operation.args.includes("--only") &&
        operation.args.at(-1) === memoryPath,
    ],
    ["ordinary push", (operation) => sameArgs(operation, ["push"])],
  ]);
  const committedPaths = gitOutput(worker, [
    "show",
    "--pretty=format:",
    "--name-only",
    "HEAD",
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  assert.ok(
    committedPaths.every((entry) => entry.startsWith(`${memoryPath}/`)),
    `commit escaped ${memoryPath}: ${committedPaths.join(", ")}`,
  );
  assert.equal(gitOutput(worker, ["diff", "--cached", "--name-only"]), "");
  assert.match(gitOutput(worker, ["status", "--porcelain", "--", "outside.txt"]), /^M /);
  assert.equal(gitOutput(worker, ["show", "origin/main:outside.txt"]), "outside base");

  const unreachableOrigin = path.join(fixtureRoot, "unreachable", "origin.git");
  runGit(worker, ["remote", "set-url", "origin", unreachableOrigin]);
  const headBeforeOutage = gitOutput(worker, ["rev-parse", "HEAD"]);
  ingest(worker, "offline-one", "local recall remains available during outage");
  assert.equal(recall(worker, "during outage").length, 1);
  const outage = syncCycle(worker);
  assert.equal(outage.state, "retry");
  assert.equal(gitOutput(worker, ["rev-parse", "HEAD"]), headBeforeOutage);
  assert.match(
    gitOutput(worker, ["status", "--porcelain", "--", memoryPath]),
    /local-claims\.json/,
  );
  ingest(worker, "offline-two", "ingest continues after a failed sync");
  assert.equal(recall(worker, "failed sync").length, 1);
  const repeatedOutage = syncCycle(worker);
  assert.equal(repeatedOutage.state, "retry");
  assert.equal(recall(worker, "outage").length, 1);

  runGit(worker, ["remote", "set-url", "origin", origin]);
  const recovery = syncCycle(worker);
  assert.equal(recovery.state, "idle");
  runGit(peer, ["pull", "--rebase"]);
  assert.equal(recall(peer, "during outage").length, 1);
  assert.equal(recall(peer, "failed sync").length, 1);

  write(worker, "Asuka/Memory/queued-local.md", "queued local commit\n");
  runGit(worker, ["add", "--", "Asuka/Memory/queued-local.md"]);
  runGit(worker, [
    "commit",
    "--only",
    "-m",
    "chore(memory): queued local commit",
    "--",
    "Asuka/Memory/queued-local.md",
  ]);
  const queuedCommitBeforeRebase = gitOutput(worker, ["rev-parse", "HEAD"]);
  write(peer, "Asuka/Memory/peer-nonconflict.md", "peer non-conflicting commit\n");
  runGit(peer, ["add", "--", "Asuka/Memory/peer-nonconflict.md"]);
  runGit(peer, ["commit", "-m", "chore(memory): peer non-conflicting commit"]);
  runGit(peer, ["push"]);
  const peerCommit = gitOutput(peer, ["rev-parse", "HEAD"]);

  const nonConflicting = syncCycle(worker);
  assert.equal(nonConflicting.state, "idle");
  assertOperationOrder(nonConflicting.operations, [
    ["fetch", (operation) => sameArgs(operation, ["fetch", "--prune"])],
    [
      "non-conflicting rebase",
      (operation) => sameArgs(operation, ["pull", "--rebase", "--autostash"]),
    ],
    ["post-pull conflict check", (operation) => operation.type === "conflict-check"],
    ["ordinary recovery push", (operation) => sameArgs(operation, ["push"])],
  ]);
  assert.notEqual(gitOutput(worker, ["rev-parse", "HEAD"]), queuedCommitBeforeRebase);
  assert.equal(
    runGit(worker, ["merge-base", "--is-ancestor", peerCommit, "HEAD"], {
      allowFailure: true,
    }).status,
    0,
  );
  assert.match(read(worker, "Asuka/Memory/queued-local.md"), /queued local commit/);
  assert.match(read(worker, "Asuka/Memory/peer-nonconflict.md"), /peer non-conflicting/);
  assert.equal(read(worker, "outside.txt"), "outside must remain local\n");
  assert.match(gitOutput(worker, ["status", "--porcelain", "--", "outside.txt"]), /^M /);

  runGit(peer, ["pull", "--rebase"]);
  const commonTopic = read(worker, "Asuka/Memory/topic.md");
  assert.equal(read(peer, "Asuka/Memory/topic.md"), commonTopic);
  write(
    worker,
    "Asuka/Memory/topic.md",
    `${commonTopic}worker autostash content\n`,
  );
  write(peer, "Asuka/Memory/topic.md", `${commonTopic}peer remote content\n`);
  runGit(peer, ["add", "--", "Asuka/Memory/topic.md"]);
  runGit(peer, ["commit", "-m", "chore(memory): peer same-file change"]);
  runGit(peer, ["push"]);

  const conflict = syncCycle(worker);
  assert.equal(
    conflict.pullExitCode,
    0,
    "fixture must exercise Git's success exit with an autostash conflict",
  );
  assert.equal(conflict.state, "conflict");
  assert.deepEqual(conflict.conflicts, ["Asuka/Memory/topic.md"]);
  const conflictedTopic = read(worker, "Asuka/Memory/topic.md");
  assert.match(conflictedTopic, /worker autostash content/);
  assert.match(conflictedTopic, /peer remote content/);
  assert.match(conflictedTopic, /<<<<<<<|>>>>>>>/);
  assert.equal(
    conflict.operations.some(
      (operation) =>
        operation.type === "wiki" ||
        (operation.type === "git" &&
          ["add", "commit", "push"].includes(operation.args[0])),
    ),
    false,
    "conflict must pause before compile, lint, staging, commit, or push",
  );
  const visibleStatus = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(visibleStatus.state, "conflict");
  assert.deepEqual(visibleStatus.conflicts, ["Asuka/Memory/topic.md"]);

  const paused = syncCycle(worker);
  assert.equal(paused.state, "conflict");
  assert.equal(
    paused.operations.some(
      (operation) =>
        operation.type === "git" &&
        ["fetch", "pull", "add", "commit", "push"].includes(operation.args[0]),
    ),
    false,
    "an unresolved conflict must remain paused before network or mutation",
  );

  const pushOperations = operations.filter(
    (operation) => operation.type === "git" && operation.args[0] === "push",
  );
  assert.ok(pushOperations.length > 0, "fixture did not exercise git push");
  for (const operation of pushOperations) {
    assert.equal(
      operation.args.some(
        (argument) =>
          argument === "-f" ||
          argument === "--force" ||
          argument === "--force-with-lease",
      ),
      false,
      `force push is forbidden: git ${operation.args.join(" ")}`,
    );
  }

  console.log(
    "asuka-memory sync fixture passed: scoped sync, offline recovery, rebase, and conflict pause",
  );
} finally {
  assert.ok(
    fixtureRoot.startsWith(`${os.tmpdir()}${path.sep}`),
    "refusing to remove a non-temporary fixture",
  );
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
