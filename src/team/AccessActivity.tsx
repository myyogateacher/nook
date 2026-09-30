import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, History, RotateCcw, TriangleAlert } from "lucide-react";
import { relativeTime } from "../files/format";
import { Select, type Option } from "../ui/Select";
import { activityLabel, LEVEL_WORDS, listAccessActivity, resetLines, type AccessLevel, type ActivityCategory, type ActivityEvent } from "../access/memberAccessApi";
import { listGroups, type GroupSummary } from "./groupsApi";
import { listInventory, type InventoryKey } from "../keys/keysApi";
import "../keys/keys.css";
import "../access/memberAccess.css";

/**
 * Team → Access activity at /team/activity (Wave 33, access plan §C.6, D288), admins only: who
 * changed keys, groups, item access, policies, and templates, newest first, filtered by person,
 * group, and kind of change. Ids and counts only; an item's title shows only when you can open it.
 */

const CATEGORY_OPTIONS: Option<"all" | ActivityCategory>[] = [
  { value: "all", label: "Any change" },
  { value: "items", label: "Item access" },
  { value: "groups", label: "Groups" },
  { value: "keys", label: "API keys" },
  { value: "policies", label: "Policies" },
  { value: "templates", label: "Templates" },
  { value: "accounts", label: "Google sign-in" }
];

/** G4: what a Google reset or re-link removed, as a sentence of only what actually went. */
export function googleRemovedLine(meta: Record<string, unknown>) {
  const count = (key: string) => typeof meta[key] === "number" ? meta[key] as number : 0;
  const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const parts = [
    count("sessions") && plural(count("sessions"), "signed-in session", "signed-in sessions"),
    count("keys") && plural(count("keys"), "API key", "API keys"),
    count("feeds") && plural(count("feeds"), "calendar feed", "calendar feeds"),
    count("password") ? "the password" : null,
    count("twoFactor") ? "two-factor" : null,
    count("items") && `sharing of ${plural(count("items"), "item", "items")}`,
    count("invites") && plural(count("invites"), "live invite", "live invites"),
    count("routines") && `${plural(count("routines"), "routine", "routines")} (paused)`
  ].filter((part): part is string => Boolean(part));
  if (!parts.length) return "Nothing needed removing.";
  const list = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `Removed ${list}.`;
}

/** "a", "a and b", "a, b, and c". */
const listWords = (parts: string[]) => parts.length <= 1 ? parts[0] ?? "" : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
const counted = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
const levelWords = (value: unknown) => typeof value === "string" && value in LEVEL_WORDS ? `“${LEVEL_WORDS[value as AccessLevel]}”` : null;
const ROLE_WORDS: Record<string, string> = { admin: "Admin", member: "Member", viewer: "Viewer", guest: "Guest" };

/**
 * F10 (v0.16.0 QA): the detail under an Access activity line, as a sentence. It used to be a raw
 * list ("direct shares: 3 · groups: 1", "audience: all users"); each action now says what it meant.
 */
export function metaLine(event: ActivityEvent): string | null {
  const meta = event.meta;
  if (!meta) return null;
  const count = (key: string) => typeof meta[key] === "number" ? meta[key] as number : 0;
  switch (event.action) {
    case "account.google_reset":
    case "account.google_relinked":
      return googleRemovedLine(meta);
    case "account.google_allowed":
      return meta.relink === true ? meta.removeCredentials === false ? "The password and two-factor stay after the re-link." : "The password and two-factor are removed at the re-link." : null;
    case "access.reset": {
      const parts = resetLines({ directShares: count("directShares"), groups: count("groups"), keys: count("keys"), feeds: count("feeds"), routines: count("routines") });
      return parts.length ? `Removed ${listWords(parts)}.` : "Nothing needed removing.";
    }
    case "access.share_lowered": {
      const from = levelWords(meta.from);
      const to = levelWords(meta.to);
      return from && to ? `From ${from} to ${to}.` : null;
    }
    case "access.share_removed": {
      const level = levelWords(meta.level);
      return level ? `They had ${level}.` : null;
    }
    case "item.access_changed": {
      const manager = meta.asManager === true ? " Changed by a manager, not the owner." : "";
      if (meta.audience === "private") return `Now private.${manager}`;
      if (meta.audience === "all_users") return `Now open to everyone on this Nook.${manager}`;
      if (meta.audience === "inherit") return `Now follows its folder's access.${manager}`;
      if (meta.audience === "selected") {
        const parts = [count("peopleCount") ? counted(count("peopleCount"), "person", "people") : "", count("groupCount") ? counted(count("groupCount"), "group", "groups") : ""].filter(Boolean);
        return `${parts.length ? `Now shared with ${listWords(parts)}.` : "Now shared with nobody yet."}${manager}`;
      }
      return manager.trim() || null;
    }
    case "group.deleted": {
      const parts = [counted(count("memberCount"), "person", "people"), `${counted(count("grantCount"), "item", "items")} shared with it`];
      return `It had ${listWords(parts)}.`;
    }
    case "group.member_added":
      return meta.from === "template" ? "Added by a template." : null;
    case "group.member_removed":
      return meta.from === "reset" ? "Part of Reset access." : meta.from === "member_access" ? "From Team → this person's access." : null;
    case "template.created": {
      const role = typeof meta.role === "string" ? ROLE_WORDS[meta.role] ?? null : null;
      const groups = count("groupCount") ? ` and ${counted(count("groupCount"), "group", "groups")}` : "";
      return role ? `New people get the ${role} role${groups}.` : null;
    }
    case "template.applied": {
      const parts = [count("added") ? `Added to ${counted(count("added"), "group", "groups")}` : "", count("skipped") ? `${counted(count("skipped"), "group was", "groups were")} skipped` : ""].filter(Boolean);
      return parts.length ? `${parts.join("; ")}.` : null;
    }
    case "template.deleted":
      return count("liveInvites") ? `${counted(count("liveInvites"), "live invite", "live invites")} used it.` : null;
    case "key.rotated":
      return count("graceHours") ? `The old key keeps working for ${counted(count("graceHours"), "hour", "hours")}.` : null;
    default:
      return null;
  }
}

/** A key that is no longer live, in the Key filter (C15b): its owner when the event names one, and its prefix. */
export const pastKeyDescription = (entry: { prefix: string | null; owner: string | null }) =>
  ["No longer live", entry.owner, entry.prefix ? `${entry.prefix}…` : null].filter(Boolean).join(" · ");

export function AccessActivity({ members, onBack }: { members: ReadonlyArray<{ id: string; displayName: string }>; onBack: () => void }) {
  const [person, setPerson] = useState("all");
  const [group, setGroup] = useState("all");
  const [category, setCategory] = useState<"all" | ActivityCategory>("all");
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [key, setKey] = useState("all");
  const [keys, setKeys] = useState<InventoryKey[]>([]);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => { listGroups().then((result) => setGroups(result.groups), () => setGroups([])); }, []);
  // Live keys as Team → Keys lists them: name, owner, prefix; never items (D73).
  useEffect(() => { listInventory({}).then((result) => setKeys(result.keys), () => setKeys([])); }, []);
  useEffect(() => { document.title = "Access activity · Team · Nook"; }, []);

  const load = useCallback(async (from: string | null) => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listAccessActivity({ user: person === "all" ? undefined : person, group: group === "all" ? undefined : group, key: key === "all" ? undefined : key, action: category === "all" ? undefined : category, cursor: from });
      if (current !== generation.current) return;
      setEvents((previous) => from && previous ? [...previous, ...result.events] : result.events);
      setCursor(result.nextCursor);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load activity");
    }
  }, [category, group, key, person]);
  useEffect(() => { void load(null); }, [load]);

  const personOptions: Option[] = [{ value: "all", label: "Anyone" }, ...members.map((member) => ({ value: member.id, label: member.displayName }))];
  const groupOptions: Option[] = [{ value: "all", label: "Any group" }, ...groups.map((entry) => ({ value: entry.id, label: entry.name }))];
  // Live keys first (Team → Keys), then keys no longer live that the loaded events name (revoked or expired).
  const seenKeys = new Map<string, { name: string; prefix: string | null; owner: string | null }>();
  for (const event of events ?? []) if (event.key?.name && !keys.some((entry) => entry.id === event.key!.id)) seenKeys.set(event.key.id, { name: event.key.name, prefix: event.key.prefix, owner: event.key.owner?.displayName ?? null });
  const keyOptions: Option[] = [
    { value: "all", label: "Any key" },
    ...keys.map((entry) => ({ value: entry.id, label: entry.name, description: `${entry.owner.displayName} · ${entry.prefix}…` })),
    ...[...seenKeys].map(([id, entry]) => ({ value: id, label: entry.name, description: pastKeyDescription(entry) }))
  ];

  return <article className="team-detail team-access-activity" aria-labelledby="team-activity-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-activity-title">Access activity</h2>
        <p className="team-muted">Changes to keys, groups, item access, policies, templates, and Google sign-in. Titles of items you cannot open stay hidden.</p>
      </div>
    </header>
    <div className="ma-filters" role="group" aria-label="Filter activity">
      <div className="keys-select-field"><span id="activity-person">Person</span><Select labelledBy="activity-person" label="Person" value={person} options={personOptions} onChange={setPerson} /></div>
      <div className="keys-select-field"><span id="activity-group">Group</span><Select labelledBy="activity-group" label="Group" value={group} options={groupOptions} onChange={setGroup} /></div>
      <div className="keys-select-field"><span id="activity-key">Key</span><Select labelledBy="activity-key" label="Key" value={key} options={keyOptions} onChange={setKey} /></div>
      <div className="keys-select-field"><span id="activity-kind">Change</span><Select<"all" | ActivityCategory> labelledBy="activity-kind" label="Change" value={category} options={CATEGORY_OPTIONS} onChange={setCategory} /></div>
    </div>
    {error && <div className="team-state team-error" role="alert">
      <span className="team-state-icon"><TriangleAlert /></span>
      <h2>Could not load activity</h2>
      <p>{error}</p>
      <button className="primary-button" onClick={() => { void load(null); }}><RotateCcw />Try again</button>
    </div>}
    {!error && !events && <p className="team-loading" role="status">Loading activity…</p>}
    {!error && events && events.length === 0 && <div className="team-state">
      <span className="team-state-icon"><History /></span>
      <h2>Nothing yet.</h2>
    </div>}
    {!error && events && events.length > 0 && <ol className="ma-activity-list" aria-label="Access activity">
      {events.map((event) => {
        const detail = metaLine(event);
        return <li key={event.id} className="ma-activity-row">
          <span>{activityLabel(event)}</span>
          {detail && <small>{detail}</small>}
          <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>{relativeTime(event.createdAt)}{event.via !== "web" ? ` · via ${event.via}` : ""}</time>
        </li>;
      })}
    </ol>}
    {cursor && <button type="button" className="secondary-button team-keys-more" onClick={() => { void load(cursor); }}>Show more</button>}
  </article>;
}
