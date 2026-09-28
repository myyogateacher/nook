import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Combobox } from "../ui/Combobox";
import { Select, type Option } from "../ui/Select";
import {
  moduleChoices, MODULE_LABELS, permissionChoices, permissionHelp, permissionLabel, SELECTOR_KINDS, grantSummary,
  type GrantModule, type GrantRow, type KeyPermission, type PolicySummary
} from "./keyGrants";
import { loadResources, type ResourceOption } from "./keysApi";

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
  const modules = moduleChoices(role, policy);
  const needed = [...new Set(rows.filter((row) => row.applies === "chosen" || narrowing).map((row) => row.module).filter((module) => SELECTOR_KINDS[module]))];

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
    const used = new Set(rows.map((row) => `${row.module}:${row.permission}`));
    const choice = modules.find((module) => !module.disabled && module.firstPermission && !used.has(`${module.value}:${module.firstPermission}`));
    if (!choice) return;
    onChange([...rows, { key: newRowKey(), module: choice.value, permission: choice.firstPermission!, applies: "all", resourceIds: [] }]);
  };

  return <div className="grant-builder">
    <ul className="grant-rows" aria-label="Permissions">
      {rows.map((row, index) => <GrantRowEditor key={row.key} row={row} index={index} role={role} policy={policy} disabled={disabled}
        ceiling={ceiling?.find((item) => item.key === row.key)} narrowing={narrowing} resources={resources[row.module]}
        moduleOptions={modules.map((module) => ({ value: module.value, label: module.label, disabled: module.disabled, description: module.description }))}
        onChange={(patch) => update(row.key, patch)} onRemove={() => remove(row.key)} canRemove={rows.length > 1 || !narrowing} />)}
    </ul>
    {!rows.length && <p className="grant-empty">No permissions yet.</p>}
    {!narrowing && <button type="button" className="secondary-button grant-add" onClick={add} disabled={disabled || !modules.some((module) => !module.disabled)}><Plus aria-hidden="true" />Add permission</button>}
    <p className="grant-summary" aria-live="polite">{grantSummary(rows)}</p>
  </div>;
}

function GrantRowEditor({ row, index, role, policy, disabled, ceiling, narrowing, resources, moduleOptions, onChange, onRemove, canRemove }: {
  row: GrantRow;
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
  const selector = SELECTOR_KINDS[row.module];
  let permissions: Option<KeyPermission>[] = permissionChoices(row.module, role, policy).map((choice) => ({ value: choice.value, label: choice.label, description: choice.description, disabled: choice.disabled }));
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
    value: option.value, label: option.label, description: option.description ?? (writable && !option.writable ? "You can only view this one" : undefined), disabled: writable && !option.writable
  }));
  if (narrowing && ceiling?.applies === "chosen") resourceOptions = resourceOptions.filter((option) => ceiling.resourceIds.includes(option.value));
  const labels = { module: `${id}-module`, permission: `${id}-permission`, applies: `${id}-applies` };

  return <li className="grant-row">
    <div className="grant-row-head">
      <span className="grant-row-number">Permission {index + 1}</span>
      {canRemove && <button type="button" className="icon-button grant-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove ${MODULE_LABELS[row.module]}: ${permissionLabel(row.module, row.permission)}`}><Trash2 /></button>}
    </div>
    <div className="grant-row-fields">
      <div className="grant-field"><span id={labels.module}>Module</span>
        <Select<GrantModule> labelledBy={labels.module} value={row.module} options={moduleOptions} disabled={disabled || narrowing}
          onChange={(module) => {
            const first = permissionChoices(module, role, policy).find((choice) => !choice.disabled)?.value ?? "read";
            onChange({ module, permission: first, applies: "all", resourceIds: [] });
          }} />
      </div>
      <div className="grant-field"><span id={labels.permission}>Permission</span>
        <Select<KeyPermission> labelledBy={labels.permission} value={row.permission} options={permissions} disabled={disabled || (narrowing && permissions.length < 2)}
          onChange={(permission) => onChange({ permission })} />
      </div>
      {selector && <div className="grant-field"><span id={labels.applies}>Applies to</span>
        <Select<"all" | "chosen"> labelledBy={labels.applies} value={row.applies} options={appliesOptions} disabled={disabled}
          onChange={(applies) => onChange({ applies, resourceIds: applies === "all" ? [] : narrowing && ceiling?.applies === "chosen" ? ceiling.resourceIds : row.resourceIds })} />
      </div>}
    </div>
    {selector && row.applies === "chosen" && <div className="grant-resources">
      {resources === "error" ? <p className="form-error" role="alert">Could not load your {selector.many}.</p>
        : <Combobox multiple label={`Chosen ${selector.many}`} placeholder={`Find ${selector.many}…`} value={row.resourceIds} options={resourceOptions}
          selectedOptions={row.resourceIds.map((value) => resourceOptions.find((option) => option.value === value) ?? { value, label: "An item you cannot open now" })}
          emptyText={resources && resources.length === 0 ? `You have no ${selector.many} to choose` : "No matches"} disabled={disabled}
          onChange={(resourceIds) => onChange({ resourceIds })} maxSelected={100} />}
    </div>}
    <p className="grant-help">{permissionHelp(row.module, row.permission)}</p>
  </li>;
}
