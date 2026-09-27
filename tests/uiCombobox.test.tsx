import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Combobox, comboboxRows, createRow, pickFocusTarget } from "../src/ui/Combobox";
import type { Option } from "../src/ui/Listbox";

const people: Option[] = [
  { value: "u1", label: "Ada Lovelace" },
  { value: "u2", label: "Grace Hopper" },
  { value: "u3", label: "Linus", disabled: true }
];
const noop = () => undefined;

test("an editable combobox with chips that are Remove buttons", () => {
  const markup = renderToStaticMarkup(<Combobox multiple value={["u1", "u2"]} onChange={noop} options={people} label="Assignees" />);
  expect(markup).toContain('type="text" role="combobox" aria-autocomplete="list" aria-expanded="false"');
  expect(markup).toContain('aria-label="Assignees"');
  expect(markup).toContain('aria-label="Remove Ada Lovelace"');
  expect(markup).toContain('aria-label="Remove Grace Hopper"');
  expect(markup).toContain('<span class="ui-chip-label">Ada Lovelace</span>');
  expect(markup).toContain('aria-live="polite"');
  expect(markup).not.toContain("<select");
});

test("the open list is multiselectable with checked options, and single mode is not", () => {
  const multi = renderToStaticMarkup(<Combobox multiple value={["u2"]} onChange={noop} options={people} label="Assignees" presentation="popup" defaultOpen />);
  expect(multi).toContain('role="listbox" aria-label="Assignees" aria-multiselectable="true"');
  expect(multi).toMatch(/role="option" aria-selected="true" class="ui-option selected"><span class="ui-option-copy"><span class="ui-option-label">Grace Hopper/);
  expect(multi).toMatch(/aria-disabled="true"[^>]*><span class="ui-option-copy"><span class="ui-option-label">Linus/);
  const single = renderToStaticMarkup(<Combobox value={[]} onChange={noop} options={people} label="Owner" presentation="popup" defaultOpen />);
  expect(single).not.toContain("aria-multiselectable");
});

test("maxSelected disables the options not chosen yet", () => {
  const markup = renderToStaticMarkup(<Combobox multiple maxSelected={1} value={["u1"]} onChange={noop} options={people} label="Assignees" presentation="popup" defaultOpen />);
  expect(markup).toMatch(/aria-selected="false" aria-disabled="true"[^>]*><span class="ui-option-copy"><span class="ui-option-label">Grace Hopper/);
  expect(markup).toMatch(/aria-selected="true" class="ui-option selected"><span class="ui-option-copy"><span class="ui-option-label">Ada Lovelace/);
});

test("selectedOptions label chips that the loaded options do not include", () => {
  const load = async () => [] as Option[];
  const markup = renderToStaticMarkup(<Combobox multiple value={["u9"]} onChange={noop} loadOptions={load} selectedOptions={[{ value: "u9", label: "Margaret Hamilton" }]} label="Assignees" />);
  expect(markup).toContain('aria-label="Remove Margaret Hamilton"');
  // Without a label the value itself is shown rather than nothing.
  expect(renderToStaticMarkup(<Combobox multiple value={["u9"]} onChange={noop} loadOptions={load} label="Assignees" />)).toContain("Remove u9");
});

test("onCreate offers a Create row only when nothing matches the text exactly", () => {
  expect(createRow("Urgent", [{ label: "urgent" }], true)).toBeNull();
  expect(createRow("  ", [], true)).toBeNull();
  expect(createRow("Bug", [{ label: "Bugfix" }], false)).toBeNull();
  const row = createRow("  Bug ", [{ label: "Bugfix" }], true);
  expect(row?.label).toBe("Create “Bug”");
  expect(row?.value).not.toBe("Bug");
});

test("the Create row leads the list, and Enter's first pick is the first match, else the Create row", () => {
  const create = createRow("Ba", [], true)!;
  const none = comboboxRows([], create);
  expect(none.shown.map((option) => option.label)).toEqual(["Create “Ba”"]);
  expect(none.firstActive).toBe(0);
  const some = comboboxRows([{ value: "t1", label: "Backend" }], createRow("Ba", [{ label: "Backend" }], true));
  expect(some.shown.map((option) => option.label)).toEqual(["Create “Ba”", "Backend"]);
  expect(some.firstActive).toBe(1);
  // Only disabled matches (the card is full would drop the row; here a disabled option): the Create row.
  expect(comboboxRows([{ value: "t1", label: "Backend", disabled: true }], create).firstActive).toBe(0);
  expect(comboboxRows([], null)).toEqual({ shown: [], firstActive: -1 });
  expect(comboboxRows(people, null).firstActive).toBe(0);
});

test("an open list with no options shows the hint row", () => {
  const markup = renderToStaticMarkup(<Combobox multiple value={[]} onChange={noop} options={[]} onCreate={async (label) => ({ value: label, label })} label="Tags" emptyText="Type a name to create a tag" presentation="popup" defaultOpen openOnFocus />);
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain('<div class="ui-listbox-empty" role="presentation">Type a name to create a tag</div>');
});

test("the phone sheet has a sticky search combobox, 44 px rows, and Done for several", () => {
  const markup = renderToStaticMarkup(<Combobox multiple value={["u1"]} onChange={noop} options={people} label="Assignees" presentation="sheet" defaultOpen />);
  expect(markup).toContain('role="dialog" aria-modal="true" aria-label="Assignees"');
  expect(markup).toContain('<div class="ui-search"><input');
  expect(markup).toContain(">Done</button>");
  // The field on the page only opens the sheet; the sheet's box is the one that types.
  expect(markup).toMatch(/readOnly=""|readonly=""/);
});

test("chip and option labels render as text (T98)", () => {
  const hostile: Option[] = [{ value: "x", label: '<img src=x onerror="alert(1)">' }];
  const markup = renderToStaticMarkup(<Combobox multiple value={["x"]} onChange={noop} options={hostile} label="Tags" presentation="popup" defaultOpen />);
  expect(markup).not.toContain("<img");
  expect(markup).toContain("Remove &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("a pointer pick that leaves focus outside moves it back into the combobox so Escape still closes it", () => {
  // The filter bar's value list opens on mount and the "+ Filter" trigger that had focus is gone.
  expect(pickFocusTarget(false, false)).toBe("field");
  expect(pickFocusTarget(true, false)).toBe("search");
  // The option's mousedown kept focus in the field or search box: leave it there.
  expect(pickFocusTarget(false, true)).toBeNull();
  expect(pickFocusTarget(true, true)).toBeNull();
});
