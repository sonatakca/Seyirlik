import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "framer-motion";
import { Pause, Play, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import {
  getBackdropImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../lib/mediaApi";
import { getEpisodeDisplayMetadata } from "../lib/episodeMetadataPreferences";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
} from "../lib/itemMetadataPreferences";
import { getRouteForItem } from "../lib/routes";
import type { MediaItem } from "../lib/types";
import { useLanguage } from "../i18n/LanguageContext";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { TimedCarouselIndicators } from "./TimedCarouselIndicators";

interface TimedMediaGalleryProps {
  title: string;
  items: MediaItem[];
  durationMs?: number;
  maxItems?: number;
}

function getBackdrop(item: MediaItem): string {
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 1900);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      1900,
    );
  }

  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 1200);
  }

  return "";
}

function getPoster(item: MediaItem): string {
  return item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 900)
    : "";
}

function canPlayItem(item: MediaItem): boolean {
  return (
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video"
  );
}

function getGalleryItems(items: MediaItem[], maxItems: number): MediaItem[] {
  const seenIds = new Set<string>();

  return items
    .filter((item) => {
      if (seenIds.has(item.Id)) {
        return false;
      }

      seenIds.add(item.Id);
      return Boolean(getBackdrop(item) || item.ImageTags?.Primary);
    })
    .slice(0, maxItems);
}

export function TimedMediaGallery({
  title,
  items,
  durationMs = 7000,
  maxItems = 7,
}: TimedMediaGalleryProps) {
  const { language, t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const galleryItems = useMemo(
    () => getGalleryItems(items, maxItems),
    [items, maxItems],
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const [_previousIndex, setPreviousIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [isPlaying, setIsPlaying] = useState(true);
  const [hasFinished, setHasFinished] = useState(false);
  const [revealKey, setRevealKey] = useState(0);
  const [indicatorResetKey, setIndicatorResetKey] = useState(0);
  const timerRef = useRef<number | null>(null);

  const activeItem = galleryItems[activeIndex];
  const activeEpisodeMetadata =
    activeItem?.Type === "Episode"
      ? getEpisodeDisplayMetadata(activeItem, language)
      : null;
  const activeItemMetadata =
    activeItem && activeItem.Type !== "Episode"
      ? getItemDisplayMetadata(activeItem, language)
      : null;
  const activeImageUrl =
    activeEpisodeMetadata?.thumbnailUrl ??
    (activeItem ? getBackdrop(activeItem) : "");
  const activePosterUrl =
    activeEpisodeMetadata?.thumbnailUrl ??
    (activeItem ? getPoster(activeItem) : "");
  const activeFallbackLogoUrl = activeItem?.ImageTags?.Logo
    ? getLogoImageUrl(activeItem.Id, activeItem.ImageTags.Logo, 950)
    : "";
  const activeLogoUrl = activeItem
    ? getItemLogoUrl(activeItem, language, activeFallbackLogoUrl)
    : "";
  const activeTitle = activeItem
    ? (activeEpisodeMetadata?.title ??
      activeItemMetadata?.title ??
      getDisplayTitle(activeItem))
    : "";
  const activeSubtitle = activeItem
    ? getItemSubtitle(activeItem, undefined, activeEpisodeMetadata?.title)
    : null;
  const activeOverview =
    activeEpisodeMetadata?.overview ??
    activeItemMetadata?.overview ??
    activeItem?.Overview ??
    null;
  const activeHref = activeItem ? getRouteForItem(activeItem) : "#";
  const canPlay = activeItem ? canPlayItem(activeItem) : false;

  const softTransition: Transition = shouldReduceMotion
    ? { duration: 0 }
    : { duration: 0.82, ease: [0.16, 1, 0.3, 1] };

  useEffect(() => {
    setActiveIndex(0);
    setPreviousIndex(0);
    setDirection(1);
    setIsPlaying(true);
    setHasFinished(false);
    setRevealKey((current) => current + 1);
    setIndicatorResetKey((current) => current + 1);
  }, [galleryItems.length]);

  useEffect(() => {
    if (
      !isPlaying ||
      hasFinished ||
      galleryItems.length <= 1 ||
      shouldReduceMotion
    ) {
      return undefined;
    }

    timerRef.current = window.setTimeout(() => {
      setActiveIndex((currentIndex) => {
        const nextIndex = currentIndex + 1;

        if (nextIndex >= galleryItems.length) {
          setHasFinished(true);
          setIsPlaying(false);
          return currentIndex;
        }

        setPreviousIndex(currentIndex);
        setDirection(1);
        return nextIndex;
      });
    }, durationMs);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, [
    activeIndex,
    durationMs,
    galleryItems.length,
    hasFinished,
    indicatorResetKey,
    isPlaying,
    shouldReduceMotion,
  ]);

  if (galleryItems.length === 0 || !activeItem) {
    return null;
  }

  const selectIndex = (index: number) => {
    setIndicatorResetKey((current) => current + 1);

    if (index === activeIndex) {
      setHasFinished(false);
      setIsPlaying(true);
      return;
    }

    setPreviousIndex(activeIndex);
    setDirection(index > activeIndex ? 1 : -1);
    setActiveIndex(index);
    setHasFinished(false);
    setIsPlaying(true);
  };

  const handlePlayPause = () => {
    if (hasFinished) {
      setPreviousIndex(activeIndex);
      setDirection(1);
      setActiveIndex(0);
      setHasFinished(false);
      setIsPlaying(true);
      setRevealKey((current) => current + 1);
      setIndicatorResetKey((current) => current + 1);
      return;
    }

    setIsPlaying((current) => !current);
  };

  const controlLabel = hasFinished
    ? t("hero.replayHighlightGallery")
    : isPlaying
      ? t("hero.pauseHighlightGallery")
      : t("hero.playHighlightGallery");

  return (
    <>
      <style>{`
        .apple-gallery {
          --apple-gallery-card-radius: clamp(1.6rem, 3vw, 2.4rem);
          --apple-gallery-control-height: 2.65rem;
          position: relative;
          margin-inline: calc(var(--page-x-offset, 0px) * -1);
          padding: clamp(2.4rem, 5vw, 4.8rem) 0 clamp(4.2rem, 8vw, 7rem);
          isolation: isolate;
        }

        .apple-gallery__inner {
          width: min(100%, 1480px);
          margin: 0 auto;
          padding: 0 clamp(1rem, 3vw, 2rem);
        }

        .apple-gallery__heading {
          margin: 0 auto clamp(1.2rem, 2.5vw, 2rem);
          width: min(100%, 1280px);
          display: flex;
          align-items: end;
          justify-content: space-between;
          gap: 1.2rem;
        }

        .apple-gallery__eyebrow {
          margin: 0 0 0.35rem;
          color: color-mix(in srgb, var(--accent) 82%, white 18%);
          font-size: 0.78rem;
          font-weight: 950;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }

        .apple-gallery__title {
          margin: 0;
          color: white;
          font-size: clamp(1.35rem, 2.4vw, 2.15rem);
          font-weight: 950;
          letter-spacing: -0.045em;
          line-height: 1.02;
        }

        .apple-gallery__stage-wrap {
          position: relative;
          margin: 0 auto;
          width: min(100%, 1280px);
        }

        .apple-gallery__white-reveal {
          pointer-events: none;
          position: absolute;
          inset: -12%;
          z-index: 30;
          border-radius: calc(var(--apple-gallery-card-radius) + 2rem);
          background:
            radial-gradient(circle at 50% 44%, rgba(255, 255, 255, 1), rgba(255, 255, 255, 0.82) 38%, rgba(255, 255, 255, 0) 72%);
          transform-origin: center;
        }

        .apple-gallery__stage {
          position: relative;
          min-height: clamp(27rem, 58vw, 43rem);
          overflow: hidden;
          border-radius: var(--apple-gallery-card-radius);
          background: #f5f5f7;
          box-shadow:
            0 42px 150px rgba(0, 0, 0, 0.48),
            0 10px 42px rgba(0, 0, 0, 0.32),
            inset 0 0 0 1px rgba(255, 255, 255, 0.18);
          transform: translateZ(0);
        }

        .apple-gallery__stage-glow {
          pointer-events: none;
          position: absolute;
          inset: -30%;
          z-index: -1;
          background:
            radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 38%),
            radial-gradient(circle at 70% 50%, rgba(255, 255, 255, 0.08), transparent 42%);
          filter: blur(42px);
          opacity: 0.75;
        }

        .apple-gallery__slide {
          position: absolute;
          inset: 0;
          overflow: hidden;
          border-radius: inherit;
          background: #111;
        }

        .apple-gallery__image,
        .apple-gallery__poster {
          position: absolute;
          inset: 0;
          height: 100%;
          width: 100%;
          object-fit: cover;
          transform: translateZ(0);
          user-select: none;
          -webkit-user-drag: none;
        }

        .apple-gallery__poster {
          left: auto;
          right: clamp(1.2rem, 4vw, 3.8rem);
          top: 50%;
          width: min(25vw, 21rem);
          height: auto;
          aspect-ratio: 2 / 3;
          border-radius: clamp(1rem, 2vw, 1.55rem);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 0 30px 110px rgba(0, 0, 0, 0.58);
          transform: translateY(-50%);
          display: none;
        }

        .apple-gallery__fallback {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          background:
            radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--accent) 28%, transparent), transparent 44%),
            linear-gradient(145deg, #27272a, #050506);
          color: white;
          text-align: center;
          font-size: clamp(2rem, 5vw, 5rem);
          font-weight: 950;
          letter-spacing: -0.06em;
        }

        .apple-gallery__shade {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(90deg, rgba(0, 0, 0, 0.88), rgba(0, 0, 0, 0.5) 39%, rgba(0, 0, 0, 0.1) 78%),
            linear-gradient(0deg, rgba(0, 0, 0, 0.74), rgba(0, 0, 0, 0.04) 52%, rgba(0, 0, 0, 0.22));
        }

        .apple-gallery__content {
          position: absolute;
          inset: auto auto clamp(1.6rem, 4vw, 3.2rem) clamp(1.4rem, 4vw, 3.5rem);
          z-index: 5;
          width: min(42rem, calc(100% - 2.8rem));
        }

        .apple-gallery__logo {
          max-width: min(35rem, 82vw);
          max-height: clamp(5rem, 13vw, 10rem);
          object-fit: contain;
          object-position: left center;
          filter: drop-shadow(0 20px 44px rgba(0, 0, 0, 0.82));
          user-select: none;
          -webkit-user-drag: none;
        }

        .apple-gallery__item-title {
          margin: 0;
          color: white;
          font-size: clamp(2.4rem, 6vw, 5.8rem);
          font-weight: 950;
          letter-spacing: -0.07em;
          line-height: 0.92;
          text-shadow: 0 18px 48px rgba(0, 0, 0, 0.75);
        }

        .apple-gallery__subtitle {
          margin: 1rem 0 0;
          color: rgba(255, 255, 255, 0.78);
          font-size: clamp(0.95rem, 1.6vw, 1.24rem);
          font-weight: 850;
          letter-spacing: -0.02em;
        }

        .apple-gallery__overview {
          margin: 1.05rem 0 0;
          max-width: 42rem;
          color: rgba(255, 255, 255, 0.72);
          font-size: clamp(0.94rem, 1.45vw, 1.12rem);
          font-weight: 550;
          line-height: 1.65;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .apple-gallery__actions {
          margin-top: clamp(1.3rem, 2.4vw, 1.8rem);
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
        }

        .apple-gallery__action {
          display: inline-flex;
          min-height: 2.9rem;
          align-items: center;
          justify-content: center;
          gap: 0.55rem;
          border-radius: 999px;
          padding: 0 1.2rem;
          font-size: 0.95rem;
          font-weight: 950;
          text-decoration: none;
          transition:
            transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
            background-color 240ms cubic-bezier(0.16, 1, 0.3, 1),
            color 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .apple-gallery__action:hover {
          transform: translateY(-1px) scale(1.025);
        }

        .apple-gallery__action:active {
          transform: scale(0.97);
        }

        .apple-gallery__action:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.72);
        }

        .apple-gallery__action--primary {
          background: white;
          color: #111;
        }

        .apple-gallery__action--secondary {
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.12);
          color: white;
          backdrop-filter: blur(24px);
        }

        .apple-gallery__controls {
          position: absolute;
          left: 50%;
          bottom: calc(var(--apple-gallery-control-height) * -0.5);
          z-index: 35;
          display: flex;
          align-items: center;
          gap: 0.72rem;
          transform: translateX(-50%);
        }

        .apple-gallery__round-control {
          position: relative;
          display: inline-flex;
          height: var(--apple-gallery-control-height);
          width: var(--apple-gallery-control-height);
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 999px;
          color: rgba(255, 255, 255, 0.86);
          box-shadow:
            0 20px 55px rgba(0, 0, 0, 0.34),
            inset 0 1px 0 rgba(255, 255, 255, 0.16);
          transition:
            transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
            color 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        .apple-gallery__round-control:hover {
          transform: translateY(-1px) scale(1.05);
          color: white;
        }

        .apple-gallery__round-control:active {
          transform: scale(0.96);
        }

        .apple-gallery__round-control:focus-visible {
          outline: none;
          box-shadow:
            0 0 0 2px rgba(255, 255, 255, 0.72),
            0 20px 55px rgba(0, 0, 0, 0.34);
        }

        .apple-gallery__glass {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.08)),
            rgba(28, 28, 30, 0.62);
          backdrop-filter: blur(24px) saturate(1.4);
        }

        @media (min-width: 1024px) {
          .apple-gallery__poster {
            display: block;
          }

          .apple-gallery__content {
            width: min(45rem, 58%);
          }
        }

        @media (max-width: 640px) {
          .apple-gallery {
            padding-top: 2.2rem;
          }

          .apple-gallery__heading {
            align-items: start;
            flex-direction: column;
          }

          .apple-gallery__stage {
            min-height: 34rem;
            border-radius: 1.55rem;
          }

          .apple-gallery__content {
            inset: auto 1.1rem 1.35rem;
            width: auto;
          }

          .apple-gallery__controls {
            width: calc(100% - 2rem);
            justify-content: center;
          }

          .apple-gallery__overview {
            -webkit-line-clamp: 4;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .apple-gallery *,
          .apple-gallery *::before,
          .apple-gallery *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>

      <section className="apple-gallery" aria-label={title}>
        <div className="apple-gallery__inner">
          <motion.div
            className="apple-gallery__heading"
            initial={shouldReduceMotion ? false : { opacity: 0, y: 18 }}
            whileInView={shouldReduceMotion ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <div>
              <p className="apple-gallery__eyebrow">{t("hero.highlights")}</p>
              <h2 className="apple-gallery__title">
                <AnimatedWidth value={title}>
                  <AnimatedText value={title} />
                </AnimatedWidth>
              </h2>
            </div>
          </motion.div>

          <div className="apple-gallery__stage-wrap">
            <div className="apple-gallery__stage-glow" />

            <AnimatePresence mode="wait">
              <motion.div
                key={`white-reveal-${revealKey}`}
                className="apple-gallery__white-reveal"
                initial={
                  shouldReduceMotion
                    ? { opacity: 0 }
                    : { opacity: 1, scale: 1.04, filter: "blur(0px)" }
                }
                animate={
                  shouldReduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, scale: 1.22, filter: "blur(18px)" }
                }
                exit={{ opacity: 0 }}
                transition={{
                  duration: shouldReduceMotion ? 0 : 1.15,
                  ease: [0.16, 1, 0.3, 1],
                }}
              />
            </AnimatePresence>

            <motion.div
              className="apple-gallery__stage"
              initial={
                shouldReduceMotion
                  ? false
                  : { opacity: 0, y: 34, scale: 0.955, filter: "blur(18px)" }
              }
              whileInView={
                shouldReduceMotion
                  ? undefined
                  : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
              }
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 1.05,
                delay: 0.12,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              <AnimatePresence custom={direction} initial={false}>
                <motion.div
                  key={activeItem.Id}
                  custom={direction}
                  className="apple-gallery__slide"
                  initial={
                    shouldReduceMotion
                      ? false
                      : {
                          x: direction === 1 ? "9%" : "-9%",
                          opacity: 0,
                          scale: 0.985,
                          filter: "blur(14px)",
                        }
                  }
                  animate={
                    shouldReduceMotion
                      ? undefined
                      : {
                          x: "0%",
                          opacity: 1,
                          scale: 1,
                          filter: "blur(0px)",
                        }
                  }
                  exit={
                    shouldReduceMotion
                      ? undefined
                      : {
                          x: direction === 1 ? "-7%" : "7%",
                          opacity: 0,
                          scale: 1.015,
                          filter: "blur(12px)",
                        }
                  }
                  transition={softTransition}
                >
                  {activeImageUrl ? (
                    <motion.img
                      src={activeImageUrl}
                      alt=""
                      className="apple-gallery__image"
                      initial={shouldReduceMotion ? false : { scale: 1.075 }}
                      animate={
                        shouldReduceMotion ? undefined : { scale: 1.015 }
                      }
                      transition={{
                        duration: shouldReduceMotion
                          ? 0
                          : durationMs / 1000 + 0.9,
                        ease: "linear",
                      }}
                    />
                  ) : (
                    <div className="apple-gallery__fallback">{activeTitle}</div>
                  )}

                  {activePosterUrl && activeImageUrl === activePosterUrl ? (
                    <motion.img
                      src={activePosterUrl}
                      alt=""
                      className="apple-gallery__poster"
                      initial={
                        shouldReduceMotion
                          ? false
                          : { opacity: 0, y: "-48%", scale: 0.96 }
                      }
                      animate={
                        shouldReduceMotion
                          ? undefined
                          : { opacity: 1, y: "-50%", scale: 1 }
                      }
                      transition={{
                        duration: 0.72,
                        delay: 0.24,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                    />
                  ) : null}

                  <div className="apple-gallery__shade" />
                </motion.div>
              </AnimatePresence>

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={`content-${activeItem.Id}`}
                  className="apple-gallery__content"
                  initial={
                    shouldReduceMotion
                      ? false
                      : {
                          opacity: 0,
                          y: 22,
                          scale: 0.985,
                          filter: "blur(10px)",
                        }
                  }
                  animate={
                    shouldReduceMotion
                      ? undefined
                      : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
                  }
                  exit={
                    shouldReduceMotion
                      ? undefined
                      : {
                          opacity: 0,
                          y: -16,
                          scale: 0.992,
                          filter: "blur(8px)",
                        }
                  }
                  transition={{
                    duration: 0.62,
                    delay: 0.12,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  {activeLogoUrl ? (
                    <img
                      src={activeLogoUrl}
                      alt={activeTitle}
                      className="apple-gallery__logo"
                      draggable={false}
                    />
                  ) : (
                    <h3 className="apple-gallery__item-title">{activeTitle}</h3>
                  )}

                  {activeSubtitle ? (
                    <p className="apple-gallery__subtitle">{activeSubtitle}</p>
                  ) : null}

                  {activeOverview ? (
                    <p className="apple-gallery__overview">{activeOverview}</p>
                  ) : null}

                  <div className="apple-gallery__actions">
                    {canPlay ? (
                      <Link
                        to={`/watch/${activeItem.Id}`}
                        className="apple-gallery__action apple-gallery__action--primary"
                      >
                        <Play size={18} fill="currentColor" />
                        {t("common.play")}
                      </Link>
                    ) : null}

                    <Link
                      to={activeHref}
                      className="apple-gallery__action apple-gallery__action--secondary"
                    >
                      {t("common.details")}
                    </Link>
                  </div>
                </motion.div>
              </AnimatePresence>
            </motion.div>

            <motion.div
              className="apple-gallery__controls"
              initial={
                shouldReduceMotion
                  ? false
                  : { opacity: 0, y: 18, scale: 0.94, filter: "blur(10px)" }
              }
              whileInView={
                shouldReduceMotion
                  ? undefined
                  : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
              }
              viewport={{ once: true, margin: "-80px" }}
              transition={{
                duration: 0.68,
                delay: 0.72,
                ease: [0.16, 1, 0.3, 1],
              }}
            >
              <button
                type="button"
                onClick={handlePlayPause}
                aria-label={controlLabel}
                className="apple-gallery__round-control"
              >
                <span className="apple-gallery__glass" />
                <span className="relative z-10">
                  {hasFinished ? (
                    <RotateCcw size={18} />
                  ) : isPlaying ? (
                    <Pause size={18} fill="currentColor" />
                  ) : (
                    <Play size={18} fill="currentColor" />
                  )}
                </span>
              </button>

              <TimedCarouselIndicators
                count={galleryItems.length}
                activeIndex={activeIndex}
                durationMs={durationMs}
                onSelect={selectIndex}
                isPaused={!isPlaying || hasFinished}
                progressResetKey={indicatorResetKey}
                ariaLabel={`${title} carousel navigation`}
                className="min-h-[var(--apple-gallery-control-height)]"
              />
            </motion.div>
          </div>
        </div>
      </section>
    </>
  );
}
