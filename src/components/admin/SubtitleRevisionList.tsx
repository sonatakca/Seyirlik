import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  compareSubtitleRevisions,
  getSubtitleRevisions,
  type SubtitleRevision,
  type SubtitleRevisionComparison,
} from "../../lib/libraryAdminApi";
import { describeErrorDetail } from "../../lib/userFacingError";
import { actionButton } from "./libraryStyle";
import { formatClock } from "./subtitleSyncFormat";

const ORIGIN_LABEL: Record<SubtitleRevision["origin"], TranslationKey> = {
  original: "library.revisionOriginal",
  external: "library.revisionExternal",
  download: "library.revisionDownload",
  fit: "library.revisionFit",
  sync: "library.revisionSync",
  manual: "library.revisionManual",
  restore: "library.revisionRestore",
};

/**
 * Every version of one subtitle file, newest first, and the way back.
 *
 * The newest committed version is what the file holds now, so it is the one
 * version that cannot be restored; every other committed one can, and doing
 * so adds a version rather than removing any.
 */
export function SubtitleRevisionList({
  itemId,
  streamIndex,
  refreshKey,
  disabled,
  onRestore,
}: {
  itemId: string;
  streamIndex: number;
  /** Changes whenever the file may have changed, to list again. */
  refreshKey: unknown;
  disabled: boolean;
  onRestore: (revisionId: string) => void;
}) {
  const { t, language } = useLanguage();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<SubtitleRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState<{
    id: string;
    comparison: SubtitleRevisionComparison | null;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getSubtitleRevisions(itemId, streamIndex)
      .then((value) => {
        if (cancelled) return;
        setError(null);
        setRevisions(value.revisions);
      })
      .catch(
        (failure: unknown) =>
          !cancelled &&
          setError(
            describeErrorDetail(failure, t) || t("library.revisionsFailed"),
          ),
      );
    return () => {
      cancelled = true;
    };
  }, [open, itemId, streamIndex, refreshKey, t]);

  const head = revisions?.find((revision) => revision.state === "committed");
  const compare = (revision: SubtitleRevision) => {
    if (comparing?.id === revision.id) return setComparing(null);
    setComparing({ id: revision.id, comparison: null });
    compareSubtitleRevisions(itemId, revision.id, streamIndex)
      .then((comparison) =>
        setComparing((current) =>
          current?.id === revision.id
            ? { id: revision.id, comparison }
            : current,
        ),
      )
      .catch(() => setComparing(null));
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(language === "tr" ? "tr-TR" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    });

  return (
    <details
      className="text-xs text-white/60"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="inline-flex cursor-pointer items-center gap-1.5 font-bold text-white/55">
        <History size={13} aria-hidden="true" />
        {t("library.revisions")}
      </summary>
      {error ? (
        <p className="mt-2 text-rose-200/80">{error}</p>
      ) : revisions === null ? (
        <p role="status" className="mt-2 text-white/40">
          {t("library.loading")}
        </p>
      ) : revisions.length === 0 ? (
        <p className="mt-2 text-white/40">{t("library.revisionsNone")}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {revisions.map((revision) => (
            <li key={revision.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold tabular-nums text-white/70">
                  v{revision.revision}
                </span>
                <span className="font-semibold">
                  {t(ORIGIN_LABEL[revision.origin])}
                </span>
                <span className="text-white/35">
                  {date(revision.createdAt)}
                </span>
                {revision.state !== "committed" ? (
                  <span className="text-amber-200/70">
                    {t(
                      revision.state === "pending"
                        ? "library.revisionPending"
                        : "library.revisionAbandoned",
                    )}
                  </span>
                ) : revision.id === head?.id ? (
                  <span className="text-sky-200/70">
                    {t("library.revisionCurrent")}
                  </span>
                ) : null}
                {revision.parentId ? (
                  <button
                    type="button"
                    className="font-bold text-white/50 underline decoration-white/20 underline-offset-2 hover:text-white/80"
                    aria-expanded={comparing?.id === revision.id}
                    onClick={() => compare(revision)}
                  >
                    {t("library.revisionCompare")}
                  </button>
                ) : null}
                {revision.state === "committed" && revision.id !== head?.id ? (
                  <button
                    type="button"
                    className={actionButton}
                    disabled={disabled}
                    onClick={() => onRestore(revision.id)}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    {t("library.revisionRestoreAction")}
                  </button>
                ) : null}
              </div>
              {comparing?.id === revision.id ? (
                <Comparison comparison={comparing.comparison} t={t} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Comparison({
  comparison,
  t,
}: {
  comparison: SubtitleRevisionComparison | null;
  t: (key: TranslationKey) => string;
}) {
  if (!comparison)
    return (
      <p role="status" className="text-white/40">
        {t("library.loading")}
      </p>
    );
  return (
    <div className="space-y-1 rounded-lg border border-white/10 bg-black/30 p-2">
      <p className="font-semibold text-white/60">
        {comparison.moved.length} {t("library.revisionMoved")}
        {comparison.removed.length > 0
          ? ` · ${comparison.removed.length} ${t("library.revisionRemoved")}`
          : ""}
        {comparison.added.length > 0
          ? ` · ${comparison.added.length} ${t("library.revisionAdded")}`
          : ""}
      </p>
      <ul className="space-y-0.5">
        {comparison.moved.slice(0, 10).map((cue, index) => (
          <li
            key={`${cue.beforeStartSeconds}-${index}`}
            className="text-white/55"
          >
            <span className="tabular-nums text-white/40">
              {formatClock(cue.beforeStartSeconds)} →{" "}
              {formatClock(cue.afterStartSeconds)}
            </span>{" "}
            {cue.text.replace(/<[^>]*>/g, "").replace(/\n/g, " ")}
          </li>
        ))}
      </ul>
    </div>
  );
}
