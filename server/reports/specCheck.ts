import { createHash } from "node:crypto";
import type { ReportBlock, ReportQuery, ReportSpec } from "../../shared/reports";
import { allowlistOf, type DatasourceRow } from "./datasources";
import { ReportError } from "./errors";
import { checkSpecShape, specSchema } from "./specValidate";
import { assertTablesAllowed, classify, GuardError } from "./sqlGuard";

/**
 * Wave 48 review fixes around specValidate (H1, H2): what a spec looks like to the validator (no
 * provenance, no createdBy), what is saved (the validated spec with Nook's provenance and authors put
 * back by id and key), the static re-check before Apply and restore, and a projection that drops any
 * block field the vocabulary does not name (for specs saved before the schema was strict).
 */

/** The spec as the validator takes it: blocks without provenance, queries without createdBy. */
export function forValidation(spec: ReportSpec): unknown {
  return {
    version: spec.version,
    specVersion: spec.specVersion,
    sections: spec.sections,
    parameters: spec.parameters ?? [],
    queries: spec.queries.map(({ key, sql, purpose }) => ({ key, sql, purpose })),
    blocks: spec.blocks.map((block) => {
      const { provenance: _provenance, ...rest } = block as ReportBlock & Record<string, unknown>;
      return rest;
    })
  };
}

/** The validated spec with the provenance (by block id) and authors (by query key) of `source` put back. */
export function reattach(validated: ReportSpec, source: ReportSpec): ReportSpec {
  const provenance = new Map(source.blocks.map((block) => [block.id, block.provenance]));
  const authors = new Map(source.queries.map((query) => [query.key, query.createdBy]));
  return {
    version: 1,
    specVersion: 3,
    sections: validated.sections,
    parameters: validated.parameters ?? [],
    queries: validated.queries.map((query): ReportQuery => ({ ...query, createdBy: authors.get(query.key) ?? "agent" })),
    blocks: validated.blocks.map((block) => {
      const stamped = provenance.get(block.id);
      return stamped ? { ...block, provenance: stamped } : block;
    })
  };
}

/** The block fields each type may have, read off the validator's own schema (so a later spec version's fields follow). */
function knownFields(): Map<string, Set<string>> {
  const fields = new Map<string, Set<string>>();
  const union = specSchema.shape.blocks.element as unknown as { options: Array<{ shape: Record<string, { value?: unknown; def?: { values?: unknown[] } }> }> };
  for (const option of union.options) {
    const literal = option.shape.type;
    const type = literal?.value ?? literal?.def?.values?.[0];
    if (typeof type === "string") fields.set(type, new Set([...Object.keys(option.shape), "provenance"]));
  }
  return fields;
}

/** The spec with only the block fields the vocabulary names (a spec saved before the schema was strict may hold others). */
export function knownSpec(spec: ReportSpec): ReportSpec {
  const fields = knownFields();
  return {
    ...spec,
    blocks: spec.blocks.map((block) => {
      const allowed = fields.get(block.type);
      if (!allowed) return block;
      return Object.fromEntries(Object.entries(block).filter(([key]) => allowed.has(key))) as ReportBlock;
    })
  };
}

export const specHash = (specJson: string) => createHash("sha256").update(specJson).digest("hex");

/**
 * The static re-check before Apply and restore (review H2, TOCTOU): the spec's shape and references,
 * and every query through the guard's classifier as a SELECT whose tables are on the data source's
 * allowlist now. Throws 409 `code` naming the first problem.
 */
export function assertRunnableNow(datasource: DatasourceRow, spec: ReportSpec, code: string) {
  const shape = checkSpecShape(forValidation(spec));
  if (!shape.ok) throw new ReportError(409, code, `The spec no longer passes the checks: ${shape.errors[0] ?? "invalid"}`, { details: shape.errors });
  const allowlist = allowlistOf(datasource);
  for (const query of spec.queries) {
    try {
      const classified = classify(query.sql, { params: true });
      if (classified.class !== "select") throw new GuardError("NOT_SELECT", "Only a SELECT can be saved in a report");
      assertTablesAllowed(classified.tables, allowlist, datasource.database);
    } catch (error) {
      if (!(error instanceof GuardError)) throw error;
      throw new ReportError(409, code, `Query ${query.key} is no longer allowed: ${error.message}`, { guard: error.code, queryKey: query.key });
    }
  }
}
