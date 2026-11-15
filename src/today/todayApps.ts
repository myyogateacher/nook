import type { LucideIcon } from "lucide-react";
import { isModuleEnabled, MODULES, type LauncherSection, type ModuleId } from "../modules";
import { arrangeApps, type AppsLayout } from "../shell/sidebarPrefs";

export type TodayApp = { section: LauncherSection; label: string; href: string; icon: LucideIcon; module: ModuleId };

/**
 * The launcher row on Today (D50), derived from the module registry (src/modules.ts, D92): each
 * module with a `launcher` adds its tile there. The Bin, Team, and notifications are not launcher items:
 * they stay in the account row and in each app's sidebar footer.
 */
export const TODAY_APPS: TodayApp[] = MODULES.flatMap((module) => module.launcher
  ? [{ section: module.launcher.section, label: module.label, href: module.launcher.href, icon: module.icon, module: module.id }]
  : []);

/** The launcher tiles of modules that are on. */
export const enabledTodayApps = (disabled: readonly ModuleId[]) => TODAY_APPS.filter((app) => isModuleEnabled(disabled, app.module));

/** The tiles in the sidebar's order (left navigation phase 4, D1294): pinned apps first, then the rest. */
export function arrangedTodayApps(apps: readonly TodayApp[], layout: AppsLayout | null | undefined): TodayApp[] {
  const { pinned, rest } = arrangeApps(apps, layout, (app) => app.section);
  return [...pinned, ...rest];
}
