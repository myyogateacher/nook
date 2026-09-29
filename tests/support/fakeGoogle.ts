/**
 * A local stand-in for Google's OpenID Connect endpoints (Wave 35 tests and local QA). Nothing here
 * reaches the network: it signs RS256 ID tokens with a throwaway key, checks PKCE and the client
 * secret like Google does, and serves test avatars. Point the server at it with
 * `GOOGLE_OIDC_TEST_BASE_URL` (a subprocess) or `config.auth.google.endpoints = googleEndpoints(url)`.
 *
 * QA: `bun tests/support/fakeGoogle.ts <port>` serves an account chooser page at the authorization
 * endpoint, so the whole flow can be clicked through in a browser.
 */
import { createHash } from "node:crypto";

export type FakeIdentity = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string | null;
  hd?: string;
};

/** Changes to one issued token, for the negative tests. */
export type TokenTweaks = {
  claims?: Record<string, unknown>;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
  /** Replace the signature with garbage. */
  badSignature?: boolean;
  header?: Record<string, unknown>;
};

/**
 * `maxAge`: the request's `max_age`. Like Google, a request with `max_age=0` (or `prompt=login`) makes
 * the person sign in again, so `auth_time` is now; otherwise the fake reuses a Google session that
 * started an hour ago.
 */
type Grant = { identity: FakeIdentity; nonce: string; challenge: string; redirectUri: string; clientId: string; tweaks: TokenTweaks; freshLogin: boolean };

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function rsaKey() {
  return await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
}

/** A 1×1 PNG. */
export const PNG_BYTES = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

export async function startFakeGoogle(options: { port?: number; clientId?: string; clientSecret?: string; hostname?: string } = {}) {
  const clientId = options.clientId ?? "nook-test-client.apps.nook.test";
  const clientSecret = options.clientSecret ?? "nook-test-secret-value";
  const keys = await rsaKey();
  const foreign = await rsaKey();
  const kid = "fake-key-1";
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const grants = new Map<string, Grant>();
  const avatars = new Map<string, { status?: number; body?: Uint8Array | string; headers?: Record<string, string> }>();
  let tokenRequests = 0;
  let jwksRequests = 0;
  let avatarRequests = 0;
  let pendingTweaks: TokenTweaks = {};

  async function sign(payload: Record<string, unknown>, tweaks: TokenTweaks) {
    const header = { alg: "RS256", kid, typ: "JWT", ...tweaks.header };
    const input = `${b64(header)}.${b64(payload)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", tweaks.foreignKey ? foreign.privateKey : keys.privateKey, new TextEncoder().encode(input));
    return `${input}.${tweaks.badSignature ? b64("not a signature at all") : Buffer.from(signature).toString("base64url")}`;
  }

  let base = "";
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "localhost",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/oauth2/v3/certs") {
        jwksRequests += 1;
        return Response.json({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }, { headers: { "Cache-Control": "public, max-age=3600" } });
      }
      if (url.pathname === "/o/oauth2/v2/auth") {
        // QA only: a chooser page; tests call authorize() instead.
        const params = url.searchParams;
        if (request.method === "POST") {
          const form = await request.formData();
          const auth = new URL(String(form.get("auth")));
          if (form.get("deny")) return Response.redirect(`${auth.searchParams.get("redirect_uri")}?error=access_denied&state=${encodeURIComponent(auth.searchParams.get("state") ?? "")}`, 302);
          const identity: FakeIdentity = {
            sub: String(form.get("sub") || `sub-${createHash("sha256").update(String(form.get("email"))).digest("hex").slice(0, 16)}`),
            email: String(form.get("email")),
            email_verified: form.get("verified") === "on",
            name: String(form.get("name") || ""),
            picture: form.get("picture") ? `${base}/avatar/${encodeURIComponent(String(form.get("email")))}.png` : null
          };
          return Response.redirect(authorize(auth.toString(), identity), 302);
        }
        const self = request.url.replace(/"/g, "&quot;");
        const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Fake Google</title>
<style>body{font:16px system-ui;margin:24px;max-width:420px}label{display:block;margin:10px 0}input[type=text],input[type=email]{width:100%;padding:10px;font:inherit;box-sizing:border-box}button{min-height:44px;padding:0 16px;margin:12px 8px 0 0;font:inherit}</style>
<h1>Fake Google (tests only)</h1><p>Client: ${params.get("client_id")?.replace(/[<>&"]/g, "")}</p>
<form method="post"><input type="hidden" name="auth" value="${self}">
<label>Email <input type="email" name="email" required value="${(params.get("login_hint") ?? "").replace(/[<>&"]/g, "")}"></label>
<label>Name <input type="text" name="name" value="QA Person"></label>
<label>Subject (sub, optional) <input type="text" name="sub"></label>
<label><input type="checkbox" name="verified" checked> Email verified</label>
<label><input type="checkbox" name="picture" checked> Has a profile picture</label>
<button type="submit">Continue</button><button type="submit" name="deny" value="1" formnovalidate>Cancel</button></form>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        tokenRequests += 1;
        const form = new URLSearchParams(await request.text());
        const grant = grants.get(form.get("code") ?? "");
        if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
        grants.delete(form.get("code")!);
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return Response.json({ error: "invalid_grant", error_description: "pkce" }, { status: 400 });
        if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("redirect_uri") !== grant.redirectUri) return Response.json({ error: "redirect_uri_mismatch" }, { status: 400 });
        const nowS = Math.floor(Date.now() / 1000);
        const { identity } = grant;
        const payload: Record<string, unknown> = {
          iss: base,
          aud: clientId,
          azp: clientId,
          sub: identity.sub,
          email: identity.email,
          email_verified: identity.email_verified ?? true,
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.picture ? { picture: identity.picture } : {}),
          ...(identity.hd ? { hd: identity.hd } : {}),
          nonce: grant.nonce,
          iat: nowS,
          exp: nowS + 3600,
          auth_time: grant.freshLogin ? nowS : nowS - 3600,
          ...grant.tweaks.claims
        };
        for (const [key, value] of Object.entries(payload)) if (value === undefined) delete payload[key];
        return Response.json({ access_token: "fake-access-token", token_type: "Bearer", expires_in: 3599, scope: "openid email profile", id_token: await sign(payload, grant.tweaks) });
      }
      if (url.pathname.startsWith("/avatar/")) {
        avatarRequests += 1;
        const configured = avatars.get(url.pathname);
        if (configured) return new Response(configured.body ?? null, { status: configured.status ?? 200, headers: configured.headers ?? { "Content-Type": "image/png" } });
        return new Response(PNG_BYTES, { headers: { "Content-Type": "image/png" } });
      }
      return new Response("Not found", { status: 404 });
    }
  });
  base = `http://${options.hostname ?? "localhost"}:${server.port}`;

  /** Plays Google's part after the account chooser: returns the callback URL with a fresh code. */
  function authorize(authorizationUrl: string, identity: FakeIdentity, tweaks: TokenTweaks = pendingTweaks) {
    pendingTweaks = {};
    const params = new URL(authorizationUrl).searchParams;
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    const maxAge = params.get("max_age");
    const freshLogin = params.get("prompt") === "login" || (maxAge !== null && Number(maxAge) < 3600);
    grants.set(code, { identity, nonce: params.get("nonce") ?? "", challenge: params.get("code_challenge") ?? "", redirectUri: params.get("redirect_uri") ?? "", clientId: params.get("client_id") ?? "", tweaks, freshLogin });
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.get("state") ?? "");
    return callback.toString();
  }

  return {
    url: base,
    clientId,
    clientSecret,
    authorize,
    /** Tweaks for the next authorize() made by the QA page. */
    tweakNext(tweaks: TokenTweaks) { pendingTweaks = tweaks; },
    avatarUrl: (path: string) => `${base}/avatar/${path}`,
    setAvatar(path: string, response: { status?: number; body?: Uint8Array | string; headers?: Record<string, string> }) { avatars.set(`/avatar/${path}`, response); },
    stats: () => ({ tokenRequests, jwksRequests, avatarRequests }),
    stop: () => server.stop(true)
  };
}

export type FakeGoogle = Awaited<ReturnType<typeof startFakeGoogle>>;

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 22302);
  const fake = await startFakeGoogle({ port });
  console.log(`Fake Google issuer on ${fake.url} (client id ${fake.clientId}, secret ${fake.clientSecret})`);
}
