/**
 * The one definition of "a two-second random-access interval" in Seyirlik.
 *
 * Two places need it and they must agree: the live transcoder builds a rolling
 * HLS playlist from a single encode, and the offline packager builds an aligned
 * ladder from several. If their GOP arithmetic drifted apart, the adaptive
 * ladder would still validate on its own — every rendition keyframed every two
 * seconds — while segment boundaries differed from anything the live path
 * produced, and the two would be silently incomparable.
 *
 * Encoder-specific arguments are decided here too, because they are not
 * interchangeable. `-sc_threshold 0` is an x264 private option that libx265
 * ignores with a warning; the equivalent lives in `-x265-params scenecut=0`.
 * QuickSync honours neither and needs `-forced_idr` for `-force_key_frames` to
 * emit an IDR rather than a plain I-frame — which a decoder cannot start on, so
 * a segment beginning there is not independently decodable at all.
 */

/** Random-access interval every adaptive rendition is cut on. */
export const SEGMENT_TARGET_SECONDS = 2;

/** Used only when a probe reports no usable frame rate at all. */
export const DEFAULT_VIDEO_FRAMERATE = 30;

export type GopEncoderFamily =
  | "libx264"
  | "libx265"
  | "h264_qsv"
  | "hevc_qsv"
  | "h264_nvenc"
  | "hevc_nvenc"
  | "h264_amf"
  | "h264_videotoolbox"
  | "hevc_videotoolbox";

/**
 * Frames per GOP for a source running at `frameRate`.
 *
 * Rounded rather than floored: 23.976 fps gives 47.95, and a 47-frame GOP would
 * put every keyframe 1.96s apart, so boundaries would creep forward against the
 * time-based forced-keyframe expression until the two disagreed by a whole
 * frame. `-force_key_frames` remains the authority on placement; `-g` only has
 * to not fight it.
 */
export function computeGopFrames(
  frameRate: number | undefined,
  segmentSeconds: number = SEGMENT_TARGET_SECONDS,
): number {
  const usableFrameRate =
    typeof frameRate === "number" &&
    Number.isFinite(frameRate) &&
    frameRate > 0 &&
    frameRate <= 1000
      ? frameRate
      : DEFAULT_VIDEO_FRAMERATE;

  return Math.max(1, Math.round(usableFrameRate * segmentSeconds));
}

/**
 * Longest a single source frame lasts, which is the alignment tolerance the
 * whole ladder is judged against. Two renditions cannot land closer than one
 * frame apart, and demanding they do would fail every real encode.
 */
export function sourceFrameDurationSeconds(
  frameRate: number | undefined,
): number {
  const usableFrameRate =
    typeof frameRate === "number" &&
    Number.isFinite(frameRate) &&
    frameRate > 0 &&
    frameRate <= 1000
      ? frameRate
      : DEFAULT_VIDEO_FRAMERATE;

  return 1 / usableFrameRate;
}

/**
 * The time-based half of the policy, identical for every encoder.
 *
 * `expr:gte(t,n_forced*2)` is evaluated against presentation timestamps rather
 * than frame counts, so a variable-frame-rate source still gets a random-access
 * point at each two-second mark instead of drifting with the frame cadence.
 */
export function buildForcedKeyframeArgs(
  segmentSeconds: number = SEGMENT_TARGET_SECONDS,
): string[] {
  return ["-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`];
}

export interface GopArgumentOptions {
  encoder: GopEncoderFamily;
  frameRate: number | undefined;
  segmentSeconds?: number;
}

/**
 * Everything an encoder needs to place a closed, scene-cut-free IDR every
 * `segmentSeconds`.
 *
 * Returned as one flat list because callers append it verbatim; splitting it
 * into "common" and "software-only" halves is what let the live path forget the
 * software-only half for one encoder and not the others.
 */
export function buildGopArgs({
  encoder,
  frameRate,
  segmentSeconds = SEGMENT_TARGET_SECONDS,
}: GopArgumentOptions): string[] {
  const gopFrames = computeGopFrames(frameRate, segmentSeconds);
  const shared = [
    "-g",
    String(gopFrames),
    ...buildForcedKeyframeArgs(segmentSeconds),
    "-flags",
    "+cgop",
  ];

  switch (encoder) {
    case "libx264":
      return [
        ...shared,
        "-keyint_min",
        String(gopFrames),
        "-sc_threshold",
        "0",
        // Without this a forced keyframe can be a non-IDR I-frame, which a
        // decoder cannot start on. Every segment must begin on one that it can.
        "-forced-idr",
        "1",
      ];

    case "libx265":
      return [
        ...shared,
        // libx265 ignores `-keyint_min`/`-sc_threshold` with a warning; the
        // equivalents are only reachable through its own parameter string.
        "-x265-params",
        `keyint=${gopFrames}:min-keyint=${gopFrames}:scenecut=0:open-gop=0`,
        "-forced-idr",
        "1",
      ];

    case "h264_qsv":
    case "hevc_qsv":
      return [
        ...shared,
        // QSV has no scene-cut threshold to disable; a fixed `-g` with
        // `look_ahead` off is how it is held to a fixed cadence.
        "-forced_idr",
        "1",
      ];

    case "h264_nvenc":
    case "hevc_nvenc":
      return [...shared, "-no-scenecut", "1", "-forced-idr", "1"];

    case "h264_videotoolbox":
    case "hevc_videotoolbox":
      // VideoToolbox exposes neither a scene-cut control nor `-forced-idr`;
      // passing one FFmpeg rejects the whole command, so `-g` plus the
      // forced-keyframe expression is the whole of what it can be given.
      return shared;

    case "h264_amf":
    default:
      return shared;
  }
}
