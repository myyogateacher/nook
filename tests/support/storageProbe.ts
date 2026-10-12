/**
 * Run as a separate `bun` process by tests/s3Storage.test.ts: the storage backend is read once at
 * startup, so each configuration (an incomplete S3 setup, a wrong key, another Nook's prefix, a migrated
 * data directory) needs its own process. It calls the app's fetch handler directly (no socket) and prints
 * one line, `PROBE {json}`. DATA_DIR and the STORAGE_BACKEND / S3_* settings come from the environment.
 *
 *   mode=start  start the server and report the backend
 *   mode=serve  start the server and keep running until a signal stops it
 *   mode=seed   register, upload two Files and a picture, create a whiteboard, set a profile picture
 *   mode=check  download every seeded file (ids in PROBE_SEED) and report sizes and hashes
 */
import { createHash } from "node:crypto";

const mode = process.argv[2];
const origin = "http://localhost:22031";
Object.assign(process.env, {
  APP_ORIGIN: origin,
  APP_ORIGINS: origin,
  PORT: "22031",
  NODE_ENV: "test",
  COOKIE_SECURE: "false",
  TOTP_POLICY: "optional",
  ALLOW_REGISTRATION: "true",
  SIGNUP_ROLE: "member",
  MAX_UPLOAD_BYTES: "4194304",
  MIN_FREE_DISK_BYTES: "0"
});

const app = (await import("../../server/index")).default;
const { objectStore } = await import("../../server/objectStore");
const { db } = await import("../../server/db");

async function send(path: string, init: RequestInit & { cookie?: string; csrf?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.csrf) headers.set("X-CSRF-Token", init.csrf);
  return app.fetch(new Request(`${origin}/api${path}`, { ...init, headers }));
}
const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, any>, cookie: response.headers.get("set-cookie")?.split(";")[0] });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function signIn() {
  const credentials = { email: "s3-probe@nook.test", password: "correct horse battery staple" };
  let response = await json(await send("/auth/register", { method: "POST", body: JSON.stringify({ ...credentials, displayName: "S3 probe" }) }));
  if (response.status !== 201) response = await json(await send("/auth/login", { method: "POST", body: JSON.stringify(credentials) }));
  return { cookie: response.cookie!, csrf: response.body.csrfToken as string, userId: response.body.user.id as string };
}

if (mode === "start") {
  console.log(`PROBE ${JSON.stringify({ backend: objectStore().backend })}`);
} else if (mode === "serve") {
  // Runs like a server until it is stopped with a signal (the S3 claim is released on SIGTERM).
  console.log(`PROBE ${JSON.stringify({ backend: objectStore().backend, serving: true })}`);
  await new Promise(() => undefined);
} else if (mode === "seed") {
  const session = await signIn();
  const uploadFile = async (bytes: Uint8Array, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    // Uploads need a Content-Length, which a Request built from FormData does not carry.
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type")!;
    const body = new Uint8Array(await encoded.arrayBuffer());
    const headers = { "Content-Type": contentType, "Content-Length": String(body.byteLength) };
    const response = await json(await send("/files", { method: "POST", body, headers, cookie: session.cookie, csrf: session.csrf }));
    if (response.status !== 201) throw new Error(`Upload failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body.document.id as string;
  };
  const text = new TextEncoder().encode("hello from the local disk\n".repeat(50));
  const binary = new Uint8Array(300_000).map((_, index) => (index * 31) % 256);
  const files = [await uploadFile(text, "notes.txt"), await uploadFile(binary, "data.bin")];
  const board = await json(await send("/whiteboards", { method: "POST", body: JSON.stringify({ name: "Seed board" }), cookie: session.cookie, csrf: session.csrf }));
  const avatarId = crypto.randomUUID();
  await objectStore().put("avatars", avatarId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  db.query("UPDATE users SET avatar_id = ? WHERE id = ?").run(avatarId, session.userId);
  console.log(`PROBE ${JSON.stringify({ files, boardId: board.body.whiteboard.id, avatarId, userId: session.userId, hashes: [sha(text), sha(binary)] })}`);
} else if (mode === "check") {
  const seed = JSON.parse(process.env.PROBE_SEED ?? "{}") as { files: string[]; boardId: string; avatarId: string; userId: string };
  const session = await signIn();
  const files = [];
  for (const id of seed.files) {
    const response = await send(`/files/${id}/content`, { cookie: session.cookie });
    const bytes = new Uint8Array(await response.arrayBuffer());
    files.push({ status: response.status, size: bytes.byteLength, sha256: sha(bytes) });
  }
  const board = await send(`/whiteboards/${seed.boardId}`, { cookie: session.cookie });
  const avatar = await send(`/users/${seed.userId}/avatar?v=${seed.avatarId}`, { cookie: session.cookie });
  console.log(`PROBE ${JSON.stringify({ backend: objectStore().backend, files, board: board.status, avatar: avatar.status })}`);
}
process.exit(0);
