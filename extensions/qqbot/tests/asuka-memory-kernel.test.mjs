import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";
import { migrateLegacyRecords } from "../dist/src/asuka-memory-kernel/legacy-migration.js";
import {
  parseMemoryJudgement,
  parseReflectionResult,
} from "../dist/src/asuka-memory-kernel/model-tasks.js";

function eventInput(overrides = {}) {
  return {
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    actor: "user",
    kind: "user_message",
    text: "我晚上睡觉不安分",
    sourceMessageId: `message-${Math.random()}`,
    ...overrides,
  };
}

function legacyEventInput(content, overrides = {}) {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const sourceRecordId = overrides.sourceRecordId ?? `record-${Math.random()}`;
  return {
    input: eventInput({
      actor: "user",
      kind: "legacy_import",
      text: content,
      sourceId: `memory:${sourceRecordId}`,
      dedupeKey: `legacy:${sourceRecordId}`,
      metadata: {
        legacySourceKind: "memory",
        legacySourcePath: "/legacy/memory.json",
        legacySourceRecordId: sourceRecordId,
        legacyContentHash: contentHash,
        ...(overrides.metadata ?? {}),
      },
      ...overrides,
      metadata: {
        legacySourceKind: "memory",
        legacySourcePath: "/legacy/memory.json",
        legacySourceRecordId: sourceRecordId,
        legacyContentHash: contentHash,
        ...(overrides.metadata ?? {}),
      },
    }),
    source: { content, contentHash },
  };
}

function applyFixtureProposal(ledger, eventId, proposal) {
  const action = proposal.action ?? "add";
  const decided = (
    (action === "add" || action === "revise")
    && proposal.disposition === undefined
  )
    ? {
        ...proposal,
        disposition: "active",
        rationale: proposal.rationale ?? "Fixture model selected active",
      }
    : proposal;
  return ledger.applyClaimProposal(eventId, decided);
}

function scheduleReflectionFixture(
  ledger,
  sourceEventId,
  targetClaimIds,
  options = {},
) {
  const source = ledger.getEvent(sourceEventId);
  assert.ok(source, `reflection fixture source is missing: ${sourceEventId}`);
  const occurredAt = options.occurredAt ?? Date.now();
  return ledger.scheduleReflectionBatch({
    accountId: source.accountId,
    peerKind: source.peerKind,
    peerId: source.peerId,
    identityId: source.identityId,
    visibility: source.visibility,
    actor: "system",
    kind: "reflection",
    text: `Reflect ${targetClaimIds.length} fixture claim(s)`,
    occurredAt,
    sourceId: `reflection:fixture:${sourceEventId}`,
    dedupeKey: `reflection:fixture:${sourceEventId}:${[...targetClaimIds].sort().join(",")}:${occurredAt}`,
    metadata: {
      trigger: options.trigger ?? "event",
      triggerEventId: sourceEventId,
      contextEventIds: options.contextEventIds ?? [sourceEventId],
      targetClaimIds,
    },
  }, options.availableAt ?? occurredAt);
}

const ledger = new AsukaMemoryLedger(":memory:");
const first = ledger.appendEvent(eventInput({ sourceMessageId: "sleep-1" }));
const duplicate = ledger.appendEvent(eventInput({ sourceMessageId: "sleep-1" }));
assert.equal(first.inserted, true);
assert.equal(duplicate.inserted, false, "source message id must make event append idempotent");

const explicit = applyFixtureProposal(ledger, first.eventId, {
  subjectId: "user",
  predicate: "sleep.behavior",
  value: { description: "晚上睡觉不安分" },
  canonicalText: "用户晚上睡觉不安分",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 0.98,
  supportingEventIds: [first.eventId],
  topic: "动态睡眠状态",
});
assert.equal(explicit.state, "active");

const inferenceEvent = ledger.appendEvent(eventInput({
  actor: "asuka",
  kind: "proactive_message",
  text: "我感觉你也许很怕冷",
  sourceMessageId: "proactive-1",
}));
const lowerAuthority = applyFixtureProposal(ledger, inferenceEvent.eventId, {
  subjectId: "user",
  predicate: "sleep.behavior",
  value: "睡觉很安稳",
  canonicalText: "用户睡觉可能很安稳",
  topLevelType: "belief",
  epistemicStatus: "inferred",
  authority: "inferred",
  confidence: 0.9,
  supportingEventIds: [inferenceEvent.eventId],
});
assert.equal(lowerAuthority.state, "candidate", "assistant inference must not replace an explicit fact");
assert.equal(ledger.getClaim(explicit.claimId).state, "active");

const assistantExplicit = applyFixtureProposal(ledger, inferenceEvent.eventId, {
  subjectId: "asuka",
  predicate: "self.preference.weather",
  value: "喜欢雨天",
  canonicalText: "Asuka 喜欢雨天",
  topLevelType: "self_narrative",
  epistemicStatus: "explicit",
  authority: "summary",
  confidence: 0.99,
  supportingEventIds: [inferenceEvent.eventId],
});
assert.equal(
  assistantExplicit.state,
  "candidate",
  "a single assistant or proactive statement must not self-authorize a durable fact",
);

const userEvidence2 = ledger.appendEvent(eventInput({
  text: "冬天我总要比别人多穿一件",
  sourceMessageId: "cold-2",
}));
const userEvidence3 = ledger.appendEvent(eventInput({
  text: "空调太低我就会冷",
  sourceMessageId: "cold-3",
}));
const inferredActive = applyFixtureProposal(ledger, userEvidence3.eventId, {
  subjectId: "user",
  predicate: "temperature.sensitivity",
  value: "怕冷",
  canonicalText: "用户可能比较怕冷",
  topLevelType: "belief",
  epistemicStatus: "inferred",
  authority: "inferred",
  confidence: 0.86,
  disposition: "active",
  rationale: "两次独立用户陈述共同支持该模式",
  supportingEventIds: [userEvidence2.eventId, userEvidence3.eventId],
});
assert.equal(inferredActive.state, "active");
const beforeSelfRepeat = ledger.getClaim(inferredActive.claimId);

const selfRepeat = ledger.appendEvent(eventInput({
  actor: "asuka",
  kind: "assistant_reply",
  text: "我记得你好像比较怕冷",
  sourceMessageId: "self-repeat",
  generatedFromClaimIds: [inferredActive.rootClaimId],
}));
applyFixtureProposal(ledger, selfRepeat.eventId, {
  subjectId: "user",
  predicate: "temperature.sensitivity",
  value: "怕冷",
  canonicalText: "用户可能比较怕冷",
  topLevelType: "belief",
  epistemicStatus: "inferred",
  authority: "inferred",
  confidence: 0.9,
  supportingEventIds: [selfRepeat.eventId],
});
const afterSelfRepeat = ledger.getClaim(inferredActive.claimId);
assert.equal(
  afterSelfRepeat.supportingEvidenceCount,
  beforeSelfRepeat.supportingEvidenceCount,
  "Asuka recalling a claim must not become independent evidence for it",
);

assert.equal(ledger.upsertEmbedding(explicit.claimId, "fixture-embedding", [1, 0, 0]), true);
const hybrid = ledger.searchLocal({
  identityId: first.identityId,
  visibility: "private",
  query: "睡眠动作",
  vector: [1, 0, 0],
  embeddingModel: "fixture-embedding",
});
assert.equal(hybrid[0].claim.claimId, explicit.claimId, "vector retrieval should recover a semantic candidate");

const modelSwitchLedger = new AsukaMemoryLedger(":memory:");
const modelSwitchEvent = modelSwitchLedger.appendEvent(eventInput({
  text: "我喜欢在窗边读书",
  sourceMessageId: "embedding-model-switch",
}));
const modelSwitchClaim = applyFixtureProposal(modelSwitchLedger, modelSwitchEvent.eventId, {
  subjectId: "user",
  predicate: "preference.reading.place",
  value: "窗边",
  canonicalText: "用户喜欢在窗边读书",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 0.98,
  supportingEventIds: [modelSwitchEvent.eventId],
});
assert.equal(
  modelSwitchLedger.upsertEmbedding(modelSwitchClaim.claimId, "embedding-a", [1, 0, 0]),
  true,
);
assert.equal(
  modelSwitchLedger.upsertEmbedding(modelSwitchClaim.claimId, "embedding-b", [0, 1, 0]),
  true,
);
const staleModelCandidate = modelSwitchLedger.searchLocal({
  identityId: modelSwitchEvent.identityId,
  visibility: "private",
  query: "完全无关的查询",
  vector: [0, 1, 0],
  embeddingModel: "embedding-a",
}).find((candidate) => candidate.claim.claimId === modelSwitchClaim.claimId);
assert.equal(
  staleModelCandidate?.vectorScore ?? 0,
  0,
  "switching embedding models must invalidate the old model metadata",
);
const currentModelCandidate = modelSwitchLedger.searchLocal({
  identityId: modelSwitchEvent.identityId,
  visibility: "private",
  query: "完全无关的查询",
  vector: [0, 1, 0],
  embeddingModel: "embedding-b",
}).find((candidate) => candidate.claim.claimId === modelSwitchClaim.claimId);
assert.ok(
  (currentModelCandidate?.vectorScore ?? 0) > 0.99,
  "the current embedding model must retain its physical vector mapping",
);
assert.deepEqual(
  modelSwitchLedger.searchLocal({
    identityId: modelSwitchEvent.identityId,
    visibility: "private",
    query: "quantum engine maintenance",
  }),
  [],
  "ordinary semantic retrieval must not inject unrelated recent claims",
);
modelSwitchLedger.close();

const vectorOnlyLedger = new AsukaMemoryLedger(":memory:");
const vectorOnlyTargetEvent = vectorOnlyLedger.appendEvent(eventInput({
  text: "我偏爱雨后石板路的气味",
  sourceMessageId: "vector-only-target",
}));
const vectorOnlyTarget = applyFixtureProposal(vectorOnlyLedger, vectorOnlyTargetEvent.eventId, {
  subjectId: "user",
  predicate: "preference.sensory",
  value: "雨后石板路的气味",
  canonicalText: "用户偏爱雨后石板路的气味",
  topLevelType: "fact",
  epistemicStatus: "explicit",
  authority: "user_explicit",
  confidence: 0.98,
  supportingEventIds: [vectorOnlyTargetEvent.eventId],
});
await wait(2);
for (let index = 0; index < 10; index += 1) {
  const fillerEvent = vectorOnlyLedger.appendEvent(eventInput({
    text: `无关近况 ${index}`,
    sourceMessageId: `vector-only-filler-${index}`,
  }));
  applyFixtureProposal(vectorOnlyLedger, fillerEvent.eventId, {
    subjectId: "user",
    predicate: `recent.filler.${index}`,
    value: index,
    canonicalText: `用户的无关近况 ${index}`,
    topLevelType: "event",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 0.9,
    supportingEventIds: [fillerEvent.eventId],
  });
}
assert.equal(
  vectorOnlyLedger.upsertEmbedding(vectorOnlyTarget.claimId, "fixture-embedding", [0, 1, 0]),
  true,
);
const withoutVector = vectorOnlyLedger.searchLocal({
  identityId: vectorOnlyTargetEvent.identityId,
  visibility: "private",
  query: "海风偏好",
  limit: 8,
});
assert.equal(
  withoutVector.find((candidate) =>
    candidate.claim.claimId === vectorOnlyTarget.claimId
  )?.exactLexicalMatch,
  false,
  "generic lexical overlap may form a rerank candidate but is not an exact fallback match",
);
assert.ok(
  !new AsukaMemoryEngine(vectorOnlyLedger).retrieveMemoryContextLocal({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    query: "海风偏好",
    maxCandidates: 8,
  }).claimIds.includes(vectorOnlyTarget.claimId),
  "generic lexical overlap must not enter the prompt without model selection",
);
const withVector = vectorOnlyLedger.searchLocal({
  identityId: vectorOnlyTargetEvent.identityId,
  visibility: "private",
  query: "海风偏好",
  vector: [0, 1, 0],
  embeddingModel: "fixture-embedding",
  limit: 8,
});
assert.equal(
  withVector[0].claim.claimId,
  vectorOnlyTarget.claimId,
  "a vector-only semantic match must be independently retrievable",
);
vectorOnlyLedger.close();

const noModelEngine = new AsukaMemoryEngine(ledger);
const queued = noModelEngine.ingestMemoryEvent(eventInput({
  text: "这是模型离线时的新信息",
  sourceMessageId: "offline-1",
}));
const offlineBatch = await noModelEngine.processPendingMemoryJobs();
assert.equal(queued.receipt.inserted, true);
assert.equal(offlineBatch.processed, 0);
assert.ok(offlineBatch.remaining > 0, "events must remain queued while the model is unavailable");

const secretResult = noModelEngine.ingestMemoryEvent(eventInput({
  text: "验证码是 123456",
  sourceMessageId: "secret-1",
}));
assert.equal(secretResult.accepted, false);
assert.equal(secretResult.redacted, true);
assert.equal(
  ledger.getEvent(secretResult.receipt.eventId).text,
  "[secret-bearing content omitted]",
  "secret-bearing content must never be persisted verbatim",
);

assert.throws(
  () => noModelEngine.retrieveMemoryContextLocal({
    accountId: "default",
    peerKind: "group",
    peerId: "group-1",
    identityId: first.identityId,
    query: "睡觉",
  }),
  /requested identity does not match the current peer scope/i,
  "a group request must not accept a direct peer identity",
);
ledger.appendEvent(eventInput({
  peerId: "user-2",
  text: "这是另一个用户",
  sourceMessageId: "cross-direct-scope",
}));
assert.throws(
  () => noModelEngine.retrieveMemoryContextLocal({
    accountId: "default",
    peerKind: "direct",
    peerId: "user-2",
    identityId: first.identityId,
    query: "睡觉",
  }),
  /requested identity does not match the current peer scope/i,
  "one direct peer must not retrieve another direct peer's private identity",
);

let rerankDelayMs = 40;
const rerankModel = {
  async complete(request) {
    if (request.task === "rerank") {
      await wait(rerankDelayMs);
      const ids = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)].map((match) => match[1]);
      return JSON.stringify({ claimIds: ids.reverse() });
    }
    return JSON.stringify({ proposals: [], noMemoryReason: "fixture" });
  },
};
const rerankEngine = new AsukaMemoryEngine(ledger, {
  model: rerankModel,
  rerankDeadlineMs: 5,
  rerankTaskTimeoutMs: 1_000,
});
const fallback = await rerankEngine.retrieveMemoryContext({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  query: "我睡觉和怕冷的情况",
});
assert.equal(fallback.usedFallback, true, "foreground must use local ranking after the deadline");
assert.ok(fallback.elapsedMs < 100, "foreground fallback should not wait for the background reranker");
await wait(70);
const cached = rerankEngine.retrieveMemoryContextLocal({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  query: "我睡觉和怕冷的情况",
});
assert.equal(cached.usedFallback, false, "background rerank should populate the next-turn cache");

rerankDelayMs = 0;
const foreground = await rerankEngine.retrieveMemoryContext({
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  query: "睡眠情况",
});
assert.equal(foreground.usedFallback, false, "fast rerank should be used in the foreground");

const integrityInvariantFailures = [];
async function verifyIntegrityInvariant(name, run) {
  try {
    await run();
  } catch (error) {
    integrityInvariantFailures.push(
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await verifyIntegrityInvariant("adjudicated deletes refresh projections once", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-delete-callback-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  const deletionLedger = new AsukaMemoryLedger(databasePath);
  const projectionChanges = [];
  try {
    const firstEvent = deletionLedger.appendEvent(eventInput({
      text: "我喜欢清晨散步",
      sourceMessageId: "delete-callback-first",
    }));
    const firstApplied = applyFixtureProposal(deletionLedger, firstEvent.eventId, {
      semanticKey: "user.preference.morning_walk",
      subjectId: "user",
      predicate: "preference.morning_walk",
      value: true,
      canonicalText: "用户喜欢清晨散步",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const firstClaim = deletionLedger.getClaim(firstApplied.claimId);
    const secondEvent = deletionLedger.appendEvent(eventInput({
      text: "我喜欢夜间阅读",
      sourceMessageId: "delete-callback-second",
    }));
    const secondApplied = applyFixtureProposal(deletionLedger, secondEvent.eventId, {
      semanticKey: "user.preference.night_reading",
      subjectId: "user",
      predicate: "preference.night_reading",
      value: true,
      canonicalText: "用户喜欢夜间阅读",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const secondClaim = deletionLedger.getClaim(secondApplied.claimId);
    const deletionEngine = new AsukaMemoryEngine(deletionLedger, {
      onProjectionChanged: (identityId) => projectionChanges.push(identityId),
      model: {
        async complete(request) {
          assert.equal(request.task, "adjudicate");
          return JSON.stringify({
            proposals: [
              {
                semanticKey: firstClaim.semanticKey,
                subjectId: firstClaim.subjectId,
                predicate: firstClaim.predicate,
                value: null,
                canonicalText: "删除清晨散步偏好",
                topLevelType: "fact",
                epistemicStatus: "explicit",
                confidence: 1,
                action: "delete",
                targetClaimId: firstClaim.claimId,
              },
              {
                semanticKey: secondClaim.semanticKey,
                subjectId: secondClaim.subjectId,
                predicate: secondClaim.predicate,
                value: null,
                canonicalText: "删除夜间阅读偏好",
                topLevelType: "fact",
                epistemicStatus: "explicit",
                confidence: 1,
                action: "delete",
                targetClaimId: secondClaim.claimId,
              },
            ],
          });
        },
      },
    });
    const controlEvent = deletionEngine.ingestMemoryEvent(eventInput({
      kind: "memory_control",
      text: "删除这两条偏好",
      sourceMessageId: "delete-callback-control",
    }), { enqueue: false });
    await deletionEngine.adjudicateEvent(controlEvent.receipt.eventId);

    assert.equal(deletionLedger.getClaim(firstClaim.claimId), undefined);
    assert.equal(deletionLedger.getClaim(secondClaim.claimId), undefined);
    assert.deepEqual(projectionChanges, [controlEvent.receipt.identityId]);
  } finally {
    deletionLedger.close();
  }

  try {
    const database = new DatabaseSync(databasePath);
    const row = database.prepare(`
      SELECT result_summary
      FROM model_runs
      WHERE task = 'adjudicate' AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get();
    database.close();
    const summary = JSON.parse(row.result_summary);
    assert.deepEqual(summary.claimIds, []);
    assert.equal(summary.deletedClaimIds.length, 2);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("rerank may exclude local candidates", async () => {
  const subsetLedger = new AsukaMemoryLedger(":memory:");
  let rerankCalls = 0;
  try {
    const selectedEvent = subsetLedger.appendEvent(eventInput({
      text: "我喜欢清晨散步",
      sourceMessageId: "rerank-subset-selected",
    }));
    const selected = applyFixtureProposal(subsetLedger, selectedEvent.eventId, {
      semanticKey: "user.preference.morning_walk",
      subjectId: "user",
      predicate: "preference.morning_walk",
      value: true,
      canonicalText: "用户喜欢清晨散步",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const excludedEvent = subsetLedger.appendEvent(eventInput({
      text: "我常在周末整理书架",
      sourceMessageId: "rerank-subset-excluded",
    }));
    const excluded = applyFixtureProposal(subsetLedger, excludedEvent.eventId, {
      semanticKey: "user.habit.bookshelf",
      subjectId: "user",
      predicate: "habit.bookshelf",
      value: true,
      canonicalText: "用户常在周末整理书架",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const subsetEngine = new AsukaMemoryEngine(subsetLedger, {
      rerankDeadlineMs: 500,
      model: {
        async complete(request) {
          assert.equal(request.task, "rerank");
          rerankCalls += 1;
          return JSON.stringify({ claimIds: [selected.claimId], reason: "only relevant item" });
        },
      },
    });
    const request = {
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query: "清晨散步",
    };
    const result = await subsetEngine.retrieveMemoryContext(request);
    assert.equal(result.usedFallback, false);
    assert.deepEqual(result.claimIds, [selected.claimId]);
    assert.ok(!result.claimIds.includes(excluded.claimId));
    assert.doesNotMatch(result.prompt, /整理书架/);

    const cachedResult = subsetEngine.retrieveMemoryContextLocal(request);
    assert.equal(cachedResult.usedFallback, false);
    assert.deepEqual(cachedResult.claimIds, [selected.claimId]);
    assert.equal(rerankCalls, 1);
  } finally {
    subsetLedger.close();
  }
});

await verifyIntegrityInvariant("group recall shares the rerank deadline path", async () => {
  const groupLedger = new AsukaMemoryLedger(":memory:");
  let rerankCalls = 0;
  let sawPublicCandidate = false;
  try {
    const publicEvent = groupLedger.appendEvent(eventInput({
      peerKind: "group",
      peerId: "group-rerank",
      text: "群里约定周五晚上看电影",
      sourceMessageId: "group-rerank-source",
    }));
    const publicClaim = applyFixtureProposal(groupLedger, publicEvent.eventId, {
      semanticKey: "group.plan.friday_movie",
      subjectId: "group",
      predicate: "plan.friday_movie",
      value: true,
      canonicalText: "群里约定周五晚上看电影",
      topLevelType: "event",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const groupEngine = new AsukaMemoryEngine(groupLedger, {
      rerankDeadlineMs: 10,
      rerankTaskTimeoutMs: 1_000,
      model: {
        async complete(request) {
          assert.equal(request.task, "rerank");
          rerankCalls += 1;
          sawPublicCandidate = request.prompt.includes(publicClaim.claimId);
          await wait(40);
          return JSON.stringify({ claimIds: [], reason: "not relevant after rerank" });
        },
      },
    });
    const request = {
      accountId: "default",
      peerKind: "group",
      peerId: "group-rerank",
      query: "周五安排",
    };
    const fallbackResult = await groupEngine.retrieveMemoryContext(request);
    assert.equal(fallbackResult.usedFallback, true);
    assert.ok(
      !fallbackResult.claimIds.includes(publicClaim.claimId),
      "a generic lexical candidate must wait for model selection before entering the prompt",
    );
    assert.equal(
      sawPublicCandidate,
      true,
      "the public group candidate must reach the reranker before the deadline",
    );
    assert.equal(rerankCalls, 1, "group recall must invoke the same reranker as direct recall");

    await wait(60);
    const cachedResult = groupEngine.retrieveMemoryContextLocal(request);
    assert.equal(cachedResult.usedFallback, false);
    assert.deepEqual(cachedResult.claimIds, []);
  } finally {
    groupLedger.close();
  }
});

await verifyIntegrityInvariant("candidate and provisional claims never enter recall", async () => {
  const provisionalLedger = new AsukaMemoryLedger(":memory:");
  try {
    const assistantEvent = provisionalLedger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      text: "我猜用户也许喜欢午夜跑步",
      sourceMessageId: "candidate-recall-source",
    }));
    const candidate = provisionalLedger.applyClaimProposal(assistantEvent.eventId, {
      semanticKey: "user.preference.midnight_run",
      subjectId: "user",
      predicate: "preference.midnight_run",
      value: true,
      canonicalText: "用户也许喜欢午夜跑步",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.95,
    });
    assert.equal(candidate.state, "candidate");

    const migrationEvent = provisionalLedger.appendEvent(eventInput({
      text: "旧框架暂存的偏好",
      sourceMessageId: "provisional-recall-source",
    }));
    const provisional = provisionalLedger.applyClaimProposal(migrationEvent.eventId, {
      semanticKey: "user.preference.provisional",
      subjectId: "user",
      predicate: "preference.provisional",
      value: true,
      canonicalText: "用户可能有一条尚未重判的旧偏好",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "migration_untrusted",
      confidence: 0.99,
      metadata: { migrationPendingRejudge: true },
    });
    assert.equal(provisional.state, "candidate");

    const local = provisionalLedger.searchLocal({
      identityId: assistantEvent.identityId,
      visibility: "private",
      query: "午夜跑步 旧偏好",
    });
    assert.deepEqual(local, []);
    const result = new AsukaMemoryEngine(provisionalLedger).retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query: "午夜跑步 旧偏好",
    });
    assert.deepEqual(result.claimIds, []);
  } finally {
    provisionalLedger.close();
  }
});

await verifyIntegrityInvariant("forget/delete authority", async () => {
  const authorityLedger = new AsukaMemoryLedger(":memory:");
  try {
    const factEvent = authorityLedger.appendEvent(eventInput({
      text: "我明确住在苏州",
      sourceMessageId: "authority-fact",
    }));
    const fact = applyFixtureProposal(authorityLedger, factEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "苏州",
      canonicalText: "用户目前住在苏州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const inferredEvent = authorityLedger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      text: "也许应该忘掉这个",
      sourceMessageId: "authority-inferred-forget",
    }));
    const inferredForget = applyFixtureProposal(authorityLedger, inferredEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: null,
      canonicalText: "忘记用户当前住所",
      topLevelType: "fact",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.99,
      action: "forget",
      targetClaimId: fact.claimId,
    });
    assert.equal(inferredForget.ignoredReason, "forget_requires_user_control_authority");
    assert.equal(authorityLedger.getClaim(fact.claimId).state, "active");

    const inferredDelete = applyFixtureProposal(authorityLedger, inferredEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: null,
      canonicalText: "删除用户当前住所",
      topLevelType: "fact",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.99,
      action: "delete",
      targetClaimId: fact.claimId,
    });
    assert.equal(inferredDelete.ignoredReason, "delete_requires_user_control_authority");
    assert.ok(authorityLedger.getClaim(fact.claimId));

    const weakControlEvent = authorityLedger.appendEvent(eventInput({
      kind: "memory_control",
      text: "忘掉住所",
      sourceMessageId: "authority-weak-control",
    }));
    const weakControl = applyFixtureProposal(authorityLedger, weakControlEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: null,
      canonicalText: "忘记用户当前住所",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      action: "forget",
      targetClaimId: fact.claimId,
    });
    assert.equal(weakControl.ignoredReason, "forget_requires_user_control_authority");

    const controlEvent = authorityLedger.appendEvent(eventInput({
      kind: "memory_control",
      text: "忘掉住所",
      sourceMessageId: "authority-control",
    }));
    const authorized = applyFixtureProposal(authorityLedger, controlEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: null,
      canonicalText: "忘记用户当前住所",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_correction",
      confidence: 1,
      action: "forget",
      targetClaimId: fact.claimId,
    });
    assert.equal(authorized.state, "forgotten");
  } finally {
    authorityLedger.close();
  }
});

await verifyIntegrityInvariant("target and evidence scope", async () => {
  const scopeLedger = new AsukaMemoryLedger(":memory:");
  try {
    const privateEvent = scopeLedger.appendEvent(eventInput({
      text: "私人证据",
      sourceMessageId: "scope-private",
    }));
    const privateClaim = applyFixtureProposal(scopeLedger, privateEvent.eventId, {
      semanticKey: "user.private.fact",
      subjectId: "user",
      predicate: "private.fact",
      value: true,
      canonicalText: "用户有一条私人事实",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const publicEvent = scopeLedger.appendEvent(eventInput({
      peerKind: "group",
      peerId: "group-1",
      text: "群聊证据",
      sourceMessageId: "scope-public",
    }));
    const crossScopeTarget = applyFixtureProposal(scopeLedger, publicEvent.eventId, {
      semanticKey: "user.private.fact",
      subjectId: "user",
      predicate: "private.fact",
      value: null,
      canonicalText: "删除私人事实",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "human_override",
      confidence: 1,
      action: "delete",
      targetClaimId: privateClaim.claimId,
    });
    assert.equal(crossScopeTarget.ignoredReason, "target_scope_mismatch");
    assert.ok(scopeLedger.getClaim(privateClaim.claimId));

    const missingEvidence = applyFixtureProposal(scopeLedger, privateEvent.eventId, {
      semanticKey: "user.missing.evidence",
      subjectId: "user",
      predicate: "missing.evidence",
      value: true,
      canonicalText: "缺少证据的声明",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      supportingEventIds: ["missing-event"],
    });
    assert.equal(missingEvidence.ignoredReason, "supporting_evidence_not_found");

    const crossScopeEvidence = applyFixtureProposal(scopeLedger, privateEvent.eventId, {
      semanticKey: "user.cross.scope.evidence",
      subjectId: "user",
      predicate: "cross.scope.evidence",
      value: true,
      canonicalText: "跨作用域证据的声明",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      opposingEventIds: [publicEvent.eventId],
    });
    assert.equal(crossScopeEvidence.ignoredReason, "opposing_evidence_scope_mismatch");
  } finally {
    scopeLedger.close();
  }
});

await verifyIntegrityInvariant("temporal FTS and vector recall", async () => {
  const temporalLedger = new AsukaMemoryLedger(":memory:");
  try {
    const futureEvent = temporalLedger.appendEvent(eventInput({
      text: "未来才生效的琥珀计划",
      sourceMessageId: "future-validity",
      occurredAt: 1_000,
    }));
    const futureClaim = applyFixtureProposal(temporalLedger, futureEvent.eventId, {
      semanticKey: "user.plan.amber",
      subjectId: "user",
      predicate: "plan.amber",
      value: "future",
      canonicalText: "用户的琥珀计划未来才生效",
      topLevelType: "event",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      validFrom: 10_000,
    });
    temporalLedger.upsertEmbedding(futureClaim.claimId, "fixture-embedding", [0, 0, 1]);
    const earlyFts = temporalLedger.searchLocal({
      identityId: futureEvent.identityId,
      visibility: "private",
      query: "琥珀计划",
      now: 5_000,
    });
    assert.ok(
      !earlyFts.some((candidate) => candidate.claim.claimId === futureClaim.claimId),
      "future claims must be excluded from FTS retrieval",
    );
    const earlyVector = temporalLedger.searchLocal({
      identityId: futureEvent.identityId,
      visibility: "private",
      query: "完全无关的查询",
      now: 5_000,
      vector: [0, 0, 1],
      embeddingModel: "fixture-embedding",
    });
    assert.ok(
      !earlyVector.some((candidate) => candidate.claim.claimId === futureClaim.claimId),
      "future claims must be excluded from vector retrieval",
    );
    const active = temporalLedger.searchLocal({
      identityId: futureEvent.identityId,
      visibility: "private",
      query: "琥珀计划",
      now: 15_000,
    });
    assert.ok(active.some((candidate) => candidate.claim.claimId === futureClaim.claimId));
  } finally {
    temporalLedger.close();
  }
});

await verifyIntegrityInvariant("LLM semantic version chain", async () => {
  const semanticLedger = new AsukaMemoryLedger(":memory:");
  let judgementIndex = 0;
  const semanticEngine = new AsukaMemoryEngine(semanticLedger, {
    model: {
      async complete(request) {
        assert.match(request.prompt, /semanticKey/);
        judgementIndex += 1;
        return JSON.stringify({
          proposals: [{
            semanticKey: "user.residence.current",
            subjectId: judgementIndex === 1 ? "user" : "person:user",
            predicate: judgementIndex === 1 ? "home.city" : "residence.current_city",
            value: judgementIndex === 1 ? "杭州" : "苏州",
            canonicalText: judgementIndex === 1 ? "用户曾住在杭州" : "用户目前住在苏州",
            topLevelType: "fact",
            epistemicStatus: "explicit",
            sourceKind: "statement",
            confidence: 1,
            disposition: "active",
            rationale: "The user stated this directly",
          }],
        });
      },
    },
  });
  try {
    const firstEvent = semanticEngine.ingestMemoryEvent(eventInput({
      text: "我以前住在杭州",
      sourceMessageId: "semantic-first",
    }), { enqueue: false });
    const secondEvent = semanticEngine.ingestMemoryEvent(eventInput({
      text: "我搬到苏州了",
      sourceMessageId: "semantic-second",
    }), { enqueue: false });
    const firstResult = await semanticEngine.adjudicateEvent(firstEvent.receipt.eventId);
    const secondResult = await semanticEngine.adjudicateEvent(secondEvent.receipt.eventId);
    const firstClaim = semanticLedger.getClaim(firstResult.claimIds[0]);
    const secondClaim = semanticLedger.getClaim(secondResult.claimIds[0]);
    assert.equal(firstClaim.semanticKey, "user.residence.current");
    assert.equal(secondClaim.semanticKey, firstClaim.semanticKey);
    assert.equal(
      secondClaim.rootClaimId,
      firstClaim.rootClaimId,
      "semanticKey must preserve one version chain across synonymous subject IDs",
    );
    assert.equal(firstClaim.state, "superseded");

    const correctionEvent = semanticLedger.appendEvent(eventInput({
      kind: "human_override",
      text: "其实现在住在南京",
      sourceMessageId: "semantic-correction",
    }));
    const corrected = semanticLedger.applyClaimProposal(correctionEvent.eventId, {
      semanticKey: "model.tried.to.change.the.key",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "南京",
      canonicalText: "用户目前住在南京",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "human_override",
      confidence: 1,
      action: "revise",
      targetClaimId: secondClaim.claimId,
    });
    assert.equal(semanticLedger.getClaim(corrected.claimId).semanticKey, firstClaim.semanticKey);
  } finally {
    semanticLedger.close();
  }
});

await verifyIntegrityInvariant("candidate-only semantic version chain", async () => {
  const candidateLedger = new AsukaMemoryLedger(":memory:");
  try {
    const firstEvent = candidateLedger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      text: "你可能偏爱安静的夜晚",
      sourceMessageId: "candidate-chain-first",
    }));
    const firstCandidate = applyFixtureProposal(candidateLedger, firstEvent.eventId, {
      semanticKey: "user.preference.quiet_period",
      subjectId: "user",
      predicate: "preference.quiet_period",
      value: "night",
      canonicalText: "用户可能偏爱安静的夜晚",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.8,
    });
    const secondEvent = candidateLedger.appendEvent(eventInput({
      actor: "asuka",
      kind: "proactive_message",
      text: "我又觉得你可能更喜欢夜深以后",
      sourceMessageId: "candidate-chain-second",
    }));
    const secondCandidate = applyFixtureProposal(candidateLedger, secondEvent.eventId, {
      semanticKey: "user.preference.quiet_period",
      subjectId: "person:user",
      predicate: "preference.late_quiet_time",
      value: "late_night",
      canonicalText: "用户可能偏爱深夜的安静时段",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.82,
    });
    assert.equal(firstCandidate.state, "candidate");
    assert.equal(secondCandidate.state, "candidate");
    assert.equal(
      candidateLedger.getClaim(secondCandidate.claimId).rootClaimId,
      candidateLedger.getClaim(firstCandidate.claimId).rootClaimId,
      "candidate-only revisions must remain on one deterministic semantic chain",
    );
  } finally {
    candidateLedger.close();
  }
});

await verifyIntegrityInvariant("future revision preserves current validity", async () => {
  const futureRevisionLedger = new AsukaMemoryLedger(":memory:");
  try {
    const currentEvent = futureRevisionLedger.appendEvent(eventInput({
      text: "我现在住在杭州",
      sourceMessageId: "future-revision-current",
      occurredAt: 1_000,
    }));
    const currentClaim = applyFixtureProposal(futureRevisionLedger, currentEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "杭州",
      canonicalText: "用户目前住在杭州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      validFrom: 1_000,
    });
    const futureEvent = futureRevisionLedger.appendEvent(eventInput({
      text: "下个月搬到苏州",
      sourceMessageId: "future-revision-next",
      occurredAt: 2_000,
    }));
    const futureClaim = applyFixtureProposal(futureRevisionLedger, futureEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "苏州",
      canonicalText: "用户将住在苏州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      validFrom: 10_000,
    });
    const beforeMove = futureRevisionLedger.searchLocal({
      identityId: currentEvent.identityId,
      visibility: "private",
      query: "住在哪里",
      now: 5_000,
    }).map((candidate) => candidate.claim.claimId);
    assert.ok(beforeMove.includes(currentClaim.claimId));
    assert.ok(!beforeMove.includes(futureClaim.claimId));
    const afterMove = futureRevisionLedger.searchLocal({
      identityId: currentEvent.identityId,
      visibility: "private",
      query: "住在哪里",
      now: 15_000,
    }).map((candidate) => candidate.claim.claimId);
    assert.ok(!afterMove.includes(currentClaim.claimId));
    assert.ok(afterMove.includes(futureClaim.claimId));
  } finally {
    futureRevisionLedger.close();
  }
});

await verifyIntegrityInvariant("foreground rerank revalidates deleted claims", async () => {
  const revalidationLedger = new AsukaMemoryLedger(":memory:");
  let signalRerankStarted;
  let releaseRerank;
  const rerankStarted = new Promise((resolve) => {
    signalRerankStarted = resolve;
  });
  const rerankRelease = new Promise((resolve) => {
    releaseRerank = resolve;
  });
  const revalidationEngine = new AsukaMemoryEngine(revalidationLedger, {
    rerankDeadlineMs: 1_000,
    model: {
      async complete(request) {
        if (request.task !== "rerank") {
          return JSON.stringify({ proposals: [], noMemoryReason: "fixture" });
        }
        const ids = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
          .map((match) => match[1]);
        signalRerankStarted();
        await rerankRelease;
        return JSON.stringify({ claimIds: ids });
      },
    },
  });
  try {
    const source = revalidationLedger.appendEvent(eventInput({
      text: "我喜欢雨后的石板路",
      sourceMessageId: "rerank-delete-source",
    }));
    const target = applyFixtureProposal(revalidationLedger, source.eventId, {
      semanticKey: "user.preference.rain_street",
      subjectId: "user",
      predicate: "preference.rain_street",
      value: true,
      canonicalText: "用户喜欢雨后的石板路",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const retrieval = revalidationEngine.retrieveMemoryContext({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query: "雨后石板路",
    });
    await rerankStarted;
    const deletionEvent = revalidationLedger.appendEvent(eventInput({
      kind: "memory_control",
      text: "删除这条偏好",
      sourceMessageId: "rerank-delete-control",
    }));
    const deletion = applyFixtureProposal(revalidationLedger, deletionEvent.eventId, {
      semanticKey: "user.preference.rain_street",
      subjectId: "user",
      predicate: "preference.rain_street",
      value: null,
      canonicalText: "删除用户的雨后石板路偏好",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_correction",
      confidence: 1,
      action: "delete",
      targetClaimId: target.claimId,
    });
    assert.equal(deletion.ignoredReason, undefined);
    assert.equal(revalidationLedger.getClaim(target.claimId), undefined);
    releaseRerank();
    const result = await retrieval;
    assert.ok(!result.claimIds.includes(target.claimId));
    assert.doesNotMatch(result.prompt, /雨后的石板路/);
  } finally {
    releaseRerank?.();
    revalidationLedger.close();
  }
});

for (const mode of ["failure", "timeout"]) {
  await verifyIntegrityInvariant(`${mode} fallback revalidates deleted claims`, async () => {
    const revalidationLedger = new AsukaMemoryLedger(":memory:");
    let signalRerankStarted;
    let releaseRerank;
    const rerankStarted = new Promise((resolve) => {
      signalRerankStarted = resolve;
    });
    const rerankRelease = new Promise((resolve) => {
      releaseRerank = resolve;
    });
    const query = `fallback-${mode}-query`;
    const revalidationEngine = new AsukaMemoryEngine(revalidationLedger, {
      rerankDeadlineMs: mode === "failure" ? 1_000 : 25,
      model: {
        async complete(request) {
          if (request.task !== "rerank") {
            return JSON.stringify({ proposals: [], noMemoryReason: "fixture" });
          }
          const ids = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
            .map((match) => match[1]);
          signalRerankStarted();
          await rerankRelease;
          if (mode === "failure") throw new Error("fixture rerank failure");
          return JSON.stringify({ claimIds: ids });
        },
      },
    });
    try {
      const source = revalidationLedger.appendEvent(eventInput({
        text: query,
        sourceMessageId: `fallback-${mode}-source`,
      }));
      const target = applyFixtureProposal(revalidationLedger, source.eventId, {
        semanticKey: `user.fixture.${mode}`,
        subjectId: "user",
        predicate: `fixture.${mode}`,
        value: true,
        canonicalText: query,
        topLevelType: "fact",
        epistemicStatus: "explicit",
        authority: "user_explicit",
        confidence: 1,
      });
      const retrieval = revalidationEngine.retrieveMemoryContext({
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
        query,
      });
      await rerankStarted;
      const deletionEvent = revalidationLedger.appendEvent(eventInput({
        kind: "memory_control",
        text: `删除 ${query}`,
        sourceMessageId: `fallback-${mode}-control`,
      }));
      const deletion = applyFixtureProposal(revalidationLedger, deletionEvent.eventId, {
        semanticKey: `user.fixture.${mode}`,
        subjectId: "user",
        predicate: `fixture.${mode}`,
        value: null,
        canonicalText: `删除 ${query}`,
        topLevelType: "fact",
        epistemicStatus: "explicit",
        authority: "user_correction",
        confidence: 1,
        action: "delete",
        targetClaimId: target.claimId,
      });
      assert.equal(deletion.ignoredReason, undefined);
      if (mode === "failure") releaseRerank();
      const result = await retrieval;

      if (mode === "timeout") {
        releaseRerank();
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (revalidationLedger.readRerankCache(source.identityId, query)) break;
          await wait(5);
        }
      }
      assert.ok(!result.claimIds.includes(target.claimId));
      assert.doesNotMatch(result.prompt, new RegExp(query));
    } finally {
      releaseRerank?.();
      revalidationLedger.close();
    }
  });
}

await verifyIntegrityInvariant("background rerank revalidates deleted claims", async () => {
  const revalidationLedger = new AsukaMemoryLedger(":memory:");
  let signalRerankStarted;
  let releaseRerank;
  const rerankStarted = new Promise((resolve) => {
    signalRerankStarted = resolve;
  });
  const rerankRelease = new Promise((resolve) => {
    releaseRerank = resolve;
  });
  const query = "雨后石板路";
  const revalidationEngine = new AsukaMemoryEngine(revalidationLedger, {
    rerankDeadlineMs: 10,
    model: {
      async complete(request) {
        if (request.task !== "rerank") {
          return JSON.stringify({ proposals: [], noMemoryReason: "fixture" });
        }
        const ids = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
          .map((match) => match[1]);
        signalRerankStarted();
        await rerankRelease;
        return JSON.stringify({ claimIds: ids });
      },
    },
  });
  try {
    const source = revalidationLedger.appendEvent(eventInput({
      text: "我喜欢雨后的石板路",
      sourceMessageId: "background-rerank-delete-source",
    }));
    const target = applyFixtureProposal(revalidationLedger, source.eventId, {
      semanticKey: "user.preference.rain_street",
      subjectId: "user",
      predicate: "preference.rain_street",
      value: true,
      canonicalText: "用户喜欢雨后的石板路",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const retrieval = revalidationEngine.retrieveMemoryContext({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
    });
    await rerankStarted;
    const fallback = await retrieval;
    assert.equal(fallback.usedFallback, true);

    const deletionEvent = revalidationLedger.appendEvent(eventInput({
      kind: "memory_control",
      text: "删除这条偏好",
      sourceMessageId: "background-rerank-delete-control",
    }));
    const deletion = applyFixtureProposal(revalidationLedger, deletionEvent.eventId, {
      semanticKey: "user.preference.rain_street",
      subjectId: "user",
      predicate: "preference.rain_street",
      value: null,
      canonicalText: "删除用户的雨后石板路偏好",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_correction",
      confidence: 1,
      action: "delete",
      targetClaimId: target.claimId,
    });
    assert.equal(deletion.ignoredReason, undefined);
    releaseRerank();

    let cache;
    for (let attempt = 0; attempt < 40 && !cache; attempt += 1) {
      await wait(5);
      cache = revalidationLedger.readRerankCache(source.identityId, query);
    }
    assert.ok(cache, "background rerank should populate the cache after its deadline");
    assert.ok(!cache.claimIds.includes(target.claimId));
  } finally {
    releaseRerank?.();
    revalidationLedger.close();
  }
});

await verifyIntegrityInvariant("rerank cache is bound to the current candidate snapshot and prompt budget", async () => {
  const cacheLedger = new AsukaMemoryLedger(":memory:");
  const query = "用户目前住在";
  const cacheEngine = new AsukaMemoryEngine(cacheLedger, {
    model: {
      async complete(request) {
        if (request.task !== "rerank") {
          return JSON.stringify({ proposals: [], noMemoryReason: "fixture" });
        }
        const claimIds = [...request.prompt.matchAll(/"claimId":"([^"]+)"/g)]
          .map((match) => match[1]);
        return JSON.stringify({ claimIds });
      },
    },
  });
  try {
    const hangzhouEvent = cacheLedger.appendEvent(eventInput({
      text: "我现在住在杭州",
      sourceMessageId: "rerank-cache-hangzhou",
    }));
    const hangzhou = applyFixtureProposal(cacheLedger, hangzhouEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "杭州",
      canonicalText: "用户目前住在杭州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const initial = await cacheEngine.retrieveMemoryContext({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
    });
    assert.equal(initial.usedFallback, false);
    assert.ok(initial.claimIds.includes(hangzhou.claimId));

    const budgetChanged = cacheEngine.retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
      maxPromptChars: 600,
    });
    assert.equal(
      budgetChanged.usedFallback,
      true,
      "a cache entry from a different prompt budget must not be reused",
    );

    const asOfChanged = cacheEngine.retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
      now: Date.now() + 1_000,
    });
    assert.equal(
      asOfChanged.usedFallback,
      true,
      "a cache entry from a different as-of time must not be reused",
    );
    assert.ok(asOfChanged.claimIds.includes(hangzhou.claimId));

    cacheLedger.linkIdentity({
      identityId: hangzhouEvent.identityId,
      accountId: "default",
      peerKind: "group",
      peerId: "group-1",
      visibility: "public",
    });
    const visibilityChanged = cacheEngine.retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "group",
      peerId: "group-1",
      query,
    });
    assert.equal(
      visibilityChanged.usedFallback,
      true,
      "a private cache entry must not be reused for public retrieval",
    );

    cacheLedger.writeRerankCache(
      hangzhouEvent.identityId,
      "expired rerank cache",
      [],
      undefined,
      -1,
    );
    assert.equal(
      cacheLedger.readRerankCache(
        hangzhouEvent.identityId,
        "expired rerank cache",
        0,
      ),
      undefined,
      "cache TTL must use wall-clock time rather than retrieval as-of time",
    );

    const shanghaiEvent = cacheLedger.appendEvent(eventInput({
      text: "我现在改住上海了",
      sourceMessageId: "rerank-cache-shanghai",
    }));
    const shanghai = applyFixtureProposal(cacheLedger, shanghaiEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "上海",
      canonicalText: "用户目前住在上海",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const revised = cacheEngine.retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
    });
    assert.equal(
      revised.usedFallback,
      true,
      "a changed candidate snapshot must invalidate the old rerank cache",
    );
    assert.ok(revised.claimIds.includes(shanghai.claimId));
    assert.ok(!revised.claimIds.includes(hangzhou.claimId));
  } finally {
    cacheLedger.close();
  }
});

await verifyIntegrityInvariant("inferred authority and activation require validated LLM intent", async () => {
  const policyLedger = new AsukaMemoryLedger(":memory:");
  try {
    const explicitEvent = policyLedger.appendEvent(eventInput({
      text: "我现在住在杭州",
      sourceMessageId: "policy-explicit-residence",
    }));
    const explicitResidence = applyFixtureProposal(policyLedger, explicitEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "杭州",
      canonicalText: "用户目前住在杭州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const supportingEvent = policyLedger.appendEvent(eventInput({
      text: "最近常提到上海",
      sourceMessageId: "policy-inferred-support",
    }));
    const inferenceEvent = policyLedger.appendEvent(eventInput({
      text: "也许已经搬去上海了",
      sourceMessageId: "policy-inferred-revision",
    }));
    const policyEngine = new AsukaMemoryEngine(policyLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "adjudicate");
          return JSON.stringify({
            proposals: [{
              semanticKey: explicitResidence.semanticKey,
              subjectId: "user",
              predicate: "residence.current_city",
              value: "上海",
              canonicalText: "推断用户目前住在上海",
              topLevelType: "belief",
              epistemicStatus: "inferred",
              sourceKind: "correction",
              confidence: 0.99,
              disposition: "active",
              rationale: "两条间接线索指向上海，但用户没有明确确认",
              action: "revise",
              targetClaimId: explicitResidence.claimId,
              supportingEventIds: [inferenceEvent.eventId],
              lifecycle: "bounded",
            }],
          });
        },
      },
    });
    const result = await policyEngine.adjudicateEvent(inferenceEvent.eventId);
    const inferredRevision = policyLedger.getClaim(result.claimIds[0]);
    assert.equal(inferredRevision.authority, "inferred");
    assert.equal(inferredRevision.state, "candidate");
    assert.equal(policyLedger.getClaim(explicitResidence.claimId).state, "active");

    const undecided = policyLedger.applyClaimProposal(inferenceEvent.eventId, {
      semanticKey: "user.preference.undecided",
      subjectId: "user",
      predicate: "preference.undecided",
      value: true,
      canonicalText: "用户可能偏爱临窗座位",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.99,
      supportingEventIds: [supportingEvent.eventId, inferenceEvent.eventId],
    });
    assert.equal(
      undecided.state,
      "candidate",
      "confidence and evidence counts must not substitute for an LLM disposition",
    );

    const llmActivated = applyFixtureProposal(policyLedger, inferenceEvent.eventId, {
      semanticKey: "user.preference.llm-decided",
      subjectId: "user",
      predicate: "preference.llm_decided",
      value: true,
      canonicalText: "用户可能偏爱靠窗座位",
      topLevelType: "belief",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.31,
      disposition: "active",
      rationale: "模型明确判断该推断可参与召回，并保留低置信度标记",
      supportingEventIds: [inferenceEvent.eventId],
    });
    assert.equal(
      llmActivated.state,
      "active",
      "validated disposition must replace fixed confidence/evidence promotion thresholds",
    );
    assert.equal(policyLedger.getClaim(llmActivated.claimId).confidence, 0.31);
  } finally {
    policyLedger.close();
  }
});

await verifyIntegrityInvariant("reflection jobs retain revise and expire non-stable claims", async () => {
  const reflectionLedger = new AsukaMemoryLedger(":memory:");
  try {
    const supportingEvent = reflectionLedger.appendEvent(eventInput({
      text: "最近的安排会不断变化",
      sourceMessageId: "reflection-support",
    }));
    const sourceEvent = reflectionLedger.appendEvent(eventInput({
      text: "这周的四个临时状态",
      sourceMessageId: "reflection-source",
    }));
    const makeClaim = (semanticKey, canonicalText) => {
      const applied = applyFixtureProposal(reflectionLedger, sourceEvent.eventId, {
        semanticKey,
        subjectId: "user",
        predicate: semanticKey,
        value: canonicalText,
        canonicalText,
        topLevelType: "working_memory",
        epistemicStatus: "inferred",
        authority: "inferred",
        confidence: 0.62,
        disposition: "active",
        rationale: "模型判定该临时状态当前可用",
        supportingEventIds: [supportingEvent.eventId, sourceEvent.eventId],
        lifecycle: "working",
      });
      return reflectionLedger.getClaim(applied.claimId);
    };
    const retained = makeClaim("user.working.retain", "用户这周可能在准备一次分享");
    const revised = makeClaim("user.working.revise", "用户这周可能在准备旧版提纲");
    const expired = makeClaim("user.working.expire", "用户这周可能还在等待旧回复");
    const refuted = makeClaim("user.working.refute", "用户这周可能还在执行旧安排");
    const reflectionEngine = new AsukaMemoryEngine(reflectionLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "reflect");
          return JSON.stringify({
            decisions: [
              {
                claimId: retained.claimId,
                action: "retain",
                disposition: "active",
                confidence: 0.58,
                rationale: "现有证据仍支持，暂时保留",
              },
              {
                claimId: revised.claimId,
                action: "revise",
                disposition: "active",
                confidence: 0.67,
                rationale: "同一证据显示提纲已经进入新版",
                revision: {
                  value: "新版提纲",
                  canonicalText: "用户这周可能在准备新版提纲",
                  lifecycle: "working",
                },
              },
              {
                claimId: expired.claimId,
                action: "expire",
                confidence: 0.2,
                rationale: "旧回复的等待窗口已经结束",
              },
              {
                claimId: refuted.claimId,
                action: "refute",
                confidence: 0.1,
                rationale: "现有证据已经否定旧安排",
              },
            ],
          });
        },
      },
    });
    scheduleReflectionFixture(
      reflectionLedger,
      sourceEvent.eventId,
      [retained, revised, expired, refuted].map((claim) => claim.claimId),
    );
    const batch = await reflectionEngine.processPendingMemoryJobs({ kinds: ["reflect"] });
    assert.equal(batch.completed, 1);
    assert.equal(reflectionLedger.getClaim(retained.claimId).state, "active");
    assert.match(
      JSON.stringify(reflectionLedger.getClaim(retained.claimId).metadata.reflection),
      /现有证据仍支持/,
    );
    assert.equal(reflectionLedger.getClaim(revised.claimId).state, "superseded");
    const revisedVersions = reflectionLedger.listClaims()
      .filter((claim) => claim.rootClaimId === revised.rootClaimId);
    const revisedActive = revisedVersions.find((claim) => claim.state === "active");
    assert.equal(revisedActive.canonicalText, "用户这周可能在准备新版提纲");
    assert.equal(revisedActive.confidence, 0.67);
    assert.ok(revisedActive.supportingEvidenceCount >= 2);
    assert.equal(reflectionLedger.getClaim(expired.claimId).state, "superseded");
    assert.ok(reflectionLedger.getClaim(expired.claimId).validTo !== undefined);
    assert.equal(reflectionLedger.getClaim(refuted.claimId).state, "refuted");
    assert.ok(
      !new AsukaMemoryEngine(reflectionLedger).retrieveMemoryContextLocal({
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
        query: "旧安排",
      }).claimIds.includes(refuted.claimId),
      "a claim refuted by reflection must not remain recallable",
    );
  } finally {
    reflectionLedger.close();
  }
});

await verifyIntegrityInvariant("reflection evidence respects the reflection as-of boundary", async () => {
  const reflectionLedger = new AsukaMemoryLedger(":memory:");
  try {
    const before = reflectionLedger.appendEvent(eventInput({
      text: "BEFORE_BOUNDARY",
      occurredAt: 1_999,
      sourceMessageId: "reflection-before-boundary",
    }));
    const equal = reflectionLedger.appendEvent(eventInput({
      text: "EQUAL_BOUNDARY",
      occurredAt: 2_000,
      sourceMessageId: "reflection-equal-boundary",
    }));
    const future = reflectionLedger.appendEvent(eventInput({
      text: "FUTURE_BOUNDARY",
      occurredAt: 2_001,
      sourceMessageId: "reflection-future-boundary",
    }));
    const applied = applyFixtureProposal(reflectionLedger, equal.eventId, {
      semanticKey: "user.working.as_of",
      subjectId: "user",
      predicate: "working.as_of",
      value: "fixture",
      canonicalText: "用户有一条需要按时间反思的临时状态",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "边界前后的证据用于测试",
      supportingEventIds: [before.eventId, equal.eventId, future.eventId],
      lifecycle: "working",
    });
    const reflection = reflectionLedger.appendEvent(eventInput({
      actor: "system",
      kind: "reflection",
      text: "Reflect one claim at the fixed boundary",
      occurredAt: 2_000,
      sourceMessageId: "reflection-as-of-event",
      metadata: {
        targetClaimIds: [applied.claimId],
        contextEventIds: [before.eventId, equal.eventId, future.eventId],
      },
    }));
    let prompt = "";
    const engine = new AsukaMemoryEngine(reflectionLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "reflect");
          prompt = request.prompt;
          return JSON.stringify({
            decisions: [{
              claimId: applied.claimId,
              action: "retain",
              disposition: "active",
              confidence: 0.6,
              rationale: "边界时点已有证据仍然支持",
            }],
          });
        },
      },
    });
    const processingNow = Date.now();
    reflectionLedger.enqueueJob(reflection.eventId, "reflect", processingNow);
    const batch = await engine.processPendingMemoryJobs({
      kinds: ["reflect"],
      now: processingNow,
    });
    assert.equal(batch.completed, 1);
    assert.match(prompt, /BEFORE_BOUNDARY/);
    assert.match(prompt, /EQUAL_BOUNDARY/);
    assert.doesNotMatch(prompt, /FUTURE_BOUNDARY/);
  } finally {
    reflectionLedger.close();
  }
});

await verifyIntegrityInvariant("terminal source-event reflection failure quarantines affected claims", async () => {
  const failureLedger = new AsukaMemoryLedger(":memory:");
  try {
    let recoverReflection = false;
    const source = failureLedger.appendEvent(eventInput({
      text: "我这周可能在准备一次分享",
      sourceMessageId: "reflection-terminal-source",
    }));
    const applied = applyFixtureProposal(failureLedger, source.eventId, {
      semanticKey: "user.working.terminal_failure",
      subjectId: "user",
      predicate: "working.terminal_failure",
      value: "准备分享",
      canonicalText: "用户这周可能在准备一次分享",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "当前用户消息提供了直接证据",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const engine = new AsukaMemoryEngine(failureLedger, {
      maxJobAttempts: 2,
      model: {
        async complete(request) {
          assert.equal(request.task, "reflect");
          if (recoverReflection) {
            return JSON.stringify({
              decisions: [{
                claimId: applied.claimId,
                action: "retain",
                disposition: "active",
                confidence: 0.6,
                rationale: "The retry confirmed that the user evidence still supports the claim",
              }],
            });
          }
          throw new Error("fixture terminal reflection failure");
        },
      },
    });
    const processingNow = Date.now();
    const terminalJob = scheduleReflectionFixture(
      failureLedger,
      source.eventId,
      [applied.claimId],
      { occurredAt: processingNow, availableAt: processingNow },
    ).job;
    const firstAttempt = await engine.processPendingMemoryJobs({
      kinds: ["reflect"],
      maxJobs: 1,
      now: processingNow,
      retryDelayMs: 0,
    });
    assert.equal(firstAttempt.failed, 1);
    assert.equal(failureLedger.getClaim(applied.claimId).state, "active");

    const terminalAttempt = await engine.processPendingMemoryJobs({
      kinds: ["reflect"],
      maxJobs: 1,
      now: processingNow,
      retryDelayMs: 0,
    });
    assert.equal(terminalAttempt.failed, 1);
    const quarantined = failureLedger.getClaim(applied.claimId);
    assert.equal(
      quarantined.state,
      "candidate",
      "infrastructure failure must not masquerade as semantic refutation",
    );
    assert.match(
      JSON.stringify(quarantined.metadata.reflectionTerminalFailure),
      /fixture terminal reflection failure/,
    );
    assert.ok(
      !engine.retrieveMemoryContextLocal({
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
        query: "准备分享",
      }).claimIds.includes(applied.claimId),
      "a terminally failed reflection claim must be removed from recall",
    );
    assert.equal(
      engine.enqueueDueReflections(processingNow + 86_400_000),
      0,
      "terminally quarantined claims must not be scheduled periodically",
    );
    const relatedEvent = failureLedger.appendEvent(eventInput({
      text: "另一条同主题的临时线索",
      sourceMessageId: "reflection-terminal-related",
    }));
    const related = applyFixtureProposal(failureLedger, relatedEvent.eventId, {
      semanticKey: "user.working.terminal_failure",
      subjectId: "user",
      predicate: "working.terminal_failure",
      value: "另一条临时线索",
      canonicalText: "用户可能还有另一条临时线索",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.4,
      disposition: "candidate",
      rationale: "线索不足，保持候选",
      supportingEventIds: [relatedEvent.eventId],
      lifecycle: "working",
    });
    const reflectionEventCount = failureLedger.listEvents()
      .filter((event) => event.kind === "reflection").length;
    engine.enqueueEventTriggeredReflection(
      failureLedger.getEvent(relatedEvent.eventId),
      [quarantined],
      [related.claimId],
    );
    assert.equal(
      failureLedger.listEvents().filter((event) => event.kind === "reflection").length,
      reflectionEventCount,
      "related events must not reschedule a terminally quarantined claim",
    );
    assert.throws(
      () => failureLedger.retryFailedJobs("reflect", processingNow),
      /retryTerminalReflectionJob/,
      "bulk retry must not bypass operator authorization for terminal reflection",
    );

    recoverReflection = true;
    assert.equal(
      failureLedger.retryTerminalReflectionJob(
        terminalJob.jobId,
        processingNow,
        processingNow,
      ),
      true,
    );
    const recovered = await engine.processPendingMemoryJobs({
      kinds: ["reflect"],
      maxJobs: 1,
      now: processingNow,
      retryDelayMs: 0,
    });
    assert.equal(recovered.completed, 1);
    const restored = failureLedger.getClaim(applied.claimId);
    assert.equal(restored.state, "active");
    assert.equal(restored.metadata.reflectionTerminalFailure, undefined);
  } finally {
    failureLedger.close();
  }
});

await verifyIntegrityInvariant("terminal reflection failure and quarantine commit atomically", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-reflection-atomic-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const setupLedger = new AsukaMemoryLedger(databasePath);
    const source = setupLedger.appendEvent(eventInput({
      text: "我这周可能在准备一次分享",
      sourceMessageId: "reflection-atomic-source",
    }));
    const applied = applyFixtureProposal(setupLedger, source.eventId, {
      semanticKey: "user.working.atomic_failure",
      subjectId: "user",
      predicate: "working.atomic_failure",
      value: "准备分享",
      canonicalText: "用户这周可能在准备一次分享",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "当前用户消息提供了直接证据",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const processingNow = Date.now();
    scheduleReflectionFixture(
      setupLedger,
      source.eventId,
      [applied.claimId],
      { occurredAt: processingNow, availableAt: processingNow },
    );
    setupLedger.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_reflection_quarantine
      BEFORE UPDATE OF state ON memory_claims
      WHEN OLD.claim_id = '${applied.claimId}' AND NEW.state = 'candidate'
      BEGIN
        SELECT RAISE(ABORT, 'fixture rejects reflection quarantine');
      END;
    `);
    database.close();

    const atomicLedger = new AsukaMemoryLedger(databasePath);
    try {
      const engine = new AsukaMemoryEngine(atomicLedger, {
        maxJobAttempts: 1,
        model: {
          async complete(request) {
            assert.equal(request.task, "reflect");
            throw new Error("fixture terminal reflection model failure");
          },
        },
      });
      await assert.rejects(
        engine.processPendingMemoryJobs({
          kinds: ["reflect"],
          maxJobs: 1,
          now: processingNow,
          retryDelayMs: 0,
        }),
        /fixture rejects reflection quarantine/,
      );
      assert.equal(atomicLedger.getClaim(applied.claimId).state, "active");
      assert.equal(
        atomicLedger.listJobs()[0].status,
        "running",
        "the terminal job transition must roll back when quarantine cannot commit",
      );
    } finally {
      atomicLedger.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("reflection jobs are scheduled by periodic and related event triggers", async () => {
  const scheduledLedger = new AsukaMemoryLedger(":memory:");
  try {
    const reflectionNow = Date.now() + 2_000;
    const source = scheduledLedger.appendEvent(eventInput({
      text: "我这周可能在准备一次分享",
      sourceMessageId: "scheduled-reflection-source",
      occurredAt: reflectionNow - 2_000,
    }));
    const active = applyFixtureProposal(scheduledLedger, source.eventId, {
      semanticKey: "user.working.weekly_share",
      subjectId: "user",
      predicate: "working.weekly_share",
      value: "准备分享",
      canonicalText: "用户这周可能在准备一次分享",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.55,
      disposition: "active",
      rationale: "用户当前消息提供了直接上下文",
      lifecycle: "working",
    });
    const scheduledEngine = new AsukaMemoryEngine(scheduledLedger, {
      autoReflection: true,
      reflectionIntervalMs: 1_000,
      reflectionEventDelayMs: 0,
      model: {
        async complete(request) {
          if (request.task === "adjudicate") {
            const eventLine = request.prompt.match(/当前事件：(\{[^\n]+\})/);
            const event = eventLine ? JSON.parse(eventLine[1]) : {};
            return JSON.stringify({
              proposals: [{
                semanticKey: "user.working.weekly_share",
                subjectId: "user",
                predicate: "working.weekly_share",
                value: "也许仍在准备分享",
                canonicalText: "用户也许仍在准备这周的分享",
                topLevelType: "working_memory",
                epistemicStatus: "inferred",
                sourceKind: "inference",
                confidence: 0.45,
                disposition: "candidate",
                rationale: "新消息只提供了不确定的延续线索",
                supportingEventIds: [event.eventId],
                lifecycle: "working",
              }],
            });
          }
          assert.equal(request.task, "reflect");
          const inputLine = request.prompt.split("\n")
            .find((line) => line.startsWith("输入："));
          const reflectionInputs = inputLine
            ? JSON.parse(inputLine.slice("输入：".length))
            : [];
          const claimIds = [...new Set(
            reflectionInputs.map((item) => item.claim.claimId),
          )];
          return JSON.stringify({
            decisions: claimIds.map((claimId) => ({
              claimId,
              action: "retain",
              disposition: "active",
              confidence: 0.5,
              rationale: "当前证据仍支持保留该临时状态",
            })),
          });
        },
      },
    });
    assert.equal(
      scheduledEngine.enqueueDueReflections(reflectionNow),
      1,
      "one due periodic reflection must be enqueued",
    );
    const periodic = await scheduledEngine.processPendingMemoryJobs({
      kinds: ["reflect"],
      now: reflectionNow,
    });
    assert.equal(
      periodic.failed,
      0,
      `the due periodic reflection failed: ${JSON.stringify(scheduledLedger.listJobs())}`,
    );
    assert.equal(periodic.completed, 1, "the due periodic reflection must complete");
    assert.equal(scheduledLedger.getClaim(active.claimId).state, "active");

    const followup = scheduledEngine.ingestMemoryEvent(eventInput({
      text: "这周的分享大概还要继续准备",
      sourceMessageId: "scheduled-reflection-followup",
    }), { enqueue: false });
    await scheduledEngine.adjudicateEvent(followup.receipt.eventId);
    assert.ok(
      scheduledLedger.listJobs("pending").some((job) => job.kind === "reflect"),
      "a semantically related event must enqueue reflection for the existing non-stable claim",
    );
    const eventTriggered = await scheduledEngine.processPendingMemoryJobs({
      kinds: ["reflect"],
    });
    assert.equal(eventTriggered.completed, 1, "the event-triggered reflection must complete");
  } finally {
    scheduledLedger.close();
  }
});

await verifyIntegrityInvariant("reflection event and job scheduling is atomic and repairs old orphans", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-reflection-schedule-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    let fixtureLedger = new AsukaMemoryLedger(databasePath);
    const sourceReceipt = fixtureLedger.appendEvent(eventInput({
      text: "reflection scheduling source",
      sourceMessageId: "reflection-schedule-source",
      occurredAt: 1_000,
    }));
    const source = fixtureLedger.getEvent(sourceReceipt.eventId);
    fixtureLedger.close();
    const reflectionInput = {
      accountId: source.accountId,
      peerKind: source.peerKind,
      peerId: source.peerId,
      identityId: source.identityId,
      visibility: source.visibility,
      actor: "system",
      kind: "reflection",
      text: "Reflect one atomic fixture claim",
      occurredAt: 2_000,
      sourceId: `reflection:fixture:${source.eventId}`,
      dedupeKey: `reflection:atomic-schedule:${source.eventId}`,
      metadata: {
        trigger: "event",
        triggerEventId: source.eventId,
        contextEventIds: [source.eventId],
        targetClaimIds: ["fixture-claim"],
      },
    };

    let raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TRIGGER reject_reflection_job_insert
      BEFORE INSERT ON memory_jobs
      WHEN NEW.kind = 'reflect'
      BEGIN
        SELECT RAISE(ABORT, 'fixture rejects reflection job insert');
      END;
    `);
    raw.close();
    fixtureLedger = new AsukaMemoryLedger(databasePath);
    assert.throws(
      () => fixtureLedger.scheduleReflectionBatch(reflectionInput, 2_000),
      /fixture rejects reflection job insert/,
    );
    assert.equal(
      fixtureLedger.listEvents().filter((event) => event.kind === "reflection").length,
      0,
      "the event must roll back when job creation fails",
    );
    assert.equal(fixtureLedger.listJobs().length, 0);
    fixtureLedger.close();

    raw = new DatabaseSync(databasePath);
    raw.exec("DROP TRIGGER reject_reflection_job_insert");
    raw.close();
    fixtureLedger = new AsukaMemoryLedger(databasePath);
    const scheduled = fixtureLedger.scheduleReflectionBatch(reflectionInput, 2_000);
    fixtureLedger.close();

    raw = new DatabaseSync(databasePath);
    raw.prepare("DELETE FROM memory_jobs WHERE job_id = ?").run(scheduled.job.jobId);
    raw.close();
    fixtureLedger = new AsukaMemoryLedger(databasePath);
    const repaired = fixtureLedger.scheduleReflectionBatch(reflectionInput, 2_000);
    assert.equal(repaired.event.eventId, scheduled.event.eventId);
    assert.equal(repaired.job.status, "pending");
    assert.equal(
      fixtureLedger.listEvents().filter((event) => event.kind === "reflection").length,
      1,
      "dedupe repair must not duplicate the reflection event",
    );
    fixtureLedger.close();
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("an expired final reflection lease quarantines only in a reflection sweep", async () => {
  const leaseLedger = new AsukaMemoryLedger(":memory:");
  try {
    const source = leaseLedger.appendEvent(eventInput({
      text: "final reflection lease source",
      sourceMessageId: "final-reflection-lease-source",
      occurredAt: 1,
    }));
    const applied = applyFixtureProposal(leaseLedger, source.eventId, {
      semanticKey: "user.working.final_reflection_lease",
      subjectId: "user",
      predicate: "working.final_reflection_lease",
      value: "temporary",
      canonicalText: "用户有一条等待反思的临时状态",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "fixture",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const scheduled = scheduleReflectionFixture(
      leaseLedger,
      source.eventId,
      [applied.claimId],
      { occurredAt: 1, availableAt: 1 },
    );
    const crashed = leaseLedger.claimNextJob({
      kinds: ["reflect"],
      now: 1,
      leaseMs: 10,
      maxAttempts: 1,
    });
    assert.equal(crashed.jobId, scheduled.job.jobId);
    assert.equal(
      leaseLedger.claimNextJob({
        kinds: ["embed"],
        now: 11,
        maxAttempts: 1,
      }),
      undefined,
    );
    assert.equal(leaseLedger.listJobs()[0].status, "running");
    assert.equal(leaseLedger.getClaim(applied.claimId).state, "active");

    assert.equal(
      leaseLedger.claimNextJob({
        kinds: ["reflect"],
        now: 11,
        maxAttempts: 1,
      }),
      undefined,
    );
    assert.equal(leaseLedger.listJobs()[0].status, "failed");
    const quarantined = leaseLedger.getClaim(applied.claimId);
    assert.equal(quarantined.state, "candidate");
    assert.match(
      JSON.stringify(quarantined.metadata.reflectionTerminalFailure),
      /lease expired at the attempt limit/,
    );
    assert.ok(
      !new AsukaMemoryEngine(leaseLedger).retrieveMemoryContextLocal({
        accountId: "default",
        peerKind: "direct",
        peerId: "user-1",
        query: "临时状态",
      }).claimIds.includes(applied.claimId),
    );
  } finally {
    leaseLedger.close();
  }
});

await verifyIntegrityInvariant("reflection commit rolls back decisions audit and completion together", async () => {
  const scenarios = [
    "after_first_decision",
    "during_revision_insert",
    "during_audit_insert",
    "before_job_completion",
  ];
  for (const scenario of scenarios) {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `asuka-reflection-${scenario}-`));
    const databasePath = path.join(fixtureRoot, "ledger.sqlite");
    try {
      const atomicLedger = new AsukaMemoryLedger(databasePath);
      const source = atomicLedger.appendEvent(eventInput({
        text: `reflection atomic ${scenario}`,
        sourceMessageId: `reflection-atomic-${scenario}`,
      }));
      const first = applyFixtureProposal(atomicLedger, source.eventId, {
        semanticKey: `user.working.${scenario}.first`,
        subjectId: "user",
        predicate: `working.${scenario}.first`,
        value: "first",
        canonicalText: "第一条临时状态",
        topLevelType: "working_memory",
        epistemicStatus: "inferred",
        authority: "inferred",
        confidence: 0.6,
        disposition: "active",
        rationale: "fixture",
        supportingEventIds: [source.eventId],
        lifecycle: "working",
      });
      const second = scenario === "after_first_decision"
        ? applyFixtureProposal(atomicLedger, source.eventId, {
            semanticKey: `user.working.${scenario}.second`,
            subjectId: "user",
            predicate: `working.${scenario}.second`,
            value: "second",
            canonicalText: "第二条临时状态",
            topLevelType: "working_memory",
            epistemicStatus: "inferred",
            authority: "inferred",
            confidence: 0.6,
            disposition: "active",
            rationale: "fixture",
            supportingEventIds: [source.eventId],
            lifecycle: "working",
          })
        : undefined;
      const targetIds = second ? [first.claimId, second.claimId] : [first.claimId];
      const now = Date.now();
      const scheduled = scheduleReflectionFixture(
        atomicLedger,
        source.eventId,
        targetIds,
        { occurredAt: now, availableAt: now },
      );
      const claimed = atomicLedger.claimNextJob({
        kinds: ["reflect"],
        now,
        leaseMs: 60_000,
      });
      const raw = new DatabaseSync(databasePath);
      if (scenario === "after_first_decision") {
        raw.exec(`
          CREATE TRIGGER inject_reflection_failure
          BEFORE UPDATE ON memory_claims
          WHEN OLD.claim_id = '${second.claimId}'
          BEGIN SELECT RAISE(ABORT, 'fixture after first decision'); END;
        `);
      } else if (scenario === "during_revision_insert") {
        raw.exec(`
          CREATE TRIGGER inject_reflection_failure
          BEFORE INSERT ON memory_claims
          WHEN NEW.source_event_id = '${scheduled.event.eventId}'
          BEGIN SELECT RAISE(ABORT, 'fixture during revision insert'); END;
        `);
      } else if (scenario === "during_audit_insert") {
        raw.exec(`
          CREATE TRIGGER inject_reflection_failure
          BEFORE INSERT ON model_runs
          WHEN NEW.task = 'reflect' AND NEW.status = 'completed'
          BEGIN SELECT RAISE(ABORT, 'fixture during audit insert'); END;
        `);
      } else {
        raw.exec(`
          CREATE TRIGGER inject_reflection_failure
          BEFORE UPDATE ON memory_jobs
          WHEN OLD.job_id = '${scheduled.job.jobId}' AND NEW.status = 'completed'
          BEGIN SELECT RAISE(ABORT, 'fixture before job completion'); END;
        `);
      }
      raw.close();
      const decisions = second
        ? [
            {
              claimId: first.claimId,
              action: "retain",
              disposition: "active",
              confidence: 0.6,
              rationale: "retain first",
            },
            {
              claimId: second.claimId,
              action: "expire",
              confidence: 0.2,
              rationale: "expire second",
            },
          ]
        : [{
            claimId: first.claimId,
            action: "revise",
            disposition: "active",
            confidence: 0.7,
            rationale: "revise fixture",
            revision: {
              value: "revised",
              canonicalText: "修订后的临时状态",
              lifecycle: "working",
            },
          }];
      assert.throws(
        () => atomicLedger.commitReflection({
          eventId: scheduled.event.eventId,
          decisions,
          jobLease: {
            jobId: claimed.jobId,
            leaseToken: claimed.leaseToken,
          },
          modelRun: {
            promptVersion: 1,
            elapsedMs: 1,
            resultSummary: "fixture",
          },
        }),
        /fixture/,
      );
      assert.equal(atomicLedger.getClaim(first.claimId).state, "active");
      assert.equal(atomicLedger.getClaim(first.claimId).metadata.reflection, undefined);
      if (second) assert.equal(atomicLedger.getClaim(second.claimId).state, "active");
      assert.equal(
        atomicLedger.listClaims().filter((claim) =>
          claim.sourceEventId === scheduled.event.eventId
        ).length,
        0,
        "a failed revision must not leave a new claim",
      );
      const job = atomicLedger.listJobs().find((candidate) =>
        candidate.jobId === claimed.jobId
      );
      assert.equal(job.status, "running");
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(
        inspection.prepare(`
          SELECT COUNT(*) AS count
          FROM model_runs
          WHERE input_event_id = ? AND status = 'completed'
        `).get(scheduled.event.eventId).count,
        0,
      );
      inspection.close();
      atomicLedger.close();
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});

await verifyIntegrityInvariant("a reclaimed reflection lease fences the stale model response", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-reflection-fencing-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const setup = new AsukaMemoryLedger(databasePath);
    const source = setup.appendEvent(eventInput({
      text: "stale reflection worker source",
      sourceMessageId: "stale-reflection-worker-source",
    }));
    const applied = applyFixtureProposal(setup, source.eventId, {
      semanticKey: "user.working.stale_reflection_worker",
      subjectId: "user",
      predicate: "working.stale_reflection_worker",
      value: "temporary",
      canonicalText: "用户有一条并发反思状态",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "fixture",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const now = Date.now();
    scheduleReflectionFixture(
      setup,
      source.eventId,
      [applied.claimId],
      { occurredAt: now, availableAt: now },
    );
    setup.close();

    let markStarted;
    let releaseStale;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const staleGate = new Promise((resolve) => {
      releaseStale = resolve;
    });
    const staleLedger = new AsukaMemoryLedger(databasePath);
    const winnerLedger = new AsukaMemoryLedger(databasePath);
    const decision = (rationale) => JSON.stringify({
      decisions: [{
        claimId: applied.claimId,
        action: "retain",
        disposition: "active",
        confidence: 0.6,
        rationale,
      }],
    });
    const staleEngine = new AsukaMemoryEngine(staleLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "reflect");
          markStarted();
          await staleGate;
          return decision("stale worker must be fenced");
        },
      },
    });
    const winnerEngine = new AsukaMemoryEngine(winnerLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "reflect");
          return decision("reclaimed worker won");
        },
      },
    });
    const staleRun = staleEngine.processPendingMemoryJobs({
      kinds: ["reflect"],
      maxJobs: 1,
      now,
      leaseMs: 10,
    });
    await started;
    const winnerRun = await winnerEngine.processPendingMemoryJobs({
      kinds: ["reflect"],
      maxJobs: 1,
      now: now + 11,
      leaseMs: 60_000,
    });
    assert.equal(winnerRun.completed, 1);
    releaseStale();
    const staleResult = await staleRun;
    assert.equal(staleResult.completed, 0);
    assert.equal(staleResult.failed, 0);

    const finalClaim = winnerLedger.getClaim(applied.claimId);
    assert.equal(finalClaim.metadata.reflectionHistory.length, 1);
    assert.equal(
      finalClaim.metadata.reflectionHistory[0].rationale,
      "reclaimed worker won",
    );
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const runs = inspection.prepare(`
      SELECT status, result_summary
      FROM model_runs
      WHERE task = 'reflect'
      ORDER BY created_at
    `).all();
    assert.equal(runs.length, 1, "the stale worker must not write an audit row");
    assert.equal(runs[0].status, "completed");
    assert.match(runs[0].result_summary, /reclaimed worker won/);
    inspection.close();
    staleLedger.close();
    winnerLedger.close();
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("reflection audit records applied revisions and rejected decisions", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-reflection-audit-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const auditLedger = new AsukaMemoryLedger(databasePath);
    const source = auditLedger.appendEvent(eventInput({
      text: "reflection audit source",
      sourceMessageId: "reflection-audit-source",
    }));
    const inferred = applyFixtureProposal(auditLedger, source.eventId, {
      semanticKey: "user.working.audit_inferred",
      subjectId: "user",
      predicate: "working.audit_inferred",
      value: "old",
      canonicalText: "用户可能保留旧状态",
      topLevelType: "working_memory",
      epistemicStatus: "inferred",
      authority: "inferred",
      confidence: 0.6,
      disposition: "active",
      rationale: "fixture",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const explicit = applyFixtureProposal(auditLedger, source.eventId, {
      semanticKey: "user.working.audit_explicit",
      subjectId: "user",
      predicate: "working.audit_explicit",
      value: "explicit",
      canonicalText: "用户明确提供了一条临时事实",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 0.95,
      disposition: "active",
      rationale: "fixture",
      supportingEventIds: [source.eventId],
      lifecycle: "working",
    });
    const now = Date.now();
    const scheduled = scheduleReflectionFixture(
      auditLedger,
      source.eventId,
      [inferred.claimId, explicit.claimId],
      { occurredAt: now, availableAt: now },
    );
    const claimed = auditLedger.claimNextJob({
      kinds: ["reflect"],
      now,
      leaseMs: 60_000,
    });
    const decisions = [
      {
        claimId: inferred.claimId,
        action: "revise",
        disposition: "active",
        confidence: 0.7,
        rationale: "apply revision",
        revision: {
          value: "new",
          canonicalText: "用户可能保留新状态",
          lifecycle: "working",
        },
      },
      {
        claimId: explicit.claimId,
        action: "refute",
        confidence: 0.2,
        rationale: "invalid inferred refutation",
      },
    ];
    auditLedger.commitReflection({
      eventId: scheduled.event.eventId,
      decisions,
      jobLease: { jobId: claimed.jobId, leaseToken: claimed.leaseToken },
      modelRun: {
        promptVersion: 1,
        elapsedMs: 1,
        resultSummary: (results) => JSON.stringify({
          decisions: decisions.map((decision, index) => ({
            claimId: decision.claimId,
            requestedAction: decision.action,
            applied: !results[index].ignoredReason,
            appliedClaimId: results[index].claimId,
            revisionClaimId: decision.action === "revise"
              ? results[index].claimId
              : undefined,
            ignoredReason: results[index].ignoredReason,
          })),
        }),
      },
    });
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const row = inspection.prepare(`
      SELECT result_summary
      FROM model_runs
      WHERE input_event_id = ? AND status = 'completed'
    `).get(scheduled.event.eventId);
    inspection.close();
    const summary = JSON.parse(row.result_summary);
    const revisedAudit = summary.decisions.find((item) =>
      item.claimId === inferred.claimId
    );
    const rejectedAudit = summary.decisions.find((item) =>
      item.claimId === explicit.claimId
    );
    assert.equal(revisedAudit.applied, true);
    assert.ok(revisedAudit.revisionClaimId);
    assert.notEqual(revisedAudit.revisionClaimId, inferred.claimId);
    assert.equal(rejectedAudit.applied, false);
    assert.equal(
      rejectedAudit.ignoredReason,
      "inferred_reflection_cannot_refute_explicit",
    );
    auditLedger.close();
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("lexical recall and adjudication context are semantic rather than newest-only", async () => {
  const contextLedger = new AsukaMemoryLedger(":memory:");
  try {
    const oldEvent = contextLedger.appendEvent(eventInput({
      text: "我现在住在杭州",
      sourceMessageId: "context-old-explicit",
      occurredAt: 1_000,
    }));
    const oldExplicit = applyFixtureProposal(contextLedger, oldEvent.eventId, {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "杭州",
      canonicalText: "用户目前住在杭州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
      validFrom: 1_000,
    });
    const oldClaim = contextLedger.getClaim(oldExplicit.claimId);
    const opposingEvidence = contextLedger.appendEvent(eventInput({
      text: "杭州已经不是当前住址",
      sourceMessageId: "context-old-opposing-evidence",
      occurredAt: 1_500,
    }));
    applyFixtureProposal(contextLedger, opposingEvidence.eventId, {
      semanticKey: oldClaim.semanticKey,
      subjectId: oldClaim.subjectId,
      predicate: oldClaim.predicate,
      value: oldClaim.value,
      canonicalText: oldClaim.canonicalText,
      topLevelType: oldClaim.topLevelType,
      epistemicStatus: oldClaim.epistemicStatus,
      authority: oldClaim.authority,
      confidence: oldClaim.confidence,
      supportingEventIds: [oldEvent.eventId],
      opposingEventIds: [opposingEvidence.eventId],
    });
    const sleepEvent = contextLedger.appendEvent(eventInput({
      text: "我晚上睡觉不安分",
      sourceMessageId: "context-old-sleep",
      occurredAt: 2_000,
    }));
    const sleepClaim = applyFixtureProposal(contextLedger, sleepEvent.eventId, {
      semanticKey: "user.sleep.behavior",
      subjectId: "user",
      predicate: "sleep.behavior",
      value: "不安分",
      canonicalText: "用户晚上睡觉不安分",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    const fillerClaims = [];
    for (let index = 0; index < 45; index += 1) {
      const fillerEvent = contextLedger.appendEvent(eventInput({
        text: `无关的临时记录 ${index}`,
        sourceMessageId: `context-filler-${index}`,
        occurredAt: 10_000 + index,
      }));
      const filler = applyFixtureProposal(contextLedger, fillerEvent.eventId, {
        semanticKey: `user.filler.${index}`,
        subjectId: "user",
        predicate: `filler.${index}`,
        value: index,
        canonicalText: `用户的无关临时记录 ${index}`,
        topLevelType: "event",
        epistemicStatus: "explicit",
        authority: "user_explicit",
        confidence: 1,
      });
      fillerClaims.push(contextLedger.getClaim(filler.claimId));
    }
    const lexical = contextLedger.searchLocal({
      identityId: oldEvent.identityId,
      visibility: "private",
      query: "我记得你晚上睡觉不安分",
      limit: 8,
    });
    assert.ok(
      lexical.some((candidate) => candidate.claim.claimId === sleepClaim.claimId),
      "generic lexical expansion must recover an older partial phrase match",
    );

    const correctionEvent = contextLedger.appendEvent(eventInput({
      text: "我现在改住上海了",
      sourceMessageId: "context-residence-revision",
      occurredAt: 20_000,
    }));
    let sawOldExplicit = false;
    let sawOpposingEvidence = false;
    let sawCoverageAudit = false;
    const contextEngine = new AsukaMemoryEngine(contextLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "adjudicate");
          sawOldExplicit = request.prompt.includes(oldExplicit.claimId)
            && request.prompt.includes("用户目前住在杭州");
          sawOpposingEvidence = request.prompt.includes(opposingEvidence.eventId);
          sawCoverageAudit = request.prompt.includes("上下文覆盖");
          return JSON.stringify({
            proposals: [{
              semanticKey: oldClaim.semanticKey,
              subjectId: oldClaim.subjectId,
              predicate: oldClaim.predicate,
              value: "上海",
              canonicalText: "用户目前住在上海",
              topLevelType: oldClaim.topLevelType,
              epistemicStatus: "explicit",
              sourceKind: "correction",
              confidence: 1,
              disposition: "active",
              rationale: "The user directly corrected this fact",
              action: "revise",
              targetClaimId: oldClaim.claimId,
              supportingEventIds: [correctionEvent.eventId],
              opposingEventIds: [opposingEvidence.eventId],
              lifecycle: "bounded",
            }],
          });
        },
      },
    });
    await contextEngine.adjudicateEvent(correctionEvent.eventId);
    assert.equal(
      sawOldExplicit,
      true,
      "a relevant old explicit claim must survive beyond the newest-40 window",
    );
    assert.equal(
      sawOpposingEvidence,
      true,
      "the selected semantic root must carry its opposing evidence into the prompt",
    );
    assert.equal(sawCoverageAudit, true, "the prompt must expose context coverage counts");
    assert.equal(contextLedger.getClaim(oldClaim.claimId).state, "superseded");

    let overflowModelCalls = 0;
    const overflowEvent = contextLedger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      text: "根据很多已有声明生成的总结",
      sourceMessageId: "context-required-overflow",
      occurredAt: 21_000,
      generatedFromClaimIds: fillerClaims
        .slice(0, 20)
        .map((claim) => claim.rootClaimId),
    }));
    const overflowEngine = new AsukaMemoryEngine(contextLedger, {
      model: {
        async complete() {
          overflowModelCalls += 1;
          return JSON.stringify({ proposals: [], noMemoryReason: "must not run" });
        },
      },
    });
    await assert.rejects(
      overflowEngine.adjudicateEvent(overflowEvent.eventId),
      /required.*coverage|coverage.*required|overflow/i,
    );
    assert.equal(
      overflowModelCalls,
      0,
      "unsafe required-root overflow must fail before sending a partial context",
    );

    const omittedTargetEvent = contextLedger.appendEvent(eventInput({
      text: "更新一条没有展示的声明",
      sourceMessageId: "context-omitted-target",
      occurredAt: 22_000,
    }));
    let omittedTarget;
    const omittedTargetEngine = new AsukaMemoryEngine(contextLedger, {
      model: {
        async complete(request) {
          omittedTarget = fillerClaims.find(
            (claim) => !request.prompt.includes(claim.claimId),
          );
          assert.ok(omittedTarget, "the bounded fixture must leave at least one target out");
          return JSON.stringify({
            proposals: [{
              semanticKey: omittedTarget.semanticKey,
              subjectId: omittedTarget.subjectId,
              predicate: omittedTarget.predicate,
              value: "changed",
              canonicalText: "模型试图修改未展示的声明",
              topLevelType: omittedTarget.topLevelType,
              epistemicStatus: "explicit",
              sourceKind: "correction",
              confidence: 1,
              disposition: "active",
              rationale: "The user directly corrected this fact",
              action: "revise",
              targetClaimId: omittedTarget.claimId,
              supportingEventIds: [omittedTargetEvent.eventId],
            }],
          });
        },
      },
    });
    await assert.rejects(
      omittedTargetEngine.adjudicateEvent(omittedTargetEvent.eventId),
      /target coverage missing/i,
    );
    assert.equal(contextLedger.getClaim(omittedTarget.claimId).state, "active");

    const hiddenEvidence = contextLedger.appendEvent(eventInput({
      text: "这条孤立证据没有出现在任何声明上下文中",
      sourceMessageId: "context-hidden-evidence",
      occurredAt: 23_000,
    }));
    const inventedEvidenceEvent = contextLedger.appendEvent(eventInput({
      text: "形成一个新声明",
      sourceMessageId: "context-invented-evidence",
      occurredAt: 24_000,
    }));
    const claimsBeforeEvidenceFailure = contextLedger.listClaims().length;
    const inventedEvidenceEngine = new AsukaMemoryEngine(contextLedger, {
      model: {
        async complete() {
          return JSON.stringify({
            proposals: [{
              semanticKey: "user.context.invented_evidence",
              subjectId: "user",
              predicate: "context.invented_evidence",
              value: true,
              canonicalText: "模型引用了未展示的证据",
              topLevelType: "fact",
              epistemicStatus: "explicit",
              sourceKind: "statement",
              confidence: 1,
              disposition: "active",
              rationale: "The event directly states this fact",
              supportingEventIds: [
                inventedEvidenceEvent.eventId,
                hiddenEvidence.eventId,
              ],
            }],
          });
        },
      },
    });
    await assert.rejects(
      inventedEvidenceEngine.adjudicateEvent(inventedEvidenceEvent.eventId),
      /evidence coverage missing/i,
    );
    assert.equal(
      contextLedger.listClaims().length,
      claimsBeforeEvidenceFailure,
      "coverage failure must occur before the first claim mutation",
    );
  } finally {
    contextLedger.close();
  }
});

await verifyIntegrityInvariant("production embedding requirement is fail-closed and health-checked", async () => {
  const missingAdapterLedger = new AsukaMemoryLedger(":memory:");
  try {
    assert.throws(
      () => new AsukaMemoryEngine(missingAdapterLedger, {
        requireEmbeddings: true,
        model: { async complete() { return "{}"; } },
      }),
      /embedding/i,
    );
  } finally {
    missingAdapterLedger.close();
  }

  const disabledVectorLedger = new AsukaMemoryLedger(":memory:", { enableVector: false });
  try {
    assert.throws(
      () => new AsukaMemoryEngine(disabledVectorLedger, {
        requireEmbeddings: true,
        model: {
          async complete() { return "{}"; },
          async embed() {
            return { model: "fixture", dimensions: 2, vectors: [[1, 0]] };
          },
        },
      }),
      /vector/i,
    );
  } finally {
    disabledVectorLedger.close();
  }

  const healthyLedger = new AsukaMemoryLedger(":memory:");
  try {
    const healthyEngine = new AsukaMemoryEngine(healthyLedger, {
      requireEmbeddings: true,
      model: {
        async complete() { return "{}"; },
        async embed(texts) {
          return {
            model: "fixture",
            dimensions: 2,
            vectors: texts.map(() => [1, 0]),
          };
        },
      },
    });
    assert.deepEqual(await healthyEngine.checkEmbeddingHealth(), {
      required: true,
      ready: true,
      model: "fixture",
      dimensions: 2,
    });
  } finally {
    healthyLedger.close();
  }
});

await verifyIntegrityInvariant("adjudication parser rejects malformed semantic decisions", async () => {
  const parserLedger = new AsukaMemoryLedger(":memory:");
  try {
    const source = parserLedger.appendEvent(eventInput({
      text: "我现在住在杭州",
      sourceMessageId: "strict-adjudication-parser",
    }));
    const base = {
      semanticKey: "user.residence.current",
      subjectId: "user",
      predicate: "residence.current_city",
      value: "杭州",
      canonicalText: "用户目前住在杭州",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      sourceKind: "statement",
      confidence: 1,
      disposition: "active",
      rationale: "The user stated this directly",
      action: "add",
      supportingEventIds: [source.eventId],
    };
    const parse = (proposal) => parseMemoryJudgement(
      JSON.stringify({ proposals: [proposal] }),
      parserLedger.getEvent(source.eventId),
    );
    assert.equal(parse(base).proposals.length, 1);
    assert.throws(
      () => parse({ ...base, disposition: undefined }),
      /missing disposition or rationale/i,
    );
    assert.throws(
      () => parse({ ...base, action: "promote" }),
      /invalid action/i,
    );
    assert.throws(
      () => parse({ ...base, confidence: "high" }),
      /invalid confidence/i,
    );
    assert.throws(
      () => parse({
        ...base,
        epistemicStatus: "inferred",
        sourceKind: "inference",
        confidence: 0.6,
        disposition: undefined,
        rationale: "间接线索",
      }),
      /missing disposition or rationale/i,
    );
    assert.throws(
      () => parse({
        ...base,
        epistemicStatus: "inferred",
        sourceKind: "inference",
        confidence: 0.6,
        disposition: "candidate",
        rationale: "间接线索",
        supportingEventIds: [],
      }),
      /missing inferred evidence/i,
    );
    assert.throws(
      () => parse({
        ...base,
        action: "delete",
        targetClaimId: "fixture-target",
        disposition: "active",
      }),
      /fields incompatible with delete/i,
    );
    assert.throws(
      () => parse({ ...base, targetClaimId: "unexpected-target" }),
      /fields incompatible with add/i,
    );
    const behavioral = parse({
      ...base,
      epistemicStatus: "inferred",
      sourceKind: "behavior",
      disposition: "candidate",
      rationale: "Repeated behavior suggests this, but it remains an inference",
    }).proposals[0];
    assert.equal(
      behavioral.authority,
      "inferred",
      "behavior evidence must not elevate inferred authority",
    );
    for (const [field, value] of [
      ["semanticKey", "s".repeat(241)],
      ["subjectId", "s".repeat(201)],
      ["predicate", "p".repeat(201)],
      ["canonicalText", "c".repeat(501)],
      ["sourceKind", "s".repeat(41)],
      ["rationale", "r".repeat(501)],
      ["topic", "t".repeat(161)],
      ["entityIds", ["e".repeat(201)]],
    ]) {
      assert.throws(
        () => parse({ ...base, [field]: value }),
        /invalid/i,
        `adjudication must reject ${field} at max+1 instead of truncating it`,
      );
    }
    assert.throws(
      () => parseMemoryJudgement(
        JSON.stringify({
          proposals: [],
          noMemoryReason: "n".repeat(501),
        }),
        parserLedger.getEvent(source.eventId),
      ),
      /invalid noMemoryReason/i,
    );

    const reflectionBase = {
      claimId: "claim-1",
      action: "revise",
      disposition: "active",
      confidence: 0.8,
      rationale: "New evidence changes the claim",
      revision: {
        value: "new",
        canonicalText: "The claim has changed",
        topic: "dynamic topic",
        entityIds: ["entity-1"],
      },
    };
    const parseReflection = (decision) => parseReflectionResult(
      JSON.stringify({ decisions: [decision] }),
      new Set([decision.claimId]),
    );
    assert.equal(parseReflection(reflectionBase).decisions.length, 1);
    assert.throws(
      () => parseReflection({ ...reflectionBase, disposition: undefined }),
      /missing disposition/i,
    );
    for (const decision of [
      { ...reflectionBase, claimId: "c".repeat(201) },
      { ...reflectionBase, rationale: "r".repeat(501) },
      {
        ...reflectionBase,
        revision: {
          ...reflectionBase.revision,
          canonicalText: "c".repeat(501),
        },
      },
      {
        ...reflectionBase,
        revision: {
          ...reflectionBase.revision,
          topic: "t".repeat(161),
        },
      },
      {
        ...reflectionBase,
        revision: {
          ...reflectionBase.revision,
          entityIds: ["e".repeat(201)],
        },
      },
    ]) {
      assert.throws(
        () => parseReflection(decision),
        /invalid/i,
        "reflection must reject max+1 semantic fields instead of truncating them",
      );
    }
  } finally {
    parserLedger.close();
  }
});

await verifyIntegrityInvariant("oversized adjudication output is rejected instead of truncated", async () => {
  const oversizedLedger = new AsukaMemoryLedger(":memory:");
  try {
    const source = oversizedLedger.appendEvent(eventInput({
      text: "一次包含许多独立信息的消息",
      sourceMessageId: "oversized-adjudication",
    }));
    const oversizedEngine = new AsukaMemoryEngine(oversizedLedger, {
      model: {
        async complete(request) {
          assert.equal(request.task, "adjudicate");
          return JSON.stringify({
            proposals: Array.from({ length: 13 }, (_, index) => ({
              semanticKey: `user.oversized.${index}`,
              subjectId: "user",
              predicate: `oversized.${index}`,
              value: index,
              canonicalText: `用户提供了第 ${index} 条独立信息`,
              topLevelType: "fact",
              epistemicStatus: "explicit",
              sourceKind: "statement",
              confidence: 1,
              disposition: "active",
              rationale: "用户明确陈述",
            })),
          });
        },
      },
    });
    await assert.rejects(
      oversizedEngine.adjudicateEvent(source.eventId),
      /13 proposals|maximum is 12/i,
    );
    assert.equal(oversizedLedger.listClaims().length, 0);
  } finally {
    oversizedLedger.close();
  }
});

await verifyIntegrityInvariant("multi-proposal adjudication is atomic", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-adjudication-atomic-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const setupLedger = new AsukaMemoryLedger(databasePath);
    const source = setupLedger.appendEvent(eventInput({
      text: "我喜欢晨跑，也喜欢夜间读书",
      sourceMessageId: "adjudication-atomic-source",
    }));
    setupLedger.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_second_atomic_claim
      BEFORE INSERT ON memory_claims
      WHEN NEW.semantic_key = 'user.atomic.second'
      BEGIN
        SELECT RAISE(ABORT, 'fixture rejects second proposal');
      END;
    `);
    database.close();

    const atomicLedger = new AsukaMemoryLedger(databasePath);
    try {
      const engine = new AsukaMemoryEngine(atomicLedger, {
        model: {
          async complete(request) {
            assert.equal(request.task, "adjudicate");
            return JSON.stringify({
              proposals: [
                {
                  semanticKey: "user.atomic.first",
                  subjectId: "user",
                  predicate: "atomic.first",
                  value: true,
                  canonicalText: "用户喜欢晨跑",
                  topLevelType: "fact",
                  epistemicStatus: "explicit",
                  sourceKind: "statement",
                  confidence: 1,
                  disposition: "active",
                  rationale: "用户明确陈述",
                },
                {
                  semanticKey: "user.atomic.second",
                  subjectId: "user",
                  predicate: "atomic.second",
                  value: true,
                  canonicalText: "用户喜欢夜间读书",
                  topLevelType: "fact",
                  epistemicStatus: "explicit",
                  sourceKind: "statement",
                  confidence: 1,
                  disposition: "active",
                  rationale: "用户明确陈述",
                },
              ],
            });
          },
        },
      });
      await assert.rejects(
        engine.adjudicateEvent(source.eventId),
        /fixture rejects second proposal/,
      );
      assert.deepEqual(
        atomicLedger.listClaims(),
        [],
        "a later proposal failure must roll back every earlier proposal",
      );
      atomicLedger.enqueueJob(source.eventId, "adjudicate", 1);
      const batch = await engine.processPendingMemoryJobs({
        kinds: ["adjudicate"],
        maxJobs: 1,
        now: 1,
        retryDelayMs: 0,
      });
      assert.equal(batch.failed, 1);
      assert.equal(atomicLedger.listJobs()[0].status, "pending");
      assert.deepEqual(
        atomicLedger.listClaims(),
        [],
        "the worker job transition must not commit a partial judgement",
      );
    } finally {
      atomicLedger.close();
    }
    const auditDatabase = new DatabaseSync(databasePath);
    const completedRuns = auditDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM model_runs
      WHERE task = 'adjudicate' AND status = 'completed'
    `).get();
    auditDatabase.close();
    assert.equal(completedRuns.count, 0);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("legacy consolidation rejects cross-subject semantic collisions", async () => {
  const consolidationLedger = new AsukaMemoryLedger(":memory:");
  try {
    const currentEvent = consolidationLedger.appendEvent(eventInput({
      text: "Asuka 喜欢雨天",
      sourceMessageId: "cross-subject-existing",
    }));
    applyFixtureProposal(consolidationLedger, currentEvent.eventId, {
      semanticKey: "shared.preference.weather",
      subjectId: "asuka",
      predicate: "preference.weather",
      value: "雨天",
      canonicalText: "Asuka 喜欢雨天",
      topLevelType: "self_narrative",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });

    const legacyFixture = legacyEventInput("用户喜欢晴天", {
      sourceRecordId: "cross-subject-legacy",
      occurredAt: 1_000,
    });
    const legacy = consolidationLedger.appendLegacyEvent(
      legacyFixture.input,
      legacyFixture.source,
      { enqueue: false },
    );
    const extraction = consolidationLedger.recordLegacyExtraction(legacy.eventId, {
      eventId: legacy.eventId,
      proposals: [{
        semanticKey: "shared.preference.weather",
        subjectId: "user",
        predicate: "preference.weather",
        value: "晴天",
        canonicalText: "用户喜欢晴天",
        topLevelType: "fact",
        epistemicStatus: "explicit",
        authority: "user_explicit",
        confidence: 1,
        disposition: "active",
        rationale: "旧记录中的用户明确陈述",
      }],
    });
    const run = consolidationLedger.beginLegacyConsolidation({
      identityId: legacy.identityId,
      visibility: "private",
      inputHash: "cross-subject-input",
      inputCandidateCount: 1,
      sourceEventCount: 1,
    });
    await assert.rejects(
      async () => consolidationLedger.commitLegacyConsolidation({
        runId: run.runId,
        runToken: run.runToken,
        claims: [{
          semanticKey: "shared.preference.weather",
          sourceCandidateIds: extraction.candidateClaimIds,
          subjectId: "user",
          predicate: "preference.weather",
          value: "晴天",
          canonicalText: "用户喜欢晴天",
          topLevelType: "fact",
          epistemicStatus: "explicit",
          confidence: 1,
          disposition: "active",
          rationale: "模型确认旧记录中的明确事实",
          entityIds: [],
          supportingEventIds: [legacy.eventId],
          opposingEventIds: [],
        }],
        discarded: [],
        audit: {},
      }),
      /semantic key.*multiple subjects|subject collision/i,
    );
    assert.equal(
      consolidationLedger.getClaim(extraction.candidateClaimIds[0]).state,
      "candidate",
    );
  } finally {
    consolidationLedger.close();
  }
});

await verifyIntegrityInvariant("duplicate legacy import preserves the stored identity scope", async () => {
  const duplicateLedger = new AsukaMemoryLedger(":memory:");
  try {
    const fixture = legacyEventInput("duplicate identity content", {
      sourceRecordId: "duplicate-identity",
      identityId: "identity-a",
    });
    const first = duplicateLedger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    assert.equal(first.identityId, "identity-a");
    assert.throws(
      () => duplicateLedger.appendLegacyEvent(
        {
          ...fixture.input,
          identityId: "identity-b",
        },
        fixture.source,
        { enqueue: false },
      ),
      /duplicate.*scope|identity.*mismatch/i,
    );
    const duplicate = duplicateLedger.appendLegacyEvent(
      {
        ...fixture.input,
        identityId: undefined,
      },
      fixture.source,
      { enqueue: false },
    );
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.identityId, "identity-a");
    assert.equal(duplicateLedger.getEvent(first.eventId).identityId, "identity-a");
    assert.equal(
      duplicateLedger.listIdentityLinks()[0].identityId,
      "identity-a",
      "a duplicate receipt must not relink the peer before validating stored scope",
    );
  } finally {
    duplicateLedger.close();
  }
});

await verifyIntegrityInvariant("duplicate legacy import repairs a missing rejudgement job", async () => {
  const duplicateLedger = new AsukaMemoryLedger(":memory:");
  try {
    const fixture = legacyEventInput("event-only upgrade fixture", {
      sourceRecordId: "event-only-upgrade",
    });
    const first = duplicateLedger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    assert.equal(first.inserted, true);
    assert.equal(duplicateLedger.listJobs().length, 0);

    const duplicate = duplicateLedger.appendLegacyEvent(
      fixture.input,
      fixture.source,
    );
    assert.equal(duplicate.inserted, false);
    const jobs = duplicateLedger.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].eventId, first.eventId);
    assert.equal(jobs[0].kind, "legacy_rejudge");
    assert.equal(jobs[0].status, "pending");
  } finally {
    duplicateLedger.close();
  }
});

await verifyIntegrityInvariant("expired final leases fail and unblock later legacy work", async () => {
  const leaseLedger = new AsukaMemoryLedger(":memory:");
  try {
    const firstFixture = legacyEventInput("first leased record", {
      sourceRecordId: "lease-first",
      occurredAt: 1,
    });
    const secondFixture = legacyEventInput("second leased record", {
      sourceRecordId: "lease-second",
      occurredAt: 2,
    });
    const first = leaseLedger.appendLegacyEvent(
      firstFixture.input,
      firstFixture.source,
      { enqueue: false },
    );
    const second = leaseLedger.appendLegacyEvent(
      secondFixture.input,
      secondFixture.source,
      { enqueue: false },
    );
    leaseLedger.enqueueJob(first.eventId, "legacy_rejudge", 1);
    leaseLedger.enqueueJob(second.eventId, "legacy_rejudge", 1);

    const crashed = leaseLedger.claimNextJob({
      kinds: ["legacy_rejudge"],
      now: 1,
      leaseMs: 10,
      maxAttempts: 1,
    });
    assert.equal(crashed.eventId, first.eventId);
    const next = leaseLedger.claimNextJob({
      kinds: ["legacy_rejudge"],
      now: 11,
      leaseMs: 10,
      maxAttempts: 1,
    });
    assert.equal(
      next.eventId,
      second.eventId,
      "the terminally expired first job must not strand later work",
    );
    assert.equal(
      leaseLedger.listJobs().find((job) => job.eventId === first.eventId).status,
      "failed",
    );
    assert.equal(leaseLedger.completeJob(next.jobId, next.leaseToken, 11), true);

    assert.equal(leaseLedger.retryFailedJobs("legacy_rejudge", 12), 1);
    const retried = leaseLedger.claimNextJob({
      kinds: ["legacy_rejudge"],
      now: 12,
      leaseMs: 10,
      maxAttempts: 1,
    });
    assert.equal(retried.eventId, first.eventId);
  } finally {
    leaseLedger.close();
  }
});

await verifyIntegrityInvariant("job and consolidation terminal states are monotonic", async () => {
  const monotonicLedger = new AsukaMemoryLedger(":memory:");
  try {
    const source = monotonicLedger.appendEvent(eventInput({
      text: "lease generation fixture",
      sourceMessageId: "lease-generation",
    }));
    monotonicLedger.enqueueJob(source.eventId, "adjudicate", 1);
    const firstLease = monotonicLedger.claimNextJob({
      kinds: ["adjudicate"],
      now: 1,
      leaseMs: 10,
      maxAttempts: 2,
    });
    const secondLease = monotonicLedger.claimNextJob({
      kinds: ["adjudicate"],
      now: 11,
      leaseMs: 10,
      maxAttempts: 2,
    });
    assert.notEqual(firstLease.leaseToken, secondLease.leaseToken);
    assert.equal(
      monotonicLedger.completeJob(firstLease.jobId, firstLease.leaseToken, 11),
      false,
    );
    assert.equal(
      monotonicLedger.failJob(
        firstLease.jobId,
        firstLease.leaseToken,
        "stale worker",
        { maxAttempts: 2 },
      ).applied,
      false,
    );
    assert.equal(
      monotonicLedger.completeJob(secondLease.jobId, secondLease.leaseToken, 12),
      true,
    );
    assert.equal(
      monotonicLedger.failJob(
        secondLease.jobId,
        secondLease.leaseToken,
        "late failure",
        { maxAttempts: 2 },
      ).applied,
      false,
    );
    assert.equal(monotonicLedger.listJobs()[0].status, "completed");

    const staleRun = monotonicLedger.beginLegacyConsolidation({
      identityId: "empty-consolidation-identity",
      visibility: "private",
      inputHash: "empty-consolidation-input",
      inputCandidateCount: 0,
      sourceEventCount: 0,
    });
    const run = monotonicLedger.beginLegacyConsolidation({
      identityId: "empty-consolidation-identity",
      visibility: "private",
      inputHash: "empty-consolidation-input",
      inputCandidateCount: 0,
      sourceEventCount: 0,
    });
    assert.notEqual(run.runToken, staleRun.runToken);
    assert.equal(
      monotonicLedger.failLegacyConsolidation(
        staleRun.runId,
        staleRun.runToken,
        "stale consolidation worker",
      ),
      false,
    );
    const completed = monotonicLedger.commitLegacyConsolidation({
      runId: run.runId,
      runToken: run.runToken,
      claims: [],
      discarded: [],
      audit: { fixture: true },
    });
    assert.equal(completed.status, "completed");
    assert.equal(
      monotonicLedger.failLegacyConsolidation(
        completed.runId,
        run.runToken,
        "late consolidation failure",
      ),
      false,
    );
    const restarted = monotonicLedger.beginLegacyConsolidation({
      identityId: "empty-consolidation-identity",
      visibility: "private",
      inputHash: "empty-consolidation-input",
      inputCandidateCount: 0,
      sourceEventCount: 0,
    });
    assert.equal(restarted.status, "completed");
    assert.deepEqual(restarted.outputClaimIds, completed.outputClaimIds);
  } finally {
    monotonicLedger.close();
  }
});

await verifyIntegrityInvariant("legacy sources preserve immutable full content with chunk coverage", async () => {
  const archiveLedger = new AsukaMemoryLedger(":memory:");
  try {
    const archiveEngine = new AsukaMemoryEngine(archiveLedger);
    const sourceContent = JSON.stringify({
      transcript: "长内容".repeat(4_500),
      tail: "immutable-tail-marker",
    });
    assert.ok(sourceContent.length > 8_000);
    const report = migrateLegacyRecords(archiveEngine, [{
      sourceKind: "session",
      sourcePath: "/legacy/session.jsonl",
      sourceRecordId: "session-long:line-1",
      sourceContent,
      legacyId: "legacy-long-record",
      actor: "user",
      text: sourceContent,
      occurredAt: 1_000,
      metadata: { sessionId: "session-long", sourceLine: 1 },
    }], {
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
    });
    const eventId = report.sourceMap[0].eventId;
    const archive = archiveLedger.getLegacySourceArchive(eventId);
    assert.equal(archive.content, sourceContent);
    assert.equal(archive.contentHash, report.sourceMap[0].legacyContentHash);
    assert.equal(archive.chunks.map((chunk) => chunk.content).join(""), sourceContent);
    assert.deepEqual(
      archive.chunks.map((chunk) => chunk.index),
      archive.chunks.map((_, index) => index),
    );
    assert.equal(archive.coveredChars, sourceContent.length);
    assert.equal(archive.complete, true);

    assert.throws(
      () => archiveLedger.storeLegacySourceArchive(
        eventId,
        `${sourceContent}-mutated`,
        report.sourceMap[0].legacyContentHash,
      ),
      /immutable|hash/i,
    );
  } finally {
    archiveLedger.close();
  }
});

await verifyIntegrityInvariant("legacy archive chunking preserves astral Unicode across restart", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-unicode-archive-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const sourceContent = `${"a".repeat(7_999)}😀tail`;
    const fixture = legacyEventInput(sourceContent, {
      sourceRecordId: "unicode-boundary",
    });
    const firstLedger = new AsukaMemoryLedger(databasePath);
    const receipt = firstLedger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    firstLedger.close();

    const reopened = new AsukaMemoryLedger(databasePath);
    try {
      const archive = reopened.getLegacySourceArchive(receipt.eventId);
      assert.equal(archive.content, sourceContent);
      assert.equal(archive.complete, true);
      assert.equal(archive.chunks.map((chunk) => chunk.content).join(""), sourceContent);
      assert.ok(
        archive.chunks.every((chunk) => !chunk.content.includes("\uFFFD")),
        "a chunk boundary must never split a surrogate pair",
      );
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("schema v4 archives rebuild immutable manifests on upgrade", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-v4-archive-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const sourceContent = `${"a".repeat(7_999)}😀legacy`;
    const fixture = legacyEventInput(sourceContent, {
      sourceRecordId: "schema-v4-archive",
    });
    const current = new AsukaMemoryLedger(databasePath);
    const receipt = current.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    current.close();

    const oldDatabase = new DatabaseSync(databasePath);
    const triggers = oldDatabase.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'legacy_%'
    `).all();
    for (const { name } of triggers) {
      oldDatabase.exec(`DROP TRIGGER "${String(name).replaceAll('"', '""')}"`);
    }
    oldDatabase.exec(`
      DROP TABLE legacy_migration_bindings;
      ALTER TABLE legacy_source_archives DROP COLUMN chunk_count;
      ALTER TABLE legacy_source_archives DROP COLUMN manifest_hash;
      DELETE FROM schema_migrations WHERE version = 5;
    `);
    oldDatabase.prepare(`
      DELETE FROM legacy_source_archive_chunks
      WHERE event_id = ? AND chunk_index = 1
    `).run(receipt.eventId);
    oldDatabase.close();

    const upgraded = new AsukaMemoryLedger(databasePath);
    try {
      const archive = upgraded.getLegacySourceArchive(receipt.eventId);
      assert.equal(archive.content, sourceContent);
      assert.equal(archive.complete, true);
      assert.equal(
        upgraded.verifyLegacyMigrationBinding(receipt.eventId).valid,
        true,
      );
      assert.equal(upgraded.integrityCheck().schemaVersion, 5);
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("finalized archive manifests reject structural mutation", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-archive-manifest-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const sourceContent = "manifest-content-".repeat(1_000);
    const fixture = legacyEventInput(sourceContent, {
      sourceRecordId: "manifest-immutability",
    });
    const ledger = new AsukaMemoryLedger(databasePath);
    const receipt = ledger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    ledger.close();

    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => database.prepare(`
          DELETE FROM legacy_source_archive_chunks
          WHERE event_id = ? AND chunk_index = 0
        `).run(receipt.eventId),
        /immutable|finalized/i,
      );
      assert.throws(
        () => database.prepare(`
          INSERT INTO legacy_source_archive_chunks(
            event_id, chunk_index, start_char, end_char, content_hash, content
          ) VALUES (?, 999, ?, ?, ?, '')
        `).run(
          receipt.eventId,
          sourceContent.length,
          sourceContent.length,
          createHash("sha256").update("").digest("hex"),
        ),
        /immutable|finalized/i,
      );
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("verified archive access cannot expose corrupted content", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-archive-verification-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const sourceContent = "verified-content-".repeat(1_000);
    const fixture = legacyEventInput(sourceContent, {
      sourceRecordId: "verified-access",
    });
    const ledger = new AsukaMemoryLedger(databasePath);
    const receipt = ledger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    ledger.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TRIGGER legacy_source_archive_chunks_insert_immutable;
      DROP TRIGGER legacy_source_archive_chunks_delete_immutable;
    `);
    database.prepare(`
      DELETE FROM legacy_source_archive_chunks
      WHERE event_id = ? AND chunk_index = 0
    `).run(receipt.eventId);
    database.close();

    const corrupted = new AsukaMemoryLedger(databasePath);
    try {
      assert.throws(
        () => corrupted.getLegacySourceArchive(receipt.eventId),
        /integrity|incomplete|manifest/i,
      );
      const inspection = corrupted.inspectLegacySourceArchive(receipt.eventId);
      assert.equal(inspection.complete, false);
      assert.equal(inspection.content, sourceContent);
    } finally {
      corrupted.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("legacy migration bindings are immutable and detect provenance drift", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-binding-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const sourceContent = "binding content";
    const fixture = legacyEventInput(sourceContent, {
      sourceRecordId: "binding-provenance",
      identityId: "identity-binding",
    });
    const ledger = new AsukaMemoryLedger(databasePath);
    const receipt = ledger.appendLegacyEvent(
      fixture.input,
      fixture.source,
      { enqueue: false },
    );
    const binding = ledger.getLegacyMigrationBinding(receipt.eventId);
    assert.equal(binding.identityId, "identity-binding");
    assert.equal(binding.sourceKind, "memory");
    assert.equal(binding.disposition, "imported");
    assert.equal(binding.contentHash, fixture.source.contentHash);
    assert.equal(binding.contentChars, sourceContent.length);
    assert.equal(ledger.verifyLegacyMigrationBinding(receipt.eventId).valid, true);
    assert.ok(
      ledger.listLegacyMigrationBindings()
        .some((candidate) => candidate.eventId === receipt.eventId),
    );
    ledger.close();

    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => database.prepare(`
          UPDATE legacy_migration_bindings SET source_kind = 'tampered'
          WHERE event_id = ?
        `).run(receipt.eventId),
        /immutable/i,
      );
      assert.throws(
        () => database.prepare("DELETE FROM memory_events WHERE event_id = ?")
          .run(receipt.eventId),
        /binding|immutable/i,
      );
      database.prepare(`
        UPDATE memory_events SET source_id = 'tampered-locator' WHERE event_id = ?
      `).run(receipt.eventId);
    } finally {
      database.close();
    }

    const drifted = new AsukaMemoryLedger(databasePath);
    try {
      const verification = drifted.verifyLegacyMigrationBinding(receipt.eventId);
      assert.equal(verification.valid, false);
      assert.ok(
        verification.errors.some((error) => /locator|source/i.test(error)),
      );
    } finally {
      drifted.close();
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

await verifyIntegrityInvariant("semantic key compatibility migration", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-schema-v1-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const originalLedger = new AsukaMemoryLedger(databasePath);
    const source = originalLedger.appendEvent(eventInput({
      text: "旧库里的声明",
      sourceMessageId: "schema-v1-source",
    }));
    const original = applyFixtureProposal(originalLedger, source.eventId, {
      subjectId: "user",
      predicate: "legacy.predicate",
      value: true,
      canonicalText: "旧库里的声明",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    originalLedger.close();

    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      DROP INDEX idx_memory_claims_semantic_key;
      ALTER TABLE memory_claims DROP COLUMN semantic_key;
      DELETE FROM schema_migrations WHERE version = 2;
    `);
    oldDatabase.close();

    const migratedLedger = new AsukaMemoryLedger(databasePath);
    const migrated = migratedLedger.getClaim(original.claimId);
    assert.equal(migrated.semanticKey, "user.legacy.predicate");
    migratedLedger.close();

    const interruptedDatabase = new DatabaseSync(databasePath);
    interruptedDatabase.prepare(`
      UPDATE memory_claims SET semantic_key = NULL WHERE claim_id = ?
    `).run(original.claimId);
    interruptedDatabase.close();

    const resumedLedger = new AsukaMemoryLedger(databasePath);
    const revisionEvent = resumedLedger.appendEvent(eventInput({
      text: "旧库里的声明已更新",
      sourceMessageId: "schema-v1-revision",
    }));
    const revision = applyFixtureProposal(resumedLedger, revisionEvent.eventId, {
      subjectId: "user",
      predicate: "legacy.predicate",
      value: false,
      canonicalText: "旧库里的声明已更新",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      authority: "user_explicit",
      confidence: 1,
    });
    assert.equal(
      resumedLedger.getClaim(revision.claimId).rootClaimId,
      original.rootClaimId,
      "restart after a partial compatibility migration must backfill semantic keys",
    );
    resumedLedger.close();

    const verifiedDatabase = new DatabaseSync(databasePath);
    const columns = verifiedDatabase.prepare("PRAGMA table_info(memory_claims)").all();
    const indexes = verifiedDatabase.prepare("PRAGMA index_list(memory_claims)").all();
    verifiedDatabase.close();
    assert.ok(columns.some((column) => column.name === "semantic_key"));
    assert.ok(indexes.some((index) => index.name === "idx_memory_claims_semantic_key"));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

assert.deepEqual(
  integrityInvariantFailures,
  [],
  `memory ledger integrity invariant failures:\n${integrityInvariantFailures.join("\n")}`,
);

assert.equal(ledger.integrityCheck().ok, true);
ledger.close();
console.log("asuka-memory-kernel tests passed");
