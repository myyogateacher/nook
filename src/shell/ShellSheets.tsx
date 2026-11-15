import { Fragment, useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Pin, type LucideIcon } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { shortcutKeys, type ShortcutGroup } from "./shortcuts";
import { arrangeApps, setAppPinned, stepApp, type AppsLayout } from "./sidebarPrefs";
import "../files/files.css";
import "./palette.css";

/** The "?" sheet (D1296): every group of shortcuts, each key in its own <kbd>. */
export function ShortcutSheet({ groups, onClose }: { groups: readonly ShortcutGroup[]; onClose: () => void }) {
  return <ModalDialog title="Keyboard shortcuts" onClose={onClose} variant="sheet" className="shell-sheet shortcut-sheet">
    <div className="shell-sheet-body">
      {groups.map((group) => <section key={group.id} className="shortcut-group" aria-labelledby={`shortcut-group-${group.id}`}>
        <h3 id={`shortcut-group-${group.id}`}>{group.label}</h3>
        <dl className="shortcut-list">
          {group.rows.map((row) => <div key={`${row.keys}:${row.label}`} className="shortcut-row">
            <dt>{shortcutKeys(row.keys).map((part, index) => "key" in part ? <kbd key={index}>{part.key}</kbd> : <Fragment key={index}>{part.text}</Fragment>)}</dt>
            <dd>{row.label}</dd>
          </div>)}
        </dl>
      </section>)}
    </div>
  </ModalDialog>;
}

/** One app the Customize sheet lists: shown in the sidebar or turned off (Settings → Modules). */
export type CustomizeApp = { id: string; label: string; icon: LucideIcon; shown: boolean };

export type CustomizeSidebarProps = {
  /** Every app this person could have in the sidebar (off ones included), in any order. */
  apps: readonly CustomizeApp[];
  layout: AppsLayout;
  onLayout: (layout: Required<AppsLayout>) => void;
  /** Turns the app's module on or off (Settings → Modules: the one hide mechanism). */
  onShown: (id: string, shown: boolean) => void;
  onClose: () => void;
};

/**
 * Customize sidebar (D1294): the keyboard and touch path for what dragging does. Every app this
 * person can have, Pinned first: Move up and Move down within its group, Pin or Unpin, and Show,
 * which is Settings → Modules' own switch (turning an app off there and here is the same thing).
 * Reset puts every app back in its default place and unpins them.
 */
export function CustomizeSidebar({ apps, layout, onLayout, onShown, onClose }: CustomizeSidebarProps) {
  const { pinned, rest } = arrangeApps(apps, layout, (app) => app.id);
  const shown = [...pinned, ...rest].map((app) => app.id);
  const bodyRef = useRef<HTMLDivElement>(null);
  // After a move the row is drawn elsewhere: focus stays on the button that moved it (or its twin at an end).
  const refocus = useRef<{ id: string; action: "up" | "down" | "pin" } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    const row = bodyRef.current?.querySelector<HTMLElement>(`[data-app="${want.id}"]`);
    const button = row?.querySelector<HTMLButtonElement>(`[data-action="${want.action}"]:not(:disabled)`)
      ?? row?.querySelector<HTMLButtonElement>(`[data-action="${want.action === "up" ? "down" : "up"}"]:not(:disabled)`)
      ?? row?.querySelector<HTMLButtonElement>('[data-action="pin"]');
    button?.focus();
  });
  const step = (id: string, delta: -1 | 1) => { const next = stepApp(layout, shown, id, delta); if (next) { refocus.current = { id, action: delta < 0 ? "up" : "down" }; onLayout(next); } };
  const pin = (id: string, value: boolean) => { refocus.current = { id, action: "pin" }; onLayout(setAppPinned(layout, shown, id, value)); };

  const row = (app: CustomizeApp, group: readonly CustomizeApp[], isPinned: boolean) => {
    const Icon = app.icon;
    const at = group.indexOf(app);
    return <li key={app.id} data-app={app.id} className={`customize-row${app.shown ? "" : " is-hidden"}`}>
      <Icon aria-hidden="true" />
      <span className="customize-name" id={`customize-${app.id}`}>{app.label}</span>
      <span className="customize-actions">
        <button type="button" data-action="up" aria-label={`Move ${app.label} up`} title="Move up" disabled={at === 0} onClick={() => step(app.id, -1)}><ArrowUp aria-hidden="true" /></button>
        <button type="button" data-action="down" aria-label={`Move ${app.label} down`} title="Move down" disabled={at === group.length - 1} onClick={() => step(app.id, 1)}><ArrowDown aria-hidden="true" /></button>
        <button type="button" data-action="pin" aria-pressed={isPinned} aria-label={`Pin ${app.label}`} title={isPinned ? "Unpin" : "Pin to the top"} onClick={() => pin(app.id, !isPinned)}><Pin aria-hidden="true" /></button>
        <label className="customize-show"><input type="checkbox" checked={app.shown} aria-describedby="customize-hide-note" onChange={(event) => onShown(app.id, event.target.checked)} aria-label={`Show ${app.label}`} /><span aria-hidden="true">Show</span></label>
      </span>
    </li>;
  };

  return <ModalDialog title="Customize sidebar" onClose={onClose} variant="sheet" className="shell-sheet customize-sheet">
    <div ref={bodyRef} className="shell-sheet-body">
      <p className="customize-note">Drag apps in the sidebar, or use the arrows here. Pinned apps stay at the top of the list. Your layout follows you to your other devices.</p>
      <section className="customize-group" aria-labelledby="customize-pinned">
        <h3 id="customize-pinned">Pinned</h3>
        {pinned.length ? <ul className="customize-list" aria-labelledby="customize-pinned">{pinned.map((app) => row(app, pinned, true))}</ul>
          : <p className="customize-empty">Nothing pinned. Use the pin beside an app to keep it at the top.</p>}
      </section>
      <section className="customize-group" aria-labelledby="customize-apps">
        <h3 id="customize-apps">Apps</h3>
        <ul className="customize-list" aria-labelledby="customize-apps">{rest.map((app) => row(app, rest, false))}</ul>
      </section>
      <p className="customize-note" id="customize-hide-note">Hiding an app turns it off for you, as in Settings → Modules. It stays available to everyone else, and you can turn it back on here or there.</p>
      <div className="customize-foot">
        <button type="button" className="secondary-button" onClick={() => onLayout({ order: [], pinned: [] })} disabled={!layout.order?.length && !layout.pinned?.length}>Reset order and pins</button>
        <button type="button" className="primary-button" onClick={onClose}>Done</button>
      </div>
    </div>
  </ModalDialog>;
}
