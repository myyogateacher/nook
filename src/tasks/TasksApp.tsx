import { useCallback, useEffect, useRef, useState } from "react";
import { SHELL_ROUTE_EVENT } from "../shell/locationSignal";
import type { TaskNotify } from "./taskActions";
import { notifier } from "../ui/notify";

import { PageHeader } from "../shell/PageHeader";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { readHistoryDepth } from "../appShellNavigation";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, locationUrl, routeFromLocation, type Route } from "../router";
import { boardSprintsRoute, cardCloseAction, createTasksEntryLog, fullPageAction, savedViewOf, savedViewStep, tasksBackAction, tasksHomeRoute, tasksRoute, withFromDialogHint, type TasksRoute } from "../tasksRoute";
import { TasksHome } from "./home/TasksHome";
import type { TasksHome as TasksHomeRoute } from "./home/homeUrl";
import { BoardView } from "./BoardView";
import { DEFAULT_BOARD_QUERY, withBoardQuery, type BoardQuery, type BoardViewId } from "./boardUrl";
import type { TaskQuery } from "../../shared/taskQuery";
import type { TaskView } from "./home/homeApi";
import { boardLayoutOf, boardViewFilter, homeLayoutOf } from "./views/boardViewModel";
import { resolveLocation } from "../friendlyLinks";
import { onRouteNames } from "../routeNames";
import "../bin/bin.css";
import "../files/files.css";
import "./tasks.css";

export type TasksNavigate = (route: Route, options?: { replace?: boolean }) => void;

type TasksAppProps = {
  userId: string;
  displayName: string;
  navigate: TasksNavigate;
  /** The app toast (unused: Tasks calls the shared toasts, ui/notify.ts, which can carry Undo). */
  flash: (message: string) => void;
  onHome: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

const currentTasksRoute = (): TasksRoute => {
  const route = routeFromLocation(window.location);
  return route.app === "tasks" ? route : tasksRoute();
};

/**
 * Tasks: the board list (/tasks) and one board (/tasks/:boardId). Every view is a history entry;
 * dialogs and sheets push none (D18). Back steps card → board → list → Home.
 */
export function TasksApp({ userId, displayName, navigate, onHome, onSettings, onSignOut }: TasksAppProps) {
  const [route, setRoute] = useState<TasksRoute>(currentTasksRoute);
  const { readOnly } = useRole();
  // The shared toasts (ui/notify.ts). One with an action (Undo, Move, Open, View) stays long enough
  // to reach it, and pauses while hovered or focused (QA 0.9.0).
  const notify: TaskNotify = notifier;
  const routeRef = useRef(route);
  routeRef.current = route;
  // App's navigate is recreated on every render; read it through a ref so effects run once.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // The entries this visit wrote or landed on (review L6): closing a card steps back only onto one.
  const entryLogRef = useRef(createTasksEntryLog());
  const noteEntry = useCallback((wrote: boolean) => {
    entryLogRef.current.note(readHistoryDepth(window.history.state), locationUrl(window.location), wrote);
  }, []);
  useEffect(() => { noteEntry(false); }, [noteEntry]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (popStateClosedDialog(event)) return;
      const next = routeFromLocation(window.location);
      if (next.app !== "tasks") return;
      setRoute(next);
      noteEntry(false);
    };
    // The sidebar moved Tasks to another of its sections or a recent board (D1282): an entry this visit wrote.
    const onShellRoute = () => {
      const next = routeFromLocation(window.location);
      if (next.app !== "tasks") return;
      setRoute(next);
      noteEntry(true);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener(SHELL_ROUTE_EVENT, onShellRoute);
    return () => { window.removeEventListener("popstate", onPopState); window.removeEventListener(SHELL_ROUTE_EVENT, onShellRoute); };
  }, [noteEntry]);


  const go = useCallback((next: TasksRoute, replace = false) => {
    setRoute(next);
    if (formatRoute(next) !== locationUrl(window.location) || replace) {
      navigateRef.current(next, { replace });
      noteEntry(true);
    }
  }, [noteEntry]);

  const back = useCallback(() => {
    const action = tasksBackAction(routeRef.current, readHistoryDepth(window.history.state));
    if (action.kind === "history") window.history.back();
    else if (action.kind === "replace") go(action.route, true);
    else onHome();
  }, [go, onHome]);

  // A card is a view with its own entry: opening pushes it, and closing steps back to the board
  // (or replaces the entry with its board when the entry below is not one this visit saw: a deep
  // link, a reload, or a card opened from Notifications or another app, review L6). The card's URL carries the board's
  // query, so closing it returns to the same view and filters (D112).
  const openCard = useCallback((cardId: string) => {
    const current = routeRef.current;
    if (current.boardId) go(tasksRoute(current.boardId, cardId, false, current.query, savedViewOf(current)));
  }, [go]);
  // Expand pushes the card as a full page with a hint that the dialog is the entry below (§4.7);
  // Collapse and Close step back through those entries, or replace a deep-linked one.
  const expandCard = useCallback(() => {
    const current = routeRef.current;
    if (!current.boardId || !current.cardId || current.full) return;
    go(tasksRoute(current.boardId, current.cardId, true, current.query, savedViewOf(current)));
    window.history.replaceState(withFromDialogHint(window.history.state), "", `${window.location.pathname}${window.location.search}`);
  }, [go]);
  const leaveFullPage = useCallback((action: "collapse" | "close") => {
    const depth = readHistoryDepth(window.history.state);
    // The Expand hint counts only when this visit saw the entries it points back to (not after a reload).
    const seen = entryLogRef.current.urlAt(depth - (action === "collapse" ? 1 : 2)) !== undefined;
    const step = fullPageAction(action, routeRef.current, seen ? window.history.state : null, depth);
    if (step.kind === "history") window.history.go(step.delta);
    else go(step.route, true);
  }, [go]);
  const collapseCard = useCallback(() => leaveFullPage("collapse"), [leaveFullPage]);
  const closeCard = useCallback(() => {
    const current = routeRef.current;
    if (!current.cardId) return;
    if (current.full) {
      leaveFullPage("close");
      return;
    }
    const step = cardCloseAction(current, readHistoryDepth(window.history.state), entryLogRef.current);
    if (step.kind === "history") window.history.back();
    else go(step.route, true);
  }, [go, leaveFullPage]);

  // The board's view and filters live in the URL query (D112): switching the view pushes an
  // entry, and filter, sort, and group edits replace it, so Back steps through views, not chips.
  const changeQuery = useCallback((query: BoardQuery, options: { push?: boolean; unsaved?: boolean } = {}) => {
    const current = routeRef.current;
    if (!current.boardId) return;
    // Under a saved view (D636) the filter is in the URL only while it differs from the view's.
    const view = current.viewId ? { viewId: current.viewId, unsaved: options.unsaved === true } : null;
    // A change made from the Sprints sheet (starting a sprint) keeps the sheet open.
    go(current.sprints ? boardSprintsRoute(current.boardId, query, view) : tasksRoute(current.boardId, current.cardId, current.full === true, query, view), !options.push);
  }, [go]);

  // Saved views on a board (D635–D638). Picking a view pushes it in its saved layout; after a save
  // or a delete the entry is replaced, keeping the layout on screen. All cards keeps the layout.
  const showSavedView = useCallback((view: TaskView | null, options: { replace?: boolean } = {}) => {
    const current = routeRef.current;
    if (!current.boardId) return;
    const presentation = withBoardQuery(current.query ?? DEFAULT_BOARD_QUERY, { filter: { terms: [] } });
    const query = view && !options.replace ? withBoardQuery(DEFAULT_BOARD_QUERY, { view: boardLayoutOf(view.display), swim: null }) : view ? presentation : withBoardQuery(presentation, { sprint: null });
    go(tasksRoute(current.boardId, null, false, query, view ? { viewId: view.id } : null), options.replace === true);
  }, [go]);
  /**
   * The view is not on this board any more (D636), or its Board field widened it to more boards
   * (lane VIEWS2, D661): its cross-board page, carrying the change as unsaved; this entry is replaced,
   * as a filter edit replaces.
   */
  const leaveSavedView = useCallback((viewId: string, change?: { filter: TaskQuery; layout: BoardViewId }) => {
    const query = change ? { layout: homeLayoutOf(change.layout), group: "none" as const, sort: "due" as const, filter: change.filter } : undefined;
    go(tasksHomeRoute({ section: "view", viewId, ...(query ? { query } : {}) }), true);
  }, [go]);
  /** A view on one board opens as that board (D635, D636), with an unsaved filter carried over when it has one. */
  const openBoardView = useCallback((view: TaskView & { board_id: string }, options: { replace?: boolean; filter?: TaskQuery } = {}) => {
    const layout = withBoardQuery(DEFAULT_BOARD_QUERY, { view: boardLayoutOf(view.display), swim: null });
    const query = options.filter ? withBoardQuery(layout, { filter: boardViewFilter(options.filter, view.board_id) }) : layout;
    go(tasksRoute(view.board_id, null, false, query, { viewId: view.id, unsaved: options.filter !== undefined }), options.replace === true);
  }, [go]);

  // The Sprints sheet is a route (/tasks/:b/sprints): opening pushes it over the board's view, and
  // closing steps back to the board, or replaces a deep-linked entry with it.
  const openSprints = useCallback(() => {
    const current = routeRef.current;
    if (current.boardId) go(boardSprintsRoute(current.boardId, current.query, savedViewOf(current)));
  }, [go]);
  const closeSprints = useCallback(() => {
    const current = routeRef.current;
    if (!current.sprints) return;
    const step = cardCloseAction(current, readHistoryDepth(window.history.state), entryLogRef.current);
    if (step.kind === "history") window.history.back();
    else go(step.route, true);
  }, [go]);

  // The home segments and views are routes (17C, §9.5): a segment tap, a layout switch, or a
  // committed filter change pushes; value edits replace. A card from cross-board results pushes
  // its board's card URL, so closing it (or Back) returns to the list it came from.
  // `saved`: a view's Save, which lands on the saved view; when the entry below already is that
  // view, step back onto it rather than leave a Back that goes nowhere (review L6a).
  const goHome = useCallback((home: TasksHomeRoute | undefined, options: { replace?: boolean; saved?: boolean } = {}) => {
    const next = home ? tasksHomeRoute(home) : tasksRoute();
    if (options.saved && savedViewStep(readHistoryDepth(window.history.state), formatRoute(next), entryLogRef.current) === "back") {
      setRoute(next);
      window.history.back();
      return;
    }
    go(next, options.replace === true);
  }, [go]);
  const openResultCard = useCallback((card: { board_id: string; id: string }) => go(tasksRoute(card.board_id, card.id)), [go]);

  const onMissing = useCallback(() => {
    notify.warning("Board not found");
    go(tasksRoute(), true);
  }, [notify, go]);

  // A board code or card key this tab has no name for yet (/tasks/MYT, /tasks/MYT-12, D713, D781):
  // resolve it, then read the location again and replace the entry with the canonical URL (an old
  // key or code becomes the current one). One this person cannot read is "not found" (T460, T490).
  const pending = route.pending ?? null;
  const pendingKey = pending ? `${pending.kind}:${pending.ref}` : null;
  useEffect(() => {
    if (!pending) return;
    let live = true;
    resolveLocation().then((resolved) => {
      if (!live) return;
      if (resolved === "missing" || resolved.app !== "tasks" || resolved.pending) {
        notify.warning(pending.kind === "card" ? `Card ${pending.ref} not found` : "Board not found");
        go(tasksRoute(), true);
      } else go(resolved, true);
    }, () => {
      if (!live) return;
      notify.warning(pending.kind === "card" ? "Could not open that card" : "Could not open that board");
      go(tasksRoute(), true);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the link, not the route object
  }, [pendingKey, go, notify]);
  // The address bar may be canonicalized in place (routeNames.ts): keep this visit's entry log on it.
  useEffect(() => onRouteNames(() => noteEntry(false)), [noteEntry]);
  // The open card moved to another board (D716), or an old link named the wrong board: follow it there.
  const followCard = useCallback((boardId: string, cardId: string) => go(tasksRoute(boardId, cardId), true), [go]);

  return <main data-read-only={readOnly ? "true" : undefined} className={`app-page tasks-app${route.boardId ? " tasks-board-open" : ""}`}>
    <PageHeader title="Tasks" />
    <ReadOnlyBanner />
    {pending && !route.boardId
      ? <p className="bin-loading" role="status">Opening {pending.kind === "card" ? pending.ref : "the board"}…</p>
      : route.boardId
      ? <BoardView key={route.boardId} userId={userId} boardId={route.boardId} openCardId={route.cardId} openCardFull={route.full === true} onExpandCard={expandCard} onCollapseCard={collapseCard} onOpenCard={openCard} onCloseCard={closeCard} onBack={back} onMissing={onMissing} notify={notify} onBoardDeleted={() => go(tasksRoute(), true)} onOpenBoard={(boardId) => go(tasksRoute(boardId))}
        onCardElsewhere={followCard}
        onOpenCardRoute={(boardId, cardId) => go(boardId === routeRef.current.boardId ? tasksRoute(boardId, cardId, false, routeRef.current.query, savedViewOf(routeRef.current)) : tasksRoute(boardId, cardId))}
        query={route.query ?? DEFAULT_BOARD_QUERY} onQueryChange={changeQuery} sprintsOpen={route.sprints === true} onOpenSprints={openSprints} onCloseSprints={closeSprints}
        savedViewId={route.viewId ?? null} viewUnsaved={route.unsaved === true} onSavedView={showSavedView} onLeaveSavedView={leaveSavedView} displayName={displayName} />
      : <TasksHome userId={userId} home={route.home} onHome={goHome} onOpenBoard={(board) => go(tasksRoute(board.id))} onOpenBoardId={(boardId) => go(tasksRoute(boardId))}
        onOpenCard={openResultCard} onOpenBoardView={openBoardView} onBack={back} notify={notify} />}
  </main>;
}
