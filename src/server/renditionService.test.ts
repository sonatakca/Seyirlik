// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adaptiveVersionIdFor,
  createRenditionService,
} from "./renditionService";
import { RENDITION_PROFILE_VERSION } from "../renditions/policy";
import type { PlaybackMediaResolver } from "../lib/playback-planner/playbackRoutes";
import { ADAPTIVE_PROFILE_VERSION } from "../renditions/adaptive/profile";

const mediaId = "jellyfin-item";
const renditionId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);
const renditionBytes = Buffer.from("complete-mp4-file-data");

async function fixture({
  includeGenerated = true,
  registryStatus = "ready",
  hdr = false,
  includeAdaptive = false,
  adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "seyirlik-routes-"));
  const mediaRoot = path.join(root, "media");
  const renditionRoot = path.join(mediaRoot, ".seyirlik", "renditions");
  const stateRoot = path.join(mediaRoot, ".seyirlik", "state");
  const sourcePath = path.join(mediaRoot, "Movies", "Film.mkv");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "source");
  const sourceStats = await stat(sourcePath);
  const versionDirectory = `${RENDITION_PROFILE_VERSION}-${fingerprint.slice(0, 16)}`;
  const versionRoot = path.join(renditionRoot, renditionId, versionDirectory);
  await mkdir(versionRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    path.join(stateRoot, "registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      profileVersion: RENDITION_PROFILE_VERSION,
      updatedAt: new Date().toISOString(),
      items: [
        {
          id: renditionId,
          relativePath: "Movies/Film.mkv",
          size: sourceStats.size,
          mtimeMs: sourceStats.mtimeMs,
          sourceFingerprint: fingerprint,
          profileVersion: RENDITION_PROFILE_VERSION,
          lastSeenAt: new Date().toISOString(),
          status: registryStatus,
          ...(includeAdaptive
            ? {
                adaptiveStatus: "ready",
                adaptiveProfileVersion,
              }
            : {}),
        },
      ],
    }),
  );
  if (includeGenerated) {
    await writeFile(
      path.join(renditionRoot, renditionId, "current.json"),
      JSON.stringify({
        schemaVersion: 2,
        versionDirectory,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
      }),
    );
    await writeFile(path.join(versionRoot, "480p.mp4"), renditionBytes);
    await writeFile(
      path.join(versionRoot, "metadata.json"),
      JSON.stringify({
        schemaVersion: 3,
        mediaId: renditionId,
        sourceFingerprint: fingerprint,
        profileVersion: RENDITION_PROFILE_VERSION,
        createdAt: new Date().toISOString(),
        durationSeconds: 60,
        original: {
          width: 1920,
          height: 1080,
          qualityHeight: 1080,
          codec: "hevc",
        },
        files: [
          {
            qualityHeight: 480,
            width: 854,
            height: 360,
            bitrate: 2_000_000,
            fileSize: renditionBytes.length,
            videoCodec: hdr ? "hevc" : "h264",
            audioCodec: "aac",
            container: "mp4",
            frameRate: 60,
            file: "480p.mp4",
            sourceAudioStreamIndex: 1,
            audioLanguage: "tur",
            ...(hdr ? { hdr: true } : {}),
          },
        ],
        audioStrategy: "default-track-only",
        subtitleStrategy: "original-playback-only",
        validation: {
          validatedAt: new Date().toISOString(),
          durationToleranceSeconds: 2,
        },
      }),
    );
  }
  if (includeAdaptive) {
    // A package lives in the folder of the title it belongs to.
    const adaptiveRoot = path.dirname(sourcePath);
    const videoBytes = Buffer.from("video-cmaf-bytes");
    const audioBytes = Buffer.from("audio-cmaf-bytes");
    for (const directory of [
      ["video"],
      ["audio"],
      ["subtitle"],
      [".seyirlik"],
      [".seyirlik", "video"],
      [".seyirlik", "audio"],
      [".seyirlik", "subtitle"],
    ]) {
      await mkdir(path.join(adaptiveRoot, ...directory), { recursive: true });
    }
    await writeFile(
      path.join(adaptiveRoot, ".seyirlik", "master.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(
      path.join(adaptiveRoot, ".seyirlik", "video", "720p.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(
      path.join(adaptiveRoot, ".seyirlik", "audio", "english.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(path.join(adaptiveRoot, "video", "720p.mp4"), videoBytes);
    await writeFile(
      path.join(adaptiveRoot, "audio", "english.m4a"),
      audioBytes,
    );
    await writeFile(
      path.join(adaptiveRoot, ".seyirlik", "subtitle", "english.m3u8"),
      "#EXTM3U\n",
    );
    await writeFile(
      path.join(adaptiveRoot, "subtitle", "english.vtt"),
      "WEBVTT\n",
    );
    await writeFile(
      path.join(adaptiveRoot, ".seyirlik", "build.json"),
      JSON.stringify({
        schemaVersion: 1,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
        mediaId: renditionId,
        sourceFingerprint: fingerprint,
        createdAt: "2026-08-13T10:00:00.000Z",
        sourceDurationSeconds: 60,
        source: {
          width: 1920,
          height: 1080,
          qualityHeight: 1080,
          codec: "h264",
          frameRate: 24,
          isHdr: false,
          isVariableFrameRate: false,
          rotation: 0,
        },
        segmentTargetSeconds: 2,
        switchingSetDurationSeconds: 60,
        masterPlaylistPath: ".seyirlik/master.m3u8",
        videoRenditions: [
          {
            id: "720p",
            qualityHeight: 720,
            width: 1280,
            height: 720,
            codec: "h264",
            codecString: "avc1.64001f",
            pixelFormat: "yuv420p",
            hdr: "sdr",
            frameRate: 60,
            averageBitrate: 3_000_000,
            peakBitrate: 3_500_000,
            durationSeconds: 60,
            playlistPath: ".seyirlik/video/720p.m3u8",
            mediaPath: "video/720p.mp4",
            fileSizeBytes: videoBytes.length,
            keyframeCount: 30,
            keyframeIntervalSeconds: {
              target: 2,
              minimum: 2,
              maximum: 2,
              mean: 2,
            },
            segmentCount: 30,
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
            durationSeconds: 60,
            playlistPath: ".seyirlik/audio/english.m3u8",
            mediaPath: "audio/english.m4a",
            fileSizeBytes: audioBytes.length,
            streamCopied: true,
          },
        ],
        subtitleRenditions: [
          {
            id: "subtitle-4",
            sourceStreamIndex: 4,
            language: "eng",
            isDefault: true,
            isForced: false,
            isHearingImpaired: false,
            codec: "webvtt",
            durationSeconds: 60,
            playlistPath: ".seyirlik/subtitle/english.m3u8",
            subtitlePath: "subtitle/english.vtt",
            fileSizeBytes: 7,
          },
        ],
        validation: {
          validatedAt: "2026-08-13T10:00:00.000Z",
          alignmentToleranceSeconds: 0.05,
          audioDurationToleranceSeconds: 0.5,
          checks: ["segment-alignment"],
        },
        storage: {
          videoBytes: videoBytes.length,
          audioBytes: audioBytes.length,
          totalBytes: videoBytes.length + audioBytes.length,
        },
      }),
    );
  }

  const tokens = new Map<string, string>();
  const resolver: PlaybackMediaResolver = {
    resolveMedia: async (requestedId) => {
      if (requestedId !== mediaId) throw new Error("not found");
      return {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      };
    },
    encodeMediaToken: (requestedId) => {
      const token = "opaque-capability";
      tokens.set(token, requestedId);
      return token;
    },
    decodeMediaToken: (token) => {
      const requestedId = tokens.get(token);
      if (!requestedId) throw new Error("invalid token");
      return requestedId;
    },
  };
  const options = {
    mediaRoot,
    renditionRoot,
    stateRoot,
    mediaResolver: resolver,
  };
  const service = createRenditionService(options);
  /** A fresh process over the same disk: every in-memory grant is gone. */
  const restart = () => createRenditionService(options);
  return { service, sourcePath, root, restart };
}

/** Splits a manifest playback URL back into the pair the resolver takes. */
function addressOf(playbackUrl: string): { token: string; fileId: string } {
  const parts = playbackUrl.split("/");
  return {
    token: decodeURIComponent(parts[parts.length - 2] ?? ""),
    fileId: decodeURIComponent(parts[parts.length - 1] ?? ""),
  };
}

describe("complete-file rendition routes", () => {
  it("omits a removed original while keeping its adaptive package available", async () => {
    const { service, sourcePath } = await fixture({
      includeGenerated: false,
      includeAdaptive: true,
    });
    const sourceStats = await stat(sourcePath);
    await unlink(sourcePath);

    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "h264",
        playableUrl: "/api/playback/direct/original",
      },
      { h264: true, hevc: false },
    );

    expect(manifest.qualities).toEqual([]);
    expect(manifest.adaptive).toBeDefined();
  });

  it("returns only ready complete files and resolves them to real bytes", async () => {
    const { service, sourcePath } = await fixture();
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(
      manifest.qualities.map((quality) => [quality.kind, quality.height]),
    ).toEqual([
      ["original", 1080],
      ["generated", 480],
    ]);
    const generated = manifest.qualities.find(
      (quality) => quality.kind === "generated",
    );
    expect(generated?.playbackUrl).toMatch(
      /^\/api\/playback\/renditions\/opaque-capability\/480-[a-f0-9]{12}\.mp4$/,
    );
    expect(JSON.stringify(manifest)).not.toContain(sourcePath);
    expect(JSON.stringify(manifest)).not.toContain("480p.mp4");

    // Resolution hands back the validated file; the playback route streams it
    // with the same byte-range implementation the original file uses.
    const address = addressOf(generated?.playbackUrl ?? "");
    const resolved = await service.resolveFile(address.token, address.fileId);
    expect(resolved?.sizeBytes).toBe(renditionBytes.length);
    expect(await readFile(resolved?.absolutePath ?? "", "utf8")).toBe(
      renditionBytes.toString("utf8"),
    );
  });

  it("returns an original-only manifest when no validated generated file exists", async () => {
    const { service, sourcePath } = await fixture({ includeGenerated: false });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(manifest.qualities).toEqual([
      expect.objectContaining({ kind: "original", height: 1080 }),
    ]);
  });

  it("omits complete files whose registry record is not ready", async () => {
    const { service, sourcePath } = await fixture({ registryStatus: "failed" });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      {
        width: 1920,
        height: 1080,
        codec: "hevc",
        playableUrl: "/api/playback/direct/original",
      },
    );

    expect(manifest.qualities).toEqual([
      expect.objectContaining({ kind: "original", height: 1080 }),
    ]);
  });

  it.each(["already-valid", "pending"])(
    "still exposes validated complete files when the registry record is %s",
    async (registryStatus) => {
      const { service, sourcePath } = await fixture({ registryStatus });
      const sourceStats = await stat(sourcePath);
      const manifest = await service.createManifest(
        {
          mediaId,
          filePath: sourcePath,
          size: sourceStats.size,
          mtimeMs: sourceStats.mtimeMs,
        },
        {
          width: 1920,
          height: 1080,
          codec: "hevc",
          playableUrl: "/api/playback/direct/original",
        },
      );

      expect(
        manifest.qualities.map((quality) => [quality.kind, quality.height]),
      ).toEqual([
        ["original", 1080],
        ["generated", 480],
      ]);
    },
  );

  it("offers an HDR HEVC rendition only to a client that can decode HEVC", async () => {
    const { service, sourcePath } = await fixture({ hdr: true });
    const sourceStats = await stat(sourcePath);
    const media = {
      mediaId,
      filePath: sourcePath,
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
    };
    const original = {
      width: 1920,
      height: 1080,
      codec: "hevc",
      playableUrl: "/api/playback/direct/original",
    };

    const hevcClient = await service.createManifest(media, original, {
      hevc: true,
      h264: true,
    });
    expect(
      hevcClient.qualities.map((quality) => [quality.kind, quality.hdr]),
    ).toEqual([
      ["original", undefined],
      ["generated", true],
    ]);

    // Without HEVC the file is undecodable, so it must not be offered at all —
    // playback falls back to the existing transcode path instead.
    const h264OnlyClient = await service.createManifest(media, original, {
      hevc: false,
      h264: true,
    });
    expect(h264OnlyClient.qualities).toEqual([
      expect.objectContaining({ kind: "original" }),
    ]);
  });

  it("rejects traversal and unregistered files without exposing filesystem paths", async () => {
    const { service, sourcePath, root } = await fixture();
    const sourceStats = await stat(sourcePath);
    await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      { width: 1920, height: 1080, codec: "hevc" },
    );
    // Nothing outside the validated output root resolves, and neither does a
    // file that was never registered — possession of the token is not enough.
    expect(
      await service.resolveFile("opaque-capability", "../metadata.mp4"),
    ).toBeNull();
    expect(
      await service.resolveFile("opaque-capability", "not-registered.mp4"),
    ).toBeNull();
    expect(
      await service.resolveFile("unknown-token", "480-abc123def456.mp4"),
    ).toBeNull();
    expect(root).toBeTruthy();
  });

  /**
   * What moving `ADAPTIVE_PROFILE_VERSION` actually costs.
   *
   * A package whose recorded profile does not match is not merely flagged for
   * rebuilding — it is withdrawn from delivery entirely, and the title loses
   * its quality ladder until it has been re-encoded. That makes the constant a
   * statement about *readability*, never a convenient way to mark packages as
   * out of date: a ladder that gains a rung leaves every existing package
   * perfectly playable and must not move it. Nothing caught this the first
   * time, so it is written down here.
   */
  it("withdraws an adaptive package whose profile version does not match", async () => {
    const { service, sourcePath } = await fixture({
      includeAdaptive: true,
      adaptiveProfileVersion: "cmaf-hls-aligned-v3-superseded",
    });
    const sourceStats = await stat(sourcePath);

    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );

    expect(manifest.adaptive).toBeUndefined();
  });

  /**
   * A registry record with no modification time must not withdraw the ladder.
   *
   * This is what put a fully packaged title into direct play with "Original
   * (2160p)" as its only quality: a recovery path enqueued work without stats
   * to hand, wrote `mtimeMs: 0` into the registry, and every later comparison
   * against the real file failed — so the manifest came back empty and eight
   * published renditions became invisible.
   */
  it("still describes a title whose registry record has no modification time", async () => {
    const { service, sourcePath } = await fixture({ includeAdaptive: true });
    const sourceStats = await stat(sourcePath);

    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );
    expect(manifest.adaptive).toBeDefined();

    // The same file, described by a record that never recorded an mtime.
    const registryPath = path.join(
      path.dirname(path.dirname(sourcePath)),
      ".seyirlik",
      "state",
      "registry.json",
    );
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.items[0].mtimeMs = 0;
    await writeFile(registryPath, JSON.stringify(registry), "utf8");

    const afterwards = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );
    expect(afterwards.adaptive).toBeDefined();
  });

  /** A record describing a different size is still rejected outright. */
  it("withdraws the ladder when the registered size disagrees", async () => {
    const { service, sourcePath } = await fixture({ includeAdaptive: true });
    const sourceStats = await stat(sourcePath);

    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size + 1_000,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );
    expect(manifest.adaptive).toBeUndefined();
  });

  it("offers and resolves only registered adaptive package assets", async () => {
    const { service, sourcePath } = await fixture({ includeAdaptive: true });
    const sourceStats = await stat(sourcePath);
    const manifest = await service.createManifest(
      {
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
      undefined,
      { h264: true, hevc: false },
    );

    expect(manifest.adaptive).toMatchObject({
      profileVersion: ADAPTIVE_PROFILE_VERSION,
      switching: "aligned-cmaf-hls",
      qualities: [{ id: "720p", height: 720, label: "720p60" }],
    });
    // The URL segment identifies the package build, not the source, so a
    // rebuilt package never reuses a URL whose assets are served `immutable`.
    const versionId = new URL(
      `https://media.test${manifest.adaptive!.playbackUrl}`,
    ).pathname
      .split("/adaptive/")[1]!
      .split("/")[0]!;
    expect(versionId).toMatch(/^[0-9a-f]{12}$/);
    expect(versionId).not.toBe(fingerprint.slice(0, 12));
    const master = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      ".seyirlik/master.m3u8",
    );
    const media = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      "video/720p.mp4",
    );
    expect(master?.contentType).toBe("application/vnd.apple.mpegurl");
    expect(await readFile(media?.absolutePath ?? "", "utf8")).toBe(
      "video-cmaf-bytes",
    );
    await expect(
      service.resolveAdaptiveAsset(
        "opaque-capability",
        versionId,
        "video/../../etc/passwd",
      ),
    ).resolves.toBeNull();

    /**
     * A subtitle group the master advertises has to resolve. This is an
     * allow-list, so a rendition kind the packager writes but it does not name
     * is a 404 — and a 404 behind an advertised subtitle group does not
     * degrade to "no subtitles", it fails the whole title in both engines.
     */
    const subtitlePlaylist = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      ".seyirlik/subtitle/english.m3u8",
    );
    const subtitleFile = await service.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      "subtitle/english.vtt",
    );
    expect(subtitlePlaylist?.contentType).toBe("application/vnd.apple.mpegurl");
    expect(await readFile(subtitleFile?.absolutePath ?? "", "utf8")).toBe(
      "WEBVTT\n",
    );

    // A download keeps each subtitle from the package's own file, named by
    // the source stream it came from, at a URL that resolves to it.
    expect(manifest.adaptive!.subtitleTracks).toEqual([
      {
        sourceStreamIndex: 4,
        url: expect.stringMatching(/\/subtitle\/english\.vtt$/),
      },
    ]);
    expect(manifest.adaptive!.subtitleTracks![0]!.url).toContain(
      `/adaptive/${versionId}/subtitle/english.vtt`,
    );
  });
});

describe("adaptive grants across a restart", () => {
  it("keeps serving a package a previous process handed out", async () => {
    // Grants live in memory. Before they could be restored, every deploy
    // answered 404 to the next segment of every film in progress.
    const { service, sourcePath, restart } = await fixture({
      includeAdaptive: true,
    });
    const sourceStats = await stat(sourcePath);
    const media = {
      mediaId,
      filePath: sourcePath,
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
    };
    const manifest = await service.createManifest(media, undefined, {
      h264: true,
      hevc: false,
    });
    const versionId = manifest
      .adaptive!.playbackUrl.split("/adaptive/")[1]!
      .split("/")[0]!;

    const restarted = restart();
    await expect(
      restarted.resolveAdaptiveAsset(
        "opaque-capability",
        versionId,
        "video/720p.mp4",
      ),
    ).resolves.toBeNull();

    // Two segment requests racing in after the restart share one restore.
    await Promise.all([
      restarted.restoreAdaptiveAccess!(media),
      restarted.restoreAdaptiveAccess!(media),
    ]);
    const segment = await restarted.resolveAdaptiveAsset(
      "opaque-capability",
      versionId,
      "video/720p.mp4",
    );
    expect(await readFile(segment?.absolutePath ?? "", "utf8")).toBe(
      "video-cmaf-bytes",
    );

    // A URL naming some other build of the package is still refused.
    await expect(
      restarted.resolveAdaptiveAsset(
        "opaque-capability",
        "000000000000",
        "video/720p.mp4",
      ),
    ).resolves.toBeNull();
  });
});

describe("describePackagedSource", () => {
  it("reports the package duration for a title whose source bytes are gone", async () => {
    const { service, sourcePath } = await fixture({
      includeGenerated: false,
      includeAdaptive: true,
    });
    const sourceStats = await stat(sourcePath);
    await unlink(sourcePath);

    await expect(
      service.describePackagedSource({
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      }),
    ).resolves.toMatchObject({
      durationSeconds: 60,
      video: { codecName: "h264", width: 1920, height: 1080, isHdr: false },
    });
  });

  it("reports nothing for a title with no adaptive package", async () => {
    const { service, sourcePath } = await fixture();
    const sourceStats = await stat(sourcePath);

    await expect(
      service.describePackagedSource({
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      }),
    ).resolves.toBeNull();
  });

  it("reports nothing for a package built under an older profile", async () => {
    const { service, sourcePath } = await fixture({
      includeGenerated: false,
      includeAdaptive: true,
      adaptiveProfileVersion: "cmaf-hls-aligned-v0",
    });
    const sourceStats = await stat(sourcePath);

    await expect(
      service.describePackagedSource({
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      }),
    ).resolves.toBeNull();
  });
});

describe("findPackagedVideo", () => {
  it("names the package's highest video rendition once the source is gone", async () => {
    const { service, sourcePath } = await fixture({
      includeGenerated: false,
      includeAdaptive: true,
    });
    const sourceStats = await stat(sourcePath);
    await unlink(sourcePath);

    const video = await service.findPackagedVideo({
      mediaId,
      filePath: sourcePath,
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
    });
    expect(video).toMatchObject({
      width: 1280,
      height: 720,
      colorTransfer: null,
    });
    expect(video?.path.split(path.sep).join("/")).toMatch(
      /\/video\/720p\.mp4$/,
    );
    expect((await stat(video!.path)).isFile()).toBe(true);
    expect(video?.playlistPath.split(path.sep).join("/")).toMatch(
      /720p.*\.m3u8$/,
    );
    expect((await stat(video!.playlistPath)).isFile()).toBe(true);
  });

  it("names nothing for a title with no adaptive package", async () => {
    const { service, sourcePath } = await fixture();
    const sourceStats = await stat(sourcePath);

    await expect(
      service.findPackagedVideo({
        mediaId,
        filePath: sourcePath,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      }),
    ).resolves.toBeNull();
  });
});

describe("findPackagedAudio", () => {
  it("names the package's default audio rendition and its playlist once the source is gone", async () => {
    const { service, sourcePath } = await fixture({
      includeGenerated: false,
      includeAdaptive: true,
    });
    const sourceStats = await stat(sourcePath);
    await unlink(sourcePath);

    const audio = await service.findPackagedAudio({
      mediaId,
      filePath: sourcePath,
      size: sourceStats.size,
      mtimeMs: sourceStats.mtimeMs,
    });
    expect(audio?.durationSeconds).toBe(60);
    expect(audio?.path.split(path.sep).join("/")).toMatch(
      /\/audio\/english\.m4a$/,
    );
    expect((await stat(audio!.path)).isFile()).toBe(true);
    expect(audio?.playlistPath.split(path.sep).join("/")).toMatch(
      /\/\.seyirlik\/audio\/english\.m3u8$/,
    );
    expect((await stat(audio!.playlistPath)).isFile()).toBe(true);
  });
});

describe("adaptiveVersionIdFor", () => {
  const base = {
    profileVersion: ADAPTIVE_PROFILE_VERSION,
    sourceFingerprint: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("produces a version segment the route will accept", () => {
    expect(adaptiveVersionIdFor(base)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable for the same package", () => {
    expect(adaptiveVersionIdFor(base)).toBe(adaptiveVersionIdFor({ ...base }));
  });

  /**
   * Adaptive assets are served `immutable`, so a rebuilt package must never
   * land on a URL a client may already have cached: the cached playlists and
   * byte ranges would be read against different media, and playback would stop
   * with nothing to explain it.
   */
  it("changes when the package is rebuilt from the same source", () => {
    expect(
      adaptiveVersionIdFor({
        ...base,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ).not.toBe(adaptiveVersionIdFor(base));
  });

  it("changes when the profile changes", () => {
    expect(
      adaptiveVersionIdFor({ ...base, profileVersion: "other-profile" }),
    ).not.toBe(adaptiveVersionIdFor(base));
  });

  it("distinguishes two sources packaged at the same instant", () => {
    expect(
      adaptiveVersionIdFor({ ...base, sourceFingerprint: "b".repeat(64) }),
    ).not.toBe(adaptiveVersionIdFor(base));
  });

  /**
   * A master repair rewrites the playlist in place and does not re-encode, so
   * the package keeps the creation stamp it was built under. Without the layout
   * in the key, a corrected master inherited the URL of the broken one it
   * replaced, and every client holding the old copy kept it for the year the
   * `immutable` directive promises — which is exactly as long as the bug the
   * repair fixes would have gone on showing.
   */
  it("changes when the master layout is repaired", () => {
    expect(adaptiveVersionIdFor({ ...base, masterLayoutVersion: 3 })).not.toBe(
      adaptiveVersionIdFor({ ...base, masterLayoutVersion: 2 }),
    );
  });

  /** A package predating the stamp is the original layout, not a new one. */
  it("treats an unstamped package as the original layout", () => {
    expect(adaptiveVersionIdFor(base)).toBe(
      adaptiveVersionIdFor({ ...base, masterLayoutVersion: 1 }),
    );
  });
});
