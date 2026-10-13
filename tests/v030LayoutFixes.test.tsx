import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AddSourceSheet } from "../src/chat/KnowledgeSettings";
import { grantChips, grantSummary } from "../src/keys/keyGrants";
import type { KnowledgeDetail } from "../shared/knowledge";

const root = join(import.meta.dir, "..", "src");
const read = (path: string) => Bun.file(join(root, path)).text();
/** The declarations of one exact selector in a stylesheet. */
const rule = (sheet: string, selector: string) => {
  const start = sheet.indexOf(`${selector} {`);
  return start === -1 ? null : sheet.slice(start, sheet.indexOf("}", start));
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const kb = (patch: Partial<KnowledgeDetail> = {}): KnowledgeDetail => ({
  id: id(1), name: "Team handbook", description: "", ownerId: id(2), ownerName: "Ana", yourLevel: "owner", embeddingModel: "text-embedding-3-small", dims: 512,
  status: "ready", chunkCount: 0, sourceCount: 0, counts: { pending: 0, indexing: 0, ready: 0, error: 0, unavailable: 0 }, audience: null, revision: 1,
  createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", notice: null, sources: [], ...patch
});
const sheet = (patch: Partial<KnowledgeDetail> = {}) => renderToStaticMarkup(<AddSourceSheet kb={kb(patch)} onClose={() => undefined} onAdded={() => undefined} />);

describe("v0.30 layout fixes", () => {
  test("H: Add source follows the shared dialog contract: one scrolling body, its footer last and pinned", async () => {
    const html = sheet();
    // The dialog's only child after its header is the shared .file-dialog-form (files.css scrolls it
    // and pins a footer that is its last child); the footer holds Done.
    expect(html).toMatch(/<\/header><form class="file-dialog-form knowledge-add-body" noValidate="">/);
    expect(html).toMatch(/<footer class="file-dialog-actions"><button type="button" class="action-button secondary">Done<\/button><\/footer><\/form><\/section>/);
    const files = await read("files/files.css");
    expect(rule(files, ".file-dialog > .file-dialog-form")).toContain("overflow-y: auto");
    expect(rule(files, ".file-dialog > .file-dialog-form > .file-dialog-actions:last-child")).toContain("position: sticky");
    // Nothing shows under the pinned footer (the chat dialogs' 16 px bottom padding once let rows through).
    expect(rule(files, ".file-dialog > .file-dialog-form:has(> .file-dialog-actions:last-child)")).toContain("padding-bottom: 0");
    // No second scroller (the candidate list once scrolled at 50vh inside the clipped sheet), and no
    // padding of its own on top of the form's (L4: the form sat 20 px further in than the modes).
    const css = await read("chat/knowledge.css");
    expect(css).not.toContain("50vh");
    expect(css).not.toMatch(/\.knowledge-candidates \{[^}]*overflow/);
    expect(css).not.toMatch(/\.knowledge-add-body \{/);
    // Paste text is the same form: no form nested inside the body.
    expect(await read("chat/KnowledgeSettings.tsx")).not.toContain('<form className="file-dialog-form" onSubmit={(event)');
  });

  test("L1: the owner reads only as themselves; a manager sees both readers by name", () => {
    const owner = sheet();
    expect(owner).toContain("Only what you can read is listed.");
    expect(owner).not.toContain("both you and you");
    const manager = sheet({ yourLevel: "manage" });
    expect(manager).toContain("Only what both you and Ana can read is listed; it is read as Ana when indexed.");
  });

  test("L2: Chat → Read on chosen knowledge bases says it searches knowledge", () => {
    const chosen = { key: "a", module: "agents" as const, permission: "read" as const, applies: "chosen" as const, resourceIds: [`knowledge_base:${id(1)}`] };
    expect(grantSummary([chosen])).toStartWith("Chat: search knowledge on 1 knowledge base.");
    expect(grantSummary([{ ...chosen, applies: "all" as const, resourceIds: [] }])).toStartWith("Chat: read agents, chats, and knowledge.");
    expect(grantChips([{ module: "agents", permission: "read", resource: { kind: "knowledge_base", id: id(1), name: "Team handbook" }, active: true, inactiveReason: null }])[0]!.label).toBe("Chat: search knowledge · Team handbook");
    expect(grantChips([{ module: "agents", permission: "read", resource: null, active: true, inactiveReason: null }])[0]!.label).toBe("Chat: read agents, chats, and knowledge");
  });

  test("L3: the source type buttons are 44 px targets", async () => {
    expect(rule(await read("chat/knowledge.css"), ".knowledge-mode")).toContain("min-height: 44px");
  });
});
