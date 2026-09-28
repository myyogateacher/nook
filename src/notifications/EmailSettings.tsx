import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Mail, MailWarning, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { ApiError } from "../api";
import { useRole } from "../team/roleAccess";
import { Select } from "../ui/Select";
import { EmailMutesList } from "./emailMutes";
import { clearSuppression, deviceTimeZone, getEmailSettings, HALF_HOURS, insideQuietHours, prefsInput, putEmailSettings, sendTestEmail, sendVerificationEmail, type EmailCategory, type EmailPrefsInput, type EmailSettings as Settings } from "./emailApi";

/**
 * Settings → Notifications → Email (Wave 28, outbound email §E.2–E.3). Preferences gate sending
 * only, never access (T97). States: email not configured on the server, the address unverified
 * (switches disabled until verified), bounced (suppressed), and ready. Saves use a compare-and-swap
 * on `revision`; a 409 asks for a reload, as Modules does. Dropdowns are the app's custom Select.
 */

const CATEGORY_ROWS: Array<{ id: EmailCategory; title: string; help: string }> = [
  { id: "assignments", title: "Assigned to you", help: "Someone assigns you a card. Grouped every 10 minutes." },
  { id: "comments", title: "Comments on your cards", help: "New comments on cards you created or are assigned to." },
  { id: "sharing", title: "Shared with you", help: "Notes, files, boards, calendars, and collections shared with you by name." },
  { id: "proposals", title: "Proposals awaiting you", help: "Your MCP keys suggested changes. At most one email every few hours." },
  { id: "reminders", title: "Reminders by email", help: "Reminders you set to email (choose per reminder in Calendar), and changes to events you set a reminder on. Sent even in quiet hours." },
  { id: "sprints", title: "Sprints", help: "A sprint with your cards in it started or was completed. Off by default." },
  { id: "bin", title: "Bin clean-up", help: "Items in your Bin are deleted for good within 3 days. At most once a week. Off by default." }
];

const DIGEST_OPTIONS: Array<{ value: "off" | "daily" | "weekly"; label: string }> = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly (Mondays)" }
];
const TIME_OPTIONS = HALF_HOURS.map((value) => ({ value, label: value }));

/** Half hours, plus a stored time between them; times inside quiet hours are disabled (the server moves them to the end). */
export function digestTimeOptions(current: string, quietStart: string | null, quietEnd: string | null) {
  const times = HALF_HOURS.includes(current) ? HALF_HOURS : [...HALF_HOURS, current].sort();
  return times.map((value) => ({ value, label: value, disabled: value !== current && insideQuietHours(value, quietStart, quietEnd) }));
}

/** "Overdue and due-soon cards…" plus when the next one goes. */
export function digestNote(prefs: Pick<Settings["prefs"], "digest" | "nextDigestAt" | "tz">) {
  const what = "Your overdue and due-soon cards, upcoming events, proposals awaiting you, and new shares. Never sent when there is nothing to say.";
  if (prefs.digest === "off" || !prefs.nextDigestAt) return what;
  const next = new Date(prefs.nextDigestAt).toLocaleString(undefined, { timeZone: prefs.tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${what} Next: ${next} (${prefs.tz}).`;
}

/** What the bounced notice says for each reason (security email keeps coming either way). */
export function suppressionCopy(settings: Pick<Settings, "address" | "suppression">) {
  const reason = settings.suppression?.reason ?? "bounce";
  if (reason === "complaint") return `An email to ${settings.address} was reported as spam, so Nook stopped sending to it. Security emails still go.`;
  if (reason === "soft") {
    const until = settings.suppression?.until ? new Date(settings.suppression.until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
    return `Email to ${settings.address} kept bouncing, so Nook paused it${until ? ` until ${until}` : ""}. Security emails still go.`;
  }
  return `Email to ${settings.address} bounced, so Nook stopped sending to it. Security emails still go. Check the address with your admin, or try again.`;
}

function Switch({ checked, disabled, labelledBy, describedBy, onChange }: { checked: boolean; disabled?: boolean; labelledBy: string; describedBy?: string; onChange?: (next: boolean) => void }) {
  return <button type="button" role="switch" className="modules-switch" aria-checked={checked} aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange?.(!checked)}>
    <span className="modules-switch-track" aria-hidden="true"><span className="modules-switch-thumb" /></span>
    <span className="modules-switch-state" aria-hidden="true">{checked ? "On" : "Off"}</span>
  </button>;
}

/** Email is off on this Nook (3a): admins get the OPERATIONS pointer, everyone else is sent to an admin. */
export function emailOffText(role: string | null | undefined) {
  return role === "admin" ? "Email is off on this Nook. Turn it on in the server settings (OPERATIONS → Email)." : "Email is off on this Nook. Ask an admin to turn it on.";
}

export function EmailSettings() {
  const { role } = useRole();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const coolTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setConflict(false);
    try {
      setSettings(await getEmailSettings());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load email settings");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (coolTimer.current !== null) window.clearTimeout(coolTimer.current); }, []);

  async function save(change: Partial<EmailPrefsInput>) {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await putEmailSettings(prefsInput(settings.prefs, change)));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) setConflict(true);
      else setError(reason instanceof Error ? reason.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  /** "Try again" after a bounce (§B.4): clears this address's suppression, once a day. */
  async function tryAgain() {
    setRetrying(true);
    setError(null);
    setMessage(null);
    try {
      setSettings(await clearSuppression());
      setMessage("Nook will email this address again.");
    } catch (reason) {
      const code = reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;
      setError(code === "RATE_LIMITED" ? "You can try again once a day." : reason instanceof Error ? reason.message : "Could not try again");
    } finally {
      setRetrying(false);
    }
  }

  /** The button rests for 20 s after each send (§E.2). */
  function cool() {
    setCooling(true);
    if (coolTimer.current !== null) window.clearTimeout(coolTimer.current);
    coolTimer.current = window.setTimeout(() => { coolTimer.current = null; setCooling(false); }, 20_000);
  }

  async function sendOne(kind: "verify" | "test") {
    setMessage(null);
    setError(null);
    cool();
    try {
      if (kind === "verify") await sendVerificationEmail();
      else await sendTestEmail();
      setMessage(kind === "verify" ? `Sent. Open the link in the email to ${settings?.address ?? "your address"}.` : "Sent. Check your inbox (and spam).");
    } catch (reason) {
      const code = reason instanceof ApiError ? (reason.payload as { code?: string } | undefined)?.code : undefined;
      setError(code === "RATE_LIMITED" ? (kind === "verify" ? "Too many verification emails; try again in an hour." : "Too many test emails; try again in an hour.")
        : code === "NOT_CONFIGURED" ? "Email is not configured" : reason instanceof Error ? reason.message : "Could not send");
    }
  }

  const heading = <h4 className="notification-settings-subheading" id="email-settings-heading">Email</h4>;
  if (!settings) return <section className="email-settings" aria-labelledby="email-settings-heading">
    {heading}
    {error ? <p className="file-dialog-error" role="alert">{error}</p> : <p className="notification-empty" role="status">Loading…</p>}
  </section>;

  if (!settings.configured) return <section className="email-settings" aria-labelledby="email-settings-heading">
    {heading}
    <p className="email-settings-muted" role="note"><Mail aria-hidden="true" />{emailOffText(role)}</p>
    {/* Mutes are made from boards and calendars whether or not email is on (Friction 1). */}
    <EmailMutesList />
  </section>;

  const { prefs } = settings;
  const ready = settings.verified && !settings.suppressed;
  const locked = !ready || saving;
  const quietOn = prefs.quietStart !== null;
  const zone = prefs.revision === 0 ? deviceTimeZone() : prefs.tz;
  const device = deviceTimeZone();

  return <section className="email-settings" aria-labelledby="email-settings-heading">
    {heading}
    {settings.suppressed && <div className="email-notice danger" role="alert">
      <MailWarning aria-hidden="true" />
      <p>{suppressionCopy(settings)}</p>
      <button type="button" className="secondary-button email-settings-button" disabled={retrying} onClick={() => { void tryAgain(); }}><RotateCcw aria-hidden="true" />Try again</button>
    </div>}
    {!settings.verified && <div className="email-notice" role="note">
      <Mail aria-hidden="true" />
      <p>Verify {settings.address} to get email from Nook. Until then only security emails are sent.</p>
      <button type="button" className="secondary-button email-settings-button" disabled={cooling} onClick={() => { void sendOne("verify"); }}><Send aria-hidden="true" />Send verification email</button>
    </div>}
    {conflict && <div className="email-notice danger" role="alert">
      <p>Your settings changed in another window.</p>
      <button type="button" className="secondary-button email-settings-button" onClick={() => { void load(); }}><RotateCcw aria-hidden="true" />Reload</button>
    </div>}

    <div className="modules-row email-row">
      <span className="modules-row-icon" aria-hidden="true"><Mail /></span>
      <span className="modules-row-text">
        <strong id="email-master-label">Email notifications</strong>
        <small id="email-master-help">Sent to {settings.address}{settings.verified ? <span className="email-verified"><CheckCircle2 aria-hidden="true" />Verified</span> : " · Not verified"}. Off stops everything below except security email.</small>
      </span>
      <Switch checked={prefs.enabled} disabled={locked} labelledBy="email-master-label" describedBy="email-master-help" onChange={(enabled) => { void save({ enabled }); }} />
    </div>
    {settings.verified && <button type="button" className="secondary-button email-settings-button email-test-button" disabled={cooling || settings.suppressed} onClick={() => { void sendOne("test"); }}><Send aria-hidden="true" />Send me a test email</button>}
    {message && <p className="notification-settings-message" role="status">{message}</p>}
    {error && <p className="file-dialog-error" role="alert">{error}</p>}

    <h4 className="notification-settings-subheading">What to email</h4>
    <ul className="modules-list email-list">
      {CATEGORY_ROWS.map((row) => <li key={row.id} className={`modules-row email-row${prefs.categories[row.id] && prefs.enabled ? "" : " off"}`}>
        <span className="modules-row-text">
          <strong id={`email-${row.id}-label`}>{row.title}</strong>
          <small id={`email-${row.id}-help`}>{row.help}</small>
        </span>
        <Switch checked={prefs.categories[row.id]} disabled={locked || !prefs.enabled} labelledBy={`email-${row.id}-label`} describedBy={`email-${row.id}-help`}
          onChange={(on) => { void save({ categories: { ...prefs.categories, [row.id]: on } }); }} />
      </li>)}
      <li className="modules-row email-row">
        <span className="modules-row-text"><strong id="email-security-label" className="email-label-icon"><ShieldCheck aria-hidden="true" className="email-inline-icon" />Security</strong><small id="email-security-help">Always on. New API keys, role changes, two-factor changes, and account blocks.</small></span>
        <Switch checked disabled labelledBy="email-security-label" describedBy="email-security-help" />
      </li>
    </ul>

    <EmailMutesList />

    <h4 className="notification-settings-subheading">Summary</h4>
    <div className="email-field-row">
      <span className="email-field"><span id="email-digest-label">Digest</span><Select value={prefs.digest} onChange={(digest) => { void save({ digest }); }} options={DIGEST_OPTIONS} label="Digest" labelledBy="email-digest-label" disabled={locked || !prefs.enabled} /></span>
      <span className="email-field"><span id="email-digest-time-label">At</span><Select value={prefs.digestLocalTime} onChange={(digestLocalTime) => { void save({ digestLocalTime }); }}
        options={digestTimeOptions(prefs.digestLocalTime, prefs.quietStart, prefs.quietEnd)} label="Digest time" labelledBy="email-digest-time-label" disabled={locked || !prefs.enabled || prefs.digest === "off"} /></span>
    </div>
    <p className="email-settings-muted">{digestNote(prefs)}</p>

    <div className="modules-row email-row">
      <span className="modules-row-text"><strong id="email-quiet-label">Quiet hours</strong><small id="email-quiet-help">Activity email waits until they end. Security email is never held.</small></span>
      <Switch checked={quietOn} disabled={locked || !prefs.enabled} labelledBy="email-quiet-label" describedBy="email-quiet-help"
        onChange={(on) => { void save({ quietHours: on ? { start: "22:00", end: "07:30" } : null }); }} />
    </div>
    {quietOn && <div className="email-field-row">
      <span className="email-field"><span id="email-quiet-from">From</span><Select value={prefs.quietStart} onChange={(start) => { if (start !== prefs.quietEnd) void save({ quietHours: { start, end: prefs.quietEnd! } }); }} options={TIME_OPTIONS} label="Quiet hours from" labelledBy="email-quiet-from" disabled={locked} /></span>
      <span className="email-field"><span id="email-quiet-to">To</span><Select value={prefs.quietEnd} onChange={(end) => { if (end !== prefs.quietStart) void save({ quietHours: { start: prefs.quietStart!, end } }); }} options={TIME_OPTIONS} label="Quiet hours to" labelledBy="email-quiet-to" disabled={locked} /></span>
    </div>}
    <p className="email-settings-muted email-zone">Time zone: {zone}{zone !== device && ready && <button type="button" className="text-button" onClick={() => { void save({ tz: device }); }}>Use this device's time zone ({device})</button>}</p>
  </section>;
}
