import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, FileText, LayoutList, RotateCcw, Table2, X } from "lucide-react";
import { api } from "./api";
import { Select, type Option } from "./ui/Select";
import { useHistoryDialogGuard } from "./ui/useHistoryDialogGuard";

/**
 * Settings → API keys → a key's "Review" (docs/plan/WAVES_18-20_SMALL.md D175, T142): what the key
 * moved to the Bin in a window, with Restore all and Revoke this key. Back closes the dialog before
 * it leaves Settings (useHistoryDialogGuard); at 390 px it is a full-height sheet with 44 px rows.
 */

export type BinnedWindow = "1h" | "24h" | "7d";
export type BinnedItem = { type: "note" | "card" | "event" | "collection_row"; id: string; title: string; binnedAt: string; restorable: boolean };

export const BINNED_WINDOW_OPTIONS: Option<BinnedWindow>[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" }
];

/** The key row's line, or null when the key binned nothing in the last 24 hours. */
export function binnedTodayLine(count: number | undefined) {
  if (!count) return null;
  return `Moved ${count} ${count === 1 ? "item" : "items"} to the Bin today`;
}

const TYPE_LABEL: Record<BinnedItem["type"], string> = { note: "Note", card: "Card", event: "Event", collection_row: "Row" };
const TYPE_ICON = { note: FileText, card: LayoutList, event: CalendarDays, collection_row: Table2 } as const;

/** The result line after Restore all. */
export function restoreSummary(result: { restored: number; skipped: unknown[] }) {
  const restored = `Restored ${result.restored} ${result.restored === 1 ? "item" : "items"}`;
  return result.skipped.length ? `${restored}; ${result.skipped.length} could not be restored` : `${restored}.`;
}

export function McpBinnedReview({ keyId, keyName, onClose, onRevoke }: { keyId: string; keyName: string; onClose: () => void; onRevoke: () => void }) {
  const [range, setRange] = useState<BinnedWindow>("24h");
  const [items, setItems] = useState<BinnedItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  useHistoryDialogGuard(true, onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A Select's popup handles its own Escape first.
      if (event.key === "Escape" && !busy && !event.defaultPrevented) onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  useEffect(() => closeRef.current?.focus(), []);

  const load = useCallback(() => {
    setItems(null);
    setError("");
    api<{ items: BinnedItem[]; truncated: boolean }>(`/mcp/keys/${keyId}/binned?window=${range}`)
      .then((result) => { setItems(result.items); setTruncated(result.truncated); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load what this key moved to the Bin"));
  }, [keyId, range]);
  useEffect(load, [load]);

  async function restoreAll() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ restored: number; skipped: unknown[] }>(`/mcp/keys/${keyId}/restore-binned`, { method: "POST", body: JSON.stringify({ window: range }) });
      setMessage(restoreSummary(result));
      load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore the items");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="mcp-review-scrim" onClick={() => { if (!busy) onClose(); }} />
    <div className="mcp-review-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-review-title">
      <header>
        <div><h2 id="mcp-review-title">Moved to the Bin by {keyName}</h2><p>Items stay in the Bin for 30 days. Restore them one by one in the Bin, or all at once here.</p></div>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close" onClick={onClose} disabled={busy}><X /></button>
      </header>
      <div className="mcp-review-window"><span id="mcp-review-window-label">Window</span>
        <Select<BinnedWindow> value={range} onChange={setRange} options={BINNED_WINDOW_OPTIONS} labelledBy="mcp-review-window-label" disabled={busy} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="mcp-review-message" role="status">{message}</p>}
      {items === null && !error ? <p className="mcp-review-empty">Loading…</p>
        : items && items.length === 0 ? <p className="mcp-review-empty">Nothing this key moved to the Bin in this window is still there.</p>
        : items && <ul className="mcp-review-list">{items.map((item) => {
          const Icon = TYPE_ICON[item.type];
          return <li key={`${item.type}:${item.id}`}><Icon aria-hidden="true" /><span><strong>{item.title || "Untitled"}</strong><small>{TYPE_LABEL[item.type]} · {new Date(item.binnedAt).toLocaleString()}</small></span></li>;
        })}</ul>}
      {truncated && <p className="mcp-review-empty">Showing the latest 500.</p>}
      <div className="mcp-review-actions">
        <button type="button" className="text-danger" disabled={busy} onClick={onRevoke}>Revoke this key</button>
        <button type="button" className="primary-button" disabled={busy || !items?.length} onClick={restoreAll}><RotateCcw aria-hidden="true" />{busy ? "Restoring…" : "Restore all"}</button>
      </div>
    </div>
  </>;
}
