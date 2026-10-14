import { timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseEntry } from "./ipRanges";

function integerEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const port = Number(process.env.PORT ?? 2026);
const dataDir = resolve(process.env.DATA_DIR ?? "/data");
const appOrigin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
const appOrigins = new Set(
  (process.env.APP_ORIGINS ?? appOrigin)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const url = new URL(value);
      if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new Error("APP_ORIGINS entries must be exact http(s) origins without paths, credentials, queries, or fragments");
      }
      return url.origin;
    })
);
if (!appOrigins.size) throw new Error("APP_ORIGINS must contain at least one origin");
const allowedEmails = new Set(
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const totpPolicyValue = process.env.TOTP_POLICY ?? "optional";
if (!(["optional", "required"] as const).includes(totpPolicyValue as "optional" | "required")) {
  throw new Error("TOTP_POLICY must be either optional or required");
}
const totpPolicy = totpPolicyValue as "optional" | "required";
// D80: the team role of accounts registered after the first (the first is always admin, D76).
// Never admin: promoting to admin needs an admin and re-authentication (Team plan §5.5).
const signupRoleValue = process.env.SIGNUP_ROLE?.trim() || "guest";
if (!(["guest", "viewer", "member"] as const).includes(signupRoleValue as "guest")) {
  throw new Error("SIGNUP_ROLE must be guest, viewer, or member");
}
const signupRole = signupRoleValue as "guest" | "viewer" | "member";
const cookieSecureValue = process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === "production" ? "true" : "false");
if (!(cookieSecureValue === "true" || cookieSecureValue === "false")) throw new Error("COOKIE_SECURE must be true or false");
const totpEncryptionKeyValue = process.env.TOTP_ENCRYPTION_KEY ?? "";
const totpEncryptionKey = totpEncryptionKeyValue ? Buffer.from(totpEncryptionKeyValue, "base64") : null;
if (totpEncryptionKey && totpEncryptionKey.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
if (totpPolicy === "required" && !totpEncryptionKey) throw new Error("TOTP_ENCRYPTION_KEY is required when TOTP_POLICY=required");

// The Vault (Wave 25, D212): its own key-encryption key, base64 of 32 bytes, from VAULT_ENCRYPTION_KEY or
// a file (VAULT_ENCRYPTION_KEY_FILE, for Docker secrets). Unset: the vault module is off, not broken.
// A malformed key, both variables at once, or a key equal to TOTP_ENCRYPTION_KEY refuses to start:
// one leaked key must never open both second factors and secrets. Never logged.
export function parseVaultKey(env: Record<string, string | undefined>, totpKey: Buffer | null, dataRoot: string | null = null): { key: Buffer | null; source: "env" | "file" | null } {
  const inline = env.VAULT_ENCRYPTION_KEY?.trim() ?? "";
  const file = env.VAULT_ENCRYPTION_KEY_FILE?.trim() ?? "";
  if (inline && file) throw new Error("Set VAULT_ENCRYPTION_KEY or VAULT_ENCRYPTION_KEY_FILE, not both");
  let raw = inline;
  if (file) {
    if (!file.startsWith("/")) throw new Error("VAULT_ENCRYPTION_KEY_FILE must be an absolute path");
    // T180: scripts/backup.sh archives the data directory, so a key file inside it would travel with
    // every backup, which is exactly the combination that opens every secret.
    const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
    if (dataRoot && `${real(file)}/`.startsWith(`${real(dataRoot)}/`)) throw new Error("VAULT_ENCRYPTION_KEY_FILE must be outside DATA_DIR: backups archive the data directory");
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error("VAULT_ENCRYPTION_KEY_FILE could not be read");
    }
  }
  if (!raw) return { key: null, source: null };
  const key = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) throw new Error("VAULT_ENCRYPTION_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)");
  if (totpKey && timingSafeEqual(key, totpKey)) throw new Error("VAULT_ENCRYPTION_KEY must differ from TOTP_ENCRYPTION_KEY");
  return { key, source: file ? "file" : "env" };
}
const vaultKey = parseVaultKey(process.env, totpEncryptionKey, dataDir);

/**
 * Agent chat (Wave 40, D354): `AGENT_SECRETS_KEY` or `AGENT_SECRETS_KEY_FILE` seals provider API keys
 * and tool-server credentials. Same rules as the vault key (base64 of 32 bytes, a file outside
 * DATA_DIR, never both), and it must differ from both TOTP_ENCRYPTION_KEY and VAULT_ENCRYPTION_KEY
 * (one leaked key must never open every secret). Unset: the module is off, not broken. Never logged.
 */
export function parseAgentSecretsKey(env: Record<string, string | undefined>, totpKey: Buffer | null, vaultKeyBytes: Buffer | null, dataRoot: string | null = null): { key: Buffer | null; source: "env" | "file" | null } {
  const inline = env.AGENT_SECRETS_KEY?.trim() ?? "";
  const file = env.AGENT_SECRETS_KEY_FILE?.trim() ?? "";
  if (inline && file) throw new Error("Set AGENT_SECRETS_KEY or AGENT_SECRETS_KEY_FILE, not both");
  let raw = inline;
  if (file) {
    if (!file.startsWith("/")) throw new Error("AGENT_SECRETS_KEY_FILE must be an absolute path");
    const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
    if (dataRoot && `${real(file)}/`.startsWith(`${real(dataRoot)}/`)) throw new Error("AGENT_SECRETS_KEY_FILE must be outside DATA_DIR: backups archive the data directory");
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error("AGENT_SECRETS_KEY_FILE could not be read");
    }
  }
  if (!raw) return { key: null, source: null };
  const key = /^[A-Za-z0-9+/]{43}=$/.test(raw) ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) throw new Error("AGENT_SECRETS_KEY must be a base64-encoded 32-byte key (openssl rand -base64 32)");
  if (totpKey && timingSafeEqual(key, totpKey)) throw new Error("AGENT_SECRETS_KEY must differ from TOTP_ENCRYPTION_KEY");
  if (vaultKeyBytes && timingSafeEqual(key, vaultKeyBytes)) throw new Error("AGENT_SECRETS_KEY must differ from VAULT_ENCRYPTION_KEY");
  return { key, source: file ? "file" : "env" };
}
const agentSecretsKey = parseAgentSecretsKey(process.env, totpEncryptionKey, vaultKey.key, dataDir);

export type S3StorageConfig = {
  backend: "s3";
  bucket: string;
  /**
   * Always an explicit origin, so Bun's client never falls back to AWS_ENDPOINT or S3_ENDPOINT from the
   * environment (review L3): AWS S3 is https://s3.<region>.amazonaws.com; MinIO, R2, B2 give S3_ENDPOINT.
   */
  endpoint: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  /** "" or a key prefix ending in "/". */
  prefix: string;
  /** Deadline for one S3 request (S3_TIMEOUT_MS); a part upload gets four times this. */
  timeoutMs: number;
};
export type StorageConfig = { backend: "local" } | S3StorageConfig;

/** A secret from NAME or NAME_FILE (absolute, outside DATA_DIR, never both), like the other keys. "" when unset. */
function secretSetting(env: Record<string, string | undefined>, name: string, dataRoot: string | null) {
  const inline = env[name]?.trim() ?? "";
  const file = env[`${name}_FILE`]?.trim() ?? "";
  if (inline && file) throw new Error(`Set ${name} or ${name}_FILE, not both`);
  if (!file) return inline;
  if (!file.startsWith("/")) throw new Error(`${name}_FILE must be an absolute path`);
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (dataRoot && `${real(file)}/`.startsWith(`${real(dataRoot)}/`)) throw new Error(`${name}_FILE must be outside DATA_DIR: backups archive the data directory`);
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }
}

/**
 * A literal loopback host for S3_ENDPOINT over plain http (review L4): `localhost`, 127.0.0.0/8, or
 * [::1]. Unlike isLocalHost, `*.localhost` names do not count: they are only a browser convention, and a
 * resolver may send them anywhere.
 */
export function isLoopbackLiteral(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1";
}

/** Settings Bun's S3 client would read from the environment on its own; Nook never wants them (review L3). */
const S3_AMBIENT_SETTINGS = ["S3_SESSION_TOKEN", "AWS_SESSION_TOKEN"];

/**
 * File storage (S3 storage slice, docs/plan/research/2026-10-09-s3-storage.md): where file bytes live.
 * `STORAGE_BACKEND=local` (the default) keeps them under DATA_DIR as before; `s3` puts them in a bucket
 * through Bun's built-in S3 client. An incomplete or malformed S3 configuration refuses to start; the
 * credentials are never logged. SQLite (and its WAL) always stays in DATA_DIR.
 */
export function parseStorageConfig(env: Record<string, string | undefined>, dataRoot: string | null = null): StorageConfig {
  const backend = env.STORAGE_BACKEND?.trim().toLowerCase() || "local";
  if (backend !== "local" && backend !== "s3") throw new Error("STORAGE_BACKEND must be local or s3");
  if (backend === "local") return { backend: "local" };
  const allowHttp = env.S3_ALLOW_HTTP?.trim() || "false";
  if (allowHttp !== "true" && allowHttp !== "false") throw new Error("S3_ALLOW_HTTP must be true or false");
  const ambient = S3_AMBIENT_SETTINGS.filter((name) => env[name]?.trim());
  if (ambient.length) throw new Error(`Unset ${ambient.join(" and ")}: Bun's S3 client would send it with every request, and Nook uses only S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY`);
  const bucket = env.S3_BUCKET?.trim() ?? "";
  const endpointRaw = env.S3_ENDPOINT?.trim() ?? "";
  const region = env.S3_REGION?.trim() || null;
  const accessKeyId = secretSetting(env, "S3_ACCESS_KEY_ID", dataRoot);
  const secretAccessKey = secretSetting(env, "S3_SECRET_ACCESS_KEY", dataRoot);
  const missing = [
    bucket ? null : "S3_BUCKET",
    accessKeyId ? null : "S3_ACCESS_KEY_ID (or S3_ACCESS_KEY_ID_FILE)",
    secretAccessKey ? null : "S3_SECRET_ACCESS_KEY (or S3_SECRET_ACCESS_KEY_FILE)",
    region || endpointRaw ? null : "S3_REGION (or S3_ENDPOINT for an S3-compatible service)"
  ].filter(Boolean);
  if (missing.length) throw new Error(`STORAGE_BACKEND=s3 needs ${missing.join(", ")}`);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error("S3_BUCKET must be a bucket name: 3 to 63 lower-case letters, digits, dots, and hyphens");
  if (region && !/^[a-z0-9-]{1,40}$/.test(region)) throw new Error("S3_REGION must be a region name such as us-east-1 (or auto for R2)");
  if (/\s/.test(accessKeyId) || accessKeyId.length > 256) throw new Error("S3_ACCESS_KEY_ID must be a single token without spaces");
  if (/\s/.test(secretAccessKey) || secretAccessKey.length > 256) throw new Error("S3_SECRET_ACCESS_KEY must be a single token without spaces");
  let endpoint = `https://s3.${region}.amazonaws.com`;
  if (endpointRaw) {
    let url: URL;
    try {
      url = new URL(endpointRaw);
    } catch {
      throw new Error("S3_ENDPOINT must be an http(s) URL such as https://<account>.r2.cloudflarestorage.com");
    }
    if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("S3_ENDPOINT must be an http(s) origin without credentials, a path, a query, or a fragment");
    }
    // Plain http sends every file over the wire unencrypted: only to this machine, or when the operator says so.
    if (url.protocol === "http:" && !isLoopbackLiteral(url.hostname) && allowHttp !== "true") {
      throw new Error("S3_ENDPOINT must use https; set S3_ALLOW_HTTP=true only for a service on a private network you trust");
    }
    endpoint = url.origin;
  }
  const prefixRaw = env.S3_PREFIX?.trim() ?? "";
  if (prefixRaw && (!/^[A-Za-z0-9._/-]{1,200}$/.test(prefixRaw) || prefixRaw.startsWith("/") || prefixRaw.split("/").some((part) => part === "." || part === ".."))) {
    throw new Error("S3_PREFIX may hold letters, digits, dots, hyphens, underscores, and slashes (up to 200), must not start with / or contain . or .. segments");
  }
  const prefix = prefixRaw && !prefixRaw.endsWith("/") ? `${prefixRaw}/` : prefixRaw;
  const timeoutRaw = env.S3_TIMEOUT_MS?.trim() || "30000";
  const timeoutMs = /^\d{1,7}$/.test(timeoutRaw) ? Number(timeoutRaw) : Number.NaN;
  if (!(timeoutMs >= 1000 && timeoutMs <= 600_000)) throw new Error("S3_TIMEOUT_MS must be an integer from 1000 to 600000");
  return { backend: "s3", bucket, endpoint, region, accessKeyId, secretAccessKey, prefix, timeoutMs };
}
const storageConfig = parseStorageConfig(process.env, dataDir);

/**
 * Hosts the agent module may call although they resolve to private, loopback, or link-local
 * addresses (plan §3.2): host names (exact, case-insensitive) or IP addresses and CIDR ranges, comma
 * separated. A LiteLLM or Ollama container on the compose network is the usual entry. Plain `http:`
 * is allowed only for these hosts.
 */
export function parseAllowedPrivateHosts(value: string | undefined) {
  return (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).map((entry) => {
    if (parseEntry(entry)) return entry;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(entry)) throw new Error("AGENT_ALLOWED_PRIVATE_HOSTS entries must be host names, IP addresses, or CIDR ranges, such as ollama,10.0.0.0/8");
    return entry;
  });
}
const agentAllowedPrivateHosts = parseAllowedPrivateHosts(process.env.AGENT_ALLOWED_PRIVATE_HOSTS);
// Tests and local QA only: hosts the chat image proxy may reach over http, on any port, even when
// private (a local picture host). The proxy never uses AGENT_ALLOWED_PRIVATE_HOSTS (review M1). Never in production.
const agentImageProxyTestHosts = parseAllowedPrivateHosts(process.env.AGENT_IMAGE_PROXY_TEST_HOSTS);
if (agentImageProxyTestHosts.length > 0 && process.env.NODE_ENV === "production") throw new Error("AGENT_IMAGE_PROXY_TEST_HOSTS is for tests only and cannot be used in production");
if (agentAllowedPrivateHosts.length > 50) throw new Error("AGENT_ALLOWED_PRIVATE_HOSTS takes at most 50 entries");
// At most 16 (Wave 42 review L2): with the held-run caps, runs never take more than their share of the request slots.
const agentMaxConcurrentRuns = integerEnv("AGENT_MAX_CONCURRENT_RUNS", 4, 1, 16);
const agentRunTimeoutS = integerEnv("AGENT_RUN_TIMEOUT_S", 600, 30, 3600);
/**
 * The agent Audit log's retention (Wave 42, plan §7.3, D366): API and MCP runs are kept this many
 * days, then the hourly sweeper deletes them. An admin's Settings → AI policy may set another value
 * in the same range; unset, this one applies.
 */
const agentAuditRetentionDays = integerEnv("AGENT_AUDIT_RETENTION_DAYS", 30, 7, 365);
/**
 * stdio MCP servers (Wave 41, plan §3.3, D348): never from the UI. Only with `AGENT_MCP_STDIO=on`
 * does Nook read the host's declaration file (`AGENT_MCP_STDIO_FILE`, an absolute path), at startup.
 * With the flag off the file is ignored, whatever it holds. server/agents/stdio.ts reads it.
 */
const agentMcpStdioRaw = (process.env.AGENT_MCP_STDIO ?? "off").trim().toLowerCase();
if (!["on", "off"].includes(agentMcpStdioRaw)) throw new Error("AGENT_MCP_STDIO must be on or off");
const agentMcpStdioFile = (process.env.AGENT_MCP_STDIO_FILE ?? "").trim() || null;
if (agentMcpStdioRaw === "on" && !agentMcpStdioFile) throw new Error("AGENT_MCP_STDIO=on needs AGENT_MCP_STDIO_FILE (an absolute path to the declaration file)");
if (agentMcpStdioFile && !agentMcpStdioFile.startsWith("/")) throw new Error("AGENT_MCP_STDIO_FILE must be an absolute path");

// Web Push (WAVES_10-12.md D65). auto: on only when APP_ORIGIN is https (browsers need a secure origin).
const pushEnabledValue = process.env.PUSH_ENABLED?.trim() || "auto";
if (!(["auto", "true", "false"] as const).includes(pushEnabledValue as "auto")) throw new Error("PUSH_ENABLED must be auto, true, or false");
const pushSubject = process.env.PUSH_SUBJECT?.trim() || appOrigin;
if (!/^mailto:[^\s@]+@[^\s@]+$/.test(pushSubject) && !/^https?:\/\/[^\s/]+/.test(pushSubject)) throw new Error("PUSH_SUBJECT must be a mailto: address or an http(s) URL");
const pushEndpointHosts = (process.env.PUSH_ENDPOINT_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
  .map((value) => {
    if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value) || /^(\*\.)?[\d.]+$/.test(value)) {
      throw new Error("PUSH_ENDPOINT_HOSTS entries must be host names such as push.example.com or *.push.example.com");
    }
    return value;
  });

// Outbound email through Resend (server/mail.ts). Off unless both are set; never logged.
const resendApiKey = process.env.RESEND_API_KEY?.trim() || null;
if (resendApiKey && !/^\S{8,200}$/.test(resendApiKey)) throw new Error("RESEND_API_KEY must be a single token without spaces");
const mailFrom = process.env.MAIL_FROM?.trim() || null;
if (mailFrom && !isMailFrom(mailFrom)) throw new Error('MAIL_FROM must be an address or "Display Name <address@example.com>"');

/**
 * `nook@example.com` or `Nook <nook@example.com>`: one address, no line breaks or extra brackets, and
 * a display name without `@`, so it cannot pose as another address (T228).
 */
export function isMailFrom(value: string) {
  const address = "[^\\s@<>\"]+@[^\\s@<>\"]+\\.[^\\s@<>\"]+";
  return value.length <= 200 && !/[\r\n]/.test(value)
    && (new RegExp(`^${address}$`).test(value) || new RegExp(`^[^<>@\"\\r\\n]{1,80} <${address}>$`).test(value));
}

// Email delivery (docs/plan/research/2026-09-28-outbound-email.md §C.2, §D.2, §D.7).
// MAIL_TRANSPORT=file writes every message to MAIL_FILE_PATH instead of sending it: development only.
const mailTransportValue = process.env.MAIL_TRANSPORT?.trim() || "resend";
if (!(["resend", "file"] as const).includes(mailTransportValue as "resend")) throw new Error("MAIL_TRANSPORT must be resend or file");
if (mailTransportValue === "file" && process.env.NODE_ENV === "production") throw new Error("MAIL_TRANSPORT=file is for development and tests only");
const mailFilePath = process.env.MAIL_FILE_PATH?.trim() || null;
if (mailTransportValue === "file" && (!mailFilePath || !mailFilePath.startsWith("/"))) throw new Error("MAIL_TRANSPORT=file needs an absolute MAIL_FILE_PATH");
const mailDailyLimit = integerEnv("MAIL_DAILY_LIMIT", 500, 1, 10_000);
// Resend webhooks (bounces and complaints, Wave 29): the endpoint exists only when this is set.
const resendWebhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim() || null;
if (resendWebhookSecret && !/^whsec_[A-Za-z0-9+/]{16,}={0,2}$/.test(resendWebhookSecret)) throw new Error("RESEND_WEBHOOK_SECRET must be the whsec_… signing secret from the Resend webhook page");
const mailAllowHttpValue = process.env.MAIL_ALLOW_HTTP_LINKS?.trim() || "false";
if (!(mailAllowHttpValue === "true" || mailAllowHttpValue === "false")) throw new Error("MAIL_ALLOW_HTTP_LINKS must be true or false");
const appOriginUrl = new URL(appOrigin);
const mailInstanceName = process.env.MAIL_INSTANCE_NAME?.trim() || appOriginUrl.hostname;
if (!isInstanceName(mailInstanceName)) throw new Error("MAIL_INSTANCE_NAME must be one line of at most 40 characters");

/** One printable line of 1 to 40 characters, counted in code points (it appears in every mail's band and footer, T228). */
export function isInstanceName(value: string) {
  const length = [...value].length;
  return length >= 1 && length <= 40 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(value);
}

// Wave 39: the name people see in titles, link previews, the web app manifest, and mail. Default "Nook";
// internal ids (mynotes_, nkv_) never change with it.
export const DEFAULT_APP_NAME = "Nook";
/** APP_NAME trimmed: 1 to 40 characters, no control or bidi characters, no `<` or `>`. Unset or empty is "Nook". */
export function parseAppName(raw: string | undefined) {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_APP_NAME;
  if (!isInstanceName(value)) throw new Error("APP_NAME must be one line of 1 to 40 characters without <, >, or control characters");
  return value;
}
const appNameValue = parseAppName(process.env.APP_NAME);

/**
 * A URL hostname that only reaches this machine: localhost and *.localhost, the whole 127.0.0.0/8
 * loopback block, 0.0.0.0, and the IPv6 loopback, unspecified, and IPv4-mapped loopback forms
 * (WHATWG URL writes [::ffff:127.0.0.1] as [::ffff:7f00:1]).
 */
export function isLocalHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const loopbackV4 = (value: string) => /^127(?:\.\d{1,3}){3}$/.test(value) || value === "0.0.0.0";
  if (loopbackV4(host)) return true;
  const v6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (v6 === "::1" || v6 === "::") return true;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(v6)?.[1];
  if (!mapped) return false;
  if (loopbackV4(mapped)) return true;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  if (!hex) return false;
  const high = Number.parseInt(hex[1]!, 16);
  return high >> 8 === 127 || (high === 0 && Number.parseInt(hex[2]!, 16) === 0);
}
/**
 * Why links in mail could not work for a recipient (§D.7), or null when they can: an https
 * APP_ORIGIN, or an http one the operator allowed with MAIL_ALLOW_HTTP_LINKS (a LAN or Tailscale
 * host). Mail sent through Resend never links to localhost. The file transport accepts any origin.
 */
function mailLinksBlocked() {
  if (mailTransportValue === "file" || appOriginUrl.protocol === "https:") return null;
  if (isLocalHost(appOriginUrl.hostname)) return "APP_ORIGIN is a localhost address, so links in mail would not work for anyone else";
  if (mailAllowHttpValue !== "true") return "APP_ORIGIN is not https; set MAIL_ALLOW_HTTP_LINKS=true to send mail with http links";
  return null;
}
const mailBlockedReason = resendApiKey && mailFrom ? mailLinksBlocked() : null;
const mailEnabled = mailTransportValue === "file" || Boolean(resendApiKey && mailFrom && !mailBlockedReason);

// Reverse proxies in front of Nook (Wave 35 review N1; access plan O-A7): 0 = the socket address and
// no forwarding header is read; N = the N-th X-Forwarded-For entry from the right. Rate limits, audit
// entries, and (Wave 34) API keys limited to addresses.
const trustedProxyHops = integerEnv("TRUSTED_PROXY_HOPS", 0, 0, 5);
// Wave 34 review S1: the proxies' own addresses. When set, forwarding headers are read only from a
// connection whose address is in this list; anyone reaching Nook around the proxy is seen as themselves.
const trustedProxyAddresses = (process.env.TRUSTED_PROXY_ADDRESSES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
for (const entry of trustedProxyAddresses) {
  if (!parseEntry(entry)) throw new Error("TRUSTED_PROXY_ADDRESSES must be a comma-separated list of IP addresses or CIDR ranges, such as 127.0.0.1,172.16.0.0/12");
}
if (trustedProxyAddresses.length > 20) throw new Error("TRUSTED_PROXY_ADDRESSES takes at most 20 addresses or ranges");

// Sign-in methods (Wave 35, D290): password (default, as before), google, or both.
const authMethodsValue = process.env.AUTH_METHODS?.trim().toLowerCase() || "password";
if (!(["password", "google", "both"] as const).includes(authMethodsValue as "password")) throw new Error("AUTH_METHODS must be password, google, or both");
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
if (authMethodsValue !== "password" && (!googleClientId || !googleClientSecret)) {
  throw new Error(`AUTH_METHODS=${authMethodsValue} needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the OAuth client from Google Cloud Console)`);
}
if (googleClientId && !/^[A-Za-z0-9._-]{8,200}$/.test(googleClientId)) throw new Error("GOOGLE_CLIENT_ID must be the client id from Google Cloud Console, without spaces");
if (googleClientSecret && !/^\S{8,200}$/.test(googleClientSecret)) throw new Error("GOOGLE_CLIENT_SECRET must be a single token without spaces");
const googleAllowedDomains = (process.env.GOOGLE_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
  .map((value) => {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) throw new Error("GOOGLE_ALLOWED_DOMAINS entries must be domain names such as example.com");
    return value;
  });
// Tests and local QA only: a fake issuer standing in for Google (D290). Never in production.
const googleTestBaseUrl = process.env.GOOGLE_OIDC_TEST_BASE_URL?.trim() || null;
if (googleTestBaseUrl && process.env.NODE_ENV === "production") throw new Error("GOOGLE_OIDC_TEST_BASE_URL is for tests only and cannot be used in production");

/** Google's endpoints, or a fake issuer's (tests). The avatar hosts are suffix rules: ".googleusercontent.com". */
export function googleEndpoints(base: string | null) {
  if (!base) {
    return {
      authorization: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      jwks: "https://www.googleapis.com/oauth2/v3/certs",
      issuers: ["https://accounts.google.com", "accounts.google.com"],
      avatarHosts: [".googleusercontent.com"],
      avatarHttp: false
    };
  }
  const url = new URL(base);
  const root = url.origin;
  return {
    authorization: `${root}/o/oauth2/v2/auth`,
    token: `${root}/token`,
    jwks: `${root}/oauth2/v3/certs`,
    issuers: [root],
    avatarHosts: [url.hostname],
    avatarHttp: url.protocol === "http:"
  };
}

export const config = {
  port,
  dataDir,
  databasePath: resolve(dataDir, "mynotes.sqlite"),
  appOrigin,
  appOrigins,
  isProduction: process.env.NODE_ENV === "production",
  cookieSecure: cookieSecureValue === "true",
  allowRegistration: process.env.ALLOW_REGISTRATION === "true",
  totpPolicy,
  totpEncryptionKey,
  /** The vault's key-encryption key (D212), or null when the vault module is off. Tests switch it in process. */
  vault: { key: vaultKey.key, source: vaultKey.source },
  /**
   * Agent chat (Wave 40): the secrets key (null = module off), the private hosts the server may
   * call, and the run caps. Tests switch these in process.
   */
  agents: { key: agentSecretsKey.key, source: agentSecretsKey.source, allowedPrivateHosts: agentAllowedPrivateHosts, imageProxyTestHosts: agentImageProxyTestHosts, maxConcurrentRuns: agentMaxConcurrentRuns, runTimeoutS: agentRunTimeoutS, stdio: agentMcpStdioRaw === "on", stdioFile: agentMcpStdioFile, auditRetentionDays: agentAuditRetentionDays },
  signupRole,
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS ?? 14)),
  maxMarkdownBytes: Math.max(1024, Number(process.env.MAX_MARKDOWN_BYTES ?? 2_000_000)),
  maxUploadBytes: integerEnv("MAX_UPLOAD_BYTES", 104_857_600, 1_048_576, 2_147_483_648),
  /** Live plus binned document bytes per user; 0 means unlimited. */
  userStorageQuotaBytes: integerEnv("USER_STORAGE_QUOTA_BYTES", 10_737_418_240, 0, Number.MAX_SAFE_INTEGER),
  minFreeDiskBytes: integerEnv("MIN_FREE_DISK_BYTES", 1_073_741_824, 0, Number.MAX_SAFE_INTEGER),
  /** Where file bytes live (STORAGE_BACKEND and the S3_* settings); server/objectStore.ts. Never logged. */
  storage: storageConfig,
  /** APP_NAME (Wave 39): titles, link previews, the manifest, mail, and MCP. Tests switch it in process. */
  appName: appNameValue,
  appVersion: process.env.APP_VERSION ?? "0.38.0",
  gitSha: (process.env.GIT_SHA ?? "development").slice(0, 40),
  pushEnabled: pushEnabledValue as "auto" | "true" | "false",
  pushSubject,
  /** Push service hosts allowed besides the built-in list; "*.example.com" matches subdomains. */
  pushEndpointHosts,
  /**
   * Email is on only when both RESEND_API_KEY and MAIL_FROM are set and links in mail can work
   * (server/mail.ts), or with the development file transport.
   */
  /** How many trusted reverse proxies add X-Forwarded-For entries (server/clientAddress.ts). */
  trustedProxyHops,
  /** The proxies' addresses (Wave 34 review S1): forwarding headers are read only from these peers; empty = from any peer. */
  trustedProxyAddresses,
  /** Sign-in methods and the Google OAuth client (Wave 35, D290). Tests switch these in process. */
  auth: {
    methods: authMethodsValue as "password" | "google" | "both",
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      allowedDomains: googleAllowedDomains,
      endpoints: googleEndpoints(googleTestBaseUrl)
    }
  },
  mail: {
    enabled: mailEnabled,
    apiKey: resendApiKey,
    from: mailFrom,
    partial: mailTransportValue === "resend" && Boolean(resendApiKey) !== Boolean(mailFrom),
    /** Why configured mail stays off (its links would not work), for the startup warning. */
    blockedReason: mailBlockedReason,
    /** True when mail goes out with http links (MAIL_ALLOW_HTTP_LINKS=true), for the startup warning. */
    httpLinks: mailEnabled && mailTransportValue === "resend" && appOriginUrl.protocol === "http:",
    transport: mailTransportValue as "resend" | "file",
    filePath: mailFilePath,
    /** Shown in the brand band and footer, so people with two Nooks can tell them apart. */
    instanceName: mailInstanceName,
    /** Messages a day for the whole instance (§D.2); 10% of it is kept for security and account mail. */
    dailyLimit: mailDailyLimit,
    /** Signs Resend's bounce and complaint webhooks; POST /api/mail/webhook answers 404 without it. */
    webhookSecret: resendWebhookSecret
  }
};

/**
 * Integrations (service accounts, D287) get a synthetic address in the reserved `.invalid` top-level
 * domain (RFC 2606), which can never receive mail. No address there is ever allowed: nobody can
 * register, sign in, reset a password, be invited, or link Google with one, whatever ALLOWED_EMAILS says.
 */
export const SERVICE_EMAIL_DOMAIN = "service.invalid";
export const isReservedEmail = (email: string) => /\.invalid$/i.test(email.trim());

export function isEmailAllowed(email: string) {
  if (isReservedEmail(email)) return false;
  return allowedEmails.size === 0 || allowedEmails.has(email.trim().toLowerCase());
}

export function isOriginAllowed(origin: string | undefined | null) {
  return Boolean(origin && appOrigins.has(origin));
}

/** Whether email and password sign-in is on (D295). Read on every request, never cached. */
export const passwordAuthEnabled = () => config.auth.methods !== "google";
/** Whether Google sign-in is on (D295). */
export const googleAuthEnabled = () => config.auth.methods !== "password" && Boolean(config.auth.google.clientId && config.auth.google.clientSecret);

/** The app's display name (APP_NAME), read when used so tests can switch it. */
export const appName = () => config.appName;
