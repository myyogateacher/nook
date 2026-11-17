import { describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

/** Wave 13C card description excerpts (WAVE_13_TASK_CARD_UX.md D111, §7). */

const { descriptionExcerpt, EXCERPT_MAX_CHARS, reconcileCardExcerpts } = await import("../server/tasks/excerpt");

async function call(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(`/tasks${path}`, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const storedExcerpt = (cardId: string) => (db.query("SELECT description_excerpt FROM cards WHERE id = ?").get(cardId) as { description_excerpt: string }).description_excerpt;

describe("descriptionExcerpt (unit)", () => {
  test("plain text from Markdown with whitespace collapsed", () => {
    expect(descriptionExcerpt("# Plan\n\nRead **the** [spec](https://example.test/spec)\n\n- one\n- two")).toBe("Plan Read the spec one two");
    expect(descriptionExcerpt("")).toBe("");
    expect(descriptionExcerpt("https://example.test/only-a-link")).toBe("");
    expect(descriptionExcerpt("<img src=x onerror=alert(1)> safe")).not.toContain("<img");
  });

  test("an @mention reads as @Name, with no space after the @", () => {
    const id = "0190a0b2-1111-7222-8333-944455556666";
    expect(descriptionExcerpt(`Ping @[Max Member](user:${id}) and **@[Amy](user:${id})** now`)).toBe("Ping @Max Member and @Amy now");
  });

  test("at most 160 code points, cut with an ellipsis, never splitting a surrogate pair", () => {
    const long = descriptionExcerpt("word ".repeat(100));
    expect(Array.from(long)).toHaveLength(EXCERPT_MAX_CHARS);
    expect(long.endsWith("word…")).toBe(true);
    const exact = "a".repeat(160);
    expect(descriptionExcerpt(exact)).toBe(exact);
    const emoji = descriptionExcerpt("😀".repeat(200));
    expect(Array.from(emoji)).toHaveLength(160);
    expect(emoji.endsWith("😀…")).toBe(true);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("description_excerpt on cards", () => {
  test("written on every description write and exposed on the board without descriptions", async () => {
    const owner = await createUser("Excerpt owner");
    const created = await call(owner, "POST", "/boards", { name: "Excerpt board" });
    const boardId = created.body.board.id as string;
    const columnId = created.body.columns[0].id as string;
    const card = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Plan", description: "## Goal\n\nShip **tags**." })).body.card;
    expect(card.description_excerpt).toBe("Goal Ship tags.");
    const bare = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Bare" })).body.card;
    expect(bare.description_excerpt).toBe("");

    let board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards.map((item: { description_excerpt: string }) => item.description_excerpt)).toEqual(["Goal Ship tags.", ""]);
    expect(board.cards[0].description).toBeUndefined();

    let patched = await call(owner, "PATCH", `/cards/${card.id}`, { description: `New ${"text ".repeat(60)}`, revision: 1 });
    expect(Array.from(patched.body.card.description_excerpt as string).length).toBeLessThanOrEqual(160);
    expect(patched.body.card.description_excerpt.startsWith("New text")).toBe(true);
    // A title-only patch keeps the excerpt; clearing the description clears it.
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { title: "Plan it", revision: 2 });
    expect(patched.body.card.description_excerpt.startsWith("New text")).toBe(true);
    patched = await call(owner, "PATCH", `/cards/${card.id}`, { description: "", revision: 3 });
    expect(patched.body.card).toMatchObject({ description_excerpt: "", has_description: 0 });
    board = (await call(owner, "GET", `/boards/${boardId}`)).body;
    expect(board.cards[0].description_excerpt).toBe("");
  });

  test("the boot reconcile fills cards written before migration 015, binned ones included", async () => {
    const owner = await createUser("Excerpt reconcile");
    const created = await call(owner, "POST", "/boards", { name: "Reconcile board" });
    const boardId = created.body.board.id as string;
    const columnId = created.body.columns[0].id as string;
    const live = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Live", description: "Old *live* text" })).body.card.id as string;
    const binned = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Binned", description: "Old binned text" })).body.card.id as string;
    const linkOnly = (await call(owner, "POST", `/boards/${boardId}/cards`, { columnId, title: "Link", description: "https://example.test/x" })).body.card.id as string;
    expect((await call(owner, "DELETE", `/cards/${binned}`)).status).toBe(200);
    // Simulate rows from before 015: the column exists with its default ''.
    db.query("UPDATE cards SET description_excerpt = '' WHERE id IN (?, ?, ?)").run(live, binned, linkOnly);

    expect(reconcileCardExcerpts()).toBeGreaterThanOrEqual(2);
    expect(storedExcerpt(live)).toBe("Old live text");
    expect(storedExcerpt(binned)).toBe("Old binned text");
    expect(storedExcerpt(linkOnly)).toBe("");
    // Idempotent: nothing left to write for these cards.
    expect(reconcileCardExcerpts()).toBe(0);
    expect((await call(owner, "GET", `/boards/${boardId}`)).body.cards[0].description_excerpt).toBe("Old live text");
  });
});
