import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createUser, origin, request, type Session } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests } = await import("../server/mcpTools");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
const { GrantBuilder } = await import("../src/keys/GrantBuilder");
const { keyEventLine } = await import("../src/keys/keyGrants");
type GrantRow = import("../src/keys/keyGrants").GrantRow;

/**
 * Wave 34 verification: narrowing "all" to chosen items in Edit (N1), the owner's key activity with
 * the shortened address (Q1), coded upload refusals (U1), and argument names on create_folder's own
 * validation (U2).
 */

beforeEach(() => resetMcpLimits());

async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function board(owner: Session, name: string) {
  return (await api(owner, "POST", "/tasks/boards", { name })).body.board.id as string;
}

describe("N1: Edit narrows all → chosen, and chosen only to a subset", () => {
  test("PATCH from all to a chosen set is allowed; a chosen set may shrink but not change or grow", async () => {
    const owner = await createUser("N1 owner");
    const [a, b, c] = [await board(owner, "N1 A"), await board(owner, "N1 B"), await board(owner, "N1 C")];
    const created = await api(owner, "POST", "/keys", { name: "Narrow", surfaces: "mcp", password: owner.password, grants: [{ module: "tasks", permission: "read" }] });
    const id = created.body.key.id as string;
    const chosen = (ids: string[]) => ({ grants: [{ module: "tasks", permission: "read", resources: ids.map((value) => ({ kind: "board", id: value })) }] });
    const toTwo = await api(owner, "PATCH", `/keys/${id}`, chosen([a, b]));
    expect(toTwo.status).toBe(200);
    expect(toTwo.body.changed).toEqual(["grants"]);
    expect((await api(owner, "PATCH", `/keys/${id}`, chosen([a]))).status).toBe(200);
    expect((await api(owner, "PATCH", `/keys/${id}`, chosen([c]))).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await api(owner, "PATCH", `/keys/${id}`, chosen([a, b]))).body.code).toBe("WIDENING_NOT_ALLOWED");
    expect((await api(owner, "PATCH", `/keys/${id}`, { grants: [{ module: "tasks", permission: "read" }] })).body.code).toBe("WIDENING_NOT_ALLOWED");
  });

  test("the builder offers the picker to narrow an 'all' grant, and only removable chips for a chosen one", () => {
    const policy = { keyMaxDays: 365, keyDefaultDays: 90, keyRequireExpiry: false, keysPerUser: 10, modules: ["tasks" as const], mcpAllowed: true, restAllowed: true };
    const row = (patch: Partial<GrantRow>): GrantRow => ({ key: "r1", module: "tasks", permission: "read", applies: "all", resourceIds: [], ...patch });
    const fromAll = renderToStaticMarkup(<GrantBuilder rows={[row({ applies: "chosen" })]} onChange={() => undefined} role="member" policy={policy} ceiling={[row({})]} />);
    expect(fromAll).toContain("Choose boards and views…");
    expect(fromAll).not.toContain("Items can only be removed here");
    const fromChosen = renderToStaticMarkup(<GrantBuilder rows={[row({ applies: "chosen", resourceIds: ["board:b1", "board:b2"] })]} onChange={() => undefined} role="member" policy={policy} ceiling={[row({ applies: "chosen", resourceIds: ["board:b1", "board:b2"] })]} />);
    expect(fromChosen).toContain("Items can only be removed here; rotate the key to add.");
    expect(fromChosen).not.toContain("ui-combobox-input");
    expect(fromAll).toContain("ui-combobox-input");
  });
});

test("Q13: on desktop the picker's list is capped at about eight rows and scrolls itself", async () => {
  const css = await Bun.file(new URL("../src/keys/keys.css", import.meta.url)).text();
  expect(css).toContain(".grant-resources .ui-popup .ui-listbox { max-height: 344px; overflow-y: auto;");
});

describe("Q1, U1, U2", () => {
  test("the owner's key activity names a refusal's surface, reason, and shortened address", () => {
    expect(keyEventLine({ action: "key.denied", meta: { reason: "ip", surface: "rest", clientPrefix: "198.51.100.0/24" } })).toBe("Refused over REST: not allowed from its address, from 198.51.100.0/24");
    expect(keyEventLine({ action: "key.denied", meta: { reason: "expired", surface: "mcp" } })).toBe("Refused over MCP: it has expired");
    expect(keyEventLine({ action: "key.policy_blocked", meta: { reason: "surface_role", surface: "rest" } })).toBe("Blocked by team policy over REST");
    expect(keyEventLine({ action: "key.created", meta: null })).toBe("Created");
  });

  test("an unknown upload is a coded 404", async () => {
    const owner = await createUser("U1 owner");
    const key = createApiKey(owner.userId, { name: "Uploads", surfaces: "mcp", grants: [{ module: "files", permission: "write", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const response = await fetch(`${origin}/mcp/uploads/${crypto.randomUUID()}`, { method: "PUT", headers: { Authorization: `Bearer ${key.token}`, "Content-Type": "application/octet-stream", "Content-Length": "1" }, body: "x" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Upload not found", code: "UPLOAD_NOT_FOUND" });
  });

  test("create_folder's own validation names the argument", async () => {
    const owner = await createUser("U2 owner");
    const key = createApiKey(owner.userId, { name: "Folders", surfaces: "mcp", grants: [{ module: "notes", permission: "draft", resourceKind: null, resourceId: null }], expiresInDays: 30 });
    const result = JSON.parse((await invokeMcpToolForTests("create_folder", { name: "   " }, key.id)).content[0]!.text) as { code: string; details: string[] };
    expect(result.code).toBe("INVALID");
    expect(result.details[0]).toStartWith("name: ");
  });
});
