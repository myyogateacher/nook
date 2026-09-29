import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import { createSession, readSession, type AppEnv } from "../auth";
import { createAccount, openRegistrationFor, RegistrationClosedError } from "../accounts";
import { rateLimited } from "../authLimits";
import { googleMethodRefusal } from "../authMethods";
import { avatarUrlFor, clearAvatar, storeAvatarFromUrl } from "../avatars";
import { config, isEmailAllowed, isOriginAllowed, passwordAuthEnabled } from "../config";
import { audit, db, now, type UserRow } from "../db";
import { mailEnabled } from "../mail";
import { kickMailDispatch } from "../mail/dispatcher";
import { mailPasswordChanged, mailTwoFactor } from "../mail/triggers";
import { isUsablePasswordHash, UNUSABLE_PASSWORD } from "../passwords";
import { consumeRecoveryCode, consumeTotp, googleReauthUntil, reauthMethod, verifyReauth } from "../reauth";
import { can } from "../team/roles";
import { allowGoogleLink, consumeGoogleLinkAllowance, googleAdminState, googleResetPreview, GoogleLinkError, unlinkGoogleForAccount } from "./linkAdmin";
import { hashInviteToken, InviteError, previewInvite } from "../team/invites";
import { invitePreviewSchema, parseJson, recoveryCode, totpCode, uuid } from "../validation";
import { claimFlow, clearFlowCookie, countFlowFailure, createFlow, liveFlowsForClient, LIVE_FLOWS_PER_CLIENT, readFlow, safeReturnPath, SECOND_FACTOR_TTL_MS, type FlowIntent, type FlowRow } from "./flows";
import { authorizationUrl, domainAllowed, exchangeCode, freshAuthTime, googleAuthoritative, OidcError, sha256Hex, verifyIdToken, type GoogleClaims } from "./oidc";

/**
 * Google sign-in routes (Wave 35, docs/plan/WAVE_35_GOOGLE_SIGNIN.md §3).
 *
 * Public, registered before the session middleware (each checks what it needs itself):
 * - GET  /api/auth/google/start          → 302 to Google (link and reauth need the signed-in session)
 * - GET  /api/auth/google/callback       → 303 to the return path, /login#google=code, or an error
 * - POST /api/auth/google/second-factor  → the Nook TOTP step after Google (D296)
 * - POST /api/auth/google/invite         → keeps an invite server side for the round trip (D298)
 * Signed in (registerGoogleAccountRoutes): GET /api/auth/account and DELETE /api/auth/google.
 *
 * Every route answers 404 GOOGLE_SIGNIN_DISABLED while AUTH_METHODS=password (D295).
 */

type IdentityRow = { id: string; user_id: string; subject: string; email: string; picture_url: string | null; created_at: string; last_login_at: string };

const identityBySub = (sub: string) => db.query("SELECT * FROM google_identities WHERE subject = ?").get(sub) as IdentityRow | null;
const identityOfUser = (userId: string) => db.query("SELECT * FROM google_identities WHERE user_id = ?").get(userId) as IdentityRow | null;
const userById = (id: string) => db.query("SELECT * FROM users WHERE id = ?").get(id) as (UserRow & { email_verified_at: string | null; avatar_id: string | null }) | null;
const userByEmail = (email: string) => db.query("SELECT * FROM users WHERE email = ?").get(email) as (UserRow & { email_verified_at: string | null; avatar_id: string | null }) | null;

function clientAddress(c: Context) {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

const safeEqual = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** Sign-in outcomes land on the sign-in page; codes only, never data (D300, T260). */
const toLogin = (c: Context, fragment: string) => c.redirect(`/login#${fragment}`, 303);

/** Where a flow's failure goes: back to Settings for link and reauth, else the sign-in page. */
function failTo(c: Context, flow: Pick<FlowRow, "intent" | "return_to"> | null, code: string) {
  if (flow && (flow.intent === "link" || flow.intent === "reauth")) return c.redirect(`${flow.return_to}#google-error=${code}`, 303);
  return toLogin(c, `error=${code}`);
}

const totpState = (user: Pick<UserRow, "totp_enabled_at">) => {
  const enabled = user.totp_enabled_at !== null;
  return { enabled, required: config.totpPolicy === "required", setupRequired: config.totpPolicy === "required" && !enabled };
};

/** Avatar downloads run after the response (a picture must not slow or fail a sign-in, D299). */
const pendingAvatars = new Set<Promise<unknown>>();
/** Test hook: resolves once every avatar download started so far has finished. */
export async function avatarWorkSettled() {
  while (pendingAvatars.size) await Promise.all([...pendingAvatars]);
}

/** Saves the picture URL on the identity and downloads it when it changed or no file is stored. */
function refreshPicture(userId: string, identityId: string, previousUrl: string | null, picture: string | null) {
  if (!picture) return;
  db.query("UPDATE google_identities SET picture_url = ? WHERE id = ?").run(picture, identityId);
  const avatarId = (db.query("SELECT avatar_id FROM users WHERE id = ?").get(userId) as { avatar_id: string | null } | null)?.avatar_id ?? null;
  if (picture === previousUrl && avatarId) return;
  const work = storeAvatarFromUrl(userId, picture).catch(() => false);
  pendingAvatars.add(work);
  void work.finally(() => pendingAvatars.delete(work));
}

function insertIdentity(userId: string, claims: GoogleClaims, at: string) {
  const id = crypto.randomUUID();
  db.query("INSERT INTO google_identities (id, user_id, subject, email, picture_url, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
    .run(id, userId, claims.sub, claims.email, at, at);
  return id;
}

/**
 * Links a Google identity to an existing account (D293, review HIGH-1). Nothing else about the
 * account changes: the password, sessions, keys, and sharing stay. It is reached only by a
 * signed-in, re-authenticated link from Settings, by a sign-in on an address Nook verified and
 * Google is authoritative for, or by an admin's allowance. The address becomes verified and the
 * owner is mailed every time (L2).
 */
function linkIdentity(user: NonNullable<ReturnType<typeof userById>>, claims: GoogleClaims, via: "signin" | "settings" | "allowance") {
  const identityId = db.transaction(() => {
    const at = now();
    const id = insertIdentity(user.id, claims, at);
    db.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), google_link_allowed_until = NULL WHERE id = ?").run(at, user.id);
    mailPasswordChanged(user.id, "google_linked");
    audit(user.id, null, "auth.google_linked", { via });
    return id;
  })();
  kickMailDispatch();
  return identityId;
}

const INVITE_CODES: Record<string, string> = { INVITE_INVALID: "invite_invalid", INVITE_EXPIRED: "invite_expired", INVITE_EMAIL_MISMATCH: "invite_mismatch", EMAIL_NOT_ALLOWED: "not_allowed" };

const displayNameFrom = (claims: GoogleClaims) => {
  const name = (claims.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return name || claims.email.slice(0, claims.email.indexOf("@")).slice(0, 80) || "Nook user";
};

function publicPostRefusal(c: Context) {
  if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
  return null;
}

const secondFactorSchema = z.object({ totpCode: totpCode.optional(), recoveryCode: recoveryCode.optional() }).strict()
  .refine((value) => Boolean(value.totpCode) !== Boolean(value.recoveryCode), "Enter an authentication code or a recovery code");

const INTENTS: readonly FlowIntent[] = ["signin", "invite", "link", "reauth"];

/** The public Google routes: register before the session middleware. */
export function registerGoogleRoutes(app: Hono<AppEnv>) {
  app.get("/api/auth/google/start", (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    // L4: the per-client bucket first, so one client cannot use up the (generous) global one, and a
    // cap on the live flows a client holds.
    const client = clientAddress(c);
    const clientHash = sha256Hex(`google-client:${client}`);
    if (rateLimited(`google:start:${client}`, 20) || rateLimited("google:start:global", 2000) || liveFlowsForClient(clientHash) >= LIVE_FLOWS_PER_CLIENT) return toLogin(c, "error=rate_limited");
    const intent = (c.req.query("intent") ?? "signin") as FlowIntent;
    if (!INTENTS.includes(intent)) return toLogin(c, "error=failed");
    if (intent === "invite") {
      // The invite was posted to /invite first; its hash waits in a prepared flow (D298).
      const prepared = readFlow(c);
      if (!prepared || prepared.stage !== "prepared" || prepared.intent !== "invite" || !prepared.invite_hash || !claimFlow(prepared.id)) return toLogin(c, "error=invite_invalid");
      const flow = createFlow(c, { intent, stage: "authorize", returnTo: prepared.return_to, inviteHash: prepared.invite_hash, clientHash });
      return c.redirect(authorizationUrl(flow), 302);
    }
    if (intent === "link") {
      // L3: linking was re-authenticated by POST /api/auth/google/link, which prepared this flow for
      // this session; the Strict session cookie proves it is still the same browser and session.
      const prepared = readFlow(c);
      const session = readSession(c);
      if (!prepared || prepared.stage !== "prepared" || prepared.intent !== "link" || !session || prepared.session_id !== session.sessionId || prepared.user_id !== session.user.id || !claimFlow(prepared.id)) {
        return c.redirect("/settings/security#google-error=expired", 303);
      }
      const flow = createFlow(c, { intent, stage: "authorize", returnTo: prepared.return_to, userId: session.user.id, sessionId: session.sessionId, clientHash });
      return c.redirect(authorizationUrl({ ...flow, loginHint: session.user.email }), 302);
    }
    if (intent === "reauth") {
      // Only a same-site navigation carries the Strict session cookie, so a cross-site page cannot start this.
      const returnTo = safeReturnPath(c.req.query("return") ?? "/settings/security");
      const session = readSession(c);
      if (!session) return toLogin(c, "error=expired");
      const identity = identityOfUser(session.user.id);
      if (!identity) return c.redirect(`${returnTo}#google-error=reauth_mismatch`, 303);
      const flow = createFlow(c, { intent, stage: "authorize", returnTo, userId: session.user.id, sessionId: session.sessionId, clientHash });
      // MEDIUM-3: a real re-authentication (prompt=login, max_age=0; auth_time checked at the callback).
      return c.redirect(authorizationUrl({ ...flow, loginHint: identity.email, reauth: true }), 302);
    }
    const flow = createFlow(c, { intent, stage: "authorize", returnTo: safeReturnPath(c.req.query("return")), clientHash });
    return c.redirect(authorizationUrl(flow), 302);
  });

  app.get("/api/auth/google/callback", async (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    if (rateLimited(`google:callback:${clientAddress(c)}`, 30) || rateLimited("google:callback:global", 3000)) return toLogin(c, "error=rate_limited");
    const flow = readFlow(c);
    const state = c.req.query("state") ?? "";
    // T250/T251: this browser's own flow, the matching state, unused and unexpired, claimed once.
    // L9: a junk or foreign state leaves the browser's own in-progress flow (and its cookie) alone.
    if (!flow || flow.stage !== "authorize" || !safeEqual(sha256Hex(state), flow.state_hash) || !claimFlow(flow.id)) {
      return toLogin(c, "error=expired");
    }
    clearFlowCookie(c);
    if (c.req.query("error")) return failTo(c, flow, "denied");
    const code = c.req.query("code") ?? "";
    if (!code || code.length > 2048) return failTo(c, flow, "failed");
    let claims: GoogleClaims;
    try {
      claims = await verifyIdToken(await exchangeCode(code, flow.code_verifier), flow.nonce);
    } catch (error) {
      // The reason code only: never the code, a token, or a claim (T260).
      console.warn(`Google sign-in failed: reason=${error instanceof OidcError ? error.reason : error instanceof Error ? error.name : "unknown"}`);
      return failTo(c, flow, "failed");
    }
    if (!claims.emailVerified) return failTo(c, flow, "unverified");
    // T256, T258: the allowlist and the domain rule, one answer for existing and new accounts alike.
    if (!isEmailAllowed(claims.email) || !domainAllowed(claims)) {
      audit(null, null, "auth.google_refused", { reason: "not_allowed" });
      return failTo(c, flow, "not_allowed");
    }

    if (flow.intent === "link") {
      const user = flow.user_id ? userById(flow.user_id) : null;
      if (!user || user.disabled_at !== null) return failTo(c, flow, "expired");
      if (user.email.toLowerCase() !== claims.email) return failTo(c, flow, "link_mismatch");
      const bySub = identityBySub(claims.sub);
      if ((bySub && bySub.user_id !== user.id) || (!bySub && identityOfUser(user.id))) return failTo(c, flow, "already_linked");
      const identityId = bySub?.id ?? linkIdentity(user, claims, "settings");
      refreshPicture(user.id, identityId, bySub?.picture_url ?? null, claims.picture);
      return c.redirect(`${flow.return_to}#google=linked`, 303);
    }

    if (flow.intent === "reauth") {
      const identity = identityBySub(claims.sub);
      const user = flow.user_id ? userById(flow.user_id) : null;
      if (!identity || !user || identity.user_id !== user.id || user.disabled_at !== null) return failTo(c, flow, "reauth_mismatch");
      // MEDIUM-3: Google must have asked for the password just now, not reused an old session.
      if (!freshAuthTime(claims)) return failTo(c, flow, "reauth_stale");
      const confirmed = db.query("UPDATE sessions SET reauth_at = ? WHERE id = ? AND user_id = ? AND expires_at > ?").run(now(), flow.session_id, user.id, now()).changes;
      if (!confirmed) return failTo(c, flow, "expired");
      audit(user.id, null, "auth.google_reauth");
      refreshPicture(user.id, identity.id, identity.picture_url, claims.picture);
      return c.redirect(`${flow.return_to}#google=reauthed`, 303);
    }

    // Sign in (or accept an invite): by sub, else link by verified email, else create (D292).
    let identity = identityBySub(claims.sub);
    let user = identity ? userById(identity.user_id) : null;
    let created = false;
    if (!user) {
      const existing = userByEmail(claims.email);
      if (existing) {
        // A different Google account already holds this Nook account (for example a recreated Google account).
        if (identityOfUser(existing.id)) return failTo(c, flow, "already_linked");
        if (existing.disabled_at !== null) {
          audit(existing.id, null, "auth.login_blocked", { via: "google" });
          return failTo(c, flow, "blocked");
        }
        // HIGH-1, MEDIUM-1: never link by email to an address Nook has not verified, or one Google is
        // not authoritative for, and never reset anything here. An admin's allowance (Team or the
        // host CLI) or a signed-in link from Settings is the way forward.
        const authoritative = googleAuthoritative(claims);
        if (authoritative && consumeGoogleLinkAllowance(existing.id)) {
          linkIdentity(existing, claims, "allowance");
        } else if (authoritative && existing.email_verified_at !== null) {
          linkIdentity(existing, claims, "signin");
        } else {
          audit(existing.id, null, "auth.google_link_required", { authoritative });
          return failTo(c, flow, "link_required");
        }
        user = userById(existing.id);
      } else {
        const inviteHash = flow.intent === "invite" ? flow.invite_hash : null;
        if (!inviteHash && !openRegistrationFor()) return failTo(c, flow, "signup_closed");
        if (rateLimited("register:global", 10)) return failTo(c, flow, "rate_limited");
        try {
          const account = createAccount({
            email: claims.email,
            displayName: displayNameFrom(claims),
            passwordHash: UNUSABLE_PASSWORD,
            inviteHash,
            emailVerified: true,
            afterInsert: (userId, at) => { insertIdentity(userId, claims, at); }
          });
          audit(account.id, null, "auth.register", { via: "google" });
          user = userById(account.id);
          created = true;
        } catch (error) {
          if (error instanceof RegistrationClosedError) return failTo(c, flow, "signup_closed");
          if (error instanceof InviteError) return failTo(c, flow, INVITE_CODES[error.code] ?? "invite_invalid");
          if ((error as { code?: string }).code?.includes("CONSTRAINT")) return failTo(c, flow, "failed");
          throw error;
        }
      }
      identity = user ? identityOfUser(user.id) : null;
    }
    if (!user || !identity) return failTo(c, flow, "failed");
    if (!isEmailAllowed(user.email)) return failTo(c, flow, "not_allowed");
    // Blocked accounts are refused after the identity is proven, before any second factor (T85).
    if (user.disabled_at !== null) {
      audit(user.id, null, "auth.login_blocked", { via: "google" });
      return failTo(c, flow, "blocked");
    }
    // L8: the Google address shown in Settings follows Google; the Nook email never does.
    db.query("UPDATE google_identities SET last_login_at = ?, email = ? WHERE id = ?").run(now(), claims.email, identity.id);
    refreshPicture(user.id, identity.id, created ? null : identity.picture_url, claims.picture);
    if (user.totp_enabled_at) {
      // D296: Google is one factor; the session waits for the Nook code.
      createFlow(c, { intent: flow.intent, stage: "second_factor", returnTo: flow.return_to, userId: user.id, ttlMs: SECOND_FACTOR_TTL_MS });
      return toLogin(c, "google=code");
    }
    await createSession(c, user.id);
    audit(user.id, null, "auth.login", { via: "google" });
    return c.redirect(flow.return_to, 303);
  });

  app.post("/api/auth/google/second-factor", async (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    const refusal = publicPostRefusal(c);
    if (refusal) return refusal;
    const expired = () => {
      clearFlowCookie(c);
      return c.json({ error: "This sign-in expired. Continue with Google again.", code: "FLOW_EXPIRED" }, 400);
    };
    const flow = readFlow(c);
    if (!flow || flow.stage !== "second_factor" || !flow.user_id) return expired();
    const body = await parseJson(c.req.raw, secondFactorSchema);
    const user = userById(flow.user_id);
    if (!user) return expired();
    // The same buckets as password sign-in (D296).
    if (rateLimited(`login:${user.email}`) || rateLimited("login:global", 50)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    if (user.disabled_at !== null) {
      claimFlow(flow.id);
      clearFlowCookie(c);
      return c.json({ error: "This account has been blocked. Contact your Nook administrator.", code: "ACCOUNT_BLOCKED" }, 403);
    }
    if (user.totp_enabled_at) {
      const valid = body.recoveryCode ? consumeRecoveryCode(user, body.recoveryCode) : consumeTotp(user, body.totpCode!) !== null;
      if (!valid) {
        audit(user.id, null, "auth.totp_failed", { via: "google" });
        if (!countFlowFailure(flow.id)) return expired();
        return c.json({ error: "Invalid or already-used authentication or recovery code", code: "TOTP_INVALID", requiresTotp: true }, 401);
      }
      if (body.recoveryCode) {
        audit(user.id, null, "auth.recovery_code_used");
        mailTwoFactor(user.id, "recovery_used");
      }
    }
    if (!claimFlow(flow.id)) return expired();
    clearFlowCookie(c);
    const csrfToken = await createSession(c, user.id);
    audit(user.id, null, "auth.login", { via: "google" });
    return c.json({
      ok: true,
      returnTo: flow.return_to,
      user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, avatarUrl: avatarUrlFor(user.id, user.avatar_id) },
      csrfToken,
      totp: totpState(user)
    });
  });

  app.post("/api/auth/google/invite", async (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    const refusal = publicPostRefusal(c);
    if (refusal) return refusal;
    if (rateLimited("invite:global", 30)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    const body = await parseJson(c.req.raw, invitePreviewSchema);
    try {
      previewInvite(body.token);
    } catch (error) {
      if (error instanceof InviteError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
    // The token itself stays in this JSON body; only its hash waits server side (D298, T136).
    createFlow(c, { intent: "invite", stage: "prepared", returnTo: "/", inviteHash: hashInviteToken(body.token), clientHash: sha256Hex(`google-client:${clientAddress(c)}`) });
    return c.json({ start: "/api/auth/google/start?intent=invite" });
  });
}

/** Signed-in routes: register after the session, CSRF, and role middleware. */
export function registerGoogleAccountRoutes(app: Hono<AppEnv>) {
  // What Settings → Security and every re-authentication prompt need to know (D297, D300).
  app.get("/api/auth/account", (c) => {
    const current = c.get("user");
    const user = userById(current.id);
    if (!user) return c.json({ error: "Authentication required" }, 401);
    const identity = identityOfUser(user.id);
    return c.json({
      methods: { password: passwordAuthEnabled(), google: googleMethodRefusal(c) === null },
      hasPassword: isUsablePasswordHash(user.password_hash),
      google: identity ? { email: identity.email } : null,
      reauth: reauthMethod(user),
      reauthUntil: googleReauthUntil(c.get("sessionId"), user.id),
      passwordReset: mailEnabled() && passwordAuthEnabled()
    });
  });

  // Settings → Security → Link Google (L3): re-authenticated here (password, or Google re-auth for
  // an account without one, plus the code when two-factor is on), then prepared for this session.
  app.post("/api/auth/google/link", async (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    const current = c.get("user");
    const body = await parseJson(c.req.raw, reauthBodySchema);
    if (identityOfUser(current.id)) return c.json({ error: "This account already signs in with Google", code: "ALREADY_LINKED" }, 409);
    if (rateLimited(`google:link:${current.id}`, 5)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    if (current.totp_enabled_at && !body.totpCode && !body.recoveryCode) return c.json({ error: "Enter your six-digit authentication code", code: "TOTP_REQUIRED", requiresTotp: true }, 428);
    if (!await verifyReauth(current.id, body, "google_link", c.get("sessionId"))) {
      audit(current.id, null, "auth.google_link_reauth_failed");
      return c.json({ error: "Invalid password or authentication code", code: "REAUTH_FAILED" }, 401);
    }
    if (body.recoveryCode) mailTwoFactor(current.id, "recovery_used");
    createFlow(c, { intent: "link", stage: "prepared", returnTo: "/settings/security", userId: current.id, sessionId: c.get("sessionId"), clientHash: sha256Hex(`google-client:${clientAddress(c)}`) });
    return c.json({ start: "/api/auth/google/start?intent=link" });
  });

  app.delete("/api/auth/google", async (c) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    const current = c.get("user");
    const body = await parseJson(c.req.raw, reauthBodySchema);
    const user = userById(current.id);
    const identity = user ? identityOfUser(user.id) : null;
    if (!user || !identity) return c.json({ error: "Google sign-in is not linked", code: "NOT_LINKED" }, 404);
    // Unlinking must never leave the account without a way in.
    if (!passwordAuthEnabled() || !isUsablePasswordHash(user.password_hash)) {
      return c.json({ error: "Set a password before you unlink Google, so you can still sign in.", code: "PASSWORD_REQUIRED" }, 409);
    }
    // L3: re-authenticated like any other sign-in change.
    if (rateLimited(`google:unlink:${current.id}`, 5)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
    if (current.totp_enabled_at && !body.totpCode && !body.recoveryCode) return c.json({ error: "Enter your six-digit authentication code", code: "TOTP_REQUIRED", requiresTotp: true }, 428);
    if (!await verifyReauth(current.id, body, "google_unlink", c.get("sessionId"))) {
      audit(current.id, null, "auth.google_unlink_reauth_failed");
      return c.json({ error: "Invalid password or authentication code", code: "REAUTH_FAILED" }, 401);
    }
    if (body.recoveryCode) mailTwoFactor(current.id, "recovery_used");
    db.transaction(() => {
      db.query("DELETE FROM google_identities WHERE id = ?").run(identity.id);
      db.query("UPDATE sessions SET reauth_at = NULL WHERE user_id = ?").run(user.id);
      audit(user.id, null, "auth.google_unlinked");
    })();
    await clearAvatar(user.id);
    return c.json({ ok: true });
  });

  // Team → member → Google sign-in (admins only; HIGH-1, L6).
  const adminRefusal = (c: Context<AppEnv>) => {
    const off = googleMethodRefusal(c);
    if (off) return off;
    return can(c.get("user").role, "team.manage") ? null : c.json({ error: "Only admins can manage Google sign-in for others", code: "ADMIN_ONLY" }, 403);
  };
  const linkError = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof GoogleLinkError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  };

  app.get("/api/team/:userId/google", (c) => {
    const refusal = adminRefusal(c);
    if (refusal) return refusal;
    const targetId = uuid.parse(c.req.param("userId"));
    const state = googleAdminState(targetId);
    if (!state) return c.json({ error: "Team member not found", code: "NOT_FOUND" }, 404);
    return c.json({ ...state, resetPreview: googleResetPreview(targetId), self: targetId === c.get("user").id });
  });

  app.post("/api/team/:userId/google/allow", async (c) => {
    const refusal = adminRefusal(c);
    if (refusal) return refusal;
    const targetId = uuid.parse(c.req.param("userId"));
    const body = await parseJson(c.req.raw, allowSchema);
    try {
      return c.json(allowGoogleLink({ id: c.get("user").id }, targetId, { reset: body.reset, via: "web" }));
    } catch (error) {
      return linkError(c, error);
    }
  });

  app.delete("/api/team/:userId/google", async (c) => {
    const refusal = adminRefusal(c);
    if (refusal) return refusal;
    const targetId = uuid.parse(c.req.param("userId"));
    try {
      return c.json(await unlinkGoogleForAccount({ id: c.get("user").id }, targetId, "web"));
    } catch (error) {
      return linkError(c, error);
    }
  });
}

const reauthBodySchema = z.object({ password: z.string().min(1).max(256).optional(), totpCode: totpCode.optional(), recoveryCode: recoveryCode.optional() }).strict()
  .refine((value) => !(value.totpCode && value.recoveryCode), "Use either an authentication code or a recovery code");
const allowSchema = z.object({ reset: z.boolean() }).strict();
