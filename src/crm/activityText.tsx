import type { ReactNode } from "react";
import type { ItemActivityEntry } from "../../shared/itemActivity";
import { interactionLogged } from "../../shared/crm";
import { linkedItemNoun } from "../../shared/workRefs";

/** How Contacts' activity reads after the actor's name (ItemTimeline and the record timeline). */
const value = (entry: ItemActivityEntry, key: "from" | "to") => entry.payload[key]?.label ?? "—";

export const CRM_ACTIVITY_RENDERERS: Readonly<Record<string, (entry: ItemActivityEntry) => ReactNode>> = {
  created: (entry) => <>created this{entry.payload.to?.label ? <> as <strong>{entry.payload.to.label}</strong></> : null}</>,
  crm_updated: (entry) => <>changed {String(entry.payload.extra?.fields ?? "details").toLowerCase()}</>,
  crm_stage: (entry) => <>moved it from <strong>{value(entry, "from")}</strong> to <strong>{value(entry, "to")}</strong></>,
  crm_merged: (entry) => <>merged <strong>{String(entry.payload.extra?.merged_from ?? "a duplicate")}</strong> into this</>,
  crm_interaction: (entry) => <>{interactionLogged(entry.payload.extra?.kind)}</>,
  crm_followup: () => <>set a follow-up</>,
  crm_imported: () => <>imported this from a CSV</>,
  contact_created: (entry) => <>added this contact{entry.payload.extra?.source ? ` (from ${String(entry.payload.extra.source)})` : ""}</>,
  contact_filled: (entry) => <>filled in {String(entry.payload.extra?.fields ?? "details")}{entry.payload.extra?.source ? ` from a ${String(entry.payload.extra.source)}` : ""}</>,
  company_created: () => <>added this company</>,
  binned: () => <>moved it to the Bin</>,
  restored: () => <>restored it</>
};

/** A linked item: "the goal Q3 plan" when the reader can open it (D1390), else "a goal". */
const linkedPlain = (entry: ItemActivityEntry) => {
  const item = entry.payload.item;
  const noun = linkedItemNoun(item);
  return noun ? `${noun}${item!.label}` : `a ${item?.label?.toLowerCase() ?? "item"}`;
};

/** Plain text of an entry (record timeline rows). */
export function activityPlain(entry: ItemActivityEntry): string {
  switch (entry.kind) {
    case "crm_stage": return `moved it from ${value(entry, "from")} to ${value(entry, "to")}`;
    case "crm_updated": return `changed ${String(entry.payload.extra?.fields ?? "details").toLowerCase()}`;
    case "crm_merged": return `merged ${String(entry.payload.extra?.merged_from ?? "a duplicate")} into this`;
    case "crm_interaction": return interactionLogged(entry.payload.extra?.kind);
    case "crm_followup": return "set a follow-up";
    case "created": return "created this";
    case "contact_created": return "added this contact";
    case "contact_filled": return `filled in ${String(entry.payload.extra?.fields ?? "details")}`;
    case "company_created": return "added this company";
    case "linked": return `linked ${linkedPlain(entry)}`;
    case "unlinked": return `unlinked ${linkedPlain(entry)}`;
    case "commented": return "commented";
    case "binned": return "moved it to the Bin";
    case "restored": return "restored it";
    default: return entry.kind.replace(/_/g, " ");
  }
}
