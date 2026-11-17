import { useCallback, useEffect, useRef, type FormEvent } from "react";
import { api } from "../api";
import { errorText, notify } from "../ui/notify";

/**
 * Renaming a Notes or Files folder in place (D1300, D1302). Notes and Files share the folders, and the
 * server lets only the owner rename an ordinary folder (PATCH /api/folders/:id): never Default, never
 * the Attachments folder, never someone else's (an edit share edits the folder's notes and files, not
 * the folder). The UI offers Rename by the same rule, so nobody is shown an action that is refused.
 */

export const FOLDER_NAME_MAX = 120;

export type RenamableFolder = { id: string; name: string; is_owner: number; is_default: number; system_kind?: string | null };

export function canRenameFolder(folder: RenamableFolder, canWrite: boolean) {
  return canWrite && folder.is_owner === 1 && folder.is_default !== 1 && !folder.system_kind;
}

/** What a typed name becomes: trimmed; null when nothing would change (blank, or the same name). */
export function nextFolderName(typed: string, current: string): string | null {
  const name = typed.trim().slice(0, FOLDER_NAME_MAX);
  return name && name !== current ? name : null;
}

export const renameFolderRequest = (id: string, name: string) =>
  api<{ folder: { id: string; name: string } }>(`/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });

/** The new name on one folder of a list. */
export const withFolderName = <F extends { id: string; name: string }>(folders: readonly F[], id: string, name: string): F[] =>
  folders.map((folder) => folder.id === id ? { ...folder, name } : folder);

/** Undo an optimistic rename, unless something newer already renamed the folder again. */
export const rollbackFolderName = <F extends { id: string; name: string }>(folders: readonly F[], id: string, attempted: string, previous: string): F[] =>
  folders.map((folder) => folder.id === id && folder.name === attempted ? { ...folder, name: previous } : folder);

/**
 * Optimistic rename: the list shows the new name at once; the server's (trimmed) name replaces it;
 * a refusal puts the old name back and says why in an error toast. `update` changes the app's list.
 */
export function useFolderRename<F extends { id: string; name: string }>(update: (change: (folders: F[]) => F[]) => void) {
  const updateRef = useRef(update);
  updateRef.current = update;
  return useCallback((folder: F, typed: string) => {
    const name = nextFolderName(typed, folder.name);
    if (name === null) return Promise.resolve(false);
    const previous = folder.name;
    updateRef.current((folders) => withFolderName(folders, folder.id, name));
    return renameFolderRequest(folder.id, name).then(({ folder: saved }) => {
      if (saved?.name && saved.name !== name) updateRef.current((folders) => folders.map((item) => item.id === folder.id && item.name === name ? { ...item, name: saved.name } : item));
      return true;
    }, (reason: unknown) => {
      updateRef.current((folders) => rollbackFolderName(folders, folder.id, name, previous));
      notify.error(errorText(reason, "Could not rename the folder"));
      return false;
    });
  }, []);
}

type FieldProps = {
  /** The folder's name now (the field starts with it, selected). */
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
};

/**
 * The inline rename field that takes a folder row's place: Enter or leaving the field saves, Escape
 * cancels (and goes no further, so the drawer or a sheet around it stays open). A blank or unchanged
 * name saves nothing. A form with noValidate: the length is capped by maxLength, the rest by the server.
 */
export function InlineRenameField({ name, onSave, onCancel, className }: FieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  const finishRef = useRef<(save: boolean) => void>(() => undefined);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return undefined;
    input.focus();
    input.select();
    // Escape is caught natively, before the phone drawer's own (native) Escape that would close it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishRef.current(false);
    };
    input.addEventListener("keydown", onKeyDown);
    return () => input.removeEventListener("keydown", onKeyDown);
  }, []);
  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const typed = inputRef.current?.value ?? name;
    if (save && nextFolderName(typed, name) !== null) onSave(typed);
    else onCancel();
  };
  finishRef.current = finish;
  return <form className={`folder-rename${className ? ` ${className}` : ""}`} noValidate
    onSubmit={(event: FormEvent) => { event.preventDefault(); finish(true); }}>
    <input ref={inputRef} type="text" defaultValue={name} maxLength={FOLDER_NAME_MAX} aria-label={`Rename folder ${name}`} autoComplete="off" spellCheck={false}
      // Keys typed here are the field's (Escape is handled natively above).
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)} />
  </form>;
}
