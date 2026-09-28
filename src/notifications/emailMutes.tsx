import { useCallback, useEffect, useState } from "react";
import { Mail, MailX } from "lucide-react";
import { listEmailMutes, muteEmails, unmuteEmails, type EmailMute, type MuteType } from "./emailApi";

/**
 * "Mute emails" for a board, calendar, or collection (Wave 29, outbound email §B.1 D249). The
 * caller's own switch: Nook sends no activity email about a muted item (assignments, comments,
 * sprints, event changes). Security email, the digest, and the caller's own reminders still come.
 */

const key = (type: MuteType, id: string) => `${type}:${id}`;

/** The caller's mutes, loaded once, with an optimistic toggle. */
export function useEmailMutes() {
  const [mutes, setMutes] = useState<EmailMute[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMutes((await listEmailMutes()).mutes);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load email mutes");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const isMuted = (type: MuteType, id: string) => Boolean(mutes?.some((mute) => mute.targetType === type && mute.targetId === id));

  async function toggle(type: MuteType, id: string, name: string) {
    const muted = isMuted(type, id);
    setBusy(key(type, id));
    setError(null);
    try {
      if (muted) await unmuteEmails(type, id);
      else await muteEmails(type, id);
      setMutes((current) => muted
        ? (current ?? []).filter((mute) => !(mute.targetType === type && mute.targetId === id))
        : [{ targetType: type, targetId: id, name, createdAt: new Date().toISOString() }, ...(current ?? [])]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not change the email mute");
    } finally {
      setBusy(null);
    }
  }

  return { mutes, error, loaded: mutes !== null, isMuted, isBusy: (type: MuteType, id: string) => busy === key(type, id), toggle, reload: load };
}

const NOUNS: Record<MuteType, string> = { board: "board", calendar: "calendar", collection: "collection" };

/** A settings-sheet row: "Mute emails from this board", as the sheet's own checkbox toggle. */
export function MuteEmailsToggle({ type, id, name, className = "task-settings-toggle" }: { type: MuteType; id: string; name: string; className?: string }) {
  const mutes = useEmailMutes();
  const muted = mutes.isMuted(type, id);
  return <>
    <label className={className}>
      <input type="checkbox" checked={muted} disabled={!mutes.loaded || mutes.isBusy(type, id)} onChange={() => { void mutes.toggle(type, id, name); }} />
      <span>Mute emails from this {NOUNS[type]}<small>Nook won't email you about activity here{type === "calendar" ? " (event changes)" : " (assignments, comments, sprints)"}. Your own reminders and security email still come.</small></span>
    </label>
    {mutes.error && <p className="file-dialog-error" role="alert">{mutes.error}</p>}
  </>;
}

/** An icon button for list rows (the Calendars sheet). */
export function MuteEmailsButton({ type, id, name, muted, busy, onToggle }: { type: MuteType; id: string; name: string; muted: boolean; busy: boolean; onToggle: () => void }) {
  return <button type="button" className={`icon-button${muted ? " active" : ""}`} aria-pressed={muted} disabled={busy} data-mute={`${type}:${id}`}
    aria-label={muted ? `Unmute emails from ${name}` : `Mute emails from ${name}`} title={muted ? "Emails muted" : "Mute emails"} onClick={onToggle}>
    {muted ? <MailX /> : <Mail />}
  </button>;
}

const TYPE_LABELS: Record<MuteType, string> = { board: "Board", calendar: "Calendar", collection: "Collection" };

/** Settings → Email → Muted: every muted item the caller can still open, each with Unmute. */
export function EmailMutesList() {
  const mutes = useEmailMutes();
  return <>
    <h4 className="notification-settings-subheading" id="email-mutes-heading">Muted</h4>
    {!mutes.loaded && !mutes.error && <p className="email-settings-muted" role="status">Loading…</p>}
    {mutes.loaded && !mutes.mutes!.length && <p className="email-settings-muted">Nothing is muted. Mute a board in its Board settings, or a calendar in Calendars.</p>}
    {mutes.loaded && mutes.mutes!.length > 0 && <ul className="modules-list email-list email-mutes" aria-labelledby="email-mutes-heading">
      {mutes.mutes!.map((mute) => <li key={`${mute.targetType}:${mute.targetId}`} className="modules-row email-row">
        <span className="modules-row-text"><strong>{mute.name}</strong><small>{TYPE_LABELS[mute.targetType]} · no activity email</small></span>
        <button type="button" className="secondary-button email-settings-button" disabled={mutes.isBusy(mute.targetType, mute.targetId)}
          aria-label={`Unmute emails from ${mute.name}`} onClick={() => { void mutes.toggle(mute.targetType, mute.targetId, mute.name); }}>Unmute</button>
      </li>)}
    </ul>}
    {mutes.error && <p className="file-dialog-error" role="alert">{mutes.error}</p>}
  </>;
}
