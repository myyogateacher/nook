import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { config, isEmailAllowed, isOriginAllowed } from "./config";
import { audit, db, ensureDefaultFolder, now, type NoteRow, type UserRow } from "./db";
import { createSession, logoutCurrentSession, requireAuth, requireMutationSafety, type AppEnv } from "./auth";
import { listReadableFolders, ownedNote, readableNote, readableNotePredicate, visibleNoteFolderIdExpression } from "./access";
import { checksum, storage, withNoteLock } from "./storage";
import { startSweeper } from "./sweeper";
import { startDispatcher } from "./calendar/reminders";
import { initPush } from "./calendar/push";
import { reconcileEventNextOccurrences } from "./calendar/service";
import { reconcileCardExcerpts } from "./tasks/excerpt";
import { purgeAfterFrom, purgeLocked } from "./bin";
import { registerBinRoutes } from "./binRoutes";
import { indexNote, reconcileSearchIndex, unindexNote } from "./searchIndex";
import { createDraftNote, hasDraftDelta, writeDraftLocked } from "./noteDrafts";
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
import { registerTeamRoutes } from "./team/routes";
import { hasActiveAdmin, recordBootstrapAdmin, warnIfNoActiveAdmin } from "./team/service";
import { can, mcpScopesForRole } from "./team/roles";
import { ROLE_READ_ONLY_BODY, roleWriteGate } from "./team/writeGate";
import {
  draftSchema,
  folderSharingSchema,
  folderSchema,
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

/**
 * A note is blank when it was never published and has no draft, or only a
 * whitespace draft (the client's `markdown.trim() === ""` check). The draft is
 * read, not inferred from its checksum. Call under the note lock.
 */
async function isBlankNote(note: NoteRow) {
  if (note.current_version !== 0) return false;
  if (note.draft_revision === null) return true;
  try {
    return (await storage.readDraft(note.id)).trim() === "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Moves a live note to the Bin for 30 days. Drafts, versions, files, and shares are kept. Call under the note lock. */
function moveNoteToBin(note: NoteRow, userId: string) {
  const deletedAt = new Date();
  const purgeAfter = purgeAfterFrom(deletedAt);
  db.transaction(() => {
    const result = db.query("UPDATE notes SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
      .run(deletedAt.toISOString(), userId, purgeAfter, note.id, userId);
    if (result.changes !== 1) throw new Error("Concurrent note update detected");
    audit(userId, note.id, "note.delete");
  })();
  return { ok: true as const, purgeAfter };
}

/** D12: blank never-published notes skip the Bin and are purged at once. Call under the note lock. */
async function purgeBlankNote(note: NoteRow, userId: string) {
  const timestamp = now();
  const result = db.query("UPDATE notes SET deleted_at = ?, deleted_by = ?, purge_after = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL")
    .run(timestamp, userId, timestamp, note.id, userId);
  if (result.changes !== 1) throw new Error("Concurrent note update detected");
  const outcome = await purgeLocked("note", note.id, { reason: "blank", actorId: userId, ownerId: userId });
  // A pending purge is already unreadable; the sweeper finishes removing it.
  return outcome === "pending" ? { ok: true as const, purged: true as const, pending: true as const } : { ok: true as const, purged: true as const };
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
app.get("/api/about", (c) => c.json({ version: config.appVersion, gitSha: config.gitSha }));

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
}

app.post("/api/auth/register", async (c) => {
  const userCount = (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
  if (!config.allowRegistration && userCount > 0) return c.json({ error: "Registration is disabled" }, 403);
  if (rateLimited("register:global", 10)) return c.json({ error: "Too many attempts. Try again soon." }, 429);
  const body = await parseJson(c.req.raw, registerSchema);
  if (!isEmailAllowed(body.email)) return c.json({ error: "This email is not allowed to create an account" }, 403);
  const exists = db.query("SELECT id FROM users WHERE email = ?").get(body.email);
  if (exists) return c.json({ error: "An account with that email already exists" }, 409);
  const id = crypto.randomUUID();
  const passwordHash = await Bun.password.hash(body.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  let role: UserRow["role"] = "member";
  try {
    db.transaction(() => {
      const currentCount = (db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
      if (!config.allowRegistration && currentCount > 0) throw new HTTPException(403, { message: "Registration is disabled" });
      // D76: the first account on an empty instance is the admin, and so is an account registered
      // while no active admin exists (an upgrade where every account was disabled, so migration 017
      // had nobody to promote). The check and the insert share this transaction, so two concurrent
      // registrations cannot both become admin.
      role = currentCount === 0 || !hasActiveAdmin() ? "admin" : config.signupRole;
      const timestamp = now();
      db.query("INSERT INTO users (id, email, display_name, password_hash, created_at, role) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, body.email, body.displayName, passwordHash, timestamp, role);
      if (role === "admin") recordBootstrapAdmin(id, timestamp);
      ensureDefaultFolder(id);
    })();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if ((error as { code?: string }).code?.includes("CONSTRAINT")) return c.json({ error: "An account with that email already exists" }, 409);
    throw error;
  }
  const csrfToken = await createSession(c, id);
  audit(id, null, "auth.register");
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
    if (usedRecoveryCode) audit(user.id, null, "auth.recovery_code_used");
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
  if (["/api/health", "/api/about", "/api/auth/login", "/api/auth/register"].includes(c.req.path)) return next();
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
  if (["/api/health", "/api/about", "/api/auth/login", "/api/auth/register"].includes(c.req.path)) return next();
  // A feed token was created from a gated session and is read-only (T70).
  if (isFeedRequest(c.req.method, c.req.path)) return next();
  if (config.totpPolicy === "required" && !c.get("user").totp_enabled_at && !totpSetupPaths.has(c.req.path)) {
    return c.json({ error: "Two-factor authentication setup is required", code: "TOTP_SETUP_REQUIRED" }, 403);
  }
  await next();
});

// Viewers and guests read; every other write is refused unless allowlisted (D75, T87).
app.use("/api/*", roleWriteGate);

app.get("/api/mcp/keys", (c) => c.json({ keys: listMcpApiKeys(c.get("user").id) }));

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
    if (body.recoveryCode) audit(userId, null, "auth.recovery_code_used", { purpose: "mcp_key" });
  }
  const activeCount = (db.query("SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { count: number }).count;
  if (activeCount >= 10) return c.json({ error: "Revoke an existing API key before creating another" }, 409);
  return c.json({ key: createMcpApiKey(userId, body.name, body.scopes) }, 201);
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
  })();
  audit(user.id, null, "auth.totp_disabled");
  return c.json({ enabled: false, required: false, setupRequired: false });
});

app.get("/api/users", (c) => {
  const currentUser = c.get("user");
  // The share picker: read-only roles cannot share, so they get no directory either (§2.2).
  if (!can(currentUser.role, "sharing.write")) return c.json(ROLE_READ_ONLY_BODY, 403);
  const users = db.query("SELECT id, display_name, role FROM users WHERE id != ? AND disabled_at IS NULL ORDER BY display_name LIMIT 100")
    .all(currentUser.id) as Array<{ id: string; display_name: string; role: UserRow["role"] }>;
  // `role` lets the picker hint that a viewer or guest will only read (§2.2 notes).
  return c.json({ users: users.map((user) => ({ id: user.id, displayName: user.display_name, role: user.role })) });
});

app.get("/api/folders", (c) => c.json({ folders: listReadableFolders(c.get("user").id) }));

app.post("/api/folders", async (c) => {
  const body = await parseJson(c.req.raw, folderSchema);
  const userId = c.get("user").id;
  if (body.name.toLowerCase() === "default") return c.json({ error: "The Default folder already exists" }, 409);
  if (body.parentId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(body.parentId, userId)) {
    return c.json({ error: "Parent folder not found" }, 404);
  }
  const id = crypto.randomUUID();
  const timestamp = now();
  db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, body.parentId ?? null, body.name, timestamp, timestamp);
  return c.json({ folder: { id, parent_id: body.parentId ?? null, name: body.name, created_at: timestamp, updated_at: timestamp } }, 201);
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
  db.transaction(() => {
    db.query("DELETE FROM folder_shares WHERE folder_id = ?").run(id);
    if (body.visibility === "selected") {
      const statement = db.query("INSERT INTO folder_shares (folder_id, user_id, created_at) VALUES (?, ?, ?)");
      for (const recipientId of uniqueIds) statement.run(id, recipientId, now());
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
  let markdown: string;
  let expectedChecksum: string | null;
  if (isOwner && note.draft_revision !== null) {
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
      isOwner,
      hasDraft: note.draft_revision !== null,
      hasDelta: isOwner && note.draft_revision !== null && expectedChecksum !== null
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
    const note = ownedNote(id, userId);
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
  const userId = c.get("user").id;
  return withNoteLock(id, async () => {
    const note = ownedNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    if (note.current_version === 0) {
      // Discarding a never-published note deletes it: blank ones are purged, anything
      // with content moves to the Bin with its draft (and draft revision) intact.
      if (await isBlankNote(note)) return c.json(await purgeBlankNote(note, userId));
      return c.json({ ...moveNoteToBin(note, userId), binned: true });
    }
    const versionTitle = db.query("SELECT title FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, note.current_version) as { title: string } | null;
    db.transaction(() => {
      db.query("UPDATE notes SET title = ?, draft_revision = NULL, draft_checksum = NULL, draft_mcp_key_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?")
        .run(versionTitle?.title ?? note.title, now(), id, userId);
      unindexNote(id, "draft");
    })();
    await storage.discardDraft(id).catch((error) => console.error(`Could not remove discarded draft for note ${id}`, errorClass(error)));
    audit(userId, id, "draft.discard");
    return c.json({ ok: true });
  });
});

app.post("/api/notes/:id/publish", async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const userId = c.get("user").id;
  const body = await parseJson(c.req.raw, publishSchema);
  return withNoteLock(id, async () => {
    const note = ownedNote(id, userId);
    if (!note) return c.json({ error: "Note not found" }, 404);
    if (note.draft_revision === null) return c.json({ error: "There is no draft to publish" }, 409);
    // The caller publishes the draft revision it last saw (T38). Older clients that send no
    // revision may still publish their own draft, but never one an MCP key wrote.
    if (body.revision === undefined && note.draft_mcp_key_id !== null) {
      return c.json({ error: "Invalid request", details: ["revision is required to publish a draft written through MCP"] }, 400);
    }
    if (body.revision !== undefined && body.revision !== note.draft_revision) {
      return c.json({ error: "Draft changed since you last saw it", code: "DRAFT_CHANGED", currentRevision: note.draft_revision }, 409);
    }
    const markdown = await storage.readDraft(id);
    if (!note.draft_checksum || checksum(markdown) !== note.draft_checksum) throw new Error("Draft content failed integrity verification");
    if (!hasDraftDelta(note, note.draft_checksum)) return c.json({ error: "Draft matches the published version" }, 409);
    const nextVersion = note.current_version + 1;
    const stagedMetadata = db.query("SELECT id FROM note_versions WHERE note_id = ? AND version_number = ?").get(id, nextVersion);
    if (stagedMetadata) throw new Error("Next version is already committed");
    await storage.stageVersion(id, nextVersion, markdown, true);
    const timestamp = now();
    const versionId = crypto.randomUUID();
    db.transaction(() => {
      db.query("INSERT INTO note_versions (id, note_id, version_number, title, checksum, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(versionId, id, nextVersion, note.title, checksum(markdown), userId, timestamp);
      const updated = db.query("UPDATE notes SET current_version = ?, draft_revision = NULL, draft_checksum = NULL, draft_mcp_key_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND current_version = ? AND draft_revision = ?")
        .run(nextVersion, timestamp, id, userId, note.current_version, note.draft_revision);
      if (updated.changes !== 1) throw new Error("Concurrent note update detected");
      indexNote(id, "published", note.title, markdown, note.draft_checksum!);
      unindexNote(id, "draft");
    })();
    await storage.finalizePublished(id, markdown).catch((error) => console.error(`Could not refresh current Markdown mirror for note ${id}`, errorClass(error)));
    audit(userId, id, "note.publish", { version: nextVersion });
    return c.json({ version: nextVersion, publishedAt: timestamp });
  });
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
      if (result.changes === 1) indexNote(id, "draft", metadata.title, markdown, metadata.checksum);
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
  // Ownership and the Bin check run under the note lock, so a note binned or purged
  // meanwhile is refused instead of having its retained shares rewritten.
  return withNoteLock(id, async () => {
    if (!ownedNote(id, userId)) return c.json({ error: "Note not found" }, 404);
    db.transaction(() => {
      db.query("DELETE FROM note_shares WHERE note_id = ?").run(id);
      if (body.visibility === "selected") {
        const statement = db.query("INSERT INTO note_shares (note_id, user_id, created_at) VALUES (?, ?, ?)");
        for (const recipientId of uniqueIds) statement.run(id, recipientId, now());
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
registerTeamRoutes(app);

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof ZodError) return c.json({ error: "Invalid request", details: error.issues.map((issue) => issue.message) }, 400);
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
  console.error("Request failed", errorClass(error));
  return c.json({ error: "Something went wrong" }, 500);
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.all("/mcp", (c) => handleMcpRequest(c.req.raw));

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
try {
  await initPush();
} catch (error) {
  console.error("Web Push setup failed; reminders still appear in the app", errorClass(error));
}
startDispatcher();

export default {
  port: config.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Uploads need a larger transport cap; JSON and MCP bodies are bounded separately while reading.
  maxRequestBodySize: Math.max(config.maxUploadBytes, JSON_BODY_LIMIT_BYTES) + 1_048_576
};
