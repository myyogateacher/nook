import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ItemLevel } from "../src/access/accessLevels";
import { BoardCalendar } from "../src/tasks/BoardCalendar";
import { BoardColumnView } from "../src/tasks/BoardColumnView";
import { boardData } from "../src/tasks/boardQuery";
import { canChangeCard, type QueriedCard } from "../src/tasks/home/homeApi";
import { QueryResults } from "../src/tasks/home/QueryResults";
import { MoveCardSheet } from "../src/tasks/MoveCardSheet";
import { cardsReadOnly } from "../src/tasks/taskActions";
import type { BoardColumn, CardSummary } from "../src/tasks/tasksApi";
import { RoleContext } from "../src/team/roleAccess";
import type { Role } from "../src/team/teamRoles";

/**
 * QA v0.13.0 B2: people below Can edit on a board (viewers, commenters) and read-only Team roles
 * (viewer, guest) are offered no card-changing action — no Move, drag, Alt+Arrow, Add a card, or
 * due-date change — in board views and task views. The level comes from the server (`board.level`,
 * `board_level` on query results); commenters keep comments and reactions in the card dialog.
 */

const noop = () => undefined;
const column = (id: string, name: string): BoardColumn => ({ id, board_id: "b1", name, position: 1024, is_done: 0, created_at: "", updated_at: "" });
const card = (id: string, column_id: string, change: Partial<CardSummary> = {}): CardSummary => ({
  id, board_id: "b1", column_id, position: 1024, title: `Card ${id}`, has_description: 0, revision: 1, created_by: null, creator_name: null,
  due_on: null, comment_count: 0, attachment_count: 0, created_at: "", updated_at: "", ...change
});
const as = (role: Role | undefined, node: ReactNode) => renderToStaticMarkup(<RoleContext.Provider value={role}>{node}</RoleContext.Provider>);

const LEVELS: ItemLevel[] = ["view", "comment", "edit", "manage", "owner"];
const ROLES: Array<{ role: Role; readOnly: boolean }> = [{ role: "admin", readOnly: false }, { role: "member", readOnly: false }, { role: "viewer", readOnly: true }, { role: "guest", readOnly: true }];

test("cards are read-only below Can edit or for a read-only role, whatever the level", () => {
  for (const level of LEVELS) {
    for (const { role, readOnly } of ROLES) {
      const expected = readOnly || level === "view" || level === "comment";
      expect({ level, role, readOnly: cardsReadOnly(readOnly, level) }).toEqual({ level, role, readOnly: expected });
      expect({ level, role, change: canChangeCard({ board_level: level }, readOnly) }).toEqual({ level, role, change: !expected });
    }
  }
  // An older server sends no level: today's behaviour (every member edits, D38).
  expect(cardsReadOnly(false, undefined)).toBe(false);
  expect(canChangeCard({}, false)).toBe(true);
});

const renderColumn = (readOnly: boolean) => renderToStaticMarkup(<BoardColumnView column={column("todo", "To do")} cards={[card("a", "todo")]}
  owner={false} isFirst isLast draggingId={null} dropIndex={null} readOnly={readOnly}
  onDragStart={noop} onDragEnd={noop} onDragOverIndex={noop} onDropAt={noop} onKeyMove={noop} onCardMenu={noop} onOpenCard={noop} onColumnMenu={noop} onMoveColumn={noop} onAddCard={noop} />);

test("a board column per level: drag, Alt+Arrow, and Add a card only at Can edit and above", () => {
  for (const level of LEVELS) {
    const readOnly = cardsReadOnly(false, level);
    const markup = renderColumn(readOnly);
    const editable = level === "edit" || level === "manage" || level === "owner";
    expect({ level, drag: markup.includes('draggable="true"') }).toEqual({ level, drag: editable });
    expect({ level, keys: markup.includes("Alt+ArrowUp") }).toEqual({ level, keys: editable });
    expect({ level, add: markup.includes("Add a card") }).toEqual({ level, add: editable });
    // The ⋯ menu stays for Copy link.
    expect(markup).toContain("More actions for “Card a”");
  }
});

test("the card ⋯ menu offers Copy link but no Move when read-only", () => {
  const columns = [column("todo", "To do"), column("done", "Done")];
  const cards = [card("a", "todo")];
  const readOnly = renderToStaticMarkup(<MoveCardSheet card={cards[0]!} columns={columns} cards={cards} onMove={async () => undefined} onCancel={noop} onCopyLink={noop} readOnly />);
  expect(readOnly).toContain("Copy link");
  expect(readOnly).toContain("not move or change it");
  expect(readOnly).not.toContain('aria-label="Column"');
  expect(readOnly).not.toContain("Move to");
  const editable = renderToStaticMarkup(<MoveCardSheet card={cards[0]!} columns={columns} cards={cards} onMove={async () => undefined} onCancel={noop} onCopyLink={noop} />);
  expect(editable).toContain('aria-label="Column"');
});

test("the board calendar per level: no drag or Set due date below Can edit", () => {
  const todo = column("todo", "To do");
  const board = boardData({ columns: [todo], cards: [card("dated", "todo", { due_on: "2026-03-06" }), card("undated", "todo")] });
  for (const level of LEVELS) {
    const readOnly = cardsReadOnly(false, level);
    const markup = renderToStaticMarkup(<BoardCalendar board={board} cards={board.cards} layout="agenda" month={null} today="2026-03-02" viewerZone="UTC" filtered={false}
      onMonth={noop} onLayout={noop} onOpenCard={noop} onSetDue={noop} readOnly={readOnly} />);
    expect({ level, due: markup.includes("Set due date for") }).toEqual({ level, due: !readOnly });
    expect({ level, drag: markup.includes('draggable="true"') }).toEqual({ level, drag: !readOnly });
  }
});

const queried = (id: string, board_level?: ItemLevel): QueriedCard => ({
  id, board_id: "b1", board_name: "Web", column_id: "col", column_name: "Doing", column_state: "doing", is_done: 0, position: 1, title: `Card ${id}`,
  description_excerpt: "", revision: 1, created_by: null, creator_name: null, due_on: null, due_time: null, due_tz: null, due_at: null,
  assignees: [], tags: [], flags: [], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...(board_level ? { board_level } : {})
});

test("task view and My work results offer Move only on boards the caller can edit, and never to read-only roles", () => {
  for (const layout of ["list", "table", "board"] as const) {
    const cards = LEVELS.map((level) => queried(level, level));
    for (const { role, readOnly } of ROLES) {
      const markup = as(role, <QueryResults cards={cards} layout={layout} group="none" today="2026-09-27" userId="u1" nextCursor={null} loadingMore={false}
        onLoadMore={noop} onOpenCard={noop} onMoveCard={noop} emptyText="Nothing" />);
      for (const level of LEVELS) {
        const offered = !readOnly && (level === "edit" || level === "manage" || level === "owner");
        expect({ layout, role, level, move: markup.includes(`Move “Card ${level}”`) }).toEqual({ layout, role, level, move: offered });
      }
    }
  }
});
