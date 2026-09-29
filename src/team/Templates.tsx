import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, LayoutTemplate, Pencil, Plus, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { ApiError } from "../api";
import { KeysDialog } from "../keys/KeysDialog";
import { Combobox } from "../ui/Combobox";
import { Select, type Option } from "../ui/Select";
import { createTemplate, deleteTemplate, listTemplates, patchTemplate, type AccessTemplate, type TemplateRole } from "../access/memberAccessApi";
import { listGroups, type GroupSummary } from "./groupsApi";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "./teamRoles";
import { collectProblems, FieldError, useFieldErrors } from "../auth/fieldChecks";
import "../keys/keys.css";
import "../access/memberAccess.css";

/**
 * Team → Templates at /team/templates (Wave 33, access plan D286), admins only: a name, a team
 * role, and groups. Pick one when creating an invite, and the new account joins those groups when
 * it registers; or add a template's groups to someone from their access page. A template never
 * opens an item by itself: groups reach only what owners shared with them.
 */

export const TEMPLATE_ROLES: TemplateRole[] = ["member", "viewer", "guest"];
export const templateRoleOptions = (): Option<TemplateRole>[] => TEMPLATE_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], description: ROLE_DESCRIPTIONS[role] }));

const stale = (reason: unknown) => reason instanceof ApiError && reason.status === 409 && (reason.payload as { code?: unknown } | null)?.code === "TEMPLATE_CHANGED";

export function Templates({ onBack, flash }: { onBack: () => void; flash: (message: string) => void }) {
  const [templates, setTemplates] = useState<AccessTemplate[] | null>(null);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccessTemplate | "new" | null>(null);
  const [deleting, setDeleting] = useState<AccessTemplate | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const [result, groupList] = await Promise.all([listTemplates(), listGroups()]);
      if (current !== generation.current) return;
      setTemplates(result.templates);
      setGroups(groupList.groups);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load templates");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = "Templates · Team · Nook"; }, []);

  return <article className="team-detail team-templates" aria-labelledby="team-templates-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-templates-title">Templates</h2>
        <p className="team-muted">A team role and groups for new people. Choose one on an invite and the new account joins those groups when it registers. A template never opens anything by itself: groups reach only what owners shared with them.</p>
      </div>
      <button type="button" className="primary-button ma-header-button" onClick={() => setEditing("new")} aria-haspopup="dialog"><Plus />New template</button>
    </header>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load templates</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !templates && <p className="team-loading" role="status">Loading templates…</p>}
    {!error && templates && templates.length === 0 && <div className="team-state">
      <span className="team-state-icon"><LayoutTemplate /></span>
      <h2>No templates yet.</h2>
      <p>For example, “Ops”: Member, in the Ops and On-call groups.</p>
    </div>}
    {!error && templates && templates.length > 0 && <ul className="template-list" aria-label="Templates">
      {templates.map((template) => <li key={template.id} className="template-row">
        <span className="team-row-copy">
          <span className="team-row-title"><strong>{template.name}</strong></span>
          <span className="team-row-meta">
            <span className={`team-role-chip ${template.role}`}><span className="sr-only">Team role: </span>{ROLE_LABELS[template.role]}</span>
            <span>{template.groups.length ? template.groups.map((group) => group.name).join(", ") : "No groups"}</span>
            <span>{template.liveInvites ? `${template.liveInvites} live ${template.liveInvites === 1 ? "invite carries" : "invites carry"} it` : "No live invites"}</span>
          </span>
        </span>
        <span className="template-row-actions">
          <button type="button" className="icon-button" aria-label={`Edit ${template.name}`} title="Edit" aria-haspopup="dialog" onClick={() => setEditing(template)}><Pencil /></button>
          <button type="button" className="icon-button" aria-label={`Delete ${template.name}`} title="Delete" aria-haspopup="dialog" onClick={() => setDeleting(template)}><Trash2 /></button>
        </span>
      </li>)}
    </ul>}
    {editing && <TemplateFormDialog template={editing === "new" ? null : editing} groups={groups} onClose={() => setEditing(null)} onSaved={(message) => { setEditing(null); flash(message); void load(); }} onStale={() => { setEditing(null); flash("Someone else changed this template. It now shows the latest."); void load(); }} />}
    {deleting && <DeleteTemplateDialog template={deleting} onClose={() => setDeleting(null)} onDone={(message) => { setDeleting(null); flash(message); void load(); }} />}
  </article>;
}

function TemplateFormDialog({ template, groups, onClose, onSaved, onStale }: { template: AccessTemplate | null; groups: GroupSummary[]; onClose: () => void; onSaved: (message: string) => void; onStale: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [role, setRole] = useState<TemplateRole>(template?.role ?? "member");
  const [groupIds, setGroupIds] = useState<string[]>(template?.groups.map((group) => group.id) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = useFieldErrors();
  const groupOptions: Option[] = groups.map((group) => ({ value: group.id, label: group.name, description: `${group.memberCount} ${group.memberCount === 1 ? "person" : "people"}` }));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The app's own check under the field (noValidate: no browser bubble, Q3).
    if (fields.show(event.currentTarget, collectProblems({ name: name.trim() ? null : "Give the template a name." }))) return;
    setBusy(true);
    setError("");
    try {
      if (template) await patchTemplate(template.id, { name: name.trim(), role, groupIds, revision: template.revision });
      else await createTemplate({ name: name.trim(), role, groupIds });
      onSaved(template ? "Template saved" : `${name.trim()} was created`);
    } catch (reason) {
      if (stale(reason)) return onStale();
      setError(reason instanceof Error ? reason.message : "Could not save the template");
      setBusy(false);
    }
  }

  return <KeysDialog title={template ? `Edit ${template.name}` : "New template"} onClose={onClose} busy={busy}>
    <form className="keys-form" onSubmit={submit} noValidate>
      <label className="keys-input">Name<input name="name" value={name} onChange={(event) => { setName(event.target.value); fields.clear("name"); }} maxLength={60} autoFocus disabled={busy}
        aria-invalid={fields.errors.name ? true : undefined} aria-describedby={fields.errors.name ? "template-name-error" : undefined} />
        <FieldError id="template-name-error" message={fields.errors.name} /></label>
      <div className="keys-select-field"><span id="template-role">Team role</span><Select<TemplateRole> labelledBy="template-role" label="Team role" value={role} options={templateRoleOptions()} onChange={setRole} disabled={busy} /></div>
      <div className="keys-select-field"><span>Groups</span><Combobox multiple value={groupIds} onChange={setGroupIds} options={groupOptions} label="Groups" placeholder="Add groups…" emptyText={groups.length ? "No more groups" : "Create groups in Team → Groups first"} disabled={busy} maxSelected={20} /></div>
      <p className="team-muted">Invites that use this template must have the same role. Each invite keeps the groups this template had when the invite was created; editing it later changes only new invites, and deleting it leaves live invites with their role and no groups.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : template ? "Save" : "Create template"}</button>
      </div>
    </form>
  </KeysDialog>;
}

function DeleteTemplateDialog({ template, onClose, onDone }: { template: AccessTemplate; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirmAction() {
    setBusy(true);
    setError("");
    try {
      await deleteTemplate(template.id, template.revision);
      onDone(`${template.name} was deleted`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the template");
      setBusy(false);
    }
  }
  const invites = template.liveInvites;
  return <KeysDialog title={`Delete ${template.name}?`} description={`${invites ? `${invites} live ${invites === 1 ? "invite uses" : "invites use"} it; they keep working with their role and no groups. ` : ""}People who already joined stay in their groups.`} onClose={onClose} busy={busy}>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="keys-dialog-actions inline">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button danger" onClick={() => { void confirmAction(); }} disabled={busy}>{busy ? "Deleting…" : "Delete template"}</button>
    </div>
  </KeysDialog>;
}
