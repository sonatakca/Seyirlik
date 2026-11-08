import type { Language } from "../i18n/translations";
/**
 * Artwork language preference. Kept here because this is now its only consumer:
 * the TMDB artwork admin client it used to live in talked to a backend that the
 * native metadata service replaced.
 */
export type TmdbImageLanguage = "en" | "tr" | null;
import type { MediaItem } from "./types";

const EPISODE_METADATA_STORAGE_KEY = "seyirlik-episode-metadata-overrides";
const STORE_VERSION = 1;

type LocalizedText = Partial<Record<Language, string>>;

export interface EpisodeThumbnailOverride {
  url: string;
  filePath: string | null;
  language: TmdbImageLanguage;
}

export interface EpisodeMetadataOverrideInput {
  episodeId: string;
  seriesId?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  titles?: Partial<Record<Language, string | null>>;
  overviews?: Partial<Record<Language, string | null>>;
  thumbnail?: EpisodeThumbnailOverride | null;
}

interface StoredEpisodeMetadata {
  episodeId: string;
  seriesId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  titles: LocalizedText;
  overviews: LocalizedText;
  thumbnail: EpisodeThumbnailOverride | null;
  updatedAt: string;
}

export interface SeriesEpisodeMetadataPreference {
  thumbnailLanguage: TmdbImageLanguage;
  updatedAt: string;
}

interface EpisodeMetadataStore {
  version: typeof STORE_VERSION;
  episodesById: Record<string, StoredEpisodeMetadata>;
  episodeIdBySeriesKey: Record<string, string>;
  series: Record<string, SeriesEpisodeMetadataPreference>;
}

export interface EpisodeDisplayMetadata {
  title: string | null;
  overview: string | null;
  thumbnailUrl: string | null;
}

function createEmptyStore(): EpisodeMetadataStore {
  return {
    version: STORE_VERSION,
    episodesById: {},
    episodeIdBySeriesKey: {},
    series: {},
  };
}

function getStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function normalizeText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeNumber(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null;
}

function createSeriesEpisodeKey(
  seriesId: string | null | undefined,
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
): string | null {
  if (
    !seriesId ||
    !isFiniteNumber(seasonNumber) ||
    !isFiniteNumber(episodeNumber)
  ) {
    return null;
  }

  return `${seriesId}:${seasonNumber}:${episodeNumber}`;
}

function sanitizeTextMap(value: unknown): Partial<Record<Language, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const map = value as Partial<Record<Language, unknown>>;
  const english = normalizeText(
    typeof map.en === "string" ? map.en : undefined,
  );
  const turkish = normalizeText(
    typeof map.tr === "string" ? map.tr : undefined,
  );

  return {
    ...(english ? { en: english } : {}),
    ...(turkish ? { tr: turkish } : {}),
  };
}

function sanitizeThumbnail(value: unknown): EpisodeThumbnailOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const thumbnail = value as Partial<EpisodeThumbnailOverride>;
  const url = normalizeText(thumbnail.url);

  if (!url) {
    return null;
  }

  return {
    url,
    filePath: normalizeText(thumbnail.filePath) ?? null,
    language:
      thumbnail.language === "en" || thumbnail.language === "tr"
        ? thumbnail.language
        : null,
  };
}

function sanitizeStoredEpisode(value: unknown): StoredEpisodeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const episode = value as Partial<StoredEpisodeMetadata>;
  const episodeId = normalizeText(episode.episodeId);

  if (!episodeId) {
    return null;
  }

  return {
    episodeId,
    seriesId: normalizeText(episode.seriesId) ?? null,
    seasonNumber: normalizeNumber(episode.seasonNumber),
    episodeNumber: normalizeNumber(episode.episodeNumber),
    titles: sanitizeTextMap(episode.titles),
    overviews: sanitizeTextMap(episode.overviews),
    thumbnail: sanitizeThumbnail(episode.thumbnail),
    updatedAt: normalizeText(episode.updatedAt) ?? new Date(0).toISOString(),
  };
}

function readStore(): EpisodeMetadataStore {
  const storage = getStorage();

  if (!storage) {
    return createEmptyStore();
  }

  try {
    const raw = storage.getItem(EPISODE_METADATA_STORAGE_KEY);

    if (!raw) {
      return createEmptyStore();
    }

    const parsed = JSON.parse(raw) as Partial<EpisodeMetadataStore>;
    const store = createEmptyStore();

    if (parsed.version !== STORE_VERSION) {
      return store;
    }

    if (parsed.episodesById && typeof parsed.episodesById === "object") {
      Object.entries(parsed.episodesById).forEach(([episodeId, episode]) => {
        const sanitized = sanitizeStoredEpisode(episode);

        if (sanitized) {
          store.episodesById[episodeId] = sanitized;
        }
      });
    }

    if (
      parsed.episodeIdBySeriesKey &&
      typeof parsed.episodeIdBySeriesKey === "object"
    ) {
      Object.entries(parsed.episodeIdBySeriesKey).forEach(
        ([key, episodeId]) => {
          if (typeof episodeId === "string" && store.episodesById[episodeId]) {
            store.episodeIdBySeriesKey[key] = episodeId;
          }
        },
      );
    }

    if (parsed.series && typeof parsed.series === "object") {
      Object.entries(parsed.series).forEach(([seriesId, preference]) => {
        if (!preference || typeof preference !== "object") {
          return;
        }

        const rawPreference =
          preference as Partial<SeriesEpisodeMetadataPreference>;
        const thumbnailLanguage =
          rawPreference.thumbnailLanguage === "en" ||
          rawPreference.thumbnailLanguage === "tr"
            ? rawPreference.thumbnailLanguage
            : null;

        store.series[seriesId] = {
          thumbnailLanguage,
          updatedAt:
            normalizeText(rawPreference.updatedAt) ?? new Date(0).toISOString(),
        };
      });
    }

    return store;
  } catch {
    return createEmptyStore();
  }
}

function writeStore(store: EpisodeMetadataStore): void {
  const storage = getStorage();

  if (!storage) {
    return;
  }

  storage.setItem(EPISODE_METADATA_STORAGE_KEY, JSON.stringify(store));
}

export function saveEpisodeMetadataOverrides(
  overrides: EpisodeMetadataOverrideInput[],
  options: {
    seriesId?: string | null;
    thumbnailLanguage?: TmdbImageLanguage;
  } = {},
): number {
  const store = readStore();
  const updatedAt = new Date().toISOString();
  let savedCount = 0;

  overrides.forEach((override) => {
    const episodeId = normalizeText(override.episodeId);

    if (!episodeId) {
      return;
    }

    const seriesId =
      normalizeText(override.seriesId) ??
      normalizeText(options.seriesId) ??
      null;
    const seasonNumber = normalizeNumber(override.seasonNumber);
    const episodeNumber = normalizeNumber(override.episodeNumber);
    const current = store.episodesById[episodeId];
    const titles = {
      ...(current?.titles ?? {}),
      ...sanitizeTextMap(override.titles),
    };
    const overviews = {
      ...(current?.overviews ?? {}),
      ...sanitizeTextMap(override.overviews),
    };
    const thumbnail =
      override.thumbnail === undefined
        ? (current?.thumbnail ?? null)
        : sanitizeThumbnail(override.thumbnail);

    store.episodesById[episodeId] = {
      episodeId,
      seriesId,
      seasonNumber,
      episodeNumber,
      titles,
      overviews,
      thumbnail,
      updatedAt,
    };

    const seriesEpisodeKey = createSeriesEpisodeKey(
      seriesId,
      seasonNumber,
      episodeNumber,
    );

    if (seriesEpisodeKey) {
      store.episodeIdBySeriesKey[seriesEpisodeKey] = episodeId;
    }

    savedCount += 1;
  });

  if (options.seriesId) {
    store.series[options.seriesId] = {
      thumbnailLanguage: options.thumbnailLanguage ?? null,
      updatedAt,
    };
  }

  writeStore(store);
  return savedCount;
}

export function getSeriesEpisodeThumbnailLanguage(
  seriesId: string | null | undefined,
): TmdbImageLanguage {
  return (
    getSeriesEpisodeMetadataPreference(seriesId)?.thumbnailLanguage ?? null
  );
}

export function getSeriesEpisodeMetadataPreference(
  seriesId: string | null | undefined,
): SeriesEpisodeMetadataPreference | null {
  if (!seriesId) {
    return null;
  }

  return readStore().series[seriesId] ?? null;
}

function getStoredEpisode(item: MediaItem): StoredEpisodeMetadata | null {
  const store = readStore();
  const directMatch = store.episodesById[item.Id];

  if (directMatch) {
    return directMatch;
  }

  const seriesEpisodeKey = createSeriesEpisodeKey(
    item.SeriesId,
    item.ParentIndexNumber,
    item.IndexNumber,
  );
  const episodeId = seriesEpisodeKey
    ? store.episodeIdBySeriesKey[seriesEpisodeKey]
    : null;

  return episodeId ? (store.episodesById[episodeId] ?? null) : null;
}

export function getEpisodeDisplayMetadata(
  item: MediaItem,
  language: Language,
): EpisodeDisplayMetadata {
  if (item.Type !== "Episode") {
    return {
      title: item.Name || null,
      overview: item.Overview || null,
      thumbnailUrl: null,
    };
  }

  const storedEpisode = getStoredEpisode(item);

  // A choice made on this device first, then the catalogue's translation for
  // the language, then the episode's own title and overview.
  return {
    title:
      storedEpisode?.titles[language] ??
      nonEmpty(item.LocalizedTitles?.[language]) ??
      item.Name ??
      null,
    overview:
      storedEpisode?.overviews[language] ??
      nonEmpty(item.LocalizedOverviews?.[language]) ??
      item.Overview ??
      null,
    thumbnailUrl: storedEpisode?.thumbnail?.url ?? null,
  };
}
