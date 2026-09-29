import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, Ellipsis, KanbanSquare } from "lucide-react";
import { Avatars, FlagIcons, shortTimestamp } from "../boardViewParts";
import type { BoardCard } from "../boardQuery";
import { cardCountLabel, dueStatus } from "../taskActions";
import { useRole } from "../../team/roleAccess";
import { canChangeCard, type QueriedCard } from "./homeApi";
import { groupResults, STATE_LABELS, stateLanes } from "./homeResults";
import type { HomeGroup, HomeLayout } from "./homeUrl";

type QueryResultsProps = {
  cards: QueriedCard[];
  layout: HomeLayout;
  group: HomeGroup;
  today: string;
  userId: string;
  total?: number;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenCard: (card: QueriedCard) => void;
  /** "Move to…" (Q9): there is no drag between state lanes or across boards. */
  onMoveCard: (card: QueriedCard, trigger: HTMLElement) => void;
  emptyText: string;
};

function Due({ card, today }: { card: QueriedCard; today: string }) {
  const due = dueStatus(card.due_on, today, card.is_done === 1, { dueAt: card.due_at });
  if (!due) return null;
  return <span className={`task-due-chip ${due.tone}`} title={due.description}><CalendarDays aria-hidden="true" /><span aria-hidden="true">{due.label}</span><span className="sr-only">{due.description}</span></span>;
}

function Tags({ card, max = 2 }: { card: QueriedCard; max?: number }) {
  if (!card.tags.length) return null;
  const shown = card.tags.slice(0, max);
  const more = card.tags.length - shown.length;
  return <span className="task-tags" role="group" aria-label={`Tags ${card.tags.map((tag) => tag.name).join(", ")}`}>
    {shown.map((tag) => <span key={tag.id} className={`task-tag color-${tag.color}`} aria-hidden="true">{tag.name}</span>)}
    {more > 0 && <span className="task-tag more" aria-hidden="true">+{more}</span>}
  </span>;
}

const people = (card: QueriedCard) => card.assignees.map((person) => person.can_read === 1 ? person.display_name : `${person.display_name} (no access)`);

function MoreButton({ card, onMoveCard, className }: { card: QueriedCard; onMoveCard: QueryResultsProps["onMoveCard"]; className: string }) {
  // Read-only roles, and boards the caller only views or comments on: nothing to move (READ_ONLY).
  const { readOnly } = useRole();
  if (!canChangeCard(card, readOnly)) return null;
  return <button type="button" className={`icon-button ${className}`} onClick={(event) => onMoveCard(card, event.currentTarget)} aria-haspopup="dialog" aria-label={`Move “${card.title}”`} title="Move to…"><Ellipsis /></button>;
}

/** One list row: the title, then board › column, due, tags, and people, 44 px tall at least. */
function ResultRow({ card, also, group, today, onOpenCard, onMoveCard }: { card: QueriedCard; also: string[]; group: HomeGroup } & Pick<QueryResultsProps, "today" | "onOpenCard" | "onMoveCard">) {
  const names = people(card);
  return <li className={`task-group-row${card.is_done === 1 ? " done" : ""}`} data-card-id={card.id}>
    <button type="button" className="task-group-open" onClick={() => onOpenCard(card)} data-open-card={card.id}>
      <span className="task-group-title"><FlagIcons flags={card.flags} /><span>{card.title}</span></span>
      <span className="task-group-meta">
        <span className="task-home-place">{group === "board" ? card.column_name : `${card.board_name} › ${card.column_name}`}</span>
        <Due card={card} today={today} />
        <Tags card={card} />
        {names.length > 0 && <span className="task-group-people" title={names.join(", ")}><Avatars card={card as unknown as BoardCard} /><span className="sr-only">Assigned to {names.join(", ")}</span></span>}
        {also.length > 0 && <span className="task-group-also">also in {also.join(", ")}</span>}
      </span>
    </button>
    <MoreButton card={card} onMoveCard={onMoveCard} className="task-group-more" />
  </li>;
}

function GroupedList({ cards, group, today, userId, onOpenCard, onMoveCard }: Pick<QueryResultsProps, "cards" | "group" | "today" | "userId" | "onOpenCard" | "onMoveCard">) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = groupResults(cards, group, { today, userId });
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(`${group}:${key}`)) next.delete(`${group}:${key}`);
    else next.add(`${group}:${key}`);
    return next;
  });
  if (group === "none") return <ul className="task-group-list">{groups[0]!.items.map(({ card }) => <ResultRow key={card.id} card={card} also={[]} group={group} today={today} onOpenCard={onOpenCard} onMoveCard={onMoveCard} />)}</ul>;
  return <div className="task-grouped">
    {groups.map((section) => {
      const isCollapsed = collapsed.has(`${group}:${section.key}`);
      const headingId = `task-home-group-${group}-${section.key.replace(/[^a-z0-9-]/gi, "_")}`;
      return <section key={section.key} className="task-group" aria-labelledby={headingId}>
        <h3 id={headingId}>
          <button type="button" className="task-group-toggle" aria-expanded={!isCollapsed} onClick={() => toggle(section.key)}>
            {isCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            <span className="task-group-name">{section.label}</span>
            <span className="task-group-count" aria-label={cardCountLabel(section.items.length)}>{section.items.length}</span>
          </button>
        </h3>
        {!isCollapsed && <ul className="task-group-list">
          {section.items.map(({ card, also }) => <ResultRow key={card.id} card={card} also={also} group={group} today={today} onOpenCard={onOpenCard} onMoveCard={onMoveCard} />)}
        </ul>}
      </section>;
    })}
  </div>;
}

function ResultTable({ cards, today, onOpenCard, onMoveCard }: Pick<QueryResultsProps, "cards" | "today" | "onOpenCard" | "onMoveCard">) {
  return <div className="task-table-region" role="region" aria-label="Cards table" tabIndex={0}>
    <table className="task-table task-home-table">
      <thead>
        <tr>{["Title", "Board", "Column", "State", "Assignees", "Due", "Tags", "Updated"].map((label) => <th key={label} scope="col" className={label === "Title" ? "task-table-title" : undefined}>{label}</th>)}</tr>
      </thead>
      <tbody>
        {cards.map((card) => {
          const names = people(card);
          return <tr key={card.id} className={card.is_done === 1 ? "done" : undefined} data-card-id={card.id}
            onClick={(event) => { if (!(event.target as Element).closest("button")) onOpenCard(card); }}>
            <th scope="row" className="task-table-title">
              <span className="task-table-title-cell">
                <button type="button" className="task-table-open" onClick={() => onOpenCard(card)} data-open-card={card.id} title={card.description_excerpt || undefined}>{card.title}</button>
                <MoreButton card={card} onMoveCard={onMoveCard} className="task-table-more" />
              </span>
            </th>
            <td>{card.board_name}</td>
            <td>{card.column_name}</td>
            <td>{STATE_LABELS[card.column_state]}</td>
            <td className="task-table-people" title={names.join(", ")}>{names.length ? <><Avatars card={card as unknown as BoardCard} /><span className="task-table-names">{names.join(", ")}</span></> : <span className="task-table-empty">—</span>}</td>
            <td><Due card={card} today={today} /></td>
            <td><Tags card={card} /></td>
            <td className="task-table-date">{shortTimestamp(card.updated_at)}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

/** The board layout: three state lanes, To do, In progress, Done; each card moves with "Move to…". */
function StateLanes({ cards, today, onOpenCard, onMoveCard }: Pick<QueryResultsProps, "cards" | "today" | "onOpenCard" | "onMoveCard">) {
  return <div className="task-home-lanes">
    {stateLanes(cards).map((lane) => <section key={lane.state} className="task-home-lane" aria-labelledby={`task-home-lane-${lane.state}`}>
      <h3 id={`task-home-lane-${lane.state}`}><span>{lane.label}</span><b aria-label={cardCountLabel(lane.cards.length)}>{lane.cards.length}</b></h3>
      {lane.cards.length
        ? <ul className="task-group-list">{lane.cards.map((card) => <ResultRow key={card.id} card={card} also={[]} group="none" today={today} onOpenCard={onOpenCard} onMoveCard={onMoveCard} />)}</ul>
        : <p className="task-group-empty">No cards</p>}
    </section>)}
  </div>;
}

/**
 * Cross-board results in one of three layouts (§10.2): the grouped list, the table, and state
 * lanes. The server pages them (keyset, 50 a page); "Load more" asks for the next page.
 */
export function QueryResults(props: QueryResultsProps) {
  const { cards, layout, total, nextCursor, loadingMore, onLoadMore, emptyText } = props;
  if (!cards.length) return <div className="bin-state task-home-empty"><span className="bin-state-icon"><KanbanSquare /></span><p>{emptyText}</p></div>;
  return <>
    {layout === "table" ? <ResultTable {...props} /> : layout === "board" ? <StateLanes {...props} /> : <GroupedList {...props} />}
    <footer className="task-home-more">
      <span role="status">{total !== undefined ? `${cards.length} of ${cardCountLabel(total)}` : nextCursor ? `${cardCountLabel(cards.length)} so far` : cardCountLabel(cards.length)}</span>
      {nextCursor && <button type="button" className="secondary-button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button>}
    </footer>
  </>;
}
