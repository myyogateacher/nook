import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

async function call(session: Session | undefined, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function uploadAttachment(session: Session, name = "shot.png") {
  const form = new FormData();
  form.append("file", new Blob([PNG]), name);
  const response = await request("/files?purpose=task_attachment", { method: "POST", body: form }, session);
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document;
}

const cardTitles = async (session: Session, boardId: string) =>
  ((await call(session, "GET", `/boards/${boardId}`)).body.cards as Array<{ title: string }>).map((card) => card.title);
const relationRows = () => (db.query("SELECT COUNT(*) AS count FROM card_relations").get() as { count: number }).count;
const attachmentRows = (documentId: string) => (db.query("SELECT COUNT(*) AS count FROM card_attachments WHERE document_id = ?").get(documentId) as { count: number }).count;

async function setup(label: string) {
  const owner = await createUser(`${label} owner`);
  const member = await createUser(`${label} member`);
  const stranger = await createUser(`${label} stranger`);
  const created = await call(owner, "POST", "/boards", { name: `${label} board` });
  const boardId = created.body.board.id as string;
  const columnId = created.body.columns[0].id as string;
  expect((await call(owner, "PUT", `/boards/${boardId}/sharing`, { visibility: "selected", userIds: [member.userId] })).status).toBe(200);
  const target = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Target" })).body.card as { id: string };
  // A card on the owner's private board, which the member cannot read.
  const privateBoard = await call(owner, "POST", "/boards", { name: `${label} private` });
  const privateCard = (await call(owner, "POST", `/boards/${privateBoard.body.board.id}/cards`, { columnId: privateBoard.body.columns[0].id, title: "Hidden" })).body.card as { id: string };
  return { owner, member, stranger, boardId, columnId, targetId: target.id, privateCardId: privateCard.id };
}

describe("creating a card with tags, flags, relations, and attachments in one call", () => {
  test("everything is written at once and audited", async () => {
    const s = await setup("Composite ok");
    const tag = (await call(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "Backend" })).body.tag as { id: string };
    const document = await uploadAttachment(s.member);
    const created = await call(s.member, "POST", `/boards/${s.boardId}/cards`, {
      columnId: s.columnId, title: "Composite", tagIds: [tag.id], flags: ["blocked"], priority: "high", assigneeIds: [s.member.userId],
      relations: [{ targetCardId: s.targetId, type: "depends_on" }], attachmentIds: [document.id]
    });
    expect(created.status).toBe(201);
    const card = created.body.card as { id: string; revision: number; tag_ids: string[]; flags: string[]; priority: string | null };
    expect(card.revision).toBe(1);
    expect(card.tag_ids).toEqual([tag.id]);
    expect([card.flags, card.priority]).toEqual([["blocked"], "high"]);
    const detail = await call(s.member, "GET", `/cards/${card.id}`);
    expect(detail.body.attachments.map((attachment: { document_id: string }) => attachment.document_id)).toEqual([document.id]);
    expect(detail.body.relations).toHaveLength(1);
    expect(detail.body.relations[0]).toMatchObject({ type: "depends_on", restricted: false, card: { id: s.targetId } });
    // Seen from the target, the relation is the inverse; the target's revision is untouched.
    const target = await call(s.owner, "GET", `/cards/${s.targetId}`);
    expect(target.body.relations[0]).toMatchObject({ type: "needed_by", card: { id: card.id } });
    expect(target.body.card.revision).toBe(1);
    const board = await call(s.member, "GET", `/boards/${s.boardId}`);
    expect(board.body.cards.find((item: { id: string }) => item.id === card.id)).toMatchObject({ relation_count: 1, open_blockers: 1 });
    const actions = (db.query("SELECT event_type FROM audit_log WHERE actor_id = ? ORDER BY rowid").all(s.member.userId) as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(actions).toEqual(expect.arrayContaining(["task.card_create", "task.relation_create", "task.attachment_link"]));
  });

  test("a restricted or unknown relation target is 404 and nothing is written", async () => {
    const s = await setup("Composite restricted");
    const before = relationRows();
    for (const targetCardId of [s.privateCardId, crypto.randomUUID()]) {
      const refused = await call(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "Linked", relations: [{ targetCardId, type: "relates_to" }] });
      expect(refused.status).toBe(404);
    }
    expect(relationRows()).toBe(before);
    expect(await cardTitles(s.owner, s.boardId)).toEqual(["Target"]);
    // Two relations to the same card (in any letter case) are a 400 before anything is written, not a
    // 409 RELATION_EXISTS carrying a relation id the same call rolled back.
    for (const second of [s.targetId, s.targetId.toUpperCase()]) {
      const twice = await call(s.member, "POST", `/boards/${s.boardId}/cards`, {
        columnId: s.columnId, title: "Twice", relations: [{ targetCardId: s.targetId, type: "relates_to" }, { targetCardId: second, type: "depends_on" }]
      });
      expect(twice.status).toBe(400);
      expect(twice.body.code).toBeUndefined();
      expect(twice.body.relation).toBeUndefined();
    }
    expect(relationRows()).toBe(before);
    expect(await cardTitles(s.owner, s.boardId)).toEqual(["Target"]);
    // Unknown types, extra keys, and more than 50 relations are 400.
    for (const relations of [[{ targetCardId: s.targetId, type: "blocks" }], [{ targetCardId: s.targetId, type: "relates_to", extra: 1 }],
      Array.from({ length: 51 }, () => ({ targetCardId: crypto.randomUUID(), type: "relates_to" }))]) {
      expect((await call(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "Bad", relations })).status).toBe(400);
    }
    // A stranger cannot create on the board at all.
    expect((await call(s.stranger, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "No", relations: [{ targetCardId: s.targetId, type: "relates_to" }] })).status).toBe(404);
  });

  test("someone else's attachment is 404 and an already linked one is 409; nothing is written", async () => {
    const s = await setup("Composite files");
    const ownerFile = await uploadAttachment(s.owner);
    const refused = await call(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "Theirs", attachmentIds: [ownerFile.id] });
    expect(refused.status).toBe(404);
    // The same body as the attachments route gives for someone else's file.
    const viaRoute = await call(s.member, "POST", `/cards/${s.targetId}/attachments`, { documentId: ownerFile.id });
    expect(viaRoute.status).toBe(404);
    expect(refused.body.error).toBe(viaRoute.body.error);
    expect(attachmentRows(ownerFile.id)).toBe(0);

    const mine = await uploadAttachment(s.member);
    expect((await call(s.member, "POST", `/cards/${s.targetId}/attachments`, { documentId: mine.id })).status).toBe(201);
    const linked = await call(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "Reused", attachmentIds: [mine.id] });
    expect(linked.status).toBe(409);
    expect(linked.body.code).toBe("ATTACHMENT_LINKED");
    expect(attachmentRows(mine.id)).toBe(1);
    expect(await cardTitles(s.owner, s.boardId)).toEqual(["Target"]);
  });

  test("a full column refuses first with COLUMN_FULL and nothing is written", async () => {
    const s = await setup("Composite WIP");
    expect((await call(s.owner, "PATCH", `/columns/${s.columnId}`, { wipLimit: 1 })).status).toBe(200);
    const tag = (await call(s.owner, "POST", `/boards/${s.boardId}/tags`, { name: "Ops" })).body.tag as { id: string };
    const document = await uploadAttachment(s.member);
    const relationsBefore = relationRows();
    const full = await call(s.member, "POST", `/boards/${s.boardId}/cards`, {
      columnId: s.columnId, title: "Overflow", tagIds: [tag.id], flags: ["blocked"],
      relations: [{ targetCardId: s.targetId, type: "relates_to" }], attachmentIds: [document.id]
    });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ code: "COLUMN_FULL", wipLimit: 1, cardCount: 1 });
    expect(relationRows()).toBe(relationsBefore);
    expect(attachmentRows(document.id)).toBe(0);
    expect(await cardTitles(s.owner, s.boardId)).toEqual(["Target"]);
    // COLUMN_FULL comes before other validation: even a restricted target reports the full column.
    const first = await call(s.member, "POST", `/boards/${s.boardId}/cards`, { columnId: s.columnId, title: "Overflow", relations: [{ targetCardId: s.privateCardId, type: "relates_to" }] });
    expect(first.body.code).toBe("COLUMN_FULL");
  });
});
