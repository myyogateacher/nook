import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { CardDialog } from "../src/tasks/CardDialog";
import type { CardHierarchyContext } from "../src/tasks/useBoardHierarchy";
import type { BoardColumn, BoardTag, CardDetail, CardSummary, CardView, SprintSummary } from "../src/tasks/tasksApi";
import { RoleContext } from "../src/team/roleAccess";
import type { Role } from "../src/team/teamRoles";

/**
 * Read-only Team roles in the card dialog and page (Wave 15 review M2): viewers and guests see the
 * card's values as text, with no Move, Delete, Add, Remove, Attach, or comment composer, since the
 * write gate refuses every one of those writes (403 ROLE_READ_ONLY).
 */

const noop = () => undefined;
const stamp = "2026-01-01T00:00:00Z";
const columns: BoardColumn[] = [
  { id: "c1", board_id: "b1", name: "To do", position: 1024, is_done: 0, created_at: stamp, updated_at: stamp },
  { id: "c2", board_id: "b1", name: "Done", position: 2048, is_done: 1, created_at: stamp, updated_at: stamp }
];
const summary = (id: string, title: string, level: number, parent: string | null): CardSummary => ({
  id, board_id: "b1", column_id: "c1", position: 1024, title, has_description: 0, revision: 1, created_by: "u1", creator_name: "Ann",
  due_on: null, comment_count: 0, attachment_count: 0, created_at: stamp, updated_at: stamp, level, parent_card_id: parent
});
const epic = summary("e1", "Checkout epic", 0, null);
const child = summary("s1", "Write the refund subtask", 2, "k1");
const card: CardDetail = {
  ...summary("k1", "Refund flow", 1, "e1"), revision: 3, description: "Some **notes**",
  due_on: "2999-01-01", assignees: [{ id: "u2", display_name: "Bo", can_read: 1 }], tag_ids: ["t1"], flags: ["urgent"], sprint_id: "sp1",
  comment_count: 1, attachment_count: 1
};
const tags: BoardTag[] = [{ id: "t1", board_id: "b1", name: "Payments", color: "blue", card_count: 1 } as BoardTag];
const sprints: SprintSummary[] = [{ id: "sp1", board_id: "b1", name: "Sprint 12", goal: "", start_on: null, end_on: null, state: "active", is_active: true, position: 1024,
  completed_at: null, card_count: 1, done_count: 0, created_at: stamp, updated_at: stamp }];
const view: CardView = {
  card,
  comments: [{ id: "m1", card_id: "k1", author_id: "u1", author_name: "Ann", is_author: 1, body: "Looks good", created_at: stamp, edited_at: null }],
  hasMoreComments: false,
  attachments: [{ document_id: "d1", card_id: "k1", comment_id: null, linked_by: "u1", linker_name: "Ann", name: "spec.pdf", mime_type: "application/pdf", preview_kind: "none", size_bytes: 10, created_at: stamp } as CardView["attachments"][number]],
  relations: [{ id: "r1", type: "relates_to", restricted: false, created_at: stamp, creator_name: "Ann",
    card: { id: "k9", board_id: "b1", board_name: "Board", title: "Related card", column_name: "To do", is_done: 0, due_on: null } }]
};
const hierarchy: CardHierarchyContext = {
  structure: { levels: [{ name: "Epic", plural: "Epics" }, { name: "Story", plural: "Stories" }, { name: "Subtask", plural: "Subtasks" }], workLevel: 1, sprints: true },
  cards: [epic, card, child], columns, openCard: noop, setChildDone: async () => undefined, addChild: async () => true, composeChild: noop, detachChild: async () => undefined
};

const as = (role: Role | undefined, node: ReactNode) => renderToStaticMarkup(<RoleContext.Provider value={role}>{node}</RoleContext.Provider>);
const dialog = (role: Role | undefined, layout: "dialog" | "page" = "dialog") => as(role, <CardDialog userId="u1" cardId="k1" columns={columns} boardOwner
  onClose={noop} onMissing={noop} onChanged={noop} onMove={noop} onDelete={async () => undefined} notify={noop} tags={tags}
  hierarchy={hierarchy} sprints={sprints} layout={layout} onExpand={noop} onCollapse={noop} initialView={view} />);

const writeControls = [
  'aria-label="Card title"', 'aria-label="Move card"', 'aria-label="Delete card"', ">Add with details<", ">Add relation<",
  'aria-label="Remove the link to Related card"', 'type="checkbox"', 'aria-label="Add subtask"', "Remove from parent",
  'class="task-due-trigger', '-assignees"', ">Edit<", ">Attach<", 'aria-label="Remove spec.pdf"',
  'aria-label="Edit comment"', 'aria-label="Delete comment"', 'aria-label="Write a comment"', ">Comment<", 'aria-label="Level"', 'aria-label="Sprint"'
];

test("members see the card's write controls (the baseline the read-only render removes)", () => {
  const markup = dialog("member");
  for (const control of ['aria-label="Card title"', 'aria-label="Move card"', 'aria-label="Delete card"', ">Add with details<", ">Add relation<",
    'type="checkbox"', ">Attach<", 'aria-label="Write a comment"', 'aria-label="Edit comment"', 'class="task-due-trigger', '-assignees"',
    'aria-label="Remove spec.pdf"', 'aria-label="Remove the link to Related card"', 'aria-label="Add subtask"']) expect({ control, found: markup.includes(control) }).toEqual({ control, found: true });
  expect(markup).not.toContain("View only");
});

for (const role of ["viewer", "guest"] as const) {
  test(`a ${role} reads the card as text, with the View only hint and no write controls`, () => {
    for (const layout of ["dialog", "page"] as const) {
      const markup = dialog(role, layout);
      for (const control of writeControls) expect({ layout, control, found: markup.includes(control) }).toEqual({ layout, control, found: false });
      expect(markup).toContain("View only");
      expect(markup).toContain('class="task-card-title-static"');
      expect(markup).toContain("Refund flow");
      // The values are still there, as text.
      for (const value of ["2999-01-01", "Bo", "Payments", "Urgent", "Checkout epic", "Story", "Sprint 12", "Related card", "Write the refund subtask", "spec.pdf", "Looks good"]) {
        expect({ layout, value, found: markup.includes(value) }).toEqual({ layout, value, found: true });
      }
      // Reading stays: related cards and subtasks open, attachments download, the page expands and collapses.
      expect(markup).toContain('aria-label="Download spec.pdf"');
      expect(markup).toContain('class="task-subtask-title"');
      expect(markup).toContain(layout === "page" ? 'aria-label="Collapse to a dialog"' : 'aria-label="Open as page"');
    }
  });
}
