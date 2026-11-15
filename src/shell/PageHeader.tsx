import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { NotificationBell } from "../notifications/NotificationBell";
import { ShellMenuButton } from "./shellContext";

type PageHeaderProps = {
  /** The page's title: a string (shown as the app's name) or the page's own heading element; none when the content carries it (a goal, D1283). */
  title?: ReactNode;
  /** A Back button before the title (a goal back to Goals, a report back to Reports). */
  back?: { label: string; onClick: () => void };
  /** The page's own actions, at the end of the row (New, ⋯, Sign out while 2FA setup is required). */
  actions?: ReactNode;
  /** False leaves the bell out (the 2FA setup screen, which has nowhere else to go). */
  bell?: boolean;
  className?: string;
};

/**
 * The one-row page header (docs/plan/LEFT_NAV.md §2.2, D1273), about 52 px: [☰ on phones] the page's
 * title … its actions … the bell (computers; on phones it is in the drawer). Home, the app's name,
 * Settings, the Inbox, the timer, and the account live in the sidebar now (AppSidebar), so the row
 * holds only what belongs to this page. It keeps the `app-page-header` class, so pages that pin or
 * size their header (sticky over a scrolling page, flex: none in a column) keep doing so.
 */
export function PageHeader({ title, back, actions, bell = true, className }: PageHeaderProps) {
  return <header className={`app-page-header page-header${className ? ` ${className}` : ""}`}>
    <ShellMenuButton />
    {back && <button type="button" className="page-header-back" onClick={back.onClick}><ChevronLeft aria-hidden="true" />{back.label}</button>}
    {title !== undefined && title !== null && <div className="page-header-title">{typeof title === "string" ? <strong>{title}</strong> : title}</div>}
    {actions && <div className="page-header-actions">{actions}</div>}
    {bell && <span className="page-header-bell"><NotificationBell /></span>}
  </header>;
}
