import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { KeysDialog } from "../keys/KeysDialog";
import "../keys/keys.css";

/** The saved-file text: one code per line, with a short header (no account details). */
export function recoveryCodesText(codes: readonly string[]) {
  return `Nook recovery codes\nEach code works once, in place of the six-digit authenticator code.\n\n${codes.join("\n")}\n`;
}

/**
 * Q4 (Wave 35 final round): right after two-factor is turned on, the new recovery codes stay on
 * screen in their own dialog until the person says they saved them. Settings stays open meanwhile;
 * Back or Escape closes only this dialog (the codes stay visible under Security).
 */
export function RecoveryCodesDialog({ codes, onSaved, onClose }: { codes: readonly string[]; onSaved: () => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([recoveryCodesText(codes)], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "nook-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  };
  const footer = <>
    <button key="copy" type="button" className="secondary-button recovery-action" onClick={() => { void copy(); }}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy all"}</button>
    <button key="download" type="button" className="secondary-button recovery-action" onClick={download}><Download aria-hidden="true" />{downloaded ? "Downloaded" : "Download"}</button>
    <button key="saved" type="button" className="primary-button recovery-action" onClick={onSaved}><Check aria-hidden="true" />I saved them</button>
  </>;
  return <KeysDialog title="Save your recovery codes" description="Two-factor authentication is on. Keep these codes somewhere safe: each one signs you in once if you lose your authenticator app. They are shown again only after you confirm with a fresh code." onClose={onClose} footer={footer}>
    <div className="recovery-codes recovery-codes-dialog">
      <div className="recovery-code-grid">{codes.map((code) => <code key={code}>{code}</code>)}</div>
    </div>
  </KeysDialog>;
}
