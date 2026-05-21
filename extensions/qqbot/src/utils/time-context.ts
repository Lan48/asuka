export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function normalizePromptHour(hour: number): number {
  return hour === 24 ? 0 : hour;
}

export function describeDayPeriod(hour: number): string {
  const normalizedHour = normalizePromptHour(hour);
  if (normalizedHour < 5) return "凌晨";
  if (normalizedHour < 9) return "早上";
  if (normalizedHour < 12) return "上午";
  if (normalizedHour < 14) return "中午";
  if (normalizedHour < 18) return "下午";
  if (normalizedHour < 21) return "晚上";
  return "深夜";
}

export function getZonedDateParts(source: Date, timeZone = "Asia/Shanghai"): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(source);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === type)?.value;
    return value ? Number(value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function formatZonedDateTimeForPrompt(timestampMs = Date.now(), timeZone = "Asia/Shanghai"): string {
  const source = new Date(timestampMs);
  const parts = getZonedDateParts(source, timeZone);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(source);
  const hour = normalizePromptHour(parts.hour);
  const date = [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
  const clock = `${String(hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return `${date} ${weekday} ${clock}（${timeZone}，${describeDayPeriod(hour)}）`;
}

export function formatRelativeTimeForPrompt(timestampMs: number | null | undefined, now = Date.now()): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return "";
  const delta = now - timestampMs;
  if (delta < 45 * 1000) return "刚刚";
  if (delta < 60 * 60 * 1000) {
    return `${Math.max(1, Math.floor(delta / 60000))}分钟前`;
  }
  if (delta < 24 * 60 * 60 * 1000) {
    return `${Math.max(1, Math.floor(delta / 3600000))}小时前`;
  }
  return `${Math.max(1, Math.floor(delta / (24 * 60 * 60 * 1000)))}天前`;
}
