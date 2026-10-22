import { describe, expect, it } from "vitest";
import {
  beamTransform,
  cubicBezier,
  edgesAt,
  flightKeyframes,
  lampTransform,
  type Flight,
} from "./tabBeam";

describe("cubicBezier", () => {
  it("matches the curve's ends and a known midpoint", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0)).toBe(0);
    expect(linear(1)).toBe(1);
    expect(linear(0.37)).toBeCloseTo(0.37, 4);

    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    // CSS `ease` at half time is about 0.8024.
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
  });
});

describe("beam flights", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  const flight: Flight = {
    from: [4, 84],
    to: [164, 244],
    durations: [0.48, 0.36],
    startedAt: 0,
  };

  it("leads with one edge and gathers on arrival", () => {
    const [left, right] = edgesAt(flight, 0.18, linear);
    expect(right - left).toBeGreaterThan(80);
    expect(edgesAt(flight, 0.48, linear)).toEqual([164, 244]);
  });

  it("starts and ends its keyframes exactly on the two rests", () => {
    const frames = flightKeyframes(flight, 80, linear);
    expect(frames.durationMs).toBeCloseTo(480);
    expect(frames.beam[0]).toEqual({ transform: beamTransform([4, 84], 80) });
    expect(frames.beam.at(-1)).toEqual({
      transform: beamTransform([164, 244], 80),
    });
    expect(frames.lamp.at(-1)).toEqual({
      transform: lampTransform([164, 244], 80),
    });
  });

  it("keeps the lamp its own width while the beam stretches", () => {
    expect(beamTransform([0, 120], 80)).toBe("translateX(0px) scaleX(1.5)");
    expect(lampTransform([0, 120], 80)).toBe(
      `translateX(-50%) scaleX(${80 / 120})`,
    );
  });
});
