import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, RotateCcw, TriangleAlert, UsersRound } from "lucide-react";
import { KeysDialog } from "../keys/KeysDialog";
import { collectProblems, FieldError, useFieldErrors } from "../auth/fieldChecks";
import { createGroup, guestCountLabel, listGroups, memberCountLabel, type GroupSummary } from "./groupsApi";
import "../keys/keys.css";
import { hubDocumentTitle } from "../router";

/**
 * Team → Groups at /team/groups (Wave 32, access plan §C.6, D267), admins only: every group with
 * its size, and New group. Owners share items with a group from their Access sheet; admins decide
 * who is in it, so a group never grants content by itself (D73).
 */
export function TeamGroups({ onBack, onOpenGroup, flash }: { onBack: () => void; onOpenGroup: (groupId: string) => void; flash: (message: string) => void }) {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listGroups();
      if (current === generation.current) setGroups(result.groups);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load groups");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = hubDocumentTitle("Groups"); }, []);

  return <article className="team-detail team-groups" aria-labelledby="team-groups-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-groups-title">Groups</h2>
        <p className="team-muted">People who work together. Owners share a board, note, or calendar with a group; you decide who is in it. A group never opens anything by itself.</p>
      </div>
      <button type="button" className="primary-button team-groups-new" onClick={() => setCreating(true)} aria-haspopup="dialog"><Plus />New group</button>
    </header>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load groups</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !groups && <p className="team-loading" role="status">Loading groups…</p>}
    {!error && groups && groups.length === 0 && <div className="team-state">
      <span className="team-state-icon"><UsersRound /></span>
      <h2>No groups yet.</h2>
      <p>Create one, add people, and owners can share with everyone in it at once.</p>
    </div>}
    {!error && groups && groups.length > 0 && <ul className="team-list" aria-label="Groups">
      {groups.map((group) => <li key={group.id}>
        <button type="button" className="team-row team-group-row" onClick={() => onOpenGroup(group.id)}>
          <span className="team-avatar" aria-hidden="true"><UsersRound /></span>
          <span className="team-row-copy">
            <span className="team-row-title"><strong>{group.name}</strong></span>
            <span className="team-row-meta"><span>{memberCountLabel(group.memberCount)}{guestCountLabel(group.guestCount)}</span><span>Shared {group.grantCount} {group.grantCount === 1 ? "item" : "items"}</span></span>
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
      </li>)}
    </ul>}
    {creating && <GroupFormDialog title="New group" submitLabel="Create group" onClose={() => setCreating(false)} onSubmit={async (value) => {
      const { group } = await createGroup(value);
      setCreating(false);
      flash(`${group.name} was created`);
      onOpenGroup(group.id);
    }} />}
  </article>;
}

/** Name and description (create and edit). Server errors (a taken name) show inline. */
export function GroupFormDialog({ title, submitLabel, initial, onClose, onSubmit }: {
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string | null };
  onClose: () => void;
  onSubmit: (value: { name: string; description: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = useFieldErrors();
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The app's own check under the field (noValidate: no browser bubble).
    if (fields.show(event.currentTarget, collectProblems({ name: name.trim() ? null : "Give the group a name." }))) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name: name.trim(), description: description.trim() || null });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the group");
      setBusy(false);
    }
  }
  return <KeysDialog title={title} onClose={onClose} busy={busy}>
    <form className="keys-form" onSubmit={submit} noValidate>
      <label className="keys-input">Name<input name="name" value={name} onChange={(event) => { setName(event.target.value); fields.clear("name"); }} maxLength={60} autoFocus disabled={busy}
        aria-invalid={fields.errors.name ? true : undefined} aria-describedby={fields.errors.name ? "group-name-error" : undefined} />
        <FieldError id="group-name-error" message={fields.errors.name} /></label>
      <label className="keys-input">Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} rows={2} disabled={busy} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : submitLabel}</button>
      </div>
    </form>
  </KeysDialog>;
}
