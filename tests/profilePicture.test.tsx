import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AVATAR_MAX_ZOOM, AVATAR_OUTPUT_SIZE, AVATAR_UPLOAD_MAX_BYTES, avatarSourceLine, blobToBase64, clampCrop, cropRect, initialCrop, looksLikeRasterPicture, outputSide, panCrop, renderAvatar, zoomCrop, type AvatarState
} from "../src/settings/avatarCrop";
import { AvatarCropDialog, ProfilePictureSheet } from "../src/settings/ProfilePicture";

/**
 * Uploads everywhere U7, the profile picture editor: the square crop with zoom and pan, the 512 px
 * re-encode, the sheet's choices, and its history layers (Back closes the sheet and the crop; the live
 * check drives them at 390 px).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const state = (over: Partial<AvatarState> = {}): AvatarState => ({ avatarUrl: null, source: "none", google: { linked: false, hasPicture: false }, ...over });

describe("crop and resize", () => {
  test("zoom 1 is the largest centred square; zoom shrinks it about the centre, within 1–4", () => {
    expect(cropRect(1200, 800, initialCrop(1200, 800))).toEqual({ x: 200, y: 0, side: 800 });
    expect(cropRect(600, 900, initialCrop(600, 900))).toEqual({ x: 0, y: 150, side: 600 });
    expect(cropRect(1200, 800, zoomCrop(1200, 800, initialCrop(1200, 800), 2))).toEqual({ x: 400, y: 200, side: 400 });
    expect(zoomCrop(100, 100, initialCrop(100, 100), 99).zoom).toBe(AVATAR_MAX_ZOOM);
    expect(zoomCrop(100, 100, initialCrop(100, 100), 0.2).zoom).toBe(1);
    expect(clampCrop(100, 100, { zoom: Number.NaN, centerX: 50, centerY: 50 }).zoom).toBe(1);
  });

  test("dragging moves the square the other way, scaled to the stage, and never past the edges", () => {
    const zoomed = zoomCrop(1000, 1000, initialCrop(1000, 1000), 2);
    // A 250 px stage shows 500 source px: dragging right 50 px moves the square 100 px left.
    expect(panCrop(1000, 1000, zoomed, 50, 0, 250)).toEqual({ zoom: 2, centerX: 400, centerY: 500 });
    expect(panCrop(1000, 1000, zoomed, 10_000, -10_000, 250)).toEqual({ zoom: 2, centerX: 250, centerY: 750 });
    // At zoom 1 on a square there is nowhere to go.
    expect(panCrop(400, 400, initialCrop(400, 400), 30, 30, 200)).toEqual(initialCrop(400, 400));
    // Zooming out after a pan pulls the square back inside.
    const panned = panCrop(1000, 1000, zoomed, 10_000, 0, 250);
    expect(cropRect(1000, 1000, zoomCrop(1000, 1000, panned, 1))).toEqual({ x: 0, y: 0, side: 1000 });
  });

  test("the output is at most 512 px and never upscaled", () => {
    expect(AVATAR_OUTPUT_SIZE).toBe(512);
    expect(outputSide({ x: 0, y: 0, side: 3000 })).toBe(512);
    expect(outputSide({ x: 0, y: 0, side: 200.4 })).toBe(200);
    expect(outputSide({ x: 0, y: 0, side: 0.2 })).toBe(1);
  });

  test("renderAvatar draws the selected square onto a fresh canvas and re-encodes it (WebP, else JPEG), within the cap", async () => {
    const draws: unknown[][] = [];
    const types: string[] = [];
    const canvas = (webp: boolean, size = 1000) => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args), imageSmoothingEnabled: false, imageSmoothingQuality: "low" }) as unknown as CanvasRenderingContext2D,
      toBlob(callback: (blob: Blob | null) => void, type?: string) {
        types.push(type!);
        const actual = type === "image/webp" && !webp ? "image/png" : type!;
        callback(new Blob([new Uint8Array(size)], { type: actual }));
      }
    });
    const picture = { source: {} as CanvasImageSource, width: 4000, height: 3000 };
    const made = canvas(true);
    const blob = await renderAvatar(picture, zoomCrop(4000, 3000, initialCrop(4000, 3000), 1), () => made);
    expect(blob.type).toBe("image/webp");
    expect([made.width, made.height]).toEqual([512, 512]);
    expect(draws[0]!.slice(1)).toEqual([500, 0, 3000, 3000, 0, 0, 512, 512]);
    // A browser that cannot write WebP (it hands back PNG) gets JPEG.
    types.length = 0;
    expect((await renderAvatar(picture, initialCrop(4000, 3000), () => canvas(false))).type).toBe("image/jpeg");
    expect(types).toEqual(["image/webp", "image/jpeg"]);
    // Too large at every quality: a readable error, never an oversized upload.
    await expect(renderAvatar(picture, initialCrop(4000, 3000), () => canvas(true, AVATAR_UPLOAD_MAX_BYTES + 1))).rejects.toThrow("small enough");
  });

  test("SVG and other markup are refused before decoding; raster pictures pass", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>";
    expect(await looksLikeRasterPicture(new File([svg], "a.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(await looksLikeRasterPicture(new File([svg], "a.png", { type: "image/png" }))).toBe(false);
    expect(await looksLikeRasterPicture(new File([svg], "a.svg", { type: "" }))).toBe(false);
    expect(await looksLikeRasterPicture(new File(["%PDF-1.7"], "a.pdf", { type: "application/pdf" }))).toBe(false);
    expect(await looksLikeRasterPicture(new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "a.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(await looksLikeRasterPicture(new File([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], "IMG_1.HEIC", { type: "image/heic" }))).toBe(true);
  });

  test("base64 of large blobs survives chunking", async () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
    expect(await blobToBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("the sheet and the crop dialog", () => {
  const sheet = (props: Partial<Parameters<typeof ProfilePictureSheet>[0]> = {}) => renderToStaticMarkup(<ProfilePictureSheet state={state()} onClose={() => undefined} onFiles={() => undefined} onUseGoogle={() => undefined} onRemove={() => undefined} camera {...props} />);

  test("Take photo is a camera capture input; Choose a picture takes PNG, JPEG, or WebP; no native controls", () => {
    const html = sheet();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Take photo");
    expect(html).toContain("Choose a picture");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*data-avatar-input="camera"/);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp"[^>]*data-avatar-input="files"/);
    expect(html).not.toContain("multiple");
    expect(html).not.toContain("<select");
    expect(html).toContain("action-button secondary attach-sheet-action");
    expect(html).toContain("location and camera details are not kept");
    // Nothing to remove and no Google: neither is offered.
    expect(html).not.toContain("Remove picture");
    expect(html).not.toContain("Use my Google picture");
    expect(sheet({ camera: false })).not.toContain("Take photo");
  });

  test("Use my Google picture only with a linked Google picture not already in use; Remove only with a picture", () => {
    expect(sheet({ state: state({ source: "upload", google: { linked: true, hasPicture: true } }) })).toContain("Use my Google picture");
    expect(sheet({ state: state({ source: "google", google: { linked: true, hasPicture: true } }) })).not.toContain("Use my Google picture");
    expect(sheet({ state: state({ source: "upload", google: { linked: true, hasPicture: false } }) })).not.toContain("Use my Google picture");
    expect(sheet({ state: state({ source: "upload" }) })).toContain("Remove picture");
    expect(sheet({ state: state({ source: "none", google: { linked: true, hasPicture: true } }) })).toContain("stays when you sign in with Google");
    expect(avatarSourceLine(state({ source: "google" }))).toContain("Google");
    expect(avatarSourceLine(state())).toBe("No picture: your initial is shown.");
  });

  test("the crop: a draggable, keyboard-movable preview, a zoom slider, Cancel and Save; busy disables them", () => {
    const picture = { source: {} as CanvasImageSource, width: 800, height: 600 };
    const html = renderToStaticMarkup(<AvatarCropDialog picture={picture} busy={false} error="" onCancel={() => undefined} onSave={() => undefined} />);
    expect(html).toContain("Crop your picture");
    expect(html).toMatch(/<canvas[^>]*class="avatar-crop-canvas"[^>]*tabindex="0"/);
    expect(html).toMatch(/type="range" min="1" max="4"/);
    expect(html).toContain("Save picture");
    const busy = renderToStaticMarkup(<AvatarCropDialog picture={picture} busy error="Pictures can be up to 1 MiB." onCancel={() => undefined} onSave={() => undefined} />);
    expect(busy).toContain("Saving…");
    expect(busy).toContain('role="alert"');
    expect(busy.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("Back closes the sheet and the crop (history layers; the crop holds while saving)", () => {
    const code = source("settings/ProfilePicture.tsx");
    expect(code).toContain("useHistoryDialogGuard(true, onClose);");
    expect(code).toContain("useHistoryDialogGuard(true, onCancel, { blocked: busy });");
    // The card updates the signed-in person's picture everywhere at once.
    expect(code).toContain("setSelfAvatar(result.avatarUrl)");
    expect(code).toContain("useFileDrop(");
    expect(source("App.tsx")).toContain("<ProfilePictureCard name={session.user.displayName} />");
  });
});
