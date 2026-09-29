import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../files/Dialog";
import { whenHistorySettled } from "../historyDialogs";
import { useHistoryDialogGuard } from "./useHistoryDialogGuard";

/** What a confirm asks (D91: the app's own dialog, never the browser's native confirm). */
export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Where focus goes back to; the focused element by default (pass it when the asking control is in a closing sheet). */
  opener?: HTMLElement | null;
};

type Pending = Omit<ConfirmRequest, "opener"> & { resolve: (confirmed: boolean) => void; opener: HTMLElement | null };

/**
 * An awaitable confirm for the places that used the browser's native confirm (C1): `if (!await ask({…})) return;`.
 * The dialog is a history layer (Back or Forward is Cancel), Escape cancels, Enter confirms (the
 * confirm button has focus), and focus goes back to the control that asked when it is still there.
 * The answer arrives once the layer is gone and any history move its sentinel made has landed, so a
 * caller that navigates next never races the layer's own history clean-up.
 */
export function useConfirm(): { ask: (request: ConfirmRequest) => Promise<boolean>; confirmOpen: boolean; confirmElement: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const answerRef = useRef<{ resolve: (confirmed: boolean) => void; confirmed: boolean; opener: HTMLElement | null } | null>(null);

  const ask = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    // A second question replaces the first, which counts as cancelled.
    pendingRef.current?.resolve(false);
    const opener = request.opener !== undefined ? request.opener : typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const next = { ...request, resolve, opener };
    pendingRef.current = next;
    setPending(next);
  }), []);

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    answerRef.current = { resolve: current.resolve, confirmed, opener: current.opener };
    setPending(null);
  }, []);

  // After the layer unmounted (its sentinel release is queued in its clean-up), answer and restore focus.
  useEffect(() => {
    if (pending || !answerRef.current) return undefined;
    const answer = answerRef.current;
    answerRef.current = null;
    let cancelSettled = () => undefined as void;
    const timer = setTimeout(() => {
      cancelSettled = whenHistorySettled(() => {
        if (answer.opener?.isConnected && !answer.opener.hasAttribute("disabled")) answer.opener.focus();
        answer.resolve(answer.confirmed);
      });
    }, 0);
    return () => { clearTimeout(timer); cancelSettled(); answer.resolve(false); };
  }, [pending]);

  // Unmounted with a question open: it counts as cancelled.
  useEffect(() => () => { pendingRef.current?.resolve(false); }, []);

  const confirmElement = pending ? <ConfirmLayer key={pending.title + pending.message} request={pending} onSettle={settle} /> : null;
  return { ask, confirmOpen: pending !== null, confirmElement };
}

function ConfirmLayer({ request, onSettle }: { request: ConfirmRequest; onSettle: (confirmed: boolean) => void }) {
  const cancel = useCallback(() => onSettle(false), [onSettle]);
  useHistoryDialogGuard(true, cancel);
  return <div className="app-confirm-layer">
    <ConfirmDialog title={request.title} message={request.message} confirmLabel={request.confirmLabel} danger={request.danger} onConfirm={() => onSettle(true)} onCancel={cancel} />
  </div>;
}
