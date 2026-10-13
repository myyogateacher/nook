import { useEffect, useState } from "react";
import { Check, Copy, Rss, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { createFeed, listFeeds, revokeFeed, type CalendarFeed, type CalendarSummary, type FeedDetail } from "./calendarApi";
import { notify } from "../ui/notify";
import { FormError } from "../ui/FormError";

export const MAX_FEEDS = 5;

export const FEED_WARNING = "Anyone with this link can read the feed until you revoke it. Cloud calendars (Google, Outlook, iCloud) fetch it from their own servers, so an address only reachable on your tailnet will not work for them.";

const detailLabel = (detail: FeedDetail) => detail === "busy" ? "Busy only" : "Full details";

function usedLabel(feed: CalendarFeed) {
  if (!feed.lastUsedAt) return "Never used";
  return `Last used ${new Date(feed.lastUsedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

type FeedDialogProps = { calendar: CalendarSummary; onClose: () => void; flash: (message: string) => void };

/**
 * Subscribe links for a calendar (D66): choose Busy or Full, copy the URL (shown once), and
 * list or revoke the caller's links. A dialog, so it pushes no history entry (D69).
 */
export function FeedDialog({ calendar, onClose, flash }: FeedDialogProps) {
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [detail, setDetail] = useState<FeedDetail>("busy");
  const [created, setCreated] = useState<{ url: string; copied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listFeeds(calendar.id).then((result) => { if (active) setFeeds(result.feeds); })
      .catch((reason) => { if (active) { setFeeds([]); setError(reason instanceof Error ? reason.message : "Could not load feed links"); } });
    return () => { active = false; };
  }, [calendar.id]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await createFeed(calendar.id, detail);
      setFeeds((current) => [result.feed, ...(current ?? [])]);
      setCreated({ url: result.url, copied: false });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the link");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCreated({ ...created, copied: true });
    } catch {
      setError("Copy failed. Select the link and copy it yourself.");
    }
  }

  async function revoke(feed: CalendarFeed) {
    setBusy(true);
    setError(null);
    try {
      await revokeFeed(feed.id);
      setFeeds((current) => (current ?? []).filter((item) => item.id !== feed.id));
      notify.success("Feed link revoked");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not revoke the link");
    } finally {
      setBusy(false);
    }
  }

  const full = (feeds?.length ?? 0) >= MAX_FEEDS;

  return <ModalDialog title={`Subscribe to “${calendar.name}”`} eyebrow="Calendar feed" onClose={onClose} variant="sheet" busy={busy}>
    <div className="calendar-feed">
      <p className="calendar-feed-warning" role="note">{FEED_WARNING}</p>
      {created
        ? <div className="calendar-feed-created">
          <label htmlFor="calendar-feed-url">Your new link. It is shown only once.</label>
          <input id="calendar-feed-url" readOnly value={created.url} onFocus={(event) => event.currentTarget.select()} />
          <div className="calendar-feed-actions">
            <button className="primary-button" onClick={() => { void copy(); }}>{created.copied ? <Check /> : <Copy />}{created.copied ? "Copied" : "Copy link"}</button>
            <button className="secondary-button" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
        : <div className="calendar-feed-new">
          <div className="share-options" role="radiogroup" aria-label="What the feed shows">
            <label><input type="radio" name="calendar-feed-detail" checked={detail === "busy"} onChange={() => setDetail("busy")} /><span>Busy only<small>Times, each titled “Busy”</small></span></label>
            <label><input type="radio" name="calendar-feed-detail" checked={detail === "full"} onChange={() => setDetail("full")} /><span>Full details<small>Titles, places, and descriptions</small></span></label>
          </div>
          <button className="primary-button" onClick={() => { void create(); }} disabled={busy || full || feeds === null}><Rss />Create link</button>
          {full && <p className="empty-copy">You have {MAX_FEEDS} links for this calendar. Revoke one to create another.</p>}
        </div>}
      <h3 className="calendar-feed-heading">Your links</h3>
      {feeds === null && <p className="empty-copy">Loading…</p>}
      {feeds?.length === 0 && <p className="empty-copy">No links yet.</p>}
      {!!feeds?.length && <ul className="calendar-feed-list" aria-label="Your feed links">
        {feeds.map((feed) => <li key={feed.id}>
          <span className="calendar-list-copy"><strong>{detailLabel(feed.detail)} · {feed.prefix}…</strong><small>{usedLabel(feed)}</small></span>
          <button className="icon-button danger" onClick={() => { void revoke(feed); }} disabled={busy} aria-label={`Revoke link ${feed.prefix}`}><Trash2 /></button>
        </li>)}
      </ul>}
      <FormError message={error} className="file-dialog-error" />
    </div>
  </ModalDialog>;
}
