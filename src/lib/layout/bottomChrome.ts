/*
 * The bottom-right corner is shared ground. The hero's carousel control sits
 * there whenever a carousel hero is on screen, and the notification pile lives
 * there on every page. Neither can measure the other — the carousel renders
 * into a portal on document.body and the pile is mounted by the app shell — so
 * whoever occupies the corner publishes how much of it is taken, and the pile
 * stacks on top of that rather than through it.
 *
 * A CSS custom property rather than React context: the pile only ever needs
 * the number inside a calc(), the two components share no ancestor worth
 * threading a provider through, and a length on the document element crosses
 * the portal boundary for free.
 *
 * The value is a distance from the bottom edge of the viewport up to the top of
 * the occupying element, including whatever gap it wants kept above it — so it
 * can be compared directly against another element's `bottom` with max().
 */

const PROPERTY = "--seyirlik-bottom-chrome";

/*
 * How the corner changes hands, shared by both sides of it.
 *
 * The occupant animates itself in and out, and the pile has to travel the
 * distance the occupant frees or takes at exactly the rate the occupant does —
 * anything else reads as two separate movements that happen to overlap. One
 * curve, one duration, one delay, held here rather than copied into each end,
 * because they are only right while they are identical.
 */
export const BOTTOM_CHROME_MOTION = {
  durationS: 1,
  delayS: 0.1,
  ease: [0.25, 1, 0.5, 1] as [number, number, number, number],
};

/**
 * The part of the right-hand edge an occupant takes, in pixels measured up from
 * the bottom of the viewport: `top` to where it ends, `bottom` to where it
 * starts. An occupant that reaches the bottom edge has a `bottom` of 0, and
 * nothing can stand underneath it.
 */
export interface BottomChromeBand {
  top: number;
  bottom: number;
}

/*
 * Keyed claims, tallest wins. One hero at a time is the realistic case, but a
 * page that mounts a second one while the first animates away would otherwise
 * have the loser's teardown clear the winner's reservation.
 */
const claims = new Map<string, BottomChromeBand>();

/**
 * What kind of change the pile is being told about.
 *
 * `tracking` is an occupant that moved because the page moved under it — a
 * control scrolling with its section. The pile follows that on the same frame:
 * easing towards a target that changes every frame is how it used to stand
 * still for the whole of a scroll and then catch up once it ended. Anything
 * else is the corner changing hands, which the pile travels in step with.
 */
export interface BottomChromeChange {
  tracking: boolean;
}

/*
 * The property alone tells the pile where to stand, but not that it has moved,
 * and the pile has to travel the distance rather than teleport it. Nothing
 * observes a custom property changing, so the reservation announces itself.
 */
const listeners = new Set<(change: BottomChromeChange) => void>();

/** The tallest standing claim's band, or `null` when the corner is free. */
export function getBottomChromeBand(): BottomChromeBand | null {
  let tallest: BottomChromeBand | null = null;
  for (const band of claims.values()) {
    if (!tallest || band.top > tallest.top) tallest = band;
  }
  return tallest;
}

/** The tallest standing claim, in pixels; `0` when the corner is free. */
export function getBottomChrome(): number {
  return getBottomChromeBand()?.top ?? 0;
}

/** Called after every change to the reservation. Returns an unsubscribe. */
export function subscribeToBottomChrome(
  listener: (change: BottomChromeChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function flush(change: BottomChromeChange) {
  const root = document.documentElement;

  /*
   * A property written on the document element restyles the whole document,
   * and a tracking change comes on every frame of a scroll: that alone was
   * most of the main thread's work while the home page scrolled. The pile,
   * the one reader, writes the lane it stands on to itself (see
   * NotificationHost), so the document's value only has to be right for a
   * pile that has not placed itself yet — which a handover or a release
   * always rewrites.
   */
  if (claims.size === 0) {
    root.style.removeProperty(PROPERTY);
  } else if (!change.tracking || !root.style.getPropertyValue(PROPERTY)) {
    root.style.setProperty(PROPERTY, `${getBottomChrome()}px`);
  }

  for (const listener of listeners) listener(change);
}

/**
 * Reserve `heightPx` of the bottom edge under `claimId`.
 *
 * `bottomPx` is where the occupant starts, for one that does not reach the
 * bottom edge; `tracking` says the claim moved because the page scrolled.
 */
export function claimBottomChrome(
  claimId: string,
  heightPx: number,
  options: { bottomPx?: number; tracking?: boolean } = {},
) {
  if (typeof document === "undefined") return;
  const band = { top: heightPx, bottom: Math.max(0, options.bottomPx ?? 0) };
  const current = claims.get(claimId);
  if (current && current.top === band.top && current.bottom === band.bottom) {
    return;
  }

  claims.set(claimId, band);
  // A claim that is new is the corner changing hands, however it was made.
  flush({ tracking: Boolean(current) && options.tracking === true });
}

export function releaseBottomChrome(claimId: string) {
  if (typeof document === "undefined" || !claims.delete(claimId)) {
    return;
  }

  flush({ tracking: false });
}
