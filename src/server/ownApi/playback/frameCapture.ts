import { collectFfmpegOutput } from "./ffmpegOutput";

/** An 8-bit 4K PNG is ~25 MB; this leaves headroom for noisy grain. */
const MAX_FRAME_BYTES = 96 * 1024 * 1024;
const FRAME_CAPTURE_TIMEOUT_MS = 60_000;

/**
 * Square pixels at full height. Anamorphic sources store a narrower picture
 * than they show, and a still saved at storage width looks squeezed.
 */
const SQUARE_PIXEL_SCALE = "scale=w=trunc(iw*sar/2)*2:h=ih";

/**
 * PQ and HLG pixels written straight into an 8-bit PNG come out grey and flat.
 * Linearise, move to BT.709 and tone-map, as a player does when it shows HDR
 * on an SDR display. Mobius, not Hable: it leaves everything under the knee
 * where the grade put it and rolls off only the highlights. On a PQ master of
 * a known SDR frame it scored 16.9 dB PSNR against the original to Hable's
 * 11.1, which dimmed the whole picture by a third.
 */
const HDR_TO_SDR = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=mobius:param=0.3:desat=0",
  "zscale=t=bt709:m=bt709:r=pc",
  SQUARE_PIXEL_SCALE,
  "setsar=1",
  "format=rgb24",
].join(",");

const SDR = [
  // The colour options belong to `scale`, which does the YUV-to-RGB step.
  `${SQUARE_PIXEL_SCALE}:in_color_matrix=auto:in_range=auto:out_range=pc`,
  "setsar=1",
  "format=rgb24",
].join(",");

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

export function isHdrTransfer(colorTransfer: string | null): boolean {
  return colorTransfer !== null && HDR_TRANSFERS.has(colorTransfer);
}

/**
 * How far before the paused time decoding starts. Longer than any frame lasts
 * in a film or episode, so the frame on screen is always among those decoded.
 */
const FRAME_LOOKBACK_SECONDS = 0.5;

/**
 * Within this of a frame's start counts as on it: the player's paused time is
 * a double, and a frame-exact time can come back a hair under the frame.
 */
const FRAME_TIME_TOLERANCE_SECONDS = 0.001;

/**
 * The time asked for is the on-screen frame's own timestamp where the browser
 * reports it, else the player's time, and either way the frame wanted is the
 * last one that began at or before it. An input seek gives the opposite — the
 * first frame at or after it — which is the next frame whenever the time lands
 * between two, and so a different shot at a cut (Arcane S01E07, 35:10). So
 * decode from a little before, keep the frames up to that time, and take the
 * last of them.
 */
export function buildFrameCaptureArgs(
  inputPath: string,
  atSeconds: number,
  options: { toneMap: boolean },
): string[] {
  const seekTo = (
    atSeconds - Math.min(FRAME_LOOKBACK_SECONDS, atSeconds)
  ).toFixed(3);
  // Measured from the seek as written, so its rounding cannot move the cut.
  const lookback = atSeconds - Number(seekTo);
  return [
    "-v",
    "error",
    "-nostdin",
    // An input seek, so FFmpeg jumps to the keyframe before it and decodes
    // forward rather than reading the film from the start. Timestamps after
    // it count from the seek point, so the paused time is `lookback`.
    "-ss",
    seekTo,
    "-i",
    inputPath,
    // `V`, not `v`: skips cover art and thumbnails muxed in as video streams.
    "-map",
    "0:V:0",
    "-frames:v",
    "1",
    "-vf",
    [
      // Ends the stream after the last frame that began by the paused time;
      // `reverse` then hands that frame over first, and only it is converted.
      `trim=end=${(lookback + FRAME_TIME_TOLERANCE_SECONDS).toFixed(6)}`,
      "reverse",
      options.toneMap ? HDR_TO_SDR : SDR,
    ].join(","),
    "-c:v",
    "png",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}

/**
 * One frame of the original file as PNG, at the source's full resolution.
 * Empty when `at` lies past the last frame: FFmpeg exits cleanly having
 * written nothing, and the caller decides what that means.
 */
export function captureFrameAsPng(
  inputPath: string,
  atSeconds: number,
  options: { toneMap: boolean },
  ffmpegPath = "ffmpeg",
): Promise<Buffer> {
  return collectFfmpegOutput(
    ffmpegPath,
    buildFrameCaptureArgs(inputPath, atSeconds, options),
    {
      label: "Frame capture",
      maxBytes: MAX_FRAME_BYTES,
      timeoutMs: FRAME_CAPTURE_TIMEOUT_MS,
    },
  );
}
