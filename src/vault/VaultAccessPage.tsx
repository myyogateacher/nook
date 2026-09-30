import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronLeft, History, RotateCcw, ShieldAlert, UsersRound, X } from "lucide-react";
import { PHONE_QUERY, useMediaQuery } from "../calendar/hooks";
import { listPeople, listPickerGroups, type PickerGroup, type PickerPerson } from "../access/accessApi";
import { PrincipalPicker } from "../access/PrincipalPicker";
import { whenHistorySettled, type PopDirection } from "../historyDialogs";
import { Avatar } from "../ui/Avatar";
import { Select, type Option } from "../ui/Select";
import type { ConfirmRequest } from "../ui/useConfirm";
import { repeatDelta, useLeaveGuard } from "../ui/useLeaveGuard";
import { ROLE_LABELS, isRole } from "../team/teamRoles";
import type { EnvLevel } from "../../shared/vault";
import { errorCode, messageOf } from "./VaultDialogs";
import { getVaultAccess, putVaultAccess, type AccessPutBody, type SheetEnvironment, type SheetGroup, type SheetPerson, type VaultAccessSheet } from "./vaultApi";

/**
 * Who has access to one vault, at /vault/:id/access (vault plan §10 Access; D214–D216, V-O3; Wave 26).
 * People × environments: on desktop a grid (the first column holds the vault role, each cell a
 * custom Select of No access, Read, Write, Admin); at 390 px one card per person with a Select per
 * environment. Groups follow the same shape. Owners change everything; environment admins change
 * read and write on their environments only (the rest is shown but locked, with the reason). Guests
 * and integrations are never offered (V-O3; integrations wait for vault keys), and viewers can only
 * read. Saving is one request with the ETag; someone else's change meanwhile shows the latest.
 * Removing someone says to rotate the real credentials upstream (§6.6) and links their reads.
 * Unsaved changes ask before Back or Forward leaves (the leave guard).
 */

export const ENV_LEVEL_LABELS: Record<EnvLevel, string> = { none: "No access", read: "Read", write: "Write", admin: "Admin" };
const LEVEL_DESCRIPTIONS: Record<EnvLevel, string> = { none: "Cannot see this environment", read: "See and copy values", write: "Also set, clear, and import values", admin: "Also rename and delete it, and give read or write" };

type Draft = { people: SheetPerson[]; groups: SheetGroup[] };

const draftOf = (sheet: VaultAccessSheet): Draft => ({ people: sheet.people.map((person) => ({ ...person, levels: { ...person.levels } })), groups: sheet.groups.map((group) => ({ ...group, levels: { ...group.levels } })) });
const bodyOf = (draft: Draft): AccessPutBody => ({
  people: draft.people.map((person) => ({ id: person.id, role: person.role, levels: person.role === "owner" ? {} : person.levels })),
  groups: draft.groups.map((group) => ({ id: group.id, levels: group.levels }))
});
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(bodyOf(a)) === JSON.stringify(bodyOf(b));

/** The levels one cell offers, and why others are off. */
export function levelOptions(options: { cap: EnvLevel; ownerOnly: boolean; current: EnvLevel }): Option<EnvLevel>[] {
  return (["none", "read", "write", "admin"] as const).map((level) => {
    const overCap = options.cap === "read" ? level === "write" || level === "admin" : options.cap === "none" ? level !== "none" : false;
    const adminLocked = options.ownerOnly && level === "admin" && options.current !== "admin";
    return {
      value: level, label: ENV_LEVEL_LABELS[level],
      description: overCap ? (options.cap === "read" ? "Viewers can only read" : "Their Team role reaches no vaults") : adminLocked ? "Only owners give admin" : LEVEL_DESCRIPTIONS[level],
      disabled: (overCap || adminLocked) && level !== options.current
    };
  });
}

export function VaultAccessPage({ vaultId, onBack, onReady, flash, ask, onOpenActivity, onMissing }: {
  vaultId: string; onBack: () => void; onReady: () => void; flash: (message: string) => void;
  ask: (request: ConfirmRequest) => Promise<boolean>; onOpenActivity: (actorId: string | null) => void; onMissing: () => void;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [sheet, setSheet] = useState<VaultAccessSheet | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const loaded = await getVaultAccess(vaultId);
      setSheet(loaded);
      setDraft(draftOf(loaded));
      if (loaded.canManagePeople) {
        const [directory, groupList] = await Promise.all([
          listPeople().then((result) => result.users, () => [] as PickerPerson[]),
          listPickerGroups().then((result) => result.groups, () => [] as PickerGroup[])
        ]);
        setPeople(directory);
        setGroups(groupList);
      }
    } catch (reason) {
      if (errorCode(reason) === "NOT_FOUND") onMissing();
      else setError(errorCode(reason) === "VAULT_LEVEL" ? "Only the vault's owners and environment admins manage who has access." : messageOf(reason, "Could not load who has access"));
    }
  }, [onMissing, vaultId]);
  useEffect(() => { void load(); }, [load]);
  const ready = sheet !== null || error !== null;
  useLayoutEffect(() => { if (ready) onReady(); }, [ready, onReady]);
  useEffect(() => { if (sheet) document.title = `Access · ${sheet.vault.name} · Vault · Nook`; }, [sheet]);

  const dirty = Boolean(sheet && draft && !sameDraft(draft, draftOf(sheet)));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [allowLeave, setAllowLeave] = useState(false);
  const repeatMove = useRef<PopDirection | null>(null);
  const discard = useMemo<ConfirmRequest>(() => ({ title: "Discard changes?", message: "The changes to who has access are not saved.", confirmLabel: "Discard", danger: true }), []);
  useLeaveGuard(dirty && !allowLeave, (direction) => {
    void ask(discard).then((confirmed) => {
      if (!confirmed) return;
      repeatMove.current = direction;
      setAllowLeave(true);
    });
  });
  useEffect(() => {
    const direction = repeatMove.current;
    if (!allowLeave || !direction) return undefined;
    repeatMove.current = null;
    let cancel = () => undefined as void;
    const timer = setTimeout(() => { cancel = whenHistorySettled(() => window.history.go(repeatDelta(direction))); }, 0);
    return () => { clearTimeout(timer); cancel(); };
  }, [allowLeave]);
  const back = async () => {
    if (!dirtyRef.current) return onBack();
    if (!await ask(discard)) return;
    // Let the leave guard (and its sentinel) go first, then step back.
    setAllowLeave(true);
    setTimeout(() => whenHistorySettled(onBack), 0);
  };

  if (error) return <div className="vault-state" role="alert"><h1>Could not open who has access</h1><p>{error}</p><button className="secondary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button><button className="secondary-button" onClick={onBack}>Back to the vault</button></div>;
  if (!sheet || !draft) return <p className="vault-loading" role="status">Loading…</p>;

  const envs = sheet.environments;
  const owner = sheet.canManagePeople;
  const listedIds = new Set(draft.people.map((person) => person.id));
  const listedGroups = new Set(draft.groups.map((group) => group.id));
  // V-O3: guests are never offered; integrations wait for vault keys (Wave 27); blocked accounts cannot be added.
  const pickerOptions: Option[] = owner ? [
    ...groups.filter((group) => !listedGroups.has(group.id)).map((group) => ({ value: `group:${group.id}`, label: group.name, description: `${group.memberCount} ${group.memberCount === 1 ? "member" : "members"}${group.guestCount ? ` · includes ${group.guestCount} ${group.guestCount === 1 ? "guest" : "guests"} (they get no access)` : ""}`, group: "Groups", icon: <UsersRound /> })),
    ...people.filter((person) => !listedIds.has(person.id) && person.kind !== "service" && person.role !== "guest").map((person) => ({ value: `person:${person.id}`, label: person.displayName, description: person.role && isRole(person.role) ? ROLE_LABELS[person.role] + (person.role === "viewer" ? " · read only" : "") : undefined, group: "People" }))
  ] : [];

  const setPerson = (id: string, change: (person: SheetPerson) => SheetPerson) => setDraft((current) => current ? { ...current, people: current.people.map((person) => person.id === id ? change(person) : person) } : current);
  const setGroup = (id: string, change: (group: SheetGroup) => SheetGroup) => setDraft((current) => current ? { ...current, groups: current.groups.map((group) => group.id === id ? change(group) : group) } : current);
  const noneLevels = () => Object.fromEntries(envs.map((env) => [env.id, "none" as EnvLevel]));

  function pick(value: string) {
    setSaveError(null);
    if (value.startsWith("group:")) {
      const group = groups.find((item) => item.id === value.slice(6));
      if (group) setDraft((current) => current ? { ...current, groups: [...current.groups, { id: group.id, name: group.name, memberCount: group.memberCount, guestCount: group.guestCount, levels: { ...noneLevels(), [envs[0]!.id]: "read" } }] } : current);
      return;
    }
    const person = people.find((item) => item.id === value.slice(7));
    if (!person) return;
    const cap: EnvLevel = person.role === "viewer" ? "read" : "admin";
    setDraft((current) => current ? { ...current, people: [...current.people, {
      id: person.id, displayName: person.displayName, teamRole: person.role ?? "member", kind: person.kind ?? "person", blocked: false, avatarUrl: person.avatarUrl ?? null, isYou: false,
      role: "member", levels: { ...noneLevels(), [envs.find((env) => !env.protected)?.id ?? envs[0]!.id]: "read" }, cap, groupIds: []
    }] } : current);
  }

  async function save() {
    if (!sheet || !draft) return;
    setBusy(true);
    setSaveError(null);
    try {
      const removed = sheet.people.filter((person) => !draft.people.some((item) => item.id === person.id));
      const result = await putVaultAccess(vaultId, bodyOf(draft), sheet.etag);
      setSheet(result.access);
      setDraft(draftOf(result.access));
      setBusy(false);
      flash("Saved who has access");
      if (result.lostAccess > 0) {
        const single = removed.length === 1 ? removed[0]! : null;
        const open = await ask({
          title: "Rotate the real credentials too",
          message: `${single ? `${single.displayName} may` : "People who lost access may"} have copied values they could read. The vault's data key is being rotated, which protects backups, but it cannot take back what someone saw: rotate those credentials where they are issued (database passwords, API tokens). Activity lists what ${single ? "they" : "each person"} read.`,
          confirmLabel: single ? `Show what ${single.displayName} read` : "Open Activity"
        });
        if (open) onOpenActivity(single?.id ?? null);
      }
    } catch (reason) {
      setBusy(false);
      const code = errorCode(reason);
      const payload = (reason as { payload?: { access?: VaultAccessSheet } }).payload;
      if (code === "ACCESS_CHANGED" && payload?.access) {
        setSheet(payload.access);
        setDraft(draftOf(payload.access));
        setSaveError("Someone else changed who has access. This shows the latest now; make your change again.");
        return;
      }
      setSaveError(code === "ROLE_CAP" ? "A viewer can only read, and cannot own a vault." : code === "GUEST_NOT_ALLOWED" ? "Guests cannot be vault members." : code === "INTEGRATION_NOT_ALLOWED" ? "Integrations cannot be vault members yet." : code === "LAST_OWNER" ? "A vault keeps at least one owner." : messageOf(reason, "Could not save"));
    }
  }

  // Owners change any cell; an environment admin only members' read and write there (not their own row).
  const personEditable = (env: SheetEnvironment, person: SheetPerson) => env.manageable && (owner || (!person.isYou && person.role !== "owner" && person.levels[env.id] !== "admin"));
  const groupEditable = (env: SheetEnvironment) => owner && env.manageable;
  const cellSelect = (label: string, current: EnvLevel, cap: EnvLevel, onChange: (level: EnvLevel) => void, canEdit: boolean) =>
    <Select<EnvLevel> label={label} value={current} onChange={onChange} disabled={busy || !canEdit} variant="chip"
      options={levelOptions({ cap, ownerOnly: !owner, current })} />;

  const roleSelect = (person: SheetPerson) => owner
    ? <Select<"owner" | "member"> label={`Vault role of ${person.displayName}`} value={person.role} variant="chip" disabled={busy}
      onChange={(role) => setPerson(person.id, (item) => ({ ...item, role, levels: role === "owner" ? Object.fromEntries(envs.map((env) => [env.id, "admin" as EnvLevel])) : noneLevels() }))}
      options={[{ value: "owner", label: "Owner", description: person.cap !== "admin" ? "Viewers cannot own a vault" : "Everything, on every environment", disabled: person.cap !== "admin" && person.role !== "owner" }, { value: "member", label: "Member", description: "What each environment allows" }]} />
    : <span className="vault-access-role">{person.role === "owner" ? "Owner" : "Member"}</span>;

  const removeButton = (label: string, onRemove: () => void) => owner
    ? <button type="button" className="icon-button vault-access-remove" aria-label={label} title={label} disabled={busy} onClick={onRemove}><X /></button> : null;

  const personName = (person: SheetPerson) => <span className="vault-access-person">
    <Avatar className="vault-access-avatar" name={person.displayName} url={person.avatarUrl} integration={person.kind === "service"} />
    <span className="vault-access-name"><strong>{person.displayName}{person.isYou ? " (you)" : ""}</strong>
      <small>{isRole(person.teamRole) ? ROLE_LABELS[person.teamRole] : person.teamRole}{person.cap === "read" ? " · read only" : person.cap === "none" ? " · no vault access" : ""}{person.blocked ? " · blocked" : ""}{person.groupIds.length ? " · also through a group" : ""}</small></span>
  </span>;

  return <>
    <div className="vault-toolbar">
      <button type="button" className="icon-button vault-back" onClick={() => { void back(); }} aria-label={`Back to ${sheet.vault.name}`} title={`Back to ${sheet.vault.name}`}><ChevronLeft /></button>
      <h1 className="vault-title" title={sheet.vault.name}>Access<span className="vault-count"> · {sheet.vault.name}</span></h1>
    </div>
    <p className="vault-honest"><ShieldAlert aria-hidden="true" />{owner
      ? "Owners hold every environment. Members get a level per environment; viewers can only read, and guests and integrations never get vault access."
      : "You administer some environments: you can give existing members read or write there. Owners manage everything else."}</p>
    {owner && <PrincipalPicker options={pickerOptions} onPick={pick} disabled={busy || draft.people.length >= sheet.maxPeople} emptyText="Nobody else to add" />}

    {!phone && <div className="vault-grid-scroll vault-access-grid" role="region" aria-label="People and groups by environment" tabIndex={0}>
      <table className="vault-grid">
        <thead><tr><th scope="col" className="vault-grid-name">Person or group</th><th scope="col">Vault role</th>{envs.map((env) => <th key={env.id} scope="col"><span>{env.name}</span><small>{env.slug}{env.protected ? " · protected" : ""}</small></th>)}<th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>
          {draft.people.map((person) => <tr key={person.id}>
            <th scope="row" className="vault-grid-name">{personName(person)}</th>
            <td>{roleSelect(person)}</td>
            {envs.map((env) => <td key={env.id}>{person.role === "owner" ? <span className="vault-access-owner">Admin (owner)</span>
              : cellSelect(`${person.displayName} in ${env.name}`, person.levels[env.id] ?? "none", person.cap, (level) => setPerson(person.id, (item) => ({ ...item, levels: { ...item.levels, [env.id]: level } })), personEditable(env, person))}</td>)}
            <td>{!person.isYou && removeButton(`Remove ${person.displayName}`, () => setDraft((current) => current ? { ...current, people: current.people.filter((item) => item.id !== person.id) } : current))}</td>
          </tr>)}
          {draft.groups.map((group) => <tr key={group.id}>
            <th scope="row" className="vault-grid-name"><span className="vault-access-person"><span className="vault-access-avatar group"><UsersRound aria-hidden="true" /></span><span className="vault-access-name"><strong>{group.name}</strong><small>Group · {group.memberCount} {group.memberCount === 1 ? "member" : "members"}{group.guestCount ? ` · ${group.guestCount} guests get nothing` : ""}</small></span></span></th>
            <td><span className="vault-access-role">Members</span></td>
            {envs.map((env) => <td key={env.id}>{cellSelect(`${group.name} in ${env.name}`, group.levels[env.id] ?? "none", "admin", (level) => setGroup(group.id, (item) => ({ ...item, levels: { ...item.levels, [env.id]: level } })), groupEditable(env))}</td>)}
            <td>{removeButton(`Remove ${group.name}`, () => setDraft((current) => current ? { ...current, groups: current.groups.filter((item) => item.id !== group.id) } : current))}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {phone && <ul className="vault-access-cards" aria-label="People and groups">
      {draft.people.map((person) => <li key={person.id} className="vault-env-card">
        <header>{personName(person)}{!person.isYou && removeButton(`Remove ${person.displayName}`, () => setDraft((current) => current ? { ...current, people: current.people.filter((item) => item.id !== person.id) } : current))}</header>
        <div className="vault-access-card-row"><span>Vault role</span>{roleSelect(person)}</div>
        {person.role !== "owner" && envs.map((env) => <div key={env.id} className="vault-access-card-row"><span>{env.name}{env.protected ? " · protected" : ""}</span>
          {cellSelect(`${person.displayName} in ${env.name}`, person.levels[env.id] ?? "none", person.cap, (level) => setPerson(person.id, (item) => ({ ...item, levels: { ...item.levels, [env.id]: level } })), personEditable(env, person))}</div>)}
        {person.role === "owner" && <p className="vault-card-meta">Admin on every environment.</p>}
      </li>)}
      {draft.groups.map((group) => <li key={group.id} className="vault-env-card">
        <header><span className="vault-access-person"><span className="vault-access-avatar group"><UsersRound aria-hidden="true" /></span><span className="vault-access-name"><strong>{group.name}</strong><small>Group · {group.memberCount} {group.memberCount === 1 ? "member" : "members"}</small></span></span>
          {removeButton(`Remove ${group.name}`, () => setDraft((current) => current ? { ...current, groups: current.groups.filter((item) => item.id !== group.id) } : current))}</header>
        {envs.map((env) => <div key={env.id} className="vault-access-card-row"><span>{env.name}</span>
          {cellSelect(`${group.name} in ${env.name}`, group.levels[env.id] ?? "none", "admin", (level) => setGroup(group.id, (item) => ({ ...item, levels: { ...item.levels, [env.id]: level } })), groupEditable(env))}</div>)}
      </li>)}
    </ul>}

    {people.some((person) => person.kind === "service") && owner && <p className="file-dialog-hint vault-access-note"><Bot className="vault-hint-icon" aria-hidden="true" />Integrations cannot be vault members; vault keys for machines arrive later.</p>}
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    <div className="vault-access-actions">
      {dirty && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft(draftOf(sheet)); setSaveError(null); }}>Discard changes</button>}
      <button type="button" className="secondary-button" onClick={() => onOpenActivity(null)}><History />Activity</button>
      <button type="button" className="primary-button vault-primary" disabled={busy || !dirty} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save"}</button>
    </div>
  </>;
}
