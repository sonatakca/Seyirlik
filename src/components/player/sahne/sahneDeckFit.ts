/**
 * Which of the deck's controls fit in its width.
 *
 * The deck is exactly as wide as the picture, and in the lobby the picture is
 * a little over half the screen, so on a narrow window the full row does not
 * fit. It gives up what is least needed first, a step at a time: the end time,
 * the room the volume slider opens into, Apple's full screen, picture in
 * picture, the five-second steps, the episode list, the volume, then the
 * lobby button's word and the clock's total. Play, the time, the lobby,
 * settings and full screen always stay. Anything that is a control and has to
 * go moves into a "more" menu at the end of the row, so nothing is lost.
 */
export type DeckPart =
  | "ends"
  | "volumeSlider"
  | "native"
  | "pip"
  | "seek"
  | "queue"
  | "volume"
  | "salonLabel"
  | "duration";

/** Parts that are controls: hiding one of them needs the more menu. */
export const MENU_PARTS: ReadonlySet<DeckPart> = new Set([
  "native",
  "pip",
  "seek",
  "queue",
  "volume",
]);

export const DECK_GAP = 2;
export const DECK_ICON = 44;
const PLAY = 58;
const CLOCK_PAD = 24;
/** A tabular digit or separator at the clock's 14px heavy weight. */
const CLOCK_CHAR = 8.4;

export interface DeckFitInput {
  /** The row's width: the deck's, plus the row's own bleed of 10px a side. */
  width: number;
  /** "36:14" — the time shown on its own. */
  current: string;
  /** " / 1:03:14" — the part that can go. */
  total: string;
  /** The lobby button with its word, measured or estimated. */
  salonWidth: number;
  hasQueue: boolean;
  canPip: boolean;
  canNative: boolean;
  canFullscreen: boolean;
}

export interface DeckFit {
  hidden: ReadonlySet<DeckPart>;
  /** Whether the more menu is needed for what was hidden. */
  more: boolean;
}

export function fitDeck(input: DeckFitInput): DeckFit {
  const parts: Array<{ part: DeckPart; width: number; items: number }> = [
    { part: "ends", width: 96, items: 1 },
    { part: "volumeSlider", width: 96, items: 0 },
  ];
  if (input.canNative) parts.push({ part: "native", width: DECK_ICON, items: 1 });
  if (input.canPip) parts.push({ part: "pip", width: DECK_ICON, items: 1 });
  parts.push({ part: "seek", width: DECK_ICON * 2, items: 2 });
  if (input.hasQueue) parts.push({ part: "queue", width: DECK_ICON, items: 1 });
  parts.push({ part: "volume", width: DECK_ICON, items: 1 });
  parts.push({ part: "salonLabel", width: Math.max(0, input.salonWidth - DECK_ICON), items: 0 });
  parts.push({ part: "duration", width: input.total.length * CLOCK_CHAR, items: 0 });

  // What always stays: play, the clock's time, the lobby button as an icon,
  // settings, and full screen where there is one.
  const always =
    PLAY +
    (input.current.length * CLOCK_CHAR + CLOCK_PAD) +
    (DECK_ICON + 6) +
    DECK_ICON +
    (input.canFullscreen ? DECK_ICON : 0);
  const alwaysItems = 4 + (input.canFullscreen ? 1 : 0);

  const hidden = new Set<DeckPart>();
  const total = () => {
    let width = always;
    let items = alwaysItems;
    let needsMore = false;
    for (const entry of parts) {
      if (hidden.has(entry.part)) {
        if (MENU_PARTS.has(entry.part)) needsMore = true;
        continue;
      }
      width += entry.width;
      items += entry.items;
    }
    if (needsMore) {
      width += DECK_ICON;
      items += 1;
    }
    return width + Math.max(0, items - 1) * DECK_GAP;
  };

  for (const entry of parts) {
    if (total() <= input.width) break;
    hidden.add(entry.part);
  }
  return { hidden, more: [...hidden].some((part) => MENU_PARTS.has(part)) };
}
