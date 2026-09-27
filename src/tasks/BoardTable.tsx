import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { levelName } from "../../shared/boardStructure";
import { parentTitleOf, structureOfData, treeRows, type BoardCard, type BoardData } from "./boardQuery";
import type { BoardSort, BoardSortField } from "./boardUrl";
import { assigneeNames, Avatars, DueChip, FlagIcons, shortTimestamp, TagChips } from "./boardViewParts";

type BoardTableProps = {
  board: BoardData;
  cards: BoardCard[];
  sort: BoardSort | null;
  today: string;
  /** Replaces the current history entry (sorting is not a view change, §4.7). */
  onSort: (sort: BoardSort | null) => void;
  onOpenCard: (card: BoardCard) => void;
  onCardMenu: (card: BoardCard, trigger: HTMLElement) => void;
  /** True when filters hide cards, for the empty state. */
  filtered: boolean;
};

const COLUMNS: Array<{ field: BoardSortField; label: string }> = [
  { field: "title", label: "Title" },
  { field: "column", label: "Column" },
  { field: "assignees", label: "Assignees" },
  { field: "due", label: "Due" },
  { field: "tags", label: "Tags" },
  { field: "flags", label: "Flags" },
  { field: "created", label: "Created" },
  { field: "updated", label: "Updated" }
];

/** Ascending, then descending, then back to board order. */
export function nextSort(current: BoardSort | null, field: BoardSortField): BoardSort | null {
  if (current?.field !== field) return { field, direction: "asc" };
  return current.direction === "asc" ? { field, direction: "desc" } : null;
}

/**
 * The table view (§4.5): sortable headers with `aria-sort`, 44 px rows, and a title button that
 * opens the card. At 390 px the table scrolls sideways inside its own labelled region with a
 * sticky title column; the page itself never scrolls sideways.
 */
export function BoardTable({ board, cards, sort, today, onSort, onOpenCard, onCardMenu, filtered }: BoardTableProps) {
  const columns = new Map(board.columns.map((column) => [column.id, column]));
  // Hierarchy (17A): unsorted, rows form a tree (children under their parent, ▸ to collapse); Level and Parent columns.
  const structure = structureOfData(board);
  const levels = structure.levels.length > 1;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = levels && !sort;
  const rows = tree ? treeRows(cards, collapsed) : cards.map((card) => ({ card, depth: 0, childCount: 0, descendantCount: 0 }));
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return <div className="task-table-region" role="region" aria-label="Cards table" tabIndex={0}>
    <table className="task-table">
      <thead>
        <tr>
          {COLUMNS.map((column) => {
            const active = sort?.field === column.field ? sort.direction : null;
            const Icon = active === "asc" ? ArrowUp : active === "desc" ? ArrowDown : ArrowUpDown;
            return <th key={column.field} scope="col" aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : "none"} className={`task-table-${column.field}`}>
              <button type="button" className={`task-table-sort${active ? " active" : ""}`} onClick={() => onSort(nextSort(sort, column.field))}>
                <span>{column.label}</span><Icon aria-hidden="true" />
              </button>
            </th>;
          })}
          {levels && <th scope="col" className="task-table-level">Level</th>}
          {levels && <th scope="col" className="task-table-parent">Parent</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ card, depth, childCount, descendantCount }) => {
          const column = columns.get(card.column_id);
          const done = column?.is_done === 1;
          const names = assigneeNames(card);
          return <tr key={card.id} className={done ? "done" : undefined} data-card-id={card.id}
            onClick={(event) => { if (!(event.target as Element).closest("button")) onOpenCard(card); }}>
            <th scope="row" className="task-table-title">
              <span className="task-table-title-cell" style={depth ? { paddingLeft: `${depth * 18}px` } : undefined}>
                {tree && (childCount > 0
                  ? <button type="button" className="icon-button task-tree-toggle" aria-expanded={!collapsed.has(card.id)} onClick={() => toggle(card.id)}
                    aria-label={`${collapsed.has(card.id) ? "Show" : "Hide"} the ${descendantCount} ${descendantCount === 1 ? "card" : "cards"} under “${card.title}”`}>
                    {collapsed.has(card.id) ? <ChevronRight /> : <ChevronDown />}
                  </button>
                  : <span className="task-tree-spacer" aria-hidden="true" />)}
                <button type="button" className="task-table-open" onClick={() => onOpenCard(card)} data-open-card={card.id} title={card.description_excerpt || undefined}>{card.title}</button>
                <button type="button" className="icon-button task-table-more" onClick={(event) => onCardMenu(card, event.currentTarget)} aria-haspopup="dialog" aria-label={`More actions for “${card.title}”`} title="More actions"><Ellipsis /></button>
              </span>
            </th>
            <td>{column?.name ?? ""}</td>
            <td className="task-table-people" title={names.join(", ")}>{names.length ? <><Avatars card={card} /><span className="task-table-names">{names.join(", ")}</span></> : <span className="task-table-empty">—</span>}</td>
            <td><DueChip card={card} today={today} done={done} /></td>
            <td><TagChips tagIds={card.tag_ids} board={board} max={2} /></td>
            <td><FlagIcons flags={card.flags} /></td>
            <td className="task-table-date">{shortTimestamp(card.created_at)}</td>
            <td className="task-table-date">{shortTimestamp(card.updated_at)}</td>
            {levels && <td>{levelName(structure, card.level ?? 0)}</td>}
            {levels && <td className="task-table-parent-cell" title={parentTitleOf(card, board) ?? undefined}>{parentTitleOf(card, board) ?? <span className="task-table-empty">—</span>}</td>}
          </tr>;
        })}
      </tbody>
    </table>
    {!cards.length && <p className="task-view-empty">{filtered ? "No cards match these filters." : "No cards yet. Add one with New card."}</p>}
  </div>;
}
