import { useEffect, useState } from "react";
import "./appShell.css";
import { binCountClaimed, listBin, onBinChanged, onBinCount } from "./bin/binApi";
import { INBOX_CHANGED, pendingCount } from "./inbox/inboxApi";
import { useDisabledModules } from "./modules";
import { readyWorkspaceModules } from "./workspaceModules";
import { NOTIFICATIONS_POLLED } from "./notifications/notificationsApi";

/**
 * The Inbox's pending badge (the sidebar's Inbox row, D1270): a bounded count (at most 100, T51), fetched on mount, after inbox changes, and
 * whenever the bell refreshes (its poll and focus), so a new proposal shows without a reload.
 */
export function useInboxCount(enabled: boolean) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () => { pendingCount().then(({ pending }) => { if (live) setCount(pending); }, () => undefined); };
    refresh();
    for (const name of INBOX_COUNT_SIGNALS) window.addEventListener(name, refresh);
    return () => {
      live = false;
      for (const name of INBOX_COUNT_SIGNALS) window.removeEventListener(name, refresh);
    };
  }, [enabled]);
  return count;
}

/** Window events that refresh the Inbox badge: inbox changes, the bell's refresh, and focus. */
export const INBOX_COUNT_SIGNALS = [INBOX_CHANGED, NOTIFICATIONS_POLLED, "focus"] as const;

/**
 * Workspace modules' header items (D833, §B.1: Time's running timer), in the sidebar's footer since
 * D1270, for the ready modules that are on. Nothing while none registers one.
 */
export function TopBarItems() {
  const disabled = useDisabledModules();
  const items = readyWorkspaceModules().filter((module) => module.topBarItem && !disabled.includes(module.id));
  if (items.length === 0) return null;
  return <>{items.map(({ id, topBarItem: Item }) => Item && <Item key={id} />)}</>;
}

/**
 * The Bin's item count for its Settings nav entry (Wave 38; the top bar's Bin badge before): a lazy
 * look on mount (no polling), and again whenever the app restores or deletes from the Bin
 * (notifyBinChanged: Restore all in a key's Review, a deleted note); a failure leaves no count.
 * While Settings → Bin itself is on screen it reports the count of the items it loaded instead
 * (claimBinCount, review L3), so opening the Bin asks the server once, and a restore or delete there
 * is counted from the list, not fetched again. `enabled` false skips the request (the Bin entry
 * hidden: the module off or a guest, or two-factor setup still required).
 */
export function useBinCount(enabled = true) {
  const [binCount, setBinCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let request = 0;
    const count = () => {
      if (binCountClaimed()) return;
      const current = ++request;
      listBin().then(({ items }) => { if (live && current === request) setBinCount(items.length); }, () => undefined);
    };
    count();
    const stop = onBinChanged(count);
    // A reported count wins over a look still in flight.
    const stopReports = onBinCount((reported) => { request += 1; if (live) setBinCount(reported); });
    return () => { live = false; stop(); stopReports(); };
  }, [enabled]);
  return binCount;
}
