// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  createEmptyRenditionRegistry,
  type RenditionRegistryItem,
} from "../../../renditions/registry";
import { OwnApiError } from "../ownApiHandler";
import type { RcRemoteFile } from "./driveUpload";
import type { StoredDriveUpload } from "./driveUploadStatus";
import type { ProcessingJobRecord } from "./jobStore";
import {
  createSourceCleanup,
  packageGapsOnDrive,
  type SourceCleanupStore,
} from "./sourceCleanup";

const FINGERPRINT = "fingerprint-1";
const MEDIA = "pretend 1080p rendition";
const AUDIO = "pretend audio";
const SOURCE_RELATIVE =
  "Series/The Sopranos/Season 3/The Sopranos - S03E08.mkv";

/**
 * A mount holding one episode's published package, laid out as the helper
 * publishes it, and the listing Drive would give for it once whole.
 */
async function fixture() {
  const mountRoot = await mkdtemp(path.join(tmpdir(), "seyirlik-cleanup-"));
  const titleRoot = path.join(
    mountRoot,
    "media",
    "Series",
    "The Sopranos",
    "Season 3",
    "The Sopranos - S03E08",
  );
  const sourcePath = path.join(
    mountRoot,
    "media",
    "Series",
    "The Sopranos",
    "Season 3",
    "src",
    "The Sopranos - S03E08.mkv",
  );
  await mkdir(path.join(titleRoot, ".seyirlik", "video"), { recursive: true });
  await mkdir(path.join(titleRoot, ".seyirlik", "audio"), { recursive: true });
  await mkdir(path.join(titleRoot, "video"), { recursive: true });
  await mkdir(path.join(titleRoot, "audio"), { recursive: true });
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "pretend source");

  const manifest: TitlePackageManifest = {
    schemaVersion: 1,
    profileVersion: "test-profile",
    sourceFingerprint: FINGERPRINT,
    createdAt: "2026-10-19T11:23:00.000Z",
    sourceDurationSeconds: 3000,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    video: [
      {
        id: "v1080",
        mediaPath: "video/1080p.mp4",
        playlistPath: ".seyirlik/video/1080p.m3u8",
        fileSizeBytes: MEDIA.length,
        qualityHeight: 1080,
        hdr: "sdr",
      },
    ],
    audio: [
      {
        id: "a0",
        mediaPath: "audio/audio.m4a",
        playlistPath: ".seyirlik/audio/audio.m3u8",
        fileSizeBytes: AUDIO.length,
      },
    ],
    subtitle: [],
    storage: { totalBytes: MEDIA.length + AUDIO.length },
  } as unknown as TitlePackageManifest;
  const manifestText = JSON.stringify(manifest);

  const files: Record<string, string> = {
    "video/1080p.mp4": MEDIA,
    "audio/audio.m4a": AUDIO,
    ".seyirlik/master.m3u8": "#EXTM3U",
    ".seyirlik/video/1080p.m3u8": "#EXTM3U",
    ".seyirlik/audio/audio.m3u8": "#EXTM3U",
    ".seyirlik/package.json": manifestText,
  };
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(path.join(titleRoot, ...relative.split("/")), content);
  }

  const prefix = "media/Series/The Sopranos/Season 3/The Sopranos - S03E08/";
  const onDrive: RcRemoteFile[] = Object.entries(files).map(
    ([relative, content]) => ({
      Path: `${prefix}${relative}`,
      Size: Buffer.byteLength(content),
    }),
  );
  return { mountRoot, titleRoot, sourcePath, manifest, prefix, onDrive };
}

const identity = async (target: string) => target;

describe("what Drive holds of a package", () => {
  it("finds nothing missing when Drive lists every file at its size", async () => {
    const f = await fixture();
    const listRemote = vi.fn(async () => f.onDrive);
    expect(
      await packageGapsOnDrive({
        client: { listRemote },
        mountRoot: f.mountRoot,
        titleRoot: f.titleRoot,
        manifest: f.manifest,
        resolvePath: identity,
      }),
    ).toEqual([]);
    // Asked about this title's folder on the remote, not about the whole mount.
    expect(listRemote).toHaveBeenCalledWith(f.prefix.slice(0, -1));
  });

  it("names a rendition Drive does not have", async () => {
    const f = await fixture();
    const gaps = await packageGapsOnDrive({
      client: {
        listRemote: async () =>
          f.onDrive.filter((file) => !file.Path.endsWith("1080p.mp4")),
      },
      mountRoot: f.mountRoot,
      titleRoot: f.titleRoot,
      manifest: f.manifest,
      resolvePath: identity,
    });
    expect(gaps.join(" ")).toContain("video/1080p.mp4 is not on Drive");
  });

  /*
   * A file still uploading appears on Drive only once it is complete, but a
   * resumable upload that died can leave a shorter object behind, and the
   * cache's copy is whole either way. Only the size on Drive says which.
   */
  it("names a rendition Drive holds short", async () => {
    const f = await fixture();
    const gaps = await packageGapsOnDrive({
      client: {
        listRemote: async () =>
          f.onDrive.map((file) =>
            file.Path.endsWith("1080p.mp4") ? { ...file, Size: 5 } : file,
          ),
      },
      mountRoot: f.mountRoot,
      titleRoot: f.titleRoot,
      manifest: f.manifest,
      resolvePath: identity,
    });
    expect(gaps.join(" ")).toContain("video/1080p.mp4 is 5 bytes on Drive");
  });

  it("requires the manifest itself on Drive, since nothing plays without it", async () => {
    const f = await fixture();
    const gaps = await packageGapsOnDrive({
      client: {
        listRemote: async () =>
          f.onDrive.filter((file) => !file.Path.endsWith("package.json")),
      },
      mountRoot: f.mountRoot,
      titleRoot: f.titleRoot,
      manifest: f.manifest,
      resolvePath: identity,
    });
    expect(gaps).toEqual([".seyirlik/package.json is not on Drive"]);
  });

  it("fails, rather than answering, when Drive cannot be listed", async () => {
    const f = await fixture();
    await expect(
      packageGapsOnDrive({
        client: {
          listRemote: async () => {
            throw new Error("rclone operations/list answered 500");
          },
        },
        mountRoot: f.mountRoot,
        titleRoot: f.titleRoot,
        manifest: f.manifest,
        resolvePath: identity,
      }),
    ).rejects.toThrow("500");
  });

  it("refuses a title that is not on the mount at all", async () => {
    const f = await fixture();
    await expect(
      packageGapsOnDrive({
        client: { listRemote: async () => f.onDrive },
        mountRoot: path.join(f.mountRoot, "elsewhere"),
        titleRoot: f.titleRoot,
        manifest: f.manifest,
        resolvePath: identity,
      }),
    ).rejects.toThrow("not on the Drive mount");
  });
});

describe("removing the source after upload", () => {
  const JOB = "33333333-3333-4333-8333-333333333333";
  const uploaded: StoredDriveUpload = {
    prefix: "media/x/",
    deleteSource: true,
    state: "uploaded",
    totalBytes: 1,
    uploadedBytes: 1,
    filesPending: 0,
    filesUploading: 0,
    startedAtMs: 0,
    updatedAtMs: 1,
    finishedAtMs: 1,
  };

  async function harness(
    over: {
      job?: Partial<ProcessingJobRecord> | null;
      gaps?: string[] | Error;
      mayDelete?: boolean;
      removal?: "deleted" | "absent" | OwnApiError | Error;
      /** The registry entry playback would use; null when there is none. */
      entry?: Partial<RenditionRegistryItem> | null;
    } = {},
  ) {
    const f = await fixture();
    const recorded: Array<[string, unknown]> = [];
    const store: SourceCleanupStore = {
      record: vi.fn(async (id: string, outcome: unknown) => {
        recorded.push([id, outcome]);
      }),
      listAwaiting: vi.fn(async () => [JOB]),
    };
    const events: string[] = [];
    const removeSource = vi.fn(async () => {
      const removal = over.removal ?? "deleted";
      if (removal instanceof Error) throw removal;
      return {
        file: { id: "file-1" },
        deleted: removal === "deleted",
        alreadyAbsent: removal === "absent",
        freedBytes: removal === "deleted" ? 6_000_000_000 : 0,
      };
    });
    const verifyOnDrive = vi.fn(async () => {
      if (over.gaps instanceof Error) throw over.gaps;
      return over.gaps ?? [];
    });
    const job =
      over.job === null
        ? null
        : ({
            id: JOB,
            itemId: "item-1",
            mediaFileId: "file-1",
            sourceFingerprint: FINGERPRINT,
            state: "succeeded",
            publishedVersion: "cmaf-hls-aligned-v3-81420a79cc6f8e16",
            ...over.job,
          } as ProcessingJobRecord);
    const log = vi.fn();
    const cleanup = createSourceCleanup({
      jobs: {
        get: async () => job,
        appendEvent: async (input: { message: string }) => {
          events.push(input.message);
        },
      } as unknown as Parameters<typeof createSourceCleanup>[0]["jobs"],
      enqueuer: {
        locateSource: async () =>
          ({
            file: {
              id: "file-1",
              relativePath: SOURCE_RELATIVE,
              sizeBytes: "6000000000",
              mtimeMs: "1760000000000",
            },
            absolutePath: f.sourcePath,
          }) as never,
        titleRootFor: async () => f.titleRoot,
        removeSource: removeSource as never,
      },
      store,
      registry: {
        read: async () => ({
          ...createEmptyRenditionRegistry(),
          items:
            over.entry === null
              ? []
              : [
                  {
                    id: "11111111-1111-4111-8111-111111111111",
                    relativePath: SOURCE_RELATIVE,
                    size: 6_000_000_000,
                    mtimeMs: 1_760_000_000_000,
                    sourceFingerprint: FINGERPRINT,
                    profileVersion: "legacy",
                    lastSeenAt: "2026-10-20T00:00:00.000Z",
                    adaptiveStatus: "ready",
                    adaptiveProfileVersion: ADAPTIVE_PROFILE_VERSION,
                    ...over.entry,
                  },
                ],
        }),
      },
      verifyOnDrive,
      mayDelete: () => over.mayDelete ?? true,
      now: () => 42,
      log,
    });
    return { cleanup, recorded, events, removeSource, verifyOnDrive, log };
  }

  it("removes it once Drive holds the whole package, and says so", async () => {
    const h = await harness();
    await h.cleanup.afterUpload(JOB, uploaded);

    expect(h.removeSource).toHaveBeenCalledWith("item-1", "file-1", {
      expectedFingerprint: FINGERPRINT,
    });
    expect(h.recorded).toEqual([
      [JOB, { state: "deleted", atMs: 42, freedBytes: 6_000_000_000 }],
    ]);
    expect(h.events[0]).toContain("6.0 GB freed");
  });

  it("does nothing for an upload that never asked for it", async () => {
    const h = await harness();
    const { deleteSource: _ask, ...plain } = uploaded;
    await h.cleanup.afterUpload(JOB, plain);
    expect(h.verifyOnDrive).not.toHaveBeenCalled();
    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });

  it("does nothing twice: an outcome already recorded stands", async () => {
    const h = await harness();
    await h.cleanup.afterUpload(JOB, {
      ...uploaded,
      source: { state: "kept", atMs: 1, reason: "earlier" },
    });
    expect(h.removeSource).not.toHaveBeenCalled();
  });

  it("keeps it, and says what is missing, when Drive is short of a file", async () => {
    const h = await harness({ gaps: ["video/1080p.mp4 is not on Drive"] });
    await h.cleanup.afterUpload(JOB, uploaded);

    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([
      [
        JOB,
        {
          state: "kept",
          atMs: 42,
          reason:
            "Drive does not hold the whole package: video/1080p.mp4 is not on Drive.",
        },
      ],
    ]);
    expect(h.events[0]).toMatch(/^Source kept: Drive does not hold/);
  });

  it("decides nothing when Drive cannot be asked, so a later start asks again", async () => {
    const h = await harness({ gaps: new Error("connect ECONNREFUSED") });
    await h.cleanup.afterUpload(JOB, uploaded);

    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("decides nothing while the media volume is gone or guarded", async () => {
    const h = await harness({ mayDelete: false });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.verifyOnDrive).not.toHaveBeenCalled();
    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });

  it("keeps it when the folder's package is not the one this job built", async () => {
    const h = await harness({
      job: { sourceFingerprint: "fingerprint-of-an-older-download" },
    });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.verifyOnDrive).not.toHaveBeenCalled();
    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded[0]?.[1]).toMatchObject({ state: "kept" });
  });

  it("keeps it when the job did not end in a publication", async () => {
    const h = await harness({
      job: { state: "failed", publishedVersion: null },
    });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.removeSource).not.toHaveBeenCalled();
    expect(h.recorded[0]?.[1]).toMatchObject({ state: "kept" });
  });

  it("records the button's own refusal as the reason it was kept", async () => {
    const h = await harness({
      removal: new OwnApiError(
        "PROCESSING_JOB_EXISTS",
        "This file has a processing job that has not finished, and that job is still reading it.",
        409,
      ),
    });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.recorded[0]?.[1]).toEqual({
      state: "kept",
      atMs: 42,
      reason:
        "This file has a processing job that has not finished, and that job is still reading it.",
    });
  });

  it("leaves an unexpected failure undecided rather than calling it a refusal", async () => {
    const h = await harness({ removal: new Error("EIO: i/o error, unlink") });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.recorded).toEqual([]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("EIO"));
  });

  /*
   * Lilyhammer S01E01, 2026-10-20: the package reached Drive, the registry
   * save did not, and the source was removed. Playback then had nothing.
   */
  it.each([
    ["has no registry entry", null, "has no entry"],
    ["has an entry at another size", { size: 1 }, "has no entry"],
    [
      "has an entry that is not ready",
      { adaptiveStatus: "pending" as const },
      "is pending",
    ],
    [
      "has an entry at an older profile",
      { adaptiveProfileVersion: "cmaf-hls-aligned-v1" },
      "at cmaf-hls-aligned-v1",
    ],
    [
      "has an entry for other source bytes",
      { sourceFingerprint: "fingerprint-2" },
      "describes other source bytes",
    ],
  ])(
    "keeps it, undecided, while playback %s",
    async (_label, entry, reason) => {
      const h = await harness({ entry });
      await h.cleanup.afterUpload(JOB, uploaded);
      expect(h.removeSource).not.toHaveBeenCalled();
      expect(h.recorded).toEqual([]);
      expect(h.log).toHaveBeenCalledWith(
        expect.stringContaining("Playback cannot find this package yet"),
      );
      expect(h.log).toHaveBeenCalledWith(expect.stringContaining(reason));
    },
  );

  it("records an already-absent source as such", async () => {
    const h = await harness({ removal: "absent" });
    await h.cleanup.afterUpload(JOB, uploaded);
    expect(h.recorded[0]?.[1]).toEqual({ state: "absent", atMs: 42 });
  });

  it("picks up, on start, uploads a stopped worker left undecided", async () => {
    const h = await harness();
    await h.cleanup.resume();
    expect(h.removeSource).toHaveBeenCalledTimes(1);
    expect(h.recorded[0]?.[0]).toBe(JOB);
  });
});
