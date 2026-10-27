import { createHash } from "node:crypto";
import {
  TITLE_AUDIO_DIRECTORY,
  TITLE_SOURCE_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_VIDEO_DIRECTORY,
} from "../../../renditions/adaptive/layout";
import {
  TITLE_MASTER_PLAYLIST,
  TITLE_PACKAGE_DIRECTORY,
  TITLE_PACKAGE_MANIFEST,
} from "../../../renditions/adaptive/titleLayout";
import {
  TITLE_BUILD_RECORD,
  TITLE_MANIFEST_SCHEMA_VERSION,
} from "../../../renditions/adaptive/publishTitle";
import {
  buildSortTitle,
  isBookFile,
  isExtraDirectory,
  isIgnoredEntry,
  isSampleFile,
  isSubtitleFile,
  isTrailerFile,
  isVideoFile,
  parseEpisodeName,
  parseMovieName,
  parseSeasonFolder,
  matchSubtitleSidecar,
  splitExtension,
} from "./nameParser";

export type LibraryKind =
  | "movies"
  | "series"
  | "books"
  | "collections"
  | "mixed";

export interface ScanDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Filesystem seam. Every path is relative to the media root and uses forward
 * slashes, so a scan can be exercised entirely in memory and no absolute host
 * path ever enters the scan result.
 */
export interface ScannerFileSystem {
  readDirectory(relativePath: string): Promise<ScanDirectoryEntry[]>;
  readTextFile(relativePath: string): Promise<string>;
  statFile(relativePath: string): Promise<{ size: number; mtimeMs: number }>;
}

export interface ScannedSubtitle {
  relativePath: string;
  codec: string;
  isText: boolean;
  language?: string;
  isForced: boolean;
  isDefault: boolean;
}

export interface ScannedFile {
  relativePath: string;
  container: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
}

export type ScannedItemKind =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "book"
  | "trailer";

export interface ScannedItem {
  /** Location-derived stable identity; survives re-encodes and retitling. */
  sourceKey: string;
  kind: ScannedItemKind;
  title: string;
  sortTitle: string;
  year?: number;
  indexNumber?: number;
  parentIndexNumber?: number;
  endIndexNumber?: number;
  parentSourceKey?: string;
  seriesSourceKey?: string;
  files: ScannedFile[];
  subtitles: ScannedSubtitle[];
  /**
   * A complete adaptive package exists in the title folder even though its
   * original source file does not. Reconciliation uses the existing file row as
   * the package's durable playback identity; it must never create a file-less
   * catalogue item from this marker alone.
   */
  renditionBacked?: boolean;
  /**
   * The name gave no title, so `title` is a stand-in ("Episode 4").
   *
   * Imported files are named by number alone, and a stand-in must never
   * replace a title the catalogue already holds: every scan did exactly that,
   * resetting each episode's provider title to "Episode N" ten minutes after
   * the metadata refresh wrote it.
   */
  titleIsPlaceholder?: boolean;
  /**
   * The folder holding that package, when there is one.
   *
   * Only a movie's package directory can be recovered from its `sourceKey`; an
   * episode's key is `series:season:episode` and names no path at all. Anything
   * that has to open the manifest — a migration recovering the source identity
   * of a title whose bytes are gone — would otherwise have to guess, so the
   * scanner reports the directory it actually looked in.
   */
  packageDirectory?: string;
}

export interface ScanSkip {
  relativePath: string;
  reason: "unsupported-extension" | "sample" | "unreadable" | "depth-limit";
}

export interface ScanResult {
  items: ScannedItem[];
  skipped: ScanSkip[];
}

const MAX_SCAN_DEPTH = 12;
const MAX_TITLE_MANIFEST_BYTES = 1_048_576;

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

interface PackageAsset {
  id: string;
  mediaPath: string;
  playlistPath: string;
  fileSizeBytes: number;
}

interface PackageManifestShape {
  schemaVersion: number;
  profileVersion: string;
  sourceFingerprint: string;
  createdAt: string;
  sourceDurationSeconds: number;
  masterPlaylistPath: string;
  video: PackageAsset[];
  audio: PackageAsset[];
  subtitle: PackageAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePackagePath(relativePath: string): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    return false;
  }
  return relativePath
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

function pathStartsIn(relativePath: string, directory: string): boolean {
  return relativePath.startsWith(`${directory}/`);
}

function parsePackageAssets(
  value: unknown,
  mediaDirectory: string,
): PackageAsset[] | null {
  if (!Array.isArray(value)) return null;
  const assets: PackageAsset[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.mediaPath !== "string" ||
      typeof entry.playlistPath !== "string" ||
      typeof entry.fileSizeBytes !== "number" ||
      !Number.isSafeInteger(entry.fileSizeBytes) ||
      entry.fileSizeBytes <= 0 ||
      !isSafeRelativePackagePath(entry.mediaPath) ||
      !isSafeRelativePackagePath(entry.playlistPath) ||
      entry.mediaPath === entry.playlistPath ||
      !pathStartsIn(entry.mediaPath, mediaDirectory) ||
      !pathStartsIn(
        entry.playlistPath,
        `${TITLE_PACKAGE_DIRECTORY}/${mediaDirectory}`,
      )
    ) {
      return null;
    }
    assets.push({
      id: entry.id,
      mediaPath: entry.mediaPath,
      playlistPath: entry.playlistPath,
      fileSizeBytes: entry.fileSizeBytes,
    });
  }
  return assets;
}

function buildRecordMatchesPackage(
  value: unknown,
  manifest: PackageManifestShape,
): boolean {
  if (
    !isRecord(value) ||
    value.profileVersion !== manifest.profileVersion ||
    value.sourceFingerprint !== manifest.sourceFingerprint ||
    value.createdAt !== manifest.createdAt ||
    value.sourceDurationSeconds !== manifest.sourceDurationSeconds ||
    value.masterPlaylistPath !== manifest.masterPlaylistPath
  ) {
    return false;
  }

  const groups: Array<{
    published: PackageAsset[];
    built: unknown;
    buildMediaField: "mediaPath" | "subtitlePath";
  }> = [
    {
      published: manifest.video,
      built: value.videoRenditions,
      buildMediaField: "mediaPath",
    },
    {
      published: manifest.audio,
      built: value.audioRenditions,
      buildMediaField: "mediaPath",
    },
    {
      published: manifest.subtitle,
      built: value.subtitleRenditions,
      buildMediaField: "subtitlePath",
    },
  ];

  for (const { published, built, buildMediaField } of groups) {
    if (!Array.isArray(built) || built.length !== published.length)
      return false;
    const builtById = new Map(
      built
        .filter(isRecord)
        .map((entry) => [entry.id, entry] as const)
        .filter(([id]) => typeof id === "string"),
    );
    if (builtById.size !== published.length) return false;
    for (const rendition of published) {
      const builtRendition = builtById.get(rendition.id);
      if (
        builtRendition?.[buildMediaField] !== rendition.mediaPath ||
        builtRendition.playlistPath !== rendition.playlistPath ||
        builtRendition.fileSizeBytes !== rendition.fileSizeBytes
      ) {
        return false;
      }
    }
  }
  return true;
}

function parsePackageManifest(value: unknown): PackageManifestShape | null {
  if (!isRecord(value)) return null;
  const video = parsePackageAssets(value.video, TITLE_VIDEO_DIRECTORY);
  const audio = parsePackageAssets(value.audio, TITLE_AUDIO_DIRECTORY);
  const subtitle = parsePackageAssets(value.subtitle, TITLE_SUBTITLE_DIRECTORY);
  if (
    value.schemaVersion !== TITLE_MANIFEST_SCHEMA_VERSION ||
    typeof value.profileVersion !== "string" ||
    value.profileVersion.length === 0 ||
    typeof value.sourceFingerprint !== "string" ||
    value.sourceFingerprint.length === 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.sourceDurationSeconds !== "number" ||
    !Number.isFinite(value.sourceDurationSeconds) ||
    value.sourceDurationSeconds <= 0 ||
    typeof value.masterPlaylistPath !== "string" ||
    value.masterPlaylistPath !==
      `${TITLE_PACKAGE_DIRECTORY}/${TITLE_MASTER_PLAYLIST}` ||
    video === null ||
    video.length === 0 ||
    audio === null ||
    audio.length === 0 ||
    subtitle === null
  ) {
    return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    profileVersion: value.profileVersion,
    sourceFingerprint: value.sourceFingerprint,
    createdAt: value.createdAt,
    sourceDurationSeconds: value.sourceDurationSeconds,
    masterPlaylistPath: value.masterPlaylistPath,
    video,
    audio,
    subtitle,
  };
}

/**
 * A package can stand in for its removed source only after every published
 * playlist and media asset has survived intact. Merely finding package.json is
 * not enough: interrupted publishing and manual file removal must remain visible
 * as missing media rather than producing a broken catalogue entry.
 */
async function hasCompleteTitlePackage(
  fs: ScannerFileSystem,
  titleDirectory: string,
): Promise<boolean> {
  const manifestPath = joinRelative(
    joinRelative(titleDirectory, TITLE_PACKAGE_DIRECTORY),
    TITLE_PACKAGE_MANIFEST,
  );
  const buildRecordPath = joinRelative(
    joinRelative(titleDirectory, TITLE_PACKAGE_DIRECTORY),
    TITLE_BUILD_RECORD,
  );
  try {
    const [manifestStat, buildRecordStat] = await Promise.all([
      fs.statFile(manifestPath),
      fs.statFile(buildRecordPath),
    ]);
    if (
      manifestStat.size <= 0 ||
      manifestStat.size > MAX_TITLE_MANIFEST_BYTES ||
      buildRecordStat.size <= 0 ||
      buildRecordStat.size > MAX_TITLE_MANIFEST_BYTES
    ) {
      return false;
    }
    const [manifestText, buildRecordText] = await Promise.all([
      fs.readTextFile(manifestPath),
      fs.readTextFile(buildRecordPath),
    ]);
    const manifest = parsePackageManifest(JSON.parse(manifestText) as unknown);
    if (!manifest) return false;
    if (
      !buildRecordMatchesPackage(
        JSON.parse(buildRecordText) as unknown,
        manifest,
      )
    ) {
      return false;
    }

    const expectedSizes = new Map<string, number | null>();
    expectedSizes.set(manifest.masterPlaylistPath, null);
    for (const rendition of [
      ...manifest.video,
      ...manifest.audio,
      ...manifest.subtitle,
    ]) {
      if (
        expectedSizes.has(rendition.mediaPath) ||
        expectedSizes.has(rendition.playlistPath)
      ) {
        return false;
      }
      expectedSizes.set(rendition.mediaPath, rendition.fileSizeBytes);
      expectedSizes.set(rendition.playlistPath, null);
    }

    for (const [relativePath, expectedSize] of expectedSizes) {
      const stat = await fs.statFile(
        joinRelative(titleDirectory, relativePath),
      );
      if (
        stat.size <= 0 ||
        (expectedSize !== null && stat.size !== expectedSize)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function buildFingerprint(
  relativePath: string,
  size: number,
  mtimeMs: number,
): string {
  return createHash("sha256")
    .update(relativePath)
    .update("\0")
    .update(String(size))
    .update("\0")
    .update(String(Math.trunc(mtimeMs)))
    .digest("hex")
    .slice(0, 32);
}

function sourceKey(kind: string, ...parts: Array<string | number>): string {
  return `${kind}:${parts.map((part) => String(part).toLowerCase()).join(":")}`;
}

async function toScannedFile(
  fs: ScannerFileSystem,
  relativePath: string,
  skipped: ScanSkip[],
): Promise<ScannedFile | null> {
  try {
    const stat = await fs.statFile(relativePath);
    return {
      relativePath,
      container: splitExtension(relativePath).extension,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fingerprint: buildFingerprint(relativePath, stat.size, stat.mtimeMs),
    };
  } catch {
    skipped.push({ relativePath, reason: "unreadable" });
    return null;
  }
}

/**
 * A file a folder owns, and where it actually is.
 *
 * The two differ once a library has been organised: the naming rules are read
 * from `name`, which is unchanged by the move, while `relativePath` points into
 * the `src/` bucket the bytes were moved to. Keeping both is what lets a
 * source folder be introduced without changing a single title's identity.
 */
interface DirectoryFile {
  name: string;
  relativePath: string;
}

interface DirectoryContents {
  directories: string[];
  videoFiles: DirectoryFile[];
  bookFiles: DirectoryFile[];
  subtitleFiles: DirectoryFile[];
}

function sortByName(files: DirectoryFile[]): void {
  files.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

/**
 * The files in one directory, sorted, with anything unusable recorded.
 *
 * `src/` is not returned as a subdirectory: its files are folded into the
 * folder above as if they had never been moved, which is exactly how the rest
 * of the scanner — and every source key it derives — sees them.
 */
async function readDirectoryContents(
  fs: ScannerFileSystem,
  relativePath: string,
  skipped: ScanSkip[],
): Promise<DirectoryContents> {
  const contents: DirectoryContents = {
    directories: [],
    videoFiles: [],
    bookFiles: [],
    subtitleFiles: [],
  };

  let sourceDirectory: string | undefined;

  const collect = async (directory: string): Promise<void> => {
    let entries: ScanDirectoryEntry[];
    try {
      entries = await fs.readDirectory(directory);
    } catch {
      skipped.push({ relativePath: directory, reason: "unreadable" });
      return;
    }

    for (const entry of entries) {
      if (isIgnoredEntry(entry.name)) continue;

      if (entry.isDirectory) {
        // Only the folder's own `src/` is folded in; one nested inside it is a
        // directory like any other and is left alone.
        if (
          directory === relativePath &&
          entry.name.toLowerCase() === TITLE_SOURCE_DIRECTORY
        ) {
          sourceDirectory = joinRelative(relativePath, entry.name);
          continue;
        }
        if (directory === relativePath) contents.directories.push(entry.name);
        continue;
      }

      const file: DirectoryFile = {
        name: entry.name,
        relativePath: joinRelative(directory, entry.name),
      };

      const { stem } = splitExtension(entry.name);
      if (isSampleFile(stem)) {
        skipped.push({ relativePath: file.relativePath, reason: "sample" });
        continue;
      }

      if (isVideoFile(entry.name)) contents.videoFiles.push(file);
      else if (isBookFile(entry.name)) contents.bookFiles.push(file);
      else if (isSubtitleFile(entry.name)) contents.subtitleFiles.push(file);
      else {
        skipped.push({
          relativePath: file.relativePath,
          reason: "unsupported-extension",
        });
      }
    }
  };

  await collect(relativePath);
  if (sourceDirectory !== undefined) await collect(sourceDirectory);

  contents.directories.sort();
  sortByName(contents.videoFiles);
  sortByName(contents.bookFiles);
  sortByName(contents.subtitleFiles);
  return contents;
}

function matchSubtitles(
  subtitleFiles: DirectoryFile[],
  videoStem: string,
): ScannedSubtitle[] {
  const matches: ScannedSubtitle[] = [];

  for (const subtitleFile of subtitleFiles) {
    const { stem, extension } = splitExtension(subtitleFile.name);
    const parsed = matchSubtitleSidecar(stem, videoStem);
    if (!parsed) continue;

    const format =
      extension === "srt"
        ? { codec: "subrip", isText: true }
        : extension === "vtt"
          ? { codec: "webvtt", isText: true }
          : extension === "ass" || extension === "ssa"
            ? { codec: extension, isText: true }
            : extension === "sup"
              ? { codec: "hdmv_pgs_subtitle", isText: false }
              : { codec: extension, isText: true };

    matches.push({
      relativePath: subtitleFile.relativePath,
      codec: format.codec,
      isText: format.isText,
      ...(parsed.language === undefined ? {} : { language: parsed.language }),
      isForced: parsed.isForced,
      isDefault: parsed.isDefault,
    });
  }

  return matches;
}

/** Video files deliberately placed in a title's canonical trailer directory. */
async function canonicalTrailerPaths(
  fs: ScannerFileSystem,
  titleDirectory: string,
  skipped: ScanSkip[],
): Promise<string[]> {
  const trailerDirectory = joinRelative(
    joinRelative(titleDirectory, "content"),
    "trailers",
  );
  let entries: ScanDirectoryEntry[];
  try {
    entries = await fs.readDirectory(trailerDirectory);
  } catch {
    // Most titles have no trailer directory; absence is not a scan warning.
    return [];
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || isIgnoredEntry(entry.name)) continue;
    const relativePath = joinRelative(trailerDirectory, entry.name);
    const { stem } = splitExtension(entry.name);
    if (isSampleFile(stem)) {
      skipped.push({ relativePath, reason: "sample" });
    } else if (isVideoFile(entry.name)) {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

/**
 * A folder holding several videos for the same title (a 4K cut plus a 1080p
 * cut, or a two-disc rip) is one logical movie with several files. Distinct
 * titles in one folder are only treated as separate movies when the folder is
 * a container rather than a title folder — that decision is made by the caller.
 */
function buildMovieItem(
  keyPath: string,
  displayName: string,
  files: ScannedFile[],
  subtitles: ScannedSubtitle[],
): ScannedItem {
  const parsed = parseMovieName(displayName);
  return {
    sourceKey: sourceKey("movie", keyPath),
    kind: "movie",
    title: parsed.title,
    sortTitle: buildSortTitle(parsed.title),
    ...(parsed.year === undefined ? {} : { year: parsed.year }),
    // Largest file first: the primary source should be the best available cut.
    files: [...files].sort((left, right) => right.size - left.size),
    subtitles,
  };
}

async function scanMovieDirectory(
  fs: ScannerFileSystem,
  directory: string,
  depth: number,
  result: ScanResult,
  isLibraryRoot: boolean,
  recurseIntoSubdirectories = true,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    result.skipped.push({ relativePath: directory, reason: "depth-limit" });
    return;
  }

  const contents = await readDirectoryContents(fs, directory, result.skipped);
  const trailerPaths: string[] = [];
  const featureFiles: DirectoryFile[] = [];

  for (const videoFile of contents.videoFiles) {
    const { stem } = splitExtension(videoFile.name);
    if (isTrailerFile(stem)) trailerPaths.push(videoFile.relativePath);
    else featureFiles.push(videoFile);
  }
  trailerPaths.push(
    ...(await canonicalTrailerPaths(fs, directory, result.skipped)),
  );

  if (featureFiles.length > 0) {
    // Several files in one title folder are alternate cuts of the same movie —
    // but only when they parse to the same title. A folder holding "Movie A"
    // and "Movie B" is a container, not a title, and must not collapse into one
    // item.
    const distinctTitles = new Set(
      featureFiles.map((file) =>
        parseMovieName(splitExtension(file.name).stem).title.toLowerCase(),
      ),
    );
    const isTitleFolder = !isLibraryRoot && distinctTitles.size <= 1;

    const groups = isTitleFolder
      ? [
          {
            keyPath: directory,
            displayName: directory.split("/").pop() ?? directory,
            members: featureFiles,
          },
        ]
      : featureFiles.map((member) => ({
          keyPath: joinRelative(directory, splitExtension(member.name).stem),
          displayName: splitExtension(member.name).stem,
          members: [member],
        }));

    for (const group of groups) {
      const files: ScannedFile[] = [];
      const subtitles: ScannedSubtitle[] = [];

      for (const member of group.members) {
        const file = await toScannedFile(
          fs,
          member.relativePath,
          result.skipped,
        );
        if (!file) continue;
        files.push(file);
        subtitles.push(
          ...matchSubtitles(
            contents.subtitleFiles,
            splitExtension(member.name).stem,
          ),
        );
      }

      if (files.length === 0) continue;
      const movie = buildMovieItem(
        group.keyPath,
        group.displayName,
        files,
        subtitles,
      );
      result.items.push(movie);

      for (const trailerPath of trailerPaths) {
        const trailerFile = await toScannedFile(
          fs,
          trailerPath,
          result.skipped,
        );
        if (!trailerFile) continue;
        result.items.push({
          sourceKey: sourceKey("trailer", trailerFile.relativePath),
          kind: "trailer",
          title: `${movie.title} (Trailer)`,
          sortTitle: buildSortTitle(movie.title),
          parentSourceKey: movie.sourceKey,
          files: [trailerFile],
          subtitles: [],
        });
      }
      // Trailers belong to the first group only; a root-level loose-file layout
      // has no folder-scoped trailer to share.
      trailerPaths.length = 0;
    }
  } else if (!isLibraryRoot && (await hasCompleteTitlePackage(fs, directory))) {
    const displayName = directory.split("/").pop() ?? directory;
    result.items.push({
      ...buildMovieItem(
        directory,
        displayName,
        [],
        matchSubtitles(contents.subtitleFiles, displayName),
      ),
      renditionBacked: true,
      packageDirectory: directory,
    });
  }

  if (!recurseIntoSubdirectories) return;

  for (const child of contents.directories) {
    if (isExtraDirectory(child)) continue;
    await scanMovieDirectory(
      fs,
      joinRelative(directory, child),
      depth + 1,
      result,
      false,
    );
  }
}

async function scanEpisodeFiles(
  fs: ScannerFileSystem,
  directory: string,
  contents: DirectoryContents,
  context: {
    seriesKey: string;
    seriesTitle: string;
    folderSeasonNumber?: number;
  },
  result: ScanResult,
  seasonKeys: Map<number, ScannedItem>,
): Promise<void> {
  /** The season row an episode hangs from, created once per season number. */
  const ensureSeason = (seasonNumber: number): ScannedItem => {
    const existing = seasonKeys.get(seasonNumber);
    if (existing) return existing;
    const season: ScannedItem = {
      sourceKey: sourceKey("season", context.seriesKey, seasonNumber),
      kind: "season",
      title: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
      sortTitle: String(seasonNumber).padStart(4, "0"),
      indexNumber: seasonNumber,
      parentSourceKey: context.seriesKey,
      seriesSourceKey: context.seriesKey,
      files: [],
      subtitles: [],
    };
    seasonKeys.set(seasonNumber, season);
    result.items.push(season);
    return season;
  };

  for (const videoFile of contents.videoFiles) {
    const { stem } = splitExtension(videoFile.name);
    if (isTrailerFile(stem)) continue;

    const parsed = parseEpisodeName(stem, {
      ...(context.folderSeasonNumber === undefined
        ? {}
        : { folderSeasonNumber: context.folderSeasonNumber }),
      folderSeriesTitle: context.seriesTitle,
    });

    const file = await toScannedFile(
      fs,
      videoFile.relativePath,
      result.skipped,
    );
    if (!file) continue;

    // Without a season the episode cannot be placed in the hierarchy; season 1
    // is the conventional default for a flat series folder.
    const seasonNumber = parsed.seasonNumber ?? 1;
    const season = ensureSeason(seasonNumber);

    const episodeNumber = parsed.episodeNumber;
    const episodeKey =
      episodeNumber === undefined
        ? sourceKey("episode", context.seriesKey, file.relativePath)
        : sourceKey("episode", context.seriesKey, seasonNumber, episodeNumber);

    const existing = result.items.find(
      (item) => item.kind === "episode" && item.sourceKey === episodeKey,
    );
    if (existing) {
      // A second file for the same episode is an alternate cut, not a duplicate.
      existing.files.push(file);
      existing.files.sort((left, right) => right.size - left.size);
      existing.subtitles.push(...matchSubtitles(contents.subtitleFiles, stem));
      continue;
    }

    result.items.push({
      sourceKey: episodeKey,
      kind: "episode",
      title: parsed.title,
      ...(parsed.episodeTitle ? {} : { titleIsPlaceholder: true }),
      sortTitle: `${String(seasonNumber).padStart(4, "0")}-${String(
        episodeNumber ?? 0,
      ).padStart(5, "0")}`,
      ...(episodeNumber === undefined ? {} : { indexNumber: episodeNumber }),
      parentIndexNumber: seasonNumber,
      ...(parsed.endEpisodeNumber === undefined
        ? {}
        : { endIndexNumber: parsed.endEpisodeNumber }),
      parentSourceKey: season.sourceKey,
      seriesSourceKey: context.seriesKey,
      files: [file],
      subtitles: matchSubtitles(contents.subtitleFiles, stem),
    });
  }

  /*
   * An episode whose source has been removed but whose package is still there.
   *
   * A movie in that state is recognised by its own folder holding a complete
   * package and no video file. An episode's package lives in a folder named
   * after the source file it was built from — `Season 1/Show - S01E01 - Kassa/`
   * — so the same rule applies one level down, to the season folder's
   * children. Without this, deleting a processed episode's source makes the
   * episode vanish from the catalogue at the next scan and takes the package's
   * only playback identity with it.
   *
   * Reconciliation drops any of these that has no existing file row, so this
   * can revive a known episode and can never invent one.
   */
  for (const child of contents.directories) {
    if (isExtraDirectory(child)) continue;

    const childPath = joinRelative(directory, child);
    if (!(await hasCompleteTitlePackage(fs, childPath))) continue;

    const parsed = parseEpisodeName(child, {
      ...(context.folderSeasonNumber === undefined
        ? {}
        : { folderSeasonNumber: context.folderSeasonNumber }),
      folderSeriesTitle: context.seriesTitle,
    });
    const seasonNumber = parsed.seasonNumber ?? 1;
    const episodeNumber = parsed.episodeNumber;
    const episodeKey =
      episodeNumber === undefined
        ? sourceKey("episode", context.seriesKey, childPath)
        : sourceKey("episode", context.seriesKey, seasonNumber, episodeNumber);

    // The source is back, or was never gone. The real file wins.
    if (
      result.items.some(
        (item) => item.kind === "episode" && item.sourceKey === episodeKey,
      )
    ) {
      continue;
    }

    const season = ensureSeason(seasonNumber);
    result.items.push({
      sourceKey: episodeKey,
      kind: "episode",
      title: parsed.title,
      ...(parsed.episodeTitle ? {} : { titleIsPlaceholder: true }),
      sortTitle: `${String(seasonNumber).padStart(4, "0")}-${String(
        episodeNumber ?? 0,
      ).padStart(5, "0")}`,
      ...(episodeNumber === undefined ? {} : { indexNumber: episodeNumber }),
      parentIndexNumber: seasonNumber,
      parentSourceKey: season.sourceKey,
      seriesSourceKey: context.seriesKey,
      files: [],
      subtitles: matchSubtitles(contents.subtitleFiles, child),
      renditionBacked: true,
      packageDirectory: childPath,
    });
  }
}

async function scanSeriesFolder(
  fs: ScannerFileSystem,
  directory: string,
  result: ScanResult,
): Promise<void> {
  const folderName = directory.split("/").pop() ?? directory;
  const parsed = parseMovieName(folderName);
  const seriesKey = sourceKey("series", directory);

  const series: ScannedItem = {
    sourceKey: seriesKey,
    kind: "series",
    title: parsed.title,
    sortTitle: buildSortTitle(parsed.title),
    ...(parsed.year === undefined ? {} : { year: parsed.year }),
    files: [],
    subtitles: [],
  };
  result.items.push(series);

  const seasonKeys = new Map<number, ScannedItem>();
  const rootContents = await readDirectoryContents(
    fs,
    directory,
    result.skipped,
  );

  const trailerPaths = [
    ...rootContents.videoFiles
      .filter((videoFile) => isTrailerFile(splitExtension(videoFile.name).stem))
      .map((videoFile) => videoFile.relativePath),
    ...(await canonicalTrailerPaths(fs, directory, result.skipped)),
  ];
  for (const trailerPath of trailerPaths) {
    const trailerFile = await toScannedFile(fs, trailerPath, result.skipped);
    if (!trailerFile) continue;
    result.items.push({
      sourceKey: sourceKey("trailer", trailerFile.relativePath),
      kind: "trailer",
      title: `${series.title} (Trailer)`,
      sortTitle: series.sortTitle,
      parentSourceKey: series.sourceKey,
      seriesSourceKey: series.sourceKey,
      files: [trailerFile],
      subtitles: [],
    });
  }

  // Episodes sitting directly in the series folder (flat layout).
  await scanEpisodeFiles(
    fs,
    directory,
    rootContents,
    { seriesKey, seriesTitle: parsed.title },
    result,
    seasonKeys,
  );

  for (const child of rootContents.directories) {
    if (isExtraDirectory(child)) continue;

    const childPath = joinRelative(directory, child);
    const seasonNumber = parseSeasonFolder(child);
    const childContents = await readDirectoryContents(
      fs,
      childPath,
      result.skipped,
    );

    await scanEpisodeFiles(
      fs,
      childPath,
      childContents,
      {
        seriesKey,
        seriesTitle: parsed.title,
        ...(seasonNumber === undefined
          ? {}
          : { folderSeasonNumber: seasonNumber }),
      },
      result,
      seasonKeys,
    );
  }

  // A series folder that yielded nothing playable is not a series.
  const hasEpisodes = result.items.some(
    (item) => item.kind === "episode" && item.seriesSourceKey === seriesKey,
  );
  if (!hasEpisodes) {
    result.items = result.items.filter(
      (item) =>
        item.sourceKey !== seriesKey && item.seriesSourceKey !== seriesKey,
    );
  }
}

async function scanBooksDirectory(
  fs: ScannerFileSystem,
  directory: string,
  depth: number,
  result: ScanResult,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    result.skipped.push({ relativePath: directory, reason: "depth-limit" });
    return;
  }

  const contents = await readDirectoryContents(fs, directory, result.skipped);

  for (const bookFile of contents.bookFiles) {
    const relativePath = bookFile.relativePath;
    const file = await toScannedFile(fs, relativePath, result.skipped);
    if (!file) continue;

    const parsed = parseMovieName(splitExtension(bookFile.name).stem);
    result.items.push({
      sourceKey: sourceKey("book", relativePath),
      kind: "book",
      title: parsed.title,
      sortTitle: buildSortTitle(parsed.title),
      ...(parsed.year === undefined ? {} : { year: parsed.year }),
      files: [file],
      subtitles: [],
    });
  }

  for (const child of contents.directories) {
    await scanBooksDirectory(
      fs,
      joinRelative(directory, child),
      depth + 1,
      result,
    );
  }
}

export interface ScanLibraryOptions {
  fileSystem: ScannerFileSystem;
  /** Library root, relative to the media root. */
  rootPath: string;
  kind: LibraryKind;
}

export async function scanLibraryTree({
  fileSystem,
  rootPath,
  kind,
}: ScanLibraryOptions): Promise<ScanResult> {
  const result: ScanResult = { items: [], skipped: [] };
  const normalizedRoot = rootPath.replace(/^\/+|\/+$/g, "");

  if (kind === "books") {
    await scanBooksDirectory(fileSystem, normalizedRoot, 0, result);
    return result;
  }

  if (kind === "series") {
    const contents = await readDirectoryContents(
      fileSystem,
      normalizedRoot,
      result.skipped,
    );
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      await scanSeriesFolder(
        fileSystem,
        joinRelative(normalizedRoot, child),
        result,
      );
    }
    return result;
  }

  if (kind === "mixed") {
    // A mixed root is scanned as movies; series folders are recognized by the
    // presence of season folders inside them.
    const contents = await readDirectoryContents(
      fileSystem,
      normalizedRoot,
      result.skipped,
    );
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      const childPath = joinRelative(normalizedRoot, child);
      const childContents = await readDirectoryContents(
        fileSystem,
        childPath,
        result.skipped,
      );
      const looksLikeSeries = childContents.directories.some(
        (grandchild) => parseSeasonFolder(grandchild) !== undefined,
      );
      if (looksLikeSeries) {
        await scanSeriesFolder(fileSystem, childPath, result);
      } else {
        await scanMovieDirectory(fileSystem, childPath, 1, result, false);
      }
    }
    // Loose files at the mixed root are movies; subdirectories were already
    // classified above, so this pass must not recurse into them again.
    await scanMovieDirectory(
      fileSystem,
      normalizedRoot,
      0,
      result,
      true,
      false,
    );
    return result;
  }

  await scanMovieDirectory(fileSystem, normalizedRoot, 0, result, true);
  return result;
}
