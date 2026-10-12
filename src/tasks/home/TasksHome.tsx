import { useCallback } from "react";
import { BoardList } from "../BoardList";
import type { TaskNotify } from "../taskActions";
import type { BoardSummary } from "../tasksApi";
import { ViewPage } from "../views/ViewPage";
import { ViewsList } from "../views/ViewsList";
import type { QueriedCard, TaskView } from "./homeApi";
import { useHomeDirectory } from "./HomeResultsPane";
import { HomeSegments, useTasksTitle, type HomeSegment } from "./HomeSegments";
import { NEW_VIEW, type HomeQuery, type TasksHome as TasksHomeRoute } from "./homeUrl";
import { MyWork } from "./MyWork";
import "../boardViews.css";
import "./home.css";

type TasksHomeProps = {
  userId: string;
  /** Undefined is the Boards segment (/tasks). */
  home: TasksHomeRoute | undefined;
  /** Pushes, or replaces with `replace`, a home route (or the board list for undefined). */
  onHome: (home: TasksHomeRoute | undefined, options?: { replace?: boolean; saved?: boolean }) => void;
  onOpenBoard: (board: BoardSummary) => void;
  onOpenBoardId: (boardId: string) => void;
  /** Opens a card from cross-board results: pushes /tasks/:b/card/:k, so Back returns here (§9.5). */
  onOpenCard: (card: QueriedCard) => void;
  onBack: () => void;
  notify: TaskNotify;
};

const TITLES: Record<HomeSegment, string> = { boards: "Tasks", my: "My work · Tasks", views: "Views · Tasks" };

/**
 * The Tasks home (§9.4, §10): Boards · My work · Views segments, each a route. Boards is the board
 * list; My work is `assignee:me` across boards; Views lists saved views and opens one.
 */
export function TasksHome({ userId, home, onHome, onOpenBoard, onOpenBoardId, onOpenCard, onBack, notify }: TasksHomeProps) {
  const directory = useHomeDirectory();
  const segment: HomeSegment = !home ? "boards" : home.section === "my" ? "my" : "views";
  const viewPage = home?.section === "view";
  // The view page sets its own title (the view's name).
  useTasksTitle(viewPage ? null : TITLES[segment]);
  const select = useCallback((next: HomeSegment) => onHome(next === "boards" ? undefined : next === "my" ? { section: "my" } : { section: "views" }), [onHome]);
  const segments = <HomeSegments active={segment} onSelect={select} />;
  const openView = useCallback((view: TaskView, options?: { replace?: boolean }) => onHome({ section: "view", viewId: view.id }, options), [onHome]);
  const onMissing = useCallback(() => {
    notify.warning("That view was deleted or is not shared with you");
    onHome({ section: "views" }, { replace: true });
  }, [notify, onHome]);

  if (!home) return <BoardList onOpen={onOpenBoard} onOpenBoard={onOpenBoardId} notify={notify} header={segments} />;

  const intro = <div className="tasks-intro task-home-intro">
    <div>
      <span className="eyebrow">Tasks</span>
      <h1 id="tasks-title">{segment === "my" ? "My work" : "Views"}</h1>
      <p>{segment === "my" ? "Cards assigned to you on every board you can open." : "Saved filters across your boards. A shared view shows each person only the boards they can open."}</p>
    </div>
  </div>;

  return <section className={`tasks-content task-home${viewPage ? " task-home-view" : ""}`} aria-labelledby={viewPage ? "task-view-title" : "tasks-title"}>
    {!viewPage && intro}
    {segments}
    {home.section === "my" && <MyWork userId={userId} query={home.query} directory={directory} notify={notify} onOpenCard={onOpenCard} onOpenView={openView}
      onQuery={(query: HomeQuery, options) => onHome({ section: "my", query }, { replace: !options.push })} />}
    {home.section === "views" && <ViewsList onOpen={openView} onNew={() => onHome({ section: "view", viewId: NEW_VIEW })} />}
    {home.section === "view" && <ViewPage key={home.viewId} userId={userId} viewId={home.viewId} query={home.query} directory={directory} notify={notify} onOpenCard={onOpenCard}
      onQuery={(query, options) => onHome(query ? { section: "view", viewId: home.viewId, query } : { section: "view", viewId: home.viewId }, { replace: !options.push, saved: options.saved === true })}
      onOpenView={openView} onBack={onBack} onMissing={onMissing}
      onDeleted={() => onHome({ section: "views" }, { replace: true })} />}
  </section>;
}
