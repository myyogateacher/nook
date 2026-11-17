/**
 * Who may comment on a container's Activity panel (D1375): comment level and up. The server already
 * caps a viewer's or guest's level at `view` (capByRole, D266), so the level alone decides; null or
 * undefined (no level, e.g. a respondent who only answers) never comments. Pure.
 */
export function canCommentAtLevel(level: string | null | undefined): boolean {
  return level === "comment" || level === "edit" || level === "manage" || level === "owner";
}
