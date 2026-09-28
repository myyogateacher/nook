/**
 * Deterministic date formatting for mail (the server knows the recipient's stored zone, D.6). Built
 * from Intl parts so the output does not drift with ICU phrasing ("at", commas).
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function partsIn(date: Date, timeZone: string) {
  let zone = timeZone;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short" });
  } catch {
    zone = "UTC";
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short" });
  }
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return { year, month, day, weekday, hour: get("hour").padStart(2, "0"), minute: get("minute").padStart(2, "0"), zone };
}

/** "Mon 28 Sep 2026, 14:05 (Europe/Berlin)". */
export function formatInstant(iso: string | Date, timeZone: string) {
  const parts = partsIn(typeof iso === "string" ? new Date(iso) : iso, timeZone);
  return `${parts.weekday} ${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}, ${parts.hour}:${parts.minute} (${parts.zone})`;
}

/** "Fri 3 Oct" for a `yyyy-mm-dd` date. */
export function formatDay(date: string) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  if (!year || !month || !day) return date;
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${MONTHS[month - 1]}`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
