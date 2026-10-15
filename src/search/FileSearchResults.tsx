import { useEffect, useState } from "react";
import { FileText, Users } from "lucide-react";
import { api } from "../api";
import { isSearchable, searchErrorMessage, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS, type SearchSegment } from "./searchApi";
import "./search.css";

/**
 * Files in search (lane FTS, migration 060): names and the text of Files text documents, found by
 * `GET /api/search?scope=files` on the Files full-text index, best first. Access is part of the query
 * (the Files list access, as `read_document_text`). Hits are text segments rendered as React text.
 * Used by the Files facet of the notes search and by the Files filter ("In file text").
 */

export type FileSearchHit = {
  id: string; name: string; title: SearchSegment[]; snippet: SearchSegment[]; folder_id: string | null; mime_type: string; size_bytes: number;
  owner_name: string; is_owner: 0 | 1; updated_at: string;
};
type State = { key: string; status: "ready" | "error"; results: FileSearchHit[]; truncated: boolean; error: string };

export const fileSearchPath = (query: string, limit = 20) =>
  `/search?${new URLSearchParams({ q: query.slice(0, SEARCH_MAX_CHARS), scope: "files", limit: String(limit) })}`;

/** File search once typing pauses, while `enabled`. */
export function useFileSearch(query: string, enabled: boolean) {
  const active = enabled && isSearchable(query);
  const key = active ? query : "";
  const [loaded, setLoaded] = useState<State | null>(null);
  useEffect(() => {
    if (!active) { setLoaded(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ results: FileSearchHit[]; truncated: boolean }>(fileSearchPath(query), { signal: controller.signal })
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

/** Whether the text matched (a snippet with a highlighted word), not only the name. */
export const matchedText = (hit: FileSearchHit) => hit.snippet.some((segment) => segment.hit);

export function FileSearchResults({ results, truncated, relativeTime, onOpen, label = "File results" }: {
  results: FileSearchHit[];
  truncated: boolean;
  relativeTime: (value: string) => string;
  onOpen: (hit: FileSearchHit) => void;
  label?: string;
}) {
  return <ul className="search-results whiteboard-search-results file-search-results" aria-label={label}>
    {results.map((hit) => <li key={hit.id} className="search-result whiteboard-search-result file-search-result">
      <button type="button" onClick={() => onOpen(hit)}>
        <span className="search-result-title"><FileText className="whiteboard-search-icon" aria-hidden="true" /><Marked segments={hit.title} fallback={hit.name} /></span>
        {matchedText(hit) && <span className="search-result-snippet"><Marked segments={hit.snippet} fallback="" /></span>}
        <span className="search-result-meta">
          <span>File</span>
          {hit.is_owner === 0 && <span className="search-result-owner"><Users aria-hidden="true" />{hit.owner_name}</span>}
          <time dateTime={hit.updated_at}>{relativeTime(hit.updated_at)}</time>
        </span>
      </button>
    </li>)}
    {truncated && <li className="search-results-more" role="presentation">Showing the top {results.length} matches. Add words to narrow the search.</li>}
  </ul>;
}
