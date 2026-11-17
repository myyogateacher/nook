import { audit } from "../db";
import { CSV_EXPORT_ROWS, csvText } from "../csvExport";
import { listBookings, type ListFilter } from "./routes";

/**
 * Bookings as CSV (D1387): the list the viewer sees (`readableBookingSql`, T583: hosts and type
 * managers) with the same view, type, and date filters, every page of it. Booker emails are in it, as
 * they are on the booking page for the same readers. Audited (`bookings.export`).
 */

const STATUS: Record<string, string> = { pending: "Awaiting confirmation", confirmed: "Confirmed", completed: "Completed", cancelled: "Cancelled", declined: "Declined", expired: "Expired", no_show: "No-show" };

export function bookingsCsv(userId: string, filter: Omit<ListFilter, "cursor" | "limit">) {
  const items: ReturnType<typeof listBookings>["items"] = [];
  let cursor: string | null = null;
  do {
    const page = listBookings(userId, { ...filter, ...(cursor ? { cursor } : {}), limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < CSV_EXPORT_ROWS);
  const rows = items.slice(0, CSV_EXPORT_ROWS).map((booking) => [
    booking.start, booking.end, booking.durationMin, booking.typeTitle, booking.hostName, booking.cohosts.map((host) => host.name).join("; "),
    booking.bookerName, booking.bookerEmail, booking.guests.join("; "), STATUS[booking.status] ?? booking.status, booking.location, booking.bookerTz, booking.source, booking.createdAt
  ]);
  audit(userId, null, "bookings.export", { view: filter.view ?? null, rows: rows.length });
  return csvText(["Start (UTC)", "End (UTC)", "Minutes", "Type", "Host", "Co-hosts", "Booker", "Booker email", "Guests", "Status", "Location", "Booker time zone", "Source", "Booked at"], rows, items.length > CSV_EXPORT_ROWS || Boolean(cursor));
}
