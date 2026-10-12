import { createElement, type ReactNode } from "react";
import { toast, type ExternalToast } from "sonner";

/**
 * Nook's toasts (docs/ARCHITECTURE.md, "Toasts"): a thin layer over Sonner, whose one <Toaster> is
 * mounted at the app root (ui/AppToaster.tsx).
 *
 * - success: a change went through (saved, published, moved to the Bin, shared, copied, uploaded).
 * - info: neutral news (the old `flash`), such as "Published in another window".
 * - warning: Nook refused, or only part went through (no permission, a limit, a stale copy).
 * - error: something failed (an API error, an upload that failed). Errors stay until dismissed,
 *   with a close button, and are announced assertively; the others are announced politely.
 */
export type NotifyKind = "success" | "info" | "warning" | "error";

export type NotifyAction = { label: string; onClick: () => void };

export type NotifyOptions = {
  /** One button on the toast, such as Undo. Clicking it closes the toast. */
  action?: NotifyAction;
  /** Milliseconds; `Infinity` keeps the toast until it is dismissed. */
  duration?: number;
  /** The message is text to copy by hand (a link): it can be selected, so the toast is not swiped. */
  selectable?: boolean;
  /** Replaces an earlier toast with the same id instead of stacking a new one. */
  id?: string | number;
};

/** Default durations. A toast with an action stays long enough to reach it. */
export const TOAST_DURATION: Record<NotifyKind, number> = { success: 4000, info: 4000, warning: 6000, error: Infinity };
export const ACTION_DURATION = 10000;
export const SELECTABLE_DURATION = 15000;

function durationFor(kind: NotifyKind, options: NotifyOptions) {
  if (options.duration !== undefined) return options.duration;
  if (kind === "error") return TOAST_DURATION.error;
  if (options.selectable) return SELECTABLE_DURATION;
  if (options.action) return Math.max(ACTION_DURATION, TOAST_DURATION[kind]);
  return TOAST_DURATION[kind];
}

function show(kind: NotifyKind, message: string, options: NotifyOptions = {}) {
  // Sonner's region is polite; an error's text sits in its own role="alert" so it is read at once.
  const title: ReactNode = kind === "error" ? createElement("span", { role: "alert" }, message) : message;
  const data: ExternalToast = {
    // The same message again replaces the toast on screen instead of stacking a copy of it.
    id: options.id ?? `${kind}:${message}`,
    duration: durationFor(kind, options),
    closeButton: kind === "error" ? true : undefined,
    className: options.selectable ? "toast-selectable" : undefined,
    dismissible: options.selectable ? false : undefined
  };
  if (options.action) {
    const { label, onClick } = options.action;
    data.action = { label, onClick: () => onClick() };
  }
  return toast[kind](title, data);
}

export const notify = {
  success: (message: string, options?: NotifyOptions) => show("success", message, options),
  info: (message: string, options?: NotifyOptions) => show("info", message, options),
  warning: (message: string, options?: NotifyOptions) => show("warning", message, options),
  error: (message: string, options?: NotifyOptions) => show("error", message, options),
  dismiss: (id?: string | number) => { toast.dismiss(id); }
};

/**
 * What a module hands its views as a `notify` prop (Tasks, Collections): the typed methods, and,
 * for older call sites, a plain call `notify(message, action?, options?)`, which is neutral (info).
 */
export type LegacyAction = { label: string; run: () => void };
export type Notifier = ((message: string, action?: LegacyAction, options?: { selectable?: boolean }) => void) & {
  success: (message: string, options?: NotifyOptions) => void;
  info: (message: string, options?: NotifyOptions) => void;
  warning: (message: string, options?: NotifyOptions) => void;
  error: (message: string, options?: NotifyOptions) => void;
};

export const notifier: Notifier = Object.assign(
  (message: string, action?: LegacyAction, options?: { selectable?: boolean }) => {
    notify.info(message, { action: action ? { label: action.label, onClick: action.run } : undefined, selectable: options?.selectable });
  },
  {
    success: (message: string, options?: NotifyOptions) => { notify.success(message, options); },
    info: (message: string, options?: NotifyOptions) => { notify.info(message, options); },
    warning: (message: string, options?: NotifyOptions) => { notify.warning(message, options); },
    error: (message: string, options?: NotifyOptions) => { notify.error(message, options); }
  }
);

/** Where a shared component (the note editor) sends its notices: `notify`, or a module's Notifier. */
export type NoticeSink = Record<NotifyKind, (message: string, options?: NotifyOptions) => unknown>;

/** The message of a caught value, or `fallback` (for `notify.error(errorText(reason, "Could not …"))`). */
export function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * The app's original one-line toast, kept for the call sites (and `flash` props) not yet given a
 * type: always neutral. A success, error or refusal calls `notify.success / error / warning`.
 */
export function flash(message: string) {
  notify.info(message);
}
