import path from "node:path";
import type {
  MediaStreamRow,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { isHdrTransfer, isTextSubtitleCodec } from "../../../renditions/probe";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import {
  decideProcessing,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import { titleRootLayoutForKind } from "../../../renditions/adaptive/titleRoot";
import type {
  PackageIndexEntry,
  PackageIndexTarget,
  ProcessingPackageState,
  ProcessingPackageSummary,
} from "./packageIndex";
import type { ProcessingJobRecord, ProcessingState } from "./jobStore";

/**
 * The catalogue's own hierarchy, projected into what the processing page needs.
 *
 * One projection serves both content kinds. A movie and an episode differ in
 * where they sit and what they are called; the thing being processed — a
 * canonical source file, a plan for it, a package on disk, maybe a job — is
 * identical, and is modelled once as `ProcessingTitle`. Series and seasons are
 * containers built around those titles and own no processing state of their
 * own: every count they carry is derived from their episodes.
 *
 * Nothing here opens a media file. The technical figures come from the probe
 * the scanner already persisted, and the package figures from the index that
 * reads manifests on its own clock. That is what lets a library with hundreds
 * of episodes be a database read.
 */

export interface ProcessingSourceSummary {
  width: number;
  height: number;
  /** The rung class the source belongs to, e.g. 2160 for a scope 4K master. */
  qualityHeight: number;
  videoCodec: string;
  frameRate: number | null;
  bitDepth: number | null;
  isHdr: boolean;
  /** `SDR`, `HDR10` or `HLG`, named the way the packager names it. */
  dynamicRange: string;
  durationSeconds: number;
  sizeBytes: number;
  container: string;
  audioTracks: number;
  subtitleTracks: number;
  externalSubtitles: number;
}

export interface ProcessingPlanSummary {
  action: string;
  summary: string;
  videoCodec: "h264" | "hevc";
  videoEncoder: string;
  hardwareAdapter: string;
  preservesHdr: boolean;
  ladder: number[];
  /** Rungs today's ladder would add to whatever is already on disk. */
  missingRungs: number[];
  estimatedOutputBytes: number;
  audioTracksKept: number;
  subtitleTracksKept: number;
}

/** What a title is, whether it is a film or one episode of a season. */
export interface ProcessingTitle {
  itemId: string;
  mediaFileId: string | null;
  title: string;
  sortTitle: string;
  /**
   * True when the canonical source is still on disk. A title whose source has
   * been removed keeps its package and stays visible; it simply cannot be the
   * subject of a job.
   */
  sourceAvailable: boolean;
  /**
   * How many playable files the catalogue holds for this title. Above one
   * means alternate representations — an `.mkv` and an `.mp4` of the same
   * episode — of which exactly one, the canonical, is ever processed.
   */
  fileCount: number;
  /**
   * The persisted probe has not run yet, so nothing technical can be said
   * about this title and no plan can be made for it.
   */
  probed: boolean;
  source: ProcessingSourceSummary | null;
  plan: ProcessingPlanSummary | null;
  package: ProcessingPackageSummary | null;
  packageState: ProcessingPackageState;
  activeJobId: string | null;
  activeJobState: ProcessingState | null;
  /** True when starting a job for this title would actually do work. */
  processable: boolean;
}

export interface ProcessingMovie extends ProcessingTitle {
  productionYear: number | null;
}

export interface ProcessingEpisode extends ProcessingTitle {
  /** The episode's name per interface language, where TMDB gives one. */
  localizedTitles?: Record<string, string>;
  seasonNumber: number;
  episodeNumber: number | null;
  /** `S01E01`, or `S01` when the episode carries no number. */
  code: string;
}

export interface ProcessingStateCounts {
  total: number;
  complete: number;
  partial: number;
  unprocessed: number;
  /** Titles whose package state the index has not read yet. */
  unknown: number;
  /** Titles with a job that has not finished. */
  active: number;
  /** Titles whose canonical source is gone. */
  unavailable: number;
  /** Titles a bulk action would enqueue right now. */
  eligible: number;
}

export interface ProcessingSeason {
  seasonId: string;
  seasonNumber: number;
  title: string;
  episodes: ProcessingEpisode[];
  counts: ProcessingStateCounts;
}

export interface ProcessingSeries {
  seriesId: string;
  title: string;
  sortTitle: string;
  productionYear: number | null;
  /** Its other names (original, other languages, added), for the search box. */
  searchNames: string[];
  seasonCount: number;
  episodeCount: number;
  seasons: ProcessingSeason[];
  counts: ProcessingStateCounts;
}

export interface ProcessingCatalogueView {
  movies: ProcessingMovie[];
  series: ProcessingSeries[];
}

/** Everything the projection needs that is not a catalogue row. */
export interface ProjectionContext {
  hardware: HardwareReport;
  streamsByFile: ReadonlyMap<string, MediaStreamRow[]>;
  packageFor: (mediaFileId: string) => PackageIndexEntry;
  /** Unfinished jobs, keyed by the file they are processing. */
  activeJobsByFile: ReadonlyMap<string, ProcessingJobRecord>;
  /**
   * Optional physical source-presence verdict.
   *
   * Rendition-backed titles deliberately keep their media-file catalogue
   * identity alive after the original bytes are removed, because rendition
   * playback authorization still resolves through that identity. Processing
   * therefore cannot equate `missingSince === null` with "source exists".
   */
  sourceAvailableFor?: (row: ProcessableTitleRow) => boolean;
  freeBytes?: number;
}

// -------------------------------------------------------------------- probe

function textOrUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/**
 * The persisted probe, in the shape the planner reads.
 *
 * Deliberately built from `media_streams` rather than by running ffprobe: this
 * is the same technical record playback and the NFO writer already work from.
 *
 * Two dispositions the container carries are not persisted — `comment` and
 * `visual_impaired` — so a plan built here can retain a commentary track that
 * the job itself, which re-probes the file for real before it encodes
 * anything, would drop. The consequence is confined to a slightly generous
 * audio count in a preview. Nothing is ever encoded from this.
 */
export function probeFromCatalogue(
  row: ProcessableTitleRow,
  streams: readonly MediaStreamRow[],
): RenditionMediaProbe | null {
  if (!row.width || !row.height || row.width <= 0 || row.height <= 0) {
    return null;
  }
  const durationSeconds = row.durationMs ? Number(row.durationMs) / 1000 : 0;
  const video = streams.find((stream) => stream.kind === "video");

  return {
    durationSeconds,
    ...(row.bitrateBps ? { overallBitrate: Number(row.bitrateBps) } : {}),
    video: {
      streamIndex: video?.streamIndex ?? 0,
      codec: (row.videoCodec ?? "unknown").toLowerCase(),
      width: row.width,
      height: row.height,
      /*
       * Rotation is not persisted. Treating an unknown rotation as none is the
       * only safe reading: it is what a source without the tag reports, and it
       * is what every file in this library reports.
       */
      rotation: 0,
      ...(row.frameRate === null ? {} : { frameRate: row.frameRate }),
      ...(row.bitDepth === null ? {} : { bitDepth: row.bitDepth }),
      ...(row.pixelFormat ? { pixelFormat: row.pixelFormat } : {}),
      ...(row.colorTransfer ? { colorTransfer: row.colorTransfer } : {}),
      ...(row.colorPrimaries ? { colorPrimaries: row.colorPrimaries } : {}),
      ...(row.colorSpace ? { colorSpace: row.colorSpace } : {}),
      /*
       * `video_range` is what the probe service wrote down as the source's own
       * verdict; the transfer characteristic is the fallback, and is what the
       * encoder itself keys on.
       */
      isHdr:
        isHdrTransfer(row.colorTransfer ?? undefined) ||
        (row.videoRange ?? "").toUpperCase().startsWith("HDR"),
    },
    audioTracks: streams
      .filter((stream) => stream.kind === "audio")
      .map((stream) => ({
        streamIndex: stream.streamIndex,
        codec: (stream.codec ?? "unknown").toLowerCase(),
        ...(stream.profile ? { profile: stream.profile } : {}),
        ...(stream.channels === null ? {} : { channels: stream.channels }),
        ...(stream.sampleRate === null
          ? {}
          : { sampleRate: stream.sampleRate }),
        ...(stream.bitrateBps ? { bitrate: Number(stream.bitrateBps) } : {}),
        ...(textOrUndefined(stream.language)
          ? { language: stream.language as string }
          : {}),
        ...(textOrUndefined(stream.title)
          ? { title: stream.title as string }
          : {}),
        isDefault: stream.isDefault,
        isCommentary: false,
        isVisualImpaired: false,
        isOriginal: false,
      })),
    subtitleTracks: streams
      /*
       * Container streams only. A sidecar `.srt` is not a stream the packager
       * copies out of the file; it is planned separately, and counting it here
       * would have the policy drop a language it never saw.
       */
      .filter((stream) => stream.kind === "subtitle" && !stream.isExternal)
      .map((stream) => ({
        streamIndex: stream.streamIndex,
        codec: (stream.codec ?? "unknown").toLowerCase(),
        ...(textOrUndefined(stream.language)
          ? { language: stream.language as string }
          : {}),
        ...(textOrUndefined(stream.title)
          ? { title: stream.title as string }
          : {}),
        isDefault: stream.isDefault,
        isForced: stream.isForced,
        isHearingImpaired: false,
        isCommentary: false,
        isTextBased:
          stream.isTextSubtitle || isTextSubtitleCodec(stream.codec ?? ""),
      })),
    chapters: [],
  };
}

export function dynamicRangeLabelFor(
  probe: RenditionMediaProbe | null,
  packageSummary: ProcessingPackageSummary | null,
): string {
  if (probe && !probe.video.isHdr) return "SDR";
  const transfer = probe?.video.colorTransfer?.trim().toLowerCase();
  if (transfer === "arib-std-b67") return "HLG";
  if (transfer === "smpte2084") return "HDR10";
  const packaged = packageSummary?.hdr;
  if (packaged && packaged !== "sdr") return packaged.toUpperCase();
  return probe?.video.isHdr ? "HDR" : "SDR";
}

// --------------------------------------------------------------- one title

function summariseDecision(
  decision: ProcessingDecision,
  missingRungs: number[],
): ProcessingPlanSummary {
  return {
    action: decision.action,
    summary: decision.summary,
    videoCodec: decision.videoCodec,
    videoEncoder: decision.videoEncoder,
    hardwareAdapter: decision.hardwareAdapter,
    preservesHdr: decision.preservesHdr,
    ladder: decision.ladder.map((rung) => rung.qualityHeight),
    missingRungs,
    estimatedOutputBytes: decision.estimate.outputBytes,
    audioTracksKept: decision.streams.keptAudioStreamIndexes.length,
    subtitleTracksKept: decision.streams.keptSubtitleStreamIndexes.length,
  };
}

export function projectTitle(
  row: ProcessableTitleRow,
  context: ProjectionContext,
): ProcessingTitle {
  const streams = row.mediaFileId
    ? (context.streamsByFile.get(row.mediaFileId) ?? [])
    : [];
  const packageEntry = row.mediaFileId
    ? context.packageFor(row.mediaFileId)
    : { state: "unknown" as const, summary: null, readAt: 0 };
  const activeJob = row.mediaFileId
    ? (context.activeJobsByFile.get(row.mediaFileId) ?? null)
    : null;

  /*
   * The processing route can provide a physical-presence verdict for
   * rendition-backed titles. Other callers retain the catalogue fallback.
   *
   * This distinction matters because a completed title intentionally keeps
   * its media-file identity after its original bytes are deleted, so
   * `fileMissingSince === null` alone does not prove that the source exists.
   */
  const sourceAvailable =
    context.sourceAvailableFor?.(row) ??
    (row.mediaFileId !== null && row.fileMissingSince === null);

  const probe = probeFromCatalogue(row, streams);
  const container =
    row.container ??
    (row.relativePath ? path.extname(row.relativePath).replace(".", "") : "");

  let plan: ProcessingPlanSummary | null = null;
  let source: ProcessingSourceSummary | null = null;

  if (probe) {
    const planInput = {
      probe,
      container,
      sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : 0,
      hardware: context.hardware,
      ...(context.freeBytes === undefined
        ? {}
        : { freeBytes: context.freeBytes }),
    };
    const planned = decideProcessing(planInput);
    const existingRungs = packageEntry.summary?.rungs ?? [];
    const missingRungs = planned.ladder
      .map((rung) => rung.qualityHeight)
      .filter((height) => !existingRungs.includes(height));

    /*
     * Re-decided against the outstanding rungs only, exactly as the single
     * title preview does, so a season row does not advertise a full package's
     * worth of bytes for a job that is adding one rung.
     */
    const incremental =
      packageEntry.summary?.current === true &&
      missingRungs.length > 0 &&
      missingRungs.length < planned.ladder.length;
    const decision = incremental
      ? decideProcessing({
          ...planInput,
          renditionsToEncode: missingRungs,
          audioTracksToEncode: 0,
        })
      : planned;

    plan = summariseDecision(decision, missingRungs);
    source = {
      width: probe.video.width,
      height: probe.video.height,
      qualityHeight: decision.source.qualityHeight,
      videoCodec: probe.video.codec,
      frameRate: probe.video.frameRate ?? null,
      bitDepth: probe.video.bitDepth ?? null,
      isHdr: probe.video.isHdr,
      dynamicRange: dynamicRangeLabelFor(probe, packageEntry.summary),
      durationSeconds: probe.durationSeconds,
      sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : 0,
      container,
      audioTracks: row.audioTrackCount,
      subtitleTracks: row.subtitleTrackCount,
      externalSubtitles: row.externalSubtitleCount,
    };
  }

  /*
   * Startable, and worth starting. Every clause is a reason a press would
   * either fail or encode nothing: no bytes to read, a job already on it, no
   * plan yet because the file has not been probed, or a package that today's
   * ladder would add nothing to.
   *
   * `unknown` is deliberately treated as eligible rather than as complete. The
   * index not having read a title yet is not evidence that it is finished, and
   * the enqueue path re-checks the package for real before it creates a job.
   */
  const processable =
    sourceAvailable &&
    activeJob === null &&
    plan !== null &&
    !plan.action.startsWith("reject") &&
    (packageEntry.state === "unknown" ||
      packageEntry.state === "none" ||
      packageEntry.state === "stale" ||
      plan.missingRungs.length > 0);

  return {
    itemId: row.itemId,
    mediaFileId: row.mediaFileId,
    title: row.title,
    sortTitle: row.sortTitle,
    sourceAvailable,
    fileCount: row.fileCount,
    probed: probe !== null,
    source,
    plan,
    package: packageEntry.summary,
    packageState: packageEntry.state,
    activeJobId: activeJob?.id ?? null,
    activeJobState: activeJob?.state ?? null,
    processable,
  };
}

// ------------------------------------------------------------------ counts

export function countTitles(
  titles: readonly ProcessingTitle[],
): ProcessingStateCounts {
  const counts: ProcessingStateCounts = {
    total: titles.length,
    complete: 0,
    partial: 0,
    unprocessed: 0,
    unknown: 0,
    active: 0,
    unavailable: 0,
    eligible: 0,
  };
  for (const title of titles) {
    if (title.activeJobId) counts.active += 1;
    if (!title.sourceAvailable) counts.unavailable += 1;
    if (title.processable) counts.eligible += 1;
    switch (title.packageState) {
      case "complete":
        counts.complete += 1;
        break;
      case "partial":
      case "stale":
        counts.partial += 1;
        break;
      case "none":
        counts.unprocessed += 1;
        break;
      default:
        counts.unknown += 1;
    }
  }
  return counts;
}

function sumCounts(
  groups: readonly ProcessingStateCounts[],
): ProcessingStateCounts {
  return groups.reduce<ProcessingStateCounts>(
    (total, group) => ({
      total: total.total + group.total,
      complete: total.complete + group.complete,
      partial: total.partial + group.partial,
      unprocessed: total.unprocessed + group.unprocessed,
      unknown: total.unknown + group.unknown,
      active: total.active + group.active,
      unavailable: total.unavailable + group.unavailable,
      eligible: total.eligible + group.eligible,
    }),
    {
      total: 0,
      complete: 0,
      partial: 0,
      unprocessed: 0,
      unknown: 0,
      active: 0,
      unavailable: 0,
      eligible: 0,
    },
  );
}

// ----------------------------------------------------------- the hierarchy

export function episodeCode(
  seasonNumber: number,
  episodeNumber: number | null,
): string {
  const season = `S${String(Math.max(0, seasonNumber)).padStart(2, "0")}`;
  if (episodeNumber === null) return season;
  return `${season}E${String(Math.max(0, episodeNumber)).padStart(2, "0")}`;
}

/** The targets the package index should be keeping warm for this view. */
export function packageTargetsFor(
  rows: readonly ProcessableTitleRow[],
  mediaRoot: string,
): PackageIndexTarget[] {
  const targets: PackageIndexTarget[] = [];
  for (const row of rows) {
    if (!row.mediaFileId || !row.relativePath) continue;
    targets.push({
      mediaFileId: row.mediaFileId,
      sourcePath: path.resolve(mediaRoot, ...row.relativePath.split("/")),
      kind: row.kind,
      /*
       * The scanner's fingerprint, which is what the packager records in the
       * manifest. Passing it is what lets a package be told apart from one
       * built for bytes that have since been replaced.
       */
      fingerprint: row.fingerprint,
    });
  }
  return targets;
}

export { titleRootLayoutForKind };

/**
 * Movies and the series tree, ordered the way they are read.
 *
 * Seasons and episodes sort by number, numerically — `S01E2` before `S01E10`,
 * which a sort by title cannot do. Series sort by the catalogue's own sort
 * title, the same key the library pages use, so a show appears in the same
 * place here as everywhere else.
 */
export function projectCatalogue(
  rows: readonly ProcessableTitleRow[],
  context: ProjectionContext,
): ProcessingCatalogueView {
  const movies: ProcessingMovie[] = [];
  const seriesById = new Map<
    string,
    {
      seriesId: string;
      title: string;
      sortTitle: string;
      productionYear: number | null;
      searchNames: string[];
      seasons: Map<
        string,
        {
          seasonId: string;
          seasonNumber: number;
          title: string;
          episodes: ProcessingEpisode[];
        }
      >;
    }
  >();

  for (const row of rows) {
    const title = projectTitle(row, context);

    if (row.kind === "movie") {
      movies.push({ ...title, productionYear: row.productionYear });
      continue;
    }

    /*
     * An episode with no series or season row cannot be placed in the
     * hierarchy. The catalogue always writes both for an episode, so this only
     * happens mid-scan; dropping it keeps a half-written show out of the tree
     * rather than inventing a container for it.
     */
    if (!row.seriesId || !row.seasonId) continue;

    let series = seriesById.get(row.seriesId);
    if (!series) {
      series = {
        seriesId: row.seriesId,
        title: row.seriesTitle ?? row.title,
        sortTitle: row.seriesSortTitle ?? row.seriesTitle ?? row.title,
        productionYear: row.seriesYear,
        searchNames: row.seriesSearchNames ?? [],
        seasons: new Map(),
      };
      seriesById.set(row.seriesId, series);
    }

    const seasonNumber = row.seasonNumber ?? 0;
    let season = series.seasons.get(row.seasonId);
    if (!season) {
      season = {
        seasonId: row.seasonId,
        seasonNumber,
        title: row.seasonTitle ?? `Season ${seasonNumber}`,
        episodes: [],
      };
      series.seasons.set(row.seasonId, season);
    }

    season.episodes.push({
      ...title,
      ...(row.localizedTitles && Object.keys(row.localizedTitles).length > 0
        ? { localizedTitles: row.localizedTitles }
        : {}),
      seasonNumber,
      episodeNumber: row.indexNumber,
      code: episodeCode(seasonNumber, row.indexNumber),
    });
  }

  const series = [...seriesById.values()]
    .map((entry) => {
      const seasons = [...entry.seasons.values()]
        .map((season) => {
          const episodes = [...season.episodes].sort(
            (left, right) =>
              (left.episodeNumber ?? Number.MAX_SAFE_INTEGER) -
                (right.episodeNumber ?? Number.MAX_SAFE_INTEGER) ||
              left.sortTitle.localeCompare(right.sortTitle),
          );
          return {
            seasonId: season.seasonId,
            seasonNumber: season.seasonNumber,
            title: season.title,
            episodes,
            counts: countTitles(episodes),
          };
        })
        .sort((left, right) => left.seasonNumber - right.seasonNumber);

      return {
        seriesId: entry.seriesId,
        title: entry.title,
        sortTitle: entry.sortTitle,
        productionYear: entry.productionYear,
        searchNames: entry.searchNames,
        seasonCount: seasons.length,
        episodeCount: seasons.reduce(
          (total, season) => total + season.episodes.length,
          0,
        ),
        seasons,
        counts: sumCounts(seasons.map((season) => season.counts)),
      };
    })
    .sort(
      (left, right) =>
        left.sortTitle.localeCompare(right.sortTitle) ||
        left.title.localeCompare(right.title),
    );

  movies.sort((left, right) => left.sortTitle.localeCompare(right.sortTitle));

  return { movies, series };
}
