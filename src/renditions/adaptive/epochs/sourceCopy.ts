/**
 * The source's sound and text subtitles, copied out by the video epochs.
 *
 * The audio and subtitle stages used to read the whole source again after the
 * video epochs: once for all the audio, then once more for each text subtitle
 * track. They map only their own streams, but a container interleaves those
 * with the picture, so FFmpeg reads every byte of the file each time. On a
 * 62 GB 4K remux over the Drive mount, each of those reads took as long as the
 * whole video encode, all to fetch about 1% of the bytes.
 *
 * Each epoch's FFmpeg is already reading its stretch of the source. It now also
 * stream-copies the retained audio and text subtitle tracks into a small
 * Matroska file kept with that epoch. The later stages join those files and
 * read from local disk.
 *
 * Exactness is measured, not assumed (FFmpeg 7.1, and 8.1 on the worker):
 *  - Every source packet lands in exactly one copy. `-copypriorss 0` drops the
 *    packets before the epoch's seek point. `-t` stops at the next epoch's seek
 *    point, and both bounds are written from the same whole microseconds, so a
 *    packet sitting exactly on a boundary goes to the later epoch and never to
 *    both.
 *  - `-output_ts_offset` puts each copy on the source's own timeline. The join
 *    chains every file from its measured start, and `-itsoffset` restores the
 *    first file's start. The joined packets and timestamps then match a direct
 *    read of the source, including a track that begins after the picture does.
 *    The AAC encode and the WebVTT extraction are byte-identical to the ones
 *    made from the source.
 *  - The concat list never uses `inpoint`. Seeking a Matroska file to a cue
 *    drops the packets of other tracks that sit before that cue (two AC-3
 *    frames per join, in testing).
 *  - The output carries no `-sn`: with it FFmpeg silently drops a subtitle
 *    stream even when it was mapped explicitly.
 *  - A subtitle track with no cue in an epoch does not keep FFmpeg reading past
 *    the epoch's end.
 */

import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFfprobe } from "../probePackaged";
import type { EpochPlan } from "./plan";

export const EPOCH_SOURCE_COPY_FILE = "source-streams.mka";
export const SOURCE_COPY_LIST_FILE = "source-streams.ffconcat";

/**
 * How far an audio track's first or last packet may sit from its epoch's
 * bounds.
 *
 * Audio frames run from under a millisecond (TrueHD) to a few tens of
 * milliseconds (AAC, AC-3). A copy that falls short by more than this was cut
 * off, and the stages read the source instead.
 */
const COPY_EDGE_TOLERANCE_SECONDS = 1;

/**
 * Containers whose streams have been proven to copy into Matroska cleanly.
 *
 * Anything else, such as AVI with missing timestamps or MPEG-TS with timestamp
 * wraps, is read the old way, because a failed copy costs an epoch attempt.
 */
const COPYABLE_SOURCE_EXTENSIONS = new Set([
  ".mkv",
  ".mka",
  ".webm",
  ".mp4",
  ".m4v",
  ".m4a",
  ".mov",
]);

/**
 * Text subtitle codecs that Matroska stores as they are.
 *
 * MP4's `mov_text` is not one of them. Those tracks keep their own read of the
 * source.
 */
const COPYABLE_SUBTITLE_CODECS = new Set([
  "subrip",
  "srt",
  "ass",
  "ssa",
  "webvtt",
  "text",
]);

export function sourceSupportsStreamCopy(sourcePath: string): boolean {
  return COPYABLE_SOURCE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase());
}

export function subtitleCodecCopies(codec: string): boolean {
  return COPYABLE_SUBTITLE_CODECS.has(codec.trim().toLowerCase());
}

export interface SourceCopyStream {
  /** Stream index in the source. */
  index: number;
  kind: "audio" | "subtitle";
}

/** What one epoch's copy holds, recorded in its checkpoint manifest. */
export interface EpochSourceCopyRecord {
  /** Relative to the epoch directory. */
  path: string;
  /** In the copy's own stream order. */
  streams: SourceCopyStream[];
  fileSizeBytes: number;
  /** Earliest packet in the copy, on FFmpeg's view of the source timeline. */
  startSeconds: number;
  /** The stretch this epoch owns: from its seek point to the next one. */
  windowStartSeconds: number;
  windowEndSeconds: number | null;
}

export interface SourceCopyWindow {
  startMicros: number;
  endMicros: number | null;
}

function micros(seconds: number): number {
  // Through the same six-decimal text the builder hands FFmpeg for `-ss`, so
  // both sides of a boundary are the same whole microsecond.
  return Math.round(Number(seconds.toFixed(6)) * 1_000_000);
}

function secondsText(value: number): string {
  return (value / 1_000_000).toFixed(6);
}

export function sourceCopyWindow(
  plan: EpochPlan,
  epochIndex: number,
): SourceCopyWindow {
  const epoch = plan.epochs[epochIndex];
  if (!epoch) throw new Error(`The plan has no epoch ${epochIndex}.`);
  const next = plan.epochs[epochIndex + 1];
  return {
    startMicros: epoch.seekSeconds > 0 ? micros(epoch.seekSeconds) : 0,
    endMicros: next ? micros(next.seekSeconds) : null,
  };
}

/**
 * A second output for an epoch's FFmpeg: the streams, copied untouched.
 *
 * Appended after the HLS output, so every option here belongs to this output
 * alone. Nothing is decoded, so it costs disk writes and no encoder time.
 */
export function sourceCopyOutputArgs({
  epochDirectory,
  streams,
  window,
}: {
  epochDirectory: string;
  streams: readonly SourceCopyStream[];
  window: SourceCopyWindow;
}): string[] {
  return [
    ...streams.flatMap((stream) => ["-map", `0:${stream.index}`]),
    "-c",
    "copy",
    /*
     * Only where the epoch seeks. The first epoch reads from the very start,
     * so nothing in it is "before" anything; and FFmpeg 8 keeps an AAC
     * track's priming at a negative timestamp, which this flag would drop.
     */
    ...(window.startMicros > 0 ? ["-copypriorss", "0"] : []),
    ...(window.endMicros === null
      ? []
      : ["-t", secondsText(window.endMicros - window.startMicros)]),
    ...(window.startMicros > 0
      ? ["-output_ts_offset", secondsText(window.startMicros)]
      : []),
    "-f",
    "matroska",
    path.join(epochDirectory, EPOCH_SOURCE_COPY_FILE).split(path.sep).join("/"),
  ];
}

/**
 * Whether FFmpeg's own words put a failure on the stream copy.
 *
 * The copy is the second output of the epoch's command, so FFmpeg names it as
 * output file #1 and its streams as `#1:n`. The HLS ladder is output #0, so a
 * failing encoder or a source read never matches.
 */
export function sourceCopyImplicated(ffmpegText: string): boolean {
  return /\[(?:out|[avsdt]?ost)#1[:/]|output file #1\b|\[matroska @/i.test(
    ffmpegText,
  );
}

interface CopyProbe {
  streams?: Array<{
    codec_type?: string;
    start_time?: string;
    tags?: Record<string, string>;
  }>;
  format?: { start_time?: string };
}

function clockSeconds(value: string | undefined): number | undefined {
  // Matroska's per-track DURATION tag: "HH:MM:SS.nnnnnnnnn", the track's end.
  const match = value?.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Checks that a finished copy covers its epoch's stretch on every audio track.
 *
 * The first epoch's start is not checked, because a track may legitimately
 * begin late. The last epoch's end is not checked either, because sound may
 * stop before the picture. Every join between epochs is checked on both sides.
 * Subtitle tracks are sparse, so an epoch with no dialogue has nothing to
 * measure. Their packets are cut by the same bounds as the audio.
 */
export async function inspectSourceCopy({
  epochDirectory,
  streams,
  window,
  ffprobePath,
  signal,
}: {
  epochDirectory: string;
  streams: readonly SourceCopyStream[];
  window: SourceCopyWindow;
  ffprobePath: string;
  signal?: AbortSignal;
}): Promise<
  { ok: true; record: EpochSourceCopyRecord } | { ok: false; reason: string }
> {
  const filePath = path.join(epochDirectory, EPOCH_SOURCE_COPY_FILE);
  const stats = await stat(filePath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    return { ok: false, reason: "the stream copy was not written" };
  }
  let parsed: CopyProbe;
  try {
    parsed = JSON.parse(
      await runFfprobe(
        ffprobePath,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,start_time:stream_tags=DURATION:format=start_time",
          "-of",
          "json",
          filePath,
        ],
        signal,
      ),
    ) as CopyProbe;
  } catch (error) {
    return {
      ok: false,
      reason: `the stream copy could not be probed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const probed = parsed.streams ?? [];
  if (probed.length !== streams.length) {
    return {
      ok: false,
      reason: `the stream copy has ${probed.length} tracks, expected ${streams.length}`,
    };
  }
  const windowStart = window.startMicros / 1_000_000;
  const windowEnd =
    window.endMicros === null ? null : window.endMicros / 1_000_000;
  for (const [position, stream] of streams.entries()) {
    const found = probed[position]!;
    const label = `track ${stream.index}`;
    if (found.codec_type !== stream.kind) {
      return {
        ok: false,
        reason: `${label} is ${found.codec_type ?? "unknown"}, expected ${stream.kind}`,
      };
    }
    if (stream.kind !== "audio") continue;
    const start = Number(found.start_time);
    const end = clockSeconds(found.tags?.DURATION ?? found.tags?.duration);
    if (!Number.isFinite(start) || end === undefined) {
      return { ok: false, reason: `${label} has no measurable extent` };
    }
    if (
      window.startMicros > 0 &&
      (start < windowStart - 0.001 ||
        start > windowStart + COPY_EDGE_TOLERANCE_SECONDS)
    ) {
      return {
        ok: false,
        reason: `${label} starts at ${start.toFixed(3)}s, not at ${windowStart.toFixed(3)}s`,
      };
    }
    if (
      windowEnd !== null &&
      (end < windowEnd - COPY_EDGE_TOLERANCE_SECONDS ||
        end > windowEnd + COPY_EDGE_TOLERANCE_SECONDS)
    ) {
      return {
        ok: false,
        reason: `${label} ends at ${end.toFixed(3)}s, not at ${windowEnd.toFixed(3)}s`,
      };
    }
  }
  const startSeconds = Number(parsed.format?.start_time);
  if (!Number.isFinite(startSeconds)) {
    return { ok: false, reason: "the stream copy has no start time" };
  }
  return {
    ok: true,
    record: {
      path: EPOCH_SOURCE_COPY_FILE,
      streams: streams.map((stream) => ({ ...stream })),
      fileSizeBytes: stats.size,
      startSeconds,
      windowStartSeconds: windowStart,
      windowEndSeconds: windowEnd,
    },
  };
}

export async function discardSourceCopy(epochDirectory: string): Promise<void> {
  await rm(path.join(epochDirectory, EPOCH_SOURCE_COPY_FILE), {
    force: true,
  }).catch(() => undefined);
}

function concatPath(filePath: string): string {
  // FFmpeg accepts forward slashes on Windows. Inside single quotes the only
  // character that needs care is the quote itself.
  return filePath.split(path.sep).join("/").replaceAll("'", "'\\''");
}

/**
 * The joined copies, standing in for the source as one FFmpeg input.
 *
 * `positionOf` maps a source stream index to its stream in this input; a
 * stream that is not there is read from the source as before.
 */
export interface SourceCopyInput {
  listPath: string;
  /** Options for the concat input, placed before its `-f concat -i`. */
  inputOptions: string[];
  /** The `-itsoffset` in `inputOptions`, in whole microseconds. */
  offsetMicros: number;
  positionOf: ReadonlyMap<number, number>;
  /** The copy's tracks, in its own stream order. */
  streams: readonly SourceCopyStream[];
}

function copyInputOptions(offsetMicros: number): string[] {
  return [
    "-safe",
    "0",
    ...(offsetMicros !== 0 ? ["-itsoffset", secondsText(offsetMicros)] : []),
  ];
}

export type SourceCopyAvailability =
  | { input: SourceCopyInput }
  | { unavailable: string };

/**
 * Writes the concat list for a finished build's copies, or says why not.
 *
 * All or nothing: an epoch without a copy (one encoded before copies existed, a
 * salvaged one, or one whose copy failed its check) sends every stage back to
 * the source. Every copy must still be on disk at the size recorded and must
 * hold the same tracks. The files are chained by their measured starts, so each
 * one is placed exactly where it sat in the source.
 */
export async function prepareSourceCopyInput({
  manifests,
  epochCount,
  epochPath,
  listPath,
}: {
  manifests: ReadonlyArray<{
    epochIndex: number;
    sourceCopy?: EpochSourceCopyRecord;
  }>;
  epochCount: number;
  epochPath: (index: number) => string;
  listPath: string;
}): Promise<SourceCopyAvailability> {
  const ordered = [...manifests].sort((a, b) => a.epochIndex - b.epochIndex);
  if (ordered.length === 0 || ordered.length !== epochCount) {
    return {
      unavailable: `${ordered.length} of ${epochCount} epochs have checkpoints`,
    };
  }
  const first = ordered[0]!.sourceCopy;
  if (!first) return { unavailable: "epoch 0 has no stream copy" };
  const lines = ["ffconcat version 1.0"];
  const startMicros: number[] = [];
  const files: string[] = [];
  for (const [position, manifest] of ordered.entries()) {
    if (manifest.epochIndex !== position) {
      return { unavailable: `epoch ${position} has no checkpoint` };
    }
    const copy = manifest.sourceCopy;
    if (!copy) {
      return { unavailable: `epoch ${position} has no stream copy` };
    }
    if (
      copy.streams.length !== first.streams.length ||
      copy.streams.some((stream, i) => first.streams[i]!.index !== stream.index)
    ) {
      return { unavailable: `epoch ${position} copied different tracks` };
    }
    const filePath = path.join(
      epochPath(manifest.epochIndex),
      ...copy.path.split("/"),
    );
    const stats = await stat(filePath).catch(() => undefined);
    if (!stats?.isFile() || stats.size !== copy.fileSizeBytes) {
      return {
        unavailable: `epoch ${position}'s stream copy is missing or changed`,
      };
    }
    files.push(filePath);
    startMicros.push(Math.round(copy.startSeconds * 1_000_000));
  }
  files.forEach((filePath, i) => {
    lines.push(`file '${concatPath(filePath)}'`);
    const next = startMicros[i + 1];
    if (next !== undefined) {
      lines.push(`duration ${secondsText(next - startMicros[i]!)}`);
    }
  });
  await writeFile(listPath, `${lines.join("\n")}\n`, "utf8");
  return {
    input: {
      listPath,
      inputOptions: copyInputOptions(startMicros[0]!),
      offsetMicros: startMicros[0]!,
      positionOf: new Map(
        first.streams.map((stream, position) => [stream.index, position]),
      ),
      streams: first.streams.map((stream) => ({ ...stream })),
    },
  };
}

/** Seconds of each input read to line the two up: a few dozen audio frames. */
const CALIBRATION_SECONDS = 4;
/** Packets per audio track that must match, hash for hash. */
const CALIBRATION_PACKETS = 24;

interface FramePacket {
  seconds: number;
  hash: string;
}

/** `-f framemd5` output, by output stream, with times in seconds. */
export function parseFrameMd5(text: string): Map<number, FramePacket[]> {
  const timebases = new Map<number, number>();
  const packets = new Map<number, FramePacket[]>();
  for (const line of text.split(/\r?\n/)) {
    const timebase = line.match(/^#tb (\d+): (\d+)\/(\d+)/);
    if (timebase) {
      timebases.set(
        Number(timebase[1]),
        Number(timebase[2]) / Number(timebase[3]),
      );
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(",").map((field) => field.trim());
    const stream = Number(fields[0]);
    const pts = Number(fields[2]);
    const hash = fields[5];
    const unit = timebases.get(stream);
    if (!Number.isFinite(stream) || !Number.isFinite(pts) || !hash || !unit) {
      continue;
    }
    const list = packets.get(stream) ?? [];
    list.push({ seconds: pts * unit, hash });
    packets.set(stream, list);
  }
  return packets;
}

/**
 * The shift that puts the joined copies' packets where the source's are.
 *
 * Undefined when the packets are not the same packets, or the shift is not
 * one constant across every track: then the copies must not stand in for the
 * source at all.
 */
export function alignmentShiftSeconds(
  source: ReadonlyMap<number, readonly FramePacket[]>,
  joined: ReadonlyMap<number, readonly FramePacket[]>,
  streams: number,
): number | undefined {
  let shift: number | undefined;
  for (let stream = 0; stream < streams; stream += 1) {
    const expected = source.get(stream) ?? [];
    const actual = joined.get(stream) ?? [];
    const count = Math.min(CALIBRATION_PACKETS, expected.length, actual.length);
    if (count < 5) return undefined;
    for (let index = 0; index < count; index += 1) {
      if (expected[index]!.hash !== actual[index]!.hash) return undefined;
      const delta = actual[index]!.seconds - expected[index]!.seconds;
      if (shift === undefined) shift = delta;
      else if (Math.abs(delta - shift) > 1e-6) return undefined;
    }
  }
  return shift;
}

/**
 * Lines the joined copies up with the source, measured, on this FFmpeg.
 *
 * How FFmpeg places a copied stream on the timeline has changed between
 * versions: 8.1 frames the copies 21 ms away from where 7.1 did, with every
 * packet otherwise identical. So nothing about it is assumed. The first
 * seconds of the source and of the joined copies are read through FFmpeg's
 * own pipeline, the audio packets compared hash for hash, and the difference
 * in their timestamps taken out of the copies' offset. Then it is read again
 * to prove the difference is gone. Anything short of an exact match leaves
 * the stages reading the source.
 */
export async function alignSourceCopyInput({
  ffmpegPath,
  sourcePath,
  input,
  signal,
}: {
  ffmpegPath: string;
  sourcePath: string;
  input: SourceCopyInput;
  signal?: AbortSignal;
}): Promise<SourceCopyAvailability> {
  const audio = input.streams.filter((stream) => stream.kind === "audio");
  if (audio.length === 0) {
    return { unavailable: "the copies hold no audio track to line them up by" };
  }
  const frames = (args: string[]) =>
    runFfprobe(ffmpegPath, args, signal).then(parseFrameMd5);
  const head = ["-v", "error", "-nostdin"];
  const tail = (indexes: readonly number[]) => [
    ...indexes.flatMap((index) => ["-map", `0:${index}`]),
    "-c",
    "copy",
    "-f",
    "framemd5",
    "-",
  ];
  const joined = (offsetMicros: number) =>
    frames([
      ...head,
      ...copyInputOptions(offsetMicros),
      "-f",
      "concat",
      "-t",
      String(CALIBRATION_SECONDS),
      "-i",
      input.listPath,
      ...tail(audio.map((stream) => input.positionOf.get(stream.index)!)),
    ]);
  try {
    const source = await frames([
      ...head,
      "-t",
      String(CALIBRATION_SECONDS),
      "-i",
      sourcePath,
      ...tail(audio.map((stream) => stream.index)),
    ]);
    const shift = alignmentShiftSeconds(
      source,
      await joined(input.offsetMicros),
      audio.length,
    );
    if (shift === undefined) {
      return {
        unavailable: "the copies' first packets are not the source's",
      };
    }
    const offsetMicros = input.offsetMicros - Math.round(shift * 1_000_000);
    if (offsetMicros !== input.offsetMicros) {
      const residual = alignmentShiftSeconds(
        source,
        await joined(offsetMicros),
        audio.length,
      );
      if (residual === undefined || Math.abs(residual) > 1e-6) {
        return {
          unavailable: "the copies could not be lined up with the source",
        };
      }
    }
    return {
      input: {
        ...input,
        offsetMicros,
        inputOptions: copyInputOptions(offsetMicros),
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      unavailable: `the copies could not be compared with the source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
