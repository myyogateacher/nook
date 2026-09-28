import { config } from "../config";

/**
 * Every URL in a mail (docs/plan/research/2026-09-28-outbound-email.md §D.7, T223): APP_ORIGIN plus
 * a path from one of the builders below. Ids are checked against the router's id pattern, so no
 * free-form path or query from user data can reach a link, and there are no redirect parameters.
 * Paths match the SPA router's `formatRoute` (tests parse every golden link back with `parseRoute`).
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Credential and unsubscribe tokens: base64url only. */
const TOKEN = /^[A-Za-z0-9_-]{16,200}(\.[A-Za-z0-9_-]{8,64})?$/;

function id(value: string) {
  const lower = value.toLowerCase();
  if (!ID.test(lower)) throw new Error("Invalid id for a mail link");
  return lower;
}

function token(value: string) {
  if (!TOKEN.test(value)) throw new Error("Invalid token for a mail link");
  return value;
}

export const SETTINGS_SECTIONS = ["security", "modules", "mcp", "notifications", "about"] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

/** Path builders, one per place a mail may open. */
export const paths = {
  home: () => "/",
  card: (boardId: string, cardId: string) => `/tasks/${id(boardId)}/card/${id(cardId)}`,
  board: (boardId: string) => `/tasks/${id(boardId)}`,
  myWork: () => "/tasks/my",
  taskView: (viewId: string) => `/tasks/views/${id(viewId)}`,
  note: (noteId: string) => `/notes/${id(noteId)}`,
  noteFolder: (folderId: string) => `/notes/folder/${id(folderId)}`,
  notesShared: () => "/notes/shared",
  file: (documentId: string) => `/files/${id(documentId)}`,
  filesShared: () => "/files/shared",
  collection: (collectionId: string) => `/collections/${id(collectionId)}`,
  calendar: () => "/calendar",
  event: (eventId: string) => `/calendar/event/${id(eventId)}`,
  notifications: () => "/notifications",
  sprints: (boardId: string) => `/tasks/${id(boardId)}/sprints`,
  bin: () => "/bin",
  inbox: () => "/inbox",
  proposal: (proposalId: string) => `/inbox/p/${id(proposalId)}`,
  team: (userId: string) => `/team/${id(userId)}`,
  settings: (section: SettingsSection) => {
    if (!SETTINGS_SECTIONS.includes(section)) throw new Error("Invalid settings section");
    return `/settings/${section}`;
  },
  /** Credential links keep the token in the fragment (T220). */
  verifyEmail: (value: string) => `/verify-email#token=${token(value)}`,
  unsubscribePage: (value: string) => `/mail/unsubscribe#t=${token(value)}`,
  /** The RFC 8058 header URL cannot use a fragment; the token is low-power (T221). */
  unsubscribeApi: (value: string) => `/api/mail/unsubscribe?t=${token(value)}`
} as const;

/** The origin mail links use. Tests pin it (golden files use https://nook.test). */
let origin = config.appOrigin;

/** Test hook. */
export function setMailOriginForTests(next: string | null) {
  origin = next ?? config.appOrigin;
}

export const mailOrigin = () => origin;

/** An absolute link: the configured origin plus a path from `paths`. */
export const appLink = (path: string) => {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Mail links take a path from paths");
  return `${origin}${path}`;
};
