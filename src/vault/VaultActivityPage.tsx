import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { relativeTime } from "../files/format";
import { Select } from "../ui/Select";
import { errorCode, messageOf } from "./VaultDialogs";
import { listActivity, type ActivityEvent, type ActivityPage } from "./vaultApi";

/**
 * A vault's Activity at /vault/:id/activity (vault plan §7, §10; Wave 26): who did what and how many,
 * newest first, never a value. Owners see everyone's events and can filter by person; members see
 * their own. Filters: person, kind of event, environment. The person filter can arrive from the
 * Access page ("show what they read"), set by the app before it opens this route.
 */

const FAMILY_LABELS: Record<string, string> = {
  reads: "Reads", writes: "Changes to values and secrets", access: "Access and members", keys: "Data key", transfer: "Import and export", structure: "Vault and environments"
};

const WORDS: Record<string, string> = {
  "value.read": "revealed", "version.read": "opened an old version of", "comment.read": "opened the comment of",
  "value.write": "set", "value.clear": "cleared", "value.restore": "restored an old version of",
  "secret.create": "created", "secret.update": "edited", "secret.delete": "deleted", "secret.restore": "restored", "secret.purge": "purged",
  "member.add": "added people", "member.remove": "removed people", "member.leave": "left the vault", "member.owner": "made someone an owner", "member.demote": "made an owner a member", "access.change": "changed which groups have access", "access.level": "changed access",
  "key.rotate": "rotated the data key", "key.rotate.auto": "started a data-key rotation (someone lost access)", "key.rotate.skipped": "left rows that did not open under their key (rotation)", "key.retire": "retired old data keys",
  "export": "exported", "import": "imported into", "import.preview": "previewed an import into",
  "vault.create": "created the vault", "vault.update": "renamed or described the vault", "vault.delete": "moved the vault to the Bin", "vault.restore": "restored the vault",
  "env.create": "added the environment", "env.update": "renamed the environment", "env.protect": "protected", "env.unprotect": "removed protection from", "env.reorder": "reordered environments",
  "env.delete": "deleted the environment", "env.restore": "restored the environment", "env.purge": "purged the environment", "integrity.fail": "hit an integrity check on"
};

/** One line, in words: "Alice revealed DATABASE_URL in Production", "You exported 12 values from Staging". */
export function activityLine(event: ActivityEvent) {
  const who = event.actor ? (event.actor.isYou ? "You" : event.actor.displayName) : event.via === "sweeper" ? "Nook" : "Someone";
  const verb = WORDS[event.event] ?? event.event;
  const secret = event.secret ? event.secret.name ?? (event.secret.state === "binned" ? "a secret now in the Bin" : "a secret that is gone") : null;
  const env = event.environment ? event.environment.name ?? "an environment you cannot see" : null;
  const count = event.count !== null && event.count > 1 && ["value.read", "export", "import", "import.preview", "member.add", "member.remove", "key.retire"].includes(event.event) ? event.count : null;
  if (event.event === "export") return `${who} exported ${count ?? event.count ?? 0} ${(event.count ?? 0) === 1 ? "value" : "values"}${env ? ` from ${env}` : ""}`;
  if (event.event === "import" || event.event === "import.preview") return `${who} ${verb} ${env ?? "an environment"} (${event.count ?? 0} ${(event.count ?? 0) === 1 ? "entry" : "entries"})`;
  if (event.event === "value.read" && !secret) return `${who} revealed ${event.count ?? 1} ${(event.count ?? 1) === 1 ? "value" : "values"}`;
  if (event.event.startsWith("env.") && env && event.event !== "env.reorder") return `${who} ${verb} ${env}`;
  // QA L1: access lines name whom they were about (names and levels only, never a value).
  if (event.target) {
    const target = event.target.isYou ? (event.actor?.isYou ? "yourself" : "you") : event.target.displayName;
    const where = env ?? "an environment";
    switch (event.event) {
      case "member.add": return `${who} added ${target}`;
      case "member.remove": return `${who} removed ${target}`;
      case "member.owner": return `${who} made ${target} an owner`;
      case "member.demote": return `${who} made ${target} a member`;
      case "access.level": return event.level === "none" || !event.level
        ? `${who} took away ${target === "yourself" ? "your own" : `${target}'s`} access to ${where}`
        : `${who} gave ${target} ${event.level} access to ${where}`;
      default: break;
    }
  }
  if (event.event.startsWith("member.") || event.event.startsWith("access.") || event.event.startsWith("key.") || event.event.startsWith("vault.") || event.event === "env.reorder") {
    return `${who} ${verb}${count ? ` (${count})` : ""}`;
  }
  return `${who} ${verb}${secret ? ` ${secret}` : ""}${env ? ` in ${env}` : ""}${count ? ` (${count} values)` : ""}`;
}

export function VaultActivityPage({ vaultId, vaultName, initialActor, onBack, onReady, onMissing }: {
  vaultId: string; vaultName: string | null; initialActor: string | null; onBack: () => void; onReady: () => void; onMissing: () => void;
}) {
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [actor, setActor] = useState<string | null>(initialActor);
  const [family, setFamily] = useState<string | null>(initialActor ? "reads" : null);
  const [env, setEnv] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (cursor: string | null) => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listActivity(vaultId, { actor, event: family, env, cursor });
      if (current !== generation.current) return;
      setPage(result);
      setEvents((previous) => cursor ? [...previous, ...result.events] : result.events);
    } catch (reason) {
      if (current !== generation.current) return;
      if (errorCode(reason) === "NOT_FOUND") onMissing();
      else setError(messageOf(reason, "Could not load the activity"));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [actor, env, family, onMissing, vaultId]);
  useEffect(() => { void load(null); }, [load]);
  const ready = page !== null || error !== null;
  useLayoutEffect(() => { if (ready) onReady(); }, [ready, onReady]);
  useEffect(() => { document.title = `Activity${vaultName ? ` · ${vaultName}` : ""} · Vault · Nook`; }, [vaultName]);

  return <>
    <div className="vault-toolbar">
      <button type="button" className="icon-button vault-back" onClick={onBack} aria-label="Back to the vault" title="Back to the vault"><ChevronLeft /></button>
      <h1 className="vault-title">Activity{vaultName && <span className="vault-count"> · {vaultName}</span>}</h1>
    </div>
    <p className="vault-description">{page?.scope === "own" ? "Your own activity in this vault. Owners see everyone's." : "Who did what in this vault. Values are never shown or recorded here."}</p>
    {page && <div className="vault-activity-filters">
      {page.scope === "vault" && <Select label="Person" value={actor ?? "all"} onChange={(next) => setActor(next === "all" ? null : next)}
        options={[{ value: "all", label: "Everyone" }, ...page.people.map((person) => ({ value: person.id, label: person.displayName }))]} />}
      <Select label="Kind" value={family ?? "all"} onChange={(next) => setFamily(next === "all" ? null : next)}
        options={[{ value: "all", label: "Everything" }, ...page.families.map((item) => ({ value: item, label: FAMILY_LABELS[item] ?? item }))]} />
      <Select label="Environment" value={env ?? "all"} onChange={(next) => setEnv(next === "all" ? null : next)}
        options={[{ value: "all", label: "Every environment" }, ...page.environments.map((item) => ({ value: item.id, label: item.name }))]} />
    </div>}
    {error && <div className="vault-state" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => { void load(null); }}><RotateCcw />Try again</button></div>}
    {!page && !error && <p className="vault-loading" role="status">Loading…</p>}
    {page && events.length === 0 && !loading && <p className="vault-loading">Nothing here yet.</p>}
    {events.length > 0 && <ol className="vault-activity" aria-label="Activity">
      {events.map((event) => <li key={event.id}>
        <span className="vault-activity-line">{activityLine(event)}</span>
        <small><time dateTime={event.createdAt}>{relativeTime(event.createdAt)}</time>{event.via !== "session" ? ` · ${event.via}` : ""}</small>
      </li>)}
    </ol>}
    {page?.nextCursor && <button type="button" className="secondary-button vault-more" disabled={loading} onClick={() => { void load(page.nextCursor); }}>{loading ? "Loading…" : "Show more"}</button>}
  </>;
}
