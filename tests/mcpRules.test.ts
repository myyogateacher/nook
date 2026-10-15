import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./support/harness";

const { mcpToolSpecs } = await import("../server/mcpTools");
const { MCP_SCOPES, MCP_WRITE_SCOPES } = await import("../server/mcpScopes");

/**
 * The hard rules of MCP write coverage (docs/plan/WAVES_18-20_SMALL.md §2.1, D180): never over MCP
 * hard deletes or purges, emptying the Bin, sharing changes, role or team changes, or key management.
 */
const FORBIDDEN_WRITE_NAME = /purge|empty|share|role|block|delete_forever|invite|key|complete_sprint/;

test("no write tool's name offers a forbidden verb", () => {
  const writes = mcpToolSpecs.filter((spec) => spec.write);
  expect(writes.length).toBeGreaterThan(30);
  for (const spec of writes) expect({ name: spec.name, forbidden: FORBIDDEN_WRITE_NAME.test(spec.name) }).toEqual({ name: spec.name, forbidden: false });
  // Nor does any tool delete (the Bin is the only removal, and it is always reversible).
  for (const spec of mcpToolSpecs) expect(spec.name).not.toMatch(/(^|_)delete(_|$)|remove|base64/);
});

test("the Wave 19 tools are exactly these, each with its scopes, all-of scopes, and buckets", () => {
  const shape = (name: string) => {
    const spec = mcpToolSpecs.find((item) => item.name === name);
    if (!spec) throw new Error(`missing ${name}`);
    return { scopes: [...spec.scopes], alsoRequires: [...(spec.alsoRequires ?? [])], write: spec.write, buckets: [...(spec.dailyBucket ? [spec.dailyBucket] : []), ...(spec.buckets ?? [])] };
  };
  const bin = ["bin_action", "bin_burst"];
  expect({
    publish_note_draft: shape("publish_note_draft"),
    create_folder: shape("create_folder"),
    bin_note: shape("bin_note"), restore_note: shape("restore_note"),
    bin_card: shape("bin_card"), restore_card: shape("restore_card"),
    manage_tags: shape("manage_tags"), set_wip_limit: shape("set_wip_limit"),
    create_sprint: shape("create_sprint"), start_sprint: shape("start_sprint"), link_attachment: shape("link_attachment"),
    bin_event: shape("bin_event"), restore_event: shape("restore_event"),
    create_collection: shape("create_collection"), bin_row: shape("bin_row"), restore_row: shape("restore_row"),
    create_text_file: shape("create_text_file"), begin_upload: shape("begin_upload"), finish_upload: shape("finish_upload"),
    rename_file: shape("rename_file"), move_file: shape("move_file")
  }).toEqual({
    publish_note_draft: { scopes: ["notes:publish"], alsoRequires: [], write: true, buckets: ["note_publish"] },
    create_folder: { scopes: ["notes:write-draft", "files:write"], alsoRequires: [], write: true, buckets: ["structure_write"] },
    bin_note: { scopes: ["notes:write-draft"], alsoRequires: ["bin:write"], write: true, buckets: bin },
    restore_note: { scopes: ["notes:write-draft"], alsoRequires: ["bin:write"], write: true, buckets: [] },
    bin_card: { scopes: ["tasks:write"], alsoRequires: ["bin:write"], write: true, buckets: bin },
    restore_card: { scopes: ["tasks:write"], alsoRequires: ["bin:write"], write: true, buckets: [] },
    manage_tags: { scopes: ["tasks:write"], alsoRequires: [], write: true, buckets: ["task_write"] },
    set_wip_limit: { scopes: ["tasks:write"], alsoRequires: [], write: true, buckets: ["task_write"] },
    create_sprint: { scopes: ["tasks:write"], alsoRequires: [], write: true, buckets: ["sprint_write"] },
    start_sprint: { scopes: ["tasks:write"], alsoRequires: [], write: true, buckets: ["sprint_write"] },
    link_attachment: { scopes: ["tasks:write"], alsoRequires: [], write: true, buckets: ["task_write"] },
    bin_event: { scopes: ["calendar:write"], alsoRequires: ["bin:write"], write: true, buckets: bin },
    restore_event: { scopes: ["calendar:write"], alsoRequires: ["bin:write"], write: true, buckets: [] },
    create_collection: { scopes: ["collections:write"], alsoRequires: [], write: true, buckets: ["row_write"] },
    bin_row: { scopes: ["collections:write"], alsoRequires: ["bin:write"], write: true, buckets: bin },
    restore_row: { scopes: ["collections:write"], alsoRequires: ["bin:write"], write: true, buckets: [] },
    create_text_file: { scopes: ["files:write"], alsoRequires: [], write: true, buckets: ["file_write"] },
    begin_upload: { scopes: ["files:write"], alsoRequires: [], write: true, buckets: ["file_write"] },
    finish_upload: { scopes: ["files:write"], alsoRequires: [], write: false, buckets: [] },
    rename_file: { scopes: ["files:write"], alsoRequires: [], write: true, buckets: ["structure_write"] },
    move_file: { scopes: ["files:write"], alsoRequires: [], write: true, buckets: ["structure_write"] }
  });
});

test("every Bin tool needs bin:write, every bin_ tool says it can be restored, and bin:write alone reaches nothing", () => {
  for (const spec of mcpToolSpecs) {
    const binTool = /^(bin|restore)_/.test(spec.name);
    expect({ name: spec.name, binWrite: (spec.alsoRequires ?? []).includes("bin:write") }).toEqual({ name: spec.name, binWrite: binTool });
    if (spec.name.startsWith("bin_")) expect(spec.description).toContain("the person can restore it");
    // bin:write is never the any-of scope: it always needs a module write scope next to it.
    expect(spec.scopes).not.toContain("bin:write");
    for (const scope of [...spec.scopes, ...(spec.alsoRequires ?? [])]) expect(MCP_SCOPES).toContain(scope);
    // A write tool needs a write scope.
    if (spec.write) expect(spec.scopes.every((scope) => MCP_WRITE_SCOPES.includes(scope))).toBe(true);
  }
  const publish = mcpToolSpecs.find((spec) => spec.name === "publish_note_draft")!;
  expect(publish.description).toContain("visible to everyone the note is shared with");
  expect(publish.description).toContain("get_note_draft");
  expect(mcpToolSpecs.find((spec) => spec.name === "move_file")!.description).toContain("who can see the file");
});

test("no MCP tool module imports a purge, empty-Bin, sharing, or role writer (D180)", () => {
  const files = [
    "server/mcpTools.ts", "server/mcpNoteTools.ts", "server/mcpFileTools.ts", "server/mcpUploads.ts", "server/mcpToolKit.ts",
    "server/tasks/mcpTools.ts", "server/tasks/viewMcpTools.ts", "server/calendar/mcpTools.ts", "server/collections/mcpTools.ts",
    "server/team/mcpTools.ts", "server/today/mcpTools.ts", "server/inbox/mcpTools.ts"
  ];
  for (const file of files) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    const imports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)].flatMap((match) => match[1]!.split(",").map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!));
    for (const name of imports) expect({ file, name, forbidden: /^purge|^emptyBin$|^emptyTaskBin$|^putSharing$|^putCalendarSharing$|^setRole$|^revokeMcpApiKey$|^createMcpApiKey$|^completeSprint$/.test(name) }).toEqual({ file, name, forbidden: false });
  }
});
