/**
 * Correcting a subtitle that is right about the words and wrong about when.
 *
 * The rest of this subsystem answers "find me a subtitle". This answers the
 * question that comes next and far more often: the subtitle is here, somebody
 * has watched twenty minutes of it, and the lines arrive late — everywhere, or
 * only after the scene this edition cut. Nothing about that is a search
 * problem: the file is somebody's translation and the only thing wrong with it
 * is when each line appears.
 *
 * Two things are chosen rather than inferred, and both belong to the operator:
 *
 *  - **Which subtitle to correct.** Only a sidecar can be corrected. An
 *    embedded track lives inside the container and moving it would mean
 *    rewriting the film; such a track is offered as a *reference* only.
 *  - **What to trust instead.** Another subtitle track timed to this edition,
 *    or an audio track. A reference subtitle carries one onset per line and is
 *    by far the better signal when one exists.
 *
 * The correction is found region by region (`alignPiecewise`): a subtitle
 * timed to a different cut is right in some places and wrong by different
 * amounts in others, and one `rate · t + offset` for the whole file — what this
 * used to apply — fixes one region by breaking the rest. What is written is
 * decided by how much of the result the evidence supports:
 *
 *  - **Already right**: nothing is written.
 *  - **Every cue placed by strong evidence**: written straight away.
 *  - **Anything less** — a region nobody can place, dialogue from a scene this
 *    edition lacks, a cue placed beside an edit by elimination — is returned as
 *    a proposal. An operator who has looked at it applies *that proposal*, to
 *    exactly the bytes it was computed from.
 *
 * Every write goes through `writeSubtitleRevision`, so the version it replaces
 * is in the database before the file is touched and can be put back.
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
import {
  alignmentStrength,
  alignPiecewise,
  type AlignmentReference,
  type CueAnchor,
  type CueDisposition,
  type PiecewiseAlignment,
  type PiecewiseBreakpoint,
  type PiecewiseSegment,
  type PiecewiseVerdict,
  type ReferenceKind,
} from "./piecewiseAlignment";
import { toUtf8 } from "./subtitleArchive";
import type { SpeechInterval } from "./subtitleAlignment";
import {
  cueIntervals,
  documentCues,
  parseSubtitleDocument,
  retimeBlocks,
  serialiseSubtitleDocument,
  type CueTransform,
  type SubtitleDocument,
} from "./subtitleCues";
import type { SubtitleRepository } from "./subtitleRepository";
import {
  settlePendingRevision,
  writeSubtitleRevision,
  type RevisionOrigin,
  type SubtitleRevision,
  type SubtitleRevisionStore,
} from "./subtitleRevisions";
import { subtitleDigest, type SubtitleStorage } from "./subtitleStorage";
import type { TitleReferences } from "./subtitleReferences";
import {
  alignmentCues,
  applyPlacements,
  canApplyUnreviewed,
} from "./subtitleTimeMap";

/**
 * How sure the old global alignment had to be before it was written.
 *
 * No longer a write threshold: the piecewise result's own verdict decides what
 * may be written. Kept because the download-time fit still reports the global
 * figure beside the piecewise one, and because the regression tests pin the
 * damage this threshold used to let through.
 */
export const MINIMUM_SYNC_CONFIDENCE = 0.35;

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

/** One cue of a proposal, as reviewed and as applied. Seconds, to the millisecond. */
export interface SyncCuePlacement {
  readonly index: number;
  readonly disposition: CueDisposition;
  readonly sourceStartSeconds: number;
  readonly sourceEndSeconds: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** The cue's text, so a person reviewing can see which line this is. */
  readonly text: string;
}

/** A proposal an operator has looked at and wants applied as it was. */
export interface ReviewedProposal {
  /** The digest of the subtitle the proposal was computed from. */
  readonly subtitleSha256: string;
  readonly placements: readonly Pick<
    SyncCuePlacement,
    "index" | "disposition" | "startSeconds" | "endSeconds"
  >[];
  /** What to do with dialogue from footage this edition lacks. */
  readonly unmatched: "keep" | "exclude";
  readonly previewTaskId: string;
  readonly verdict: PiecewiseVerdict;
}

export interface SubtitleSyncRequest {
  readonly mediaFileId: string;
  /** The sidecar to correct, by the stream index the catalogue gave it. */
  readonly targetStreamIndex: number;
  readonly reference: SyncReference;
  /**
   * A correction to apply as given, instead of one to work out.
   *
   * For the operator who already knows — a subtitle they have watched enough
   * of to name the shift themselves. Supplying it skips the analysis and the
   * evidence gate, which is the operator's to skip and nothing else's.
   */
  readonly transform?: CueTransform;
  /** Apply a proposal that was reviewed, rather than analysing again. */
  readonly reviewed?: ReviewedProposal;
  /** Work out the correction and report it, writing nothing. */
  readonly dryRun?: boolean;
  /**
   * Transcript-derived evidence for this title's audio, when it has been
   * analysed (see `subtitleTranscript.ts`). Optional: without it the speech
   * envelope is all the audio says.
   */
  readonly transcript?: TranscriptEvidence | null;
  readonly signal?: AbortSignal;
  readonly progress?: (message: string) => Promise<void>;
}

/**
 * What an ASR pass contributes: speech segments timed by the recogniser, and
 * anchors from matching what each cue says to what was spoken.
 */
export interface TranscriptEvidence {
  readonly intervals: readonly SpeechInterval[];
  /** Built per subtitle, since they depend on the cues' text. */
  anchorsFor?(
    cues: readonly { index: number; text: string; startSeconds: number }[],
  ): Promise<readonly CueAnchor[]>;
  readonly describe: Record<string, unknown>;
}

/** The parts of a piecewise alignment an operator reviews, sized for a task result. */
export interface SyncAlignmentReport {
  readonly verdict: PiecewiseVerdict;
  readonly autoApplicable: boolean;
  readonly coverage: number;
  readonly counts: Readonly<Record<CueDisposition, number>>;
  readonly placedAtEdits: number;
  readonly rate: number;
  readonly reference: ReferenceKind;
  readonly anchorCount: number;
  readonly version: string;
  readonly segments: readonly PiecewiseSegment[];
  readonly breakpoints: readonly PiecewiseBreakpoint[];
  readonly cues: readonly SyncCuePlacement[];
}

export interface SubtitleSyncSuccess {
  readonly outcome: "analysed" | "applied" | "unchanged" | "restored";
  readonly relativePath: string;
  readonly fileName: string;
  readonly referenceKind: SyncReference["kind"] | "manual" | "revision";
  readonly referenceLabel: string;
  readonly cueCount: number;
  /** The digest of the subtitle as it was read, which a review must still match. */
  readonly subtitleSha256: string;
  /** The revision written, when something was. */
  readonly revisionId: string | null;
  /**
   * True when nothing was written because the result needs a person: the
   * reasons say what they should look at.
   */
  readonly needsReview: boolean;
  readonly reviewReasons: readonly string[];
  readonly alignment: SyncAlignmentReport | null;
  /**
   * The single transform that best describes the result, for a summary line:
   * the largest corrected region's, or the identity. Not what was applied
   * when regions differ — `alignment` is.
   */
  readonly rate: number;
  readonly offsetSeconds: number;
  readonly confidence: number;
  readonly droppedCues: number;
  readonly clampedCues: number;
  readonly excludedCues: number;
}

export type SubtitleSyncResult =
  | SubtitleSyncSuccess
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

export interface SubtitleRevisionListing {
  readonly relativePath: string;
  readonly fileName: string;
  readonly revisions: readonly SubtitleRevision[];
}

export interface SubtitleSyncService {
  tracks(mediaFileId: string): Promise<SyncTracks>;
  sync(request: SubtitleSyncRequest): Promise<SubtitleSyncResult>;
  /** Every revision of one sidecar, newest first. */
  revisions(
    mediaFileId: string,
    targetStreamIndex: number,
  ): Promise<SubtitleRevisionListing | null>;
  /** Puts an earlier revision back, as a new revision. */
  restore(request: {
    mediaFileId: string;
    targetStreamIndex: number;
    revisionId: string;
  }): Promise<SubtitleSyncResult>;
  /**
   * What changed between two versions of one sidecar: by default a version
   * and the one it was made from.
   */
  compare(request: {
    mediaFileId: string;
    targetStreamIndex: number;
    revisionId: string;
    againstRevisionId?: string;
  }): Promise<RevisionComparison | null>;
  /** Settles every write a crash left pending. Returns how many it settled. */
  settlePending(): Promise<number>;
}

export interface RevisionComparison {
  readonly before: { id: string; revision: number; origin: string };
  readonly after: { id: string; revision: number; origin: string };
  readonly cueCount: { before: number; after: number };
  /** Lines in both whose timing differs. */
  readonly moved: readonly {
    text: string;
    beforeStartSeconds: number;
    beforeEndSeconds: number;
    afterStartSeconds: number;
    afterEndSeconds: number;
  }[];
  /** Lines only in the earlier version, and only in the later. */
  readonly removed: readonly { text: string; startSeconds: number }[];
  readonly added: readonly { text: string; startSeconds: number }[];
  /** True when the lists were cut short. */
  readonly truncated: boolean;
}

/** The most lines a comparison lists; the counts are always complete. */
const COMPARISON_LIMIT = 2_000;

/**
 * Pairs two versions' lines by their text, in order.
 *
 * A retiming never changes a line's words, so equal text in order is the same
 * line; a line excluded or restored shows up as one side's alone. A short
 * look-ahead keeps one missing line from unpairing everything after it.
 */
export function compareCues(
  before: readonly { text: string; startSeconds: number; endSeconds: number }[],
  after: readonly { text: string; startSeconds: number; endSeconds: number }[],
): Pick<RevisionComparison, "moved" | "removed" | "added" | "truncated"> {
  const moved: RevisionComparison["moved"][number][] = [];
  const removed: RevisionComparison["removed"][number][] = [];
  const added: RevisionComparison["added"][number][] = [];
  const lookAhead = 8;
  /** How many lines ahead `text` is, or Infinity beyond the look-ahead. */
  const distance = (
    lines: readonly { text: string }[],
    from: number,
    text: string,
  ) => {
    for (let step = 1; step <= lookAhead; step += 1)
      if (lines[from + step]?.text === text) return step;
    return Number.POSITIVE_INFINITY;
  };
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    const a = before[left];
    const b = after[right];
    if (a && b && a.text === b.text) {
      if (
        Math.abs(a.startSeconds - b.startSeconds) > 0.0005 ||
        Math.abs(a.endSeconds - b.endSeconds) > 0.0005
      )
        moved.push({
          text: a.text,
          beforeStartSeconds: a.startSeconds,
          beforeEndSeconds: a.endSeconds,
          afterStartSeconds: b.startSeconds,
          afterEndSeconds: b.endSeconds,
        });
      left += 1;
      right += 1;
      continue;
    }
    // Whichever side reaches the other's line sooner is the side with extra lines.
    const dropA = a && b ? distance(before, left, b.text) : 0;
    const dropB = a && b ? distance(after, right, a.text) : 0;
    if (a && (!b || (dropA <= dropB && Number.isFinite(dropA)))) {
      removed.push({ text: a.text, startSeconds: a.startSeconds });
      left += 1;
    } else if (b && (!a || Number.isFinite(dropB))) {
      added.push({ text: b.text, startSeconds: b.startSeconds });
      right += 1;
    } else if (a && b) {
      removed.push({ text: a.text, startSeconds: a.startSeconds });
      added.push({ text: b.text, startSeconds: b.startSeconds });
      left += 1;
      right += 1;
    }
  }
  const truncated =
    moved.length > COMPARISON_LIMIT ||
    removed.length > COMPARISON_LIMIT ||
    added.length > COMPARISON_LIMIT;
  return {
    moved: moved.slice(0, COMPARISON_LIMIT),
    removed: removed.slice(0, COMPARISON_LIMIT),
    added: added.slice(0, COMPARISON_LIMIT),
    truncated,
  };
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

const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

export function alignmentReport(
  alignment: PiecewiseAlignment,
  document: SubtitleDocument,
): SyncAlignmentReport {
  const timed = documentCues(document);
  return {
    verdict: alignment.verdict,
    autoApplicable: alignment.autoApplicable,
    coverage: ms(alignment.coverage),
    counts: alignment.counts,
    placedAtEdits: alignment.placedAtEdits,
    rate: alignment.rate,
    reference: alignment.reference,
    anchorCount: alignment.anchorCount,
    version: alignment.version,
    segments: alignment.segments.map((segment) => ({
      ...segment,
      sourceStartSeconds: ms(segment.sourceStartSeconds),
      sourceEndSeconds: ms(segment.sourceEndSeconds),
      offsetSeconds: ms(segment.offsetSeconds),
      confidence: ms(segment.confidence),
      medianErrorSeconds:
        segment.medianErrorSeconds === null
          ? null
          : ms(segment.medianErrorSeconds),
    })),
    breakpoints: alignment.breakpoints.map((breakpoint) => ({
      ...breakpoint,
      afterSourceSeconds: ms(breakpoint.afterSourceSeconds),
      beforeSourceSeconds: ms(breakpoint.beforeSourceSeconds),
      seconds: ms(breakpoint.seconds),
    })),
    cues: alignment.cues.map((cue) => ({
      index: cue.index,
      disposition: cue.disposition,
      sourceStartSeconds: ms(cue.sourceStartSeconds),
      sourceEndSeconds: ms(cue.sourceEndSeconds),
      startSeconds: ms(cue.startSeconds),
      endSeconds: ms(cue.endSeconds),
      text: (timed[cue.index]?.text ?? []).join("\n").slice(0, 200),
    })),
  };
}

/** Why a result was not written on its own, in words an operator can act on. */
export function reviewReasons(
  alignment: PiecewiseAlignment,
  excluded: number,
  beforeMedia: number,
): string[] {
  const reasons: string[] = [];
  const { counts } = alignment;
  if (alignment.verdict === "insufficient-evidence")
    reasons.push("Too little of the subtitle agrees with the reference.");
  if (alignment.verdict === "reordered")
    reasons.push("The proposed regions would put lines out of order.");
  if (counts.unresolved > 0)
    reasons.push(
      `${counts.unresolved} lines could not be placed and would stay where they are.`,
    );
  if (counts.unmatched > 0)
    reasons.push(
      `${counts.unmatched} lines seem to belong to footage this version does not have.`,
    );
  if (alignment.placedAtEdits > 0)
    reasons.push(
      `${alignment.placedAtEdits} lines beside an edit were placed without direct evidence.`,
    );
  if (beforeMedia > 0)
    reasons.push(`${beforeMedia} lines would fall before the video starts.`);
  if (excluded > 0)
    reasons.push(`${excluded} lines would be left out of the active subtitle.`);
  if (
    reasons.length === 0 &&
    alignment.verdict === "correctable" &&
    !alignment.autoApplicable
  )
    reasons.push(
      "Some corrected regions rest on weaker evidence than an automatic change needs.",
    );
  return reasons;
}

/** The largest corrected region's transform, for a one-line summary. */
function dominant(alignment: PiecewiseAlignment | null): {
  rate: number;
  offsetSeconds: number;
  confidence: number;
} {
  const corrected = (alignment?.segments ?? [])
    .filter((segment) => segment.status === "corrected")
    .sort((left, right) => right.cueCount - left.cueCount)[0];
  if (corrected)
    return {
      rate: corrected.rate,
      offsetSeconds: ms(corrected.offsetSeconds),
      confidence: ms(corrected.confidence),
    };
  const aligned = (alignment?.segments ?? []).find(
    (segment) => segment.status === "aligned",
  );
  return {
    rate: 1,
    offsetSeconds: 0,
    confidence: ms(aligned?.confidence ?? 0),
  };
}

export function createSubtitleSyncService(dependencies: {
  libraryRoot: string;
  ffmpegPath: string;
  catalogue: SubtitleSyncCatalogue;
  repository: Pick<
    SubtitleRepository,
    "mediaFileRelativePath" | "recordRetiming"
  >;
  revisions: SubtitleRevisionStore;
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

  interface Target {
    readonly relativeMedia: string;
    readonly streams: MediaStreamRow[];
    readonly target: MediaStreamRow & { externalRelativePath: string };
    readonly storage: SubtitleStorage;
    readonly relativePath: string;
    readonly fileName: string;
  }

  /** The sidecar a request names, or why it cannot be corrected. */
  async function resolveTarget(
    mediaFileId: string,
    targetStreamIndex: number,
  ): Promise<Target | SubtitleSyncResult> {
    const file = await catalogue.getFileById(mediaFileId);
    if (!file || file.missingSince !== null)
      return refuse("media-missing", "This title has no file on disk.");
    const relativeMedia = await repository.mediaFileRelativePath(mediaFileId);
    if (relativeMedia === null)
      return refuse(
        "media-missing",
        "The catalogue has no path for this file.",
      );
    const streams = await catalogue.listStreams(mediaFileId);
    const target = streams.find(
      (stream) =>
        stream.streamIndex === targetStreamIndex && isReadableSubtitle(stream),
    );
    if (!target)
      return refuse("target-missing", "That subtitle track is not here.");
    if (!target.isExternal || !target.externalRelativePath)
      return refuse(
        "target-embedded",
        "Only a subtitle file beside the video can be re-timed. This one is inside the video.",
      );
    const relativePath = target.externalRelativePath;
    return {
      relativeMedia,
      streams,
      target: target as Target["target"],
      storage: dependencies.storageFactory(relativeMedia, mediaFileId),
      relativePath,
      fileName: relativePath.split("/").pop() ?? relativePath,
    };
  }

  async function readTarget(
    resolved: Target,
    mediaFileId: string,
  ): Promise<{ bytes: Uint8Array } | SubtitleSyncResult> {
    try {
      return {
        bytes: await resolved.storage.read(mediaFileId, resolved.relativePath),
      };
    } catch (error) {
      return refuse(
        "target-unreadable",
        error instanceof Error && error.name === "StorageFailure"
          ? error.message
          : "That subtitle file could not be read.",
      );
    }
  }

  /*
   * Decoded the way the uploader decodes: a hand-placed Turkish sidecar is very
   * often Windows-1254, and refusing it would make the feature useless for the
   * library it is for. A rewrite therefore lands as UTF-8, which is a change
   * beyond the timings — and the right one, since everything downstream, the
   * validator included, requires it.
   */
  const decode = (bytes: Uint8Array, language: string | null) =>
    parseSubtitleDocument(
      new TextDecoder("utf-8").decode(toUtf8(bytes, language ?? "und")),
    );

  /** Writes new bytes through the revision history, then tells everyone. */
  async function commit(input: {
    mediaFileId: string;
    resolved: Target;
    read: Uint8Array;
    next: Uint8Array;
    origin: RevisionOrigin;
    provenance: Record<string, unknown>;
    syncState: "assumed-in-sync" | "unknown";
  }): Promise<
    | { ok: true; revisionId: string | null; changed: boolean }
    | { ok: false; refusal: SubtitleSyncResult }
  > {
    const written = await writeSubtitleRevision({
      store: dependencies.revisions,
      storage: input.resolved.storage,
      mediaFileId: input.mediaFileId,
      relativePath: input.resolved.relativePath,
      read: input.read,
      next: input.next,
      origin: input.origin,
      provenance: input.provenance,
    });
    if (written.outcome === "refused")
      return { ok: false, refusal: refuse(written.failure, written.reason) };
    if (written.outcome === "unchanged")
      return { ok: true, revisionId: written.revision.id, changed: false };

    /*
     * The receipt is updated, never replaced. A retimed subtitle is the same
     * installation with different bytes — it answers the same want, came from
     * the same provider, and is in the same language — so the digest and the
     * sync state move and the provenance stays where it is.
     */
    const { resolved } = input;
    await repository.recordRetiming({
      mediaFileId: input.mediaFileId,
      relativePath: resolved.relativePath,
      language: resolved.target.language ?? "und",
      forced: resolved.target.isForced,
      format: resolved.fileName.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
      sha256: written.sha256,
      sizeBytes: input.next.length,
      cueCount: written.cueCount,
      syncState: input.syncState,
    });
    await dependencies
      .onFilesChanged?.(resolved.relativePath)
      .catch(() => undefined);
    // Observational, and after the commit: a player that will not refresh
    // does not un-write a correct subtitle.
    await dependencies.playback
      ?.request({ mediaFileId: input.mediaFileId, kind: "subtitles" })
      .catch(() => undefined);
    return { ok: true, revisionId: written.revision.id, changed: true };
  }

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
      const resolved = await resolveTarget(
        request.mediaFileId,
        request.targetStreamIndex,
      );
      if ("outcome" in resolved) return resolved;
      if (
        request.reference.kind === "subtitle" &&
        request.reference.streamIndex === resolved.target.streamIndex
      )
        return refuse(
          "reference-invalid",
          "A subtitle cannot be timed against itself.",
        );

      const read = await readTarget(resolved, request.mediaFileId);
      if ("outcome" in read) return read;
      const originalBytes = read.bytes;
      const subtitleSha256 = subtitleDigest(originalBytes);
      const document = decode(originalBytes, resolved.target.language);
      const timed = documentCues(document);
      if (timed.length === 0)
        return refuse("target-empty", "That subtitle file holds no cues.");

      const base = {
        relativePath: resolved.relativePath,
        fileName: resolved.fileName,
        cueCount: timed.length,
        subtitleSha256,
      };
      const serialise = (blocks: SubtitleDocument["blocks"]) =>
        new TextEncoder().encode(
          serialiseSubtitleDocument({ ...document, blocks }),
        );

      // ── A correction typed by hand: applied as given, and recorded as such.
      if (request.transform) {
        const retimed = retimeBlocks(document.blocks, request.transform);
        const summary = {
          ...base,
          referenceKind: "manual" as const,
          referenceLabel: "a correction given by hand",
          alignment: null,
          rate: request.transform.rate,
          offsetSeconds: request.transform.offsetSeconds,
          // An operator's own figure is not a measurement and is not scored.
          confidence: 1,
          droppedCues: retimed.dropped,
          clampedCues: retimed.clamped,
          excludedCues: 0,
          needsReview: false,
          reviewReasons: [],
        };
        if (request.dryRun)
          return { ...summary, outcome: "analysed", revisionId: null };
        const committed = await commit({
          mediaFileId: request.mediaFileId,
          resolved,
          read: originalBytes,
          next: serialise(retimed.blocks),
          origin: "manual",
          provenance: { transform: request.transform },
          syncState: "assumed-in-sync",
        });
        if (!committed.ok) return committed.refusal;
        return {
          ...summary,
          outcome: committed.changed ? "applied" : "unchanged",
          revisionId: committed.revisionId,
        };
      }

      // ── A reviewed proposal: exactly what was looked at, to exactly those bytes.
      if (request.reviewed) {
        const reviewed = request.reviewed;
        if (reviewed.subtitleSha256 !== subtitleSha256)
          return refuse(
            "changed-since-analysis",
            "The subtitle changed after it was analysed. Analyse it again before applying.",
          );
        let placement;
        try {
          placement = applyPlacements(document, reviewed.placements, {
            unmatched: reviewed.unmatched,
          });
        } catch (error) {
          return refuse(
            "proposal-invalid",
            error instanceof Error
              ? error.message
              : "The proposal is not valid.",
          );
        }
        const placedEverything = reviewed.placements.every(
          (cue) =>
            cue.disposition !== "unresolved" && cue.disposition !== "unmatched",
        );
        const committed = await commit({
          mediaFileId: request.mediaFileId,
          resolved,
          read: originalBytes,
          next: serialise(placement.blocks),
          origin: "sync",
          provenance: {
            previewTaskId: reviewed.previewTaskId,
            verdict: reviewed.verdict,
            unmatched: reviewed.unmatched,
            reviewed: true,
            moved: placement.moved,
            excluded: placement.excluded,
            beforeMedia: placement.beforeMedia,
            trimmed: placement.trimmed,
          },
          syncState: placedEverything ? "assumed-in-sync" : "unknown",
        });
        if (!committed.ok) return committed.refusal;
        return {
          ...base,
          outcome: committed.changed ? "applied" : "unchanged",
          referenceKind: request.reference.kind,
          referenceLabel: "the reviewed proposal",
          revisionId: committed.revisionId,
          needsReview: false,
          reviewReasons: [],
          alignment: null,
          rate: 1,
          offsetSeconds: 0,
          confidence: 0,
          droppedCues: placement.beforeMedia.length,
          clampedCues: placement.clamped,
          excludedCues: placement.excluded.length,
        };
      }

      // ── Analysis.
      const readings = await readReferences(request, resolved);
      if ("outcome" in readings) return readings;
      const cues = alignmentCues(document);
      await request.progress?.("Matching the subtitle against the reference");
      const anchors =
        request.transcript?.anchorsFor && request.reference.kind === "audio"
          ? await request.transcript.anchorsFor(
              timed.map((cue, index) => ({
                index,
                text: cue.text.join(" "),
                startSeconds: cue.startSeconds,
              })),
            )
          : [];
      /*
       * Where a stretch of speech starts depends on the threshold, and the
       * right threshold is a property of the film's mix; reading the audio is
       * what costs, so every reading is tried and the one that places the most
       * of the subtitle on strong evidence is believed.
       */
      let alignment: PiecewiseAlignment | null = null;
      for (const reading of readings.references) {
        const candidate = alignPiecewise(
          cues,
          reading,
          anchors.length > 0 ? { anchors } : {},
        );
        if (
          alignment === null ||
          alignmentStrength(candidate) > alignmentStrength(alignment)
        )
          alignment = candidate;
      }
      if (alignment === null)
        return refuse("reference-empty", "There is nothing to time against.");

      const placement = applyPlacements(document, alignment.cues, {
        unmatched: "keep",
      });
      const report = alignmentReport(alignment, document);
      const reasons = reviewReasons(
        alignment,
        placement.excluded.length,
        placement.beforeMedia.length,
      );
      const result = {
        ...base,
        referenceKind: request.reference.kind,
        referenceLabel: readings.label,
        alignment: report,
        ...dominant(alignment),
        droppedCues: placement.beforeMedia.length,
        clampedCues: placement.clamped,
        excludedCues: 0,
      };

      if (alignment.verdict === "insufficient-evidence")
        return refuse(
          "unconvincing",
          "This subtitle and that reference do not look like the same film; nothing was changed.",
        );
      if (alignment.verdict === "in-sync")
        return {
          ...result,
          outcome: "unchanged",
          revisionId: null,
          needsReview: false,
          reviewReasons: [],
        };
      const unattended = canApplyUnreviewed(alignment, placement);
      if (request.dryRun || !unattended)
        return {
          ...result,
          outcome: "analysed",
          revisionId: null,
          needsReview: !unattended,
          reviewReasons: unattended ? [] : reasons,
        };

      const committed = await commit({
        mediaFileId: request.mediaFileId,
        resolved,
        read: originalBytes,
        next: serialise(placement.blocks),
        origin: "sync",
        provenance: {
          reference: request.reference,
          referenceLabel: readings.label,
          aligner: alignment.version,
          verdict: alignment.verdict,
          coverage: report.coverage,
          segments: report.segments,
          breakpoints: report.breakpoints,
          anchors: alignment.anchorCount,
          ...(request.transcript
            ? { transcript: request.transcript.describe }
            : {}),
          reviewed: false,
        },
        syncState: "assumed-in-sync",
      });
      if (!committed.ok) return committed.refusal;
      return {
        ...result,
        outcome: committed.changed ? "applied" : "unchanged",
        revisionId: committed.revisionId,
        needsReview: false,
        reviewReasons: [],
      };
    },

    async revisions(mediaFileId, targetStreamIndex) {
      const resolved = await resolveTarget(mediaFileId, targetStreamIndex);
      if ("outcome" in resolved) return null;
      // Settled first, so a listing never shows a write as still in flight
      // when the file already says how it ended.
      await settlePendingRevision(
        dependencies.revisions,
        resolved.storage,
        mediaFileId,
        resolved.relativePath,
      ).catch(() => undefined);
      return {
        relativePath: resolved.relativePath,
        fileName: resolved.fileName,
        revisions: await dependencies.revisions.list(
          mediaFileId,
          resolved.relativePath,
        ),
      };
    },

    async restore(request) {
      const resolved = await resolveTarget(
        request.mediaFileId,
        request.targetStreamIndex,
      );
      if ("outcome" in resolved) return resolved;
      const revision = await dependencies.revisions.get(request.revisionId);
      if (
        !revision ||
        revision.mediaFileId !== request.mediaFileId ||
        revision.relativePath !== resolved.relativePath
      )
        return refuse(
          "revision-missing",
          "That version does not belong to this subtitle.",
        );
      if (revision.state !== "committed")
        return refuse(
          "revision-unsettled",
          "That version was never saved, so it cannot be put back.",
        );
      const read = await readTarget(resolved, request.mediaFileId);
      if ("outcome" in read) return read;
      const current = read.bytes;
      const committed = await commit({
        mediaFileId: request.mediaFileId,
        resolved,
        read: current,
        next: revision.content,
        origin: "restore",
        provenance: {
          restoredFrom: revision.id,
          restoredRevision: revision.revision,
        },
        syncState: "unknown",
      });
      if (!committed.ok) return committed.refusal;
      return {
        outcome: committed.changed ? "restored" : "unchanged",
        relativePath: resolved.relativePath,
        fileName: resolved.fileName,
        referenceKind: "revision",
        referenceLabel: `version ${revision.revision}`,
        cueCount: documentCues(
          decode(revision.content, resolved.target.language),
        ).length,
        subtitleSha256: subtitleDigest(current),
        revisionId: committed.revisionId,
        needsReview: false,
        reviewReasons: [],
        alignment: null,
        rate: 1,
        offsetSeconds: 0,
        confidence: 0,
        droppedCues: 0,
        clampedCues: 0,
        excludedCues: 0,
      };
    },

    async compare(request) {
      const resolved = await resolveTarget(
        request.mediaFileId,
        request.targetStreamIndex,
      );
      if ("outcome" in resolved) return null;
      const after = await dependencies.revisions.get(request.revisionId);
      const againstId = request.againstRevisionId ?? after?.parentId ?? null;
      const before = againstId
        ? await dependencies.revisions.get(againstId)
        : null;
      const belongs = (revision: typeof after) =>
        revision !== null &&
        revision.mediaFileId === request.mediaFileId &&
        revision.relativePath === resolved.relativePath;
      if (!after || !before || !belongs(after) || !belongs(before)) return null;
      const lines = (content: Uint8Array) =>
        documentCues(decode(content, resolved.target.language)).map((cue) => ({
          text: cue.text.join("\n"),
          startSeconds: cue.startSeconds,
          endSeconds: cue.endSeconds,
        }));
      const earlier = lines(before.content);
      const later = lines(after.content);
      const summary = (revision: NonNullable<typeof after>) => ({
        id: revision.id,
        revision: revision.revision,
        origin: revision.origin,
      });
      return {
        before: summary(before),
        after: summary(after),
        cueCount: { before: earlier.length, after: later.length },
        ...compareCues(earlier, later),
      };
    },

    async settlePending() {
      let settled = 0;
      for (const {
        mediaFileId,
        relativePath,
      } of await dependencies.revisions.pendingPaths()) {
        const relativeMedia = await repository
          .mediaFileRelativePath(mediaFileId)
          .catch(() => null);
        if (relativeMedia === null) continue;
        const outcome = await settlePendingRevision(
          dependencies.revisions,
          dependencies.storageFactory(relativeMedia, mediaFileId),
          mediaFileId,
          relativePath,
        ).catch(() => "unreadable" as const);
        if (outcome === "committed" || outcome === "abandoned") settled += 1;
      }
      return settled;
    },
  };

  /** Every reading of the reference the request named, or why there is none. */
  async function readReferences(
    request: SubtitleSyncRequest,
    resolved: Target,
  ): Promise<
    { references: AlignmentReference[]; label: string } | SubtitleSyncResult
  > {
    const { streams, storage, relativeMedia } = resolved;
    if (request.reference.kind === "subtitle") {
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
      let intervals: SpeechInterval[] | null;
      try {
        intervals = await readReferenceSubtitle(
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
      if (intervals === null)
        return refuse(
          "source-removed",
          "That subtitle was inside the removed source video and its package holds no copy of it.",
        );
      if (intervals.length === 0)
        return refuse(
          "reference-empty",
          "That reference subtitle holds no cues.",
        );
      return {
        references: [{ kind: "subtitle", intervals }],
        label: `the ${trackLabel(reference)} subtitle`,
      };
    }

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
    const references: AlignmentReference[] = SPEECH_DUTY_CYCLES.map(
      (dutyCycle) => ({
        kind: "speech" as const,
        intervals: speechIntervalsFromEnvelope(envelope, { dutyCycle }),
      }),
    ).filter((reading) => reading.intervals.length > 0);
    if (request.transcript && request.transcript.intervals.length > 0)
      references.push({
        kind: "transcript",
        intervals: request.transcript.intervals,
      });
    if (references.length === 0)
      return refuse(
        "reference-empty",
        "No speech could be found in that audio track.",
      );
    return { references, label: `the ${trackLabel(reference)} audio` };
  }

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
