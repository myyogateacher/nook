import { useCallback, useEffect, useId, useState } from "react";
import { Check, Copy, Globe, TriangleAlert } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { PublicLinkState } from "../../shared/agents";
import { errorCode, getPublicLink, messageOf, putPublicLink, revokePublicLink } from "./chatApi";
import { FormError } from "../ui/FormError";

/** The warning the sheet always shows (plan §6.2, T315, T316). */
export const PUBLIC_LINK_WARNING = "Anyone with the link can read this snapshot, without signing in. It shows the chat as it is now; later messages appear only after Update link. Tool results stay hidden unless you include them.";

/** "Updated 2 Oct, 14:05" for the link's state line. */
export function linkStateLine(link: PublicLinkState) {
  const when = (value: string) => new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return link.updatedAt !== link.createdAt ? `Created ${when(link.createdAt)} · snapshot updated ${when(link.updatedAt)}` : `Created ${when(link.createdAt)}`;
}

/**
 * The Public link sheet (Wave 43, AC-D, plan §6.2, D362, AC-O1): create a frozen snapshot of the
 * branch on screen, copy its link (shown once: only a hash is stored), Update link (re-snapshot,
 * same link), New link (the old one stops working), and Revoke (asks first). "Include tool results"
 * is off by default. Back closes it (D18); a pending Revoke question closes first.
 */
export function PublicLinkSheet({ chatId, title, onClose, onChanged }: { chatId: string; title: string; onClose: () => void; onChanged: (link: PublicLinkState | null) => void }) {
  const [link, setLink] = useState<PublicLinkState | null | undefined>(undefined);
  const [includeResults, setIncludeResults] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const checkboxId = useId();
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const cancelRevoke = useCallback(() => setConfirmRevoke(false), []);
  // Back on the Revoke question answers Keep it (the newest guard is asked first).
  useHistoryDialogGuard(confirmRevoke, cancelRevoke, { blocked: busy });

  useEffect(() => {
    let live = true;
    getPublicLink(chatId).then((result) => {
      if (!live) return;
      setLink(result.link);
      setIncludeResults(result.link?.includeToolResults ?? false);
    }, (reason) => { if (live) { setLink(null); setError(errorCode(reason) === "NOT_FOUND" ? "Public links are turned off on this Nook." : messageOf(reason, "Could not load the link")); } });
    return () => { live = false; };
  }, [chatId]);

  async function save(newLink = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await putPublicLink(chatId, { includeToolResults: includeResults, ...(newLink ? { newLink: true } : {}) });
      setLink(result.link);
      if (result.url) { setUrl(result.url); setCopied(false); }
      onChanged(result.link);
    } catch (reason) {
      setError(errorCode(reason) === "NOT_FOUND" ? "Public links are turned off on this Nook, or the chat is gone." : messageOf(reason, "Could not save the link"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await revokePublicLink(chatId);
      setLink(null);
      setUrl(null);
      setConfirmRevoke(false);
      onChanged(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not revoke the link"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy did not work here; select the link and copy it.");
    }
  }

  return <ModalDialog title="Public link" eyebrow={title} onClose={() => { if (!busy) onClose(); }} busy={busy} className="chat-dialog chat-public-sheet">
    <p className="chat-public-warning" role="note"><TriangleAlert aria-hidden="true" />{PUBLIC_LINK_WARNING}</p>
    {link === undefined && !error && <p className="chat-muted" role="status">Loading…</p>}
    {link !== undefined && <>
      <label className="ai-check" htmlFor={checkboxId}><input id={checkboxId} type="checkbox" checked={includeResults} disabled={busy} onChange={(event) => setIncludeResults(event.target.checked)} />Include tool results (arguments and results, not just the tools' names)</label>
      {includeResults && <p className="file-dialog-hint">Results can hold what the agent read from your Nook or other services.</p>}
      {link && <p className="chat-muted"><Globe aria-hidden="true" className="chat-inline-icon" />Link is on · {linkStateLine(link)}{link.includeToolResults ? " · tool results included" : ""}</p>}
      {url && <div className="chat-public-url">
        <label htmlFor={`${checkboxId}-url`}>Copy the link now: it is shown once.</label>
        <div className="chat-public-url-row">
          <input id={`${checkboxId}-url`} readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="secondary-button" onClick={() => { void copy(); }}>{copied ? <><Check />Copied</> : <><Copy />Copy link</>}</button>
        </div>
      </div>}
      {link && !url && <p className="file-dialog-hint">Lost the link? New link makes another one; the old one stops working.</p>}
    </>}
    <FormError message={error} />
    {confirmRevoke ? <footer className="file-dialog-actions chat-public-confirm" role="group" aria-label="Revoke the link?">
      <span>Revoke the link? It stops working at once.</span>
      <button type="button" className="secondary-button" onClick={cancelRevoke} disabled={busy}>Keep it</button>
      <button type="button" className="danger-button" onClick={() => { void revoke(); }} disabled={busy}>{busy ? "Revoking…" : "Revoke"}</button>
    </footer> : <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Close</button>
      {link && <button type="button" className="secondary-button" onClick={() => setConfirmRevoke(true)} disabled={busy}>Revoke</button>}
      {link && <button type="button" className="secondary-button" onClick={() => { void save(true); }} disabled={busy}>New link</button>}
      {link !== undefined && <button type="button" className="primary-button" onClick={() => { void save(false); }} disabled={busy}>{busy ? "Saving…" : link ? "Update link" : "Create link"}</button>}
    </footer>}
  </ModalDialog>;
}
