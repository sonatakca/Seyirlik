import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdaptivePackageMetadata } from "./metadata";
import {
  TitleRootConflictError,
  copyFileResumable,
  publishTitlePackage,
  readTitlePackageManifest,
} from "./publishTitle";
import { rejectPublicationCommit } from "../../test/publicationFault";
import { resolvePublishedTitleRoot } from "./publishedRoot";

/**
 * Publishing a built package into the folder a person browses.
 *
 * What matters here is what the folder looks like afterwards and whether the
 * playlists still resolve to the files they name — a package whose media moved
 * but whose playlists did not is indistinguishable from a corrupt one.
 */

function metadata(): AdaptivePackageMetadata {
  return {
    schemaVersion: 1,
    profileVersion: "cmaf-hls-aligned-v3",
    mediaId: "media-1",
    sourceFingerprint: "f".repeat(64),
    createdAt: "2026-08-29T10:00:00.000Z",
    sourceDurationSeconds: 300,
    masterPlaylistPath: "master.m3u8",
    videoRenditions: [
      {
        id: "2160p",
        qualityHeight: 2160,
        width: 3840,
        height: 1604,
        codec: "hevc",
        codecString: "hvc1.2.4.L150.b0",
        pixelFormat: "yuv420p10le",
        hdr: "hdr10",
        frameRate: 23.976,
        averageBitrate: 12_000_000,
        peakBitrate: 20_000_000,
        durationSeconds: 300,
        playlistPath: "video/2160p/playlist.m3u8",
        mediaPath: "video/2160p/media.m4s",
        fileSizeBytes: 400,
        keyframeCount: 150,
        keyframeIntervalSeconds: { target: 2, minimum: 2, maximum: 2, mean: 2 },
        segmentCount: 150,
      },
      {
        id: "480p",
        qualityHeight: 480,
        width: 854,
        height: 356,
        codec: "hevc",
        codecString: "hvc1.2.4.L90.b0",
        pixelFormat: "yuv420p10le",
        hdr: "hdr10",
        frameRate: 23.976,
        averageBitrate: 1_400_000,
        peakBitrate: 2_500_000,
        durationSeconds: 300,
        playlistPath: "video/480p/playlist.m3u8",
        mediaPath: "video/480p/media.m4s",
        fileSizeBytes: 200,
        keyframeCount: 150,
        keyframeIntervalSeconds: { target: 2, minimum: 2, maximum: 2, mean: 2 },
        segmentCount: 150,
      },
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
        durationSeconds: 300,
        playlistPath: "audio/track-1/playlist.m3u8",
        mediaPath: "audio/track-1/media.m4s",
        fileSizeBytes: 100,
        streamCopied: false,
      },
    ],
    subtitleRenditions: [
      {
        id: "subtitle-4",
        sourceStreamIndex: 4,
        language: "tur",
        isDefault: false,
        isForced: false,
        isHearingImpaired: true,
        codec: "webvtt",
        durationSeconds: 300,
        playlistPath: "subtitles/subtitle-4/playlist.m3u8",
        subtitlePath: "subtitles/subtitle-4/subtitles.vtt",
        fileSizeBytes: 50,
      },
    ],
    validation: {
      validatedAt: "2026-08-29T10:00:00.000Z",
      alignmentToleranceSeconds: 0.05,
      audioDurationToleranceSeconds: 0.5,
      checks: ["segment-alignment"],
    },
    storage: { videoBytes: 600, audioBytes: 100, totalBytes: 700 },
    segmentTargetSeconds: 2,
    switchingSetDurationSeconds: 300,
    source: {
      width: 3840,
      height: 1604,
      qualityHeight: 2160,
      codec: "hevc",
      frameRate: 23.976,
      isHdr: true,
      isVariableFrameRate: false,
      rotation: 0,
    },
  } as unknown as AdaptivePackageMetadata;
}

/*
 * The byte ranges have to fit inside the placeholder media files below, not
 * just look plausible. Publication verifies the destination playlist against
 * the size of the file it just copied, so a fixture whose ranges ran past its
 * own media would be rejected for exactly the reason a truncated copy is.
 */
function renditionPlaylist(mediaFileName: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-MAP:URI="${mediaFileName}",BYTERANGE="4@0"`,
    "#EXTINF:2.002000,",
    "#EXT-X-BYTERANGE:5@4",
    mediaFileName,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

/** A WebVTT rendition carries no initialisation segment and never has one. */
function subtitlePlaylist(fileName: string): string {
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:3",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXTINF:2.002000,",
    fileName,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

async function buildWorkPackage(): Promise<{
  workVersionRoot: string;
  titleRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-publish-"));
  const workVersionRoot = path.join(root, "work");
  const titleRoot = path.join(root, "Movies", "Dune (2021)");
  await mkdir(titleRoot, { recursive: true });
  await writeFile(path.join(titleRoot, "Dune (2021).mp4"), "the source");

  const files: Array<[string, string]> = [
    ["video/2160p/media.m4s", "2160-bytes"],
    ["video/2160p/playlist.m3u8", renditionPlaylist("media.m4s")],
    ["video/480p/media.m4s", "480-bytes"],
    ["video/480p/playlist.m3u8", renditionPlaylist("media.m4s")],
    ["audio/track-1/media.m4s", "audio-bytes"],
    ["audio/track-1/playlist.m3u8", renditionPlaylist("media.m4s")],
    ["subtitles/subtitle-4/subtitles.vtt", "WEBVTT\n"],
    ["subtitles/subtitle-4/playlist.m3u8", subtitlePlaylist("subtitles.vtt")],
    [
      "master.m3u8",
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",URI="audio/track-1/playlist.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="tur",URI="subtitles/subtitle-4/playlist.m3u8"',
        "#EXT-X-STREAM-INF:BANDWIDTH=12000000",
        "video/2160p/playlist.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=1400000",
        "video/480p/playlist.m3u8",
        "",
      ].join("\n"),
    ],
  ];
  for (const [relative, contents] of files) {
    const target = path.join(workVersionRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return { workVersionRoot, titleRoot };
}

describe("publishing a package into its title folder", () => {
  it("lays the media out under names a person would choose", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    expect((await readdir(path.join(titleRoot, "video"))).sort()).toEqual([
      "2160p HDR.mp4",
      "480p HDR.mp4",
    ]);
    expect(await readdir(path.join(titleRoot, "audio"))).toEqual([
      "english.m4a",
    ]);
    expect(await readdir(path.join(titleRoot, "subtitle"))).toEqual([
      "turkish (sdh).vtt",
    ]);
  });

  /** The folders the user opens hold media; the machinery stays out of sight. */
  it("keeps playlists and the manifest out of the media folders", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    for (const directory of ["video", "audio", "subtitle"]) {
      const entries = await readdir(path.join(titleRoot, directory));
      expect(entries.some((entry) => entry.endsWith(".m3u8"))).toBe(false);
      expect(entries.some((entry) => entry.endsWith(".json"))).toBe(false);
    }
    expect((await readdir(path.join(titleRoot, ".seyirlik"))).sort()).toEqual([
      "audio",
      "build.json",
      "master.m3u8",
      "package.json",
      "subtitle",
      "video",
    ]);
  });

  it("leaves the source file exactly where it was", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    expect(
      await readFile(path.join(titleRoot, "Dune (2021).mp4"), "utf8"),
    ).toBe("the source");
  });

  it("keeps the verified scratch package until its caller commits success", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });
    await expect(
      readFile(path.join(workVersionRoot, "video/2160p/media.m4s"), "utf8"),
    ).resolves.toBe("2160-bytes");
  });

  /**
   * A package whose media moved but whose playlists did not is indistinguishable
   * from a corrupt one, so every URI has to arrive at a file that exists.
   */
  it("leaves every playlist pointing at a file that is really there", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    const { manifest } = await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    for (const rendition of [
      ...manifest.video,
      ...manifest.audio,
      ...manifest.subtitle,
    ]) {
      const playlist = await readFile(
        path.join(titleRoot, ...rendition.playlistPath.split("/")),
        "utf8",
      );
      const uris = playlist
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"));
      expect(uris.length).toBeGreaterThan(0);
      for (const uri of uris) {
        const resolved = path.resolve(
          path.dirname(
            path.join(titleRoot, ...rendition.playlistPath.split("/")),
          ),
          decodeURIComponent(uri),
        );
        await expect(readFile(resolved)).resolves.toBeDefined();
      }
    }
  });

  it("points the master at the published playlists", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    const master = await readFile(
      path.join(titleRoot, ".seyirlik", "master.m3u8"),
      "utf8",
    );
    expect(master).toContain("video/2160p%20HDR.m3u8");
    expect(master).toContain('URI="audio/english.m3u8"');
    expect(master).not.toContain("playlist.m3u8");
    for (const line of master
      .split("\n")
      .filter((entry) => entry.trim() && !entry.startsWith("#"))) {
      await expect(
        readFile(path.join(titleRoot, ".seyirlik", decodeURIComponent(line))),
      ).resolves.toBeDefined();
    }
  });

  it("writes a manifest the server can read back", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    const manifest = await readTitlePackageManifest(titleRoot);
    expect(manifest?.profileVersion).toBe("cmaf-hls-aligned-v3");
    expect(manifest?.video.map((rendition) => rendition.mediaPath)).toEqual([
      "video/2160p HDR.mp4",
      "video/480p HDR.mp4",
    ]);
    expect(manifest?.masterPlaylistPath).toBe(".seyirlik/master.m3u8");
  });

  /**
   * A rebuild that drops a track must not leave the old file behind: the folder
   * would then offer a rendition the manifest does not know about.
   */
  it("replaces a previous package rather than merging with it", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();
    await mkdir(path.join(titleRoot, "audio"), { recursive: true });
    await writeFile(
      path.join(titleRoot, "audio", "klingon.m4a"),
      "from an older package",
    );

    await publishTitlePackage({
      workVersionRoot,
      titleRoot,
      metadata: metadata(),
    });

    expect(await readdir(path.join(titleRoot, "audio"))).toEqual([
      "english.m4a",
    ]);
  });

  it("never exposes an HDD package whose incoming playlists fail verification", async () => {
    const { workVersionRoot, titleRoot } = await buildWorkPackage();
    await mkdir(path.join(titleRoot, "video"), { recursive: true });
    await writeFile(path.join(titleRoot, "video", "existing.mp4"), "old-valid");
    await writeFile(
      path.join(workVersionRoot, "video/2160p/playlist.m3u8"),
      "not an hls playlist",
    );

    await expect(
      publishTitlePackage({
        workVersionRoot,
        titleRoot,
        metadata: metadata(),
        publicationId: "verification-failure",
      }),
    ).rejects.toThrow(/invalid playlist/);
    await expect(
      readFile(path.join(titleRoot, "video", "existing.mp4"), "utf8"),
    ).resolves.toBe("old-valid");
    await expect(
      stat(path.join(titleRoot, ".seyirlik-incoming", "verification-failure")),
    ).resolves.toBeDefined();
  });
});

describe("resumable cross-volume copy", () => {
  it("continues a partial destination without recopying its verified prefix", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-copy-resume-"));
    const source = path.join(root, "scratch.bin");
    const destination = path.join(root, "incoming", "media.bin");
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
    await writeFile(source, bytes);

    const controller = new AbortController();
    await expect(
      copyFileResumable(source, destination, {
        signal: controller.signal,
        onProgress: (completed) => {
          if (completed >= 1024 * 1024) controller.abort();
        },
      }),
    ).rejects.toThrow(/interrupted/);
    const partialBytes = (await stat(destination)).size;
    expect(partialBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(partialBytes).toBeLessThan(bytes.length);

    const samples: number[] = [];
    await copyFileResumable(source, destination, {
      onProgress: (completed) => samples.push(completed),
    });
    expect(samples[0]).toBe(partialBytes);
    expect(await readFile(destination)).toEqual(bytes);
  }, 30_000);

  it("discards an untrusted partial suffix before resuming", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-copy-reset-"));
    const source = path.join(root, "scratch.bin");
    const destination = path.join(root, "incoming.bin");
    await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 0x11));
    await writeFile(destination, Buffer.alloc(1024 * 1024, 0x22));
    const samples: number[] = [];
    await copyFileResumable(source, destination, {
      onProgress: (completed) => samples.push(completed),
    });
    expect(samples[0]).toBe(0);
    expect(await readFile(destination)).toEqual(await readFile(source));
    /* Two megabytes really copied, twice; 5 s is a macOS budget. */
  }, 30_000);
});

/**
 * The folder a package publishes into holds exactly one title.
 *
 * This is the assertion that stands between a destination resolved wrongly and
 * a library that quietly loses content. An episode whose destination came out
 * as its season folder published over its neighbours one at a time, and because
 * every individual publish succeeded, the only symptom was that the earlier
 * episodes had stopped existing. Whatever resolved the destination is where such
 * a bug is fixed; this is what makes the next one cost a failed job instead.
 */
describe("publishing into a folder another title already occupies", () => {
  it("retains owned staging when cleanup fails and retries without touching active bytes", async () => {
    const first = await buildWorkPackage();
    await publishTitlePackage({ ...first, metadata: metadata() });
    const next = await buildWorkPackage();
    const input = {
      workVersionRoot: next.workVersionRoot,
      titleRoot: first.titleRoot,
      publicationId: "cleanup-retry",
      metadata: { ...metadata(), sourceFingerprint: "c".repeat(64) },
    };
    await expect(
      publishTitlePackage({
        ...input,
        fileSystem: {
          rename,
          rm: async () => {
            throw Object.assign(new Error("Cleanup refused"), {
              code: "EACCES",
            });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    const active = await resolvePublishedTitleRoot(first.titleRoot);
    expect(
      (await readTitlePackageManifest(first.titleRoot))?.sourceFingerprint,
    ).toBe("c".repeat(64));
    const incoming = path.join(
      first.titleRoot,
      ".seyirlik-incoming",
      input.publicationId,
    );
    expect(
      JSON.parse(
        await readFile(path.join(incoming, ".publication.json"), "utf8"),
      ).publicationId,
    ).toBe(input.publicationId);
    await expect(
      publishTitlePackage({
        ...input,
        fileSystem: {
          rename: async () => {
            throw new Error("Active files must not be renamed on retry");
          },
        },
      }),
    ).resolves.toBeDefined();
    expect(await resolvePublishedTitleRoot(first.titleRoot)).toBe(active);
    await expect(stat(incoming)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a pointer rename that committed before reporting failure", async () => {
    const first = await buildWorkPackage();
    await publishTitlePackage({ ...first, metadata: metadata() });
    const next = await buildWorkPackage();
    const input = {
      workVersionRoot: next.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), sourceFingerprint: "b".repeat(64) },
    };
    let committed = false;
    await expect(
      publishTitlePackage({
        ...input,
        fileSystem: {
          rename: async (from, to) => {
            await rename(from, to);
            if (
              String(to).endsWith(`${path.sep}.seyirlik${path.sep}current.json`)
            ) {
              committed = true;
              throw Object.assign(new Error("Commit outcome unavailable"), {
                code: "EIO",
              });
            }
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(committed).toBe(true);
    const active = await resolvePublishedTitleRoot(first.titleRoot);
    expect(
      (await readTitlePackageManifest(first.titleRoot))?.sourceFingerprint,
    ).toBe("b".repeat(64));
    await expect(
      publishTitlePackage({
        ...input,
        fileSystem: {
          rename: async () => {
            throw new Error("Retry must not swap active files");
          },
        },
      }),
    ).resolves.toMatchObject({ publishedRoot: expect.any(String) });
    expect(await resolvePublishedTitleRoot(first.titleRoot)).toBe(active);
  });

  it("keeps every last-valid artifact readable when a replacement commit fails", async () => {
    const first = await buildWorkPackage();
    const { manifest } = await publishTitlePackage({
      ...first,
      metadata: metadata(),
    });
    const files = [
      manifest.masterPlaylistPath,
      ...[...manifest.video, ...manifest.audio, ...manifest.subtitle].flatMap(
        (r) => [r.mediaPath, r.playlistPath],
      ),
    ];
    const before = await Promise.all(
      files.map((file) => readFile(path.join(first.titleRoot, file))),
    );
    const next = await buildWorkPackage();
    const fault = await rejectPublicationCommit(first.titleRoot);
    try {
      await expect(
        publishTitlePackage({
          workVersionRoot: next.workVersionRoot,
          titleRoot: first.titleRoot,
          metadata: { ...metadata(), sourceFingerprint: "a".repeat(64) },
          fileSystem: fault.fileSystem,
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(fault.rejected()).toBeGreaterThan(0);
      expect(await readTitlePackageManifest(first.titleRoot)).toEqual(manifest);
      for (const [index, file] of files.entries()) {
        expect(await readFile(path.join(first.titleRoot, file))).toEqual(
          before[index],
        );
      }
    } finally {
      fault.restore();
    }
    const recovered = await publishTitlePackage({
      workVersionRoot: next.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), sourceFingerprint: "a".repeat(64) },
    });
    expect(
      (await readTitlePackageManifest(first.titleRoot))?.sourceFingerprint,
    ).toBe("a".repeat(64));
    expect(await resolvePublishedTitleRoot(first.titleRoot)).toBe(
      await realpath(recovered.publishedRoot!),
    );
    // An existing consumer retains readable bytes after the new pointer lands.
    for (const [index, file] of files.entries()) {
      expect(await readFile(path.join(first.titleRoot, file))).toEqual(
        before[index],
      );
      expect(await readFile(path.join(recovered.publishedRoot!, file))).toEqual(
        before[index],
      );
    }
  });

  it("refuses, and leaves the package that was there untouched", async () => {
    const first = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot: first.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), mediaId: "media-1" },
    });
    const published = await readTitlePackageManifest(first.titleRoot);
    const videoBefore = await readdir(path.join(first.titleRoot, "video"));

    const second = await buildWorkPackage();
    await expect(
      publishTitlePackage({
        workVersionRoot: second.workVersionRoot,
        // The season-folder mistake, in miniature: a different source, told to
        // publish where the first one already lives.
        titleRoot: first.titleRoot,
        metadata: { ...metadata(), mediaId: "media-2" },
      }),
    ).rejects.toBeInstanceOf(TitleRootConflictError);

    // Not merely "an error was thrown": the occupant is still whole.
    expect(await readTitlePackageManifest(first.titleRoot)).toEqual(published);
    expect(await readdir(path.join(first.titleRoot, "video"))).toEqual(
      videoBefore,
    );
  });

  it("replaces a package whose media the registry no longer knows", async () => {
    // A film lost with its drive and downloaded again: the new source is a
    // new media id, and the old package's id is in no registry any more.
    const first = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot: first.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), mediaId: "lost-source" },
    });
    const asked: string[] = [];
    const second = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot: second.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: {
        ...metadata(),
        mediaId: "new-source",
        sourceFingerprint: "d".repeat(64),
      },
      occupantIsLive: async (occupant) => {
        asked.push(occupant);
        return false;
      },
    });
    expect(asked).toEqual(["lost-source"]);
    expect(
      (await readTitlePackageManifest(first.titleRoot))?.sourceFingerprint,
    ).toBe("d".repeat(64));
  });

  it.each([
    ["the registry still lists the occupant", async () => true],
    [
      "the registry cannot be read",
      async (): Promise<boolean> => {
        throw new Error("database unavailable");
      },
    ],
  ])("still refuses when %s", async (_case, occupantIsLive) => {
    const first = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot: first.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), mediaId: "media-1" },
    });
    const published = await readTitlePackageManifest(first.titleRoot);
    const second = await buildWorkPackage();
    await expect(
      publishTitlePackage({
        workVersionRoot: second.workVersionRoot,
        titleRoot: first.titleRoot,
        metadata: { ...metadata(), mediaId: "media-2" },
        occupantIsLive,
      }),
    ).rejects.toBeInstanceOf(TitleRootConflictError);
    expect(await readTitlePackageManifest(first.titleRoot)).toEqual(published);
  });

  it("still lets a title publish over its own package", async () => {
    const first = await buildWorkPackage();
    await publishTitlePackage({
      workVersionRoot: first.workVersionRoot,
      titleRoot: first.titleRoot,
      metadata: { ...metadata(), mediaId: "media-1" },
    });

    /*
     * Re-encoding a source replaces its own renditions, and must keep doing so:
     * a guard that blocked this would make every re-process a manual deletion.
     */
    const again = await buildWorkPackage();
    await expect(
      publishTitlePackage({
        workVersionRoot: again.workVersionRoot,
        titleRoot: first.titleRoot,
        metadata: {
          ...metadata(),
          mediaId: "media-1",
          sourceFingerprint: "a".repeat(64),
        },
      }),
    ).resolves.toBeDefined();
  });
});
