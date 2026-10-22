import { formatRuntime } from "../../lib/format";
import type { MediaItem } from "../../lib/types";

/** Shared geometry for the floating backdrop, reflected copy and centre dock. */

export const PHONE_TITLE_HERO_SECTION = "relative w-full bg-[#050607] pb-6";
/** The backdrop starts below the separate navbar, inside the 16px page gutter. */
export const PHONE_TITLE_HERO_FRAME =
  "phone-title-frame relative mx-4 pt-[calc(3.5rem+env(safe-area-inset-top))]";
export const PHONE_TITLE_HERO_PICTURE =
  "relative aspect-video w-full overflow-hidden rounded-t-2xl";
/** The logo lives below the backdrop, with sixteen pixels of space above it. */
export const PHONE_TITLE_HERO_LOGO_BOX =
  "relative mx-auto mb-3 flex h-auto min-h-12 w-[min(18rem,100%)] items-end justify-center";
export const PHONE_TITLE_HERO_COPY =
  "relative isolate overflow-hidden rounded-b-2xl px-4 pt-4 pb-6";
export const PHONE_TITLE_HERO_FACTS = "flex min-h-5 items-center";
export const PHONE_TITLE_HERO_OVERVIEW = "mt-2";
export const PHONE_TITLE_HERO_ACTIONS = "phone-title-dock";
export const PHONE_TITLE_HERO_PLAY = "hero-dock-play";
export const PHONE_TITLE_HERO_ROW = "hero-dock-row";
export const PHONE_TITLE_HERO_ACTION =
  "hero-dock-action focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
/** The size of a labelled action's mark. */
export const PHONE_TITLE_ACTION_ICON = 16;
/** The column each labelled action stands in. */
export const PHONE_TITLE_HERO_ACTION_SLOT =
  "flex min-w-0 flex-1 justify-center";

/**
 * Where the logo's box lies over the backdrop, as shares of it, on a 390px
 * phone (the backdrop is shown whole): what its shadow is measured against.
 */
export const PHONE_TITLE_LOGO_REGION = {
  left: 16 / 390,
  top: 1 - (16 + 44) / 219,
  width: 0.43,
  height: 44 / 219,
};

/** The facts line, as the home hero writes it. */
export function phoneTitleFacts(
  item: MediaItem,
  labels: { season: string; hourShort: string; minuteShort: string },
) {
  return [
    item.ProductionYear,
    formatRuntime(item.RunTimeTicks, labels),
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");
}
