import { audit } from "../db";
import { CSV_EXPORT_ROWS, csvText } from "../csvExport";
import { cardKey } from "../../shared/boardKeys";
import { getBoard } from "./service";

/**
 * A board's cards as CSV (D1387): any reader of the board (`getBoard` checks it, T39), its live cards
 * in board order, archived ones too when `archived` is set. Assignees who can no longer read the board
 * are still named, as the card shows them. Audited (`tasks.export`).
 */

const PRIORITY: Record<string, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export function boardCsv(userId: string, boardId: string, options: { archived: boolean }) {
  const detail = getBoard(userId, boardId, { includeArchived: options.archived });
  const code = detail.board.code;
  const columns = new Map(detail.columns.map((column) => [column.id, column]));
  const tags = new Map(detail.tags.map((tag: { id: string; name: string }) => [tag.id, tag.name]));
  const sprints = new Map(detail.sprints.map((sprint) => [sprint.id, sprint.name]));
  const keys = new Map(detail.cards.map((card) => [card.id, cardKey(code, card.number) ?? ""]));
  const cards = detail.cards.slice(0, CSV_EXPORT_ROWS);
  const rows = cards.map((card) => {
    const column = columns.get(card.column_id);
    return [
      keys.get(card.id) ?? "", card.title, column?.name ?? "", column?.is_done === 1 ? "Yes" : "No", card.priority ? PRIORITY[card.priority] ?? card.priority : "",
      card.assignees.map((person) => person.display_name).join("; "), card.tag_ids.map((id) => tags.get(id) ?? "").filter(Boolean).join("; "),
      card.start_on ?? "", card.due_on ?? "", card.due_time ?? "", card.estimate ?? "", card.parent_card_id ? keys.get(card.parent_card_id) || "" : "",
      card.sprint_id ? sprints.get(card.sprint_id) ?? "" : "", card.child_count ? `${card.done_child_count}/${card.child_count}` : "", card.comment_count,
      card.description_excerpt, card.created_at, card.updated_at, card.done_at ?? "", card.archived_at ?? ""
    ];
  });
  audit(userId, null, "tasks.export", { boardId, rows: rows.length, archived: options.archived });
  return {
    name: detail.board.name,
    text: csvText(["Key", "Title", "Column", "Done", "Priority", "Assignees", "Tags", "Start", "Due", "Due time", "Estimate", "Parent", "Sprint", "Subitems done", "Comments", "Description (start)", "Created", "Updated", "Done at", "Archived at"], rows, detail.cards.length > CSV_EXPORT_ROWS)
  };
}
