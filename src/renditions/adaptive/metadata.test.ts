import { describe, expect, it } from "vitest";
import { parseAdaptiveMetadata, parseAdaptivePointer } from "./metadata";
import { ADAPTIVE_PROFILE_VERSION } from "./profile";

const FINGERPRINT = "a".repeat(64);

function validMetadata(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileVersion: ADAPTIVE_PROFILE_VERSION,
    mediaId: "33333333-3333-4333-8333-333333333333",
    sourceFingerprint: FINGERPRINT,
    createdAt: "2026-08-13T10:00:00.000Z",
    sourceDurationSeconds: 5400,
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
    segmentTargetSeconds: 2,
    switchingSetDurationSeconds: 5400,
    masterPlaylistPath: "master.m3u8",
    videoRenditions: [
      {
        id: "720p",
        qualityHeight: 720,
        width: 1280,
        height: 534,
        codec: "hevc",
        codecString: "hvc1.2.4.L120.B0",
        pixelFormat: "yuv420p10le",
        hdr: "hdr10",
        colorTransfer: "smpte2084",
        frameRate: 23.976,
        averageBitrate: 3_000_000,
        peakBitrate: 3_600_000,
        durationSeconds: 5400,
        playlistPath: "video/720p/playlist.m3u8",
        mediaPath: "video/720p/media.m4s",
        fileSizeBytes: 2_025_000_000,
        keyframeCount: 2700,
        keyframeIntervalSeconds: { target: 2, minimum: 2, maximum: 2, mean: 2 },
        segmentCount: 2700,
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
        durationSeconds: 5400,
        playlistPath: "audio/track-1/playlist.m3u8",
        mediaPath: "audio/track-1/media.m4s",
        fileSizeBytes: 129_600_000,
        streamCopied: false,
      },
    ],
    validation: {
      validatedAt: "2026-08-13T10:30:00.000Z",
      alignmentToleranceSeconds: 0.0437,
      audioDurationToleranceSeconds: 0.5,
      checks: ["segment-alignment"],
    },
    storage: {
      videoBytes: 2_025_000_000,
      audioBytes: 129_600_000,
      totalBytes: 2_154_600_000,
    },
  };
}

function withMetadata(
  mutate: (metadata: ReturnType<typeof validMetadata>) => void,
) {
  const metadata = validMetadata();
  mutate(metadata);
  return metadata;
}

describe("parseAdaptiveMetadata", () => {
  it("allows subtitle-only incremental scratch while keeping published packages strict", () => {
    const metadata = {
      ...validMetadata(),
      videoRenditions: [],
      audioRenditions: [],
      subtitleRenditions: [
        {
          id: "subtitle-1000",
          sourceStreamIndex: 1000,
          sidecarFingerprint: "b".repeat(64),
          language: "tur",
          isDefault: false,
          isForced: false,
          isHearingImpaired: false,
          codec: "webvtt",
          durationSeconds: 5400,
          playlistPath: "subtitles/subtitle-1000/playlist.m3u8",
          subtitlePath: "subtitles/subtitle-1000/subtitles.vtt",
          fileSizeBytes: 100,
        },
      ],
      storage: {
        videoBytes: 0,
        audioBytes: 0,
        subtitleBytes: 100,
        totalBytes: 100,
      },
    };
    expect(() => parseAdaptiveMetadata(metadata)).toThrow(/videoRenditions/);
    const options = { allowMissingVideo: true, allowMissingAudio: true };
    expect(
      parseAdaptiveMetadata(metadata, options).subtitleRenditions?.[0]
        ?.sidecarFingerprint,
    ).toBe("b".repeat(64));
    expect(() =>
      parseAdaptiveMetadata({ ...metadata, subtitleRenditions: [] }, options),
    ).toThrow(/at least one rendition/);
    expect(() =>
      parseAdaptiveMetadata(
        {
          ...metadata,
          subtitleRenditions: [
            { ...metadata.subtitleRenditions[0], sidecarFingerprint: "broken" },
          ],
        },
        options,
      ),
    ).toThrow(/fingerprint/);
  });

  it("accepts a well-formed manifest", () => {
    const metadata = parseAdaptiveMetadata(validMetadata());
    expect(metadata.videoRenditions[0].id).toBe("720p");
    expect(metadata.audioRenditions[0].language).toBe("eng");
    expect(metadata.source.isHdr).toBe(true);
  });

  it("rejects an unknown schema version rather than guessing at the shape", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          metadata.schemaVersion = 2;
        }),
      ),
    ).toThrow(/schemaVersion must be 1/);
  });

  it.each([
    ["../../etc/passwd", /relative path inside the package/],
    ["/etc/passwd", /relative path inside the package/],
    ["C:\\Windows\\system32", /relative path inside the package/],
    ["video/720p/../../../escape.m4s", /relative path inside the package/],
    ["video\\720p\\media.m4s", /relative path inside the package/],
  ])("rejects %s as a media path", (mediaPath, expected) => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (
            metadata.videoRenditions as Array<Record<string, unknown>>
          )[0].mediaPath = mediaPath;
        }),
      ),
    ).toThrow(expected);
  });

  it("rejects a rendition whose files are not at their canonical location", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (
            metadata.videoRenditions as Array<Record<string, unknown>>
          )[0].mediaPath = "video/480p/media.m4s";
        }),
      ),
    ).toThrow(/canonical location/);
  });

  it("rejects an unsafe rendition id", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (metadata.videoRenditions as Array<Record<string, unknown>>)[0].id =
            "../x";
        }),
      ),
    ).toThrow(/not a safe id/);
  });

  it("rejects an audio id that disagrees with its source stream index", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (
            metadata.audioRenditions as Array<Record<string, unknown>>
          )[0].sourceStreamIndex = 4;
        }),
      ),
    ).toThrow(/does not match its source stream index/);
  });

  it("rejects duplicate rendition ids", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          const renditions = metadata.videoRenditions as Array<
            Record<string, unknown>
          >;
          renditions.push({ ...renditions[0] });
        }),
      ),
    ).toThrow(/duplicate ids/);
  });

  it("requires exactly one default audio rendition", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (
            metadata.audioRenditions as Array<Record<string, unknown>>
          )[0].isDefault = false;
        }),
      ),
    ).toThrow(/exactly one audio rendition must be marked default/i);
  });

  it("rejects a storage total that does not add up", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (metadata.storage as Record<string, number>).totalBytes = 1;
        }),
      ),
    ).toThrow(/does not equal videoBytes plus audioBytes/);
  });

  it("rejects a codec string that would be unsafe inside a playlist attribute", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          (
            metadata.videoRenditions as Array<Record<string, unknown>>
          )[0].codecString = 'avc1.640028",URI="evil';
        }),
      ),
    ).toThrow(/unsafe in a playlist/);
  });

  it("rejects an empty ladder or an empty audio set", () => {
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          metadata.videoRenditions = [];
        }),
      ),
    ).toThrow(/videoRenditions must be a non-empty array/);
    expect(() =>
      parseAdaptiveMetadata(
        withMetadata((metadata) => {
          metadata.audioRenditions = [];
        }),
      ),
    ).toThrow(/audioRenditions must be a non-empty array/);
  });

  it("rejects a manifest for a different media, source or profile", () => {
    const metadata = validMetadata();
    expect(() => parseAdaptiveMetadata(metadata, { mediaId: "other" })).toThrow(
      /mediaId does not match/,
    );
    expect(() =>
      parseAdaptiveMetadata(metadata, { sourceFingerprint: "b".repeat(64) }),
    ).toThrow(/sourceFingerprint does not match/);
    expect(() =>
      parseAdaptiveMetadata(metadata, { profileVersion: "h264-aac-mp4-v2" }),
    ).toThrow(/profileVersion does not match/);
  });

  it("rejects a legacy manifest outright", () => {
    // The two generations describe incompatible things, so a legacy manifest
    // must never be accepted by the adaptive reader.
    expect(() =>
      parseAdaptiveMetadata({
        schemaVersion: 3,
        mediaId: "x",
        profileVersion: "h264-aac-mp4-v2",
        files: [],
      }),
    ).toThrow(/schemaVersion must be 1/);
  });
});

describe("parseAdaptivePointer", () => {
  it("accepts a well-formed pointer", () => {
    expect(
      parseAdaptivePointer({
        schemaVersion: 1,
        versionDirectory: `${ADAPTIVE_PROFILE_VERSION}-0123456789abcdef`,
        sourceFingerprint: FINGERPRINT,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      }).versionDirectory,
    ).toBe(`${ADAPTIVE_PROFILE_VERSION}-0123456789abcdef`);
  });

  it.each([
    ["..", "traversal"],
    ["../escape", "traversal"],
    ["a/b", "separator"],
    ["", "empty"],
  ])("rejects %s as a version directory (%s)", (versionDirectory) => {
    expect(() =>
      parseAdaptivePointer({
        schemaVersion: 1,
        versionDirectory,
        sourceFingerprint: FINGERPRINT,
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      }),
    ).toThrow(/Adaptive pointer is invalid/);
  });

  it("rejects a pointer with a malformed fingerprint", () => {
    expect(() =>
      parseAdaptivePointer({
        schemaVersion: 1,
        versionDirectory: "ok",
        sourceFingerprint: "short",
        profileVersion: ADAPTIVE_PROFILE_VERSION,
      }),
    ).toThrow(/Adaptive pointer is invalid/);
  });
});

/**
 * The master layout stamp a repair leaves behind.
 *
 * The served URL is keyed on it, so it has to survive parsing — dropped here,
 * a repaired master keeps the URL of the broken one and cached clients never
 * see the fix.
 */
describe("the master layout a package records", () => {
  it("carries the stamp through", () => {
    const parsed = parseAdaptiveMetadata({
      ...validMetadata(),
      masterLayoutVersion: 3,
    });
    expect(parsed.masterLayoutVersion).toBe(3);
  });

  it("leaves a package published before the stamp without one", () => {
    expect(parseAdaptiveMetadata(validMetadata()).masterLayoutVersion).toBe(
      undefined,
    );
  });

  it("rejects a stamp that is not a whole version", () => {
    expect(() =>
      parseAdaptiveMetadata({ ...validMetadata(), masterLayoutVersion: 0 }),
    ).toThrow(/masterLayoutVersion/);
    expect(() =>
      parseAdaptiveMetadata({ ...validMetadata(), masterLayoutVersion: 2.5 }),
    ).toThrow(/masterLayoutVersion/);
  });
});
