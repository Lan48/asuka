import assert from "node:assert/strict";
import { AsukaMemoryEngine } from "../dist/src/asuka-memory-kernel/engine.js";
import { AsukaMemoryLedger } from "../dist/src/asuka-memory-kernel/ledger.js";
import {
  containsDeterministicSecretValue,
  scanDeterministicSecretValue,
} from "../dist/src/asuka-memory-kernel/policy.js";

function eventInput(overrides = {}) {
  return {
    accountId: "default",
    peerKind: "direct",
    peerId: "user-1",
    actor: "user",
    kind: "user_message",
    text: "ordinary memory event",
    sourceMessageId: `message-${Math.random()}`,
    ...overrides,
  };
}

function explicitProposal(overrides = {}) {
  return {
    semanticKey: `fact:${Math.random()}`,
    subjectId: "user",
    predicate: "profile.fact",
    value: "value",
    canonicalText: "The user stated a fact",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 0.95,
    disposition: "active",
    rationale: "Fixture model selected active",
    lifecycle: "stable",
    ...overrides,
  };
}

assert.equal(
  containsDeterministicSecretValue({
    evidence: {
      nested: {
        password: "do-not-persist",
      },
    },
  }),
  true,
);
assert.equal(
  containsDeterministicSecretValue({
    metadata: {
      tokenCount: 512,
      authorizationMode: "none",
    },
  }),
  false,
);
for (const structuredSecret of [
  { nested: { password: "ordinary-looking-value" } },
  { nested: { clientSecret: "ordinary-looking-value" } },
  { nested: { accessToken: "ordinary-looking-value" } },
  { nested: { password: 123456 } },
]) {
  assert.equal(
    containsDeterministicSecretValue(structuredSecret),
    true,
    `structured secret field must fail closed: ${JSON.stringify(structuredSecret)}`,
  );
  assert.equal(
    containsDeterministicSecretValue(JSON.stringify(structuredSecret)),
    true,
    "canonical JSON strings must retain key-aware secret detection",
  );
}
assert.equal(
  containsDeterministicSecretValue({
    nested: {
      clientSecretHint: "ordinary-looking-value",
      accessTokenCount: 2,
    },
  }),
  false,
  "non-secret descriptive field names must not trigger exact key rules",
);

const wideSecretScanValue = new Array(10_000).fill(null);
assert.equal(
  scanDeterministicSecretValue(wideSecretScanValue),
  "limit_exceeded",
  "wide values must exhaust the budget before children enter the scan stack",
);
assert.equal(
  containsDeterministicSecretValue(wideSecretScanValue),
  true,
  "secret scan budget exhaustion must fail closed",
);
let deepSecretScanValue = {};
for (let depth = 0; depth < 130; depth += 1) {
  deepSecretScanValue = { nested: deepSecretScanValue };
}
assert.equal(
  scanDeterministicSecretValue(deepSecretScanValue),
  "limit_exceeded",
  "deep values must return a controlled budget result without recursion",
);

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const engine = new AsukaMemoryEngine(ledger);
    const result = engine.ingestMemoryEvent(eventInput({
      metadata: {
        nested: {
          password: "do-not-persist",
        },
      },
    }));
    assert.equal(result.accepted, false);
    assert.equal(result.redacted, true);
    const stored = ledger.getEvent(result.receipt.eventId);
    assert.equal(stored.text, "[secret-bearing content omitted]");
    assert.deepEqual(stored.evidence, {});
    assert.deepEqual(stored.metadata, { secretRedacted: true });
    assert.doesNotMatch(JSON.stringify(stored), /do-not-persist/);

    assert.throws(
      () => ledger.appendEvent(eventInput({
        metadata: {
          nested: {
            api_key: "do-not-persist",
          },
        },
      })),
      /must be redacted before persistence/,
    );
  } finally {
    ledger.close();
  }
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const source = ledger.appendEvent(eventInput({
      occurredAt: 1_000,
      sourceMessageId: "validity-source",
    }));
    const invalid = ledger.applyClaimProposal(source.eventId, explicitProposal({
      validFrom: 2_000,
      validTo: 2_000,
    }));
    assert.equal(invalid.ignoredReason, "invalid_validity_interval");
    assert.equal(ledger.listClaims().length, 0);
  } finally {
    ledger.close();
  }
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const boundedSource = ledger.appendEvent(eventInput({
      occurredAt: 1_000,
      sourceMessageId: "bounded-source",
    }));
    const bounded = ledger.applyClaimProposal(boundedSource.eventId, explicitProposal({
      semanticKey: "fact:bounded",
      lifecycle: "bounded",
    }));
    const reflection = ledger.appendEvent(eventInput({
      actor: "system",
      kind: "reflection",
      text: "reflect bounded claim",
      occurredAt: 2_000,
      sourceMessageId: "bounded-reflection",
      metadata: {
        targetClaimIds: [bounded.claimId],
      },
    }));
    const expired = ledger.applyReflectionDecision(reflection.eventId, {
      claimId: bounded.claimId,
      action: "expire",
      confidence: 0.9,
      rationale: "The bounded condition has ended.",
    });
    assert.equal(expired.state, "superseded");
    assert.equal(ledger.getClaim(bounded.claimId).validTo, 2_000);

    const stableSource = ledger.appendEvent(eventInput({
      occurredAt: 3_000,
      sourceMessageId: "stable-source",
    }));
    const stable = ledger.applyClaimProposal(stableSource.eventId, explicitProposal({
      semanticKey: "fact:stable",
    }));
    const stableReflection = ledger.appendEvent(eventInput({
      actor: "system",
      kind: "reflection",
      text: "reflect stable claim",
      occurredAt: 4_000,
      sourceMessageId: "stable-reflection",
      metadata: {
        targetClaimIds: [stable.claimId],
      },
    }));
    const stableResult = ledger.applyReflectionDecision(stableReflection.eventId, {
      claimId: stable.claimId,
      action: "expire",
      confidence: 0.9,
      rationale: "No longer current.",
    });
    assert.equal(stableResult.ignoredReason, "stable_claim_does_not_require_reflection");
    assert.equal(ledger.getClaim(stable.claimId).state, "active");

    const unspecifiedSource = ledger.appendEvent(eventInput({
      occurredAt: 4_100,
      sourceMessageId: "unspecified-source",
    }));
    const unspecified = ledger.applyClaimProposal(unspecifiedSource.eventId, explicitProposal({
      semanticKey: "fact:unspecified",
      lifecycle: undefined,
    }));
    const unspecifiedReflection = ledger.appendEvent(eventInput({
      actor: "system",
      kind: "reflection",
      text: "reflect unspecified claim",
      occurredAt: 4_200,
      sourceMessageId: "unspecified-reflection",
      metadata: {
        targetClaimIds: [unspecified.claimId],
      },
    }));
    const unspecifiedResult = ledger.applyReflectionDecision(
      unspecifiedReflection.eventId,
      {
        claimId: unspecified.claimId,
        action: "expire",
        confidence: 0.9,
        rationale: "No temporal lifecycle was declared.",
      },
    );
    assert.equal(
      unspecifiedResult.ignoredReason,
      "explicit_reflection_requires_temporal_lifecycle",
    );
    assert.equal(ledger.getClaim(unspecified.claimId).state, "active");

    const correctionEvent = ledger.appendEvent(eventInput({
      kind: "memory_control",
      text: "correct the stable fact",
      occurredAt: 5_000,
      sourceMessageId: "stable-correction",
    }));
    const corrected = ledger.applyClaimProposal(correctionEvent.eventId, explicitProposal({
      semanticKey: "fact:stable",
      canonicalText: "The user corrected the stable fact",
      value: "corrected",
      authority: "user_correction",
      action: "revise",
      targetClaimId: stable.claimId,
    }));
    assert.equal(corrected.state, "active");
    assert.equal(ledger.getClaim(stable.claimId).state, "superseded");

    const deleteEvent = ledger.appendEvent(eventInput({
      kind: "memory_control",
      text: "delete the corrected fact",
      occurredAt: 6_000,
      sourceMessageId: "stable-delete",
    }));
    const deleted = ledger.applyClaimProposal(deleteEvent.eventId, explicitProposal({
      semanticKey: "fact:stable",
      authority: "user_correction",
      action: "delete",
      targetClaimId: corrected.claimId,
    }));
    assert.ok(deleted.deletedClaimIds.includes(corrected.claimId));
    assert.equal(ledger.getClaim(corrected.claimId), undefined);
  } finally {
    ledger.close();
  }
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const now = Date.now();
    const stableSource = ledger.appendEvent(eventInput({
      occurredAt: now - 10_000,
      sourceMessageId: "periodic-stable",
    }));
    const stable = ledger.applyClaimProposal(stableSource.eventId, explicitProposal({
      semanticKey: "periodic:stable",
    }));
    const boundedSource = ledger.appendEvent(eventInput({
      occurredAt: now - 10_000,
      sourceMessageId: "periodic-bounded",
    }));
    const bounded = ledger.applyClaimProposal(boundedSource.eventId, explicitProposal({
      semanticKey: "periodic:bounded",
      lifecycle: "bounded",
    }));
    const engine = new AsukaMemoryEngine(ledger, {
      autoReflection: true,
      reflectionIntervalMs: 1_000,
    });
    assert.equal(engine.enqueueDueReflections(Date.now() + 2_000), 1);
    const reflectionEvents = ledger.listEvents()
      .filter((event) => event.kind === "reflection");
    assert.equal(reflectionEvents.length, 1);
    assert.deepEqual(
      reflectionEvents[0].metadata.targetClaimIds,
      [bounded.claimId],
    );
    assert.ok(!reflectionEvents[0].metadata.targetClaimIds.includes(stable.claimId));
  } finally {
    ledger.close();
  }
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const baseSource = ledger.appendEvent(eventInput({
      sourceMessageId: "event-base",
    }));
    const base = ledger.applyClaimProposal(baseSource.eventId, explicitProposal({
      semanticKey: "event:shared",
    }));
    const stableSource = ledger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      sourceMessageId: "event-stable-candidate",
    }));
    const stable = ledger.applyClaimProposal(stableSource.eventId, {
      ...explicitProposal({
        semanticKey: "event:shared",
        epistemicStatus: "inferred",
        authority: "inferred",
        disposition: "candidate",
        rationale: "Assistant-origin candidate.",
        lifecycle: "stable",
      }),
    });
    const boundedSource = ledger.appendEvent(eventInput({
      actor: "asuka",
      kind: "assistant_reply",
      sourceMessageId: "event-bounded-candidate",
    }));
    const bounded = ledger.applyClaimProposal(boundedSource.eventId, {
      ...explicitProposal({
        semanticKey: "event:shared",
        epistemicStatus: "inferred",
        authority: "inferred",
        disposition: "candidate",
        rationale: "Assistant-origin candidate.",
        lifecycle: "bounded",
      }),
    });
    const trigger = ledger.getEvent(ledger.appendEvent(eventInput({
      sourceMessageId: "event-trigger",
    })).eventId);
    const engine = new AsukaMemoryEngine(ledger, {
      autoReflection: true,
      reflectionEventDelayMs: 0,
    });
    engine.enqueueEventTriggeredReflection(
      trigger,
      [ledger.getClaim(stable.claimId), ledger.getClaim(bounded.claimId)],
      [base.claimId],
    );
    const reflectionEvents = ledger.listEvents()
      .filter((event) => event.kind === "reflection");
    assert.equal(reflectionEvents.length, 1);
    assert.deepEqual(
      reflectionEvents[0].metadata.targetClaimIds,
      [bounded.claimId],
    );
    assert.ok(!reflectionEvents[0].metadata.targetClaimIds.includes(stable.claimId));
  } finally {
    ledger.close();
  }
}

console.log("asuka-memory-policy-regressions tests passed");
