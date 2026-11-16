// A card's priority (docs/plan/TASK_PRIORITY.md, D1310, D1317): the words, the icons, the compact
// indicator the card faces, list rows, and table show, and the card's dropdown. No indicator for a
// card without a priority. Every label is React text (T98).
import { Flame, Minus } from "lucide-react";
import { Select } from "../ui/Select";
import type { Option, Presentation } from "../ui/Listbox";
import { TASK_PRIORITIES, type TaskPriority } from "../../shared/taskQuery";

export { TASK_PRIORITIES, type TaskPriority };

export const PRIORITY_LABELS: Record<TaskPriority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

/** How many of the three bars High, Medium, and Low fill. */
const BAR_LEVELS = { high: 3, medium: 2, low: 1 } as const;

/**
 * Three rising bars with the priority's share filled and the rest dimmed, so Low still shows the
 * whole scale at 14 px (lucide's signal icons draw only the filled bars, and Low reads as a dot).
 */
function PriorityBars({ level, className }: { level: number; className: string }) {
  return <svg className={className} viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    {[0, 1, 2].map((bar) => <rect key={bar} x={3 + bar * 7} y={20 - (7 + bar * 5)} width="4.5" height={7 + bar * 5} rx="1.2" opacity={bar < level ? 1 : 0.28} />)}
  </svg>;
}

export const isPriority = (value: unknown): value is TaskPriority => typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);

/** A `priority:` value in words: "Urgent", "No priority". */
export const priorityLabel = (value: string) => value === "none" ? "No priority" : isPriority(value) ? PRIORITY_LABELS[value] : value;

/**
 * A priority's icon in its tone: Urgent keeps the red flame it had as a flag; High (orange), Medium
 * (yellow), and Low (muted blue) are bars.
 */
export function PriorityIcon({ priority }: { priority: TaskPriority }) {
  const className = `task-priority-icon priority-${priority}`;
  return priority === "urgent" ? <Flame className={className} aria-hidden="true" /> : <PriorityBars level={BAR_LEVELS[priority]} className={className} />;
}

/** The compact indicator: the icon alone, named "Urgent priority" for screen readers; nothing without a priority. */
export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  if (!isPriority(priority)) return null;
  const name = `${PRIORITY_LABELS[priority]} priority`;
  return <span className={`task-priority priority-${priority}`} role="img" aria-label={name} title={name}><PriorityIcon priority={priority} /></span>;
}

type PriorityChoice = TaskPriority | "none";

/** A list option's icon: the priority's, or a muted dash for No priority (the dropdown and the filter's values). */
export const priorityIconFor = (choice: PriorityChoice) =>
  choice === "none" ? <Minus className="task-priority-icon priority-none" aria-hidden="true" /> : <PriorityIcon priority={choice} />;

const OPTIONS: Option<PriorityChoice>[] = [
  { value: "none", label: "No priority", icon: priorityIconFor("none") },
  ...TASK_PRIORITIES.map((priority) => ({ value: priority, label: PRIORITY_LABELS[priority], icon: priorityIconFor(priority) }))
];

type PriorityPickerProps = {
  id: string;
  /** The field's visible label. */
  labelledBy: string;
  priority: TaskPriority | null;
  disabled?: boolean;
  /** Saves the choice; null clears the priority. */
  onChange: (priority: TaskPriority | null) => void;
  /** Tests: open the list, as a popup or a sheet. */
  presentation?: Presentation;
  defaultOpen?: boolean;
};

/** The card's Priority field: the app's select (no native select, D91), keyboard and type-ahead included. */
export function PriorityPicker({ id, labelledBy, priority, disabled = false, onChange, presentation, defaultOpen }: PriorityPickerProps) {
  return <Select<PriorityChoice> id={id} labelledBy={labelledBy} label="Priority" value={priority ?? "none"} options={OPTIONS} searchable={false} disabled={disabled}
    className="task-priority-select" presentation={presentation} defaultOpen={defaultOpen} onChange={(value) => onChange(value === "none" ? null : value)} />;
}
