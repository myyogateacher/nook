import { z } from "zod";
import { SECTION_LIMITS, type ReportBlock, type ReportQuery, type ReportSection, type ReportSpec } from "../../shared/reports";
import { BLOCK_JSON_SCHEMA, SECTION_JSON_SCHEMA } from "./specValidate";
import { INSTRUCTION_LIMITS, type BlockChange, type PatchOp, type QueryChange, type ReportPatch } from "../../shared/reportsEdit";

/**
 * Patches to a report spec (plan wave 48, D451): the edit agent's `submit_patch` and the owner's manual
 * edits. Ops work on whole block objects: `add_block` inserts the object as given, `update_block` merges
 * a partial into the block; this file names no block fields, so it follows the vocabulary as it grows.
 * A patch is applied to a copy; the whole result is then checked like a submitted spec (specValidate.ts:
 * a strict shape, references, guard, execution, columns), and only the validated spec is proposed or
 * saved (review H1: a field the vocabulary does not name is refused). Provenance is Nook's: a patch can
 * neither set nor clear it.
 *
 * Spec v2 (wave 48b): section ops add, change, and remove the spec's sections; `move_block` can also
 * put a block into a section (or take it out with `section: null`). Removing a section takes its
 * blocks out of it (they stay, in the untitled section).
 */

const objectArg = z.record(z.string(), z.unknown());
const blockArg = objectArg.refine((value) => typeof value.id === "string" && typeof value.type === "string", "a block needs a string id and type");
const name = z.string().min(1).max(64);
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_block"), block: blockArg, after: name.nullish() }),
  z.object({ op: z.literal("update_block"), id: name, set: objectArg.optional(), unset: z.array(z.string().max(64)).max(40).optional() }),
  z.object({ op: z.literal("remove_block"), id: name }),
  z.object({ op: z.literal("move_block"), id: name, after: name.nullable(), section: name.nullish() }),
  z.object({ op: z.literal("add_query"), query: z.object({ key: name, sql: z.string().min(1).max(20_000), purpose: z.string().max(300).optional() }) }),
  z.object({ op: z.literal("update_query"), key: name, sql: z.string().min(1).max(20_000).optional(), purpose: z.string().max(300).optional() }),
  z.object({ op: z.literal("remove_query"), key: name }),
  z.object({ op: z.literal("add_section"), section: z.object({ id: name, title: z.string().min(1).max(SECTION_LIMITS.title), summary: z.string().max(SECTION_LIMITS.summary).optional() }), after: name.nullish() }),
  z.object({ op: z.literal("update_section"), id: name, set: z.object({ title: z.string().min(1).max(SECTION_LIMITS.title).optional(), summary: z.string().max(SECTION_LIMITS.summary).nullable().optional() }) }),
  z.object({ op: z.literal("remove_section"), id: name })
]);
export const patchSchema = z.object({ ops: z.array(opSchema).min(1).max(INSTRUCTION_LIMITS.ops), summary: z.string().max(INSTRUCTION_LIMITS.summary).optional() });

/** update_block's `set`: any v2 block field (none required; no field outside the vocabulary). */
const BLOCK_SET_JSON_SCHEMA: Record<string, unknown> = (() => {
  const properties: Record<string, unknown> = {};
  for (const option of BLOCK_JSON_SCHEMA.anyOf as Array<{ properties: Record<string, unknown> }>) {
    for (const [key, value] of Object.entries(option.properties)) if (key !== "id" && key !== "type" && !(key in properties)) properties[key] = value;
  }
  return { type: "object", additionalProperties: false, description: "Fields to set (a new type replaces the block)", properties: { type: { enum: ["markdown", "kpi", "chart", "table"] }, ...properties } };
})();

/** submit_patch's parameters as JSON Schema: blocks and sections in spec v2's vocabulary (no colours, sizes, CSS, or formatters). */
export const PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ops"],
  properties: {
    summary: { type: "string", maxLength: INSTRUCTION_LIMITS.summary, description: "One line: what the patch changes" },
    ops: {
      type: "array", minItems: 1, maxItems: INSTRUCTION_LIMITS.ops,
      items: {
        anyOf: [
          { type: "object", additionalProperties: false, required: ["op", "block"], properties: { op: { const: "add_block" }, block: BLOCK_JSON_SCHEMA, after: { type: ["string", "null"], description: "The block id to insert after; null for the top" } } },
          { type: "object", additionalProperties: false, required: ["op", "id"], properties: { op: { const: "update_block" }, id: { type: "string" }, set: BLOCK_SET_JSON_SCHEMA, unset: { type: "array", items: { type: "string" } } } },
          { type: "object", additionalProperties: false, required: ["op", "id"], properties: { op: { const: "remove_block" }, id: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["op", "id", "after"], properties: { op: { const: "move_block" }, id: { type: "string" }, after: { type: ["string", "null"] }, section: { type: ["string", "null"], description: "Put the block in this section (null: out of any section)" } } },
          { type: "object", additionalProperties: false, required: ["op", "query"], properties: { op: { const: "add_query" }, query: { type: "object", additionalProperties: false, required: ["key", "sql", "purpose"], properties: { key: { type: "string" }, sql: { type: "string" }, purpose: { type: "string" } } } } },
          { type: "object", additionalProperties: false, required: ["op", "key"], properties: { op: { const: "update_query" }, key: { type: "string" }, sql: { type: "string" }, purpose: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["op", "key"], properties: { op: { const: "remove_query" }, key: { type: "string" } } },
          { type: "object", additionalProperties: false, required: ["op", "section"], properties: { op: { const: "add_section" }, section: SECTION_JSON_SCHEMA, after: { type: ["string", "null"], description: "The section id to insert after; null for the first" } } },
          { type: "object", additionalProperties: false, required: ["op", "id", "set"], properties: { op: { const: "update_section" }, id: { type: "string" }, set: { type: "object", additionalProperties: false, properties: { title: { type: "string", maxLength: SECTION_LIMITS.title }, summary: { type: ["string", "null"], maxLength: SECTION_LIMITS.summary } } } } },
          { type: "object", additionalProperties: false, required: ["op", "id"], properties: { op: { const: "remove_section" }, id: { type: "string" } } }
        ]
      }
    }
  }
};

export type PatchParse = { ok: true; patch: ReportPatch } | { ok: false; errors: string[] };

export function parsePatch(raw: unknown): PatchParse {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "patch"}: ${issue.message}`) };
  return { ok: true, patch: parsed.data as ReportPatch };
}

/** Fields a patch never sets or clears on a block. */
const RESERVED = new Set(["id", "provenance"]);
const clean = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key)));

export type PatchResult = { ok: true; spec: ReportSpec } | { ok: false; errors: string[] };

/**
 * Applies a patch to a copy of `spec`. `author` stamps the createdBy of added or changed queries.
 * Errors name the op ("op 2 (update_block): no block with id x"); the first failing op stops the patch.
 */
export function applyPatch(spec: ReportSpec, patch: ReportPatch, author: ReportQuery["createdBy"]): PatchResult {
  const next = structuredClone(spec) as ReportSpec;
  next.sections = next.sections ?? [];
  const sections: ReportSection[] = next.sections;
  const sectionAt = (id: string) => sections.findIndex((section) => section.id === id);
  const blocks = next.blocks as Array<ReportBlock & Record<string, unknown>>;
  const indexOf = (id: string) => blocks.findIndex((block) => block.id === id);
  const insertAt = (after: string | null | undefined): number | string => {
    if (after === null || after === undefined) return 0;
    const at = indexOf(after);
    return at < 0 ? `no block with id ${after} to insert after` : at + 1;
  };
  for (const [index, op] of patch.ops.entries()) {
    const fail = (message: string): PatchResult => ({ ok: false, errors: [`op ${index + 1} (${op.op}): ${message}`] });
    switch (op.op) {
      case "add_block": {
        const block = { ...clean(op.block), id: op.block.id } as ReportBlock & Record<string, unknown>;
        if (indexOf(block.id) >= 0) return fail(`a block with id ${block.id} already exists; choose another id or use update_block`);
        const at = insertAt(op.after);
        if (typeof at === "string") return fail(at);
        blocks.splice(at, 0, block);
        break;
      }
      case "update_block": {
        const at = indexOf(op.id);
        if (at < 0) return fail(`no block with id ${op.id}`);
        const old = blocks[at]!;
        const set = clean(op.set ?? {});
        // A new type is a new block in the same place: nothing of the old type's fields is kept.
        let merged: Record<string, unknown> = typeof set.type === "string" && set.type !== old.type ? { id: old.id, ...set } : { ...old, ...set };
        for (const field of op.unset ?? []) if (!RESERVED.has(field) && field !== "type") delete merged[field];
        if (old.provenance) merged = { ...merged, provenance: old.provenance };
        blocks[at] = merged as ReportBlock & Record<string, unknown>;
        break;
      }
      case "remove_block": {
        const at = indexOf(op.id);
        if (at < 0) return fail(`no block with id ${op.id}`);
        blocks.splice(at, 1);
        break;
      }
      case "move_block": {
        const at = indexOf(op.id);
        if (at < 0) return fail(`no block with id ${op.id}`);
        if (op.after === op.id) return fail("a block cannot move after itself");
        if (op.section && sectionAt(op.section) < 0) return fail(`no section with id ${op.section}; add_section first`);
        const [block] = blocks.splice(at, 1);
        const target = insertAt(op.after);
        if (typeof target === "string") return fail(target);
        let moved = block!;
        if (op.section) moved = { ...moved, section: op.section };
        else if (op.section === null) {
          const { section: _section, ...rest } = moved;
          moved = rest as typeof moved;
        }
        blocks.splice(target, 0, moved);
        break;
      }
      case "add_query": {
        if (next.queries.some((query) => query.key === op.query.key)) return fail(`a query with key ${op.query.key} already exists; use update_query`);
        next.queries.push({ key: op.query.key, sql: op.query.sql, purpose: op.query.purpose ?? "", createdBy: author });
        break;
      }
      case "update_query": {
        const query = next.queries.find((item) => item.key === op.key);
        if (!query) return fail(`no query with key ${op.key}`);
        if (op.sql === undefined && op.purpose === undefined) return fail("give sql or purpose");
        if (op.sql !== undefined && op.sql !== query.sql) { query.sql = op.sql; query.createdBy = author; }
        if (op.purpose !== undefined) query.purpose = op.purpose;
        break;
      }
      case "remove_query": {
        const at = next.queries.findIndex((item) => item.key === op.key);
        if (at < 0) return fail(`no query with key ${op.key}`);
        next.queries.splice(at, 1);
        break;
      }
      case "add_section": {
        if (sectionAt(op.section.id) >= 0) return fail(`a section with id ${op.section.id} already exists; use update_section`);
        if (sections.length >= SECTION_LIMITS.sections) return fail(`a report has at most ${SECTION_LIMITS.sections} sections`);
        let at = 0;
        if (op.after) {
          const found = sectionAt(op.after);
          if (found < 0) return fail(`no section with id ${op.after} to insert after`);
          at = found + 1;
        }
        sections.splice(at, 0, { id: op.section.id, title: op.section.title, ...(op.section.summary ? { summary: op.section.summary } : {}) });
        break;
      }
      case "update_section": {
        const at = sectionAt(op.id);
        if (at < 0) return fail(`no section with id ${op.id}`);
        const section = { ...sections[at]! };
        if (op.set.title !== undefined) section.title = op.set.title;
        if (op.set.summary === null || op.set.summary === "") delete section.summary;
        else if (op.set.summary !== undefined) section.summary = op.set.summary;
        sections[at] = section;
        break;
      }
      case "remove_section": {
        const at = sectionAt(op.id);
        if (at < 0) return fail(`no section with id ${op.id}`);
        sections.splice(at, 1);
        // Its blocks stay, out of any section.
        for (const [index, block] of blocks.entries()) {
          if (block.section !== op.id) continue;
          const { section: _section, ...rest } = block;
          blocks[index] = rest as typeof block;
        }
        break;
      }
    }
  }
  return { ok: true, spec: next };
}

/** Drops queries no block uses (manual removals; the agent must remove its own). */
export function withoutUnusedQueries(spec: ReportSpec): ReportSpec {
  const used = new Set(spec.blocks.flatMap((block) => "queryKey" in block && typeof block.queryKey === "string" ? [block.queryKey] : []));
  return { ...spec, queries: spec.queries.filter((query) => used.has(query.key)) };
}

/** The blocks that kept their relative order (a longest increasing run of old positions); the rest moved. */
function unmovedIds(before: string[], after: string[]): Set<string> {
  const position = new Map(before.map((id, index) => [id, index]));
  const sequence = after.map((id) => position.get(id)!);
  const tails: number[] = [];
  const tailAt: number[] = [];
  const previous = new Array<number>(sequence.length).fill(-1);
  sequence.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailAt[low] = index;
    previous[index] = low > 0 ? tailAt[low - 1]! : -1;
  });
  const kept = new Set<string>();
  for (let index = tails.length ? tailAt[tails.length - 1]! : -1; index >= 0; index = previous[index]!) kept.add(after[index]!);
  return kept;
}

/** JSON with object keys sorted, so a validated copy (keys in the schema's order) compares equal to its source. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** A block's content for comparison: without Nook's own fields (provenance, the recomputed auto-fixes, the v1 marker). */
const withoutProvenance = (block: ReportBlock) => {
  const { provenance: _provenance, autoFixes: _autoFixes, legacy: _legacy, ...rest } = block as ReportBlock & Record<string, unknown>;
  return stableJson(rest);
};

/** Whether two specs' sections differ (ids, order, titles, or summaries). */
export const sectionsChanged = (before: ReportSpec, after: ReportSpec) => stableJson(before.sections ?? []) !== stableJson(after.sections ?? []);

/** What a patch changed: blocks added, updated (content or the SQL of their query), removed, or moved; queries added, updated, removed. */
export function diffSpecs(before: ReportSpec, after: ReportSpec): { blocks: BlockChange[]; queries: QueryChange[] } {
  const queries: QueryChange[] = [];
  const oldQueries = new Map(before.queries.map((query) => [query.key, query]));
  const newQueries = new Map(after.queries.map((query) => [query.key, query]));
  for (const query of after.queries) {
    const old = oldQueries.get(query.key);
    if (!old) queries.push({ key: query.key, change: "added", before: null, after: query.sql });
    else if (old.sql !== query.sql) queries.push({ key: query.key, change: "updated", before: old.sql, after: query.sql });
  }
  for (const query of before.queries) if (!newQueries.has(query.key)) queries.push({ key: query.key, change: "removed", before: query.sql, after: null });
  const changedKeys = new Set(queries.filter((item) => item.change !== "removed").map((item) => item.key));

  const blocks: BlockChange[] = [];
  const oldBlocks = new Map(before.blocks.map((block) => [block.id, block]));
  const newIds = new Set(after.blocks.map((block) => block.id));
  const stayed = unmovedIds(before.blocks.filter((block) => newIds.has(block.id)).map((block) => block.id), after.blocks.filter((block) => oldBlocks.has(block.id)).map((block) => block.id));
  for (const block of after.blocks) {
    const old = oldBlocks.get(block.id);
    const queryKey = "queryKey" in block && typeof block.queryKey === "string" ? block.queryKey : null;
    if (!old) blocks.push({ blockId: block.id, change: "added", before: null, after: block });
    else if (withoutProvenance(old) !== withoutProvenance(block) || (queryKey && changedKeys.has(queryKey))) blocks.push({ blockId: block.id, change: "updated", before: old, after: block });
    else if (!stayed.has(block.id)) blocks.push({ blockId: block.id, change: "moved", before: old, after: block });
  }
  for (const block of before.blocks) if (!newIds.has(block.id)) blocks.push({ blockId: block.id, change: "removed", before: block, after: null });
  return { blocks, queries };
}

/** The blocks a change adds or changes (what the design rules check on an edit, D437). */
export const changedBlockIds = (diff: { blocks: BlockChange[] }) => diff.blocks.filter((item) => item.change === "added" || item.change === "updated").map((item) => item.blockId);

/** The queries whose results a change needs: added, or with new SQL. */
export const changedQueryKeys = (diff: { queries: QueryChange[] }) => new Set(diff.queries.filter((item) => item.change !== "removed").map((item) => item.key));

/** The ops a patch carries, as one short line for the audit log (never SQL or text). */
export const opsSummary = (ops: readonly PatchOp[]) => ops.map((op) => op.op).join(",").slice(0, 200);
