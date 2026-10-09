import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadMenu } from "../src/files/UploadMenu";
import {
  chosenFolderFiles,
  droppedEntries,
  filesToUploadFromPaste,
  FOLDER_NAME_MAX,
  FOLDER_UPLOAD_MAX_DEPTH,
  FOLDER_UPLOAD_MAX_FILES,
  FOLDER_UPLOAD_MAX_FOLDERS,
  folderUploadParentFor,
  folderUploadSummary,
  isEditableTarget,
  isSystemClutter,
  nestFolders,
  pastedFileName,
  planFolderUpload,
  readDroppedEntries,
  renamePastedFile,
  safeFolderName,
  uniqueFolderName,
  UNTITLED_FOLDER,
  uploadFolderFor
} from "../src/files/uploadSources";
import { canRetryUpload, emptyUploadQueue, finishedBatch, uploadQueueReducer, uploadsToStart } from "../src/files/uploadQueue";

/**
 * Uploads everywhere U6 (Files polish, G9): paste to upload, Take photo, folder upload (the tree
 * builder and its limits), and the rule that no new upload path targets the Attachments folder.
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

const owned = { id: "f-own", is_owner: 1, system_kind: null };
const attachments = { id: "f-att", is_owner: 1, system_kind: "attachments" };
const sharedFolder = { id: "f-shared", is_owner: 0, system_kind: null };
const defaultFolder = { id: "f-default" };

describe("upload targets", () => {
  test("files go to Default in All files and to an owned folder, never to Shared, a shared folder, or Attachments", () => {
    expect(uploadFolderFor("all", null, defaultFolder)).toBe("f-default");
    expect(uploadFolderFor("f-own", owned, defaultFolder)).toBe("f-own");
    expect(uploadFolderFor("f-att", attachments, defaultFolder)).toBeUndefined();
    expect(uploadFolderFor("f-shared", sharedFolder, defaultFolder)).toBeUndefined();
    expect(uploadFolderFor("shared", null, defaultFolder)).toBeUndefined();
  });

  test("a folder upload lands at the top level in All files or inside an owned folder, never in Attachments", () => {
    expect(folderUploadParentFor("all", null)).toBeNull();
    expect(folderUploadParentFor("f-own", owned)).toBe("f-own");
    expect(folderUploadParentFor("f-att", attachments)).toBeUndefined();
    expect(folderUploadParentFor("f-shared", sharedFolder)).toBeUndefined();
    expect(folderUploadParentFor("shared", null)).toBeUndefined();
  });

  test("FilesApp routes every source through the same targets and strips location from camera and paste", () => {
    const app = source("files/FilesApp.tsx");
    expect(app).toContain("uploadFolderFor(folder, currentFolder, defaultFolder)");
    expect(app).toContain("folderUploadParentFor(folder, currentFolder)");
    expect(app).toMatch(/async function chooseCaptured[\s\S]{0,200}stripImageLocation/);
    expect(app).toContain("onPhoto={(files) => { void chooseCaptured(files); }}");
    expect(app).toContain("void chooseCaptured(files.map((file) => renamePastedFile(file, at)))");
  });
});

const clipboard = (files: File[], data: Record<string, string> = {}) => ({
  files: files as unknown as FileList,
  getData: (type: string) => data[type] ?? ""
});
const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

describe("paste to upload", () => {
  test("a clipboard holding only files (a screenshot) uploads", () => {
    expect(filesToUploadFromPaste(clipboard([png]), null)).toEqual([png]);
    expect(filesToUploadFromPaste(clipboard([png], { "text/html": "<img src=\"blob:x\">" }), { tagName: "BODY" })).toEqual([png]);
  });

  test("rich text and plain text pastes are ignored", () => {
    expect(filesToUploadFromPaste(clipboard([png], { "text/html": "<p>Quarterly numbers</p><img src=\"x\">" }), null)).toEqual([]);
    expect(filesToUploadFromPaste(clipboard([], { "text/plain": "hello" }), null)).toEqual([]);
    expect(filesToUploadFromPaste(null, null)).toEqual([]);
  });

  test("in a text field a clipboard that also has plain text stays a text paste", () => {
    const filter = { tagName: "INPUT", type: "search" };
    expect(filesToUploadFromPaste(clipboard([png], { "text/plain": "report.pdf" }), filter)).toEqual([]);
    expect(filesToUploadFromPaste(clipboard([png]), filter)).toEqual([png]);
    expect(filesToUploadFromPaste(clipboard([png], { "text/plain": "report.pdf" }), { tagName: "DIV" })).toEqual([png]);
  });

  test("editable targets", () => {
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableTarget({ tagName: "INPUT", type: "file" })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test("a browser's generic image.png gets a dated name; real names are kept", () => {
    const at = new Date(2026, 9, 9, 14, 3, 7);
    expect(pastedFileName("image.png", at)).toBe("Pasted image 2026-10-09 at 14.03.07.png");
    expect(pastedFileName("IMAGE.JPEG", at)).toBe("Pasted image 2026-10-09 at 14.03.07.jpg");
    expect(pastedFileName("", at)).toBe("Pasted image 2026-10-09 at 14.03.07.png");
    expect(pastedFileName("diagram.png", at)).toBe("diagram.png");
    const renamed = renamePastedFile(png, at);
    expect(renamed.name).toBe("Pasted image 2026-10-09 at 14.03.07.png");
    expect(renamed.type).toBe("image/png");
    expect(renamed.size).toBe(png.size);
    const named = new File(["x"], "notes.txt");
    expect(renamePastedFile(named, at)).toBe(named);
  });
});

const menu = (props: Partial<Parameters<typeof UploadMenu>[0]> = {}) => renderToStaticMarkup(<UploadMenu destination="Projects" open camera={false} folder={false}
  onOpenChange={() => undefined} onChooseFiles={() => undefined} onPhoto={() => undefined} onFolder={() => undefined} {...props} />);

describe("the upload menu (Take photo, Upload files, Upload folder)", () => {
  test("Take photo is offered on coarse pointers with a rear-camera capture input", () => {
    const markup = menu({ camera: true });
    expect(markup).toContain(">Take photo<");
    expect(markup).toContain(">Choose files<");
    expect(markup).toContain('accept="image/*"');
    expect(markup).toContain('capture="environment"');
    expect(markup).toContain('data-upload-input="camera"');
  });

  test("without a coarse pointer there is no camera item and no capture input", () => {
    const markup = menu();
    expect(markup).not.toContain("Take photo");
    expect(markup).not.toContain("capture=");
    expect(markup).toContain(">Upload files<");
    expect(markup).not.toContain("Upload folder");
  });

  test("Upload folder uses a directory chooser", () => {
    const markup = menu({ folder: true });
    expect(markup).toContain(">Upload folder<");
    expect(markup).toContain('webkitdirectory=""');
    expect(markup).toContain('data-upload-input="folder"');
  });

  test("closed, the button names the destination and the menu is absent", () => {
    const markup = menu({ open: false, camera: true });
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('title="Upload to Projects"');
    expect(markup).not.toContain('role="menu"');
  });

  test("the menu is a history layer (Back closes it)", () => {
    expect(source("files/UploadMenu.tsx")).toContain("useHistoryDialogGuard(open,");
  });
});

const file = (path: string, size = 10) => ({ item: { path, size }, path });

describe("folder upload tree builder", () => {
  test("recreates the subfolders, parents first, and puts each file in its folder", () => {
    const plan = planFolderUpload([file("Photos/2024/a.jpg"), file("Photos/b.jpg"), file("Photos/2024/Trip/c.jpg"), file("Photos/2025/d.jpg")], []);
    expect(plan.error).toBeNull();
    expect(plan.roots).toEqual(["Photos"]);
    expect(plan.folders).toEqual([
      { key: "Photos", name: "Photos", parentKey: null, depth: 1 },
      { key: "Photos/2024", name: "2024", parentKey: "Photos", depth: 2 },
      { key: "Photos/2024/Trip", name: "Trip", parentKey: "Photos/2024", depth: 3 },
      { key: "Photos/2025", name: "2025", parentKey: "Photos", depth: 2 }
    ]);
    expect(plan.files.map((entry) => [entry.name, entry.folderKey])).toEqual([["a.jpg", "Photos/2024"], ["b.jpg", "Photos"], ["c.jpg", "Photos/2024/Trip"], ["d.jpg", "Photos/2025"]]);
    for (const folder of plan.folders) if (folder.parentKey) expect(plan.folders.findIndex((item) => item.key === folder.parentKey)).toBeLessThan(plan.folders.indexOf(folder));
  });

  test("a top folder whose name is taken in the parent becomes “(2)”, case-insensitively, so nothing merges", () => {
    const plan = planFolderUpload([file("photos/a.jpg"), file("photos/sub/b.jpg")], ["Default", "Photos", "Photos (2)"]);
    expect(plan.roots).toEqual(["photos (3)"]);
    expect(plan.files.map((entry) => entry.folderKey)).toEqual(["photos (3)", "photos (3)/sub"]);
    expect(planFolderUpload([file("Attachments/a.txt")], ["Attachments"]).roots).toEqual(["Attachments (2)"]);
  });

  test("two dropped folders become two top folders", () => {
    const plan = planFolderUpload([file("A/x.txt"), file("B/y.txt"), file("A/z.txt")], []);
    expect(plan.roots).toEqual(["A", "B"]);
    expect(plan.folders.map((folder) => folder.key)).toEqual(["A", "B"]);
  });

  test("operating-system clutter is skipped and counted", () => {
    const plan = planFolderUpload([file("Docs/.DS_Store"), file("Docs/Thumbs.db"), file("Docs/._a.pdf"), file("Docs/a.pdf"), file("Docs/desktop.ini")], []);
    expect(plan.skipped).toBe(4);
    expect(plan.files.map((entry) => entry.name)).toEqual(["a.pdf"]);
    expect(isSystemClutter(".gitignore")).toBe(false);
  });

  test("folder names are made safe", () => {
    const plan = planFolderUpload([file("Re\u202eport\u0007s/\u200b /a.txt"), file("../../etc/b.txt")], []);
    expect(plan.folders.map((folder) => folder.name)).toEqual(["Reports", UNTITLED_FOLDER, "etc"]);
    expect(plan.files.map((entry) => entry.path)).toEqual([`Reports/${UNTITLED_FOLDER}/a.txt`, "etc/b.txt"]);
  });

  test("files deeper than the depth limit are listed as failed, the rest upload", () => {
    const deep = `${Array.from({ length: FOLDER_UPLOAD_MAX_DEPTH + 1 }, (_, index) => `L${index + 1}`).join("/")}/deep.txt`;
    const edge = `${Array.from({ length: FOLDER_UPLOAD_MAX_DEPTH }, (_, index) => `L${index + 1}`).join("/")}/edge.txt`;
    const plan = planFolderUpload([file(deep), file(edge)], []);
    expect(plan.files.map((entry) => entry.name)).toEqual(["edge.txt"]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0].reason).toBe(`In a folder more than ${FOLDER_UPLOAD_MAX_DEPTH} levels deep`);
    expect(Math.max(...plan.folders.map((folder) => folder.depth))).toBe(FOLDER_UPLOAD_MAX_DEPTH);
  });

  test("an upload over the file cap is refused as a whole, and the cap itself is allowed", () => {
    const at = (count: number) => Array.from({ length: count }, (_, index) => file(`Big/f${index}.txt`));
    expect(planFolderUpload(at(FOLDER_UPLOAD_MAX_FILES), []).error).toBeNull();
    const over = planFolderUpload(at(FOLDER_UPLOAD_MAX_FILES + 1), []);
    expect(over.error).toContain("at most 1,000 files; this one has 1,001");
    expect(over.folders).toEqual([]);
    expect(over.files).toEqual([]);
    // Clutter does not count toward the cap.
    expect(planFolderUpload([...at(FOLDER_UPLOAD_MAX_FILES), file("Big/.DS_Store")], []).error).toBeNull();
  });

  test("an upload that would create too many folders is refused as a whole", () => {
    const entries = Array.from({ length: FOLDER_UPLOAD_MAX_FOLDERS }, (_, index) => file(`Root/s${index}/a.txt`));
    const over = planFolderUpload(entries, []);
    expect(over.error).toContain("at most 200 folders; this one has 201");
    expect(over.folders).toEqual([]);
    expect(planFolderUpload(entries.slice(1), []).error).toBeNull();
  });

  test("safe names and de-duplication stay within 120 characters", () => {
    expect(safeFolderName("  a \t  b  ")).toBe("a b");
    expect(safeFolderName("a/b\\c")).toBe("a-b-c");
    expect(safeFolderName("..")).toBe(UNTITLED_FOLDER);
    expect(safeFolderName("\u0000\u0001")).toBe(UNTITLED_FOLDER);
    expect(Array.from(safeFolderName("😀".repeat(200)))).toHaveLength(FOLDER_NAME_MAX);
    const long = "x".repeat(FOLDER_NAME_MAX);
    const unique = uniqueFolderName(long, [long]);
    expect(unique.length).toBe(FOLDER_NAME_MAX);
    expect(unique.endsWith(" (2)")).toBe(true);
    expect(uniqueFolderName("New", [])).toBe("New");
  });

  test("the summary toast", () => {
    expect(folderUploadSummary(["Photos"], { done: 118, failed: 2, canceled: 0, skipped: 1 })).toBe("Folder “Photos”: 118 of 120 files uploaded, 2 failed, 1 system file skipped");
    expect(folderUploadSummary(["A", "B"], { done: 1, failed: 0, canceled: 0, skipped: 0 })).toBe("2 folders: 1 of 1 file uploaded");
  });

  test("a folder chooser's files carry their relative paths", () => {
    const chosen = new File(["x"], "a.txt");
    Object.defineProperty(chosen, "webkitRelativePath", { value: "Docs/sub/a.txt" });
    const loose = new File(["y"], "b.txt");
    expect(chosenFolderFiles([chosen, loose]).map((entry) => entry.path)).toEqual(["Docs/sub/a.txt", "b.txt"]);
  });
});

type FakeEntry = { isFile: boolean; isDirectory: boolean; name: string; fullPath: string; file?: (ok: (file: File) => void, fail?: (error: unknown) => void) => void; createReader?: () => { readEntries: (ok: (entries: FakeEntry[]) => void) => void } };
const fileEntry = (fullPath: string, readable = true): FakeEntry => ({
  isFile: true, isDirectory: false, name: fullPath.split("/").at(-1)!, fullPath,
  file: (ok, fail) => readable ? ok(new File(["x"], fullPath.split("/").at(-1)!)) : fail?.(new Error("gone"))
});
// readEntries hands out at most two entries per call, as browsers page them (100 at a time).
const dirEntry = (fullPath: string, children: FakeEntry[]): FakeEntry => ({
  isFile: false, isDirectory: true, name: fullPath.split("/").at(-1)!, fullPath,
  createReader: () => {
    let at = 0;
    return { readEntries: (ok) => { const batch = children.slice(at, at + 2); at += batch.length; ok(batch); } };
  }
});

describe("dragged folders", () => {
  test("walks every page of every folder and keeps loose files apart", async () => {
    const tree = dirEntry("/Photos", [fileEntry("/Photos/a.jpg"), fileEntry("/Photos/b.jpg"), dirEntry("/Photos/2024", [fileEntry("/Photos/2024/c.jpg")]), fileEntry("/Photos/d.jpg"), fileEntry("/Photos/bad.jpg", false)]);
    const result = await readDroppedEntries([tree, fileEntry("/loose.txt")] as never);
    expect(result.folders.map((entry) => entry.path)).toEqual(["Photos/a.jpg", "Photos/b.jpg", "Photos/2024/c.jpg", "Photos/d.jpg"]);
    expect(result.files.map((entry) => entry.name)).toEqual(["loose.txt"]);
    expect(result).toMatchObject({ folderCount: 1, unreadable: 1, overflow: false });
  });

  test("stops reading once the file cap is passed", async () => {
    const tree = dirEntry("/Big", Array.from({ length: 8 }, (_, index) => fileEntry(`/Big/f${index}.txt`)));
    const result = await readDroppedEntries([tree] as never, 3);
    expect(result.overflow).toBe(true);
    expect(result.folders.length).toBe(4);
  });

  test("a drop without folders (or without the entry API) is left to the plain file path", () => {
    const item = (entry: FakeEntry) => ({ kind: "file", webkitGetAsEntry: () => entry });
    expect(droppedEntries({ items: [item(fileEntry("/a.txt"))] } as never)).toBeNull();
    expect(droppedEntries({ items: [{ kind: "file" }] } as never)).toBeNull();
    expect(droppedEntries(null)).toBeNull();
    expect(droppedEntries({ items: [item(fileEntry("/a.txt")), item(dirEntry("/D", []))] } as never)).toHaveLength(2);
  });
});

describe("the queue for folder uploads", () => {
  test("refused files enter as final failures that never start or retry; the batch ends when all have an outcome", () => {
    let state = uploadQueueReducer(emptyUploadQueue, { type: "enqueue", uploads: [
      { id: "a", key: "ka", name: "a.txt", size: 1, folderId: "f1", label: "Docs/a.txt", batch: "b1" },
      { id: "deep", key: "kd", name: "deep.txt", size: 1, folderId: null, label: "Docs/1/2/deep.txt", batch: "b1", rejected: "In a folder more than 10 levels deep" }
    ] });
    expect(state.items.map((item) => [item.status, item.final, item.error])).toEqual([["queued", false, null], ["failed", true, "In a folder more than 10 levels deep"]]);
    expect(canRetryUpload(state.items[1])).toBe(false);
    expect(uploadsToStart(state).map((item) => item.id)).toEqual(["a"]);
    expect(finishedBatch(state, "b1")).toBeNull();
    state = uploadQueueReducer(uploadQueueReducer(state, { type: "start", id: "a" }), { type: "succeed", id: "a", documentId: "d" });
    expect(finishedBatch(state, "b1")).toEqual({ done: 1, failed: 1, canceled: 0 });
    expect(finishedBatch(state, "other")).toBeNull();
  });
});

describe("subfolders in the sidebar", () => {
  test("children follow their parent with a depth; unknown parents and loops still list every folder once", () => {
    const folders = [
      { id: "default", parent_id: null }, { id: "child", parent_id: "photos" }, { id: "photos", parent_id: null },
      { id: "grand", parent_id: "child" }, { id: "orphan", parent_id: "gone" }, { id: "loop1", parent_id: "loop2" }, { id: "loop2", parent_id: "loop1" }
    ];
    expect(nestFolders(folders).map(({ folder, depth }) => `${folder.id}:${depth}`)).toEqual(["default:0", "photos:0", "child:1", "grand:2", "orphan:0", "loop1:0", "loop2:1"]);
  });
});
