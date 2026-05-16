const STRUCTURED_PAYLOAD_RE = /QQBOT_(?:PAYLOAD|CRON):/;
const MEDIA_TAG_RE = /<(?:qqimg|qqvoice|qqvideo|qqfile)>[\s\S]*?<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/i;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\([^)]+\)/;
const FULL_WIDTH_PAREN_SEGMENT_RE = /（[^（）]*）/g;
const FULL_WIDTH_PAREN_ONLY_RE = /^（[^（）]*）$/;

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

export function splitAsukaNarrationSegments(text: string): string[] {
  const original = text ?? "";
  const trimmed = original.trim();
  if (!trimmed || isProtectedMessage(trimmed)) return [original];

  const segments: string[] = [];
  let lastIndex = 0;
  FULL_WIDTH_PAREN_SEGMENT_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FULL_WIDTH_PAREN_SEGMENT_RE.exec(trimmed)) !== null) {
    const before = normalizeSegment(trimmed.slice(lastIndex, match.index));
    if (before) appendTextSegments(segments, before);

    const stageDirection = normalizeSegment(match[0]);
    if (stageDirection) segments.push(stageDirection);

    lastIndex = match.index + match[0].length;
  }

  const after = normalizeSegment(trimmed.slice(lastIndex));
  if (after) appendTextSegments(segments, after);

  return segments.length > 1 ? segments : [original];
}

export function isAsukaNarrationSegment(text: string): boolean {
  return FULL_WIDTH_PAREN_ONLY_RE.test((text ?? "").trim());
}
