import { describe, expect, it } from "vitest";

import {
  DIM_ALPHA,
  QUALITY_TOAST_TIMING,
  RESTING_SCALE,
  classifyQualityChange,
  glowAt,
  swapFrameAt,
  type LinePaint,
} from "./qualityToastModel";

const q720 = { id: "720", height: 720, hdr: false };
const q1080 = { id: "1080", height: 1080, hdr: false };
const q1080hdr = { id: "1080-hdr", height: 1080, hdr: true };

/** Every alpha in a line's gradient, in order from its top. */
const alphas = (paint: LinePaint) =>
  [...paint.backgroundImage.matchAll(/rgba\(255,255,255,([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );

describe("classifyQualityChange", () => {
  it("names the first quality of a title a start", () => {
    expect(classifyQualityChange(null, q1080)).toBe("start");
  });

  it("reads direction from the rung's class", () => {
    expect(classifyQualityChange(q720, q1080)).toBe("up");
    expect(classifyQualityChange(q1080, q720)).toBe("down");
  });

  it("counts gaining or losing HDR at the same height as a change", () => {
    expect(classifyQualityChange(q1080, q1080hdr)).toBe("up");
    expect(classifyQualityChange(q1080hdr, q1080)).toBe("down");
  });

  it("stays quiet when nothing a viewer could read has changed", () => {
    expect(
      classifyQualityChange(q1080, {
        id: "other-1080",
        height: 1080,
        hdr: false,
      }),
    ).toBeNull();
  });
});

describe("glowAt", () => {
  it("falls off smoothly from its centre with no flat plateau beyond the core", () => {
    expect(glowAt(0)).toBe(1);
    expect(glowAt(-6)).toBeCloseTo(glowAt(6));
    for (let d = 3; d < 20; d += 1) {
      expect(glowAt(d + 1)).toBeLessThan(glowAt(d));
    }
    expect(glowAt(20)).toBe(0);
  });
});

describe("swapFrameAt", () => {
  const { swapMs } = QUALITY_TOAST_TIMING;

  it("before an upgrade, lights only the playing value at the bottom", () => {
    const frame = swapFrameAt("up", -swapMs);
    expect(new Set(alphas(frame.bottom))).toEqual(new Set([1]));
    expect(new Set(alphas(frame.top))).toEqual(new Set([DIM_ALPHA]));
    expect(frame.top.scale).toBeCloseTo(RESTING_SCALE);
    expect(frame.bottom.scale).toBe(1);
    expect(frame.arrowOutY).toBeCloseTo(0, 0);
  });

  it("after an upgrade, the new value on top is the lit one and the old one rests", () => {
    const frame = swapFrameAt("up", swapMs + 50);
    expect(new Set(alphas(frame.top))).toEqual(new Set([1]));
    expect(new Set(alphas(frame.bottom))).toEqual(new Set([DIM_ALPHA]));
    expect(frame.top.scale).toBeCloseTo(1);
    expect(frame.bottom.scale).toBeCloseTo(RESTING_SCALE);
    // The arrow left upwards and its replacement settled in the ring.
    expect(frame.arrowOutY).toBeCloseTo(-20);
    expect(frame.arrowInY).toBeCloseTo(0);
  });

  it("a downgrade travels the other way: from the top value to the bottom one", () => {
    const before = swapFrameAt("down", -swapMs);
    const after = swapFrameAt("down", swapMs + 50);
    expect(new Set(alphas(before.top))).toEqual(new Set([1]));
    expect(new Set(alphas(after.bottom))).toEqual(new Set([1]));
    expect(new Set(alphas(after.top))).toEqual(new Set([DIM_ALPHA]));
    expect(after.arrowOutY).toBeCloseTo(20);
  });

  it("mid-swap, the light is a gradient inside the text rather than a flat colour", () => {
    const frame = swapFrameAt("up", swapMs / 2);
    const top = alphas(frame.top);
    expect(Math.max(...top) - Math.min(...top)).toBeGreaterThan(0.2);
    // No neighbouring pixels jump: the band has no edge to see.
    for (let i = 1; i < top.length; i += 1) {
      expect(Math.abs(top[i] - top[i - 1])).toBeLessThan(0.12);
    }
  });

  it("never steps when the light hands over between the lines", () => {
    let previous = swapFrameAt("up", 0);
    for (let ms = 10; ms <= swapMs; ms += 10) {
      const frame = swapFrameAt("up", ms);
      const now = [...alphas(frame.top), ...alphas(frame.bottom)];
      const before = [...alphas(previous.top), ...alphas(previous.bottom)];
      now.forEach((alpha, i) => {
        expect(Math.abs(alpha - before[i])).toBeLessThan(0.15);
      });
      previous = frame;
    }
  });
});
