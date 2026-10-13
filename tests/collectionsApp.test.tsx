import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TODAY_APPS } from "../src/today/todayApps";
import { binFolderLabel, binItemLabel, filterBinItems } from "../src/bin/binFormat";
import type { BinItem } from "../src/types";
import { CellEditor } from "../src/collections/cells";
import { CollectionCards } from "../src/collections/CollectionCards";
import { CollectionList, CollectionListRow } from "../src/collections/CollectionList";
import type { CollectionRow, CollectionSummary, FieldDefinition } from "../src/collections/collectionsApi";
import { fromDrafts, moveDraft, newFieldDraft, toDrafts, typeChoices, validateDrafts } from "../src/collections/fieldDrafts";
import { importButtonLabel } from "../src/collections/ImportDialog";
import { RowPanel } from "../src/collections/RowPanel";
import { SortFilterSheet } from "../src/collections/SortFilterSheet";
import { FieldEditor } from "../src/collections/FieldEditor";
import { allowedTypeChanges, cardFields, collectionBinMessage, defaultFilterValue, displayValue, filterReady, parseInput, submitOnEnter, validateCollectionName } from "../src/collections/values";

const fields: FieldDefinition[] = [
  { id: "f_aaaaaaaa", name: "Name", type: "text", required: true },
  { id: "f_bbbbbbbb", name: "Price", type: "number", number: { decimals: 2, unit: "EUR" } },
  { id: "f_cccccccc", name: "When", type: "date" },
  { id: "f_dddddddd", name: "Kind", type: "select", options: [{ id: "o_aaaaaa", label: "Book", color: "blue" }] },
  { id: "f_eeeeeeee", name: "Tags", type: "multi_select", options: [{ id: "o_bbbbbb", label: "x", color: "gray" }, { id: "o_cccccc", label: "y", color: "red" }] },
  { id: "f_ffffffff", name: "Note", type: "note" },
  { id: "f_gggggggg", name: "Site", type: "url" },
  { id: "f_hhhhhhhh", name: "Done", type: "checkbox" }
];
const row = (values: CollectionRow["values"], links: CollectionRow["links"] = {}): CollectionRow => ({
  id: "r", collection_id: "c", position: 1, title: String(values.f_aaaaaaaa ?? ""), values, links, revision: 1, can_undo: false,
  created_by: null, created_by_name: null, updated_by_name: null, updated_via_key_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"
});

test("Today's launcher has a Collections entry", () => {
  expect(TODAY_APPS.find((app) => app.section === "collections")).toMatchObject({ label: "Collections", href: "/collections" });
});

test("the collection list starts with its loading state and a New collection action", () => {
  const markup = renderToStaticMarkup(<CollectionList onOpen={() => undefined} onOpenRow={() => undefined} notify={() => undefined} />);
  expect(markup).toContain("Loading collections…");
  expect(markup).toContain(">New collection</button>");
  expect(markup).toContain('<h1 id="collections-title">Collections</h1>');
});

test("owned collection rows offer Rename, Share, and Move to Bin; shared rows show the owner instead", () => {
  const summary: CollectionSummary = {
    id: "c_1", name: "Pantry", icon: "table", owner_id: "u_1", owner_name: "Asha", is_owner: 1, role: "owner", visibility: "private", share_role: "viewer",
    row_count: 3, field_count: 2, template_id: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"
  };
  const owned = renderToStaticMarkup(<CollectionListRow collection={summary} onOpen={() => undefined} onAction={() => undefined} />);
  expect(owned).toContain('class="collection-list-actions"');
  expect(owned).toContain('aria-label="Rename Pantry" title="Rename"');
  expect(owned).toContain('aria-label="Share Pantry" title="Share"');
  expect(owned).toContain('aria-label="Delete Pantry" title="Move to the Bin"');
  expect(owned.match(/aria-haspopup="dialog"/g)?.length).toBe(3);
  expect(owned).not.toContain("owner-badge");
  const shared = renderToStaticMarkup(<CollectionListRow collection={{ ...summary, is_owner: 0, role: "editor" }} onOpen={() => undefined} onAction={() => undefined} />);
  expect(shared).not.toContain("collection-list-actions");
  expect(shared).toContain('<span class="owner-badge">Asha</span>');
  expect(collectionBinMessage(summary)).toBe("Move “Pantry” and its 3 rows to the Bin? Everyone it is shared with loses access. You can restore it for 30 days.");
});

test("header actions whose label phones hide keep an accessible name", async () => {
  const css = await Bun.file(new URL("../src/collections/collections.css", import.meta.url)).text();
  expect(css).toContain(".collection-action span { display: none; }");
  const source = await Bun.file(new URL("../src/collections/CollectionView.tsx", import.meta.url)).text();
  const buttons = source.split("\n").filter((line) => /<button[^\n]*className="[^"]*collection-action/.test(line));
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  for (const button of buttons) expect(button).toMatch(/aria-label="[^"]+"/);
  expect(buttons.some((button) => button.includes('aria-label="Fields"'))).toBe(true);
});

test("collection list actions get 44 px hit areas on phones", async () => {
  const css = await Bun.file(new URL("../src/collections/collections.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.collection-list-actions \.icon-button \{ width: 44px; height: 44px; \}/);
});

test("values display per type and parse the way the server validates them", () => {
  const sample = row({ f_aaaaaaaa: "Mug", f_bbbbbbbb: 3.5, f_cccccccc: "2024-02-29", f_dddddddd: "o_aaaaaa", f_eeeeeeee: ["o_cccccc", "o_bbbbbb"], f_ffffffff: "n", f_gggggggg: "https://example.test/", f_hhhhhhhh: true }, { f_ffffffff: { id: "n", restricted: true } });
  expect(displayValue(fields[1]!, sample, "en-US")).toBe("3.50 EUR");
  expect(displayValue(fields[2]!, sample, "en-US")).toBe("Feb 29, 2024");
  expect(displayValue(fields[3]!, sample)).toBe("Book");
  expect(displayValue(fields[4]!, sample)).toBe("y, x");
  expect(displayValue(fields[5]!, sample)).toBe("Restricted note");
  expect(displayValue(fields[6]!, sample)).toBe("example.test");
  expect(displayValue(fields[7]!, sample)).toBe("Yes");
  expect(cardFields(fields, sample).map((field) => field.name)).toEqual(["Price", "When", "Kind"]);
  expect(cardFields(fields, row({ f_aaaaaaaa: "only", f_hhhhhhhh: true })).map((field) => field.name)).toEqual(["Done"]);
  expect(parseInput(fields[1]!, " 1,200.5 ")).toEqual({ ok: true, value: 1200.5 });
  expect(parseInput(fields[1]!, "12abc").ok).toBe(false);
  expect(parseInput(fields[1]!, "")).toEqual({ ok: true, value: null });
  expect(parseInput(fields[2]!, "2023-02-29").ok).toBe(false);
  expect(parseInput(fields[6]!, "javascript:alert(1)").ok).toBe(false);
  expect(validateCollectionName("  Pantry ")).toEqual({ ok: true, name: "Pantry", changed: true });
  expect(validateCollectionName("x".repeat(121)).ok).toBe(false);
  expect(allowedTypeChanges("select")).toEqual(["select", "multi_select"]);
  expect(allowedTypeChanges("number")).toEqual(["number"]);
});

test("viewers get read-only cells and editors get inputs", () => {
  const sample = row({ f_aaaaaaaa: "Mug", f_dddddddd: "o_aaaaaa" });
  const readOnly = renderToStaticMarkup(<CellEditor field={fields[0]!} row={sample} editable={false} onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(readOnly).not.toContain("<input");
  expect(readOnly).toContain("Mug");
  const editable = renderToStaticMarkup(<CellEditor field={fields[0]!} row={sample} editable onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(editable).toContain('<input class="cell-input cell-text"');
  const select = renderToStaticMarkup(<CellEditor field={fields[3]!} row={sample} editable onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(select).not.toContain("<select");
  expect(select).toMatch(/class="ui-select ui-select-cell cell-select" role="combobox"[^>]*aria-label="[^"]+"/);
  expect(select).toContain('<span class="ui-option-swatch color-');
  // Multi-line text is edited in the row panel, never in a single-line input that drops line breaks.
  const multiline = renderToStaticMarkup(<CellEditor field={fields[0]!} row={row({ f_aaaaaaaa: "a\nb" })} editable onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(multiline).not.toContain("<input");
});

test("phone cards show the primary field and up to three more, with 44 px actions", () => {
  const sample = row({ f_aaaaaaaa: "Mug", f_bbbbbbbb: 3.5, f_cccccccc: "2024-02-29", f_dddddddd: "o_aaaaaa", f_gggggggg: "https://example.test/" });
  const markup = renderToStaticMarkup(<CollectionCards fields={fields} rows={[sample]} editable conflicts={{}} onOpenRow={() => undefined} onRowActions={() => undefined} onReloadRow={() => undefined} onAdd={async () => true} />);
  expect(markup).toContain('<span class="collection-card-title">Mug</span>');
  expect([...markup.matchAll(/class="collection-card-field"/g)]).toHaveLength(3);
  expect(markup).not.toContain("example.test");
  expect(markup).toContain('aria-label="Actions for Mug"');
  const viewer = renderToStaticMarkup(<CollectionCards fields={fields} rows={[sample]} editable={false} conflicts={{}} onOpenRow={() => undefined} onRowActions={() => undefined} onReloadRow={() => undefined} />);
  expect(viewer).not.toContain("New row");
});

test("the row panel labels one editor per field and shows View only to viewers", () => {
  const collection = { id: "c", name: "Things", icon: "table", owner_id: "o", owner_name: "O", is_owner: 0 as const, role: "viewer" as const, visibility: "all_users" as const, share_role: "viewer" as const, row_count: 1, field_count: fields.length, template_id: null, created_at: "", updated_at: "", fields, schema_version: 1 };
  const sample = row({ f_aaaaaaaa: "Mug" });
  const props = { collection, rowId: "r", listed: sample, conflict: null, save: async () => null, onAcceptConflict: () => undefined, onActions: () => undefined, onClose: () => undefined, onMissing: () => undefined };
  const viewer = renderToStaticMarkup(<RowPanel {...props} editable={false} />);
  expect(viewer).toContain("View only");
  expect(viewer).not.toContain("<input");
  const editor = renderToStaticMarkup(<RowPanel {...props} editable />);
  expect(editor).not.toContain("View only");
  expect([...editor.matchAll(/class="row-field-label"/g)]).toHaveLength(fields.length);
  expect(editor).toContain('aria-labelledby="row-field-f_aaaaaaaa"');
  expect(editor).toContain("<textarea");
});

test("the row panel's checkbox sits in a 44 px label that its field name also toggles", () => {
  const collection = { id: "c", name: "Things", icon: "table", owner_id: "o", owner_name: "O", is_owner: 1 as const, role: "owner" as const, visibility: "private" as const, share_role: "viewer" as const, row_count: 1, field_count: fields.length, template_id: null, created_at: "", updated_at: "", fields, schema_version: 1 };
  const props = { collection, rowId: "r", listed: row({ f_aaaaaaaa: "Mug", f_hhhhhhhh: true }), conflict: null, save: async () => null, onAcceptConflict: () => undefined, onActions: () => undefined, onClose: () => undefined, onMissing: () => undefined };
  const editor = renderToStaticMarkup(<RowPanel {...props} editable />);
  expect(editor).toContain('<label class="row-field-label" id="row-field-f_hhhhhhhh" for="row-field-f_hhhhhhhh-input">');
  expect(editor).toContain('<label class="cell-checkbox-target"><input type="checkbox" id="row-field-f_hhhhhhhh-input"');
  // The table keeps its bare checkbox.
  const cell = renderToStaticMarkup(<CellEditor field={fields[7]!} row={row({ f_hhhhhhhh: true })} editable onSave={async () => true} onOpenPicker={() => undefined} />);
  expect(cell).not.toContain("cell-checkbox-target");
});

test("Enter in the New row input submits its form, except while composing", () => {
  let submitted = 0;
  const form = { requestSubmit: () => { submitted += 1; } } as unknown as HTMLFormElement;
  const press = (key: string, isComposing = false) => {
    let prevented = false;
    submitOnEnter({ key, nativeEvent: { isComposing }, preventDefault: () => { prevented = true; }, currentTarget: { form } });
    return prevented;
  };
  expect(press("Enter")).toBe(true);
  expect(press("Enter", true)).toBe(false);
  expect(press("a")).toBe(false);
  expect(submitted).toBe(1);
  const markup = renderToStaticMarkup(<CollectionCards fields={fields} rows={[]} editable conflicts={{}} onOpenRow={() => undefined} onRowActions={() => undefined} onReloadRow={() => undefined} onAdd={async () => true} />);
  expect(markup).toContain('<form class="collection-quick-add collection-card-add" noValidate="">');
  expect(markup).not.toMatch(/New row Name"[^>]*disabled/);
});

test("filters are sent only when complete", () => {
  expect(filterReady(fields[1], { op: "gt", value: 3 })).toBe(true);
  expect(filterReady(fields[1], { op: "gt" })).toBe(false);
  expect(filterReady(fields[1], { op: "contains", value: "3" })).toBe(false);
  expect(filterReady(fields[0], { op: "empty" })).toBe(true);
  expect(filterReady(fields[0], { op: "contains", value: "  " })).toBe(false);
  expect(filterReady(fields[3], { op: "in", value: [] })).toBe(false);
  expect(filterReady(fields[4], { op: "has_all", value: ["o_bbbbbb"] })).toBe(true);
  expect(filterReady(fields[7], { op: "is", value: false })).toBe(true);
  expect(defaultFilterValue(fields[7]!, "is")).toBe(true);
  expect(defaultFilterValue(fields[3]!, "in")).toEqual([]);
  expect(defaultFilterValue(fields[0]!, "empty")).toBeUndefined();
});

test("the Bin labels collections and rows and filters them together", () => {
  const base = { folder_id: null, size_bytes: null, deleted_at: "2026-01-01T00:00:00.000Z", purge_after: "2026-01-31T00:00:00.000Z", purging: false };
  const items: BinItem[] = [
    { ...base, type: "collection", id: "c", title: "Recipes", folder_name: null },
    { ...base, type: "collection_row", id: "r", title: "", folder_name: "Recipes", can_purge: false },
    { ...base, type: "note", id: "n", title: "Note", folder_name: null }
  ];
  expect(filterBinItems(items, "collections").map((item) => item.id)).toEqual(["c", "r"]);
  expect(filterBinItems(items, "note").map((item) => item.id)).toEqual(["n"]);
  expect(binFolderLabel(items[0]!)).toBe("Collections");
  expect(binFolderLabel(items[1]!)).toBe("Recipes");
  expect(binFolderLabel(items[2]!)).toBe("Default");
  expect(binItemLabel(items[1]!)).toBe("Untitled row");
  expect(binItemLabel({ type: "collection", title: " " })).toBe("Untitled collection");
});

test("field drafts mirror the schema rules and build the PUT body", () => {
  const drafts = toDrafts(fields);
  expect(validateDrafts(drafts)).toBeNull();
  expect(typeChoices(drafts[0]!, ["text", "number"])).toEqual(["text", "url"]);
  expect(typeChoices(newFieldDraft(), ["text", "number"])).toEqual(["text", "number"]);
  expect(validateDrafts(moveDraft(drafts, 1, -1))).toContain("first field");
  expect(validateDrafts([...drafts, { ...newFieldDraft(), name: "name" }])).toContain("Two fields");
  expect(validateDrafts([...drafts, { ...newFieldDraft("select", "S"), options: [{ key: "1", label: "a", color: "gray" }, { key: "2", label: "A", color: "red" }] }])).toContain("two options");
  expect(validateDrafts([])).toBe("Keep at least one field");
  const body = fromDrafts([...drafts, { ...newFieldDraft("number", " Weight "), decimals: 9, unit: " kilograms" }]);
  expect(body[0]).toEqual({ id: "f_aaaaaaaa", name: "Name", type: "text", required: true });
  expect(body[3]!.options).toEqual([{ id: "o_aaaaaa", label: "Book", color: "blue" }]);
  expect(body.at(-1)).toEqual({ name: "Weight", type: "number", number: { decimals: 6, unit: "kilogram" } });
  expect(moveDraft([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  expect(moveDraft([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
});

test("small Collections controls get 44 px hit areas on phones without growing", async () => {
  const css = await Bun.file(new URL("../src/collections/collections.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(phone).toMatch(/\.sort-filter-options label::after, \.collection-reload::after, \.field-editor-check::after \{[^}]*width: max\(100%, 44px\); height: max\(100%, 44px\);/);
  expect(phone).toMatch(/\.sort-filter-options label, \.collection-reload, \.field-editor-check \{ position: relative; \}/);
  // The visible sizes stay as they are.
  expect(css).toMatch(/\.field-editor-check input \{ min-height: 0; width: 16px; height: 16px;/);
  expect(css).toMatch(/\.collection-reload \{ min-height: 28px;/);
});

test("the import button names the problems to fix instead of a row count it cannot import", () => {
  expect(importButtonLabel(null, false)).toBe("Import");
  expect(importButtonLabel({ valid: 1, errorCount: 0 }, false)).toBe("Import 1 row");
  expect(importButtonLabel({ valid: 4, errorCount: 0 }, false)).toBe("Import 4 rows");
  expect(importButtonLabel({ valid: 1, errorCount: 1 }, false)).toBe("Fix 1 problem to import");
  expect(importButtonLabel({ valid: 1, errorCount: 3 }, false)).toBe("Fix 3 problems to import");
  expect(importButtonLabel({ valid: 1, errorCount: 3 }, true)).toBe("Working…");
});

test("the sort and filter sheet and the field editor use custom dropdowns (D91)", () => {
  const noop = () => undefined;
  const sheet = renderToStaticMarkup(<SortFilterSheet fields={fields} onApply={noop} onClose={noop}
    value={{ sort: [{ fieldId: "f_bbbbbbbb", direction: "desc" }], filters: [{ fieldId: "f_dddddddd", op: "is", value: "o_aaaaaa" }, { fieldId: "f_hhhhhhhh", op: "is", value: false }], hiddenFieldIds: [] }} />);
  expect(sheet).not.toContain("<select");
  for (const label of ["Sort 1 field", "Sort 1 direction", "Filter 1 field", "Filter 1 condition", "Filter 1 value", "Filter 2 value"]) {
    expect(sheet).toMatch(new RegExp(`role="combobox"[^>]*aria-label="${label}"`));
  }
  expect(sheet).toContain('<span class="ui-select-value">Descending</span>');
  expect(sheet).toContain('<span class="ui-select-value">Book</span>');
  expect(sheet).toContain('<span class="ui-select-value">Not checked</span>');
  const collection = { id: "c", name: "Things", fields, schema_version: 1 } as unknown as Parameters<typeof FieldEditor>[0]["collection"];
  const editor = renderToStaticMarkup(<FieldEditor collection={collection} onSaved={noop} onReload={noop} onClose={noop} />);
  expect(editor).not.toContain("<select");
  // A number field has one type choice, so its type select keeps the disabled state.
  expect(editor).toMatch(/role="combobox"[^>]*aria-label="Field 2 type"[^>]*disabled=""/);
  expect(editor).not.toMatch(/aria-label="Field 1 type" disabled=""/);
  expect(editor).toMatch(/class="ui-select ui-select-compact" role="combobox"[^>]*aria-label="Color of Book"/);
});
