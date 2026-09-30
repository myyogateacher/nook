import { useEffect, useId, useState, type FormEvent } from "react";
import { PenTool, Plus, Search } from "lucide-react";
import { ApiError } from "../api";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { whiteboardDisplayName } from "../../shared/whiteboardScene";
import { createWhiteboard, listWhiteboards, thumbnailUrl, type WhiteboardSummary } from "../whiteboards/whiteboardsApi";
import "../ui/pickerSheet.css";

/**
 * "Embed a whiteboard" in a note (whiteboard plan §10.5, D208): the boards the writer can read,
 * searchable by name, or New whiteboard, created in the note's folder (Default when that is not
 * theirs). A sheet at 390 px and one history layer: Back closes it. Loaded only when opened.
 */
export default function WhiteboardPicker({ folderId, onPick, onClose }: {
  folderId: string | null;
  onPick: (board: { id: string; name: string }) => void;
  onClose: () => void;
}) {
  const [boards, setBoards] = useState<WhiteboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const searchId = useId();
  const nameId = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  useEffect(() => {
    let live = true;
    listWhiteboards("all")
      .then((result) => { if (live) setBoards(result.whiteboards); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load your whiteboards"); });
    return () => { live = false; };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name for the new whiteboard.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let created: WhiteboardSummary;
      try {
        created = (await createWhiteboard(trimmed, folderId)).whiteboard;
      } catch (reason) {
        // A note in someone else's folder: the board goes to the writer's own Default folder.
        if (!(reason instanceof ApiError && reason.status === 404) || !folderId) throw reason;
        created = (await createWhiteboard(trimmed, null)).whiteboard;
      }
      onPick({ id: created.id, name: created.name });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the whiteboard");
      setBusy(false);
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = (boards ?? []).filter((board) => !needle || whiteboardDisplayName(board.name).toLowerCase().includes(needle)).slice(0, 150);
  return <ModalDialog title="Embed a whiteboard" eyebrow="Note" onClose={onClose} variant="sheet" className="nook-picker" busy={busy}>
    <form className="nook-picker-new" onSubmit={create}>
      <label className="sr-only" htmlFor={nameId}>New whiteboard name</label>
      <input id={nameId} value={name} maxLength={200} placeholder="New whiteboard name" autoComplete="off" onChange={(event) => { setName(event.target.value); setError(null); }} disabled={busy} />
      <button type="submit" className="primary-button" disabled={busy}><Plus />{busy ? "Creating…" : "New whiteboard"}</button>
    </form>
    <label className="nook-picker-search" htmlFor={searchId}>
      <Search aria-hidden="true" />
      <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your whiteboards" autoComplete="off" spellCheck={false} enterKeyHint="search" />
    </label>
    <div className="nook-picker-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!error && !boards && <p className="nook-picker-empty" role="status">Loading your whiteboards…</p>}
      {boards && visible.length === 0 && <p className="nook-picker-empty">{boards.length ? "No whiteboards match." : "No whiteboards yet. Name one above to create it."}</p>}
      {visible.length > 0 && <ul className="nook-picker-list" aria-label="Whiteboards">
        {visible.map((board) => <li key={board.id}>
          <button type="button" onClick={() => onPick({ id: board.id, name: board.name })} disabled={busy}>
            <span className="nook-picker-thumb">{board.hasThumbnail ? <img src={thumbnailUrl(board)} alt="" loading="lazy" draggable={false} /> : <PenTool aria-hidden="true" />}</span>
            <span><strong>{whiteboardDisplayName(board.name)}</strong><small>{board.is_owner === 1 ? "Yours" : `Shared by ${board.owner_name}`}</small></span>
          </button>
        </li>)}
      </ul>}
    </div>
  </ModalDialog>;
}
