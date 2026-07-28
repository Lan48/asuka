import assert from "node:assert/strict";
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
    text: "A durable but lexically unrelated memory",
    sourceMessageId: `message-${Math.random()}`,
    ...overrides,
  };
}

function addClaim(ledger) {
  const source = ledger.appendEvent(eventInput());
  const claim = ledger.applyClaimProposal(source.eventId, {
    semanticKey: "user.sensory.preference",
    subjectId: "user",
    predicate: "sensory.preference",
    value: "rain on stone",
    canonicalText: "The user likes the smell of rain on stone",
    topLevelType: "fact",
    epistemicStatus: "explicit",
    authority: "user_explicit",
    confidence: 1,
    disposition: "active",
    rationale: "Fixture model selected active",
    lifecycle: "stable",
  });
  return { source, claim };
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const { claim } = addClaim(ledger);
    let rerankSawClaim = false;
    const engine = new AsukaMemoryEngine(ledger, {
      requireEmbeddings: true,
      model: {
        async embed() {
          throw new Error("transient embedding outage");
        },
        async complete(request) {
          assert.equal(request.task, "rerank");
          rerankSawClaim = request.prompt.includes(claim.claimId);
          return JSON.stringify({
            claimIds: [claim.claimId],
            reason: "The model selected the paraphrased memory.",
          });
        },
      },
    });
    assert.equal(engine.rerankDeadlineMs, 1_500);
    const result = await engine.retrieveMemoryContext({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query: "Which atmosphere do I enjoy after a storm?",
    });
    assert.equal(rerankSawClaim, true);
    assert.deepEqual(result.claimIds, [claim.claimId]);
    assert.equal(result.usedFallback, false);
  } finally {
    ledger.close();
  }
}

{
  const ledger = new AsukaMemoryLedger(":memory:");
  try {
    const { claim } = addClaim(ledger);
    const engine = new AsukaMemoryEngine(ledger, {
      requireEmbeddings: true,
      rerankDeadlineMs: 20,
      model: {
        async embed() {
          await wait(80);
          return {
            model: "slow-fixture",
            dimensions: 2,
            vectors: [[1, 0]],
          };
        },
        async complete(request) {
          assert.equal(request.task, "rerank");
          return JSON.stringify({
            claimIds: [claim.claimId],
            reason: "Background rerank selected the memory.",
          });
        },
      },
    });
    const query = "Which atmosphere do I enjoy after a storm?";
    const foreground = await engine.retrieveMemoryContext({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
    });
    assert.deepEqual(
      foreground.claimIds,
      [],
      "zero-signal broad candidates must not leak into the deadline fallback",
    );
    assert.ok(foreground.elapsedMs < 100);

    await wait(30);
    const cached = engine.retrieveMemoryContextLocal({
      accountId: "default",
      peerKind: "direct",
      peerId: "user-1",
      query,
    });
    assert.deepEqual(cached.claimIds, [claim.claimId]);
    assert.equal(cached.usedFallback, false);
  } finally {
    ledger.close();
  }
}

console.log("asuka-memory-retrieval-resilience tests passed");
