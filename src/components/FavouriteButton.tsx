import type { CSSProperties, MouseEvent } from "react";
import { useLanguage } from "../i18n/LanguageContext";
import { useFavouriteState } from "../hooks/useFavouriteState";
import type { MediaItem } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { ListToggleIcon } from "./ui/ListToggleIcon";
import { Tooltip } from "./ui/Tooltip";

interface FavouriteButtonProps {
  item: MediaItem;
  className: string;
  style?: CSSProperties;
  iconSize?: number;
  showLabel?: boolean;
  /** What a shown label says, where the full action name will not fit. */
  shortLabel?: string;
  tooltipGroup?: string;
}

export function FavouriteButton({
  item,
  className,
  style,
  iconSize = 18,
  showLabel = false,
  shortLabel,
  tooltipGroup,
}: FavouriteButtonProps) {
  const { t } = useLanguage();
  const { isFavourite, isSaving, didFail, toggle } = useFavouriteState(item);

  const label = isFavourite
    ? t("myList.removeFromMyList")
    : t("myList.addToMyList");
  const tooltipLabel = didFail ? t("myList.couldNotSave") : label;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Cards and hero panels wrap this control in their own link/overlay, and a
    // bubbled click there would navigate away mid-save.
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  return (
    <Tooltip content={tooltipLabel} group={tooltipGroup}>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        aria-pressed={isFavourite}
        style={style}
        className={`${className} disabled:cursor-wait`}
      >
        {/* The toggle is optimistic, so the mark changes the moment it is
            pressed; a save still in flight only dims it, and a failed one
            morphs it back. */}
        <ListToggleIcon
          checked={isFavourite}
          size={iconSize}
          className={`transition-opacity duration-200 ${isSaving ? "opacity-60" : "opacity-100"}`}
        />
        {showLabel ? (
          <AnimatedWidth value={shortLabel ?? label}>
            <AnimatedText value={shortLabel ?? label} />
          </AnimatedWidth>
        ) : null}
      </button>
    </Tooltip>
  );
}
