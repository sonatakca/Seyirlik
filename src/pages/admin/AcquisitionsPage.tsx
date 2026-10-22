import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpToLine,
  Ban,
  ChevronDown,
  Clapperboard,
  GripVertical,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  X,
} from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import { WorkflowSteps } from "../../components/admin/WorkflowSteps";
import { formatTemplate } from "../../lib/format";
import { getBackdropImageUrl, getThumbImageUrl } from "../../lib/mediaApi";
import {
  actionsFor,
  bucketOf,
  etaParts,
  formatBytes,
  formatSpeed,
  queueMoveFor,
  remedyFor,
  targetLabel,
} from "../../lib/acquisitionPresentation";
import {
  blocklistAcquisition,
  cancelAcquisition,
  getAcquisition,
  getDownloadProgress,
  listAcquisitions,
  listBlocklist,
  moveAcquisition,
  pauseAcquisition,
  removeBlocklistEntry,
  resumeAcquisition,
  retryAcquisition,
  setDownloadClientPaused,
  type Acquisition,
  type AcquisitionDetail,
  type AcquisitionProgress,
  type BlocklistEntry,
  type DownloadProgress,
} from "../../lib/acquisitionsApi";
import type { TranslationKey } from "../../i18n/translations";
import { useQueueSortable } from "./useQueueSortable";

/**
 * Every download Seyirlik has asked for, as a queue a person can steer.
 *
 * The download client knows these jobs only by an idempotency key, which is
 * how a lost submission is recovered and means nothing to a reader. So this
 * page is the one that names them: each row leads with the title and the
 * episode or year it is for, with the release underneath, and the queue can
 * be reordered, held and released here without opening the download client.
 *
 * Order is the download client's own. The page reads it every few seconds,
 * and a move is sent as a place in that queue, so what is shown is always
 * what the client will do next.
 */

/** How often a running download is re-read from the download client. */
const PROGRESS_POLL_MS = 3_000;
/** Every this many progress reads, the list itself is re-read too. */
const LIST_EVERY_POLLS = 5;

const ICON_BUTTON =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.06] text-white/65 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const TEXT_BUTTON =
  "inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] px-3 py-1.5 text-xs font-black text-white/80 transition hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const ROW =
  "rounded-2xl border border-white/10 bg-black/25 p-3 sm:p-4 transition-[border-color,background-color,box-shadow]";

/** What the last blocklisting did, said once, above the list. */
type Notice =
  | { kind: "blocklisted" }
  | { kind: "replaced"; releaseTitle: string }
  | { kind: "nothingElse" }
  | { kind: "noProfile" }
  | { kind: "failed" }
  | { kind: "controlFailed" };

type Translate = (key: TranslationKey) => string;

function durationText(seconds: number, t: Translate): string {
  const parts = etaParts(seconds);
  if (parts === "underAMinute")
    return t("admin.acquisitions.progress.underAMinute");
  const hours = parts.hours
    ? `${parts.hours} ${t("admin.acquisitions.progress.hours")} `
    : "";
  return `${hours}${parts.minutes} ${t("admin.acquisitions.progress.minutes")}`;
}

/** The name a person would use: title first, then the episode or year. */
function TargetName({
  row,
  t,
  className = "",
}: {
  row: Acquisition;
  t: Translate;
  className?: string;
}) {
  const label = targetLabel(row.target);
  const qualifier =
    label.episodeCode ??
    (label.season !== undefined
      ? formatTemplate(t("admin.acquisitions.target.season"), {
          season: label.season,
        })
      : label.year !== undefined
        ? String(label.year)
        : null);
  return (
    <span className={`flex min-w-0 items-baseline gap-2 ${className}`}>
      <span className="truncate text-base font-black text-white">
        {label.title}
      </span>
      {qualifier ? (
        <span className="shrink-0 rounded-md border border-white/15 bg-white/[0.06] px-1.5 py-0.5 text-[0.6875rem] font-black tabular-nums tracking-wide text-white/75">
          {qualifier}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A still for the row, when the catalogue has one.
 *
 * An episode's own frame for an episode, the title's backdrop otherwise. A
 * download for something not yet in the catalogue has no artwork, and the
 * tile says "film" rather than leaving a hole.
 */
function DownloadArt({ row }: { row: Acquisition }) {
  const [failed, setFailed] = useState(false);
  const itemId = row.target.itemId;
  const src = itemId
    ? row.target.kind === "episode"
      ? getThumbImageUrl(itemId, undefined, 240)
      : getBackdropImageUrl(itemId, undefined, 240)
    : null;
  return (
    <span className="relative hidden h-[54px] w-24 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.05] sm:block">
      <Clapperboard
        size={18}
        aria-hidden="true"
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/20"
      />
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}

/**
 * Where a download is, in the download client's own numbers.
 *
 * Says only what was measured: a size it was not told is left out rather
 * than shown as zero, and a speed is shown only on the job actually moving.
 */
function ProgressLine({
  entry,
  live,
  t,
}: {
  entry: AcquisitionProgress;
  live: DownloadProgress;
  t: Translate;
}) {
  // History can report failure before the acquisition worker reconciles it.
  // A terminal job is not necessarily a successful download.
  if (entry.stage === "failed") {
    return (
      <p className="mt-2 text-xs font-semibold text-amber-200/80">
        {t("admin.acquisitions.state.failed")}
      </p>
    );
  }

  const finishedBytes = entry.stage === "processing" || entry.stage === "done";
  const total = entry.totalBytes;
  const downloaded = finishedBytes ? total : entry.downloadedBytes;
  const percent = finishedBytes ? 100 : (entry.percent ?? 0);
  const paused =
    entry.stage === "paused" ||
    (live.paused &&
      (entry.stage === "queued" || entry.stage === "downloading"));

  const status = paused
    ? t("admin.acquisitions.progress.paused")
    : entry.stage === "processing"
      ? [entry.statusText, entry.detail].filter(Boolean).join(" — ")
      : entry.stage === "downloading"
        ? [
            entry.speedBytesPerSecond
              ? formatSpeed(entry.speedBytesPerSecond)
              : null,
            entry.etaSeconds
              ? `${durationText(entry.etaSeconds, t)} ${t("admin.acquisitions.progress.left")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : entry.etaSeconds
          ? formatTemplate(t("admin.acquisitions.row.doneIn"), {
              eta: durationText(entry.etaSeconds, t),
            })
          : t("admin.acquisitions.progress.queued");

  return (
    <div className="mt-2.5">
      <div
        role="progressbar"
        aria-label={t("admin.acquisitions.progress.label")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(percent)}
        className="h-1.5 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${
            paused ? "bg-white/35" : "bg-[var(--accent)]"
          }`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs font-bold tabular-nums">
        <span className="text-white/75">
          {total !== undefined
            ? `${downloaded !== undefined ? formatBytes(downloaded) : "—"} / ${formatBytes(total)}`
            : t("admin.acquisitions.progress.sizeUnknown")}
          {` · ${Math.floor(percent)}%`}
        </span>
        {status ? <span className="text-white/55">{status}</span> : null}
      </div>
    </div>
  );
}

/** Why this release, and what happened to it — opened from a row. */
function RowDetails({
  detail,
  t,
}: {
  detail: AcquisitionDetail | "loading" | "failed";
  t: Translate;
}) {
  if (detail === "loading") {
    return (
      <p className="mt-3 text-xs font-semibold text-white/40">
        {t("admin.acquisitions.loadingDetails")}
      </p>
    );
  }
  if (detail === "failed") {
    return (
      <p className="mt-3 text-xs font-semibold text-amber-200/80">
        {t("admin.acquisitions.detailsFailed")}
      </p>
    );
  }
  return (
    <div className="mt-3 grid gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-3 md:grid-cols-2">
      <div>
        <h4 className="text-xs font-black uppercase tracking-[0.14em] text-white/50">
          {t("admin.acquisitions.why")}
        </h4>
        {detail.decision ? (
          <>
            <p className="mt-1.5 text-sm font-semibold text-white/75">
              {detail.decision.profileName} · {t("admin.acquisitions.score")}{" "}
              {detail.decision.score}
            </p>
            {detail.decision.reasons.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {detail.decision.reasons.map((reason, index) => (
                  <li
                    key={`${reason.code ?? "reason"}-${index}`}
                    className="text-xs font-medium text-white/55"
                  >
                    {reason.detail ?? reason.code}
                  </li>
                ))}
              </ul>
            ) : null}
            {detail.decision.rejected.length > 0 ? (
              <>
                <h5 className="mt-3 text-xs font-black text-white/60">
                  {t("admin.acquisitions.rejected")}
                </h5>
                <ul className="mt-1 space-y-0.5">
                  {detail.decision.rejected.map((entry, index) => (
                    <li
                      key={`${entry.title ?? "release"}-${index}`}
                      className="break-all text-xs font-medium text-white/45"
                    >
                      {entry.title} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : (
          <p className="mt-1.5 text-sm font-medium text-white/45">
            {t("admin.acquisitions.noDecision")}
          </p>
        )}
      </div>

      <div>
        <h4 className="text-xs font-black uppercase tracking-[0.14em] text-white/50">
          {t("admin.acquisitions.history")}
        </h4>
        <ol className="mt-1.5 space-y-1 border-l border-white/10 pl-3">
          {detail.events.map((event, index) => (
            <li key={`${event.toState}-${index}`} className="text-xs">
              <span className="font-bold text-white/70">
                {t(
                  `admin.acquisitions.state.${event.toState}` as "admin.acquisitions.state.queued",
                )}
              </span>
              <span className="font-medium tabular-nums text-white/35">
                {" · "}
                {new Date(event.at).toLocaleString()}
              </span>
              {event.detail ? (
                <span className="block font-medium text-white/45">
                  {event.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** The download client as a whole: is it moving, and the switch for it. */
function DownloaderBar({
  live,
  queued,
  busy,
  onToggle,
  t,
}: {
  live: DownloadProgress | null;
  queued: number;
  busy: boolean;
  onToggle: (paused: boolean) => void;
  t: Translate;
}) {
  if (!live) return null;
  const tone = !live.reachable
    ? "unreachable"
    : live.paused
      ? "paused"
      : live.speedBytesPerSecond
        ? "downloading"
        : "idle";
  const facts = live.reachable
    ? [
        live.remainingBytes !== undefined && live.remainingBytes > 0
          ? formatTemplate(t("admin.acquisitions.client.left"), {
              size: formatBytes(live.remainingBytes),
            })
          : null,
        live.freeBytes !== undefined
          ? formatTemplate(t("admin.acquisitions.client.free"), {
              size: formatBytes(live.freeBytes),
            })
          : null,
        queued > 0
          ? formatTemplate(t("admin.acquisitions.client.inQueue"), {
              count: queued,
            })
          : null,
      ].filter(Boolean)
    : [];

  return (
    <section
      aria-label={t("admin.acquisitions.client.label")}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-3xl border border-white/10 bg-black/30 px-4 py-3.5 backdrop-blur-xl sm:px-5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            tone === "downloading"
              ? "bg-[var(--accent)]"
              : tone === "paused"
                ? "bg-amber-300"
                : tone === "unreachable"
                  ? "bg-red-400"
                  : "bg-white/30"
          }`}
        />
        <div className="min-w-0">
          <p className="text-sm font-black text-white">
            {t(
              `admin.acquisitions.client.${tone}` as "admin.acquisitions.client.idle",
            )}
            {tone === "downloading" && live.speedBytesPerSecond ? (
              <span className="ml-2 tabular-nums text-[var(--accent)]">
                {formatSpeed(live.speedBytesPerSecond)}
              </span>
            ) : null}
          </p>
          {facts.length > 0 ? (
            <p className="mt-0.5 text-xs font-bold tabular-nums text-white/45">
              {facts.join(" · ")}
            </p>
          ) : null}
        </div>
      </div>

      {live.reachable ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(!live.paused)}
          className={
            live.paused
              ? "inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-black text-black transition hover:brightness-110 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              : "inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.08] px-4 py-2 text-sm font-black text-white/80 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          }
        >
          {live.paused ? (
            <Play size={15} aria-hidden="true" />
          ) : (
            <Pause size={15} aria-hidden="true" />
          )}
          {t(
            live.paused
              ? "admin.acquisitions.client.resumeAll"
              : "admin.acquisitions.client.pauseAll",
          )}
        </button>
      ) : null}
    </section>
  );
}

export function AcquisitionsPage() {
  const { t } = useLanguage();
  const [acquisitions, setAcquisitions] = useState<Acquisition[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clientBusy, setClientBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [live, setLive] = useState<DownloadProgress | null>(null);
  const [expanded, setExpanded] = useState<
    Map<string, AcquisitionDetail | "loading" | "failed">
  >(new Map());
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  /** The order a drop committed, held until the client confirms it. */
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  /** The order the list is held in while a row is being dragged. */
  const [dragFreeze, setDragFreeze] = useState<string[] | null>(null);

  const loadBlocklist = useCallback(async () => {
    try {
      setBlocklist(await listBlocklist());
    } catch {
      // The blocklist is secondary here; the acquisitions still load.
    }
  }, []);

  const refreshLive = useCallback(async () => {
    try {
      setLive(await getDownloadProgress());
    } catch {
      // A failed read leaves the last one standing.
    }
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setFailure(null);
    void loadBlocklist();
    try {
      setAcquisitions(await listAcquisitions());
    } catch {
      // The message from a failed request can carry a URL; the page says that
      // it could not load rather than repeating whatever the client threw.
      setFailure("admin.acquisitions.loadFailed");
    } finally {
      setIsLoading(false);
    }
  }, [loadBlocklist]);

  useEffect(() => {
    setPageTitle(`${t("admin.acquisitions.title")} · Seyirlik`, {
      canonicalPath: "/admin/acquisitions",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isCancelled = false;

    void (async () => {
      try {
        void listBlocklist()
          .then((entries) => {
            if (!isCancelled) setBlocklist(entries);
          })
          .catch(() => undefined);
        const rows = await listAcquisitions();
        if (!isCancelled) setAcquisitions(rows);
      } catch {
        if (!isCancelled) setFailure("admin.acquisitions.loadFailed");
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  const rows = useMemo(() => acquisitions ?? [], [acquisitions]);
  const hasActive = rows.some((row) => bucketOf(row.state) === "active");

  /*
   * While anything is running, read its progress every few seconds, and the
   * list itself less often so a finished download moves on by itself. A
   * hidden tab reads nothing.
   */
  useEffect(() => {
    if (!hasActive) return;
    let isCancelled = false;
    let polls = 0;

    const tick = async () => {
      if (document.hidden) return;
      polls += 1;
      try {
        const next = await getDownloadProgress();
        if (isCancelled) return;
        setLive(next);
        const finished = next.progress.some(
          (entry) => entry.stage === "done" || entry.stage === "failed",
        );
        if (finished || polls % LIST_EVERY_POLLS === 0) {
          const rows = await listAcquisitions();
          if (!isCancelled) setAcquisitions(rows);
        }
      } catch {
        // A failed read leaves the last one standing; the next tick retries.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), PROGRESS_POLL_MS);
    return () => {
      isCancelled = true;
      window.clearInterval(timer);
    };
  }, [hasActive]);

  const liveById = useMemo(
    () =>
      new Map(
        (live?.reachable ? live.progress : []).map((entry) => [
          entry.acquisitionId,
          entry,
        ]),
      ),
    [live],
  );

  /*
   * The four lists the page is made of.
   *
   * The queue is what the download client holds, in its order. Unpacking is
   * past the queue and cannot be moved. Preparing is what Seyirlik has not yet
   * handed over, or cannot see in the client.
   */
  const { queue, unpacking, preparing, attention, finished } = useMemo(() => {
    const queue: Array<{ row: Acquisition; entry: AcquisitionProgress }> = [];
    const unpacking: Acquisition[] = [];
    const preparing: Acquisition[] = [];
    const attention: Acquisition[] = [];
    const finished: Acquisition[] = [];
    for (const row of rows) {
      const bucket = bucketOf(row.state);
      if (bucket === "needsAttention") {
        attention.push(row);
        continue;
      }
      if (bucket === "finished") {
        finished.push(row);
        continue;
      }
      const entry = liveById.get(row.id);
      if (entry?.queuePosition !== undefined) queue.push({ row, entry });
      else if (entry) unpacking.push(row);
      else preparing.push(row);
    }
    queue.sort((a, b) => a.entry.queuePosition! - b.entry.queuePosition!);
    return { queue, unpacking, preparing, attention, finished };
  }, [rows, liveById]);

  const queueIds = useMemo(() => queue.map(({ row }) => row.id), [queue]);
  const shownIds = dragFreeze ?? orderOverride ?? queueIds;
  const queueById = useMemo(
    () => new Map(queue.map((item) => [item.row.id, item])),
    [queue],
  );
  const shownQueue = shownIds.flatMap((id) => {
    const item = queueById.get(id);
    return item ? [item] : [];
  });

  const commitOrder = useCallback(
    async (orderedIds: string[]) => {
      const move = queueMoveFor(
        queue.map(({ row, entry }) => ({
          id: row.id,
          queuePosition: entry.queuePosition!,
        })),
        orderedIds,
      );
      if (!move) return;
      setOrderOverride(orderedIds);
      try {
        await moveAcquisition(move.id, move.position);
        setLive(await getDownloadProgress());
      } catch {
        setNotice({ kind: "controlFailed" });
      } finally {
        setOrderOverride(null);
      }
    },
    [queue],
  );

  const sortable = useQueueSortable({
    ids: shownIds,
    disabled: orderOverride !== null || !live?.reachable,
    onDragStart: setDragFreeze,
    onDragEnd: () => setDragFreeze(null),
    onCommit: (orderedIds) => void commitOrder(orderedIds),
  });

  /*
   * A queue that changed shape under the gesture — a download finished, one
   * was cancelled from another tab — no longer matches the geometry the drag
   * was measured against. Ending it leaves the row where the client says.
   */
  const cancelDrag = sortable.cancel;
  useEffect(() => {
    if (!dragFreeze) return;
    const current = new Set(queueIds);
    const intact =
      current.size === dragFreeze.length &&
      dragFreeze.every((id) => current.has(id));
    if (!intact) cancelDrag();
  }, [queueIds, cancelDrag, dragFreeze]);

  const moveTo = useCallback(
    (id: string, index: number) => {
      const from = shownIds.indexOf(id);
      if (from < 0 || index < 0 || index >= shownIds.length || index === from)
        return;
      const next = shownIds.filter((other) => other !== id);
      next.splice(index, 0, id);
      void commitOrder(next);
    },
    [commitOrder, shownIds],
  );

  /** Runs one queue control, then re-reads the queue to show its effect. */
  const control = useCallback(
    async (id: string | null, run: () => Promise<unknown>) => {
      if (id) setBusyId(id);
      else setClientBusy(true);
      setNotice(null);
      try {
        await run();
      } catch {
        setNotice({ kind: "controlFailed" });
      } finally {
        await refreshLive();
        if (id) setBusyId(null);
        else setClientBusy(false);
      }
    },
    [refreshLive],
  );

  const toggleDetails = useCallback(
    async (id: string) => {
      if (expanded.has(id)) {
        setExpanded((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        return;
      }
      setExpanded((current) => new Map(current).set(id, "loading"));
      let detail: AcquisitionDetail | "failed";
      try {
        detail = await getAcquisition(id);
      } catch {
        detail = "failed";
      }
      setExpanded((current) =>
        current.has(id) ? new Map(current).set(id, detail) : current,
      );
    },
    [expanded],
  );

  const act = useCallback(
    async (id: string, action: "retry" | "cancel") => {
      setBusyId(id);
      try {
        await (action === "retry"
          ? retryAcquisition(id)
          : cancelAcquisition(id));
      } catch {
        setNotice({ kind: "controlFailed" });
      } finally {
        setBusyId(null);
        setConfirmingCancel(null);
        await load();
        await refreshLive();
      }
    },
    [load, refreshLive],
  );

  /*
   * Searching again runs the indexer search inside the request, so it takes
   * seconds. The row's buttons stay disabled for that long, which is also
   * what keeps a second press from asking twice.
   */
  const blocklistRow = useCallback(
    async (id: string, searchAgain: boolean) => {
      setBusyId(id);
      setNotice(null);
      try {
        const outcome = await blocklistAcquisition(id, searchAgain);
        setNotice(
          outcome.replacement
            ? {
                kind: "replaced",
                releaseTitle: outcome.replacement.releaseTitle,
              }
            : !searchAgain
              ? { kind: "blocklisted" }
              : outcome.reason === "no-profile"
                ? { kind: "noProfile" }
                : { kind: "nothingElse" },
        );
      } catch {
        setNotice({ kind: "failed" });
      } finally {
        setBusyId(null);
        await load();
      }
    },
    [load],
  );

  const unblock = useCallback(
    async (entryId: string) => {
      try {
        await removeBlocklistEntry(entryId);
      } finally {
        await loadBlocklist();
      }
    },
    [loadBlocklist],
  );

  /** The parts every row shares: the name, the release, the failure. */
  const rowHeader = (row: Acquisition, status: string | null) => (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <TargetName row={row} t={t} className="flex-1" />
        {status ? (
          <span className="shrink-0 text-xs font-black uppercase tracking-[0.1em] text-white/50">
            {status}
          </span>
        ) : null}
      </div>
      {/* The release name is provider text: rendered as text. */}
      <p
        title={row.releaseTitle}
        className="mt-0.5 truncate text-xs font-medium text-white/40"
      >
        {row.releaseTitle}
      </p>
      {row.failureClass ? (
        <p className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-200">
          {t(
            `admin.acquisitions.failure.${row.failureClass}` as "admin.acquisitions.failure.unknown",
          )}
          {/* A superseded row was already acted on: what to do about it no
              longer applies. */}
          {row.state === "superseded"
            ? null
            : ` — ${t(
                `admin.acquisitions.remedy.${remedyFor(row.failureClass)}` as "admin.acquisitions.remedy.waits",
              )}`}
        </p>
      ) : null}
    </>
  );

  /** Cancel, asked once more: it deletes what has been downloaded so far. */
  const cancelControl = (row: Acquisition) =>
    confirmingCancel === row.id ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-xs font-bold text-white/60">
          {t("admin.acquisitions.row.confirmCancel")}
        </span>
        <button
          type="button"
          disabled={busyId === row.id}
          onClick={() => void act(row.id, "cancel")}
          className="rounded-full bg-red-500/80 px-3 py-1.5 text-xs font-black text-white transition hover:bg-red-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {t("admin.acquisitions.row.confirmYes")}
        </button>
        <button
          type="button"
          onClick={() => setConfirmingCancel(null)}
          className={TEXT_BUTTON}
        >
          {t("admin.acquisitions.row.keep")}
        </button>
      </span>
    ) : (
      <button
        type="button"
        disabled={busyId === row.id}
        aria-label={t("admin.acquisitions.cancel")}
        title={t("admin.acquisitions.cancel")}
        onClick={() => setConfirmingCancel(row.id)}
        className={ICON_BUTTON}
      >
        <X size={16} aria-hidden="true" />
      </button>
    );

  const detailsToggle = (row: Acquisition) => (
    <button
      type="button"
      aria-expanded={expanded.has(row.id)}
      aria-label={t("admin.acquisitions.row.details")}
      title={t("admin.acquisitions.row.details")}
      onClick={() => void toggleDetails(row.id)}
      className={ICON_BUTTON}
    >
      <ChevronDown
        size={16}
        aria-hidden="true"
        className={expanded.has(row.id) ? "rotate-180" : ""}
      />
    </button>
  );

  /** Never this release again; offered wherever the server allows it. */
  const blocklistButtons = (row: Acquisition) => {
    const isBusy = busyId === row.id;
    return (
      <>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void blocklistRow(row.id, true)}
          className={TEXT_BUTTON}
        >
          <SearchCheck size={13} aria-hidden="true" />
          {isBusy
            ? t("admin.acquisitions.searching")
            : t("admin.acquisitions.blocklistAndSearch")}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void blocklistRow(row.id, false)}
          className={TEXT_BUTTON}
        >
          <Ban size={13} aria-hidden="true" />
          {t("admin.acquisitions.blocklist")}
        </button>
      </>
    );
  };

  /*
   * A running download's details carry the blocklist buttons too: a release
   * that turns out wrong mid-download is stopped from here, but those two
   * buttons are too heavy to sit on every row of a long queue.
   */
  const details = (row: Acquisition, withBlocklist = false) => {
    const detail = expanded.get(row.id);
    if (!detail) return null;
    return (
      <>
        <RowDetails detail={detail} t={t} />
        {withBlocklist ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {blocklistButtons(row)}
          </div>
        ) : null}
      </>
    );
  };

  /** Rows that are not in the client's queue: no handle, no live place. */
  const plainRow = (row: Acquisition, withProgress: boolean) => {
    const actions = actionsFor(
      row.state,
      row.failureClass,
      row.releaseBlocklisted,
    );
    const isBusy = busyId === row.id;
    const entry = liveById.get(row.id);
    return (
      <li key={row.id} className={ROW}>
        <div className="flex items-start gap-3">
          <DownloadArt row={row} />
          <div className="min-w-0 flex-1">
            {rowHeader(
              row,
              /*
               * The client's word when it has one: the stored state is
               * written by the reconciler every half-minute, and a download
               * that has just started unpacking is still "queued" there.
               */
              entry?.stage === "processing"
                ? t("admin.acquisitions.state.processing")
                : t(
                    `admin.acquisitions.state.${row.state}` as "admin.acquisitions.state.queued",
                  ),
            )}
            {withProgress && entry && live ? (
              <ProgressLine entry={entry} live={live} t={t} />
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions.canBlocklist ? blocklistButtons(row) : null}
              {actions.canRetry ? (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void act(row.id, "retry")}
                  className={TEXT_BUTTON}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  {t("admin.acquisitions.retry")}
                </button>
              ) : null}
              <span className="ml-auto flex items-center gap-2">
                {actions.canCancel ? cancelControl(row) : null}
                {detailsToggle(row)}
              </span>
            </div>
            {details(row)}
          </div>
        </div>
      </li>
    );
  };

  const section = (
    id: string,
    heading: string,
    children: ReactNode,
    aside?: ReactNode,
  ) => (
    <section aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 id={id} className="text-lg font-black text-white">
          {heading}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );

  return (
    <div className="w-full space-y-6">
      <WorkflowSteps current="/admin/acquisitions" />

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-white">
            {t("admin.acquisitions.title")}
          </h1>
          <p className="mt-1 text-sm font-semibold text-white/50">
            {t("admin.acquisitions.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void load();
            void refreshLive();
          }}
          disabled={isLoading}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-bold text-white/70 transition hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
          {t("admin.acquisitions.refresh")}
        </button>
      </header>

      <DownloaderBar
        live={live}
        queued={queue.length}
        busy={clientBusy}
        onToggle={(paused) =>
          void control(null, () => setDownloadClientPaused(paused))
        }
        t={t}
      />

      {failure ? (
        <p
          role="alert"
          className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm font-bold text-red-200"
        >
          {t(failure as "admin.acquisitions.loadFailed")}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
            notice.kind === "replaced" || notice.kind === "blocklisted"
              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
              : "border-amber-400/30 bg-amber-400/10 text-amber-100"
          }`}
        >
          {t(
            `admin.acquisitions.notice.${notice.kind}` as "admin.acquisitions.notice.blocklisted",
          )}
          {/* Provider text, rendered as text. */}
          {notice.kind === "replaced" ? (
            <span className="mt-1 block break-all text-xs font-medium opacity-80">
              {notice.releaseTitle}
            </span>
          ) : null}
        </p>
      ) : null}

      {!isLoading && rows.length === 0 && !failure ? (
        <p className="rounded-3xl border border-white/10 bg-white/[0.04] px-5 py-8 text-center text-sm font-semibold text-white/45">
          {t("admin.acquisitions.empty")}
        </p>
      ) : null}

      {attention.length > 0
        ? section(
            "bucket-needsAttention",
            t("admin.acquisitions.bucket.needsAttention"),
            <ul className="mt-3 space-y-2">
              {attention.map((row) => plainRow(row, false))}
            </ul>,
          )
        : null}

      {unpacking.length > 0
        ? section(
            "bucket-unpacking",
            t("admin.acquisitions.unpacking.heading"),
            <ul className="mt-3 space-y-2">
              {unpacking.map((row) => plainRow(row, true))}
            </ul>,
          )
        : null}

      {shownQueue.length > 0
        ? section(
            "bucket-queue",
            t("admin.acquisitions.queue.heading"),
            <ul className="mt-3 flex flex-col gap-2">
              {shownQueue.map(({ row, entry }) => {
                const position =
                  (sortable.previewOrder ?? shownIds).indexOf(row.id) + 1;
                const held = sortable.isActive(row.id);
                const lifted = held || sortable.isSettling(row.id);
                const isBusy = busyId === row.id;
                const jobPaused = entry.stage === "paused";
                const name = targetLabel(row.target);
                const spoken = [name.title, name.episodeCode]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <li
                    key={row.id}
                    ref={sortable.registerRow(row.id)}
                    style={sortable.rowStyle(row.id)}
                    data-acquisition-id={row.id}
                    className={`${ROW} ${
                      lifted
                        ? "border-white/25 bg-[#15151a] shadow-[0_20px_45px_-18px_rgba(0,0,0,0.9)]"
                        : entry.stage === "downloading" && !live?.paused
                          ? "border-[var(--accent)]/30"
                          : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex shrink-0 flex-col items-center gap-1">
                        <button
                          type="button"
                          aria-label={formatTemplate(
                            t("admin.acquisitions.row.handle"),
                            {
                              title: spoken,
                              position,
                              total: shownIds.length,
                            },
                          )}
                          title={t("admin.acquisitions.row.dragHint")}
                          onPointerDown={(event) =>
                            sortable.startDrag(event, row.id)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "ArrowUp") {
                              event.preventDefault();
                              moveTo(row.id, position - 2);
                            } else if (event.key === "ArrowDown") {
                              event.preventDefault();
                              moveTo(row.id, position);
                            }
                          }}
                          className={`inline-flex h-9 w-9 cursor-grab touch-none select-none items-center justify-center rounded-lg border text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white/70 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                            held
                              ? "cursor-grabbing border-white/25 bg-white/[0.1] text-white/80"
                              : "border-white/10"
                          }`}
                        >
                          <GripVertical size={18} aria-hidden="true" />
                        </button>
                        <span className="text-[0.6875rem] font-black tabular-nums text-white/40">
                          {position}
                        </span>
                      </div>

                      <DownloadArt row={row} />

                      <div className="min-w-0 flex-1">
                        {rowHeader(
                          row,
                          live?.paused || jobPaused
                            ? t("admin.acquisitions.row.paused")
                            : t(
                                entry.stage === "downloading"
                                  ? "admin.acquisitions.state.downloading"
                                  : "admin.acquisitions.state.queued",
                              ),
                        )}
                        {live ? (
                          <ProgressLine entry={entry} live={live} t={t} />
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={isBusy}
                            aria-label={t(
                              jobPaused
                                ? "admin.acquisitions.row.resume"
                                : "admin.acquisitions.row.pause",
                            )}
                            title={t(
                              jobPaused
                                ? "admin.acquisitions.row.resume"
                                : "admin.acquisitions.row.pause",
                            )}
                            onClick={() =>
                              void control(row.id, () =>
                                jobPaused
                                  ? resumeAcquisition(row.id)
                                  : pauseAcquisition(row.id),
                              )
                            }
                            className={ICON_BUTTON}
                          >
                            {jobPaused ? (
                              <Play size={15} aria-hidden="true" />
                            ) : (
                              <Pause size={15} aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={
                              isBusy || position === 1 || orderOverride !== null
                            }
                            aria-label={t("admin.acquisitions.row.toTop")}
                            title={t("admin.acquisitions.row.toTop")}
                            onClick={() => moveTo(row.id, 0)}
                            className={ICON_BUTTON}
                          >
                            <ArrowUpToLine size={15} aria-hidden="true" />
                          </button>
                          <span className="ml-auto flex items-center gap-2">
                            {cancelControl(row)}
                            {detailsToggle(row)}
                          </span>
                        </div>
                        {details(row, true)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>,
          )
        : null}

      {preparing.length > 0
        ? section(
            "bucket-preparing",
            t(
              live && !live.reachable
                ? "admin.acquisitions.bucket.active"
                : "admin.acquisitions.preparing.heading",
            ),
            <>
              {live && !live.reachable ? (
                <p className="mt-1 px-1 text-xs font-semibold text-amber-200/80">
                  {t("admin.acquisitions.progress.unreachable")}
                </p>
              ) : null}
              <ul className="mt-3 space-y-2">
                {preparing.map((row) => plainRow(row, false))}
              </ul>
            </>,
          )
        : null}

      {finished.length > 0
        ? section(
            "bucket-finished",
            t("admin.acquisitions.bucket.finished"),
            showFinished ? (
              <ul className="mt-3 space-y-2">
                {finished.map((row) => plainRow(row, false))}
              </ul>
            ) : null,
            <button
              type="button"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((value) => !value)}
              className="text-xs font-black text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {showFinished
                ? t("admin.acquisitions.finished.hide")
                : formatTemplate(t("admin.acquisitions.finished.show"), {
                    count: finished.length,
                  })}
            </button>,
          )
        : null}

      {blocklist.length > 0 ? (
        <section aria-labelledby="blocklist-heading">
          <h2
            id="blocklist-heading"
            className="px-1 text-lg font-black text-white"
          >
            {t("admin.acquisitions.blocklistHeading")}
          </h2>
          <p className="mt-1 px-1 text-sm font-semibold text-white/50">
            {t("admin.acquisitions.blocklistDescription")}
          </p>

          <ul className="mt-3 space-y-2">
            {blocklist.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  {entry.targetTitle ? (
                    <p className="text-sm font-black text-white">
                      {entry.targetTitle}
                    </p>
                  ) : null}
                  {/* Provider text, rendered as text. */}
                  <p className="break-all text-xs font-medium text-white/45">
                    {entry.releaseTitle}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void unblock(entry.id)}
                  className={TEXT_BUTTON}
                >
                  {t("admin.acquisitions.unblock")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
