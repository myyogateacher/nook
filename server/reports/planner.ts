import { db } from "../db";
import { logger } from "../log";
import { BLOCK_INTENTS, type ReportSpec } from "../../shared/reports";
import { PLAN_LIMITS, PLAN_TODO_KINDS, type PlanTodo, type PlanTodoKind, type RunPlan } from "../../shared/reportsGenerate";
import { ReportError } from "./errors";

/**
 * The report agents' planner (generate.ts: plan_report; edit.ts: plan_change). The agent reads the
 * doc (or the instruction), plans its sections and todos, works through them, and submits only when
 * every todo is closed. Everything here is deterministic: a plan is validated (1–24 todos, unique ids,
 * known kinds and intents, tables that exist in the data source's allowlisted catalog, with the
 * closest names suggested for one that does not), `done` on a kpi, chart, or table todo needs a query
 * key that ran successfully in this run, and `skipped` / `blocked` need a reason. The plan is saved on
 * the run after every change (report_runs.plan_json), so the live view, Runs, and Provenance show it.
 */

const plog = logger("reports");
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const QUERY_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** Todo kinds a block answers: done needs a successful query key, and submit needs a block on it. */
const DATA_KINDS: ReadonlySet<PlanTodoKind> = new Set(["kpi", "chart", "table"]);

const invalid = (message: string) => new ReportError(400, "INVALID", message);
const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Edit distance, for "did you mean" suggestions (names are short). */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The data source's allowlisted catalog tables (db.table, lower case), the planner's table check. */
export function catalogTables(datasourceId: string): string[] {
  return (db.query("SELECT db, name FROM report_schema_tables WHERE datasource_id = ?").all(datasourceId) as Array<{ db: string; name: string }>).map((row) => `${row.db}.${row.name}`);
}

export function suggestTables(name: string, known: readonly string[], count = 3): string[] {
  const wanted = name.toLowerCase();
  const bare = wanted.includes(".") ? wanted.split(".").pop()! : wanted;
  return [...known].map((table) => ({ table, score: Math.min(editDistance(wanted, table.toLowerCase()), editDistance(bare, table.toLowerCase().split(".").pop()!)) }))
    .sort((a, b) => a.score - b.score || a.table.localeCompare(b.table)).slice(0, count).map((item) => item.table);
}

export type PlannerMode = "report" | "change";

export class Planner {
  plan: RunPlan | null = null;
  /** Query keys run_sql ran successfully in this run (key → the SQL). */
  readonly ranKeys = new Map<string, string>();
  constructor(private readonly options: { mode: PlannerMode; datasourceId: string | null; runId: string; database?: string; /** E4: the metric catalog's ids and names. */ metrics?: ReadonlyArray<{ id: string; name: string }> }) {}

  /** E4: a todo's catalog metric: the metricId it names (unknown is an error), else a catalog metric whose name or id is its metric. */
  private metricIdOf(item: Record<string, unknown>, metric: string | null, errors: string[], where: string): string | null {
    const catalog = this.options.metrics ?? [];
    if (!catalog.length) return null;
    const given = text(item.metricId, 40);
    if (given) {
      if (catalog.some((entry) => entry.id === given)) return given;
      errors.push(`${where}: metricId ${given} is not in the metric catalog (ids: ${catalog.map((entry) => entry.id).slice(0, 24).join(", ")})`);
      return null;
    }
    const wanted = metric?.toLowerCase().trim();
    return wanted ? catalog.find((entry) => entry.name.toLowerCase() === wanted || entry.id === wanted)?.id ?? null : null;
  }

  private save() {
    if (!this.plan) return;
    try {
      db.query("UPDATE report_runs SET plan_json = ? WHERE id = ?").run(JSON.stringify(this.plan).slice(0, 65_536), this.options.runId);
    } catch (error) {
      plog.warn("Could not save the run's plan", { err: error });
    }
  }

  private tablesOf(raw: unknown, errors: string[], where: string): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { errors.push(`${where}: tables must be a list of db.table names`); return []; }
    const names = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 10);
    if (!this.options.datasourceId) return names;
    const known = catalogTables(this.options.datasourceId);
    const lower = new Set(known.map((table) => table.toLowerCase()));
    for (const name of names) {
      const qualified = name.includes(".") ? name : `${this.options.database ?? ""}.${name}`;
      if (!lower.has(qualified.toLowerCase())) {
        const near = suggestTables(name, known);
        errors.push(`${where}: no allowlisted table ${name}${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}`);
      }
    }
    return names;
  }

  private todoOf(raw: unknown, index: number, sectionIds: ReadonlySet<string>, errors: string[]): PlanTodo | null {
    const where = `todo ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${where}: must be an object`); return null; }
    const item = raw as Record<string, unknown>;
    const id = text(item.id, 40);
    if (!ID.test(id)) errors.push(`${where}: id must be 1–40 letters, digits, _ or -`);
    const title = text(item.title, PLAN_LIMITS.title);
    if (!title) errors.push(`${where} (${id}): title is required`);
    const kind = item.kind as PlanTodoKind;
    if (!PLAN_TODO_KINDS.includes(kind)) errors.push(`${where} (${id}): kind must be one of ${PLAN_TODO_KINDS.join(", ")}`);
    const intent = item.intent === undefined || item.intent === null ? null : text(item.intent, 20);
    if (intent !== null && !(BLOCK_INTENTS as readonly string[]).includes(intent)) errors.push(`${where} (${id}): intent must be one of ${BLOCK_INTENTS.join(", ")}`);
    const section = item.section === undefined || item.section === null ? null : text(item.section, 40);
    if (section !== null && !sectionIds.has(section)) errors.push(`${where} (${id}): section ${section} is not one of the plan's sections`);
    const metric = text(item.metric, 120) || null;
    const metricId = this.metricIdOf(item, metric, errors, `${where} (${id})`);
    return {
      id, title, kind, section, intent, metric, docRef: text(item.docRef, 200) || null,
      tables: this.tablesOf(item.tables, errors, `${where} (${id})`), status: "open", note: null, queryKey: null, blockId: null, ...(metricId ? { metricId } : {})
    };
  }

  /** plan_report / plan_change: validates and keeps the plan, or throws INVALID listing every problem. */
  makePlan(args: Record<string, unknown>): string {
    if (this.plan) throw invalid("The plan is already made; use update_todo, add_todo, or revise_plan");
    const errors: string[] = [];
    const goal = text(args.goal, PLAN_LIMITS.goal) || (this.options.mode === "change" ? "The requested change" : "");
    if (!goal) errors.push("goal is required: one sentence on what the report answers");
    const sections: RunPlan["sections"] = [];
    if (args.sections !== undefined && !Array.isArray(args.sections)) errors.push("sections must be a list of {id, title}");
    for (const raw of Array.isArray(args.sections) ? args.sections.slice(0, PLAN_LIMITS.sections + 1) : []) {
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const id = text(item.id, 40);
      const title = text(item.title, 120);
      if (!ID.test(id) || !title) { errors.push(`section ${sections.length + 1}: needs an id (letters, digits, _ or -) and a title`); continue; }
      if (sections.some((section) => section.id === id)) { errors.push(`section ${id}: the id is used twice`); continue; }
      sections.push({ id, title });
    }
    if (sections.length > PLAN_LIMITS.sections) errors.push(`at most ${PLAN_LIMITS.sections} sections`);
    const rawTodos = Array.isArray(args.todos) ? args.todos : [];
    if (rawTodos.length < 1 || rawTodos.length > PLAN_LIMITS.todos) errors.push(`todos: 1–${PLAN_LIMITS.todos} todos, one per metric or question`);
    const ids = new Set(sections.map((section) => section.id));
    const todos = rawTodos.slice(0, PLAN_LIMITS.todos).map((raw, index) => this.todoOf(raw, index, ids, errors)).filter((todo): todo is PlanTodo => todo !== null);
    const seen = new Set<string>();
    for (const todo of todos) {
      if (seen.has(todo.id)) errors.push(`todo ${todo.id}: the id is used twice`);
      seen.add(todo.id);
    }
    if (errors.length) throw invalid(`The plan was not accepted:\n- ${errors.slice(0, 20).join("\n- ")}\nFix these and call ${this.options.mode === "change" ? "plan_change" : "plan_report"} again.`);
    this.plan = { goal, sections, todos, added: 0 };
    this.save();
    plog.info("Plan made", { mode: this.options.mode, todos: todos.length, sections: sections.length });
    return `Plan saved: ${todos.length} ${todos.length === 1 ? "todo" : "todos"}${sections.length ? ` in ${sections.length} sections` : ""}. Work through them: for each, run_sql with a key, then update_todo {id, status: "done", queryKey}. Mark a todo skipped or blocked with a note when the data cannot answer it.`;
  }

  private need(): RunPlan {
    if (!this.plan) throw invalid(`Make the plan first: call ${this.options.mode === "change" ? "plan_change" : "plan_report"}`);
    return this.plan;
  }

  /** update_todo {id, status, note?, queryKey?, blockId?}. */
  updateTodo(args: Record<string, unknown>): string {
    const plan = this.need();
    const todo = plan.todos.find((item) => item.id === args.id);
    if (!todo) throw invalid(`There is no todo ${text(args.id, 40)}; the todos are ${plan.todos.map((item) => item.id).join(", ")}`);
    const status = args.status;
    if (status !== "in_progress" && status !== "done" && status !== "skipped" && status !== "blocked") throw invalid("status must be in_progress, done, skipped, or blocked");
    const note = text(args.note, PLAN_LIMITS.note) || null;
    const queryKey = args.queryKey === undefined || args.queryKey === null ? null : text(args.queryKey, 40);
    if ((status === "skipped" || status === "blocked") && !note) throw invalid(`A ${status} todo needs a note saying why (for example "no table has refunds by channel")`);
    if (status === "done" && DATA_KINDS.has(todo.kind)) {
      if (!queryKey) throw invalid(`Todo ${todo.id} is a ${todo.kind}: done needs the queryKey of a run_sql that worked in this run`);
      if (!this.ranKeys.has(queryKey)) throw invalid(`No run_sql with key ${queryKey} worked in this run${this.ranKeys.size ? ` (keys that did: ${[...this.ranKeys.keys()].join(", ")})` : ""}; run the query with that key first`);
    }
    if (queryKey !== null && !QUERY_KEY.test(queryKey)) throw invalid("queryKey must be [a-z][a-z0-9_]*");
    todo.status = status;
    todo.note = note ?? todo.note;
    if (queryKey) todo.queryKey = queryKey;
    if (typeof args.blockId === "string") todo.blockId = text(args.blockId, 40) || null;
    this.save();
    const left = plan.todos.filter((item) => item.status === "open" || item.status === "in_progress").length;
    return `Todo ${todo.id} is ${status}. ${left ? `${left} still open.` : "Every todo is closed: submit now."}`;
  }

  /** add_todo {todo}: at most PLAN_LIMITS.added more in a run. */
  addTodo(args: Record<string, unknown>): string {
    const plan = this.need();
    if (plan.added >= PLAN_LIMITS.added || plan.todos.length >= PLAN_LIMITS.todos + PLAN_LIMITS.added) throw invalid(`The plan can grow by at most ${PLAN_LIMITS.added} todos; finish or skip the ones you have`);
    const errors: string[] = [];
    const todo = this.todoOf(args.todo ?? args, plan.todos.length, new Set(plan.sections.map((section) => section.id)), errors);
    if (todo && plan.todos.some((item) => item.id === todo.id)) errors.push(`todo ${todo.id}: the id is used twice`);
    if (errors.length || !todo) throw invalid(`The todo was not added:\n- ${errors.join("\n- ")}`);
    plan.todos.push(todo);
    plan.added += 1;
    this.save();
    return `Added todo ${todo.id}.`;
  }

  /** revise_plan {sections?, drop?: [ids of open todos], note}: small changes mid-run. */
  revisePlan(args: Record<string, unknown>): string {
    const plan = this.need();
    const note = text(args.note, PLAN_LIMITS.note);
    if (!note) throw invalid("revise_plan needs a note saying why the plan changes");
    if (Array.isArray(args.sections)) {
      for (const raw of args.sections.slice(0, PLAN_LIMITS.sections)) {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const id = text(item.id, 40);
        const title = text(item.title, 120);
        if (!ID.test(id) || !title) throw invalid("each section needs an id and a title");
        const existing = plan.sections.find((section) => section.id === id);
        if (existing) existing.title = title;
        else if (plan.sections.length < PLAN_LIMITS.sections) plan.sections.push({ id, title });
      }
    }
    for (const id of Array.isArray(args.drop) ? args.drop : []) {
      const todo = plan.todos.find((item) => item.id === id);
      if (todo && (todo.status === "open" || todo.status === "in_progress")) { todo.status = "skipped"; todo.note = note; }
    }
    this.save();
    return "Plan revised.";
  }

  /** run_sql with a key that worked. */
  recordQuery(key: string, sql: string) {
    if (QUERY_KEY.test(key)) this.ranKeys.set(key, sql);
  }

  /** The second submit with open todos (the first is refused): they are closed as skipped with this note. */
  closeOpen(note: string): number {
    const open = this.openTodos();
    for (const todo of open) { todo.status = "skipped"; todo.note = note; }
    if (open.length) this.save();
    return open.length;
  }

  /** Whether a submit already came back for open todos (the next one closes them). */
  openRefused = false;

  openTodos(): PlanTodo[] {
    return this.plan?.todos.filter((todo) => todo.status === "open" || todo.status === "in_progress") ?? [];
  }

  /** What a submit must satisfy: a plan, every todo closed, each done data todo's key on a block, its section kept. */
  submitErrors(spec: Pick<ReportSpec, "blocks" | "sections">): string[] {
    if (!this.plan) return [`Make the plan first: call ${this.options.mode === "change" ? "plan_change" : "plan_report"}, then work through it`];
    const errors: string[] = [];
    const open = this.openTodos();
    if (open.length) errors.push(`plan: ${open.length} ${open.length === 1 ? "todo is" : "todos are"} still open (${open.map((todo) => todo.id).join(", ")}); mark each done, skipped, or blocked with update_todo`);
    const keyed = new Map<string, Array<{ section: string | null | undefined }>>();
    for (const block of spec.blocks) {
      const key = (block as { queryKey?: string }).queryKey;
      if (key) keyed.set(key, [...(keyed.get(key) ?? []), { section: (block as { section?: string | null }).section }]);
    }
    const specSections = new Set((spec.sections ?? []).map((section) => section.id));
    for (const todo of this.plan.todos) {
      if (todo.status !== "done" || !DATA_KINDS.has(todo.kind) || !todo.queryKey) continue;
      const blocks = keyed.get(todo.queryKey);
      if (!blocks) { errors.push(`plan: todo ${todo.id} is done with query ${todo.queryKey}, but no block uses that query`); continue; }
      if (this.options.mode === "report" && todo.section && specSections.has(todo.section) && !blocks.some((block) => block.section === todo.section)) {
        errors.push(`plan: todo ${todo.id} belongs in section ${todo.section}; put its block there`);
      }
    }
    if (this.options.mode === "report") {
      const planned = new Set(this.plan.todos.filter((todo) => todo.status === "done" && todo.section).map((todo) => todo.section!));
      for (const section of this.plan.sections) {
        if (planned.has(section.id) && !specSections.has(section.id)) errors.push(`plan: section ${section.id} ("${section.title}") has done todos but is not in the spec's sections`);
      }
    }
    return errors;
  }

  /** The skipped and blocked todos as a short "Not covered" note (markdown), or null. */
  notCovered(): string | null {
    const left = this.plan?.todos.filter((todo) => todo.status === "skipped" || todo.status === "blocked") ?? [];
    if (!left.length) return null;
    const line = (todo: PlanTodo) => `- ${todo.title.replace(/[*_`[\]<>]/g, "")}: ${(todo.note ?? todo.status).replace(/[*_`[\]<>]/g, "")}`;
    return `**Not covered**\n\n${left.slice(0, 12).map(line).join("\n")}`;
  }

  counts() {
    const todos = this.plan?.todos ?? [];
    return { todos: todos.length, done: todos.filter((todo) => todo.status === "done").length, skipped: todos.filter((todo) => todo.status === "skipped").length, blocked: todos.filter((todo) => todo.status === "blocked").length };
  }
}

/** A stored plan (report_runs.plan_json), or null. */
export function storedPlan(json: string | null | undefined): RunPlan | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as RunPlan;
    return value && Array.isArray(value.todos) ? value : null;
  } catch {
    return null;
  }
}

const todoProperties = {
  id: { type: "string", maxLength: 40 }, title: { type: "string", maxLength: PLAN_LIMITS.title }, kind: { type: "string", enum: [...PLAN_TODO_KINDS] },
  section: { type: "string", maxLength: 40 }, metric: { type: "string", maxLength: 120 }, docRef: { type: "string", maxLength: 200 },
  tables: { type: "array", maxItems: 10, items: { type: "string" } }, intent: { type: "string", enum: [...BLOCK_INTENTS] },
  metricId: { type: "string", maxLength: 40, description: "The metric catalog's id, when the todo is one of its metrics" }
};
const todoSchema = { type: "object", required: ["id", "title", "kind"], properties: todoProperties };

/** The planner tools as the model sees them (`plan` is plan_report or plan_change). */
export function plannerTools(mode: PlannerMode) {
  const planName = mode === "change" ? "plan_change" : "plan_report";
  return [
    mode === "change"
      ? { name: planName, description: "Plans the change before you edit: the todos it takes (one per block or query to add or change). Call it once, first.", parameters: { type: "object", required: ["todos"], properties: { goal: { type: "string", maxLength: PLAN_LIMITS.goal }, todos: { type: "array", minItems: 1, maxItems: PLAN_LIMITS.todos, items: todoSchema } } } }
      : { name: planName, description: "Plans the report after reading the doc: its goal, sections, and todos (one per metric or question in the doc: kpi, chart, table, markdown, or explore), each with the tables it needs. Call it once, before run_sql.", parameters: { type: "object", required: ["goal", "todos"], properties: { goal: { type: "string", maxLength: PLAN_LIMITS.goal }, sections: { type: "array", maxItems: PLAN_LIMITS.sections, items: { type: "object", required: ["id", "title"], properties: { id: { type: "string", maxLength: 40 }, title: { type: "string", maxLength: 120 } } } }, todos: { type: "array", minItems: 1, maxItems: PLAN_LIMITS.todos, items: todoSchema } } } },
    { name: "update_todo", description: "Marks a todo in_progress, done (a kpi, chart, or table todo needs the queryKey of a run_sql that worked), skipped, or blocked (both need a note saying why).", parameters: { type: "object", required: ["id", "status"], properties: { id: { type: "string" }, status: { type: "string", enum: ["in_progress", "done", "skipped", "blocked"] }, note: { type: "string", maxLength: PLAN_LIMITS.note }, queryKey: { type: "string", maxLength: 40 }, blockId: { type: "string", maxLength: 40 } } } },
    { name: "add_todo", description: `Adds one todo you found you need (at most ${PLAN_LIMITS.added} in a run).`, parameters: { type: "object", required: ["todo"], properties: { todo: todoSchema } } },
    { name: "revise_plan", description: "Small changes mid-run: add or rename sections, or drop open todos (they become skipped with your note).", parameters: { type: "object", required: ["note"], properties: { note: { type: "string", maxLength: PLAN_LIMITS.note }, sections: { type: "array", items: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" } } } }, drop: { type: "array", items: { type: "string" } } } } }
  ];
}

/** Tools that may run before the plan (they only read): the rest are refused until it is made. */
export const BEFORE_PLAN_TOOLS: ReadonlySet<string> = new Set(["search_schema", "list_tables", "describe_tables", "read_doc_section"]);
