// Pure display and input helpers for collection values. No DOM or network access, so they are
// unit tested directly. The server remains the authority: these only mirror its rules for early
// feedback.
import type { ItemLevel } from "../access/accessLevels";
import type { CollectionRow, FieldDefinition, FieldType, FieldValue, OptionColor } from "./collectionsApi";

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Checkbox",
  select: "Select",
  multi_select: "Multi-select",
  url: "Link",
  note: "Note",
  file: "Files"
};

export const OPTION_COLORS: OptionColor[] = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

/** Type changes the server accepts for an existing field (text ↔ url, select → multi_select). */
export function allowedTypeChanges(type: FieldType): FieldType[] {
  if (type === "text") return ["text", "url"];
  if (type === "url") return ["url", "text"];
  if (type === "select") return ["select", "multi_select"];
  return [type];
}

const controlCharacters = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
type NameCheck = { ok: true; name: string; changed: boolean } | { ok: false; error: string };

export function validateName(value: string, max: number, current?: string): NameCheck {
  const name = value.normalize("NFC").trim();
  if (!name) return { ok: false, error: "Enter a name" };
  if (name.length > max) return { ok: false, error: `Use at most ${max} characters` };
  if (controlCharacters.test(name)) return { ok: false, error: "Names cannot contain control characters" };
  return { ok: true, name, changed: name !== current };
}

export const validateCollectionName = (value: string, current?: string) => validateName(value, 120, current);

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isRealDate(value: string) {
  const match = isoDate.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isHttpUrl(value: string) {
  if (value.length > 2048 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

export type Parsed = { ok: true; value: FieldValue | null } | { ok: false; error: string };

/** Parses what a text-like input holds (text, number, date, url) into a value; "" clears. */
export function parseInput(field: FieldDefinition, raw: string): Parsed {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  switch (field.type) {
    case "text":
      return raw.length > 4000 ? { ok: false, error: "Use at most 4000 characters" } : { ok: true, value: raw.trim() };
    case "number": {
      const value = Number(text.replace(/,/g, ""));
      return /^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text) && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: "Enter a number" };
    }
    case "date":
      return isRealDate(text) ? { ok: true, value: text } : { ok: false, error: "Enter a date as YYYY-MM-DD" };
    case "url":
      return isHttpUrl(text) ? { ok: true, value: text } : { ok: false, error: "Enter an http or https link" };
    default:
      return { ok: false, error: "Not editable here" };
  }
}

/** The text an input shows for a value (the inverse of parseInput). */
export function inputText(field: FieldDefinition, value: FieldValue | undefined) {
  if (value === undefined) return "";
  if (field.type === "number" && typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

export function formatNumber(field: FieldDefinition, value: number, locale?: string) {
  const decimals = field.number?.decimals ?? 0;
  const text = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 6) }).format(value);
  const unit = field.number?.unit;
  return unit ? `${text} ${unit}` : text;
}

export function formatDate(value: string, locale?: string) {
  if (!isRealDate(value)) return value;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
}

export const optionById = (field: FieldDefinition, id: string) => field.options?.find((option) => option.id === id) ?? null;

/** One line of display text for a cell or card (the table and the mobile card list). */
export function displayValue(field: FieldDefinition, row: Pick<CollectionRow, "values" | "links" | "files">, locale?: string): string {
  if (field.type === "file") {
    const count = row.files?.[field.id]?.length ?? 0;
    return count === 0 ? "" : count === 1 ? row.files![field.id]![0]!.name : `${count} files`;
  }
  if (field.type === "note") {
    const link = row.links[field.id];
    if (!link) return "";
    return "restricted" in link ? "Restricted note" : link.title || "Untitled note";
  }
  const value = row.values[field.id];
  if (value === undefined) return "";
  switch (field.type) {
    case "number":
      return typeof value === "number" ? formatNumber(field, value, locale) : "";
    case "date":
      return typeof value === "string" ? formatDate(value, locale) : "";
    case "checkbox":
      return value === true ? "Yes" : "";
    case "select":
      return typeof value === "string" ? optionById(field, value)?.label ?? "" : "";
    case "multi_select":
      return Array.isArray(value) ? value.map((id) => optionById(field, id)?.label).filter(Boolean).join(", ") : "";
    case "url":
      if (typeof value !== "string") return "";
      try {
        const url = new URL(value);
        return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
      } catch {
        return value;
      }
    default:
      return typeof value === "string" ? value : "";
  }
}

/** Mobile card list: the primary field plus up to three more fields that have something to show. */
export function cardFields(fields: FieldDefinition[], row: Pick<CollectionRow, "values" | "links" | "files">, count = 3) {
  return fields.slice(1).filter((field) => displayValue(field, row) !== "").slice(0, count);
}

export const rowTitle = (row: Pick<CollectionRow, "title">) => row.title.trim() || "Untitled";

export const rowCountLabel = (count: number) => count === 1 ? "1 row" : `${count.toLocaleString()} rows`;

/** The Move to Bin confirmation for a collection, from the list and from the collection view. */
export const collectionBinMessage = (collection: { name: string; row_count: number }) =>
  `Move “${collection.name}” and its ${rowCountLabel(collection.row_count)} to the Bin? Everyone it is shared with loses access. You can restore it for 30 days.`;

/** The caller's access as a badge: a manager (Wave 32, D273) is "Manager", not "Can edit" (QA v0.13.0 B6). */
export function roleLabel(role: "owner" | "editor" | "viewer", level?: ItemLevel) {
  return role === "owner" ? "Owner" : level === "manage" ? "Manager" : role === "editor" ? "Can edit" : "View only";
}

/**
 * What the owner's list says about sharing (QA v0.13.0 B6). `share_role` is the level of everyone
 * signed in only; people and groups each have their own level (a manager, an editor), so a chosen
 * audience does not claim one level for all of them.
 */
export function ownerSharingLabel(visibility: "private" | "selected" | "all_users", shareRole: "viewer" | "editor") {
  if (visibility === "private") return "Private";
  if (visibility === "all_users") return `Shared with everyone · ${shareRole === "editor" ? "can edit" : "view only"}`;
  return "Shared with people you chose";
}

/** Filter operators per field type (mirrors server/collections/query.ts OPERATORS). */
export const OPERATORS: Record<FieldType, string[]> = {
  text: ["contains", "equals", "empty", "not_empty"],
  url: ["contains", "equals", "empty", "not_empty"],
  number: ["eq", "lt", "lte", "gt", "gte", "empty"],
  date: ["eq", "lt", "lte", "gt", "gte", "empty"],
  checkbox: ["is"],
  select: ["is", "is_not", "in"],
  multi_select: ["has_any", "has_all"],
  note: ["empty", "not_empty"],
  file: ["empty", "not_empty"]
};

export const OPERATOR_LABELS: Record<string, string> = {
  contains: "contains", equals: "is", empty: "is empty", not_empty: "is not empty",
  eq: "=", lt: "<", lte: "≤", gt: ">", gte: "≥",
  is: "is", is_not: "is not", in: "is any of", has_any: "has any of", has_all: "has all of"
};

export const SORTABLE_TYPES: FieldType[] = ["text", "url", "number", "date", "checkbox", "select"];

/** Operators that take no value. */
export const valuelessOperator = (op: string) => op === "empty" || op === "not_empty";

/** Whether a filter is complete enough to send (the server rejects incomplete ones with 400). */
export function filterReady(field: FieldDefinition | undefined, filter: { op: string; value?: unknown }) {
  if (!field || !OPERATORS[field.type].includes(filter.op)) return false;
  if (valuelessOperator(filter.op)) return true;
  const value = filter.value;
  switch (field.type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "date": return typeof value === "string" && isRealDate(value);
    case "checkbox": return typeof value === "boolean";
    case "select": return filter.op === "in" ? Array.isArray(value) && value.length > 0 : typeof value === "string" && value !== "";
    case "multi_select": return Array.isArray(value) && value.length > 0;
    default: return typeof value === "string" && value.trim() !== "";
  }
}

/** The default value when a filter's operator or field changes. */
export function defaultFilterValue(field: FieldDefinition, op: string): string | number | boolean | string[] | undefined {
  if (valuelessOperator(op)) return undefined;
  if (field.type === "checkbox") return true;
  if (field.type === "multi_select" || (field.type === "select" && op === "in")) return [];
  return field.type === "number" ? undefined : "";
}

/**
 * Enter in a quick-add input submits its form explicitly (as the Tasks quick-add does), so it works
 * with every input method and keyboard handler around the view.
 */
export function submitOnEnter(event: { key: string; nativeEvent: { isComposing?: boolean }; preventDefault: () => void; currentTarget: { form: HTMLFormElement | null } }) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
