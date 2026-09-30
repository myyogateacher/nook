import { useEffect, useState } from "react";
import { PenTool, Users } from "lucide-react";
import { api } from "../api";
import { isSearchable, searchErrorMessage, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS, type SearchSegment } from "./searchApi";
import "./search.css";

/**
 * Whiteboards in search (Wave 24, whiteboard plan §10.7, D204): the "Whiteboards" facet next to
 * Notes. Board names and the text on boards, found by `GET /api/search?scope=whiteboards`, whose
 * access check is part of the query (T171, D73). Hits are text segments rendered as React text.
 */

export type WhiteboardSearchHit = { id: string; name: string; title: SearchSegment[]; snippet: SearchSegment[]; owner_name: string; is_owner: 0 | 1; updated_at: string };
type State = { key: string; status: "ready" | "error"; results: WhiteboardSearchHit[]; truncated: boolean; error: string };

export const whiteboardSearchPath = (query: string, limit = 20) =>
  `/search?${new URLSearchParams({ q: query.slice(0, SEARCH_MAX_CHARS), scope: "whiteboards", limit: String(limit) })}`;

/** Board search once typing pauses, while `enabled` (the facet is chosen). */
export function useWhiteboardSearch(query: string, enabled: boolean) {
  const active = enabled && isSearchable(query);
  const key = active ? query : "";
  const [loaded, setLoaded] = useState<State | null>(null);
  useEffect(() => {
    if (!active) { setLoaded(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ results: WhiteboardSearchHit[]; truncated: boolean }>(whiteboardSearchPath(query), { signal: controller.signal })
        .then((response) => setLoaded({ key, status: "ready", results: response.results, truncated: response.truncated, error: "" }))
        .catch((reason: unknown) => { if (!controller.signal.aborted) setLoaded({ key, status: "error", results: [], truncated: false, error: searchErrorMessage(reason) }); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, key]);
  const current = loaded && loaded.key === key ? loaded : null;
  return { active, status: !active ? "idle" as const : current?.status ?? "loading" as const, results: current?.results ?? [], truncated: current?.truncated ?? false, error: current?.error ?? "" };
}

function Marked({ segments, fallback }: { segments: SearchSegment[]; fallback: string }) {
  if (!segments.length) return <>{fallback}</>;
  return <>{segments.map((segment, index) => segment.hit ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>)}</>;
}

export function WhiteboardSearchResults({ results, truncated, relativeTime, onOpen }: {
  results: WhiteboardSearchHit[];
  truncated: boolean;
  relativeTime: (value: string) => string;
  onOpen: (hit: WhiteboardSearchHit) => void;
}) {
  return <ul className="search-results whiteboard-search-results" aria-label="Whiteboard results">
    {results.map((hit) => <li key={hit.id} className="search-result whiteboard-search-result">
      <button type="button" onClick={() => onOpen(hit)}>
        <span className="search-result-title"><PenTool className="whiteboard-search-icon" aria-hidden="true" /><Marked segments={hit.title} fallback={hit.name} /></span>
        {hit.snippet.length > 0 && <span className="search-result-snippet"><Marked segments={hit.snippet} fallback="" /></span>}
        <span className="search-result-meta">
          <span>Whiteboard</span>
          {hit.is_owner === 0 && <span className="search-result-owner"><Users aria-hidden="true" />{hit.owner_name}</span>}
          <time dateTime={hit.updated_at}>{relativeTime(hit.updated_at)}</time>
        </span>
      </button>
    </li>)}
    {truncated && <li className="search-results-more" role="presentation">Showing the top {results.length} matches. Add words to narrow the search.</li>}
  </ul>;
}
