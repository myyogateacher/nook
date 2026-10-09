import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAT_IMAGE_ACCEPT, downscaleTarget, IMAGES_FULL_MESSAGE, isChatImageFile, NOT_AN_IMAGE_MESSAGE, renamed, triageImageFiles, visionMissingMessage } from "../src/chat/chatImageFiles";
import { ComposerImageStrip, MessageImages, type PendingImage } from "../src/chat/ComposerImages";
import { ProviderVisionFields, visionDraft, visionFromDraft, visionSuggestions, visionSummary } from "../src/chat/ProviderVisionPolicy";
import { CHAT_IMAGE_BOUNDS, visionAllowsModel } from "../shared/agents";

/**
 * Uploads everywhere U5, the client side: the composer's image rules (images only, at most five, a
 * model marked vision-capable), the browser downscale's sizes, the thumbnails with Remove and
 * progress, the images in a user bubble, the provider editor's Images group, and the wiring in
 * ChatApp (the shared attach sheet, paste, drop, the viewer, Send blocked while it must be).
 */

const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");
const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

describe("the composer's image rules", () => {
  test("images only, up to five, and only for a vision-capable model, each refusal explained", () => {
    expect(CHAT_IMAGE_ACCEPT).toBe("image/png,image/jpeg,image/gif,image/webp");
    expect(isChatImageFile(file("a.png", "image/png"))).toBe(true);
    for (const type of ["application/pdf", "image/svg+xml", "image/heic", "text/csv", ""]) expect(isChatImageFile(file("x", type))).toBe(false);
    const png = file("a.png", "image/png");
    const pdf = file("a.pdf", "application/pdf");
    expect(triageImageFiles([png], 0, false, "Looker")).toEqual({ accepted: [], refusal: visionMissingMessage("Looker") });
    expect(visionMissingMessage("Looker")).toContain("Settings → AI → Model providers");
    expect(triageImageFiles([png, pdf], 0, true)).toEqual({ accepted: [png], refusal: NOT_AN_IMAGE_MESSAGE });
    expect(NOT_AN_IMAGE_MESSAGE).toContain("PDFs");
    const six = Array.from({ length: 6 }, (_, index) => file(`${index}.jpg`, "image/jpeg"));
    expect(triageImageFiles(six, 0, true).accepted).toHaveLength(5);
    expect(triageImageFiles(six, 0, true).refusal).toBe(IMAGES_FULL_MESSAGE);
    expect(triageImageFiles([png], 5, true)).toEqual({ accepted: [], refusal: IMAGES_FULL_MESSAGE });
    expect(triageImageFiles([], 0, false)).toEqual({ accepted: [], refusal: null });
  });

  test("large photos are downscaled to a 2,048 px long side; small ones and small GIFs are left alone", () => {
    expect(CHAT_IMAGE_BOUNDS.maxEdge).toBe(2048);
    expect(downscaleTarget(1200, 800, 300_000, "image/jpeg")).toBeNull();
    expect(downscaleTarget(4032, 3024, 3_000_000, "image/jpeg")).toEqual({ width: 2048, height: 1536 });
    expect(downscaleTarget(1000, 4000, 1_000, "image/png")).toEqual({ width: 512, height: 2048 });
    // Over the byte cap at a small size: drawn again at the same size (re-encoded smaller).
    expect(downscaleTarget(1500, 1000, CHAT_IMAGE_BOUNDS.bytes + 1, "image/png")).toEqual({ width: 1500, height: 1000 });
    expect(downscaleTarget(3000, 3000, 2_000_000, "image/gif")).toBeNull();
    expect(downscaleTarget(3000, 3000, CHAT_IMAGE_BOUNDS.bytes + 1, "image/gif")).toEqual({ width: 2048, height: 2048 });
    expect(renamed("holiday.PNG", "image/webp")).toBe("holiday.webp");
    expect(renamed("IMG_0001.heic.jpeg", "image/jpeg")).toBe("IMG_0001.heic.jpg");
    expect(renamed("", "image/jpeg")).toBe("image.jpg");
  });
});

describe("thumbnails", () => {
  const item = (patch: Partial<PendingImage>): PendingImage => ({ key: "k", name: "shot.png", status: "ready", progress: 1, documentId: "d", previewUrl: "blob:x", confirmed: false, error: null, ...patch });
  test("the composer strip: a thumbnail each, progress while uploading, the reason when one failed, and Remove", () => {
    expect(renderToStaticMarkup(<ComposerImageStrip items={[]} onRemove={() => undefined} />)).toBe("");
    const html = renderToStaticMarkup(<ComposerImageStrip items={[item({}), item({ key: "u", name: "up.jpg", status: "uploading", progress: 0.4 }), item({ key: "f", name: "bad.png", status: "failed", error: "Storage quota exceeded" })]} onRemove={() => undefined} />);
    expect(html).toContain("aria-label=\"Images to send\"");
    expect(html).toContain("aria-label=\"Remove shot.png\"");
    expect(html).toContain("aria-valuenow=\"40\"");
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("Storage quota exceeded");
    expect(html.match(/<img /g)).toHaveLength(3);
  });

  test("a user bubble: a thumbnail button per image that opens the viewer, and \"Image removed\" for one in the Bin", () => {
    const html = renderToStaticMarkup(<MessageImages items={[{ documentId: "11111111-1111-4111-8111-111111111111", removed: false, name: "red.png", mimeType: "image/png", sizeBytes: 10 }, { documentId: "22222222-2222-4222-8222-222222222222", removed: true }]} onOpen={() => undefined} />);
    expect(html).toContain("/api/files/11111111-1111-4111-8111-111111111111/content");
    expect(html).toContain("aria-label=\"Open red.png\"");
    expect(html).toContain("aria-haspopup=\"dialog\"");
    expect(html).toContain("Image removed");
    expect(html).not.toContain("22222222-2222-4222-8222-222222222222/content");
  });
});

describe("the provider editor's Images group (D91)", () => {
  test("no models, every model, or a list; the summary and suggestions", () => {
    expect(visionDraft(undefined)).toEqual({ mode: "off", models: [] });
    expect(visionDraft({ enabled: true, models: null })).toEqual({ mode: "all", models: [] });
    expect(visionDraft({ enabled: true, models: ["gpt-6-vision"] })).toEqual({ mode: "models", models: ["gpt-6-vision"] });
    expect(visionFromDraft({ mode: "models", models: [] })).toHaveProperty("error");
    expect(visionFromDraft({ mode: "models", models: ["a"] })).toEqual({ policy: { enabled: true, models: ["a"] } });
    expect(visionFromDraft({ mode: "off", models: ["a"] })).toEqual({ policy: { enabled: false, models: null } });
    expect(visionSummary({ enabled: false, models: null })).toBe("Not sent");
    expect(visionSummary({ enabled: true, models: null })).toBe("Every model");
    expect(visionSummary({ enabled: true, models: ["one"] })).toBe("one");
    expect(visionSummary({ enabled: true, models: ["one", "two"] })).toBe("2 models");
    expect(visionSuggestions(["gpt-6-luna", "text-embedding-3-small", "bad id"])).toEqual(["gpt-6-luna"]);
    expect(visionAllowsModel({ enabled: true, models: ["gpt-6-vision"] }, " gpt-6-vision ")).toBe(true);
    expect(visionAllowsModel({ enabled: false, models: null }, "gpt-6-vision")).toBe(false);
  });

  test("custom segmented buttons and the shared Combobox, never a native select", () => {
    const off = renderToStaticMarkup(<ProviderVisionFields providerId={null} defaultModel="gpt-6-luna" draft={{ mode: "off", models: [] }} onChange={() => undefined} />);
    expect(off).toContain(">Images<");
    expect(off).toContain("aria-pressed=\"true\"");
    expect(off).toContain(">No models<");
    expect(off).not.toContain("<select");
    const list = renderToStaticMarkup(<ProviderVisionFields providerId={null} defaultModel="gpt-6-luna" draft={{ mode: "models", models: ["gpt-6-vision"] }} onChange={() => undefined} />);
    expect(list).toContain("gpt-6-vision");
    expect(list).not.toContain("<select");
    const settings = source("chat/AiSettings.tsx");
    expect(settings).toContain("<ProviderVisionFields");
    expect(settings).toContain("vision: images.policy");
    expect(settings).toContain("<dt>Images</dt>");
  });
});

describe("ChatApp wiring", () => {
  const app = source("chat/ChatApp.tsx");
  test("the shared attach sheet (images only, Back closes it), paste, drop, and the viewer", () => {
    expect(app).toMatch(/<AttachSheet hostNoun="message" accept=\{CHAT_IMAGE_ACCEPT\} closeOnPick/);
    expect(app).toContain("onPickDocument={composerImages.addDocument}");
    expect(app).toContain("disabledReason={!composerVision ? visionMissingMessage(composerAgentName)");
    expect(app).toContain("const files = pastedFiles(event.clipboardData);");
    expect(app).toContain("useFileDrop(composerImages.addFiles");
    expect(app).toContain("<AttachmentPreview documentId={viewing.documentId}");
    // Every layer is the kit's (history guarded): no own sheet or native file input in Chat.
    expect(app).not.toContain("type=\"file\"");
    expect(app).not.toContain("<select");
  });

  test("Send waits for uploads, refuses failed ones, and is blocked on a model that cannot see images", () => {
    expect(app).toContain("composerImages.uploading || composerImages.failed || imagesBlocked");
    expect(app).toMatch(/if \(images\.length > 0 && !composerVision\) \{ flash\(visionMissingMessage/);
    expect(app).toContain("sendMessage(route.chatId, text, parentId, images)");
    expect(app).toContain("editAttachments(shown.message)");
    // The disclosure names images when there are some.
    expect(app).toContain("Messages and their images leave this Nook for the configured model provider.");
  });
});
