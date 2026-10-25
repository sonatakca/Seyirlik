// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createDriveUploadTracker,
  driveRcConfigFromEnvironment,
  MEMBERSHIP_WINDOW_MS,
  MINIMUM_TRACKING_MS,
  mountPrefixFor,
  mountPrefixForAny,
  nextDriveUpload,
  type DriveRcClient,
  type DriveUploadStore,
  type RcQueueEntry,
  type RcTransfer,
} from "./driveUpload";
import {
  combineDriveUploads,
  publicDriveUpload,
  type DriveUploadStatus,
  type StoredDriveUpload,
} from "./driveUploadStatus";

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

  /*
   * Every job the import sweep queued on 2026-10-19 carried a title root under
   * the volume's UNC name, because the library root is a realpath. Against
   * `D:\` alone none of them matched, and 22 uploads went unwatched.
   */
  it("knows the mount by its UNC name as well as its drive letter", async () => {
    const resolve = vi.fn(async () => "\\\\seyirlik\\drive\\");
    expect(
      await mountPrefixForAny(
        "D:\\",
        "\\\\seyirlik\\drive\\media\\Series\\The Sopranos\\Season 3\\The Sopranos - S03E08",
        resolve,
      ),
    ).toBe("media/Series/The Sopranos/Season 3/The Sopranos - S03E08/");
    expect(
      await mountPrefixForAny(
        "D:\\",
        "D:\\media\\Movies\\The Empire Strikes Back (1980)",
        resolve,
      ),
    ).toBe(TITLE);
    expect(
      await mountPrefixForAny("D:\\", "\\\\other\\share\\media\\X", resolve),
    ).toBeNull();
  });

  it("finds nothing when the mount cannot be resolved", async () => {
    expect(
      await mountPrefixForAny(
        "D:\\",
        "\\\\seyirlik\\drive\\media\\X",
        async () => {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
      ),
    ).toBeNull();
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
  function harness(
    readings: Array<[RcQueueEntry[], RcTransfer[]]>,
    deleteSource = false,
  ) {
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
      listRemote: async () => [],
    };
    const store: DriveUploadStore = {
      write: vi.fn(async (_id: string, upload: StoredDriveUpload) => {
        writes.push(upload);
      }),
      listUnfinished: async () => [],
    };
    const finished = vi.fn();
    const tracker = createDriveUploadTracker({
      config: { url: "http://127.0.0.1:5573", mountRoot: "D:\\", deleteSource },
      client,
      store,
      now: () => at,
      pollMs: 60_000_000,
      resolvePath: async () => "\\\\seyirlik\\drive\\",
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
      // Nothing asked for a deletion, so nothing will act on one.
      expect(h.writes.some((write) => write.deleteSource)).toBe(false);
      h.tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a deletion request on every reading, through to the last", async () => {
    vi.useFakeTimers();
    try {
      const h = harness(
        [
          [QUEUE, TRANSFERS],
          [[], []],
          [[], []],
        ],
        true,
      );
      await h.tracker.track({
        processingJobId: "job-1",
        directory: "D:\\media\\Movies\\The Empire Strikes Back (1980)",
        totalBytes: 33_235_270_203,
      });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 2; i += 1) {
        h.advance(MINIMUM_TRACKING_MS);
        await vi.advanceTimersByTimeAsync(60_000_000);
      }
      expect(h.writes.length).toBeGreaterThan(1);
      expect(h.writes.every((write) => write.deleteSource === true)).toBe(true);
      expect(h.finished).toHaveBeenCalledWith(
        "job-1",
        expect.objectContaining({ state: "uploaded", deleteSource: true }),
      );
      h.tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * An imported episode lands in `src/` beside the rest of its season, so a
   * folder prefix would count every neighbour's upload as its own.
   */
  it("follows one imported file and none of the files beside it", async () => {
    const folder = "media/Series/Arcane/Season 1/src/";
    const h = harness([
      [
        [
          { name: `${folder}Arcane - S01E09.mkv`, size: 7_603_618_701 },
          { name: `${folder}Arcane - S01E09.mkv.tur.srt`, size: 25_013 },
          { name: `${folder}Arcane - S01E08.mkv`, size: 6_939_257_801 },
        ],
        [
          {
            name: `${folder}Arcane - S01E09.mkv`,
            bytes: 3_500_000_000,
            size: 7_603_618_701,
            speed: 2_800_000,
          },
        ],
      ],
    ]);
    expect(
      await h.tracker.track({
        processingJobId: "import-file-1",
        file: "D:\\media\\Series\\Arcane\\Season 1\\src\\Arcane - S01E09.mkv",
        totalBytes: 7_603_618_701,
      }),
    ).toBe(true);
    await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(1));
    const last = h.writes.at(-1)!;
    expect(last.prefix).toBe(`${folder}Arcane - S01E09.mkv`);
    expect(last.members).toEqual([`${folder}Arcane - S01E09.mkv`]);
    expect(last.filesPending).toBe(1);
    expect(last.uploadedBytes).toBe(3_500_000_000);
    expect(last.bytesPerSecond).toBe(2_800_000);
    h.tracker.stop();
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
      deleteSource: true,
    });
    expect(
      driveRcConfigFromEnvironment({
        SEYIRLIK_DRIVE_RC: JSON.stringify({
          url: "http://127.0.0.1:5573",
          mountRoot: "D:\\",
          deleteSource: false,
        }),
      })?.deleteSource,
    ).toBe(false);
    expect(driveRcConfigFromEnvironment({})).toBeNull();
    expect(
      driveRcConfigFromEnvironment({ SEYIRLIK_DRIVE_RC: "not json" }),
    ).toBeNull();
  });

  it("reads a season's files as one upload", () => {
    const file = (over: Partial<DriveUploadStatus>): DriveUploadStatus => ({
      state: "uploading",
      totalBytes: 100,
      uploadedBytes: 0,
      filesPending: 1,
      filesUploading: 0,
      startedAtMs: 1_000,
      updatedAtMs: 9_000,
      ...over,
    });
    expect(combineDriveUploads([null, undefined])).toBeNull();
    const one = file({});
    expect(combineDriveUploads([one, undefined])).toBe(one);

    const combined = combineDriveUploads([
      file({
        uploadedBytes: 40,
        filesUploading: 1,
        bytesPerSecond: 10,
        startedAtMs: 500,
        updatedAtMs: 8_000,
      }),
      file({ uploadedBytes: 100, filesPending: 0, state: "uploaded" }),
      file({ retries: 2 }),
    ]);
    expect(combined).toMatchObject({
      state: "uploading",
      totalBytes: 300,
      uploadedBytes: 140,
      filesPending: 2,
      filesUploading: 1,
      bytesPerSecond: 10,
      etaSeconds: 16,
      retries: 2,
      startedAtMs: 500,
      // The oldest reading of what is still uploading.
      updatedAtMs: 8_000,
    });

    const finished = combineDriveUploads([
      file({
        state: "uploaded",
        uploadedBytes: 100,
        filesPending: 0,
        finishedAtMs: 20_000,
      }),
      file({
        state: "uploaded",
        uploadedBytes: 100,
        filesPending: 0,
        finishedAtMs: 30_000,
      }),
    ]);
    expect(finished).toMatchObject({
      state: "uploaded",
      uploadedBytes: 200,
      finishedAtMs: 30_000,
    });
    expect(finished).not.toHaveProperty("bytesPerSecond");
  });

  it("never sends the folder path to the page", () => {
    const status = publicDriveUpload({
      ...started({
        members: [`${TITLE}video/2160p.mp4`],
        deleteSource: true,
        source: { state: "kept", atMs: 1, reason: "D:\\media\\x" },
      }),
    } as unknown as Record<string, unknown>);
    expect(status).not.toHaveProperty("prefix");
    expect(status).not.toHaveProperty("members");
    expect(status).not.toHaveProperty("deleteSource");
    expect(status).not.toHaveProperty("source");
    expect(status?.totalBytes).toBe(33_235_270_203);
  });
});
