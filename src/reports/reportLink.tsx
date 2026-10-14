import { useEffect, useId, useRef, useState } from "react";
import { Copy, Link2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { formatRoute } from "../router";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { reportsRoute } from "../reportsRoute";

/** The report's canonical URL: the app's origin and the report route, as the address bar shows it. */
export const reportLink = (reportId: string, origin = window.location.origin) => `${origin}${formatRoute(reportsRoute(reportId))}`;

export const LINK_COPIED = "Link copied. Only people the report is shared with can open it.";

/** Copies text; false when the browser refuses (an insecure context, a denied permission, no clipboard). */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard): Promise<boolean> {
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy the link, then say so; when the clipboard refuses, `onFallback` shows the link to copy by hand. */
export async function copyReportLink(url: string, options: { flash: (message: string) => void; onFallback: () => void; clipboard?: Pick<Clipboard, "writeText"> }): Promise<boolean> {
  const copied = await copyText(url, options.clipboard);
  if (copied) options.flash(LINK_COPIED);
  else options.onFallback();
  return copied;
}

/**
 * The link row (Share panel, and the link sheet for readers): the URL in a read-only field and a Copy
 * button. With `selectFirst` (the clipboard refused) the field is selected and the row says so.
 */
export function CopyLinkRow({ url, selectFirst, flash }: { url: string; selectFirst: boolean; flash: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [manual, setManual] = useState(selectFirst);
  useEffect(() => { if (selectFirst) { input.current?.focus(); input.current?.select(); } }, [selectFirst]);
  return <div className="report-link-row">
    <label htmlFor={id}><Link2 aria-hidden="true" />Link to this report</label>
    <div className="report-link-field">
      <input id={id} ref={input} readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="secondary-button" onClick={() => { void copyReportLink(url, { flash, onFallback: () => { setManual(true); input.current?.focus(); input.current?.select(); } }); }}><Copy aria-hidden="true" />Copy</button>
    </div>
    {manual && <p className="file-dialog-hint" role="status">Copy the link above: the browser did not let Nook copy it.</p>}
  </div>;
}

/** Readers' fallback when the clipboard refuses: the link in a small sheet, selected. */
export function LinkSheet({ url, title, onClose, flash }: { url: string; title: string; onClose: () => void; flash: (message: string) => void }) {
  useHistoryDialogGuard(true, onClose);
  return <ModalDialog title="Copy link" eyebrow={title} onClose={onClose} variant="sheet" className="reports-dialog report-link-sheet">
    <div className="report-edit-sheet-body"><CopyLinkRow url={url} selectFirst flash={flash} /></div>
  </ModalDialog>;
}
