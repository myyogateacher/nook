import { useEffect, useRef, useState } from "react";
import { Copy, History, LoaderCircle, RotateCcw } from "lucide-react";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { getSnapshot, listSnapshots, type WhiteboardSnapshot } from "./whiteboardsApi";
import "../ui/pickerSheet.css";

/**
 * The History sheet (D207): the versions the server kept of this board, newest first, each with its
 * time, shape count, and a small preview drawn here from its scene (pictures the viewer already has
 * on the canvas are drawn too; others are left blank). The owner restores one as a new revision (the
 * canvas saves anything unsaved first, and the server's revision check applies) or saves it as a
 * copy. Only the owner sees History; the server refuses everyone else.
 */

const PREVIEW_SIDE = 240;
const shapes = (count: number | null) => count === null ? "Shapes unknown" : `${count} ${count === 1 ? "shape" : "shapes"}`;
const formatTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const readAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

function Preview({ boardId, snapshot, files }: { boardId: string; snapshot: WhiteboardSnapshot; files: () => BinaryFiles }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const controller = new AbortController();
    let started = false;
    const start = async () => {
      if (started) return;
      started = true;
      try {
        const { scene } = await getSnapshot(boardId, snapshot.id, controller.signal);
        if (!scene.elements.length) { setFailed(true); return; }
        const blob = await exportToBlob({
          elements: scene.elements as never, files: files(), mimeType: "image/png", maxWidthOrHeight: PREVIEW_SIDE, exportPadding: 12,
          appState: { viewBackgroundColor: scene.appState.viewBackgroundColor ?? "#ffffff", exportBackground: true, exportWithDarkMode: false } as never
        });
        if (!controller.signal.aborted) setSrc(await readAsDataUrl(blob));
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    // Previews are drawn as rows come into view, so a long History does not fetch every version at once.
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void start(); }) : null;
    if (observer) observer.observe(element); else void start();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [boardId, files, snapshot.id]);
  return <span ref={ref} className="whiteboard-history-preview" aria-hidden="true">
    {src ? <img src={src} alt="" draggable={false} /> : failed ? <History /> : <LoaderCircle className="spin" />}
  </span>;
}

export function HistorySheet({ boardId, files, onRestore, onCopy, onClose }: {
  boardId: string;
  /** The pictures the canvas already holds, for the previews. */
  files: () => BinaryFiles;
  onRestore: (snapshot: WhiteboardSnapshot) => void;
  onCopy: (snapshot: WhiteboardSnapshot) => Promise<void>;
  onClose: () => void;
}) {
  const [snapshots, setSnapshots] = useState<WhiteboardSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy !== null });
  useEffect(() => {
    let live = true;
    listSnapshots(boardId)
      .then((result) => { if (live) setSnapshots(result.snapshots); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "Could not load the history"); });
    return () => { live = false; };
  }, [boardId]);
  return <ModalDialog title="History" eyebrow="Whiteboard" onClose={onClose} variant="sheet" className="nook-picker whiteboard-history" busy={busy !== null}>
    <p className="nook-picker-hint whiteboard-history-intro">Nook keeps a version when you empty the board or remove most of it, and one every 30 minutes while you draw, up to 20. Restoring one keeps what is on the board now as a version too.</p>
    <div className="nook-picker-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!error && !snapshots && <p className="nook-picker-empty" role="status">Loading the history…</p>}
      {snapshots && snapshots.length === 0 && <p className="nook-picker-empty">No earlier versions yet. They are kept as you draw.</p>}
      {snapshots && snapshots.length > 0 && <ol className="whiteboard-history-list" aria-label="Versions">
        {snapshots.map((snapshot, index) => <li key={snapshot.id}>
          <Preview boardId={boardId} snapshot={snapshot} files={files} />
          <span className="whiteboard-history-copy">
            <strong>{formatTime(snapshot.createdAt)}</strong>
            <small>{shapes(snapshot.elementCount)}{index === 0 ? " · newest" : ""}</small>
          </span>
          <span className="whiteboard-history-actions">
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => onRestore(snapshot)}><RotateCcw />Restore</button>
            <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => {
              setBusy(snapshot.id);
              void onCopy(snapshot).finally(() => setBusy(null));
            }}><Copy />{busy === snapshot.id ? "Saving…" : "Save as copy"}</button>
          </span>
        </li>)}
      </ol>}
    </div>
  </ModalDialog>;
}
