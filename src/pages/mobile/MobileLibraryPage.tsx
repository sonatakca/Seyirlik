import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { move, settle } from "../../lib/compositorMotion";
import { Search, SlidersHorizontal } from "lucide-react";
import { useLocation, useParams } from "react-router-dom";
import {
  LibraryBarcodePlaceholder,
  LibraryHeaderArt,
} from "../../components/LibraryHeaderArt";
import { BackButton } from "../../components/BackButton";
import { ErrorMessage } from "../../components/ErrorMessage";
import { useIsPhoneView } from "../../hooks/useIsPhoneView";
import { TitleHero } from "../../components/home/TitleHero";
import { useHeroCentreDock } from "../../components/home/heroCentreDock";
import { PhoneTitleHero } from "../../components/mobile/PhoneTitleHero";
import { HeroBackButton } from "../../components/mobile/HeroBackButton";
import { MobileMediaCard } from "../../components/mobile/MobileMediaCard";
import { SeriesLibraryDetails } from "../../components/SeriesLibraryDetails";
import { WatchedIndicator } from "../../components/WatchedIndicator";
import { WatchedStatusButton } from "../../components/WatchedStatusButton";
import {
  glassControlBase,
  glassInputControl,
} from "../../components/ui/glassControlStyles";
import { useFlipLayout } from "../../hooks/useFlipLayout";
import { useLanguage } from "../../i18n/LanguageContext";

import { getDisplayTitle } from "../../lib/format";
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
import { setPageTitle } from "../../lib/pageTitle";
import { preloadMediaPlayback } from "../../lib/playbackPreload";
import { getRouteForItem, getShelfNavKey } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import type { LibraryPageProps } from "../libraryPageTypes";
import { preloadPlayerPage } from "../PlayerPage";
import { useDevSkeletonMode } from "../../lib/devSkeletonMode";
import {
  MovieLibrarySkeleton,
  ShowLibrarySkeleton,
} from "../../components/Skeletons";
import {
  compareNames,
  countLabel,
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
  return item.IndexNumber ?? item.ProductionYear ?? 9999;
}

function compareDates(leftDate?: string, rightDate?: string): number {
  return (
    Date.parse(leftDate ?? "9999-12-31") - Date.parse(rightDate ?? "9999-12-31")
  );
}

function sortItems(
  left: MediaItem,
  right: MediaItem,
  sortBy: LibrarySortMode,
): number {
  if (left.Type === "Season" && right.Type === "Season") {
    return (
      getSortNumber(left) - getSortNumber(right) || compareNames(left, right)
    );
  }

  if (left.Type === "Episode" && right.Type === "Episode") {
    return (
      (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0) ||
      getSortNumber(left) - getSortNumber(right) ||
      compareDates(left.PremiereDate, right.PremiereDate) ||
      compareNames(left, right)
    );
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
  seriesId?: string,
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

    if (seasons.length === 0) {
      return getItemsForLibrary(id);
    }

    return Promise.all(
      seasons.map(async (season) => {
        const hasEpisodeCount =
          (season.ChildCount ?? 0) > 0 || (season.RecursiveItemCount ?? 0) > 0;

        if (hasEpisodeCount) {
          return season;
        }

        const episodes = await getSeasonEpisodes(id, season.Id).catch(() => []);

        return {
          ...season,
          ChildCount: episodes.length,
          RecursiveItemCount: episodes.length,
        };
      }),
    );
  }

  const resolvedSeriesId = seriesId ?? library?.SeriesId ?? library?.ParentId;

  if (resolvedSeriesId) {
    const episodes = await getSeasonEpisodes(resolvedSeriesId, id);

    if (episodes.length > 0) {
      return episodes;
    }
  }

  return getItemsForLibrary(id);
}

function MobileLibraryLoading() {
  // The page's header, piece for piece, so nothing moves when it arrives.
  return (
    <div className="pb-6">
      <section className="full-bleed relative -mt-1 min-h-[7rem] px-4 pb-12 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="shimmer ml-1 mt-1 h-9 w-[5.375rem] rounded-full" />
          <div className="shimmer h-4 w-24 rounded-full" />
        </div>
      </section>
      <div className="relative -mt-11 mb-5 min-h-[5.5rem] px-4">
        <LibraryBarcodePlaceholder compact />
      </div>
      <div className="mb-5 flex gap-2">
        <div className="shimmer h-12 min-w-0 flex-1 rounded-full" />
        <div className="shimmer h-12 w-[7.4rem] shrink-0 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 px-[clamp(0.5rem,4vw,1.75rem)] min-[600px]:grid-cols-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="shimmer aspect-[2/3] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function MobileLibraryPage({
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
  const labels = useMemo(
    () => ({
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    [t],
  );
  const [data, setData] = useState<LibraryData | null>(null);
  const isPhone = useIsPhoneView();
  const renderCentreDock = useHeroCentreDock();
  const [loadingItemType, setLoadingItemType] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [chosenSortBy, setSortBy] = useState<LibrarySortMode | null>(null);
  const location = useLocation();
  const [readyDetailsId, setReadyDetailsId] = useState<string | null>(null);

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
        const library = await getItem(activeId).catch(() => undefined);
        if (isMounted) setLoadingItemType(library?.Type);
        const items = await loadLibraryItems(activeId, mode, library, seriesId);
        const collectionPosterChildrenById =
          await loadCollectionPosterChildrenMap(items, getBoxSetItems);
        const firstEpisode = items.find((item) => item.Type === "Episode");
        const selectableSeriesId = firstEpisode
          ? (library?.SeriesId ?? firstEpisode.SeriesId ?? library?.ParentId)
          : undefined;
        const selectableSeasons = selectableSeriesId
          ? await getSeriesSeasons(selectableSeriesId).catch(() => [])
          : [];
        const fallbackLibrary =
          library ??
          (mode === "series"
            ? { Id: activeId, Name: items[0]?.SeriesName ?? "", Type: "Series" }
            : mode === "season"
              ? {
                  Id: activeId,
                  Name: items[0]?.SeasonName ?? "",
                  Type: "Season",
                  SeriesId: seriesId,
                }
              : undefined);
        const fallbackTitleKey: LibraryFallbackTitleKey =
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
          const message =
            libraryError instanceof Error
              ? libraryError.message
              : t("library.couldNotLoadView");
          setError(`${mode} id: ${activeId}\n${message}`);
        }
      }
    }

    void loadLibrary();

    return () => {
      isMounted = false;
    };
  }, [activeId, mode, seriesId, t]);

  const filteredItems = useMemo(() => {
    if (!data) {
      return [];
    }

    const query = searchTerm.trim().toLowerCase();
    const items = query
      ? data.items.filter((item) => item.Name.toLowerCase().includes(query))
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
      sortItems(left, right, effectiveSortBy),
    );
  }, [data, searchTerm, effectiveSortBy, curatedList]);

  // Sorting and filtering move cards rather than reshuffling them in place.
  const gridRef = useRef<HTMLDivElement | null>(null);
  const titleDetailsRef = useRef<HTMLDivElement | null>(null);
  // Where the title hero takes the details' watched button.
  const [watchedSlot, setWatchedSlot] = useState<HTMLSpanElement | null>(null);
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
    if (!data) {
      setPageTitle("Seyirlik", {
        canonicalPath,
        robots: "noindex, nofollow",
      });
      return;
    }

    const fallbackTitle = t(data.fallbackTitleKey ?? "library.library");
    const title = data.library?.Name
      ? getDisplayTitle(data.library, labels)
      : fallbackTitle;

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, data, labels, t]);

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
      preloadPlayer: () => preloadPlayerPage(true),
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
    <MobileLibraryLoading />
  ) : libraryRouteKind === "show" ||
    mode === "series" ||
    mode === "season" ||
    loadingItemType === "Series" ||
    loadingItemType === "Season" ? (
    <ShowLibrarySkeleton mobile />
  ) : libraryRouteKind === "movie" || loadingItemType === "Movie" ? (
    <MovieLibrarySkeleton mobile />
  ) : (
    <MobileLibraryLoading />
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
        <MovieLibrarySkeleton mobile item={data.library} />
      ) : (
        <ShowLibrarySkeleton mobile item={data.library} />
      );

    const showTitleDetails = () =>
      titleDetailsRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });

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
            {isPhone ? (
              isInitialDetailsReady ? (
                <HeroBackButton
                  fallbackTo={
                    data.library.Type === "Movie" ? "/movies" : "/shows"
                  }
                />
              ) : null
            ) : null}

            {/* A phone, and a tablet held upright, have the phone's title
                hero: the whole backdrop, the copy beneath it. A tablet on its
                side gets the desktop's, on a stage its own shape: the same
                composition, copy and actions as the home hero, with nothing
                queued. */}
            <div className="full-bleed relative">
              {isPhone ? (
                <PhoneTitleHero
                  key={data.library.Id}
                  item={data.library}
                  isRevealed={isInitialDetailsReady}
                  onWatchedSlot={setWatchedSlot}
                  onShowDetails={showTitleDetails}
                />
              ) : (
                <TitleHero
                  key={data.library.Id}
                  item={data.library}
                  backTo={data.library.Type === "Movie" ? "/movies" : "/shows"}
                  onWatchedSlot={setWatchedSlot}
                  fit="mobile"
                  trailers={false}
                  isRevealed={isInitialDetailsReady}
                  onShowDetails={showTitleDetails}
                />
              )}
            </div>

            {/* A phone's hero has no stage for a centre dock; it stands
                under the hero instead. */}
            {isPhone ? renderCentreDock?.(null) : null}

            <div
              ref={titleDetailsRef}
              className="scroll-mt-[calc(4rem+env(safe-area-inset-top))]"
            >
              <SeriesLibraryDetails
                initialItem={data.library}
                variant="mobile"
                watchedSlot={watchedSlot}
                watchedSlotLook={isPhone ? "phone" : "dock"}
                canonicalPath={canonicalPath}
                onInitialReady={() => setReadyDetailsId(activeId ?? null)}
              />
            </div>
          </div>
        </div>
      </>
    );
  }

  const fallbackTitle = t(data.fallbackTitleKey ?? "library.library");
  const title = data.library?.Name
    ? getDisplayTitle(data.library, labels)
    : fallbackTitle;
  const itemType = data.items.find((item) => item.Type)?.Type;
  const firstEpisodeItem = data.items.find((item) => item.Type === "Episode");
  const firstItemWithLogo = data.items.find(
    (libraryItem) =>
      Boolean(libraryItem.ImageTags?.Logo) ||
      Boolean(libraryItem.ParentLogoItemId && libraryItem.ParentLogoImageTag),
  );
  const shelfNavKey = getShelfNavKey(location.pathname);
  const libraryArtTitle = shelfNavKey ? t(shelfNavKey) : title;

  const fallbackLogoUrl = data.library?.ImageTags?.Logo
    ? getLogoImageUrl(data.library.Id, data.library.ImageTags.Logo, 900)
    : data.library?.ParentLogoItemId && data.library.ParentLogoImageTag
      ? getLogoImageUrl(
          data.library.ParentLogoItemId,
          data.library.ParentLogoImageTag,
          900,
        )
      : firstItemWithLogo?.ImageTags?.Logo
        ? getLogoImageUrl(
            firstItemWithLogo.Id,
            firstItemWithLogo.ImageTags.Logo,
            900,
          )
        : firstItemWithLogo?.ParentLogoItemId &&
            firstItemWithLogo.ParentLogoImageTag
          ? getLogoImageUrl(
              firstItemWithLogo.ParentLogoItemId,
              firstItemWithLogo.ParentLogoImageTag,
              900,
            )
          : "";
  const localizedFallbackLogoUrl = getItemLogoUrlById(
    data.library?.Id ??
      firstItemWithLogo?.ParentLogoItemId ??
      firstItemWithLogo?.Id,
    language,
    fallbackLogoUrl,
  );

  const activeLibraryLogoUrl = localizedFallbackLogoUrl;
  const countText =
    itemType === "Season"
      ? countLabel(
          data.items.length,
          "media.seasonSingular",
          "media.seasonPlural",
          t,
        )
      : itemType === "Episode"
        ? countLabel(
            data.items.length,
            "media.episodeSingular",
            "media.episodePlural",
            t,
          )
        : `${data.items.length} ${t("library.itemsAvailable")}`;
  const usesLandscapeCards = itemType === "Episode";
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
  return (
    <div className="pb-[calc(5.75rem+env(safe-area-inset-bottom))]">
      <section className="full-bleed relative -mt-1 min-h-[7rem] overflow-hidden border-white/10 bg-zinc-950 px-4 pb-12 pt-3">
        <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/38 to-[#050506]" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#050506] to-transparent" />

        <div className="relative z-20 flex items-center justify-between gap-3">
          <BackButton buttonClassName="min-h-9 px-3 text-xs" />

          <p className="min-w-0 truncate text-right text-xs font-bold text-white/62">
            {countText}
          </p>
        </div>
      </section>

      <div className="relative z-30 -mt-11 mb-5 flex min-h-[5.5rem] items-center justify-center px-4">
        {mode === "library" ? (
          <>
            <LibraryHeaderArt items={data.items} compact />
            <h1 className="sr-only">{libraryArtTitle}</h1>
          </>
        ) : activeLibraryLogoUrl ? (
          // The logo stands in for the title, so it carries the heading.
          <h1 className="flex min-w-0 justify-center">
            <img
              src={activeLibraryLogoUrl}
              alt={title}
              draggable={false}
              className="cinematic-logo-shadow h-auto max-h-16 max-w-[min(16rem,74vw)] transform-gpu object-contain will-change-transform"
            />
          </h1>
        ) : (
          <motion.h1
            className="mx-auto max-w-[84vw] text-center text-3xl font-black tracking-tight text-white drop-shadow-[0_16px_38px_rgba(0,0,0,0.9)]"
            initial={{ opacity: 0, transform: move({ y: 6 }) }}
            animate={{ opacity: 1, ...settle }}
            transition={{
              duration: 0.5,
              ease: [0.16, 1, 0.3, 1],
            }}
          >
            {title}
          </motion.h1>
        )}
      </div>

      {isLibraryScopeWatched ? (
        <div className="mb-5 flex justify-center">
          <WatchedIndicator isWatched size="md" />
        </div>
      ) : null}

      <div className="mb-5 flex gap-2">
        <label className={`relative min-w-0 flex-1 pl-9 ${glassInputControl}`}>
          <Search
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40"
          />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("common.search")}
            aria-label={t("library.searchLabel")}
            className="h-11 w-full bg-transparent text-sm text-white outline-none placeholder:text-white/30"
          />
        </label>
        <label
          className={`${glassControlBase} h-12 w-[7.4rem] shrink-0 gap-1.5 px-3 text-xs font-semibold`}
        >
          <SlidersHorizontal size={15} />
          <select
            value={effectiveSortBy}
            onChange={(event) =>
              setSortBy(event.target.value as LibrarySortMode)
            }
            aria-label={t("library.sortBy")}
            className="min-w-0 flex-1 bg-transparent text-white outline-none"
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
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {seasonResetSeriesId && currentSeasonId && hasUnwatchedSeasonItems ? (
          <WatchedStatusButton
            scope="season"
            action="mark"
            seriesId={seasonResetSeriesId}
            seasonId={currentSeasonId}
            confirm
            onReset={handleWatchedStatusReset}
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {showResetSeriesId && hasWatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="remove"
            seriesId={showResetSeriesId}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "remove",
                scope: "show",
              })
            }
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
        {showResetSeriesId && hasUnwatchedShowItems ? (
          <WatchedStatusButton
            scope="show"
            action="mark"
            seriesId={showResetSeriesId}
            confirm
            onReset={(items) =>
              handleWatchedStatusReset(items, {
                action: "mark",
                scope: "show",
              })
            }
            className={`${glassControlBase} h-12 w-12 shrink-0`}
            iconSize={16}
          />
        ) : null}
      </div>

      {filteredItems.length > 0 ? (
        <div
          ref={gridRef}
          className={
            usesLandscapeCards
              ? "relative mx-auto grid max-w-sm grid-cols-1 gap-3"
              : "relative grid grid-cols-2 gap-x-3 gap-y-4 px-[clamp(0.5rem,4vw,1.75rem)] min-[600px]:grid-cols-3"
          }
        >
          {filteredItems.map((item) => (
            <MobileMediaCard
              key={item.Id}
              item={item}
              to={getRouteForItem(item)}
              layout="grid"
              variant={item.Type === "Episode" ? "landscape" : "poster"}
              collectionItems={data.collectionPosterChildrenById[item.Id]}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/62">
          {t("library.noMatches")}
        </p>
      )}
    </div>
  );
}
