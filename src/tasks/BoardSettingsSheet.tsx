import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Columns3, Layers, Mail, Minus, Pencil, Plus, Share2, Trash2, X } from "lucide-react";
import { MuteEmailsToggle } from "../notifications/emailMutes";
import { trapTabKey, useDialogFocus } from "../files/Dialog";
import { Select } from "../ui/Select";
import {
  LEVEL_NAME_MAX,
  MAX_LEVELS,
  PRESETS,
  presetOf,
  STRUCTURE_PRESETS,
  structureLabel,
  validateStructure,
  type BoardStructure,
  type StructurePreset
} from "../../shared/boardStructure";
import { structureOf } from "./hierarchyModel";
import { taskErrorMessage, updateBoardStructure, type BoardSummary } from "./tasksApi";

type BoardSettingsSheetProps = {
  board: BoardSummary;
  owner: boolean;
  /** Per viewer (D126): show epics and nested subtasks as board cards. */
  showAllLevels: boolean;
  onShowAllLevels: (value: boolean) => void;
  onClose: () => void;
  /** A dialog is open over the sheet (Complete sprint): it handles Escape, and the sheet waits. */
  suspended?: boolean;
  /** The owner's actions that open their own dialogs. */
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onAddColumn: () => void;
  onStructureSaved: (board: BoardSummary) => void;
  /** Board settings → Sprint defaults (17B), shown when the saved structure has sprints on. The sprint list is the Sprints sheet. */
  sprintsSection?: ReactNode;
  notify: (message: string) => void;
};

/** The structure without its sprint defaults: what Save structure compares and sends. */
const levelsOnly = ({ levels, workLevel, sprints }: BoardStructure): BoardStructure => ({ levels, workLevel, sprints });

/** "Columns show Stories. Subtasks appear inside their story." */
export function structurePreview(structure: BoardStructure) {
  const work = structure.levels[structure.workLevel]!;
  const parts = [`Columns show ${work.plural}.`];
  const below = structure.levels[structure.workLevel + 1];
  if (below) parts.push(`${below.plural} appear inside their ${work.name.toLowerCase()}.`);
  const above = structure.levels[structure.workLevel - 1];
  if (above) parts.push(`${above.plural} show as a chip on each ${work.name.toLowerCase()}.`);
  if (structure.sprints) parts.push(below ? `${work.plural} are planned in sprints; their ${below.plural.toLowerCase()} follow them.` : `${work.plural} are planned in sprints.`);
  return parts.join(" ");
}

/**
 * Board settings (research 2026-09-26 §7.1, §9): General, Structure, Display, Columns, Sharing, and
 * Delete in one sheet that replaced the owner icons in the board header. A full-height sheet at
 * 390 px and a right-hand panel on desktop; the board's dialog guard closes it on Back (D69). Only
 * the owner edits; everyone sees the structure and the per-viewer display option.
 */
export function BoardSettingsSheet({ board, owner, showAllLevels, onShowAllLevels, onClose, onRename, onShare, onDelete, onAddColumn, onStructureSaved, notify, sprintsSection, suspended = false }: BoardSettingsSheetProps) {
  const saved = structureOf(board);
  const [draft, setDraft] = useState<BoardStructure>(saved);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  // Take focus on open (QA 0.9.0): the gear kept it and Tab walked the board behind the sheet.
  const panelRef = useRef<HTMLElement>(null);
  useDialogFocus(panelRef);
  const preset = presetOf(draft);
  // Sprint defaults are saved on their own (Sprint defaults below); a structure save leaves them be.
  const dirty = JSON.stringify(levelsOnly(draft)) !== JSON.stringify(levelsOnly(saved));
  const check = validateStructure(draft);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || suspended) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suspended]);

  const update = (next: BoardStructure) => {
    setDraft(next);
    setError(null);
  };
  const choosePreset = (id: StructurePreset | "custom") => {
    if (id === "custom") {
      // Custom is any names you type: start with the first level's name.
      window.document.getElementById(`${titleId}-level-0`)?.focus();
      return;
    }
    update(PRESETS[id].structure);
  };
  const setLevel = (index: number, field: "name" | "plural", value: string) =>
    update({ ...draft, levels: draft.levels.map((level, at) => at === index ? { ...level, [field]: value } : level) });

  async function save() {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    try {
      // Without `sprintDefaults` the server keeps the stored ones.
      const { board: next } = await updateBoardStructure(board.id, levelsOnly(check.structure));
      onStructureSaved(next);
      setDraft(structureOf(next));
      notify(`Structure saved: ${structureLabel(structureOf(next))}`);
    } catch (reason) {
      // LEVEL_IN_USE and SPRINTS_IN_USE explain themselves (T120).
      setError(taskErrorMessage(reason, "Could not save the structure"));
    } finally {
      setBusy(false);
    }
  }

  const workOptions = draft.levels.map((level, index) => ({ value: String(index), label: level.name || `Level ${index + 1}` }));

  return <>
    <button className="panel-scrim" onClick={onClose} aria-label="Close board settings" tabIndex={-1} />
    <aside ref={panelRef} tabIndex={-1} className="side-panel task-settings-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapTabKey}>
      <header>
        <div><span className="eyebrow">{board.name}</span><h2 id={titleId}>Board settings</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close board settings"><X /></button>
      </header>
      <div className="task-settings-body">
        <section className="task-settings-section" aria-labelledby={`${titleId}-general`}>
          <h3 id={`${titleId}-general`}>General</h3>
          <div className="task-settings-row">
            <span><strong title={board.name}>{board.name}</strong><small>{owner ? "You own this board" : `${board.owner_name}’s board`}</small></span>
            {owner && <button className="secondary-button task-small-button" onClick={onRename}><Pencil />Rename</button>}
          </div>
        </section>

        <section className="task-settings-section" aria-labelledby={`${titleId}-structure`}>
          <h3 id={`${titleId}-structure`}><Layers aria-hidden="true" />Structure</h3>
          {!owner && <p className="task-settings-note">{structureLabel(saved)}. {structurePreview(saved)} Only the owner changes the structure.</p>}
          {owner && <>
            <div className="task-preset-grid" role="radiogroup" aria-label="Structure preset">
              {[...STRUCTURE_PRESETS, "custom" as const].map((id) => {
                const checked = preset === id;
                const levels = id === "custom" ? null : PRESETS[id].structure;
                return <button key={id} type="button" role="radio" aria-checked={checked} className={`task-preset${checked ? " active" : ""}`} disabled={busy}
                  onClick={() => choosePreset(id)}>
                  <span className="task-preset-diagram" aria-hidden="true">
                    {(levels ? [...(levels.sprints ? ["Sprint"] : []), ...levels.levels.map((level) => level.name)] : ["…"]).map((name, index) =>
                      <span key={`${name}-${index}`} style={{ marginLeft: `${index * 8}px` }}>{name}</span>)}
                  </span>
                  <span className="task-preset-copy"><strong>{id === "custom" ? "Custom" : PRESETS[id].label}</strong><small>{id === "custom" ? "Your own level names below." : PRESETS[id].description}</small></span>
                  {checked && <Check className="task-preset-check" aria-hidden="true" />}
                </button>;
              })}
            </div>
            <fieldset className="task-level-names" disabled={busy}>
              <legend>Level names</legend>
              {draft.levels.map((level, index) => <div key={index} className="task-level-row">
                <span className="task-level-index" aria-hidden="true">{index + 1}</span>
                <input id={`${titleId}-level-${index}`} value={level.name} maxLength={LEVEL_NAME_MAX} aria-label={`Level ${index + 1} name`} placeholder="Name" onChange={(event) => setLevel(index, "name", event.target.value)} />
                <input value={level.plural} maxLength={LEVEL_NAME_MAX} aria-label={`Level ${index + 1} plural`} placeholder="Plural" onChange={(event) => setLevel(index, "plural", event.target.value)} />
              </div>)}
              <span className="task-level-buttons">
                {draft.levels.length < MAX_LEVELS && <button type="button" className="secondary-button task-small-button"
                  onClick={() => update({ ...draft, levels: [...draft.levels, { name: "Subtask", plural: "Subtasks" }] })}><Plus />Add a level below</button>}
                {draft.levels.length > 1 && <button type="button" className="secondary-button task-small-button"
                  onClick={() => update({ ...draft, levels: draft.levels.slice(0, -1), workLevel: Math.min(draft.workLevel, draft.levels.length - 2) })}><Minus />Remove the last level</button>}
              </span>
            </fieldset>
            {draft.levels.length > 1 && <div className="task-card-field">
              <label id={`${titleId}-work`}>New cards are created as</label>
              <Select labelledBy={`${titleId}-work`} label="New cards are created as" value={String(draft.workLevel)} options={workOptions} disabled={busy}
                onChange={(value) => update({ ...draft, workLevel: Number(value) })} />
            </div>}
            <label className="task-settings-toggle">
              <input type="checkbox" checked={draft.sprints} disabled={busy} onChange={(event) => update({ ...draft, sprints: event.target.checked })} />
              <span>Plan in sprints<small>“Sprint ›” groups the work in time boxes. After saving, set the sprint defaults below; add and start sprints from the header’s sprint switcher.</small></span>
            </label>
            <p className="task-settings-note" aria-live="polite">{check.ok ? structurePreview(check.structure) : check.error}</p>
            {error && <p className="file-dialog-error" role="alert">{error}</p>}
            <span className="task-settings-actions">
              {dirty && <button type="button" className="secondary-button" disabled={busy} onClick={() => update(saved)}>Reset</button>}
              <button type="button" className="primary-button" disabled={busy || !dirty || !check.ok} onClick={() => { void save(); }}>{busy ? "Saving…" : "Save structure"}</button>
            </span>
          </>}
        </section>

        {saved.sprints && sprintsSection}

        {saved.levels.length > 1 && <section className="task-settings-section" aria-labelledby={`${titleId}-display`}>
          <h3 id={`${titleId}-display`}>Display</h3>
          <label className="task-settings-toggle">
            <input type="checkbox" checked={showAllLevels} onChange={(event) => onShowAllLevels(event.target.checked)} />
            <span>Show all levels on the board<small>Only for you, on this device. Off: columns show {saved.levels[saved.workLevel]!.plural.toLowerCase()} only.</small></span>
          </label>
        </section>}

        <section className="task-settings-section" aria-labelledby={`${titleId}-email`}>
          <h3 id={`${titleId}-email`}><Mail aria-hidden="true" />Email</h3>
          <MuteEmailsToggle type="board" id={board.id} name={board.name} />
        </section>

        {owner && <section className="task-settings-section" aria-labelledby={`${titleId}-columns`}>
          <h3 id={`${titleId}-columns`}><Columns3 aria-hidden="true" />Columns</h3>
          <p className="task-settings-note">Each column’s ⋯ menu renames it, sets its state (To do, In progress, or Done), moves it, or sets a WIP limit.</p>
          <button className="secondary-button task-small-button" onClick={onAddColumn}><Plus />Add column</button>
        </section>}

        {owner && <section className="task-settings-section" aria-labelledby={`${titleId}-sharing`}>
          <h3 id={`${titleId}-sharing`}><Share2 aria-hidden="true" />Sharing</h3>
          <button className="secondary-button task-small-button" onClick={onShare}><Share2 />Share board…</button>
        </section>}

        {owner && <section className="task-settings-section" aria-labelledby={`${titleId}-delete`}>
          <h3 id={`${titleId}-delete`}>Delete</h3>
          <button className="secondary-button task-small-button danger" onClick={onDelete}><Trash2 />Move board to the Bin</button>
        </section>}
      </div>
    </aside>
  </>;
}
