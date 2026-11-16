import {
  Archive, Building2, Calendar, CalendarCheck, CalendarClock, Presentation, Sunrise, CalendarDays, CalendarPlus, ChartColumn, ClipboardList, Clock, File, FileText, FolderClock, Gauge, Handshake,
  KanbanSquare, Link2, Megaphone, MessageCircle, MessageCircleQuestion, MessageSquareText, MessagesSquare, PenTool, Rows3, SquareCheck, Table2, Target, Timer, Contact,
  type LucideIcon
} from "lucide-react";
import { WORK_KIND_ICONS, WORK_KIND_MODULE, type WorkKind } from "../../../shared/workRefs";

/** The lucide icons a WorkSummary may name (shared/workRefs.ts WORK_KIND_ICONS), by name. */
const ICONS: Record<string, LucideIcon> = {
  "square-check": SquareCheck, "kanban-square": KanbanSquare, timer: Timer, "file-text": FileText, file: File, "pen-tool": PenTool, "calendar-days": CalendarDays,
  calendar: Calendar, "table-2": Table2, "rows-3": Rows3, "chart-column": ChartColumn, "clipboard-list": ClipboardList, "message-square-text": MessageSquareText,
  clock: Clock, "folder-clock": FolderClock, target: Target, gauge: Gauge, "message-circle": MessageCircle, "messages-square": MessagesSquare, contact: Contact,
  "building-2": Building2, handshake: Handshake, "calendar-check": CalendarCheck, "calendar-plus": CalendarPlus, megaphone: Megaphone,
  "message-circle-question": MessageCircleQuestion
};

/** A summary's icon by name, else its kind's, else a link. Unknown names never render arbitrary content. */
export const workIcon = (name: string | undefined, kind?: WorkKind): LucideIcon => (name && ICONS[name]) || (kind && ICONS[WORK_KIND_ICONS[kind]]) || Link2;

/** The app (sidebar id) a kind's items open in. */
export function appOfKind(kind: WorkKind | "chat"): string {
  const module = WORK_KIND_MODULE[kind as WorkKind];
  if (module) return module;
  switch (kind) {
    case "note": return "notes";
    case "document": return "files";
    case "whiteboard": return "whiteboards";
    case "report": return "reports";
    case "card": case "board": case "sprint": return "tasks";
    case "event": case "calendar": return "calendar";
    case "collection": case "row": return "collections";
    default: return kind;
  }
}

/**
 * Each app's icon as the sidebar draws it (MODULES and the workspace modules' `icon`; D1346): the one
 * icon map the ⌘K palette's results and Recent and the link picker's rows use, so a note is the
 * Notes archive icon everywhere. tests/searchEverywhereClient.test.tsx keeps it equal to MODULES.
 */
export const APP_ICONS: Readonly<Record<string, LucideIcon>> = {
  notes: Archive, files: FileText, tasks: KanbanSquare, collections: Table2, calendar: CalendarDays, whiteboards: PenTool, reports: ChartColumn,
  chat: MessagesSquare, forms: ClipboardList, time: Timer, goals: Target, checkins: Sunrise, crm: Contact, bookings: CalendarClock, townhall: Presentation
};

/** A kind's icon: its app's sidebar icon, else the kind's own. */
export const appIcon = (kind: WorkKind | "chat"): LucideIcon => APP_ICONS[appOfKind(kind)] ?? (kind === "chat" ? MessagesSquare : workIcon(undefined, kind));
