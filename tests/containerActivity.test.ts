import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, request, type Session } from "./support/harness";
import { canCommentAtLevel } from "../src/ui/activity/activityAccess";
import { module as bookingsModule } from "../src/bookings/module";
import { module as timeModule } from "../src/time/module";
import { module as townhallModule } from "../src/townhall/module";
import type { ItemActivityEntry } from "../shared/itemActivity";

/**
 * Activity panels on module containers (docs/plan/WORKSPACE_MODULES.md §B.5, D1375): a form, a standup,
 * a townhall session, a booking type, and a time project each record history under their own kind;
 * the item activity and comments endpoints serve it to anyone who can read the container and answer
 * 404 to anyone else (T501), which is what the new Activity tabs read.
 */

type Json = Record<string, any>;
const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { json = { text }; }
  return { status: response.status, body: json, etag: response.headers.get("ETag") };
};

const QUESTIONS = { version: 1, sections: [], endings: [], logic: [], questions: [{ id: "q", type: "short_text", title: "Anything?" }] };

let owner: Session;
let reader: Session;
let stranger: Session;
const items: Array<{ kind: string; id: string; expect: string }> = [];

beforeAll(async () => {
  owner = await createUser("Activity owner");
  reader = await createUser("Activity reader");
  stranger = await createUser("Activity stranger");
  const form = await api(owner, "POST", "/forms", { kind: "form", title: "Activity form", questions: QUESTIONS, publish: true });
  expect(form.status).toBe(201);
  items.push({ kind: "form", id: form.body.form.id, expect: "published" });
  const standup = await api(owner, "POST", "/checkins", { template: "standup", name: "Activity standup" });
  expect(standup.status).toBe(201);
  items.push({ kind: "checkin", id: standup.body.checkin.id, expect: "created" });
  const session = await api(owner, "POST", "/townhall/sessions", { title: "Activity townhall" });
  expect(session.status).toBe(201);
  items.push({ kind: "townhall_session", id: session.body.session.id, expect: "created" });
  const type = await api(owner, "POST", "/bookings/types", { title: "Activity call", minNotice: 0 });
  expect(type.status).toBe(201);
  items.push({ kind: "booking_type", id: type.body.type.id, expect: "created" });
  const project = await api(owner, "POST", "/time/projects", { name: "Activity project" });
  expect(project.status).toBe(201);
  items.push({ kind: "time_project", id: project.body.project.id, expect: "time_project_created" });
  for (const item of items) {
    const current = await api(owner, "GET", `/access/${item.kind}/${item.id}`);
    expect(current.status).toBe(200);
    const shared = await request(`/access/${item.kind}/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-Match": current.etag! }, body: JSON.stringify({ audience: "selected", people: [{ id: reader.userId, level: "view" }] }) }, owner);
    expect(shared.status).toBe(200);
  }
});

describe("container activity (D1375)", () => {
  test("a reader of each container gets its recorded history and its comments", async () => {
    for (const item of items) {
      const activity = await api(reader, "GET", `/items/${item.kind}/${item.id}/activity`);
      expect(activity.status, item.kind).toBe(200);
      expect((activity.body.entries as ItemActivityEntry[]).map((entry) => entry.kind), item.kind).toContain(item.expect);
      const comments = await api(reader, "GET", `/items/${item.kind}/${item.id}/comments`);
      expect(comments.status, item.kind).toBe(200);
    }
  });

  test("someone who cannot read the container gets the same 404 as a missing one", async () => {
    for (const item of items) {
      expect((await api(stranger, "GET", `/items/${item.kind}/${item.id}/activity`)).status, item.kind).toBe(404);
      expect((await api(stranger, "GET", `/items/${item.kind}/${item.id}/comments`)).status, item.kind).toBe(404);
    }
  });

  test("a viewer reads the panel but cannot comment; an owner can", async () => {
    const [form] = items;
    expect((await api(reader, "POST", `/items/form/${form!.id}/comments`, { body: "Looks good" })).status).toBe(403);
    expect((await api(owner, "POST", `/items/form/${form!.id}/comments`, { body: "Published it" })).status).toBe(201);
  });
});

describe("Activity panel helpers (D1375)", () => {
  test("comment level and up may comment; view and no level may not", () => {
    expect(["owner", "manage", "edit", "comment"].map(canCommentAtLevel)).toEqual([true, true, true, true]);
    expect([canCommentAtLevel("view"), canCommentAtLevel(null), canCommentAtLevel(undefined), canCommentAtLevel("public")]).toEqual([false, false, false, false]);
  });

  test("Time, Bookings, and Townhall draw their own activity kinds instead of “updated this”", () => {
    const entry = (kind: string, payload: ItemActivityEntry["payload"]) => ({ kind, payload }) as ItemActivityEntry;
    expect(timeModule.activityRenderers!.time_week_submitted!(entry("time_week_submitted", { extra: { weekStart: "2026-11-09" } }))).toBe("submitted the week of 2026-11-09");
    expect(timeModule.activityRenderers!.time_project_changed!(entry("time_project_changed", { to: { label: "Retainer" } }))).toBe("renamed it to “Retainer”");
    expect(bookingsModule.activityRenderers!.type_renamed!(entry("type_renamed", { to: { label: "Intro" } }))).toBe("renamed it to “Intro”");
    expect(bookingsModule.activityRenderers!.type_updated!(entry("type_updated", {}))).toBe("changed the settings");
    expect(townhallModule.activityRenderers!.title!(entry("title", { to: { label: "All hands" } }))).toBe("renamed it to “All hands”");
  });
});
