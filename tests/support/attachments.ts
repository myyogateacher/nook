import { expect } from "bun:test";
import { createUser, db, request, type Session } from "./harness";

/** Helpers for the uploads-everywhere tests (U0): uploads, hosts, links, and reads as a session. */

export async function api(session: Session, method: string, path: string, body?: unknown) {
  const response = await request(path, method === "GET" ? {} : { method, body: JSON.stringify(body ?? {}) }, session);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** Uploads `content` as `name`: into the Attachments folder for `attachTo`, or as an ordinary Files item. */
export async function upload(session: Session, name: string, content: string | Uint8Array, options: { attachTo?: string; folderId?: string } = {}) {
  const form = new FormData();
  form.append("file", new Blob([content as BlobPart]), name);
  const query = options.attachTo ? `?attachTo=${options.attachTo}` : options.folderId ? `?folderId=${options.folderId}` : "";
  const response = await request(`/files${query}`, { method: "POST", body: form }, session);
  const body = await response.json() as Record<string, any>;
  return { status: response.status, body, id: (body.document?.id ?? "") as string };
}

export async function uploadAttachment(session: Session, name = "agenda.txt", content: string | Uint8Array = "Agenda: ship U0", attachTo = "event") {
  const result = await upload(session, name, content, { attachTo });
  expect(result.status).toBe(201);
  return result.id;
}

export const contentStatus = async (session: Session, documentId: string) => (await request(`/files/${documentId}/content`, {}, session)).status;
export const metadataStatus = async (session: Session, documentId: string) => (await request(`/files/${documentId}`, {}, session)).status;
export const filesList = async (session: Session) => ((await (await request("/files", {}, session)).json()) as { documents: Array<{ id: string }> }).documents.map((document) => document.id);

export const link = (session: Session, kind: string, hostId: string, body: Record<string, unknown>) => api(session, "POST", `/attachments/${kind}/${hostId}`, body);
export const unlink = (session: Session, kind: string, hostId: string, documentId: string) => api(session, "DELETE", `/attachments/${kind}/${hostId}/${documentId}`);
export const listOn = (session: Session, kind: string, hostId: string) => api(session, "GET", `/attachments/${kind}/${hostId}`);

/** A calendar with one all-day event, owned by `owner`. */
export async function calendarWithEvent(owner: Session, name = "Team calendar") {
  const calendar = await api(owner, "POST", "/calendars", { name });
  expect(calendar.status).toBe(201);
  const calendarId = calendar.body.calendar.id as string;
  const event = await api(owner, "POST", `/calendars/${calendarId}/events`, { title: "Planning", allDay: true, startDate: "2026-10-12", endDate: "2026-10-13" });
  expect(event.status).toBe(201);
  return { calendarId, eventId: event.body.event.id as string };
}

export async function shareCalendar(owner: Session, calendarId: string, visibility: "private" | "selected" | "all_users", userIds: string[] = [], shareRole: "viewer" | "editor" = "viewer") {
  const result = await api(owner, "PUT", `/calendars/${calendarId}/sharing`, { visibility, shareRole, userIds });
  expect(result.status).toBe(200);
}

/** A member row added directly (guests, where the share-with-guests policy would refuse the route). */
export function addCalendarMember(calendarId: string, userId: string, level: "view" | "edit" = "view") {
  db.query("INSERT OR REPLACE INTO calendar_members (calendar_id, user_id, created_at, level) VALUES (?, ?, ?, ?)").run(calendarId, userId, new Date().toISOString(), level);
  db.query("UPDATE calendars SET visibility = 'selected' WHERE id = ? AND visibility = 'private'").run(calendarId);
}

export async function userWithRole(label: string, role: "member" | "viewer" | "guest" | "admin") {
  const session = await createUser(label);
  db.query("UPDATE users SET role = ? WHERE id = ?").run(role, session.userId);
  return session;
}

export const attachmentsFolderOf = (userId: string) => (db.query("SELECT id FROM folders WHERE owner_id = ? AND system_kind = 'attachments'").get(userId) as { id: string } | null)?.id ?? null;
export const defaultFolderOf = (userId: string) => (db.query("SELECT id FROM folders WHERE owner_id = ? AND is_default = 1").get(userId) as { id: string }).id;
export const documentRow = (id: string) => db.query("SELECT id, owner_id, folder_id, purpose, deleted_at FROM documents WHERE id = ?").get(id) as { id: string; owner_id: string; folder_id: string | null; purpose: string; deleted_at: string | null } | null;
