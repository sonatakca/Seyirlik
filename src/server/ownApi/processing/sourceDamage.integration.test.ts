/**
 * What an operator sees while a disk is failing under a job.
 *
 * Driven through the real runner, with a fake packager emitting the exact
 * sequence the real one produces when a source region cannot be read: FFmpeg
 * reporting four times a second with media time frozen, then a failed read,
 * then a diagnosis, then a replacement, then the rest of the title.
 *
 * Two claims are being tested and both are about honesty. Progress must not
 * advance while nothing is happening, and the rate and the estimate must be
 * withdrawn rather than left falling — the original incident spent minutes
 * showing a confidently declining encoding speed for a process blocked on a
 * platter. And when the interval is replaced, the work that produces the
 * replacement is real, so the bar moves for it and says what it is.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenditionMediaProbe } from "../../../renditions/probe";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { createProcessingJobRunner } from "./jobRunner";
import { RenditionLockHeldError } from "../../../renditions/locks";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import type { LiveProgressSnapshot, SourceIoState } from "./liveProgress";

const GIB = 1024 ** 3;
const SOURCE_SECONDS = 9039.2;
/** The damaged epoch of the real incident, to the tick. */
const DAMAGE = {
  epochIndex: 10,
  sourceStartSeconds: 3000.039,
  sourceEndSeconds: 3300.005,
  expectedDurationSeconds: 299.966,
  lastConfirmedMediaSeconds: 123.29,
  ffmpegByteOffset: 10_074_169_063,
  sourceRetryCount: 4,
} as const;

const { published } = vi.hoisted(() => ({ published: [] as unknown[] }));

vi.mock("./liveProgress", async () => {
  const actual =
    await vi.importActual<typeof import("./liveProgress")>("./liveProgress");
  return {
    ...actual,
    writeLiveProgress: vi.fn(async (snapshot: unknown) => {
      published.push(JSON.parse(JSON.stringify(snapshot)));
    }),
    clearLiveProgress: vi.fn(async () => undefined),
  };
});

function snapshots(): LiveProgressSnapshot[] {
  return published as LiveProgressSnapshot[];
}

beforeEach(() => {
  published.length = 0;
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

function jobRecord(): ProcessingJobRecord {
  return {
    id: "job-1",
    jobId: "queue-1",
    itemId: "item-1",
    mediaFileId: "file-1",
    sourceFingerprint: "f".repeat(64),
    profile: "cmaf-hls-aligned-v3",
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
  };
}

function probe(): RenditionMediaProbe {
  return {
    durationSeconds: SOURCE_SECONDS,
    video: {
      width: 1920,
      height: 1080,
      codec: "h264",
      frameRate: 24000 / 1001,
      isHdr: false,
    },
    audioTracks: [
      {
        streamIndex: 1,
        codec: "ac3",
        channels: 6,
        language: "eng",
        isDefault: true,
        isForced: false,
      },
    ],
    subtitleTracks: [],
    container: "mkv",
    sizeBytes: 20 * GIB,
  } as unknown as RenditionMediaProbe;
}

const hardware = {
  platform: "darwin",
  probedAt: new Date().toISOString(),
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
} as unknown as HardwareReport;

function fakeStore() {
  let current = jobRecord();
  const updates: Array<Parameters<ProcessingJobStore["update"]>[1]> = [];
  const events: Array<{ message: string; level?: string }> = [];
  const store = {
    get: vi.fn(async () => current),
    update: vi.fn(async (_id: string, update) => {
      updates.push(update);
      current = { ...current, ...update } as ProcessingJobRecord;
      return current;
    }),
    appendEvent: vi.fn(async (event: { message: string; level?: string }) => {
      events.push(event);
      return {} as never;
    }),
    incrementAttempts: vi.fn(async () => 1),
    listPhaseTimings: vi.fn(async () => []),
  } as unknown as ProcessingJobStore;
  return { store, updates, events, latest: () => current };
}

const paths = {
  mediaRoot: "/media",
  renditionRoot: "/outputs",
  stateRoot: mkdtempSync(path.join(tmpdir(), "seyirlik-damage-state-")),
  workRoot: "/work",
  logsRoot: "/logs",
} as never;

/**
 * The incident, as events.
 *
 * Epoch 10 reads 123.29 seconds of its 299.966 and then stops. FFmpeg keeps
 * reporting — same `out_time`, falling `speed` — which is the part that used to
 * be shown as progress. The reads are retried, the diagnosis is made, the
 * interval is replaced, and epoch 11 carries on from 00:55:00.
 */
function damagedPackager({ salvage = true }: { salvage?: boolean } = {}) {
  return vi.fn(async (_request: never, _paths: never, options: never) => {
    const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
    const tick = async (ms = 300) => {
      await vi.advanceTimersByTimeAsync(ms);
    };

    emit({ type: "build-stage", mediaId: "m", stage: "encoding" });
    emit({
      type: "epoch-plan",
      mediaId: "m",
      epochCount: 30,
      epochTargetSeconds: 300,
      sourceDurationSeconds: SOURCE_SECONDS,
      reusedEpochs: 10,
      protectedSeconds: DAMAGE.sourceStartSeconds,
      checkpointBytes: 8 * GIB,
      invalidated: [],
    });
    emit({
      type: "epoch-start",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      epochCount: 30,
      startSeconds: DAMAGE.sourceStartSeconds,
      endSeconds: DAMAGE.sourceEndSeconds,
      attempt: 1,
    });
    await tick();

    // Reading normally, up to the bad region.
    for (const [processed, speed] of [
      [40, 2.4],
      [80, 2.4],
      [123.29, 2.3],
    ] as const) {
      emit({
        type: "epoch-progress",
        mediaId: "m",
        index: DAMAGE.epochIndex,
        epochCount: 30,
        startSeconds: DAMAGE.sourceStartSeconds,
        endSeconds: DAMAGE.sourceEndSeconds,
        epochProcessedSeconds: processed,
        encodedSeconds: DAMAGE.sourceStartSeconds + processed,
        protectedSeconds: DAMAGE.sourceStartSeconds,
        sourceDurationSeconds: SOURCE_SECONDS,
        speed,
        fps: 55,
        writtenBytes: 8 * GIB,
      });
      await tick();
    }

    /*
     * Blocked. Media time never moves again, and FFmpeg's `speed` falls
     * because wall clock keeps going — arithmetically correct and completely
     * misleading, which is exactly why it must not be shown.
     */
    for (const speed of [1.9, 1.2, 0.7, 0.4]) {
      emit({
        type: "epoch-progress",
        mediaId: "m",
        index: DAMAGE.epochIndex,
        epochCount: 30,
        startSeconds: DAMAGE.sourceStartSeconds,
        endSeconds: DAMAGE.sourceEndSeconds,
        epochProcessedSeconds: DAMAGE.lastConfirmedMediaSeconds,
        encodedSeconds: DAMAGE.sourceStartSeconds + 123.29,
        protectedSeconds: DAMAGE.sourceStartSeconds,
        sourceDurationSeconds: SOURCE_SECONDS,
        speed,
        fps: 0,
        writtenBytes: 8 * GIB,
      });
      await tick(3_000);
    }

    /*
     * The watchdog's decision, announced before the signals go out. What
     * follows can take tens of seconds on a wedged read, and a page that went
     * quiet through them would look like a page that had crashed.
     */
    emit({
      type: "source-stall-abort",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      startSeconds: DAMAGE.sourceStartSeconds,
      endSeconds: DAMAGE.sourceEndSeconds,
      lastMediaSeconds: DAMAGE.lastConfirmedMediaSeconds,
      stalledForMs: 25_400,
    });
    await tick();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      emit({
        type: "source-io-retry",
        mediaId: "m",
        index: DAMAGE.epochIndex,
        attempt,
        maxAttempts: 2,
        sourceReadable: false,
        verdict: "source-damage",
        because: "FFmpeg reported the failure on its input",
        detail: "Error during demuxing: Input/output error",
      });
      await tick();
    }

    const damage = {
      type: "source-damage",
      ...DAMAGE,
      evidence: [
        "Read error at pos. 10074169063",
        "Error during demuxing: Input/output error",
      ],
      detectedAt: new Date().toISOString(),
    };
    emit({
      type: "source-damage-confirmed",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      damage,
      policy: salvage ? "replace-epoch" : "fail",
    });
    await tick();

    if (!salvage) {
      return {
        status: "failed",
        mediaId: "m",
        relativePath: "Movies/Damaged/Damaged.mkv",
        error: "The source could not be read after repeated attempts.",
        failureKind: "source-io",
        sourceDamage: [damage],
      };
    }

    emit({
      type: "epoch-salvage-start",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      epochCount: 30,
      startSeconds: DAMAGE.sourceStartSeconds,
      endSeconds: DAMAGE.sourceEndSeconds,
      expectedDurationSeconds: DAMAGE.expectedDurationSeconds,
    });
    await tick();

    // Producing the replacement is real work with real progress.
    for (const processed of [100, 200, 299.966]) {
      emit({
        type: "epoch-progress",
        mediaId: "m",
        index: DAMAGE.epochIndex,
        epochCount: 30,
        startSeconds: DAMAGE.sourceStartSeconds,
        endSeconds: DAMAGE.sourceEndSeconds,
        epochProcessedSeconds: processed,
        encodedSeconds: DAMAGE.sourceStartSeconds + processed,
        protectedSeconds: DAMAGE.sourceStartSeconds,
        sourceDurationSeconds: SOURCE_SECONDS,
        speed: 180,
        writtenBytes: 8 * GIB,
        placeholder: true,
      });
      await tick();
    }

    emit({
      type: "epoch-salvaged",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      epochCount: 30,
      protectedSeconds: DAMAGE.sourceEndSeconds,
      bytes: 12 * 1024 * 1024,
      damage: { ...damage, audioReplaced: true },
    });
    emit({
      type: "epoch-complete",
      mediaId: "m",
      index: DAMAGE.epochIndex,
      epochCount: 30,
      protectedSeconds: DAMAGE.sourceEndSeconds,
      bytes: 12 * 1024 * 1024,
      elapsedMs: 4_000,
    });
    await tick();

    // Epoch 11 starts at 00:55:00, exactly where it always would have.
    emit({
      type: "epoch-start",
      mediaId: "m",
      index: DAMAGE.epochIndex + 1,
      epochCount: 30,
      startSeconds: DAMAGE.sourceEndSeconds,
      endSeconds: DAMAGE.sourceEndSeconds + 300,
      attempt: 1,
    });
    emit({
      type: "epoch-progress",
      mediaId: "m",
      index: DAMAGE.epochIndex + 1,
      epochCount: 30,
      startSeconds: DAMAGE.sourceEndSeconds,
      endSeconds: DAMAGE.sourceEndSeconds + 300,
      epochProcessedSeconds: 150,
      encodedSeconds: DAMAGE.sourceEndSeconds + 150,
      protectedSeconds: DAMAGE.sourceEndSeconds,
      sourceDurationSeconds: SOURCE_SECONDS,
      speed: 2.4,
      writtenBytes: 9 * GIB,
    });
    await tick();

    emit({ type: "build-stage", mediaId: "m", stage: "publishing" });
    await tick();

    return {
      status: "ready",
      mediaId: "m",
      relativePath: "Movies/Damaged/Damaged.mkv",
      versionDirectory: "v1",
      storageBytes: 20 * GIB,
      jobOutputBytes: 20 * GIB,
      sourceDamage: [{ ...damage, audioReplaced: true }],
    };
  });
}

async function runJob(packageFn: unknown, fake: ReturnType<typeof fakeStore>) {
  return createProcessingJobRunner({
    store: fake.store,
    paths,
    mediaRoot: "/media",
    detectHardwareFn: vi.fn(async () => hardware) as never,
    probeFn: vi.fn(async () => probe()) as never,
    freeBytesFn: vi.fn(async () => 500 * GIB) as never,
    packageFn: packageFn as never,
    sourceDamagePolicy: "replace-epoch",
  }).run({
    processingJobId: "job-1",
    sourcePath: "/media/Movies/Damaged/Damaged.mkv",
    relativePath: "Movies/Damaged/Damaged.mkv",
    sizeBytes: 20 * GIB,
    mtimeMs: 0,
  });
}

describe("a job whose source stops answering", () => {
  it("stops claiming a rate and an estimate once media time freezes", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);

    const encoding = snapshots().filter(
      (sample) => sample.phase === "encoding",
    );
    const stalled = encoding.filter(
      (sample) => sample.sourceIo?.state === "waiting",
    );
    expect(stalled.length).toBeGreaterThan(0);
    for (const sample of stalled) {
      // The position stays — it is still true — and the present-tense figures
      // go, because they describe something that is not happening.
      expect(sample.encodedSeconds).toBeCloseTo(
        DAMAGE.sourceStartSeconds + DAMAGE.lastConfirmedMediaSeconds,
        3,
      );
      expect(sample.speed).toBeUndefined();
      expect(sample.smoothedSpeed).toBeUndefined();
      expect(sample.etaSeconds).toBeUndefined();
    }
  });

  it("stops confirming samples, so a reader can tell the difference too", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const stalled = snapshots().filter(
      (sample) => sample.sourceIo?.state === "waiting",
    );
    const confirmations = new Set(
      stalled.map((sample) => sample.confirmedAtMs),
    );
    // Every stalled sample carries the same measurement time: the panel keeps
    // being republished, and nothing in it has become true since.
    expect(confirmations.size).toBe(1);
    expect(stalled[0]!.timestampMs).toBeGreaterThan(stalled[0]!.confirmedAtMs!);
  });

  it("never advances progress while nothing is being produced", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const stalled = snapshots().filter(
      (sample) => sample.sourceIo?.state === "waiting",
    );
    const positions = new Set(
      stalled.map((sample) => sample.globalProgress ?? 0),
    );
    expect(positions.size).toBe(1);
  });

  it("says less than it knows until a read has actually failed", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const states = snapshots()
      .map((sample) => sample.sourceIo?.state)
      .filter((state) => state !== undefined);
    // The escalation, in order and without skipping a step.
    const firstIndex = (state: SourceIoState) => states.indexOf(state);
    expect(firstIndex("waiting")).toBeGreaterThanOrEqual(0);
    expect(firstIndex("aborting")).toBeGreaterThan(firstIndex("waiting"));
    expect(firstIndex("suspected")).toBeGreaterThan(firstIndex("aborting"));
    expect(firstIndex("confirmed")).toBeGreaterThan(firstIndex("suspected"));
    expect(firstIndex("replacing")).toBeGreaterThan(firstIndex("confirmed"));
    expect(firstIndex("replaced")).toBeGreaterThan(firstIndex("replacing"));
  });

  it("names the interval and where the build carries on from", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const confirmed = snapshots().find(
      (sample) => sample.sourceIo?.state === "confirmed",
    );
    expect(confirmed?.sourceIo?.startSeconds).toBeCloseTo(3000.039, 3);
    expect(confirmed?.sourceIo?.endSeconds).toBeCloseTo(3300.005, 3);
    const replaced = snapshots().find(
      (sample) => sample.sourceIo?.state === "replaced",
    );
    expect(replaced?.sourceIo?.resumeSeconds).toBeCloseTo(3300.005, 3);
    expect(replaced?.sourceDamage).toHaveLength(1);
  });

  it("keeps the whole-job bar monotonic across the stall and the repair", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    let previous = -1;
    for (const sample of snapshots()) {
      const value = sample.globalProgress ?? 0;
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
  });

  it("moves the bar again for the work the replacement really is", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const replacing = snapshots().filter(
      (sample) => sample.sourceIo?.state === "replacing",
    );
    expect(replacing.length).toBeGreaterThan(1);
    expect(replacing[replacing.length - 1]!.globalProgress).toBeGreaterThan(
      replacing[0]!.globalProgress!,
    );
  });
});

describe("what a salvaged job leaves behind", () => {
  it("succeeds, and records the substitution rather than hiding it", async () => {
    const fake = fakeStore();
    const outcome = await runJob(damagedPackager(), fake);

    expect(outcome.status).toBe("succeeded");
    const final = fake.latest();
    expect(final.state).toBe("succeeded");
    // The row is what tells a perfect encode from a salvaged one.
    expect(final.sourceDamage).toHaveLength(1);
    expect(
      (final.sourceDamage as unknown as { epochIndex: number }[])[0]!
        .epochIndex,
    ).toBe(DAMAGE.epochIndex);
    expect(final.warnings.join(" ")).toContain("00:50:00–00:55:00");
    expect(final.warnings.join(" ")).toContain("silence");
  });

  it("says so in the job's own history, as a warning", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const messages = fake.events.map((event) => event.message);
    expect(messages.join("\n")).toContain("Replacing 00:50:00–00:55:00");
    expect(messages.join("\n")).toContain("continues from 00:55:00");
    const completion = fake.events[fake.events.length - 1]!;
    expect(completion.message).toContain("source damage");
    expect(completion.level).toBe("warning");
  });

  it("keeps the finding even when the strict policy fails the job", async () => {
    const fake = fakeStore();
    const outcome = await runJob(damagedPackager({ salvage: false }), fake);

    expect(outcome.status).toBe("failed");
    // Nothing was substituted, and the interval is still on the record: it is
    // what an operator needs to choose between repairing the disc and
    // enabling salvage.
    expect(fake.latest().sourceDamage).toHaveLength(1);
  });

  it("leaves a clean encode looking exactly as it always did", async () => {
    const fake = fakeStore();
    const clean = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "encoding" });
        await vi.advanceTimersByTimeAsync(300);
        return {
          status: "ready",
          mediaId: "m",
          relativePath: "Movies/Fine/Fine.mkv",
          versionDirectory: "v1",
          storageBytes: 20 * GIB,
          jobOutputBytes: 20 * GIB,
        };
      },
    );

    const outcome = await runJob(clean, fake);
    expect(outcome.status).toBe("succeeded");
    expect(fake.latest().sourceDamage).toBeNull();
    expect(fake.latest().warnings).toEqual([]);
    expect(snapshots().every((sample) => sample.sourceIo === undefined)).toBe(
      true,
    );
  });
});

/**
 * The second regression the hardware found.
 *
 * After the wedged FFmpeg was killed, the worker logged
 * `job.failed { retry: true }` and the queue re-ran the same `media.process`
 * job — a fresh FFmpeg with the identical `-ss`, straight back into the sectors
 * that had just wedged the first. Nothing about a physical fault improves on a
 * second attempt, and the attempt costs tens of seconds per bad block.
 *
 * `retryable` is what the queue reads. These assert on it directly.
 */
describe("what the queue is told", () => {
  it("never asks for a retry after a salvaged interval", async () => {
    const fake = fakeStore();
    const outcome = await runJob(damagedPackager(), fake);

    expect(outcome.status).toBe("succeeded");
    // Not "retryable: false" — absent. There is no failure to retry: the
    // damage was handled inside the job, which then finished.
    expect(outcome.retryable).toBeUndefined();
    expect(outcome.errorCode).toBeUndefined();
  });

  it("never asks for a retry of a source that will not read", async () => {
    const fake = fakeStore();
    const outcome = await runJob(damagedPackager({ salvage: false }), fake);

    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBeUndefined();
    expect(outcome.errorCode).toBe("SOURCE_UNREADABLE");
    expect(fake.latest().errorCode).toBe("SOURCE_UNREADABLE");
  });

  it("never asks for a retry of an encoder that stopped producing", async () => {
    const fake = fakeStore();
    const stalled = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "encoding" });
        await vi.advanceTimersByTimeAsync(300);
        return {
          status: "failed",
          mediaId: "m",
          relativePath: "Movies/Damaged/Damaged.mkv",
          error: "The encoder stopped producing media and had to be stopped.",
          failureKind: "media-progress-timeout",
        };
      },
    );

    const outcome = await runJob(stalled, fake);
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBeUndefined();
    expect(outcome.errorCode).toBe("MEDIA_PROGRESS_TIMEOUT");
  });

  it("asks for a retry of a network read that stalled", async () => {
    /*
     * A cloud mount that went quiet for longer than the engine would wait.
     * Nothing about the media or the encode is in doubt, so the queue's own
     * backoff is the right answer, and the code says what actually happened.
     */
    const fake = fakeStore();
    const stalled = vi.fn(
      async (_request: never, _paths: never, options: never) => {
        const emit = (options as { onEvent: (event: unknown) => void }).onEvent;
        emit({ type: "build-stage", mediaId: "m", stage: "encoding" });
        await vi.advanceTimersByTimeAsync(300);
        return {
          status: "failed",
          mediaId: "m",
          relativePath: "Movies/Damaged/Damaged.mkv",
          error: "The network volume stopped answering.",
          failureKind: "network-read-stall",
        };
      },
    );

    const outcome = await runJob(stalled, fake);
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.errorCode).toBe("SOURCE_READ_STALLED");
  });

  it("still asks for a retry when another attempt merely held the lock", async () => {
    /*
     * The one condition that genuinely deserves another pass, and the reason
     * this cannot simply be "never retry anything".
     */
    const fake = fakeStore();
    const contended = vi.fn(async () => {
      throw new RenditionLockHeldError("/state/locks/a.lock");
    });

    const outcome = await runJob(contended, fake);
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
  });

  it("does not turn a database failure into a second pass over the media", async () => {
    /*
     * During the real encode the worker logged
     * "Could not read the pause state ... Connection terminated due to
     * connection timeout" repeatedly — the wedged volume had starved libuv's
     * thread pool, which is also what `getaddrinfo` needs to open a new
     * connection. An unguarded write rejecting on that used to escape the
     * runner as an ordinary error, and an ordinary error is requeued.
     */
    const fake = fakeStore();
    let writes = 0;
    const flaky = {
      ...fake.store,
      update: vi.fn(async (id: string, update: never) => {
        writes += 1;
        if (writes === 3) {
          throw new Error("Connection terminated due to connection timeout");
        }
        return fake.store.update(id, update);
      }),
    } as unknown as ProcessingJobStore;

    const outcome = await createProcessingJobRunner({
      store: flaky,
      paths,
      mediaRoot: "/media",
      detectHardwareFn: vi.fn(async () => hardware) as never,
      probeFn: vi.fn(async () => probe()) as never,
      freeBytesFn: vi.fn(async () => 500 * GIB) as never,
      packageFn: damagedPackager() as never,
      sourceDamagePolicy: "replace-epoch",
    }).run({
      processingJobId: "job-1",
      sourcePath: "/media/Movies/Damaged/Damaged.mkv",
      relativePath: "Movies/Damaged/Damaged.mkv",
      sizeBytes: 20 * GIB,
      mtimeMs: 0,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBeUndefined();
  });
});

/**
 * The state machine an operator watches, end to end.
 *
 * Each step says exactly as much as the evidence supports at that moment, and
 * nothing between them invents a rate for a process that is producing nothing.
 */
describe("the sequence the page is given", () => {
  it("escalates through every state in order and no further", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const states = snapshots()
      .map((sample) => sample.sourceIo?.state)
      .filter((state) => state !== undefined);

    // Deduplicated into the order they first appear.
    const sequence = states.filter(
      (state, index) => index === 0 || states[index - 1] !== state,
    );
    expect(sequence).toEqual([
      "waiting",
      "aborting",
      "suspected",
      "confirmed",
      "replacing",
      "replaced",
    ]);
  });

  it("shows no rate or estimate while the encoder is being stopped", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const aborting = snapshots().filter(
      (sample) => sample.sourceIo?.state === "aborting",
    );
    expect(aborting.length).toBeGreaterThan(0);
    for (const sample of aborting) {
      expect(sample.speed).toBeUndefined();
      expect(sample.fps).toBeUndefined();
      expect(sample.etaSeconds).toBeUndefined();
    }
    // And the bar does not move through the termination.
    const positions = new Set(
      aborting.map((sample) => sample.globalProgress ?? 0),
    );
    expect(positions.size).toBe(1);
  });

  it("keeps the position where the encoder actually stopped", async () => {
    const fake = fakeStore();
    await runJob(damagedPackager(), fake);
    const aborting = snapshots().find(
      (sample) => sample.sourceIo?.state === "aborting",
    );
    expect(aborting?.sourceIo?.lastMediaSeconds).toBeCloseTo(123.29, 3);
  });
});
