import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";

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

const ledger = new AsukaMemoryLedger(":memory:");
const first = ledger.appendEvent(eventInput({ sourceMessageId: "sleep-1" }));
const duplicate = ledger.appendEvent(eventInput({ sourceMessageId: "sleep-1" }));
assert.equal(first.inserted, true);
assert.equal(duplicate.inserted, false, "source message id must make event append idempotent");

const explicit = ledger.applyClaimProposal(first.eventId, {
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
const lowerAuthority = ledger.applyClaimProposal(inferenceEvent.eventId, {
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

const assistantExplicit = ledger.applyClaimProposal(inferenceEvent.eventId, {
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
const inferredActive = ledger.applyClaimProposal(userEvidence3.eventId, {
  subjectId: "user",
  predicate: "temperature.sensitivity",
  value: "怕冷",
  canonicalText: "用户可能比较怕冷",
  topLevelType: "belief",
  epistemicStatus: "inferred",
  authority: "inferred",
  confidence: 0.86,
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
ledger.applyClaimProposal(selfRepeat.eventId, {
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

const vectorOnlyLedger = new AsukaMemoryLedger(":memory:");
const vectorOnlyTargetEvent = vectorOnlyLedger.appendEvent(eventInput({
  text: "我偏爱雨后石板路的气味",
  sourceMessageId: "vector-only-target",
}));
const vectorOnlyTarget = vectorOnlyLedger.applyClaimProposal(vectorOnlyTargetEvent.eventId, {
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
for (let index = 0; index < 10; index += 1) {
  const fillerEvent = vectorOnlyLedger.appendEvent(eventInput({
    text: `无关近况 ${index}`,
    sourceMessageId: `vector-only-filler-${index}`,
  }));
  vectorOnlyLedger.applyClaimProposal(fillerEvent.eventId, {
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
assert.ok(
  !withoutVector.some((candidate) => candidate.claim.claimId === vectorOnlyTarget.claimId),
  "the target must not be reachable through lexical or recent fallback",
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

const groupLeak = noModelEngine.retrieveMemoryContextLocal({
  accountId: "default",
  peerKind: "group",
  peerId: "group-1",
  identityId: first.identityId,
  query: "睡觉",
});
assert.equal(groupLeak.claimIds.length, 0, "private claims must not be retrievable from a group scope");

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

await verifyIntegrityInvariant("forget/delete authority", async () => {
  const authorityLedger = new AsukaMemoryLedger(":memory:");
  try {
    const factEvent = authorityLedger.appendEvent(eventInput({
      text: "我明确住在苏州",
      sourceMessageId: "authority-fact",
    }));
    const fact = authorityLedger.applyClaimProposal(factEvent.eventId, {
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
    const inferredForget = authorityLedger.applyClaimProposal(inferredEvent.eventId, {
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

    const inferredDelete = authorityLedger.applyClaimProposal(inferredEvent.eventId, {
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
    const weakControl = authorityLedger.applyClaimProposal(weakControlEvent.eventId, {
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
    const authorized = authorityLedger.applyClaimProposal(controlEvent.eventId, {
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
    const privateClaim = scopeLedger.applyClaimProposal(privateEvent.eventId, {
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
    const crossScopeTarget = scopeLedger.applyClaimProposal(publicEvent.eventId, {
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

    const missingEvidence = scopeLedger.applyClaimProposal(privateEvent.eventId, {
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

    const crossScopeEvidence = scopeLedger.applyClaimProposal(privateEvent.eventId, {
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
    const futureClaim = temporalLedger.applyClaimProposal(futureEvent.eventId, {
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
    const firstCandidate = candidateLedger.applyClaimProposal(firstEvent.eventId, {
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
    const secondCandidate = candidateLedger.applyClaimProposal(secondEvent.eventId, {
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
    const currentClaim = futureRevisionLedger.applyClaimProposal(currentEvent.eventId, {
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
    const futureClaim = futureRevisionLedger.applyClaimProposal(futureEvent.eventId, {
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
    const target = revalidationLedger.applyClaimProposal(source.eventId, {
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
    const deletion = revalidationLedger.applyClaimProposal(deletionEvent.eventId, {
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
      const target = revalidationLedger.applyClaimProposal(source.eventId, {
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
      const deletion = revalidationLedger.applyClaimProposal(deletionEvent.eventId, {
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
    const target = revalidationLedger.applyClaimProposal(source.eventId, {
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
    const deletion = revalidationLedger.applyClaimProposal(deletionEvent.eventId, {
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

await verifyIntegrityInvariant("semantic key compatibility migration", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-schema-v1-"));
  const databasePath = path.join(fixtureRoot, "ledger.sqlite");
  try {
    const originalLedger = new AsukaMemoryLedger(databasePath);
    const source = originalLedger.appendEvent(eventInput({
      text: "旧库里的声明",
      sourceMessageId: "schema-v1-source",
    }));
    const original = originalLedger.applyClaimProposal(source.eventId, {
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
    const revision = resumedLedger.applyClaimProposal(revisionEvent.eventId, {
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
