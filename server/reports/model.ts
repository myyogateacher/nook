import { audit, db, now } from "../db";
import { AGENT_BOUNDS } from "../../shared/agents";
import type { ReportModelChoice, ReportModelView } from "../../shared/reportsModel";
import type { ProviderConnection } from "../agents/loop";
import { connectionFor, defaultProvider, providerChoices } from "../agents/providers";
import { readAgentSettings } from "../agents/settings";
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

/** `GET /api/reports/:id/model`: anyone who can read the report sees it; only the owner may change it. */
export function reportModelView(reportId: string, userId: string): ReportModelView {
  const row = readableReport(reportId, userId);
  const own = db.query("SELECT model_provider_id, model FROM reports WHERE id = ?").get(reportId) as { model_provider_id: string | null; model: string | null };
  return {
    override: own.model_provider_id || own.model ? { providerId: own.model_provider_id, model: own.model } : null,
    effective: resolveReportModel(reportId),
    providers: providerChoices().map((provider) => ({ id: provider.id, name: provider.name, defaultModel: provider.defaultModel, models: provider.models })),
    canEdit: row.owner_id === userId
  };
}

/** `PUT /api/reports/:id/model`: the owner sets or clears the override (a provider must exist; a model is one line). */
export function setReportModel(reportId: string, userId: string, override: ReportModelChoice | null): ReportModelView {
  ownedReport(reportId, userId);
  const providerId = override?.providerId ?? null;
  const model = override?.model?.trim() || null;
  if (providerId && !providerExists(providerId)) throw new ReportError(400, "INVALID", "That provider does not exist", { field: "providerId" });
  if (model && (model.length > AGENT_BOUNDS.model || /[\u0000-\u001f\u007f]/.test(model))) throw new ReportError(400, "INVALID", "The model must be one line", { field: "model" });
  db.query("UPDATE reports SET model_provider_id = ?, model = ?, updated_at = ? WHERE id = ?").run(providerId, model, now(), reportId);
  audit(userId, null, "reports.model.set", { reportId, providerId, model, cleared: !providerId && !model });
  return reportModelView(reportId, userId);
}
