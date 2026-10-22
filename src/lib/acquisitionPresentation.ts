/**
 * How an acquisition reads to somebody who has to decide what to do about it.
 *
 * The server is the authority on what may happen — it refuses a retry from the
 * wrong state and a cancellation of a finished download — and this mirrors
 * those rules so the page does not offer a button that will be refused. Where
 * the two could drift, the server wins: an action offered here and rejected
 * there is a worse outcome than an action not offered.
 */

/** The eleven states an acquisition can be in, as the server names them. */
export type AcquisitionState =
  | "planned"
  | "resolving"
  | "submitting"
  | "queued"
  | "downloading"
  | "processing"
  | "downloaded"
  | "awaiting_retry"
  | "failed"
  | "cancelled"
  | "superseded";

/** Which list an acquisition belongs in. */
export type AcquisitionBucket =
  /** Seyirlik is doing something about it right now. */
  | "active"
  /** Nothing is happening and something should. */
  | "needsAttention"
  /** Done, one way or another. */
  | "finished";

const ACTIVE: readonly AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "awaiting_retry",
];

const FINISHED: readonly AcquisitionState[] = [
  "downloaded",
  "cancelled",
  "superseded",
];

export function bucketOf(state: AcquisitionState): AcquisitionBucket {
  if (ACTIVE.includes(state)) return "active";
  if (FINISHED.includes(state)) return "finished";
  // `failed` is the only thing left, and it is the only one waiting on a
  // person: the queue has stopped trying and will not resume by itself.
  return "needsAttention";
}

/**
 * Where the server will blocklist from: not mid-submission, and not once the
 * record is over.
 */
const BLOCKLISTABLE: readonly AcquisitionState[] = [
  "planned",
  "queued",
  "downloading",
  "processing",
  "awaiting_retry",
  "failed",
];

export interface AcquisitionActions {
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  /** Blocklist the release, optionally searching for another at once. */
  readonly canBlocklist: boolean;
  /** Why an action is unavailable, when saying so is more use than hiding it. */
  readonly cancelBlockedReason?: "already-finished";
}

/**
 * What may be done to an acquisition in this state.
 *
 * Mirrors the server: retry from `failed` only, and never cancel something
 * that has already finished downloading. A cancelled or superseded row is
 * likewise past cancelling.
 */
export function actionsFor(
  state: AcquisitionState,
  failureClass?: AcquisitionFailureClass,
  releaseBlocklisted = false,
): AcquisitionActions {
  const finished = FINISHED.includes(state);
  return {
    // A blocklisted release is refused a retry — from any row that holds it,
    // not only the one it was blocklisted from.
    canRetry:
      state === "failed" &&
      failureClass !== "blocklisted" &&
      !releaseBlocklisted,
    canCancel: !finished,
    canBlocklist: BLOCKLISTABLE.includes(state),
    ...(finished ? { cancelBlockedReason: "already-finished" as const } : {}),
  };
}

/**
 * Whether a failure is worth a person's time, or will resolve on its own.
 *
 * `awaiting_retry` is not a failure — the queue is going to try again — so an
 * acquisition sitting there is reported as active rather than as a problem.
 */
export function isWaitingOnSeyirlik(state: AcquisitionState): boolean {
  return state === "awaiting_retry";
}

/** The order the states run in, for drawing progress honestly. */
export const ACQUISITION_PROGRESSION: readonly AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "downloaded",
];

/**
 * How far along a running acquisition is, as a step rather than a percentage.
 *
 * SABnzbd is polled, so a download can move several steps between two reads
 * and a percentage would imply a precision nobody measured. A step out of a
 * known list says exactly as much as is actually known. Returns null for a
 * state that is not on the path at all.
 */
export function progressStep(
  state: AcquisitionState,
): { step: number; of: number } | null {
  const index = ACQUISITION_PROGRESSION.indexOf(state);
  if (index === -1) return null;
  return { step: index + 1, of: ACQUISITION_PROGRESSION.length };
}

/** The failure classes the acquisition service records. */
export type AcquisitionFailureClass =
  | "indexer-unavailable"
  | "indexer-auth"
  | "nzb-unavailable"
  | "sab-unavailable"
  | "sab-auth"
  | "submission-timeout"
  | "disk-full"
  | "missing-articles"
  | "repair-failed"
  | "unpack-failed"
  | "password-required"
  | "removed-externally"
  | "cancelled"
  | "blocklisted"
  | "unknown";

export type FailureRemedy =
  /** Seyirlik will try this release again by itself. */
  | "waits"
  /** This release will not work; a different one is needed. */
  | "another-release"
  /** Somebody has to change something outside Seyirlik. */
  | "operator";

/**
 * What a failure means for what happens next.
 *
 * The same three-way split the server plans retries by, said in terms of what
 * the person reading it should do — which is the only reason to show a failure
 * class to a human at all.
 */
export function remedyFor(failure: AcquisitionFailureClass): FailureRemedy {
  switch (failure) {
    case "indexer-unavailable":
    case "sab-unavailable":
    case "submission-timeout":
    case "disk-full":
      return "waits";
    case "nzb-unavailable":
    case "missing-articles":
    case "repair-failed":
    case "unpack-failed":
    case "password-required":
    case "blocklisted":
      return "another-release";
    default:
      // Authentication, an external removal, a cancellation, or something
      // unrecognised: none of them get better by waiting.
      return "operator";
  }
}

/**
 * Sizes in decimal gigabytes, the unit the size limit is set in, and in
 * megabytes below one.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
}

/** The parts of a remaining time, for the page to word in its language. */
export function etaParts(
  seconds: number,
): { hours: number; minutes: number } | "underAMinute" {
  if (seconds < 60) return "underAMinute";
  const minutes = Math.round(seconds / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * What a download is for, as a person would name it.
 *
 * The download client knows a job only by an idempotency key, which is right
 * for it and meaningless to anyone reading the queue. This is the name the
 * page leads with: the title, then which episode, season or year.
 */
export function targetLabel(target: {
  readonly kind: string;
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}): {
  title: string;
  /** "S01E03", or the season number alone, or the year. */
  episodeCode?: string;
  season?: number;
  year?: number;
} {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (
    target.kind === "episode" &&
    target.season !== undefined &&
    target.episode !== undefined
  ) {
    return {
      title: target.title,
      episodeCode: `S${pad(target.season)}E${pad(target.episode)}`,
    };
  }
  if (target.kind === "season" && target.season !== undefined) {
    return { title: target.title, season: target.season };
  }
  return {
    title: target.title,
    ...(target.year === undefined ? {} : { year: target.year }),
  };
}

/**
 * Where a drag put one row, as a place in the download client's queue.
 *
 * The list on the page holds only Seyirlik's queued downloads, while the
 * client's queue can hold other jobs between them. So the place is read from
 * the row the dragged one now stands in for: moving onto the slot of the row
 * at index k means taking that row's place in the client's queue, which the
 * client does by removing the moved job and inserting it there.
 *
 * Returns null when the order did not change, or changed by more than one
 * row moving (which a single drag cannot do).
 */
export function queueMoveFor(
  before: readonly { id: string; queuePosition: number }[],
  after: readonly string[],
): { id: string; position: number } | null {
  const ids = before.map((row) => row.id);
  if (ids.length !== after.length) return null;
  if (ids.every((id, index) => id === after[index])) return null;
  for (const id of ids) {
    const from = ids.indexOf(id);
    const to = after.indexOf(id);
    if (from === to) continue;
    const moved = ids.filter((other) => other !== id);
    moved.splice(to, 0, id);
    if (moved.every((other, index) => other === after[index])) {
      return { id, position: before[to]!.queuePosition };
    }
  }
  return null;
}
