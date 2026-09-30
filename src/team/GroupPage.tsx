import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, EyeOff, Pencil, RotateCcw, Trash2, TriangleAlert, UserMinus, UsersRound } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { KeysDialog } from "../keys/KeysDialog";
import { Combobox } from "../ui/Combobox";
import type { Option } from "../ui/Select";
import { GroupFormDialog } from "./TeamGroups";
import { deleteGroup, deleteGroupMessage, getGroup, groupEventLabel, guestCountLabel, KIND_LABELS, LEVEL_LABELS, memberCountLabel, patchGroup, putGroupMembers, type GroupDetail } from "./groupsApi";
import { ROLE_LABELS, type Role } from "./teamRoles";

type TeamPerson = { id: string; displayName: string; role: Role; status: "active" | "blocked"; isYou: boolean };

const staleMessage = "Someone else changed this group. It now shows the latest.";
const isStale = (reason: unknown) => reason instanceof ApiError && reason.status === 409 && (reason.payload as { code?: unknown } | null)?.code === "GROUP_CHANGED";
const isGuestRefusal = (reason: unknown) => reason instanceof ApiError && reason.status === 400 && (reason.payload as { code?: unknown } | null)?.code === "GUEST_SHARE_DISABLED";
const guestRefusedMessage = "Sharing with guests is turned off, and this group has items shared with it, so guests cannot be added.";

/**
 * Active people not yet in the group, for the member picker. With `guestAddRefused` (T213) guests
 * stay listed but disabled, with the reason, rather than failing after they are picked.
 */
export function groupCandidates(group: Pick<GroupDetail, "members" | "guestAddRefused">, people: readonly TeamPerson[]): Option[] {
  const inGroup = new Set(group.members.map((member) => member.id));
  return people.filter((person) => person.status === "active" && !inGroup.has(person.id)).map((person) => {
    const refused = group.guestAddRefused && person.role === "guest";
    return { value: person.id, label: person.displayName, disabled: refused, description: `${ROLE_LABELS[person.role]}${person.isYou ? " · You" : ""}${refused ? " · Sharing with guests is off" : ""}` };
  });
}

/**
 * One group at /team/groups/:groupId (Wave 32, access plan §C.6, §E): members (add with a
 * type-to-search Combobox, remove per row), the items shared with it (titles hidden when you cannot
 * open the item, D269), and its history. An admin adding themselves is allowed and flagged (O-A1).
 */
export function GroupPage({ groupId, members, onBack, onDeleted, flash }: {
  groupId: string;
  members: readonly TeamPerson[];
  onBack: () => void;
  onDeleted: () => void;
  flash: (message: string) => void;
}) {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await getGroup(groupId);
      if (current === generation.current) setGroup(result.group);
    } catch (reason) {
      if (current !== generation.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        flash("Group not found");
        onDeleted();
        return;
      }
      setError(reason instanceof Error ? reason.message : "Could not load the group");
    }
  }, [flash, groupId, onDeleted]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (group) document.title = `${group.name} · Groups · Nook`; }, [group]);

  async function saveMembers(userIds: string[], message: string) {
    if (!group) return;
    setBusy(true);
    try {
      const result = await putGroupMembers(group.id, { userIds, revision: group.revision });
      setGroup(result.group);
      flash(result.selfAdded ? `${message}. You added yourself; this is noted in the group's history.` : message);
    } catch (reason) {
      if (isStale(reason)) {
        flash(staleMessage);
        void load();
      } else if (isGuestRefusal(reason)) {
        // The policy or the group's grants changed since the page loaded: say why and show the latest.
        flash(guestRefusedMessage);
        void load();
      } else flash(reason instanceof Error ? reason.message : "Could not change the members");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <article className="team-detail"><button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Groups</button><div className="team-state team-error" role="alert">
    <span className="team-state-icon"><TriangleAlert /></span>
    <h2>Could not load the group</h2>
    <p>{error}</p>
    <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
  </div></article>;
  if (!group) return <p className="team-loading" role="status">Loading the group…</p>;

  const inGroup = new Set(group.members.map((member) => member.id));
  const candidates = groupCandidates(group, members);

  return <article className="team-detail team-group-page" aria-labelledby="team-group-title">
    <button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Groups</button>
    <header className="team-detail-header">
      <span className="team-avatar large" aria-hidden="true"><UsersRound /></span>
      <div>
        <h2 id="team-group-title">{group.name}</h2>
        {group.description && <p className="team-detail-email">{group.description}</p>}
        <p className="team-muted">{memberCountLabel(group.memberCount)}{guestCountLabel(group.guestCount)} · shared {group.grantCount} {group.grantCount === 1 ? "item" : "items"}</p>
      </div>
    </header>
    <div className="team-card team-actions">
      <button type="button" className="team-action" onClick={() => setDialog("edit")} aria-haspopup="dialog"><Pencil />Rename</button>
      <button type="button" className="team-action danger" onClick={() => setDialog("delete")} aria-haspopup="dialog"><Trash2 />Delete group</button>
    </div>

    <section className="team-card" aria-labelledby="group-members-title">
      <h3 id="group-members-title">Members</h3>
      <p className="team-muted">Owners who share with this group reach everyone here. Guests in a group can only view.</p>
      <Combobox value={[]} onChange={(picked) => { if (picked[0]) void saveMembers([...inGroup, picked[0]], "Added to the group"); }}
        options={candidates} label="Add people" placeholder="Add people…" emptyText="Everyone is already in this group" disabled={busy} />
      {group.guestAddRefused && <p className="team-muted">{guestRefusedMessage} Guests already here stay until you remove them.</p>}
      {group.members.length === 0 ? <p className="team-muted">Nobody is in this group yet.</p> : <ul className="group-member-list" aria-label="Members">
        {group.members.map((member) => <li key={member.id} className="group-member-row">
          <span className="team-row-copy">
            <span className="team-row-title"><strong>{member.displayName}</strong>{member.status === "blocked" && <span className="team-status-chip">Blocked</span>}</span>
            <span className="team-row-meta">
              <span className={`team-role-chip ${member.role}`}><span className="sr-only">Team role: </span>{ROLE_LABELS[member.role]}</span>
              {member.selfAdded ? <span className="team-status-chip warn">Added by themselves</span> : member.addedBy && <span>Added by {member.addedBy.displayName}</span>}
              <span>{relativeTime(member.addedAt)}</span>
            </span>
          </span>
          <button type="button" className="icon-button group-member-remove" disabled={busy} aria-label={`Remove ${member.displayName} from ${group.name}`} title="Remove from group"
            onClick={() => { void saveMembers(group.members.filter((other) => other.id !== member.id).map((other) => other.id), `${member.displayName} was removed`); }}><UserMinus /></button>
        </li>)}
      </ul>}
    </section>

    <section className="team-card" aria-labelledby="group-items-title">
      <h3 id="group-items-title">Shared with this group</h3>
      {group.items.length === 0 ? <p className="team-muted">No owner has shared anything with this group yet.</p> : <ul className="group-item-list" aria-label="Items shared with this group">
        {group.items.map((item, index) => <li key={`${item.kind}-${item.id ?? index}`} className="group-item-row">
          <span className="team-row-copy">
            <span className="team-row-title">{item.titleHidden && <EyeOff aria-hidden="true" className="group-item-hidden" />}<strong>{item.title}</strong></span>
            <span className="team-row-meta"><span>{KIND_LABELS[item.kind]}</span>{!item.titleHidden && <span>Owned by {item.owner.displayName}</span>}{item.titleHidden && <span>Title hidden: you cannot open it</span>}</span>
          </span>
          <span className="team-role-chip">{LEVEL_LABELS[item.level]}</span>
        </li>)}
      </ul>}
      {group.truncated && <p className="team-muted">Showing the first 200 items.</p>}
    </section>

    <section className="team-card" aria-labelledby="group-history-title">
      <h3 id="group-history-title">History</h3>
      {group.history.length === 0 ? <p className="team-muted">Nothing yet.</p> : <ol className="team-events group-history">
        {group.history.map((row) => <li key={row.id}><span className={row.self ? "group-history-self" : undefined}>{groupEventLabel(row)}</span><time dateTime={row.createdAt}>{relativeTime(row.createdAt)}</time></li>)}
      </ol>}
    </section>

    {dialog === "edit" && <GroupFormDialog title="Rename group" submitLabel="Save" initial={{ name: group.name, description: group.description }} onClose={() => setDialog(null)} onSubmit={async (value) => {
      try {
        const result = await patchGroup(group.id, { ...value, revision: group.revision });
        setGroup(result.group);
        setDialog(null);
        flash("Group saved");
      } catch (reason) {
        if (!isStale(reason)) throw reason;
        setDialog(null);
        flash(staleMessage);
        void load();
      }
    }} />}
    {dialog === "delete" && <DeleteGroupDialog group={group} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); flash(`${group.name} was deleted`); onDeleted(); }} onStale={() => { setDialog(null); flash(staleMessage); void load(); }} />}
  </article>;
}

function DeleteGroupDialog({ group, onClose, onDeleted, onStale }: { group: GroupDetail; onClose: () => void; onDeleted: () => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirmAction() {
    setBusy(true);
    setError("");
    try {
      await deleteGroup(group.id, group.revision);
      onDeleted();
    } catch (reason) {
      if (isStale(reason)) return onStale();
      setError(reason instanceof Error ? reason.message : "Could not delete the group");
      setBusy(false);
    }
  }
  return <KeysDialog title={`Delete ${group.name}?`} description={deleteGroupMessage(group.memberCount, group.grantCount)} onClose={onClose} busy={busy}>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="keys-dialog-actions inline">
      <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button danger" onClick={() => { void confirmAction(); }} disabled={busy}>{busy ? "Deleting…" : "Delete group"}</button>
    </div>
  </KeysDialog>;
}
