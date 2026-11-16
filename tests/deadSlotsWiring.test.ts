import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createUser, request, type Session } from "./support/harness";

/**
 * D1386: the dead slots and orphan endpoints. The card face's goal badge reads every card on screen
 * at once (GET /api/goals/for-cards), only cards the viewer can read and goals they can open; the
 * duplicate PUT /api/crm/pipelines/:id/stages and the uncalled GET /api/crm/search are gone; the
 * never-read `settingsSections` field is gone.
 */

type Json = Record<string, any>;
let owner: Session;
let outsider: Session;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const payload = body === undefined && method !== "GET" ? {} : body;
  const response = await request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, session);
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

beforeAll(async () => {
  owner = await createUser("Badge owner");
  outsider = await createUser("Badge outsider");
});

describe("the card face goal badge read", () => {
  test("names each card's goals in one read; cards without goals and unreadable cards are left out", async () => {
    const created = await api(owner, "POST", "/tasks/boards", { name: "Badge board" });
    const boardId = created.body.board.id as string;
    const column = (created.body.columns as Json[])[0]!.id as string;
    const cardOf = async (title: string) => (await api(owner, "POST", `/tasks/boards/${boardId}/cards`, { columnId: column, title })).body.card.id as string;
    const [linked, twice, plain] = [await cardOf("Linked"), await cardOf("Twice"), await cardOf("Plain")];
    const goalA = (await api(owner, "POST", "/goals", { title: "Launch" })).body.goal as Json;
    const goalB = (await api(owner, "POST", "/goals", { title: "Hire" })).body.goal as Json;
    for (const [cardId, goalId] of [[linked, goalA.id], [twice, goalA.id], [twice, goalB.id]]) {
      expect((await api(owner, "POST", "/links", { a: { kind: "card", id: cardId }, b: { kind: "goal", id: goalId }, relation: "contributes" })).status).toBe(201);
    }
    const read = await api(owner, "GET", `/goals/for-cards?ids=${[linked, twice, plain].join(",")}`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body.cards).sort()).toEqual([linked, twice].sort());
    expect(read.body.cards[linked]).toEqual([{ id: goalA.id, title: "Launch", href: goalA.href, progress: 0, health: expect.any(String) }]);
    expect(read.body.cards[twice].map((goal: Json) => goal.title)).toEqual(["Launch", "Hire"]);
    // Someone who cannot read the board learns nothing, even about goals they can open.
    expect((await api(outsider, "GET", `/goals/for-cards?ids=${linked}`)).body.cards).toEqual({});
    expect((await api(owner, "GET", "/goals/for-cards?ids=")).body.cards).toEqual({});
    const many = Array.from({ length: 201 }, () => crypto.randomUUID()).join(",");
    expect((await api(owner, "GET", `/goals/for-cards?ids=${many}`)).status).toBe(400);
  });
});

describe("removed duplicates", () => {
  test("PATCH changes a pipeline's stages; the PUT duplicate and the uncalled CRM search are gone", async () => {
    const book = (await api(owner, "POST", "/crm/books", { name: "Stages book" })).body.book as Json;
    const pipeline = (await api(owner, "GET", `/crm/pipelines?book=${book.id}`)).body.pipelines[0] as Json;
    const stages = (pipeline.stages as Json[]).map((stage) => ({ id: stage.id, name: stage.name, kind: stage.kind, probability: stage.probability }));
    expect((await api(owner, "PATCH", `/crm/pipelines/${pipeline.id}`, { stages })).status).toBe(200);
    expect((await api(owner, "PUT", `/crm/pipelines/${pipeline.id}/stages`, { stages })).status).toBe(404);
    expect((await api(owner, "GET", "/crm/search?q=a")).status).toBe(404);
  });

  test("the never-read settingsSections slot is gone; workKindRenderers stays for the link chips", () => {
    const types = readFileSync(new URL("../src/workspaceModules/types.ts", import.meta.url), "utf8");
    expect(types).not.toContain("settingsSections");
    expect(types).toContain("workKindRenderers?:");
  });
});
