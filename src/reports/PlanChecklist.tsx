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

/** The agent's plan (2c) as a checklist: live while a report generates, and in Runs afterwards. */
export function PlanChecklist({ plan, heading = "Plan" }: { plan: RunPlan; heading?: string }) {
  const done = plan.todos.filter((todo) => todo.status === "done").length;
  return <section className="plan-checklist" aria-label={heading}>
    <p className="plan-goal"><strong>{heading}</strong> · {done} of {plan.todos.length} done{plan.goal ? ` · ${plan.goal}` : ""}</p>
    {planGroups(plan).map((group) => <div key={group.id ?? "_"} className="plan-group">
      {group.title && <h3>{group.title}</h3>}
      <ol>
        {group.todos.map((todo) => <li key={todo.id} className={`plan-todo is-${todo.status}`}>
          <span className="plan-todo-icon"><StatusIcon status={todo.status} /></span>
          <span className="plan-todo-body">
            <span className="plan-todo-title">{todo.title}</span>
            <span className="plan-todo-meta">{KIND_TEXT[todo.kind]} · {STATUS_TEXT[todo.status]}{todo.queryKey ? <> · <code>{todo.queryKey}</code></> : null}</span>
            {todo.note && <span className="plan-todo-note">{todo.note}</span>}
          </span>
        </li>)}
      </ol>
    </div>)}
  </section>;
}
