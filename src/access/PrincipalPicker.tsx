import { Combobox } from "../ui/Combobox";
import type { Option } from "../ui/Select";

/**
 * "Add people or groups…" (Wave 32, §E): the shared type-to-search Combobox (D91). Groups come first
 * with their size and guest count, then people with their Team role. Picking one adds it to the
 * sheet's list at the default level; the field then clears for the next one. On phones the list is
 * a bottom sheet with a sticky search box that Back closes before the Access sheet (D69).
 */
export function PrincipalPicker({ options, onPick, disabled = false, emptyText, onOpening }: {
  options: Option[];
  onPick: (value: string) => void;
  disabled?: boolean;
  emptyText?: string;
  /** F7: called as the picker is about to open (a press or focus on it), to refresh what it offers. */
  onOpening?: () => void;
}) {
  return <div className="access-picker" onPointerDownCapture={onOpening} onFocusCapture={onOpening}>
    <Combobox value={[]} onChange={(picked) => { if (picked[0]) onPick(picked[0]); }} options={options}
      label="Add people or groups" placeholder="Add people or groups…" emptyText={emptyText ?? "Nobody else to add"} disabled={disabled} />
  </div>;
}
