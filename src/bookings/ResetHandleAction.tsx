import { useState } from "react";
import { createPortal } from "react-dom";
import { RotateCcw } from "lucide-react";
import { api } from "../api";
import type { MemberActionDef, MemberActionProps } from "../ui/memberSlots";
import { useConfirm } from "../ui/useConfirm";
import { errorText, notify } from "../ui/notify";

/**
 * "Reset booking link name" on a member's page in Settings → Team (D1384; admins only), the app's
 * side of POST /api/bookings/profile/:userId/reset-handle (T579: a squatted or impersonating link
 * name such as `/p/book/admin`). Before, the reset was API-only. It asks first in the app's own
 * dialog, saying what the reset does: a new link name from the member's name, and their booking page
 * settings back to the defaults. The server audits it (`bookings.handle_reset`).
 */

/** At most this many members per request (the server's own cap is higher). */
const BY_ID_LIMIT = 150;

export const loadHandles = async (memberIds: readonly string[]): Promise<Record<string, unknown>> => {
  const handles: Record<string, unknown> = {};
  for (let at = 0; at < memberIds.length; at += BY_ID_LIMIT) {
    const chunk = memberIds.slice(at, at + BY_ID_LIMIT);
    Object.assign(handles, (await api<{ handles: Record<string, string> }>(`/bookings/admin/handles?users=${chunk.map(encodeURIComponent).join(",")}`)).handles);
  }
  return handles;
};

export const resetHandleConfirm = (name: string, handle: string) =>
  `${name}'s booking page moves from /p/book/${handle} to a new link made from their name, and the old link stops working at once. Their booking page name, welcome text, time zone, and busy calendars go back to the defaults; their booking types and availability stay.`;

export function ResetHandleAction({ member, data, variant }: MemberActionProps) {
  const [handle, setHandle] = useState(typeof data === "string" ? data : null);
  const [busy, setBusy] = useState(false);
  const { ask, confirmElement } = useConfirm();
  // On the member's page only: a list row has no room for an admin repair.
  if (variant !== "detail" || !handle) return null;

  const reset = async () => {
    if (!await ask({ title: "Reset booking link name?", message: resetHandleConfirm(member.displayName, handle), confirmLabel: "Reset link name", danger: true })) return;
    setBusy(true);
    try {
      const { profile } = await api<{ profile: { handle: string } }>(`/bookings/profile/${encodeURIComponent(member.id)}/reset-handle`, { method: "POST", body: "{}" });
      setHandle(profile.handle);
      notify.success(`Booking link name reset to ${profile.handle}`);
    } catch (reason) {
      notify.error(errorText(reason, "Could not reset the booking link name"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="bk-reset-handle">
    <button type="button" className="secondary-button bk-reset-handle-button" disabled={busy} onClick={() => { void reset(); }}>
      <RotateCcw aria-hidden="true" />{busy ? "Resetting…" : "Reset booking link name"}
    </button>
    <small className="bk-reset-handle-hint">Booking page: <code>/p/book/{handle}</code></small>
    {confirmElement && createPortal(confirmElement, document.body)}
  </div>;
}

export const resetHandleMemberAction: MemberActionDef = {
  id: "bookings.reset-handle",
  order: 90,
  // Admins only (the endpoint checks the same).
  hiddenFor: ["member", "viewer", "guest"],
  load: loadHandles,
  component: ResetHandleAction
};
