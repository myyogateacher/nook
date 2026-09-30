import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, FileText, KanbanSquare, Link2Off, NotebookText, PenTool, Search, SquareCheckBig, Table2, Upload } from "lucide-react";
import { api } from "../api";
import { ModalDialog } from "../files/Dialog";
import { IMAGE_ACCEPT, imageContentUrl } from "../editor/imageUpload";
import { isModuleEnabled, useDisabledModules, type ModuleId } from "../modules";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { DocumentSummary, NoteSummary } from "../types";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";
import { listWhiteboards } from "./whiteboardsApi";
import "../ui/pickerSheet.css";

/**
 * Nook's own pickers on the canvas (Wave 24): pictures from Files (D198) and links to Nook items
 * (D199). Each is a sheet (full screen on a phone) and one history layer: Back closes it (D18).
 * Lists come from the same routes as the modules themselves, so they only ever show what the
 * viewer can open.
 */

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

function PickerSheet({ title, eyebrow, onClose, query, onQuery, placeholder, children, top }: {
  title: string; eyebrow: string; onClose: () => void; query: string; onQuery: (value: string) => void; placeholder: string; children: ReactNode; top?: ReactNode;
}) {
  useHistoryDialogGuard(true, onClose);
  const searchId = useId();
  return <ModalDialog title={title} eyebrow={eyebrow} onClose={onClose} variant="sheet" className="nook-picker">
    {top}
    <label className="nook-picker-search" htmlFor={searchId}>
      <Search aria-hidden="true" />
      <input id={searchId} type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} enterKeyHint="search" />
    </label>
    <div className="nook-picker-body">{children}</div>
  </ModalDialog>;
}

const matches = (text: string, needle: string) => !needle || text.toLowerCase().includes(needle);

/** Insert image: the viewer's own pictures and the ones shared with them, or a new upload. */
export function ImagePickerSheet({ onPick, onUpload, onClose }: {
  onPick: (document: Pick<DocumentSummary, "id" | "name" | "mime_type">) => void;
  onUpload: (files: File[]) => void;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    api<{ documents: DocumentSummary[] }>("/files")
      .then((result) => { if (live) setDocuments(result.documents.filter((document) => document.preview_kind === "image" && document.kind !== "whiteboard")); })
      .catch((reason) => { if (live) setError(messageOf(reason, "Could not load your pictures")); });
    return () => { live = false; };
  }, []);
  const needle = query.trim().toLowerCase();
  const visible = (documents ?? []).filter((document) => matches(document.name, needle)).slice(0, 120);
  return <PickerSheet title="Insert image" eyebrow="Whiteboard" onClose={onClose} query={query} onQuery={setQuery} placeholder="Search your pictures"
    top={<div className="nook-picker-actions">
      <button type="button" className="primary-button" onClick={() => input.current?.click()}><Upload />Upload a picture</button>
      <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) onUpload(files);
      }} />
      <p className="nook-picker-hint">Uploaded pictures are saved in Files, in this whiteboard's folder. People you share the board with see a picture only if they can open its file.</p>
    </div>}>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!error && !documents && <p className="nook-picker-empty" role="status">Loading your pictures…</p>}
    {documents && visible.length === 0 && <p className="nook-picker-empty">{documents.length ? "No pictures match." : "No pictures in Files yet. Upload one."}</p>}
    {visible.length > 0 && <ul className="nook-picker-images" aria-label="Pictures">
      {visible.map((document) => <li key={document.id}>
        <button type="button" onClick={() => onPick(document)} title={document.name}>
          <span className="nook-picker-image"><img src={imageContentUrl(document.id)} alt="" loading="lazy" draggable={false} /></span>
          <span className="nook-picker-name">{document.name}</span>
        </button>
      </li>)}
    </ul>}
  </PickerSheet>;
}

type LinkKind = "note" | "file" | "whiteboard" | "board" | "card" | "collection" | "event";
type LinkItem = { key: string; path: string; title: string; detail?: string };
const LINK_KINDS: Array<{ kind: LinkKind; label: string; module: ModuleId; Icon: typeof FileText }> = [
  { kind: "note", label: "Notes", module: "notes", Icon: NotebookText },
  { kind: "file", label: "Files", module: "files", Icon: FileText },
  { kind: "whiteboard", label: "Whiteboards", module: "whiteboards", Icon: PenTool },
  { kind: "board", label: "Task boards", module: "tasks", Icon: KanbanSquare },
  { kind: "card", label: "Cards", module: "tasks", Icon: SquareCheckBig },
  { kind: "collection", label: "Collections", module: "collections", Icon: Table2 },
  { kind: "event", label: "Events", module: "calendar", Icon: CalendarDays }
];

const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

async function loadItems(kind: Exclude<LinkKind, "card">): Promise<LinkItem[]> {
  switch (kind) {
    case "note": return (await api<{ notes: NoteSummary[] }>("/notes")).notes.map((note) => ({ key: note.id, path: `/notes/${note.id}`, title: note.title || "Untitled" }));
    case "file": return (await api<{ documents: DocumentSummary[] }>("/files")).documents.filter((document) => document.kind !== "whiteboard").map((document) => ({ key: document.id, path: `/files/${document.id}`, title: document.name }));
    case "whiteboard": return (await listWhiteboards("all")).whiteboards.map((board) => ({ key: board.id, path: `/whiteboards/${board.id}`, title: whiteboardDisplayName(board.name) }));
    case "board": return (await api<{ boards: Array<{ id: string; name: string }> }>("/tasks/boards")).boards.map((board) => ({ key: board.id, path: `/tasks/${board.id}`, title: board.name }));
    case "collection": return (await api<{ collections: Array<{ id: string; name: string }> }>("/collections")).collections.map((collection) => ({ key: collection.id, path: `/collections/${collection.id}`, title: collection.name }));
    case "event": {
      const today = new Date();
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 14);
      const to = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 85);
      let zone = "UTC";
      try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* UTC */ }
      const params = new URLSearchParams({ from: isoDay(from), to: isoDay(to), tz: zone });
      const { occurrences } = await api<{ occurrences: Array<{ eventId: string; title: string; date: string }> }>(`/events?${params.toString()}`);
      const seen = new Set<string>();
      return occurrences.flatMap((occurrence) => {
        if (seen.has(occurrence.eventId)) return [];
        seen.add(occurrence.eventId);
        return [{ key: occurrence.eventId, path: `/calendar/event/${occurrence.eventId}`, title: occurrence.title || "Untitled event", detail: occurrence.date }];
      });
    }
  }
}

/** Link to a Nook item (D199): the shape gets the item's in-app path; nothing is fetched or unfurled. */
export function LinkPickerSheet({ currentLink, onPick, onRemove, onClose }: {
  currentLink: string | null;
  onPick: (path: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const disabled = useDisabledModules();
  const kinds = useMemo(() => LINK_KINDS.filter((entry) => isModuleEnabled(disabled, entry.module)), [disabled]);
  const [kind, setKind] = useState<LinkKind>(kinds[0]?.kind ?? "note");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LinkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<LinkKind, LinkItem[]>());
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    let live = true;
    setError(null);
    if (kind === "card") {
      if ([...needle].length < 2) { setItems([]); return; }
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        const params = new URLSearchParams({ q: needle.slice(0, 100) });
        api<{ results: Array<{ id: string; board_id: string; board_name: string; title: string }> }>(`/tasks/cards/search?${params.toString()}`, { signal: controller.signal })
          .then((result) => { if (live) setItems(result.results.map((card) => ({ key: card.id, path: `/tasks/${card.board_id}/card/${card.id}`, title: card.title, detail: card.board_name }))); })
          .catch((reason) => { if (live && !controller.signal.aborted) setError(messageOf(reason, "Could not search cards")); });
      }, 250);
      return () => { live = false; window.clearTimeout(timer); controller.abort(); };
    }
    const known = cache.current.get(kind);
    if (known) { setItems(known); return; }
    setItems(null);
    loadItems(kind)
      .then((loaded) => { cache.current.set(kind, loaded); if (live) setItems(loaded); })
      .catch((reason) => { if (live) setError(messageOf(reason, "Could not load these items")); });
    return () => { live = false; };
  }, [kind, kind === "card" ? needle : ""]);

  const visible = kind === "card" ? items ?? [] : (items ?? []).filter((item) => matches(item.title, needle)).slice(0, 150);
  const current = LINK_KINDS.find((entry) => entry.kind === kind)!;
  return <PickerSheet title="Link to a Nook item" eyebrow="Whiteboard" onClose={onClose} query={query} onQuery={setQuery}
    placeholder={kind === "card" ? "Search cards by title" : `Search ${current.label.toLowerCase()}`}
    top={<>
      <div className="nook-picker-kinds" role="group" aria-label="Kind of item">
        {kinds.map(({ kind: value, label, Icon }) => <button key={value} type="button" className={value === kind ? "active" : ""} aria-pressed={value === kind} onClick={() => setKind(value)}><Icon aria-hidden="true" />{label}</button>)}
      </div>
      {currentLink && <div className="nook-picker-actions nook-picker-current">
        <span>Links to <code>{currentLink}</code></span>
        <button type="button" className="secondary-button" onClick={onRemove}><Link2Off />Remove link</button>
      </div>}
    </>}>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!error && items === null && <p className="nook-picker-empty" role="status">Loading…</p>}
    {!error && items !== null && visible.length === 0 && <p className="nook-picker-empty">{kind === "card" && [...needle].length < 2 ? "Type at least two letters of a card's title." : "Nothing matches."}</p>}
    {visible.length > 0 && <ul className="nook-picker-list" aria-label={current.label}>
      {visible.map((item) => <li key={item.key}>
        <button type="button" onClick={() => onPick(item.path)}>
          <current.Icon aria-hidden="true" />
          <span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
        </button>
      </li>)}
    </ul>}
  </PickerSheet>;
}

