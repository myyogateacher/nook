import { describe, expect, test } from "bun:test";
import { createUser, db, request } from "./support/harness";

const { isAllowedReadOnlyWrite } = await import("../server/team/writeGate");

/** /api/inbox (agent inbox §8): session, CSRF, owner-only 404s, and the role gate. */

function insertProposal(ownerId: string, title = "Card") {
  const id = crypto.randomUUID();
  db.query(`INSERT INTO proposals (id, owner_id, key_name, kind, target_type, target_id, title, payload, created_at, expires_at)
    VALUES (?, ?, 'agent', 'card_create', 'board', 'b', ?, '{}', ?, ?)`).run(id, ownerId, title, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  return id;
}

describe("inbox routes", () => {
  test("need a session, and writes need the CSRF token", async () => {
    expect((await request("/inbox/proposals")).status).toBe(401);
    expect((await request("/inbox/count")).status).toBe(401);
    const owner = await createUser("Inbox csrf");
    const id = insertProposal(owner.userId);
    const noCsrf = await request(`/inbox/proposals/${id}/reject`, { method: "POST", body: "{}", headers: { "X-CSRF-Token": "wrong" } }, owner);
    expect(noCsrf.status).toBe(403);
    expect((db.query("SELECT status FROM proposals WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
  });

  test("another user's proposal is 404 everywhere; malformed input is 400", async () => {
    const owner = await createUser("Inbox owner routes");
    const other = await createUser("Inbox other routes");
    const id = insertProposal(owner.userId);
    for (const [method, path] of [["GET", `/inbox/proposals/${id}`], ["POST", `/inbox/proposals/${id}/approve`], ["POST", `/inbox/proposals/${id}/reject`]] as const) {
      expect((await request(path, method === "GET" ? {} : { method, body: "{}" }, other)).status).toBe(404);
    }
    const bulk = await request("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action: "reject", ids: [id] }) }, other);
    expect(((await bulk.json()) as { results: Array<{ status: string }> }).results).toEqual([{ id, status: "not_found", code: "NOT_FOUND" }]);
    expect((db.query("SELECT status FROM proposals WHERE id = ?").get(id) as { status: string }).status).toBe("pending");
    expect((await request("/inbox/proposals/not-a-uuid", {}, owner)).status).toBe(400);
    expect((await request("/inbox/proposals?status=weird", {}, owner)).status).toBe(400);
    expect((await request("/inbox/proposals?cursor=garbage", {}, owner)).status).toBe(400);
    expect((await request("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action: "approve" }) }, owner)).status).toBe(400);
    expect((await request("/inbox/proposals/bulk", { method: "POST", body: JSON.stringify({ action: "approve", ids: Array.from({ length: 51 }, () => crypto.randomUUID()) }) }, owner)).status).toBe(400);
    expect((await request(`/inbox/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: "x".repeat(401) }) }, owner)).status).toBe(400);
    const listed = await request("/inbox/proposals", {}, other);
    expect(await listed.json()).toEqual({ groups: [], nextCursor: null });
  });

  test("viewers may reject and change their push setting; approve is not allowlisted (D152)", () => {
    const id = crypto.randomUUID();
    expect(isAllowedReadOnlyWrite("viewer", "POST", `/api/inbox/proposals/${id}/reject`)).toBe(true);
    expect(isAllowedReadOnlyWrite("viewer", "POST", "/api/inbox/proposals/bulk")).toBe(true);
    expect(isAllowedReadOnlyWrite("viewer", "PUT", "/api/inbox/settings")).toBe(true);
    expect(isAllowedReadOnlyWrite("viewer", "POST", `/api/inbox/proposals/${id}/approve`)).toBe(false);
    for (const path of [`/api/inbox/proposals/${id}/reject`, "/api/inbox/proposals/bulk"]) expect(isAllowedReadOnlyWrite("guest", "POST", path)).toBe(false);
  });

  test("the push setting is per user and off by default", async () => {
    const owner = await createUser("Inbox push");
    expect(await (await request("/inbox/settings", {}, owner)).json()).toEqual({ push: false });
    expect((await request("/inbox/settings", { method: "PUT", body: JSON.stringify({ push: "yes" }) }, owner)).status).toBe(400);
    expect(await (await request("/inbox/settings", { method: "PUT", body: JSON.stringify({ push: true }) }, owner)).json()).toEqual({ push: true });
    // The Modules preference is untouched by it.
    const me = await (await request("/auth/me", {}, owner)).json() as { preferences: { disabledModules: string[] } };
    expect(me.preferences.disabledModules).toEqual([]);
  });
});
