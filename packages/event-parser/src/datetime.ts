interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function isValidDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function partsAt(instant: number, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function wallClockValue(parts: LocalDateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function zonedDateTimeToInstant(
  eventDate: string,
  hour: number,
  minute: number,
  timeZone: string,
): string | null {
  if (!isValidDateOnly(eventDate) || !isValidTimeZone(timeZone)) return null;
  const [year, month, day] = eventDate.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour, minute);
  let instant = target;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const correction = target - wallClockValue(partsAt(instant, timeZone));
    instant += correction;
    if (correction === 0) break;
  }

  const resolved = partsAt(instant, timeZone);
  if (wallClockValue(resolved) !== target) return null;
  const offsetMinutes = Math.round((target - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${eventDate}T${pad(hour)}:${pad(minute)}:00${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

export function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export function dateInTimeZone(instant: string, timeZone: string): string | null {
  if (!isValidTimeZone(timeZone) || Number.isNaN(Date.parse(instant))) return null;
  const parts = partsAt(Date.parse(instant), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
