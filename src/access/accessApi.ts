import { api } from "../api";
import type { Role } from "../team/teamRoles";
import type { AccessKind, Level } from "./accessLevels";

/** GET/PUT …/access (Wave 32, access plan §C.5, docs/plan/API_CONTRACTS.md § Access). */
export type Audience = "private" | "selected" | "all_users" | "inherit";

export type AccessPerson = { id: string; displayName: string; teamRole: Role; kind: "person" | "service"; level: Level; via: "direct"; blocked: boolean };
export type AccessGroup = { id: string; name: string; memberCount: number; guestCount: number; selfAddedCount: number; level: Level };

export type ItemAccess = {
  etag: string;
  kind: AccessKind;
  title: string;
  owner: { id: string; displayName: string };
  audience: Audience;
  audienceLevel?: Level | null;
  audienceLevels?: Level[];
  people: AccessPerson[];
  groups: AccessGroup[];
  /** The levels the caller may give (managers never see Manager, D273). */
  levels: Level[];
  yourLevel: "owner" | "manage";
  /** The caller's id: a manager's own row says to ask the owner (MANAGER_CAP). */
  youId?: string;
  shareWithGuests: boolean;
  /** Notes and files can use their folder's access. */
  inheritable: boolean;
};

export type AccessPutBody = {
  audience: Audience;
  audienceLevel?: Level;
  people: Array<{ id: string; level: Level }>;
  groups: Array<{ id: string; level: Level }>;
};

/** The picker's directories: people who can be shared with, and groups (names and counts only). */
export type PickerPerson = { id: string; displayName: string; role?: Role };
export type PickerGroup = { id: string; name: string; memberCount: number; guestCount: number };

const BASES: Record<AccessKind, string> = {
  note: "/notes",
  folder: "/folders",
  document: "/files",
  board: "/tasks/boards",
  task_view: "/tasks/views",
  collection: "/collections",
  calendar: "/calendars"
};

export const accessPath = (kind: AccessKind, id: string) => `${BASES[kind]}/${encodeURIComponent(id)}/access`;

export const getAccess = (kind: AccessKind, id: string) => api<ItemAccess>(accessPath(kind, id));

/** Saves with the ETag the sheet loaded; a stale one answers 409 ACCESS_CHANGED with the current access. */
export const putAccess = (kind: AccessKind, id: string, body: AccessPutBody, etag: string) =>
  api<ItemAccess>(accessPath(kind, id), { method: "PUT", body: JSON.stringify(body), headers: { "If-Match": etag } });

export const listPeople = () => api<{ users: PickerPerson[] }>("/users");
export const listPickerGroups = () => api<{ groups: PickerGroup[]; shareWithGuests?: boolean }>("/groups");
