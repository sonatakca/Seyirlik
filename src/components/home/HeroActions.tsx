import type { MouseEvent } from "react";
import { AlignLeft, Info, Play, RotateCcw } from "lucide-react";
import { motion, type Variants } from "framer-motion";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { formatRuntime } from "../../lib/format";
import type { MediaItem } from "../../lib/types";
import { canStartOverFromHero } from "../HeroSection";
import { FavouriteButton } from "../FavouriteButton";
import { DownloadButton } from "../offline/DownloadButton";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";
import "./heroDock.css";

/** A centre dock: play above labelled actions, on smoked glass over the artwork.
 * One opacity boundary fades the glass and its controls together.
 */

const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050607]";
const PRESS =
  "transition-transform duration-200 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

/**
 * The one bright thing: solid white, lifted by a soft falling shadow, with a
 * hairline that keeps its edge against a white sky.
 */
const PLAY =
  "bg-white text-zinc-950 shadow-[0_0_0_1px_rgba(0,0,0,0.07),inset_0_-1px_0_rgba(0,0,0,0.08),0_14px_32px_-10px_rgba(0,0,0,0.65),0_2px_8px_rgba(0,0,0,0.25)] transition-colors duration-200 hover:bg-zinc-100";

/** The play surface, focus ring and press, for a phone's title page too. */
export { FOCUS as HERO_FOCUS, PRESS as HERO_PRESS, PLAY as HERO_PLAY };

/**
 * "Details" from the home hero opens the title's page already on its way
 * down to the details: that page opens on this same hero, and showing it
 * twice in a row would read as nothing having happened.
 */
const SCROLL_TO_DETAILS_STATE = { scrollToDetails: true } as const;

/**
 * What play says and where it starts: the title itself, or for a title under
 * way the place it was left, with how far in and how long is left.
 */
export function heroPlayState(
  item: MediaItem,
  smartContinueItems: MediaItem[],
  t: (key: TranslationKey) => string,
) {
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const continueTarget = smartContinueItems.find((candidate) =>
    item.Type === "Series"
      ? candidate.Type === "Episode" && candidate.SeriesId === item.Id
      : candidate.Id === item.Id,
  );
  const playItem = continueTarget ?? item;
  const hasProgress =
    (continueTarget?.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const episodeLabel =
    continueTarget?.Type === "Episode" &&
    typeof continueTarget.ParentIndexNumber === "number" &&
    typeof continueTarget.IndexNumber === "number"
      ? t("media.seasonEpisodeNumber")
          .replace("{seasonNumber}", String(continueTarget.ParentIndexNumber))
          .replace("{episodeNumber}", String(continueTarget.IndexNumber))
      : null;
  const playVerb = hasProgress
    ? t("details.continueWatching")
    : t("common.play");
  const position = continueTarget?.UserData?.PlaybackPositionTicks ?? 0;
  const length = continueTarget?.RunTimeTicks ?? 0;
  const left =
    hasProgress && length > position
      ? formatRuntime(length - position, labels)
      : null;
  return {
    playItem,
    playLabel: `${playVerb}${episodeLabel ? `: ${episodeLabel}` : ""}`,
    // A phone's play button says only what it needs to: the episode it
    // starts, or the verb. The play glyph beside it already says "play".
    shortPlayLabel: episodeLabel ?? playVerb,
    canStartOver: canStartOverFromHero(playItem),
    progress: left ? { share: position / length, left } : null,
  };
}

/**
 * Which controls a row holds beside play. The row and its skeleton both read
 * this, so a placeholder is reserved for exactly what will load.
 */
export function heroRowParts({
  onTitlePage,
  isFilm,
  canStartOver,
  hasOverview,
}: {
  compact: boolean;
  onTitlePage: boolean;
  isFilm: boolean;
  canStartOver: boolean;
  hasOverview: boolean;
}) {
  return {
    startOver: canStartOver,
    details: "pill",
    // On a film's own page only: the home hero is for choosing, and a
    // series is downloaded an episode at a time.
    download: onTitlePage && isFilm && isOfflineSupported(),
    overview: hasOverview,
  } as const;
}

/** Controls in the second floor, including My List. */
export function heroRoundCount(parts: ReturnType<typeof heroRowParts>) {
  return (
    Number(Boolean(parts.details)) +
    1 +
    Number(parts.download) +
    Number(parts.overview)
  );
}

/** Play's shape on a full row; the skeleton draws its placeholder from it. */
export const PLAY_PILL = "hero-dock-play";
/** "Details" on a full row. */
export const DETAILS_PILL = "hero-dock-action";
/** What a full row's play shows, in the order it shows it. */
export const PLAY_TIME_LEFT = "font-semibold tabular-nums";

export interface HeroActionsProps {
  item: MediaItem;
  playTo: string;
  playLabel: string;
  /** What a compact row's play button shows; its name stays `playLabel`. */
  shortPlayLabel?: string;
  onPlay: (event: MouseEvent<HTMLAnchorElement>) => void;
  startOverTo: string | null;
  detailsTo: string;
  /** How far into the title the viewer is, 0–1, and how long is left. */
  progress: { share: number; left: string } | null;
  overviewId: string;
  hasOverview: boolean;
  isOverviewOpen: boolean;
  onToggleOverview: () => void;
  /**
   * On the title's own page its details are further down, so "Details"
   * scrolls there instead of opening the page it is already on.
   */
  onShowDetails?: () => void;
  /** The copy's fade, driven by the copy it sits under. */
  fade: Variants;
  /**
   * A phone's row: play takes whatever width the round buttons leave,
   * "Details" becomes a round button like the rest, and the time left gives
   * way to the progress line under the label, which carries the same news.
   */
  compact?: boolean;
}

export function HeroActions({
  item,
  playTo,
  playLabel,
  shortPlayLabel = playLabel,
  onPlay,
  startOverTo,
  detailsTo,
  progress,
  overviewId,
  hasOverview,
  isOverviewOpen,
  onToggleOverview,
  onShowDetails,
  fade,
  compact = false,
}: HeroActionsProps) {
  const { t } = useLanguage();
  const overviewLabel = isOverviewOpen
    ? t("hero.hideOverview")
    : t("hero.showOverview");
  const action = `hero-dock-action ${FOCUS}`;
  return (
    <motion.div
      initial="initial"
      animate="animate"
      exit="exit"
      variants={fade}
      className={`hero-dock ${compact ? "hero-dock-compact" : ""}`}
    >
      <span className={`flex ${PRESS}`}>
        <Link
          to={playTo}
          onClick={onPlay}
          aria-label={
            progress
              ? `${playLabel}, ${t("hero.timeLeft").replace("{time}", progress.left)}`
              : playLabel
          }
          className={`hero-dock-play ${PLAY} ${FOCUS}`}
        >
          {progress ? (
            <span
              aria-hidden="true"
              className="hero-dock-watched"
              style={{
                width: `${Math.min(100, Math.max(0, progress.share * 100))}%`,
              }}
            />
          ) : null}
          <Play size={18} fill="currentColor" className="relative shrink-0" />
          <span className="relative truncate">{shortPlayLabel}</span>
          {progress ? (
            <span
              className={`relative shrink-0 text-xs text-zinc-600 ${PLAY_TIME_LEFT}`}
            >
              {t("hero.timeLeft").replace("{time}", progress.left)}
            </span>
          ) : null}
        </Link>
      </span>
      {startOverTo ? (
        <Link
          to={startOverTo}
          aria-label={t("details.playFromBeginning")}
          title={t("details.playFromBeginning")}
          className={`${action} hero-dock-restart`}
        >
          <RotateCcw size={16} />
          <span>{t("details.restartWatching")}</span>
        </Link>
      ) : null}
      <div className="hero-dock-row">
        {onShowDetails ? (
          <button type="button" onClick={onShowDetails} className={action}>
            <Info size={16} />
            <span>{t("common.details")}</span>
          </button>
        ) : (
          <Link
            to={detailsTo}
            state={SCROLL_TO_DETAILS_STATE}
            className={action}
          >
            <Info size={16} />
            <span>{t("common.details")}</span>
          </Link>
        )}
        <FavouriteButton
          item={item}
          iconSize={16}
          showLabel
          shortLabel={t("myList.title")}
          className={action}
        />
        {hasOverview ? (
          <button
            type="button"
            aria-label={overviewLabel}
            aria-expanded={isOverviewOpen}
            aria-controls={overviewId}
            onClick={onToggleOverview}
            className={action}
          >
            <AlignLeft size={16} />
            <span>{t("details.overview")}</span>
            <span
              aria-hidden="true"
              className="hero-dock-story-dot"
              data-open={isOverviewOpen}
            />
          </button>
        ) : null}
        {onShowDetails && item.Type === "Movie" && isOfflineSupported() ? (
          <DownloadButton
            item={item}
            iconSize={16}
            className={`${action} hero-dock-extra`}
          />
        ) : null}
      </div>
    </motion.div>
  );
}
