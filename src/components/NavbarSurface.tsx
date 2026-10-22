import { motion, useReducedMotion } from "framer-motion";
import "./NavbarSurface.css";

interface NavbarSurfaceProps {
  shown: boolean;
  variant: "desktop" | "mobile";
}

/**
 * What the bar stands on: the room's black falling from the top of the
 * screen, thinning to nothing a little below the bar, with no edge. Its own
 * layer under the links, never the header itself: a backdrop-filter there
 * would become the containing block of every fixed panel inside it.
 *
 * Scroll only chooses open or closed; each trip takes 300ms, including a
 * reversal mid-flight. Each layer fades itself: fading their parent would
 * make it the blur's backdrop root. The blur would drop what it blurs for
 * the length of the fade, then snap.
 */
export function NavbarSurface({ shown, variant }: NavbarSurfaceProps) {
  const reduced = useReducedMotion();
  const opacity = shown ? 1 : 0;
  const transition = {
    type: "tween" as const,
    duration: reduced ? 0.12 : 0.3,
    ease: "easeOut" as const,
  };

  return (
    <div aria-hidden="true" className="navbar-surface" data-variant={variant}>
      <motion.span
        className="navbar-surface__veil"
        initial={false}
        animate={{ opacity }}
        transition={transition}
      />
      <motion.span
        className="navbar-surface__shade"
        initial={false}
        animate={{ opacity }}
        transition={transition}
      />
    </div>
  );
}
