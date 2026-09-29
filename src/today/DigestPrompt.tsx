import { useEffect, useRef, useState } from "react";
import { Mail, X } from "lucide-react";
import { api } from "../api";
import { viewerTimeZone } from "./todayApi";

/**
 * The one-time Today prompt for the email digest (D248, outbound email §B.1). The server decides
 * whether it shows (email on, address verified, account 7 days old, digest still off, never answered);
 * any answer, including No thanks, settles it for good. Settings → Notifications → Email changes it later.
 */

export type DigestChoice = "daily" | "weekly" | "dismiss";

export const DIGEST_PROMPT_TITLE = "Get a morning summary by email?";

/** What the card says once answered, or null for No thanks (the card just goes). */
export function digestPromptDone(choice: DigestChoice, localTime: string) {
  if (choice === "dismiss") return null;
  return `Email digest on: ${choice === "daily" ? "every day" : "every Monday"} at ${localTime}. Change it in Settings → Notifications.`;
}

export function DigestPromptCard({ busy, error, onChoose }: { busy: boolean; error: string; onChoose: (choice: DigestChoice) => void }) {
  return <section className="today-digest-prompt" aria-labelledby="today-digest-title">
    <span className="today-digest-icon" aria-hidden="true"><Mail /></span>
    <div className="today-digest-copy">
      <h2 id="today-digest-title">{DIGEST_PROMPT_TITLE}</h2>
      <p>One short email in the morning with your cards due soon, your next events, suggestions awaiting you, and what was shared with you. Days with nothing new send nothing.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="today-digest-actions">
        <button type="button" className="primary-button" onClick={() => onChoose("daily")} disabled={busy}>Every morning</button>
        <button type="button" className="secondary-button" onClick={() => onChoose("weekly")} disabled={busy}>Mondays only</button>
        <button type="button" className="text-button" onClick={() => onChoose("dismiss")} disabled={busy}>No thanks</button>
      </div>
    </div>
    <button type="button" className="icon-button today-digest-close" onClick={() => onChoose("dismiss")} disabled={busy} aria-label="Dismiss the email digest suggestion"><X /></button>
  </section>;
}

export function DigestPrompt({ userId }: { userId: string }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let current = true;
    setShow(false);
    api<{ show: boolean }>("/mail/digest-prompt").then((result) => { if (current) setShow(result.show); }).catch(() => undefined);
    return () => { current = false; };
  }, [userId]);

  async function choose(choice: DigestChoice) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ digestLocalTime: string }>("/mail/digest-prompt", { method: "POST", body: JSON.stringify({ choice, tz: viewerTimeZone() }) });
      setShow(false);
      const message = digestPromptDone(choice, result.digestLocalTime);
      setDone(message);
      // The card is gone: keep focus on Today instead of the page body.
      if (message) window.requestAnimationFrame(() => doneRef.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save your choice");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p ref={doneRef} tabIndex={-1} className="today-digest-done" role="status">{done}</p>;
  if (!show) return null;
  return <DigestPromptCard busy={busy} error={error} onChoose={(choice) => { void choose(choice); }} />;
}
