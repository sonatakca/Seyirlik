import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { planSourceRanges, type SourceInterval } from "./epochs/salvage";
import { parseFfmpegProgressFields } from "../progress";

const MAX_WEBVTT_BYTES = 32 * 1024 * 1024;

export function buildWebVttExtractionArgs(
  inputPath: string,
  streamIndex: number,
  outputPath: string,
  /**
   * The stretch of the source to read, when only part of it can be read.
   *
   * Given as input options so the demuxer stops at the end of the range rather
   * than reading on into a region that returns nothing. The cues come out timed
   * from zero, which is what `shiftWebVttCues` then puts back.
   */
  range?: { startSeconds: number; durationSeconds: number },
  /**
   * Options and a demuxer for the input, when it is the epochs' joined stream
   * copies rather than the source. See `epochs/sourceCopy.ts`.
   */
  input?: { options: readonly string[]; format: string },
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    /*
     * Where FFmpeg has got to in the source. An embedded track is found by
     * reading the whole file, which over Drive is tens of minutes, and without
     * this the page can only say how long the read has been going.
     */
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-nostats",
    "-y",
    ...(range && range.startSeconds > 0
      ? ["-ss", range.startSeconds.toFixed(3)]
      : []),
    ...(range && range.durationSeconds > 0
      ? ["-t", range.durationSeconds.toFixed(3)]
      : []),
    ...(input ? [...input.options, "-f", input.format] : []),
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    outputPath,
  ];
}

/** `HH:MM:SS.mmm`, the only cue-timestamp form this writes. */
export function formatWebVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const rest = clamped % 60;
  const whole = Math.floor(rest);
  const milliseconds = Math.round((rest - whole) * 1000);
  // Rounding can carry a millisecond into the next second; letting it write
  // `00:00:09.1000` would produce a cue no player can parse.
  const carry = milliseconds === 1000 ? 1 : 0;
  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(whole + carry).padStart(2, "0"),
  ]
    .join(":")
    .concat(`.${String(carry ? 0 : milliseconds).padStart(3, "0")}`);
}

export function parseWebVttTimestamp(text: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(
    text.trim(),
  );
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, "0")) / 1000
  );
}

const CUE_TIMING =
  /^((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{1,3})(.*)$/;

export interface WebVttCue {
  startSeconds: number;
  endSeconds: number;
  /** Anything after the timings on the same line: positioning, alignment. */
  settings: string;
  /** The identifier line, when the cue had one. */
  identifier?: string;
  text: string;
}

/**
 * Reads a WebVTT document into cues.
 *
 * Deliberately tolerant: anything that is not a cue — the header, `NOTE`
 * blocks, `STYLE` blocks — is skipped rather than rejected, because this runs
 * on whatever FFmpeg produced from whatever the container held, and a subtitle
 * track is never a reason to fail a title.
 */
export function parseWebVttCues(text: string): WebVttCue[] {
  const cues: WebVttCue[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((line) => CUE_TIMING.test(line.trim()));
    if (timingIndex < 0) continue;
    const match = CUE_TIMING.exec(lines[timingIndex]!.trim())!;
    const startSeconds = parseWebVttTimestamp(match[1]!);
    const endSeconds = parseWebVttTimestamp(match[2]!);
    if (startSeconds === null || endSeconds === null) continue;
    const identifier =
      timingIndex > 0 ? lines.slice(0, timingIndex).join("\n") : undefined;
    cues.push({
      startSeconds,
      endSeconds,
      settings: match[3]!.trim(),
      ...(identifier ? { identifier } : {}),
      text: lines.slice(timingIndex + 1).join("\n"),
    });
  }
  return cues;
}

export function serialiseWebVttCues(cues: readonly WebVttCue[]): string {
  const blocks = cues.map((cue) =>
    [
      ...(cue.identifier ? [cue.identifier] : []),
      `${formatWebVttTimestamp(cue.startSeconds)} --> ${formatWebVttTimestamp(
        cue.endSeconds,
      )}${cue.settings ? ` ${cue.settings}` : ""}`,
      cue.text,
    ].join("\n"),
  );
  return ["WEBVTT", "", ...blocks.map((block) => `${block}\n`)].join("\n");
}

/** Moves every cue by a fixed offset, which is how a range regains its place. */
export function shiftWebVttCues(
  cues: readonly WebVttCue[],
  offsetSeconds: number,
): WebVttCue[] {
  if (offsetSeconds === 0) return [...cues];
  return cues.map((cue) => ({
    ...cue,
    startSeconds: cue.startSeconds + offsetSeconds,
    endSeconds: cue.endSeconds + offsetSeconds,
  }));
}

/**
 * Joins the cues recovered from several readable stretches into one document.
 *
 * Nothing is invented and nothing is moved: cues keep the timestamps they have
 * on the source's own timeline, so a viewer who seeks past a damaged interval
 * finds the dialogue where it belongs rather than shifted by the length of the
 * hole. Cues whose bytes were inside the hole are simply absent, which is the
 * honest outcome and is recorded in the job's warning.
 *
 * A cue that straddles a range boundary is read twice, once clipped; the
 * duplicate is dropped by text and overlap rather than by exact timing.
 */
export function mergeWebVttCues(
  groups: readonly (readonly WebVttCue[])[],
): WebVttCue[] {
  const merged: WebVttCue[] = [];
  for (const group of groups) {
    for (const cue of group) {
      const duplicate = merged.find(
        (kept) =>
          kept.text === cue.text &&
          cue.startSeconds < kept.endSeconds + 0.001 &&
          kept.startSeconds < cue.endSeconds + 0.001,
      );
      if (duplicate) {
        // Keep the widest reading of a cue that was clipped by a boundary.
        duplicate.startSeconds = Math.min(
          duplicate.startSeconds,
          cue.startSeconds,
        );
        duplicate.endSeconds = Math.max(duplicate.endSeconds, cue.endSeconds);
        continue;
      }
      merged.push({ ...cue });
    }
  }
  return merged.sort((left, right) => left.startSeconds - right.startSeconds);
}

async function runWebVttExtraction({
  ffmpegPath,
  inputPath,
  streamIndex,
  outputPath,
  range,
  input,
  signal,
  onPosition,
}: {
  ffmpegPath: string;
  inputPath: string;
  streamIndex: number;
  outputPath: string;
  range?: { startSeconds: number; durationSeconds: number };
  input?: { options: readonly string[]; format: string };
  signal?: AbortSignal;
  /**
   * Seconds into what this run reads, from FFmpeg's `-progress` blocks. It is
   * the timestamp of the last cue written, so it holds still through a long
   * stretch without dialogue and then catches up.
   */
  onPosition?: (seconds: number) => void;
}): Promise<void> {
  await runWebVttFfmpeg({
    ffmpegPath,
    args: buildWebVttExtractionArgs(
      inputPath,
      streamIndex,
      outputPath,
      range,
      input,
    ),
    label: `stream ${streamIndex}`,
    ...(signal ? { signal } : {}),
    ...(onPosition ? { onPosition } : {}),
  });
}

async function runWebVttFfmpeg({
  ffmpegPath,
  args,
  label,
  signal,
  onPosition,
}: {
  ffmpegPath: string;
  args: string[];
  /** Names what failed, e.g. "stream 3" or "streams 3, 4". */
  label: string;
  signal?: AbortSignal;
  onPosition?: (seconds: number) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false, windowsHide: true });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Subtitle extraction was cancelled."));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    let pending = "";
    let fields: Record<string, string> = {};
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator).trim();
        fields[key] = line.slice(separator + 1).trim();
        if (key !== "progress") continue;
        if (onPosition) {
          try {
            onPosition(parseFfmpegProgressFields(fields).processedSeconds);
          } catch {
            // A reporting fault never costs the extraction.
          }
        }
        fields = {};
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.once("error", finish);
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `WebVTT extraction for ${label} failed: ${stderr.trim() || `FFmpeg exited ${code}`}`,
          ),
        );
      } else finish();
    });
  });
}

export async function extractWebVttFile({
  ffmpegPath,
  inputPath,
  streamIndex,
  outputPath,
  damagedIntervals = [],
  sourceDurationSeconds,
  signal,
  onProgress,
  input,
}: {
  ffmpegPath: string;
  inputPath: string;
  streamIndex: number;
  outputPath: string;
  /**
   * Options and a demuxer for `inputPath`, when it is the epochs' joined
   * stream copies. Not combined with `damagedIntervals`: a salvaged build has
   * no copies.
   */
  input?: { options: readonly string[]; format: string };
  /**
   * Stretches the source cannot return.
   *
   * When any are known the track is read in the pieces around them and the
   * pieces are put back on the source's own timeline, so dialogue after a hole
   * keeps its own timestamps. Cues inside the hole are lost, which is stated in
   * the job's warning rather than papered over by moving what follows.
   */
  damagedIntervals?: readonly SourceInterval[];
  /**
   * Required when `damagedIntervals` is non-empty, to bound the last range.
   * Also what `onProgress` measures against: without it there is no fraction.
   */
  sourceDurationSeconds?: number;
  signal?: AbortSignal;
  /**
   * How much of the read is done, 0 to 1, never moving backwards. Reaches 1
   * only when the file has been written.
   */
  onProgress?: (fraction: number) => void;
}): Promise<{ fileSizeBytes: number; contents: string; partial: boolean }> {
  const readable =
    damagedIntervals.length > 0 && sourceDurationSeconds
      ? planSourceRanges(damagedIntervals, sourceDurationSeconds).filter(
          (range) => range.kind === "source",
        )
      : [];

  let reported = 0;
  const report = (fraction: number): void => {
    if (!onProgress || !Number.isFinite(fraction)) return;
    const bounded = Math.min(1, Math.max(reported, fraction));
    if (bounded <= reported && bounded < 1) return;
    reported = bounded;
    onProgress(bounded);
  };
  /*
   * FFmpeg's position can reach the full duration before the muxer has
   * finished, so a running read stops just short of done.
   */
  const RUNNING_CEILING = 0.999;

  if (readable.length === 0) {
    const total = sourceDurationSeconds ?? 0;
    await runWebVttExtraction({
      ffmpegPath,
      inputPath,
      streamIndex,
      outputPath,
      ...(input ? { input } : {}),
      ...(signal ? { signal } : {}),
      ...(onProgress && total > 0
        ? {
            onPosition: (seconds: number) =>
              report(Math.min(RUNNING_CEILING, seconds / total)),
          }
        : {}),
    });
  } else {
    const scratch = await mkdtemp(path.join(tmpdir(), "seyirlik-webvtt-"));
    try {
      const groups: WebVttCue[][] = [];
      const readableSeconds = readable.reduce(
        (sum, range) => sum + range.durationSeconds,
        0,
      );
      let readSeconds = 0;
      for (const [ordinal, range] of readable.entries()) {
        const partPath = path.join(scratch, `part-${ordinal}.vtt`);
        const before = readSeconds;
        readSeconds += range.durationSeconds;
        try {
          await runWebVttExtraction({
            ffmpegPath,
            inputPath,
            streamIndex,
            outputPath: partPath,
            range: {
              startSeconds: range.startSeconds,
              durationSeconds: range.durationSeconds,
            },
            ...(signal ? { signal } : {}),
            ...(onProgress && readableSeconds > 0
              ? {
                  // Cues in a range come out timed from zero, so the
                  // position is already relative to the range's start.
                  onPosition: (seconds: number) =>
                    report(
                      Math.min(
                        RUNNING_CEILING,
                        (before + Math.min(seconds, range.durationSeconds)) /
                          readableSeconds,
                      ),
                    ),
                }
              : {}),
          });
        } catch {
          /*
           * One unreadable stretch does not cost the other. A range that fails
           * contributes no cues; the ones that succeeded keep theirs, at their
           * own timestamps.
           */
          continue;
        }
        const part = await readFile(partPath, "utf8").catch(() => "");
        groups.push(shiftWebVttCues(parseWebVttCues(part), range.startSeconds));
      }
      await writeFile(
        outputPath,
        serialiseWebVttCues(mergeWebVttCues(groups)),
        "utf8",
      );
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  const result = await readWebVttOutput(outputPath, streamIndex);
  report(1);
  return { ...result, partial: readable.length > 0 };
}

/** A finished WebVTT file, checked the same way whichever run wrote it. */
async function readWebVttOutput(
  outputPath: string,
  streamIndex: number,
): Promise<{ fileSizeBytes: number; contents: string }> {
  const file = await stat(outputPath);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_WEBVTT_BYTES) {
    throw new Error(
      `WebVTT extraction for stream ${streamIndex} produced an invalid file size.`,
    );
  }
  const contents = await readFile(outputPath, "utf8");
  if (!/^WEBVTT(?:\s|$)/.test(contents)) {
    throw new Error(
      `WebVTT extraction for stream ${streamIndex} did not produce WebVTT.`,
    );
  }
  return { fileSizeBytes: file.size, contents };
}

/**
 * Several text subtitle tracks of one input, in a single read.
 *
 * An embedded track can only be reached by reading the whole container, so
 * extracting tracks one at a time read a 62 GB remux once per track over the
 * Drive mount, an hour or more each. One FFmpeg run with an output per track
 * reads it once. Each file is checked exactly as a single extraction's is.
 */
export function buildWebVttMultiExtractionArgs(
  inputPath: string,
  tracks: ReadonlyArray<{ streamIndex: number; outputPath: string }>,
  input?: { options: readonly string[]; format: string },
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-nostats",
    "-y",
    ...(input ? [...input.options, "-f", input.format] : []),
    "-i",
    inputPath,
    ...tracks.flatMap((track) => [
      "-map",
      `0:${track.streamIndex}`,
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      track.outputPath,
    ]),
  ];
}

export async function extractWebVttFiles({
  ffmpegPath,
  inputPath,
  tracks,
  input,
  sourceDurationSeconds,
  signal,
  onProgress,
}: {
  ffmpegPath: string;
  inputPath: string;
  /** `streamIndex` is the stream in this input; `outputPath` its own file. */
  tracks: ReadonlyArray<{ streamIndex: number; outputPath: string }>;
  input?: { options: readonly string[]; format: string };
  sourceDurationSeconds?: number;
  signal?: AbortSignal;
  /** How much of the shared read is done, 0 to 1, never moving backwards. */
  onProgress?: (fraction: number) => void;
}): Promise<Map<number, { fileSizeBytes: number; contents: string }>> {
  if (tracks.length === 0) return new Map();
  let reported = 0;
  const total = sourceDurationSeconds ?? 0;
  await runWebVttFfmpeg({
    ffmpegPath,
    args: buildWebVttMultiExtractionArgs(inputPath, tracks, input),
    label: `streams ${tracks.map((track) => track.streamIndex).join(", ")}`,
    ...(signal ? { signal } : {}),
    ...(onProgress && total > 0
      ? {
          onPosition: (seconds: number) => {
            // Short of done until the files are written and checked.
            const fraction = Math.min(
              0.999,
              Math.max(reported, seconds / total),
            );
            if (!Number.isFinite(fraction) || fraction <= reported) return;
            reported = fraction;
            onProgress(fraction);
          },
        }
      : {}),
  });
  const results = new Map<
    number,
    { fileSizeBytes: number; contents: string }
  >();
  for (const track of tracks) {
    results.set(
      track.streamIndex,
      await readWebVttOutput(track.outputPath, track.streamIndex),
    );
  }
  onProgress?.(1);
  return results;
}

export function buildWebVttMediaPlaylist(
  durationSeconds: number,
  subtitleFileName: string,
): string {
  const target = Math.max(1, Math.ceil(durationSeconds));
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${durationSeconds.toFixed(6)},`,
    subtitleFileName,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

export function parseWebVttMediaPlaylist(text: string): {
  durationSeconds: number;
  uri: string;
} {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "#EXTM3U" || !lines.includes("#EXT-X-ENDLIST")) {
    throw new Error("WebVTT media playlist is not a complete HLS playlist.");
  }
  const extinfIndex = lines.findIndex((line) => line.startsWith("#EXTINF:"));
  const durationSeconds = Number(
    lines[extinfIndex]?.slice("#EXTINF:".length).split(",")[0],
  );
  const uri = lines[extinfIndex + 1];
  if (
    extinfIndex < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !uri ||
    uri.startsWith("#")
  ) {
    throw new Error("WebVTT media playlist has no valid subtitle segment.");
  }
  return { durationSeconds, uri };
}
