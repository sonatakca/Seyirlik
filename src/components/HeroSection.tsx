import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "framer-motion";
import {
  Info,
  Play,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ButtonLink } from "./Button";
import {
  getHeroPreviewUrl,
  getLogoImageUrl,
  redactPlaybackUrl,
} from "../lib/mediaApi";
import { formatRuntime, getDisplayTitle, getItemSubtitle } from "../lib/format";
import { getEpisodeDisplayMetadata } from "../lib/episodeMetadataPreferences";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../lib/itemMetadataPreferences";
import { getRouteForItem } from "../lib/routes";
import { getPlayTargetForItem } from "../lib/playTarget";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import type { MediaItem } from "../lib/types";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { TimedCarouselIndicators } from "./TimedCarouselIndicators";
import { useCroppedTransparentImage } from "../hooks/useCroppedTransparentImage";
import { getItemProgressPercent } from "../lib/watchStatus";

/** Below this, "resume" and "start over" land in the same place. */
export const HERO_START_OVER_MIN_PERCENT = 5;

/**
 * Whether starting over is a real choice for this title.
 *
 * A film barely begun resumes to almost the same place, so the second button
 * would only be clutter; one already finished has no progress to keep. Both are
 * excluded, which is what makes the button mean something when it appears.
 */
export function canStartOverFromHero(item: MediaItem | undefined): boolean {
  if (!item) return false;
  const progress = getItemProgressPercent(item);
  return progress !== null && progress >= HERO_START_OVER_MIN_PERCENT;
}
import { getSmartContinueWatchingItems } from "../lib/smartContinueWatching";
import { WATCH_STATUS_CHANGED_EVENT } from "../lib/watchedStatusActions";
import {
  getHeroImageCandidates,
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "./hero/heroModel";
import { FavouriteButton } from "./FavouriteButton";
import { Tooltip } from "./ui/Tooltip";
const HERO_DESCRIPTION_VISIBLE_MS = 5000;
const HERO_DEFAULT_SLIDE_DURATION_MS = 12000;
const HERO_INDICATOR_AFTER_BANNER_LIMIT_VH = 30;
const HERO_PREVIEW_FADE_MS = 1200;
const HERO_POST_TRAILER_VISIBLE_MS = 10000;

type IndicatorsPlacement =
  | "top-center"
  | "top-right"
  | "top-left"
  | "top-left-quarter"
  | "top-right-quarter"
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "bottom-left-quarter"
  | "bottom-right-quarter";

/** How far the control travels in and out of the corner, as a share of its own height. */
const INDICATOR_TRAVEL = "280%";
const INDICATOR_MOTION = {
  durationS: 1,
  delayS: 0.1,
  ease: [0.25, 1, 0.5, 1] as [number, number, number, number],
};

interface HeroSectionProps {
  /**
   * `carousel` keeps the existing slide and indicator behaviour.
   * `fixed` pins the hero to one media item for details pages while still
   * allowing its backdrop and preview trailer to play.
   */
  variant?: "carousel" | "fixed";
  item?: MediaItem;
  smartContinueItems?: MediaItem[];
  currentIndex?: number;
  totalItems?: number;
  durationMs?: number;
  progressStartedAtMs?: number;
  progressResetKey?: string | number;
  isPaused?: boolean;
  onTogglePaused?: () => void;
  showPauseButton?: boolean;
  indicatorPlacement?: IndicatorsPlacement;
  onSelectIndex?: (index: number) => void;
  onHeroReady?: () => void;
  onPreviewPlaybackChange?: (isPlayingPreview: boolean) => void;
  onSlideDurationChange?: (durationMs: number) => void;
  enablePreview?: boolean;
  keepDetailsVisible?: boolean;
}

interface HeroPreviewVideoProps {
  previewUrl: string | null;
  isPreviewMuted: boolean;
  shouldReduceMotion: boolean;
  isPreviewReady: boolean;
  areTrailersEnabled: boolean;
  resumeTimeSeconds: number;
  softEase: [number, number, number, number];
  isCarouselPaused: boolean;
  shouldPlay: boolean;
  onDurationChange: (durationMs: number) => void;
  onPlaybackTimeChange: (timeSeconds: number) => void;
  onCanPlay: () => void;
  onPlay: () => void;
  onDisabledFadeOutComplete: (timeSeconds: number) => void;
  onEnded: () => void;
  onError: () => void;
  onLoadStart: () => void;
}

function HeroPreviewVideo({
  previewUrl,
  isPreviewMuted,
  shouldReduceMotion,
  isPreviewReady,
  areTrailersEnabled,
  resumeTimeSeconds,
  softEase,
  isCarouselPaused,
  shouldPlay,
  onDurationChange,
  onPlaybackTimeChange,
  onCanPlay,
  onPlay,
  onDisabledFadeOutComplete,
  onEnded,
  onError,
  onLoadStart,
}: HeroPreviewVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const disabledFadeFrameRef = useRef<number | null>(null);
  const disabledFadeTimeoutRef = useRef<number | null>(null);
  const isPresent = useIsPresent();

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isPresent) return;

    const clearDisabledFade = () => {
      if (disabledFadeFrameRef.current !== null) {
        cancelAnimationFrame(disabledFadeFrameRef.current);
        disabledFadeFrameRef.current = null;
      }

      if (disabledFadeTimeoutRef.current !== null) {
        window.clearTimeout(disabledFadeTimeoutRef.current);
        disabledFadeTimeoutRef.current = null;
      }
    };

    if (isCarouselPaused || !shouldPlay) {
      if (isCarouselPaused || areTrailersEnabled) {
        clearDisabledFade();
        video.pause();
        return;
      }

      const duration = shouldReduceMotion ? 0 : HERO_PREVIEW_FADE_MS;
      const initialVolume = video.volume;
      const shouldFadeAudio =
        !isPreviewMuted && !video.muted && initialVolume > 0;

      const finishDisabledFade = () => {
        onPlaybackTimeChange(video.currentTime);
        video.pause();
        video.volume = 1;
        disabledFadeFrameRef.current = null;
        disabledFadeTimeoutRef.current = null;
        onDisabledFadeOutComplete(video.currentTime);
      };

      if (duration <= 0 || video.paused) {
        finishDisabledFade();
        return;
      }

      if (!shouldFadeAudio) {
        disabledFadeTimeoutRef.current = window.setTimeout(
          finishDisabledFade,
          duration,
        );
        return () => clearDisabledFade();
      }

      let start: number;

      const fade = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = timestamp - start;
        const volumeMultiplier = Math.max(0, 1 - progress / duration);
        video.volume = initialVolume * volumeMultiplier;

        if (progress < duration) {
          disabledFadeFrameRef.current = requestAnimationFrame(fade);
          return;
        }

        finishDisabledFade();
      };

      disabledFadeFrameRef.current = requestAnimationFrame(fade);
      return () => clearDisabledFade();
    }

    clearDisabledFade();
    video.volume = 1;
    video.play().catch(() => {});

    return () => clearDisabledFade();
  }, [
    areTrailersEnabled,
    isCarouselPaused,
    isPresent,
    isPreviewMuted,
    onDisabledFadeOutComplete,
    shouldPlay,
    shouldReduceMotion,
  ]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPresent) {
      video.volume = 1;
    } else {
      const initialVolume = video.volume;
      const duration = shouldReduceMotion ? 0 : 1200;

      if (duration <= 0 || isPreviewMuted) {
        video.muted = true;
        return;
      }

      let start: number;
      let animationFrame: number;

      const fade = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = timestamp - start;

        const volumeMultiplier = Math.max(0.01, 1 - progress / duration);
        video.volume = initialVolume * volumeMultiplier;

        if (progress < duration) {
          animationFrame = requestAnimationFrame(fade);
          return;
        }

        video.muted = true;
      };

      animationFrame = requestAnimationFrame(fade);

      return () => cancelAnimationFrame(animationFrame);
    }
  }, [isPresent, shouldReduceMotion, isPreviewMuted]);

  const handleLoadedMetadata = () => {
    const video = videoRef.current;

    if (video) {
      const dur = video.duration;
      if (!Number.isNaN(dur) && dur > 0) {
        onDurationChange(dur * 1000);

        const safeResumeTime = Math.min(
          Math.max(resumeTimeSeconds, 0),
          Math.max(dur - 0.25, 0),
        );

        if (
          safeResumeTime > 0 &&
          Math.abs(video.currentTime - safeResumeTime) > 0.25
        ) {
          try {
            video.currentTime = safeResumeTime;
          } catch {
            // Some browsers reject early seeks before enough metadata is ready.
          }
        }
      }

      onPlaybackTimeChange(video.currentTime);
    }
  };

  return (
    <motion.video
      ref={videoRef}
      src={previewUrl ?? undefined}
      className="absolute inset-0 z-[1] h-full w-full object-cover"
      autoPlay={false}
      muted={isPreviewMuted}
      playsInline
      preload="auto"
      onLoadedMetadata={handleLoadedMetadata}
      onLoadStart={onLoadStart}
      onCanPlay={onCanPlay}
      onPlay={onPlay}
      onTimeUpdate={(event) => {
        onPlaybackTimeChange(event.currentTarget.currentTime);
      }}
      onEnded={onEnded}
      onError={onError}
      initial={{
        opacity: 0,
        scale: shouldReduceMotion ? 1 : 1.035,
        filter: shouldReduceMotion ? "none" : "blur(10px)",
      }}
      animate={{
        opacity: isPreviewReady && shouldPlay ? 1 : 0,
        scale: 1,
        filter:
          (isPreviewReady && shouldPlay) || shouldReduceMotion
            ? "none"
            : "blur(10px)",
      }}
      exit={{
        opacity: 0,
        scale: shouldReduceMotion ? 1 : 1.025,
        filter: shouldReduceMotion ? "none" : "blur(10px)",
      }}
      transition={{
        duration: shouldReduceMotion ? 0 : 1.2,
        ease: softEase,
      }}
    />
  );
}

export function HeroSection({
  item,
  smartContinueItems,
  variant = "carousel",
  currentIndex = 0,
  totalItems = 0,
  durationMs = HERO_DEFAULT_SLIDE_DURATION_MS,
  progressStartedAtMs,
  progressResetKey,
  isPaused = false,
  onTogglePaused,
  onPreviewPlaybackChange,
  showPauseButton = false,
  indicatorPlacement = "bottom-right-quarter",
  onSelectIndex,
  onHeroReady,
  onSlideDurationChange,
  enablePreview = true,
  keepDetailsVisible = false,
}: HeroSectionProps) {
  const { language, t } = useLanguage();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const navigate = useNavigate();
  const heroSectionRef = useRef<HTMLElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewReady, setIsPreviewReady] = useState(false);
  const [hasPreviewEnded, setHasPreviewEnded] = useState(false);
  const [areTrailersEnabled, setAreTrailersEnabled] = useState(
    readHeroTrailersEnabledPreference,
  );
  const [isPreviewStartDelayDone, setIsPreviewStartDelayDone] = useState(false);
  const [shouldStartPreviewUnmuted, setShouldStartPreviewUnmuted] =
    useState(false);
  const [isPreviewMuted, setIsPreviewMuted] = useState(true);
  const isPreviewReadyRef = useRef(false);
  const isPreviewMutedRef = useRef(true);
  const areTrailersEnabledRef = useRef(areTrailersEnabled);
  const shouldStartPreviewUnmutedRef = useRef(false);
  const previewDurationMsRef = useRef<number | null>(null);
  const previewPlaybackSecondsRef = useRef(0);
  const postTrailerElapsedMsRef = useRef(0);
  const disabledPostPhaseStartedAtMsRef = useRef<number | null>(null);
  const hasPreviewEndedRef = useRef(false);
  const [failedImageUrls, setFailedImageUrls] = useState<string[]>([]);
  const [loadedImageUrl, setLoadedImageUrl] = useState<string | null>(null);
  const [isLogoLoaded, setIsLogoLoaded] = useState(false);
  const [isHeroIntroDone, setIsHeroIntroDone] = useState(false);

  const [fallbackSmartContinueItems, setFallbackSmartContinueItems] = useState<
    MediaItem[]
  >([]);

  useEffect(() => {
    if (smartContinueItems) {
      return;
    }

    let cancelled = false;

    const loadSmartContinueItems = async () => {
      const items = await getSmartContinueWatchingItems().catch(
        () => [] as MediaItem[],
      );

      if (!cancelled) {
        setFallbackSmartContinueItems(items);
      }
    };

    void loadSmartContinueItems();

    const handleWatchStatusChanged = () => {
      void loadSmartContinueItems();
    };

    window.addEventListener(
      WATCH_STATUS_CHANGED_EVENT,
      handleWatchStatusChanged,
    );

    return () => {
      cancelled = true;
      window.removeEventListener(
        WATCH_STATUS_CHANGED_EVENT,
        handleWatchStatusChanged,
      );
    };
  }, [smartContinueItems]);

  const hasPreview = Boolean(previewUrl && !hasPreviewEnded);
  const shouldPlayPreview = Boolean(
    enablePreview &&
    hasPreview &&
    areTrailersEnabled &&
    isPreviewStartDelayDone,
  );
  const shouldRenderPreview = Boolean(
    enablePreview && hasPreview && (areTrailersEnabled || isPreviewReady),
  );
  const shouldShowPreviewRef = useRef(shouldPlayPreview);

  useEffect(() => {
    shouldShowPreviewRef.current = shouldPlayPreview;
  }, [shouldPlayPreview]);

  useEffect(() => {
    isPreviewReadyRef.current = isPreviewReady;
  }, [isPreviewReady]);

  useEffect(() => {
    isPreviewMutedRef.current = isPreviewMuted;
  }, [isPreviewMuted]);

  useEffect(() => {
    areTrailersEnabledRef.current = areTrailersEnabled;
  }, [areTrailersEnabled]);

  useEffect(() => {
    hasPreviewEndedRef.current = hasPreviewEnded;
  }, [hasPreviewEnded]);

  useEffect(() => {
    shouldStartPreviewUnmutedRef.current = shouldStartPreviewUnmuted;
  }, [shouldStartPreviewUnmuted]);

  useEffect(() => {
    if (!enablePreview) {
      return;
    }

    const handleGlobalPointerDown = () => {
      const previewIsShowing = shouldShowPreviewRef.current;
      const previewIsReady = isPreviewReadyRef.current;
      const previewIsMuted = isPreviewMutedRef.current;

      if (!previewIsShowing || !previewIsReady) {
        setShouldStartPreviewUnmuted(true);
        setIsPreviewMuted(false);
        return;
      }

      if (!previewIsMuted) {
        setShouldStartPreviewUnmuted(true);
      }
    };

    window.addEventListener("pointerdown", handleGlobalPointerDown, {
      capture: true,
    });

    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown, {
        capture: true,
      });
    };
  }, [enablePreview]);

  const [showStickyIndicators, setShowStickyIndicators] = useState(true);
  const [isCompactHeroViewport, setIsCompactHeroViewport] = useState(false);
  const episodeMetadata =
    item?.Type === "Episode" ? getEpisodeDisplayMetadata(item, language) : null;
  const itemMetadata =
    item && item.Type !== "Episode"
      ? getItemDisplayMetadata(item, language)
      : null;
  const imageCandidates = useMemo(() => {
    const candidates = getHeroImageCandidates(item);

    if (item?.Type !== "Episode" || !episodeMetadata?.thumbnailUrl) {
      return candidates;
    }

    return [
      { type: "primary" as const, url: episodeMetadata.thumbnailUrl },
      ...candidates.filter(
        (candidate) => candidate.url !== episodeMetadata.thumbnailUrl,
      ),
    ];
  }, [episodeMetadata?.thumbnailUrl, item]);
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const selectedImage = imageCandidates.find(
    (candidate) => !failedImageUrls.includes(candidate.url),
  );
  const primaryPosterUrl =
    imageCandidates.find((candidate) => candidate.type === "primary")?.url ??
    "";
  const fallbackLogoUrl = item?.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 1100)
    : "";
  const logoUrl = item ? getItemLogoUrl(item, language, fallbackLogoUrl) : "";

  const croppedLogoUrl = useCroppedTransparentImage(logoUrl);

  const showSidePoster = Boolean(
    primaryPosterUrl && selectedImage?.type === "primary",
  );
  const title = item
    ? (episodeMetadata?.title ??
      itemMetadata?.title ??
      getDisplayTitle(item, mediaFormatLabels))
    : "Seyirlik";
  const runtime = item
    ? formatRuntime(item.RunTimeTicks, mediaFormatLabels)
    : null;
  const mediaTypeLabel =
    item?.Type === "Movie"
      ? t("common.movie")
      : item?.Type === "Series"
        ? t("common.series")
        : item?.Type === "BoxSet"
          ? t("common.boxsets")
          : item?.Type;
  const metadata = [item?.ProductionYear, runtime, mediaTypeLabel].filter(
    Boolean,
  );
  /**
   * The facts that stay put once the intro is over: what it is and when it is
   * from. The pill row above them is part of the intro and fades with it.
   */
  const heroFacts = [item?.ProductionYear, runtime].filter(Boolean).join(" · ");
  const heroGenres = item?.Genres?.filter(Boolean).slice(0, 3) ?? [];
  const heroGenreLabel = heroGenres.join(" · ");
  const overview =
    episodeMetadata?.overview ??
    itemMetadata?.overview ??
    item?.Overview ??
    null;
  const subtitle = item ? getItemSubtitle(item, mediaFormatLabels) : null;
  const effectiveSmartContinueItems =
    smartContinueItems ?? fallbackSmartContinueItems;
  const heroSeriesId =
    item?.Type === "Series"
      ? item.Id
      : item?.Type === "Season"
        ? item.SeriesId
        : item?.Type === "Episode"
          ? item.SeriesId
          : undefined;
  const smartContinueTarget = item
    ? effectiveSmartContinueItems.find((candidate) => {
        if (item.Type === "Movie" || item.Type === "Episode") {
          return candidate.Id === item.Id;
        }

        if (heroSeriesId) {
          return (
            candidate.Type === "Episode" && candidate.SeriesId === heroSeriesId
          );
        }

        return false;
      })
    : undefined;
  const effectivePlayItem = smartContinueTarget ?? item;
  const hasResumeProgress =
    (smartContinueTarget?.UserData?.PlaybackPositionTicks ?? 0) > 0;
  const smartEpisodeLabel =
    smartContinueTarget?.Type === "Episode" &&
    typeof smartContinueTarget.ParentIndexNumber === "number" &&
    typeof smartContinueTarget.IndexNumber === "number"
      ? t("media.seasonEpisodeNumber")
          .replace(
            "{seasonNumber}",
            String(smartContinueTarget.ParentIndexNumber),
          )
          .replace("{episodeNumber}", String(smartContinueTarget.IndexNumber))
      : null;
  const canStartOver = canStartOverFromHero(effectivePlayItem);
  const playButtonLabel = smartEpisodeLabel
    ? `${
        hasResumeProgress ? t("details.continueWatching") : t("common.play")
      }: ${smartEpisodeLabel}`
    : hasResumeProgress
      ? t("details.continueWatching")
      : t("common.play");
  const canPlay = Boolean(
    effectivePlayItem &&
    (effectivePlayItem.Type === "Movie" ||
      effectivePlayItem.Type === "Episode" ||
      effectivePlayItem.Type === "Series" ||
      effectivePlayItem.MediaType === "Video"),
  );
  const playTo = effectivePlayItem
    ? effectivePlayItem.Type === "Series"
      ? getRouteForItem(effectivePlayItem)
      : `/watch/${effectivePlayItem.Id}`
    : "#";
  const handlePlayClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!effectivePlayItem) {
      return;
    }

    event.preventDefault();

    const target = await getPlayTargetForItem(effectivePlayItem);
    navigate(target);
  };
  const easeOut: [number, number, number, number] = [0.16, 1, 0.3, 1];
  const softEase: [number, number, number, number] = [0.25, 1, 0.5, 1];
  const heroImageLoaded = Boolean(
    selectedImage && loadedImageUrl === selectedImage.url,
  );
  const heroContentVisible = !selectedImage || heroImageLoaded;
  const contentKey = item?.Id ?? "hero-fallback";
  const isFixedHero = variant === "fixed";
  const carouselItemCount = isFixedHero ? 1 : totalItems;
  const showCarouselDots = !isFixedHero && carouselItemCount > 1;
  const activeCarouselIndex = isFixedHero
    ? 0
    : Math.min(Math.max(currentIndex, 0), Math.max(carouselItemCount - 1, 0));
  const showHeroIndicators = showCarouselDots && showStickyIndicators;
  const heroIndicatorsRef = useRef<HTMLDivElement | null>(null);

  const indicatorPlacementClasses: Record<IndicatorsPlacement, string> = {
    "top-center":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-center",
    "top-right":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-end",
    "top-left":
      "inset-x-0 top-[calc(0.85rem+env(safe-area-inset-top))] justify-start",
    "top-left-quarter":
      "left-1/4 top-[calc(0.85rem+env(safe-area-inset-top))] -translate-x-1/2 justify-center",
    "top-right-quarter":
      "left-3/4 top-[calc(0.85rem+env(safe-area-inset-top))] -translate-x-1/2 justify-center",
    "bottom-center":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-right":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-end sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-left":
      "inset-x-0 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] justify-start sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-left-quarter":
      "left-1/4 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] -translate-x-1/2 justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
    "bottom-right-quarter":
      "left-3/4 bottom-[calc(0.85rem+env(safe-area-inset-bottom))] -translate-x-1/2 justify-center sm:bottom-[calc(clamp(5.75rem,10vh,7.25rem)+env(safe-area-inset-bottom))]",
  };

  const heroIndicators = showCarouselDots ? (
    <AnimatePresence>
      {showHeroIndicators ? (
        <motion.div
          key="hero-carousel-indicators"
          ref={heroIndicatorsRef}
          layout
          data-hero-carousel-indicators
          className={`pointer-events-none fixed z-[99999] flex px-3 sm:px-4 ${indicatorPlacementClasses[indicatorPlacement]}`}
          initial={{
            opacity: 0,
            y: shouldReduceMotion ? 0 : INDICATOR_TRAVEL,
            scale: shouldReduceMotion ? 1 : 0.96,
          }}
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
          }}
          exit={{
            opacity: 0,
            y: shouldReduceMotion ? 0 : INDICATOR_TRAVEL,
            scale: 1,
          }}
          /*
           * Shared with the notification pile, which travels the lane this
           * control frees or takes. The two only read as one movement while
           * they keep exactly the same time, so the numbers live next to the
           * reservation itself rather than once at each end.
           */
          transition={{
            duration: shouldReduceMotion ? 0 : INDICATOR_MOTION.durationS,
            delay: shouldReduceMotion ? 0 : INDICATOR_MOTION.delayS,
            ease: INDICATOR_MOTION.ease,
          }}
        >
          <div className="pointer-events-auto max-w-[calc(100vw-1.5rem)] -translate-x-7 overflow-hidden rounded-full border border-white/25 bg-black/80 p-1 shadow-[0_24px_90px_rgba(0,0,0,0.78),0_0_0_1px_rgba(255,255,255,0.08)] sm:max-w-[calc(100vw-2rem)] sm:-translate-x-8 sm:p-1.5">
            <TimedCarouselIndicators
              count={carouselItemCount}
              activeIndex={activeCarouselIndex}
              durationMs={durationMs}
              progressStartedAtMs={progressStartedAtMs}
              onSelect={(index) => onSelectIndex?.(index)}
              isPaused={isPaused}
              progressResetKey={progressResetKey}
              onTogglePaused={onTogglePaused}
              showPauseButton={showPauseButton}
              isPauseButtonDisabled={false}
              maxVisibleDots={9}
              ariaLabel="Featured carousel"
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  ) : null;

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setIsPreviewReady(false);

    if (!item || !enablePreview) {
      return;
    }

    getHeroPreviewUrl(item)
      .then((url) => {
        if (!cancelled) {
          setPreviewUrl(url);
        }
      })
      .catch((error) => {
        console.debug("[Seyirlik Hero] No preview trailer available", {
          itemId: item.Id,
          error,
        });

        if (!cancelled) {
          setPreviewUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enablePreview, item?.Id]);

  useEffect(() => {
    setFailedImageUrls([]);
    setIsLogoLoaded(false);
    setPreviewUrl(null);
    setIsPreviewReady(false);
    setIsPreviewStartDelayDone(false);
    setHasPreviewEnded(false);
    setIsPreviewMuted(!shouldStartPreviewUnmutedRef.current);
    previewDurationMsRef.current = null;
    previewPlaybackSecondsRef.current = 0;
    postTrailerElapsedMsRef.current = 0;
    disabledPostPhaseStartedAtMsRef.current = null;
    hasPreviewEndedRef.current = false;
    onPreviewPlaybackChange?.(false);

    if (!areTrailersEnabledRef.current) {
      onSlideDurationChange?.(
        HERO_DESCRIPTION_VISIBLE_MS + HERO_POST_TRAILER_VISIBLE_MS,
      );
    }
  }, [item?.Id, onPreviewPlaybackChange, onSlideDurationChange]);

  useEffect(() => {
    setIsPreviewStartDelayDone(false);

    if (!enablePreview || !item?.Id || !areTrailersEnabledRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsPreviewStartDelayDone(true);
    }, HERO_DESCRIPTION_VISIBLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enablePreview, item?.Id]);

  useEffect(() => {
    setIsLogoLoaded(false);
  }, [croppedLogoUrl]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 640px)");
    const updateCompactViewport = () =>
      setIsCompactHeroViewport(mediaQuery.matches);

    updateCompactViewport();
    mediaQuery.addEventListener("change", updateCompactViewport);

    return () => {
      mediaQuery.removeEventListener("change", updateCompactViewport);
    };
  }, []);

  useEffect(() => {
    setIsHeroIntroDone(false);

    if (!item?.Id || keepDetailsVisible) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsHeroIntroDone(true);
    }, HERO_DESCRIPTION_VISIBLE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [item?.Id, keepDetailsVisible]);

  useEffect(() => {
    if (!heroContentVisible) {
      return;
    }

    onHeroReady?.();
  }, [heroContentVisible, onHeroReady]);

  useEffect(() => {
    const updateStickyIndicatorVisibility = () => {
      const heroSection = heroSectionRef.current;

      if (!heroSection) {
        setShowStickyIndicators(false);
        return;
      }

      const heroRect = heroSection.getBoundingClientRect();
      const heroTop = heroRect.top + window.scrollY;
      const bannerBottom = heroTop + window.innerHeight;
      const indicatorLimit =
        bannerBottom +
        window.innerHeight * (HERO_INDICATOR_AFTER_BANNER_LIMIT_VH / 100);
      const viewportBottom = window.scrollY + window.innerHeight;

      setShowStickyIndicators(viewportBottom <= indicatorLimit);
    };

    updateStickyIndicatorVisibility();
    window.addEventListener("scroll", updateStickyIndicatorVisibility, {
      passive: true,
    });
    window.addEventListener("resize", updateStickyIndicatorVisibility);

    return () => {
      window.removeEventListener("scroll", updateStickyIndicatorVisibility);
      window.removeEventListener("resize", updateStickyIndicatorVisibility);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    const heroRect = heroSectionRef.current?.getBoundingClientRect();
    const bannerBottom =
      heroRect && typeof window !== "undefined"
        ? heroRect.top + window.scrollY + window.innerHeight
        : null;

    console.debug("[Seyirlik Hero] carousel indicators", {
      carouselItemCount,
      showCarouselDots,
      currentIndex,
      activeCarouselIndex,
      featuredItem: item
        ? {
            id: item.Id,
            name: item.Name,
          }
        : null,
      heroContentVisible,
      showStickyIndicators,
      loadedImageUrl: loadedImageUrl
        ? redactPlaybackUrl(loadedImageUrl)
        : loadedImageUrl,
      selectedImageUrl: selectedImage?.url
        ? redactPlaybackUrl(selectedImage.url)
        : selectedImage?.url,
      selectedImageType: selectedImage?.type,
      scrollY: typeof window === "undefined" ? null : window.scrollY,
      viewportBottom:
        typeof window === "undefined"
          ? null
          : window.scrollY + window.innerHeight,
      heroSectionRect: heroRect
        ? {
            top: heroRect.top,
            right: heroRect.right,
            bottom: heroRect.bottom,
            left: heroRect.left,
            width: heroRect.width,
            height: heroRect.height,
          }
        : null,
      bannerBottom,
      indicatorLimit:
        bannerBottom === null || typeof window === "undefined"
          ? null
          : bannerBottom +
            window.innerHeight * (HERO_INDICATOR_AFTER_BANNER_LIMIT_VH / 100),
      indicatorLimitExtraVh: HERO_INDICATOR_AFTER_BANNER_LIMIT_VH,
      reason: showCarouselDots
        ? showStickyIndicators
          ? "Indicators should be mounted and visible."
          : "Indicators are mounted but fading because the viewport bottom is past the hero indicator limit."
        : "Indicators are intentionally not mounted because carouselItemCount <= 1; TimedCarouselIndicators returns null for a single slide.",
    });
  }, [
    activeCarouselIndex,
    carouselItemCount,
    currentIndex,
    heroContentVisible,
    item,
    loadedImageUrl,
    selectedImage?.type,
    selectedImage?.url,
    showCarouselDots,
    showStickyIndicators,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV || !item) {
      return;
    }

    console.debug("[Seyirlik Hero] selected featured artwork", {
      name: item.Name,
      id: item.Id,
      hasBackdropImageTags: Boolean(
        item.BackdropImageTags?.[0] || item.ParentBackdropImageTags?.[0],
      ),
      hasPrimaryImage: Boolean(item.ImageTags?.Primary),
      selectedHeroImageType: selectedImage?.type ?? "fallback",
      selectedHeroImageUrl: selectedImage?.url
        ? redactPlaybackUrl(selectedImage.url)
        : "gradient-fallback",
    });
  }, [item, selectedImage]);

  const handleImageError = (url: string) => {
    setFailedImageUrls((currentUrls) =>
      currentUrls.includes(url) ? currentUrls : [...currentUrls, url],
    );
  };

  const getSlideElapsedMs = () => {
    if (typeof progressStartedAtMs !== "number") {
      return 0;
    }

    return Math.max(0, Date.now() - progressStartedAtMs);
  };

  const getPostTrailerElapsedMs = () => {
    let elapsedMs = postTrailerElapsedMsRef.current;
    const disabledPostStartedAtMs = disabledPostPhaseStartedAtMsRef.current;

    if (disabledPostStartedAtMs !== null) {
      elapsedMs += Math.max(0, Date.now() - disabledPostStartedAtMs);
    }

    const previewDurationMs = previewDurationMsRef.current;

    if (hasPreviewEndedRef.current && previewDurationMs !== null) {
      elapsedMs = Math.max(
        elapsedMs,
        getSlideElapsedMs() - HERO_DESCRIPTION_VISIBLE_MS - previewDurationMs,
      );
    }

    return Math.min(Math.max(elapsedMs, 0), HERO_POST_TRAILER_VISIBLE_MS);
  };

  const getPreviewElapsedMs = () => {
    const previewDurationMs = previewDurationMsRef.current;
    const measuredElapsedMs = Math.max(
      0,
      previewPlaybackSecondsRef.current * 1000,
    );

    if (previewDurationMs === null) {
      return measuredElapsedMs;
    }

    const derivedElapsedMs = Math.max(
      0,
      getSlideElapsedMs() -
        HERO_DESCRIPTION_VISIBLE_MS -
        getPostTrailerElapsedMs(),
    );

    return Math.min(
      previewDurationMs,
      Math.max(measuredElapsedMs, derivedElapsedMs),
    );
  };

  const updateSlideDurationForPhase = (
    trailersEnabled: boolean,
    options: { skipIntro?: boolean } = {},
  ) => {
    const elapsedMs = getSlideElapsedMs();
    const remainingIntroMs =
      trailersEnabled && (options.skipIntro ?? isPreviewStartDelayDone)
        ? 0
        : Math.max(0, HERO_DESCRIPTION_VISIBLE_MS - elapsedMs);
    const previewDurationMs = previewDurationMsRef.current;
    const previewElapsedMs = getPreviewElapsedMs();
    previewPlaybackSecondsRef.current = previewElapsedMs / 1000;
    const remainingTrailerMs =
      trailersEnabled &&
      previewDurationMs !== null &&
      !hasPreviewEndedRef.current
        ? Math.max(0, previewDurationMs - previewElapsedMs)
        : 0;
    const remainingPostTrailerMs = Math.max(
      0,
      HERO_POST_TRAILER_VISIBLE_MS - getPostTrailerElapsedMs(),
    );

    onSlideDurationChange?.(
      elapsedMs +
        remainingIntroMs +
        remainingTrailerMs +
        remainingPostTrailerMs,
    );
  };

  const handleToggleTrailers = () => {
    setAreTrailersEnabled((current) => {
      const nextEnabled = !current;
      saveHeroTrailersEnabledPreference(nextEnabled);
      areTrailersEnabledRef.current = nextEnabled;

      postTrailerElapsedMsRef.current = getPostTrailerElapsedMs();

      if (nextEnabled) {
        disabledPostPhaseStartedAtMsRef.current = null;
        setIsPreviewStartDelayDone(true);
        updateSlideDurationForPhase(true, { skipIntro: true });
      } else {
        const elapsedMs = getSlideElapsedMs();
        const remainingIntroMs = Math.max(
          0,
          HERO_DESCRIPTION_VISIBLE_MS - elapsedMs,
        );

        disabledPostPhaseStartedAtMsRef.current = Date.now() + remainingIntroMs;
        setIsPreviewStartDelayDone(false);
        updateSlideDurationForPhase(false);
      }

      return nextEnabled;
    });
  };

  return (
    <>
      <section
        ref={heroSectionRef}
        className="seyirlik-hero-section relative mb-0 min-h-[min(100svh,44rem)] w-full overflow-hidden bg-zinc-950 sm:min-h-screen"
      >
        <div className="absolute inset-0 z-0 bg-[linear-gradient(145deg,#18181b_0%,#09090b_52%,#050506_100%)]" />
        <AnimatePresence initial>
          {selectedImage ? (
            <motion.img
              key={selectedImage.url}
              src={selectedImage.url}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              alt=""
              className={`seyirlik-hero-artwork absolute inset-0 z-0 h-full w-full object-cover ${
                selectedImage.type === "primary" ? "blur-2xl" : ""
              }`}
              initial={{
                opacity: 0,
                scale: shouldReduceMotion
                  ? 1
                  : selectedImage.type === "primary"
                    ? 1.16
                    : 1.07,
                filter: shouldReduceMotion ? "none" : "blur(18px)",
              }}
              animate={{
                opacity: heroImageLoaded
                  ? shouldPlayPreview && isPreviewReady
                    ? 0
                    : selectedImage.type === "primary"
                      ? 0.52
                      : 0.78
                  : 0,
                scale: heroImageLoaded
                  ? selectedImage.type === "primary"
                    ? 1.1
                    : 1
                  : shouldReduceMotion
                    ? 1
                    : selectedImage.type === "primary"
                      ? 1.13
                      : 1.04,
                filter:
                  heroImageLoaded || shouldReduceMotion ? "none" : "blur(16px)",
              }}
              exit={{
                opacity: 0,
                scale: shouldReduceMotion
                  ? 1
                  : selectedImage.type === "primary"
                    ? 1.12
                    : 1.035,
                filter: shouldReduceMotion ? "none" : "blur(16px)",
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 1.45,
                ease: softEase,
              }}
              onLoad={() => setLoadedImageUrl(selectedImage.url)}
              onError={() => handleImageError(selectedImage.url)}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {shouldRenderPreview ? (
            <HeroPreviewVideo
              key={`${item?.Id}-hero-preview`}
              previewUrl={previewUrl}
              isPreviewMuted={isPreviewMuted}
              shouldReduceMotion={shouldReduceMotion}
              isPreviewReady={isPreviewReady}
              areTrailersEnabled={areTrailersEnabled}
              resumeTimeSeconds={previewPlaybackSecondsRef.current}
              softEase={softEase}
              isCarouselPaused={isPaused}
              shouldPlay={shouldPlayPreview}
              onDurationChange={(durationMs) => {
                previewDurationMsRef.current = durationMs;
                updateSlideDurationForPhase(areTrailersEnabledRef.current);
              }}
              onPlaybackTimeChange={(timeSeconds) => {
                previewPlaybackSecondsRef.current = Math.max(0, timeSeconds);
              }}
              onLoadStart={() => {
                if (shouldPlayPreview) {
                  onPreviewPlaybackChange?.(true);
                }
              }}
              onCanPlay={() => setIsPreviewReady(true)}
              onPlay={() => {
                onPreviewPlaybackChange?.(true);
              }}
              onDisabledFadeOutComplete={(timeSeconds) => {
                previewPlaybackSecondsRef.current = Math.max(0, timeSeconds);

                if (areTrailersEnabledRef.current) {
                  return;
                }

                setIsPreviewReady(false);
                onPreviewPlaybackChange?.(false);
              }}
              onEnded={() => {
                hasPreviewEndedRef.current = true;
                if (previewDurationMsRef.current !== null) {
                  previewPlaybackSecondsRef.current =
                    previewDurationMsRef.current / 1000;
                }
                setHasPreviewEnded(true);
                setIsPreviewReady(false);
                onPreviewPlaybackChange?.(false);
              }}
              onError={() => {
                hasPreviewEndedRef.current = true;
                setPreviewUrl(null);
                setIsPreviewReady(false);
                setHasPreviewEnded(true);
                onPreviewPlaybackChange?.(false);
              }}
            />
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {item && enablePreview ? (
            <motion.div
              key="hero-preview-controls"
              className="absolute right-0 top-1/2 z-30 flex -translate-y-1/2 flex-col items-end gap-2 sm:gap-3"
              initial={{ opacity: 0, x: 38, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 38, scale: 0.96 }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.28,
                ease: softEase,
              }}
            >
              <Tooltip
                content={
                  areTrailersEnabled
                    ? t("hero.disableTrailers")
                    : t("hero.enableTrailers")
                }
                placement="left"
              >
                <button
                  type="button"
                  className="group flex h-12 w-24 items-center justify-start rounded-l-full border-y border-l border-white/[0.18] bg-white/5 pl-4 pr-3 text-white shadow-[0_22px_80px_rgba(0,0,0,0.48),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl transition-colors hover:bg-white/[0.18] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-16 sm:w-28 sm:pl-5 sm:pr-4"
                  onClick={handleToggleTrailers}
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.18] bg-white/[0.14] shadow-[0_12px_35px_rgba(0,0,0,0.35)] sm:h-11 sm:w-11">
                    <AnimatePresence mode="wait" initial={false}>
                      {areTrailersEnabled ? (
                        <motion.span
                          key="trailers-enabled"
                          className="flex items-center justify-center"
                          initial={
                            shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                          }
                          animate={{ scale: 1 }}
                          exit={
                            shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                          }
                          transition={{
                            duration: shouldReduceMotion ? 0 : 0.16,
                            ease: softEase,
                          }}
                        >
                          <Video
                            className="h-5 w-5 sm:h-5 sm:w-5"
                            strokeWidth={2.4}
                          />
                        </motion.span>
                      ) : (
                        <motion.span
                          key="trailers-disabled"
                          className="flex items-center justify-center"
                          initial={
                            shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                          }
                          animate={{ scale: 1 }}
                          exit={
                            shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                          }
                          transition={{
                            duration: shouldReduceMotion ? 0 : 0.16,
                            ease: softEase,
                          }}
                        >
                          <VideoOff
                            className="h-5 w-5 sm:h-5 sm:w-5"
                            strokeWidth={2.4}
                          />
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                </button>
              </Tooltip>

              <AnimatePresence>
                {shouldPlayPreview && isPreviewReady ? (
                  <Tooltip
                    content={
                      isPreviewMuted ? t("player.unmute") : t("player.mute")
                    }
                    placement="left"
                  >
                    <motion.button
                      key="hero-preview-mute-toggle"
                      type="button"
                      className="group flex h-12 w-24 items-center justify-start rounded-l-full border-y border-l border-white/[0.18] bg-white/5 pl-4 pr-3 text-white shadow-[0_22px_80px_rgba(0,0,0,0.48),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl transition-colors hover:bg-white/[0.18] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black sm:h-16 sm:w-28 sm:pl-5 sm:pr-4"
                      initial={{ opacity: 0, x: 28, scale: 0.96 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: 28, scale: 0.96 }}
                      transition={{
                        duration: shouldReduceMotion ? 0 : 0.22,
                        ease: softEase,
                      }}
                      onClick={() => {
                        setIsPreviewMuted((current) => {
                          const nextMuted = !current;
                          setShouldStartPreviewUnmuted(!nextMuted);
                          return nextMuted;
                        });
                      }}
                    >
                      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.18] bg-white/[0.14] shadow-[0_12px_35px_rgba(0,0,0,0.35)] sm:h-11 sm:w-11">
                        <AnimatePresence mode="wait" initial={false}>
                          {isPreviewMuted ? (
                            <motion.span
                              key="muted"
                              className="flex items-center justify-center"
                              initial={
                                shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                              }
                              animate={{ scale: 1 }}
                              exit={
                                shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                              }
                              transition={{
                                duration: shouldReduceMotion ? 0 : 0.16,
                                ease: softEase,
                              }}
                            >
                              <VolumeX
                                className="h-5 w-5 sm:h-5 sm:w-5"
                                strokeWidth={2.4}
                              />
                            </motion.span>
                          ) : (
                            <motion.span
                              key="unmuted"
                              className="flex items-center justify-center"
                              initial={
                                shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                              }
                              animate={{ scale: 1 }}
                              exit={
                                shouldReduceMotion ? { scale: 1 } : { scale: 0 }
                              }
                              transition={{
                                duration: shouldReduceMotion ? 0 : 0.16,
                                ease: softEase,
                              }}
                            >
                              <Volume2
                                className="h-5 w-5 sm:h-5 sm:w-5"
                                strokeWidth={2.4}
                              />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                    </motion.button>
                  </Tooltip>
                ) : null}
              </AnimatePresence>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div
          className="hero-cinematic-vignette z-10"
          initial={false}
          animate={{
            opacity: isHeroIntroDone ? 0.12 : 1,
          }}
          transition={{
            duration: shouldReduceMotion ? 0 : 1.25,
            ease: softEase,
          }}
        />
        <div className="hero-bottom-fade z-10" />

        <div className="seyirlik-hero-content relative z-20 mx-auto flex min-h-[min(100svh,44rem)] w-full max-w-[1600px] flex-col justify-end px-4 pb-[calc(6.75rem+env(safe-area-inset-bottom))] pt-0 sm:min-h-screen sm:px-6 sm:pb-[clamp(3rem,8vh,6rem)] sm:pt-28 lg:px-8">
          {/* eslint-disable-next-line no-constant-condition -- see TODO below */}
          {showSidePoster && false ? ( //TODO - for now I made it always false because of a bug
            <motion.div
              className="artwork-edge-vignette pointer-events-none absolute bottom-20 right-8 hidden w-[min(26vw,21rem)] overflow-hidden rounded-3xl border border-white/[0.12] bg-black/[0.35] shadow-artwork-glow lg:block"
              initial={false}
              animate={{
                opacity: heroContentVisible ? 1 : 0,
                y: heroContentVisible ? 0 : 18,
                scale: heroContentVisible ? 1 : 0.985,
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.55,
                delay: shouldReduceMotion ? 0 : 0.12,
                ease: easeOut,
              }}
            >
              <img
                src={primaryPosterUrl}
                alt=""
                className="aspect-[2/3] w-full object-cover"
                onError={() => handleImageError(primaryPosterUrl)}
              />
            </motion.div>
          ) : null}
          <AnimatePresence mode="wait" initial>
            <motion.div
              key={contentKey}
              className="max-w-[min(32rem,88vw)] sm:max-w-3xl"
              initial={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : 28,
                scale: shouldReduceMotion ? 1 : 0.982,
                filter: shouldReduceMotion ? "none" : "blur(14px)",
              }}
              animate={{
                opacity: heroContentVisible ? 1 : 0,
                y: heroContentVisible || shouldReduceMotion ? 0 : 18,
                scale: heroContentVisible || shouldReduceMotion ? 1 : 0.982,
                filter:
                  heroContentVisible || shouldReduceMotion
                    ? "none"
                    : "blur(10px)",
              }}
              exit={{
                opacity: 0,
                y: shouldReduceMotion ? 0 : -16,
                scale: shouldReduceMotion ? 1 : 0.992,
                filter: shouldReduceMotion ? "none" : "blur(10px)",
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.5,
                delay: shouldReduceMotion ? 0 : 0.18,
                ease: softEase,
              }}
            >
              <motion.div
                className="cinematic-logo-motion-wrap origin-left"
                initial={{
                  opacity: 0,
                  y: shouldReduceMotion ? 0 : 20,
                  scale: shouldReduceMotion ? 1 : 0.975,
                }}
                animate={{
                  opacity: heroContentVisible ? 1 : 0,
                  y: heroContentVisible
                    ? isHeroIntroDone
                      ? isCompactHeroViewport
                        ? logoUrl
                          ? 48
                          : 42
                        : logoUrl
                          ? 145
                          : 64
                      : 0
                    : 14,
                  scale: heroContentVisible ? 1 : 0.985,
                }}
                transition={{
                  duration: shouldReduceMotion
                    ? 0
                    : isHeroIntroDone
                      ? 1.35
                      : 0.9,
                  delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.28,
                  ease: softEase,
                }}
              >
                {logoUrl ? (
                  <div className="relative flex h-[clamp(6rem,28vw,15rem)] w-[min(24rem,70vw)] items-end justify-start sm:h-[clamp(10rem,26vw,32rem)] sm:w-[min(44rem,72vw)]">
                    <motion.div
                      className="relative inline-block w-fit max-h-[clamp(6rem,28vw,15rem)] max-w-full leading-none sm:max-h-[clamp(10rem,26vw,32rem)]"
                      initial={false}
                      animate={{
                        scale: isHeroIntroDone
                          ? isCompactHeroViewport
                            ? 0.592
                            : 0.544
                          : 1,
                      }}
                      transition={{
                        duration: shouldReduceMotion
                          ? 0
                          : isHeroIntroDone
                            ? 1.35
                            : 0.9,
                        ease: softEase,
                      }}
                      style={{ transformOrigin: "left bottom" }}
                    >
                      <img
                        key={`shadow-${croppedLogoUrl || logoUrl}`}
                        src={croppedLogoUrl || logoUrl}
                        alt=""
                        draggable={false}
                        aria-hidden="true"
                        className={`cinematic-logo-shadow cinematic-logo-shadow-ghost block h-auto w-auto max-h-[clamp(6rem,28vw,15rem)] max-w-full sm:max-h-[clamp(10rem,26vw,32rem)] select-none transition-opacity duration-300 ${
                          isLogoLoaded ? "opacity-100" : "opacity-0"
                        }`}
                      />

                      <img
                        key={`logo-${croppedLogoUrl || logoUrl}`}
                        src={croppedLogoUrl || logoUrl}
                        alt={title}
                        draggable={false}
                        onLoad={() => setIsLogoLoaded(true)}
                        onError={() => setIsLogoLoaded(false)}
                        className={`cinematic-logo-image block h-auto w-auto max-h-[clamp(6rem,28vw,15rem)] max-w-full sm:max-h-[clamp(10rem,26vw,32rem)] select-none transition-opacity duration-300 ${
                          isLogoLoaded ? "opacity-100" : "opacity-0"
                        }`}
                      />
                    </motion.div>
                  </div>
                ) : (
                  <h1 className="text-cinematic-title max-w-3xl text-4xl font-black leading-[0.95] text-white sm:text-6xl lg:text-7xl">
                    {title}
                  </h1>
                )}

                {heroGenreLabel ? (
                  <motion.p
                    className="mt-2 max-w-2xl origin-left text-xs font-semibold leading-5 tracking-[0.01em] text-white/[0.84] drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] sm:mt-3 sm:text-sm sm:leading-6"
                    initial={false}
                    animate={{ scale: 1 }}
                    transition={{
                      duration: shouldReduceMotion
                        ? 0
                        : isHeroIntroDone
                          ? 1.35
                          : 0.9,
                      ease: softEase,
                    }}
                  >
                    {heroGenreLabel}
                  </motion.p>
                ) : null}
              </motion.div>
              {overview ? (
                <motion.p
                  className="mt-3 h-[4.5rem] max-w-2xl line-clamp-3 text-sm leading-6 text-white/[0.76] sm:mt-5 sm:h-[5.25rem] sm:text-lg sm:leading-7"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                    filter:
                      heroContentVisible && !isHeroIntroDone
                        ? "blur(0px)"
                        : "blur(0px)",
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 0.5
                        : 0.5,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.48,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {overview}
                </motion.p>
              ) : (
                <motion.p
                  className="mt-3 h-[4.5rem] max-w-2xl line-clamp-3 text-sm leading-6 text-white/[0.76] sm:mt-5 sm:h-[5.25rem] sm:text-lg sm:leading-7"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                    filter:
                      heroContentVisible && !isHeroIntroDone
                        ? "blur(0px)"
                        : "blur(0px)",
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.15
                        : 0.78,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.48,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {t("hero.fallbackDescription")}
                </motion.p>
              )}
              {/* eslint-disable-next-line no-constant-condition -- see TODO below */}
              {subtitle && false ? (
                <motion.p
                  className="mt-4 text-lg font-semibold text-white/[0.78]"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible ? 1 : 0,
                    y: heroContentVisible ? 0 : 10,
                  }}
                  transition={{
                    duration: shouldReduceMotion ? 0 : 0.62,
                    delay: shouldReduceMotion ? 0 : 0.36,
                    ease: softEase,
                  }}
                >
                  {subtitle}
                </motion.p>
              ) : null}
              {metadata.length > 0 ? (
                <motion.div
                  className="mt-4 flex flex-wrap gap-1.5 sm:mt-5 sm:gap-2"
                  initial={false}
                  animate={{
                    opacity: heroContentVisible && !isHeroIntroDone ? 1 : 0,
                    y: heroContentVisible ? (isHeroIntroDone ? 26 : 0) : 10,
                  }}
                  transition={{
                    duration: shouldReduceMotion
                      ? 0
                      : isHeroIntroDone
                        ? 1.15
                        : 0.74,
                    delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0 : 0.42,
                    ease: softEase,
                  }}
                  style={{
                    pointerEvents: isHeroIntroDone ? "none" : "auto",
                  }}
                >
                  {metadata.map((value) => (
                    <span
                      key={String(value)}
                      className="rounded-full border border-white/[0.12] bg-black/[0.32] px-2.5 py-1 text-xs font-semibold text-white/[0.82] backdrop-blur sm:px-3 sm:py-1.5 sm:text-sm"
                    >
                      {value}
                    </span>
                  ))}
                </motion.div>
              ) : null}
              <motion.div
                className="mt-5 flex flex-wrap gap-2.5 max-sm:flex-nowrap max-sm:gap-2 sm:mt-7 sm:gap-3"
                initial={false}
                animate={{
                  opacity: heroContentVisible ? 1 : 0,
                  y: heroContentVisible ? 0 : 10,
                }}
                transition={{
                  duration: shouldReduceMotion
                    ? 0
                    : isHeroIntroDone
                      ? 1.05
                      : 0.84,
                  delay: shouldReduceMotion ? 0 : isHeroIntroDone ? 0.08 : 0.56,
                  ease: softEase,
                }}
              >
                {item ? (
                  <>
                    {canPlay ? (
                      <ButtonLink
                        to={playTo}
                        className="bg-white min-h-10 rounded-full px-4 text-sm shadow-button-glow hover:translate-y-0 hover:bg-white/80 max-sm:h-12 max-sm:min-w-0 max-sm:!rounded-full max-sm:pl-5 max-sm:pr-6 max-sm:text-[0.9375rem] sm:min-h-16 sm:px-12 sm:text-lg"
                        onClick={handlePlayClick}
                      >
                        <Play
                          size={30}
                          fill="currentColor"
                          className="shrink-0 max-sm:h-[19px] max-sm:w-[19px]"
                        />
                        <AnimatedWidth value={playButtonLabel}>
                          <AnimatedText value={playButtonLabel} />
                        </AnimatedWidth>
                      </ButtonLink>
                    ) : null}
                    {canPlay && canStartOver ? (
                      <ButtonLink
                        to={`${playTo}${playTo.includes("?") ? "&" : "?"}start=0`}
                        variant="secondary"
                        aria-label={t("details.playFromBeginning")}
                        className="min-h-10 rounded-full px-4 text-sm hover:translate-y-0 max-sm:h-12 max-sm:w-12 max-sm:shrink-0 max-sm:!rounded-full max-sm:px-0 sm:min-h-16 sm:px-8 sm:text-base"
                      >
                        <RotateCcw
                          size={26}
                          className="shrink-0 max-sm:h-[18px] max-sm:w-[18px]"
                        />
                        {/* A phone's row has room for the glyph alone. */}
                        <span className="max-sm:hidden">
                          <AnimatedWidth value={t("details.playFromBeginning")}>
                            <AnimatedText
                              value={t("details.playFromBeginning")}
                            />
                          </AnimatedWidth>
                        </span>
                      </ButtonLink>
                    ) : null}
                    {!isFixedHero ? (
                      <ButtonLink
                        to={getRouteForItem(item)}
                        variant="secondary"
                        className="min-h-10 rounded-full px-4 text-sm hover:translate-y-0 sm:min-h-16 sm:px-10 sm:text-base"
                      >
                        <Info size={30} />
                        <AnimatedWidth value={t("common.details")}>
                          <AnimatedText value={t("common.details")} />
                        </AnimatedWidth>
                      </ButtonLink>
                    ) : null}
                    <FavouriteButton
                      item={item}
                      iconSize={26}
                      className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/[0.14] bg-black/[0.34] text-white/[0.82] backdrop-blur transition duration-200 hover:bg-white hover:text-zinc-950 focus:outline-none focus:ring-2 focus:ring-white/70 max-sm:h-12 max-sm:w-12 max-sm:shrink-0 max-sm:border-white/15 max-sm:bg-white/10 max-sm:text-white max-sm:[&_svg]:h-5 max-sm:[&_svg]:w-5 sm:min-h-16 sm:w-16"
                    />
                    {heroFacts && !keepDetailsVisible ? (
                      // The metadata pills above fade out as the intro settles,
                      // so the year was only ever visible for a moment. This
                      // sits with the actions, which stay. Where the pills
                      // stay too, it would only repeat them.
                      <span className="inline-flex min-h-10 items-center rounded-full border border-white/[0.14] bg-black/[0.34] px-4 text-sm font-semibold text-white/[0.82] backdrop-blur sm:min-h-16 sm:px-6 sm:text-base">
                        {heroFacts}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </motion.div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
      {typeof document === "undefined"
        ? heroIndicators
        : createPortal(heroIndicators, document.body)}
    </>
  );
}
