import { cleanLine, html, join, type SafeHtml } from "./html";

/**
 * The one mail layout (docs/plan/research/2026-09-28-outbound-email.md §C.1–C.2, D250, D251): a
 * light body card under the dark `#111113` brand band with the gold "N" mark, 600 px, one column of
 * presentation tables, every style inline, and `<style>` only as a progressive enhancement (the
 * dark-mode media query and phone padding). No images, no web fonts, no remote requests.
 *
 * Components return both markup and plain text, so every mail has a first-class text part with each
 * link on its own line.
 */

export const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Email-safe tokens from the app palette (src/styles.css), light first. */
export const COLORS = {
  page: "#f4f4f5",
  band: "#111113",
  card: "#ffffff",
  border: "#e4e4e7",
  text: "#18181b",
  muted: "#52525b",
  gold: "#f6c453",
  goldText: "#8a5a00",
  buttonText: "#281f0b",
  goldDim: "#fbe7b0",
  context: "#fafafa",
  danger: "#be123c"
} as const;

export type Tone = "default" | "security";
export type Block = { html: SafeHtml; text: string };

const accent = (tone: Tone) => tone === "security" ? COLORS.danger : COLORS.gold;

/** A paragraph of body text. */
export function paragraph(text: string): Block {
  return {
    html: html`<p class="nk-text" style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${COLORS.text};">${text}</p>`,
    text
  };
}

/** A small muted line (expiry, hints). */
export function note(text: string): Block {
  return {
    html: html`<p class="nk-muted" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.5;color:${COLORS.muted};">${text}</p>`,
    text
  };
}

export type ContextRow = { title: string; meta?: string; href?: string; quote?: string };

/**
 * The context block: the object the mail is about, inside a quoted panel with a gold (or red) left
 * bar, never as the heading (T222). User text is escaped and one line.
 */
export function context(rows: readonly ContextRow[], options: { tone?: Tone; more?: number; moreLabel?: string } = {}): Block {
  const bar = accent(options.tone ?? "default");
  const items = rows.map((row, index) => {
    const title = row.href
      ? html`<a href="${row.href}" class="nk-text" style="color:${COLORS.text};text-decoration:underline;text-decoration-color:${COLORS.border};">${row.title}</a>`
      : html`${row.title}`;
    return html`<tr><td style="padding:${index === 0 ? "0" : "12px"} 0 0;">
<p class="nk-text" style="margin:0;font-family:${FONT};font-size:15px;line-height:1.45;font-weight:600;color:${COLORS.text};">${title}</p>
${row.meta ? html`<p class="nk-muted" style="margin:2px 0 0;font-family:${FONT};font-size:13px;line-height:1.45;color:${COLORS.muted};">${row.meta}</p>` : ""}
${row.quote ? html`<p class="nk-text" style="margin:6px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${COLORS.text};">${row.quote}</p>` : ""}
</td></tr>`;
  });
  const more = options.more && options.more > 0 ? options.moreLabel ?? `and ${options.more} more` : null;
  const markup = html`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border-collapse:separate;">
<tr><td class="nk-context" style="background:${COLORS.context};border-left:3px solid ${bar};border-radius:0 8px 8px 0;padding:14px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${join(items)}${more ? html`<tr><td style="padding:12px 0 0;"><p class="nk-muted" style="margin:0;font-family:${FONT};font-size:13px;line-height:1.45;color:${COLORS.muted};">${more}</p></td></tr>` : ""}</table>
</td></tr></table>`;
  const text = [
    ...rows.map((row) => [
      `> ${row.title}`,
      ...(row.meta ? [`  ${row.meta}`] : []),
      ...(row.quote ? [`  "${row.quote}"`] : []),
      ...(row.href ? [`  ${row.href}`] : [])
    ].join("\n")),
    ...(more ? [`> ${more}`] : [])
  ].join("\n");
  return { html: markup, text };
}

/**
 * The single primary action: a bulletproof gold button (a padded link, with a VML round rectangle
 * for Outlook on Windows), then the bare link for clients that hide buttons.
 */
export function button(label: string, href: string): Block {
  const markup = html`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;"><tr><td align="left">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="23%" stroke="f" fillcolor="${COLORS.gold}"><w:anchorlock/><center style="color:${COLORS.buttonText};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" class="nk-button" style="display:inline-block;background:${COLORS.gold};color:${COLORS.buttonText};font-family:${FONT};font-size:15px;font-weight:700;line-height:44px;min-height:44px;padding:0 22px;border-radius:10px;text-decoration:none;">${label}</a><!--<![endif]-->
</td></tr></table>
<p class="nk-muted" style="margin:0 0 4px;font-family:${FONT};font-size:13px;line-height:1.5;color:${COLORS.muted};word-break:break-all;">Or open: <a href="${href}" class="nk-muted" style="color:${COLORS.muted};">${href}</a></p>`;
  return { html: markup, text: `${label}:\n${href}` };
}

export type Footer = {
  /** "You got this because …". */
  reason: string;
  /** Activity mail: the one-click category switch-off link, and its label. */
  unsubscribe?: { href: string; label: string };
  /** Omitted for mail to someone without an account (an invite). */
  settingsHref?: string;
  security?: boolean;
};

export type LayoutInput = {
  subject: string;
  preheader: string;
  eyebrow: string;
  title: string;
  lead?: string;
  blocks: readonly Block[];
  action?: { label: string; href: string };
  footer: Footer;
  tone?: Tone;
  instanceName: string;
};

export type RenderedMail = { subject: string; html: string; text: string };

const STYLE = html`<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%}
a{color:inherit}
@media (max-width:620px){.nk-pad{padding-left:20px!important;padding-right:20px!important}.nk-outer{padding:12px 8px!important}}
@media (prefers-color-scheme:dark){
.nk-page{background:#09090a!important}
.nk-card{background:#18181b!important;border-color:#29292d!important}
.nk-context{background:#111113!important}
.nk-text{color:#f5f5f4!important}
.nk-muted{color:#a1a1aa!important}
.nk-eyebrow{color:#f6c453!important}
.nk-eyebrow-security{color:#fb7185!important}
}
[data-ogsc] .nk-page{background:#09090a!important}
[data-ogsc] .nk-card{background:#18181b!important;border-color:#29292d!important}
[data-ogsc] .nk-context{background:#111113!important}
[data-ogsc] .nk-text{color:#f5f5f4!important}
[data-ogsc] .nk-muted{color:#a1a1aa!important}
[data-ogsc] .nk-eyebrow{color:#f6c453!important}
</style>`;

const SUBJECT_MAX = 120;

/** Renders a mail from its parts. Subject and preheader are one line and length-capped (T228). */
export function layout(input: LayoutInput): RenderedMail {
  const tone = input.tone ?? "default";
  const subject = cleanLine(input.subject, SUBJECT_MAX, "Nook");
  const preheader = cleanLine(input.preheader, 150);
  const instance = cleanLine(input.instanceName, 40, "Nook", false);
  const blocks = [...input.blocks, ...(input.action ? [button(input.action.label, input.action.href)] : [])];
  const eyebrowColor = tone === "security" ? COLORS.danger : COLORS.goldText;
  const footer = input.footer;
  const footerLinks = [
    ...(footer.unsubscribe ? [html`<a href="${footer.unsubscribe.href}" class="nk-muted" style="color:${COLORS.muted};text-decoration:underline;">${footer.unsubscribe.label}</a>`] : []),
    ...(footer.settingsHref ? [html`<a href="${footer.settingsHref}" class="nk-muted" style="color:${COLORS.muted};text-decoration:underline;">Email settings</a>`] : [])
  ];
  const securityLine = "Security emails can't be turned off. They tell you about changes to your account.";

  const markup = html`<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
${STYLE}
</head>
<body class="nk-page" style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;opacity:0;color:${COLORS.page};">${preheader}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<div role="article" aria-roledescription="email" aria-label="${subject}" lang="en">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="nk-page" style="background:${COLORS.page};">
<tr><td align="center" class="nk-outer" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
<tr><td class="nk-pad" bgcolor="${COLORS.band}" style="background:${COLORS.band};border-radius:12px 12px 0 0;padding:16px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="28" height="28" align="center" valign="middle" bgcolor="${COLORS.gold}" style="width:28px;height:28px;background:${COLORS.gold};border-radius:7px;font-family:${FONT};font-size:16px;line-height:28px;font-weight:800;color:${COLORS.buttonText};">N</td>
<td style="padding-left:10px;font-family:${FONT};font-size:16px;line-height:28px;font-weight:700;color:#f5f5f4;">Nook</td>
<td style="padding-left:10px;font-family:${FONT};font-size:13px;line-height:28px;color:${COLORS.goldDim};">${instance}</td>
</tr></table>
</td></tr>
<tr><td class="nk-card nk-pad" bgcolor="${COLORS.card}" style="background:${COLORS.card};border:1px solid ${COLORS.border};border-top:0;border-radius:0 0 12px 12px;padding:28px 32px 24px;">
<p class="${tone === "security" ? "nk-eyebrow-security" : "nk-eyebrow"}" style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${eyebrowColor};">${input.eyebrow}</p>
<h1 class="nk-text" style="margin:0 0 10px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${COLORS.text};">${input.title}</h1>
${input.lead ? html`<p class="nk-muted" style="margin:0 0 18px;font-family:${FONT};font-size:16px;line-height:1.55;color:${COLORS.muted};">${input.lead}</p>` : ""}
${join(blocks.map((block) => block.html))}
</td></tr>
<tr><td class="nk-pad" style="padding:20px 32px 8px;" align="center">
<p class="nk-muted" style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};text-align:center;">${footer.reason}</p>
${footer.security ? html`<p class="nk-muted" style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};text-align:center;">${securityLine}</p>` : ""}
${footerLinks.length ? html`<p class="nk-muted" style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};text-align:center;">${join(footerLinks.flatMap((link, index) => index ? [html` &middot; `, link] : [link]))}</p>` : ""}
<p class="nk-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};text-align:center;">Sent by Nook on ${instance}, a self-hosted workspace. No tracking. Nook never asks for your password by email.</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>
`;

  const text = [
    `Nook · ${instance}`,
    "",
    input.eyebrow.toUpperCase(),
    cleanLine(input.title, 200),
    ...(input.lead ? ["", input.lead] : []),
    "",
    ...blocks.map((block) => `${block.text}\n`),
    "--",
    footer.reason,
    ...(footer.security ? [securityLine] : []),
    ...(footer.unsubscribe ? [`${footer.unsubscribe.label}:`, footer.unsubscribe.href] : []),
    ...(footer.settingsHref ? ["Email settings:", footer.settingsHref] : []),
    `Sent by Nook on ${instance}, a self-hosted workspace. No tracking. Nook never asks for your password by email.`,
    ""
  ].join("\n");

  return { subject, html: markup.toString(), text };
}
