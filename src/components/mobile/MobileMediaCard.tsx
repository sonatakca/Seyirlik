import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import {
  getItemDisplayMetadata,
  getItemLogoUrlById,
} from "../../lib/itemMetadataPreferences";
import {
  formatRuntime,
  formatTemplate,
  getDisplayTitle,
} from "../../lib/format";
import {
  getCardLogoOverlayImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getThumbImageUrl,
} from "../../lib/mediaApi";
import {
  getReadRouteForItem,
  getWatchRouteForItem,
  shouldOpenPlaybackForItem,
  shouldOpenReaderForItem,
} from "../../lib/routes";
import {
  LOGO_SHADOW_REFERENCE_WIDTH,
  getLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
} from "../../lib/logoLayout";
import type { MediaItem } from "../../lib/types";
import { getItemProgressPercent, isItemCompleted } from "../../lib/watchStatus";
import { CollectionPosterMosaic } from "../CollectionPosterMosaic";
import { WatchedIndicator } from "../WatchedIndicator";
import { DownloadButton } from "../offline/DownloadButton";
import { isOfflineSupported } from "../../lib/offline/offlineLibrary";

/**
 * A phone's poster card is about 150px wide; its logo shadow is scaled to
 * that, so it keeps the proportion the artwork tool set it at.
 */
const PHONE_CARD_SHADOW_SCALE = 150 / LOGO_SHADOW_REFERENCE_WIDTH;

interface MobileMediaCardProps {
  item: MediaItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
  showRestartWatching?: boolean;
  /** Offer to keep this episode on the device, as the series page does. */
  showDownload?: boolean;
  collectionItems?: MediaItem[];
  animateRemoval?: boolean;
  onClearContinueWatching?: (item: MediaItem) => void;
}

function countLabel(
  count: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
  t: (key: TranslationKey) => string,
): string {
  return count === 1 ? t(singularKey) : formatTemplate(t(pluralKey), { count });
}

function getSeriesCount(
  item: MediaItem,
  t: (key: TranslationKey) => string,
): string | null {
  const seasonCount = item.ChildCount;
  const episodeCount = item.RecursiveItemCount;

  if (item.Type === "Series") {
    if (seasonCount && episodeCount) {
      return `${countLabel(seasonCount, "media.seasonSingular", "media.seasonPlural", t)} · ${countLabel(episodeCount, "media.episodeSingular", "media.episodePlural", t)}`;
    }
    if (seasonCount) {
      return countLabel(
        seasonCount,
        "media.seasonSingular",
        "media.seasonPlural",
        t,
      );
    }
  }

  if (item.Type === "Season") {
    const count = item.ChildCount ?? item.RecursiveItemCount;
    if (count) {
      return countLabel(
        count,
        "media.episodeSingular",
        "media.episodePlural",
        t,
      );
    }
  }

  return null;
}

export function MobileMediaCard({
  item,
  to,
  variant = "poster",
  layout = "row",
  collectionItems,
  animateRemoval = false,
  showDownload = false,
}: MobileMediaCardProps) {
  const { language, t } = useLanguage();
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };

  const isEpisode = item.Type === "Episode";
  const episodeMetadata = isEpisode
    ? getEpisodeDisplayMetadata(item, language)
    : null;
  const isSeason = item.Type === "Season";
  const isLandscape = variant === "landscape";
  const isRow = layout === "row";
  const isWatched = isItemCompleted(item);

  const itemMetadata = getItemDisplayMetadata(item, language);
  const baseTitle =
    item.Type === "Episode"
      ? getDisplayTitle(item, labels)
      : (itemMetadata.title ?? getDisplayTitle(item, labels));

  // === Desktop Matching Logic for Titles ===
  let mainTitle = baseTitle;
  let secondaryTitle: string | null = null;
  let tertiaryInfo: string | null = null;

  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const countText = getSeriesCount(item, t);
  // A finished title carries its seal instead of a full progress bar.
  const progressPercent = isWatched ? null : getItemProgressPercent(item);

  if (isEpisode) {
    // Top line is the big bold episode number (e.g. "3. Bölüm")
    mainTitle =
      item.IndexNumber != null
        ? formatTemplate(t("media.episodeNumber"), { number: item.IndexNumber })
        : baseTitle;

    // Second line is the specific name of that episode
    secondaryTitle = episodeMetadata?.title ?? item.Name;

    // Third line is the year and runtime (like desktop!)
    tertiaryInfo = [item.ProductionYear, runtime].filter(Boolean).join("  ");
  } else if (isSeason) {
    // For seasons, just show "1. Sezon" or similar
    mainTitle = baseTitle;
    secondaryTitle = item.SeriesName || null;
    tertiaryInfo = countText;
  } else {
    // Standard movies or series
    mainTitle = baseTitle;
    tertiaryInfo =
      countText ?? [item.ProductionYear, runtime].filter(Boolean).join(" / ");
  }

  const shouldPlayOnCardClick = shouldOpenPlaybackForItem(item);
  const shouldReadOnCardClick = shouldOpenReaderForItem(item);
  const usesArtworkOnlyLayout =
    shouldReadOnCardClick || item.Type === "Movie" || item.Type === "Series";
  const primaryActionLabel = shouldPlayOnCardClick
    ? t("common.play")
    : shouldReadOnCardClick
      ? t("common.read")
      : t("common.details");
  const primaryTo = shouldPlayOnCardClick
    ? getWatchRouteForItem(item)
    : shouldReadOnCardClick
      ? getReadRouteForItem(item)
      : to;

  // A vertical episode card borrows the series poster, because an episode still
  // is a wide frame and would be cropped to nothing. A wide one uses the still
  // itself, which the metadata pass stores as a thumb — an episode has no
  // poster of its own, so looking only for a primary image left every episode
  // card blank even though the still was sitting in the catalogue.
  const ownImageWidth = isLandscape ? 680 : 440;
  const imageUrl =
    isEpisode && isLandscape && episodeMetadata?.thumbnailUrl
      ? episodeMetadata.thumbnailUrl
      : isEpisode && !isLandscape && item.SeriesId && item.SeriesPrimaryImageTag
        ? getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 440)
        : item.ImageTags?.Primary
          ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, ownImageWidth)
          : item.ImageTags?.Thumb
            ? getThumbImageUrl(item.Id, item.ImageTags.Thumb, ownImageWidth)
            : "";

  const fallbackLogoUrl =
    !isEpisode && !isSeason && item.ImageTags?.Logo
      ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 420)
      : !isEpisode &&
          !isSeason &&
          item.ParentLogoItemId &&
          item.ParentLogoImageTag
        ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 420)
        : "";
  const logoUrl = getItemLogoUrlById(
    item.Type === "Episode"
      ? (item.SeriesId ?? item.ParentLogoItemId)
      : item.Id,
    language,
    fallbackLogoUrl,
  );

  const logoLayout = getLogoLayout(item);
  const logoOverlayUrl =
    logoUrl && logoLayout && logoLayout.shadow > 0 && !isLandscape
      ? getCardLogoOverlayImageUrl(logoUrl, item.Id, logoLayout, 440)
      : null;
  const logoShadow = logoLayout
    ? getLogoShadowFrameStyle(logoLayout.shadow, PHONE_CARD_SHADOW_SCALE)
    : undefined;
  const logoShadowBackdrop = logoLayout
    ? getLogoShadowBackdropStyle(logoLayout.shadow, PHONE_CARD_SHADOW_SCALE)
    : undefined;

  return (
    <motion.article
      data-flip-key={item.Id}
      layout={animateRemoval ? "position" : undefined}
      exit={
        animateRemoval
          ? { opacity: 0, x: -28, scale: 0.96, filter: "blur(6px)" }
          : undefined
      }
      className={
        isRow
          ? variant === "landscape"
            ? "flex w-60 shrink-0 snap-start flex-col min-[390px]:w-64 sm:w-80"
            : "flex w-[9rem] shrink-0 snap-start flex-col min-[390px]:w-[9.5rem] sm:w-52"
          : "flex h-full min-w-0 flex-col"
      }
    >
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#141416] shadow-cinematic-card">
        <div
          className={`relative shrink-0 overflow-hidden bg-zinc-900 ${
            isLandscape ? "aspect-video" : "aspect-[2/3]"
          }`}
        >
          <Link
            to={primaryTo}
            aria-label={`${primaryActionLabel} ${mainTitle}`}
            className="block h-full w-full focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent)]"
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={mainTitle}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : collectionItems?.length ? (
              <CollectionPosterMosaic
                title={mainTitle}
                items={collectionItems}
                imageSize={isLandscape ? 520 : 400}
              />
            ) : (
              <span className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#080809)] p-3 text-center text-xs font-bold text-white/80">
                {mainTitle}
              </span>
            )}
          </Link>

          {/* A poster whose logo was placed in the artwork tool shows it there,
              at that size and shadow, exactly as the desktop card does. */}
          {logoOverlayUrl ? (
            <img
              data-logo-overlay="true"
              src={logoOverlayUrl}
              alt={mainTitle}
              loading="lazy"
              decoding="async"
              className="pointer-events-none absolute inset-0 z-20 h-full w-full"
            />
          ) : logoUrl && logoLayout && !isLandscape ? (
            <div
              data-logo-layout="true"
              style={getLogoLayoutStyle(
                logoLayout,
                getLogoShadowReach(logoLayout.shadow, PHONE_CARD_SHADOW_SCALE),
              )}
              className="pointer-events-none absolute z-20"
            >
              <div className="relative flow-root">
                {logoShadowBackdrop ? (
                  <span
                    aria-hidden="true"
                    style={logoShadowBackdrop}
                    className="absolute inset-[6%] rounded-[45%]"
                  />
                ) : null}
                <div
                  data-logo-shadow="true"
                  style={logoShadow}
                  className="relative z-10"
                >
                  <img
                    src={logoUrl}
                    alt={mainTitle}
                    loading="lazy"
                    decoding="async"
                    className="block h-auto w-full object-contain"
                  />
                </div>
              </div>
            </div>
          ) : logoUrl ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center bg-gradient-to-t from-black/75 via-black/20 to-transparent px-3 pb-3 pt-12 min-[390px]:px-4 min-[390px]:pb-4">
              <img
                src={logoUrl}
                alt={mainTitle}
                loading="lazy"
                decoding="async"
                className="max-h-20 max-w-[82%] object-contain object-left drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)] min-[390px]:max-h-[3.75rem]"
              />
            </div>
          ) : null}

          {/* The eye sits in the artwork's corner, as on desktop; an episode
              that offers a download keeps that corner for the button. */}
          <div
            className={`pointer-events-none absolute top-2 z-30 ${
              showDownload && isEpisode && isOfflineSupported()
                ? "left-2"
                : "right-2"
            }`}
          >
            <WatchedIndicator isWatched={isWatched} reveal="hover" size="sm" />
          </div>

          {showDownload && isEpisode && isOfflineSupported() ? (
            <div className="absolute right-2 top-2 z-30">
              <DownloadButton
                item={item}
                iconSize={16}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              />
            </div>
          ) : null}

          {progressPercent !== null ? (
            <div className="absolute inset-x-0 bottom-0 z-30 h-0.5 bg-[#343438]">
              <div
                data-testid="media-card-progress-fill"
                className="media-progress-fill h-full bg-[var(--accent)]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          ) : null}
        </div>

        {!usesArtworkOnlyLayout ? (
          <div className="flex flex-1 flex-col justify-center px-3 py-2.5 min-[390px]:px-3.5 min-[390px]:py-3">
            {!logoUrl ? (
              <h3
                className={`truncate font-black text-white ${
                  isEpisode
                    ? "text-base tracking-tight min-[390px]:text-lg"
                    : "text-[0.7rem] min-[390px]:text-xs"
                }`}
              >
                {mainTitle}
              </h3>
            ) : null}

            {secondaryTitle ? (
              <p className="mt-1 truncate text-xs font-semibold text-white/90">
                {secondaryTitle}
              </p>
            ) : null}

            {tertiaryInfo ? (
              <div className="mt-1.5 flex items-center gap-2">
                {isEpisode ? (
                  tertiaryInfo.split("  ").map((infoChunk, idx) => (
                    <span
                      key={idx}
                      className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[0.62rem] font-bold text-white/55"
                    >
                      {infoChunk}
                    </span>
                  ))
                ) : (
                  <p className="truncate text-[0.68rem] font-medium text-white/52">
                    {tertiaryInfo}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.article>
  );
}
