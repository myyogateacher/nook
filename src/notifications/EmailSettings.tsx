import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Mail, MailWarning, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { ApiError } from "../api";
import { Select } from "../ui/Select";
import { deviceTimeZone, getEmailSettings, HALF_HOURS, prefsInput, putEmailSettings, sendTestEmail, sendVerificationEmail, type EmailCategory, type EmailPrefsInput, type EmailSettings as Settings } from "./emailApi";

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
  { id: "proposals", title: "Proposals awaiting you", help: "Your MCP keys suggested changes. At most one email every few hours." }
];

const DIGEST_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "daily", label: "Daily", disabled: true },
  { value: "weekly", label: "Weekly (Mondays)", disabled: true }
] as const;
const TIME_OPTIONS = HALF_HOURS.map((value) => ({ value, label: value }));

function Switch({ checked, disabled, labelledBy, describedBy, onChange }: { checked: boolean; disabled?: boolean; labelledBy: string; describedBy?: string; onChange?: (next: boolean) => void }) {
  return <button type="button" role="switch" className="modules-switch" aria-checked={checked} aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange?.(!checked)}>
    <span className="modules-switch-track" aria-hidden="true"><span className="modules-switch-thumb" /></span>
    <span className="modules-switch-state" aria-hidden="true">{checked ? "On" : "Off"}</span>
  </button>;
}

export function EmailSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
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
    <p className="email-settings-muted" role="note"><Mail aria-hidden="true" />Email is off on this Nook. Your admin can turn it on (OPERATIONS → Email).</p>
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
      <p>Email to {settings.address} bounced, so Nook stopped sending to it. Ask your admin to check the address.</p>
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
      <li className="modules-row email-row off">
        <span className="modules-row-text"><strong id="email-reminders-label">Reminders by email</strong><small id="email-reminders-help">Coming in a later update. Reminders appear under the bell and as push.</small></span>
        <Switch checked={false} disabled labelledBy="email-reminders-label" describedBy="email-reminders-help" />
      </li>
      <li className="modules-row email-row">
        <span className="modules-row-text"><strong id="email-security-label"><ShieldCheck aria-hidden="true" className="email-inline-icon" />Security</strong><small id="email-security-help">Always on. New API keys, role changes, two-factor changes, and account blocks.</small></span>
        <Switch checked disabled labelledBy="email-security-label" describedBy="email-security-help" />
      </li>
    </ul>

    <h4 className="notification-settings-subheading">Summary</h4>
    <div className="email-field-row">
      <span className="email-field"><span id="email-digest-label">Digest</span><Select value="off" onChange={() => undefined} options={[...DIGEST_OPTIONS]} labelledBy="email-digest-label" disabled /></span>
      <span className="email-field"><span id="email-digest-time-label">At</span><Select value={prefs.digestLocalTime} onChange={() => undefined} options={TIME_OPTIONS} labelledBy="email-digest-time-label" disabled /></span>
    </div>
    <p className="email-settings-muted">A daily or weekly summary is coming in a later update.</p>

    <div className="modules-row email-row">
      <span className="modules-row-text"><strong id="email-quiet-label">Quiet hours</strong><small id="email-quiet-help">Activity email waits until they end. Security email is never held.</small></span>
      <Switch checked={quietOn} disabled={locked || !prefs.enabled} labelledBy="email-quiet-label" describedBy="email-quiet-help"
        onChange={(on) => { void save({ quietHours: on ? { start: "22:00", end: "07:30" } : null }); }} />
    </div>
    {quietOn && <div className="email-field-row">
      <span className="email-field"><span id="email-quiet-from">From</span><Select value={prefs.quietStart} onChange={(start) => { if (start !== prefs.quietEnd) void save({ quietHours: { start, end: prefs.quietEnd! } }); }} options={TIME_OPTIONS} labelledBy="email-quiet-from" disabled={locked} /></span>
      <span className="email-field"><span id="email-quiet-to">To</span><Select value={prefs.quietEnd} onChange={(end) => { if (end !== prefs.quietStart) void save({ quietHours: { start: prefs.quietStart!, end } }); }} options={TIME_OPTIONS} labelledBy="email-quiet-to" disabled={locked} /></span>
    </div>}
    <p className="email-settings-muted email-zone">Time zone: {zone}{zone !== device && ready && <button type="button" className="text-button" onClick={() => { void save({ tz: device }); }}>Use this device's time zone ({device})</button>}</p>
  </section>;
}
