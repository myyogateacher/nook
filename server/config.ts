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

/** One printable line of at most 40 characters (it appears in every mail's band and footer, T228). */
export function isInstanceName(value: string) {
  return value.length >= 1 && value.length <= 40 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/.test(value);
}

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
  signupRole,
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS ?? 14)),
  maxMarkdownBytes: Math.max(1024, Number(process.env.MAX_MARKDOWN_BYTES ?? 2_000_000)),
  maxUploadBytes: integerEnv("MAX_UPLOAD_BYTES", 104_857_600, 1_048_576, 2_147_483_648),
  /** Live plus binned document bytes per user; 0 means unlimited. */
  userStorageQuotaBytes: integerEnv("USER_STORAGE_QUOTA_BYTES", 10_737_418_240, 0, Number.MAX_SAFE_INTEGER),
  minFreeDiskBytes: integerEnv("MIN_FREE_DISK_BYTES", 1_073_741_824, 0, Number.MAX_SAFE_INTEGER),
  appVersion: process.env.APP_VERSION ?? "0.18.0",
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
