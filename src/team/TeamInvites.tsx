import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronLeft, Copy, Link2, Mail, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { Select, type Option } from "../ui/Select";
import { listTemplates, type AccessTemplate } from "../access/memberAccessApi";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { DEFAULT_EXPIRY, DEFAULT_INVITE_ROLE, EMAIL_NOT_CONFIGURED, expiryOptions, INVITE_STATUS_LABELS, inviteLimitHint, inviteRoleOptions, inviteTimeLabel, mailOutcomeLabel, shownOnceWarning, templateLabel, type ExpiryDays } from "./inviteFormat";
import { createTeamInvite, emailTeamInvite, revokeTeamInvite, type InviteRole, type MailOutcome, type TeamInvite, type TeamInviteList } from "./teamApi";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "./teamRoles";

type Props = {
  data: TeamInviteList | null;
  error: string | null;
  onBack: () => void;
  onReload: () => void;
  onOpenMember: (userId: string) => void;
  flash: (message: string) => void;
};

type Dialog = { kind: "create" } | { kind: "revoke"; invite: TeamInvite } | { kind: "email"; invite: TeamInvite };

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const NO_TEMPLATE = "none";

/**
 * The admin Invites panel at /team/invites (docs/plan/WAVES_18-20_SMALL.md §1.6, D167): in the
 * Team detail pane on desktop, a full panel at ≤760 px. Dialogs push no history entry; Back closes
 * them first (useHistoryDialogGuard). Focus returns to the control that opened a dialog.
 */
export function TeamInvites({ data, error, onBack, onReload, onOpenMember, flash }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const limitHint = data ? inviteLimitHint(data.liveCount, data.liveLimit) : null;
  const emailEnabled = data?.emailEnabled === true;

  const open = (next: Dialog) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(next);
  };
  const close = useCallback(() => {
    setDialog(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) window.setTimeout(() => trigger.focus(), 0);
  }, []);

  return <article className="team-detail team-invites" aria-labelledby="team-invites-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-invites-title">Invites</h2>
        <p className="team-muted">Single-use links that let someone create an account with a team role you choose, even while registration is closed. The email allowlist still applies.</p>
      </div>
      <button type="button" className="team-action primary" onClick={() => open({ kind: "create" })} disabled={!data || Boolean(limitHint)}><Plus />New invite</button>
    </header>
    {limitHint && <p className="team-muted team-invites-limit" role="note">{limitHint}</p>}

    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load invites</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={onReload}><RotateCcw />Try again</button>
    </div>}
    {!error && !data && <p className="team-loading" role="status">Loading invites…</p>}
    {!error && data && data.invites.length === 0 && <div className="team-state">
      <span className="team-state-icon"><Link2 /></span>
      <h2>No invites yet.</h2>
      <p>Create a link to add someone without opening registration.</p>
    </div>}
    {!error && data && data.invites.length > 0 && <ul className="team-invite-list" aria-label="Invites">
      {data.invites.map((invite) => <li key={invite.id} className={`team-invite ${invite.status}`}>
        <div className="team-invite-top">
          <span className={`team-role-chip ${invite.role}`}><span className="sr-only">Team role: </span>{ROLE_LABELS[invite.role]}</span>
          <span className={`team-status-chip invite-${invite.status}`}>{INVITE_STATUS_LABELS[invite.status]}</span>
          <code className="team-invite-prefix" title="The first characters of the link's token">{invite.tokenPrefix}…</code>
        </div>
        {(invite.email || invite.note || invite.template) && <p className="team-invite-label">
          {invite.email && <span>Only {invite.email}</span>}
          {invite.note && <span className="team-invite-note">{invite.note}</span>}
          {invite.template && <span>{templateLabel(invite.template)}</span>}
        </p>}
        <p className="team-invite-meta">
          <span>{inviteTimeLabel(invite)}</span>
          <span>Created {relativeTime(invite.createdAt)}{invite.createdBy ? ` by ${invite.createdBy.displayName}` : ""}</span>
        </p>
        {(invite.status === "live" || (invite.status === "used" && invite.usedBy)) && <div className="team-invite-actions">
          {invite.status === "live" && invite.email && <button type="button" className="team-action" onClick={() => { if (emailEnabled) open({ kind: "email", invite }); else flash(EMAIL_NOT_CONFIGURED); }}><Mail />Resend email</button>}
          {invite.status === "live" && <button type="button" className="team-action danger" onClick={() => open({ kind: "revoke", invite })}><Ban />Revoke</button>}
          {invite.status === "used" && invite.usedBy && <button type="button" className="team-action" onClick={() => onOpenMember(invite.usedBy!.id)}>Open {invite.usedBy.displayName}</button>}
        </div>}
      </li>)}
    </ul>}

    {dialog?.kind === "create" && <InviteCreateDialog emailEnabled={emailEnabled} onClose={close} onCreated={onReload} />}
    {dialog?.kind === "email" && <InviteEmailDialog invite={dialog.invite} onClose={close} onDone={(message) => { close(); flash(message); onReload(); }} />}
    {dialog?.kind === "revoke" && <InviteRevokeDialog invite={dialog.invite} onClose={close} onDone={(message) => { close(); flash(message); onReload(); }} />}
  </article>;
}

function useDialogChrome(busy: boolean, onClose: () => void) {
  useHistoryDialogGuard(true, onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A Select's popup handles its own Escape first.
      if (event.key === "Escape" && !busy && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
}

type Created = { url: string; role: InviteRole; expiresAt: string; email: string | null; mail?: MailOutcome };

/**
 * The create dialog, then the shown-once state: the link lives only in this component's state, so
 * closing the dialog drops it (D161).
 */
function InviteCreateDialog({ emailEnabled, onClose, onCreated }: { emailEnabled: boolean; onClose: () => void; onCreated: () => void }) {
  const [role, setRole] = useState<InviteRole>(DEFAULT_INVITE_ROLE);
  const [email, setEmail] = useState("");
  const [sendEmail, setSendEmail] = useState(false);
  const boundEmail = email.trim();
  const [expiry, setExpiry] = useState<ExpiryDays>(DEFAULT_EXPIRY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  // Wave 33 (D286): an optional access template; its role becomes the invite's role.
  const [templates, setTemplates] = useState<AccessTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>(NO_TEMPLATE);
  const linkRef = useRef<HTMLInputElement>(null);
  useDialogChrome(busy, onClose);
  useEffect(() => { listTemplates().then((result) => setTemplates(result.templates), () => setTemplates([])); }, []);
  const template = templates.find((entry) => entry.id === templateId) ?? null;
  const templateOptions: Option[] = [{ value: NO_TEMPLATE, label: "No template" }, ...templates.map((entry) => ({ value: entry.id, label: entry.name, description: `${ROLE_LABELS[entry.role]} · ${entry.groups.length ? entry.groups.map((group) => group.name).join(", ") : "no groups"}` }))];
  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const picked = templates.find((entry) => entry.id === id);
    if (picked) setRole(picked.role);
  };
  const chooseRole = (next: InviteRole) => {
    setRole(next);
    // A template's role must match the invite's (the server refuses otherwise), so a different role drops it.
    if (template && template.role !== next) setTemplateId(NO_TEMPLATE);
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const note = String(form.get("note") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const mailIt = Boolean(boundEmail) && sendEmail && emailEnabled;
      const result = await createTeamInvite({ role, expiresInDays: Number(expiry), ...(boundEmail ? { email: boundEmail } : {}), ...(note ? { note } : {}), ...(mailIt ? { sendEmail: true } : {}), ...(template ? { templateId: template.id } : {}) });
      setCreated({ url: result.url, role: result.invite.role, expiresAt: result.invite.expiresAt, email: result.invite.email, ...(result.email ? { mail: result.email } : {}) });
      onCreated();
    } catch (reason) {
      setError(messageOf(reason, "Could not create the invite"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      // No clipboard permission: select the link so the admin can copy it by hand.
      linkRef.current?.focus();
      linkRef.current?.select();
      setCopied(false);
    }
  }

  return <>
    <button type="button" className="panel-scrim team-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div className="team-dialog team-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="team-invite-dialog-title">
      <header>
        <h2 id="team-invite-dialog-title">{created ? "Invite link ready" : "New invite"}</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      {created ? <div className="team-invite-created">
        <label className="team-field">Invite link
          <input ref={linkRef} readOnly value={created.url} onFocus={(event) => event.currentTarget.select()} aria-describedby="team-invite-warning" />
        </label>
        <p id="team-invite-warning" className="team-invite-warning"><TriangleAlert aria-hidden="true" />{shownOnceWarning(created.role, created.expiresAt)}</p>
        {created.mail && <p className={`team-invite-mail${created.mail.sent ? " sent" : ""}`} role="status"><Mail aria-hidden="true" />{mailOutcomeLabel(created.mail, created.email)}</p>}
        <p className="sr-only" aria-live="polite">{copied ? "Link copied" : ""}</p>
        <div className="team-dialog-actions">
          <button type="button" className="team-action" onClick={onClose}>Done</button>
          <button type="button" className="team-action primary" onClick={() => { void copy(); }} autoFocus>{copied ? <><Check />Link copied</> : <><Copy />Copy link</>}</button>
        </div>
      </div> : <form onSubmit={submit}>
        {templates.length > 0 && <div className="team-field">
          <span id="team-invite-template-label">Template (optional)</span>
          <Select labelledBy="team-invite-template-label" label="Template" value={templateId} options={templateOptions} onChange={chooseTemplate} disabled={busy} />
          <small className="team-muted">{template ? `They join ${template.groups.length ? template.groups.map((group) => group.name).join(", ") : "no groups"} when they register.` : "A template adds groups when they register."}</small>
        </div>}
        <div className="team-field">
          <span id="team-invite-role-label">Team role</span>
          <Select labelledBy="team-invite-role-label" label="Team role" value={role} options={inviteRoleOptions()} onChange={chooseRole} disabled={busy} />
          <small className="team-muted">{ROLE_DESCRIPTIONS[role]}. Admins are promoted after sign-up.</small>
        </div>
        <div className="team-field">
          <span id="team-invite-expiry-label">Expires</span>
          <Select labelledBy="team-invite-expiry-label" label="Expires" value={expiry} options={expiryOptions()} onChange={setExpiry} disabled={busy} />
        </div>
        <label className="team-field">Email (optional)
          <input name="email" type="email" autoComplete="off" maxLength={254} placeholder="Only this address can use the link" disabled={busy} value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        {boundEmail && <label className={`team-check${emailEnabled ? "" : " disabled"}`}>
          <input type="checkbox" checked={sendEmail && emailEnabled} disabled={busy || !emailEnabled} onChange={(event) => setSendEmail(event.target.checked)} />
          <span>Send by email to {boundEmail}{!emailEnabled && <small>{EMAIL_NOT_CONFIGURED}</small>}</span>
        </label>}
        <label className="team-field">Label (optional, only admins see it)
          <input name="note" maxLength={80} placeholder="For the design contractor" disabled={busy} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="team-dialog-actions">
          <button type="button" className="team-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="team-action primary" disabled={busy}>{busy ? "Creating…" : "Create link"}</button>
        </div>
      </form>}
    </div>
  </>;
}

function InviteRevokeDialog({ invite, onClose, onDone }: { invite: TeamInvite; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogChrome(busy, onClose);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await revokeTeamInvite(invite.id);
      onDone("Invite revoked");
    } catch (reason) {
      if (reason instanceof ApiError && (reason.payload as { code?: string } | undefined)?.code === "INVITE_NOT_LIVE") onDone(messageOf(reason, "This invite is no longer live"));
      else setError(messageOf(reason, "Could not revoke the invite"));
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="panel-scrim team-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div className="team-dialog" role="dialog" aria-modal="true" aria-labelledby="team-revoke-dialog-title">
      <header>
        <h2 id="team-revoke-dialog-title">Revoke this {ROLE_LABELS[invite.role]} invite?</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      <form onSubmit={submit}>
        <p>The link stops working at once{invite.email ? ` for ${invite.email}` : ""}. Nobody has used it yet. You can create a new one at any time.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="team-dialog-actions">
          <button type="button" className="team-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="team-action primary danger" disabled={busy} autoFocus>{busy ? "Working…" : "Revoke"}</button>
        </div>
      </form>
    </div>
  </>;
}

/** "Resend email": a fresh link goes to the bound address; the current link stops working once it is sent. */
function InviteEmailDialog({ invite, onClose, onDone }: { invite: TeamInvite; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useDialogChrome(busy, onClose);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await emailTeamInvite(invite.id);
      if (result.email.sent) onDone(mailOutcomeLabel(result.email, invite.email));
      else {
        setError(mailOutcomeLabel(result.email, invite.email));
        setBusy(false);
      }
    } catch (reason) {
      setError(messageOf(reason, "Could not send the email"));
      setBusy(false);
    }
  }

  return <>
    <button type="button" className="panel-scrim team-dialog-scrim" onClick={() => { if (!busy) onClose(); }} aria-label="Close" tabIndex={-1} />
    <div className="team-dialog" role="dialog" aria-modal="true" aria-labelledby="team-email-dialog-title">
      <header>
        <h2 id="team-email-dialog-title">Email a new link to {invite.email}?</h2>
        <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button>
      </header>
      <form onSubmit={submit}>
        <p>Nook emails a fresh {ROLE_LABELS[invite.role]} link to this address only. Once it is sent, the link you copied earlier stops working. The expiry stays the same.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="team-dialog-actions">
          <button type="button" className="team-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="team-action primary" disabled={busy} autoFocus>{busy ? "Sending…" : "Send email"}</button>
        </div>
      </form>
    </div>
  </>;
}
