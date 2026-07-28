import assert from "node:assert/strict";
import {
  parseMemoryJudgement,
  parseReflectionResult,
} from "../dist/src/asuka-memory-kernel/model-tasks.js";

const fixtureEvent = {
  eventId: "validity-event",
  accountId: "default",
  peerKind: "direct",
  peerId: "user-1",
  actor: "user",
  kind: "user_message",
  text: "fixture",
  identityId: "identity-1",
  visibility: "private",
  occurredAt: Date.now(),
  recordedAt: Date.now(),
  evidence: {},
  metadata: {},
  generatedFromClaimIds: [],
  dedupeKey: "validity-fixture",
};

function parseProposal(validity) {
  return parseMemoryJudgement(JSON.stringify({
    proposals: [{
      subjectId: "user",
      predicate: "residence",
      value: "Shanghai",
      canonicalText: "The user lives in Shanghai.",
      topLevelType: "fact",
      epistemicStatus: "explicit",
      confidence: 1,
      disposition: "active",
      rationale: "Fixture model selected active",
      ...validity,
    }],
  }), fixtureEvent).proposals[0];
}

function parseRevision(validity) {
  return parseReflectionResult(JSON.stringify({
    decisions: [{
      claimId: "claim-1",
      action: "revise",
      disposition: "active",
      confidence: 1,
      rationale: "The newer evidence changes the validity interval.",
      revision: {
        value: "Shanghai",
        canonicalText: "The user lives in Shanghai.",
        ...validity,
      },
    }],
  }), new Set(["claim-1"])).decisions[0].revision;
}

const validFrom = "2026-07-28T08:00:00.000Z";
const validTo = "2026-07-29T08:00:00.000Z";

for (const [label, parse] of [
  ["memory proposal", parseProposal],
  ["reflection revision", parseRevision],
]) {
  const omitted = parse({});
  assert.equal(omitted.validFrom, undefined, `${label} may omit validFrom`);
  assert.equal(omitted.validTo, undefined, `${label} may omit validTo`);

  const oneSided = parse({ validTo });
  assert.equal(oneSided.validFrom, undefined, `${label} may omit one interval endpoint`);
  assert.equal(oneSided.validTo, Date.parse(validTo));

  const complete = parse({ validFrom, validTo });
  assert.equal(complete.validFrom, Date.parse(validFrom));
  assert.equal(complete.validTo, Date.parse(validTo));

  for (const field of ["validFrom", "validTo"]) {
    for (const invalid of [null, "", "not-a-timestamp", false]) {
      assert.throws(
        () => parse({ [field]: invalid }),
        /invalid validity interval/,
        `${label} must reject present-but-invalid ${field}`,
      );
    }
  }

  for (const invalidEnd of [validFrom, "2026-07-27T08:00:00.000Z"]) {
    assert.throws(
      () => parse({ validFrom, validTo: invalidEnd }),
      /invalid validity interval/,
      `${label} must require validTo to be later than validFrom`,
    );
  }
}

console.log("asuka-memory-validity tests passed");
