import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";
import { contentStatus, uploadAttachment } from "./support/attachments";

const { registeredMailTemplate } = await import("../server/mail/registry");
const { sharedItem } = await import("../server/mail/resolve");
const { resetReactionRateLimit } = await import("../server/reactions/service");
const mail = await import("../server/mail");

/**
 * Item comments, fully baked (docs/plan/WORKSPACE_MODULES.md §B.5, D1360–D1366, T690–T692):
 * - a comment tells the item's followers (owner, contributors) and a reply its parent's author, once
 *   each, never the commenter, readers only, and never someone the comment already @mentions;
 * - reactions and files on item comments, readable by the item's readers only, now;
 * - delete gives an Undo ticket that brings back the comment with its reactions and files;
 * - sharing a module container by name tells the people newly added (bell, mail, digest log).
 */

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await request(path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? (method === "GET" ? {} : { body: "{}" }) : { body: JSON.stringify(body) }) }, session);
  const text = await response.text();
  let json: Json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
  return { status: response.status, body: json };
}
async function share(session: Session, kind: string, id: string, people: Array<{ id: string; level: string }>) {
  const sheet = await request(`/access/${kind}/${id}`, {}, session);
  const etag = sheet.headers.get("ETag")!;
  const put = await api(session, "PUT", `/access/${kind}/${id}`, { audience: people.length ? "selected" : "private", people, groups: [] }, { "If-Match": etag });
  expect(put.status).toBe(200);
}

const commentRows = (userId: string, itemId: string) => db.query("SELECT title, module, href FROM notifications WHERE user_id = ? AND topic = 'core.comment' AND item_id = ? ORDER BY created_at")
  .all(userId, itemId) as Array<{ title: string; module: string; href: string }>;
const mentionRows = (userId: string, itemId: string) => db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'core.mention' AND item_id = ?").all(userId, itemId) as Array<{ title: string }>;
const commentMails = (userId: string) => (db.query("SELECT payload, category FROM mail_outbox WHERE user_id = ? AND template = 'core.comment'").all(userId) as Array<{ payload: string; category: string }>)
  .map((row) => ({ category: row.category, payload: JSON.parse(row.payload) as Json }));
const recipient = (session: Session) => ({ id: session.userId, email: "x@example.test", displayName: "x", role: "member", tz: "UTC" });

let owner: Session;
let contributor: Session;
let reader: Session;
let stranger: Session;
let goalId: string;

afterAll(() => { mail.setMailTransportForTests(null); });

beforeAll(async () => {
  mail.setMailTransportForTests(async () => ({ id: "msg_1" }));
  owner = await createUser("Bake owner");
  contributor = await createUser("Bake contributor");
  reader = await createUser("Bake reader");
  stranger = await createUser("Bake stranger");
  const goal = await api(owner, "POST", "/goals", { title: "Grow MRR", contributorIds: [contributor.userId], keyResults: [{ title: "MRR", targetValue: 100 }] });
  expect(goal.status).toBe(201);
  goalId = goal.body.goal.id;
  await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }, { id: reader.userId, level: "comment" }]);
});

describe("comment notifications (D1360–D1361)", () => {
  test("a comment tells the owner and contributors, never the commenter or a non-follower reader", async () => {
    const posted = await api(reader, "POST", `/items/goal/${goalId}/comments`, { body: "How is this going?" });
    expect(posted.status).toBe(201);
    expect(commentRows(owner.userId, goalId).map((row) => row.title)).toEqual(["Bake reader commented on a goal"]);
    expect(commentRows(contributor.userId, goalId)).toHaveLength(1);
    expect(commentRows(reader.userId, goalId)).toHaveLength(0);
    expect(commentRows(stranger.userId, goalId)).toHaveLength(0);
    expect(commentRows(owner.userId, goalId)[0]!.module).toBe("goals");
    // The title never carries the text (T505); the mail is ids only, in the comments category.
    expect(commentRows(owner.userId, goalId)[0]!.title).not.toContain("going");
    const mail = commentMails(owner.userId).at(-1)!;
    expect(mail.category).toBe("comments");
    expect(JSON.stringify(mail.payload)).not.toContain("going");
  });

  test("a reply tells the parent's author once (as a reply), and someone @mentioned hears only the mention", async () => {
    const parent = await api(reader, "POST", `/items/goal/${goalId}/comments`, { body: "First" });
    db.query("UPDATE notifications SET read_at = ? WHERE topic = 'core.comment'").run(new Date().toISOString());
    const reply = await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: `Thanks @[Bake contributor](user:${contributor.userId})`, parentId: parent.body.comment.id });
    expect(reply.status).toBe(201);
    const unread = (userId: string) => db.query("SELECT title, topic FROM notifications WHERE user_id = ? AND item_id = ? AND read_at IS NULL AND topic IN ('core.comment','core.mention')").all(userId, goalId) as Array<{ title: string; topic: string }>;
    expect(unread(reader.userId)).toEqual([{ title: "Bake owner replied to your comment on a goal", topic: "core.comment" }]);
    // The contributor follows the goal and is mentioned: one notification, the mention.
    expect(unread(contributor.userId).map((row) => row.topic)).toEqual(["core.mention"]);
    expect(mentionRows(contributor.userId, goalId)).toHaveLength(1);
    expect(unread(owner.userId)).toEqual([]);
  });

  test("a later comment never hides a reply: the reply keeps its own unread row", async () => {
    const mine = await api(contributor, "POST", `/items/goal/${goalId}/comments`, { body: "My update" });
    db.query("UPDATE notifications SET read_at = ? WHERE topic = 'core.comment'").run(new Date().toISOString());
    await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "Nice", parentId: mine.body.comment.id });
    await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "Unrelated note" });
    const unread = db.query("SELECT title FROM notifications WHERE user_id = ? AND topic = 'core.comment' AND read_at IS NULL ORDER BY title").all(contributor.userId) as Array<{ title: string }>;
    expect(unread.map((row) => row.title)).toEqual(["Bake owner commented on a goal", "Bake owner replied to your comment on a goal"]);
  });

  test("people who cannot read the item are skipped, and the mail is re-checked as the recipient", async () => {
    // The reader writes a comment, then loses access: a reply does not tell them, and their queued mail resolves to nothing.
    const parent = await api(reader, "POST", `/items/goal/${goalId}/comments`, { body: "Before I go" });
    await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }]);
    db.query("UPDATE notifications SET read_at = ? WHERE topic = 'core.comment'").run(new Date().toISOString());
    const reply = await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "Answer", parentId: parent.body.comment.id });
    expect(reply.status).toBe(201);
    expect(db.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND topic = 'core.comment' AND read_at IS NULL").get(reader.userId)).toEqual({ n: 0 });
    const template = registeredMailTemplate("core.comment")!;
    const payload = { comments: [{ kind: "goal", id: goalId, commentId: reply.body.comment.id, actorId: owner.userId, reply: true }] };
    expect(template.resolve!(payload, recipient(reader), Date.now())).toEqual({ skip: "access_lost" });
    expect(template.resolve!(payload, recipient(stranger), Date.now())).toEqual({ skip: "access_lost" });
    const resolved = template.resolve!(payload, recipient(contributor), Date.now()) as Json;
    expect(resolved.data.comments[0]).toMatchObject({ title: "Grow MRR", kindLabel: "Goal", reply: true });
    // A comment deleted since is left out.
    await api(owner, "DELETE", `/items/goal/${goalId}/comments/${reply.body.comment.id}`);
    expect(template.resolve!(payload, recipient(contributor), Date.now())).toEqual({ skip: "access_lost" });
    await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }, { id: reader.userId, level: "comment" }]);
  });
});

describe("reactions and files on item comments (D1362–D1363, T690)", () => {
  test("readers react; a non-reader gets 404; a viewer cannot react", async () => {
    resetReactionRateLimit();
    const posted = await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "React to me" });
    const id = posted.body.comment.id as string;
    expect(posted.body.comment.reactions).toEqual([]);
    const put = await api(reader, "PUT", `/reactions/item_comment/${id}/thumbs_up`);
    expect(put.status).toBe(200);
    expect(put.body.reactions[0]).toMatchObject({ emoji: "thumbs_up", count: 1, reacted: true });
    expect((await api(stranger, "PUT", `/reactions/item_comment/${id}/thumbs_up`)).status).toBe(404);
    const listed = await api(owner, "GET", `/items/goal/${goalId}/comments`);
    expect(listed.body.comments.find((comment: Json) => comment.id === id).reactions[0]).toMatchObject({ emoji: "thumbs_up", count: 1, reacted: false });
    const viewer = await createUser("Bake viewer");
    await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }, { id: reader.userId, level: "comment" }, { id: viewer.userId, level: "view" }]);
    expect((await api(viewer, "PUT", `/reactions/item_comment/${id}/heart`)).status).toBe(403);
  });

  test("files posted with a comment open for the item's readers only, and only while they can read it", async () => {
    const documentId = await uploadAttachment(reader, "notes.txt", "Q3 numbers", "item_comment");
    const posted = await api(reader, "POST", `/items/goal/${goalId}/comments`, { attachmentIds: [documentId] });
    expect(posted.status).toBe(201);
    expect(posted.body.comment.body).toBe("");
    expect(posted.body.comment.attachments.map((file: Json) => [file.documentId, file.name])).toEqual([[documentId, "notes.txt"]]);
    expect(await contentStatus(owner, documentId)).toBe(200);
    expect(await contentStatus(stranger, documentId)).toBe(404);
    // Nothing reaches lists: the owner's Files never shows another person's comment file.
    const files = await api(owner, "GET", "/files");
    expect(files.body.documents.map((document: Json) => document.id)).not.toContain(documentId);
    // Another person's file cannot be attached (only your own, T341).
    const theirs = await uploadAttachment(owner, "mine.txt", "x", "item_comment");
    expect((await api(reader, "POST", `/items/goal/${goalId}/comments`, { attachmentIds: [theirs] })).status).toBe(404);
    // Only the author links more files to their comment.
    expect((await api(owner, "POST", `/attachments/item_comment/${posted.body.comment.id}`, { documentId: theirs })).body.code).toBe("READ_ONLY");
    // Shared and then unshared: the file opens and closes with the goal.
    const watcher = await createUser("Bake watcher");
    expect(await contentStatus(watcher, documentId)).toBe(404);
    await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }, { id: reader.userId, level: "comment" }, { id: watcher.userId, level: "view" }]);
    expect(await contentStatus(watcher, documentId)).toBe(200);
    await share(owner, "goal", goalId, [{ id: contributor.userId, level: "comment" }, { id: reader.userId, level: "comment" }]);
    expect(await contentStatus(watcher, documentId)).toBe(404);
  });

  test("MCP never sees item comment files: the attachment tools do not offer the kind", async () => {
    const { attachmentTools } = await import("../server/attachments/mcpTools");
    const list = attachmentTools.find((tool) => tool.name === "list_attachments")!;
    expect(JSON.stringify((list.inputSchema as unknown as { shape: Json }).shape.hostKind._def)).not.toContain("item_comment");
  });
});

describe("delete and Undo (D1364)", () => {
  test("delete returns an Undo ticket that restores the comment with its reactions and files", async () => {
    resetReactionRateLimit();
    const documentId = await uploadAttachment(owner, "plan.txt", "Plan", "item_comment");
    const posted = await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "With a file", attachmentIds: [documentId] });
    const id = posted.body.comment.id as string;
    await api(reader, "PUT", `/reactions/item_comment/${id}/heart`);
    const removed = await api(owner, "DELETE", `/items/goal/${goalId}/comments/${id}`);
    expect(removed.status).toBe(200);
    expect(typeof removed.body.undoTicket).toBe("string");
    expect((await api(owner, "GET", `/items/goal/${goalId}/comments`)).body.comments.some((comment: Json) => comment.id === id)).toBe(false);
    expect(await contentStatus(reader, documentId)).toBe(404);
    expect((await api(reader, "POST", `/undo/${removed.body.undoTicket}`)).status).toBe(404);
    expect((await api(owner, "POST", `/undo/${removed.body.undoTicket}`)).status).toBe(200);
    const back = (await api(reader, "GET", `/items/goal/${goalId}/comments`)).body.comments.find((comment: Json) => comment.id === id);
    expect(back.body).toBe("With a file");
    expect(back.reactions[0]).toMatchObject({ emoji: "heart", count: 1, reacted: true });
    expect(back.attachments.map((file: Json) => file.documentId)).toEqual([documentId]);
    expect(await contentStatus(reader, documentId)).toBe(200);
  });

  test("a deleted comment with replies keeps its place without its files or reactions", async () => {
    resetReactionRateLimit();
    const documentId = await uploadAttachment(owner, "kept.txt", "x", "item_comment");
    const parent = await api(owner, "POST", `/items/goal/${goalId}/comments`, { body: "Parent", attachmentIds: [documentId] });
    await api(reader, "POST", `/items/goal/${goalId}/comments`, { body: "Child", parentId: parent.body.comment.id });
    const removed = await api(owner, "DELETE", `/items/goal/${goalId}/comments/${parent.body.comment.id}`);
    const shown = (await api(reader, "GET", `/items/goal/${goalId}/comments`)).body.comments.find((comment: Json) => comment.id === parent.body.comment.id);
    expect(shown).toMatchObject({ deleted: true, body: "", attachments: [], reactions: [] });
    expect(await contentStatus(reader, documentId)).toBe(404);
    expect((await api(owner, "POST", `/undo/${removed.body.undoTicket}`)).status).toBe(200);
    expect(await contentStatus(reader, documentId)).toBe(200);
  });
});

describe("sharing a module item tells the people added (D1366, T692)", () => {
  test("newly added people get a bell row and the Shared with you mail; people already there and the sharer do not", async () => {
    const sharer = await createUser("Share owner");
    const first = await createUser("Share first");
    const second = await createUser("Share second");
    const project = await api(sharer, "POST", "/time/projects", { name: "Website rebuild" });
    expect(project.status).toBe(201);
    const id = project.body.project.id as string;
    const rows = (userId: string) => db.query("SELECT title, module, href FROM notifications WHERE user_id = ? AND topic = 'core.shared'").all(userId) as Array<{ title: string; module: string; href: string }>;
    const mails = (userId: string) => db.query("SELECT payload FROM mail_outbox WHERE user_id = ? AND template = 'sharing.shared'").all(userId) as Array<{ payload: string }>;
    const logged = (userId: string) => db.query("SELECT kind, item_id FROM mail_share_log WHERE user_id = ?").all(userId) as Array<{ kind: string; item_id: string }>;
    await share(sharer, "time_project", id, [{ id: first.userId, level: "view" }]);
    expect(rows(first.userId)).toEqual([{ title: "Share owner shared the time project ‘Website rebuild’ with you", module: "time", href: expect.stringMatching(/^\/time/) }]);
    expect(mails(first.userId)).toHaveLength(1);
    expect(JSON.parse(mails(first.userId)[0]!.payload).items).toEqual([{ kind: "time_project", id }]);
    expect(rows(sharer.userId)).toEqual([]);
    // Adding a second person tells only them.
    await share(sharer, "time_project", id, [{ id: first.userId, level: "view" }, { id: second.userId, level: "edit" }]);
    expect(rows(first.userId)).toHaveLength(1);
    expect(rows(second.userId)).toHaveLength(1);
    // The mail and the digest read the item again as the recipient (no leak after unsharing).
    const sharedMail = registeredMailTemplate("sharing.shared");
    void sharedMail;
    expect(sharedItem("time_project", id, second.userId)).toMatchObject({ title: "Website rebuild", access: "edit" });
    expect(sharedItem("time_project", id, first.userId)).toMatchObject({ access: "read" });
    await share(sharer, "time_project", id, [{ id: second.userId, level: "edit" }]);
    expect(sharedItem("time_project", id, first.userId)).toBeNull();
    // The digest log took the module kind (migration 155).
    expect(logged(second.userId)).toEqual([{ kind: "time_project", item_id: id }]);
  });
});

describe("the dev mail preview covers every template that can be sent (D1368)", () => {
  test("registered module and core templates render from their fixtures, listed beside the built-in ones", async () => {
    const { registeredPreviewFixtures, renderFixture } = await import("../server/mail/preview");
    const { registeredMailTemplateNames } = await import("../server/mail/registry");
    const ids = registeredPreviewFixtures().map((item) => item.id);
    for (const name of registeredMailTemplateNames()) expect(ids).toContain(name);
    for (const name of ["time.update", "goals.update", "crm.update", "core.comment", "core.mention", "sharing.shared.module"]) {
      const rendered = renderFixture(name);
      expect({ name, ok: !!rendered && rendered.html.includes("<html") && rendered.subject.length > 3 }).toEqual({ name, ok: true });
    }
    expect(renderFixture("sharing.shared.module")!.html).toContain("Website rebuild");
    expect(renderFixture("no.such_template")).toBeNull();
  });
});

describe("comment links open where the comments are (D1367)", () => {
  test("a comment on a time project notifies its owner with a link to the project's Activity tab", async () => {
    const lead = await createUser("Link owner");
    const helper = await createUser("Link helper");
    const project = await api(lead, "POST", "/time/projects", { name: "Linked project" });
    const id = project.body.project.id as string;
    await share(lead, "time_project", id, [{ id: helper.userId, level: "comment" }]);
    expect((await api(helper, "POST", `/items/time_project/${id}/comments`, { body: "Hours look high" })).status).toBe(201);
    const row = db.query("SELECT href FROM notifications WHERE user_id = ? AND topic = 'core.comment'").get(lead.userId) as { href: string };
    expect(row.href).toMatch(/^\/time\/projects\/[a-z0-9-]+\?tab=activity$/);
  });
});
