/**
 * The administrator's view of the library: every movie and show the catalogue
 * holds, whether or not there is anything to play yet.
 *
 * Browse pages hide a title with no source (`mediaAvailableSql`); this is the
 * one place that deliberately does not, because a wanted film and a film that
 * is downloading are exactly what an administrator comes here to see.
 *
 * A title's "family" is itself and its seasons and episodes, so a show is
 * described by what its episodes hold. Aliases are code-owned SQL identifiers.
 */
import type { DatabaseExecutor } from "../database/databaseTypes";
import type { TmdbClient } from "../metadata/tmdbClient";
import {
  resolveEpisodeMonitoring,
  type MonitoringChoice,
} from "../releases/monitoring";
import { normalizeLanguage } from "../../../renditions/processing/languages";
import type { ProcessingPackageState } from "../processing/packageIndex";
import { importUnderWaySql } from "../imports/importLanding";
import { MEDIA_STATUS_SQL, mediaAvailableSql } from "./mediaAvailability";

export type LibraryTitleKind = "movie" | "series" | "book";

/** What a title or episode holds, summarised for one row. */
export interface HoldingFacts {
  status: string;
  hasMedia: boolean;
  downloading: number;
  importing: number;
  processing: number;
  sizeBytes: number;
  resolution: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  /** Subtitle languages Seyirlik is still looking for. */
  pendingSubtitles: string[];
  /** Playable titles (a film, or each episode) on disk, and how many have trickplay sheets. */
  files: number;
  trickplayFiles: number;
  /** Playable titles whose trickplay is queued or being generated. */
  pendingTrickplay: number;
}

export interface LibraryTitle extends HoldingFacts {
  id: string;
  kind: LibraryTitleKind;
  title: string;
  year: number | null;
  desired: boolean;
  tmdbId: string | null;
  imdbId: string | null;
  episodeCount: number;
  availableEpisodeCount: number;
  artwork: TitleArtwork;
}

/** What a poster needs: the cover and logo as stored, and where the logo sits. */
export interface TitleArtwork {
  coverTag: string | null;
  logoTag: string | null;
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  /** No cover, or a stored cover whose file is gone; TMDB can fill it in. */
  missing: boolean;
}

export interface LibraryEpisode extends HoldingFacts {
  id: string | null;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  mediaFileId: string | null;
  fileName: string | null;
  /** Whether a missing episode is wanted, and which level decided that. */
  monitored: boolean;
  /** Whether the catalogue holds the episode's own still. */
  hasThumb: boolean;
  /** TMDB's still, for an episode the catalogue has none for. */
  stillUrl: string | null;
}

export interface LibrarySeason {
  /** The season's own catalogue row, when the scanner made one. */
  id: string | null;
  seasonNumber: number;
  episodes: LibraryEpisode[];
}

export interface LibraryTitleDetail extends LibraryTitle {
  mediaFileId: string | null;
  fileName: string | null;
  seasons: LibrarySeason[];
  /** False when TMDB could not be asked, so only what is on disk is listed. */
  catalogueComplete: boolean;
}

const FAMILY = (alias: string) =>
  `(fam.id = ${alias}.id OR fam.series_id = ${alias}.id OR fam.parent_id = ${alias}.id)`;

/** Facts about one item's family. `item` must be the row alias in scope. */
const HOLDING_COLUMNS = `
  ${MEDIA_STATUS_SQL} AS status,
  ${mediaAvailableSql()} AS "hasMedia",
  (SELECT count(*)::int FROM acquisitions a JOIN items fam ON fam.id = a.target_item_id
    WHERE ${FAMILY("item")} AND a.state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed')) AS downloading,
  (SELECT count(*)::int FROM imports imp JOIN items fam ON fam.id = imp.target_item_id
    WHERE ${FAMILY("item")} AND ${importUnderWaySql("imp")}) AS importing,
  (SELECT count(*)::int FROM processing_jobs p JOIN items fam ON fam.id = p.item_id
    WHERE ${FAMILY("item")} AND p.state IN ('running', 'queued', 'pending', 'paused')) AS processing,
  (SELECT COALESCE(sum(f.size_bytes), 0)::bigint FROM media_files f JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND f.missing_since IS NULL) AS "sizeBytes",
  -- The resolution class, read from the width: a scope film at 3840x1608 is
  -- 2160p, not "1608p".
  (SELECT CASE WHEN max(s.width) >= 3200 THEN 2160 WHEN max(s.width) >= 1800 THEN 1080
      WHEN max(s.width) >= 1200 THEN 720 WHEN max(s.width) >= 960 THEN 576 ELSE max(s.height) END
    FROM media_streams s JOIN media_files f ON f.id = s.media_file_id JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND f.missing_since IS NULL AND s.kind = 'video') AS resolution,
  ARRAY(SELECT DISTINCT COALESCE(NULLIF(s.language, ''), 'und') FROM media_streams s JOIN media_files f ON f.id = s.media_file_id
    JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND f.missing_since IS NULL AND s.kind = 'audio' ORDER BY 1) AS "audioLanguages",
  ARRAY(SELECT DISTINCT language FROM (
      SELECT COALESCE(NULLIF(s.language, ''), 'und') AS language FROM media_streams s JOIN media_files f ON f.id = s.media_file_id
        JOIN items fam ON fam.id = f.item_id
        WHERE ${FAMILY("item")} AND f.missing_since IS NULL AND s.kind = 'subtitle'
      UNION
      SELECT si.language FROM subtitle_installations si JOIN media_files f ON f.id = si.media_file_id
        JOIN items fam ON fam.id = f.item_id
        WHERE ${FAMILY("item")} AND f.missing_since IS NULL
    ) languages ORDER BY 1) AS "subtitleLanguages",
  -- Counted per playable title, not per file: trickplay is generated for a
  -- title, and an episode kept in two containers is still one episode.
  (SELECT count(DISTINCT fam.id)::int FROM media_files f JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND fam.kind IN ('movie', 'episode') AND f.missing_since IS NULL AND f.size_bytes > 0) AS files,
  (SELECT count(DISTINCT fam.id)::int FROM media_files f JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND fam.kind IN ('movie', 'episode') AND f.missing_since IS NULL AND f.size_bytes > 0
      AND EXISTS (SELECT 1 FROM trickplay_sets ts WHERE ts.media_file_id = f.id)) AS "trickplayFiles",
  ARRAY(SELECT DISTINCT w.language FROM subtitle_wants w JOIN media_files f ON f.id = w.media_file_id
    JOIN items fam ON fam.id = f.item_id
    WHERE ${FAMILY("item")} AND w.active ORDER BY 1) AS "pendingSubtitles",
  -- A title's trickplay job is keyed by the title, so a queued or running one
  -- is found by its dedupe key alone.
  (SELECT count(*)::int FROM items fam
    WHERE ${FAMILY("item")} AND fam.kind IN ('movie', 'episode')
      AND EXISTS (SELECT 1 FROM jobs tj WHERE tj.dedupe_key = 'trickplay.generate:' || fam.id::text
        AND tj.status IN ('queued', 'running'))) AS "pendingTrickplay"`;

type HoldingRow = Omit<HoldingFacts, "sizeBytes"> & {
  sizeBytes: string | number;
};

/**
 * One code per language. Probes and sidecars write `tr` and `tur`, `en` and
 * `eng` for the same thing; a row that listed both would look like two tracks.
 */
function languageSet(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => normalizeLanguage(code)))].sort();
}

function holding(row: HoldingRow): HoldingFacts {
  return {
    status: row.status,
    hasMedia: row.hasMedia,
    downloading: row.downloading,
    importing: row.importing,
    processing: row.processing,
    sizeBytes: Number(row.sizeBytes),
    resolution: row.resolution === null ? null : Number(row.resolution),
    audioLanguages: languageSet(row.audioLanguages),
    subtitleLanguages: languageSet(row.subtitleLanguages),
    pendingSubtitles: languageSet(row.pendingSubtitles),
    files: row.files,
    trickplayFiles: row.trickplayFiles,
    pendingTrickplay: row.pendingTrickplay,
  };
}

/** Nothing held, nothing moving: a TMDB episode the disk has never seen. */
const NOTHING_HELD = (status: string): HoldingFacts => ({
  status,
  hasMedia: false,
  downloading: 0,
  importing: 0,
  processing: 0,
  sizeBytes: 0,
  resolution: null,
  audioLanguages: [],
  subtitleLanguages: [],
  pendingSubtitles: [],
  files: 0,
  trickplayFiles: 0,
  pendingTrickplay: 0,
});

type TitleRow = HoldingRow & {
  coverTag: string | null;
  coverKey: string | null;
  logoTag: string | null;
  logo_offset_x: number | null;
  logo_offset_y: number | null;
  logo_width: number | null;
  logo_shadow: number | null;
  id: string;
  kind: LibraryTitleKind;
  title: string;
  year: number | null;
  desired: boolean;
  tmdbId: string | null;
  imdbId: string | null;
  episodeCount: number;
  availableEpisodeCount: number;
};

const TITLE_SELECT = `SELECT item.id, item.kind, item.title, item.production_year AS year, item.desired,
    item.provider_ids->>'tmdb' AS "tmdbId", item.provider_ids->>'imdb' AS "imdbId",
    (SELECT count(*)::int FROM items e WHERE e.series_id = item.id AND e.kind = 'episode') AS "episodeCount",
    (SELECT count(*)::int FROM items e WHERE e.series_id = item.id AND e.kind = 'episode'
      AND ${mediaAvailableSql("e")}) AS "availableEpisodeCount",
    (SELECT im.content_hash FROM item_images im WHERE im.item_id = item.id AND im.image_type = 'cover' AND im.image_index = 0) AS "coverTag",
    (SELECT im.storage_key FROM item_images im WHERE im.item_id = item.id AND im.image_type = 'cover' AND im.image_index = 0) AS "coverKey",
    (SELECT im.content_hash FROM item_images im WHERE im.item_id = item.id AND im.image_type = 'logo' AND im.image_index = 0) AS "logoTag",
    item.logo_offset_x, item.logo_offset_y, item.logo_width, item.logo_shadow,
    ${HOLDING_COLUMNS}
  FROM items item`;

function toTitle(row: TitleRow, coverPresent: boolean): LibraryTitle {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    year: row.year,
    desired: row.desired,
    tmdbId: row.tmdbId,
    imdbId: row.imdbId,
    episodeCount: row.episodeCount,
    availableEpisodeCount: row.availableEpisodeCount,
    artwork: {
      coverTag: coverPresent ? row.coverTag : null,
      logoTag: row.logoTag,
      logoLayout:
        row.logo_offset_x === null ||
        row.logo_offset_y === null ||
        row.logo_width === null ||
        row.logo_shadow === null
          ? null
          : {
              x: row.logo_offset_x,
              y: row.logo_offset_y,
              width: row.logo_width,
              shadow: row.logo_shadow,
            },
      missing: !coverPresent,
    },
    ...holding(row),
  };
}

export function createLibraryAdminRepository(
  db: DatabaseExecutor,
  options: {
    /**
     * Whether a stored image can still be drawn: its file, or a cached
     * variant of it. Generated storage is rebuilt rather than backed up, so a
     * row can outlive both — which reads as a title with no poster.
     */
    artworkExists?: (image: {
      storageKey: string;
      contentHash: string;
    }) => Promise<boolean>;
  } = {},
) {
  const present = async (row: TitleRow) =>
    row.coverKey !== null &&
    row.coverTag !== null &&
    (options.artworkExists
      ? await options.artworkExists({
          storageKey: row.coverKey,
          contentHash: row.coverTag,
        })
      : true);
  const toTitles = (rows: TitleRow[]) =>
    Promise.all(rows.map(async (row) => toTitle(row, await present(row))));

  return {
    async listTitles(kind: LibraryTitleKind): Promise<LibraryTitle[]> {
      const result = await db.query<TitleRow>(
        `${TITLE_SELECT} WHERE item.kind = $1 ORDER BY item.sort_title, item.id`,
        [kind],
      );
      return toTitles(result.rows);
    },

    async getTitle(itemId: string): Promise<LibraryTitle | null> {
      const result = await db.query<TitleRow>(
        `${TITLE_SELECT} WHERE item.id = $1 AND item.kind IN ('movie', 'series', 'book')`,
        [itemId],
      );
      return result.rows[0] ? (await toTitles(result.rows))[0]! : null;
    },

    /** Films and shows matched to TMDB whose cover is missing or unreadable. */
    async titlesMissingArtwork(): Promise<string[]> {
      const result = await db.query<TitleRow>(
        `${TITLE_SELECT} WHERE item.kind IN ('movie', 'series') AND item.provider_ids ? 'tmdb'`,
      );
      // A show whose episodes on disk have no stills: its refresh imports them.
      const stills = await db.query<{ id: string }>(
        `SELECT DISTINCT series.id FROM items series
         JOIN items episode ON episode.series_id = series.id AND episode.kind = 'episode'
         WHERE series.kind = 'series' AND series.provider_ids ? 'tmdb'
           AND EXISTS (SELECT 1 FROM media_files f WHERE f.item_id = episode.id AND f.missing_since IS NULL)
           AND NOT EXISTS (SELECT 1 FROM item_images thumb WHERE thumb.item_id = episode.id AND thumb.image_type = 'thumb')`,
      );
      return [
        ...new Set([
          ...(await toTitles(result.rows))
            .filter((title) => title.artwork.missing)
            .map((title) => title.id),
          ...stills.rows.map((row) => row.id),
        ]),
      ];
    },

    /** The file a subtitle or a detail line is about: the largest live one. */
    async primaryFiles(
      itemIds: readonly string[],
    ): Promise<Map<string, PrimaryFile>> {
      const files = new Map<string, PrimaryFile>();
      if (itemIds.length === 0) return files;
      const result = await db.query<{
        item_id: string;
        id: string;
        relative_path: string;
        fingerprint: string | null;
      }>(
        `SELECT DISTINCT ON (item_id) item_id, id, relative_path, fingerprint FROM media_files
         WHERE item_id = ANY($1::uuid[]) AND missing_since IS NULL AND size_bytes > 0
         ORDER BY item_id, is_primary DESC, size_bytes DESC`,
        [[...itemIds]],
      );
      for (const row of result.rows)
        files.set(row.item_id, {
          id: row.id,
          relativePath: row.relative_path,
          fingerprint: row.fingerprint,
        });
      return files;
    },

    async listEpisodes(seriesId: string) {
      const result = await db.query<
        HoldingRow & {
          id: string;
          title: string;
          season: number | null;
          episode: number | null;
          airDate: string | null;
          seasonId: string | null;
          hasThumb: boolean;
        }
      >(
        `SELECT item.id, item.title, item.parent_index_number AS season, item.index_number AS episode,
           (SELECT parent.id FROM items parent WHERE parent.id = item.parent_id AND parent.kind = 'season') AS "seasonId",
           to_char(item.premiere_date, 'YYYY-MM-DD') AS "airDate",
           EXISTS (SELECT 1 FROM item_images thumb WHERE thumb.item_id = item.id AND thumb.image_type = 'thumb') AS "hasThumb",
           ${HOLDING_COLUMNS}
         FROM items item WHERE item.series_id = $1 AND item.kind = 'episode'
         ORDER BY item.parent_index_number NULLS LAST, item.index_number NULLS LAST, item.sort_title`,
        [seriesId],
      );
      return result.rows;
    },

    /**
     * Downloads and imports that name the series itself rather than an
     * episode: a season pack, or an episode the catalogue has no row for yet.
     * A null episode covers the whole season.
     */
    async seriesWork(seriesId: string) {
      const result = await db.query<{
        stage: "downloading" | "importing";
        season: number | null;
        episode: number | null;
      }>(
        `SELECT 'downloading' AS stage, a.target_season AS season, a.target_episode AS episode
           FROM acquisitions a
          WHERE a.target_item_id = $1 AND a.target_kind IN ('season', 'episode')
            AND a.state NOT IN ('downloaded', 'cancelled', 'superseded', 'failed')
         UNION ALL
         SELECT 'importing', imp.target_season, imp.target_episode
           FROM imports imp
          WHERE imp.target_item_id = $1 AND imp.target_kind IN ('season', 'episode')
            AND ${importUnderWaySql("imp")}`,
        [seriesId],
      );
      return result.rows;
    },

    async monitoring(seriesId: string) {
      const [series, seasons, episodes] = await Promise.all([
        db.query<{ monitored: boolean }>(
          `SELECT COALESCE(m.monitored, item.desired) AS monitored FROM items item
           LEFT JOIN monitored_items m ON m.item_id = item.id WHERE item.id = $1`,
          [seriesId],
        ),
        db.query<{ season_number: number; monitoring: MonitoringChoice }>(
          "SELECT season_number, monitoring FROM monitored_seasons WHERE series_item_id = $1",
          [seriesId],
        ),
        db.query<{
          season_number: number;
          episode_number: number;
          monitoring: MonitoringChoice;
        }>(
          "SELECT season_number, episode_number, monitoring FROM monitored_episodes WHERE series_item_id = $1",
          [seriesId],
        ),
      ]);
      return {
        series: { monitored: series.rows[0]?.monitored ?? false },
        seasons: new Map(
          seasons.rows.map((row) => [
            row.season_number,
            { seasonNumber: row.season_number, monitoring: row.monitoring },
          ]),
        ),
        episodes: new Map(
          episodes.rows.map((row) => [
            `${row.season_number}:${row.episode_number}`,
            { monitoring: row.monitoring },
          ]),
        ),
      };
    },
  };
}

export type LibraryAdminRepository = ReturnType<
  typeof createLibraryAdminRepository
>;

export interface PrimaryFile {
  id: string;
  relativePath: string;
  fingerprint: string | null;
}

/** What the processing page's package index knows about one file's package. */
export type PackageStateLookup = (file: PrimaryFile) => ProcessingPackageState;

/**
 * An episode's status, with "processed" read from its package.
 *
 * `MEDIA_STATUS_SQL` calls a title ready when a succeeded job published it,
 * but that row is history: the processing page deletes it on request, and a
 * title packaged before the catalogue was rebuilt never had one. The package
 * on disk is what playback serves and what the processing page reports, so
 * once the index has read it, it decides; until then the job history stands.
 */
export function packagedStatus(
  status: string,
  processing: number,
  state: ProcessingPackageState,
): string {
  if (state === "complete") return "ready";
  if (state === "unknown" || status !== "ready") return status;
  return processing > 0 ? "processing" : "downloaded";
}

function baseName(relativePath: string | undefined): string | null {
  if (!relativePath) return null;
  return relativePath.split("/").pop() ?? null;
}

/** What a title page needs from TMDB: a show's seasons and their episodes. */
export type SeriesCatalogue = Pick<
  TmdbClient,
  "getSeries" | "getSeasonEpisodes" | "buildImageUrl"
>;

/**
 * TMDB's seasons and episodes, kept for a few minutes.
 *
 * An open title page asks for itself every few seconds to stay live, and what
 * TMDB lists for a show changes over days, so asking it each time would be a
 * call per season every few seconds for nothing. A failed answer is not kept.
 */
export function cacheSeriesCatalogue(
  tmdb: SeriesCatalogue,
  ttlMs = 10 * 60_000,
  now = () => Date.now(),
): SeriesCatalogue {
  const entries = new Map<string, { at: number; value: Promise<unknown> }>();
  const remember = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value as Promise<T>;
    if (entries.size > 500)
      for (const [stale, entry] of entries)
        if (now() - entry.at >= ttlMs) entries.delete(stale);
    const value = load();
    entries.set(key, { at: now(), value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
  return {
    getSeries: (providerId, language) =>
      remember(`series:${providerId}:${language ?? ""}`, () =>
        tmdb.getSeries(providerId, language),
      ),
    getSeasonEpisodes: (providerId, seasonNumber) =>
      remember(`season:${providerId}:${seasonNumber}`, () =>
        tmdb.getSeasonEpisodes(providerId, seasonNumber),
      ),
    buildImageUrl: (imagePath, size) => tmdb.buildImageUrl(imagePath, size),
  };
}

/**
 * A title with everything under it.
 *
 * A show's seasons are what TMDB says it has, merged with what the disk holds,
 * so a missing episode is a row rather than a gap. An episode on disk that TMDB
 * does not know (a special, a double episode) is kept: the disk is never hidden
 * because a catalogue disagrees with it.
 */
export async function loadTitleDetail(
  repository: LibraryAdminRepository,
  tmdb: SeriesCatalogue | undefined,
  itemId: string,
  options: { now?: Date; packageState?: PackageStateLookup } = {},
): Promise<LibraryTitleDetail | null> {
  const now = options.now ?? new Date();
  const title = await repository.getTitle(itemId);
  if (!title) return null;
  if (title.kind !== "series") {
    const file = (await repository.primaryFiles([title.id])).get(title.id);
    return {
      ...title,
      mediaFileId: file?.id ?? null,
      fileName: baseName(file?.relativePath),
      seasons: [],
      catalogueComplete: true,
    };
  }

  const [rows, monitoring, seriesWork] = await Promise.all([
    repository.listEpisodes(title.id),
    repository.monitoring(title.id),
    repository.seriesWork(title.id),
  ]);
  const files = await repository.primaryFiles(rows.map((row) => row.id));
  const seasonIds = new Map<number, string>();
  for (const row of rows)
    if (row.seasonId && row.season !== null)
      seasonIds.set(row.season, row.seasonId);
  const episodes = new Map<string, LibraryEpisode>();
  const unnumbered: LibraryEpisode[] = [];
  for (const row of rows) {
    const file = files.get(row.id);
    const facts = holding(row);
    if (file && options.packageState)
      facts.status = packagedStatus(
        facts.status,
        facts.processing,
        options.packageState(file),
      );
    const episode: LibraryEpisode = {
      id: row.id,
      seasonNumber: row.season ?? 0,
      episodeNumber: row.episode ?? 0,
      title: row.title,
      airDate: row.airDate,
      mediaFileId: file?.id ?? null,
      fileName: baseName(file?.relativePath),
      monitored: true,
      hasThumb: row.hasThumb,
      stillUrl: null,
      ...facts,
    };
    if (row.season === null || row.episode === null) unnumbered.push(episode);
    else episodes.set(`${row.season}:${row.episode}`, episode);
  }

  let catalogueComplete = !title.tmdbId;
  if (tmdb && title.tmdbId) {
    try {
      const series = await tmdb.getSeries(title.tmdbId);
      const seasons = (series.seasons ?? []).filter(
        (season) => season.seasonNumber > 0 && season.episodeCount > 0,
      );
      const listed = await Promise.all(
        seasons.map((season) =>
          tmdb.getSeasonEpisodes(title.tmdbId!, season.seasonNumber),
        ),
      );
      for (const known of listed.flat()) {
        const key = `${known.seasonNumber}:${known.episodeNumber}`;
        const still = known.stillPath
          ? tmdb.buildImageUrl(known.stillPath, "w300")
          : null;
        const held = episodes.get(key);
        if (held) {
          held.title ??= known.title ?? null;
          held.airDate ??= known.airDate ?? null;
          held.stillUrl ??= still;
          continue;
        }
        const aired =
          known.airDate !== undefined && new Date(known.airDate) <= now;
        const monitored = resolveEpisodeMonitoring(
          monitoring.series,
          monitoring.seasons.get(known.seasonNumber),
          monitoring.episodes.get(key),
        ).monitored;
        episodes.set(key, {
          id: null,
          seasonNumber: known.seasonNumber,
          episodeNumber: known.episodeNumber,
          title: known.title ?? null,
          airDate: known.airDate ?? null,
          mediaFileId: null,
          fileName: null,
          monitored,
          hasThumb: false,
          stillUrl: still,
          ...NOTHING_HELD(
            known.airDate !== undefined && !aired
              ? "unaired"
              : monitored
                ? "wanted"
                : "missing",
          ),
        });
      }
      catalogueComplete = true;
    } catch {
      // The disk is still the truth; TMDB only adds the rows it is missing.
      catalogueComplete = false;
    }
  }

  // Work addressed to the series reaches the episodes it covers that are not
  // held yet, so a season pack or an uncatalogued episode reads as on its way.
  for (const episode of episodes.values()) {
    if (episode.hasMedia) continue;
    for (const work of seriesWork) {
      if (
        work.season === episode.seasonNumber &&
        (work.episode === null || work.episode === episode.episodeNumber)
      )
        episode[work.stage] += 1;
    }
  }

  const bySeason = new Map<number, LibraryEpisode[]>();
  for (const episode of [...episodes.values(), ...unnumbered]) {
    const list = bySeason.get(episode.seasonNumber) ?? [];
    list.push(episode);
    bySeason.set(episode.seasonNumber, list);
  }
  return {
    ...title,
    mediaFileId: null,
    fileName: null,
    catalogueComplete,
    seasons: [...bySeason.entries()]
      .sort(([a], [b]) => a - b)
      .map(([seasonNumber, list]) => ({
        id: seasonIds.get(seasonNumber) ?? null,
        seasonNumber,
        episodes: list.sort((a, b) => a.episodeNumber - b.episodeNumber),
      })),
  };
}
