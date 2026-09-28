import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamInvite, TeamInviteList } from "../src/team/teamApi";
import { DEFAULT_EXPIRY, DEFAULT_INVITE_ROLE, expiryOptions, INVITE_ROLES, inviteLimitHint, inviteRoleOptions, inviteTimeLabel, shownOnceWarning } from "../src/team/inviteFormat";
import { joinedLabel } from "../src/team/teamFormat";
import { TeamInvites } from "../src/team/TeamInvites";

const invite = (overrides: Partial<TeamInvite>): TeamInvite => ({
  id: crypto.randomUUID(), tokenPrefix: "abcdef", role: "viewer", email: null, note: null, status: "live",
  createdAt: "2026-09-28T10:00:00.000Z", expiresAt: "2026-10-05T10:00:00.000Z",
  createdBy: { id: "a", displayName: "Asha" }, usedBy: null, usedAt: null, revokedAt: null, ...overrides
});

const render = (data: TeamInviteList | null, error: string | null = null) => renderToStaticMarkup(<TeamInvites data={data} error={error} onBack={() => undefined} onReload={() => undefined} onOpenMember={() => undefined} flash={() => undefined} />);

describe("Invite formatting", () => {
  test("roles mirror the server (never admin), with Guest and 7 days as defaults", () => {
    // The same list as server/team/invites.ts and the migration 018 CHECK.
    expect([...INVITE_ROLES]).toEqual(["member", "viewer", "guest"]);
    expect(inviteRoleOptions().map((option) => option.value)).toEqual(["member", "viewer", "guest"]);
    expect(inviteRoleOptions().every((option) => option.description.length > 0)).toBe(true);
    expect(DEFAULT_INVITE_ROLE).toBe("guest");
    expect(expiryOptions()).toEqual([{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "7 days" }]);
    expect(DEFAULT_EXPIRY).toBe("7");
  });

  test("time lines, the limit hint, the shown-once warning, and the joined line", () => {
    const now = Date.parse("2026-09-29T10:00:00.000Z");
    expect(inviteTimeLabel(invite({}), now)).toBe("Expires in 6 days");
    expect(inviteTimeLabel(invite({ expiresAt: "2026-09-30T10:00:00.000Z" }), now)).toBe("Expires in 1 day");
    expect(inviteTimeLabel(invite({ expiresAt: "2026-09-29T15:00:00.000Z" }), now)).toBe("Expires in 5 hours");
    expect(inviteTimeLabel(invite({ expiresAt: "2026-09-29T10:30:00.000Z" }), now)).toBe("Expires within an hour");
    expect(inviteTimeLabel(invite({ status: "used", usedBy: { id: "b", displayName: "Bo" } }), now)).toBe("Used by Bo");
    expect(inviteTimeLabel(invite({ status: "revoked" }), now)).toBe("Revoked");
    expect(inviteTimeLabel(invite({ status: "expired" }), now)).toBe("Expired");
    expect(inviteLimitHint(19, 20)).toBeNull();
    expect(inviteLimitHint(20, 20)).toContain("20 invites are live");
    expect(shownOnceWarning("viewer", "2026-10-05T10:00:00.000Z")).toStartWith("This link is shown once. Anyone with it can create a Viewer account until ");
    expect(joinedLabel({ role: "guest", usedAt: "2026-09-28T10:00:00.000Z", invitedBy: { id: "a", displayName: "Asha" } })).toBe("Joined with an invite from Asha, as Guest");
    expect(joinedLabel({ role: "member", usedAt: "2026-09-28T10:00:00.000Z", invitedBy: null })).toBe("Joined with an invite, as Member");
  });
});

describe("Invites panel", () => {
  test("empty, loading, and error states", () => {
    expect(render({ invites: [], liveCount: 0, liveLimit: 20 })).toContain("No invites yet.");
    expect(render({ invites: [], liveCount: 0, liveLimit: 20 })).toContain("Create a link to add someone without opening registration.");
    expect(render(null)).toContain("Loading invites…");
    expect(render(null, "Boom")).toContain("Could not load invites");
  });

  test("cards show role and status chips; only live invites offer Revoke; used ones link to the member; no native select", () => {
    const markup = render({ invites: [
      invite({ note: "Design contractor", email: "dana@example.test" }),
      invite({ role: "member", status: "used", usedBy: { id: "u", displayName: "Uma" }, usedAt: "2026-09-29T10:00:00.000Z" }),
      invite({ role: "guest", status: "revoked", revokedAt: "2026-09-29T10:00:00.000Z" })
    ], liveCount: 1, liveLimit: 20 });
    expect(markup.match(/>Revoke</g)).toHaveLength(1);
    expect(markup).toContain("Open Uma");
    expect(markup).toContain("Only dana@example.test");
    expect(markup).toContain("Design contractor");
    for (const label of ["Live", "Used", "Revoked", "Viewer", "Member", "Guest"]) expect(markup).toContain(`>${label}<`);
    expect(markup).not.toContain("<select");
    // The token is never in the list: only its six-character prefix.
    expect(markup).toContain("abcdef…");
  });

  test("New invite is disabled at the live limit, with a hint", () => {
    const full = render({ invites: [invite({})], liveCount: 20, liveLimit: 20 });
    expect(full).toMatch(/<button type="button" class="team-action primary" disabled="">.*New invite/);
    expect(full).toContain("20 invites are live");
    expect(render({ invites: [invite({})], liveCount: 1, liveLimit: 20 })).not.toMatch(/disabled="">.*New invite/);
  });
});
