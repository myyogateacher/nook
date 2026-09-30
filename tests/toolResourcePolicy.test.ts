import { beforeEach, describe, expect, test } from "bun:test";
import { createUser } from "./support/harness";

const { createApiKey } = await import("../server/apiKeys");
const { invokeMcpToolForTests, loadLiveKey, mcpToolSpecs, toolVisible } = await import("../server/mcpTools");
const { ANCHOR_KINDS } = await import("../server/keyResources");
const { SCOPE_GRANTS, SELECTOR_KINDS } = await import("../server/keyGrants");
const { resetMcpLimits } = await import("../server/mcpRateLimit");
type Grant = import("../server/keyGrants").Grant;

/**
 * Resource policy on every tool (Wave 34, access plan D281, T203): each MCP tool declares what it
 * reads and writes, and runTool enforces chosen-item keys from the declaration. This file fails
 * when a tool has no declaration, names an argument it does not have, or takes an id argument it
 * neither checks nor explains, and it calls every item tool with ids outside a chosen-items key.
 */

beforeEach(() => resetMcpLimits());

const shapeOf = (spec: (typeof mcpToolSpecs)[number]) => (spec.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
const MODES = ["items", "list", "derived", "own", "global"];
const namesAnItem = (name: string) => /(^id$|Id$|Ids$)/.test(name);

type SchemaNode = { def?: { type?: string; innerType?: SchemaNode; element?: SchemaNode; options?: SchemaNode[]; shape?: Record<string, SchemaNode>; valueType?: SchemaNode; left?: SchemaNode; right?: SchemaNode }; format?: string; shape?: Record<string, SchemaNode> };

/**
 * Every place a schema takes a UUID (review S6), as a path: `cardId`, `assigneeIds[]`, `items[].boardId`.
 * Walks optional, nullable, default, array, union, intersection, record, and nested object schemas.
 */
export function uuidPaths(node: SchemaNode | undefined, path = ""): string[] {
  if (!node) return [];
  if (node.format === "uuid") return [path];
  const def = node.def ?? {};
  // Verification R2: a plain string named like an id (`folderId`, `tagIds[]`) counts as an item argument too.
  const lastName = path.replace(/(\[\]|\{\})+$/, "").split(".").pop() ?? "";
  if (def.type === "string" && namesAnItem(lastName)) return [path];
  switch (def.type) {
    case "optional": case "nullable": case "default": case "prefault": case "readonly": case "nonoptional": case "catch":
      return uuidPaths(def.innerType, path);
    case "array": return uuidPaths(def.element, `${path}[]`);
    case "union": return (def.options ?? []).flatMap((option) => uuidPaths(option, path));
    case "intersection": return [...uuidPaths(def.left, path), ...uuidPaths(def.right, path)];
    case "record": return uuidPaths(def.valueType, `${path}{}`);
    case "object": return Object.entries(node.shape ?? def.shape ?? {}).flatMap(([key, child]) => uuidPaths(child, path ? `${path}.${key}` : key));
    default: return [];
  }
}

/** The UUID arguments a tool neither checks (items) nor explains (related), by top-level argument. */
export function undeclaredUuidArgs(spec: { inputSchema: unknown; access: { items?: ReadonlyArray<{ arg: string }>; related?: readonly string[] } }) {
  const declared = new Set([...(spec.access.items ?? []).map((item) => item.arg), ...(spec.access.related ?? [])]);
  return uuidPaths(spec.inputSchema as SchemaNode).filter((path) => !declared.has(path.split(/[.[{]/)[0]!));
}

describe("tool resource policy", () => {
  test("every registered tool declares what it touches", () => {
    expect(mcpToolSpecs.length).toBeGreaterThan(60);
    for (const spec of mcpToolSpecs) {
      expect({ tool: spec.name, mode: MODES.includes(spec.access?.mode) }).toEqual({ tool: spec.name, mode: true });
      const shape = shapeOf(spec);
      const declared = [...(spec.access.items ?? []).map((item) => item.arg), ...(spec.access.related ?? [])];
      // Every declared argument exists.
      for (const arg of declared) expect({ tool: spec.name, arg, exists: arg in shape }).toEqual({ tool: spec.name, arg, exists: true });
      // Every id argument is either checked or explained.
      for (const arg of Object.keys(shape).filter(namesAnItem)) expect({ tool: spec.name, arg, declared: declared.includes(arg) }).toEqual({ tool: spec.name, arg, declared: true });
      // Every UUID anywhere in the arguments, nested ones included (review S6).
      expect({ tool: spec.name, undeclared: undeclaredUuidArgs(spec) }).toEqual({ tool: spec.name, undeclared: [] });
      if (spec.access.mode === "items") expect({ tool: spec.name, items: (spec.access.items ?? []).length > 0 }).toEqual({ tool: spec.name, items: true });
      if (spec.access.mode === "list") expect({ tool: spec.name, lists: (spec.access.lists ?? []).length > 0 }).toEqual({ tool: spec.name, lists: true });
    }
  });

  test("the UUID walk finds nested undeclared ids (a fake tool fails the check)", async () => {
    const z = await import("zod/v4");
    const fake = {
      inputSchema: z.object({ boardId: z.string().uuid(), moves: z.array(z.object({ cardId: z.string().uuid(), to: z.union([z.literal("top"), z.string().uuid()]) })).optional(), note: z.string(), filter: z.object({ tagIds: z.array(z.string()).optional(), ownerId: z.string().nullable() }).optional() }),
      access: { mode: "items", items: [{ arg: "boardId", kind: "board" }] }
    };
    expect(uuidPaths(fake.inputSchema as never).sort()).toEqual(["boardId", "filter.ownerId", "filter.tagIds[]", "moves[].cardId", "moves[].to"]);
    expect(undeclaredUuidArgs(fake).sort()).toEqual(["filter.ownerId", "filter.tagIds[]", "moves[].cardId", "moves[].to"]);
    expect(undeclaredUuidArgs({ ...fake, access: { ...fake.access, related: ["moves", "filter"] } })).toEqual([]);
  });

  test("no tool deletes forever, shares, or manages keys, groups, templates, policies, or sign-in (D265)", () => {
    for (const spec of mcpToolSpecs) {
      expect(spec.name).not.toMatch(/key|grant|polic|access|token|permission|share|sharing|group|template|purge|delete|password|login|sign/);
    }
  });

  test("every item tool refuses items outside a chosen-items key as NOT_FOUND, never naming them", async () => {
    const owner = await createUser("Policy enumeration");
    const checked: string[] = [];
    for (const spec of mcpToolSpecs.filter((item) => item.access.mode === "items")) {
      const needed = SCOPE_GRANTS[spec.scopes[0]!];
      const kinds = SELECTOR_KINDS[needed.module] ?? [];
      // For each named item, a kind it anchors on that the module's grants may name (on random ids).
      const chosen = spec.access.items!.map((item) => ANCHOR_KINDS[item.kind].find((candidate) => kinds.includes(candidate) && (candidate !== "task_view" || needed.permission === "read")));
      if (chosen.some((kind) => !kind)) continue;
      const grants: Grant[] = [...new Set(chosen)].map((kind) => ({ ...needed, resourceKind: kind!, resourceId: crypto.randomUUID() }));
      for (const scope of spec.alsoRequires ?? []) grants.push({ ...SCOPE_GRANTS[scope], resourceKind: null, resourceId: null });
      const created = createApiKey(owner.userId, { name: `Policy ${spec.name}`.slice(0, 80), surfaces: "both", grants, expiresInDays: 30 });
      expect({ tool: spec.name, visible: toolVisible(spec, loadLiveKey(created.id)!) }).toEqual({ tool: spec.name, visible: true });
      const shape = shapeOf(spec);
      const outside = crypto.randomUUID();
      const args = Object.fromEntries(spec.access.items!.map((item) => {
        const schema = shape[item.arg] as { def?: { type?: string; innerType?: { def?: { type?: string } } } };
        const isArray = schema?.def?.type === "array" || schema?.def?.innerType?.def?.type === "array";
        return [item.arg, isArray ? [outside] : outside];
      }));
      for (const surface of ["mcp", "rest"] as const) {
        const result = await invokeMcpToolForTests(spec.name, args, created.id, surface);
        const text = result.content[0]!.text;
        expect({ tool: spec.name, surface, code: (JSON.parse(text) as { code?: string }).code }).toEqual({ tool: spec.name, surface, code: "NOT_FOUND" });
        expect({ tool: spec.name, echoed: text.includes(outside) }).toEqual({ tool: spec.name, echoed: false });
      }
      checked.push(spec.name);
    }
    // Every module with chosen items is exercised.
    for (const name of ["read_note", "get_note_draft", "publish_note_draft", "read_document_text", "move_file", "get_card", "link_cards", "set_wip_limit",
      "start_sprint", "get_row", "create_row", "get_event", "create_event", "read_whiteboard", "start_run", "finish_run", "bin_card"]) expect(checked).toContain(name);
  });

  test("global tools are hidden from chosen-items keys and refused if called", async () => {
    const owner = await createUser("Policy global");
    const created = createApiKey(owner.userId, {
      name: "Chosen notes", surfaces: "mcp", expiresInDays: 30,
      grants: [{ module: "notes", permission: "draft", resourceKind: "folder", resourceId: crypto.randomUUID() }, { module: "collections", permission: "write", resourceKind: "collection", resourceId: crypto.randomUUID() }]
    });
    const context = loadLiveKey(created.id)!;
    for (const name of ["create_folder", "create_collection"]) {
      const spec = mcpToolSpecs.find((item) => item.name === name)!;
      expect(toolVisible(spec, context)).toBe(false);
      const result = await invokeMcpToolForTests(name, { name: "Nope" }, created.id);
      expect(JSON.parse(result.content[0]!.text).code).toBe("SCOPE_REQUIRED");
    }
    // A create inside a chosen container must name it: leaving it out would use the Default folder.
    const missing = await invokeMcpToolForTests("create_note", { markdown: "Hello" }, created.id);
    expect(JSON.parse(missing.content[0]!.text).code).toBe("INVALID");
  });
});
