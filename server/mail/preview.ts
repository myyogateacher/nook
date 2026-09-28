import type { Hono } from "hono";
import { config } from "../config";
import { escapeHtml } from "./html";
import { appLink, paths } from "./links";
import { previewFixtures, renderTemplate, TEMPLATES } from "./registry";
import type { RenderContext } from "./templates/types";

/** A placeholder unsubscribe token for previews and goldens (it does not verify). */
export const PREVIEW_UNSUBSCRIBE_TOKEN = "cHJldmlldy1vbmx5LW5vdC1hLXRva2Vu.cHJldmlldzAw";

/** The render context for a fixture: activity mail gets the footer's one-click link. */
export function fixtureContext(template: keyof typeof TEMPLATES, instanceName = config.mail.instanceName): RenderContext {
  const definition = TEMPLATES[template];
  return {
    instanceName,
    tz: "UTC",
    unsubscribeHref: definition.class === "activity" ? appLink(paths.unsubscribePage(PREVIEW_UNSUBSCRIBE_TOKEN)) : undefined
  };
}

export function renderFixture(id: string, instanceName?: string) {
  const fixture = previewFixtures().find((item) => item.id === id);
  if (!fixture) return null;
  return renderTemplate(fixture.template, fixture.data, fixtureContext(fixture.template, instanceName));
}

/**
 * The dev-only mail preview (D253, T232): `/dev/mail/preview` lists the fixtures and
 * `/dev/mail/preview/:template?scheme=light|dark&format=html|text` renders one. Never sends. Outside
 * production only; in production every /dev path is 404 (and never falls through to the SPA).
 */
export function registerMailPreviewRoutes(app: Hono<any>, production = config.isProduction) {
  if (production) {
    app.all("/dev/*", (c) => c.text("Not found", 404));
    return;
  }
  app.get("/dev/mail/preview", (c) => {
    const items = previewFixtures().map((item) => `<li><a href="/dev/mail/preview/${escapeHtml(item.id)}">${escapeHtml(item.id)}</a> · <a href="/dev/mail/preview/${escapeHtml(item.id)}?scheme=dark">dark</a> · <a href="/dev/mail/preview/${escapeHtml(item.id)}?format=text">text</a></li>`).join("");
    c.header("Cache-Control", "no-store");
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mail preview</title></head><body style="font-family:system-ui;padding:24px"><h1>Mail preview</h1><p>Fixture data only; nothing is sent.</p><ul>${items}</ul></body></html>`);
  });
  app.get("/dev/mail/preview/:template", (c) => {
    const rendered = renderFixture(c.req.param("template"));
    if (!rendered) return c.text("Unknown template", 404);
    c.header("Cache-Control", "no-store");
    if (c.req.query("format") === "text") return c.text(`Subject: ${rendered.subject}\n\n${rendered.text}`);
    // Dark: apply the prefers-color-scheme overrides unconditionally, as a dark-mode client would.
    const markup = c.req.query("scheme") === "dark" ? rendered.html.replace("@media (prefers-color-scheme:dark){", "@media all{") : rendered.html;
    return c.html(markup);
  });
}
