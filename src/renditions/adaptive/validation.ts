/**
 * Strict validation of a packaged adaptive rendition set.
 *
 * A package is either provably correct or it is not activated. There is no
 * middle state, because the failure mode of a nearly-correct adaptive package
 * is not an error message — it is a viewer whose picture freezes for a few
 * seconds every time the ladder moves, with nothing in any log to say why.
 *
 * Two rules shape the checks below:
 *
 *  - Nothing is trusted because the encoder was asked for it. Every claim in
 *    the manifest is re-derived from the packaged bytes and compared.
 *  - Error messages name the media id, the rendition, the stage and the
 *    measured discrepancy, and contain no absolute filesystem path, because
 *    they are surfaced to operators through interfaces that also reach clients.
 */

import { open, readFile, realpath, stat } from "node:fs/promises";
import path, { posix } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { sourceFrameDurationSeconds } from "../../lib/playback-planner/gopPolicy";
import {
  parseAdaptiveMetadata,
  type AdaptivePackageMetadata,
  type AdaptiveVideoRenditionMetadata,
} from "./metadata";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  type ParsedMediaPlaylist,
} from "./playlist";
import {
  probePackagedAudio,
  probePackagedVideo,
  type PackagedVideoProbe,
} from "./probePackaged";
import {
  ADAPTIVE_METADATA_FILE,
  ALIGNMENT_EPSILON_SECONDS,
  AUDIO_DURATION_TOLERANCE_SECONDS,
  VIDEO_DURATION_TOLERANCE_SECONDS,
} from "./profile";
import { parseWebVttMediaPlaylist } from "./subtitles";
import { TITLE_PACKAGE_DIRECTORY } from "./titleLayout";
import { TITLE_BUILD_RECORD } from "./publishTitle";
import {
  createByteRateEstimator,
  etaFromRate,
  safeFraction,
  VERIFICATION_STALE_MS,
  type VerificationCheckKind,
  type VerificationGroupProgress,
  type VerificationPhaseProgress,
  type VerificationStepProgress,
} from "./phaseProgress";

export interface AdaptiveValidationIssue {
  mediaId: string;
  /** Rendition id, or `package` for whole-package checks. */
  rendition: string;
  stage: string;
  message: string;
}

export interface AdaptiveValidationResult {
  ok: boolean;
  /** Names of the checks that passed, recorded into the manifest. */
  checks: string[];
  issues: AdaptiveValidationIssue[];
  metadata?: AdaptivePackageMetadata;
}

export interface AdaptiveValidationOptions {
  versionRoot: string;
  mediaId: string;
  sourceFingerprint?: string;
  profileVersion?: string;
  ffprobePath?: string;
  ffmpegPath?: string;
  /**
   * Decode-level checks: seek points and cross-rendition splice accuracy.
   * Skipped by the read-only inspection the playback path performs on every
   * session, which must stay cheap, and always run by the CLI validator.
   */
  deep?: boolean;
  /**
   * The package under validation describes only part of a title.
   *
   * True for the work directory of an incremental run, which holds just the
   * renditions that run produced — commonly video with no audio, because the
   * published audio is being reused untouched. Never true for a published
   * package, which must always carry audio.
   */
  allowMissingAudio?: boolean;
  /** Only for incremental scratch, never for a published package. */
  allowMissingVideo?: boolean;
  signal?: AbortSignal;
  /**
   * Called as each planned check finishes.
   *
   * The plan is built from the manifest before the first check runs, so the
   * denominator is real: these are the checks this package will actually
   * receive, weighted by the bytes they will actually read. A metadata parse
   * and a probe of a ten-gigabyte rendition are both one check and are nothing
   * like the same work, which is why the fraction is byte-weighted and the
   * count is reported beside it rather than instead of it.
   */
  onProgress?: (progress: VerificationPhaseProgress) => void;
}

/**
 * What a check costs, relative to the others.
 *
 * A structural check parses a playlist of a few kilobytes. A probe runs ffprobe
 * across the whole media file — `-skip_frame nokey` discards non-keyframes but
 * the demuxer still walks the file to find them — so its cost grows with the
 * rendition's size. A deep seek-decode reads two segments.
 *
 * The unit is bytes because the size of what a check reads is the best
 * available predictor of its cost, and for no other reason. It is a weight, not
 * a measurement: ffprobe reports nothing while it runs, so a check contributes
 * all of its weight when it finishes and none before. Nothing downstream may
 * present these as bytes actually read.
 */
const STRUCTURAL_CHECK_WEIGHT = 64 * 1024;

/** Segments a deep check reads at each probe point. */
const DEEP_SLICE_SEGMENTS = 2;

/**
 * A deep check's weight: two segments at each probe point, where a segment
 * averages the rendition's size over its segment count.
 */
function deepSliceWeight(
  rendition: { fileSizeBytes: number; segmentCount: number },
  probePoints: number,
): number {
  if (rendition.segmentCount <= 0) return STRUCTURAL_CHECK_WEIGHT;
  const perSegment = rendition.fileSizeBytes / rendition.segmentCount;
  return Math.round(perSegment * DEEP_SLICE_SEGMENTS * probePoints);
}

/** One planned verification check. Exported for the progress tests. */
export interface PlannedCheck {
  kind: VerificationCheckKind;
  rendition: string;
  /** Relative cost of this check. Unitless; see the constant above. */
  weight: number;
}

/**
 * A progress reporter over a plan that is fixed before any check runs.
 *
 * Kept as a closure rather than a class because it holds two counters and one
 * callback, and because nothing outside this file may advance it: a check that
 * reported itself complete without having run would be exactly the lie this
 * whole exercise exists to remove.
 */
export function createVerificationReporter(
  planned: PlannedCheck[],
  declared: VerificationPhaseProgress["declared"],
  onProgress: ((progress: VerificationPhaseProgress) => void) | undefined,
  now: () => number = Date.now,
) {
  const totalWeight = planned.reduce((sum, check) => sum + check.weight, 0);
  const done = new Set<string>();
  let completedChecks = 0;
  let completedWeight = 0;
  /*
   * Live state for the check that is running, which is separate from the
   * counters on purpose. `completedChecks` may only move when a check has
   * genuinely finished — that is the number the page prints as "10 / 36" — so
   * everything a long scan reports about its own position lives here instead.
   */
  let step: VerificationStepProgress | undefined;
  let stepRate = createByteRateEstimator();
  /** Presentation time of the first keyframe, so a scan that does not start at
   * zero is still measured from where it actually began. */
  let stepOrigin: number | undefined;
  let stepFurthest = 0;

  const key = (kind: VerificationCheckKind, rendition: string) =>
    `${kind}:${rendition}`;

  /** Counts per family, which are the figures the page prints as numbers. */
  const groups = (): VerificationGroupProgress[] => {
    const byKind = new Map<VerificationCheckKind, VerificationGroupProgress>();
    for (const check of planned) {
      const entry = byKind.get(check.kind) ?? {
        kind: check.kind,
        completed: 0,
        total: 0,
      };
      entry.total += 1;
      if (done.has(key(check.kind, check.rendition))) entry.completed += 1;
      byKind.set(check.kind, entry);
    }
    return [...byKind.values()];
  };

  /**
   * The running check as the page should see it.
   *
   * A rate and an estimate are shown only while the scan is demonstrably
   * moving. Once it has said nothing for long enough they are withdrawn rather
   * than left counting down from a measurement that is no longer true — the
   * same rule the encoder's own panel follows.
   */
  const currentStep = (
    check: PlannedCheck,
    at: number,
  ): VerificationStepProgress => {
    if (
      !step ||
      step.kind !== check.kind ||
      step.rendition !== check.rendition
    ) {
      return { kind: check.kind, rendition: check.rendition };
    }
    const total = step.totalMediaSeconds;
    const measurable = total !== undefined && total > 0;
    const stalled =
      step.lastAdvancedAtMs !== undefined &&
      at - step.lastAdvancedAtMs > VERIFICATION_STALE_MS;
    const rate = stalled ? undefined : stepRate.rate(at);
    const remaining = measurable ? Math.max(0, total - stepFurthest) : 0;
    const eta = measurable ? etaFromRate(remaining, rate) : undefined;
    return {
      ...step,
      ...(stepFurthest > 0 ? { currentMediaSeconds: stepFurthest } : {}),
      ...(measurable ? { fraction: safeFraction(stepFurthest, total) } : {}),
      ...(rate === undefined ? {} : { rate }),
      ...(eta === undefined ? {} : { etaSeconds: eta }),
      ...(stalled ? { stalled: true } : {}),
    };
  };

  const emit = (current?: PlannedCheck, ok?: boolean): void => {
    if (!onProgress) return;
    const at = now();
    const running = current ? currentStep(current, at) : undefined;
    /*
     * The running check counts for the part of itself it has measurably done.
     *
     * Without this the phase's bar — and with it the whole job's — stood still
     * for the entire time the largest rendition was being read, which on a
     * two-and-a-half-hour 4K title is minutes of a page that looks stopped.
     * Only a check that reports a real position contributes anything; the ones
     * that finish atomically still move the bar exactly once, when they finish.
     */
    const inFlight =
      running?.fraction !== undefined && current
        ? current.weight * running.fraction
        : 0;
    onProgress({
      totalChecks: planned.length,
      completedChecks,
      totalWeight,
      completedWeight,
      fraction: safeFraction(completedWeight + inFlight, totalWeight),
      groups: groups(),
      ...(running ? { current: running } : {}),
      ...(declared ? { declared } : {}),
      ...(ok === undefined ? {} : { ok }),
    });
  };

  return {
    /** Announces the check about to run, before it does any work. */
    begin(
      kind: VerificationCheckKind,
      rendition: string,
      totalMediaSeconds?: number,
    ): void {
      /*
       * A new check starts from nothing. Carrying the previous rendition's
       * position forward would show 2160p's progress under 1440p's name for as
       * long as it took the next scan to print its first keyframe.
       */
      step = {
        kind,
        rendition,
        startedAtMs: now(),
        ...(totalMediaSeconds !== undefined && totalMediaSeconds > 0
          ? { totalMediaSeconds }
          : {}),
      };
      stepRate = createByteRateEstimator();
      stepOrigin = undefined;
      stepFurthest = 0;
      emit(
        planned.find(
          (check) => check.kind === kind && check.rendition === rendition,
        ) ?? { kind, rendition, weight: 0 },
      );
    },
    /**
     * Records how far into its own timeline the running check has read.
     *
     * Monotonic by construction: a presentation time that goes backwards is
     * ordinary — an out-of-order sample, a container whose timestamps are not
     * strictly sorted — and a bar that went backwards would read as a fault
     * where there is none.
     */
    advance(mediaSeconds: number): void {
      if (!step || !Number.isFinite(mediaSeconds)) return;
      const at = now();
      const publish = (): void =>
        emit(
          planned.find(
            (check) =>
              check.kind === step!.kind && check.rendition === step!.rendition,
          ) ?? { kind: step!.kind, rendition: step!.rendition, weight: 0 },
        );

      /*
       * The first timestamp is the origin, not progress — a scan that opens at
       * ten minutes has not already done ten minutes of work. It is still
       * reported, because it is the moment the page can first say which
       * rendition is being read, and it seeds the window the rate is measured
       * over.
       */
      if (stepOrigin === undefined) {
        stepOrigin = mediaSeconds;
        stepRate.sample(0, at);
        step = { ...step, lastAdvancedAtMs: at };
        publish();
        return;
      }

      const scanned = mediaSeconds - stepOrigin;
      if (!(scanned > stepFurthest)) {
        /*
         * Not progress, but an opportunity: a repeated or out-of-order
         * timestamp still tells us the scan is being read from, and re-emitting
         * is how a page learns that the position has stopped moving.
         */
        if (
          step.lastAdvancedAtMs !== undefined &&
          at - step.lastAdvancedAtMs > VERIFICATION_STALE_MS
        ) {
          publish();
        }
        return;
      }
      stepFurthest = scanned;
      stepRate.sample(stepFurthest, at);
      step = { ...step, lastAdvancedAtMs: at };
      publish();
    },
    /** Records a check that has genuinely finished. */
    complete(kind: VerificationCheckKind, rendition: string): void {
      step = undefined;
      const identity = key(kind, rendition);
      if (done.has(identity)) return;
      done.add(identity);
      const match = planned.find(
        (check) => check.kind === kind && check.rendition === rendition,
      );
      completedChecks = Math.min(planned.length, completedChecks + 1);
      completedWeight = Math.min(
        totalWeight,
        completedWeight + (match?.weight ?? 0),
      );
      emit();
    },
    finish(ok: boolean): void {
      emit(undefined, ok);
    },
  };
}

class ValidationCollector {
  readonly issues: AdaptiveValidationIssue[] = [];
  readonly checks: string[] = [];

  constructor(private readonly mediaId: string) {}

  add(rendition: string, stage: string, message: string): void {
    this.issues.push({ mediaId: this.mediaId, rendition, stage, message });
  }

  pass(check: string): void {
    if (!this.checks.includes(check)) this.checks.push(check);
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

/**
 * Resolves a package-relative path and proves it stays inside the version
 * directory even after symlinks are followed.
 *
 * The manifest parser already rejects traversal syntax, so this is the second
 * of two independent barriers: it catches the case the parser structurally
 * cannot, which is a well-formed relative path whose real target has been
 * redirected outside the package since it was written.
 */
async function resolveInsidePackage(
  versionRoot: string,
  relativePath: string,
): Promise<string | null> {
  const candidate = path.resolve(versionRoot, ...relativePath.split("/"));
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(versionRoot),
      realpath(candidate),
    ]);
    const normalise = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const root = normalise(realRoot);
    const target = normalise(realCandidate);
    return target === root || target.startsWith(`${root}${path.sep}`)
      ? realCandidate
      : null;
  } catch {
    return null;
  }
}

async function readPackageFile(
  versionRoot: string,
  relativePath: string,
): Promise<string | null> {
  const resolved = await resolveInsidePackage(versionRoot, relativePath);
  if (!resolved) return null;
  try {
    return await readFile(resolved, "utf8");
  } catch {
    return null;
  }
}

/** Byte offsets of the first sample of every segment, derived from the playlist. */
function segmentStartTimes(playlist: ParsedMediaPlaylist): number[] {
  const starts: number[] = [];
  let elapsed = 0;
  for (const segment of playlist.segments) {
    starts.push(elapsed);
    elapsed += segment.durationSeconds;
  }
  return starts;
}

function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      error?: Error,
      value?: { code: number; stderr: string; stdout: string },
    ) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as { code: number; stderr: string; stdout: string });
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("Validation process was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 1024 * 1024);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) =>
      finish(undefined, { code: code ?? -1, stderr, stdout }),
    );
  });
}

/**
 * Writes `init + segments` from one rendition into a standalone fMP4.
 *
 * This is the shape a Media Source buffer holds after a quality change: the
 * initialization for the rendition being switched to, followed by that
 * rendition's segments from the switch point onwards. Reconstructing it on disk
 * is what lets a decoder be pointed at the exact splice the browser will make.
 */
async function extractSegmentSlice(
  mediaPath: string,
  playlist: ParsedMediaPlaylist,
  fromSegment: number,
  segmentCount: number,
  destination: string,
): Promise<void> {
  const handle = await open(mediaPath, "r");
  try {
    const parts: Buffer[] = [];
    const readRange = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error("Byte range read short of its declared length.");
      }
      return buffer;
    };

    parts.push(
      await readRange(
        playlist.map.byteRange.offset,
        playlist.map.byteRange.length,
      ),
    );
    for (
      let index = fromSegment;
      index < Math.min(fromSegment + segmentCount, playlist.segments.length);
      index += 1
    ) {
      const segment = playlist.segments[index];
      parts.push(
        await readRange(segment.byteRange.offset, segment.byteRange.length),
      );
    }
    await writeFile(destination, Buffer.concat(parts));
  } finally {
    await handle.close();
  }
}

async function firstPresentationTime(
  ffprobePath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const { code, stdout } = await runProcess(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time,flags",
      "-of",
      "csv=p=0",
      "-read_intervals",
      "%+#1",
      filePath,
    ],
    signal,
  );
  if (code !== 0) return null;
  const first = stdout.split(/\r?\n/).find((line) => line.trim() !== "");
  if (!first) return null;
  const [time, flags] = first.split(",");
  const parsed = Number(time);
  if (!Number.isFinite(parsed)) return null;
  // A slice that does not begin on a keyframe is not independently decodable,
  // which is the whole property being tested.
  return flags?.includes("K") ? parsed : null;
}

async function decodes(
  ffmpegPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { code } = await runProcess(
    ffmpegPath,
    ["-hide_banner", "-v", "error", "-i", filePath, "-f", "null", "-"],
    signal,
  );
  return code === 0;
}

function compareVideoAgainstMetadata(
  collector: ValidationCollector,
  rendition: AdaptiveVideoRenditionMetadata,
  probe: PackagedVideoProbe,
): void {
  const stage = "video-properties";
  if (probe.codec !== rendition.codec) {
    collector.add(
      rendition.id,
      stage,
      `codec is ${probe.codec}, metadata records ${rendition.codec}.`,
    );
  }
  if (probe.width !== rendition.width || probe.height !== rendition.height) {
    collector.add(
      rendition.id,
      stage,
      `dimensions are ${probe.width}x${probe.height}, metadata records ${rendition.width}x${rendition.height}.`,
    );
  }
  if (probe.pixelFormat !== rendition.pixelFormat) {
    collector.add(
      rendition.id,
      stage,
      `pixel format is ${probe.pixelFormat}, metadata records ${rendition.pixelFormat}.`,
    );
  }
  if (Math.abs(probe.frameRate - rendition.frameRate) > 0.01) {
    collector.add(
      rendition.id,
      stage,
      `frame rate is ${round(probe.frameRate)}, metadata records ${round(rendition.frameRate)}.`,
    );
  }

  if (rendition.hdr === "sdr") return;

  const hdrStage = "hdr-signalling";
  const expectedTransfer =
    rendition.hdr === "hdr10" ? "smpte2084" : "arib-std-b67";
  if ((probe.colorTransfer ?? "").toLowerCase() !== expectedTransfer) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour transfer is ${probe.colorTransfer ?? "unset"}, expected ${expectedTransfer}.`,
    );
  }
  if (
    rendition.colorPrimaries &&
    (probe.colorPrimaries ?? "").toLowerCase() !==
      rendition.colorPrimaries.toLowerCase()
  ) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour primaries are ${probe.colorPrimaries ?? "unset"}, metadata records ${rendition.colorPrimaries}.`,
    );
  }
  if (
    rendition.colorSpace &&
    (probe.colorSpace ?? "").toLowerCase() !==
      rendition.colorSpace.toLowerCase()
  ) {
    collector.add(
      rendition.id,
      hdrStage,
      `colour matrix is ${probe.colorSpace ?? "unset"}, metadata records ${rendition.colorSpace}.`,
    );
  }
  if (!probe.pixelFormat.includes("10")) {
    collector.add(
      rendition.id,
      hdrStage,
      `pixel format ${probe.pixelFormat} is not 10-bit, which an HDR rendition must be.`,
    );
  }
  if (probe.codecTag !== "hvc1") {
    collector.add(
      rendition.id,
      hdrStage,
      `codec tag is ${probe.codecTag || "unset"}, not hvc1; Safari refuses hev1-tagged media.`,
    );
  }
}

export async function validateAdaptivePackage({
  versionRoot,
  mediaId,
  sourceFingerprint,
  profileVersion,
  ffprobePath = process.env.FFPROBE_PATH ??
    process.env.SEYIRLIK_FFPROBE_PATH ??
    "ffprobe",
  ffmpegPath = process.env.FFMPEG_PATH ??
    process.env.SEYIRLIK_FFMPEG_PATH ??
    "ffmpeg",
  deep = false,
  allowMissingAudio = false,
  allowMissingVideo = false,
  signal,
  onProgress,
}: AdaptiveValidationOptions): Promise<AdaptiveValidationResult> {
  const collector = new ValidationCollector(mediaId);

  /*
   * A package is validated in two places: in the work directory before it is
   * published, where its layout is the build's own, and in the title folder
   * afterwards, where the paths are the library's names. Both carry the same
   * record under different filenames, so the layout is recognised rather than
   * demanded — an operator revalidating a published title should not have to
   * say which shape it is in.
   */
  const published = await readPackageFile(
    versionRoot,
    `${TITLE_PACKAGE_DIRECTORY}/${TITLE_BUILD_RECORD}`,
  );
  const metadataText =
    published ?? (await readPackageFile(versionRoot, ADAPTIVE_METADATA_FILE));
  if (metadataText === null) {
    collector.add(
      "package",
      "metadata",
      "metadata.json is missing or unreadable.",
    );
    return { ok: false, checks: collector.checks, issues: collector.issues };
  }

  let metadata: AdaptivePackageMetadata;
  try {
    metadata = parseAdaptiveMetadata(JSON.parse(metadataText), {
      mediaId,
      ...(sourceFingerprint ? { sourceFingerprint } : {}),
      ...(profileVersion ? { profileVersion } : {}),
      ...(published ? { enforceCanonicalPaths: false } : {}),
      ...(!published && allowMissingAudio ? { allowMissingAudio: true } : {}),
      ...(!published && allowMissingVideo ? { allowMissingVideo: true } : {}),
    });
  } catch (error) {
    collector.add(
      "package",
      "metadata",
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, checks: collector.checks, issues: collector.issues };
  }
  collector.pass("metadata-schema");

  /*
   * The workload, fixed here and never revised. Every entry below is a check
   * this run will genuinely perform on this package, and its byte cost is the
   * size of what that check reads — the manifest's own recorded file sizes,
   * which the structural checks then prove against the disk.
   */
  const planned: PlannedCheck[] = [
    { kind: "metadata", rendition: "package", weight: STRUCTURAL_CHECK_WEIGHT },
    {
      kind: "master-playlist",
      rendition: "package",
      weight: STRUCTURAL_CHECK_WEIGHT,
    },
    ...metadata.videoRenditions.map((rendition) => ({
      kind: "video-structure" as const,
      rendition: rendition.id,
      weight: STRUCTURAL_CHECK_WEIGHT,
    })),
    ...metadata.videoRenditions.map((rendition) => ({
      kind: "video-probe" as const,
      rendition: rendition.id,
      weight: rendition.fileSizeBytes,
    })),
    {
      kind: "cross-rendition",
      rendition: "package",
      weight: STRUCTURAL_CHECK_WEIGHT,
    },
    ...metadata.audioRenditions.map((rendition) => ({
      kind: "audio" as const,
      rendition: rendition.id,
      weight: rendition.fileSizeBytes,
    })),
    ...(metadata.subtitleRenditions ?? []).map((rendition) => ({
      kind: "subtitle" as const,
      rendition: rendition.id,
      weight: rendition.fileSizeBytes,
    })),
    ...(deep
      ? [
          ...metadata.videoRenditions.map((rendition) => ({
            kind: "seek-decode" as const,
            rendition: rendition.id,
            // Three probe points, two segments each, out of a file whose
            // segments average its size over its segment count.
            weight: deepSliceWeight(rendition, 3),
          })),
          ...(metadata.videoRenditions.length > 1
            ? metadata.videoRenditions.map((rendition) => ({
                kind: "cross-quality-splice" as const,
                rendition: rendition.id,
                weight: deepSliceWeight(rendition, 1),
              }))
            : []),
        ]
      : []),
  ];
  const progress = createVerificationReporter(
    planned,
    {
      videoRenditions: metadata.videoRenditions.length,
      audioRenditions: metadata.audioRenditions.length,
      subtitleRenditions: metadata.subtitleRenditions?.length ?? 0,
    },
    onProgress,
  );
  progress.complete("metadata", "package");
  progress.begin("master-playlist", "package");

  // 1 & 20. The master must exist, parse, and resolve inside the package.
  const masterText = await readPackageFile(
    versionRoot,
    metadata.masterPlaylistPath,
  );
  if (masterText === null) {
    collector.add(
      "package",
      "master-playlist",
      `${metadata.masterPlaylistPath} is missing, unreadable, or resolves outside the package.`,
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  try {
    const master = parseMasterPlaylist(masterText, {
      allowMissingVideo: !published && allowMissingVideo,
    });
    if (!master.independentSegments) {
      collector.add(
        "package",
        "master-playlist",
        "master playlist does not declare #EXT-X-INDEPENDENT-SEGMENTS.",
      );
    }
    /*
     * A master names its renditions relative to itself, and the manifest names
     * them relative to the package root. Those are the same path expressed from
     * two places, so both are brought to the package root before they are
     * compared — and percent-encoding is undone, because a published name
     * carries spaces a URI cannot.
     */
    const toPackageRelative = (uri: string): string => {
      const decoded = decodeURIComponent(uri);
      const base = posix.dirname(metadata.masterPlaylistPath);
      return base === "." ? decoded : posix.normalize(`${base}/${decoded}`);
    };
    const declaredVariants = new Set(
      master.variants.map((variant) => toPackageRelative(variant.uri)),
    );
    for (const rendition of metadata.videoRenditions) {
      if (!declaredVariants.has(rendition.playlistPath)) {
        collector.add(
          rendition.id,
          "master-playlist",
          `master playlist does not reference ${rendition.playlistPath}.`,
        );
      }
    }
    const declaredAudio = new Set(
      master.audioRenditions.map((entry) => toPackageRelative(entry.uri)),
    );
    for (const rendition of metadata.audioRenditions) {
      if (!declaredAudio.has(rendition.playlistPath)) {
        collector.add(
          rendition.id,
          "master-playlist",
          `master playlist does not reference ${rendition.playlistPath}.`,
        );
      }
    }
    const declaredSubtitles = new Set(
      master.subtitleRenditions.map((entry) => toPackageRelative(entry.uri)),
    );
    for (const rendition of metadata.subtitleRenditions ?? []) {
      if (!declaredSubtitles.has(rendition.playlistPath)) {
        collector.add(
          rendition.id,
          "master-playlist",
          `master playlist does not reference ${rendition.playlistPath}.`,
        );
      }
    }
    for (const variant of master.variants) {
      // A partial package's master describes only what its run produced; the
      // published master it merges into is where sound is guaranteed.
      if (!allowMissingAudio && !variant.audioGroup) {
        collector.add(
          "package",
          "master-playlist",
          `variant ${variant.uri} has no AUDIO group, so it carries no sound.`,
        );
      }
    }
    collector.pass("master-playlist");
    progress.complete("master-playlist", "package");
  } catch (error) {
    collector.add(
      "package",
      "master-playlist",
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  const frameTolerance =
    sourceFrameDurationSeconds(metadata.source.frameRate) +
    ALIGNMENT_EPSILON_SECONDS;

  interface LoadedRendition {
    id: string;
    playlist: ParsedMediaPlaylist;
    mediaPath: string;
    rendition: AdaptiveVideoRenditionMetadata;
    probe?: PackagedVideoProbe;
  }
  const loadedVideo: LoadedRendition[] = [];

  // 2-7. Playlists parse, media files exist, sizes match, ranges stay inside.
  for (const rendition of metadata.videoRenditions) {
    progress.begin("video-structure", rendition.id);
    const playlistText = await readPackageFile(
      versionRoot,
      rendition.playlistPath,
    );
    if (playlistText === null) {
      collector.add(
        rendition.id,
        "media-playlist",
        `${rendition.playlistPath} is missing, unreadable, or resolves outside the package.`,
      );
      continue;
    }
    let playlist: ParsedMediaPlaylist;
    try {
      playlist = parseMediaPlaylist(playlistText);
    } catch (error) {
      collector.add(
        rendition.id,
        "media-playlist",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (!playlist.independentSegments) {
      collector.add(
        rendition.id,
        "media-playlist",
        "media playlist does not declare #EXT-X-INDEPENDENT-SEGMENTS.",
      );
    }
    /*
     * One file per rendition is what makes byte ranges work, so the
     * initialisation range and every segment must name that one file — the
     * media file this rendition's own manifest entry points at, wherever the
     * package was laid out.
     */
    const expectedMediaUri = posix.relative(
      posix.dirname(rendition.playlistPath),
      rendition.mediaPath,
    );
    const namesTheMediaFile = (uri: string): boolean =>
      decodeURIComponent(uri) === expectedMediaUri;
    if (!namesTheMediaFile(playlist.map.uri)) {
      collector.add(
        rendition.id,
        "media-playlist",
        `#EXT-X-MAP points at ${playlist.map.uri}, not ${expectedMediaUri}.`,
      );
    }
    if (playlist.segments.some((segment) => !namesTheMediaFile(segment.uri))) {
      collector.add(
        rendition.id,
        "media-playlist",
        `a segment references a file other than ${expectedMediaUri}.`,
      );
    }
    if (playlist.segments.length !== rendition.segmentCount) {
      collector.add(
        rendition.id,
        "media-playlist",
        `playlist has ${playlist.segments.length} segments, metadata records ${rendition.segmentCount}.`,
      );
    }

    const mediaPath = await resolveInsidePackage(
      versionRoot,
      rendition.mediaPath,
    );
    if (!mediaPath) {
      collector.add(
        rendition.id,
        "media-file",
        `${rendition.mediaPath} is missing or resolves outside the package.`,
      );
      continue;
    }
    const stats = await stat(mediaPath).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) {
      collector.add(
        rendition.id,
        "media-file",
        "media file is missing or empty.",
      );
      continue;
    }
    if (stats.size !== rendition.fileSizeBytes) {
      collector.add(
        rendition.id,
        "media-file",
        `media file is ${stats.size} bytes, metadata records ${rendition.fileSizeBytes}; the file changed after validation.`,
      );
      continue;
    }

    // 4 & 5. Every declared range, including the init range, must lie wholly
    // inside the file the playlist names.
    if (
      playlist.map.byteRange.offset + playlist.map.byteRange.length >
      stats.size
    ) {
      collector.add(
        rendition.id,
        "byte-ranges",
        `#EXT-X-MAP range ${playlist.map.byteRange.offset}+${playlist.map.byteRange.length} exceeds the ${stats.size}-byte media file.`,
      );
    }
    for (const [index, segment] of playlist.segments.entries()) {
      const end = segment.byteRange.offset + segment.byteRange.length;
      if (end > stats.size) {
        collector.add(
          rendition.id,
          "byte-ranges",
          `segment ${index} range ${segment.byteRange.offset}+${segment.byteRange.length} exceeds the ${stats.size}-byte media file.`,
        );
        break;
      }
    }

    loadedVideo.push({ id: rendition.id, playlist, mediaPath, rendition });
    progress.complete("video-structure", rendition.id);
  }

  if (
    loadedVideo.length === 0 &&
    !(allowMissingVideo && !published && metadata.videoRenditions.length === 0)
  ) {
    collector.add(
      "package",
      "media-playlist",
      "no video rendition survived structural validation.",
    );
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }
  collector.pass("byte-ranges");
  collector.pass("media-playlists");

  // 8, 13, 14, 16, 19. Probe each rendition and compare against its claims.
  for (const entry of loadedVideo) {
    /*
     * The rendition's own declared length is the denominator. Taken from the
     * playlist rather than from the probe, because the probe is the thing being
     * measured and will not report a duration until it has finished.
     */
    progress.begin(
      "video-probe",
      entry.id,
      entry.playlist.totalDurationSeconds,
    );
    let probe: PackagedVideoProbe;
    try {
      probe = await probePackagedVideo(
        entry.mediaPath,
        ffprobePath,
        signal,
        (ptsSeconds) => progress.advance(ptsSeconds),
      );
    } catch (error) {
      collector.add(
        entry.id,
        "probe",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    entry.probe = probe;
    compareVideoAgainstMetadata(collector, entry.rendition, probe);

    if (probe.keyframeTimes.length !== entry.rendition.keyframeCount) {
      collector.add(
        entry.id,
        "keyframes",
        `probe found ${probe.keyframeTimes.length} keyframes, metadata records ${entry.rendition.keyframeCount}.`,
      );
    }

    // 16. The playlist's declared timeline must match the samples it describes.
    const playlistDuration = entry.playlist.totalDurationSeconds;
    if (
      Math.abs(playlistDuration - probe.durationSeconds) >
      VIDEO_DURATION_TOLERANCE_SECONDS
    ) {
      collector.add(
        entry.id,
        "extinf-accuracy",
        `EXTINF durations sum to ${round(playlistDuration)}s but the media decodes to ${round(probe.durationSeconds)}s.`,
      );
    }

    // 13. Every segment must begin on a random-access frame.
    const baseTime = probe.keyframeTimes[0] ?? 0;
    const starts = segmentStartTimes(entry.playlist);
    for (const [index, start] of starts.entries()) {
      const wanted = baseTime + start;
      const nearest = probe.keyframeTimes.reduce(
        (best, time) =>
          Math.abs(time - wanted) < Math.abs(best - wanted) ? time : best,
        Number.POSITIVE_INFINITY,
      );
      if (Math.abs(nearest - wanted) > frameTolerance) {
        collector.add(
          entry.id,
          "segment-keyframe-start",
          `segment ${index} starts at ${round(wanted)}s but the nearest keyframe is at ${round(nearest)}s, ${round(Math.abs(nearest - wanted))}s away (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }

    // 15. Keyframes must advance monotonically at roughly the target interval.
    for (let index = 1; index < probe.keyframeTimes.length; index += 1) {
      const gap = probe.keyframeTimes[index] - probe.keyframeTimes[index - 1];
      if (gap <= 0) {
        collector.add(
          entry.id,
          "timestamp-continuity",
          `keyframe ${index} at ${round(probe.keyframeTimes[index])}s does not advance past the previous one.`,
        );
        break;
      }
    }
    progress.complete("video-probe", entry.id);
  }

  const probed = loadedVideo.filter(
    (entry): entry is LoadedRendition & { probe: PackagedVideoProbe } =>
      entry.probe !== undefined,
  );
  if (probed.length !== loadedVideo.length) {
    return {
      ok: false,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }
  collector.pass("video-properties");
  collector.pass("segment-keyframe-start");
  collector.pass("extinf-accuracy");
  collector.pass("timestamp-continuity");

  // 10 & 12. Every video rendition must describe the same timeline, segment for
  // segment. This is the property that makes a mid-playback switch invisible.
  const reference = probed[0];
  progress.begin("cross-rendition", "package");
  for (const entry of probed.slice(1)) {
    if (entry.playlist.segments.length !== reference.playlist.segments.length) {
      collector.add(
        entry.id,
        "segment-alignment",
        `has ${entry.playlist.segments.length} segments but ${reference.id} has ${reference.playlist.segments.length}.`,
      );
      continue;
    }
    const referenceStarts = segmentStartTimes(reference.playlist);
    const entryStarts = segmentStartTimes(entry.playlist);
    for (let index = 0; index < entryStarts.length; index += 1) {
      const drift = Math.abs(entryStarts[index] - referenceStarts[index]);
      if (drift > frameTolerance) {
        collector.add(
          entry.id,
          "segment-alignment",
          `segment ${index} starts at ${round(entryStarts[index])}s but ${reference.id} starts it at ${round(referenceStarts[index])}s, a drift of ${round(drift)}s (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }
    const durationDrift = Math.abs(
      entry.playlist.totalDurationSeconds -
        reference.playlist.totalDurationSeconds,
    );
    if (durationDrift > VIDEO_DURATION_TOLERANCE_SECONDS) {
      collector.add(
        entry.id,
        "switching-set-duration",
        `covers ${round(entry.playlist.totalDurationSeconds)}s but ${reference.id} covers ${round(reference.playlist.totalDurationSeconds)}s.`,
      );
    }

    // 14. Keyframe instants themselves, not merely the boundaries derived from
    // EXTINF, must line up.
    const referenceBase = reference.probe.keyframeTimes[0] ?? 0;
    const entryBase = entry.probe.keyframeTimes[0] ?? 0;
    const shared = Math.min(
      entry.probe.keyframeTimes.length,
      reference.probe.keyframeTimes.length,
    );
    for (let index = 0; index < shared; index += 1) {
      const drift = Math.abs(
        entry.probe.keyframeTimes[index] -
          entryBase -
          (reference.probe.keyframeTimes[index] - referenceBase),
      );
      if (drift > frameTolerance) {
        collector.add(
          entry.id,
          "keyframe-alignment",
          `keyframe ${index} is ${round(drift)}s away from the matching keyframe in ${reference.id} (tolerance ${round(frameTolerance)}s).`,
        );
        break;
      }
    }
  }
  collector.pass("segment-alignment");
  collector.pass("keyframe-alignment");
  collector.pass("switching-set-duration");
  progress.complete("cross-rendition", "package");

  // 9 & 11. Audio must match its metadata and cover the same content.
  for (const rendition of metadata.audioRenditions) {
    progress.begin("audio", rendition.id);
    const playlistText = await readPackageFile(
      versionRoot,
      rendition.playlistPath,
    );
    if (playlistText === null) {
      collector.add(
        rendition.id,
        "audio-playlist",
        `${rendition.playlistPath} is missing, unreadable, or resolves outside the package.`,
      );
      continue;
    }
    let playlist: ParsedMediaPlaylist;
    try {
      playlist = parseMediaPlaylist(playlistText);
    } catch (error) {
      collector.add(
        rendition.id,
        "audio-playlist",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }

    const mediaPath = await resolveInsidePackage(
      versionRoot,
      rendition.mediaPath,
    );
    if (!mediaPath) {
      collector.add(
        rendition.id,
        "audio-media-file",
        `${rendition.mediaPath} is missing or resolves outside the package.`,
      );
      continue;
    }
    const stats = await stat(mediaPath).catch(() => null);
    if (!stats?.isFile() || stats.size === 0) {
      collector.add(
        rendition.id,
        "audio-media-file",
        "audio media file is missing or empty.",
      );
      continue;
    }
    if (stats.size !== rendition.fileSizeBytes) {
      collector.add(
        rendition.id,
        "audio-media-file",
        `audio media file is ${stats.size} bytes, metadata records ${rendition.fileSizeBytes}.`,
      );
      continue;
    }
    if (
      playlist.map.byteRange.offset + playlist.map.byteRange.length >
        stats.size ||
      playlist.segments.some(
        (segment) =>
          segment.byteRange.offset + segment.byteRange.length > stats.size,
      )
    ) {
      collector.add(
        rendition.id,
        "audio-byte-ranges",
        `a declared byte range exceeds the ${stats.size}-byte audio media file.`,
      );
      continue;
    }

    try {
      const probe = await probePackagedAudio(mediaPath, ffprobePath, signal);
      if (probe.codec !== rendition.codec) {
        collector.add(
          rendition.id,
          "audio-properties",
          `codec is ${probe.codec}, metadata records ${rendition.codec}.`,
        );
      }
      if (probe.channels !== rendition.channels) {
        collector.add(
          rendition.id,
          "audio-properties",
          `has ${probe.channels} channels, metadata records ${rendition.channels}.`,
        );
      }
      if (probe.sampleRate !== rendition.sampleRate) {
        collector.add(
          rendition.id,
          "audio-properties",
          `sample rate is ${probe.sampleRate}Hz, metadata records ${rendition.sampleRate}Hz.`,
        );
      }
      const coverageDrift = Math.abs(
        probe.durationSeconds -
          (reference?.playlist.totalDurationSeconds ??
            metadata.switchingSetDurationSeconds),
      );
      if (coverageDrift > AUDIO_DURATION_TOLERANCE_SECONDS) {
        collector.add(
          rendition.id,
          "audio-video-coverage",
          `covers ${round(probe.durationSeconds)}s but the switching set covers ${round(reference?.playlist.totalDurationSeconds ?? metadata.switchingSetDurationSeconds)}s, a difference of ${round(coverageDrift)}s.`,
        );
      }
    } catch (error) {
      collector.add(
        rendition.id,
        "audio-probe",
        error instanceof Error ? error.message : String(error),
      );
    }
    progress.complete("audio", rendition.id);
  }
  collector.pass("audio-properties");
  collector.pass("audio-video-coverage");

  for (const rendition of metadata.subtitleRenditions ?? []) {
    progress.begin("subtitle", rendition.id);
    const playlistText = await readPackageFile(
      versionRoot,
      rendition.playlistPath,
    );
    if (playlistText === null) {
      collector.add(
        rendition.id,
        "subtitle-playlist",
        `${rendition.playlistPath} is missing, unreadable, or resolves outside the package.`,
      );
      continue;
    }
    try {
      const playlist = parseWebVttMediaPlaylist(playlistText);
      /*
       * Resolved against the playlist's own location, exactly as the video and
       * audio checks do. Comparing against a bare filename assumed the playlist
       * sits beside its media, which stopped being true when playlists moved
       * into the hidden package directory and the media stayed in the folder a
       * person browses — so every published title carrying subtitles failed
       * validation while being perfectly correct.
       */
      const expectedSubtitleUri = path.posix.relative(
        path.posix.dirname(rendition.playlistPath),
        rendition.subtitlePath,
      );
      if (decodeURIComponent(playlist.uri) !== expectedSubtitleUri) {
        collector.add(
          rendition.id,
          "subtitle-playlist",
          `subtitle playlist points at ${playlist.uri}, not ${expectedSubtitleUri}.`,
        );
      }
      if (
        Math.abs(playlist.durationSeconds - rendition.durationSeconds) >
        AUDIO_DURATION_TOLERANCE_SECONDS
      ) {
        collector.add(
          rendition.id,
          "subtitle-timeline",
          "subtitle playlist duration does not match its metadata.",
        );
      }
    } catch (error) {
      collector.add(
        rendition.id,
        "subtitle-playlist",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    const subtitlePath = await resolveInsidePackage(
      versionRoot,
      rendition.subtitlePath,
    );
    if (!subtitlePath) {
      collector.add(
        rendition.id,
        "subtitle-file",
        `${rendition.subtitlePath} is missing or resolves outside the package.`,
      );
      continue;
    }
    const subtitleStats = await stat(subtitlePath).catch(() => null);
    const contents = await readFile(subtitlePath, "utf8").catch(() => "");
    if (
      !subtitleStats?.isFile() ||
      subtitleStats.size !== rendition.fileSizeBytes ||
      !/^WEBVTT(?:\s|$)/.test(contents)
    ) {
      collector.add(
        rendition.id,
        "subtitle-file",
        "subtitle file is missing, changed, or is not valid WebVTT.",
      );
    }
    progress.complete("subtitle", rendition.id);
  }
  if ((metadata.subtitleRenditions?.length ?? 0) > 0) {
    collector.pass("webvtt-subtitles");
    collector.pass("subtitle-metadata");
  }

  if (!deep || !reference) {
    progress.finish(collector.ok);
    return {
      ok: collector.ok,
      checks: collector.checks,
      issues: collector.issues,
      metadata,
    };
  }

  // 17 & 18. Decode-level proof. Slices are reconstructed the way a Media
  // Source buffer holds them after a switch — the target rendition's own
  // initialization followed by its segments from the splice point — and each
  // must decode and begin exactly at the boundary the ladder shares.
  const workDirectory = await mkdtemp(
    path.join(tmpdir(), "seyirlik-adaptive-check-"),
  );
  try {
    const segmentTotal = reference.playlist.segments.length;
    const probePoints = [
      0,
      Math.floor(segmentTotal / 2),
      Math.max(0, segmentTotal - 2),
    ].filter((value, index, all) => all.indexOf(value) === index);

    for (const entry of probed) {
      progress.begin("seek-decode", entry.id);
      const starts = segmentStartTimes(entry.playlist);
      const base = entry.probe.keyframeTimes[0] ?? 0;
      for (const point of probePoints) {
        const slicePath = path.join(
          workDirectory,
          `${entry.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${point}.mp4`,
        );
        try {
          await extractSegmentSlice(
            entry.mediaPath,
            entry.playlist,
            point,
            2,
            slicePath,
          );
        } catch (error) {
          collector.add(
            entry.id,
            "seek-decode",
            `could not read the byte ranges for segment ${point}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (!(await decodes(ffmpegPath, slicePath, signal))) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} (${round(starts[point])}s) does not decode independently.`,
          );
          continue;
        }
        const firstTime = await firstPresentationTime(
          ffprobePath,
          slicePath,
          signal,
        );
        if (firstTime === null) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} does not begin on a random-access frame.`,
          );
          continue;
        }
        const expected = base + starts[point];
        if (Math.abs(firstTime - expected) > frameTolerance) {
          collector.add(
            entry.id,
            "seek-decode",
            `the slice starting at segment ${point} begins at ${round(firstTime)}s, ${round(Math.abs(firstTime - expected))}s from the ${round(expected)}s the playlist promises.`,
          );
        }
        await rm(slicePath, { force: true });
      }
      progress.complete("seek-decode", entry.id);
    }
    collector.pass("seek-decode");

    // A cross-quality switch is two independently decodable slices meeting at
    // one instant. Proving both sides start at the same presentation time — and
    // that each decodes on its own — is what makes the splice sample-accurate.
    if (probed.length > 1) {
      const splicePoint = Math.max(1, Math.floor(segmentTotal / 2));
      const spliceTimes: Array<{ id: string; time: number }> = [];
      for (const entry of probed) {
        progress.begin("cross-quality-splice", entry.id);
        const slicePath = path.join(
          workDirectory,
          `splice-${entry.id.replace(/[^A-Za-z0-9_-]/g, "_")}.mp4`,
        );
        await extractSegmentSlice(
          entry.mediaPath,
          entry.playlist,
          splicePoint,
          2,
          slicePath,
        );
        if (!(await decodes(ffmpegPath, slicePath, signal))) {
          collector.add(
            entry.id,
            "cross-quality-splice",
            `the segment-${splicePoint} slice does not decode on its own, so a switch into this rendition would stall.`,
          );
          continue;
        }
        const firstTime = await firstPresentationTime(
          ffprobePath,
          slicePath,
          signal,
        );
        if (firstTime === null) {
          collector.add(
            entry.id,
            "cross-quality-splice",
            `the segment-${splicePoint} slice does not begin on a random-access frame.`,
          );
          continue;
        }
        const base = entry.probe.keyframeTimes[0] ?? 0;
        spliceTimes.push({ id: entry.id, time: firstTime - base });
        await rm(slicePath, { force: true });
        progress.complete("cross-quality-splice", entry.id);
      }
      for (const candidate of spliceTimes.slice(1)) {
        const drift = Math.abs(candidate.time - spliceTimes[0].time);
        if (drift > frameTolerance) {
          collector.add(
            candidate.id,
            "cross-quality-splice",
            `enters segment ${splicePoint} at ${round(candidate.time)}s but ${spliceTimes[0].id} enters it at ${round(spliceTimes[0].time)}s, a drift of ${round(drift)}s.`,
          );
        }
      }
      collector.pass("cross-quality-splice");
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  progress.finish(collector.ok);
  return {
    ok: collector.ok,
    checks: collector.checks,
    issues: collector.issues,
    metadata,
  };
}

export function formatValidationIssue(issue: AdaptiveValidationIssue): string {
  return `${issue.mediaId}\t${issue.rendition}\t${issue.stage}\t${issue.message}`;
}
