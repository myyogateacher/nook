/**
 * The invite email (operator decision 2026-09-28), on the shared mail layout since Wave 28 (D254):
 * no images, no remote content, no tracking. The only link is the invite link itself, in its
 * fragment form. The inviter appears by display name only.
 */
import { config } from "../config";
import type { MailMessage } from "../mail";
import { inviteTemplate } from "../mail/templates/account";
import type { InviteRole } from "./invites";

/** "5 October 2026 at 10:00 UTC": the server does not know the recipient's time zone. */
export function formatExpiry(iso: string) {
  const date = new Date(iso);
  return `${date.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}

export function inviteEmail(input: { to: string; url: string; role: InviteRole; expiresAt: string; inviterName: string }): MailMessage {
  const rendered = inviteTemplate.render(input, { instanceName: config.mail.instanceName, tz: "UTC" });
  return { to: input.to, subject: rendered.subject, text: rendered.text, html: rendered.html };
}
