/**
 * What was said in an audio track, and when — read for timing, never for text.
 *
 * The aligner's best evidence is a subtitle timed to the same edition, and
 * most titles have none in the subtitle's language. Their audio says the same
 * thing: an ASR pass turns it into words with times, and the words do two jobs
 * a loudness envelope cannot. Their timing is the timing of *speech* — not of
 * the score's swell or an explosion, which an energy gate cannot tell from a
 * shout — and their meaning can be matched to what a cue in another language
 * says (`subtitleSemantics.ts`), which pins that cue to a moment.
 *
 * None of this text is ever shown or written into a subtitle. A transcript is
 * evidence about when, and only that.
 *
 * The recogniser is whisper.cpp, run as a process: one binary and one model
 * file per machine, CUDA on the encoding laptop, Metal on a Mac, CPU anywhere,
 * no Python and no service. Measured on nine packaged episodes (see
 * `docs/subtitle-sync-engine.md`): the small multilingual model put a word
 * start within 0.3 s of 75% of the English subtitle's cue starts, where the
 * energy gate found an onset within 0.6 s of about a third. Its built-in voice
 * detection is deliberately not used: whisper.cpp 1.9 leaves token times on
 * the voice-only timeline it builds, so words came back minutes from where they
 * were said.
 *
 * What a recogniser gets wrong is handled here rather than trusted:
 *
 *  - **Sound captions.** Whisper writes "(explosion)", "[MUSIC]", "♪ … ♪" for
 *    what it hears that is not speech. Those are kept as audio events — free,
 *    time-localised evidence of music and effects — and never as speech.
 *  - **Hallucinations.** Over music or silence it may emit a line nobody
 *    said, often the same line again and again, or a stock phrase from its
 *    training subtitles. Such segments are flagged and contribute nothing.
 *  - **Low confidence.** A segment whose words the model itself doubts is
 *    flagged; a timing anchor is only as good as its words.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeLocalPackagePlaylist } from "../../../renditions/adaptive/localPlaylist";
import { runBoundedProcess } from "../../../renditions/processExecution";
import type { SpeechInterval } from "./subtitleAlignment";

/** Bumped when parsing or flagging changes, which invalidates cached transcripts. */
export const TRANSCRIPT_SCHEMA_VERSION = 1;

export interface TranscriptWord {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** The recogniser's own probability for the word's tokens, averaged. */
  readonly probability: number;
}

export type TranscriptFlag =
  /** A caption of a sound, not speech. */
  | "sound"
  /** The same text as the segments around it, which a model looping over music writes. */
  | "repeated"
  /** A stock line from the model's training subtitles. */
  | "stock-phrase"
  /** The model's own confidence in the words is low. */
  | "low-confidence"
  /** More words than anybody can say in the time, or none in a long stretch. */
  | "implausible-rate";

export interface TranscriptSegment {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
  readonly words: readonly TranscriptWord[];
  readonly flags: readonly TranscriptFlag[];
}

export interface Transcript {
  readonly schemaVersion: number;
  readonly language: string;
  readonly engine: TranscriptEngine;
  readonly segments: readonly TranscriptSegment[];
  readonly durationSeconds: number | null;
}

export interface TranscriptEngine {
  readonly name: "whisper.cpp";
  /** The model file's name and size, which is what changes when it is replaced. */
  readonly model: string;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

/** A sound the recogniser captioned, with a coarse class. */
export interface AudioEvent {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly label: string;
  readonly category: "music" | "singing" | "effect" | "ambience" | "other";
}

/** A segment is evidence of speech only without any of these. */
const DISQUALIFYING: ReadonlySet<TranscriptFlag> = new Set([
  "sound",
  "repeated",
  "stock-phrase",
  "low-confidence",
  "implausible-rate",
]);

export function isReliableSpeech(segment: TranscriptSegment): boolean {
  return !segment.flags.some((flag) => DISQUALIFYING.has(flag));
}

/** Text that is only a caption: wholly in brackets, asterisks or music notes. */
const SOUND_CAPTION =
  /^\s*(?:[([*][^)\]*]*[)\]*]\s*)+$|^\s*[♪♫#]+[^♪♫]*[♪♫#]*\s*$/u;

/**
 * Lines Whisper is known to produce from silence and music, because its
 * training data was subtitles with credits in them. Lowercased, punctuation
 * stripped; matched as the whole segment or its start.
 */
const STOCK_PHRASES = [
  "thank you for watching",
  "thanks for watching",
  "please subscribe",
  "subtitles by",
  "subtitled by",
  "translated by",
  "amaraorg",
  "altyazı",
  "altyazi",
  "abone ol",
  "izlediğiniz için teşekkürler",
  "gracias por ver",
  "subtítulos",
];

const normalise = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function categorise(label: string): AudioEvent["category"] {
  const text = label.toLowerCase();
  if (/♪|sing|song|choir|vocal|hum/.test(text)) return "singing";
  if (/music|score|orchestra|piano|guitar|drum|melod|tune/.test(text))
    return "music";
  if (
    /explo|gun|shot|bang|crash|boom|thud|impact|punch|slam|glass|clang|thunder|roar|growl|scream|grunt|gasp|engine|siren|footstep|knock|crunch|whoosh|blast|fire/.test(
      text,
    )
  )
    return "effect";
  if (
    /wind|rain|crowd|chatter|ambien|birds|water|wave|traffic|murmur/.test(text)
  )
    return "ambience";
  return "other";
}

interface WhisperToken {
  readonly text: string;
  readonly offsets: { readonly from: number; readonly to: number };
  readonly p?: number;
}

interface WhisperJson {
  readonly result?: { readonly language?: string };
  readonly transcription: readonly {
    readonly offsets: { readonly from: number; readonly to: number };
    readonly text: string;
    readonly tokens?: readonly WhisperToken[];
  }[];
}

/**
 * Reads whisper.cpp's `--output-json-full` and flags what is not speech.
 *
 * Tokens are joined into words at a leading space, which is how its tokenizer
 * marks a word boundary; special tokens (`[_BEG_]`, `[_TT_…]`) are timing
 * markers, not text.
 */
export function parseWhisperTranscript(
  json: string,
  engine: TranscriptEngine,
  durationSeconds: number | null = null,
): Transcript {
  const data = JSON.parse(json) as WhisperJson;
  if (!Array.isArray(data.transcription))
    throw new Error("The recogniser's output has no transcription.");
  const segments: TranscriptSegment[] = data.transcription.map((segment) => {
    const words: { text: string; start: number; end: number; p: number[] }[] =
      [];
    for (const token of segment.tokens ?? []) {
      if (token.text.startsWith("[_")) continue;
      const start = token.offsets.from / 1000;
      const end = token.offsets.to / 1000;
      const previous = words[words.length - 1];
      if (previous && !token.text.startsWith(" ")) {
        previous.text += token.text;
        previous.end = end;
        previous.p.push(token.p ?? 0);
      } else
        words.push({
          text: token.text.trim(),
          start,
          end,
          p: [token.p ?? 0],
        });
    }
    const text = segment.text.trim();
    return {
      startSeconds: segment.offsets.from / 1000,
      endSeconds: segment.offsets.to / 1000,
      text,
      words: words
        .filter((word) => /[\p{L}\p{N}]/u.test(word.text))
        .map((word) => ({
          text: word.text,
          startSeconds: word.start,
          endSeconds: Math.max(word.start, word.end),
          probability:
            word.p.reduce((sum, value) => sum + value, 0) / word.p.length,
        })),
      flags: [],
    };
  });
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    language: data.result?.language ?? "und",
    engine,
    segments: flagSegments(segments),
    durationSeconds,
  };
}

/** Below this mean word probability a segment's words are the model's guess. */
const LOW_CONFIDENCE = 0.35;
/** Nobody says more than this many words a second for a whole segment. */
const MAX_WORDS_PER_SECOND = 7;

function flagSegments(
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
  return segments.map((segment, index) => {
    const flags: TranscriptFlag[] = [];
    const text = normalise(segment.text);
    if (SOUND_CAPTION.test(segment.text) || text === "") flags.push("sound");
    if (
      STOCK_PHRASES.some(
        (phrase) => text === phrase || text.startsWith(`${phrase} `),
      )
    )
      flags.push("stock-phrase");
    /*
     * A loop: the same words in at least three segments in a row. The first
     * of them may be real, so the run is flagged from its second member on.
     */
    const same = (other: TranscriptSegment | undefined) =>
      other !== undefined && text !== "" && normalise(other.text) === text;
    const runBefore =
      same(segments[index - 1]) &&
      (same(segments[index - 2]) || same(segments[index + 1]));
    if (runBefore) flags.push("repeated");
    const words = segment.words;
    if (words.length > 0) {
      const mean =
        words.reduce((sum, word) => sum + word.probability, 0) / words.length;
      if (mean < LOW_CONFIDENCE) flags.push("low-confidence");
      const spoken =
        (words[words.length - 1] as TranscriptWord).endSeconds -
        (words[0] as TranscriptWord).startSeconds;
      if (
        words.length >= 4 &&
        words.length / Math.max(0.1, spoken) > MAX_WORDS_PER_SECOND
      )
        flags.push("implausible-rate");
    }
    return { ...segment, flags };
  });
}

/**
 * Stretches of speech from the transcript's word timings: a new stretch
 * wherever two words are further apart than `gap`, or a segment ends. The
 * onset of a stretch is where a subtitle line most often starts.
 */
export function transcriptUtterances(
  transcript: Pick<Transcript, "segments">,
  gap = 0.6,
): SpeechInterval[] {
  const stretches: { startSeconds: number; endSeconds: number }[] = [];
  for (const segment of transcript.segments) {
    if (!isReliableSpeech(segment)) continue;
    let current: { startSeconds: number; endSeconds: number } | null = null;
    for (const word of segment.words) {
      if (current && word.startSeconds - current.endSeconds <= gap) {
        current.endSeconds = Math.max(current.endSeconds, word.endSeconds);
        continue;
      }
      if (current) stretches.push(current);
      current = {
        startSeconds: word.startSeconds,
        endSeconds: Math.max(word.endSeconds, word.startSeconds + 0.1),
      };
    }
    if (current) stretches.push(current);
  }
  return stretches.sort(
    (left, right) => left.startSeconds - right.startSeconds,
  );
}

/** The sounds the recogniser captioned, as events. */
export function transcriptAudioEvents(
  transcript: Pick<Transcript, "segments">,
): AudioEvent[] {
  return transcript.segments
    .filter((segment) => segment.flags.includes("sound"))
    .map((segment) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      label: segment.text.replace(/[()[\]*]/g, "").trim() || "sound",
      category: categorise(segment.text),
    }));
}

export interface WhisperConfig {
  /** The whisper.cpp command-line binary (`whisper-cli`). */
  readonly binaryPath: string;
  /** A ggml model file. Its name and size identify the analysis. */
  readonly modelPath: string;
  readonly threads?: number;
  /** Extra time budget per minute of audio, for a slow CPU host. */
  readonly secondsPerMinute?: number;
}

/**
 * Transcribes one audio stream.
 *
 * FFmpeg decodes it to 16 kHz mono, which is what Whisper hears, into a
 * private temporary directory that is removed on every exit path; the
 * recogniser then reads that file. A package playlist is first given a local
 * copy whose segment paths FFmpeg can open (see `localPackagePlaylist`).
 */
export async function transcribeAudio(options: {
  readonly ffmpegPath: string;
  readonly whisper: WhisperConfig;
  readonly inputPath: string;
  readonly streamIndex: number;
  readonly isPackagePlaylist?: boolean;
  /** An ISO 639-1 code, or "auto". The track's own language when known. */
  readonly language: string;
  readonly modelIdentity: string;
  readonly signal?: AbortSignal;
}): Promise<Transcript> {
  const scratch = await mkdtemp(path.join(tmpdir(), "seyirlik-asr-"));
  const localPlaylist = options.isPackagePlaylist
    ? await writeLocalPackagePlaylist(options.inputPath).catch(() => null)
    : null;
  try {
    const wav = path.join(scratch, "audio.wav");
    await runBoundedProcess({
      command: options.ffmpegPath,
      args: [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        localPlaylist?.path ?? options.inputPath,
        "-map",
        `0:${options.streamIndex}`,
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      timeoutMs: 20 * 60 * 1000,
      maxOutputBytes: 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      describe: "Audio decoding for transcription",
    });
    const durationSeconds = await wavDuration(wav);
    const output = path.join(scratch, "transcript");
    const threads = options.whisper.threads ?? 4;
    const args = [
      "-m",
      options.whisper.modelPath,
      "-f",
      wav,
      "-l",
      options.language,
      "-ojf",
      "-of",
      output,
      "-np",
      "-t",
      String(threads),
      // No carried context: a model that remembers its last line over a long
      // passage of music is a model that repeats it.
      "-mc",
      "0",
    ];
    const minutes = Math.max(1, (durationSeconds ?? 3600) / 60);
    await runBoundedProcess({
      command: options.whisper.binaryPath,
      args,
      timeoutMs: Math.round(
        Math.max(10 * 60, minutes * (options.whisper.secondsPerMinute ?? 30)) *
          1000,
      ),
      maxOutputBytes: 16 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      describe: "Speech recognition",
    });
    return parseWhisperTranscript(
      await readFile(`${output}.json`, "utf8"),
      {
        name: "whisper.cpp",
        model: options.modelIdentity,
        options: { language: options.language, maxContext: 0, threads },
      },
      durationSeconds,
    );
  } finally {
    await localPlaylist?.remove();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A canonical 16-bit mono WAV's length, from its header. */
async function wavDuration(file: string): Promise<number | null> {
  const { stat } = await import("node:fs/promises");
  const size = (await stat(file)).size;
  return size > 44 ? (size - 44) / (16000 * 2) : null;
}
