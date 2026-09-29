import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, History, RotateCcw, TriangleAlert } from "lucide-react";
import { relativeTime } from "../files/format";
import { Select, type Option } from "../ui/Select";
import { activityLabel, listAccessActivity, type ActivityCategory, type ActivityEvent } from "../access/memberAccessApi";
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

const metaLine = (event: ActivityEvent) => {
  if (!event.meta) return null;
  if (event.action === "account.google_reset" || event.action === "account.google_relinked") return googleRemovedLine(event.meta);
  const parts: string[] = [];
  const meta = event.meta;
  if (typeof meta.from === "string" && typeof meta.to === "string") parts.push(`${meta.from} → ${meta.to}`);
  for (const key of ["directShares", "groups", "sessions", "keys", "feeds", "items", "shares", "groupGrants", "invites", "routines", "peopleCount", "groupCount", "added", "skipped", "memberCount", "grantCount"] as const) {
    if (typeof meta[key] === "number") parts.push(`${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${meta[key]}`);
  }
  // Google sign-in (Wave 35): what went with the password and two-factor.
  if (meta.password === 1) parts.push("password removed");
  if (meta.twoFactor === 1) parts.push("two-factor removed");
  if (meta.relink === true) parts.push(meta.removeCredentials === false ? "keeps password and two-factor" : "removes password and two-factor at re-link");
  if (typeof meta.audience === "string") parts.push(`audience: ${meta.audience.replace("_", " ")}`);
  if (meta.self === true) parts.push("added themselves");
  return parts.length ? parts.join(" · ") : null;
};

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
  const seenKeys = new Map<string, { name: string; prefix: string | null }>();
  for (const event of events ?? []) if (event.key?.name && !keys.some((entry) => entry.id === event.key!.id)) seenKeys.set(event.key.id, { name: event.key.name, prefix: event.key.prefix });
  const keyOptions: Option[] = [
    { value: "all", label: "Any key" },
    ...keys.map((entry) => ({ value: entry.id, label: entry.name, description: `${entry.owner.displayName} · ${entry.prefix}…` })),
    ...[...seenKeys].map(([id, entry]) => ({ value: id, label: entry.name, description: `No longer live${entry.prefix ? ` · ${entry.prefix}…` : ""}` }))
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
