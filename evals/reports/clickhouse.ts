/**
 * The eval's own ClickHouse access (seeding only): plain HTTP to the operator's ClickHouse with the
 * URL's user and password. Nook's guard is never involved here; generation reads the seeded tables
 * through a normal data source like any report.
 */

export type ChUrl = { base: string; user: string; password: string };

/** `http://user:password@host:port` (or CLICKHOUSE_TEST_USER / CLICKHOUSE_TEST_PASSWORD) as its parts. */
export function parseChUrl(raw: string): ChUrl {
  const url = new URL(raw);
  const user = process.env.CLICKHOUSE_TEST_USER ?? (url.username ? decodeURIComponent(url.username) : "default");
  const password = process.env.CLICKHOUSE_TEST_PASSWORD ?? (url.password ? decodeURIComponent(url.password) : "");
  return { base: `${url.protocol}//${url.host}/`, user, password };
}

/** Runs one statement; returns the TSV body. Throws with ClickHouse's message. */
export async function chExec(ch: ChUrl, sql: string, format = "TabSeparated"): Promise<string> {
  const url = new URL(ch.base);
  url.searchParams.set("default_format", format);
  const response = await fetch(url, { method: "POST", body: sql, headers: { Authorization: `Basic ${Buffer.from(`${ch.user}:${ch.password}`).toString("base64")}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse: ${text.slice(0, 400)}`);
  return text;
}

/** The statements of a seed script: split on `;` at a line end; `--` comment lines dropped. */
export function seedStatements(script: string): string[] {
  return script.split(/;\s*\n/).map((part) => part.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n").trim().replace(/;$/, "")).filter(Boolean);
}

/** Runs a case's seed script (it drops and recreates its own `eval_<case>` database). */
export async function seed(ch: ChUrl, script: string): Promise<number> {
  const statements = seedStatements(script);
  for (const statement of statements) await chExec(ch, statement);
  return statements.length;
}
