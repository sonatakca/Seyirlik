import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { CustomVideoPlayer } from "../../components/player/CustomVideoPlayer";
import { ErrorMessage } from "../../components/ErrorMessage";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import { usePlaybackQueue } from "../../hooks/usePlaybackQueue";
import { usePlaybackSource } from "../../hooks/usePlaybackSource";
import { usePartyWatch } from "../../features/partyWatch/usePartyWatch";
import { useLanguage } from "../../i18n/LanguageContext";
import { getItem } from "../../lib/mediaApi";
import { loadPlayerItem } from "../../lib/offline/offlineLibrary";
import type { MediaItem } from "../../lib/types";
import {
  getMediaOwnerRouteFromNavigationState,
  getMediaOwnerRouteForItem,
  getWatchRouteForItem,
} from "../../lib/routes";
import { readPreloadedPlaybackItem } from "../../lib/playbackPreload";
import {
  setDefaultPageTitle,
  setLoadingPageTitle,
  setPageTitle,
} from "../../lib/pageTitle";
import { setSeoMetadata } from "../../lib/seo";
import { usePlaybackReporting } from "../player/usePlaybackReporting";
import {
  getInitialPlaybackSeconds,
  getPlayerLoadingBackdropUrl,
} from "../player/playerPageModel";
import { describeErrorForUser } from "../../lib/userFacingError";

export function DesktopPlayerPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const shouldReduceMotion = Boolean(useReducedMotion());
  const [item, setItem] = useState<MediaItem | null>(() =>
    itemId ? readPreloadedPlaybackItem(itemId) : null,
  );
  const [itemError, setItemError] = useState<string | null>(null);
  const [isVideoTimelinePreparing, setIsVideoTimelinePreparing] =
    useState(true);

  /** A downloaded copy, played with no server involved. */
  const offlineOnly = location.pathname.startsWith("/downloads/watch/");
  const playback = usePlaybackSource(itemId, { offlineOnly });
  // Held by the page, not the player: the player unmounts while the next
  // title loads, and the party must not notice.
  const party = usePartyWatch(offlineOnly ? "" : (itemId ?? ""));
  const playbackQueue = usePlaybackQueue(offlineOnly ? null : item);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setItemError(t("player.missingItemId"));
        return;
      }

      setItemError(null);
      const preloadedItem = readPreloadedPlaybackItem(itemId);
      setItem(preloadedItem);

      try {
        const itemDetails = await loadPlayerItem(itemId, offlineOnly, getItem);

        console.info("[Seyirlik Item] Full item details", itemDetails);
        console.info("[Seyirlik Item] Chapters", itemDetails.Chapters);
        console.info("[Seyirlik Item] MediaSources", itemDetails.MediaSources);

        if (isMounted) {
          setItem(itemDetails);
        }
      } catch (error) {
        if (isMounted) {
          setItemError(
            describeErrorForUser(error, t, "player.couldNotLoadItem"),
          );
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, offlineOnly, t]);

  useEffect(() => {
    setIsVideoTimelinePreparing(true);
  }, [itemId]);

  useEffect(() => {
    const isPageLoading = !item || playback.isLoading;

    if (isPageLoading) {
      const loadingTitle =
        item?.SeriesName && item?.IndexNumber
          ? `${item.SeriesName} - ${item.Name}`
          : item?.Name;

      setSeoMetadata({
        title: loadingTitle ?? t("player.preparing"),
        canonicalPath: itemId ? `/watch/${itemId}` : "/watch",
        robots: "noindex, nofollow",
      });
      setLoadingPageTitle(loadingTitle);
      return;
    }

    const title =
      item.SeriesName && item.IndexNumber
        ? `${item.SeriesName} - ${item.Name}`
        : item.Name;

    setPageTitle(title, {
      canonicalPath: `/watch/${item.Id}`,
      robots: "noindex, nofollow",
    });

    return () => {
      setDefaultPageTitle(false);
    };
  }, [item, itemId, playback.isLoading, t]);

  const {
    handlePlaybackBeforeUnload,
    handlePlaybackProgress,
    handlePlaybackStarted,
    handlePlaybackStopped,
  } = usePlaybackReporting(playback.activeSource);

  const handlePlayNextUp = useCallback(
    (nextItem: MediaItem) => {
      navigate(getWatchRouteForItem(nextItem));
    },
    [navigate],
  );

  const loadingBackdropUrl = getPlayerLoadingBackdropUrl(item);
  const requestedMediaOwnerRoute = getMediaOwnerRouteFromNavigationState(
    location.state,
  );
  const mediaOwnerRoute = offlineOnly
    ? "/downloads"
    : item
      ? (requestedMediaOwnerRoute ?? getMediaOwnerRouteForItem(item))
      : "/home";

  const isPreparingPlayback =
    !item ||
    playback.isLoading ||
    !playback.activeSource ||
    isVideoTimelinePreparing;

  if (itemError) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <Link
          to="/home"
          className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft size={17} />
          {t("common.home")}
        </Link>
        <ErrorMessage
          title={t("player.playbackUnavailable")}
          message={itemError}
        />
      </main>
    );
  }

  if (isPreparingPlayback && item && playback.error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black p-4 text-white">
        <div className="w-full max-w-2xl">
          <Link
            to={mediaOwnerRoute}
            replace
            className="mb-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronLeft size={17} />
            {t("common.details")}
          </Link>
          <ErrorMessage
            title={t("player.playbackUnavailable")}
            message={playback.error.message}
            details={playback.error.details}
            onRetry={playback.retry}
          />
        </div>
      </main>
    );
  }

  const resolvedItem = item;
  const resolvedSource = playback.activeSource;
  const shouldShowStandalonePreparingOverlay =
    isPreparingPlayback && (!resolvedItem || !resolvedSource);

  const shouldStartFromBeginning =
    searchParams.get("start") === "0" || searchParams.get("restart") === "1";
  const initialStartSeconds = getInitialPlaybackSeconds(
    resolvedItem,
    shouldStartFromBeginning,
  );

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      {resolvedItem && resolvedSource ? (
        <CustomVideoPlayer
          item={resolvedItem}
          source={resolvedSource}
          playbackCandidates={playback.candidates}
          notice={playback.notice}
          error={playback.error}
          hasTranscodingFallback={playback.hasTranscodingFallback}
          onVideoFailure={playback.handleVideoFailure}
          onVideoRecovery={playback.handleVideoRecovery}
          onTryTranscodedPlayback={playback.tryTranscodedPlayback}
          onRetryPlayback={playback.retry}
          initialStartSeconds={initialStartSeconds}
          onPlaybackStarted={handlePlaybackStarted}
          onPlaybackProgress={handlePlaybackProgress}
          onPlaybackStopped={handlePlaybackStopped}
          onPlaybackBeforeUnload={handlePlaybackBeforeUnload}
          onPreparingPlaybackChange={setIsVideoTimelinePreparing}
          nextEpisode={
            resolvedItem.Type === "Episode"
              ? (playbackQueue?.nextItem ?? null)
              : null
          }
          playbackQueue={playbackQueue}
          enableDefaultNextEpisodeCountdown={resolvedItem.Type === "Episode"}
          onAutoPlayNextEpisode={handlePlayNextUp}
          onPlayQueueItem={handlePlayNextUp}
          showPreparingArtwork={isPreparingPlayback}
          preparingBackdropUrl={loadingBackdropUrl}
          backTo={mediaOwnerRoute}
          party={party}
        />
      ) : null}

      <AnimatePresence>
        {shouldShowStandalonePreparingOverlay ? (
          <motion.div
            key="playback-loading-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.45,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="fixed inset-0 z-[100] overflow-hidden bg-black"
          >
            {loadingBackdropUrl ? (
              <motion.img
                src={loadingBackdropUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                initial={{
                  opacity: 0,
                  scale: shouldReduceMotion ? 1 : 1.035,
                }}
                animate={{
                  opacity: 1,
                  scale: 1.02,
                }}
                exit={{
                  opacity: 0,
                  scale: shouldReduceMotion ? 1 : 1.01,
                }}
                transition={{
                  opacity: {
                    duration: shouldReduceMotion ? 0 : 0.5,
                  },
                  scale: {
                    duration: shouldReduceMotion ? 0 : 1.2,
                    ease: [0.22, 1, 0.36, 1],
                  },
                }}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}

            <motion.div
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.4 }}
              className="absolute inset-0 bg-black/45"
            />

            <motion.div
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.45 }}
              className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-black/45"
            />

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.35,
                delay: shouldReduceMotion ? 0 : 0.08,
              }}
              className="absolute inset-0 z-10 grid place-items-center"
            >
              <div className="flex items-center justify-center">
                <LoadingSpinner label="" />
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
