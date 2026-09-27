import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { boardData } from "../src/tasks/boardQuery";
import { TagChips } from "../src/tasks/boardViewParts";
import { CardFace } from "../src/tasks/CardFace";
import { termSwatches } from "../src/tasks/FilterBar";
import { TagPicker } from "../src/tasks/TagPicker";
import { TAG_COLORS, type BoardTag, type CardSummary } from "../src/tasks/tasksApi";

// Tags read by their colour everywhere (operator QA 0.9.1): the picker's rows and chips, the lane
// card, the table and list chips, and the filter bar, with text at least 4.5:1 on its fill.

const tag = (id: string, name: string, color: BoardTag["color"]): BoardTag => ({ id, board_id: "b1", name, color, card_count: 1 });
const tags = [tag("t1", "jakarta", "teal"), tag("t2", "minal", "pink")];
const card: CardSummary = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Fix login", has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, description_excerpt: "", tag_ids: ["t1", "t2"], flags: [],
  relation_count: 0, open_blockers: 0, comment_count: 0, attachment_count: 0, created_at: "", updated_at: ""
};
const colours = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].map((match) => match[1]);

test("two tags with different colours render in their colours on the lane card, table and list chips, and the picker", () => {
  const face = renderToStaticMarkup(<CardFace card={card} tags={tags} done={false} today="2026-03-05" excerptId="ex" />);
  expect(colours(face, /class="task-tag color-(\w+)"/g)).toEqual(["teal", "pink"]);
  const chips = renderToStaticMarkup(<TagChips tagIds={["t2", "t1"]} board={boardData({ columns: [], cards: [], tags })} />);
  expect(colours(chips, /class="task-tag color-(\w+)"/g)).toEqual(["pink", "teal"]);
  const picker = renderToStaticMarkup(<TagPicker boardId="b1" inputId="t-tags" tags={tags} tagIds={["t1", "t2"]} owner={false} disabled={false} onCommit={async () => undefined} onTagsChange={() => undefined} />);
  expect(colours(picker, /class="ui-chip color-(\w+)"/g)).toEqual(["teal", "pink"]);
});

test("a tag filter chip shows each tag's colour before its words", () => {
  const board = boardData({ columns: [], cards: [], tags });
  const markup = renderToStaticMarkup(<>{termSwatches(["t2", "jakarta", "gone"], board)}</>);
  expect(markup).toBe('<span class="task-filter-swatches" aria-hidden="true"><span class="ui-option-swatch color-pink"></span><span class="ui-option-swatch color-teal"></span></span>');
  expect(termSwatches(["none"], board)).toBeNull();
});

// WCAG relative luminance and contrast.
const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test("every tag colour's text is at least 4.5:1 on its fill and on the dark card", () => {
  const css = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
  for (const color of TAG_COLORS) {
    const rule = new RegExp(`\\.tasks-app \\.color-${color} \\{ --tag-bg: (#[0-9a-f]{6}); --tag-fg: (#[0-9a-f]{6}); \\}`).exec(css);
    expect(rule, color).not.toBeNull();
    const [, bg, fg] = rule!;
    expect(contrast(fg!, bg!), `${color} text on its fill`).toBeGreaterThanOrEqual(4.5);
    // The lane card (#1a1a1d) and the dialog behind a chip: the bullet and text stand out there too.
    expect(contrast(fg!, "#1a1a1d"), `${color} on the card`).toBeGreaterThanOrEqual(4.5);
  }
  // The bullet, fill, and border are drawn in the tag's tones.
  expect(css).toContain('.task-tag[class*="color-"] { border: 1px solid color-mix(in srgb, var(--tag-fg) 40%, transparent); background: var(--tag-bg); color: var(--tag-fg); }');
  expect(css).toMatch(/\.tasks-app \.ui-chip\[class\*="color-"\]::before \{[^}]*background: currentColor;/);
  expect(css).toMatch(/\.task-tag\[class\*="color-"\]::before \{[^}]*background: currentColor;/);
});
