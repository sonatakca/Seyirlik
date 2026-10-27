/**
 * A title's or a file's way to Google Drive, after the work itself is done.
 *
 * Shared by the processing page, where it follows a published package, and the
 * imports page, where it follows an imported file. Both are uploaded by the
 * helper's Drive mount in the background, and both are on Drive — where the
 * server reads them from — only when this says so.
 */
import type { useLanguage } from "../../i18n/LanguageContext";
import type { DriveUploadStatus } from "../../lib/processingApi";
import { formatTemplate } from "./libraryMaintenanceModel";
import {
  formatByteRate,
  formatDuration,
  formatFileSize,
  phasePercent,
} from "./processingModel";

type Translate = ReturnType<typeof useLanguage>["t"];

const LABEL =
  "text-[11px] font-black uppercase tracking-[0.14em] text-white/40";

/** A tracker reading older than this means nobody is watching the upload. */
const DRIVE_UPLOAD_STALE_MS = 60_000;

/**
 * The package's way to Google Drive, after the job itself has finished.
 *
 * Publishing on the helper only reaches the Drive mount's cache; the title is
 * on Drive — where the server plays it from — when this says so.
 */
export function DriveUploadPanel({
  upload,
  nowMs,
  t,
}: {
  upload: DriveUploadStatus;
  nowMs: number;
  t: Translate;
}) {
  const done = upload.state === "uploaded";
  const stale = !done && nowMs - upload.updatedAtMs > DRIVE_UPLOAD_STALE_MS;
  const fraction =
    upload.totalBytes > 0 ? upload.uploadedBytes / upload.totalBytes : 0;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={LABEL}>{t("processing.upload.heading")}</span>
        {done ? (
          <span className="text-xs font-semibold text-emerald-200/90">
            {formatTemplate(t("processing.upload.done"), {
              duration: formatDuration(
                Math.max(
                  0,
                  Math.round(
                    ((upload.finishedAtMs ?? upload.updatedAtMs) -
                      upload.startedAtMs) /
                      1000,
                  ),
                ),
              ),
            })}
          </span>
        ) : (
          <span className="text-2xl font-black tabular-nums">
            {phasePercent(fraction)}
          </span>
        )}
      </div>
      {done ? (
        <span className="text-xs text-white/45">
          {formatFileSize(upload.totalBytes)} ·{" "}
          {t("processing.upload.serverNote")}
        </span>
      ) : (
        <>
          <PhaseBar fraction={fraction} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-white/45">
            <span>
              {formatFileSize(upload.uploadedBytes)} /{" "}
              {formatFileSize(upload.totalBytes)}
            </span>
            <span>
              {formatTemplate(t("processing.upload.files"), {
                pending: String(upload.filesPending),
                uploading: String(upload.filesUploading),
              })}
            </span>
            {upload.bytesPerSecond && !stale ? (
              <span>{formatByteRate(upload.bytesPerSecond)}</span>
            ) : null}
            {upload.etaSeconds !== undefined && !stale ? (
              <span>
                {t("processing.eta")}: {formatDuration(upload.etaSeconds)}
              </span>
            ) : null}
            {upload.retries ? (
              <span className="text-amber-100/70">
                {formatTemplate(t("processing.upload.retries"), {
                  count: String(upload.retries),
                })}
              </span>
            ) : null}
          </div>
          {stale ? (
            <span className="text-xs text-amber-100/70">
              {formatTemplate(t("processing.upload.notWatched"), {
                age: formatDuration(
                  Math.round((nowMs - upload.updatedAtMs) / 1000),
                ),
              })}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The bar a phase panel draws for its own measured fraction. */
export function PhaseBar({ fraction }: { fraction: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none"
        style={{
          width: `${Math.min(100, Math.max(0, fraction * 100))}%`,
        }}
      />
    </div>
  );
}
