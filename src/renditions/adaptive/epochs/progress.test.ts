import { describe, expect, it } from "vitest";
import {
  createMediaStallDetector,
  createSpeedEstimator,
  epochProgress,
  epochVideoProgress,
  estimateEncodeEtaSeconds,
  interpolatedMediaSeconds,
  SPEED_WARMUP_SAMPLES,
} from "./progress";
import { formatClock } from "./engine";

describe("epochProgress", () => {
  it("reports the media time actually encoded, not a position in a workflow", () => {
    // The worked example: 3000s protected, 92.5s into the epoch that starts there.
    const snapshot = epochProgress({
      protectedSeconds: 3000,
      currentEpochStartSeconds: 3000,
      currentEpochProcessedSeconds: 92.5,
      sourceDurationSeconds: 9039.2,
    });
    expect(snapshot.encodedSeconds).toBeCloseTo(3092.5, 6);
    expect(snapshot.encodedFraction * 100).toBeCloseTo(34.212, 2);
  });

  it("measures a redone epoch from its own start, not from the protected mark", () => {
    /*
     * An epoch being rebuilt after a corrupted checkpoint sits behind the
     * protected mark. Adding its progress to that mark would count the same
     * stretch twice and run the bar past the end of the film.
     */
    const snapshot = epochProgress({
      protectedSeconds: 1800,
      currentEpochStartSeconds: 600,
      currentEpochProcessedSeconds: 120,
      sourceDurationSeconds: 3600,
    });
    expect(snapshot.encodedSeconds).toBe(1800);
  });

  it("never reports more than the source contains", () => {
    const snapshot = epochProgress({
      protectedSeconds: 3500,
      currentEpochStartSeconds: 3500,
      currentEpochProcessedSeconds: 500,
      sourceDurationSeconds: 3600,
    });
    expect(snapshot.encodedSeconds).toBe(3600);
    expect(snapshot.encodedFraction).toBe(1);
  });

  it("treats a source with no duration as no progress rather than as complete", () => {
    expect(
      epochProgress({
        protectedSeconds: 0,
        currentEpochStartSeconds: 0,
        currentEpochProcessedSeconds: 0,
        sourceDurationSeconds: 0,
      }).encodedFraction,
    ).toBe(0);
  });
});

describe("createSpeedEstimator", () => {
  it("ignores the startup samples that would show an ETA of days", () => {
    const estimator = createSpeedEstimator();
    for (let index = 0; index < SPEED_WARMUP_SAMPLES; index += 1) {
      expect(estimator.sample(0.01)).toBeUndefined();
    }
    expect(estimator.sample(0.6)).toBeCloseTo(0.6, 6);
  });

  it("bends toward a new rate rather than lurching onto it", () => {
    const estimator = createSpeedEstimator({
      warmupSamples: 0,
      smoothing: 0.2,
    });
    estimator.sample(1);
    const next = estimator.sample(2);
    expect(next).toBeCloseTo(1.2, 6);
    expect(next).toBeLessThan(2);
  });

  it("keeps its last estimate when a sample is missing or nonsense", () => {
    const estimator = createSpeedEstimator({ warmupSamples: 0 });
    estimator.sample(0.5);
    expect(estimator.sample(undefined)).toBeCloseTo(0.5, 6);
    expect(estimator.sample(0)).toBeCloseTo(0.5, 6);
    expect(estimator.sample(Number.NaN)).toBeCloseTo(0.5, 6);
  });

  it("adapts when the throughput genuinely changes", () => {
    const estimator = createSpeedEstimator({
      warmupSamples: 0,
      smoothing: 0.3,
    });
    for (let index = 0; index < 40; index += 1) estimator.sample(1);
    for (let index = 0; index < 40; index += 1) estimator.sample(0.25);
    expect(estimator.value).toBeCloseTo(0.25, 2);
  });
});

describe("estimateEncodeEtaSeconds", () => {
  it("divides the media left by the smoothed rate", () => {
    expect(
      estimateEncodeEtaSeconds({
        encodedSeconds: 3092.5,
        sourceDurationSeconds: 9039.2,
        smoothedSpeed: 0.61,
      }),
    ).toBe(Math.round((9039.2 - 3092.5) / 0.61));
  });

  it("says nothing at all until there is a rate worth believing", () => {
    expect(
      estimateEncodeEtaSeconds({
        encodedSeconds: 10,
        sourceDurationSeconds: 100,
        smoothedSpeed: undefined,
      }),
    ).toBeUndefined();
  });

  it("reaches zero rather than going negative at the end", () => {
    expect(
      estimateEncodeEtaSeconds({
        encodedSeconds: 120,
        sourceDurationSeconds: 100,
        smoothedSpeed: 2,
      }),
    ).toBe(0);
  });
});

describe("interpolatedMediaSeconds", () => {
  it("moves between authoritative samples at the measured rate", () => {
    expect(
      interpolatedMediaSeconds({
        confirmedSeconds: 100,
        confirmedAtMs: 1_000,
        nowMs: 1_500,
        smoothedSpeed: 0.6,
        upperBoundSeconds: 300,
      }),
    ).toBeCloseTo(100.3, 6);
  });

  it("stops at the bound rather than inventing completion", () => {
    expect(
      interpolatedMediaSeconds({
        confirmedSeconds: 299,
        confirmedAtMs: 0,
        nowMs: 60_000,
        smoothedSpeed: 1,
        upperBoundSeconds: 300,
      }),
    ).toBe(300);
  });

  it("does not move at all when nothing is known about the rate", () => {
    expect(
      interpolatedMediaSeconds({
        confirmedSeconds: 100,
        confirmedAtMs: 0,
        nowMs: 60_000,
        smoothedSpeed: undefined,
        upperBoundSeconds: 300,
      }),
    ).toBe(100);
  });
});

/**
 * The relationships between the three numbers, rather than the numbers.
 *
 * A checkpoint is a promise that a crash cannot cost more than what lies beyond
 * it, and the figures the panel shows are how that promise is read. They have
 * to hold together for every input, including inputs the current event order
 * does not produce.
 */
describe("epoch progress invariants", () => {
  const cases: Array<{
    protectedSeconds: number;
    currentEpochStartSeconds: number;
    currentEpochProcessedSeconds: number;
    sourceDurationSeconds: number;
  }> = [
    // The ordinary case, part way into the epoch after the protected mark.
    {
      protectedSeconds: 600.016,
      currentEpochStartSeconds: 600.016,
      currentEpochProcessedSeconds: 42.5,
      sourceDurationSeconds: 1200,
    },
    // An epoch being redone: it starts *at* the protected mark.
    {
      protectedSeconds: 600.016,
      currentEpochStartSeconds: 600.016,
      currentEpochProcessedSeconds: 0,
      sourceDurationSeconds: 1200,
    },
    // A sample that arrived before the encoder reported anything.
    {
      protectedSeconds: 600.016,
      currentEpochStartSeconds: 600.016,
      currentEpochProcessedSeconds: -3,
      sourceDurationSeconds: 1200,
    },
    // A stretch being rebuilt behind the protected mark, which must not pull
    // the reported position back behind durable media.
    {
      protectedSeconds: 900,
      currentEpochStartSeconds: 300,
      currentEpochProcessedSeconds: 12,
      sourceDurationSeconds: 1200,
    },
    // An encoder that reports past the end of its own epoch and of the source.
    {
      protectedSeconds: 600,
      currentEpochStartSeconds: 600,
      currentEpochProcessedSeconds: 99_999,
      sourceDurationSeconds: 1200,
    },
    // The first epoch of all.
    {
      protectedSeconds: 0,
      currentEpochStartSeconds: 0,
      currentEpochProcessedSeconds: 1.25,
      sourceDurationSeconds: 1200,
    },
  ];

  it.each(cases)(
    "keeps encoded time at or ahead of protected time (%j)",
    (input) => {
      const snapshot = epochProgress(input);
      expect(snapshot.encodedSeconds).toBeGreaterThanOrEqual(
        input.protectedSeconds,
      );
    },
  );

  it.each(cases)("never reports past the end of the source (%j)", (input) => {
    const snapshot = epochProgress(input);
    expect(snapshot.encodedSeconds).toBeLessThanOrEqual(
      Math.max(input.sourceDurationSeconds, input.protectedSeconds),
    );
    expect(snapshot.encodedFraction).toBeGreaterThanOrEqual(0);
    expect(snapshot.encodedFraction).toBeLessThanOrEqual(1);
  });

  it("moves forward, and only forward, as an epoch is encoded", () => {
    let previous = -1;
    for (let processed = 0; processed <= 300; processed += 7.5) {
      const snapshot = epochProgress({
        protectedSeconds: 600.016,
        currentEpochStartSeconds: 600.016,
        currentEpochProcessedSeconds: processed,
        sourceDurationSeconds: 1200,
      });
      expect(snapshot.encodedSeconds).toBeGreaterThanOrEqual(previous);
      previous = snapshot.encodedSeconds;
    }
  });

  /**
   * The reading the report claimed to have seen. Half of a twenty-minute title
   * is exactly ten minutes, and ten minutes is what the epoch before it
   * protects — so a percentage of 50 and a clock of 09:59 cannot both be true,
   * and this is the arithmetic that makes them impossible.
   */
  it("cannot pair a half-encoded twenty minutes with a clock below ten", () => {
    const snapshot = epochProgress({
      protectedSeconds: 600.016,
      currentEpochStartSeconds: 600.016,
      currentEpochProcessedSeconds: 0,
      sourceDurationSeconds: 1200,
    });
    expect(snapshot.encodedSeconds).toBeGreaterThanOrEqual(600);
    expect(formatClock(snapshot.encodedSeconds)).toBe("00:10:00");
    expect(snapshot.encodedFraction * 100).toBeGreaterThanOrEqual(50);
  });
});

/**
 * Watching media time rather than the reports about it.
 *
 * FFmpeg blocked on an unreadable sector keeps reporting four times a second
 * with the same `out_time` and a `speed` that falls a little further each time.
 * Believing those reports is what put a confidently declining encoding rate on
 * the page for minutes while nothing at all was happening.
 */
describe("createMediaStallDetector", () => {
  it("does not call a working encoder stalled", () => {
    const detector = createMediaStallDetector({ stallAfterMs: 6_000 });
    expect(detector.sample(1, 1_000).stalled).toBe(false);
    expect(detector.sample(2, 2_000).stalled).toBe(false);
    expect(detector.sample(20, 20_000).stalled).toBe(false);
  });

  it("calls it stalled once media time stops for the window", () => {
    const detector = createMediaStallDetector({ stallAfterMs: 6_000 });
    detector.sample(123.29, 1_000);
    expect(detector.sample(123.29, 5_000).stalled).toBe(false);
    const reading = detector.sample(123.29, 8_000);
    expect(reading.stalled).toBe(true);
    expect(reading.stalledForMs).toBe(7_000);
    expect(reading.advancedAtMs).toBe(1_000);
  });

  it("recovers the moment media time moves again", () => {
    const detector = createMediaStallDetector({ stallAfterMs: 6_000 });
    detector.sample(123.29, 1_000);
    expect(detector.sample(123.29, 9_000).stalled).toBe(true);
    expect(detector.sample(123.5, 9_100).stalled).toBe(false);
  });

  it("starts again for a new epoch, so a process is never born stalled", () => {
    const detector = createMediaStallDetector({ stallAfterMs: 6_000 });
    detector.sample(123.29, 1_000);
    detector.sample(123.29, 20_000);
    detector.reset();
    expect(detector.sample(0, 20_100).stalled).toBe(false);
  });
});

describe("epochVideoProgress", () => {
  it("reads video time from frames while a copied subtitle holds out_time", () => {
    // How to Train Your Dragon 3, epoch 1: 1847 frames at 23.976 fps, N/A.
    const reported: {
      processedSeconds: number;
      frames: number;
      fps: number;
      speed?: number;
    } = { processedSeconds: 0, frames: 1847, fps: 57.74 };
    const progress = epochVideoProgress(reported, 24000 / 1001, 1800);
    expect(progress.processedSeconds).toBeCloseTo(77.035, 3);
    expect(progress.speed).toBeCloseTo(2.408, 3);
  });

  it("never goes behind out_time, and keeps FFmpeg's own speed", () => {
    const progress = epochVideoProgress(
      { processedSeconds: 120, frames: 2000, fps: 48, speed: 1.53 },
      24,
      1800,
    );
    expect(progress.processedSeconds).toBe(120);
    expect(progress.speed).toBe(1.53);
  });

  it("never runs past the epoch's own length", () => {
    const progress = epochVideoProgress(
      { processedSeconds: 0, frames: 50_000 },
      24,
      1800,
    );
    expect(progress.processedSeconds).toBe(1800);
  });

  it("leaves a report alone without a frame rate or frames", () => {
    const report = { processedSeconds: 3, fps: 40 };
    expect(epochVideoProgress(report, undefined, 1800)).toBe(report);
    expect(epochVideoProgress(report, 24, 1800)).toBe(report);
  });
});
