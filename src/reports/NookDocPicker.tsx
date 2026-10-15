import { useEffect, useId, useState } from "react";
import { FileText, NotebookText, Search } from "lucide-react";
import { api } from "../api";
import { appName } from "../appName";
import { isSearchable, searchErrorMessage, searchNotes, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS } from "../search/searchApi";
import type { NookFileHit, NookFileSearch } from "../../shared/reportsGenerate";

/** One thing the picker offers: a note (published or draft hit), a Files text document, or a Files PDF (D512). */
export type NookPick = { kind: "note" | "file"; id: string; title: string; detail: string; /** K4: a file's text around the match. */ snippet?: string | null };

/** The link a pick becomes: this instance's own route for it (shared/nookDocRef.ts reads it back). */
export const nookLinkOf = (pick: Pick<NookPick, "kind" | "id">, origin = window.location.origin) => `${origin}/${pick.kind === "note" ? "notes" : "files"}/${pick.id}`;

/** K4: a Files search hit as a pick. */
export const filePick = (hit: NookFileHit): NookPick => ({ kind: "file", id: hit.id, title: hit.name, detail: `${hit.pdf ? "PDF" : "File"} · ${hit.ownerName}${hit.matched === "text" ? " · matches its text" : ""}`, snippet: hit.snippet });
export const searchNookFiles = (query: string, cursor: string | null, signal?: AbortSignal) =>
  api<NookFileSearch>(`/reports/nook-files?q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal });

/**
 * B4: "Pick from <APP_NAME>": search notes (GET /api/search, as the app's search) and Files text
 * documents and PDFs with a text layer (K4, D512: GET /api/reports/nook-files, by name and text, a page at a time with "Search older
 * files"), and pick one; it becomes this instance's link to it.
 */
export function NookDocPicker({ onPick, onClose }: { onPick: (pick: NookPick) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NookPick[]>([]);
  const [files, setFiles] = useState<{ query: string; picks: NookPick[]; next: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const inputId = useId();
  const listId = useId();

  // K4: Files text documents and PDFs (D512) by name and text, the first page; "Search older files" asks for the next.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setFiles(null); setFileError(null); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchingFiles(true);
      searchNookFiles(trimmed, null, controller.signal).then((page) => {
        setFiles({ query: trimmed, picks: page.results.map(filePick), next: page.next });
        setFileError(null);
      }).catch((reason: unknown) => { if (!controller.signal.aborted) setFileError(searchErrorMessage(reason)); })
        .finally(() => { if (!controller.signal.aborted) setSearchingFiles(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  function searchOlder() {
    if (!files?.next) return;
    const current = files;
    setSearchingFiles(true);
    searchNookFiles(current.query, current.next, undefined).then((page) => {
      setFiles((now) => now && now.query === current.query ? { query: now.query, picks: [...now.picks, ...page.results.map(filePick).filter((pick) => !now.picks.some((item) => item.id === pick.id))], next: page.next } : now);
      setFileError(null);
    }).catch((reason: unknown) => setFileError(searchErrorMessage(reason))).finally(() => setSearchingFiles(false));
  }

  useEffect(() => {
    if (!isSearchable(query)) { setNotes([]); setError(null); return undefined; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchNotes(query, "all", controller.signal).then(({ results }) => {
        setNotes(results.slice(0, 8).map((hit) => ({ kind: "note", id: hit.id, title: hit.title.map((part) => part.text).join("") || "Untitled note", detail: `Note · ${hit.owner_name}${hit.source === "draft" ? " · draft (only a published version can be read)" : ""}` })));
        setError(null);
      }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(searchErrorMessage(reason)); }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const filePicks = files && files.query === query.trim() ? files.picks : [];
  const picks = [...notes, ...filePicks];
  const busy = searching || searchingFiles;
  return <div className="nook-doc-picker" role="group" aria-label={`Pick from ${appName()}`}>
    <label htmlFor={inputId} className="sr-only">Search {appName()}</label>
    <div className="nook-doc-picker-search">
      <Search aria-hidden="true" />
      <input id={inputId} type="search" value={query} maxLength={SEARCH_MAX_CHARS} autoFocus autoComplete="off" placeholder={`Search notes, text files, and PDFs in ${appName()}`} aria-controls={listId}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }} />
    </div>
    {(error ?? fileError) && <p className="file-dialog-hint" role="alert">{error ?? fileError}</p>}
    {query.trim() && !busy && !error && !fileError && picks.length === 0 && !files?.next && <p className="file-dialog-hint" role="status">Nothing found. Notes need a published version; files must be text (.md, .txt, .csv, .json) or PDFs with a text layer.</p>}
    <ul id={listId} className="nook-doc-picker-list">
      {picks.map((pick) => <li key={`${pick.kind}-${pick.id}`}>
        <button type="button" onClick={() => onPick(pick)}>
          {pick.kind === "note" ? <NotebookText aria-hidden="true" /> : <FileText aria-hidden="true" />}
          <span><strong>{pick.title}</strong><small>{pick.detail}</small>{pick.snippet && <small className="nook-doc-picker-snippet">{pick.snippet}</small>}</span>
        </button>
      </li>)}
    </ul>
    {files?.next && files.query === query.trim() && <button type="button" className="secondary-button nook-doc-picker-more" onClick={searchOlder} disabled={searchingFiles}>
      {searchingFiles ? "Searching files…" : filePicks.length ? "Search older files" : "No match in the newest files yet; search older files"}
    </button>}
  </div>;
}
