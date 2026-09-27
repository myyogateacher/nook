import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { avatarTone, CardFace, cardFaceLabel, initials } from "../src/tasks/CardFace";
import type { BoardColumn, BoardTag, CardSummary } from "../src/tasks/tasksApi";

const noop = () => undefined;
const column: BoardColumn = { id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: 0, wip_limit: null, created_at: "", updated_at: "" };
const tag = (id: string, name: string, color: BoardTag["color"] = "gray"): BoardTag => ({ id, board_id: "b1", name, color, card_count: 1 });
const tags = [tag("t1", "Backend", "blue"), tag("t2", "Bug", "red"), tag("t3", "Design", "purple"), tag("t4", "Ops"), tag("t5", "QA", "green")];
const person = (id: string, display_name: string, can_read: 0 | 1 = 1) => ({ id, display_name, can_read });
const base: CardSummary = {
  id: "k1", board_id: "b1", column_id: "c1", position: 1024, title: "Fix login", has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, due_time: null, due_tz: null, due_at: null, assignees: [], assignee_id: null, assignee_name: null, description_excerpt: "", tag_ids: [], flags: [],
  relation_count: 0, open_blockers: 0, comment_count: 0, attachment_count: 0, created_at: "", updated_at: ""
};
const today = "2026-03-05";
const full: CardSummary = {
  ...base,
  flags: ["urgent", "needs_review"],
  description_excerpt: "Users on Safari see a blank page after the redirect.",
  has_description: 1,
  due_on: "2026-03-06",
  tag_ids: ["t2", "t1", "t3", "t4", "t5"],
  assignees: [person("u1", "Asha Rao"), person("u2", "Ben"), person("u3", "Chen Li"), person("u4", "Dee", 0)],
  comment_count: 2,
  attachment_count: 1,
  relation_count: 3,
  open_blockers: 1
};

test("initials and avatar tones", () => {
  expect(initials("Asha Rao")).toBe("AR");
  expect(initials("  ben  ")).toBe("B");
  expect(initials("Mary Ann van Dyke")).toBe("MD");
  expect(initials("Élodie")).toBe("É");
  expect(initials("")).toBe("?");
  expect(avatarTone("u1")).toBe(avatarTone("u1"));
  expect(avatarTone("u1")).toBeGreaterThanOrEqual(0);
  expect(avatarTone("u1")).toBeLessThan(6);
});

test("the accessible name reads flags, due, every tag, every assignee, and the counts in order", () => {
  expect(cardFaceLabel({ card: full, tags, done: false, today })).toBe(
    "Fix login, urgent, needs review, due tomorrow, tags Bug, Backend, Design, Ops, and QA, assigned to Asha Rao, Ben, Chen Li, and Dee, 2 comments, 1 attachment, 3 related cards, blocked by 1 open card"
  );
  expect(cardFaceLabel({ card: { ...base, tag_ids: ["t1"], assignees: [person("u1", "Asha"), person("u2", "Ben")] }, tags, done: false, today })).toBe("Fix login, tag Backend, assigned to Asha and Ben");
  // A done column shows no due date; a tag the board lost is not read.
  expect(cardFaceLabel({ card: { ...base, due_on: "2026-03-01", tag_ids: ["gone"] }, tags, done: true, today })).toBe("Fix login");
  expect(cardFaceLabel({ card: { ...base, due_on: "2026-03-01" }, tags, done: false, today })).toMatch(/^Fix login, overdue, was due /);
});

test("the face shows flags, the excerpt, three tag chips then +N, the counts, and three avatars then +N", () => {
  const markup = renderToStaticMarkup(<CardFace card={full} tags={tags} done={false} today={today} excerptId="ex" />);
  expect(markup.startsWith('<div class="task-card-face" aria-hidden="true">')).toBe(true);
  expect(markup).toContain('title="Urgent"><svg');
  expect(markup).toContain("task-flag-icon flag-urgent");
  expect(markup).toContain("task-flag-icon flag-needs_review");
  expect(markup).not.toContain("flag-blocked");
  expect(markup).toContain('<span id="ex" class="task-card-excerpt">Users on Safari see a blank page after the redirect.</span>');
  expect(markup).toContain('class="task-due-chip soon" title="Due tomorrow"');
  const chips = [...markup.matchAll(/class="task-tag color-(\w+)" title="([^"]+)"/g)].map((match) => `${match[2]}:${match[1]}`);
  expect(chips).toEqual(["Bug:red", "Backend:blue", "Design:purple"]);
  expect(markup).toContain('title="Ops, QA">+2</span>');
  expect(markup).toContain('title="2 comments"');
  expect(markup).toContain('title="3 related cards"');
  expect(markup).toContain('title="Blocked by 1 open card"');
  // The excerpt stands in for the "has a description" icon.
  expect(markup).not.toContain("Has a description");
  expect(markup).toContain('title="Assigned to Asha Rao, Ben, and 2 others"');
  expect([...markup.matchAll(/class="task-avatar tone-\d( former)?">(\w+)</g)].map((match) => match[2])).toEqual(["AR", "B", "CL"]);
  expect(markup).toContain('class="task-avatar task-avatar-more">+1</span>');
});

test("a bare card shows only its title; a description without an excerpt keeps the icon", () => {
  expect(renderToStaticMarkup(<CardFace card={base} tags={tags} done={false} today={today} excerptId="ex" />))
    .toBe('<div class="task-card-face" aria-hidden="true"><span class="task-card-title">Fix login</span></div>');
  const imageOnly = renderToStaticMarkup(<CardFace card={{ ...base, has_description: 1 }} tags={tags} done={false} today={today} excerptId="ex" />);
  expect(imageOnly).toContain('title="Has a description"');
  expect(imageOnly).not.toContain("task-card-excerpt");
  // An older payload without the Wave 13 fields still renders.
  const legacy = renderToStaticMarkup(<CardFace card={{ ...base, description_excerpt: undefined, tag_ids: undefined, flags: undefined, assignees: undefined }} tags={[]} done={false} today={today} excerptId="ex" />);
  expect(legacy).toContain('<span class="task-card-title">Fix login</span>');
  expect(legacy).not.toContain("task-avatar");
});

test("lane cards are named groups described by their excerpt, with the Move button outside the hidden face", () => {
  const markup = renderToStaticMarkup(<BoardColumnView column={column} cards={[{ ...full, due_on: "2999-01-01" }, { ...base, id: "k2", title: "Plain" }]} tags={tags} owner={false} isFirst isLast draggingId={null} dropIndex={null}
    onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={async () => undefined} />);
  expect(markup).toContain('role="group" aria-label="Fix login, urgent, needs review, due ');
  expect(markup).toContain('aria-describedby="task-card-excerpt-k1 task-card-keys"');
  expect(markup).toContain('id="task-card-excerpt-k1"');
  expect(markup).toContain('aria-label="Plain" aria-roledescription="Draggable card" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight" aria-describedby="task-card-keys"');
  expect(markup).toContain('</div><button class="icon-button task-card-more" aria-haspopup="dialog" aria-label="More actions for “Fix login”"');
});
