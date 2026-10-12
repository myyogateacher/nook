import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toast, type ToastT } from "sonner";
import { ApiError } from "../src/api";
import { binUndoOptions, notifyBinned, onBinRestored, undoBinMove, undoFailureMessage, type BinRef } from "../src/bin/binUndo";
import { ACTION_DURATION } from "../src/ui/notify";

/** v0.35.0: Undo on every move to the Bin, through the Bin's own restore. */

const root = join(import.meta.dir, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const latest = () => [...toast.getHistory()].reverse().find((item) => !("dismiss" in item && item.dismiss)) as ToastT;
const titleText = (item: ToastT) => typeof item.title === "string" ? item.title : String((item.title as { props: { children: string } }).props.children);

// Other test files may leave `window` defined but undefined; put back whatever was there.
const scope = globalThis as { window?: unknown };
let saved: { had: boolean; value: unknown } | null = null;
afterEach(() => {
  if (!saved) return;
  if (saved.had) scope.window = saved.value;
  else delete scope.window;
  saved = null;
});
function withWindow() {
  if (scope.window && typeof (scope.window as EventTarget).addEventListener === "function") return;
  saved = { had: "window" in scope, value: scope.window };
  scope.window = new EventTarget();
}

const purging = () => new ApiError("This item is being permanently deleted", 409, { code: "PURGING" });
const gone = () => new ApiError("Item not found", 404, { error: "Item not found" });

describe("undoBinMove", () => {
  test("restores each item through the Bin's restore, refreshes once, and says Restored", async () => {
    const restored: BinRef[] = [];
    let refreshes = 0;
    const ok = await undoBinMove([{ type: "note", id: "n1" }], () => { refreshes += 1; }, async (item) => { restored.push(item); });
    expect(ok).toBe(true);
    expect(restored).toEqual([{ type: "note", id: "n1" }]);
    expect(refreshes).toBe(1);
    expect(latest().type).toBe("success");
    expect(titleText(latest())).toBe("Restored");
  });

  test("calls POST /api/bin/:type/:id/restore by default, the same path as Bin › Restore", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({ ok: true, folderName: "Default" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      expect(await undoBinMove([{ type: "knowledge_base", id: "k1" }, { type: "vault_secret", id: "s1" }])).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([{ url: "/api/bin/knowledge_base/k1/restore", method: "POST" }, { url: "/api/bin/vault_secret/s1/restore", method: "POST" }]);
  });

  test("an item purged meanwhile, or no longer the caller's to restore, is an error toast", async () => {
    let refreshes = 0;
    expect(await undoBinMove([{ type: "chat", id: "c1" }], () => { refreshes += 1; }, async () => { throw purging(); })).toBe(false);
    expect(refreshes).toBe(0);
    expect(latest().type).toBe("error");
    expect(titleText(latest())).toBe("Could not undo. It is being deleted forever and can't be restored.");
    expect(await undoBinMove([{ type: "agent", id: "a1" }], undefined, async () => { throw gone(); })).toBe(false);
    expect(titleText(latest())).toBe("Could not undo. It is no longer in the Bin, or you can no longer restore it.");
    // The server's own reason otherwise (a limit, a parent in the Bin).
    expect(undoFailureMessage(new ApiError("Restore its collection from the Bin first", 409, { code: "PARENT_IN_BIN" }))).toBe("Could not undo. Restore its collection from the Bin first.");
  });

  test("bulk: one toast for the batch, naming how many came back", async () => {
    let refreshes = 0;
    const ok = await undoBinMove([{ type: "note", id: "a" }, { type: "note", id: "b" }, { type: "note", id: "c" }], () => { refreshes += 1; }, async (item) => { if (item.id === "b") throw purging(); });
    expect(ok).toBe(false);
    expect(refreshes).toBe(1);
    expect(titleText(latest())).toBe("Restored 2 of 3. It is being deleted forever and can't be restored.");
  });

  test("tells views that left the item behind (onBinRestored), by type", async () => {
    withWindow();
    const heard: BinRef[][] = [];
    const stop = onBinRestored(["collection"], (items) => heard.push(items));
    await undoBinMove([{ type: "collection", id: "c1" }, { type: "note", id: "n1" }], undefined, async () => undefined);
    await undoBinMove([{ type: "note", id: "n2" }], undefined, async () => undefined);
    stop();
    await undoBinMove([{ type: "collection", id: "c2" }], undefined, async () => undefined);
    expect(heard).toEqual([[{ type: "collection", id: "c1" }]]);
  });
});

describe("notifyBinned", () => {
  test("one success toast with Undo that stays long enough, and Undo restores every item", async () => {
    const restored: string[] = [];
    let refreshed = 0;
    notifyBinned("Moved 2 items to the Bin", [{ type: "note", id: "x" }, { type: "document", id: "y" }], () => { refreshed += 1; }, async (item) => { restored.push(`${item.type}:${item.id}`); });
    const item = latest();
    expect(item.type).toBe("success");
    expect(item.title).toBe("Moved 2 items to the Bin");
    expect(item.duration).toBe(ACTION_DURATION);
    const action = item.action as { label: string; onClick: (event: unknown) => void };
    expect(action.label).toBe("Undo");
    action.onClick({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restored).toEqual(["note:x", "document:y"]);
    expect(refreshed).toBe(1);
  });

  test("with nothing binned (an empty note purged) there is no Undo", () => {
    notifyBinned("Empty note removed", []);
    expect(latest().action).toBeUndefined();
    expect(binUndoOptions([{ type: "note", id: "z" }]).action?.label).toBe("Undo");
  });
});

describe("every move to the Bin offers Undo through the right restore", () => {
  // File → the Bin types its delete handlers pass to notifyBinned.
  const sites: Record<string, string[]> = {
    "src/App.tsx": ["note"],
    "src/whiteboards/BoardDialogs.tsx": ["document"],
    "src/calendar/CalendarApp.tsx": ["event", "calendar"],
    "src/collections/CollectionView.tsx": ["collection", "collection_row"],
    "src/collections/CollectionList.tsx": ["collection"],
    "src/chat/ChatApp.tsx": ["chat"],
    "src/chat/AgentsSettings.tsx": ["agent"],
    "src/chat/KnowledgeSettings.tsx": ["knowledge_base"],
    "src/vault/VaultApp.tsx": ["vault", "vault_secret"],
    "src/vault/VaultDialogs.tsx": ["vault_environment"]
  };
  for (const [file, types] of Object.entries(sites)) {
    test(file, () => {
      const source = read(file);
      for (const type of types) expect(source).toMatch(new RegExp(`notifyBinned\\([^;]*\\[\\{ type: "${type}", id: `));
      // No move to the Bin is left with a plain "Moved to the Bin" toast.
      expect(source).not.toMatch(/notify\.success\([^)]*to the Bin[`"]\)/);
    });
  }

  test("notes: both the delete (list, editor, phone menu) and discarding an unpublished note", () => {
    const app = read("src/App.tsx");
    expect(app.match(/notifyBinned\("Moved to the Bin", \[\{ type: "note", id: noteId \}\], \(\) => loadNavigation\(\)\)/g)?.length).toBe(2);
    // An empty note is purged, not binned: no Undo.
    expect(app).toContain('if (result.purged) notify.success("Empty note removed");');
  });

  test("lists the deleting screen left reload after Undo", () => {
    expect(read("src/whiteboards/WhiteboardsApp.tsx")).toContain('onBinRestored(["document"]');
    expect(read("src/collections/CollectionList.tsx")).toContain('onBinRestored(["collection"]');
    expect(read("src/chat/AgentsSettings.tsx")).toContain('onBinRestored(["agent"]');
    expect(read("src/chat/KnowledgeSettings.tsx")).toContain('onBinRestored(["knowledge_base"]');
    expect(read("src/vault/VaultApp.tsx")).toContain('onBinRestored(["vault"]');
    expect(read("src/vault/VaultApp.tsx")).toContain('onBinRestored(["vault_secret", "vault_environment"]');
  });

  test("Files and Tasks keep their own Undo; a collection view re-creates itself", () => {
    expect(read("src/files/FilesApp.tsx")).toContain('restoreBinItem({ type: "document", id })');
    expect(read("src/tasks/BoardList.tsx")).toContain('label: "Undo"');
    expect(read("src/tasks/BoardView.tsx").match(/label: "Undo"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(read("src/collections/CollectionView.tsx")).toMatch(/Deleted view[^\n]*label: "Undo"[\s\S]*createView\(collectionId, name, config\)/);
  });

  test("delete forever and Empty Bin never offer Undo", () => {
    const bin = read("src/bin/BinSection.tsx");
    expect(bin).not.toContain("Undo");
    expect(bin).not.toContain("notifyBinned");
  });

  test("no MCP tool was added for agent deletes", () => {
    expect(read("server/mcpTools.ts")).not.toMatch(/delete_agent|delete_chat/);
  });
});
