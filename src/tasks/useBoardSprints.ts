import { useCallback, useMemo, type Dispatch, type SetStateAction } from "react";
import { FLAT_STRUCTURE } from "../../shared/boardStructure";
import { withBoardQuery, type BoardQuery } from "./boardUrl";
import { orderSprints, resolveSprintSelection, selectionTerm, sprintQueryValue, withSprint, type SprintSelection } from "./sprintModel";
import type { TaskNotify } from "./taskActions";
import type { SprintDefaults } from "../../shared/sprintPlan";
import { completeSprint, createSprint, deleteSprint, taskErrorMessage, updateBoardStructure, updateSprint, type BoardDetail, type SprintCarryTo, type SprintFields, type SprintSummary } from "./tasksApi";

type Options = {
  detail: BoardDetail | null;
  setDetail: Dispatch<SetStateAction<BoardDetail | null>>;
  query: BoardQuery;
  onQueryChange: (query: BoardQuery, options?: { push?: boolean }) => void;
  notify: TaskNotify;
  load: () => Promise<void>;
};

const cards = (count: number) => count === 1 ? "1 card" : `${count} cards`;

/**
 * The board's sprints (research 2026-09-26 §7.3, §7.5, 17B), kept out of BoardView: which sprint
 * the board shows (`?sprint=` in the URL, the active sprint by default), the grammar term that
 * scopes the views to it, and the owner's sprint actions. Every action refreshes the sprint list
 * from the server's answer; completing one reloads the board, since cards moved.
 */
export function useBoardSprints({ detail, setDetail, query, onQueryChange, notify, load }: Options) {
  const structure = detail?.board.structure ?? FLAT_STRUCTURE;
  const sprints = useMemo(() => detail?.sprints ?? [], [detail]);
  const selection: SprintSelection | null = resolveSprintSelection(query.sprint, sprints, structure);

  const setSprints = useCallback((change: (current: SprintSummary[]) => SprintSummary[]) =>
    setDetail((current) => current ? { ...current, sprints: change(current.sprints ?? []) } : current), [setDetail]);

  /** Shows a sprint, the backlog, or every card; a pick is a committed change, so it gets its own Back step. */
  const select = useCallback((value: string) => {
    onQueryChange(withBoardQuery(query, { sprint: sprintQueryValue(value, sprints) }), { push: true });
  }, [onQueryChange, query, sprints]);

  const create = useCallback(async (fields: SprintFields & { name: string }) => {
    if (!detail) return null;
    try {
      const { sprint } = await createSprint(detail.board.id, fields);
      setSprints((current) => withSprint(current, sprint));
      notify(`Added ${sprint.name}`);
      return sprint;
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not add the sprint"));
      return null;
    }
  }, [detail, notify, setSprints]);

  const update = useCallback(async (sprint: SprintSummary, change: SprintFields) => {
    try {
      const { sprint: saved } = await updateSprint(sprint.id, change);
      setSprints((current) => withSprint(current, saved));
      return true;
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not change the sprint"));
      return false;
    }
  }, [notify, setSprints]);

  /** Starts a planned sprint; the board then shows it (it is the current sprint, so the URL drops `sprint`). */
  const start = useCallback(async (sprint: SprintSummary) => {
    try {
      const { sprint: saved } = await updateSprint(sprint.id, { state: "active" });
      setSprints((current) => withSprint(current, saved));
      notify(`${saved.name} started`);
      if (query.sprint) onQueryChange(withBoardQuery(query, { sprint: null }), { push: true });
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not start the sprint"));
      void load();
    }
  }, [load, notify, onQueryChange, query, setSprints]);

  const remove = useCallback(async (sprint: SprintSummary) => {
    try {
      await deleteSprint(sprint.id);
      setSprints((current) => current.filter((item) => item.id !== sprint.id));
      notify(`Deleted ${sprint.name}`);
      if (query.sprint === sprint.id) onQueryChange(withBoardQuery(query, { sprint: null }));
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not delete the sprint"));
    }
  }, [notify, onQueryChange, query, setSprints]);

  /**
   * Completes the active sprint with carry-over (D131). The toast says where the unfinished cards
   * went and offers to show that sprint (or the backlog). Errors are thrown for the dialog to show.
   */
  const complete = useCallback(async (sprint: SprintSummary, carryTo: SprintCarryTo, next: SprintFields = {}) => {
    const result = await completeSprint(sprint.id, carryTo, next);
    setSprints((current) => orderSprints([...current.filter((item) => item.id !== result.sprint.id && item.id !== result.target?.id), result.sprint, ...(result.target ? [result.target] : [])]));
    const where = result.target ? result.target.name : "the backlog";
    // The board keeps showing the completed sprint (its done cards; with no active sprint the default
    // would jump to the backlog), and View follows the unfinished cards. No sprint is active now, so
    // the backlog is the default view (no `sprint` in the URL).
    onQueryChange(withBoardQuery(query, { sprint: result.sprint.id }));
    notify(`${result.sprint.name} completed${result.carried ? ` · ${cards(result.carried)} moved to ${where}` : ""}`, {
      label: "View", run: () => onQueryChange(withBoardQuery(query, { sprint: result.target ? result.target.id : null }), { push: true })
    });
    void load();
    return result;
  }, [load, notify, onQueryChange, query, setSprints]);

  /** Saves the board's sprint defaults into its structure (owner, Board settings → Sprint defaults). */
  const saveDefaults = useCallback(async (defaults: SprintDefaults) => {
    if (!detail) return false;
    try {
      const { board } = await updateBoardStructure(detail.board.id, { ...structure, sprintDefaults: defaults });
      setDetail((current) => current ? { ...current, board } : current);
      notify("Sprint defaults saved");
      return true;
    } catch (reason) {
      notify(taskErrorMessage(reason, "Could not save the sprint defaults"));
      return false;
    }
  }, [detail, notify, setDetail, structure]);

  /** New sprint, then (Create and start) start it. */
  const createAndMaybeStart = useCallback(async (fields: SprintFields & { name: string }, andStart: boolean) => {
    const made = await create(fields);
    if (!made) return false;
    if (andStart) await start(made);
    return true;
  }, [create, start]);

  return {
    enabled: structure.sprints,
    /** The board's sprint defaults (length, start rule, name pattern), when set. */
    defaults: structure.sprintDefaults ?? null,
    saveDefaults,
    createAndMaybeStart,
    sprints,
    selection,
    /** The term the views add to the board's filter, or null (no sprints, or All cards). */
    term: selectionTerm(selection),
    /** The sprint new cards start in: the one on screen, unless it is completed. */
    composerSprintId: selection?.kind === "sprint" && selection.sprint.state !== "completed" ? selection.sprint.id : null,
    select,
    create,
    update,
    start,
    remove,
    complete
  };
}

export type BoardSprints = ReturnType<typeof useBoardSprints>;
