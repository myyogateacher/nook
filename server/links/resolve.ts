import { workKindAdapter, type Viewer } from "./adapters";
import { isWorkKind, WORK_KIND_LABELS, workRefKey, type WorkKind, type WorkRef, type WorkSummary } from "../../shared/workRefs";
import { ACTIVITY_LABEL_MAX, type ActivityValue } from "../../shared/cardActivity";

/** Summaries for many refs at once, grouped by kind; null for unreadable or unknown ones (T501). */
export function resolveRefs(refs: readonly WorkRef[], viewer: Viewer): Map<string, WorkSummary | null> {
  const result = new Map<string, WorkSummary | null>();
  const byKind = new Map<WorkKind, string[]>();
  for (const ref of refs) byKind.set(ref.kind, [...(byKind.get(ref.kind) ?? []), ref.id]);
  for (const [kind, ids] of byKind) {
    const adapter = workKindAdapter(kind);
    const resolved = adapter ? adapter.resolve([...new Set(ids)], viewer) : new Map<string, WorkSummary | null>();
    for (const id of ids) result.set(workRefKey({ kind, id }), resolved.get(id) ?? null);
  }
  return result;
}

/** A linked item as a history payload stores it: its id and the neutral kind word (never its title). */
export type LinkedActivityValue = ActivityValue & { kind?: WorkKind };

const KIND_BY_LABEL = new Map<string, WorkKind>(Object.entries(WORK_KIND_LABELS).map(([kind, label]) => [label, kind as WorkKind]));

/**
 * The other item of a link history entry (D1390): the stored `kind`, else `fallback` (a card's
 * `goal_linked` is always a goal), else the kind word reversed (rows from before `kind` was stored).
 * Null when the value names no item (no id, or a word that is no kind).
 */
export function linkedActivityRef(value: LinkedActivityValue | null | undefined, fallback?: WorkKind): WorkRef | null {
  if (!value?.id) return null;
  const kind = isWorkKind(value.kind) ? value.kind : fallback ?? KIND_BY_LABEL.get(value.label) ?? null;
  return kind ? { kind, id: value.id } : null;
}

const clip = (value: string) => value.length > ACTIVITY_LABEL_MAX ? `${value.slice(0, ACTIVITY_LABEL_MAX - 1)}…` : value;

/**
 * Resolves link history values per viewer at read time (D1390, T706): one batched resolve over the
 * page's refs, through the same adapters as the Links panel. An item the viewer can read (and
 * `mayRead` allows, for keys over chosen items) reads as its current title, with id and kind; any
 * other keeps the kind word only, without its id (T501). Titles are never stored.
 */
export function linkedActivityResolver(refs: readonly WorkRef[], viewer: Viewer, mayRead?: (ref: WorkRef) => boolean) {
  const allowed = mayRead ? refs.filter(mayRead) : refs;
  const summaries = allowed.length ? resolveRefs(allowed, viewer) : new Map<string, WorkSummary | null>();
  return (ref: WorkRef, value: LinkedActivityValue): LinkedActivityValue => {
    const summary = summaries.get(workRefKey(ref));
    const detail = value.detail ? { detail: value.detail } : {};
    return summary
      ? { id: ref.id, label: clip(summary.title), kind: ref.kind, ...detail }
      : { label: WORK_KIND_LABELS[ref.kind] ?? value.label, kind: ref.kind, ...detail };
  };
}
