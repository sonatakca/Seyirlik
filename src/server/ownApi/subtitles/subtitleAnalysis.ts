/**
 * Transcribing a title's audio once, on the machine that can, for every
 * subtitle timed against it afterwards.
 *
 * The work is split by what each machine is for. Speech recognition wants a
 * GPU and minutes, so it is a heavy job (`subtitle.analyse`), claimed only by a
 * host that declares a recogniser in `SEYIRLIK_SUBTITLE_ASR` — the encoding
 * laptop. Its result goes to PostgreSQL, keyed by the audio itself. Matching a
 * subtitle's meaning to that transcript is light and needs the subtitle, so it
 * runs in the sync job on the always-on server, from the stored transcript,
 * with a small embedding model declared in `SEYIRLIK_SUBTITLE_EMBEDDINGS`.
 *
 * Every part is optional. Without a recogniser anywhere the analyse jobs wait
 * in the queue and syncing works from the audio's loudness alone, as it always
 * has; without an embedder the transcript is not used at all. Nothing here can
 * make a sync fail that would otherwise succeed.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { normalizeLanguage } from "../../../renditions/processing/languages";
import type { DatabasePool } from "../database/databasePool";
import { PermanentJobError, type JobHandler } from "../tasks/worker";
import type { AudioReference } from "./subtitleFit";
import type { TitleReferences } from "./subtitleReferences";
import {
  semanticAnchors,
  SEMANTIC_MATCHER_VERSION,
  type SemanticAnchorEvidence,
  type TextEmbedder,
} from "./subtitleSemantics";
import {
  isReliableSpeech,
  transcribeAudio,
  transcriptAudioEvents,
  TRANSCRIPT_SCHEMA_VERSION,
  type Transcript,
  type WhisperConfig,
} from "./subtitleTranscript";

export const SUBTITLE_ANALYSIS_JOB_TYPE = "subtitle.analyse";

/** `SEYIRLIK_SUBTITLE_ASR`: a whisper.cpp binary and model on this host. */
export function parseAsrConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WhisperConfig | undefined {
  const raw = environment.SEYIRLIK_SUBTITLE_ASR?.trim();
  if (!raw) return undefined;
  const fail = (): never => {
    throw new Error(
      'SEYIRLIK_SUBTITLE_ASR must be {"binaryPath": absolute, "modelPath": absolute, "threads"?: 1-64, "secondsPerMinute"?: 1-600}.',
    );
  };
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (key) =>
        !["binaryPath", "modelPath", "threads", "secondsPerMinute"].includes(
          key,
        ),
    ) ||
    typeof value.binaryPath !== "string" ||
    !path.isAbsolute(value.binaryPath) ||
    typeof value.modelPath !== "string" ||
    !path.isAbsolute(value.modelPath) ||
    (value.threads !== undefined &&
      (!Number.isInteger(value.threads) ||
        (value.threads as number) < 1 ||
        (value.threads as number) > 64)) ||
    (value.secondsPerMinute !== undefined &&
      (typeof value.secondsPerMinute !== "number" ||
        value.secondsPerMinute < 1 ||
        value.secondsPerMinute > 600))
  )
    return fail();
  return {
    binaryPath: value.binaryPath,
    modelPath: value.modelPath,
    ...(value.threads === undefined
      ? {}
      : { threads: value.threads as number }),
    ...(value.secondsPerMinute === undefined
      ? {}
      : { secondsPerMinute: value.secondsPerMinute as number }),
  };
}

export interface EmbeddingConfig {
  /** Where the model is downloaded once and kept. */
  readonly modelDir: string;
  readonly threads: number;
}

/** `SEYIRLIK_SUBTITLE_EMBEDDINGS`: where this host keeps its embedding model. */
export function parseEmbeddingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig | undefined {
  const raw = environment.SEYIRLIK_SUBTITLE_EMBEDDINGS?.trim();
  if (!raw) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    value = {};
  }
  if (
    typeof value.modelDir !== "string" ||
    !path.isAbsolute(value.modelDir) ||
    Object.keys(value).some((key) => !["modelDir", "threads"].includes(key)) ||
    (value.threads !== undefined &&
      (!Number.isInteger(value.threads) ||
        (value.threads as number) < 1 ||
        (value.threads as number) > 16))
  )
    throw new Error(
      'SEYIRLIK_SUBTITLE_EMBEDDINGS must be {"modelDir": absolute, "threads"?: 1-16}.',
    );
  return {
    modelDir: value.modelDir,
    threads: (value.threads as number | undefined) ?? 2,
  };
}

/**
 * The recogniser's language code for a stream's language tag: the two-letter
 * code Whisper expects, or "auto" when the tag is unknown.
 */
export function recogniserLanguage(tag: string | null | undefined): string {
  const canonical = normalizeLanguage(tag ?? undefined);
  const twoLetter: Record<string, string> = {
    eng: "en",
    tur: "tr",
    fra: "fr",
    deu: "de",
    spa: "es",
    ita: "it",
    jpn: "ja",
    rus: "ru",
    por: "pt",
    ara: "ar",
    zho: "zh",
    kor: "ko",
    nld: "nl",
    nor: "no",
    nob: "no",
    swe: "sv",
    dan: "da",
    pol: "pl",
  };
  return twoLetter[canonical] ?? "auto";
}

/**
 * What identifies the sound of one stream, the same on every machine.
 *
 * A package's audio is identified by its playlist's bytes, which name the
 * rendition and every byte range of it — a re-encode changes them. A source
 * not yet packaged by its size and modification time. Paths are left out:
 * the two machines mount the same Drive at different places.
 */
export async function audioIdentity(input: {
  mediaFileId: string;
  sourceStreamIndex: number | null;
  audio: AudioReference;
}): Promise<string> {
  const content = input.audio.isPackagePlaylist
    ? createHash("sha256")
        .update(await readFile(input.audio.path))
        .digest("hex")
    : await stat(input.audio.path).then(
        (stats) => `${stats.size}:${Math.round(stats.mtimeMs / 1000)}`,
      );
  return createHash("sha256")
    .update(
      JSON.stringify([
        "audio-1",
        input.mediaFileId,
        input.sourceStreamIndex,
        input.audio.streamIndex,
        content,
      ]),
    )
    .digest("hex");
}

/** A model file's identity: its name and size, which change when it is replaced. */
export async function modelIdentity(modelPath: string): Promise<string> {
  const size = (await stat(modelPath)).size;
  return `${path.basename(modelPath)}:${size}`;
}

export interface StoredTranscript {
  readonly id: string;
  readonly engine: string;
  readonly transcript: Transcript;
  readonly createdAt: Date;
}

export interface SubtitleAnalysisStore {
  findTranscript(audioKey: string): Promise<StoredTranscript | null>;
  hasTranscript(audioKey: string, engine: string): Promise<boolean>;
  saveTranscript(input: {
    mediaFileId: string;
    sourceStreamIndex: number | null;
    audioKey: string;
    engine: string;
    transcript: Transcript;
    elapsedMs: number;
  }): Promise<void>;
}

export function createSubtitleAnalysisStore(
  pool: DatabasePool,
): SubtitleAnalysisStore {
  return {
    async findTranscript(audioKey) {
      const result = await pool.query<{
        id: string;
        engine: string;
        result: Transcript;
        created_at: Date;
      }>(
        `SELECT id, engine, result, created_at FROM subtitle_audio_analyses
          WHERE audio_key = $1 AND kind = 'transcript' AND schema_version = $2
          ORDER BY created_at DESC LIMIT 1`,
        [audioKey, TRANSCRIPT_SCHEMA_VERSION],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            engine: row.engine,
            transcript: row.result,
            createdAt: row.created_at,
          }
        : null;
    },
    async hasTranscript(audioKey, engine) {
      const result = await pool.query(
        `SELECT 1 FROM subtitle_audio_analyses
          WHERE audio_key = $1 AND kind = 'transcript' AND engine = $2
            AND schema_version = $3`,
        [audioKey, engine, TRANSCRIPT_SCHEMA_VERSION],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async saveTranscript(input) {
      await pool.query(
        `INSERT INTO subtitle_audio_analyses
           (id, media_file_id, source_stream_index, audio_key, kind, engine,
            schema_version, result, produced_by, elapsed_ms)
         VALUES ($1, $2, $3, $4, 'transcript', $5, $6, $7, $8, $9)
         ON CONFLICT (audio_key, kind, engine, schema_version) DO UPDATE
           SET result = EXCLUDED.result,
               produced_by = EXCLUDED.produced_by,
               elapsed_ms = EXCLUDED.elapsed_ms,
               created_at = now()`,
        [
          randomUUID(),
          input.mediaFileId,
          input.sourceStreamIndex,
          input.audioKey,
          input.engine,
          TRANSCRIPT_SCHEMA_VERSION,
          JSON.stringify(compact(input.transcript)),
          hostname(),
          input.elapsedMs,
        ],
      );
    },
  };
}

/** Milliseconds and two-place probabilities are all the aligner reads. */
function compact(transcript: Transcript): Transcript {
  const ms = (value: number) => Math.round(value * 1000) / 1000;
  return {
    ...transcript,
    segments: transcript.segments.map((segment) => ({
      ...segment,
      startSeconds: ms(segment.startSeconds),
      endSeconds: ms(segment.endSeconds),
      words: segment.words.map((word) => ({
        text: word.text,
        startSeconds: ms(word.startSeconds),
        endSeconds: ms(word.endSeconds),
        probability: Math.round(word.probability * 100) / 100,
      })),
    })),
  };
}

/** What `subtitle.analyse` needs that it cannot reach for itself. */
export interface SubtitleAnalysisDependencies {
  readonly ffmpegPath: string;
  readonly whisper: WhisperConfig;
  readonly store: SubtitleAnalysisStore;
  readonly references: TitleReferences;
  mediaFileRelativePath(mediaFileId: string): Promise<string | null>;
  /** The language tag of a source audio stream, for the recogniser. */
  audioLanguage(
    mediaFileId: string,
    sourceStreamIndex: number | null,
  ): Promise<string | null>;
}

/** How often a running transcription asks whether it has been cancelled. */
const CANCELLATION_POLL_MS = 3_000;

export function createSubtitleAnalysisHandler(
  dependencies: SubtitleAnalysisDependencies,
): JobHandler {
  return async ({ job, reportProgress, isCancelled }) => {
    const { mediaFileId, sourceStreamIndex } = job.payload;
    if (
      typeof mediaFileId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(mediaFileId)
    )
      throw new PermanentJobError("The task must name a media file.");
    const streamIndex =
      sourceStreamIndex === undefined || sourceStreamIndex === null
        ? null
        : Number.isSafeInteger(sourceStreamIndex) &&
            (sourceStreamIndex as number) >= 0
          ? (sourceStreamIndex as number)
          : (() => {
              throw new PermanentJobError("The audio stream is not valid.");
            })();
    const relativePath = await dependencies.mediaFileRelativePath(mediaFileId);
    if (relativePath === null)
      throw new PermanentJobError("The catalogue has no path for this file.");
    const audio = await dependencies.references.audio({
      mediaFileId,
      relativePath,
      ...(streamIndex === null ? {} : { sourceStreamIndex: streamIndex }),
    });
    if (!audio)
      throw new PermanentJobError("This title has no audio to transcribe.");

    const audioKey = await audioIdentity({
      mediaFileId,
      sourceStreamIndex: streamIndex,
      audio,
    });
    const model = await modelIdentity(dependencies.whisper.modelPath);
    const engine = `whisper.cpp:${model}`;
    if (await dependencies.store.hasTranscript(audioKey, engine))
      return { outcome: "cached", audioKey };
    if (await isCancelled()) return { outcome: "cancelled" };

    const controller = new AbortController();
    const poll = setInterval(() => {
      void isCancelled()
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .catch(() => undefined);
    }, CANCELLATION_POLL_MS);
    poll.unref?.();
    try {
      await reportProgress(0, "Transcribing the audio", {
        phase: "analysing",
        measure: { kind: "indeterminate" },
      }).catch(() => undefined);
      const started = Date.now();
      const transcript = await transcribeAudio({
        ffmpegPath: dependencies.ffmpegPath,
        whisper: dependencies.whisper,
        inputPath: audio.path,
        streamIndex: audio.streamIndex,
        ...(audio.isPackagePlaylist ? { isPackagePlaylist: true } : {}),
        language: recogniserLanguage(
          await dependencies.audioLanguage(mediaFileId, streamIndex),
        ),
        modelIdentity: model,
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - started;
      await dependencies.store.saveTranscript({
        mediaFileId,
        sourceStreamIndex: streamIndex,
        audioKey,
        engine,
        transcript,
        elapsedMs,
      });
      const reliable = transcript.segments.filter(isReliableSpeech);
      return {
        outcome: "transcribed",
        audioKey,
        engine,
        language: transcript.language,
        segments: transcript.segments.length,
        reliableSegments: reliable.length,
        words: reliable.reduce((sum, segment) => sum + segment.words.length, 0),
        soundEvents: transcriptAudioEvents(transcript).length,
        elapsedMs,
      };
    } finally {
      clearInterval(poll);
    }
  };
}

/**
 * The anchors a stored transcript gives one subtitle, or null when there is
 * no transcript for this audio yet.
 */
export async function transcriptAnchors(input: {
  readonly store: SubtitleAnalysisStore;
  readonly embedder: TextEmbedder;
  readonly mediaFileId: string;
  readonly sourceStreamIndex: number | null;
  readonly audio: AudioReference;
  readonly cues: readonly {
    index: number;
    text: string;
    startSeconds: number;
  }[];
}): Promise<{
  readonly anchors: SemanticAnchorEvidence[];
  readonly describe: Record<string, unknown>;
} | null> {
  const audioKey = await audioIdentity({
    mediaFileId: input.mediaFileId,
    sourceStreamIndex: input.sourceStreamIndex,
    audio: input.audio,
  });
  const stored = await input.store.findTranscript(audioKey);
  if (!stored) return null;
  const segments = stored.transcript.segments.filter(isReliableSpeech);
  const anchors = await semanticAnchors({
    cues: input.cues,
    segments,
    embedder: input.embedder,
  });
  return {
    anchors,
    describe: {
      transcript: stored.id,
      engine: stored.engine,
      embedder: input.embedder.model,
      matcher: SEMANTIC_MATCHER_VERSION,
      reliableSegments: segments.length,
      anchors: anchors.length,
    },
  };
}
