import { useEffect, useRef } from "react";
import { Camera, FileUp, FolderUp, Upload } from "lucide-react";
import { CAMERA_ACCEPT, CAMERA_CAPTURE } from "../ui/attachments";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { chosenFolderFiles, type FolderFile } from "./uploadSources";

type UploadMenuProps = {
  destination: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Take photo (phones and tablets): the camera opens directly. */
  camera: boolean;
  /** Upload folder (browsers with a folder chooser, on desktop). */
  folder: boolean;
  onChooseFiles: () => void;
  onPhoto: (files: File[]) => void;
  onFolder: (files: Array<FolderFile<File>>) => void;
};

/**
 * The Files Upload button and its menu (uploads everywhere U6): Take photo on coarse-pointer devices,
 * Upload files, and Upload folder. The menu is a history layer like the sort menu (D69, D18): Back,
 * Esc, or a click elsewhere closes only the menu.
 */
export function UploadMenu({ destination, open, onOpenChange, camera, folder, onChooseFiles, onPhoto, onFolder }: UploadMenuProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const close = useRef(() => onOpenChange(false));
  close.current = () => onOpenChange(false);

  useEffect(() => {
    if (!open) return;
    const closeMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && event.target instanceof Element && event.target.closest(".files-upload-control")) return;
      close.current();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);
    return () => { window.removeEventListener("click", closeMenu); window.removeEventListener("keydown", closeMenu); };
  }, [open]);
  useHistoryDialogGuard(open, () => close.current());

  const pick = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return <div className="sort-control files-upload-control">
    <button className="primary-button files-upload-button" onClick={() => onOpenChange(!open)} aria-haspopup="menu" aria-expanded={open} title={`Upload to ${destination}`}><Upload /><span className="files-upload-label">Upload</span></button>
    {open && <div className="sort-menu files-upload-menu" role="menu" aria-label={`Upload to ${destination}`}>
      {camera && <button role="menuitem" onClick={() => pick(() => cameraInput.current?.click())}><span>Take photo</span><Camera aria-hidden="true" /></button>}
      <button role="menuitem" onClick={() => pick(onChooseFiles)}><span>{camera ? "Choose files" : "Upload files"}</span><FileUp aria-hidden="true" /></button>
      {folder && <button role="menuitem" onClick={() => pick(() => folderInput.current?.click())}><span>Upload folder</span><FolderUp aria-hidden="true" /></button>}
    </div>}
    {camera && <input ref={cameraInput} type="file" accept={CAMERA_ACCEPT} capture={CAMERA_CAPTURE} hidden tabIndex={-1} data-upload-input="camera"
      onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) onPhoto(files); }} />}
    {folder && <input ref={folderInput} type="file" multiple hidden tabIndex={-1} data-upload-input="folder" {...{ webkitdirectory: "" }}
      onChange={(event) => { const files = chosenFolderFiles(event.currentTarget.files); event.currentTarget.value = ""; if (files.length) onFolder(files); }} />}
  </div>;
}
