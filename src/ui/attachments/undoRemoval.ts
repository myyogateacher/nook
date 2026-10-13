import { errorText, notify, type NotifyOptions } from "../notify";

/** Where the removal toast goes: `notify`, or a module's Notifier. */
export type RemovalSink = { success: (message: string, options?: NotifyOptions) => unknown; error: (message: string, options?: NotifyOptions) => unknown };

/**
 * The toast after a file was removed from an event, a card, or a row: with Undo when `undo` is given
 * (it puts the file back through POST /api/attachments/relink, then the host refreshes). Without
 * `undo` (the person cannot edit the host, or the file went to someone else's Bin) it is a plain
 * success. A failed Undo says why.
 */
export function notifyRemoved(message: string, undo: (() => Promise<unknown>) | null, sink: RemovalSink = notify) {
  if (!undo) {
    sink.success(message);
    return;
  }
  sink.success(message, {
    action: {
      label: "Undo",
      onClick: () => {
        undo().then(() => { sink.success("File put back"); }, (reason: unknown) => { sink.error(errorText(reason, "Could not put the file back")); });
      }
    }
  });
}
