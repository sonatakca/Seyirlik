import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownToLine, Play, RotateCw, Trash2, WifiOff } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { useLanguage } from "../i18n/LanguageContext";
import {
  cancelDownload,
  startDownload,
  useActiveDownload,
} from "../lib/offline/downloadController";
import { formatBytes } from "../lib/offline/formatBytes";
import {
  isOfflineSupported,
  listOfflineTitles,
  offlineArtworkUrls,
  removeOfflineTitle,
  type OfflineTitle,
} from "../lib/offline/offlineLibrary";
import { setPageTitle } from "../lib/pageTitle";

/** Shape only; the two colourings below never compete for the same property. */
const ACTION_SHAPE =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-bold transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const ACTION = `${ACTION_SHAPE} border border-white/12 bg-white/[0.06] text-white hover:border-white/25 hover:bg-white/[0.12]`;
const PLAY_ACTION = `${ACTION_SHAPE} bg-white text-zinc-950 hover:bg-zinc-100`;

function titleOf(entry: OfflineTitle): {
  heading: string;
  detail: string | null;
} {
  const item = entry.item;
  if (item.Type === "Episode") {
    const code =
      item.ParentIndexNumber !== undefined && item.IndexNumber !== undefined
        ? `S${item.ParentIndexNumber}:E${item.IndexNumber}`
        : null;
    return {
      heading: item.SeriesName ?? item.Name,
      detail: [code, item.Name].filter(Boolean).join(" · "),
    };
  }
  return {
    heading: item.Name,
    detail: item.ProductionYear ? String(item.ProductionYear) : null,
  };
}

function DownloadRow({
  entry,
  onRemove,
}: {
  entry: OfflineTitle;
  onRemove: (itemId: string) => void;
}) {
  const { t } = useLanguage();
  const active = useActiveDownload(entry.itemId);
  const live = active?.progress ?? entry;
  const isDownloading = active !== null && active.failure === null;
  const isComplete = !isDownloading && entry.state === "complete";
  const share =
    live.estimatedBytes > 0
      ? Math.min(1, live.downloadedBytes / live.estimatedBytes)
      : 0;
  const { heading, detail } = titleOf(entry);
  const poster = offlineArtworkUrls(entry.item).poster;
  const [posterFailed, setPosterFailed] = useState(false);

  return (
    <li className="flex items-center gap-4 rounded-3xl border border-white/10 bg-white/[0.045] p-3 sm:p-4">
      {posterFailed ? (
        <span
          aria-hidden="true"
          className="flex h-24 w-16 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white/30 sm:h-28 sm:w-[4.7rem]"
        >
          <ArrowDownToLine size={20} />
        </span>
      ) : (
        <img
          src={poster}
          alt=""
          loading="lazy"
          onError={() => setPosterFailed(true)}
          className="h-24 w-16 shrink-0 rounded-xl bg-white/[0.06] object-cover sm:h-28 sm:w-[4.7rem]"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-black text-white">{heading}</p>
        {detail ? (
          <p className="truncate text-sm font-semibold text-white/55">
            {detail}
          </p>
        ) : null}
        <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-white/40">
          {`${entry.height}p${entry.hdr ? " HDR" : ""} · ${formatBytes(
            isComplete ? entry.downloadedBytes : live.downloadedBytes,
          )}`}
          {isComplete ? "" : ` / ${formatBytes(entry.estimatedBytes)}`}
        </p>
        {!isComplete ? (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(2, share * 100)}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
        {isComplete ? (
          <Link
            to={`/downloads/watch/${encodeURIComponent(entry.itemId)}`}
            className={PLAY_ACTION}
          >
            <Play size={16} fill="currentColor" />
            {t("downloads.play")}
          </Link>
        ) : isDownloading ? (
          <button
            type="button"
            className={ACTION}
            onClick={() => cancelDownload(entry.itemId)}
          >
            {t("downloads.pause")}
          </button>
        ) : (
          <button
            type="button"
            className={ACTION}
            onClick={() => startDownload(entry.item)}
          >
            <RotateCw size={16} />
            {t("downloads.resume")}
          </button>
        )}
        <button
          type="button"
          aria-label={t("downloads.remove")}
          className={ACTION}
          onClick={() => {
            cancelDownload(entry.itemId);
            onRemove(entry.itemId);
          }}
        >
          <Trash2 size={16} />
          <span className="hidden sm:inline">{t("downloads.remove")}</span>
        </button>
      </div>
    </li>
  );
}

/**
 * Titles kept on this device.
 *
 * Reachable without the server — it is routed outside the connection check —
 * because being without the server is exactly when it is needed.
 */
export function DownloadsPage() {
  const { t } = useLanguage();
  const [entries, setEntries] = useState<OfflineTitle[] | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(
    null,
  );
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const load = useCallback(() => {
    void listOfflineTitles()
      .then(setEntries)
      .catch(() => setEntries([]));
    void navigator.storage
      ?.estimate?.()
      .then((estimate) =>
        setUsage({ used: estimate.usage ?? 0, quota: estimate.quota ?? 0 }),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setPageTitle(t("downloads.title"), {
      canonicalPath: "/downloads",
      robots: "noindex, nofollow",
    });
    load();
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener("seyirlik:offline-changed", load);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("seyirlik:offline-changed", load);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [load, t]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 pb-24 pt-[calc(env(safe-area-inset-top)+1.5rem)] text-white sm:px-6 sm:pt-12">
      {/* Routed outside the app shell so it works offline, which leaves it
          without the navbar; the way out is the homepage, as on Alerts. */}
      <BackButton to="/home" label={t("common.home")} className="mb-8" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
            {t("downloads.title")}
          </h1>
          <p className="mt-2 max-w-xl text-sm font-medium leading-6 text-white/55">
            {t("downloads.description")}
          </p>
        </div>
        {usage && usage.quota > 0 ? (
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-white/40">
            {t("downloads.storage")
              .replace("{used}", formatBytes(usage.used))
              .replace("{quota}", formatBytes(usage.quota))}
          </p>
        ) : null}
      </div>

      {!isOnline ? (
        <p className="mt-6 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm font-bold text-white/70">
          <WifiOff size={16} />
          {t("downloads.offlineNotice")}
        </p>
      ) : null}

      {!isOfflineSupported() ? (
        <p className="mt-10 text-sm font-semibold text-white/55">
          {t("downloads.unsupported")}
        </p>
      ) : entries === null ? null : entries.length === 0 ? (
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-white/60">
            <ArrowDownToLine size={24} />
          </span>
          <p className="mt-4 max-w-sm text-sm font-semibold leading-6 text-white/55">
            {t("downloads.empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {entries.map((entry) => (
            <DownloadRow
              key={entry.itemId}
              entry={entry}
              onRemove={(itemId) => {
                void removeOfflineTitle(itemId).then(load);
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
