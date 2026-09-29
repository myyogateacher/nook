import { Select } from "../ui/Select";
import { levelOptions } from "./accessModel";
import { LEVEL_LABELS, levelDescription, type AccessKind, type Level } from "./accessLevels";

/**
 * The level picker of one Access sheet row (Wave 32, §E): the shared custom Select (D91, never a
 * native select), a popup on desktop and a bottom sheet with 44 px rows on phones that Back closes.
 * Each option carries one line on what it allows. A row the caller may not change shows its level
 * as text with the reason instead (a Team role cap, or another manager, D273), and so does a row
 * with one level to choose from (files and task views are view-only, D275): its line says what it allows.
 */
export function LevelSelect({ kind, levels, value, onChange, label, lockedReason }: {
  kind: AccessKind;
  levels: readonly Level[];
  value: Level;
  onChange: (level: Level) => void;
  /** "Level for Ops": the accessible name and the phone sheet's heading. */
  label: string;
  /** Shown instead of the picker when set. */
  lockedReason?: string | null;
}) {
  // A stored level the caller may not give (a manager seeing Manager) stays visible as the current choice.
  const shown = levels.includes(value) ? levels : [...levels, value];
  if (lockedReason || shown.length === 1) {
    const reason = lockedReason ?? levelDescription(kind, value);
    return <span className="access-level-locked" title={reason}><span>{LEVEL_LABELS[value]}</span><small>{reason}</small></span>;
  }
  return <Select<Level> className="access-level-select" value={value} onChange={onChange} options={levelOptions(kind, shown)} label={label} searchable={false} />;
}
