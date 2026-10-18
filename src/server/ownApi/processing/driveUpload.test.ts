// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createDriveUploadTracker,
  driveRcConfigFromEnvironment,
  MEMBERSHIP_WINDOW_MS,
  MINIMUM_TRACKING_MS,
  mountPrefixFor,
  nextDriveUpload,
  type DriveRcClient,
  type DriveUploadStore,
  type RcQueueEntry,
  type RcTransfer,
} from "./driveUpload";
import { publicDriveUpload, type StoredDriveUpload } from "./driveUploadStatus";

const TITLE = "media/Movies/The Empire Strikes Back (1980)/";

/** What rclone's `vfs/queue` and `core/stats` returned mid-upload. */
const QUEUE: RcQueueEntry[] = [
  {
    name: `${TITLE}video/2160p.mp4`,
    size: 10_392_937_363,
    uploading: true,
    tries: 2,
  },
  {
    name: `${TITLE}video/1440p.mp4`,
    size: 5_345_581_324,
    uploading: true,
    tries: 2,
  },
];
const TRANSFERS: RcTransfer[] = [
  {
    name: `${TITLE}video/2160p.mp4`,
    bytes: 6_226_440_192,
    size: 10_392_937_363,
    speed: 7_812_787,
  },
  {
    name: `${TITLE}video/1440p.mp4`,
    bytes: 4_639_977_472,
    size: 5_345_581_324,
    speed: 8_916_753,
  },
];

function started(over: Partial<StoredDriveUpload> = {}): StoredDriveUpload {
  return {
    prefix: TITLE,
    state: "uploading",
    totalBytes: 33_235_270_203,
    uploadedBytes: 0,
    filesPending: 0,
    filesUploading: 0,
    startedAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe("where a title sits under the Drive mount", () => {
  it("names it the way rclone names queue entries", () => {
    expect(
      mountPrefixFor(
        "D:\\",
        "D:\\media\\Movies\\The Empire Strikes Back (1980)",
      ),
    ).toBe(TITLE);
    expect(mountPrefixFor("/mnt/drive", "/mnt/drive/media/Series/X")).toBe(
      "media/Series/X/",
    );
  });

  it("refuses a folder that is not on the mount", () => {
    expect(mountPrefixFor("D:\\", "C:\\Seyirlik\\work\\scratch")).toBeNull();
    expect(mountPrefixFor("D:\\", "D:\\")).toBeNull();
  });
});

describe("one reading of the upload queue", () => {
  it("counts what is queued less what is already sent", () => {
    const { upload } = nextDriveUpload(started(), QUEUE, TRANSFERS, 60_000, 0);
    const pending =
      10_392_937_363 - 6_226_440_192 + (5_345_581_324 - 4_639_977_472);
    expect(upload.uploadedBytes).toBe(33_235_270_203 - pending);
    expect(upload.filesPending).toBe(2);
    expect(upload.filesUploading).toBe(2);
    expect(upload.bytesPerSecond).toBe(7_812_787 + 8_916_753);
    expect(upload.etaSeconds).toBe(
      Math.round(pending / (7_812_787 + 8_916_753)),
    );
    expect(upload.retries).toBe(1);
    expect(upload.state).toBe("uploading");
  });

  it("ignores another title's uploads", () => {
    const { upload } = nextDriveUpload(
      started(),
      [
        ...QUEUE,
        { name: "media/Movies/Other (2001)/video/1080p.mp4", size: 4e9 },
      ],
      TRANSFERS,
      60_000,
      0,
    );
    expect(upload.filesPending).toBe(2);
  });

  /*
   * A season folder is shared. The next episode published into it while this
   * one is still uploading must not keep this one "uploading" for ever.
   */
  it("stops taking in new files once the membership window closes", () => {
    const first = nextDriveUpload(started(), QUEUE, [], 2_000, 0).upload;
    const later = nextDriveUpload(
      first,
      [{ name: `${TITLE}video/720p.mp4`, size: 1e9 }],
      [],
      MEMBERSHIP_WINDOW_MS + 5_000,
      0,
    );
    expect(later.upload.filesPending).toBe(0);
  });

  it("never moves the uploaded figure backwards", () => {
    const ahead = started({ uploadedBytes: 30e9 });
    const { upload } = nextDriveUpload(ahead, QUEUE, [], 60_000, 0);
    expect(upload.uploadedBytes).toBe(30e9);
  });

  it("finishes only after repeated empty readings, and not too early", () => {
    const early = nextDriveUpload(started(), [], [], 1_000, 1);
    expect(early.upload.state).toBe("uploading");

    const once = nextDriveUpload(started(), [], [], MINIMUM_TRACKING_MS, 0);
    expect(once.upload.state).toBe("uploading");
    const twice = nextDriveUpload(
      once.upload,
      [],
      [],
      MINIMUM_TRACKING_MS + 2_000,
      once.emptyReads,
    );
    expect(twice.upload.state).toBe("uploaded");
    expect(twice.upload.uploadedBytes).toBe(twice.upload.totalBytes);
    expect(twice.upload.finishedAtMs).toBe(MINIMUM_TRACKING_MS + 2_000);
  });
});

describe("the tracker", () => {
  function harness(readings: Array<[RcQueueEntry[], RcTransfer[]]>) {
    let at = 0;
    let index = 0;
    const writes: StoredDriveUpload[] = [];
    const client: DriveRcClient = {
      queue: async () => readings[Math.min(index, readings.length - 1)]![0],
      transferring: async () => {
        const result = readings[Math.min(index, readings.length - 1)]![1];
        index += 1;
        return result;
      },
    };
    const store: DriveUploadStore = {
      write: vi.fn(async (_id: string, upload: StoredDriveUpload) => {
        writes.push(upload);
      }),
      listUnfinished: async () => [],
    };
    const finished = vi.fn();
    const tracker = createDriveUploadTracker({
      config: { url: "http://127.0.0.1:5573", mountRoot: "D:\\" },
      client,
      store,
      now: () => at,
      pollMs: 60_000_000,
      onFinished: finished,
    });
    return {
      tracker,
      writes,
      finished,
      advance: (ms: number) => {
        at += ms;
      },
    };
  }

  it("does nothing for a folder off the mount", async () => {
    const h = harness([[QUEUE, TRANSFERS]]);
    expect(
      await h.tracker.track({
        processingJobId: "job-1",
        directory: "C:\\Seyirlik\\work",
        totalBytes: 1,
      }),
    ).toBe(false);
    expect(h.writes).toHaveLength(0);
    h.tracker.stop();
  });

  it("writes progress onto the job and reports when the title is on Drive", async () => {
    vi.useFakeTimers();
    try {
      const h = harness([
        [QUEUE, TRANSFERS],
        [[], []],
        [[], []],
      ]);
      await h.tracker.track({
        processingJobId: "job-1",
        directory: "D:\\media\\Movies\\The Empire Strikes Back (1980)",
        totalBytes: 33_235_270_203,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.writes.at(-1)?.filesPending).toBe(2);

      for (let i = 0; i < 2; i += 1) {
        h.advance(MINIMUM_TRACKING_MS);
        await vi.advanceTimersByTimeAsync(60_000_000);
      }
      expect(h.writes.at(-1)?.state).toBe("uploaded");
      expect(h.finished).toHaveBeenCalledWith(
        "job-1",
        expect.objectContaining({ state: "uploaded" }),
      );
      h.tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("configuration and the public shape", () => {
  it("reads the mount's control address from the environment", () => {
    expect(
      driveRcConfigFromEnvironment({
        SEYIRLIK_DRIVE_RC: JSON.stringify({
          url: "http://127.0.0.1:5573/",
          mountRoot: "D:\\",
          user: "u",
          pass: "p",
        }),
      }),
    ).toEqual({
      url: "http://127.0.0.1:5573",
      mountRoot: "D:\\",
      user: "u",
      pass: "p",
    });
    expect(driveRcConfigFromEnvironment({})).toBeNull();
    expect(
      driveRcConfigFromEnvironment({ SEYIRLIK_DRIVE_RC: "not json" }),
    ).toBeNull();
  });

  it("never sends the folder path to the page", () => {
    const status = publicDriveUpload({
      ...started({ members: [`${TITLE}video/2160p.mp4`] }),
    } as unknown as Record<string, unknown>);
    expect(status).not.toHaveProperty("prefix");
    expect(status).not.toHaveProperty("members");
    expect(status?.totalBytes).toBe(33_235_270_203);
  });
});
