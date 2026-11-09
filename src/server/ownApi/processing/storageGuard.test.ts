import { describe, expect, it, vi } from "vitest";
import {
  createStorageGuard,
  shouldRereadIncident,
  type StorageGuardEvent,
} from "./storageGuard";
import {
  healthFromIncident,
  type StorageIncidentRecord,
  type StorageIncidentStore,
} from "./storageIncidentStore";
import { STABILITY_SETTLE_MS } from "../../../renditions/processing/storageHealth";
import { createDiskutilIdentityProbe } from "../../../renditions/processing/storageIdentity";

/**
 * The guard, with the database and the volume both faked.
 *
 * The properties under test are the ones that failed in production: that a
 * quarantine is written down, that it is read back after a restart, that
 * nothing but an operator lifts it, and that the log does not become a storm
 * while it stands.
 *
 * Nothing here touches a real volume or a real database. The watchdog is a
 * function returning a boolean and the incident store is a map, which is
 * exactly the fidelity needed: the code under test never does anything with
 * storage except ask that boolean.
 */

const ROOT = "/vol/media";

/** An incident store backed by a map, with a switch for making it fail. */
function fakeIncidents(): StorageIncidentStore & {
  rows: Map<string, StorageIncidentRecord>;
  writes: number;
  failWrites: boolean;
} {
  const rows = new Map<string, StorageIncidentRecord>();
  const store = {
    rows,
    writes: 0,
    failWrites: false,
    async findOpen(root: string) {
      const row = rows.get(root);
      return row && row.clearedAtMs === null ? row : null;
    },
    async listOpen() {
      return [...rows.values()].filter((row) => row.clearedAtMs === null);
    },
    async listRecent() {
      return [...rows.values()];
    },
    async save(
      record: Parameters<StorageIncidentStore["save"]>[0],
      context: Parameters<StorageIncidentStore["save"]>[1] = {},
    ) {
      if (store.failWrites) throw new Error("the database is unavailable");
      store.writes += 1;
      const existing = rows.get(record.root);
      if (!existing && record.state === "healthy") return null;
      const row: StorageIncidentRecord = {
        ...record,
        id: existing?.id ?? "incident-1",
        failureClass: context.failureClass ?? existing?.failureClass ?? null,
        processingJobId:
          context.processingJobId ?? existing?.processingJobId ?? null,
        quarantinedAtMs:
          existing?.quarantinedAtMs ??
          (record.state === "quarantined" ? record.changedAtMs : null),
        acknowledgedBy:
          context.acknowledgedBy ?? existing?.acknowledgedBy ?? null,
        // First identity wins, exactly as the real store's COALESCE does.
        // Adoption is the one write allowed to move a recorded identity.
        identity: context.adoption
          ? (context.identity ?? null)
          : (existing?.identity ?? context.identity ?? null),
        identitySource: context.adoption
          ? "adopted"
          : (existing?.identitySource ?? (context.identity ? "probe" : null)),
        adoptedAtMs:
          context.adoption?.adoptedAtMs ?? existing?.adoptedAtMs ?? null,
        supersededVolumeUuid: context.adoption
          ? (existing?.identity?.volumeUuid ?? null)
          : (existing?.supersededVolumeUuid ?? null),
        createdAtMs: existing?.createdAtMs ?? record.changedAtMs,
        updatedAtMs: record.changedAtMs,
        clearedAtMs:
          record.state === "healthy"
            ? (record.clearedAtMs ?? record.changedAtMs)
            : null,
      };
      rows.set(record.root, row);
      return row;
    },
  };
  return store;
}

function build(
  options: {
    available?: () => boolean;
    incidents?: ReturnType<typeof fakeIncidents>;
    now?: () => number;
  } = {},
) {
  const incidents = options.incidents ?? fakeIncidents();
  const events: Array<[StorageGuardEvent, string]> = [];
  let available = true;
  const guard = createStorageGuard({
    root: ROOT,
    watchdog: {
      poll: async () => (options.available ? options.available() : available),
      get missingRoots() {
        return (options.available ? options.available() : available)
          ? []
          : [ROOT];
      },
    },
    incidents,
    /*
     * A stable identity for the volume under test. Present by default because
     * a verified recovery is the ordinary path; the tests that care about a
     * *missing* identity construct their own guard without one.
     */
    identityProbe: async () => ({
      volumeUuid: "11111111-2222-3333-4444-555555555555",
      deviceNode: "/dev/disk6s1",
      medium: "physical-external" as const,
      fsType: "exfat",
      mountPath: ROOT,
    }),
    logger: { transition: (event, detail) => events.push([event, detail]) },
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    guard,
    incidents,
    events,
    setAvailable: (value: boolean) => {
      available = value;
    },
    /*
     * What the runtime does on its first healthy poll: learn the volume's
     * identity while asking it anything is free. Tests that quarantine must do
     * this first, because identity is no longer captured at fault time — a
     * probe launched at a device that has just returned EIO is the one thing
     * this design will not do.
     */
    async establishIdentity() {
      await guard.ensureIdentity();
    },
  };
}

describe("recording a fault", () => {
  it("persists quarantine after the first source EIO", async () => {
    const { guard, incidents } = build();
    await guard.reportFailure({ kind: "source-io", detail: "EIO at LBA 9" });
    expect(guard.health.state).toBe("quarantined");
    expect(guard.health.faultCount).toBe(1);
    expect(guard.mayStartWork()).toBe(false);

    const row = await incidents.findOpen(ROOT);
    expect(row?.state).toBe("quarantined");
    expect(row?.quarantinedAtMs).not.toBeNull();
    expect(row?.failureClass).toBe("source-io");
  });

  /** The distinction that keeps a filter-graph bug from stopping a library. */
  it("ignores an encoder stall entirely", async () => {
    const { guard, incidents } = build();
    for (let index = 0; index < 5; index += 1) {
      await guard.reportFailure({
        kind: "media-progress-timeout",
        detail: "no media for 991s",
      });
    }
    expect(guard.health.state).toBe("healthy");
    expect(guard.mayStartWork()).toBe(true);
    expect(await incidents.findOpen(ROOT)).toBeNull();
  });

  it("attributes the incident to the job that was running", async () => {
    const { guard, incidents } = build();
    await guard.reportFailure({
      kind: "source-io",
      detail: "EIO",
      processingJobId: "a6b95457-443b-4ba0-9fce-ad504cc25006",
    });
    expect((await incidents.findOpen(ROOT))?.processingJobId).toBe(
      "a6b95457-443b-4ba0-9fce-ad504cc25006",
    );
  });
});

describe("a quarantine across a restart", () => {
  /**
   * The regression that mattered most. Every circuit breaker in this system
   * lived in memory, and a forced power-off — the way a kernel I/O storm ends —
   * was a reset.
   */
  it("is read back by a fresh process from the row alone", async () => {
    const incidents = fakeIncidents();
    const first = build({ incidents });
    await first.guard.reportFailure({ kind: "source-io", detail: "EIO" });
    expect(first.guard.health.state).toBe("quarantined");

    // A new process. New guard, same database, volume answering perfectly.
    const second = build({ incidents, available: () => true });
    expect(second.guard.mayStartWork()).toBe(true); // before it has read the row
    await second.guard.reload();
    expect(second.guard.health.state).toBe("quarantined");
    expect(second.guard.mayStartWork()).toBe(false);
    expect(
      second.events.some(([event]) => event === "storage.quarantined"),
    ).toBe(true);
  });

  it("is not cleared by a volume that answers every poll", async () => {
    const incidents = fakeIncidents();
    const { guard } = build({ incidents, available: () => true });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    for (let index = 0; index < 100; index += 1) {
      await guard.observeAvailability(true);
    }
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
  });
});

describe("an outage restored from the row after the volume came back", () => {
  /**
   * 2026-11-09: the Drive mount was stopped at 17:39 and back at 18:03, but no
   * running process saw it return, and after a reboot both processes read the
   * open `unavailable` row and held it. The runtime now tells the guard on
   * every present poll while it is unavailable; this is what that telling does.
   */
  it("lifts once the volume has answered past the settling period", async () => {
    const incidents = fakeIncidents();
    let clock = 1_000_000;
    const first = build({ incidents, now: () => clock });
    await first.guard.observeAvailability(false);
    expect(first.guard.health.state).toBe("unavailable");

    clock += 24 * 60_000;
    const second = build({ incidents, available: () => true, now: () => clock });
    await second.guard.reload();
    expect(second.guard.health.state).toBe("unavailable");
    expect(second.guard.mayStartWork()).toBe(false);

    await second.guard.observeAvailability(true);
    expect(second.guard.health.state).toBe("healthy");
    expect(second.guard.mayStartWork()).toBe(true);
    expect(await incidents.findOpen(ROOT)).toBeNull();
  });

  it("waits out the settling period for an outage that just began", async () => {
    let clock = 1_000_000;
    const { guard } = build({ now: () => clock });
    await guard.observeAvailability(false);

    clock += 10_000;
    await guard.observeAvailability(true);
    expect(guard.health.state).toBe("unavailable");

    clock += 60_000;
    await guard.observeAvailability(true);
    expect(guard.health.state).toBe("healthy");
  });
});

describe("the operator's way back", () => {
  it("needs a verification and then a resume", async () => {
    const incidents = fakeIncidents();
    const built = build({ incidents, available: () => true });
    const { guard } = built;
    await built.establishIdentity();
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });

    const verified = await guard.verify("operator-uuid");
    expect(verified.ok).toBe(true);
    expect(guard.health.state).toBe("recovery-pending");
    expect(guard.mayStartWork()).toBe(false);

    await guard.resume("operator-uuid");
    expect(guard.health.state).toBe("healthy");
    expect(guard.mayStartWork()).toBe(true);
    // The incident is closed rather than deleted: the history is the point.
    expect(await incidents.findOpen(ROOT)).toBeNull();
    expect(incidents.rows.get(ROOT)?.clearedAtMs).not.toBeNull();
  });

  /** Verification exercises nothing: it is the watchdog's own metadata poll. */
  it("verifies by asking the watchdog and nothing else", async () => {
    const poll = vi.fn(async () => true);
    const incidents = fakeIncidents();
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll, missingRoots: [] },
      incidents,
    });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    await guard.verify();
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("refuses to verify a volume that is not answering", async () => {
    const incidents = fakeIncidents();
    const { guard } = build({ incidents, available: () => false });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    const outcome = await guard.verify();
    expect(outcome.ok).toBe(false);
    expect(guard.health.state).toBe("quarantined");
  });
});

describe("what the log costs", () => {
  /**
   * A five-minute outage at the watchdog's five-second interval is sixty polls.
   * It must produce one line, not sixty.
   */
  it("writes one transition line and one row per state change", async () => {
    const incidents = fakeIncidents();
    const { guard, events } = build({ incidents });

    await guard.observeAvailability(false);
    for (let poll = 0; poll < 60; poll += 1) {
      await guard.observeAvailability(false);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.[0]).toBe("storage.unavailable");
    expect(incidents.writes).toBe(1);
  });

  it("announces recovery once when the volume returns and settles", async () => {
    let time = 1_000_000;
    const incidents = fakeIncidents();
    const { guard, events } = build({ incidents, now: () => time });

    await guard.observeAvailability(false);
    time += STABILITY_SETTLE_MS;
    await guard.observeAvailability(true);
    for (let poll = 0; poll < 30; poll += 1) {
      time += 5_000;
      await guard.observeAvailability(true);
    }
    expect(events.map(([event]) => event)).toEqual([
      "storage.unavailable",
      "storage.recovered",
    ]);
  });
});

describe("when the database cannot record the incident", () => {
  /**
   * The deliberately unsafe corner, pinned so it cannot get worse: a failed
   * write must not undo the in-memory verdict. Losing the row is survivable;
   * a process that concluded the storage was fine because it could not write
   * down that it was not would be the original bug with extra steps.
   */
  it("keeps the block in force for this process", async () => {
    const incidents = fakeIncidents();
    incidents.failWrites = true;
    const { guard } = build({ incidents });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
  });

  it("writes the incident once the database comes back", async () => {
    const incidents = fakeIncidents();
    incidents.failWrites = true;
    const { guard } = build({ incidents });
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    incidents.failWrites = false;
    await guard.reportFailure({ kind: "source-io", detail: "EIO" });
    expect((await incidents.findOpen(ROOT))?.state).toBe("quarantined");
  });
});

describe("reading health back from a row", () => {
  it("takes the state's age from the row, not from process start", () => {
    const row: StorageIncidentRecord = {
      id: "i",
      root: ROOT,
      state: "unavailable",
      reason: "gone",
      faultCount: 0,
      firstFaultAtMs: null,
      lastFaultAtMs: null,
      changedAtMs: 500,
      verifiedAtMs: null,
      missingRoots: [],
      clearedAtMs: null,
      failureClass: null,
      processingJobId: null,
      quarantinedAtMs: null,
      acknowledgedBy: null,
      identity: null,
      identitySource: null,
      adoptedAtMs: null,
      supersededVolumeUuid: null,
      createdAtMs: 500,
      updatedAtMs: 500,
    };
    /*
     * A settling period measured from process start would be restarted by every
     * worker restart, so a flapping volume would never be seen to flap.
     */
    expect(healthFromIncident(ROOT, row, 9_999_999).changedAtMs).toBe(500);
  });

  it("treats a cleared incident as no incident", () => {
    const cleared: StorageIncidentRecord = {
      id: "i",
      root: ROOT,
      state: "healthy",
      reason: "resumed",
      faultCount: 0,
      firstFaultAtMs: null,
      lastFaultAtMs: null,
      changedAtMs: 1,
      verifiedAtMs: 1,
      missingRoots: [],
      clearedAtMs: 2,
      failureClass: null,
      processingJobId: null,
      quarantinedAtMs: null,
      acknowledgedBy: null,
      identity: null,
      identitySource: null,
      adoptedAtMs: null,
      supersededVolumeUuid: null,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    expect(healthFromIncident(ROOT, cleared, 10).state).toBe("healthy");
  });
});

describe("one process lifting a hold that another process is enforcing", () => {
  /**
   * The two recovery presses land on the API server; the encoders run in the
   * worker. Without this the button appeared to work — the panel cleared — while
   * every held job stayed dormant until the worker was restarted by hand.
   */
  it("is seen by the worker on its next reload", async () => {
    const incidents = fakeIncidents();

    // The API server's guard, where the operator presses the buttons.
    const server = build({ incidents, available: () => true });
    // The worker's guard, which is what actually gates the encoders.
    const worker = build({ incidents, available: () => true });

    await server.establishIdentity();
    await server.guard.reportFailure({ kind: "source-io", detail: "EIO" });
    await worker.guard.reload();
    expect(worker.guard.mayStartWork()).toBe(false);

    await server.guard.verify("operator");
    await worker.guard.reload();
    // Verified is not resumed: the worker must still refuse.
    expect(worker.guard.mayStartWork()).toBe(false);

    await server.guard.resume("operator");
    await worker.guard.reload();
    expect(worker.guard.mayStartWork()).toBe(true);
  });

  /** A worker reload must not resurrect a hold the operator has cleared. */
  it("does not re-apply a cleared incident on a later reload", async () => {
    const incidents = fakeIncidents();
    const server = build({ incidents, available: () => true });
    const worker = build({ incidents, available: () => true });

    await server.establishIdentity();
    await server.guard.reportFailure({ kind: "source-io", detail: "EIO" });
    await server.guard.verify("operator");
    await server.guard.resume("operator");

    for (let index = 0; index < 5; index += 1) {
      await worker.guard.reload();
    }
    expect(worker.guard.mayStartWork()).toBe(true);
  });
});

describe("when the incident record cannot be read at startup", () => {
  /**
   * The subtle way back to "healthy" that had to be closed.
   *
   * A guard is constructed healthy — it must be, or every process would
   * announce an outage on startup — and `reload` is what replaces that
   * assumption with the recorded truth. A read that throws and is swallowed
   * leaves the assumption standing, so a process comes up believing a
   * quarantined volume is fine: the original defect exactly, concluding health
   * from absence of evidence rather than from evidence.
   */
  it("blocks work rather than assuming the storage is fine", async () => {
    const incidents = fakeIncidents();
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents: {
        ...incidents,
        findOpen: async () => {
          throw new Error("Connection terminated due to connection timeout");
        },
      },
    });

    expect(guard.mayStartWork()).toBe(true); // constructed optimistic
    await guard.reload();
    expect(guard.mayStartWork()).toBe(false);
    expect(guard.health.state).toBe("recovery-pending");
  });

  /** And it un-blocks by itself once the row can actually be read. */
  it("clears on the next reload that succeeds", async () => {
    const incidents = fakeIncidents();
    let broken = true;
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents: {
        ...incidents,
        findOpen: async (root) => {
          if (broken) throw new Error("database is unavailable");
          return incidents.findOpen(root);
        },
      },
    });

    await guard.reload();
    expect(guard.mayStartWork()).toBe(false);

    broken = false;
    await guard.reload();
    expect(guard.mayStartWork()).toBe(true);
  });

  /** A real quarantine still wins once the row is legible again. */
  it("still surfaces a genuine quarantine once the read recovers", async () => {
    const incidents = fakeIncidents();
    const writer = build({ incidents });
    await writer.establishIdentity();
    await writer.guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    let broken = true;
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents: {
        ...incidents,
        findOpen: async (root) => {
          if (broken) throw new Error("database is unavailable");
          return incidents.findOpen(root);
        },
      },
    });

    await guard.reload();
    expect(guard.health.state).toBe("recovery-pending");
    broken = false;
    await guard.reload();
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
  });
});

describe("verification is gated on volume identity, not on the path answering", () => {
  const EXPANSION = {
    volumeUuid: "11111111-2222-3333-4444-555555555555",
    deviceNode: "/dev/disk6s1",
    medium: "physical-external" as const,
    fsType: "exfat",
    mountPath: ROOT,
  };
  const E2E_IMAGE = {
    volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    deviceNode: "/dev/disk4s2",
    medium: "disk-image" as const,
    fsType: "hfs",
    mountPath: ROOT,
  };

  function guardWithIdentity(
    incidents: StorageIncidentStore,
    identity: () => typeof EXPANSION | typeof E2E_IMAGE | null,
  ) {
    return createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async () => identity(),
    });
  }

  /**
   * The hole this closes. Verification used to ask only "does something answer
   * at this path", so attaching any volume there passed — which would hand back
   * a green light for hardware nobody repaired.
   */
  it("refuses a disk image mounted where the quarantined drive was", async () => {
    const incidents = fakeIncidents();
    let present: typeof EXPANSION | typeof E2E_IMAGE = EXPANSION;
    const guard = guardWithIdentity(incidents, () => present);

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    expect(guard.health.state).toBe("quarantined");
    // The identity was captured while the failing drive was still attached.
    expect((await incidents.findOpen(ROOT))?.identity?.volumeUuid).toBe(
      EXPANSION.volumeUuid,
    );

    present = E2E_IMAGE;
    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(false);
    expect(verified.detail).toContain("a disk image");
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
  });

  it("accepts the same drive back on a different device node", async () => {
    const incidents = fakeIncidents();
    let present = EXPANSION;
    const guard = guardWithIdentity(incidents, () => present);

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    present = { ...EXPANSION, deviceNode: "/dev/disk11s1" };

    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(true);
    expect(guard.health.state).toBe("recovery-pending");
    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });

  /** Identity that cannot be read is a refusal, never a pass. */
  it("fails closed when no identity can be established", async () => {
    const incidents = fakeIncidents();
    let present: typeof EXPANSION | null = EXPANSION;
    const guard = guardWithIdentity(incidents, () => present);

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    present = null;

    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(false);
    expect(guard.mayStartWork()).toBe(false);
  });

  /**
   * A quarantine recorded before identity existed — or while no probe was
   * available — has nothing to compare, so it cannot be satisfied automatically.
   * The path answering is not evidence.
   */
  it("fails closed for a quarantine recorded without any identity", async () => {
    const incidents = fakeIncidents();
    // No probe at all: this is the pre-identity deployment.
    const withoutProbe = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
    });
    await withoutProbe.reportFailure({ kind: "storage-io", detail: "EIO" });
    expect((await incidents.findOpen(ROOT))?.identity).toBeNull();

    // A later process does have a probe, and a volume is present.
    const withProbe = guardWithIdentity(incidents, () => EXPANSION);
    await withProbe.reload();
    const verified = await withProbe.verify("operator");
    expect(verified.ok).toBe(false);
    expect(verified.detail).toContain("without a volume identity");
    expect(withProbe.mayStartWork()).toBe(false);
  });

  /**
   * The recorded identity is written once. Re-recording it on a later fault
   * would let whatever is mounted now become the thing recovery is checked
   * against, which is the failure in a different disguise.
   */
  it("never lets a later mount overwrite the recorded identity", async () => {
    const incidents = fakeIncidents();
    let present: typeof EXPANSION | typeof E2E_IMAGE = EXPANSION;
    const guard = guardWithIdentity(incidents, () => present);

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    present = E2E_IMAGE;
    await guard.reportFailure({ kind: "storage-io", detail: "EIO again" });

    expect((await incidents.findOpen(ROOT))?.identity?.volumeUuid).toBe(
      EXPANSION.volumeUuid,
    );
  });

  /**
   * An unclean restart is not a fault and has no identity on record, so the
   * metadata check remains the whole of its verification — otherwise a
   * deployment with no probe could never clear a recovery-pending hold.
   */
  it("still verifies a recovery-pending hold on the metadata check alone", async () => {
    const incidents = fakeIncidents();
    const guard = guardWithIdentity(incidents, () => null);
    await guard.reportUncleanRestart({ detail: "job still running" });
    expect(guard.health.state).toBe("recovery-pending");

    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(true);
    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });
});

describe("adopting storage instead of ignoring identity", () => {
  const ORIGINAL = {
    volumeUuid: "11111111-1111-1111-1111-111111111111",
    deviceNode: "/dev/disk6s1",
    medium: "physical-external" as const,
    fsType: "exfat",
    mountPath: ROOT,
  };
  const REPLACEMENT = {
    volumeUuid: "22222222-2222-2222-2222-222222222222",
    deviceNode: "/dev/disk7s1",
    medium: "physical-external" as const,
    fsType: "exfat",
    mountPath: ROOT,
  };
  const THIRD = {
    ...REPLACEMENT,
    volumeUuid: "33333333-3333-3333-3333-333333333333",
  };

  function guardWith(
    incidents: StorageIncidentStore,
    present: () => typeof ORIGINAL | null,
    events: Array<[string, string]> = [],
  ) {
    return createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async () => present(),
      logger: { transition: (event, detail) => events.push([event, detail]) },
    });
  }

  /** 1. A quarantine with no recorded identity, adopted from a real probe. */
  it("adopts a volume for a legacy quarantine that recorded no identity", async () => {
    const incidents = fakeIncidents();
    // No probe at all while healthy, so nothing is cached: the legacy case.
    const legacy = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
    });
    await legacy.reportFailure({ kind: "storage-io", detail: "EIO" });
    expect((await incidents.findOpen(ROOT))?.identity).toBeNull();

    const guard = guardWith(incidents, () => ORIGINAL);
    await guard.reload();
    // Ordinary verification refuses: there is nothing to match against.
    expect((await guard.verify("operator")).ok).toBe(false);

    const adopted = await guard.adopt("operator");
    expect(adopted.ok).toBe(true);
    expect(adopted.adopted?.volumeUuid).toBe(ORIGINAL.volumeUuid);

    const row = await incidents.findOpen(ROOT);
    expect(row?.identity?.volumeUuid).toBe(ORIGINAL.volumeUuid);
    expect(row?.identitySource).toBe("adopted");
    expect(row?.adoptedAtMs).not.toBeNull();
  });

  /** 2. A probe that errors is not an adoption. */
  it("refuses to adopt when the probe fails", async () => {
    const incidents = fakeIncidents();
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async () => {
        throw new Error("diskutil failed");
      },
    });
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    const adopted = await guard.adopt("operator");
    expect(adopted.ok).toBe(false);
    expect(guard.mayStartWork()).toBe(false);
  });

  /** 3. A volume with no UUID has nothing to adopt. */
  it("refuses to adopt a volume that reports no UUID", async () => {
    const incidents = fakeIncidents();
    const guard = guardWith(
      incidents,
      () =>
        ({
          ...ORIGINAL,
          volumeUuid: null,
        }) as never,
    );
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    const adopted = await guard.adopt("operator");
    expect(adopted.ok).toBe(false);
    expect(adopted.detail).toContain("did not report an identity");
    expect(guard.mayStartWork()).toBe(false);
  });

  /** 4 & 5. A mismatch is never bypassable through the ordinary flow. */
  it("refuses ordinary verify and resume for a different volume", async () => {
    const incidents = fakeIncidents();
    let present = ORIGINAL;
    const guard = guardWith(incidents, () => present);
    await guard.observeAvailability(true); // identity cached while healthy
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    present = REPLACEMENT;
    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(false);
    expect(verified.outcome).toBe("identity-unconfirmed");

    // And resume alone cannot move it: the state never reached recovery-pending.
    await guard.resume("operator");
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
  });

  /** 6. Replacement hardware, adopted deliberately, with history kept. */
  it("adopts replacement storage, records it, and keeps the superseded UUID", async () => {
    const incidents = fakeIncidents();
    const events: Array<[string, string]> = [];
    let present = ORIGINAL;
    const guard = guardWith(incidents, () => present, events);
    await guard.observeAvailability(true);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    present = REPLACEMENT;
    const adopted = await guard.adopt("operator");
    expect(adopted.ok).toBe(true);

    const row = await incidents.findOpen(ROOT);
    expect(row?.identity?.volumeUuid).toBe(REPLACEMENT.volumeUuid);
    expect(row?.supersededVolumeUuid).toBe(ORIGINAL.volumeUuid);
    expect(row?.identitySource).toBe("adopted");
    expect(events.some(([event]) => event === "storage.identity_adopted")).toBe(
      true,
    );

    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });

  /** 7. After adoption, strictness resumes against the new UUID. */
  it("rejects a third volume normally once a replacement is adopted", async () => {
    const incidents = fakeIncidents();
    let present = ORIGINAL;
    const guard = guardWith(incidents, () => present);
    await guard.observeAvailability(true);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    present = REPLACEMENT;
    await guard.adopt("operator");
    await guard.resume("operator");

    // The replacement now fails in its turn.
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    present = THIRD;
    const verified = await guard.verify("operator");
    expect(verified.ok).toBe(false);
    expect(guard.mayStartWork()).toBe(false);
  });

  /** 8. Nothing automatic can adopt. */
  it("is never reached by polling, reload, or a fault", async () => {
    const incidents = fakeIncidents();
    let present = ORIGINAL;
    const guard = guardWith(incidents, () => present);
    await guard.observeAvailability(true);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    present = REPLACEMENT;
    for (let poll = 0; poll < 50; poll += 1) {
      await guard.observeAvailability(true);
    }
    await guard.reload();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO again" });

    const row = await incidents.findOpen(ROOT);
    expect(row?.identity?.volumeUuid).toBe(ORIGINAL.volumeUuid);
    expect(row?.identitySource).toBe("probe");
    expect(guard.mayStartWork()).toBe(false);
  });

  /** 9. The two outcomes are reported distinctly. */
  it("distinguishes a verified recovery from an adoption", async () => {
    const incidents = fakeIncidents();
    let present = ORIGINAL;
    const guard = guardWith(incidents, () => present);
    await guard.observeAvailability(true);
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    const verified = await guard.verify("operator");
    expect(verified.outcome).toBe("same-identity-verified");
    await guard.resume("operator");

    // Now a genuine replacement, which must not claim the same thing.
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    present = REPLACEMENT;
    const refused = await guard.verify("operator");
    expect(refused.outcome).toBe("identity-unconfirmed");
    const adopted = await guard.adopt("operator");
    expect(adopted.detail).toContain("adopted replacement storage");
    expect((await incidents.findOpen(ROOT))?.identitySource).toBe("adopted");
  });
});

describe("never probing a device that has just hard-failed", () => {
  const IDENTITY = {
    volumeUuid: "11111111-1111-1111-1111-111111111111",
    deviceNode: "/dev/disk6s1",
    medium: "physical-external" as const,
    fsType: "exfat",
    mountPath: ROOT,
  };

  /**
   * A probe that counts, so "zero probes after the fault" is asserted rather
   * than assumed.
   *
   * The behaviour under test is the second safety point, and it is easy to get
   * backwards: an earlier version captured identity "at the instant health
   * first leaves healthy", which reads as careful and means launching
   * `diskutil` at the device that has just returned `EIO`. On the drive this
   * exists for, that is another process entering the same kernel retry path the
   * encoder is being pulled out of.
   */
  function countingGuard(incidents: StorageIncidentStore) {
    const calls: string[] = [];
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async (path) => {
        calls.push(path);
        return IDENTITY;
      },
    });
    return { guard, calls };
  }

  /** 1. Identity is known before any heavy work is allowed to begin. */
  it("captures identity while the storage is healthy", async () => {
    const { guard, calls } = countingGuard(fakeIncidents());
    expect(calls).toHaveLength(0);

    await guard.ensureIdentity();
    expect(calls).toHaveLength(1);
    expect(guard.identity.cached?.volumeUuid).toBe(IDENTITY.volumeUuid);

    // Cached: the ordinary poll loop must not spawn a process per tick.
    for (let poll = 0; poll < 25; poll += 1) {
      await guard.observeAvailability(true);
    }
    expect(calls).toHaveLength(1);
  });

  /** 2–5. Every hard signal, and none of them may touch the device. */
  const hardFaults = [
    ["EIO", { kind: "storage-io" as const, detail: "EIO: input/output error" }],
    [
      "ENXIO",
      {
        kind: "storage-io" as const,
        detail: "ENXIO: no such device or address",
      },
    ],
    [
      "an FFmpeg input/output error",
      { kind: "source-io" as const, detail: "Input/output error" },
    ],
    [
      "a device disappearance",
      {
        kind: "storage-device-lost" as const,
        detail: "the device disappeared during a read",
      },
    ],
  ] as const;

  for (const [name, failure] of hardFaults) {
    it(`performs zero identity probes after ${name}`, async () => {
      const incidents = fakeIncidents();
      const { guard, calls } = countingGuard(incidents);

      await guard.ensureIdentity();
      const before = calls.length;
      expect(before).toBe(1);

      await guard.reportFailure(failure);
      expect(guard.health.state).toBe("quarantined");

      /*
       * The assertion this whole block exists for. Not "few probes" — none.
       */
      expect(calls).toHaveLength(before);

      // The quarantine still carries the identity, from the healthy capture.
      expect((await incidents.findOpen(ROOT))?.identity?.volumeUuid).toBe(
        IDENTITY.volumeUuid,
      );

      // And nothing that follows a fault asks either.
      for (let poll = 0; poll < 20; poll += 1) {
        await guard.observeAvailability(true);
      }
      await guard.reload();
      expect(calls).toHaveLength(before);
    });
  }

  /** 6. No cached identity is still an immediate, fail-closed quarantine. */
  it("quarantines with no identity rather than probing the sick device", async () => {
    const incidents = fakeIncidents();
    const { guard, calls } = countingGuard(incidents);

    // Deliberately never healthy-probed: the fault arrives first.
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    expect(calls).toHaveLength(0);
    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
    expect((await incidents.findOpen(ROOT))?.identity).toBeNull();
  });

  /** 7. The operator's verification is the one moment a probe is right. */
  it("probes the current volume when an operator verifies", async () => {
    const incidents = fakeIncidents();
    const { guard, calls } = countingGuard(incidents);
    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    const beforeVerify = calls.length;

    const verified = await guard.verify("operator");
    expect(calls.length).toBe(beforeVerify + 1);
    expect(verified.ok).toBe(true);
    expect(verified.outcome).toBe("same-identity-verified");
  });

  /** 8. And probing during recovery does not by itself clear anything. */
  it("does not let the recovery probe clear the quarantine on its own", async () => {
    const incidents = fakeIncidents();
    const { guard } = countingGuard(incidents);
    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    await guard.verify("operator");
    // Verified is not resumed.
    expect(guard.mayStartWork()).toBe(false);
    await guard.resume("operator");
    expect(guard.mayStartWork()).toBe(true);
  });

  /** 9. A quarantine stands even when the identity service is broken. */
  it("still quarantines when the identity probe is unavailable", async () => {
    const incidents = fakeIncidents();
    let probes = 0;
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async () => {
        probes += 1;
        throw new Error("diskutil is not available");
      },
    });

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });

    expect(guard.health.state).toBe("quarantined");
    expect(guard.mayStartWork()).toBe(false);
    expect((await incidents.findOpen(ROOT))?.state).toBe("quarantined");
    // The failing probe was tried once, while healthy, and never after.
    expect(probes).toBe(1);
  });

  /**
   * 10. Identity costs no media read. The probe is handed a path and returns
   * metadata; nothing in this file opens a file on the volume, which is what
   * makes it safe to run on a drive an operator has just reconnected.
   */
  it("establishes and verifies identity without reading any media", async () => {
    const incidents = fakeIncidents();
    const paths: string[] = [];
    const guard = createStorageGuard({
      root: ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents,
      identityProbe: async (path) => {
        paths.push(path);
        return IDENTITY;
      },
    });

    await guard.ensureIdentity();
    await guard.reportFailure({ kind: "storage-io", detail: "EIO" });
    await guard.verify("operator");

    // Only ever the root itself, never a file beneath it.
    expect(new Set(paths)).toEqual(new Set([ROOT]));
  });
});

/**
 * The production incident this whole gate was found by.
 *
 * The media root is `/Volumes/Expansion/media` — a directory *on* the external
 * volume, which is how every deployment configures it. The probe handed that
 * path straight to `diskutil info -plist`, which takes a device or a mount
 * point and exits 1 on anything else, so it returned `null`. The gate then did
 * exactly what it is written to do with no identity on a `/Volumes` path: held
 * the work. Every job parked `paused / waiting / recovery-pending` against a
 * USB disk that was healthy, mounted and answering.
 *
 * So this runs the real probe against a fake host rather than a fake probe: the
 * bug lived in the wiring between the two, and a stub identity would have
 * passed throughout.
 */
describe("a healthy external volume configured by a path inside it", () => {
  const MEDIA_ROOT = "/Volumes/Expansion/media";

  /** This machine's actual `df` and `diskutil` output, trimmed. */
  const run = async (command: string, args: readonly string[]) => {
    if (command === "/bin/df") {
      return `Filesystem   512-blocks       Used  Available Capacity  Mounted on\n/dev/disk4s1 3906904320 2754344448 1152559872    71%    /Volumes/Expansion\n`;
    }
    if (args[args.length - 1] !== "/dev/disk4s1") {
      // What the old code did, and what the real diskutil answers to it.
      throw new Error("the volume identity probe failed with exit code 1");
    }
    return `<plist><dict>
      <key>BusProtocol</key><string>USB</string>
      <key>DeviceIdentifier</key><string>disk4s1</string>
      <key>DeviceNode</key><string>/dev/disk4s1</string>
      <key>FilesystemType</key><string>exfat</string>
      <key>Internal</key><false/>
      <key>MountPoint</key><string>/Volumes/Expansion</string>
      <key>VolumeUUID</key><string>885D7C8D-8088-315E-AAFF-0B9537DADFD8</string>
    </dict></plist>`;
  };

  function guardForMediaRoot() {
    return createStorageGuard({
      root: MEDIA_ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents: fakeIncidents(),
      identityProbe: createDiskutilIdentityProbe({ run }),
    });
  }

  it("identifies the volume and lets processing start", async () => {
    const guard = guardForMediaRoot();

    await guard.observeAvailability(true);
    expect(guard.identity.cached?.volumeUuid).toBe(
      "885D7C8D-8088-315E-AAFF-0B9537DADFD8",
    );
    expect(guard.identity.cached?.medium).toBe("physical-external");
    expect(guard.identity.cached?.fsType).toBe("exfat");

    expect(guard.identityPermitsWork()).toEqual({ ok: true });
    expect(guard.mayStartWork()).toBe(true);
    expect(guard.health.state).toBe("healthy");
  });

  /**
   * The gate itself is untouched: give it a probe that still cannot identify
   * the volume and it holds the work exactly as it did on the day. What changed
   * is that the probe can now answer, not that the refusal got weaker.
   */
  it("still holds work when the volume genuinely cannot be identified", async () => {
    const guard = createStorageGuard({
      root: MEDIA_ROOT,
      watchdog: { poll: async () => true, missingRoots: [] },
      incidents: fakeIncidents(),
      identityProbe: async () => null,
    });

    await guard.observeAvailability(true);
    const verdict = guard.identityPermitsWork();
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "could not be established",
    );
  });
});

/**
 * Which process re-reads the incident row, and when.
 *
 * The hold is raised in the worker and lifted in the API server, so neither
 * process sees the whole of it from memory. The worker used to be the only one
 * that re-read the row, which left the server believing whatever the storage
 * had been when it started: it went on accepting job resumes the worker then
 * refused a second later — the job flicking to running and back to paused with
 * no error — and refused to lift a hold it had never heard of, which left the
 * operator with an incident on screen and no press that could clear it.
 */
describe("re-reading the incident row from the other process", () => {
  const check = (runWorker: boolean, mayStartWork: boolean) =>
    shouldRereadIncident({ runWorker, mayStartWork });

  it("has the worker watch for a lift it cannot perform itself", () => {
    expect(check(true, false)).toBe(true);
  });

  it("does not have the worker re-read while work may start", () => {
    // It is the only thing that could have held the storage, so it would be
    // asking the database to confirm its own last decision.
    expect(check(true, true)).toBe(false);
  });

  it("has the server watch for a hold raised behind its back", () => {
    expect(check(false, true)).toBe(true);
  });

  it("does not have the server re-read while it is already held", () => {
    // The server performs the lift, so a hold it knows about stays put until
    // an operator presses, and that press is its own.
    expect(check(false, false)).toBe(false);
  });

  it("covers both directions between the two processes", () => {
    // Whatever the storage is doing, exactly one of the pair is watching it.
    for (const mayStartWork of [true, false]) {
      const watchers = [true, false].filter((runWorker) =>
        check(runWorker, mayStartWork),
      );
      expect(watchers).toHaveLength(1);
    }
  });
});
