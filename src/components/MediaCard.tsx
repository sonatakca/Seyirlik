import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { move, REST, settle } from "../lib/compositorMotion";
import { Link } from "react-router-dom";
import {
  getCardLogoOverlayImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getThumbImageUrl,
} from "../lib/mediaApi";
import { formatRuntime, formatTemplate, getDisplayTitle } from "../lib/format";
import { getEpisodeDisplayMetadata } from "../lib/episodeMetadataPreferences";
import {
  getItemDisplayMetadata,
  getItemLogoUrlById,
} from "../lib/itemMetadataPreferences";
import {
  getReadRouteForItem,
  getWatchRouteForItem,
  shouldOpenPlaybackForItem,
  shouldOpenReaderForItem,
} from "../lib/routes";
import type { MediaItem } from "../lib/types";
import { getItemProgressPercent, isItemCompleted } from "../lib/watchStatus";
import {
  DEFAULT_LOGO_SHADOW,
  getLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
} from "../lib/logoLayout";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { ClearWatchingButton } from "./ClearWatchingButton";
import { CollectionPosterMosaic } from "./CollectionPosterMosaic";
import { FavouriteButton } from "./FavouriteButton";
import { RestartWatchingButton } from "./RestartWatchingButton";
import { DownloadButton } from "./offline/DownloadButton";
import { isOfflineSupported } from "../lib/offline/offlineLibrary";
import { WatchedIndicator } from "./WatchedIndicator";

// A press starts at rest, so it names its start (see compositorMotion).
const CARD_PRESS = { transform: [REST, move({ scale: 0.985 })] };

interface MediaCardProps {
  item: MediaItem;
  to: string;
  variant?: "poster" | "landscape";
  layout?: "row" | "grid";
  index?: number;
  animateIn?: boolean;
  /** Offer to keep this episode on the device, as the series page does. */
  showDownload?: boolean;
  showRestartWatching?: boolean;
  collectionItems?: MediaItem[];
  onClearContinueWatching?: (item: MediaItem) => void;
}

function getEpisodeDisplayTitle(
  item: MediaItem,
  t: (key: TranslationKey) => string,
): string | null {
  if (item.Type !== "Episode") {
    return null;
  }

  if (typeof item.IndexNumber === "number" && item.IndexNumber > 0) {
    return formatTemplate(t("media.episodeCardTitle"), {
      number: item.IndexNumber,
    });
  }

  return item.Name || null;
}

function countLabel(
  count: number,
  singularKey: TranslationKey,
  pluralKey: TranslationKey,
  t: (key: TranslationKey) => string,
): string {
  return count === 1 ? t(singularKey) : formatTemplate(t(pluralKey), { count });
}

function getCountLabel(
  item: MediaItem,
  t: (key: TranslationKey) => string,
): string | null {
  if (item.Type === "Series") {
    const parts: string[] = [];

    if (typeof item.ChildCount === "number" && item.ChildCount > 0) {
      parts.push(
        countLabel(
          item.ChildCount,
          "media.seasonSingular",
          "media.seasonPlural",
          t,
        ),
      );
    }

    if (
      typeof item.RecursiveItemCount === "number" &&
      item.RecursiveItemCount > 0
    ) {
      parts.push(
        countLabel(
          item.RecursiveItemCount,
          "media.episodeSingular",
          "media.episodePlural",
          t,
        ),
      );
    }

    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (item.Type === "Season") {
    const seasonLabel =
      typeof item.IndexNumber === "number" && item.IndexNumber > 0
        ? formatTemplate(t("media.seasonNumber"), { number: item.IndexNumber })
        : item.Name;

    const episodeCount =
      typeof item.ChildCount === "number" && item.ChildCount > 0
        ? item.ChildCount
        : typeof item.RecursiveItemCount === "number" &&
            item.RecursiveItemCount > 0
          ? item.RecursiveItemCount
          : null;

    if (!episodeCount) {
      return seasonLabel;
    }

    const episodeLabel = countLabel(
      episodeCount,
      "media.episodeSingular",
      "media.episodePlural",
      t,
    );

    return `${seasonLabel} · ${episodeLabel}`;
  }

  return null;
}

function getEpisodeSeasonLabel(
  item: MediaItem,
  t: (key: TranslationKey) => string,
): string | null {
  if (item.Type !== "Episode") {
    return null;
  }

  if (
    typeof item.ParentIndexNumber === "number" &&
    item.ParentIndexNumber > 0
  ) {
    return formatTemplate(t("media.seasonNumber"), {
      number: item.ParentIndexNumber,
    });
  }

  return item.SeasonName ?? null;
}

function getCommunityRatingLabel(rating?: number): string | null {
  if (typeof rating !== "number" || !Number.isFinite(rating)) {
    return null;
  }

  return `${rating.toFixed(1).replace(/\.0$/, "")}/10`;
}

function getContinueEpisodeTitleFontSize(title: string): string {
  const maxFontSizeRem = 1.125;
  const minFontSizeRem = 0.82;
  const shrinkStartLength = 18;
  const titleLength = Array.from(title).length;
  const fontSize =
    maxFontSizeRem - Math.max(titleLength - shrinkStartLength, 0) * 0.024;

  return `${Math.max(minFontSizeRem, fontSize).toFixed(3)}rem`;
}

/** The small round controls on a card's corner, shown on hover. */
const CORNER_ACTION_CLASS =
  "flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-black/60 text-white opacity-0 shadow-[0_8px_18px_rgba(0,0,0,0.5)] backdrop-blur-sm transition duration-200 hover:scale-105 hover:bg-white hover:text-zinc-950 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:opacity-100 group-focus-within:opacity-100 aria-pressed:opacity-100 max-sm:opacity-100";

export function MediaCard({
  item,
  to,
  variant = "poster",
  layout = "row",
  index = 0,
  animateIn = false,
  showRestartWatching = false,
  showDownload = false,
  collectionItems,
  onClearContinueWatching,
}: MediaCardProps) {
  const { language, t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const mediaFormatLabels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };

  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [shouldUseShowPrimaryImage, setShouldUseShowPrimaryImage] =
    useState(false);

  const itemMetadata = getItemDisplayMetadata(item, language);
  const title =
    item.Type === "Episode"
      ? getDisplayTitle(item, mediaFormatLabels)
      : (itemMetadata.title ?? getDisplayTitle(item, mediaFormatLabels));
  const isEpisode = item.Type === "Episode";
  const episodeMetadata = isEpisode
    ? getEpisodeDisplayMetadata(item, language)
    : null;
  const episodeNumberLabel = isEpisode ? getEpisodeDisplayTitle(item, t) : null;
  const isSeasonEpisodeGrid =
    isEpisode && layout === "grid" && variant === "landscape";
  const episodeDisplayTitle = isSeasonEpisodeGrid
    ? episodeNumberLabel
    : isEpisode
      ? (episodeMetadata?.title ?? item.Name ?? null)
      : null;
  const displayTitle = episodeDisplayTitle ?? title;

  const itemCounts = getCountLabel(item, t);
  const isWatched = isItemCompleted(item);
  // Progress is for something still under way. A finished title says so with
  // its seal; a full bar beside it would only say it again.
  const progressPercent = isWatched ? null : getItemProgressPercent(item);
  const isContinueWatchingCard = Boolean(onClearContinueWatching);
  const runtimeLabel = formatRuntime(item.RunTimeTicks, mediaFormatLabels);
  const episodeSeasonLabel = getEpisodeSeasonLabel(item, t);
  const continueContextLabel = isEpisode
    ? [item.SeriesName, episodeSeasonLabel].filter(Boolean).join(" · ")
    : item.Genres?.filter(Boolean).slice(0, 2).join(" · ") || null;
  const continueDescription = isEpisode
    ? (episodeMetadata?.overview ?? item.Overview)
    : (itemMetadata.overview ?? item.Overview);
  // The year and certificate used to ride on the poster overlay. That overlay
  // is gone, and this card is the one place that is explicitly about details,
  // so they belong here rather than back on the artwork.
  const continueFactChips = [
    item.ProductionYear ? String(item.ProductionYear) : null,
    item.OfficialRating ?? null,
    runtimeLabel,
    getCommunityRatingLabel(item.CommunityRating),
  ].filter((chip): chip is string => Boolean(chip));

  // An episode's own artwork is its still, which the metadata pass stores as a
  // thumb; an episode never has a poster of its own, and the series poster it
  // can borrow arrives separately as `SeriesPrimaryImageTag`. Looking only for
  // a primary image therefore left every episode card blank while the still sat
  // in the catalogue.
  const ownImageWidth = variant === "poster" ? 600 : 900;
  const imageUrl =
    episodeMetadata?.thumbnailUrl ??
    (item.ImageTags?.Primary
      ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, ownImageWidth)
      : item.ImageTags?.Thumb
        ? getThumbImageUrl(item.Id, item.ImageTags.Thumb, ownImageWidth)
        : "");
  const showPrimaryImageUrl =
    item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag
      ? getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, 600)
      : "";
  const displayImageUrl =
    shouldUseShowPrimaryImage && showPrimaryImageUrl
      ? showPrimaryImageUrl
      : imageUrl;
  const continueCoverImageUrl = isEpisode
    ? showPrimaryImageUrl
    : item.ImageTags?.Primary
      ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 600)
      : displayImageUrl;
  const fallbackLogoUrl =
    item.Type === "Episode" && isSeasonEpisodeGrid
      ? ""
      : item.ImageTags?.Logo
        ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 520)
        : item.ParentLogoItemId && item.ParentLogoImageTag
          ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 520)
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
    logoUrl &&
    logoLayout &&
    logoLayout.shadow > 0 &&
    variant !== "landscape" &&
    !isEpisode
      ? getCardLogoOverlayImageUrl(logoUrl, item.Id, logoLayout, 600)
      : null;
  const logoShadowFrame = getLogoShadowFrameStyle(
    logoLayout?.shadow ?? DEFAULT_LOGO_SHADOW,
  );
  const logoShadowBackdropStyle = logoLayout
    ? getLogoShadowBackdropStyle(logoLayout.shadow)
    : undefined;

  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  const shouldPlayOnCardClick = shouldOpenPlaybackForItem(item);
  const shouldReadOnCardClick = shouldOpenReaderForItem(item);
  const primaryActionLabel = shouldPlayOnCardClick
    ? t("common.play")
    : shouldReadOnCardClick
      ? t("common.read")
      : t("common.details");
  const primaryCardTo = shouldPlayOnCardClick
    ? getWatchRouteForItem(item)
    : shouldReadOnCardClick
      ? getReadRouteForItem(item)
      : to;

  const isLandscape = variant === "landscape" || isEpisode;
  const isGrid = layout === "grid";

  const sizeClass = isGrid
    ? "w-full"
    : isContinueWatchingCard
      ? "w-72 sm:w-[26rem] lg:w-[30rem]"
      : isLandscape
        ? "w-60 sm:w-80 lg:w-96"
        : "w-36 sm:w-52 lg:w-60";

  const aspectClass = isEpisode
    ? ""
    : isLandscape
      ? "aspect-video"
      : "aspect-[2/3]";

  const entranceDelay = Math.min(index * 0.025, 0.18);
  const motionProps = animateIn
    ? shouldReduceMotion
      ? {
          initial: { opacity: 0 },
          whileInView: { opacity: 1 },
          viewport: { once: true, margin: "80px" },
          transition: { duration: 0.01 },
        }
      : {
          initial: { opacity: 0, transform: move({ y: 14, scale: 0.985 }) },
          whileInView: { opacity: 1, ...settle },
          viewport: { once: true, margin: "80px" },
          transition: {
            duration: 0.3,
            delay: entranceDelay,
            ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
          },
        }
    : {};

  const handleImageLoaded = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const imageAspectRatio = image.naturalWidth / image.naturalHeight;

    if (
      !isContinueWatchingCard &&
      item.Type === "Episode" &&
      variant === "poster" &&
      !shouldUseShowPrimaryImage &&
      showPrimaryImageUrl &&
      imageAspectRatio > 1.2
    ) {
      setImageLoaded(false);
      setShouldUseShowPrimaryImage(true);
      return;
    }

    setImageLoaded(true);
  };

  const renderContinueWatchingCard = () => {
    const continueTitle = isEpisode
      ? (episodeMetadata?.title ?? item.Name)
      : displayTitle;
    const continueTitleStyle: React.CSSProperties | undefined = isEpisode
      ? {
          fontSize: getContinueEpisodeTitleFontSize(continueTitle),
          lineHeight: 1.14,
        }
      : undefined;
    const continueActionButtonClass =
      "pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/64 transition duration-200 hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-white/55 disabled:opacity-50";

    return (
      <motion.div
        data-flip-key={item.Id}
        className={`relative isolate h-full min-w-0 shrink-0 hover:z-10 focus-within:z-10 ${sizeClass}`}
        whileTap={shouldReduceMotion ? undefined : CARD_PRESS}
        {...motionProps}
      >
        <div className="media-card-cinematic media-card-lifted group relative grid aspect-[4/3] h-full min-w-0 grid-cols-2 scroll-ml-4 transform-gpu overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] transition-transform duration-300 will-change-transform hover:-translate-y-1.5 hover:scale-[1.012] motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100">
          <Link
            to={primaryCardTo}
            aria-label={`${primaryActionLabel} ${title}`}
            className="absolute inset-0 z-20 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent)]"
          />

          <div className="pointer-events-none relative z-0 h-full min-w-0 overflow-hidden bg-zinc-950">
            {!imageLoaded && continueCoverImageUrl && !imageFailed ? (
              <div className="shimmer absolute inset-0" />
            ) : null}
            {continueCoverImageUrl && !imageFailed ? (
              <img
                src={continueCoverImageUrl}
                alt={title}
                loading="lazy"
                decoding="async"
                className="relative z-10 h-full w-full object-cover"
                onLoad={handleImageLoaded}
                onError={() => setImageFailed(true)}
              />
            ) : collectionItems?.length ? (
              <CollectionPosterMosaic
                title={title}
                items={collectionItems}
                imageSize={isEpisode || isLandscape ? 760 : 520}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-4 text-center text-sm font-bold text-zinc-100">
                {displayTitle}
              </div>
            )}
            {renderContentByType()}
          </div>

          <div className="pointer-events-none relative isolate z-30 flex h-full min-w-0 flex-col overflow-hidden bg-black/40 px-4 py-3.5 shadow-[inset_1px_0_0_rgba(255,255,255,0.1)] sm:px-5 sm:py-4 transform-gpu [backface-visibility:hidden]">
            {continueCoverImageUrl && !imageFailed ? (
              <img
                src={continueCoverImageUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-y-0 left-0 -z-30 h-full w-full -scale-x-100 object-cover opacity-100 blur-[50px] transform-gpu [backface-visibility:hidden]"
              />
            ) : null}
            <div className="absolute inset-0 -z-20" />
            <div className="absolute inset-y-0 left-0 -z-[5] w-px bg-gradient-to-b from-transparent via-white/25 to-transparent" />

            <div className="flex min-h-9 items-center justify-between gap-3">
              <div className="min-w-0 self-stretch">
                {isEpisode && episodeNumberLabel ? (
                  <span className="flex h-full items-center truncate text-[0.67rem] font-black uppercase tracking-[0.12em] text-white/62 sm:text-xs">
                    {episodeNumberLabel}
                  </span>
                ) : null}
              </div>

              <div className="pointer-events-auto relative z-40 flex shrink-0 items-center gap-2">
                {canPlay && showRestartWatching ? (
                  <RestartWatchingButton
                    item={item}
                    className={continueActionButtonClass}
                  />
                ) : null}
                {showDownload &&
                isEpisode &&
                canPlay &&
                isOfflineSupported() ? (
                  <DownloadButton
                    item={item}
                    iconSize={16}
                    className={continueActionButtonClass}
                  />
                ) : null}
                {canPlay && onClearContinueWatching ? (
                  <ClearWatchingButton
                    item={item}
                    onCleared={onClearContinueWatching}
                    className={continueActionButtonClass}
                  />
                ) : null}
              </div>
            </div>

            <h3
              className={`mt-1 font-black text-white ${
                isEpisode
                  ? "truncate whitespace-nowrap"
                  : "line-clamp-2 text-base leading-tight sm:text-lg"
              }`}
              style={continueTitleStyle}
            >
              {continueTitle}
            </h3>

            {continueContextLabel ? (
              <p className="mt-1 truncate text-[0.72rem] font-bold text-white/58 sm:text-xs">
                {continueContextLabel}
              </p>
            ) : null}

            {continueDescription ? (
              <p className="mt-2 min-h-0 overflow-hidden text-[0.72rem] font-medium leading-[1.45] text-white/76 line-clamp-[7] sm:text-xs sm:leading-[1.5] sm:line-clamp-[8] lg:line-clamp-[9] ">
                {continueDescription}
              </p>
            ) : null}

            {continueFactChips.length > 0 ? (
              <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                {continueFactChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border border-white/10 bg-white/[0.07] px-2 py-0.5 text-[0.64rem] font-bold text-white/68 sm:text-[0.7rem]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {progressPercent !== null ? (
            <div className="absolute inset-x-0 bottom-0 z-50 h-[0.1rem] w-[50%] bg-gray-600">
              <div
                data-testid="media-card-progress-fill"
                className="media-progress-fill h-full bg-[var(--accent)]"
                style={{ width: `${progressPercent / 2}%` }}
              />
            </div>
          ) : null}
        </div>
        <CardLiftShadow lift="translateY(-0.375rem) scale(1.012)" />
      </motion.div>
    );
  };

  const renderContentByType = () => {
    if (item.Type === "Season") {
      return (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col p-3 sm:p-4 bg-gradient-to-t from-black/95 via-black/40 to-transparent">
          <h3 className="mb-1 line-clamp-1 text-base font-bold text-white sm:text-lg">
            {displayTitle}
          </h3>
          {itemCounts && (
            <p className="line-clamp-1 text-[0.7rem] font-medium text-gray-300 sm:text-sm">
              {itemCounts}
            </p>
          )}
        </div>
      );
    }

    if (item.Type === "BoxSet" || collectionItems?.length) {
      return (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center p-3 sm:p-4 bg-black/60 transition-colors group-hover:bg-black/40">
          <h3 className="text-center text-lg font-black text-white sm:text-xl drop-shadow-lg">
            {displayTitle}
          </h3>
          {itemCounts && (
            <p className="mt-2 rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white backdrop-blur-md">
              {itemCounts}
            </p>
          )}
        </div>
      );
    }

    return (
      <>
        {logoOverlayUrl ? (
          <img
            data-logo-overlay="true"
            src={logoOverlayUrl}
            alt={displayTitle}
            loading="lazy"
            decoding="async"
            className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          />
        ) : logoUrl && logoLayout ? (
          <div
            data-logo-layout="true"
            style={getLogoLayoutStyle(
              logoLayout,
              getLogoShadowReach(logoLayout.shadow),
            )}
            className="pointer-events-none absolute z-20"
          >
            <div className="relative flow-root">
              {logoShadowBackdropStyle ? (
                <span
                  aria-hidden="true"
                  data-logo-shadow-backdrop="true"
                  style={logoShadowBackdropStyle}
                  className="absolute inset-[6%] rounded-[45%]"
                />
              ) : null}
              <div
                data-logo-shadow="true"
                style={logoShadowFrame}
                className="relative z-10"
              >
                <img
                  src={logoUrl}
                  alt={displayTitle}
                  className="block h-auto w-full object-contain"
                />
              </div>
            </div>
          </div>
        ) : logoUrl ? (
          // Nothing sits behind the logo any more — no gradient, no tags — so
          // its own shadow is the only thing separating it from the artwork.
          // The frame spans the card; the logo is centred on its foot, and
          // its height follows its width so the aspect ratio is preserved.
          <div
            data-logo-shadow="true"
            style={logoShadowFrame}
            className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex items-end justify-center"
          >
            <img
              src={logoUrl}
              alt={displayTitle}
              className="h-auto max-h-16 w-auto max-w-[80%] object-contain sm:max-h-24"
            />
          </div>
        ) : (
          // A card with neither logo nor title would be unidentifiable, so the
          // title stands in — carrying its own shadow for the same reason.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3 sm:p-4">
            <h3 className="text-cinematic-title line-clamp-2 text-center text-sm font-bold text-white sm:text-base">
              {displayTitle}
            </h3>
          </div>
        )}
      </>
    );
  };

  if (isContinueWatchingCard) {
    return renderContinueWatchingCard();
  }

  return (
    <motion.div
      data-flip-key={item.Id}
      className={`relative isolate h-full min-w-0 shrink-0 hover:z-10 focus-within:z-10 ${sizeClass}`}
      whileTap={shouldReduceMotion ? undefined : CARD_PRESS}
      {...motionProps}
    >
      <div
        className={`media-card-cinematic media-card-lifted group relative h-full w-full min-w-0 scroll-ml-4 transform-gpu overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] transition-transform duration-300 will-change-transform motion-reduce:hover:translate-y-0 motion-reduce:hover:scale-100 ${
          isEpisode
            ? "flex flex-col hover:-translate-y-1"
            : `block ${aspectClass} hover:-translate-y-1.5 hover:scale-[1.025]`
        }`}
      >
        <Link
          to={primaryCardTo}
          aria-label={`${primaryActionLabel} ${title}`}
          className="absolute inset-0 z-30 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />

        <div
          className={
            isEpisode
              ? "pointer-events-none relative z-0 aspect-video w-full shrink-0 overflow-hidden bg-zinc-950"
              : "pointer-events-none absolute inset-0 z-0 overflow-hidden bg-zinc-900"
          }
        >
          {!imageLoaded && displayImageUrl && !imageFailed ? (
            <div className="shimmer absolute inset-0" />
          ) : null}
          {displayImageUrl && !imageFailed ? (
            <img
              src={displayImageUrl}
              alt={title}
              loading="lazy"
              className={`relative z-10 h-full w-full transition-[transform,opacity] duration-500 ${
                isEpisode
                  ? "object-contain"
                  : "object-cover group-hover:scale-[1.04] group-focus-within:scale-[1.08]"
              } ${imageLoaded ? "opacity-100" : "opacity-0"}`}
              onLoad={(event) => {
                handleImageLoaded(event);
              }}
              onError={() => setImageFailed(true)}
            />
          ) : collectionItems?.length ? (
            <CollectionPosterMosaic
              title={title}
              items={collectionItems}
              imageSize={variant === "poster" ? 520 : 760}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-5 text-center text-sm font-bold text-zinc-100">
              {displayTitle}
            </div>
          )}
        </div>

        <div
          className={`absolute right-3 top-3 z-30 sm:right-4 sm:top-4 ${
            canPlay && showRestartWatching
              ? "transition-opacity duration-200 group-hover:opacity-0 group-focus-within:opacity-0"
              : ""
          }`}
        >
          <WatchedIndicator
            isWatched={isWatched}
            reveal="hover"
            size={variant === "poster" ? "md" : "sm"}
          />
        </div>

        {/*
          Sits above the full-card link (z-30) so the control is clickable, and
          on the opposite corner from the watched indicator.
        */}
        <div className="absolute left-3 top-3 z-40 flex gap-2 sm:left-4 sm:top-4">
          <FavouriteButton
            item={item}
            iconSize={14}
            tooltipGroup="media-card"
            className={CORNER_ACTION_CLASS}
          />
          {showDownload && isEpisode && canPlay && isOfflineSupported() ? (
            <DownloadButton
              item={item}
              iconSize={14}
              className={CORNER_ACTION_CLASS}
            />
          ) : null}
        </div>

        {isEpisode ? (
          <div className="pointer-events-none relative isolate z-20 flex min-h-[8.5rem] flex-col overflow-hidden border-t border-white/16 bg-black/40 px-4 pb-4 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] sm:min-h-[9.75rem] sm:px-5 sm:pb-5 sm:pt-4 transform-gpu [backface-visibility:hidden]">
            {displayImageUrl && !imageFailed ? (
              <img
                src={displayImageUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-x-0 top-0 -z-30 h-auto w-full -scale-y-100 object-contain opacity-60 blur-[30px] transform-gpu [backface-visibility:hidden]"
              />
            ) : null}

            <div className="absolute inset-x-0 top-0 -z-[5] h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

            {episodeNumberLabel ? (
              <span className="mb-1 truncate text-[0.66rem] font-black uppercase tracking-[0.08em] text-white/95 sm:text-xs">
                {episodeNumberLabel}
              </span>
            ) : null}

            <h3 className="line-clamp-1 text-sm font-bold text-white sm:text-base">
              {episodeMetadata?.title ?? item.Name}
            </h3>

            {episodeMetadata?.overview ? (
              <p className="mt-1.5 line-clamp-2 text-[0.7rem] font-medium leading-[1.35] text-white/78 sm:text-xs">
                {episodeMetadata.overview}
              </p>
            ) : null}

            <div className="mt-auto flex items-end justify-between gap-3 pt-2">
              {item.RunTimeTicks ? (
                <span className="flex items-center gap-1.5 text-[0.7rem] font-semibold text-white/75 sm:text-xs">
                  <svg
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 2" />
                  </svg>
                  {Math.round(item.RunTimeTicks / 600000000)} dk
                </span>
              ) : (
                <span />
              )}

              <svg
                aria-hidden="true"
                className="h-4 w-4 text-white/60"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM22 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" />
              </svg>
            </div>
          </div>
        ) : (
          renderContentByType()
        )}

        {progressPercent !== null ? (
          <div className="absolute inset-x-0 bottom-0 z-30 h-[0.1rem] sm:h-[0.1rem] bg-white/[0.18]">
            <div
              data-testid="media-card-progress-fill"
              className="media-progress-fill h-full bg-[var(--accent)]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        ) : null}

        <div className="absolute inset-0 z-40 pointer-events-none">
          {canPlay && onClearContinueWatching ? (
            <ClearWatchingButton
              item={item}
              onCleared={onClearContinueWatching}
              className="pointer-events-auto absolute right-3 top-3 flex h-9 w-9 shrink-0 -translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-300 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
            />
          ) : null}
          {canPlay && showRestartWatching ? (
            <RestartWatchingButton
              item={item}
              className="pointer-events-auto absolute right-3 top-3 flex h-10 w-10 shrink-0 translate-y-1 items-center justify-center rounded-full border border-white/15 bg-gray-600/90 text-white opacity-0 shadow-player-controls transition duration-500 hover:bg-gray-500 focus:translate-y-0 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white/70 group-hover:-translate-y-3 group-hover:opacity-100 group-focus-within:-translate-y-3 group-focus-within:opacity-100"
            />
          ) : null}
        </div>
      </div>
      <CardLiftShadow
        lift={
          isEpisode
            ? "translateY(-0.25rem)"
            : "translateY(-0.375rem) scale(1.025)"
        }
      />
    </motion.div>
  );
}

/**
 * The shadow a hovered card stands on, and its brighter edge, drawn once on a
 * layer behind the card and faded in with opacity, lifted with the card's own
 * transform. The card's box-shadow and border colour used to be transitioned
 * instead, which repainted the card and its 120px blur on every frame.
 */
function CardLiftShadow({ lift }: { lift: string }) {
  return (
    <div
      aria-hidden="true"
      className="media-card-lift-shadow"
      style={{ "--card-lift": lift } as React.CSSProperties}
    />
  );
}
