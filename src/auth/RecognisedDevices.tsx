import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Laptop, Trash2 } from "lucide-react";
import { api } from "../api";
import { useConfirm } from "../ui/useConfirm";
import "./auth.css";
import { FormError } from "../ui/FormError";

/**
 * Settings → Security → Recognised devices (migration 044; outbound email plan #9 as built). The
 * browsers that signed in to this account, newest first, with "This device" on the one in use. A
 * sign-in from a browser not on the list sends a "New sign-in" email and a bell notice. Forget
 * removes a device from the list only: nothing is signed out (changing the password does that).
 * Confirms use the app's own dialog (D91), a history layer, so Back closes it.
 */

export type RecognisedDevice = { id: string; label: string; browser: string; os: string; firstSeenAt: string; lastSeenAt: string; current: boolean };

export const listRecognisedDevices = () => api<{ devices: RecognisedDevice[]; max: number }>("/auth/devices");
export const forgetRecognisedDevice = (id: string) => api<{ ok: true }>(`/auth/devices/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
export const forgetAllRecognisedDevices = () => api<{ ok: true; forgotten: number }>("/auth/devices", { method: "DELETE", body: "{}" });

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "Last seen …" for the row; the device in use is "Active now". */
export function deviceSeenLine(device: Pick<RecognisedDevice, "current" | "firstSeenAt" | "lastSeenAt">) {
  return `${device.current ? "Active now" : `Last seen ${when(device.lastSeenAt)}`} · First seen ${when(device.firstSeenAt)}`;
}

export function RecognisedDevices() {
  const [devices, setDevices] = useState<RecognisedDevice[] | null>(null);
  const [max, setMax] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { ask, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    try {
      const result = await listRecognisedDevices();
      setDevices(result.devices);
      setMax(result.max);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your devices");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function forget(device: RecognisedDevice) {
    const confirmed = await ask({
      title: `Forget ${device.label}?`,
      message: device.current
        ? "This browser stays signed in. The next time you sign in here, you get a “New sign-in” email."
        : "It stays signed in if it is now. The next sign-in from it sends a “New sign-in” email. To sign it out, change your password.",
      confirmLabel: "Forget"
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await forgetRecognisedDevice(device.id);
      setMessage(`${device.label} forgotten.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not forget the device");
    } finally {
      setBusy(false);
    }
  }

  async function forgetAll() {
    const confirmed = await ask({
      title: "Forget all devices?",
      message: "Nothing is signed out. The next sign-in from any browser, this one included, sends a “New sign-in” email. To sign other devices out, change your password.",
      confirmLabel: "Forget all",
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await forgetAllRecognisedDevices();
      setMessage(result.forgotten === 1 ? "1 device forgotten." : `${result.forgotten} devices forgotten.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not forget your devices");
    } finally {
      setBusy(false);
    }
  }

  return <RecognisedDevicesView devices={devices} max={max} busy={busy} message={message} error={error} onForget={(device) => { void forget(device); }} onForgetAll={() => { void forgetAll(); }} confirmElement={confirmElement} />;
}

type ViewProps = {
  devices: RecognisedDevice[] | null;
  max: number;
  busy: boolean;
  message: string;
  error: string;
  onForget: (device: RecognisedDevice) => void;
  onForgetAll: () => void;
  confirmElement?: ReactNode;
};

/** The card itself, without loading (tests render it with fixed devices). */
export function RecognisedDevicesView({ devices, max, busy, message, error, onForget, onForgetAll, confirmElement = null }: ViewProps) {
  return <section className="security-card recognised-devices" aria-labelledby="recognised-devices-heading">
    <div className="recognised-devices-summary">
      <span className="settings-icon" aria-hidden="true"><Laptop /></span>
      <div>
        <strong id="recognised-devices-heading" role="heading" aria-level={4}>Recognised devices</strong>
        <small>Browsers that signed in to your account. A sign-in from one not listed here sends you a “New sign-in” email and a notice under the bell. Only the browser and system are kept, never your IP address. Forgetting a device signs nothing out. Up to {max} are kept.</small>
      </div>
      {devices && devices.length > 1 && <button type="button" className="secondary-button" onClick={onForgetAll} disabled={busy}>Forget all</button>}
    </div>
    {!devices && !error && <p className="recognised-devices-empty" role="status">Loading…</p>}
    {devices && devices.length === 0 && <p className="recognised-devices-empty">No devices yet. The next sign-in adds this browser.</p>}
    {devices && devices.length > 0 && <ul className="recognised-devices-list">
      {devices.map((device) => <li key={device.id} className={device.current ? "current" : undefined}>
        <span className="recognised-devices-text">
          <strong>{device.label}{device.current && <span className="recognised-devices-badge">This device</span>}</strong>
          <small>{deviceSeenLine(device)}</small>
        </span>
        <button type="button" className="secondary-button" onClick={() => onForget(device)} disabled={busy} aria-label={`Forget ${device.label}${device.current ? " (this device)" : ""}`}><Trash2 aria-hidden="true" />Forget</button>
      </li>)}
    </ul>}
    {message && <p className="password-change-done" role="status">{message}</p>}
    <FormError message={error} />
    {confirmElement}
  </section>;
}
