/**
 * The final epoch is measured against the end of the video, not the container.
 *
 * Every Lilyhammer episode failed on its last epoch after a full encode: the
 * container lasts 2695.328s because the audio does, the video stops at
 * 2695.005s, and the validator's quarter-second tolerance cannot absorb the
 * difference.
 */

import { describe, expect, it } from "vitest";
import { buildEpochPlan, withVideoEnd } from "./plan";
import { parseVideoEndSeconds } from "./sourceTimeline";

describe("parseVideoEndSeconds", () => {
  it("ends at the last frame's presentation time plus its duration", () => {
    // The tail of Lilyhammer S01E03 as ffprobe lists it: 25 fps in 1/1000.
    const output = [
      "time_base=1/1000",
      "pts=2694885|duration=40",
      "pts=2694965|duration=40",
      "pts=2694925|duration=40",
      "",
    ].join("\r\n");
    expect(parseVideoEndSeconds(output)).toBeCloseTo(2695.005, 6);
  });

  it("falls back to the frame interval when packets carry no duration", () => {
    const output = [
      "time_base=1/24000",
      "pts=1001000|duration=N/A",
      "pts=1002001|duration=N/A",
      "pts=1003002|duration=N/A",
    ].join("\n");
    expect(parseVideoEndSeconds(output)).toBeCloseTo(1004003 / 24000, 9);
  });

  it("says nothing rather than guessing from an empty read", () => {
    expect(parseVideoEndSeconds("time_base=1/1000\n")).toBeNull();
    expect(parseVideoEndSeconds("")).toBeNull();
  });
});

describe("withVideoEnd", () => {
  const twoEpochs = buildEpochPlan({
    mediaId: "lilyhammer-s01e02",
    sourceFingerprint: "fingerprint",
    profileVersion: "profile",
    sourceDurationSeconds: 2700.32,
    epochTargetSeconds: 1800,
    segmentSeconds: 2,
    createdAt: "2026-10-20T00:00:00.000Z",
  });

  it("measures the final epoch to where the video stops", () => {
    expect(twoEpochs.epochs[1]!.expectedDurationSeconds).toBeCloseTo(900.32, 6);
    const aligned = withVideoEnd(twoEpochs, 2700.005);
    expect(aligned.epochs[1]!.expectedDurationSeconds).toBeCloseTo(900.005, 6);
    // Nothing that places media moves: only the expectation does.
    expect(aligned.epochs[0]).toEqual(twoEpochs.epochs[0]);
    expect(aligned.epochs[1]!.start).toEqual(twoEpochs.epochs[1]!.start);
    expect(aligned.sourceDurationSeconds).toBe(2700.32);
  });

  it("corrects a plan an earlier attempt left on disk", () => {
    const stored = JSON.parse(JSON.stringify(twoEpochs));
    const aligned = withVideoEnd(stored, 2700.005);
    expect(aligned.epochs[1]!.expectedDurationSeconds).toBeCloseTo(900.005, 6);
  });

  it("keeps the container's duration when the video end is unknown", () => {
    expect(withVideoEnd(twoEpochs, null)).toBe(twoEpochs);
    expect(withVideoEnd(twoEpochs, Number.NaN)).toBe(twoEpochs);
    // A video end before the final epoch even starts is not a measurement.
    expect(withVideoEnd(twoEpochs, 1000)).toBe(twoEpochs);
  });
});
