import type { MatchCandidate } from "./matcher";

/**
 * TMDB v3 client.
 *
 * The API key lives only in this process — it is never sent to a browser, never
 * logged, and never appears in an error message. Failures are surfaced as a
 * small typed error so callers can distinguish "not found" from "provider is
 * down" without inspecting strings.
 */

export const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
/** Whose age rating is recorded, in order of preference. */
const CERTIFICATION_COUNTRIES = ["TR", "US", "GB", "DE"];
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const REQUEST_TIMEOUT_MS = 10_000;

export type TmdbErrorKind = "not-found" | "rate-limited" | "unavailable";

export class TmdbError extends Error {
  constructor(
    readonly kind: TmdbErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

export interface TmdbPerson {
  name: string;
  role: "actor" | "director" | "writer" | "producer" | "composer";
  character?: string;
  order: number;
  providerId: string;
  /** TMDB's headshot path (`/abc.jpg`), when TMDB has one. */
  profilePath?: string;
}

export interface TmdbTitleDetails {
  providerId: string;
  title: string;
  originalTitle?: string;
  /** ISO 639-1, as TMDB records it (`en`, `ja`). Absent when TMDB has none. */
  originalLanguage?: string;
  overview?: string;
  tagline?: string;
  releaseDate?: string;
  endDate?: string;
  runtimeMs?: number;
  communityRating?: number;
  officialRating?: string;
  genres: string[];
  people: TmdbPerson[];
  posterPath?: string;
  backdropPaths: string[];
  logoPath?: string;
  imdbId?: string;
  /** A series' seasons as TMDB numbers them. Absent for a film. */
  seasons?: TmdbSeasonSummary[];
  /** The box set a film belongs to, when it belongs to one. */
  collection?: TmdbCollectionRef;
}

export interface TmdbCollectionRef {
  providerId: string;
  name: string;
}

/** A box set's own description and artwork. */
export interface TmdbCollectionDetails extends TmdbCollectionRef {
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
}

export interface TmdbSeasonSummary {
  seasonNumber: number;
  episodeCount: number;
  airDate?: string;
}

export interface TmdbEpisodeDetails {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  airDate?: string;
  runtimeMs?: number;
  communityRating?: number;
  stillPath?: string;
}

/** The three artwork sets TMDB keeps for a title. */
export type TmdbArtworkKind = "poster" | "backdrop" | "logo";

export interface TmdbArtworkCandidate {
  kind: TmdbArtworkKind;
  filePath: string;
  /** ISO 639-1, or null for artwork with no text and therefore no language. */
  language: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  voteAverage: number;
  voteCount: number;
}

export interface TmdbCatalogueTitle {
  providerId: string;
  kind: "movie" | "series";
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
}
export interface TmdbCataloguePage {
  items: TmdbCatalogueTitle[];
  page: number;
  totalPages: number;
}

export interface TmdbClient {
  catalogue?(
    kind: "movie" | "tv",
    query: string,
    page: number,
  ): Promise<TmdbCataloguePage>;
  /** `language` names the titles come back in; the client's own by default. */
  searchMovies(
    title: string,
    year?: number,
    language?: string,
  ): Promise<MatchCandidate[]>;
  searchSeries(
    title: string,
    year?: number,
    language?: string,
  ): Promise<MatchCandidate[]>;
  getMovie(providerId: string, language?: string): Promise<TmdbTitleDetails>;
  getSeries(providerId: string, language?: string): Promise<TmdbTitleDetails>;
  /**
   * Every artwork candidate the provider holds for a title, in every language,
   * for an operator to choose from. The automatic pass takes the provider's
   * first choice; this is what makes disagreeing with it possible.
   */
  listArtwork(
    kind: "movie" | "tv",
    providerId: string,
  ): Promise<TmdbArtworkCandidate[]>;
  getSeasonEpisodes(
    providerId: string,
    seasonNumber: number,
  ): Promise<TmdbEpisodeDetails[]>;
  getCollection?(providerId: string): Promise<TmdbCollectionDetails>;
  /** A person's headshot path, or null when TMDB has none. */
  getPersonProfilePath?(providerId: string): Promise<string | null>;
  /** Absolute artwork URL for a stored provider path. */
  buildImageUrl(imagePath: string, size: string): string;
}

interface TmdbImageEntry {
  file_path?: string;
  iso_639_1?: string | null;
  width?: number;
  height?: number;
  aspect_ratio?: number;
  vote_average?: number;
  vote_count?: number;
}

interface TmdbImagesResponse {
  posters?: TmdbImageEntry[];
  backdrops?: TmdbImageEntry[];
  logos?: TmdbImageEntry[];
}

interface TmdbSearchResponse {
  total_pages?: number;
  results?: Array<{
    id: number;
    title?: string;
    name?: string;
    original_title?: string;
    original_name?: string;
    release_date?: string;
    first_air_date?: string;
    popularity?: number;
    overview?: string;
    poster_path?: string;
  }>;
}

function yearFromDate(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

function minutesToMs(minutes: unknown): number | undefined {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? Math.round(minutes * 60_000)
    : undefined;
}

export interface CreateTmdbClientOptions {
  apiKey: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

/**
 * TMDB has two credential formats and they authenticate differently:
 * a v4 read access token is a JWT sent as a bearer token, while a v3 key is a
 * 32-character hex string that must travel as the `api_key` query parameter.
 * Sending one as the other returns 401 on every request, so the format is
 * detected rather than assumed.
 */
export function isV4ReadAccessToken(apiKey: string): boolean {
  return apiKey.trim().startsWith("eyJ");
}

export function createTmdbClient({
  apiKey,
  language = "en-US",
  fetchImpl = fetch,
}: CreateTmdbClientOptions): TmdbClient {
  if (!apiKey.trim()) {
    throw new Error("SEYIRLIK_TMDB_API_KEY is required for metadata lookups.");
  }

  const usesBearerToken = isV4ReadAccessToken(apiKey);

  async function request<T>(
    endpoint: string,
    params: Record<string, string> = {},
    // `null` omits the parameter entirely, which is how TMDB is asked for every
    // language at once rather than one filtered set.
    languageOverride: string | null | undefined = undefined,
  ): Promise<T> {
    const url = new URL(`${TMDB_API_BASE_URL}${endpoint}`);
    const requestLanguage =
      languageOverride === undefined ? language : languageOverride;
    if (requestLanguage !== null) {
      url.searchParams.set("language", requestLanguage);
    }
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (!usesBearerToken) {
      url.searchParams.set("api_key", apiKey);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          // A v4 token travels as a header so it cannot leak through a proxy
          // access log; a v3 key has no such option and rides in the query.
          ...(usesBearerToken ? { Authorization: `Bearer ${apiKey}` } : {}),
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        throw new TmdbError("not-found", "The provider has no such record.");
      }
      if (response.status === 429) {
        throw new TmdbError("rate-limited", "The provider is rate limiting.");
      }
      if (!response.ok) {
        throw new TmdbError("unavailable", "The provider request failed.");
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TmdbError) throw error;
      // Deliberately does not include the URL: with a v3 key the query string
      // carries the credential.
      throw new TmdbError("unavailable", "The provider could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }

  function toCandidates(
    response: TmdbSearchResponse,
    kind: "movie" | "tv",
  ): MatchCandidate[] {
    return (response.results ?? []).slice(0, 10).map((result) => {
      const title = (kind === "movie" ? result.title : result.name) ?? "";
      const originalTitle =
        kind === "movie" ? result.original_title : result.original_name;
      const year = yearFromDate(
        kind === "movie" ? result.release_date : result.first_air_date,
      );

      return {
        providerId: String(result.id),
        title,
        ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
        ...(year === undefined ? {} : { year }),
        ...(result.popularity === undefined
          ? {}
          : { popularity: result.popularity }),
      };
    });
  }

  function extractPeople(credits: unknown): TmdbPerson[] {
    const people: TmdbPerson[] = [];
    if (!credits || typeof credits !== "object") return people;

    const typed = credits as {
      cast?: Array<{
        id: number;
        name: string;
        character?: string;
        order?: number;
        profile_path?: string | null;
      }>;
      crew?: Array<{
        id: number;
        name: string;
        job?: string;
        profile_path?: string | null;
      }>;
    };

    // Cast is capped: a full crew list of hundreds of names is noise on a detail
    // page and a great deal of write amplification on every refresh.
    for (const [index, member] of (typed.cast ?? []).slice(0, 20).entries()) {
      people.push({
        providerId: String(member.id),
        name: member.name,
        role: "actor",
        ...(member.character ? { character: member.character } : {}),
        order: member.order ?? index,
        ...(member.profile_path ? { profilePath: member.profile_path } : {}),
      });
    }

    const crewRoles: Record<string, TmdbPerson["role"]> = {
      Director: "director",
      Writer: "writer",
      Screenplay: "writer",
      Producer: "producer",
      "Original Music Composer": "composer",
    };
    for (const member of typed.crew ?? []) {
      const role = member.job ? crewRoles[member.job] : undefined;
      if (!role) continue;
      people.push({
        providerId: String(member.id),
        name: member.name,
        role,
        order: 100,
        ...(member.profile_path ? { profilePath: member.profile_path } : {}),
      });
    }

    return people;
  }

  function toArtworkCandidates(
    images: TmdbImageEntry[] | undefined,
    kind: TmdbArtworkKind,
  ): TmdbArtworkCandidate[] {
    return (images ?? [])
      .filter((image) => typeof image.file_path === "string")
      .map((image) => ({
        kind,
        filePath: image.file_path as string,
        // TMDB writes an empty string for language-neutral artwork; that is a
        // meaningful category, not a missing value.
        language: image.iso_639_1 ? image.iso_639_1 : null,
        width: typeof image.width === "number" ? image.width : null,
        height: typeof image.height === "number" ? image.height : null,
        aspectRatio:
          typeof image.aspect_ratio === "number" ? image.aspect_ratio : null,
        voteAverage:
          typeof image.vote_average === "number" ? image.vote_average : 0,
        voteCount: typeof image.vote_count === "number" ? image.vote_count : 0,
      }))
      .sort(
        (left, right) =>
          right.voteAverage - left.voteAverage ||
          right.voteCount - left.voteCount,
      );
  }

  function extractLogoPath(images: unknown): string | undefined {
    if (!images || typeof images !== "object") return undefined;
    const logos = (images as { logos?: Array<{ file_path?: string }> }).logos;
    return logos?.[0]?.file_path;
  }

  function extractBackdropPaths(images: unknown, fallback?: string): string[] {
    const paths: string[] = [];
    if (images && typeof images === "object") {
      const backdrops = (
        images as { backdrops?: Array<{ file_path?: string }> }
      ).backdrops;
      for (const backdrop of (backdrops ?? []).slice(0, 5)) {
        if (backdrop.file_path) paths.push(backdrop.file_path);
      }
    }
    if (paths.length === 0 && fallback) paths.push(fallback);
    return paths;
  }

  /** A movie states its IMDb id directly; a series only does under `external_ids`. */
  function readImdbId(details: Record<string, unknown>): string | undefined {
    if (typeof details.imdb_id === "string" && details.imdb_id) {
      return details.imdb_id;
    }
    const external = details.external_ids;
    if (external && typeof external === "object") {
      const value = (external as Record<string, unknown>).imdb_id;
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  }

  function readSeasons(value: unknown[]): TmdbSeasonSummary[] {
    return value
      .filter(
        (season): season is Record<string, unknown> =>
          !!season &&
          typeof season === "object" &&
          typeof (season as Record<string, unknown>).season_number === "number",
      )
      .map((season) => ({
        seasonNumber: season.season_number as number,
        episodeCount:
          typeof season.episode_count === "number" ? season.episode_count : 0,
        ...(typeof season.air_date === "string" && season.air_date
          ? { airDate: season.air_date }
          : {}),
      }));
  }

  async function getTitle(
    kind: "movie" | "tv",
    providerId: string,
    languageOverride?: string,
  ): Promise<TmdbTitleDetails> {
    const effectiveLanguage = languageOverride ?? language;
    const details = await request<Record<string, unknown>>(
      `/${kind}/${encodeURIComponent(providerId)}`,
      {
        /*
         * `external_ids` is only needed for series. A movie carries `imdb_id`
         * on its own details; a series does not, and without it every show
         * ends up with a TMDB id and no IMDb one — which is invisible until
         * something tries to match on the identity another application
         * recorded.
         */
        append_to_response:
          "credits,images,release_dates,content_ratings,external_ids",
        // Language-neutral artwork is included so a logo exists even when the
        // localized set is empty.
        include_image_language: `${effectiveLanguage.slice(0, 2)},en,null`,
      },
      effectiveLanguage,
    );

    const title = (kind === "movie" ? details.title : details.name) ?? "";
    const originalTitle =
      kind === "movie" ? details.original_title : details.original_name;
    const releaseDate =
      kind === "movie" ? details.release_date : details.first_air_date;

    const runtimeMs =
      kind === "movie"
        ? minutesToMs(details.runtime)
        : minutesToMs(
            Array.isArray(details.episode_run_time)
              ? (details.episode_run_time as number[])[0]
              : undefined,
          );

    return {
      providerId,
      title: String(title),
      ...(typeof originalTitle === "string" && originalTitle !== title
        ? { originalTitle }
        : {}),
      // `xx` is TMDB's "no language", which says nothing about the audio.
      ...(typeof details.original_language === "string" &&
      details.original_language &&
      details.original_language !== "xx"
        ? { originalLanguage: details.original_language }
        : {}),
      ...(typeof details.overview === "string" && details.overview
        ? { overview: details.overview }
        : {}),
      ...(typeof details.tagline === "string" && details.tagline
        ? { tagline: details.tagline }
        : {}),
      ...(typeof releaseDate === "string" && releaseDate
        ? { releaseDate }
        : {}),
      ...(typeof details.last_air_date === "string" && details.last_air_date
        ? { endDate: details.last_air_date }
        : {}),
      ...(runtimeMs === undefined ? {} : { runtimeMs }),
      ...(typeof details.vote_average === "number" && details.vote_average > 0
        ? { communityRating: details.vote_average }
        : {}),
      genres: Array.isArray(details.genres)
        ? (details.genres as Array<{ name?: string }>)
            .map((genre) => genre.name)
            .filter((name): name is string => typeof name === "string")
        : [],
      people: extractPeople(details.credits),
      ...(typeof details.poster_path === "string"
        ? { posterPath: details.poster_path }
        : {}),
      backdropPaths: extractBackdropPaths(
        details.images,
        typeof details.backdrop_path === "string"
          ? details.backdrop_path
          : undefined,
      ),
      ...(extractLogoPath(details.images)
        ? { logoPath: extractLogoPath(details.images) as string }
        : {}),
      ...(readImdbId(details) ? { imdbId: readImdbId(details) as string } : {}),
      ...(kind === "tv" && Array.isArray(details.seasons)
        ? { seasons: readSeasons(details.seasons) }
        : {}),
      ...(kind === "movie" ? readCollectionRef(details) : {}),
      ...(readCertification(kind, details)
        ? { officialRating: readCertification(kind, details) as string }
        : {}),
    };
  }

  /**
   * The age rating to record, from the country list below.
   *
   * Turkish first because this is a Turkish household's library and its
   * boards rate differently; then the two English-language boards whose
   * ratings are everywhere; then whatever else TMDB has.
   */
  function readCertification(
    kind: "movie" | "tv",
    details: Record<string, unknown>,
  ): string | undefined {
    const byCountry = new Map<string, string>();
    if (kind === "movie") {
      const results = (
        details.release_dates as { results?: unknown } | undefined
      )?.results;
      if (Array.isArray(results)) {
        for (const entry of results as Array<Record<string, unknown>>) {
          const country = entry.iso_3166_1;
          const dates = entry.release_dates;
          if (typeof country !== "string" || !Array.isArray(dates)) continue;
          // Theatrical first, then any release that carries a rating at all.
          const ordered = [...(dates as Array<Record<string, unknown>>)].sort(
            (a, b) => (a.type === 3 ? -1 : 0) - (b.type === 3 ? -1 : 0),
          );
          const rated = ordered.find(
            (date) =>
              typeof date.certification === "string" &&
              date.certification.trim(),
          );
          if (rated) byCountry.set(country, String(rated.certification).trim());
        }
      }
    } else {
      const results = (
        details.content_ratings as { results?: unknown } | undefined
      )?.results;
      if (Array.isArray(results)) {
        for (const entry of results as Array<Record<string, unknown>>) {
          if (
            typeof entry.iso_3166_1 === "string" &&
            typeof entry.rating === "string" &&
            entry.rating.trim()
          ) {
            byCountry.set(entry.iso_3166_1, entry.rating.trim());
          }
        }
      }
    }
    for (const country of CERTIFICATION_COUNTRIES) {
      const rating = byCountry.get(country);
      if (rating) return rating.slice(0, 32);
    }
    const [first] = byCountry.values();
    return first?.slice(0, 32);
  }

  function readCollectionRef(details: Record<string, unknown>): {
    collection?: TmdbCollectionRef;
  } {
    const value = details.belongs_to_collection;
    if (!value || typeof value !== "object") return {};
    const collection = value as Record<string, unknown>;
    return typeof collection.id === "number" &&
      typeof collection.name === "string" &&
      collection.name.trim()
      ? {
          collection: {
            providerId: String(collection.id),
            name: collection.name.trim(),
          },
        }
      : {};
  }

  return {
    catalogue: async (kind, query, page) => {
      const response = await request<TmdbSearchResponse>(
        query ? `/search/${kind}` : `/${kind}/popular`,
        { page: String(page), ...(query ? { query } : {}) },
      );
      return {
        page,
        totalPages: Math.min(500, response.total_pages ?? 1),
        items: (response.results ?? []).map((row) => ({
          providerId: String(row.id),
          kind: kind === "movie" ? "movie" : "series",
          title: (kind === "movie" ? row.title : row.name) ?? "",
          year: yearFromDate(
            kind === "movie" ? row.release_date : row.first_air_date,
          ),
          overview: row.overview,
          posterUrl:
            row.poster_path &&
            /^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(row.poster_path)
              ? `${TMDB_IMAGE_BASE_URL}/w185${row.poster_path}`
              : undefined,
        })),
      };
    },
    searchMovies: async (title, year, searchLanguage) =>
      toCandidates(
        await request<TmdbSearchResponse>(
          "/search/movie",
          {
            query: title,
            ...(year === undefined ? {} : { year: String(year) }),
          },
          searchLanguage,
        ),
        "movie",
      ),

    searchSeries: async (title, year, searchLanguage) =>
      toCandidates(
        await request<TmdbSearchResponse>(
          "/search/tv",
          {
            query: title,
            ...(year === undefined
              ? {}
              : { first_air_date_year: String(year) }),
          },
          searchLanguage,
        ),
        "tv",
      ),

    getMovie: (providerId, titleLanguage) =>
      getTitle("movie", providerId, titleLanguage),
    getSeries: (providerId, titleLanguage) =>
      getTitle("tv", providerId, titleLanguage),

    listArtwork: async (kind, providerId) => {
      // No `language` at all: the point of the picker is to show the Turkish
      // poster next to the English one, so filtering here would defeat it.
      const images = await request<TmdbImagesResponse>(
        `/${kind}/${encodeURIComponent(providerId)}/images`,
        {},
        null,
      );

      return [
        ...toArtworkCandidates(images.posters, "poster"),
        ...toArtworkCandidates(images.backdrops, "backdrop"),
        ...toArtworkCandidates(images.logos, "logo"),
      ];
    },

    getCollection: async (providerId) => {
      const details = await request<Record<string, unknown>>(
        `/collection/${encodeURIComponent(providerId)}`,
      );
      const name =
        typeof details.name === "string" && details.name.trim()
          ? details.name.trim()
          : providerId;
      return {
        providerId,
        name,
        ...(typeof details.overview === "string" && details.overview
          ? { overview: details.overview }
          : {}),
        ...(typeof details.poster_path === "string"
          ? { posterPath: details.poster_path }
          : {}),
        ...(typeof details.backdrop_path === "string"
          ? { backdropPath: details.backdrop_path }
          : {}),
      };
    },

    getPersonProfilePath: async (providerId) => {
      const person = await request<{ profile_path?: string | null }>(
        `/person/${encodeURIComponent(providerId)}`,
      );
      return typeof person.profile_path === "string" && person.profile_path
        ? person.profile_path
        : null;
    },

    getSeasonEpisodes: async (providerId, seasonNumber) => {
      const season = await request<{
        episodes?: Array<{
          season_number?: number;
          episode_number?: number;
          name?: string;
          overview?: string;
          air_date?: string;
          runtime?: number;
          vote_average?: number;
          still_path?: string;
        }>;
      }>(`/tv/${encodeURIComponent(providerId)}/season/${seasonNumber}`);

      return (season.episodes ?? [])
        .filter(
          (episode) =>
            typeof episode.episode_number === "number" &&
            typeof episode.season_number === "number",
        )
        .map((episode) => ({
          seasonNumber: episode.season_number as number,
          episodeNumber: episode.episode_number as number,
          ...(episode.name ? { title: episode.name } : {}),
          ...(episode.overview ? { overview: episode.overview } : {}),
          ...(episode.air_date ? { airDate: episode.air_date } : {}),
          ...(minutesToMs(episode.runtime) === undefined
            ? {}
            : { runtimeMs: minutesToMs(episode.runtime) as number }),
          ...(typeof episode.vote_average === "number" &&
          episode.vote_average > 0
            ? { communityRating: episode.vote_average }
            : {}),
          ...(episode.still_path ? { stillPath: episode.still_path } : {}),
        }));
    },

    buildImageUrl: (imagePath, size) =>
      `${TMDB_IMAGE_BASE_URL}/${size}${imagePath}`,
  };
}
