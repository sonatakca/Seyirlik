/**
 * The tab bar's beam, moved by the compositor.
 *
 * A journey sends the beam's two edges on their own curves — the edge on the
 * side it heads for leaves first, the other follows — so it stretches along
 * its path and gathers itself on arrival. Every slot is the same width, so the
 * beam can keep one width and draw that stretch as a scaleX, with its place
 * as a translateX. Both edges' curves are sampled into the keyframes of one
 * Web Animation, finely enough that the linear steps between them are below a
 * pixel, and the compositor plays it at the display's full rate. Animating
 * the edges as values used to re-lay the beam out on the main thread every
 * frame.
 *
 * The beam's contents are all sized in fractions of its width, so the scale
 * draws them exactly as the old width did — except the lamp, a fixed 24px,
 * which is given the inverse scale.
 */

export type Edges = readonly [left: number, right: number];

export interface Flight {
  from: Edges;
  to: Edges;
  /** Seconds each edge takes. */
  durations: Edges;
  startedAt: number;
}

export { cubicBezier } from "../../../lib/timeline/curve";

export function edgesAt(
  flight: Flight,
  elapsedS: number,
  ease: (x: number) => number,
): Edges {
  const edge = (i: 0 | 1) =>
    flight.from[i] +
    (flight.to[i] - flight.from[i]) *
      ease(Math.min(1, elapsedS / flight.durations[i]));
  return [edge(0), edge(1)];
}

export function beamTransform([left, right]: Edges, slot: number): string {
  return `translateX(${left}px) scaleX(${(right - left) / slot})`;
}

export function lampTransform([left, right]: Edges, slot: number): string {
  return `translateX(-50%) scaleX(${slot / (right - left)})`;
}

/** Keyframes for the whole flight, sampled at about 240 a second. */
export function flightKeyframes(
  flight: Flight,
  slot: number,
  ease: (x: number) => number,
) {
  const total = Math.max(...flight.durations);
  const steps = Math.max(2, Math.ceil(total * 240));
  const beam: Keyframe[] = [];
  const lamp: Keyframe[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const edges = edgesAt(flight, (total * i) / steps, ease);
    beam.push({ transform: beamTransform(edges, slot) });
    lamp.push({ transform: lampTransform(edges, slot) });
  }
  return { beam, lamp, durationMs: total * 1000 };
}
