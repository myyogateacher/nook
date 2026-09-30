import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "../db";
import { keyContainerIds } from "../keyResources";
import { hasScope } from "../mcpScopes";
import type { McpKeyContext } from "../mcpToolKit";
import { PROPOSAL_KINDS } from "./kinds";
import { ROUTINE_LIMIT, routineProtocol } from "./routines";

/**
 * Routines as MCP prompts (agent inbox O7, Wave 22): each enabled routine this key may run is the
 * prompt `routine.<slug>`, so a person can run it by hand from any MCP client (Claude Desktop's
 * prompt picker). The prompt is the fixed run protocol followed by the user's own instructions.
 * Registered per request, like the tools, only for keys with inbox:read, and read fresh from the
 * database when the prompt is fetched.
 */

type PromptRow = { id: string; name: string; instructions: string; output_kinds: string; max_proposals: number };

/** "Weekly review" → "weekly-review"; names that slug to nothing, or collide, get the id's first block. */
export function routineSlug(name: string, id: string, taken: Set<string>) {
  const base = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  let slug = base || id.slice(0, 8);
  if (taken.has(slug)) slug = `${slug}-${id.slice(0, 8)}`;
  taken.add(slug);
  return slug;
}

const visible = `SELECT id, name, instructions, output_kinds, max_proposals FROM routines
  WHERE owner_id = $userId AND (key_id IS NULL OR key_id = $keyId) AND enabled = 1`;

export function registerRoutinePrompts(server: McpServer, key: McpKeyContext) {
  if (!hasScope(key.scopes, "inbox:read")) return;
  // A key limited to chosen routines (Wave 34) is offered only those.
  const chosen = keyContainerIds(key, "inbox:read", "routine");
  const rows = (db.query(`${visible} ORDER BY name_fold LIMIT $limit`).all({ userId: key.userId, keyId: key.keyId, limit: ROUTINE_LIMIT }) as PromptRow[])
    .filter((row) => chosen === null || chosen.includes(row.id));
  const taken = new Set<string>();
  for (const row of rows) {
    server.registerPrompt(`routine.${routineSlug(row.name, row.id, taken)}`, {
      title: row.name,
      description: `Run the Nook routine “${row.name}”: start a run, suggest changes for the user to approve, and finish the run.`
    }, () => {
      const current = db.query(`${visible} AND id = $id`).get({ userId: key.userId, keyId: key.keyId, id: row.id }) as PromptRow | null;
      if (!current) return { messages: [{ role: "user" as const, content: { type: "text" as const, text: "This routine is no longer available." } }] };
      const kinds = (JSON.parse(current.output_kinds) as string[]).filter((kind) => (PROPOSAL_KINDS as readonly string[]).includes(kind));
      const text = `${routineProtocol({ ...current, outputKinds: kinds })}\n\n${current.instructions}`;
      return { description: current.name, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
    });
  }
}
