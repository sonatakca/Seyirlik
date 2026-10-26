import { useEffect, useState } from "react";
import { Headphones, RotateCcw, Trash2 } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import {
  getNarratorSeenAt,
  type BookNarration,
} from "../../lib/bookNarrationApi";
import { formatDuration, formatPercent } from "./readerText";

/** A narrator that asked for work this recently is there to read. */
const PRESENT_MS = 3 * 60 * 1000;

/**
 * The audiobook, as an administrator sees it in the reader's menu: asking
 * for it, how far the narrator has read, and taking it away. Sections can be
 * listened to as they arrive, so "being narrated" already plays.
 */
export function ReaderNarrationControl({
  narration,
  busy,
  failed,
  onRequest,
  onRemove,
}: {
  narration: BookNarration | null;
  busy: boolean;
  /** The last request or removal did not go through. */
  failed: boolean;
  onRequest: () => void;
  onRemove: () => void;
}) {
  const { t, language } = useLanguage();
  // The state a removal was asked to be confirmed in: once it moves on (the
  // narration finished, say), the question no longer stands.
  const [confirmingIn, setConfirmingIn] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** With no narration yet the book says nothing of the narrator, so it is asked for. */
  const [presence, setPresence] = useState<string | null | undefined>(
    undefined,
  );
  const askPresence = narration === null;

  // "Seen a minute ago" stays true while the menu is open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!askPresence) return undefined;
    let current = true;
    getNarratorSeenAt().then(
      (seenAt) => current && setPresence(seenAt),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [askPresence]);

  const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
  const seen = (() => {
    const at = narration ? narration.narratorSeenAt : presence;
    if (at === undefined) return null;
    if (!at) return t("reader.narration.neverSeen");
    const ago = now - Date.parse(at);
    return ago < PRESENT_MS
      ? t("reader.narration.present")
      : t("reader.narration.seenAgo").replace(
          "{time}",
          formatDuration(Math.round(ago / 60_000), t),
        );
  })();

  const state = narration?.state ?? null;
  const progress = narration?.progress ?? null;
  const listen = narration
    ? narration.sections.reduce((sum, section) => sum + section.duration, 0)
    : 0;

  let status: string;
  let detail: string | null = null;
  if (!narration) {
    status = t("reader.narration.none");
    detail = seen;
  } else if (state === "queued") {
    status = t("reader.narration.queued");
    detail = seen;
  } else if (state === "narrating") {
    status = `${t("reader.narration.narrating")} · ${formatPercent(progress?.fraction ?? 0, language)}`;
    const parts = [
      progress
        ? t("reader.narration.sections")
            .replace("{done}", String(progress.sectionsDone))
            .replace("{total}", String(progress.sectionsTotal))
        : null,
      progress?.activity === "loading"
        ? t("reader.narration.loading")
        : progress?.activity === "uploading"
          ? t("reader.narration.uploading")
          : progress?.etaSeconds
            ? t("reader.narration.left").replace(
                "{time}",
                formatDuration(minutes(progress.etaSeconds), t),
              )
            : null,
    ];
    detail = parts.filter(Boolean).join(" · ") || seen;
  } else if (state === "ready") {
    status = t("reader.narration.ready");
    detail = t("reader.narration.length").replace(
      "{time}",
      formatDuration(minutes(listen), t),
    );
  } else if (state === "failed") {
    status = t("reader.narration.failed");
    detail = narration.error;
  } else {
    status = t("reader.narration.outdated");
  }

  const confirming =
    confirmingIn !== null && confirmingIn === (state ?? "none");
  const canRequest = !narration || state === "failed" || state === "outdated";

  return (
    <div
      className="rd-narration"
      role="group"
      aria-label={t("reader.narration.title")}
      data-state={state ?? "none"}
      aria-busy={busy || undefined}
    >
      <div className="rd-narration-head">
        <Headphones size={18} aria-hidden="true" />
        <span className="rd-narration-title">
          {t("reader.narration.title")}
        </span>
        <span className="rd-narration-status">{status}</span>
      </div>
      {state === "narrating" ? (
        <div className="rd-narration-bar" aria-hidden="true">
          <span
            style={{
              transform: `scaleX(${Math.min(1, Math.max(0, progress?.fraction ?? 0))})`,
            }}
          />
        </div>
      ) : null}
      {detail ? <p className="rd-narration-detail">{detail}</p> : null}
      {failed ? (
        <p className="rd-narration-detail" role="status">
          {t("reader.narration.requestFailed")}
        </p>
      ) : null}

      {canRequest ? (
        <button
          type="button"
          role="menuitem"
          className="rd-menu-item"
          disabled={busy}
          onClick={onRequest}
        >
          {narration ? (
            <RotateCcw size={18} aria-hidden="true" />
          ) : (
            <Headphones size={18} aria-hidden="true" />
          )}
          {narration
            ? t("reader.narration.retry")
            : t("reader.narration.create")}
        </button>
      ) : null}
      {narration ? (
        <button
          type="button"
          role="menuitem"
          className="rd-menu-item"
          data-danger={confirming || undefined}
          disabled={busy}
          onClick={() => {
            if (confirming) onRemove();
            else setConfirmingIn(state ?? "none");
          }}
        >
          <Trash2 size={18} aria-hidden="true" />
          {confirming
            ? t("reader.narration.confirm")
            : state === "queued" || state === "narrating"
              ? t("reader.narration.cancel")
              : t("reader.narration.remove")}
        </button>
      ) : null}
    </div>
  );
}
