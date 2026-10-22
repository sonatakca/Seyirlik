import type { PartySnapshot } from "./partyWatchTypes";

/**
 * How a player follows the group: pure decisions, tuned in one place.
 *
 * The values are chosen for people watching the same film in different rooms,
 * usually talking over a call that itself lags 150–300 ms. What matters is
 * being on the same scene at the same time; a fraction of a second apart is
 * indistinguishable, while a visible correction — the picture pausing to seek
 * and wait — is not. So small drift is left alone, moderate drift (up to a
 * few seconds) is closed by running a few percent fast or slow (pitch is
 * preserved, and nobody hears dialogue at 1.05×), and only drift too large to
 * close that way is seeked.
 */
export const PARTY_SYNC_TUNING = {
  /**
   * Drift at which a player starts correcting. Below it, nothing happens. Set
   * well above the error of the clock estimate (tens of milliseconds on a
   * normal connection) and the jitter of `currentTime` while HLS buffers, so
   * a correction always answers a real difference.
   */
  nudgeStartMs: 350,
  /**
   * A correction stops once the player is back within this. The gap to
   * `nudgeStartMs` is deliberate: without it, a player hovering at the
   * threshold would switch rate on every tick.
   */
  nudgeStopMs: 120,
  /** The largest rate change: 1 s of drift closes in 20 s, 3 s in a minute. */
  maxRateDelta: 0.05,
  /** The smallest, so 250 ms does not take a minute to close. */
  minRateDelta: 0.02,
  /** Drift at which the rate change reaches its largest. */
  fullRateDriftMs: 2_500,
  /**
   * A rate correction that lets drift grow by more than this has not slowed
   * or sped the player up — it has stalled it. Some players (HLS in Safari)
   * freeze at any rate but 1×, so a 2% nudge became a second lost per second
   * and a catch-up seek every two. Such a player stops using rate for the
   * rest of the party and only seeks past `seekThresholdMs`.
   */
  rateFailureMarginMs: 250,
  /**
   * Beyond this a rate change would take too long; the player seeks. A seek
   * while the group plays means pausing, landing ahead and waiting — a visible
   * freeze — and right after a group seek the first measurements can read a
   * second or more off while the stream refills, so a low threshold here
   * turned every seek into a run of freeze-and-continue catch-ups. Three
   * seconds apart is still the same scene.
   */
  seekThresholdMs: 3_000,
  /**
   * When the group is paused or holding, a player further than this from the
   * group's position moves to it, so everyone is looking at the same frame.
   * A remote pause arrives one network trip after the pauser's, so without
   * this each player would stop a few frames past it. Nearer than this, the
   * difference is a frame or two and not worth a visible step. A player that
   * has not started yet while the group plays lands on it to the same
   * tolerance, since there is no moving picture for a seek to interrupt.
   */
  pausedSnapToleranceMs: 100,
  /**
   * How long an element takes from `play()` to actually moving, before it has
   * been measured; each player then learns its own. Scheduled starts and
   * catch-ups call `play()` this much early so the picture moves on time.
   */
  initialPlayStartMs: 40,
  /** A start slower than this is a stall, not a measure of start latency. */
  maxPlayStartMs: 400,
  /**
   * Stalled mid-playback for longer than this, a player asks the group to wait.
   * Shorter stalls — segment boundaries, a brief dip — it absorbs on its own
   * and the rate correction recovers.
   */
  stallGraceMs: 1_200,
  /**
   * Right after a seek, `currentTime` is not yet trustworthy for drift: the
   * stream is refilling and playback start lags. Drift is not acted on until
   * this long after one.
   */
  postSeekSettleMs: 2_000,
  /**
   * Catching up to a group that is moving: land this much ahead of it, wait for
   * it to arrive, then play. Aiming at where the group *is* would arrive late by
   * however long the seek took, and seek again — a chase that a slow connection
   * never wins. The lead is learned from how long seeks actually take here.
   */
  catchUpLeadFactor: 1.5,
  catchUpLeadMinMs: 600,
  catchUpLeadMaxMs: 6_000,
  /** What a seek is assumed to cost before one has been measured. */
  initialSeekCostMs: 1_200,
  /**
   * Some browsers do not buffer ahead while paused, so a paused player can sit
   * at "current frame only" indefinitely. After this long it counts as ready.
   */
  pausedReadyGraceMs: 1_500,
  /**
   * The player paused without being asked while the group plays (a headset
   * unplugged, an OS interruption). After this long the viewer is offered a
   * way back, instead of being yanked back or dragging the group with them.
   */
  unexpectedPauseNoticeMs: 1_500,
  /** Scrubbing: the first seek is sent at once, then at most one per window. */
  seekCoalesceMs: 300,
  /** How often a playing player measures its drift. */
  loopIntervalMs: 250,
  /**
   * The group is treated as having reached the end once its position is this
   * close to the media's duration.
   */
  endToleranceMs: 500,
} as const;

export type PartySyncTuning = typeof PARTY_SYNC_TUNING;

export interface GroupTarget {
  /** The group is (or is scheduled to be) playing, not paused or holding. */
  advancing: boolean;
  positionMs: number;
  /** How long until a scheduled start; 0 once it has passed. */
  startsInMs: number;
}

/** Where the group wants this player to be at server time `serverNow`. */
export function groupTarget(
  snapshot: Pick<PartySnapshot, "intent" | "hold" | "positionMs" | "anchorMs">,
  serverNow: number,
): GroupTarget {
  const advancing = snapshot.intent === "playing" && snapshot.hold === null;
  if (!advancing) {
    return { advancing, positionMs: snapshot.positionMs, startsInMs: 0 };
  }
  const elapsed = serverNow - snapshot.anchorMs;
  return {
    advancing,
    positionMs: snapshot.positionMs + Math.max(0, elapsed),
    startsInMs: Math.max(0, -elapsed),
  };
}

export type DriftCorrection =
  | { kind: "none" }
  | { kind: "rate"; rate: number }
  | { kind: "seek" };

/**
 * What to do about `driftMs` (positive: this player is ahead). `correcting`
 * says whether a rate correction is already under way, which is what gives the
 * decision its hysteresis.
 */
export function driftCorrection(
  driftMs: number,
  correcting: boolean,
  tuning: PartySyncTuning = PARTY_SYNC_TUNING,
): DriftCorrection {
  const magnitude = Math.abs(driftMs);
  if (magnitude >= tuning.seekThresholdMs) return { kind: "seek" };
  const threshold = correcting ? tuning.nudgeStopMs : tuning.nudgeStartMs;
  if (magnitude <= threshold) return { kind: "none" };

  const delta = Math.min(
    tuning.maxRateDelta,
    Math.max(
      tuning.minRateDelta,
      (magnitude / tuning.fullRateDriftMs) * tuning.maxRateDelta,
    ),
  );
  // Ahead runs slow, behind runs fast.
  return { kind: "rate", rate: driftMs > 0 ? 1 - delta : 1 + delta };
}

/** How far ahead of a moving group to land when catching up. */
export function catchUpLeadMs(
  seekCostMs: number,
  tuning: PartySyncTuning = PARTY_SYNC_TUNING,
): number {
  return Math.min(
    tuning.catchUpLeadMaxMs,
    Math.max(tuning.catchUpLeadMinMs, seekCostMs * tuning.catchUpLeadFactor),
  );
}

/** Folds a measured seek into the running estimate of what seeks cost. */
export function nextSeekCostMs(previousMs: number, measuredMs: number): number {
  // Weighted towards the newest measurement, because conditions change —
  // but not entirely, so one unusually slow seek does not overcorrect.
  return Math.round(previousMs * 0.4 + measuredMs * 0.6);
}
