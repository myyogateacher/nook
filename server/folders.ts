import { audit, db, now } from "./db";

/**
 * Folder creation shared by POST /api/folders and the MCP create_folder tool (Wave 19). A new folder
 * is always private: sharing never cascades from its parent (D3), so creating one never widens who
 * can see anything.
 */
export class FolderError extends Error {
  constructor(readonly status: 404 | 409, message: string, readonly code?: "NAME_TAKEN") {
    super(message);
    this.name = "FolderError";
  }
}

export function createFolder(userId: string, name: string, parentId: string | null) {
  if (name.toLowerCase() === "default") throw new FolderError(409, "The Default folder already exists", "NAME_TAKEN");
  if (parentId && !db.query("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(parentId, userId)) {
    throw new FolderError(404, "Parent folder not found");
  }
  const id = crypto.randomUUID();
  const timestamp = now();
  db.transaction(() => {
    db.query("INSERT INTO folders (id, owner_id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, parentId, name, timestamp, timestamp);
    audit(userId, null, "folder.create", { folderId: id, ...(parentId ? { parentId } : {}) });
  })();
  return { id, parent_id: parentId, name, created_at: timestamp, updated_at: timestamp };
}
