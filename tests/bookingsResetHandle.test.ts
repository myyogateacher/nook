import { beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

/**
 * D1384 (T579): admins read members' booking link names in one batched call
 * (GET /api/bookings/admin/handles) and reset one (POST /api/bookings/profile/:userId/reset-handle,
 * audited); members can do neither.
 */

type Json = Record<string, any>;
let admin: Session;
let squatter: Session;
let plain: Session;

const api = async (session: Session, method: string, path: string, body?: unknown) => {
  const payload = body === undefined && method !== "GET" ? {} : body;
  const response = await request(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }, session);
  return { status: response.status, body: await response.json().catch(() => null) as Json };
};

beforeAll(async () => {
  admin = await createUser("Handle admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  squatter = await createUser("Handle squatter");
  plain = await createUser("Handle plain");
});

describe("booking link names for admins (D1384)", () => {
  test("one batched read names the members with a profile; members are refused", async () => {
    await api(squatter, "GET", "/bookings/profile");
    expect((await api(squatter, "PUT", "/bookings/profile", { handle: "the-real-ceo" })).status).toBe(200);
    const read = await api(admin, "GET", `/bookings/admin/handles?users=${squatter.userId},${plain.userId}`);
    expect(read.status).toBe(200);
    expect(read.body.handles).toEqual({ [squatter.userId]: "the-real-ceo" });
    expect((await api(admin, "GET", "/bookings/admin/handles")).body.handles).toEqual({});
    expect((await api(plain, "GET", `/bookings/admin/handles?users=${squatter.userId}`)).body.code).toBe("ADMIN_ONLY");
  });

  test("the reset gives a new name from the person's name, frees the old one, and is audited", async () => {
    expect((await api(plain, "POST", `/bookings/profile/${squatter.userId}/reset-handle`)).status).toBe(403);
    const reset = await api(admin, "POST", `/bookings/profile/${squatter.userId}/reset-handle`);
    expect(reset.status).toBe(200);
    expect(reset.body.profile.handle).toMatch(/^handle-squatter/);
    expect((await api(admin, "GET", `/bookings/admin/handles?users=${squatter.userId}`)).body.handles[squatter.userId]).toBe(reset.body.profile.handle);
    expect(db.query("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'bookings.handle_reset' AND actor_id = ?").get(admin.userId)).toEqual({ count: 1 });
  });
});
