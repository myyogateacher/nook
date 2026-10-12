import { useState } from "react";
import { BookmarkPlus } from "lucide-react";
import { format, type TaskState } from "../../../shared/taskQuery";
import { NameDialog } from "../../files/RenameDialog";
import { Select } from "../../ui/Select";
import { useHistoryDialogGuard } from "../../ui/useHistoryDialogGuard";
import { viewerTimeZone, type TaskNotify } from "../taskActions";
import { createView, type QueriedCard, type TaskView } from "./homeApi";
import { HomeResultsPane, type HomeDirectory } from "./HomeResultsPane";
import { withHomeTerm, homeTermValues } from "./HomeFilterBar";
import { STATE_LABELS } from "./homeResults";
import { myWorkDefault, sameHomeQuery, serverGroup, withAssigneeMe, type HomeQuery } from "./homeUrl";
import { useRole } from "../../team/roleAccess";
import { validateViewName, viewNameHint, viewRoleAccess } from "../views/viewActions";

/** My work's state chips: one tap picks a preset; "Open" is the default (`state:todo,doing`). */
export const STATE_PRESETS: Array<{ id: string; label: string; states: TaskState[] }> = [
  { id: "open", label: "Open", states: ["todo", "doing"] },
  { id: "todo", label: STATE_LABELS.todo, states: ["todo"] },
  { id: "doing", label: STATE_LABELS.doing, states: ["doing"] },
  { id: "done", label: STATE_LABELS.done, states: ["done"] },
  { id: "all", label: "All", states: [] }
];

export function statePreset(query: HomeQuery) {
  const values = [...homeTermValues(query.filter, "state")].sort().join(",");
  return STATE_PRESETS.find((preset) => [...preset.states].sort().join(",") === values)?.id ?? null;
}

type MyWorkProps = {
  userId: string;
  query: HomeQuery | undefined;
  onQuery: (next: HomeQuery, options: { push: boolean }) => void;
  directory: HomeDirectory;
  notify: TaskNotify;
  onOpenCard: (card: QueriedCard) => void;
  onOpenView: (view: TaskView) => void;
};

/**
 * My work (§10.2): the built-in, unsaved view of cards assigned to me on every board I can read.
 * It always carries `assignee:me` (Q11), so it never runs an unselective cross-board query; the
 * default at 390 px is the list grouped by due bucket (Q16), with table and lanes one tap away.
 */
export function MyWork({ userId, query, onQuery, directory, notify, onOpenCard, onOpenView }: MyWorkProps) {
  const effective: HomeQuery = { ...(query ?? myWorkDefault()), filter: withAssigneeMe((query ?? myWorkDefault()).filter) };
  const { canCreate, canShare } = viewRoleAccess(useRole());
  const [saving, setSaving] = useState(false);
  useHistoryDialogGuard(saving, () => setSaving(false));
  const preset = statePreset(effective);
  const q = format(effective.filter);
  const choosePreset = (id: string) => {
    const item = STATE_PRESETS.find((candidate) => candidate.id === id);
    if (item && preset !== item.id) onQuery({ ...effective, filter: withHomeTerm(effective.filter, "state", item.states) }, { push: true });
  };

  async function saveAsView(name: string) {
    const { view } = await createView({ name, query: q, display: { layout: effective.layout, group: effective.group, sort: effective.sort } });
    setSaving(false);
    notify.success(`Saved “${view.name}” to your views`);
    onOpenView(view);
  }

  return <>
    <HomeResultsPane userId={userId} query={effective} onQuery={onQuery} directory={directory} notify={notify} onOpenCard={onOpenCard}
      source={{ kind: "query", request: { q, sort: effective.sort, group: serverGroup(effective.group), tz: viewerTimeZone() } }}
      lockedKeys={["assignee"]} hiddenKeys={["state"]}
      above={<>
        <div className="task-home-states" role="radiogroup" aria-label="State">
          {STATE_PRESETS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={preset === item.id} className={`task-home-state${preset === item.id ? " active" : ""}`}
            onClick={() => choosePreset(item.id)}>{item.label}</button>)}
        </div>
        {/* Phones (QA 0.9.0): one chip on the layout switch's row instead of five. */}
        <span className="task-home-state-select">
          <Select<string> variant="chip" label="State" placeholder="Custom" value={preset} searchable={false}
            options={STATE_PRESETS.map((item) => ({ value: item.id, label: item.label }))} onChange={choosePreset} />
        </span>
      </>}
      actions={canCreate && !sameHomeQuery(effective, myWorkDefault()) && <button type="button" className="secondary-button task-home-action" onClick={() => setSaving(true)} aria-haspopup="dialog"><BookmarkPlus aria-hidden="true" /><span>Save as view</span></button>}
      emptyText={preset === "open" ? "Nothing open is assigned to you. Cards assigned to you on any board show here." : "No cards assigned to you match these filters."} />
    {saving && canCreate && <NameDialog title="Save as view" eyebrow="My work" label="View name" initialValue="My work" submitLabel="Save view" hint={viewNameHint(canShare)}
      validate={(value) => validateViewName(value)} onSubmit={saveAsView} onCancel={() => setSaving(false)} />}
  </>;
}
