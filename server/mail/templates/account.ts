import { layout, note, paragraph } from "../layout";
import { appLink, paths } from "../links";
import { formatInstant } from "../format";
import { accountFooter, personName } from "./common";
import { defineTemplate } from "./types";

type InviteRole = "member" | "viewer" | "guest";
const ROLE_LABELS: Record<InviteRole, string> = { member: "Member", viewer: "Viewer", guest: "Guest" };
const ROLE_LINES: Record<InviteRole, string> = {
  member: "Members create, edit, and share notes, files, tasks, collections, and events.",
  viewer: "Viewers read what is shared with them or with everyone.",
  guest: "Guests read only what is shared with them by name."
};

/**
 * The team invite (#1, D254): sent at once by the admin's request, never queued. The link is the
 * `/register#invite=` fragment link the admin's origin produced; it works once and only for `to`.
 */
export const inviteTemplate = defineTemplate<{ to: string; url: string; role: InviteRole; expiresAt: string; inviterName: string }>({
  name: "team.invite",
  class: "account",
  render(data, context) {
    const inviter = personName(data.inviterName, "An admin");
    const role = ROLE_LABELS[data.role];
    return layout({
      instanceName: context.instanceName,
      subject: `${inviter} invited you to Nook`,
      preheader: `Join as a ${role}. The link works once.`,
      eyebrow: "Team · Invite",
      title: `${inviter} invited you to Nook`,
      lead: `You're invited as a ${role}. ${ROLE_LINES[data.role]}`,
      blocks: [
        note(`The link works once and expires on ${formatInstant(data.expiresAt, "UTC")}. It only works for ${data.to}.`),
        note("If you did not expect this email, ignore it: nothing happens until someone opens the link. Do not forward it; anyone with the link can use it.")
      ],
      action: { label: "Create your account", href: data.url },
      footer: accountFooter(`You got this because an admin of this Nook invited ${data.to}.`, false)
    });
  },
  fixture: () => ({ to: "dana@example.com", url: `${appLink("/register")}#invite=${"a".repeat(43)}`, role: "member", expiresAt: "2026-10-05T10:00:00.000Z", inviterName: "Priya Admin" })
});

/** Verify your email (#13, D244): the token rides in the fragment and is minted at send time (T220). */
export const verifyTemplate = defineTemplate<{ token: string; expiresAt: string; address: string }>({
  name: "account.verify",
  class: "account",
  render(data, context) {
    return layout({
      instanceName: context.instanceName,
      subject: "Verify your email for Nook",
      preheader: "Confirm this address to get email from Nook.",
      eyebrow: "Account · Verify",
      title: "Confirm your email address",
      lead: `Confirm that ${data.address} is yours, so Nook can send you assignments, shares, and other updates.`,
      blocks: [note(`The link works once, until ${formatInstant(data.expiresAt, context.tz)}. If you did not ask for this, ignore it.`)],
      action: { label: "Verify email", href: appLink(paths.verifyEmail(data.token)) },
      footer: accountFooter("You got this because someone asked Nook to verify this address.")
    });
  },
  fixture: () => ({ token: "b".repeat(43), expiresAt: "2026-09-29T09:00:00.000Z", address: "priya@example.com" })
});

/** "Send me a test email" (#15). */
export const testTemplate = defineTemplate<{ sentAt: string }>({
  name: "account.test",
  class: "account",
  render(data, context) {
    return layout({
      instanceName: context.instanceName,
      subject: "Test email from Nook",
      preheader: "Email from Nook reaches you.",
      eyebrow: "Account · Test",
      title: "Email from Nook works",
      lead: "You asked for a test email, and here it is. Nothing else to do.",
      blocks: [paragraph(`Sent ${formatInstant(data.sentAt, context.tz)}.`)],
      action: { label: "Open email settings", href: appLink(paths.settings("notifications")) },
      footer: accountFooter("You got this because you pressed “Send me a test email” in Settings.")
    });
  },
  fixture: () => ({ sentAt: "2026-09-28T09:00:00.000Z" })
});
