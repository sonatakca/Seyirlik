import { useLayoutEffect, useRef, useState, type DependencyList } from "react";
import { frame, frameData } from "framer-motion";
import type { ValueSource } from "./curve";

/** Only what the compositor can play by itself. */
export interface BakedStyle {
  transform?: string;
  opacity?: number;
}

/** Each element's look at one moment. Missing elements are skipped. */
export type BakedFrame = ReadonlyArray<
  readonly [HTMLElement | null | undefined, BakedStyle]
>;

/**
 * Samples per second of a baked journey. The compositor interpolates linearly
 * between them; at this density the hero's fastest lift (about 3,000 px/s at
 * its peak) strays from its curve by under a fifth of a pixel.
 */
const SAMPLES_PER_SECOND = 120;

/**
 * Bakes a component's look into Web Animations.
 *
 * Whenever any source changes course, the look from now until every source has
 * settled is sampled from `render` and handed to each element as one animation,
 * started at the same instant as every other bakery flushed with it. The
 * element's own style is left at where the journey ends, so nothing jumps when
 * the animation finishes or is replaced by the next one, which picks up from
 * the exact value of the moment.
 */
/** An element's baked journey: its animation and the samples it plays. */
interface Playing {
  animation: Animation;
  keyframes: Keyframe[];
  /** When its first sample is, and how many steps it takes to `until`. */
  start: number;
  steps: number;
}

class Bakery {
  constructor(private readonly render: (at: number) => BakedFrame) {}
  private sources: readonly ValueSource[] = [];
  private unsubscribe: Array<() => void> = [];
  private playing = new Map<HTMLElement, Playing>();
  /** When the journeys in `playing` end. */
  private until = 0;

  setSources(sources: readonly ValueSource[]) {
    if (
      sources.length === this.sources.length &&
      sources.every((source, index) => source === this.sources[index])
    ) {
      return;
    }
    this.unsubscribe.forEach((stop) => stop());
    this.sources = sources;
    this.unsubscribe = sources.map((source) =>
      source.subscribe(() => schedule(this)),
    );
  }

  /**
   * `frame` is true for a flush on an animation frame, which pins the start of
   * any tween still waiting for one. A flush outside a frame (a component
   * mounting, or a prop changing) draws where everything stands now; the
   * frame that a waiting tween has asked for bakes its journey.
   */
  flush(now: number, frame: boolean) {
    if (frame) for (const source of this.sources) source.anchor?.(now);
    const until = Math.max(
      0,
      ...this.sources.map((source) => source.settlesAt),
    );
    if (!Number.isFinite(until)) {
      this.stopAll();
      for (const [element, style] of this.render(now)) {
        if (element) applyStyle(element, style);
      }
      return;
    }
    const end = this.render(Math.max(now, until));
    for (const [element, style] of end) {
      if (element) applyStyle(element, style);
    }
    if (until <= now + 1) {
      this.stopAll();
      return;
    }

    /*
     * A re-bake with the same timing is a prop changing mid-flight, usually
     * one that moves a single element (an artwork's size arriving). Every
     * element whose journey comes out the same keeps the animation it is
     * playing. Restarting it would hold its first sample, which is where the
     * journey stood on the main thread's clock, until the timeline reached it,
     * while the compositor had already drawn it further on: a frame back and
     * then a leap forward.
     */
    const kept = new Map<HTMLElement, Playing>();
    if (until === this.until) {
      const schedules = new Map<string, Map<HTMLElement, Keyframe[]>>();
      for (const [element, playing] of this.playing) {
        const key = `${playing.start}:${playing.steps}`;
        let again = schedules.get(key);
        if (!again) {
          again = this.sample(playing.start, until, playing.steps);
          schedules.set(key, again);
        }
        if (sameKeyframes(again.get(element), playing.keyframes)) {
          kept.set(element, playing);
        }
      }
    }
    for (const [element, playing] of this.playing) {
      if (!kept.has(element)) playing.animation.cancel();
    }
    this.playing = kept;
    this.until = until;

    const duration = until - now;
    const steps = Math.max(
      2,
      Math.ceil((duration / 1000) * SAMPLES_PER_SECOND),
    );
    for (const [element, keyframes] of this.sample(now, until, steps)) {
      if (
        kept.has(element) ||
        typeof element.animate !== "function" ||
        isStill(keyframes)
      ) {
        continue;
      }
      const animation = element.animate(keyframes, {
        duration,
        easing: "linear",
        // `now` is usually a few ms ahead of the document timeline: framer
        // stamps its frame with performance.now(), past the frame's own time,
        // and a flush between frames is later still. Until the timeline
        // reaches it the animation has not begun, and without a backwards
        // fill the element would be drawn at its own style — the journey's
        // end — for that frame: a title flashing at full size before it
        // rises, or jumping ahead mid-flight when a re-bake lands.
        fill: "backwards",
      });
      // Started at the frame it was computed for, so every element baked
      // together moves on one clock, and what the sources report mid-flight
      // matches what is on screen.
      animation.startTime = now;
      this.playing.set(element, { animation, keyframes, start: now, steps });
    }
  }

  /** Each element's look at `steps + 1` even moments from `start` to `until`. */
  private sample(start: number, until: number, steps: number) {
    const frames = new Map<HTMLElement, Keyframe[]>();
    for (let step = 0; step <= steps; step += 1) {
      const offset = step / steps;
      for (const [element, style] of this.render(
        start + (until - start) * offset,
      )) {
        if (!element) continue;
        let list = frames.get(element);
        if (!list) {
          list = [];
          frames.set(element, list);
        }
        list.push({ ...style, offset });
      }
    }
    return frames;
  }

  private stopAll() {
    for (const { animation } of this.playing.values()) animation.cancel();
    this.playing.clear();
    this.until = 0;
  }

  dispose() {
    this.unsubscribe.forEach((stop) => stop());
    this.unsubscribe = [];
    this.sources = [];
    this.stopAll();
    dirty.delete(this);
  }
}

function applyStyle(element: HTMLElement, style: BakedStyle) {
  if (style.transform !== undefined) element.style.transform = style.transform;
  if (style.opacity !== undefined) {
    element.style.opacity = String(style.opacity);
  }
}

function sameKeyframes(
  next: Keyframe[] | undefined,
  previous: Keyframe[],
): boolean {
  return (
    next !== undefined &&
    next.length === previous.length &&
    next.every(
      (frame, index) =>
        frame.transform === previous[index].transform &&
        frame.opacity === previous[index].opacity,
    )
  );
}

function isStill(keyframes: Keyframe[]) {
  const first = keyframes[0];
  return keyframes.every(
    (frame) =>
      frame.transform === first?.transform && frame.opacity === first?.opacity,
  );
}

// Bakeries whose sources changed, flushed together on framer-motion's next
// frame with its timestamp, so a choreography that sets off a dozen values at
// once starts as one, on the clock framer-motion's own animations start on.
const dirty = new Set<Bakery>();
let isScheduled = false;

function schedule(bakery: Bakery) {
  dirty.add(bakery);
  if (isScheduled) return;
  isScheduled = true;
  frame.update(() => {
    isScheduled = false;
    const pending = [...dirty];
    dirty.clear();
    for (const each of pending) each.flush(frameData.timestamp, true);
  });
}

/**
 * Keeps elements' transform and opacity baked from `sources` by `render`.
 *
 * `render` is read on every flush, so it may close over props; `deps` lists
 * the props that change the look without any source moving (a new stage size,
 * a different element), which re-bake at once, before paint.
 */
export function useBake(
  sources: readonly ValueSource[],
  render: (at: number) => BakedFrame,
  deps: DependencyList,
) {
  // The latest render, for flushes that come between commits.
  const renderRef = useRef(render);
  useLayoutEffect(() => {
    renderRef.current = render;
  });
  const [bakery] = useState(() => new Bakery((at) => renderRef.current(at)));

  useLayoutEffect(() => {
    bakery.setSources(sources);
    bakery.flush(performance.now(), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bakery, ...sources, ...deps]);

  useLayoutEffect(() => () => bakery.dispose(), [bakery]);
}
