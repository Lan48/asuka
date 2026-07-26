import fs from "node:fs";
import path from "node:path";

export type AsukaMemoryWikiScope =
  | "home-base"
  | "temporary-stay"
  | "current-presence"
  | "plan"
  | "general";

export interface AsukaMemoryWikiItem {
  id: string;
  type: string;
  text: string;
  source: string;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  confidence: number;
  key?: string;
  status?: "active" | "superseded" | "forgotten";
  supersededBy?: string;
  supersededAt?: number;
  forgottenAt?: number;
}

export interface AsukaMemoryWikiClaim {
  id: string;
  subject: "user" | "asuka" | "relationship";
  property: string;
  value: string;
  scope: AsukaMemoryWikiScope;
  status: "current" | "planned" | "superseded" | "expired" | "forgotten";
  validFrom: string | null;
  validTo: string | null;
  observedAt: string;
  updatedAt: string;
  source: string;
  confidence: number;
  supersedes: string[];
}

const GENERATED_START = "<!-- ASUKA_MEMORY_GENERATED_START -->";
const GENERATED_END = "<!-- ASUKA_MEMORY_GENERATED_END -->";
const NOTES_START = "<!-- ASUKA_MEMORY_NOTES_START -->";
const NOTES_END = "<!-- ASUKA_MEMORY_NOTES_END -->";
const OPENCLAW_HUMAN_START = "<!-- openclaw:human:start -->";
const OPENCLAW_HUMAN_END = "<!-- openclaw:human:end -->";
const PENDING_FILE = ".asuka-memory-pending";

function iso(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function deriveScope(item: AsukaMemoryWikiItem): AsukaMemoryWikiScope {
  const text = item.text;
  if (item.key === "user:residence:plan" || /(计划|准备|打算|将要|未来|下月|之后).*(搬|住)/.test(text)) {
    return "plan";
  }
  if (item.key === "user:residence:temporary-stay" || /(暂住|临时住|短住|借住|住一阵|暑假.*住)/.test(text)) {
    return "temporary-stay";
  }
  if (item.key === "user:residence:current-presence" || /(?:现在|目前|此刻|刚刚?)在(?!.*(?:住|宿舍|家))/.test(text)) {
    return "current-presence";
  }
  if (item.key === "user:residence:home-base" || /(住在|住所|家在|搬到|宿舍)/.test(text)) {
    return "home-base";
  }
  return "general";
}

function deriveSubject(item: AsukaMemoryWikiItem): AsukaMemoryWikiClaim["subject"] {
  if (item.type.startsWith("asuka_") || item.source.startsWith("assistant_")) return "asuka";
  if (item.type === "relationship") return "relationship";
  return "user";
}

function deriveProperty(item: AsukaMemoryWikiItem, scope: AsukaMemoryWikiScope): string {
  if (scope !== "general") return "residence";
  if (item.key) return item.key.replace(/^(?:user|asuka):/, "");
  return item.type;
}

function toClaim(item: AsukaMemoryWikiItem, allItems: AsukaMemoryWikiItem[]): AsukaMemoryWikiClaim {
  const scope = deriveScope(item);
  const status = item.status === "forgotten"
    ? "forgotten"
    : item.status === "superseded"
      ? "superseded"
      : item.expiresAt && item.expiresAt <= Date.now()
        ? "expired"
        : scope === "plan"
          ? "planned"
          : "current";
  return {
    id: item.id,
    subject: deriveSubject(item),
    property: deriveProperty(item, scope),
    value: item.text,
    scope,
    status,
    validFrom: status === "planned" ? null : iso(item.createdAt),
    validTo: iso(item.forgottenAt ?? item.supersededAt ?? item.expiresAt),
    observedAt: iso(item.createdAt)!,
    updatedAt: iso(item.updatedAt)!,
    source: item.sourceMessageId ?? item.source,
    confidence: item.confidence,
    supersedes: allItems
      .filter((candidate) => candidate.supersededBy === item.id)
      .map((candidate) => candidate.id),
  };
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf-8");
  fs.renameSync(temporary, file);
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderGeneratedClaims(claims: AsukaMemoryWikiClaim[]): string {
  const rows = claims
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((claim) =>
      `| ${claim.id} | ${claim.subject} | ${escapeTable(claim.property)} | ${escapeTable(claim.value)} | ${claim.scope} | ${claim.status} | ${claim.updatedAt} |`,
    )
    .join("\n");
  return [
    GENERATED_START,
    "| ID | Subject | Property | Value | Scope | Status | Updated |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    rows,
    GENERATED_END,
  ].join("\n");
}

function renderMarkdown(claims: AsukaMemoryWikiClaim[], current: string): string {
  const generated = renderGeneratedClaims(claims);
  const start = current.indexOf(GENERATED_START);
  const end = current.indexOf(GENERATED_END);
  if (start >= 0 && end >= start) {
    return `${current.slice(0, start)}${generated}${current.slice(end + GENERATED_END.length)}`;
  }
  if (current.trim()) {
    return `${current.trimEnd()}\n\n${generated}\n`;
  }
  return [
    "---",
    "title: Asuka Memory Claims",
    "generated: true",
    "tags:",
    "  - asuka/memory",
    "---",
    "",
    "# Asuka Memory Claims",
    "",
    generated,
    "",
    "## Notes",
    "",
    NOTES_START,
    "",
    NOTES_END,
    "",
  ].join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function compiledClaimStatus(status: AsukaMemoryWikiClaim["status"]): string {
  if (status === "current") return "supported";
  if (status === "planned") return "proposed";
  if (status === "expired") return "stale";
  if (status === "forgotten") return "refuted";
  return status;
}

function claimEvidenceNote(claim: AsukaMemoryWikiClaim): string {
  return JSON.stringify({
    subject: claim.subject,
    property: claim.property,
    scope: claim.scope,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    observedAt: claim.observedAt,
    supersedes: claim.supersedes,
    sourceStatus: claim.status,
  });
}

function extractHumanNotes(current: string): string {
  const start = current.indexOf(OPENCLAW_HUMAN_START);
  const end = current.indexOf(OPENCLAW_HUMAN_END);
  if (start < 0 || end < start) return "";
  return current.slice(start + OPENCLAW_HUMAN_START.length, end).trim();
}

function renderCompiledEntityPage(claims: AsukaMemoryWikiClaim[], current: string): string {
  const updatedAt = claims.reduce(
    (latest, claim) => claim.updatedAt > latest ? claim.updatedAt : latest,
    new Date(0).toISOString(),
  );
  const frontmatter = [
    "pageType: entity",
    "entityType: relationship-context",
    "id: entity.asuka-memory-context",
    "canonicalId: asuka-memory-context",
    "title: Asuka Memory Context",
    "privacyTier: local-private",
    "sourceIds:",
    "  - source.asuka-memory-jsonl",
    `updatedAt: ${yamlScalar(updatedAt)}`,
    `lastRefreshedAt: ${yamlScalar(updatedAt)}`,
    "claims:",
    ...claims.flatMap((claim) => [
      `  - id: ${yamlScalar(claim.id)}`,
      `    text: ${yamlScalar(`${claim.subject}.${claim.property} [${claim.scope}]: ${claim.value}`)}`,
      `    status: ${yamlScalar(compiledClaimStatus(claim.status))}`,
      `    confidence: ${claim.confidence}`,
      `    updatedAt: ${yamlScalar(claim.updatedAt)}`,
      "    evidence:",
      `      - kind: ${yamlScalar("asuka-memory")}`,
      `        sourceId: ${yamlScalar(claim.source)}`,
      `        privacyTier: ${yamlScalar("local-private")}`,
      `        note: ${yamlScalar(claimEvidenceNote(claim))}`,
      `        updatedAt: ${yamlScalar(claim.updatedAt)}`,
    ]),
  ];
  const notes = extractHumanNotes(current);
  return [
    "---",
    ...frontmatter,
    "---",
    "",
    "# Asuka Memory Context",
    "",
    renderGeneratedClaims(claims),
    "",
    "## Notes",
    OPENCLAW_HUMAN_START,
    notes,
    OPENCLAW_HUMAN_END,
    "",
  ].join("\n");
}

function renderSourcePage(updatedAt: string, current: string): string {
  const notes = extractHumanNotes(current);
  return [
    "---",
    "pageType: source",
    "id: source.asuka-memory-jsonl",
    "title: Asuka Memory JSONL Source",
    "sourceType: asuka-memory-jsonl",
    "provenanceMode: local-private",
    "sourcePath: claims.jsonl",
    `updatedAt: ${yamlScalar(updatedAt)}`,
    "---",
    "",
    "# Asuka Memory JSONL Source",
    "",
    "This page records the provenance of structured claims generated from Asuka's local long-term memory.",
    "",
    "## Notes",
    OPENCLAW_HUMAN_START,
    notes,
    OPENCLAW_HUMAN_END,
    "",
  ].join("\n");
}

function readExistingClaims(file: string): AsukaMemoryWikiClaim[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AsukaMemoryWikiClaim];
      } catch {
        return [];
      }
    });
}

export function syncAsukaMemoryWiki(items: AsukaMemoryWikiItem[]): void {
  const configuredDir = process.env.ASUKA_MEMORY_WIKI_DIR?.trim();
  if (!configuredDir) return;
  try {
    const targetDir = path.resolve(configuredDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const jsonlFile = path.join(targetDir, "claims.jsonl");
    const markdownFile = path.join(targetDir, "Claims.md");
    const entityFile = path.join(targetDir, "entities", "asuka-memory-context.md");
    const sourceFile = path.join(targetDir, "sources", "asuka-memory-jsonl.md");
    const claimsById = new Map(readExistingClaims(jsonlFile).map((claim) => [claim.id, claim]));
    for (const claim of items.map((item) => toClaim(item, items))) {
      claimsById.set(claim.id, claim);
    }
    const claims = [...claimsById.values()];
    const jsonl = claims.map((claim) => JSON.stringify(claim)).join("\n");
    atomicWrite(jsonlFile, jsonl ? `${jsonl}\n` : "");
    const currentMarkdown = fs.existsSync(markdownFile) ? fs.readFileSync(markdownFile, "utf-8") : "";
    atomicWrite(markdownFile, renderMarkdown(claims, currentMarkdown));
    fs.mkdirSync(path.dirname(entityFile), { recursive: true });
    const currentEntity = fs.existsSync(entityFile) ? fs.readFileSync(entityFile, "utf-8") : "";
    atomicWrite(entityFile, renderCompiledEntityPage(claims, currentEntity));
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    const currentSource = fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, "utf-8") : "";
    const updatedAt = claims.reduce(
      (latest, claim) => claim.updatedAt > latest ? claim.updatedAt : latest,
      new Date(0).toISOString(),
    );
    atomicWrite(sourceFile, renderSourcePage(updatedAt, currentSource));
    atomicWrite(path.join(targetDir, PENDING_FILE), `${new Date().toISOString()}\n`);
  } catch (error) {
    console.error(`[asuka-memory] Failed to sync Memory Wiki: ${error}`);
  }
}

export function isAsukaMemoryWikiPrimary(): boolean {
  if (process.env.ASUKA_MEMORY_WIKI_PRIMARY !== "1") return false;
  const configuredDir = process.env.ASUKA_MEMORY_WIKI_DIR?.trim();
  if (!configuredDir) return false;
  try {
    const targetDir = path.resolve(configuredDir);
    if (!fs.statSync(targetDir).isDirectory()) return false;
    if (fs.existsSync(path.join(targetDir, PENDING_FILE))) return false;
    return fs.existsSync(path.join(targetDir, ".openclaw-wiki", "cache", "agent-digest.json"));
  } catch {
    return false;
  }
}
