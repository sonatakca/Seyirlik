import { useState, type ReactNode } from "react";
import { Check, ImageOff, Pause, RotateCcw } from "lucide-react";
import { LoadingRing } from "../LoadingRing";
import { formatTime } from "./PlayerControls";
import type { FrameCapture } from "./useFrameCapture";
import type { TranslationKey } from "../../i18n/translations";

/**
 * The save-frame toast: a small print that drops from under the camera
 * button. While the server reads the frame its slot is an empty plate; the
 * saved PNG itself then develops in that slot, so what the viewer sees is the
 * file they now have, at its true shape and with its true size beside it.
 */
export function FrameCaptureToast({
  capture,
  leaving,
  onRetry,
  t,
}: {
  capture: FrameCapture;
  leaving: boolean;
  onRetry: () => void;
  t: (key: TranslationKey) => string;
}) {
  const [size, setSize] = useState<{ id: number; label: string } | null>(null);
  const at = "atSeconds" in capture ? formatTime(capture.atSeconds) : null;

  let title: string;
  let meta: ReactNode;
  switch (capture.status) {
    case "pause-first":
      title = t("player.saveFramePauseFirst");
      meta = t("player.saveFramePauseFirstDetail");
      break;
    case "saving":
      title = t("player.saveFrameSaving");
      meta = `${at} · ${t("player.saveFrameFullResolution")}`;
      break;
    case "saved":
      title = t("player.saveFrameSaved");
      meta =
        size?.id === capture.id ? `${at} · ${size.label}` : (at ?? undefined);
      break;
    case "failed":
      title = t("player.saveFrameFailed");
      meta = (
        <button
          type="button"
          className="frame-capture-retry"
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
        >
          <RotateCcw size={11} strokeWidth={2.6} aria-hidden="true" />
          {t("player.saveFrameRetry")}
        </button>
      );
      break;
  }

  return (
    <div className="frame-capture-anchor" role="status" aria-live="polite">
      <div
        key={capture.id}
        data-status={capture.status}
        className={`frame-capture ${leaving ? "frame-capture-leaving" : "frame-capture-entering"}`}
      >
        <span className="frame-capture-plate" aria-hidden="true">
          {capture.status === "saved" ? (
            <img
              src={capture.imageUrl}
              alt=""
              className="frame-capture-print"
              onLoad={(event) => {
                const image = event.currentTarget;
                setSize({
                  id: capture.id,
                  label: `${image.naturalWidth} × ${image.naturalHeight}`,
                });
              }}
            />
          ) : capture.status === "saving" ? (
            <LoadingRing size={18} stroke={2} />
          ) : capture.status === "failed" ? (
            <ImageOff size={17} strokeWidth={2.2} />
          ) : (
            <Pause size={15} strokeWidth={2.4} fill="currentColor" />
          )}
        </span>

        <span key={capture.status} className="frame-capture-copy">
          <span className="frame-capture-title">
            {capture.status === "saved" ? (
              <Check
                size={13}
                strokeWidth={3}
                className="frame-capture-check"
                aria-hidden="true"
              />
            ) : null}
            <span className="truncate">{title}</span>
          </span>
          <span className="frame-capture-meta">{meta}</span>
        </span>
      </div>
    </div>
  );
}
