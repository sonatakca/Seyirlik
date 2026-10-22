import { describe, expect, it } from "vitest";
import {
  buildMasterPlaylist,
  parseCodecsFromGeneratedMaster,
  parseMasterPlaylist,
  parseMediaPlaylist,
  uniqueRenditionNames,
} from "./playlist";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";

it("permits a subtitle-only scratch master only with an explicit incremental option", () => {
  const input = {
    videoRenditions: [],
    audioRenditions: [],
    subtitleRenditions: [
      {
        id: "subtitle-1000",
        sourceStreamIndex: 1000,
        language: "tur",
        isDefault: false,
        isForced: false,
        isHearingImpaired: false,
        codec: "webvtt" as const,
        durationSeconds: 10,
        playlistPath: "subtitles/subtitle-1000/playlist.m3u8",
        subtitlePath: "subtitles/subtitle-1000/subtitles.vtt",
        fileSizeBytes: 100,
      },
    ],
    videoCodecStrings: new Map<string, string>(),
    audioCodecStrings: new Map<string, string>(),
  };
  expect(() => buildMasterPlaylist(input)).toThrow(/at least one video/);
  const master = buildMasterPlaylist({ ...input, allowMissingVideo: true });
  expect(() => parseMasterPlaylist(master)).toThrow(/no variants/);
  expect(
    parseMasterPlaylist(master, { allowMissingVideo: true }).subtitleRenditions,
  ).toHaveLength(1);
  expect(() =>
    buildMasterPlaylist({
      ...input,
      subtitleRenditions: [],
      allowMissingVideo: true,
    }),
  ).toThrow(/at least one rendition/);
});

const MEDIA_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:2",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  '#EXT-X-MAP:URI="media.m4s",BYTERANGE="845@0"',
  "#EXTINF:2.000000,",
  "#EXT-X-BYTERANGE:80769@845",
  "media.m4s",
  "#EXTINF:2.000000,",
  "#EXT-X-BYTERANGE:77608@81614",
  "media.m4s",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

function videoRendition(
  overrides: Partial<AdaptiveVideoRenditionMetadata> = {},
): AdaptiveVideoRenditionMetadata {
  return {
    id: "720p",
    qualityHeight: 720,
    width: 1280,
    height: 720,
    codec: "h264",
    codecString: "avc1.640028",
    pixelFormat: "yuv420p",
    hdr: "sdr",
    frameRate: 23.976,
    averageBitrate: 3_000_000,
    peakBitrate: 3_400_000,
    durationSeconds: 120,
    playlistPath: "video/720p/playlist.m3u8",
    mediaPath: "video/720p/media.m4s",
    fileSizeBytes: 45_000_000,
    keyframeCount: 60,
    keyframeIntervalSeconds: { target: 2, minimum: 2, maximum: 2, mean: 2 },
    segmentCount: 60,
    ...overrides,
  };
}

function audioRendition(
  overrides: Partial<AdaptiveAudioRenditionMetadata> = {},
): AdaptiveAudioRenditionMetadata {
  return {
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
    durationSeconds: 120,
    playlistPath: "audio/track-1/playlist.m3u8",
    mediaPath: "audio/track-1/media.m4s",
    fileSizeBytes: 2_880_000,
    streamCopied: false,
    ...overrides,
  };
}

describe("parseMediaPlaylist", () => {
  it("reads the initialization range and every segment range", () => {
    const playlist = parseMediaPlaylist(MEDIA_PLAYLIST);

    expect(playlist.map).toEqual({
      uri: "media.m4s",
      byteRange: { length: 845, offset: 0 },
    });
    expect(playlist.segments).toEqual([
      {
        durationSeconds: 2,
        uri: "media.m4s",
        byteRange: { length: 80_769, offset: 845 },
      },
      {
        durationSeconds: 2,
        uri: "media.m4s",
        byteRange: { length: 77_608, offset: 81_614 },
      },
    ]);
    expect(playlist.independentSegments).toBe(true);
    expect(playlist.totalDurationSeconds).toBe(4);
  });

  it("infers an omitted byte-range offset from the previous segment's end", () => {
    const playlist = parseMediaPlaylist(
      MEDIA_PLAYLIST.replace(
        "#EXT-X-BYTERANGE:77608@81614",
        "#EXT-X-BYTERANGE:77608",
      ),
    );

    expect(playlist.segments[1].byteRange).toEqual({
      length: 77_608,
      offset: 81_614,
    });
  });

  it("rejects a playlist that does not start with #EXTM3U", () => {
    expect(() => parseMediaPlaylist("#EXT-X-VERSION:7\n")).toThrow(/#EXTM3U/);
  });

  it("rejects a segment with no byte range, which single-file packaging requires", () => {
    const withoutRange = MEDIA_PLAYLIST.replace(
      "#EXT-X-BYTERANGE:80769@845\n",
      "",
    );
    expect(() => parseMediaPlaylist(withoutRange)).toThrow(/#EXT-X-BYTERANGE/);
  });

  it("rejects a playlist with no initialization map", () => {
    const withoutMap = MEDIA_PLAYLIST.replace(
      '#EXT-X-MAP:URI="media.m4s",BYTERANGE="845@0"\n',
      "",
    );
    expect(() => parseMediaPlaylist(withoutMap)).toThrow(/#EXT-X-MAP/);
  });

  it("rejects an unterminated playlist", () => {
    expect(() =>
      parseMediaPlaylist(MEDIA_PLAYLIST.replace("#EXT-X-ENDLIST\n", "")),
    ).toThrow(/#EXT-X-ENDLIST/);
  });

  it("rejects a discontinuity, which an aligned switching set must never contain", () => {
    const withDiscontinuity = MEDIA_PLAYLIST.replace(
      "#EXTINF:2.000000,\n#EXT-X-BYTERANGE:77608@81614",
      "#EXT-X-DISCONTINUITY\n#EXTINF:2.000000,\n#EXT-X-BYTERANGE:77608@81614",
    );
    expect(() => parseMediaPlaylist(withDiscontinuity)).toThrow(
      /DISCONTINUITY/,
    );
  });

  it("rejects a tag it does not understand rather than skipping it", () => {
    const withUnknown = MEDIA_PLAYLIST.replace(
      "#EXT-X-ENDLIST",
      "#EXT-X-KEY:METHOD=AES-128\n#EXT-X-ENDLIST",
    );
    expect(() => parseMediaPlaylist(withUnknown)).toThrow(
      /Unsupported playlist tag/,
    );
  });

  it("rejects a malformed byte range", () => {
    expect(() =>
      parseMediaPlaylist(MEDIA_PLAYLIST.replace("80769@845", "-1@845")),
    ).toThrow(/malformed/);
  });

  it("rejects a non-positive EXTINF", () => {
    expect(() =>
      parseMediaPlaylist(
        MEDIA_PLAYLIST.replace("#EXTINF:2.000000,", "#EXTINF:0,"),
      ),
    ).toThrow(/positive duration/);
  });
});

describe("parseCodecsFromGeneratedMaster", () => {
  it("keys FFmpeg's bitstream-derived codec strings by variant path", () => {
    const codecs = parseCodecsFromGeneratedMaster(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        '#EXT-X-STREAM-INF:BANDWIDTH=259824,CODECS="avc1.640028,mp4a.40.2"',
        "video/480p/playlist.m3u8",
        "",
        '#EXT-X-STREAM-INF:BANDWIDTH=360504,CODECS="avc1.64001f,mp4a.40.2"',
        "video/720p/playlist.m3u8",
      ].join("\n"),
    );

    expect(codecs.get("video/480p/playlist.m3u8")).toBe(
      "avc1.640028,mp4a.40.2",
    );
    expect(codecs.get("video/720p/playlist.m3u8")).toBe(
      "avc1.64001f,mp4a.40.2",
    );
  });
});

describe("buildMasterPlaylist", () => {
  it("signals retained WebVTT renditions and preserves forced metadata", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [audioRendition()],
      subtitleRenditions: [
        {
          id: "subtitle-7",
          sourceStreamIndex: 7,
          language: "eng",
          title: "English Forced",
          isDefault: false,
          isForced: true,
          isHearingImpaired: false,
          codec: "webvtt",
          durationSeconds: 32.4,
          playlistPath: "subtitles/subtitle-7/playlist.m3u8",
          subtitlePath: "subtitles/subtitle-7/subtitles.vtt",
          fileSizeBytes: 128,
        },
      ],
      videoCodecStrings: new Map([["720p", "avc1.64001f"]]),
      audioCodecStrings: new Map([["track-1", "mp4a.40.2"]]),
    });

    expect(master).toContain("TYPE=SUBTITLES");
    expect(master).toContain("FORCED=YES");
    expect(master).toContain('SUBTITLES="seyirlik-subtitles"');
    expect(parseMasterPlaylist(master).subtitleRenditions).toEqual([
      expect.objectContaining({ language: "eng", isForced: true }),
    ]);
  });
  const videoCodecStrings = new Map([
    ["480p", "avc1.64001e"],
    ["720p", "avc1.640028"],
  ]);
  const audioCodecStrings = new Map([["track-1", "mp4a.40.2"]]);

  it("advertises measured bandwidth with the audio a variant is paired with", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [audioRendition()],
      videoCodecStrings,
      audioCodecStrings,
    });

    // Advertising the video rate alone makes every rung look cheaper than it is,
    // which is how an ABR ladder settles one rung too high and then stalls.
    expect(master).toContain("BANDWIDTH=3592000");
    expect(master).toContain("AVERAGE-BANDWIDTH=3192000");
  });

  it("carries resolution, frame rate, codecs and the audio group", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [audioRendition()],
      videoCodecStrings,
      audioCodecStrings,
    });

    expect(master).toContain("RESOLUTION=1280x720");
    expect(master).toContain("FRAME-RATE=23.976");
    expect(master).toContain('CODECS="avc1.640028,mp4a.40.2"');
    expect(master).toContain('AUDIO="aud"');
    expect(master).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
    expect(master).toContain("video/720p/playlist.m3u8");
  });

  it("orders variants from the cheapest rung upwards", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [
        videoRendition(),
        videoRendition({
          id: "480p",
          qualityHeight: 480,
          width: 854,
          height: 480,
          codecString: "avc1.64001e",
          averageBitrate: 1_200_000,
          peakBitrate: 1_400_000,
          playlistPath: "video/480p/playlist.m3u8",
          mediaPath: "video/480p/media.m4s",
        }),
      ],
      audioRenditions: [audioRendition()],
      videoCodecStrings,
      audioCodecStrings,
    });

    /*
     * 720p leads because a native player starts on whatever is listed first,
     * before it has measured anything. The rest still ascend behind it.
     */
    expect(master.indexOf("video/720p/playlist.m3u8")).toBeLessThan(
      master.indexOf("video/480p/playlist.m3u8"),
    );
  });

  /**
   * The regression this guards: the ladder was listed purely cheapest-first, so
   * Safari and every other native player opened each title on the smallest rung
   * and only crawled up from there. hls.js chooses by `startLevel` and ignores
   * order, which is why this was invisible in Chrome.
   */
  it("leads with a rung a player can open on, then ascends", () => {
    const rung = (height: number, bitrate: number) =>
      videoRendition({
        id: `${height}p`,
        qualityHeight: height,
        width: Math.round((height * 16) / 9),
        height,
        codecString: "avc1.64001e",
        averageBitrate: bitrate,
        peakBitrate: bitrate * 1.2,
        playlistPath: `video/${height}p/playlist.m3u8`,
        mediaPath: `video/${height}p/media.m4s`,
      });

    const master = buildMasterPlaylist({
      videoRenditions: [
        rung(144, 180_000),
        rung(360, 700_000),
        rung(720, 3_000_000),
        rung(1080, 5_500_000),
      ],
      audioRenditions: [audioRendition()],
      videoCodecStrings: new Map([
        ["144p", "avc1.64001e"],
        ["360p", "avc1.64001e"],
        ["720p", "avc1.64001e"],
        ["1080p", "avc1.64001e"],
      ]),
      audioCodecStrings,
    });

    const order = ["144p", "360p", "720p", "1080p"].map((id) => ({
      id,
      at: master.indexOf(`video/${id}/playlist.m3u8`),
    }));
    const first = [...order].sort((a, b) => a.at - b.at)[0];
    expect(first.id).toBe("720p");

    // Everything after the opener still climbs, so a player walking the list
    // sees a normal ladder.
    const rest = order.filter((entry) => entry.id !== "720p");
    expect(rest.map((entry) => entry.at)).toEqual(
      [...rest].sort((a, b) => a.at - b.at).map((entry) => entry.at),
    );
  });

  /** With nothing at or below the opening ceiling, the smallest rung leads. */
  it("falls back to the smallest rung when none is small enough to open on", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [
        videoRendition({
          id: "2160p",
          qualityHeight: 2160,
          width: 3840,
          height: 2160,
          codecString: "avc1.640033",
          averageBitrate: 12_000_000,
          peakBitrate: 20_000_000,
          playlistPath: "video/2160p/playlist.m3u8",
          mediaPath: "video/2160p/media.m4s",
        }),
      ],
      audioRenditions: [audioRendition()],
      videoCodecStrings: new Map([["2160p", "avc1.640033"]]),
      audioCodecStrings,
    });

    expect(master).toContain("video/2160p/playlist.m3u8");
  });

  it("signals HDR renditions as PQ and HLG rather than SDR", () => {
    for (const [hdr, expected] of [
      ["hdr10", "PQ"],
      ["hlg", "HLG"],
      ["sdr", "SDR"],
    ] as const) {
      const master = buildMasterPlaylist({
        videoRenditions: [videoRendition({ hdr })],
        audioRenditions: [audioRendition()],
        videoCodecStrings,
        audioCodecStrings,
      });
      expect(master).toContain(`VIDEO-RANGE=${expected}`);
    }
  });

  it("lists every audio rendition, marking exactly one default", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [
        audioRendition(),
        audioRendition({
          id: "track-2",
          sourceStreamIndex: 2,
          language: "tur",
          isDefault: false,
          playlistPath: "audio/track-2/playlist.m3u8",
          mediaPath: "audio/track-2/media.m4s",
        }),
      ],
      videoCodecStrings,
      audioCodecStrings: new Map([
        ["track-1", "mp4a.40.2"],
        ["track-2", "mp4a.40.2"],
      ]),
    });

    expect(master).toContain('LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES');
    expect(master).toContain('LANGUAGE="tur",DEFAULT=NO,AUTOSELECT=NO');
    expect(master).toContain('URI="audio/track-2/playlist.m3u8"');
  });

  it("strips quotes and newlines out of a source-supplied track title", () => {
    // Titles come from source metadata, and a quoted-string attribute has no
    // escape sequence for either character.
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [
        audioRendition({ title: 'Commentary" ,URI="evil.m3u8' }),
      ],
      videoCodecStrings,
      audioCodecStrings,
    });

    const mediaLine = master
      .split("\n")
      .find((line) => line.startsWith("#EXT-X-MEDIA:")) as string;

    // The injected quote is what would have closed NAME early and let the rest
    // of the title be read as further attributes, so the test that matters is
    // that the tag still declares exactly one URI, and that it is the real one.
    expect(mediaLine.match(/URI="/g)).toHaveLength(1);
    expect(parseMasterPlaylist(master).audioRenditions[0].uri).toBe(
      "audio/track-1/playlist.m3u8",
    );
    expect(mediaLine).toContain('NAME="Commentary  ,URI= evil.m3u8"');
  });

  it("refuses to advertise a rendition whose codec string was never measured", () => {
    expect(() =>
      buildMasterPlaylist({
        videoRenditions: [videoRendition()],
        audioRenditions: [audioRendition()],
        videoCodecStrings: new Map(),
        audioCodecStrings,
      }),
    ).toThrow(/no codec string was measured/i);
  });
});

describe("parseMasterPlaylist", () => {
  it("round-trips a generated master", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [audioRendition()],
      videoCodecStrings: new Map([["720p", "avc1.640028"]]),
      audioCodecStrings: new Map([["track-1", "mp4a.40.2"]]),
    });
    const parsed = parseMasterPlaylist(master);

    expect(parsed.independentSegments).toBe(true);
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants[0]).toMatchObject({
      uri: "video/720p/playlist.m3u8",
      resolution: { width: 1280, height: 720 },
      frameRate: 23.976,
      videoRange: "SDR",
      audioGroup: "aud",
    });
    expect(parsed.audioRenditions[0]).toMatchObject({
      groupId: "aud",
      language: "eng",
      isDefault: true,
      uri: "audio/track-1/playlist.m3u8",
    });
  });

  it("rejects a master with no variants", () => {
    expect(() => parseMasterPlaylist("#EXTM3U\n#EXT-X-VERSION:7\n")).toThrow(
      /no variants/,
    );
  });

  it("rejects a variant with no BANDWIDTH or CODECS", () => {
    expect(() =>
      parseMasterPlaylist(
        ["#EXTM3U", "#EXT-X-STREAM-INF:RESOLUTION=1280x720", "a.m3u8"].join(
          "\n",
        ),
      ),
    ).toThrow(/BANDWIDTH and CODECS/);
  });
});

/**
 * A group whose renditions share a NAME.
 *
 * A title with several English subtitle tracks has only the language to name
 * them by, so every one of them came out as "eng". RFC 8216 §4.3.4.1 requires
 * the names in a group to differ, and a client that enforces it stops after
 * reading the master without saying why.
 */
describe("naming renditions inside one group", () => {
  it("leaves names that are already distinct alone", () => {
    expect(uniqueRenditionNames(["eng", "tur", "fra"])).toEqual([
      "eng",
      "tur",
      "fra",
    ]);
  });

  it("separates repeated names", () => {
    expect(uniqueRenditionNames(["eng", "eng", "eng"])).toEqual([
      "eng",
      "eng 2",
      "eng 3",
    ]);
  });

  /**
   * Audio tracks are matched to source streams by the leading word of their
   * label, so the suffix has to stay out of it.
   */
  it("keeps the language as the first word", () => {
    for (const name of uniqueRenditionNames(["eng", "eng"])) {
      expect(name.split(" ")[0]).toBe("eng");
    }
  });

  /** A suffix must not collide with a name that already ends in one. */
  it("does not reuse a name a later rendition already carries", () => {
    expect(uniqueRenditionNames(["eng", "eng 2", "eng"])).toEqual([
      "eng",
      "eng 2",
      "eng 3",
    ]);
  });

  it("gives a master's subtitle group distinct names end to end", () => {
    const master = buildMasterPlaylist({
      videoRenditions: [videoRendition()],
      audioRenditions: [audioRendition()],
      subtitleRenditions: [1, 2, 3].map((index) => ({
        id: `subtitle-${index}`,
        sourceStreamIndex: index,
        language: "eng",
        isDefault: false,
        isForced: false,
        isHearingImpaired: false,
        codec: "webvtt" as const,
        durationSeconds: 32.4,
        playlistPath: `subtitles/subtitle-${index}/playlist.m3u8`,
        subtitlePath: `subtitles/subtitle-${index}/subtitles.vtt`,
        fileSizeBytes: 128,
      })),
      videoCodecStrings: new Map([["720p", "avc1.64001f"]]),
      audioCodecStrings: new Map([["track-1", "mp4a.40.2"]]),
    });

    const names = [
      ...master.matchAll(/TYPE=SUBTITLES[^\n]*NAME="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });
});
