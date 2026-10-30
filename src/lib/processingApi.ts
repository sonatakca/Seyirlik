import { ownApiClient, ownApiUrl } from "../api/ownApi/client";
/*
 * Type-only, so nothing from the packaging layer is bundled into the browser:
 * these are the exact shapes the worker measures and the live stream carries,
 * and restating them here would let the two drift apart silently.
 */
import type {
  AssemblyPhaseProgress,
  AssemblyRenditionProgress,
  AudioPhaseProgress,
  AudioTrackProgress,
  PlanningPhaseProgress,
  PublishPhaseProgress,
  PublishStepProgress,
  SubtitlePhaseProgress,
  SubtitleTrackProgress,
  VerificationPhaseProgress,
} from "../renditions/adaptive/phaseProgress";
import type {
  SourceDamageRecord,
  SourceInterval,
} from "../renditions/adaptive/epochs/salvage";
import type { SourceIoStatus } from "../server/ownApi/processing/liveProgress";
import type { DriveUploadStatus } from "../server/ownApi/processing/driveUploadStatus";

export type {
  DriveUploadStatus,
  SourceDamageRecord,
  SourceInterval,
  SourceIoStatus,
};

export type {
  AssemblyPhaseProgress,
  AssemblyRenditionProgress,
  AudioPhaseProgress,
  AudioTrackProgress,
  PlanningPhaseProgress,
  PublishPhaseProgress,
  PublishStepProgress,
  SubtitlePhaseProgress,
  SubtitleTrackProgress,
  VerificationPhaseProgress,
};

/** One finished phase, summarised for the history strip. */
export interface CompletedPhaseSummary {
  phase: ProcessingBuildPhase;
  elapsedSeconds: number;
  bytes?: number;
  count?: number;
  reused?: boolean;
}

/**
 * Client for the media-processing administration API.
 *
 * Kept apart from `mediaApi` because nothing here is part of playback: these
 * calls are only reachable by an administrator and only from the processing
 * page.
 */

export type ProcessingState =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProcessingStage =
  | "waiting"
  | "analysing"
  | "planning"
  | "video"
  | "audio"
  | "subtitles"
  | "packaging"
  | "validating"
  | "publishing"
  | "complete";

export interface ProcessingLadderRung {
  qualityHeight: number;
  width: number;
  height: number;
}

export interface ProcessingAudioDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  channels?: number;
  channelLayout?: string;
  title?: string;
  isDefault: boolean;
  isCommentary: boolean;
  keep: boolean;
  reason: string;
  explanation: string;
}

export interface ProcessingSubtitleDecision {
  streamIndex: number;
  language: string;
  languageName: string;
  codec: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isHearingImpaired: boolean;
  isTextBased: boolean;
  keep: boolean;
  reason: string;
  requiresOcr: boolean;
  explanation: string;
}

export interface ProcessingDecision {
  action: string;
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
    bitDepth?: number;
    pixelFormat?: string;
    isHdr: boolean;
    colorTransfer?: string;
    colorPrimaries?: string;
  };
  ladder: ProcessingLadderRung[];
  /**
   * The rungs this job will actually encode. Absent on jobs recorded before
   * processing became incremental, where the whole ladder was always built.
   */
  renditionsToEncode?: number[];
  incremental?: boolean;
  videoCodec: "h264" | "hevc";
  videoEncoder: string;
  hardwareAdapter: string;
  preservesHdr: boolean;
  streams: {
    audio: ProcessingAudioDecision[];
    subtitles: ProcessingSubtitleDecision[];
    keptAudioStreamIndexes: number[];
    keptSubtitleStreamIndexes: number[];
    warnings: string[];
  };
  estimate: {
    outputBytes: number;
    stagingBytes: number;
    freeBytes?: number;
    sufficient: boolean;
    reserveBytes: number;
  };
  warnings: string[];
}

export interface ProcessingJob {
  id: string;
  itemId: string;
  mediaFileId: string;
  profile: string;
  state: ProcessingState;
  stage: ProcessingStage;
  stageProgress: number;
  overallProgress: number;
  bytesProcessed: number;
  /**
   * Bytes this job has physically written.
   *
   * Distinct from `outputBytes`, which is the whole published package: an
   * incremental job that adds one rendition writes a fraction of what the
   * title holds, and reporting the package total as this job's output is what
   * showed a 5%-complete run as having produced 10 GiB.
   */
  actualOutputBytes: number;
  outputBytes: number | null;
  estimatedOutputBytes: number | null;
  estimatedStagingBytes: number | null;
  speed: number | null;
  fps: number | null;
  etaSeconds: number | null;
  hardwareAdapter: string | null;
  videoEncoder: string | null;
  /** The machine that planned this attempt; null until a worker plans it. */
  processedBy?: string | null;
  decision: ProcessingDecision | null;
  validation: { ok: boolean; issues: string[] } | null;
  warnings: string[];
  /**
   * Intervals of the source that could not be read and were replaced.
   *
   * Null for a clean encode. A succeeded job carrying these is *salvaged*: the
   * package is playable and on the source's own timeline, with black picture
   * and silence where the disk could not answer. The page must not present the
   * two as the same outcome.
   */
  sourceDamage: SourceDamageRecord[] | null;
  /**
   * One summary per finished build phase, kept on the row so a finished card
   * can still say how its build went. Absent from servers that predate it.
   */
  phaseHistory?: CompletedPhaseSummary[] | null;
  /**
   * The package's upload to Google Drive after publication, where publishing
   * only reached a mount's cache. Null where there is no such upload.
   */
  driveUpload?: DriveUploadStatus | null;
  errorCode: string | null;
  errorMessage: string | null;
  publishedVersion: string | null;
  attempts: number;
  cancellationRequested: boolean;
  pauseRequested: boolean;
  /**
   * Why the job is paused, and who may un-pause it.
   *
   * Only `storage-unavailable` comes back on its own. The other two mean a
   * person has to look: `storage-quarantined` is an established I/O fault, and
   * `recovery-pending` is an attempt whose ending nobody observed.
   */
  pausedReason:
    | "operator"
    | "storage-unavailable"
    | "storage-quarantined"
    | "recovery-pending"
    | null;
  /**
   * The checkpointed build's position.
   *
   * `encodedSeconds / sourceDurationSeconds` is how much of the film has been
   * encoded, and is the only figure that may be shown as encoding progress.
   * `overallProgress` remains a whole-workflow weighting and reads as nearly
   * done long before the encoder is.
   */
  epochCount: number | null;
  epochIndex: number | null;
  completedEpochs: number;
  /** Media time that would survive the machine losing power right now. */
  protectedSeconds: number;
  encodedSeconds: number;
  sourceDurationSeconds: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  /** Bytes of encoded media protected by checkpoints. */
  checkpointBytes: number;
  freeBytes: number | null;
  /**
   * Where the job sits in the waiting line.
   *
   * A number only while the job is genuinely waiting; `null` once it has been
   * claimed or has finished, which is what makes a row draggable or not.
   * Absent from servers predating the ordered queue — read as "this server
   * cannot be reordered", never as "this job is next".
   */
  queuePriority?: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Where a checkpointed build is, in terms an operator recognises. */
export type ProcessingBuildPhase =
  | "planning"
  | "encoding"
  | "audio"
  | "subtitles"
  | "assembling"
  | "validating"
  | "publishing";

/**
 * One high-frequency sample from the running encoder.
 *
 * Delivered on its own event so it can arrive four times a second without the
 * job row being written that often. Everything in it is transient: a page that
 * has none of it still shows the durable figures from the job record.
 */
export interface ProcessingLiveProgress {
  processingJobId: string;
  revision: number;
  /** When the sample was published. Refreshed by the worker's heartbeat. */
  timestampMs: number;
  /**
   * When the values were last actually measured, which is not the same thing.
   * A phase inside one long operation keeps publishing the same figures so the
   * panel survives; this is what says they have not moved.
   */
  confirmedAtMs?: number;
  stage: ProcessingStage;
  phase: ProcessingBuildPhase;
  epochIndex: number | null;
  epochCount: number | null;
  epochStartSeconds: number | null;
  epochEndSeconds: number | null;
  epochFraction: number | null;
  completedEpochs: number;
  protectedSeconds: number;
  encodedSeconds: number;
  sourceDurationSeconds: number;
  fps?: number;
  speed?: number;
  smoothedSpeed?: number;
  etaSeconds?: number;
  writtenBytes?: number;
  encoder?: string;
  qualityHeights?: number[];
  /**
   * Cumulative progress across the whole job, in [0,1).
   *
   * Drawn as a bar and never printed as a number: everything inside a phase is
   * measured exactly, while the boundaries between phases rest on an estimate
   * of their relative cost, and a percentage would claim a precision the second
   * half of that does not have.
   */
  globalProgress?: number;
  /** How far through the current phase, by that phase's own measure. */
  phaseFraction?: number;
  /** When the current phase began, so a panel can say how long it has run. */
  phaseStartedAtMs?: number;
  /** Present only for the phase named by `phase`. */
  planning?: PlanningPhaseProgress;
  audio?: AudioPhaseProgress;
  subtitles?: SubtitlePhaseProgress;
  assembly?: AssemblyPhaseProgress;
  verification?: VerificationPhaseProgress;
  publish?: PublishPhaseProgress;
  completedPhases?: CompletedPhaseSummary[];
  /** The source-read diagnosis, present only while there is one to make. */
  sourceIo?: SourceIoStatus;
  /** Intervals already replaced in this attempt. */
  sourceDamage?: SourceDamageRecord[];
}

export interface ProcessingJobEvent {
  sequence: number;
  stage: ProcessingStage;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: string;
}

export interface HardwareLane {
  family: "h264" | "hevc";
  tenBit: boolean;
  encoder: string | null;
  available: boolean;
  reason?: string;
  detail?: string;
}

export interface HardwareAdapterReport {
  id: string;
  label: string;
  platform: string;
  available: boolean;
  reason?: string;
  detail?: string;
  lanes: HardwareLane[];
}

export interface HardwareReport {
  platform: string;
  probedAt: string;
  adapters: HardwareAdapterReport[];
  selected: { h264: string; hevc: string; hevcTenBit: string };
  selectedAdapter: { h264: string; hevc: string; hevcTenBit: string };
}

/**
 * What the server remembers about the storage, as opposed to what the storage
 * currently says about itself.
 *
 * The distinction is the entire point of the panel this feeds. A drive whose
 * USB bridge is returning `EIO` still answers a `stat` instantly, so "is it
 * mounted" is the question that was being asked throughout the incident that
 * required two forced power-offs. This is the answer to the other one.
 */
export type StorageHealthState =
  | "healthy"
  | "unavailable"
  | "suspect"
  | "quarantined"
  | "recovery-pending";

export interface ProcessingStorageHealth {
  root: string;
  state: StorageHealthState;
  /** One sentence, already written for an operator. Shown verbatim. */
  summary: string;
  reason: string;
  faultCount: number;
  missingRoots: string[];
  firstFaultAt: string | null;
  lastFaultAt: string | null;
  changedAt: string;
  verifiedAt: string | null;
  mayStartWork: boolean;
  /** True whenever the volume returning is not, on its own, enough. */
  automaticResumeBlocked: boolean;
  /** The next step is the operator's cheap, non-destructive check. */
  awaitingVerification: boolean;
  /** Verification passed; only the explicit resume press remains. */
  awaitingResume: boolean;
}

// ------------------------------------------------------- the catalogue view

/**
 * What the processing page knows about a title before anything is running.
 *
 * One shape for a film and for one episode of a show, because the thing being
 * processed is the same in both cases: a canonical source file, a plan for it,
 * a package on disk, and at most one job. What differs is only where it sits
 * and what it is called.
 */
export type ProcessingPackageState =
  /** The server has not read this title's manifest yet. Not "nothing there". */
  "unknown" | "none" | "partial" | "complete" | "stale";

export interface ProcessingPackageSummary {
  present: boolean;
  current: boolean;
  sourceMatches: boolean;
  profileMatches: boolean;
  rungs: number[];
  complete: boolean;
  hdr: string;
  audioTracks: number;
  subtitleTracks: number;
  totalBytes: number;
}

export interface ProcessingSourceSummary {
  width: number;
  height: number;
  qualityHeight: number;
  videoCodec: string;
  frameRate: number | null;
  bitDepth: number | null;
  isHdr: boolean;
  /** `SDR`, `HDR10` or `HLG`, already resolved for display. */
  dynamicRange: string;
  durationSeconds: number;
  sizeBytes: number;
  container: string;
  audioTracks: number;
  subtitleTracks: number;
  externalSubtitles: number;
}

export interface ProcessingPlanSummary {
  action: string;
  summary: string;
  videoCodec: "h264" | "hevc";
  videoEncoder: string;
  hardwareAdapter: string;
  preservesHdr: boolean;
  ladder: number[];
  missingRungs: number[];
  estimatedOutputBytes: number;
  audioTracksKept: number;
  subtitleTracksKept: number;
}

export interface ProcessingTitle {
  itemId: string;
  mediaFileId: string | null;
  title: string;
  sortTitle: string;
  sourceAvailable: boolean;
  /** Above one means alternate representations; only the canonical is used. */
  fileCount: number;
  probed: boolean;
  source: ProcessingSourceSummary | null;
  plan: ProcessingPlanSummary | null;
  package: ProcessingPackageSummary | null;
  packageState: ProcessingPackageState;
  activeJobId: string | null;
  activeJobState: ProcessingState | null;
  processable: boolean;
}

export interface ProcessingMovieTitle extends ProcessingTitle {
  productionYear: number | null;
}

export interface ProcessingEpisode extends ProcessingTitle {
  seasonNumber: number;
  episodeNumber: number | null;
  /** `S01E01`. */
  code: string;
}

export interface ProcessingStateCounts {
  total: number;
  complete: number;
  partial: number;
  unprocessed: number;
  unknown: number;
  active: number;
  unavailable: number;
  /** How many a bulk press would queue right now. */
  eligible: number;
}

export interface ProcessingSeason {
  seasonId: string;
  seasonNumber: number;
  title: string;
  episodes: ProcessingEpisode[];
  counts: ProcessingStateCounts;
}

export interface ProcessingSeries {
  seriesId: string;
  title: string;
  sortTitle: string;
  productionYear: number | null;
  seasonCount: number;
  episodeCount: number;
  seasons: ProcessingSeason[];
  counts: ProcessingStateCounts;
}

/** What a queued or running job is called, so the queue tab can identify it. */
export interface ProcessingJobTitle {
  jobId: string;
  kind: "movie" | "episode";
  seriesTitle?: string;
  code?: string;
  /*
   * Optional for the same reason the catalogue itself is: a server that
   * predates them says nothing rather than zero. The queue reads the code as a
   * fallback, so grouping a show by season and episode still works — it simply
   * trusts a label instead of a number.
   */
  seasonNumber?: number;
  episodeNumber?: number | null;
  title: string;
}

/** What a season or series press did. */
export interface BulkProcessingOutcome {
  queued: number;
  alreadyQueued: number;
  alreadyComplete: number;
  unavailable: number;
  failed: number;
  jobIds: string[];
  skipped: Array<{
    itemId: string;
    mediaFileId: string | null;
    reason: string;
    detail?: string;
  }>;
}

export interface ProcessingOverview {
  counts: Record<ProcessingState, number>;
  hardware: HardwareReport;
  jobs: ProcessingJob[];
  stages: ProcessingStage[];
  profile: string;
  storage: ProcessingStorageHealth;
  /*
   * Optional so a page can be served by a server that predates them. Absent is
   * read as "this server has no catalogue view", never as "the library is
   * empty" — the two look identical to a reader that defaults them to `[]`
   * without saying why.
   */
  movies?: ProcessingMovieTitle[];
  series?: ProcessingSeries[];
  jobTitles?: ProcessingJobTitle[];
}

/**
 * The overview carries every unfinished job and one page of concluded ones.
 * `history` picks that page; without it the server sends the newest.
 */
export function getProcessingOverview({
  background = false,
  history,
}: {
  background?: boolean;
  history?: { offset: number; limit: number };
} = {}): Promise<ProcessingOverview> {
  const query = history
    ? `?historyOffset=${history.offset}&historyLimit=${history.limit}`
    : "";
  return ownApiClient.request<ProcessingOverview>(
    `/processing/overview${query}`,
    background ? { background } : undefined,
  );
}

export function getProcessingHardware(): Promise<HardwareReport> {
  return ownApiClient.request<HardwareReport>("/processing/hardware");
}

/** What the title already holds, so a preview can describe the work left. */
export type ExistingPackage =
  | { present: false }
  | {
      present: true;
      /** True when the package was built from these bytes under this profile. */
      current: boolean;
      sourceMatches: boolean;
      profileMatches: boolean;
      rungs: number[];
      /**
       * True when the package holds every standard rung at or below its own
       * best one — a whole ladder, judged without the source. Absent from
       * servers predating it.
       */
      complete?: boolean;
      /**
       * The package's transfer characteristic: "sdr", "hdr10" or "hlg".
       * Absent from servers predating it, so read it as unknown, not as SDR.
       */
      hdr?: string;
      /**
       * Rungs today's ladder would add to this package.
       *
       * Separate from `current`: a package can match its source and profile
       * exactly and still be a rung short, because a ladder gaining a rung
       * does not make what is on disk unreadable.
       */
      missingRungs: number[];
      audioTracks: number;
      subtitleTracks: number;
      totalBytes: number;
    };

interface ProcessingPreviewBase {
  itemId: string;
  mediaFileId: string;
  relativePath: string;
  existing: ExistingPackage;
  activeJobId: string | null;
}

/**
 * A preview describes a title, not only the work waiting for it.
 *
 * The source can be deleted while the package built from it stays on disk, so
 * `sourceAvailable` is false rather than the request failing: there is no
 * decision to show, but the renditions the title still holds are worth seeing.
 */
export type ProcessingPreview =
  | (ProcessingPreviewBase & {
      /*
       * Optional, and only ever `true`, so that a server predating this field
       * is read as "the source is there" — which is what every response it can
       * produce means. Absence must not be mistaken for absence of a source.
       */
      sourceAvailable?: true;
      sourceFingerprint: string;
      decision: ProcessingDecision;
    })
  | (ProcessingPreviewBase & {
      sourceAvailable: false;
      sourceFingerprint: null;
      decision: null;
    });

export function previewProcessing(
  itemId: string,
  mediaFileId?: string,
): Promise<ProcessingPreview> {
  return ownApiClient.request<ProcessingPreview>("/processing/preview", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

export function enqueueProcessing(
  itemId: string,
  mediaFileId?: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>("/processing/jobs", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

/**
 * Removes the source file of a title whose package already holds every
 * rendition.
 *
 * Separate from anything in the job lifecycle: it queues nothing and touches
 * no package, it only takes away the bytes a finished title no longer needs.
 * The server re-checks the package before unlinking, so a refusal here is a
 * real answer about the title and not a stale preview.
 */
export function deleteProcessingSource(
  itemId: string,
  mediaFileId?: string,
): Promise<{
  deleted: boolean;
  /** True when the file was already gone, which is not a failure. */
  alreadyAbsent: boolean;
  freedBytes: number;
}> {
  return ownApiClient.request("/processing/source/delete", {
    method: "POST",
    body: { itemId, ...(mediaFileId ? { mediaFileId } : {}) },
  });
}

export function listProcessingJobs(limit = 50): Promise<ProcessingJob[]> {
  return ownApiClient.request<ProcessingJob[]>(
    `/processing/jobs?limit=${encodeURIComponent(String(limit))}`,
  );
}

export function getProcessingJob(
  jobId: string,
  afterSequence = 0,
): Promise<{
  job: ProcessingJob;
  /**
   * The latest encoder sample, when one is fresh enough to trust.
   *
   * Carried on the snapshot as well as on the stream so a page that has just
   * reconnected does not have to wait for the next tick before it can say where
   * the encode is — that wait is what made a refresh look like a stall.
   */
  live: ProcessingLiveProgress | null;
  streamDecisions: {
    audio: ProcessingAudioDecision[];
    subtitles: ProcessingSubtitleDecision[];
  } | null;
  events: ProcessingJobEvent[];
}> {
  return ownApiClient.request(
    `/processing/jobs/${encodeURIComponent(jobId)}?afterSequence=${afterSequence}`,
  );
}

export function cancelProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export function pauseProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/pause`,
    { method: "POST" },
  );
}

export function resumeProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/resume`,
    { method: "POST" },
  );
}

export function retryProcessingJob(
  jobId: string,
): Promise<{ job: ProcessingJob }> {
  return ownApiClient.request<{ job: ProcessingJob }>(
    `/processing/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST" },
  );
}

/**
 * Rewrites the order the waiting jobs will be encoded in.
 *
 * The whole order goes over, not a single move: the server would otherwise
 * have to guess what the other positions were, and two people dragging at once
 * would each get back a queue neither of them arranged. Replaying the same
 * list changes nothing, and the reply names the jobs that actually moved — a
 * job that started encoding between the drag and the drop is reported as
 * unmoved rather than quietly dropped.
 */
export function reorderProcessingQueue(
  jobIds: readonly string[],
): Promise<{ reordered: string[] }> {
  return ownApiClient.request<{ reordered: string[] }>(
    "/processing/queue/order",
    { method: "POST", body: { jobIds: [...jobIds] } },
  );
}

/**
 * The operator's cheap check that the storage is back.
 *
 * Reads directory metadata and a device identity, and nothing else: no media,
 * no checksum, no benchmark. A verification that exercised a suspect drive
 * would simply be the next outage under a friendlier name.
 */
export function verifyProcessingStorage(): Promise<{
  ok: boolean;
  detail: string;
  /**
   * Which thing happened, so a page can never present a replacement as a
   * confirmed recovery of the original hardware. There is deliberately no
   * option here meaning "ignore identity": a volume that cannot be matched is
   * not verified, and the way forward is `adoptProcessingStorage`.
   */
  outcome: "same-identity-verified" | "identity-unconfirmed" | "unavailable";
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/verify", { method: "POST" });
}

/**
 * Declares the volume currently present to be the storage from now on.
 *
 * For replacement hardware, and for a quarantine recorded before identities
 * were captured. Not an "ignore identity" button: it requires a volume that
 * reports an authoritative UUID, writes that UUID down, keeps the superseded
 * one in the history, and makes every later check an ordinary strict one
 * against the new identity. Refused when nothing there can identify itself.
 */
export function adoptProcessingStorage(): Promise<{
  detail: string;
  adoptedVolumeUuid: string | null;
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/adopt", { method: "POST" });
}

/**
 * The second, explicit press. The only thing that lifts a quarantine.
 *
 * Separate from verification on purpose: reconnecting a drive must never be, on
 * its own, the thing that restarts a multi-hour 4K encode against it.
 */
export function resumeProcessingStorage(): Promise<{
  storage: ProcessingStorageHealth;
}> {
  return ownApiClient.request("/processing/storage/resume", { method: "POST" });
}

export function deleteProcessingJob(jobId: string): Promise<{ removed: true }> {
  return ownApiClient.request<{ removed: true }>(
    `/processing/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

/**
 * URL of the live progress stream for one job.
 *
 * `lastEventId` resumes where a dropped connection stopped, so a page that is
 * refreshed mid-encode picks up the timeline rather than replaying it.
 */
export function processingStreamUrl(jobId: string, lastEventId = 0): string {
  return ownApiUrl(
    `/ownAPI/v1/processing/jobs/${encodeURIComponent(jobId)}/stream?lastEventId=${lastEventId}`,
  );
}

/**
 * Queues one independent job per eligible episode of a season.
 *
 * Never one job for the season: a season has no source file and no ladder, and
 * a single run spanning thirteen hours would lose all thirteen to one failure.
 * Safe to press twice — episodes that already have a job come back counted as
 * `alreadyQueued` rather than queued again.
 */
export function processSeason(
  seasonId: string,
): Promise<BulkProcessingOutcome> {
  return ownApiClient.request<BulkProcessingOutcome>(
    `/processing/seasons/${encodeURIComponent(seasonId)}/jobs`,
    { method: "POST" },
  );
}

/** The same, across every season of a show. */
export function processSeries(
  seriesId: string,
): Promise<BulkProcessingOutcome> {
  return ownApiClient.request<BulkProcessingOutcome>(
    `/processing/series/${encodeURIComponent(seriesId)}/jobs`,
    { method: "POST" },
  );
}

export interface VolumeSpace {
  role: "media" | "scratch";
  /** Null when the server could not ask the volume — unknown, not full. */
  freeBytes: number | null;
  totalBytes: number | null;
}

/** Free space on the media and scratch volumes; one entry when they share a disk. */
export function getVolumeSpace(options?: {
  signal?: AbortSignal;
}): Promise<{ volumes: VolumeSpace[] }> {
  return ownApiClient.request("/processing/space", options);
}
