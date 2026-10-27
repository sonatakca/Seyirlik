import { describe, expect, it } from "vitest";
import {
  applyOperatorAction,
  applyStorageObservation,
  demandsStop,
  describeStorageHealth,
  initialStorageHealth,
  looksLikeHardIoFault,
  mayStartWork,
  observationForFailure,
  QUARANTINE_AFTER_SOFT_FAULTS,
  resumesAutomatically,
  STABILITY_SETTLE_MS,
  SUSPECT_WINDOW_MS,
  type StorageHealthRecord,
  type StorageObservation,
} from "./storageHealth";

/**
 * The rules that decide whether a volume may be worked against.
 *
 * The incident these are written from: a USB-attached drive returned `EIO` from
 * the SCSI block layer while its mount stayed and its directory metadata
 * answered instantly. Every availability check passed. After a forced restart a
 * job left `running` was requeued within seconds, FFmpeg went back at the same
 * region, and the machine had to be powered off a second time.
 *
 * So the property under test is not "does it notice a failure" — the old code
 * noticed several — but "having noticed, can anything short of a person undo
 * it". No test here touches a real volume; the whole point of the state machine
 * being pure is that this file cannot.
 */

const AT = 1_000_000;
const hardFault = (detail = "EIO on read"): StorageObservation => ({
  kind: "hard-io-fault",
  detail,
});
const softFault = (
  detail = "ambiguous transient signal",
): StorageObservation => ({
  kind: "soft-fault",
  detail,
});

/** Drives a record through a sequence of observations at chosen times. */
function run(
  record: StorageHealthRecord,
  steps: Array<[StorageObservation, number]>,
): StorageHealthRecord {
  return steps.reduce(
    (current, [observation, at]) =>
      applyStorageObservation(current, observation, at),
    record,
  );
}

describe("what each state permits", () => {
  it("lets work start only when healthy", () => {
    expect(mayStartWork("healthy")).toBe(true);
    for (const state of [
      "unavailable",
      "suspect",
      "quarantined",
      "recovery-pending",
    ] as const) {
      expect(mayStartWork(state)).toBe(false);
    }
  });

  /**
   * A verified-but-not-resumed volume must not have work stopped *again* — by
   * then nothing is running — but must equally not have work started. The two
   * questions are separate and a single boolean conflates them.
   */
  it("stops running work for every fault state, but not while awaiting a resume", () => {
    expect(demandsStop("unavailable")).toBe(true);
    expect(demandsStop("suspect")).toBe(true);
    expect(demandsStop("quarantined")).toBe(true);
    expect(demandsStop("recovery-pending")).toBe(false);
    expect(demandsStop("healthy")).toBe(false);
  });

  /** Only the clean unplug comes back on its own. */
  it("permits automatic resume for a clean absence and nothing else", () => {
    expect(resumesAutomatically("unavailable")).toBe(true);
    expect(resumesAutomatically("suspect")).toBe(false);
    expect(resumesAutomatically("quarantined")).toBe(false);
    expect(resumesAutomatically("recovery-pending")).toBe(false);
  });
});

describe("a clean unmount and remount", () => {
  it("goes unavailable, then healthy once the volume has stayed", () => {
    const gone = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "absent", roots: ["/vol/media"] },
      AT,
    );
    expect(gone.state).toBe("unavailable");
    expect(gone.missingRoots).toEqual(["/vol/media"]);

    const back = applyStorageObservation(
      gone,
      { kind: "ok" },
      AT + STABILITY_SETTLE_MS,
    );
    expect(back.state).toBe("healthy");
    expect(back.missingRoots).toEqual([]);
  });

  /**
   * A cable on its way out presents as rapid clean disappearances. Reading each
   * return as a recovery is how a queue starts an encode into a volume that is
   * about to leave again.
   */
  it("does not call a volume recovered before it has settled", () => {
    const gone = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "absent", roots: ["/vol/media"] },
      AT,
    );
    const tooSoon = applyStorageObservation(
      gone,
      { kind: "ok" },
      AT + STABILITY_SETTLE_MS - 1,
    );
    expect(tooSoon.state).toBe("unavailable");
  });

  /** Otherwise every poll restarts the settling clock and it never elapses. */
  it("does not restart the settling clock on each absent poll", () => {
    const settled = run(initialStorageHealth("/vol/media", AT), [
      [{ kind: "absent", roots: ["/vol/media"] }, AT],
      [{ kind: "absent", roots: ["/vol/media"] }, AT + 10_000],
      [{ kind: "absent", roots: ["/vol/media"] }, AT + 20_000],
      [{ kind: "ok" }, AT + STABILITY_SETTLE_MS],
    ]);
    expect(settled.state).toBe("healthy");
  });
});

describe("hard storage evidence", () => {
  it.each([
    ["one EIO immediately enters persisted-policy quarantine", "EIO"],
    ["one ENXIO immediately enters persisted-policy quarantine", "ENXIO"],
    [
      "one FFmpeg Input/output error immediately enters persisted-policy quarantine",
      "[in#0] Error during demuxing: Input/output error",
    ],
  ])("%s", (_name, detail) => {
    const quarantined = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      hardFault(detail),
      AT,
    );
    expect(quarantined.state).toBe("quarantined");
    expect(quarantined.faultCount).toBe(1);
    expect(mayStartWork(quarantined.state)).toBe(false);
  });

  it("one active device loss immediately quarantines", () => {
    const quarantined = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "device-lost", detail: "device disappeared during source read" },
      AT,
    );
    expect(quarantined.state).toBe("quarantined");
    expect(quarantined.faultCount).toBe(1);
  });

  it("one confirmed source-read watchdog failure immediately quarantines", () => {
    const quarantined = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "read-timeout", detail: "bounded source read did not answer" },
      AT,
    );
    expect(quarantined.state).toBe("quarantined");
    expect(quarantined.faultCount).toBe(1);
  });
});

describe("an ambiguous soft fault", () => {
  it("uses suspect and stops work without claiming the disk failed", () => {
    const suspect = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      softFault(),
      AT,
    );
    expect(suspect.state).toBe("suspect");
    expect(suspect.faultCount).toBe(1);
    expect(mayStartWork(suspect.state)).toBe(false);
  });

  it("quarantines only after corroboration inside the window", () => {
    const quarantined = run(initialStorageHealth("/vol/media", AT), [
      [softFault("ambiguous signal one"), AT],
      [softFault("ambiguous signal two"), AT + 5_000],
    ]);
    expect(quarantined.state).toBe("quarantined");
    expect(quarantined.faultCount).toBe(QUARANTINE_AFTER_SOFT_FAULTS);
  });

  /**
   * Otherwise the counter is a lifetime total and every drive eventually
   * reaches two, which would teach an operator that quarantines mean nothing.
   */
  it("lets a lone fault lapse rather than accumulating one blip a month", () => {
    const lapsed = run(initialStorageHealth("/vol/media", AT), [
      [softFault(), AT],
      [{ kind: "ok" }, AT + SUSPECT_WINDOW_MS + 1],
    ]);
    expect(lapsed.state).toBe("healthy");
    expect(lapsed.faultCount).toBe(0);

    const second = applyStorageObservation(
      lapsed,
      softFault(),
      AT + SUSPECT_WINDOW_MS + 2,
    );
    expect(second.state).toBe("suspect");
  });

  /** A fault long after the previous one is a first fault, not a second. */
  it("does not quarantine on two faults far apart", () => {
    const record = run(initialStorageHealth("/vol/media", AT), [
      [softFault(), AT],
      [softFault(), AT + SUSPECT_WINDOW_MS + 60_000],
    ]);
    expect(record.state).toBe("suspect");
    expect(record.faultCount).toBe(1);
  });
});

describe("a quarantine, once established", () => {
  const quarantined = applyStorageObservation(
    initialStorageHealth("/vol/media", AT),
    hardFault(),
    AT,
  );

  /**
   * The regression this whole design exists for. A failing drive answers a
   * `stat` perfectly between retry storms, and letting that clear the record is
   * exactly how the second freeze happened.
   */
  it("does not lapse after 10 minutes, 1 hour, or a host-recovery observation", () => {
    const polled = run(quarantined, [
      [{ kind: "ok" }, AT + SUSPECT_WINDOW_MS],
      [{ kind: "ok" }, AT + 60 * 60_000],
      [{ kind: "unclean-restart", detail: "host recovered" }, AT + 86_400_000],
    ]);
    expect(polled.state).toBe("quarantined");
  });

  it("is not cleared by the volume going away and coming back", () => {
    const cycled = run(quarantined, [
      [{ kind: "absent", roots: ["/vol/media"] }, AT + 10_000],
      [{ kind: "ok" }, AT + 10_000 + STABILITY_SETTLE_MS * 5],
    ]);
    expect(cycled.state).toBe("quarantined");
  });

  it("is not cleared by an unclean restart", () => {
    const restarted = applyStorageObservation(
      quarantined,
      { kind: "unclean-restart", detail: "job still running" },
      AT + 999_999,
    );
    expect(restarted.state).toBe("quarantined");
  });

  /** Verification is cheap and safe; deciding the hardware is fixed is not. */
  it("needs a verification and then a separate resume", () => {
    const verified = applyOperatorAction(
      quarantined,
      { kind: "verify-passed", detail: "metadata check passed" },
      AT + 1_000_000,
    );
    expect(verified.state).toBe("recovery-pending");
    expect(mayStartWork(verified.state)).toBe(false);

    const resumed = applyOperatorAction(
      verified,
      { kind: "resume", detail: "operator confirmed" },
      AT + 1_000_001,
    );
    expect(resumed.state).toBe("healthy");
    expect(resumed.faultCount).toBe(0);
    expect(resumed.clearedAtMs).toBe(AT + 1_000_001);
  });

  /** A resume that skipped the check would make the check decorative. */
  it("refuses a resume that did not follow a passing verification", () => {
    const attempted = applyOperatorAction(
      quarantined,
      { kind: "resume", detail: "operator confirmed" },
      AT + 1_000,
    );
    expect(attempted.state).toBe("quarantined");
  });

  /** The operator saying "still bad" is stronger evidence than any poll. */
  it("records a failed verification rather than ignoring it", () => {
    const verified = applyOperatorAction(
      quarantined,
      { kind: "verify-passed", detail: "ok" },
      AT + 1_000,
    );
    const failed = applyOperatorAction(
      verified,
      { kind: "verify-failed", detail: "the volume did not answer" },
      AT + 2_000,
    );
    expect(failed.state).toBe("quarantined");
    expect(failed.verifiedAtMs).toBeNull();
  });
});

describe("an unclean restart", () => {
  it("parks a healthy root rather than condemning it", () => {
    const parked = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "unclean-restart", detail: "job still running" },
      AT,
    );
    expect(parked.state).toBe("recovery-pending");
    expect(mayStartWork(parked.state)).toBe(false);
    expect(resumesAutomatically(parked.state)).toBe(false);
  });

  /** A poll finding the path readable must not be mistaken for a decision. */
  it("is not lifted by the storage answering", () => {
    const parked = run(initialStorageHealth("/vol/media", AT), [
      [{ kind: "unclean-restart", detail: "job still running" }, AT],
      [{ kind: "ok" }, AT + STABILITY_SETTLE_MS * 10],
    ]);
    expect(parked.state).toBe("recovery-pending");
  });
});

describe("what is not storage evidence", () => {
  /**
   * The distinction cost a real investigation. A deadlocked filter graph must
   * never take a library offline, and a healthy disk must never be blamed for
   * one — the alternative is replacing five minutes of a film with black
   * because of an encoder bug.
   */
  it("never lets an encoder stall touch the storage's state", () => {
    const record = run(initialStorageHealth("/vol/media", AT), [
      [{ kind: "encoder-stall", detail: "no media for 991s" }, AT],
      [{ kind: "encoder-stall", detail: "no media for 991s" }, AT + 1_000],
      [{ kind: "encoder-stall", detail: "no media for 991s" }, AT + 2_000],
    ]);
    expect(record.state).toBe("healthy");
    expect(record.faultCount).toBe(0);
  });

  it("maps a media-progress timeout to an encoder stall, not a fault", () => {
    expect(
      observationForFailure("media-progress-timeout", "stalled").kind,
    ).toBe("encoder-stall");
  });

  it("never quarantines for a slow network read", () => {
    const observation = observationForFailure(
      "network-read-stall",
      "FFmpeg produced no media for 26s and was stopped at 1658.907s.",
    );
    expect(observation.kind).toBe("ok");
    const record = run(initialStorageHealth("\\\\seyirlik\\drive\\media", AT), [
      [observation, AT],
      [observation, AT + 1_000],
    ]);
    expect(record.state).toBe("healthy");
  });

  it("does not treat a full disk or a crashed encoder as a storage fault", () => {
    expect(observationForFailure("out-of-space", "ENOSPC").kind).toBe("ok");
    expect(observationForFailure("encoder", "segfault").kind).toBe("ok");
    expect(observationForFailure("unknown", "?").kind).toBe("ok");
  });

  it("keeps clean absence separate while conservatively handling legacy hard details", () => {
    expect(
      observationForFailure("storage-unavailable", "ENOENT on output").kind,
    ).toBe("absent");
    expect(
      observationForFailure("storage-unavailable", "EIO on read").kind,
    ).toBe("hard-io-fault");
    expect(
      observationForFailure("storage-unavailable", "Input/output error").kind,
    ).toBe("hard-io-fault");
  });

  it("maps explicit hard, device-loss, and ambiguous failure kinds exactly", () => {
    expect(observationForFailure("storage-io", "EIO").kind).toBe(
      "hard-io-fault",
    );
    expect(
      observationForFailure("storage-device-lost", "gone during read").kind,
    ).toBe("device-lost");
    expect(
      observationForFailure("storage-soft-fault", "temporary transport blip")
        .kind,
    ).toBe("soft-fault");
  });

  /** A missing path is the ordinary shape of a clean unmount. */
  it("does not read ENOENT as a hard I/O fault", () => {
    expect(looksLikeHardIoFault("ENOENT: no such file or directory")).toBe(
      false,
    );
    expect(looksLikeHardIoFault("ENXIO")).toBe(true);
    expect(looksLikeHardIoFault("Device not configured")).toBe(true);
  });
});

describe("what an operator is told", () => {
  it("never describes a quarantine as something that clears itself", () => {
    const quarantined = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      hardFault(),
      AT,
    );
    const sentence = describeStorageHealth(quarantined);
    expect(sentence).toContain("will not resume automatically");
  });

  it("says a clean absence recovers on its own", () => {
    const gone = applyStorageObservation(
      initialStorageHealth("/vol/media", AT),
      { kind: "absent", roots: ["/vol/media"] },
      AT,
    );
    expect(describeStorageHealth(gone)).toContain("resumes on its own");
  });
});
