import { describe, expect, test } from "bun:test";
import { attachmentLabel, binFolderLabel, binItemLabel, binItemModule, binKindLabel, moduleFilters, daysUntilPurge, deleteForeverConfirm, emptiedMessage, emptyBinConfirm, filterBinItems, purgeCountdownLabel, restoredMessage, restoreResultMessage, subitemLabel } from "../src/bin/binFormat";
import type { BinItem } from "../src/types";

const DAY = 86_400_000;
const now = Date.parse("2026-09-25T12:00:00.000Z");
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

describe("Bin countdown", () => {
  test("a fresh deletion reads 30 days and partial days round up", () => {
    expect(daysUntilPurge(at(30 * DAY), now)).toBe(30);
    expect(daysUntilPurge(at(30 * DAY - 1000), now)).toBe(30);
    expect(daysUntilPurge(at(29 * DAY + 1), now)).toBe(30);
    expect(daysUntilPurge(at(29 * DAY), now)).toBe(29);
    expect(daysUntilPurge(at(1), now)).toBe(1);
  });

  test("due, overdue, and malformed dates never go negative", () => {
    expect(daysUntilPurge(at(0), now)).toBe(0);
    expect(daysUntilPurge(at(-5 * DAY), now)).toBe(0);
    expect(daysUntilPurge("not a date", now)).toBe(0);
  });

  test("labels use singular and plural forms and say soon when due", () => {
    expect(purgeCountdownLabel(at(30 * DAY), now)).toBe("Deletes in 30 days");
    expect(purgeCountdownLabel(at(DAY / 2), now)).toBe("Deletes in 1 day");
    expect(purgeCountdownLabel(at(-1), now)).toBe("Deletes soon");
  });
});

describe("Bin labels and copy", () => {
  const item = (type: BinItem["type"], extra: Partial<BinItem> = {}): BinItem => ({
    type, id: crypto.randomUUID(), title: "Plan", folder_id: null, folder_name: null, size_bytes: type === "document" ? 10 : null,
    deleted_at: at(0), purge_after: at(30 * DAY), purging: false, ...extra
  });

  test("the folder falls back to Default when the original is gone", () => {
    expect(binFolderLabel({ folder_name: "Projects" })).toBe("Projects");
    expect(binFolderLabel({ folder_name: null })).toBe("Default");
  });

  test("filters by type and keeps order", () => {
    const items = [item("document"), item("note"), item("document")];
    expect(filterBinItems(items, "all")).toEqual(items);
    expect(filterBinItems(items, "note")).toEqual([items[1]!]);
    expect(filterBinItems(items, "document")).toEqual([items[0]!, items[2]!]);
  });

  test("blank titles get a readable fallback", () => {
    expect(binItemLabel({ title: "  ", type: "note" })).toBe("Untitled note");
    expect(binItemLabel({ title: "", type: "document" })).toBe("Untitled file");
    expect(binItemLabel({ title: "Report.pdf", type: "document" })).toBe("Report.pdf");
  });

  test("confirmation and toast copy", () => {
    expect(deleteForeverConfirm("Plan")).toBe("Permanently delete “Plan”? This can't be undone.");
    expect(emptyBinConfirm(1)).toBe("Permanently delete 1 item in the Bin? This can't be undone.");
    expect(emptyBinConfirm(4)).toBe("Permanently delete 4 items in the Bin? This can't be undone.");
    expect(emptyBinConfirm(499)).toBe("Permanently delete 499 items in the Bin? This can't be undone.");
    expect(emptyBinConfirm(500)).toBe("Permanently delete all 500+ items in the Bin? This can't be undone.");
    expect(restoredMessage("Projects", "private")).toBe("Restored to Projects");
    expect(restoredMessage("Default", "all_users")).toBe("Restored to Default · shared with everyone");
    expect(restoredMessage("Team", "selected")).toBe("Restored to Team · shared with selected people");
    expect(emptiedMessage(3, 0)).toBe("3 items deleted forever");
    expect(emptiedMessage(1, 2)).toBe("1 item deleted forever. 2 still finishing.");
  });
});

describe("Tasks items in the Bin", () => {
  const card = { type: "card" as const, id: "k", title: "Ship it", folder_id: null, folder_name: null, size_bytes: null, deleted_at: "2026-01-02T00:00:00.000Z", purge_after: "2026-02-01T00:00:00.000Z", purging: false, board_id: "b", board_name: "Launch", attachment: false, can_purge: false };
  const board = { ...card, type: "board" as const, id: "b", title: "Launch", can_purge: true };
  const note = { ...card, type: "note" as const, id: "n", title: "A note", board_id: null, board_name: null, can_purge: true };
  const attachment = { ...note, type: "document" as const, id: "d", title: "shot.png", attachment: true };

  test("the Tasks filter shows cards and boards", () => {
    expect(filterBinItems([card, board, note, attachment], "tasks").map((item) => item.id)).toEqual(["k", "b"]);
    expect(filterBinItems([card, board, note, attachment], "document").map((item) => item.id)).toEqual(["d"]);
  });

  test("labels name the board, the kind, and the restore result", () => {
    expect(binFolderLabel(card)).toBe("Launch");
    expect(binFolderLabel(board)).toBe("Tasks");
    expect(binItemLabel({ type: "card", title: " " })).toBe("Untitled card");
    expect(binItemLabel({ type: "board", title: "" })).toBe("Untitled board");
    expect([card, board, note, attachment].map((item) => binKindLabel(item))).toEqual(["Card", "Board", "Note", "Card attachment"]);
    expect(restoreResultMessage(card, { ok: true, boardName: "Launch", columnName: "To do" })).toBe("Restored to To do on Launch");
    // A card tree (task hierarchy D129, D130).
    expect(restoreResultMessage(card, { ok: true, boardName: "Launch", columnName: "To do", descendantCount: 7 })).toBe("Restored to To do on Launch with 7 subitems");
    expect(restoreResultMessage(card, { ok: true, boardName: "Launch", columnName: "To do", descendantCount: 1, detached: true }))
      .toBe("Restored to To do on Launch with 1 subitem, without its parent (it is in the Bin)");
    expect([subitemLabel(1), subitemLabel(7)]).toEqual(["+ 1 subitem", "+ 7 subitems"]);
    expect(restoreResultMessage(board, { ok: true, boardName: "Launch" })).toBe("Restored the board “Launch”");
    expect(restoreResultMessage(board, { ok: true, boardName: "Launch", alreadyRestored: true })).toBe("The board “Launch” is already restored");
    expect(restoreResultMessage(note, { ok: true, folderName: "Projects", visibility: "private" })).toBe("Restored to Projects");
  });
});

test("a restored linked attachment returns to its card", () => {
  expect(restoreResultMessage({ type: "document", attachment: true }, { ok: true, folderId: null, folderName: null })).toBe("Restored to its card");
  expect(restoreResultMessage({ type: "document", attachment: true }, { ok: true, folderId: "f", folderName: "Default" })).toBe("Restored to Default");
});

test("attachment rows name their card while it exists", () => {
  expect(attachmentLabel({ attachment_of: "Ship it" })).toBe("Attachment of Ship it");
  expect(attachmentLabel({ attachment_of: null, attachment_kind: "card" })).toBe("Card attachment");
  expect(attachmentLabel({ attachment_of: null })).toBe("Card attachment · restores to Default");
});

test("row attachments name their row and only mention Default once nothing links them", () => {
  expect(attachmentLabel({ attachment_of: "Acme", attachment_kind: "row" })).toBe("Attachment of Acme");
  expect(attachmentLabel({ attachment_of: "", attachment_kind: "row" })).toBe("Attachment of Untitled row");
  expect(attachmentLabel({ attachment_of: null, attachment_kind: "row" })).toBe("Row attachment");
  expect(attachmentLabel({ attachment_of: null, attachment_kind: null, folder_name: null })).toBe("Attachment · restores to Default");
  expect(attachmentLabel({ attachment_of: null, attachment_kind: null, folder_name: "Work" })).toBe("Attachment · restores to Work");
  expect(binKindLabel({ type: "document", attachment: true, attachment_kind: "row" })).toBe("Row attachment");
  expect(restoreResultMessage({ type: "document", attachment: true, attachment_kind: "row" }, { ok: true, folderId: null, folderName: null })).toBe("Restored to its row");
});

describe("workspace-module items in the Bin (D1380)", () => {
  const item = (type: BinItem["type"], extra: Partial<BinItem> = {}) => ({ type, title: "", folder_name: null, ...extra }) as BinItem;

  test("each module kind reads its own name, never Item", () => {
    const kinds: Array<[BinItem["type"], string]> = [["form", "Form"], ["goal", "Goal"], ["checkin", "Standup"], ["contact_book", "Contact book"], ["contact", "Contact"], ["company", "Company"], ["deal", "Deal"], ["time_project", "Time project"], ["booking_type", "Booking type"], ["townhall_session", "Townhall session"]];
    for (const [type, label] of kinds) expect(binKindLabel(item(type))).toBe(label);
    expect(binItemLabel(item("deal"))).toBe("Untitled deal");
  });

  test("a module item restores to its module, and a record to its contact book", () => {
    expect(binFolderLabel(item("form", { folder_name: "Forms" }))).toBe("Forms");
    expect(binFolderLabel(item("contact_book"))).toBe("Contacts");
    expect(binFolderLabel(item("deal", { folder_name: "Sales" }))).toBe("Sales");
    expect(binFolderLabel(item("townhall_session"))).toBe("Townhall");
    expect(binFolderLabel(item("checkin"))).toBe("Standups");
  });

  test("module filters show only modules with items (plus the active one), in Settings order", () => {
    const items = [item("deal"), item("note"), item("form"), item("contact")];
    expect(binItemModule(item("note"))).toBeNull();
    expect(moduleFilters(items, "all")).toEqual(["forms", "crm"]);
    expect(moduleFilters(items, "module:townhall")).toEqual(["forms", "crm", "townhall"]);
    expect(filterBinItems(items, "module:crm").map((entry) => entry.type)).toEqual(["deal", "contact"]);
    expect(filterBinItems(items, "module:goals")).toEqual([]);
  });
});
