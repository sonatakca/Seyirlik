import { describe, expect, it } from "vitest";
import { getEncodingPolicy } from "../encoding";
import {
  chooseRungRates,
  encoderTakesTargetRate,
  poolVmafScores,
  qualityPasses,
  sampleWindows,
} from "./rateProbe";

const LADDER = [
  { qualityHeight: 1080 },
  { qualityHeight: 720 },
  { qualityHeight: 480 },
  { qualityHeight: 360 },
];

/** A rung whose quality crosses the bar at `threshold` of the table rate. */
function rungThatNeeds(threshold: number) {
  return (factor: number) =>
    factor >= threshold ? { mean: 96, p5: 92 } : { mean: 93, p5: 85 };
}

describe("chooseRungRates", () => {
  it("takes the lowest fraction that still meets the bar", async () => {
    const asked: number[] = [];
    const { rates } = await chooseRungRates({
      outputs: [{ qualityHeight: 1080 }],
      codecFamily: "h264",
      measure: async (_, factor) => {
        asked.push(factor);
        return rungThatNeeds(0.7)(factor);
      },
    });
    expect(rates[1080]!.factor).toBe(0.7);
    expect(rates[1080]!.target).toBe(Math.round(5_500_000 * 0.7));
    // Binary search: never more than three of the four candidates.
    expect(asked.length).toBeLessThanOrEqual(3);
  });

  /*
   * Ezel: a 2 Mbps 1080p source that scored 88 at its own rate and needed
   * the full table rate. A rung no fraction satisfies keeps the table.
   */
  it("keeps the table rate when no fraction qualifies", async () => {
    const { rates } = await chooseRungRates({
      outputs: [{ qualityHeight: 1080 }],
      codecFamily: "h264",
      measure: async () => ({ mean: 97, p5: 80 }),
    });
    const policy = getEncodingPolicy(1080, "h264");
    expect(rates[1080]).toEqual({
      target: policy.expectedVideoBitrate,
      max: policy.maxVideoBitrate,
      factor: 1,
    });
  });

  it("never measures the small rungs", async () => {
    const measured: number[] = [];
    await chooseRungRates({
      outputs: LADDER,
      codecFamily: "h264",
      measure: async (index, factor) => {
        measured.push(LADDER[index]!.qualityHeight);
        return rungThatNeeds(0.4)(factor);
      },
    });
    expect(new Set(measured)).toEqual(new Set([1080, 720]));
  });

  it("keeps every rung below the one above it", async () => {
    // 1080p qualifies at 0.4 (2.2 Mbps); 720p at the table's 3.0 would outrank it.
    const { rates } = await chooseRungRates({
      outputs: LADDER,
      codecFamily: "h264",
      measure: async (index, factor) =>
        LADDER[index]!.qualityHeight === 1080
          ? rungThatNeeds(0.4)(factor)
          : { mean: 90, p5: 80 },
    });
    const targets = LADDER.map((rung) => rates[rung.qualityHeight]!.target);
    for (let index = 1; index < targets.length; index += 1) {
      expect(targets[index]).toBeLessThan(targets[index - 1]!);
    }
  });

  it("keeps the cap above the target in the table's proportion", async () => {
    const { rates } = await chooseRungRates({
      outputs: [{ qualityHeight: 1080 }],
      codecFamily: "h264",
      measure: async (_, factor) => rungThatNeeds(0.55)(factor),
    });
    const policy = getEncodingPolicy(1080, "h264");
    const rate = rates[1080]!;
    expect(rate.max).toBeGreaterThan(rate.target);
    expect(rate.max / rate.target).toBeCloseTo(
      policy.maxVideoBitrate / policy.expectedVideoBitrate,
      3,
    );
  });

  it("never exceeds the table rate", async () => {
    const { rates } = await chooseRungRates({
      outputs: LADDER,
      codecFamily: "hevc",
      measure: async () => ({ mean: 99, p5: 98 }),
    });
    for (const rung of LADDER) {
      expect(rates[rung.qualityHeight]!.target).toBeLessThanOrEqual(
        getEncodingPolicy(rung.qualityHeight, "hevc").expectedVideoBitrate,
      );
    }
  });
});

describe("quality bar", () => {
  it("needs both the average and the worst frames", () => {
    expect(qualityPasses({ mean: 95.3, p5: 91.6 })).toBe(true);
    expect(qualityPasses({ mean: 97.8, p5: 89.9 })).toBe(false);
    expect(qualityPasses({ mean: 94.9, p5: 93 })).toBe(false);
  });

  it("pools per-frame scores into a mean and a 5th percentile", () => {
    const scores = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(poolVmafScores(scores)).toEqual({ mean: 50.5, p5: 6 });
    expect(() => poolVmafScores([])).toThrow();
  });
});

describe("when a probe runs", () => {
  it("samples across the title, clear of the opening and the credits", () => {
    const windows = sampleWindows(3600);
    expect(windows).toHaveLength(5);
    expect(windows[0]!.startSeconds).toBeGreaterThanOrEqual(300);
    const last = windows.at(-1)!;
    expect(last.startSeconds + last.durationSeconds).toBeLessThan(3600 * 0.9);
  });

  it("leaves short titles on the table", () => {
    expect(sampleWindows(240)).toEqual([]);
    expect(sampleWindows(Number.NaN)).toEqual([]);
  });

  it("only acts for encoders that are given a target rate", () => {
    expect(encoderTakesTargetRate("h264_qsv")).toBe(true);
    expect(encoderTakesTargetRate("hevc_videotoolbox")).toBe(true);
    // CRF already adapts to the picture.
    expect(encoderTakesTargetRate("libx264")).toBe(false);
    expect(encoderTakesTargetRate("libx265")).toBe(false);
  });
});
