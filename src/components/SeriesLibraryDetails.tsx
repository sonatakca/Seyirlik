import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Play,
  UserRound,
} from "lucide-react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ErrorMessage } from "./ErrorMessage";
import { MediaCard } from "./MediaCard";
import { EpisodeCardSkeleton } from "./Skeletons";
import { MobileMediaCard } from "./mobile/MobileMediaCard";
import {
  PHONE_TITLE_ACTION_ICON,
  PHONE_TITLE_HERO_ACTION,
} from "./mobile/phoneTitleHeroRows";
import { MotionReveal } from "./MotionReveal";
import { WatchedStatusButton } from "./WatchedStatusButton";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getAllSeriesEpisodes,
  getItem,
  getItemPeople,
  getLocalTrailers,
  getPrimaryImageUrl,
  getSeasonEpisodes,
  getSeriesSeasons,
  getSimilarItems,
} from "../lib/mediaApi";
import { getDisplayTitle } from "../lib/format";
import { getItemDisplayMetadata } from "../lib/itemMetadataPreferences";
import { getRouteForItem, getWatchRouteForItem } from "../lib/routes";
import type { PlayerNavigationState } from "../lib/routes";
import { setPageTitle } from "../lib/pageTitle";
import type { MediaItem } from "../lib/types";
import type { ItemPersonDto } from "../api/ownApi/dto";
import type { Language } from "../i18n/translations";
import { isItemCompleted } from "../lib/watchStatus";

interface MediaPerson {
  Id: string;
  Name: string;
  /** The character played, then any crew jobs, e.g. "Rick · Director". */
  Role?: string;
  ImageUrl?: string;
}

interface MediaStudio {
  Id?: string;
  Name?: string;
}

type SeriesDetailsItem = MediaItem & {
  Studios?: MediaStudio[];
};

const CREW_JOB_LABELS: Record<
  "tr" | "en",
  Record<"director" | "writer" | "producer" | "composer", string>
> = {
  tr: {
    director: "Yönetmen",
    writer: "Senarist",
    producer: "Yapımcı",
    composer: "Besteci",
  },
  en: {
    director: "Director",
    writer: "Writer",
    producer: "Producer",
    composer: "Composer",
  },
};

/**
 * One card per person: the server lists a credit per role, so someone who
 * both directs and acts arrives twice and is folded together here, keeping
 * the place of their first credit.
 */
function toCredits(people: ItemPersonDto[], language: Language): MediaPerson[] {
  const credits = new Map<
    string,
    { person: ItemPersonDto; character?: string; jobs: string[] }
  >();

  for (const person of people) {
    const credit = credits.get(person.id) ?? { person, jobs: [] };
    credits.set(person.id, credit);

    if (person.role === "actor" || person.role === "guest") {
      credit.character ??= person.character;
    } else {
      credit.jobs.push(CREW_JOB_LABELS[language][person.role]);
    }
  }

  return [...credits.values()].map(({ person, character, jobs }) => {
    const role = [character, ...jobs].filter(Boolean).join(" · ");
    return {
      Id: person.id,
      Name: person.name,
      ...(role ? { Role: role } : {}),
      ...(person.imageUrl ? { ImageUrl: person.imageUrl } : {}),
    };
  });
}

interface SeriesLibraryDetailsProps {
  initialItem: MediaItem;
  variant: "desktop" | "mobile";
  canonicalPath: string;
  onInitialReady?: () => void;
  /**
   * The title hero's place for the watched button: a phone's action row, or
   * the bar over a wider hero's dock. Null until the hero has drawn it.
   */
  watchedSlot: HTMLElement | null;
  /** Which of the two the slot is, for the button's look. */
  watchedSlotLook: "phone" | "dock";
}

interface MediaShelfProps {
  title: string;
  headerControl?: ReactNode;
  children: ReactNode;
  variant: "desktop" | "mobile";
}

function MediaShelf({
  title,
  headerControl,
  children,
  variant,
}: MediaShelfProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = () => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      return;
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    setCanScrollLeft(scroller.scrollLeft > 2);
    setCanScrollRight(scroller.scrollLeft < maxScrollLeft - 2);
  };

  useEffect(() => {
    updateScrollState();

    const scroller = scrollerRef.current;

    if (!scroller) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scroller);
    window.addEventListener("resize", updateScrollState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [children]);

  const scroll = (direction: "left" | "right") => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      return;
    }

    scroller.scrollBy({
      left:
        direction === "left"
          ? -scroller.clientWidth * 0.82
          : scroller.clientWidth * 0.82,
      behavior: "smooth",
    });
  };

  return (
    <MotionReveal className={variant === "desktop" ? "py-5" : "py-3"}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className={"text-2xl font-black text-white"}>{title}</h2>
        <div className="flex min-w-0 items-center gap-3">{headerControl}</div>

        {variant === "desktop" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => scroll("left")}
              disabled={!canScrollLeft}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-25"
              aria-label={`Scroll ${title} left`}
            >
              <ChevronLeft size={19} />
            </button>
            <button
              type="button"
              onClick={() => scroll("right")}
              disabled={!canScrollRight}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white transition hover:bg-white/[0.12] disabled:pointer-events-none disabled:opacity-25"
              aria-label={`Scroll ${title} right`}
            >
              <ChevronRight size={19} />
            </button>
          </div>
        ) : null}
      </div>

      <div
        ref={scrollerRef}
        onScroll={updateScrollState}
        className="media-scroll flex snap-x gap-3 overflow-x-auto overflow-y-visible pb-5 pt-1 sm:gap-4"
      >
        {children}
      </div>
    </MotionReveal>
  );
}

/**
 * A headshot at its own 2:3 shape. TMDB's are portraits; a circle keeps only
 * the middle of one and loses the hair and shoulders that make a face read.
 * Without a picture, or when it fails to load, the frame holds an icon.
 */
function PersonPortrait({
  name,
  imageUrl,
}: {
  name: string;
  imageUrl?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="aspect-[2/3] w-full overflow-hidden rounded-xl border border-white/10 bg-white/[0.06]">
      {imageUrl && !failed ? (
        <img
          src={imageUrl}
          alt={name}
          loading="lazy"
          className="h-full w-full object-cover object-top"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-white/25">
          <UserRound aria-hidden size={36} strokeWidth={1.5} />
        </div>
      )}
    </div>
  );
}

function SeriesDetailsLoading({ variant }: { variant: "desktop" | "mobile" }) {
  return (
    <div
      className={variant === "desktop" ? "space-y-8 pb-12" : "space-y-5 pb-7"}
    >
      <div className="shimmer h-10 w-24 rounded-full" />
      <div className="shimmer mx-auto h-20 w-72 max-w-[70vw] rounded-2xl" />
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index}>
          <div className="shimmer mb-4 h-7 w-36 rounded-lg" />
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 4 }, (_, cardIndex) => (
              <div
                key={cardIndex}
                className="shimmer aspect-video w-72 shrink-0 rounded-xl"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string | undefined, language: "en" | "tr") {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function getSeasonLabel(season: MediaItem, language: "en" | "tr"): string {
  if (typeof season.IndexNumber === "number" && season.IndexNumber >= 0) {
    return language === "tr"
      ? `${season.IndexNumber}. Sezon`
      : `Season ${season.IndexNumber}`;
  }

  return season.Name;
}

function sortSeasons(left: MediaItem, right: MediaItem) {
  return (
    (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.IndexNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.Name.localeCompare(right.Name, undefined, { numeric: true })
  );
}

function sortEpisodes(left: MediaItem, right: MediaItem) {
  return (
    (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.IndexNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.Name.localeCompare(right.Name, undefined, { numeric: true })
  );
}

export function SeriesLibraryDetails({
  initialItem,
  variant,
  canonicalPath,
  onInitialReady,
  watchedSlot,
  watchedSlotLook,
}: SeriesLibraryDetailsProps) {
  const { language, t } = useLanguage();
  const [series, setSeries] = useState<SeriesDetailsItem | null>(null);
  const [seasons, setSeasons] = useState<MediaItem[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<MediaItem[]>([]);
  const [seriesEpisodes, setSeriesEpisodes] = useState<MediaItem[]>([]);
  const [trailers, setTrailers] = useState<MediaItem[]>([]);
  const [similarItems, setSimilarItems] = useState<MediaItem[]>([]);
  const [people, setPeople] = useState<ItemPersonDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false);
  const [resolvedEpisodeSelectionKey, setResolvedEpisodeSelectionKey] =
    useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reportedReadyItemIdRef = useRef<string | null>(null);

  const isDesktop = variant === "desktop";
  const isMovie = initialItem.Type === "Movie";

  const seriesId = isMovie
    ? null
    : initialItem.Type === "Series"
      ? initialItem.Id
      : (initialItem.SeriesId ?? initialItem.ParentId);

  const detailsItemId = isMovie ? initialItem.Id : seriesId;
  const routeSeasonId = initialItem.Type === "Season" ? initialItem.Id : null;

  useEffect(() => {
    let cancelled = false;

    async function loadDetails() {
      if (!detailsItemId) {
        setError(
          language === "tr"
            ? "İçerik bilgileri bulunamadı."
            : "The media details could not be found.",
        );
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setSeriesEpisodes([]);

      try {
        const [
          seriesResult,
          seasonResults,
          trailerResults,
          similarResults,
          seriesEpisodeResults,
          peopleResults,
        ] = await Promise.all([
          initialItem.Type === "Series" || isMovie
            ? Promise.resolve(initialItem as SeriesDetailsItem)
            : getItem(detailsItemId).then((item) => item as SeriesDetailsItem),

          isMovie
            ? Promise.resolve([] as MediaItem[])
            : getSeriesSeasons(detailsItemId),

          getLocalTrailers(detailsItemId).catch(() => []),

          getSimilarItems(detailsItemId, 18).catch(() => []),

          isMovie
            ? Promise.resolve([] as MediaItem[])
            : getAllSeriesEpisodes(detailsItemId).catch(() => []),

          getItemPeople(detailsItemId).catch(() => []),
        ]);

        if (cancelled) {
          return;
        }

        const orderedSeasons = [...seasonResults].sort(sortSeasons);
        const defaultSeason =
          orderedSeasons.find((season) => season.Id === routeSeasonId) ??
          orderedSeasons.find((season) => season.IndexNumber === 1) ??
          orderedSeasons[0] ??
          null;

        setSeries(seriesResult);
        setPeople(peopleResults);
        setSeriesEpisodes(seriesEpisodeResults);
        setSeasons(orderedSeasons);
        setTrailers(trailerResults);
        setSimilarItems(
          similarResults.filter((item) => item.Id !== seriesResult.Id),
        );
        setSelectedSeasonId(defaultSeason?.Id ?? null);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : language === "tr"
                ? "Dizi ayrıntıları yüklenemedi."
                : "Series details could not be loaded.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadDetails();

    return () => {
      cancelled = true;
    };
  }, [initialItem, language, routeSeasonId, seriesId]);

  useEffect(() => {
    let cancelled = false;
    const selectionKey =
      seriesId && selectedSeasonId ? `${seriesId}:${selectedSeasonId}` : null;

    async function loadEpisodes() {
      if (!seriesId || !selectedSeasonId) {
        setEpisodes([]);
        setResolvedEpisodeSelectionKey(null);
        return;
      }

      setIsLoadingEpisodes(true);
      setResolvedEpisodeSelectionKey(null);

      try {
        const episodeResults = await getSeasonEpisodes(
          seriesId,
          selectedSeasonId,
        );

        if (!cancelled) {
          setEpisodes([...episodeResults].sort(sortEpisodes));
        }
      } catch (episodeError) {
        if (!cancelled) {
          console.warn("[Seyirlik Series Details] Could not load episodes", {
            seriesId,
            selectedSeasonId,
            error: episodeError,
          });
          setEpisodes([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingEpisodes(false);
          setResolvedEpisodeSelectionKey(selectionKey);
        }
      }
    }

    void loadEpisodes();

    return () => {
      cancelled = true;
    };
  }, [selectedSeasonId, seriesId]);

  useEffect(() => {
    const selectionKey =
      seriesId && selectedSeasonId ? `${seriesId}:${selectedSeasonId}` : null;
    const initialEpisodesReady =
      isMovie || !selectionKey || resolvedEpisodeSelectionKey === selectionKey;
    const initialDetailsReady =
      !isLoading && !isLoadingEpisodes && (Boolean(series) || Boolean(error));

    if (
      initialDetailsReady &&
      initialEpisodesReady &&
      reportedReadyItemIdRef.current !== initialItem.Id
    ) {
      reportedReadyItemIdRef.current = initialItem.Id;
      onInitialReady?.();
    }
  }, [
    error,
    initialItem.Id,
    isLoading,
    isLoadingEpisodes,
    isMovie,
    onInitialReady,
    resolvedEpisodeSelectionKey,
    selectedSeasonId,
    series,
    seriesId,
  ]);

  const title = useMemo(() => {
    if (!series) {
      return initialItem.Name;
    }

    const localizedTitle = getItemDisplayMetadata(series, language).title;

    if (localizedTitle) {
      return localizedTitle;
    }

    return getDisplayTitle(series, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    });
  }, [initialItem.Name, language, series, t]);

  useEffect(() => {
    if (!title) {
      return;
    }

    setPageTitle(`${title} · Seyirlik`, {
      canonicalPath,
      robots: "noindex, nofollow",
    });
  }, [canonicalPath, title]);

  if (isLoading) {
    return <SeriesDetailsLoading variant={variant} />;
  }

  if (error || !series) {
    return (
      <ErrorMessage
        title={language === "tr" ? "Dizi kullanılamıyor" : "Series unavailable"}
        message={error ?? "Unknown error"}
      />
    );
  }

  const itemDisplayMetadata = getItemDisplayMetadata(series, language);
  const cast = toCredits(people, language);
  const studios = (series.Studios ?? [])
    .map((studio) => studio.Name)
    .filter((name): name is string => Boolean(name));
  const releaseDate = formatDate(series.PremiereDate, language);
  const ratingPercent =
    typeof series.CommunityRating === "number"
      ? Math.round(series.CommunityRating * 10)
      : null;
  const isDetailsItemWatched = isMovie
    ? isItemCompleted(series)
    : seriesEpisodes.length > 0
      ? seriesEpisodes.every((episode) => isItemCompleted(episode))
      : isItemCompleted(series);
  const canChangeWatchedStatus = isMovie || seriesEpisodes.length > 0;
  const handleWatchedStatusChange = (changedItems: MediaItem[]) => {
    const changedItemsById = new Map(
      changedItems.map((changedItem) => [changedItem.Id, changedItem]),
    );

    if (isMovie) {
      const changedMovie = changedItemsById.get(series.Id);

      if (changedMovie) {
        setSeries((currentSeries) =>
          currentSeries
            ? {
                ...currentSeries,
                ...changedMovie,
                Studios: currentSeries.Studios,
              }
            : currentSeries,
        );
      }

      return;
    }

    setSeriesEpisodes(changedItems.filter((item) => item.Type === "Episode"));
    setEpisodes((currentEpisodes) =>
      currentEpisodes.map(
        (episode) => changedItemsById.get(episode.Id) ?? episode,
      ),
    );
  };
  const labels =
    language === "tr"
      ? {
          episodes: "Bölümler",
          trailers: "Fragmanlar",
          trailerLabel: "Fragman",
          similar: "Benzerler",
          cast: "Oyuncular ve ekip",
          about: "Hakkında",
          information: "Bilgiler",
          studio: "Stüdyo",
          release: "Yayın tarihi",
          ageRating: "Yaş sınırı",
          noEpisodes: "Bu sezon için bölüm bulunamadı.",
          selectSeason: "Sezon seç",
        }
      : {
          episodes: "Episodes",
          trailers: "Trailers",
          trailerLabel: "Trailer",
          similar: "Similar",
          cast: "Cast and crew",
          about: "About",
          information: "Information",
          studio: "Studio",
          release: "Release",
          ageRating: "Age rating",
          noEpisodes: "No episodes were found for this season.",
          selectSeason: "Select season",
        };

  const seasonSelector =
    seasons.length > 0 ? (
      <label className="relative shrink-0">
        <span className="sr-only">{labels.selectSeason}</span>
        <select
          value={selectedSeasonId ?? ""}
          onChange={(event) => setSelectedSeasonId(event.target.value)}
          className={
            isDesktop
              ? "h-10 rounded-xl bg-transparent px-3 pr-9 text-sm font-black text-white outline-none transition hover:bg-white/[0.12] cursor-pointer focus:border-white/30"
              : "h-9 max-w-[46vw] rounded-lg border border-white/10 bg-white/[0.08] px-2 pr-8 text-xs font-black text-white outline-none"
          }
        >
          {seasons.map((season) => (
            <option key={season.Id} value={season.Id}>
              {getSeasonLabel(season, language)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const trailerShelf =
    trailers.length > 0 ? (
      <MediaShelf title={labels.trailers} variant={variant}>
        {trailers.map((trailer) => (
          <Link
            key={trailer.Id}
            to={getWatchRouteForItem(trailer)}
            state={
              {
                mediaOwnerRoute: canonicalPath,
              } satisfies PlayerNavigationState
            }
            className={
              isDesktop
                ? "group relative aspect-video w-80 shrink-0 snap-start overflow-hidden rounded-xl border border-white/10 bg-zinc-900"
                : "group relative aspect-video w-[78vw] shrink-0 snap-start overflow-hidden rounded-xl border border-white/10 bg-zinc-900"
            }
          >
            <img
              src={getPrimaryImageUrl(
                trailer.Id,
                trailer.ImageTags?.Primary,
                isDesktop ? 900 : 650,
              )}
              alt={trailer.Name}
              loading="lazy"
              className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 p-3 text-white">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-black">
                <Play size={15} fill="currentColor" />
              </span>
              <span className="line-clamp-1 text-sm font-black">
                {labels.trailerLabel}
              </span>
            </div>
          </Link>
        ))}
      </MediaShelf>
    ) : null;

  return (
    <div className={isDesktop ? "pb-14" : "pb-7"}>
      {canChangeWatchedStatus && watchedSlot
        ? createPortal(
            <WatchedStatusButton
              scope={isMovie ? "item" : "show"}
              action={isDetailsItemWatched ? "remove" : "mark"}
              item={isMovie ? series : undefined}
              seriesId={isMovie ? undefined : series.Id}
              label={
                isDetailsItemWatched
                  ? isMovie
                    ? t("details.removeWatchedStatus")
                    : t("details.removeWatchedStatusForShow")
                  : isMovie
                    ? t("details.markWatchedStatus")
                    : t("details.markWatchedStatusForShow")
              }
              showLabel
              confirm={!isMovie}
              onReset={handleWatchedStatusChange}
              {...(watchedSlotLook === "phone"
                ? {
                    shortLabel: t("details.watchedShort"),
                    iconSize: PHONE_TITLE_ACTION_ICON,
                    icon: isDetailsItemWatched ? (
                      <Check size={PHONE_TITLE_ACTION_ICON} strokeWidth={2.2} />
                    ) : undefined,
                    className: PHONE_TITLE_HERO_ACTION,
                  }
                : { iconSize: 15, className: "hero-dock-action" })}
            />,
            watchedSlot,
          )
        : null}

      {!isDesktop ? trailerShelf : null}

      {!isMovie ? (
        <MediaShelf
          title={labels.episodes}
          headerControl={seasonSelector}
          variant={variant}
        >
          {isLoadingEpisodes ? (
            Array.from({ length: 4 }, (_, index) =>
              isDesktop ? (
                <div key={index} className="snap-start">
                  <EpisodeCardSkeleton />
                </div>
              ) : (
                <div
                  key={index}
                  className="shimmer aspect-video w-[78vw] shrink-0 rounded-xl"
                />
              ),
            )
          ) : episodes.length > 0 ? (
            episodes.map((episode, index) => (
              <div key={episode.Id} className="snap-start">
                {isDesktop ? (
                  <MediaCard
                    item={episode}
                    to={getRouteForItem(episode)}
                    variant="landscape"
                    index={index}
                    animateIn
                    showDownload
                  />
                ) : (
                  <MobileMediaCard
                    item={episode}
                    to={getRouteForItem(episode)}
                    variant="landscape"
                    showDownload
                  />
                )}
              </div>
            ))
          ) : (
            <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-5 text-sm text-white/55">
              {labels.noEpisodes}
            </p>
          )}
        </MediaShelf>
      ) : null}

      {isDesktop ? trailerShelf : null}

      {cast.length > 0 ? (
        <MediaShelf title={labels.cast} variant={variant}>
          {cast.map((person) => (
            <div
              key={person.Id}
              className={
                isDesktop
                  ? "w-32 shrink-0 snap-start"
                  : "w-[5.5rem] shrink-0 snap-start"
              }
            >
              <PersonPortrait name={person.Name} imageUrl={person.ImageUrl} />
              <p className="mt-2 line-clamp-2 text-xs font-bold text-white">
                {person.Name}
              </p>
              {person.Role ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-white/45">
                  {person.Role}
                </p>
              ) : null}
            </div>
          ))}
        </MediaShelf>
      ) : null}

      <MotionReveal className={isDesktop ? "pt-6" : "pt-4"}>
        <h2
          className={
            isDesktop
              ? "mb-5 text-2xl font-black text-white"
              : "mb-4 text-lg font-black text-white"
          }
        >
          {labels.about}
        </h2>

        <div
          className={
            isDesktop
              ? "grid grid-cols-[minmax(0,1fr)_15rem] gap-4"
              : "space-y-3"
          }
        >
          <div className="rounded-2xl border border-white/10 bg-white/[0.055] p-5 sm:p-6">
            <p className="font-black text-white">{title}</p>
            {series.Genres?.length ? (
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-white/60">
                {series.Genres.join(", ")}
              </p>
            ) : null}
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">
              {itemDisplayMetadata.overview || t("details.noOverview")}
            </p>
          </div>

          {ratingPercent !== null ? (
            <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.055] p-5 text-center">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-white/40">
                TMDB
              </span>
              <strong className="mt-3 text-4xl font-black text-orange-400">
                {ratingPercent}%
              </strong>
              <span className="mt-3 text-xs font-bold text-white/35">
                Community
              </span>
            </div>
          ) : null}
        </div>

        <div className={isDesktop ? "mt-8" : "mt-6"}>
          <h2
            className={
              isDesktop
                ? "mb-4 text-2xl font-black text-white"
                : "mb-3 text-lg font-black text-white"
            }
          >
            {labels.information}
          </h2>
          <dl
            className={
              isDesktop
                ? "grid max-w-3xl grid-cols-3 gap-x-8 gap-y-5"
                : "grid grid-cols-2 gap-x-5 gap-y-4"
            }
          >
            {studios.length > 0 ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.studio}
                </dt>
                <dd className="mt-1 text-sm text-white/75">
                  {studios.join(", ")}
                </dd>
              </div>
            ) : null}
            {releaseDate ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.release}
                </dt>
                <dd className="mt-1 text-sm text-white/75">{releaseDate}</dd>
              </div>
            ) : null}
            {series.OfficialRating ? (
              <div>
                <dt className="text-xs font-bold text-white/45">
                  {labels.ageRating}
                </dt>
                <dd className="mt-1 text-sm text-white/75">
                  {series.OfficialRating}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </MotionReveal>

      {/* Other titles come last, once this one has been told in full; the
          gap above matches the one between the last shelf and "About". */}
      {similarItems.length > 0 ? (
        <div className={isDesktop ? "mt-6" : "mt-4"}>
          <MediaShelf title={labels.similar} variant={variant}>
            {similarItems.map((item, index) => (
              <div key={item.Id} className="snap-start">
                {isDesktop ? (
                  <MediaCard
                    item={item}
                    to={getRouteForItem(item)}
                    variant="poster"
                    index={index}
                    animateIn
                  />
                ) : (
                  <MobileMediaCard
                    item={item}
                    to={getRouteForItem(item)}
                    variant="poster"
                  />
                )}
              </div>
            ))}
          </MediaShelf>
        </div>
      ) : null}
    </div>
  );
}
