import type { Option } from "../ui/Select";
import { ROLE_LABELS, type Role } from "../team/teamRoles";
import { LEVEL_LABELS, levelDescription, type AccessKind, type Level } from "./accessLevels";
import type { AccessGroup, AccessPerson, AccessPutBody, Audience, ItemAccess, PickerGroup, PickerPerson } from "./accessApi";

/**
 * The Access sheet's pure model (Wave 32, access plan §C.5, §E): what the sheet shows and what it
 * saves. Kept apart from the component so tests/accessSheet.test.tsx can check it without a DOM.
 */

export type DraftPerson = Pick<AccessPerson, "id" | "displayName" | "teamRole" | "level"> & { blocked?: boolean; avatarUrl?: string | null };
export type DraftGroup = Pick<AccessGroup, "id" | "name" | "memberCount" | "guestCount" | "selfAddedCount" | "level">;
export type Draft = { audience: Audience; audienceLevel: Level | null; people: DraftPerson[]; groups: DraftGroup[] };

export const draftFrom = (access: ItemAccess): Draft => ({
  audience: access.audience,
  audienceLevel: access.audienceLevel ?? null,
  people: access.people.map(({ id, displayName, teamRole, level, blocked }) => ({ id, displayName, teamRole, level, blocked })),
  groups: access.groups.map(({ id, name, memberCount, guestCount, selfAddedCount, level }) => ({ id, name, memberCount, guestCount, selfAddedCount, level }))
});

const KIND_NOUN: Record<AccessKind, string> = { note: "note", folder: "folder", document: "file", board: "board", task_view: "view", collection: "collection", calendar: "calendar" };

/** The audience radios (§E). Managers never see them (D273); notes and files can inherit their folder. */
export function audienceOptions(access: Pick<ItemAccess, "kind" | "inheritable">): Array<{ value: Audience; label: string; hint: string }> {
  const noun = KIND_NOUN[access.kind];
  return [
    ...(access.inheritable ? [{ value: "inherit" as const, label: "Use folder access", hint: `Whoever can open its folder can open this ${noun}` }] : []),
    { value: "private", label: "Only me", hint: `Nobody else can open this ${noun}` },
    { value: "selected", label: "People and groups I choose", hint: "Add them below, each with what they can do" },
    { value: "all_users", label: "Everyone signed in", hint: "Everyone on this Nook except guests; never public" }
  ];
}

export function levelOptions(kind: AccessKind, levels: readonly Level[]): Option<Level>[] {
  return levels.map((level) => ({ value: level, label: LEVEL_LABELS[level], description: levelDescription(kind, level) }));
}

/** The level a new person or group starts at: today's default for the module, within what the caller may give. */
export function defaultLevelFor(access: Pick<ItemAccess, "kind" | "levels" | "audienceLevel">): Level {
  const wanted: Level = access.kind === "board" ? "edit"
    : (access.kind === "collection" || access.kind === "calendar") && access.audienceLevel === "edit" ? "edit" : "view";
  return access.levels.includes(wanted) ? wanted : access.levels[access.levels.length - 1] ?? "view";
}

/** "Viewer role reads only": the Team role caps what a person can do, whatever the level says (D71). */
export function roleCapHint(role: Role | undefined) {
  return role === "viewer" || role === "guest" ? `${ROLE_LABELS[role]} role reads only` : null;
}

/** A row a manager may not change: another manager (only the owner adds, changes, or removes managers, T207). */
export const lockedForYou = (access: Pick<ItemAccess, "yourLevel">, level: Level) => access.yourLevel === "manage" && level === "manage";

export const personValue = (id: string) => `person:${id}`;
export const groupValue = (id: string) => `group:${id}`;

export function groupSummary(group: Pick<PickerGroup, "memberCount" | "guestCount">) {
  const people = `${group.memberCount} ${group.memberCount === 1 ? "person" : "people"}`;
  return group.guestCount ? `${people} · includes ${group.guestCount} ${group.guestCount === 1 ? "guest" : "guests"}` : people;
}

/**
 * The Add people or groups options: groups first (with their size and guests), then people (with
 * their Team role), leaving out the owner and everyone already on the list. With sharing with guests
 * off, groups that include guests are shown disabled with the reason (T213).
 */
export function pickerOptions(draft: Draft, access: Pick<ItemAccess, "owner" | "shareWithGuests">, people: readonly PickerPerson[], groups: readonly PickerGroup[]): Option[] {
  const chosenPeople = new Set(draft.people.map((person) => person.id));
  const chosenGroups = new Set(draft.groups.map((group) => group.id));
  const groupOptions: Option[] = groups.filter((group) => !chosenGroups.has(group.id)).map((group) => {
    const blocked = !access.shareWithGuests && group.guestCount > 0;
    return { value: groupValue(group.id), label: group.name, group: "Groups", description: blocked ? `${groupSummary(group)} · sharing with guests is off` : groupSummary(group), disabled: blocked };
  });
  const personOptions: Option[] = people.filter((person) => person.id !== access.owner.id && !chosenPeople.has(person.id)).map((person) => ({
    value: personValue(person.id),
    label: person.displayName,
    group: "People",
    description: person.role ? `Team role: ${ROLE_LABELS[person.role]}${roleCapHint(person.role) ? " · reads only" : ""}` : undefined
  }));
  return [...groupOptions, ...personOptions];
}

/** Adds the picked person or group at the default level. Unknown values change nothing. */
export function addPicked(draft: Draft, value: string, access: Pick<ItemAccess, "kind" | "levels" | "audienceLevel">, people: readonly PickerPerson[], groups: readonly PickerGroup[]): Draft {
  const level = defaultLevelFor(access);
  if (value.startsWith("group:")) {
    const group = groups.find((item) => groupValue(item.id) === value);
    if (!group || draft.groups.some((item) => item.id === group.id)) return draft;
    return { ...draft, groups: [...draft.groups, { id: group.id, name: group.name, memberCount: group.memberCount, guestCount: group.guestCount, selfAddedCount: 0, level }] };
  }
  const person = people.find((item) => personValue(item.id) === value);
  if (!person || draft.people.some((item) => item.id === person.id)) return draft;
  return { ...draft, people: [...draft.people, { id: person.id, displayName: person.displayName, teamRole: person.role ?? "member", level, ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}) }] };
}

/** What PUT sends. People and groups only for "selected"; managers never send the audience level (D273). */
export function toPutBody(draft: Draft, access: Pick<ItemAccess, "yourLevel" | "audienceLevels">): AccessPutBody {
  const selected = draft.audience === "selected";
  return {
    audience: draft.audience,
    ...(access.audienceLevels && access.yourLevel === "owner" && draft.audienceLevel ? { audienceLevel: draft.audienceLevel } : {}),
    people: selected ? draft.people.map(({ id, level }) => ({ id, level })) : [],
    groups: selected ? draft.groups.map(({ id, level }) => ({ id, level })) : []
  };
}

/** Why Save is unavailable, or null. */
export function saveBlocker(draft: Draft) {
  if (draft.audience === "selected" && draft.people.length === 0 && draft.groups.length === 0) return "Add at least one person or group, or choose another option.";
  return null;
}

export function isDirty(draft: Draft, access: ItemAccess) {
  return JSON.stringify(toPutBody(draft, access)) !== JSON.stringify(toPutBody(draftFrom(access), access));
}

/** The server's error codes as the sheet says them. */
export function accessErrorMessage(code: unknown, fallback: string) {
  switch (code) {
    case "ACCESS_CHANGED": return "Someone else changed who has access. The sheet now shows the latest; make your change again.";
    case "GUEST_SHARE_DISABLED": return "Sharing with guests is turned off for this Nook. Remove guests, or groups that include them.";
    case "MANAGER_CAP": return "Managers share up to Can edit. Only the owner changes managers or who can open this.";
    case "LEVEL_NOT_OFFERED": return "One of those levels is not offered here.";
    case "ROLE_READ_ONLY": return "Your team role is read-only.";
    default: return fallback;
  }
}
