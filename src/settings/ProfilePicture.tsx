import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Camera, ImagePlus, Trash2, UserRound } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Avatar } from "../ui/Avatar";
import { CAMERA_ACCEPT, CAMERA_CAPTURE, coarsePointer, useFileDrop } from "../ui/attachments";
import { setSelfAvatar, useSelfAvatar } from "../ui/selfAvatar";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { errorText, notify } from "../ui/notify";
import { GoogleMark } from "../auth/googleSignIn";
import {
  AVATAR_MAX_ZOOM, AVATAR_OUTPUT_SIZE, avatarSourceLine, blobToBase64, changeAvatar, cropRect, decodePicture, initialCrop, loadAvatarState, panCrop, renderAvatar, zoomCrop,
  type AvatarState, type Crop, type DecodedPicture
} from "./avatarCrop";
import "../files/files.css";
import "../ui/attachments/attachments.css";
import "./profilePicture.css";

const PICTURE_ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * Settings → Security → Profile picture (uploads everywhere U7). Change picture opens a sheet (Take
 * photo on phones, Choose a picture, Use my Google picture when Google sign-in is linked, Remove);
 * a picture dropped on the card opens the crop too. The crop is a square with zoom and drag; Save
 * draws it at 512 px and uploads the new encoding, so nothing from the original file is kept. The
 * sheet and the crop are history layers: Back closes them (D18, D21). The new picture shows at once
 * wherever the app draws the signed-in person (selfAvatar), and other people's lists pick up its new
 * URL on their next load.
 */
export function ProfilePictureCard({ name }: { name: string }) {
  const [state, setState] = useState<AvatarState | null>(null);
  const [sheet, setSheet] = useState(false);
  const [picture, setPicture] = useState<DecodedPicture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selfUrl = useSelfAvatar();

  useEffect(() => {
    let live = true;
    loadAvatarState().then((result) => { if (live) setState(result); }).catch(() => { if (live) setError("Could not load your picture settings."); });
    return () => { live = false; };
  }, []);

  const applied = (result: AvatarState, done: string) => {
    setState(result);
    setSelfAvatar(result.avatarUrl);
    notify.success(done);
  };

  const openFile = useCallback(async (files: File[]) => {
    const file = files[0];
    setSheet(false);
    if (!file) return;
    setError("");
    try {
      setPicture(await decodePicture(file));
    } catch (reason) {
      notify.warning(errorText(reason, "This picture could not be opened."));
    }
  }, []);

  const closeCrop = useCallback(() => {
    setPicture((current) => { current?.close(); return null; });
    setError("");
  }, []);

  async function run(action: () => Promise<AvatarState>, done: string, failed: string) {
    setBusy(true);
    setError("");
    try {
      applied(await action(), done);
      return true;
    } catch (reason) {
      // The crop dialog shows its own error; otherwise (Google picture, Remove) it is a toast.
      if (picture) setError(errorText(reason, failed));
      else notify.error(errorText(reason, failed));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(crop: Crop) {
    if (!picture) return;
    const ok = await run(async () => changeAvatar({ source: "upload", image: await blobToBase64(await renderAvatar(picture, crop)) }), "Your picture is saved.", "Could not save your picture.");
    if (ok) closeCrop();
  }

  const useGoogle = () => { setSheet(false); void run(() => changeAvatar({ source: "google" }), "Your Google picture is back.", "Could not use your Google picture."); };
  const remove = () => { setSheet(false); void run(() => changeAvatar({ source: "none" }), "Your picture is removed. Your initial shows instead.", "Could not remove your picture."); };

  const drop = useFileDrop((files) => void openFile(files), { enabled: !busy && !picture && !sheet });
  const url = state ? state.avatarUrl : selfUrl;

  return <section className={`security-card profile-picture-card${drop.dragging ? " dragging" : ""}`} aria-labelledby="profile-picture-heading" {...drop.bind}>
    <div className="profile-picture-summary">
      <Avatar className="app-user-avatar profile-picture-avatar" name={name} url={url} />
      <div>
        <strong id="profile-picture-heading" role="heading" aria-level={4}>Profile picture</strong>
        <small>{avatarSourceLine(state)} Everyone who can see your name sees it.</small>
      </div>
      <button type="button" className="secondary-button" onClick={() => setSheet(true)} disabled={busy || !state} aria-haspopup="dialog"><ImagePlus aria-hidden="true" />Change picture</button>
    </div>
    {drop.dragging && <p className="profile-picture-drop" aria-hidden="true">Drop a picture to crop it</p>}
    {busy && !picture && <p className="recognised-devices-empty" role="status">Saving…</p>}
    {error && !picture && <p className="form-error" role="alert">{error}</p>}
    {sheet && state && <ProfilePictureSheet state={state} onClose={() => setSheet(false)} onFiles={(files) => void openFile(files)} onUseGoogle={useGoogle} onRemove={remove} />}
    {picture && <AvatarCropDialog picture={picture} busy={busy} error={error} onCancel={closeCrop} onSave={(crop) => void save(crop)} />}
  </section>;
}

/** The choices for a new picture (D91: the app's own sheet; the system pickers sit behind its buttons). */
export function ProfilePictureSheet({ state, onClose, onFiles, onUseGoogle, onRemove, camera = coarsePointer() }: {
  state: AvatarState;
  onClose: () => void;
  onFiles: (files: File[]) => void;
  onUseGoogle: () => void;
  onRemove: () => void;
  camera?: boolean;
}) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  useHistoryDialogGuard(true, onClose);
  const take = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) onFiles(files);
  };
  const googleOffered = state.google.linked && state.google.hasPicture && state.source !== "google";
  return <ModalDialog title="Profile picture" eyebrow="Your account" onClose={onClose} className="attach-sheet profile-picture-sheet">
    <div className="attach-sheet-actions" role="group" aria-label="Picture choices">
      {camera && <button type="button" className="action-button secondary attach-sheet-action" onClick={() => cameraInput.current?.click()}><Camera aria-hidden="true" />Take photo</button>}
      <button type="button" className="action-button secondary attach-sheet-action" onClick={() => filesInput.current?.click()}><ImagePlus aria-hidden="true" />Choose a picture</button>
      {googleOffered && <button type="button" className="action-button secondary attach-sheet-action" onClick={onUseGoogle}><GoogleMark />Use my Google picture</button>}
      {state.source !== "none" && <button type="button" className="action-button secondary attach-sheet-action" onClick={onRemove}><Trash2 aria-hidden="true" />Remove picture</button>}
    </div>
    {camera && <input ref={cameraInput} className="attach-sheet-input" type="file" accept={CAMERA_ACCEPT} capture={CAMERA_CAPTURE} tabIndex={-1} aria-hidden="true" data-avatar-input="camera" onChange={(event) => take(event.currentTarget)} />}
    <input ref={filesInput} className="attach-sheet-input" type="file" accept={PICTURE_ACCEPT} tabIndex={-1} aria-hidden="true" data-avatar-input="files" onChange={(event) => take(event.currentTarget)} />
    <p className="attach-sheet-note">You crop it to a square next. It is saved at {AVATAR_OUTPUT_SIZE} px as a new image, so the photo's location and camera details are not kept.{state.google.linked ? " A picture you choose here stays when you sign in with Google." : ""}</p>
  </ModalDialog>;
}

/** The square crop with zoom: drag (or arrow keys) to move, the slider (or + and −, or the wheel) to zoom. */
export function AvatarCropDialog({ picture, busy, error, onCancel, onSave }: { picture: Pick<DecodedPicture, "source" | "width" | "height">; busy: boolean; error: string; onCancel: () => void; onSave: (crop: Crop) => void }) {
  const { width, height } = picture;
  const [crop, setCrop] = useState<Crop>(() => initialCrop(width, height));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const zoomId = useId();
  useHistoryDialogGuard(true, onCancel, { blocked: busy });

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const stage = canvas.getBoundingClientRect().width || 280;
    const pixels = Math.round(stage * Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== pixels) { canvas.width = pixels; canvas.height = pixels; }
    const rect = cropRect(width, height, crop);
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, pixels, pixels);
    context.drawImage(picture.source, rect.x, rect.y, rect.side, rect.side, 0, 0, pixels, pixels);
  }, [crop, height, picture.source, width]);

  const stageWidth = () => canvasRef.current?.getBoundingClientRect().width ?? 280;
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const last = drag.current;
    if (!last || last.id !== event.pointerId) return;
    drag.current = { ...last, x: event.clientX, y: event.clientY };
    setCrop((current) => panCrop(width, height, current, event.clientX - last.x, event.clientY - last.y, stageWidth()));
  };
  const endDrag = () => { drag.current = null; };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const step = 12;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key]!;
      setCrop((current) => panCrop(width, height, current, dx, dy, stageWidth()));
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      setCrop((current) => zoomCrop(width, height, current, current.zoom + (event.key === "-" ? -0.25 : 0.25)));
    }
  };

  return <ModalDialog title="Crop your picture" eyebrow="Profile picture" onClose={onCancel} busy={busy} className="avatar-crop-dialog">
    <div className="avatar-crop-body">
      <div className="avatar-crop-stage">
        <canvas
          ref={canvasRef}
          className="avatar-crop-canvas"
          tabIndex={0}
          role="img"
          aria-label="Picture preview. Drag or use the arrow keys to move it; plus and minus zoom."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={(event) => { if (!busy) setCrop((current) => zoomCrop(width, height, current, current.zoom - event.deltaY / 400)); }}
          onKeyDown={onKeyDown}
        />
        <span className="avatar-crop-ring" aria-hidden="true" />
      </div>
      <label className="avatar-crop-zoom" htmlFor={zoomId}>
        <span>Zoom</span>
        <input id={zoomId} type="range" min={1} max={AVATAR_MAX_ZOOM} step={0.01} value={crop.zoom} disabled={busy} onChange={(event) => { const zoom = Number(event.currentTarget.value); setCrop((current) => zoomCrop(width, height, current, zoom)); }} />
      </label>
      <p className="avatar-crop-hint">The circle shows how people see it. The square is saved.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button type="button" className="primary-button" onClick={() => onSave(crop)} disabled={busy}>{busy ? "Saving…" : <><UserRound aria-hidden="true" />Save picture</>}</button>
    </footer>
  </ModalDialog>;
}
