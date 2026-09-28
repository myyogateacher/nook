import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createUser, db, request, type Session } from "./support/harness";
import { newCollection, shareCollection } from "./support/collections";

/**
 * T84 (Team plan §5.3): a guest is never part of an `all_users` audience, in any module, while a
 * viewer is; both still read what is shared with them by name. One owner shares one item per module
 * with everyone and one with a named guest, and each reader's view is checked through every read
 * path (lists, single reads, search, Today, the task query, and views).
 */

type Role = "admin" | "member" | "viewer" | "guest";
async function user(label: string, role: Role = "member") {
  const session = await createUser(label);
  if (role !== "member") db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

const send = async (session: Session, method: string, path: string, body?: unknown) => {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
const ok = async (session: Session, method: string, path: string, body?: unknown) => {
  const result = await send(session, method, path, body);
  expect({ path, ok: result.status === 200 || result.status === 201 }).toEqual({ path, ok: true });
  return result.body;
};

async function publishedNote(owner: Session, folderId: string | null, markdown: string) {
  const id = (await ok(owner, "POST", "/notes", { folderId })).note.id as string;
  await ok(owner, "PUT", `/notes/${id}/draft`, { markdown, revision: 1 });
  await ok(owner, "POST", `/notes/${id}/publish`);
  return id;
}

async function upload(owner: Session, name: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob(["guest audience"], { type: "text/plain" }), name);
  const response = await request(`/files${folderId ? `?folderId=${folderId}` : ""}`, { method: "POST", body: form }, owner);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

describe("guests and all_users audiences (T84)", () => {
  test("guests see only named shares across notes, files, tasks, collections, calendar, search, and Today; viewers see everyone's too", async () => {
    const owner = await user("Audience owner");
    const viewer = await user("Audience viewer", "viewer");
    const guest = await user("Audience guest", "guest");
    const named = await user("Audience named guest", "guest");
    const marker = `gaudience${crypto.randomUUID().slice(0, 8)}`;

    // Notes and folders: an everyone folder with a note, an everyone override, and a named share.
    const everyoneFolder = (await ok(owner, "POST", "/folders", { name: `${marker} everyone`, parentId: null })).folder.id as string;
    await ok(owner, "PUT", `/folders/${everyoneFolder}/sharing`, { visibility: "all_users", userIds: [] });
    const namedFolder = (await ok(owner, "POST", "/folders", { name: `${marker} named`, parentId: null })).folder.id as string;
    await ok(owner, "PUT", `/folders/${namedFolder}/sharing`, { visibility: "selected", userIds: [named.userId] });
    const notes = {
      inEveryoneFolder: await publishedNote(owner, everyoneFolder, `# Folder ${marker}`),
      everyoneOverride: await publishedNote(owner, null, `# Override ${marker}`),
      inNamedFolder: await publishedNote(owner, namedFolder, `# Named folder ${marker}`),
      namedOverride: await publishedNote(owner, null, `# Named ${marker}`)
    };
    await ok(owner, "PUT", `/notes/${notes.everyoneOverride}/sharing`, { visibility: "all_users", userIds: [] });
    await ok(owner, "PUT", `/notes/${notes.namedOverride}/sharing`, { visibility: "selected", userIds: [named.userId] });

    // Files: one inherits the everyone folder, one is an everyone override, one is shared by name.
    const files = {
      inEveryoneFolder: await upload(owner, `${marker}-folder.txt`, everyoneFolder),
      everyoneOverride: await upload(owner, `${marker}-override.txt`),
      namedOverride: await upload(owner, `${marker}-named.txt`)
    };
    await ok(owner, "PUT", `/files/${files.everyoneOverride}/sharing`, { visibility: "all_users", userIds: [] });
    await ok(owner, "PUT", `/files/${files.namedOverride}/sharing`, { visibility: "selected", userIds: [named.userId] });

    // Tasks: an everyone board and a named board, each with a card; an everyone view.
    const everyoneBoard = await ok(owner, "POST", "/tasks/boards", { name: `${marker} everyone board` });
    await ok(owner, "PUT", `/tasks/boards/${everyoneBoard.board.id}/sharing`, { visibility: "all_users", userIds: [] });
    await ok(owner, "POST", `/tasks/boards/${everyoneBoard.board.id}/cards`, { columnId: everyoneBoard.columns[0].id, title: `${marker} everyone card` });
    const namedBoard = await ok(owner, "POST", "/tasks/boards", { name: `${marker} named board` });
    await ok(owner, "PUT", `/tasks/boards/${namedBoard.board.id}/sharing`, { visibility: "selected", userIds: [named.userId] });
    await ok(owner, "POST", `/tasks/boards/${namedBoard.board.id}/cards`, { columnId: namedBoard.columns[0].id, title: `${marker} named card`, assigneeIds: [named.userId] });
    const view = (await ok(owner, "POST", "/tasks/views", { name: `${marker} view`, query: "" })).view.id as string;
    await ok(owner, "PUT", `/tasks/views/${view}/sharing`, { visibility: "all_users", userIds: [] });

    // Collections and calendars.
    const everyoneCollection = await newCollection(owner, { name: `${marker} everyone collection`, fields: [{ name: "Name", type: "text" }] });
    await shareCollection(owner, everyoneCollection.id, "all_users", [], "editor");
    const namedCollection = await newCollection(owner, { name: `${marker} named collection`, fields: [{ name: "Name", type: "text" }] });
    await shareCollection(owner, namedCollection.id, "selected", [named.userId]);
    const everyoneCalendar = (await ok(owner, "POST", "/calendars", { name: `${marker} everyone calendar`, color: "green" })).calendar.id as string;
    await ok(owner, "PUT", `/calendars/${everyoneCalendar}/sharing`, { visibility: "all_users", shareRole: "editor", userIds: [] });
    const namedCalendar = (await ok(owner, "POST", "/calendars", { name: `${marker} named calendar`, color: "blue" })).calendar.id as string;
    await ok(owner, "PUT", `/calendars/${namedCalendar}/sharing`, { visibility: "selected", shareRole: "viewer", userIds: [named.userId] });
    const event = { allDay: false, startLocal: "2026-05-04T09:00", tz: "UTC", durationMinutes: 30 };
    const everyoneEvent = (await ok(owner, "POST", `/calendars/${everyoneCalendar}/events`, { ...event, title: `${marker} everyone event` })).event.id as string;
    const namedEvent = (await ok(owner, "POST", `/calendars/${namedCalendar}/events`, { ...event, title: `${marker} named event` })).event.id as string;

    const everyoneIds = [notes.inEveryoneFolder, notes.everyoneOverride, files.inEveryoneFolder, files.everyoneOverride, everyoneBoard.board.id, everyoneCollection.id, everyoneCalendar, everyoneEvent, view, everyoneFolder];
    const namedIds = [notes.inNamedFolder, notes.namedOverride, files.namedOverride, namedBoard.board.id, namedCollection.id, namedCalendar, namedEvent, namedFolder];

    /** Everything a reader can reach, as one string per read path. */
    async function reach(session: Session, guestQuery = false) {
      const paths = [
        "/notes", "/folders", "/files", "/tasks/boards", "/tasks/views", "/collections", "/calendars",
        "/events?from=2026-05-01&to=2026-05-10&tz=UTC", `/search?q=${marker}`, "/today?tz=UTC"
      ];
      const seen: Record<string, string> = {};
      for (const path of paths) {
        const result = await send(session, "GET", path);
        expect({ path, status: result.status }).toEqual({ path, status: 200 });
        seen[path] = result.text;
      }
      // The query echoes the board ids it was given, so only its cards count (checked by title below).
      // Guests may only run "my work" queries (assignee:me); the named card is assigned to the named guest.
      const mine = guestQuery ? "assignee:me " : "";
      const query = (await send(session, "POST", "/tasks/query", { q: `${mine}board:${everyoneBoard.board.id}` })).text
        + (await send(session, "POST", "/tasks/query", { q: `${mine}board:${namedBoard.board.id}` })).text;
      // Single reads: 200 when readable, 404 otherwise.
      const single: Record<string, number> = {
        [notes.inEveryoneFolder]: (await send(session, "GET", `/notes/${notes.inEveryoneFolder}`)).status,
        [notes.everyoneOverride]: (await send(session, "GET", `/notes/${notes.everyoneOverride}`)).status,
        [notes.inNamedFolder]: (await send(session, "GET", `/notes/${notes.inNamedFolder}`)).status,
        [notes.namedOverride]: (await send(session, "GET", `/notes/${notes.namedOverride}`)).status,
        [files.inEveryoneFolder]: (await send(session, "GET", `/files/${files.inEveryoneFolder}`)).status,
        [files.everyoneOverride]: (await send(session, "GET", `/files/${files.everyoneOverride}`)).status,
        [files.namedOverride]: (await send(session, "GET", `/files/${files.namedOverride}`)).status,
        [everyoneBoard.board.id]: (await send(session, "GET", `/tasks/boards/${everyoneBoard.board.id}`)).status,
        [namedBoard.board.id]: (await send(session, "GET", `/tasks/boards/${namedBoard.board.id}`)).status,
        [view]: (await send(session, "GET", `/tasks/views/${view}`)).status,
        [everyoneCollection.id]: (await send(session, "GET", `/collections/${everyoneCollection.id}`)).status,
        [namedCollection.id]: (await send(session, "GET", `/collections/${namedCollection.id}`)).status,
        [everyoneEvent]: (await send(session, "GET", `/events/${everyoneEvent}`)).status,
        [namedEvent]: (await send(session, "GET", `/events/${namedEvent}`)).status
      };
      const all = Object.values(seen).join("\n");
      return { all, query, single };
    }

    const expectReach = async (label: string, session: Session, everyone: boolean, byName: boolean, guestQuery = false) => {
      const { all, query, single } = await reach(session, guestQuery);
      for (const id of everyoneIds) expect({ label, id, listed: all.includes(id) }).toEqual({ label, id, listed: everyone });
      for (const id of namedIds) expect({ label, id, listed: all.includes(id) }).toEqual({ label, id, listed: byName });
      for (const [id, status] of Object.entries(single)) {
        const expected = everyoneIds.includes(id) ? everyone : byName;
        expect({ label, id, status }).toEqual({ label, id, status: expected ? 200 : 404 });
      }
      // Cards come through the task query (and Today, for assignees).
      expect({ label, everyoneCard: query.includes(`${marker} everyone card`), namedCard: query.includes(`${marker} named card`) })
        .toEqual({ label, everyoneCard: everyone, namedCard: byName });
    };

    await expectReach("viewer", viewer, true, false);
    await expectReach("guest", guest, false, false, true);
    await expectReach("named guest", named, false, true, true);

    // An everyone board lists only non-guests as readers (assignee picker), plus the owner.
    const readers = (await ok(owner, "GET", `/tasks/boards/${everyoneBoard.board.id}/readers`)).users as Array<{ id: string }>;
    expect(readers.some((row) => row.id === viewer.userId)).toBe(true);
    expect(readers.some((row) => row.id === guest.userId)).toBe(false);

    // Promotion applies at once: the same guest, made a member, joins the everyone audience.
    db.query("UPDATE users SET role = 'member' WHERE id = ?").run(guest.userId);
    expect((await send(guest, "GET", `/notes/${notes.everyoneOverride}`)).status).toBe(200);
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);

    // Leave no everyone items behind for other test files.
    await send(owner, "PUT", `/folders/${everyoneFolder}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/notes/${notes.everyoneOverride}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/files/${files.everyoneOverride}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/tasks/boards/${everyoneBoard.board.id}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/tasks/views/${view}/sharing`, { visibility: "private", userIds: [] });
    await send(owner, "PUT", `/collections/${everyoneCollection.id}/sharing`, { visibility: "private", userIds: [], role: "viewer" });
    await send(owner, "PUT", `/calendars/${everyoneCalendar}/sharing`, { visibility: "private", shareRole: "viewer", userIds: [] });
  }, 30_000);
});

describe("guests in groups (Wave 32, D.2, T213)", () => {
  test("a guest reached through a group reads the item, never above view, and still never matches all_users", async () => {
    const admin = await user("Group guest admin", "admin");
    const owner = await user("Group guest owner");
    const guest = await user("Group guest", "guest");
    const group = (await send(admin, "POST", "/team/groups", { name: `Guests ${crypto.randomUUID().slice(0, 8)}` })).body.group;
    await send(admin, "PUT", `/team/groups/${group.id}/members`, { userIds: [guest.userId], revision: 1 });
    const created = (await send(owner, "POST", "/tasks/boards", { name: "Group guest board" })).body;
    const board = created.board.id as string;
    const etag = (await send(owner, "GET", `/tasks/boards/${board}/access`)).body.etag as string;
    const response = await request(`/tasks/boards/${board}/access`, { method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ audience: "selected", groups: [{ id: group.id, level: "edit" }] }) }, owner);
    expect(response.status).toBe(200);
    const read = await send(guest, "GET", `/tasks/boards/${board}`);
    expect(read.status).toBe(200);
    expect(read.body.board.level).toBe("view");
    expect((await send(guest, "POST", `/tasks/boards/${board}/cards`, { columnId: created.columns[0].id, title: "No" })).status).toBe(403);
    // The same board shared with everyone instead: the guest drops out, group or not.
    const next = (await send(owner, "GET", `/tasks/boards/${board}/access`)).body.etag as string;
    await request(`/tasks/boards/${board}/access`, { method: "PUT", headers: { "If-Match": next }, body: JSON.stringify({ audience: "all_users" }) }, owner);
    expect((await send(guest, "GET", `/tasks/boards/${board}`)).status).toBe(404);
    await send(owner, "PUT", `/tasks/boards/${board}/sharing`, { visibility: "private", userIds: [] });
    await send(admin, "DELETE", `/team/groups/${group.id}`, {});
  });
});

describe("AUDIENCE_ALL_USERS guard (T84)", () => {
  const serverRoot = join(import.meta.dir, "..", "server");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "migrations") walk(path);
      } else if (entry.endsWith(".ts")) files.push(path);
    }
  };
  walk(serverRoot);

  test("every SQL comparison with 'all_users' is ANDed with the guest exclusion", () => {
    expect(files.length).toBeGreaterThan(40);
    const offenders: string[] = [];
    let guarded = 0;
    for (const path of files) {
      if (path.endsWith(join("team", "roles.ts"))) continue; // defines the fragment
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/visibility\s*=\s*'all_users'/g)) {
        const after = source.slice(match.index! + match[0].length, match.index! + match[0].length + 40);
        if (/^\s+AND\s+\$\{(AUDIENCE_ALL_USERS|audienceAllUsersFor\()/.test(after)) guarded += 1;
        else offenders.push(`${path.slice(serverRoot.length + 1)}: ${source.slice(match.index!, match.index! + 60).split("\n")[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // Notes (3), folders (1), files (3), search (1), boards (4), views (2), assignees (1), collections, calendars.
    expect(guarded).toBeGreaterThanOrEqual(16);
  });

  test("the fragment excludes guests and fails closed for unknown users", async () => {
    const { AUDIENCE_ALL_USERS } = await import("../server/team/roles");
    const member = await user("Guard member");
    const viewer = await user("Guard viewer", "viewer");
    const guest = await user("Guard guest", "guest");
    const check = (userId: string) => (db.query(`SELECT ${AUDIENCE_ALL_USERS} AS ok`).get({ userId }) as { ok: number | null }).ok;
    expect(check(member.userId)).toBe(1);
    expect(check(viewer.userId)).toBe(1);
    expect(check(guest.userId)).toBe(0);
    expect(check(crypto.randomUUID())).toBeNull();
  });
});
