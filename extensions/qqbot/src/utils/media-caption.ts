function normalizeCaptionForCompare(text: string): string {
  return text
    .replace(/<qqimg>[\s\S]*?<\/(?:qqimg|img)>/gi, "")
    .replace(/QQBOT_PAYLOAD:[\s\S]*$/gi, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, "")
    .trim();
}

export function dedupeCaptionAgainstVisibleText(
  visibleText: string | undefined | null,
  caption: string | undefined | null,
): string {
  const cleanCaption = (caption || "").trim();
  if (!cleanCaption) {
    return "";
  }

  const normalizedCaption = normalizeCaptionForCompare(cleanCaption);
  const normalizedVisible = normalizeCaptionForCompare(visibleText || "");
  if (!normalizedCaption) {
    return "";
  }

  if (
    normalizedVisible &&
    (normalizedVisible === normalizedCaption ||
      normalizedVisible.includes(normalizedCaption) ||
      normalizedCaption.includes(normalizedVisible))
  ) {
    return "";
  }

  return cleanCaption;
}

export function mergeVisibleTextAndCaption(
  visibleText: string | undefined | null,
  caption: string | undefined | null,
): string {
  const cleanVisible = (visibleText || "").trim();
  const cleanCaption = dedupeCaptionAgainstVisibleText(cleanVisible, caption);
  return [cleanVisible, cleanCaption]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}
