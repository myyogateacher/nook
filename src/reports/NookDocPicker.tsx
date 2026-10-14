import { useEffect, useId, useRef, useState } from "react";
import { FileText, NotebookText, Search } from "lucide-react";
import { api } from "../api";
import { appName } from "../appName";
import { isSearchable, searchErrorMessage, searchNotes, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS } from "../search/searchApi";
import type { DocumentSummary } from "../types";

/** One thing the picker offers: a note (published or draft hit) or a Files text document. */
export type NookPick = { kind: "note" | "file"; id: string; title: string; detail: string };

/** The link a pick becomes: this instance's own route for it (shared/nookDocRef.ts reads it back). */
export const nookLinkOf = (pick: Pick<NookPick, "kind" | "id">, origin = window.location.origin) => `${origin}/${pick.kind === "note" ? "notes" : "files"}/${pick.id}`;

/** Files text documents whose name has every word of the query. */
export function matchingFiles(files: readonly DocumentSummary[], query: string, limit = 8): NookPick[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter((file) => file.preview_kind === "text" && (file.kind ?? "file") === "file" && words.every((word) => file.name.toLowerCase().includes(word)))
    .slice(0, limit).map((file) => ({ kind: "file", id: file.id, title: file.name, detail: `File · ${file.owner_name}` }));
}

/**
 * B4: "Pick from <APP_NAME>": search notes (GET /api/search, as the app's search) and Files text
 * documents (GET /api/files, by name), and pick one; it becomes this instance's link to it.
 */
export function NookDocPicker({ onPick, onClose }: { onPick: (pick: NookPick) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NookPick[]>([]);
  const [files, setFiles] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const inputId = useId();
  const listId = useId();
  const loadedFiles = useRef(false);

  useEffect(() => {
    if (loadedFiles.current) return;
    loadedFiles.current = true;
    api<{ documents: DocumentSummary[] }>("/files").then(({ documents }) => setFiles(documents)).catch(() => setFiles([]));
  }, []);

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

  const picks = [...notes, ...(query.trim() && files ? matchingFiles(files, query) : [])];
  return <div className="nook-doc-picker" role="group" aria-label={`Pick from ${appName()}`}>
    <label htmlFor={inputId} className="sr-only">Search {appName()}</label>
    <div className="nook-doc-picker-search">
      <Search aria-hidden="true" />
      <input id={inputId} type="search" value={query} maxLength={SEARCH_MAX_CHARS} autoFocus autoComplete="off" placeholder={`Search notes and text files in ${appName()}`} aria-controls={listId}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }} />
    </div>
    {error && <p className="file-dialog-hint" role="alert">{error}</p>}
    {query.trim() && !searching && !error && picks.length === 0 && <p className="file-dialog-hint" role="status">Nothing found. Notes need a published version; files must be text (.md, .txt, .csv, .json).</p>}
    <ul id={listId} className="nook-doc-picker-list">
      {picks.map((pick) => <li key={`${pick.kind}-${pick.id}`}>
        <button type="button" onClick={() => onPick(pick)}>
          {pick.kind === "note" ? <NotebookText aria-hidden="true" /> : <FileText aria-hidden="true" />}
          <span><strong>{pick.title}</strong><small>{pick.detail}</small></span>
        </button>
      </li>)}
    </ul>
  </div>;
}
