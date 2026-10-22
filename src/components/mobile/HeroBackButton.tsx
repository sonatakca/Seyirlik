import { createPortal } from "react-dom";
import { BackButton } from "../BackButton";

/**
 * Where the back button stands over the phone's title hero (a phone, or a
 * tablet upright): on the picture's top-left, eight pixels inside the floating
 * backdrop. The visible circle is 38px within a 44px touch target, and
 * remains pinned as the page
 * scrolls.
 *
 * It is drawn into `document.body` because the page sits inside a
 * transformed ancestor, and a transform makes `position: fixed` relative to
 * itself: in place, the button stood 26-44px off the copy's edge and
 * scrolled away with the page.
 */
export const HERO_BACK_POSITION =
  "fixed left-6 top-[calc(4rem+env(safe-area-inset-top))] z-[80]";

export function HeroBackButton({ fallbackTo }: { fallbackTo: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <BackButton
      fallbackTo={fallbackTo}
      label=""
      variant="hero"
      noYShift
      className={`${HERO_BACK_POSITION} !border-0 !bg-transparent !p-0 !backdrop-blur-none !hover:bg-transparent`}
      buttonClassName="!h-11 !w-11 before:absolute before:inset-[3px] before:rounded-full before:border before:border-white/15 before:bg-[#0b0c0e]/90 [&_svg]:relative"
    />,
    document.body,
  );
}

/** The button's place while the page loads, the same size and spot. */
export function HeroBackButtonPlaceholder() {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className={HERO_BACK_POSITION}>
      <div className="h-11 w-11 p-[3px]">
        <div className="shimmer h-full w-full rounded-full" />
      </div>
    </div>,
    document.body,
  );
}
