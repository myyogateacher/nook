import { createHash } from "node:crypto";
import { config } from "../config";

/**
 * Google OpenID Connect, server side (Wave 35, D289, T251, T252, T260). No dependency: `fetch` and
 * WebCrypto. Google's tokens never leave this module and are never logged: failures carry a short
 * reason code only.
 */

export const GOOGLE_SCOPES = "openid email profile";
const CLOCK_SKEW_S = 60;
const TOKEN_TIMEOUT_MS = 10_000;
const JWKS_MIN_TTL_MS = 5 * 60_000;
const JWKS_MAX_TTL_MS = 24 * 3_600_000;
const JWKS_REFETCH_GAP_MS = 60_000;

export class OidcError extends Error {
  constructor(readonly reason: string) {
    super(`Google sign-in failed: ${reason}`);
    this.name = "OidcError";
  }
}

export const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Built from APP_ORIGIN only: never from Host or X-Forwarded-Host (T253). */
export const redirectUri = () => `${new URL(config.appOrigin).origin}/api/auth/google/callback`;

export function authorizationUrl(input: { state: string; nonce: string; verifier: string; loginHint?: string | null; reauth?: boolean }) {
  const google = config.auth.google;
  const url = new URL(google.endpoints.authorization);
  url.searchParams.set("client_id", google.clientId ?? "");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", pkceChallenge(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // A re-authentication must be a real one (MEDIUM-3): Google asks for the password again and the
  // token's auth_time is checked at the callback.
  url.searchParams.set("prompt", input.reauth ? "login" : "select_account");
  if (input.reauth) url.searchParams.set("max_age", "0");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  // A hint only (T256): the signed `hd` claim is what is checked.
  if (google.allowedDomains.length === 1) url.searchParams.set("hd", google.allowedDomains[0]!);
  return url.toString();
}

/** Redeems the code (with the PKCE verifier) at the token endpoint and returns the raw ID token. */
export async function exchangeCode(code: string, verifier: string) {
  const google = config.auth.google;
  let response: Response;
  try {
    response = await fetch(google.endpoints.token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri(),
        client_id: google.clientId ?? "",
        client_secret: google.clientSecret ?? ""
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    });
  } catch {
    throw new OidcError("token_network");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new OidcError(`token_status_${response.status}`);
  }
  const body = await response.json().catch(() => null) as { id_token?: unknown } | null;
  if (!body || typeof body.id_token !== "string") throw new OidcError("token_missing");
  return body.id_token;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type JwksCache = { url: string; keys: Map<string, CryptoKey>; expiresAt: number; fetchedAt: number };
let jwksCache: JwksCache | null = null;

/** Test hook: forget the cached Google keys. */
export function resetJwksCache() {
  jwksCache = null;
}

function maxAgeMs(header: string | null) {
  const match = /max-age=(\d+)/i.exec(header ?? "");
  const value = match ? Number(match[1]) * 1000 : JWKS_MIN_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, value));
}

async function loadJwks(url: string) {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch {
    throw new OidcError("jwks_network");
  }
  if (!response.ok) throw new OidcError(`jwks_status_${response.status}`);
  const body = await response.json().catch(() => null) as { keys?: Jwk[] } | null;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body?.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid || (jwk.alg && jwk.alg !== "RS256") || (jwk.use && jwk.use !== "sig")) continue;
    try {
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    } catch {
      // A malformed key is skipped; a token signed with it then fails.
    }
  }
  const time = Date.now();
  jwksCache = { url, keys, expiresAt: time + maxAgeMs(response.headers.get("Cache-Control")), fetchedAt: time };
  return jwksCache;
}

/** The verification key for `kid`: cached while fresh, refetched once (at most every minute) for an unknown kid. */
async function signingKey(kid: string) {
  const url = config.auth.google.endpoints.jwks;
  let cache = jwksCache && jwksCache.url === url && jwksCache.expiresAt > Date.now() ? jwksCache : await loadJwks(url);
  if (!cache.keys.has(kid) && Date.now() - cache.fetchedAt > JWKS_REFETCH_GAP_MS) cache = await loadJwks(url);
  const key = cache.keys.get(kid);
  if (!key) throw new OidcError("unknown_kid");
  return key;
}

function decodePart(part: string) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new OidcError("malformed");
  }
}

export type GoogleClaims = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  hd: string | null;
  /** When the person last authenticated at Google (seconds), or null when the token has none. */
  authTime: number | null;
};

/**
 * Verifies an ID token: RS256 signature against Google's keys, issuer, audience (and azp), expiry and
 * issue time with 60 s skew, and the flow's nonce. `email_verified` is returned for the caller to
 * enforce (it answers `unverified`, not `failed`).
 */
export async function verifyIdToken(idToken: string, expectedNonce: string, nowMs = Date.now()): Promise<GoogleClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new OidcError("malformed");
  const header = decodePart(parts[0]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OidcError("alg");
  const key = await signingKey(header.kid);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new OidcError("signature");
  const claims = decodePart(parts[1]!);
  const google = config.auth.google;
  if (typeof claims.iss !== "string" || !google.endpoints.issuers.includes(claims.iss)) throw new OidcError("iss");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!google.clientId || !audiences.includes(google.clientId)) throw new OidcError("aud");
  if (audiences.length > 1 && claims.azp !== google.clientId) throw new OidcError("azp");
  if (claims.azp !== undefined && claims.azp !== google.clientId) throw new OidcError("azp");
  const nowS = Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) throw new OidcError("exp");
  if (typeof claims.iat !== "number" || claims.iat - CLOCK_SKEW_S > nowS) throw new OidcError("iat");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - CLOCK_SKEW_S > nowS)) throw new OidcError("nbf");
  if (typeof claims.nonce !== "string" || claims.nonce !== expectedNonce) throw new OidcError("nonce");
  if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) throw new OidcError("sub");
  if (typeof claims.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(claims.email) || claims.email.length > 254) throw new OidcError("email");
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    hd: typeof claims.hd === "string" ? claims.hd.toLowerCase() : null,
    authTime: typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time) ? claims.auth_time : null
  };
}

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Whether Google speaks for this address (MEDIUM-1): a consumer address (gmail.com, googlemail.com)
 * without an `hd` claim, or a Workspace account whose signed `hd` equals the address's domain. A
 * consumer Google account registered with a company address is verified by Google but not owned by
 * it: linking an existing Nook account by email needs this, not just `email_verified`.
 */
export function googleAuthoritative(claims: Pick<GoogleClaims, "email" | "hd">) {
  const domain = claims.email.slice(claims.email.lastIndexOf("@") + 1);
  return CONSUMER_DOMAINS.has(domain) ? claims.hd === null : claims.hd === domain;
}

/** A re-authentication's `auth_time` must be within 5 minutes (60 s skew) of now (MEDIUM-3). */
export const REAUTH_MAX_AGE_S = 300;
export function freshAuthTime(claims: Pick<GoogleClaims, "authTime">, nowMs = Date.now()) {
  if (claims.authTime === null) return false;
  const nowS = Math.floor(nowMs / 1000);
  return claims.authTime <= nowS + CLOCK_SKEW_S && nowS - claims.authTime <= REAUTH_MAX_AGE_S + CLOCK_SKEW_S;
}

/**
 * GOOGLE_ALLOWED_DOMAINS (T256): the verified email's domain must be listed, and the signed `hd`
 * claim must equal it (Workspace), or be absent for gmail.com and googlemail.com.
 */
export function domainAllowed(claims: Pick<GoogleClaims, "email" | "hd">) {
  const domains = config.auth.google.allowedDomains;
  if (!domains.length) return true;
  const domain = claims.email.slice(claims.email.lastIndexOf("@") + 1);
  if (!domains.includes(domain)) return false;
  return googleAuthoritative(claims);
}
