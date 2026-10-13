import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";

/**
 * The report page's header actions (wave 48 integration): Refresh all and Schedule belong to the
 * viewer (ReportView), Check doc and Regenerate to the generation part (ReportGeneration), but the
 * page header shows them. Each part registers what it can do here; the header calls it. Without a
 * provider (tests, other hosts) the parts show their own buttons as before.
 */
export type ReportCommands = {
  refreshAll?: { run: () => void; busy: boolean; disabled: boolean } | null;
  schedule?: { open: () => void; badge: string | null } | null;
  checkDoc?: { run: () => void; busy: boolean } | null;
  regenerate?: { run: () => void; busy: boolean } | null;
};
type Registry = { set: (part: Partial<ReportCommands>) => void };

export const ReportCommandsContext = createContext<Registry | null>(null);

/** Whether the page header shows this part's actions (a provider is present). */
export const useHeaderActions = () => useContext(ReportCommandsContext) !== null;

/**
 * Registers a part's commands while it is mounted. `run` callbacks are read through a ref, so only
 * the flags (busy, disabled, the badge) re-render the header.
 */
export function useRegisterReportCommands(part: ReportCommands, keys: Array<keyof ReportCommands>) {
  const registry = useContext(ReportCommandsContext);
  const latest = useRef(part);
  latest.current = part;
  const flags = JSON.stringify(keys.map((key) => {
    const value = part[key];
    return value ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function")) : null;
  }));
  useEffect(() => {
    if (!registry) return;
    const next: Partial<ReportCommands> = {};
    for (const key of keys) {
      const value = latest.current[key];
      if (!value) { next[key] = null; continue; }
      const stable = { ...value } as Record<string, unknown>;
      for (const [name, item] of Object.entries(value)) {
        if (typeof item === "function") stable[name] = () => (latest.current[key] as Record<string, () => void> | null | undefined)?.[name]?.();
      }
      (next as Record<string, unknown>)[key] = stable;
    }
    registry.set(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, flags]);
  useEffect(() => () => {
    if (!registry) return;
    registry.set(Object.fromEntries(keys.map((key) => [key, null])) as Partial<ReportCommands>);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);
}

export type MenuItem = { id: string; label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; /** Shown in the menu on a phone only (the header shows it on wider screens). */ narrowOnly?: boolean };

/**
 * The "⋯" overflow menu: a menu button with arrow-key, Home/End, and Escape handling; Back, Escape, or
 * a click elsewhere closes only the menu (a history layer, D69); every item is at least 44 px tall.
 */
export function ReportOverflowMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const visibleItems = () => [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])].filter((item) => item.getClientRects().length > 0);
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useHistoryDialogGuard(open, () => closeRef.current(false));
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event: MouseEvent) => { if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) closeRef.current(false); };
    window.addEventListener("click", onClick);
    // Focus the first item shown (the phone-only ones are hidden on wider screens) when the menu opens.
    visibleItems()[0]?.focus();
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = visibleItems();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (index: number) => { event.preventDefault(); list[(index + list.length) % list.length]?.focus(); };
    if (event.key === "ArrowDown") focus(at + 1);
    else if (event.key === "ArrowUp") focus(at - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(list.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") setOpen(false);
  };
  if (!items.length) return null;
  // Only phone-only items (a reader's Schedule): wider screens show them in the header, so no menu there.
  const narrowOnly = items.every((item) => item.narrowOnly);
  return <div className={`report-overflow${narrowOnly ? " report-narrow-only-menu" : ""}`} ref={rootRef}>
    <button ref={buttonRef} type="button" className="secondary-button report-overflow-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={label} title={label}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (!open) setOpen(true);
        else (event.key === "ArrowDown" ? visibleItems()[0] : visibleItems().at(-1))?.focus();
      }}>
      <MoreHorizontal aria-hidden="true" />
    </button>
    {open && <div id={menuId} className="report-overflow-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => <button key={item.id} type="button" role="menuitem" disabled={item.disabled}
        className={`${item.danger ? "report-overflow-danger" : ""}${item.narrowOnly ? " report-narrow-only" : ""}${item.danger && index > 0 ? " report-overflow-separated" : ""}`.trim() || undefined}
        onClick={() => { setOpen(false); item.onSelect(); }}>
        {item.icon}<span>{item.label}</span>
      </button>)}
    </div>}
  </div>;
}
