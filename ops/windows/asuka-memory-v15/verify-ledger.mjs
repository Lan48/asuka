#!/usr/bin/env node

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const rawArguments = process.argv.slice(2);
const unknownSwitch = rawArguments.find((value) =>
  value.startsWith("--") && value !== "--outbox-only"
);
if (unknownSwitch) throw new Error(`unknown option: ${unknownSwitch}`);
const outboxOnly = rawArguments.includes("--outbox-only");
const [
  pluginRoot,
  databasePath,
  migrationReportPath,
  expectedCohortSha256,
  ...extraArguments
] = rawArguments.filter((value) => value !== "--outbox-only");
if (!pluginRoot || !databasePath) {
  throw new Error(
    "usage: node verify-ledger.mjs <qqbot-plugin-root> <database> [migration-report] [cohort-sha256] [--outbox-only]",
  );
}
if (extraArguments.length > 0) throw new Error("too many arguments");
if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
  throw new Error(`ledger database does not exist: ${databasePath}`);
}

function requireCleanProjectionOutbox(status) {
  const pendingCount = status?.pendingCount;
  const failedCount = status?.failedCount;
  const degraded = status?.degraded;
  if (
    !Number.isSafeInteger(pendingCount)
    || pendingCount < 0
    || !Number.isSafeInteger(failedCount)
    || failedCount < 0
    || failedCount > pendingCount
    || typeof degraded !== "boolean"
  ) {
    throw new Error("legacy projection outbox status is malformed");
  }
  if (pendingCount !== 0 || failedCount !== 0 || degraded) {
    throw new Error(
      `legacy projection outbox is not drained: pending=${pendingCount} failed=${failedCount} degraded=${degraded}`,
    );
  }
  return { degraded, pendingCount, failedCount };
}

function readProjectionOutboxOnly() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT
        COUNT(*) AS pending_count,
        SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) AS failed_count
      FROM legacy_projection_outbox
    `).get();
    const pendingCount = Number(row?.pending_count);
    const failedCount = Number(row?.failed_count ?? 0);
    return requireCleanProjectionOutbox({
      degraded: failedCount > 0,
      pendingCount,
      failedCount,
    });
  } finally {
    database.close();
  }
}

if (outboxOnly) {
  const projectionOutbox = readProjectionOutboxOnly();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectionOutbox,
  })}\n`);
  process.exit(0);
}

const ledgerModule = await import(pathToFileURL(
  path.join(pluginRoot, "dist", "src", "asuka-memory-kernel", "ledger.js"),
).href);
const engineModule = await import(pathToFileURL(
  path.join(pluginRoot, "dist", "src", "asuka-memory-kernel", "engine.js"),
).href);
const migrationModule = await import(pathToFileURL(
  path.join(pluginRoot, "dist", "src", "asuka-memory-kernel", "legacy-migration.js"),
).href);
const ledger = new ledgerModule.AsukaMemoryLedger(databasePath);
try {
  const integrity = ledger.integrityCheck();
  if (!integrity.ok) {
    throw new Error(`ledger integrity failed: ${JSON.stringify(integrity)}`);
  }
  const stats = ledger.getStats();
  if ((stats.memory_events ?? 0) < 1) {
    throw new Error("ledger contains no migrated memory events");
  }
  const engine = new engineModule.AsukaMemoryEngine(ledger);
  const rejudgementGate = migrationModule.getLegacyRejudgementGate(engine);
  const consolidationComplete = (
    rejudgementGate.consolidation.status === "completed"
    || rejudgementGate.consolidation.status === "not_required"
  );
  const missingRequiredConsolidation = (
    rejudgementGate.extractions.withClaims > 0
    && rejudgementGate.consolidation.status !== "completed"
  );
  const migrationComplete = (
    rejudgementGate.passed
    && rejudgementGate.jobs.pending === 0
    && rejudgementGate.jobs.running === 0
    && rejudgementGate.jobs.failed === 0
    && rejudgementGate.claims.provisionalOpen === 0
    && rejudgementGate.extractions.completed === rejudgementGate.events.eligible
    && consolidationComplete
    && !missingRequiredConsolidation
    && rejudgementGate.coverage.coveredSourceEvents
      === rejudgementGate.coverage.sourceEvents
  );
  if (!migrationComplete) {
    throw new Error(
      `legacy rejudgement gate failed: ${JSON.stringify(rejudgementGate.blockers)}`,
    );
  }
  let cohort;
  if (migrationReportPath) {
    if (
      !fs.existsSync(migrationReportPath)
      || !fs.statSync(migrationReportPath).isFile()
    ) {
      throw new Error(`migration report does not exist: ${migrationReportPath}`);
    }
    const report = JSON.parse(fs.readFileSync(migrationReportPath, "utf8"));
    const sourceMap = report?.migration?.sourceMap;
    const discoveredRecords = Number(report?.migration?.discoveredRecords);
    if (
      !Array.isArray(sourceMap)
      || !Number.isInteger(discoveredRecords)
      || sourceMap.length !== discoveredRecords
    ) {
      throw new Error("migration report has invalid source cohort accounting");
    }
    const records = sourceMap.map((entry) => {
      const eventId = String(entry?.eventId ?? "");
      const legacyContentHash = String(entry?.legacyContentHash ?? "").toLowerCase();
      if (
        !eventId
        || !/^[a-f0-9]{64}$/.test(legacyContentHash)
        || entry?.status === "skipped"
      ) {
        throw new Error("migration source cohort contains an incomplete record");
      }
      const event = ledger.getEvent(eventId);
      if (!event) throw new Error(`migrated source event is missing: ${eventId}`);
      if (
        String(event.metadata?.legacyContentHash ?? "").toLowerCase()
        !== legacyContentHash
      ) {
        throw new Error(`migrated source hash mismatch: ${eventId}`);
      }
      return [
        String(entry.sourceKind ?? ""),
        String(entry.sourceRecordId ?? entry.legacyId ?? ""),
        legacyContentHash,
        eventId,
      ].join("\t");
    }).sort();
    const sha256 = createHash("sha256").update(records.join("\n")).digest("hex");
    if (
      expectedCohortSha256
      && sha256 !== String(expectedCohortSha256).toLowerCase()
    ) {
      throw new Error("live migration cohort does not match the activated cohort hash");
    }
    cohort = {
      records: records.length,
      uniqueEvents: new Set(
        sourceMap.map((entry) => String(entry.eventId ?? "")),
      ).size,
      sha256,
    };
  }
  if (typeof ledger.getLegacyProjectionStatus !== "function") {
    throw new Error("ledger cannot report legacy projection outbox status");
  }
  const projectionOutbox = requireCleanProjectionOutbox(
    ledger.getLegacyProjectionStatus(),
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    integrity,
    stats,
    rejudgementGate,
    projectionOutbox,
    ...(cohort ? { cohort } : {}),
  })}\n`);
} finally {
  ledger.close();
}
