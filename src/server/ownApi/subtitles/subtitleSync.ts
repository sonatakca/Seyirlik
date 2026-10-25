/**
 * Correcting a subtitle that is right about the words and wrong about when.
 *
 * The rest of this subsystem answers "find me a subtitle". This answers the
 * question that comes next and far more often: the subtitle is here, somebody
 * has watched twenty minutes of it, and every line arrives fourteen seconds
 * late. Nothing about that is a search problem — the file is correct, the
 * translation is somebody's work, and the only thing wrong with it is an
 * arithmetic fact about its timeline.
 *
 * Two things are chosen rather than inferred, and both belong to the operator:
 *
 *  - **Which subtitle to correct.** Only a sidecar can be corrected. An
 *    embedded track lives inside the container and moving it would mean
 *    rewriting the film, which is not a subtitle operation; such a track is
 *    offered as a *reference* and never as a target.
 *  - **What to trust instead.** Either another subtitle track — usually the
 *    English one that came with the release and is known to be right — or an
 *    audio track. A reference subtitle is the better signal by a wide margin
 *    when one exists, because it carries one onset per line of dialogue rather
 *    than one per stretch of speech; audio is what is left when it does not.
 *
 * The correction is `time · rate + offset` and nothing more expressive. That is
 * not a simplification of the problem, it is the problem: a subtitle and a film
 * are two clocks, and two clocks differ by where they started and how fast they
 * run. A subtitle that needs more than this — one timed to a different cut —
 * cannot be repaired by moving it, and the confidence figure is what says so.
 */

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
import type { PlaybackRefreshBoundary } from "../playback/playbackRefresh";
import { extractSubtitleAsWebVtt } from "../playback/subtitleDelivery";
import {
  readAudioEnvelope,
  speechIntervalsFromEnvelope,
  SPEECH_DUTY_CYCLES,
} from "./audioSpeech";
import { toUtf8 } from "./subtitleArchive";
import {
  alignSpeech,
  type AlignmentProposal,
  type SpeechInterval,
} from "./subtitleAlignment";
import {
  cueIntervals,
  documentCues,
  parseSubtitleDocument,
  retimeBlocks,
  serialiseSubtitleDocument,
  type CueTransform,
} from "./subtitleCues";
import type { SubtitleRepository } from "./subtitleRepository";
import { subtitleDigest, type SubtitleStorage } from "./subtitleStorage";
import type { TitleReferences } from "./subtitleReferences";

/**
 * How sure the alignment has to be before anything is written.
 *
 * `confidence` is the proposal's match count measured against how often cues
 * land near a reference onset by chance. Against the library's own files a
 * correct alignment scores between 0.54 and 0.77 whether the reference is a
 * subtitle or an audio track, and an alignment of two *different films* scores
 * between 0.00 and 0.04. The gap is wide enough that the threshold's exact
 * value hardly matters, which is the point of choosing a measure that has one.
 */
export const MINIMUM_SYNC_CONFIDENCE = 0.35;

/** Below this there is nothing to correct and the file is left alone. */
const NEGLIGIBLE_OFFSET_SECONDS = 0.05;
const NEGLIGIBLE_RATE = 0.00002;

/** What the operator may pick as the thing to correct. */
export interface SyncSubtitleTrack {
  readonly streamIndex: number;
  readonly language: string | null;
  readonly title: string | null;
  readonly forced: boolean;
  readonly external: boolean;
  /** The file's own name, which is how a person recognises a sidecar. */
  readonly fileName: string | null;
  /**
   * Whether this track can be corrected, as opposed to merely consulted.
   *
   * False for every embedded track: correcting one means rewriting the
   * container, and a subtitle feature that rewrites films is a different and
   * far more dangerous thing than this.
   */
  readonly retimable: boolean;
}

export interface SyncAudioTrack {
  readonly streamIndex: number;
  readonly language: string | null;
  readonly title: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly isDefault: boolean;
}

export interface SyncTracks {
  readonly mediaFileId: string;
  readonly subtitles: readonly SyncSubtitleTrack[];
  readonly audio: readonly SyncAudioTrack[];
}

export type SyncReference =
  | { readonly kind: "subtitle"; readonly streamIndex: number }
  | { readonly kind: "audio"; readonly streamIndex: number };

export interface SubtitleSyncRequest {
  readonly mediaFileId: string;
  /** The sidecar to correct, by the stream index the catalogue gave it. */
  readonly targetStreamIndex: number;
  readonly reference: SyncReference;
  /**
   * A correction to apply as given, instead of one to work out.
   *
   * For the operator who already knows — a subtitle they have watched enough of
   * to name the shift themselves, or a proposal they saw in a dry run and want
   * applied without the audio being read a second time. Supplying it skips the
   * analysis and therefore skips the confidence gate, which is the operator's
   * to skip and nothing else's.
   */
  readonly transform?: CueTransform;
  /** Work out the correction and report it, writing nothing. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
  readonly progress?: (message: string) => Promise<void>;
}

export interface SubtitleSyncProposal extends AlignmentProposal {
  /** What the correction does to the first cue, which is what a person checks. */
  readonly firstCueBeforeSeconds: number | null;
  readonly firstCueAfterSeconds: number | null;
}

export type SubtitleSyncResult =
  | ({
      readonly outcome: "analysed" | "applied" | "unchanged";
      readonly relativePath: string;
      readonly fileName: string;
      readonly referenceKind: SyncReference["kind"];
      readonly referenceLabel: string;
      readonly cueCount: number;
      readonly droppedCues: number;
      readonly clampedCues: number;
    } & SubtitleSyncProposal)
  | {
      readonly outcome: "refused";
      readonly failure: string;
      readonly reason: string;
    };

/** The catalogue reads a sync makes, and nothing else it can reach. */
export interface SubtitleSyncCatalogue {
  getFileById(fileId: string): Promise<MediaFileRow | null>;
  listStreams(mediaFileId: string): Promise<MediaStreamRow[]>;
}

export interface SubtitleSyncService {
  tracks(mediaFileId: string): Promise<SyncTracks>;
  sync(request: SubtitleSyncRequest): Promise<SubtitleSyncResult>;
}

/** A text subtitle FFmpeg can read; the same set the player already offers. */
function isReadableSubtitle(stream: MediaStreamRow): boolean {
  return stream.kind === "subtitle" && stream.isTextSubtitle;
}

function refuse(failure: string, reason: string): SubtitleSyncResult {
  return { outcome: "refused", failure, reason };
}

function trackLabel(
  stream: Pick<MediaStreamRow, "language" | "title" | "streamIndex">,
): string {
  return (
    stream.title?.trim() || stream.language || `stream ${stream.streamIndex}`
  );
}

export function createSubtitleSyncService(dependencies: {
  libraryRoot: string;
  ffmpegPath: string;
  catalogue: SubtitleSyncCatalogue;
  repository: Pick<
    SubtitleRepository,
    "mediaFileRelativePath" | "recordRetiming"
  >;
  storageFactory: (
    relativeMedia: string,
    mediaFileId: string,
  ) => SubtitleStorage;
  playback?: PlaybackRefreshBoundary;
  onFilesChanged?: (relativePath: string) => Promise<void>;
  /**
   * The package's audio and its copies of the video's own subtitles. Preferred
   * to the source even while it exists (the same print, a fraction of the
   * reading), and the only way to retime against either once it is removed.
   */
  references?: TitleReferences;
}): SubtitleSyncService {
  const { libraryRoot, ffmpegPath, catalogue, repository } = dependencies;

  /** Absolute, for the two readers that take a path rather than a catalogue id. */
  const absolute = (relative: string) =>
    path.join(libraryRoot, ...relative.split("/"));

  return {
    async tracks(mediaFileId) {
      const streams = await catalogue.listStreams(mediaFileId);
      return {
        mediaFileId,
        subtitles: streams.filter(isReadableSubtitle).map((stream) => ({
          streamIndex: stream.streamIndex,
          language: stream.language,
          title: stream.title,
          forced: stream.isForced,
          external: stream.isExternal,
          fileName: stream.externalRelativePath?.split("/").pop() ?? null,
          retimable: stream.isExternal && stream.externalRelativePath !== null,
        })),
        audio: streams
          .filter((stream) => stream.kind === "audio")
          .map((stream) => ({
            streamIndex: stream.streamIndex,
            language: stream.language,
            title: stream.title,
            codec: stream.codec,
            channels: stream.channels,
            isDefault: stream.isDefault,
          })),
      };
    },

    async sync(request) {
      const file = await catalogue.getFileById(request.mediaFileId);
      if (!file || file.missingSince !== null)
        return refuse("media-missing", "This title has no file on disk.");
      const relativeMedia = await repository.mediaFileRelativePath(
        request.mediaFileId,
      );
      if (relativeMedia === null)
        return refuse(
          "media-missing",
          "The catalogue has no path for this file.",
        );

      const streams = await catalogue.listStreams(request.mediaFileId);
      const target = streams.find(
        (stream) =>
          stream.streamIndex === request.targetStreamIndex &&
          isReadableSubtitle(stream),
      );
      if (!target)
        return refuse("target-missing", "That subtitle track is not here.");
      if (!target.isExternal || !target.externalRelativePath) {
        return refuse(
          "target-embedded",
          "Only a subtitle file beside the video can be re-timed. This one is inside the video.",
        );
      }
      if (
        request.reference.kind === "subtitle" &&
        request.reference.streamIndex === target.streamIndex
      ) {
        return refuse(
          "reference-invalid",
          "A subtitle cannot be timed against itself.",
        );
      }

      const storage = dependencies.storageFactory(
        relativeMedia,
        request.mediaFileId,
      );
      const relativePath = target.externalRelativePath;
      const fileName = relativePath.split("/").pop() ?? relativePath;

      let originalBytes: Uint8Array;
      try {
        originalBytes = await storage.read(request.mediaFileId, relativePath);
      } catch (error) {
        return refuse(
          "target-unreadable",
          error instanceof Error && error.name === "StorageFailure"
            ? error.message
            : "That subtitle file could not be read.",
        );
      }

      /*
       * Decoded the way the uploader decodes: a hand-placed Turkish sidecar is
       * very often Windows-1254, and refusing it would make the feature useless
       * for the library it is for. The rewrite therefore also lands as UTF-8,
       * which is a change to the file beyond its timings — and the right one,
       * since everything downstream, the validator included, requires it.
       */
      const document = parseSubtitleDocument(
        new TextDecoder("utf-8").decode(
          toUtf8(originalBytes, target.language ?? "und"),
        ),
      );
      const cues = documentCues(document);
      if (cues.length === 0)
        return refuse("target-empty", "That subtitle file holds no cues.");
      const targetIntervals = cueIntervals(cues);

      let proposal: AlignmentProposal;
      let referenceLabel: string;

      if (request.transform) {
        proposal = {
          ...request.transform,
          matchedCues: 0,
          consideredCues: cues.length,
          matchedFraction: 0,
          medianErrorSeconds: Number.NaN,
          coarseScore: 0,
          // An operator's own figure is not a measurement and is not scored.
          confidence: 1,
        };
        referenceLabel = "a correction given by hand";
      } else if (request.reference.kind === "subtitle") {
        const reference = streams.find(
          (stream) =>
            stream.streamIndex === request.reference.streamIndex &&
            isReadableSubtitle(stream),
        );
        if (!reference)
          return refuse(
            "reference-missing",
            "That reference subtitle is not here.",
          );
        await request.progress?.("Reading the reference subtitle");
        let referenceIntervals: SpeechInterval[] | null;
        try {
          referenceIntervals = await readReferenceSubtitle(
            reference,
            storage,
            request.mediaFileId,
            relativeMedia,
          );
        } catch {
          return refuse(
            "reference-unreadable",
            "That reference subtitle could not be read.",
          );
        }
        if (referenceIntervals === null)
          return refuse(
            "source-removed",
            "That subtitle was inside the removed source video and its package holds no copy of it.",
          );
        if (referenceIntervals.length === 0)
          return refuse(
            "reference-empty",
            "That reference subtitle holds no cues.",
          );
        proposal = alignSpeech(targetIntervals, referenceIntervals);
        referenceLabel = `the ${trackLabel(reference)} subtitle`;
      } else {
        const reference = streams.find(
          (stream) =>
            stream.streamIndex === request.reference.streamIndex &&
            stream.kind === "audio",
        );
        if (!reference)
          return refuse("reference-missing", "That audio track is not here.");
        // The package's rendition of this track, else the source's own.
        const audio =
          (await dependencies.references
            ?.audio({
              mediaFileId: request.mediaFileId,
              relativePath: relativeMedia,
              sourceStreamIndex: reference.streamIndex,
            })
            .catch(() => null)) ??
          ((await sourceIsGone(relativeMedia))
            ? null
            : {
                path: absolute(relativeMedia),
                streamIndex: reference.streamIndex,
              });
        if (!audio)
          return refuse(
            "source-removed",
            "This title's source video has been removed and its package has no audio to listen to.",
          );
        await request.progress?.("Listening to the audio");
        const envelope = await readAudioEnvelope({
          ffmpegPath,
          inputPath: audio.path,
          streamIndex: audio.streamIndex,
          ...(audio.isPackagePlaylist ? { isPackagePlaylist: true } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        await request.progress?.("Matching the subtitle against the speech");
        /*
         * Where a stretch of speech starts depends on where the threshold is
         * put, and the right threshold is a property of the film's mix rather
         * than of any constant. Reading the audio is what costs; trying three
         * thresholds against it is arithmetic, so all three are tried and the
         * most confident answer wins.
         */
        let best: AlignmentProposal | null = null;
        for (const dutyCycle of SPEECH_DUTY_CYCLES) {
          const speech = speechIntervalsFromEnvelope(envelope, { dutyCycle });
          if (speech.length === 0) continue;
          const candidate = alignSpeech(targetIntervals, speech);
          if (best === null || candidate.confidence > best.confidence)
            best = candidate;
        }
        if (best === null)
          return refuse(
            "reference-empty",
            "No speech could be found in that audio track.",
          );
        proposal = best;
        referenceLabel = `the ${trackLabel(reference)} audio`;
      }

      const firstCue = cues[0];
      const enriched: SubtitleSyncProposal = {
        ...proposal,
        firstCueBeforeSeconds: firstCue?.startSeconds ?? null,
        firstCueAfterSeconds:
          firstCue === undefined
            ? null
            : firstCue.startSeconds * proposal.rate + proposal.offsetSeconds,
      };
      const report = (
        outcome: "analysed" | "applied" | "unchanged",
        extra: { droppedCues: number; clampedCues: number },
      ): SubtitleSyncResult => ({
        outcome,
        relativePath,
        fileName,
        referenceKind: request.reference.kind,
        referenceLabel,
        cueCount: cues.length,
        ...extra,
        ...enriched,
      });

      if (proposal.confidence < MINIMUM_SYNC_CONFIDENCE) {
        return refuse(
          "unconvincing",
          "This subtitle and that reference do not look like the same film; nothing was changed.",
        );
      }
      if (
        Math.abs(proposal.offsetSeconds) < NEGLIGIBLE_OFFSET_SECONDS &&
        Math.abs(proposal.rate - 1) < NEGLIGIBLE_RATE
      ) {
        return report("unchanged", { droppedCues: 0, clampedCues: 0 });
      }

      const retimed = retimeBlocks(document.blocks, proposal);
      if (request.dryRun) {
        return report("analysed", {
          droppedCues: retimed.dropped,
          clampedCues: retimed.clamped,
        });
      }

      const bytes = new TextEncoder().encode(
        serialiseSubtitleDocument({ ...document, blocks: retimed.blocks }),
      );
      const written = await storage.rewrite({
        mediaFileId: request.mediaFileId,
        relativePath,
        bytes,
        expectedSha256: subtitleDigest(originalBytes),
      });
      if (written.outcome === "error")
        return refuse(written.failure, written.reason);
      if (written.outcome === "cancelled")
        return refuse("cancelled", "The correction was cancelled.");

      /*
       * The receipt is updated, never replaced. A retimed subtitle is the same
       * installation with different bytes — it answers the same want, came from
       * the same provider, and is still in the same language — so the digest and
       * the sync state move and the provenance stays where it is.
       */
      await repository.recordRetiming({
        mediaFileId: request.mediaFileId,
        relativePath,
        language: target.language ?? "und",
        forced: target.isForced,
        format: fileName.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
        sha256: written.sha256,
        sizeBytes: bytes.length,
        cueCount:
          written.outcome === "installed" ? written.cueCount : cues.length,
      });

      await dependencies.onFilesChanged?.(relativePath).catch(() => undefined);

      // Observational, and after the commit: a player that will not refresh
      // does not un-write a correct subtitle.
      await dependencies.playback
        ?.request({ mediaFileId: request.mediaFileId, kind: "subtitles" })
        .catch(() => undefined);

      return report("applied", {
        droppedCues: retimed.dropped,
        clampedCues: retimed.clamped,
      });
    },
  };

  async function sourceIsGone(relativeMedia: string): Promise<boolean> {
    return lstat(absolute(relativeMedia)).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  }

  /**
   * The reference track's cues, from wherever that track lives, or null when
   * it lived only inside a source that is gone.
   *
   * A sidecar is read straight off the disk. A track that was inside the video
   * is read from the package's WebVTT copy when there is one — the file the
   * player shows, so the subtitle is aligned to the timeline the viewer sees —
   * and otherwise through the same FFmpeg conversion the player uses on the
   * source.
   */
  async function readReferenceSubtitle(
    reference: MediaStreamRow,
    storage: SubtitleStorage,
    mediaFileId: string,
    relativeMedia: string,
  ): Promise<SpeechInterval[] | null> {
    const intervals = (text: string) =>
      cueIntervals(documentCues(parseSubtitleDocument(text)));
    if (reference.isExternal && reference.externalRelativePath)
      return intervals(
        new TextDecoder("utf-8").decode(
          toUtf8(
            await storage.read(mediaFileId, reference.externalRelativePath),
            reference.language ?? "und",
          ),
        ),
      );
    const packaged = (
      (await dependencies.references
        ?.embeddedSubtitles({ mediaFileId, relativePath: relativeMedia })
        .catch(() => [])) ?? []
    ).find((subtitle) => subtitle.streamIndex === reference.streamIndex);
    if (packaged) return intervals(await readFile(packaged.path, "utf8"));
    if (await sourceIsGone(relativeMedia)) return null;
    return intervals(
      (
        await extractSubtitleAsWebVtt(
          absolute(relativeMedia),
          reference.streamIndex,
          ffmpegPath,
        )
      ).toString("utf8"),
    );
  }
}
