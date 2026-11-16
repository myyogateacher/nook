import { Component, type ReactNode } from "react";
import { useDisabledModules } from "../modules";
import { boardHeaderItemsFor, cardFaceBadges, cardHeaderActions, cardSections, registeredCardFaceBadges, timelineDecorations, type CardSlotCard, type CardSlotProps } from "./cardSlots";

/**
 * Where the card dialog, the card face, and the Timeline render the slots other modules registered
 * (src/ui/cardSlots.ts, D834). Each outlet renders nothing when no slot applies, so a board without
 * module slots is unchanged. A slot that throws is dropped (logged), never the card around it.
 */
class SlotBoundary extends Component<{ children: ReactNode; id: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error(`Card slot ${this.props.id} failed`, error); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The card dialog's module sections in one area: `side` under Relations, `main` under Attachments. */
export function CardSectionsOutlet({ area, ...props }: CardSlotProps & { area: "side" | "main" }) {
  const disabled = useDisabledModules();
  const list = cardSections(area, disabled);
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Section }) => <SlotBoundary key={id} id={id}><Section {...props} /></SlotBoundary>)}</>;
}

/** The card dialog header's module actions (before Move). */
export function CardHeaderActionsOutlet(props: CardSlotProps) {
  const disabled = useDisabledModules();
  const list = cardHeaderActions(disabled);
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Action }) => <SlotBoundary key={id} id={id}><Action {...props} /></SlotBoundary>)}</>;
}

/** Whether any face badge applies (the face shows its footer line for them). */
export const useCardFaceBadges = () => cardFaceBadges(useDisabledModules());

/**
 * Whether a face badge has something for this card (D1386): each badge's `useShows` hook runs for
 * every registered badge (a list fixed at startup, so the hooks keep their order), then the modules
 * that are off drop out.
 */
export function useCardFaceBadgesShown(card: CardSlotCard) {
  const disabled = useDisabledModules();
  const shows = new Map(registeredCardFaceBadges().map((badge) => [badge.id, badge.useShows ? badge.useShows(card) : true]));
  return cardFaceBadges(disabled).some((badge) => shows.get(badge.id));
}

/** The card face's module badges, after the built-in counts. */
export function CardFaceBadgesOutlet({ card }: { card: CardSlotCard }) {
  const list = useCardFaceBadges();
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Badge }) => <SlotBoundary key={id} id={id}><Badge card={card} /></SlotBoundary>)}</>;
}

/** A Timeline bar's module decorations (C14's logged-vs-estimate fill). */
export function TimelineDecorationsOutlet({ card }: { card: CardSlotCard }) {
  const list = timelineDecorations(useDisabledModules());
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Decoration }) => <SlotBoundary key={id} id={id}><Decoration card={card} /></SlotBoundary>)}</>;
}

/** A board header's module items, after the card count (C22, D1048). */
export function BoardHeaderItemsOutlet({ board }: { board: { id: string; name: string } }) {
  const list = boardHeaderItemsFor(useDisabledModules());
  if (list.length === 0) return null;
  return <>{list.map(({ id, component: Item }) => <SlotBoundary key={id} id={id}><Item board={board} /></SlotBoundary>)}</>;
}
