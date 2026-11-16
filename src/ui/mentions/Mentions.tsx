import { useContext, type ReactNode } from "react";
import { Avatar } from "../Avatar";
import { RoleContext } from "../../team/roleAccess";
import { splitMentions, type MentionCandidate } from "../../../shared/itemActivity";
import { cannotReadLabel } from "./mentionModel";
import "./mentions.css";

/**
 * The @mention list and chips (docs/plan/MENTIONS.md §3, §6, D1322, D1324, D1329).
 *
 * `MentionList` is presentational: the textarea picker (MentionTextarea) and the rich editor's
 * (src/editor/mention.ts) both draw it and own the state. Rows are `option`s of a `listbox`; a person
 * who cannot read the item is greyed, `aria-disabled`, and never picked.
 */

export const mentionOptionId = (listId: string, index: number) => `${listId}-option-${index}`;

export function MentionList({ id, people, active, loading, noun, onPick, onActive }: {
  id: string;
  people: readonly MentionCandidate[];
  active: number;
  loading: boolean;
  /** The item's kind word: "Can't see this card". */
  noun: string;
  onPick: (person: MentionCandidate) => void;
  onActive: (index: number) => void;
}) {
  return <div className="mention-list" id={id} role="listbox" aria-label="People to mention">
    {people.map((person, index) => <div key={person.id} id={mentionOptionId(id, index)} role="option" aria-selected={index === active} aria-disabled={!person.canRead || undefined}
      className={`mention-option${index === active ? " is-active" : ""}${person.canRead ? "" : " is-unavailable"}`}
      title={person.canRead ? undefined : `${person.displayName} can't open this ${noun}. Share it first; a mention never shares it.`}
      // mousedown, not click: the field keeps its focus and caret.
      onMouseDown={(event) => { event.preventDefault(); if (person.canRead) onPick(person); }}
      onMouseMove={() => { if (person.canRead && index !== active) onActive(index); }}>
      <Avatar className="mention-avatar" name={person.displayName} url={person.avatarUrl} />
      <span className="mention-option-text">
        <span className="mention-option-name">{person.displayName}</span>
        {!person.canRead && <small>{cannotReadLabel(noun)}</small>}
      </span>
    </div>)}
    {!people.length && <p className="mention-empty" role="status">{loading ? "Looking…" : "No one matches"}</p>}
  </div>;
}

/** Whether the signed-in person sees the Team (members, admins, viewers): their chips open profiles. */
const seesTeam = (role: string | undefined) => role !== undefined && role !== "guest";

export const memberProfilePath = (userId: string) => `/settings/team/members/${userId.toLowerCase()}`;

/** One mention as a chip: the person's initial and @Name; a button to their Team profile for people who see the Team. */
export function MentionChip({ name, userId }: { name: string; userId: string }) {
  const role = useContext(RoleContext);
  const body = <><Avatar className="mention-chip-avatar" name={name} /><span>@{name}</span></>;
  if (!seesTeam(role)) return <span className="mention-chip" data-user-id={userId}>{body}</span>;
  return <button type="button" className="mention-chip" data-user-id={userId} title={`Open ${name}'s profile`}
    onClick={(event) => { event.stopPropagation(); window.dispatchEvent(new CustomEvent("nook:open-path", { detail: { path: memberProfilePath(userId) } })); }}>{body}</button>;
}

/** Plain text with its mentions drawn as chips (card comments, item comments). Line breaks are kept by the container's CSS. */
export function MentionText({ text }: { text: string }): ReactNode {
  const parts = splitMentions(text);
  if (parts.length === 1 && parts[0]!.type === "text") return text;
  return <>{parts.map((part, index) => part.type === "text" ? part.text : <MentionChip key={index} name={part.name} userId={part.userId} />)}</>;
}
