import { expect, test } from "bun:test";
import { uploadFailure } from "../src/calendar/EventAttachments";
import { LocationStripError } from "../src/ui/attachments";

/**
 * Uploads everywhere U1: a photo whose location cannot be removed is refused by the kit
 * (LocationStripError, Q9). The event's staged upload shows a friendly reason and offers no Retry;
 * other failures keep their message and their Retry.
 */
test("a location strip failure is friendly and not retryable; other failures keep Retry", () => {
  const strip = uploadFailure(new LocationStripError("IMG_0001.jpg"));
  expect(strip).toMatchObject({ status: "failed", file: null });
  expect(strip.error).toContain("The location in “IMG_0001.jpg” could not be removed");
  expect(strip.error).toContain("Remove its location in another app");
  const other = uploadFailure(new Error("Storage is full"));
  expect(other).toEqual({ status: "failed", error: "Storage is full" });
  expect("file" in other).toBe(false);
});
