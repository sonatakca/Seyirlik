import { spawn } from "node:child_process";

export type RenditionCodecFamily = "h264" | "hevc";
export type RenditionVideoEncoder =
  | "libx264"
  | "h264_qsv"
  | "h264_videotoolbox"
  | "h264_nvenc"
  | "libx265"
  | "hevc_qsv"
  | "hevc_videotoolbox"
  | "hevc_nvenc";
export type RenditionEncoderPreference =
  | "auto"
  | "qsv"
  | "videotoolbox"
  | "software";
/**
 * `preserve` keeps an HDR master in HDR, which forces HEVC Main 10 because no
 * browser decodes 10-bit H.264. `tonemap` converts to SDR H.264 instead, which
 * plays everywhere but discards the HDR grade.
 */
export type RenditionHdrPolicy = "preserve" | "tonemap";

export interface RenditionEncodingPolicy {
  crf: number;
  /**
   * QuickSync ICQ quality. QSV is less efficient per bit than the software
   * encoders at the same nominal quality, so each class sits a couple of steps
   * tighter to land on comparable output sizes.
   */
  globalQuality: number;
  /** Hard rate cap handed to the encoder; only busy scenes ever reach it. */
  maxVideoBitrate: number;
  /**
   * Typical output rate for live-action content at this quality class. Storage
   * planning uses this rather than `maxVideoBitrate`, which would roughly double
   * every estimate and defer titles that comfortably fit. The processor still
   * re-checks real free space before every title, so an optimistic plan can
   * never overfill the drive.
   */
  expectedVideoBitrate: number;
  audioBitrate: number;
}

/**
 * HEVC is roughly 35-45% more efficient than H.264, but HDR10 carries a 10-bit
 * wider-gamut signal, so the saving is spent on the extra precision rather than
 * banked. Rates therefore land close to the SDR H.264 ladder.
 */
const ENCODING_POLICY: Record<
  RenditionCodecFamily,
  Record<number, RenditionEncodingPolicy>
> = {
  h264: {
    4320: {
      crf: 22,
      globalQuality: 24,
      maxVideoBitrate: 100_000_000,
      expectedVideoBitrate: 50_000_000,
      audioBitrate: 384_000,
    },
    2160: {
      crf: 21,
      globalQuality: 23,
      maxVideoBitrate: 40_000_000,
      expectedVideoBitrate: 20_000_000,
      audioBitrate: 384_000,
    },
    1440: {
      crf: 20,
      globalQuality: 22,
      maxVideoBitrate: 20_000_000,
      expectedVideoBitrate: 10_000_000,
      audioBitrate: 384_000,
    },
    1080: {
      crf: 20,
      globalQuality: 22,
      maxVideoBitrate: 10_000_000,
      expectedVideoBitrate: 5_500_000,
      audioBitrate: 384_000,
    },
    720: {
      crf: 21,
      globalQuality: 23,
      maxVideoBitrate: 5_000_000,
      expectedVideoBitrate: 3_000_000,
      audioBitrate: 256_000,
    },
    480: {
      crf: 22,
      globalQuality: 24,
      maxVideoBitrate: 2_500_000,
      expectedVideoBitrate: 1_400_000,
      audioBitrate: 192_000,
    },
    360: {
      crf: 23,
      globalQuality: 25,
      maxVideoBitrate: 1_200_000,
      expectedVideoBitrate: 700_000,
      audioBitrate: 128_000,
    },
    240: {
      crf: 24,
      globalQuality: 26,
      maxVideoBitrate: 600_000,
      expectedVideoBitrate: 350_000,
      audioBitrate: 96_000,
    },
    144: {
      crf: 26,
      globalQuality: 28,
      maxVideoBitrate: 300_000,
      expectedVideoBitrate: 180_000,
      audioBitrate: 64_000,
    },
  },
  hevc: {
    4320: {
      crf: 25,
      globalQuality: 27,
      maxVideoBitrate: 60_000_000,
      expectedVideoBitrate: 30_000_000,
      audioBitrate: 384_000,
    },
    2160: {
      crf: 24,
      globalQuality: 26,
      maxVideoBitrate: 25_000_000,
      expectedVideoBitrate: 12_000_000,
      audioBitrate: 384_000,
    },
    1440: {
      crf: 23,
      globalQuality: 25,
      maxVideoBitrate: 18_000_000,
      expectedVideoBitrate: 9_000_000,
      audioBitrate: 384_000,
    },
    1080: {
      crf: 22,
      globalQuality: 24,
      maxVideoBitrate: 12_000_000,
      expectedVideoBitrate: 6_000_000,
      audioBitrate: 384_000,
    },
    720: {
      crf: 23,
      globalQuality: 25,
      maxVideoBitrate: 6_000_000,
      expectedVideoBitrate: 3_200_000,
      audioBitrate: 256_000,
    },
    480: {
      crf: 24,
      globalQuality: 26,
      maxVideoBitrate: 3_000_000,
      expectedVideoBitrate: 1_600_000,
      audioBitrate: 192_000,
    },
    360: {
      crf: 25,
      globalQuality: 27,
      maxVideoBitrate: 900_000,
      expectedVideoBitrate: 500_000,
      audioBitrate: 128_000,
    },
    240: {
      crf: 26,
      globalQuality: 28,
      maxVideoBitrate: 450_000,
      expectedVideoBitrate: 260_000,
      audioBitrate: 96_000,
    },
    144: {
      crf: 28,
      globalQuality: 30,
      maxVideoBitrate: 220_000,
      expectedVideoBitrate: 130_000,
      audioBitrate: 64_000,
    },
  },
};

/**
 * PQ/HLG to SDR BT.709, used only when the HDR policy is `tonemap`. Without this
 * an HDR master is simply truncated to 8-bit BT.709 and the result looks grey
 * and desaturated. `npl=100` targets a 100-nit SDR display and Hable keeps
 * highlight roll-off gentle. Needs libzimg.
 */
const HDR_TO_SDR_FILTER = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
].join(",");

export interface RenditionHdrSignal {
  colorPrimaries: string;
  colorTransfer: string;
  colorSpace: string;
}

export interface RenditionOutputRequest {
  /** Standard quality class (1080/720/480) that selects the rate policy. */
  qualityHeight: number;
  /** Actual encoded pixel dimensions, preserving the source aspect ratio. */
  width: number;
  height: number;
  outputPath: string;
}

export interface RenditionEncodingInput {
  inputPath: string;
  /** Every rendition produced from a single decode of the source. */
  outputs: RenditionOutputRequest[];
  audioStreamIndex: number;
  audioLanguage?: string;
  encoder?: RenditionVideoEncoder;
  /** Present when the HDR grade is being carried through to the output. */
  hdr?: RenditionHdrSignal;
  /** Set when a PQ/HLG source is being converted down to SDR instead. */
  tonemapHdr?: boolean;
  preset?: string;
}

export function codecFamilyForEncoder(
  encoder: RenditionVideoEncoder,
): RenditionCodecFamily {
  return encoder === "libx265" ||
    encoder === "hevc_qsv" ||
    encoder === "hevc_videotoolbox" ||
    encoder === "hevc_nvenc"
    ? "hevc"
    : "h264";
}

export function getEncodingPolicy(
  qualityHeight: number,
  family: RenditionCodecFamily = "h264",
): RenditionEncodingPolicy {
  const policy = ENCODING_POLICY[family][qualityHeight];
  if (!policy)
    throw new Error(`Unsupported rendition quality: ${qualityHeight}p`);
  return policy;
}

/**
 * The level a decoder is told to expect.
 *
 * H.264 levels cap the frame size, so a 4K rung declared at 4.1 is a frame the
 * level does not admit — VideoToolbox refuses to configure the encoder at all
 * and every other decoder is entitled to reject the stream.
 */
/**
 * The presets Intel Quick Sync will accept, which are not the presets x264 has.
 *
 * `-preset` looks like one option shared by every encoder and is not.
 * x264 and x265 both offer `ultrafast` and `superfast`; QSV's fastest is
 * `veryfast`, and it does not merely ignore a name it does not know — it fails
 * the encode:
 *
 *     [h264_qsv] Unable to parse "preset" option value "ultrafast"
 *     [vost#0:0/h264_qsv] Error applying encoder options: Invalid argument
 *
 * On macOS the hardware encoder is VideoToolbox, which takes no preset at all,
 * so nothing here ever consumed one and the assumption that a preset name is
 * portable was never tested. Windows is the first platform where the chosen
 * hardware encoder reads it.
 */
const QSV_PRESETS = new Set([
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
]);

/**
 * What x264's extra presets mean to an encoder that does not have them.
 *
 * Nearest in intent, not nearest in name: somebody asking for `ultrafast` wants
 * the fastest encode available and should get QSV's fastest, and somebody
 * asking for `placebo` wants the slowest. Both directions preserve the request.
 */
const QSV_PRESET_EQUIVALENT: Record<string, string> = {
  ultrafast: "veryfast",
  superfast: "veryfast",
  placebo: "veryslow",
};

/**
 * The preset to hand this encoder, given the one that was asked for.
 *
 * Translates only between names that genuinely correspond. A preset this
 * function does not recognise is passed through untouched rather than clamped
 * to a default, so a typo in a configured value fails loudly and attributably
 * instead of being silently reinterpreted as `medium`.
 */
export function presetForEncoder(
  encoder: RenditionVideoEncoder,
  preset: string,
): string {
  if (encoder === "h264_nvenc" || encoder === "hevc_nvenc") {
    return NVENC_PRESET_EQUIVALENT[preset] ?? preset;
  }
  if (encoder !== "h264_qsv" && encoder !== "hevc_qsv") return preset;
  if (QSV_PRESETS.has(preset)) return preset;
  return QSV_PRESET_EQUIVALENT[preset] ?? preset;
}

/**
 * NVENC's presets are `p1` (fastest) to `p7` (best). Its old names (`slow`,
 * `medium`, `fast`) still parse but are deprecated aliases that FFmpeg warns
 * about, so the x264 vocabulary is translated to the nearest `p` level.
 */
const NVENC_PRESET_EQUIVALENT: Record<string, string> = {
  ultrafast: "p1",
  superfast: "p2",
  veryfast: "p3",
  faster: "p3",
  fast: "p4",
  medium: "p5",
  slow: "p6",
  slower: "p7",
  veryslow: "p7",
  placebo: "p7",
};

function levelFor(qualityHeight: number, family: RenditionCodecFamily): string {
  if (family === "hevc") {
    if (qualityHeight >= 4320) return "6.1";
    if (qualityHeight >= 2160) return "5.1";
    if (qualityHeight >= 1440) return "5";
    return qualityHeight >= 1080 ? "4.1" : "4";
  }
  if (qualityHeight >= 4320) return "6.2";
  if (qualityHeight >= 2160) return "5.2";
  if (qualityHeight >= 1440) return "5.0";
  if (qualityHeight >= 1080) return "4.1";
  if (qualityHeight >= 720) return "3.1";
  return "3.0";
}

function videoEncoderArgs(
  encoder: RenditionVideoEncoder,
  qualityHeight: number,
  preset: string,
  hdr: RenditionHdrSignal | undefined,
  tonemappedToSdr = false,
): string[] {
  // The single-file renditions predate NVENC support, which exists only for
  // adaptive packages; `resolveVideoEncoder` never offers it here.
  if (encoder === "h264_nvenc" || encoder === "hevc_nvenc") {
    throw new Error(`${encoder} is configured only for adaptive packages.`);
  }
  const family = codecFamilyForEncoder(encoder);
  const policy = getEncodingPolicy(qualityHeight, family);
  const rateCap = [
    "-maxrate",
    String(policy.maxVideoBitrate),
    "-bufsize",
    String(policy.maxVideoBitrate * 2),
  ];
  // Colour properties have to be written explicitly. Without this a tone mapped
  // stream inherits the source's PQ/BT.2020 tags, so players tone map the
  // already-tone-mapped picture a second time and it looks washed out.
  const colour = hdr
    ? [
        "-color_primaries",
        hdr.colorPrimaries,
        "-color_trc",
        hdr.colorTransfer,
        "-colorspace",
        hdr.colorSpace,
      ]
    : tonemappedToSdr
      ? [
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-colorspace",
          "bt709",
        ]
      : [];

  if (encoder === "hevc_qsv") {
    return [
      "-c:v",
      "hevc_qsv",
      "-preset",
      presetForEncoder(encoder, preset),
      "-profile:v",
      hdr ? "main10" : "main",
      // A target, not `-global_quality`: with only a quality and a cap, QSV
      // falls back to constant QP and ignores the cap. See `qsvTargetBitrate`
      // in adaptive/encoding.ts.
      "-b:v",
      String(policy.expectedVideoBitrate),
      ...rateCap,
      ...colour,
      // Safari refuses `hev1`-tagged MP4s; `hvc1` is required for playback.
      "-tag:v",
      "hvc1",
    ];
  }

  if (encoder === "libx265") {
    return [
      "-c:v",
      "libx265",
      "-preset",
      preset,
      "-crf",
      String(policy.crf),
      ...rateCap,
      ...colour,
      "-tag:v",
      "hvc1",
    ];
  }

  if (encoder === "hevc_videotoolbox") {
    return [
      "-c:v",
      encoder,
      "-profile:v",
      hdr ? "main10" : "main",
      "-b:v",
      String(policy.expectedVideoBitrate),
      ...rateCap,
      ...colour,
      "-tag:v",
      "hvc1",
    ];
  }

  const shared = [
    ...rateCap,
    ...colour,
    "-profile:v",
    "high",
    "-level:v",
    levelFor(qualityHeight, family),
  ];

  if (encoder === "h264_qsv") {
    return [
      "-c:v",
      "h264_qsv",
      "-preset",
      presetForEncoder(encoder, preset),
      "-b:v",
      String(policy.expectedVideoBitrate),
      ...shared,
    ];
  }

  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v",
      encoder,
      "-b:v",
      String(policy.expectedVideoBitrate),
      ...shared,
    ];
  }

  return [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(policy.crf),
    ...shared,
  ];
}

function pixelFormatFor(
  encoder: RenditionVideoEncoder,
  hdr: RenditionHdrSignal | undefined,
): string {
  if (hdr)
    return encoder === "hevc_qsv" || encoder === "hevc_videotoolbox"
      ? "p010le"
      : "yuv420p10le";
  return encoder === "h264_qsv" ||
    encoder === "hevc_qsv" ||
    encoder === "h264_videotoolbox" ||
    encoder === "hevc_videotoolbox"
    ? "nv12"
    : "yuv420p";
}

/**
 * Builds one filter graph that decodes the source once, tone maps once when
 * needed, then splits into every requested rendition. Decoding a 4K master
 * separately per rendition was the dominant cost of the previous per-file passes.
 */
export function buildRenditionFilterComplex({
  outputs,
  encoder = "libx264",
  hdr,
  tonemapHdr = false,
}: Pick<
  RenditionEncodingInput,
  "outputs" | "encoder" | "hdr" | "tonemapHdr"
>): string {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }

  const pixelFormat = pixelFormatFor(encoder, hdr);
  const chains: string[] = [];
  let head = "0:v:0";

  if (tonemapHdr) {
    chains.push(`[${head}]${HDR_TO_SDR_FILTER}[tonemapped]`);
    head = "tonemapped";
  }

  if (outputs.length > 1) {
    const branches = outputs.map((_, index) => `split${index}`);
    chains.push(
      `[${head}]split=${outputs.length}${branches.map((label) => `[${label}]`).join("")}`,
    );
    outputs.forEach((output, index) => {
      chains.push(
        `[${branches[index]}]scale=${output.width}:${output.height}:flags=lanczos,format=${pixelFormat}[out${index}]`,
      );
    });
  } else {
    chains.push(
      `[${head}]scale=${outputs[0].width}:${outputs[0].height}:flags=lanczos,format=${pixelFormat}[out0]`,
    );
  }

  return chains.join(";");
}

export function buildRenditionFfmpegArgs({
  inputPath,
  outputs,
  audioStreamIndex,
  audioLanguage,
  encoder = "libx264",
  hdr,
  tonemapHdr = false,
  preset = "medium",
}: RenditionEncodingInput): string[] {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }
  if (hdr && codecFamilyForEncoder(encoder) !== "hevc") {
    throw new Error(
      "Preserving HDR requires an HEVC encoder; no browser decodes 10-bit H.264.",
    );
  }

  const family = codecFamilyForEncoder(encoder);
  const args = [
    "-hide_banner",
    /*
     * Deliberately no `-nostdin`. FFmpeg's only cooperative stop is `q` on
     * stdin, and `-nostdin` tells it not to read one — with the flag present
     * the key is accepted by the pipe and ignored, and a cancelled encode runs
     * to the end of its grace period and is then killed with no `moov` atom.
     * The child's stdin is a pipe this process owns, never an inherited
     * terminal, so there is nothing here for FFmpeg to steal keystrokes from.
     * See `FFMPEG_GRACEFUL_STOP`.
     */
    // Machine-readable progress on stdout instead of the per-frame stderr
    // spam, so a multi-hour title can report where it is.
    "-progress",
    "pipe:1",
    "-nostats",
    "-n",
    "-i",
    inputPath,
    "-filter_complex",
    buildRenditionFilterComplex({ outputs, encoder, hdr, tonemapHdr }),
  ];

  outputs.forEach((output, index) => {
    const policy = getEncodingPolicy(output.qualityHeight, family);
    args.push(
      "-map",
      `[out${index}]`,
      "-map",
      `0:${audioStreamIndex}`,
      "-sn",
      "-dn",
      ...videoEncoderArgs(
        encoder,
        output.qualityHeight,
        preset,
        hdr,
        tonemapHdr,
      ),
      "-metadata:s:v:0",
      "rotate=0",
      "-c:a",
      "aac",
      "-b:a",
      String(policy.audioBitrate),
      "-ar",
      "48000",
      "-disposition:a:0",
      "default",
      ...(audioLanguage
        ? ["-metadata:s:a:0", `language=${audioLanguage}`]
        : []),
      "-max_muxing_queue_size",
      "2048",
      "-movflags",
      "+faststart",
      output.outputPath,
    );
  });

  return args;
}

export function parseEncoderPreference(
  value: string | undefined,
): RenditionEncoderPreference {
  const preference = value?.trim().toLowerCase();
  if (!preference || preference === "auto") return "auto";
  if (
    preference === "qsv" ||
    preference === "videotoolbox" ||
    preference === "software"
  )
    return preference;
  throw new Error(
    "SEYIRLIK_RENDITION_ENCODER must be `auto`, `qsv`, `videotoolbox` or `software`.",
  );
}

export function parseHdrPolicy(value: string | undefined): RenditionHdrPolicy {
  const policy = value?.trim().toLowerCase();
  if (!policy || policy === "preserve") return "preserve";
  if (policy === "tonemap") return "tonemap";
  throw new Error("SEYIRLIK_RENDITION_HDR must be `preserve` or `tonemap`.");
}

/**
 * A hardware encoder appearing in `-encoders` does not mean a usable device is
 * present, so availability is decided by actually encoding a throwaway frame at
 * the bit depth the profile needs.
 */
export async function detectEncoderSupport(
  ffmpegPath: string,
  encoder: RenditionVideoEncoder,
  tenBit: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const sourceFormat = tenBit ? "p010" : "nv12";
  const profile =
    encoder === "hevc_qsv" || encoder === "hevc_videotoolbox"
      ? ["-profile:v", tenBit ? "main10" : "main"]
      : [];

  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=128x128:d=0.1,format=${sourceFormat}`,
        "-c:v",
        encoder,
        ...profile,
        "-f",
        "null",
        "-",
      ],
      { shell: false, windowsHide: true, stdio: "ignore", signal },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export async function resolveVideoEncoder(
  preference: RenditionEncoderPreference,
  ffmpegPath: string,
  family: RenditionCodecFamily = "h264",
  tenBit = false,
  signal?: AbortSignal,
): Promise<RenditionVideoEncoder> {
  const software: RenditionVideoEncoder =
    family === "hevc" ? "libx265" : "libx264";

  if (preference === "software") return software;

  const qsv: RenditionVideoEncoder =
    family === "hevc" ? "hevc_qsv" : "h264_qsv";
  const videotoolbox: RenditionVideoEncoder =
    family === "hevc" ? "hevc_videotoolbox" : "h264_videotoolbox";
  const candidates =
    preference === "qsv"
      ? [qsv]
      : preference === "videotoolbox"
        ? [videotoolbox]
        : process.platform === "darwin"
          ? [videotoolbox, qsv]
          : [qsv];

  for (const encoder of candidates) {
    if (await detectEncoderSupport(ffmpegPath, encoder, tenBit, signal)) {
      return encoder;
    }
  }

  if (preference !== "auto") {
    throw new Error(
      `SEYIRLIK_RENDITION_ENCODER=${preference} was requested but ${candidates[0]} is not usable on this machine.`,
    );
  }
  return software;
}
