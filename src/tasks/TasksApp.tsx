import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskNotify } from "./taskActions";
import { House, Sparkles } from "lucide-react";
import { AccountActions, useBinCount } from "../AppShell";
import { ReadOnlyBanner, useRole } from "../team/roleAccess";
import { readHistoryDepth } from "../appShellNavigation";
import { popStateClosedDialog } from "../historyDialogs";
import { formatRoute, locationUrl, routeFromLocation, type Route } from "../router";
import { boardSprintsRoute, cardCloseAction, createTasksEntryLog, fullPageAction, savedViewStep, tasksBackAction, tasksHomeRoute, tasksRoute, withFromDialogHint, type TasksRoute } from "../tasksRoute";
import { TasksHome } from "./home/TasksHome";
import type { TasksHome as TasksHomeRoute } from "./home/homeUrl";
import { BoardView } from "./BoardView";
import { DEFAULT_BOARD_QUERY, type BoardQuery } from "./boardUrl";
import "../bin/bin.css";
import "../files/files.css";
import "./tasks.css";

export type TasksNavigate = (route: Route, options?: { replace?: boolean }) => void;

type TasksAppProps = {
  userId: string;
  displayName: string;
  navigate: TasksNavigate;
  /** The app toast; Tasks shows its own so a message can carry Undo. */
  flash: (message: string) => void;
  onHome: () => void;
  /** Opens the Bin from the header, as on Home; hidden when the host does not wire it. */
  onBin?: () => void;
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
export function TasksApp({ userId, displayName, navigate, onHome, onBin, onSettings, onSignOut }: TasksAppProps) {
  const [route, setRoute] = useState<TasksRoute>(currentTasksRoute);
  const { readOnly } = useRole();
  const binCount = useBinCount(Boolean(onBin));
  // Tasks keeps its own toast so a message can carry an action (Undo after moving to the Bin). One
  // with an action (Undo, Move, Open, View) stays 15 s so there is time to reach it (QA 0.9.0).
  const [toast, setToast] = useState<{ id: number; message: string; action?: { label: string; run: () => void }; selectable?: boolean } | null>(null);
  const toastIdRef = useRef(0);
  const notify = useCallback<TaskNotify>((message, action, options) => setToast({ id: ++toastIdRef.current, message, action, selectable: options?.selectable === true }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), toast.action || toast.selectable ? 15000 : 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);
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
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
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
    const { boardId, query } = routeRef.current;
    if (boardId) go(tasksRoute(boardId, cardId, false, query));
  }, [go]);
  // Expand pushes the card as a full page with a hint that the dialog is the entry below (§4.7);
  // Collapse and Close step back through those entries, or replace a deep-linked one.
  const expandCard = useCallback(() => {
    const current = routeRef.current;
    if (!current.boardId || !current.cardId || current.full) return;
    go(tasksRoute(current.boardId, current.cardId, true, current.query));
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
  const changeQuery = useCallback((query: BoardQuery, options: { push?: boolean } = {}) => {
    const current = routeRef.current;
    if (!current.boardId) return;
    // A change made from the Sprints sheet (starting a sprint) keeps the sheet open.
    go(current.sprints ? boardSprintsRoute(current.boardId, query) : tasksRoute(current.boardId, current.cardId, current.full === true, query), !options.push);
  }, [go]);

  // The Sprints sheet is a route (/tasks/:b/sprints): opening pushes it over the board's view, and
  // closing steps back to the board, or replaces a deep-linked entry with it.
  const openSprints = useCallback(() => {
    const { boardId, query } = routeRef.current;
    if (boardId) go(boardSprintsRoute(boardId, query));
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
    notify("Board not found");
    go(tasksRoute(), true);
  }, [notify, go]);

  return <main data-read-only={readOnly ? "true" : undefined} className={`app-page tasks-app${route.boardId ? " tasks-board-open" : ""}`}>
    <header className="app-page-header">
      <button className="app-home-button" onClick={onHome}><House />Home</button>
      <span className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Tasks</strong></span></span>
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={onBin} binCount={binCount} />
    </header>
    <ReadOnlyBanner />
    {route.boardId
      ? <BoardView key={route.boardId} userId={userId} boardId={route.boardId} openCardId={route.cardId} openCardFull={route.full === true} onExpandCard={expandCard} onCollapseCard={collapseCard} onOpenCard={openCard} onCloseCard={closeCard} onBack={back} onMissing={onMissing} notify={notify} onBoardDeleted={() => go(tasksRoute(), true)} onOpenBoard={(boardId) => go(tasksRoute(boardId))}
        onOpenCardRoute={(boardId, cardId) => go(tasksRoute(boardId, cardId, false, boardId === routeRef.current.boardId ? routeRef.current.query : null))}
        query={route.query ?? DEFAULT_BOARD_QUERY} onQueryChange={changeQuery} sprintsOpen={route.sprints === true} onOpenSprints={openSprints} onCloseSprints={closeSprints} />
      : <TasksHome userId={userId} home={route.home} onHome={goHome} onOpenBoard={(board) => go(tasksRoute(board.id))} onOpenBoardId={(boardId) => go(tasksRoute(boardId))}
        onOpenCard={openResultCard} onBack={back} notify={notify} />}
    {toast && <div className="toast file-toast" role="status">
      <span className={toast.selectable ? "task-toast-selectable" : undefined}>{toast.message}</span>
      {toast.action && <button className="file-toast-action" onClick={() => { const run = toast.action!.run; setToast(null); run(); }}>{toast.action.label}</button>}
    </div>}
  </main>;
}
