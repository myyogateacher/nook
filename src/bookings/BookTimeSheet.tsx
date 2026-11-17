import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, CalendarCheck2, CalendarPlus, Clock, MapPin } from "lucide-react";
import { ApiError } from "../api";
import { ModalDialog } from "../files/Dialog";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { QuestionRenderer } from "../ui/questions/QuestionRenderer";
import { notify } from "../ui/notify";
import { FormError } from "../ui/FormError";
import type { Answers } from "../../shared/questions";
import { SlotPicker } from "./SlotPicker";
import { useUnitPreferences } from "../ui/units";
import { bookingsApi, dayLabel, durationLabel, timeLabel, viewerZone, type BookableType, type Booking, type BookingForm } from "./api";
import "../files/files.css";
import "../ui/workspace.css";
import "./teamBookTime.css";

/**
 * The in-app booking sheet (D1252): a member books a colleague's type as themselves, through the
 * internal POST /api/bookings (source `internal`; they then read the booking as its booker, D1022).
 * Steps: length and time (the SlotPicker every booking flow uses), then the place when the type asks,
 * guests, and the type's intake questions, then a confirmation. A dialog on a computer, a bottom
 * sheet on a phone; one history layer (Back closes it).
 */

type Step = { kind: "pick" } | { kind: "details"; start: string } | { kind: "done"; booking: Booking; mailQueued: boolean };

const errorPayload = (reason: unknown) => reason instanceof ApiError && reason.payload && typeof reason.payload === "object" ? reason.payload as { code?: string; errors?: Record<string, string>; field?: string } : {};

export default function BookTimeSheet({ type, hostName, onClose }: { type: BookableType; hostName: string; onClose: () => void }) {
  const [form, setForm] = useState<BookingForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tz, setTz] = useState(viewerZone);
  const { weekStart } = useUnitPreferences();
  const [duration, setDuration] = useState(type.durations[0] ?? 30);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [busy, setBusy] = useState(false);
  useHistoryDialogGuard(true, onClose);

  useEffect(() => {
    let live = true;
    bookingsApi.form(type.id).then((result) => { if (live) setForm(result); }, (reason: unknown) => { if (live) setLoadError(reason instanceof Error ? reason.message : "Could not open this booking type"); });
    return () => { live = false; };
  }, [type.id]);

  const title = `Book time with ${hostName}`;
  const durations = form?.type.durations ?? type.durations;
  const withNames = form && form.hosts.length > 1 ? form.hosts.map((host) => host.name).join(", ") : null;

  return <ModalDialog title={title} eyebrow={type.title} onClose={onClose} busy={busy} className="bk-book-sheet">
    <div className="file-dialog-body bk-book-body">
      {loadError ? <p className="bk-book-note" role="alert">{loadError}</p>
        : step.kind === "done" ? <Done booking={step.booking} mailQueued={step.mailQueued} tz={tz} onClose={onClose} />
        : <>
          <ul className="bk-book-facts">
            <li><Clock aria-hidden="true" />{durationLabel(duration)}</li>
            {form && <li><MapPin aria-hidden="true" />{form.type.location || form.type.locationLabel}</li>}
            {withNames && <li>With {withNames}</li>}
            {step.kind === "details" && <li className="bk-book-chosen"><CalendarPlus aria-hidden="true" />{dayLabel(step.start, tz, { weekday: "long", day: "numeric", month: "long" })}, {timeLabel(step.start, tz)}</li>}
          </ul>
          {form?.type.description && step.kind === "pick" && <p className="bk-book-description">{form.type.description}</p>}
          {type.confirm === "manual" && <p className="bk-book-note">{hostName} confirms each request.</p>}
          {step.kind === "pick" && <>
            {durations.length > 1 && <div className="bk-book-durations" role="radiogroup" aria-label="Length">
              {durations.map((value) => <button key={value} type="button" role="radio" aria-checked={value === duration} className={value === duration ? "selected" : ""} onClick={() => setDuration(value)}>{durationLabel(value)}</button>)}
            </div>}
            <SlotPicker key={duration} load={(from, to, zone) => bookingsApi.typeSlots(type.id, { from, to, tz: zone, duration })} tz={tz} onTz={setTz} weekStart={weekStart} onPick={(start) => setStep({ kind: "details", start })} />
          </>}
          {step.kind === "details" && form && <Details form={form} start={step.start} duration={duration} tz={tz} busy={busy} setBusy={setBusy}
            onBack={() => setStep({ kind: "pick" })} onDone={(booking, mailQueued) => setStep({ kind: "done", booking, mailQueued })} />}
          {step.kind === "details" && !form && <p className="bk-book-note" role="status">Loading…</p>}
        </>}
    </div>
  </ModalDialog>;
}

function Details({ form, start, duration, tz, busy, setBusy, onBack, onDone }: {
  form: BookingForm; start: string; duration: number; tz: string; busy: boolean; setBusy: (busy: boolean) => void;
  onBack: () => void; onDone: (booking: Booking, mailQueued: boolean) => void;
}) {
  const [location, setLocation] = useState("");
  const [guests, setGuests] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState("");
  const asksPhone = form.type.locationKind === "phone";

  const submit = async (checked: Answers) => {
    const problems: Record<string, string> = {};
    if (form.type.needsLocation && !location.trim()) problems.location = asksPhone ? "Enter the number to call" : "Say where to meet";
    const guestList = guests.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
    if (guestList.length > 10 || guestList.some((guest) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest))) problems.guests = "Up to 10 email addresses, separated by commas";
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await bookingsApi.book({ type: form.type.id, start, duration, tz, location: form.type.needsLocation ? location.trim() : null, guests: guestList, answers: checked });
      notify.success(result.booking.status === "pending" ? "Request sent" : "Booked");
      onDone(result.booking, result.mailQueued);
    } catch (reason) {
      const payload = errorPayload(reason);
      if (payload.errors) setErrors(payload.errors);
      else if (payload.field) setErrors({ [payload.field]: reason instanceof Error ? reason.message : "Check this" });
      setFailure(payload.code === "SLOT_TAKEN" ? "That time was just taken. Go back and choose another." : reason instanceof Error ? reason.message : "Could not book");
    } finally {
      setBusy(false);
    }
  };

  const label = form.type.confirm === "manual" ? "Request booking" : "Confirm booking";
  const fields = <div className="bk-book-fields">
    <button type="button" className="ui-text-button bk-book-back" onClick={onBack}><ArrowLeft aria-hidden="true" />Change the time</button>
    {form.type.needsLocation && <Field label={asksPhone ? "Phone number to call" : "Where should you meet?"} error={errors.location}>
      <input type={asksPhone ? "tel" : "text"} maxLength={500} value={location} onChange={(event) => setLocation(event.target.value)} aria-invalid={Boolean(errors.location)} autoFocus /></Field>}
    <Field label="Guests (optional)" hint="Email addresses, separated by commas" error={errors.guests}>
      <input value={guests} onChange={(event) => setGuests(event.target.value)} aria-invalid={Boolean(errors.guests)} /></Field>
    <FormError message={failure} />
  </div>;

  if (form.questions) return <QuestionRenderer set={form.questions} answers={answers} onChange={setAnswers} onSubmit={(checked) => submit(checked)} theme="app" audience="member"
    errors={errors} submitting={busy} submitLabel={label} header={fields} timeZone={tz} />;
  return <form className="bk-book-form" noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); void submit({}); }}>
    {fields}
    <footer className="file-dialog-actions">
      <button type="button" className="secondary-button" onClick={onBack} disabled={busy}>Back</button>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? "Booking…" : label}</button>
    </footer>
  </form>;
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return <label className="ui-field"><span>{label}</span>{children}{hint && !error && <small className="bk-book-hint">{hint}</small>}{error && <small className="bk-book-error" role="alert">{error}</small>}</label>;
}

function Done({ booking, mailQueued, tz, onClose }: { booking: Booking; mailQueued: boolean; tz: string; onClose: () => void }) {
  const pending = booking.status === "pending";
  return <div className="bk-book-done" role="status">
    <span className="bk-book-done-icon" aria-hidden="true"><CalendarCheck2 /></span>
    <h3>{pending ? "Request sent" : "You're booked"}</h3>
    <p><strong>{booking.typeTitle}</strong> with {booking.hostName}{booking.cohosts.length ? `, ${booking.cohosts.map((host) => host.name).join(", ")}` : ""}</p>
    <p>{dayLabel(booking.start, tz, { weekday: "long", day: "numeric", month: "long" })}, {timeLabel(booking.start, tz)}–{timeLabel(booking.end, tz)}</p>
    {booking.location && <p className="bk-book-muted">{booking.location}</p>}
    <p className="bk-book-muted">{pending ? `${booking.hostName} confirms it; you'll hear when they do.` : mailQueued ? "A confirmation is on its way to your inbox." : "It is in Bookings under Upcoming."}</p>
    <footer className="file-dialog-actions">
      <a className="secondary-button" href={booking.href} onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onClose();
        window.dispatchEvent(new CustomEvent("nook:open-path", { detail: { path: booking.href } }));
      }}>Open in Bookings</a>
      <button type="button" className="primary-button" onClick={onClose} autoFocus>Done</button>
    </footer>
  </div>;
}
