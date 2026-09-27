import { useCallback, useEffect, useState } from "react";
import { Bookmark, Lock, Plus, RotateCcw, Share2, TriangleAlert, Users } from "lucide-react";
import { taskErrorMessage } from "../tasksApi";
import { listViews, type TaskView, type ViewLists } from "../home/homeApi";
import { useRole } from "../../team/roleAccess";
import { onViewsChanged, viewRoleAccess, viewVisibilityLabel } from "./viewActions";

type ViewsListProps = {
  onOpen: (view: TaskView) => void;
  onNew: () => void;
  /** Lists to show before the first load returns (render tests); the list still loads on mount. */
  initialLists?: ViewLists | null;
};

const VisibilityIcon = ({ visibility }: { visibility: TaskView["visibility"] }) => {
  const Icon = visibility === "all_users" ? Share2 : visibility === "selected" ? Users : Lock;
  return <Icon aria-hidden="true" />;
};

/**
 * The Views segment (§9.4): my views, views shared with me, and everyone's, each a saved filter
 * and layout. Selecting one pushes /tasks/views/:id. Views run as the viewer, so a shared view
 * never shows cards from boards the viewer cannot read (T115).
 */
export function ViewsList({ onOpen, onNew, initialLists = null }: ViewsListProps) {
  const { canCreate } = viewRoleAccess(useRole());
  const [lists, setLists] = useState<ViewLists | null>(initialLists);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setLists(await listViews());
    } catch (reason) {
      setError(taskErrorMessage(reason, "Could not load your views"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // A view restored by Undo (from the toast, after its page has gone) shows without a reload.
  useEffect(() => onViewsChanged(() => { void load(); }), [load]);

  const row = (view: TaskView) => <li key={view.id} className="task-board-row task-view-row">
    <button className="task-board-open" onClick={() => onOpen(view)}>
      <span className="task-board-icon" aria-hidden="true"><Bookmark /></span>
      <span className="task-board-copy">
        <span className="task-board-name" title={view.name}>{view.name}</span>
        <span className="task-board-meta">
          {view.is_owner === 0 && <span className="owner-badge">{view.owner_name}</span>}
          <span className="task-shared"><VisibilityIcon visibility={view.visibility} />{viewVisibilityLabel(view.visibility)}</span>
          {view.is_owner === 0 && <span>Read only</span>}
        </span>
      </span>
    </button>
  </li>;

  const empty = lists && !lists.mine.length && !lists.shared.length && !lists.everyone.length;
  return <div className="task-views">
    {/* Q12: viewers save private views; guests save none (the write gate refuses them). The empty
        state carries its own "New view", so the toolbar button shows only beside a list (or an error). */}
    {canCreate && (error || (lists && !empty)) && <div className="task-home-toolbar">
      <button className="primary-button task-home-action" onClick={onNew}><Plus aria-hidden="true" /><span>New view</span></button>
    </div>}
    {error && <div className="bin-state bin-error" role="alert">
      <span className="bin-state-icon"><TriangleAlert /></span>
      <h2>Could not load your views</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !lists && <p className="bin-loading" role="status">Loading views…</p>}
    {empty && <div className="bin-state">
      <span className="bin-state-icon"><Bookmark /></span>
      <h2>No views yet</h2>
      {canCreate
        ? <p>A view saves a filter across your boards, such as “Urgent cards on Web and Home”. Start one here, or filter My work and choose Save as view.</p>
        : <p>Views that people share with you show here.</p>}
      {canCreate && <button className="primary-button" onClick={onNew}><Plus />New view</button>}
    </div>}
    {lists && lists.mine.length > 0 && <><h2 className="tasks-section-label">My views</h2><ul className="task-board-list" aria-label="My views">{lists.mine.map(row)}</ul></>}
    {lists && lists.shared.length > 0 && <><h2 className="tasks-section-label">Shared with me</h2><ul className="task-board-list" aria-label="Views shared with me">{lists.shared.map(row)}</ul></>}
    {lists && lists.everyone.length > 0 && <><h2 className="tasks-section-label">Everyone</h2><ul className="task-board-list" aria-label="Views shared with everyone">{lists.everyone.map(row)}</ul></>}
    {lists?.truncated && <p className="task-home-note">Showing the first 200 shared views.</p>}
  </div>;
}
