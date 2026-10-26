import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { ReadAlong } from "./readAlong";

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

/**
 * The read-along's player, and the way back to the voice after scrolling
 * away from it. Built from the reader's ink, not the accent colour. The time
 * and the scrub bar are written each frame straight to the elements, so the
 * reader page never renders for them.
 */
export function ReaderVoice({ voice }: { voice: ReadAlong }) {
  const { t, language } = useLanguage();
  const state = useSyncExternalStore(voice.subscribe, voice.getState);
  const nowRef = useRef<HTMLSpanElement | null>(null);
  const leftRef = useRef<HTMLSpanElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!state.engaged) return undefined;
    let frame = 0;
    let shown = "";
    const tick = () => {
      const duration = Math.max(1, state.duration);
      const time = Math.min(voice.time, duration);
      const share = time / duration;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${share})`;
      if (knobRef.current) knobRef.current.style.left = `${share * 100}%`;
      const text = `${clock(time)}|${clock(duration - time)}`;
      if (text !== shown) {
        shown = text;
        if (nowRef.current) nowRef.current.textContent = clock(time);
        if (leftRef.current)
          leftRef.current.textContent = `−${clock(duration - time)}`;
        trackRef.current?.setAttribute(
          "aria-valuenow",
          String(Math.round(share * 100)),
        );
        trackRef.current?.setAttribute("aria-valuetext", clock(time));
      }
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => window.cancelAnimationFrame(frame);
  }, [state.duration, state.engaged, voice]);

  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    voice.seekFraction((event.clientX - box.left) / Math.max(1, box.width));
  };
  const scrubKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    voice.seekFraction((voice.time + step) / Math.max(1, state.duration));
  };
  const rate = `${String(state.rate).replace(".", language === "tr" ? "," : ".")}×`;

  return (
    <>
      <button
        type="button"
        className="rd-voice-return"
        data-on={state.engaged && state.away ? "" : undefined}
        data-direction={state.away ?? "down"}
        tabIndex={state.engaged && state.away ? 0 : -1}
        aria-hidden={!(state.engaged && state.away)}
        onClick={() => voice.follow()}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M8 12.5V3.5M4 7.5l4-4 4 4" />
        </svg>
        <span>{t("reader.voice.return")}</span>
      </button>

      <div
        className="rd-voice"
        role="region"
        aria-label={t("reader.voice.player")}
        data-on={state.engaged ? "" : undefined}
        data-playing={state.playing ? "" : undefined}
        // React 18 knows no `inert`; written as a plain attribute it still works.
        {...(state.engaged ? {} : ({ inert: "" } as Record<string, string>))}
      >
        <button
          type="button"
          className="rd-voice-button"
          aria-label={t("reader.voice.previous")}
          onClick={() => voice.seekSentence(-1)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6.5v11L10 12z" />
            <path d="M6 6.5v11" />
          </svg>
        </button>
        <button
          type="button"
          className="rd-voice-button rd-voice-play"
          aria-label={
            state.playing ? t("reader.voice.pause") : t("reader.voice.play")
          }
          onClick={() => voice.toggle()}
        >
          {state.playing ? (
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <rect x="4.5" y="3.5" width="3.6" height="13" rx="1.2" />
              <rect x="11.9" y="3.5" width="3.6" height="13" rx="1.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.2 3.6c-.66-.4-1.2-.08-1.2.69v11.42c0 .77.54 1.09 1.2.69l9.32-5.71c.64-.39.64-1.03 0-1.42z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="rd-voice-button"
          aria-label={t("reader.voice.next")}
          onClick={() => voice.seekSentence(1)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 6.5v11l8-5.5z" />
            <path d="M18 6.5v11" />
          </svg>
        </button>
        <div className="rd-voice-time">
          <span ref={nowRef} className="rd-voice-now">
            0:00
          </span>
          <div
            ref={trackRef}
            className="rd-voice-track"
            role="slider"
            tabIndex={0}
            aria-label={t("reader.voice.position")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              draggingRef.current = true;
              event.currentTarget.dataset.dragging = "";
              scrub(event);
            }}
            onPointerMove={(event) => {
              if (draggingRef.current) scrub(event);
            }}
            onPointerUp={(event) => {
              draggingRef.current = false;
              delete event.currentTarget.dataset.dragging;
            }}
            onPointerCancel={(event) => {
              draggingRef.current = false;
              delete event.currentTarget.dataset.dragging;
            }}
            onKeyDown={scrubKey}
          >
            <div ref={fillRef} className="rd-voice-fill" />
            <div ref={knobRef} className="rd-voice-knob" />
          </div>
          <span ref={leftRef} className="rd-voice-left">
            −{clock(state.duration)}
          </span>
        </div>
        <button
          type="button"
          className="rd-voice-rate"
          aria-label={t("reader.voice.rate")}
          onClick={() => voice.nextRate()}
        >
          {rate}
        </button>
        <button
          type="button"
          className="rd-voice-button rd-voice-close"
          aria-label={t("reader.voice.close")}
          onClick={() => voice.close()}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
