import { resolve } from "node:path";

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
  signupRole,
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS ?? 14)),
  maxMarkdownBytes: Math.max(1024, Number(process.env.MAX_MARKDOWN_BYTES ?? 2_000_000)),
  maxUploadBytes: integerEnv("MAX_UPLOAD_BYTES", 104_857_600, 1_048_576, 2_147_483_648),
  /** Live plus binned document bytes per user; 0 means unlimited. */
  userStorageQuotaBytes: integerEnv("USER_STORAGE_QUOTA_BYTES", 10_737_418_240, 0, Number.MAX_SAFE_INTEGER),
  minFreeDiskBytes: integerEnv("MIN_FREE_DISK_BYTES", 1_073_741_824, 0, Number.MAX_SAFE_INTEGER),
  appVersion: process.env.APP_VERSION ?? "0.9.2",
  gitSha: (process.env.GIT_SHA ?? "development").slice(0, 40),
  pushEnabled: pushEnabledValue as "auto" | "true" | "false",
  pushSubject,
  /** Push service hosts allowed besides the built-in list; "*.example.com" matches subdomains. */
  pushEndpointHosts
};

export function isEmailAllowed(email: string) {
  return allowedEmails.size === 0 || allowedEmails.has(email.trim().toLowerCase());
}

export function isOriginAllowed(origin: string | undefined | null) {
  return Boolean(origin && appOrigins.has(origin));
}
