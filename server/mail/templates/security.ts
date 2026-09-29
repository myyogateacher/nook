import { cleanLine } from "../html";
import { context, layout, note, paragraph } from "../layout";
import { appLink, paths } from "../links";
import { formatInstant } from "../format";
import { personName, securityFooter } from "./common";
import { defineTemplate } from "./types";

/**
 * Security mail (#2–#8): always on, sent at once, never held by quiet hours, and without an
 * unsubscribe link. Red eyebrow and context bar, and a fixed "if this wasn't you" line.
 */

const delayed = (subject: string, isDelayed?: boolean) => isDelayed ? `${subject} (delayed)` : subject;

export const apiKeyCreatedTemplate = defineTemplate<{ keyName: string; scopes: string; at: string; delayed?: boolean }>({
  name: "security.api_key_created",
  class: "security",
  render(data, ctx) {
    const name = cleanLine(data.keyName, 60, "unnamed");
    return layout({
      instanceName: ctx.instanceName,
      tone: "security",
      subject: delayed(`New API key “${name}” on your Nook account`, data.delayed),
      preheader: "An MCP key was created. If this wasn't you, revoke it.",
      eyebrow: "Security · MCP key",
      title: "A new MCP API key was created",
      lead: "An AI client can use this key to reach your notes and other modules with the permissions below.",
      blocks: [
        context([{ title: `“${name}”`, meta: `Created ${formatInstant(data.at, ctx.tz)}` }, { title: "Permissions", meta: cleanLine(data.scopes, 300, "None") }], { tone: "security" }),
        paragraph("If this wasn't you, sign in and revoke the key, then change your password, or ask your admin.")
      ],
      action: { label: "Review in Settings", href: appLink(paths.settings("mcp")) },
      footer: securityFooter()
    });
  },
  fixture: () => ({ keyName: "laptop", scopes: "Notes: read, write drafts · Tasks: read", at: "2026-09-28T09:00:00.000Z" })
});

const ROLE_LABELS: Record<string, string> = { admin: "Admin", member: "Member", viewer: "Viewer", guest: "Guest" };
const ROLE_LINES: Record<string, string> = {
  admin: "Admins manage the team and have every member permission.",
  member: "Members create, edit, and share notes, files, tasks, collections, and events.",
  viewer: "Viewers read what is shared with them or with everyone.",
  guest: "Guests read only what is shared with them by name."
};

export const roleChangedTemplate = defineTemplate<{ userId: string; fromRole: string; toRole: string; actorName: string | null; delayed?: boolean }>({
  name: "security.role_changed",
  class: "security",
  render(data, ctx) {
    const to = ROLE_LABELS[data.toRole] ?? "Member";
    const from = ROLE_LABELS[data.fromRole] ?? "Member";
    const actor = personName(data.actorName, "An admin");
    return layout({
      instanceName: ctx.instanceName,
      tone: "security",
      subject: delayed(`Your Nook role is now ${to}`, data.delayed),
      preheader: `${actor} changed your role from ${from} to ${to}.`,
      eyebrow: "Security · Role",
      title: `Your role is now ${to}`,
      lead: `${actor} changed your role on this Nook.`,
      blocks: [
        context([{ title: `${from} → ${to}`, meta: ROLE_LINES[data.toRole] }], { tone: "security" }),
        paragraph("If you did not expect this, ask your admin.")
      ],
      action: { label: "Open your team page", href: appLink(paths.team(data.userId)) },
      footer: securityFooter()
    });
  },
  fixture: () => ({ userId: "9d4a9ea2-5f6b-4a7c-8d8e-555555555555", fromRole: "member", toRole: "viewer", actorName: "Priya Admin" })
});

export type TwoFactorEvent = "enabled" | "disabled" | "admin_reset" | "recovery_regenerated" | "recovery_used";
const TWO_FACTOR_COPY: Record<TwoFactorEvent, { subject: string; title: string; lead: string; off: boolean }> = {
  enabled: { subject: "Two-factor authentication is on", title: "Two-factor authentication is on", lead: "Signing in to Nook now needs a code from your authenticator app. Other sessions were signed out.", off: false },
  disabled: { subject: "Two-factor authentication was turned off", title: "Two-factor authentication is off", lead: "Signing in to Nook needs only your password now. Other sessions were signed out.", off: true },
  admin_reset: { subject: "Two-factor authentication was reset", title: "Two-factor authentication was reset", lead: "The host administrator reset two-factor authentication on your account.", off: true },
  recovery_regenerated: { subject: "New recovery codes for your Nook account", title: "New recovery codes were made", lead: "Your old recovery codes no longer work.", off: false },
  recovery_used: { subject: "A recovery code was used on your Nook account", title: "A recovery code was used", lead: "Someone signed in or confirmed an action with one of your recovery codes.", off: false }
};

export const twoFactorTemplate = defineTemplate<{ event: TwoFactorEvent; at: string; remaining: number | null; delayed?: boolean }>({
  name: "security.two_factor",
  class: "security",
  render(data, ctx) {
    const copy = TWO_FACTOR_COPY[data.event];
    return layout({
      instanceName: ctx.instanceName,
      tone: "security",
      subject: delayed(copy.subject, data.delayed),
      preheader: copy.lead,
      eyebrow: "Security · Two-factor",
      title: copy.title,
      lead: copy.lead,
      blocks: [
        context([{ title: formatInstant(data.at, ctx.tz), meta: data.remaining !== null ? `${data.remaining} recovery code${data.remaining === 1 ? "" : "s"} left` : undefined }], { tone: "security" }),
        paragraph(copy.off ? "Turn it back on in Settings → Security. If this wasn't you, change your password and ask your admin." : "If this wasn't you, change your password and ask your admin.")
      ],
      action: { label: copy.off ? "Turn it back on" : "Review in Settings", href: appLink(paths.settings("security")) },
      footer: securityFooter()
    });
  },
  fixture: () => ({ event: "disabled", at: "2026-09-28T09:00:00.000Z", remaining: null })
});

/**
 * Wave 35: `google_allowed` (an admin allowed the next Google sign-in with this address to link the
 * account), `google_reset` (the admin reset the account first; `counts` says what was removed), and
 * `google_unlinked` (an admin removed the Google sign-in).
 */
export type AccountEvent = "blocked" | "unblocked" | "sessions_revoked" | "google_allowed" | "google_reset" | "google_unlinked" | "google_unlinked_self";

/** The reset counts, in plain words ("3 sessions", "2 shared items made private"), zeros left out. */
export function resetCountLines(counts: Record<string, number> | null | undefined) {
  const labels: Array<[string, string, string]> = [
    ["sessions", "signed-in session", "signed-in sessions"],
    ["keys", "API key", "API keys"],
    ["feeds", "calendar feed link", "calendar feed links"],
    ["items", "shared item made private", "shared items made private"],
    ["shares", "person removed from shared items", "people removed from shared items"],
    ["groupGrants", "group removed from shared items", "groups removed from shared items"],
    ["invites", "live invite revoked", "live invites revoked"],
    ["routines", "routine paused", "routines paused"]
  ];
  const lines = labels.filter(([key]) => (counts?.[key] ?? 0) > 0).map(([key, one, many]) => `${counts![key]} ${counts![key] === 1 ? one : many}`);
  if (counts?.password) lines.push("the password");
  if (counts?.twoFactor) lines.push("two-factor authentication");
  return lines;
}

export const accountEventTemplate = defineTemplate<{ event: AccountEvent; actorName: string | null; at: string; counts?: Record<string, number> | null; delayed?: boolean }>({
  name: "security.account",
  class: "security",
  render(data, ctx) {
    const actor = personName(data.actorName, "An admin");
    const when = formatInstant(data.at, ctx.tz);
    const removed = resetCountLines(data.counts);
    const copy = data.event === "google_allowed"
      ? { subject: "Google sign-in was allowed for your Nook account", title: "Google sign-in was allowed", lead: `${actor} allowed the next Google sign-in with this address to be linked to your Nook account. It works once, within 24 hours.`, action: { label: "Sign in", href: appLink(paths.home()) }, extra: "If you did not ask for this, contact your admin." }
      : data.event === "google_reset"
        ? { subject: "Your Nook account was reset for Google sign-in", title: "Your account was reset", lead: `${actor} reset your account before allowing Google sign-in. Removed: ${removed.length ? removed.join(", ") : "nothing"}. Your notes, files, and other items are kept, and everything you owned is private now.`, action: { label: "Sign in with Google", href: appLink(paths.home()) }, extra: "Sign in with Google as this address within 24 hours to link it. If you did not expect this, contact your admin." }
        : data.event === "google_unlinked"
          ? { subject: "Google sign-in was removed from your Nook account", title: "Google sign-in was removed", lead: `${actor} removed Google sign-in from your Nook account.`, action: { label: "Review in Settings", href: appLink(paths.settings("security")) }, extra: "Contact your admin if you think this is a mistake." }
          : data.event === "google_unlinked_self"
            ? { subject: "Google sign-in was removed from your Nook account", title: "Google sign-in was removed", lead: "Google sign-in was removed from your Nook account in Settings. Sign in with your email and password from now on.", action: { label: "Review in Settings", href: appLink(paths.settings("security")) }, extra: "If this wasn't you, change your password and ask your admin to check your account." }
          : data.event === "blocked"
      // The admin's reason is never included (O11).
      ? { subject: "Your Nook account was blocked", title: "Your account was blocked", lead: `${actor} blocked your account. You are signed out everywhere and cannot sign in until an admin unblocks it.`, action: null, extra: "Contact your admin if you think this is a mistake." }
      : data.event === "unblocked"
        ? { subject: "Your Nook account was unblocked", title: "Your account was unblocked", lead: `${actor} unblocked your account. You can sign in again.`, action: { label: "Sign in", href: appLink(paths.home()) }, extra: "Sign in on each device again, and turn push notifications back on in Settings if you use them." }
        : { subject: "You were signed out of Nook everywhere", title: "You were signed out everywhere", lead: `${actor} signed your account out on every device.`, action: { label: "Sign in", href: appLink(paths.home()) }, extra: "Sign in again to continue. If you did not expect this, ask your admin." };
    return layout({
      instanceName: ctx.instanceName,
      tone: "security",
      subject: delayed(copy.subject, data.delayed),
      preheader: copy.lead,
      eyebrow: data.event.startsWith("google_") ? "Security · Sign-in" : "Security · Account",
      title: copy.title,
      lead: copy.lead,
      blocks: [context([{ title: when }], { tone: "security" }), note(copy.extra)],
      action: copy.action ?? undefined,
      footer: securityFooter()
    });
  },
  fixture: () => ({ event: "blocked", actorName: "Priya Admin", at: "2026-09-28T09:00:00.000Z" })
});

/**
 * `google_linked` (Wave 35, D293): Google sign-in was linked to the account, from Settings, by a
 * sign-in on a verified address, or through an admin's allowance. Nothing else changed.
 */
export type PasswordEvent = "changed" | "reset" | "google_linked";

/**
 * #12: the password was changed in Settings → Security, or reset from a mailed link (Wave 30,
 * outbound email §A.5). A reset signs out every device; a change keeps the one that made it. API keys
 * keep working either way, so the mail points at them.
 */
export const passwordChangedTemplate = defineTemplate<{ event: PasswordEvent; at: string; delayed?: boolean }>({
  name: "security.password_changed",
  class: "security",
  render(data, ctx) {
    if (data.event === "google_linked") {
      const lead = "Google sign-in was added to your Nook account. You can now sign in with Google as this address; your password and devices are unchanged.";
      return layout({
        instanceName: ctx.instanceName,
        tone: "security",
        subject: delayed("Google sign-in was added to your Nook account", data.delayed),
        preheader: lead,
        eyebrow: "Security · Sign-in",
        title: "Google sign-in was added",
        lead,
        blocks: [
          context([{ title: formatInstant(data.at, ctx.tz) }], { tone: "security" }),
          paragraph("If this wasn't you, ask your admin to block the account at once.")
        ],
        action: { label: "Review in Settings", href: appLink(paths.settings("security")) },
        footer: securityFooter()
      });
    }
    const reset = data.event === "reset";
    const lead = reset
      ? "Your Nook password was reset with a link sent to this address. Every device was signed out."
      : "Your Nook password was changed in Settings. All other sessions were signed out.";
    return layout({
      instanceName: ctx.instanceName,
      tone: "security",
      subject: delayed(reset ? "Your Nook password was reset" : "Your Nook password was changed", data.delayed),
      preheader: lead,
      eyebrow: "Security · Password",
      title: reset ? "Your password was reset" : "Your password was changed",
      lead,
      blocks: [
        context([
          { title: formatInstant(data.at, ctx.tz) },
          { title: "Review your API keys", meta: "Keys keep working after a password change. Revoke any you do not recognise.", href: appLink(paths.settings("mcp")) }
        ], { tone: "security" }),
        paragraph("If this wasn't you, reset your password from the sign-in page at once, then ask your admin to check your account.")
      ],
      action: { label: "Review in Settings", href: appLink(paths.settings("security")) },
      footer: securityFooter()
    });
  },
  fixture: () => ({ event: "changed", at: "2026-09-28T09:00:00.000Z" })
});
