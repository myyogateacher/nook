import { lazy, Suspense, useEffect, useState } from "react";
import { BOOKINGS_SECTIONS } from "./sections";
import { pickAndEmbed } from "../ui/embeds/openEmbedPicker";
import type { ItemSlotProps } from "../ui/itemSlots";
import { CalendarCheck2, CalendarClock, CalendarPlus, Link2 } from "lucide-react";
import { WORKSPACE_MODULE_LABELS } from "../../shared/workspaceModules";
import type { WorkspaceClientModule } from "../workspaceModules/types";
import { parseRoute } from "../router";
import { EmbedCard } from "../ui/embeds/EmbedCard";
import { api } from "../api";
import type { EmbedCardProps } from "../editor/moduleEmbedRegistry";
import { bookTimeMemberAction } from "./TeamBookTime";

/**
 * Bookings (lane BOOK, docs/plan/WORKSPACE_MODULES.md §D.6): the client module. The app is its own
 * lazy chunk; the public pages (`/p/book/…`) another, loaded without the session code (D831).
 * Registers: routes (`/bookings`, `/bookings/b/<id>`, `/bookings/types/<slug-id>`), the launcher,
 * Today's "Bookings" section, a "Copy booking link" quick action, notification topics, the
 * booking-link embed and its `/` item, search rows, the Team page's "Book time with …" (D1253), and
 * the module's shortcuts.
 */

const BookingsApp = lazy(() => import("./BookingsApp"));
const RecordBookingsPanel = lazy(() => import("./RecordBookings"));

function RecordBookings(props: ItemSlotProps) {
  return <Suspense fallback={null}><RecordBookingsPanel {...props} /></Suspense>;
}

type MineType = { href: string; title: string; status: string; publicPath: string | null; durations: number[] };
const loadBookableTypes = () => api<{ types: MineType[] }>("/bookings/types?mine=1").then(({ types }) => types
  .filter((type) => type.status === "active" && type.publicPath)
  .map((type) => ({ id: type.href, title: type.title, meta: type.durations.map((minutes) => `${minutes} min`).join(" / "), path: type.href })));
const BookingPublicPage = lazy(() => import("./public/BookingPublicPage"));

function BookingLinkEmbed({ path }: EmbedCardProps) {
  const ref = path.split("/").pop() ?? "";
  const [state, setState] = useState<{ title: string; publicPath: string | null; durations: number[]; ownerName: string } | null | "gone">(null);
  useEffect(() => {
    let live = true;
    api<{ title: string; publicPath: string | null; durations: number[]; ownerName: string }>(`/bookings/types/${encodeURIComponent(ref)}/embed`).then((data) => live && setState(data), () => live && setState("gone"));
    return () => { live = false; };
  }, [ref]);
  if (state === null) return <EmbedCard icon={CalendarPlus} word="Booking link" loading />;
  if (state === "gone" || !state.publicPath) return <EmbedCard icon={CalendarPlus} word="Booking link" unavailable />;
  const href = state.publicPath;
  return <EmbedCard icon={CalendarPlus} word="Booking link" title={state.title} subtitle={`With ${state.ownerName} · ${state.durations.map((minutes) => `${minutes} min`).join(" / ")}`}
    action={{ label: "Book a time", primary: true, onClick: () => window.open(href, "_blank", "noopener,noreferrer") }} />;
}

async function copyBookingLink(flash: (message: string) => void) {
  try {
    const { profile } = await api<{ profile: { publicPath: string } }>("/bookings/profile");
    const url = `${window.location.origin}${profile.publicPath}`;
    await navigator.clipboard.writeText(url).then(() => flash("Booking link copied"), () => flash(url));
  } catch {
    flash("Could not copy your booking link");
  }
}

export const module: WorkspaceClientModule = {
  id: "bookings",
  segment: WORKSPACE_MODULE_LABELS.bookings.path.slice(1),
  label: WORKSPACE_MODULE_LABELS.bookings.label,
  icon: CalendarClock,
  description: WORKSPACE_MODULE_LABELS.bookings.description,
  ready: true,
  app: BookingsApp,
  launcher: true,
  sections: BOOKINGS_SECTIONS,
  parseRoute: (segments) => ({ path: segments.slice(0, 2).map((segment) => decodeURIComponent(segment)) }),
  todaySections: {
    bookingsToday: {
      title: "Bookings", group: "today", empty: "no bookings today or tomorrow", app: "Bookings",
      row: (item) => ({ key: item.id, label: item.title, meta: item.status === "pending" ? `Awaiting approval · ${item.when}` : item.when, route: parseRoute(item.href), tone: item.status === "pending" ? "soon" : "today" })
    }
  },
  quickActions: [{ id: "bookings.copy-link", label: "Copy booking link", icon: Link2, hiddenFor: ["guest", "viewer"], run: (context) => copyBookingLink(context.flash) }],
  notificationTopics: [
    { id: "bookings.new", label: "New bookings" }, { id: "bookings.pending", label: "Requests to approve" },
    { id: "bookings.cancelled", label: "Cancellations" }, { id: "bookings.rescheduled", label: "Reschedules" }, { id: "bookings.reminder", label: "Reminders before a booking" }
  ],
  workKindRenderers: { booking: { icon: CalendarCheck2, label: "Booking" }, booking_type: { icon: CalendarPlus, label: "Booking type" } },
  embedRenderers: [{ kind: "booking_type", component: BookingLinkEmbed }],
  slashItems: [{
    label: "Booking link", hint: "Embed one of your booking types", keywords: "booking book meeting schedule calendly link",
    // A picker of your active public types (D1059; D1025 embedded the first one).
    run: (editor, range) => pickAndEmbed(editor, range, "booking_type", {
      title: "Add a booking link", eyebrow: "Bookings", icon: CalendarPlus, emptyTitle: "No public booking types", emptyText: "Make a booking type public and active in Bookings first.",
      load: loadBookableTypes
    })
  }],
  // "Book time with …" on the Team page (D1253).
  memberActions: [bookTimeMemberAction],
  itemSections: [{ id: "bookings.record", kinds: ["contact", "company", "deal"], order: 30, component: RecordBookings }],
  searchRenderer: {
    scope: "bookings", label: "Bookings", icon: CalendarCheck2,
    row: (result) => ({ key: String(result.id), title: String(result.title), meta: typeof result.snippet === "string" ? result.snippet : undefined, href: String(result.href) })
  },
  shortcuts: [{ keys: "n", label: "New booking type" }, { keys: "/", label: "Search bookings" }, { keys: "j / k", label: "Next / previous booking" }],
  publicPages: [{ prefix: "/p/book/", component: BookingPublicPage }]
};
