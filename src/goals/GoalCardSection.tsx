import { useCallback, useEffect, useState } from "react";
import { Plus, Target } from "lucide-react";
import { Select } from "../ui/Select";
import { WorkRefChip } from "../ui/links/WorkLinks";
import { errorText } from "../ui/notify";
import { createLink, deleteLink, listLinks } from "../ui/workspaceApi";
import { listGoals, type GoalSummary } from "./goalsApi";
import type { CardSlotProps } from "../ui/cardSlots";
import { forgetCardGoals } from "./CardGoalBadge";
import type { WorkLinkView } from "../../shared/workRefs";
import "../ui/workspace.css";
import "./goals.css";

/**
 * The card dialog's "Goals" field (C22, §F.3: a registered card section, never an edit of src/tasks):
 * the goals this card contributes to, as chips with their progress and health, and "Add to goal" (a
 * goal the viewer can open; the card side needs edit, the link rules of §B.4.3).
 */
export function GoalCardSection({ card, readOnly, idPrefix, notify }: CardSlotProps) {
  const [links, setLinks] = useState<WorkLinkView[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  const load = useCallback(() => {
    listLinks({ kind: "card", id: card.id }).then((body) => setLinks(body.links.filter((link) => link.other.kind === "goal" && link.relation === "contributes" && link.direction === "out")), () => setLinks([]));
  }, [card.id]);
  useEffect(load, [load]);
  useEffect(() => { if (picking && goals === null) listGoals({ view: "tree" }).then((body) => setGoals(body.goals), () => setGoals([])); }, [picking, goals]);
  const headingId = `${idPrefix}-goals`;
  if (links === null) return null;
  if (!links.length && readOnly) return null;
  const linked = new Set(links.map((link) => ("id" in link.other ? link.other.id : "")));
  const add = async (goalId: string) => {
    try { await createLink({ kind: "card", id: card.id }, { kind: "goal", id: goalId }, "contributes"); setPicking(false); load(); forgetCardGoals(card.id); notify.success("Added to the goal"); }
    catch (reason) { notify.error(errorText(reason, "Could not add it to the goal")); }
  };
  // The card dialog's own section frame (task-card-section), so it reads like Relations above it.
  return <section className="task-card-section goals-card-goals" aria-labelledby={headingId}>
    <header>
      <h3 id={headingId}><Target aria-hidden="true" />Goals</h3>
      {!readOnly && !picking && <button type="button" className="secondary-button task-small-button" onClick={() => setPicking(true)}><Plus aria-hidden="true" />Add to goal</button>}
    </header>
    {!links.length && !picking && <p className="goals-note">Not part of a goal yet.</p>}
    {links.length > 0 && <ul>{links.map((link) => <li key={link.id}><WorkRefChip summary={link.other} onRemove={readOnly ? undefined : () => { deleteLink(link.id).then(() => { load(); forgetCardGoals(card.id); }, (reason) => notify.error(errorText(reason, "Could not remove it"))); }} removeLabel="Remove from goal" /></li>)}</ul>}
    {!readOnly && picking && (goals === null ? <p className="goals-note" role="status">Loading goals…</p>
      : <Select label="Add to goal" defaultOpen value="" onChange={(value) => { if (value) void add(value); }} placeholder="Choose a goal"
        options={goals.filter((goal) => !linked.has(goal.id)).map((goal) => ({ value: goal.id, label: goal.title, description: [goal.period?.name, `${Math.round(goal.progress * 100)}%`].filter(Boolean).join(" · ") }))} emptyText="No goals you can open" />)}
  </section>;
}
