/**
 * Precision on the seek bar.
 *
 * A pointer cannot land between pixels, and a two-hour film on a 1250 px bar
 * puts six seconds under each one, so the time under the pointer could only
 * ever move in six-second steps. Here a slow movement counts for less: at a
 * nudge each pixel is one second, rising to the bar's own scale as the
 * pointer speeds up, and a fast sweep follows the pointer exactly.
 *
 * The time this gives is never more than {@link FINE_SEEK_REACH_PX} from the
 * pointer, so what the bar shows stays where the viewer is pointing.
 */

/** Seconds per pixel at the slowest movement. */
export const FINE_SEEK_SECONDS_PER_PX = 1;
/** Below this the pointer is being nudged and gets the finest step. */
const FINE_SEEK_SLOW_PX_PER_S = 40;
/** From here the pointer is sweeping, and the time is simply under it. */
const FINE_SEEK_FAST_PX_PER_S = 220;
/** How far the time may sit from the pointer, in pixels either way. */
export const FINE_SEEK_REACH_PX = 12;
/**
 * Speed is measured over this much movement rather than event to event: at
 * 120 Hz a one-pixel nudge is 120 px/s from one event to the next.
 */
const FINE_SEEK_SPEED_WINDOW_MS = 120;
/** A first event after a pause is not taken as an instant. */
const FINE_SEEK_MIN_SPAN_MS = 16;

interface FineSeekSample {
  position: number;
  at: number;
}

export interface FineSeekState {
  /** Pointer position along the bar, in pixels from where time starts. */
  position: number;
  seconds: number;
  samples: FineSeekSample[];
}

export interface FineSeekInput {
  position: number;
  /** Timestamp of the event, in milliseconds. */
  at: number;
  /** The bar's own scale: duration over its length. */
  secondsPerPx: number;
  duration: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function stepFineSeek(
  previous: FineSeekState | null,
  { position, at, secondsPerPx, duration }: FineSeekInput,
): FineSeekState {
  const absolute = clamp(position * secondsPerPx, 0, duration);
  const sample = { position, at };

  if (
    !previous ||
    !Number.isFinite(secondsPerPx) ||
    secondsPerPx <= FINE_SEEK_SECONDS_PER_PX
  ) {
    return { position, seconds: absolute, samples: [sample] };
  }

  // Keep the movement inside the window, and the last sample before it, so a
  // pause followed by a move still has something to measure from.
  const recent = previous.samples.filter(
    (entry) => at - entry.at <= FINE_SEEK_SPEED_WINDOW_MS,
  );
  const anchor =
    recent.length < previous.samples.length
      ? previous.samples[previous.samples.length - recent.length - 1]
      : undefined;
  const samples = [...(anchor ? [anchor] : []), ...recent, sample];
  const from = samples[0];
  const speed =
    (Math.abs(position - from.position) /
      Math.max(at - from.at, FINE_SEEK_MIN_SPAN_MS)) *
    1_000;

  let seconds: number;
  if (speed >= FINE_SEEK_FAST_PX_PER_S) {
    seconds = absolute;
  } else {
    const blend = clamp(
      (speed - FINE_SEEK_SLOW_PX_PER_S) /
        (FINE_SEEK_FAST_PX_PER_S - FINE_SEEK_SLOW_PX_PER_S),
      0,
      1,
    );
    const rate =
      FINE_SEEK_SECONDS_PER_PX +
      blend * (secondsPerPx - FINE_SEEK_SECONDS_PER_PX);
    const reach = FINE_SEEK_REACH_PX * secondsPerPx;
    seconds = clamp(
      previous.seconds + (position - previous.position) * rate,
      absolute - reach,
      absolute + reach,
    );
  }

  return {
    position,
    seconds: clamp(seconds, 0, duration),
    // Only what the next speed reading can need.
    samples: samples.slice(-12),
  };
}
