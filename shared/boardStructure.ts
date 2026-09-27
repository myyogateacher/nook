/**
 * Board structure: the names of a board's card levels, the work level, and
 * whether sprints are on (research 2026-09-26-task-hierarchy-workflows.md
 * D121–D123, §7.1). Pure and dependency-free, shared by the server (validation,
 * `boards.structure_json`) and the client (Board settings, the card dialog).
 *
 * - `levels` has 1–3 entries, top first. Level 0 is the top ("Epic"), level 1
 *   sits under it ("Story"), level 2 under that ("Subtask").
 * - `workLevel` is where new cards are created by default and the level the
 *   board's columns show (D126).
 * - `sprints` means the sprint is the outer grouping ("Sprint › Task"). A
 *   sprint is a time box, never a card level (D123, D124).
 */

export const MAX_LEVELS = 3;
export const LEVEL_NAME_MAX = 24;

export type LevelName = { name: string; plural: string };
export type BoardStructure = { levels: LevelName[]; workLevel: number; sprints: boolean };

export const FLAT_STRUCTURE: BoardStructure = { levels: [{ name: "Card", plural: "Cards" }], workLevel: 0, sprints: false };

export const STRUCTURE_PRESETS = ["flat", "task_subtask", "sprint_task", "sprint_task_subtask", "epic_story_subtask"] as const;
export type StructurePreset = typeof STRUCTURE_PRESETS[number];

const TASK: LevelName = { name: "Task", plural: "Tasks" };
const SUBTASK: LevelName = { name: "Subtask", plural: "Subtasks" };

export const PRESETS: Record<StructurePreset, { label: string; description: string; structure: BoardStructure }> = {
  flat: { label: "Card", description: "One level. Every card is a card on the board.", structure: FLAT_STRUCTURE },
  task_subtask: { label: "Task › Subtask", description: "Tasks on the board, each with a checklist of subtasks.", structure: { levels: [TASK, SUBTASK], workLevel: 0, sprints: false } },
  sprint_task: { label: "Sprint › Task", description: "Tasks grouped into time-boxed sprints.", structure: { levels: [TASK], workLevel: 0, sprints: true } },
  sprint_task_subtask: { label: "Sprint › Task › Subtask", description: "Tasks with subtasks, grouped into sprints.", structure: { levels: [TASK, SUBTASK], workLevel: 0, sprints: true } },
  epic_story_subtask: {
    label: "Epic › Story › Subtask",
    description: "Stories on the board, grouped under epics, each with subtasks.",
    structure: { levels: [{ name: "Epic", plural: "Epics" }, { name: "Story", plural: "Stories" }, SUBTASK], workLevel: 1, sprints: false }
  }
};

// C0/C1 controls and bidi overrides never belong in a name (as for board and column names).
const CONTROL = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export type StructureCheck = { ok: true; structure: BoardStructure } | { ok: false; error: string };

/** Validates and normalizes (trims names) a structure from a client or the database. */
export function validateStructure(input: unknown): StructureCheck {
  const fail = (error: string): StructureCheck => ({ ok: false, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("The structure must be an object");
  const value = input as Record<string, unknown>;
  const extra = Object.keys(value).filter((key) => !["levels", "workLevel", "sprints"].includes(key));
  if (extra.length) return fail(`Unknown structure field ${extra[0]}`);
  if (!Array.isArray(value.levels) || value.levels.length < 1 || value.levels.length > MAX_LEVELS) return fail(`A board has 1 to ${MAX_LEVELS} levels`);
  const levels: LevelName[] = [];
  for (const level of value.levels) {
    if (!level || typeof level !== "object" || Array.isArray(level)) return fail("Each level has a name and a plural");
    const entry = level as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "name" && key !== "plural")) return fail("Each level has only a name and a plural");
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const plural = typeof entry.plural === "string" ? entry.plural.trim() : "";
    if (!name || !plural || name.length > LEVEL_NAME_MAX || plural.length > LEVEL_NAME_MAX) return fail(`Level names are 1 to ${LEVEL_NAME_MAX} characters`);
    if (CONTROL.test(name) || CONTROL.test(plural)) return fail("Names cannot contain control characters");
    levels.push({ name, plural });
  }
  if (typeof value.workLevel !== "number" || !Number.isInteger(value.workLevel) || value.workLevel < 0 || value.workLevel >= levels.length) {
    return fail("New cards must be created at one of the board's levels");
  }
  if (typeof value.sprints !== "boolean") return fail("sprints must be true or false");
  return { ok: true, structure: { levels, workLevel: value.workLevel, sprints: value.sprints } };
}

/** The stored structure, or Flat when the stored text is missing or invalid (never throws). */
export function parseStructure(text: string | null | undefined): BoardStructure {
  if (!text) return FLAT_STRUCTURE;
  try {
    const checked = validateStructure(JSON.parse(text));
    return checked.ok ? checked.structure : FLAT_STRUCTURE;
  } catch {
    return FLAT_STRUCTURE;
  }
}

const sameLevels = (a: readonly LevelName[], b: readonly LevelName[]) =>
  a.length === b.length && a.every((level, index) => level.name === b[index]!.name && level.plural === b[index]!.plural);

/** The preset a structure matches exactly, or "custom". */
export function presetOf(structure: BoardStructure): StructurePreset | "custom" {
  for (const preset of STRUCTURE_PRESETS) {
    const candidate = PRESETS[preset].structure;
    if (sameLevels(candidate.levels, structure.levels) && candidate.workLevel === structure.workLevel && candidate.sprints === structure.sprints) return preset;
  }
  return "custom";
}

/** The level's name ("Story"); "Card" past the configured levels. */
export const levelName = (structure: BoardStructure, level: number) => structure.levels[level]?.name ?? "Card";
export const levelPlural = (structure: BoardStructure, level: number) => structure.levels[level]?.plural ?? "Cards";
/** What a card's children are called: the level below, else "Subtasks". */
export const childPlural = (structure: BoardStructure, level: number) => structure.levels[level + 1]?.plural ?? "Subtasks";
export const childName = (structure: BoardStructure, level: number) => structure.levels[level + 1]?.name ?? "Subtask";
/** Whether a card at `level` can have children on this board. */
export const canHaveChildren = (structure: BoardStructure, level: number) => level + 1 < structure.levels.length;

/**
 * A card below the work level (a subtask) needs a parent (operator QA 0.9.1): it is created and
 * moved only under one. At the work level and above a parent stays optional (an orphan story).
 * A subtask restored while its parent is in the Bin comes back detached (D130) until someone
 * chooses a parent or changes its level.
 */
export const parentRequired = (structure: BoardStructure, level: number) => level > structure.workLevel && level < structure.levels.length;

/** "a task", "an epic": the level's name with its article, lower case. */
export function aLevel(structure: BoardStructure, level: number) {
  const name = levelName(structure, level).toLowerCase();
  return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
}

/** The inline message when a subtask has no parent: "Pick the task this subtask belongs to". */
export const parentRequiredMessage = (structure: BoardStructure, level: number) =>
  `Pick the ${levelName(structure, level - 1).toLowerCase()} this ${levelName(structure, level).toLowerCase()} belongs to`;

/** "Epic › Story › Subtask", with "Sprint ›" in front when sprints are on. */
export function structureLabel(structure: BoardStructure) {
  return [...(structure.sprints ? ["Sprint"] : []), ...structure.levels.map((level) => level.name)].join(" › ");
}

/**
 * The 409 LEVEL_IN_USE message (T120), naming each removed level's count: "8 cards are Stories and
 * 6 are Subtasks (2 in the Bin). Move or change them before removing this level."
 */
export function levelInUseMessage(levels: ReadonlyArray<{ name: string; plural: string; cardCount: number }>, binnedCount = 0) {
  const total = levels.reduce((sum, level) => sum + level.cardCount, 0);
  const phrase = (level: { name: string; plural: string; cardCount: number }, first: boolean) => level.cardCount === 1
    ? `1 ${first ? "card " : ""}is ${/^[aeiou]/i.test(level.name) ? "an" : "a"} ${level.name}`
    : `${level.cardCount} ${first ? "cards " : ""}are ${level.plural}`;
  const parts = levels.map((level, index) => phrase(level, index === 0));
  const list = parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const those = total === 1 ? "it" : "them";
  const which = levels.length > 1 ? "these levels" : "this level";
  return `${list}${binnedCount ? ` (${binnedCount} in the Bin)` : ""}. Move or change ${those} before removing ${which}.`;
}

/** Hierarchy limits (D135): direct children per card; three levels are `MAX_LEVELS`. */
export const HIERARCHY_LIMITS = { childrenPerCard: 100 } as const;

// ---------------------------------------------------------------------------
// Board templates (D136, §7.4). Data only; a template never creates cards.

export type TemplateColumn = { name: string; state: "todo" | "doing" | "done" };
export const BOARD_TEMPLATES = ["kanban", "todo", "checklist", "scrum", "epics", "triage", "content"] as const;
export type BoardTemplateId = typeof BOARD_TEMPLATES[number];
export type BoardTemplate = {
  id: BoardTemplateId;
  label: string;
  description: string;
  columns: TemplateColumn[];
  structure: BoardStructure;
  /** Board tags the template adds (name, palette colour). */
  tags?: Array<{ name: string; color: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" }>;
  /** A planned first sprint of two weeks from today, by this name (17B, the Scrum template). */
  firstSprint?: string;
};

const col = (name: string, state: TemplateColumn["state"]): TemplateColumn => ({ name, state });

export const TEMPLATES: Record<BoardTemplateId, BoardTemplate> = {
  kanban: { id: "kanban", label: "Simple kanban", description: "To do, Doing, and Done. The default.", columns: [col("To do", "todo"), col("Doing", "doing"), col("Done", "done")], structure: FLAT_STRUCTURE },
  todo: { id: "todo", label: "Personal to-do", description: "A list with subtasks for the bigger items.", columns: [col("To do", "todo"), col("Done", "done")], structure: PRESETS.task_subtask.structure },
  checklist: { id: "checklist", label: "Task checklist", description: "Tasks that each carry a checklist of subtasks.", columns: [col("To do", "todo"), col("Doing", "doing"), col("Done", "done")], structure: PRESETS.task_subtask.structure },
  scrum: {
    id: "scrum", label: "Scrum sprint board", description: "Backlog to Done, with tasks and subtasks planned in sprints.",
    columns: [col("Backlog", "todo"), col("To do", "todo"), col("In progress", "doing"), col("Review", "doing"), col("Done", "done")],
    structure: PRESETS.sprint_task_subtask.structure,
    firstSprint: "Sprint 1"
  },
  epics: { id: "epics", label: "Epic › Story › Subtask", description: "Stories on the board, grouped under epics.", columns: [col("To do", "todo"), col("In progress", "doing"), col("Done", "done")], structure: PRESETS.epic_story_subtask.structure },
  triage: {
    id: "triage", label: "Bug triage", description: "Triage to Done, with Bug and Regression tags.",
    columns: [col("Triage", "todo"), col("Accepted", "todo"), col("Fixing", "doing"), col("Verify", "doing"), col("Done", "done")],
    structure: FLAT_STRUCTURE, tags: [{ name: "Bug", color: "red" }, { name: "Regression", color: "orange" }]
  },
  content: {
    id: "content", label: "Content pipeline", description: "Ideas to Published for writing and media.",
    columns: [col("Ideas", "todo"), col("Drafting", "doing"), col("Editing", "doing"), col("Scheduled", "doing"), col("Published", "done")],
    structure: FLAT_STRUCTURE
  }
};
