import { ApiError } from "../api";
import type { BinItem } from "../types";
import { errorText, notify, type NotifyOptions } from "../ui/notify";
import { restoreBinItem } from "./binApi";

/**
 * Undo after a move to the Bin (v0.35.0): every action that bins something shows one success toast
 * with an Undo button. Undo goes through the Bin's own restore (POST /api/bin/:type/:id/restore,
 * the same path and access rules as Settings → Bin → Restore), then refreshes the view the item left.
 * Delete forever and purges never offer it. A toast adds no history entry, so phones' Back is untouched.
 */
export type BinRef = Pick<BinItem, "type" | "id">;

type Restore = (item: BinRef) => Promise<unknown>;

const BIN_RESTORED = "nook:bin-restored";

/**
 * Runs `listener` after an Undo brought items of one of `types` back, so a view the deleting screen
 * already left (a list behind a closed page) shows them again. Returns the unsubscribe function.
 */
export function onBinRestored(types: readonly BinRef["type"][], listener: (items: BinRef[]) => void) {
  const handler = (event: Event) => {
    const items = ((event as CustomEvent<unknown>).detail as BinRef[] | undefined) ?? [];
    const mine = items.filter((item) => types.includes(item.type));
    if (mine.length) listener(mine);
  };
  window.addEventListener(BIN_RESTORED, handler);
  return () => window.removeEventListener(BIN_RESTORED, handler);
}

function announceRestored(items: BinRef[]) {
  if (items.length && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BIN_RESTORED, { detail: items }));
}

const codeOf = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object"
  ? (reason.payload as { code?: unknown }).code
  : undefined;

/** Why an Undo could not bring something back: purged meanwhile, no longer the caller's to restore, or the server's own reason. */
export function undoFailureMessage(reason: unknown, total = 1, failures = 1) {
  const base = codeOf(reason) === "PURGING"
    ? "It is being deleted forever and can't be restored"
    : reason instanceof ApiError && (reason.status === 404 || reason.status === 403)
      ? "It is no longer in the Bin, or you can no longer restore it"
      : errorText(reason, "Could not restore it");
  if (total <= 1) return `Could not undo. ${base}.`.replace(/\.\.$/, ".");
  return `Restored ${total - failures} of ${total}. ${base}.`.replace(/\.\.$/, ".");
}

/**
 * Restores `items` one by one (each under the server's own lock), then runs `refresh` once if
 * anything came back. Toasts "Restored", or an error naming why. Resolves true when all came back.
 */
export async function undoBinMove(items: readonly BinRef[], refresh?: () => unknown, restore: Restore = restoreBinItem) {
  let failures = 0;
  let firstFailure: unknown = null;
  const restored: BinRef[] = [];
  for (const item of items) {
    try {
      await restore(item);
      restored.push({ type: item.type, id: item.id });
    } catch (reason) {
      failures += 1;
      firstFailure ??= reason;
    }
  }
  announceRestored(restored);
  if (failures < items.length && refresh) {
    try {
      await refresh();
    } catch {
      if (failures === 0) {
        notify.warning("Restored, but the view could not be refreshed. Reload to see it.");
        return true;
      }
    }
  }
  if (failures === 0) {
    notify.success("Restored");
    return true;
  }
  notify.error(undoFailureMessage(firstFailure, items.length, failures));
  return false;
}

/** The toast options for a move to the Bin: an Undo button that restores `items` and refreshes. */
export function binUndoOptions(items: readonly BinRef[], refresh?: () => unknown, restore: Restore = restoreBinItem): NotifyOptions {
  return { action: { label: "Undo", onClick: () => { void undoBinMove(items, refresh, restore); } } };
}

/**
 * The one toast for a move to the Bin, single or bulk: `message` with Undo for every item binned.
 * With nothing binned (an empty note purged, say) it is a plain success toast.
 */
export function notifyBinned(message: string, items: readonly BinRef[], refresh?: () => unknown, restore: Restore = restoreBinItem) {
  return notify.success(message, items.length > 0 ? binUndoOptions(items, refresh, restore) : undefined);
}
