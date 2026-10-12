import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatBytes } from "../files/filesApi";
import { LocationStripError } from "../ui/attachments";
import { taskErrorMessage, uploadAttachment, type UploadedAttachment } from "./tasksApi";

/**
 * Uploads for a card, a comment, or the new-card form (uploads everywhere U2): one file at a time
 * through the attach kit's upload (Files › Attachments, JPEG location removed), with a progress row
 * each and Cancel. Uploads still running when the card closes are cancelled; an upload that finished
 * but was never linked moves to the Bin after a day (server/attachments/sweep.ts).
 */
export type UploadRow = { key: string; name: string; loaded: number; total: number; cancel: () => void };

export function useCardUploads(notify: (message: string) => void) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const live = useRef(new Set<AbortController>());
  useEffect(() => () => { for (const controller of live.current) controller.abort(); }, []);

  /** Uploads `files` in order and hands each to `onUploaded` (which links or stages it). */
  const upload = useCallback(async (files: readonly File[], onUploaded: (uploaded: UploadedAttachment) => Promise<void> | void) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const controller = new AbortController();
      live.current.add(controller);
      setRows((current) => [...current, { key, name: file.name || "file", loaded: 0, total: file.size, cancel: () => controller.abort() }]);
      try {
        const uploaded = await uploadAttachment(file, {
          signal: controller.signal,
          onProgress: (loaded, total) => setRows((current) => current.map((row) => row.key === key ? { ...row, loaded, total } : row))
        });
        await onUploaded(uploaded);
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) notify(uploadFailure(file, reason));
      } finally {
        live.current.delete(controller);
        setRows((current) => current.filter((row) => row.key !== key));
      }
    }
  }, [notify]);

  return { rows, busy: rows.length > 0, upload };
}

/**
 * What a failed upload says. The kit refuses a picture whose location it could not remove (U0 review
 * M2, LocationStripError) rather than share it with the board: say so plainly, with what to do.
 */
export function uploadFailure(file: { name: string }, reason: unknown) {
  const name = file.name || "File";
  if (reason instanceof LocationStripError) return `${name} was not attached: Nook could not remove the photo's location from it. Save it again as a new picture (for example, a screenshot of it) and attach that.`;
  return `${name}: ${taskErrorMessage(reason, "could not attach")}`;
}

/** The progress rows: name, percent, and Cancel. */
export function UploadRows({ rows, label = "Uploading" }: { rows: readonly UploadRow[]; label?: string }) {
  if (!rows.length) return null;
  return <ul className="task-upload-rows" aria-label={label}>
    {rows.map((row) => {
      const percent = row.total ? Math.min(100, Math.round((row.loaded / row.total) * 100)) : 0;
      return <li key={row.key}>
        <span className="task-upload-copy"><span title={row.name}>{row.name}</span><small>{percent}% of {formatBytes(row.total)}</small></span>
        <progress max={100} value={percent} aria-label={`Uploading ${row.name}`} />
        <button type="button" className="icon-button" onClick={row.cancel} aria-label={`Cancel ${row.name}`} title="Cancel"><X /></button>
      </li>;
    })}
  </ul>;
}

/** Where a paste or drop inside the card lands, from the closest `data-attach-zone` (default: the card). */
export type AttachZone = "card" | "comment" | "edit" | "editor";
type ZoneNode = { closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null; parentElement?: ZoneNode | null };
export function attachZoneOf(target: EventTarget | ZoneNode | null): AttachZone {
  const node = target as ZoneNode | null;
  // A text node (a paste into a text run) asks its parent element.
  const element = node && typeof node.closest === "function" ? node : node?.parentElement ?? null;
  const zone = element?.closest?.("[data-attach-zone]")?.getAttribute("data-attach-zone");
  return zone === "comment" || zone === "edit" || zone === "editor" ? zone : "card";
}

/**
 * What a paste or drop in `zone` does on a card (U2): the comment box and the comment being edited
 * stage files for the comment (commenters and up), the description editor keeps its own images, and
 * anywhere else attaches to the card (editors and up). Null: nothing (the caller leaves the event alone).
 */
export function attachTarget(zone: AttachZone, access: { readOnly: boolean; commentReadOnly: boolean }): "card" | "comment" | "edit" | null {
  if (zone === "editor") return null;
  if (zone === "comment" || zone === "edit") return access.commentReadOnly ? null : zone;
  return access.readOnly ? null : "card";
}
