/**
 * The attach kit (uploads everywhere plan D398), for module slices U1–U7. Import from here only;
 * changes to these files go back to the kit's owner (plan §6 "Parallel safety").
 */
export { AttachSheet, FromFilesSheet, coarsePointer, fromFilesConfirm, CAMERA_ACCEPT, CAMERA_CAPTURE, type AttachSheetProps } from "./AttachSheet";
export { AttachmentList, showsThumbnail, THUMBNAIL_MAX_BYTES } from "./AttachmentList";
export { AttachmentPreview } from "./AttachmentPreview";
export { useFileDrop, dragHasFiles } from "./useFileDrop";
export { usePasteFiles, pastedFiles } from "./usePasteFiles";
export { stripImageLocation, stripJpegMetadata } from "./exif";
export { uploadForHost, listHostAttachments, linkToHost, unlinkFromHost, fileUsage, usageSummary, type HostKind, type HostAttachment, type FileUsage, type UploadForHostOptions } from "./uploadForHost";
