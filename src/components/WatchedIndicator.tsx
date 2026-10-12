import { useState } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import type { MediaItem } from "../lib/types";
import { isItemCompleted } from "../lib/watchStatus";
import "./WatchedIndicator.css";

/**
 * When the word "İzlendi" is shown beside the eye. A card in a grid of
 * dozens carries only the eye, and spells it out when the card is hovered
 * or focused; a header standing on its own always says it.
 */
type WatchedReveal = "always" | "hover";
type WatchedSize = "sm" | "md" | "lg";

interface WatchedIndicatorProps {
  item?: MediaItem;
  isWatched?: boolean;
  className?: string;
  reveal?: WatchedReveal;
  size?: WatchedSize;
}

/**
 * The watched seal: a dark disc from the same family as the card's corner
 * controls, holding an open eye in the live accent. Not a check: on a card the
 * check already means "in My List", and two checks in two corners read as one
 * thing said twice. The eye is the film diary's own mark for "seen".
 *
 * It is the only thing a watched card adds; the frame, the art and the logo
 * stay exactly as they are on any other card.
 *
 * It animates only when the state changes while it is on screen, so a film
 * finished elsewhere opens its eye in the grid, and opening a library of
 * watched films does not open forty of them at once.
 */
export function WatchedIndicator({
  item,
  isWatched,
  className = "",
  reveal = "always",
  size = "md",
}: WatchedIndicatorProps) {
  const { t } = useLanguage();
  const watched = isWatched ?? (item ? isItemCompleted(item) : false);
  // Watched from the first render means it was already so when the card
  // arrived; only a later change earns the opening.
  const [watchedOnArrival] = useState(watched);

  if (!watched) {
    return null;
  }

  return (
    <span
      data-reveal={reveal}
      data-size={size}
      data-opening={watchedOnArrival ? undefined : ""}
      className={`watched-seal ${className}`}
    >
      <span className="watched-seal__label">
        <span>{t("details.watched")}</span>
      </span>
      <span className="watched-seal__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <g className="watched-seal__eye">
            <path
              d="M2.75 12S6.25 5.75 12 5.75 21.25 12 21.25 12 17.75 18.25 12 18.25 2.75 12 2.75 12Z"
              stroke="currentColor"
              strokeWidth={2.25}
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="3.1" fill="currentColor" />
          </g>
        </svg>
      </span>
    </span>
  );
}
