import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";
import type {
  PlaybackQueue,
  PlaybackQueueSeason,
} from "../../lib/playbackQueue";
import type { MediaItem } from "../../lib/types";
import { PlayerEpisodeRow } from "./PlayerEpisodeRow";
import {
  QueueItemButton,
  type PlayerQueueTranslate,
} from "./PlayerQueueItemButton";

/*
 * The list fades into the panel's edges rather than being cut by them, so a
 * row half out of view reads as "more this way" instead of as clipped.
 */
const EPISODE_LIST_FADE_GRADIENT =
  "linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 36px), transparent 100%)";
const EPISODE_LIST_FADE = {
  maskImage: EPISODE_LIST_FADE_GRADIENT,
  WebkitMaskImage: EPISODE_LIST_FADE_GRADIENT,
} as const;

interface PlayerQueuePanelProps {
  queue: PlaybackQueue;
  compact?: boolean;
  onPlayItem?: (item: MediaItem) => void;
}

/** The short form a season chip shows: its number, or its name for specials. */
function getSeasonChipLabel(
  season: PlaybackQueueSeason,
  t: PlayerQueueTranslate,
) {
  if (season.seasonNumber !== null && season.seasonNumber > 0) {
    return String(season.seasonNumber);
  }
  return season.name ?? t("player.seasonSelect");
}

function getSeasonLabel(season: PlaybackQueueSeason, t: PlayerQueueTranslate) {
  if (season.seasonNumber !== null) {
    return formatTemplate(t("media.seasonNumber"), {
      number: season.seasonNumber,
    });
  }

  return season.name ?? t("player.seasonSelect");
}

function getQueueTitle(queue: PlaybackQueue, t: PlayerQueueTranslate) {
  return queue.kind === "series"
    ? t("player.queueEpisodes")
    : t("player.queueCollection");
}

export function PlayerQueuePanel({
  queue,
  compact = false,
  onPlayItem,
}: PlayerQueuePanelProps) {
  const { t } = useLanguage();
  const seasons = queue.seasons ?? [];
  const defaultSeasonId = queue.currentSeasonId ?? seasons[0]?.id ?? "";
  const [selectedSeasonId, setSelectedSeasonId] = useState(defaultSeasonId);
  const [isCollectionScrollable, setIsCollectionScrollable] = useState(false);
  const [canScrollCollectionLeft, setCanScrollCollectionLeft] = useState(false);
  const [canScrollCollectionRight, setCanScrollCollectionRight] =
    useState(false);
  const collectionScrollRef = useRef<HTMLDivElement | null>(null);
  const episodeScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedSeason =
    seasons.find((season) => season.id === selectedSeasonId) ?? seasons[0];
  const visibleItems =
    queue.kind === "series" ? (selectedSeason?.episodes ?? []) : queue.items;
  const panelWidthClass = compact
    ? queue.kind === "collection"
      ? "sm:w-fit sm:max-w-md"
      : "sm:w-[23rem] sm:max-w-[calc(100vw-2rem)]"
    : queue.kind === "collection"
      ? "sm:w-fit sm:max-w-2xl"
      : "sm:w-[27rem] sm:max-w-[calc(100vw-2rem)]";

  useEffect(() => {
    setSelectedSeasonId(defaultSeasonId);
  }, [defaultSeasonId]);

  useLayoutEffect(() => {
    if (queue.kind !== "collection") {
      setIsCollectionScrollable(false);
      setCanScrollCollectionLeft(false);
      setCanScrollCollectionRight(false);
      return;
    }

    const scrollContainer = collectionScrollRef.current;

    if (!scrollContainer) {
      setIsCollectionScrollable(false);
      setCanScrollCollectionLeft(false);
      setCanScrollCollectionRight(false);
      return;
    }

    const updateScrollableState = () => {
      const maxScrollLeft = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const isScrollable = maxScrollLeft > 1;

      setIsCollectionScrollable(isScrollable);
      setCanScrollCollectionLeft(
        isScrollable && scrollContainer.scrollLeft > 1,
      );
      setCanScrollCollectionRight(
        isScrollable && scrollContainer.scrollLeft < maxScrollLeft - 1,
      );
    };

    updateScrollableState();

    scrollContainer.addEventListener("scroll", updateScrollableState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateScrollableState);

      return () => {
        scrollContainer.removeEventListener("scroll", updateScrollableState);
        window.removeEventListener("resize", updateScrollableState);
      };
    }

    const resizeObserver = new ResizeObserver(updateScrollableState);
    resizeObserver.observe(scrollContainer);

    Array.from(scrollContainer.children).forEach((child) => {
      resizeObserver.observe(child);
    });

    return () => {
      scrollContainer.removeEventListener("scroll", updateScrollableState);
      resizeObserver.disconnect();
    };
  }, [queue.kind, visibleItems.length]);

  useLayoutEffect(() => {
    const currentItemId = queue.currentItemId;

    if (!currentItemId) {
      return;
    }

    const scrollContainer =
      queue.kind === "collection"
        ? collectionScrollRef.current
        : episodeScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const currentElement = scrollContainer.querySelector<HTMLElement>(
      `[data-queue-item-id="${CSS.escape(currentItemId)}"]`,
    );

    if (!currentElement) {
      return;
    }

    const containerRect = scrollContainer.getBoundingClientRect();
    const elementRect = currentElement.getBoundingClientRect();

    if (queue.kind === "collection") {
      scrollContainer.scrollLeft += elementRect.left - containerRect.left;
      return;
    }

    // Part of the episode before stays in view, so the list reads as a
    // place in the season rather than starting at the current episode.
    scrollContainer.scrollTop +=
      elementRect.top -
      containerRect.top -
      Math.round(elementRect.height * 0.4);
  }, [queue.kind, queue.currentItemId, selectedSeasonId, visibleItems.length]);

  const scrollCollection = (direction: "left" | "right") => {
    const scrollContainer = collectionScrollRef.current;

    if (!scrollContainer) {
      return;
    }

    const firstItem = scrollContainer.querySelector<HTMLElement>(
      "[data-queue-item-id]",
    );
    const itemWidth = firstItem?.offsetWidth ?? 160;
    const gap = 12;
    const scrollAmount = Math.max(
      itemWidth + gap,
      scrollContainer.clientWidth * 0.72,
    );

    scrollContainer.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });

    window.setTimeout(() => {
      const maxScrollLeft = Math.max(
        0,
        scrollContainer.scrollWidth - scrollContainer.clientWidth,
      );
      const isScrollable = maxScrollLeft > 1;

      setIsCollectionScrollable(isScrollable);
      setCanScrollCollectionLeft(
        isScrollable && scrollContainer.scrollLeft > 1,
      );
      setCanScrollCollectionRight(
        isScrollable && scrollContainer.scrollLeft < maxScrollLeft - 1,
      );
    }, 220);
  };

  if (queue.kind === "series") {
    return (
      <div
        className={`fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-[70] flex max-h-[calc(100dvh-6rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[rgba(14,14,16,0.94)] text-white shadow-[0_28px_90px_rgba(0,0,0,0.75)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[5.25rem] sm:right-0 ${panelWidthClass}`}
      >
        <div className="shrink-0 px-4 pb-3 pt-4">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[0.68rem] font-black uppercase tracking-[0.2em] text-[var(--accent)]">
                {getQueueTitle(queue, t)}
              </p>
              {queue.title ? (
                <p className="mt-1 truncate text-lg font-black leading-tight text-white">
                  {queue.title}
                </p>
              ) : null}
            </div>
            <p className="shrink-0 pb-0.5 text-xs font-bold tabular-nums text-white/45">
              {formatTemplate(t("player.queueEpisodeCount"), {
                count: visibleItems.length,
              })}
            </p>
          </div>

          {seasons.length > 1 ? (
            <div className="mt-3 flex items-center gap-2">
              <span
                id="player-season-label"
                className="shrink-0 text-[0.68rem] font-black uppercase tracking-[0.16em] text-white/45"
              >
                {t("player.seasonSelect")}
              </span>
              <div
                role="tablist"
                aria-labelledby="player-season-label"
                className="player-queue-scroll -my-1 flex min-w-0 gap-1.5 overflow-x-auto py-1"
              >
                {seasons.map((season) => {
                  const isSelected = season.id === selectedSeason?.id;
                  const isPlaying = season.id === queue.currentSeasonId;
                  return (
                    <button
                      key={season.id}
                      type="button"
                      role="tab"
                      aria-selected={isSelected}
                      aria-label={getSeasonLabel(season, t)}
                      onClick={() => setSelectedSeasonId(season.id)}
                      className={`relative flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full px-2.5 text-sm font-black tabular-nums transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                        isSelected
                          ? "bg-white text-zinc-950"
                          : "bg-white/[0.07] text-white/70 hover:bg-white/[0.13] hover:text-white"
                      }`}
                    >
                      {getSeasonChipLabel(season, t)}
                      {isPlaying && !isSelected ? (
                        <span
                          aria-hidden="true"
                          className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[var(--accent)]"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : selectedSeason ? (
            <p className="mt-2 text-xs font-bold text-white/55">
              {getSeasonLabel(selectedSeason, t)}
            </p>
          ) : null}
        </div>

        <div
          ref={episodeScrollRef}
          className="player-queue-scroll min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-white/[0.07] px-2 pb-7 pt-3 sm:max-h-[min(30rem,calc(100dvh-16rem))]"
          style={EPISODE_LIST_FADE}
        >
          {visibleItems.map((item) => (
            <div key={item.Id} data-queue-item-id={item.Id}>
              <PlayerEpisodeRow
                item={item}
                isCurrent={item.Id === queue.currentItemId}
                t={t}
                onPlayItem={onPlayItem}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-[70] overflow-visible rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.96)] p-4 pr-2 text-white shadow-[0_24px_90px_rgba(0,0,0,0.72)] backdrop-blur-2xl sm:absolute sm:inset-x-auto sm:bottom-[5.25rem] sm:right-0 ${panelWidthClass}`}
    >
      {isCollectionScrollable ? (
        <>
          <button
            type="button"
            aria-label="Scroll queue left"
            onClick={() => scrollCollection("left")}
            disabled={!canScrollCollectionLeft}
            className="absolute -left-11 top-1/2 z-[85] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-gray-500 text-white shadow-player-controls transition hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-white/70 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-gray-700 disabled:text-white/35 disabled:shadow-none disabled:hover:bg-gray-700"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>

          <button
            type="button"
            aria-label="Scroll queue right"
            onClick={() => scrollCollection("right")}
            disabled={!canScrollCollectionRight}
            className="absolute -right-11 top-1/2 z-[85] flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-gray-500 text-white shadow-player-controls transition hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-white/70 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-gray-700 disabled:text-white/35 disabled:shadow-none disabled:hover:bg-gray-700"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      ) : null}
      <p className="text-xs font-black uppercase tracking-[0.18em] text-[var(--accent)]">
        {getQueueTitle(queue, t)}
      </p>

      <div className="mt-3">
        <div
          ref={collectionScrollRef}
          className={`media-scroll flex w-max max-w-full gap-3 overflow-y-hidden pb-2 pt-1 ${
            isCollectionScrollable ? "overflow-x-auto" : "overflow-x-hidden"
          }`}
        >
          {visibleItems.map((item) => (
            <div
              key={item.Id}
              data-queue-item-id={item.Id}
              className="shrink-0"
            >
              <QueueItemButton
                item={item}
                isCurrent={item.Id === queue.currentItemId}
                variant="collection"
                t={t}
                onPlayItem={onPlayItem}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
