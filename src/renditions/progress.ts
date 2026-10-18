import type { RenditionVideoEncoder } from "./encoding";
import type {
  AssemblyPhaseProgress,
  AudioPhaseProgress,
  PlanningPhaseProgress,
  PublishPhaseProgress,
  SubtitlePhaseProgress,
  VerificationPhaseProgress,
} from "./adaptive/phaseProgress";
import type {
  SourceDamagePolicy,
  SourceDamageRecord,
} from "./adaptive/epochs/salvage";
import type { SourceReadVerdict } from "./adaptive/epochs/sourceIo";

export interface RenditionSourceSummary {
  width: number;
  height: number;
  qualityHeight: number;
  durationSeconds: number;
  videoCodec: string;
  isHdr: boolean;
  audioLanguage?: string;
}

export type RenditionProgressEvent =
  | {
      type: "encoder-selected";
      encoder: RenditionVideoEncoder;
      hdrEncoder?: RenditionVideoEncoder;
    }
  | {
      type: "item-start";
      index: number;
      total: number;
      mediaId: string;
      relativePath: string;
      source: RenditionSourceSummary;
      pendingQualities: number[];
      reusedQualities: number[];
    }
  | {
      type: "encode-start";
      mediaId: string;
      qualities: number[];
      encoder: RenditionVideoEncoder;
      hdr: boolean;
      tonemapHdr: boolean;
      durationSeconds: number;
    }
  | {
      type: "encode-progress";
      mediaId: string;
      processedSeconds: number;
      durationSeconds: number;
      fps?: number;
      speed?: number;
      writtenBytes?: number;
    }
  | {
      type: "quality-ready";
      mediaId: string;
      qualityHeight: number;
      width: number;
      height: number;
      fileSize: number;
      reused: boolean;
    }
  /**
   * The build's shape, once the epoch plan is known and disk has been
   * reconciled against it. Sent before any encoding so a page that attaches
   * mid-job can describe the work without waiting for a progress tick.
   */
  | {
      type: "epoch-plan";
      mediaId: string;
      epochCount: number;
      epochTargetSeconds: number;
      sourceDurationSeconds: number;
      /** Epochs already durable when this attempt started. */
      reusedEpochs: number;
      protectedSeconds: number;
      /** Bytes of durable checkpoint media already on disk for this build. */
      checkpointBytes: number;
      /** Checkpoints that existed and could not be trusted, with reasons. */
      invalidated: Array<{ index: number; reason: string }>;
    }
  | {
      type: "epoch-start";
      mediaId: string;
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      attempt: number;
    }
  /**
   * The authoritative video-progress sample.
   *
   * `encodedSeconds` is the number the page shows as a percentage: media time
   * genuinely encoded, never a weighted position in a workflow.
   */
  | {
      type: "epoch-progress";
      mediaId: string;
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      epochProcessedSeconds: number;
      encodedSeconds: number;
      protectedSeconds: number;
      sourceDurationSeconds: number;
      fps?: number;
      speed?: number;
      /** Bytes this job has written, checkpoints included. */
      writtenBytes?: number;
      /**
       * True while the media being produced is the replacement for an
       * unreadable interval. Real work, honestly reported, and labelled for
       * what it is.
       */
      placeholder?: boolean;
    }
  | {
      type: "epoch-complete";
      mediaId: string;
      index: number;
      epochCount: number;
      protectedSeconds: number;
      bytes: number;
      elapsedMs: number;
    }
  | {
      type: "epoch-invalid";
      mediaId: string;
      index: number;
      reason: string;
    }
  /**
   * A source read that failed while the volume kept answering.
   *
   * Reported so an operator watching a job can see it escalating rather than
   * apparently stalling, and so the job record carries the count that decided
   * the outcome.
   */
  | {
      type: "source-io-retry";
      mediaId: string;
      index: number;
      attempt: number;
      maxAttempts: number;
      sourceReadable?: boolean;
      /** What the evidence concludes so far, which decides the read budget. */
      verdict?: SourceReadVerdict;
      /** One clause naming what decided it. */
      because?: string;
      detail: string;
    }
  /**
   * Media time stopped and the encoder is being terminated.
   *
   * Between "waiting for source data" and any diagnosis. Emitted at the moment
   * the decision is taken rather than after the kernel has finished unwinding,
   * because on the drive this was built for that unwinding takes tens of
   * seconds and a page that goes quiet for them looks like a page that has
   * crashed.
   */
  | {
      type: "source-stall-abort";
      mediaId: string;
      index: number;
      startSeconds: number;
      endSeconds: number;
      lastMediaSeconds: number;
      stalledForMs: number;
    }
  /**
   * The read budget is spent and the source is the thing that is broken.
   *
   * Emitted under either policy, because the diagnosis does not depend on what
   * is done about it. A page that has been saying "waiting for source data" can
   * stop guessing from here.
   */
  | {
      type: "source-damage-confirmed";
      mediaId: string;
      index: number;
      damage: SourceDamageRecord;
      policy: SourceDamagePolicy;
    }
  /** Synthetic media of exactly the planned length is being produced. */
  | {
      type: "epoch-salvage-start";
      mediaId: string;
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      expectedDurationSeconds: number;
    }
  /** The replacement passed the same validation a real epoch must. */
  | {
      type: "epoch-salvaged";
      mediaId: string;
      index: number;
      epochCount: number;
      protectedSeconds: number;
      bytes: number;
      damage: SourceDamageRecord;
    }
  /** Which part of the build is running, for a page that shows stages apart. */
  | {
      type: "build-stage";
      mediaId: string;
      stage:
        | "planning"
        | "encoding"
        | "audio"
        | "subtitles"
        | "assembling"
        | "validating"
        | "publishing";
      detail?: string;
    }
  /**
   * The phases after the video encode, each reporting its own measured work.
   *
   * They arrive on the same channel as the epoch events and carry the same
   * guarantee: every figure in them is something the process has finished, not
   * something a timer supposes it might have. Before these existed, a job that
   * had encoded its last frame reported nothing at all for the minutes it spent
   * encoding audio, joining twenty-seven gigabytes and reading every one of
   * them back to prove the result — which is precisely when someone watching
   * most wants to know that anything is happening.
   */
  | {
      type: "audio-progress";
      mediaId: string;
      progress: AudioPhaseProgress;
    }
  | {
      type: "planning-progress";
      mediaId: string;
      progress: PlanningPhaseProgress;
    }
  | {
      type: "subtitle-progress";
      mediaId: string;
      progress: SubtitlePhaseProgress;
    }
  | {
      type: "assembly-progress";
      mediaId: string;
      progress: AssemblyPhaseProgress;
    }
  | {
      type: "verification-progress";
      mediaId: string;
      progress: VerificationPhaseProgress;
    }
  | {
      type: "publish-progress";
      mediaId: string;
      progress: PublishPhaseProgress;
    }
  | {
      type: "item-complete";
      mediaId: string;
      relativePath: string;
      status: string;
      elapsedMs: number;
      error?: string;
    }
  | {
      type: "analysis-progress";
      index: number;
      total: number;
      relativePath: string;
    };

export type RenditionProgressReporter = (event: RenditionProgressEvent) => void;

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(remainder).padStart(2, "0");
  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/**
 * Remaining wall time from FFmpeg's own throughput multiplier, which already
 * accounts for tone mapping and encoder speed.
 */
export function estimateRemainingSeconds(
  processedSeconds: number,
  durationSeconds: number,
  speed: number | undefined,
): number | undefined {
  if (!speed || speed <= 0 || !Number.isFinite(durationSeconds))
    return undefined;
  const remaining = Math.max(0, durationSeconds - processedSeconds);
  return remaining / speed;
}

/**
 * Parses one `-progress pipe:1` block. FFmpeg repeats every key in each block,
 * so the accumulated record is always complete.
 */
export function parseFfmpegProgressFields(fields: Record<string, string>): {
  processedSeconds: number;
  fps?: number;
  speed?: number;
  writtenBytes?: number;
} {
  const outTime = fields.out_time?.trim();
  let processedSeconds = 0;

  if (outTime && /^-?\d+:\d{2}:\d{2}(\.\d+)?$/.test(outTime)) {
    const [hours, minutes, seconds] = outTime.split(":");
    processedSeconds =
      Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  } else {
    // `out_time_ms` has always carried microseconds; `out_time_us` is the
    // unambiguous newer spelling.
    const micros = Number(fields.out_time_us ?? fields.out_time_ms);
    if (Number.isFinite(micros)) processedSeconds = micros / 1_000_000;
  }

  const fps = Number(fields.fps);
  const speed = Number((fields.speed ?? "").replace(/x$/, ""));
  const writtenBytes = Number(fields.total_size);

  return {
    processedSeconds: Math.max(0, processedSeconds),
    ...(Number.isFinite(fps) && fps > 0 ? { fps } : {}),
    ...(Number.isFinite(speed) && speed > 0 ? { speed } : {}),
    ...(Number.isFinite(writtenBytes) && writtenBytes >= 0
      ? { writtenBytes }
      : {}),
  };
}
