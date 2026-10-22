import { createHash } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  PUBLICATION_GENERATIONS,
  PUBLICATION_POINTER,
  resolvePublishedTitleRoot,
} from "./publishedRoot";
import type { AdaptivePackageMetadata } from "./metadata";
import { buildMasterPlaylist, parseMediaPlaylist } from "./playlist";
import { parseWebVttMediaPlaylist } from "./subtitles";
import { MASTER_LAYOUT_VERSION } from "./repairMaster";
import {
  createByteRateEstimator,
  etaFromRate,
  safeFraction,
  type PublishPhaseProgress,
  type PublishStepId,
  type PublishStepProgress,
} from "./phaseProgress";
import {
  TITLE_AUDIO_DIRECTORY,
  TITLE_SUBTITLE_DIRECTORY,
  TITLE_VIDEO_DIRECTORY,
} from "./layout";
import {
  TITLE_MASTER_PLAYLIST,
  TITLE_PACKAGE_DIRECTORY,
  TITLE_PACKAGE_MANIFEST,
  type TitleLayoutPlan,
  planTitleLayout,
  playlistUri,
  rewriteMasterPlaylist,
  rewriteRenditionPlaylist,
} from "./titleLayout";

/**
 * A publish that would land on another title's package.
 *
 * Kept distinct from every other publication failure because the remedy is
 * different in kind: nothing is wrong with the encode, the bytes, or the
 * volume. The destination is wrong, and the only safe thing to do about a
 * wrong destination is nothing at all.
 */
export class TitleRootConflictError extends Error {
  readonly code = "TITLE_ROOT_CONFLICT";
  constructor(
    readonly titleRoot: string,
    readonly occupantMediaId: string,
    readonly incomingMediaId: string,
  ) {
    super(
      `Refusing to publish into ${titleRoot}: it already holds the package ` +
        `for media ${occupantMediaId}, and this run built media ` +
        `${incomingMediaId}. Publishing would replace another title's ` +
        `renditions. The destination is wrong, not the package.`,
    );
    this.name = "TitleRootConflictError";
  }
}

/**
 * The media a package already in this folder was built from, or null.
 *
 * Deliberately not `readTitleBuildRecord`: that returns null for a record it
 * judges too incomplete to rebuild a master from, and a half-written package is
 * still a package this run must not write over. All that is needed here is
 * whose it is.
 */
async function occupantMediaId(titleRoot: string): Promise<string | null> {
  titleRoot = await resolvePublishedTitleRoot(titleRoot);
  try {
    const raw = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_BUILD_RECORD),
      "utf8",
    );
    const mediaId = (JSON.parse(raw) as { mediaId?: unknown }).mediaId;
    return typeof mediaId === "string" && mediaId !== "" ? mediaId : null;
  } catch {
    return null;
  }
}

/**
 * The last thing standing between a wrong destination and lost content.
 *
 * A title root holds exactly one title. Re-encoding a source publishes over its
 * own package, which is the point; publishing over a *different* source's
 * package is never intended, and until now nothing said so — a season folder
 * accepted ten episodes in turn, each one deleting the last, and the only
 * evidence was that nine of them had quietly stopped existing.
 *
 * Whoever resolved the destination is where such a bug lives, and it is fixed
 * there. This is the assertion that the fix held, on the one path every publish
 * goes through, so the next way of getting it wrong costs a failed job instead
 * of a re-encode of somebody's library.
 */
async function assertTitleRootOwnedBy(
  titleRoot: string,
  mediaId: string,
): Promise<void> {
  const occupant = await occupantMediaId(titleRoot);
  if (occupant === null || occupant === mediaId) return;
  throw new TitleRootConflictError(titleRoot, occupant, mediaId);
}

/**
 * Moving a validated package into the title's own folder.
 *
 * The package is built and proven somewhere else, then laid out here under the
 * names a person would expect. Publication is the only step that writes into
 * the library, and it never touches the source file — the original is read
 * throughout and is still there afterwards.
 */

export const TITLE_MANIFEST_SCHEMA_VERSION = 1;

/** The packager's own record of what it made and how it proved it. */
export const TITLE_BUILD_RECORD = "build.json";

export interface TitleManifestRendition {
  id: string;
  /** Path of the media file, relative to the title folder. */
  mediaPath: string;
  /** Path of the playlist, relative to the title folder. */
  playlistPath: string;
  fileSizeBytes: number;
}

export interface TitleVideoRendition extends TitleManifestRendition {
  qualityHeight: number;
  width: number;
  height: number;
  codec: "h264" | "hevc";
  codecString: string;
  frameRate: number;
  hdr: string;
  averageBitrate: number;
  peakBitrate: number;
}

export interface TitleAudioRendition extends TitleManifestRendition {
  sourceStreamIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  codecString: string;
  channels: number;
}

export interface TitleSubtitleRendition extends TitleManifestRendition {
  sourceStreamIndex: number;
  sidecarFingerprint?: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
}

/**
 * What a title folder says about its own package.
 *
 * Deliberately separate from the packager's build manifest: that one describes
 * a work directory whose layout is fixed and machine shaped, and its validator
 * is right to insist on it. This one describes where things ended up in a
 * library folder, which is a different question with different answers.
 */
export interface TitlePackageManifest {
  schemaVersion: number;
  profileVersion: string;
  sourceFingerprint: string;
  createdAt: string;
  sourceDurationSeconds: number;
  /** Relative to the title folder. */
  masterPlaylistPath: string;
  video: TitleVideoRendition[];
  audio: TitleAudioRendition[];
  subtitle: TitleSubtitleRendition[];
  storage: { totalBytes: number };
}

/**
 * Efficient copy verification.
 *
 * Full SHA-256 over hundreds of gigabytes would read both disks for a second
 * complete pass and roughly double publication time. What is checked instead,
 * exactly:
 *
 *  - **Size**, first and exactly. Any difference — a truncated destination, a
 *    short write, a longer file — fails before a byte is read.
 *  - **Files of `COPY_CHUNK_BYTES * 3` (3 MiB) or less**: every window is read,
 *    so the digest covers the whole file and any single altered byte is caught.
 *    Playlists, manifests and build records are all far below this.
 *  - **Larger files**: three 1 MiB windows — first, middle, last — with the
 *    size mixed into the digest. Verification I/O is capped at 3 MiB a side
 *    whether the file is 4 MiB or 400 GB.
 *
 * The bound this accepts: a same-size alteration inside a large file that
 * falls outside all three windows is not detected here. That is a deliberate
 * trade against reading the whole package twice, and it is pinned by a test in
 * `destinationVerification.test.ts` so it stays deliberate. What surrounds it —
 * deep validation of the package on scratch before publication, playlist byte
 * ranges re-checked against the destination file they address, and every
 * manifest-named file re-checked for its recorded size after the swap — is
 * described in that file's header.
 */
const COPY_CHUNK_BYTES = 1024 * 1024;

async function sampledDigest(filePath: string, size: number): Promise<string> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const offsets =
      size <= COPY_CHUNK_BYTES * 3
        ? Array.from(
            { length: Math.ceil(size / COPY_CHUNK_BYTES) },
            (_, index) => index * COPY_CHUNK_BYTES,
          )
        : [
            0,
            Math.max(0, Math.floor(size / 2) - COPY_CHUNK_BYTES / 2),
            size - COPY_CHUNK_BYTES,
          ];
    for (const offset of offsets) {
      const length = Math.min(COPY_CHUNK_BYTES, size - offset);
      if (length <= 0) continue;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
    hash.update(String(size));
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function replicasMatch(
  source: string,
  destination: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    stat(source).catch(() => null),
    stat(destination).catch(() => null),
  ]);
  if (!left?.isFile() || !right?.isFile() || left.size !== right.size)
    return false;
  const [leftHash, rightHash] = await Promise.all([
    sampledDigest(source, left.size),
    sampledDigest(destination, right.size),
  ]);
  return leftHash === rightHash;
}

/**
 * Copies one immutable package file without consuming it, resuming a partial
 * destination after checking samples around the resume boundary.
 */
export async function copyFileResumable(
  from: string,
  to: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (completedBytes: number, totalBytes: number) => void;
  } = {},
): Promise<number> {
  const sourceStats = await stat(from);
  if (!sourceStats.isFile())
    throw new Error(`Publication source is not a file: ${from}`);
  await mkdir(path.dirname(to), { recursive: true });

  const destinationStats = await stat(to).catch(() => null);
  if (
    destinationStats?.size === sourceStats.size &&
    (await replicasMatch(from, to))
  ) {
    options.onProgress?.(sourceStats.size, sourceStats.size);
    return sourceStats.size;
  }

  let offset = destinationStats?.isFile() ? destinationStats.size : 0;
  if (offset > sourceStats.size) offset = 0;
  if (offset > 0) {
    const sampleLength = Math.min(COPY_CHUNK_BYTES, offset);
    const sampleOffset = offset - sampleLength;
    const [source, destination] = await Promise.all([
      open(from, "r"),
      open(to, "r"),
    ]);
    try {
      const left = Buffer.allocUnsafe(sampleLength);
      const right = Buffer.allocUnsafe(sampleLength);
      const [a, b] = await Promise.all([
        source.read(left, 0, sampleLength, sampleOffset),
        destination.read(right, 0, sampleLength, sampleOffset),
      ]);
      if (
        a.bytesRead !== b.bytesRead ||
        !left.subarray(0, a.bytesRead).equals(right.subarray(0, b.bytesRead))
      ) {
        offset = 0;
      }
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
  }

  const source = await open(from, "r");
  const destination = await open(to, offset === 0 ? "w" : "r+");
  try {
    options.onProgress?.(offset, sourceStats.size);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    while (offset < sourceStats.size) {
      if (options.signal?.aborted)
        throw new Error("Publication was interrupted.");
      const wanted = Math.min(buffer.length, sourceStats.size - offset);
      const { bytesRead } = await source.read(buffer, 0, wanted, offset);
      if (bytesRead === 0)
        throw new Error("Publication source ended before its recorded size.");
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        written += result.bytesWritten;
      }
      offset += bytesRead;
      options.onProgress?.(offset, sourceStats.size);
    }
    await destination.truncate(sourceStats.size);
    await destination.sync();
  } finally {
    await Promise.all([source.close(), destination.close()]);
  }
  if (!(await replicasMatch(from, to))) {
    /*
     * The bad destination is discarded before the error is raised, so the next
     * attempt starts from nothing.
     *
     * Leaving it made some corruption permanently unrecoverable. A destination
     * file of the right size whose damage lies outside the resume sample looks
     * like a finished copy to the resume check: the retry copies no bytes,
     * re-runs this comparison, fails identically, and does so for ever. The
     * job could not make progress and no amount of retrying would have helped.
     *
     * Removing it is safe here and only here: `to` is always inside the hidden
     * incoming staging directory, never a published file, so nothing a player
     * can reach is being deleted.
     */
    await rm(to, { force: true }).catch(() => undefined);
    throw new Error(
      "The destination copy did not match the verified scratch file.",
    );
  }
  return sourceStats.size;
}

function absolute(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

export interface PublishTitlePackageInput {
  /** The validated package, in the packager's own work layout. */
  workVersionRoot: string;
  /** The folder the source file lives in. */
  titleRoot: string;
  metadata: AdaptivePackageMetadata;
  /**
   * Called as each publication step finishes.
   *
   * Publication is usually renames within one filesystem and over in seconds —
   * but when the work directory is on a different volume from the library every
   * byte of the package is copied, and a job that sat silent for ten minutes at
   * "publishing" looked hung. The steps are weighted by the bytes they move so
   * the reported position means the same thing in both cases.
   */
  onProgress?: (progress: PublishPhaseProgress) => void;
  /** Stable job id, making HDD incoming state resumable across processes. */
  publicationId?: string;
  signal?: AbortSignal;
  /** Free bytes retained on the destination after the incoming copy. */
  destinationReserveBytes?: number;
  retainIncomingAfterPublish?: boolean;
  /** Filesystem commit boundary, shared by activation and recovery. */
  fileSystem?: Pick<typeof import("node:fs/promises"), "rename"> &
    Partial<Pick<typeof import("node:fs/promises"), "rm">>;
}

/**
 * A reporter over the fixed list of steps publication performs.
 *
 * The list is derived from the package being published, so it names only work
 * that will actually happen: a title with no subtitles has no subtitle step.
 */
export function createPublishReporter(
  steps: readonly { id: PublishStepId; bytes?: number }[],
  onProgress: ((progress: PublishPhaseProgress) => void) | undefined,
) {
  const state = new Map<PublishStepId, PublishStepProgress["state"]>(
    steps.map((step) => [step.id, "waiting" as const]),
  );
  const copied = new Map<PublishStepId, number>();
  const totalBytes = steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0);
  const rate = createByteRateEstimator();

  const emit = (currentId?: PublishStepId): void => {
    if (!onProgress) return;
    const list: PublishStepProgress[] = steps.map((step) => ({
      id: step.id,
      state: state.get(step.id) ?? "waiting",
      ...(step.bytes === undefined ? {} : { bytes: step.bytes }),
      ...(step.bytes === undefined
        ? {}
        : { completedBytes: copied.get(step.id) ?? 0 }),
    }));
    const completedBytes = steps.reduce(
      (sum, step) => sum + Math.min(step.bytes ?? 0, copied.get(step.id) ?? 0),
      0,
    );
    rate.sample(completedBytes, Date.now());
    const bytesPerSecond = rate.rate(Date.now());
    const etaSeconds = etaFromRate(totalBytes - completedBytes, bytesPerSecond);
    onProgress({
      steps: list,
      totalBytes,
      completedBytes,
      fraction: safeFraction(completedBytes, totalBytes),
      ...(currentId === undefined ? {} : { currentId }),
      ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
      ...(etaSeconds === undefined ? {} : { etaSeconds }),
    });
  };

  return {
    begin(id: PublishStepId): void {
      if (!state.has(id)) return;
      state.set(id, "running");
      emit(id);
    },
    complete(id: PublishStepId): void {
      if (!state.has(id)) return;
      state.set(id, "complete");
      const step = steps.find((candidate) => candidate.id === id);
      if (step?.bytes !== undefined) copied.set(id, step.bytes);
      emit();
    },
    update(id: PublishStepId, completedBytes: number): void {
      if (!state.has(id)) return;
      state.set(id, "running");
      copied.set(id, Math.max(copied.get(id) ?? 0, completedBytes));
      emit(id);
    },
    /** Marks a step complete that another component performed. */
    finish(): void {
      emit();
    },
  };
}

export type PublishReporter = ReturnType<typeof createPublishReporter>;

export interface PublishTitlePackageResult {
  manifest: TitlePackageManifest;
  plan: TitleLayoutPlan;
  incomingDirectory: string;
  publishedRoot?: string;
}

export const TITLE_INCOMING_DIRECTORY = ".seyirlik-incoming";
const PUBLICATION_OWNER_FILE = ".publication.json";

function safePublicationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("The publication id is not a safe path component.");
  }
  return value;
}

async function prepareIncoming(
  titleRoot: string,
  publicationId: string,
  metadata: AdaptivePackageMetadata,
): Promise<string> {
  const incomingRoot = path.join(titleRoot, TITLE_INCOMING_DIRECTORY);
  const staging = path.join(incomingRoot, safePublicationId(publicationId));
  const resolvedTitle = path.resolve(titleRoot);
  if (path.dirname(path.resolve(incomingRoot)) !== resolvedTitle) {
    throw new Error(
      "The incoming publication directory escaped the title root.",
    );
  }
  await mkdir(staging, { recursive: true });
  const marker = path.join(staging, PUBLICATION_OWNER_FILE);
  const existing = await readFile(marker, "utf8").catch(() => null);
  if (existing) {
    const owner = JSON.parse(existing) as Record<string, unknown>;
    if (
      owner.publicationId !== publicationId ||
      owner.sourceFingerprint !== metadata.sourceFingerprint ||
      owner.profileVersion !== metadata.profileVersion
    ) {
      throw new Error(
        "The HDD incoming directory belongs to a different publication.",
      );
    }
  } else {
    await writeFile(
      marker,
      `${JSON.stringify({
        schemaVersion: 1,
        publicationId,
        sourceFingerprint: metadata.sourceFingerprint,
        profileVersion: metadata.profileVersion,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  return staging;
}

/**
 * Publishes a package into its title folder, replacing any previous one.
 *
 * Everything is assembled in a staging directory beside the destination first,
 * so the swap at the end is a sequence of renames within one filesystem rather
 * than a folder that is half old and half new for the length of a copy.
 */
export async function publishTitlePackage({
  workVersionRoot,
  titleRoot,
  metadata,
  onProgress,
  publicationId = `${metadata.profileVersion}-${metadata.sourceFingerprint.slice(0, 16)}`,
  signal,
  destinationReserveBytes = 0,
  retainIncomingAfterPublish = false,
  fileSystem = { rename },
}: PublishTitlePackageInput): Promise<PublishTitlePackageResult> {
  const plan = planTitleLayout(metadata);
  /*
   * The steps, named before any of them runs. The media steps carry the bytes
   * they move; the small ones carry none, so a package that publishes by rename
   * still reports each stage passing rather than one long silence.
   */
  const progress = createPublishReporter(
    [
      ...(metadata.videoRenditions.length > 0
        ? [
            {
              id: "video" as const,
              bytes: metadata.videoRenditions.reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      ...(metadata.audioRenditions.length > 0
        ? [
            {
              id: "audio" as const,
              bytes: metadata.audioRenditions.reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      ...((metadata.subtitleRenditions?.length ?? 0) > 0
        ? [
            {
              id: "subtitles" as const,
              bytes: (metadata.subtitleRenditions ?? []).reduce(
                (sum, rendition) => sum + rendition.fileSizeBytes,
                0,
              ),
            },
          ]
        : []),
      { id: "master-playlist" as const },
      { id: "manifest" as const },
      { id: "build-record" as const },
      { id: "verify" as const },
      { id: "swap" as const },
    ],
    onProgress,
  );
  await assertTitleRootOwnedBy(titleRoot, metadata.mediaId);
  // Existing readers retain their root. A replacement is built separately and
  // activated by one atomic file rename, never by retiring their live folders.
  const previous = await readTitlePackageManifest(titleRoot);
  const generation = createHash("sha256")
    .update(JSON.stringify({ publicationId, metadata }))
    .digest("hex");
  const publishedRoot = previous
    ? path.join(titleRoot, PUBLICATION_GENERATIONS, generation)
    : titleRoot;
  await mkdir(publishedRoot, { recursive: true });
  const staging = await prepareIncoming(titleRoot, publicationId, metadata);
  if (
    previous &&
    (await resolvePublishedTitleRoot(titleRoot)) ===
      (await realpath(publishedRoot))
  ) {
    await verifyIncomingPackage(publishedRoot, previous);
    if (!retainIncomingAfterPublish)
      await cleanupPublicationIncoming(
        titleRoot,
        staging,
        publicationId,
        fileSystem.rm,
      );
    return {
      manifest: previous,
      plan,
      incomingDirectory: staging,
      publishedRoot,
    };
  }

  const destinationSpace = await statfs(titleRoot);
  const destinationFreeBytes = destinationSpace.bavail * destinationSpace.bsize;
  let reusableIncomingBytes = 0;
  for (const entry of [
    ...plan.video.map((rendition) => rendition.mediaPath),
    ...plan.audio.map((rendition) => rendition.mediaPath),
    ...plan.subtitle.map((rendition) => rendition.mediaPath),
  ]) {
    reusableIncomingBytes +=
      (await stat(absolute(staging, entry)).catch(() => null))?.size ?? 0;
  }
  const remainingBytes = Math.max(
    0,
    metadata.storage.totalBytes - reusableIncomingBytes,
  );
  if (destinationFreeBytes - remainingBytes < destinationReserveBytes) {
    const error = new Error(
      "The final media volume does not have enough free space for transactional publication.",
    ) as NodeJS.ErrnoException;
    error.code = "ENOSPC";
    throw error;
  }

  const workPlaylistPathById = new Map<string, string>();
  for (const rendition of metadata.videoRenditions) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }
  for (const rendition of metadata.audioRenditions) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }
  for (const rendition of metadata.subtitleRenditions ?? []) {
    workPlaylistPathById.set(rendition.id, rendition.playlistPath);
  }

  {
    const copiedByStep = new Map<PublishStepId, number>();
    const publishOne = async (
      step: PublishStepId,
      published: { id: string; mediaPath: string; playlistPath: string },
      workMediaPath: string,
      workPlaylistPath: string,
    ) => {
      const previous = copiedByStep.get(step) ?? 0;
      const copied = await copyFileResumable(
        absolute(workVersionRoot, workMediaPath),
        absolute(staging, published.mediaPath),
        {
          ...(signal ? { signal } : {}),
          onProgress: (completed) =>
            progress.update(step, previous + completed),
        },
      );
      copiedByStep.set(step, previous + copied);
      const playlist = await readFile(
        absolute(workVersionRoot, workPlaylistPath),
        "utf8",
      );
      const target = absolute(staging, published.playlistPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        rewriteRenditionPlaylist(
          playlist,
          // Every URI in a byte-range playlist names the one media file, by its
          // bare filename rather than by any path.
          path.posix.basename(workMediaPath),
          published.mediaPath,
        ),
        "utf8",
      );
    };

    const video: TitleVideoRendition[] = [];
    progress.begin("video");
    for (const [index, rendition] of metadata.videoRenditions.entries()) {
      const published = plan.video[index]!;
      await publishOne(
        "video",
        published,
        rendition.mediaPath,
        rendition.playlistPath,
      );
      video.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        qualityHeight: rendition.qualityHeight,
        width: rendition.width,
        height: rendition.height,
        codec: rendition.codec,
        codecString: rendition.codecString,
        frameRate: rendition.frameRate,
        hdr: rendition.hdr,
        averageBitrate: rendition.averageBitrate,
        peakBitrate: rendition.peakBitrate,
      });
    }

    progress.complete("video");
    const audio: TitleAudioRendition[] = [];
    progress.begin("audio");
    for (const [index, rendition] of metadata.audioRenditions.entries()) {
      const published = plan.audio[index]!;
      await publishOne(
        "audio",
        published,
        rendition.mediaPath,
        rendition.playlistPath,
      );
      audio.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        sourceStreamIndex: rendition.sourceStreamIndex,
        ...(rendition.language ? { language: rendition.language } : {}),
        ...(rendition.title ? { title: rendition.title } : {}),
        isDefault: rendition.isDefault,
        isForced: rendition.isForced,
        codecString: rendition.codecString,
        channels: rendition.channels,
      });
    }

    progress.complete("audio");
    const subtitle: TitleSubtitleRendition[] = [];
    progress.begin("subtitles");
    for (const [index, rendition] of (
      metadata.subtitleRenditions ?? []
    ).entries()) {
      const published = plan.subtitle[index]!;
      await publishOne(
        "subtitles",
        published,
        rendition.subtitlePath,
        rendition.playlistPath,
      );
      subtitle.push({
        id: rendition.id,
        mediaPath: published.mediaPath,
        playlistPath: published.playlistPath,
        fileSizeBytes: rendition.fileSizeBytes,
        sourceStreamIndex: rendition.sourceStreamIndex,
        ...(rendition.language ? { language: rendition.language } : {}),
        ...(rendition.title ? { title: rendition.title } : {}),
        isDefault: rendition.isDefault,
        isForced: rendition.isForced,
        isHearingImpaired: rendition.isHearingImpaired,
        ...(rendition.sidecarFingerprint
          ? { sidecarFingerprint: rendition.sidecarFingerprint }
          : {}),
      });
    }

    progress.complete("subtitles");

    progress.begin("master-playlist");
    const master = await readFile(
      absolute(workVersionRoot, metadata.masterPlaylistPath),
      "utf8",
    );
    await writeFile(
      absolute(staging, plan.masterPlaylistPath),
      rewriteMasterPlaylist(master, plan, workPlaylistPathById),
      "utf8",
    );
    progress.complete("master-playlist");
    progress.begin("manifest");

    const manifest: TitlePackageManifest = {
      schemaVersion: TITLE_MANIFEST_SCHEMA_VERSION,
      profileVersion: metadata.profileVersion,
      sourceFingerprint: metadata.sourceFingerprint,
      createdAt: metadata.createdAt,
      sourceDurationSeconds: metadata.sourceDurationSeconds,
      masterPlaylistPath: plan.masterPlaylistPath,
      video,
      audio,
      subtitle,
      storage: { totalBytes: metadata.storage.totalBytes },
    };
    await writeFile(
      absolute(staging, plan.manifestPath),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    progress.complete("manifest");
    progress.begin("build-record");

    /*
     * The build record travels with the package it describes: which checks the
     * validator ran, the measured keyframe cadence, the bitrates actually
     * achieved. `package.json` is what the server reads to serve; this is what
     * a person reads to understand what was made and how it was proven.
     */
    const publishedById = new Map<string, string>();
    for (const group of [plan.video, plan.audio, plan.subtitle]) {
      for (const rendition of group) {
        publishedById.set(rendition.id, rendition.mediaPath);
      }
    }
    const playlistById = new Map<string, string>();
    for (const group of [plan.video, plan.audio, plan.subtitle]) {
      for (const rendition of group) {
        playlistById.set(rendition.id, rendition.playlistPath);
      }
    }
    const buildRecord = {
      ...metadata,
      // Which master generator produced this playlist, so a later improvement
      // to it can be applied to the package without re-encoding media that is
      // already correct.
      masterLayoutVersion: MASTER_LAYOUT_VERSION,
      masterPlaylistPath: plan.masterPlaylistPath,
      videoRenditions: metadata.videoRenditions.map((rendition) => ({
        ...rendition,
        mediaPath: publishedById.get(rendition.id) ?? rendition.mediaPath,
        playlistPath: playlistById.get(rendition.id) ?? rendition.playlistPath,
      })),
      audioRenditions: metadata.audioRenditions.map((rendition) => ({
        ...rendition,
        mediaPath: publishedById.get(rendition.id) ?? rendition.mediaPath,
        playlistPath: playlistById.get(rendition.id) ?? rendition.playlistPath,
      })),
      subtitleRenditions: (metadata.subtitleRenditions ?? []).map(
        (rendition) => ({
          ...rendition,
          subtitlePath:
            publishedById.get(rendition.id) ?? rendition.subtitlePath,
          playlistPath:
            playlistById.get(rendition.id) ?? rendition.playlistPath,
        }),
      ),
    };
    await writeFile(
      absolute(staging, `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`),
      `${JSON.stringify(buildRecord, null, 2)}\n`,
      "utf8",
    );

    progress.complete("build-record");
    progress.begin("verify");
    await verifyIncomingPackage(staging, manifest);
    progress.complete("verify");
    progress.begin("swap");
    await swapPublishedDirectories(publishedRoot, staging, fileSystem.rename);
    if (publishedRoot !== titleRoot) {
      const pointer = path.join(titleRoot, PUBLICATION_POINTER);
      const pending = path.join(staging, ".current.pending");
      await writeFile(
        pending,
        `${JSON.stringify({ schemaVersion: 1, generation })}\n`,
        "utf8",
      );
      const pointerFile = await open(pending, "r+");
      try {
        await pointerFile.sync();
      } finally {
        await pointerFile.close();
      }
      await fileSystem.rename(pending, pointer);
    }
    progress.complete("swap");
    if (!retainIncomingAfterPublish) {
      await cleanupPublicationIncoming(
        titleRoot,
        staging,
        publicationId,
        fileSystem.rm,
      );
    }
    return { manifest, plan, incomingDirectory: staging, publishedRoot };
  }
}

/**
 * Verifies the hidden HDD copy before any live name is changed.
 *
 * Media equality was already checked against SSD by `copyFileResumable`; this
 * pass proves the package-level relationships that a collection of successful
 * file copies cannot: every manifest path exists, and every playlist still
 * parses as the kind of playlist its rendition is.
 *
 * The kinds are checked apart on purpose. A CMAF rendition is a single file
 * addressed by byte range, so its playlist must carry an `#EXT-X-MAP` and its
 * ranges must fall inside the file that was copied. A WebVTT rendition has no
 * initialisation segment at all, and requiring one here rejected every title
 * that carried a subtitle track.
 */
async function verifyIncomingPackage(
  staging: string,
  manifest: TitlePackageManifest,
): Promise<void> {
  const root = path.resolve(staging);
  const safe = (relative: string): string => {
    const target = path.resolve(root, ...relative.split("/"));
    const relation = path.relative(root, target);
    if (relation.startsWith("..") || path.isAbsolute(relation)) {
      throw new Error(
        `A publication path escaped its incoming root: ${relative}`,
      );
    }
    return target;
  };

  const required = [
    manifest.masterPlaylistPath,
    `${TITLE_PACKAGE_DIRECTORY}/${TITLE_PACKAGE_MANIFEST}`,
    `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`,
  ];
  const renditions = [
    ...manifest.video.map((rendition) => ({
      rendition,
      kind: "cmaf" as const,
    })),
    ...manifest.audio.map((rendition) => ({
      rendition,
      kind: "cmaf" as const,
    })),
    ...manifest.subtitle.map((rendition) => ({
      rendition,
      kind: "webvtt" as const,
    })),
  ];
  for (const { rendition, kind } of renditions) {
    required.push(rendition.mediaPath, rendition.playlistPath);
    const media = await stat(safe(rendition.mediaPath)).catch(() => null);
    if (!media?.isFile() || media.size === 0) {
      throw new Error(`The HDD copy is missing media: ${rendition.mediaPath}`);
    }
    const playlist = await readFile(safe(rendition.playlistPath), "utf8");
    try {
      if (kind === "webvtt") {
        parseWebVttMediaPlaylist(playlist);
      } else {
        const parsed = parseMediaPlaylist(playlist);
        /*
         * The last byte the playlist addresses has to be inside the file that
         * was actually copied. This is what catches a truncated destination
         * that still passed its own size check because the manifest and the
         * playlist disagree.
         */
        const end = Math.max(
          parsed.map.byteRange.offset + parsed.map.byteRange.length,
          ...parsed.segments.map(
            (segment) => segment.byteRange.offset + segment.byteRange.length,
          ),
        );
        if (end > media.size) {
          throw new Error(
            `its ranges end at ${end}, past the ${media.size}-byte media file`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `The HDD copy has an invalid playlist: ${rendition.playlistPath} (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  for (const relative of required) {
    const entry = await stat(safe(relative)).catch(() => null);
    if (!entry?.isFile() || entry.size === 0) {
      throw new Error(`The HDD incoming package is incomplete: ${relative}`);
    }
  }
  const master = await readFile(safe(manifest.masterPlaylistPath), "utf8");
  if (!master.startsWith("#EXTM3U") || !master.includes("#EXT-X-STREAM-INF")) {
    throw new Error("The HDD incoming package has an invalid master playlist.");
  }
  const parsed = JSON.parse(
    await readFile(
      safe(`${TITLE_PACKAGE_DIRECTORY}/${TITLE_PACKAGE_MANIFEST}`),
      "utf8",
    ),
  ) as TitlePackageManifest;
  if (
    parsed.sourceFingerprint !== manifest.sourceFingerprint ||
    parsed.profileVersion !== manifest.profileVersion
  ) {
    throw new Error("The HDD incoming manifest does not describe this build.");
  }
}

/**
 * Replaces the previous package's folders with the staged ones.
 *
 * Each folder is swapped by rename, which is atomic within a filesystem, so a
 * reader never sees a folder that is half of one package and half of another.
 * A request already reading a file keeps reading it: the bytes outlive the name
 * that led to them.
 */
async function swapPublishedDirectories(
  titleRoot: string,
  staging: string,
  renameFile: typeof rename,
): Promise<void> {
  const retired = `${staging}.retired`;
  await mkdir(retired, { recursive: true });
  const statePath = path.join(staging, ".activation.json");
  const completed = new Set<string>(
    await readFile(statePath, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as { completed?: string[] };
        return parsed.completed ?? [];
      })
      .catch((): string[] => []),
  );
  const commitState = async () => {
    const pending = `${statePath}.pending`;
    await writeFile(
      pending,
      `${JSON.stringify({ schemaVersion: 1, completed: [...completed] })}\n`,
      "utf8",
    );
    await renameFile(pending, statePath);
  };

  for (const directory of [
    TITLE_VIDEO_DIRECTORY,
    TITLE_AUDIO_DIRECTORY,
    TITLE_SUBTITLE_DIRECTORY,
    TITLE_PACKAGE_DIRECTORY,
  ]) {
    if (completed.has(directory)) continue;
    const staged = path.join(staging, directory);
    const live = path.join(titleRoot, directory);
    const old = path.join(retired, directory);
    const stagedExists = await pathExists(staged);
    const liveExists = await pathExists(live);
    const oldExists = await pathExists(old);

    // The staged directory has already been renamed but the process died before
    // recording it. Presence of both the new live directory and retired old
    // directory is sufficient to reconcile that boundary without copying.
    if (!stagedExists && liveExists && oldExists) {
      completed.add(directory);
      await commitState();
      continue;
    }
    if (!stagedExists) {
      // A package with no subtitles must still clear the previous package's
      // subtitle folder, or a dropped track keeps playing from a stale file.
      if (liveExists && !oldExists) await renameFile(live, old);
      completed.add(directory);
      await commitState();
      continue;
    }
    if (liveExists && !oldExists) await renameFile(live, old);
    await renameFile(staged, live);
    completed.add(directory);
    await commitState();
  }

  await rm(retired, { recursive: true, force: true }).catch(() => undefined);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Reads a title's package manifest, or null when the title has none. */
export async function readTitlePackageManifest(
  titleRoot: string,
): Promise<TitlePackageManifest | null> {
  try {
    titleRoot = await resolvePublishedTitleRoot(titleRoot);
    const raw = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_PACKAGE_MANIFEST),
      "utf8",
    );
    const parsed = JSON.parse(raw) as TitlePackageManifest;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schemaVersion !== TITLE_MANIFEST_SCHEMA_VERSION ||
      typeof parsed.masterPlaylistPath !== "string" ||
      !Array.isArray(parsed.video)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export { TITLE_MASTER_PLAYLIST };

/**
 * Adding renditions to a package that is already published, without replacing it.
 *
 * `publishTitlePackage` swaps whole directories, which is exactly right when a
 * package is being rebuilt and exactly wrong when one rendition is being added
 * to seven good ones: the swap would carry away every rendition this run did
 * not produce. So the new files are written in beside the existing ones and
 * only the three description files — master playlist, package manifest and
 * build record — are replaced, each by write-then-rename.
 *
 * The ordering matters for safety. Media lands first and is inert until
 * something references it; the master is rewritten last and atomically. A run
 * that dies part-way leaves an unreferenced file and a package that still
 * plays exactly as it did before.
 */
export async function publishAdditionalRenditions({
  workVersionRoot,
  titleRoot,
  existing,
  added,
  onProgress,
  publicationId = `${existing.profileVersion}-${existing.sourceFingerprint.slice(0, 16)}-incremental`,
  signal,
  destinationReserveBytes = 0,
  retainIncomingAfterPublish = false,
  fileSystem = { rename },
}: {
  workVersionRoot: string;
  titleRoot: string;
  /** The published package's own build record, read from disk. */
  existing: AdaptivePackageMetadata;
  /** Newly encoded renditions, in the packager's work layout. */
  added: Pick<
    AdaptivePackageMetadata,
    "videoRenditions" | "audioRenditions" | "subtitleRenditions"
  >;
  onProgress?: (progress: PublishPhaseProgress) => void;
  publicationId?: string;
  signal?: AbortSignal;
  destinationReserveBytes?: number;
  retainIncomingAfterPublish?: boolean;
  fileSystem?: Pick<typeof import("node:fs/promises"), "rename">;
}): Promise<{
  manifest: TitlePackageManifest;
  plan: TitleLayoutPlan;
  incomingDirectory: string;
  publishedRoot?: string;
}> {
  const publicationTitleRoot = titleRoot;
  titleRoot = await resolvePublishedTitleRoot(titleRoot);
  /*
   * Existing renditions are listed first so the layout planner hands them the
   * stems they already carry: their published paths must come out unchanged,
   * because those files are staying exactly where they are. Anything the new
   * run rebuilt replaces the old entry of the same id.
   */
  const replaced = new Set([
    ...added.videoRenditions.map((rendition) => rendition.id),
    ...added.audioRenditions.map((rendition) => rendition.id),
    ...(added.subtitleRenditions ?? []).map((rendition) => rendition.id),
  ]);
  const merged: AdaptivePackageMetadata = {
    ...existing,
    videoRenditions: [
      ...existing.videoRenditions.filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...added.videoRenditions,
    ].sort((left, right) => right.qualityHeight - left.qualityHeight),
    audioRenditions: [
      ...existing.audioRenditions.filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...added.audioRenditions,
    ],
    subtitleRenditions: [
      ...(existing.subtitleRenditions ?? []).filter(
        (rendition) => !replaced.has(rendition.id),
      ),
      ...(added.subtitleRenditions ?? []),
    ],
  };
  await assertTitleRootOwnedBy(titleRoot, merged.mediaId);
  const staging = await prepareIncoming(
    publicationTitleRoot,
    publicationId,
    merged,
  );

  const destinationSpace = await statfs(titleRoot);
  const destinationFreeBytes = destinationSpace.bavail * destinationSpace.bsize;
  const addedBytes = [
    ...added.videoRenditions,
    ...added.audioRenditions,
    ...(added.subtitleRenditions ?? []),
  ].reduce((sum, rendition) => sum + rendition.fileSizeBytes, 0);
  if (destinationFreeBytes - addedBytes < destinationReserveBytes) {
    const error = new Error(
      "The final media volume does not have enough free space for the incremental publication.",
    ) as NodeJS.ErrnoException;
    error.code = "ENOSPC";
    throw error;
  }

  const plan = planTitleLayout(merged);
  const generation = createHash("sha256")
    .update(JSON.stringify({ publicationId, merged }))
    .digest("hex");
  const generationRoot = path.join(
    publicationTitleRoot,
    PUBLICATION_GENERATIONS,
    generation,
  );
  if (
    (await realpath(generationRoot).catch(() => null)) ===
    (await realpath(titleRoot))
  ) {
    const manifest = await readTitlePackageManifest(publicationTitleRoot);
    if (!manifest)
      throw new Error(
        "The committed incremental publication is missing its manifest.",
      );
    if (!retainIncomingAfterPublish)
      await cleanupPublicationIncoming(
        publicationTitleRoot,
        staging,
        publicationId,
      );
    return {
      manifest,
      plan,
      incomingDirectory: staging,
      publishedRoot: generationRoot,
    };
  }
  // Reuse immutable bytes on the same filesystem. All modifications below use
  // write-then-rename, so these links never permit a write into an old reader's
  // files. Unsupported links fail before the active pointer changes.
  const clone = async (source: string, destination: string): Promise<void> => {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (
        entry.name === "current.json" &&
        path.basename(source) === TITLE_PACKAGE_DIRECTORY
      )
        continue;
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) await clone(from, to);
      else if (entry.isFile())
        await link(from, to).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      else
        throw new Error(
          "A published package contains an unsupported filesystem entry.",
        );
    }
  };
  for (const directory of [
    TITLE_VIDEO_DIRECTORY,
    TITLE_AUDIO_DIRECTORY,
    TITLE_SUBTITLE_DIRECTORY,
    TITLE_PACKAGE_DIRECTORY,
  ]) {
    const source = path.join(titleRoot, directory);
    if (await pathExists(source))
      await clone(source, path.join(generationRoot, directory));
  }
  titleRoot = generationRoot;
  const publishedById = new Map<string, { media: string; playlist: string }>();
  for (const group of [plan.video, plan.audio, plan.subtitle]) {
    for (const entry of group) {
      publishedById.set(entry.id, {
        media: entry.mediaPath,
        playlist: entry.playlistPath,
      });
    }
  }

  // Media and its playlist, moved into the live package beside what is there.
  const moveIn = async (rendition: {
    id: string;
    mediaPath: string;
    playlistPath: string;
  }) => {
    const target = publishedById.get(rendition.id);
    if (!target) return;
    const destinationMedia = path.join(titleRoot, ...target.media.split("/"));
    const destinationPlaylist = path.join(
      titleRoot,
      ...target.playlist.split("/"),
    );
    await mkdir(path.dirname(destinationMedia), { recursive: true });
    await mkdir(path.dirname(destinationPlaylist), { recursive: true });
    const sourceMedia = path.join(
      workVersionRoot,
      ...rendition.mediaPath.split("/"),
    );
    if (!(await replicasMatch(sourceMedia, destinationMedia))) {
      const stagedMedia = path.join(staging, ...target.media.split("/"));
      await copyFileResumable(sourceMedia, stagedMedia, {
        ...(signal ? { signal } : {}),
      });
      await rename(stagedMedia, destinationMedia);
    }
    const playlist = await readFile(
      path.join(workVersionRoot, ...rendition.playlistPath.split("/")),
      "utf8",
    );
    const pending = `${destinationPlaylist}.pending`;
    await writeFile(
      pending,
      rewriteRenditionPlaylist(
        playlist,
        path.posix.basename(rendition.mediaPath),
        target.media,
      ),
      "utf8",
    );
    await rename(pending, destinationPlaylist);
  };

  const bytesOf = (renditions: readonly { fileSizeBytes: number }[]) =>
    renditions.reduce((sum, rendition) => sum + rendition.fileSizeBytes, 0);
  const progress = createPublishReporter(
    [
      ...(added.videoRenditions.length > 0
        ? [{ id: "video" as const, bytes: bytesOf(added.videoRenditions) }]
        : []),
      ...(added.audioRenditions.length > 0
        ? [{ id: "audio" as const, bytes: bytesOf(added.audioRenditions) }]
        : []),
      ...((added.subtitleRenditions?.length ?? 0) > 0
        ? [
            {
              id: "subtitles" as const,
              bytes: bytesOf(added.subtitleRenditions ?? []),
            },
          ]
        : []),
      { id: "master-playlist" as const },
      { id: "manifest" as const },
      { id: "build-record" as const },
    ],
    onProgress,
  );

  progress.begin("video");
  for (const rendition of added.videoRenditions) await moveIn(rendition);
  progress.complete("video");
  progress.begin("audio");
  for (const rendition of added.audioRenditions) await moveIn(rendition);
  progress.complete("audio");
  progress.begin("subtitles");
  for (const rendition of added.subtitleRenditions ?? []) {
    await moveIn({
      id: rendition.id,
      mediaPath: rendition.subtitlePath,
      playlistPath: rendition.playlistPath,
    });
  }
  progress.complete("subtitles");
  progress.begin("master-playlist");

  /*
   * Rebuilt from the merged set rather than from whatever this run's FFmpeg
   * happened to emit, so the master describes every rendition the title holds
   * — including the seven this job never touched.
   */
  const republished = <T extends { id: string }>(
    renditions: readonly T[],
    pathKey: "mediaPath" | "subtitlePath",
  ) =>
    renditions.map((rendition) => {
      const target = publishedById.get(rendition.id);
      return {
        ...rendition,
        ...(target
          ? { [pathKey]: target.media, playlistPath: target.playlist }
          : {}),
      } as T;
    });

  const publishedMetadata: AdaptivePackageMetadata & {
    masterLayoutVersion: number;
  } = {
    ...merged,
    masterLayoutVersion: MASTER_LAYOUT_VERSION,
    masterPlaylistPath: plan.masterPlaylistPath,
    videoRenditions: republished(merged.videoRenditions, "mediaPath"),
    audioRenditions: republished(merged.audioRenditions, "mediaPath"),
    subtitleRenditions: republished(
      merged.subtitleRenditions ?? [],
      "subtitlePath",
    ),
  };

  const atomicWrite = async (relative: string, contents: string) => {
    const target = path.join(titleRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const pending = `${target}.pending`;
    await writeFile(pending, contents, "utf8");
    await rename(pending, target);
  };

  const subtitles = publishedMetadata.subtitleRenditions ?? [];
  const totalBytes = [
    ...publishedMetadata.videoRenditions,
    ...publishedMetadata.audioRenditions,
    ...subtitles,
  ].reduce((total, rendition) => total + rendition.fileSizeBytes, 0);

  const manifest: TitlePackageManifest = {
    schemaVersion: TITLE_MANIFEST_SCHEMA_VERSION,
    profileVersion: publishedMetadata.profileVersion,
    sourceFingerprint: publishedMetadata.sourceFingerprint,
    createdAt: publishedMetadata.createdAt,
    sourceDurationSeconds: publishedMetadata.sourceDurationSeconds,
    masterPlaylistPath: plan.masterPlaylistPath,
    video: publishedMetadata.videoRenditions.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.mediaPath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      qualityHeight: rendition.qualityHeight,
      width: rendition.width,
      height: rendition.height,
      codec: rendition.codec,
      codecString: rendition.codecString,
      frameRate: rendition.frameRate,
      hdr: rendition.hdr,
      averageBitrate: rendition.averageBitrate,
      peakBitrate: rendition.peakBitrate,
    })),
    audio: publishedMetadata.audioRenditions.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.mediaPath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      sourceStreamIndex: rendition.sourceStreamIndex,
      ...(rendition.language ? { language: rendition.language } : {}),
      ...(rendition.title ? { title: rendition.title } : {}),
      isDefault: rendition.isDefault,
      isForced: rendition.isForced,
      codecString: rendition.codecString,
      channels: rendition.channels,
    })),
    subtitle: subtitles.map((rendition) => ({
      id: rendition.id,
      mediaPath: rendition.subtitlePath,
      playlistPath: rendition.playlistPath,
      fileSizeBytes: rendition.fileSizeBytes,
      sourceStreamIndex: rendition.sourceStreamIndex,
      ...(rendition.language ? { language: rendition.language } : {}),
      ...(rendition.title ? { title: rendition.title } : {}),
      isDefault: rendition.isDefault,
      isForced: rendition.isForced,
      isHearingImpaired: rendition.isHearingImpaired,
      ...(rendition.sidecarFingerprint
        ? { sidecarFingerprint: rendition.sidecarFingerprint }
        : {}),
    })),
    storage: { totalBytes },
  };

  // The record describes the whole package, so its byte totals must count the
  // renditions this run reused as well as the ones it produced.
  const sumBytes = (renditions: readonly { fileSizeBytes: number }[]) =>
    renditions.reduce((total, rendition) => total + rendition.fileSizeBytes, 0);
  publishedMetadata.storage = {
    videoBytes: sumBytes(publishedMetadata.videoRenditions),
    audioBytes: sumBytes(publishedMetadata.audioRenditions),
    subtitleBytes: sumBytes(subtitles),
    totalBytes,
  };

  progress.begin("build-record");
  await atomicWrite(
    `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`,
    `${JSON.stringify(publishedMetadata, null, 2)}\n`,
  );
  progress.complete("build-record");
  progress.begin("manifest");
  await atomicWrite(
    plan.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  progress.complete("manifest");
  // Last, so nothing advertises a rendition before its bytes are in place.
  await atomicWrite(
    plan.masterPlaylistPath,
    buildTitleMasterPlaylist(publishedMetadata),
  );
  progress.complete("master-playlist");

  const pointer = path.join(publicationTitleRoot, PUBLICATION_POINTER);
  const pendingPointer = path.join(staging, ".current.pending");
  await writeFile(
    pendingPointer,
    `${JSON.stringify({ schemaVersion: 1, generation })}\n`,
    "utf8",
  );
  const pointerFile = await open(pendingPointer, "r+");
  try {
    await pointerFile.sync();
  } finally {
    await pointerFile.close();
  }
  await fileSystem.rename(pendingPointer, pointer);

  if (!retainIncomingAfterPublish) {
    await cleanupPublicationIncoming(
      publicationTitleRoot,
      staging,
      publicationId,
    );
  }

  return {
    manifest,
    plan,
    incomingDirectory: staging,
    publishedRoot: titleRoot,
  };
}

/** Removes only the owned incoming tree for one confirmed publication. */
export async function cleanupPublicationIncoming(
  titleRoot: string,
  incomingDirectory: string,
  publicationId: string,
  remove: typeof rm = rm,
): Promise<void> {
  const expected = path.resolve(
    titleRoot,
    TITLE_INCOMING_DIRECTORY,
    safePublicationId(publicationId),
  );
  if (path.resolve(incomingDirectory) !== expected) {
    throw new Error(
      "Refusing to clean an incoming directory outside this publication.",
    );
  }
  const owner = JSON.parse(
    await readFile(path.join(expected, PUBLICATION_OWNER_FILE), "utf8"),
  ) as Record<string, unknown>;
  if (owner.publicationId !== publicationId) {
    throw new Error(
      "Refusing to clean an incoming directory owned by another publication.",
    );
  }
  await remove(expected, { recursive: true, force: true });
  /*
   * The shared `.seyirlik-incoming` parent is removed only when this was the
   * last publication using it, which `rmdir` decides by refusing a directory
   * that still has entries. `rm` without `recursive` throws on any directory,
   * so the previous call here always failed and always left the empty folder
   * sitting in the title beside the published package.
   */
  await rmdir(path.dirname(expected)).catch(() => undefined);
}

/** The master a published package should carry, built from its own record. */
function buildTitleMasterPlaylist(metadata: AdaptivePackageMetadata): string {
  const relative = (published: string): string =>
    playlistUri(published.slice(TITLE_PACKAGE_DIRECTORY.length + 1));
  return buildMasterPlaylist({
    videoRenditions: metadata.videoRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relative(rendition.playlistPath),
    })),
    audioRenditions: metadata.audioRenditions.map((rendition) => ({
      ...rendition,
      playlistPath: relative(rendition.playlistPath),
    })),
    subtitleRenditions: (metadata.subtitleRenditions ?? []).map(
      (rendition) => ({
        ...rendition,
        playlistPath: relative(rendition.playlistPath),
      }),
    ),
    videoCodecStrings: new Map(
      metadata.videoRenditions.map((rendition) => [
        rendition.id,
        rendition.codecString,
      ]),
    ),
    audioCodecStrings: new Map(
      metadata.audioRenditions.map((rendition) => [
        rendition.id,
        rendition.codecString,
      ]),
    ),
  });
}

/**
 * A published package's own build record, which carries far more than the
 * manifest does — codec strings measured off the bitstream, achieved bitrates,
 * keyframe cadence. An incremental publish needs all of it to rebuild a master
 * that describes renditions it never encoded.
 */
export async function readTitleBuildRecord(
  titleRoot: string,
): Promise<AdaptivePackageMetadata | null> {
  try {
    titleRoot = await resolvePublishedTitleRoot(titleRoot);
    const raw = await readFile(
      path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_BUILD_RECORD),
      "utf8",
    );
    const record = JSON.parse(raw) as AdaptivePackageMetadata;
    // Without measured codec strings a faithful master cannot be regenerated,
    // and inventing them would advertise a bitstream nobody verified.
    const complete =
      Array.isArray(record.videoRenditions) &&
      record.videoRenditions.length > 0 &&
      record.videoRenditions.every((rendition) => rendition.codecString) &&
      (record.audioRenditions ?? []).every(
        (rendition) => rendition.codecString,
      );
    return complete ? record : null;
  } catch {
    return null;
  }
}
