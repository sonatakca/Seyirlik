import { useIsMobileView } from "../../hooks/useIsMobileView";
import { navbarVeilGradient, navbarVeilHeight } from "../../lib/navbarBackdrop";

/**
 * The stage's top edge, very lightly darkened under the navbar only. Over the
 * stage and anything rising onto it, under the queue (which shares its layer
 * and comes later). The navbar wordmark measures its backdrop through it.
 */
export function NavbarVeil() {
  const height = navbarVeilHeight(useIsMobileView());
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-[4]"
      style={{ height, background: navbarVeilGradient(height) }}
    />
  );
}
