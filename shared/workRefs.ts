import type { Status } from "./tones";
import { shortIdOfSegment } from "./friendlyUrls";

/**
 * Work references (docs/plan/WORKSPACE_MODULES.md §B.4, D804): a `WorkRef` names any item across
 * modules; a `WorkSummary` is what a viewer may see of it (null when they cannot read it, T501).
 * `work_links` (migration 086) relates two refs. Pure; shared by the server (server/links/*) and the
 * client (src/ui/links/*).
 */

/** Existing kinds (W1 registers their adapters) and the workspace modules' kinds (each lane registers its own). */
export const WORK_KINDS = [
  "card", "board", "sprint", "note", "document", "whiteboard", "event", "calendar", "collection", "row", "report",
  "form", "response", "time_entry", "time_project", "goal", "key_result", "checkin", "checkin_round",
  "contact", "company", "deal", "booking", "booking_type", "townhall_session", "townhall_question"
] as const;
export type WorkKind = typeof WORK_KINDS[number];
export const isWorkKind = (value: unknown): value is WorkKind => typeof value === "string" && (WORK_KINDS as readonly string[]).includes(value);

export type WorkRef = { kind: WorkKind; id: string };

/** Link relations (§B.4.1). Display reads "A <relation> B": "MYT-12 contributes to Grow MRR". */
export const LINK_RELATIONS = ["relates", "contributes", "tracks", "source", "blocks", "mentions"] as const;
export type LinkRelation = typeof LINK_RELATIONS[number];
export const isLinkRelation = (value: unknown): value is LinkRelation => typeof value === "string" && (LINK_RELATIONS as readonly string[]).includes(value);

/** How a relation reads from each side ("contributes to" / "has contribution from"). */
export const RELATION_WORDS: Record<LinkRelation, { outgoing: string; incoming: string }> = {
  relates: { outgoing: "relates to", incoming: "relates to" },
  contributes: { outgoing: "contributes to", incoming: "has contributions from" },
  tracks: { outgoing: "tracks time on", incoming: "has time from" },
  source: { outgoing: "was created from", incoming: "created" },
  blocks: { outgoing: "blocks", incoming: "is blocked by" },
  mentions: { outgoing: "mentions", incoming: "is mentioned in" }
};

/** What a viewer sees of an item they can read. */
export type WorkSummary = {
  kind: WorkKind;
  id: string;
  shortId?: string;
  /** A card's key (MYT-12). */
  key?: string;
  title: string;
  subtitle?: string;
  /** In-app path, always relative (T509). */
  href: string;
  /** A lucide icon name the client maps (e.g. "kanban-square"). */
  icon: string;
  status?: Status;
  /** 0–1. */
  progress?: number;
  /** YYYY-MM-DD or an ISO instant. */
  due?: string;
};

/** The other side of a link the viewer cannot read: the kind's icon only (T501). */
export type HiddenWorkSummary = { kind: WorkKind; hidden: true };

/** One link as GET /api/links?kind=&id= returns it. */
export type WorkLinkView = {
  id: string;
  relation: LinkRelation;
  /** `out`: this item is side A ("this contributes to …"); `in`: side B. */
  direction: "out" | "in";
  other: WorkSummary | HiddenWorkSummary;
  /** Links kept in another table (card relations, event links, attachments) are read-only here. */
  source: "work_links" | "card_relations" | "card_hierarchy" | "event_links" | "attachment_links";
  createdAt: string | null;
};

/** The icon each kind shows when nothing else is known about it. */
export const WORK_KIND_ICONS: Record<WorkKind, string> = {
  card: "square-check", board: "kanban-square", sprint: "timer", note: "file-text", document: "file", whiteboard: "pen-tool", event: "calendar-days",
  calendar: "calendar", collection: "table-2", row: "rows-3", report: "chart-column", form: "clipboard-list", response: "message-square-text",
  time_entry: "clock", time_project: "folder-clock", goal: "target", key_result: "gauge", checkin: "message-circle", checkin_round: "messages-square",
  contact: "contact", company: "building-2", deal: "handshake", booking: "calendar-check", booking_type: "calendar-plus", townhall_session: "megaphone",
  townhall_question: "message-circle-question"
};

/** Words for a kind ("a goal"), for "An item you can't open" and link pickers. */
export const WORK_KIND_LABELS: Record<WorkKind, string> = {
  card: "Card", board: "Board", sprint: "Sprint", note: "Note", document: "File", whiteboard: "Whiteboard", event: "Event", calendar: "Calendar",
  collection: "Collection", row: "Row", report: "Report", form: "Form", response: "Response", time_entry: "Time entry", time_project: "Time project",
  goal: "Goal", key_result: "Key result", checkin: "Standup", checkin_round: "Standup round", contact: "Contact", company: "Company", deal: "Deal",
  booking: "Booking", booking_type: "Booking type", townhall_session: "Townhall", townhall_question: "Question"
};

/**
 * The words before a linked item's label in a history line (D1390): "the goal " when the reader can
 * open it (the server served its id and title), "" when the label is only the kind word ("Goal").
 */
export function linkedItemNoun(item: { id?: string; kind?: string } | null | undefined): string {
  return item?.id && isWorkKind(item.kind) ? `the ${WORK_KIND_LABELS[item.kind].toLowerCase()} ` : "";
}

/**
 * A reference as text names it, before the server resolves it to an id: a UUID, a short id
 * (friendly URLs, D771), a card key (MYT-12), or a board code.
 */
export type ParsedWorkRef = { kind: WorkKind; ref: string; by: "id" | "short_id" | "key" | "code" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/;
const BOARD_CODE = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

/**
 * App paths of the kinds whose items have a friendly segment (`<slug>-<shortid>`) or a UUID as their
 * last segment, by the path's leading segments. Longest prefixes are tried first.
 */
export const WORK_KIND_PATHS: ReadonlyArray<{ prefix: readonly string[]; kind: WorkKind }> = [
  { prefix: ["contacts", "companies"], kind: "company" },
  { prefix: ["contacts", "deals"], kind: "deal" },
  { prefix: ["bookings", "types"], kind: "booking_type" },
  { prefix: ["time", "projects"], kind: "time_project" },
  { prefix: ["contacts"], kind: "contact" },
  { prefix: ["notes"], kind: "note" },
  { prefix: ["files"], kind: "document" },
  { prefix: ["whiteboards"], kind: "whiteboard" },
  { prefix: ["collections"], kind: "collection" },
  { prefix: ["reports"], kind: "report" },
  { prefix: ["forms"], kind: "form" },
  { prefix: ["goals"], kind: "goal" },
  { prefix: ["standups"], kind: "checkin" },
  { prefix: ["townhall"], kind: "townhall_session" }
];

/** Words that are list pages, never an item segment. */
const LIST_WORDS = new Set(["shared", "folder", "favorites", "lists", "views", "my", "new", "settings", "insights", "people", "companies", "deals", "types", "projects"]);

function refFromSegment(kind: WorkKind, segment: string | undefined): ParsedWorkRef | null {
  if (!segment) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { return null; }
  if (UUID.test(decoded)) return { kind, ref: decoded.toLowerCase(), by: "id" };
  if (LIST_WORDS.has(decoded.toLowerCase())) return null;
  const shortId = shortIdOfSegment(decoded);
  return shortId ? { kind, ref: shortId, by: "short_id" } : null;
}

function parsePath(path: string): ParsedWorkRef | null {
  const segments = path.split(/[?#]/)[0]!.split("/").filter(Boolean);
  if (!segments.length) return null;
  if (segments[0] === "tasks") {
    // /tasks/<uuid>/card/<uuid>, /tasks/<CODE>/views/<v>/card/<KEY>, /tasks/<KEY>(/full), /tasks/<CODE>
    const cardAt = segments.indexOf("card");
    if (cardAt > 0 && segments[cardAt + 1]) {
      const ref = segments[cardAt + 1]!;
      if (UUID.test(ref)) return { kind: "card", ref: ref.toLowerCase(), by: "id" };
      if (CARD_KEY.test(ref)) return { kind: "card", ref: ref.toUpperCase(), by: "key" };
      return null;
    }
    const first = segments[1];
    if (!first || ["my", "views"].includes(first.toLowerCase())) return null;
    if (CARD_KEY.test(first)) return { kind: "card", ref: first.toUpperCase(), by: "key" };
    if (UUID.test(first)) return { kind: "board", ref: first.toLowerCase(), by: "id" };
    if (BOARD_CODE.test(first)) return { kind: "board", ref: first.toUpperCase(), by: "code" };
    return null;
  }
  if (segments[0] === "collections" && segments.length >= 4 && segments[2] === "row") {
    const row = segments[3]!;
    return UUID.test(row) ? { kind: "row", ref: row.toLowerCase(), by: "id" } : null;
  }
  for (const entry of WORK_KIND_PATHS) {
    if (segments.length <= entry.prefix.length || !entry.prefix.every((word, index) => segments[index] === word)) continue;
    // The item is the segment right after the prefix, except notes, whose folder segment may come first.
    const segment = entry.kind === "note" ? segments[segments.length - 1] : segments[entry.prefix.length];
    return refFromSegment(entry.kind, segment);
  }
  return null;
}

/**
 * Parses a reference written in text (§B.4.4): a card key (`MYT-12`), any in-app URL or path of a
 * registered kind (friendly or UUID, on one of `origins`), or `kind:id` (`goal:3f9x2ab01k`). Null when
 * it is none of these. The server resolves it and checks access; parsing grants nothing.
 */
export function parseWorkRef(text: string, origins: readonly string[] = []): ParsedWorkRef | null {
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  if (CARD_KEY.test(value)) return { kind: "card", ref: value.toUpperCase(), by: "key" };
  const typed = /^([a-z_]{2,20}):(\S{1,64})$/.exec(value);
  if (typed && isWorkKind(typed[1]) && !/^https?$/.test(typed[1]!)) {
    const ref = typed[2]!;
    if (UUID.test(ref)) return { kind: typed[1], ref: ref.toLowerCase(), by: "id" };
    const shortId = shortIdOfSegment(ref);
    if (shortId) return { kind: typed[1], ref: shortId, by: "short_id" };
    if (typed[1] === "card" && CARD_KEY.test(ref)) return { kind: "card", ref: ref.toUpperCase(), by: "key" };
    if (typed[1] === "board" && BOARD_CODE.test(ref)) return { kind: "board", ref: ref.toUpperCase(), by: "code" };
    return null;
  }
  if (value.startsWith("/")) return parsePath(value);
  try {
    const url = new URL(value);
    if (!origins.includes(url.origin)) return null;
    return parsePath(url.pathname);
  } catch {
    return null;
  }
}

/** The workspace module a kind belongs to (absent for the built-in modules' kinds): notifications, scopes, and labels. */
export const WORK_KIND_MODULE: Partial<Record<WorkKind, "forms" | "time" | "goals" | "checkins" | "crm" | "bookings" | "townhall">> = {
  form: "forms", response: "forms", time_entry: "time", time_project: "time", goal: "goals", key_result: "goals", checkin: "checkins", checkin_round: "checkins",
  contact: "crm", company: "crm", deal: "crm", booking: "bookings", booking_type: "bookings", townhall_session: "townhall", townhall_question: "townhall"
};

/** A stable string for a ref (map keys, dedupe). */
export const workRefKey = (ref: WorkRef) => `${ref.kind}:${ref.id}`;
