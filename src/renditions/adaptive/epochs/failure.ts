/**
 * Telling "the drive was pulled out" from "this encode is broken".
 *
 * They produce the same shape of failure — a non-zero exit and an errno on a
 * path — and treating the first as the second is what turned every accidental
 * unplug into a permanently failed job that a person had to notice and retry.
 * The distinction is made from two things together: what the error says, and
 * whether the storage the job needs is answering right now.
 */

import type { SourceIoEvidence, SourceReadVerdict } from "./sourceIo";
import type { SourceDamageRecord } from "./salvage";

export type ProcessingFailureKind =
  /** A root is simply absent outside active I/O; this is the clean-unmount path. */
  | "storage-unavailable"
  /** The device vanished while a source or destination was actively in use. */
  | "storage-device-lost"
  /** An unambiguous OS or FFmpeg storage error such as EIO or ENXIO. */
  | "storage-io"
  /** A storage-adjacent signal that does not itself establish physical failure. */
  | "storage-soft-fault"
  | "out-of-space"
  /**
   * The volume is there, mounted, the same device it was, and answering — and
   * the source still will not read. That is not something waiting fixes, so it
   * is deliberately a different kind from `storage-unavailable`: it ends the
   * job and asks for a person rather than parking it for the watchdog.
   */
  | "source-io"
  /**
   * The encoder stopped producing and had to be killed, while the source it
   * reads proved perfectly readable.
   *
   * Deliberately not `source-io`: replacing five minutes of a film with black
   * because a filter graph deadlocked would be working around a bug by
   * destroying content. Deliberately not `encoder` either, because nothing
   * crashed and the distinction is what an operator needs to debug it.
   */
  | "media-progress-timeout"
  /**
   * The encoder went quiet on a network volume, a bounded re-read of the same
   * stretch timed out as well, and waiting did not bring it back.
   *
   * Not `source-io`: a cloud mount that is slow to fetch says nothing about the
   * media, and quarantining it would stop the library over a busy connection.
   * Not `media-progress-timeout` either, because the read itself is what did
   * not answer, and that one is worth the queue trying again later.
   */
  | "network-read-stall"
  | "source-missing"
  | "encoder"
  | "unknown";

export interface ClassifiedFailure {
  kind: ProcessingFailureKind;
  /** The sentence an operator reads first. */
  summary: string;
  /** The underlying text, kept so the cause survives into the job record. */
  detail: string;
  /**
   * What FFmpeg said about *which side* failed, when it said anything.
   *
   * Carried through so the salvage decision does not have to re-read a string:
   * replacing five minutes of a film is only ever justified by input-side
   * evidence, and a failure that also names the output is a destination problem
   * wearing the same errno.
   */
  evidence?: SourceIoEvidence;
}

/** Errno spellings that mean the storage stopped answering, not that a file is absent. */
const HARD_STORAGE_ERROR_PATTERNS = [
  /\bEIO\b/,
  /Input\/output error/i,
  /\bENXIO\b/,
  /\bENODEV\b/,
  /\bESTALE\b/,
  /Stale file handle/i,
  /Device not configured/i,
  /Transport endpoint is not connected/i,
];

const AMBIGUOUS_STORAGE_ERROR_PATTERNS = [
  /Resource temporarily unavailable on/i,
];

const SPACE_ERROR_PATTERNS = [
  /\bENOSPC\b/,
  /No space left on device/i,
  /Disk quota exceeded/i,
];

const MISSING_PATTERNS = [/\bENOENT\b/, /No such file or directory/i];

export function looksLikeStorageLoss(message: string): boolean {
  return [
    ...HARD_STORAGE_ERROR_PATTERNS,
    ...AMBIGUOUS_STORAGE_ERROR_PATTERNS,
  ].some((pattern) => pattern.test(message));
}

/** True only when one occurrence proves that the storage path failed. */
export function looksLikeHardStorageFailure(message: string): boolean {
  return HARD_STORAGE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function looksLikeOutOfSpace(message: string): boolean {
  return SPACE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function looksLikeMissingPath(message: string): boolean {
  return MISSING_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Classifies an encode failure.
 *
 * `storageAvailable` is the deciding evidence for the ambiguous cases. An
 * `ENOENT` on an output path is a vanished volume when the volume is gone and a
 * genuine missing file when it is not, and nothing in the message itself can
 * tell the two apart.
 */
export function classifyFailure({
  message,
  errorCode,
  storageAvailable,
  missingRoots = [],
  ioRechecksExhausted = false,
  evidence,
  sourceVerdict,
}: {
  message: string;
  /**
   * The `errno` the failure carried, where it carried one.
   *
   * Outranks every message heuristic below, because it is the operating
   * system's own answer rather than a sentence somebody wrote. Seyirlik's own
   * storage errors are the case in point: the free-space preflight refuses a
   * publication with a plain-English message and an `ENOSPC` code, and reading
   * only the prose classified a merely-full disk as a broken encoder — ending
   * the job permanently instead of deferring it until room was made.
   */
  errorCode?: string | undefined;
  /** Whether every root the job needs answered its last check. */
  storageAvailable: boolean;
  missingRoots?: readonly string[];
  /**
   * Structured evidence read from FFmpeg's own stderr.
   *
   * Optional, because plenty of callers have only an error message. Where it is
   * present it *overrides* the message heuristics on the one question that
   * matters: an I/O error whose evidence names the output is never called
   * source damage, however many times it repeats.
   */
  evidence?: SourceIoEvidence;
  /**
   * The verdict the source-read assessment reached, when one was reached.
   *
   * Takes precedence over every message heuristic below, because it is built
   * from strictly more information: which side FFmpeg named, whether the
   * encoder had to be killed, and what a targeted re-read of the same window
   * did. A watchdog termination has no errno in its message at all, so without
   * this it would be read as a generic encoder fault — which is exactly how a
   * confirmed source failure escaped as a retryable job error.
   */
  sourceVerdict?: SourceReadVerdict;
  /**
   * Set once the same epoch has failed to read its source the allowed number of
   * times, with the storage verified present and unchanged between every one of
   * them. Until then an I/O error is read as a drive that is on its way out and
   * the watchdog has not caught up with, which is the common case and the
   * recoverable one.
   */
  ioRechecksExhausted?: boolean;
}): ClassifiedFailure {
  const detail = message.slice(-4000);
  const where = missingRoots.length > 0 ? ` (${missingRoots.join(", ")})` : "";
  const carry = evidence ? { evidence } : {};

  /*
   * An explicit `ENOSPC` is checked before the volume is asked about, because
   * a full disk is still a present disk: falling through to the availability
   * question would describe "there is no room" as "the drive went away".
   */
  if (errorCode === "ENOSPC") {
    return {
      kind: "out-of-space",
      summary: "The output volume ran out of space.",
      detail,
      ...carry,
    };
  }
  if (!storageAvailable) {
    return {
      kind: "storage-device-lost",
      summary: `The storage this active job was using became unavailable and disappeared${where}.`,
      detail,
      ...carry,
    };
  }
  if (looksLikeOutOfSpace(message)) {
    return {
      kind: "out-of-space",
      summary: "The output volume ran out of space.",
      detail,
      ...carry,
    };
  }
  if (
    errorCode !== undefined &&
    ["EIO", "ENXIO", "ENODEV", "ESTALE"].includes(errorCode)
  ) {
    return {
      kind: "storage-io",
      summary:
        "The operating system reported a hard storage I/O failure on the path this job was using.",
      detail,
      ...carry,
    };
  }
  /*
   * The assessment, where one was made, outranks everything that follows. It
   * saw which side FFmpeg named and what a re-read of the same window did;
   * the checks below only ever saw a sentence.
   */
  if (sourceVerdict === "media-progress-timeout") {
    return {
      kind: "media-progress-timeout",
      summary:
        "The encoder stopped producing media and had to be stopped, but the source it reads is answering normally. This is a fault in the encode rather than in the media.",
      detail,
      ...carry,
    };
  }
  if (sourceVerdict === "network-stall") {
    return {
      kind: "network-read-stall",
      summary:
        "The network volume stopped answering while the source was being read, and waiting did not bring it back. Nothing points at the media itself, so this will be tried again later.",
      detail,
      ...carry,
    };
  }
  if (sourceVerdict === "source-damage" && ioRechecksExhausted) {
    return {
      kind: "source-io",
      summary:
        "The source could not be read while its volume stayed available, healthy and unchanged. This looks like damaged media or a failing disk rather than a disconnection.",
      detail,
      ...carry,
    };
  }
  if (evidence?.sourceRead && !evidence.outputWrite) {
    return {
      kind: "source-io",
      summary:
        "FFmpeg explicitly reported an input-side I/O failure consistent with damaged media or a failing disk. The source will not be read again until an operator clears storage quarantine.",
      detail,
      ...carry,
    };
  }
  if (looksLikeStorageLoss(message)) {
    /*
     * Evidence that names the *output* settles it before anything else. A
     * destination volume returning `EIO` is a storage fault whatever the retry
     * count says, and calling it damaged media would blame a film for the disk
     * being written to.
     */
    if (evidence && evidence.outputWrite && !evidence.sourceRead) {
      return {
        kind: "storage-io",
        summary:
          "The output volume reported an I/O error while it was being written to.",
        detail,
        ...carry,
      };
    }
    if (looksLikeHardStorageFailure(message)) {
      if (ioRechecksExhausted) {
        return {
          kind: "source-io",
          summary:
            "The source could not be read after repeated attempts while its volume stayed present. This looks like damaged media or a failing disk.",
          detail,
          ...carry,
        };
      }
      return {
        kind: "storage-io",
        summary:
          "The operating system or encoder reported a hard storage I/O failure.",
        detail,
        ...carry,
      };
    }
    return {
      kind: "storage-soft-fault",
      summary: ioRechecksExhausted
        ? "The encoder repeatedly reported an ambiguous storage-related failure."
        : "The encoder reported an ambiguous storage-related failure.",
      detail,
      ...carry,
    };
  }
  if (looksLikeMissingPath(message)) {
    return {
      kind: "source-missing",
      summary: "A file the encode needs is no longer where it was.",
      detail,
      ...carry,
    };
  }
  return {
    kind: "encoder",
    summary: "The encoder stopped before the epoch was finished.",
    detail,
    ...carry,
  };
}

/**
 * A failure that must not be recorded as a defect in the job.
 *
 * Carried as its own class so the layers between the encoder and the job record
 * do not have to re-derive the classification from a string a second time.
 */
export class StorageInterruptedError extends Error {
  readonly failure: ClassifiedFailure;
  constructor(failure: ClassifiedFailure) {
    super(failure.summary);
    this.name = "StorageInterruptedError";
    this.failure = failure;
  }
}

/**
 * A read failure that waiting will not fix.
 *
 * Separate from `StorageInterruptedError` because the two demand opposite
 * handling: that one parks the job for the watchdog, this one ends it and asks
 * for a person. Every checkpoint is kept either way — the epochs already on
 * disk are still valid, and a retry after the source is repaired or replaced
 * re-encodes only the epoch that could not be read.
 */
export class SourceReadError extends Error {
  readonly failure: ClassifiedFailure;
  /** Which epoch could not be read, so the message can name the minutes. */
  readonly epochIndex: number;
  readonly attempts: number;
  /**
   * The interval that could not be read, when the caller knew it.
   *
   * Carried so the job record can name the minutes in the same words whether
   * the outcome was a strict failure or a salvage — and so a deployment that
   * later turns salvage on has the interval already described in its history.
   */
  readonly damage?: SourceDamageRecord;
  constructor(
    failure: ClassifiedFailure,
    epochIndex: number,
    attempts: number,
    damage?: SourceDamageRecord,
  ) {
    super(failure.summary);
    this.name = "SourceReadError";
    this.failure = failure;
    this.epochIndex = epochIndex;
    this.attempts = attempts;
    if (damage) this.damage = damage;
  }
}

/**
 * The audio stage stopping for a reason worth naming.
 *
 * Audio is built in one pass over the whole title, so it is the one stage that
 * can meet a bad region of the source the video epochs never touched. Carried
 * as its own class so the packager can tell "this soundtrack could not be read"
 * from "this soundtrack could not be encoded" without parsing a sentence.
 */
export class AudioStageError extends Error {
  readonly failure: ClassifiedFailure;
  /** Sanitised FFmpeg lines, safe to store and to show. */
  readonly evidence: string[];
  constructor(
    message: string,
    failure: ClassifiedFailure,
    evidence: readonly string[] = [],
  ) {
    super(message);
    this.name = "AudioStageError";
    this.failure = failure;
    this.evidence = [...evidence];
  }
}

/**
 * The encoder stopped producing, and the source is not to blame.
 *
 * Its own class so it cannot be mistaken for source damage on the way up. A
 * media-progress timeout ends the attempt and is worth a person's attention;
 * what it must never do is quietly become a black placeholder, because that
 * would let a deadlocked encoder erase five minutes of a film.
 *
 * A network read stall travels in it too, with `failure.kind` saying which one
 * it is: the media is equally blameless there, and equally never replaced.
 */
export class MediaProgressTimeoutError extends Error {
  readonly failure: ClassifiedFailure;
  readonly epochIndex: number;
  /** Media seconds the encoder had produced when it stopped. */
  readonly lastMediaSeconds: number;
  /** How long media time had been standing still. */
  readonly stalledForMs: number;
  constructor(
    failure: ClassifiedFailure,
    epochIndex: number,
    media: { lastMediaSeconds: number; stalledForMs: number },
  ) {
    super(failure.summary);
    this.name = "MediaProgressTimeoutError";
    this.failure = failure;
    this.epochIndex = epochIndex;
    this.lastMediaSeconds = media.lastMediaSeconds;
    this.stalledForMs = media.stalledForMs;
  }
}
