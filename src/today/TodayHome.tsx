import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ArrowRight, RotateCcw, RotateCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { AccountActions, useBinCount } from "../AppShell";
import type { AppSection } from "../appShellNavigation";
import { ApiError } from "../api";
import { hiddenTodaySections, isModuleEnabled, useDisabledModules } from "../modules";
import { formatRoute, type Route } from "../router";
import { CustomizeSections } from "./CustomizeSections";
import { getToday, type TodayResponse, type TodaySection } from "./todayApi";
import { enabledTodayApps } from "./todayApps";
import { readHiddenSections, toggleHidden, writeHiddenSections } from "./todayPreferences";
import { DEFAULT_SECTION_ORDER, groupTodaySections, sectionCount, storageText, TODAY_SECTIONS, viewAllRoute, type StorageUsage } from "./todaySections";
import "./today.css";

/** Data older than this is refetched when the tab becomes visible again. */
export const TODAY_STALE_MS = 60_000;

type TodayHomeProps = {
  userId: string;
  displayName: string;
  onOpen: (section: AppSection) => void;
  /** Opens an in-app route as a new history entry (depth + 1), so Back returns to Today. */
  onOpenRoute: (route: Route) => void;
  onSettings: () => void;
  onSignOut: () => void;
};

/** A real link: middle-click and modifier clicks keep the browser's behaviour; a plain click routes in the app. */
export function RouteLink({ route, onOpenRoute, className, children, label }: { route: Route; onOpenRoute: (route: Route) => void; className?: string; children: ReactNode; label?: string }) {
  const onClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenRoute(route);
  };
  return <a className={className} href={formatRoute(route)} onClick={onClick} aria-label={label}>{children}</a>;
}

function StorageMeter({ usage }: { usage: StorageUsage }) {
  const text = storageText(usage);
  const percent = usage.quotaBytes ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100)) : 0;
  return <div className="today-storage">
    <p className="today-storage-summary">{text.summary}</p>
    {usage.quotaBytes
      ? <div className={`today-meter${percent >= 90 ? " high" : ""}`} role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={usage.quotaBytes} aria-valuenow={Math.min(usage.usedBytes, usage.quotaBytes)} aria-valuetext={text.summary}>
        <span style={{ width: `${percent}%` }} />
      </div>
      : null}
    <p className="today-storage-detail">{text.detail}</p>
  </div>;
}

type SectionViewProps = { name: string; section: TodaySection | undefined; date: string; busy: boolean; retrying: boolean; onRetry: () => void; onOpenRoute: (route: Route) => void };

/** A section that has loaded with nothing in it: it folds into one muted line in its group. */
export function isQuietSection(name: string, section: TodaySection | undefined, busy: boolean, retrying: boolean) {
  return !busy && !retrying && !!section && !section.error && section.items.length === 0 && !!TODAY_SECTIONS[name];
}

function SectionView({ name, section, date, busy, retrying, onRetry, onOpenRoute }: SectionViewProps) {
  const def = TODAY_SECTIONS[name]!;
  const headingId = `today-${name}`;
  const count = !busy && section && !section.error && name !== "storage" ? sectionCount(section.items, section.more) : null;
  return <section className={`today-section today-section-${name}`} aria-labelledby={headingId} aria-busy={busy || retrying || undefined}>
    <header className="today-section-header">
      <h3 id={headingId}>{def.title}{count && <span className="today-section-count"> · {count}</span>}</h3>
      {section && <RouteLink className="today-view-all" route={viewAllRoute(def.viewAll ?? section.href)} onOpenRoute={onOpenRoute} label={`View all ${def.title.toLowerCase()} in ${def.app}`}>View all<ArrowRight aria-hidden="true" /></RouteLink>}
    </header>
    {busy || !section
      ? <ul className="today-skeleton" aria-hidden="true"><li /><li /><li /></ul>
      : section.error
        ? <div className="today-section-error" role="alert">
          <p>{def.title} could not be loaded.</p>
          <button className="secondary-button today-retry" onClick={onRetry} disabled={retrying}><RotateCcw />{retrying ? "Retrying…" : "Retry"}</button>
        </div>
        : name === "storage"
          ? <StorageMeter usage={section.items[0] as StorageUsage} />
          : <>
            <ul className="today-list">
              {section.items.map((item) => {
                const row = def.row!(item, date);
                return <li key={row.key}>
                  <RouteLink className={`today-row${row.tone ? ` ${row.tone}` : ""}`} route={row.route} onOpenRoute={onOpenRoute}>
                    <span className="today-row-label">{row.label}</span>
                    {row.meta && <span className="today-row-meta">{row.meta}</span>}
                  </RouteLink>
                </li>;
              })}
            </ul>
            {section.more && <p className="today-more">Showing the latest ten. View all for more.</p>}
          </>}
  </section>;
}

type TodayGroupsProps = {
  names: readonly string[];
  data: TodayResponse | null;
  busy: boolean;
  retrying: ReadonlySet<string>;
  onRetry: (name: string) => void;
  onOpenRoute: (route: Route) => void;
};

/**
 * The sections in their three fixed groups (Today, Recent work, Housekeeping), one column each
 * on wide screens. Sections with items are cards; empty ones fold into a muted line under them,
 * and a group with nothing at all says "All clear".
 */
export function TodayGroups({ names, data, busy, retrying, onRetry, onOpenRoute }: TodayGroupsProps) {
  return <div className="today-groups" aria-busy={busy || undefined}>
    {groupTodaySections(names).map((group) => {
      const quiet = group.names.filter((name) => isQuietSection(name, data?.sections[name], busy, retrying.has(name)));
      const cards = group.names.filter((name) => !quiet.includes(name));
      const headingId = `today-group-${group.id}`;
      return <section key={group.id} className={`today-group today-group-${group.id}`} aria-labelledby={headingId}>
        <h2 id={headingId} className="today-group-title">{group.title}</h2>
        {cards.length > 0 && <div className="today-group-cards">
          {cards.map((name) => <SectionView key={name} name={name} section={data?.sections[name]} date={data?.date ?? ""} busy={busy} retrying={retrying.has(name)} onRetry={() => onRetry(name)} onOpenRoute={onOpenRoute} />)}
        </div>}
        {cards.length === 0
          ? <p className="today-all-clear"><strong>All clear</strong> · {group.clear}</p>
          : quiet.length > 0 && <ul className="today-quiet-list">
            {quiet.map((name) => <li key={name} className={`today-quiet today-quiet-${name}`}><span className="today-quiet-title">{TODAY_SECTIONS[name]!.title}</span> · {TODAY_SECTIONS[name]!.empty}</li>)}
          </ul>}
      </section>;
    })}
  </div>;
}

/**
 * Home at `/` (WAVES_10-12.md D50, §2.3): the greeting, a launcher row of the
 * installed apps, and the Today sections. Every item is a real link routed
 * through `navigate`, so Back from it returns here.
 */
/** Today's date in the browser, for the heading when no section is requested at all. */
function localIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Loads Today without the sections of modules that are off (D92), so their providers never run.
 * An older server that does not know one of the names answers 400; then everything is loaded and
 * the view filters instead.
 */
async function loadVisibleToday(moduleHidden: readonly string[]): Promise<TodayResponse> {
  if (moduleHidden.length === 0) return getToday();
  const wanted = DEFAULT_SECTION_ORDER.filter((name) => !moduleHidden.includes(name));
  if (wanted.length === 0) return { generatedAt: new Date().toISOString(), date: localIsoDate(), sections: {} };
  try {
    return await getToday(wanted);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 400) return getToday();
    throw reason;
  }
}

export function TodayHome({ userId, displayName, onOpen, onOpenRoute, onSettings, onSignOut }: TodayHomeProps) {
  const disabledModules = useDisabledModules();
  const binEnabled = isModuleEnabled(disabledModules, "bin");
  const moduleHiddenKey = hiddenTodaySections(disabledModules).join(",");
  const binCount = useBinCount(binEnabled);
  const [data, setData] = useState<TodayResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [hidden, setHidden] = useState<string[]>(() => readHiddenSections(userId));
  const [customizing, setCustomizing] = useState(false);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const fetchedAtRef = useRef(0);
  const generationRef = useRef(0);

  const load = useCallback(async (announce: boolean) => {
    const generation = ++generationRef.current;
    setRefreshing(true);
    if (announce) setAnnouncement("Refreshing…");
    try {
      const next = await loadVisibleToday(moduleHiddenKey ? moduleHiddenKey.split(",") : []);
      if (generation !== generationRef.current) return;
      setData(next);
      setLoadError(null);
      fetchedAtRef.current = Date.now();
      if (announce) setAnnouncement("Today is up to date");
    } catch (reason) {
      if (generation !== generationRef.current) return;
      const message = reason instanceof Error ? reason.message : "Could not load Today";
      setLoadError(message);
      // A failure also counts as an attempt, so tab switches retry at most once a minute.
      fetchedAtRef.current = Date.now();
      if (announce) setAnnouncement(`Could not refresh: ${message}`);
    } finally {
      if (generation === generationRef.current) setRefreshing(false);
    }
  }, [moduleHiddenKey]);

  useEffect(() => {
    void load(false);
    return () => { generationRef.current += 1; };
  }, [load, userId]);

  // Coming back to the tab refetches data older than a minute (no polling, no realtime).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - fetchedAtRef.current > TODAY_STALE_MS) void load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [load]);

  useEffect(() => setHidden(readHiddenSections(userId)), [userId]);
  function changeHidden(next: string[]) {
    setHidden(next);
    writeHiddenSections(userId, next);
  }
  const closeCustomize = useCallback(() => {
    setCustomizing(false);
    // Return focus to the button that opened the dialog.
    window.requestAnimationFrame(() => customizeButtonRef.current?.focus());
  }, []);

  async function retrySection(name: string) {
    setRetrying((current) => new Set(current).add(name));
    try {
      const next = await getToday([name]);
      const section = next.sections[name];
      if (section) setData((current) => current ? { ...current, sections: { ...current.sections, [name]: section } } : current);
      setAnnouncement(section?.error ? `${TODAY_SECTIONS[name]?.title ?? "Section"} still could not be loaded` : `${TODAY_SECTIONS[name]?.title ?? "Section"} loaded`);
    } catch (reason) {
      setAnnouncement(reason instanceof Error ? reason.message : "Could not load the section");
    } finally {
      setRetrying((current) => { const next = new Set(current); next.delete(name); return next; });
    }
  }

  const initialLoading = data === null && loadError === null;
  // The sections the server returned that this client knows how to show, without
  // those of modules that are turned off (they are not offered in Customize either).
  const moduleHidden = moduleHiddenKey ? moduleHiddenKey.split(",") : [];
  // Client registry order (group order), whatever order the server answered in.
  const available = DEFAULT_SECTION_ORDER.filter((name) => data ? data.sections[name] : name !== "agentDrafts")
    .filter((name) => !moduleHidden.includes(name));
  const names = available.filter((name) => !hidden.includes(name));
  const firstName = displayName.split(" ")[0] || displayName;

  return <main className="app-home today-home">
    <header className="app-home-header">
      <div className="app-home-brand"><span className="brand-dot"><Sparkles /></span><span className="brand-text"><strong>Home</strong></span></div>
      <AccountActions displayName={displayName} onSettings={onSettings} onSignOut={onSignOut} onBin={binEnabled ? () => onOpen("bin") : undefined} binCount={binCount} />
    </header>
    <div className="today-content">
      <section className="today-intro" aria-labelledby="app-home-title">
        <h1 id="app-home-title">Good to see you, {firstName}.</h1>
        <p className="today-launcher-label" aria-hidden="true">Apps</p>
        <nav className="today-launcher" aria-label="Apps">
          <ul>
            {enabledTodayApps(disabledModules).map(({ section, label, href, icon: Icon }) => <li key={section}>
              <a className={`today-app today-app-${section}`} href={href} onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpen(section);
              }}><span className="today-app-icon" aria-hidden="true"><Icon /></span><span>{label}</span></a>
            </li>)}
          </ul>
        </nav>
      </section>

      <div className="today-toolbar">
        <p className="today-toolbar-title">{data ? new Date(`${data.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "Today"}</p>
        <button className="secondary-button today-refresh" onClick={() => { void load(true); }} disabled={refreshing} aria-describedby="today-status"><RotateCw className={refreshing ? "spinning" : undefined} />{refreshing ? "Refreshing…" : "Refresh"}</button>
        <button ref={customizeButtonRef} className="secondary-button today-customize" onClick={() => setCustomizing(true)} aria-haspopup="dialog" disabled={!data}><SlidersHorizontal /><span>Customize<span className="today-customize-extra"> sections</span></span></button>
        <p id="today-status" className="sr-only" role="status" aria-live="polite">{announcement}</p>
      </div>

      {loadError && !data
        ? <div className="today-load-error" role="alert">
          <h2>Today could not be loaded</h2>
          <p>{loadError}</p>
          <button className="primary-button" onClick={() => { void load(true); }} disabled={refreshing}><RotateCcw />Try again</button>
        </div>
        : names.length === 0
          ? <p className="today-all-hidden">{available.length === 0 ? "Every Today section belongs to a module that is turned off. Turn modules on in Settings → Modules." : "Every section is hidden. Use Customize sections to show them again."}</p>
          : <TodayGroups names={names} data={data} busy={initialLoading} retrying={retrying} onRetry={(name) => { void retrySection(name); }} onOpenRoute={onOpenRoute} />}
      {customizing && <CustomizeSections names={available} hidden={hidden} onChange={(name, visible) => changeHidden(toggleHidden(hidden, name, visible))} onShowAll={() => changeHidden([])} onClose={closeCustomize} />}
    </div>
  </main>;
}
