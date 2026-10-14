import { describe, expect, test } from "bun:test";
import {
  expandSeries,
  isOccurrenceDate,
  nextOccurrence,
  isValidDate,
  isValidTimeZone,
  MAX_INSTANCES,
  normalizeExdates,
  normalizeRule,
  rangeFor,
  RecurrenceError,
  seriesBounds,
  utcToZoned,
  validateTiming,
  zonedToUtc,
  type RecurrenceRule,
  type SeriesInput
} from "../server/calendar/recurrence";
import { cpuMs } from "./support/cpuTime";

const iso = (ms: number) => new Date(ms).toISOString();
const timed = (startLocal: string, rule: RecurrenceRule | null, extra: Partial<SeriesInput> = {}): SeriesInput =>
  ({ allDay: false, startLocal, tz: "UTC", durationMinutes: 60, rule, ...extra } as SeriesInput);
const allDay = (startDate: string, endDate: string, rule: RecurrenceRule | null, exdates: string[] = []): SeriesInput =>
  ({ allDay: true, startDate, endDate, rule, exdates });
const dates = (series: SeriesInput, from: string, to: string, tz = "UTC") => expandSeries(series, rangeFor(from, to, tz)).occurrences.map((item) => item.date);

describe("zoned time", () => {
  test("converts wall times with the zone's offset", () => {
    expect(iso(zonedToUtc("2026-01-15T09:00", "America/New_York"))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15T09:00", "America/New_York"))).toBe("2026-07-15T13:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15T09:00", "Europe/Berlin"))).toBe("2026-07-15T07:00:00.000Z");
    expect(iso(zonedToUtc("2026-07-15T09:00", "Asia/Kolkata"))).toBe("2026-07-15T03:30:00.000Z");
    expect(iso(zonedToUtc("2026-07-15T09:00", "UTC"))).toBe("2026-07-15T09:00:00.000Z");
    expect(utcToZoned(Date.parse("2026-07-15T13:00:00Z"), "America/New_York")).toBe("2026-07-15T09:00");
  });

  test("a wall time in a DST gap shifts forward (New York and Berlin)", () => {
    // New York springs forward at 02:00 on 2026-03-08: 02:30 does not exist and becomes 03:30 EDT.
    expect(iso(zonedToUtc("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(utcToZoned(zonedToUtc("2026-03-08T02:30", "America/New_York"), "America/New_York")).toBe("2026-03-08T03:30");
    // Berlin springs forward at 02:00 on 2026-03-29.
    expect(iso(zonedToUtc("2026-03-29T02:15", "Europe/Berlin"))).toBe("2026-03-29T01:15:00.000Z");
    expect(utcToZoned(zonedToUtc("2026-03-29T02:15", "Europe/Berlin"), "Europe/Berlin")).toBe("2026-03-29T03:15");
  });

  test("a wall time in a DST overlap picks the earlier instant (New York and Berlin)", () => {
    // New York falls back at 02:00 on 2026-11-01: 01:30 happens twice; EDT (-4) is earlier.
    expect(iso(zonedToUtc("2026-11-01T01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    // Berlin falls back at 03:00 on 2026-10-25: 02:30 CEST (+2) is earlier.
    expect(iso(zonedToUtc("2026-10-25T02:30", "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
  });

  test("zones and dates are checked against Intl and the real calendar (T71)", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("../etc/passwd")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-01")).toBe(false);
    expect(() => zonedToUtc("2026-02-30T10:00", "UTC")).toThrow(RecurrenceError);
    expect(() => zonedToUtc("2026-02-10T24:00", "UTC")).toThrow(RecurrenceError);
  });
});

describe("recurrence expansion", () => {
  test("a single event yields one occurrence when it overlaps the range", () => {
    expect(dates(timed("2026-05-10T10:00", null), "2026-05-01", "2026-06-01")).toEqual(["2026-05-10"]);
    expect(dates(timed("2026-05-10T10:00", null), "2026-05-11", "2026-06-01")).toEqual([]);
  });

  test("daily, with an interval", () => {
    expect(dates(timed("2026-05-01T08:00", { freq: "daily", interval: 1 }), "2026-05-01", "2026-05-05")).toEqual(["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"]);
    expect(dates(timed("2026-05-01T08:00", { freq: "daily", interval: 3 }), "2026-05-01", "2026-05-15")).toEqual(["2026-05-01", "2026-05-04", "2026-05-07", "2026-05-10", "2026-05-13"]);
  });

  test("weekly, with byDay and an interval", () => {
    // 2026-05-04 is a Monday.
    expect(dates(timed("2026-05-04T08:00", { freq: "weekly", interval: 1 }), "2026-05-01", "2026-05-26")).toEqual(["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"]);
    expect(dates(timed("2026-05-04T08:00", { freq: "weekly", interval: 1, byDay: ["MO", "WE", "FR"] }), "2026-05-01", "2026-05-12"))
      .toEqual(["2026-05-04", "2026-05-06", "2026-05-08", "2026-05-11"]);
    expect(dates(timed("2026-05-06T08:00", { freq: "weekly", interval: 2, byDay: ["MO", "WE"] }), "2026-05-01", "2026-06-01"))
      .toEqual(["2026-05-06", "2026-05-18", "2026-05-20"]);
  });

  test("monthly on the 31st skips short months", () => {
    expect(dates(timed("2026-01-31T09:00", { freq: "monthly", interval: 1 }), "2026-01-01", "2026-04-10")).toEqual(["2026-01-31", "2026-03-31"]);
    expect(dates(timed("2026-01-31T09:00", { freq: "monthly", interval: 1 }), "2026-04-01", "2026-06-10")).toEqual(["2026-05-31"]);
    expect(dates(timed("2026-01-15T09:00", { freq: "monthly", interval: 2 }), "2026-01-01", "2026-04-10")).toEqual(["2026-01-15", "2026-03-15"]);
  });

  test("yearly on Feb 29 only lands in leap years", () => {
    const series = allDay("2024-02-29", "2024-03-01", { freq: "yearly", interval: 1 });
    expect(dates(series, "2025-02-01", "2025-03-15")).toEqual([]);
    expect(dates(series, "2028-02-01", "2028-03-15")).toEqual(["2028-02-29"]);
    expect(dates(allDay("2026-07-04", "2026-07-05", { freq: "yearly", interval: 2 }), "2028-06-10", "2028-07-10")).toEqual(["2028-07-04"]);
  });

  test("until is inclusive and count stops the series", () => {
    expect(dates(timed("2026-05-01T08:00", { freq: "daily", interval: 1, until: "2026-05-03" }), "2026-05-01", "2026-05-10")).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    expect(dates(timed("2026-05-01T08:00", { freq: "daily", interval: 2, count: 3 }), "2026-05-01", "2026-05-20")).toEqual(["2026-05-01", "2026-05-03", "2026-05-05"]);
    // count is counted from the start even when the range begins later.
    expect(dates(timed("2026-05-04T08:00", { freq: "weekly", interval: 1, byDay: ["MO", "TU"], count: 5 }), "2026-05-12", "2026-06-01")).toEqual(["2026-05-12", "2026-05-18"]);
  });

  test("exdates remove single occurrences", () => {
    const series = allDay("2026-05-01", "2026-05-02", { freq: "daily", interval: 1 }, ["2026-05-02", "2026-05-04"]);
    expect(dates(series, "2026-05-01", "2026-05-06")).toEqual(["2026-05-01", "2026-05-03", "2026-05-05"]);
  });

  test("timed repeats keep their wall time across DST in New York and Berlin", () => {
    const ny = expandSeries(timed("2026-03-06T09:00", { freq: "daily", interval: 1 }, { tz: "America/New_York" }), rangeFor("2026-03-06", "2026-03-10", "UTC")).occurrences;
    expect(ny.map((item) => item.allDay ? "" : iso(item.startMs))).toEqual([
      "2026-03-06T14:00:00.000Z", "2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"
    ]);
    const berlin = expandSeries(timed("2026-10-24T02:30", { freq: "daily", interval: 1 }, { tz: "Europe/Berlin" }), rangeFor("2026-10-23", "2026-10-27", "Europe/Berlin")).occurrences;
    expect(berlin.map((item) => item.allDay ? "" : iso(item.startMs))).toEqual([
      "2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"
    ]);
    // A repeat whose wall time falls in the gap shifts forward on that night only.
    const gap = expandSeries(timed("2026-03-28T02:30", { freq: "daily", interval: 1 }, { tz: "Europe/Berlin" }), rangeFor("2026-03-28", "2026-03-31", "Europe/Berlin")).occurrences;
    expect(gap.map((item) => item.allDay ? "" : utcToZoned(item.startMs, "Europe/Berlin"))).toEqual(["2026-03-28T02:30", "2026-03-29T03:30", "2026-03-30T02:30"]);
  });

  test("an occurrence that started before the range but overlaps it is included", () => {
    const series = timed("2026-05-01T22:00", { freq: "daily", interval: 1 }, { durationMinutes: 180 });
    expect(dates(series, "2026-05-03", "2026-05-04")).toEqual(["2026-05-02", "2026-05-03"]);
    const trip = allDay("2026-04-28", "2026-05-05", null);
    expect(dates(trip, "2026-05-01", "2026-05-02")).toEqual(["2026-04-28"]);
  });

  test("the viewer's zone decides which timed occurrences fall in a date range", () => {
    const series = timed("2026-05-01T23:30", null, { tz: "UTC", durationMinutes: 30 });
    expect(dates(series, "2026-05-01", "2026-05-02", "UTC")).toEqual(["2026-05-01"]);
    // 23:30 UTC is 01:30 the next day in Berlin.
    expect(dates(series, "2026-05-01", "2026-05-02", "Europe/Berlin")).toEqual([]);
    expect(dates(series, "2026-05-02", "2026-05-03", "Europe/Berlin")).toEqual(["2026-05-01"]);
  });

  test("an endless series far in the past expands quickly and correctly", () => {
    const series = timed("1990-01-01T07:00", { freq: "daily", interval: 7 });
    let found: string[] = [];
    // CPU time, not wall time (tests/support/cpuTime.ts).
    expect(cpuMs(() => { found = dates(series, "2026-05-01", "2026-05-15"); })).toBeLessThan(200);
    expect(found).toEqual(["2026-05-04", "2026-05-11"]);
    expect(dates(allDay("1990-01-31", "1990-02-01", { freq: "monthly", interval: 1 }), "2026-01-01", "2026-04-01")).toEqual(["2026-01-31", "2026-03-31"]);
  });

  test("expansion stops at the instance cap and reports truncation", () => {
    const series = timed("2026-01-01T00:00", { freq: "daily", interval: 1 }, { durationMinutes: 1 });
    const range = rangeFor("2026-01-01", "2026-04-11", "UTC");
    const capped = expandSeries(series, range, 10);
    expect(capped.occurrences.length).toBe(10);
    expect(capped.truncated).toBe(true);
    const full = expandSeries(series, range);
    expect(full.occurrences.length).toBe(100);
    expect(full.truncated).toBe(false);
    expect(expandSeries(series, range, 0)).toEqual({ occurrences: [], truncated: true });
    expect(MAX_INSTANCES).toBe(1000);
  });

  test("ranges are whole days, at most 100", () => {
    expect(() => rangeFor("2026-01-01", "2026-04-11", "UTC")).not.toThrow();
    expect(() => rangeFor("2026-01-01", "2026-04-12", "UTC")).toThrow(RecurrenceError);
    expect(() => rangeFor("2026-01-02", "2026-01-01", "UTC")).toThrow(RecurrenceError);
    expect(() => rangeFor("2026-01-01", "2026-01-02", "Nowhere/City")).toThrow(RecurrenceError);
  });
});

describe("rules, exdates, timing, and bounds", () => {
  const start = { allDay: false as const, startLocal: "2026-05-04T08:00", tz: "UTC", durationMinutes: 30 };

  test("normalizeRule accepts the subset and rejects everything else", () => {
    expect(normalizeRule({ freq: "weekly", interval: 1, byDay: ["FR", "MO", "MO"] }, start)).toEqual({ freq: "weekly", interval: 1, byDay: ["MO", "FR"] });
    expect(normalizeRule({ freq: "monthly", interval: 1, count: 120 }, start)).toEqual({ freq: "monthly", interval: 1, count: 120 });
    for (const bad of [
      { freq: "hourly", interval: 1 },
      { freq: "daily", interval: 0 },
      { freq: "daily", interval: 100 },
      { freq: "daily", interval: 1.5 },
      { freq: "daily", interval: 1, byDay: ["MO"] },
      { freq: "weekly", interval: 1, byDay: [] },
      { freq: "weekly", interval: 1, byDay: ["XX"] },
      { freq: "weekly", interval: 1, byDay: ["TU"] },
      { freq: "daily", interval: 1, count: 731 },
      { freq: "daily", interval: 1, count: 0 },
      { freq: "daily", interval: 1, until: "2026-05-03" },
      { freq: "daily", interval: 1, until: "2026-02-30" },
      { freq: "daily", interval: 1, until: "2026-06-01", count: 3 }
    ]) {
      expect(() => normalizeRule(bad as RecurrenceRule, start)).toThrow(RecurrenceError);
    }
  });

  test("normalizeExdates sorts, dedupes, and caps at 200", () => {
    expect(normalizeExdates(["2026-05-03", "2026-05-01", "2026-05-03"])).toEqual(["2026-05-01", "2026-05-03"]);
    expect(() => normalizeExdates(["2026-02-30"])).toThrow(RecurrenceError);
    const many = Array.from({ length: 201 }, (_, index) => new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10));
    expect(() => normalizeExdates(many)).toThrow(RecurrenceError);
    expect(normalizeExdates(many.slice(0, 200)).length).toBe(200);
  });

  test("validateTiming checks dates, zones, spans, and durations", () => {
    expect(() => validateTiming(start)).not.toThrow();
    expect(() => validateTiming({ ...start, tz: "Nowhere/City" })).toThrow(RecurrenceError);
    expect(() => validateTiming({ ...start, durationMinutes: 0 })).toThrow(RecurrenceError);
    expect(() => validateTiming({ ...start, durationMinutes: 10_081 })).toThrow(RecurrenceError);
    expect(() => validateTiming({ allDay: true, startDate: "2026-05-01", endDate: "2026-05-01" })).toThrow(RecurrenceError);
    expect(() => validateTiming({ allDay: true, startDate: "2026-05-01", endDate: "2027-05-03" })).toThrow(RecurrenceError);
    expect(() => validateTiming({ allDay: true, startDate: "2026-05-01", endDate: "2026-05-02" })).not.toThrow();
  });

  test("seriesBounds stores the first start and the latest end", () => {
    expect(seriesBounds(timed("2026-05-01T08:00", null, { tz: "Europe/Berlin", durationMinutes: 90 }))).toEqual({ startUtc: "2026-05-01T06:00:00.000Z", seriesEndUtc: "2026-05-01T07:30:00.000Z" });
    expect(seriesBounds(timed("2026-05-01T08:00", { freq: "daily", interval: 2, count: 3 }))).toEqual({ startUtc: "2026-05-01T08:00:00.000Z", seriesEndUtc: "2026-05-05T09:00:00.000Z" });
    expect(seriesBounds(timed("2026-05-01T08:00", { freq: "weekly", interval: 1, until: "2026-05-29" }))).toEqual({ startUtc: "2026-05-01T08:00:00.000Z", seriesEndUtc: "2026-05-29T09:00:00.000Z" });
    expect(seriesBounds(timed("2026-05-01T08:00", { freq: "daily", interval: 1 })).seriesEndUtc).toBeNull();
    expect(seriesBounds(allDay("2026-05-01", "2026-05-03", null))).toEqual({ startUtc: "2026-05-01T00:00:00.000Z", seriesEndUtc: "2026-05-03T00:00:00.000Z" });
    expect(seriesBounds(allDay("2026-01-31", "2026-02-01", { freq: "monthly", interval: 1, count: 2 })).seriesEndUtc).toBe("2026-04-01T00:00:00.000Z");
  });

  test("nextOccurrence finds the next start at or after an instant, skipping exdates, and null after the end", () => {
    const daily = timed("2026-05-01T09:00", { freq: "daily", interval: 1, count: 5 }, { tz: "Europe/Berlin", exdates: ["2026-05-03"] });
    expect(nextOccurrence(daily, Date.parse("2026-05-01T07:00:00Z"), "UTC")).toEqual({ date: "2026-05-01", startMs: Date.parse("2026-05-01T07:00:00Z") });
    expect(nextOccurrence(daily, Date.parse("2026-05-01T07:00:01Z"), "UTC")?.date).toBe("2026-05-02");
    expect(nextOccurrence(daily, Date.parse("2026-05-02T08:00:00Z"), "UTC")?.date).toBe("2026-05-04");
    expect(nextOccurrence(daily, Date.parse("2026-05-06T00:00:00Z"), "UTC")).toBeNull();
    expect(nextOccurrence(timed("2026-05-01T09:00", null), Date.parse("2026-05-02T00:00:00Z"), "UTC")).toBeNull();
    // All-day occurrences start at midnight in the asker's zone.
    expect(nextOccurrence(allDay("2026-05-10", "2026-05-11", null), Date.parse("2026-05-01T00:00:00Z"), "Asia/Kolkata")?.startMs).toBe(Date.parse("2026-05-09T18:30:00Z"));
    // Endless series far in the past stay cheap.
    expect(nextOccurrence(timed("1990-01-01T07:00", { freq: "weekly", interval: 1 }), Date.parse("2026-05-01T00:00:00Z"), "UTC")?.date).toBe("2026-05-04");
  });

  test("isOccurrenceDate matches only real occurrence starts", () => {
    const series = timed("2026-01-31T09:00", { freq: "monthly", interval: 1 });
    expect(isOccurrenceDate(series, "2026-03-31")).toBe(true);
    expect(isOccurrenceDate(series, "2026-02-28")).toBe(false);
    expect(isOccurrenceDate(series, "2025-12-31")).toBe(false);
    expect(isOccurrenceDate(timed("2026-05-01T09:00", null), "2026-05-01")).toBe(true);
    expect(isOccurrenceDate(timed("2026-05-01T09:00", { freq: "daily", interval: 1, count: 2 }), "2026-05-03")).toBe(false);
    expect(isOccurrenceDate(timed("2026-05-01T09:00", null), "not-a-date")).toBe(false);
  });
});
