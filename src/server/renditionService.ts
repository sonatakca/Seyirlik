import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  PlaybackMediaResolver,
  PlaybackResolvedMedia,
} from "../lib/playback-planner/playbackRoutes";
import type {
  AudioStreamAnalysis,
  SubtitleStreamAnalysis,
  VideoStreamAnalysis,
} from "../lib/playback-planner/types";
import type {
  AvailableQualityFile,
  MediaQualityManifest,
} from "../renditions/contracts";
import {
  RENDITION_PROFILE_VERSION,
  classifyQualityHeight,
} from "../renditions/policy";
import {
  loadRenditionRegistry,
  type RenditionRegistry,
} from "../renditions/registry";
import { inspectCompletedRendition } from "../renditions/validation";
import { inspectAdaptivePackage } from "../renditions/adaptive/inspect";
import type { AdaptivePackageMetadata } from "../renditions/adaptive/metadata";
import { resolveTitleRoot } from "../renditions/adaptive/titleRoot";
import { qualityLabel } from "../renditions/adaptive/layout";
import { ADAPTIVE_PROFILE_VERSION } from "../renditions/adaptive/profile";
import { recordedMasterLayoutVersion } from "../renditions/adaptive/repairMaster";

// Analysis records "already-valid" when every required height already exists and
// "pending" while a title is only partially generated. Both still expose the
// heights that passed validation, so only records describing an untrustworthy
// source or output are rejected here; `inspectCompletedRendition` remains the
// authority on whether the files themselves are usable.
const REJECTED_REGISTRY_STATUSES = new Set([
  "failed",
  "stale",
  "validation-failed",
]);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}\.mp4$/;
/**
 * A path a package asset may be requested under.
 *
 * Deliberately a shape check rather than a list of the package's own layouts.
 * The previous version enumerated `video/` and `audio/` and was not updated when
 * the packager gained subtitle renditions, so every subtitle playlist 404d — and
 * a 404 behind an advertised subtitle group does not degrade to "no subtitles",
 * it fails the whole title. Authorisation does not rest on this: only paths the
 * title's own manifest names are served, and this exists to reject traversal and
 * anything a filename cannot legitimately contain.
 */
const ADAPTIVE_ASSET_PATTERN =
  /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w .()[\]-]+(?:\/[\w .()[\]-]+){0,2}$/;
const ADAPTIVE_VERSION_PATTERN = /^[0-9a-f]{12}$/;
const MAX_ACCESS_ENTRIES = 10_000;
const ACCESS_TTL_MS = 12 * 60 * 60 * 1_000;

export interface RenditionOriginalDescriptor {
  /** Rotation-corrected display dimensions of the source video stream. */
  width: number;
  height: number;
  rotation?: number;
  codec: string;
  container?: string;
  bitrate?: number;
  fileSize?: number;
  playableUrl?: string;
}

/**
 * What the requesting browser can actually decode. HDR renditions are HEVC Main
 * 10, so a client without HEVC must never be offered one — it would be handed a
 * file it cannot play instead of falling back to the existing transcode path.
 */
export interface RenditionClientSupport {
  hevc?: boolean;
  h264?: boolean;
}

function canDecodeRendition(
  file: { videoCodec: string; hdr?: boolean },
  client: RenditionClientSupport | undefined,
): boolean {
  if (!client) return true;
  if (file.videoCodec === "hevc") return client.hevc === true;
  return client.h264 !== false;
}

interface RenditionAccessFile {
  filePath: string;
  expectedSize?: number;
}

interface RenditionAccess {
  createdAt: number;
  manifest: MediaQualityManifest;
  versionRoot?: string;
  filesById: Map<string, RenditionAccessFile>;
  adaptiveVersionRoot?: string;
  adaptiveVersionId?: string;
  adaptiveFilesByPath: Map<string, RenditionAccessFile>;
}

export interface RenditionServiceOptions {
  mediaRoot: string;
  renditionRoot: string;
  stateRoot: string;
  mediaResolver: PlaybackMediaResolver;
  basePath?: string;
}

export interface ResolvedRenditionFile {
  absolutePath: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * What a package still knows about the source it replaced.
 *
 * The catalogue row of a packaged title carries no duration and no streams:
 * it was written from a registry record of a file that is gone, and the probe
 * that would have filled it in has nothing left to read. The package recorded
 * all of it at build time, so this is the source's own description, not a
 * reconstruction of it.
 */
/** A text subtitle a title's adaptive package carries, already WebVTT. */
export interface PackagedSubtitle {
  /** The source stream it was converted from, as the catalogue numbers it. */
  streamIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  /**
   * True when it was packaged from a subtitle file beside the source rather
   * than from a track inside it. Only a track inside the video is known to be
   * timed for this video, which is what makes it a reference to align against.
   */
  fromSidecar: boolean;
  /** The converted file, absolute. */
  path: string;
}

export interface PackagedSourceDescription {
  durationSeconds: number;
  video: VideoStreamAnalysis;
  audio: AudioStreamAnalysis[];
  subtitles: SubtitleStreamAnalysis[];
}

export interface RenditionService {
  /**
   * The text subtitles a ready package carries, each one already WebVTT.
   * Empty when the title has no ready package.
   */
  findPackagedSubtitles?(
    media: PlaybackResolvedMedia,
  ): Promise<PackagedSubtitle[]>;
  createManifest(
    media: PlaybackResolvedMedia,
    original?: RenditionOriginalDescriptor,
    client?: RenditionClientSupport,
  ): Promise<MediaQualityManifest>;
  /**
   * Re-grants delivery of a file's adaptive package when this process holds no
   * grant for it — after a restart, above all. Never replaces a live grant.
   * The caller has already authorized the user for the file.
   */
  restoreAdaptiveAccess?(media: PlaybackResolvedMedia): Promise<void>;
  /**
   * The validated file behind a rendition URL, or null if there is none.
   *
   * Only resolves; the caller streams it. Serving bytes is delicate — aborted
   * range requests, HEAD, 416 — and there is already one implementation of it
   * that playback depends on, so this does not add a second.
   */
  resolveFile(
    token: string,
    fileId: string,
  ): Promise<ResolvedRenditionFile | null>;
  resolveAdaptiveAsset(
    token: string,
    versionId: string,
    assetPath: string,
  ): Promise<ResolvedRenditionFile | null>;
  /**
   * The complete package a title kept after packaging consumed its source, or
   * null when there is none.
   *
   * Playback's readiness gate asks this before refusing a file whose probe
   * failed. A fully processed title can never be probed again — the bytes
   * ffprobe would read are gone — yet the package that replaced them is
   * exactly what playback is about to serve, and it carries the source
   * duration the catalogue row no longer holds.
   */
  describePackagedSource(
    media: PlaybackResolvedMedia,
  ): Promise<PackagedSourceDescription | null>;
  /**
   * The best picture a packaged title still has, for a reader that must
   * decode one — trickplay — once the source it would have used is gone.
   */
  findPackagedVideo(
    media: PlaybackResolvedMedia,
  ): Promise<PackagedVideo | null>;
  /**
   * The default audio rendition of a ready package, for a reader that must
   * listen to a title — intro detection — once its source is gone.
   */
  findPackagedAudio(
    media: PlaybackResolvedMedia,
    /** The source audio stream wanted; the default rendition when absent or not packaged. */
    sourceStreamIndex?: number,
  ): Promise<PackagedAudio | null>;
}

/** The default audio rendition of a ready package, as a decoder input. */
export interface PackagedAudio {
  path: string;
  /**
   * The rendition's own HLS playlist, for the same reason as
   * `PackagedVideo.playlistPath`: the audio is one fragmented MP4 too, and
   * a reader that only needs its samples should not make FFmpeg walk every
   * fragment through the Drive mount before the first one decodes.
   */
  playlistPath: string;
  durationSeconds: number;
}

/** The highest video rendition of a ready package, as a decoder input. */
export interface PackagedVideo {
  path: string;
  /**
   * The rendition's own HLS playlist: the same media, with its fragment index
   * already written out as byte ranges.
   *
   * A rendition is one fragmented MP4, and FFmpeg's MP4 demuxer finds a
   * fragmented file's fragments by visiting every one of them before it
   * decodes a frame — around 1,500 seeks for an hour of two-second fragments.
   * On a local disk that is nothing. Through the Drive mount every seek is a
   * ranged download, and opening one episode took two and a half minutes.
   * The playlist names every fragment's offset in a single small read, so a
   * reader that only needs the frames should open this instead.
   */
  playlistPath: string;
  width: number;
  height: number;
  durationSeconds: number;
  colorTransfer: string | null;
  colorPrimaries: string | null;
}

/**
 * The path segment an adaptive package is served under.
 *
 * Derived from the package build, not from the source file. Every asset under
 * this segment is served `immutable`, which is only honest if the bytes behind
 * a given URL never change — and they do change whenever a package is
 * regenerated, which happens on any encoder or policy change. Keyed on the
 * source alone, a rebuild silently reused the same URLs: clients that had
 * cached the previous build kept serving its playlists and byte ranges against
 * the new media, and playback stopped with no error to explain it. Including
 * the package's own creation stamp gives every build its own URL space, so a
 * stale cache simply misses.
 *
 * The master layout belongs in the same key. A master repair rewrites the
 * playlist in place without re-encoding, so the creation stamp it was built
 * under still stands — and without this, a corrected master kept the URL of the
 * broken one it replaced and every client that had cached the old copy went on
 * using it for the year the `immutable` directive promises.
 */
/** See `adaptiveVersionIdFor`. */
const ADAPTIVE_DELIVERY_REVISION = 2;

export function adaptiveVersionIdFor(metadata: {
  profileVersion: string;
  sourceFingerprint: string;
  createdAt: string;
  masterLayoutVersion?: number;
}): string {
  return createHash("sha256")
    .update(
      [
        metadata.profileVersion,
        metadata.sourceFingerprint,
        metadata.createdAt,
        `master-layout-${recordedMasterLayoutVersion(metadata)}`,
        // Revision of how the package is delivered, not of the bytes. Bumped
        // once because browsers hold year-long `immutable` copies cached
        // without `Vary: Origin`, which a CORS request (hls.js) cannot use;
        // new URLs are the only way past them. See `applyCors`.
        `delivery-${ADAPTIVE_DELIVERY_REVISION}`,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
}

function normalizeForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedCandidate = normalizeForComparison(candidate);
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function mediaRelativePath(
  mediaRoot: string,
  filePath: string,
): string | undefined {
  if (!isInside(mediaRoot, filePath)) return undefined;
  const relative = path.relative(mediaRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return undefined;
  return relative.split(path.sep).join("/");
}

function originalQuality(
  original: RenditionOriginalDescriptor | undefined,
): AvailableQualityFile | undefined {
  if (!original?.playableUrl) return undefined;
  // Letterboxed masters store a short frame height (a 4K scope feature is
  // 3840x1604), so the label comes from the standard quality class rather than
  // the raw pixel height.
  const qualityHeight = classifyQualityHeight(original);
  return {
    id: "original",
    label: `Original (${qualityHeight}p)`,
    kind: "original",
    width: original.width,
    height: qualityHeight,
    bitrate: original.bitrate,
    fileSize: original.fileSize,
    videoCodec: original.codec,
    container: original.container,
    playbackUrl: original.playableUrl,
  };
}

/**
 * The catalogue row can intentionally outlive the source bytes when a complete
 * adaptive package replaces them. That row remains the package's authorization
 * identity, but it is not evidence that an "Original" playback target still
 * exists. Consult the filesystem before advertising the direct file.
 */
async function hasOriginalSource(
  media: PlaybackResolvedMedia,
): Promise<boolean> {
  try {
    const source = await stat(media.filePath);
    return source.isFile() && source.size > 0;
  } catch {
    return false;
  }
}

export function createRenditionService({
  mediaRoot,
  renditionRoot,
  stateRoot,
  mediaResolver,
  basePath = "/api/playback/renditions",
}: RenditionServiceOptions): RenditionService {
  const accessByToken = new Map<string, RenditionAccess>();
  const registryPath = path.join(stateRoot, "registry.json");
  let cachedRegistry:
    | { signature: string; items: RenditionRegistry["items"] }
    | undefined;

  /**
   * The registry covers the whole library, so it is re-read only when the
   * offline CLI has actually rewritten it. Playback requests otherwise reuse the
   * parsed copy instead of parsing the full inventory per request.
   */
  const loadRegistryItems = async (): Promise<RenditionRegistry["items"]> => {
    let signature = "missing";

    try {
      const registryStats = await stat(registryPath);
      signature = `${registryStats.size}:${registryStats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (cachedRegistry?.signature === signature) {
      return cachedRegistry.items;
    }

    const { items } = await loadRenditionRegistry(registryPath);
    cachedRegistry = { signature, items };
    return items;
  };

  const pruneAccess = () => {
    const cutoff = Date.now() - ACCESS_TTL_MS;
    for (const [token, access] of accessByToken) {
      if (access.createdAt < cutoff) accessByToken.delete(token);
    }
    while (accessByToken.size > MAX_ACCESS_ENTRIES) {
      const oldest = accessByToken.keys().next().value as string | undefined;
      if (!oldest) break;
      accessByToken.delete(oldest);
    }
  };

  /**
   * The registry record that describes exactly these bytes, if there is one.
   *
   * A record that disagrees with the file describes some other version of it,
   * and its renditions must not be offered. Size is decisive.
   *
   * The modification time is only consulted when the record actually carries
   * one. A record written without it — a recovery path that had no stats to
   * hand, an import — would otherwise fail this comparison against every real
   * file and return nothing, which withdraws the entire ladder and leaves the
   * player direct-playing the source as the only quality on offer. A zero is an
   * absent measurement, not evidence that the file changed, and the package's
   * own fingerprint is checked by the inspection in any case.
   */
  const findRegistryItem = async (
    media: PlaybackResolvedMedia,
  ): Promise<RenditionRegistry["items"][number] | undefined> => {
    const relativePath = mediaRelativePath(mediaRoot, media.filePath);
    if (!relativePath) return undefined;
    const registryItems = await loadRegistryItems();
    const registryItem = registryItems.find(
      (item) => item.relativePath.toLowerCase() === relativePath.toLowerCase(),
    );
    const registeredMtime = Math.trunc(registryItem?.mtimeMs ?? 0);
    if (
      !registryItem ||
      registryItem.size !== media.size ||
      (registeredMtime > 0 && registeredMtime !== Math.trunc(media.mtimeMs))
    ) {
      return undefined;
    }
    return registryItem;
  };

  /** The complete, current package these source bytes were built into. */
  const readyPackageFor = async (
    media: PlaybackResolvedMedia,
  ): Promise<{
    metadata: AdaptivePackageMetadata;
    versionRoot: string;
  } | null> => {
    const registryItem = await findRegistryItem(media);
    if (
      !registryItem ||
      registryItem.adaptiveStatus !== "ready" ||
      registryItem.adaptiveProfileVersion !== ADAPTIVE_PROFILE_VERSION
    ) {
      return null;
    }
    const inspection = await inspectAdaptivePackage({
      titleRoot: await resolveTitleRoot(media.filePath),
      sourceFingerprint: registryItem.sourceFingerprint,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
    });
    if (
      inspection.status !== "ready" ||
      !inspection.metadata ||
      !inspection.versionRoot
    ) {
      return null;
    }
    return {
      metadata: inspection.metadata,
      versionRoot: inspection.versionRoot,
    };
  };

  const findPackagedVideo: RenditionService["findPackagedVideo"] = async (
    media,
  ) => {
    const ready = await readyPackageFor(media);
    if (!ready) return null;
    const best = [...ready.metadata.videoRenditions].sort(
      (a, b) => b.height - a.height || b.width - a.width,
    )[0];
    if (!best) return null;
    return {
      path: path.join(ready.versionRoot, ...best.mediaPath.split("/")),
      playlistPath: path.join(
        ready.versionRoot,
        ...best.playlistPath.split("/"),
      ),
      width: best.width,
      height: best.height,
      durationSeconds: best.durationSeconds,
      // An older manifest may carry only the HDR state; the filter graph
      // decides from the transfer, so name the one that state implies.
      colorTransfer:
        best.colorTransfer ??
        (best.hdr === "hdr10"
          ? "smpte2084"
          : best.hdr === "hlg"
            ? "arib-std-b67"
            : null),
      colorPrimaries: best.colorPrimaries ?? null,
    };
  };

  const findPackagedSubtitles: NonNullable<
    RenditionService["findPackagedSubtitles"]
  > = async (media) => {
    const ready = await readyPackageFor(media);
    if (!ready) return [];
    return (ready.metadata.subtitleRenditions ?? []).map((rendition) => ({
      streamIndex: rendition.sourceStreamIndex,
      ...(rendition.language ? { language: rendition.language } : {}),
      ...(rendition.title ? { title: rendition.title } : {}),
      isDefault: rendition.isDefault,
      isForced: rendition.isForced,
      fromSidecar: rendition.sidecarFingerprint !== undefined,
      path: path.join(ready.versionRoot, ...rendition.subtitlePath.split("/")),
    }));
  };

  const findPackagedAudio: RenditionService["findPackagedAudio"] = async (
    media,
    sourceStreamIndex,
  ) => {
    const ready = await readyPackageFor(media);
    if (!ready) return null;
    const renditions = ready.metadata.audioRenditions;
    const chosen =
      (sourceStreamIndex === undefined
        ? undefined
        : renditions.find(
            (rendition) => rendition.sourceStreamIndex === sourceStreamIndex,
          )) ??
      renditions.find((rendition) => rendition.isDefault) ??
      renditions[0];
    if (!chosen) return null;
    return {
      path: path.join(ready.versionRoot, ...chosen.mediaPath.split("/")),
      playlistPath: path.join(
        ready.versionRoot,
        ...chosen.playlistPath.split("/"),
      ),
      durationSeconds: chosen.durationSeconds,
    };
  };

  const describePackagedSource: RenditionService["describePackagedSource"] =
    async (media) => {
      const ready = await readyPackageFor(media);
      if (!ready) return null;
      const metadata = ready.metadata;
      return {
        durationSeconds: metadata.sourceDurationSeconds,
        video: {
          index: 0,
          codecName: metadata.source.codec,
          width: metadata.source.width,
          height: metadata.source.height,
          ...(metadata.source.frameRate === undefined
            ? {}
            : { framerate: metadata.source.frameRate }),
          isHdr: metadata.source.isHdr,
          // The package records whether the source was HDR, not which HDR
          // system it used. Claiming Dolby Vision on that would put a client
          // through a tone-mapping decision nothing here can support.
          hasDolbyVision: false,
        },
        audio: metadata.audioRenditions.map((rendition) => ({
          index: rendition.sourceStreamIndex,
          codecName: rendition.codec,
          channels: rendition.channels,
          sampleRate: rendition.sampleRate,
          bitrate: rendition.averageBitrate,
          ...(rendition.language ? { language: rendition.language } : {}),
          ...(rendition.title ? { title: rendition.title } : {}),
          isDefault: rendition.isDefault,
        })),
        subtitles: (metadata.subtitleRenditions ?? []).map((rendition) => ({
          index: rendition.sourceStreamIndex,
          codecName: rendition.codec,
          ...(rendition.language ? { language: rendition.language } : {}),
          ...(rendition.title ? { title: rendition.title } : {}),
          isDefault: rendition.isDefault,
          isForced: rendition.isForced,
          isImageBased: false,
        })),
      };
    };

  const createManifest: RenditionService["createManifest"] = async (
    media,
    original,
    client,
  ) => {
    const playableOriginal = (await hasOriginalSource(media))
      ? originalQuality(original)
      : undefined;
    const emptyManifest: MediaQualityManifest = {
      mediaId: media.mediaId,
      qualities: playableOriginal ? [playableOriginal] : [],
      limitations: {
        generatedAudio: "default-track-only",
        generatedSubtitles: "external-or-original-only",
        switching: "complete-file-rebuffer",
      },
    };
    const registryItem = await findRegistryItem(media);
    if (!registryItem) return emptyManifest;
    const packageRoot = path.join(renditionRoot, registryItem.id);
    const [inspection, adaptiveInspection] = await Promise.all([
      REJECTED_REGISTRY_STATUSES.has(registryItem.status ?? "") ||
      registryItem.profileVersion !== RENDITION_PROFILE_VERSION
        ? Promise.resolve({
            status: "missing" as const,
            metadata: undefined,
            versionRoot: undefined,
          })
        : inspectCompletedRendition({
            mediaRoot: packageRoot,
            mediaId: registryItem.id,
            sourceFingerprint: registryItem.sourceFingerprint,
            profileVersion: RENDITION_PROFILE_VERSION,
          }),
      registryItem.adaptiveStatus === "ready" &&
      registryItem.adaptiveProfileVersion === ADAPTIVE_PROFILE_VERSION
        ? inspectAdaptivePackage({
            /*
             * A movie's package lives beside the source it was made from; an
             * episode's lives in its own folder inside the season, because a
             * season folder is shared. Resolved rather than assumed, so this
             * reader needs no catalogue to find either.
             */
            titleRoot: await resolveTitleRoot(media.filePath),
            sourceFingerprint: registryItem.sourceFingerprint,
            profileVersion: ADAPTIVE_PROFILE_VERSION,
          })
        : Promise.resolve({
            status: "missing" as const,
            metadata: undefined,
            versionRoot: undefined,
          }),
    ]);

    const token = mediaResolver.encodeMediaToken(media.mediaId);
    const filesById = new Map<string, RenditionAccessFile>();
    const playableFiles =
      inspection.status === "ready" && inspection.metadata
        ? inspection.metadata.files.filter((file) =>
            canDecodeRendition(file, client),
          )
        : [];
    const generated: AvailableQualityFile[] = playableFiles.map((file) => {
      const fileId = `${file.qualityHeight}-${registryItem.sourceFingerprint.slice(0, 12)}.mp4`;
      filesById.set(fileId, {
        filePath: file.file,
        expectedSize: file.fileSize,
      });
      return {
        id: `generated-${file.qualityHeight}`,
        label: `${file.qualityHeight}p`,
        kind: "generated" as const,
        width: file.width,
        height: file.qualityHeight,
        bitrate: file.bitrate,
        fileSize: file.fileSize,
        videoCodec: file.videoCodec,
        audioCodec: file.audioCodec,
        container: file.container,
        ...(file.hdr ? { hdr: true } : {}),
        playbackUrl: `${basePath}/${encodeURIComponent(token)}/${fileId}`,
        sourceAudioStreamIndex: file.sourceAudioStreamIndex,
        audioLanguage: file.audioLanguage,
      };
    });
    const manifest: MediaQualityManifest = {
      ...emptyManifest,
      generatedAt:
        adaptiveInspection.metadata?.createdAt ??
        inspection.metadata?.createdAt,
      qualities: [
        ...generated,
        ...(playableOriginal ? [playableOriginal] : []),
      ].sort(
        (left, right) =>
          right.height - left.height ||
          Number(left.kind === "original") - Number(right.kind === "original"),
      ),
    };
    const adaptiveFilesByPath = new Map<string, RenditionAccessFile>();
    const adaptiveMetadata =
      adaptiveInspection.status === "ready" &&
      adaptiveInspection.versionRoot &&
      adaptiveInspection.metadata &&
      adaptiveInspection.metadata.videoRenditions.every((rendition) =>
        canDecodeRendition(
          { videoCodec: rendition.codec, hdr: rendition.hdr !== "sdr" },
          client,
        ),
      )
        ? adaptiveInspection.metadata
        : undefined;
    const adaptiveVersionId = adaptiveMetadata
      ? adaptiveVersionIdFor(adaptiveMetadata)
      : undefined;
    if (adaptiveMetadata) {
      adaptiveFilesByPath.set(adaptiveMetadata.masterPlaylistPath, {
        filePath: adaptiveMetadata.masterPlaylistPath,
      });
      for (const rendition of [
        ...adaptiveMetadata.videoRenditions,
        ...adaptiveMetadata.audioRenditions,
      ]) {
        adaptiveFilesByPath.set(rendition.playlistPath, {
          filePath: rendition.playlistPath,
        });
        adaptiveFilesByPath.set(rendition.mediaPath, {
          filePath: rendition.mediaPath,
          expectedSize: rendition.fileSizeBytes,
        });
      }
      for (const rendition of adaptiveMetadata.subtitleRenditions ?? []) {
        adaptiveFilesByPath.set(rendition.playlistPath, {
          filePath: rendition.playlistPath,
        });
        adaptiveFilesByPath.set(rendition.subtitlePath, {
          filePath: rendition.subtitlePath,
          expectedSize: rendition.fileSizeBytes,
        });
      }
      const adaptiveBaseUrl = `${basePath}/${encodeURIComponent(token)}/adaptive/${adaptiveVersionId}`;
      const adaptiveAssetUrl = (assetPath: string) =>
        `${adaptiveBaseUrl}/${assetPath
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`;
      manifest.adaptive = {
        profileVersion: adaptiveMetadata.profileVersion,
        // The master's own recorded location, not a fixed name: a player
        // resolves every rendition URI against this URL, so it has to sit where
        // the package actually put it.
        playbackUrl: adaptiveAssetUrl(adaptiveMetadata.masterPlaylistPath),
        mimeType: "application/vnd.apple.mpegurl",
        segmentTargetSeconds: adaptiveMetadata.segmentTargetSeconds,
        qualities: adaptiveMetadata.videoRenditions
          .map((rendition) => ({
            id: rendition.id,
            label: qualityLabel({
              qualityHeight: rendition.qualityHeight,
              frameRate: rendition.frameRate,
              isHdr: rendition.hdr !== "sdr",
            }),
            width: rendition.width,
            height: rendition.qualityHeight,
            bitrate: rendition.averageBitrate,
            videoCodec: rendition.codec,
            hdr: rendition.hdr !== "sdr",
          }))
          .sort((left, right) => right.height - left.height),
        audioTracks: adaptiveMetadata.audioRenditions.map((rendition) => ({
          id: rendition.id,
          sourceStreamIndex: rendition.sourceStreamIndex,
          label: rendition.title ?? rendition.language ?? rendition.id,
          ...(rendition.language ? { language: rendition.language } : {}),
          channels: rendition.channels,
          isDefault: rendition.isDefault,
        })),
        subtitleTracks: (adaptiveMetadata.subtitleRenditions ?? []).map(
          (rendition) => ({
            sourceStreamIndex: rendition.sourceStreamIndex,
            url: adaptiveAssetUrl(rendition.subtitlePath),
          }),
        ),
        switching: "aligned-cmaf-hls",
      };
    }
    if (playableFiles.length === 0 && !manifest.adaptive) return emptyManifest;
    pruneAccess();
    accessByToken.set(token, {
      createdAt: Date.now(),
      manifest,
      ...(inspection.versionRoot
        ? { versionRoot: inspection.versionRoot }
        : {}),
      filesById,
      ...(adaptiveInspection.versionRoot
        ? { adaptiveVersionRoot: adaptiveInspection.versionRoot }
        : {}),
      ...(adaptiveVersionId ? { adaptiveVersionId } : {}),
      adaptiveFilesByPath,
    });
    return manifest;
  };

  const resolveFile: RenditionService["resolveFile"] = async (
    token,
    fileId,
  ) => {
    if (!TOKEN_PATTERN.test(token) || !FILE_ID_PATTERN.test(fileId))
      return null;

    pruneAccess();
    const access = accessByToken.get(token);
    const registered = access?.filesById.get(fileId);
    if (!access || !registered || !access.versionRoot) return null;

    try {
      const candidate = path.join(access.versionRoot, registered.filePath);
      const [trustedRoot, trustedFile] = await Promise.all([
        realpath(access.versionRoot),
        realpath(candidate),
      ]);
      if (!isInside(trustedRoot, trustedFile)) return null;

      // The registry records the size the file had when it was validated. A
      // different one means the output changed underneath us, and serving it
      // would hand the player bytes nothing has checked.
      const stats = await stat(trustedFile);
      if (
        !stats.isFile() ||
        (registered.expectedSize !== undefined &&
          stats.size !== registered.expectedSize)
      )
        return null;

      return { absolutePath: trustedFile, sizeBytes: stats.size };
    } catch {
      return null;
    }
  };

  /*
   * Grants live in this process's memory, so a restart forgot every one of
   * them and every open player got 404 for its next segment — each deploy
   * stalled every film in progress until its viewer reloaded. A grant is only
   * a cache of what `createManifest` derives from the registry and the
   * package on disk, so a request that finds none has it derived again.
   *
   * Decode support decides what a client is *offered*; it has no bearing on
   * whether a package it was already given may be read, so the restore admits
   * every codec. Authorization stays with the route, which has checked the
   * user against the file. The URL's version must still match the package on
   * disk, so a player holding a replaced package is refused as before.
   *
   * After a restart every player's next requests arrive together; they share
   * one derivation per file instead of each repeating the registry read.
   */
  const restoringAccess = new Map<string, Promise<void>>();
  const restoreAdaptiveAccess: NonNullable<
    RenditionService["restoreAdaptiveAccess"]
  > = async (media) => {
    const token = mediaResolver.encodeMediaToken(media.mediaId);
    pruneAccess();
    if (accessByToken.has(token)) return;
    let pending = restoringAccess.get(token);
    if (!pending) {
      pending = createManifest(media, undefined, { hevc: true, h264: true })
        .then(() => undefined)
        .finally(() => restoringAccess.delete(token));
      restoringAccess.set(token, pending);
    }
    await pending;
  };

  const resolveAdaptiveAsset: RenditionService["resolveAdaptiveAsset"] = async (
    token,
    versionId,
    assetPath,
  ) => {
    if (
      !TOKEN_PATTERN.test(token) ||
      !ADAPTIVE_VERSION_PATTERN.test(versionId) ||
      !ADAPTIVE_ASSET_PATTERN.test(assetPath)
    ) {
      return null;
    }
    pruneAccess();
    const access = accessByToken.get(token);
    const registered = access?.adaptiveFilesByPath.get(assetPath);
    if (
      !access?.adaptiveVersionRoot ||
      access.adaptiveVersionId !== versionId ||
      !registered
    ) {
      return null;
    }

    try {
      const candidate = path.join(
        access.adaptiveVersionRoot,
        ...registered.filePath.split("/"),
      );
      const [trustedRoot, trustedFile] = await Promise.all([
        realpath(access.adaptiveVersionRoot),
        realpath(candidate),
      ]);
      if (!isInside(trustedRoot, trustedFile)) return null;
      const stats = await stat(trustedFile);
      if (
        !stats.isFile() ||
        (registered.expectedSize !== undefined &&
          stats.size !== registered.expectedSize)
      ) {
        return null;
      }
      return {
        absolutePath: trustedFile,
        sizeBytes: stats.size,
        contentType: assetPath.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : assetPath.endsWith(".vtt")
            ? "text/vtt; charset=utf-8"
            : "video/iso.segment",
      };
    } catch {
      return null;
    }
  };

  return {
    createManifest,
    restoreAdaptiveAccess,
    resolveFile,
    resolveAdaptiveAsset,
    describePackagedSource,
    findPackagedVideo,
    findPackagedAudio,
    findPackagedSubtitles,
  };
}
