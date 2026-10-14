import type { ReactNode } from "react";
import { Ban, Check, Circle, LoaderCircle, SkipForward } from "lucide-react";
import type { PlanTodo, RunPlan } from "../../shared/reportsGenerate";

const STATUS_TEXT: Record<PlanTodo["status"], string> = { open: "To do", in_progress: "In progress", done: "Done", skipped: "Skipped", blocked: "Blocked" };
const KIND_TEXT: Record<PlanTodo["kind"], string> = { kpi: "KPI", chart: "Chart", table: "Table", markdown: "Text", explore: "Explore" };

function StatusIcon({ status }: { status: PlanTodo["status"] }) {
  if (status === "done") return <Check aria-hidden="true" />;
  if (status === "in_progress") return <LoaderCircle className="spin" aria-hidden="true" />;
  if (status === "skipped") return <SkipForward aria-hidden="true" />;
  if (status === "blocked") return <Ban aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

/** The plan's todos grouped by section: what each covers, its status, its note, and the query it ended on. */
export function planGroups(plan: RunPlan): Array<{ id: string | null; title: string | null; todos: PlanTodo[] }> {
  const groups: Array<{ id: string | null; title: string | null; todos: PlanTodo[] }> = [];
  const loose = plan.todos.filter((todo) => !todo.section || !plan.sections.some((section) => section.id === todo.section));
  if (loose.length) groups.push({ id: null, title: null, todos: loose });
  for (const section of plan.sections) {
    const todos = plan.todos.filter((todo) => todo.section === section.id);
    if (todos.length) groups.push({ id: section.id, title: section.title, todos });
  }
  return groups;
}

/** A step as the grouping reads it: its tool and its arguments (JSON, or a cut preview of it). */
export type GroupableStep = { tool: string; args: string | null };

const PLAN_TOOLS = new Set(["plan_report", "plan_change", "add_todo", "revise_plan"]);
const FINAL_TOOLS = new Set(["submit_report", "submit_patch"]);
/** A string field of the arguments; a cut preview is read with a pattern. */
function argField(args: string | null, name: string): string | null {
  if (!args) return null;
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  } catch {
    return new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]{1,80})"`).exec(args)?.[1] ?? null;
  }
}

/**
 * The steps grouped under the plan's todos (the live log and Runs): an update_todo belongs to its todo;
 * a run_sql with a key to the todo that ends on that key; any other step to the todo in progress, if
 * any. The rest (reading before the plan, planning, submitting) stays in `general`, in order.
 */
export function groupStepsByTodo<T extends GroupableStep>(plan: RunPlan, steps: readonly T[]): { byTodo: Map<string, T[]>; general: T[] } {
  const byTodo = new Map<string, T[]>();
  const general: T[] = [];
  const known = new Set(plan.todos.map((todo) => todo.id));
  let current: string | null = null;
  const put = (id: string | null, step: T) => {
    if (id && known.has(id)) byTodo.set(id, [...(byTodo.get(id) ?? []), step]);
    else general.push(step);
  };
  for (const step of steps) {
    if (PLAN_TOOLS.has(step.tool) || FINAL_TOOLS.has(step.tool)) { general.push(step); continue; }
    if (step.tool === "update_todo") {
      const id = argField(step.args, "id");
      const status = argField(step.args, "status");
      put(id, step);
      if (status === "in_progress") current = id;
      else if (id && id === current) current = null;
      continue;
    }
    const key = step.tool === "run_sql" ? argField(step.args, "key") : null;
    const owner = key ? plan.todos.find((todo) => todo.queryKey === key)?.id ?? current : current;
    put(owner, step);
  }
  return { byTodo, general };
}

/** The agent's plan (2c) as a checklist: live while a report generates, and in Runs afterwards; `stepsOf` puts each todo's steps under it. */
export function PlanChecklist({ plan, heading = "Plan", stepsOf }: { plan: RunPlan; heading?: string; stepsOf?: (todoId: string) => ReactNode }) {
  const done = plan.todos.filter((todo) => todo.status === "done").length;
  return <section className="plan-checklist" aria-label={heading}>
    <p className="plan-goal"><strong>{heading}</strong> · {done} of {plan.todos.length} done{plan.goal ? ` · ${plan.goal}` : ""}</p>
    {planGroups(plan).map((group) => <div key={group.id ?? "_"} className="plan-group">
      {group.title && <h3>{group.title}</h3>}
      <ol>
        {group.todos.map((todo) => <li key={todo.id} className={`plan-todo is-${todo.status}`}>
          <span className="plan-todo-icon"><StatusIcon status={todo.status} /></span>
          <div className="plan-todo-body">
            <span className="plan-todo-title">{todo.title}</span>
            <span className="plan-todo-meta">{KIND_TEXT[todo.kind]} · {STATUS_TEXT[todo.status]}{todo.queryKey ? <> · <code>{todo.queryKey}</code></> : null}</span>
            {todo.note && <span className="plan-todo-note">{todo.note}</span>}
            {stepsOf?.(todo.id)}
          </div>
        </li>)}
      </ol>
    </div>)}
  </section>;
}
