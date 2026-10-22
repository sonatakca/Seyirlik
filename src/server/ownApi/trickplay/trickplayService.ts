import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_PROCESS_NICENESS } from "../../../renditions/processExecution";
import { isHdrTransfer } from "../../../renditions/probe";
import {
  GENERATED_TITLE_DIRECTORIES,
  TITLE_CONTENT_DIRECTORY,
} from "../../../renditions/adaptive/layout";
import { TITLE_PACKAGE_DIRECTORY } from "../../../renditions/adaptive/titleLayout";
import {
  resolveTitleRoot,
  titleRootLayoutForKind,
} from "../../../renditions/adaptive/titleRoot";
import type { DatabasePool } from "../database/databasePool";
import type {
  CatalogueRepository,
  MediaFileRow,
  MediaStreamRow,
  ProcessableTitleRow,
} from "../catalogue/catalogueRepository";
import type { RenditionService } from "../../renditionService";
import { buildTrickplayLayout, type TrickplayLayout } from "./trickplayLayout";
import { planTrickplaySegments } from "./trickplaySegments";
import {
  isInsideDirectory,
  spritePathIn,
  trickplayDirectoryFor,
  trickplayStagingDirectory,
} from "./trickplayStorage";
import {
  commitPublishedTrickplay,
  discardTrickplayStaging,
  prepareTrickplayStaging,
  publishTrickplayDirectory,
  rollbackPublishedTrickplay,
} from "./trickplayPublication";
import { validateTrickplayOutput } from "./trickplayValidation";

/**
 * Whether a catalogued path names something Seyirlik generated rather than the
 * original a person put on the volume.
 *
 * Sheets are sampled from the source and only from the source. An HLS
 * rendition is already tone-mapped, already re-quantised and — for every SDR
 * ladder rung of an HDR master — already a different picture, so a thumbnail
 * taken from one would show the seek bar a copy of a copy.
 */
export function isGeneratedMediaPath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some(
      (segment) =>
        segment === TITLE_PACKAGE_DIRECTORY ||
        segment === TITLE_CONTENT_DIRECTORY ||
        GENERATED_TITLE_DIRECTORIES.has(segment.toLowerCase()),
    );
}

/**
 * Whether a title can be given sheets now: the one rule the per-title button
 * and the library-wide pass both apply.
 *
 * A packaged title qualifies without a probe. Packaging removed the source, so
 * it can never be probed again, and the service samples its package instead.
 */
export function isTrickplayCandidate(
  title: Pick<
    ProcessableTitleRow,
    | "mediaFileId"
    | "relativePath"
    | "fileMissingSince"
    | "itemMissingSince"
    | "probeState"
    | "durationMs"
    | "width"
    | "height"
  >,
): boolean {
  if (
    title.mediaFileId === null ||
    title.relativePath === null ||
    title.fileMissingSince !== null ||
    title.itemMissingSince !== null
  ) {
    return false;
  }
  if (title.probeState === "packaged") return true;
  return (
    title.probeState === "probed" &&
    title.durationMs !== null &&
    (title.width ?? 0) > 0 &&
    (title.height ?? 0) > 0
  );
}

/** What FFmpeg is pointed at, and the facts the layout and colour come from. */
interface SamplingInput {
  path: string;
  /** A package's HLS playlist, which FFmpeg is handed a local copy of. */
  isPackagePlaylist?: boolean;
  map: string;
  durationMs: number;
  width: number;
  height: number;
  colorTransfer: string | null;
  colorPrimaries: string | null;
}

/**
 * PQ and HLG masters carried straight into an 8-bit JPEG come out grey and
 * desaturated; the same chain applied to an ordinary BT.709 source washes it
 * out just as badly in the other direction. So the conversion is chosen from
 * the transfer function and primaries the probe already recorded, and a source
 * that is already BT.709 gets no colour filter at all.
 *
 * This is the same PQ/HLG-to-SDR chain the rendition encoder uses, for the
 * same reason and with the same `npl=100` target — a sprite sheet is looked at
 * on the same display as the video it belongs to.
 */
const HDR_TO_SDR_FILTERS = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
];

/**
 * A wide-gamut source whose transfer is *not* HDR: BT.2020 primaries with a
 * conventional curve. Nothing needs tone mapping here — only the gamut is
 * wrong for a browser, and treating it as BT.709 without converting is what
 * makes such a thumbnail look oversaturated.
 */
const WIDE_GAMUT_TO_BT709_FILTERS = ["zscale=p=bt709:m=bt709:r=tv"];

function isWideGamutPrimaries(colorPrimaries: string | null): boolean {
  return (colorPrimaries ?? "").trim().toLowerCase().startsWith("bt2020");
}

/**
 * The colour conversion this source needs is not available in the configured
 * FFmpeg.
 *
 * Distinguished from an ordinary failure because retrying cannot help: the
 * binary either has the filter or it does not. The message names the remedy
 * rather than the file, and carries no path.
 */
export class TrickplayUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrickplayUnsupportedError";
  }
}

/**
 * Said when there is nothing left to sample: the source is gone and no ready
 * package stands in for it.
 *
 * Without this the missing source path went to FFmpeg anyway, which failed in
 * a second, three times, as "Trickplay generation failed." A package that is
 * complete on disk but whose registry entry lost its ready status lands here
 * too, so the failure stays retryable rather than permanent.
 */
export const TRICKPLAY_NOTHING_TO_SAMPLE =
  "Trickplay generation failed: the source file is gone and no ready package was found to sample instead.";

/**
 * A package playlist rewritten so FFmpeg can open it from anywhere.
 *
 * The packager writes each URI percent-encoded, because browsers fetch them —
 * an HDR rung is named `2160p HDR`, so its segment is `2160p%20HDR.mp4`. FFmpeg
 * opens a local playlist's URIs as literal file names and never decodes them,
 * so it looked for a file called `2160p%20HDR.mp4` and failed. The copy names
 * every file by its decoded, absolute path; byte ranges and tags are unchanged.
 */
export function localPackagePlaylist(
  playlist: string,
  playlistDirectory: string,
): string {
  const localPath = (uri: string): string => {
    // Anything with a scheme is not a file beside the playlist.
    if (/^[a-z][a-z0-9+.-]+:/i.test(uri)) return uri;
    let decoded = uri;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      // A lone `%` is not an escape; the name is then exactly as written.
    }
    return path.resolve(playlistDirectory, ...decoded.split("/"));
  };
  return playlist
    .split("\n")
    .map((line) => {
      const content = line.trim();
      if (content === "") return line;
      if (content.startsWith("#")) {
        return line.replace(
          /URI="([^"]*)"/g,
          (_, uri: string) => `URI="${localPath(uri)}"`,
        );
      }
      return localPath(content);
    })
    .join("\n");
}

/**
 * The reason FFmpeg gave, in words that are safe to store on a job.
 *
 * The stderr tail itself never leaves the process: it names the source path.
 * What does is one fixed sentence per failure worth telling apart, so a failed
 * job says more than that it failed.
 */
export function trickplayFailureMessage(stderr: string): string {
  if (/No such file or directory/i.test(stderr)) {
    return "Trickplay generation failed: FFmpeg could not find a file it needed.";
  }
  if (/Permission denied|Operation not permitted/i.test(stderr)) {
    return "Trickplay generation failed: FFmpeg was refused access to a file.";
  }
  if (/No space left on device/i.test(stderr)) {
    return "Trickplay generation failed: the volume is full.";
  }
  if (
    /Invalid data found when processing input|moov atom not found/i.test(stderr)
  ) {
    return "Trickplay generation failed: FFmpeg could not read the video.";
  }
  return "Trickplay generation failed.";
}

export interface TrickplayFilterSource {
  colorTransfer: string | null;
  colorPrimaries: string | null;
}

/**
 * The one-pass filter graph: sample, colour-correct, fit, tile.
 *
 * `fps` selects one frame per interval so the source is decoded once instead
 * of being seeked to thousands of times, and `tile` packs the result — no
 * intermediate video is ever written.
 *
 * The two scales are deliberate. The first converts non-square pixels to
 * square ones so an anamorphic source is not squashed; the second fits the
 * frame inside the tile without distorting it, and `pad` fills what is left so
 * every tile is exactly the size the seek bar computes offsets from. Rotation
 * is handled before the graph — FFmpeg applies a stream's display matrix by
 * default — so `iw`/`ih` here are already the displayed orientation.
 */
/**
 * The frame index in one line of FFmpeg's own log, or null for every other
 * line.
 *
 * `showinfo` prints one of these as each sampled frame leaves the filter, and
 * `n:` is its own zero-based count of them — so the line for `n: 57` means the
 * decoder has walked fifty-eight sampling points into the source. Only that
 * field is read: the rest of the line is geometry whose spelling has changed
 * between FFmpeg releases, where `n:` has not.
 */
export function frameIndexFromAnnouncement(line: string): number | null {
  const match = /\[Parsed_showinfo[^\]]*\]\s+n:\s*(\d+)(?:\s|$)/.exec(line);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

export interface TrickplayFilterOptions {
  /**
   * Insert the filter that makes FFmpeg name each sampled frame as it passes.
   *
   * The tiler holds a hundred frames before it writes a sheet, and FFmpeg
   * reports progress against what it has *muxed* — so a single-output trickplay
   * pass says nothing at all until sheet zero lands, which on a television
   * episode is most of the way through the file. `showinfo` is the one hook
   * that speaks per frame, at the point the frame leaves the sampler, and it is
   * placed after the scale so it hashes a tile-sized picture rather than a
   * full-sized one.
   */
  announceFrames?: boolean;
}

export function buildTrickplayFilterGraph(
  layout: TrickplayLayout,
  source: TrickplayFilterSource,
  options: TrickplayFilterOptions = {},
): string {
  const colour = isHdrTransfer(source.colorTransfer ?? undefined)
    ? HDR_TO_SDR_FILTERS
    : isWideGamutPrimaries(source.colorPrimaries)
      ? WIDE_GAMUT_TO_BT709_FILTERS
      : [];

  return [
    `fps=1/${layout.intervalMs / 1_000}`,
    ...colour,
    "scale=iw*sar:ih:flags=bicubic",
    "setsar=1",
    `scale=${layout.tileWidth}:${layout.tileHeight}:force_original_aspect_ratio=decrease`,
    `pad=${layout.tileWidth}:${layout.tileHeight}:(ow-iw)/2:(oh-ih)/2`,
    // Explicit and deterministic: the sheets are served as JPEG, so the tiles
    // reach the encoder in the full-range 4:2:0 it expects rather than in
    // whatever the last filter happened to leave behind.
    "format=yuvj420p",
    ...(options.announceFrames ? ["showinfo"] : []),
    `tile=${layout.columns}x${layout.rows}`,
  ].join(",");
}

export interface TrickplaySet extends TrickplayLayout {
  id: string;
  mediaFileId: string;
  /**
   * The legacy UUID directory this set's sheets are still in, or null.
   *
   * Null is the current shape and the only one new generation writes: the
   * sheets are at `<titleRoot>/trickplay/`, derived from the media file's own
   * source path, so there is no address to record. A non-null value means the
   * set predates that and has not been migrated yet — see
   * `019_trickplay_title_storage.sql` and `trickplayMigration.ts`.
   */
  storagePrefix: string | null;
  contentType: string;
}

export interface TrickplayFrameProgress {
  /** Frames of the source the sampler has emitted so far, one-based. */
  completed: number;
  /** Frames the layout expects in total. */
  total: number;
}

export interface GenerateTrickplayOptions {
  /**
   * Rebuild even though the title already has sheets.
   *
   * Deliberately not "delete, then generate". The previous set stays live and
   * readable for the whole of the rebuild and is only replaced once the
   * replacement has been validated on disk, so a regeneration that fails leaves
   * the title exactly as it found it.
   */
  force?: boolean;
  /**
   * Called as FFmpeg walks the source, once per sampled frame.
   *
   * Both halves of the fraction are real: the numerator is a frame the decoder
   * has actually reached, the denominator is the frame count the layout was
   * built from. Nothing is smoothed or extrapolated here — a caller that wants
   * to report less often throttles its own reports.
   *
   * An FFmpeg that announces nothing simply never calls this, and the job then
   * reports what it reported before: elapsed time and the title's name.
   */
  onProgress?: (progress: TrickplayFrameProgress) => void;
}

export interface TrickplayService {
  findForItem(itemId: string): Promise<TrickplaySet | null>;
  findById(setId: string): Promise<TrickplaySet | null>;
  /**
   * The file a sheet is served from, or null when it cannot be located.
   *
   * Asynchronous because the address is derived rather than stored: the set
   * names a media file, the file names a source, and the source's title root
   * names the directory. That derivation is the single source of truth for
   * where sheets are, which is exactly why no caller may reconstruct it.
   */
  spritePath(set: TrickplaySet, spriteIndex: number): Promise<string | null>;
  /** Generates sheets for an item's primary file. Returns null if not possible. */
  generateForItem(
    itemId: string,
    options?: GenerateTrickplayOptions,
  ): Promise<TrickplaySet | null>;
  /**
   * Which of these files already have sheets.
   *
   * The bulk pass asks in one statement rather than enqueuing a job per title
   * and letting each discover for itself that there is nothing to do — a
   * library of several thousand episodes would otherwise fill the queue with
   * no-ops every time somebody pressed the button.
   */
  listGeneratedMediaFileIds(mediaFileIds: string[]): Promise<Set<string>>;
  deleteForItem(itemId: string): Promise<void>;
}

interface RawSetRow {
  id: string;
  media_file_id: string;
  tile_width: number;
  tile_height: number;
  columns: number;
  rows: number;
  interval_ms: number;
  thumbnail_count: number;
  sprite_count: number;
  storage_prefix: string | null;
  content_type: string;
}

function toSet(row: RawSetRow): TrickplaySet {
  return {
    id: row.id,
    mediaFileId: row.media_file_id,
    tileWidth: row.tile_width,
    tileHeight: row.tile_height,
    columns: row.columns,
    rows: row.rows,
    intervalMs: row.interval_ms,
    thumbnailCount: row.thumbnail_count,
    spriteCount: row.sprite_count,
    storagePrefix: row.storage_prefix ?? null,
    contentType: row.content_type,
  };
}

const SET_COLUMNS = `
  id, media_file_id, tile_width, tile_height, columns, rows,
  interval_ms, thumbnail_count, sprite_count, storage_prefix, content_type
`;

export interface CreateTrickplayServiceOptions {
  pool: DatabasePool;
  catalogue: CatalogueRepository;
  mediaRoot: string;
  /**
   * The old central tree, `<generatedStoragePath>/trickplay/<uuid>/`.
   *
   * Nothing is ever written there any more. It is still resolved so that the
   * sets which have not yet been through `trickplay:migrate` keep serving while
   * the migration is run title by title.
   */
  generatedStoragePath: string;
  ffmpegPath?: string;
  /**
   * Injected in tests so no FFmpeg process is spawned.
   *
   * `onFrame` receives the sampler's own zero-based frame index as each frame
   * is announced; a runner that cannot report one simply never calls it.
   */
  runFfmpeg?: (
    args: string[],
    onFrame?: (index: number) => void,
  ) => Promise<void>;
  /**
   * Whether the configured FFmpeg has a given filter. Probed once and cached;
   * injected in tests so no process is spawned.
   */
  hasFilter?: (name: string) => Promise<boolean>;
  /**
   * The package a title was built into, for when its source is gone.
   *
   * A fully processed title keeps only its adaptive package, so the highest
   * rendition is the best picture left to sample. Without this, such a title
   * can never have sheets at all.
   */
  findPackagedVideo?: RenditionService["findPackagedVideo"];
}

export function createTrickplayService({
  pool,
  catalogue,
  mediaRoot,
  generatedStoragePath,
  ffmpegPath = "ffmpeg",
  runFfmpeg,
  hasFilter,
  findPackagedVideo,
}: CreateTrickplayServiceOptions): TrickplayService {
  const legacyTrickplayRoot = path.join(generatedStoragePath, "trickplay");
  const resolvedMediaRoot = path.resolve(mediaRoot);

  /*
   * The filter list, asked for once.
   *
   * `zscale` is the linearisation step every correct PQ/HLG conversion needs,
   * and an FFmpeg built without libzimg simply does not have it — the graph
   * then fails to parse, which without this check reads as a generic
   * "Trickplay generation failed." on a quarter of a library.
   */
  let filters: Promise<Set<string>> | undefined;
  const listFilters = (): Promise<Set<string>> => {
    filters ??= new Promise<Set<string>>((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-filters"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      /*
       * Not an empty list. A binary that cannot be started has said nothing
       * about its filters, and reading it as "no zscale" reported a missing
       * FFmpeg as an unsupported HDR title — permanently, since the answer
       * was cached. Uncached, so the next job asks again.
       */
      child.on("error", () => {
        filters = undefined;
        reject(new Error("FFmpeg could not be started."));
      });
      child.on("close", () =>
        resolve(
          new Set(
            output
              .split("\n")
              .map((line) => line.trim().split(/\s+/)[1] ?? "")
              .filter(Boolean),
          ),
        ),
      );
    });
    return filters;
  };
  const filterAvailable =
    hasFilter ?? (async (name: string) => (await listFilters()).has(name));

  const execute =
    runFfmpeg ??
    ((args: string[], onFrame?: (index: number) => void) =>
      new Promise<void>((resolve, reject) => {
        // Argument array only — never a shell string, so a filename containing
        // shell metacharacters cannot become a command.
        const child = spawn(ffmpegPath, args, {
          stdio: ["ignore", "ignore", "pipe"],
        });
        /*
         * A sprite sheet decodes the whole file to sample it, so this is the
         * one path here that can hold every performance core for minutes while
         * nobody is waiting for the result. It runs behind the interface for
         * the same reason the encodes do; see BACKGROUND_PROCESS_NICENESS.
         */
        if (child.pid !== undefined) {
          try {
            setPriority(child.pid, BACKGROUND_PROCESS_NICENESS);
          } catch {
            // Already gone, or a platform that will not reprioritise.
          }
        }
        let stderr = "";
        /*
         * Whatever has arrived since the last newline.
         *
         * The announcements are read line by line and a chunk boundary falls
         * wherever the pipe happens to break, so a line held here is a line
         * that has not been announced yet rather than one to be dropped.
         */
        let pending = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr = (stderr + text).slice(-2_000);
          if (!onFrame) return;
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const index = frameIndexFromAnnouncement(line);
            if (index !== null) onFrame(index);
          }
        });
        child.on("error", () =>
          reject(new Error("FFmpeg could not be started.")),
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          // The stderr tail carries the source path, so it is deliberately not
          // included in the error that reaches a job record — only a fixed
          // sentence chosen from it.
          else reject(new Error(trickplayFailureMessage(stderr)));
        });
      }));

  async function findByMediaFile(
    mediaFileId: string,
  ): Promise<TrickplaySet | null> {
    const result = await pool.query<RawSetRow>(
      `SELECT ${SET_COLUMNS} FROM trickplay_sets WHERE media_file_id = $1 LIMIT 1`,
      [mediaFileId],
    );
    const row = result.rows[0];
    return row ? toSet(row) : null;
  }

  /** The original this title was built from, as the filesystem spells it. */
  function sourcePathOf(file: MediaFileRow): string {
    return path.resolve(resolvedMediaRoot, ...file.relativePath.split("/"));
  }

  /**
   * The source while it is on disk; the package once packaging consumed it.
   *
   * The source wins whenever it is there, for the reason on
   * `isGeneratedMediaPath`. Only a title with nothing else left is sampled
   * from its own highest rendition — a copy, but the copy the viewer watches.
   */
  async function samplingInputFor(
    file: MediaFileRow,
  ): Promise<SamplingInput | null> {
    const sourcePath = sourcePathOf(file);
    const probed = file.probeState === "probed" && file.durationMs !== null;
    const sourcePresent = await stat(sourcePath).then(
      (stats) => stats.isFile(),
      () => false,
    );

    const fromSource = async (): Promise<SamplingInput | null> => {
      const streams = await catalogue.listStreams(file.id);
      const video: MediaStreamRow | undefined = streams.find(
        (stream) => stream.kind === "video",
      );
      if (!video?.width || !video.height) return null;
      return {
        path: sourcePath,
        // The very stream the layout and the colour decision were made from,
        // named by index so a cover-art picture cannot be sampled instead.
        map: `0:${video.streamIndex}`,
        durationMs: Number(file.durationMs),
        width: video.width,
        height: video.height,
        colorTransfer: video.colorTransfer,
        colorPrimaries: video.colorPrimaries,
      };
    };

    if (probed && sourcePresent) return fromSource();

    if (!sourcePresent && findPackagedVideo) {
      const packaged = await findPackagedVideo({
        mediaId: file.id,
        filePath: sourcePath,
        size: Number(file.sizeBytes),
        mtimeMs: Number(file.mtimeMs),
      });
      if (packaged && packaged.durationSeconds > 0) {
        return {
          /*
           * The playlist rather than the MP4 behind it. Both decode to the
           * same frames, but the MP4 has to be walked fragment by fragment
           * before its first one — once per parallel segment — and on the
           * Drive mount that walk was minutes in which the job could report
           * nothing. See `PackagedVideo.playlistPath`.
           */
          path: packaged.playlistPath,
          isPackagePlaylist: true,
          // A rendition carries exactly one video stream.
          map: "0:v:0",
          durationMs: Math.round(packaged.durationSeconds * 1_000),
          width: packaged.width,
          height: packaged.height,
          colorTransfer: packaged.colorTransfer,
          colorPrimaries: packaged.colorPrimaries,
        };
      }
    }

    /*
     * Not the source path regardless. A probed title whose source is gone and
     * whose package is not (or no longer) recorded as ready used to fall
     * through to it, and FFmpeg was handed a file that does not exist.
     */
    if (!sourcePresent) throw new Error(TRICKPLAY_NOTHING_TO_SAMPLE);
    return probed ? fromSource() : null;
  }

  /**
   * The one place a title's trickplay directory is decided.
   *
   * The kind comes from the catalogue rather than from the shape of the path,
   * because a path cannot tell a movie folder from a season folder — the same
   * reason the packager asks. Everything else is the shared resolver, so a
   * title's sheets land beside the very `video/` and `audio/` its package
   * published, and a library that is reorganised afterwards keeps them.
   *
   * The containment check is not decoration. This directory is created, swapped
   * and deleted; a source path that resolved outside the media root — through a
   * `..` in a catalogued relative path, or a symlinked library folder — would
   * point all three of those operations somewhere nobody asked for.
   */
  async function trickplayDirectoryForFile(
    file: MediaFileRow,
  ): Promise<{ titleRoot: string; directory: string } | null> {
    const sourcePath = sourcePathOf(file);
    if (!isInsideDirectory(resolvedMediaRoot, sourcePath)) return null;

    const kind = (await catalogue.getItemKind(file.itemId)) ?? "movie";
    const titleRoot = await resolveTitleRoot(
      sourcePath,
      titleRootLayoutForKind(kind),
    );
    if (!isInsideDirectory(resolvedMediaRoot, titleRoot)) return null;

    return { titleRoot, directory: trickplayDirectoryFor(titleRoot) };
  }

  /**
   * Deletes one old UUID directory, and only if it really is one.
   *
   * A prefix is a value out of a database column. Joining it blindly would let
   * a `..` in a corrupted or hand-edited row aim `rm -r` at the tree above the
   * old storage root, so the join is resolved and checked before it is used.
   */
  async function removeLegacyDirectory(storagePrefix: string): Promise<void> {
    const directory = path.join(legacyTrickplayRoot, storagePrefix);
    if (!isInsideDirectory(legacyTrickplayRoot, directory)) return;
    if (path.resolve(directory) === path.resolve(legacyTrickplayRoot)) return;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  /**
   * Where a set's sheets are, whichever layout it is still in.
   *
   * A row that carries a `storage_prefix` has not been migrated yet, so its
   * bytes are in the old tree and that is where they are read from. Every row
   * without one — which is every row this server writes — resolves through the
   * title root. New generation and new serving both go down the second branch;
   * the first exists only so the migration can be run at leisure rather than
   * during a restart.
   */
  async function directoryForSet(set: TrickplaySet): Promise<string | null> {
    if (set.storagePrefix) {
      return path.join(legacyTrickplayRoot, set.storagePrefix);
    }
    const file = await catalogue.getFileById(set.mediaFileId);
    if (!file) return null;
    return (await trickplayDirectoryForFile(file))?.directory ?? null;
  }

  return {
    findForItem: async (itemId) => {
      const file = await catalogue.getPrimaryFile(itemId);
      return file ? findByMediaFile(file.id) : null;
    },

    findById: async (setId) => {
      const result = await pool.query<RawSetRow>(
        `SELECT ${SET_COLUMNS} FROM trickplay_sets WHERE id = $1`,
        [setId],
      );
      const row = result.rows[0];
      return row ? toSet(row) : null;
    },

    spritePath: async (set, spriteIndex) => {
      const directory = await directoryForSet(set);
      if (!directory) return null;
      const spritePath = spritePathIn(directory, spriteIndex);
      /*
       * The index reached here as digits from a URL. It is checked at the route
       * as well; this is the check that has the resolved directory in hand, and
       * is therefore the one that can actually prove the file being opened is
       * inside it.
       */
      if (!isInsideDirectory(directory, spritePath)) return null;
      return spritePath;
    },

    generateForItem: async (itemId, options = {}) => {
      const file = await catalogue.getPrimaryFile(itemId);
      if (!file) return null;
      // The catalogue only ever holds originals, but a marker item or a
      // hand-inserted row must never be able to point the sampler at a
      // rendition; the check is here because this is the sole decoder.
      if (isGeneratedMediaPath(file.relativePath)) return null;

      /*
       * Before the input is looked for, since a title with nothing left to
       * sample is now an error — and one that already has sheets has no need
       * of anything to sample.
       */
      const existing = await findByMediaFile(file.id);
      if (existing && !options.force) return existing;

      const input = await samplingInputFor(file);
      if (!input) return null;

      const placement = await trickplayDirectoryForFile(file);
      if (!placement) return null;

      const layout = buildTrickplayLayout({
        durationMs: input.durationMs,
        sourceWidth: input.width,
        sourceHeight: input.height,
      });

      /*
       * Only a caller that is listening pays for the announcements: they need
       * FFmpeg's log raised to `info`, and a pass nobody is watching has no
       * reason to say a word.
       */
      const announceFrames = options.onProgress !== undefined;
      const filterGraph = buildTrickplayFilterGraph(
        layout,
        {
          colorTransfer: input.colorTransfer,
          colorPrimaries: input.colorPrimaries,
        },
        { announceFrames },
      );
      /*
       * Checked before a directory is made or a process is spawned. Asking the
       * graph what it needs, rather than keeping a second list of which
       * sources are HDR, means the two can never disagree.
       */
      if (
        filterGraph.includes("zscale") &&
        !(await filterAvailable("zscale"))
      ) {
        throw new TrickplayUnsupportedError(
          "This title is HDR, and trickplay for HDR needs an FFmpeg built with the zscale filter (libzimg).",
        );
      }

      /*
       * FFmpeg writes here, never into the live directory.
       *
       * Staging is a sibling of the live set inside the same title folder, so
       * publication is a rename within one filesystem rather than a copy across
       * one — and so the volume that has to have room for the new sheets is the
       * volume they will live on.
       */
      const staging = trickplayStagingDirectory(placement.titleRoot);
      await prepareTrickplayStaging(staging);

      const { onProgress } = options;
      const segments = planTrickplaySegments(layout);
      /*
       * Each segment announces its own frames from its own zero, so the figure
       * the caller is given is the sum of what the segments have reached rather
       * than any one of their counters. Held here and re-summed on every
       * announcement: the segments finish at different times, and a total
       * assembled from stale halves would walk backwards.
       */
      const framesPerSegment = new Array<number>(segments.length).fill(0);

      /*
       * A package's playlist goes to FFmpeg as a decoded copy in local temp
       * storage — see `localPackagePlaylist`. Local rather than beside the
       * original, which is on the media volume, and removed however the pass
       * ends.
       */
      let localPlaylistDirectory: string | null = null;
      try {
        let inputPath = input.path;
        if (input.isPackagePlaylist) {
          localPlaylistDirectory = await mkdtemp(
            path.join(tmpdir(), "seyirlik-trickplay-"),
          );
          inputPath = path.join(
            localPlaylistDirectory,
            path.basename(input.path),
          );
          await writeFile(
            inputPath,
            localPackagePlaylist(
              await readFile(input.path, "utf8"),
              path.dirname(input.path),
            ),
          );
        }
        const outcomes = await Promise.allSettled(
          segments.map((segment, index) =>
            execute(
              [
                "-hide_banner",
                "-loglevel",
                // `showinfo` speaks at info level, so a pass that is being
                // watched has to let info through. The periodic stats line is
                // not wanted with it: it says nothing this does not, several
                // times a second.
                ...(announceFrames ? ["info", "-nostats"] : ["error"]),
                /*
                 * Before `-i`, so the seek is served by the demuxer rather than
                 * by decoding and discarding everything up to it — the same
                 * placement, for the same reason, as the rendition encoder's
                 * epochs. Omitted entirely at zero so a single-segment pass is
                 * the command this has always run.
                 */
                ...(segment.startSeconds > 0
                  ? ["-ss", segment.startSeconds.toFixed(6)]
                  : []),
                ...(segment.durationSeconds === undefined
                  ? []
                  : ["-t", segment.durationSeconds.toFixed(6)]),
                "-i",
                inputPath,
                "-map",
                input.map,
                "-vf",
                filterGraph,
                "-an",
                "-sn",
                "-pix_fmt",
                "yuvj420p",
                "-qscale:v",
                "5",
                /*
                 * The image muxer numbers from one unless told otherwise, while
                 * every reader here — `spritePath`, `tilesInSprite`, the seek
                 * bar's tile arithmetic — counts sheets from zero. Left at the
                 * default, sheet zero did not exist and the final sheet was
                 * never served. A segment starts at its own first sheet so the
                 * files it writes land in that same numbering.
                 */
                "-start_number",
                String(segment.firstSpriteIndex),
                path.join(staging, "sprite_%d.jpg"),
              ],
              onProgress
                ? (frameIndex) => {
                    // The sampler counts from zero; a frame it has announced is
                    // a frame it has finished with.
                    framesPerSegment[index] = frameIndex + 1;
                    onProgress({
                      completed: framesPerSegment.reduce(
                        (total, frames) => total + frames,
                        0,
                      ),
                      total: layout.thumbnailCount,
                    });
                  }
                : undefined,
            ),
          ),
        );
        /*
         * Settled rather than raced. A rejection from `Promise.all` would leave
         * the other segments still writing into the staging directory the
         * failure path is about to remove — so every segment is waited for, and
         * only then is the first failure raised.
         */
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        if (failure) throw failure.reason;
      } catch (error) {
        await discardTrickplayStaging(staging);
        throw error;
      } finally {
        if (localPlaylistDirectory) {
          await rm(localPlaylistDirectory, {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
      }

      /*
       * The bytes are proven before anything else moves. A process that exited
       * zero having written four sheets of an expected five, or a sheet that is
       * a zero-byte file because the volume filled, must not become a row that
       * tells the seek bar those tiles exist.
       */
      let validated;
      try {
        validated = await validateTrickplayOutput(staging, layout);
      } catch (error) {
        await discardTrickplayStaging(staging);
        throw error;
      }

      let published;
      try {
        published = await publishTrickplayDirectory(
          placement.titleRoot,
          staging,
        );
      } catch (error) {
        await discardTrickplayStaging(staging);
        throw error;
      }

      /*
       * The row is written to describe what validation just counted, not what
       * the layout predicted. `storage_prefix` goes in as NULL: there is no
       * address to record any more, and a null is what tells the migration
       * command this set is already where it belongs.
       */
      try {
        const inserted = await pool.query<RawSetRow>(
          `INSERT INTO trickplay_sets (
             id, media_file_id, tile_width, tile_height, columns, rows,
             interval_ms, thumbnail_count, sprite_count, storage_prefix
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
           /*
            * Regeneration must replace the geometry as well as the directory.
            * Carrying the old tile height or interval next to new sheets is how
            * a seek bar comes to draw the wrong frame: the row is what the
            * client computes tile offsets from, and it has to describe the
            * sprites that are actually on disk.
            */
           ON CONFLICT (media_file_id, tile_width) DO UPDATE SET
             storage_prefix = NULL,
             tile_height = EXCLUDED.tile_height,
             columns = EXCLUDED.columns,
             rows = EXCLUDED.rows,
             interval_ms = EXCLUDED.interval_ms,
             thumbnail_count = EXCLUDED.thumbnail_count,
             sprite_count = EXCLUDED.sprite_count
           RETURNING ${SET_COLUMNS}`,
          [
            randomUUID(),
            file.id,
            layout.tileWidth,
            layout.tileHeight,
            layout.columns,
            layout.rows,
            layout.intervalMs,
            validated.thumbnailCount,
            validated.spriteCount,
          ],
        );

        const row = inserted.rows[0];
        if (!row) throw new Error("The trickplay row was not written.");

        await commitPublishedTrickplay(published);

        /*
         * A regenerated set that used to live in the old tree leaves its UUID
         * directory behind. It is removed only here, with the replacement
         * already live and recorded — never before.
         */
        if (existing?.storagePrefix) {
          await removeLegacyDirectory(existing.storagePrefix);
        }

        return toSet(row);
      } catch (error) {
        // The row did not land, so the sheets in the title folder describe
        // nothing. Put the previous set back rather than leaving the folder and
        // the database disagreeing about the geometry.
        await rollbackPublishedTrickplay(published);
        throw error;
      }
    },

    listGeneratedMediaFileIds: async (mediaFileIds) => {
      if (mediaFileIds.length === 0) return new Set<string>();
      const result = await pool.query<{ media_file_id: string }>(
        `SELECT media_file_id FROM trickplay_sets
          WHERE media_file_id = ANY($1::uuid[])`,
        [[...mediaFileIds]],
      );
      return new Set(result.rows.map((row) => row.media_file_id));
    },

    /**
     * Removes a title's own sheets and the row that describes them.
     *
     * The only directory this may ever delete is `<titleRoot>/trickplay` —
     * resolved through the shared resolver, proven to be inside the media root,
     * and named exactly. It is deliberately not a search for anything matching
     * "trickplay": the media volume holds hundreds of `<title>.trickplay`
     * folders that belong to a different era and to a person's archive, and it
     * holds `video/`, `audio/`, `subtitle/`, `content/` and `.seyirlik/` beside
     * the directory being removed.
     */
    deleteForItem: async (itemId) => {
      const file = await catalogue.getPrimaryFile(itemId);
      if (!file) return;

      const existing = await findByMediaFile(file.id);
      if (!existing) return;

      await pool.query(`DELETE FROM trickplay_sets WHERE id = $1`, [
        existing.id,
      ]);

      if (existing.storagePrefix) {
        await removeLegacyDirectory(existing.storagePrefix);
        return;
      }

      const placement = await trickplayDirectoryForFile(file);
      if (!placement) return;
      await rm(placement.directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}
