import { alignSpeech, type AlignmentProposal } from "./subtitleAlignment";
import {
  readAudioEnvelope,
  SPEECH_DUTY_CYCLES,
  speechIntervalsFromEnvelope,
} from "./audioSpeech";
import {
  cueIntervals,
  documentCues,
  parseSubtitleDocument,
  retimeBlocks,
  serialiseSubtitleDocument,
} from "./subtitleCues";
import { MINIMUM_SYNC_CONFIDENCE } from "./subtitleSync";

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
 * Every reference comes from the package once there is one (see
 * `TitleReferences`), so this works the same after the source is removed.
 */

/** Where the title's speech is read from: an FFmpeg input and its audio stream. */
export interface AudioReference {
  readonly path: string;
  readonly streamIndex: number;
}

export interface SubtitleFit {
  /** The most confident proposal over every reference and speech threshold. */
  readonly proposal: AlignmentProposal;
  /** True when the proposal is confident enough to act on. */
  readonly trusted: boolean;
}

export interface SubtitleFitter {
  /** Null when the bytes hold no cues; throws when no reference can be read. */
  measure(bytes: Uint8Array): Promise<SubtitleFit | null>;
}

/**
 * Below this a correction is not worth making. An audio onset is itself only
 * placed to the envelope's quarter-second window, so moving a subtitle by less
 * would be correcting the measurement, not the subtitle.
 */
const NEGLIGIBLE_OFFSET_SECONDS = 0.15;
/** A rate this close to one drifts less than the offset floor over three hours. */
const NEGLIGIBLE_RATE_ERROR = 0.00001;

type Intervals = ReturnType<typeof cueIntervals>;

export function createSubtitleFitter(options: {
  ffmpegPath: string;
  audio: AudioReference | null;
  /**
   * Subtitles that were inside the video, as text. `confidence` is measured
   * against chance on the pair in hand, so it compares across a subtitle and
   * an audio reference, and the better of the two is taken.
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
  let references: Promise<Intervals[]> | null = null;
  const referenceSets = () =>
    (references ??= (async () => {
      const sets: Intervals[] = (options.subtitles ?? [])
        .map((text) => cueIntervals(documentCues(parseSubtitleDocument(text))))
        .filter((intervals) => intervals.length > 0);
      let audioError: unknown = null;
      if (options.audio) {
        try {
          const envelope = await readAudioEnvelope({
            ffmpegPath: options.ffmpegPath,
            inputPath: options.audio.path,
            streamIndex: options.audio.streamIndex,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          for (const dutyCycle of SPEECH_DUTY_CYCLES) {
            const speech = speechIntervalsFromEnvelope(envelope, { dutyCycle });
            if (speech.length > 0) sets.push(speech);
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
      const cues = documentCues(
        parseSubtitleDocument(new TextDecoder("utf-8").decode(bytes)),
      );
      const target = cueIntervals(cues);
      if (target.length === 0) return null;
      let best: AlignmentProposal | null = null;
      for (const intervals of await referenceSets()) {
        const proposal = alignSpeech(target, intervals);
        if (best === null || proposal.confidence > best.confidence)
          best = proposal;
      }
      if (best === null) return null;
      return {
        proposal: best,
        trusted: best.confidence >= MINIMUM_SYNC_CONFIDENCE,
      };
    },
  };
}

/** Whether a trusted fit moves the cues by enough to be worth rewriting them. */
export function fitNeedsRetiming(fit: SubtitleFit): boolean {
  if (!fit.trusted) return false;
  const { rate, offsetSeconds } = fit.proposal;
  return (
    Math.abs(rate - 1) > NEGLIGIBLE_RATE_ERROR ||
    Math.abs(offsetSeconds) > NEGLIGIBLE_OFFSET_SECONDS
  );
}

/** The subtitle with its cues moved onto the title's timeline. UTF-8 in, UTF-8 out. */
export function retimeToFit(bytes: Uint8Array, fit: SubtitleFit): Uint8Array {
  const document = parseSubtitleDocument(
    new TextDecoder("utf-8").decode(bytes),
  );
  const retimed = retimeBlocks(document.blocks, fit.proposal);
  return new TextEncoder().encode(
    serialiseSubtitleDocument({ ...document, blocks: retimed.blocks }),
  );
}
