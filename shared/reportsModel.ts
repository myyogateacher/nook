/**
 * Wave 48b wire types: which model writes a report (docs/plan/API_CONTRACTS.md § Analytics reports,
 * wave 48b; D435). Pure: no server or client imports.
 */

/** A provider and model; null provider is "the next level's", null model the provider's default. */
export type ReportModelChoice = { providerId: string | null; model: string | null };

/** Where the model a report uses comes from: the report's override, the admin setting, or chat's default provider. */
export type ReportModelSource = "report" | "setting" | "default";

/** `GET /api/reports/:id/model`: the override, what resolves now, and the providers to pick from (names and models only). */
export type ReportModelView = {
  override: ReportModelChoice | null;
  effective: { source: ReportModelSource; providerId: string | null; providerName: string | null; model: string | null };
  /** Only for someone who may edit; `models` are the names they may pick (review M1). */
  providers: Array<{ id: string; name: string; defaultModel: string; models: string[] }>;
  /** The admin lets owners type any model name. */
  freeText: boolean;
  canEdit: boolean;
};

/** `PUT /api/reports/:id/model` body: null clears the override. */
export type ReportModelInput = { override: ReportModelChoice | null };

/** What "Test tool calling" found (Settings → AI → a provider), stored in the provider's compat flags. */
export type ProbeOutcome = "supported" | "unsupported" | "inconclusive";
/**
 * Each choice: `unsupported` only after a 400 or a 2xx without the probe call; `inconclusive` (a
 * timeout, network error, 429, 5xx, or auth error) leaves the stored flag as it was. `compat` is what is stored now.
 */
export type ToolCallingProbe = {
  required: { ok: boolean; outcome: ProbeOutcome; status: number | null; error: string | null };
  named: { ok: boolean; outcome: ProbeOutcome; status: number | null; error: string | null };
  compat: { requiredToolChoice: boolean; namedToolChoice: boolean; reasoningEffort?: string };
  /** 2026-10-14: set when the model refused tools at its default reasoning and Nook found an effort that works (now saved). */
  reasoning?: { effort: string; note: string } | null;
  inconclusive: boolean;
  model: string;
  ms: number;
};
