import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { popStateClosedDialog, registerHistoryDialogGuard } from "../src/historyDialogs";
import { CardFields } from "../src/tasks/CardFields";
import { applyCardDetail, applyTagChange, cardTags, deleteTagMessage, mergeCardDetail, recountTags, sortTags, toggleFlag, upsertTag, visibleItems } from "../src/tasks/cardTags";
import { FlagPicker, ManageTagsDialog, TagPicker } from "../src/tasks/TagPicker";
import { validateTagName } from "../src/tasks/taskActions";
import type { BoardDetail, BoardTag, CardDetail } from "../src/tasks/tasksApi";
import { createDialogGuard } from "../src/tasks/useHistoryDialogGuard";

const noop = () => undefined;
const tag = (id: string, name: string, color: BoardTag["color"] = "gray", card_count = 0): BoardTag => ({ id, board_id: "b1", name, color, card_count });
const tags = [tag("t1", "Backend", "blue", 2), tag("t2", "bug", "red", 1), tag("t3", "Design", "purple")];
const card: CardDetail = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Fix login", has_description: 0, revision: 3, created_by: "u1", creator_name: "Ann",
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, tag_ids: [], flags: [], description_excerpt: "",
  comment_count: 0, attachment_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", description: ""
};

test("flags toggle in the fixed order and tags resolve in tagging order", () => {
  expect(toggleFlag([], "on_hold")).toEqual(["on_hold"]);
  expect(toggleFlag(["on_hold"], "urgent")).toEqual(["urgent", "on_hold"]);
  expect(toggleFlag(["urgent", "blocked"], "urgent")).toEqual(["blocked"]);
  // A tag the board no longer has (deleted meanwhile) is skipped.
  expect(cardTags(["t3", "gone", "t1"], tags).map((item) => item.name)).toEqual(["Design", "Backend"]);
  expect(cardTags(undefined, tags)).toEqual([]);
  expect(visibleItems([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], more: 2 });
  expect(visibleItems([1], 3)).toEqual({ shown: [1], more: 0 });
});

test("tag names follow the server rules, and the list stays in name order", () => {
  expect(validateTagName("  Backend ")).toEqual({ ok: true, name: "Backend", changed: true });
  expect(validateTagName("   ").ok).toBe(false);
  expect(validateTagName("x".repeat(41))).toEqual({ ok: false, error: "Use at most 40 characters." });
  expect(validateTagName("a‮b").ok).toBe(false);
  expect(validateTagName("Bug", "Bug")).toEqual({ ok: true, name: "Bug", changed: false });
  expect(sortTags(tags).map((item) => item.name)).toEqual(["Backend", "bug", "Design"]);
  expect(upsertTag(tags, tag("t4", "api")).map((item) => item.name)).toEqual(["api", "Backend", "bug", "Design"]);
  expect(upsertTag(tags, tag("t2", "Zeta", "green")).map((item) => `${item.name}:${item.color}`)).toEqual(["Backend:blue", "Design:purple", "Zeta:green"]);
  expect(deleteTagMessage({ name: "bug", card_count: 1 })).toBe("Delete “bug” for everyone on this board? It is removed from 1 card. This cannot be undone.");
  expect(deleteTagMessage({ name: "bug", card_count: 0 })).toContain("No card uses it.");
});

test("a deleted tag leaves the board and every lane card; a saved card updates its lane card and the counts", () => {
  const detail: BoardDetail = {
    board: { id: "b1", name: "B", owner_id: "u1", owner_name: "Ann", is_owner: 1, visibility: "private", card_count: 2, created_at: "", updated_at: "" },
    columns: [],
    cards: [{ ...card, tag_ids: ["t1", "t2"] }, { ...card, id: "k2", tag_ids: ["t1"] }],
    tags
  };
  const deleted = applyTagChange(detail, { kind: "deleted", tagId: "t1" });
  expect(deleted.tags!.map((item) => item.id)).toEqual(["t2", "t3"]);
  expect(deleted.cards.map((item) => item.tag_ids)).toEqual([["t2"], []]);
  expect(applyTagChange(detail, { kind: "saved", tag: tag("t9", "Alpha") }).tags![0]!.name).toBe("Alpha");

  const saved = applyCardDetail(detail, { ...card, column_id: "elsewhere", title: "Renamed", tag_ids: ["t2", "t3"], flags: ["urgent"], description: "Hi", description_excerpt: "Hi", revision: 4 });
  const lane = saved.cards[0]!;
  expect([lane.title, lane.column_id, lane.has_description, lane.description_excerpt, lane.revision]).toEqual(["Renamed", "c1", 1, "Hi", 4]);
  expect(lane.tag_ids).toEqual(["t2", "t3"]);
  expect(lane.flags).toEqual(["urgent"]);
  expect(saved.tags!.map((item) => `${item.id}:${item.card_count}`)).toEqual(["t1:1", "t2:1", "t3:1"]);
  expect(recountTags(tags, ["t1"], ["t1"])).toBe(tags);
  // An older payload without the Wave 13 fields keeps what the lane card had.
  expect(mergeCardDetail({ ...card, tag_ids: ["t1"], flags: ["blocked"] }, { ...card, tag_ids: undefined, flags: undefined }).tag_ids).toEqual(["t1"]);
});

test("the tag picker is a multiple combobox with coloured chips, and only the owner manages tags", () => {
  const reader = renderToStaticMarkup(<TagPicker boardId="b1" inputId="t-tags" tags={tags} tagIds={["t2", "gone", "t1"]} owner={false} disabled={false} onCommit={async () => undefined} onTagsChange={noop} />);
  expect(reader).toContain('id="t-tags"');
  expect(reader).toContain('role="combobox" aria-autocomplete="list"');
  expect(reader).toContain('class="ui-chip color-red"');
  expect(reader).toContain('aria-label="Remove bug"');
  expect(reader).toContain('aria-label="Remove Backend"');
  expect(reader.indexOf("Remove bug")).toBeLessThan(reader.indexOf("Remove Backend"));
  expect(reader).not.toContain("gone");
  expect(reader).not.toContain("Manage tags");
  expect(reader).not.toContain("<select");
  const owner = renderToStaticMarkup(<TagPicker boardId="b1" inputId="t-tags" tags={tags} tagIds={[]} owner disabled={false} onCommit={async () => undefined} onTagsChange={noop} />);
  expect(owner).toContain('aria-haspopup="dialog">Manage tags…</button>');
  // "+ New tag" sits beside Manage tags for every reader and opens the same flow in the field.
  expect(reader).toMatch(/<button type="button" class="task-add-time" aria-controls="t-tags"><svg[^>]*>[\s\S]*?<\/svg>New tag<\/button>/);
  expect(owner.indexOf("New tag")).toBeLessThan(owner.indexOf("Manage tags"));
  const full = renderToStaticMarkup(<TagPicker boardId="b1" inputId="t-tags" tags={Array.from({ length: 12 }, (_, index) => tag(`x${index}`, `Tag ${index}`))} tagIds={Array.from({ length: 10 }, (_, index) => `x${index}`)} owner={false} disabled={false} onCommit={async () => undefined} onTagsChange={noop} />);
  expect(full).toContain("A card can have up to 10 tags.");
});

test("flags are four toggle buttons with aria-pressed in the fixed order", () => {
  const markup = renderToStaticMarkup(<FlagPicker labelId="t-flags" flags={["blocked"]} disabled={false} onCommit={async () => undefined} />);
  expect(markup).toContain('role="group" aria-labelledby="t-flags"');
  const pressed = [...markup.matchAll(/aria-pressed="(true|false)"[^>]*>(?:<svg[\s\S]*?<\/svg>)([^<]+)</g)].map((match) => `${match[2]}:${match[1]}`);
  expect(pressed).toEqual(["Urgent:false", "Blocked:true", "Needs review:false", "On hold:false"]);
});

test("the manage dialog lists each tag with its colour, name, count, and delete", () => {
  const markup = renderToStaticMarkup(<ManageTagsDialog tags={tags} onChange={noop} onClose={noop} />);
  expect(markup).toContain('role="dialog" aria-modal="true"');
  expect(markup).toContain(">Manage tags</h2>");
  expect(markup).toContain('aria-label="Colour of Backend"');
  expect(markup).toContain('class="ui-option-swatch color-blue"');
  expect(markup).toContain('maxLength="40" aria-label="Name of Backend" value="Backend"');
  expect(markup).toContain(">2 cards</small>");
  expect(markup).toContain('aria-label="Delete Design"');
  expect(markup).not.toContain("<select");
  expect(renderToStaticMarkup(<ManageTagsDialog tags={[]} onChange={noop} onClose={noop} />)).toContain("No tags yet.");
});

test("card fields add Tags when the board's tags are known, and Flags always", () => {
  const withTags = renderToStaticMarkup(<CardFields card={{ ...card, tag_ids: ["t1"], flags: ["urgent"] }} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} tags={tags} owner={false} onTagsChange={noop} />);
  expect(withTags).toContain('<label for="t-tags">');
  expect(withTags).toContain('aria-label="Remove Backend"');
  expect(withTags).toContain('id="t-flags"');
  expect(withTags).toContain('aria-pressed="true"');
  const without = renderToStaticMarkup(<CardFields card={card} userId="u1" idPrefix="t" done={false} saving={false} onSave={async () => true} />);
  expect(without).not.toContain('for="t-tags"');
  expect(without).toContain('id="t-flags"');
});

test("Back closes the colour sheet, then Manage tags, then reaches the card's own guard", () => {
  // Registered in this order when the owner opens Manage tags, then a colour sheet on a phone.
  let cardAsked = 0;
  const unregisterCard = registerHistoryDialogGuard(() => { cardAsked += 1; return true; });
  const layer = (closed: string[], name: string) => {
    let open = true;
    return registerHistoryDialogGuard(createDialogGuard({
      isOpen: () => open, markClosed: () => { open = false; }, close: () => { closed.push(name); }, openDepth: () => 2, undo: noop
    }));
  };
  const closed: string[] = [];
  const unregisterManage = layer(closed, "manage");
  const unregisterSheet = layer(closed, "colour sheet");
  expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
  expect(closed).toEqual(["colour sheet"]);
  unregisterSheet();
  expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
  expect(closed).toEqual(["colour sheet", "manage"]);
  expect(cardAsked).toBe(0);
  unregisterManage();
  expect(popStateClosedDialog({ state: { "mynotes.depth": 1 } })).toBe(true);
  expect(cardAsked).toBe(1);
  unregisterCard();
});
