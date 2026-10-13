/**
 * Avatar caching (T353): `GET /api/users/:id/avatar?v=` is `private, no-cache` with an ETag, so a
 * browser keeps the bytes but revalidates on every page load. A current URL answers 304 (no body);
 * once the picture is replaced or an admin removed it, the same revalidation answers 404, so other
 * viewers stop seeing the old picture on their next page load at the latest. The security headers
 * (sniffed type, nosniff, CORP, the global CSP) are kept on every answer.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { base64, makePng } from "./support/images";
import { retireUsersAfterFile } from "./support/retireUsers";
const { resetTeamRateLimits } = await import("../server/team/routes");

retireUsersAfterFile();
beforeEach(() => resetTeamRateLimits());

const upload = (session: Session, bytes: Uint8Array) => request("/me/avatar", { method: "PUT", body: JSON.stringify({ source: "upload", image: base64(bytes) }) }, session);
const urlOf = async (response: Response) => (await response.json() as { avatarUrl: string }).avatarUrl;
const load = (url: string, viewer: Session, etag?: string) =>
  fetch(`${origin}${url}`, { headers: { Cookie: viewer.cookie, ...(etag ? { "If-None-Match": etag } : {}) } });

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
}

describe("GET /api/users/:id/avatar caching", () => {
  test("200 then a cheap 304 on revalidation, both with the security headers", async () => {
    const member = await createUser("AC member");
    const viewer = await createUser("AC viewer");
    const url = await urlOf(await upload(member, makePng(20, 20)));
    const first = await load(url, viewer);
    expect(first.status).toBe(200);
    expectSecurityHeaders(first);
    expect(first.headers.get("content-type")).toBe("image/png");
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${new URL(url, origin).searchParams.get("v")}"`);
    await first.arrayBuffer();

    const again = await load(url, viewer, etag);
    expect(again.status).toBe(304);
    expectSecurityHeaders(again);
    expect(again.headers.get("etag")).toBe(etag);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    // A different validator gets the bytes again.
    expect((await load(url, viewer, '"something-else"')).status).toBe(200);
  });

  test("after the member replaces the picture, revalidating the old URL is 404, not 304", async () => {
    const member = await createUser("AC replacer");
    const viewer = await createUser("AC onlooker");
    const oldUrl = await urlOf(await upload(member, makePng(20, 20)));
    const etag = (await load(oldUrl, viewer)).headers.get("etag")!;
    const newUrl = await urlOf(await upload(member, makePng(22, 22, [0, 0, 255])));
    expect(newUrl).not.toBe(oldUrl);
    expect((await load(oldUrl, viewer, etag)).status).toBe(404);
    expect((await load(newUrl, viewer)).status).toBe(200);
  });

  test("after an admin removal, revalidating the old URL is 404 for every viewer", async () => {
    const admin = await createUser("AC admin");
    db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
    const member = await createUser("AC removed");
    const viewer = await createUser("AC watcher");
    const url = await urlOf(await upload(member, makePng(20, 20)));
    const etag = (await load(url, viewer)).headers.get("etag")!;
    expect((await load(url, viewer, etag)).status).toBe(304);
    expect((await request(`/team/${member.userId}/avatar`, { method: "DELETE", body: "{}" }, admin)).status).toBe(200);
    const after = await load(url, viewer, etag);
    expect(after.status).toBe(404);
    expect(after.headers.get("etag")).toBeNull();
    expect(after.headers.get("cache-control") ?? "").not.toContain("max-age");
  });
});
