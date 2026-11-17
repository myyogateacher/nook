import type { ComponentType } from "react";
import type { Notifier } from "./notify";

/**
 * Card slots (docs/plan/WORKSPACE_MODULES.md §F.2, D834): the places other modules add to a Tasks card
 * without editing src/tasks. Time adds a "Time" section and a ▶ header action; Goals a "Goal" field;
 * Time's logged-vs-estimate fill decorates Timeline bars. A leaf module (types only), so the card
 * dialog, the card face, and the registry read it without cycles.
 *
 * Each slot names its module; the card renders a slot only while that module is on for the viewer
 * (useDisabledModules), and renders nothing at all when no slot is registered, so the card looks
 * exactly as it did before any module registered (the buttonMetrics check).
 */

/** What a slot knows about the card: ids and the few fields every module needs. */
export type CardSlotCard = { id: string; board_id: string; key?: string | null; title: string; estimate?: number | null };

export type CardSlotProps = {
  card: CardSlotCard;
  /** The viewer may not write (viewer/guest role, or comment level). */
  readOnly: boolean;
  /** A unique id prefix for headings and fields inside the dialog. */
  idPrefix: string;
  /** The card dialog's toasts. */
  notify: Notifier;
};

/**
 * A section of the card dialog: `side` under Relations (the fields column on a wide page), `main`
 * under Attachments (above Comments). `order` sorts within an area (lower first; ties by module order).
 */
export type CardSectionDef = { id: string; area: "side" | "main"; order?: number; component: ComponentType<CardSlotProps>; module?: string };

/**
 * A small badge on the card face's footer line (Time's "1h 30m"); it returns null for nothing.
 * `useShows` (a hook, D1386) says whether it has something for this card, so a card none applies to
 * keeps no footer line; without it the badge counts as showing.
 */
export type CardFaceBadgeDef = { id: string; order?: number; component: ComponentType<{ card: CardSlotCard }>; module?: string; useShows?: (card: CardSlotCard) => boolean };

/** An icon button in the card dialog's header, before Move (Time's ▶ Start timer). */
export type CardHeaderActionDef = { id: string; order?: number; component: ComponentType<CardSlotProps>; module?: string };

/** A decoration inside a Timeline bar (C14: logged-vs-estimate fill), absolutely positioned in the bar. */
export type TimelineDecorationDef = { id: string; order?: number; component: ComponentType<{ card: CardSlotCard }>; module?: string };

/** An item in a board's header after its card count (C22: the goal the board contributes to). Renders nothing when it has nothing to say. */
export type BoardHeaderItemDef = { id: string; order?: number; component: ComponentType<{ board: { id: string; name: string } }>; module?: string };

const sections: CardSectionDef[] = [];
const boardHeaderItems: BoardHeaderItemDef[] = [];
const badges: CardFaceBadgeDef[] = [];
const actions: CardHeaderActionDef[] = [];
const decorations: TimelineDecorationDef[] = [];

function put<T extends { id: string; order?: number }>(list: T[], def: T) {
  const at = list.findIndex((item) => item.id === def.id);
  if (at >= 0) list.splice(at, 1, def);
  else list.push(def);
  // Stable: equal orders keep registration (module) order.
  list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export const registerCardSection = (def: CardSectionDef) => put(sections, def);
export const registerCardFaceBadge = (def: CardFaceBadgeDef) => put(badges, def);
export const registerCardHeaderAction = (def: CardHeaderActionDef) => put(actions, def);
export const registerTimelineDecoration = (def: TimelineDecorationDef) => put(decorations, def);
export const registerBoardHeaderItem = (def: BoardHeaderItemDef) => put(boardHeaderItems, def);

const shown = <T extends { module?: string }>(list: readonly T[], disabled: readonly string[]) => list.filter((item) => !item.module || !disabled.includes(item.module));

/** The slots to render for a viewer whose `disabled` modules are off. */
export const cardSections = (area: "side" | "main", disabled: readonly string[] = []) => shown(sections, disabled).filter((section) => section.area === area);
export const cardFaceBadges = (disabled: readonly string[] = []) => shown(badges, disabled);
/** Every registered face badge, on or off: the hooks of `useShows` run for all of them, in a fixed order. */
export const registeredCardFaceBadges = (): readonly CardFaceBadgeDef[] => badges;
export const cardHeaderActions = (disabled: readonly string[] = []) => shown(actions, disabled);
export const timelineDecorations = (disabled: readonly string[] = []) => shown(decorations, disabled);
export const boardHeaderItemsFor = (disabled: readonly string[] = []) => shown(boardHeaderItems, disabled);

/** Tests: drop every registration. */
export function clearCardSlotsForTests() {
  sections.length = 0;
  badges.length = 0;
  actions.length = 0;
  decorations.length = 0;
  boardHeaderItems.length = 0;
}
