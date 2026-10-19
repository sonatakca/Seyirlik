// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_PROGRESSION,
  actionsFor,
  bucketOf,
  etaParts,
  formatBytes,
  formatSpeed,
  isWaitingOnSeyirlik,
  progressStep,
  queueMoveFor,
  remedyFor,
  targetLabel,
  type AcquisitionFailureClass,
  type AcquisitionState,
} from "./acquisitionPresentation";

const ALL_STATES: AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "downloaded",
  "awaiting_retry",
  "failed",
  "cancelled",
  "superseded",
];

describe("which list an acquisition belongs in", () => {
  it.each([
    ["planned", "active"],
    ["resolving", "active"],
    ["submitting", "active"],
    ["queued", "active"],
    ["downloading", "active"],
    ["processing", "active"],
    ["awaiting_retry", "active"],
    ["failed", "needsAttention"],
    ["downloaded", "finished"],
    ["cancelled", "finished"],
    ["superseded", "finished"],
  ] as Array<[AcquisitionState, string]>)("puts %s in %s", (state, bucket) => {
    expect(bucketOf(state)).toBe(bucket);
  });

  it("sorts every state into exactly one list", () => {
    for (const state of ALL_STATES) {
      expect(["active", "needsAttention", "finished"]).toContain(
        bucketOf(state),
      );
    }
  });

  it("does not call a scheduled retry a problem", () => {
    /*
     * `awaiting_retry` means the queue is going to try again on its own.
     * Listing it as needing attention would send an operator to look at
     * something that is already being handled.
     */
    expect(bucketOf("awaiting_retry")).toBe("active");
    expect(isWaitingOnSeyirlik("awaiting_retry")).toBe(true);
    expect(isWaitingOnSeyirlik("failed")).toBe(false);
  });
});

describe("what may be done, mirroring what the server allows", () => {
  it("offers a retry only where the server accepts one", () => {
    for (const state of ALL_STATES) {
      expect(actionsFor(state).canRetry).toBe(state === "failed");
    }
  });

  it("never offers to cancel a download that already finished", () => {
    // The server refuses this with a conflict; offering the button would only
    // produce an error an operator did not need to see.
    const actions = actionsFor("downloaded");
    expect(actions.canCancel).toBe(false);
    expect(actions.cancelBlockedReason).toBe("already-finished");
  });

  it("does not offer to cancel something already cancelled or superseded", () => {
    expect(actionsFor("cancelled").canCancel).toBe(false);
    expect(actionsFor("superseded").canCancel).toBe(false);
  });

  it("offers cancellation everywhere the work is still live", () => {
    for (const state of [
      "planned",
      "resolving",
      "submitting",
      "queued",
      "downloading",
      "processing",
      "awaiting_retry",
      "failed",
    ] as AcquisitionState[]) {
      expect(actionsFor(state).canCancel).toBe(true);
    }
  });
});

describe("how far along it is", () => {
  it("counts steps rather than inventing a percentage", () => {
    /*
     * SABnzbd is polled, so a job can move several states between two reads. A
     * percentage would claim a precision nobody measured; a step out of a known
     * list says exactly what is known.
     */
    expect(progressStep("planned")).toEqual({ step: 1, of: 7 });
    expect(progressStep("downloading")).toEqual({ step: 5, of: 7 });
    expect(progressStep("downloaded")).toEqual({
      step: ACQUISITION_PROGRESSION.length,
      of: 7,
    });
  });

  it("says nothing for a state that is not on the path", () => {
    for (const state of [
      "failed",
      "cancelled",
      "superseded",
      "awaiting_retry",
    ] as AcquisitionState[]) {
      expect(progressStep(state)).toBeNull();
    }
  });

  it("never moves backwards through the list", () => {
    const steps = ACQUISITION_PROGRESSION.map(
      (state) => progressStep(state)!.step,
    );
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});

describe("what a failure asks of the reader", () => {
  it.each([
    ["indexer-unavailable", "waits"],
    ["sab-unavailable", "waits"],
    ["submission-timeout", "waits"],
    ["disk-full", "waits"],
    ["nzb-unavailable", "another-release"],
    ["missing-articles", "another-release"],
    ["repair-failed", "another-release"],
    ["unpack-failed", "another-release"],
    ["password-required", "another-release"],
    ["blocklisted", "another-release"],
    ["indexer-auth", "operator"],
    ["sab-auth", "operator"],
    ["removed-externally", "operator"],
    ["cancelled", "operator"],
    ["unknown", "operator"],
  ] as Array<[AcquisitionFailureClass, string]>)(
    "reads %s as %s",
    (failure, remedy) => {
      expect(remedyFor(failure)).toBe(remedy);
    },
  );

  it("never tells a reader to wait for something that will not change", () => {
    // A wrong password is wrong tomorrow too.
    for (const failure of [
      "indexer-auth",
      "sab-auth",
      "password-required",
    ] as AcquisitionFailureClass[]) {
      expect(remedyFor(failure)).not.toBe("waits");
    }
  });
});

describe("blocklisting", () => {
  it("is offered wherever the server will stop the acquisition", () => {
    for (const state of [
      "planned",
      "queued",
      "downloading",
      "processing",
      "awaiting_retry",
      "failed",
    ] as const) {
      expect(actionsFor(state).canBlocklist).toBe(true);
    }
    // Mid-submission, or already over.
    for (const state of [
      "resolving",
      "submitting",
      "downloaded",
      "cancelled",
      "superseded",
    ] as const) {
      expect(actionsFor(state).canBlocklist).toBe(false);
    }
  });

  it("takes away the retry, which would ask for the same release", () => {
    expect(actionsFor("failed", "blocklisted").canRetry).toBe(false);
    expect(actionsFor("failed", "missing-articles").canRetry).toBe(true);
  });
});

describe("saying sizes, speeds and time left", () => {
  it("uses decimal GB, the unit of the size limit", () => {
    expect(formatBytes(30_000_000_000)).toBe("30.0 GB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatBytes(512_000_000)).toBe("512 MB");
    expect(formatSpeed(31_000_000)).toBe("31.0 MB/s");
  });

  it("rounds time left to minutes, and says so under one", () => {
    expect(etaParts(30)).toBe("underAMinute");
    expect(etaParts(425)).toEqual({ hours: 0, minutes: 7 });
    expect(etaParts(4_350)).toEqual({ hours: 1, minutes: 13 });
  });

  it("refuses a retry wherever the release is blocklisted", () => {
    expect(actionsFor("failed", "missing-articles", true).canRetry).toBe(false);
  });
});

describe("naming a download", () => {
  it("names an episode by its code", () => {
    expect(
      targetLabel({
        kind: "episode",
        title: "The Sopranos",
        season: 1,
        episode: 3,
      }),
    ).toEqual({ title: "The Sopranos", episodeCode: "S01E03" });
  });

  it("names a season pack by its season", () => {
    expect(
      targetLabel({ kind: "season", title: "Ezel", season: 2, year: 2009 }),
    ).toEqual({ title: "Ezel", season: 2 });
  });

  it("names a film by its year, when there is one", () => {
    expect(targetLabel({ kind: "movie", title: "Dune", year: 2021 })).toEqual({
      title: "Dune",
      year: 2021,
    });
    expect(targetLabel({ kind: "movie", title: "Dune" })).toEqual({
      title: "Dune",
    });
  });
});

describe("turning a drop into a place in the client's queue", () => {
  // Places with gaps: the client holds jobs that are not Seyirlik's.
  const before = [
    { id: "a", queuePosition: 1 },
    { id: "b", queuePosition: 3 },
    { id: "c", queuePosition: 4 },
  ];

  it("takes the place of the row it now stands in for, moving up", () => {
    expect(queueMoveFor(before, ["c", "a", "b"])).toEqual({
      id: "c",
      position: 1,
    });
  });

  it("takes the place of the row it now stands in for, moving down", () => {
    expect(queueMoveFor(before, ["b", "c", "a"])).toEqual({
      id: "a",
      position: 4,
    });
  });

  it("does nothing for an unchanged order or a changed set", () => {
    expect(queueMoveFor(before, ["a", "b", "c"])).toBeNull();
    expect(queueMoveFor(before, ["a", "b"])).toBeNull();
  });
});
