import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { HardwareReport } from "../../../renditions/hardware/detect";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import { readTitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import { createProcessingEnqueuer } from "./processingEnqueue";
import { planRetainedSidecarSubtitles } from "../../../renditions/adaptive/processor";

vi.mock("../../../renditions/probe", () => ({
  probeMediaFile: vi.fn(async () => ({
    durationSeconds: 12,
    video: {
      width: 640,
      height: 360,
      rotation: 0,
      codec: "h264",
      isHdr: false,
    },
    audioTracks: [
      { streamIndex: 1, codec: "aac", language: "eng", isDefault: true },
    ],
    subtitleTracks: [],
    chapters: [],
  })),
}));
vi.mock("../../../renditions/registry", () => ({
  computeSourceFingerprint: vi.fn(async () => "source-fingerprint"),
}));
vi.mock("../../../renditions/adaptive/publishTitle", async (original) => ({
  ...(await original<
    typeof import("../../../renditions/adaptive/publishTitle")
  >()),
  readTitlePackageManifest: vi.fn(),
}));
vi.mock("./packageAssets", () => ({
  missingPackageAssets: vi.fn(async () => []),
}));

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("processing subtitles added after publication", () => {
  it("allows subtitle-only work for an otherwise complete package", async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-subtitle-enqueue-"));
    const source = path.join(root, "Film.mkv");
    await writeFile(source, "source");
    await writeFile(
      path.join(root, "Film.tur.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nMerhaba\n",
    );
    vi.mocked(readTitlePackageManifest).mockResolvedValue({
      schemaVersion: 1,
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      sourceFingerprint: "source-fingerprint",
      masterPlaylistPath: ".seyirlik/master.m3u8",
      video: [360, 240, 144].map((qualityHeight) => ({
        id: `${qualityHeight}p`,
        qualityHeight,
        hdr: "sdr",
      })),
      audio: [{ id: "track-1" }],
      subtitle: [],
      storage: { totalBytes: 100 },
    } as never);
    const enqueuer = createProcessingEnqueuer({
      catalogue: {
        listFilesForItem: async () => [
          { id: "file", relativePath: "Film.mkv", missingSince: null },
        ],
        getItemKind: async () => "movie",
      } as unknown as CatalogueRepository,
      store: {} as never,
      queue: {} as never,
      mediaRoot: root,
      workRoot: root,
      ffprobePath: "ffprobe",
      hardware: async () =>
        ({
          selected: { h264: "libx264" },
          selectedAdapter: { h264: "software" },
        }) as HardwareReport,
      storageGuard: {} as never,
    });
    const result = await enqueuer.analyse("item");
    expect(result.decision.action).toBe("package-adaptive");
    expect(result.decision.renditionsToEncode).toEqual([]);
    expect(result.decision.summary).toMatch(/subtitle/i);
    const manifest = (await readTitlePackageManifest(root))!;
    const [sidecar] = await planRetainedSidecarSubtitles(source);
    vi.mocked(readTitlePackageManifest).mockResolvedValue({
      ...manifest,
      subtitle: [
        {
          id: "subtitle-1000",
          sidecarFingerprint: sidecar!.sidecarFingerprint,
        },
      ] as never,
    });
    expect((await enqueuer.analyse("item")).decision.action).toBe(
      "skip-already-current",
    );

    await writeFile(
      path.join(root, "Film.tur.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nDüzeltilmiş\n",
    );
    expect((await enqueuer.analyse("item")).decision.action).toBe(
      "package-adaptive",
    );

    // Old manifests stay readable, but refresh sidecars whose identity was never recorded.
    vi.mocked(readTitlePackageManifest).mockResolvedValue({
      ...manifest,
      subtitle: [{ id: "subtitle-1000" }] as never,
    });
    expect((await enqueuer.analyse("item")).decision.action).toBe(
      "package-adaptive",
    );
  });
});
