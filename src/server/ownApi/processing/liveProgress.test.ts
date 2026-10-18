// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLiveProgress,
  readLiveProgress,
  shareLiveProgress,
  SHARED_LIVE_PROGRESS_INTERVAL_MS,
  writeLiveProgress,
  type LiveProgressSnapshot,
  type SharedLiveProgressStore,
} from "./liveProgress";

const JOB = "0b2b1c4e-1111-4222-8333-444455556666";

function sample(
  over: Partial<LiveProgressSnapshot> = {},
): LiveProgressSnapshot {
  return {
    processingJobId: JOB,
    revision: 1,
    timestampMs: Date.now(),
    stage: "video",
    phase: "encoding",
    epochIndex: 1,
    epochCount: 25,
    epochStartSeconds: 300,
    epochEndSeconds: 600,
    epochFraction: 0.5,
    completedEpochs: 1,
    protectedSeconds: 300,
    encodedSeconds: 450,
    sourceDurationSeconds: 7644,
    ...over,
  } as LiveProgressSnapshot;
}

function memoryStore() {
  const rows = new Map<string, LiveProgressSnapshot>();
  const store: SharedLiveProgressStore = {
    write: vi.fn(async (snapshot: LiveProgressSnapshot) => {
      rows.set(snapshot.processingJobId, snapshot);
    }),
    read: async (id: string) => rows.get(id) ?? null,
    clear: vi.fn(async (id: string) => {
      rows.delete(id);
    }),
    prune: async () => undefined,
  };
  return { store, rows };
}

describe("live progress shared between machines", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "seyirlik-live-test-"));
    vi.stubEnv("SEYIRLIK_LIVE_PROGRESS_DIR", directory);
  });
  afterEach(async () => {
    shareLiveProgress(null);
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("writes to the shared store at most once a second within a phase", async () => {
    const { store } = memoryStore();
    shareLiveProgress(store);
    await writeLiveProgress(sample({ revision: 1 }), 10_000);
    await writeLiveProgress(sample({ revision: 2 }), 10_250);
    await writeLiveProgress(sample({ revision: 3 }), 10_500);
    await writeLiveProgress(
      sample({ revision: 4 }),
      10_000 + SHARED_LIVE_PROGRESS_INTERVAL_MS,
    );
    expect(store.write).toHaveBeenCalledTimes(2);
  });

  it("writes a new phase at once, so the page changes panels with it", async () => {
    const { store } = memoryStore();
    shareLiveProgress(store);
    await writeLiveProgress(sample({ revision: 1, phase: "encoding" }), 10_000);
    await writeLiveProgress(
      sample({ revision: 2, phase: "audio", stage: "audio" }),
      10_100,
    );
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.write).mock.calls[1]![0].phase).toBe("audio");
  });

  it("reads the shared sample when this machine is not the one encoding", async () => {
    const { store, rows } = memoryStore();
    shareLiveProgress(store);
    rows.set(JOB, sample({ phase: "audio", stage: "audio" }));
    expect((await readLiveProgress(JOB))?.phase).toBe("audio");
  });

  it("prefers a newer shared sample over a stale local file", async () => {
    const { store, rows } = memoryStore();
    // A file an earlier run on this machine left behind.
    await writeLiveProgress(
      sample({ phase: "encoding", timestampMs: Date.now() - 60_000 }),
    );
    shareLiveProgress(store);
    rows.set(JOB, sample({ phase: "publishing", stage: "publishing" }));
    expect((await readLiveProgress(JOB))?.phase).toBe("publishing");
  });

  it("clears both copies when the job ends", async () => {
    const { store, rows } = memoryStore();
    shareLiveProgress(store);
    await writeLiveProgress(sample(), 10_000);
    await clearLiveProgress(JOB);
    expect(rows.has(JOB)).toBe(false);
    expect(await readLiveProgress(JOB)).toBeNull();
  });
});
