import type { Context, Next } from "hono";
import type { AppEnv } from "../auth";
import { parse } from "../../shared/taskQuery";
import { readBoundedBody } from "../validation";
import { can, type Role } from "./roles";

/**
 * The default-deny role write gate (docs/plan/research/2026-09-26-team-module.md §5.2, D75, T87).
 * Every `/api` request that is not GET, HEAD, or OPTIONS from a user whose role cannot write content
 * (viewer, guest) gets 403 `ROLE_READ_ONLY`, unless it matches this exact allowlist of personal,
 * non-content writes and reads sent as POST. New routes are therefore read-only for these roles with
 * no per-route work; tests/writeGate.test.ts enumerates every mutating route to prove it.
 */

type AllowedWrite = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Hono-style path; `:name` matches exactly one segment. */
  path: string;
  /** Read-only roles this entry applies to; both when omitted. */
  roles?: readonly Role[];
  why: string;
};

export const ROLE_READ_ONLY_ALLOWED_WRITES: readonly AllowedWrite[] = [
  { method: "POST", path: "/api/auth/logout", why: "sign out" },
  { method: "POST", path: "/api/auth/totp/setup", why: "own two-factor setup" },
  { method: "POST", path: "/api/auth/totp/enable", why: "own two-factor setup" },
  { method: "POST", path: "/api/auth/totp/recovery-codes", why: "view own recovery codes" },
  { method: "POST", path: "/api/auth/totp/recovery-codes/regenerate", why: "own recovery codes" },
  { method: "DELETE", path: "/api/auth/totp", why: "turn off own two-factor" },
  { method: "POST", path: "/api/notifications/read", why: "mark own notifications read" },
  { method: "POST", path: "/api/push/subscriptions", why: "own push devices" },
  { method: "DELETE", path: "/api/push/subscriptions", why: "own push devices" },
  { method: "POST", path: "/api/push/test", why: "own push devices" },
  { method: "POST", path: "/api/reminders", why: "own reminders on readable events (O4)" },
  { method: "DELETE", path: "/api/reminders/:reminderId", why: "own reminders" },
  { method: "PUT", path: "/api/preferences", why: "own Modules preference (UI only, D92)" },
  { method: "PUT", path: "/api/mail/settings", why: "own email preferences (outbound email §B.1)" },
  { method: "POST", path: "/api/mail/verify/send", why: "verify own address (D244)" },
  { method: "POST", path: "/api/mail/test", why: "own test email" },
  { method: "POST", path: "/api/mcp/keys", why: "own MCP keys; the handler limits scopes by role and refuses guests (O6)" },
  { method: "DELETE", path: "/api/mcp/keys/:id", why: "revoke own MCP keys" },
  // Nook keys (Wave 31, access plan §C.7): viewers keep read-only keys; the handlers cap grants by role.
  { method: "POST", path: "/api/keys", why: "own API keys; the handler limits grants by role and policy and refuses guests" },
  { method: "PATCH", path: "/api/keys/:id", why: "narrow own API keys (never widens)" },
  { method: "POST", path: "/api/keys/:id/rotate", why: "rotate own API keys (same grants, re-authenticated)" },
  { method: "DELETE", path: "/api/keys/:id", why: "revoke own API keys" },
  { method: "POST", path: "/api/collections/:collectionId/query", why: "a read sent as POST" },
  { method: "POST", path: "/api/tasks/query", why: "a read sent as POST; guests only with assignee:me (isGuestTaskQuery)" },
  // Personal task views (task hierarchy plan Q12): viewers keep private views; sharing stays refused
  // except withdrawing one. The service allows PATCH/DELETE only while the view is private and PUT
  // sharing only to `private` (403 VIEW_SHARED_READ_ONLY), so a demoted member can unshare.
  { method: "POST", path: "/api/tasks/views", roles: ["viewer"], why: "own private view" },
  { method: "PATCH", path: "/api/tasks/views/:viewId", roles: ["viewer"], why: "own private view (owner-only, private-only in the service)" },
  { method: "DELETE", path: "/api/tasks/views/:viewId", roles: ["viewer"], why: "own private view (owner-only, private-only in the service)" },
  { method: "PUT", path: "/api/tasks/views/:viewId/sharing", roles: ["viewer"], why: "withdraw a share of own view (only to private in the service)" },
  { method: "POST", path: "/api/tasks/views/:viewId/duplicate", roles: ["viewer"], why: "private copy of a readable view" },
  // Agent inbox (D152): a demoted owner keeps clearing their own proposals; approve stays refused.
  { method: "POST", path: "/api/inbox/proposals/:id/reject", roles: ["viewer"], why: "clear own proposals" },
  { method: "POST", path: "/api/inbox/proposals/bulk", roles: ["viewer"], why: "clear own proposals; the handler refuses approve for read-only roles" },
  { method: "PUT", path: "/api/inbox/settings", roles: ["viewer"], why: "own proposal push setting" }
];

/**
 * Routes that enforce roles themselves and so pass the gate: Team answers guests 404 and non-admins
 * 403 `ADMIN_ONLY` (§5.2 item 3), which the gate must not turn into `ROLE_READ_ONLY`.
 */
export const SELF_GATED_WRITE_PREFIXES: readonly string[] = ["/api/team/"];

const compiled = ROLE_READ_ONLY_ALLOWED_WRITES.map((entry) => ({
  ...entry,
  regex: new RegExp(`^${entry.path.split("/").map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}$`)
}));

/** Whether `role` may send this write although it cannot write content. */
export function isAllowedReadOnlyWrite(role: Role, method: string, path: string) {
  if (SELF_GATED_WRITE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return compiled.some((entry) => entry.method === method && entry.regex.test(path) && (!entry.roles || entry.roles.includes(role)));
}

export const ROLE_READ_ONLY_BODY = { error: "Your team role is read-only", code: "ROLE_READ_ONLY" } as const;

/**
 * Guests run only "my work" task queries (task hierarchy plan Q12): the filter must carry a plain
 * `assignee:me` term. Terms AND together, so any other terms only narrow it. Anything unreadable
 * is refused here; a valid query then goes through the route's own validation.
 */
export function isGuestTaskQuery(body: unknown) {
  if (typeof body !== "object" || body === null) return false;
  const q = (body as { q?: unknown }).q;
  if (typeof q !== "string") return false;
  const parsed = parse(q);
  return parsed.ok && parsed.query.terms.some((term) => term.key === "assignee" && !term.negate && term.values.length === 1 && term.values[0] === "me");
}

const GUEST_QUERY_BODY = { error: "Guests can only list cards assigned to them (assignee:me)", code: "ROLE_READ_ONLY" } as const;

/** Registered on `/api/*` after the session, CSRF, and TOTP gates. */
export async function roleWriteGate(c: Context<AppEnv>, next: Next) {
  const role = c.get("user")?.role;
  if (!role || can(role, "content.write") || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  // Hono matches routes case-sensitively on the raw path, so the gate compares the same path.
  if (!isAllowedReadOnlyWrite(role, c.req.method, c.req.path)) return c.json(ROLE_READ_ONLY_BODY, 403);
  if (role === "guest" && c.req.method === "POST" && c.req.path === "/api/tasks/query") {
    let body: unknown = null;
    try {
      body = JSON.parse(new TextDecoder().decode(await readBoundedBody(c.req.raw.clone(), 16_384)));
    } catch {
      body = null;
    }
    if (!isGuestTaskQuery(body)) return c.json(GUEST_QUERY_BODY, 403);
  }
  return next();
}
