import { createContext, useContext } from "react";
import { MessageSquarePlus } from "lucide-react";

/**
 * "Ask for a change" on one block (Wave 48): the report page provides how a comment starts (it opens
 * the Changes panel aimed at the block); the inspect sheet (and the block menu, through the same
 * button) only asks for it, so the viewer's components need no new props.
 */
export const ReportCommentContext = createContext<((blockId: string | null) => void) | null>(null);

export function CommentOnBlockButton({ blockId, className = "secondary-button report-comment-button", onBefore }: { blockId: string; className?: string; onBefore?: () => void }) {
  const comment = useContext(ReportCommentContext);
  if (!comment) return null;
  return <button type="button" className={className} role={className === "report-menu-comment" ? "menuitem" : undefined} onClick={() => { onBefore?.(); comment(blockId); }}>
    <MessageSquarePlus aria-hidden="true" />Ask for a change
  </button>;
}
