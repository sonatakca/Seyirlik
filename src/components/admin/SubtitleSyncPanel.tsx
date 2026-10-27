import { useEffect, useId, useState } from "react";
import { Eye, Timer } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  applyReviewedSubtitleSync,
  getSubtitleSyncTask,
  getSubtitleSyncTracks,
  restoreSubtitleRevision,
  syncTitleSubtitle,
  type SubtitleSyncAudioTrack,
  type SubtitleSyncTask,
  type SubtitleSyncTrack,
  type SubtitleSyncTracks,
} from "../../lib/libraryAdminApi";
import { signalTasksChanged } from "../../lib/tasksChanged";
import { describeErrorDetail } from "../../lib/userFacingError";
import { NoticeLine } from "./libraryPresentation";
import { actionButton } from "./libraryStyle";
import { SubtitleRevisionList } from "./SubtitleRevisionList";
import { SubtitleSyncProposal } from "./SubtitleSyncProposal";
import type { Notice } from "./useTitleActions";

type ReferenceKind = "subtitle" | "audio";

/** How often a running sync is asked what it did. */
const POLL_MS = 2_000;

const selectStyle =
  "min-h-9 w-full rounded-lg border border-white/10 bg-black/40 px-2 text-xs font-bold text-white/80 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40";

function isFinished(status: SubtitleSyncTask["status"]): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

/**
 * What a finished sync did, in one line.
 *
 * A refusal is shown in the server's own words, because it is the only
 * sentence that says what is wrong — "these do not look like the same film" —
 * and flattening it into "failed" would hide that nothing was written.
 */
function describeOutcome(
  finished: SubtitleSyncTask,
  t: (key: TranslationKey) => string,
): Notice {
  const result = finished.result;
  if (finished.status === "cancelled")
    return { tone: "error", text: t("library.syncCancelled") };
  if (finished.status !== "succeeded" || !result)
    return { tone: "error", text: t("library.syncFailed") };
  if (result.outcome === "refused")
    return { tone: "error", text: result.reason };
  if (result.outcome === "unchanged")
    return { tone: "ok", text: t("library.syncUnchanged") };
  if (result.outcome === "restored")
    return {
      tone: "ok",
      text: `${t("library.revisionRestored")}: ${result.fileName}`,
    };
  if (result.outcome === "analysed")
    return {
      tone: result.needsReview ? "error" : "ok",
      text: [
        result.needsReview
          ? t("library.syncNeedsReview")
          : t("library.syncPreviewReady"),
        result.transcriptionTaskId
          ? t("library.syncTranscriptionQueued")
          : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  // Several regions moved by different amounts: one shift would misdescribe it.
  const regions =
    result.alignment?.segments.filter(
      (segment) => segment.status === "corrected",
    ).length ?? 0;
  if (regions > 1)
    return {
      tone: "ok",
      text: `${t("library.syncApplied")}: ${result.fileName} · ${regions} ${t("library.syncRegionsCorrected")}`,
    };
  const direction =
    result.offsetSeconds < 0
      ? t("library.syncEarlier")
      : t("library.syncLater");
  const parts = [
    `${t("library.syncApplied")}: ${result.fileName}`,
    `${direction} ${Math.abs(result.offsetSeconds).toFixed(2)} s`,
    Math.abs(result.rate - 1) > 0.0005
      ? `${t("library.syncSpeed")}${result.rate.toFixed(4)}`
      : null,
  ].filter(Boolean);
  return { tone: "ok", text: parts.join(" · ") };
}

/**
 * The shift typed into the panel, in seconds, or null when the field is empty
 * and the shift is to be worked out instead. A comma is a decimal point, since
 * that is how a Turkish keyboard writes one.
 */
function parseManualShift(text: string): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value !== 0 ? value : "invalid";
}

/**
 * The subtitle a person most likely came here to fix: a Turkish file beside
 * the video, because that is the one this house adds by hand and the one that
 * arrives timed to somebody else's release.
 */
function preferredTarget(tracks: SubtitleSyncTracks): number | null {
  const correctable = tracks.subtitles.filter((track) => track.retimable);
  return (
    (correctable.find((track) => track.language === "tur") ?? correctable[0])
      ?.streamIndex ?? null
  );
}

/** An English subtitle first, since that is the one that came with the release. */
function preferredReference(
  tracks: SubtitleSyncTracks,
  kind: ReferenceKind,
  target: number | null,
): number | null {
  if (kind === "audio")
    return (
      (tracks.audio.find((track) => track.isDefault) ?? tracks.audio[0])
        ?.streamIndex ?? null
    );
  const others = tracks.subtitles.filter(
    (track) => track.streamIndex !== target,
  );
  return (
    (
      others.find((track) => track.language === "eng" && !track.forced) ??
      others[0]
    )?.streamIndex ?? null
  );
}

/**
 * Re-timing one subtitle file against something that is already right.
 *
 * Every choice is made from the tracks the server says this video has, so a
 * track that cannot be corrected is never offered as the target, and the
 * target is never offered as its own reference. The work runs as a task; this
 * follows that one task to its end and says what it did, because the task list
 * can only say that it finished.
 */
export function SubtitleSyncPanel({
  itemId,
  onSynced,
  initiallyOpen = false,
}: {
  itemId: string;
  /** Called after a file was actually rewritten. */
  onSynced: () => void | Promise<void>;
  /** For a caller that already has its own button, such as a library row. */
  initiallyOpen?: boolean;
}) {
  const { t } = useLanguage();
  const ids = { target: useId(), reference: useId(), shift: useId() };
  const [open, setOpen] = useState(initiallyOpen);
  const [tracks, setTracks] = useState<SubtitleSyncTracks | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [kind, setKind] = useState<ReferenceKind>("subtitle");
  const [reference, setReference] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [task, setTask] = useState<SubtitleSyncTask | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  /*
   * The escape hatch for a film the aligner cannot hear — a score so dense
   * that speech never stands out of it — where the operator has watched it
   * and can say how far off it is.
   */
  const [shiftText, setShiftText] = useState("");
  /** The finished preview on show, kept while its apply runs. */
  const [proposal, setProposal] = useState<SubtitleSyncTask | null>(null);
  /** Bumped whenever the file may have changed, so the versions list again. */
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    if (!open || tracks) return;
    let cancelled = false;
    getSubtitleSyncTracks(itemId)
      .then((value) => {
        if (cancelled) return;
        const chosen = preferredTarget(value);
        const againstSubtitle = value.subtitles.some(
          (track) => track.streamIndex !== chosen,
        );
        const initialKind: ReferenceKind = againstSubtitle
          ? "subtitle"
          : "audio";
        setTracks(value);
        setTarget(chosen);
        setKind(initialKind);
        setReference(preferredReference(value, initialKind, chosen));
      })
      .catch(
        (error: unknown) =>
          !cancelled &&
          setNotice({
            tone: "error",
            text:
              describeErrorDetail(error, t) || t("library.syncTracksFailed"),
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [open, tracks, itemId, t]);

  const taskId = task?.taskId;
  const running = task !== null && !isFinished(task.status);

  useEffect(() => {
    if (!taskId || !running) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getSubtitleSyncTask(itemId, taskId)
        .then((next) => {
          if (cancelled) return;
          setTask(next);
          if (!isFinished(next.status)) return;
          setNotice(describeOutcome(next, t));
          const outcome = next.result?.outcome;
          if (
            next.result &&
            "alignment" in next.result &&
            next.result.alignment
          )
            setProposal(next);
          if (outcome === "applied" || outcome === "restored") {
            setChanges((count) => count + 1);
            void onSynced();
          }
        })
        // A missed poll is not a failed sync; the next one asks again.
        .catch(
          () => !cancelled && setTask((current) => current && { ...current }),
        );
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `task` is re-set on every poll, which is what schedules the next one.
  }, [task, taskId, running, itemId, onSynced, t]);

  const subtitleLabel = (track: SubtitleSyncTrack) =>
    [
      (track.language ?? "und").toUpperCase(),
      track.forced ? t("library.subtitleForced") : null,
      track.title?.trim() || null,
      track.fileName ?? t("library.syncInVideo"),
    ]
      .filter(Boolean)
      .join(" · ");
  const audioLabel = (track: SubtitleSyncAudioTrack) =>
    [
      (track.language ?? "und").toUpperCase(),
      track.title?.trim() || track.codec?.toUpperCase() || null,
      track.channels ? `${track.channels}ch` : null,
      track.isDefault ? t("library.syncDefault") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  const targets = tracks?.subtitles.filter((track) => track.retimable) ?? [];
  const subtitleReferences =
    tracks?.subtitles.filter((track) => track.streamIndex !== target) ?? [];
  const references =
    kind === "subtitle" ? subtitleReferences : (tracks?.audio ?? []);
  const locked = submitting || running;
  const shift = parseManualShift(shiftText);

  /** Queues one task and follows it, whatever it is. */
  const follow = async (queue: () => Promise<{ taskId: string }>) => {
    setSubmitting(true);
    setNotice(null);
    try {
      const { taskId: queued } = await queue();
      signalTasksChanged();
      setTask({
        taskId: queued,
        status: "queued",
        message: null,
        result: null,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: describeErrorDetail(error, t) || t("library.actionFailed"),
      });
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Sync applies a correction straight away only when the server finds every
   * line placed on strong evidence; anything less comes back as a proposal.
   * Preview never writes.
   */
  const start = (dryRun: boolean) => {
    if (target === null || reference === null || shift === "invalid") return;
    setProposal(null);
    return follow(() =>
      syncTitleSubtitle(itemId, {
        targetStreamIndex: target,
        reference: { kind, streamIndex: reference },
        ...(shift === null ? {} : { offsetSeconds: shift }),
        ...(dryRun ? { dryRun: true } : {}),
      }),
    );
  };

  const applyProposal = (unmatched: "keep" | "exclude") => {
    if (!proposal) return;
    return follow(() =>
      applyReviewedSubtitleSync(itemId, {
        previewTaskId: proposal.taskId,
        unmatched,
      }),
    );
  };

  const restore = (revisionId: string) => {
    if (target === null) return;
    setProposal(null);
    return follow(() => restoreSubtitleRevision(itemId, revisionId, target));
  };

  const proposed =
    proposal?.result && "alignment" in proposal.result ? proposal.result : null;
  const proposalApplied =
    task !== null &&
    task.taskId !== proposal?.taskId &&
    task.result?.outcome === "applied";

  if (!open)
    return (
      <button
        type="button"
        className={actionButton}
        onClick={() => setOpen(true)}
      >
        <Timer size={13} aria-hidden="true" />
        {t("library.syncSubtitle")}
      </button>
    );

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-center gap-2">
        <Timer size={14} aria-hidden="true" className="text-white/45" />
        <span className="text-xs font-black uppercase tracking-[0.12em] text-white/45">
          {t("library.syncSubtitle")}
        </span>
      </div>
      <p className="text-xs font-semibold text-white/35">
        {t("library.syncHint")}
      </p>

      {tracks === null ? (
        notice ? null : (
          <p role="status" className="text-xs text-white/50">
            {t("library.loading")}
          </p>
        )
      ) : targets.length === 0 ? (
        <p className="text-xs font-semibold text-white/60">
          {t("library.syncNoTarget")}
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <label
              htmlFor={ids.target}
              className="text-[11px] font-black uppercase tracking-wide text-white/45"
            >
              {t("library.syncTarget")}
            </label>
            <select
              id={ids.target}
              className={selectStyle}
              value={target ?? ""}
              disabled={locked}
              onChange={(event) => {
                const next = Number(event.target.value);
                setTarget(next);
                // The new target may have been the reference; never let it be both.
                if (kind === "subtitle" && reference === next)
                  setReference(preferredReference(tracks, kind, next));
              }}
            >
              {targets.map((track) => (
                <option key={track.streamIndex} value={track.streamIndex}>
                  {subtitleLabel(track)}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="space-y-1" disabled={locked}>
            <legend className="text-[11px] font-black uppercase tracking-wide text-white/45">
              {t("library.syncAgainst")}
            </legend>
            <div className="flex flex-wrap gap-4">
              {(["subtitle", "audio"] as const).map((option) => (
                <label
                  key={option}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-white/70"
                >
                  <input
                    type="radio"
                    name={`${ids.reference}-kind`}
                    value={option}
                    checked={kind === option}
                    disabled={
                      option === "subtitle"
                        ? subtitleReferences.length === 0
                        : tracks.audio.length === 0
                    }
                    onChange={() => {
                      setKind(option);
                      setReference(preferredReference(tracks, option, target));
                    }}
                    className="accent-sky-300"
                  />
                  {t(
                    option === "subtitle"
                      ? "library.syncAgainstSubtitle"
                      : "library.syncAgainstAudio",
                  )}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1">
            <label
              htmlFor={ids.reference}
              className="text-[11px] font-black uppercase tracking-wide text-white/45"
            >
              {t("library.syncReference")}
            </label>
            {references.length === 0 ? (
              <p className="text-xs font-semibold text-white/60">
                {t("library.syncNoReference")}
              </p>
            ) : (
              <select
                id={ids.reference}
                className={selectStyle}
                value={reference ?? ""}
                disabled={locked}
                onChange={(event) => setReference(Number(event.target.value))}
              >
                {kind === "subtitle"
                  ? subtitleReferences.map((track) => (
                      <option key={track.streamIndex} value={track.streamIndex}>
                        {subtitleLabel(track)}
                      </option>
                    ))
                  : tracks.audio.map((track) => (
                      <option key={track.streamIndex} value={track.streamIndex}>
                        {audioLabel(track)}
                      </option>
                    ))}
              </select>
            )}
            {kind === "audio" ? (
              <p className="text-xs font-semibold text-white/35">
                {t("library.syncAudioSlow")}
              </p>
            ) : null}
          </div>

          <div className="space-y-1">
            <label
              htmlFor={ids.shift}
              className="text-[11px] font-black uppercase tracking-wide text-white/45"
            >
              {t("library.syncManual")}
            </label>
            <input
              id={ids.shift}
              type="text"
              inputMode="decimal"
              placeholder="-5"
              className={`${selectStyle} max-w-32 tabular-nums`}
              value={shiftText}
              disabled={locked}
              aria-invalid={shift === "invalid"}
              onChange={(event) => setShiftText(event.target.value)}
            />
            <p className="text-xs font-semibold text-white/35">
              {t("library.syncManualHint")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={actionButton}
              disabled={
                locked ||
                target === null ||
                reference === null ||
                shift === "invalid"
              }
              onClick={() => void start(false)}
            >
              <Timer size={13} aria-hidden="true" />
              {t("library.syncSubtitle")}
            </button>
            <button
              type="button"
              className={actionButton}
              disabled={
                locked ||
                target === null ||
                reference === null ||
                shift === "invalid"
              }
              onClick={() => void start(true)}
            >
              <Eye size={13} aria-hidden="true" />
              {t("library.syncPreview")}
            </button>
            {running ? (
              <span
                role="status"
                className="text-xs font-semibold text-white/60"
              >
                {task?.status === "queued"
                  ? t("library.syncQueued")
                  : task?.message || t("library.syncRunning")}
              </span>
            ) : null}
          </div>
          {proposed?.alignment ? (
            <SubtitleSyncProposal
              alignment={proposed.alignment}
              canApply={
                proposed.outcome === "analysed" &&
                !proposalApplied &&
                proposed.alignment.verdict !== "in-sync" &&
                proposed.alignment.verdict !== "insufficient-evidence" &&
                proposed.alignment.cues.some(
                  (cue) =>
                    (cue.disposition === "corrected" ||
                      cue.disposition === "inferred") &&
                    Math.abs(cue.startSeconds - cue.sourceStartSeconds) >= 0.05,
                )
              }
              applying={locked}
              onApply={(unmatched) => void applyProposal(unmatched)}
            />
          ) : null}

          {target !== null ? (
            <SubtitleRevisionList
              itemId={itemId}
              streamIndex={target}
              refreshKey={changes}
              disabled={locked}
              onRestore={(revisionId) => void restore(revisionId)}
            />
          ) : null}
        </>
      )}

      <NoticeLine notice={notice} />
    </div>
  );
}
