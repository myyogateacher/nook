import { beforeEach, describe, expect, test } from "bun:test";
import { createUser, db, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Whiteboard MCP tools (Wave 23, whiteboard plan §9, D205, T170): list and read with
 * `whiteboards:read`, create an empty board with `whiteboards:write`, nothing destructive, and
 * chosen-board keys (Wave 31 D281) that never see another board's name.
 */

beforeEach(() => resetMcpLimits());

type Json = Record<string, any>;
async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Json };
}
const docRow = (id: string) => db.query("SELECT * FROM documents WHERE id = ?").get(id) as Json | null;

async function create(owner: Session, name: string) {
  const result = await api(owner, "POST", "/whiteboards", { name });
  expect(result.status).toBe(201);
  return result.body.whiteboard as Json;
}

let seq = 0;
function sceneWith(texts: string[]) {
  const elements = texts.map((text) => {
    seq += 1;
    return { id: `m${seq}`, type: "text", x: 0, y: 0, width: 10, height: 10, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", text, originalText: text, fontSize: 20, fontFamily: 5, containerId: null };
  });
  return { type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} };
}
const save = (owner: Session, id: string, baseRevision: number, scene: unknown) => api(owner, "PUT", `/whiteboards/${id}/scene`, { baseRevision, scene });

describe("whiteboards MCP", () => {
  const all = (module: Grant["module"], permission: Grant["permission"]): Grant => ({ module, permission, resourceKind: null, resourceId: null });
  const on = (permission: Grant["permission"], id: string): Grant => ({ module: "whiteboards", permission, resourceKind: "whiteboard", resourceId: id });
  const key = (session: Session, grants: Grant[]) => createApiKey(session.userId, { name: "Agent", surfaces: "mcp", grants, expiresInDays: 90 }).id;
  async function call(keyId: string, name: string, args: Json = {}) {
    const result = await invokeMcpToolForTests(name, args, keyId);
    return { isError: result.isError === true, text: result.content[0]!.text, value: JSON.parse(result.content[0]!.text) as Json };
  }
  const visible = (keyId: string) => mcpToolSpecs.filter((spec) => toolVisible(spec, loadLiveKey(keyId)!)).map((spec) => spec.name).filter((name) => name.includes("whiteboard")).sort();

  test("scopes: read lists and reads, write implies read and only creates; no destructive tools exist", async () => {
    const owner = await createUser("WB mcp owner");
    const board = await create(owner, "Retro");
    await save(owner, board.id, 1, sceneWith(["Went well: shipping"]));
    const reader = key(owner, [all("whiteboards", "read")]);
    const writer = key(owner, [all("whiteboards", "write")]);
    const notes = key(owner, [all("notes", "read")]);
    expect(visible(reader)).toEqual(["list_whiteboards", "read_whiteboard"]);
    expect(visible(writer)).toEqual(["create_whiteboard", "list_whiteboards", "read_whiteboard"]);
    expect(visible(notes)).toEqual([]);
    expect(mcpToolSpecs.filter((spec) => spec.name.includes("whiteboard")).map((spec) => spec.name).sort()).toEqual(["create_whiteboard", "list_whiteboards", "read_whiteboard"]);
    expect((await call(notes, "list_whiteboards")).value.code).toBe("SCOPE_REQUIRED");
    expect((await call(reader, "create_whiteboard", { name: "No" })).value.code).toBe("SCOPE_REQUIRED");

    const listed = await call(reader, "list_whiteboards");
    expect(listed.value.whiteboards[0]).toMatchObject({ id: board.id, name: "Retro", revision: 2, elementCount: 1 });
    expect(listed.value.whiteboards[0].url).toEndWith(`/whiteboards/${board.id}`);
    const searched = await call(reader, "list_whiteboards", { query: "shipping" });
    expect(searched.value.whiteboards.map((item: Json) => item.id)).toEqual([board.id]);
    const read = await call(reader, "read_whiteboard", { id: board.id });
    expect(read.value).toMatchObject({ id: board.id, name: "Retro", revision: 2, texts: [{ text: "Went well: shipping" }], truncated: false });
    expect(read.value.elements).toBeUndefined();
    const withElements = await call(reader, "read_whiteboard", { id: board.id, include: "elements" });
    expect(withElements.value.elements[0]).toMatchObject({ type: "text", text: "Went well: shipping" });
    expect(withElements.value.elements[0].points).toBeUndefined();
    expect((await call(reader, "read_whiteboard", { id: crypto.randomUUID() })).value.code).toBe("NOT_FOUND");

    const created = await call(writer, "create_whiteboard", { name: "Agent board" });
    expect(created.isError).toBe(false);
    const createdRow = docRow(created.value.id)!;
    expect(createdRow).toMatchObject({ name: "Agent board.excalidraw", visibility: "private", sharing_override: 0 });
    const defaultFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(owner.userId) as { id: string }).id;
    expect(createdRow.folder_id).toBe(defaultFolder);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'mcp.whiteboard_create' AND metadata_json LIKE ?").get(`%${writer}%`)).toEqual({ n: 1 });
    const other = await createUser("WB mcp other");
    const foreignFolder = (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(other.userId) as { id: string }).id;
    expect((await call(writer, "create_whiteboard", { name: "Elsewhere", folderId: foreignFolder })).value.code).toBe("NOT_FOUND");
  });

  test("read_whiteboard output is bounded to 256 KiB and says when it was truncated", async () => {
    const owner = await createUser("WB mcp bounds");
    const board = await create(owner, "Wall of text");
    expect((await save(owner, board.id, 1, sceneWith(Array.from({ length: 25 }, (_, index) => `${index} ${"w".repeat(19_990)}`)))).status).toBe(200);
    const reader = key(owner, [all("whiteboards", "read")]);
    const read = await call(reader, "read_whiteboard", { id: board.id, include: "elements" });
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(256 * 1024 + 4096);
    expect(read.value.truncated).toBe(true);
  });

  test("viewers get read only, guests nothing; a chosen-board key sees only its boards and never another board's name", async () => {
    const owner = await createUser("WB mcp chooser");
    const chosen = await create(owner, "Chosen board");
    const secret = await create(owner, "Secret board Whiskey");
    await save(owner, secret.id, 1, sceneWith(["Whiskey text"]));
    const selector = key(owner, [on("read", chosen.id)]);
    expect(visible(selector)).toEqual(["list_whiteboards", "read_whiteboard"]);
    const listed = await call(selector, "list_whiteboards");
    expect(listed.value.whiteboards.map((item: Json) => item.id)).toEqual([chosen.id]);
    expect(listed.text).not.toContain("Whiskey");
    expect((await call(selector, "list_whiteboards", { query: "whiskey" })).text).not.toContain("Whiskey");
    expect((await call(selector, "read_whiteboard", { id: secret.id })).value.code).toBe("NOT_FOUND");
    expect((await call(selector, "read_whiteboard", { id: chosen.id })).isError).toBe(false);

    const { mcpScopesForRole } = await import("../server/team/roles");
    expect(mcpScopesForRole("viewer").filter((scope) => scope.startsWith("whiteboards"))).toEqual(["whiteboards:read"]);
    expect(mcpScopesForRole("guest")).toEqual([]);
    // A member's write key held by someone who becomes a viewer loses create at once (effective scopes, T81).
    const demoted = await createUser("WB mcp demoted");
    const demotedKey = key(demoted, [all("whiteboards", "write")]);
    expect(visible(demotedKey)).toEqual(["create_whiteboard", "list_whiteboards", "read_whiteboard"]);
    db.query("UPDATE users SET role = 'viewer' WHERE id = ?").run(demoted.userId);
    expect(visible(demotedKey)).toEqual(["list_whiteboards", "read_whiteboard"]);
    expect((await call(demotedKey, "create_whiteboard", { name: "No" })).value.code).toBe("SCOPE_REQUIRED");
  });
});
