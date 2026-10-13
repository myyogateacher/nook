/**
 * Data source allowlists (D413): what an admin lets reports read, as `db.table` globs. `*` matches
 * any run of characters, `?` one character; a pattern without a dot is a whole database (`analytics`
 * is `analytics.*`). Names are case-sensitive, as ClickHouse's are. The `system` and
 * `information_schema` databases can never be allowlisted: the metadata class reaches the few system
 * tables it needs on its own terms (sqlGuard.ts), filtered to this allowlist.
 *
 * Pure: no database or network, so the guard, the catalog, and the tests share it.
 */

export const ALLOWLIST_PATTERN = /^[A-Za-z0-9_*?]{1,128}(\.[A-Za-z0-9_*?]{1,128})?$/;
const RESERVED_DATABASES = /^(system|information_schema)$/i;

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

/** One pattern in canonical form (`db.table`), or an AllowlistError saying what is wrong with it. */
export function normalizePattern(raw: string): string {
  const value = raw.trim();
  if (!ALLOWLIST_PATTERN.test(value)) throw new AllowlistError(`"${value.slice(0, 60)}" is not a database or db.table pattern (letters, digits, _, * and ? only)`);
  const pattern = value.includes(".") ? value : `${value}.*`;
  const db = pattern.slice(0, pattern.indexOf("."));
  // A database glob that could match a reserved database (`*`, `s*`, `?ystem`) is refused too.
  if (["system", "information_schema", "INFORMATION_SCHEMA"].some((name) => globMatches(db, name))) throw new AllowlistError(`"${value.slice(0, 60)}" would include the ${RESERVED_DATABASES.test(db) ? db : "system"} database, which reports never read directly`);
  return pattern;
}

/** Every pattern in canonical form, de-duplicated, in the order given. */
export function normalizeAllowlist(raw: readonly string[]): string[] {
  return [...new Set(raw.map(normalizePattern))];
}

const cache = new Map<string, RegExp>();
function globRegExp(glob: string): RegExp {
  let compiled = cache.get(glob);
  if (!compiled) {
    compiled = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s");
    if (cache.size > 2000) cache.clear();
    cache.set(glob, compiled);
  }
  return compiled;
}

export const globMatches = (glob: string, value: string) => globRegExp(glob).test(value);

const split = (pattern: string) => {
  const dot = pattern.indexOf(".");
  return { db: pattern.slice(0, dot), table: pattern.slice(dot + 1) };
};

/** Whether `db.table` is allowlisted. */
export function tableAllowed(patterns: readonly string[], db: string, table: string): boolean {
  if (RESERVED_DATABASES.test(db)) return false;
  return patterns.some((pattern) => {
    const parts = split(pattern);
    return globMatches(parts.db, db) && globMatches(parts.table, table);
  });
}

/** Whether any allowlisted table could live in `db` (SHOW DATABASES, SHOW TABLES FROM db). */
export function databaseAllowed(patterns: readonly string[], db: string): boolean {
  if (RESERVED_DATABASES.test(db)) return false;
  return patterns.some((pattern) => globMatches(split(pattern).db, db));
}

/**
 * The allowlist as one RE2 pattern over `database || '.' || table`, for filtering the system tables
 * inside ClickHouse (sqlGuard's metadata class). `(?!)` matches nothing (an empty allowlist).
 */
export function clickhouseRegex(patterns: readonly string[]): string {
  if (!patterns.length) return "^(?!)$";
  const toRe2 = (glob: string) => glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return `^(?:${patterns.map((pattern) => {
    const parts = split(pattern);
    return `${toRe2(parts.db)}\\.${toRe2(parts.table)}`;
  }).join("|")})$`;
}
