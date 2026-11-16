import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { isSearchable, SEARCH_MAX_CHARS } from "../search/searchApi";
import type { SearchSection } from "../../shared/workspaceSearch";

/**
 * The palette's search across apps (D1340): `GET /api/search?scope=all` once the trimmed query has two
 * characters, 250 ms after the last keystroke, the previous request aborted. Answers are kept for the
 * palette's life, so deleting back to an earlier query asks nothing again. Searching shares the
 * 20-per-10-seconds budget with Notes' search: a 429 says so and tries once more after three seconds;
 * other failures say search is unavailable and leave the rest of the palette working.
 */

export type PaletteSearchRun = (query: string, signal: AbortSignal) => Promise<SearchSection[]>;
export type PaletteSearchState = { status: "idle" | "loading" | "ready" | "error"; query: string; sections: SearchSection[]; message?: string };

export const PALETTE_SEARCH_DEBOUNCE_MS = 250;
export const PALETTE_SEARCH_RETRY_MS = 3000;
const IDLE: PaletteSearchState = { status: "idle", query: "", sections: [] };

export function usePaletteSearch(query: string, run: PaletteSearchRun | undefined): PaletteSearchState {
  const [state, setState] = useState<PaletteSearchState>(IDLE);
  const cache = useRef(new Map<string, SearchSection[]>());
  const trimmed = query.trim().slice(0, SEARCH_MAX_CHARS);
  useEffect(() => {
    if (!run || !isSearchable(trimmed)) { setState(IDLE); return; }
    const cached = cache.current.get(trimmed);
    if (cached) { setState({ status: "ready", query: trimmed, sections: cached }); return; }
    const controller = new AbortController();
    // Earlier results stay on screen while the next query is asked (no flicker as the person types).
    setState((current) => ({ ...current, status: "loading", message: undefined }));
    let timer = 0;
    const ask = (retry: boolean) => {
      run(trimmed, controller.signal).then((sections) => {
        if (controller.signal.aborted) return;
        cache.current.set(trimmed, sections);
        setState({ status: "ready", query: trimmed, sections });
      }, (reason: unknown) => {
        if (controller.signal.aborted) return;
        const limited = reason instanceof ApiError && reason.status === 429;
        setState((current) => ({ ...current, status: "error", message: limited ? "Searching too quickly. Trying again in a moment…" : "Search across apps is unavailable right now." }));
        if (limited && !retry) timer = window.setTimeout(() => ask(true), PALETTE_SEARCH_RETRY_MS);
      });
    };
    timer = window.setTimeout(() => ask(false), PALETTE_SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [trimmed, run]);
  return state;
}
