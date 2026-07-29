import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";
import {
  AsukaMemoryRuntime,
  getAsukaMemoryRuntime,
  initializeAsukaMemoryRuntime,
  resetAsukaMemoryRuntime,
  resolveAsukaMemoryKernelConfig,
} from "../dist/src/asuka-memory-kernel/runtime.js";
import {
  captureAsukaMemoryControl,
  captureAsukaUserMemory,
  initializeQQBotAsukaMemory,
  retrieveQQBotAsukaMemory,
} from "../dist/src/asuka-memory-kernel/qqbot-adapter.js";
import {
  writeAsukaLegacyMemoryProjection,
} from "../dist/src/asuka-memory.js";
import {
  memoryWikiMarkers,
  projectMemoryWiki,
} from "../dist/src/asuka-memory-kernel/wiki.js";

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(10);
  }
  assert.fail("timed out waiting for asynchronous memory work");
}

function rootConfig(overrides = {}) {
  return {
    channels: {
      qqbot: {
        memoryKernel: {
          enabled: true,
          databasePath: ":memory:",
          worker: { enabled: false },
          wiki: { enabled: false },
          ...overrides,
        },
      },
    },
  };
}

function directorySnapshot(root) {
  const snapshot = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        snapshot[`directory:${relative}`] = true;
        visit(absolute);
      } else {
        snapshot[`file:${relative}`] = fs.readFileSync(absolute).toString("base64");
      }
    }
  };
  visit(root);
  return snapshot;
}

function manualBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end >= 0, "manual block markers must exist");
  return content.slice(start + startMarker.length, end);
}

function readLegacyMemories(memoryFile) {
  return Object.values(
    JSON.parse(fs.readFileSync(memoryFile, "utf8")).memories ?? {},
  );
}

await resetAsukaMemoryRuntime();
assert.equal(
  initializeAsukaMemoryRuntime({ channels: { qqbot: {} } }),
  undefined,
  "memory kernel must remain off unless explicitly enabled",
);

const configuredModel = {
  provider: "runtime-selected-provider",
  model: "runtime-selected-model",
};
let receivedModel;
const singletonConfig = rootConfig({ model: configuredModel });
const singleton = initializeAsukaMemoryRuntime(singletonConfig, {
  allowMissingEmbeddingsForTests: true,
  createModelAdapter(settings) {
    receivedModel = settings;
    return undefined;
  },
});
assert.ok(singleton);
assert.equal(getAsukaMemoryRuntime(), singleton);
assert.equal(
  initializeAsukaMemoryRuntime(singletonConfig),
  singleton,
  "initialization must be singleton-scoped",
);
assert.equal(receivedModel, configuredModel, "runtime must pass model settings through unchanged");
await resetAsukaMemoryRuntime();
assert.equal(getAsukaMemoryRuntime(), undefined);

const migrationConfig = resolveAsukaMemoryKernelConfig(rootConfig({
  migration: {
    extractionMaxInputChars: 12_000,
    extractionMaxProposals: 80,
    extractionMaxTokens: 5_000,
    consolidationMaxInputChars: 48_000,
    consolidationMaxClaimsPerBatch: 120,
    consolidationMaxTokens: 9_000,
  },
}));
assert.deepEqual(migrationConfig.migration, {
  extractionMaxInputChars: 12_000,
  extractionMaxProposals: 80,
  extractionMaxTokens: 5_000,
  consolidationMaxInputChars: 48_000,
  consolidationMaxClaimsPerBatch: 120,
  consolidationMaxTokens: 9_000,
});

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-runtime-"));
const databasePath = path.join(temporaryRoot, "memory.sqlite");
const legacyMemoryFile = path.join(temporaryRoot, "legacy", "memory.json");
const memoryRoot = path.join(temporaryRoot, "vault", "Asuka", "Memory");
const identityId = "private:default:user-1";
const wikiScope = {
  identityId,
  visibility: "private",
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
};
const atomicProjectionFile = path.join(temporaryRoot, "atomic", "memory.json");
const originalProjection = `${JSON.stringify({
  version: 1,
  memories: {
    existing: {
      id: "existing",
      text: "must survive a failed replacement",
    },
  },
}, null, 2)}`;
fs.mkdirSync(path.dirname(atomicProjectionFile), { recursive: true });
fs.writeFileSync(atomicProjectionFile, originalProjection, "utf8");
const originalRenameSync = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (path.resolve(destination) === path.resolve(atomicProjectionFile)) {
    throw new Error("fixture replacement failure");
  }
  return originalRenameSync(source, destination);
};
try {
  assert.throws(
    () => writeAsukaLegacyMemoryProjection(
      {
        identityId,
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
      },
      {
        generatedAt: Date.now(),
        claims: [{
          claimId: "atomic-claim",
          rootClaimId: "atomic-claim",
          identityId,
          canonicalText: "用户现在住在杭州",
          authority: "user_explicit",
          epistemicStatus: "explicit",
          state: "active",
          visibility: "private",
          sourceEventId: "atomic-event",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }],
        history: [],
        claimEvidence: [],
        eventSummaries: [],
      },
      { memoryFile: atomicProjectionFile },
    ),
    /fixture replacement failure/,
  );
} finally {
  fs.renameSync = originalRenameSync;
}
assert.equal(
  fs.readFileSync(atomicProjectionFile, "utf8"),
  originalProjection,
  "a failed projection replacement must preserve the rollback file byte-for-byte",
);
assert.deepEqual(
  fs.readdirSync(path.dirname(atomicProjectionFile)).sort(),
  ["memory.json"],
  "a failed projection replacement must remove its temporary file",
);
const persistentRoot = rootConfig({
  databasePath,
  worker: { enabled: false },
  wiki: {
    enabled: true,
    memoryRoot,
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    identityId,
    visibility: "private",
    debounceMs: 20,
    overrideImportIntervalMs: 20,
  },
});
const nonStarvingWikiRoot = path.join(temporaryRoot, "non-starving-wiki");
const nonStarvingRuntime = new AsukaMemoryRuntime(
  resolveAsukaMemoryKernelConfig(rootConfig({
    databasePath: path.join(temporaryRoot, "non-starving.sqlite"),
    worker: { enabled: false },
    wiki: {
      enabled: true,
      memoryRoot: nonStarvingWikiRoot,
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      identityId,
      visibility: "private",
      debounceMs: 30,
      overrideImportIntervalMs: 30,
    },
  })),
  { allowMissingEmbeddingsForTests: true },
);
const repeatedProjectionSignals = setInterval(() => {
  nonStarvingRuntime.scheduleWikiProjection();
}, 5);
try {
  await wait(50);
  assert.equal(
    fs.existsSync(path.join(nonStarvingWikiRoot, "Asuka Memory.md")),
    true,
    "continuous claim changes must not starve the bounded Wiki projection window",
  );
} finally {
  clearInterval(repeatedProjectionSignals);
  await nonStarvingRuntime.close();
}
const firstRuntime = new AsukaMemoryRuntime(
  resolveAsukaMemoryKernelConfig(persistentRoot),
  {
    allowMissingEmbeddingsForTests: true,
    logger: {
      warn(message) {
        legacyWarnings.push(message);
      },
    },
  },
);
const legacyWarnings = [];
const legacyReasons = [];
firstRuntime.registerLegacyWriter(async (context) => {
  legacyReasons.push(context.reason);
  throw new Error("fixture legacy writer failure");
});
const persisted = firstRuntime.ingestUserMessage({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  identityId,
  text: "我现在住在杭州",
  sourceMessageId: "durable-before-restart",
});
assert.equal(persisted.accepted, true);
assert.equal(firstRuntime.ledger.listJobs("pending").length, 1);
await wait(0);
assert.deepEqual(legacyReasons, ["event_ingested"]);
await firstRuntime.shutdown();

let activeModelCalls = 0;
let maximumConcurrentModelCalls = 0;
let deleteTargetClaimId;
const model = {
  async complete(request) {
    if (request.task === "rerank") {
      const claimIds = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
        .map((match) => match[1]);
      return JSON.stringify({ claimIds, reason: "fixture" });
    }
    activeModelCalls += 1;
    maximumConcurrentModelCalls = Math.max(
      maximumConcurrentModelCalls,
      activeModelCalls,
    );
    await wait(25);
    activeModelCalls -= 1;
    const eventLine = request.prompt.match(/当前事件：(\{[^\n]+\})/);
    const event = eventLine ? JSON.parse(eventLine[1]) : {};
    if (event.kind === "memory_control" && deleteTargetClaimId) {
      return JSON.stringify({
        proposals: [{
          action: "delete",
          targetClaimId: deleteTargetClaimId,
          subjectId: "user",
          predicate: "wiki.delete_refresh",
          value: null,
          canonicalText: "彻底删除 Wiki 刷新测试记忆",
          topLevelType: "fact",
          epistemicStatus: "explicit",
          sourceKind: "correction",
          confidence: 1,
          topic: "删除刷新测试",
        }],
      });
    }
    if (event.actor === "asuka") {
      return JSON.stringify({
        proposals: [{
          subjectId: "asuka",
          predicate: "self.statement",
          value: event.text,
          canonicalText: `Asuka 说过：${event.text}`,
          topLevelType: "self_narrative",
          epistemicStatus: "explicit",
          sourceKind: "statement",
          confidence: 0.82,
          disposition: "candidate",
          rationale: "Assistant-authored context must remain provisional",
          topic: "Asuka 自述",
          lifecycle: "episodic",
        }],
      });
    }
    const city = String(event.text ?? "").includes("苏州") ? "苏州" : "杭州";
    return JSON.stringify({
      proposals: [{
        subjectId: "user",
        predicate: "residence.current",
        value: city,
        canonicalText: `用户现在住在${city}`,
        topLevelType: "fact",
        epistemicStatus: "explicit",
        sourceKind: "statement",
        confidence: city === "苏州" ? 0.93 : 0.98,
        disposition: "active",
        rationale: "The user directly stated the current residence",
        topic: "居住状态",
        lifecycle: "bounded",
      }],
    });
  },
};
const warnings = [];
const secondRoot = rootConfig({
  databasePath,
  worker: { enabled: true, intervalMs: 20, maxJobs: 10 },
  wiki: persistentRoot.channels.qqbot.memoryKernel.wiki,
});
const secondRuntime = initializeAsukaMemoryRuntime(
  secondRoot,
  {
    allowMissingEmbeddingsForTests: true,
    model,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  },
);
assert.ok(secondRuntime);
const secondLegacyReasons = [];
secondRuntime.registerLegacyWriter((context) => {
  secondLegacyReasons.push(context.reason);
});
assert.equal(
  initializeQQBotAsukaMemory(
    secondRoot,
    "default",
    undefined,
    { legacyWriter: { memoryFile: legacyMemoryFile } },
  ),
  secondRuntime,
);
secondRuntime.ingestUserMessage({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  identityId,
  text: "杭州是我当前的常住地",
  sourceMessageId: "durable-after-restart",
});
await waitFor(() =>
  secondRuntime.ledger.listJobs().every((job) => job.status === "completed")
  && secondRuntime.ledger.listClaims({ identityId, states: ["active"] }).length > 0
);
assert.equal(maximumConcurrentModelCalls, 1, "worker ticks must not process jobs reentrantly");
assert.ok(
  secondRuntime.ledger.listClaims({ identityId, states: ["active"] }).length > 0,
  "a queued event from the previous process must be adjudicated after restart",
);
assert.ok(secondLegacyReasons.includes("claims_changed"));
await waitFor(() =>
  fs.existsSync(legacyMemoryFile)
  && readLegacyMemories(legacyMemoryFile).some((item) =>
    item.status === "active" && item.text === "用户现在住在杭州"
  )
);

secondRuntime.ingestUserMessage({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  identityId,
  text: "我已经搬到苏州",
  sourceMessageId: "durable-residence-revision",
});
await waitFor(() =>
  secondRuntime.ledger.listJobs().every((job) => job.status === "completed")
  && secondRuntime.ledger.listClaims({
    identityId,
    states: ["active"],
  }).some((claim) => claim.canonicalText === "用户现在住在苏州")
);
await waitFor(() => {
  const memories = readLegacyMemories(legacyMemoryFile);
  return memories.some((item) =>
    item.status === "active" && item.text === "用户现在住在苏州"
  ) && memories.some((item) =>
    item.status === "superseded" && item.text === "用户现在住在杭州"
  );
});

const assistantReceipt = secondRuntime.ingestAssistantReply({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  identityId,
  text: "今晚我会记得把窗帘拉好",
  sourceMessageId: "durable-assistant-evidence",
}).receipt;
const proactiveReceipt = secondRuntime.ingestProactiveMessage({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  identityId,
  text: "我路过时想起你怕夜里太亮",
  sourceMessageId: "durable-proactive-evidence",
}).receipt;
assert.ok(assistantReceipt?.eventId);
assert.ok(proactiveReceipt?.eventId);
await waitFor(() =>
  secondRuntime.ledger.listJobs().every((job) => job.status === "completed")
);
await waitFor(() => {
  const memories = readLegacyMemories(legacyMemoryFile);
  return [assistantReceipt.eventId, proactiveReceipt.eventId].every((eventId) =>
    memories.some((item) =>
      item.sourceMessageId === eventId
      && item.source === "assistant_self_signal"
      && item.status === "superseded"
    )
  );
});

const originalClaim = secondRuntime.ledger.listClaims({
  identityId,
  states: ["active"],
})[0];
assert.ok(originalClaim);
const evidenceBaseTime = Date.now() - 1_000;
const supportingEvents = Array.from({ length: 6 }, (_, index) => {
  const number = index + 1;
  return secondRuntime.ledger.appendEvent({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    identityId,
    actor: "user",
    kind: "user_message",
    text: `支持证据 ${number}：已经在苏州稳定居住`,
    sourceId: `fixture:support-${number}`,
    occurredAt: evidenceBaseTime + number,
    evidence: {
      excerpt: `支持证据 ${number}：已经在苏州稳定居住`,
      mediaType: "text",
    },
  });
});
const opposingEvents = Array.from({ length: 6 }, (_, index) => {
  const number = index + 1;
  return secondRuntime.ledger.appendEvent({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    identityId,
    actor: "user",
    kind: "user_message",
    text: `反对证据 ${number}：旧资料仍写着杭州`,
    sourceId: `fixture:oppose-${number}`,
    occurredAt: evidenceBaseTime + 100 + number,
    evidence: {
      excerpt: `反对证据 ${number}：旧资料仍写着杭州`,
      mediaType: "text",
    },
  });
});
const revisedClaim = secondRuntime.ledger.applyClaimProposal(
  supportingEvents.at(-1).eventId,
  {
    action: "revise",
    targetClaimId: originalClaim.claimId,
    subjectId: "user",
    predicate: "residence.current",
    value: "苏州",
    canonicalText: "用户现在住在苏州",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 0.93,
    disposition: "active",
    rationale: "Fixture model selected active",
    topic: "居住状态",
    lifecycle: "bounded",
    supportingEventIds: supportingEvents.map((event) => event.eventId),
    opposingEventIds: opposingEvents.map((event) => event.eventId),
  },
);
assert.equal(revisedClaim.state, "active");
assert.equal(revisedClaim.rootClaimId, originalClaim.rootClaimId);

const foreignEvent = secondRuntime.ledger.appendEvent({
  accountId: "default",
  peerKind: "group",
  peerId: "other-scope",
  identityId: "public:default:other-scope",
  visibility: "public",
  actor: "user",
  kind: "user_message",
  text: "不应出现在私有 Wiki 的证据",
  sourceId: "fixture:foreign",
  evidence: {
    excerpt: "跨身份跨可见性证据绝不能泄漏",
    mediaType: "text",
  },
});
secondRuntime.ledger.applyClaimProposal(foreignEvent.eventId, {
  subjectId: "other-user",
  predicate: "residence.current",
  value: "秘密地点",
  canonicalText: "跨 scope 的秘密记忆",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 1,
  disposition: "active",
  rationale: "Fixture model selected active",
  topic: "居住状态",
});

const publicEventForSameIdentity = secondRuntime.ledger.appendEvent({
  accountId: "default",
  peerKind: "group",
  peerId: "shared-room",
  identityId,
  visibility: "public",
  actor: "user",
  kind: "user_message",
  text: "同一 identity 的公开记忆也不能混入私有 Wiki",
  sourceId: "fixture:same-identity-public",
});
secondRuntime.ledger.applyClaimProposal(publicEventForSameIdentity.eventId, {
  subjectId: "user",
  predicate: "public_scope.marker",
  value: "公开地点",
  canonicalText: "同一 identity 的公开 scope 记忆",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 1,
  disposition: "active",
  rationale: "Fixture model selected active",
  topic: "居住状态",
});

const otherPeerEventForSameIdentity = secondRuntime.ledger.appendEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "other-direct-peer",
  identityId,
  visibility: "private",
  actor: "user",
  kind: "user_message",
  text: "同一 identity 和 visibility 的其他私聊也不能混入",
  sourceId: "fixture:same-identity-other-peer",
});
secondRuntime.ledger.applyClaimProposal(otherPeerEventForSameIdentity.eventId, {
  subjectId: "user",
  predicate: "other_peer.marker",
  value: "其他私聊地点",
  canonicalText: "同一 identity 的其他 peer scope 记忆",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 1,
  disposition: "active",
  rationale: "Fixture model selected active",
  topic: "居住状态",
});

const genericIndexFile = path.join(memoryRoot, "index.md");
const genericIndex = [
  "# Wiki Index",
  "",
  "<!-- openclaw:wiki:index:start -->",
  "- Generic compile output",
  "<!-- openclaw:wiki:index:end -->",
  "",
].join("\n");
fs.writeFileSync(genericIndexFile, genericIndex, "utf8");
const projected = await secondRuntime.flushWiki();
assert.ok(projected?.pageCount);
assert.equal(fs.existsSync(path.join(memoryRoot, ".asuka-memory-pending")), true);
const entityFile = fs.readdirSync(path.join(memoryRoot, "entities"))
  .map((name) => path.join(memoryRoot, "entities", name))
  .find((file) =>
    file.endsWith(".md")
    && fs.readFileSync(file, "utf8").includes("用户现在住在")
  );
assert.ok(entityFile, "Wiki projection must create a topic page");
const indexFile = path.join(memoryRoot, "Asuka Memory.md");
assert.equal(
  fs.readFileSync(genericIndexFile, "utf8"),
  genericIndex,
  "ledger projection must not overwrite the generic OpenClaw Wiki index",
);
const relativeEntity = path.relative(memoryRoot, entityFile)
  .split(path.sep)
  .join("/")
  .replace(/\.md$/i, "");
const firstTopicPage = fs.readFileSync(entityFile, "utf8");
const firstIndexPage = fs.readFileSync(indexFile, "utf8");
assert.match(firstTopicPage, /^---\n[\s\S]*\ntype: memory-topic\n[\s\S]*\n---\n/);
assert.match(firstIndexPage, /^---\n[\s\S]*\ntype: memory-index\n[\s\S]*\n---\n/);
assert.match(firstTopicPage, /scope_identity_id: "private:default:user-1"/);
assert.match(firstTopicPage, /scope_visibility: "private"/);
assert.match(firstTopicPage, /scope_account_id: "default"/);
assert.match(firstTopicPage, /scope_peer_kind: "direct"/);
assert.match(firstTopicPage, /scope_peer_id: "user-1"/);
assert.ok(
  firstIndexPage.includes(`[[${relativeEntity}|居住状态]]`),
  "the index must use a valid topic wikilink",
);
assert.match(firstTopicPage, /用户现在住在苏州/);
assert.match(firstTopicPage, /Confidence:\s+0\.93/);
assert.ok(firstTopicPage.includes(revisedClaim.rootClaimId));
assert.ok(firstTopicPage.includes(originalClaim.claimId));
assert.match(firstTopicPage, /用户现在住在杭州/);
assert.match(firstTopicPage, /支持证据 6：已经在苏州稳定居住/);
assert.match(firstTopicPage, /反对证据 6：旧资料仍写着杭州/);
assert.ok(firstTopicPage.includes("fixture:support-6"));
assert.ok(firstTopicPage.includes(
  new Date(evidenceBaseTime + 6).toISOString(),
));
assert.doesNotMatch(firstTopicPage, /支持证据 1：已经在苏州稳定居住/);
assert.doesNotMatch(firstTopicPage, /反对证据 1：旧资料仍写着杭州/);
assert.doesNotMatch(firstTopicPage, /跨身份跨可见性证据绝不能泄漏/);
assert.doesNotMatch(firstTopicPage, /跨 scope 的秘密记忆/);
const projectedMarkdown = [
  fs.readFileSync(indexFile, "utf8"),
  ...fs.readdirSync(path.join(memoryRoot, "entities"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => fs.readFileSync(path.join(memoryRoot, "entities", name), "utf8")),
].join("\n");
assert.doesNotMatch(projectedMarkdown, /同一 identity 的公开 scope 记忆/);
assert.doesNotMatch(projectedMarkdown, /同一 identity 的其他 peer scope 记忆/);

const generatedEventCount = secondRuntime.ledger.listEvents(identityId).length;
await secondRuntime.flushWiki();
assert.equal(
  secondRuntime.ledger.listEvents(identityId).length,
  generatedEventCount,
  "generated Wiki blocks must not be imported as user memory",
);

const notesBytes = "\r\n  用户自由 Notes，空格和换行必须原样保留。\t\r\n\r\n";
const indexNotesBytes = "\n索引 Notes 也必须原样保留。  \r\n";
let topicPage = fs.readFileSync(entityFile, "utf8");
fs.writeFileSync(
  entityFile,
  topicPage.replace(
    `${memoryWikiMarkers.notesStart}\n\n${memoryWikiMarkers.notesEnd}`,
    `${memoryWikiMarkers.notesStart}${notesBytes}${memoryWikiMarkers.notesEnd}`,
  ),
  "utf8",
);
const indexPage = fs.readFileSync(indexFile, "utf8");
fs.writeFileSync(
  indexFile,
  indexPage.replace(
    `${memoryWikiMarkers.notesStart}\n\n${memoryWikiMarkers.notesEnd}`,
    `${memoryWikiMarkers.notesStart}${indexNotesBytes}${memoryWikiMarkers.notesEnd}`,
  ),
  "utf8",
);
await secondRuntime.flushWiki();
topicPage = fs.readFileSync(entityFile, "utf8");
assert.equal(
  manualBlock(topicPage, memoryWikiMarkers.notesStart, memoryWikiMarkers.notesEnd),
  notesBytes,
  "topic Notes bytes must survive recompilation exactly",
);
assert.equal(
  manualBlock(
    fs.readFileSync(indexFile, "utf8"),
    memoryWikiMarkers.notesStart,
    memoryWikiMarkers.notesEnd,
  ),
  indexNotesBytes,
  "index Notes bytes must survive recompilation exactly",
);

const overrideBytes = "\r\n用户已明确更正：目前住在苏州。  \n\n";
fs.writeFileSync(
  entityFile,
  topicPage.replace(
    `${memoryWikiMarkers.overridesStart}\n\n${memoryWikiMarkers.overridesEnd}`,
    `${memoryWikiMarkers.overridesStart}${overrideBytes}${memoryWikiMarkers.overridesEnd}`,
  ),
  "utf8",
);
await secondRuntime.flushWiki();
assert.equal(
  manualBlock(
    fs.readFileSync(entityFile, "utf8"),
    memoryWikiMarkers.overridesStart,
    memoryWikiMarkers.overridesEnd,
  ),
  overrideBytes,
  "Overrides bytes must survive recompilation exactly",
);
await secondRuntime.processPendingMemoryJobs();
const importedOverride = secondRuntime.ledger.listEvents(identityId)
  .find((event) => event.kind === "human_override");
assert.ok(importedOverride);
assert.deepEqual(
  {
    identityId: importedOverride.identityId,
    visibility: importedOverride.visibility,
    accountId: importedOverride.accountId,
    peerKind: importedOverride.peerKind,
    peerId: importedOverride.peerId,
  },
  wikiScope,
  "Wiki Overrides must use the exact scope bound to the editable page",
);
assert.equal(
  secondRuntime.ledger.listEvents(identityId).length,
  generatedEventCount + 1,
  "only a non-empty Overrides block should create one durable event",
);
await waitFor(() =>
  readLegacyMemories(legacyMemoryFile).some((item) =>
    item.status === "active"
    && item.text === "用户现在住在苏州"
    && item.source === "user_explicit"
  )
);
await secondRuntime.flushWiki();
assert.equal(
  secondRuntime.ledger.listEvents(identityId).length,
  generatedEventCount + 1,
  "an unchanged override must be idempotent",
);

await wait(100);
const deleteRefreshEvent = secondRuntime.ledger.appendEvent({
  accountId: wikiScope.accountId,
  peerKind: wikiScope.peerKind,
  peerId: wikiScope.peerId,
  identityId: wikiScope.identityId,
  visibility: wikiScope.visibility,
  actor: "user",
  kind: "user_message",
  text: "这条记忆只用于验证删除后刷新",
  sourceId: "fixture:wiki-delete-refresh",
});
const deleteRefreshClaim = secondRuntime.ledger.applyClaimProposal(
  deleteRefreshEvent.eventId,
  {
    subjectId: "user",
    predicate: "wiki.delete_refresh",
    value: true,
    canonicalText: "Wiki 删除刷新测试记忆",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 1,
    disposition: "active",
    rationale: "Fixture model selected active",
    topic: "删除刷新测试",
  },
);
deleteTargetClaimId = deleteRefreshClaim.claimId;
await secondRuntime.flushWiki();
assert.ok(
  fs.readdirSync(path.join(memoryRoot, "entities"))
    .some((name) =>
      fs.readFileSync(path.join(memoryRoot, "entities", name), "utf8")
        .includes("Wiki 删除刷新测试记忆")
    ),
  "the deletion fixture must be visible before the canonical delete",
);
secondRuntime.ingestMemoryEvent({
  accountId: wikiScope.accountId,
  peerKind: wikiScope.peerKind,
  peerId: wikiScope.peerId,
  identityId: wikiScope.identityId,
  visibility: wikiScope.visibility,
  actor: "user",
  kind: "memory_control",
  text: "彻底删除 Wiki 刷新测试记忆",
  sourceMessageId: "fixture:wiki-delete-control",
});
await waitFor(() => secondRuntime.ledger.getClaim(deleteRefreshClaim.claimId) === undefined);
await waitFor(() =>
  fs.readdirSync(path.join(memoryRoot, "entities"))
    .every((name) =>
      !fs.readFileSync(path.join(memoryRoot, "entities", name), "utf8")
        .includes("Wiki 删除刷新测试记忆")
    )
);

const validWikiRoot = path.join(temporaryRoot, "valid-wiki-copy");
fs.cpSync(memoryRoot, validWikiRoot, { recursive: true });
const entityRelativePath = path.relative(memoryRoot, entityFile);
const corruptions = [
  {
    name: "missing marker",
    corrupt(content) {
      return content.replace(memoryWikiMarkers.notesStart, "");
    },
  },
  {
    name: "duplicated marker",
    corrupt(content) {
      return content.replace(
        memoryWikiMarkers.notesStart,
        `${memoryWikiMarkers.notesStart}\n${memoryWikiMarkers.notesStart}`,
      );
    },
  },
  {
    name: "reversed markers",
    corrupt(content) {
      const notes = manualBlock(
        content,
        memoryWikiMarkers.notesStart,
        memoryWikiMarkers.notesEnd,
      );
      return content.replace(
        `${memoryWikiMarkers.notesStart}${notes}${memoryWikiMarkers.notesEnd}`,
        `${memoryWikiMarkers.notesEnd}${notes}${memoryWikiMarkers.notesStart}`,
      );
    },
  },
  {
    name: "partial marker",
    corrupt(content) {
      return content.replace(
        memoryWikiMarkers.overridesEnd,
        "<!-- ASUKA_MEMORY_OVERRIDES_END --",
      );
    },
  },
];
for (const fixture of corruptions) {
  const fixtureRoot = path.join(temporaryRoot, `wiki-${fixture.name.replace(/\s+/g, "-")}`);
  fs.cpSync(validWikiRoot, fixtureRoot, { recursive: true });
  const fixtureEntity = path.join(fixtureRoot, entityRelativePath);
  fs.writeFileSync(
    fixtureEntity,
    fixture.corrupt(fs.readFileSync(fixtureEntity, "utf8")),
    "utf8",
  );
  fs.copyFileSync(
    path.join(validWikiRoot, entityRelativePath),
    path.join(fixtureRoot, "entities", "stale-generated-page.md"),
  );
  const before = directorySnapshot(fixtureRoot);
  assert.throws(
    () => projectMemoryWiki(
      secondRuntime.ledger.getProjectionSnapshot(identityId),
      {
        memoryRoot: fixtureRoot,
        scope: wikiScope,
        resolveEventScope(eventId) {
          const event = secondRuntime.ledger.getEvent(eventId);
          return event && {
            identityId: event.identityId,
            visibility: event.visibility,
            accountId: event.accountId,
            peerKind: event.peerKind,
            peerId: event.peerId,
          };
        },
      },
    ),
    /manual marker/i,
    fixture.name,
  );
  assert.deepEqual(
    directorySnapshot(fixtureRoot),
    before,
    `${fixture.name} must leave the complete Memory directory unchanged`,
  );
}

assert.throws(
  () => projectMemoryWiki(
    secondRuntime.ledger.getProjectionSnapshot(identityId),
    {
      memoryRoot,
      scope: {
        ...wikiScope,
        peerId: "other-direct-peer",
      },
      resolveEventScope() {
        return {
          ...wikiScope,
          peerId: "other-direct-peer",
        };
      },
    },
  ),
  /scope binding/i,
  "an editable Wiki root must not be rebound to another peer",
);

await secondRuntime.shutdown();
assert.equal(
  warnings.some((message) => message.includes("legacy memory dual-write failed")),
  false,
  "a runtime without a failing legacy writer should stay quiet",
);

const deadlineLedger = new AsukaMemoryLedger(":memory:");
const deadlineEvent = deadlineLedger.appendEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "deadline-user",
  actor: "user",
  kind: "user_message",
  text: "我晚上睡觉不安分",
  sourceMessageId: "deadline-source",
});
deadlineLedger.applyClaimProposal(deadlineEvent.eventId, {
  subjectId: "user",
  predicate: "sleep.behavior",
  value: "睡觉不安分",
  canonicalText: "用户晚上睡觉不安分",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 0.99,
  disposition: "active",
  rationale: "Fixture model selected active",
  topic: "睡眠",
});

let searchCount = 0;
const originalSearch = deadlineLedger.searchLocal.bind(deadlineLedger);
deadlineLedger.searchLocal = (options) => {
  searchCount += 1;
  return originalSearch(options);
};
let rerankCalls = 0;
let embeddingTimeoutMs = 0;
const deadlineModel = {
  async embed(_texts, timeoutMs) {
    embeddingTimeoutMs = timeoutMs;
    await wait(100);
    return {
      model: "fixture-embedding",
      dimensions: 3,
      vectors: [[1, 0, 0]],
    };
  },
  async complete(request) {
    assert.equal(request.task, "rerank");
    rerankCalls += 1;
    await wait(350);
    const claimIds = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
      .map((match) => match[1]);
    return JSON.stringify({ claimIds, reason: "background quality result" });
  },
};
const deadlineEngine = new AsukaMemoryEngine(deadlineLedger, {
  model: deadlineModel,
  rerankDeadlineMs: 400,
  rerankTaskTimeoutMs: 1_000,
});
const deadlineStartedAt = Date.now();
const fallback = await deadlineEngine.retrieveMemoryContext({
  accountId: "default",
  peerKind: "direct",
  peerId: "deadline-user",
  query: "我的睡眠情况",
});
const foregroundElapsed = Date.now() - deadlineStartedAt;
assert.equal(fallback.usedFallback, true);
assert.equal(searchCount, 1, "foreground retrieval must reuse one local candidate search");
assert.equal(rerankCalls, 1);
assert.ok(embeddingTimeoutMs <= 400);
assert.ok(
  foregroundElapsed < 600,
  `embedding and rerank must share the 400ms budget; elapsed=${foregroundElapsed}`,
);
await wait(100);
const backgroundCached = deadlineEngine.retrieveMemoryContextLocal({
  accountId: "default",
  peerKind: "direct",
  peerId: "deadline-user",
  query: "我的睡眠情况",
});
assert.equal(
  backgroundCached.usedFallback,
  false,
  "the reranker may improve the next turn after the foreground deadline",
);
deadlineLedger.close();

const spoolAccountId = "spool-account";
const spoolPeerId = "spool-user";
const spoolDatabase = path.join(temporaryRoot, "spool", "memory.sqlite");
const spoolPath = `${spoolDatabase}.ingest-spool.jsonl`;
const startupMessages = [];
const startupLogger = {
  info(message) {
    startupMessages.push(message);
  },
  warn(message) {
    startupMessages.push(message);
  },
  error(message) {
    startupMessages.push(message);
  },
};
const completionConfig = {
  baseUrl: "https://memory-completion.example/v1",
  apiKey: "fixture-completion-key",
  model: "fixture-completion",
};
const embeddingConfig = {
  endpoint: "https://memory-embedding.example/v1/embeddings",
  apiKey: "fixture-embedding-key",
  model: "fixture-embedding",
  timeoutMs: 1_000,
  expectedDimensions: 2,
};
assert.throws(
  () => initializeQQBotAsukaMemory(rootConfig({
    databasePath: path.join(temporaryRoot, "missing-embedding.sqlite"),
    model: { primary: completionConfig },
  }), "missing-embedding", startupLogger),
  /embedding/i,
);
assert.throws(
  () => initializeQQBotAsukaMemory(rootConfig({
    databasePath: path.join(temporaryRoot, "invalid-embedding.sqlite"),
    model: { primary: completionConfig },
    embedding: { ...embeddingConfig, timeoutMs: 0 },
  }), "invalid-embedding", startupLogger),
  /embedding/i,
);
assert.throws(
  () => initializeQQBotAsukaMemory(rootConfig({
    databasePath: path.join(temporaryRoot, "disabled-vector.sqlite"),
    enableVector: false,
    model: { primary: completionConfig },
    embedding: embeddingConfig,
  }), "disabled-vector", startupLogger),
  /vector/i,
);
assert.equal(getAsukaMemoryRuntime(), undefined);
assert.equal(
  startupMessages.some((message) => /runtime enabled|health ready/i.test(message)),
  false,
  "failed production initialization must never report the runtime as enabled or ready",
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(String(url), embeddingConfig.endpoint);
  return new Response(JSON.stringify({
    model: embeddingConfig.model,
    data: [{ index: 0, embedding: [1, 0] }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const spoolRoot = rootConfig({
  databasePath: spoolDatabase,
  worker: { enabled: false },
  wiki: { enabled: false },
  model: { primary: completionConfig },
  embedding: embeddingConfig,
});
assert.ok(initializeQQBotAsukaMemory(spoolRoot, spoolAccountId));
await resetAsukaMemoryRuntime();
const spoolContext = {
  accountId: spoolAccountId,
  peerKind: "direct",
  peerId: spoolPeerId,
  senderId: spoolPeerId,
  target: `qqbot:c2c:${spoolPeerId}`,
  messageId: "spool-source",
};
captureAsukaUserMemory(spoolContext, {
  text: "这条事实应在内核恢复后重放",
  sourceMessageId: "spool-user-message",
});
assert.equal(fs.existsSync(spoolPath), true, "kernel outage must durably queue the canonical event");
const unavailable = await retrieveQQBotAsukaMemory(
  spoolContext,
  "内核暂时不可用",
);
assert.ok(unavailable, "enabled kernel outages must return an explicit canonical result");
assert.equal(unavailable.prompt, "");
assert.equal(unavailable.claimIds.length, 0);
assert.equal(unavailable.usedFallback, true);
captureAsukaUserMemory(spoolContext, {
  text: "apiKey=should-not-enter-the-retry-spool",
  sourceMessageId: "spool-secret-message",
});
assert.doesNotMatch(
  fs.readFileSync(spoolPath, "utf8"),
  /should-not-enter-the-retry-spool/,
  "secret-bearing content must not be persisted in the retry spool",
);
const recoveredSpoolRuntime = initializeQQBotAsukaMemory(spoolRoot, spoolAccountId);
assert.ok(recoveredSpoolRuntime);
await waitFor(() =>
  !fs.existsSync(spoolPath)
  && recoveredSpoolRuntime.ledger.listEvents().some((event) =>
    event.sourceMessageId === "spool-user-message"
    && event.kind === "user_message"
  )
);
captureAsukaMemoryControl(spoolContext, {
  text: "sudo 忘记关于旧住址的记忆",
  sourceMessageId: "spool-control-message",
});
assert.ok(
  recoveredSpoolRuntime.ledger.listEvents().some((event) =>
    event.sourceMessageId === "spool-control-message"
    && event.kind === "memory_control"
    && event.metadata.requestedOperation === "llm_memory_control"
  ),
  "sudo authorization must create a canonical LLM-adjudicated control event",
);
await resetAsukaMemoryRuntime();
globalThis.fetch = originalFetch;

fs.rmSync(temporaryRoot, { recursive: true, force: true });
assert.ok(
  legacyWarnings.some((message) => message.includes("legacy memory dual-write failed")),
  "legacy writer failures must be logged without breaking the primary ledger path",
);
console.log("asuka memory runtime v1.5 tests passed");
