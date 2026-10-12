import { useEffect } from "react";
import { Toaster } from "sonner";
import "sonner/dist/styles.css";
import "./toasts.css";

/** Toasts stacked at once; more wait their turn (ui/notify.ts). */
export const VISIBLE_TOASTS = 3;

/**
 * Sonner pauses a toast's timer while the pointer is over the stack, not while a toast (or its Undo)
 * has keyboard focus. Focus entering the stack is reported to Sonner as the pointer entering it,
 * and focus leaving as the pointer leaving, so a focused toast does not close under the user.
 */
function usePauseOnFocus() {
  useEffect(() => {
    const stackOf = (target: EventTarget | null) => target instanceof Element ? target.closest("[data-sonner-toaster]") : null;
    const onFocusIn = (event: FocusEvent) => {
      const stack = stackOf(event.target);
      if (stack) stack.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    };
    const onFocusOut = (event: FocusEvent) => {
      const stack = stackOf(event.target);
      if (!stack || stack.contains(event.relatedTarget as Node | null)) return;
      stack.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
}

/**
 * The one toast stack, mounted once at the app root (main.tsx). Bottom-centre on a desktop; on a
 * phone (≤ 760 px) it sits above the bottom bar and the safe area (--toast-offset-bottom in
 * toasts.css). Toasts push no history entry, so Back keeps closing dialogs, never a toast.
 */
export function AppToaster() {
  usePauseOnFocus();
  return <Toaster
    theme="dark"
    position="bottom-center"
    visibleToasts={VISIBLE_TOASTS}
    gap={8}
    offset={{ bottom: "var(--toast-offset-bottom)" }}
    mobileOffset={{ bottom: "var(--toast-offset-bottom)", left: "var(--toast-offset-side)", right: "var(--toast-offset-side)" }}
    containerAriaLabel="Notifications"
    toastOptions={{ className: "nook-toast", closeButtonAriaLabel: "Dismiss" }}
  />;
}
