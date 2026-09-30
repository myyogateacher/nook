import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Share2, TriangleAlert, UsersRound, X } from "lucide-react";
import { ApiError } from "../api";
import { trapTabKey } from "../files/Dialog";
import { Select } from "../ui/Select";
import { Avatar } from "../ui/Avatar";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { useRole } from "../team/roleAccess";
import { ROLE_LABELS } from "../team/teamRoles";
import { getAccess, keysReachLine, listPeople, listPickerGroups, putAccess, type ItemAccess, type PickerGroup, type PickerPerson } from "./accessApi";
import {
  accessErrorMessage, addPicked, afterGuestRefusal, audienceLoss, audienceLossMessage, audienceOptions, draftFrom, groupBoost, groupSummary, guestRefusal, guestRefusalMessage, isDirty,
  KEPT_GUEST_NOTE, KEPT_GUEST_REASON, keptGuestLevel, levelOptions, levelsUpTo, lockedForYou, pickerOptions, roleCapHint, saveBlocker, toPutBody, type Draft
} from "./accessModel";
import { LEVEL_LABELS, type AccessKind, type Level } from "./accessLevels";
import { LevelSelect } from "./LevelSelect";
import { PrincipalPicker } from "./PrincipalPicker";
import { SheetConfirm } from "./SheetConfirm";
import "../files/files.css";
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

/** The confirm over the sheet: discarding unsaved changes (B4), or saving another audience that clears the list (B3). */
type Prompt = { kind: "discard" } | { kind: "audience"; message: string };

/**
 * The Access sheet (Wave 32, access plan §C.5, §E): one component for every shareable item, in
 * place of the five share panels. Who can open it (only me, people and groups I choose, everyone
 * signed in, or the folder's access), and each person and group with a level from the module's
 * list. A full-height sheet at 390 px and a side panel on desktop; 44 px targets; custom Select and
 * Combobox only (D91); Escape and (with `guardHistory`, or through the host) Back close it; Tab
 * stays inside; focus returns to the control that opened it. Saving sends the ETag it loaded, so a
 * change made meanwhile is never overwritten (409: the sheet shows the latest instead).
 *
 * With unsaved changes, Close, Escape, the scrim, and Back ask "Discard changes?" first; Back is
 * caught by a guard registered once the sheet is dirty, so it runs before the host's own (newest
 * first). Saving another audience over a list of people and groups asks first too, with the count.
 */
export function AccessSheet({ kind, id, title, onClose, onSaved, guardHistory = false, initial }: AccessSheetProps) {
  const [access, setAccess] = useState<ItemAccess | null>(initial?.access ?? null);
  const [draft, setDraft] = useState<Draft | null>(initial ? draftFrom(initial.access) : null);
  const [people, setPeople] = useState<PickerPerson[]>(initial?.people ?? []);
  const [groups, setGroups] = useState<PickerGroup[]>(initial?.groups ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The rows a GUEST_SHARE_DISABLED refusal named, marked until the next save.
  const [refused, setRefused] = useState<{ people: string[]; groups: string[] } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  // Viewers and guests have no people directory (403 ROLE_READ_ONLY): do not ask for it.
  const { readOnly: roleReadOnly } = useRole();
  // Focus goes back to whatever opened the sheet (the Share button), once it closes.
  const openerRef = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);

  const dirty = Boolean(access && draft && isDirty(draft, access));
  useHistoryDialogGuard(guardHistory, onClose, { blocked: busy });
  // Back with unsaved changes asks first (B4); this guard registers after the host's, so it is asked first.
  const askDiscard = useCallback(() => setPrompt({ kind: "discard" }), []);
  useHistoryDialogGuard(dirty && prompt === null, askDiscard, { blocked: busy });
  // Back on the prompt is Keep editing.
  const keepEditing = useCallback(() => setPrompt(null), []);
  useHistoryDialogGuard(prompt !== null, keepEditing, { blocked: busy });

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [loaded, directory, groupList] = await Promise.all([
        getAccess(kind, id),
        // Read-only roles have no directory (403): they can still withdraw a share.
        roleReadOnly ? Promise.resolve([] as PickerPerson[]) : listPeople().then((result) => result.users, () => [] as PickerPerson[]),
        listPickerGroups().then((result) => result.groups, () => [] as PickerGroup[])
      ]);
      setAccess(loaded);
      setDraft(draftFrom(loaded));
      setPeople(directory);
      setGroups(groupList);
    } catch (reason) {
      setLoadError(reason instanceof ApiError && reason.status === 404 ? "This item is gone or you can no longer open it." : reason instanceof Error ? reason.message : "Could not load who has access");
    }
  }, [id, kind, roleReadOnly]);
  useEffect(() => { if (!initial) void load(); }, [initial, load]);

  // F7: an admin may turn sharing with guests off (or on) while this sheet is open. The flag comes
  // with the small picker groups list, so it is read again when the sheet regains focus and as the
  // picker opens, never on a timer; guests are then no longer offered without reopening the sheet.
  const loaded = access !== null;
  const policyRequest = useRef(false);
  const refreshGuestPolicy = useCallback(() => {
    if (!loaded || policyRequest.current) return;
    policyRequest.current = true;
    listPickerGroups().then((result) => {
      setGroups(result.groups);
      const allowed = result.shareWithGuests;
      if (typeof allowed === "boolean") setAccess((current) => current && current.shareWithGuests !== allowed ? { ...current, shareWithGuests: allowed } : current);
    }, () => undefined).finally(() => { policyRequest.current = false; });
  }, [loaded]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshGuestPolicy(); };
    window.addEventListener("focus", refreshGuestPolicy);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refreshGuestPolicy);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshGuestPolicy]);

  useEffect(() => {
    closeRef.current?.focus();
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    if (dirty) setPrompt({ kind: "discard" });
    else onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && prompt === null) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, prompt]);

  function requestSave() {
    if (!access || !draft) return;
    const loss = audienceLoss(draft, access);
    if (loss) setPrompt({ kind: "audience", message: audienceLossMessage(loss, draft.audience) });
    else void save();
  }

  async function save() {
    if (!access || !draft) return;
    setPrompt(null);
    setBusy(true);
    setError(null);
    setRefused(null);
    try {
      const saved = await putAccess(kind, id, toPutBody(draft, access), access.etag);
      setBusy(false);
      onSaved(saved);
    } catch (reason) {
      setBusy(false);
      const code = errorCode(reason);
      const payload = reason instanceof ApiError ? reason.payload : null;
      const latest = code === "ACCESS_CHANGED" ? payload as { access?: ItemAccess } : null;
      if (latest?.access) {
        setAccess(latest.access);
        setDraft(draftFrom(latest.access));
      }
      const guests = code === "GUEST_SHARE_DISABLED" ? guestRefusal(payload) : null;
      if (guests) {
        // Point at the rows that caused it (B1): the server names them.
        setRefused(guests);
        // The refusal means sharing with guests is off now, even if it was on when the sheet opened:
        // mark every kept guest row and cap its levels at once, not only after reopening (C11b).
        setAccess((current) => current ? afterGuestRefusal(current) : current);
        const names = [...draft.groups.filter((group) => guests.groups.includes(group.id)).map((group) => group.name),
          ...draft.people.filter((person) => guests.people.includes(person.id)).map((person) => person.displayName)];
        setError(guestRefusalMessage(names));
      } else setError(accessErrorMessage(code, reason instanceof Error ? reason.message : "Could not save access"));
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
            <PrincipalPicker options={pickerOptions(draft, access, people, groups)} onPick={(value) => update((current) => addPicked(current, value, access, people, groups))} disabled={busy} onOpening={refreshGuestPolicy}
              emptyText={people.length || groups.length ? "Nobody else to add" : "No one to share with yet"} />
            {draft.groups.length === 0 && draft.people.length === 0 && <p className="access-empty">Nobody yet. Add people or groups above.</p>}
            <ul className="access-list">
              {draft.groups.map((group) => {
                const locked = lockedForYou(access, group.level);
                const kept = keptGuestLevel(access, { type: "group", id: group.id });
                const flagged = refused?.groups.includes(group.id) ?? false;
                return <li key={`g-${group.id}`} className={`access-row${flagged ? " refused" : ""}`}>
                  <span className="access-avatar group" aria-hidden="true"><UsersRound /></span>
                  <span className="access-row-copy">
                    <strong>{group.name}</strong>
                    <small>{groupSummary(group)}</small>
                    {kept
                      ? <small className="access-row-hint access-kept">{KEPT_GUEST_NOTE}</small>
                      : <small className="access-row-hint">Admins decide who is in this group{group.selfAddedCount ? ` · ${group.selfAddedCount === 1 ? "an admin" : `${group.selfAddedCount} admins`} added themselves` : ""}</small>}
                    {flagged && <small className="access-row-refused">Sharing with guests is off: remove this group{kept ? " or set its level back" : ""}.</small>}
                  </span>
                  <LevelSelect kind={kind} levels={kept ? levelsUpTo(access.levels, kept) : access.levels} value={group.level} label={`What ${group.name} can do`}
                    lockedReason={locked ? "Only the owner changes managers" : kept && levelsUpTo(access.levels, kept).length === 1 ? KEPT_GUEST_REASON : null}
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
                const kept = keptGuestLevel(access, { type: "person", id: person.id });
                const boost = groupBoost(person, draft.groups);
                const flagged = refused?.people.includes(person.id) ?? false;
                return <li key={`p-${person.id}`} className={`access-row${flagged ? " refused" : ""}`}>
                  <Avatar className="access-avatar" name={person.displayName} url={person.avatarUrl} />
                  <span className="access-row-copy">
                    <strong>{person.displayName}</strong>
                    <small>Team role: {ROLE_LABELS[person.teamRole]}{yours ? " · You" : ""}{person.blocked ? " · Blocked" : ""}</small>
                    {kept && <small className="access-row-hint access-kept">{KEPT_GUEST_NOTE}</small>}
                    {boost && <small className="access-row-hint access-boost">Also {LEVEL_LABELS[boost.level]} through {boost.group}; the higher level applies</small>}
                    {flagged && <small className="access-row-refused">Sharing with guests is off: remove this person{kept ? " or set their level back" : ""}.</small>}
                  </span>
                  <LevelSelect kind={kind} levels={kept ? levelsUpTo(access.levels, kept) : access.levels} value={person.level} label={`What ${person.displayName} can do`}
                    lockedReason={locked ? yours ? "Ask the owner to change your access" : "Only the owner changes managers" : cap ?? (kept && levelsUpTo(access.levels, kept).length === 1 ? KEPT_GUEST_REASON : null)}
                    onChange={(level) => update((current) => ({ ...current, people: current.people.map((item) => item.id === person.id ? { ...item, level } : item) }))} />
                  {!locked && <button type="button" className="icon-button access-remove" aria-label={`Remove ${person.displayName}`} disabled={busy}
                    onClick={() => update((current) => ({ ...current, people: current.people.filter((item) => item.id !== person.id) }))}><X /></button>}
                </li>;
              })}
            </ul>
            {!access.shareWithGuests && <p className="access-row-hint">Sharing with guests is turned off for this Nook. Guests already listed keep their access; they cannot be added or given more.</p>}
          </section>}
        </>}
      </div>

      <footer className="access-footer">
        {error && <p className="access-error" role="alert">{error}</p>}
        {!error && blocker && selected && <p className="access-row-hint">{blocker}</p>}
        {access && typeof access.keysWithAccess === "number" && access.keysWithAccess > 0 && <p className="access-row-hint access-keys-hint">{keysReachLine(access.keysWithAccess)}</p>}
        <div className="access-actions">
          <button type="button" className="secondary-button" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className="primary-button" onClick={requestSave} disabled={busy || !access || !draft || blocker !== null}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </footer>
    </aside>
    {prompt?.kind === "discard" && <SheetConfirm title="Discard changes?" message="Your changes to who has access are not saved." confirmLabel="Discard" cancelLabel="Keep editing" danger
      onConfirm={() => { setPrompt(null); onClose(); }} onCancel={keepEditing} />}
    {prompt?.kind === "audience" && <SheetConfirm title="Remove individual access?" message={prompt.message} confirmLabel="Save" cancelLabel="Keep editing" danger
      onConfirm={() => { void save(); }} onCancel={keepEditing} />}
  </>;
}
