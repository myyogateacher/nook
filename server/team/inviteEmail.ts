/**
 * The invite email (operator decision 2026-09-28): plain text plus minimal HTML with inline styles.
 * No images, no remote content, no tracking pixels or tracked links: the only link is the invite
 * link itself, in its fragment form. The inviter appears by display name only.
 */
import { escapeHtml, type MailMessage } from "../mail";
import type { InviteRole } from "./invites";

const ROLE_LABELS: Record<InviteRole, string> = { member: "Member", viewer: "Viewer", guest: "Guest" };
const ROLE_LINES: Record<InviteRole, string> = {
  member: "Members create, edit, and share notes, files, tasks, collections, and events.",
  viewer: "Viewers read what is shared with them or with everyone.",
  guest: "Guests read only what is shared with them by name."
};

/** "5 October 2026, 10:00 UTC": the server does not know the recipient's time zone. */
export function formatExpiry(iso: string) {
  const date = new Date(iso);
  return `${date.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}

/** One line, at most 80 characters, so a display name cannot inject headers or long subjects. */
const cleanName = (name: string) => name.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "An admin";

export function inviteEmail(input: { to: string; url: string; role: InviteRole; expiresAt: string; inviterName: string }): MailMessage {
  const inviter = cleanName(input.inviterName);
  const role = ROLE_LABELS[input.role];
  const expiry = formatExpiry(input.expiresAt);
  const subject = `${inviter} invited you to Nook`;
  const text = [
    `${inviter} invited you to join their Nook as a ${role}.`,
    ROLE_LINES[input.role],
    "",
    "Create your account with this link:",
    input.url,
    "",
    `The link works once and expires on ${expiry}. It only works for ${input.to}.`,
    "If you did not expect this email, ignore it: nothing happens until someone opens the link.",
    "Do not forward this email; anyone with the link can use it."
  ].join("\n");
  const safeUrl = escapeHtml(input.url);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e3e3e6;border-radius:12px;padding:24px;">
<p style="margin:0 0 12px;font-size:16px;line-height:1.5;"><strong>${escapeHtml(inviter)}</strong> invited you to join their Nook as a <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5;color:#55555a;">${escapeHtml(ROLE_LINES[input.role])}</p>
<p style="margin:0 0 20px;"><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#f6c453;color:#281f0b;font-weight:700;text-decoration:none;">Create your account</a></p>
<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#55555a;">Or paste this link into your browser:<br><span style="word-break:break-all;color:#1d1d1f;">${safeUrl}</span></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#55555a;">The link works once and expires on ${escapeHtml(expiry)}. It only works for ${escapeHtml(input.to)}. If you did not expect this email, ignore it. Do not forward it: anyone with the link can use it.</p>
</div></body></html>`;
  return { to: input.to, subject, text, html };
}
