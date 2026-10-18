import { describe, expect, it } from "vitest";
import {
  buildEpochPlan,
  nominalEpochBoundaries,
  parseEpochPlan,
  planMatches,
  protectedSecondsAfter,
} from "./plan";
import { EPOCH_TIMELINE_POLICY_VERSION } from "./policy";
import type { SourceFrameTimeline } from "./sourceTimeline";
import {
  cutSecondsBetween,
  straddlingFrames,
  timestampToTicks,
} from "./sourceTimeline";

/** 23.976 fps: the rate the library is full of and the one that never lands round. */
const TICKS_PER_FRAME = 1001;
const TIMEBASE = 24_000;

function constantRateTimeline(seconds: number): SourceFrameTimeline {
  const frames = Math.ceil((seconds * TIMEBASE) / TICKS_PER_FRAME);
  return {
    timebase: TIMEBASE,
    ticks: Array.from(
      { length: frames },
      (_, index) => index * TICKS_PER_FRAME,
    ),
  };
}

describe("nominalEpochBoundaries", () => {
  it("places boundaries on the segment grid so no cut lands inside a segment", () => {
    const boundaries = nominalEpochBoundaries({
      sourceDurationSeconds: 9039.2,
      epochTargetSeconds: 300,
      segmentSeconds: 2,
    });
    expect(boundaries[0]).toBe(300);
    expect(boundaries.every((value) => value % 2 === 0)).toBe(true);
    for (const boundary of boundaries) {
      expect(boundary % 300).toBe(0);
    }
  });

  it("rounds an epoch target that is not a whole number of segments", () => {
    const boundaries = nominalEpochBoundaries({
      sourceDurationSeconds: 100,
      epochTargetSeconds: 7,
      segmentSeconds: 2,
    });
    // Seven seconds is three and a half segments; the grid uses four.
    expect(boundaries.slice(0, 3)).toEqual([8, 16, 24]);
  });

  it("folds a short tail into the epoch before it rather than protecting it alone", () => {
    const boundaries = nominalEpochBoundaries({
      sourceDurationSeconds: 604,
      epochTargetSeconds: 300,
      segmentSeconds: 2,
    });
    // 600 would leave a four-second epoch, which costs more than it protects.
    expect(boundaries).toEqual([300]);
  });

  it("keeps a tail that is worth its own epoch", () => {
    const boundaries = nominalEpochBoundaries({
      sourceDurationSeconds: 800,
      epochTargetSeconds: 300,
      segmentSeconds: 2,
    });
    expect(boundaries).toEqual([300, 600]);
  });

  it("produces a single epoch for a source shorter than the target", () => {
    expect(
      nominalEpochBoundaries({
        sourceDurationSeconds: 120,
        epochTargetSeconds: 300,
        segmentSeconds: 2,
      }),
    ).toEqual([]);
  });
});

describe("buildEpochPlan", () => {
  const base = {
    mediaId: "media",
    sourceFingerprint: "fingerprint",
    profileVersion: "profile",
    epochTargetSeconds: 6,
    segmentSeconds: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("partitions the source with no frame in two epochs and none in neither", () => {
    const timeline = constantRateTimeline(26);
    const plan = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });

    // Every frame belongs to exactly one epoch.
    for (const tick of timeline.ticks) {
      const owners = plan.epochs.filter((epoch) => {
        const start = epoch.start.ticks;
        const end = epoch.end?.ticks ?? Number.POSITIVE_INFINITY;
        return tick >= start && tick < end;
      });
      expect(owners).toHaveLength(1);
    }
  });

  it("cuts between frames rather than on one, so rounding cannot move a frame", () => {
    const timeline = constantRateTimeline(26);
    const plan = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });

    for (const epoch of plan.epochs.slice(1)) {
      const startSeconds = epoch.start.ticks / TIMEBASE;
      const previousSeconds = (epoch.start.ticks - TICKS_PER_FRAME) / TIMEBASE;
      expect(epoch.seekSeconds).toBeGreaterThan(previousSeconds);
      expect(epoch.seekSeconds).toBeLessThan(startSeconds);
      // At least a third of a frame of slack either side of the cut.
      const frame = TICKS_PER_FRAME / TIMEBASE;
      expect(epoch.seekSeconds - previousSeconds).toBeGreaterThan(frame / 3);
      expect(startSeconds - epoch.seekSeconds).toBeGreaterThan(frame / 3);
    }
  });

  it("measures the encode window from the first kept frame, not the seek point", () => {
    const timeline = constantRateTimeline(26);
    const plan = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });
    for (const [index, epoch] of plan.epochs.entries()) {
      const next = plan.epochs[index + 1];
      if (!next) {
        expect(epoch.durationSeconds).toBeUndefined();
        continue;
      }
      const startSeconds = epoch.start.ticks / TIMEBASE;
      const stop = startSeconds + epoch.durationSeconds!;
      // The stop lands between this epoch's last frame and the next one's first.
      expect(stop).toBeGreaterThan(
        (next.start.ticks - TICKS_PER_FRAME) / TIMEBASE,
      );
      expect(stop).toBeLessThan(next.start.ticks / TIMEBASE);
    }
  });

  it("is deterministic for the same source, profile and policy", () => {
    const timeline = constantRateTimeline(26);
    const first = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });
    const second = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });
    expect(second.epochs).toEqual(first.epochs);
    expect(second.timelinePolicyVersion).toBe(EPOCH_TIMELINE_POLICY_VERSION);
  });

  it("falls back to nominal boundaries when frame times cannot be measured", () => {
    const plan = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline: null,
    });
    expect(plan.boundariesMeasured).toBe(false);
    expect(plan.epochs.map((epoch) => epoch.seekSeconds)).toEqual([
      0, 6, 12, 18,
    ]);
  });

  it("stops placing epochs where the source has no more frames", () => {
    /*
     * A container whose declared duration runs past its last frame. Placing an
     * epoch there would produce a checkpoint with nothing in it, which the
     * assembler could not join.
     */
    const timeline = constantRateTimeline(13);
    const plan = buildEpochPlan({
      ...base,
      sourceDurationSeconds: 26,
      timeline,
    });
    expect(plan.epochs).toHaveLength(3);
    expect(plan.epochs[2]!.end).toBeUndefined();
  });

  it("refuses a source with no duration", () => {
    expect(() =>
      buildEpochPlan({ ...base, sourceDurationSeconds: 0, timeline: null }),
    ).toThrow(/positive duration/);
  });
});

describe("planMatches", () => {
  const plan = buildEpochPlan({
    mediaId: "media",
    sourceFingerprint: "fingerprint",
    profileVersion: "profile",
    sourceDurationSeconds: 26,
    epochTargetSeconds: 6,
    segmentSeconds: 2,
    timeline: constantRateTimeline(26),
  });
  const expected = {
    mediaId: "media",
    sourceFingerprint: "fingerprint",
    profileVersion: "profile",
    epochTargetSeconds: 6,
    segmentSeconds: 2,
    sourceDurationSeconds: 26,
  };

  it("accepts a plan built for this exact job", () => {
    expect(planMatches(plan, expected)).toEqual({ ok: true });
  });

  it.each([
    ["source-fingerprint", { sourceFingerprint: "other" }],
    ["profile-version", { profileVersion: "other" }],
    ["media-id", { mediaId: "other" }],
    ["segment-target", { segmentSeconds: 4 }],
  ])("refuses a plan whose %s differs", (reason, override) => {
    expect(planMatches(plan, { ...expected, ...override })).toEqual({
      ok: false,
      reason,
    });
  });

  it("keeps a plan made under another epoch length, so its checkpoints survive a change of length", () => {
    expect(
      planMatches(plan, { ...expected, epochTargetSeconds: 1800 }),
    ).toEqual({ ok: true });
  });

  it("refuses a plan written under a different timeline policy", () => {
    expect(
      planMatches(
        { ...plan, timelinePolicyVersion: "epoch-something-else" },
        expected,
      ),
    ).toEqual({ ok: false, reason: "timeline-policy-version" });
  });

  it("tolerates a duration that moved by less than a second between probes", () => {
    expect(
      planMatches(plan, { ...expected, sourceDurationSeconds: 26.4 }),
    ).toEqual({ ok: true });
  });
});

describe("protectedSecondsAfter", () => {
  const plan = buildEpochPlan({
    mediaId: "media",
    sourceFingerprint: "fingerprint",
    profileVersion: "profile",
    sourceDurationSeconds: 26,
    epochTargetSeconds: 6,
    segmentSeconds: 2,
    timeline: constantRateTimeline(26),
  });

  it("protects nothing before the first checkpoint", () => {
    expect(protectedSecondsAfter(plan, 0)).toBe(0);
  });

  it("protects up to the start of the first unfinished epoch", () => {
    expect(protectedSecondsAfter(plan, 2)).toBeCloseTo(
      plan.epochs[2]!.start.ticks / TIMEBASE,
      6,
    );
  });

  it("protects the whole source once every epoch is complete", () => {
    expect(protectedSecondsAfter(plan, plan.epochs.length)).toBe(26);
  });
});

describe("source timestamps", () => {
  it("converts to a rendition timescale through the rational, not through seconds", () => {
    // 5400 seconds at 23.976: a value a float would already have rounded.
    const timestamp = { ticks: 129_600_000, timebase: TIMEBASE };
    expect(timestampToTicks(timestamp, 90_000)).toBe(486_000_000);
    expect(timestampToTicks(timestamp, TIMEBASE)).toBe(129_600_000);
  });

  it("puts the cut exactly between the straddling frames", () => {
    const timeline = constantRateTimeline(20);
    const frames = straddlingFrames(timeline, 10);
    expect(frames.previous!.ticks).toBe(239 * TICKS_PER_FRAME);
    expect(frames.next!.ticks).toBe(240 * TICKS_PER_FRAME);
    const cut = cutSecondsBetween(frames, 10);
    expect(cut).toBeGreaterThan((239 * TICKS_PER_FRAME) / TIMEBASE);
    expect(cut).toBeLessThan((240 * TICKS_PER_FRAME) / TIMEBASE);
  });

  it("falls back to the nominal boundary when nothing straddles it", () => {
    expect(cutSecondsBetween({}, 300)).toBe(300);
  });
});

describe("parseEpochPlan", () => {
  it("rejects a document with no epochs rather than treating it as empty work", () => {
    expect(() => parseEpochPlan(JSON.stringify({ epochs: [] }))).toThrow(
      /usable document/,
    );
  });
});
