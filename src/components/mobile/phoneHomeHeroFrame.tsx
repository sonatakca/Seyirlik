import type { ReactNode } from "react";

/**
 * The phone home hero's frame: the room the deck stands in, the card's size
 * and edge, and the rows under it. The hero (`PhoneHomeHero`) and its loading
 * state are both built from these, so every placeholder is the size of, and
 * where, the piece that replaces it. Kept apart from the hero so the loading
 * state can be drawn before the hero's own code has arrived.
 */

/**
 * The front card's width: at most 70% of the screen, so a neighbour shows at
 * each side, and small enough for the card and everything under it to stand
 * above the tab bar. Taken off the height: the page's top inset, the progress
 * line, the facts and the actions with their gaps, and the tab bar.
 */
export const CARD_WIDTH =
  "min(20.5rem, 70vw, max(13rem, calc((100svh - 19.25rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 1.5)))";
export const CARD_GAP_PX = 14;
/** A neighbour stands back: smaller and in shade. */
export const SIDE_SCALE = 0.88;
export const SIDE_SHADE = 0.55;

export const ROUND =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full";

/** The rows under the deck: their heights are fixed, so nothing moves. */
export const PROGRESS = "mt-4 h-[2px] overflow-hidden rounded-full bg-white/15";
export const FACTS =
  "mt-3 h-5 w-full truncate text-center text-[0.8125rem] font-semibold leading-5 text-white/[0.78]";
export const ACTIONS = "mt-3 flex h-11 w-full items-center gap-2";

/** The room the deck stands in, lit by the front poster's own colours. */
export function PhoneHeroFrame({
  ambient,
  children,
}: {
  ambient?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="full-bleed relative overflow-hidden bg-zinc-950 pb-8 pt-[calc(4.75rem+env(safe-area-inset-top))]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(82,82,91,0.28),transparent_46%),linear-gradient(180deg,#111113_0%,#070708_55%,#050506_100%)]" />
      {ambient}
      <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/38 to-[#050506]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#050506] via-[#050506]/20 to-black/30" />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#050506] to-transparent" />
      <div className="relative flex w-full flex-col items-center">
        {children}
      </div>
    </section>
  );
}

/** A card's edge and fill, the same for a poster and its placeholder. */
export function CardShell({ children }: { children: ReactNode }) {
  return (
    <div className="cinematic-card-shadow relative aspect-[2/3] w-full rounded-[2rem] bg-gradient-to-t from-zinc-400/35 via-zinc-600/18 to-transparent p-px shadow-2xl">
      <div className="relative h-full w-full overflow-hidden rounded-[calc(2rem-1px)] bg-zinc-900">
        {children}
      </div>
    </div>
  );
}

export function PhoneHomeHeroSkeleton() {
  return (
    <PhoneHeroFrame>
      <div className="relative" style={{ width: CARD_WIDTH }}>
        <div className="relative aspect-[2/3] w-full">
          {[-1, 1].map((side) => (
            <div
              key={side}
              className="absolute inset-0"
              style={{
                transform: `translateX(calc(${side} * (100% + ${CARD_GAP_PX}px))) scale(${SIDE_SCALE})`,
                opacity: 1 - SIDE_SHADE,
              }}
            >
              <CardShell>
                <div className="shimmer absolute inset-0" />
              </CardShell>
            </div>
          ))}
          <div className="absolute inset-0">
            <CardShell>
              <div className="shimmer absolute inset-0" />
            </CardShell>
          </div>
        </div>
        <div className={PROGRESS} />
        <div className={`${FACTS} flex justify-center`}>
          <div className="shimmer h-full w-3/5 rounded-md" />
        </div>
        <div className={ACTIONS}>
          <div className="shimmer h-11 flex-1 rounded-full" />
          <div className={`shimmer ${ROUND}`} />
          <div className={`shimmer ${ROUND}`} />
        </div>
      </div>
    </PhoneHeroFrame>
  );
}
