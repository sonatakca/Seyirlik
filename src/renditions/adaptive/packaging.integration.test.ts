/**
 * End-to-end packaging against real FFmpeg output.
 *
 * These tests exist because the properties that make adaptive switching
 * invisible cannot be checked by inspecting a command line. Whether two
 * renditions really land on the same keyframes, whether a segment really begins
 * on a random-access frame, and whether an irregular-timestamp source really
 * cuts on two-second boundaries are all facts about bytes, and the only honest
 * way to establish them is to encode something and measure it.
 */

import {
  copyFile,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { packageAdaptiveRendition } from "./packager";
import { parseMasterPlaylist, parseMediaPlaylist } from "./playlist";
import { probeKeyframeTimes } from "./probePackaged";
import { validateAdaptivePackage } from "./validation";
import { parseAdaptiveMetadata } from "./metadata";
import {
  ADAPTIVE_SOURCE_FIXTURES,
  ensureAdaptiveHdrFixture,
  ensureAdaptiveSourceFixtures,
  getAdaptiveFixtureDirectory,
} from "./testFixtures";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

let ffmpegAvailable = false;
let workspace = "";

async function createPaths(): Promise<RenditionPaths> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: getAdaptiveFixtureDirectory(),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });
  return paths;
}

async function packageSource(
  sourcePath: string,
  options: Record<string, unknown> = {},
) {
  const paths = await createPaths();
  /*
   * A package is published beside its source, so two runs against one fixture
   * would share a destination and the second would find the first already
   * there. Each run gets its own copy of the source in its own title folder,
   * which is also how a real library is shaped: one folder, one title.
   */
  const titleRoot = await mkdtemp(path.join(workspace, "title-"));
  const isolatedSource = path.join(titleRoot, path.basename(sourcePath));
  await copyFile(sourcePath, isolatedSource);
  sourcePath = isolatedSource;
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  const result = await packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(sourcePath),
      sourceFingerprint: fingerprint,
      sourcePath,
    },
    paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      ...options,
    },
  );
  /*
   * A package now lives with the title it belongs to, so the folder holding the
   * source is also the root every published path is relative to.
   */
  const versionRoot = path.dirname(sourcePath);
  return { result, paths, fingerprint, versionRoot };
}

beforeAll(async () => {
  ffmpegAvailable = await ensureAdaptiveSourceFixtures();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-adaptive-it-"));
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe.each(ADAPTIVE_SOURCE_FIXTURES)(
  "adaptive packaging of $description",
  (fixture) => {
    it("produces an aligned, validated, single-file byte-range CMAF package", async () => {
      if (!ffmpegAvailable) {
        console.warn(
          "FFmpeg is not available; skipping adaptive packaging test.",
        );
        return;
      }

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { result, versionRoot } = await packageSource(sourcePath);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("ready");
      expect(versionRoot).toBeDefined();
      expect(result.versionDirectory).toMatch(
        new RegExp(`^${ADAPTIVE_PROFILE_VERSION}-[0-9a-f]{16}$`),
      );

      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(
            path.join(versionRoot!, ".seyirlik", "build.json"),
            "utf8",
          ),
        ),
        { enforceCanonicalPaths: false },
      );

      // Every check the validator can make must have run and passed, including
      // the decode-level ones. A package that skipped them would still parse.
      expect(metadata.validation.checks).toEqual(
        expect.arrayContaining([
          "segment-alignment",
          "keyframe-alignment",
          "segment-keyframe-start",
          "seek-decode",
          "cross-quality-splice",
        ]),
      );

      expect(metadata.videoRenditions.length).toBeGreaterThanOrEqual(2);
      expect(metadata.audioRenditions.length).toBeGreaterThanOrEqual(1);
      expect(metadata.segmentTargetSeconds).toBe(2);

      // One media file per rendition, addressed by byte range: this is what
      // keeps a 345-hour library from becoming a million small files.
      for (const rendition of [
        ...metadata.videoRenditions,
        ...metadata.audioRenditions,
      ]) {
        const playlist = parseMediaPlaylist(
          await readFile(
            path.join(versionRoot!, ...rendition.playlistPath.split("/")),
            "utf8",
          ),
        );
        // Audio playlists do not repeat the tag: the master declares it, and
        // per RFC 8216 that applies to every media playlist it references.
        // Video playlists carry it as well, which is where it is load-bearing.
        if (metadata.videoRenditions.includes(rendition as never)) {
          expect(playlist.independentSegments).toBe(true);
        }
        // One file per rendition is what makes byte ranges possible, so the
        // initialisation range and every segment must still name that one file
        // — now under the published name it carries in the library.
        const publishedUri = rendition.mediaPath
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");
        expect(playlist.map.uri).toBe(`../../${publishedUri}`);
        expect(
          new Set(playlist.segments.map((segment) => segment.uri)),
        ).toEqual(new Set([`../../${publishedUri}`]));
        const mediaStats = await stat(
          path.join(versionRoot!, ...rendition.mediaPath.split("/")),
        );
        expect(mediaStats.size).toBe(rendition.fileSizeBytes);
      }
    }, 300_000);

    it("cuts every rendition on the same two-second keyframes", async () => {
      if (!ffmpegAvailable) return;

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { versionRoot } = await packageSource(sourcePath);
      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(
            path.join(versionRoot!, ".seyirlik", "build.json"),
            "utf8",
          ),
        ),
        { enforceCanonicalPaths: false },
      );

      const keyframesByRendition = new Map<string, number[]>();
      for (const rendition of metadata.videoRenditions) {
        keyframesByRendition.set(
          rendition.id,
          await probeKeyframeTimes(
            path.join(versionRoot!, ...rendition.mediaPath.split("/")),
            "ffprobe",
          ),
        );
      }

      const [referenceId, referenceTimes] = [...keyframesByRendition][0];
      const referenceBase = referenceTimes[0];

      // Two seconds, measured. An irregular-timestamp source reaches this
      // because keyframes are forced on presentation time rather than on frame
      // counts, which is the whole reason the policy is expressed that way.
      for (let index = 1; index < referenceTimes.length; index += 1) {
        expect(referenceTimes[index] - referenceTimes[index - 1]).toBeCloseTo(
          2,
          1,
        );
      }

      const frameTolerance = 1 / fixture.frameRate + 0.002;
      for (const [id, times] of keyframesByRendition) {
        if (id === referenceId) continue;
        expect(times.length).toBe(referenceTimes.length);
        for (let index = 0; index < times.length; index += 1) {
          expect(
            Math.abs(
              times[index] - times[0] - (referenceTimes[index] - referenceBase),
            ),
          ).toBeLessThanOrEqual(frameTolerance);
        }
      }

      // Segment boundaries, not merely keyframes, must match: they are what a
      // player actually requests when it changes rung mid-playback.
      const boundaries = new Map<string, number[]>();
      for (const rendition of metadata.videoRenditions) {
        const playlist = parseMediaPlaylist(
          await readFile(
            path.join(versionRoot!, ...rendition.playlistPath.split("/")),
            "utf8",
          ),
        );
        let elapsed = 0;
        boundaries.set(
          rendition.id,
          playlist.segments.map((segment) => {
            const start = elapsed;
            elapsed += segment.durationSeconds;
            return start;
          }),
        );
      }
      const referenceBoundaries = [...boundaries.values()][0];
      for (const starts of boundaries.values()) {
        expect(starts).toEqual(referenceBoundaries);
      }
    }, 300_000);

    it("does not duplicate audio into any video rendition", async () => {
      if (!ffmpegAvailable) return;

      const sourcePath = path.join(
        getAdaptiveFixtureDirectory(),
        fixture.fileName,
      );
      const { versionRoot } = await packageSource(sourcePath);
      const metadata = parseAdaptiveMetadata(
        JSON.parse(
          await readFile(
            path.join(versionRoot!, ".seyirlik", "build.json"),
            "utf8",
          ),
        ),
        { enforceCanonicalPaths: false },
      );

      const { probePackagedAudio } = await import("./probePackaged");
      for (const rendition of metadata.videoRenditions) {
        await expect(
          probePackagedAudio(
            path.join(versionRoot!, ...rendition.mediaPath.split("/")),
            "ffprobe",
          ),
        ).rejects.toThrow(/no audio stream/i);
      }
    }, 300_000);
  },
);

describe("adaptive packaging with several audio tracks", () => {
  it("packages one shared audio rendition per source track", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-2398.mp4",
    );
    const { result, versionRoot } = await packageSource(sourcePath, {
      allAudioTracks: true,
    });

    expect(result.status).toBe("ready");
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(
          path.join(versionRoot!, ".seyirlik", "build.json"),
          "utf8",
        ),
      ),
      { enforceCanonicalPaths: false },
    );

    expect(metadata.audioRenditions).toHaveLength(2);
    expect(metadata.audioRenditions.map((rendition) => rendition.id)).toEqual([
      "track-1",
      "track-2",
    ]);
    expect(
      metadata.audioRenditions.map((rendition) => rendition.language),
    ).toEqual(["eng", "tur"]);
    expect(
      metadata.audioRenditions.filter((rendition) => rendition.isDefault),
    ).toHaveLength(1);

    // AC3 is not a browser-decodable fMP4 audio codec, so it must have been
    // re-encoded rather than carried through.
    const turkish = metadata.audioRenditions[1];
    expect(turkish.streamCopied).toBe(false);
    expect(turkish.codec).toBe("aac");
    expect(turkish.sampleRate).toBe(48_000);

    const master = parseMasterPlaylist(
      await readFile(
        path.join(versionRoot!, ".seyirlik", "master.m3u8"),
        "utf8",
      ),
    );
    expect(master.audioRenditions).toHaveLength(2);
    for (const variant of master.variants) {
      expect(variant.audioGroup).toBe("aud");
      // A video variant advertises the audio codec it is paired with even
      // though it carries none of it.
      expect(variant.codecs).toContain("mp4a.40.2");
    }
  }, 300_000);

  it("records tracks a run deliberately left out", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-2398.mp4",
    );
    const { versionRoot } = await packageSource(sourcePath, {
      allAudioTracks: false,
    });
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(
          path.join(versionRoot!, ".seyirlik", "build.json"),
          "utf8",
        ),
      ),
      { enforceCanonicalPaths: false },
    );

    expect(metadata.audioRenditions).toHaveLength(1);
    // Present so an operator can tell "this title has one language" from "this
    // run only packaged the default track".
    expect(metadata.deferredAudioStreamIndexes).toEqual([2]);
  }, 300_000);
});

describe("adaptive packaging of HDR sources", () => {
  it("keeps HDR10 as hvc1-tagged 10-bit HEVC without tone mapping", async () => {
    if (!ffmpegAvailable) return;
    const sourcePath = await ensureAdaptiveHdrFixture();
    if (!sourcePath) {
      console.warn(
        "libx265 is not available; skipping the HDR packaging test.",
      );
      return;
    }

    const { result, versionRoot } = await packageSource(sourcePath, {
      encoderPreference: "software",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ready");

    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(
          path.join(versionRoot!, ".seyirlik", "build.json"),
          "utf8",
        ),
      ),
      { enforceCanonicalPaths: false },
    );

    expect(metadata.source.isHdr).toBe(true);
    for (const rendition of metadata.videoRenditions) {
      expect(rendition.codec).toBe("hevc");
      expect(rendition.hdr).toBe("hdr10");
      expect(rendition.pixelFormat).toContain("10");
      expect(rendition.colorTransfer).toBe("smpte2084");
      expect(rendition.codecString.startsWith("hvc1")).toBe(true);
    }

    const master = parseMasterPlaylist(
      await readFile(
        path.join(versionRoot!, ".seyirlik", "master.m3u8"),
        "utf8",
      ),
    );
    for (const variant of master.variants) {
      expect(variant.videoRange).toBe("PQ");
    }

    const validation = await validateAdaptivePackage({
      versionRoot: versionRoot!,
      mediaId: MEDIA_ID,
      deep: true,
    });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  }, 900_000);
});

describe("adaptive WebVTT subtitle packaging", () => {
  it("extracts the retained forced track and signals it in the master", async () => {
    if (!ffmpegAvailable) return;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const subtitleSource = path.join(workspace, "forced-subtitle.srt");
    const sourcePath = path.join(workspace, "source-with-forced-subtitle.mkv");
    await writeFile(
      subtitleSource,
      "1\n00:00:01,000 --> 00:00:03,000\nOnly the beginning.\n",
      "utf8",
    );
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      path.join(getAdaptiveFixtureDirectory(), "source-sdr-2398.mp4"),
      "-f",
      "srt",
      "-i",
      subtitleSource,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-c:s",
      "srt",
      "-metadata:s:s:0",
      "language=eng",
      "-disposition:s:0",
      "forced",
      sourcePath,
    ]);

    const { result, versionRoot } = await packageSource(sourcePath, {
      subtitleStreamIndexes: [2],
    });
    expect(result.status).toBe("ready");
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(
          path.join(versionRoot!, ".seyirlik", "build.json"),
          "utf8",
        ),
      ),
      { enforceCanonicalPaths: false },
    );
    expect(metadata.subtitleRenditions).toEqual([
      expect.objectContaining({
        sourceStreamIndex: 2,
        language: "eng",
        isForced: true,
        codec: "webvtt",
      }),
    ]);
    const vtt = await readFile(
      path.join(versionRoot!, "subtitle", "english (forced).vtt"),
      "utf8",
    );
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("Only the beginning.");
    const master = parseMasterPlaylist(
      await readFile(
        path.join(versionRoot!, ".seyirlik", "master.m3u8"),
        "utf8",
      ),
    );
    expect(master.subtitleRenditions).toEqual([
      expect.objectContaining({ language: "eng", isForced: true }),
    ]);
    expect(metadata.validation.checks).toContain("webvtt-subtitles");
  }, 300_000);
});

describe("adaptive packaging refusals", () => {
  /**
   * A small source still earns a package: it gets its own class and the rungs
   * below it. That package is the copy that lets the original file be removed,
   * so refusing it would leave the smallest titles permanently dependent on
   * their source.
   */
  it("packages a small source down from its own class", async () => {
    if (!ffmpegAvailable) return;

    const smallSource = path.join(workspace, "small.mp4");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=25:duration=3",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      smallSource,
    ]);

    const { result, versionRoot } = await packageSource(smallSource);
    expect(result.status).toBe("ready");
    const metadata = parseAdaptiveMetadata(
      JSON.parse(
        await readFile(
          path.join(versionRoot!, ".seyirlik", "build.json"),
          "utf8",
        ),
      ),
      { enforceCanonicalPaths: false },
    );
    expect(
      metadata.videoRenditions.map((rendition) => rendition.qualityHeight),
    ).toEqual([360, 240, 144]);
  }, 120_000);

  it("refuses a source with no audio", async () => {
    if (!ffmpegAvailable) return;

    const mute = path.join(workspace, "mute.mp4");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1920x1080:rate=25:duration=3",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-y",
      mute,
    ]);

    const { result } = await packageSource(mute);
    expect(result.status).toBe("incompatible");
    expect(result.error).toMatch(/no audio stream/i);
  }, 120_000);

  it("does not activate a package when free space would breach the reserve", async () => {
    if (!ffmpegAvailable) return;

    const sourcePath = path.join(
      getAdaptiveFixtureDirectory(),
      "source-sdr-25.mp4",
    );
    const { result } = await packageSource(sourcePath, {
      reserveBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(result.status).toBe("deferred-for-storage");
    expect(result.versionDirectory).toBeUndefined();
  }, 120_000);
});

describe("resuming a package that never finished validating", () => {
  it.each([
    { withPackage: true, status: "ready" },
    { withPackage: false, status: "deferred-for-storage" },
  ])(
    "counts the unverified package it replaces as free space: $withPackage",
    async ({ withPackage, status }) => {
      if (!ffmpegAvailable) return;
      // A restart mid-validation leaves an assembled package with no verified
      // marker. The packager removes it before re-assembling, so the
      // preflight must not demand room for it as well.
      const paths = await createPaths();
      const titleRoot = await mkdtemp(path.join(workspace, "title-"));
      const sourcePath = path.join(titleRoot, "source-sdr-25.mp4");
      await copyFile(
        path.join(getAdaptiveFixtureDirectory(), "source-sdr-25.mp4"),
        sourcePath,
      );
      const fingerprint = await computeSourceFingerprint(
        sourcePath,
        await stat(sourcePath),
      );
      const workspaceId = "22222222-2222-4222-8222-222222222222";
      const own = path.join(paths.workRoot, workspaceId);
      await mkdir(own, { recursive: true });
      await writeFile(
        path.join(own, ".seyirlik-job.json"),
        JSON.stringify({
          schemaVersion: 1,
          owner: "seyirlik-processing-job",
          workspaceId,
          sourceFingerprint: fingerprint,
        }),
      );
      const assembled = path.join(
        own,
        `${ADAPTIVE_PROFILE_VERSION}-${fingerprint.slice(0, 16)}.verified-package`,
      );
      if (withPackage) {
        await mkdir(assembled, { recursive: true });
        // Sparse: its size is what counts, not its blocks.
        const handle = await open(path.join(assembled, "video.m4s"), "w");
        await handle.truncate(64 * 1024 * 1024 * 1024);
        await handle.close();
      }

      const result = await packageAdaptiveRendition(
        {
          mediaId: MEDIA_ID,
          relativePath: path.basename(sourcePath),
          sourceFingerprint: fingerprint,
          sourcePath,
          workspaceId,
        },
        paths,
        {
          reserveBytes: 0,
          preset: "ultrafast",
          verifySourceFingerprint: false,
          // Less room than one more copy of this package would take.
          driveSpaceProvider: async () => ({ totalBytes: 1e12, freeBytes: 1 }),
        },
      );

      expect(result.status).toBe(status);
      if (withPackage) {
        // The stale package was replaced, not kept beside the new one.
        await expect(stat(path.join(assembled, "video.m4s"))).rejects.toThrow();
      }
    },
    180_000,
  );
});

describe("resume behaviour", () => {
  it("re-points at an already-valid deterministic version instead of re-encoding", async () => {
    if (!ffmpegAvailable) return;

    // Its own title folder, because the second run is meant to find the first
    // run's package — and only that one.
    const titleRoot = await mkdtemp(path.join(workspace, "resume-"));
    const sourcePath = path.join(titleRoot, "source-sdr-25.mp4");
    await copyFile(
      path.join(getAdaptiveFixtureDirectory(), "source-sdr-25.mp4"),
      sourcePath,
    );
    const paths = await createPaths();
    const fingerprint = await computeSourceFingerprint(
      sourcePath,
      await stat(sourcePath),
    );
    const request = {
      mediaId: MEDIA_ID,
      relativePath: "source-sdr-25.mp4",
      sourceFingerprint: fingerprint,
      sourcePath,
    };
    const options = {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
    };

    const first = await packageAdaptiveRendition(request, paths, options);
    expect(first.status).toBe("ready");

    const second = await packageAdaptiveRendition(request, paths, options);
    expect(second.status).toBe("already-valid");
    expect(second.versionDirectory).toBe(first.versionDirectory);
  }, 300_000);
});
