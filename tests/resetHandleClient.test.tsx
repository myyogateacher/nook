/**
 * D1384: "Reset booking link name" on a member's page in Settings → Team (admins only), the app's side
 * of POST /api/bookings/profile/:userId/reset-handle (T579). Rendered with happy-dom and mocked answers.
 */
import { describe, expect, test } from "bun:test";
import { captureToasts, installDom, mockApi, render } from "./support/dom";

installDom();

const { ResetHandleAction, resetHandleMemberAction, resetHandleConfirm } = await import("../src/bookings/ResetHandleAction");
const { memberActions, registerMemberAction, clearMemberActionsForTests } = await import("../src/ui/memberSlots");

const ADA = "22222222-2222-4222-8222-222222222222";
const ada = { id: ADA, displayName: "Ada Lovelace", isYou: false, blocked: false };

describe("Reset booking link name", () => {
  test("only admins get the action; it loads every member's link name in one call", async () => {
    clearMemberActionsForTests();
    registerMemberAction({ ...resetHandleMemberAction, module: "bookings" });
    expect(memberActions("admin").map((action) => action.id)).toEqual(["bookings.reset-handle"]);
    for (const role of ["member", "viewer", "guest"] as const) expect(memberActions(role)).toEqual([]);
    const api = mockApi({ [`GET /bookings/admin/handles?users=${ADA}`]: () => ({ handles: { [ADA]: "admin" } }) });
    expect(await resetHandleMemberAction.load([ADA])).toEqual({ [ADA]: "admin" });
    expect(api.calls).toHaveLength(1);
  });

  test("shows on the member's page only, asks in the app's dialog, then resets and shows the new name", async () => {
    const toasts = captureToasts();
    const api = mockApi({ [`POST /bookings/profile/${ADA}/reset-handle`]: () => ({ profile: { handle: "ada-lovelace" } }) });
    const row = await render(<ResetHandleAction member={ada} data="admin" variant="row" />);
    expect(row.container.textContent).toBe("");
    const view = await render(<ResetHandleAction member={ada} data="admin" variant="detail" />);
    expect(view.container.textContent).toContain("/p/book/admin");
    await view.click(view.button("Reset booking link name")!);
    const dialog = await view.waitFor(() => document.querySelector('[role="alertdialog"], [role="dialog"]'));
    expect(dialog.textContent).toContain(resetHandleConfirm("Ada Lovelace", "admin"));
    expect(api.calls).toHaveLength(0);
    await view.click(view.button("Reset link name", dialog)!);
    await view.waitFor(() => view.container.textContent?.includes("/p/book/ada-lovelace"));
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST /bookings/profile/${ADA}/reset-handle`]);
    expect(toasts).toEqual([{ kind: "success", message: "Booking link name reset to ada-lovelace" }]);
  });

  test("Cancel in the dialog resets nothing; a member without a booking profile shows nothing", async () => {
    const api = mockApi({});
    const empty = await render(<ResetHandleAction member={ada} data={undefined} variant="detail" />);
    expect(empty.container.textContent).toBe("");
    const view = await render(<ResetHandleAction member={ada} data="admin" variant="detail" />);
    await view.click(view.button("Reset booking link name")!);
    const dialog = await view.waitFor(() => document.querySelector('[role="alertdialog"], [role="dialog"]'));
    await view.click(view.button("Cancel", dialog)!);
    expect(api.calls).toHaveLength(0);
    expect(view.container.textContent).toContain("/p/book/admin");
  });
});
