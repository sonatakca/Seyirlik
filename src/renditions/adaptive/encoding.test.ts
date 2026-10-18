import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_AUDIO_GROUP,
  adaptiveOutputDirectories,
  buildAdaptiveFilterComplex,
  buildAdaptivePackageFfmpegArgs,
  buildAdaptiveSampleFfmpegArgs,
  buildVarStreamMap,
  canStreamCopyAudio,
  frameMacroblocks,
  h264LevelFor,
  deliveryChannelsFor,
  MAX_DELIVERY_AUDIO_CHANNELS,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";
import { getEncodingPolicy } from "../encoding";

const LADDER: AdaptiveVideoOutput[] = [
  { qualityHeight: 480, width: 854, height: 480 },
  { qualityHeight: 720, width: 1280, height: 720 },
  { qualityHeight: 1080, width: 1920, height: 1080 },
];

const DEFAULT_AUDIO: AdaptiveAudioOutput = {
  sourceStreamIndex: 1,
  action: "transcode",
  bitrate: 192_000,
  language: "eng",
  isDefault: true,
  isForced: false,
};

function build(
  overrides: Partial<Parameters<typeof buildAdaptivePackageFfmpegArgs>[0]> = {},
) {
  return buildAdaptivePackageFfmpegArgs({
    inputPath: "/media/Movies/Example.mp4",
    outputRoot: "/work/example",
    videoOutputs: LADDER,
    audioOutputs: [DEFAULT_AUDIO],
    frameRate: 23.976,
    ...overrides,
  });
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("per-rung frame rate", () => {
  it.each(["h264_qsv", "hevc_qsv", "h264_nvenc", "hevc_nvenc"] as const)(
    "keeps %s epoch presentation time free of reorder delay",
    (encoder) => {
      const args = build({ encoder });
      for (const index of LADDER.keys())
        expect(valueAfter(args, `-bf:v:${index}`)).toBe("0");
    },
  );
  /**
   * The small rungs are halved because they exist for scarce bandwidth. The
   * conversion goes in front of the scale so the frames that will not survive
   * are discarded before they are resized rather than after.
   */
  it("drops the rate before the scale, and only where it changes", () => {
    const filter = buildAdaptiveFilterComplex({
      videoOutputs: [
        { qualityHeight: 1080, width: 1920, height: 1080 },
        { qualityHeight: 480, width: 854, height: 480, frameRate: 30 },
      ],
    });

    expect(filter).toContain("fps=30,scale=854:480");
    expect(filter).not.toContain("fps=30,scale=1920:1080");
    expect(filter.match(/fps=/g)).toHaveLength(1);
  });

  it("leaves a single-rung ladder alone when its rate matches the source", () => {
    const filter = buildAdaptiveFilterComplex({
      videoOutputs: [{ qualityHeight: 1080, width: 1920, height: 1080 }],
    });

    expect(filter).not.toContain("fps=");
  });
});

describe("QSV rate control", () => {
  /*
   * FFmpeg's QSV encoder reads a quality value with a cap and no target as
   * constant QP and ignores the cap. Mad Max's ladder came out at 3-6 times
   * its planned bitrate on every rung, an estimated 123 GB, and filled C:.
   */
  it.each([
    ["hevc_qsv", "hevc"],
    ["h264_qsv", "h264"],
    ["hevc_nvenc", "hevc"],
    ["h264_nvenc", "h264"],
  ] as const)(
    "gives every %s rung its planned bitrate as a target under its cap",
    (encoder, family) => {
      const args = build({ encoder });
      expect(args.some((arg) => arg.startsWith("-global_quality"))).toBe(false);
      for (const [index, rung] of LADDER.entries()) {
        const policy = getEncodingPolicy(rung.qualityHeight, family);
        expect(valueAfter(args, `-b:v:${index}`)).toBe(
          String(policy.expectedVideoBitrate),
        );
        expect(valueAfter(args, `-maxrate:v:${index}`)).toBe(
          String(policy.maxVideoBitrate),
        );
        // A cap above the target: equal values would select CBR instead.
        expect(policy.maxVideoBitrate).toBeGreaterThan(
          policy.expectedVideoBitrate,
        );
      }
    },
  );
});

describe("NVENC", () => {
  const HDR = {
    colorPrimaries: "bt2020",
    colorTransfer: "smpte2084",
    colorSpace: "bt2020nc",
  } as const;

  it("asks for variable bitrate explicitly rather than the preset's default", () => {
    const args = build({ encoder: "hevc_nvenc" });
    for (const index of LADDER.keys()) {
      expect(valueAfter(args, `-rc:v:${index}`)).toBe("vbr");
      expect(valueAfter(args, `-multipass:v:${index}`)).toBe("qres");
      expect(valueAfter(args, `-tune:v:${index}`)).toBe("hq");
    }
  });

  it("carries an HDR grade as Main 10 from P010 frames", () => {
    const args = build({ encoder: "hevc_nvenc", hdr: HDR });
    expect(valueAfter(args, "-profile:v:0")).toBe("main10");
    expect(valueAfter(args, "-color_trc:v:0")).toBe("smpte2084");
    expect(valueAfter(args, "-filter_complex")).toContain("format=p010le");
  });

  it("holds every rung to a fixed two-second cadence of IDR frames", () => {
    const args = build({ encoder: "h264_nvenc" });
    for (const index of LADDER.keys()) {
      expect(valueAfter(args, `-no-scenecut:v:${index}`)).toBe("1");
      expect(valueAfter(args, `-forced-idr:v:${index}`)).toBe("1");
      expect(valueAfter(args, `-profile:v:${index}`)).toBe("high");
    }
  });

  it("translates x264 preset names to NVENC's p1-p7", () => {
    expect(
      valueAfter(
        build({ encoder: "hevc_nvenc", preset: "medium" }),
        "-preset:v:0",
      ),
    ).toBe("p5");
    expect(
      valueAfter(build({ encoder: "hevc_nvenc", preset: "p6" }), "-preset:v:0"),
    ).toBe("p6");
  });
});

describe("measured rung rates", () => {
  it.each(["h264_qsv", "hevc_qsv", "h264_nvenc", "hevc_nvenc"] as const)(
    "gives %s a rung's measured rate in place of the table's",
    (encoder) => {
      const args = build({
        encoder,
        videoOutputs: [
          { ...LADDER[2]!, bitrate: { target: 3_850_000, max: 7_000_000 } },
          LADDER[1]!,
        ],
      });
      expect(valueAfter(args, "-b:v:0")).toBe("3850000");
      expect(valueAfter(args, "-maxrate:v:0")).toBe("7000000");
      expect(valueAfter(args, "-bufsize:v:0")).toBe("14000000");
      const family = encoder.startsWith("hevc") ? "hevc" : "h264";
      expect(valueAfter(args, "-b:v:1")).toBe(
        String(getEncodingPolicy(720, family).expectedVideoBitrate),
      );
    },
  );

  /*
   * The probe is only worth what it measures, so a sample must be encoded
   * with the arguments the ladder itself gets.
   */
  it("encodes a probe sample with the ladder's own encoder arguments", () => {
    const outputs = [
      { ...LADDER[2]!, bitrate: { target: 3_850_000, max: 7_000_000 } },
      LADDER[1]!,
    ];
    const ladder = build({
      encoder: "h264_qsv",
      preset: "veryfast",
      videoOutputs: outputs,
    });
    const sample = buildAdaptiveSampleFfmpegArgs({
      inputPath: "/media/Movies/Example.mp4",
      startSeconds: 600,
      durationSeconds: 10,
      outputPath: "/work/sample.mp4",
      videoOutputs: outputs,
      encoder: "h264_qsv",
      preset: "veryfast",
      frameRate: 23.976,
    });
    for (const index of outputs.keys()) {
      for (const flag of [
        "-c",
        "-preset",
        "-b",
        "-maxrate",
        "-bufsize",
        "-profile",
        "-level",
        "-bf",
        "-g",
      ]) {
        expect(valueAfter(sample, `${flag}:v:${index}`)).toBe(
          valueAfter(ladder, `${flag}:v:${index}`),
        );
      }
    }
    expect(valueAfter(sample, "-filter_complex")).toContain("trim=start=0");
    expect(sample.at(-1)).toBe("/work/sample.mp4");
  });
});

describe("buildAdaptiveFilterComplex", () => {
  it("decodes once and splits into every rendition", () => {
    const graph = buildAdaptiveFilterComplex({ videoOutputs: LADDER });

    expect(graph).toContain("[0:v:0]split=3[split0][split1][split2]");
    expect(graph).toContain(
      "[split0]scale=854:480:flags=lanczos,format=yuv420p[out0]",
    );
    expect(graph).toContain(
      "[split2]scale=1920:1080:flags=lanczos,format=yuv420p[out2]",
    );
  });

  it("skips the split when there is only one rendition", () => {
    const graph = buildAdaptiveFilterComplex({ videoOutputs: [LADDER[0]] });

    expect(graph).not.toContain("split=");
    expect(graph).toContain("[0:v:0]scale=854:480");
  });

  it("uses a 10-bit pixel format when the HDR grade is being carried through", () => {
    const graph = buildAdaptiveFilterComplex({
      videoOutputs: [LADDER[0]],
      encoder: "libx265",
      hdr: {
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
    });

    expect(graph).toContain("format=yuv420p10le");
  });

  it("rejects an empty ladder", () => {
    expect(() => buildAdaptiveFilterComplex({ videoOutputs: [] })).toThrow(
      /at least one adaptive video rendition/i,
    );
  });
});

describe("buildVarStreamMap", () => {
  it("names entries so they land in the canonical package layout", () => {
    const map = buildVarStreamMap({
      videoOutputs: LADDER,
      audioOutputs: [
        DEFAULT_AUDIO,
        {
          ...DEFAULT_AUDIO,
          sourceStreamIndex: 2,
          isDefault: false,
          language: "tur",
        },
      ],
    });

    expect(map).toContain(`v:0,agroup:${ADAPTIVE_AUDIO_GROUP},name:video/480p`);
    expect(map).toContain(
      `v:2,agroup:${ADAPTIVE_AUDIO_GROUP},name:video/1080p`,
    );
    expect(map).toContain(
      "a:0,agroup:aud,name:audio/track-1,default:yes,language:eng",
    );
    expect(map).toContain("a:1,agroup:aud,name:audio/track-2,language:tur");
  });
});

describe("adaptiveOutputDirectories", () => {
  it("lists every directory the muxer expects to already exist", () => {
    expect(
      adaptiveOutputDirectories({
        videoOutputs: LADDER,
        audioOutputs: [DEFAULT_AUDIO],
      }),
    ).toEqual(["video/480p", "video/720p", "video/1080p", "audio/track-1"]);
  });
});

describe("buildAdaptivePackageFfmpegArgs", () => {
  it("shares a software CPU budget across encoders and keeps one filter pool", () => {
    const args = build({
      encoder: "libx264",
      softwareThreads: 8,
      filterComplexThreads: 4,
    });

    expect(valueAfter(args, "-filter_complex_threads")).toBe("4");
    expect(valueAfter(args, "-threads:v:0")).toBe("3");
    expect(valueAfter(args, "-threads:v:1")).toBe("3");
    expect(valueAfter(args, "-threads:v:2")).toBe("2");
  });

  it("does not apply software thread controls to a hardware encoder", () => {
    const args = build({
      encoder: "h264_videotoolbox",
      softwareThreads: 8,
    });

    expect(args.some((argument) => argument.startsWith("-threads:v:"))).toBe(
      false,
    );
  });

  it("limits libx265's actual worker pool without losing its GOP controls", () => {
    const args = build({
      encoder: "libx265",
      videoOutputs: [LADDER[2]],
      softwareThreads: 8,
      filterComplexThreads: 4,
    });

    expect(args).not.toContain("-threads:v:0");
    expect(valueAfter(args, "-x265-params:v:0")).toBe(
      "keyint=48:min-keyint=48:scenecut=0:open-gop=0:pools=8",
    );
  });

  it("forces a two-second closed GOP on every rendition, not just the first", () => {
    const args = build();

    // A `-force_key_frames` without a stream specifier only reaches the first
    // video output, which would leave the rest of the ladder unaligned.
    for (const ordinal of [0, 1, 2]) {
      expect(args).toContain(`-force_key_frames:v:${ordinal}`);
      expect(valueAfter(args, `-force_key_frames:v:${ordinal}`)).toBe(
        "expr:gte(t,n_forced*2)",
      );
      expect(valueAfter(args, `-g:v:${ordinal}`)).toBe("48");
      expect(valueAfter(args, `-flags:v:${ordinal}`)).toBe("+cgop");
      expect(valueAfter(args, `-sc_threshold:v:${ordinal}`)).toBe("0");
      expect(valueAfter(args, `-keyint_min:v:${ordinal}`)).toBe("48");
      expect(valueAfter(args, `-forced-idr:v:${ordinal}`)).toBe("1");
    }
  });

  it.each([
    [23.976, "48"],
    [24, "48"],
    [25, "50"],
    [59.94, "120"],
  ])(
    "derives the GOP length from %s fps as %s frames",
    (frameRate, expected) => {
      const args = build({ frameRate });
      expect(valueAfter(args, "-g:v:0")).toBe(expected);
    },
  );

  it("produces video-only variants", () => {
    const args = build();

    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
    // Audio is mapped once for the whole package, never per video variant.
    expect(args.filter((argument) => argument === "-map").length).toBe(4);
    expect(args.filter((argument) => argument.startsWith("0:1")).length).toBe(
      1,
    );
  });

  it("shares one audio rendition across every video variant", () => {
    const args = build();

    expect(valueAfter(args, "-var_stream_map")).toBe(
      "v:0,agroup:aud,name:video/480p v:1,agroup:aud,name:video/720p v:2,agroup:aud,name:video/1080p a:0,agroup:aud,name:audio/track-1,default:yes,language:eng",
    );
    expect(valueAfter(args, "-c:a:0")).toBe("aac");
    expect(valueAfter(args, "-b:a:0")).toBe("192000");
    expect(valueAfter(args, "-ar:a:0")).toBe("48000");
  });

  it("encodes a stereo source at its own channel count", () => {
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, channels: 2 }],
    });

    expect(valueAfter(args, "-ac:a:0")).toBe("2");
  });

  it("downmixes a 7.1 source to a layout every engine decodes", () => {
    // ffmpeg's 7.1 layout is AAC channelConfiguration 12, which Chromium's MSE
    // parser rejects outright with CHUNK_DEMUXER_ERROR_APPEND_FAILED.
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, channels: 8, bitrate: 256_000 }],
    });

    expect(valueAfter(args, "-ac:a:0")).toBe("2");
  });

  it("downmixes a 5.1 source too", () => {
    // 5.1 gets past the parser but is not decoded reliably by every shipping
    // Chrome, and one shared ladder cannot carry a layout any client refuses.
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, channels: 6, bitrate: 256_000 }],
    });

    expect(valueAfter(args, "-ac:a:0")).toBe("2");
  });

  it("leaves a mono source mono rather than upmixing it", () => {
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, channels: 1 }],
    });

    expect(valueAfter(args, "-ac:a:0")).toBe("1");
  });

  it("never leaves the encoder to inherit an unknown source layout", () => {
    const args = build({ audioOutputs: [DEFAULT_AUDIO] });

    expect(valueAfter(args, "-ac:a:0")).toBe("2");
  });

  it("stream-copies audio when the source is already browser-compatible", () => {
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, action: "copy" }],
    });

    expect(valueAfter(args, "-c:a:0")).toBe("copy");
    expect(args).not.toContain("-b:a:0");
  });

  it("carries language, title and disposition through to each audio rendition", () => {
    const args = build({
      audioOutputs: [
        { ...DEFAULT_AUDIO, title: "Director commentary" },
        {
          sourceStreamIndex: 2,
          action: "transcode",
          bitrate: 256_000,
          language: "tur",
          isDefault: false,
          isForced: true,
        },
      ],
    });

    expect(args).toContain("language=eng");
    expect(args).toContain("title=Director commentary");
    expect(args).toContain("language=tur");
    expect(valueAfter(args, "-disposition:a:0")).toBe("default");
    expect(valueAfter(args, "-disposition:a:1")).toBe("forced");
  });

  it("writes single-file byte-range CMAF with independent segments", () => {
    const args = build();

    expect(valueAfter(args, "-hls_segment_type")).toBe("fmp4");
    expect(valueAfter(args, "-hls_flags")).toBe(
      "single_file+independent_segments",
    );
    expect(valueAfter(args, "-hls_time")).toBe("2");
    expect(valueAfter(args, "-hls_playlist_type")).toBe("vod");
    expect(valueAfter(args, "-hls_segment_filename")).toBe(
      "/work/example/%v/media.m4s",
    );
    expect(args.at(-1)).toBe("/work/example/%v/playlist.m3u8");
  });

  it("tags HEVC output as hvc1 and writes the HDR colour signal per rendition", () => {
    const args = build({
      encoder: "libx265",
      videoOutputs: [LADDER[0], LADDER[1]],
      hdr: {
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
    });

    for (const ordinal of [0, 1]) {
      // Safari refuses hev1-tagged media outright.
      expect(valueAfter(args, `-tag:v:${ordinal}`)).toBe("hvc1");
      expect(valueAfter(args, `-color_trc:v:${ordinal}`)).toBe("smpte2084");
      expect(valueAfter(args, `-color_primaries:v:${ordinal}`)).toBe("bt2020");
      expect(valueAfter(args, `-colorspace:v:${ordinal}`)).toBe("bt2020nc");
      expect(valueAfter(args, `-x265-params:v:${ordinal}`)).toContain(
        "scenecut=0",
      );
    }
  });

  it("uses Apple VideoToolbox without unsupported preset options", () => {
    const args = build({
      encoder: "hevc_videotoolbox",
      videoOutputs: [LADDER[1]],
      hdr: {
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
    });

    expect(valueAfter(args, "-c:v:0")).toBe("hevc_videotoolbox");
    expect(valueAfter(args, "-profile:v:0")).toBe("main10");
    expect(valueAfter(args, "-tag:v:0")).toBe("hvc1");
    expect(args.join(" ")).toContain("format=p010le");
    expect(args).not.toContain("-preset:v:0");
    expect(args).not.toContain("-crf:v:0");
  });

  it("does not tag H.264 output as hvc1", () => {
    expect(build()).not.toContain("-tag:v:0");
  });

  it("refuses to preserve HDR on an H.264 encoder", () => {
    expect(() =>
      build({
        encoder: "libx264",
        hdr: {
          colorPrimaries: "bt2020",
          colorTransfer: "smpte2084",
          colorSpace: "bt2020nc",
        },
      }),
    ).toThrow(/no browser decodes 10-bit H.264/i);
  });

  it("requires exactly one default audio rendition when audio is encoded", () => {
    expect(() =>
      build({
        audioOutputs: [
          DEFAULT_AUDIO,
          { ...DEFAULT_AUDIO, sourceStreamIndex: 2 },
        ],
      }),
    ).toThrow(/exactly one adaptive audio rendition must be default/i);
  });

  /**
   * One invocation is not one package.
   *
   * These arguments used to insist on both video and audio, which assumed
   * every run builds a complete package. Once work is planned per rendition
   * that is wrong in both directions — adding a rung to a title whose audio is
   * already published is a video-only run — and refusing it would force the
   * caller back to rebuilding the whole ladder.
   */
  it("accepts a run that produces only video, or only audio", () => {
    expect(() => build({ audioOutputs: [] })).not.toThrow();
    expect(() => build({ videoOutputs: [] })).not.toThrow();
    expect(() => build({ videoOutputs: [], audioOutputs: [] })).toThrow(
      /at least one video or audio rendition/i,
    );
  });
});

describe("canStreamCopyAudio", () => {
  it("copies plain stereo AAC-LC", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toBe(true);
  });

  it("re-encodes anything that is not AAC", () => {
    for (const codec of ["ac3", "eac3", "dts", "truehd", "opus"]) {
      expect(canStreamCopyAudio({ codec, channels: 2 })).toBe(false);
    }
  });

  it("re-encodes HE-AAC, whose implicit signalling survives a remux badly", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "HE-AAC",
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toBe(false);
  });

  it("re-encodes multichannel AAC rather than narrowing who can play the ladder", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 48_000,
        channels: 6,
      }),
    ).toBe(false);
  });

  it("re-encodes unusual sample rates", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 22_050,
        channels: 2,
      }),
    ).toBe(false);
  });
});

describe("deliveryChannelsFor", () => {
  it("caps every multichannel layout at the universally decodable one", () => {
    expect(deliveryChannelsFor(6)).toBe(MAX_DELIVERY_AUDIO_CHANNELS);
    expect(deliveryChannelsFor(7)).toBe(MAX_DELIVERY_AUDIO_CHANNELS);
    expect(deliveryChannelsFor(8)).toBe(MAX_DELIVERY_AUDIO_CHANNELS);
    expect(deliveryChannelsFor(12)).toBe(MAX_DELIVERY_AUDIO_CHANNELS);
  });

  it("passes layouts at or below the cap through untouched", () => {
    expect(deliveryChannelsFor(1)).toBe(1);
    expect(deliveryChannelsFor(2)).toBe(2);
  });

  it("falls back to stereo when the source channel count is unusable", () => {
    expect(deliveryChannelsFor(undefined)).toBe(2);
    expect(deliveryChannelsFor(0)).toBe(2);
    expect(deliveryChannelsFor(-1)).toBe(2);
    expect(deliveryChannelsFor(2.5)).toBe(2);
  });
});

describe("h264LevelFor", () => {
  /**
   * The bug this exists to prevent: a rung is named for its height, but its
   * width comes from the source aspect ratio. Naming the level after the rung
   * gave every 16:9 title a 480p rung at level 3.0, which VideoToolbox refuses
   * to open an encoder for, while letterboxed sources happened to fit and
   * packaged fine.
   */
  it("gives a 16:9 480p rung more room than level 3.0", () => {
    expect(frameMacroblocks(854, 480)).toBe(1620);
    expect(h264LevelFor(854, 480, 23.976)).toBe("3.1");
  });

  it("keeps a letterboxed 480p rung at level 3.0", () => {
    expect(frameMacroblocks(854, 356)).toBe(1242);
    expect(h264LevelFor(854, 356, 23.976)).toBe("3.0");
  });

  it("never sits exactly at a level's frame-size ceiling", () => {
    // At exactly MaxFS the hardware encoder has no headroom for reference
    // frames and rejects the configuration outright.
    expect(h264LevelFor(1280, 720, 23.976)).not.toBe("3.1");
    expect(h264LevelFor(640, 480, 23.976)).toBe("3.0");
  });

  it("scales up with the frame", () => {
    expect(h264LevelFor(1920, 800, 23.976)).toBe("4.0");
    expect(h264LevelFor(1920, 1080, 23.976)).toBe("4.0");
    expect(h264LevelFor(3840, 2160, 23.976)).toBe("5.1");
  });

  it("accounts for frame rate, not only frame size", () => {
    // 1920x1080 at 60fps needs more macroblocks per second than level 4.0
    // allows, even though the frame itself fits.
    expect(h264LevelFor(1920, 1080, 60)).toBe("4.2");
  });

  it("assumes a safe frame rate when the source does not report one", () => {
    expect(h264LevelFor(854, 480, undefined)).toBe("3.1");
    expect(h264LevelFor(854, 480, 0)).toBe("3.1");
  });
});
