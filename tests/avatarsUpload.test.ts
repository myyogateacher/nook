/**
 * Uploaded profile pictures (uploads everywhere U7, T353): PUT /api/me/avatar with an upload, the
 * Google picture, or none; sniffing, the size and pixel caps, the rate limit, every role, the Google
 * sync rules, and serving. Runs on S3 too: `MYNOTES_TEST_STORAGE=s3 bun test tests/avatarsUpload.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, spareEmail, storedObjectBytes, storedObjectExists, type Session } from "./support/harness";
import { startFakeGoogle, type FakeGoogle, type FakeIdentity } from "./support/fakeGoogle";
import { base64, GIF_1X1, makePng, SVG_IMAGE } from "./support/images";
import { retireUsersAfterFile } from "./support/retireUsers";
const { config, googleEndpoints } = await import("../server/config");
const { resetJwksCache } = await import("../server/google/oidc");
const { avatarWorkSettled } = await import("../server/google/routes");
const { resetRegistrationRateLimit } = await import("../server/authLimits");
const avatars = await import("../server/avatars");

retireUsersAfterFile();
type AvatarState = { avatarUrl: string | null; source: "upload" | "google" | "none"; google: { linked: boolean; hasPicture: boolean } };

const put = (session: Session, body: unknown) => request("/me/avatar", { method: "PUT", body: JSON.stringify(body) }, session);
const upload = (session: Session, bytes: Uint8Array) => put(session, { source: "upload", image: base64(bytes) });
const avatarIdOf = (userId: string) => (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null }).avatar_id;
const codeOf = async (response: Response) => (await response.json() as { code?: string }).code;

describe("helpers", () => {
  test("ids say where a picture came from; the removed marker is never a URL", () => {
    const uploaded = avatars.uploadedAvatarId();
    expect(uploaded).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(avatars.avatarSourceOf(uploaded)).toBe("upload");
    expect(avatars.avatarSourceOf(crypto.randomUUID())).toBe("google");
    expect(avatars.avatarSourceOf(null)).toBe("none");
    expect(avatars.avatarSourceOf(avatars.AVATAR_REMOVED)).toBe("none");
    expect(avatars.avatarChosenByPerson(avatars.AVATAR_REMOVED)).toBe(true);
    expect(avatars.avatarChosenByPerson(crypto.randomUUID())).toBe(false);
    expect(avatars.avatarUrlFor(crypto.randomUUID(), avatars.AVATAR_REMOVED)).toBeNull();
  });

  test("pixel sizes from PNG, JPEG, and WebP headers", () => {
    expect(avatars.avatarDimensions(makePng(37, 21))).toEqual({ width: 37, height: 21 });
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
    jpeg.set([0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03], 20);
    expect(avatars.avatarDimensions(jpeg)).toEqual({ width: 600, height: 300 });
    const webp = new Uint8Array(40);
    webp.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"), 0);
    webp.set([0xff, 0x01, 0x00, 0x7f, 0x00, 0x00], 24);
    expect(avatars.avatarDimensions(webp)).toEqual({ width: 512, height: 128 });
    expect(avatars.avatarDimensions(SVG_IMAGE)).toBeNull();
  });
});

describe("PUT /api/me/avatar", () => {
  test("an upload is sniffed, stored under a new version-8 id, served with the usual headers, and replaces the last", async () => {
    const person = await createUser("U7 uploader");
    const png = makePng(48, 48);
    const response = await upload(person, png);
    expect(response.status).toBe(200);
    const state = await response.json() as AvatarState;
    expect(state.source).toBe("upload");
    expect(state.google).toEqual({ linked: false, hasPicture: false });
    const firstId = avatarIdOf(person.userId)!;
    expect(firstId[14]).toBe("8");
    expect(state.avatarUrl).toBe(`/api/users/${person.userId}/avatar?v=${firstId}`);
    expect(Buffer.compare(await storedObjectBytes(firstId, "avatars"), Buffer.from(png))).toBe(0);
    const viewer = await createUser("U7 onlooker");
    const image = await fetch(`${origin}${state.avatarUrl}`, { headers: { Cookie: viewer.cookie } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cache-control")).toBe("private, no-cache");
    expect(image.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.compare(Buffer.from(await image.arrayBuffer()), Buffer.from(png))).toBe(0);
    // The session's own payloads carry it (header, Settings, the people picker).
    expect((await (await request("/auth/me", {}, person)).json() as { user: { avatarUrl: string } }).user.avatarUrl).toBe(state.avatarUrl!);
    expect(((await (await request("/me/avatar", {}, person)).json()) as AvatarState).source).toBe("upload");
    // A second upload gets a new URL (cache-busting): the old one is 404 and its file is gone.
    const again = await upload(person, makePng(32, 32, [10, 200, 10]));
    expect(again.status).toBe(200);
    const secondId = avatarIdOf(person.userId)!;
    expect(secondId).not.toBe(firstId);
    expect(await storedObjectExists(firstId, "avatars")).toBe(false);
    expect(await storedObjectExists(secondId, "avatars")).toBe(true);
    expect((await fetch(`${origin}${state.avatarUrl}`, { headers: { Cookie: viewer.cookie } })).status).toBe(404);
    // Audited without the bytes.
    const rows = db.query("SELECT metadata_json FROM audit_log WHERE actor_id = ? AND event_type = 'account.avatar_changed' ORDER BY created_at").all(person.userId) as Array<{ metadata_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ source: "upload", previousSource: "none", type: "image/png", width: 48, height: 48 });
    expect(rows[0]!.metadata_json).not.toContain(base64(png).slice(0, 24));
  });

  test("SVG, GIF, HTML, bad base64, too large, and too many pixels are refused; nothing is stored", async () => {
    const person = await createUser("U7 refused");
    expect(await codeOf(await upload(person, SVG_IMAGE))).toBe("AVATAR_TYPE");
    expect((await upload(person, GIF_1X1)).status).toBe(415);
    expect((await upload(person, new TextEncoder().encode("<html><script>alert(1)</script></html>"))).status).toBe(415);
    const badBase64 = await put(person, { source: "upload", image: "not base64!!" });
    expect(badBase64.status).toBe(400);
    const big = new Uint8Array(avatars.AVATAR_MAX_BYTES + 1);
    big.set(makePng(8, 8).subarray(0, 33));
    const tooBig = await upload(person, big);
    expect({ status: tooBig.status, code: await codeOf(tooBig) }).toEqual({ status: 413, code: "AVATAR_TOO_LARGE" });
    const huge = makePng(1, 1);
    new DataView(huge.buffer).setUint32(16, 30_000);
    new DataView(huge.buffer).setUint32(20, 30_000);
    const bomb = await upload(person, huge);
    expect({ status: bomb.status, code: await codeOf(bomb) }).toEqual({ status: 422, code: "AVATAR_DIMENSIONS" });
    expect((await put(person, { source: "upload" })).status).toBe(400);
    expect((await put(person, { source: "elsewhere" })).status).toBe(400);
    expect((await put(person, { source: "none", image: "x" })).status).toBe(400);
    expect(avatarIdOf(person.userId)).toBeNull();
    // Sessions only: no cookie is 401, and a JSON body is required (no multipart side door).
    expect((await request("/me/avatar", { method: "PUT", body: JSON.stringify({ source: "none" }) })).status).toBe(401);
    expect((await request("/me/avatar", { method: "PUT", body: new FormData() }, person)).status).toBe(415);
  });

  test("Remove goes back to the letters: the file goes and every payload says no picture", async () => {
    const person = await createUser("U7 remover");
    await upload(person, makePng(16, 16));
    const fileId = avatarIdOf(person.userId)!;
    const removed = await put(person, { source: "none" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ avatarUrl: null, source: "none" });
    expect(avatarIdOf(person.userId)).toBe(avatars.AVATAR_REMOVED);
    expect(await storedObjectExists(fileId, "avatars")).toBe(false);
    expect((await (await request("/auth/me", {}, person)).json() as { user: { avatarUrl: string | null } }).user.avatarUrl).toBeNull();
    expect((await request(`/users/${person.userId}/avatar?v=${avatars.AVATAR_REMOVED}`, {}, person)).status).toBe(404);
    const member = await (await request(`/team/${person.userId}`, {}, person)).json() as { member?: { avatarUrl: string | null } };
    if (member.member) expect(member.member.avatarUrl).toBeNull();
    expect(avatars.avatarUrlsFor([person.userId]).has(person.userId)).toBe(false);
    // The sweep leaves the marker alone (it is never listed as a file).
    expect(await avatars.sweepAvatarFiles()).toBeGreaterThanOrEqual(0);
    expect(avatarIdOf(person.userId)).toBe(avatars.AVATAR_REMOVED);
  });

  test("viewers and guests may change their own picture (the one write-gate entry); other writes stay refused", async () => {
    for (const role of ["viewer", "guest"] as const) {
      const person = await createUser(`U7 ${role}`);
      db.query("UPDATE users SET role = ? WHERE id = ?").run(role, person.userId);
      expect((await upload(person, makePng(12, 12))).status).toBe(200);
      expect((await put(person, { source: "none" })).status).toBe(200);
      const other = await request("/folders", { method: "POST", body: JSON.stringify({ name: "Nope" }) }, person);
      expect({ role, status: other.status, code: await codeOf(other) }).toEqual({ role, status: 403, code: "ROLE_READ_ONLY" });
    }
  });

  test("ten changes a minute per account, then 429 RATE_LIMITED", async () => {
    const person = await createUser("U7 busy");
    for (let index = 0; index < 10; index += 1) expect((await put(person, { source: "none" })).status).toBe(200);
    const limited = await put(person, { source: "none" });
    expect({ status: limited.status, code: await codeOf(limited) }).toEqual({ status: 429, code: "RATE_LIMITED" });
    // Per account: someone else is not affected.
    expect((await put(await createUser("U7 calm"), { source: "none" })).status).toBe(200);
  });

});

describe("with Google sign-in (Wave 35 sync kept)", () => {
  let fake: FakeGoogle;
  const saved = { auth: structuredClone(config.auth), allowRegistration: config.allowRegistration };
  beforeAll(async () => { fake = await startFakeGoogle(); });
  afterAll(() => {
    Object.assign(config.auth, structuredClone(saved.auth));
    config.allowRegistration = saved.allowRegistration;
    resetJwksCache();
    fake.stop();
  });
  beforeEach(() => {
    config.auth.methods = "both";
    config.auth.google.clientId = fake.clientId;
    config.auth.google.clientSecret = fake.clientSecret;
    config.auth.google.allowedDomains = [];
    config.auth.google.endpoints = googleEndpoints(fake.url);
    config.allowRegistration = true;
    resetJwksCache();
    resetRegistrationRateLimit();
    db.query("DELETE FROM google_auth_flows").run();
  });

  const cookieOf = (response: Response, name: string) => response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!).find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null;
  async function googleSignIn(identity: FakeIdentity) {
    const started = await fetch(`${origin}/api/auth/google/start`, { redirect: "manual" });
    const callbackUrl = fake.authorize(started.headers.get("location") ?? "", identity, {});
    const response = await fetch(callbackUrl, { redirect: "manual", headers: { Cookie: cookieOf(started, "nook_google_flow")! } });
    const cookie = cookieOf(response, "mynotes_session")!;
    await avatarWorkSettled();
    const me = await (await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } })).json() as { user: { id: string; email: string }; csrfToken: string };
    return { cookie, setCookie: cookie, csrf: me.csrfToken, userId: me.user.id, email: me.user.email, password: "" } satisfies Session;
  }

  test("an uploaded or removed picture survives Google sign-ins until the person chooses their Google picture", async () => {
    const email = spareEmail();
    const identity: FakeIdentity = { sub: `sub-${crypto.randomUUID()}`, email, name: "U7 Google", picture: fake.avatarUrl(`${crypto.randomUUID()}.png`) };
    const session = await googleSignIn(identity);
    const googleId = avatarIdOf(session.userId)!;
    expect(avatars.avatarSourceOf(googleId)).toBe("google");
    let state = await (await request("/me/avatar", {}, session)).json() as AvatarState;
    expect(state).toMatchObject({ source: "google", google: { linked: true, hasPicture: true } });

    // Upload: Google's copy goes; a changed Google picture and "no picture" at Google leave it.
    expect((await upload(session, makePng(20, 20))).status).toBe(200);
    const uploadedId = avatarIdOf(session.userId)!;
    expect(await storedObjectExists(googleId, "avatars")).toBe(false);
    await googleSignIn({ ...identity, picture: fake.avatarUrl("changed-u7.png") });
    expect(avatarIdOf(session.userId)).toBe(uploadedId);
    await googleSignIn({ ...identity, picture: null });
    expect(avatarIdOf(session.userId)).toBe(uploadedId);

    // Google has no picture now: "Use my Google picture" says so.
    const none = await put(session, { source: "google" });
    expect({ status: none.status, code: await codeOf(none) }).toEqual({ status: 409, code: "GOOGLE_PICTURE_UNAVAILABLE" });
    await googleSignIn(identity);
    expect(avatarIdOf(session.userId)).toBe(uploadedId);

    // Choosing Google brings the copy back and it follows Google again.
    const back = await put(session, { source: "google" });
    expect(back.status).toBe(200);
    state = await back.json() as AvatarState;
    expect(state.source).toBe("google");
    expect(await storedObjectExists(uploadedId, "avatars")).toBe(false);
    const chosenGoogle = avatarIdOf(session.userId)!;
    expect((await fetch(`${origin}${state.avatarUrl}`, { headers: { Cookie: session.cookie } })).status).toBe(200);
    await googleSignIn({ ...identity, picture: fake.avatarUrl("changed-again-u7.png") });
    expect(avatarIdOf(session.userId)).not.toBe(chosenGoogle);
    expect(avatars.avatarSourceOf(avatarIdOf(session.userId))).toBe("google");

    // Removed: Google sign-ins keep the letters.
    expect((await put(session, { source: "none" })).status).toBe(200);
    await googleSignIn({ ...identity, picture: fake.avatarUrl("yet-another-u7.png") });
    expect(avatarIdOf(session.userId)).toBe(avatars.AVATAR_REMOVED);
    const audits = db.query("SELECT json_extract(metadata_json, '$.source') AS source FROM audit_log WHERE actor_id = ? AND event_type = 'account.avatar_changed' ORDER BY rowid").all(session.userId) as Array<{ source: string }>;
    expect(audits.map((row) => row.source)).toEqual(["upload", "google", "none"]);
  });

  test("unlinking Google keeps an uploaded picture (and still removes Google's copy)", async () => {
    const { clearAvatar } = avatars;
    const person = await createUser("U7 unlink");
    await upload(person, makePng(10, 10));
    const uploadedId = avatarIdOf(person.userId)!;
    await clearAvatar(person.userId);
    expect(avatarIdOf(person.userId)).toBe(uploadedId);
    const googleCopy = crypto.randomUUID();
    db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(googleCopy, person.userId);
    await clearAvatar(person.userId);
    expect(avatarIdOf(person.userId)).toBeNull();
  });
});
