import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Share2, TriangleAlert, UsersRound, X } from "lucide-react";
import { ApiError } from "../api";
import { trapTabKey } from "../files/Dialog";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { ROLE_LABELS } from "../team/teamRoles";
import { getAccess, keysReachLine, listPeople, listPickerGroups, putAccess, type ItemAccess, type PickerGroup, type PickerPerson } from "./accessApi";
import { accessErrorMessage, addPicked, audienceOptions, draftFrom, groupSummary, levelOptions, lockedForYou, pickerOptions, roleCapHint, saveBlocker, toPutBody, type Draft } from "./accessModel";
import { LEVEL_LABELS, type AccessKind, type Level } from "./accessLevels";
import { LevelSelect } from "./LevelSelect";
import { PrincipalPicker } from "./PrincipalPicker";
import "./access.css";

export type AccessSheetProps = {
  kind: AccessKind;
  id: string;
  /** The item's name, the sheet's heading. */
  title: string;
  onClose: () => void;
  /** After a save; the host refreshes and says so. */
  onSaved: (access: ItemAccess) => void;
  /**
   * Register the sheet's own Back/Forward guard (Notes). Hosts that already close their dialogs on
   * Back (Files, Tasks, Collections, Calendar) leave it off, so one Back closes one layer (D69).
   */
  guardHistory?: boolean;
  /** Render tests: the loaded state, without fetching. */
  initial?: { access: ItemAccess; people?: PickerPerson[]; groups?: PickerGroup[] };
};

const errorCode = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? (reason.payload as { code?: unknown }).code : undefined;

/**
 * The Access sheet (Wave 32, access plan §C.5, §E): one component for every shareable item, in
 * place of the five share panels. Who can open it (only me, people and groups I choose, everyone
 * signed in, or the folder's access), and each person and group with a level from the module's
 * list. A full-height sheet at 390 px and a side panel on desktop; 44 px targets; custom Select and
 * Combobox only (D91); Escape and (with `guardHistory`, or through the host) Back close it; Tab
 * stays inside; focus returns to the control that opened it. Saving sends the ETag it loaded, so a
 * change made meanwhile is never overwritten (409: the sheet shows the latest instead).
 */
export function AccessSheet({ kind, id, title, onClose, onSaved, guardHistory = false, initial }: AccessSheetProps) {
  const [access, setAccess] = useState<ItemAccess | null>(initial?.access ?? null);
  const [draft, setDraft] = useState<Draft | null>(initial ? draftFrom(initial.access) : null);
  const [people, setPeople] = useState<PickerPerson[]>(initial?.people ?? []);
  const [groups, setGroups] = useState<PickerGroup[]>(initial?.groups ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Focus goes back to whatever opened the sheet (the Share button), once it closes.
  const openerRef = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);

  useHistoryDialogGuard(guardHistory, onClose, { blocked: busy });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [loaded, directory, groupList] = await Promise.all([
        getAccess(kind, id),
        // Read-only roles have no directory (403): they can still withdraw a share.
        listPeople().then((result) => result.users, () => [] as PickerPerson[]),
        listPickerGroups().then((result) => result.groups, () => [] as PickerGroup[])
      ]);
      setAccess(loaded);
      setDraft(draftFrom(loaded));
      setPeople(directory);
      setGroups(groupList);
    } catch (reason) {
      setLoadError(reason instanceof ApiError && reason.status === 404 ? "This item is gone or you can no longer open it." : reason instanceof Error ? reason.message : "Could not load who has access");
    }
  }, [id, kind]);
  useEffect(() => { if (!initial) void load(); }, [initial, load]);

  useEffect(() => {
    closeRef.current?.focus();
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const close = () => { if (!busy) onClose(); };

  async function save() {
    if (!access || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await putAccess(kind, id, toPutBody(draft, access), access.etag);
      setBusy(false);
      onSaved(saved);
    } catch (reason) {
      setBusy(false);
      const code = errorCode(reason);
      const latest = code === "ACCESS_CHANGED" ? (reason as ApiError).payload as { access?: ItemAccess } : null;
      if (latest?.access) {
        setAccess(latest.access);
        setDraft(draftFrom(latest.access));
      }
      setError(accessErrorMessage(code, reason instanceof Error ? reason.message : "Could not save access"));
    }
  }

  const update = (change: (current: Draft) => Draft) => setDraft((current) => current ? change(current) : current);
  const owner = access?.yourLevel === "owner";
  const blocker = draft ? saveBlocker(draft) : null;
  const selected = draft?.audience === "selected";

  return <>
    <div className="access-scrim" onClick={close} aria-hidden="true" />
    <aside className="access-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header className="access-header">
        <div><span className="eyebrow">Access</span><h2 id={titleId} title={title}>{title}</h2></div>
        <button ref={closeRef} type="button" className="icon-button access-close" onClick={close} aria-label="Close access" disabled={busy}><X /></button>
      </header>

      <div className="access-body">
        {loadError && <div className="access-state" role="alert"><TriangleAlert aria-hidden="true" /><p>{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => { void load(); }}>Try again</button></div>}
        {!loadError && (!access || !draft) && <p className="access-loading" role="status">Loading who has access…</p>}
        {access && draft && <>
          {owner ? <fieldset className="access-audience">
            <legend>Who can open this</legend>
            {audienceOptions(access).map((option) => <div key={option.value} className="access-audience-row">
              <label className="access-radio">
                <input type="radio" name={`${titleId}-audience`} value={option.value} checked={draft.audience === option.value}
                  onChange={() => update((current) => ({ ...current, audience: option.value }))} />
                <span><strong>{option.label}</strong><small>{option.hint}</small></span>
              </label>
              {option.value === "all_users" && access.audienceLevels && draft.audienceLevel && draft.audience === "all_users" && <Select<Level> className="access-level-select"
                value={draft.audienceLevel} options={levelOptions(kind, access.audienceLevels)} label="What everyone signed in can do" searchable={false}
                onChange={(level) => update((current) => ({ ...current, audienceLevel: level }))} />}
            </div>)}
          </fieldset> : <p className="access-note" role="note"><Share2 aria-hidden="true" />You manage this item: you can add and change people and groups up to {LEVEL_LABELS.edit}. Only {access.owner.displayName} changes managers or who can open it.</p>}

          {selected && <section className="access-principals" aria-label="People and groups">
            <PrincipalPicker options={pickerOptions(draft, access, people, groups)} onPick={(value) => update((current) => addPicked(current, value, access, people, groups))} disabled={busy}
              emptyText={people.length || groups.length ? "Nobody else to add" : "No one to share with yet"} />
            {draft.groups.length === 0 && draft.people.length === 0 && <p className="access-empty">Nobody yet. Add people or groups above.</p>}
            <ul className="access-list">
              {draft.groups.map((group) => {
                const locked = lockedForYou(access, group.level);
                return <li key={`g-${group.id}`} className="access-row">
                  <span className="access-avatar group" aria-hidden="true"><UsersRound /></span>
                  <span className="access-row-copy">
                    <strong>{group.name}</strong>
                    <small>{groupSummary(group)}</small>
                    <small className="access-row-hint">Admins decide who is in this group{group.selfAddedCount ? ` · ${group.selfAddedCount === 1 ? "an admin" : `${group.selfAddedCount} admins`} added themselves` : ""}</small>
                  </span>
                  <LevelSelect kind={kind} levels={access.levels} value={group.level} label={`What ${group.name} can do`} lockedReason={locked ? "Only the owner changes managers" : null}
                    onChange={(level) => update((current) => ({ ...current, groups: current.groups.map((item) => item.id === group.id ? { ...item, level } : item) }))} />
                  {!locked && <button type="button" className="icon-button access-remove" aria-label={`Remove ${group.name}`} disabled={busy}
                    onClick={() => update((current) => ({ ...current, groups: current.groups.filter((item) => item.id !== group.id) }))}><X /></button>}
                </li>;
              })}
              {draft.people.map((person) => {
                const locked = lockedForYou(access, person.level);
                // A manager cannot lower or remove their own manage row (403 MANAGER_CAP): say who can.
                const yours = person.id === access.youId;
                const cap = roleCapHint(person.teamRole);
                return <li key={`p-${person.id}`} className="access-row">
                  <span className="access-avatar" aria-hidden="true">{person.displayName.trim().charAt(0).toUpperCase() || "?"}</span>
                  <span className="access-row-copy">
                    <strong>{person.displayName}</strong>
                    <small>Team role: {ROLE_LABELS[person.teamRole]}{yours ? " · You" : ""}{person.blocked ? " · Blocked" : ""}</small>
                  </span>
                  <LevelSelect kind={kind} levels={access.levels} value={person.level} label={`What ${person.displayName} can do`}
                    lockedReason={locked ? yours ? "Ask the owner to change your access" : "Only the owner changes managers" : cap}
                    onChange={(level) => update((current) => ({ ...current, people: current.people.map((item) => item.id === person.id ? { ...item, level } : item) }))} />
                  {!locked && <button type="button" className="icon-button access-remove" aria-label={`Remove ${person.displayName}`} disabled={busy}
                    onClick={() => update((current) => ({ ...current, people: current.people.filter((item) => item.id !== person.id) }))}><X /></button>}
                </li>;
              })}
            </ul>
            {!access.shareWithGuests && <p className="access-row-hint">Sharing with guests is turned off for this Nook.</p>}
          </section>}
        </>}
      </div>

      <footer className="access-footer">
        {error && <p className="access-error" role="alert">{error}</p>}
        {!error && blocker && selected && <p className="access-row-hint">{blocker}</p>}
        {access && typeof access.keysWithAccess === "number" && access.keysWithAccess > 0 && <p className="access-row-hint access-keys-hint">{keysReachLine(access.keysWithAccess)}</p>}
        <div className="access-actions">
          <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className="primary-button" onClick={() => { void save(); }} disabled={busy || !access || !draft || blocker !== null}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </footer>
    </aside>
  </>;
}
