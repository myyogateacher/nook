import { Hono, type Context } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { config, isEmailAllowed, isOriginAllowed } from "./config";
import { audit, db, ensureDefaultFolder, now, type NoteRow, type UserRow } from "./db";
import { createSession, logoutCurrentSession, requireAuth, requireMutationSafety, type AppEnv } from "./auth";
import { editableNote, listReadableFolders, noteLevel, ownedNote, readableNote, readableNotePredicate, visibleNoteFolderIdExpression } from "./access";
import { checksum, storage, withNoteLock } from "./storage";
import { startSweeper } from "./sweeper";
import { startDispatcher } from "./calendar/reminders";
import { startMailDispatcher } from "./mail/dispatcher";
import { initPush } from "./calendar/push";
import { reconcileEventNextOccurrences } from "./calendar/service";
import { reconcileCardExcerpts } from "./tasks/excerpt";
import { registerBinRoutes } from "./binRoutes";
import { createFolder, FolderError } from "./folders";
import { indexNote, reconcileSearchIndex, unindexNote } from "./searchIndex";
import { createDraftNote, discardDraft, DraftActionError, hasDraftDelta, isBlankNote, moveNoteToBin, publishDraft, purgeBlankNote, writeDraftLocked } from "./noteDrafts";
import { resolveNoteDraftProposals } from "./inbox/noteDraftProposals";
import { registerSearchRoutes } from "./searchRoutes";
import { registerTaskRoutes } from "./tasks/routes";
import { registerReactionRoutes } from "./reactions/routes";
import { registerSprintRoutes } from "./tasks/sprintRoutes";
import { registerTodayRoutes } from "./today/routes";
import { registerCollectionRoutes } from "./collections/routes";
import { reconcileCollectionSearchIndex } from "./collections/search";
import { registerCalendarRoutes } from "./calendar/routes";
import { readPreferences, registerPreferenceRoutes } from "./preferences";
import { isFeedRequest } from "./calendar/feeds";
import { contentRouteSecurityHeaders, isContentRequest, registerDocumentRoutes } from "./documents";
import { createMcpApiKey, handleMcpRequest, listMcpApiKeys, revokeMcpApiKey } from "./mcp";
import { handleMcpUpload } from "./mcpUploads";
import { aliasKeyRefusal, registerKeyRoutes } from "./keyRoutes";
import { liveKeyCount, startKeyUsageFlusher } from "./apiKeys";
import { readPolicies } from "./team/policies";
import { BINNED_WINDOWS, binnedCountsByKey, isBinnedWindow, listKeyBinned, restoreKeyBinned } from "./mcpBinned";
import { z } from "zod";

const restoreBinnedSchema = z.object({ window: z.enum(["1h", "24h", "7d"]) }).strict();
import { registerTeamRoutes } from "./team/routes";
import { registerInboxRoutes } from "./inbox/routes";
import { registerMailPreviewRoutes } from "./mail/preview";
import { mailApiKeyCreated, mailShared, mailTwoFactor, shareMembers } from "./mail/triggers";
import { enqueueVerifyMail, registerMailLogRoutes, registerMailRoutes, registerPublicMailRoutes } from "./mail/routes";
import { passwordResetAvailable, registerPasswordChangeRoute, registerPasswordResetRoutes } from "./passwordFlows";
import { hasActiveAdmin, recordBootstrapAdmin, warnIfNoActiveAdmin } from "./team/service";
import { GUEST_SHARE_DISABLED, legacyGuestShareBlocked, legacyShareLevels, writeDirectShares } from "./access/shares";
import { registerItemAccessRoutes } from "./access/itemAccess";
import { claimInvite, hashInviteToken, InviteError, inviteForRegistration, previewInvite } from "./team/invites";
import { can, mcpScopesForRole } from "./team/roles";
import { ROLE_READ_ONLY_BODY, roleWriteGate } from "./team/writeGate";
import {
  draftSchema,
  folderSharingSchema,
  folderSchema,
  invitePreviewSchema,
  JSON_BODY_LIMIT_BYTES,
  loginSchema,
  mcpApiKeySchema,
  noteCreateSchema,
  noteMetaSchema,
  parseJson,
  publishSchema,
  registerSchema,
  sharingSchema,
  totpCodeSchema,
  totpDisableSchema,
  totpRecoveryViewSchema,
  totpSetupSchema,
  uuid
} from "./validation";
import {
  createRecoveryCodes,
  createTotpSecret,
  decryptRecoveryCodes,
  encryptRecoveryCodes,
  encryptTotpSecret,
  totpUri
} from "./totp";
import { consumeRecoveryCode, consumeTotp } from "./reauth";

const app = new Hono<AppEnv>();

/** Error class and errno code for logs. Messages can carry paths or constraint text, so they are never logged. */
function errorClass(error: unknown) {
  if (!(error instanceof Error)) return "Unknown error";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}

function totpState(user: Pick<UserRow, "totp_enabled_at">) {
  const enabled = user.totp_enabled_at !== null;
  return { enabled, required: config.totpPolicy === "required", setupRequired: config.totpPolicy === "required" && !enabled };
}

const globalSecureHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"]
  },
  referrerPolicy: "no-referrer",
  strictTransportSecurity: config.appOrigin.startsWith("https://")
    ? "max-age=15552000; includeSubDomains"
    : false,
  permissionsPolicy: {
    camera: false,
    microphone: false,
    geolocation: false,
    payment: false,
    usb: false
  },
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY"
});

// secureHeaders overwrites headers after next(), so the document content route (and only it)
// is excluded and sets its own strict header set, including a sandboxing CSP.
app.use("*", (c, next) => isContentRequest(c.req.method, c.req.path)
  ? contentRouteSecurityHeaders(c, next)
  : globalSecureHeaders(c, next));

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/api/health", (c) => c.json({ status: "ok" }));
// hasUsers and openRegistration let the login screen offer "Create the first account" only on a
// fresh instance (QA note 13): a yes/no, never a count.
app.get("/api/about", (c) => c.json({
  version: config.appVersion, gitSha: config.gitSha,
  hasUsers: db.query("SELECT 1 FROM users LIMIT 1").get() !== null, openRegistration: config.allowRegistration,
  // Wave 30: whether "Forgot password?" can mail a link (email on); an instance fact, never per account.
  passwordReset: passwordResetAvailable()
}));

app.use("/api/auth/login", async (c, next) => {
  if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
  await next();
});
app.use("/api/auth/register", async (c, next) => {
  if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
  await next();
});
app.use("/api/auth/invite", async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (!isOriginAllowed(c.req.header("Origin"))) return c.json({ error: "Invalid request origin" }, 403);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Content-Type must be application/json" }, 415);
  await next();
});

const authAttempts = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string, limit = 10) {
  const time = Date.now();
  if (authAttempts.size > 500) {
    for (const [entryKey, entry] of authAttempts) if (entry.resetAt <= time) authAttempts.delete(entryKey);
  }
  const item = authAttempts.get(key);
  if (!item || item.resetAt <= time) {
    authAttempts.set(key, { count: 1, resetAt: time + 60_000 });
    return false;
  }
  item.count += 1;
  return item.count > limit;
}

/** Test hook: `bun test` runs every file on one server, so the run-wide register:global bucket is shared. */
export function resetRegistrationRateLimit() {
  authAttempts.delete("register:global");
  authAttempts.delete("invite:global");
}

const inviteErrorResponse = (c: Context<AppEnv>, error: InviteError) => c.json({ error: error.message, code: error.code }, error.status);

/**
 * Pre-auth invite preview (D166). The token comes in the JSON body only (the link carries it in
 * the URL fragment, which browsers never send), and is never logged.
 */
app.post("/api/auth/invite", async (c) => {
  if (rateLimited("invite:global", 30)) return c.json({ error: "Too many attempts. Try again soon.", code: "RATE_LIMITED" }, 429);
  const body = await parseJson(c.req.raw, invitePreviewSchema);
  try {
    return c.json(previewInvite(body.token));
  } catch (error) {
    if (error instanceof InviteError) return inviteErrorResponse(c, error);
    throw error;
  }
});

// Email verification and one-click unsubscribe work without a session (outbound email §A.4, §B.2).
registerPublicMailRoutes(app);
// Forgot / reset password (Wave 30, outbound email §A.5): no session, identical answers (T224).
registerPasswordResetRoutes(app);

app.post("/api/auth/register", async (c) => {
  const userCount = (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
  // The body is read first: only it can say whether an invite (D162) opens a closed instance.
  const body = await parseJson(c.req.raw, registerSchema);
  // D162: a valid invite bypasses ALLOW_REGISTRATION and nothing else.
  const inviteHash = body.inviteToken ? hashInviteToken(body.inviteToken) : null;
  if (!inviteHash && !config.allowRegistration && userCount > 0) return c.json({ error: "Registration is disabled" }, 403);
  if (rateLimited("register:global", 10)) return c.json({ error: "Too many attempts. Try again soon." }, 429);
  if (!isEmailAllowed(body.email)) return c.json({ error: "This email is not allowed to create an account" }, 403);
  try {
    // Checked before the account lookup, so a made-up token cannot probe which emails exist.
    if (inviteHash && userCount > 0) inviteForRegistration(inviteHash, body.email, now());
  } catch (error) {
    if (error instanceof InviteError) return inviteErrorResponse(c, error);
    throw error;
  }
  const exists = db.query("SELECT id FROM users WHERE email = ?").get(body.email);
  if (exists) return c.json({ error: "An account with that email already exists" }, 409);
  const id = crypto.randomUUID();
  const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  let role: UserRow["role"] = "member";
  try {
    db.transaction(() => {
      const currentCount = (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
      const timestamp = now();
      // An empty instance ignores any token: its first account is the admin (D163). Otherwise the
      // invite is re-checked here, in the transaction that claims it.
      const invite = inviteHash && currentCount > 0 ? inviteForRegistration(inviteHash, body.email, timestamp) : null;
      if (!invite && !config.allowRegistration && currentCount > 0) throw new HTTPException(403, { message: "Registration is disabled" });
      // D76: the first account on an empty instance is the admin, and so is an account registered
      // while no active admin exists (an upgrade where every account was disabled, so migration 017
      // had nobody to promote). The check and the insert share this transaction, so two concurrent
      // registrations cannot both become admin. A usable invite implies an active admin (D162).
      role = currentCount === 0 || !hasActiveAdmin() ? "admin" : invite ? invite.role : config.signupRole;
      db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, body.email, body.displayName, passwordHash, timestamp, role);
      if (role === "admin") recordBootstrapAdmin(id, timestamp);
      ensureDefaultFolder(id);
      if (invite) {
        // Single use (T141): a lost race throws INVITE_INVALID and rolls the new account back.
        claimInvite(invite.id, id, timestamp);
        // An invite bound to this address proved control of the inbox (D244).
        if (invite.email !== null) db.query("UPDATE users SET email_verified_at = ? WHERE id = ?").run(timestamp, id);
        audit(id, null, "team.invite_accept", { inviteId: invite.id, role });
      }
    })();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof InviteError) return inviteErrorResponse(c, error);
    if ((error as { code?: string }).code?.includes("CONSTRAINT")) return c.json({ error: "An account with that email already exists" }, 409);
    throw error;
  }
  const csrfToken = await createSession(c, id);
  audit(id, null, "auth.register");
  // Everyone else verifies their address before Nook sends them anything but security mail.
  enqueueVerifyMail(id);
  return c.json({
    user: { id, email: body.email, displayName: body.displayName, role },
    csrfToken,
    totp: { enabled: false, required: config.totpPolicy === "required", setupRequired: config.totpPolicy === "required" }
  }, 201);
});

app.post("/api/auth/login", async (c) => {
  const body = await parseJson(c.req.raw, loginSchema);
  if (rateLimited(`login:${body.email}`) || rateLimited("login:global", 50)) return c.json({ error: "Too many attempts. Try again soon." }, 429);
  // Blocked accounts are looked up too, so the block can be explained, but only after the right
  // password and before any second factor is consumed (T85). The reason is never shown (O11).
  const user = isEmailAllowed(body.email)
    ? db.query("SELECT * FROM users WHERE email = ?").get(body.email) as UserRow | null
    : null;
  const valid = user ? await Bun.password.verify(body.password, user.password_hash) : false;
  if (!user || !valid) {
    audit(user?.id ?? null, null, "auth.login_failed");
    return c.json({ error: "Invalid email or password" }, 401);
  }
  if (user.disabled_at !== null) {
    audit(user.id, null, "auth.login_blocked");
    return c.json({ error: "This account has been blocked. Contact your Nook administrator.", code: "ACCOUNT_BLOCKED" }, 403);
  }
  if (user.totp_enabled_at) {
    if (!body.totpCode && !body.recoveryCode) return c.json({ error: "Enter your six-digit authentication code", requiresTotp: true }, 428);
    const usedRecoveryCode = body.recoveryCode !== undefined;
    const validFactor = body.recoveryCode !== undefined
      ? consumeRecoveryCode(user, body.recoveryCode)
      : consumeTotp(user, body.totpCode!) !== null;
    if (!validFactor) {
      audit(user.id, null, "auth.totp_failed");
      return c.json({ error: "Invalid or already-used authentication or recovery code", requiresTotp: true }, 401);
    }
    if (usedRecoveryCode) {
      audit(user.id, null, "auth.recovery_code_used");
      mailTwoFactor(user.id, "recovery_used");
    }
  }
  const csrfToken = await createSession(c, user.id);
  audit(user.id, null, "auth.login");
  return c.json({
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    csrfToken,
    totp: totpState(user)
  });
});

app.use("/api/auth/me", requireAuth);
app.get("/api/auth/me", (c) => {
  const user = c.get("user");
  return c.json({
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
    csrfToken: c.get("csrfToken"),
    totp: totpState(user),
    // UI-only (D92): which modules this user hid. Never used for authorization (T97).
    preferences: readPreferences(user.id)
  });
});

app.use("/api/*", async (c, next) => {
  if (["/api/health", "/api/about", "/api/auth/login", "/api/auth/register", "/api/auth/invite"].includes(c.req.path)) return next();
  // Calendar feeds carry their own token (D66); only GET or HEAD of the exact feed pattern skips the session.
  if (isFeedRequest(c.req.method, c.req.path)) return next();
  return requireAuth(c, next);
});

app.use("/api/*", requireMutationSafety);

const totpSetupPaths = new Set([
  "/api/auth/logout",
  "/api/auth/totp/status",
  "/api/auth/totp/setup",
  "/api/auth/totp/enable"
]);
app.use("/api/*", async (c, next) => {
  if (["/api/health", "/api/about", "/api/auth/login", "/api/auth/register", "/api/auth/invite"].includes(c.req.path)) return next();
  // A feed token was created from a gated session and is read-only (T70).
  if (isFeedRequest(c.req.method, c.req.path)) return next();
  if (config.totpPolicy === "required" && !c.get("user").totp_enabled_at && !totpSetupPaths.has(c.req.path)) {
    return c.json({ error: "Two-factor authentication setup is required", code: "TOTP_SETUP_REQUIRED" }, 403);
  }
  await next();
});

// Viewers and guests read; every other write is refused unless allowlisted (D75, T87).
app.use("/api/*", roleWriteGate);

// Nook keys (Wave 31): /api/keys; /api/mcp/keys below stays as an alias for one release.
registerKeyRoutes(app);

// Settings → Security → Change password (Wave 30).
registerPasswordChangeRoute(app);

app.get("/api/mcp/keys", (c) => {
  const userId = c.get("user").id;
  // What each key moved to the Bin in the last 24 hours, for the key row's Review line (D175).
  const binned = binnedCountsByKey(userId, new Date(Date.now() - BINNED_WINDOWS["24h"]).toISOString());
  return c.json({ keys: listMcpApiKeys(userId).map((key) => ({ ...key, binnedToday: binned.get(key.id) ?? 0 })) });
});

// Review / Restore all for one key (Wave 19, D175): the key owner's only; anyone else gets 404.
app.get("/api/mcp/keys/:id/binned", (c) => {
  const keyId = uuid.parse(c.req.param("id"));
  const window = c.req.query("window") ?? "24h";
  if (!isBinnedWindow(window)) return c.json({ error: "Invalid request", details: ["window must be 1h, 24h, or 7d"] }, 400);
  const listed = listKeyBinned(c.get("user").id, keyId, window);
  return listed ? c.json(listed) : c.json({ error: "API key not found" }, 404);
});

app.post("/api/mcp/keys/:id/restore-binned", async (c) => {
  const keyId = uuid.parse(c.req.param("id"));
  const body = await parseJson(c.req.raw, restoreBinnedSchema);
  const result = await restoreKeyBinned(c.get("user").id, keyId, body.window);
  return result ? c.json(result) : c.json({ error: "API key not found" }, 404);
});

app.post("/api/mcp/keys", async (c) => {
  const body = await parseJson(c.req.raw, mcpApiKeySchema);
  const userId = c.get("user").id;
  // Checked before the password so no code is consumed: guests hold no keys (O6), viewers read
  // scopes only, and team:read is admin-only (T81).
  if (!can(c.get("user").role, "mcp.key.create")) {
    return c.json({ error: "Your team role cannot create API keys", code: "ROLE_READ_ONLY" }, 403);
  }
  const allowedScopes = mcpScopesForRole(c.get("user").role);
  if (body.scopes?.some((scope) => !allowedScopes.includes(scope))) {
    return c.json({ error: "Your team role cannot create a key with these permissions", code: "SCOPE_NOT_ALLOWED" }, 403);
  }
  // Nook keys (Wave 31): the alias obeys team policy (modules, MCP per role, key count) like /api/keys.
  const aliasRefusal = aliasKeyRefusal(c.get("user"), body.scopes ?? ["notes:read"]);
  if (aliasRefusal) return c.json({ error: aliasRefusal.message, code: aliasRefusal.code, ...aliasRefusal.details }, aliasRefusal.status);
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(userId) as UserRow | null;
  const passwordValid = user ? await Bun.password.verify(body.password, user.password_hash) : false;
  if (!user || !passwordValid) {
    audit(userId, null, "mcp.key_create_failed");
    return c.json({ error: "Invalid password or authentication code" }, 401);
  }
  if (user.totp_enabled_at) {
    const factorValid = body.recoveryCode ? consumeRecoveryCode(user, body.recoveryCode) : body.totpCode ? consumeTotp(user, body.totpCode) !== null : false;
    if (!factorValid) {
      audit(userId, null, "mcp.key_create_failed");
      return c.json({ error: "Invalid password or authentication code" }, 401);
    }
    if (body.recoveryCode) {
      audit(userId, null, "auth.recovery_code_used", { purpose: "mcp_key" });
      mailTwoFactor(userId, "recovery_used");
    }
  }
  const activeCount = liveKeyCount(userId);
  if (activeCount >= readPolicies().keysPerUser) return c.json({ error: "Revoke an existing API key before creating another", code: "KEY_LIMIT" }, 409);
  const key = createMcpApiKey(userId, body.name, body.scopes);
  // Security mail (outbound email #5): the key's name and scopes, read at send time.
  mailApiKeyCreated(userId, key.id);
  return c.json({ key }, 201);
});

app.delete("/api/mcp/keys/:id", (c) => {
  const keyId = uuid.parse(c.req.param("id"));
  if (!revokeMcpApiKey(c.get("user").id, keyId)) return c.json({ error: "API key not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  logoutCurrentSession(c);
  return c.json({ ok: true });
});

app.get("/api/auth/totp/status", (c) => {
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(c.get("user").id) as UserRow | null;
  if (!user) return c.json({ error: "Authentication required" }, 401);
  return c.json(totpState(user));
});

app.post("/api/auth/totp/setup", async (c) => {
  const body = await parseJson(c.req.raw, totpSetupSchema);
  const current = c.get("user");
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(current.id) as UserRow | null;
  if (!user) return c.json({ error: "Authentication required" }, 401);
  if (user.totp_enabled_at) return c.json({ error: "Two-factor authentication is already enabled" }, 409);
  if (!config.totpEncryptionKey) return c.json({ error: "Two-factor authentication is not configured on this service" }, 503);
  if (rateLimited(`totp-setup:${user.id}`, 5)) return c.json({ error: "Too many setup attempts. Try again soon." }, 429);
  if (!await Bun.password.verify(body.password, user.password_hash)) {
    audit(user.id, null, "auth.totp_setup_password_failed");
    return c.json({ error: "Invalid password" }, 400);
  }
  const secret = createTotpSecret();
  const encryptedSecret = encryptTotpSecret(secret, config.totpEncryptionKey, user.id);
  db.query("UPDATE users SET totp_secret = ?, totp_last_counter = NULL WHERE id = ? AND totp_enabled_at IS NULL").run(encryptedSecret, user.id);
  audit(user.id, null, "auth.totp_setup_started");
  return c.json({ secret, uri: totpUri(secret, user.email) });
});

app.post("/api/auth/totp/enable", async (c) => {
  const body = await parseJson(c.req.raw, totpCodeSchema);
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(c.get("user").id) as UserRow | null;
  if (!user) return c.json({ error: "Authentication required" }, 401);
  if (user.totp_enabled_at) return c.json({ error: "Two-factor authentication is already enabled" }, 409);
  const acceptedCounter = consumeTotp(user, body.code);
  if (acceptedCounter === null) {
    audit(user.id, null, "auth.totp_enable_failed");
    return c.json({ error: "Invalid or expired authentication code" }, 400);
  }
  const timestamp = now();
  const recoveryCodes = createRecoveryCodes();
  const encryptedRecoveryCodes = encryptRecoveryCodes(recoveryCodes, config.totpEncryptionKey!, user.id);
  const enabled = db.transaction(() => {
    const result = db.query("UPDATE users SET totp_enabled_at = ?, totp_recovery_codes = ? WHERE id = ? AND totp_enabled_at IS NULL AND totp_secret = ? AND totp_last_counter = ?")
      .run(timestamp, encryptedRecoveryCodes, user.id, user.totp_secret, acceptedCounter);
    if (result.changes !== 1) return false;
    db.query("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, c.get("sessionId"));
    mailTwoFactor(user.id, "enabled");
    return true;
  })();
  if (!enabled) return c.json({ error: "Authenticator setup changed. Start setup again." }, 409);
  audit(user.id, null, "auth.totp_enabled");
  return c.json({ enabled: true, required: config.totpPolicy === "required", setupRequired: false, recoveryCodes });
});

app.post("/api/auth/totp/recovery-codes", async (c) => {
  const body = await parseJson(c.req.raw, totpRecoveryViewSchema);
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(c.get("user").id) as UserRow | null;
  if (!user?.totp_enabled_at || !user.totp_recovery_codes || !config.totpEncryptionKey) {
    return c.json({ error: "Recovery codes are not available" }, 409);
  }
  if (!await Bun.password.verify(body.password, user.password_hash) || consumeTotp(user, body.code) === null) {
    audit(user.id, null, "auth.totp_recovery_view_failed");
    return c.json({ error: "Invalid password or authentication code" }, 400);
  }
  try {
    const recoveryCodes = decryptRecoveryCodes(user.totp_recovery_codes, config.totpEncryptionKey, user.id);
    audit(user.id, null, "auth.totp_recovery_viewed", { remaining: recoveryCodes.length });
    return c.json({ recoveryCodes });
  } catch {
    audit(user.id, null, "auth.totp_recovery_unreadable");
    return c.json({ error: "Recovery codes are unavailable" }, 409);
  }
});

app.post("/api/auth/totp/recovery-codes/regenerate", async (c) => {
  const body = await parseJson(c.req.raw, totpRecoveryViewSchema);
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(c.get("user").id) as UserRow | null;
  if (!user?.totp_enabled_at || !config.totpEncryptionKey) return c.json({ error: "Two-factor authentication is not enabled" }, 409);
  if (!await Bun.password.verify(body.password, user.password_hash) || consumeTotp(user, body.code) === null) {
    audit(user.id, null, "auth.totp_recovery_regenerate_failed");
    return c.json({ error: "Invalid password or authentication code" }, 400);
  }
  const recoveryCodes = createRecoveryCodes();
  const encrypted = encryptRecoveryCodes(recoveryCodes, config.totpEncryptionKey, user.id);
  db.query("UPDATE users SET totp_recovery_codes = ? WHERE id = ?").run(encrypted, user.id);
  audit(user.id, null, "auth.totp_recovery_regenerated", { count: recoveryCodes.length });
  mailTwoFactor(user.id, "recovery_regenerated", recoveryCodes.length);
  return c.json({ recoveryCodes });
});

app.delete("/api/auth/totp", async (c) => {
  if (config.totpPolicy === "required") return c.json({ error: "Two-factor authentication is required for this service" }, 409);
  const body = await parseJson(c.req.raw, totpDisableSchema);
  const user = db.query("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL").get(c.get("user").id) as UserRow | null;
  if (!user?.totp_enabled_at) return c.json({ error: "Two-factor authentication is not enabled" }, 409);
  if (!await Bun.password.verify(body.password, user.password_hash)) return c.json({ error: "Invalid password or authentication code" }, 400);
  const acceptedCounter = consumeTotp(user, body.code);
  if (acceptedCounter === null) return c.json({ error: "Invalid or already-used authentication code" }, 400);
  db.transaction(() => {
    const result = db.query("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_counter = NULL, totp_recovery_codes = NULL WHERE id = ? AND totp_secret = ? AND totp_last_counter = ?")
      .run(user.id, user.totp_secret, acceptedCounter);
    if (result.changes !== 1) throw new Error("Concurrent authenticator update detected");
    db.query("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(user.id, c.get("sessionId"));
    mailTwoFactor(user.id, "disabled");
  })();
  audit(user.id, null, "auth.totp_disabled");
  return c.json({ enabled: false, required: false, setupRequired: false });
});

app.get("/api/users", (c) => {
  const currentUser = c.get("user");
  // The share picker: read-only roles cannot share, so they get no directory either (§2.2).
  if (!can(currentUser.role, "sharing.write")) return c.json(ROLE_READ_ONLY_BODY, 403);
  // With the share_with_guests policy off, guests are left out of the picker (Wave 32, D.2, T213).
  const guests = readPolicies().shareWithGuests ? "" : " AND role <> 'guest'";
  const users = db.query(`SELECT id, display_name, role FROM users WHERE id != ? AND disabled_at IS NULL${guests} ORDER BY display_name LIMIT 100`)
    .all(currentUser.id) as Array<{ id: string; display_name: string; role: UserRow["role"] }>;
  // `role` lets the picker hint that a viewer or guest will only read (§2.2 notes).
  return c.json({ users: users.map((user) => ({ id: user.id, displayName: user.display_name, role: user.role })) });
});

app.get("/api/folders", (c) => c.json({ folders: listReadableFolders(c.get("user").id) }));

app.post("/api/folders", async (c) => {
  const body = await parseJson(c.req.raw, folderSchema);
  try {
    return c.json({ folder: createFolder(c.get("user").id, body.name, body.parentId ?? null) }, 201);
  } catch (error) {
    if (error instanceof FolderError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

app.patch("/api/folders/:id", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await parseJson(c.req.raw, folderSchema.partial().strict());
  const userId = c.get("user").id;
  const folder = db.query("SELECT id, is_default FROM folders WHERE id = ? AND owner_id = ?").get(id, userId) as { id: string; is_default: number } | null;
  if (!folder) return c.json({ error: "Folder not found" }, 404);
  if (folder.is_default) return c.json({ error: "The Default folder cannot be changed" }, 409);
  if (body.parentId === id) return c.json({ error: "A folder cannot contain itself" }, 400);
  if (body.parentId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(body.parentId, userId)) {
    return c.json({ error: "Parent folder not found" }, 404);
  }
  db.query("UPDATE folders SET name = COALESCE(?, name), parent_id = CASE WHEN ? THEN ? ELSE parent_id END, updated_at = ? WHERE id = ?")
    .run(body.name ?? null, Object.hasOwn(body, "parentId") ? 1 : 0, body.parentId ?? null, now(), id);
  return c.json({ ok: true });
});

app.delete("/api/folders/:id", (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const result = db.query("DELETE FROM folders WHERE id = ? AND owner_id = ? AND is_default = 0").run(id, userId);
  return result.changes ? c.json({ ok: true }) : c.json({ error: "Folder not found" }, 404);
});

app.get("/api/folders/:id/sharing", (c) => {
  const id = uuid.parse(c.req.param("id"));
  const folder = db.query("SELECT id, visibility FROM folders WHERE id = ? AND owner_id = ?").get(id, c.get("user").id) as { id: string; visibility: "private" | "selected" | "all_users" } | null;
  if (!folder) return c.json({ error: "Folder not found" }, 404);
  const users = db.query("SELECT u.id, u.display_name FROM folder_shares fs JOIN users u ON u.id = fs.user_id WHERE fs.folder_id = ? ORDER BY u.display_name")
    .all(id);
  return c.json({ visibility: folder.visibility, users });
});

app.put("/api/folders/:id/sharing", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const folder = db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(id, userId);
  if (!folder) return c.json({ error: "Folder not found" }, 404);
  const body = await parseJson(c.req.raw, folderSharingSchema);
  if (body.userIds.includes(userId)) return c.json({ error: "The owner cannot be added as a recipient" }, 400);
  const uniqueIds = [...new Set(body.userIds)];
  if (body.visibility === "selected" && uniqueIds.length === 0) return c.json({ error: "Select at least one user" }, 400);
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const validUsers = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
    if (validUsers.length !== uniqueIds.length) return c.json({ error: "One or more users were not found" }, 400);
  }
  if (body.visibility === "selected" && legacyGuestShareBlocked("folder", id, legacyShareLevels("folder", id, uniqueIds, "view"))) return c.json(GUEST_SHARE_DISABLED, 400);
  db.transaction(() => {
    const before = shareMembers("folder_shares", "folder_id", id);
    // Levels are kept for people already shared with (D272); group grants are left as they are.
    writeDirectShares("folder", id, body.visibility === "selected" ? legacyShareLevels("folder", id, uniqueIds, "view") : []);
    if (body.visibility === "selected") {
      // "Shared with you" mail for people newly added by name (outbound email #25, D239).
      mailShared(userId, "folder", id, before, uniqueIds);
    }
    db.query("UPDATE folders SET visibility = ?, updated_at = ? WHERE id = ? AND owner_id = ?").run(body.visibility, now(), id, userId);
  })();
  audit(userId, null, "folder.sharing_changed", { folderId: id, visibility: body.visibility, recipientCount: uniqueIds.length });
  return c.json({ ok: true });
});

app.get("/api/notes", (c) => {
  const userId = c.get("user").id;
  const folderId = c.req.query("folderId");
  if (folderId) uuid.parse(folderId);
  const rows = db.query(`
    SELECT n.id, n.owner_id,
           ${visibleNoteFolderIdExpression} AS folder_id,
           n.title,
           CASE WHEN n.sharing_override = 0 THEN COALESCE(f.visibility, 'private') ELSE n.visibility END AS visibility,
           n.current_version,
           n.draft_revision, n.created_at, n.updated_at, u.display_name AS owner_name,
           CASE WHEN n.owner_id = $userId THEN 1 ELSE 0 END AS is_owner,
           CASE WHEN n.owner_id = $userId AND n.draft_revision IS NOT NULL THEN k.name ELSE NULL END AS draft_mcp_key_name
    FROM notes n JOIN users u ON u.id = n.owner_id LEFT JOIN folders f ON f.id = n.folder_id
    LEFT JOIN mcp_api_keys k ON k.id = n.draft_mcp_key_id
    WHERE n.deleted_at IS NULL AND ${readableNotePredicate} AND ($folderId IS NULL OR n.folder_id = $folderId)
    ORDER BY n.updated_at DESC LIMIT 500
  `).all({ userId, folderId: folderId ?? null });
  return c.json({ notes: rows });
});

app.post("/api/notes", async (c) => {
  const body = await parseJson(c.req.raw, noteCreateSchema);
  const userId = c.get("user").id;
  if (body.folderId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(body.folderId, userId)) {
    return c.json({ error: "Folder not found" }, 404);
  }
  const created = await createDraftNote(userId, body.folderId ?? null, "");
  return c.json({ note: { id: created.id, title: created.title, folder_id: created.folderId, current_version: 0, draft_revision: created.revision } }, 201);
});

app.get("/api/notes/:id", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const note = readableNote(id, userId);
  if (!note) return c.json({ error: "Note not found" }, 404);
  const isOwner = note.owner_id === userId;
  // Editors (Wave 32, D274) open the shared draft, as the owner does, and write and publish it.
  const level = noteLevel(note, userId);
  const canEdit = isOwner || editableNote(id, userId) !== null;
  let markdown: string;
  let expectedChecksum: string | null;
  if (canEdit && note.draft_revision !== null) {
    markdown = await storage.readDraft(id);
    expectedChecksum = note.draft_checksum;
  } else {
    if (note.current_version < 1) return c.json({ error: "Note has not been published" }, 409);
    const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, note.current_version) as { checksum: string } | null;
    if (!metadata) throw new Error("Published version metadata is missing");
    markdown = await storage.readVersion(id, note.current_version);
    expectedChecksum = metadata.checksum;
  }
  if (!expectedChecksum || checksum(markdown) !== expectedChecksum) throw new Error("Note content failed integrity verification");
  const { draft_mcp_key_id: draftMcpKeyId, ...visible } = note;
  const draftMcpKeyName = isOwner && note.draft_revision !== null && draftMcpKeyId
    ? (db.query("SELECT name FROM mcp_api_keys WHERE id = ?").get(draftMcpKeyId) as { name: string } | null)?.name ?? null
    : null;
  return c.json({
    note: {
      ...visible,
      draftMcpKeyName,
      // The client shows "Shared by <owner>" to recipients; the row alone has only the owner id.
      owner_name: (db.query("SELECT display_name FROM users WHERE id = ?").get(note.owner_id) as { display_name: string } | null)?.display_name ?? "",
      isOwner,
      level,
      canEdit,
      hasDraft: note.draft_revision !== null,
      hasDelta: canEdit && note.draft_revision !== null && expectedChecksum !== null
        ? hasDraftDelta(note, expectedChecksum)
        : false,
      markdown
    }
  });
});

app.patch("/api/notes/:id", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await parseJson(c.req.raw, noteMetaSchema);
  return withNoteLock(id, async () => {
    const note = ownedNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    if (body.folderId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(body.folderId, userId)) {
      return c.json({ error: "Folder not found" }, 404);
    }
    db.query("UPDATE notes SET folder_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND draft_revision IS ?")
      .run(body.folderId ?? null, now(), id, userId, note.draft_revision);
    return c.json({ ok: true });
  });
});

app.put("/api/notes/:id/draft", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await parseJson(c.req.raw, draftSchema);
  if (Buffer.byteLength(body.markdown, "utf8") > config.maxMarkdownBytes) return c.json({ error: "Note is too large" }, 413);
  return withNoteLock(id, async () => {
    // The owner or an editor (D274); a reader who cannot write gets the same 404 as a stranger.
    const note = editableNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    if (body.revision !== note.draft_revision) {
      return c.json({ error: "Draft changed in another session", currentRevision: note.draft_revision }, 409);
    }
    const saved = await writeDraftLocked(note, userId, body.markdown);
    if (!saved) return c.json({ error: "Draft changed in another session" }, 409);
    return c.json(saved);
  });
});

app.delete("/api/notes/:id/draft", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  try {
    // Discarding a never-published note deletes it: blank ones are purged, anything with content
    // moves to the Bin with its draft (and draft revision) intact (server/noteDrafts.ts).
    return c.json(await discardDraft(c.get("user").id, id));
  } catch (error) {
    if (error instanceof DraftActionError) return c.json(error.body, error.status);
    throw error;
  }
});

app.post("/api/notes/:id/publish", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await parseJson(c.req.raw, publishSchema);
  try {
    // The caller publishes the draft revision it last saw (T38), in server/noteDrafts.ts.
    return c.json(await publishDraft(c.get("user").id, id, body.revision, { allowEditors: true }));
  } catch (error) {
    if (error instanceof DraftActionError) return c.json(error.body, error.status);
    throw error;
  }
});

app.get("/api/notes/:id/versions", (c) => {
  const id = uuid.parse(c.req.param("id"));
  const note = readableNote(id, c.get("user").id);
  if (!note) return c.json({ error: "Note not found" }, 404);
  const versions = db.query(`
    SELECT v.id, v.version_number, v.title, v.checksum, v.created_at, u.display_name AS author_name
    FROM note_versions v JOIN users u ON u.id = v.author_id
    WHERE v.note_id = ? ORDER BY v.version_number DESC
  `).all(id);
  return c.json({ versions });
});

app.get("/api/notes/:id/versions/:version", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const version = Number(c.req.param("version"));
  if (!Number.isSafeInteger(version) || version < 1) return c.json({ error: "Invalid version" }, 400);
  const note = readableNote(id, c.get("user").id);
  if (!note) return c.json({ error: "Note not found" }, 404);
  const metadata = db.query("SELECT id, version_number, title, checksum, created_at FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, version) as { checksum: string } | null;
  if (!metadata) return c.json({ error: "Version not found" }, 404);
  const markdown = await storage.readVersion(id, version);
  if (checksum(markdown) !== metadata.checksum) throw new Error("Version content failed integrity verification");
  return c.json({ version: metadata, markdown });
});

app.post("/api/notes/:id/versions/:version/restore", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const version = Number(c.req.param("version"));
  if (!Number.isSafeInteger(version) || version < 1) return c.json({ error: "Invalid version" }, 400);
  const userId = c.get("user").id;
  return withNoteLock(id, async () => {
    const note = ownedNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    const metadata = db.query("SELECT title, checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, version) as { title: string; checksum: string } | null;
    if (!metadata) return c.json({ error: "Version not found" }, 404);
    const markdown = await storage.readVersion(id, version);
    if (checksum(markdown) !== metadata.checksum) throw new Error("Version content failed integrity verification");
    await storage.writeDraft(id, markdown);
    const revision = (note.draft_revision ?? 0) + 1;
    db.transaction(() => {
      // The restored text is the owner's choice, so the draft is no longer an MCP key's.
      const result = db.query("UPDATE notes SET title = ?, draft_revision = ?, draft_checksum = ?, draft_mcp_key_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND draft_revision IS ?")
        .run(metadata.title, revision, metadata.checksum, now(), id, userId, note.draft_revision);
      if (result.changes === 1) {
        indexNote(id, "draft", metadata.title, markdown, metadata.checksum);
        // The restored text replaces an agent's draft, so its note_draft proposal is superseded (D149).
        resolveNoteDraftProposals(id, { kind: "restored" });
      }
    })();
    audit(userId, id, "version.restore_to_draft", { version });
    return c.json({ revision });
  });
});

app.get("/api/notes/:id/sharing", (c) => {
  const id = uuid.parse(c.req.param("id"));
  const note = ownedNote(id, c.get("user").id);
  if (!note) return c.json({ error: "Note not found" }, 404);
  const users = db.query("SELECT u.id, u.display_name FROM note_shares s JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY u.display_name")
    .all(id);
  return c.json({ visibility: note.sharing_override ? note.visibility : "inherit", users });
});

app.put("/api/notes/:id/sharing", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await parseJson(c.req.raw, sharingSchema);
  if (body.userIds.includes(userId)) return c.json({ error: "The owner cannot be added as a recipient" }, 400);
  const uniqueIds = [...new Set(body.userIds)];
  if (body.visibility === "selected" && uniqueIds.length === 0) return c.json({ error: "Select at least one user" }, 400);
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => "?").join(",");
    const validUsers = db.query(`SELECT id FROM users WHERE disabled_at IS NULL AND id IN (${placeholders})`).all(...uniqueIds);
    if (validUsers.length !== uniqueIds.length) return c.json({ error: "One or more users were not found" }, 400);
  }
  if (body.visibility === "selected" && legacyGuestShareBlocked("note", id, legacyShareLevels("note", id, uniqueIds, "view"))) return c.json(GUEST_SHARE_DISABLED, 400);
  // Ownership and the Bin check run under the note lock, so a note binned or purged
  // meanwhile is refused instead of having its retained shares rewritten.
  return withNoteLock(id, async () => {
    if (!ownedNote(id, userId)) return c.json({ error: "Note not found" }, 404);
    db.transaction(() => {
      const before = shareMembers("note_shares", "note_id", id);
      // Levels are kept for people already shared with (D272); group grants are left as they are.
      writeDirectShares("note", id, body.visibility === "selected" ? legacyShareLevels("note", id, uniqueIds, "view") : []);
      if (body.visibility === "selected") {
        mailShared(userId, "note", id, before, uniqueIds);
      }
      const visibility = body.visibility === "inherit" ? "private" : body.visibility;
      db.query("UPDATE notes SET visibility = ?, sharing_override = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
        .run(visibility, body.visibility === "inherit" ? 0 : 1, now(), id, userId);
    })();
    audit(userId, id, "note.sharing_changed", { visibility: body.visibility, recipientCount: uniqueIds.length });
    return c.json({ ok: true });
  });
});

app.delete("/api/notes/:id", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  return withNoteLock(id, async () => {
    const note = ownedNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    if (await isBlankNote(note)) return c.json(await purgeBlankNote(note, userId));
    return c.json(moveNoteToBin(note, userId));
  });
});

registerDocumentRoutes(app);
registerBinRoutes(app);
registerSearchRoutes(app);
registerTaskRoutes(app);
registerReactionRoutes(app);
registerSprintRoutes(app);
registerTodayRoutes(app);
registerCollectionRoutes(app);
registerCalendarRoutes(app);
registerPreferenceRoutes(app);
registerMailRoutes(app);
registerMailLogRoutes(app);
registerTeamRoutes(app);
registerInboxRoutes(app);
// The Access sheet's GET/PUT …/access for the seven shareable kinds (Wave 32, access plan §C.5).
registerItemAccessRoutes(app);

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError) return c.json({ error: "Invalid request", details: error.issues.map((issue) => issue.message) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
  console.error("Request failed", errorClass(error));
  return c.json({ error: "Something went wrong" }, 500);
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.all("/mcp", (c) => handleMcpRequest(c.req.raw));
// Ticketed MCP uploads (Wave 19, D176): the same Bearer key that called begin_upload.
app.put("/mcp/uploads/:uploadId", (c) => handleMcpUpload(c.req.raw, c.req.param("uploadId")));

// Dev-only mail preview (D253); in production every /dev path answers 404 (T232).
registerMailPreviewRoutes(app);

// The service worker must be revalidated on every registration check (T69).
app.use("/sw.js", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-cache");
});

if (config.isProduction) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("/*", serveStatic({ path: "./dist/index.html" }));
}

async function reconcilePublishedMirrors() {
  const notes = db.query("SELECT id, current_version, draft_revision FROM notes WHERE deleted_at IS NULL AND current_version > 0").all() as Array<{ id: string; current_version: number; draft_revision: number | null }>;
  for (const note of notes) {
    try {
      const metadata = db.query("SELECT checksum FROM note_versions WHERE note_id = ? AND version_number = ?").get(note.id, note.current_version) as { checksum: string } | null;
      if (!metadata) throw new Error("Version metadata is missing");
      const markdown = await storage.readVersion(note.id, note.current_version);
      if (checksum(markdown) !== metadata.checksum) throw new Error("Version checksum does not match");
      await storage.writeCurrentMirror(note.id, markdown);
      if (note.draft_revision === null) await storage.discardDraft(note.id);
    } catch (error) {
      console.error(`Could not reconcile note ${note.id}`, errorClass(error));
    }
  }
}

await reconcilePublishedMirrors();
// Migrations ran when ./db loaded: say so loudly when the team has nobody who can manage it.
warnIfNoActiveAdmin();
try {
  await reconcileSearchIndex();
} catch (error) {
  console.error("Search index reconcile failed", errorClass(error));
}
try {
  reconcileCollectionSearchIndex();
} catch (error) {
  console.error("Collection search index reconcile failed", errorClass(error));
}
try {
  await reconcileEventNextOccurrences();
} catch (error) {
  console.error("Calendar range index reconcile failed", errorClass(error));
}
try {
  reconcileCardExcerpts();
} catch (error) {
  console.error("Card excerpt reconcile failed", errorClass(error));
}
startSweeper();
// Nook key usage counts (D283) are kept in memory and written once a minute.
startKeyUsageFlusher();
try {
  await initPush();
} catch (error) {
  console.error("Web Push setup failed; reminders still appear in the app", errorClass(error));
}
startDispatcher();
startMailDispatcher();

export default {
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Uploads need a larger transport cap; JSON and MCP bodies are bounded separately while reading.
  maxRequestBodySize: Math.max(config.maxUploadBytes, JSON_BODY_LIMIT_BYTES) + 1_048_576
};
