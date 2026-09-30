import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { relativeTime } from "../files/format";
import { KeysDialog } from "../keys/KeysDialog";
import { collectProblems, FieldError, useFieldErrors } from "../auth/fieldChecks";
import { Select } from "../ui/Select";
import { Avatar } from "../ui/Avatar";
import { createIntegration, INTEGRATION_ROLE_OPTIONS, lastUsedText, listIntegrations, RETIRED_LABEL, type Integration, type IntegrationRole } from "./integrationsApi";
import "../keys/keys.css";

/** The help line under Team → Integrations (Wave 36, D287, T212): what an integration can and cannot reach. */
export const INTEGRATIONS_HELP = "Accounts for AI clients and scripts. An integration never signs in: it acts only through the API keys you create for it here. "
  + "Its keys reach only what owners share with it by name in their Access sheet, never what is open to everyone, and never your own items. "
  + "Admins hold its keys, so admins can read what owners share with it, and nothing else of theirs; owners see this when they share.";

/**
 * Team → Integrations at /team/integrations (Wave 36, D287), admins only: every integration with its
 * role, status, live keys, and last use, and New integration. One integration opens at
 * /team/integrations/:integrationId.
 */
export function TeamIntegrations({ onBack, onOpen, flash }: { onBack: () => void; onOpen: (integrationId: string) => void; flash: (message: string) => void }) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listIntegrations();
      if (current === generation.current) setIntegrations(result.integrations);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load integrations");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = "Integrations · Team · Nook"; }, []);

  return <article className="team-detail team-integrations" aria-labelledby="team-integrations-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-integrations-title">Integrations</h2>
        <p className="team-muted">{INTEGRATIONS_HELP}</p>
      </div>
      <button type="button" className="primary-button team-groups-new" onClick={() => setCreating(true)} aria-haspopup="dialog"><Plus />New integration</button>
    </header>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load integrations</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !integrations && <p className="team-loading" role="status">Loading integrations…</p>}
    {!error && integrations && integrations.length === 0 && <div className="team-state">
      <span className="team-state-icon"><Bot /></span>
      <h2>No integrations yet.</h2>
      <p>Create one for a CI job, a bot, or an AI client, then give it a key. Owners share items with it like with a person.</p>
    </div>}
    {!error && integrations && integrations.length > 0 && <ul className="team-list" aria-label="Integrations">
      {integrations.map((integration) => <li key={integration.id}>
        <button type="button" className={`team-row team-group-row${integration.status !== "active" ? " blocked" : ""}`} onClick={() => onOpen(integration.id)}>
          <Avatar className="team-avatar" name={integration.displayName} integration />
          <span className="team-row-copy">
            <span className="team-row-title"><strong>{integration.displayName}</strong></span>
            <span className="team-row-meta">
              <span>{integration.keys.live === 1 ? "1 live key" : `${integration.keys.live} live keys`}</span>
              <span>{lastUsedText(integration, relativeTime)}</span>
            </span>
          </span>
          <span className="team-row-chips">
            <span className={`team-role-chip ${integration.role}`}><span className="sr-only">Role: </span>{integration.role === "viewer" ? "Viewer" : "Member"}</span>
            {integration.status === "blocked" && <span className="team-status-chip">Blocked</span>}
            {integration.status === "retired" && <span className="team-status-chip">{RETIRED_LABEL}</span>}
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
    {creating && <IntegrationFormDialog title="New integration" submitLabel="Create integration" onClose={() => setCreating(false)} onSubmit={async (value) => {
      const { integration } = await createIntegration(value);
      setCreating(false);
      flash(`${integration.displayName} was created. Give it a key next.`);
      onOpen(integration.id);
    }} />}
  </article>;
}

/** Name, role (Member or Viewer, never Admin), and description: create and edit. Errors show inline. */
export function IntegrationFormDialog({ title, submitLabel, initial, onClose, onSubmit }: {
  title: string;
  submitLabel: string;
  initial?: { name: string; role: IntegrationRole; description: string | null };
  onClose: () => void;
  onSubmit: (value: { name: string; role: IntegrationRole; description: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState<IntegrationRole>(initial?.role ?? "member");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = useFieldErrors();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fields.show(event.currentTarget, collectProblems({ name: name.trim() ? null : "Give the integration a name." }))) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name: name.trim(), role, description: description.trim() || null });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the integration");
      setBusy(false);
    }
  }
  return <KeysDialog title={title} description="An integration never signs in. It acts only through keys you create for it, and reaches only what owners share with it." onClose={onClose} busy={busy}>
    <form className="keys-form" onSubmit={submit} noValidate>
      <label className="keys-input">Name<input name="name" value={name} onChange={(event) => { setName(event.target.value); fields.clear("name"); }} maxLength={80} autoFocus disabled={busy} placeholder="CI reporter" autoComplete="off"
        aria-invalid={fields.errors.name ? true : undefined} aria-describedby={fields.errors.name ? "integration-name-error" : undefined} />
        <FieldError id="integration-name-error" message={fields.errors.name} /></label>
      <div className="keys-select-field"><span id="integration-role-label">Role</span>
        <Select<IntegrationRole> labelledBy="integration-role-label" label="Role" value={role} options={INTEGRATION_ROLE_OPTIONS} onChange={setRole} disabled={busy} />
        <small>Integrations are members or viewers, never admins.</small>
      </div>
      <label className="keys-input">Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} rows={2} disabled={busy} placeholder="What it does and who runs it" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  </KeysDialog>;
}
