/**
 * Resuming and cancelling a durable processing job.
 *
 * The distinction these tests exist to hold is the one the system got wrong: a
 * `processing_jobs` row is the lifetime of one media-processing operation, and
 * a `media.process` row is one executable attempt at it. An operation outlives
 * its attempts. It can be queued, parked for storage while that attempt
 * finishes *successfully*, and queued again — so the attempt id stored beside
 * the job names the last one, never necessarily a live one.
 *
 * The job that produced this file had reached exactly that state: paused for
 * recovery, its only queue attempt already `succeeded`. Resume set the row to
 * `running` without queueing anything, so no worker ever learned it existed,
 * and Cancel then wrote a cancellation flag onto a queue row that had finished
 * hours earlier. The page showed Running / Waiting, for ever, and neither
 * button could get it out.
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RouteContext, RoutePrincipal } from "../api/router";
import { OwnApiError } from "../ownApiHandler";
import type {
  CatalogueRepository,
  MediaFileRow,
} from "../catalogue/catalogueRepository";
import type { JobQueue, JobRecord, JobStatus } from "../tasks/jobQueue";
import type {
  ProcessingJobRecord,
  ProcessingJobStore,
  ProcessingPauseReason,
  ProcessingState,
} from "./jobStore";
import { createProcessingRoutes } from "./processingRoutes";
import { createStorageGuard } from "./storageGuard";
import type { StorageIncidentStore } from "./storageIncidentStore";

vi.mock("../../../renditions/probe", () => ({
  probeMediaFile: vi.fn(async () => ({})),
  isHdrTransfer: () => false,
  isTextSubtitleCodec: () => true,
}));
vi.mock("../../../renditions/hardware/detect", () => ({
  detectHardware: vi.fn(async () => ({ platform: "test", adapters: [] })),
}));
vi.mock("../../../renditions/registry", () => ({
  computeSourceFingerprint: vi.fn(async () => "fingerprint-1"),
}));

const ITEM = "ddef03b9-2660-4dec-b766-eb8f94a0a110";
const FILE = "fb5c0242-76c4-4052-a978-cc92d77665b0";
const JOB = "980a07a2-0010-43e8-bfb8-673612d84de2";
/** The attempt that parked the work and then finished successfully. */
const HISTORIC_QUEUE_JOB = "c91c2cb0-7ab4-4935-8f8e-6b6592e982c7";

const ACTIVE: readonly ProcessingState[] = [
  "pending",
  "queued",
  "running",
  "paused",
];

const RELATIVE_PATH =
  "Movies/Seyirlik Storage E2E Test (2026)/Seyirlik Storage E2E Test (2026).mp4";

// ------------------------------------------------------------------- queue

interface QueueRow extends JobRecord {
  dedupeKey: string | null;
}

/**
 * The queue, with the two rules that decide this behaviour.
 *
 * `enqueue` collapses onto a live row with the same dedupe key and *only* onto
 * a live one, which is the partial unique index the real table carries; a
 * terminal row with that key holds nothing. `findActive` answers by payload,
 * which is how an attempt is found by what it is for rather than by an id
 * somebody wrote down.
 */
function createQueue(seed: Array<Partial<QueueRow>> = []) {
  const rows: QueueRow[] = [];
  const push = (row: Partial<QueueRow>): QueueRow => {
    const full: QueueRow = {
      id: row.id ?? `queue-${rows.length + 1}`,
      jobType: row.jobType ?? "media.process",
      payload: row.payload ?? {},
      status: row.status ?? "queued",
      attempts: row.attempts ?? 0,
      maxAttempts: 3,
      progress: 0,
      progressMessage: null,
      progressDetail: null,
      priority: 100,
      runAfter: new Date(0),
      safeError: null,
      result: null,
      cancellationRequested: row.cancellationRequested ?? false,
      queuedAt: row.queuedAt ?? new Date(),
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      dedupeKey: row.dedupeKey ?? null,
    };
    rows.push(full);
    return full;
  };
  for (const row of seed) push(row);

  const live = (row: QueueRow) =>
    row.status === "queued" || row.status === "running";

  const queue = {
    rows,
    /** Every attempt ever created for this processing job, in order. */
    attemptsFor: (processingJobId: string) =>
      rows.filter(
        (row) =>
          row.jobType === "media.process" &&
          row.payload.processingJobId === processingJobId,
      ),
    liveAttemptsFor: (processingJobId: string) =>
      queue.attemptsFor(processingJobId).filter(live),

    async enqueue(input: {
      jobType: string;
      payload?: Record<string, unknown>;
      dedupeKey?: string;
    }) {
      if (input.dedupeKey) {
        const collapsed = rows.find(
          (row) => row.dedupeKey === input.dedupeKey && live(row),
        );
        if (collapsed) return collapsed.id;
      }
      return push({
        jobType: input.jobType,
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey ?? null,
      }).id;
    },

    async findActive({
      jobType,
      payload,
    }: {
      jobType: string;
      payload: Record<string, unknown>;
    }) {
      const matches = rows.filter(
        (row) =>
          row.jobType === jobType &&
          live(row) &&
          Object.entries(payload).every(
            ([key, value]) => row.payload[key] === value,
          ),
      );
      return matches[matches.length - 1] ?? null;
    },

    async get(id: string) {
      return rows.find((row) => row.id === id) ?? null;
    },

    async requestCancellation(id: string) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || !live(row)) return false;
      row.cancellationRequested = true;
      // A queued attempt has nobody to tell, so the queue ends it itself.
      if (row.status === "queued") {
        row.status = "cancelled";
        row.finishedAt = new Date();
      }
      return true;
    },

    /** Leases the next attempt, as a worker would. */
    lease(): QueueRow | null {
      const row = rows.find((candidate) => candidate.status === "queued");
      if (!row) return null;
      row.status = "running";
      row.attempts += 1;
      row.startedAt = new Date();
      return row;
    },
    finish(id: string, status: JobStatus = "succeeded"): void {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return;
      row.status = status;
      row.finishedAt = new Date();
    },
  };
  return queue as typeof queue & JobQueue;
}

// ------------------------------------------------------------------- store

function jobRecord(overrides: Partial<ProcessingJobRecord> = {}) {
  return {
    id: JOB,
    jobId: null,
    itemId: ITEM,
    mediaFileId: FILE,
    sourceFingerprint: "fingerprint-1",
    profile: "adaptive-1",
    state: "pending",
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
    warnings: [],
    sourceDamage: null,
    scratchIdentity: null,
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
    createdAt: new Date("2026-09-03T22:15:33.982Z"),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date("2026-09-03T22:15:33.982Z"),
    ...overrides,
  } as ProcessingJobRecord;
}

/**
 * The durable record, with the guards its statements actually carry.
 *
 * Every mutation here refuses a job that is no longer active, because that is
 * what makes the real ones idempotent, and a fake that always succeeds would
 * prove nothing about pressing a button twice.
 */
function createStore(seed: ProcessingJobRecord) {
  const job = { ...seed };
  const events: Array<{ message: string; level: string }> = [];

  const store = {
    job,
    events,
    async get() {
      return { ...job };
    },
    async update(_id: string, update: Record<string, unknown>) {
      Object.assign(job, update);
      return { ...job };
    },
    async attachQueueJob(_id: string, queueJobId: string) {
      job.jobId = queueJobId;
      job.state = "queued";
    },
    async setCurrentAttempt(_id: string, queueJobId: string) {
      job.jobId = queueJobId;
    },
    async requestCancellation() {
      if (!ACTIVE.includes(job.state)) return false;
      job.cancellationRequested = true;
      return true;
    },
    async requestPause(_id: string, reason: ProcessingPauseReason) {
      if (!ACTIVE.includes(job.state) || job.cancellationRequested)
        return false;
      job.pauseRequested = true;
      job.pausedReason = reason;
      job.state = "paused";
      return true;
    },
    async resume(
      _id: string,
      onlyReason?: ProcessingPauseReason,
      resumesInto: "queued" | "running" = "queued",
    ) {
      if (!ACTIVE.includes(job.state)) return false;
      if (onlyReason && job.pausedReason !== onlyReason) return false;
      job.pauseRequested = false;
      job.pausedReason = null;
      if (job.state === "paused") job.state = resumesInto;
      return true;
    },
    async finalizeCancelled() {
      if (!ACTIVE.includes(job.state)) return null;
      job.state = "cancelled";
      job.cancellationRequested = true;
      job.pauseRequested = false;
      job.pausedReason = null;
      job.errorCode = "CANCELLED";
      job.errorMessage = "Processing was cancelled.";
      job.speed = null;
      job.fps = null;
      job.etaSeconds = null;
      job.finishedAt = job.finishedAt ?? new Date();
      return { ...job };
    },
    async appendEvent(input: { message: string; level?: string }) {
      events.push({ message: input.message, level: input.level ?? "info" });
      return null as never;
    },
    async listActive() {
      return ACTIVE.includes(job.state) ? [{ ...job }] : [];
    },
    async findActiveForFile() {
      return ACTIVE.includes(job.state) ? { ...job } : null;
    },
    async list() {
      return [{ ...job }];
    },
    async counts() {
      return {} as never;
    },
    async reconcileTerminalQueueJobs() {
      return 0;
    },
    /** Every attempt this store makes enters at the back of an empty line. */
    async nextQueuePriority() {
      return 100;
    },
  };
  return store as typeof store & ProcessingJobStore;
}

// ----------------------------------------------------------------- fixture

async function library(options: { withSource?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-resume-"));
  const absolute = path.join(root, ...RELATIVE_PATH.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  if (options.withSource !== false) {
    await writeFile(absolute, "pretend source");
  }
  return { root, absolute };
}

function createCatalogue(): CatalogueRepository {
  return {
    getItemKind: async () => "movie" as const,
    listFilesForItem: async () =>
      [
        {
          id: FILE,
          itemId: ITEM,
          relativePath: RELATIVE_PATH,
          sizeBytes: "69381143",
          missingSince: null,
          isPrimary: true,
        },
      ] as unknown as MediaFileRow[],
    listProcessableTitles: async () => [],
    listStreamsForFiles: async () => new Map(),
  } as unknown as CatalogueRepository;
}

function fakeIncidents(): StorageIncidentStore {
  return {
    open: async () => null,
    listOpen: async () => [],
    listRecent: async () => [],
    record: async () => null,
    resolve: async () => null,
  } as unknown as StorageIncidentStore;
}

async function build(
  seed: ProcessingJobRecord,
  options: {
    queue?: ReturnType<typeof createQueue>;
    withSource?: boolean;
    storageGuardHealthy?: boolean;
  } = {},
) {
  const fixture = await library({ withSource: options.withSource !== false });
  const store = createStore(seed);
  const queue = options.queue ?? createQueue();
  const guard = createStorageGuard({
    root: fixture.root,
    watchdog: {
      poll: async () => options.storageGuardHealthy !== false,
      missingRoots: [],
    },
    incidents: fakeIncidents(),
  });
  if (options.storageGuardHealthy === false) {
    await guard.reportFailure({
      kind: "storage-io",
      detail: "A rehearsed fault.",
    });
  }
  const routes = createProcessingRoutes({
    catalogue: createCatalogue(),
    store,
    queue,
    mediaRoot: fixture.root,
    workRoot: fixture.root,
    storageGuard: guard,
  });
  return { routes, store, queue, fixture, guard };
}

async function call(
  routes: ReturnType<typeof createProcessingRoutes>,
  routePath: string,
  jobId = JOB,
) {
  const route = routes.find(
    (candidate) => candidate.path === routePath && candidate.method === "POST",
  );
  expect(route, routePath).toBeDefined();

  const sent = { statusCode: 200, body: "" };
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader() {},
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  const principal: RoutePrincipal = {
    userId: ITEM,
    username: "admin",
    displayName: "Admin",
    isAdministrator: true,
    sessionId: FILE,
    sessionTokenHash: Buffer.alloc(32),
  };
  const context: RouteContext = {
    request: {} as IncomingMessage,
    response,
    requestId: "req",
    url: new URL(`https://seyirlik.test${routePath}`),
    params: { jobId },
    method: "POST",
    principal,
    requirePrincipal: () => principal,
    readJson: async () => ({}),
  };

  let error: OwnApiError | undefined;
  try {
    await route!.handle(context);
  } catch (thrown) {
    error = thrown as OwnApiError;
  }
  return {
    error,
    statusCode: sent.statusCode,
    job: sent.body
      ? ((JSON.parse(sent.body) as { data: { job: Record<string, unknown> } })
          .data.job ?? null)
      : null,
  };
}

const resume = (routes: ReturnType<typeof createProcessingRoutes>) =>
  call(routes, "/processing/jobs/:jobId/resume");
const cancel = (routes: ReturnType<typeof createProcessingRoutes>) =>
  call(routes, "/processing/jobs/:jobId/cancel");

/**
 * The row as it actually stood, and the queue row it pointed at.
 *
 * Reproduced field for field rather than approximated: paused for recovery,
 * never started, and attached to an attempt the queue calls `succeeded`.
 */
function historicalShape() {
  const queue = createQueue([
    {
      id: HISTORIC_QUEUE_JOB,
      jobType: "media.process",
      status: "succeeded",
      attempts: 1,
      dedupeKey: `processing:${FILE}`,
      payload: { processingJobId: JOB },
      startedAt: new Date("2026-09-03T22:15:34.746Z"),
      finishedAt: new Date("2026-09-03T22:15:34.794Z"),
    },
  ]);
  const job = jobRecord({
    jobId: HISTORIC_QUEUE_JOB,
    state: "paused",
    stage: "waiting",
    pauseRequested: true,
    pausedReason: "recovery-pending",
    startedAt: null,
    finishedAt: null,
  });
  return { queue, job };
}

// ------------------------------------------------------------------- tests

describe("resume, on the shape the incident left behind", () => {
  it("queues a new attempt rather than declaring the job running", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });

    const result = await resume(routes);
    expect(result.error).toBeUndefined();

    const attempts = queue.attemptsFor(JOB);
    expect(attempts).toHaveLength(2);
    const created = attempts[1]!;
    expect(created.id).not.toBe(HISTORIC_QUEUE_JOB);
    expect(created.jobType).toBe("media.process");
    expect(created.payload.processingJobId).toBe(JOB);
    expect(created.status).toBe("queued");
    // The source the attempt will read, and where it will publish.
    expect(created.payload.relativePath).toBe(RELATIVE_PATH);
    expect(typeof created.payload.titleRoot).toBe("string");

    // The durable job now points at the attempt that can actually run.
    expect(store.job.jobId).toBe(created.id);
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
  });

  it("does not claim the job is executing before a worker has it", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });

    await resume(routes);

    expect(store.job.state).toBe("queued");
    expect(store.job.startedAt).toBeNull();
    expect(store.job.pauseRequested).toBe(false);
    expect(store.job.pausedReason).toBeNull();
  });

  it("reaches running only once the attempt is leased and the runner says so", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });
    await resume(routes);
    expect(store.job.state).toBe("queued");

    // The worker leases it; the runner is what writes `running` and a start.
    const leased = queue.lease();
    expect(leased?.payload.processingJobId).toBe(JOB);
    await store.update(JOB, { state: "running", startedAt: new Date() });
    expect(store.job.state).toBe("running");
    expect(store.job.startedAt).not.toBeNull();
  });

  it("creates exactly one attempt when pressed twice", async () => {
    const { queue, job } = historicalShape();
    const { routes } = await build(job, { queue });

    await resume(routes);
    const second = await resume(routes);

    expect(second.error).toBeUndefined();
    expect(queue.attemptsFor(JOB)).toHaveLength(2);
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
  });

  it("creates exactly one attempt under concurrent presses", async () => {
    const { queue, job } = historicalShape();
    const { routes } = await build(job, { queue });

    const results = await Promise.all([
      resume(routes),
      resume(routes),
      resume(routes),
    ]);
    for (const result of results) expect(result.error).toBeUndefined();

    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
    // One historical attempt, one new one, whatever the interleaving was.
    expect(queue.attemptsFor(JOB)).toHaveLength(2);
  });

  it("is not blocked by the dedupe key its finished attempt still carries", async () => {
    const { queue, job } = historicalShape();
    expect(queue.rows[0]!.dedupeKey).toBe(`processing:${FILE}`);
    const { routes } = await build(job, { queue });

    await resume(routes);

    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
  });

  it("is not blocked by the durable job's own active-file uniqueness", async () => {
    /*
     * Resuming creates an attempt, never a second `processing_jobs` row, so
     * the unique index over active jobs per media file has nothing to say
     * about it. The store's `create` is the only thing that index guards, and
     * this path does not call it.
     */
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });
    const before = store.job.id;

    await resume(routes);

    expect(store.job.id).toBe(before);
    expect(await store.findActiveForFile()).not.toBeNull();
  });

  it("adopts an attempt that is already executable instead of adding another", async () => {
    const { queue, job } = historicalShape();
    const live = await queue.enqueue({
      jobType: "media.process",
      payload: { processingJobId: JOB },
      dedupeKey: `processing:${FILE}`,
    });
    const { routes, store } = await build(job, { queue });

    await resume(routes);

    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
    expect(store.job.jobId).toBe(live);
  });

  /**
   * A worker still holds the attempt, so there is an encoder to wake — and
   * waking it is not this request's to claim.
   *
   * This used to write `running` on the spot, which read as harmless because an
   * encoder really was there. It is not harmless: suspension on Windows is
   * `NtSuspendProcess` on a handle, and coming back from it is a round trip
   * through a helper process that can fail. For that round trip the page would
   * have said Running over a process that was still frozen — the mirror of the
   * bug where it said Paused over one that was still encoding.
   *
   * So the route lifts the *request* and leaves the state alone. The row then
   * reads paused with nothing requesting it, which is exactly "resuming", and
   * the worker writes `running` when the operating system has agreed.
   */
  it("hands the resume to the worker when one still holds the attempt", async () => {
    const { queue, job } = historicalShape();
    await queue.enqueue({
      jobType: "media.process",
      payload: { processingJobId: JOB },
      dedupeKey: `processing:${FILE}`,
    });
    queue.lease();
    const { routes, store } = await build(job, { queue });

    await resume(routes);

    expect(store.job.state).toBe("paused");
    expect(store.job.pauseRequested).toBe(false);
    expect(store.job.pausedReason).toBeNull();
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
  });

  it("repairs a job left running by a worker that died", async () => {
    const orphan = jobRecord({
      jobId: HISTORIC_QUEUE_JOB,
      state: "running",
      stage: "waiting",
      startedAt: null,
    });
    const { queue } = historicalShape();
    const { routes, store } = await build(orphan, { queue });

    await resume(routes);

    expect(store.job.state).toBe("queued");
    expect(store.job.startedAt).toBeNull();
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
  });

  it("refuses while the storage is guarded, and queues nothing", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, {
      queue,
      storageGuardHealthy: false,
    });

    const result = await resume(routes);

    expect(result.error?.code).toBe("PROCESSING_STORAGE_GUARDED");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);
    expect(store.job.state).toBe("paused");
    expect(store.job.pausedReason).toBe("recovery-pending");
  });

  it("refuses when the source is gone, without un-pausing the job", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue, withSource: false });

    const result = await resume(routes);

    expect(result.error?.code).toBe("SOURCE_UNAVAILABLE");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);
    expect(store.job.state).toBe("paused");
    expect(store.job.pauseRequested).toBe(true);
  });

  it("refuses a job that has already finished", async () => {
    const { queue } = historicalShape();
    const { routes } = await build(
      jobRecord({ state: "succeeded", finishedAt: new Date() }),
      { queue },
    );

    const result = await resume(routes);

    expect(result.error?.code).toBe("PROCESSING_JOB_NOT_RESUMABLE");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);
  });

  it("refuses a job that is on its way out", async () => {
    const { queue, job } = historicalShape();
    const { routes } = await build(
      { ...job, cancellationRequested: true },
      { queue },
    );

    const result = await resume(routes);

    expect(result.error?.code).toBe("PROCESSING_JOB_CANCELLING");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);
  });

  it("resumes recovery-pending work once the identity is healthy again", async () => {
    const { queue, job } = historicalShape();
    const { routes, store, guard } = await build(job, { queue });
    expect(guard.mayStartWork()).toBe(true);

    const result = await resume(routes);

    expect(result.error).toBeUndefined();
    expect(store.job.pausedReason).toBeNull();
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
    expect(store.events.at(-1)?.message).toContain("Resumed");
  });
});

describe("cancel, on the shape the incident left behind", () => {
  it("ends the durable job even though its only attempt already succeeded", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });

    const result = await cancel(routes);

    expect(result.error).toBeUndefined();
    expect(store.job.state).toBe("cancelled");
    expect(store.job.finishedAt).not.toBeNull();
    expect(store.job.pauseRequested).toBe(false);
    expect(store.job.pausedReason).toBeNull();
    expect(store.job.speed).toBeNull();
    expect(store.job.fps).toBeNull();
    expect(store.job.etaSeconds).toBeNull();
    // The historical row is history. Nothing rewrote it.
    expect(queue.rows[0]!.status).toBe("succeeded");
    expect(queue.rows[0]!.cancellationRequested).toBe(false);
  });

  it("cancels a queued attempt and the job with it, before any lease", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });
    await resume(routes);
    const attempt = queue.liveAttemptsFor(JOB)[0]!;

    await cancel(routes);

    expect(attempt.status).toBe("cancelled");
    expect(attempt.cancellationRequested).toBe(true);
    expect(store.job.state).toBe("cancelled");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);
  });

  it("leaves a running attempt to stop itself", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });
    await resume(routes);
    queue.lease();
    const attempt = queue.liveAttemptsFor(JOB)[0]!;

    await cancel(routes);

    // The flag is set, and the runner's own path does the ending and the
    // cleanup — which is the only code that knows what is half-written.
    expect(attempt.cancellationRequested).toBe(true);
    expect(attempt.status).toBe("running");
    expect(store.job.cancellationRequested).toBe(true);
    expect(store.job.state).not.toBe("cancelled");
    expect(store.job.finishedAt).toBeNull();
  });

  it("is harmless pressed twice", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });

    const first = await cancel(routes);
    const finishedAt = store.job.finishedAt;
    const second = await cancel(routes);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(store.job.state).toBe("cancelled");
    // The finish time is the first one. A second press is not a new ending.
    expect(store.job.finishedAt).toBe(finishedAt);
  });

  it("does not disturb a job that already finished", async () => {
    const { queue } = historicalShape();
    const succeeded = jobRecord({
      state: "succeeded",
      publishedVersion: "2026-09-03",
      finishedAt: new Date("2026-09-03T23:00:00.000Z"),
    });
    const { routes, store } = await build(succeeded, { queue });

    const result = await cancel(routes);

    expect(result.error).toBeUndefined();
    expect(store.job.state).toBe("succeeded");
    expect(store.job.publishedVersion).toBe("2026-09-03");
    expect(store.job.cancellationRequested).toBe(false);
    expect(store.events).toHaveLength(0);
  });

  it("keeps the published package and the workspace it may still need", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(
      {
        ...job,
        publishedVersion: "2026-09-01",
        stagingDirectory: "/scratch/980a07a2",
      },
      { queue },
    );

    await cancel(routes);

    expect(store.job.state).toBe("cancelled");
    // Neither is touched here: releasing them belongs to the paths that can
    // prove it is safe, and a cancel has the least information of anybody.
    expect(store.job.publishedVersion).toBe("2026-09-01");
    expect(store.job.stagingDirectory).toBe("/scratch/980a07a2");
  });
});

describe("an attempt that parks its job", () => {
  /**
   * The exact sequence that produced the incident, played forward.
   *
   * A `media.process` run that parks the durable job for storage returns
   * successfully — that is deliberate, since a missing volume is not a failed
   * job and must not burn the queue's attempts. What must survive it is the
   * ability to make another attempt later.
   */
  it("succeeds without finishing the job, and a later resume still works", async () => {
    const queue = createQueue();
    const { routes, store } = await build(jobRecord({ state: "queued" }), {
      queue,
    });

    // The first attempt: queued, leased, parks the job, ends successfully.
    const first = await queue.enqueue({
      jobType: "media.process",
      payload: { processingJobId: JOB },
      dedupeKey: `processing:${FILE}`,
    });
    await store.setCurrentAttempt(JOB, first);
    queue.lease();
    await store.requestPause(JOB, "recovery-pending");
    queue.finish(first, "succeeded");

    expect(store.job.state).toBe("paused");
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(0);

    const result = await resume(routes);

    expect(result.error).toBeUndefined();
    expect(queue.attemptsFor(JOB)).toHaveLength(2);
    expect(queue.liveAttemptsFor(JOB)).toHaveLength(1);
    expect(store.job.jobId).not.toBe(first);
    expect(store.job.state).toBe("queued");
  });
});

describe("the state a resume may never leave behind", () => {
  it("never produces running / waiting / never-started", async () => {
    const { queue, job } = historicalShape();
    const { routes, store } = await build(job, { queue });

    await resume(routes);
    await resume(routes);
    await cancel(routes);

    const orphaned =
      store.job.state === "running" &&
      store.job.stage === "waiting" &&
      store.job.startedAt === null;
    expect(orphaned).toBe(false);
  });
});
