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
  salience?: number;
  temporary?: boolean;
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
  sourceKind?: string;
  memoryType?: string;
  confidence: number;
  salience?: number;
  temporary?: boolean;
  supersedes: string[];
}

const GENERATED_START = "<!-- ASUKA_MEMORY_GENERATED_START -->";
const GENERATED_END = "<!-- ASUKA_MEMORY_GENERATED_END -->";
const NOTES_START = "<!-- ASUKA_MEMORY_NOTES_START -->";
const NOTES_END = "<!-- ASUKA_MEMORY_NOTES_END -->";
const OPENCLAW_HUMAN_START = "<!-- openclaw:human:start -->";
const OPENCLAW_HUMAN_END = "<!-- openclaw:human:end -->";
const LEGACY_REDIRECT_MARKER = "<!-- asuka-memory:legacy-redirect -->";
const PENDING_FILE = ".asuka-memory-pending";

interface CompiledTopic {
  slug: string;
  title: string;
  entityType: string;
}

const COMPILED_TOPICS: CompiledTopic[] = [
  {
    slug: "residence-location-timeline",
    title: "Residence and Location Timeline",
    entityType: "location-timeline",
  },
  {
    slug: "relationship-state",
    title: "Relationship State",
    entityType: "relationship-context",
  },
  {
    slug: "preferences-boundaries",
    title: "Preferences and Boundaries",
    entityType: "preference-profile",
  },
  {
    slug: "commitments-todos",
    title: "Commitments and Todos",
    entityType: "task-context",
  },
  {
    slug: "user-basics",
    title: "User Basics",
    entityType: "person-profile",
  },
  {
    slug: "asuka-self-state",
    title: "Asuka Self State",
    entityType: "agent-state",
  },
];

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
  if (item.type === "active_thread") return "active_thread";
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
    sourceKind: item.source,
    memoryType: item.type,
    confidence: item.confidence,
    salience: item.salience,
    temporary: item.temporary,
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
    sourceKind: claim.sourceKind,
    memoryType: claim.memoryType,
    salience: claim.salience,
    temporary: claim.temporary,
  });
}

function extractHumanNotes(current: string): string {
  const start = current.indexOf(OPENCLAW_HUMAN_START);
  const end = current.indexOf(OPENCLAW_HUMAN_END);
  if (start < 0 || end < start) return "";
  return current.slice(start + OPENCLAW_HUMAN_START.length, end).trim();
}

function mergeHumanNotes(...notes: string[]): string {
  let merged = "";
  for (const candidate of notes.map((note) => note.trim()).filter(Boolean)) {
    if (!merged) {
      merged = candidate;
    } else if (!merged.includes(candidate)) {
      merged = candidate.includes(merged) ? candidate : `${merged}\n\n${candidate}`;
    }
  }
  return merged;
}

function topicForClaim(claim: AsukaMemoryWikiClaim): string {
  if (claim.property === "explicit") {
    if (STABLE_RELATIONSHIP_RE.test(claim.value)) return "relationship-state";
    if (STABLE_RESIDENCE_RE.test(claim.value)) return "residence-location-timeline";
    if (STABLE_PREFERENCE_RE.test(claim.value) || STABLE_BOUNDARY_RE.test(claim.value)) {
      return "preferences-boundaries";
    }
  }
  if (
    claim.scope !== "general"
    || claim.property === "residence"
    || claim.property === "location"
  ) {
    return "residence-location-timeline";
  }
  if (claim.subject === "relationship" || claim.property === "relationship") {
    return "relationship-state";
  }
  if (
    claim.property === "preference"
    || claim.property.startsWith("preference:")
    || claim.property === "boundary"
    || claim.property.startsWith("boundary:")
  ) {
    return "preferences-boundaries";
  }
  if (claim.property === "active_thread") return "commitments-todos";
  if (claim.subject === "asuka") return "asuka-self-state";
  return "user-basics";
}

const LOW_INFORMATION_CLAIM_RE = /^(?:[嗯哦噢啊诶唉哈]+[，,\s]*)?(?:不(?:太)?记得(?:了)?|记不(?:太)?清(?:了)?|没有(?:吧|啊|呢)?|没(?:有)?(?:吧|呢)?|不知道|不清楚)[。！？!?~～…\s]*$/;
const NON_ASSERTIVE_CLAIM_RE = /[?？]|(?:还记得|记不记得|知道不知道|你知道).*(?:吗|呢|么)/;
const STABLE_USER_PROFILE_RE = /(我叫|我的名字|(?:^|[，,:：])(?:请)?叫我|生日|纪念日|时区|城市|住在|住所|家在|工作|上学|学校|公司)/;
const STABLE_RESIDENCE_RE = /(住在|住所|家在|宿舍|暂住|临时住|短住|借住|搬到|搬家|同居)/;
const STABLE_PREFERENCE_RE = /(我喜欢|我偏好|我更喜欢|我习惯|我希望|对我来说[^。！？!?]{0,40}重要)/;
const STABLE_BOUNDARY_RE = /(我不喜欢|我讨厌|我不想被|我介意|我的雷点|让我不舒服|别再|不要再|别叫我)/;
const STABLE_RELATIONSHIP_RE = /(同居|恋人|情侣|夫妻|结婚|在一起|分手|和好|我们约定|我们拉钩|纪念日|我爱你|我喜欢你)/;
const ACTIONABLE_THREAD_RE = /(计划|准备|打算|约定|答应|承诺|提醒|待办|下次|回头|继续|要做|记得|别忘)/;
const EXPLICIT_MEMORY_COMMAND_RE = /^(?:(?:请|麻烦)(?:你)?[，,:：\s]*)?(?:(?:你)?帮我记(?:一下)?|记住|记下|记好|记得|别忘(?:记)?|你要记(?:住|得)?|以后(?:你)?(?:要)?记得)/;

function isSubstantiveExplicitClaim(value: string): boolean {
  if (/[？?]/.test(value)) return false;
  const content = value.replace(EXPLICIT_MEMORY_COMMAND_RE, "").replace(/^[，,:：。\s]+/, "").trim();
  return EXPLICIT_MEMORY_COMMAND_RE.test(value) && content.length >= 2;
}

export function isDurableClaim(claim: AsukaMemoryWikiClaim): boolean {
  if (
    claim.status === "forgotten"
    || claim.status === "expired"
    || claim.temporary
    || LOW_INFORMATION_CLAIM_RE.test(claim.value.trim())
    || NON_ASSERTIVE_CLAIM_RE.test(claim.value)
  ) return false;
  const topic = topicForClaim(claim);
  if (claim.memoryType === "active_thread" || claim.property === "active_thread") {
    return ACTIONABLE_THREAD_RE.test(claim.value);
  }
  if (claim.memoryType === "asuka_self_signal" || claim.property === "asuka_self_signal") {
    return claim.confidence >= 0.75;
  }
  if (claim.subject === "asuka") return false;
  if (topic === "residence-location-timeline") {
    return claim.subject === "user"
      && (claim.scope !== "general" || STABLE_RESIDENCE_RE.test(claim.value));
  }
  if (claim.memoryType === "explicit" || claim.property === "explicit") {
    return isSubstantiveExplicitClaim(claim.value);
  }
  if (claim.sourceKind === "user_explicit" || claim.source === "user_explicit") {
    return true;
  }
  if (claim.memoryType === "user_profile" || topic === "user-basics") {
    return STABLE_USER_PROFILE_RE.test(claim.value);
  }
  if (claim.memoryType === "preference" || claim.property.startsWith("preference")) {
    return STABLE_PREFERENCE_RE.test(claim.value);
  }
  if (claim.memoryType === "boundary" || claim.property.startsWith("boundary")) {
    return STABLE_BOUNDARY_RE.test(claim.value);
  }
  if (claim.memoryType === "relationship" || topic === "relationship-state") {
    return STABLE_RELATIONSHIP_RE.test(claim.value);
  }
  return false;
}

function renderCompiledEntityPage(
  topic: CompiledTopic,
  claims: AsukaMemoryWikiClaim[],
  notes: string,
): string {
  const updatedAt = claims.reduce(
    (latest, claim) => claim.updatedAt > latest ? claim.updatedAt : latest,
    new Date(0).toISOString(),
  );
  const frontmatter = [
    "pageType: entity",
    `entityType: ${topic.entityType}`,
    `id: entity.asuka-memory-${topic.slug}`,
    `canonicalId: asuka-memory-${topic.slug}`,
    `title: ${topic.title}`,
    "privacyTier: local-private",
    "sourceIds:",
    "  - source.asuka-memory-jsonl",
    `updatedAt: ${yamlScalar(updatedAt)}`,
    `lastRefreshedAt: ${yamlScalar(updatedAt)}`,
    claims.length ? "claims:" : "claims: []",
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
  return [
    "---",
    ...frontmatter,
    "---",
    "",
    `# ${topic.title}`,
    "",
    ...(claims.length ? [renderGeneratedClaims(claims), ""] : []),
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

function renderLegacyRedirect(current: string): string {
  if (current.includes(LEGACY_REDIRECT_MARKER)) return current;
  const archived = current
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join("\n");
  return [
    "---",
    "pageType: entity",
    "entityType: migration-redirect",
    "id: entity.asuka-memory-context-legacy",
    "canonicalId: asuka-memory-context-legacy",
    "title: Asuka Memory Context (Migrated)",
    "privacyTier: local-private",
    "sourceIds:",
    "  - source.asuka-memory-jsonl",
    `updatedAt: ${yamlScalar(new Date().toISOString())}`,
    "claims: []",
    "---",
    "",
    LEGACY_REDIRECT_MARKER,
    "# Asuka Memory Context (Migrated)",
    "",
    "The generated memory view has moved to the [[index|memory topic index]] in this folder.",
    "",
    "<details>",
    "<summary>Preserved pre-migration page</summary>",
    "",
    archived,
    "",
    "</details>",
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
    const entitiesDir = path.join(targetDir, "entities");
    const legacyEntityFile = path.join(entitiesDir, "asuka-memory-context.md");
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
    fs.mkdirSync(entitiesDir, { recursive: true });
    const legacyContent = fs.existsSync(legacyEntityFile)
      ? fs.readFileSync(legacyEntityFile, "utf-8")
      : "";
    const legacyNotes = extractHumanNotes(legacyContent);
    for (const topic of COMPILED_TOPICS) {
      const topicFile = path.join(entitiesDir, `${topic.slug}.md`);
      const current = fs.existsSync(topicFile) ? fs.readFileSync(topicFile, "utf-8") : "";
      const notes = mergeHumanNotes(
        extractHumanNotes(current),
        topic.slug === "user-basics" ? legacyNotes : "",
      );
      const topicClaims = claims.filter(
        (claim) => isDurableClaim(claim) && topicForClaim(claim) === topic.slug,
      );
      if (!topicClaims.length && !notes) {
        if (fs.existsSync(topicFile)) fs.unlinkSync(topicFile);
        continue;
      }
      atomicWrite(topicFile, renderCompiledEntityPage(topic, topicClaims, notes));
    }
    if (legacyContent) atomicWrite(legacyEntityFile, renderLegacyRedirect(legacyContent));
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
