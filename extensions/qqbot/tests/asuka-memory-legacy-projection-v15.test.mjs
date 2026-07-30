import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import {
  AsukaMemoryRuntime,
  resolveAsukaMemoryKernelConfig,
} from "../dist/src/asuka-memory-kernel/runtime.js";
import {
  writeAsukaLegacyMemoryProjection,
} from "../dist/src/asuka-memory.js";

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  assert.fail("timed out waiting for legacy projection work");
}

function config(databasePath) {
  return resolveAsukaMemoryKernelConfig({
    channels: {
      qqbot: {
        memoryKernel: {
          enabled: true,
          databasePath,
          worker: { enabled: false, intervalMs: 20 },
          wiki: { enabled: false },
        },
      },
    },
  });
}

function projectionWriter(memoryFile) {
  return (context) => {
    if (context.reason !== "claims_changed" || !context.scope) return;
    writeAsukaLegacyMemoryProjection(
      context.scope,
      context.snapshot,
      { memoryFile },
    );
  };
}

function legacyMemories(memoryFile) {
  return Object.values(
    JSON.parse(fs.readFileSync(memoryFile, "utf8")).memories ?? {},
  );
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "asuka-legacy-projection-v15-"),
);
const databasePath = path.join(temporaryRoot, "memory.sqlite");
const memoryFile = path.join(temporaryRoot, "legacy", "memory.json");
const identityId = "identity:shared-user";

const firstRuntime = new AsukaMemoryRuntime(config(databasePath), {
  allowMissingEmbeddingsForTests: true,
});
const privatePeers = ["direct-a", "direct-b"];
const privateEvents = privatePeers.map((peerId, index) =>
  firstRuntime.ledger.appendEvent({
    accountId: "default",
    peerKind: "direct",
    peerId,
    identityId,
    visibility: "private",
    actor: "user",
    kind: "user_message",
    text: `private source ${index + 1}`,
    sourceMessageId: `private-source-${index + 1}`,
  })
);
const publicEvent = firstRuntime.ledger.appendEvent({
  accountId: "default",
  peerKind: "group",
  peerId: "group-a",
  identityId,
  visibility: "public",
  actor: "user",
  kind: "user_message",
  text: "public source",
  sourceMessageId: "public-source",
});

const explicitPrivate = firstRuntime.ledger.applyClaimProposal(
  privateEvents[0].eventId,
  {
    subjectId: "user",
    predicate: "residence.current",
    value: "杭州",
    canonicalText: "用户现在住在杭州",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 1,
    disposition: "active",
    rationale: "Fixture model selected active",
  },
);
const inferredPrivate = firstRuntime.ledger.applyClaimProposal(
  privateEvents[1].eventId,
  {
    subjectId: "user",
    predicate: "sleep.restless",
    value: true,
    canonicalText: "推断：用户晚上睡觉可能不安分",
    topLevelType: "belief",
    epistemicStatus: "inferred",
    authority: "inferred",
    confidence: 0.9,
    disposition: "active",
    rationale: "Fixture model selected active",
  },
);
const explicitPublic = firstRuntime.ledger.applyClaimProposal(
  publicEvent.eventId,
  {
    subjectId: "user",
    predicate: "group.nickname",
    value: "小明",
    canonicalText: "群里称呼用户为小明",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 1,
    disposition: "active",
    rationale: "Fixture model selected active",
  },
);
assert.ok(explicitPrivate.claimId);
assert.ok(inferredPrivate.claimId);
assert.ok(explicitPublic.claimId);

assert.deepEqual(
  firstRuntime.ledger.listIdentityLinks({ identityId }).map((link) => ({
    accountId: link.accountId,
    peerKind: link.peerKind,
    peerId: link.peerId,
    visibility: link.visibility,
  })),
  [
    {
      accountId: "default",
      peerKind: "direct",
      peerId: "direct-a",
      visibility: "private",
    },
    {
      accountId: "default",
      peerKind: "direct",
      peerId: "direct-b",
      visibility: "private",
    },
    {
      accountId: "default",
      peerKind: "group",
      peerId: "group-a",
      visibility: "public",
    },
  ],
);

firstRuntime.registerLegacyWriter(() => {
  throw new Error("fixture projection writer failure");
});
await waitFor(() => {
  const status = firstRuntime.getLegacyProjectionStatus();
  return status.pendingCount === 3 && status.failedCount === 3;
});
assert.deepEqual(firstRuntime.getLegacyProjectionStatus(), {
  degraded: true,
  pendingCount: 3,
  failedCount: 3,
  lastError: "fixture projection writer failure",
});
await firstRuntime.shutdown();

const secondRuntime = new AsukaMemoryRuntime(config(databasePath), {
  allowMissingEmbeddingsForTests: true,
});
assert.deepEqual(secondRuntime.getLegacyProjectionStatus(), {
  degraded: true,
  pendingCount: 3,
  failedCount: 3,
  lastError: "fixture projection writer failure",
});
secondRuntime.registerLegacyWriter(projectionWriter(memoryFile));
await waitFor(() => secondRuntime.getLegacyProjectionStatus().pendingCount === 0);
assert.deepEqual(secondRuntime.getLegacyProjectionStatus(), {
  degraded: false,
  pendingCount: 0,
  failedCount: 0,
});

const projected = legacyMemories(memoryFile);
for (const peerId of privatePeers) {
  const peerMemories = projected.filter((memory) =>
    memory.peerId === peerId && memory.peerKind === "direct"
  );
  assert.deepEqual(
    peerMemories.map((memory) => memory.text).sort(),
    [
      "推断：用户晚上睡觉可能不安分",
      "用户现在住在杭州",
    ],
  );
  assert.equal(
    peerMemories.some((memory) => memory.text === "群里称呼用户为小明"),
    false,
  );
  assert.equal(
    peerMemories.find((memory) =>
      memory.text === "推断：用户晚上睡觉可能不安分"
    ).type,
    "inferred",
  );
}
assert.deepEqual(
  projected
    .filter((memory) =>
      memory.peerId === "group-a" && memory.peerKind === "group"
    )
    .map((memory) => memory.text),
  ["群里称呼用户为小明"],
);
assert.equal(
  new Set(projected.map((memory) => memory.id)).size,
  projected.length,
  "the same canonical claim projected to multiple peers needs a stable unique legacy id",
);

secondRuntime.ingestMemoryEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "direct-c",
  identityId,
  visibility: "private",
  actor: "user",
  kind: "user_message",
  text: "这条消息本身不产生新的测试 claim",
  sourceMessageId: "new-peer-without-claim",
});
await waitFor(() =>
  legacyMemories(memoryFile).filter((memory) => memory.peerId === "direct-c")
    .length === 2
);
privatePeers.push("direct-c");

const deleteTargets = [explicitPrivate.claimId, inferredPrivate.claimId];
const deleteEvent = secondRuntime.ingestMemoryEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "direct-a",
  identityId,
  visibility: "private",
  actor: "user",
  kind: "memory_control",
  text: "删除所有私有测试记忆",
  sourceMessageId: "delete-private-fixture",
}).receipt;
assert.ok(deleteEvent?.eventId);

for (const claimId of deleteTargets) {
  secondRuntime.ledger.applyClaimProposal(deleteEvent.eventId, {
    action: "delete",
    targetClaimId: claimId,
    subjectId: "user",
    predicate: "fixture.delete",
    value: null,
    canonicalText: "删除测试记忆",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_correction",
    confidence: 1,
  });
}
secondRuntime.refreshLegacyProjections(identityId);
await secondRuntime.processPendingLegacyProjections();
await waitFor(() => {
  const memories = legacyMemories(memoryFile);
  return privatePeers.every((peerId) =>
    memories.every((memory) => memory.peerId !== peerId)
  );
});
assert.deepEqual(
  legacyMemories(memoryFile).map((memory) => memory.text),
  ["群里称呼用户为小明"],
  "clearing one visibility must not clear another visibility",
);
assert.deepEqual(secondRuntime.getLegacyProjectionStatus(), {
  degraded: false,
  pendingCount: 0,
  failedCount: 0,
});

await secondRuntime.shutdown();
fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("asuka memory legacy projection v1.5 tests passed");
