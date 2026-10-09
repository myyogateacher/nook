import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { isNoteImageSrc } from "./imageUpload";

/**
 * The note editor's attach commands (uploads everywhere U4): the slash menu's "File" opens the
 * shared attach sheet (Take photo, Choose files, From Files) and "From Files" opens the picker of the
 * person's own files directly. The editor's host shows the sheets; this only asks for them.
 */

/** Files per note (Q11, D400): the server links at most this many on publish. */
export const NOTE_FILE_LIMIT = 100;
export const NOTE_FILE_LIMIT_MESSAGE = `A note can hold up to ${NOTE_FILE_LIMIT} files and images`;

const imageId = (src: unknown) => isNoteImageSrc(src) ? /\/api\/files\/([0-9a-f-]{36})\//i.exec(src)![1]!.toLowerCase() : null;

/** The distinct files a note's content uses: its images and its file cards. */
export function noteFileIds(doc: ProseMirrorNode) {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "image") {
      const id = imageId(node.attrs.src);
      if (id) ids.add(id);
    } else if (node.type.name === "fileChip" && typeof node.attrs.id === "string") {
      ids.add(node.attrs.id.toLowerCase());
    }
    return true;
  });
  return ids;
}

/** How many more files fit (never below zero). */
export const noteFileRoom = (editor: Editor) => Math.max(0, NOTE_FILE_LIMIT - noteFileIds(editor.state.doc).size);

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    noteAttach: {
      /** Opens the attach sheet (the editor's host shows it). */
      openAttachSheet: () => ReturnType;
      /** Opens the From Files picker. */
      openFromFiles: () => ReturnType;
    };
  }
}

export const NoteAttach = Extension.create<{ onOpen: (editor: Editor, what: "sheet" | "files") => void }>({
  name: "noteAttach",
  addOptions() {
    return { onOpen: () => undefined };
  },
  addCommands() {
    return {
      openAttachSheet: () => ({ editor }) => {
        this.options.onOpen(editor, "sheet");
        return true;
      },
      openFromFiles: () => ({ editor }) => {
        this.options.onOpen(editor, "files");
        return true;
      }
    };
  }
});
