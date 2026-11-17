import type { Hono } from "hono";
import { config } from "../config";
import { escapeHtml } from "./html";
import { appLink, paths } from "./links";
import { previewFixtures, registeredMailTemplate, registeredMailTemplateNames, renderTemplate, TEMPLATES, type RegisteredMailTemplate } from "./registry";
import { sharedTemplate } from "./templates/activity";
import type { RenderContext } from "./templates/types";

/** A placeholder unsubscribe token for previews and goldens (it does not verify). */
export const PREVIEW_UNSUBSCRIBE_TOKEN = "cHJldmlldy1vbmx5LW5vdC1hLXRva2Vu.cHJldmlldzAw";

/** The render context for a fixture: activity mail gets the footer's one-click link. */
export function fixtureContext(template: keyof typeof TEMPLATES, instanceName = config.mail.instanceName): RenderContext {
  const definition = TEMPLATES[template];
  return {
    instanceName,
    tz: "UTC",
    unsubscribeHref: definition.class === "activity" || definition.class === "reminders" || definition.class === "digest" ? appLink(paths.unsubscribePage(PREVIEW_UNSUBSCRIBE_TOKEN)) : undefined
  };
}

/** Dark: the prefers-color-scheme overrides applied unconditionally, as a dark-mode client would (goldens too). */
export const darkPreview = (markup: string) => markup.replace("@media (prefers-color-scheme:dark){", "@media all{");

/**
 * The templates registered at run time (D1368): the workspace modules' (`time.update`, `goals.update`,
 * `crm.update`, bookings, forms, standups, townhall) and core ones outside the built-in set
 * (`core.comment`, `core.mention`), each with its own fixture, so every template that can be sent can
 * be previewed. Plus preview-only variants worth seeing (a module item in "Shared with you", D1366).
 * Not in the goldens: those cover the built-in set (tests/mailTemplates.test.ts).
 */
export function registeredPreviewFixtures(): Array<{ id: string; render: (instanceName?: string) => ReturnType<RegisteredMailTemplate["render"]> }> {
  const context = (definition: Pick<RegisteredMailTemplate, "class">, instanceName = config.mail.instanceName): RenderContext => ({
    instanceName, tz: "UTC",
    unsubscribeHref: definition.class === "activity" || definition.class === "reminders" || definition.class === "digest" ? appLink(paths.unsubscribePage(PREVIEW_UNSUBSCRIBE_TOKEN)) : undefined
  });
  const registered = registeredMailTemplateNames().sort().flatMap((name) => {
    const definition = registeredMailTemplate(name);
    return definition ? [{ id: name, render: (instanceName?: string) => definition.render(definition.fixture(), context(definition, instanceName)) }] : [];
  });
  const moduleShare = {
    id: "sharing.shared.module",
    render: (instanceName?: string) => sharedTemplate.render({ actors: ["Priya Shah"], items: [{ kind: "time_project", id: "6f0ea7bd-c2e3-4417-9d99-669fca132a4e", title: "Website rebuild", access: "edit", path: "/time/projects/website-rebuild-k7f3q2ab01" }] }, context(sharedTemplate, instanceName))
  };
  return [...registered, moduleShare];
}

export function renderFixture(id: string, instanceName?: string) {
  const fixture = previewFixtures().find((item) => item.id === id);
  if (fixture) return renderTemplate(fixture.template, fixture.data, fixtureContext(fixture.template, instanceName));
  return registeredPreviewFixtures().find((item) => item.id === id)?.render(instanceName) ?? null;
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
    const items = [...previewFixtures(), ...registeredPreviewFixtures()].map((item) => `<li><a href="/dev/mail/preview/${escapeHtml(item.id)}">${escapeHtml(item.id)}</a> · <a href="/dev/mail/preview/${escapeHtml(item.id)}?scheme=dark">dark</a> · <a href="/dev/mail/preview/${escapeHtml(item.id)}?format=text">text</a></li>`).join("");
    c.header("Cache-Control", "no-store");
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mail preview</title></head><body style="font-family:system-ui;padding:24px"><h1>Mail preview</h1><p>Fixture data only; nothing is sent.</p><ul>${items}</ul></body></html>`);
  });
  app.get("/dev/mail/preview/:template", (c) => {
    const rendered = renderFixture(c.req.param("template"));
    if (!rendered) return c.text("Unknown template", 404);
    c.header("Cache-Control", "no-store");
    if (c.req.query("format") === "text") return c.text(`Subject: ${rendered.subject}\n\n${rendered.text}`);
    const markup = c.req.query("scheme") === "dark" ? darkPreview(rendered.html) : rendered.html;
    return c.html(markup);
  });
}
