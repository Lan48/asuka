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

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function escapeTable(value: string): string {
  return value
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

function extractBlock(content: string, startMarker: string, endMarker: string): string {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end < start) return "";
  return content.slice(start + startMarker.length, end).trim();
}

function manualBlocks(current: string): { notes: string; overrides: string } {
  return {
    notes: extractBlock(current, NOTES_START, NOTES_END),
    overrides: extractBlock(current, OVERRIDES_START, OVERRIDES_END),
  };
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
      `- Validity: ${claim.validFrom ? new Date(claim.validFrom).toISOString() : "open"} to ${claim.validTo ? new Date(claim.validTo).toISOString() : "open"}`,
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
  currentContent: string,
  updatedAt: number,
): string {
  const blocks = manualBlocks(currentContent);
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
    `# ${topic}`,
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
    NOTES_START,
    blocks.notes,
    NOTES_END,
    "",
    "## Corrections / Overrides",
    "",
    OVERRIDES_START,
    blocks.overrides,
    OVERRIDES_END,
    "",
  ].join("\n");
}

function renderIndex(
  title: string,
  pages: Array<{ topic: string; relativePath: string; active: number; history: number }>,
  currentContent: string,
  updatedAt: number,
): string {
  const blocks = manualBlocks(currentContent);
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
    `# ${title}`,
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
    NOTES_START,
    blocks.notes,
    NOTES_END,
    "",
    "## Corrections / Overrides",
    "",
    OVERRIDES_START,
    blocks.overrides,
    OVERRIDES_END,
    "",
  ].join("\n");
}

function generatedMarkdownFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(GENERATED_MARKER));
}

export function projectMemoryWiki(
  snapshot: MemoryProjectionSnapshot,
  options: WikiProjectionOptions,
): WikiProjectionResult {
  const memoryRoot = path.resolve(options.memoryRoot);
  const entitiesDirectory = path.join(memoryRoot, "entities");
  fs.mkdirSync(entitiesDirectory, { recursive: true });
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
  for (const [topic, topicClaims] of grouped) {
    if (topicClaims.length === 0) continue;
    const relativePath = path.posix.join("entities", `${safeSlug(topic)}.md`);
    const file = path.join(memoryRoot, ...relativePath.split("/"));
    expectedEntityFiles.add(path.resolve(file));
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const topicUpdatedAt = topicClaims.reduce(
      (latest, claim) => Math.max(latest, claim.updatedAt),
      projectionUpdatedAt,
    );
    if (atomicWrite(
      file,
      renderTopicPage(
        topic,
        topicClaims,
        snapshot.claimEvidence,
        eventsById,
        current,
        topicUpdatedAt,
      ),
    )) {
      changedFiles.push(file);
    }
    pages.push({
      topic,
      relativePath,
      active: topicClaims.filter((claim) => claim.state === "active").length,
      history: topicClaims.filter((claim) => claim.state !== "active").length,
    });
  }

  for (const file of generatedMarkdownFiles(entitiesDirectory)) {
    if (expectedEntityFiles.has(path.resolve(file))) continue;
    const current = fs.readFileSync(file, "utf8");
    const blocks = manualBlocks(current);
    if (blocks.notes || blocks.overrides) continue;
    fs.unlinkSync(file);
    removedFiles.push(file);
  }

  const indexFile = path.join(memoryRoot, "index.md");
  const currentIndex = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : "";
  if (atomicWrite(
    indexFile,
    renderIndex(options.title ?? "Asuka Memory", pages, currentIndex, projectionUpdatedAt),
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
  return files;
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
  let imported = 0;
  let unchanged = 0;
  const eventIds: string[] = [];
  for (const file of listWikiMarkdownFiles(options.memoryRoot)) {
    const content = fs.readFileSync(file, "utf8");
    const overrides = extractBlock(content, OVERRIDES_START, OVERRIDES_END);
    if (!overrides) continue;
    const input = overrideEventInput(file, overrides, options);
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
