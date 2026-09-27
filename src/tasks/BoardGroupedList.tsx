import { useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { Select } from "../ui/Select";
import { GROUP_DIMENSIONS, type BoardCard, type BoardData, type BoardGroup } from "./boardQuery";
import { BOARD_GROUPS, type BoardGroupId } from "./boardUrl";
import { assigneeNames, Avatars, DueChip, FlagIcons, TagChips } from "./boardViewParts";
import { cardCountLabel } from "./taskActions";

type BoardGroupedListProps = {
  board: BoardData;
  groups: BoardGroup[];
  group: BoardGroupId;
  today: string;
  /** Replaces the current history entry (§4.7). */
  onGroup: (group: BoardGroupId) => void;
  onOpenCard: (card: BoardCard) => void;
  onCardMenu: (card: BoardCard, trigger: HTMLElement) => void;
  filtered: boolean;
};

/**
 * The grouped list view (§4.5): collapsible sections with a count, grouped by column, assignee,
 * tag, flag, or due date. A card with two assignees or tags is listed in each group, marked
 * "also in …". Rows are full width with 44 px targets.
 */
export function BoardGroupedList({ board, groups, group, today, onGroup, onOpenCard, onCardMenu, filtered }: BoardGroupedListProps) {
  // Collapsed sections, per grouping; not part of the URL.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const columns = new Map(board.columns.map((column) => [column.id, column]));
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(`${group}:${key}`)) next.delete(`${group}:${key}`);
    else next.add(`${group}:${key}`);
    return next;
  });
  const empty = groups.every((item) => item.items.length === 0);

  return <div className="task-grouped">
    <div className="task-grouped-bar">
      <span id="task-group-label">Group by</span>
      <Select<BoardGroupId> variant="chip" label="Group by" labelledBy="task-group-label" value={group} onChange={onGroup}
        options={BOARD_GROUPS.filter((id) => id !== "parent" || group === "parent" || (board.structure?.levels.length ?? 1) > 1).map((id) => ({ value: id, label: GROUP_DIMENSIONS[id].label }))} searchable={false} />
    </div>
    {empty && <p className="task-view-empty">{filtered ? "No cards match these filters." : "No cards yet. Add one with New card."}</p>}
    {groups.map((section) => {
      if (empty && section.items.length === 0) return null;
      const isCollapsed = collapsed.has(`${group}:${section.key}`);
      const headingId = `task-group-${group}-${section.key}`;
      return <section key={section.key} className="task-group" aria-labelledby={headingId}>
        <h3 id={headingId}>
          <button type="button" className="task-group-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(section.key)}>
            {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            <span className="task-group-name">{section.label}</span>
            <span className="task-group-count" aria-label={cardCountLabel(section.items.length)}>{section.items.length}</span>
          </button>
        </h3>
        {!isCollapsed && (section.items.length
          ? <ul className="task-group-list">
            {section.items.map(({ card, also }) => {
              const column = columns.get(card.column_id);
              const names = assigneeNames(card);
              return <li key={card.id} className={`task-group-row${column?.is_done === 1 ? " done" : ""}`} data-card-id={card.id}>
                <button type="button" className="task-group-open" onClick={() => onOpenCard(card)} data-open-card={card.id}>
                  <span className="task-group-title"><FlagIcons flags={card.flags} /><span>{card.title}</span></span>
                  {card.description_excerpt && <span className="task-group-excerpt">{card.description_excerpt}</span>}
                  <span className="task-group-meta">
                    {group !== "column" && <span className="task-group-column">{column?.name}</span>}
                    <DueChip card={card} today={today} done={column?.is_done === 1} />
                    <TagChips tagIds={card.tag_ids} board={board} max={2} />
                    {names.length > 0 && group !== "assignee" && <span className="task-group-people" title={names.join(", ")}><Avatars card={card} /><span className="sr-only">Assigned to {names.join(", ")}</span></span>}
                    {also.length > 0 && <span className="task-group-also">also in {also.join(", ")}</span>}
                  </span>
                </button>
                <button type="button" className="icon-button task-group-more" onClick={(event) => onCardMenu(card, event.currentTarget)} aria-haspopup="dialog" aria-label={`More actions for “${card.title}”`} title="More actions"><Ellipsis /></button>
              </li>;
            })}
          </ul>
          : <p className="task-group-empty">No cards</p>)}
      </section>;
    })}
  </div>;
}
