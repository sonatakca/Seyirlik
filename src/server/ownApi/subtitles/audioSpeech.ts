/**
 * Where somebody is speaking in an audio track.
 *
 * The aligner needs one thing from audio: the same list of speaking intervals a
 * subtitle gives it for free. Producing that properly is a speech-detection
 * problem, and the tempting answer — bundle a voice-activity model — buys a
 * dependency, a model file and a second runtime for a job that a band-limited
 * energy envelope does well enough, because the aligner does not need to know
 * *whether* a sound is speech. It needs a signal whose loud stretches begin when
 * the dialogue begins, a thousand times over two hours, and film audio obliges.
 *
 * Two decisions do most of the work:
 *
 *  - **The band.** Measuring full-range energy makes a score's bass and an
 *    explosion look exactly like a line of dialogue, and a film with a
 *    continuous score reduces to one enormous "speaking" interval with no
 *    onsets in it at all. Everything outside roughly 250–3000 Hz is discarded
 *    first, which is where speech lives and where most of a score does not.
 *  - **The threshold.** There is no absolute loudness that means "talking": a
 *    quiet chamber piece and an action film differ by twenty decibels. So the
 *    threshold is chosen by *duty cycle* instead — the caller names the fraction
 *    of the runtime that should count as speech, and the loudest that much of
 *    the film is what does. Which fraction is right is a property of the mix
 *    rather than of any constant, so the envelope is returned separately from
 *    the intervals and a caller can try several thresholds against one reading
 *    of the audio.
 *
 * FFmpeg produces the envelope in one pass, on a fixed grid, as plain text on
 * stdout. Nothing decodes audio in this process.
 */

import { writeLocalPackagePlaylist } from "../../../renditions/adaptive/localPlaylist";
import { runBoundedProcess } from "../../../renditions/processExecution";
import type { SpeechInterval } from "./subtitleAlignment";

/**
 * How long one measurement covers.
 *
 * A quarter second is four measurements per syllable-group and about 26,000
 * lines per hour of film, which is small enough to pass through a pipe as text
 * and fine enough that an onset is never more than an eighth of a second from
 * where it really is — well inside the tolerance the fit works at.
 */
export const ENVELOPE_WINDOW_SECONDS = 0.25;

/** 8 kHz mono: twice the top of the band that is kept, and nothing wasted. */
const ENVELOPE_SAMPLE_RATE = 8000;

/**
 * Gaps shorter than this are inside one stretch of speech, not between two.
 *
 * Set from what the fit consumes rather than from phonetics: its feature is the
 * *start* of a stretch, so splitting one sentence at every breath would invent
 * onsets that no subtitle has and dilute every real one.
 */
const MERGE_GAP_SECONDS = 0.7;

/** Shorter than this is a door closing, not a line. */
const MINIMUM_SPEECH_SECONDS = 0.4;

/**
 * What fraction of a film counts as speech.
 *
 * Measured rather than assumed. Against a film whose subtitle is known to be
 * correctly timed, a threshold admitting a quarter to a third of the runtime
 * recovers that subtitle's position to within a fifth of a second; at forty
 * percent the ambience it lets in drowns the onsets and the alignment fails
 * outright. A caller that can afford it should try several and keep the most
 * confident — `SPEECH_DUTY_CYCLES` is that set — because the right value is a
 * property of the film's mix rather than of this constant.
 */
const DEFAULT_DUTY_CYCLE = 0.28;
const MINIMUM_DUTY_CYCLE = 0.12;
const MAXIMUM_DUTY_CYCLE = 0.5;

/** Thresholds worth trying when one pass over the audio can serve several. */
export const SPEECH_DUTY_CYCLES: readonly number[] = [0.22, 0.28, 0.35];

export function buildAudioEnvelopeArgs(
  inputPath: string,
  streamIndex: number,
  windowSeconds = ENVELOPE_WINDOW_SECONDS,
): string[] {
  const samplesPerWindow = Math.round(ENVELOPE_SAMPLE_RATE * windowSeconds);
  return [
    "-v",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-vn",
    "-sn",
    "-dn",
    "-af",
    [
      `aresample=${ENVELOPE_SAMPLE_RATE}`,
      "highpass=f=250",
      "lowpass=f=3000",
      `asetnsamples=n=${samplesPerWindow}:p=0`,
      "astats=metadata=1:reset=1",
      "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
    ].join(","),
    /*
     * The null muxer writes nothing, so naming stdout for it does not collide
     * with the metadata the filter prints there. `NUL` and `/dev/null` are each
     * wrong on the other platform; this is right on both.
     */
    "-f",
    "null",
    "-",
  ];
}

export interface EnvelopeSample {
  readonly timeSeconds: number;
  /** RMS in dBFS. `-Infinity` for a window of digital silence. */
  readonly decibels: number;
}

const FRAME_LINE = /^frame:\d+\s+pts:\S+\s+pts_time:(-?[\d.]+)/;
const RMS_LINE = /^lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-?inf|nan)$/i;

/**
 * Reads the filter's own report.
 *
 * Each measurement arrives as two lines — the frame's timestamp, then its
 * level — and the timestamp is taken from the file rather than counted, so a
 * track that does not begin at zero, or that FFmpeg had to resynchronise, still
 * lands on the media's timeline instead of on a timeline of this parser's
 * invention.
 */
export function parseAudioEnvelope(stdout: string): EnvelopeSample[] {
  const samples: EnvelopeSample[] = [];
  let pending: number | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const frame = FRAME_LINE.exec(line);
    if (frame) {
      pending = Number(frame[1]);
      continue;
    }
    const rms = RMS_LINE.exec(line);
    if (!rms || pending === null) continue;
    const value = (rms[1] as string).toLowerCase();
    samples.push({
      timeSeconds: pending,
      decibels:
        value === "-inf" || value === "nan"
          ? Number.NEGATIVE_INFINITY
          : Number(value),
    });
    pending = null;
  }
  return samples;
}

/**
 * The level above which a window counts as speech.
 *
 * The `dutyCycle`-th loudest window, so that exactly that fraction of the film
 * is called speech. Windows of true silence are excluded from the ranking
 * first: a film with twenty minutes of digital silence at the head would
 * otherwise push the threshold down into its own room tone.
 */
export function envelopeThreshold(
  samples: readonly EnvelopeSample[],
  dutyCycle: number,
): number {
  const audible = samples
    .map((sample) => sample.decibels)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left);
  if (audible.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(
    audible.length - 1,
    Math.max(0, Math.floor(audible.length * dutyCycle)),
  );
  return audible[index] as number;
}

/**
 * How much further down the ranking the *start* of a stretch is looked for.
 *
 * A single threshold finds an utterance only once it is already loud, so every
 * onset it reports arrives late by the syllable's own rise time — measured
 * against a subtitle known to be correctly timed, consistently about 280
 * milliseconds late, which lands as a systematic error of that size in every
 * offset derived from audio. A stretch is therefore *found* at the strict
 * threshold and then walked backwards while the level stays above a slacker
 * one, which is the ordinary hysteresis a gate uses and removes most of the
 * bias without admitting the quiet passages the strict threshold is there to
 * exclude.
 */
const ONSET_HYSTERESIS = 1.9;

/**
 * How far back the walk may go, in windows.
 *
 * A syllable reaches full level in well under half a second, so three quarters
 * of one is already generous. The bound is what stops the slacker threshold
 * being followed all the way back through a loud musical passage and reporting
 * an onset where the score began rather than where the line did.
 */
const MAX_ONSET_BACKTRACK_WINDOWS = 3;

export function speechIntervalsFromEnvelope(
  samples: readonly EnvelopeSample[],
  options: { dutyCycle?: number; windowSeconds?: number } = {},
): SpeechInterval[] {
  const windowSeconds = options.windowSeconds ?? ENVELOPE_WINDOW_SECONDS;
  const dutyCycle = Math.min(
    MAXIMUM_DUTY_CYCLE,
    Math.max(MINIMUM_DUTY_CYCLE, options.dutyCycle ?? DEFAULT_DUTY_CYCLE),
  );
  const threshold = envelopeThreshold(samples, dutyCycle);
  const openThreshold = envelopeThreshold(
    samples,
    Math.min(0.95, dutyCycle * ONSET_HYSTERESIS),
  );

  const runs: { startSeconds: number; endSeconds: number }[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] as EnvelopeSample;
    if (sample.decibels < threshold) continue;
    const previous = runs[runs.length - 1];
    if (
      previous &&
      sample.timeSeconds - previous.endSeconds <= MERGE_GAP_SECONDS
    ) {
      previous.endSeconds = sample.timeSeconds + windowSeconds;
      continue;
    }
    // Back to where the sound actually began, never past the stretch before it.
    let start = index;
    while (
      start > 0 &&
      index - start < MAX_ONSET_BACKTRACK_WINDOWS &&
      (samples[start - 1] as EnvelopeSample).decibels >= openThreshold &&
      (previous === undefined ||
        (samples[start - 1] as EnvelopeSample).timeSeconds >=
          previous.endSeconds)
    )
      start -= 1;
    runs.push({
      startSeconds: (samples[start] as EnvelopeSample).timeSeconds,
      endSeconds: sample.timeSeconds + windowSeconds,
    });
  }
  return runs.filter(
    (run) => run.endSeconds - run.startSeconds >= MINIMUM_SPEECH_SECONDS,
  );
}

/**
 * How long a whole track is allowed to take.
 *
 * Generous on purpose. The measured worst case is reading one audio stream out
 * of a twenty-gigabyte remux on an external drive, which is bound by the disk
 * rather than by the decoder and took most of six minutes; the same audio as a
 * packaged `.m4a` took twenty-nine seconds. This runs in a background job, so
 * the ceiling is here to catch a wedged process, not to pace the work.
 */
const ENVELOPE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * One pass over an audio track, as a loudness envelope.
 *
 * Returns the envelope rather than the intervals so that the one expensive
 * thing here — reading the audio — is paid for once however many thresholds the
 * caller wants to try. Turning the envelope into intervals is arithmetic.
 *
 * The FFmpeg path is the deployment's, not this module's guess: a host that
 * names its own build in configuration means it, and picking `ffmpeg` off the
 * PATH here would analyse with a different version from the one that encoded
 * the film.
 */
export async function readAudioEnvelope(options: {
  ffmpegPath: string;
  inputPath: string;
  streamIndex: number;
  /**
   * The input is a package's HLS playlist, which FFmpeg is handed a decoded
   * local copy of: a kept original track is named `english (original)`, and
   * the playlist's own `%20` sends FFmpeg looking for a file that does not
   * exist. See `localPackagePlaylist`.
   */
  isPackagePlaylist?: boolean;
  signal?: AbortSignal;
}): Promise<EnvelopeSample[]> {
  // A copy that cannot be made leaves the playlist itself, which still opens
  // for a name without a space.
  const localPlaylist = options.isPackagePlaylist
    ? await writeLocalPackagePlaylist(options.inputPath).catch(() => null)
    : null;
  try {
    const { stdout } = await runBoundedProcess({
      command: options.ffmpegPath,
      args: buildAudioEnvelopeArgs(
        localPlaylist?.path ?? options.inputPath,
        options.streamIndex,
      ),
      timeoutMs: ENVELOPE_TIMEOUT_MS,
      // Two lines per quarter-second: a six-hour file is still under thirty
      // megabytes, and anything past that is not a film.
      maxOutputBytes: 64 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      // Never the path: this string reaches an operator's screen.
      describe: "Audio speech analysis",
    });
    return parseAudioEnvelope(stdout);
  } finally {
    await localPlaylist?.remove();
  }
}

/** The speaking intervals of one audio track, at the default threshold. */
export async function readSpeechIntervals(options: {
  ffmpegPath: string;
  inputPath: string;
  streamIndex: number;
  dutyCycle?: number;
  signal?: AbortSignal;
}): Promise<SpeechInterval[]> {
  return speechIntervalsFromEnvelope(await readAudioEnvelope(options), {
    ...(options.dutyCycle === undefined
      ? {}
      : { dutyCycle: options.dutyCycle }),
  });
}
