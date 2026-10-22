import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ErrorMessage } from "../../components/ErrorMessage";
import { HomeHero } from "../../components/home/HomeHero";
import { MediaRow } from "../../components/MediaRow";
import { HomeSkeleton } from "../../components/Skeletons";
import { useLanguage } from "../../i18n/LanguageContext";
import { getFavouriteItems, getLatestMediaItems } from "../../lib/mediaApi";
import { FAVOURITE_CHANGED_EVENT } from "../../lib/favouriteActions";
import { applyCuration, buildHomeCarouselPool } from "../../lib/curation";
import { buildLatestRow } from "../../lib/homeShelves";
import { useCataloguePools } from "../../hooks/useCataloguePools";
import { useHomeCuratedLists } from "../../hooks/useCuratedList";
import { getSmartContinueWatchingItems } from "../../lib/smartContinueWatching";
import { WATCH_STATUS_CHANGED_EVENT } from "../../lib/watchedStatusActions";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { ConfettiAnimation } from "../../components/animations/ConfettiAnimation";
import { setSeoMetadata } from "../../lib/seo";
import { useStandaloneWebApp } from "../../hooks/useStandaloneWebApp";
import { groupLatestMediaItems } from "../../lib/latestMedia";
import { useDevSkeletonMode } from "../../lib/devSkeletonMode";
import {
  consumeLoginConfettiPending,
  markDailyHomeConfettiShown,
  shouldShowDailyHomeConfetti,
} from "../../lib/homeConfetti";
import {
  getHomeLoadErrorMessage,
  removeContinueWatchingItem,
  replaceContinueWatchingItems,
} from "../home/homeModel";

type HomeRowLabelKey = "home.continueWatching" | "home.latestMedia";

interface HomeData {
  continueWatching: MediaItem[];
  latestMedia: MediaItem[];
  heroItems: MediaItem[];
  favourites: MediaItem[];
}

interface RowWarning {
  labelKey: HomeRowLabelKey;
  message: string;
}

export function DesktopHomePage() {
  const { t } = useLanguage();
  const forceSkeletons = useDevSkeletonMode();
  const isWebApp = useStandaloneWebApp();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowWarnings, setRowWarnings] = useState<RowWarning[]>([]);

  const [isHeroReady, setIsHeroReady] = useState(false);
  const [shouldShowConfetti, setShouldShowConfetti] = useState(false);
  const hasEvaluatedConfetti = useRef(false);

  const curatedLists = useHomeCuratedLists();
  const pools = useCataloguePools();

  const featuredPool = useMemo(() => {
    const heroItems = pools.loaded
      ? [...pools.movies, ...pools.series]
      : (data?.latestMedia ?? []);

    return applyCuration(buildHomeCarouselPool(heroItems), curatedLists.hero);
  }, [pools, data?.latestMedia, curatedLists.hero]);

  const refreshSmartContinueWatching = useCallback(async () => {
    const smartContinueItems = await getSmartContinueWatchingItems();
    setData((currentData) =>
      replaceContinueWatchingItems(currentData, smartContinueItems),
    );
  }, []);

  useEffect(() => {
    setSeoMetadata({
      title: `${t("common.home")} · Seyirlik`,
      canonicalPath: "/home",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    if (!isHeroReady || hasEvaluatedConfetti.current) return;
    hasEvaluatedConfetti.current = true;

    if (consumeLoginConfettiPending()) {
      markDailyHomeConfettiShown();
      setShouldShowConfetti(true);
      return;
    }

    if (shouldShowDailyHomeConfetti()) {
      markDailyHomeConfettiShown();
      setShouldShowConfetti(true);
    }
  }, [isHeroReady]);

  useEffect(() => {
    let isMounted = true;
    async function loadHome() {
      setError(null);
      setRowWarnings([]);

      const [continueResult, latestResult, favouritesResult] =
        await Promise.allSettled([
          getSmartContinueWatchingItems(),
          getLatestMediaItems(),
          // A failed My List row must not take the rest of the home page with
          // it, so it is settled alongside the others and simply stays empty.
          getFavouriteItems(),
        ]);

      if (!isMounted) return;

      const warnings: RowWarning[] = [];

      if (continueResult.status === "rejected") {
        warnings.push({
          labelKey: "home.continueWatching",
          message: getHomeLoadErrorMessage(
            continueResult,
            t,
            t("home.someDataFailed"),
          ),
        });
      }

      if (latestResult.status === "rejected") {
        warnings.push({
          labelKey: "home.latestMedia",
          message: getHomeLoadErrorMessage(
            latestResult,
            t,
            t("home.someDataFailed"),
          ),
        });
      }

      setRowWarnings(warnings);

      // Stored raw: each Latest row carries its own ordering, so the curation
      // is applied per row at render rather than to the mixed pool here.
      const latestMedia =
        latestResult.status === "fulfilled" ? latestResult.value : [];
      setData({
        continueWatching:
          continueResult.status === "fulfilled" ? continueResult.value : [],
        latestMedia,
        heroItems: latestMedia,
        favourites:
          favouritesResult.status === "fulfilled" ? favouritesResult.value : [],
      });
    }
    void loadHome();
    return () => {
      isMounted = false;
    };
  }, [t]);

  useEffect(() => {
    const handleWatchStatusChanged = () => void refreshSmartContinueWatching();
    window.addEventListener(
      WATCH_STATUS_CHANGED_EVENT,
      handleWatchStatusChanged,
    );
    return () =>
      window.removeEventListener(
        WATCH_STATUS_CHANGED_EVENT,
        handleWatchStatusChanged,
      );
  }, [refreshSmartContinueWatching]);

  useEffect(() => {
    const handleFavouriteChanged = () => {
      void getFavouriteItems()
        .then((favourites) => {
          setData((currentData) =>
            currentData ? { ...currentData, favourites } : currentData,
          );
        })
        .catch(() => undefined);
    };

    window.addEventListener(FAVOURITE_CHANGED_EVENT, handleFavouriteChanged);

    return () =>
      window.removeEventListener(
        FAVOURITE_CHANGED_EVENT,
        handleFavouriteChanged,
      );
  }, []);

  const handleClearContinueWatching = (clearedItem: MediaItem) => {
    setData((currentData) =>
      removeContinueWatchingItem(currentData, clearedItem.Id),
    );
    void refreshSmartContinueWatching();
  };

  if (forceSkeletons) {
    return <HomeSkeleton />;
  }

  if (error) {
    return <ErrorMessage title={t("home.couldNotLoad")} message={error} />;
  }

  if (!data) {
    return <HomeSkeleton />;
  }

  const showContinueWatchingRow = data.continueWatching.length > 0;
  /*
   * Each row draws from the whole library once the catalogue has arrived, and
   * from the server's Latest page until then. The fallback is what keeps the
   * first paint honest: a row that renders empty for a second while nine
   * hundred films are fetched is worse than a row that starts short.
   */
  const groupedLatestMedia = groupLatestMediaItems(data.latestMedia);
  const latestMediaGroups = {
    movies: buildLatestRow(
      pools.loaded ? pools.movies : groupedLatestMedia.movies,
      curatedLists.movies,
    ),
    shows: buildLatestRow(
      pools.loaded ? pools.series : groupedLatestMedia.shows,
      curatedLists.shows,
    ),
    books: buildLatestRow(
      pools.loaded ? pools.books : groupedLatestMedia.books,
      curatedLists.books,
    ),
  };

  return (
    <div
      className={[
        "layout-no-offset",
        isWebApp ? "pt-[calc(env(safe-area-inset-top)+0rem)]" : "",
      ].join(" ")}
    >
      {shouldShowConfetti ? (
        <ConfettiAnimation startDelay={0} pieceCount={200} />
      ) : null}

      <div className="full-bleed flow-root">
        <HomeHero items={featuredPool} onReady={() => setIsHeroReady(true)} />
      </div>

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
        {rowWarnings.length > 0 ? (
          <div className="mb-4 space-y-3">
            {rowWarnings.map((warning) => (
              <ErrorMessage
                key={`${warning.labelKey}-${warning.message}`}
                title={t("home.someDataFailed")}
                message={`${t(warning.labelKey)}: ${warning.message}`}
              />
            ))}
          </div>
        ) : null}

        <AnimatePresence initial={false}>
          {showContinueWatchingRow ? (
            <motion.div
              key="continue-watching"
              className="relative z-10"
              exit={{ opacity: 0, y: -10, height: 0 }}
              transition={{ duration: 0.24 }}
            >
              <MediaRow
                title={t("home.continueWatching")}
                items={data.continueWatching}
                getItemTo={getRouteForItem}
                emptyMessage={t("home.nothingInProgress")}
                showRestartWatching
                onClearContinueWatching={handleClearContinueWatching}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {data.favourites.length > 0 ? (
          <MediaRow
            title={t("myList.title")}
            items={data.favourites}
            getItemTo={getRouteForItem}
            viewAllTo="/my-list"
          />
        ) : null}

        <MediaRow
          title={t("home.latestAddedMovies")}
          items={latestMediaGroups.movies}
          getItemTo={getRouteForItem}
          emptyMessage={t("home.noLatestMovies")}
        />

        <MediaRow
          title={t("home.latestAddedShows")}
          items={latestMediaGroups.shows}
          getItemTo={getRouteForItem}
          emptyMessage={t("home.noLatestShows")}
        />

        <MediaRow
          title={t("home.latestAddedBooks")}
          items={latestMediaGroups.books}
          getItemTo={getRouteForItem}
          emptyMessage={t("home.noLatestBooks")}
        />
      </div>
    </div>
  );
}
