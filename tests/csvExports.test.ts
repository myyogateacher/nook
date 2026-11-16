import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createBooking } = await import("../server/bookings/service");
const { typeRow } = await import("../server/bookings/model");

/**
 * D1387: CSV exports for Goals, Standups, Bookings, and Tasks boards, as Forms, Time, Contacts,
 * Collections, and Townhall write them: a UTF-8 BOM, CRLF lines, formula cells neutralized (T514),
 * `no-store`, an attachment; only what the caller can read; audited.
 */

let owner: Session;
let member: Session;
let outsider: Session;

const raw = (session: Session, path: string) => request(path, {}, session);
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> };
};
/** The CSV's rows (after the BOM), split naively: tests keep commas and quotes out of their values unless checking them. */
async function csv(session: Session, path: string) {
  const response = await raw(session, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-disposition")).toStartWith("attachment;");
  const bytes = new Uint8Array(await response.arrayBuffer());
  // The UTF-8 BOM (fetch's text() would drop it).
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.slice(3));
  expect(text.endsWith("\r\n")).toBe(true);
  return { text, lines: text.trimEnd().split("\r\n") };
}
const audited = (actor: string, event: string) => (db.query("SELECT COUNT(*) AS count FROM audit_log WHERE actor_id = ? AND event_type = ?").get(actor, event) as { count: number }).count;

beforeAll(async () => {
  owner = await createUser("Export owner");
  member = await createUser("Export member");
  outsider = await createUser("Export outsider");
});

describe("CSV exports (D1387)", () => {
  test("a board's cards: key, column, assignees; formulas neutralized; readers only", async () => {
    const created = await api(owner, "POST", "/tasks/boards", { name: "Export board" });
    const boardId = created.body.board.id as string;
    const column = created.body.columns[0].id as string;
    await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: column, title: "=HYPERLINK(\"x\")" });
    await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: column, title: "Plain card" });
    const file = await csv(owner, `/tasks/boards/${boardId}/export.csv`);
    expect(file.lines[0]).toStartWith("Key,Title,Column,Done,Priority,Assignees");
    expect(file.lines).toHaveLength(3);
    expect(file.text).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(file.lines[2]).toContain("Plain card");
    expect((await raw(outsider, `/tasks/boards/${boardId}/export.csv`)).status).toBe(404);
    expect(audited(owner.userId, "tasks.export")).toBe(1);
  });

  test("goals: the list the viewer sees, with its filters", async () => {
    await api(owner, "POST", "/goals", { title: "Export goal" });
    await api(owner, "POST", "/goals", { title: "+Risky goal" });
    const file = await csv(owner, "/goals/export.csv?mine=1");
    expect(file.lines[0]).toBe("Goal,Kind,State,Health,Progress %,Expected %,Owner,Team,Period,Start,Due,Key results,Last check-in,Link");
    expect(file.text).toContain("Export goal");
    expect(file.text).toContain("\"'+Risky goal\"");
    const searched = await csv(owner, "/goals/export.csv?mine=1&q=Export");
    expect(searched.lines.slice(1).every((line) => line.includes("Export goal"))).toBe(true);
    expect(audited(owner.userId, "goals.export")).toBe(2);
  });

  test("a standup: one row per participant per round, answers by question; outsiders get 404", async () => {
    const created = await api(owner, "POST", "/checkins", { template: "standup", name: "Export standup", participants: { people: [owner.userId, member.userId], groups: [] } });
    const checkin = created.body.checkin;
    const round = (await api(owner, "POST", `/checkins/${checkin.id}/rounds`, {})).body.round.round.id as string;
    expect((await api(member, "POST", `/checkin-rounds/${round}/answer`, { answers: { done: "Shipped the export", plan: "-Tests" } })).status).toBe(201);
    const file = await csv(member, `/checkins/${checkin.id}/export.csv`);
    expect(file.lines[0]).toStartWith("Date,Person,Status,Submitted,");
    const mine = file.lines.find((line) => line.includes("Export member"))!;
    expect(mine).toContain("Answered");
    expect(mine).toContain("Shipped the export");
    expect(mine).toContain("\"'-Tests\"");
    expect(file.lines.find((line) => line.includes("Export owner"))).toContain("Not answered");
    expect((await raw(outsider, `/checkins/${checkin.id}/export.csv`)).status).toBe(404);
  });

  test("bookings: the host's list, by view; others see none of them", async () => {
    const type = (await api(owner, "POST", "/bookings/types", { title: "Export call", minNotice: 0 })).body.type;
    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(10, 0, 0, 0);
    createBooking({ type: typeRow(type.id)!, start: start.toISOString(), durationMin: 30, booker: { name: "@Ada", email: "ada@example.org", tz: "UTC" }, source: "internal", actorId: owner.userId });
    const file = await csv(owner, "/bookings/export.csv?view=upcoming");
    expect(file.lines[0]).toStartWith("Start (UTC),End (UTC),Minutes,Type,Host");
    const row = file.lines.find((line) => line.includes("Export call"))!;
    expect(row).toContain("\"'@Ada\"");
    expect(row).toContain("ada@example.org");
    const other = await csv(outsider, "/bookings/export.csv?view=upcoming");
    expect(other.text).not.toContain("Export call");
    expect(audited(owner.userId, "bookings.export")).toBe(1);
  });
});
