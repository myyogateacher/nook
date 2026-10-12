import type { Notifier } from "../ui/notify";
import { useCallback, useRef, useState } from "react";
import { createRow, errorCode, errorMessage, errorPayload, patchRow, queryRows, type CollectionRow, type FieldValue, type QueryRequest } from "./collectionsApi";

export const PAGE_SIZE = 100;

type RowsState = { rows: CollectionRow[]; nextCursor: string | null; total: number; schemaVersion: number | null };

/**
 * Rows of one collection as the current query returns them, plus the write path every editor
 * uses: one save at a time per row, each sent with the row's latest revision (CAS). A 409
 * ROW_CHANGED keeps the user's screen and records the server's row so the UI can offer Reload.
 */
export function useRows(collectionId: string, notify: Notifier) {
  const [state, setState] = useState<RowsState>({ rows: [], nextCursor: null, total: 0, schemaVersion: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, CollectionRow>>({});
  const rowsRef = useRef<CollectionRow[]>([]);
  rowsRef.current = state.rows;
  const queues = useRef(new Map<string, Promise<unknown>>());
  const generation = useRef(0);
  const specRef = useRef<QueryRequest>({});

  const load = useCallback(async (spec: QueryRequest) => {
    const current = ++generation.current;
    specRef.current = spec;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await queryRows(collectionId, { ...spec, limit: PAGE_SIZE });
      if (current !== generation.current) return;
      setState({ rows: result.rows, nextCursor: result.nextCursor, total: result.total, schemaVersion: result.schemaVersion });
      setConflicts({});
    } catch (reason) {
      if (current === generation.current) setLoadError(errorMessage(reason, "Could not load the rows"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [collectionId]);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor) return;
    const current = generation.current;
    try {
      const result = await queryRows(collectionId, { ...specRef.current, cursor, limit: PAGE_SIZE });
      if (current !== generation.current) return;
      setState((previous) => {
        const known = new Set(previous.rows.map((row) => row.id));
        return { rows: [...previous.rows, ...result.rows.filter((row) => !known.has(row.id))], nextCursor: result.nextCursor, total: result.total, schemaVersion: result.schemaVersion };
      });
    } catch (reason) {
      // The fields changed under the cursor: start over from the first page.
      if (errorCode(reason) === "SCHEMA_CHANGED") void load(specRef.current);
      else notify.error(errorMessage(reason, "Could not load more rows"));
    }
  }, [collectionId, load, notify, state.nextCursor]);

  const replaceRow = useCallback((row: CollectionRow) => {
    setState((previous) => ({ ...previous, rows: previous.rows.map((item) => item.id === row.id ? row : item) }));
    setConflicts((previous) => {
      if (!previous[row.id]) return previous;
      const next = { ...previous };
      delete next[row.id];
      return next;
    });
  }, []);

  const removeRow = useCallback((rowId: string) => {
    setState((previous) => ({ ...previous, rows: previous.rows.filter((row) => row.id !== rowId), total: Math.max(0, previous.total - 1) }));
  }, []);

  const addRow = useCallback((row: CollectionRow) => {
    setState((previous) => ({ ...previous, rows: [...previous.rows, row], total: previous.total + 1 }));
  }, []);

  /** Saves a change to one row; resolves to the stored row, or null when it was not saved. */
  const save = useCallback((rowId: string, values: Record<string, FieldValue | null>, known?: () => CollectionRow | null) => {
    const previous = queues.current.get(rowId) ?? Promise.resolve();
    const next = previous.then(async (): Promise<CollectionRow | null> => {
      // The row panel may show a row outside the loaded page; it passes its own latest copy.
      const row = rowsRef.current.find((item) => item.id === rowId) ?? known?.() ?? null;
      if (!row) return null;
      try {
        const { row: saved } = await patchRow(rowId, values, row.revision);
        replaceRow(saved);
        return saved;
      } catch (reason) {
        const code = errorCode(reason);
        if (code === "ROW_CHANGED") {
          const current = errorPayload<{ row?: CollectionRow }>(reason)?.row;
          if (current) setConflicts((items) => ({ ...items, [rowId]: current }));
          notify.warning("Someone else changed this row. Reload it to see their change.");
        } else if (code === "INVALID_VALUES") {
          const fieldErrors = errorPayload<{ fieldErrors?: Record<string, string> }>(reason)?.fieldErrors ?? {};
          notify.warning(Object.values(fieldErrors)[0] ?? "That value is not valid");
        } else {
          notify.error(errorMessage(reason, "Could not save the change"));
        }
        return null;
      }
    });
    queues.current.set(rowId, next.catch(() => null));
    return next;
  }, [notify, replaceRow]);

  const create = useCallback(async (values: Record<string, FieldValue | null>) => {
    try {
      const { row } = await createRow(collectionId, values);
      addRow(row);
      return row;
    } catch (reason) {
      const fieldErrors = errorPayload<{ fieldErrors?: Record<string, string> }>(reason)?.fieldErrors;
      notify.error(fieldErrors ? `Could not add the row: ${Object.values(fieldErrors)[0]}` : errorMessage(reason, "Could not add the row"));
      return null;
    }
  }, [addRow, collectionId, notify]);

  /** Reload after ROW_CHANGED: show the server's row and drop the conflict. */
  const acceptConflict = useCallback((rowId: string) => {
    const row = conflicts[rowId];
    if (row) replaceRow(row);
  }, [conflicts, replaceRow]);

  return { ...state, loading, loadError, conflicts, load, loadMore, save, create, replaceRow, removeRow, addRow, acceptConflict, reload: () => load(specRef.current) };
}
