import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, KeyRound, RotateCcw, ShieldOff, TriangleAlert, X } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { KeysDialog } from "../keys/KeysDialog";
import { adminRevokeKey } from "../keys/keysApi";
import { Select, type Option } from "../ui/Select";
import { AccessOverview } from "../access/AccessOverview";
import {
  applyTemplateToMember, getMemberAccess, getMemberAccessPage, LEVEL_WORDS, listTemplates, lowerMemberAccess, removeMemberAccess, removeMemberFromGroup,
  resetMemberAccess, resetLines, resetSummary, feedsAndRoutines, guestRefusedNames, guestRefusalReason, type AccessKind, type AccessLevel, type AccessRow, type AccessSource, type AccessSummary, type AccessTemplate, type ResetCounts
} from "../access/memberAccessApi";
import { ROLE_LABELS } from "./teamRoles";
import "../keys/keys.css";

/**
 * A member's access at /team/:userId/access (Wave 33, access plan §C.6, §E, D268, D269), admins
 * only: their groups, keys, feeds and routines, and per module what they reach. Every action is a
 * reduction (remove, lower, leave a group, revoke a key, Reset access) or adds groups from a
 * template, and each goes through a confirm dialog that Back closes. Titles of items the admin
 * cannot open stay hidden.
 */

type Dialog =
  | { kind: "remove"; row: AccessRow; source: AccessSource }
  | { kind: "lower"; row: AccessRow; source: AccessSource; level: AccessLevel }
  | { kind: "group"; group: { id: string; name: string } }
  | { kind: "key"; key: AccessSummary["keys"][number] }
  | { kind: "template"; template: AccessTemplate }
  | { kind: "reset" };

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

/** A real title in quotes; a placeholder for an item you cannot open in plain words ("the board owned by Carol"). */
export const itemRef = (row: Pick<AccessRow, "title" | "titleHidden">) => row.titleHidden ? row.title.replace(/^\w/, (letter) => `the ${letter.toLowerCase()}`) : `“${row.title}”`;

export function MemberAccess({ userId, onBack, flash }: { userId: string; onBack: () => void; flash: (message: string) => void }) {
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<AccessTemplate[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await getMemberAccess(userId);
      if (current === generation.current) setSummary(result);
    } catch (reason) {
      if (current === generation.current) setError(messageOf(reason, "Could not load access"));
    }
  }, [userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { listTemplates().then((result) => setTemplates(result.templates), () => setTemplates([])); }, []);
  useEffect(() => { if (summary) document.title = `${summary.member.displayName} · Access · Team · Nook`; }, [summary]);

  const loadPage = useCallback((kind: AccessKind, cursor?: string | null) => getMemberAccessPage(userId, kind, cursor), [userId]);
  const changed = useCallback((message: string) => {
    setDialog(null);
    flash(message);
    setReloadKey((value) => value + 1);
    void load();
  }, [flash, load]);

  if (error) return <article className="team-detail"><button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Back</button><div className="team-state team-error" role="alert">
    <span className="team-state-icon"><TriangleAlert /></span>
    <h2>Could not load access</h2>
    <p>{error}</p>
    <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
  </div></article>;
  if (!summary) return <p className="team-loading" role="status">Loading access…</p>;

  const { member } = summary;
  // A guest cannot join granted groups while sharing with guests is off: say so on the option (Q2).
  const templateOptions: Option[] = templates.map((template) => {
    const refused = member.role === "guest" ? guestRefusedNames(template) : [];
    const groups = template.groups.length ? template.groups.map((group) => group.name).join(", ") : "No groups";
    return { value: template.id, label: refused.length ? `${template.name} (refused for a guest)` : template.name, description: refused.length ? `${groups}. ${guestRefusalReason(refused)}` : groups };
  });
  const nothingToReset = Object.values(summary.resetCounts).every((count) => count === 0);

  return <article className="team-detail member-access" aria-labelledby="member-access-title">
    <button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />{member.displayName}</button>
    <header className="team-invites-header">
      <div>
        <h2 id="member-access-title">{member.displayName}'s access</h2>
        <p className="team-muted">{ROLE_LABELS[member.role]}{member.status === "blocked" ? " · Blocked" : ""}. What they can open, and through what. You can only take access away here; owners share their own items. Titles of items you cannot open stay hidden.</p>
      </div>
      {!member.isYou && <div className="ma-header-actions">
        <button type="button" className="team-action danger" aria-haspopup="dialog" disabled={nothingToReset} onClick={() => setDialog({ kind: "reset" })}><ShieldOff />Reset access…</button>
      </div>}
    </header>

    <section className="team-card" aria-labelledby="member-access-groups">
      <h3 id="member-access-groups">Groups</h3>
      {summary.groups.length === 0 ? <p className="team-muted">Not in any group.</p> : <ul className="ma-group-chips" aria-label="Groups">
        {summary.groups.map((group) => <li key={group.id} className="ma-group-chip">
          <span>{group.name}</span>
          {group.selfAdded && <span className="team-status-chip warn">Added by themselves</span>}
          <button type="button" className="icon-button" aria-label={`Remove from ${group.name}`} title="Remove from group" onClick={() => setDialog({ kind: "group", group })}><X /></button>
        </li>)}
      </ul>}
      {templates.length > 0 && member.status === "active" && <div className="keys-select-field">
        <span id="member-access-template">Add the groups of a template</span>
        <Select labelledBy="member-access-template" label="Apply a template" placeholder="Choose a template…" value={null} options={templateOptions}
          onChange={(id) => { const template = templates.find((entry) => entry.id === id); if (template) setDialog({ kind: "template", template }); }} />
      </div>}
    </section>

    <section className="team-card" aria-labelledby="member-access-keys">
      <h3 id="member-access-keys">API keys, feeds, and routines</h3>
      {summary.keys.length === 0 ? <p className="team-muted">No live API keys.</p> : <ul className="ma-key-list" aria-label="API keys">
        {summary.keys.map((key) => <li key={key.id} className="ma-key-row">
          <span className="team-row-copy">
            <span className="team-row-title"><KeyRound aria-hidden="true" className="group-item-hidden" /><strong>{key.name}</strong></span>
            <span className="team-row-meta"><code>{key.prefix}…</code><span>{key.modules.join(", ") || "No modules"}</span><span>{key.expiresAt ? `Expires ${new Date(key.expiresAt).toLocaleDateString()}` : "No expiry"}</span><span>{key.lastUsedAt ? `Used ${relativeTime(key.lastUsedAt)}` : "Never used"}</span></span>
          </span>
          <button type="button" className="team-action danger" aria-haspopup="dialog" onClick={() => setDialog({ kind: "key", key })}>Revoke</button>
        </li>)}
      </ul>}
      <p className="ma-summary-line">{feedsAndRoutines(summary) ?? "No calendar feeds or active routines."}{feedsAndRoutines(summary) ? " Reset access revokes feeds and pauses routines." : ""}</p>
    </section>

    <AccessOverview summary={summary} loadPage={loadPage} reloadKey={reloadKey} busy={dialog !== null}
      actions={{ onRemove: (row, source) => setDialog({ kind: "remove", row, source }), onLower: (row, source, level) => setDialog({ kind: "lower", row, source, level }) }} />

    {dialog && <ActionDialog dialog={dialog} summary={summary} onClose={() => setDialog(null)} onDone={changed} onStale={() => { setDialog(null); flash("That access changed meanwhile. The page now shows the latest."); setReloadKey((value) => value + 1); void load(); }} />}
  </article>;
}

function ActionDialog({ dialog, summary, onClose, onDone, onStale }: { dialog: Dialog; summary: AccessSummary; onClose: () => void; onDone: (message: string) => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ removed: ResetCounts; remaining: ResetCounts } | null>(null);
  const name = summary.member.displayName;
  const userId = summary.member.id;
  // The server refuses a template for a guest when any of its groups has items shared with it and sharing with guests is off (Q2).
  const refusedNames = dialog.kind === "template" && summary.member.role === "guest" ? guestRefusedNames(dialog.template) : [];
  const templateRefusal = refusedNames.length ? refusedNames : null;
  let confirmDisabled = false;

  async function run(operation: () => Promise<string | null>) {
    setBusy(true);
    setError("");
    try {
      const message = await operation();
      if (message) onDone(message);
      else setBusy(false);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) return onStale();
      setError(messageOf(reason, "Something went wrong"));
      setBusy(false);
    }
  }

  let title: string;
  let body: ReactNode;
  let confirm: string;
  let action: () => Promise<string | null>;
  let danger = true;
  switch (dialog.kind) {
    case "remove": {
      const { row, source } = dialog;
      const viaGroup = source.via === "group";
      title = viaGroup ? `Remove ${name} from ${source.group?.name ?? "the group"}?` : `Remove ${name}'s access?`;
      body = viaGroup
        ? <p>{name} loses everything owners shared with {source.group?.name ?? "this group"}, not only {itemRef(row)}. Their own items and direct shares stay. They are told.</p>
        : <p>{name} can no longer open {itemRef(row)} {row.sources.some((other) => other.via === "group") ? `through a direct share; they keep what ${row.sources.filter((other) => other.via === "group").map((other) => other.group?.name ?? "a group").join(", ")} gives them` : "unless it is shared with them another way"}. The owner is told and can share it again.</p>;
      confirm = viaGroup ? "Remove from group" : "Remove access";
      action = async () => {
        const removed = await removeMemberAccess(userId, source.handle!);
        return removed.removed === "group" ? `${name} was removed from ${source.group?.name ?? "the group"}` : `${name}'s direct share was removed`;
      };
      break;
    }
    case "lower":
      title = `Lower ${name}'s access to ${LEVEL_WORDS[dialog.level]}?`;
      body = <p>{name} keeps access to {itemRef(dialog.row)}, at {LEVEL_WORDS[dialog.level]} instead of {LEVEL_WORDS[dialog.source.level]} through their direct share. The owner is told and can change it back.</p>;
      confirm = "Lower access";
      action = async () => {
        await lowerMemberAccess(userId, dialog.source.handle!, dialog.level);
        return `${name} now has ${LEVEL_WORDS[dialog.level]}`;
      };
      break;
    case "group":
      title = `Remove ${name} from ${dialog.group.name}?`;
      body = <p>{name} loses everything owners shared with {dialog.group.name}. They are told. You can add them back from the group's page.</p>;
      confirm = "Remove from group";
      action = async () => {
        await removeMemberFromGroup(userId, dialog.group.id);
        return `${name} was removed from ${dialog.group.name}`;
      };
      break;
    case "key":
      title = `Revoke ${name}'s key “${dialog.key.name}”?`;
      body = <label className="keys-input">Reason (the owner sees it)<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} rows={2} disabled={busy} /></label>;
      confirm = "Revoke key";
      action = async () => {
        if (!reason.trim()) {
          setError("Say why, so the owner knows.");
          return null;
        }
        await adminRevokeKey(dialog.key.id, reason.trim());
        return `${dialog.key.name} was revoked`;
      };
      break;
    case "template":
      danger = false;
      title = `Add ${name} to the groups of ${dialog.template.name}?`;
      body = templateRefusal
        ? <p className="form-error" role="alert">{name} is a guest, so this template cannot be applied: {guestRefusalReason(templateRefusal)} Remove those groups from the template, or turn on sharing with guests in Team → Policies.</p>
        : <p>{dialog.template.groups.length ? `${name} joins ${dialog.template.groups.map((group) => group.name).join(", ")}, and so reaches what owners shared with those groups.` : "This template has no groups, so nothing changes."} Their team role stays {ROLE_LABELS[summary.member.role]}. They are told.</p>;
      confirm = "Add to groups";
      confirmDisabled = templateRefusal !== null;
      action = async () => {
        const applied = await applyTemplateToMember(userId, dialog.template.id);
        return applied.added ? `${name} joined ${applied.added} ${applied.added === 1 ? "group" : "groups"}` : `${name} was already in those groups`;
      };
      break;
    case "reset":
      title = result ? `${name}'s access was reset` : `Reset ${name}'s access?`;
      body = result
        ? <>
          <p>Removed: {resetSummary(result.removed)}.</p>
          <p>{Object.values(result.remaining).every((count) => count === 0) ? "Nothing is left." : `Still there (changed meanwhile): ${resetSummary(result.remaining)}.`}</p>
        </>
        : <>
          <p>This removes, at once:</p>
          <ul className="ma-reset-counts">
            {resetLines(summary.resetCounts).map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p>Their own items and what is shared with everyone stay. Each owner is told once. This cannot be undone here; owners can share again.</p>
        </>;
      confirm = result ? "Done" : "Reset access";
      danger = !result;
      action = async () => {
        if (result) return `${name}'s access was reset`;
        setResult(await resetMemberAccess(userId));
        return null;
      };
      break;
  }

  return <KeysDialog title={title} onClose={result ? () => onDone(`${name}'s access was reset`) : onClose} busy={busy}>
    <div className="keys-form">
      {body}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="keys-dialog-actions inline">
        {!result && <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>}
        <button type="button" className={`primary-button${danger ? " danger" : ""}`} onClick={() => { void run(action); }} disabled={busy || confirmDisabled}>{busy ? "Working…" : confirm}</button>
      </div>
    </div>
  </KeysDialog>;
}
