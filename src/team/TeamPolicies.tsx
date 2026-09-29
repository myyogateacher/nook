import { useCallback, useEffect, useRef, useState } from "react";
import { SheetConfirm } from "../access/SheetConfirm";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { ChevronLeft, RotateCcw, TriangleAlert } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { Combobox } from "../ui/Combobox";
import { onCheckedChange } from "../ui/checkedChange";
import { GRANT_MODULES, MODULE_LABELS, type GrantModule } from "../keys/keyGrants";
import { getPolicies, previewPolicies, savePolicies, type Policies, type PolicyImpact, type PolicyState } from "../keys/keysApi";
import "../keys/keys.css";

/**
 * Team → Policies at /team/policies (Wave 31, access plan D285, §C.6), admins only: key lifetime,
 * required expiry, keys per person, where keys work per role, and which modules each role may
 * put in keys. Checked on every key call; a key that breaks a policy is blocked, never revoked.
 * An impact line above Save previews what the change would block. Saves with a revision check.
 */

const KEY_ROLES = ["admin", "member", "viewer"] as const;
const ROLE_NAMES: Record<(typeof KEY_ROLES)[number], string> = { admin: "Admins", member: "Members", viewer: "Viewers" };

export function impactLine(impact: PolicyImpact | null, dirty: boolean) {
  if (!impact) return "Checking which keys these settings affect…";
  const parts: string[] = [];
  if (impact.blocked) parts.push(`${impact.blocked} of ${impact.liveKeys} live ${impact.liveKeys === 1 ? "key" : "keys"} ${dirty ? "would be" : "are"} blocked${dirty && impact.newlyBlocked ? ` (${impact.newlyBlocked} newly)` : ""}`);
  if (impact.narrowed) parts.push(`${impact.narrowed} ${impact.narrowed === 1 ? "key" : "keys"} ${dirty ? "would lose" : "lose"} at least one module`);
  if (!parts.length) return `No live key ${dirty ? "would be" : "is"} blocked or narrowed (${impact.liveKeys} live).`;
  return `${parts.join("; ")}. Blocked keys are not revoked: loosening the policy brings them back.`;
}

/** The policies whose values differ between two states. */
export function changedPolicies(saved: Policies, draft: Policies) {
  return (Object.keys(draft) as Array<keyof Policies>).filter((key) => JSON.stringify(saved[key]) !== JSON.stringify(draft[key]));
}

/**
 * The line above Save for a change to sharing with guests alone (QA v0.13.0 B10): what it does to
 * sharing, not a key count. Null when keys change too (the key impact line applies).
 */
export function sharingImpactLine(saved: Policies, draft: Policies) {
  const changed = changedPolicies(saved, draft);
  if (changed.length !== 1 || changed[0] !== "shareWithGuests") return null;
  return draft.shareWithGuests
    ? "Guests can be shared with again, directly and through groups. No API key is affected."
    : "New shares with guests will be refused. Shares that already reach guests stay until they are removed. No API key is affected.";
}

/** A whole-number field that commits on every valid keystroke and snaps into range on blur. */
function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (raw: number) => Math.min(max, Math.max(min, Math.round(raw)));
  return <label className="keys-input">{label}<input type="text" inputMode="numeric" pattern="[0-9]*" value={text}
    onChange={(event) => {
      const next = event.target.value.replace(/[^0-9]/g, "").slice(0, 3);
      setText(next);
      const number = Number(next);
      if (next && number >= min && number <= max) onChange(number);
    }}
    onBlur={() => { const number = clamp(Number(text) || min); setText(String(number)); onChange(number); }} /></label>;
}

export function TeamPolicies({ onBack, flash }: { onBack: () => void; flash: (message: string) => void }) {
  const [state, setState] = useState<PolicyState | null>(null);
  const [draft, setDraft] = useState<Policies | null>(null);
  const [impact, setImpact] = useState<PolicyImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const previewGeneration = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await getPolicies();
      setState(result);
      setDraft(result.policies);
      setImpact(result.impact);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load policies");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = "Policies · Team · Nook"; }, []);

  const dirty = Boolean(state && draft && JSON.stringify(state.policies) !== JSON.stringify(draft));
  const sharingOnly = state && draft ? sharingImpactLine(state.policies, draft) : null;

  // Unsaved changes (QA v0.13.0 B4): Back, and the Team button, ask Discard or Keep editing first.
  // Back is caught by a history guard (the browser's step is undone), so the page stays behind the prompt.
  const [leaving, setLeaving] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const askLeave = useCallback(() => setLeaving(true), []);
  useHistoryDialogGuard(dirty && !leaving && !busy, askLeave);
  const keepEditing = useCallback(() => setLeaving(false), []);
  useHistoryDialogGuard(leaving, keepEditing);
  const requestBack = () => { if (dirty) setLeaving(true); else onBack(); };
  // Leave once the discarded draft has rendered, so the guards above are gone before Back runs.
  useEffect(() => {
    if (!discarded || dirty) return;
    setDiscarded(false);
    onBack();
  }, [dirty, discarded, onBack]);

  const invalid = draft ? draft.keyDefaultDays > draft.keyMaxDays ? "The default lifetime cannot be longer than the maximum." : null : null;

  // The live impact preview, 300 ms after the last change.
  useEffect(() => {
    if (!draft || !state || invalid) return undefined;
    if (!dirty || sharingOnly) { setImpact(state.impact); return undefined; }
    const current = ++previewGeneration.current;
    setImpact(null);
    const timer = setTimeout(() => {
      previewPolicies(draft).then((result) => { if (current === previewGeneration.current) setImpact(result.impact); }, () => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [dirty, draft, invalid, sharingOnly, state]);

  const set = <K extends keyof Policies>(field: K, value: Policies[K]) => setDraft((current) => current ? { ...current, [field]: value } : current);
  const toggleRole = (field: "mcpRoles" | "restRoles", role: (typeof KEY_ROLES)[number], on: boolean) =>
    set(field, KEY_ROLES.filter((item) => item === role ? on : draft![field].includes(item)));

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !state || invalid) return;
    setBusy(true);
    setFormError("");
    try {
      const saved = await savePolicies(draft, state.revision);
      setState(saved);
      setDraft(saved.policies);
      setImpact(saved.impact);
      flash(saved.changed.length ? "Policies saved" : "Nothing changed");
    } catch (reason) {
      const code = reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: string }).code : undefined;
      if (code === "POLICIES_CHANGED") {
        flash("Another admin changed the policies. Review them and save again.");
        void load();
      } else setFormError(reason instanceof Error ? reason.message : "Could not save the policies");
    } finally {
      setBusy(false);
    }
  }

  const moduleOptions = GRANT_MODULES.map((value) => ({ value, label: MODULE_LABELS[value] }));

  return <article className="team-detail team-policies" aria-labelledby="team-policies-title">
    <button type="button" className="team-back" onClick={requestBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-policies-title">Policies</h2>
        <p className="team-muted">Rules for every API key on this Nook, checked on each call. A key that breaks a rule stops working until it complies or the rule changes; nothing is revoked.{state?.updatedAt ? ` Last changed ${relativeTime(state.updatedAt)}${state.updatedBy ? ` by ${state.updatedBy.displayName}` : ""}.` : ""}</p>
      </div>
    </header>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load policies</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !draft && <p className="team-loading" role="status">Loading policies…</p>}
    {draft && <form className="policies-form" onSubmit={save}>
      <fieldset className="policies-section" disabled={busy}>
        <legend>Key lifetime</legend>
        <div className="policies-grid">
          <NumberField label="Longest lifetime (days, up to 365)" value={draft.keyMaxDays} min={1} max={365} onChange={(value) => set("keyMaxDays", value)} />
          <NumberField label="Default for new keys (days)" value={draft.keyDefaultDays} min={1} max={365} onChange={(value) => set("keyDefaultDays", value)} />
        </div>
        <label className="policies-switch"><span>Require an expiry on every key (older keys without one stop working)</span><input type="checkbox" checked={draft.keyRequireExpiry} onChange={onCheckedChange((checked) => set("keyRequireExpiry", checked))} /></label>
        <NumberField label="Live keys per person (up to 50)" value={draft.keysPerUser} min={1} max={50} onChange={(value) => set("keysPerUser", value)} />
      </fieldset>

      <fieldset className="policies-section" disabled={busy}>
        <legend>Where keys work</legend>
        <p>Guests never hold keys. REST arrives in a later release; the setting applies from then.</p>
        <div className="policies-grid">
          <div className="policies-role"><span>MCP</span>{KEY_ROLES.map((role) => <label key={role} className="policies-switch"><span>{ROLE_NAMES[role]}</span><input type="checkbox" checked={draft.mcpRoles.includes(role)} onChange={onCheckedChange((checked) => toggleRole("mcpRoles", role, checked))} /></label>)}</div>
          <div className="policies-role"><span>REST</span>{KEY_ROLES.map((role) => <label key={role} className="policies-switch"><span>{ROLE_NAMES[role]}</span><input type="checkbox" checked={draft.restRoles.includes(role)} onChange={onCheckedChange((checked) => toggleRole("restRoles", role, checked))} /></label>)}</div>
        </div>
      </fieldset>

      <fieldset className="policies-section" disabled={busy}>
        <legend>Modules keys may use</legend>
        <p>A key's permissions in other modules stay listed but grant nothing. Each role's own limits still apply (viewers only read).</p>
        {KEY_ROLES.map((role) => <div key={role} className="policies-role"><span>{ROLE_NAMES[role]}</span>
          <Combobox<GrantModule> multiple label={`Modules for ${ROLE_NAMES[role].toLowerCase()}' keys`} value={draft.keyModulesByRole[role]} options={moduleOptions} disabled={busy}
            onChange={(modules) => set("keyModulesByRole", { ...draft.keyModulesByRole, [role]: GRANT_MODULES.filter((module) => modules.includes(module)) })} placeholder="Add a module…" />
        </div>)}
      </fieldset>

      <fieldset className="policies-section" disabled={busy}>
        <legend>Sharing</legend>
        <p>Off: nobody can share with a guest, directly or through a group that includes one, and guests are left out of the people list. Existing shares with guests stay until they are removed.</p>
        <label className="policies-switch"><span>Allow sharing with guests</span><input type="checkbox" checked={draft.shareWithGuests} onChange={onCheckedChange((checked) => set("shareWithGuests", checked))} /></label>
      </fieldset>

      <p className={`policies-impact${impact && impact.blocked && !sharingOnly ? " warn" : ""}`} role="status" aria-live="polite">{invalid ?? sharingOnly ?? impactLine(impact, dirty)}</p>
      {formError && <p className="form-error" role="alert">{formError}</p>}
      <div className="policies-actions">
        <button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { if (state) setDraft(state.policies); }}>Discard changes</button>
        <button type="submit" className="primary-button" disabled={busy || !dirty || Boolean(invalid)}>{busy ? "Saving…" : "Save policies"}</button>
      </div>
    </form>}
    {leaving && <SheetConfirm title="Discard changes?" message="Your changes to the policies are not saved." confirmLabel="Discard" cancelLabel="Keep editing" danger
      onConfirm={() => { setLeaving(false); if (state) setDraft(state.policies); setDiscarded(true); }} onCancel={keepEditing} />}
  </article>;
}
