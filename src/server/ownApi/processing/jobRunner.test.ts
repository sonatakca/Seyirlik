import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { decideProcessing } from "../../../renditions/processing/decide";
import { checkpointRoot } from "../../../renditions/adaptive/epochs/checkpoints";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  createFileRenditionRegistryStore,
  loadRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "../../../renditions/registry";
import { createProcessingJobRunner } from "./jobRunner";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import type { PauseController } from "../../../renditions/processing/pauseController";
import { AUTOMATIC_REQUEUE_PAUSE_REASON } from "./interruptedJobs";
import type { StorageGuard } from "./storageGuard";
import {
  demandsStop,
  initialStorageHealth,
  mayStartWork,
  resumesAutomatically,
  type StorageHealthRecord,
  type StorageHealthState,
} from "../../../renditions/processing/storageHealth";
import type { ProcessingStage } from "./stages";

function record(
  overrides: Partial<ProcessingJobRecord> = {},
): ProcessingJobRecord {
  return {
    id: "job-1",
    jobId: "queue-1",
    itemId: "item-1",
    mediaFileId: "file-1",
    sourceFingerprint: "f".repeat(64),
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    streamDecisions: null,
    validation: null,
    sourceDamage: null,
    scratchIdentity: null,
    warnings: [],
    errorCode: null,
    errorMessage: null,
    stagingDirectory: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    checkpointBytes: 0,
    freeBytes: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function probe(
  overrides: Partial<RenditionMediaProbe> = {},
): RenditionMediaProbe {
  return {
    durationSeconds: 300,
    video: {
      streamIndex: 0,
      codec: "h264",
      width: 3840,
      height: 1604,
      rotation: 0,
      frameRate: 23.976,
      bitDepth: 10,
      isHdr: true,
    },
    audioTracks: [
      {
        streamIndex: 1,
        codec: "aac",
        channels: 8,
        language: "eng",
        isDefault: true,
        isCommentary: false,
        isVisualImpaired: false,
        isOriginal: false,
      },
    ],
    subtitleTracks: [],
    chapters: [],
    ...overrides,
  };
}

const hardware: HardwareReport = {
  platform: "darwin",
  ffmpegPath: "ffmpeg",
  probedAt: "2026-01-01T00:00:00.000Z",
  adapters: [
    {
      id: "videotoolbox",
      label: "Apple VideoToolbox",
      platform: "darwin",
      available: true,
      lanes: [],
    },
  ],
  selected: {
    h264: "h264_videotoolbox",
    hevc: "hevc_videotoolbox",
    hevcTenBit: "hevc_videotoolbox",
  },
  selectedAdapter: {
    h264: "videotoolbox",
    hevc: "videotoolbox",
    hevcTenBit: "videotoolbox",
  },
};

function fakeStore() {
  let current = record();
  const events: Array<{
    stage: ProcessingStage;
    message: string;
    level: string;
  }> = [];
  const updates: Array<Parameters<ProcessingJobStore["update"]>[1]> = [];
  const store = {
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update) => {
      updates.push(update);
      // Mirrors the store's own monotonic guard.
      const nextOverall =
        update.overallProgress === undefined
          ? current.overallProgress
          : Math.max(current.overallProgress, update.overallProgress);
      current = {
        ...current,
        ...update,
        overallProgress: nextOverall,
      } as ProcessingJobRecord;
      return current;
    }),
    appendEvent: vi.fn(async (input) => {
      events.push({
        stage: input.stage,
        message: input.message,
        level: input.level ?? "info",
      });
      return {
        id: events.length,
        processingJobId: input.processingJobId,
        sequence: events.length,
        stage: input.stage,
        level: input.level ?? "info",
        message: input.message,
        detail: input.detail ?? null,
        createdAt: new Date(),
      };
    }),
    incrementAttempts: vi.fn(async () => 1),
  } as unknown as ProcessingJobStore;
  return {
    store,
    events,
    updates,
    setCancelled: () => {
      current = { ...current, cancellationRequested: true };
    },
    /** What pressing Pause on the page does to the durable record. */
    setOperatorPaused: () => {
      current = {
        ...current,
        pauseRequested: true,
        pausedReason: "operator",
      };
    },
    /** What the storage watchdog does when the volume disappears. */
    setStorageUnavailable: () => {
      current = {
        ...current,
        pauseRequested: true,
        pausedReason: "storage-unavailable",
      };
    },
    latest: () => current,
  };
}

/**
 * A guard whose state a test can move, because the bug lives in the gap
 * between two readings of it.
 *
 * The real guard reaches `quarantined` through an incident row and a fault
 * count, and cannot be walked back to `unavailable` from the outside — which
 * is precisely the sequence the drive produces on its own and which no test
 * could otherwise stage. The predicates are the real ones, so the only thing
 * faked here is the clock.
 */
function fakeGuard(initial: StorageHealthState = "healthy") {
  let state = initial;
  const health = (): StorageHealthRecord => ({
    ...initialStorageHealth("/media", 0),
    state,
    reason: `The media volume is ${state}.`,
  });
  const guard: StorageGuard = {
    get health() {
      return health();
    },
    mayStartWork: () => mayStartWork(state),
    demandsStop: () => demandsStop(state),
    resumesAutomatically: () => resumesAutomatically(state),
    describe: () => `The media volume is ${state}.`,
    observeAvailability: async () => health(),
    reportFailure: async () => health(),
    reportUncleanRestart: async () => health(),
    verify: async () => ({
      ok: false,
      detail: "not asked in this test",
      outcome: "unavailable" as const,
      health: health(),
    }),
    resume: async () => health(),
    ensureIdentity: async () => null,
    identity: { recorded: null, cached: null },
    adopt: async () => ({
      ok: false,
      detail: "not asked in this test",
      adopted: null,
      health: health(),
    }),
    identityPermitsWork: () => ({ ok: true }),
    reload: async () => health(),
    incident: async () => null,
  };
  return {
    guard,
    becomes: (next: StorageHealthState) => {
      state = next;
    },
  };
}

const paths = {
  mediaRoot: "/media",
  renditionRoot: "/outputs",
  stateRoot: mkdtempSync(path.join(tmpdir(), "seyirlik-runner-")),
} as never;

function runner(
  fake: ReturnType<typeof fakeStore>,
  packageFn: ReturnType<typeof vi.fn>,
  softwareThreads?: number,
) {
  return createProcessingJobRunner({
    store: fake.store,
    paths,
    mediaRoot: "/media",
    detectHardwareFn: vi.fn(async () => hardware) as never,
    probeFn: vi.fn(async () => probe()) as never,
    packageFn: packageFn as never,
    ...(softwareThreads === undefined ? {} : { softwareThreads }),
  });
}

const input = {
  processingJobId: "job-1",
  sourcePath: "/media/Movies/Dune.mp4",
  relativePath: "Movies/Dune.mp4",
  sizeBytes: 477_590_241,
  mtimeMs: 1_787_938_172_390,
};

describe("processing job runner", () => {
  let fake: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    fake = fakeStore();
  });

  it("publishes a validated package and completes", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 149_000_000,
    }));

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("succeeded");
    expect(fake.latest().state).toBe("succeeded");
    expect(fake.latest().stage).toBe("complete");
    expect(fake.latest().overallProgress).toBe(1);
    expect(fake.latest().publishedVersion).toBe(
      "cmaf-hls-aligned-v2-abcdef0123456789",
    );
  });

  it.each(["removed", "replaced"])(
    "does not mark a %s source ready after encoding",
    async (change) => {
      const stateRoot = mkdtempSync(
        path.join(tmpdir(), "seyirlik-runner-source-change-"),
      );
      const registry = createFileRenditionRegistryStore(
        path.join(stateRoot, "registry.json"),
      );
      const outcome = await createProcessingJobRunner({
        store: fake.store,
        paths: { ...(paths as object), stateRoot } as never,
        registry,
        mediaRoot: "/media",
        detectHardwareFn: vi.fn(async () => hardware) as never,
        probeFn: vi.fn(async () => probe()) as never,
        packageFn: vi.fn(async () => {
          await registry.update((current) => {
            if (change === "removed") current.items = [];
            else current.items[0]!.sourceFingerprint = "b".repeat(64);
          });
          return {
            mediaId: "file-1",
            relativePath: "Movies/Dune.mp4",
            status: "ready" as const,
            versionDirectory: "version",
          };
        }) as never,
      }).run(input);
      expect(outcome).toMatchObject({ status: "failed", retryable: true });
      const items = (await registry.read()).items;
      if (change === "removed") expect(items).toEqual([]);
      else
        expect(items[0]).toMatchObject({ sourceFingerprint: "b".repeat(64) });
      expect(items[0]?.adaptiveStatus).not.toBe("ready");
      rmSync(stateRoot, { recursive: true, force: true });
    },
  );

  it("does not call the job a success until playback can find its package", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-runner-"));
    const file = createFileRenditionRegistryStore(
      path.join(stateRoot, "registry.json"),
    );
    let writes = 0;
    const registry = {
      read: file.read,
      revision: file.revision,
      update: <T>(mutate: Parameters<typeof file.update<T>>[0]) => {
        writes += 1;
        // The start-of-job registration lands; the ready write does not.
        if (writes === 2)
          return Promise.reject(new Error("connection terminated"));
        return file.update(mutate);
      },
    };
    const outcome = await createProcessingJobRunner({
      store: fake.store,
      paths: { ...(paths as object), stateRoot } as never,
      registry,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: vi.fn(async () => ({
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
        versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
        storageBytes: 149_000_000,
      })) as never,
    }).run(input);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(fake.latest().state).toBe("failed");
    expect(fake.latest().errorMessage).toContain("connection terminated");
    expect((await file.read()).items[0]?.adaptiveStatus).toBeUndefined();
  });

  it("walks the stages in order and records each one", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "v2-abc",
    }));

    await runner(fake, packageFn).run(input);

    const stages = fake.events.map((event) => event.stage);
    expect(stages).toContain("analysing");
    expect(stages.indexOf("analysing")).toBeLessThan(
      stages.indexOf("planning"),
    );
    expect(stages.indexOf("planning")).toBeLessThan(stages.indexOf("video"));
    expect(stages.indexOf("video")).toBeLessThan(stages.indexOf("validating"));
    expect(stages.indexOf("validating")).toBeLessThan(
      stages.indexOf("publishing"),
    );
  });

  it("records the language decisions where an operator can read them", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    expect(fake.events.map((event) => event.message).join(" | ")).toContain(
      "Keeping English",
    );
  });

  /** A package that fails validation must never reach the player. */
  it("does not publish a package that failed validation", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "validation-failed" as const,
      issues: ["segment boundary drifted"],
    }));

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("VALIDATION_FAILED");
    expect(fake.latest().publishedVersion).toBeNull();
    expect(fake.latest().validation).toEqual({
      ok: false,
      issues: ["segment boundary drifted"],
    });
  });

  /**
   * Running out of room halfway through leaves a staging directory to clean up
   * by hand, so the shortfall has to stop the job before any encoding starts.
   */
  it.each([
    { correctSource: true, owned: true, resumes: true },
    { correctSource: false, owned: true, resumes: false },
    { correctSource: true, owned: false, resumes: false },
  ])(
    "credits only owned matching scratch: $correctSource/$owned",
    async ({ correctSource, owned, resumes }) => {
      const estimate = decideProcessing({
        probe: probe(),
        container: "mp4",
        sizeBytes: input.sizeBytes,
        hardware,
      }).estimate;
      const required =
        estimate.outputBytes + estimate.stagingBytes + estimate.reserveBytes;
      const workRoot = (paths as unknown as { stateRoot: string }).stateRoot;
      const own = path.join(workRoot, "job-1");
      mkdirSync(own, { recursive: true });
      writeFileSync(
        path.join(own, ".seyirlik-job.json"),
        JSON.stringify({
          owner: owned ? "seyirlik-processing-job" : "operator",
          workspaceId: "job-1",
        }),
      );
      const root = checkpointRoot(
        workRoot,
        "job-1",
        ADAPTIVE_PROFILE_VERSION,
        correctSource ? fake.latest().sourceFingerprint : "x".repeat(64),
      );
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "retained.m4s"), Buffer.alloc(1024 * 1024));
      const packageFn = vi.fn(async () => ({
        mediaId: "file-1",
        relativePath: input.relativePath,
        status: "ready" as const,
        versionDirectory: "version",
        storageBytes: 1,
      }));
      const localRunner = createProcessingJobRunner({
        store: fake.store,
        paths,
        mediaRoot: "/media",
        detectHardwareFn: vi.fn(async () => hardware) as never,
        probeFn: vi.fn(async () => probe()) as never,
        packageFn: packageFn as never,
        freeBytesFn: vi.fn(async () => required - 512 * 1024) as never,
      });
      const outcome = await localRunner.run(input);
      if (resumes) {
        expect(packageFn).toHaveBeenCalledOnce();
        expect(outcome.status).toBe("succeeded");
      } else {
        expect(packageFn).not.toHaveBeenCalled();
        expect(outcome.errorCode).toBe("INSUFFICIENT_DISK_SPACE");
      }
      rmSync(own, { recursive: true, force: true });
    },
  );

  it.each([
    { withPackage: true, resumes: true },
    { withPackage: false, resumes: false },
  ])(
    "credits an unverified package a restart will rebuild: $withPackage",
    async ({ withPackage, resumes }) => {
      // A restart mid-validation: the checkpoints and an assembled package
      // with no verified marker. The packager removes that package before it
      // re-assembles, so its bytes count as space that comes back.
      const estimate = decideProcessing({
        probe: probe(),
        container: "mp4",
        sizeBytes: input.sizeBytes,
        hardware,
      }).estimate;
      const required =
        estimate.outputBytes + estimate.stagingBytes + estimate.reserveBytes;
      const workRoot = (paths as unknown as { stateRoot: string }).stateRoot;
      const own = path.join(workRoot, "job-1");
      mkdirSync(own, { recursive: true });
      writeFileSync(
        path.join(own, ".seyirlik-job.json"),
        JSON.stringify({
          owner: "seyirlik-processing-job",
          workspaceId: "job-1",
        }),
      );
      const fingerprint = fake.latest().sourceFingerprint;
      const checkpoints = checkpointRoot(
        workRoot,
        "job-1",
        ADAPTIVE_PROFILE_VERSION,
        fingerprint,
      );
      mkdirSync(checkpoints, { recursive: true });
      writeFileSync(
        path.join(checkpoints, "epoch.m4s"),
        Buffer.alloc(1024 * 1024),
      );
      if (withPackage) {
        const assembled = path.join(
          own,
          `${ADAPTIVE_PROFILE_VERSION}-${fingerprint.slice(0, 16)}.verified-package`,
        );
        mkdirSync(path.join(assembled, "video"), { recursive: true });
        writeFileSync(
          path.join(assembled, "video", "segment.m4s"),
          Buffer.alloc(1024 * 1024),
        );
      }
      const packageFn = vi.fn(async () => ({
        mediaId: "file-1",
        relativePath: input.relativePath,
        status: "ready" as const,
        versionDirectory: "version",
        storageBytes: 1,
      }));
      const localRunner = createProcessingJobRunner({
        store: fake.store,
        paths,
        mediaRoot: "/media",
        detectHardwareFn: vi.fn(async () => hardware) as never,
        probeFn: vi.fn(async () => probe()) as never,
        packageFn: packageFn as never,
        // Short by more than the checkpoints, but not by both together.
        freeBytesFn: vi.fn(async () => required - 1.5 * 1024 * 1024) as never,
      });
      const outcome = await localRunner.run(input);
      if (resumes) {
        expect(packageFn).toHaveBeenCalledOnce();
        expect(outcome.status).toBe("succeeded");
      } else {
        expect(packageFn).not.toHaveBeenCalled();
        expect(outcome.errorCode).toBe("INSUFFICIENT_DISK_SPACE");
      }
      rmSync(own, { recursive: true, force: true });
    },
  );

  /**
   * MSI's rclone mount reported the registry as empty for a minute or more,
   * and every queued title failed permanently with "Unexpected end of JSON
   * input" while it lasted.
   */
  it("hands an unreadable registry back to the queue instead of failing the title", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-runner-"));
    writeFileSync(path.join(stateRoot, "registry.json"), "");
    const packageFn = vi.fn();
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths: { ...(paths as object), stateRoot } as never,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
    });

    try {
      const outcome = await localRunner.run(input);

      expect(outcome.status).toBe("failed");
      expect(outcome.retryable).toBe(true);
      expect(outcome.errorMessage).toContain("could not be read");
      expect(packageFn).not.toHaveBeenCalled();
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  /**
   * The job saved the copy it read before encoding, so every title that
   * published during those hours lost its entry (Arcane S01E02-E06).
   */
  it("keeps entries other jobs published while this one encoded", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-runner-"));
    const registryPath = path.join(stateRoot, "registry.json");
    const packageFn = vi.fn(async ({ mediaId }: { mediaId: string }) => {
      const other = await loadRenditionRegistry(registryPath);
      const item = upsertRegistrySource(other, {
        relativePath: "Movies/Arrival.mkv",
        size: 1,
        mtimeMs: 1,
        sourceFingerprint: "a".repeat(64),
      });
      item.adaptiveStatus = "ready";
      await saveRenditionRegistry(registryPath, other);
      return {
        mediaId,
        relativePath: input.relativePath,
        status: "ready" as const,
        versionDirectory: "cmaf-hls-aligned-v3-abcdef0123456789",
      };
    });
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths: { ...(paths as object), stateRoot } as never,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
    });

    try {
      const outcome = await localRunner.run(input);

      expect(outcome.status).toBe("succeeded");
      const { items } = await loadRenditionRegistry(registryPath);
      expect(
        items.map((item) => [item.relativePath, item.adaptiveStatus]),
      ).toEqual(
        expect.arrayContaining([
          ["Movies/Dune.mp4", "ready"],
          ["Movies/Arrival.mkv", "ready"],
        ]),
      );
      expect(items).toHaveLength(2);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("retries publication without overwriting an unreadable registry", async () => {
    const stateRoot = mkdtempSync(path.join(tmpdir(), "seyirlik-runner-"));
    const registryPath = path.join(stateRoot, "registry.json");
    const packageFn = vi.fn(async ({ mediaId }: { mediaId: string }) => {
      writeFileSync(registryPath, "");
      return {
        mediaId,
        relativePath: input.relativePath,
        status: "ready" as const,
        versionDirectory: "cmaf-hls-aligned-v3-abcdef0123456789",
      };
    });
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths: { ...(paths as object), stateRoot } as never,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
    });

    try {
      const outcome = await localRunner.run(input);

      expect(outcome.status).toBe("failed");
      expect(outcome.retryable).toBe(true);
      expect(fake.latest().state).not.toBe("succeeded");
      expect(readFileSync(registryPath, "utf8")).toBe("");
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("stops before encoding when the volume is too full", async () => {
    const packageFn = vi.fn();
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      freeBytesFn: vi.fn(async () => 1_000_000) as never,
    });

    const outcome = await localRunner.run(input);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("INSUFFICIENT_DISK_SPACE");
    expect(packageFn).not.toHaveBeenCalled();
  });

  /**
   * A restart during publishing used to fail a finished encode here: the
   * estimate is for building from nothing, and the next restart's scratch
   * sweep then deleted the verified package nobody could resume.
   */
  it("publishes an already-verified package even when scratch is too full to build one", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 149_000_000,
    }));
    const verifiedPackageFn = vi.fn(async () => true);
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      freeBytesFn: vi.fn(async () => 1_000_000) as never,
      verifiedPackageFn,
    });

    const outcome = await localRunner.run(input);

    expect(outcome.status).toBe("succeeded");
    expect(packageFn).toHaveBeenCalledTimes(1);
    expect(verifiedPackageFn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: fake.latest().id,
        sourceFingerprint: fake.latest().sourceFingerprint,
      }),
    );
  });

  it("still stops on a full volume when the package check itself fails", async () => {
    const packageFn = vi.fn();
    const localRunner = createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      freeBytesFn: vi.fn(async () => 1_000_000) as never,
      verifiedPackageFn: vi.fn(async () => {
        throw new Error("scratch unreadable");
      }),
    });

    const outcome = await localRunner.run(input);

    expect(outcome.errorCode).toBe("INSUFFICIENT_DISK_SPACE");
    expect(packageFn).not.toHaveBeenCalled();
  });

  it("reports cancellation without failing the job", async () => {
    const packageFn = vi.fn(async () => {
      fake.setCancelled();
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("cancelled");
    expect(fake.latest().state).toBe("cancelled");
    expect(fake.latest().errorCode).toBe("CANCELLED");
  });

  /**
   * Cancellation has to reach FFmpeg. Checking only between stages let a
   * cancelled encode run to completion, which to an operator looks exactly
   * like the request being ignored.
   */
  it("aborts the encoder when cancellation is requested mid-encode", async () => {
    let observed: AbortSignal | undefined;
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      observed = (options as { signal?: AbortSignal }).signal;
      fake.setCancelled();
      // The packager would normally be inside FFmpeg here; waiting lets the
      // runner's cancellation watch fire.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: observed?.aborted
          ? ("interrupted" as const)
          : ("ready" as const),
      };
    });

    const outcome = await runner(fake, packageFn).run(input);

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(true);
    expect(outcome.status).toBe("cancelled");
  });

  it("does not abort the encoder when nothing asked it to", async () => {
    let observed: AbortSignal | undefined;
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      observed = (options as { signal?: AbortSignal }).signal;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    expect(observed!.aborted).toBe(false);
  });

  it("keeps overall progress moving forward when FFmpeg reports a lower timestamp", async () => {
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "encode-progress",
        mediaId: "file-1",
        processedSeconds: 200,
        durationSeconds: 300,
        speed: 3,
      });
      onEvent({
        type: "encode-progress",
        mediaId: "file-1",
        processedSeconds: 40,
        durationSeconds: 300,
        speed: 3,
      });
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    const reported = fake.updates
      .map((update) => update.overallProgress)
      .filter((value): value is number => value !== undefined);
    for (let index = 1; index < reported.length; index += 1) {
      expect(reported[index]!).toBeGreaterThanOrEqual(
        Math.min(...reported.slice(0, index)),
      );
    }
    expect(fake.latest().overallProgress).toBe(1);
  });

  it("computes an ETA from smoothed throughput once there is enough evidence", async () => {
    /*
     * The estimate deliberately ignores the first samples of an epoch: they are
     * dominated by process start, filter-graph construction and the seek
     * preroll, and taking them at face value showed an ETA of days for the
     * first seconds of every five minutes.
     */
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "epoch-start",
        mediaId: "file-1",
        index: 0,
        epochCount: 1,
        startSeconds: 0,
        endSeconds: 300,
        attempt: 1,
      });
      for (let sample = 0; sample < 30; sample += 1) {
        onEvent({
          type: "epoch-progress",
          mediaId: "file-1",
          index: 0,
          epochCount: 1,
          startSeconds: 0,
          endSeconds: 300,
          epochProcessedSeconds: 100,
          encodedSeconds: 100,
          protectedSeconds: 0,
          sourceDurationSeconds: 300,
          speed: 2,
        });
      }
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    const etas = fake.updates
      .map((update) => update.etaSeconds)
      .filter(
        (value): value is number => typeof value === "number" && value > 0,
      );
    // 200 seconds of media left at twice real time.
    expect(etas).toContain(100);
  });

  it("reports video progress as media time encoded, not as a workflow position", async () => {
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "epoch-plan",
        mediaId: "file-1",
        epochCount: 31,
        epochTargetSeconds: 300,
        sourceDurationSeconds: 9039.2,
        reusedEpochs: 10,
        protectedSeconds: 3000,
        invalidated: [],
      });
      onEvent({
        type: "epoch-progress",
        mediaId: "file-1",
        index: 10,
        epochCount: 31,
        startSeconds: 3000,
        endSeconds: 3300,
        epochProcessedSeconds: 92.5,
        encodedSeconds: 3092.5,
        protectedSeconds: 3000,
        sourceDurationSeconds: 9039.2,
      });
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    const encoded = fake.updates
      .map((update) => update.encodedSeconds)
      .filter((value): value is number => typeof value === "number");
    expect(encoded).toContain(3092.5);
    const protectedSeconds = fake.updates
      .map((update) => update.protectedSeconds)
      .filter((value): value is number => typeof value === "number");
    expect(protectedSeconds).toContain(3000);
    const counts = fake.updates
      .map((update) => update.epochCount)
      .filter((value): value is number => typeof value === "number");
    expect(counts).toContain(31);
  });

  it("records a checkpoint the moment it becomes durable", async () => {
    const packageFn = vi.fn(async (_request, _paths, options: never) => {
      const onEvent = (options as { onEvent?: (event: unknown) => void })
        .onEvent!;
      onEvent({
        type: "epoch-complete",
        mediaId: "file-1",
        index: 9,
        epochCount: 31,
        protectedSeconds: 3000,
        bytes: 1_234_567,
        elapsedMs: 1000,
      });
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
      };
    });

    await runner(fake, packageFn).run(input);

    expect(
      fake.events.some((event) =>
        event.message.includes("Checkpoint saved — protected through 00:50:00"),
      ),
    ).toBe(true);
    expect(fake.updates.some((update) => update.completedEpochs === 10)).toBe(
      true,
    );
  });

  it("waits for storage rather than failing when the packager says the volume went", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "interrupted" as const,
      interruption: "storage" as const,
      error: "Expansion became unavailable.",
    }));

    const outcome = await runner(fake, packageFn).run(input);

    expect(outcome.status).toBe("waiting-for-storage");
    expect(fake.latest().state).toBe("paused");
    // Not finished, so it must carry no finish time and no failure.
    expect(fake.latest().finishedAt).toBeNull();
    expect(fake.latest().errorCode).toBeNull();
    expect(
      fake.events.some((event) =>
        event.message.includes("Every completed checkpoint is untouched"),
      ),
    ).toBe(true);
  });

  /**
   * The reason is what makes the pause recoverable.
   *
   * `requeueStorageInterruptedJobs` finds work to restart with
   * `listPaused("storage-unavailable")`, which reads `paused_reason`. A job the
   * runner parks without stamping that reason is invisible to the watchdog: it
   * sits in `paused` with no reason, no error and no finish time, and nothing
   * will ever pick it up again. The engine classifies an I/O error as storage
   * loss *before* the watchdog has polled, so this is the ordinary path, not a
   * corner of one.
   */
  it("stamps the storage reason so the watchdog can find the job it parked", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "interrupted" as const,
      interruption: "storage" as const,
      error: "Input/output error",
    }));

    await runner(fake, packageFn).run(input);

    expect(fake.latest().state).toBe("paused");
    expect(fake.latest().pausedReason).toBe("storage-unavailable");
  });

  it("passes the policy's audio selection to the packager", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    const options = (packageFn.mock.calls[0] as unknown as unknown[])[2];
    expect(options).toMatchObject({
      audioStreamIndexes: [1],
      videoEncoder: "hevc_videotoolbox",
    });
  });

  it("passes an explicit software thread override to the packager", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn, 8).run(input);

    const options = (packageFn.mock.calls[0] as unknown as unknown[])[2];
    expect(options).toMatchObject({ softwareThreads: 8 });
  });

  /**
   * Losing the volume mid-encode.
   *
   * This used to suspend FFmpeg and leave it holding descriptors on storage
   * that was no longer there, and an aborted encode was reported as cancelled
   * — so an accidental unplug looked like a deliberate stop and needed a
   * person to press Retry.
   */
  it("parks the job as waiting for storage rather than cancelling it", async () => {
    const packageFn = vi.fn(async () => {
      fake.setStorageUnavailable();
      // The runner polls the store once a second, so the encode has to still
      // be in flight when that tick lands — as a real one would be.
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn as never).run(input);

    expect(outcome.status).toBe("waiting-for-storage");
    const final = fake.latest();
    expect(final.state).toBe("paused");
    // It has not finished, so it must not claim a finish time.
    expect(final.finishedAt ?? null).toBeNull();
    // And it is not an error the operator has to clear.
    expect(final.errorCode ?? null).toBeNull();
  });

  /**
   * A quarantine is recorded at the moment of the fault, and finished long
   * afterwards.
   *
   * Two places write `pausedReason` for one interruption. The supervisor tick
   * runs while the fault is happening and classifies it correctly. Then FFmpeg
   * has to actually die, and on a bad region that takes minutes — nineteen of
   * them, on job 21f644c2 — during which the drive drops off the bus and the
   * guard stops saying "quarantined" and starts saying "unavailable".
   * `finishStorageInterrupted` re-derived the reason from that second reading
   * and overwrote the first.
   *
   * The reason is not a label. `storage-unavailable` is the one reason
   * `requeueStorageInterruptedJobs` can see, so the rewrite handed a
   * quarantined volume back to the automatic requeue and left the page saying
   * the drive was merely being waited for.
   */
  it("keeps a quarantine recorded at fault time when the encoder is reaped later", async () => {
    const storage = fakeGuard();
    const packageFn = vi.fn(async () => {
      // The fault, while the encode is in flight. The runner polls once a
      // second, so the tick has to be given a chance to land.
      storage.becomes("quarantined");
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      // And by the time the encoder is finally reaped, the drive is simply
      // gone — which reads as a clean absence, not as a fault.
      storage.becomes("unavailable");
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      storageGuard: storage.guard,
    } as never).run(input);

    expect(outcome.status).toBe("waiting-for-storage");
    expect(fake.latest().pausedReason).toBe("storage-quarantined");
    // Which is what keeps it out of the automatic requeue's query entirely.
    expect(fake.latest().pausedReason).not.toBe(AUTOMATIC_REQUEUE_PAUSE_REASON);
  });

  /**
   * The other direction has to keep working, or the fix is just a different
   * wrong answer: a job parked as a clean absence whose volume is *then* found
   * faulty must become quarantined.
   */
  it("still escalates a clean absence to a quarantine found while reaping", async () => {
    const storage = fakeGuard();
    const packageFn = vi.fn(async () => {
      storage.becomes("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      storage.becomes("quarantined");
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      storageGuard: storage.guard,
    } as never).run(input);

    expect(fake.latest().pausedReason).toBe("storage-quarantined");
  });

  /** A person cancelling still cancels; the two paths must stay distinct. */
  it("still reports a genuine cancellation as cancelled", async () => {
    const packageFn = vi.fn(async () => {
      fake.setCancelled();
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    const outcome = await runner(fake, packageFn as never).run(input);
    expect(outcome.status).toBe("cancelled");
    expect(fake.latest().state).toBe("cancelled");
  });

  /**
   * A new attempt owns its own telemetry.
   *
   * The live bug: a retry inherited the previous attempt's 89% overall
   * progress and its finish time, so a run that had just begun showed as
   * nearly done and as having finished before it started.
   */
  /**
   * A pause has to hold against a worker that starts, not only against one that
   * is already encoding.
   *
   * The worker is kept alive by launchd, so it restarts on its own. While a
   * pause was only observed from inside the encode loop, such a restart leased
   * the next paused job and began a fresh encode on it — burning hours on a
   * drive an operator had just told it to leave alone.
   */
  it("does not start an attempt on a job that is paused", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 149_000_000,
    }));
    fake.setOperatorPaused();

    const outcome = await runner(fake, packageFn).run(input);

    // Nothing was read, probed or encoded.
    expect(packageFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("waiting-for-storage");
    // And the job is left exactly as resumable as it was.
    expect(fake.latest().state).toBe("paused");
    expect(fake.latest().pauseRequested).toBe(true);
    expect(fake.latest().pausedReason).toBe("operator");
    expect(fake.events.at(-1)?.message).toMatch(/paused/i);
  });

  /* ------------------------------------------------- pausing a live encoder */

  /**
   * The bug this whole area was rebuilt for.
   *
   * `state = "paused"` used to be written the instant the request was seen,
   * from a controller that had flipped a boolean and told nobody. On Windows
   * nothing behind that boolean suspended anything, so the row said paused, the
   * watchdog stood down, and FFmpeg carried on writing to the disk the operator
   * was about to unplug. The durable state now waits for the operating system.
   */
  it("does not write paused until the encoder is actually suspended", async () => {
    let release: (() => void) | undefined;
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawPausedWhileSuspending = false;

    const packageFn = vi.fn(async (_input, _paths, options: never) => {
      const controller = (options as { pauseController: PauseController })
        .pauseController;
      controller.bind({
        describe: "The encoder could not be suspended:",
        apply: async () => {
          await suspended;
          return { ok: true };
        },
      });
      fake.setOperatorPaused();
      // Two ticks' worth: long enough that a runner writing the state from the
      // request alone would certainly have done it by now.
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      sawPausedWhileSuspending = fake.latest().state === "paused";
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
        versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
        storageBytes: 1,
      };
    });

    await runner(fake, packageFn as never).run(input);

    expect(sawPausedWhileSuspending).toBe(false);
    // And once the suspension landed, it was recorded.
    expect(fake.updates.some((update) => update.state === "paused")).toBe(true);
    expect(fake.events.some((event) => event.message === "Paused.")).toBe(true);
  }, 20_000);

  /**
   * A suspension the operating system refuses.
   *
   * The encoder is still running, so nothing may say otherwise: not the row,
   * not the history, and not the pause request, which is withdrawn rather than
   * left standing over a process that has already declined it.
   */
  it("keeps a job running when the encoder cannot be suspended", async () => {
    const packageFn = vi.fn(async (_input, _paths, options: never) => {
      const controller = (options as { pauseController: PauseController })
        .pauseController;
      controller.bind({
        describe: "The encoder could not be suspended:",
        apply: async () => ({ ok: false, reason: "the handle was refused." }),
      });
      fake.setOperatorPaused();
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "ready" as const,
        versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
        storageBytes: 1,
      };
    });

    await runner(fake, packageFn as never).run(input);

    expect(fake.updates.some((update) => update.state === "paused")).toBe(
      false,
    );
    // Said once, however many times it was retried.
    const failures = fake.events.filter((event) =>
      /could not be paused/i.test(event.message),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.level).toBe("error");
    // And the request is withdrawn, so the page stops promising a pause that
    // is not coming.
    expect(fake.updates.some((update) => update.pauseRequested === false)).toBe(
      true,
    );
  }, 20_000);

  /**
   * Cancelling something that is asleep.
   *
   * A suspended process cannot read FFmpeg's quit key, cannot act on a signal
   * and — on Windows — cannot be reaped without being forced. Cancel therefore
   * has to wake it *first*, and the ordering has to hold across the await, not
   * merely be initiated before it. A cancel that terminated a frozen encoder is
   * how an orphan holding handles on the media volume gets made.
   */
  it("wakes a suspended encoder before it aborts it", async () => {
    const order: string[] = [];
    const packageFn = vi.fn(async (_input, _paths, options: never) => {
      const opts = options as {
        pauseController: PauseController;
        signal: AbortSignal;
      };
      opts.signal.addEventListener("abort", () => order.push("abort"));
      opts.pauseController.bind({
        describe: "The encoder could not be suspended:",
        apply: async (paused) => {
          // A round trip through a helper process, not a signal.
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push(paused ? "suspend" : "resume");
          return { ok: true };
        },
      });
      fake.setOperatorPaused();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      fake.setCancelled();
      // Several ticks past the abort. The pause request outlives the cancel —
      // it is cleared only when the cancellation is finalised, which is after
      // FFmpeg has been reaped — so this is exactly the window in which the
      // poll used to keep asking a dying process to suspend itself.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "cancelled" as const,
      };
    });

    await runner(fake, packageFn as never).run(input);

    expect(order).toEqual(["suspend", "resume", "abort"]);
  }, 20_000);

  /**
   * The volume going away while the encoder is asleep.
   *
   * Same invariant, different trigger, and the one the Unix audit already
   * depends on: the encoder is woken before it is ended, so it can be reaped
   * rather than left frozen with descriptors open on a disk that is no longer
   * there.
   */
  it("wakes a suspended encoder before storage ends it", async () => {
    const order: string[] = [];
    const guard = fakeGuard("healthy");
    const packageFn = vi.fn(async (_input, _paths, options: never) => {
      const opts = options as {
        pauseController: PauseController;
        signal: AbortSignal;
      };
      opts.signal.addEventListener("abort", () => order.push("abort"));
      opts.pauseController.bind({
        describe: "The encoder could not be suspended:",
        apply: async (paused) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push(paused ? "suspend" : "resume");
          return { ok: true };
        },
      });
      fake.setOperatorPaused();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      guard.becomes("unavailable");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return {
        mediaId: "file-1",
        relativePath: "Movies/Dune.mp4",
        status: "interrupted" as const,
      };
    });

    await createProcessingJobRunner({
      store: fake.store,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      packageFn: packageFn as never,
      storageGuard: guard.guard,
    }).run(input);

    expect(order.indexOf("resume")).toBeGreaterThan(order.indexOf("suspend"));
    expect(order.indexOf("abort")).toBeGreaterThan(order.indexOf("resume"));
  }, 20_000);

  /**
   * The destination the queue carried has to reach the packager.
   *
   * It is computed when the job is queued, travels in the payload, and is used
   * here — and every hop in that chain has now dropped it at least once. This
   * asserts the last one.
   */
  it("publishes where the job says, not beside the source", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Series/Show/Season 1/S01E02.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 1,
    }));

    await runner(fake, packageFn).run({
      ...input,
      sourcePath: "/media/Series/Show/Season 1/S01E02.mp4",
      relativePath: "Series/Show/Season 1/S01E02.mp4",
      titleRoot: "/media/Series/Show/Season 1/S01E02",
    });

    expect(packageFn.mock.calls.at(0)?.at(0)).toMatchObject({
      titleRoot: "/media/Series/Show/Season 1/S01E02",
    });
  });

  /**
   * With no destination carried, the folder beside the source is a guess, and
   * it is only a safe one where that folder holds a single title. A season
   * folder holds ten, and publishing beside there is how one episode comes to
   * overwrite its neighbours.
   */
  it("refuses to guess a destination in a folder holding several sources", async () => {
    const shared = mkdtempSync(path.join(tmpdir(), "seyirlik-season-"));
    for (const name of ["S01E01.mp4", "S01E02.mp4", "S01E03.mp4"]) {
      writeFileSync(path.join(shared, name), "source");
    }
    const packageFn = vi.fn();

    const outcome = await runner(fake, packageFn).run({
      ...input,
      sourcePath: path.join(shared, "S01E02.mp4"),
      relativePath: "Series/Show/Season 1/S01E02.mp4",
      // No titleRoot: the case every dropped-field bug produced.
    });

    expect(packageFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(fake.latest().errorMessage).toMatch(/holds 3 sources/);
  });

  /*
   * The same folder, organised: the ten sources now sit in `src/` and the
   * season folder above holds only their episode folders. Counting sources in
   * the season folder would find none and read that as "one title here" — the
   * answer that publishes one episode over the whole season.
   */
  it("refuses to guess just as firmly once the sources are in src/", async () => {
    const season = mkdtempSync(path.join(tmpdir(), "seyirlik-organised-"));
    const bucket = path.join(season, "src");
    mkdirSync(bucket);
    for (const name of ["S01E01.mp4", "S01E02.mp4", "S01E03.mp4"]) {
      writeFileSync(path.join(bucket, name), "source");
      mkdirSync(path.join(season, name.replace(".mp4", "")));
    }
    const packageFn = vi.fn();

    const outcome = await runner(fake, packageFn).run({
      ...input,
      sourcePath: path.join(bucket, "S01E02.mp4"),
      relativePath: "Series/Show/Season 1/src/S01E02.mp4",
      // No titleRoot: the case every dropped-field bug produced.
    });

    expect(packageFn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(fake.latest().errorMessage).toMatch(/holds 3 sources/);
  });

  /** An organised movie folder holds one source, so beside it is still safe. */
  it("falls back to the movie folder when its lone source is in src/", async () => {
    const movie = mkdtempSync(path.join(tmpdir(), "seyirlik-organised-movie-"));
    const bucket = path.join(movie, "src");
    mkdirSync(bucket);
    writeFileSync(path.join(bucket, "Dune.mp4"), "source");
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune/src/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 1,
    }));

    await runner(fake, packageFn).run({
      ...input,
      sourcePath: path.join(bucket, "Dune.mp4"),
      relativePath: "Movies/Dune/src/Dune.mp4",
    });

    // The movie folder, not the bucket the source happens to sit in.
    expect(packageFn.mock.calls.at(0)?.at(0)).toMatchObject({
      titleRoot: movie,
    });
  });

  /** A movie folder holds one title, so beside it is unambiguous and allowed. */
  it("still falls back to the folder beside a lone source", async () => {
    const solo = mkdtempSync(path.join(tmpdir(), "seyirlik-movie-"));
    writeFileSync(path.join(solo, "Dune.mp4"), "source");
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune/Dune.mp4",
      status: "ready" as const,
      versionDirectory: "cmaf-hls-aligned-v2-abcdef0123456789",
      storageBytes: 1,
    }));

    await runner(fake, packageFn).run({
      ...input,
      sourcePath: path.join(solo, "Dune.mp4"),
      relativePath: "Movies/Dune/Dune.mp4",
    });

    expect(packageFn.mock.calls.at(0)?.at(0)).toMatchObject({
      titleRoot: solo,
    });
  });

  it("starts an attempt with fresh progress and no finish time", async () => {
    const packageFn = vi.fn(async () => ({
      mediaId: "file-1",
      relativePath: "Movies/Dune.mp4",
      status: "ready" as const,
    }));

    await runner(fake, packageFn).run(input);

    const start = fake.updates.find((update) => update.state === "running") as
      | Record<string, unknown>
      | undefined;
    expect(start).toBeDefined();
    expect(start!.finishedAt).toBeNull();
    expect(start!.overallProgress).toBe(0);
    expect(start!.stageProgress).toBe(0);
    expect(start!.speed).toBeNull();
    expect(start!.fps).toBeNull();
    expect(start!.etaSeconds).toBeNull();
    expect(start!.validation).toBeNull();
    expect(start!.errorCode).toBeNull();
  });
});
