import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AsukaMemoryEngine } from "./engine.js";
import type {
  MemoryClaim,
  MemoryEventInput,
  MemoryProjectionClaimEvidence,
  MemoryProjectionEventSummary,
  MemoryProjectionSnapshot,
} from "./types.js";

const GENERATED_MARKER = "<!-- ASUKA_MEMORY_V15_GENERATED -->";
const GENERATED_START = "<!-- ASUKA_MEMORY_GENERATED_START -->";
const GENERATED_END = "<!-- ASUKA_MEMORY_GENERATED_END -->";
const NOTES_START = "<!-- ASUKA_MEMORY_NOTES_START -->";
const NOTES_END = "<!-- ASUKA_MEMORY_NOTES_END -->";
const OVERRIDES_START = "<!-- ASUKA_MEMORY_OVERRIDES_START -->";
const OVERRIDES_END = "<!-- ASUKA_MEMORY_OVERRIDES_END -->";
const PENDING_FILE = ".asuka-memory-pending";

interface WikiProjectionOptions {
  memoryRoot: string;
  title?: string;
}

interface WikiProjectionResult {
  changedFiles: string[];
  removedFiles: string[];
  pageCount: number;
  claimCount: number;
}

interface WikiOverrideImportOptions {
  memoryRoot: string;
  accountId: string;
  peerId: string;
  identityId?: string;
}

interface ManualBlocks {
  notes: string;
  overrides: string;
}

const EMPTY_MANUAL_BLOCKS: ManualBlocks = {
  notes: "\n\n",
  overrides: "\n\n",
};

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function escapeTable(value: string): string {
  return value
    .replace(/\]/g, "\\]")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function inlineText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .trim();
}

function safeSlug(value: string): string {
  const readable = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = hashText(value).slice(0, 10);
  return `${readable || "memory-topic"}-${suffix}`;
}

function atomicWrite(file: string, content: string): boolean {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
  return true;
}

function markerLines(content: string): Array<{ value: string; start: number }> {
  const lines: Array<{ value: string; start: number }> = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline;
    const valueEnd = end > start && content[end - 1] === "\r" ? end - 1 : end;
    lines.push({ value: content.slice(start, valueEnd), start });
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

function parseManualBlocks(content: string, file: string): ManualBlocks {
  const markers = [NOTES_START, NOTES_END, OVERRIDES_START, OVERRIDES_END];
  const positions = new Map<string, number[]>(
    markers.map((marker) => [marker, []]),
  );
  for (const line of markerLines(content)) {
    const marker = markers.find((candidate) => line.value === candidate);
    if (marker) {
      positions.get(marker)!.push(line.start);
      continue;
    }
    if (/<!--\s*ASUKA_MEMORY_(?:NOTES|OVERRIDES)/.test(line.value)) {
      throw new Error(`Invalid manual marker in ${file}: partial or non-standalone marker`);
    }
  }
  for (const marker of markers) {
    if (positions.get(marker)!.length !== 1) {
      throw new Error(`Invalid manual marker in ${file}: expected exactly one ${marker}`);
    }
  }
  const notesStart = positions.get(NOTES_START)![0];
  const notesEnd = positions.get(NOTES_END)![0];
  const overridesStart = positions.get(OVERRIDES_START)![0];
  const overridesEnd = positions.get(OVERRIDES_END)![0];
  if (!(notesStart < notesEnd && notesEnd < overridesStart && overridesStart < overridesEnd)) {
    throw new Error(`Invalid manual marker order in ${file}`);
  }
  return {
    notes: content.slice(notesStart + NOTES_START.length, notesEnd),
    overrides: content.slice(overridesStart + OVERRIDES_START.length, overridesEnd),
  };
}

function hasStandaloneMarker(content: string, marker: string): boolean {
  return markerLines(content).some((line) => line.value === marker);
}

function readExistingWikiPage(file: string): ManualBlocks {
  const content = fs.readFileSync(file, "utf8");
  if (!hasStandaloneMarker(content, GENERATED_MARKER)) {
    throw new Error(`Invalid manual marker ownership in ${file}: generated marker is missing`);
  }
  return parseManualBlocks(content, file);
}

function topicKey(claim: MemoryClaim): string {
  return claim.topic?.trim()
    || claim.predicate.split(".").slice(0, 2).join(".")
    || claim.subjectId;
}

function claimStatus(claim: MemoryClaim): string {
  if (claim.state === "active") return "current";
  return claim.state;
}

function renderEvidence(
  claim: MemoryClaim,
  stance: MemoryProjectionClaimEvidence["stance"],
  claimEvidence: MemoryProjectionClaimEvidence[],
  eventsById: ReadonlyMap<string, MemoryProjectionEventSummary>,
): string {
  const rows = claimEvidence
    .filter((item) => item.claimId === claim.claimId && item.stance === stance)
    .map((item) => eventsById.get(item.eventId))
    .filter((event): event is MemoryProjectionEventSummary =>
      event !== undefined
      && event.identityId === claim.identityId
      && event.visibility === claim.visibility
    )
    .map((event) =>
      `- ${new Date(event.occurredAt).toISOString()} | Source: ${inlineText(event.source)} | ${event.kind}/${event.actor} | ${inlineText(event.excerpt)}`
    );
  return rows.length > 0 ? rows.join("\n") : "- None";
}

function renderClaimEntries(
  claims: MemoryClaim[],
  claimEvidence: MemoryProjectionClaimEvidence[],
  eventsById: ReadonlyMap<string, MemoryProjectionEventSummary>,
): string {
  return claims
    .sort((a, b) => b.updatedAt - a.updatedAt || a.claimId.localeCompare(b.claimId))
    .map((claim) => [
      `### ${inlineText(claim.canonicalText)}`,
      "",
      `- Claim: ${claim.claimId}`,
      `- Status: ${claimStatus(claim)}`,
      `- Confidence: ${claim.confidence}`,
      `- Epistemic / type: ${claim.epistemicStatus} / ${claim.topLevelType}`,
      `- Predicate / value: ${inlineText(claim.predicate)} / ${inlineText(valueText(claim.value))}`,
      `- Validity: ${claim.validFrom !== undefined ? new Date(claim.validFrom).toISOString() : "open"} to ${claim.validTo !== undefined ? new Date(claim.validTo).toISOString() : "open"}`,
      `- rootClaimId: ${claim.rootClaimId}`,
      `- supersedesClaimId: ${claim.supersedesClaimId ?? "none"}`,
      `- Source event: ${claim.sourceEventId}`,
      "",
      "#### Supporting evidence",
      "",
      renderEvidence(claim, "supports", claimEvidence, eventsById),
      "",
      "#### Opposing evidence",
      "",
      renderEvidence(claim, "opposes", claimEvidence, eventsById),
    ].join("\n"))
    .join("\n\n");
}

function renderTopicPage(
  topic: string,
  claims: MemoryClaim[],
  claimEvidence: MemoryProjectionClaimEvidence[],
  eventsById: ReadonlyMap<string, MemoryProjectionEventSummary>,
  blocks: ManualBlocks,
  updatedAt: number,
): string {
  const active = claims.filter((claim) => claim.state === "active");
  const history = claims.filter((claim) => claim.state !== "active");
  return [
    "---",
    `id: ${yamlScalar(`asuka-memory-topic:${safeSlug(topic)}`)}`,
    `title: ${yamlScalar(topic)}`,
    "type: memory-topic",
    `updated: ${yamlScalar(new Date(updatedAt).toISOString())}`,
    "generated: true",
    "tags:",
    "  - asuka/memory",
    "---",
    "",
    GENERATED_MARKER,
    "",
    `# ${inlineText(topic)}`,
    "",
    GENERATED_START,
    "",
    "## Current",
    "",
    renderClaimEntries(active, claimEvidence, eventsById),
    "",
    "## History",
    "",
    renderClaimEntries(history, claimEvidence, eventsById),
    "",
    GENERATED_END,
    "",
    "## Notes",
    "",
    `${NOTES_START}${blocks.notes}${NOTES_END}`,
    "",
    "## Corrections / Overrides",
    "",
    `${OVERRIDES_START}${blocks.overrides}${OVERRIDES_END}`,
    "",
  ].join("\n");
}

function renderIndex(
  title: string,
  pages: Array<{ topic: string; relativePath: string; active: number; history: number }>,
  blocks: ManualBlocks,
  updatedAt: number,
): string {
  const rows = pages
    .sort((a, b) => a.topic.localeCompare(b.topic))
    .map((page) =>
      `| [[${page.relativePath.replace(/\.md$/i, "")}|${escapeTable(page.topic)}]] | ${page.active} | ${page.history} |`,
    )
    .join("\n");
  return [
    "---",
    "id: asuka-memory-index",
    `title: ${yamlScalar(title)}`,
    "type: memory-index",
    `updated: ${yamlScalar(new Date(updatedAt).toISOString())}`,
    "generated: true",
    "tags:",
    "  - asuka/memory",
    "---",
    "",
    GENERATED_MARKER,
    "",
    `# ${inlineText(title)}`,
    "",
    GENERATED_START,
    "",
    "| Topic | Current | History |",
    "| --- | ---: | ---: |",
    rows,
    "",
    GENERATED_END,
    "",
    "## Notes",
    "",
    `${NOTES_START}${blocks.notes}${NOTES_END}`,
    "",
    "## Corrections / Overrides",
    "",
    `${OVERRIDES_START}${blocks.overrides}${OVERRIDES_END}`,
    "",
  ].join("\n");
}

function generatedMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => hasStandaloneMarker(fs.readFileSync(file, "utf8"), GENERATED_MARKER));
}

export function projectMemoryWiki(
  snapshot: MemoryProjectionSnapshot,
  options: WikiProjectionOptions,
): WikiProjectionResult {
  const memoryRoot = path.resolve(options.memoryRoot);
  const entitiesDirectory = path.join(memoryRoot, "entities");
  const claims = [...snapshot.claims, ...snapshot.history];
  const projectionUpdatedAt = claims.reduce(
    (latest, claim) => Math.max(latest, claim.updatedAt),
    0,
  ) || snapshot.generatedAt;
  const grouped = new Map<string, MemoryClaim[]>();
  const eventsById = new Map(
    snapshot.eventSummaries.map((event) => [event.eventId, event]),
  );
  for (const claim of claims) {
    const topic = topicKey(claim);
    const existing = grouped.get(topic) ?? [];
    existing.push(claim);
    grouped.set(topic, existing);
  }

  const changedFiles: string[] = [];
  const removedFiles: string[] = [];
  const expectedEntityFiles = new Set<string>();
  const pages: Array<{ topic: string; relativePath: string; active: number; history: number }> = [];
  const topicPages: Array<{
    topic: string;
    claims: MemoryClaim[];
    file: string;
    updatedAt: number;
    blocks: ManualBlocks;
  }> = [];
  for (const [topic, topicClaims] of grouped) {
    if (topicClaims.length === 0) continue;
    const relativePath = path.posix.join("entities", `${safeSlug(topic)}.md`);
    const file = path.join(memoryRoot, ...relativePath.split("/"));
    expectedEntityFiles.add(path.resolve(file));
    const topicUpdatedAt = topicClaims.reduce(
      (latest, claim) => Math.max(latest, claim.updatedAt),
      0,
    );
    topicPages.push({
      topic,
      claims: topicClaims,
      file,
      updatedAt: topicUpdatedAt || projectionUpdatedAt,
      blocks: fs.existsSync(file)
        ? readExistingWikiPage(file)
        : EMPTY_MANUAL_BLOCKS,
    });
    pages.push({
      topic,
      relativePath,
      active: topicClaims.filter((claim) => claim.state === "active").length,
      history: topicClaims.filter((claim) => claim.state !== "active").length,
    });
  }

  const stalePages = generatedMarkdownFiles(entitiesDirectory)
    .filter((file) => !expectedEntityFiles.has(path.resolve(file)))
    .map((file) => ({ file, blocks: readExistingWikiPage(file) }));
  const indexFile = path.join(memoryRoot, "index.md");
  const indexBlocks = fs.existsSync(indexFile)
    ? readExistingWikiPage(indexFile)
    : EMPTY_MANUAL_BLOCKS;
  const topicWrites = topicPages.map((page) => ({
    file: page.file,
    content: renderTopicPage(
      page.topic,
      page.claims,
      snapshot.claimEvidence,
      eventsById,
      page.blocks,
      page.updatedAt,
    ),
  }));
  const indexContent = renderIndex(
    options.title ?? "Asuka Memory",
    pages,
    indexBlocks,
    projectionUpdatedAt,
  );

  fs.mkdirSync(entitiesDirectory, { recursive: true });
  for (const write of topicWrites) {
    if (atomicWrite(write.file, write.content)) changedFiles.push(write.file);
  }
  for (const stale of stalePages) {
    if (stale.blocks.notes.trim() || stale.blocks.overrides.trim()) continue;
    fs.unlinkSync(stale.file);
    removedFiles.push(stale.file);
  }
  if (atomicWrite(
    indexFile,
    indexContent,
  )) {
    changedFiles.push(indexFile);
  }

  if (changedFiles.length > 0 || removedFiles.length > 0) {
    const pendingPath = path.join(memoryRoot, PENDING_FILE);
    atomicWrite(pendingPath, `${new Date(snapshot.generatedAt).toISOString()}\n`);
  }
  return {
    changedFiles,
    removedFiles,
    pageCount: pages.length,
    claimCount: claims.length,
  };
}

function listWikiMarkdownFiles(memoryRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
    }
  };
  visit(memoryRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function overrideEventInput(
  file: string,
  content: string,
  options: WikiOverrideImportOptions,
): MemoryEventInput {
  const relativePath = path.relative(options.memoryRoot, file).split(path.sep).join("/");
  const contentHash = hashText(content);
  return {
    accountId: options.accountId,
    peerKind: "direct",
    peerId: options.peerId,
    identityId: options.identityId,
    actor: "user",
    kind: "human_override",
    text: content,
    sourceId: `obsidian:${relativePath}`,
    dedupeKey: `obsidian-override:${relativePath}:${contentHash}`,
    evidence: {
      excerpt: content.slice(0, 2_000),
      sourcePath: relativePath,
      mediaType: "text",
    },
    metadata: {
      source: "obsidian_override",
      relativePath,
      contentHash,
    },
  };
}

export function importWikiOverrides(
  engine: AsukaMemoryEngine,
  options: WikiOverrideImportOptions,
): {
  imported: number;
  unchanged: number;
  eventIds: string[];
} {
  const pages = listWikiMarkdownFiles(options.memoryRoot)
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      if (
        !hasStandaloneMarker(content, GENERATED_MARKER)
        && !/<!--\s*ASUKA_MEMORY_(?:NOTES|OVERRIDES)/.test(content)
      ) {
        return undefined;
      }
      return {
        file,
        overrides: parseManualBlocks(content, file).overrides.trim(),
      };
    })
    .filter((page): page is { file: string; overrides: string } => page !== undefined);
  let imported = 0;
  let unchanged = 0;
  const eventIds: string[] = [];
  for (const page of pages) {
    if (!page.overrides) continue;
    const input = overrideEventInput(page.file, page.overrides, options);
    const result = engine.applyHumanOverride(input);
    if (!result.receipt) continue;
    eventIds.push(result.receipt.eventId);
    if (result.receipt.inserted) imported += 1;
    else unchanged += 1;
  }
  return { imported, unchanged, eventIds };
}

export const memoryWikiMarkers = {
  generated: GENERATED_MARKER,
  generatedStart: GENERATED_START,
  generatedEnd: GENERATED_END,
  notesStart: NOTES_START,
  notesEnd: NOTES_END,
  overridesStart: OVERRIDES_START,
  overridesEnd: OVERRIDES_END,
};
