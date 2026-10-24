/**
 * Telling a source that cannot be read from an output that cannot be written.
 *
 * Both produce `Input/output error`, both can end the same FFmpeg process, and
 * exactly one of them is a reason to replace five minutes of a film with black.
 * The difference is never in the errno and never in the exit code — it is in
 * *which side* of the transcode reported it, which FFmpeg does say and which
 * nothing in this pipeline used to read.
 *
 * Two further facts shape this file, both learned from a real failure on a
 * Seagate volume whose platter had a bad region:
 *
 *  - The exit status cannot be trusted on its own. A demuxer that gives up
 *    mid-file may still let the muxer finalise, and `progress=end` arriving is
 *    a statement about the reporting pipe rather than about the media. So the
 *    evidence is read from stderr whatever the process returned, and it is read
 *    *before* the duration validator, which would otherwise blame the encoder
 *    for a short epoch and spend the retry budget re-encoding a hole.
 *  - What is kept must be safe to show. The tail is bounded and every absolute
 *    path is reduced to a file name, because this text travels into the job
 *    record and from there to a browser.
 */

/** Longest sanitised evidence kept, per failure. */
export const SOURCE_IO_EVIDENCE_LINES = 6;
/** Longest single evidence line kept. */
export const SOURCE_IO_EVIDENCE_LINE_CHARS = 240;
/** Longest raw stderr tail retained while an epoch runs. */
export const SOURCE_IO_STDERR_TAIL_CHARS = 16_384;

/**
 * Lines that name the *input* as the thing that failed.
 *
 * `Read error at pos.` is emitted by the protocol layer when a read on the
 * input file returns an error, and carries the byte offset the platter gave up
 * at. `Error during demuxing` and the `[in#0…]` prefixes are the transcoder
 * saying the same thing one layer up.
 */
const SOURCE_PATTERNS: readonly RegExp[] = [
  /Read error at pos\.?\s*\d+/i,
  /Error (?:during )?demuxing/i,
  /\[in#\d+[^\]]*\][^\n]*(?:Input\/output error|I\/O error|\bEIO\b)/i,
  /Error (?:while )?reading (?:from )?(?:the )?input/i,
  /Failed to read (?:packet|frame) from input/i,
  /Invalid return value 0 for stream protocol/i,
];

/**
 * Lines that name the *output*. An `EIO` here is the destination volume
 * misbehaving, which is a storage problem and never a reason to declare the
 * film damaged.
 */
const OUTPUT_PATTERNS: readonly RegExp[] = [
  /av_interleaved_write_frame\(\)/i,
  /\[out#\d+[^\]]*\][^\n]*(?:Input\/output error|I\/O error|\bEIO\b)/i,
  /Error (?:while )?writing (?:to )?(?:the )?(?:output|trailer)/i,
  /Failure occurred when .*writing/i,
  /Could not write header/i,
  /Unable to open .* for writing/i,
];

/** Any errno spelling that means a read or write physically failed. */
const IO_ERRNO = /(?:Input\/output error|\bEIO\b|I\/O error)/i;

export interface SourceIoEvidence {
  /** The input side reported a read failure. */
  sourceRead: boolean;
  /** The output side reported a write failure. */
  outputWrite: boolean;
  /** Byte offset of the failed read, when FFmpeg named one. */
  byteOffset?: number;
  /** Sanitised lines, bounded, safe to store and to show. */
  lines: string[];
}

/**
 * Replaces anything path-shaped with its last component.
 *
 * `/Volumes/Expansion/Films/Some Film (2006)/Some Film.mkv: Input/output error`
 * becomes `Some Film.mkv: Input/output error`. The file name is kept because it
 * is what an operator recognises; everything above it is layout the browser has
 * no business learning.
 */
export function sanitiseFfmpegLine(line: string): string {
  return line
    .replace(/(?:[A-Za-z]:)?(?:\/|\\\\)[^\s'"]*(?:\/|\\)([^\s'"/\\]+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SOURCE_IO_EVIDENCE_LINE_CHARS);
}

/**
 * Reads an FFmpeg stderr tail for evidence about which side failed.
 *
 * Deliberately structured rather than a boolean: an epoch can hit a read error
 * on the source *and* a write error on the output in the same run — a drive
 * being pulled takes both with it — and the caller has to be able to see that
 * the output was involved and refuse to call it source damage.
 */
export function readSourceIoEvidence(stderr: string): SourceIoEvidence {
  const lines = stderr.split(/\r?\n/);
  const evidence: string[] = [];
  let sourceRead = false;
  let outputWrite = false;
  let byteOffset: number | undefined;

  for (const line of lines) {
    const output = OUTPUT_PATTERNS.some((pattern) => pattern.test(line));
    /*
     * Output first, and a line that matches both is the output's. FFmpeg
     * prefixes a muxer failure with the output stream it belongs to, so a line
     * carrying both markers is a write that failed — reading it as a source
     * read is the one misclassification that must not happen, because it would
     * replace good film with black over a failing destination disk.
     */
    if (output) {
      outputWrite = true;
      evidence.push(sanitiseFfmpegLine(line));
      continue;
    }
    if (SOURCE_PATTERNS.some((pattern) => pattern.test(line))) {
      sourceRead = true;
      const position = /Read error at pos\.?\s*(\d+)/i.exec(line);
      if (position) {
        const parsed = Number(position[1]);
        if (Number.isSafeInteger(parsed) && parsed >= 0) byteOffset = parsed;
      }
      evidence.push(sanitiseFfmpegLine(line));
      continue;
    }
    // An errno with no side named is kept as context but proves nothing on its
    // own; the decision above is what says whether anything is salvageable.
    if (IO_ERRNO.test(line)) evidence.push(sanitiseFfmpegLine(line));
  }

  return {
    sourceRead,
    outputWrite,
    ...(byteOffset === undefined ? {} : { byteOffset }),
    /*
     * The last few distinct lines. FFmpeg's final words are the ones that
     * describe how it stopped, and the same line arrives twice whenever a
     * caller appends the thrown message to the log it came from — repeating it
     * in the job record would read as two failures.
     */
    lines: [...new Set(evidence.filter((line) => line.length > 0))].slice(
      -SOURCE_IO_EVIDENCE_LINES,
    ),
  };
}

/**
 * Whether this evidence, on its own, justifies calling the source unreadable.
 *
 * Both halves matter. Without input-side evidence there is nothing to blame the
 * media for; with output-side evidence present the failure is at least partly
 * the destination's, and a destination that cannot be written to is a storage
 * problem the existing recovery path already handles correctly.
 */
export function evidenceIndictsSource(evidence: SourceIoEvidence): boolean {
  return evidence.sourceRead && !evidence.outputWrite;
}

/** Keeps a bounded tail of a child process's stderr without holding the lot. */
export function createStderrTail(limit: number = SOURCE_IO_STDERR_TAIL_CHARS): {
  append(chunk: string): void;
  value(): string;
  reset(): void;
} {
  let tail = "";
  return {
    append(chunk) {
      tail = `${tail}${chunk}`.slice(-limit);
    },
    value() {
      return tail;
    },
    reset() {
      tail = "";
    },
  };
}

/**
 * What a bounded readability probe of the source concluded.
 *
 * `timeout` is deliberately its own answer rather than being folded into
 * `unreadable`. A probe that answered "no" read the file and was refused; a
 * probe that never answered entered the same kernel recovery as the encode it
 * was diagnosing, which on the drive this was built for takes tens of seconds
 * per sector. Both are evidence against the source, and only one of them is
 * evidence that anything is still responding.
 */
export type SourceProbeVerdict = "readable" | "unreadable" | "timeout";

export interface SourceProbeOutcome {
  verdict: SourceProbeVerdict;
  /** Sanitised, bounded. Never a path. */
  detail?: string;
}

export function probeSaysUnreadable(
  probe: SourceProbeOutcome | undefined,
): boolean {
  return probe?.verdict === "unreadable" || probe?.verdict === "timeout";
}

/**
 * What the pipeline should do about a failed read.
 *
 * Three answers, because three different things produce the same symptom:
 *
 *  - `transient` — an I/O error with nothing to say about which side failed.
 *    This is the drive that is on its way out and the watchdog has not caught
 *    up with, which is the common case and the recoverable one. Existing
 *    bounded retry behaviour, unchanged.
 *  - `source-damage` — the input side is named, or the encoder had to be
 *    stopped and a targeted probe of the same window also failed. The region
 *    will not read.
 *  - `media-progress-timeout` — the encoder stopped producing and had to be
 *    killed, but the source reads perfectly. That is an encoder or pipeline
 *    fault, and turning it into black picture would be replacing film to work
 *    around a bug.
 *  - `network-stall` — the encoder went quiet and the probe timed out too, but
 *    the source sits on a network volume. There, silence is a slow fetch rather
 *    than a platter's retry storm, so the read is waited for and tried again.
 */
export type SourceReadVerdict =
  | "transient"
  | "source-damage"
  | "media-progress-timeout"
  | "network-stall";

export interface SourceReadAssessment {
  verdict: SourceReadVerdict;
  /**
   * Full source reads this epoch may spend in total, the failed one included.
   *
   * The figure exists because reads of a damaged region are not cheap. One
   * application read of the sector that motivated this took 35–37 seconds,
   * because the kernel retries a failing block about twenty times before giving
   * up — so four attempts is not "a bounded retry", it is two and a half
   * minutes of deliberately re-injuring the same platter. Once the evidence is
   * decisive the budget collapses to a single confirmation.
   */
  fullReadBudget: number;
  /** One clause for the job history, saying what decided it. */
  because: string;
}

export function assessSourceRead({
  evidence,
  watchdogAborted,
  probe,
  transientBudget,
  networkVolume = false,
  networkStallBudget = transientBudget,
}: {
  evidence: SourceIoEvidence;
  /** True when the media-progress watchdog had to stop the encoder. */
  watchdogAborted: boolean;
  /** The bounded probe's answer, when one was taken. */
  probe?: SourceProbeOutcome;
  /** Attempts the transient path is allowed, from the existing backoff policy. */
  transientBudget: number;
  /** True when the source is read over the network, such as a Drive mount. */
  networkVolume?: boolean;
  /** Reads a quiet network volume is allowed, from its own backoff policy. */
  networkStallBudget?: number;
}): SourceReadAssessment {
  /*
   * The output side settles it before anything else. A destination volume
   * returning `EIO` is a storage fault however the encoder ended, and calling
   * it damaged media would replace readable film because the disk being
   * written to is failing.
   */
  if (evidence.outputWrite && !evidence.sourceRead) {
    return {
      verdict: "transient",
      fullReadBudget: transientBudget,
      because: "the failure names the output rather than the source",
    };
  }

  const indicted = evidenceIndictsSource(evidence);

  /*
   * Silence on a network volume is not evidence against the media. The rule
   * below was written for a local disk, where a read that does not answer in
   * fifteen seconds is the kernel retrying a bad sector. Over a cloud mount it
   * is a fetch that has not come back yet, and quarantining for it took a
   * healthy library offline. An explicit error still goes the other way: only
   * a probe that *timed out* is excused, never one that failed.
   */
  if (
    networkVolume &&
    watchdogAborted &&
    !indicted &&
    probe?.verdict === "timeout"
  ) {
    return {
      verdict: "network-stall",
      fullReadBudget: networkStallBudget,
      because:
        "the network volume stopped answering, and a bounded read of the same stretch timed out too",
    };
  }

  if (probeSaysUnreadable(probe) && (indicted || watchdogAborted)) {
    return {
      verdict: "source-damage",
      fullReadBudget: 1,
      because:
        probe?.verdict === "timeout"
          ? "a targeted read of the same window did not answer either"
          : "a targeted read of the same window failed too",
    };
  }

  if (indicted) {
    return {
      /*
       * FFmpeg named the input. One more bounded read is allowed, because a
       * single demux error on an otherwise healthy file is a thing that
       * happens — but only one, and only because the probe just succeeded.
       */
      verdict: "source-damage",
      fullReadBudget: 2,
      because: "FFmpeg reported the failure on its input",
    };
  }

  if (watchdogAborted) {
    /*
     * Stopped producing, yet the source reads. A media-progress timeout on its
     * own is never source damage: that would let a deadlocked filter graph or a
     * wedged encoder turn five minutes of a film into black.
     */
    return {
      verdict: "media-progress-timeout",
      fullReadBudget: 1,
      because: "media time stopped while the source still reads",
    };
  }

  return {
    verdict: "transient",
    fullReadBudget: transientBudget,
    because: "an I/O error with no side named",
  };
}
