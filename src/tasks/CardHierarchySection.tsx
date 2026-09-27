import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronRight, CornerLeftUp, Layers, ListChecks, Plus, SquarePen, X } from "lucide-react";
import { aLevel, canHaveChildren, childName, childPlural, levelName, parentRequired, parentRequiredMessage } from "../../shared/boardStructure";
import { Combobox, type ComboboxHandle } from "../ui/Combobox";
import { Select } from "../ui/Select";
import { ancestorsOf, checklistColumn, childrenOf, hasLevels, levelOf, parentCandidates } from "./hierarchyModel";
import { dueStatus, localDateString, validateCardTitle } from "./taskActions";
import type { CardChange, CardDetail } from "./tasksApi";
import type { CardHierarchyContext } from "./useBoardHierarchy";

/**
 * Runs one inline add at a time (QA 0.9.0): while `flag` is set a second call is refused (null),
 * so a quick double Enter never creates a duplicate. Otherwise the add's own result.
 */
export async function addOnce(flag: { current: boolean }, run: () => Promise<boolean>): Promise<boolean | null> {
  if (flag.current) return null;
  flag.current = true;
  try {
    return await run();
  } finally {
    flag.current = false;
  }
}

/** "Epic: Checkout › Story: Refunds ›" above the card title; each step opens that card (a history entry). */
export function CardBreadcrumb({ card, context }: { card: CardDetail; context: CardHierarchyContext }) {
  const chain = ancestorsOf(context.cards, card.id);
  if (!chain.length) return null;
  return <nav className="task-breadcrumb" aria-label="Parents">
    {chain.map((item) => <span key={item.id}>
      <button type="button" onClick={() => context.openCard(item.id)} title={item.title}>
        <small>{levelName(context.structure, levelOf(item))}</small><span className="sr-only">: </span>{item.title}
      </button>
      <ChevronRight aria-hidden="true" />
    </span>)}
  </nav>;
}

type ParentFieldsProps = {
  card: CardDetail;
  context: CardHierarchyContext;
  idPrefix: string;
  saving: boolean;
  onSave: (change: Pick<CardChange, "parentId" | "level">, success: string) => Promise<boolean>;
  /** A read-only Team role: the parent and level show as text. */
  readOnly?: boolean;
};

/**
 * The Parent field (a Combobox over this board's cards one level up) and the Level field ("Change
 * level", D128). Hidden on a flat board; the Parent field is hidden at the top level. An empty
 * parent shows the prompt "Choose a task…", never a "No task" chip (operator QA 0.9.1). Below the
 * work level a parent is required: removing it asks for another one or offers "Make it a task",
 * choosing a sub-level asks for its parent before saving, and a subtask restored without its parent
 * (D130) says so with both ways out.
 */
export function CardParentFields({ card, context, idPrefix, saving, onSave, readOnly = false }: ParentFieldsProps) {
  const comboRef = useRef<ComboboxHandle>(null);
  // A sub-level chosen in the Level field that still needs its parent before it can be saved.
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  // The chip's × on a required parent: ask instead of leaving the card without one.
  const [asking, setAsking] = useState(false);
  const { structure } = context;
  if (!hasLevels(structure)) return null;
  const level = levelOf(card);
  const shownLevel = pendingLevel ?? level;
  const liveChildren = childrenOf(context.cards, context.columns, card.id).length;
  const parentLevel = shownLevel - 1;
  const parentLevelName = shownLevel > 0 ? levelName(structure, parentLevel) : "";
  const required = parentRequired(structure, shownLevel);
  const workName = aLevel(structure, structure.workLevel);
  const candidates = parentCandidates(context.cards, card, shownLevel);
  const columnName = (columnId: string) => context.columns.find((column) => column.id === columnId)?.name;
  const options = candidates.map((candidate) => ({ value: candidate.id, label: candidate.title, ...(columnName(candidate.column_id) ? { description: columnName(candidate.column_id)! } : {}) }));
  const parentTitle = card.parent_card_id
    ? context.cards.find((item) => item.id === card.parent_card_id)?.title ?? (card.parent?.id === card.parent_card_id ? card.parent.title : parentLevelName)
    : null;
  if (readOnly) {
    return <>
      {level > 0 && <div className="task-card-field">
        <span id={`${idPrefix}-parent-label`} className="task-card-field-label"><Layers aria-hidden="true" />{parentLevelName}</span>
        <p className="task-card-static" aria-labelledby={`${idPrefix}-parent-label`}>{parentTitle ?? `No ${parentLevelName.toLowerCase()}`}</p>
      </div>}
      <div className="task-card-field">
        <span id={`${idPrefix}-level-label`} className="task-card-field-label"><Layers aria-hidden="true" />Level</span>
        <p className="task-card-static" aria-labelledby={`${idPrefix}-level-label`}>{levelName(structure, level)}</p>
      </div>
    </>;
  }
  const levelOptions = structure.levels.map((item, index) => ({ value: String(index), label: item.name, ...(index === level ? { description: "Now" } : {}) }));
  const value = pendingLevel === null && card.parent_card_id ? [card.parent_card_id] : [];
  const detached = pendingLevel === null && required && !card.parent_card_id;
  // "Make it a task": up to the work level with no parent; a card with children keeps its level.
  const canPromote = liveChildren === 0 && level !== structure.workLevel;
  const promote = () => {
    setAsking(false);
    void onSave({ level: structure.workLevel, parentId: null }, `Now ${workName}`);
  };
  const chooseParent = () => {
    setAsking(false);
    comboRef.current?.open();
  };

  function changeLevel(next: number) {
    setAsking(false);
    if (next === level) {
      setPendingLevel(null);
      return;
    }
    // The parent stays only if it is one level above the new level.
    const parent = card.parent_card_id ? context.cards.find((item) => item.id === card.parent_card_id) : undefined;
    const keep = parent && levelOf(parent) === next - 1 ? parent.id : null;
    if (!keep && parentRequired(structure, next)) {
      // Nothing saves until a parent one level up is chosen.
      setPendingLevel(next);
      window.setTimeout(() => comboRef.current?.open(), 0);
      return;
    }
    setPendingLevel(null);
    void onSave({ level: next, parentId: keep }, `Now ${aLevel(structure, next)}`);
  }

  function pickParent(next: string[]) {
    const picked = next[next.length - 1] ?? null;
    if (!picked) {
      // The chip's ×: a subtask asks for another parent instead of losing it.
      if (required) setAsking(true);
      else void onSave({ parentId: null }, `No ${parentLevelName.toLowerCase()} now`);
      return;
    }
    setAsking(false);
    const title = candidates.find((item) => item.id === picked)?.title;
    if (pendingLevel !== null) {
      const levelTo = pendingLevel;
      setPendingLevel(null);
      void onSave({ level: levelTo, parentId: picked }, `Now ${aLevel(structure, levelTo)} of “${title}”`);
      return;
    }
    if (picked !== card.parent_card_id) void onSave({ parentId: picked }, `Moved under “${title}”`);
  }

  const noteId = `${idPrefix}-parent-note`;
  return <>
    {shownLevel > 0 && <div className="task-card-field">
      <label htmlFor={`${idPrefix}-parent`}><Layers aria-hidden="true" />{parentLevelName}</label>
      <Combobox id={`${idPrefix}-parent`} label={parentLevelName} placeholder={`Choose ${aLevel(structure, parentLevel)}…`}
        emptyText={candidates.length ? `No ${structure.levels[parentLevel]!.plural.toLowerCase()} match` : `No ${structure.levels[parentLevel]!.plural.toLowerCase()} on this board yet`}
        value={value} options={options} disabled={saving} handleRef={comboRef} openOnFocus={pendingLevel !== null}
        selectedOptions={card.parent_card_id && parentTitle && !candidates.some((item) => item.id === card.parent_card_id) ? [{ value: card.parent_card_id, label: parentTitle }] : undefined}
        onChange={pickParent} />
      {pendingLevel !== null && <div id={noteId} className="task-parent-note" role="alert">
        <p>{parentRequiredMessage(structure, pendingLevel)}.</p>
        <span><button type="button" className="secondary-button task-small-button" onClick={() => setPendingLevel(null)}>Cancel</button></span>
      </div>}
      {asking && <div id={noteId} className="task-parent-note" role="alert">
        <p>{`${aLevel(structure, level).replace(/^./, (first) => first.toUpperCase())} needs ${aLevel(structure, parentLevel)}. Choose another one${canPromote ? `, or make it ${workName}` : ""}.`}</p>
        <span>
          <button type="button" className="secondary-button task-small-button" onClick={() => setAsking(false)}>Keep</button>
          <button type="button" className="secondary-button task-small-button" onClick={chooseParent}>Choose {aLevel(structure, parentLevel)}</button>
          {canPromote && <button type="button" className="primary-button task-small-button" onClick={promote}>Make it {workName}</button>}
        </span>
      </div>}
      {detached && !asking && <div id={noteId} className="task-parent-note detached" role="status">
        <p><strong>Detached {levelName(structure, level).toLowerCase()}</strong> — choose {aLevel(structure, parentLevel)} or change its level.</p>
        <span>
          <button type="button" className="secondary-button task-small-button" disabled={saving} onClick={chooseParent}>Choose {aLevel(structure, parentLevel)}</button>
          {canPromote && <button type="button" className="secondary-button task-small-button" disabled={saving} onClick={promote}>Make it {workName}</button>}
        </span>
      </div>}
    </div>}
    <div className="task-card-field">
      <label id={`${idPrefix}-level-label`}><Layers aria-hidden="true" />Level</label>
      <Select id={`${idPrefix}-level`} labelledBy={`${idPrefix}-level-label`} label="Level" value={String(shownLevel)} options={levelOptions} disabled={saving || liveChildren > 0} onChange={(next) => changeLevel(Number(next))} />
      {liveChildren > 0 && <small className="task-due-text">It has {liveChildren === 1 ? "a child" : `${liveChildren} children`}, so it stays a {levelName(structure, level).toLowerCase()}.</small>}
    </div>
  </>;
}

type SubtasksProps = {
  card: CardDetail; context: CardHierarchyContext; idPrefix: string;
  /** A read-only Team role: the list and progress only (no checkboxes, add, or remove). */
  readOnly?: boolean;
};

/**
 * The Subtasks section (§7.2), named by the level below ("Stories" on an epic): a checklist whose
 * checkbox moves a child to the board's first done column and back (D127), links that open each
 * child, "Remove from parent", and an inline add that keeps focus for the next one.
 */
export function SubtasksSection({ card, context, idPrefix, readOnly = false }: SubtasksProps) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const headingId = useId();
  const { structure } = context;
  const level = levelOf(card);
  if (!canHaveChildren(structure, level)) return null;
  const children = childrenOf(context.cards, context.columns, card.id);
  const doneIds = new Set(context.columns.filter((column) => column.is_done === 1).map((column) => column.id));
  const done = children.filter((child) => doneIds.has(child.column_id)).length;
  const checkable = !readOnly && checklistColumn(context.columns, true) !== null;
  const plural = childPlural(structure, level);
  const singular = childName(structure, level);
  const today = localDateString();
  const columnName = (columnId: string) => context.columns.find((column) => column.id === columnId)?.name ?? "";

  // QA 0.9.0: the input stays enabled (a disabled input drops focus) and a ref, not state, refuses a
  // second Enter while the first add is saving, so a quick double Enter never adds a duplicate.
  async function add() {
    const check = validateCardTitle(draft);
    if (!check.ok || inFlightRef.current) return;
    setAdding(true);
    const added = await addOnce(inFlightRef, () => context.addChild(card, check.name));
    setAdding(false);
    if (added) setDraft((current) => current.trim() === check.name ? "" : current);
    inputRef.current?.focus();
  }

  function onKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void add();
    }
    if (event.key === "Escape" && draft) {
      event.preventDefault();
      setDraft("");
    }
  }

  async function toggle(child: (typeof children)[number], checked: boolean) {
    setPending(child.id);
    try {
      await context.setChildDone(child, checked);
    } finally {
      setPending(null);
    }
  }

  return <section className="task-card-section task-subtasks" aria-labelledby={headingId}>
    <header>
      <h3 id={headingId}><ListChecks aria-hidden="true" />{plural} {children.length > 0 && <span className="task-subtasks-count">{done}/{children.length}</span>}</h3>
      {!readOnly && <button type="button" className="secondary-button task-small-button" onClick={() => context.composeChild(card)}><SquarePen />Add with details</button>}
    </header>
    {children.length > 0 && <span className="task-subtasks-bar" role="progressbar" aria-label={`${done} of ${children.length} ${plural.toLowerCase()} done`} aria-valuemin={0} aria-valuemax={children.length} aria-valuenow={done}>
      <span style={{ width: `${Math.round((done / children.length) * 100)}%` }} />
    </span>}
    <ul className="task-subtask-list" aria-label={plural}>
      {children.map((child) => {
        const isDone = doneIds.has(child.column_id);
        const due = dueStatus(child.due_on, today, isDone, { dueAt: child.due_at });
        return <li key={child.id} className={`task-subtask${isDone ? " done" : ""}`}>
          {checkable
            ? <label className="task-subtask-check"><input type="checkbox" checked={isDone} disabled={pending === child.id} onChange={(event) => { void toggle(child, event.target.checked); }}
              aria-label={`${isDone ? "Done" : "Not done"}: ${child.title}`} /></label>
            : <span className="task-subtask-column">{columnName(child.column_id)}</span>}
          <button type="button" className="task-subtask-title" onClick={() => context.openCard(child.id)} title={child.title}>{child.title}</button>
          {due && <span className={`task-due-chip ${due.tone}`}>{due.label}</span>}
          {checkable && <small className="task-subtask-where">{columnName(child.column_id)}</small>}
          {!readOnly && (parentRequired(structure, levelOf(child))
            // A subtask never loses its parent: it can become a work-level card instead (unless it has children).
            ? (child.child_count ?? 0) === 0 && <button type="button" className="icon-button" onClick={() => { void context.detachChild(child); }}
              aria-label={`Make “${child.title}” ${aLevel(structure, structure.workLevel)}`} title={`Make it ${aLevel(structure, structure.workLevel)}`}><CornerLeftUp /></button>
            : <button type="button" className="icon-button" onClick={() => { void context.detachChild(child); }} aria-label={`Remove “${child.title}” from this ${levelName(structure, level).toLowerCase()}`} title="Remove from parent"><X /></button>)}
        </li>;
      })}
    </ul>
    {!readOnly && <div className="task-subtask-add">
      <Plus aria-hidden="true" />
      <input ref={inputRef} id={`${idPrefix}-add-child`} value={draft} maxLength={200} placeholder={`Add ${singular.toLowerCase()}…`} aria-label={`Add ${singular.toLowerCase()}`}
        aria-busy={adding || undefined} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} enterKeyHint="done" />
      {draft.trim() && <button type="button" className="primary-button task-small-button" onClick={() => { void add(); }} disabled={adding}>{adding ? "Adding…" : "Add"}</button>}
    </div>}
    {readOnly && !children.length && <p className="task-comment-empty">No {plural.toLowerCase()} yet.</p>}
  </section>;
}
