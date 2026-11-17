import { useEffect, useId, useState, type ReactNode } from "react";
import { Copy, Globe, Link2, Plus, Trash2 } from "lucide-react";
import { ModalDialog } from "../files/Dialog";
import { Select } from "../ui/Select";
import { ItemTimeline } from "../ui/activity/ItemTimeline";
import { useHistoryDialogGuard } from "../ui/useHistoryDialogGuard";
import { errorText, notify } from "../ui/notify";
import { authorLabel, POLL_KIND_LABELS, POLL_KINDS, TOWNHALL_LIMITS, type TownhallPollKind, type TownhallQuestionView, type TownhallSessionView } from "../../shared/townhall";
import * as townhall from "./api";
import { useQrCode } from "./Presenter";

/** Sheets of the Townhall module: new/edit session, new poll, comments, merge, cards, share. */

function Sheet({ title, onClose, busy = false, children, className }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode; className?: string }) {
  useHistoryDialogGuard(true, onClose, { blocked: busy });
  return <ModalDialog title={title} onClose={onClose} variant="sheet" busy={busy} className={`th-sheet${className ? ` ${className}` : ""}`}>{children}</ModalDialog>;
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <label className="th-toggle">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
  </label>;
}

/** `yyyy-mm-ddThh:mm` in the viewer's zone ↔ ISO. */
const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string) => value ? new Date(value).toISOString() : null;

const REMINDERS = [
  { value: "0", label: "No reminder" }, { value: "10", label: "10 minutes before" }, { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" }, { value: "60", label: "1 hour before" }, { value: "1440", label: "1 day before" }
];

export function SessionSheet({ session, onClose, onSaved }: { session?: TownhallSessionView; onClose: () => void; onSaved: (session: TownhallSessionView) => void }) {
  const [title, setTitle] = useState(session?.title ?? "");
  const [description, setDescription] = useState(session?.description ?? "");
  const [startsAt, setStartsAt] = useState(toLocalInput(session?.startsAt));
  const [eventId, setEventId] = useState<string>(session?.event?.id ?? "");
  const [events, setEvents] = useState<townhall.EventOption[] | null>(null);
  const [allowAnonymous, setAllowAnonymous] = useState(session?.allowAnonymous ?? true);
  const [review, setReview] = useState(session?.moderation === "review");
  const [allowComments, setAllowComments] = useState(session?.allowComments ?? true);
  const [questionsOpen, setQuestionsOpen] = useState(session?.questionsOpen ?? true);
  const [reminder, setReminder] = useState(String(session?.reminderMinutes ?? 15));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  useEffect(() => {
    townhall.upcomingEvents().then((body) => {
      const seen = new Set<string>();
      setEvents(body.occurrences.filter((entry) => !seen.has(entry.eventId) && seen.add(entry.eventId)).slice(0, 100).map((entry) => ({ id: entry.eventId, title: entry.title, start: entry.start, allDay: entry.allDay })));
    }, () => setEvents([]));
  }, []);
  const eventOptions = [{ value: "", label: "No event" }, ...(events ?? []).map((event) => ({ value: event.id, label: event.title || "Untitled event", description: event.allDay ? event.start.slice(0, 10) : new Date(event.start).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) })),
    ...(session?.event && !(events ?? []).some((event) => event.id === session.event!.id) ? [{ value: session.event.id, label: session.event.title }] : [])];
  const save = async () => {
    if (!title.trim()) { setError("Give the session a title"); return; }
    setBusy(true);
    setError(null);
    const pickedEvent = (events ?? []).find((event) => event.id === eventId);
    const draft: townhall.SessionDraft = {
      title: title.trim(), description, startsAt: fromLocalInput(startsAt) ?? (pickedEvent && !pickedEvent.allDay && !session ? pickedEvent.start : null), eventId: eventId || null,
      allowAnonymous, moderation: review ? "review" : "off", allowComments, questionsOpen, reminderMinutes: Number(reminder)
    };
    try {
      const result = session ? await townhall.updateSession(session.id, { ...draft, expectedRevision: session.revision }) : await townhall.createSession(draft);
      onSaved(result.session);
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not save the session"));
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title={session ? "Session settings" : "New townhall"} onClose={onClose} busy={busy}>
    <form className="file-dialog-form th-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="ui-field" htmlFor={titleId}><span>Title</span>
        <input id={titleId} autoFocus value={title} maxLength={TOWNHALL_LIMITS.title} placeholder="All hands · November" onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="ui-field"><span>What it is about <small className="th-optional">optional</small></span>
        <textarea value={description} maxLength={2000} rows={3} placeholder="Agenda, who is answering, how to ask" onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="th-form-row">
        <label className="ui-field"><span>Starts</span>
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </label>
        <div className="ui-field"><span>Reminder</span>
          <Select label="Reminder" value={reminder} onChange={setReminder} options={REMINDERS} />
        </div>
      </div>
      <div className="ui-field"><span>Calendar event <small className="th-optional">optional</small></span>
        <Select label="Calendar event" value={eventId} onChange={setEventId} options={eventOptions} placeholder={events === null ? "Loading events…" : "No event"} />
      </div>
      <fieldset className="th-toggles">
        <legend>Questions</legend>
        <Toggle checked={questionsOpen} onChange={setQuestionsOpen} label="Take questions" hint="People can ask before and during the session." />
        <Toggle checked={allowAnonymous} onChange={setAllowAnonymous} label="Allow anonymous questions" hint="Anonymous questions keep no name, not even for hosts." />
        <Toggle checked={review} onChange={setReview} label="Review before showing" hint="Hosts approve each question before others see it." />
        <Toggle checked={allowComments} onChange={setAllowComments} label="Replies on questions" hint="Members can reply under a question." />
      </fieldset>
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : session ? "Save" : "Create"}</button>
      </footer>
    </form>
  </Sheet>;
}

export function PollSheet({ sessionId, live, onClose }: { sessionId: string; live: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<TownhallPollKind>("single");
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [resultsHidden, setResultsHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = kind === "single" || kind === "multi";
  const save = async (launch: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await townhall.createPoll(sessionId, { kind, title: title.trim(), ...(choice ? { options: options.map((option) => option.trim()).filter(Boolean) } : {}), resultsHidden, launch });
      notify.success(launch ? "Poll launched" : "Poll saved");
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not save the poll"));
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title="New poll" onClose={onClose} busy={busy}>
    <form className="file-dialog-form th-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(live); }}>
      <div className="th-kind-picker" role="radiogroup" aria-label="Kind of poll">
        {POLL_KINDS.map((value) => <label key={value} className="th-kind"><input type="radio" name="poll-kind" checked={kind === value} onChange={() => setKind(value)} /><span>{POLL_KIND_LABELS[value]}</span></label>)}
      </div>
      <label className="ui-field"><span>Question</span>
        <input autoFocus value={title} maxLength={TOWNHALL_LIMITS.pollTitle} placeholder={kind === "word_cloud" ? "One word for this quarter?" : kind === "rating" ? "How useful was this session?" : "Which topic first?"} onChange={(event) => setTitle(event.target.value)} />
      </label>
      {choice && <div className="ui-field"><span>Options</span>
        <ol className="th-options">
          {options.map((option, index) => <li key={index}>
            <input value={option} maxLength={TOWNHALL_LIMITS.optionLabel} aria-label={`Option ${index + 1}`} placeholder={`Option ${index + 1}`} onChange={(event) => setOptions(options.map((entry, at) => at === index ? event.target.value : entry))} />
            <button type="button" className="icon-button" aria-label={`Remove option ${index + 1}`} disabled={options.length <= 2} onClick={() => setOptions(options.filter((_, at) => at !== index))}><Trash2 /></button>
          </li>)}
        </ol>
        {options.length < TOWNHALL_LIMITS.pollOptions && <button type="button" className="ui-text-button th-add-option" onClick={() => setOptions([...options, ""])}><Plus aria-hidden="true" />Add option</button>}
      </div>}
      {kind === "rating" && <p className="th-hint">People rate from 1 to 5 stars.</p>}
      {kind === "word_cloud" && <p className="th-hint">Each person can add up to {TOWNHALL_LIMITS.wordsPerPerson} words or short phrases.</p>}
      <Toggle checked={resultsHidden} onChange={setResultsHidden} label="Hide results until it closes" hint="Hosts always see them." />
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={() => { void save(false); }} disabled={busy || !title.trim()}>Save for later</button>
        <button type="submit" className="primary-button" disabled={busy || !title.trim()}>{busy ? "Saving…" : "Launch now"}</button>
      </footer>
    </form>
  </Sheet>;
}

export function CommentsSheet({ question, canComment, onClose }: { question: TownhallQuestionView; canComment: boolean; onClose: () => void }) {
  return <Sheet title="Replies" onClose={onClose} className="th-comments">
    <div className="th-sheet-body">
      <blockquote className="th-quote">{question.text}<footer>{authorLabel(question) ?? "Anonymous"}</footer></blockquote>
      <ItemTimeline kind="townhall_question" id={question.id} canComment={canComment} title="Replies" />
    </div>
  </Sheet>;
}

export function MergeSheet({ source, questions, onPick, onClose }: { source: TownhallQuestionView; questions: readonly TownhallQuestionView[]; onPick: (targetId: string) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = questions.filter((question) => question.id !== source.id && question.status !== "hidden" && question.text.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50);
  return <Sheet title="Merge into…" onClose={onClose} busy={busy} className="nook-picker">
    <p className="th-hint th-sheet-pad">“{source.text}” joins the question you pick; its upvotes move there.</p>
    <label className="nook-picker-search"><span className="ui-visually-hidden">Find a question</span>
      <input type="search" autoFocus value={query} placeholder="Find a question" onChange={(event) => setQuery(event.target.value)} />
    </label>
    <div className="nook-picker-body">
      {candidates.length === 0 ? <p className="nook-picker-empty">No other questions.</p>
        : <ul className="nook-picker-list" aria-label="Questions">{candidates.map((question) => <li key={question.id}><button type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await onPick(question.id); onClose(); } catch (reason) { notify.error(errorText(reason, "Could not merge")); } finally { setBusy(false); }
        }}><span><strong>{question.text}</strong><small>{question.votes} upvotes{question.author ? ` · ${authorLabel(question)}` : ""}</small></span></button></li>)}</ul>}
    </div>
  </Sheet>;
}

export function CardsSheet({ sessionId, questions, onClose, onDone }: { sessionId: string; questions: readonly { id: string; text: string }[]; onClose: () => void; onDone: (count: number, href: string | null) => void }) {
  const [boards, setBoards] = useState<townhall.BoardOption[] | null>(null);
  const [boardId, setBoardId] = useState<string>("");
  const [columns, setColumns] = useState<Array<{ id: string; name: string }>>([]);
  const [columnId, setColumnId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    townhall.listBoards().then((body) => {
      const writable = body.boards.filter((board) => board.level === undefined || ["owner", "manage", "edit"].includes(board.level));
      setBoards(writable.map((board) => ({ id: board.id, name: board.name })));
      if (writable[0]) setBoardId(writable[0].id);
    }, () => setBoards([]));
  }, []);
  useEffect(() => {
    if (!boardId) return;
    townhall.listColumns(boardId).then((body) => { setColumns(body.columns); setColumnId(body.columns[0]?.id ?? ""); }, () => setColumns([]));
  }, [boardId]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await townhall.toCards(sessionId, boardId, columnId, questions.map((question) => question.id));
      onDone(result.cards.length, result.cards.length === 1 ? result.cards[0]!.href : null);
      onClose();
    } catch (reason) {
      setError(errorText(reason, "Could not create the cards"));
    } finally {
      setBusy(false);
    }
  };
  return <Sheet title={questions.length === 1 ? "Make a card" : `Make ${questions.length} cards`} onClose={onClose} busy={busy}>
    <div className="file-dialog-form th-form">
      <ul className="th-card-preview">{questions.slice(0, 5).map((question) => <li key={question.id}>{question.text}</li>)}{questions.length > 5 && <li>and {questions.length - 5} more</li>}</ul>
      {boards !== null && boards.length === 0
        ? <p className="th-hint">You have no boards you can add cards to.</p>
        : <>
          <div className="ui-field"><span>Board</span><Select label="Board" value={boardId || null} onChange={setBoardId} options={(boards ?? []).map((board) => ({ value: board.id, label: board.name }))} placeholder={boards === null ? "Loading…" : "Choose a board"} /></div>
          <div className="ui-field"><span>Column</span><Select label="Column" value={columnId || null} onChange={setColumnId} options={columns.map((column) => ({ value: column.id, label: column.name }))} placeholder="Choose a column" /></div>
        </>}
      {error && <p className="ui-field-error" role="alert">{error}</p>}
      <footer className="file-dialog-actions">
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary-button" onClick={() => { void create(); }} disabled={busy || !boardId || !columnId}>{busy ? "Creating…" : questions.length === 1 ? "Create card" : "Create cards"}</button>
      </footer>
    </div>
  </Sheet>;
}

export function ShareSheet({ session, memberUrl, publicUrl, publicAllowed, canManage, onPublic, onAccess, onClose }: {
  session: TownhallSessionView; memberUrl: string; publicUrl: string | null; publicAllowed: boolean; canManage: boolean;
  onPublic: (enabled: boolean) => Promise<void>; onAccess: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The QR code is of the link shown beside it (D1112): the audience link once there is one, else the team link.
  const shown = publicUrl ?? memberUrl;
  const qr = useQrCode(shown);
  const qrFigure = qr ? <figure className="th-share-qr"><img src={qr} alt={`QR code for ${shown}`} width={180} height={180} /><figcaption>{publicUrl ? "Scan to join as audience" : "Scan to open (team link)"}</figcaption></figure> : null;
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify.success("Link copied"); } catch { notify.error("Could not copy the link"); }
  };
  return <Sheet title="Invite people" onClose={onClose} busy={busy}>
    <div className="th-sheet-body th-share">
      <section>
        <h3><Link2 aria-hidden="true" />Link for your team</h3>
        <p className="th-hint">{session.visibility === "all_users" ? "Everyone signed in can open it." : session.visibility === "selected" ? "The people and groups you chose can open it." : "Only you can open it now."}</p>
        <div className="th-copy-row"><input readOnly value={memberUrl} aria-label="Link for your team" onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void copy(memberUrl); }}><Copy aria-hidden="true" />Copy</button></div>
        {canManage && <button type="button" className="ui-text-button" onClick={onAccess}>Change who has access</button>}
        {!publicUrl && qrFigure}
      </section>
      <section>
        <h3><Globe aria-hidden="true" />Audience link</h3>
        {!publicAllowed
          ? <p className="th-hint">Public townhall links are turned off for this workspace (Settings → Workspace → Public townhall links).</p>
          : publicUrl
            ? <>
              <p className="th-hint">Anyone with this link can ask, upvote, and vote, without an account. Turn it off to stop it at once.</p>
              <div className="th-copy-row"><input readOnly value={publicUrl} aria-label="Audience link" onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void copy(publicUrl); }}><Copy aria-hidden="true" />Copy</button></div>
              <button type="button" className="ui-text-button th-danger-text" disabled={busy} onClick={async () => { setBusy(true); try { await onPublic(false); } finally { setBusy(false); } }}>Turn off the audience link</button>
              {qrFigure}
            </>
            : <>
              <p className="th-hint">For people outside the workspace: they can ask, upvote, and vote, nothing else.</p>
              <button type="button" className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { await onPublic(true); } finally { setBusy(false); } }}><Globe aria-hidden="true" />Create an audience link</button>
            </>}
      </section>
    </div>
  </Sheet>;
}
