/**
 * B4: a doc ref that points into this Nook (the built-in doc source `nook`). Pure; the server reads
 * with it and New report auto-selects the source with it.
 *
 * Accepted:
 * - a link on one of this instance's origins (APP_ORIGIN, APP_ORIGINS) to a note or a Files item, in
 *   every shape the router (src/router.ts) and the server's routes produce: `/notes/:id`,
 *   `/files/:id`, and `/api/notes/:id…` / `/api/files/:id…` (versions, content, sharing, and the
 *   like); the query and fragment are ignored, ids in any case;
 * - a bare id (a note's or a file's, tried in that order).
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NookDocRef = { kind: "note" | "file" | "any"; id: string };

/** The id-bearing path of a link into Nook, or null for any other path. */
function refOfPath(pathname: string): NookDocRef | null {
  const segments = pathname.split("/").filter(Boolean).map((segment) => { try { return decodeURIComponent(segment); } catch { return segment; } });
  const at = segments[0] === "api" ? 1 : 0;
  const app = segments[at];
  const id = segments[at + 1];
  if (!id || !ID.test(id)) return null;
  // The app's own routes are exactly /notes/:id and /files/:id; the API's carry more after the id.
  if (at === 0 && segments.length !== 2) return null;
  if (app === "notes") return { kind: "note", id: id.toLowerCase() };
  if (app === "files") return { kind: "file", id: id.toLowerCase() };
  return null;
}

/** Whether `ref` is a URL on one of `origins` (whatever its path). */
export function isNookLink(ref: string, origins: readonly string[]): boolean {
  try {
    const url = new URL(ref.trim());
    return origins.some((origin) => { try { return new URL(origin).origin === url.origin; } catch { return false; } });
  } catch {
    return false;
  }
}

/** The note or file a ref names in this Nook, or null when it is not a ref into it. */
export function parseNookRef(ref: string, origins: readonly string[]): NookDocRef | null {
  const value = ref.trim();
  if (ID.test(value)) return { kind: "any", id: value.toLowerCase() };
  if (!isNookLink(value, origins)) return null;
  return refOfPath(new URL(value).pathname);
}

/** Whether a link's host is a tool server's (New report selects that server for it). */
export function linkHost(ref: string): string | null {
  try {
    const url = new URL(ref.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
