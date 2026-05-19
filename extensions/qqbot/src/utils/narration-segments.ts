const STRUCTURED_PAYLOAD_RE = /Q{1,2}BOT_(?:PAYLOAD|CRON):/;
const MEDIA_TAG_RE = /<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\([^)]+\)/;
const FULL_WIDTH_PAREN_ONLY_RE = /^（[\s\S]*）?$/;

function isProtectedMessage(text: string): boolean {
  return STRUCTURED_PAYLOAD_RE.test(text) || MEDIA_TAG_RE.test(text) || MARKDOWN_IMAGE_RE.test(text);
}

function normalizeSegment(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function appendTextSegments(segments: string[], text: string): void {
  for (const line of text.split(/\r?\n+/)) {
    const segment = normalizeSegment(line);
    if (segment) segments.push(segment);
  }
}

function findFullWidthParenSegmentEnd(text: string, startIndex: number): number {
  let depth = 0;
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index];
    if (char === "（") {
      depth++;
      continue;
    }
    if (char === "）") {
      depth--;
      if (depth <= 0) return index + 1;
      continue;
    }
    if ((char === "\n" || char === "\r") && depth > 0) {
      return index;
    }
  }
  return text.length;
}

export function splitAsukaNarrationSegments(text: string): string[] {
  const original = text ?? "";
  const trimmed = original.trim();
  if (!trimmed || isProtectedMessage(trimmed)) return [original];

  const segments: string[] = [];
  let lastIndex = 0;

  for (let index = 0; index < trimmed.length; index++) {
    if (trimmed[index] !== "（") continue;

    const before = normalizeSegment(trimmed.slice(lastIndex, index));
    if (before) appendTextSegments(segments, before);

    const endIndex = findFullWidthParenSegmentEnd(trimmed, index);
    const stageDirection = normalizeSegment(trimmed.slice(index, endIndex));
    if (stageDirection) segments.push(stageDirection);

    lastIndex = endIndex;
    index = endIndex - 1;
  }

  const after = normalizeSegment(trimmed.slice(lastIndex));
  if (after) appendTextSegments(segments, after);

  return segments.length > 0 ? segments : [original];
}

export function isAsukaNarrationSegment(text: string): boolean {
  return FULL_WIDTH_PAREN_ONLY_RE.test((text ?? "").trim());
}

export function stripAsukaNarrationForSpeech(text: string): string {
  return splitAsukaNarrationSegments(text)
    .filter((segment) => !isAsukaNarrationSegment(segment))
    .join("\n")
    .trim();
}
