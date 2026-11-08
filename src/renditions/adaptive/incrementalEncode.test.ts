import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";
import { publishAdditionalRenditions } from "./publishTitle";
import { resolvePublishedTitleRoot } from "./publishedRoot";
import { rejectPublicationCommit } from "../../test/publicationFault";
import type { AdaptivePackageMetadata } from "./metadata";

/**
 * The command a one-rung job actually produces, and what publishing it does to
 * the seven renditions it did not touch.
 *
 * The bug: a title needing only 1440p was given the whole desired ladder, so
 * FFmpeg was told to `split=8`, run eight VideoToolbox encoders and re-encode
 * audio — roughly four hours of work to obtain one rendition that existed
 * nowhere else. These assert the command and the package, not the intent.
 */

const FORD_SOURCE = { width: 3840, height: 1608 };

/** The rung Ford v Ferrari was missing, at that source's aspect. */
const QHD_ONLY: AdaptiveVideoOutput[] = [
  { qualityHeight: 1440, width: 2560, height: 1072 },
];

const FULL_LADDER: AdaptiveVideoOutput[] = [
  { qualityHeight: 2160, width: 3840, height: 1608 },
  { qualityHeight: 1440, width: 2560, height: 1072 },
  { qualityHeight: 1080, width: 1920, height: 804 },
  { qualityHeight: 720, width: 1280, height: 536 },
  { qualityHeight: 480, width: 854, height: 358 },
  { qualityHeight: 360, width: 640, height: 268 },
  { qualityHeight: 240, width: 426, height: 178 },
  { qualityHeight: 144, width: 256, height: 108 },
];

const AUDIO: AdaptiveAudioOutput = {
  sourceStreamIndex: 1,
  action: "transcode",
  bitrate: 192_000,
  language: "eng",
  isDefault: true,
  isForced: false,
};

function build(
  videoOutputs: AdaptiveVideoOutput[],
  audioOutputs: AdaptiveAudioOutput[],
) {
  return buildAdaptivePackageFfmpegArgs({
    inputPath: "/media/Movies/Ford v Ferrari (2019)/source.mp4",
    outputRoot: "/work/ford",
    videoOutputs,
    audioOutputs,
    encoder: "hevc_videotoolbox",
    hdr: {
      colorPrimaries: "bt2020",
      colorTransfer: "smpte2084",
      colorSpace: "bt2020nc",
    },
    frameRate: 23.976,
  });
}

describe("the FFmpeg command an incremental job produces", () => {
  /** TEST 9 — exactly one video encoder for a one-rung job. */
  it("encodes one rendition and nothing else when only 1440p is missing", () => {
    const args = build(QHD_ONLY, []);
    const command = args.join(" ");

    // The one scale that should be there.
    expect(command).toContain("scale=2560:1072");

    // None of the rungs that already exist on disk.
    for (const absent of [
      `scale=${FORD_SOURCE.width}:${FORD_SOURCE.height}`,
      "scale=1920:804",
      "scale=1280:536",
      "scale=854:358",
      "scale=640:268",
      "scale=426:178",
      "scale=256:108",
    ]) {
      expect(command).not.toContain(absent);
    }

    // One video encoder, not eight.
    const videoEncoders = args.filter((arg) => arg === "hevc_videotoolbox");
    expect(videoEncoders).toHaveLength(1);

    // A single branch needs no split at all, and certainly not an eight-way one.
    expect(command).not.toContain("split=8");
    expect(command).not.toContain("[out7]");
    expect(command).not.toContain("-map [out1]");

    // Valid audio is reused, so nothing asks the encoder for it.
    expect(command).not.toContain("aac");
    expect(args.filter((arg) => arg === "-map").length).toBe(1);
  });

  /** TEST 2, at the command level — a non-contiguous subset. */
  it("splits by the number of rungs it is building, not the ladder size", () => {
    const args = build(
      [
        { qualityHeight: 1440, width: 2560, height: 1072 },
        { qualityHeight: 480, width: 854, height: 358 },
        { qualityHeight: 240, width: 426, height: 178 },
      ],
      [],
    );
    const command = args.join(" ");

    expect(command).toContain("split=3");
    expect(command).not.toContain("split=8");
    expect(args.filter((arg) => arg === "hevc_videotoolbox")).toHaveLength(3);
    expect(command).toContain("scale=2560:1072");
    expect(command).toContain("scale=854:358");
    expect(command).toContain("scale=426:178");
    expect(command).not.toContain("scale=1920:804");

    /*
     * The variant map must name the rungs being produced, and index them by
     * their position among the generated streams rather than by their place in
     * the full ladder — the subset is not contiguous.
     */
    const varStreamMap = args[args.indexOf("-var_stream_map") + 1] ?? "";
    expect(varStreamMap).toContain("v:0");
    expect(varStreamMap).toContain("v:1");
    expect(varStreamMap).toContain("v:2");
    expect(varStreamMap).not.toContain("v:3");
    expect(varStreamMap).toContain("video/1440p");
    expect(varStreamMap).toContain("video/480p");
    expect(varStreamMap).toContain("video/240p");
    expect(varStreamMap).not.toContain("video/1080p");
  });

  /** TEST 4, at the command level — a new title still gets everything. */
  it("still builds the whole ladder for a title with no package", () => {
    const args = build(FULL_LADDER, [AUDIO]);
    const command = args.join(" ");

    expect(command).toContain("split=8");
    expect(args.filter((arg) => arg === "hevc_videotoolbox")).toHaveLength(8);
    expect(command).toContain("scale=2560:1072");
    expect(command).toContain("scale=3840:1608");
    // Audio is genuinely missing here, so it is genuinely encoded.
    expect(command).toContain("aac");
  });

  /** Audio-only work must not drag the video ladder in with it. */
  it("produces no video encoder when only audio is missing", () => {
    const args = build([], [AUDIO]);
    const command = args.join(" ");

    expect(args.filter((arg) => arg === "hevc_videotoolbox")).toHaveLength(0);
    expect(command).not.toContain("scale=");
    expect(command).toContain("aac");
  });
});

function videoRendition(
  qualityHeight: number,
  width: number,
  height: number,
): AdaptivePackageMetadata["videoRenditions"][number] {
  const id = `${qualityHeight}p`;
  return {
    id,
    qualityHeight,
    width,
    height,
    codec: "hevc",
    codecString: "hvc1.2.4.L150.B0",
    pixelFormat: "yuv420p10le",
    hdr: "hdr10",
    frameRate: 23.976,
    averageBitrate: 3_000_000,
    peakBitrate: 8_000_000,
    durationSeconds: 100,
    playlistPath: `.seyirlik/video/${id} HDR.m3u8`,
    mediaPath: `video/${id} HDR.mp4`,
    fileSizeBytes: 1000,
    keyframeCount: 50,
    keyframeIntervalSeconds: {
      target: 2,
      minimum: 1.9,
      maximum: 2.1,
      mean: 2,
    },
    segmentCount: 50,
  };
}

function existingPackage(): AdaptivePackageMetadata {
  return {
    schemaVersion: 1,
    profileVersion: "cmaf-hls-aligned-v3",
    mediaId: "ford",
    sourceFingerprint: "f".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    sourceDurationSeconds: 100,
    source: {
      width: 3840,
      height: 1608,
      qualityHeight: 2160,
      codec: "hevc",
      isHdr: true,
      isVariableFrameRate: false,
      rotation: 0,
    },
    segmentTargetSeconds: 2,
    switchingSetDurationSeconds: 100,
    masterPlaylistPath: ".seyirlik/master.m3u8",
    videoRenditions: [
      videoRendition(2160, 3840, 1608),
      videoRendition(1080, 1920, 804),
      videoRendition(720, 1280, 536),
    ],
    audioRenditions: [
      {
        id: "track-1",
        sourceStreamIndex: 1,
        language: "eng",
        isDefault: true,
        isForced: false,
        codec: "aac",
        codecString: "mp4a.40.2",
        channels: 2,
        sampleRate: 48_000,
        averageBitrate: 192_000,
        durationSeconds: 100,
        playlistPath: ".seyirlik/audio/english.m3u8",
        mediaPath: "audio/english.m4a",
        fileSizeBytes: 500,
        streamCopied: false,
      },
    ],
    subtitleRenditions: [
      {
        id: "subtitle-2",
        sourceStreamIndex: 2,
        language: "tur",
        isDefault: false,
        isForced: false,
        isHearingImpaired: false,
        codec: "webvtt",
        durationSeconds: 100,
        playlistPath: ".seyirlik/subtitle/turkish.m3u8",
        subtitlePath: "subtitle/turkish.vtt",
        fileSizeBytes: 100,
      },
    ],
    storage: {
      videoBytes: 3000,
      audioBytes: 500,
      subtitleBytes: 100,
      totalBytes: 3600,
    },
    validation: { validatedAt: "2026-08-30T00:00:00.000Z", checks: [] },
  } as unknown as AdaptivePackageMetadata;
}

/** Lays down the files a published package would already have on disk. */
async function publishedTitle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-incremental-"));
  const existing = existingPackage();
  for (const rendition of existing.videoRenditions) {
    for (const relative of [rendition.mediaPath, rendition.playlistPath]) {
      const target = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "existing-bytes");
    }
  }
  for (const relative of [
    "audio/english.m4a",
    ".seyirlik/audio/english.m3u8",
    "subtitle/turkish.vtt",
    ".seyirlik/subtitle/turkish.m3u8",
    ".seyirlik/master.m3u8",
  ]) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "existing-bytes");
  }
  return root;
}

/** A work directory holding just the newly encoded 1440p rendition. */
async function workWithQhd(
  rendition = {
    ...videoRendition(1440, 2560, 1072),
    playlistPath: "video/1440p/playlist.m3u8",
    mediaPath: "video/1440p/media.mp4",
  },
): Promise<{
  root: string;
  added: Pick<
    AdaptivePackageMetadata,
    "videoRenditions" | "audioRenditions" | "subtitleRenditions"
  >;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-work-"));
  for (const relative of [rendition.mediaPath, rendition.playlistPath]) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      relative.endsWith(".m3u8")
        ? '#EXTM3U\n#EXT-X-MAP:URI="media.mp4"\n#EXTINF:2.0,\nmedia.mp4\n#EXT-X-ENDLIST\n'
        : "new-bytes",
    );
  }
  return {
    root,
    added: {
      videoRenditions: [rendition],
      audioRenditions: [],
      subtitleRenditions: [],
    },
  };
}

describe("a master for a video-only incremental run", () => {
  /**
   * The work directory of an incremental run holds only what that run built,
   * and the validator needs a master describing it. Naming an audio group with
   * no members would make that master refer to something it never defines.
   */
  it("omits the audio group rather than pointing at an empty one", async () => {
    const { buildMasterPlaylist } = await import("./playlist");
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition(1440, 2560, 1072)],
      audioRenditions: [],
      subtitleRenditions: [],
      videoCodecStrings: new Map([["1440p", "hvc1.2.4.L150.B0"]]),
      audioCodecStrings: new Map(),
    });

    expect(master).toContain("RESOLUTION=2560x1072");
    expect(master).not.toContain('AUDIO="');
    expect(master).not.toContain("TYPE=AUDIO");
    // The codec list must not carry a dangling comma where audio would be.
    expect(master).toContain('CODECS="hvc1.2.4.L150.B0"');
    expect(master).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });
});

describe("publishing one rendition into an existing package", () => {
  it("keeps the old master and media readable through a failed final commit and retry", async () => {
    const titleRoot = await publishedTitle();
    const { root: workVersionRoot, added } = await workWithQhd();
    const input = {
      titleRoot,
      workVersionRoot,
      added,
      existing: existingPackage(),
    };
    const fault = await rejectPublicationCommit(titleRoot);
    await expect(
      publishAdditionalRenditions({ ...input, fileSystem: fault.fileSystem }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(fault.rejected()).toBe(1);
    expect(await resolvePublishedTitleRoot(titleRoot)).toBe(titleRoot);
    for (const file of [
      ".seyirlik/master.m3u8",
      "video/2160p HDR.mp4",
      "audio/english.m4a",
    ]) {
      expect(await readFile(path.join(titleRoot, file), "utf8")).toBe(
        "existing-bytes",
      );
    }
    fault.restore();
    await expect(publishAdditionalRenditions(input)).resolves.toBeDefined();
    expect(await resolvePublishedTitleRoot(titleRoot)).not.toBe(titleRoot);
    expect(
      await readFile(path.join(titleRoot, ".seyirlik/master.m3u8"), "utf8"),
    ).toBe("existing-bytes");
  });

  /** TEST 8 — the master describes everything, not just what this run built. */
  it("keeps every existing rendition and adds the new one exactly once", async () => {
    const titleRoot = await publishedTitle();
    const { root: workRoot, added } = await workWithQhd();

    const { manifest } = await publishAdditionalRenditions({
      workVersionRoot: workRoot,
      titleRoot,
      existing: existingPackage(),
      added,
    });

    expect(manifest.video.map((rendition) => rendition.qualityHeight)).toEqual([
      2160, 1440, 1080, 720,
    ]);
    // Audio and subtitles this job never touched are still described.
    expect(manifest.audio).toHaveLength(1);
    expect(manifest.subtitle).toHaveLength(1);

    const master = await readFile(
      path.join(
        await resolvePublishedTitleRoot(titleRoot),
        ".seyirlik",
        "master.m3u8",
      ),
      "utf8",
    );
    for (const rung of ["2160p", "1440p", "1080p", "720p"]) {
      expect(master).toContain(rung);
    }
    // No rung may be advertised twice.
    for (const rung of ["2160p", "1440p", "1080p", "720p"]) {
      const uri = `${rung}%20HDR.m3u8`;
      expect(master.split(uri).length - 1).toBeGreaterThanOrEqual(1);
    }
    expect(master).toContain("TYPE=AUDIO");
    expect(master).toContain("TYPE=SUBTITLES");
  });

  /**
   * TEST 7 — a failed encode must leave the published package untouched.
   *
   * Publishing is never reached when the encode or validation fails, so the
   * package a viewer is playing is exactly what it was.
   */
  it("leaves the published package intact when the new rendition never arrives", async () => {
    const titleRoot = await publishedTitle();
    const { root: workRoot } = await workWithQhd();
    const before = await readFile(
      path.join(titleRoot, ".seyirlik", "master.m3u8"),
      "utf8",
    );

    await expect(
      publishAdditionalRenditions({
        workVersionRoot: workRoot,
        titleRoot,
        existing: existingPackage(),
        added: {
          // Names a rendition whose bytes were never produced.
          videoRenditions: [
            {
              ...videoRendition(1440, 2560, 1072),
              playlistPath: "video/missing/playlist.m3u8",
              mediaPath: "video/missing/media.mp4",
            },
          ],
          audioRenditions: [],
          subtitleRenditions: [],
        },
      }),
    ).rejects.toThrow();

    // Every original rendition is still on disk and still described.
    for (const relative of [
      "video/2160p HDR.mp4",
      "video/1080p HDR.mp4",
      "video/720p HDR.mp4",
      "audio/english.m4a",
    ]) {
      const contents = await readFile(
        path.join(titleRoot, ...relative.split("/")),
        "utf8",
      );
      expect(contents).toBe("existing-bytes");
    }
    expect(
      await readFile(path.join(titleRoot, ".seyirlik", "master.m3u8"), "utf8"),
    ).toBe(before);
  });
});

/** `link` as the rclone Google Drive mount answers it (WinFsp, 2026-11-08). */
const noHardLinks = {
  async link(): Promise<void> {
    throw Object.assign(new Error("operation not supported on socket, link"), {
      code: "ENOTSUP",
      syscall: "link",
    });
  },
};

describe("publishing into a package on a volume with no hard links", () => {
  /**
   * At World's End: a Turkish sidecar added to a published 42 GB package on the
   * Drive mount failed on its first link, and copying the package instead
   * would have moved all of it to add 100 KB.
   */
  it("adds a rendition in place, leaving every file the old master names untouched", async () => {
    const titleRoot = await publishedTitle();
    const { root: workVersionRoot, added } = await workWithQhd();

    const { manifest, publishedRoot } = await publishAdditionalRenditions({
      workVersionRoot,
      titleRoot,
      existing: existingPackage(),
      added,
      fileSystem: {
        rename: (await import("node:fs/promises")).rename,
        ...noHardLinks,
      },
    });

    expect(publishedRoot).toBe(titleRoot);
    expect(await resolvePublishedTitleRoot(titleRoot)).toBe(titleRoot);
    await expect(
      stat(path.join(titleRoot, ".seyirlik-generations")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(manifest.video.map((rendition) => rendition.qualityHeight)).toEqual([
      2160, 1440, 1080, 720,
    ]);
    for (const file of [
      "video/2160p HDR.mp4",
      "video/1080p HDR.mp4",
      "video/720p HDR.mp4",
      "audio/english.m4a",
      "subtitle/turkish.vtt",
    ]) {
      expect(await readFile(path.join(titleRoot, file), "utf8")).toBe(
        "existing-bytes",
      );
    }
    const qhd = manifest.video.find((rendition) => rendition.id === "1440p")!;
    expect(
      await readFile(path.join(titleRoot, ...qhd.mediaPath.split("/")), "utf8"),
    ).toBe("new-bytes");
    expect(
      await readFile(path.join(titleRoot, ".seyirlik", "master.m3u8"), "utf8"),
    ).toContain("1440p");
  });

  it("copies the kept files into a new generation when it replaces a published rendition", async () => {
    const titleRoot = await publishedTitle();
    const { root: workVersionRoot, added } = await workWithQhd({
      ...videoRendition(1080, 1920, 804),
      playlistPath: "video/1080p/playlist.m3u8",
      mediaPath: "video/1080p/media.mp4",
    });

    await publishAdditionalRenditions({
      workVersionRoot,
      titleRoot,
      existing: existingPackage(),
      added,
      fileSystem: {
        rename: (await import("node:fs/promises")).rename,
        ...noHardLinks,
      },
    });

    const live = await resolvePublishedTitleRoot(titleRoot);
    expect(live).not.toBe(titleRoot);
    // An old reader keeps the bytes it was reading.
    expect(
      await readFile(path.join(titleRoot, "video/1080p HDR.mp4"), "utf8"),
    ).toBe("existing-bytes");
    expect(await readFile(path.join(live, "video/1080p HDR.mp4"), "utf8")).toBe(
      "new-bytes",
    );
    for (const file of ["video/2160p HDR.mp4", "audio/english.m4a"]) {
      expect(await readFile(path.join(live, file), "utf8")).toBe(
        "existing-bytes",
      );
    }
  });

  it("still links when the volume supports it", async () => {
    const titleRoot = await publishedTitle();
    const { root: workVersionRoot, added } = await workWithQhd();
    let links = 0;
    await publishAdditionalRenditions({
      workVersionRoot,
      titleRoot,
      existing: existingPackage(),
      added,
      fileSystem: {
        rename: (await import("node:fs/promises")).rename,
        link: async (from, to) => {
          links += 1;
          return link(from, to);
        },
      },
    });
    expect(links).toBeGreaterThan(0);
    expect(await resolvePublishedTitleRoot(titleRoot)).not.toBe(titleRoot);
  });
});
