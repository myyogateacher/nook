import { audit, db, now } from "../db";
import { AGENT_BOUNDS } from "../../shared/agents";
import type { ReportModelChoice, ReportModelView } from "../../shared/reportsModel";
import type { ProviderConnection } from "../agents/loop";
import { connectionFor, defaultProvider, providerChoices } from "../agents/providers";
import { readAgentSettings, roleMayChat, roleMayCreate } from "../agents/settings";
import { ownedReport, readableReport } from "./access";
import { ReportError } from "./errors";

/**
 * Which model writes a report (wave 48b, D435). One resolver for generation and every later agent
 * that writes a report (wave 48's edit agent): `reportModelFor(reportId)`.
 *
 * 1. The report's own override (`reports.model_provider_id`, `reports.model`, owner-editable), when
 *    its provider still exists (a removed provider reads as no override).
 * 2. The admin's "Report generation model" (agent settings `report_provider_id`, `report_model`).
 * 3. Chat's default provider and its default model (`connectionFor(null, null)`).
 *
 * At each level a model left empty is that provider's default model; a model set without a provider
 * names a model of the next level's provider. Chat never reads these settings.
 */

const providerExists = (id: string | null) => Boolean(id && db.query("SELECT 1 FROM agent_providers WHERE id = ?").get(id));
const providerName = (id: string | null) => id ? (db.query("SELECT name FROM agent_providers WHERE id = ?").get(id) as { name: string } | null)?.name ?? null : null;

/** The admin setting, or null when it names nothing (or a provider that is gone and no model). */
export function reportModelSetting(): ReportModelChoice | null {
  const settings = readAgentSettings();
  const providerId = providerExists(settings.reportProviderId) ? settings.reportProviderId : null;
  return providerId || settings.reportModel ? { providerId, model: settings.reportModel } : null;
}

/** A report's own override, or null (none, or its provider is gone and it names no model). */
export function reportModelOverride(reportId: string | null): ReportModelChoice | null {
  if (!reportId) return null;
  const row = db.query("SELECT model_provider_id, model FROM reports WHERE id = ?").get(reportId) as { model_provider_id: string | null; model: string | null } | null;
  if (!row) return null;
  const providerId = providerExists(row.model_provider_id) ? row.model_provider_id : null;
  return providerId || row.model ? { providerId, model: row.model } : null;
}

/** The provider and model a report resolves to, and where they come from. */
export function resolveReportModel(reportId: string | null): ReportModelView["effective"] {
  const levels: Array<{ source: "report" | "setting"; choice: ReportModelChoice | null }> = [{ source: "report", choice: reportModelOverride(reportId) }, { source: "setting", choice: reportModelSetting() }];
  let model: string | null = null;
  let modelSource: "report" | "setting" | null = null;
  for (const level of levels) {
    if (!level.choice) continue;
    if (level.choice.providerId) {
      const fallbackModel = model ?? level.choice.model;
      return { source: modelSource ?? level.source, providerId: level.choice.providerId, providerName: providerName(level.choice.providerId), model: fallbackModel ?? defaultModelOf(level.choice.providerId) };
    }
    if (level.choice.model && model === null) { model = level.choice.model; modelSource = level.source; }
  }
  const fallback = defaultProvider();
  return { source: modelSource ?? "default", providerId: fallback?.id ?? null, providerName: fallback?.name ?? null, model: model ?? fallback?.default_model ?? null };
}

const defaultModelOf = (providerId: string) => (db.query("SELECT default_model FROM agent_providers WHERE id = ?").get(providerId) as { default_model: string } | null)?.default_model ?? null;

/**
 * The connection a report's agent run uses (generation now; wave 48's edit agent too). `reportId`
 * null is a report not created yet: the admin setting, else chat's default. Throws `NO_PROVIDER`
 * (AgentError) when no provider is configured at all.
 */
export function reportModelFor(reportId: string | null): ProviderConnection {
  const effective = resolveReportModel(reportId);
  return connectionFor(effective.providerId, effective.model);
}

type Actor = { id: string; role: string };

/** Whether a person may choose a report's model: their role may create agents and chat (review M1). */
const mayChoose = (role: string) => {
  const settings = readAgentSettings();
  return roleMayCreate(role, settings) && roleMayChat(role, settings);
};

/**
 * The models a report owner may pick on a provider (review M1): the models an admin's Test or model
 * list last saw, the provider's default, and the admin's report model when it names this provider. With
 * the admin's "any model name" switch (`reportModelFreeText`) any one-line name is allowed.
 */
export function allowedReportModels(providerId: string): string[] {
  const choice = providerChoices().find((provider) => provider.id === providerId);
  if (!choice) return [];
  const settings = readAgentSettings();
  const setting = settings.reportModel && (settings.reportProviderId === providerId || (!settings.reportProviderId && defaultProvider()?.id === providerId)) ? [settings.reportModel] : [];
  return [...new Set([choice.defaultModel, ...setting, ...(choice.models ?? [])])].slice(0, 200);
}

/** `GET /api/reports/:id/model`: anyone who can read the report sees it; only the owner, in a role that may create agents and chat, may change it. */
export function reportModelView(reportId: string, actor: Actor): ReportModelView {
  const row = readableReport(reportId, actor.id);
  const own = db.query("SELECT model_provider_id, model FROM reports WHERE id = ?").get(reportId) as { model_provider_id: string | null; model: string | null };
  const canEdit = row.owner_id === actor.id && mayChoose(actor.role);
  return {
    override: own.model_provider_id || own.model ? { providerId: own.model_provider_id, model: own.model } : null,
    effective: resolveReportModel(reportId),
    providers: canEdit ? providerChoices().map((provider) => ({ id: provider.id, name: provider.name, defaultModel: provider.defaultModel, models: allowedReportModels(provider.id) })) : [],
    freeText: readAgentSettings().reportModelFreeText,
    canEdit
  };
}

/**
 * `PUT /api/reports/:id/model` (review M1): the owner sets or clears the override. Setting one needs a
 * role that may create agents and chat (403 `ROLE_READ_ONLY`); the provider must be one of
 * `providerChoices()`, and the model one of `allowedReportModels` for the provider it will run on
 * unless the admin allows any name. Clearing is always allowed.
 */
export function setReportModel(reportId: string, actor: Actor, override: ReportModelChoice | null): ReportModelView {
  ownedReport(reportId, actor.id);
  const providerId = override?.providerId ?? null;
  const model = override?.model?.trim() || null;
  if (providerId || model) {
    if (!mayChoose(actor.role)) throw new ReportError(403, "ROLE_READ_ONLY", "Your role cannot choose the model that writes reports");
    if (providerId && !providerChoices().some((provider) => provider.id === providerId)) throw new ReportError(400, "INVALID", "That provider is not one you can choose", { field: "providerId" });
    if (model && (model.length > AGENT_BOUNDS.model || /[\u0000-\u001f\u007f]/.test(model))) throw new ReportError(400, "INVALID", "The model must be one line", { field: "model" });
    if (model && !readAgentSettings().reportModelFreeText) {
      // The provider the model will run on: this override's, else the next level's.
      const target = providerId ?? (reportModelSetting()?.providerId ?? defaultProvider()?.id ?? null);
      if (!target || !allowedReportModels(target).includes(model)) throw new ReportError(400, "INVALID", "Choose one of the provider's listed models", { field: "model" });
    }
  }
  db.query("UPDATE reports SET model_provider_id = ?, model = ?, updated_at = ? WHERE id = ?").run(providerId, model, now(), reportId);
  audit(actor.id, null, "reports.model.set", { reportId, providerId, model, cleared: !providerId && !model });
  return reportModelView(reportId, actor);
}
