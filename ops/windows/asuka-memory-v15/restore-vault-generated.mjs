#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [currentRoot, backupRoot] = process.argv.slice(2);
if (!currentRoot || !backupRoot) {
  throw new Error("usage: node restore-vault-generated.mjs <current-memory-root> <backup-memory-root>");
}

const markers = {
  generated: "<!-- ASUKA_MEMORY_V15_GENERATED -->",
  notesStart: "<!-- ASUKA_MEMORY_NOTES_START -->",
  notesEnd: "<!-- ASUKA_MEMORY_NOTES_END -->",
  overridesStart: "<!-- ASUKA_MEMORY_OVERRIDES_START -->",
  overridesEnd: "<!-- ASUKA_MEMORY_OVERRIDES_END -->",
  humanStart: "<!-- openclaw:human:start -->",
  humanEnd: "<!-- openclaw:human:end -->",
};

function walkMarkdown(root) {
  const result = new Map();
  if (!fs.existsSync(root)) return result;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        result.set(path.relative(root, full), full);
      }
    }
  };
  visit(root);
  return result;
}

function extract(content, start, end) {
  const left = content.indexOf(start);
  const right = content.indexOf(end);
  if (left < 0 || right < left) return undefined;
  return content.slice(left + start.length, right).trim();
}

function replace(content, start, end, value) {
  if (value === undefined) return content;
  const left = content.indexOf(start);
  const right = content.indexOf(end);
  if (left < 0 || right < left) return content;
  return `${content.slice(0, left + start.length)}\n${value}\n${content.slice(right)}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
}

const current = walkMarkdown(currentRoot);
const backup = walkMarkdown(backupRoot);
const relativeFiles = new Set([...current.keys(), ...backup.keys()]);
const changed = [];
const removed = [];
const retainedManualOnly = [];

for (const relative of [...relativeFiles].sort()) {
  const currentFile = current.get(relative);
  const backupFile = backup.get(relative);
  const currentContent = currentFile ? fs.readFileSync(currentFile, "utf8") : "";
  const notes = extract(currentContent, markers.notesStart, markers.notesEnd);
  const overrides = extract(currentContent, markers.overridesStart, markers.overridesEnd);
  const human = extract(currentContent, markers.humanStart, markers.humanEnd);

  if (backupFile) {
    let restored = fs.readFileSync(backupFile, "utf8");
    restored = replace(restored, markers.notesStart, markers.notesEnd, notes);
    restored = replace(restored, markers.overridesStart, markers.overridesEnd, overrides);
    restored = replace(restored, markers.humanStart, markers.humanEnd, human);
    const destination = path.join(currentRoot, relative);
    if (restored !== currentContent) {
      atomicWrite(destination, restored);
      changed.push(relative);
    }
    continue;
  }

  if (!currentContent.includes(markers.generated)) continue;
  const manualPresent = [notes, overrides, human].some((value) => value && value.trim());
  if (!manualPresent) {
    fs.unlinkSync(currentFile);
    removed.push(relative);
    continue;
  }
  const title = currentContent.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relative, ".md");
  const retained = [
    `# ${title}`,
    "",
    "This generated page was retired during an Asuka memory rollback.",
    "",
    "## Notes",
    markers.notesStart,
    notes || "",
    markers.notesEnd,
    "",
    "## Corrections / Overrides",
    markers.overridesStart,
    overrides || "",
    markers.overridesEnd,
    "",
    ...(human !== undefined
      ? [markers.humanStart, human || "", markers.humanEnd, ""]
      : []),
  ].join("\n");
  atomicWrite(currentFile, retained);
  retainedManualOnly.push(relative);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  changed,
  removed,
  retainedManualOnly,
})}\n`);
