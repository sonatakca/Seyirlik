import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Search, SlidersHorizontal } from "lucide-react";
import { BackButton } from "../../components/BackButton";
import { ErrorMessage } from "../../components/ErrorMessage";
import { TitleHero } from "../../components/home/TitleHero";
import { MediaCard } from "../../components/MediaCard";
import { LibraryHeaderArt } from "../../components/LibraryHeaderArt";
import { MotionReveal } from "../../components/MotionReveal";
import { SeasonPicker } from "../../components/SeasonPicker";
import { SeriesLibraryDetails } from "../../components/SeriesLibraryDetails";
import {
  LibrarySkeleton,
  MovieLibrarySkeleton,
  ShowLibrarySkeleton,
} from "../../components/Skeletons";
import { WatchedIndicator } from "../../components/WatchedIndicator";
import { WatchedStatusButton } from "../../components/WatchedStatusButton";
import {
  glassControlBase,
  glassInputControl,
} from "../../components/ui/glassControlStyles";
import { useFlipLayout } from "../../hooks/useFlipLayout";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import { getItemLogoUrlById } from "../../lib/itemMetadataPreferences";
import {
  getBoxSetItems,
  getItem,
  getItemsForLibrary,
  getLogoImageUrl,
  getSeasonEpisodes,
  getSeriesSeasons,
  getItemChildren,
} from "../../lib/mediaApi";
import {
  loadCollectionPosterChildrenMap,
  type CollectionPosterChildrenMap,
} from "../../lib/collectionPoster";
import { sortCollectionItemsForWatching } from "../../lib/collectionUtils";
import { formatTemplate, getDisplayTitle } from "../../lib/format";
import { preloadMediaPlayback } from "../../lib/playbackPreload";
import { getRouteForItem, getShelfNavKey } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import { AnimatedText } from "../../components/AnimatedText";
import { AnimatedWidth } from "../../components/AnimatedWidth";
import { setPageTitle } from "../../lib/pageTitle";
import type { LibraryPageProps } from "../libraryPageTypes";
import { preloadPlayerPage } from "../PlayerPage";
import { useDevSkeletonMode } from "../../lib/devSkeletonMode";
import {
  compareNames,
  isWatchableScopeItem,
  isWholeWatchedScope,
  resolveLibraryCanonicalPath,
  withWatchedState,
  type LibrarySortMode,
} from "../library/libraryModel";
import { hasCuratedOrder, orderItemsByCuration } from "../../lib/curation";
import { useCuratedList } from "../../hooks/useCuratedList";

type LibraryFallbackTitleKey =
  | "common.series"
  | "format.season"
  | "library.library";

interface LibraryData {
  library?: MediaItem;
  fallbackTitleKey?: LibraryFallbackTitleKey;
  items: MediaItem[];
  selectableSeasons: MediaItem[];
  collectionPosterChildrenById: CollectionPosterChildrenMap;
}

function getSortNumber(item: MediaItem): number {
  if (item.Type === "Season") {
    return item.IndexNumber ?? item.ProductionYear ?? 9999;
  }

  if (item.Type === "Episode") {
    return item.IndexNumber ?? 9999;
  }

  return 9999;
}

function compareDates(leftDate?: string, rightDate?: string): number {
  const leftTime = Date.parse(leftDate ?? "9999-12-31");
  const rightTime = Date.parse(rightDate ?? "9999-12-31");
  return leftTime - rightTime;
}

function sortMediaItems(
  left: MediaItem,
  right: MediaItem,
  sortBy: LibrarySortMode,
): number {
  if (left.Type === "Season" && right.Type === "Season") {
    const seasonCompare = getSortNumber(left) - getSortNumber(right);
    return seasonCompare !== 0 ? seasonCompare : compareNames(left, right);
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    const seasonCompare =
      (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0);

    if (seasonCompare !== 0) {
      return seasonCompare;
    }

    const episodeCompare = getSortNumber(left) - getSortNumber(right);

    if (episodeCompare !== 0) {
      return episodeCompare;
    }

    const dateCompare = compareDates(left.PremiereDate, right.PremiereDate);
    return dateCompare !== 0 ? dateCompare : compareNames(left, right);
  }

  if (sortBy === "year") {
    return (right.ProductionYear ?? 0) - (left.ProductionYear ?? 0);
  }

  if (sortBy === "latest") {
    return (
      Date.parse(right.DateCreated ?? right.PremiereDate ?? "1970-01-01") -
      Date.parse(left.DateCreated ?? left.PremiereDate ?? "1970-01-01")
    );
  }

  return compareNames(left, right);
}

async function loadLibraryItems(
  id: string,
  mode: "library" | "series" | "season",
  library?: MediaItem,
  seriesIdFromRoute?: string,
): Promise<MediaItem[]> {
  if (mode === "library") {
    // The two id spaces are disjoint: a library is not an item. `library` is
    // set only when the route id resolved as an item, which is how a shared
    // route such as /movies/:id serves both the shelf and a single film. A
    // film resolves to itself and simply has no children.
    if (library) {
      const children = await getItemChildren(id);
      return library.Type === "BoxSet"
        ? sortCollectionItemsForWatching(children)
        : children;
    }

    return getItemsForLibrary(id);
  }

  if (mode === "series") {
    const seasons = await getSeriesSeasons(id);

    if (seasons.length > 0) {
      const seasonsWithEpisodeCounts = await Promise.all(
        seasons.map(async (season) => {
          const existingCount =
            typeof season.ChildCount === "number" && season.ChildCount > 0
              ? season.ChildCount
              : typeof season.RecursiveItemCount === "number" &&
                  season.RecursiveItemCount > 0
                ? season.RecursiveItemCount
                : null;

          if (existingCount !== null) {
            return season;
          }

          const episodes = await getSeasonEpisodes(id, season.Id).catch(
            () => [],
          );

          return {
            ...season,
            ChildCount: episodes.length,
            RecursiveItemCount: episodes.length,
          };
        }),
      );

      return seasonsWithEpisodeCounts;
    }

    return getItemsForLibrary(id);
  }

  if (mode === "season") {
    const resolvedSeriesId =
      seriesIdFromRoute ?? library?.SeriesId ?? library?.ParentId;

    if (resolvedSeriesId) {
      const episodes = await getSeasonEpisodes(resolvedSeriesId, id);

      if (episodes.length > 0) {
        return episodes;
      }
    }

    return getItemsForLibrary(id);
  }

  return getItemsForLibrary(id);
}

/** How long the page shows its hero before gliding down to the details. */
const DETAILS_ARRIVAL_BEAT_MS = 200;

export function DesktopLibraryPage({
  mode = "library",
  libraryId: libraryIdOverride,
  canonicalPath: canonicalPathOverride,
  libraryRouteKind,
}: LibraryPageProps) {
  const forceSkeletons = useDevSkeletonMode();
  const { libraryId, seriesId, seasonId } = useParams<{
    libraryId?: string;
    seriesId?: string;
    seasonId?: string;
  }>();

  const activeId = libraryIdOverride ?? libraryId ?? seriesId ?? seasonId;
  const canonicalPath = resolveLibraryCanonicalPath({
    activeId,
    canonicalPathOverride,
    libraryRouteKind,
    mode,
    seasonId,
    seriesId,
  });
  const { language, t } = useLanguage();
  const mediaFormatLabels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const [data, setData] = useState<LibraryData | null>(null);
  const [loadingItemType, setLoadingItemType] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [chosenSortBy, setSortBy] = useState<LibrarySortMode | null>(null);
  const [readyDetailsId, setReadyDetailsId] = useState<string | null>(null);
  const seriesDetailsRef = useRef<HTMLDivElement | null>(null);
  // Where the title hero takes the details' watched button.
  const [watchedSlot, setWatchedSlot] = useState<HTMLSpanElement | null>(null);
  const location = useLocation();

  /*
   * Arriving from the home hero's "Details": the page opens on the same hero
   * the viewer just left, so once its details are in it glides down to them,
   * as its own "Details" would. The request is spent on use, so a refresh or
   * a return to the page opens it at the top. It is cleared in the history
   * entry directly: a router navigation would count as a new arrival and
   * send the page back to the top mid-glide.
   */
  const wantsDetails = Boolean(
    (location.state as { scrollToDetails?: boolean } | null)?.scrollToDetails,
  );
  const spentArrivalRef = useRef<string | null>(null);
  const areDetailsReady = Boolean(activeId) && readyDetailsId === activeId;
  useEffect(() => {
    if (
      !wantsDetails ||
      !areDetailsReady ||
      spentArrivalRef.current === location.key
    )
      return undefined;
    const timer = window.setTimeout(() => {
      spentArrivalRef.current = location.key;
      const entry = window.history.state as { usr?: unknown } | null;
      window.history.replaceState({ ...entry, usr: null }, "");
      seriesDetailsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, DETAILS_ARRIVAL_BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [areDetailsReady, location.key, wantsDetails]);

  /*
   * Only a library shelf carries an ordering. The same routes serve a single
   * title — `/movies/:id` resolves to an item, not a library — and an item id
   * names no list, so it is not asked about.
   */
  const curatedLibraryId =
    mode === "library" && activeId && data && !data.library
      ? activeId
      : undefined;
  const curatedList = useCuratedList("library", curatedLibraryId);

  /*
   * Derived rather than stored. A hand-placed order is somebody's decision
   * about this shelf, so it is the default the moment one loads — but only
   * until the viewer picks a sort of their own, and never on a shelf that has
   * no ordering, where `custom` would select an option the dropdown does not
   * offer.
   */
  const preferredSortBy: LibrarySortMode =
    chosenSortBy ?? (hasCuratedOrder(curatedList) ? "custom" : "name");
  const effectiveSortBy: LibrarySortMode =
    preferredSortBy === "custom" && !hasCuratedOrder(curatedList)
      ? "name"
      : preferredSortBy;

  useEffect(() => {
    let isMounted = true;

    async function loadLibrary() {
      if (!activeId) {
        setError(t("library.missingId"));
        return;
      }

      setError(null);
      setData(null);
      setLoadingItemType(undefined);

      try {
        const libraryResult = await getItem(activeId).catch(() => undefined);
        if (isMounted) setLoadingItemType(libraryResult?.Type);
        const items = await loadLibraryItems(
          activeId,
          mode,
          libraryResult,
          seriesId,
        );
        const collectionPosterChildrenById =
          await loadCollectionPosterChildrenMap(items, getBoxSetItems);
        const firstEpisode = items.find((item) => item.Type === "Episode");
        const selectableSeriesId = firstEpisode
          ? (libraryResult?.SeriesId ??
            firstEpisode.SeriesId ??
            libraryResult?.ParentId)
          : undefined;
        const selectableSeasons = selectableSeriesId
          ? await getSeriesSeasons(selectableSeriesId).catch(() => [])
          : [];

        const fallbackLibrary =
          libraryResult ??
          (mode === "series"
            ? {
                Id: activeId,
                Name: items[0]?.SeriesName ?? "",
                Type: "Series",
              }
            : mode === "season"
              ? {
                  Id: activeId,
                  Name: items[0]?.SeasonName ?? "",
                  Type: "Season",
                  SeriesId: seriesId,
                }
              : undefined);
        const fallbackTitleKey: LibraryFallbackTitleKey | undefined =
          mode === "series"
            ? "common.series"
            : mode === "season"
              ? "format.season"
              : "library.library";

        if (isMounted) {
          setData({
            library: fallbackLibrary,
            fallbackTitleKey,
            items,
            selectableSeasons,
            collectionPosterChildrenById,
          });
        }
      } catch (libraryError) {
        if (isMounted) {
          setError(
            libraryError instanceof Error
              ? `${mode} id: ${activeId}\n${libraryError.message}`
              : `${mode} id: ${activeId}\n${t("library.couldNotLoadView")}`,
          );
        }
      }
    }

    void loadLibrary();

    return () => {
      isMounted = false;
    };
  }, [activeId, mode, seriesId]);

  const filteredItems = useMemo(() => {
    if (!data) {
      return [];
    }

    const normalizedSearch = searchTerm.trim().toLowerCase();
    const items = normalizedSearch
      ? data.items.filter((item) =>
          item.Name.toLowerCase().includes(normalizedSearch),
        )
      : data.items;

    if (data.library?.Type === "BoxSet") {
      return sortCollectionItemsForWatching(items);
    }

    // The hand-placed order is a saved sequence rather than a comparison rule,
    // so it replaces the comparator instead of feeding it.
    if (effectiveSortBy === "custom") {
      return orderItemsByCuration(items, curatedList);
    }

    return [...items].sort((left, right) =>
      sortMediaItems(left, right, effectiveSortBy),
    );
  }, [data, searchTerm, effectiveSortBy, curatedList]);

  // Sorting and filtering move cards rather than reshuffling them in place.
  const gridRef = useRef<HTMLDivElement | null>(null);
  useFlipLayout(gridRef, filteredItems.map((item) => item.Id).join("|"));

  const handleWatchedStatusReset = (
    resetItems: MediaItem[],
    options?: { action: "mark" | "remove"; scope: "show" },
  ) => {
    const resetItemsById = new Map(
      resetItems.map((resetItem) => [resetItem.Id, resetItem]),
    );
    const forceWatched = options ? options.action === "mark" : undefined;

    setData((currentData) =>
      currentData
        ? {
            ...currentData,
            library:
              forceWatched !== undefined && options?.scope === "show"
                ? currentData.library
                  ? withWatchedState(currentData.library, forceWatched)
                  : currentData.library
                : currentData.library,
            items: currentData.items.map(
              (item) =>
                resetItemsById.get(item.Id) ??
                (forceWatched !== undefined && options?.scope === "show"
                  ? withWatchedState(item, forceWatched)
                  : item),
            ),
          }
        : currentData,
    );
  };

  useEffect(() => {
    if (data) {
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const fallbackTitle =
      data.library?.Name ||
      (data.fallbackTitleKey
        ? t(data.fallbackTitleKey as TranslationKey)
        : t("library.library"));
    const title = data.library?.Name
      ? getDisplayTitle(data.library, mediaFormatLabels)
      : fallbackTitle;

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data, mediaFormatLabels, t]);

  useEffect(() => {
    const library = data?.library;

    if (!library) {
      return;
    }

    const shouldPreloadPlayback =
      library.Type === "Movie" ||
      library.Type === "Series" ||
      mode === "series";

    if (!shouldPreloadPlayback) {
      return;
    }

    let isMounted = true;

    void preloadMediaPlayback(library, {
      preloadPlayer: () => preloadPlayerPage(false),
    }).catch((preloadError) => {
      if (!isMounted) {
        return;
      }

      console.debug(
        "[Seyirlik Playback] Details playback preload skipped",
        preloadError,
      );
    });

    return () => {
      isMounted = false;
    };
  }, [data?.library?.Id, data?.library?.Type, mode]);

  const isAliasLibrary = [
    "/movies",
    "/shows",
    "/books",
    "/collections",
  ].includes(canonicalPathOverride ?? "");
  const loadingSkeleton = isAliasLibrary ? (
    <LibrarySkeleton />
  ) : libraryRouteKind === "show" ||
    mode === "series" ||
    mode === "season" ||
    loadingItemType === "Series" ||
    loadingItemType === "Season" ? (
    <ShowLibrarySkeleton />
  ) : libraryRouteKind === "movie" || loadingItemType === "Movie" ? (
    <MovieLibrarySkeleton />
  ) : (
    <LibrarySkeleton />
  );

  if (forceSkeletons) return loadingSkeleton;

  if (error) {
    return <ErrorMessage title={t("library.unavailable")} message={error} />;
  }

  if (!data) {
    return loadingSkeleton;
  }

  const shouldShowSeriesDetails =
    data.library?.Type === "Series" ||
    data.library?.Type === "Season" ||
    data.library?.Type === "Movie" ||
    mode === "series" ||
    mode === "season";

  if (shouldShowSeriesDetails && data.library) {
    const isInitialDetailsReady = readyDetailsId === activeId;
    const initialDetailsSkeleton =
      data.library.Type === "Movie" || libraryRouteKind === "movie" ? (
        <MovieLibrarySkeleton item={data.library} />
      ) : (
        <ShowLibrarySkeleton item={data.library} />
      );

    return (
      <>
        {!isInitialDetailsReady && initialDetailsSkeleton}
        <div
          aria-hidden={isInitialDetailsReady ? undefined : true}
          className={
            isInitialDetailsReady
              ? "contents"
              : "pointer-events-none fixed inset-0 invisible overflow-hidden"
          }
        >
          <div className="layout-no-offset flex min-w-0 flex-col">
            <div className="full-bleed relative flow-root">
              <TitleHero
                key={data.library.Id}
                item={data.library}
                backTo={data.library.Type === "Movie" ? "/movies" : "/shows"}
                onWatchedSlot={setWatchedSlot}
                isRevealed={isInitialDetailsReady}
                onShowDetails={() =>
                  seriesDetailsRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  })
                }
              />
            </div>

            <div
              ref={seriesDetailsRef}
              className="mx-auto w-full max-w-[1600px] scroll-mt-24 px-4 sm:px-6 lg:px-8"
            >
              <SeriesLibraryDetails
                initialItem={data.library}
                variant="desktop"
                watchedSlot={watchedSlot}
                watchedSlotLook="dock"
                canonicalPath={canonicalPath}
                onInitialReady={() => setReadyDetailsId(activeId ?? null)}
              />
            </div>
          </div>
        </div>
      </>
    );
  }

  const libraryTitle =
    data.library?.Name ||
    (data.fallbackTitleKey
      ? t(data.fallbackTitleKey as TranslationKey)
      : t("library.library"));

  const firstItemWithLogo = data.items.find(
    (libraryItem) =>
      Boolean(libraryItem.ImageTags?.Logo) ||
      Boolean(libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag),
  );
  const fallbackLibraryLogoUrl = data.library?.ImageTags?.Logo
    ? getLogoImageUrl(data.library.Id, data.library.ImageTags.Logo, 1100)
    : data.library?.ParentLogoItemId && data.library.ParentLogoImageTag
      ? getLogoImageUrl(
          data.library.ParentLogoItemId,
          data.library.ParentLogoImageTag,
          1100,
        )
      : firstItemWithLogo?.ParentLogoItemId &&
          firstItemWithLogo.ParentLogoImageTag
        ? getLogoImageUrl(
            firstItemWithLogo.ParentLogoItemId,
            firstItemWithLogo.ParentLogoImageTag,
            1100,
          )
        : firstItemWithLogo?.ImageTags?.Logo
          ? getLogoImageUrl(
              firstItemWithLogo.Id,
              firstItemWithLogo.ImageTags.Logo,
              1100,
            )
          : "";
  const libraryLogoUrl = getItemLogoUrlById(
    data.library?.Id ??
      firstItemWithLogo?.ParentLogoItemId ??
      firstItemWithLogo?.Id,
    language,
    fallbackLibraryLogoUrl,
  );
  const activeLibraryLogoUrl = libraryLogoUrl;
  const displayLibraryTitle = data.library?.Name
    ? getDisplayTitle(data.library, mediaFormatLabels)
    : libraryTitle;

  const shelfNavKey = getShelfNavKey(location.pathname);
  const libraryArtTitle = shelfNavKey ? t(shelfNavKey) : displayLibraryTitle;

  const visibleItemType = data.items.find(
    (libraryItem) => libraryItem.Type,
  )?.Type;

  const headerCountLabel =
    visibleItemType === "Season"
      ? `${data.items.length} Sezon`
      : visibleItemType === "Episode"
        ? `${data.items.length} Bölüm`
        : `${data.items.length} ${t("library.itemsAvailable")}`;
  const firstEpisodeItem = data.items.find(
    (libraryItem) => libraryItem.Type === "Episode",
  );

  const seasonHeaderLabel =
    visibleItemType === "Episode"
      ? typeof firstEpisodeItem?.ParentIndexNumber === "number" &&
        firstEpisodeItem.ParentIndexNumber > 0
        ? formatTemplate(t("media.seasonNumber"), {
            number: firstEpisodeItem.ParentIndexNumber,
          })
        : data.library?.Name ||
          firstEpisodeItem?.SeasonName ||
          t("format.season")
      : null;
  const currentSeasonId =
    data.library?.Type === "Season"
      ? data.library.Id
      : (firstEpisodeItem?.SeasonId ?? activeId);
  const seasonResetSeriesId =
    mode === "season"
      ? (seriesId ?? data.library?.SeriesId ?? firstEpisodeItem?.SeriesId)
      : undefined;
  const showResetSeriesId = mode === "series" ? activeId : undefined;
  const hasWatchedSeasonItems =
    mode === "season" && data.items.some(isItemCompleted);
  const hasWatchedShowItems =
    mode === "series" &&
    (Boolean(data.library && isItemCompleted(data.library)) ||
      data.items.some(isItemCompleted));
  const hasUnwatchedSeasonItems =
    mode === "season" &&
    data.items.some(
      (libraryItem) =>
        isWatchableScopeItem(libraryItem) && !isItemCompleted(libraryItem),
    );
  const hasUnwatchedShowItems =
    mode === "series" && !isWholeWatchedScope(data.library, data.items);
  const isLibraryScopeWatched =
    (mode === "series" || mode === "season") &&
    isWholeWatchedScope(data.library, data.items);
  const seasonPickerOptions = [...data.selectableSeasons]
    .sort((left, right) => sortMediaItems(left, right, "name"))
    .map((season) => ({
      id: season.Id,
      label:
        typeof season.IndexNumber === "number" && season.IndexNumber > 0
          ? formatTemplate(t("media.seasonNumber"), {
              number: season.IndexNumber,
            })
          : season.Name || t("format.season"),
    }));

  return (
    <div>
      <div className="relative mb-4 flex flex-col gap-3 sm:grid sm:min-h-20 sm:grid-cols-[auto_1fr_auto] sm:items-end sm:gap-4">
        {mode === "library" ? <LibraryHeaderArt items={data.items} /> : null}
        <div className="relative z-10 order-2 flex items-center justify-between gap-3 sm:order-none sm:block sm:justify-self-start sm:pb-1">
          <BackButton buttonClassName="min-h-9 px-3 text-xs sm:min-h-10 sm:px-4 sm:text-sm" />
          <p className="min-w-0 truncate text-right text-xs font-bold text-white/[0.62] sm:hidden">
            <AnimatedWidth value={headerCountLabel}>
              <AnimatedText value={headerCountLabel} />
            </AnimatedWidth>
          </p>
        </div>

        {mode === "library" ? (
          <div className="order-1 min-h-24 sm:order-none sm:min-h-28">
            <h1 className="sr-only">{libraryArtTitle}</h1>
          </div>
        ) : (
          <MotionReveal
            className="relative z-20 order-1 flex min-w-0 justify-center px-2 sm:order-none"
            direction="up"
            delay={0.02}
          >
            {activeLibraryLogoUrl && seasonHeaderLabel ? (
              <div className="flex min-h-[3.4rem] w-full min-w-0 items-center justify-center gap-2.5 sm:min-h-[5.5rem] sm:gap-4">
                <motion.img
                  src={activeLibraryLogoUrl}
                  alt={displayLibraryTitle}
                  draggable={false}
                  className="cinematic-logo-shadow z-30 h-auto max-h-10 max-w-[min(10rem,42vw)] transform-gpu object-contain will-change-transform sm:max-h-20 sm:max-w-[min(18rem,40vw)]"
                  initial={{
                    opacity: 0,
                    scale: 0.98,
                  }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                  }}
                  transition={{
                    opacity: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
                    scale: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
                  }}
                />

                <motion.div
                  aria-hidden="true"
                  className="z-10 h-10 w-px shrink-0 origin-center bg-gradient-to-b from-transparent via-white/24 to-transparent will-change-transform sm:h-14"
                  initial={{
                    opacity: 0,
                    scaleY: 0.55,
                  }}
                  animate={{
                    opacity: 1,
                    scaleY: 1,
                  }}
                  transition={{
                    duration: 0.78,
                    delay: 1.55,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                />

                <motion.div
                  className="relative z-20 transform-gpu will-change-[transform,opacity,filter]"
                  initial={{
                    opacity: 0,
                    scale: 0.975,
                    filter: "blur(6px)",
                  }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    filter: "blur(0px)",
                  }}
                  transition={{
                    duration: 0.95,
                    delay: 1.25,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  {seasonPickerOptions.length > 0 ? (
                    <SeasonPicker
                      activeSeasonId={currentSeasonId}
                      currentLabel={seasonHeaderLabel}
                      labelContent={
                        <AnimatedWidth value={seasonHeaderLabel}>
                          <AnimatedText value={seasonHeaderLabel} />
                        </AnimatedWidth>
                      }
                      options={seasonPickerOptions}
                      selectLabel={t("library.selectSeason")}
                    />
                  ) : (
                    <div
                      className={`${glassControlBase} relative max-w-[44vw] overflow-hidden px-3 py-2 sm:max-w-none sm:min-h-12 sm:px-5 sm:py-3`}
                    >
                      <div className="relative flex items-center">
                        <span className="truncate text-xl font-black leading-none text-white sm:text-4xl">
                          <AnimatedWidth value={seasonHeaderLabel}>
                            <AnimatedText value={seasonHeaderLabel} />
                          </AnimatedWidth>
                        </span>
                      </div>
                    </div>
                  )}
                </motion.div>
              </div>
            ) : activeLibraryLogoUrl ? (
              // The logo stands in for the title, so it carries the heading.
              <h1 className="flex min-w-0 justify-center">
                <img
                  src={activeLibraryLogoUrl}
                  alt={displayLibraryTitle}
                  draggable={false}
                  className="cinematic-logo-shadow h-auto max-h-12 max-w-[min(14rem,64vw)] object-contain sm:max-h-20 sm:max-w-[min(26rem,58vw)]"
                />
              </h1>
            ) : (
              <h1 className="text-center text-3xl font-black leading-none text-white sm:text-5xl">
                <AnimatedWidth value={displayLibraryTitle}>
                  <AnimatedText value={displayLibraryTitle} />
                </AnimatedWidth>
              </h1>
            )}
          </MotionReveal>
        )}

        <p className="relative z-10 hidden justify-self-end pb-2 text-right text-sm font-bold text-white/[0.62] sm:block">
          <AnimatedWidth value={headerCountLabel}>
            <AnimatedText value={headerCountLabel} />
          </AnimatedWidth>
        </p>
      </div>

      {isLibraryScopeWatched ? (
        <MotionReveal
          className="mb-5 flex justify-center"
          direction="up"
          delay={0.03}
        >
          <WatchedIndicator isWatched size="lg" />
        </MotionReveal>
      ) : null}

      <MotionReveal
        className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
        delay={0.04}
      >
        <label className={`relative flex-1 pl-11 ${glassInputControl}`}>
          <Search
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/[0.42]"
            size={19}
          />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
            aria-label={t("library.searchLabel")}
            className="w-full bg-transparent text-white outline-none placeholder:text-white/35"
          />
        </label>
        <label
          className={`${glassControlBase} min-h-12 gap-2 px-4 text-sm font-semibold`}
        >
          <SlidersHorizontal size={18} />
          <select
            value={effectiveSortBy}
            onChange={(event) =>
              setSortBy(event.target.value as LibrarySortMode)
            }
            aria-label={t("library.sortBy")}
            className="bg-transparent text-white outline-none"
          >
            {hasCuratedOrder(curatedList) ? (
              <option value="custom">{t("library.custom")}</option>
            ) : null}
            <option value="name">{t("library.name")}</option>
            <option value="latest">{t("library.latest")}</option>
            <option value="year">{t("library.year")}</option>
          </select>
        </label>
        {seasonResetSeriesId && currentSeasonId && hasWatchedSeasonItems ? (
          <WatchedStatusButton
            scope="season"
            action="remove"
            seriesId={seasonResetSeriesId}
            seasonId={currentSeasonId}
            label={t("details.removeWatchedStatusForSeason")}
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} min-h-12 gap-2 px-4 text-sm font-black`}
          />
        ) : null}
        {seasonResetSeriesId && currentSeasonId && hasUnwatchedSeasonItems ? (
          <WatchedStatusButton
            scope="season"
            action="mark"
            seriesId={seasonResetSeriesId}
            seasonId={currentSeasonId}
            label={t("details.markWatchedStatusForSeason")}
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} min-h-12 gap-2 px-4 text-sm font-black`}
          />
        ) : null}
        {showResetSeriesId && hasWatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="remove"
            seriesId={showResetSeriesId}
            label={t("details.removeWatchedStatusForShow")}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "remove",
                scope: "show",
              })
            }
            className={`${glassControlBase} min-h-12 gap-2 px-4 text-sm font-black`}
          />
        ) : null}
        {showResetSeriesId && hasUnwatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="mark"
            seriesId={showResetSeriesId}
            label={t("details.markWatchedStatusForShow")}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "mark",
                scope: "show",
              })
            }
            className={`${glassControlBase} min-h-12 gap-2 px-4 text-sm font-black`}
          />
        ) : null}
      </MotionReveal>

      {filteredItems.length > 0 ? (
        <div
          ref={gridRef}
          className="relative grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6"
        >
          {filteredItems.map((item, index) => (
            <MediaCard
              key={item.Id}
              item={item}
              to={getRouteForItem(item)}
              layout="grid"
              variant={item.Type === "Episode" ? "landscape" : "poster"}
              index={index}
              animateIn
              collectionItems={data.collectionPosterChildrenById[item.Id]}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
          <AnimatedWidth value={t("library.noMatches")}>
            <AnimatedText value={t("library.noMatches")} />
          </AnimatedWidth>
        </p>
      )}
    </div>
  );
}
