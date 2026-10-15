import { useState } from "react";
import { ListFilter, X } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { REPORTS_FILTER_STATUSES, type ReportsFilter } from "../router";
import { Select } from "../ui/Select";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import type { DatasourceChoice, ReportOwnerFacet, ReportStatus } from "../../shared/reports";

/**
 * Report organization phase 1: the Reports list's filters (owner, status, data source, schedule). They
 * live in the URL (ReportsFilter), so Back and Forward restore them. From 761 px they are a chip bar of
 * pills (custom Selects, D91) with Clear filters; on a phone one Filters button opens them in a bottom
 * sheet (a history layer with its key, so Forward after Back reopens it), applied with Show reports.
 */

const STATUS_NAMES: Record<ReportStatus, string> = { draft: "Draft", ready: "Ready", stale: "Stale", error: "Error" };
const ANY = "any";

export type FilterChoices = { owners: readonly ReportOwnerFacet[]; sources: readonly DatasourceChoice[] };

/** How many of the four filters are set. */
export const activeFilterCount = (filter: ReportsFilter | undefined) =>
  filter ? [filter.owner, filter.status?.length ? filter.status : undefined, filter.datasource, filter.schedule].filter(Boolean).length : 0;

/** The filter with one part changed (`undefined` clears it); empty parts are dropped. */
export function withFilter(filter: ReportsFilter | undefined, part: Partial<ReportsFilter>): ReportsFilter | undefined {
  const next: ReportsFilter = { ...(filter ?? {}), ...part };
  for (const key of Object.keys(next) as Array<keyof ReportsFilter>) {
    const value = next[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
  }
  return Object.keys(next).length ? next : undefined;
}

function ownerOptions(choices: FilterChoices) {
  const others = choices.owners.filter((owner) => !owner.isMe);
  return [{ value: ANY, label: "Any owner" }, { value: "me", label: "Mine" }, ...others.map((owner) => ({ value: owner.id, label: `By ${owner.name}` }))];
}
const statusOptions = () => [{ value: ANY, label: "Any status" }, ...REPORTS_FILTER_STATUSES.map((status) => ({ value: status, label: STATUS_NAMES[status] }))];
const sourceOptions = (choices: FilterChoices) => [{ value: ANY, label: "Any data source" }, ...choices.sources.map((source) => ({ value: source.id, label: source.name }))];
const scheduleOptions = () => [{ value: ANY, label: "Any schedule" }, { value: "on", label: "Scheduled" }, { value: "off", label: "Not scheduled" }];

/** The four pills' values (`any` when unset); a URL with several statuses shows them in the pill's placeholder. */
function pillValues(filter: ReportsFilter | undefined, choices: FilterChoices) {
  const owner = filter?.owner === "me" || (filter?.owner && choices.owners.some((item) => item.isMe && item.id === filter.owner)) ? "me" : filter?.owner ?? ANY;
  const statuses = filter?.status ?? [];
  return {
    owner,
    // A person who is not among the owners any more (no report of theirs is readable): the pill says so.
    ownerMissing: owner !== ANY && owner !== "me" && !choices.owners.some((item) => item.id === owner),
    status: statuses.length === 1 ? statuses[0]! : statuses.length ? null : ANY,
    statusText: statuses.map((status) => STATUS_NAMES[status as ReportStatus] ?? status).join(", "),
    source: filter?.datasource ?? ANY,
    schedule: filter?.schedule ?? ANY
  };
}

type FieldsProps = { filter: ReportsFilter | undefined; choices: FilterChoices; onChange: (filter: ReportsFilter | undefined) => void; variant: "chip" | "field" };

/** The four filters as Selects: pills in the bar, labelled fields in the sheet. */
function FilterFields({ filter, choices, onChange, variant }: FieldsProps) {
  const values = pillValues(filter, choices);
  const set = (part: Partial<ReportsFilter>) => onChange(withFilter(filter, part));
  const field = (label: string, active: boolean, select: React.ReactNode) => variant === "chip"
    ? <span className={`reports-filter${active ? " active" : ""}`}>{select}</span>
    : <div className="reports-filter-field"><span className="reports-filter-label">{label}</span>{select}</div>;
  return <>
    {field("Owner", values.owner !== ANY, <Select<string> variant={variant} label="Owner" value={values.ownerMissing ? null : values.owner} placeholder="Another owner" searchable="auto"
      options={ownerOptions(choices)} onChange={(value) => set({ owner: value === ANY ? undefined : value })} />)}
    {field("Status", values.status !== ANY, <Select<string> variant={variant} label="Status" value={values.status} placeholder={values.statusText || "Any status"} searchable={false}
      options={statusOptions()} onChange={(value) => set({ status: value === ANY ? undefined : [value] })} />)}
    {field("Data source", values.source !== ANY, <Select<string> variant={variant} label="Data source" value={choices.sources.some((source) => source.id === values.source) || values.source === ANY ? values.source : null}
      placeholder="Another data source" searchable="auto" options={sourceOptions(choices)} onChange={(value) => set({ datasource: value === ANY ? undefined : value })} />)}
    {field("Schedule", values.schedule !== ANY, <Select<string> variant={variant} label="Schedule" value={values.schedule} searchable={false}
      options={scheduleOptions()} onChange={(value) => set({ schedule: value === ANY ? undefined : value as "on" | "off" })} />)}
  </>;
}

type BarProps = { filter: ReportsFilter | undefined; choices: FilterChoices; onChange: (filter: ReportsFilter | undefined) => void; onOpenSheet: () => void };

/** The chip bar (761 px and up) and the phone's Filters button; both always rendered, CSS shows one. */
export function ReportFilterBar({ filter, choices, onChange, onOpenSheet }: BarProps) {
  const count = activeFilterCount(filter);
  return <div className="reports-filters" role="group" aria-label="Filters">
    <div className="reports-filter-chips">
      <FilterFields filter={filter} choices={choices} onChange={onChange} variant="chip" />
      {count > 0 && <button type="button" className="reports-filter-clear" onClick={() => onChange(undefined)}><X aria-hidden="true" />Clear filters</button>}
    </div>
    <button type="button" className={`reports-filter-open${count ? " active" : ""}`} onClick={onOpenSheet} aria-haspopup="dialog">
      <ListFilter aria-hidden="true" />Filters{count > 0 && <b aria-label={`${count} on`}>{count}</b>}
    </button>
    {count > 0 && <button type="button" className="reports-filter-clear reports-filter-clear-narrow" onClick={() => onChange(undefined)}><X aria-hidden="true" />Clear filters</button>}
  </div>;
}

type SheetProps = { filter: ReportsFilter | undefined; choices: FilterChoices; onApply: (filter: ReportsFilter | undefined) => void; onClose: () => void; reopen: () => void };

/** The phone's bottom sheet: the four filters as fields over a draft; Show reports applies it, Back or × leaves the list as it was. */
export function ReportFilterSheet({ filter, choices, onApply, onClose, reopen }: SheetProps) {
  const [draft, setDraft] = useState<ReportsFilter | undefined>(filter);
  useHistoryDialogGuard(true, onClose, { reopen, layerKey: "reports.filters" });
  return <ModalDialog title="Filters" eyebrow="Reports" onClose={onClose} variant="sheet" className="reports-dialog reports-filter-sheet">
    <div className="reports-filter-fields">
      <FilterFields filter={draft} choices={choices} onChange={setDraft} variant="field" />
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={() => setDraft(undefined)} disabled={!activeFilterCount(draft)}>Clear filters</button>
      <button type="button" className="primary-button" onClick={() => onApply(draft)}>Show reports</button>
    </footer>
  </ModalDialog>;
}
