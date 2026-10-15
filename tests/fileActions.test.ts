import { expect, test } from "bun:test";
import { sanitizeDisplayName } from "../server/validation";
import {
  baseNameRange,
  canDropOnFolder,
  DOCUMENT_DRAG_TYPE,
  isDocumentDrag,
  isOsFileDrag,
  readDocumentDragPayload,
  rollbackRename,
  upsertListedDocument,
  ROW_ITEM_ATTRIBUTE,
  shortcutDocumentId,
  uploadDropMessage,
  compareDocuments,
  DEFAULT_FILE_SORT,
  fileCountLabel,
  fileSortOptions,
  fileSortStorageKey,
  filterDocuments,
  readFileSort,
  sortDocuments,
  validateFolderName,
  writeFileSort,
  deleteConfirmMessage,
  filesEmptyState,
  moveTargets,
  movedMessage,
  sanitizeRenameInput,
  validateRename
} from "../src/files/fileActions";
import type { DocumentSummary, Folder } from "../src/types";

test("the client rename sanitizer matches the server for every rule", () => {
  const inputs = [
    "report.pdf", "  spaced   out  .txt ", "a/b\\c:d.txt", "\u202Eevil\u202C.txt", "zero\u200Bwidth", "tab\tand\nnewline",
    ".", "..", "...", "   ", "", "\u0000\u0007", ".hidden", "trailing.", "e\u0301clair.md", "x".repeat(255), "x".repeat(256),
    "é".repeat(127) + "a", "é".repeat(128), "\uD800lonely", "日本語のファイル.txt", "emoji 😀.png"
  ];
  for (const input of inputs) expect(sanitizeRenameInput(input)).toBe(sanitizeDisplayName(input, "rename"));
});

test("rename validation explains empty and oversized names and detects no-op renames", () => {
  expect(validateRename("   ", "a.txt")).toEqual({ ok: false, error: "Enter a name." });
  expect(validateRename("..", "a.txt")).toEqual({ ok: false, error: "Enter a name." });
  const long = validateRename("é".repeat(200), "a.txt");
  expect(long.ok).toBe(false);
  if (!long.ok) expect(long.error).toContain("255 bytes");
  expect(validateRename(" a.txt ", "a.txt")).toEqual({ ok: true, name: "a.txt", changed: false });
  expect(validateRename("a:b.txt", "a.txt")).toEqual({ ok: true, name: "a-b.txt", changed: true });
});

test("the rename field preselects the base name without the extension", () => {
  expect(baseNameRange("report.final.pdf")).toEqual([0, 12]);
  expect(baseNameRange("README")).toEqual([0, 6]);
  expect(baseNameRange(".env")).toEqual([0, 4]);
});

const folder = (id: string, name: string, extra: Partial<Folder> = {}): Folder => ({
  id, owner_id: "u1", owner_name: "Ada", parent_id: null, name, is_default: 0, is_owner: 1, visibility: "private",
  created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", ...extra
});

test("move targets list owned folders only, Default first, with the current folder disabled", () => {
  const folders = [folder("f3", "zeta"), folder("f2", "Alpha"), folder("f1", "Default", { is_default: 1 }), folder("f4", "Theirs", { is_owner: 0, owner_id: "u2" })];
  const targets = moveTargets(folders, "f2");
  expect(targets.map((target) => target.id)).toEqual(["f1", "f2", "f3"]);
  expect(targets.filter((target) => target.current).map((target) => target.id)).toEqual(["f2"]);
  expect(moveTargets(folders, null).some((target) => target.current)).toBe(false);
});

test("move and delete copy", () => {
  expect(movedMessage("Projects", "selected")).toBe("Moved to Projects · shared with selected people");
  expect(movedMessage("Default", "private")).toBe("Moved to Default · private");
  expect(movedMessage("Team", "all_users")).toBe("Moved to Team · shared with everyone");
  expect(deleteConfirmMessage("a.pdf")).toBe("Move “a.pdf” to the Bin? You can restore it for 30 days.");
});

const doc = (id: string, name: string, updated_at: string, size_bytes: number, extra: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id, owner_id: "u1", owner_name: "Ada", is_owner: 1, folder_id: null, name, mime_type: "text/plain", preview_kind: "text",
  size_bytes, visibility: "private", sharing_override: 0, created_at: updated_at, updated_at, ...extra
});
const docs = [
  doc("d1", "file10.txt", "2026-09-03T00:00:00.000Z", 300),
  doc("d2", "File2.txt", "2026-09-01T00:00:00.000Z", 5000),
  doc("d3", "alpha.pdf", "2026-09-02T00:00:00.000Z", 300),
  doc("d4", "Zeta notes.md", "2026-09-04T00:00:00.000Z", 12, { owner_name: "Grace", is_owner: 0 })
];
const names = (items: DocumentSummary[]) => items.map((item) => item.name);

test("the sort comparator covers every option with a stable tie-break", () => {
  expect(names(sortDocuments(docs, "name-asc"))).toEqual(["alpha.pdf", "File2.txt", "file10.txt", "Zeta notes.md"]);
  expect(names(sortDocuments(docs, "name-desc"))).toEqual(["Zeta notes.md", "file10.txt", "File2.txt", "alpha.pdf"]);
  expect(names(sortDocuments(docs, "updated-desc"))).toEqual(["Zeta notes.md", "file10.txt", "alpha.pdf", "File2.txt"]);
  expect(names(sortDocuments(docs, "updated-asc"))).toEqual(["File2.txt", "alpha.pdf", "file10.txt", "Zeta notes.md"]);
  expect(names(sortDocuments(docs, "size-desc"))).toEqual(["File2.txt", "alpha.pdf", "file10.txt", "Zeta notes.md"]);
  expect(names(sortDocuments(docs, "size-asc"))).toEqual(["Zeta notes.md", "alpha.pdf", "file10.txt", "File2.txt"]);
  // Same size: name decides, then id.
  const twins = [doc("b", "same.txt", "2026-09-01T00:00:00.000Z", 1), doc("a", "same.txt", "2026-09-01T00:00:00.000Z", 1)];
  expect(sortDocuments(twins, "size-desc").map((item) => item.id)).toEqual(["a", "b"]);
  expect(compareDocuments("name-asc")(docs[0], docs[0])).toBe(0);
  expect(sortDocuments(docs, "name-asc")).not.toBe(docs);
  expect(fileSortOptions.map((option) => option.label)).toEqual(["Name A–Z", "Name Z–A", "Newest modified", "Oldest modified", "Largest", "Smallest"]);
});

test("the filter matches every word in the name or owner, ignoring case and spacing", () => {
  expect(names(filterDocuments(docs, "  "))).toEqual(names(docs));
  expect(names(filterDocuments(docs, "FILE"))).toEqual(["file10.txt", "File2.txt"]);
  expect(names(filterDocuments(docs, "txt  2"))).toEqual(["File2.txt"]);
  expect(names(filterDocuments(docs, "grace"))).toEqual(["Zeta notes.md"]);
  expect(filterDocuments(docs, "nothing")).toEqual([]);
  expect(fileCountLabel(4, 4)).toBe("4 files");
  expect(fileCountLabel(1, 1)).toBe("1 file");
  expect(fileCountLabel(1, 4)).toBe("1 of 4 files");
  // D497: text hits are counted; no name match never reads "0 of 4 files".
  expect(fileCountLabel(0, 4)).toBe("No names match");
  expect(fileCountLabel(0, 4, 2)).toBe("2 in file text");
  expect(fileCountLabel(0, 4, 20, true)).toBe("20+ in file text");
  expect(fileCountLabel(1, 4, 3)).toBe("1 of 4 files · 3 in text");
  expect(fileCountLabel(4, 4, 3)).toBe("4 files · 3 in text");
});

test("the sort choice is remembered per user and survives broken storage", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  expect(readFileSort(storage, "u1")).toBe(DEFAULT_FILE_SORT);
  writeFileSort(storage, "u1", "size-asc");
  expect(store.get(fileSortStorageKey("u1"))).toBe("size-asc");
  expect(readFileSort(storage, "u1")).toBe("size-asc");
  expect(readFileSort(storage, "u2")).toBe(DEFAULT_FILE_SORT);
  store.set(fileSortStorageKey("u1"), "bogus");
  expect(readFileSort(storage, "u1")).toBe(DEFAULT_FILE_SORT);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  expect(readFileSort(broken, "u1")).toBe(DEFAULT_FILE_SORT);
  expect(() => writeFileSort(broken, "u1", "name-asc")).not.toThrow();
  expect(readFileSort(null, "u1")).toBe(DEFAULT_FILE_SORT);
});

test("folder names follow the server rules", () => {
  expect(validateFolderName("  Projects ")).toEqual({ ok: true, name: "Projects", changed: true });
  expect(validateFolderName("   ").ok).toBe(false);
  expect(validateFolderName("default").ok).toBe(false);
  expect(validateFolderName("x".repeat(120)).ok).toBe(true);
  expect(validateFolderName("x".repeat(121)).ok).toBe(false);
});

test("drag type checks tell OS files, our rows, and notes apart", () => {
  expect(DOCUMENT_DRAG_TYPE).toBe("application/x-mynotes-document");
  expect(isOsFileDrag(["Files"])).toBe(true);
  expect(isOsFileDrag(["text/plain"])).toBe(false);
  expect(isOsFileDrag(["Files", DOCUMENT_DRAG_TYPE])).toBe(false);
  expect(isOsFileDrag(["Files", "application/x-mynotes-note"])).toBe(false);
  expect(isOsFileDrag(null)).toBe(false);
  expect(isDocumentDrag([DOCUMENT_DRAG_TYPE])).toBe(true);
  expect(isDocumentDrag({ length: 1, 0: DOCUMENT_DRAG_TYPE })).toBe(true);
  expect(isDocumentDrag(["application/x-mynotes-note"])).toBe(false);
});

test("row drag payloads must be document ids", () => {
  expect(readDocumentDragPayload("A1B2C3D4-E5F6-4A7B-9C8D-0E1F2A3B4C5D")).toBe("a1b2c3d4-e5f6-4a7b-9c8d-0e1f2a3b4c5d");
  expect(readDocumentDragPayload("")).toBeNull();
  expect(readDocumentDragPayload("../etc/passwd")).toBeNull();
  expect(readDocumentDragPayload(null)).toBeNull();
});

test("rows drop only on other folders the caller owns", () => {
  const mine = folder("f1", "Mine");
  const theirs = folder("f2", "Theirs", { is_owner: 0 });
  expect(canDropOnFolder(mine, { is_owner: 1, folder_id: "f9" })).toBe(true);
  expect(canDropOnFolder(mine, { is_owner: 1, folder_id: null })).toBe(true);
  expect(canDropOnFolder(mine, { is_owner: 1, folder_id: "f1" })).toBe(false);
  expect(canDropOnFolder(mine, { is_owner: 0, folder_id: "f9" })).toBe(false);
  expect(canDropOnFolder(theirs, { is_owner: 1, folder_id: "f9" })).toBe(false);
  expect(canDropOnFolder(mine, null)).toBe(true);
  expect(uploadDropMessage("Projects")).toBe("Drop to upload to Projects");
  expect(uploadDropMessage(null)).toBe("You can only upload to your own folders");
});

test("each Files view has its own empty state", () => {
  expect(filesEmptyState({ kind: "all" }).title).toBe("No files yet");
  expect(filesEmptyState({ kind: "shared" }).body).toBe("Files other people share with you will appear here.");
  expect(filesEmptyState({ kind: "folder", name: "Projects", owned: true, ownerName: "Ada" })).toEqual({ title: "This folder is empty", body: "Upload a file, or drop files here, to add it to Projects." });
  expect(filesEmptyState({ kind: "folder", name: "Team", owned: false, ownerName: "Grace" }).body).toBe("Nothing in Grace’s folder is shared with you yet.");
});

test("list shortcuts act on the item holding focus, including its ⋯ button", () => {
  // A minimal element: closest() finds the list item that wraps both the row and its ⋯ button.
  const item = { getAttribute: (name: string) => name === ROW_ITEM_ATTRIBUTE ? "doc-b" : null };
  const moreButton = { closest: (selector: string) => selector === `[${ROW_ITEM_ATTRIBUTE}]` ? item : null };
  expect(shortcutDocumentId(moreButton, "doc-a")).toBe("doc-b");
  expect(shortcutDocumentId({ closest: () => null }, "doc-a")).toBe("doc-a");
  expect(shortcutDocumentId(null, null)).toBeNull();
});

test("a saved document replaces its row, is added when new, and never pulls an unlisted one into the list", () => {
  const saved = { ...docs[1], name: "renamed.txt" };
  expect(names(upsertListedDocument(docs, saved, null))).toEqual(["file10.txt", "renamed.txt", "alpha.pdf", "Zeta notes.md"]);
  const outside = doc("d9", "beyond-limit.txt", "2026-09-05T00:00:00.000Z", 1);
  expect(upsertListedDocument(docs, outside, "d9")).toBe(docs);
  expect(names(upsertListedDocument(docs, outside, null))[0]).toBe("beyond-limit.txt");
});

test("a refused rename rolls back only if the optimistic name is still shown", () => {
  const optimistic = docs.map((item) => item.id === "d2" ? { ...item, name: "new.txt" } : item);
  expect(rollbackRename(optimistic, "d2", "new.txt", "File2.txt").find((item) => item.id === "d2")?.name).toBe("File2.txt");
  // A later rename won; the rollback leaves it alone.
  const later = optimistic.map((item) => item.id === "d2" ? { ...item, name: "newer.txt" } : item);
  expect(rollbackRename(later, "d2", "new.txt", "File2.txt").find((item) => item.id === "d2")?.name).toBe("newer.txt");
  expect(rollbackRename(optimistic, "d1", "new.txt", "x").find((item) => item.id === "d1")?.name).toBe("file10.txt");
});
