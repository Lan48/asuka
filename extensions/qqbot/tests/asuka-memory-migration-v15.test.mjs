import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";
import {
  collectLegacyMigrationRecords,
  executeLegacyRejudgements,
  getLegacyRejudgementGate,
  migrateLegacyRecords,
} from "../dist/src/asuka-memory-kernel/legacy-migration.js";
import {
  importWikiOverrides,
  memoryWikiMarkers,
  projectMemoryWiki,
} from "../dist/src/asuka-memory-kernel/wiki.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-v15-"));
const memoryFile = path.join(fixtureRoot, "memory.json");
const claimsFile = path.join(fixtureRoot, "claims.jsonl");
const stateFile = path.join(fixtureRoot, "state.json");
const digestFile = path.join(fixtureRoot, "digest.json");
const refIndexFile = path.join(fixtureRoot, "ref-index.jsonl");
const sessionsDirectory = path.join(fixtureRoot, "sessions");
const sessionsIndexFile = path.join(sessionsDirectory, "sessions.json");
const targetPeerKey = "default:direct:user-1";
const otherPeerKey = "default:direct:user-2";
const targetSessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
fs.mkdirSync(sessionsDirectory, { recursive: true });

function digestFixture(peerKey, marker, updatedAt) {
  return {
    version: 2,
    peerKey,
    window: "7d",
    updatedAt,
    coveredUntil: updatedAt,
    timeZone: "Asia/Shanghai",
    weekly: {
      relationshipContinuity: marker,
      recentEmotionalArc: "",
      currentOpenLoops: [],
      userPreferences: [],
      temporaryDirectives: [],
      asukaSelfContinuity: "",
      sceneContinuity: "",
      importantRecentFacts: [],
      thingsToAvoid: [],
      lastSalientTurns: [],
      evidenceNotes: [],
    },
    daily: [],
  };
}

fs.writeFileSync(memoryFile, JSON.stringify({
  version: 1,
  memories: {
    "legacy-explicit": {
      id: "legacy-explicit",
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      type: "explicit",
      text: "我晚上睡觉不安分",
      source: "user_explicit",
      createdAt: 100,
      status: "active",
    },
    "legacy-noise": {
      id: "legacy-noise",
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      type: "boundary",
      text: "不想睡",
      source: "user_inferred",
      createdAt: 200,
      status: "active",
    },
  },
}, null, 2));
fs.writeFileSync(claimsFile, `${JSON.stringify({
  id: "legacy-claim",
  accountId: "default",
  peerId: "user-1",
  value: "旧住所推断",
  sourceKind: "user_inferred",
  observedAt: "2026-01-01T00:00:00Z",
})}\n`);
fs.writeFileSync(stateFile, JSON.stringify({
  version: 1,
  peers: {
    [targetPeerKey]: {
      accountId: "default",
      peerKey: targetPeerKey,
      peerKind: "direct",
      peerId: "user-1",
      marker: "target-state",
    },
    [otherPeerKey]: {
      accountId: "default",
      peerKey: otherPeerKey,
      peerKind: "direct",
      peerId: "user-2",
      marker: "other-state-must-not-import",
    },
  },
  promises: {
    "promise-target": {
      id: "promise-target",
      accountId: "default",
      peerKey: targetPeerKey,
      peerKind: "direct",
      peerId: "user-1",
      marker: "target-promise",
    },
    "promise-other": {
      id: "promise-other",
      accountId: "default",
      peerKey: otherPeerKey,
      peerKind: "direct",
      peerId: "user-2",
      marker: "other-promise-must-not-import",
    },
  },
}));
fs.writeFileSync(digestFile, JSON.stringify({
  version: 2,
  digests: {
    [targetPeerKey]: digestFixture(targetPeerKey, "target-digest", 400),
    [otherPeerKey]: digestFixture(otherPeerKey, "other-digest-must-not-import", 500),
  },
}));
fs.writeFileSync(refIndexFile, [
  JSON.stringify({
    k: "REFIDX_TARGET",
    v: {
      content: "target-ref-content",
      senderId: "user-1",
      peerId: "user-1",
      timestamp: 300,
      attachments: [{ type: "voice", transcript: "target-ref-transcript" }],
    },
    t: 301,
  }),
  JSON.stringify({
    k: "REFIDX_OTHER",
    v: {
      content: "other-ref-must-not-import",
      senderId: "user-2",
      peerId: "user-2",
      timestamp: 302,
    },
    t: 303,
  }),
].join("\n"));
fs.writeFileSync(sessionsIndexFile, JSON.stringify({
  "agent:main:qqbot:direct:user-1": {
    sessionId: targetSessionId,
    channel: "qqbot",
    chatType: "direct",
  },
  "agent:main:qqbot:direct:user-2": {
    sessionId: otherSessionId,
    channel: "qqbot",
    chatType: "direct",
  },
}));
fs.writeFileSync(path.join(sessionsDirectory, `${targetSessionId}.jsonl`), [
  JSON.stringify({
    type: "message",
    id: "session-user",
    timestamp: "2026-01-02T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "我这周暂住朋友家" }],
    },
  }),
  JSON.stringify({
    type: "message",
    id: "session-assistant",
    timestamp: "2026-01-02T00:00:01Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "那我记得你现在是暂住，不会当成常住地址。" }],
    },
  }),
].join("\n"));
fs.writeFileSync(path.join(sessionsDirectory, `${otherSessionId}.jsonl`), `${JSON.stringify({
  type: "message",
  id: "other-session-message",
  timestamp: "2026-01-02T00:00:02Z",
  message: {
    role: "user",
    content: [{ type: "text", text: "other-session-must-not-import" }],
  },
})}\n`);

const sources = {
  memoryJson: memoryFile,
  claimsJsonl: claimsFile,
  stateJson: stateFile,
  digestJson: digestFile,
  refIndexJsonl: refIndexFile,
  sessionsIndexJson: sessionsIndexFile,
  sessionsDirectory,
};
const scope = { accountId: "default", peerId: "user-1" };
const records = collectLegacyMigrationRecords(sources, scope);
assert.deepEqual(
  Object.fromEntries(
    ["memory", "claim", "state", "digest", "ref_index", "session"].map((kind) => [
      kind,
      records.filter((record) => record.sourceKind === kind).length,
    ]),
  ),
  { memory: 2, claim: 1, state: 1, digest: 1, ref_index: 1, session: 2 },
);
const scopedState = JSON.parse(records.find((record) => record.sourceKind === "state").sourceContent);
assert.equal(scopedState.peerKey, targetPeerKey);
assert.equal(scopedState.peer.marker, "target-state");
assert.deepEqual(Object.keys(scopedState.promises), ["promise-target"]);
assert.doesNotMatch(JSON.stringify(scopedState), /other-.*-must-not-import/);
const scopedDigest = JSON.parse(records.find((record) => record.sourceKind === "digest").sourceContent);
assert.equal(scopedDigest.peerKey, targetPeerKey);
assert.equal(scopedDigest.digest.weekly.relationshipContinuity, "target-digest");
assert.doesNotMatch(JSON.stringify(scopedDigest), /other-digest-must-not-import/);
const scopedRefIndex = records.find((record) => record.sourceKind === "ref_index");
assert.equal(scopedRefIndex.legacyId, "REFIDX_TARGET");
assert.match(scopedRefIndex.text, /target-ref-content/);
assert.match(scopedRefIndex.text, /target-ref-transcript/);
assert.doesNotMatch(scopedRefIndex.sourceContent, /other-ref-must-not-import/);
assert.equal(
  records.some((record) => record.text.includes("other-session-must-not-import")),
  false,
);
const malformedClaimsFile = path.join(fixtureRoot, "malformed-claims.jsonl");
fs.writeFileSync(malformedClaimsFile, "{\"id\":\n");
assert.throws(
  () => collectLegacyMigrationRecords({ claimsJsonl: malformedClaimsFile }, scope),
  /cannot parse legacy JSONL source .*:1:/,
  "a malformed configured source must block a lossless migration",
);
assert.throws(
  () => collectLegacyMigrationRecords({
    memoryJson: path.join(fixtureRoot, "missing-memory.json"),
  }, scope),
  /legacy source does not exist:/,
  "a missing configured source must not be treated as an empty source",
);
const missingScopeStateFile = path.join(fixtureRoot, "missing-scope-state.json");
fs.writeFileSync(missingScopeStateFile, JSON.stringify({
  version: 1,
  peers: {
    [otherPeerKey]: {
      accountId: "default",
      peerKey: otherPeerKey,
      peerKind: "direct",
      peerId: "user-2",
    },
  },
  promises: {},
}));
assert.throws(
  () => collectLegacyMigrationRecords({ stateJson: missingScopeStateFile }, scope),
  /does not contain exact scope/i,
  "a configured global state without the exact peer entry must fail closed",
);
const conflictingScopeDigestFile = path.join(fixtureRoot, "conflicting-scope-digest.json");
fs.writeFileSync(conflictingScopeDigestFile, JSON.stringify({
  version: 2,
  digests: {
    [targetPeerKey]: digestFixture(otherPeerKey, "conflicting-digest", 600),
  },
}));
assert.throws(
  () => collectLegacyMigrationRecords({ digestJson: conflictingScopeDigestFile }, scope),
  /scope metadata/i,
  "a digest stored under the target key with conflicting scope metadata must fail closed",
);
const flatRefIndexFile = path.join(fixtureRoot, "flat-ref-index.jsonl");
fs.writeFileSync(flatRefIndexFile, `${JSON.stringify({
  id: "legacy-flat-row",
  peerId: "user-1",
  content: "unsupported-flat-ref-index",
  timestamp: 700,
})}\n`);
assert.throws(
  () => collectLegacyMigrationRecords({ refIndexJsonl: flatRefIndexFile }, scope),
  /ref-index.*\{k,v,t\}/i,
  "unknown ref-index row schemas must fail closed",
);
const hostileSessionsDirectory = path.join(fixtureRoot, "hostile-sessions");
const hostileSessionsIndex = path.join(hostileSessionsDirectory, "sessions.json");
fs.mkdirSync(hostileSessionsDirectory, { recursive: true });
fs.writeFileSync(hostileSessionsIndex, JSON.stringify({
  "agent:main:qqbot:direct:user-1": {
    sessionId: "../../outside",
    channel: "qqbot",
    chatType: "direct",
  },
}));
assert.throws(
  () => collectLegacyMigrationRecords({
    sessionsIndexJson: hostileSessionsIndex,
    sessionsDirectory: hostileSessionsDirectory,
  }, scope),
  /invalid legacy session id/i,
  "a hostile session id must be rejected before any transcript path is read",
);

const sourceAccountingRegressionFailures = [];
function verifySourceAccountingRegression(name, run) {
  try {
    run();
  } catch (error) {
    sourceAccountingRegressionFailures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

verifySourceAccountingRegression("full source content hash", () => {
  const collisionSessionsDirectory = path.join(fixtureRoot, "collision-sessions");
  const collisionSessionsIndex = path.join(collisionSessionsDirectory, "sessions.json");
  const collisionSessionId = "33333333-3333-4333-8333-333333333333";
  const collisionSessionFile = path.join(
    collisionSessionsDirectory,
    `${collisionSessionId}.jsonl`,
  );
  const sharedPrefix = "相".repeat(8_000);
  fs.mkdirSync(collisionSessionsDirectory, { recursive: true });
  fs.writeFileSync(collisionSessionsIndex, JSON.stringify({
    "agent:main:qqbot:direct:user-1": {
      sessionId: collisionSessionId,
      channel: "qqbot",
      chatType: "direct",
    },
  }));
  const writeCollisionRow = (tail) => fs.writeFileSync(
    collisionSessionFile,
    `${JSON.stringify({
      type: "message",
      id: "collision-message",
      timestamp: "2026-07-27T00:00:00Z",
      message: {
        role: "user",
        content: [{ type: "text", text: `${sharedPrefix}${tail}` }],
      },
    })}\n`,
  );
  const collisionSources = {
    sessionsIndexJson: collisionSessionsIndex,
    sessionsDirectory: collisionSessionsDirectory,
  };
  const collisionLedger = new AsukaMemoryLedger(":memory:");
  try {
    const collisionEngine = new AsukaMemoryEngine(collisionLedger);
    writeCollisionRow("尾部甲");
    const firstRecords = collectLegacyMigrationRecords(collisionSources, scope);
    assert.equal(firstRecords.length, 1);
    assert.equal(firstRecords[0].text.length, 8_000, "model-facing text stays bounded");
    assert.ok(firstRecords[0].sourceRecordId, "physical row identity must be explicit");
    const firstReport = migrateLegacyRecords(collisionEngine, firstRecords, scope);
    assert.equal(firstReport.importedEvents, 1);
    const storedSource = collisionLedger.getEvent(firstReport.sourceMap[0].eventId);
    assert.equal(storedSource.text.length, 8_000);
    assert.equal(typeof storedSource.metadata.legacyContentHash, "string");
    assert.equal("legacyRecord" in storedSource.metadata, false);
    assert.doesNotMatch(JSON.stringify(storedSource.metadata), /尾部甲/);

    writeCollisionRow("尾部乙");
    const changedRecords = collectLegacyMigrationRecords(collisionSources, scope);
    assert.equal(changedRecords[0].sourceRecordId, firstRecords[0].sourceRecordId);
    assert.throws(
      () => migrateLegacyRecords(collisionEngine, changedRecords, scope),
      /legacy content hash mismatch/i,
      "content beyond the model text limit must remain collision-bound",
    );
  } finally {
    collisionLedger.close();
  }
});

verifySourceAccountingRegression("secret-bearing legacy payload is not persisted", () => {
  const secret = "sk-phase23-secret-1234567890";
  const secretMemoryFile = path.join(fixtureRoot, "secret-memory.json");
  const secretDatabase = path.join(fixtureRoot, "secret-memory.sqlite");
  fs.writeFileSync(secretMemoryFile, JSON.stringify({
    version: 1,
    memories: {
      "secret-record": {
        id: "secret-record",
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
        type: "explicit",
        text: `api_key=${secret}`,
        source: "user_explicit",
        nested: { rawSecret: secret },
      },
    },
  }));
  const secretRecords = collectLegacyMigrationRecords(
    { memoryJson: secretMemoryFile },
    scope,
  );
  const secretLedger = new AsukaMemoryLedger(secretDatabase);
  try {
    const secretEngine = new AsukaMemoryEngine(secretLedger);
    const secretReport = migrateLegacyRecords(secretEngine, secretRecords, scope);
    const secretEvent = secretLedger.getEvent(secretReport.sourceMap[0].eventId);
    assert.equal(secretEvent.text, "[secret-bearing content omitted]");
    assert.equal(secretEvent.metadata.secretRedacted, true);
    assert.equal("legacyRecord" in secretEvent.metadata, false);
    assert.equal(typeof secretEvent.metadata.legacyContentHash, "string");
    assert.equal(secretEvent.metadata.legacySourcePath, secretMemoryFile);
    assert.doesNotMatch(JSON.stringify(secretEvent.metadata), new RegExp(secret));
  } finally {
    secretLedger.close();
  }
  for (const sqlitePath of [
    secretDatabase,
    `${secretDatabase}-wal`,
    `${secretDatabase}-shm`,
  ]) {
    if (!fs.existsSync(sqlitePath)) continue;
    assert.equal(
      fs.readFileSync(sqlitePath).includes(Buffer.from(secret)),
      false,
      `plaintext secret must not remain in ${path.basename(sqlitePath)}`,
    );
  }
});

verifySourceAccountingRegression("duplicate logical IDs keep physical row identity", () => {
  const duplicateClaimsFile = path.join(fixtureRoot, "duplicate-claims.jsonl");
  fs.writeFileSync(duplicateClaimsFile, [
    JSON.stringify({ id: "duplicate-id", value: "重复 ID 的第一条证据" }),
    JSON.stringify({ id: "duplicate-id", value: "重复 ID 的第二条证据" }),
  ].join("\n"));
  const duplicateRecords = collectLegacyMigrationRecords(
    { claimsJsonl: duplicateClaimsFile },
    scope,
  );
  assert.equal(duplicateRecords.length, 2);
  assert.equal(
    new Set(duplicateRecords.map((record) => record.sourceRecordId)).size,
    2,
    "JSONL line identity must disambiguate duplicate legacy IDs",
  );
  const duplicateLedger = new AsukaMemoryLedger(":memory:");
  try {
    const duplicateEngine = new AsukaMemoryEngine(duplicateLedger);
    const duplicateReport = migrateLegacyRecords(duplicateEngine, duplicateRecords, scope);
    assert.equal(duplicateReport.importedEvents, 2);
    assert.equal(duplicateReport.skippedRecords, 0);
    assert.equal(duplicateReport.sourceMap.length, 2);
    const duplicateRepeat = migrateLegacyRecords(
      duplicateEngine,
      duplicateRecords,
      scope,
    );
    assert.equal(duplicateRepeat.importedEvents, 0);
    assert.equal(duplicateRepeat.duplicateEvents, 2);
  } finally {
    duplicateLedger.close();
  }
});

verifySourceAccountingRegression("every parseable source row is accounted", () => {
  const accountingClaimsFile = path.join(fixtureRoot, "accounting-claims.jsonl");
  fs.writeFileSync(accountingClaimsFile, [
    JSON.stringify({ id: "known", value: "可识别声明" }),
    JSON.stringify({ id: "empty" }),
    JSON.stringify({ id: "unknown", opaque: { nested: true } }),
    JSON.stringify(["schema", "mismatch"]),
    JSON.stringify(null),
    JSON.stringify("standalone legacy row"),
  ].join("\n"));
  const accountingRecords = collectLegacyMigrationRecords(
    { claimsJsonl: accountingClaimsFile },
    scope,
  );
  assert.equal(
    accountingRecords.length,
    6,
    "empty, unknown, and schema-mismatched but parseable rows must not disappear",
  );
  assert.equal(
    new Set(accountingRecords.map((record) => record.sourceRecordId)).size,
    6,
    "every physical row must have one stable accounting identity",
  );
  const accountingLedger = new AsukaMemoryLedger(":memory:");
  try {
    const accountingEngine = new AsukaMemoryEngine(accountingLedger);
    const accountingReport = migrateLegacyRecords(
      accountingEngine,
      accountingRecords,
      scope,
    );
    assert.equal(accountingReport.discoveredRecords, 6);
    assert.equal(accountingReport.sourceCounts.claim, 6);
    assert.equal(accountingReport.sourceMap.length, 6);
    assert.equal(accountingReport.auditedNonImportRecords, 5);
    assert.equal(
      accountingReport.sourceMap
        .filter((item) => item.status === "audited_non_import").length,
      5,
    );
    assert.ok(
      accountingReport.sourceMap
        .filter((item) => item.status === "audited_non_import")
        .every((item) => typeof item.reason === "string" && item.reason.length > 0),
      "every deterministic non-import outcome must retain an audit reason",
    );
    assert.equal(
      accountingReport.importedEvents
        + accountingReport.duplicateEvents
        + accountingReport.skippedRecords,
      accountingReport.discoveredRecords,
      "terminal outcomes must exactly cover every discovered row",
    );
    assert.equal(accountingReport.skippedRecords, 0);
    assert.deepEqual(
      accountingReport.sourceMap.map((item) => item.sourceRecordId),
      accountingRecords.map((record) => record.sourceRecordId),
    );
    const auditOnlyLedger = new AsukaMemoryLedger(":memory:");
    try {
      const auditOnlyEngine = new AsukaMemoryEngine(auditOnlyLedger);
      const auditOnlyRecords = accountingRecords
        .filter((record) => record.auditedNonImport);
      const auditOnlyReport = migrateLegacyRecords(
        auditOnlyEngine,
        auditOnlyRecords,
        scope,
      );
      assert.equal(auditOnlyReport.auditedNonImportRecords, 5);
      assert.equal(
        getLegacyRejudgementGate(auditOnlyEngine).passed,
        true,
        "recognized deterministic audit dispositions must not require model jobs",
      );
    } finally {
      auditOnlyLedger.close();
    }
  } finally {
    accountingLedger.close();
  }
});

const database = path.join(fixtureRoot, "memory-ledger.sqlite.next");
const ledger = new AsukaMemoryLedger(database);
const engine = new AsukaMemoryEngine(ledger);
const firstMigration = migrateLegacyRecords(engine, records, scope);
assert.equal(firstMigration.discoveredRecords, 8);
assert.equal(firstMigration.importedEvents, 8);
assert.equal(firstMigration.skippedRecords, 0);
assert.equal(firstMigration.provisionalCandidates, 3);
assert.equal(ledger.listClaims({ states: ["active"] }).length, 0, "legacy claims must not become active without rejudgement");
assert.equal(ledger.listClaims({ states: ["candidate"] }).length, 3);
assert.equal(ledger.listJobs("pending").length, 8);
assert.ok(firstMigration.sourceMap.every((item) => item.eventId), "every imported legacy id must map to an event");

const secondMigration = migrateLegacyRecords(engine, records, scope);
assert.equal(secondMigration.importedEvents, 0);
assert.equal(secondMigration.duplicateEvents, 8, "migration must be safely resumable");
assert.equal(ledger.listEvents().length, 8);
const untrackedLegacyEvent = engine.ingestMemoryEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  actor: "user",
  kind: "legacy_import",
  text: "未排入重裁决队列的旧记忆",
}, { enqueue: false });
assert.ok(untrackedLegacyEvent.receipt);
const untrackedGate = getLegacyRejudgementGate(engine);
assert.equal(untrackedGate.passed, false);
assert.equal(untrackedGate.events.untracked, 1);
assert.match(untrackedGate.blockers.join("; "), /no rejudgement job/);
ledger.enqueueJob(untrackedLegacyEvent.receipt.eventId, "legacy_rejudge");
assert.equal(getLegacyRejudgementGate(engine).events.untracked, 0);

const wikiRoot = path.join(fixtureRoot, "Memory");
const wikiScope = {
  identityId: "private:default:user-1",
  visibility: "private",
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
};
const wikiProjectionOptions = {
  memoryRoot: wikiRoot,
  scope: wikiScope,
  resolveEventScope(eventId) {
    const event = ledger.getEvent(eventId);
    return event && {
      identityId: event.identityId,
      visibility: event.visibility,
      accountId: event.accountId,
      peerKind: event.peerKind,
      peerId: event.peerId,
    };
  },
};
const firstProjection = projectMemoryWiki(
  ledger.getProjectionSnapshot(undefined, 1_000),
  wikiProjectionOptions,
);
assert.equal(firstProjection.pageCount, 1, "only a topic with real claims should generate a page");
assert.ok(firstProjection.changedFiles.some((file) => file.endsWith("index.md")));
const entityFile = firstProjection.changedFiles.find((file) => file.includes(`${path.sep}entities${path.sep}`));
assert.ok(entityFile);

let entityContent = fs.readFileSync(entityFile, "utf8");
entityContent = entityContent
  .replace(
    memoryWikiMarkers.notesStart,
    `${memoryWikiMarkers.notesStart}\n用户自由 Notes，compile 后必须保留。`,
  )
  .replace(
    memoryWikiMarkers.overridesStart,
    `${memoryWikiMarkers.overridesStart}\n用户明确纠正：我睡觉其实很安稳。`,
  );
fs.writeFileSync(entityFile, entityContent);
const secondProjection = projectMemoryWiki(
  ledger.getProjectionSnapshot(undefined, 1_000),
  wikiProjectionOptions,
);
const preserved = fs.readFileSync(entityFile, "utf8");
assert.match(preserved, /用户自由 Notes/);
assert.match(preserved, /用户明确纠正/);
const thirdProjection = projectMemoryWiki(
  ledger.getProjectionSnapshot(undefined, 1_000),
  wikiProjectionOptions,
);
assert.equal(
  thirdProjection.changedFiles.length,
  0,
  `an unchanged projection must be idempotent after manual blocks are normalized; previous=${secondProjection.changedFiles.length}`,
);

const overrideImport = importWikiOverrides(engine, {
  memoryRoot: wikiRoot,
  expectedScope: wikiScope,
});
assert.equal(overrideImport.imported, 1);
const repeatedOverrideImport = importWikiOverrides(engine, {
  memoryRoot: wikiRoot,
  expectedScope: wikiScope,
});
assert.equal(repeatedOverrideImport.imported, 0);
assert.equal(repeatedOverrideImport.unchanged, 1);
const overrideEvent = ledger.getEvent(overrideImport.eventIds[0]);
assert.equal(overrideEvent.kind, "human_override");
assert.equal(overrideEvent.actor, "user");
assert.equal(overrideEvent.identityId, wikiScope.identityId);
assert.equal(overrideEvent.visibility, wikiScope.visibility);
assert.equal(overrideEvent.accountId, wikiScope.accountId);
assert.equal(overrideEvent.peerKind, wikiScope.peerKind);
assert.equal(overrideEvent.peerId, wikiScope.peerId);
assert.equal(ledger.integrityCheck().ok, true);

ledger.close();

function legacyRecord(id, text, occurredAt, actor = "user") {
  return {
    sourceKind: "memory",
    sourcePath: memoryFile,
    legacyId: id,
    actor,
    text,
    occurredAt,
    metadata: {},
    provisional: {
      legacyType: actor === "user" ? "explicit" : "assistant_summary",
      topLevelType: "fact",
      epistemicStatus: actor === "user" ? "explicit" : "inferred",
    },
  };
}

function promptPayload(prompt, marker) {
  const line = prompt.split("\n").find((item) => item.startsWith(`${marker}=`));
  assert.ok(line, `missing ${marker} payload`);
  return JSON.parse(line.slice(marker.length + 1));
}

function extractionForResidence(request) {
  const { event } = promptPayload(request.prompt, "LEGACY_EXTRACTION_INPUT");
  const inHangzhou = event.text.includes("杭州");
  return JSON.stringify({
    proposals: [{
      subjectId: "user",
      predicate: inHangzhou ? "home.city" : "residence.current_city",
      value: inHangzhou ? "杭州" : "苏州",
      canonicalText: inHangzhou ? "用户曾住在杭州" : "用户目前住在苏州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      sourceKind: "statement",
      confidence: 0.99,
      topic: "居住状态",
      lifecycle: "bounded",
    }],
  });
}

function consolidateResidences(request) {
  const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
  const hangzhou = items.filter((item) => item.canonicalText.includes("杭州"));
  const suzhou = items.filter((item) => item.canonicalText.includes("苏州"));
  assert.equal(hangzhou.length, 1);
  assert.equal(suzhou.length, 2);
  return JSON.stringify({
    claims: [
      {
        semanticKey: "user.residence.current_city",
        sourceItemIds: hangzhou.map((item) => item.itemId),
        subjectId: "user",
        predicate: "residence.current_city",
        value: "杭州",
        canonicalText: "用户曾住在杭州",
        topLevelType: "fact",
        epistemicStatus: "explicit",
        confidence: 0.99,
        topic: "居住状态",
        lifecycle: "bounded",
      },
      {
        semanticKey: "user.residence.current_city",
        sourceItemIds: suzhou.map((item) => item.itemId),
        subjectId: "user",
        predicate: "residence.current_city",
        value: "苏州",
        canonicalText: "用户目前住在苏州",
        topLevelType: "fact",
        epistemicStatus: "explicit",
        confidence: 0.99,
        topic: "居住状态",
        lifecycle: "bounded",
      },
    ],
    discarded: [],
  });
}

const migrationInvariantFailures = [];
async function verifyMigrationInvariant(name, run) {
  try {
    await run();
  } catch (error) {
    migrationInvariantFailures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await verifyMigrationInvariant("legacy stable content hash", async () => {
  const hashLedger = new AsukaMemoryLedger(":memory:");
  try {
    const hashEngine = new AsukaMemoryEngine(hashLedger);
    const stableHashFirst = migrateLegacyRecords(hashEngine, [
      legacyRecord("stable-hash", "同一份旧记忆证据", 10_000),
    ], scope);
    assert.equal(stableHashFirst.importedEvents, 1);
    const stableHashRepeat = migrateLegacyRecords(hashEngine, [
      legacyRecord("stable-hash", "同一份旧记忆证据", 99_999),
    ], scope);
    assert.equal(
      stableHashRepeat.duplicateEvents,
      1,
      "unstable fallback timestamps must not change the legacy content binding",
    );
    assert.throws(
      () => migrateLegacyRecords(hashEngine, [
        legacyRecord("stable-hash", "同一个旧 ID 下被替换的内容", 99_999),
      ], scope),
      /legacy content hash mismatch/i,
      "one legacy ID must never silently bind to different evidence",
    );
  } finally {
    hashLedger.close();
  }
});

const chronologicalRejudgementRecords = [
  legacyRecord("residence-hangzhou", "我以前住在杭州", 1_000),
  legacyRecord("residence-suzhou", "我已经搬到苏州", 2_000),
  legacyRecord("residence-suzhou-confirmation", "苏州现在是我的常住地", 3_000),
];
const rejudgementRecords = [
  chronologicalRejudgementRecords[2],
  chronologicalRejudgementRecords[0],
  chronologicalRejudgementRecords[1],
];
const rejudgementDatabase = path.join(fixtureRoot, "rejudgement.sqlite");
let firstAttempt = true;
const failingLedger = new AsukaMemoryLedger(rejudgementDatabase);
const failingEngine = new AsukaMemoryEngine(failingLedger, {
  maxJobAttempts: 1,
  model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        if (firstAttempt) {
          firstAttempt = false;
          throw new Error("fixture provider outage");
        }
        return extractionForResidence(request);
      }
      throw new Error(`unexpected task before extraction completes: ${request.task}`);
    },
  },
});
for (const record of rejudgementRecords) {
  migrateLegacyRecords(failingEngine, [record], scope);
  await wait(2);
}
assert.equal(failingLedger.listEvents().length, 3);
assert.equal(
  failingEngine.retrieveMemoryContextLocal({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    query: "我住在哪里",
  }).claimIds.length,
  0,
  "migration candidates must never participate in official recall",
);
const stagedGate = getLegacyRejudgementGate(failingEngine);
assert.equal(stagedGate.passed, false);
assert.equal(stagedGate.jobs.pending, 3);
assert.equal(stagedGate.claims.provisionalOpen, 3);
const interrupted = await executeLegacyRejudgements(failingEngine, {
  batchSize: 1,
  maxBatches: 1,
  retryDelayMs: 0,
});
assert.equal(interrupted.processed, 1);
assert.equal(interrupted.failed, 1);
assert.equal(interrupted.gateAfter.jobs.failed, 1);
assert.equal(interrupted.gateAfter.jobs.pending, 2);
assert.equal(interrupted.gateAfter.consolidation.status, "not_started");
failingLedger.close();

const taskCalls = [];
const resumedLedger = new AsukaMemoryLedger(rejudgementDatabase);
const resumedEngine = new AsukaMemoryEngine(resumedLedger, {
  model: {
    async complete(request) {
      taskCalls.push(request.task);
      if (request.task === "legacy_extract") return extractionForResidence(request);
      if (request.task === "legacy_consolidate") return consolidateResidences(request);
      throw new Error(`unexpected task: ${request.task}`);
    },
  },
});
const resumed = await executeLegacyRejudgements(resumedEngine, {
  batchSize: 2,
  retryDelayMs: 0,
  retryFailed: true,
});
assert.equal(resumed.retriedFailedJobs, 1);
assert.equal(resumed.gateAfter.passed, true, resumed.gateAfter.blockers.join("; "));
assert.equal(resumed.gateAfter.jobs.completed, 3);
assert.equal(resumed.gateAfter.extractions.completed, 3);
assert.equal(resumed.gateAfter.consolidation.status, "completed");
assert.equal(resumed.gateAfter.coverage.sourceEvents, 3);
assert.equal(resumed.gateAfter.coverage.coveredSourceEvents, 3);
assert.equal(resumed.gateAfter.claims.provisionalOpen, 0);
assert.ok(taskCalls.includes("legacy_extract"));
assert.ok(taskCalls.includes("legacy_consolidate"));
assert.equal(resumedLedger.listEvents().length, 3, "raw legacy events must remain lossless");

const residenceClaims = resumedLedger.listClaims()
  .filter((claim) => claim.predicate === "residence.current_city");
const currentResidence = residenceClaims.find((claim) => claim.state === "active");
const previousResidence = residenceClaims.find((claim) => claim.state === "superseded");
assert.equal(currentResidence?.canonicalText, "用户目前住在苏州");
assert.equal(currentResidence?.supportingEvidenceCount, 2, "semantic duplicates must merge evidence");
assert.equal(previousResidence?.canonicalText, "用户曾住在杭州");
assert.equal(
  currentResidence?.rootClaimId,
  previousResidence?.rootClaimId,
  "a changed fact must remain in one version chain despite predicate paraphrases",
);
assert.ok((previousResidence?.validFrom ?? Infinity) < (currentResidence?.validFrom ?? -Infinity));
assert.equal(
  resumedLedger.listClaims({ states: ["candidate"] })
    .filter((claim) => claim.metadata.migrationPendingConsolidation === true)
    .length,
  0,
  "successful consolidation must close every extraction candidate",
);

const repeatedMigration = migrateLegacyRecords(resumedEngine, rejudgementRecords, scope);
assert.equal(repeatedMigration.importedEvents, 0);
const callsBeforeRepeat = taskCalls.length;
const repeatedExecution = await executeLegacyRejudgements(resumedEngine);
assert.equal(repeatedExecution.processed, 0);
assert.equal(repeatedExecution.gateAfter.passed, true);
assert.equal(taskCalls.length, callsBeforeRepeat, "completed consolidation must be idempotent");

assert.ok(currentResidence);
const reorganizedResidenceClaimIds = new Set([
  ...residenceClaims
    .filter((claim) => claim.metadata.legacyConsolidationRunId)
    .map((claim) => claim.claimId),
  ...residenceClaims
    .filter((claim) => claim.metadata.legacyConsolidationRunId)
    .flatMap((claim) => claim.metadata.sourceCandidateIds ?? []),
]);
const deleteControl = resumedEngine.ingestMemoryEvent({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  actor: "user",
  kind: "human_override",
  text: "彻底删除住所声明",
}, { enqueue: false });
assert.ok(deleteControl.receipt);
const deletedResidence = resumedLedger.applyClaimProposal(deleteControl.receipt.eventId, {
  subjectId: "user",
  predicate: "residence.current_city",
  value: null,
  canonicalText: "删除用户住所声明",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "human_override",
  confidence: 1,
  action: "delete",
  targetClaimId: currentResidence.claimId,
});
assert.equal(
  deletedResidence.deletedClaimIds?.length,
  reorganizedResidenceClaimIds.size,
  "deleting a reorganized chain must also remove extraction candidates with synonymous predicates",
);
assert.ok(
  [...reorganizedResidenceClaimIds].every((claimId) => !resumedLedger.getClaim(claimId)),
);
assert.equal(
  resumedLedger.listEvents().filter((event) => event.kind === "legacy_import").length,
  3,
  "deleting reorganized claims must not delete the immutable legacy evidence ledger",
);
await verifyMigrationInvariant("final output revalidation", async () => {
  const deletedOutputGate = getLegacyRejudgementGate(resumedEngine);
  assert.equal(
    deletedOutputGate.passed,
    false,
    "the final gate must revalidate output claim existence",
  );
  assert.match(deletedOutputGate.blockers.join("; "), /output claim.*missing/i);
});
assert.equal(resumedLedger.integrityCheck().ok, true);
resumedLedger.close();

async function runExtractionFailureCase(name, modelResult, engineOptions = {}) {
  const database = path.join(fixtureRoot, `${name}.sqlite`);
  const caseLedger = new AsukaMemoryLedger(database);
  const caseEngine = new AsukaMemoryEngine(caseLedger, {
    maxJobAttempts: 1,
    ...engineOptions,
    model: {
      async complete(request) {
        assert.equal(request.task, "legacy_extract");
        return typeof modelResult === "function" ? modelResult(request) : modelResult;
      },
    },
  });
  migrateLegacyRecords(caseEngine, [
    legacyRecord(`${name}-event`, "需要裁决的旧信息", 10_000),
  ], scope);
  const result = await executeLegacyRejudgements(caseEngine, { retryDelayMs: 0 });
  assert.equal(result.failed, 1, `${name} must fail extraction`);
  assert.equal(result.gateAfter.passed, false);
  assert.equal(result.gateAfter.jobs.failed, 1);
  assert.equal(result.gateAfter.extractions.completed, 0);
  caseLedger.close();
}

await runExtractionFailureCase(
  "empty-without-disposition",
  JSON.stringify({ proposals: [] }),
);
await runExtractionFailureCase(
  "invalid-proposal",
  JSON.stringify({
    proposals: [{
      subjectId: "user",
      canonicalText: "缺少 predicate",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      confidence: 0.9,
    }],
  }),
);
await runExtractionFailureCase(
  "invalid-validity-interval",
  JSON.stringify({
    proposals: [{
      subjectId: "user",
      predicate: "dynamic.interval",
      value: true,
      canonicalText: "结束时间早于开始时间",
      topLevelType: "event",
      epistemicStatus: "explicit",
      sourceKind: "statement",
      confidence: 0.9,
      validFrom: "2026-07-28T00:00:00.000Z",
      validTo: "2026-07-27T00:00:00.000Z",
    }],
  }),
);
await runExtractionFailureCase(
  "proposal-overflow",
  JSON.stringify({
    proposals: Array.from({ length: 13 }, (_, index) => ({
      subjectId: "user",
      predicate: `dynamic.${index}`,
      value: index,
      canonicalText: `动态声明 ${index}`,
      topLevelType: "fact",
      epistemicStatus: "explicit",
      sourceKind: "statement",
      confidence: 0.9,
    })),
  }),
  { legacyExtractionMaxProposals: 12 },
);

const emptyDatabase = path.join(fixtureRoot, "valid-empty.sqlite");
const emptyLedger = new AsukaMemoryLedger(emptyDatabase);
const emptyEngine = new AsukaMemoryEngine(emptyLedger, {
  model: {
    async complete(request) {
      assert.equal(request.task, "legacy_extract");
      return JSON.stringify({
        proposals: [],
        noMemoryReason: "这只是没有长期价值的寒暄",
      });
    },
  },
});
migrateLegacyRecords(emptyEngine, [
  legacyRecord("valid-empty", "你好", 20_000),
], scope);
const validEmpty = await executeLegacyRejudgements(emptyEngine, { retryDelayMs: 0 });
assert.equal(validEmpty.gateAfter.passed, true, validEmpty.gateAfter.blockers.join("; "));
assert.equal(validEmpty.gateAfter.extractions.noMemory, 1);
assert.equal(validEmpty.gateAfter.consolidation.status, "not_required");
emptyLedger.close();

await verifyMigrationInvariant("audited all-discard consolidation", async () => {
  const allDiscardDatabase = path.join(fixtureRoot, "all-discard.sqlite");
  const allDiscardLedger = new AsukaMemoryLedger(allDiscardDatabase);
  const allDiscardEngine = new AsukaMemoryEngine(allDiscardLedger, {
    legacyConsolidationMaxClaimsPerBatch: 2,
    model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        return JSON.stringify({
          proposals: [{
            subjectId: "user",
            predicate: "transient.noise",
            value: true,
            canonicalText: "误提取的瞬时噪声",
            topLevelType: "working_memory",
            epistemicStatus: "inferred",
            sourceKind: "inference",
            confidence: 0.3,
          }],
        });
      }
      const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
      return JSON.stringify({
        claims: [],
        discarded: [{
          sourceItemIds: items.map((item) => item.itemId),
          reason: "全局复核确认只是瞬时噪声，不具备长期记忆价值",
        }],
      });
    },
  },
  });
  try {
    migrateLegacyRecords(allDiscardEngine, [
      legacyRecord("all-discard-1", "嗯嗯，刚才随口说的甲", 25_000),
      legacyRecord("all-discard-2", "嗯嗯，刚才随口说的乙", 26_000),
      legacyRecord("all-discard-3", "嗯嗯，刚才随口说的丙", 27_000),
    ], scope);
    const allDiscard = await executeLegacyRejudgements(allDiscardEngine, { retryDelayMs: 0 });
    assert.equal(allDiscard.gateAfter.passed, true, allDiscard.gateAfter.blockers.join("; "));
    assert.equal(allDiscard.gateAfter.consolidation.status, "completed");
    assert.equal(allDiscard.gateAfter.consolidation.outputClaims, 0);
    const allDiscardRun = allDiscardLedger.listLegacyConsolidationRuns()[0];
    assert.equal(allDiscardRun.coveredCandidateCount, allDiscardRun.inputCandidateCount);
    assert.ok(Array.isArray(allDiscardRun.audit.discarded));
    assert.ok(
      allDiscardRun.audit.discarded.every((item) =>
        item.reason === "全局复核确认只是瞬时噪声，不具备长期记忆价值"
      ),
      "every discarded group must retain a concrete audit reason",
    );
    assert.deepEqual(
      allDiscardRun.audit.discarded
        .flatMap((item) => item.sourceCandidateIds)
        .sort(),
      [...allDiscardRun.discardedCandidateIds].sort(),
      "an all-discard result must retain exact audited coverage",
    );
    assert.equal(
      allDiscardLedger.listClaims({ states: ["candidate"] })
        .filter((claim) =>
          claim.metadata.migrationPendingRejudge === true
          || claim.metadata.migrationPendingConsolidation === true
        ).length,
      0,
    );
  } finally {
    allDiscardLedger.close();
  }
});

await verifyMigrationInvariant("bounded intermediate evidence excerpts", async () => {
  const evidenceBudgetDatabase = path.join(fixtureRoot, "evidence-budget.sqlite");
  const evidenceBudgetLedger = new AsukaMemoryLedger(evidenceBudgetDatabase);
  let sawIntermediateEvidence = false;
  const evidenceBudgetEngine = new AsukaMemoryEngine(evidenceBudgetLedger, {
  legacyConsolidationMaxClaimsPerBatch: 2,
  legacyConsolidationMaxInputChars: 8_000,
  model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        const { event } = promptPayload(request.prompt, "LEGACY_EXTRACTION_INPUT");
        return JSON.stringify({
          proposals: [{
            subjectId: "user",
            predicate: "dynamic.evidence",
            value: event.text,
            canonicalText: event.text,
            topLevelType: "fact",
            epistemicStatus: "explicit",
            sourceKind: "statement",
            confidence: 0.99,
          }],
        });
      }
      assert.ok(
        request.prompt.length <= 8_000,
        `consolidation prompt exceeded its configured input budget: ${request.prompt.length}`,
      );
      const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
      if (items.some((item) => item.itemId.startsWith("legacy-consolidated-"))) {
        sawIntermediateEvidence = true;
        assert.ok(
          items.every((item) =>
            item.evidence.length > 0
            && item.evidence.every((evidence) =>
              typeof evidence.text === "string" && evidence.text.length > 0
            )
          ),
          "intermediate consolidation must preserve bounded source excerpts",
        );
      }
      return JSON.stringify({
        claims: [{
          semanticKey: "user.dynamic.evidence",
          sourceItemIds: items.map((item) => item.itemId),
          subjectId: "user",
          predicate: "dynamic.evidence",
          value: "归并证据",
          canonicalText: "用户提供了多条需要归并的证据",
          topLevelType: "fact",
          epistemicStatus: "explicit",
          confidence: 0.99,
        }],
        discarded: [],
      });
    },
  },
  });
  try {
    migrateLegacyRecords(evidenceBudgetEngine, [
      legacyRecord("evidence-budget-1", "证据片段甲：保留这段原话", 31_000),
      legacyRecord("evidence-budget-2", "证据片段乙：保留这段原话", 32_000),
      legacyRecord("evidence-budget-3", "证据片段丙：保留这段原话", 33_000),
      legacyRecord("evidence-budget-4", "证据片段丁：保留这段原话", 34_000),
    ], scope);
    const evidenceBudgetResult = await executeLegacyRejudgements(
      evidenceBudgetEngine,
      { retryDelayMs: 0 },
    );
    assert.equal(
      evidenceBudgetResult.gateAfter.passed,
      true,
      evidenceBudgetResult.gateAfter.blockers.join("; "),
    );
    assert.equal(sawIntermediateEvidence, true);
  } finally {
    evidenceBudgetLedger.close();
  }
});

await verifyMigrationInvariant("large consolidation fan-in remains bounded and traceable", async () => {
  const fanInDatabase = path.join(fixtureRoot, "large-fan-in.sqlite");
  const fanInLedger = new AsukaMemoryLedger(fanInDatabase);
  let maximumPromptLength = 0;
  const fanInEngine = new AsukaMemoryEngine(fanInLedger, {
    legacyConsolidationMaxClaimsPerBatch: 8,
    legacyConsolidationMaxInputChars: 8_000,
    model: {
      async complete(request) {
        if (request.task === "legacy_extract") {
          const { event } = promptPayload(request.prompt, "LEGACY_EXTRACTION_INPUT");
          return JSON.stringify({
            proposals: [{
              subjectId: "user",
              predicate: "dynamic.large_fan_in",
              value: event.text,
              canonicalText: event.text,
              topLevelType: "fact",
              epistemicStatus: "explicit",
              sourceKind: "statement",
              confidence: 0.99,
            }],
          });
        }
        maximumPromptLength = Math.max(maximumPromptLength, request.prompt.length);
        assert.ok(request.prompt.length <= 8_000);
        const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
        return JSON.stringify({
          claims: [{
            semanticKey: "user.dynamic.large_fan_in",
            sourceItemIds: items.map((item) => item.itemId),
            subjectId: "user",
            predicate: "dynamic.large_fan_in",
            value: "完整归并",
            canonicalText: "用户提供了一组需要完整归并的长期事实",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            confidence: 0.99,
          }],
          discarded: [],
        });
      },
    },
  });
  try {
    migrateLegacyRecords(
      fanInEngine,
      Array.from({ length: 128 }, (_, index) =>
        legacyRecord(
          `large-fan-in-${index}`,
          `长期事实片段 ${String(index).padStart(3, "0")}`,
          100_000 + index,
        )
      ),
      scope,
    );
    const result = await executeLegacyRejudgements(fanInEngine, {
      batchSize: 128,
      retryDelayMs: 0,
    });
    assert.equal(result.gateAfter.passed, true, result.gateAfter.blockers.join("; "));
    assert.ok(maximumPromptLength <= 8_000);
    const output = fanInLedger.listClaims()
      .find((claim) => claim.metadata.legacyConsolidationRunId);
    assert.ok(output);
    assert.equal(
      fanInLedger.listClaimEvidence(output.claimId, "supports").length,
      128,
      "prompt compaction must not discard engine-side provenance",
    );
  } finally {
    fanInLedger.close();
  }
});

await verifyMigrationInvariant("invalidated extraction candidates cannot be resurrected", async () => {
  const invalidatedDatabase = path.join(fixtureRoot, "invalidated-candidate.sqlite");
  const invalidatedLedger = new AsukaMemoryLedger(invalidatedDatabase);
  const invalidatedEngine = new AsukaMemoryEngine(invalidatedLedger, {
    model: {
      async complete(request) {
        if (request.task === "legacy_extract") {
          return JSON.stringify({
            proposals: [{
              subjectId: "user",
              predicate: "dynamic.invalidated",
              value: true,
              canonicalText: "这条候选随后被用户否定",
              topLevelType: "fact",
              epistemicStatus: "explicit",
              sourceKind: "statement",
              confidence: 0.99,
            }],
          });
        }
        const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
        return JSON.stringify({
          claims: [{
            semanticKey: "user.dynamic.invalidated",
            sourceItemIds: items.map((item) => item.itemId),
            subjectId: "user",
            predicate: "dynamic.invalidated",
            value: true,
            canonicalText: "这条候选随后被用户否定",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            confidence: 0.99,
          }],
          discarded: [],
        });
      },
    },
  });
  try {
    migrateLegacyRecords(invalidatedEngine, [
      legacyRecord("invalidated-candidate", "这条候选随后被用户否定", 120_000),
    ], scope);
    const extractionBatch = await invalidatedEngine.processPendingMemoryJobs({
      maxJobs: 10,
      kinds: ["legacy_rejudge"],
      retryDelayMs: 0,
    });
    assert.equal(extractionBatch.failed, 0);
    const extraction = invalidatedLedger.listLegacyExtractions()[0];
    const candidate = invalidatedLedger.getClaim(extraction.candidateClaimIds[0]);
    const override = invalidatedLedger.appendEvent({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      actor: "user",
      kind: "human_override",
      text: "这条旧记忆不是真的",
      sourceMessageId: "invalidated-candidate-override",
      occurredAt: 130_000,
    });
    invalidatedLedger.applyClaimProposal(override.eventId, {
      semanticKey: candidate.semanticKey,
      subjectId: candidate.subjectId,
      predicate: candidate.predicate,
      value: false,
      canonicalText: "用户明确否定了这条旧记忆",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "human_override",
      confidence: 1,
      action: "refute",
      targetClaimId: candidate.claimId,
    });
    assert.equal(invalidatedLedger.getClaim(candidate.claimId).state, "superseded");
    await invalidatedEngine.consolidateLegacyExtractions();
    const gate = getLegacyRejudgementGate(invalidatedEngine);
    assert.equal(gate.passed, false);
    assert.match(gate.blockers.join("; "), /candidate|state|invalid/i);
    assert.equal(
      invalidatedLedger.listClaims({ states: ["active"] })
        .filter((claim) => claim.metadata.legacyConsolidationRunId).length,
      0,
    );
  } finally {
    invalidatedLedger.close();
  }
});

await verifyMigrationInvariant("legacy consolidation joins an existing semantic chain", async () => {
  const joinedDatabase = path.join(fixtureRoot, "joined-semantic-chain.sqlite");
  const joinedLedger = new AsukaMemoryLedger(joinedDatabase);
  const liveEvent = joinedLedger.appendEvent({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    actor: "user",
    kind: "user_message",
    text: "我现在住在苏州",
    sourceMessageId: "joined-live-claim",
    occurredAt: 200_000,
  });
  const liveClaim = joinedLedger.applyClaimProposal(liveEvent.eventId, {
    semanticKey: "user.residence.current",
    subjectId: "user",
    predicate: "residence.current_city",
    value: "苏州",
    canonicalText: "用户目前住在苏州",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 1,
    validFrom: 200_000,
  });
  const joinedEngine = new AsukaMemoryEngine(joinedLedger, {
    model: {
      async complete(request) {
        if (request.task === "legacy_extract") {
          return JSON.stringify({
            proposals: [{
              subjectId: "person:user",
              predicate: "home.city",
              value: "杭州",
              canonicalText: "用户曾住在杭州",
              topLevelType: "fact",
              epistemicStatus: "explicit",
              sourceKind: "statement",
              confidence: 1,
              validFrom: "1970-01-01T00:00:10.000Z",
            }],
          });
        }
        const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
        return JSON.stringify({
          claims: [{
            semanticKey: "user.residence.current",
            sourceItemIds: items.map((item) => item.itemId),
            subjectId: "user",
            predicate: "residence.current_city",
            value: "杭州",
            canonicalText: "用户曾住在杭州",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            confidence: 1,
            validFrom: "1970-01-01T00:00:10.000Z",
          }],
          discarded: [],
        });
      },
    },
  });
  try {
    migrateLegacyRecords(joinedEngine, [
      legacyRecord("joined-legacy-claim", "我以前住在杭州", 10_000),
    ], scope);
    const result = await executeLegacyRejudgements(joinedEngine, { retryDelayMs: 0 });
    assert.equal(result.gateAfter.passed, true, result.gateAfter.blockers.join("; "));
    const chain = joinedLedger.listClaims()
      .filter((claim) =>
        claim.semanticKey === "user.residence.current"
        && claim.metadata.migrationPendingConsolidation !== true
      );
    assert.equal(new Set(chain.map((claim) => claim.rootClaimId)).size, 1);
    assert.deepEqual(
      chain.filter((claim) => claim.state === "active").map((claim) => claim.claimId),
      [liveClaim.claimId],
      "the newer live claim must remain the only effective active version",
    );
  } finally {
    joinedLedger.close();
  }
});

const assistantDatabase = path.join(fixtureRoot, "assistant-only.sqlite");
const assistantLedger = new AsukaMemoryLedger(assistantDatabase);
const assistantEngine = new AsukaMemoryEngine(assistantLedger, {
  model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        return JSON.stringify({
          proposals: [{
            subjectId: "user",
            predicate: "residence.current_city",
            value: "东京",
            canonicalText: "用户住在东京",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            sourceKind: "statement",
            confidence: 0.99,
          }],
        });
      }
      const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
      return JSON.stringify({
        claims: [{
          semanticKey: "user.residence.current_city",
          sourceItemIds: items.map((item) => item.itemId),
          subjectId: "user",
          predicate: "residence.current_city",
          value: "东京",
          canonicalText: "用户住在东京",
          topLevelType: "fact",
          epistemicStatus: "explicit",
          confidence: 0.99,
        }],
        discarded: [],
      });
    },
  },
});
migrateLegacyRecords(assistantEngine, [
  legacyRecord("assistant-only", "你住在东京，我记住了。", 30_000, "asuka"),
], scope);
const assistantResult = await executeLegacyRejudgements(assistantEngine, { retryDelayMs: 0 });
assert.equal(assistantResult.gateAfter.passed, true, assistantResult.gateAfter.blockers.join("; "));
const assistantClaim = assistantLedger.listClaims()
  .find((claim) =>
    claim.canonicalText === "用户住在东京"
    && claim.metadata.legacyConsolidationRunId
  );
assert.equal(assistantClaim?.authority, "summary");
assert.equal(assistantClaim?.epistemicStatus, "inferred");
assert.equal(assistantClaim?.state, "candidate");
assert.equal(
  assistantEngine.retrieveMemoryContextLocal({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    query: "东京住所",
  }).claimIds.length,
  0,
  "assistant-only evidence must not self-authorize a durable user fact",
);
assistantLedger.close();

const inferenceConflictDatabase = path.join(fixtureRoot, "inference-conflict.sqlite");
const inferenceConflictLedger = new AsukaMemoryLedger(inferenceConflictDatabase);
const inferenceConflictEngine = new AsukaMemoryEngine(inferenceConflictLedger, {
  model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        const { event } = promptPayload(request.prompt, "LEGACY_EXTRACTION_INPUT");
        const explicit = event.text.includes("明确");
        return JSON.stringify({
          proposals: [{
            subjectId: "user",
            predicate: explicit ? "preference.explicit" : "preference.behavioral_pattern",
            value: explicit ? "morning" : "night",
            canonicalText: explicit ? "用户明确偏好早晨" : "从行为推断用户可能偏好夜晚",
            topLevelType: "belief",
            epistemicStatus: explicit ? "explicit" : "inferred",
            sourceKind: explicit ? "statement" : "behavior",
            confidence: 0.99,
          }],
        });
      }
      const { items } = promptPayload(request.prompt, "LEGACY_CONSOLIDATION_INPUT");
      const explicitItems = items.filter((item) => item.epistemicStatus === "explicit");
      const inferredItems = items.filter((item) => item.epistemicStatus === "inferred");
      return JSON.stringify({
        claims: [
          {
            semanticKey: "user.preference.daily_period",
            sourceItemIds: explicitItems.map((item) => item.itemId),
            subjectId: "user",
            predicate: "preference.daily_period",
            value: "morning",
            canonicalText: "用户明确偏好早晨",
            topLevelType: "belief",
            epistemicStatus: "explicit",
            confidence: 0.99,
          },
          {
            semanticKey: "user.preference.daily_period",
            sourceItemIds: inferredItems.map((item) => item.itemId),
            subjectId: "user",
            predicate: "preference.daily_period",
            value: "night",
            canonicalText: "从行为推断用户可能偏好夜晚",
            topLevelType: "belief",
            epistemicStatus: "explicit",
            confidence: 0.99,
          },
        ],
        discarded: [],
      });
    },
  },
});
migrateLegacyRecords(inferenceConflictEngine, [
  legacyRecord("explicit-preference", "我明确喜欢早晨", 50_000),
  legacyRecord("inferred-preference-1", "最近一次深夜活动", 60_000),
  legacyRecord("inferred-preference-2", "又一次深夜活动", 70_000),
], scope);
const inferenceConflictResult = await executeLegacyRejudgements(
  inferenceConflictEngine,
  { retryDelayMs: 0 },
);
assert.equal(
  inferenceConflictResult.gateAfter.passed,
  true,
  inferenceConflictResult.gateAfter.blockers.join("; "),
);
const preferenceVersions = inferenceConflictLedger.listClaims()
  .filter((claim) =>
    claim.metadata.legacyConsolidationRunId
    && claim.predicate === "preference.daily_period"
  );
const explicitPreference = preferenceVersions.find((claim) =>
  claim.epistemicStatus === "explicit"
);
const inferredPreference = preferenceVersions.find((claim) =>
  claim.epistemicStatus === "inferred"
);
assert.equal(explicitPreference?.state, "active");
assert.equal(inferredPreference?.state, "candidate");
assert.equal(explicitPreference?.rootClaimId, inferredPreference?.rootClaimId);
inferenceConflictLedger.close();

const coverageDatabase = path.join(fixtureRoot, "missing-coverage.sqlite");
const coverageLedger = new AsukaMemoryLedger(coverageDatabase);
const coverageEngine = new AsukaMemoryEngine(coverageLedger, {
  maxJobAttempts: 1,
  model: {
    async complete(request) {
      if (request.task === "legacy_extract") {
        return JSON.stringify({
          proposals: [{
            subjectId: "user",
            predicate: "dynamic.fact",
            value: true,
            canonicalText: "需要被覆盖的声明",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            sourceKind: "statement",
            confidence: 0.9,
          }],
        });
      }
      return JSON.stringify({ claims: [], discarded: [] });
    },
  },
});
migrateLegacyRecords(coverageEngine, [
  legacyRecord("missing-coverage", "必须覆盖", 40_000),
], scope);
const missingCoverage = await executeLegacyRejudgements(coverageEngine, { retryDelayMs: 0 });
assert.equal(missingCoverage.gateAfter.passed, false);
assert.equal(missingCoverage.gateAfter.consolidation.status, "failed");
assert.match(missingCoverage.gateAfter.blockers.join("; "), /coverage|non-empty/i);
coverageLedger.close();

assert.deepEqual(
  sourceAccountingRegressionFailures,
  [],
  `legacy source accounting regression failures:\n${sourceAccountingRegressionFailures.join("\n")}`,
);
assert.deepEqual(
  migrationInvariantFailures,
  [],
  `memory migration integrity invariant failures:\n${migrationInvariantFailures.join("\n")}`,
);

console.log("asuka-memory migration/wiki v15 tests passed");
