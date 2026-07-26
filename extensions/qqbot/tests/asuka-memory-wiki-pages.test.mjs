import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { isDurableClaim, syncAsukaMemoryWiki } = await import("../dist/src/asuka-memory-wiki.js");

const now = Date.now();
let sequence = 0;

function memory(overrides) {
  sequence += 1;
  return {
    id: `memory-${sequence}`,
    type: "explicit",
    text: "请记住这个长期事实",
    source: "user_explicit",
    sourceMessageId: `message-${sequence}`,
    createdAt: now + sequence,
    updatedAt: now + sequence,
    confidence: 0.9,
    salience: 8,
    ...overrides,
  };
}

function humanPage(notes) {
  return [
    "---",
    "pageType: entity",
    "---",
    "",
    "## Notes",
    "<!-- openclaw:human:start -->",
    notes,
    "<!-- openclaw:human:end -->",
    "",
  ].join("\n");
}

function frontmatterClaimIds(content) {
  const frontmatter = content.split("---")[1] ?? "";
  return [...frontmatter.matchAll(/^  - id: "([^"]+)"$/gm)].map((match) => match[1]);
}

function occurrenceCount(content, needle) {
  return content.split(needle).length - 1;
}

const topicById = new Map([
  ["residence", "residence-location-timeline"],
  ["relationship", "relationship-state"],
  ["preference", "preferences-boundaries"],
  ["todo", "commitments-todos"],
  ["user", "user-basics"],
  ["asuka", "asuka-self-state"],
]);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asuka-memory-wiki-pages-"));
const wikiDir = path.join(tempRoot, "wiki");
const sparseWikiDir = path.join(tempRoot, "sparse-wiki");

try {
  fs.mkdirSync(path.join(wikiDir, "entities"), { recursive: true });
  const legacyFile = path.join(wikiDir, "entities", "asuka-memory-context.md");
  fs.writeFileSync(legacyFile, humanPage("legacy user note"), "utf-8");
  process.env.ASUKA_MEMORY_WIKI_DIR = wikiDir;

  const items = [
    memory({
      id: "residence",
      type: "user_profile",
      text: "我目前住在杭州的宿舍",
      source: "user_inferred",
      key: "user:residence:home-base",
    }),
    memory({
      id: "relationship",
      type: "relationship",
      text: "我们是恋人，也约定认真沟通",
      source: "user_inferred",
    }),
    memory({
      id: "preference",
      type: "preference",
      text: "我更喜欢简短直接的回复",
      source: "user_inferred",
      key: "preference:reply_style",
    }),
    memory({
      id: "todo",
      type: "active_thread",
      text: "下次继续整理旅行计划",
      source: "user_inferred",
    }),
    memory({
      id: "user",
      type: "explicit",
      text: "请记住我的项目代号是 Aurora",
      source: "user_explicit",
    }),
    memory({
      id: "asuka",
      type: "asuka_self_signal",
      text: "我会认真对你，也不想敷衍",
      source: "assistant_self_signal",
      confidence: 0.88,
    }),
    memory({
      id: "noise-thread",
      type: "active_thread",
      text: "最近随便聊聊天",
      source: "user_inferred",
      confidence: 0.6,
      salience: 3,
    }),
    memory({
      id: "noise-asuka",
      type: "asuka_self_thread",
      text: "我今天喝了一杯咖啡",
      source: "assistant_self_thread",
      confidence: 0.9,
    }),
    memory({
      id: "noise-explicit-recall",
      type: "explicit",
      text: "我记住了",
      source: "user_explicit",
    }),
    memory({
      id: "noise-explicit-question",
      type: "explicit",
      text: "那你现在记住了？",
      source: "user_explicit",
    }),
    memory({
      id: "noise-temporary-residence",
      type: "user_profile",
      text: "我临时住在苏州",
      source: "user_inferred",
      temporary: true,
      key: "user:residence:temporary-stay",
    }),
    memory({
      id: "noise-asuka-residence",
      type: "asuka_self_thread",
      text: "我今天在宿舍整理东西",
      source: "assistant_self_thread",
      confidence: 0.9,
    }),
  ];

  syncAsukaMemoryWiki(items);

  const rootClaims = fs.readFileSync(path.join(wikiDir, "claims.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    new Set(rootClaims.map((claim) => claim.id)),
    new Set(items.map((item) => item.id)),
    "root claims.jsonl should retain the complete audit history",
  );
  const rootMarkdown = fs.readFileSync(path.join(wikiDir, "Claims.md"), "utf-8");
  for (const item of items) {
    assert.match(rootMarkdown, new RegExp(`\\| ${item.id} \\|`), `Claims.md should retain ${item.id}`);
  }

  const indexedIds = [];
  for (const [claimId, slug] of topicById) {
    const file = path.join(wikiDir, "entities", `${slug}.md`);
    assert.equal(fs.existsSync(file), true, `${slug} should be generated`);
    const content = fs.readFileSync(file, "utf-8");
    const ids = frontmatterClaimIds(content);
    assert.deepEqual(ids, [claimId], `${claimId} should route only to ${slug}`);
    assert.equal(occurrenceCount(content.split("---")[1], "    evidence:"), ids.length);
    assert.match(content, /kind: "asuka-memory"/);
    assert.match(content, /sourceId: "message-/);
    assert.match(content, /privacyTier: "local-private"/);
    assert.match(content, /note: "\{/);
    indexedIds.push(...ids);
  }

  const durableIds = rootClaims.filter(isDurableClaim).map((claim) => claim.id);
  assert.deepEqual(
    new Set(indexedIds),
    new Set(durableIds),
    "every durable claim should appear in exactly one topic frontmatter",
  );
  assert.equal(indexedIds.length, new Set(indexedIds).size, "topic pages must not duplicate claims");
  assert.equal(indexedIds.includes("noise-thread"), false);
  assert.equal(indexedIds.includes("noise-asuka"), false);
  assert.equal(indexedIds.includes("noise-explicit-recall"), false);
  assert.equal(indexedIds.includes("noise-explicit-question"), false);
  assert.equal(indexedIds.includes("noise-temporary-residence"), false);
  assert.equal(indexedIds.includes("noise-asuka-residence"), false);

  const userBasicsFile = path.join(wikiDir, "entities", "user-basics.md");
  let userBasics = fs.readFileSync(userBasicsFile, "utf-8");
  assert.match(userBasics, /legacy user note/);
  assert.equal(fs.existsSync(legacyFile), true, "legacy path should remain as a backlink-safe redirect");
  const legacyRedirect = fs.readFileSync(legacyFile, "utf-8");
  assert.match(legacyRedirect, /Asuka Memory Context \(Migrated\)/);
  assert.match(legacyRedirect, /Preserved pre-migration page/);
  assert.equal(frontmatterClaimIds(legacyRedirect).length, 0, "legacy redirect must not duplicate claims");

  const relationshipFile = path.join(wikiDir, "entities", "relationship-state.md");
  let relationshipPage = fs.readFileSync(relationshipFile, "utf-8");
  relationshipPage = relationshipPage.replace(
    "<!-- openclaw:human:start -->\n",
    "<!-- openclaw:human:start -->\nkeep this relationship note\n",
  );
  fs.writeFileSync(relationshipFile, relationshipPage, "utf-8");
  fs.writeFileSync(legacyFile, humanPage("legacy user note"), "utf-8");
  syncAsukaMemoryWiki(items);
  assert.match(fs.readFileSync(relationshipFile, "utf-8"), /keep this relationship note/);
  userBasics = fs.readFileSync(userBasicsFile, "utf-8");
  assert.equal(occurrenceCount(userBasics, "legacy user note"), 1, "legacy Notes migration must be idempotent");
  assert.equal(
    occurrenceCount(fs.readFileSync(legacyFile, "utf-8"), "Preserved pre-migration page"),
    1,
    "legacy redirect must not recursively archive itself",
  );

  const malformedWikiDir = path.join(tempRoot, "malformed-wiki");
  const malformedLegacyFile = path.join(malformedWikiDir, "entities", "asuka-memory-context.md");
  fs.mkdirSync(path.dirname(malformedLegacyFile), { recursive: true });
  fs.writeFileSync(
    malformedLegacyFile,
    "# Legacy\n\nmanual text outside markers\n\n<!-- openclaw:human:start -->\nbroken note",
    "utf-8",
  );
  process.env.ASUKA_MEMORY_WIKI_DIR = malformedWikiDir;
  syncAsukaMemoryWiki([]);
  const malformedRedirect = fs.readFileSync(malformedLegacyFile, "utf-8");
  assert.match(malformedRedirect, /manual text outside markers/);
  assert.match(malformedRedirect, /broken note/);

  const legacySchemaWikiDir = path.join(tempRoot, "legacy-schema-wiki");
  fs.mkdirSync(legacySchemaWikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacySchemaWikiDir, "claims.jsonl"),
    `${JSON.stringify({
      id: "legacy-explicit",
      subject: "user",
      property: "explicit",
      value: "记住：我的项目代号是 Legacy Aurora",
      scope: "general",
      status: "current",
      validFrom: new Date(now).toISOString(),
      validTo: null,
      observedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      source: "legacy-message-id",
      confidence: 0.9,
      supersedes: [],
    })}\n`,
    "utf-8",
  );
  process.env.ASUKA_MEMORY_WIKI_DIR = legacySchemaWikiDir;
  syncAsukaMemoryWiki([]);
  assert.deepEqual(
    frontmatterClaimIds(
      fs.readFileSync(path.join(legacySchemaWikiDir, "entities", "user-basics.md"), "utf-8"),
    ),
    ["legacy-explicit"],
    "legacy explicit claims without provenance fields must remain durable",
  );

  fs.mkdirSync(path.join(sparseWikiDir, "entities"), { recursive: true });
  fs.writeFileSync(
    path.join(sparseWikiDir, "entities", "preferences-boundaries.md"),
    humanPage(""),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(sparseWikiDir, "entities", "relationship-state.md"),
    humanPage("hand-written note only"),
    "utf-8",
  );
  process.env.ASUKA_MEMORY_WIKI_DIR = sparseWikiDir;
  syncAsukaMemoryWiki([
    memory({
      id: "only-user",
      text: "请记住我的项目代号是 Sparse",
      source: "user_explicit",
    }),
  ]);
  assert.equal(
    fs.existsSync(path.join(sparseWikiDir, "entities", "preferences-boundaries.md")),
    false,
    "an empty generated topic without Notes should be removed",
  );
  const notesOnly = fs.readFileSync(
    path.join(sparseWikiDir, "entities", "relationship-state.md"),
    "utf-8",
  );
  assert.match(notesOnly, /hand-written note only/, "a Notes-only topic should be preserved");
  assert.deepEqual(frontmatterClaimIds(notesOnly), []);

  for (const entry of fs.readdirSync(path.join(sparseWikiDir, "entities"))) {
    const content = fs.readFileSync(path.join(sparseWikiDir, "entities", entry), "utf-8");
    assert.equal(
      frontmatterClaimIds(content).length > 0 || /openclaw:human:start -->\s*\S/.test(content),
      true,
      `${entry} must contain claims or human Notes`,
    );
  }
} finally {
  delete process.env.ASUKA_MEMORY_WIKI_DIR;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
