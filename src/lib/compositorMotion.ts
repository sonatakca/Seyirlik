/**
 * Transforms that framer-motion hands to the compositor.
 *
 * framer-motion runs opacity and a whole `transform` string through the Web
 * Animations API, which the compositor plays at the display's full rate (120 Hz
 * on ProMotion) whatever the main thread is doing. Its x/y/scale shorthands are
 * instead recomputed by script and written inline every frame, which Safari
 * holds to 60 fps and which stalls whenever the page is busy.
 *
 * Two rules keep the whole-string form correct:
 * - Both ends name the same functions in the same order, so they interpolate
 *   function by function. `move()` always writes translate() then scale().
 * - Nothing animates *from* "none": framer-motion would zero every number in
 *   the target and start at scale(0). An animation that may start at rest
 *   names its start, `[REST, move(...)]`.
 *
 * At rest an element should carry no transform at all, as it did with the
 * shorthands, so it never becomes a stacking context or the containing block
 * of a fixed child: `settle` puts "none" back once an entrance lands.
 */
export interface Move {
  x?: number;
  y?: number;
  scale?: number;
}

export function move({ x = 0, y = 0, scale = 1 }: Move = {}): string {
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

export const REST = move();

/** The target of an entrance that lands at rest and leaves no transform. */
export const settle = {
  transform: REST,
  transitionEnd: { transform: "none" },
} as const;
