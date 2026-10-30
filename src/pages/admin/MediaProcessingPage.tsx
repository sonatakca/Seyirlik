import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  Cpu,
  GripVertical,
  ListOrdered,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  Search,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { processingDeviceLabel } from "./processingDevice";
import { setPageTitle } from "../../lib/pageTitle";
import { notify } from "../../lib/notifications/notificationStore";
import {
  getPrimaryImageUrl,
  getVideoItemsForLibrary,
  getUserViews,
} from "../../lib/mediaApi";
import type { MediaItem, MediaLibrary } from "../../lib/types";
import { getDisplayTitle } from "../../lib/format";
import {
  cancelProcessingJob,
  deleteProcessingJob,
  deleteProcessingSource,
  pauseProcessingJob,
  resumeProcessingJob,
  enqueueProcessing,
  getProcessingJob,
  getProcessingOverview,
  previewProcessing,
  processingStreamUrl,
  reorderProcessingQueue,
  retryProcessingJob,
  adoptProcessingStorage,
  resumeProcessingStorage,
  verifyProcessingStorage,
  processSeason,
  processSeries,
  type AssemblyPhaseProgress,
  type AudioPhaseProgress,
  type CompletedPhaseSummary,
  type PlanningPhaseProgress,
  type ProcessingBuildPhase,
  type ProcessingJob,
  type ProcessingJobEvent,
  type ProcessingLiveProgress,
  type ProcessingEpisode,
  type ProcessingOverview,
  type ProcessingPreview,
  type ProcessingSeason,
  type ProcessingSeries,
  type PublishPhaseProgress,
  type SubtitlePhaseProgress,
  type VerificationPhaseProgress,
} from "../../lib/processingApi";
import {
  BUILD_PHASE_LABEL_KEYS,
  buildPhaseFor,
  completedPhaseLabelKey,
  describeAudioTrack,
  liveSampleIsStale,
  formatByteRate,
  globalProgressPercent,
  phasePercent,
  canCancel,
  canPause,
  canResume,
  pauseTransition,
  canRetry,
  completedEpochs,
  encodedPercent,
  formatBytes,
  formatDuration,
  formatFileSize,
  formatFinishedAt,
  formatMediaClock,
  formatSpeed,
  hasResumableCheckpoints,
  isOperatorHeld,
  isSalvaged,
  isWaitingForStorage,
  lastSequence,
  pausedReasonChip,
  mergeEvents,
  mergeJobFrame,
  PROCESSING_STAGE_ORDER,
  progressPercent,
  processingDurationSeconds,
  processingElapsedSeconds,
  protectedSeconds,
  sourceDamageRecords,
  sourceIoNotice,
  retryScopeKey,
  smoothedEncodedSeconds,
  stageStateFor,
  summariseLanguages,
} from "./processingModel";
import {
  applyQueueOverride,
  canReorder,
  moveItem,
  partitionProcessingJobs,
  PROCESSING_OUTCOME_TABS,
  type ProcessingOutcomeTab,
} from "./processingQueueModel";
import {
  arrangeByShowAndEpisode,
  moveToBack,
  moveToFront,
} from "./queueArrangement";
import { useQueueSortable } from "./useQueueSortable";
import { describeErrorForUser } from "../../lib/userFacingError";
import { formatTemplate } from "./libraryMaintenanceModel";
import { ProcessingSeriesTree } from "./ProcessingSeriesTree";
import { DriveUploadPanel, PhaseBar } from "./DriveUploadPanel";
import {
  autoExpandedIds,
  describeBulkOutcome,
  filterSeries,
  jobLabel,
} from "./processingSeriesModel";

const CARD = "rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5";
const LABEL =
  "text-[11px] font-black uppercase tracking-[0.14em] text-white/40";
/**
 * The storage banner's headline, in the reader's language.
 *
 * Keyed off `state` rather than shown as the server sent it. The server writes
 * one English sentence per state for the log and the job history, which is the
 * right thing there and the wrong thing here — it arrived on a Turkish page as
 * English, under chips that were already translated.
 *
 * The server's sentence stays the fallback. A state this build has no key for
 * is better read in English than not read at all, and that is also what keeps a
 * newer server from blanking the banner on an older page.
 */
function storageSummary(
  storage: { state: string; summary: string; missingRoots: readonly string[] },
  t: (key: never) => string,
): string {
  if (storage.state === "unavailable" && storage.missingRoots.length > 0) {
    return formatTemplate(
      t("processing.storage.summary.unavailableNamed" as never),
      { roots: storage.missingRoots.join(", ") },
    );
  }
  const key = `processing.storage.summary.${storage.state}`;
  const translated = t(key as never);
  return translated === key ? storage.summary : translated;
}

/** Matches the per-job action buttons, so the recovery flow reads as native. */
const BUTTON =
  "rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
/*
 * A running encode reports speed, frame rate and progress several times a
 * second, so a five-second poll showed a figure that was already stale by the
 * time it was painted — and a job that started and failed inside one interval
 * never appeared to run at all.
 */
const PROCESSING_REFRESH_MS = 1_000;

/** The page's own translator, so a helper cannot be handed an unknown key. */
type Translate = ReturnType<typeof useLanguage>["t"];

/**
 * How often the page repaints between authoritative samples.
 *
 * The encoder reports four times a second and the stream carries every sample,
 * so this is not the source of the numbers — it is what lets the seconds
 * counter move smoothly between them. It never runs ahead of the bound the last
 * sample established, so a stalled encoder shows a bar that stops.
 */
const LIVE_TICK_MS = 250;

type PreviewLoadState =
  | { status: "waiting" | "loading" }
  | { status: "ready"; value: ProcessingPreview }
  /*
   * The failure itself, not its text: the text is chosen at render, so it is
   * in whichever language the page is in by then.
   */
  | { status: "error"; error: unknown };

// React's development Strict Mode starts effects twice. Sharing only in-flight
// probes keeps that safety check from analysing the same media file twice,
// while still allowing a fresh preview after the probe settles.
const previewRequests = new Map<string, Promise<ProcessingPreview>>();

function loadProcessingPreview(itemId: string): Promise<ProcessingPreview> {
  const current = previewRequests.get(itemId);
  if (current) return current;
  const request = previewProcessing(itemId);
  previewRequests.set(itemId, request);
  const clear = () => {
    if (previewRequests.get(itemId) === request) previewRequests.delete(itemId);
  };
  void request.then(clear, clear);
  return request;
}

/**
 * The transfer characteristic, spelled the way a viewer would say it.
 *
 * Stated even when it is SDR: "no HDR" is as much a fact about a title as HDR
 * is, and its absence used to be indistinguishable from an unread source.
 */
function dynamicRangeLabel(hdr: string): string {
  if (hdr === "hdr10") return "HDR10";
  if (hdr === "hlg") return "HLG";
  if (hdr === "sdr") return "SDR";
  return hdr.toUpperCase();
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={LABEL}>{label}</span>
      <span className="text-sm font-semibold text-white/90 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Chip({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    ok: "bg-emerald-400/15 text-emerald-200 border-emerald-400/25",
    warn: "bg-amber-400/15 text-amber-200 border-amber-400/25",
    bad: "bg-rose-400/15 text-rose-200 border-rose-400/25",
    muted: "bg-white/[0.06] text-white/60 border-white/10",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * The ladder as a list of rungs, each saying whether it already exists.
 *
 * This replaces a single joined line that listed the whole ladder in one
 * colour: it could say "already packaged" beside a ladder containing a rung
 * the title did not have, and nothing in the text distinguished the two. A
 * rung is the unit the decision is actually made in, so it is the unit shown.
 *
 * Green is what will be reused; amber is what this run would encode. Amber
 * rather than red on purpose — a rung that does not exist yet is planned work,
 * not a fault, and the page keeps red for things that actually went wrong.
 */
function LadderRungs({
  planned,
  present,
  keptLabel,
  buildLabel,
}: {
  planned: readonly number[];
  present: readonly number[];
  keptLabel: string;
  /** Omitted where nothing can be built, so the legend states only the truth. */
  buildLabel?: string;
}) {
  const owned = new Set(present);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {planned.map((height) => {
          const kept = owned.has(height);
          return (
            <span
              key={height}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-bold tabular-nums ${
                kept
                  ? "border-emerald-400/25 bg-emerald-400/15 text-emerald-200"
                  : "border-amber-400/30 bg-amber-400/15 text-amber-100"
              }`}
            >
              <span
                aria-hidden="true"
                className="text-[0.6875rem] leading-none"
              >
                {kept ? "\u2713" : "+"}
              </span>
              {height}p
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-white/45">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
          {keptLabel}
        </span>
        {buildLabel ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400/70" />
            {buildLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a checkpointed encode is doing, in the terms an operator asks about.
 *
 * Deliberately separate from the workflow bar above it. That bar answers "how
 * far through the whole job", which is a different question from "how much of
 * the film has been encoded" and used to be the only one on offer — so a job
 * that had merely reached a late stage read as nearly done while the encoder
 * was a third of the way through the picture.
 */

/**
 * The audio stage.
 *
 * One FFmpeg pass writes every retained track together, so there is one
 * timeline and a list of tracks, not a track counter. Saying "track 2 of 3"
 * would read better and would describe a pipeline this is not.
 */
function AudioPanel({
  progress,
  stale,
  t,
}: {
  progress: AudioPhaseProgress;
  /** True when nothing has been reported for several seconds. */
  stale: boolean;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tabular-nums">
          {progress.reused ? "—" : phasePercent(progress.fraction)}
        </span>
        {/*
         * One position for every track, because one FFmpeg pass writes them
         * all. The label says "source timeline" rather than leaving the reader
         * to assume this is a per-track figure.
         */}
        <span className="text-xs tabular-nums text-white/45">
          {t("processing.audio.sharedTimeline")}{" "}
          {formatTemplate(t("processing.epoch.mediaPosition"), {
            encoded: formatMediaClock(progress.processedSeconds),
            total: formatMediaClock(progress.durationSeconds),
          })}
        </span>
        {progress.reused ? (
          <span className="text-xs font-semibold text-emerald-200/80">
            {t("processing.audio.reused")}
          </span>
        ) : null}
      </div>
      <PhaseBar fraction={progress.fraction} />
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>
          {formatTemplate(t("processing.audio.trackCount"), {
            count: String(progress.tracks.length),
          })}
        </span>
        {progress.tracks.map((track) => (
          <div
            key={track.id}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
          >
            <span className="text-white/70">
              {describeAudioTrack(track, (code) =>
                t(`processing.language.${code}` as never),
              )}
            </span>
            <span className="tabular-nums text-white/45">
              {formatBytes(track.writtenBytes)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/45">
        {/*
         * Rate and remaining time describe something happening now, so they go
         * when nothing is. The measured position stays, because it is still
         * exactly where the work stopped.
         */}
        {progress.speed && !stale ? (
          <span className="tabular-nums">
            {t("processing.speed")}: {formatSpeed(progress.speed)}
          </span>
        ) : null}
        <span className="tabular-nums">
          {t("processing.actualOutput")}: {formatBytes(progress.writtenBytes)}
        </span>
        {progress.etaSeconds !== undefined && !stale ? (
          <span className="tabular-nums">
            {t("processing.eta")}: {formatDuration(progress.etaSeconds)}
          </span>
        ) : null}
        {stale ? (
          <span className="text-amber-100/70">
            {t("processing.phaseStalled")}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Assembly, rung by rung and byte by byte.
 *
 * The table is the point. 2160p is seventy times the bytes of 144p, so a
 * position expressed in rungs would have called this build a quarter done when
 * it had written two thirds of its data.
 */
function AssemblyPanel({
  progress,
  stale,
  t,
}: {
  progress: AssemblyPhaseProgress;
  stale: boolean;
  t: Translate;
}) {
  const current = progress.renditions.find(
    (rendition) => rendition.id === progress.currentId,
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tabular-nums">
          {phasePercent(progress.fraction)}
        </span>
        <span className="text-xs tabular-nums text-white/45">
          {formatBytes(progress.completedBytes)} /{" "}
          {formatBytes(progress.totalBytes)}
        </span>
      </div>
      <PhaseBar fraction={progress.fraction} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[19rem] border-collapse text-xs">
          <tbody>
            {progress.renditions.map((rendition) => {
              const fraction =
                rendition.expectedBytes > 0
                  ? Math.min(
                      1,
                      rendition.writtenBytes / rendition.expectedBytes,
                    )
                  : 0;
              return (
                <tr key={rendition.id} className="align-baseline">
                  <td className="py-0.5 pr-3 font-bold text-white/75">
                    {rendition.id}
                  </td>
                  <td className="py-0.5 pr-3 tabular-nums text-white/45">
                    {rendition.state === "waiting"
                      ? t("processing.assembly.waiting")
                      : `${formatBytes(rendition.writtenBytes)} / ${formatBytes(
                          rendition.expectedBytes,
                        )}`}
                  </td>
                  <td className="py-0.5 text-right tabular-nums">
                    {rendition.state === "complete" ? (
                      <span className="text-emerald-300">✓</span>
                    ) : rendition.state === "running" ? (
                      <span className="text-amber-200">
                        {phasePercent(fraction)}
                      </span>
                    ) : (
                      <span className="text-white/25">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/45">
        {current ? (
          <span className="tabular-nums">
            {t("processing.assembly.current")}: {current.id}
          </span>
        ) : null}
        {/*
         * A rate is a claim about the present tense. When the writer has
         * stopped — paused, or its volume gone — there is no current rate, and
         * showing the last one produces a remaining time that never arrives.
         */}
        <span className="tabular-nums">
          {t("processing.assembly.writeRate")}:{" "}
          {formatByteRate(stale ? undefined : progress.bytesPerSecond)}
        </span>
        <span className="tabular-nums">
          {t("processing.assembly.remaining")}:{" "}
          {formatBytes(
            Math.max(0, progress.totalBytes - progress.completedBytes),
          )}
        </span>
        {/*
         * Absent rather than zero when there is no measured rate to divide by.
         * A stalled writer has no estimate, and inventing one is what makes a
         * remaining time that counts up.
         */}
        {progress.etaSeconds !== undefined && !stale ? (
          <span className="tabular-nums">
            {t("processing.eta")}: {formatDuration(progress.etaSeconds)}
          </span>
        ) : null}
        {stale ? (
          <span className="text-amber-100/70">
            {t("processing.phaseStalled")}
          </span>
        ) : null}
        {progress.audioCopyState ? (
          <span className="tabular-nums">
            {t("processing.assembly.audioCopy")}:{" "}
            {progress.audioCopyState === "complete"
              ? formatBytes(progress.audioCopyBytes ?? 0)
              : t("processing.assembly.copying")}
          </span>
        ) : null}
      </div>
      {/*
       * The measurement that follows the join. Without it the panel showed a
       * full byte bar and a stale-rate notice for as long as it took to read
       * every rendition back — which on a thirty-gigabyte ladder is tens of
       * minutes of work the page flatly denied was happening.
       */}
      {progress.measure ? (
        <div className="flex flex-col gap-1 rounded-lg bg-white/[0.03] px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs text-white/60">
              {formatTemplate(t("processing.assembly.measuring"), {
                rendition: progress.measure.currentId,
              })}
            </span>
            <span className="text-[11px] tabular-nums text-white/40">
              {formatTemplate(t("processing.assembly.rungOf"), {
                index: String(progress.measure.index),
                count: String(progress.measure.count),
              })}
            </span>
            {progress.measure.fraction !== undefined ? (
              <span className="text-xs font-semibold tabular-nums">
                {(progress.measure.fraction * 100).toFixed(1)}%
              </span>
            ) : null}
          </div>
          {progress.measure.fraction !== undefined ? (
            <PhaseBar fraction={progress.measure.fraction} />
          ) : null}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/40">
            {progress.measure.currentMediaSeconds !== undefined &&
            progress.measure.totalMediaSeconds !== undefined ? (
              <span className="tabular-nums">
                {formatDuration(progress.measure.currentMediaSeconds)} /{" "}
                {formatDuration(progress.measure.totalMediaSeconds)}
              </span>
            ) : null}
            {progress.measure.etaSeconds !== undefined &&
            !stale &&
            !progress.measure.stalled ? (
              <span className="tabular-nums">
                {t("processing.eta")}:{" "}
                {formatDuration(progress.measure.etaSeconds)}
              </span>
            ) : null}
            {progress.measure.stalled ? (
              <span className="text-amber-100/70">
                {t("processing.verification.waiting")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Verification.
 *
 * The literal figures are the counts: how many checks of each kind have
 * finished, and which one is running. The bar is weighted by the size of what
 * each check reads, because a probe of a ten-gigabyte rendition and a playlist
 * parse are not the same work — and it is labelled as weighted, because
 * ffprobe reports nothing until it exits, so no byte figure here would be a
 * measurement of anything.
 */
function VerificationPanel({
  progress,
  stale,
  t,
}: {
  progress: VerificationPhaseProgress;
  stale: boolean;
  t: Translate;
}) {
  /** Only the families this package actually has. */
  const groups = progress.groups.filter((group) => group.total > 0);
  const step = progress.current;
  /*
   * The running check's own progress, which exists only for a check that reads
   * a timeline. Its rate and estimate are withdrawn the moment the scan stops
   * reporting — the position it reached stays, because that much is still true.
   */
  const scanning = step?.fraction !== undefined;
  const quiet = stale || step?.stalled === true;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tabular-nums">
          {formatTemplate(t("processing.verification.checks"), {
            done: String(progress.completedChecks),
            total: String(progress.totalChecks),
          })}
        </span>
        {step ? (
          <span className="text-xs text-white/45">
            {t(`processing.verification.kind.${step.kind}` as never)}
            {step.rendition === "package" ? "" : ` · ${step.rendition}`}
          </span>
        ) : null}
      </div>
      <PhaseBar fraction={progress.fraction} />
      <span className="text-[11px] text-white/35">
        {t("processing.verification.weighted")}
      </span>

      {step && scanning ? (
        <div className="flex flex-col gap-1 rounded-lg bg-white/[0.03] px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-semibold tabular-nums">
              {(step.fraction! * 100).toFixed(1)}%
            </span>
            {step.currentMediaSeconds !== undefined &&
            step.totalMediaSeconds !== undefined ? (
              <span className="text-xs tabular-nums text-white/45">
                {formatDuration(step.currentMediaSeconds)} /{" "}
                {formatDuration(step.totalMediaSeconds)}
              </span>
            ) : null}
          </div>
          <PhaseBar fraction={step.fraction!} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/40">
            {step.rate !== undefined && !quiet ? (
              <span className="tabular-nums">
                {t("processing.verification.scanRate")}:{" "}
                {formatTemplate(t("processing.verification.timesRealtime"), {
                  rate: step.rate.toFixed(1),
                })}
              </span>
            ) : null}
            {step.etaSeconds !== undefined && !quiet ? (
              <span className="tabular-nums">
                {t("processing.eta")}: {formatDuration(step.etaSeconds)}
              </span>
            ) : null}
            {quiet ? (
              <span className="text-amber-100/70">
                {t("processing.verification.waiting")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <div
            key={group.kind}
            className="flex items-baseline justify-between gap-3 text-xs"
          >
            <span className="text-white/60">
              {t(`processing.verification.kind.${group.kind}` as never)}
            </span>
            <span className="tabular-nums text-white/45">
              {group.completed} / {group.total}
            </span>
          </div>
        ))}
      </div>

      {progress.declared ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/45">
          <span>
            {formatTemplate(t("processing.verification.videoRenditions"), {
              count: String(progress.declared.videoRenditions),
            })}
          </span>
          <span>
            {formatTemplate(t("processing.verification.audioTracks"), {
              count: String(progress.declared.audioRenditions),
            })}
          </span>
          <span>
            {formatTemplate(t("processing.verification.subtitles"), {
              count: String(progress.declared.subtitleRenditions),
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Publication, as the list of operations it genuinely performs. */
function PublishPanel({
  progress,
  t,
}: {
  progress: PublishPhaseProgress;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-2">
      {progress.totalBytes > 0 ? (
        <>
          <div className="flex items-baseline justify-between text-xs text-white/60">
            <span>{t("processing.publish.copying")}</span>
            <span className="tabular-nums text-white/40">
              {formatBytes(progress.completedBytes)} /{" "}
              {formatBytes(progress.totalBytes)}
              {progress.bytesPerSecond
                ? ` · ${formatBytes(progress.bytesPerSecond)}/s`
                : ""}
            </span>
          </div>
          <PhaseBar fraction={progress.fraction} />
        </>
      ) : null}
      {progress.steps.map((step) => (
        <div
          key={step.id}
          className="flex items-baseline gap-2 text-xs text-white/60"
        >
          <span
            className={
              step.state === "complete"
                ? "text-emerald-300"
                : step.state === "running"
                  ? "text-amber-200"
                  : "text-white/25"
            }
          >
            {step.state === "complete"
              ? "✓"
              : step.state === "running"
                ? "•"
                : "○"}
          </span>
          <span>{t(`processing.publish.${step.id}` as never)}</span>
          {step.bytes ? (
            <span className="ml-auto tabular-nums text-white/35">
              {formatBytes(step.completedBytes ?? 0)} /{" "}
              {formatBytes(step.bytes)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Planning, by step.
 *
 * The rate probe's search runs as long as its answers require, so there is no
 * honest fraction to draw: the panel counts the work finished instead.
 */
function PlanningPanel({
  progress,
  t,
}: {
  progress: PlanningPhaseProgress;
  t: Translate;
}) {
  const rates = progress.rateProbe;
  const steps: Array<{ key: string; state: "running" | "complete" }> = [
    {
      key: "timeline",
      state: progress.step === "timeline" ? "running" : "complete",
    },
    ...(progress.step === "rates" || (progress.step === "encoder" && rates)
      ? [
          {
            key: "rates",
            state:
              progress.step === "rates"
                ? ("running" as const)
                : ("complete" as const),
          },
        ]
      : []),
    ...(progress.step === "encoder"
      ? [{ key: "encoder", state: "running" as const }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2 text-xs text-white/60">
      {steps.map((step) => (
        <div key={step.key} className="flex items-baseline gap-2">
          <StepMark state={step.state} />
          <span>
            {step.key === "timeline"
              ? formatTemplate(t("processing.planning.timeline"), {
                  count: String(progress.boundaryCount),
                })
              : step.key === "encoder"
                ? t("processing.planning.encoder")
                : rates?.reused
                  ? t("processing.planning.ratesReused")
                  : t("processing.planning.rates")}
          </span>
        </div>
      ))}
      {progress.epochCount ? (
        <span className="tabular-nums text-white/45">
          {formatTemplate(t("processing.planning.epochs"), {
            count: String(progress.epochCount),
          })}
        </span>
      ) : null}
      {rates && !rates.reused ? (
        <span className="tabular-nums text-white/45">
          {formatTemplate(t("processing.planning.rateWork"), {
            encodes: String(rates.encodes),
            measurements: String(rates.measurements),
          })}
          {rates.qualityHeight
            ? ` · ${formatTemplate(t("processing.planning.rateRung"), {
                rendition: `${rates.qualityHeight}p`,
              })}`
            : ""}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Subtitles, track by track.
 *
 * Each track is its own FFmpeg run and reports nothing until it finishes, so
 * the list is the progress: done, running for how long, still to come.
 */
function SubtitlePanel({
  progress,
  nowMs,
  t,
}: {
  progress: SubtitlePhaseProgress;
  nowMs: number;
  t: Translate;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tabular-nums">
          {progress.completedTracks} / {progress.tracks.length}
        </span>
        <span className="text-xs tabular-nums text-white/45">
          {t("processing.subtitles.tracks")}
          {progress.writtenBytes > 0
            ? ` · ${formatBytes(progress.writtenBytes)}`
            : ""}
        </span>
      </div>
      <PhaseBar fraction={progress.fraction} />
      <div className="flex flex-col gap-1.5">
        {progress.tracks.map((track) => (
          <div
            key={track.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
          >
            <StepMark
              state={
                track.state === "skipped"
                  ? "skipped"
                  : track.state === "complete"
                    ? "complete"
                    : track.state === "running"
                      ? "running"
                      : "waiting"
              }
            />
            <span className="text-white/70">
              {[
                track.language
                  ? t(`processing.language.${track.language}` as never)
                  : track.title,
                track.isForced ? t("processing.subtitles.forced") : null,
              ]
                .filter(Boolean)
                .join(" · ") || track.id}
            </span>
            <span className="text-white/35">
              {t(`processing.subtitles.${track.origin}` as never)}
            </span>
            <span className="ml-auto tabular-nums text-white/45">
              {track.state === "running" &&
              progress.currentStartedAtMs !== undefined
                ? formatTemplate(t("processing.subtitles.running"), {
                    elapsed: formatDuration(
                      Math.max(
                        0,
                        Math.round(
                          (nowMs - progress.currentStartedAtMs) / 1000,
                        ),
                      ),
                    ),
                  })
                : track.state === "skipped"
                  ? t("processing.subtitles.skipped")
                  : track.bytes
                    ? formatBytes(track.bytes)
                    : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A phase that has begun and not yet sent its first measurement.
 *
 * Showing the video panel here — the old fallback — is what made audio look
 * like video. The phase is named and timed instead, and its own panel replaces
 * this the moment it reports.
 */
function PhaseStartingPanel({
  live,
  nowMs,
  t,
}: {
  live: ProcessingLiveProgress;
  nowMs: number;
  t: Translate;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-white/55">
      <Loader2
        size={13}
        className="animate-spin text-white/40 motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>
        {live.phaseStartedAtMs !== undefined
          ? formatTemplate(t("processing.phase.startedAgo"), {
              elapsed: formatDuration(
                Math.max(0, Math.round((nowMs - live.phaseStartedAtMs) / 1000)),
              ),
            })
          : t("processing.phase.starting")}
      </span>
    </div>
  );
}

function StepMark({
  state,
}: {
  state: "waiting" | "running" | "complete" | "skipped";
}) {
  return (
    <span
      className={
        state === "complete"
          ? "text-emerald-300"
          : state === "running"
            ? "text-amber-200"
            : state === "skipped"
              ? "text-rose-300/70"
              : "text-white/25"
      }
      aria-hidden="true"
    >
      {state === "complete"
        ? "✓"
        : state === "running"
          ? "•"
          : state === "skipped"
            ? "×"
            : "○"}
    </span>
  );
}

/**
 * How a finished build went, phase by phase.
 *
 * Read from the row, because the live sample that carried it is gone once the
 * job ends. Each line says what the phase handled in its own unit — epochs,
 * tracks, renditions, checks — rather than a bare number.
 */
function FinishedPhases({
  phases,
  t,
}: {
  phases: readonly CompletedPhaseSummary[];
  t: Translate;
}) {
  const total = phases.reduce((sum, entry) => sum + entry.elapsedSeconds, 0);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <span className={LABEL}>{t("processing.phaseHistory")}</span>
      {phases.map((entry) => (
        <div
          key={entry.phase}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
        >
          <StepMark state="complete" />
          <span className="font-semibold text-white/70">
            {t(completedPhaseLabelKey(entry.phase) as never)}
          </span>
          <span className="text-white/40">
            {[
              entry.count
                ? formatTemplate(t(phaseCountKey(entry.phase) as never), {
                    count: String(entry.count),
                  })
                : null,
              entry.bytes ? formatFileSize(entry.bytes) : null,
              entry.reused ? t("processing.audio.reused") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="ml-auto tabular-nums text-white/45">
            {formatDuration(entry.elapsedSeconds)}
          </span>
        </div>
      ))}
      <div className="flex items-baseline justify-between border-t border-white/[0.06] pt-1.5 text-xs text-white/45">
        <span>{t("processing.history.total")}</span>
        <span className="tabular-nums">{formatDuration(total)}</span>
      </div>
    </div>
  );
}

function phaseCountKey(phase: ProcessingBuildPhase): string {
  return `processing.history.count.${phase}`;
}

/** Exported so the panels can be asserted without a live stream. */
export const DriveUploadPanelForTest = DriveUploadPanel;
export const FinishedPhasesForTest = FinishedPhases;

/**
 * What is finished, in one line each.
 *
 * Kept because the phase panel above it only ever shows the phase that is
 * running: without this, a job in verification looked as though it had never
 * encoded anything.
 */
function PhaseHistory({
  phases,
  t,
}: {
  phases: readonly CompletedPhaseSummary[];
  t: Translate;
}) {
  if (phases.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/40">
      {phases.map((entry) => (
        <span key={entry.phase} className="inline-flex items-center gap-1.5">
          <span className="text-emerald-300">✓</span>
          <span className="font-semibold text-white/55">
            {t(completedPhaseLabelKey(entry.phase) as never)}
          </span>
          <span className="tabular-nums">
            {formatDuration(entry.elapsedSeconds)}
            {entry.count ? ` · ${entry.count}` : ""}
            {entry.bytes ? ` · ${formatBytes(entry.bytes)}` : ""}
            {entry.reused ? ` · ${t("processing.audio.reused")}` : ""}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * What the encoder currently believes about the source it is reading.
 *
 * Shown in the epoch panel rather than as an alert, because for most of its
 * life it is not an alert: media time stopping means the encoder may be busy.
 * The wording escalates only as the evidence does, which is the difference
 * between a page that is trusted and one that cries wolf. It also replaces the
 * thing this exists to remove — a confidently falling encoding speed shown for
 * minutes while FFmpeg is blocked on a platter that will never answer.
 */
function SourceIoNotice({
  live,
  t,
}: {
  live: ProcessingLiveProgress | null;
  t: Translate;
}) {
  const notice = sourceIoNotice(live);
  if (!notice) return null;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
        notice.tentative
          ? "border-white/10 bg-white/[0.04] text-white/60"
          : "border-amber-400/25 bg-amber-400/10 text-amber-100"
      }`}
    >
      {notice.tentative ? (
        <Loader2
          size={13}
          className="animate-spin text-white/40 motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <AlertTriangle size={13} aria-hidden="true" />
      )}
      <span>{formatTemplate(t(notice.key as never), notice.values)}</span>
    </div>
  );
}

/**
 * The warning a salvaged title keeps for ever.
 *
 * A succeeded row and a playable package look exactly like a clean encode from
 * every other angle, so this is the only place the difference is stated. It
 * names the interval rather than saying "some source damage", because the one
 * thing an operator does with this is decide whether that stretch of the film
 * is worth re-ripping the disc for.
 */
function SourceDamagePanel({
  job,
  live,
  t,
}: {
  job: ProcessingJob;
  live?: ProcessingLiveProgress | null;
  t: Translate;
}) {
  const records = sourceDamageRecords(job, live);
  if (records.length === 0) return null;
  const total = records.reduce(
    (sum, record) =>
      sum + Math.max(0, record.sourceEndSeconds - record.sourceStartSeconds),
    0,
  );
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3">
      <div className="flex items-center gap-2">
        <AlertTriangle
          size={13}
          className="text-amber-200"
          aria-hidden="true"
        />
        <span className="text-xs font-bold uppercase tracking-[0.14em] text-amber-200/90">
          {t("processing.sourceDamage.heading")}
        </span>
      </div>
      <p className="text-xs font-semibold text-amber-100">
        {t("processing.sourceDamage.completed")}
      </p>
      <ul className="flex flex-col gap-1.5 text-xs text-amber-100/85">
        {records.map((record) => (
          <li
            key={`${record.epochIndex}-${record.sourceStartSeconds}`}
            className="flex flex-col gap-0.5"
          >
            <span className="tabular-nums">
              {formatTemplate(t("processing.sourceDamage.interval"), {
                from: formatMediaClock(record.sourceStartSeconds),
                to: formatMediaClock(record.sourceEndSeconds),
              })}
            </span>
            {record.audioReplaced ? (
              <span className="text-amber-100/60">
                {t("processing.sourceDamage.audio")}
              </span>
            ) : null}
            {record.subtitlesAffected ? (
              <span className="text-amber-100/60">
                {t("processing.sourceDamage.subtitles")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[11px] tabular-nums text-amber-100/60">
        {formatTemplate(t("processing.sourceDamage.total"), {
          duration: formatDuration(total),
          count: String(records.length),
        })}
      </p>
      <p className="text-[11px] text-amber-100/60">
        {t("processing.sourceDamage.advice")}
      </p>
    </div>
  );
}

/** Exported so the panels can be asserted without standing up a live stream. */
export const SourceDamagePanelForTest = SourceDamagePanel;

function EpochPanel({
  job,
  live,
  nowMs,
  t,
}: {
  job: ProcessingJob;
  live: ProcessingLiveProgress | null;
  nowMs: number;
  t: Translate;
}) {
  const duration = live?.sourceDurationSeconds ?? job.sourceDurationSeconds;
  if (!duration || duration <= 0) return null;

  const phase = buildPhaseFor(job, live);
  const smoothed = smoothedEncodedSeconds({ live, nowMs });
  const guarded = protectedSeconds(job, live);
  /*
   * Floored at the protected mark as well as at the row, because the two come
   * from different places — the durable row and the live file — and either can
   * be the fresher of the pair. Showing a position behind media that is already
   * checkpointed is what makes a panel say "protected through 00:10:00" and
   * "00:09:59" in the same breath.
   */
  const encoded = Math.max(
    guarded,
    job.encodedSeconds,
    smoothed ?? live?.encodedSeconds ?? 0,
  );
  const percent =
    job.state === "succeeded"
      ? 100
      : Math.min(100, Math.round((encoded / duration) * 1000) / 10);
  const done = completedEpochs(job, live);
  const count = live?.epochCount ?? job.epochCount;
  const index = live?.epochIndex ?? job.epochIndex;
  const epochStart = live?.epochStartSeconds ?? job.epochStartSeconds;
  const epochEnd = live?.epochEndSeconds ?? job.epochEndSeconds;
  const encoding = phase === "encoding" && job.state === "running";
  const rungs = live?.qualityHeights ?? job.decision?.renditionsToEncode ?? [];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={LABEL}>
          {phase
            ? t(BUILD_PHASE_LABEL_KEYS[phase] as never)
            : t("processing.stage.video")}
        </span>
        {encoding ? (
          <span className="text-2xl font-black tabular-nums">{percent}%</span>
        ) : (
          <span className="text-sm font-bold text-white/70">
            {t("processing.epoch.videoComplete")}
          </span>
        )}
        <span className="text-xs tabular-nums text-white/45">
          {formatTemplate(t("processing.epoch.mediaPosition"), {
            encoded: formatMediaClock(encoded),
            total: formatMediaClock(duration),
          })}
        </span>
      </div>

      <SourceIoNotice live={live} t={t} />

      {/*
       * Two bars in one: the filled part is what has been encoded, and the
       * brighter mark inside it is how much of that a crash could not take
       * away. Seeing the two apart is the whole point of checkpointing.
       */}
      <div className="relative h-2 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]/45"
          style={{ width: `${Math.min(100, (encoded / duration) * 100)}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-400/80"
          style={{ width: `${Math.min(100, (guarded / duration) * 100)}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/55">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
          {done > 0 && count
            ? `${formatTemplate(t("processing.epoch.checkpointsSaved"), {
                done: String(done),
                count: String(count),
              })} · ${formatTemplate(t("processing.epoch.protectedThrough"), {
                time: formatMediaClock(guarded),
              })}`
            : t("processing.epoch.noneYet")}
        </span>
        {job.checkpointBytes > 0 ? (
          <span className="tabular-nums text-white/40">
            {t("processing.epoch.protectedMedia")}:{" "}
            {formatBytes(job.checkpointBytes)}
          </span>
        ) : null}
      </div>

      {/*
       * The rungs, and the fact that they advance together. They are produced
       * from one decode inside each epoch, so their timeline progress is the
       * same by construction — listing them separately would invite the reader
       * to look for a difference that cannot exist.
       */}
      {rungs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rungs.map((height) => (
            <span
              key={height}
              className={`rounded-md border px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
                encoding
                  ? "border-amber-400/30 bg-amber-400/15 text-amber-100"
                  : "border-emerald-400/25 bg-emerald-400/15 text-emerald-200"
              }`}
            >
              {height}p
            </span>
          ))}
          {live?.encoder ? (
            <span className="text-[11px] text-white/40">{live.encoder}</span>
          ) : null}
          {job.freeBytes !== null ? (
            <span className="ml-auto text-[11px] tabular-nums text-white/40">
              {formatTemplate(t("processing.storage.free"), {
                free: formatBytes(job.freeBytes),
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {index !== null && count && epochStart !== null && epochEnd !== null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/45">
          <span className={LABEL}>{t("processing.epoch.heading")}</span>
          <span className="font-bold tabular-nums text-white/70">
            {formatTemplate(t("processing.epoch.position"), {
              index: String(index + 1),
              count: String(count),
            })}
          </span>
          <span className="tabular-nums">
            {formatMediaClock(epochStart)} → {formatMediaClock(epochEnd)}
          </span>
          {live?.epochFraction !== null && live?.epochFraction !== undefined ? (
            <span className="tabular-nums">
              {Math.round(live.epochFraction * 100)}%
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The detail area under the global bar: whichever phase is running, in its own
 * terms.
 *
 * Video keeps the panel it already had, unchanged — it is the standard the
 * others were built to meet — and the phases that used to show nothing now show
 * what they are measuring.
 */
function PhaseDetail({
  job,
  live,
  nowMs,
  t,
}: {
  job: ProcessingJob;
  live: ProcessingLiveProgress | null;
  nowMs: number;
  t: Translate;
}) {
  const phase = buildPhaseFor(job, live);
  const stale = liveSampleIsStale(live, nowMs);
  /*
   * A finished build is described by its history, not by the video panel's
   * last state, which said "video encoding complete" and nothing else.
   */
  if (job.state === "succeeded" && job.phaseHistory?.length) {
    return <FinishedPhases phases={job.phaseHistory} t={t} />;
  }
  const detail =
    live && phase === "planning" && live.planning ? (
      <PlanningPanel progress={live.planning} t={t} />
    ) : live && phase === "audio" && live.audio ? (
      <AudioPanel progress={live.audio} stale={stale} t={t} />
    ) : live && phase === "subtitles" && live.subtitles ? (
      <SubtitlePanel progress={live.subtitles} nowMs={nowMs} t={t} />
    ) : live && phase === "assembling" && live.assembly ? (
      <AssemblyPanel progress={live.assembly} stale={stale} t={t} />
    ) : live && phase === "validating" && live.verification ? (
      <VerificationPanel progress={live.verification} stale={stale} t={t} />
    ) : live && phase === "publishing" && live.publish ? (
      <PublishPanel progress={live.publish} t={t} />
    ) : null;

  /*
   * No payload for this phase — it is video, or it is a phase whose sample has
   * not arrived yet, or the job is being read from its row after a restart. The
   * epoch panel is the right thing to show in all three: it is the only one
   * that can describe a build from the durable record alone.
   */
  if (!detail && live && phase && phase !== "encoding") {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <span className={LABEL}>
          {t(BUILD_PHASE_LABEL_KEYS[phase] as never)}
        </span>
        <PhaseStartingPanel live={live} nowMs={nowMs} t={t} />
      </div>
    );
  }
  if (!detail) {
    return <EpochPanel job={job} live={live} nowMs={nowMs} t={t} />;
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <span className={LABEL}>
        {phase ? t(BUILD_PHASE_LABEL_KEYS[phase] as never) : ""}
      </span>
      {detail}
    </div>
  );
}

/**
 * The phase panel, exported so its rendering can be tested directly.
 *
 * The panels are what turn a measurement into something on screen, and testing
 * them through the whole page would mean standing up a live stream to reach
 * them. Named for what it is rather than dressed up as production API.
 */
export const PhaseDetailForTest = PhaseDetail;

export function MediaProcessingPage() {
  const { language, t } = useLanguage();
  const [activeTab, setActiveTab] = useState<"titles" | "processes">("titles");
  /**
   * Which half of the Processes tab is showing.
   *
   * One list held both the queue and the history, so a page of yesterday's
   * completed encodes sat between the operator and the thing that is running
   * right now. They answer different questions — "what is happening" and "what
   * happened" — and only the first of them can be reordered.
   */
  const [outcomeTab, setOutcomeTab] = useState<ProcessingOutcomeTab>("active");
  /**
   * The order the operator has just dragged the queue into.
   *
   * Held until the server's own answer says the same thing. The page polls
   * once a second, so without it a poll landing between the drop and the
   * server's reply would snap the row back to where it came from and then
   * forward again — which reads as the drag having failed.
   */
  const [queueOverride, setQueueOverride] = useState<string[] | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  /**
   * The waiting jobs the operator has ticked, for a move that takes several.
   *
   * A season queued out of order is forty rows, and dragging them one at a
   * time is the reason the queue tab had a reorder nobody used. Held as ids
   * rather than positions so the one-second poll cannot change what is
   * selected — and pruned, below, of anything that stops being movable.
   */
  const [selectedQueueIds, setSelectedQueueIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Which sweep of the whole queue is in flight, if any. */
  const [bulkBusy, setBulkBusy] = useState<"resume" | "pause" | null>(null);
  /**
   * The queue order held still for the length of a drag.
   *
   * The rows rearrange under the cursor by transform, not by moving in the
   * DOM, so the list the gesture was measured against has to stay the list on
   * screen. Without this the one-second poll would re-sort the queue mid-drag
   * and the card would be dropped into a slot that had moved.
   */
  const [dragFreeze, setDragFreeze] = useState<string[] | null>(null);
  /**
   * Which content kind the Titles tab is showing.
   *
   * A switch rather than one merged list: a film is one processing unit and an
   * episode is one of eighty-six, and flattening the two into a single stream
   * of cards loses the only structure that makes a show navigable.
   */
  const [contentKind, setContentKind] = useState<"movies" | "series">("movies");
  /*
   * Which shows and seasons the operator has opened.
   *
   * Held by catalogue id rather than by position, and never rebuilt from the
   * server's response, so the one-second poll that refreshes job state cannot
   * close a season somebody is reading.
   */
  const [expandedSeriesIds, setExpandedSeriesIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedSeasonIds, setExpandedSeasonIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [seriesSearchTerm, setSeriesSearchTerm] = useState("");
  const [busySeriesId, setBusySeriesId] = useState<string | null>(null);
  const [busySeasonId, setBusySeasonId] = useState<string | null>(null);
  const [overview, setOverview] = useState<ProcessingOverview | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now());
  /** Serialises the two recovery presses so neither can be double-fired. */
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  /**
   * Set when verification found a volume that is not the one quarantined.
   *
   * Gates the adoption button: replacing storage is offered only once the
   * ordinary check has actually been run and refused, so nobody reaches for it
   * as a shortcut past a check that would have passed.
   */
  const [storageIdentityUnconfirmed, setStorageIdentityUnconfirmed] =
    useState(false);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [titlesLoading, setTitlesLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [previews, setPreviews] = useState<Record<string, PreviewLoadState>>(
    {},
  );
  const [startingItemId, setStartingItemId] = useState<string | null>(null);
  /**
   * The title whose source deletion has been armed, and the one being deleted.
   *
   * Deleting a source cannot be undone, so the first press only arms the
   * second: one press of a button sitting where "start processing" used to be
   * must never be enough to remove the file. Only one title can be armed at a
   * time, and arming another disarms the first.
   */
  const [confirmingDeleteItemId, setConfirmingDeleteItemId] = useState<
    string | null
  >(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [removingJobIds, setRemovingJobIds] = useState<Set<string>>(new Set());
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<ProcessingJob | null>(null);
  const [events, setEvents] = useState<ProcessingJobEvent[]>([]);
  /**
   * The newest encoder sample, and which job it belongs to.
   *
   * Kept beside the job rather than merged into it because the two have very
   * different lifetimes: the job row survives a restart and this does not.
   */
  const [live, setLive] = useState<{
    jobId: string;
    snapshot: ProcessingLiveProgress;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [streamState, setStreamState] = useState<
    "idle" | "live" | "reconnecting"
  >("idle");
  const sourceRef = useRef<EventSource | null>(null);
  const overviewRequestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setPageTitle(t("processing.title"));
  }, [t]);

  const refreshOverview = useCallback(async () => {
    if (overviewRequestRef.current) return overviewRequestRef.current;
    const request = (async () => {
      try {
        setOverview(await getProcessingOverview());
        setRefreshedAt(Date.now());
      } catch {
        notify({ tone: "error", title: t("common.somethingWentWrong") });
      } finally {
        setLoading(false);
      }
    })();
    overviewRequestRef.current = request;
    await request.finally(() => {
      if (overviewRequestRef.current === request) {
        overviewRequestRef.current = null;
      }
    });
  }, [t]);

  useEffect(() => {
    void refreshOverview();
    const timer = window.setInterval(
      () => void refreshOverview(),
      PROCESSING_REFRESH_MS,
    );
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOverview();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [refreshOverview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const views: MediaLibrary[] = await getUserViews();
        const movies = views.find((view) => view.CollectionType === "movies");
        if (!movies) return;
        const found = await getVideoItemsForLibrary(movies.Id);
        if (!cancelled) setItems(found);
      } catch {
        // History and running jobs still work when the catalogue is offline.
      } finally {
        if (!cancelled) setTitlesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Previewing can probe a large media file, so titles are deliberately
   * analysed one at a time. The catalogue cards render before this loop starts
   * yielding results, keeping initial page load independent of ffprobe speed.
   */
  useEffect(() => {
    if (items.length === 0) return undefined;
    let cancelled = false;
    setPreviews(
      Object.fromEntries(items.map((item) => [item.Id, { status: "waiting" }])),
    );

    void (async () => {
      for (const item of items) {
        if (cancelled) return;
        setPreviews((current) => ({
          ...current,
          [item.Id]: { status: "loading" },
        }));
        try {
          const value = await loadProcessingPreview(item.Id);
          if (cancelled) return;
          setPreviews((current) => ({
            ...current,
            [item.Id]: { status: "ready", value },
          }));
        } catch (error) {
          if (cancelled) return;
          setPreviews((current) => ({
            ...current,
            [item.Id]: {
              status: "error",
              error,
            },
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [items]);

  /**
   * Live progress for the open job.
   *
   * Reconnects resume from the last sequence the page already has, so a refresh
   * mid-encode continues the timeline instead of replaying or losing it.
   */
  /*
   * The job whose live stream is worth holding open.
   *
   * The one an operator has opened, or failing that the one that is actually
   * encoding — so the running card moves at the encoder's own rate rather than
   * at the overview poll, without anybody having to open it first.
   */
  const runningJobId =
    overview?.jobs.find((entry) => entry.state === "running")?.id ?? null;
  const streamJobId = openJobId ?? runningJobId;

  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setLive(null);
    if (!streamJobId) {
      setStreamState("idle");
      return undefined;
    }
    const jobId = streamJobId;

    let closed = false;
    void (async () => {
      const snapshot = await getProcessingJob(jobId).catch(() => null);
      if (closed || !snapshot) return;
      setOpenJob(snapshot.job);
      setEvents(snapshot.events);
      if (snapshot.live) setLive({ jobId, snapshot: snapshot.live });

      const connect = (from: number) => {
        if (closed) return;
        const source = new EventSource(processingStreamUrl(jobId, from), {
          withCredentials: true,
        });
        sourceRef.current = source;
        source.addEventListener("open", () => setStreamState("live"));
        source.addEventListener("progress", (event) => {
          const frame = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJob;
          setOpenJob((previous) => mergeJobFrame(previous ?? undefined, frame));
        });
        source.addEventListener("stage", (event) => {
          const entry = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJobEvent;
          setEvents((previous) => mergeEvents(previous, [entry]));
        });
        /*
         * The fast lane. Out-of-order delivery is possible on a reconnect, so
         * a sample older than the one on screen is discarded by its revision
         * rather than trusted for having arrived last.
         */
        source.addEventListener("live", (event) => {
          const snapshot = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingLiveProgress;
          setLive((previous) =>
            previous &&
            previous.jobId === snapshot.processingJobId &&
            previous.snapshot.revision >= snapshot.revision
              ? previous
              : { jobId: snapshot.processingJobId, snapshot },
          );
        });
        source.addEventListener("done", (event) => {
          const frame = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as ProcessingJob;
          setOpenJob((previous) => mergeJobFrame(previous ?? undefined, frame));
          setStreamState("idle");
          setLive(null);
          source.close();
          void refreshOverview();
        });
        source.addEventListener("error", () => {
          if (closed) return;
          setStreamState("reconnecting");
          source.close();
          // The browser's own retry would replay from the start, so the
          // reconnect is made explicitly from the last sequence seen.
          window.setTimeout(() => {
            setEvents((current) => {
              connect(lastSequence(current));
              return current;
            });
          }, 1500);
        });
      };

      connect(lastSequence(snapshot.events));
    })();

    return () => {
      closed = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [streamJobId, refreshOverview]);

  /*
   * Repaints between authoritative samples so the seconds counter moves rather
   * than stepping. Only runs while there is a live sample to interpolate from,
   * so a finished or storage-paused job costs nothing.
   */
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  const runPreview = useCallback(async (itemId: string) => {
    setPreviews((current) => ({
      ...current,
      [itemId]: { status: "loading" },
    }));
    try {
      const value = await loadProcessingPreview(itemId);
      setPreviews((current) => ({
        ...current,
        [itemId]: { status: "ready", value },
      }));
    } catch (error) {
      setPreviews((current) => ({
        ...current,
        [itemId]: {
          status: "error",
          error,
        },
      }));
    }
  }, []);

  const startJob = useCallback(
    async (itemId: string) => {
      setStartingItemId(itemId);
      try {
        const { job } = await enqueueProcessing(itemId);
        setOpenJobId(job.id);
        await refreshOverview();
        await runPreview(itemId);
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
      } finally {
        setStartingItemId(null);
      }
    },
    [refreshOverview, runPreview, t],
  );

  /**
   * Starting one episode.
   *
   * The same request a film's button makes, against the episode's own item.
   * There is deliberately no episode-specific endpoint: an episode is a title
   * with a canonical source like any other, and the server decides everything
   * about how it is packaged.
   */
  const startEpisode = useCallback(
    async (episode: ProcessingEpisode) => {
      setStartingItemId(episode.itemId);
      try {
        const { job } = await enqueueProcessing(
          episode.itemId,
          episode.mediaFileId ?? undefined,
        );
        setOpenJobId(job.id);
        await refreshOverview();
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
      } finally {
        setStartingItemId(null);
      }
    },
    [refreshOverview, t],
  );

  /**
   * One press, one server-side batch, one job per eligible episode.
   *
   * Not eighty browser requests. The server holds the only consistent view of
   * which episodes already have jobs, so letting it decide is what makes a
   * double press idempotent instead of a race — and `busy` here only stops the
   * second press being *sent*, it is not what makes it safe.
   */
  const runBulk = useCallback(
    async (
      request: () => Promise<{
        queued: number;
        alreadyQueued: number;
        alreadyComplete: number;
        unavailable: number;
        failed: number;
      }>,
      setBusy: (value: string | null) => void,
      id: string,
    ) => {
      setBusy(id);
      try {
        const outcome = await request();
        notify({
          tone: outcome.queued > 0 ? "success" : "info",
          title: describeBulkOutcome(
            outcome,
            (key) => t(key as never),
            formatTemplate,
          ),
        });
        await refreshOverview();
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
      } finally {
        setBusy(null);
      }
    },
    [refreshOverview, t],
  );

  const startSeason = useCallback(
    (season: ProcessingSeason) =>
      void runBulk(
        () => processSeason(season.seasonId),
        setBusySeasonId,
        season.seasonId,
      ),
    [runBulk],
  );

  const startSeries = useCallback(
    (series: ProcessingSeries) =>
      void runBulk(
        () => processSeries(series.seriesId),
        setBusySeriesId,
        series.seriesId,
      ),
    [runBulk],
  );

  const toggleSeries = useCallback((seriesId: string) => {
    setExpandedSeriesIds((current) => {
      const next = new Set(current);
      if (!next.delete(seriesId)) next.add(seriesId);
      return next;
    });
  }, []);

  const toggleSeason = useCallback((seasonId: string) => {
    setExpandedSeasonIds((current) => {
      const next = new Set(current);
      if (!next.delete(seasonId)) next.add(seasonId);
      return next;
    });
  }, []);

  /**
   * Removes a finished title's source file.
   *
   * Only reachable from the armed second press, and only for a title whose
   * package the preview reports as holding every rendition. The server checks
   * that again for itself before unlinking anything — this is the operator's
   * intent, not the authority on whether the file is still needed.
   */
  const deleteSource = useCallback(
    async (itemId: string, sizeBytes: number) => {
      setDeletingItemId(itemId);
      try {
        const result = await deleteProcessingSource(itemId);
        setConfirmingDeleteItemId(null);
        notify({
          tone: "success",
          title: formatTemplate(
            t(
              result.alreadyAbsent
                ? "processing.sourceAlreadyGone"
                : "processing.sourceDeleted",
            ),
            {
              size: formatFileSize(
                result.alreadyAbsent ? sizeBytes : result.freedBytes,
              ),
            },
          ),
        });
        await refreshOverview();
        await runPreview(itemId);
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
        // The preview is re-read on failure too: a refusal is nearly always the
        // server disagreeing with what this page was still showing.
        await runPreview(itemId);
      } finally {
        setDeletingItemId(null);
      }
    },
    [refreshOverview, runPreview, t],
  );

  /**
   * Deletes episode source files only after a fresh preflight has verified
   * every member of the requested season/show.
   *
   * Actual unlinking still goes through /processing/source/delete, whose server
   * implementation independently re-checks every individual title immediately
   * before the irreversible unlink.
   */
  const deleteTvSources = useCallback(
    async (deleteKey: string, itemIds: readonly string[]) => {
      if (itemIds.length === 0) return;

      setDeletingItemId(deleteKey);

      try {
        /*
         * Sequential on purpose. Previewing can fingerprint/probe large files,
         * so a whole season must not hammer the storage with concurrent reads.
         */
        const fresh: ProcessingPreview[] = [];

        for (const itemId of itemIds) {
          fresh.push(await previewProcessing(itemId));
        }

        /*
         * Preflight every episode before deleting the first source.
         *
         * A source already removed earlier is acceptable only when its finished
         * package still exists and is complete.
         */
        const unsafe = fresh.find((preview) => {
          if (preview.activeJobId) return true;

          if (preview.sourceAvailable === false) {
            return (
              !preview.existing.present || preview.existing.complete !== true
            );
          }

          return (
            !preview.existing.present ||
            !preview.existing.current ||
            preview.existing.missingRungs.length > 0
          );
        });

        if (unsafe) {
          throw new Error(t("processing.tv.deleteSourcesVerificationFailed"));
        }

        const remaining = fresh.filter(
          (preview) => preview.sourceAvailable !== false,
        );

        let removed = 0;
        let freedBytes = 0;

        for (const preview of remaining) {
          /*
           * This endpoint performs the authoritative final checks:
           * source fingerprint, current profile, missing rungs, active job,
           * manifest readability, and every package file's existence/size.
           */
          const result = await deleteProcessingSource(preview.itemId);

          if (result.deleted) {
            removed += 1;
            freedBytes += result.freedBytes;
          }
        }

        setConfirmingDeleteItemId(null);

        notify({
          tone: "success",
          title:
            remaining.length === 0
              ? t("processing.sourceAlreadyGone")
              : formatTemplate(t("processing.tv.sourcesDeleted"), {
                  count: String(removed),
                  size: formatFileSize(freedBytes),
                }),
        });

        await refreshOverview();
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });

        await refreshOverview();
      } finally {
        setDeletingItemId(null);
      }
    },
    [refreshOverview, t],
  );

  const removeJob = useCallback(
    async (jobId: string) => {
      setRemovingJobIds((current) => new Set(current).add(jobId));
      try {
        await deleteProcessingJob(jobId);
        if (openJobId === jobId) setOpenJobId(null);
        await refreshOverview();
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
      } finally {
        setRemovingJobIds((current) => {
          const next = new Set(current);
          next.delete(jobId);
          return next;
        });
      }
    },
    [openJobId, refreshOverview, t],
  );

  const itemTitleFor = useCallback(
    (itemId: string) =>
      items.find((item) => item.Id === itemId)
        ? getDisplayTitle(items.find((item) => item.Id === itemId)!)
        : itemId.slice(0, 8),
    [items],
  );

  /*
   * Memoised so the arrays below have a stable identity between polls that
   * return equivalent data; without it every dependent memo recomputes on
   * every render and the tree re-renders while nothing has changed.
   */
  const jobs = useMemo(() => overview?.jobs ?? [], [overview]);
  const storage = overview?.storage;
  /*
   * The titles the guard is holding. Read from the pause reason rather than
   * inferred from the storage state, because the two can disagree for exactly
   * one job — the one whose own attempt met the I/O error and which is held
   * even while the volume as a whole has not yet earned a quarantine.
   */
  const heldJobs = jobs.filter(
    (job) =>
      job.pausedReason === "storage-quarantined" ||
      job.pausedReason === "recovery-pending",
  );
  const activeItemIds = useMemo(
    () =>
      new Set(
        jobs
          .filter((job) =>
            ["pending", "queued", "running", "paused"].includes(job.state),
          )
          .map((job) => job.itemId),
      ),
    [jobs],
  );
  const counts = overview?.counts;
  const hardware = overview?.hardware;
  const detail = openJob;
  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLocaleLowerCase(language);
    return [...items]
      .sort((left, right) =>
        getDisplayTitle(left).localeCompare(getDisplayTitle(right), language),
      )
      .filter((item) =>
        query
          ? getDisplayTitle(item).toLocaleLowerCase(language).includes(query)
          : true,
      );
  }, [items, language, searchTerm]);
  /*
   * The shows, narrowed by the search.
   *
   * `useMemo` on the overview's own array, so a poll that returns an
   * equivalent tree produces an equivalent filtered tree and React re-renders
   * rows in place. The expansion sets are keyed by catalogue id and are not
   * touched here at all.
   */
  const allSeries = useMemo(() => overview?.series ?? [], [overview]);
  const filteredSeries = useMemo(
    () => filterSeries(allSeries, seriesSearchTerm, language),
    [allSeries, seriesSearchTerm, language],
  );
  /*
   * A search opens what it found, without disturbing what the operator opened.
   * Clearing the search therefore returns the page to their own expansions
   * rather than to a collapsed list.
   */
  const searchExpansion = useMemo(
    () => autoExpandedIds(filteredSeries, seriesSearchTerm),
    [filteredSeries, seriesSearchTerm],
  );
  const visibleExpandedSeriesIds = useMemo(
    () => new Set([...expandedSeriesIds, ...searchExpansion.seriesIds]),
    [expandedSeriesIds, searchExpansion],
  );
  const visibleExpandedSeasonIds = useMemo(
    () => new Set([...expandedSeasonIds, ...searchExpansion.seasonIds]),
    [expandedSeasonIds, searchExpansion],
  );
  /*
   * The two halves of the Processes tab, each in its own order: the queue
   * forwards, because its top is what happens next, and the history backwards,
   * because its top is what just happened.
   */
  const { active: activeJobs, finished: finishedJobs } = useMemo(
    () => partitionProcessingJobs(jobs),
    [jobs],
  );
  const queue = useMemo(
    () =>
      applyQueueOverride(
        applyQueueOverride(activeJobs, queueOverride),
        dragFreeze,
      ),
    [activeJobs, dragFreeze, queueOverride],
  );
  /** The rows that are genuinely still waiting, and so can be moved. */
  const movableQueue = useMemo(() => queue.filter(canReorder), [queue]);
  const visibleJobs = outcomeTab === "active" ? queue : finishedJobs;

  /*
   * The optimistic order is dropped the moment it stops being useful: either
   * the server has confirmed it, or the queue is no longer the same set of
   * jobs and the override describes a line that does not exist. Comparing the
   * answer rather than trusting the request is what keeps a rejected reorder
   * from leaving the page showing an order the machine will not follow.
   */
  useEffect(() => {
    if (!queueOverride) return;
    const confirmed = activeJobs.filter(canReorder).map((job) => job.id);
    const sameLength = confirmed.length === queueOverride.length;
    const sameOrder =
      sameLength && confirmed.every((id, index) => id === queueOverride[index]);
    const sameSet =
      sameLength && confirmed.every((id) => queueOverride.includes(id));
    if (sameOrder || !sameSet) setQueueOverride(null);
  }, [activeJobs, queueOverride]);

  const commitQueueOrder = useCallback(
    async (orderedIds: string[]) => {
      setQueueOverride(orderedIds);
      setReorderBusy(true);
      try {
        await reorderProcessingQueue(orderedIds);
      } catch (error) {
        /*
         * The override goes immediately on a refusal. Leaving it up would show
         * an order the encoder is not going to follow, which is worse than the
         * row visibly springing back.
         */
        setQueueOverride(null);
        notify({
          tone: "error",
          title: describeErrorForUser(error, t, "processing.queueOrder.failed"),
        });
      } finally {
        setReorderBusy(false);
        await refreshOverview();
      }
    },
    [refreshOverview, t],
  );

  const movableIds = useMemo(
    () => movableQueue.map((job) => job.id),
    [movableQueue],
  );

  /**
   * The drag itself: which row is held, where it would land, and how far the
   * rows around it have moved to make room.
   *
   * The list rearranges as the pointer crosses each slot, so what is on screen
   * at any moment is what a release would save. Only waiting rows are handed
   * to it — the encode underway has already been claimed by a worker and its
   * position means nothing to the server.
   */
  const sortable = useQueueSortable({
    ids: movableIds,
    disabled: reorderBusy,
    onDragStart: setDragFreeze,
    onDragEnd: () => setDragFreeze(null),
    onCommit: (orderedIds) => void commitQueueOrder(orderedIds),
  });

  /*
   * A queue that changed shape underneath the gesture — the head of the line
   * claimed by a worker, a job cancelled from another tab — no longer matches
   * the geometry the drag was measured against. Ending it puts the row back
   * where the server says it is rather than dropping it into a slot that has
   * moved.
   */
  const cancelQueueDrag = sortable.cancel;
  useEffect(() => {
    if (!dragFreeze) return;
    const waiting = new Set(activeJobs.filter(canReorder).map((job) => job.id));
    const intact =
      waiting.size === dragFreeze.length &&
      dragFreeze.every((id) => waiting.has(id));
    if (!intact) cancelQueueDrag();
  }, [activeJobs, cancelQueueDrag, dragFreeze]);

  /**
   * One step up or down, for the handle's arrow keys.
   *
   * A queue that can only be arranged by dragging is a queue that cannot be
   * arranged without a mouse, and this page is often open on a machine being
   * operated over a remote session.
   */
  const nudgeQueueJob = useCallback(
    (jobId: string, delta: -1 | 1) => {
      // Held off while a reorder is in flight, for the same reason the drag is:
      // a second order computed from a list the server has not answered for yet
      // is an order that can arrive out of sequence.
      if (reorderBusy) return;
      const from = movableQueue.findIndex((job) => job.id === jobId);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= movableQueue.length) return;
      void commitQueueOrder(
        moveItem(movableQueue, from, to).map((job) => job.id),
      );
    },
    [commitQueueOrder, movableQueue, reorderBusy],
  );

  /*
   * The selection, kept honest against a queue that moves on its own.
   *
   * A ticked job that has since been claimed by a worker is no longer
   * something a group move can carry, and leaving it in the set would have the
   * next press send an order the server refuses. Dropped silently: the row
   * itself has visibly changed state, which is the explanation.
   */
  useEffect(() => {
    setSelectedQueueIds((current) => {
      if (current.size === 0) return current;
      const movable = new Set(movableIds);
      const kept = [...current].filter((id) => movable.has(id));
      if (kept.length === current.size) return current;
      return new Set(kept);
    });
  }, [movableIds]);

  /** The selection in queue order, which is the order a group move uses. */
  const selectedInOrder = useMemo(
    () => movableIds.filter((id) => selectedQueueIds.has(id)),
    [movableIds, selectedQueueIds],
  );

  const toggleQueueSelection = useCallback((jobId: string) => {
    setSelectedQueueIds((current) => {
      const next = new Set(current);
      if (!next.delete(jobId)) next.add(jobId);
      return next;
    });
  }, []);

  /**
   * The rows a press should carry: the selection when the row is part of it,
   * and the row alone when it is not.
   *
   * Grabbing an unticked row is not a mistake to be corrected — it is the
   * ordinary single-row drag, and it must keep working while a selection is
   * standing.
   */
  const blockFor = useCallback(
    (jobId: string) =>
      selectedQueueIds.has(jobId) && selectedInOrder.length > 1
        ? selectedInOrder
        : undefined,
    [selectedInOrder, selectedQueueIds],
  );

  /** Job identity, so the queue tab can say which show's pilot is encoding. */
  const jobTitlesById = useMemo(
    () =>
      new Map((overview?.jobTitles ?? []).map((entry) => [entry.jobId, entry])),
    [overview],
  );

  /*
   * The arrangements that take one press instead of forty drags.
   *
   * Each of them is the same shape: work out the whole new order from the one
   * on screen, and hand it to the same commit the drag uses. Nothing here
   * knows about the server, and nothing about them is optimistic in a way the
   * drag is not — a refusal springs the queue back exactly as it does there.
   */
  const groupQueueByShow = useCallback(() => {
    const arranged = arrangeByShowAndEpisode(movableIds, (id) =>
      jobTitlesById.get(id),
    );
    if (arranged.every((id, index) => id === movableIds[index])) return;
    void commitQueueOrder(arranged);
  }, [commitQueueOrder, jobTitlesById, movableIds]);

  const sendQueueToFront = useCallback(
    (jobIds: readonly string[]) => {
      const arranged = moveToFront(movableIds, jobIds);
      if (arranged.every((id, index) => id === movableIds[index])) return;
      void commitQueueOrder(arranged);
    },
    [commitQueueOrder, movableIds],
  );

  const sendQueueToBack = useCallback(
    (jobIds: readonly string[]) => {
      const arranged = moveToBack(movableIds, jobIds);
      if (arranged.every((id, index) => id === movableIds[index])) return;
      void commitQueueOrder(arranged);
    },
    [commitQueueOrder, movableIds],
  );

  /** Every pause an operator can lift, and everything they can still hold. */
  const resumableJobs = useMemo(
    () => activeJobs.filter((job) => canResume(job)),
    [activeJobs],
  );
  const holdableJobs = useMemo(
    () => activeJobs.filter((job) => job.state !== "running" && canPause(job)),
    [activeJobs],
  );

  /**
   * One press over a whole queue, one request per job.
   *
   * Sequential rather than parallel: forty simultaneous writes to the same
   * table is how a queue tab takes the API down, and the operator is watching
   * a list that updates when it finishes either way. What failed is counted
   * rather than thrown — a job that started encoding halfway through the sweep
   * refuses its pause, and that is a race, not an error worth a dialogue.
   */
  const sweepQueue = useCallback(
    async (
      kind: "resume" | "pause",
      jobs: readonly ProcessingJob[],
      act: (jobId: string) => Promise<unknown>,
    ) => {
      if (jobs.length === 0 || bulkBusy) return;
      setBulkBusy(kind);
      let failed = 0;
      try {
        for (const job of jobs) {
          await act(job.id).catch(() => {
            failed += 1;
          });
        }
      } finally {
        setBulkBusy(null);
        await refreshOverview();
      }
      if (failed > 0) {
        notify({
          tone: "warning",
          title: formatTemplate(t("processing.bulk.failed"), {
            count: String(failed),
          }),
        });
      }
    },
    [bulkBusy, refreshOverview, t],
  );

  /**
   * One press against one job, and what to say when the server refuses it.
   *
   * These four presses used to swallow their errors, which turned every
   * refusal the server has a sentence for — a source no longer on disk, a
   * volume under quarantine, an attempt already cancelling — into a button
   * that could be pressed all evening without doing anything or saying why.
   * The refresh stays in `finally`: a press that failed still leaves the row
   * to be re-read, because the reason it failed is usually something that has
   * changed since the page last asked.
   */
  const runJobAction = useCallback(
    async (act: () => Promise<unknown>) => {
      try {
        await act();
      } catch (error) {
        notify({
          tone: "error",
          title: describeErrorForUser(error, t),
        });
      } finally {
        await refreshOverview();
      }
    },
    [refreshOverview, t],
  );

  const dateLocale = language === "tr" ? "tr-TR" : "en-US";
  const languages = useMemo(
    () =>
      summariseLanguages(
        detail?.decision?.streams.audio,
        detail?.decision?.streams.subtitles,
        (key) => t(key as never),
        t("processing.forced"),
      ),
    [detail, t],
  );

  return (
    <div className="min-h-screen bg-black px-4 pb-24 pt-6 text-white sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-3">
          <div>
            <h1 className="text-3xl font-black tracking-tight">
              {t("processing.title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-white/50">
              {t("processing.subtitle")}
            </p>
          </div>
        </header>

        <div
          role="tablist"
          aria-label={t("processing.title")}
          className="grid w-full grid-cols-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit sm:min-w-80"
        >
          {(["titles", "processes"] as const).map((tab) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`processing-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`processing-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  selected
                    ? "bg-white/[0.1] text-white shadow-sm"
                    : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                }`}
              >
                {t(`processing.tabs.${tab}`)}
                {tab === "processes" && jobs.length > 0 ? (
                  <span
                    className={`rounded-full px-1.5 py-auto text-[0.6875rem] tabular-nums ${
                      selected
                        ? "bg-[var(--accent)] text-black"
                        : "bg-white/10 text-white/55"
                    }`}
                  >
                    {jobs.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* ------------------------------------------------ health strip */}
        <section
          className={`${CARD} flex flex-wrap items-center gap-x-8 gap-y-4`}
        >
          <div className="flex items-center gap-2">
            <Cpu
              size={18}
              className="text-[var(--accent)]"
              aria-hidden="true"
            />
            <span className={LABEL}>{t("processing.hardware")}</span>
          </div>
          {loading && !hardware ? (
            <div
              className="h-5 w-40 animate-pulse rounded bg-white/10"
              aria-label={t("processing.loading")}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {hardware?.adapters.map((adapter) => (
                <Chip
                  key={adapter.id}
                  tone={adapter.available ? "ok" : "muted"}
                >
                  <span title={adapter.detail ?? undefined}>
                    {adapter.label}
                    {!adapter.available && adapter.reason
                      ? ` — ${t(`processing.reason.${adapter.reason}` as never)}`
                      : ""}
                  </span>
                </Chip>
              ))}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-6">
            <Stat
              label={t("processing.counts.queued")}
              value={String((counts?.queued ?? 0) + (counts?.pending ?? 0))}
            />
            <Stat
              label={t("processing.counts.running")}
              value={String(counts?.running ?? 0)}
            />
            {/*
             * Paused work is counted in its own right. Without it this strip
             * read "0 queued, 0 running" beside a list of jobs that were
             * plainly there, which invites the conclusion that the page is
             * broken rather than that the jobs are held.
             */}
            <Stat
              label={t("processing.counts.paused")}
              value={String(counts?.paused ?? 0)}
            />
            <Stat
              label={t("processing.counts.succeeded")}
              value={String(counts?.succeeded ?? 0)}
            />
            <Stat
              label={t("processing.counts.failed")}
              value={String(counts?.failed ?? 0)}
            />
          </div>
        </section>

        {/* ------------------------------------------ storage quarantine */}
        {/*
          Severity is carried by the whole border and a faint wash of the status
          hue, not by a bar down one edge. Amber is a far brighter hue than red,
          so the two are tuned to their luminance rather than to matching
          numbers: equal alphas would make the recoverable warning shout louder
          than the blocking fault.
        */}
        {storage && storage.state !== "healthy" ? (
          <section
            className={`flex flex-col gap-4 rounded-2xl border p-4 sm:p-5 ${
              storage.automaticResumeBlocked
                ? "border-red-400/50 bg-red-400/[0.06]"
                : "border-amber-400/30 bg-amber-400/[0.035]"
            }`}
            aria-live="polite"
          >
            <div className="flex flex-wrap items-start gap-3">
              <AlertTriangle
                size={18}
                className={
                  storage.automaticResumeBlocked
                    ? "mt-0.5 shrink-0 text-red-400"
                    : "mt-0.5 shrink-0 text-amber-400"
                }
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-white">
                  {storageSummary(storage, t)}
                </span>
                {/*
                  The reason carries the evidence — which errno, how many faults —
                  and it is what somebody deciding between a new cable and a new
                  disk actually needs. It is server-sanitised: no path reaches it.
                */}
                <span className="text-xs text-white/60">{storage.reason}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <Stat label={t("processing.storage.root")} value={storage.root} />
              {storage.faultCount > 0 ? (
                <Stat
                  label={t("processing.storage.faults")}
                  value={String(storage.faultCount)}
                />
              ) : null}
              {storage.firstFaultAt ? (
                <Stat
                  label={t("processing.storage.firstFault")}
                  value={new Date(storage.firstFaultAt).toLocaleString()}
                />
              ) : null}
              <Stat
                label={t("processing.storage.automaticResume")}
                value={
                  storage.automaticResumeBlocked
                    ? t("processing.storage.blocked")
                    : t("processing.storage.allowed")
                }
              />
            </div>

            {/*
              Which titles this is holding, so the panel answers "what is it
              costing me" as well as "what is wrong". The last safe checkpoint is
              shown from the job's own verified counters rather than from a
              claim, which is the whole correction here.
            */}
            {heldJobs.length > 0 ? (
              <ul className="flex flex-col gap-1 text-xs text-white/70">
                {heldJobs.slice(0, 5).map((job) => (
                  <li key={job.id} className="truncate">
                    {itemTitleFor(job.itemId)}
                    {job.completedEpochs > 0
                      ? ` — ${formatTemplate(t("processing.storage.lastSafe"), {
                          time: formatMediaClock(job.protectedSeconds),
                        })}`
                      : ` — ${t("processing.storage.noCheckpoint")}`}
                  </li>
                ))}
              </ul>
            ) : null}

            {storage.automaticResumeBlocked ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={storageBusy}
                  onClick={async () => {
                    setStorageBusy(true);
                    try {
                      const result = await verifyProcessingStorage();
                      setStorageNotice(result.detail);
                      /*
                       * "Not the same volume" is a different situation from
                       * "did not answer", and only the first has anything to
                       * adopt. Conflating them would offer to adopt a volume
                       * that is not there.
                       */
                      setStorageIdentityUnconfirmed(
                        result.outcome === "identity-unconfirmed",
                      );
                      await refreshOverview();
                    } catch (error) {
                      setStorageNotice(
                        describeErrorForUser(
                          error,
                          t,
                          "processing.storage.verifyFailed",
                        ),
                      );
                    } finally {
                      setStorageBusy(false);
                    }
                  }}
                >
                  {t("processing.storage.verify")}
                </button>
                {/*
                  Only offered once verification has passed. Showing it earlier
                  would let an operator skip the check that establishes the
                  hardware is answering *now*, which is the only cheap evidence
                  anyone has.
                */}
                {/*
                  Offered only after verification has refused on identity. The
                  wording says what it does — this is different storage, and
                  adopting it means the original was not recovered — because a
                  button that read "continue anyway" is exactly the generic
                  override this replaced.
                */}
                {storageIdentityUnconfirmed && !storage.awaitingResume ? (
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={storageBusy}
                    onClick={async () => {
                      setStorageBusy(true);
                      try {
                        const result = await adoptProcessingStorage();
                        setStorageNotice(result.detail);
                        setStorageIdentityUnconfirmed(false);
                        await refreshOverview();
                      } catch (error) {
                        setStorageNotice(
                          describeErrorForUser(
                            error,
                            t,
                            "processing.storage.adoptFailed",
                          ),
                        );
                      } finally {
                        setStorageBusy(false);
                      }
                    }}
                  >
                    {t("processing.storage.adopt")}
                  </button>
                ) : null}
                {storage.awaitingResume ? (
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={storageBusy}
                    onClick={async () => {
                      setStorageBusy(true);
                      try {
                        await resumeProcessingStorage();
                        setStorageNotice(null);
                        await refreshOverview();
                      } catch (error) {
                        setStorageNotice(
                          describeErrorForUser(
                            error,
                            t,
                            "processing.storage.resumeFailed",
                          ),
                        );
                      } finally {
                        setStorageBusy(false);
                      }
                    }}
                  >
                    {t("processing.storage.resume")}
                  </button>
                ) : null}
                {storageNotice ? (
                  <span className="text-xs text-white/60">{storageNotice}</span>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* --------------------------------------- searchable title catalogue */}
        {activeTab === "titles" ? (
          <section
            id="processing-panel-titles"
            role="tabpanel"
            aria-labelledby="processing-tab-titles"
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/*
               * Films or shows. Two content kinds with genuinely different
               * shapes — one title against one source, versus a show whose
               * seasons each hold a dozen independently processable episodes —
               * so they get two views rather than one list that suits neither.
               */}
              <div
                role="tablist"
                aria-label={t("processing.chooseTitle")}
                className="grid grid-cols-2 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit sm:min-w-64"
              >
                {(["movies", "series"] as const).map((kind) => {
                  const selected = contentKind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      id={`processing-kind-${kind}`}
                      aria-selected={selected}
                      aria-controls={`processing-kind-panel-${kind}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setContentKind(kind)}
                      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                        selected
                          ? "bg-white/[0.1] text-white shadow-sm"
                          : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                      }`}
                    >
                      {t(`processing.kind.${kind}`)}
                      {kind === "series" && allSeries.length > 0 ? (
                        <span
                          className={`rounded-full px-1.5 py-auto text-[0.6875rem] tabular-nums ${
                            selected
                              ? "bg-[var(--accent)] text-black"
                              : "bg-white/[0.08] text-white/60"
                          }`}
                        >
                          {allSeries.length}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <label className="relative block w-full sm:max-w-sm">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={
                    contentKind === "series" ? seriesSearchTerm : searchTerm
                  }
                  onChange={(event) =>
                    contentKind === "series"
                      ? setSeriesSearchTerm(event.target.value)
                      : setSearchTerm(event.target.value)
                  }
                  placeholder={t(
                    contentKind === "series"
                      ? "processing.tv.searchSeries"
                      : "processing.search",
                  )}
                  aria-label={t(
                    contentKind === "series"
                      ? "processing.tv.searchSeries"
                      : "processing.search",
                  )}
                  className="w-full rounded-xl border border-white/10 bg-white/[0.04] py-2.5 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-white/30 hover:border-white/20 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                />
              </label>
            </div>

            {contentKind === "series" ? (
              <div
                id="processing-kind-panel-series"
                role="tabpanel"
                aria-labelledby="processing-kind-series"
              >
                {filteredSeries.length === 0 ? (
                  <div className={`${CARD} text-center text-sm text-white/55`}>
                    {seriesSearchTerm.trim()
                      ? t("processing.tv.noSearchResults")
                      : t("processing.tv.emptySeries")}
                  </div>
                ) : (
                  <ProcessingSeriesTree
                    series={filteredSeries}
                    expandedSeriesIds={visibleExpandedSeriesIds}
                    expandedSeasonIds={visibleExpandedSeasonIds}
                    onToggleSeries={toggleSeries}
                    onToggleSeason={toggleSeason}
                    onProcessSeries={startSeries}
                    onProcessSeason={startSeason}
                    onStartEpisode={(episode) => void startEpisode(episode)}
                    onDeleteEpisodeSource={(episode) =>
                      void deleteTvSources(episode.itemId, [episode.itemId])
                    }
                    onDeleteSeasonSources={(season) =>
                      void deleteTvSources(
                        `season:${season.seasonId}`,
                        season.episodes.map((episode) => episode.itemId),
                      )
                    }
                    onDeleteSeriesSources={(series) =>
                      void deleteTvSources(
                        `series:${series.seriesId}`,
                        series.seasons.flatMap((season) =>
                          season.episodes.map((episode) => episode.itemId),
                        ),
                      )
                    }
                    confirmingDeleteKey={confirmingDeleteItemId}
                    deletingDeleteKey={deletingItemId}
                    onArmDelete={setConfirmingDeleteItemId}
                    onCancelDelete={() => setConfirmingDeleteItemId(null)}
                    busySeriesId={busySeriesId}
                    busySeasonId={busySeasonId}
                    startingItemId={startingItemId}
                    t={(key) => t(key as never)}
                  />
                )}
              </div>
            ) : titlesLoading ? (
              <div
                id="processing-kind-panel-movies"
                role="tabpanel"
                aria-labelledby="processing-kind-movies"
                className="flex flex-col gap-3"
                aria-label={t("processing.loadingTitles")}
              >
                {[0, 1, 2].map((row) => (
                  <div key={row} className={`${CARD} flex gap-4`}>
                    <div className="aspect-[2/3] w-24 shrink-0 animate-pulse rounded-xl bg-white/[0.07] sm:w-28" />
                    <div className="flex flex-1 flex-col gap-3 py-2">
                      <div className="h-5 w-44 animate-pulse rounded bg-white/[0.07]" />
                      <div className="h-16 animate-pulse rounded-xl bg-white/[0.05]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredItems.length === 0 ? (
              <div
                id="processing-kind-panel-movies"
                role="tabpanel"
                aria-labelledby="processing-kind-movies"
                className={`${CARD} text-center text-sm text-white/55`}
              >
                {searchTerm.trim()
                  ? t("processing.noSearchResults")
                  : t("processing.emptyTitles")}
              </div>
            ) : (
              <ul
                id="processing-kind-panel-movies"
                role="tabpanel"
                aria-labelledby="processing-kind-movies"
                className="flex flex-col gap-3"
              >
                {filteredItems.map((item) => {
                  const title = getDisplayTitle(item);
                  const state = previews[item.Id] ?? { status: "waiting" };
                  const itemPreview =
                    state.status === "ready" ? state.value : null;
                  const imageUrl = item.ImageTags?.Primary
                    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 360)
                    : "";
                  const isStarting = startingItemId === item.Id;
                  /*
                   * Nothing can be encoded from bytes that are gone, so a
                   * title whose source has been deleted drops its start button
                   * and describes the package it still holds instead. Split
                   * here rather than at each use so the decision is only read
                   * where it exists.
                   */
                  const orphanPreview =
                    itemPreview && itemPreview.sourceAvailable === false
                      ? itemPreview
                      : null;
                  const readyPreview =
                    itemPreview && itemPreview.sourceAvailable !== false
                      ? itemPreview
                      : null;
                  const orphanComplete =
                    orphanPreview !== null &&
                    orphanPreview.existing.present &&
                    orphanPreview.existing.complete === true;
                  const hasActiveJob = loading
                    ? Boolean(itemPreview?.activeJobId)
                    : activeItemIds.has(item.Id);
                  /*
                   * A title that has everything it will ever be given: its
                   * package was built from these exact bytes under this
                   * profile, and today's ladder would add nothing to it. Only
                   * then is the source dead weight, and only then is removing
                   * it offered in place of starting a run that would encode
                   * nothing.
                   */
                  const canDeleteSource =
                    readyPreview !== null &&
                    readyPreview.existing.present &&
                    readyPreview.existing.current &&
                    readyPreview.existing.missingRungs.length === 0 &&
                    !hasActiveJob;
                  const sourceBytes =
                    readyPreview?.decision.source.sizeBytes ?? 0;
                  const isConfirmingDelete = confirmingDeleteItemId === item.Id;
                  const isDeletingSource = deletingItemId === item.Id;
                  return (
                    <li
                      key={item.Id}
                      className={`${CARD} grid grid-cols-[6rem,minmax(0,1fr)] gap-4 sm:grid-cols-[7rem,minmax(0,1fr)] sm:gap-5`}
                    >
                      <div className="media-card-cinematic relative aspect-[2/3] w-24 self-start overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] sm:w-28">
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-3 text-center text-xs font-bold text-white/80">
                            {title}
                          </div>
                        )}
                        {item.ProductionYear ? (
                          <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[0.6875rem] font-bold text-white/75 backdrop-blur">
                            {item.ProductionYear}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex min-w-0 flex-col gap-3">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-base font-black text-white sm:text-lg">
                              {title}
                            </h2>
                            {itemPreview ? (
                              <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-white/45">
                                {readyPreview
                                  ? readyPreview.decision.summary
                                  : t("processing.sourceMissing")}
                              </p>
                            ) : null}
                          </div>
                          {orphanPreview ? null : canDeleteSource ? (
                            /*
                             * Two presses, never one. The first only arms the
                             * second, and the second says what it costs: the
                             * file is unlinked, not moved anywhere it could be
                             * fetched back from.
                             */
                            isConfirmingDelete ? (
                              <div className="flex flex-col items-stretch gap-1.5 sm:max-w-[16rem]">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void deleteSource(item.Id, sourceBytes)
                                  }
                                  disabled={isDeletingSource}
                                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-xs font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                >
                                  {isDeletingSource ? (
                                    <Loader2
                                      size={14}
                                      className="animate-spin motion-reduce:animate-none"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <AlertTriangle
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  )}
                                  {formatTemplate(
                                    t("processing.deleteSourceConfirm"),
                                    { size: formatFileSize(sourceBytes) },
                                  )}
                                </button>
                                <p className="text-[11px] leading-snug text-white/45">
                                  {t("processing.deleteSourceHint")}
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setConfirmingDeleteItemId(null)
                                  }
                                  disabled={isDeletingSource}
                                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-bold text-white/70 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                                >
                                  {t("processing.deleteSourceCancel")}
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setConfirmingDeleteItemId(item.Id)
                                }
                                className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-400/[0.12] px-3 py-2 text-xs font-black text-rose-100 transition hover:bg-rose-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                              >
                                <Trash2 size={14} aria-hidden="true" />
                                {t("processing.deleteSource")}
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => void startJob(item.Id)}
                              disabled={
                                isStarting ||
                                state.status !== "ready" ||
                                hasActiveJob
                              }
                              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                            >
                              {isStarting ? (
                                <Loader2
                                  size={14}
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Play size={14} aria-hidden="true" />
                              )}
                              {hasActiveJob
                                ? t("processing.activeJob")
                                : t("processing.start")}
                            </button>
                          )}
                        </div>

                        {state.status === "waiting" ||
                        state.status === "loading" ? (
                          <div className="flex min-h-24 items-center justify-center rounded-xl border border-white/[0.07] bg-black/25 text-xs text-white/40">
                            {state.status === "loading" ? (
                              <span className="inline-flex items-center gap-2">
                                <Loader2
                                  size={14}
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                                {t("processing.loadingPreview")}
                              </span>
                            ) : (
                              t("processing.loadingPreview")
                            )}
                          </div>
                        ) : state.status === "error" ? (
                          <div className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] p-3">
                            <p className="line-clamp-2 text-xs text-rose-200/80">
                              {describeErrorForUser(
                                state.error,
                                t,
                                "processing.previewUnavailable",
                              )}
                            </p>
                            <button
                              type="button"
                              onClick={() => void runPreview(item.Id)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-bold text-white/70 transition hover:bg-white/[0.08]"
                            >
                              <RefreshCcw size={12} aria-hidden="true" />
                              {t("processing.tryAgain")}
                            </button>
                          </div>
                        ) : orphanPreview ? (
                          /*
                           * A whole ladder with no source left is a finished
                           * title, not a problem, so it is not dressed as a
                           * warning. Amber is kept for a package that really
                           * is short of rungs it can no longer be given.
                           */
                          <div
                            className={`flex flex-col gap-3 rounded-xl border p-3 sm:p-4 ${
                              orphanComplete
                                ? "border-emerald-400/20 bg-emerald-400/[0.05]"
                                : "border-amber-400/20 bg-amber-400/[0.05]"
                            }`}
                          >
                            <p
                              className={`text-xs font-semibold ${
                                orphanComplete
                                  ? "text-emerald-100/75"
                                  : "text-amber-100/75"
                              }`}
                            >
                              {t("processing.sourceMissingHint")}
                            </p>
                            {orphanPreview.existing.present ? (
                              <>
                                <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                                  <Stat
                                    label={t("processing.dynamicRange")}
                                    value={dynamicRangeLabel(
                                      orphanPreview.existing.hdr ?? "sdr",
                                    )}
                                  />
                                  <Stat
                                    label={t("processing.packageSize")}
                                    value={formatBytes(
                                      orphanPreview.existing.totalBytes,
                                    )}
                                  />
                                  <Stat
                                    label={t("processing.audioKept")}
                                    value={String(
                                      orphanPreview.existing.audioTracks,
                                    )}
                                  />
                                  <Stat
                                    label={t("processing.subtitlesKept")}
                                    value={String(
                                      orphanPreview.existing.subtitleTracks,
                                    )}
                                  />
                                </div>
                                <div className="flex flex-col gap-2">
                                  <span className={LABEL}>
                                    {t("processing.ladder")}
                                  </span>
                                  {/*
                                   * Every rung here is already built, and
                                   * without a source none can be added, so the
                                   * "will be encoded" legend is left off.
                                   */}
                                  <LadderRungs
                                    planned={orphanPreview.existing.rungs}
                                    present={orphanPreview.existing.rungs}
                                    keptLabel={t("processing.rungKept")}
                                  />
                                </div>
                              </>
                            ) : (
                              <p className="text-xs text-white/45">
                                {t("processing.noPackage")}
                              </p>
                            )}
                          </div>
                        ) : readyPreview ? (
                          <div className="flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-black/25 p-3 sm:p-4">
                            {readyPreview.existing?.present &&
                            !readyPreview.existing.current ? (
                              <p className="text-xs font-semibold text-white/55">
                                {formatTemplate(t("processing.rebuildReason"), {
                                  reason: readyPreview.existing.sourceMatches
                                    ? t("processing.rebuildProfile")
                                    : t("processing.rebuildSource"),
                                })}
                              </p>
                            ) : null}
                            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                              <Stat
                                label={t("processing.source")}
                                value={`${readyPreview.decision.source.width}×${readyPreview.decision.source.height}`}
                              />
                              <Stat
                                label={t("processing.dynamicRange")}
                                value={
                                  /*
                                   * The source decides this. The package only
                                   * names the flavour, and only when it agrees
                                   * that there is one — a tone-mapped package
                                   * of an HDR source must not read as SDR.
                                   */
                                  !readyPreview.decision.source.isHdr
                                    ? "SDR"
                                    : readyPreview.existing.present &&
                                        readyPreview.existing.hdr &&
                                        readyPreview.existing.hdr !== "sdr"
                                      ? dynamicRangeLabel(
                                          readyPreview.existing.hdr,
                                        )
                                      : "HDR"
                                }
                              />
                              <Stat
                                label={t("processing.encoder")}
                                value={readyPreview.decision.videoEncoder}
                              />
                              <Stat
                                label={t("processing.estimate")}
                                value={formatBytes(
                                  readyPreview.decision.estimate.outputBytes,
                                )}
                              />
                            </div>
                            <div className="flex flex-col gap-2">
                              <span className={LABEL}>
                                {t("processing.ladder")}
                              </span>
                              <LadderRungs
                                planned={readyPreview.decision.ladder.map(
                                  (rung) => rung.qualityHeight,
                                )}
                                present={
                                  readyPreview.existing?.present
                                    ? readyPreview.existing.rungs
                                    : []
                                }
                                keptLabel={t("processing.rungKept")}
                                buildLabel={t("processing.rungBuild")}
                              />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {/* ------------------------------------------------------- queue */}
        {activeTab === "processes" ? (
          <section
            id="processing-panel-processes"
            role="tabpanel"
            aria-labelledby="processing-tab-processes"
            className="flex flex-col gap-3"
          >
            {/*
             * What is happening, and what happened. One list held both, so a
             * page of yesterday's completed encodes sat between the operator
             * and the job that is running right now — and only the first of
             * these two can be reordered at all.
             */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div
                role="tablist"
                aria-label={t("processing.outcome.chooseOutcome")}
                className="grid grid-cols-2 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit sm:min-w-64"
              >
                {PROCESSING_OUTCOME_TABS.map((outcome) => {
                  const selected = outcomeTab === outcome;
                  const count =
                    outcome === "active"
                      ? activeJobs.length
                      : finishedJobs.length;
                  return (
                    <button
                      key={outcome}
                      type="button"
                      role="tab"
                      id={`processing-outcome-${outcome}`}
                      aria-selected={selected}
                      aria-controls={`processing-outcome-panel-${outcome}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setOutcomeTab(outcome)}
                      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                        selected
                          ? "bg-white/[0.1] text-white shadow-sm"
                          : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"
                      }`}
                    >
                      {t(`processing.outcome.${outcome}`)}
                      {count > 0 ? (
                        <span
                          className={`rounded-full px-1.5 py-auto text-[0.6875rem] tabular-nums ${
                            selected
                              ? "bg-[var(--accent)] text-black"
                              : "bg-white/[0.08] text-white/60"
                          }`}
                        >
                          {count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {/*
               * Said once, above the list, rather than repeated on every
               * handle. Only worth saying when there is more than one waiting
               * job: with a single one there is no order to arrange.
               */}
              {outcomeTab === "active" && movableQueue.length > 1 ? (
                <p className="text-xs text-white/40">
                  {t("processing.queueOrder.hint")}
                </p>
              ) : null}
            </div>
            {/*
             * The presses that act on the whole queue rather than on one job.
             *
             * Each of them appears only when it would do something: a bar of
             * buttons that are all refusals is a bar an operator learns to
             * ignore, and the count on the face of each one is the answer to
             * "how many" before it is pressed rather than after.
             */}
            {outcomeTab === "active" &&
            (resumableJobs.length > 0 ||
              holdableJobs.length > 0 ||
              movableQueue.length > 1) ? (
              <div className="flex min-h-9 flex-wrap items-center gap-2">
                {resumableJobs.length > 0 ? (
                  <button
                    type="button"
                    disabled={bulkBusy !== null}
                    title={t("processing.bulk.resumeAllHint")}
                    onClick={() =>
                      void sweepQueue(
                        "resume",
                        resumableJobs,
                        resumeProcessingJob,
                      )
                    }
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-xs font-bold text-white/75 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {bulkBusy === "resume" ? (
                      <Loader2
                        size={13}
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Play size={13} aria-hidden="true" />
                    )}
                    {t("processing.bulk.resumeAll")}
                    <span className="rounded-full bg-white/[0.08] px-1.5 text-[0.6875rem] tabular-nums text-white/60">
                      {resumableJobs.length}
                    </span>
                  </button>
                ) : null}
                {holdableJobs.length > 0 ? (
                  <button
                    type="button"
                    disabled={bulkBusy !== null}
                    title={t("processing.bulk.pauseAllHint")}
                    onClick={() =>
                      void sweepQueue("pause", holdableJobs, pauseProcessingJob)
                    }
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-xs font-bold text-white/75 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {bulkBusy === "pause" ? (
                      <Loader2
                        size={13}
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Pause size={13} aria-hidden="true" />
                    )}
                    {t("processing.bulk.pauseAll")}
                    <span className="rounded-full bg-white/[0.08] px-1.5 text-[0.6875rem] tabular-nums text-white/60">
                      {holdableJobs.length}
                    </span>
                  </button>
                ) : null}
                {movableQueue.length > 1 ? (
                  <button
                    type="button"
                    disabled={reorderBusy}
                    title={t("processing.queueOrder.groupHint")}
                    onClick={groupQueueByShow}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-xs font-bold text-white/75 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    <ListOrdered size={13} aria-hidden="true" />
                    {t("processing.queueOrder.groupTitle")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {/*
             * The selection's controls, on a line of their own and always
             * present.
             *
             * They used to sit at the end of the button row, and ticking a box
             * moved the whole queue: the controls are taller than the button
             * they replace and wider than the space left on the line, so the
             * row grew and sometimes wrapped, and every card below shifted
             * down. A row that is always there, and always one line high,
             * cannot do that — whichever of the two states it is showing.
             */}
            {outcomeTab === "active" && movableQueue.length > 1 ? (
              <div className="flex h-9 items-center justify-end gap-2 overflow-x-auto">
                {selectedInOrder.length > 0 ? (
                  <div className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] px-2">
                    <span className="px-1 text-xs font-bold tabular-nums text-white/80">
                      {formatTemplate(
                        t("processing.queueOrder.selectedCount"),
                        { count: String(selectedInOrder.length) },
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={reorderBusy}
                      onClick={() => sendQueueToFront(selectedInOrder)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <ChevronsUp size={12} aria-hidden="true" />
                      {t("processing.queueOrder.groupToTop")}
                    </button>
                    <button
                      type="button"
                      disabled={reorderBusy}
                      onClick={() => sendQueueToBack(selectedInOrder)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <ChevronsDown size={12} aria-hidden="true" />
                      {t("processing.queueOrder.groupToBottom")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedQueueIds(new Set())}
                      className="h-7 rounded-lg px-2 text-xs font-semibold text-white/55 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      {t("processing.queueOrder.clearSelection")}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSelectedQueueIds(new Set(movableIds))}
                    className="h-9 shrink-0 rounded-xl px-2 text-xs font-semibold text-white/40 transition hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {t("processing.queueOrder.selectAll")}
                  </button>
                )}
              </div>
            ) : null}
            {loading ? (
              <div className={`${CARD} flex flex-col gap-3`}>
                {[0, 1].map((row) => (
                  <div
                    key={row}
                    className="h-14 animate-pulse rounded-xl bg-white/[0.06]"
                  />
                ))}
              </div>
            ) : visibleJobs.length === 0 ? (
              <div
                id={`processing-outcome-panel-${outcomeTab}`}
                role="tabpanel"
                aria-labelledby={`processing-outcome-${outcomeTab}`}
                className={`${CARD} text-center`}
              >
                <p className="text-sm font-semibold text-white/70">
                  {t(
                    jobs.length === 0
                      ? "processing.empty"
                      : outcomeTab === "active"
                        ? "processing.outcome.emptyActive"
                        : "processing.outcome.emptyFinished",
                  )}
                </p>
                <p className="mt-1 text-xs text-white/40">
                  {t(
                    jobs.length === 0
                      ? "processing.emptyHint"
                      : outcomeTab === "active"
                        ? "processing.outcome.emptyActiveHint"
                        : "processing.outcome.emptyFinishedHint",
                  )}
                </p>
              </div>
            ) : (
              /*
               * The panel is the wrapper rather than the list itself: a `ul`
               * carrying `role="tabpanel"` stops being a list, and every row
               * inside it stops being a list item.
               */
              <div
                id={`processing-outcome-panel-${outcomeTab}`}
                role="tabpanel"
                aria-labelledby={`processing-outcome-${outcomeTab}`}
              >
                <ul className="flex flex-col gap-2">
                  {visibleJobs.map((job) => {
                    const percent = progressPercent(job);
                    const jobLive =
                      live?.jobId === job.id ? live.snapshot : null;
                    const globalPercent = globalProgressPercent(job, jobLive);
                    const encoded = encodedPercent(job, jobLive);
                    const waitingForStorage = isWaitingForStorage(job);
                    const isFinished = [
                      "succeeded",
                      "failed",
                      "cancelled",
                    ].includes(job.state);
                    /*
                     * Who this job belongs to.
                     *
                     * A film is its own name. An episode is a show and a code: a
                     * queue listing three rows called "Pilot" is a queue nobody
                     * can act on, and the operator has to be able to tell which
                     * show they would be pausing.
                     */
                    const label = jobLabel(
                      jobTitlesById.get(job.id),
                      itemTitleFor(job.itemId),
                    );
                    const movable = outcomeTab === "active" && canReorder(job);
                    /*
                     * The number on the card is the number the drop would
                     * give it. Reading it from the drag's own preview rather
                     * than from the saved queue is what stops the badges
                     * disagreeing with the order under the cursor.
                     */
                    const orderDuringDrag = sortable.previewOrder;
                    const queuePosition = movable
                      ? (orderDuringDrag ?? movableIds).indexOf(job.id) + 1
                      : 0;
                    const held = movable && sortable.isActive(job.id);
                    const selected = movable && selectedQueueIds.has(job.id);
                    /*
                     * The lift stays on for the moment the card is landing.
                     * The handle's own grabbing state does not: the button has
                     * been released, and saying otherwise under the cursor is
                     * how a drag appears to still be going after it has ended.
                     */
                    const lifted =
                      held || (movable && sortable.isSettling(job.id));
                    return (
                      <li
                        key={job.id}
                        ref={movable ? sortable.registerRow(job.id) : undefined}
                        style={movable ? sortable.rowStyle(job.id) : undefined}
                        /*
                         * The slot this row is in while the list is being
                         * rearranged. Written out so the behaviour can be
                         * asserted as an order rather than as pixels.
                         */
                        data-queue-slot={movable ? queuePosition : undefined}
                        className={`${CARD} flex flex-col gap-3 ${
                          lifted
                            ? "border-white/25 shadow-[0_20px_45px_-18px_rgba(0,0,0,0.9)]"
                            : selected
                              ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.04]"
                              : ""
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {movable ? (
                            /*
                             * The tick that makes a group. A checkbox rather
                             * than a modifier-click on the row: the rows carry
                             * buttons of their own, and a queue where clicking
                             * a card might mean "select" and might mean
                             * "inspect" is a queue nobody trusts.
                             */
                            <label className="-m-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]">
                              {/*
                               * A dot rather than a tick. Still a checkbox —
                               * it is one thing being turned on and off, and
                               * several of them can be on at once — but drawn
                               * as the queue's own selection mark instead of
                               * the platform's form control, which is the one
                               * square corner on a page of round ones.
                               */}
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleQueueSelection(job.id)}
                                aria-label={formatTemplate(
                                  t("processing.queueOrder.select"),
                                  { title: label.primary },
                                )}
                                className={`h-5 w-5 cursor-pointer appearance-none rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                                  selected
                                    ? "border-[var(--accent)] bg-[var(--accent)] shadow-[inset_0_0_0_3px_rgba(0,0,0,0.6)]"
                                    : "border-white/25 bg-transparent hover:border-white/50"
                                }`}
                              />
                            </label>
                          ) : null}
                          {/*
                           * Only a row that can actually be moved carries a
                           * handle, and nothing stands in for one that cannot.
                           * The encode underway is not selectable and not
                           * draggable, so a slot held open for controls it will
                           * never have is just an indent on the one row that
                           * matters most.
                           */}
                          {movable ? (
                            <button
                              type="button"
                              aria-label={
                                selected && selectedInOrder.length > 1
                                  ? formatTemplate(
                                      t("processing.queueOrder.groupHandle"),
                                      {
                                        count: String(selectedInOrder.length),
                                        title: label.primary,
                                      },
                                    )
                                  : formatTemplate(
                                      t("processing.queueOrder.handle"),
                                      {
                                        title: label.primary,
                                        position: String(queuePosition),
                                        total: String(movableQueue.length),
                                      },
                                    )
                              }
                              title={t("processing.queueOrder.hint")}
                              /*
                               * Not disabled while the reorder is in flight.
                               * The gesture is already refused for that
                               * moment by the sortable itself, and a
                               * `disabled` handle dims every card in the
                               * queue for the length of a request — a flash
                               * across the whole list every time one is
                               * dropped.
                               */
                              onPointerDown={(event) =>
                                sortable.startDrag(
                                  event,
                                  job.id,
                                  blockFor(job.id),
                                )
                              }
                              onKeyDown={(event) => {
                                if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  nudgeQueueJob(job.id, -1);
                                } else if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  nudgeQueueJob(job.id, 1);
                                }
                              }}
                              className={`inline-flex h-9 w-9 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg border text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white/70 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                                held
                                  ? "cursor-grabbing border-white/25 bg-white/[0.1] text-white/80"
                                  : "border-white/10"
                              }`}
                            >
                              <GripVertical size={20} aria-hidden="true" />
                            </button>
                          ) : null}
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-bold">
                              {label.primary}
                            </span>
                            {label.secondary ? (
                              <span className="truncate text-[11px] font-semibold text-white/45">
                                {label.secondary}
                              </span>
                            ) : null}
                          </span>
                          {movable ? (
                            <span className="shrink-0 rounded-md border border-white/10 px-1.5 py-0.5 text-[0.6875rem] font-bold tabular-nums text-white/45">
                              {formatTemplate(
                                t("processing.queueOrder.position"),
                                { position: String(queuePosition) },
                              )}
                            </span>
                          ) : null}
                          {/*
                           * The two ends of the queue, which is where a row
                           * nearly always wants to go. Dragging is for the
                           * places in between; asking somebody to drag a job
                           * past thirty others to reach the front is asking
                           * them to hold a button down for a page and a half.
                           *
                           * Hidden on the row that is already at that end,
                           * rather than shown and refused.
                           */}
                          {movable && movableQueue.length > 1 ? (
                            <span className="flex shrink-0 items-center gap-1">
                              {queuePosition > 1 ? (
                                <button
                                  type="button"
                                  disabled={reorderBusy}
                                  aria-label={formatTemplate(
                                    t("processing.queueOrder.sendNextLabel"),
                                    { title: label.primary },
                                  )}
                                  onClick={() => sendQueueToFront([job.id])}
                                  className="inline-flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[0.6875rem] font-bold text-white/45 transition hover:bg-white/[0.08] hover:text-white/80 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                                >
                                  <ChevronsUp size={11} aria-hidden="true" />
                                  {t("processing.queueOrder.sendNext")}
                                </button>
                              ) : null}
                              {queuePosition < movableQueue.length ? (
                                <button
                                  type="button"
                                  disabled={reorderBusy}
                                  aria-label={formatTemplate(
                                    t("processing.queueOrder.sendLastLabel"),
                                    { title: label.primary },
                                  )}
                                  onClick={() => sendQueueToBack([job.id])}
                                  className="inline-flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[0.6875rem] font-bold text-white/45 transition hover:bg-white/[0.08] hover:text-white/80 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                                >
                                  <ChevronsDown size={11} aria-hidden="true" />
                                  {t("processing.queueOrder.sendLast")}
                                </button>
                              ) : null}
                            </span>
                          ) : null}
                          <Chip
                            tone={
                              job.state === "succeeded"
                                ? "ok"
                                : job.state === "failed"
                                  ? "bad"
                                  : job.state === "cancelled"
                                    ? "muted"
                                    : "warn"
                            }
                          >
                            {/*
                             * The journey, where there is one. Suspending a live
                             * encoder is a round trip through the operating
                             * system and it can fail; showing Paused before it
                             * has come back is precisely the claim that let an
                             * operator unplug a drive under a running FFmpeg.
                             */}
                            {t(
                              `processing.state.${
                                pauseTransition(job) ?? job.state
                              }` as never,
                            )}
                          </Chip>
                          {job.pausedReason
                            ? (() => {
                                const chip = pausedReasonChip(job.pausedReason);
                                return (
                                  <Chip tone={chip.tone}>
                                    {chip.tone === "bad" ? (
                                      <ShieldAlert
                                        size={11}
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                    {t(chip.labelKey as never)}
                                  </Chip>
                                );
                              })()
                            : null}
                          {job.warnings.length > 0 ? (
                            <Chip tone="warn">
                              <AlertTriangle size={11} aria-hidden="true" />
                              {job.warnings.length}
                            </Chip>
                          ) : null}
                          <span className="text-xs text-white/40">
                            {t(`processing.stage.${job.stage}` as never)}
                          </span>
                          {(() => {
                            const device = processingDeviceLabel(job);
                            return device ? (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-white/50"
                                title={t("processing.device")}
                              >
                                <Cpu size={11} aria-hidden="true" />
                                {device}
                              </span>
                            ) : null;
                          })()}
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setOpenJobId(job.id)}
                              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              {t("processing.inspect")}
                            </button>
                            {canPause(job) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void runJobAction(() =>
                                    pauseProcessingJob(job.id),
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                              >
                                <Pause size={12} aria-hidden="true" />
                                {t("processing.pause")}
                              </button>
                            ) : null}
                            {canResume(job) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void runJobAction(() =>
                                    resumeProcessingJob(job.id),
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                              >
                                <Play size={12} aria-hidden="true" />
                                {t("processing.resume")}
                              </button>
                            ) : null}
                            {canCancel(job) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void runJobAction(() =>
                                    cancelProcessingJob(job.id),
                                  )
                                }
                                className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                              >
                                {t("processing.cancel")}
                              </button>
                            ) : null}
                            {canRetry(job) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void runJobAction(() =>
                                    retryProcessingJob(job.id),
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                              >
                                <RefreshCcw size={12} aria-hidden="true" />
                                {t("processing.retry")}
                              </button>
                            ) : null}
                            {isFinished ? (
                              <button
                                type="button"
                                onClick={() => void removeJob(job.id)}
                                disabled={removingJobIds.has(job.id)}
                                aria-label={
                                  removingJobIds.has(job.id)
                                    ? t("processing.removing")
                                    : `${t("processing.remove")}: ${itemTitleFor(job.itemId)}`
                                }
                                title={t("processing.remove")}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 text-white/40 transition hover:border-rose-300/30 hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-35 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                              >
                                {removingJobIds.has(job.id) ? (
                                  <Loader2
                                    size={13}
                                    className="animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <X size={14} aria-hidden="true" />
                                )}
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {/*
                         * The whole-job bar, and the only one that spans every
                         * phase. It carries no number on purpose: inside each
                         * phase the figures below are exact, but the boundaries
                         * between phases rest on an estimate of their relative
                         * cost, and printing a percentage would claim a precision
                         * the second half of that does not have. It is monotonic,
                         * it moves only when real work is measured, and it fills
                         * only when the job row says the package is published.
                         */}
                        <div
                          className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]"
                          role="progressbar"
                          aria-valuenow={Math.round(globalPercent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={itemTitleFor(job.itemId)}
                        >
                          <div
                            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-linear motion-reduce:transition-none"
                            style={{ width: `${globalPercent}%` }}
                          />
                        </div>

                        {waitingForStorage ? (
                          /*
                           * Not an error. Nothing is wrong with the source, the
                           * plan or the package; a volume went away and the job
                           * is waiting for it. Saying so, and saying that no
                           * action is needed, is what stops an operator pressing
                           * Retry on something that will continue by itself.
                           */
                          <div className="flex flex-col gap-1 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs text-amber-100">
                            <span className="font-bold">
                              {t("processing.storage.interrupted")}
                            </span>
                            <span className="text-amber-100/75">
                              {t("processing.storage.waiting")}
                            </span>
                            {job.protectedSeconds > 0 ? (
                              <span className="tabular-nums text-amber-100/75">
                                {formatTemplate(
                                  t("processing.epoch.protectedThrough"),
                                  {
                                    time: formatMediaClock(
                                      job.protectedSeconds,
                                    ),
                                  },
                                )}
                                {job.epochStartSeconds !== null &&
                                job.epochEndSeconds !== null
                                  ? ` · ${t("processing.storage.willRetry")}: ${formatMediaClock(job.epochStartSeconds)} → ${formatMediaClock(job.epochEndSeconds)}`
                                  : ""}
                              </span>
                            ) : null}
                            <span className="text-amber-100/60">
                              {t("processing.storage.noAction")}
                            </span>
                          </div>
                        ) : null}

                        {isOperatorHeld(job) ? (
                          /*
                           * The opposite of the panel above, and it has to read
                           * that way. Nothing here resumes on its own, the drive
                           * may genuinely be failing, and the row's own buttons
                           * cannot release it — so this says which of the two
                           * holds it is, what the guard actually recorded, and
                           * where the way out is.
                           */
                          <div className="flex flex-col gap-1 rounded-xl border border-rose-400/30 bg-rose-400/[0.08] p-3 text-xs text-rose-100">
                            <span className="inline-flex items-center gap-1.5 font-bold">
                              <ShieldAlert size={13} aria-hidden="true" />
                              {t(
                                job.pausedReason === "storage-quarantined"
                                  ? "processing.storage.held.quarantined"
                                  : "processing.storage.held.recoveryPending",
                              )}
                            </span>
                            <span className="text-rose-100/75">
                              {t(
                                job.pausedReason === "storage-quarantined"
                                  ? "processing.storage.summary.quarantined"
                                  : "processing.storage.summary.recovery-pending",
                              )}
                            </span>
                            {/*
                             * The guard's own sentence, printed verbatim. It is
                             * the only place the *cause* appears — which fault,
                             * at which offset — and it is already written for an
                             * operator, so paraphrasing it here would only lose
                             * the detail that makes it worth reading.
                             */}
                            {storage && !storage.mayStartWork ? (
                              <>
                                <span className="text-rose-100/90">
                                  {storage.reason}
                                </span>
                                {storage.faultCount > 0 ? (
                                  <span className="tabular-nums text-rose-100/60">
                                    {t("processing.storage.faults")}:{" "}
                                    {storage.faultCount}
                                    {storage.firstFaultAt
                                      ? ` · ${t("processing.storage.firstFault")} ${formatFinishedAt(storage.firstFaultAt, language)}`
                                      : ""}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              /*
                               * The two can disagree, and silence about it is
                               * what makes the row look stuck for no reason: the
                               * hold lives in the worker while the incident row
                               * the panel reads says healthy, so nothing on this
                               * page can lift it and nothing on this page said so.
                               */
                              <span className="text-rose-100/90">
                                {t("processing.storage.heldButHealthy")}
                              </span>
                            )}
                            {job.protectedSeconds > 0 ? (
                              <span className="tabular-nums text-rose-100/75">
                                {formatTemplate(
                                  t("processing.epoch.protectedThrough"),
                                  {
                                    time: formatMediaClock(
                                      job.protectedSeconds,
                                    ),
                                  },
                                )}
                                {job.epochStartSeconds !== null &&
                                job.epochEndSeconds !== null
                                  ? ` · ${t("processing.storage.willRetry")}: ${formatMediaClock(job.epochStartSeconds)} → ${formatMediaClock(job.epochEndSeconds)}`
                                  : ""}
                              </span>
                            ) : null}
                            <span className="text-rose-100/60">
                              {t("processing.storage.heldAction")}
                            </span>
                          </div>
                        ) : null}

                        {job.pauseRequested &&
                        job.pausedReason === "operator" ? (
                          /*
                           * Pausing suspends the encoder rather than killing it,
                           * so it costs nothing — but only while the process
                           * lives, and saying so is the difference between a
                           * promise the system keeps and one it cannot.
                           */
                          <p className="text-xs text-white/50">
                            {t("processing.pausedLive")}
                          </p>
                        ) : null}

                        <PhaseDetail
                          job={job}
                          live={jobLive}
                          nowMs={nowMs}
                          t={t}
                        />

                        {!isFinished &&
                        (jobLive?.completedPhases ?? job.phaseHistory)
                          ?.length ? (
                          <PhaseHistory
                            phases={
                              jobLive?.completedPhases ?? job.phaseHistory ?? []
                            }
                            t={t}
                          />
                        ) : null}

                        {job.driveUpload ? (
                          <DriveUploadPanel
                            upload={job.driveUpload}
                            nowMs={nowMs}
                            t={t}
                          />
                        ) : null}

                        {canRetry(job) && hasResumableCheckpoints(job) ? (
                          <p className="text-xs text-white/45">
                            {formatTemplate(t(retryScopeKey(job) as never), {
                              time: formatMediaClock(job.protectedSeconds),
                            })}
                          </p>
                        ) : null}

                        {/*
                         * Nine figures now rather than eight, so the row gains a
                         * column at the widest breakpoint instead of squeezing
                         * every value narrower.
                         */}
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
                          <Stat
                            label="%"
                            value={
                              encoded === null ? `${percent}%` : `${encoded}%`
                            }
                          />
                          <Stat
                            label={t("processing.speed")}
                            value={formatSpeed(jobLive?.speed ?? job.speed)}
                          />
                          <Stat
                            label={t("processing.fps")}
                            value={
                              (jobLive?.fps ?? job.fps)
                                ? (jobLive?.fps ?? job.fps)!.toFixed(0)
                                : "—"
                            }
                          />
                          <Stat
                            label={t("processing.eta")}
                            value={formatDuration(
                              jobLive?.etaSeconds ?? job.etaSeconds,
                            )}
                          />
                          <Stat
                            label={t("processing.encoding")}
                            value={
                              job.decision?.renditionsToEncode?.length
                                ? job.decision.renditionsToEncode
                                    .map((height) => `${height}p`)
                                    .join(" · ")
                                : t("processing.fullPackage")
                            }
                          />
                          {/*
                           * Two separate questions: what this job has written,
                           * and how large it will end up. Falling back from the
                           * first to the second is what labelled a planning
                           * estimate as though it were bytes on disk.
                           */}
                          <Stat
                            label={t("processing.actualOutput")}
                            value={formatBytes(job.actualOutputBytes)}
                          />
                          <Stat
                            label={t("processing.estimatedOutput")}
                            value={formatBytes(job.estimatedOutputBytes)}
                          />
                          <Stat
                            label={t("processing.duration")}
                            value={formatDuration(
                              isFinished
                                ? processingDurationSeconds(job)
                                : processingElapsedSeconds(job, refreshedAt),
                            )}
                          />
                          <Stat
                            label={t("processing.finishedAt")}
                            value={formatFinishedAt(job.finishedAt, dateLocale)}
                          />
                        </div>

                        {job.errorMessage ? (
                          <p className="rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">
                            {job.errorMessage}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        ) : null}
      </div>

      {/* ------------------------------------------------- detail drawer */}
      {openJobId && detail ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={itemTitleFor(detail.itemId)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpenJobId(null);
          }}
        >
          <div className="flex h-full w-full max-w-xl flex-col gap-5 overflow-y-auto border-l border-white/10 bg-[#0a0b0e] p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h2 className="text-xl font-black">
                  {itemTitleFor(detail.itemId)}
                </h2>
                <p className="mt-0.5 text-xs text-white/40">
                  {t(
                    `processing.state.${
                      pauseTransition(detail) ?? detail.state
                    }` as never,
                  )}
                  {streamState === "reconnecting"
                    ? ` · ${t("processing.reconnecting")}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpenJobId(null)}
                aria-label={t("processing.close")}
                className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/[0.08] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {/*
             * The same whole-job bar the queue row carries, at the top of the
             * card where the title is. No number beside it, for the same
             * reason: the phase panel underneath prints the figures that are
             * exact, and this one is a position, not a measurement.
             */}
            <div
              className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]"
              role="progressbar"
              aria-valuenow={Math.round(
                globalProgressPercent(
                  detail,
                  live?.jobId === detail.id ? live.snapshot : null,
                ),
              )}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={itemTitleFor(detail.itemId)}
            >
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-linear motion-reduce:transition-none"
                style={{
                  width: `${globalProgressPercent(
                    detail,
                    live?.jobId === detail.id ? live.snapshot : null,
                  )}%`,
                }}
              />
            </div>

            <PhaseDetail
              job={detail}
              live={live?.jobId === detail.id ? live.snapshot : null}
              nowMs={nowMs}
              t={t}
            />

            {detail.state !== "succeeded" &&
            (
              (live?.jobId === detail.id
                ? live.snapshot.completedPhases
                : undefined) ?? detail.phaseHistory
            )?.length ? (
              <PhaseHistory
                phases={
                  (live?.jobId === detail.id
                    ? live.snapshot.completedPhases
                    : undefined) ??
                  detail.phaseHistory ??
                  []
                }
                t={t}
              />
            ) : null}

            {detail.driveUpload ? (
              <DriveUploadPanel
                upload={detail.driveUpload}
                nowMs={nowMs}
                t={t}
              />
            ) : null}

            <ol className="flex flex-col gap-1.5">
              {PROCESSING_STAGE_ORDER.map((stage) => {
                const state = stageStateFor(stage, detail);
                return (
                  <li key={stage} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        state === "done"
                          ? "bg-emerald-400"
                          : state === "active"
                            ? "bg-[var(--accent)]"
                            : "bg-white/15"
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className={
                        state === "pending"
                          ? "text-white/30"
                          : state === "active"
                            ? "font-bold text-white"
                            : "text-white/60"
                      }
                    >
                      {t(`processing.stage.${stage}` as never)}
                    </span>
                    {state === "active" && detail.state === "running" ? (
                      <Loader2
                        size={13}
                        className="animate-spin text-white/40 motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t("processing.encoder")}
                value={detail.videoEncoder ?? "—"}
              />
              <Stat
                label={t("processing.hardware")}
                value={detail.hardwareAdapter ?? "—"}
              />
              <Stat
                label={t("processing.device")}
                value={processingDeviceLabel(detail) ?? "—"}
              />
              <Stat
                label={t("processing.inputSize")}
                value={formatBytes(detail.decision?.source.sizeBytes)}
              />
              <Stat
                label={t("processing.estimate")}
                value={formatBytes(detail.estimatedOutputBytes)}
              />
              <Stat
                label={t("processing.actualOutput")}
                value={formatBytes(detail.actualOutputBytes)}
              />
              <Stat
                label={t("processing.staging")}
                value={formatBytes(detail.estimatedStagingBytes)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Stat
                label={t("processing.audioKept")}
                value={languages.audioKept.join(", ") || "—"}
              />
              <Stat
                label={t("processing.audioDropped")}
                value={languages.audioDropped.join(", ") || "—"}
              />
              <Stat
                label={t("processing.subtitlesKept")}
                value={languages.subtitlesKept.join(", ") || "—"}
              />
            </div>

            {detail.validation ? (
              <div className="flex items-center gap-2">
                <span className={LABEL}>{t("processing.validation")}</span>
                {/*
                 * A salvaged package validates — every structural claim it
                 * makes is true — so the validation chip alone would present it
                 * as a clean result. This sits beside it and says otherwise.
                 */}
                {isSalvaged(detail) ? (
                  <Chip tone="warn">
                    <AlertTriangle size={11} aria-hidden="true" />
                    {t("processing.sourceDamage.badge")}
                  </Chip>
                ) : null}
                {detail.validation.ok ? (
                  <Chip tone="ok">
                    <CheckCircle2 size={11} aria-hidden="true" />
                    {t("processing.validationPassed")}
                  </Chip>
                ) : (
                  <Chip tone="bad">
                    <XCircle size={11} aria-hidden="true" />
                    {t("processing.validationFailed")}
                  </Chip>
                )}
              </div>
            ) : null}

            <SourceDamagePanel
              job={detail}
              live={live?.jobId === detail.id ? live.snapshot : null}
              t={t}
            />

            {detail.warnings.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className={LABEL}>{t("processing.warnings")}</span>
                <ul className="flex flex-col gap-1 text-xs text-amber-200/80">
                  {detail.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="rounded-xl border border-white/10 bg-black/30 p-3">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.14em] text-white/40">
                {t("processing.diagnostics")}
              </summary>
              <ul className="mt-3 flex flex-col gap-1 font-mono text-[11px] leading-relaxed text-white/55">
                {events.map((entry) => (
                  <li
                    key={entry.sequence}
                    className={
                      entry.level === "error"
                        ? "text-rose-300"
                        : entry.level === "warning"
                          ? "text-amber-200"
                          : undefined
                    }
                  >
                    <span className="text-white/25">
                      {String(entry.sequence).padStart(2, "0")}{" "}
                    </span>
                    [{entry.stage}] {entry.message}
                  </li>
                ))}
              </ul>
            </details>

            {detail.publishedVersion ? (
              <p className="text-xs text-white/40">
                {t("processing.published")}:{" "}
                <span className="font-mono">{detail.publishedVersion}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
