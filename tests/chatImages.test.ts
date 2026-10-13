import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser, db, origin, type Session } from "./support/harness";
import { api, makeKey } from "./support/mcpClient";
import { startFakeProvider } from "./support/fakeProvider";
import { startFakeMcpServer } from "./support/fakeMcpServer";
import { retireUsersAfterFile } from "./support/retireUsers";
import { settleAgentRunsAfterEach } from "./support/agentRuns";
import { GIF_1X1, makePng, SVG_IMAGE } from "./support/images";

const { config } = await import("../server/config");
const { storedBytes } = await import("../server/documents");
const { chargeImageLoad, IMAGE_PROXY_LIMITS, imageLoadsInFlight } = await import("../server/agents/images");
const { deleteProvider } = await import("../server/agents/providers");
const { resetToolServersForTests } = await import("../server/agents/toolServers");
const { toolImageOf } = await import("../server/agents/mcpClient");

/**
 * Images in chats (D370 as amended, T304): the image proxy (`GET /api/agents/image-proxy`) and tool
 * images (`GET /api/chats/:chatId/tool-images/:imageId`). The proxy needs a session and its header,
 * never takes an API key, goes out through the egress guard (private hosts, redirects, caps), answers
 * only sniffed PNG/JPEG/GIF/WebP bytes with the strict header set, and is rate-limited per person.
 * Tool images are checked by their bytes, capped, stored once per picture with a reference per chat,
 * counted against the owner's quota and the disk floor, served to its readers (the active branch for
 * people it is shared with), and kept by a copy; the model is told only whether an image was shown.
 *
 * Security review fixes: the proxy never uses AGENT_ALLOWED_PRIVATE_HOSTS (public https on 443 only;
 * the test-only AGENT_IMAGE_PROXY_TEST_HOSTS stands in for a local picture host here), every failure
 * on the far side is one 502, and a browser that leaves aborts the fetch (M1, L1, L2); blobs are
 * deduplicated and released by the last reference (M2); readers see the active branch only (L3, L4).
 */

retireUsersAfterFile();
settleAgentRunsAfterEach();

const PNG = makePng(32, 20);
const BIG = new Uint8Array(IMAGE_PROXY_LIMITS.maxBytes + 1024);
BIG.set(PNG.subarray(0, 16));
const received: Array<{ path: string; headers: Record<string, string> }> = [];
let slowCancelled = false;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
const imageHost = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    received.push({ path: url.pathname, headers });
    switch (url.pathname) {
      case "/chart.png": return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      // The upstream's type is never trusted: these bytes are a GIF.
      case "/pixel": return new Response(GIF_1X1, { headers: { "Content-Type": "text/html" } });
      case "/page.png": return new Response("<html><body>not an image</body></html>", { headers: { "Content-Type": "image/png" } });
      case "/logo": return new Response(SVG_IMAGE, { headers: { "Content-Type": "image/png" } });
      case "/big.png": return new Response(BIG, { headers: { "Content-Type": "image/png" } });
      case "/stream-big.png": return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(PNG.subarray(0, 64));
          const block = new Uint8Array(512 * 1024);
          for (let sent = 0; sent < IMAGE_PROXY_LIMITS.maxBytes + block.length; sent += block.length) controller.enqueue(block);
          controller.close();
        }
      }), { headers: { "Content-Type": "image/png" } });
      case "/moved.png": return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${IMAGE_PORT}/chart.png` } });
      // Sends the first bytes, then nothing for 20 s: the browser leaves first (L1).
      case "/slow.png": return new Response(new ReadableStream({
        start(controller) { controller.enqueue(PNG.subarray(0, 64)); slowTimer = setTimeout(() => { try { controller.close(); } catch { /* gone */ } }, 20_000); },
        cancel() { slowCancelled = true; clearTimeout(slowTimer); }
      }), { headers: { "Content-Type": "image/png" } });
      default: return new Response("missing", { status: 404 });
    }
  }
});
const IMAGE_PORT = imageHost.port!;
const fake = startFakeProvider(0);
const mcp = startFakeMcpServer(0);
let member: Session;
let admin: Session;
let reader: Session;
let stranger: Session;
let providerId: string;
let serverId: string;

const imageUrl = (path: string) => `http://127.0.0.1:${IMAGE_PORT}${path}`;
async function proxy(session: Session | null, url: string, headers: Record<string, string> = { "X-Nook-Image-Proxy": "1" }) {
  return fetch(`${origin}/api/agents/image-proxy?url=${encodeURIComponent(url)}`, { headers: { ...(session ? { Cookie: session.cookie } : {}), ...headers } });
}
const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;

beforeAll(async () => {
  member = await createUser("Images member");
  admin = await createUser("Images admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  reader = await createUser("Images reader");
  stranger = await createUser("Images stranger");
  const created = await api(admin, "POST", "/agents/admin/providers", { name: "Fake OpenAI (images)", baseUrl: fake.baseUrl, apiKey: "sk-test-fake-key-0009", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const server = await api(admin, "POST", "/agents/admin/servers", { name: "Fake Images", url: mcp.url, availability: "all", timeoutMs: 5000 });
  expect(server.status).toBe(201);
  serverId = server.body.server.id;
  expect((await api(admin, "POST", `/agents/admin/servers/${serverId}/sync`, {})).status).toBe(200);
  // The local picture host stands in for a public one (test-only setting; refused in production).
  config.agents.imageProxyTestHosts = ["127.0.0.1"];
});
afterAll(async () => {
  config.agents.imageProxyTestHosts = [];
  clearTimeout(slowTimer);
  deleteProvider(admin.userId, providerId);
  await resetToolServersForTests();
  imageHost.stop(true);
  fake.stop();
  mcp.stop();
});

describe("the image proxy (T304)", () => {
  test("loads a picture for a signed-in person: sniffed type, inline, the strict header set, and nothing of the session sent out", async () => {
    received.length = 0;
    const response = await proxy(member, `${imageUrl("/chart.png")}?q=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    const sent = received.at(-1)!;
    expect(sent.path).toBe("/chart.png");
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["user-agent"]).toMatch(/^Nook\//);
    // The type comes from the bytes, not from what the host said.
    const gif = await proxy(member, imageUrl("/pixel"));
    expect(gif.status).toBe(200);
    expect(gif.headers.get("content-type")).toBe("image/gif");
    expect(imageLoadsInFlight(member.userId)).toBe(0);
  });

  test("needs a session and its header; API keys, other sites, and guests never reach it", async () => {
    expect((await proxy(null, imageUrl("/chart.png"))).status).toBe(401);
    const key = makeKey(member, ["notes:read"]);
    expect((await proxy(null, imageUrl("/chart.png"), { "X-Nook-Image-Proxy": "1", Authorization: `Bearer ${key.token}` })).status).toBe(401);
    // An <img>, a link, or a form cannot send the header.
    const bare = await proxy(member, imageUrl("/chart.png"), {});
    expect(bare.status).toBe(400);
    expect((await proxy(member, imageUrl("/chart.png"), { "X-Nook-Image-Proxy": "1", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const guest = await createUser("Images guest");
    db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
    expect((await proxy(guest, imageUrl("/chart.png"))).status).toBe(404);
  });

  test("never uses AGENT_ALLOWED_PRIVATE_HOSTS: private hosts are refused even when listed there, and only https on 443 is fetched (M1, L2)", async () => {
    config.agents.imageProxyTestHosts = [];
    expect(config.agents.allowedPrivateHosts).toContain("127.0.0.1");
    received.length = 0;
    try {
      // Plain http, another port, or a private address: never fetched, whatever the admin allowed for providers.
      for (const url of [imageUrl("/chart.png"), `https://127.0.0.1:${IMAGE_PORT}/chart.png`, "https://images.example.test:8443/a.png", "http://images.example.test/a.png"]) {
        const refused = await proxy(member, url);
        expect({ url, status: refused.status, code: await codeOf(refused) }).toEqual({ url, status: 400, code: "URL_REFUSED" });
      }
      // https on 443 to a private or local address: the same 502 as any other failure, never a hint.
      for (const url of ["https://127.0.0.1/x.png", "https://[::1]/x.png", "https://10.0.0.1/x.png", "https://169.254.169.254/latest/meta-data/x.png"]) {
        const refused = await proxy(member, url);
        expect({ url, status: refused.status, code: await codeOf(refused) }).toEqual({ url, status: 502, code: "IMAGE_UNAVAILABLE" });
      }
      expect(received.length).toBe(0);
    } finally {
      config.agents.imageProxyTestHosts = ["127.0.0.1"];
    }
  });

  test("AGENT_IMAGE_PROXY_TEST_HOSTS is refused in production, and read otherwise", () => {
    const configPath = join(import.meta.dir, "..", "server", "config.ts");
    const load = (env: Record<string, string>) => {
      const result = Bun.spawnSync(["bun", "--no-env-file", "--eval", `const { config } = await import(${JSON.stringify(configPath)}); console.log(JSON.stringify(config.agents.imageProxyTestHosts));`], {
        cwd: tmpdir(), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATA_DIR: join(tmpdir(), "mynotes-config-test"), ...env }, stdout: "pipe", stderr: "pipe"
      });
      return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim().split("\n").at(-1) ?? "", stderr: result.stderr.toString() };
    };
    const production = load({ NODE_ENV: "production", COOKIE_SECURE: "true", AGENT_IMAGE_PROXY_TEST_HOSTS: "127.0.0.1" });
    expect(production.ok).toBe(false);
    expect(production.stderr).toContain("AGENT_IMAGE_PROXY_TEST_HOSTS is for tests only");
    expect(JSON.parse(load({ AGENT_IMAGE_PROXY_TEST_HOSTS: "127.0.0.1" }).stdout)).toEqual(["127.0.0.1"]);
    expect(JSON.parse(load({}).stdout)).toEqual([]);
  }, 30_000);

  test("refuses Nook itself, other schemes, credentials, long addresses, and SVG addresses before fetching", async () => {
    received.length = 0;
    expect((await proxy(member, `${origin}/api/files/x/content`)).status).toBe(400);
    expect((await proxy(member, "ftp://images.example.test/a.png")).status).toBe(400);
    expect((await proxy(member, "https://user:pass@images.example.test/a.png")).status).toBe(400);
    expect((await proxy(member, "javascript:alert(1)")).status).toBe(400);
    const svg = await proxy(member, imageUrl("/logo.svg"));
    expect(svg.status).toBe(415);
    expect((await proxy(member, `https://images.example.test/${"a".repeat(2100)}.png`)).status).toBe(400);
    expect(received.length).toBe(0);
  });

  test("every failure on the far side is the same 502 with the same words: not an image, SVG bytes, too large, a redirect (not followed), missing", async () => {
    received.length = 0;
    const bodies = new Set<string>();
    for (const path of ["/page.png", "/logo", "/big.png", "/stream-big.png", "/moved.png", "/nope.png"]) {
      const response = await proxy(member, imageUrl(path));
      expect({ path, status: response.status }).toEqual({ path, status: 502 });
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "That image could not be loaded", code: "IMAGE_UNAVAILABLE" })]);
    // The redirect was not followed.
    expect(received.filter((entry) => entry.path === "/chart.png").length).toBe(0);
    expect(imageLoadsInFlight(member.userId)).toBe(0);
  });

  test("a browser that leaves aborts the fetch and frees its slot (L1)", async () => {
    slowCancelled = false;
    const controller = new AbortController();
    const pending = fetch(`${origin}/api/agents/image-proxy?url=${encodeURIComponent(imageUrl("/slow.png"))}`, { headers: { Cookie: member.cookie, "X-Nook-Image-Proxy": "1" }, signal: controller.signal }).catch(() => null);
    const until = Date.now() + 3000;
    while (imageLoadsInFlight(member.userId) === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(imageLoadsInFlight(member.userId)).toBe(1);
    controller.abort();
    await pending;
    const freed = Date.now() + 5000;
    while ((imageLoadsInFlight(member.userId) > 0 || !slowCancelled) && Date.now() < freed) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(imageLoadsInFlight(member.userId)).toBe(0);
    expect(slowCancelled).toBe(true);
  });

  test("is rate-limited per person (a sliding minute), with Retry-After; others are unaffected", async () => {
    const busy = await createUser("Images busy");
    for (let index = 0; index < IMAGE_PROXY_LIMITS.perMinute; index += 1) expect(chargeImageLoad(busy.userId)).toBe(0);
    const limited = await proxy(busy, imageUrl("/chart.png"));
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await proxy(member, imageUrl("/chart.png"))).status).toBe(200);
  });
});

describe("tool images (MCP image content)", () => {
  type SseEvent = { type: string; data: Record<string, any> };
  async function sendAndWait(session: Session, chatId: string, content: string) {
    const started = await api(session, "POST", `/chats/${chatId}/messages`, { content });
    expect(started.status).toBe(201);
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/runs/${started.body.runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
    const events: SseEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
          if (frame.startsWith(":")) continue;
          const lines = Object.fromEntries(frame.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
          events.push({ type: lines.event!, data: JSON.parse(lines.data!) });
        }
        if (events.some((event) => event.type === "done" || event.type === "snapshot")) { controller.abort(); break; }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
    } finally {
      clearTimeout(timer);
    }
    return { messageId: started.body.assistantMessage.id as string, events };
  }
  const imageGet = (session: Session, chatId: string, imageId: string) => fetch(`${origin}/api/chats/${chatId}/tool-images/${imageId}`, { headers: { Cookie: session.cookie } });

  test("checks an image part by its bytes: real pictures kept (at most 4 a call), SVG and junk refused", () => {
    expect(toolImageOf(Buffer.from(PNG).toString("base64"))).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(toolImageOf(Buffer.from(GIF_1X1).toString("base64"))?.mimeType).toBe("image/gif");
    expect(toolImageOf(Buffer.from(SVG_IMAGE).toString("base64"))).toBeNull();
    expect(toolImageOf("AAAA")).toBeNull();
    expect(toolImageOf("not base64!")).toBeNull();
    expect(toolImageOf(Buffer.from(new Uint8Array(2 * 1024 * 1024 + 16).fill(0x89)).toString("base64"))).toBeNull();
  });

  test("a tool's picture is stored with the chat, shown to its readers, never sent to the model, and kept by a copy", async () => {
    const agent = await api(member, "POST", "/agents", { name: "Painter", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    expect(agent.status).toBe(201);
    const chat = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const { messageId, events } = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"png"}');
    const result = events.find((event) => event.type === "tool_result")!;
    expect(result.data.ok).toBe(true);
    expect(result.data.images).toHaveLength(1);
    const ref = result.data.images[0] as { id: string; mimeType: string; bytes: number };
    expect(ref.mimeType).toBe("image/png");
    // The model saw a line about the picture, never its bytes.
    const lastTurn = (fake.calls.filter((call) => call.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string | null }> }).messages.at(-1)!;
    expect(lastTurn.role).toBe("tool");
    expect(lastTurn.content).toContain("[image: image/png");
    expect(lastTurn.content).toContain("[The image was shown to the person.]");
    expect(lastTurn.content).not.toContain(Buffer.from(PNG).toString("base64").slice(0, 40));
    // The message keeps the reference; the route serves the bytes with the strict headers.
    const detail = await api(member, "GET", `/chats/${chat.id}`);
    const stored = (detail.body.messages as Array<{ id: string; toolCalls: Array<{ images?: unknown[] }> }>).find((message) => message.id === messageId)!;
    expect(stored.toolCalls[0]!.images).toEqual([ref]);
    const served = await imageGet(member, chat.id, ref.id);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(makePng(48, 32));
    // Someone the chat is not shared with gets 404, as for the chat itself; a reader it is shared with sees it.
    expect((await imageGet(stranger, chat.id, ref.id)).status).toBe(404);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(404);
    const access = await api(member, "GET", `/chats/${chat.id}/access`);
    const shared = await fetch(`${origin}/api/chats/${chat.id}/access`, { method: "PUT", headers: { Cookie: member.cookie, Origin: origin, "X-CSRF-Token": member.csrf, "Content-Type": "application/json", "If-Match": access.body.etag }, body: JSON.stringify({ audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }) });
    expect(shared.status).toBe(200);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(200);
    // A wrong pairing of chat and image is 404.
    const other = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    expect((await imageGet(member, other.id, ref.id)).status).toBe(404);
    // Continue as a copy: the copy's tool calls still show the picture, through a reference to the same
    // bytes (stored once) under the copy's own message id (M2, L4); the owner pays for it once.
    const sha = (db.query("SELECT sha256 FROM chat_tool_images WHERE chat_id = ? AND id = ?").get(chat.id, ref.id) as { sha256: string }).sha256;
    const before = storedBytes(member.userId);
    const fork = await api(member, "POST", `/chats/${chat.id}/fork`, { messageId });
    expect(fork.status).toBe(201);
    expect((await imageGet(member, fork.body.chat.id, ref.id)).status).toBe(200);
    expect(storedBytes(member.userId)).toBe(before);
    expect((db.query("SELECT COUNT(*) AS count FROM chat_image_blobs WHERE sha256 = ?").get(sha) as { count: number }).count).toBe(1);
    const copyRef = db.query("SELECT message_id FROM chat_tool_images WHERE chat_id = ? AND id = ?").get(fork.body.chat.id, ref.id) as { message_id: string };
    const copyAssistant = db.query("SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'assistant'").get(fork.body.chat.id) as { id: string };
    expect(copyRef.message_id).toBe(copyAssistant.id);
    // A copy by someone else counts against their own quota.
    const readerBefore = storedBytes(reader.userId);
    const readerFork = await api(reader, "POST", `/chats/${chat.id}/fork`, { messageId });
    expect(readerFork.status === 201 || readerFork.status === 403).toBe(true);
    if (readerFork.status === 201) expect(storedBytes(reader.userId)).toBe(readerBefore + ref.bytes);
    // Purge releases references; the bytes go with the last one.
    db.query("DELETE FROM chats WHERE id = ?").run(chat.id);
    expect((db.query("SELECT COUNT(*) AS count FROM chat_image_blobs WHERE sha256 = ?").get(sha) as { count: number }).count).toBe(1);
    db.query("DELETE FROM chats WHERE id = ?").run(fork.body.chat.id);
    if (readerFork.status === 201) db.query("DELETE FROM chats WHERE id = ?").run(readerFork.body.chat.id);
    expect((db.query("SELECT COUNT(*) AS count FROM chat_image_blobs WHERE sha256 = ?").get(sha) as { count: number }).count).toBe(0);
    expect(storedBytes(member.userId)).toBe(before - ref.bytes);
  });

  test("people a chat is shared with see tool images and continue only on the active branch (L3)", async () => {
    const agent = await api(member, "POST", "/agents", { name: "Painter 3", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    const chat = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const { messageId, events } = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"png"}');
    const ref = events.find((event) => event.type === "tool_result")!.data.images[0] as { id: string };
    const access = await api(member, "GET", `/chats/${chat.id}/access`);
    expect((await fetch(`${origin}/api/chats/${chat.id}/access`, { method: "PUT", headers: { Cookie: member.cookie, Origin: origin, "X-CSRF-Token": member.csrf, "Content-Type": "application/json", "If-Match": access.body.etag }, body: JSON.stringify({ audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }) })).status).toBe(200);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(200);
    // The owner switches to another branch (here: back to the question alone); the reply with the picture is off it.
    const question = db.query("SELECT parent_id FROM chat_messages WHERE id = ?").get(messageId) as { parent_id: string };
    db.query("UPDATE chats SET active_leaf_id = ? WHERE id = ?").run(question.parent_id, chat.id);
    expect((await imageGet(reader, chat.id, ref.id)).status).toBe(404);
    expect((await imageGet(member, chat.id, ref.id)).status).toBe(200);
    expect((await api(reader, "POST", `/chats/${chat.id}/fork`, { messageId })).status).toBe(404);
    const onPath = await api(reader, "POST", `/chats/${chat.id}/fork`, { messageId: question.parent_id });
    expect(onPath.status === 201 || onPath.status === 403).toBe(true);
  });

  test("nothing is kept past the owner's storage quota or the free-disk floor, and the model is told so (M2)", async () => {
    const agent = await api(stranger, "POST", "/agents", { name: "Painter 4", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    const chat = (await api(stranger, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const quota = config.userStorageQuotaBytes;
    const floor = config.minFreeDiskBytes;
    const lastTool = () => (fake.calls.filter((call) => call.path === "/v1/chat/completions").at(-1)!.body as { messages: Array<{ role: string; content: string | null }> }).messages.at(-1)!.content ?? "";
    try {
      config.userStorageQuotaBytes = storedBytes(stranger.userId) + 100;
      const full = await sendAndWait(stranger, chat.id, 'tool:fake-images__image:{"kind":"png"}');
      expect(full.events.find((event) => event.type === "tool_result")!.data.images).toBeUndefined();
      expect(lastTool()).toContain("[An image was not kept or shown: the chat owner's storage quota is full.]");
      config.userStorageQuotaBytes = quota;
      config.minFreeDiskBytes = Number.MAX_SAFE_INTEGER;
      const disk = await sendAndWait(stranger, chat.id, 'tool:fake-images__image:{"kind":"png"}');
      expect(disk.events.find((event) => event.type === "tool_result")!.data.images).toBeUndefined();
      expect(lastTool()).toContain("this Nook's disk is nearly full");
    } finally {
      config.userStorageQuotaBytes = quota;
      config.minFreeDiskBytes = floor;
    }
    expect((db.query("SELECT COUNT(*) AS count FROM chat_tool_images WHERE chat_id = ?").get(chat.id) as { count: number }).count).toBe(0);
  });

  test("an SVG part is refused and a call keeps at most 4 pictures", async () => {
    const agent = await api(member, "POST", "/agents", { name: "Painter 2", systemPrompt: "Draw.", providerId, tools: [{ source: "server", serverId, toolName: "image", policy: null }] });
    const chat = (await api(member, "POST", "/chats", { agentId: agent.body.agent.id })).body.chat as { id: string };
    const svg = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"svg"}');
    const svgResult = svg.events.find((event) => event.type === "tool_result")!;
    expect(svgResult.data.images).toBeUndefined();
    expect(svgResult.data.resultPreview).toContain("[image omitted]");
    const many = await sendAndWait(member, chat.id, 'tool:fake-images__image:{"kind":"many"}');
    const manyResult = many.events.find((event) => event.type === "tool_result")!;
    expect(manyResult.data.images).toHaveLength(4);
    expect(manyResult.data.resultPreview).toContain("[4 images were shown to the person.]");
    // A call keeps at most 4; the rest are placeholders the model sees.
    expect(manyResult.data.resultPreview.match(/\[image omitted\]/g)).toHaveLength(2);
    expect((db.query("SELECT COUNT(*) AS count FROM chat_tool_images WHERE chat_id = ?").get(chat.id) as { count: number }).count).toBe(4);
    // Six identical pictures: the bytes are stored once.
    expect((db.query("SELECT COUNT(DISTINCT sha256) AS count FROM chat_tool_images WHERE chat_id = ?").get(chat.id) as { count: number }).count).toBe(1);
  });
});
