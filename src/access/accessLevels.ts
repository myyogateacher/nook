/**
 * The item level ladder on the client (access plan D266, §C.2, §D.3), mirroring
 * server/access/levels.ts. Chrome only: the server decides every write.
 */
export type Level = "view" | "comment" | "edit" | "manage";
export type ItemLevel = "none" | Level | "owner";
export type AccessKind = "note" | "folder" | "document" | "board" | "task_view" | "collection" | "calendar";

const RANK: Record<ItemLevel, number> = { none: 0, view: 1, comment: 2, edit: 3, manage: 4, owner: 5 };

/** Whether `level` reaches `needed`; an older server that sends no level keeps today's behaviour (`fallback`). */
export function levelAtLeast(level: ItemLevel | undefined | null, needed: ItemLevel, fallback: ItemLevel = "edit") {
  return RANK[level ?? fallback] >= RANK[needed];
}

export const LEVEL_LABELS: Record<Level, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", manage: "Manager" };

/** One line per level and kind, under each option of the level Select (§E). */
export function levelDescription(kind: AccessKind, level: Level): string {
  switch (kind) {
    case "board":
      return { view: "Read cards and comments", comment: "Read, comment, and react", edit: "Add, change, and move cards, not columns or sharing", manage: "Also columns, tags, sprints, and sharing up to Can edit" }[level];
    case "collection":
      return { view: "Read rows and export", comment: "Read rows", edit: "Add, change, and delete rows, not fields or sharing", manage: "Also fields, views, name, and sharing up to Can edit" }[level];
    case "calendar":
      return { view: "See events", comment: "See events", edit: "Add and change events, not the calendar or sharing", manage: "Also rename, colour, and sharing up to Can edit" }[level];
    case "note":
      return level === "edit" ? "Write the draft and publish; never share, move, or delete" : "Read the published note";
    case "folder":
      return level === "edit" ? "Also write and publish the notes that use its access; never share, move, or delete" : "Read the notes and files that use the folder's access";
    case "task_view":
      return "Run the saved view; cards show only from boards they can open";
    case "document":
      return "Open and download";
  }
}

/** Compares levels on the ladder (view < comment < edit < manage). */
export const levelRank = (level: ItemLevel) => RANK[level];
