/**
 * Where a five-minute boundary actually falls in a source's own timestamps.
 *
 * A nominal boundary is a round number; a source's frames are not. At 23.976
 * fps no frame lands on 00:05:00 at all — the neighbours are 299.966 and
 * 300.008 — so "cut at 300" has to be turned into a decision about which of
 * those two frames belongs to which epoch, and that decision has to be made the
 * same way every time the job restarts.
 *
 * The rule is: the epoch owns every frame whose presentation time is at or
 * after the boundary, and FFmpeg is asked to cut *midway between* the two
 * straddling frames. Asking it to cut at the boundary itself would put a real
 * frame within a rounding error of the cut, and a microsecond either way then
 * decides whether that frame is encoded twice or not at all. Half a frame of
 * slack is not a tolerance being relaxed; it is the only place in the interval
 * where no frame exists and therefore the only place a cut is unambiguous.
 */

import { runBoundedProcess } from "../../processExecution";

/** Presentation time as the source stores it, kept as an exact rational. */
export interface SourceTimestamp {
  /** Numerator in the source stream's own time base. */
  ticks: number;
  /** Denominator of the source stream's time base, e.g. 24000. */
  timebase: number;
}

export function timestampSeconds(value: SourceTimestamp): number {
  return value.ticks / value.timebase;
}

/**
 * Converts a source timestamp into a packaged rendition's media timescale.
 *
 * Done in integer arithmetic through the rational rather than by multiplying a
 * float by a timescale, so a two-and-a-half-hour title cannot accumulate a
 * fraction of a tick per epoch into something visible at the end.
 */
export function timestampToTicks(
  value: SourceTimestamp,
  timescale: number,
): number {
  return Math.round((value.ticks * timescale) / value.timebase);
}

export interface StraddlingFrames {
  /** The last frame strictly before the boundary, if the probe saw one. */
  previous?: SourceTimestamp;
  /** The first frame at or after the boundary, if the probe saw one. */
  next?: SourceTimestamp;
}

export interface SourceFrameTimeline {
  timebase: number;
  /** Sorted presentation ticks the probe collected, deduplicated. */
  ticks: number[];
}

const MAX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A probe that cannot outlive its own question.
 *
 * This reads the *source*, which on the drive that motivated all of this can
 * enter the same twenty-retry kernel recovery as the encode it is diagnosing —
 * so it is spawned through the managed runner with a wall clock, a process
 * group and an escalating termination. An unbounded `await` here would hang the
 * worker in precisely the situation it exists to diagnose.
 */
/**
 * The runner this module spawns through.
 *
 * Injected so a test can substitute a program of its own without needing one
 * the host can execute — the fixtures here used to be `/bin/sh` scripts, which
 * a Windows host cannot run at all, so the spawn failed and every case read the
 * failure as an answer about the source. Everything else stays on the
 * production path: the wall clock, the process group, the escalation and the
 * reap are the real ones.
 */
export type BoundedRunner = typeof runBoundedProcess;

async function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs?: number,
  run: BoundedRunner = runBoundedProcess,
): Promise<string> {
  const { stdout } = await run({
    command,
    args,
    ...(signal ? { signal } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    describe: "The source timeline probe",
  });
  return stdout;
}

function parseTimebase(value: string): number | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || numerator !== 1) return undefined;
  return Number.isFinite(denominator) && denominator > 0
    ? denominator
    : undefined;
}

/**
 * The window read around each boundary.
 *
 * Half a second either side is comfortably more than one frame at any rate the
 * library contains, and the read starts from the keyframe before the window, so
 * the probe always sees both straddling frames. The end is given as an absolute
 * time rather than a duration because `-read_intervals` measures a duration
 * from wherever the *seek* landed, which on a source with sparse keyframes is
 * nowhere near the requested start.
 */
const BOUNDARY_WINDOW_SECONDS = 0.5;

/**
 * Collects presentation timestamps around every nominal boundary.
 *
 * Packets rather than frames: a video packet carries the presentation time of
 * exactly one frame, and reading packets means the probe never decodes, so
 * placing thirty boundaries in a 4K title costs a seek and a few hundred
 * packets rather than a minute of decoding.
 */
export async function probeSourceFrameTimeline({
  sourcePath,
  boundaries,
  ffprobePath = "ffprobe",
  signal,
  timeoutMs,
  run,
}: {
  sourcePath: string;
  boundaries: readonly number[];
  ffprobePath?: string;
  signal?: AbortSignal;
  /** Injected by tests; see `BoundedRunner`. */
  run?: BoundedRunner;
  /**
   * Wall clock the probe may not exceed.
   *
   * Set by anything asking this question *about a source that is already
   * suspect*. Left unset for ordinary planning, where the file has just been
   * probed successfully and a timeout would only add a way to fail.
   */
  timeoutMs?: number;
}): Promise<SourceFrameTimeline | null> {
  if (boundaries.length === 0) return { timebase: 1000, ticks: [] };

  const intervals = boundaries
    .map((boundary) => {
      const start = Math.max(0, boundary - BOUNDARY_WINDOW_SECONDS);
      const end = boundary + BOUNDARY_WINDOW_SECONDS;
      return `${start.toFixed(6)}%${end.toFixed(6)}`;
    })
    .join(",");

  let output: string;
  try {
    output = await runProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base:packet=pts",
        "-of",
        "compact=p=0:nk=0",
        "-read_intervals",
        intervals,
        sourcePath,
      ],
      signal,
      timeoutMs,
      run,
    );
  } catch {
    // A source the prober cannot read is not a reason to refuse to build it:
    // the planner falls back to nominal boundaries, which are correct to within
    // one frame and which the epoch validator still measures afterwards.
    return null;
  }

  let timebase: number | undefined;
  const ticks = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const timebaseField = /(?:^|\|)time_base=([^|]+)/.exec(trimmed);
    if (timebaseField) {
      timebase ??= parseTimebase(timebaseField[1]!);
      continue;
    }
    const ptsField = /(?:^|\|)pts=(-?\d+)/.exec(trimmed);
    if (ptsField) {
      const value = Number(ptsField[1]);
      if (Number.isFinite(value) && value >= 0) ticks.add(value);
    }
  }

  if (timebase === undefined || ticks.size === 0) return null;
  return { timebase, ticks: [...ticks].sort((left, right) => left - right) };
}

/**
 * The two frames a nominal boundary falls between.
 *
 * `previous` is missing when the boundary precedes every frame the probe saw,
 * `next` when it follows all of them — which is how the planner recognises a
 * boundary past the end of the source and stops placing epochs there.
 */
export function straddlingFrames(
  timeline: SourceFrameTimeline,
  boundarySeconds: number,
): StraddlingFrames {
  const boundaryTicks = boundarySeconds * timeline.timebase;
  let previous: number | undefined;
  let next: number | undefined;
  for (const tick of timeline.ticks) {
    if (tick < boundaryTicks) previous = tick;
    else {
      next = tick;
      break;
    }
  }
  return {
    ...(previous === undefined
      ? {}
      : { previous: { ticks: previous, timebase: timeline.timebase } }),
    ...(next === undefined
      ? {}
      : { next: { ticks: next, timebase: timeline.timebase } }),
  };
}

/**
 * The instant to hand FFmpeg as the cut, in seconds.
 *
 * Midway between the two frames, rounded down to the microsecond FFmpeg parses
 * `-ss` into. Rounding down keeps the cut strictly before the frame that starts
 * the next epoch even when the midpoint is not representable, which is the
 * direction that cannot lose a frame.
 */
export function cutSecondsBetween(
  frames: StraddlingFrames,
  boundarySeconds: number,
): number {
  const previous = frames.previous
    ? timestampSeconds(frames.previous)
    : undefined;
  const next = frames.next ? timestampSeconds(frames.next) : undefined;
  if (previous === undefined || next === undefined) return boundarySeconds;
  const midpoint = (previous + next) / 2;
  return Math.floor(midpoint * 1_000_000) / 1_000_000;
}

/**
 * How far before the container's end the video's last frames are looked for.
 *
 * A container's duration is that of its longest stream, which is often audio:
 * Lilyhammer's episodes carry a third of a second of sound after their last
 * picture. Ten seconds is far more than any such tail and still only a short
 * read, since the probe reads packets and never decodes.
 */
const VIDEO_END_WINDOW_SECONDS = 10;

/**
 * The instant the source's last video frame stops being shown.
 *
 * The final epoch runs to the end of the source, and what it encodes is the
 * video stream, so its expected length must be measured against where the
 * video ends rather than where the container does. Null when the probe cannot
 * say, in which case the container duration stands, as it always did.
 */
export async function probeSourceVideoEndSeconds({
  sourcePath,
  containerDurationSeconds,
  ffprobePath = "ffprobe",
  signal,
  timeoutMs,
  run,
}: {
  sourcePath: string;
  containerDurationSeconds: number;
  ffprobePath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected by tests; see `BoundedRunner`. */
  run?: BoundedRunner;
}): Promise<number | null> {
  const start = Math.max(
    0,
    containerDurationSeconds - VIDEO_END_WINDOW_SECONDS,
  );
  let output: string;
  try {
    output = await runProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base:packet=pts,duration",
        "-of",
        "compact=p=0:nk=0",
        "-read_intervals",
        `${start.toFixed(6)}%`,
        sourcePath,
      ],
      signal,
      timeoutMs,
      run,
    );
  } catch {
    return null;
  }
  return parseVideoEndSeconds(output);
}

/**
 * The end of the last frame in a packet listing: its presentation time plus
 * its duration, or plus the stream's frame interval when the container records
 * no packet durations.
 */
export function parseVideoEndSeconds(output: string): number | null {
  let timebase: number | undefined;
  const packets: Array<{ pts: number; duration?: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const timebaseField = /(?:^|\|)time_base=([^|]+)/.exec(trimmed);
    if (timebaseField) {
      timebase ??= parseTimebase(timebaseField[1]!);
      continue;
    }
    const ptsField = /(?:^|\|)pts=(-?\d+)/.exec(trimmed);
    if (!ptsField) continue;
    const pts = Number(ptsField[1]);
    if (!Number.isFinite(pts) || pts < 0) continue;
    const durationField = /(?:^|\|)duration=(\d+)/.exec(trimmed);
    const duration = durationField ? Number(durationField[1]) : undefined;
    packets.push({
      pts,
      ...(duration !== undefined && duration > 0 ? { duration } : {}),
    });
  }
  if (timebase === undefined || packets.length === 0) return null;

  const sorted = [...new Set(packets.map((packet) => packet.pts))].sort(
    (left, right) => left - right,
  );
  let interval: number | undefined;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index]! - sorted[index - 1]!;
    if (gap > 0 && (interval === undefined || gap < interval)) interval = gap;
  }

  let endTicks: number | undefined;
  for (const packet of packets) {
    const length = packet.duration ?? interval;
    if (length === undefined) continue;
    const end = packet.pts + length;
    if (endTicks === undefined || end > endTicks) endTicks = end;
  }
  return endTicks === undefined ? null : endTicks / timebase;
}
