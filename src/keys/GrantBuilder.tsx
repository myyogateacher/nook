import { useEffect, useId, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import { Select, type Option } from "../ui/Select";
import {
  CREATE_ONLY, MODULE_LABELS, permissionHelp, permissionLabel, rowModuleChoices, rowPermissionChoices, selectorFor, SELECTOR_KINDS, grantSummary,
  type GrantModule, type GrantRow, type KeyPermission, type PolicySummary
} from "./keyGrants";
import { useKeysApi, type ResourceOption } from "./keysApi";

/**
 * The grant builder (access plan §E "New key", step 3): one row per permission. Module → permission
 * → "all" or chosen items. Custom Select and Combobox only (D91); every control is 44 px at 390 px.
 *
 * `ceiling` switches it to narrowing (D278): rows can only lower a permission to read, narrow
 * "all" to chosen items, drop items, or be removed; nothing can be added.
 */

let rowCounter = 0;
export const newRowKey = () => `row-${++rowCounter}`;

export function GrantBuilder({ rows, onChange, role, policy, disabled = false, ceiling }: {
  rows: GrantRow[];
  onChange: (rows: GrantRow[]) => void;
  role: string | undefined;
  policy: PolicySummary | null;
  disabled?: boolean;
  ceiling?: readonly GrantRow[];
}) {
  const [resources, setResources] = useState<Partial<Record<GrantModule, ResourceOption[] | "error">>>({});
  const narrowing = ceiling !== undefined;
  // Settings: your own items; Team → Integrations: only what is shared with the integration.
  const { loadResources } = useKeysApi();
  const needed = [...new Set(rows.filter((row) => row.applies === "chosen" || narrowing).filter((row) => selectorFor(row.module, row.permission)).map((row) => row.module))];

  useEffect(() => {
    for (const module of needed) {
      if (resources[module] !== undefined) continue;
      setResources((current) => ({ ...current, [module]: [] }));
      loadResources(module).then((options) => setResources((current) => ({ ...current, [module]: options })), () => setResources((current) => ({ ...current, [module]: "error" })));
    }
    // needed is derived from rows; resources is read only to skip modules already loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed.join(",")]);

  const update = (key: string, patch: Partial<GrantRow>) => onChange(rows.map((row) => row.key === key ? { ...row, ...patch } : row));
  const remove = (key: string) => onChange(rows.filter((row) => row.key !== key));
  const add = () => {
    const choice = rowModuleChoices(role, policy, rows, null).find((module) => !module.disabled && module.firstPermission);
    if (!choice) return;
    onChange([...rows, { key: newRowKey(), module: choice.value, permission: choice.firstPermission!, applies: "all", resourceIds: [] }]);
  };

  return <div className="grant-builder">
    <ul className="grant-rows" aria-label="Permissions">
      {rows.map((row, index) => <GrantRowEditor key={row.key} row={row} index={index} role={role} policy={policy} disabled={disabled} rows={rows}
        ceiling={ceiling?.find((item) => item.key === row.key)} narrowing={narrowing} resources={resources[row.module]}
        moduleOptions={rowModuleChoices(role, policy, rows, row.key).map((module) => ({ value: module.value, label: module.label, disabled: module.disabled && module.value !== row.module, description: module.description }))}
        onChange={(patch) => update(row.key, patch)} onRemove={() => remove(row.key)} canRemove={rows.length > 1 || !narrowing} />)}
    </ul>
    {!rows.length && <p className="grant-empty">No permissions yet.</p>}
    {!narrowing && <button type="button" className="secondary-button grant-add" onClick={add} disabled={disabled || !rowModuleChoices(role, policy, rows, null).some((module) => !module.disabled)}><Plus aria-hidden="true" />Add permission</button>}
    <p className="grant-summary" aria-live="polite">{grantSummary(rows)}</p>
  </div>;
}

function GrantRowEditor({ row, index, role, policy, disabled, rows, ceiling, narrowing, resources, moduleOptions, onChange, onRemove, canRemove }: {
  row: GrantRow;
  rows: readonly GrantRow[];
  index: number;
  role: string | undefined;
  policy: PolicySummary | null;
  disabled: boolean;
  ceiling: GrantRow | undefined;
  narrowing: boolean;
  resources: ResourceOption[] | "error" | undefined;
  moduleOptions: Option<GrantModule>[];
  onChange: (patch: Partial<GrantRow>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const id = useId();
  const selector = selectorFor(row.module, row.permission);
  let permissions: Option<KeyPermission>[] = rowPermissionChoices(row.module, role, policy, rows, row.key).map((choice) => ({ value: choice.value, label: choice.label, description: choice.description, disabled: choice.disabled && choice.value !== row.permission }));
  if (narrowing && ceiling) {
    // Narrowing keeps the permission or lowers it to read (D278).
    permissions = permissions.filter((option) => option.value === ceiling.permission || option.value === "read").map((option) => ({ ...option, disabled: false }));
  }
  const appliesOptions: Option<"all" | "chosen">[] = selector ? [
    { value: "all", label: `All ${selector.many}`, description: `Every ${selector.one} you can open, now and later`, disabled: narrowing && ceiling?.applies === "chosen" },
    { value: "chosen", label: `Chosen ${selector.many}`, description: `Only the ${selector.many} you pick` }
  ] : [];
  const writable = row.permission !== "read";
  let resourceOptions: Option[] = resources === "error" || !resources ? [] : resources.map((option) => ({
    value: option.value, label: option.label,
    description: writable && option.readOnly ? "Views can only be read through a key" : writable && !option.writable ? "You can only view this one" : option.description,
    disabled: writable && !option.writable
  }));
  // N1: in Edit, a grant already on chosen items can only lose items (chips with ×: adding would
  // widen it); a grant on "all" may be narrowed to any chosen items with the full picker (D278).
  const removeOnly = narrowing && ceiling?.applies === "chosen";
  if (removeOnly) resourceOptions = resourceOptions.filter((option) => ceiling!.resourceIds.includes(option.value));
  // Chosen items leave the list (their chips hold them, with ×), so a pick never reads as a no-op (Friction 3).
  const unchosen = resourceOptions.filter((option) => !row.resourceIds.includes(option.value));
  const labels = { module: `${id}-module`, permission: `${id}-permission`, applies: `${id}-applies` };

  return <li className="grant-row">
    <div className="grant-row-head">
      <span className="grant-row-number">Permission {index + 1}</span>
      {canRemove && <button type="button" className="icon-button grant-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove ${MODULE_LABELS[row.module]}: ${permissionLabel(row.module, row.permission)}`}><Trash2 /></button>}
    </div>
    <div className="grant-row-fields">
      <div className="grant-field"><span id={labels.module}>Module</span>
        <Select<GrantModule> labelledBy={labels.module} label="Module" value={row.module} options={moduleOptions} disabled={disabled || narrowing}
          onChange={(module) => {
            const first = rowPermissionChoices(module, role, policy, rows, row.key).find((choice) => !choice.disabled)?.value ?? "read";
            onChange({ module, permission: first, applies: "all", resourceIds: [] });
          }} />
      </div>
      <div className="grant-field"><span id={labels.permission}>Permission</span>
        <Select<KeyPermission> labelledBy={labels.permission} label="Permission" value={row.permission} options={permissions} disabled={disabled || (narrowing && permissions.length < 2)}
          onChange={(permission) => onChange(CREATE_ONLY.has(`${row.module}:${permission}`) ? { permission, applies: "all", resourceIds: [] } : { permission })} />
      </div>
      {selector && <div className="grant-field"><span id={labels.applies}>Applies to</span>
        <Select<"all" | "chosen"> labelledBy={labels.applies} label="Applies to" value={row.applies} options={appliesOptions} disabled={disabled}
          onChange={(applies) => onChange({ applies, resourceIds: applies === "all" ? [] : narrowing && ceiling?.applies === "chosen" ? ceiling.resourceIds : row.resourceIds })} />
      </div>}
    </div>
    {selector && row.applies === "chosen" && removeOnly && <div className="grant-resources">
      {/* Review Q9: editing only removes items; adding needs a rotation (re-authenticated). */}
      <ul className="grant-chosen" aria-label={`Chosen ${selector.many}`}>
        {row.resourceIds.map((value) => {
          const label = resourceOptions.find((option) => option.value === value)?.label ?? "An item you cannot open now";
          return <li key={value} className="ui-chip"><span className="ui-chip-label">{label}</span>
            <button type="button" className="ui-chip-remove" aria-label={`Remove ${label}`} disabled={disabled || row.resourceIds.length < 2} onClick={() => onChange({ resourceIds: row.resourceIds.filter((item) => item !== value) })}><X /></button></li>;
        })}
      </ul>
      <small className="grant-note">Items can only be removed here; rotate the key to add.</small>
    </div>}
    {selector && row.applies === "chosen" && !removeOnly && <div className="grant-resources">
      {resources === "error" ? <p className="form-error" role="alert">Could not load your {selector.many}.</p>
        : <Combobox multiple backspaceRemoves={false} label={`Chosen ${selector.many}`} placeholder={`Choose ${selector.many}…`} placeholderWithValues={`Add another ${selector.one}…`} value={row.resourceIds} options={unchosen}
          selectedOptions={row.resourceIds.map((value) => resourceOptions.find((option) => option.value === value) ?? { value, label: "An item you cannot open now" })}
          emptyText={resources && resources.length === 0 ? `You have no ${selector.many} to choose` : resourceOptions.length && !unchosen.length ? `Every ${selector.one} is chosen` : "No matches"} disabled={disabled}
          onChange={(resourceIds) => onChange({ resourceIds })} maxSelected={100} />}
    </div>}
    <p className="grant-help">{permissionHelp(row.module, row.permission)}</p>
  </li>;
}
