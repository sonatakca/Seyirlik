import {
  alignmentStrength,
  alignPiecewise,
  type AlignmentReference,
  type PiecewiseAlignment,
} from "./piecewiseAlignment";
import {
  readAudioEnvelope,
  SPEECH_DUTY_CYCLES,
  speechIntervalsFromEnvelope,
} from "./audioSpeech";
import {
  cueIntervals,
  documentCues,
  parseSubtitleDocument,
  serialiseSubtitleDocument,
} from "./subtitleCues";
import {
  alignmentCues,
  applyPlacements,
  canApplyUnreviewed,
} from "./subtitleTimeMap";

/**
 * How well a downloaded subtitle fits the title it is for, measured against
 * the title's own audio and, where the video carried one, its own subtitles.
 *
 * A provider's metadata says which release a subtitle was timed for, and is
 * often wrong or silent: one season's packs on TürkçeAltyazı carry the same
 * translation timed four ways, and the metadata cannot tell which matches this
 * file. The title can. Measured on The Sopranos S01, the UNIT3D pack's E06 ran a
 * second late by the end while the CtrlHD pack's, the same text, landed on the
 * speech throughout; nothing a provider said would have chosen between them.
 *
 * Each candidate is aligned region by region (`alignPiecewise`), because a
 * subtitle for another cut of the episode is right in some places and not in
 * others, and the one transform the fit used to measure scored such a file as
 * a confident fit and wrote the late half's shift over the right half.
 *
 * Every reference comes from the package once there is one (see
 * `TitleReferences`), so this works the same after the source is removed.
 */

/** Where the title's speech is read from: an FFmpeg input and its audio stream. */
export interface AudioReference {
  readonly path: string;
  readonly streamIndex: number;
  /** `path` is a package's HLS playlist; see `readAudioEnvelope`. */
  readonly isPackagePlaylist?: boolean;
}

export interface SubtitleFit {
  /** The alignment from the reference reading that explains the most of it. */
  readonly alignment: PiecewiseAlignment;
  /**
   * True when the candidate may be installed as the measurement leaves it:
   * already in sync, or correctable everywhere on strong evidence.
   */
  readonly trusted: boolean;
  /** The largest corrected region's transform, else the identity. */
  readonly rate: number;
  readonly offsetSeconds: number;
  readonly confidence: number;
}

export interface SubtitleFitter {
  /** Null when the bytes hold no cues; throws when no reference can be read. */
  measure(bytes: Uint8Array): Promise<SubtitleFit | null>;
}

/**
 * How good a fit is, as a rank: in sync beats correctable without review,
 * which beats needing review, which beats not matching at all. A subtitle that
 * already fits most of this edition is worth more than one that needs many
 * corrections, however confident each correction is.
 */
export function fitClass(fit: SubtitleFit): 0 | 1 | 2 | 3 {
  const { verdict } = fit.alignment;
  if (verdict === "in-sync") return 3;
  if (fit.trusted) return 2;
  if (verdict === "insufficient-evidence" || verdict === "reordered") return 0;
  return 1;
}

/** How much a fit would move, in cue-seconds: less is better between equals. */
export function fitCorrection(fit: SubtitleFit): number {
  return fit.alignment.cues.reduce(
    (sum, cue) =>
      cue.disposition === "corrected" || cue.disposition === "inferred"
        ? sum + Math.abs(cue.startSeconds - cue.sourceStartSeconds)
        : sum,
    0,
  );
}

type Intervals = ReturnType<typeof cueIntervals>;

export function createSubtitleFitter(options: {
  ffmpegPath: string;
  audio: AudioReference | null;
  /**
   * Subtitles that were inside the video, as text. Each is a reading of its
   * own, and a subtitle's onsets are a far sharper reference than an audio
   * track's speech; the reading that places most of the candidate wins.
   */
  subtitles?: readonly string[];
  signal?: AbortSignal;
}): SubtitleFitter {
  /*
   * Reading the audio is what costs (about twenty seconds for an episode over
   * the Drive mount); every candidate after the first is arithmetic. So the
   * references are read once, on first use, and an audio that cannot be read
   * is remembered rather than retried per candidate.
   */
  let references: Promise<AlignmentReference[]> | null = null;
  const readings = () =>
    (references ??= (async () => {
      const sets: AlignmentReference[] = (options.subtitles ?? [])
        .map(
          (text): Intervals =>
            cueIntervals(documentCues(parseSubtitleDocument(text))),
        )
        .filter((intervals) => intervals.length > 0)
        .map((intervals) => ({ kind: "subtitle" as const, intervals }));
      let audioError: unknown = null;
      if (options.audio) {
        try {
          const envelope = await readAudioEnvelope({
            ffmpegPath: options.ffmpegPath,
            inputPath: options.audio.path,
            streamIndex: options.audio.streamIndex,
            ...(options.audio.isPackagePlaylist
              ? { isPackagePlaylist: true }
              : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          for (const dutyCycle of SPEECH_DUTY_CYCLES) {
            const intervals = speechIntervalsFromEnvelope(envelope, {
              dutyCycle,
            });
            if (intervals.length > 0) sets.push({ kind: "speech", intervals });
          }
        } catch (error) {
          audioError = error;
        }
      }
      if (sets.length === 0)
        throw audioError ?? new Error("Nothing to align against.");
      return sets;
    })());

  return {
    async measure(bytes) {
      const document = parseSubtitleDocument(
        new TextDecoder("utf-8").decode(bytes),
      );
      const cues = alignmentCues(document);
      if (cues.length === 0) return null;
      let best: PiecewiseAlignment | null = null;
      for (const reference of await readings()) {
        const alignment = alignPiecewise(cues, reference);
        if (
          best === null ||
          alignmentStrength(alignment) > alignmentStrength(best)
        )
          best = alignment;
      }
      if (best === null) return null;
      const placement = applyPlacements(document, best.cues, {
        unmatched: "keep",
      });
      const corrected = best.segments
        .filter((segment) => segment.status === "corrected")
        .sort((left, right) => right.cueCount - left.cueCount)[0];
      return {
        alignment: best,
        trusted:
          best.verdict === "in-sync" || canApplyUnreviewed(best, placement),
        rate: corrected?.rate ?? 1,
        offsetSeconds: corrected?.offsetSeconds ?? 0,
        confidence:
          corrected?.confidence ??
          best.segments.find((segment) => segment.status === "aligned")
            ?.confidence ??
          0,
      };
    },
  };
}

/** Whether a trusted fit moves any cue, and so is worth rewriting. */
export function fitNeedsRetiming(fit: SubtitleFit): boolean {
  return fit.trusted && fit.alignment.verdict === "correctable";
}

/** The subtitle with its cues moved onto the title's timeline. UTF-8 in, UTF-8 out. */
export function retimeToFit(bytes: Uint8Array, fit: SubtitleFit): Uint8Array {
  const document = parseSubtitleDocument(
    new TextDecoder("utf-8").decode(bytes),
  );
  const placed = applyPlacements(document, fit.alignment.cues, {
    unmatched: "keep",
  });
  return new TextEncoder().encode(
    serialiseSubtitleDocument({ ...document, blocks: placed.blocks }),
  );
}
