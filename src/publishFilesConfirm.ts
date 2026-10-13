import type { ConfirmRequest } from "./ui/useConfirm";

/**
 * v0.35.0 review M1: publishing a note (or approving an agent's draft of one) that would share the
 * publisher's own files from Files (outside their Attachments folder) answers 409 CONFIRM_REQUIRED
 * with the files and the note's audience. The app asks with its own dialog (useConfirm, a history
 * layer, D91) and publishes again with those ids in `confirmAttachments`.
 */

export type ConfirmFile = { id: string; name: string };
export type NoteAudience = { visibility: "private" | "selected" | "all_users"; people: number; groups: number };
export type ConfirmRequired = { files: ConfirmFile[]; audience: NoteAudience };

/** The files and audience of a 409 CONFIRM_REQUIRED answer, or null for anything else. */
export function confirmRequiredOf(status: number, payload: unknown): ConfirmRequired | null {
  if (status !== 409 || typeof payload !== "object" || payload === null) return null;
  const body = payload as { code?: unknown; files?: unknown; audience?: unknown };
  if (body.code !== "CONFIRM_REQUIRED" || !Array.isArray(body.files)) return null;
  const files = body.files.filter((file): file is ConfirmFile => typeof file === "object" && file !== null
    && typeof (file as ConfirmFile).id === "string" && typeof (file as ConfirmFile).name === "string");
  if (!files.length) return null;
  const raw = (typeof body.audience === "object" && body.audience !== null ? body.audience : {}) as Partial<NoteAudience>;
  const visibility = raw.visibility === "selected" || raw.visibility === "all_users" ? raw.visibility : "private";
  return { files, audience: { visibility, people: Number(raw.people) || 0, groups: Number(raw.groups) || 0 } };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** “a.pdf”, “a.pdf” and “b.png”, or “a.pdf”, “b.png” and 3 more files. */
export function fileNames(files: readonly ConfirmFile[]) {
  const quoted = files.map((file) => `“${file.name}”`);
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length <= 3) return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `${quoted.slice(0, 2).join(", ")} and ${plural(quoted.length - 2, "more file", "more files")}`;
}

/** Who will be able to open the files, in words. */
export function audienceText(audience: NoteAudience) {
  if (audience.visibility === "all_users") return "Everyone signed in to Nook can open this note, so they will all be able to open";
  if (audience.visibility === "selected") {
    const parts = [audience.people ? plural(audience.people, "person", "people") : "", audience.groups ? plural(audience.groups, "group", "groups") : ""].filter(Boolean);
    return `The ${parts.length ? parts.join(" and ") : "people"} this note is shared with will be able to open`;
  }
  return "Only you can open this note now, but anyone you share it with later will be able to open";
}

/** The dialog for a publish (or an approval) that would share the publisher's Files items. */
export function publishFilesConfirm(required: ConfirmRequired, action: "publish" | "approve" = "publish"): Omit<ConfirmRequest, "opener"> {
  const count = required.files.length;
  return {
    title: count === 1 ? "Share a file from Files with this note?" : `Share ${count} files from Files with this note?`,
    message: `${audienceText(required.audience)} ${fileNames(required.files)}. ${count === 1 ? "It stays" : "They stay"} in ${count === 1 ? "its folder" : "their folders"} in Files.`,
    confirmLabel: action === "approve" ? "Share and approve" : "Share and publish"
  };
}

/** Shown when leaving a note would have published it but its files need a confirm first: it stays a draft. */
export const confirmLaterMessage = (required: ConfirmRequired) =>
  `Not published yet: it would share ${fileNames(required.files)} from your Files. Open the note and press Publish to confirm.`;
