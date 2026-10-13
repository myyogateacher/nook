import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { LinkableKey, NookLink } from "../../shared/agents";
import { agentLink, messageOf, setAgentLink } from "./chatApi";
import { MODULE_NAMES } from "./toolPicker";
import "./chat.css";
import { FormError } from "../ui/FormError";

/**
 * The Link Nook key sheet (agent chat plan §5.3, D359; Wave 41 AC-B): the person picks one of
 * THEIR OWN live general keys with the MCP surface. The link is a pointer, never a token; the
 * agent then reads and proposes through that key's grants, never through the owner's session.
 * Back closes the sheet (useHistoryDialogGuard).
 */

/** "Notes: read · Tasks: read, write" from a key's grants, for the sheet and the editor. */
export function grantSummary(grants: LinkableKey["grants"]): string {
  const byModule = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (!grant.active) continue;
    const label = `${grant.permission}${grant.resource ? ` (${grant.resource.name ?? grant.resource.kind})` : ""}`;
    byModule.set(grant.module, new Set([...(byModule.get(grant.module) ?? []), label]));
  }
  if (byModule.size === 0) return "No active grants";
  return [...byModule.entries()].map(([module, permissions]) => `${MODULE_NAMES[module] ?? module}: ${[...permissions].join(", ")}`).join(" · ");
}

export function LinkNookKeySheet({ agentId, agentName, onClose, onChanged, onOpenKeys }: { agentId: string; agentName: string; onClose: () => void; onChanged: (link: NookLink) => void; onOpenKeys?: () => void }) {
  const [link, setLink] = useState<NookLink | undefined>(undefined);
  const [keys, setKeys] = useState<LinkableKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  const load = useCallback(async () => {
    try {
      const next = await agentLink(agentId);
      setLink(next.link);
      setKeys(next.keys);
      setError(null);
    } catch (reason) {
      setError(messageOf(reason, "Could not load your keys"));
    }
  }, [agentId]);
  useEffect(() => { void load(); }, [load]);

  async function choose(keyId: string | null) {
    setBusy(true);
    try {
      const next = await setAgentLink(agentId, keyId);
      setLink(next.link);
      onChanged(next.link);
    } catch (reason) {
      setError(messageOf(reason, "Could not change the link"));
    } finally {
      setBusy(false);
    }
  }

  return <ModalDialog title="Link Nook key" eyebrow={agentName} onClose={onClose} busy={busy} variant="sheet" className="chat-dialog chat-link-key-sheet">
    <div className="chat-link-key">
      <p className="file-dialog-hint"><KeyRound /> {agentName} reaches your Nook only through a key you own: what the key may read, the agent may read, and its writes land in your Inbox as proposals. Your own session is never used, and whatever the agent reads is sent to the model provider.</p>
      <FormError message={error} />
      {link && <div className="security-card chat-link-current">
        <strong>Linked: {link.name}</strong><small><code>{link.prefix}…</code> · {link.state}</small>
        <button type="button" className="secondary-button" onClick={() => { void choose(null); }} disabled={busy}>Unlink</button>
      </div>}
      {link === undefined ? <p className="chat-muted">Loading…</p> : keys.length === 0 ? <p className="chat-muted">You have no live general API key with the MCP surface. Create one in Settings → API keys with the read grants this agent needs, then come back.</p> : <ul className="chat-link-keys">
        {keys.map((key) => <li key={key.id} className={`security-card${link?.keyId === key.id ? " chat-link-key-active" : ""}`}>
          <div className="chat-link-key-text">
            <strong>{key.name}</strong>
            <small><code>{key.prefix}…</code>{key.expiresAt ? ` · expires ${new Date(key.expiresAt).toLocaleDateString()}` : ""}{key.state === "grace" ? " · rotating" : ""}</small>
            <small className="chat-link-grants">{grantSummary(key.grants)}</small>
          </div>
          {link?.keyId === key.id ? <span className="ai-badge">Linked</span> : <button type="button" className="primary-button" onClick={() => { void choose(key.id); }} disabled={busy}>Link</button>}
        </li>)}
      </ul>}
      <footer className="file-dialog-actions">
        {onOpenKeys && <button type="button" className="secondary-button" onClick={onOpenKeys}>Manage API keys</button>}
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Done</button>
      </footer>
    </div>
  </ModalDialog>;
}
