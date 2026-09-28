import { api } from "../api";
import type { BinItem, BinRestoreResult } from "../types";

const itemPath = (item: Pick<BinItem, "type" | "id">) => `/bin/${item.type}/${encodeURIComponent(item.id)}`;

const BIN_CHANGED = "nook:bin-changed";

/** Tells the header Bin badges (useBinCount) that the Bin's contents changed, so they count again (Friction 8). */
export function notifyBinChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BIN_CHANGED));
}

/** Runs `listener` after each notifyBinChanged; returns the unsubscribe function. */
export function onBinChanged(listener: () => void) {
  window.addEventListener(BIN_CHANGED, listener);
  return () => window.removeEventListener(BIN_CHANGED, listener);
}

const changed = <T,>(result: T) => { notifyBinChanged(); return result; };

export const listBin = () => api<{ items: BinItem[] }>("/bin");
export const restoreBinItem = (item: Pick<BinItem, "type" | "id">) => api<BinRestoreResult>(`${itemPath(item)}/restore`, { method: "POST", body: "{}" }).then(changed);
export const deleteBinItem = (item: Pick<BinItem, "type" | "id">) => api<{ ok: true; pending?: true }>(itemPath(item), { method: "DELETE", body: "{}" }).then(changed);
export const emptyBin = () => api<{ ok: true; purged: number; pending: number }>("/bin", { method: "DELETE", body: "{}" }).then(changed);
