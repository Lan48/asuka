#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [pluginRoot, databasePath] = process.argv.slice(2);
if (!pluginRoot || !databasePath) {
  throw new Error("usage: node verify-ledger.mjs <qqbot-plugin-root> <database>");
}
if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
  throw new Error(`ledger database does not exist: ${databasePath}`);
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
  process.stdout.write(`${JSON.stringify({
    ok: true,
    integrity,
    stats,
    rejudgementGate,
  })}\n`);
} finally {
  ledger.close();
}
