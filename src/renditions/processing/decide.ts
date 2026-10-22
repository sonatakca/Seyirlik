import { statfs } from "node:fs/promises";
import { DEFAULT_STORAGE_SAFETY_MARGIN } from "../planning";
import { estimateAdaptivePackageBytes } from "../adaptive/packager";
import { codecFamilyForEncoder, type RenditionVideoEncoder } from "../encoding";
import { buildRenditionRequirements, classifyQualityHeight } from "../policy";
import type { RenditionMediaProbe } from "../probe";
import type { HardwareReport } from "../hardware/detect";
import {
  applyStreamPolicy,
  type StreamPolicyOptions,
  type StreamPolicyResult,
} from "./streamPolicy";

/**
 * What processing a source would do, worked out without doing any of it.
 *
 * The same function answers "preview this" and "what is this job going to do",
 * so the plan an operator approves in the UI is the plan the worker executes
 * rather than a description of it written separately.
 */

export type ProcessingAction =
  | "package-adaptive"
  | "skip-already-current"
  | "reject-no-video"
  /**
   * No longer produced: the ladder now reaches the source's own class, so
   * every source with a usable frame has at least one rung, and a frame with
   * no usable dimensions is already rejected as `reject-no-video`. Kept in the
   * vocabulary because jobs recorded before that change still carry it.
   */
  | "reject-too-small"
  | "reject-unsafe-tonemap";

export interface LadderRung {
  qualityHeight: number;
  width: number;
  height: number;
}

export interface DiskEstimate {
  /** Bytes the finished package is expected to occupy. */
  outputBytes: number;
  /** Peak bytes needed in staging while it is produced. */
  stagingBytes: number;
  freeBytes?: number;
  /** False when the volume cannot hold staging plus output plus a reserve. */
  sufficient: boolean;
  reserveBytes: number;
}

export interface ProcessingDecision {
  action: ProcessingAction;
  /** One sentence explaining the action, for the UI and the job record. */
  summary: string;
  source: {
    container: string;
    durationSeconds: number;
    sizeBytes: number;
    width: number;
    height: number;
    qualityHeight: number;
    frameRate?: number;
    videoCodec: string;
    videoProfile?: string;
    bitDepth?: number;
    pixelFormat?: string;
    isHdr: boolean;
    colorTransfer?: string;
    colorPrimaries?: string;
  };
  ladder: LadderRung[];
  /**
   * The rungs this run will actually encode.
   *
   * `ladder` describes the package when it is finished; this describes the
   * job. They differ whenever an existing package is only a rung or two short,
   * and conflating them is what had a one-rung job report itself as encoding
   * the whole ladder.
   */
  renditionsToEncode: number[];
  videoCodec: "h264" | "hevc";
  videoEncoder: RenditionVideoEncoder;
  hardwareAdapter: string;
  /** True when HDR is carried through rather than tone mapped. */
  preservesHdr: boolean;
  streams: StreamPolicyResult;
  estimate: DiskEstimate;
  warnings: string[];
}

export interface DecideProcessingInput {
  probe: RenditionMediaProbe;
  container: string;
  sizeBytes: number;
  hardware: HardwareReport;
  policy?: StreamPolicyOptions;
  /** Free bytes on the scratch volume, when known. */
  freeBytes?: number;
  /** Existing bytes in this job/source scratch root, already excluded from freeBytes. */
  inheritedBytes?: number;
  /** Bytes to leave unused on the scratch volume. */
  reserveBytes?: number;
  /** True when a current package for this exact source already exists. */
  alreadyCurrent?: boolean;
  /**
   * Rungs this run would actually encode, when a package already exists.
   *
   * The ladder describes the finished package; this describes the job. Sizing
   * the job from the ladder made a one-rung run reserve disk for eight and
   * report the whole package's bytes as its own output.
   */
  renditionsToEncode?: readonly number[];
  /** Audio tracks this run would encode; existing valid audio is reused. */
  audioTracksToEncode?: number;
}

/** Headroom kept free on the scratch volume so a full disk cannot be reached. */
export const DEFAULT_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Checkpoints and the assembled package coexist on the scratch volume.
 * Keep the same safety margin as the packager's fresh-job peak check.
 */
function stagingBytesFor(outputBytes: number): number {
  return (
    Math.ceil(outputBytes * (1 + DEFAULT_STORAGE_SAFETY_MARGIN) * 2) -
    outputBytes
  );
}

export async function freeBytesOn(
  directory: string,
): Promise<number | undefined> {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

export function decideProcessing(
  input: DecideProcessingInput,
): ProcessingDecision {
  const { probe, hardware } = input;
  const warnings: string[] = [];
  const streams = applyStreamPolicy(probe, input.policy);
  warnings.push(...streams.warnings);

  const sourceQualityHeight = classifyQualityHeight({
    width: probe.video.width,
    height: probe.video.height,
    rotation: probe.video.rotation,
  });
  const ladder = buildRenditionRequirements({
    width: probe.video.width,
    height: probe.video.height,
    rotation: probe.video.rotation,
  }).map((requirement) => ({
    qualityHeight: requirement.qualityHeight,
    width: requirement.width,
    height: requirement.height,
  }));

  // HDR is carried in HEVC Main 10, which is the only lane a browser decodes
  // 10-bit in. An SDR source uses H.264, which every target plays.
  const preservesHdr = probe.video.isHdr;
  const videoCodec: "h264" | "hevc" = preservesHdr ? "hevc" : "h264";
  const encoder = preservesHdr
    ? probe.video.bitDepth && probe.video.bitDepth > 8
      ? hardware.selected.hevcTenBit
      : hardware.selected.hevc
    : hardware.selected.h264;
  const hardwareAdapter = preservesHdr
    ? probe.video.bitDepth && probe.video.bitDepth > 8
      ? hardware.selectedAdapter.hevcTenBit
      : hardware.selectedAdapter.hevc
    : hardware.selectedAdapter.h264;

  /*
   * What this run will write, which is the whole ladder only when the whole
   * ladder is being built. Both the free-space check and the job's reported
   * output size read this.
   */
  const encodedRungs =
    input.renditionsToEncode ?? ladder.map((rung) => rung.qualityHeight);
  const estimateBytes = estimateAdaptivePackageBytes({
    durationSeconds: probe.durationSeconds,
    qualityHeights: [...encodedRungs],
    codecFamily: codecFamilyForEncoder(encoder),
    audioTrackCount:
      input.audioTracksToEncode ??
      Math.max(1, streams.keptAudioStreamIndexes.length),
  });
  const reserveBytes = input.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  const stagingBytes = stagingBytesFor(estimateBytes.totalBytes);
  const inheritedBytes =
    Number.isFinite(input.inheritedBytes) && (input.inheritedBytes ?? 0) >= 0
      ? (input.inheritedBytes ?? 0)
      : 0;
  const required =
    Math.max(0, estimateBytes.totalBytes + stagingBytes - inheritedBytes) +
    reserveBytes;
  const estimate: DiskEstimate = {
    outputBytes: estimateBytes.totalBytes,
    stagingBytes,
    ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
    sufficient:
      input.freeBytes === undefined ? true : input.freeBytes >= required,
    reserveBytes,
  };
  if (!estimate.sufficient) {
    warnings.push(
      "The scratch volume does not have room for this package plus its staging copy.",
    );
  }

  const source: ProcessingDecision["source"] = {
    container: input.container,
    durationSeconds: probe.durationSeconds,
    sizeBytes: input.sizeBytes,
    width: probe.video.width,
    height: probe.video.height,
    qualityHeight: sourceQualityHeight,
    ...(probe.video.frameRate === undefined
      ? {}
      : { frameRate: probe.video.frameRate }),
    videoCodec: probe.video.codec,
    ...(probe.video.bitDepth === undefined
      ? {}
      : { bitDepth: probe.video.bitDepth }),
    ...(probe.video.pixelFormat
      ? { pixelFormat: probe.video.pixelFormat }
      : {}),
    isHdr: probe.video.isHdr,
    ...(probe.video.colorTransfer
      ? { colorTransfer: probe.video.colorTransfer }
      : {}),
    ...(probe.video.colorPrimaries
      ? { colorPrimaries: probe.video.colorPrimaries }
      : {}),
  };

  const base = {
    source,
    ladder,
    renditionsToEncode: [...encodedRungs],
    videoCodec,
    videoEncoder: encoder,
    hardwareAdapter,
    preservesHdr,
    streams,
    estimate,
    warnings,
  };

  if (probe.video.width <= 0 || probe.video.height <= 0) {
    return {
      ...base,
      action: "reject-no-video",
      summary: "This file has no usable video stream.",
    };
  }
  if (input.alreadyCurrent) {
    return {
      ...base,
      action: "skip-already-current",
      summary: "A current package for this exact source already exists.",
    };
  }

  const rungs = ladder.map((rung) => `${rung.qualityHeight}p`).join(", ");
  const audioCount = streams.keptAudioStreamIndexes.length;
  const subtitleCount = streams.keptSubtitleStreamIndexes.length;
  const codecLabel = `${videoCodec === "hevc" ? "HEVC" : "H.264"}${preservesHdr ? " HDR" : ""}`;

  /*
   * What this run will do, not what the finished package will contain.
   *
   * The summary described the whole ladder whatever the job was, so a run
   * adding a single rung announced itself as "Package 2160p, 1440p, 1080p,
   * 720p, 480p, 360p, 240p, 144p" — which reads as though every rendition is
   * being rebuilt, the very thing the incremental work exists to avoid. The
   * full ladder is still carried in `ladder` for anything that wants it.
   */
  const isIncremental =
    encodedRungs.length > 0 && encodedRungs.length < ladder.length;
  if (isIncremental) {
    const building = [...encodedRungs]
      .sort((left, right) => right - left)
      .map((height) => `${height}p`)
      .join(", ");
    return {
      ...base,
      action: "package-adaptive",
      summary:
        `Encode ${building} ${codecLabel} and add ${encodedRungs.length === 1 ? "it" : "them"} ` +
        `to the existing package, reusing its other ${ladder.length - encodedRungs.length} renditions` +
        `${audioCount > 0 ? ", audio" : ""}${subtitleCount > 0 ? " and subtitles" : ""}.`,
    };
  }

  return {
    ...base,
    action: "package-adaptive",
    summary:
      `Package ${rungs} ${codecLabel} with ${audioCount} audio ` +
      `${audioCount === 1 ? "rendition" : "renditions"}` +
      `${subtitleCount > 0 ? ` and ${subtitleCount} subtitle ${subtitleCount === 1 ? "track" : "tracks"}` : ""}.`,
  };
}
