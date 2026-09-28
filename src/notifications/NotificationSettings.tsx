import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Send, Smartphone, Trash2 } from "lucide-react";
import { getInboxSettings, setInboxPush } from "../inbox/inboxApi";
import { useRole } from "../team/roleAccess";
import { EmailSettings } from "./EmailSettings";
import {
  currentEndpoint,
  enablePushOnThisDevice,
  getPushConfig,
  listPushDevices,
  pushAvailability,
  removePushDevice,
  sendTestPush,
  type PushConfig,
  type PushDevice
} from "./pushClient";

export const PUSH_UNAVAILABLE_COPY = "Push needs the HTTPS address, such as your Tailscale URL; reminders still appear in Nook.";
export const IOS_HOME_SCREEN_COPY = "Add to Home Screen first.";

/** The explanation shown when push cannot be enabled here (§4.4). */
export function unavailableMessage(reason: "server_insecure" | "server_disabled" | "ios_home_screen" | "unsupported") {
  if (reason === "server_disabled") return "Push notifications are turned off on this server; reminders still appear in Nook.";
  if (reason === "ios_home_screen") return `${IOS_HOME_SCREEN_COPY} On iPhone and iPad, open Nook from the Share menu → Add to Home Screen, then enable notifications from there. Reminders still appear in Nook.`;
  if (reason === "unsupported") return "This browser does not support push notifications; reminders still appear in Nook.";
  return PUSH_UNAVAILABLE_COPY;
}

/** Settings → Notifications: enable push on this device, see and remove devices, send a test. */
export function NotificationSettings() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [enabledHere, setEnabledHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextConfig, list] = await Promise.all([getPushConfig(), listPushDevices()]);
      setConfig(nextConfig);
      setDevices(list.subscriptions);
      setEnabledHere(Boolean(await currentEndpoint().catch(() => null)) && typeof Notification !== "undefined" && Notification.permission === "granted");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load notification settings");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const availability = config ? pushAvailability(config) : null;

  async function enable() {
    if (!config?.enabled) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await enablePushOnThisDevice(config);
      setMessage("Notifications are on for this device.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not enable notifications");
    } finally {
      setBusy(false);
    }
  }

  async function remove(device: PushDevice) {
    setBusy(true);
    setError(null);
    try {
      await removePushDevice(device.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the device");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await sendTestPush();
      setMessage(result.sent ? `Sent to ${result.sent === 1 ? "1 device" : `${result.sent} devices`}.` : "No device accepted the test. Try enabling notifications again.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send a test");
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-content notification-settings" aria-labelledby="notification-settings-heading">
    <div className="settings-section-heading"><span className="settings-icon"><Bell /></span><div><h3 id="notification-settings-heading">Notifications</h3><p>Calendar reminders always appear under the bell in Nook. Push shows them on this device too, even when Nook is closed. Push messages carry no content; your device fetches the reminder from Nook.</p></div></div>
    {!config && !error && <p className="notification-empty" role="status">Loading…</p>}
    {availability && !availability.available && <p className="notification-settings-note" role="note">{unavailableMessage(availability.reason)}</p>}
    {availability?.available && <div className="notification-settings-row">
      {enabledHere
        ? <p className="notification-settings-status"><BellRing />Notifications are on for this device.</p>
        : <button className="primary-button notification-settings-button" onClick={() => { void enable(); }} disabled={busy}><BellRing />{busy ? "Enabling…" : "Enable on this device"}</button>}
    </div>}
    {devices && devices.length > 0 && <>
      <h4 className="notification-settings-subheading">Devices</h4>
      <ul className="notification-devices">
        {devices.map((device) => <li key={device.id}>
          <Smartphone aria-hidden="true" />
          <span><strong>{device.label}</strong><small>{device.disabled ? "Paused after failed deliveries. Enable again on that device." : device.lastSuccessAt ? `Last delivered ${new Date(device.lastSuccessAt).toLocaleString()}` : `Added ${new Date(device.createdAt).toLocaleDateString()}`}</small></span>
          <button className="secondary-button" onClick={() => { void remove(device); }} disabled={busy} aria-label={`Remove ${device.label}`}><Trash2 />Remove</button>
        </li>)}
      </ul>
      {config?.enabled && <button className="secondary-button notification-settings-button" onClick={() => { void test(); }} disabled={busy}><Send />Send test</button>}
    </>}
    {message && <p className="notification-settings-message" role="status">{message}</p>}
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
    <ProposalPushSetting />
    <EmailSettings />
  </section>;
}

/**
 * Agent proposals (agent inbox O5, D159): they always appear under the bell; pushing them is off
 * until the user turns it on. The push carries no content, and its title is the key name and a count.
 */
function ProposalPushSetting() {
  const { isGuest } = useRole();
  const [push, setPush] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isGuest) return;
    let live = true;
    getInboxSettings().then((result) => { if (live) setPush(result.push); }, () => { if (live) setError("Could not load the proposal setting"); });
    return () => { live = false; };
  }, [isGuest]);
  if (isGuest) return null;
  async function toggle() {
    if (push === null) return;
    setError(null);
    try {
      setPush((await setInboxPush(!push)).push);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save");
    }
  }
  return <>
    <h4 className="notification-settings-subheading" id="proposal-push-label">Agent proposals</h4>
    <div className="modules-row notification-proposals-row">
      <span className="modules-row-text"><strong id="proposal-push-name">Push new proposals</strong><small id="proposal-push-help">Changes your MCP keys suggest always appear under the bell and in the Inbox. Turn this on to get a push too, named only by the key and how many.</small></span>
      <button type="button" role="switch" className="modules-switch" aria-checked={push === true} aria-labelledby="proposal-push-name" aria-describedby="proposal-push-help" disabled={push === null} onClick={() => { void toggle(); }}>
        <span className="modules-switch-track" aria-hidden="true"><span className="modules-switch-thumb" /></span>
        <span className="modules-switch-state" aria-hidden="true">{push ? "On" : "Off"}</span>
      </button>
    </div>
    {error && <p className="file-dialog-error" role="alert">{error}</p>}
  </>;
}
