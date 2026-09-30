/**
 * The Vault's shared limits, shapes, and pure checks (vault plan §5, §6, D222, D227, D228), used by
 * the server's validation and the client's forms. No imports, so client tests load it directly.
 */

export const VAULT_BOUNDS = {
  vaultName: 80,
  description: 500,
  envName: 40,
  slug: 32,
  secretName: 128,
  tag: 32,
  tags: 10,
  environments: 20,
  secretsPerVault: 1000,
  ownedVaults: 100,
  /** Plaintext bytes (UTF-8). */
  valueBytes: 64 * 1024,
  commentBytes: 2 * 1024,
  versionsKept: 20,
  revealBatch: 100,
  applyBatch: 20,
  /** People per vault (D227); groups are bounded separately (20). */
  members: 50,
  /** Entries per import (D227, §6.4) and the largest file the client reads (1 MiB). */
  importEntries: 500,
  importFileBytes: 1024 * 1024,
  secretsPage: 200
} as const;

/** `dev`, `staging`, `prod-eu`: lowercase letters, digits, and hyphens, starting with a letter or digit. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const SECRET_TYPES = ["value", "login", "note"] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export const ENV_LEVELS = ["none", "read", "write", "admin"] as const;
export type EnvLevel = (typeof ENV_LEVELS)[number];

/** The environments of a new vault (§6.3, V-O2): prod is marked protected for the Wave 26 re-auth window. */
export const DEFAULT_ENVIRONMENTS: ReadonlyArray<{ slug: string; name: string; protected: boolean }> = [
  { slug: "dev", name: "Development", protected: false },
  { slug: "staging", name: "Staging", protected: false },
  { slug: "prod", name: "Production", protected: true }
];

/** C0 and C1 controls and bidi overrides, which never belong in a name or tag. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const hasControlChars = (value: string) => CONTROL.test(value);

/** A tag: 1–32 characters, no spaces, commas, or controls. */
export const isTag = (value: string) => value.length >= 1 && value.length <= VAULT_BOUNDS.tag && !/[\s,]/.test(value) && !hasControlChars(value);

export const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/** A `login` secret's value (D228): three fields, stored as one encrypted JSON string. */
export type LoginValue = { username: string; password: string; url: string };

export function parseLoginValue(value: string): LoginValue | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["username", "password", "url"].includes(key))) return null;
    const field = (name: string) => record[name] === undefined ? "" : record[name];
    const [username, password, url] = [field("username"), field("password"), field("url")];
    if (typeof username !== "string" || typeof password !== "string" || typeof url !== "string") return null;
    return { username, password, url };
  } catch {
    return null;
  }
}

export const formatLoginValue = (login: LoginValue) => JSON.stringify({ username: login.username, password: login.password, url: login.url });

/** What the list shows per environment: never a value (§6.2). */
export type CellStatus = "set" | "empty" | "no-access";
