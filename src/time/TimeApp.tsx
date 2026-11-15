import { useCallback, useEffect, useState } from "react";
import { Bell, Plus, Timer } from "lucide-react";
import { ModuleHome } from "../ui/ModuleHome";
import { useRole } from "../team/roleAccess";
import { shortIdOfSegment } from "../../shared/friendlyUrls";
import type { WorkspaceAppProps } from "../workspaceModules/types";
import { TimerTab } from "./TimerTab";
import type { TimeSection } from "./sections";
import { TimesheetTab } from "./TimesheetTab";
import { ReportsTab } from "./ReportsTab";
import { ProjectPage, ProjectSheet, ProjectsTab } from "./ProjectsTab";
import { RemindersSheet } from "./RemindersSheet";
import { EntrySheet } from "./EntrySheet";
import "./time.css";

/**
 * Time home (§D.2, §E.2): ModuleHome with the Timer, Timesheet, Reports, and Projects tabs; a
 * project's page at /time/projects/<slug>-<shortid>. The primary action is "Log time" (`n`), or
 * "New project" on the Projects tab; Reminders sit in the ⋯ menu.
 */

type Tab = TimeSection;

export default function TimeApp({ route, navigate, onOpenPath, displayName, onHome, onSettings, onSignOut, flash, userId }: WorkspaceAppProps) {
  const { readOnly, isGuest, role } = useRole();
  const [first, second] = route.path;
  const tab: Tab = first === "timesheet" || first === "reports" || first === "projects" ? first : "timer";
  const params = new URLSearchParams(route.search);
  const projectRef = tab === "projects" && second ? shortIdOfSegment(second) ?? second : null;
  const [newProject, setNewProject] = useState(false);
  const [logging, setLogging] = useState(false);
  const [reminders, setReminders] = useState(false);
  const go = useCallback((path: string[], search = "", replace = false) => navigate({ app: "time", path, search }, { replace }), [navigate]);
  useEffect(() => { document.title = "Time"; }, []);
  const writer = !readOnly || isGuest;
  const canCreateProject = role === "admin" || role === "member";

  const primary = tab === "projects" && !projectRef
    ? (canCreateProject ? { label: "New project", icon: Plus, onClick: () => setNewProject(true) } : undefined)
    : writer ? { label: "Log time", icon: Plus, onClick: () => setLogging(true) } : undefined;

  return <ModuleHome icon={Timer} title="Time" displayName={displayName} onHome={onHome} onSettings={onSettings} onSignOut={onSignOut}
    primary={primary} sections={{ module: "time", role, active: tab, onSelect: (id) => go(id === "timer" ? [] : [id]) }}
    menu={writer ? [{ id: "reminders", label: "Reminders", icon: Bell, onSelect: () => setReminders(true) }] : undefined}
    className="time-home">
    {tab === "timer" && <TimerTab onOpen={onOpenPath} readOnly={!writer} focusEntry={params.get("entry")} />}
    {tab === "timesheet" && <TimesheetTab week={params.get("week")} onWeek={(week) => go(["timesheet"], week ? `?week=${week}` : "")} onOpen={onOpenPath} readOnly={!writer} />}
    {tab === "reports" && <ReportsTab onOpen={onOpenPath} userId={userId} />}
    {tab === "projects" && !projectRef && <ProjectsTab canCreate={canCreateProject} onNew={() => setNewProject(true)} onProject={(project) => go(["projects", `${slug(project.name)}-${project.shortId}`])} />}
    {tab === "projects" && projectRef && <ProjectPage key={`${projectRef}:${params.get("tab") ?? ""}`} projectId={projectRef} initialTab={params.get("tab")} onBack={() => go(["projects"])} onOpen={onOpenPath} flashMissing={() => { flash("That project is not available"); go(["projects"], "", true); }} />}
    {newProject && <ProjectSheet project={null} onClose={() => setNewProject(false)} onSaved={(project) => { setNewProject(false); go(["projects", `${slug(project.name)}-${project.shortId}`]); }} />}
    {logging && <EntrySheet entry={null} onOpen={onOpenPath} onClose={() => setLogging(false)} />}
    {reminders && <RemindersSheet onClose={() => setReminders(false)} />}
  </ModuleHome>;
}

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";
