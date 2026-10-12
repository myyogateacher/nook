import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createUser, db, origin, request, type Session } from "./support/harness";
import { FAKE_IMAGE_TOKENS, startFakeProvider, type ProviderCall } from "./support/fakeProvider";
import { makePng, GIF_1X1, SVG_IMAGE } from "./support/images";
import { upload } from "./support/attachments";
import { retireUsersAfterFile } from "./support/retireUsers";

const { chatImageLimits } = await import("../server/agents/chatImages");
const { CHAT_IMAGE_BOUNDS } = await import("../shared/agents");

/**
 * Chat composer images (uploads everywhere U5; operator decision Q10): the admin's vision flag on a
 * provider, refusals (a model not marked, a file that is not an image, more than five, too large,
 * someone else's file, a Files item without the confirm), the request the provider receives
 * (`image_url` parts with base64 data URLs, newest first within the request cap), usage, the audit
 * (ids and counts only), who can open the images (the owner; people the chat is shared with, on the
 * branch they see; never guests or the public page), Continue as a copy, API runs, and the Bin.
 */

retireUsersAfterFile();
const fake = startFakeProvider(0, { models: ["gpt-6-luna", "gpt-6-vision", "text-embedding-3-small"] });
let admin: Session;
let owner: Session;
let reader: Session;
let stranger: Session;
let guest: Session;
let providerId: string;
let agentId: string;

type Reply = { status: number; body: Record<string, any> };
async function send(session: Session, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await request(path, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}
async function share(session: Session, chatId: string, body: Record<string, unknown>) {
  const current = await send(session, "GET", `/chats/${chatId}/access`);
  expect(current.status).toBe(200);
  const written = await send(session, "PUT", `/chats/${chatId}/access`, { people: [], groups: [], ...body }, { "If-Match": current.body.etag });
  expect([written.status, written.body.code]).toEqual([200, undefined]);
}
async function finish(session: Session, runId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${origin}/api/runs/${runId}/events?after=0`, { headers: { Cookie: session.cookie, Origin: origin }, signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/event: (done|snapshot)/.test(text)) { controller.abort(); break; }
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "";
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const completions = () => fake.calls.filter((call) => call.path === "/v1/chat/completions");
const lastCompletion = (): ProviderCall => completions().at(-1)!;
const setVision = async (vision: Record<string, unknown>) => {
  const current = await send(admin, "GET", `/agents/admin/providers/${providerId}`);
  const patched = await send(admin, "PATCH", `/agents/admin/providers/${providerId}`, { vision, expectedRevision: current.body.provider.revision });
  expect(patched.status).toBe(200);
  return patched.body.provider as { vision: { enabled: boolean; models: string[] | null } };
};
async function newChat(session: Session = owner) {
  const created = await send(session, "POST", "/chats", { agentId });
  expect(created.status).toBe(201);
  return created.body.chat.id as string;
}
const png = (width = 32, height = 20, hue: [number, number, number] = [200, 40, 40]) => makePng(width, height, hue, [10, 10, 10]);
async function image(session: Session = owner, bytes: Uint8Array = png(), name = "shot.png") {
  const result = await upload(session, name, bytes, { attachTo: "chat_message" });
  expect(result.status).toBe(201);
  return result.id;
}
async function sendWith(session: Session, chatId: string, content: string, attachments: Array<{ documentId: string; confirmed?: boolean }>, parentId?: string | null) {
  return send(session, "POST", `/chats/${chatId}/messages`, { content, attachments, ...(parentId !== undefined ? { parentId } : {}) });
}
const contentStatus = async (session: Session | null, documentId: string) => session ? (await request(`/files/${documentId}/content`, {}, session)).status : (await fetch(`${origin}/api/files/${documentId}/content`)).status;
const linksOf = (messageId: string) => (db.query("SELECT document_id FROM attachment_links WHERE host_kind = 'chat_message' AND host_id = ? ORDER BY position").all(messageId) as Array<{ document_id: string }>).map((row) => row.document_id);
const auditRows = (action: string, since: number) => db.query("SELECT metadata_json AS details_json FROM audit_log WHERE event_type = ? AND rowid > ? ORDER BY rowid").all(action, since) as Array<{ details_json: string }>;
const auditMark = () => (db.query("SELECT COALESCE(MAX(rowid), 0) AS id FROM audit_log").get() as { id: number }).id;

beforeAll(async () => {
  admin = await createUser("U5 admin");
  db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.userId);
  owner = await createUser("U5 owner");
  reader = await createUser("U5 reader");
  stranger = await createUser("U5 stranger");
  guest = await createUser("U5 guest");
  db.query("UPDATE users SET role = 'guest' WHERE id = ?").run(guest.userId);
  const created = await send(admin, "POST", "/agents/admin/providers", { name: "Fake vision", baseUrl: fake.baseUrl, apiKey: "sk-test-u5-0001", defaultModel: "gpt-6-luna" });
  expect(created.status).toBe(201);
  providerId = created.body.provider.id;
  const agent = await send(owner, "POST", "/agents", { name: "Looker", systemPrompt: "Describe images.", providerId, model: "gpt-6-vision" });
  expect(agent.status).toBe(201);
  agentId = agent.body.agent.id;
});
afterAll(async () => {
  // One server serves every test file: leave no provider (others expect to be the default) and the public-links policy off.
  const settings = await send(admin, "GET", "/agents/admin/settings");
  if (settings.body.settings?.publicChatLinks) await send(admin, "PUT", "/agents/admin/settings", { publicChatLinks: false, expectedRevision: settings.body.settings.revision });
  const { deleteProvider } = await import("../server/agents/providers");
  deleteProvider(admin.userId, providerId);
  fake.stop();
});
afterEach(() => {
  chatImageLimits.bytes = CHAT_IMAGE_BOUNDS.bytes;
  chatImageLimits.requestBytes = CHAT_IMAGE_BOUNDS.requestBytes;
});

describe("the vision flag (Settings → AI, Q10)", () => {
  test("off by default; every model, or a list; stored on compat_json without a migration, audited, admins only", async () => {
    const fresh = await send(admin, "GET", `/agents/admin/providers/${providerId}`);
    expect(fresh.body.provider.vision).toEqual({ enabled: false, models: null });
    expect((await send(owner, "GET", "/agents")).body.agents.find((agent: { id: string }) => agent.id === agentId).vision).toBe(false);
    const mark = auditMark();
    expect((await setVision({ enabled: true, models: ["gpt-6-luna"] })).vision).toEqual({ enabled: true, models: ["gpt-6-luna"] });
    // The agent runs gpt-6-vision, which is not listed.
    expect((await send(owner, "GET", "/agents")).body.agents.find((agent: { id: string }) => agent.id === agentId).vision).toBe(false);
    expect((await setVision({ models: ["gpt-6-luna", "gpt-6-vision"] })).vision.models).toEqual(["gpt-6-luna", "gpt-6-vision"]);
    expect((await send(owner, "GET", "/agents")).body.agents.find((agent: { id: string }) => agent.id === agentId).vision).toBe(true);
    expect((await setVision({ models: null })).vision).toEqual({ enabled: true, models: null });
    const stored = JSON.parse((db.query("SELECT compat_json FROM agent_providers WHERE id = ?").get(providerId) as { compat_json: string }).compat_json);
    expect(stored.vision).toEqual({ enabled: true, models: null });
    expect(stored.tokenParam).toBe("max_completion_tokens");
    const audits = auditRows("agents.provider.update", mark).map((row) => JSON.parse(row.details_json));
    expect(audits.at(-1)).toMatchObject({ providerId, visionPolicy: { enabled: true, models: null } });
    // Bad input is refused; members never reach the admin route.
    const current = await send(admin, "GET", `/agents/admin/providers/${providerId}`);
    for (const bad of [{ models: [] }, { models: ["has space"] }, { models: ["a", "a"] }, { enabled: "yes" }, { extra: true }]) {
      expect((await send(admin, "PATCH", `/agents/admin/providers/${providerId}`, { vision: bad, expectedRevision: current.body.provider.revision })).status).toBe(400);
    }
    expect((await send(owner, "PATCH", `/agents/admin/providers/${providerId}`, { vision: { enabled: false }, expectedRevision: current.body.provider.revision })).status).toBe(404);
    // A malformed stored value reads as off (no image leaves for a model nobody marked).
    const { parseVisionPolicy } = await import("../server/agents/providers");
    expect(parseVisionPolicy("{\"vision\":{\"enabled\":\"true\"}}")).toEqual({ enabled: false, models: null });
    expect(parseVisionPolicy("{\"vision\":{\"enabled\":true,\"models\":[\"\"]}}")).toEqual({ enabled: false, models: null });
    expect(parseVisionPolicy("not json")).toEqual({ enabled: false, models: null });
  });
});

describe("sending images", () => {
  test("a model that is not vision-capable is refused before anything is stored or sent", async () => {
    await setVision({ enabled: false });
    const chatId = await newChat();
    const documentId = await image();
    const before = completions().length;
    const refused = await sendWith(owner, chatId, "What is this?", [{ documentId }]);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("VISION_REQUIRED");
    expect(refused.body.error).toContain("Settings → AI");
    expect((db.query("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?").get(chatId) as { count: number }).count).toBe(0);
    expect(completions().length).toBe(before);
    // Text alone still works.
    const plain = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "Hello" });
    expect(plain.status).toBe(201);
    await finish(owner, plain.body.runId);
    expect(lastCompletion().images).toEqual([]);
  });

  test("non-images, too many, too large, someone else's file, and a Files item without the confirm are refused", async () => {
    await setVision({ enabled: true, models: null });
    const chatId = await newChat();
    const text = (await upload(owner, "notes.txt", "plain text", { attachTo: "chat_message" })).id;
    const pdf = (await upload(owner, "doc.pdf", "%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF", { attachTo: "chat_message" })).id;
    const svg = (await upload(owner, "x.svg", SVG_IMAGE, { attachTo: "chat_message" })).id;
    for (const documentId of [text, pdf, svg]) {
      const refused = await sendWith(owner, chatId, "Read this", [{ documentId }]);
      expect(refused.status).toBe(415);
      expect(refused.body.code).toBe("NOT_AN_IMAGE");
    }
    const six: string[] = [];
    for (let index = 0; index < 6; index += 1) six.push(await image(owner, png(8 + index, 8)));
    const many = await sendWith(owner, chatId, "Six", six.map((documentId) => ({ documentId })));
    expect(many.status).toBe(400);
    expect(many.body.code).toBe("TOO_MANY_ATTACHMENTS");
    chatImageLimits.bytes = 100;
    const large = await sendWith(owner, chatId, "Big", [{ documentId: six[0]! }]);
    expect(large.status).toBe(413);
    expect(large.body.code).toBe("IMAGE_TOO_LARGE");
    chatImageLimits.bytes = CHAT_IMAGE_BOUNDS.bytes;
    const theirs = await image(stranger);
    expect((await sendWith(owner, chatId, "Theirs", [{ documentId: theirs }])).status).toBe(404);
    // A picture from Files (outside Attachments) needs the confirm, as on every host (D396).
    const filesItem = (await upload(owner, "holiday.png", png(12, 12))).id;
    const unconfirmed = await sendWith(owner, chatId, "From Files", [{ documentId: filesItem }]);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe("CONFIRM_REQUIRED");
    // Nothing was written by any refusal.
    expect((db.query("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?").get(chatId) as { count: number }).count).toBe(0);
    const confirmed = await sendWith(owner, chatId, "From Files", [{ documentId: filesItem, confirmed: true }]);
    expect(confirmed.status).toBe(201);
    await finish(owner, confirmed.body.runId);
    expect(linksOf(confirmed.body.userMessage.id)).toEqual([filesItem]);
    // An empty message with nothing attached is still refused.
    expect((await send(owner, "POST", `/chats/${chatId}/messages`, { content: "  " })).status).toBe(400);
  });

  test("the provider receives the text and one image_url part per image (base64 data URLs); usage and the audit hold ids and counts", async () => {
    await setVision({ enabled: true, models: ["gpt-6-vision"] });
    const chatId = await newChat();
    const first = png(40, 30, [250, 10, 10]);
    const second = GIF_1X1;
    const ids = [await image(owner, first, "red.png"), await image(owner, second, "dot.gif")];
    const mark = auditMark();
    const before = (db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens FROM agent_usage_daily WHERE user_id = ?").get(owner.userId) as { tokens: number }).tokens;
    const started = await sendWith(owner, chatId, "echo:two pictures", ids.map((documentId) => ({ documentId })));
    expect(started.status).toBe(201);
    expect(started.body.userMessage.attachments).toEqual([
      { documentId: ids[0], removed: false, name: "red.png", mimeType: "image/png", sizeBytes: first.byteLength },
      { documentId: ids[1], removed: false, name: "dot.gif", mimeType: "image/gif", sizeBytes: second.byteLength }
    ]);
    await finish(owner, started.body.runId);
    const call = lastCompletion();
    const messages = (call.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const user = messages.at(-1)!;
    expect(user.role).toBe("user");
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: "text", text: "echo:two pictures" });
    expect(parts.slice(1).map((part) => part.type)).toEqual(["image_url", "image_url"]);
    expect(parts[1]!.image_url!.url).toBe(`data:image/png;base64,${Buffer.from(first).toString("base64")}`);
    expect(call.images.map((part) => [part.mimeType, part.bytes, part.dataUrl])).toEqual([["image/png", first.byteLength, true], ["image/gif", second.byteLength, true]]);
    // The system turn stays a string; the reply streamed as usual.
    expect(typeof messages[0]!.content).toBe("string");
    const detail = await send(owner, "GET", `/chats/${chatId}`);
    expect(detail.body.messages.find((message: { role: string }) => message.role === "assistant").content).toBe("two pictures");
    // Usage: the provider's report, image tokens included.
    const after = (db.query("SELECT COALESCE(SUM(prompt_tokens), 0) AS tokens FROM agent_usage_daily WHERE user_id = ?").get(owner.userId) as { tokens: number }).tokens;
    expect(after - before).toBeGreaterThanOrEqual(2 * FAKE_IMAGE_TOKENS);
    // The audit: ids and counts, never bytes or names.
    const start = auditRows("agents.run.start", mark).map((row) => JSON.parse(row.details_json)).at(-1);
    expect(start).toMatchObject({ chatId, userMessageId: started.body.userMessage.id, images: 2 });
    const done = auditRows("agents.run.finish", mark).map((row) => JSON.parse(row.details_json)).at(-1);
    expect(done).toMatchObject({ chatId, imagesSent: 2, imagesOmitted: 0 });
    const allDetails = (db.query("SELECT COALESCE(metadata_json, '') AS details_json FROM audit_log WHERE rowid > ?").all(mark) as Array<{ details_json: string }>).map((row) => row.details_json).join("\n");
    expect(allDetails).not.toContain("base64");
    expect(allDetails).not.toContain("red.png");
    expect(auditRows("attachment.link", mark).length).toBe(2);
  });

  test("an image-only message is sent and titles the chat; the request cap keeps the newest images and tells the model about the rest", async () => {
    await setVision({ enabled: true, models: null });
    const chatId = await newChat();
    const older = png(64, 64, [10, 200, 10]);
    const newer = png(60, 60, [10, 10, 200]);
    const first = await sendWith(owner, chatId, "", [{ documentId: await image(owner, older) }]);
    expect(first.status).toBe(201);
    await finish(owner, first.body.runId);
    expect((await send(owner, "GET", `/chats/${chatId}`)).body.chat.title).toBe("Image");
    expect(lastCompletion().images.length).toBe(1);
    // Room for one image: the newest goes, the older one becomes a note.
    chatImageLimits.requestBytes = Math.max(older.byteLength, newer.byteLength) + 10;
    const second = await sendWith(owner, chatId, "echo:and this one", [{ documentId: await image(owner, newer) }]);
    expect(second.status).toBe(201);
    await finish(owner, second.body.runId);
    const call = lastCompletion();
    expect(call.images.map((part) => part.bytes)).toEqual([newer.byteLength]);
    const turns = (call.body as { messages: Array<{ role: string; content: unknown }> }).messages.filter((turn) => turn.role === "user");
    expect(turns[0]!.content).toBe("[1 earlier image was left out to keep the request small.]");
  });

  test("a model that loses the mark gets a note instead of the images on Regenerate", async () => {
    await setVision({ enabled: true, models: null });
    const chatId = await newChat();
    const started = await sendWith(owner, chatId, "echo:look", [{ documentId: await image() }]);
    await finish(owner, started.body.runId);
    await setVision({ enabled: false });
    const again = await send(owner, "POST", `/chats/${chatId}/messages/${started.body.assistantMessage.id}/regenerate`, {});
    expect(again.status).toBe(201);
    await finish(owner, again.body.runId);
    const call = lastCompletion();
    expect(call.images).toEqual([]);
    const user = (call.body as { messages: Array<{ role: string; content: unknown }> }).messages.at(-1)!;
    expect(user.content).toBe("echo:look\n[The person attached 1 image here; this model cannot see images, so it was not sent.]");
  });
});

describe("who can open the images", () => {
  test("the owner and readers on the active branch; never off-branch, strangers, guests, the public page, or after the Bin", async () => {
    await setVision({ enabled: true, models: null });
    const chatId = await newChat();
    const pictured = await image(owner, png(20, 20, [1, 2, 3]), "branch-a.png");
    const first = await sendWith(owner, chatId, "echo:branch a", [{ documentId: pictured }]);
    await finish(owner, first.body.runId);
    expect(await contentStatus(reader, pictured)).toBe(404);
    await share(owner, chatId, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
    expect(await contentStatus(owner, pictured)).toBe(200);
    expect(await contentStatus(reader, pictured)).toBe(200);
    expect(await contentStatus(stranger, pictured)).toBe(404);
    expect(await contentStatus(guest, pictured)).toBe(404);
    expect(await contentStatus(null, pictured)).not.toBe(200);
    // Everyone signed in: people, never guests (they cannot be shared with at all).
    await share(owner, chatId, { audience: "all_users" });
    expect(await contentStatus(stranger, pictured)).toBe(200);
    expect(await contentStatus(guest, pictured)).toBe(404);
    await share(owner, chatId, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
    const seen = await send(reader, "GET", `/chats/${chatId}`);
    expect(seen.body.messages.find((message: { role: string }) => message.role === "user").attachments).toEqual([{ documentId: pictured, removed: false, name: "branch-a.png", mimeType: "image/png", sizeBytes: expect.any(Number) }]);
    // The owner edits the first message without images: the pictured turn leaves the branch on screen.
    const edited = await send(owner, "POST", `/chats/${chatId}/messages`, { content: "echo:branch b", parentId: null });
    expect(edited.status).toBe(201);
    await finish(owner, edited.body.runId);
    expect(await contentStatus(reader, pictured)).toBe(404);
    expect(await contentStatus(owner, pictured)).toBe(200);
    expect(JSON.stringify((await send(reader, "GET", `/chats/${chatId}`)).body)).not.toContain(pictured);
    // The public page carries no attachment: no id, no content route.
    const settings = await send(admin, "GET", "/agents/admin/settings");
    expect((await send(admin, "PUT", "/agents/admin/settings", { publicChatLinks: true, expectedRevision: settings.body.settings.revision })).status).toBe(200);
    const back = await send(owner, "GET", `/chats/${chatId}`);
    expect((await send(owner, "PATCH", `/chats/${chatId}`, { activeLeafId: first.body.assistantMessage.id, expectedRevision: back.body.chat.revision })).status).toBe(200);
    expect(await contentStatus(reader, pictured)).toBe(200);
    const link = await send(owner, "PUT", `/chats/${chatId}/public`, { includeToolResults: true });
    expect(link.status).toBe(200);
    const token = new URL(link.body.url).pathname.split("/").at(-1)!;
    const snapshot = await (await fetch(`${origin}/api/public/chat-shares/${token}`)).text();
    expect(snapshot).toContain("branch a");
    expect(snapshot).not.toContain(pictured);
    expect(snapshot).not.toContain("/api/files/");
    expect(snapshot).not.toContain("branch-a.png");
    // The chat in the Bin: readers lose the image; the owner keeps the file in Files.
    expect((await send(owner, "DELETE", `/chats/${chatId}`, {})).status).toBe(200);
    expect(await contentStatus(reader, pictured)).toBe(404);
    expect(await contentStatus(owner, pictured)).toBe(200);
    // Purged: the links go with the messages (046's trigger); the upload, now unlinked, goes to its owner's Bin with the hourly sweep.
    expect(linksOf(first.body.userMessage.id)).toEqual([pictured]);
    expect((await send(owner, "DELETE", `/bin/chat/${chatId}`)).status).toBe(200);
    expect(linksOf(first.body.userMessage.id)).toEqual([]);
    expect((db.query("SELECT COUNT(*) AS count FROM attachment_links WHERE host_kind = 'chat_message' AND document_id = ?").get(pictured) as { count: number }).count).toBe(0);
  });

  test("Continue as a copy keeps the owner's images and leaves them behind for someone else's copy", async () => {
    await setVision({ enabled: true, models: null });
    // The reader can use the agent too (D361), so they can continue the chat.
    const agentAccess = await send(owner, "GET", `/agents/${agentId}/access`);
    expect((await send(owner, "PUT", `/agents/${agentId}/access`, { audience: "selected", people: [{ id: reader.userId, level: "view" }], groups: [] }, { "If-Match": agentAccess.body.etag })).status).toBe(200);
    const chatId = await newChat();
    const pictured = await image(owner, png(18, 18), "copy.png");
    const started = await sendWith(owner, chatId, "echo:copy me", [{ documentId: pictured }]);
    await finish(owner, started.body.runId);
    const own = await send(owner, "POST", `/chats/${chatId}/fork`, { messageId: started.body.assistantMessage.id });
    expect(own.status).toBe(201);
    const ownCopy = await send(owner, "GET", `/chats/${own.body.chat.id}`);
    expect(ownCopy.body.messages.find((message: { role: string }) => message.role === "user").attachments).toEqual([expect.objectContaining({ documentId: pictured, removed: false })]);
    await share(owner, chatId, { audience: "selected", people: [{ id: reader.userId, level: "view" }] });
    const mark = auditMark();
    const theirs = await send(reader, "POST", `/chats/${chatId}/fork`, { messageId: started.body.assistantMessage.id });
    expect(theirs.status).toBe(201);
    const theirCopy = await send(reader, "GET", `/chats/${theirs.body.chat.id}`);
    expect(theirCopy.body.messages.find((message: { role: string }) => message.role === "user").attachments).toBeUndefined();
    expect(auditRows("agents.chat.fork", mark).map((row) => JSON.parse(row.details_json)).at(-1)).toMatchObject({ shared: true, images: 0, imagesLeftBehind: 1 });
    // Unshared: the reader's copy never reached the owner's file.
    await share(owner, chatId, { audience: "private" });
    expect(await contentStatus(reader, pictured)).toBe(404);
  });

  test("an edit sends the edited message's images again; API runs refuse attachments", async () => {
    await setVision({ enabled: true, models: null });
    const chatId = await newChat();
    const pictured = await image();
    const started = await sendWith(owner, chatId, "echo:first", [{ documentId: pictured }]);
    await finish(owner, started.body.runId);
    const edit = await sendWith(owner, chatId, "echo:edited", [{ documentId: pictured, confirmed: true }], null);
    expect(edit.status).toBe(201);
    await finish(owner, edit.body.runId);
    expect(linksOf(edit.body.userMessage.id)).toEqual([pictured]);
    expect(lastCompletion().images.length).toBe(1);
    // /api/v1/agents/:id/runs takes text only for now (the strict body refuses `attachments`).
    const { createApiKey } = await import("../server/apiKeys");
    const key = createApiKey(owner.userId, { name: "U5 runs", surfaces: "rest", grants: [{ module: "agents", permission: "run", resourceKind: "agent", resourceId: agentId }], expiresInDays: 30 });
    const runs = (body: unknown) => fetch(`${origin}/api/v1/agents/${agentId}/runs`, { method: "POST", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const refused = await runs({ input: "echo:hi", attachments: [{ documentId: pictured }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(fake.calls.at(-1)?.body ?? {})).not.toContain("attachments");
    // The same body without them runs (the key is good).
    expect((await runs({ input: "echo:hi" })).status).toBe(200);
  });
});
