/**
 * Team → a member → "Remove profile picture" (T353), rendered with happy-dom and mocked API answers:
 * the button shows only for someone else who has a picture, asks first through useConfirm, and on
 * confirm calls DELETE /api/team/:userId/avatar, shows the initials and a success toast; a failure
 * shows an error toast and keeps the picture.
 */
import { describe, expect, test } from "bun:test";
import type { TeamMember } from "../src/team/teamApi";
import { captureToasts, installDom, mockApi, render, reply, type ApiRoutes } from "./support/dom";

installDom();

const { TeamSection } = await import("../src/team/TeamApp");

const ME = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const PICTURE = `/api/users/${ADA}/avatar?v=33333333-3333-4333-8333-333333333333`;

const person = (overrides: Partial<TeamMember>): TeamMember => ({
  id: ADA, displayName: "Ada Lovelace", role: "member", status: "active", createdAt: "2026-01-01T00:00:00.000Z", isYou: false,
  email: "ada@nook.test", lastSeenAt: null, totpEnabled: false, mcpKeys: { live: 0 }, storageBytes: 0, ...overrides
});
const me = person({ id: ME, displayName: "Admin Me", role: "admin", email: "me@nook.test", isYou: true, avatarUrl: `/api/users/${ME}/avatar?v=44444444-4444-4444-8444-444444444444` });

/** The answers a member detail needs: the list, invites, the member, and its Google card. */
function teamRoutes(detail: TeamMember, extra: ApiRoutes = {}): ApiRoutes {
  return {
    "GET /team": () => ({ me: { id: ME, role: "admin" }, users: detail.id === ME ? [me] : [me, detail] }),
    "GET /team/invites": () => ({ invites: [] }),
    [`GET /team/${detail.id}`]: () => ({ member: { ...detail, events: [], joinedWithInvite: null } }),
    [`GET /team/${detail.id}/google`]: () => reply(404, { error: "Not found" }),
    ...extra
  };
}

async function openMember(userId: string) {
  const view = await render(<TeamSection
    route={{ app: "team", userId }}
    role="admin"
    navigate={() => undefined}
    flash={() => undefined}
    onLeave={() => undefined}
    guardLeave={(leave) => leave()}
    onKeyPendingChange={() => undefined}
  />);
  const pane = await view.waitFor(() => {
    const section = document.querySelector('[aria-label="Team member"]');
    return section?.querySelector('[aria-label="Account actions"], .team-facts') ? section : null;
  });
  return { ...view, pane };
}

const avatarImage = (pane: Element) => pane.querySelector(`img[src="${PICTURE}"]`);

describe("Team member detail: Remove profile picture", () => {
  test("shows only for someone else who has a picture", async () => {
    mockApi(teamRoutes(person({ avatarUrl: PICTURE })));
    const withPicture = await openMember(ADA);
    expect(withPicture.button("Remove profile picture", withPicture.pane)).not.toBeNull();
  });

  test("hidden when the member has no picture", async () => {
    mockApi(teamRoutes(person({ avatarUrl: null })));
    const view = await openMember(ADA);
    expect(view.pane.querySelector('[aria-label="Account actions"]')).not.toBeNull();
    expect(view.button("Remove profile picture", view.pane)).toBeNull();
  });

  test("hidden on your own account, even with a picture", async () => {
    mockApi(teamRoutes(me));
    const view = await openMember(ME);
    await view.waitFor(() => view.pane.textContent?.includes("This is your account"));
    expect(view.button("Remove profile picture", view.pane)).toBeNull();
  });

  test("asks first; Cancel sends nothing", async () => {
    const api = mockApi(teamRoutes(person({ avatarUrl: PICTURE })));
    const toasts = captureToasts();
    const view = await openMember(ADA);
    await view.click(view.button("Remove profile picture", view.pane)!);
    const dialog = await view.waitFor(() => document.querySelector('[role="dialog"]'));
    expect(dialog.textContent).toContain("Remove Ada Lovelace's profile picture?");
    expect(dialog.textContent).toContain("Everyone sees their initials instead.");
    await view.click(view.button("Cancel", dialog)!);
    await view.waitFor(() => !document.querySelector('[role="dialog"]'));
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(avatarImage(view.pane)).not.toBeNull();
    expect(toasts).toEqual([]);
  });

  test("confirming calls DELETE /api/team/:userId/avatar, then shows the initials and a success toast", async () => {
    const api = mockApi(teamRoutes(person({ avatarUrl: PICTURE }), {
      [`DELETE /team/${ADA}/avatar`]: () => ({ removed: true, member: { ...person({ avatarUrl: null }), events: [], joinedWithInvite: null } })
    }));
    const toasts = captureToasts();
    const view = await openMember(ADA);
    expect(avatarImage(view.pane)).not.toBeNull();
    await view.click(view.button("Remove profile picture", view.pane)!);
    const dialog = await view.waitFor(() => document.querySelector('[role="dialog"]'));
    // Nothing is sent before the answer.
    expect(api.calls.some((call) => call.method === "DELETE")).toBe(false);
    await view.click(view.button("Remove picture", dialog)!);
    await view.waitFor(() => toasts.length > 0);

    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([{ method: "DELETE", path: `/team/${ADA}/avatar`, body: {} }]);
    expect(toasts).toEqual([{ kind: "success", message: "Ada Lovelace's profile picture was removed" }]);
    expect(avatarImage(view.pane)).toBeNull();
    expect(view.pane.querySelector(".avatar-has-image")).toBeNull();
    expect(view.pane.querySelector(".team-avatar.large")?.textContent).toBe("A");
    expect(view.button("Remove profile picture", view.pane)).toBeNull();
    // The list is loaded again, so its row shows the letters too.
    expect(api.calls.filter((call) => call.method === "GET" && call.path === "/team").length).toBeGreaterThanOrEqual(2);
  });

  test("a failure shows an error toast and keeps the picture", async () => {
    mockApi(teamRoutes(person({ avatarUrl: PICTURE }), {
      [`DELETE /team/${ADA}/avatar`]: () => reply(500, { error: "Storage is busy. Try again in a moment." })
    }));
    const toasts = captureToasts();
    const view = await openMember(ADA);
    await view.click(view.button("Remove profile picture", view.pane)!);
    const dialog = await view.waitFor(() => document.querySelector('[role="dialog"]'));
    await view.click(view.button("Remove picture", dialog)!);
    await view.waitFor(() => toasts.length > 0);
    expect(toasts).toEqual([{ kind: "error", message: "Storage is busy. Try again in a moment." }]);
    expect(avatarImage(view.pane)).not.toBeNull();
    expect(view.button("Remove profile picture", view.pane)).not.toBeNull();
  });
});
