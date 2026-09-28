import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataDir, db, origin, register, request, tailscaleOrigin, type Session } from "./support/harness";

const { resetRegistrationRateLimit } = await import("../server/index");

const { totpCodeAt, totpCounter } = await import("../server/totp");
const { registeredMigrationIds } = await import("../server/migrations");

describe("authorization and version workflow", () => {
  test("enforces restrictive data and database permissions", () => {
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "mynotes.sqlite")).mode & 0o777).toBe(0o600);
    const migrations = db.query("SELECT id, name FROM schema_migrations ORDER BY id").all() as Array<{ id: number; name: string }>;
    expect(migrations.map((migration) => migration.id)).toEqual([...registeredMigrationIds]);
    // 1–20 are on main; later waves (021 and up) may or may not be registered yet.
    expect(registeredMigrationIds.slice(0, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(registeredMigrationIds.slice(20).every((id) => id >= 21)).toBe(true);
  });

  test("registration is limited to 10 attempts a minute server-wide, refused ones included", async () => {
    resetRegistrationRateLimit();
    const attempt = () => request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "blocked@example.test", displayName: "Blocked", password: "correct horse battery staple" })
    });
    for (let index = 0; index < 10; index += 1) expect((await attempt()).status).toBe(403);
    expect((await attempt()).status).toBe(429);
    // The harness clears the bucket before each register(), so this still succeeds.
    await register("After the limit");
  });

  test("rejects registration and login outside the email allowlist", async () => {
    const registration = await request("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "blocked@example.test", displayName: "Blocked", password: "correct horse battery staple" })
    });
    expect(registration.status).toBe(403);
    const login = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "blocked@example.test", password: "correct horse battery staple" })
    });
    expect(login.status).toBe(401);
  });

  test("accepts exact LAN/Tailscale origins and secures HTTPS cookies", async () => {
    const tailscaleUser = await register("Tailscale owner", tailscaleOrigin);
    expect(tailscaleUser.setCookie).toMatch(/;\s*Secure/i);
    const mutation = await request("/folders", {
      method: "POST",
      headers: { Origin: tailscaleOrigin },
      body: JSON.stringify({ name: "Remote", parentId: null })
    }, tailscaleUser);
    expect(mutation.status).toBe(201);

    const lanUser = await register("LAN owner", origin);
    expect(lanUser.setCookie).not.toMatch(/;\s*Secure/i);
    const hostile = await request("/folders", {
      method: "POST",
      headers: { Origin: "http://192.0.2.10:2026" },
      body: JSON.stringify({ name: "Blocked", parentId: null })
    }, lanUser);
    expect(hostile.status).toBe(403);
  });

  test("issues one-time MCP keys, authenticates Streamable HTTP, and revokes access", async () => {
    const owner = await register("MCP owner");
    const createNote = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const noteId = ((await createNote.json()) as { note: { id: string } }).note.id;
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# MCP knowledge\n\nPublished only", revision: 1 }) }, owner);
    await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "# DRAFT SECRET\n\nNever expose this", revision: null }) }, owner);

    const rejectedKey = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "Test client", password: "wrong password" }) }, owner);
    expect(rejectedKey.status).toBe(401);
    const createKey = await request("/mcp/keys", { method: "POST", body: JSON.stringify({ name: "Test client", password: owner.password }) }, owner);
    expect(createKey.status).toBe(201);
    const created = (await createKey.json()) as { key: { id: string; token: string; prefix: string } };
    expect(created.key.token).toMatch(/^mynotes_[A-Za-z0-9_-]{43}$/);
    const stored = db.query("SELECT token_hash FROM mcp_api_keys WHERE id = ?").get(created.key.id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(created.key.token);

    const listed = await request("/mcp/keys", {}, owner);
    const listedBody = (await listed.json()) as { keys: Array<Record<string, unknown>> };
    expect(JSON.stringify(listedBody)).not.toContain(created.key.token);
    expect(listedBody.keys).toHaveLength(1);

    const rpc = (method: string, params?: unknown, token = created.key.token) => fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })
    });
    expect((await fetch(`${origin}/mcp`, { method: "POST" })).status).toBe(401);
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("cache-control")).toContain("no-store");
    expect(initialized.headers.get("vary")).toContain("Authorization");
    expect(await initialized.text()).toContain("\"nook\"");

    const hostileOrigin = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key.token}`, Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(hostileOrigin.status).toBe(403);

    const allowedRemoteHost = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.key.token}`,
        Host: "notes.example-tailnet.ts.net",
        Origin: tailscaleOrigin,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(allowedRemoteHost.status).toBe(200);
    const hostileHost = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key.token}`, Host: "attacker.example", Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(hostileHost.status).toBe(403);

    const tools = await rpc("tools/list", {});
    expect(tools.status).toBe(200);
    const toolsBody = await tools.text();
    expect(toolsBody).toContain("list_notes");
    expect(toolsBody).toContain("read_note");
    expect(toolsBody).not.toContain("create_note");

    const notes = await rpc("tools/call", { name: "list_notes", arguments: { query: "MCP" } });
    expect(notes.status).toBe(200);
    const notesText = await notes.text();
    expect(notesText).toContain("MCP knowledge");
    expect(notesText).not.toContain("DRAFT SECRET");

    const read = await rpc("tools/call", { name: "read_note", arguments: { noteId } });
    const readText = await read.text();
    expect(readText).toContain("Published only");
    expect(readText).not.toContain("Never expose this");

    expect((await request(`/mcp/keys/${created.key.id}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect((await rpc("tools/list", {})).status).toBe(401);
  }, 20_000);

  test("encrypts TOTP and recovery codes, supports one-time recovery, and rejects replay", async () => {
    const owner = await register("TOTP owner");
    expect(totpCodeAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1)).toBe("287082");
    const setupResponse = await request("/auth/totp/setup", { method: "POST", body: JSON.stringify({ password: owner.password }) }, owner);
    expect(setupResponse.status).toBe(200);
    const setup = await setupResponse.json() as { secret: string; uri: string };
    expect(setup.uri).toContain("otpauth://totp/");
    expect(setup.uri).toContain("issuer=Nook");

    const stored = db.query("SELECT totp_secret FROM users WHERE id = ?").get(owner.userId) as { totp_secret: string };
    expect(stored.totp_secret.startsWith("v1:")).toBe(true);
    expect(stored.totp_secret).not.toContain(setup.secret);

    const previousCode = totpCodeAt(setup.secret, totpCounter() - 1);
    const enable = await request("/auth/totp/enable", { method: "POST", body: JSON.stringify({ code: previousCode }) }, owner);
    expect(enable.status).toBe(200);
    const enabled = await enable.json() as { enabled: boolean; recoveryCodes: string[] };
    expect(enabled.enabled).toBe(true);
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect(enabled.recoveryCodes[0]).toMatch(/^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){2}$/);
    const encryptedCodes = db.query("SELECT totp_recovery_codes FROM users WHERE id = ?").get(owner.userId) as { totp_recovery_codes: string };
    expect(encryptedCodes.totp_recovery_codes.startsWith("v1:")).toBe(true);
    expect(encryptedCodes.totp_recovery_codes).not.toContain(enabled.recoveryCodes[0]!);

    const currentCounter = totpCounter();
    const currentCode = totpCodeAt(setup.secret, currentCounter);
    const reveal = await request("/auth/totp/recovery-codes", { method: "POST", body: JSON.stringify({ password: owner.password, code: currentCode }) }, owner);
    expect(reveal.status).toBe(200);
    expect(((await reveal.json()) as { recoveryCodes: string[] }).recoveryCodes).toEqual(enabled.recoveryCodes);

    await request("/auth/logout", { method: "POST", body: "{}" }, owner);
    const passwordOnly = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password })
    });
    expect(passwordOnly.status).toBe(428);
    expect(((await passwordOnly.json()) as { requiresTotp: boolean }).requiresTotp).toBe(true);

    db.query("UPDATE users SET totp_last_counter = ? WHERE id = ?").run(currentCounter - 1, owner.userId);
    const login = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password, totpCode: currentCode })
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json() as { csrfToken: string };
    const loginSession: Session = { ...owner, csrf: loginBody.csrfToken, cookie: login.headers.get("set-cookie")!.split(";", 1)[0]! };
    const replay = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: owner.email, password: owner.password, totpCode: currentCode })
    });
    expect(replay.status).toBe(401);

    const recoveryLogin = await request("/auth/login", { method: "POST", body: JSON.stringify({ email: owner.email, password: owner.password, recoveryCode: enabled.recoveryCodes[0] }) });
    expect(recoveryLogin.status).toBe(200);
    const recoveryReplay = await request("/auth/login", { method: "POST", body: JSON.stringify({ email: owner.email, password: owner.password, recoveryCode: enabled.recoveryCodes[0] }) });
    expect(recoveryReplay.status).toBe(401);

    db.query("UPDATE users SET totp_last_counter = ?, totp_recovery_codes = NULL WHERE id = ?").run(currentCounter - 1, owner.userId);
    const regenerate = await request("/auth/totp/recovery-codes/regenerate", { method: "POST", body: JSON.stringify({ password: owner.password, code: currentCode }) }, loginSession);
    expect(regenerate.status).toBe(200);
    const regeneratedCodes = ((await regenerate.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(regeneratedCodes).toHaveLength(10);
    expect(regeneratedCodes).not.toEqual(enabled.recoveryCodes);

    db.query("UPDATE users SET totp_last_counter = ? WHERE id = ?").run(currentCounter - 1, owner.userId);
    const revealRegenerated = await request("/auth/totp/recovery-codes", { method: "POST", body: JSON.stringify({ password: owner.password, code: currentCode }) }, loginSession);
    expect(revealRegenerated.status).toBe(200);
    expect(((await revealRegenerated.json()) as { recoveryCodes: string[] }).recoveryCodes).toEqual(regeneratedCodes);
  }, 20_000);

  test("keeps notes private, rejects CSRF, then shares and versions safely", async () => {
    const owner = await register("Owner");
    const reader = await register("Reader");

    const folderResponse = await request("/folders", {}, owner);
    const ownerFolders = ((await folderResponse.json()) as { folders: Array<{ id: string; name: string; is_default: number }> }).folders;
    expect(ownerFolders).toHaveLength(1);
    expect(ownerFolders[0]?.name).toBe("Default");
    expect(ownerFolders[0]?.is_default).toBe(1);

    const rejected = await fetch(`${origin}/api/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, Cookie: owner.cookie },
      body: JSON.stringify({ folderId: null })
    });
    expect(rejected.status).toBe(403);

    const create = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    expect(create.status).toBe(201);
    const createdNote = ((await create.json()) as { note: { id: string; folder_id: string } }).note;
    const noteId = createdNote.id;
    expect(createdNote.folder_id).toBe(ownerFolders[0]?.id);

    const fresh = await request(`/notes/${noteId}`, {}, owner);
    const freshNote = ((await fresh.json()) as { note: { hasDraft: boolean; hasDelta: boolean } }).note;
    expect(freshNote.hasDraft).toBe(true);
    expect(freshNote.hasDelta).toBe(false);
    const blankPublish = await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    expect(blankPublish.status).toBe(409);

    const folderCreate = await request("/folders", { method: "POST", body: JSON.stringify({ name: "Projects", parentId: null }) }, owner);
    const projectFolderId = ((await folderCreate.json()) as { folder: { id: string } }).folder.id;
    const move = await request(`/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ folderId: projectFolderId }) }, owner);
    expect(move.status).toBe(200);
    const moved = await request(`/notes/${noteId}`, {}, owner);
    expect(((await moved.json()) as { note: { folder_id: string } }).note.folder_id).toBe(projectFolderId);

    const hidden = await request(`/notes/${noteId}`, {}, reader);
    expect(hidden.status).toBe(404);

    const save = await request(`/notes/${noteId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ markdown: "# First\n\npassword = hunter2", revision: 1 })
    }, owner);
    expect(save.status).toBe(200);
    const savedDraft = (await save.json()) as { revision: number; hasDelta: boolean };
    expect(savedDraft.revision).toBe(2);
    expect(savedDraft.hasDelta).toBe(true);

    const publish = await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    expect(publish.status).toBe(200);
    expect(((await publish.json()) as { version: number }).version).toBe(1);

    const published = await request(`/notes/${noteId}`, {}, owner);
    const publishedNote = ((await published.json()) as { note: { hasDraft: boolean; hasDelta: boolean } }).note;
    expect(publishedNote.hasDraft).toBe(false);
    expect(publishedNote.hasDelta).toBe(false);

    const shareFolder = await request(`/folders/${projectFolderId}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] })
    }, owner);
    expect(shareFolder.status).toBe(200);

    const inherited = await request(`/notes/${noteId}`, {}, reader);
    expect(inherited.status).toBe(200);

    const privateOverride = await request(`/notes/${noteId}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ visibility: "private", userIds: [] })
    }, owner);
    expect(privateOverride.status).toBe(200);
    expect((await request(`/notes/${noteId}`, {}, reader)).status).toBe(404);

    const inheritAgain = await request(`/notes/${noteId}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ visibility: "inherit", userIds: [] })
    }, owner);
    expect(inheritAgain.status).toBe(200);
    expect((await request(`/notes/${noteId}`, {}, reader)).status).toBe(200);

    const share = await request(`/notes/${noteId}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ visibility: "selected", userIds: [reader.userId] })
    }, owner);
    expect(share.status).toBe(200);

    const visible = await request(`/notes/${noteId}`, {}, reader);
    expect(visible.status).toBe(200);
    const sharedBody = await visible.json() as { note: { markdown: string; isOwner: boolean; title: string } };
    expect(sharedBody.note.markdown).toContain("hunter2");
    expect(sharedBody.note.isOwner).toBe(false);
    expect(sharedBody.note.title).toBe("First");

    const readerEdit = await request(`/notes/${noteId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ markdown: "changed", revision: null })
    }, reader);
    expect(readerEdit.status).toBe(404);

    const versions = await request(`/notes/${noteId}/versions`, {}, reader);
    expect(versions.status).toBe(200);
    expect(((await versions.json()) as { versions: unknown[] }).versions).toHaveLength(1);

    const identical = await request(`/notes/${noteId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ markdown: "# First\n\npassword = hunter2", revision: null })
    }, owner);
    expect(identical.status).toBe(200);
    expect(((await identical.json()) as { hasDelta: boolean }).hasDelta).toBe(false);
    expect((await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner)).status).toBe(409);
    const unchangedVersions = await request(`/notes/${noteId}/versions`, {}, owner);
    expect(((await unchangedVersions.json()) as { versions: unknown[] }).versions).toHaveLength(1);

    const blankCreate = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const blankId = ((await blankCreate.json()) as { note: { id: string } }).note.id;
    const blankPath = join(dataDir, "notes", blankId);
    expect(existsSync(blankPath)).toBe(true);
    expect((await request(`/notes/${blankId}`, { method: "DELETE", body: "{}" }, owner)).status).toBe(200);
    expect(existsSync(blankPath)).toBe(false);
    expect((await request(`/notes/${blankId}`, {}, owner)).status).toBe(404);
  }, 20_000);

  test("serializes concurrent draft saves and publishes", async () => {
    const owner = await register("Concurrent owner");
    const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const noteId = ((await created.json()) as { note: { id: string } }).note.id;

    const save = (markdown: string) => request(`/notes/${noteId}/draft`, {
      method: "PUT",
      body: JSON.stringify({ markdown, revision: 1 })
    }, owner);
    const saveResponses = await Promise.all([save("first writer"), save("second writer")]);
    expect(saveResponses.map((response) => response.status).sort()).toEqual([200, 409]);

    const loaded = await request(`/notes/${noteId}`, {}, owner);
    const loadedBody = await loaded.json() as { note: { markdown: string; draft_revision: number } };
    expect(["first writer", "second writer"]).toContain(loadedBody.note.markdown);
    expect(loadedBody.note.draft_revision).toBe(2);

    const publish = () => request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    const publishResponses = await Promise.all([publish(), publish()]);
    expect(publishResponses.map((response) => response.status).sort()).toEqual([200, 409]);

    const history = await request(`/notes/${noteId}/versions`, {}, owner);
    expect(((await history.json()) as { versions: unknown[] }).versions).toHaveLength(1);
  }, 20_000);

  test("rejects a symlink substituted for a note directory", async () => {
    const owner = await register("Symlink owner");
    const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const noteId = ((await created.json()) as { note: { id: string } }).note.id;
    const notePath = join(dataDir, "notes", noteId);
    const outside = mkdtempSync(join(tmpdir(), "mynotes-outside-"));
    rmSync(notePath, { recursive: true, force: true });
    symlinkSync(outside, notePath, "dir");
    const response = await request(`/notes/${noteId}`, {}, owner);
    expect(response.status).toBe(500);
    rmSync(notePath, { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("recovers an uncommitted staged version without overwriting history", async () => {
    const owner = await register("Recovery owner");
    const created = await request("/notes", { method: "POST", body: JSON.stringify({ folderId: null }) }, owner);
    const noteId = ((await created.json()) as { note: { id: string } }).note.id;
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "version one", revision: 1 }) }, owner);
    await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    await request(`/notes/${noteId}/draft`, { method: "PUT", body: JSON.stringify({ markdown: "version two", revision: null }) }, owner);

    const versionsDir = join(dataDir, "notes", noteId, "versions");
    mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(versionsDir, "000002.md"), "orphan from interrupted publish", { mode: 0o600 });
    const publish = await request(`/notes/${noteId}/publish`, { method: "POST", body: "{}" }, owner);
    expect(publish.status).toBe(200);

    const version = await request(`/notes/${noteId}/versions/2`, {}, owner);
    expect(((await version.json()) as { markdown: string }).markdown).toBe("version two");
    const loaded = await request(`/notes/${noteId}`, {}, owner);
    expect(((await loaded.json()) as { note: { title: string } }).note.title).toBe("version two");
  });
});
