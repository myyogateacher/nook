import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { resetTodayRateLimit, TODAY_RATE_LIMIT } = await import("../server/today/routes");
const { addDays, dateInZone, loadToday, registerTodayProvider, todayContext, todaySectionNames, validTimeZone } = await import("../server/today/registry");
const { createMcpApiKey } = await import("../server/mcp");
const { createDraftNote } = await import("../server/noteDrafts");

beforeEach(() => resetTodayRateLimit());

type Section = { items: Array<Record<string, any>>; more: boolean; href: string; error?: string };
type Today = { generatedAt: string; date: string; sections: Record<string, Section> };

async function json<T>(response: Response) {
  return (await response.json()) as T;
}

async function today(session: Session, tz = "UTC") {
  resetTodayRateLimit();
  const response = await request(`/today?tz=${encodeURIComponent(tz)}`, {}, session);
  expect(response.status).toBe(200);
  return json<Today>(response);
}

const ids = (section: Section | undefined, key = "id") => (section?.items ?? []).map((item) => item[key] as string);
/** The ids among `known`: the test run shares one database, and other files share items with all users. */
const among = (section: Section | undefined, known: string[], key = "id") => ids(section, key).filter((id) => known.includes(id));

async function createNote(session: Session, markdown: string, options: { publish?: boolean; folderId?: string | null } = {}) {
  const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: options.folderId ?? null }) }, session);
  expect(created.status).toBe(201);
  const id = (await json<{ note: { id: string } }>(created)).note.id;
  if (markdown !== "") expect((await request(`/notes/${id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: 1 }) }, session)).status).toBe(200);
  if (options.publish) expect((await request(`/notes/${id}/publish`, { method: "POST", body: "{}" }, session)).status).toBe(200);
  return id;
}

async function saveDraft(session: Session, id: string, markdown: string) {
  const note = (await json<{ note: { draft_revision: number | null } }>(await request(`/notes/${id}`, {}, session))).note;
  expect((await request(`/notes/${id}/draft`, { method: "PUT", body: JSON.stringify({ markdown, revision: note.draft_revision }) }, session)).status).toBe(200);
}

async function createFolder(session: Session, name: string) {
  const response = await request("/folders", { method: "POST", body: JSON.stringify({ name }) }, session);
  expect(response.status).toBe(201);
  return (await json<{ folder: { id: string } }>(response)).folder.id;
}

async function shareFolder(owner: Session, folderId: string, recipients: Session[]) {
  const body = recipients.length ? { visibility: "selected", userIds: recipients.map((user) => user.userId) } : { visibility: "private", userIds: [] };
  expect((await request(`/folders/${folderId}/sharing`, { method: "PUT", body: JSON.stringify(body) }, owner)).status).toBe(200);
}

async function upload(session: Session, content: string, filename: string, options: { folderId?: string; purpose?: string } = {}) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const query = new URLSearchParams();
  if (options.folderId) query.set("folderId", options.folderId);
  if (options.purpose) query.set("purpose", options.purpose);
  const response = await request(`/files${query.size ? `?${query}` : ""}`, { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return (await json<{ document: { id: string } }>(response)).document.id;
}

async function tasks(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

async function board(owner: Session, name: string, members: Session[] = []) {
  const created = await tasks(owner, "POST", "/boards", { name });
  const boardId = created.body.board.id as string;
  const [todo, doing, done] = (created.body.columns as Array<{ id: string }>).map((column) => column.id) as [string, string, string];
  if (members.length) expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: members.map((user) => user.userId) })).status).toBe(200);
  return { boardId, todo, doing, done };
}

async function card(session: Session, boardId: string, columnId: string, title: string, dueOn?: string) {
  const created = await tasks(session, "POST", `/boards/${boardId}/cards`, dueOn ? { columnId, title, dueOn } : { columnId, title });
  expect(created.status).toBe(201);
  return created.body.card as { id: string; revision: number };
}

/**
 * T50 parity: every Today item is in the owning app's own list for the same
 * user (Notes list, Files list, the readable boards' cards, the Bin).
 */
async function expectParity(session: Session) {
  const view = await today(session);
  const notes = new Set((await json<{ notes: Array<{ id: string; is_owner: number }> }>(await request("/notes", {}, session))).notes.map((note) => note.id));
  for (const name of ["notesRecent", "drafts"]) for (const id of ids(view.sections[name])) expect(notes.has(id)).toBe(true);
  const files = new Set((await json<{ documents: Array<{ id: string }> }>(await request("/files", {}, session))).documents.map((document) => document.id));
  for (const id of ids(view.sections.files)) expect(files.has(id)).toBe(true);
  const boards = (await tasks(session, "GET", "/boards")).body.boards as Array<{ id: string }>;
  const cards = new Set<string>();
  for (const item of boards) for (const listed of (await tasks(session, "GET", `/boards/${item.id}`)).body.cards as Array<{ id: string }>) cards.add(listed.id);
  for (const name of ["tasksDue", "tasksMine"]) for (const id of ids(view.sections[name], "cardId")) expect(cards.has(id)).toBe(true);
  const bin = new Set((await json<{ items: Array<{ id: string }> }>(await request("/bin", {}, session))).items.map((item) => item.id));
  for (const id of ids(view.sections.binSoon)) expect(bin.has(id)).toBe(true);
  return view;
}

describe("GET /api/today", () => {
  test("returns every installed section, bounded, with hrefs and no bodies", async () => {
    const user = await createUser("Today shape");
    const view = await today(user, "Europe/Berlin");
    // agentDrafts retired with the agent inbox (D158): MCP drafts are listed under proposals.
    expect(Object.keys(view.sections)).toEqual(["tasksDue", "tasksMine", "notesRecent", "drafts", "files", "collectionsRecent", "binSoon", "upcoming", "storage", "proposals"]);
    // Calendar (W12) is installed: a user with no calendars gets an empty section linking to /calendar.
    expect(view.sections.upcoming).toEqual({ items: [], more: false, href: "/calendar" });
    expect(view.date).toBe(dateInZone(new Date(view.generatedAt), "Europe/Berlin"));
    expect(view.sections.notesRecent).toMatchObject({ href: "/notes", more: expect.any(Boolean) });
    expect(view.sections.drafts).toEqual({ items: [], more: false, href: "/notes" });
    expect(view.sections.storage!.items).toEqual([{ usedBytes: 0, binnedBytes: 0, quotaBytes: 12582912 }]);
    expect(view.sections.binSoon!.href).toBe("/bin");
  });

  test("upcoming lists the next occurrences on readable calendars, ids and times only", async () => {
    const user = await createUser("Today upcoming");
    const stranger = await createUser("Today upcoming stranger");
    const calendar = ((await (await request("/calendars", { method: "POST", body: JSON.stringify({ name: "Family" }) }, user)).json()) as { calendar: { id: string } }).calendar;
    const tomorrow = addDays(dateInZone(new Date(), "UTC"), 1);
    const created = await request(`/calendars/${calendar.id}/events`, { method: "POST", body: JSON.stringify({ title: "Dentist", description: "Bring the form", allDay: false, startLocal: `${tomorrow}T09:00`, tz: "UTC", durationMinutes: 30 }) }, user);
    expect(created.status).toBe(201);
    const eventId = ((await created.json()) as { event: { id: string } }).event.id;
    const view = await today(user, "UTC");
    expect(view.sections.upcoming).toEqual({
      items: [{ eventId, calendarId: calendar.id, title: "Dentist", start: `${tomorrow}T09:00:00.000Z`, end: `${tomorrow}T09:30:00.000Z`, allDay: false, date: tomorrow }],
      more: false, href: "/calendar"
    });
    expect(JSON.stringify(view)).not.toContain("Bring the form");
    expect((await today(stranger, "UTC")).sections.upcoming!.items).toEqual([]);
  });

  test("validates tz, limits sections, and rate-limits at 30 a minute per user", async () => {
    const user = await createUser("Today limits");
    const other = await createUser("Today limits other");
    for (const tz of ["", "Not/AZone", "UTC; DROP", "../etc", "x".repeat(80)]) {
      expect((await request(`/today?tz=${encodeURIComponent(tz)}`, {}, user)).status).toBe(400);
    }
    expect((await request("/today", {}, user)).status).toBe(400);
    expect((await request("/today?tz=UTC&sections=nope", {}, user)).status).toBe(400);
    const partial = await json<Today>(await request("/today?tz=UTC&sections=files,storage", {}, user));
    expect(Object.keys(partial.sections)).toEqual(["files", "storage"]);
    expect((await request("/today?tz=UTC", {})).status).toBe(401);

    resetTodayRateLimit();
    for (let index = 0; index < TODAY_RATE_LIMIT; index += 1) expect((await request("/today?tz=UTC", {}, user)).status).toBe(200);
    const limited = await request("/today?tz=UTC", {}, user);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    // Per user.
    expect((await request("/today?tz=UTC", {}, other)).status).toBe(200);
  });

  test("time zones: the date and overdue flags follow tz at UTC+14 and UTC-12 midnights", async () => {
    expect(validTimeZone("Pacific/Kiritimati")).toBe("Pacific/Kiritimati");
    expect(validTimeZone("Etc/GMT+12")).toBe("Etc/GMT+12");
    expect(validTimeZone("UTC")).toBe("UTC");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    // An alias a browser still reports is accepted as sent.
    expect(validTimeZone("Asia/Calcutta")).toBe("Asia/Calcutta");
    // 10:00Z is midnight on the 26th at UTC+14; 12:00Z is midnight on the 25th at UTC-12.
    expect(dateInZone(new Date("2026-09-25T10:00:00Z"), "Pacific/Kiritimati")).toBe("2026-09-26");
    expect(dateInZone(new Date("2026-09-25T09:59:59Z"), "Pacific/Kiritimati")).toBe("2026-09-25");
    expect(dateInZone(new Date("2026-09-25T12:00:00Z"), "Etc/GMT+12")).toBe("2026-09-25");
    expect(dateInZone(new Date("2026-09-25T11:59:59Z"), "Etc/GMT+12")).toBe("2026-09-24");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");

    const owner = await createUser("Today tz");
    const { boardId, todo } = await board(owner, "Tz board");
    const dueToday = await card(owner, boardId, todo, "Due on the 25th", "2026-09-25");
    const edge = await card(owner, boardId, todo, "Due on the 2nd", "2026-10-02");
    const instant = new Date("2026-09-25T10:00:00Z");
    const east = (await loadToday(todayContext(owner.userId, "Pacific/Kiritimati", instant), ["tasksDue"])).sections.tasksDue!;
    expect(east.items.find((item: any) => item.cardId === dueToday.id)).toMatchObject({ overdue: true });
    expect(east.items.some((item: any) => item.cardId === edge.id)).toBe(true);
    const west = (await loadToday(todayContext(owner.userId, "Etc/GMT+12", instant), ["tasksDue"])).sections.tasksDue!;
    // At UTC-12 it is still the 24th: not overdue yet, and the 2nd is beyond seven days.
    expect(west.items.find((item: any) => item.cardId === dueToday.id)).toMatchObject({ overdue: false });
    expect(west.items.some((item: any) => item.cardId === edge.id)).toBe(false);
  });

  test("a failing provider errors only its own section; uninstalled modules are absent", async () => {
    const user = await createUser("Today failure");
    const removeBoom = registerTodayProvider("boom", { href: "/", load: () => { throw new Error("provider down"); } });
    const removeAbsent = registerTodayProvider("notInstalled", { href: "/", available: () => false, load: () => ({ items: [1], more: false }) });
    try {
      expect(todaySectionNames()).not.toContain("notInstalled");
      const view = await today(user);
      expect(view.sections.boom).toEqual({ items: [], more: false, href: "/", error: "This section could not be loaded" });
      expect(view.sections.notInstalled).toBeUndefined();
      expect(view.sections.storage!.error).toBeUndefined();
      expect(view.sections.notesRecent!.error).toBeUndefined();
      // An over-long page from a provider is still cut to ten.
      removeBoom();
      const removeLong = registerTodayProvider("longList", { href: "/", load: () => ({ items: Array.from({ length: 50 }, (_, index) => index), more: false }) });
      const long = (await today(user)).sections.longList!;
      removeLong();
      expect(long.items).toHaveLength(10);
      expect(long.more).toBe(true);
    } finally {
      removeBoom();
      removeAbsent();
    }
  });

  test("notes and drafts: the share matrix, unshare, bin, and drafts stay within the Notes list", async () => {
    const owner = await createUser("Today notes owner");
    const recipient = await createUser("Today notes recipient");
    const stranger = await createUser("Today notes stranger");
    const folderId = await createFolder(owner, "Today shared");
    await shareFolder(owner, folderId, [recipient]);
    const shared = await createNote(owner, "# Shared plan\n\nbody", { publish: true, folderId });
    const privateNote = await createNote(owner, "# Private plan", { publish: true });
    const unpublished = await createNote(owner, "# Only a draft", { folderId });
    const overridden = await createNote(owner, "# Direct share", { publish: true });
    expect((await request(`/notes/${overridden}/sharing`, { method: "PUT", body: JSON.stringify({ visibility: "selected", userIds: [recipient.userId] }) }, owner)).status).toBe(200);
    const blank = await createNote(owner, "");
    const all = [shared, privateNote, unpublished, overridden, blank];
    await saveDraft(owner, shared, "# Secret new title\n\nnot yet published");

    const ownerView = await expectParity(owner);
    expect(ids(ownerView.sections.notesRecent)).toEqual(expect.arrayContaining([shared, privateNote, overridden, blank]));
    // A never-published note listed under Unpublished drafts is not repeated in Recent notes.
    expect(ids(ownerView.sections.notesRecent)).not.toContain(unpublished);
    // Drafts: the edited published note and the unpublished one; not the blank one or clean published notes.
    expect(ids(ownerView.sections.drafts).sort()).toEqual([shared, unpublished].sort());
    expect(ownerView.sections.drafts!.items.find((item) => item.id === unpublished)).toMatchObject({ neverPublished: true, title: "Only a draft" });
    expect(ids(ownerView.sections.drafts)).not.toContain(blank);

    const recipientView = await expectParity(recipient);
    const recipientNotes = ids(recipientView.sections.notesRecent);
    expect(recipientNotes).toEqual(expect.arrayContaining([shared, overridden]));
    expect(recipientNotes).not.toContain(privateNote);
    // Recipients never see a note before it is published, nor the owner's draft title.
    expect(recipientNotes).not.toContain(unpublished);
    expect(recipientView.sections.notesRecent!.items.find((item) => item.id === shared)).toMatchObject({ title: "Shared plan", is_owner: 0, owner_name: "Today notes owner" });
    expect(recipientView.sections.drafts!.items).toEqual([]);
    expect(JSON.stringify(recipientView)).not.toContain("Secret new title");
    expect(among((await expectParity(stranger)).sections.notesRecent, all)).toEqual([]);

    // Unshare the folder, then bin the directly shared note.
    await shareFolder(owner, folderId, []);
    expect(among((await expectParity(recipient)).sections.notesRecent, all)).toEqual([overridden]);
    expect((await request(`/notes/${overridden}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(among((await expectParity(recipient)).sections.notesRecent, all)).toEqual([]);
    expect(ids((await expectParity(owner)).sections.notesRecent)).not.toContain(overridden);
  });

  test("agent drafts are listed apart from the owner's drafts, as proposals with the key name (D158)", async () => {
    const owner = await createUser("Today agent");
    const key = createMcpApiKey(owner.userId, "Laptop agent", ["notes:read", "notes:write-draft"]);
    const created = await createDraftNote(owner.userId, null, "# Agent summary\n\ntext", { keyId: key.id });
    const view = await expectParity(owner);
    expect(view.sections.agentDrafts).toBeUndefined();
    expect(view.sections.proposals!.items).toEqual([expect.objectContaining({ id: created.proposalId, kind: "note_draft", kindLabel: "Note draft", title: "Agent summary", keyName: "Laptop agent" })]);
    expect(view.sections.proposals!.href).toBe("/inbox");
    expect(ids(view.sections.drafts)).not.toContain(created.id);
    const recipient = await createUser("Today agent other");
    expect((await today(recipient)).sections.proposals!.items).toEqual([]);
  });

  test("proposals: ten plus more from an eleven-row fetch, never a COUNT (T51)", async () => {
    const owner = await createUser("Today proposals");
    const insert = db.query(`INSERT INTO proposals (id, owner_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
      VALUES (?, ?, 'agent', 'card_create', 'board', 'b', ?, '{}', ?, ?)`);
    for (let index = 0; index < 12; index += 1) insert.run(crypto.randomUUID(), owner.userId, `P${index}`, new Date(Date.now() - index * 1000).toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    const section = (await today(owner)).sections.proposals!;
    expect(section.items.length).toBe(10);
    expect(section.more).toBe(true);
    expect((section.items[0] as { title: string }).title).toBe("P0");
    const source = await Bun.file(new URL("../server/inbox/today.ts", import.meta.url)).text();
    expect(source).not.toMatch(/COUNT\(/i);
    db.query("DELETE FROM proposals WHERE owner_id = ?").run(owner.userId);
  });

  test("files: shared folders, attachments, unshare, and bin match the Files list; storage and binSoon", async () => {
    const owner = await createUser("Today files owner");
    const recipient = await createUser("Today files recipient");
    const folderId = await createFolder(owner, "Today files");
    await shareFolder(owner, folderId, [recipient]);
    const sharedFile = await upload(owner, "shared bytes", "shared.txt", { folderId });
    const privateFile = await upload(owner, "private", "private.txt");
    const attachment = await upload(owner, "attached", "attached.txt", { purpose: "task_attachment" });

    const ownerView = await expectParity(owner);
    expect(ids(ownerView.sections.files)).toEqual(expect.arrayContaining([sharedFile, privateFile]));
    expect(ids(ownerView.sections.files)).not.toContain(attachment);
    expect(ownerView.sections.files!.items[0]).not.toHaveProperty("sha256");
    const all = [sharedFile, privateFile, attachment];
    const recipientView = await expectParity(recipient);
    expect(among(recipientView.sections.files, all)).toEqual([sharedFile]);

    await shareFolder(owner, folderId, []);
    expect(among((await expectParity(recipient)).sections.files, all)).toEqual([]);

    expect((await request(`/files/${privateFile}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    let view = await expectParity(owner);
    expect(ids(view.sections.files)).not.toContain(privateFile);
    const total = "shared bytes".length + "private".length + "attached".length;
    expect(view.sections.storage!.items[0]).toEqual({ usedBytes: total, binnedBytes: "private".length, quotaBytes: 12582912 });
    // Thirty days away: not "soon". Two days away: soon, and only in the owner's view.
    expect(ids(view.sections.binSoon)).not.toContain(privateFile);
    db.query("UPDATE documents SET purge_after = ? WHERE id = ?").run(new Date(Date.now() + 2 * 86_400_000).toISOString(), privateFile);
    view = await expectParity(owner);
    expect(view.sections.binSoon!.items).toEqual([expect.objectContaining({ type: "document", id: privateFile, title: "private.txt" })]);
    expect(ids((await today(recipient)).sections.binSoon)).toEqual([]);
  });

  test("tasks: due and mine follow board access, done columns, member removal, and the Bin", async () => {
    const owner = await createUser("Today tasks owner");
    const member = await createUser("Today tasks member");
    const stranger = await createUser("Today tasks stranger");
    const { boardId, todo, doing, done } = await board(owner, "Today board", [member]);
    const date = dateInZone(new Date(), "UTC");
    const overdue = await card(owner, boardId, todo, "Overdue", addDays(date, -3));
    const soon = await card(owner, boardId, doing, "Soon", addDays(date, 7));
    const later = await card(owner, boardId, todo, "Later", addDays(date, 8));
    const finished = await card(owner, boardId, done, "Finished", addDays(date, -1));
    const assigned = await card(owner, boardId, todo, "For the member");
    expect((await tasks(owner, "PATCH", `/cards/${assigned.id}`, { assigneeId: member.userId, revision: assigned.revision })).status).toBe(200);
    const memberCard = await card(member, boardId, todo, "Member made");
    const all = [overdue.id, soon.id, later.id, finished.id, assigned.id, memberCard.id];

    const ownerView = await expectParity(owner);
    expect(among(ownerView.sections.tasksDue, all, "cardId")).toEqual([overdue.id, soon.id]);
    expect(ownerView.sections.tasksDue!.items[0]).toEqual({
      cardId: overdue.id, boardId, boardName: "Today board", title: "Overdue", dueOn: addDays(date, -3), dueTime: null, dueTz: null, dueAt: null, overdue: true, parentTitle: null
    });
    expect(ownerView.sections.tasksDue!.items[1]).toMatchObject({ overdue: false });
    expect(ids(ownerView.sections.tasksDue, "cardId")).not.toContain(later.id);
    expect(ids(ownerView.sections.tasksDue, "cardId")).not.toContain(finished.id);
    // The owner created everything but the member's card; the assigned card is still "created" for them.
    // Cards due within seven days (and overdue ones) are already under Due soon, so My tasks leaves them out.
    const ownerMine = ids(ownerView.sections.tasksMine, "cardId");
    expect(ownerMine).toEqual(expect.arrayContaining([later.id, assigned.id]));
    expect(ownerMine).not.toContain(overdue.id);
    expect(ownerMine).not.toContain(soon.id);
    expect(ownerMine).not.toContain(memberCard.id);
    expect(ownerMine).not.toContain(finished.id);

    const memberView = await expectParity(member);
    expect(among(memberView.sections.tasksDue, all, "cardId")).toEqual([overdue.id, soon.id]);
    const memberMine = memberView.sections.tasksMine!.items;
    expect(memberMine.find((item) => item.cardId === assigned.id)).toMatchObject({ reason: "assigned" });
    expect(memberMine.find((item) => item.cardId === memberCard.id)).toMatchObject({ reason: "created" });
    expect(memberMine).toHaveLength(2);
    expect(among((await expectParity(stranger)).sections.tasksDue, all, "cardId")).toEqual([]);

    // A column the owner marks done drops out.
    expect((await tasks(owner, "PATCH", `/columns/${doing}`, { isDone: true })).status).toBe(200);
    expect(among((await expectParity(owner)).sections.tasksDue, all, "cardId")).toEqual([overdue.id]);
    // Binning a card removes it everywhere.
    expect((await tasks(member, "DELETE", `/cards/${overdue.id}`)).status).toBe(200);
    expect(among((await expectParity(owner)).sections.tasksDue, all, "cardId")).toEqual([]);
    // Member removal: nothing from the board, even the assigned card.
    expect((await tasks(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "private", userIds: [] })).status).toBe(200);
    const removed = await expectParity(member);
    expect(among(removed.sections.tasksDue, all, "cardId")).toEqual([]);
    expect(removed.sections.tasksMine!.items).toEqual([]);
    // Binning the board removes it for the owner.
    expect((await tasks(owner, "DELETE", `/boards/${boardId}`)).status).toBe(200);
    const binned = await expectParity(owner);
    expect(binned.sections.tasksMine!.items).toEqual([]);
  });

  test("tasks: Due soon ranks the viewer's own cards first, so others' overdue cards never push them out of the ten", async () => {
    const owner = await createUser("Today ranking owner");
    const member = await createUser("Today ranking member");
    const { boardId, todo } = await board(owner, "Ranking board", [member]);
    const date = dateInZone(new Date(), "UTC");
    const theirs: string[] = [];
    for (let index = 0; index < 11; index += 1) theirs.push((await card(owner, boardId, todo, `Overdue ${index}`, addDays(date, -5 + (index % 3)))).id);
    const mine = await card(member, boardId, todo, "Mine due today", date);
    const assigned = await card(owner, boardId, todo, "Assigned tomorrow", addDays(date, 1));
    expect((await tasks(owner, "PATCH", `/cards/${assigned.id}`, { assigneeId: member.userId, revision: assigned.revision })).status).toBe(200);

    const memberDue = (await expectParity(member)).sections.tasksDue!;
    expect(memberDue.items).toHaveLength(10);
    expect(memberDue.more).toBe(true);
    // Own cards first (by due date), then the others' overdue ones by due date.
    expect(ids(memberDue, "cardId").slice(0, 2)).toEqual([mine.id, assigned.id]);
    const rest = memberDue.items.slice(2).map((item) => item.dueOn as string);
    expect(rest).toEqual([...rest].sort());
    expect(memberDue.items.slice(2).every((item) => theirs.includes(item.cardId))).toBe(true);
    // The owner made the eleven and the assigned card, so theirs come first for them and the member's card drops out.
    const ownerDue = (await expectParity(owner)).sections.tasksDue!;
    expect(ids(ownerDue, "cardId")).not.toContain(mine.id);
  });

  test("tasks: timed cards carry dueAt, sort by time, go overdue at their instant, and My tasks reads card_assignees", async () => {
    const owner = await createUser("Today timed owner");
    const member = await createUser("Today timed member");
    const { boardId, todo } = await board(owner, "Timed board", [member]);
    const now = new Date();
    const date = dateInZone(now, "UTC");
    const timed = async (title: string, dueOn: string, dueTime: string, dueTz: string) => {
      const created = await tasks(owner, "POST", `/boards/${boardId}/cards`, { columnId: todo, title, dueOn, dueTime, dueTz });
      expect(created.status).toBe(201);
      return created.body.card as { id: string; revision: number; due_at: string };
    };
    // One minute ago and in an hour, in UTC, plus a date-only card on the same day.
    const pad = (value: number) => String(value).padStart(2, "0");
    const hm = (at: Date) => `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 3_600_000);
    const pastCard = await timed("Just passed", dateInZone(past, "UTC"), hm(past), "UTC");
    const dateOnly = await card(owner, boardId, todo, "Today, no time", date);
    const futureCard = await timed("In an hour", dateInZone(future, "UTC"), hm(future), "UTC");
    const all = [pastCard.id, dateOnly.id, futureCard.id];

    const view = await expectParity(owner);
    const items = view.sections.tasksDue!.items.filter((item) => all.includes(item.cardId as string));
    const byId = Object.fromEntries(items.map((item) => [item.cardId, item]));
    expect(byId[pastCard.id]).toMatchObject({ dueTime: hm(past), dueTz: "UTC", dueAt: pastCard.due_at, overdue: true });
    expect(byId[futureCard.id]).toMatchObject({ dueTime: hm(future), dueTz: "UTC", overdue: false });
    // A date-only card due today is not overdue.
    expect(byId[dateOnly.id]).toMatchObject({ dueTime: null, dueAt: null, overdue: false });
    // Same day: timed cards by time, then the date-only card.
    if (dateInZone(past, "UTC") === date && dateInZone(future, "UTC") === date) {
      expect(items.map((item) => item.cardId)).toEqual([pastCard.id, futureCard.id, dateOnly.id]);
    }

    // My tasks reads card_assignees: a second assignee sees the card as assigned.
    const later = await card(owner, boardId, todo, "Later, shared", addDays(date, 30));
    expect((await tasks(owner, "PATCH", `/cards/${later.id}`, { assigneeIds: [owner.userId, member.userId], revision: later.revision })).status).toBe(200);
    expect((db.query("SELECT assignee_id FROM cards WHERE id = ?").get(later.id) as { assignee_id: string }).assignee_id).toBe(owner.userId);
    const memberMine = (await expectParity(member)).sections.tasksMine!.items;
    expect(memberMine.find((item) => item.cardId === later.id)).toMatchObject({ reason: "assigned" });
    const ownerMine = (await expectParity(owner)).sections.tasksMine!.items;
    expect(ownerMine.find((item) => item.cardId === later.id)).toMatchObject({ reason: "assigned" });
  });

  test("sections hold ten items plus more", async () => {
    const owner = await createUser("Today bounds");
    for (let index = 0; index < 12; index += 1) await createNote(owner, `# Note ${index}`, { publish: true });
    const { boardId, todo } = await board(owner, "Bounds board");
    for (let index = 0; index < 11; index += 1) await card(owner, boardId, todo, `Card ${index}`, dateInZone(new Date(), "UTC"));
    const view = await today(owner);
    expect(view.sections.notesRecent!.items).toHaveLength(10);
    expect(view.sections.notesRecent!.more).toBe(true);
    expect(view.sections.tasksDue!.items).toHaveLength(10);
    expect(view.sections.tasksDue!.more).toBe(true);
    // Newest first.
    expect(view.sections.notesRecent!.items[0]!.title).toBe("Note 11");
    const fresh = await createUser("Today bounds fresh");
    expect((await today(fresh)).sections.tasksMine).toEqual({ items: [], more: false, href: "/tasks" });
  });
});

describe("binSoon", () => {
  test("finds the soonest-to-purge items even behind more than 500 newer Bin entries", async () => {
    const owner = await createUser("Today big bin");
    const insert = db.query(`INSERT INTO notes (id, owner_id, folder_id, title, current_version, created_at, updated_at, deleted_at, deleted_by, purge_after)
      VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?)`);
    const later = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const old = new Date(Date.now() - 28 * 86_400_000).toISOString();
    const soonIds: string[] = [];
    db.transaction(() => {
      // Deleted long ago, so listBin's newest-500 window would miss them.
      for (let index = 0; index < 3; index += 1) {
        const id = crypto.randomUUID();
        soonIds.push(id);
        insert.run(id, owner.userId, `Leaving ${index}`, old, old, old, owner.userId, new Date(Date.now() + (index + 1) * 3_600_000).toISOString());
      }
      const recent = new Date().toISOString();
      for (let index = 0; index < 520; index += 1) insert.run(crypto.randomUUID(), owner.userId, `Recent ${index}`, recent, recent, recent, owner.userId, later);
    })();
    const view = await today(owner);
    expect(ids(view.sections.binSoon)).toEqual(soonIds);
    expect(view.sections.binSoon!.more).toBe(false);
    // A row already being purged is not listed.
    db.query("UPDATE notes SET purge_started_at = ? WHERE id = ?").run(new Date().toISOString(), soonIds[0]!);
    expect(ids((await today(owner)).sections.binSoon)).toEqual(soonIds.slice(1));
  });
});
