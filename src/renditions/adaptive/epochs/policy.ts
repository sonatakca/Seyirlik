/**
 * The durable checkpoint format, and the rules that decide where a movie is cut.
 *
 * A package used to be one transaction: one FFmpeg process read the source
 * once, decoded it once, and produced the whole ladder. That is the right shape
 * for throughput and the worst possible shape for recovery — losing the drive
 * at 00:52 of a 02:30 title threw away fifty-two minutes of encoding, because a
 * half-written ladder has no subset anybody can use.
 *
 * The timeline is now cut into nominal thirty-minute epochs. Each epoch is still
 * one FFmpeg process with one decode feeding every rung, so the shared-decode
 * advantage is kept intact; what changes is that an epoch which finishes is
 * *durable*. Worst-case loss is therefore one epoch rather than the whole
 * title.
 */

/**
 * Identifies the rules that place epoch boundaries.
 *
 * Bumping this invalidates every checkpoint on disk, because two builds with
 * different boundaries cannot be concatenated into one timeline. It is separate
 * from the adaptive profile version, which says whether a *published package*
 * is still readable: a change to where the cuts fall does not make an already
 * published title unplayable, and must not withdraw it from delivery.
 */
export const EPOCH_TIMELINE_POLICY_VERSION = "epoch-midpoint-cut-v1";

/** Version of the on-disk checkpoint manifest, read before anything is reused. */
export const EPOCH_CHECKPOINT_SCHEMA_VERSION = 1;

/** Version of the on-disk plan document. */
export const EPOCH_PLAN_SCHEMA_VERSION = 1;

/**
 * Nominal epoch length.
 *
 * The trade the whole design turns on: long enough that FFmpeg startup, the
 * seek preroll and the checkpoint validation are noise against the encode, and
 * short enough that losing one is an annoyance rather than an evening. It was
 * five minutes while encodes ran against a failing disk that lost one an hour;
 * on healthy local scratch thirty minutes costs at most one half-hour on a
 * crash, and saves a sixth of the process starts, seeks, validations and
 * joins. Plans already on disk keep the length they were made with.
 * Configurable for tests, which use seconds rather than minutes so an
 * integration test can cross several boundaries in a few seconds of fixture.
 */
export const DEFAULT_EPOCH_TARGET_SECONDS = 1800;

/**
 * The smallest tail worth its own epoch.
 *
 * A movie of 02:30:04 would otherwise end with a four-second epoch: an FFmpeg
 * start, a seek and a validation pass to protect four seconds of work. Anything
 * shorter than this is folded into the epoch before it, which is why the last
 * epoch may run up to one and a half times the target.
 */
export const MINIMUM_TAIL_FRACTION = 0.5;

/** Directory names inside a checkpoint root. */
export const EPOCH_PLAN_FILE = "plan.json";
export const EPOCH_DIRECTORY = "epochs";
export const EPOCH_MANIFEST_FILE = "COMPLETE.json";
export const EPOCH_AUDIO_DIRECTORY = "audio-stage";
export const EPOCH_SUBTITLE_DIRECTORY = "subtitle-stage";
export const EPOCH_ASSEMBLY_DIRECTORY = "assembly";

/**
 * Marks a directory that is being written and must never be read as finished.
 *
 * The suffix carries the writing process's identity so a reconciliation pass
 * can tell "another worker is using this right now" from "a worker died holding
 * this", which are the same directory and opposite decisions.
 */
export const EPOCH_PARTIAL_SUFFIX = ".partial";

/** Epoch directory name, zero padded so a directory listing sorts correctly. */
export function epochDirectoryName(index: number): string {
  return String(index).padStart(6, "0");
}

export function partialEpochDirectoryName(
  index: number,
  pid: number,
  token: string,
): string {
  return `${epochDirectoryName(index)}${EPOCH_PARTIAL_SUFFIX}-${pid}-${token}`;
}

const PARTIAL_PATTERN = /^(\d{6})\.partial-(\d+)-([0-9a-f]{4,32})$/;

export interface ParsedPartialEpochDirectory {
  index: number;
  pid: number;
  token: string;
}

export function parsePartialEpochDirectory(
  name: string,
): ParsedPartialEpochDirectory | null {
  const match = PARTIAL_PATTERN.exec(name);
  if (!match) return null;
  return {
    index: Number(match[1]),
    pid: Number(match[2]),
    token: match[3]!,
  };
}

export function parseCompletedEpochDirectory(name: string): number | null {
  if (!/^\d{6}$/.test(name)) return null;
  return Number(name);
}

/**
 * How an I/O error is told apart from a vanished volume.
 *
 * An `EIO` from FFmpeg has two completely different causes that produce an
 * identical message. The drive was pulled out — in which case the job must wait
 * and resume itself — or the volume is mounted, healthy and answering, and the
 * source is returning read errors from a bad region, in which case waiting
 * forever is the wrong answer and a person has to be told.
 *
 * The watchdog polls every five seconds, so the first `EIO` proves nothing: it
 * arrives inside the window where the drive may already be gone and the check
 * has not run. These backoffs are therefore long enough to outlast at least one
 * watchdog poll before the volume is believed to be healthy, and there are only
 * a few of them, because a source that has failed to read the same five minutes
 * three times over a quarter of a minute is not going to succeed on the fourth.
 */
export const SOURCE_IO_RETRY_BACKOFF_MS = [1_000, 6_000, 12_000] as const;

/** Reads of one epoch's source window allowed before it is called a bad source. */
export const SOURCE_IO_MAX_ATTEMPTS = SOURCE_IO_RETRY_BACKOFF_MS.length + 1;
