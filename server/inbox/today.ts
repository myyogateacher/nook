import { db } from "../db";
import { page, registerTodayProvider, TODAY_FETCH } from "../today/registry";
import { PROPOSAL_KIND_DEFS, type ProposalKind } from "./kinds";

/**
 * Today → "Proposals awaiting you" (agent inbox D158): the owner's newest pending proposals, ten
 * plus `more` from the eleven-row fetch, never a COUNT (T51). Titles and the kind only. For an MCP
 * key (get_today with inbox:read) only that key's own proposals are listed (T131). It replaces the
 * retired "Drafts from agents" section: MCP drafts are note_draft proposals now (D149).
 */
registerTodayProvider("proposals", {
  mcpScope: "inbox:read",
  href: "/inbox",
  load: ({ userId, scopes, keyId }) => {
    // A key without an id (never in practice) sees nothing rather than every key's proposals.
    const forKey = scopes !== undefined;
    const rows = db.query(`SELECT id, kind, title, key_name AS keyName, created_at, expires_at FROM proposals
        WHERE owner_id = $userId AND status = 'pending' AND ($forKey = 0 OR key_id = $keyId)
        ORDER BY created_at DESC, rowid DESC LIMIT $limit`)
      .all({ userId, forKey: forKey ? 1 : 0, keyId: keyId ?? "", limit: TODAY_FETCH }) as Array<{ id: string; kind: ProposalKind; title: string; keyName: string; created_at: string; expires_at: string }>;
    return page(rows.map((row) => ({ ...row, kindLabel: PROPOSAL_KIND_DEFS[row.kind].label })));
  }
});
