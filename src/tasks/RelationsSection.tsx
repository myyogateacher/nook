import type { Notifier } from "../ui/notify";
import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CircleCheck, Link2, Lock, Plus, TriangleAlert, X } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import type { Option } from "../ui/Listbox";
import { Select } from "../ui/Select";
import { formatRoute } from "../router";
import { tasksRoute } from "../tasksRoute";
import {
  RELATION_HINTS,
  RELATION_LABELS,
  RELATION_TYPE_ORDER,
  blockedByLabel,
  groupRelations,
  linkedCardIds,
  openBlockerCount,
  relatedCardPlace,
  relationErrorMessage,
  relationRow,
  type RelationRow
} from "./relationsModel";
import { createRelation, deleteRelation, searchCards, taskErrorCode, taskErrorMessage, type CardRelation, type CardSearchResult, type RelationType } from "./tasksApi";
import { ApiError } from "../api";

export type RelatedCardTarget = NonNullable<RelationRow["card"]>;

type RelationListProps = {
  rows: RelationRow[];
  boardId: string;
  /** Opens a readable related card (its route); without it the rows are plain text (the composer). */
  onOpen?: (card: RelatedCardTarget) => void;
  onRemove?: (row: RelationRow) => void;
  busyKey?: string | null;
};

/** Relations grouped by type; a card the viewer cannot read is a "Restricted card" row that can still be removed. */
export function RelationList({ rows, boardId, onOpen, onRemove, busyKey }: RelationListProps) {
  const follow = (event: ReactMouseEvent<HTMLAnchorElement>, card: RelatedCardTarget) => {
    // A modified click opens a new tab as links do.
    if (!onOpen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(card);
  };
  return <div className="task-relation-groups">
    {groupRelations(rows).map((group) => <section key={group.type} className="task-relation-group" aria-label={group.label}>
      <h4>{group.label}</h4>
      <ul className="task-relations">
        {group.rows.map((row) => <li key={row.key} className={`task-relation${row.restricted ? " restricted" : ""}`}>
          {row.card
            ? <>
              <span className="task-relation-icon" aria-hidden="true">{row.card.is_done === 1 ? <CircleCheck /> : <Link2 />}</span>
              <span className="task-relation-copy">
                {onOpen
                  ? <a href={formatRoute(tasksRoute(row.card.board_id, row.card.id))} onClick={(event) => follow(event, row.card!)} title={row.card.title}>{row.card.title}</a>
                  : <span title={row.card.title}>{row.card.title}</span>}
                <small>{[relatedCardPlace(row.card, boardId), row.card.is_done === 1 ? "Done" : null].filter(Boolean).join(" · ")}</small>
              </span>
            </>
            : <>
              <span className="task-relation-icon" aria-hidden="true"><Lock /></span>
              <span className="task-relation-copy"><span>Restricted card</span><small>On a board you cannot open</small></span>
            </>}
          {onRemove && <button type="button" className="icon-button" onClick={() => onRemove(row)} disabled={busyKey === row.key}
            aria-label={row.card ? `Remove the link to ${row.card.title}` : "Remove the link to the restricted card"} title="Remove link"><X /></button>}
        </li>)}
      </ul>
    </section>)}
  </div>;
}

type RelationAdderProps = {
  idPrefix: string;
  /** The board on screen: its cards are listed first. */
  boardId: string;
  /** The card itself (never offered). */
  excludeCardId?: string;
  /** Cards already linked. */
  excluded: ReadonlySet<string>;
  disabled?: boolean;
  /** Adds the link; resolves to an error message to show, or null when it was added. */
  onAdd: (type: RelationType, card: CardSearchResult) => Promise<string | null>;
  onDone: () => void;
};

/** "Add relation": a type `Select` and a card `Combobox` backed by `GET /cards/search` (D106). */
export function RelationAdder({ idPrefix, boardId, excludeCardId, excluded, disabled, onAdd, onDone }: RelationAdderProps) {
  const [type, setType] = useState<RelationType>("relates_to");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = useRef(new Map<string, CardSearchResult>());
  const excludedRef = useRef(excluded);
  excludedRef.current = excluded;

  const loadOptions = useCallback(async (query: string, signal: AbortSignal): Promise<Option[]> => {
    const q = query.trim();
    if (!q) return [];
    const { results } = await searchCards(q, { boardId, ...(excludeCardId ? { excludeCardId } : {}), signal });
    return results.filter((result) => !excludedRef.current.has(result.id)).map((result) => {
      found.current.set(result.id, result);
      const place = [result.board_id === boardId ? null : result.board_name, result.column_name, result.is_done === 1 ? "Done" : null].filter(Boolean).join(" · ");
      return { value: result.id, label: result.title, ...(place ? { description: place } : {}) };
    });
  }, [boardId, excludeCardId]);

  async function pick(ids: string[]) {
    const card = ids[0] ? found.current.get(ids[0]) : undefined;
    if (!card) return;
    setBusy(true);
    setError(null);
    try {
      const message = await onAdd(type, card);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="task-relation-adder">
    <div className="task-relation-adder-row">
      <Select<RelationType> id={`${idPrefix}-relation-type`} label="Relation type" value={type} onChange={setType} disabled={disabled || busy}
        options={RELATION_TYPE_ORDER.map((value) => ({ value, label: RELATION_LABELS[value], description: RELATION_HINTS[value] }))} />
      <Combobox id={`${idPrefix}-relation-card`} label="Card to link" placeholder="Search card titles…" emptyText="Type part of a card title" value={[]}
        loadOptions={loadOptions} disabled={disabled || busy} onChange={(ids) => { void pick(ids); }} />
      <button type="button" className="secondary-button task-small-button" onClick={onDone}>Done</button>
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
  </div>;
}

const existingRelation = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { relation?: CardRelation }).relation ?? null
  : null;

type RelationsSectionProps = {
  cardId: string;
  boardId: string;
  idPrefix: string;
  relations: CardRelation[];
  onChange: (relations: CardRelation[]) => void;
  onOpen: (card: RelatedCardTarget) => void;
  notify: Notifier;
  /** A read-only Team role: the links only (no Add relation, no Remove). */
  readOnly?: boolean;
};

/**
 * The card's relations (D104–D107). Links are edges with their own endpoints: adding or removing
 * one never changes either card's revision, so it never conflicts with someone editing the card.
 */
export function RelationsSection({ cardId, boardId, idPrefix, relations, onChange, onOpen, notify, readOnly = false }: RelationsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const rows = relations.map(relationRow);
  const blockers = openBlockerCount(rows);
  const latest = useRef(relations);
  latest.current = relations;

  async function add(type: RelationType, card: CardSearchResult) {
    try {
      const { relation } = await createRelation(cardId, type, card.id);
      onChange([relation, ...latest.current.filter((item) => item.id !== relation.id)]);
      notify.success(`Linked: ${RELATION_LABELS[relation.type].toLowerCase()} “${card.title}”`);
      return null;
    } catch (reason) {
      const code = taskErrorCode(reason);
      if (reason instanceof ApiError && reason.status === 404) return "That card is no longer available.";
      return relationErrorMessage(code, taskErrorMessage(reason, "Could not link the card"), existingRelation(reason));
    }
  }

  async function remove(row: RelationRow) {
    setBusyKey(row.key);
    try {
      await deleteRelation(cardId, row.key);
      onChange(latest.current.filter((item) => item.id !== row.key));
      notify.success(row.card ? `Removed the link to “${row.card.title}”` : "Removed the link");
    } catch (reason) {
      // Already gone (someone else removed it): drop the row.
      if (reason instanceof ApiError && reason.status === 404) onChange(latest.current.filter((item) => item.id !== row.key));
      else notify.error(taskErrorMessage(reason, "Could not remove the link"));
    } finally {
      setBusyKey(null);
    }
  }

  return <section className="task-card-section" aria-labelledby={`${idPrefix}-relations`}>
    <header>
      <h3 id={`${idPrefix}-relations`}><Link2 aria-hidden="true" />Relations</h3>
      {!adding && !readOnly && <button type="button" className="secondary-button task-small-button" onClick={() => setAdding(true)} disabled={relations.length >= 50}><Plus />Add relation</button>}
    </header>
    {blockers > 0 && <p className="task-blocked-chip" role="note"><TriangleAlert aria-hidden="true" />{blockedByLabel(blockers)}</p>}
    {adding && !readOnly && <RelationAdder idPrefix={idPrefix} boardId={boardId} excludeCardId={cardId} excluded={linkedCardIds(rows)} onAdd={add} onDone={() => setAdding(false)} />}
    {rows.length
      ? <RelationList rows={rows} boardId={boardId} onOpen={onOpen} onRemove={readOnly ? undefined : (row) => { void remove(row); }} busyKey={busyKey} />
      : !adding && <p className="task-comment-empty">{readOnly ? "No related cards." : "No related cards. Link cards that depend on, block, or repeat this one."}</p>}
  </section>;
}
