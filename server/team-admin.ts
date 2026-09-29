/**
 * Host CLI for Team recovery (docs/plan/research/2026-09-26-team-module.md §3.1, T78), modelled on
 * server/reset-totp.ts. It is the way out of admin lockouts: the last admin forgot their password,
 * was removed from ALLOWED_EMAILS, or two admins blocked each other. Every change is written to
 * `team_events` with `via = 'cli'` and no actor, and audited. The last-admin rule still applies.
 *
 *   bun server/team-admin.ts list
 *   bun server/team-admin.ts set-role user@example.com admin|member|viewer|guest
 *   bun server/team-admin.ts unblock user@example.com
 *   bun server/team-admin.ts allow-google-link user@example.com [--reset | --keep-credentials]
 *   bun server/team-admin.ts unlink-google user@example.com
 *
 * Google sign-in (Wave 35): `allow-google-link` lets the next Google sign-in with the account's
 * address link it (once, 24 hours); `--reset` first removes every credential and makes everything the
 * account owns private (docs/OPERATIONS.md, Google sign-in). On an account already linked to Google
 * it is a re-linking allowance: when the new Google account signs in, the previous holder's sessions,
 * keys, feeds, and reset links end, and so do the password and two-factor unless `--keep-credentials`
 * (review F2). It prints what will happen before doing it. `unlink-google` removes a linked Google
 * identity, for example after the person recreated their Google account. These work in every
 * AUTH_METHODS mode and are the way out for a lone admin.
 */
import { db } from "./db";
import { isRole, SELECTABLE_ROLES } from "./team/roles";
import { setRole, TeamError, unblockUser } from "./team/service";
import { allowGoogleLink, checkAllowGoogleLink, GoogleLinkError, relinkPreview, unlinkGoogleForAccount } from "./google/linkAdmin";

const usage = `Usage:
  bun server/team-admin.ts list
  bun server/team-admin.ts set-role user@example.com ${SELECTABLE_ROLES.join("|")}
  bun server/team-admin.ts unblock user@example.com
  bun server/team-admin.ts allow-google-link user@example.com [--reset | --keep-credentials]
      --reset             an account not linked yet: remove every credential and all sharing first
      --keep-credentials  an account already linked: keep the password and two-factor at the re-link
                          (by default the re-link removes them; sessions, keys, and feeds always end)
  bun server/team-admin.ts unlink-google user@example.com`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function findUser(emailArgument: string | undefined) {
  const email = emailArgument?.trim().toLowerCase();
  if (!email) fail(usage, 2);
  const user = db.query("SELECT id, role, disabled_at FROM users WHERE email = ? COLLATE NOCASE").get(email) as { id: string; role: string; disabled_at: string | null } | null;
  if (!user) fail("No account exists for that email address.");
  return user;
}

function run(operation: () => void, success: string) {
  try {
    operation();
  } catch (error) {
    if (error instanceof TeamError || error instanceof GoogleLinkError) fail(`${error.message} (${error.code}).`);
    throw error;
  }
  console.log(success);
}

const [command, ...args] = process.argv.slice(2);

if (command === "list") {
  const rows = db.query(`SELECT email, display_name, role, disabled_at, created_at FROM users
    ORDER BY disabled_at IS NOT NULL, CASE role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, created_at`)
    .all() as Array<{ email: string; display_name: string; role: string; disabled_at: string | null; created_at: string }>;
  if (!rows.length) console.log("No accounts yet. The first account to register becomes the admin.");
  for (const row of rows) {
    console.log([row.email, row.role, row.disabled_at ? "blocked" : "active", `created ${row.created_at.slice(0, 10)}`, row.display_name].join("\t"));
  }
} else if (command === "set-role") {
  if (args.length !== 2) fail(usage, 2);
  const user = findUser(args[0]);
  const role = args[1]!.trim().toLowerCase();
  if (!isRole(role)) fail(`Choose one of: ${SELECTABLE_ROLES.join(", ")}.`, 2);
  if (!isRole(user.role)) fail("That account has an unknown role.");
  if (user.role === role) {
    console.log(`That account is already ${role}.`);
  } else {
    run(() => { setRole(null, user.id, { role, expectedRole: user.role as typeof role }, { via: "cli" }); }, `Role changed from ${user.role} to ${role}. It applies to the account's next request.`);
  }
} else if (command === "unblock") {
  if (args.length !== 1) fail(usage, 2);
  const user = findUser(args[0]);
  run(() => { unblockUser(null, user.id, { via: "cli" }); }, "The account was unblocked. The user signs in again with their existing password and two-factor code.");
} else if (command === "allow-google-link") {
  const reset = args.includes("--reset");
  const keepCredentials = args.includes("--keep-credentials");
  const rest = args.filter((arg) => arg !== "--reset" && arg !== "--keep-credentials");
  if (rest.length !== 1 || (reset && keepCredentials)) fail(usage, 2);
  const user = findUser(rest[0]);
  let relink = false;
  try {
    relink = checkAllowGoogleLink(null, user.id, { reset, via: "cli" }).relink;
  } catch (error) {
    if (error instanceof GoogleLinkError) fail(`${error.message} (${error.code}).`);
    throw error;
  }
  if (keepCredentials && !relink) fail("--keep-credentials is for an account already linked to Google (a re-link).", 2);
  // F2: say what will happen before doing it.
  if (relink) {
    const preview = relinkPreview(user.id, !keepCredentials);
    console.log(`This account is linked to Google: this allows a re-link. Whoever next signs in with Google as its address gets the account and everything in it. Then ${preview.sessions} sessions end, ${preview.keys} API keys and ${preview.feeds} calendar feeds are revoked, and unused password-reset links stop working; the password and two-factor are ${keepCredentials ? "kept (--keep-credentials)" : "removed (use --keep-credentials to keep them)"}.`);
  } else if (reset) {
    console.log("Resetting the account first: every credential goes and everything it owns becomes private; content is kept.");
  }
  let result: ReturnType<typeof allowGoogleLink> | null = null;
  run(() => { result = allowGoogleLink(null, user.id, { reset, via: "cli", removeCredentials: !keepCredentials }); }, "Google sign-in is allowed for that account.");
  const allowed = result as ReturnType<typeof allowGoogleLink> | null;
  if (allowed?.reset) {
    const counts = allowed.reset;
    console.log(`Reset first: ${counts.sessions} sessions, ${counts.keys} API keys, ${counts.feeds} calendar feeds, ${counts.items} shared items made private (${counts.shares} people and ${counts.groupGrants} groups removed), ${counts.invites} invites revoked, ${counts.routines} routines paused${counts.password ? ", the password" : ""}${counts.twoFactor ? ", two-factor" : ""}.`);
  }
  console.log(`The next Google sign-in with that address links it, until ${allowed?.allowedUntil ?? "24 hours from now"}.`);
} else if (command === "unlink-google") {
  if (args.length !== 1) fail(usage, 2);
  const user = findUser(args[0]);
  try {
    await unlinkGoogleForAccount(null, user.id, "cli");
  } catch (error) {
    if (error instanceof GoogleLinkError) fail(`${error.message} (${error.code}).`);
    throw error;
  }
  console.log("Google sign-in was unlinked. Use allow-google-link to let a (new) Google account link it.");
} else {
  fail(usage, 2);
}
