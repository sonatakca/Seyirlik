interface HandDrawnLoadingMarkProps {
  className?: string;
}

const HAND_DRAWN_ANIMATION_URL =
  "/artwork/seyirlik/animations/seyirlik-loading.webp";
const HAND_DRAWN_STILL_URL =
  "/artwork/seyirlik/animations/seyirlik-loading-still.webp";

/**
 * The hand-drawn brush circle that used to be Seyirlik's loader.
 *
 * Retired in favour of LoadingRing, which moves at the display's full frame
 * rate, and no longer rendered anywhere. It is kept, with its artwork, so it
 * can come back without being redrawn.
 */
export function HandDrawnLoadingMark({ className }: HandDrawnLoadingMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`relative block aspect-square ${className ?? "w-[min(10rem,36vw)]"}`}
    >
      <img
        src={HAND_DRAWN_ANIMATION_URL}
        alt=""
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full object-contain motion-reduce:hidden"
      />
      <img
        src={HAND_DRAWN_STILL_URL}
        alt=""
        draggable={false}
        decoding="async"
        className="absolute inset-0 hidden h-full w-full object-contain motion-reduce:block"
      />
    </span>
  );
}
