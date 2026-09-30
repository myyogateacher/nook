import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Pencil, RotateCcw, ShieldAlert, Trash2, TriangleAlert, UserCheck, UserX } from "lucide-react";
import { ApiError } from "../api";
import { relativeTime } from "../files/format";
import { KeysSettings } from "../keys/KeysSettings";
import { integrationKeysApi, KeysApiContext } from "../keys/keysApi";
import { Avatar } from "../ui/Avatar";
import { IntegrationBadge } from "../ui/IntegrationBadge";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/useConfirm";
import { IntegrationFormDialog, INTEGRATIONS_HELP } from "./TeamIntegrations";
import {
  blockIntegration, deleteIntegration, deleteIntegrationMessage, getIntegration, INTEGRATION_ROLE_OPTIONS, retainedMessage, RETIRED_HELP, RETIRED_LABEL, unblockIntegration, updateIntegration,
  type IntegrationDetail, type IntegrationRole
} from "./integrationsApi";
import { eventLabel } from "./teamFormat";
import { hubDocumentTitle } from "../router";
import { googleIntegrationResultFor } from "../auth/googleSignIn";
import { googleSettingsNotice } from "../auth/GoogleAccountCard";
import { GoogleReturnNotice } from "./TeamGoogle";

const formatDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * One integration at /team/integrations/:integrationId (Wave 36, D287), admins only: its role
 * (Member or Viewer), rename and describe, block and unblock, delete, its keys (the same list and
 * dialogs as Settings → API keys, against this integration, with your password to create or
 * rotate), and its Team history. Every dialog is a history layer: Back closes it first.
 */
export function IntegrationPage({ integrationId, totpEnabled, onBack, onDeleted, onKeyPendingChange, flash }: {
  integrationId: string;
  /** The signed-in admin's two-factor state: creating or rotating a key asks for their code. */
  totpEnabled: boolean;
  onBack: () => void;
  onDeleted: () => void;
  /** Review R4: a new key is on screen (shown only once), so leaving the page asks first. */
  onKeyPendingChange?: (pending: boolean) => void;
  flash: (message: string) => void;
}) {
  const [integration, setIntegration] = useState<IntegrationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keysVersion, setKeysVersion] = useState(0);
  // Review R4: the key list remounts to reload after a block, unblock, role change, or delete, but
  // never while a new key is on screen (that would drop it): the reload waits until it is dismissed.
  const keyPendingRef = useRef(false);
  const staleKeysRef = useRef(false);
  const reloadKeys = useCallback(() => {
    if (keyPendingRef.current) staleKeysRef.current = true;
    else setKeysVersion((value) => value + 1);
  }, []);
  const pendingChanged = useCallback((pending: boolean) => {
    keyPendingRef.current = pending;
    onKeyPendingChange?.(pending);
    if (!pending && staleKeysRef.current) {
      staleKeysRef.current = false;
      setKeysVersion((value) => value + 1);
    }
  }, [onKeyPendingChange]);
  const { ask, confirmElement } = useConfirm();
  // Review L6: an admin's Google confirmation started from this page's keys comes back here; its result shows over the keys.
  const [returned, setReturned] = useState(() => {
    const result = googleIntegrationResultFor(integrationId);
    return result ? googleSettingsNotice(result) : null;
  });
  const generation = useRef(0);
  const keysApi = useMemo(() => integrationKeysApi(integrationId), [integrationId]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await getIntegration(integrationId);
      if (current === generation.current) setIntegration(result.integration);
    } catch (reason) {
      if (current !== generation.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        flash("Integration not found");
        onDeleted();
        return;
      }
      setError(reason instanceof Error ? reason.message : "Could not load the integration");
    }
  }, [flash, integrationId, onDeleted]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (integration) document.title = hubDocumentTitle(integration.displayName); }, [integration]);

  async function act(operation: () => Promise<{ integration: IntegrationDetail }>, message: string) {
    setBusy(true);
    try {
      const result = await operation();
      setIntegration(result.integration);
      reloadKeys();
      flash(message);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Something went wrong");
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(role: IntegrationRole) {
    if (!integration || role === integration.role) return;
    const confirmed = await ask({
      title: `Make ${integration.displayName} a ${role}?`,
      message: role === "viewer" ? "Its keys keep only their read permissions from now on." : "Its keys can write again where an owner gave it Can edit and the key allows it.",
      confirmLabel: "Change role"
    });
    if (confirmed) await act(() => updateIntegration(integration.id, { role, expectedRole: integration.role }), `${integration.displayName} is now a ${role}`);
  }

  async function toggleBlock() {
    if (!integration) return;
    const blocked = integration.status === "blocked";
    const confirmed = await ask(blocked
      ? { title: `Unblock ${integration.displayName}?`, message: integration.keys.live ? "Its live keys work again, as they were before the block." : "It has no live keys: create one after unblocking.", confirmLabel: "Unblock" }
      : { title: `Block ${integration.displayName}?`, message: "Its keys stop working until you unblock it. Nothing is deleted, and owners' shares with it stay.", confirmLabel: "Block", danger: true });
    if (!confirmed) return;
    await act(() => blocked ? unblockIntegration(integration.id) : blockIntegration(integration.id), blocked ? `${integration.displayName} is unblocked` : `${integration.displayName} is blocked; its keys are paused`);
  }

  async function remove() {
    if (!integration) return;
    const confirmed = await ask({ title: `Delete ${integration.displayName}?`, message: deleteIntegrationMessage(integration), confirmLabel: "Delete integration", danger: true });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await deleteIntegration(integration.id);
      if (result.deleted) {
        flash(`${integration.displayName} was deleted`);
        onDeleted();
        return;
      }
      setIntegration(result.integration);
      reloadKeys();
      flash(retainedMessage(integration));
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not delete the integration");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <article className="team-detail"><button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Integrations</button><div className="team-state team-error" role="alert">
    <span className="team-state-icon"><TriangleAlert /></span>
    <h2>Could not load the integration</h2>
    <p>{error}</p>
    <button className="primary-button" onClick={() => { void load(); }}><RotateCcw />Try again</button>
  </div></article>;
  if (!integration) return <p className="team-loading" role="status">Loading the integration…</p>;

  const blocked = integration.status === "blocked";
  const retired = integration.status === "retired";
  return <article className="team-detail team-integration-page" aria-labelledby="team-integration-title">
    <button type="button" className="team-back team-back-visible" onClick={onBack}><ChevronLeft />Integrations</button>
    <header className="team-detail-header">
      <Avatar className="team-avatar large" name={integration.displayName} integration />
      <div>
        <h2 id="team-integration-title">{integration.displayName}<IntegrationBadge /></h2>
        {integration.description && <p className="team-detail-email">{integration.description}</p>}
        <p className="team-detail-status"><span className={blocked || retired ? "team-status-chip" : "team-status-chip active"}>{retired ? RETIRED_LABEL : blocked ? "Blocked" : "Active"}</span></p>
      </div>
    </header>
    <p className="team-muted">{INTEGRATIONS_HELP}</p>

    {retired && <section className="team-card team-blocked" aria-label="Deleted">
      <p><ShieldAlert aria-hidden="true" />Deleted{integration.retiredAt ? ` ${relativeTime(integration.retiredAt)}` : ""}, and kept so its name stays on what it did.</p>
      <p className="team-muted">{RETIRED_HELP}</p>
    </section>}

    {!retired && <section className="team-card" aria-labelledby="integration-role-heading">
      <h3 id="integration-role-heading">Role</h3>
      <Select<IntegrationRole> labelledBy="integration-role-heading" label="Role" value={integration.role} options={INTEGRATION_ROLE_OPTIONS} onChange={(role) => { void changeRole(role); }} disabled={busy} />
      <p className="team-role-hint">Its keys never do more than this role allows, whatever their permissions say.</p>
    </section>}

    {!retired && <section className="team-card team-actions" aria-label="Integration actions">
      <button type="button" className="team-action" onClick={() => setEditing(true)} disabled={busy} aria-haspopup="dialog"><Pencil />Rename</button>
      {blocked
        ? <button type="button" className="team-action" onClick={() => { void toggleBlock(); }} disabled={busy}><UserCheck />Unblock</button>
        : <button type="button" className="team-action danger" onClick={() => { void toggleBlock(); }} disabled={busy}><UserX />Block</button>}
      <button type="button" className="team-action danger" onClick={() => { void remove(); }} disabled={busy}><Trash2 />Delete</button>
    </section>}

    {blocked && <section className="team-card team-blocked" aria-label="Block details">
      <p><ShieldAlert aria-hidden="true" />{integration.blockedBy ? `Blocked by ${integration.blockedBy.displayName}` : "Blocked"}{integration.blockedAt ? `, ${relativeTime(integration.blockedAt)}` : ""}.</p>
      <p className="team-muted">Its keys are paused. Unblock it to use them again; create or rotate keys after unblocking.</p>
    </section>}

    {!retired && <KeysApiContext.Provider value={keysApi}>
      <KeysSettings key={keysVersion} notice={returned && <GoogleReturnNotice notice={returned} onDismiss={() => setReturned(null)} />} integration={{ name: integration.displayName }} role={integration.role} totpEnabled={totpEnabled} onPendingChange={pendingChanged} reopenOnForward={false} />
    </KeysApiContext.Provider>}

    <section className="team-card" aria-labelledby="integration-facts-heading">
      <h3 id="integration-facts-heading">About</h3>
      <dl className="team-facts">
        <div><dt>Created</dt><dd>{formatDate(integration.createdAt)}{integration.createdBy ? ` by ${integration.createdBy.displayName}` : ""}</dd></div>
        <div><dt>Last used</dt><dd>{integration.lastUsedAt ? relativeTime(integration.lastUsedAt) : "Never"}</dd></div>
        <div><dt>Live keys</dt><dd>{integration.keys.live}</dd></div>
      </dl>
    </section>

    {integration.events.length > 0 && <section className="team-card" aria-labelledby="integration-activity-heading">
      <h3 id="integration-activity-heading">Activity</h3>
      <ol className="team-activity">
        {integration.events.map((event) => <li key={event.id}>
          <span>{eventLabel(event)}</span>
          <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>{relativeTime(event.createdAt)}</time>
        </li>)}
      </ol>
    </section>}

    {editing && <IntegrationFormDialog title={`Rename ${integration.displayName}`} submitLabel="Save" initial={{ name: integration.displayName, role: integration.role, description: integration.description }} onClose={() => setEditing(false)} onSubmit={async (value) => {
      const result = await updateIntegration(integration.id, { name: value.name, description: value.description, ...(value.role !== integration.role ? { role: value.role, expectedRole: integration.role } : {}) });
      setIntegration(result.integration);
      setEditing(false);
      flash("Integration saved");
    }} />}
    {confirmElement}
  </article>;
}
