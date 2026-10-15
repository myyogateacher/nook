import { useRef } from "react";
import { Star } from "lucide-react";
import { errorText, notify } from "../ui/notify";
import { starReport } from "./reportsApi";

/**
 * Report organization phase 1 (D486): ☆/★ on a report row and the report header. The toggle is
 * optimistic: `onChange` shows the new state at once, and an error puts it back with a toast. A second
 * click while one is in flight waits for it, so the server ends on the last state shown.
 */
export function StarButton({ reportId, title, favorite, onChange, className = "" }: { reportId: string; title: string; favorite: boolean; onChange: (favorite: boolean) => void; className?: string }) {
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const toggle = () => {
    const next = !favorite;
    onChange(next);
    chain.current = chain.current.then(() => starReport(reportId, next)).catch((reason: unknown) => {
      onChange(!next);
      notify.error(errorText(reason, next ? `Could not star “${title}”` : `Could not unstar “${title}”`));
    });
  };
  return <button type="button" className={`icon-button reports-star${favorite ? " on" : ""}${className ? ` ${className}` : ""}`} aria-pressed={favorite}
    aria-label={favorite ? `Unstar ${title}` : `Star ${title}`} title={favorite ? "Remove from Favorites" : "Add to Favorites"} onClick={toggle}>
    <Star aria-hidden="true" />
  </button>;
}
