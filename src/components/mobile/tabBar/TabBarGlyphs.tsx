import { useId } from "react";
import { motion, type Transition } from "framer-motion";

/**
 * The tab bar's five glyphs, drawn for it on one 24-unit grid with one
 * stroke. Each has an outline (not here) and a filled (here) form, and each
 * arrives the way its object moves: the clapper's arm claps, the set warms
 * up like a tube, a page turns, the ribbon drops in. Nothing plays on first
 * paint, only when a tab becomes the one you are on.
 */

export interface GlyphProps {
  active: boolean;
  reduced: boolean;
}

const STROKE = 1.8;
const fade: Transition = { duration: 0.2, ease: [0.37, 0, 0.63, 1] };
const fadeOut: Transition = { duration: 0.14, ease: [0.37, 0, 0.63, 1] };
const travel = [0.22, 1, 0.36, 1] as const;

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block overflow-visible"
    >
      {children}
    </svg>
  );
}

function layer(active: boolean, on: boolean) {
  const shown = active === on;
  return {
    initial: false as const,
    animate: { opacity: shown ? 1 : 0 },
    transition: shown ? fade : fadeOut,
  };
}

const HOUSE =
  "M3.9 10.4 12 3.9l8.1 6.5v8.85a1.75 1.75 0 0 1-1.75 1.75H5.65a1.75 1.75 0 0 1-1.75-1.75Z";
const BARS = [11.9, 14.85, 17.8];

/** Home: a house whose filled form carries the mark's bars, drawn in. */
export function HomeGlyph({ active, reduced }: GlyphProps) {
  const mask = useId();
  return (
    <Svg>
      <motion.path d={HOUSE} {...layer(active, false)} />
      <motion.g {...layer(active, true)}>
        <mask
          id={mask}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="24"
          height="24"
        >
          <path d={HOUSE} fill="#fff" stroke="#fff" />
          {BARS.map((y, index) => (
            <motion.rect
              key={y}
              x="7.6"
              y={y}
              width="8.8"
              height="1.45"
              rx="0.7"
              fill="#000"
              stroke="none"
              style={{ transformBox: "fill-box", transformOrigin: "0% 50%" }}
              initial={false}
              animate={{ scaleX: active || reduced ? 1 : 0 }}
              transition={
                active && !reduced
                  ? { duration: 0.34, delay: 0.06 + index * 0.06, ease: travel }
                  : { duration: 0 }
              }
            />
          ))}
        </mask>
        <rect
          width="24"
          height="24"
          fill="currentColor"
          stroke="none"
          mask={`url(#${mask})`}
        />
      </motion.g>
    </Svg>
  );
}

const CLAP_ARM = { x: 3.4, y: 4.6, width: 17.2, height: 3.7 };
const CLAP_STRIPES = [
  "M8.2 4.6 6.3 8.3",
  "M12.7 4.6 10.8 8.3",
  "M17.2 4.6 15.3 8.3",
];

/** Films: a clapperboard; its arm lifts and claps shut. */
export function FilmGlyph({ active, reduced }: GlyphProps) {
  const mask = useId();
  return (
    <Svg>
      <motion.rect
        x="3.4"
        y="10"
        width="17.2"
        height="10.4"
        rx="2"
        {...layer(active, false)}
      />
      <motion.rect
        x="3.4"
        y="10"
        width="17.2"
        height="10.4"
        rx="2"
        fill="currentColor"
        {...layer(active, true)}
      />
      {/* The arm turns on its hinge at the board's left. A clap speeds up
          into the board, so the closing half eases in, not out. */}
      <motion.g
        style={{ transformBox: "view-box", transformOrigin: "3.4px 8.3px" }}
        initial={false}
        animate={{ rotate: active && !reduced ? [0, -22, 0] : 0 }}
        transition={
          active && !reduced
            ? {
                duration: 0.34,
                times: [0, 0.5, 1],
                ease: ["easeOut", "easeIn"],
              }
            : { duration: 0.18 }
        }
      >
        <motion.g {...layer(active, false)}>
          <rect {...CLAP_ARM} rx="1" />
          {CLAP_STRIPES.map((d) => (
            <path key={d} d={d} />
          ))}
        </motion.g>
        <motion.g {...layer(active, true)}>
          <mask
            id={mask}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="24"
            height="24"
          >
            <rect {...CLAP_ARM} rx="1" fill="#fff" stroke="#fff" />
            {CLAP_STRIPES.map((d) => (
              <path key={d} d={d} stroke="#000" strokeWidth="1.5" />
            ))}
          </mask>
          <rect
            width="24"
            height="24"
            fill="currentColor"
            stroke="none"
            mask={`url(#${mask})`}
          />
        </motion.g>
      </motion.g>
    </Svg>
  );
}

/** Shows: a set with rabbit ears; its screen warms up like a tube, a line first. */
export function ShowsGlyph({ active, reduced }: GlyphProps) {
  const on = reduced
    ? { opacity: active ? 1 : 0, scaleX: 1, scaleY: 1 }
    : active
      ? { opacity: 1, scaleX: [0.04, 1, 1], scaleY: [0.12, 0.12, 1] }
      : { opacity: [1, 1, 0], scaleX: [1, 1, 0.04], scaleY: [1, 0.12, 0.12] };
  return (
    <Svg>
      <path d="M8.4 2.9 12 6.7l3.6-3.8" />
      <rect x="2.9" y="6.9" width="18.2" height="13.4" rx="2.7" />
      <motion.rect
        x="5.55"
        y="9.55"
        width="12.9"
        height="8.1"
        rx="1.1"
        fill="currentColor"
        stroke="none"
        style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}
        initial={false}
        animate={on}
        transition={
          reduced
            ? fade
            : active
              ? { duration: 0.4, times: [0, 0.45, 1], ease: travel }
              : { duration: 0.22, times: [0, 0.5, 1], ease: "easeIn" }
        }
      />
    </Svg>
  );
}

const PAGE_LEFT =
  "M12 6.7C10.15 5.3 7.4 4.75 3.3 5v13.65c4.1-.25 6.85.3 8.7 1.7Z";
const PAGE_RIGHT =
  "M12 6.7c1.85-1.4 4.6-1.95 8.7-1.7v13.65c-4.1-.25-6.85.3-8.7 1.7Z";

/** Books: an open book; a page turns over the spine as it opens to you. */
export function BookGlyph({ active, reduced }: GlyphProps) {
  const mask = useId();
  return (
    <Svg>
      <motion.g {...layer(active, false)}>
        <path d={PAGE_LEFT} />
        <path d={PAGE_RIGHT} />
      </motion.g>
      <motion.g {...layer(active, true)}>
        <mask
          id={mask}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="24"
          height="24"
        >
          <path d={PAGE_LEFT} fill="#fff" stroke="#fff" />
          <path d={PAGE_RIGHT} fill="#fff" stroke="#fff" />
          <path d="M12 7.4v12.2" stroke="#000" strokeWidth="1.3" />
        </mask>
        <rect
          width="24"
          height="24"
          fill="currentColor"
          stroke="none"
          mask={`url(#${mask})`}
        />
      </motion.g>
      {/* The turning page: its edge, in the bar's own ground, crossing from
          the right leaf to the left about the spine. */}
      {!reduced ? (
        <motion.path
          d={PAGE_RIGHT}
          fill="currentColor"
          stroke="var(--tabbar-ground, #08090a)"
          strokeWidth="1.1"
          style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}
          initial={false}
          animate={
            active
              ? { scaleX: [1, -1], opacity: [0, 1, 1, 0] }
              : { scaleX: 1, opacity: 0 }
          }
          transition={
            active
              ? {
                  scaleX: {
                    duration: 0.46,
                    delay: 0.04,
                    ease: [0.37, 0, 0.63, 1],
                  },
                  opacity: { duration: 0.5, times: [0, 0.12, 0.85, 1] },
                }
              : { duration: 0 }
          }
        />
      ) : null}
    </Svg>
  );
}

const RIBBON =
  "M6.3 3.6h11.4a1 1 0 0 1 1 1v15.55a.5.5 0 0 1-.78.42L12 16.75l-5.92 3.82a.5.5 0 0 1-.78-.42V4.6a1 1 0 0 1 1-1Z";

/** My List: a ribbon marker; it drops in from the top edge, as from a book. */
export function ListGlyph({ active, reduced }: GlyphProps) {
  const clip = useId();
  return (
    <Svg>
      <motion.path d={RIBBON} {...layer(active, false)} />
      <clipPath id={clip}>
        <rect x="-4" y="2.7" width="32" height="24" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <motion.path
          d={RIBBON}
          fill="currentColor"
          initial={false}
          animate={{ opacity: active ? 1 : 0, y: active || reduced ? 0 : -7 }}
          transition={
            active && !reduced
              ? {
                  y: { duration: 0.42, ease: travel },
                  opacity: { duration: 0.12 },
                }
              : fadeOut
          }
        />
      </g>
    </Svg>
  );
}
