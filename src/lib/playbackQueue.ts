import {
  getAllBoxSetItems,
  getAllMovieItems,
  getAllSeriesEpisodes,
  getBoxSetItems,
} from "./mediaApi";
import { sortCollectionItemsForWatching } from "./collectionUtils";
import { sharesFile } from "./fileParts";
import type { MediaItem } from "./types";

export interface PlaybackQueueSeason {
  id: string;
  name?: string;
  seasonNumber: number | null;
  episodes: MediaItem[];
}

export interface PlaybackQueue {
  kind: "series" | "collection";
  currentItemId: string;
  title?: string;
  items: MediaItem[];
  seasons?: PlaybackQueueSeason[];
  currentSeasonId?: string;
  nextItem: MediaItem | null;
}

function getTmdbCollectionIds(item: MediaItem): string[] {
  const providerIds = item.ProviderIds ?? {};

  return Object.entries(providerIds)
    .filter(([key, value]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        Boolean(value?.trim()) &&
        normalizedKey.includes("tmdb") &&
        normalizedKey.includes("collection")
      );
    })
    .map(([, value]) => value.trim())
    .filter(Boolean);
}

function parseDateTime(value?: string): number | null {
  if (!value) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function getSortNumber(item: MediaItem): number {
  return typeof item.IndexNumber === "number" &&
    Number.isFinite(item.IndexNumber)
    ? item.IndexNumber
    : Number.POSITIVE_INFINITY;
}

function getSeasonSortNumber(item: MediaItem): number {
  return typeof item.ParentIndexNumber === "number" &&
    Number.isFinite(item.ParentIndexNumber)
    ? item.ParentIndexNumber
    : Number.POSITIVE_INFINITY;
}

function compareEpisodeOrder(left: MediaItem, right: MediaItem): number {
  const seasonCompare = getSeasonSortNumber(left) - getSeasonSortNumber(right);

  if (seasonCompare !== 0) {
    return seasonCompare;
  }

  const episodeCompare = getSortNumber(left) - getSortNumber(right);

  if (episodeCompare !== 0) {
    return episodeCompare;
  }

  const dateCompare =
    (parseDateTime(left.PremiereDate) ?? Number.POSITIVE_INFINITY) -
    (parseDateTime(right.PremiereDate) ?? Number.POSITIVE_INFINITY);

  if (Number.isFinite(dateCompare) && dateCompare !== 0) {
    return dateCompare;
  }

  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
}

function getSeasonGroupId(item: MediaItem): string {
  return (
    item.SeasonId ??
    item.ParentId ??
    (typeof item.ParentIndexNumber === "number"
      ? `season:${item.ParentIndexNumber}`
      : "season:unknown")
  );
}

function getNextItem(
  items: MediaItem[],
  currentItemId: string,
  isPlayingAlready: (item: MediaItem) => boolean = () => false,
): MediaItem | null {
  const currentIndex = items.findIndex((item) => item.Id === currentItemId);

  if (currentIndex < 0) {
    return null;
  }

  return (
    items
      .slice(currentIndex + 1)
      .find((item) => !isPlayingAlready(item)) ?? null
  );
}

function buildSeriesSeasons(episodes: MediaItem[]): PlaybackQueueSeason[] {
  const seasonsById = new Map<string, PlaybackQueueSeason>();

  episodes.forEach((episode) => {
    const seasonId = getSeasonGroupId(episode);
    const existingSeason = seasonsById.get(seasonId);

    if (existingSeason) {
      existingSeason.episodes.push(episode);
      return;
    }

    seasonsById.set(seasonId, {
      id: seasonId,
      name: episode.SeasonName,
      seasonNumber:
        typeof episode.ParentIndexNumber === "number"
          ? episode.ParentIndexNumber
          : null,
      episodes: [episode],
    });
  });

  return Array.from(seasonsById.values())
    .map((season) => ({
      ...season,
      episodes: [...season.episodes].sort(compareEpisodeOrder),
    }))
    .sort((left, right) => {
      if (left.seasonNumber !== null && right.seasonNumber !== null) {
        return left.seasonNumber - right.seasonNumber;
      }

      if (left.seasonNumber !== null) {
        return -1;
      }

      if (right.seasonNumber !== null) {
        return 1;
      }

      return (left.name ?? left.id).localeCompare(right.name ?? right.id);
    });
}

async function getSeriesPlaybackQueue(
  currentEpisode: MediaItem,
): Promise<PlaybackQueue | null> {
  if (!currentEpisode.SeriesId) {
    return null;
  }

  const episodes = await getAllSeriesEpisodes(currentEpisode.SeriesId);
  const orderedEpisodes = episodes
    .filter((episode) => episode.Type === "Episode")
    .sort(compareEpisodeOrder);

  if (orderedEpisodes.length <= 1) {
    return null;
  }

  const currentEpisodeFromList =
    orderedEpisodes.find((episode) => episode.Id === currentEpisode.Id) ??
    currentEpisode;
  const seasons = buildSeriesSeasons(orderedEpisodes);

  return {
    kind: "series",
    currentItemId: currentEpisode.Id,
    currentSeasonId: getSeasonGroupId(currentEpisodeFromList),
    title: currentEpisode.SeriesName,
    items: orderedEpisodes,
    seasons,
    // The stories after this one in the same half-hour have already played
    // by the time the file ends; next is the first one after them.
    nextItem: getNextItem(orderedEpisodes, currentEpisode.Id, (episode) =>
      sharesFile(currentEpisode, episode),
    ),
  };
}

function buildMoviePlaybackQueue(
  movie: MediaItem,
  collectionItems: MediaItem[],
): PlaybackQueue | null {
  const orderedMovies = sortCollectionItemsForWatching(
    collectionItems.filter((item) => item.Type === "Movie"),
  );

  if (
    orderedMovies.length <= 1 ||
    !orderedMovies.some((item) => item.Id === movie.Id)
  ) {
    return null;
  }

  return {
    kind: "collection",
    currentItemId: movie.Id,
    title: movie.Name,
    items: orderedMovies,
    nextItem: getNextItem(orderedMovies, movie.Id),
  };
}

async function getMovieQueueFromTmdbCollection(
  movie: MediaItem,
): Promise<PlaybackQueue | null> {
  const tmdbCollectionIds = getTmdbCollectionIds(movie);

  if (tmdbCollectionIds.length === 0) {
    return null;
  }

  const movieItems = await getAllMovieItems().catch(() => []);
  const collectionItems = movieItems.filter((candidate) => {
    const candidateCollectionIds = getTmdbCollectionIds(candidate);
    return tmdbCollectionIds.some((collectionId) =>
      candidateCollectionIds.includes(collectionId),
    );
  });

  return buildMoviePlaybackQueue(movie, collectionItems);
}

async function getMovieQueueFromBoxSet(
  movie: MediaItem,
): Promise<PlaybackQueue | null> {
  const boxSets = await getAllBoxSetItems().catch(() => []);

  for (const boxSet of boxSets) {
    const collectionItems = await getBoxSetItems(boxSet.Id).catch(() => []);

    if (!collectionItems.some((item) => item.Id === movie.Id)) {
      continue;
    }

    const queue = buildMoviePlaybackQueue(movie, collectionItems);

    if (queue) {
      return {
        ...queue,
        title: boxSet.Name,
      };
    }
  }

  return null;
}

export async function getPlaybackQueue(
  item: MediaItem,
): Promise<PlaybackQueue | null> {
  if (item.Type === "Episode") {
    return getSeriesPlaybackQueue(item);
  }

  if (item.Type === "Movie") {
    return (
      (await getMovieQueueFromTmdbCollection(item)) ??
      (await getMovieQueueFromBoxSet(item))
    );
  }

  return null;
}
