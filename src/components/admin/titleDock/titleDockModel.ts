import type { TranslationKey } from "../../../i18n/translations";
import type { LibraryTitleDetail } from "../../../lib/libraryAdminApi";
import type {
  ProcessingJob,
  ProcessingMovieTitle,
  ProcessingOverview,
  ProcessingSeason,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../../lib/processingApi";
import { languages } from "../libraryStyle";

/**
 * What the admin dock is about: one film, or one show — and, on a season's
 * page, the season the operator is looking at.
 *
 * The season narrows processing only. Subtitles, trickplay, metadata and
 * monitoring are the show's, because that is where the library keeps them.
 */
export type DockScope =
  | { kind: "movie"; itemId: string }
  | { kind: "series"; seriesId: string; seasonId?: string };

export type DockSection =
  | "processing"
  | "subtitles"
  | "trickplay"
  | "metadata"
  | "monitoring";

export const DOCK_SECTIONS: DockSection[] = [
  "processing",
  "subtitles",
  "trickplay",
  "metadata",
  "monitoring",
];

/**
 * ok: nothing to do. busy: the server is working on it. attention: something
 * an administrator would want to act on. idle: nothing applies yet.
 * unknown: the server has not said.
 */
export type DockTone = "ok" | "busy" | "attention" | "idle" | "unknown";

export interface DockStatus {
  tone: DockTone;
  key: TranslationKey;
  values?: Record<string, string | number>;
}

/** The part of the processing overview that belongs to this title. */
export interface DockProcessing {
  movie?: ProcessingMovieTitle;
  series?: ProcessingSeries;
  season?: ProcessingSeason;
  /** The job the catalogue says is active for the film, if it is in the overview. */
  activeJob?: ProcessingJob;
  /** The film's most recent job, active or not. */
  lastJob?: ProcessingJob;
}

export function scopeTitleId(scope: DockScope): string {
  return scope.kind === "movie" ? scope.itemId : scope.seriesId;
}

/** The films and episodes of one title, out of the whole library's overview. */
export function pickProcessing(
  overview: ProcessingOverview,
  scope: DockScope,
): DockProcessing {
  if (scope.kind === "movie") {
    const movie = overview.movies?.find((row) => row.itemId === scope.itemId);
    const jobs = overview.jobs.filter((job) => job.itemId === scope.itemId);
    const lastJob = [...jobs].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    const activeJob = movie?.activeJobId
      ? overview.jobs.find((job) => job.id === movie.activeJobId)
      : undefined;
    return { movie, activeJob, lastJob };
  }
  const series = overview.series?.find(
    (row) => row.seriesId === scope.seriesId,
  );
  const season = scope.seasonId
    ? series?.seasons.find((row) => row.seasonId === scope.seasonId)
    : undefined;
  return { series, season };
}

export function seriesCounts(
  processing: DockProcessing,
): ProcessingStateCounts | undefined {
  return processing.season?.counts ?? processing.series?.counts;
}

/**
 * Whether the dock should look again soon: something for this title is
 * queued or running, so its figures will move.
 */
export function hasActiveWork(processing: DockProcessing | null): boolean {
  if (!processing) return false;
  if (processing.movie?.activeJobId) return true;
  return (seriesCounts(processing)?.active ?? 0) > 0;
}

export function jobPercent(job: ProcessingJob): number {
  const fraction = Number.isFinite(job.overallProgress)
    ? Math.min(1, Math.max(0, job.overallProgress))
    : 0;
  return Math.min(99, Math.floor(fraction * 100));
}

export function processingStatus(
  processing: DockProcessing | null,
  scope: DockScope,
): DockStatus {
  if (!processing) return { tone: "unknown", key: "titleDock.status.unknown" };

  if (scope.kind === "series") {
    const counts = seriesCounts(processing);
    if (!counts) return { tone: "unknown", key: "titleDock.status.unknown" };
    const available = counts.total - counts.unavailable;
    if (available <= 0)
      return { tone: "idle", key: "titleDock.processing.noFiles" };
    const values = { done: counts.complete, total: available };
    if (counts.active > 0)
      return {
        tone: "busy",
        key: "titleDock.processing.episodesActive",
        values: { ...values, active: counts.active },
      };
    if (counts.complete >= available)
      return { tone: "ok", key: "titleDock.processing.episodesDone", values };
    return {
      tone: "attention",
      key: "titleDock.processing.episodesPartial",
      values,
    };
  }

  const { movie, activeJob, lastJob } = processing;
  if (!movie) return { tone: "unknown", key: "titleDock.status.unknown" };

  if (movie.activeJobId) {
    const state = activeJob?.state ?? movie.activeJobState;
    if (state === "running")
      return {
        tone: "busy",
        key: "titleDock.processing.running",
        values: { percent: activeJob ? jobPercent(activeJob) : 0 },
      };
    if (state === "paused")
      return { tone: "attention", key: "titleDock.processing.paused" };
    return { tone: "busy", key: "titleDock.processing.queued" };
  }

  if (movie.packageState === "complete") {
    const best = Math.max(0, ...(movie.package?.rungs ?? []));
    return best > 0
      ? { tone: "ok", key: "titleDock.processing.ready", values: { best } }
      : { tone: "ok", key: "titleDock.processing.readyPlain" };
  }
  if (lastJob?.state === "failed")
    return { tone: "attention", key: "titleDock.processing.failed" };
  if (movie.packageState === "partial")
    return { tone: "attention", key: "titleDock.processing.partial" };
  if (movie.packageState === "stale")
    return { tone: "attention", key: "titleDock.processing.stale" };
  if (movie.packageState === "unknown")
    return { tone: "unknown", key: "titleDock.status.unknown" };
  if (!movie.sourceAvailable)
    return { tone: "idle", key: "titleDock.processing.noSource" };
  return { tone: "attention", key: "titleDock.processing.none" };
}

export function subtitleStatus(detail: LibraryTitleDetail | null): DockStatus {
  if (!detail) return { tone: "unknown", key: "titleDock.status.unknown" };
  if (detail.files === 0)
    return { tone: "idle", key: "titleDock.status.noFiles" };
  if (detail.pendingSubtitles.length > 0)
    return {
      tone: "busy",
      key: "titleDock.subtitles.searching",
      values: { languages: languages(detail.pendingSubtitles, 2) },
    };
  const held = detail.subtitleLanguages.filter((code) => code !== "und");
  if (held.length === 0)
    return { tone: "attention", key: "titleDock.subtitles.none" };
  const list = languages(held, 2);
  return held.includes("tur")
    ? {
        tone: "ok",
        key: "titleDock.subtitles.held",
        values: { languages: list },
      }
    : {
        tone: "attention",
        key: "titleDock.subtitles.noTurkish",
        values: { languages: list },
      };
}

export function trickplayStatus(detail: LibraryTitleDetail | null): DockStatus {
  if (!detail) return { tone: "unknown", key: "titleDock.status.unknown" };
  if (detail.files === 0)
    return { tone: "idle", key: "titleDock.status.noFiles" };
  if (detail.trickplayFiles >= detail.files)
    return { tone: "ok", key: "titleDock.trickplay.ready" };
  return {
    tone: "attention",
    key: "titleDock.trickplay.partial",
    values: { done: detail.trickplayFiles, total: detail.files },
  };
}

export function metadataStatus(detail: LibraryTitleDetail | null): DockStatus {
  if (!detail) return { tone: "unknown", key: "titleDock.status.unknown" };
  if (detail.artwork.missing)
    return { tone: "attention", key: "titleDock.metadata.noCover" };
  if (!detail.artwork.logoTag)
    return { tone: "attention", key: "titleDock.metadata.noLogo" };
  return { tone: "ok", key: "titleDock.metadata.ready" };
}

export function monitoringStatus(
  detail: LibraryTitleDetail | null,
): DockStatus {
  if (!detail) return { tone: "unknown", key: "titleDock.status.unknown" };
  if (detail.downloading > 0)
    return {
      tone: "busy",
      key: "titleDock.monitoring.downloading",
      values: { count: detail.downloading },
    };
  if (detail.importing > 0)
    return { tone: "busy", key: "titleDock.monitoring.importing" };
  if (detail.kind === "series" && detail.episodeCount > 0) {
    const values = {
      held: detail.availableEpisodeCount,
      total: detail.episodeCount,
    };
    if (!detail.desired)
      return { tone: "idle", key: "titleDock.monitoring.offEpisodes", values };
    return detail.availableEpisodeCount >= detail.episodeCount
      ? { tone: "ok", key: "titleDock.monitoring.onEpisodes", values }
      : { tone: "attention", key: "titleDock.monitoring.onEpisodes", values };
  }
  return detail.desired
    ? { tone: "ok", key: "titleDock.monitoring.on" }
    : { tone: "idle", key: "titleDock.monitoring.off" };
}

export function sectionStatus(
  section: DockSection,
  detail: LibraryTitleDetail | null,
  processing: DockProcessing | null,
  scope: DockScope,
): DockStatus {
  switch (section) {
    case "processing":
      return processingStatus(processing, scope);
    case "subtitles":
      return subtitleStatus(detail);
    case "trickplay":
      return trickplayStatus(detail);
    case "metadata":
      return metadataStatus(detail);
    case "monitoring":
      return monitoringStatus(detail);
  }
}
