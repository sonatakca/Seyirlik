/**
 * Reading FFmpeg's log for which side of the transcode failed.
 *
 * The lines here are the real ones, taken from a reproduced failure on a
 * Seagate volume whose platter had an unreadable region. The distinction they
 * carry is the whole point: an `Input/output error` on the *input* is a case
 * for replacing five minutes of a film with black, and the identical errno on
 * the *output* is a case for waiting for a destination volume — and getting
 * that backwards would destroy good film because the drive being written to is
 * failing.
 */

import { describe, expect, it } from "vitest";
import {
  assessSourceRead,
  createStderrTail,
  evidenceIndictsSource,
  readSourceIoEvidence,
  sanitiseFfmpegLine,
  SOURCE_IO_EVIDENCE_LINES,
} from "./sourceIo";

const REAL_INCIDENT = [
  "[in#0/matroska,webm @ 0x14b706ce0] Read error at pos. 10074169063",
  "[in#0/matroska,webm @ 0x14b706ce0] Error during demuxing: Input/output error",
  "[out#0/hls @ 0x14b7071e0] video:120345KiB audio:0KiB",
].join("\n");

describe("readSourceIoEvidence", () => {
  it("recognises the real incident as an input-side read failure", () => {
    const evidence = readSourceIoEvidence(REAL_INCIDENT);
    expect(evidence.sourceRead).toBe(true);
    expect(evidence.outputWrite).toBe(false);
    expect(evidenceIndictsSource(evidence)).toBe(true);
  });

  it("keeps the byte offset the platter gave up at", () => {
    expect(readSourceIoEvidence(REAL_INCIDENT).byteOffset).toBe(10_074_169_063);
  });

  it("does not blame the source for a write that failed", () => {
    const evidence = readSourceIoEvidence(
      [
        "[out#0/hls @ 0x600001] Error writing trailer: Input/output error",
        "av_interleaved_write_frame(): Input/output error",
      ].join("\n"),
    );
    expect(evidence.sourceRead).toBe(false);
    expect(evidence.outputWrite).toBe(true);
    expect(evidenceIndictsSource(evidence)).toBe(false);
  });

  it("refuses to indict the source when both sides failed", () => {
    /*
     * A drive being pulled out takes the read and the write with it. That is a
     * storage interruption the existing recovery path handles, and replacing
     * media over it would be destroying film to work around an unplugged cable.
     */
    const evidence = readSourceIoEvidence(
      [
        "[in#0/mov,mp4 @ 0x1] Error during demuxing: Input/output error",
        "av_interleaved_write_frame(): Input/output error",
      ].join("\n"),
    );
    expect(evidence.sourceRead).toBe(true);
    expect(evidence.outputWrite).toBe(true);
    expect(evidenceIndictsSource(evidence)).toBe(false);
  });

  it("says nothing about a log that merely mentions encoding", () => {
    const evidence = readSourceIoEvidence(
      "frame= 1234 fps= 58 q=28.0 size=  120345KiB time=00:02:03.29 speed=1.2x",
    );
    expect(evidence.sourceRead).toBe(false);
    expect(evidence.outputWrite).toBe(false);
    expect(evidence.lines).toEqual([]);
  });

  it("never carries an absolute path into what it keeps", () => {
    const evidence = readSourceIoEvidence(
      "[in#0] /Volumes/Expansion/Films/Dead Man's Chest (2006)/film.mkv: Input/output error",
    );
    expect(evidence.lines.join(" ")).not.toContain("/Volumes");
    expect(evidence.lines.join(" ")).toContain("film.mkv");
  });

  it("keeps only a bounded tail of the evidence", () => {
    const noisy = Array.from(
      { length: 40 },
      (_, index) => `[in#0] Read error at pos. ${index}`,
    ).join("\n");
    expect(readSourceIoEvidence(noisy).lines).toHaveLength(
      SOURCE_IO_EVIDENCE_LINES,
    );
  });
});

describe("sanitiseFfmpegLine", () => {
  it("reduces a path to the file name a person recognises", () => {
    expect(
      sanitiseFfmpegLine("/Volumes/Expansion/Films/x/film.mkv: I/O error"),
    ).toBe("film.mkv: I/O error");
  });

  it("bounds a single line however long FFmpeg makes it", () => {
    expect(sanitiseFfmpegLine("x".repeat(5_000)).length).toBeLessThanOrEqual(
      240,
    );
  });
});

describe("createStderrTail", () => {
  it("holds only the tail, however much is written through it", () => {
    const tail = createStderrTail(32);
    for (let index = 0; index < 100; index += 1) tail.append("0123456789");
    expect(tail.value()).toHaveLength(32);
    expect(tail.value().endsWith("6789")).toBe(true);
  });

  it("starts again on reset, so one attempt cannot indict the next", () => {
    const tail = createStderrTail();
    tail.append("Error during demuxing: Input/output error");
    tail.reset();
    expect(evidenceIndictsSource(readSourceIoEvidence(tail.value()))).toBe(
      false,
    );
  });
});

/**
 * How much of a damaged region this pipeline is willing to re-read.
 *
 * The budget is not a matter of taste. One application-level read of the sector
 * that motivated all of this took 35-37 seconds, because Darwin retries a
 * failing block about twenty times before returning `EIO` — so four attempts,
 * which is what a transient error is allowed, is two and a half minutes of
 * deliberately re-injuring the same platter for an answer already given.
 */
describe("assessSourceRead", () => {
  const clean = readSourceIoEvidence("");
  const inputEio = readSourceIoEvidence(REAL_INCIDENT);
  const outputEio = readSourceIoEvidence(
    "av_interleaved_write_frame(): Input/output error",
  );

  it("keeps the full budget for an error with no side named", () => {
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: false,
      probe: { verdict: "readable" },
      transientBudget: 4,
    });
    expect(assessment.verdict).toBe("transient");
    expect(assessment.fullReadBudget).toBe(4);
  });

  it("spends one confirming read when FFmpeg named its input", () => {
    const assessment = assessSourceRead({
      evidence: inputEio,
      watchdogAborted: false,
      probe: { verdict: "readable" },
      transientBudget: 4,
    });
    expect(assessment.verdict).toBe("source-damage");
    expect(assessment.fullReadBudget).toBe(2);
  });

  it("spends none at all when a targeted re-read also failed", () => {
    for (const verdict of ["unreadable", "timeout"] as const) {
      const assessment = assessSourceRead({
        evidence: inputEio,
        watchdogAborted: true,
        probe: { verdict },
        transientBudget: 4,
      });
      expect(assessment.verdict).toBe("source-damage");
      expect(assessment.fullReadBudget).toBe(1);
    }
  });

  it("treats a probe that never answered as evidence, not as silence", () => {
    /*
     * A probe that timed out entered the same kernel recovery as the encode it
     * was diagnosing. Reading that as "inconclusive" would send the encoder
     * back for another thirty-five seconds to learn the same thing.
     */
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "timeout" },
      transientBudget: 4,
    });
    expect(assessment.verdict).toBe("source-damage");
    expect(assessment.fullReadBudget).toBe(1);
  });

  it("will not call a stall source damage while the source still reads", () => {
    /*
     * The guard that stops a wedged encoder erasing five minutes of a film.
     * A media-progress timeout on its own is never enough.
     */
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "readable" },
      transientBudget: 4,
    });
    expect(assessment.verdict).toBe("media-progress-timeout");
  });

  it("never blames the source for a failing output volume", () => {
    for (const watchdogAborted of [false, true]) {
      const assessment = assessSourceRead({
        evidence: outputEio,
        watchdogAborted,
        probe: { verdict: "timeout" },
        transientBudget: 4,
      });
      expect(assessment.verdict).toBe("transient");
      expect(assessment.fullReadBudget).toBe(4);
    }
  });
});

/**
 * The same silence on a cloud mount.
 *
 * On 2026-10-23 an epoch read over the Drive mount stalled for 26 s and the
 * probe's 15 s did not answer either, so the rule above called it damage and
 * quarantined the library. The stretch read cleanly afterwards.
 */
describe("assessSourceRead on a network volume", () => {
  const clean = readSourceIoEvidence("");
  const inputEio = readSourceIoEvidence(REAL_INCIDENT);

  it("reads a stall the probe could not answer as a slow fetch", () => {
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "timeout" },
      transientBudget: 4,
      networkVolume: true,
      networkStallBudget: 4,
    });
    expect(assessment.verdict).toBe("network-stall");
    expect(assessment.fullReadBudget).toBe(4);
  });

  it("still calls an explicit read failure damage", () => {
    const failed = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "unreadable" },
      transientBudget: 4,
      networkVolume: true,
      networkStallBudget: 4,
    });
    expect(failed.verdict).toBe("source-damage");

    const named = assessSourceRead({
      evidence: inputEio,
      watchdogAborted: true,
      probe: { verdict: "timeout" },
      transientBudget: 4,
      networkVolume: true,
      networkStallBudget: 4,
    });
    expect(named.verdict).toBe("source-damage");
  });

  it("leaves a wedged encoder a media-progress timeout", () => {
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "readable" },
      transientBudget: 4,
      networkVolume: true,
      networkStallBudget: 4,
    });
    expect(assessment.verdict).toBe("media-progress-timeout");
  });

  it("changes nothing for a local disk", () => {
    const assessment = assessSourceRead({
      evidence: clean,
      watchdogAborted: true,
      probe: { verdict: "timeout" },
      transientBudget: 4,
    });
    expect(assessment.verdict).toBe("source-damage");
    expect(assessment.fullReadBudget).toBe(1);
  });
});
