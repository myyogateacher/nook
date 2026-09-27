import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { avatarTone, CardFace, cardFaceLabel, faceTagCount, FACE_FOOTER_PX, initials } from "../src/tasks/CardFace";
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

test("the face shows flags, the excerpt, the tags that fit then +N, the counts, and three avatars then +N", () => {
  const markup = renderToStaticMarkup(<CardFace card={full} tags={tags} done={false} today={today} excerptId="ex" />);
  expect(markup.startsWith('<div class="task-card-face" aria-hidden="true">')).toBe(true);
  expect(markup).toContain('title="Urgent"><svg');
  expect(markup).toContain("task-flag-icon flag-urgent");
  expect(markup).toContain("task-flag-icon flag-needs_review");
  expect(markup).not.toContain("flag-blocked");
  expect(markup).toContain('<span id="ex" class="task-card-excerpt">Users on Safari see a blank page after the redirect.</span>');
  expect(markup).toContain('class="task-due-chip soon" title="Due tomorrow"');
  // Due, four counts, and four avatars leave no room on the line for a whole tag: only "+5", named in full.
  expect(markup).not.toContain('class="task-tag ');
  expect(markup).toContain('title="Bug, Backend, Design, Ops, QA">+5</span>');
  const tagsOnly = renderToStaticMarkup(<CardFace card={{ ...base, tag_ids: full.tag_ids }} tags={tags} done={false} today={today} excerptId="ex" />);
  const chips = [...tagsOnly.matchAll(/class="task-tag color-(\w+)" title="([^"]+)"/g)].map((match) => `${match[2]}:${match[1]}`);
  expect(chips).toEqual(["Bug:red", "Backend:blue", "Design:purple"]);
  expect(tagsOnly).toContain('title="Ops, QA">+2</span>');
  expect(markup).toContain('title="2 comments"');
  expect(markup).toContain('title="3 related cards"');
  expect(markup).toContain('title="Blocked by 1 open card"');
  // The excerpt stands in for the "has a description" icon.
  expect(markup).not.toContain("Has a description");
  expect(markup).toContain('title="Assigned to Asha Rao, Ben, and 2 others"');
  expect([...markup.matchAll(/class="task-avatar tone-\d( former)?">(\w+)</g)].map((match) => match[2])).toEqual(["AR", "B", "CL"]);
  expect(markup).toContain('class="task-avatar task-avatar-more">+1</span>');
});

test("the face is three rows: flags inline in the title, the excerpt, and one footer with the chips left and the avatars right", () => {
  const markup = renderToStaticMarkup(<CardFace card={full} tags={tags} done={false} today={today} excerptId="ex" rollup={{ done: 1, total: 2 }} />);
  const rows = [...markup.matchAll(/<(?:span|div)[^>]*class="(task-card-title|task-card-excerpt|task-card-meta|task-card-flags)"/g)].map((match) => match[1]);
  expect(rows).toEqual(["task-card-title", "task-card-flags", "task-card-excerpt", "task-card-meta"]);
  expect(markup).toMatch(/<span class="task-card-title"><span class="task-card-flags">.*<\/span>Fix login<\/span>/);
  // Left cluster in order: due, tags, counts, subtask roll-up; the avatars are the footer's other child.
  const footer = markup.slice(markup.indexOf('class="task-card-meta"'));
  const order = ["task-due-chip", "task-card-tags", "Has a description", "2 comments", "task-subtask-chip", "task-card-people"].map((needle) => footer.indexOf(needle));
  expect(order.filter((at) => at >= 0)).toEqual(order.filter((at) => at >= 0).sort((a, b) => a - b));
  expect(footer).toMatch(/^class="task-card-meta"><span class="task-card-meta-main">.*<\/span><span class="task-card-people" /);
  // Avatars only: no empty left cluster.
  const onlyPeople = renderToStaticMarkup(<CardFace card={{ ...base, assignees: [person("u1", "Asha Rao")] }} tags={tags} done={false} today={today} excerptId="ex" />);
  expect(onlyPeople).not.toContain("task-card-meta-main");
  expect(onlyPeople).toContain('<span class="task-card-meta"><span class="task-card-people"');
  // Chips only: no people cluster.
  const onlyDue = renderToStaticMarkup(<CardFace card={{ ...base, due_on: "2026-03-06" }} tags={tags} done={false} today={today} excerptId="ex" />);
  expect(onlyDue).toContain("task-card-meta-main");
  expect(onlyDue).not.toContain("task-card-people");
});

test("the footer is one line (QA 0.9.2): whole tag chips while they fit beside the due chip, counts, and avatars, then +N", () => {
  // Measured in Chrome on a 280 px lane (238 px footer): "Tomorrow" 84.5, "qa92ga-backend" 109, "0/2" 32, one avatar 26.
  expect(FACE_FOOTER_PX).toBe(238);
  const qa = ["qa92ga-backend", "qa92ga-frontend", "qa92ga-release"];
  // The QA card: due, three long tags, a subtask count, one avatar. No whole tag fits: "+3", never "qa92ga…".
  expect(faceTagCount(qa, { due: "Tomorrow", counts: ["0/2"], people: 1 })).toBe(0);
  // Due "Today" and two long tags: one whole chip and "+1".
  expect(faceTagCount(qa.slice(0, 2), { due: "Today" })).toBe(1);
  // Short tags fit; never more than three.
  expect(faceTagCount(["Bug", "UI", "Ops"], { due: "Tomorrow", people: 1 })).toBe(1);
  expect(faceTagCount(["Bug", "UI", "Ops", "Design"], {})).toBe(3);
  expect(faceTagCount(["Bug", "UI"], {})).toBe(2);
  // A tag alone on the line always shows (the only case that may ellipsise); with anything else it may not fit.
  expect(faceTagCount(["x".repeat(40)], {})).toBe(1);
  expect(faceTagCount(["x".repeat(40)], { people: 1 })).toBe(0);
  expect(faceTagCount([], { due: "Today" })).toBe(0);
  // A wider footer fits more.
  expect(faceTagCount(qa, { due: "Tomorrow", counts: ["0/2"], people: 1 }, 480)).toBe(2);

  const qaTags = qa.map((name, index) => tag(`q${index}`, name, "blue"));
  const card = { ...base, due_on: "2026-03-06", tag_ids: ["q0", "q1", "q2"], assignees: [person("u1", "Qa Tester")] };
  const markup = renderToStaticMarkup(<CardFace card={card} tags={qaTags} done={false} today={today} excerptId="ex" rollup={{ done: 0, total: 2 }} />);
  expect(markup).not.toContain('class="task-tag ');
  expect(markup).toContain('<span class="task-card-more-tags" title="qa92ga-backend, qa92ga-frontend, qa92ga-release">+3</span>');
  // Every name stays in the accessible label.
  expect(cardFaceLabel({ card, tags: qaTags, done: false, today })).toContain("tags qa92ga-backend, qa92ga-frontend, and qa92ga-release");
});

test("the footer CSS keeps whole chips: centred on one line, no fixed tag max-width on the face", () => {
  const css = readFileSync(new URL("../src/tasks/tasks.css", import.meta.url), "utf8");
  expect(css).toContain(".task-card-meta { min-width: 0; display: flex; align-items: center;");
  expect(css).toContain(".task-card-meta .task-tag { flex: 0 1 auto; max-width: 100%;");
  expect(css).toContain(".task-card-meta .task-tag + .task-tag { flex: none; }");
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
