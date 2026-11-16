import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarDays, Check, Clock, Mail, RotateCcw, UserX, Users, X } from "lucide-react";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { LinkedItemsPanel } from "../ui/links/WorkLinks";
import { ItemSectionsOutlet } from "../ui/ItemSlotOutlet";
import { answerText } from "../ui/questions/ResponseViewer";
import { LOCATION_LABELS } from "../../shared/bookings";

const SOURCE_LABEL: Record<Booking["source"], string> = { public: "Booked on your page", secret_link: "Booked with a private link", internal: "Booked by a member", mcp: "Booked through an API key" };
import { bookingsApi, dayLabel, durationLabel, timeLabel, viewerZone, type Booking } from "./api";
import { SlotPicker } from "./SlotPicker";
import { useUnitPreferences } from "../ui/units";
import { LOCATION_ICONS, StatusChip } from "./BookingsApp";

/**
 * One booking for its host (§D.6 UI): when (your zone and the booker's), who, where, the intake
 * answers, the linked event / contact / card, internal notes (ItemTimeline), and the host actions:
 * Approve / Decline a request, Reschedule (pick a free time), Cancel with a message, No-show.
 */

export function BookingDetail({ bookingRef, onBack, onOpenPath, flash, readOnly }: { bookingRef: string; onBack: () => void; onOpenPath: (path: string) => void; flash: (message: string) => void; readOnly: boolean }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel" | "decline">("view");
  const { weekStart } = useUnitPreferences();
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [tz, setTz] = useState(viewerZone);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(() => bookingsApi.booking(bookingRef).then((result) => setBooking(result.booking)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Booking not found")), [bookingRef]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <div className="bk-panel"><button type="button" className="text-button bk-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Bookings</button><p className="bk-error" role="alert">{error}</p></div>;
  if (!booking) return <p className="bk-muted" role="status">Loading booking…</p>;
  const Icon = LOCATION_ICONS[booking.locationKind];
  const upcoming = Date.parse(booking.start) > Date.now();
  const live = booking.status === "pending" || booking.status === "confirmed";
  const run = async (work: () => Promise<{ booking: Booking }>, done: string) => {
    setBusy(true);
    try {
      const result = await work();
      flash(done);
      setMode("view");
      setMessage("");
      if (result.booking.id !== booking.id) onOpenPath(result.booking.href);
      else { setBooking(result.booking); setRefresh((value) => value + 1); }
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not update the booking");
    } finally {
      setBusy(false);
    }
  };
  const answers = booking.response && booking.questions ? booking.questions.questions.filter((question) => booking.response!.answers[question.id] !== undefined) : [];

  return <div className="bk-detail">
    <button type="button" className="text-button bk-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Bookings</button>
    <div className="bk-detail-grid">
      <div className="bk-detail-main">
        <section className="bk-panel" aria-labelledby="bk-detail-title" style={{ "--bk-color": booking.color } as React.CSSProperties}>
          <div className="bk-detail-head">
            <h2 id="bk-detail-title">{booking.typeTitle} with {booking.bookerName}</h2>
            <StatusChip status={booking.status} />
          </div>
          <ul className="bk-facts">
            <li><CalendarDays aria-hidden="true" /><span>{dayLabel(booking.start, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, {timeLabel(booking.start, tz)}–{timeLabel(booking.end, tz)} <span className="bk-muted">({durationLabel(booking.durationMin)})</span></span></li>
            {booking.bookerTz !== tz && <li><Clock aria-hidden="true" /><span className="bk-muted">For {booking.bookerName}: {timeLabel(booking.start, booking.bookerTz)} ({booking.bookerTz.replace(/_/g, " ")})</span></li>}
            <li><Mail aria-hidden="true" /><a href={`mailto:${booking.bookerEmail}`}>{booking.bookerEmail}</a></li>
            {booking.guests.length > 0 && <li><Users aria-hidden="true" /><span>Guests: {booking.guests.join(", ")}</span></li>}
            <li><Icon aria-hidden="true" /><span>{booking.location || LOCATION_LABELS[booking.locationKind]}</span></li>
            <li><Users aria-hidden="true" /><span>Host: {booking.hostName}{booking.cohosts.length ? `, ${booking.cohosts.map((host) => host.name).join(", ")}` : ""} · {SOURCE_LABEL[booking.source]}</span></li>
          </ul>
          {booking.cancelReason && <p className="bk-muted">Message: {booking.cancelReason}</p>}
          {!readOnly && live && mode === "view" && <div className="bk-detail-actions">
            {booking.status === "pending" && <button type="button" className="action-button ui-small-button" disabled={busy} onClick={() => void run(() => bookingsApi.act(booking.id, "approve"), "Booking confirmed")}><Check aria-hidden="true" />Approve</button>}
            {booking.status === "pending" && <button type="button" className="secondary-button ui-small-button" onClick={() => setMode("decline")}><X aria-hidden="true" />Decline</button>}
            {upcoming && booking.typeId && <button type="button" className="secondary-button ui-small-button" onClick={() => setMode("reschedule")}><RotateCcw aria-hidden="true" />Reschedule</button>}
            {upcoming && <button type="button" className="secondary-button ui-small-button" onClick={() => setMode("cancel")}><X aria-hidden="true" />Cancel booking</button>}
            {!upcoming && booking.status === "confirmed" && <button type="button" className="secondary-button ui-small-button" disabled={busy} onClick={() => void run(() => bookingsApi.act(booking.id, "no-show"), "Marked as a no-show")}><UserX aria-hidden="true" />No-show</button>}
          </div>}
          {!readOnly && booking.status === "completed" && <div className="bk-detail-actions"><button type="button" className="secondary-button ui-small-button" disabled={busy} onClick={() => void run(() => bookingsApi.act(booking.id, "no-show"), "Marked as a no-show")}><UserX aria-hidden="true" />No-show</button></div>}
          {(mode === "cancel" || mode === "decline") && <form className="bk-inline-form" noValidate onSubmit={(event) => { event.preventDefault(); void run(() => bookingsApi.act(booking.id, mode === "cancel" ? "cancel" : "decline", message), mode === "cancel" ? "Booking cancelled" : "Request declined"); }}>
            <label className="ui-field"><span>Message to {booking.bookerName} (optional)</span><textarea rows={2} maxLength={500} value={message} autoFocus onChange={(event) => setMessage(event.target.value)} /></label>
            <div className="bk-detail-actions"><button type="submit" className="danger-button ui-small-button" disabled={busy}>{mode === "cancel" ? "Cancel booking" : "Decline"}</button><button type="button" className="secondary-button ui-small-button" onClick={() => setMode("view")}>Keep it</button></div>
          </form>}
          {mode === "reschedule" && <div className="bk-inline-form">
            <SlotPicker load={(from, to, zone) => bookingsApi.bookingSlots(booking.id, { from, to, tz: zone })} tz={tz} onTz={setTz} weekStart={weekStart} picked={picked} onPick={setPicked} label="Choose a new time" />
            <label className="ui-field"><span>Message (optional)</span><textarea rows={2} maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
            <div className="bk-detail-actions">
              <button type="button" className="action-button" disabled={!picked || busy} onClick={() => picked && void run(() => bookingsApi.reschedule(booking.id, picked, message), "Booking moved")}>{picked ? `Move to ${dayLabel(picked, tz)} ${timeLabel(picked, tz)}` : "Pick a time"}</button>
              <button type="button" className="secondary-button ui-small-button" onClick={() => setMode("view")}>Keep the time</button>
            </div>
          </div>}
        </section>
        {answers.length > 0 && <section className="bk-panel" aria-labelledby="bk-answers">
          <h3 id="bk-answers" className="bk-h3">Answers</h3>
          <dl className="bk-answers">{answers.map((question) => <div key={question.id}><dt>{question.title}</dt><dd>{answerText(question, booking.response!.answers[question.id] as never, tz)}</dd></div>)}</dl>
        </section>}
        <section className="bk-panel"><ItemTimeline kind="booking" id={booking.id} canComment={!readOnly} title="Notes" refreshKey={String(refresh)} /></section>
      </div>
      <aside className="bk-detail-side">
        <section className="bk-panel"><LinkedItemsPanel item={{ kind: "booking", id: booking.id }} canEdit={!readOnly} onOpen={onOpenPath} title="Linked" /></section>
        <ItemSectionsOutlet kind="booking" id={booking.id} readOnly={readOnly} onOpen={onOpenPath} frameClassName="bk-panel" />
      </aside>
    </div>
  </div>;
}
