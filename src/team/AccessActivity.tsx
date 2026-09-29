import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, History, RotateCcw, TriangleAlert } from "lucide-react";
import { relativeTime } from "../files/format";
import { Select, type Option } from "../ui/Select";
import { activityLabel, listAccessActivity, type ActivityCategory, type ActivityEvent } from "../access/memberAccessApi";
import { listGroups, type GroupSummary } from "./groupsApi";
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
  { value: "templates", label: "Templates" }
];

const metaLine = (event: ActivityEvent) => {
  if (!event.meta) return null;
  const parts: string[] = [];
  const meta = event.meta;
  if (typeof meta.from === "string" && typeof meta.to === "string") parts.push(`${meta.from} → ${meta.to}`);
  for (const key of ["directShares", "groups", "keys", "feeds", "routines", "peopleCount", "groupCount", "added", "skipped", "memberCount", "grantCount"] as const) {
    if (typeof meta[key] === "number") parts.push(`${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${meta[key]}`);
  }
  if (typeof meta.audience === "string") parts.push(`audience: ${meta.audience.replace("_", " ")}`);
  if (meta.self === true) parts.push("added themselves");
  return parts.length ? parts.join(" · ") : null;
};

export function AccessActivity({ members, onBack }: { members: ReadonlyArray<{ id: string; displayName: string }>; onBack: () => void }) {
  const [person, setPerson] = useState("all");
  const [group, setGroup] = useState("all");
  const [category, setCategory] = useState<"all" | ActivityCategory>("all");
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => { listGroups().then((result) => setGroups(result.groups), () => setGroups([])); }, []);
  useEffect(() => { document.title = "Access activity · Team · Nook"; }, []);

  const load = useCallback(async (from: string | null) => {
    const current = ++generation.current;
    setError(null);
    try {
      const result = await listAccessActivity({ user: person === "all" ? undefined : person, group: group === "all" ? undefined : group, action: category === "all" ? undefined : category, cursor: from });
      if (current !== generation.current) return;
      setEvents((previous) => from && previous ? [...previous, ...result.events] : result.events);
      setCursor(result.nextCursor);
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : "Could not load activity");
    }
  }, [category, group, person]);
  useEffect(() => { void load(null); }, [load]);

  const personOptions: Option[] = [{ value: "all", label: "Anyone" }, ...members.map((member) => ({ value: member.id, label: member.displayName }))];
  const groupOptions: Option[] = [{ value: "all", label: "Any group" }, ...groups.map((entry) => ({ value: entry.id, label: entry.name }))];

  return <article className="team-detail team-access-activity" aria-labelledby="team-activity-title">
    <button type="button" className="team-back" onClick={onBack}><ChevronLeft />Team</button>
    <header className="team-invites-header">
      <div>
        <h2 id="team-activity-title">Access activity</h2>
        <p className="team-muted">Changes to keys, groups, item access, policies, and templates. Titles of items you cannot open stay hidden.</p>
      </div>
    </header>
    <div className="ma-filters" role="group" aria-label="Filter activity">
      <div className="keys-select-field"><span id="activity-person">Person</span><Select labelledBy="activity-person" label="Person" value={person} options={personOptions} onChange={setPerson} /></div>
      <div className="keys-select-field"><span id="activity-group">Group</span><Select labelledBy="activity-group" label="Group" value={group} options={groupOptions} onChange={setGroup} /></div>
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
