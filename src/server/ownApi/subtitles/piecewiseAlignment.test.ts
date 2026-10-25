import { describe, expect, it } from "vitest";
import {
  alignPiecewise,
  type AlignmentCue,
  type PiecewiseAlignment,
} from "./piecewiseAlignment";
import { alignSpeech, type SpeechInterval } from "./subtitleAlignment";
import { MINIMUM_SYNC_CONFIDENCE } from "./subtitleSync";

/**
 * An episode's dialogue on the media's own timeline, deterministically.
 *
 * Seeded rather than patterned: a generator with a rhythm of its own (the
 * global aligner's tests use an irrational rotation) repeats its local
 * pattern every few hundred lines, and a piecewise search over five minutes
 * of offsets finds those repeats and reports them as edits. Real dialogue has
 * no such period, and neither does this.
 */
function dialogue(
  untilSeconds: number,
  options: { from?: number; seed?: number } = {},
): SpeechInterval[] {
  let state = options.seed ?? 7;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const intervals: SpeechInterval[] = [];
  let at = options.from ?? 20;
  while (at < untilSeconds) {
    const duration = 0.8 + random() * 3.2;
    intervals.push({ startSeconds: at, endSeconds: at + duration });
    // Mostly conversation, sometimes a pause, now and then a long silence.
    const pause = random();
    at +=
      duration +
      (pause < 0.7
        ? 0.3 + random() * 2
        : pause < 0.95
          ? 2 + random() * 6
          : 10 + random() * 30);
  }
  return intervals;
}

/** A subtitle whose cue `i` is the reference line `i`, mis-timed by `timing`. */
function subtitleOf(
  lines: readonly SpeechInterval[],
  timing: (seconds: number) => number,
): AlignmentCue[] {
  // A cue moves as a whole: the shift its start gets, its end gets too.
  return lines.map((line, index) => {
    const start = timing(line.startSeconds);
    return {
      index,
      startSeconds: start,
      endSeconds: line.endSeconds + (start - line.startSeconds),
    };
  });
}

/** How far each cue ended up from where its line really is. */
function errors(
  result: PiecewiseAlignment,
  truth: (index: number) => SpeechInterval | null,
): number[] {
  return result.cues.flatMap((cue) => {
    const line = truth(cue.index);
    return line === null
      ? []
      : [Math.abs(cue.startSeconds - line.startSeconds)];
  });
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  ] as number;
};

const EPISODE = 2400;
const media = dialogue(EPISODE);
const asSubtitle = { kind: "subtitle" as const, intervals: media };

describe("alignPiecewise — the regression that started this", () => {
  // Scenario A: the first twenty minutes right, the last twenty eight seconds late.
  const late = subtitleOf(media, (t) => (t >= 1200 ? t + 8 : t));

  it("is what the global aligner gets wrong, confidently", () => {
    /*
     * Pinned so the failure stays documented. One transform cannot be right
     * for both halves: whichever half it chose, the other is eight seconds
     * out — and it is still scored above the old acceptance threshold, which
     * is how a damaging correction used to be written.
     */
    const global = alignSpeech(late, media);
    const wrongBy = (seconds: number) =>
      Math.abs(seconds * global.rate + global.offsetSeconds - seconds);
    expect(
      Math.max(wrongBy(600), Math.abs(wrongBy(1800 + 8) - 8)),
    ).toBeGreaterThan(7.5);
    expect(global.confidence).toBeGreaterThan(MINIMUM_SYNC_CONFIDENCE);
  });

  it("corrects the late half and leaves the right half exactly where it was", () => {
    const result = alignPiecewise(late, asSubtitle);
    expect(result.verdict).toBe("correctable");
    const early = result.cues.filter((cue) => cue.sourceStartSeconds < 1200);
    for (const cue of early)
      expect(cue.startSeconds).toBe(cue.sourceStartSeconds);
    expect(
      percentile(
        errors(result, (i) => media[i] ?? null),
        0.95,
      ),
    ).toBeLessThan(0.05);
    expect(result.segments.map((segment) => segment.status)).toEqual([
      "aligned",
      "corrected",
    ]);
    expect(result.segments[1]?.offsetSeconds).toBeCloseTo(-8, 2);
  });
});

describe("alignPiecewise — timing scenarios", () => {
  it("B: several regions shifted independently", () => {
    const shifted = subtitleOf(media, (t) =>
      t < 600 ? t : t < 1080 ? t + 4 : t < 1740 ? t : t - 12,
    );
    const result = alignPiecewise(shifted, asSubtitle);
    expect(result.verdict).toBe("correctable");
    expect(
      result.segments
        .filter((segment) => segment.status === "corrected")
        .map((segment) => Math.round(segment.offsetSeconds)),
    ).toEqual([-4, 12]);
    expect(
      percentile(
        errors(result, (i) => media[i] ?? null),
        0.95,
      ),
    ).toBeLessThan(0.05);
  });

  it("C: a frame-rate transfer is one region with a rate", () => {
    const rate = 25 / 23.976;
    const drifting = subtitleOf(media, (t) => t * rate + 2);
    const result = alignPiecewise(drifting, asSubtitle);
    expect(result.verdict).toBe("correctable");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.rate).toBeCloseTo(1 / rate, 5);
    expect(
      percentile(
        errors(result, (i) => media[i] ?? null),
        0.95,
      ),
    ).toBeLessThan(0.05);
  });

  it("D: footage removed from this edition leaves its dialogue unmatched, not misplaced", () => {
    // The subtitle's edition has 45 s at 900 s that this one does not.
    const source = media;
    const removedFrom = 900;
    const removedTo = 945;
    const target = source
      .filter(
        (line) =>
          line.endSeconds <= removedFrom || line.startSeconds >= removedTo,
      )
      .map((line) =>
        line.startSeconds >= removedTo
          ? {
              startSeconds: line.startSeconds - 45,
              endSeconds: line.endSeconds - 45,
            }
          : line,
      );
    const subtitle = subtitleOf(source, (t) => t);
    const result = alignPiecewise(subtitle, {
      kind: "subtitle",
      intervals: target,
    });

    const inCut = subtitle.filter(
      (cue) => cue.endSeconds > removedFrom && cue.startSeconds < removedTo,
    );
    const unmatched = result.cues.filter(
      (cue) => cue.disposition === "unmatched",
    );
    expect(unmatched.map((cue) => cue.index)).toEqual(
      inCut.map((cue) => cue.index),
    );
    expect(result.verdict).toBe("partial");
    expect(result.breakpoints).toHaveLength(1);
    expect(result.breakpoints[0]?.kind).toBe("removed");
    expect(result.breakpoints[0]?.seconds).toBeCloseTo(45, 1);
    // Nothing that is in this edition was moved anywhere but onto its line.
    for (const cue of result.cues) {
      if (cue.disposition === "unmatched") continue;
      const expected =
        cue.sourceStartSeconds >= removedTo
          ? cue.sourceStartSeconds - 45
          : cue.sourceStartSeconds;
      expect(Math.abs(cue.startSeconds - expected)).toBeLessThan(0.05);
    }
  });

  it("E: footage inserted in this edition moves everything after it", () => {
    const inserted = dialogue(930, { from: 902, seed: 5 });
    const target = [
      ...media.filter((line) => line.startSeconds < 900),
      ...inserted,
      ...media
        .filter((line) => line.startSeconds >= 900)
        .map((line) => ({
          startSeconds: line.startSeconds + 30,
          endSeconds: line.endSeconds + 30,
        })),
    ];
    const result = alignPiecewise(
      subtitleOf(media, (t) => t),
      {
        kind: "subtitle",
        intervals: target,
      },
    );
    expect(result.verdict).toBe("correctable");
    expect(result.breakpoints).toEqual([
      expect.objectContaining({
        kind: "inserted",
        seconds: expect.closeTo(30, 1),
      }),
    ]);
    for (const cue of result.cues) {
      const expected =
        cue.sourceStartSeconds >= 900
          ? cue.sourceStartSeconds + 30
          : cue.sourceStartSeconds;
      expect(Math.abs(cue.startSeconds - expected)).toBeLessThan(0.05);
    }
  });

  it("F: a subtitle already right is reported as right and changes nothing", () => {
    const result = alignPiecewise(
      subtitleOf(media, (t) => t),
      asSubtitle,
    );
    expect(result.verdict).toBe("in-sync");
    for (const cue of result.cues) {
      expect(cue.startSeconds).toBe(cue.sourceStartSeconds);
      expect(cue.endSeconds).toBe(cue.sourceEndSeconds);
    }
  });

  it("F: a plain global shift is still one region", () => {
    const result = alignPiecewise(
      subtitleOf(media, (t) => t + 14.5),
      asSubtitle,
    );
    expect(result.verdict).toBe("correctable");
    expect(result.autoApplicable).toBe(true);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.offsetSeconds).toBeCloseTo(-14.5, 2);
  });
});

describe("alignPiecewise — refusing what the evidence does not support", () => {
  it("finds nothing between two different episodes", () => {
    const other = dialogue(EPISODE, { from: 31, seed: 99 });
    const result = alignPiecewise(
      subtitleOf(other, (t) => t),
      asSubtitle,
    );
    expect(result.verdict).toBe("insufficient-evidence");
    expect(result.autoApplicable).toBe(false);
    expect(result.counts.corrected).toBe(0);
  });

  it("leaves a region with no reference at all unresolved rather than moving it", () => {
    // The reference stops at 1500 s: the rest of the subtitle has nothing to agree with.
    const truncated = media.filter((line) => line.startSeconds < 1500);
    const late = subtitleOf(media, (t) => (t >= 1200 ? t + 8 : t));
    const result = alignPiecewise(late, {
      kind: "subtitle",
      intervals: truncated,
    });
    expect(result.verdict).toBe("partial");
    const tail = result.cues.filter((cue) => cue.sourceStartSeconds > 1800);
    for (const cue of tail) {
      expect(cue.disposition).toBe("unresolved");
      expect(cue.startSeconds).toBe(cue.sourceStartSeconds);
    }
  });

  it("does not split for one coincidental cue", () => {
    // One line badly mistimed by hand in an otherwise correct subtitle.
    const subtitle = subtitleOf(media, (t) => t);
    const moved = subtitle.map((cue) =>
      cue.index === 200
        ? {
            ...cue,
            startSeconds: cue.startSeconds + 6,
            endSeconds: cue.endSeconds + 6,
          }
        : cue,
    );
    const result = alignPiecewise(moved, asSubtitle);
    expect(
      result.segments.filter((segment) => segment.status === "corrected"),
    ).toEqual([]);
  });
});

describe("alignPiecewise — an audio track's speech", () => {
  /*
   * What an energy gate makes of dialogue: neighbouring lines merged into one
   * stretch, onsets late and jittered, a few lines missed, and music and
   * effects that look exactly like speech.
   */
  function speechOf(lines: readonly SpeechInterval[]): SpeechInterval[] {
    const out: { startSeconds: number; endSeconds: number }[] = [];
    lines.forEach((line, index) => {
      const jitter = (((index * 0.754877666) % 1) - 0.5) * 0.3;
      if (index % 7 === 3) return; // a whisper the gate missed
      const previous = out[out.length - 1];
      if (previous && line.startSeconds - previous.endSeconds < 0.7) {
        previous.endSeconds = line.endSeconds;
        return;
      }
      out.push({
        startSeconds: line.startSeconds + 0.1 + jitter,
        endSeconds: line.endSeconds + 0.3,
      });
    });
    for (let at = 50; at < EPISODE; at += 97.3)
      out.push({ startSeconds: at, endSeconds: at + 6 }); // a score's swell
    return out.sort((left, right) => left.startSeconds - right.startSeconds);
  }

  it("A against speech: corrects the late half without touching the early one", () => {
    const late = subtitleOf(media, (t) => (t >= 1200 ? t + 8 : t));
    const result = alignPiecewise(late, {
      kind: "speech",
      intervals: speechOf(media),
    });
    expect(["correctable", "partial"]).toContain(result.verdict);
    for (const cue of result.cues.filter((c) => c.sourceStartSeconds < 1150))
      expect(cue.startSeconds).toBe(cue.sourceStartSeconds);
    const late95 = percentile(
      errors(result, (i) =>
        (media[i]?.startSeconds ?? 0) >= 1250 ? (media[i] ?? null) : null,
      ),
      0.95,
    );
    expect(late95).toBeLessThan(0.4);
  });

  it("F against speech: a correct subtitle stays exactly as it is", () => {
    const result = alignPiecewise(
      subtitleOf(media, (t) => t),
      {
        kind: "speech",
        intervals: speechOf(media),
      },
    );
    expect(["in-sync", "partial"]).toContain(result.verdict);
    expect(result.counts.corrected).toBe(0);
    for (const cue of result.cues)
      expect(cue.startSeconds).toBe(cue.sourceStartSeconds);
  });
});

describe("alignPiecewise — anchors from what was said", () => {
  it("lets meaning place a region the speech alone cannot", () => {
    // Speech present only in the first half; the second half is music the gate cannot read.
    const early = media.filter((line) => line.startSeconds < 1200);
    const late = subtitleOf(media, (t) => (t >= 1200 ? t + 8 : t));
    const anchors = late
      .filter((cue) => cue.startSeconds >= 1250 && cue.index % 4 === 0)
      .map((cue) => ({
        cueIndex: cue.index,
        mediaSeconds: (media[cue.index] as SpeechInterval).startSeconds + 0.2,
        weight: 1.5,
      }));
    const result = alignPiecewise(
      late,
      { kind: "subtitle", intervals: early },
      { anchors },
    );
    const tail = result.cues.filter((cue) => cue.sourceStartSeconds > 1300);
    const placed = tail.filter(
      (cue) =>
        cue.disposition === "corrected" || cue.disposition === "inferred",
    );
    expect(placed.length / tail.length).toBeGreaterThan(0.9);
    for (const cue of placed)
      expect(
        Math.abs(cue.startSeconds - (cue.sourceStartSeconds - 8)),
      ).toBeLessThan(0.6);
  });
});
