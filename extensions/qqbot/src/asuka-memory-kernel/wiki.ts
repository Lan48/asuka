import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AsukaMemoryEngine } from "./engine.js";
import type {
  MemoryClaim,
  MemoryEventInput,
  MemoryPeerKind,
  MemoryProjectionClaimEvidence,
  MemoryProjectionEventSummary,
  MemoryProjectionSnapshot,
  MemoryVisibility,
} from "./types.js";

const GENERATED_MARKER = "<!-- ASUKA_MEMORY_V15_GENERATED -->";
const GENERATED_START = "<!-- ASUKA_MEMORY_GENERATED_START -->";
const GENERATED_END = "<!-- ASUKA_MEMORY_GENERATED_END -->";
const NOTES_START = "<!-- ASUKA_MEMORY_NOTES_START -->";
const NOTES_END = "<!-- ASUKA_MEMORY_NOTES_END -->";
const OVERRIDES_START = "<!-- ASUKA_MEMORY_OVERRIDES_START -->";
const OVERRIDES_END = "<!-- ASUKA_MEMORY_OVERRIDES_END -->";
const PENDING_FILE = ".asuka-memory-pending";
const SCOPE_FILE = ".asuka-memory-scope.json";
const SCOPE_MARKER_PREFIX = "<!-- ASUKA_MEMORY_SCOPE ";

interface WikiProjectionOptions {
  memoryRoot: string;
  title?: string;
  scope: WikiMemoryScope;
  resolveEventScope(eventId: string): WikiMemoryScope | undefined;
}

interface WikiProjectionResult {
  changedFiles: string[];
  removedFiles: string[];
  pageCount: number;
  claimCount: number;
}

interface WikiOverrideImportOptions {
  memoryRoot: string;
  expectedScope?: WikiMemoryScope;
}

export interface WikiMemoryScope {
  identityId: string;
  visibility: MemoryVisibility;
  accountId: string;
  peerKind: MemoryPeerKind;
  peerId: string;
}

interface ManualBlocks {
  notes: string;
  overrides: string;
}

const EMPTY_MANUAL_BLOCKS: ManualBlocks = {
  notes: "\n\n",
  overrides: "\n\n",
};

function normalizeWikiScope(scope: WikiMemoryScope): WikiMemoryScope {
  const normalized: WikiMemoryScope = {
    identityId: scope.identityId.trim(),
    visibility: scope.visibility,
    accountId: scope.accountId.trim(),
    peerKind: scope.peerKind,
    peerId: scope.peerId.trim(),
  };
  if (
    !normalized.identityId
    || !normalized.accountId
    || !normalized.peerId
    || !["private", "public"].includes(normalized.visibility)
    || !["direct", "group"].includes(normalized.peerKind)
  ) {
    throw new Error("Invalid Memory Wiki scope binding");
  }
  if (normalized.peerKind === "group" && normalized.visibility === "private") {
    throw new Error("Invalid Memory Wiki scope binding: group scope cannot be private");
  }
  return normalized;
}

function scopeContent(scope: WikiMemoryScope): string {
  return `${JSON.stringify(normalizeWikiScope(scope), null, 2)}\n`;
}

function sameScope(left: WikiMemoryScope, right: WikiMemoryScope): boolean {
  return scopeContent(left) === scopeContent(right);
}

function scopeMarker(scope: WikiMemoryScope): string {
  return `${SCOPE_MARKER_PREFIX}${hashText(scopeContent(scope))} -->`;
}

function scopeFrontmatter(scope: WikiMemoryScope): string[] {
  return [
    `scope_identity_id: ${yamlScalar(scope.identityId)}`,
    `scope_visibility: ${yamlScalar(scope.visibility)}`,
    `scope_account_id: ${yamlScalar(scope.accountId)}`,
    `scope_peer_kind: ${yamlScalar(scope.peerKind)}`,
    `scope_peer_id: ${yamlScalar(scope.peerId)}`,
    "editable: true",
  ];
}

function readScopeBinding(memoryRoot: string): WikiMemoryScope | undefined {
  const file = path.join(memoryRoot, SCOPE_FILE);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Invalid Memory Wiki scope binding in ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Memory Wiki scope binding in ${file}`);
  }
  try {
    return normalizeWikiScope(parsed as WikiMemoryScope);
  } catch {
    throw new Error(`Invalid Memory Wiki scope binding in ${file}`);
  }
}

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

function assertPageScope(
  content: string,
  file: string,
  scope: WikiMemoryScope,
  allowLegacyUnbound: boolean,
): void {
  const expected = scopeMarker(scope);
  const markers = markerLines(content)
    .map((line) => line.value)
    .filter((line) => /<!--\s*ASUKA_MEMORY_SCOPE/.test(line));
  if (allowLegacyUnbound && markers.length === 0) return;
  if (markers.length !== 1 || markers[0] !== expected) {
    throw new Error(`Invalid Memory Wiki scope binding in ${file}`);
  }
}

function readExistingWikiPage(
  file: string,
  scope: WikiMemoryScope,
  allowLegacyUnbound: boolean,
): ManualBlocks {
  const content = fs.readFileSync(file, "utf8");
  if (!hasStandaloneMarker(content, GENERATED_MARKER)) {
    throw new Error(`Invalid manual marker ownership in ${file}: generated marker is missing`);
  }
  assertPageScope(content, file, scope, allowLegacyUnbound);
  return parseManualBlocks(content, file);
}

function readPageTitle(file: string): string {
  const titleLine = markerLines(fs.readFileSync(file, "utf8"))
    .map((line) => line.value)
    .find((line) => line.startsWith("title: "));
  if (titleLine) {
    try {
      const parsed = JSON.parse(titleLine.slice("title: ".length));
      if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    } catch {
      // Fall back to the stable filename when legacy frontmatter is malformed.
    }
  }
  return path.basename(file, path.extname(file));
}

function readPageUpdatedAt(file: string): number | undefined {
  const updatedLine = markerLines(fs.readFileSync(file, "utf8"))
    .map((line) => line.value)
    .find((line) => line.startsWith("updated: "));
  if (!updatedLine) return undefined;
  try {
    const parsed = JSON.parse(updatedLine.slice("updated: ".length));
    if (typeof parsed !== "string") return undefined;
    const timestamp = Date.parse(parsed);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
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
  scope: WikiMemoryScope,
): string {
  const active = claims.filter((claim) => claim.state === "active");
  const history = claims.filter((claim) => claim.state !== "active");
  return [
    "---",
    `id: ${yamlScalar(`asuka-memory-topic:${hashText(scopeContent(scope)).slice(0, 12)}:${safeSlug(topic)}`)}`,
    `title: ${yamlScalar(topic)}`,
    "type: memory-topic",
    `updated: ${yamlScalar(new Date(updatedAt).toISOString())}`,
    "generated: true",
    ...scopeFrontmatter(scope),
    "tags:",
    "  - asuka/memory",
    "---",
    "",
    GENERATED_MARKER,
    scopeMarker(scope),
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
  scope: WikiMemoryScope,
): string {
  const rows = pages
    .sort((a, b) => a.topic.localeCompare(b.topic))
    .map((page) =>
      `| [[${page.relativePath.replace(/\.md$/i, "")}|${escapeTable(page.topic)}]] | ${page.active} | ${page.history} |`,
    )
    .join("\n");
  return [
    "---",
    `id: ${yamlScalar(`asuka-memory-index:${hashText(scopeContent(scope)).slice(0, 12)}`)}`,
    `title: ${yamlScalar(title)}`,
    "type: memory-index",
    `updated: ${yamlScalar(new Date(updatedAt).toISOString())}`,
    "generated: true",
    ...scopeFrontmatter(scope),
    "tags:",
    "  - asuka/memory",
    "---",
    "",
    GENERATED_MARKER,
    scopeMarker(scope),
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
  const scope = normalizeWikiScope(options.scope);
  const existingBinding = readScopeBinding(memoryRoot);
  if (existingBinding && !sameScope(existingBinding, scope)) {
    throw new Error(`Memory Wiki scope binding mismatch in ${memoryRoot}`);
  }
  const allowLegacyUnbound = existingBinding === undefined;
  const entitiesDirectory = path.join(memoryRoot, "entities");
  const indexFile = path.join(memoryRoot, "index.md");
  const eventScopeMatches = new Map<string, boolean>();
  const eventMatchesScope = (eventId: string): boolean => {
    const cached = eventScopeMatches.get(eventId);
    if (cached !== undefined) return cached;
    const resolved = options.resolveEventScope(eventId);
    const matches = resolved !== undefined
      && sameScope(normalizeWikiScope(resolved), scope);
    eventScopeMatches.set(eventId, matches);
    return matches;
  };
  const claims = [...snapshot.claims, ...snapshot.history].filter((claim) =>
    claim.identityId === scope.identityId
    && claim.visibility === scope.visibility
    && eventMatchesScope(claim.sourceEventId)
  );
  const selectedClaimIds = new Set(claims.map((claim) => claim.claimId));
  const claimEvidence = snapshot.claimEvidence.filter((item) =>
    selectedClaimIds.has(item.claimId) && eventMatchesScope(item.eventId)
  );
  const selectedEvidenceEventIds = new Set(claimEvidence.map((item) => item.eventId));
  const projectionUpdatedAt = claims.reduce(
    (latest, claim) => Math.max(latest, claim.updatedAt),
    0,
  ) || (
    fs.existsSync(indexFile)
      ? readPageUpdatedAt(indexFile)
      : undefined
  ) || snapshot.generatedAt;
  const grouped = new Map<string, MemoryClaim[]>();
  const eventsById = new Map(
    snapshot.eventSummaries
      .filter((event) =>
        selectedEvidenceEventIds.has(event.eventId)
        && eventMatchesScope(event.eventId)
      )
      .map((event) => [event.eventId, event]),
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
        ? readExistingWikiPage(file, scope, allowLegacyUnbound)
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
    .map((file) => ({
      file,
      topic: readPageTitle(file),
      updatedAt: readPageUpdatedAt(file) ?? projectionUpdatedAt,
      blocks: readExistingWikiPage(file, scope, allowLegacyUnbound),
    }));
  const indexBlocks = fs.existsSync(indexFile)
    ? readExistingWikiPage(indexFile, scope, allowLegacyUnbound)
    : EMPTY_MANUAL_BLOCKS;
  const topicWrites = topicPages.map((page) => ({
    file: page.file,
    content: renderTopicPage(
      page.topic,
      page.claims,
      claimEvidence,
      eventsById,
      page.blocks,
      page.updatedAt,
      scope,
    ),
  }));
  const indexContent = renderIndex(
    options.title ?? "Asuka Memory",
    pages,
    indexBlocks,
    projectionUpdatedAt,
    scope,
  );

  fs.mkdirSync(entitiesDirectory, { recursive: true });
  const scopeFile = path.join(memoryRoot, SCOPE_FILE);
  for (const write of topicWrites) {
    if (atomicWrite(write.file, write.content)) changedFiles.push(write.file);
  }
  for (const stale of stalePages) {
    if (stale.blocks.notes.trim() || stale.blocks.overrides.trim()) {
      if (atomicWrite(
        stale.file,
        renderTopicPage(
          stale.topic,
          [],
          [],
          new Map(),
          stale.blocks,
          stale.updatedAt,
          scope,
        ),
      )) {
        changedFiles.push(stale.file);
      }
    } else {
      fs.unlinkSync(stale.file);
      removedFiles.push(stale.file);
    }
  }
  if (atomicWrite(
    indexFile,
    indexContent,
  )) {
    changedFiles.push(indexFile);
  }
  if (atomicWrite(scopeFile, scopeContent(scope))) changedFiles.push(scopeFile);

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
  memoryRoot: string,
  scope: WikiMemoryScope,
): MemoryEventInput {
  const relativePath = path.relative(memoryRoot, file).split(path.sep).join("/");
  const contentHash = hashText(content);
  return {
    accountId: scope.accountId,
    peerKind: scope.peerKind,
    peerId: scope.peerId,
    identityId: scope.identityId,
    visibility: scope.visibility,
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
  const memoryRoot = path.resolve(options.memoryRoot);
  const scope = readScopeBinding(memoryRoot);
  if (!scope) {
    throw new Error(`Memory Wiki scope binding is missing in ${memoryRoot}`);
  }
  if (
    options.expectedScope
    && !sameScope(scope, normalizeWikiScope(options.expectedScope))
  ) {
    throw new Error(`Memory Wiki scope binding mismatch in ${memoryRoot}`);
  }
  const pages = listWikiMarkdownFiles(options.memoryRoot)
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      if (
        !hasStandaloneMarker(content, GENERATED_MARKER)
        && !/<!--\s*ASUKA_MEMORY_(?:NOTES|OVERRIDES)/.test(content)
      ) {
        return undefined;
      }
      assertPageScope(content, file, scope, false);
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
    const input = overrideEventInput(page.file, page.overrides, memoryRoot, scope);
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
