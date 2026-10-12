import { HOSTS } from "../attachments/hosts";
import { listAttachments } from "../attachments/service";
import { registerEventAttachments } from "./service";

/**
 * Event attachments (uploads everywhere U1), wired into the calendar service. Access, linking, caps,
 * and the lifecycle are the U0 attachment service's (`hostKind = "event"`); this only lends the
 * calendar's responses the list. Files belong to the event's whole series, so every occurrence of a
 * repeating event shows the same ones. server/calendar/routes.ts and mcpTools.ts import this file.
 */

/** Files an event may hold (D400, Q11), from the host registry. */
export const MAX_ATTACHMENTS_PER_EVENT = HOSTS.event.caps.perHost;

// Callers have already read the event, so the host check inside listAttachments passes.
registerEventAttachments({ list: (eventId, userId) => listAttachments("event", eventId, userId), limit: MAX_ATTACHMENTS_PER_EVENT });
