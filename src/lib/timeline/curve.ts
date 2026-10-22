/**
 * Values that know where they are going.
 *
 * A Curve holds a number and, while it tweens, the whole tween: where it set
 * off from, where it lands, when, and on what ease. Its value at any moment is
 * therefore a formula rather than something written every frame, so whatever
 * depends on it can be baked into a Web Animation up front (see `bake.ts`) and
 * left to the compositor, which plays it at the display's full rate however
 * busy the page is. `get()` is exact mid-flight, so a journey can be redirected
 * from where it really is.
 *
 * A tween sets off on framer-motion's next frame, with that frame's timestamp,
 * as framer-motion's own animations do, so baked elements and framer-driven
 * ones that start together move together. Its start is pinned (`anchor`) by
 * the first of the bakery's flush and its own frame callback.
 *
 * It replaces framer-motion's MotionValue + animate() where a component's look
 * is derived from values: framer-motion writes those derivations inline on
 * every frame, which Safari holds to 60 fps and which stalls with the page.
 */

import { frame, frameData } from "framer-motion";

export type Ease = (progress: number) => number;

/** A cubic-bezier, or one of framer-motion's named curves. */
export type EaseSpec =
  | readonly [number, number, number, number]
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut";

/** A CSS cubic-bezier(x1, y1, x2, y2) timing function. */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Ease {
  // The curve's coefficients, so a point and a slope are a few multiplies.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xAt = (t: number) => ((ax * t + bx) * t + cx) * t;
  const yAt = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeAt = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton's method from x itself; bisection only where the slope is flat.
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = xAt(t) - x;
      if (Math.abs(error) < 1e-7) return yAt(t);
      const slope = slopeAt(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 40; i += 1) {
      const value = xAt(t);
      if (Math.abs(value - x) < 1e-7) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return yAt(t);
  };
}

const linear: Ease = (x) => Math.min(1, Math.max(0, x));
// framer-motion's named eases, as the cubic-beziers it defines them by.
const NAMED: Record<Exclude<EaseSpec, readonly number[]>, Ease> = {
  linear,
  easeIn: cubicBezier(0.42, 0, 1, 1),
  easeOut: cubicBezier(0, 0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
};

const beziers = new Map<string, Ease>();

export function toEase(spec: EaseSpec = "easeOut"): Ease {
  if (typeof spec === "string") return NAMED[spec];
  const key = spec.join(",");
  let ease = beziers.get(key);
  if (!ease) {
    ease = cubicBezier(...spec);
    beziers.set(key, ease);
  }
  return ease;
}

/** Anything a baked style can be computed from: a value over time. */
export interface ValueSource {
  /** The value at `at` (a performance.now() time), default now. */
  get(at?: number): number;
  /**
   * When it stops changing, as a performance.now() time; 0 once at rest, and
   * Infinity while a tween waits for its first frame.
   */
  readonly settlesAt: number;
  /** Pins a waiting tween's start to `time` (a frame's timestamp). */
  anchor?(time: number): void;
  /** Called whenever its course changes: a set, a new tween, a stop. */
  subscribe(listener: () => void): () => void;
}

export interface TweenOptions {
  /** Seconds. */
  duration: number;
  /** Seconds. */
  delay?: number;
  ease?: EaseSpec;
}

export interface TweenControls {
  stop(): void;
  /** Settles when the tween lands, or is stopped or replaced. */
  readonly finished: Promise<void>;
}

interface Tween {
  from: number;
  to: number;
  delayMs: number;
  durationMs: number;
  /** null until the first frame pins it. */
  startsAt: number | null;
  ease: Ease;
  timer: number;
  settle: () => void;
}

export class Curve implements ValueSource {
  private value: number;
  private tweenState: Tween | null = null;
  private listeners = new Set<() => void>();

  constructor(value: number) {
    this.value = value;
  }

  get(at: number = performance.now()): number {
    const tween = this.tweenState;
    if (!tween) return this.value;
    if (tween.startsAt === null || at <= tween.startsAt) return tween.from;
    const endsAt = tween.startsAt + tween.durationMs;
    if (at >= endsAt) return tween.to;
    const progress = (at - tween.startsAt) / tween.durationMs;
    return tween.from + (tween.to - tween.from) * tween.ease(progress);
  }

  get settlesAt(): number {
    const tween = this.tweenState;
    if (!tween) return 0;
    if (tween.startsAt === null) return Infinity;
    return tween.startsAt + tween.durationMs;
  }

  anchor(time: number): void {
    const tween = this.tweenState;
    if (!tween || tween.startsAt !== null) return;
    tween.startsAt = time + tween.delayMs;
    const endsAt = tween.startsAt + tween.durationMs;
    tween.timer = window.setTimeout(
      () => {
        if (this.tweenState !== tween) return;
        this.tweenState = null;
        this.value = tween.to;
        tween.settle();
      },
      Math.max(0, endsAt - performance.now()),
    );
  }

  /** Jumps to `value`, ending any tween. */
  set(value: number): void {
    if (!this.tweenState && this.value === value) return;
    this.end(value);
    this.notify();
  }

  /** Holds where it is now. */
  stop(): void {
    if (!this.tweenState) return;
    this.end(this.get());
    this.notify();
  }

  /** Travels from where it is now to `to`. */
  tween(to: number, options: TweenOptions): TweenControls {
    const now = performance.now();
    const from = this.get(now);
    const delayMs = Math.max(0, (options.delay ?? 0) * 1000);
    const durationMs = Math.max(0, options.duration * 1000);
    if (durationMs === 0 && delayMs === 0) {
      this.set(to);
      return { stop() {}, finished: Promise.resolve() };
    }
    this.end(from);
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const tween: Tween = {
      from,
      to,
      delayMs,
      durationMs,
      startsAt: null,
      ease: durationMs === 0 ? () => 1 : toEase(options.ease),
      timer: 0,
      settle,
    };
    this.tweenState = tween;
    // Pinned by the bakery's frame when one bakes this value; this is the
    // fallback for a value nothing bakes, so its tween still runs and lands.
    frame.update(() => this.anchor(frameData.timestamp));
    this.notify();
    return {
      stop: () => {
        if (this.tweenState === tween) this.stop();
      },
      finished,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private end(value: number) {
    const tween = this.tweenState;
    this.tweenState = null;
    this.value = value;
    if (tween) {
      window.clearTimeout(tween.timer);
      tween.settle();
    }
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

/** A value computed from others, at every moment they are known for. */
export function derive(
  sources: readonly ValueSource[],
  compute: (...values: number[]) => number,
): ValueSource {
  return {
    anchor: (time) => sources.forEach((source) => source.anchor?.(time)),
    get: (at = performance.now()) =>
      compute(...sources.map((source) => source.get(at))),
    get settlesAt() {
      return Math.max(0, ...sources.map((source) => source.settlesAt));
    },
    subscribe: (listener) => {
      const stops = sources.map((source) => source.subscribe(listener));
      return () => stops.forEach((stop) => stop());
    },
  };
}

/** A value that never changes. */
export function constant(value: number): ValueSource {
  return { get: () => value, settlesAt: 0, subscribe: () => () => {} };
}
