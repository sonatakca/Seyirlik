import type { MouseEvent, ReactNode } from "react";
import { motion } from "framer-motion";
import { move, REST } from "../../../lib/compositorMotion";
import { NavLink } from "react-router-dom";
import type { TabDef } from "./useTabBar";

// A press starts at rest, so it names its start (see compositorMotion).
const GLYPH_PRESS = { transform: [REST, move({ scale: 0.84 })] };

// How bright a glyph stands when its tab is not the lit one.
const DIM = 0.5;

interface TabButtonProps {
  tab: TabDef;
  index: number;
  /** The tab you are on, or the one a scrubbing finger is over. */
  lit: boolean;
  reduced: boolean;
  className: string;
  onTabClick: (event: MouseEvent<HTMLAnchorElement>, index: number) => void;
  children?: ReactNode;
}

/**
 * One tab: its glyph and whatever the route sets beside it. A finger on it
 * presses the glyph in; lifting lets it back out. The glyph fills for the
 * lit tab, so a finger sliding along the bar plays each one it crosses.
 */
export function TabButton({
  tab,
  index,
  lit,
  reduced,
  className,
  onTabClick,
  children,
}: TabButtonProps) {
  const { Glyph } = tab;
  return (
    <NavLink
      to={tab.to}
      aria-label={tab.label}
      draggable={false}
      onClick={(event) => onTabClick(event, index)}
      data-lit={lit ? "" : undefined}
      className={className}
    >
      {/* The glyph is drawn in solid white and dimmed as one layer: a
          translucent colour would let each stroke show through where it
          crosses another (the clapper's stripes, the set's ears). */}
      <motion.span
        className="relative block text-white"
        initial={false}
        animate={{ opacity: lit ? 1 : DIM }}
        whileTap={reduced ? undefined : GLYPH_PRESS}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <Glyph active={lit} reduced={reduced} />
      </motion.span>
      {children}
    </NavLink>
  );
}
