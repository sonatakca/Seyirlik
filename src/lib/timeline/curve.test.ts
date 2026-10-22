import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Curve, cubicBezier, derive, toEase } from "./curve";

describe("eases", () => {
  it("are the CSS curves they are named for", () => {
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(toEase("linear")(0.3)).toBeCloseTo(0.3);
    expect(toEase("easeOut")(0)).toBe(0);
    expect(toEase("easeOut")(1)).toBe(1);
    expect(toEase([0.37, 0, 0.63, 1])(0.5)).toBeCloseTo(0.5, 5);
  });
});

describe("Curve", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "performance",
        "requestAnimationFrame",
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("knows its value at every moment of a tween, and lands", async () => {
    const curve = new Curve(0);
    const { finished } = curve.tween(100, { duration: 1, ease: "linear" });
    const start = performance.now();
    // Waiting for its first frame, it has not set off.
    expect(curve.get(start + 250)).toBe(0);
    expect(curve.settlesAt).toBe(Infinity);
    curve.anchor(start);
    expect(curve.get(start + 250)).toBeCloseTo(25);
    expect(curve.settlesAt).toBeCloseTo(start + 1000);

    vi.advanceTimersByTime(1000);
    await finished;
    expect(curve.get()).toBe(100);
    expect(curve.settlesAt).toBe(0);
  });

  it("holds its start through a delay", () => {
    const curve = new Curve(10);
    curve.tween(20, { duration: 1, delay: 0.5, ease: "linear" });
    const start = performance.now();
    curve.anchor(start);
    expect(curve.get(start + 400)).toBe(10);
    expect(curve.get(start + 1000)).toBeCloseTo(15);
  });

  it("sets off again from where it really is when redirected", () => {
    const curve = new Curve(0);
    curve.tween(100, { duration: 1, ease: "linear" });
    curve.anchor(performance.now());
    vi.advanceTimersByTime(400);
    curve.tween(0, { duration: 1, ease: "linear" });
    expect(curve.get()).toBeCloseTo(40);
  });

  it("sets off on its own first frame when nothing bakes it", async () => {
    // framer-motion's frame loop holds the real requestAnimationFrame, so
    // this one runs on real time.
    vi.useRealTimers();
    const curve = new Curve(0);
    const { finished } = curve.tween(1, { duration: 0.1, ease: "linear" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(curve.settlesAt).not.toBe(Infinity);
    await finished;
    expect(curve.get()).toBe(1);
  });

  it("settles a replaced tween's promise and tells subscribers", async () => {
    const curve = new Curve(0);
    const listener = vi.fn();
    curve.subscribe(listener);
    const first = curve.tween(1, { duration: 1 });
    curve.set(5);
    await first.finished;
    expect(curve.get()).toBe(5);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("derives values at any moment from its sources", () => {
    const a = new Curve(0);
    const derived = derive([a], (value) => value * 2);
    a.tween(10, { duration: 1, ease: "linear" });
    derived.anchor?.(performance.now());
    expect(derived.get(performance.now() + 500)).toBeCloseTo(10);
    expect(derived.settlesAt).toBe(a.settlesAt);
  });
});
