import type { Hono } from "hono";
import type { AppEnv } from "../auth";
import { db } from "../db";
import { avatarUrlFor } from "../avatars";
import { can } from "../team/roles";
import { readPolicies } from "../team/policies";
import { itemLevel } from "../access/workspaceItems";
import { anchorBySql, registerItemKind } from "../keyResources";
import { registerWorkKind, each } from "../links/adapters";
import { companyPath, contactPath } from "./paths";
import { contactSummaries, readableContact, searchContacts } from "./contacts";
import { userSummaries } from "./summaries";
import { PEOPLE_ALLOW, type PersonSummary } from "../../shared/people";
import { isWorkKind, WORK_KIND_ICONS } from "../../shared/workRefs";
import { MENTIONABLE_LIMIT_MAX, MENTION_QUERY_MAX } from "../../shared/itemActivity";
import { mentionCandidates, mentionLookupRetryAfter } from "./mentions";
import { readableContainerSql } from "../access/workspaceItems";

/**
 * People pickers (§B.3, §D.0): `GET /api/people/search?q=&allow=user,group,contact&book=` searches team
 * users (people only, never integrations), groups, and contacts in books the caller can read. Like the
 * share picker (`/api/users`), read-only roles get no directory (403), and guests are left out while
 * the `share_with_guests` policy is off.
 *
 * Contacts and companies are foundation tables, so their work kind adapters and key grant anchors are
 * registered here (the Contacts lane adds deals and interactions).
 */

registerItemKind("contact", anchorBySql("contact_book", "SELECT book_id AS anchor FROM contacts WHERE id = ? OR short_id = ?1"));
registerItemKind("company", anchorBySql("contact_book", "SELECT book_id AS anchor FROM companies WHERE id = ? OR short_id = ?1"));

const contactLevel = (table: "contacts" | "companies", id: string, userId: string) => {
  const row = db.query(`SELECT book_id FROM ${table} WHERE (id = ? OR short_id = ?1) AND deleted_at IS NULL`).get(id) as { book_id: string } | null;
  return row ? itemLevel("contact_book", row.book_id, userId) : "none" as const;
};

registerWorkKind({
  kind: "contact", itemKind: "contact", scopes: { read: "crm:read", write: "crm:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM contacts WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
  level: (id, viewer) => contactLevel("contacts", id, viewer.userId),
  resolve: each((id, viewer) => {
    const contact = readableContact(id, viewer.userId);
    return contact ? { kind: "contact", id: contact.id, shortId: contact.shortId, title: contact.displayName, ...(contact.companyName ? { subtitle: contact.companyName } : {}), href: contactPath(contact.displayName, contact.shortId), icon: WORK_KIND_ICONS.contact } : null;
  })
});

registerWorkKind({
  kind: "company", itemKind: "company", scopes: { read: "crm:read", write: "crm:write" },
  lookup: (ref) => ref.by === "id" ? ref.ref : ref.by === "short_id" ? (db.query("SELECT id FROM companies WHERE short_id = ?").get(ref.ref) as { id: string } | null)?.id ?? null : null,
  level: (id, viewer) => contactLevel("companies", id, viewer.userId),
  resolve: each((id, viewer) => {
    const row = db.query(`SELECT co.id, co.short_id, co.name, co.domain FROM companies co JOIN contact_books b ON b.id = co.book_id WHERE co.id = $id AND co.deleted_at IS NULL AND ${readableContainerSql("contact_book", "b")}`)
      .get({ id, userId: viewer.userId }) as { id: string; short_id: string; name: string; domain: string | null } | null;
    return row ? { kind: "company", id: row.id, shortId: row.short_id, title: row.name, ...(row.domain ? { subtitle: row.domain } : {}), href: companyPath(row.name, row.short_id), icon: WORK_KIND_ICONS.company } : null;
  })
});

export function registerPeopleRoutes(app: Hono<AppEnv>) {
  app.get("/api/people/search", (c) => {
    const user = c.get("user");
    if (!can(user.role, "sharing.write")) return c.json({ error: "Your team role is read-only", code: "READ_ONLY" }, 403);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100).toLowerCase();
    const allow = (c.req.query("allow") ?? "user").split(",").filter((word): word is typeof PEOPLE_ALLOW[number] => (PEOPLE_ALLOW as readonly string[]).includes(word));
    const books = (c.req.query("book") ?? "").split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const people: PersonSummary[] = [];
    if (allow.includes("user")) {
      const guests = readPolicies().shareWithGuests ? "" : " AND role <> 'guest'";
      const users = db.query(`SELECT id, display_name, email, role, avatar_id FROM users WHERE disabled_at IS NULL AND kind = 'person'${guests}
          AND ($q = '' OR instr(lower(display_name), $q) > 0 OR instr(lower(email), $q) > 0) ORDER BY display_name COLLATE NOCASE LIMIT 20`)
        .all({ q }) as Array<{ id: string; display_name: string; email: string; role: string; avatar_id: string | null }>;
      // Emails are shown to members and admins only, like the Team list (D79).
      for (const row of users) people.push({ kind: "user", id: row.id, name: row.display_name, role: row.role, avatarUrl: avatarUrlFor(row.id, row.avatar_id), ...(user.role === "admin" ? { email: row.email } : {}) });
    }
    if (allow.includes("group")) {
      const groups = db.query(`SELECT g.id, g.name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS members FROM user_groups g
          WHERE ($q = '' OR instr(lower(g.name), $q) > 0) ORDER BY g.name COLLATE NOCASE LIMIT 20`).all({ q }) as Array<{ id: string; name: string; members: number }>;
      for (const row of groups) people.push({ kind: "group", id: row.id, name: row.name, memberCount: row.members });
    }
    if (allow.includes("contact")) {
      for (const contact of searchContacts(user.id, q, { bookIds: books, limit: 20 })) {
        people.push({ kind: "contact", id: contact.id, name: contact.displayName, email: contact.email, companyId: contact.companyId, companyName: contact.companyName, bookId: contact.bookId, shortId: contact.shortId });
      }
    }
    return c.json({ people });
  });

  /**
   * The @mention picker (docs/plan/MENTIONS.md §4, D1323, T660, T661):
   * `GET /api/people/mentionable?kind=<workKind>&id=<itemId>&q=<text>&limit=<1–20>`. 404 unless the
   * caller can read the item; readers first, non-readers (`canRead: false`) only for callers who see
   * the Team. 120 lookups a minute per person.
   */
  app.get("/api/people/mentionable", (c) => {
    const user = c.get("user");
    const retryAfter = mentionLookupRetryAfter(user.id);
    if (retryAfter) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many requests. Try again in a moment.", code: "RATE_LIMITED" }, 429);
    }
    const kind = c.req.query("kind");
    const id = c.req.query("id") ?? "";
    const q = c.req.query("q") ?? "";
    const limitText = c.req.query("limit");
    if (!isWorkKind(kind) || !/^[0-9A-Za-z_-]{1,64}$/.test(id)) return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    if (q.length > MENTION_QUERY_MAX) return c.json({ error: `q is at most ${MENTION_QUERY_MAX} characters`, code: "INVALID" }, 400);
    if (limitText !== undefined && (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > MENTIONABLE_LIMIT_MAX)) {
      return c.json({ error: `limit must be an integer from 1 to ${MENTIONABLE_LIMIT_MAX}`, code: "INVALID" }, 400);
    }
    const people = mentionCandidates({ id: user.id, role: user.role }, kind, id.toLowerCase(), { q, limit: limitText === undefined ? undefined : Number(limitText) });
    return people ? c.json({ people }) : c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
  });

  /**
   * Chips for ids a module already holds (D1206: Contacts custom person and contact fields):
   * `GET /api/people/resolve?users=<ids>&contacts=<ids>`, up to 200 of each. Team members give their
   * name (former members say so); a contact whose book the caller cannot read is `hidden` (T640).
   */
  app.get("/api/people/resolve", (c) => {
    const user = c.get("user");
    const ids = (name: string) => (c.req.query(name) ?? "").split(",").filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0, 200);
    return c.json({ people: [...userSummaries(ids("users")).values(), ...contactSummaries(ids("contacts"), user.id).values()] });
  });
}
