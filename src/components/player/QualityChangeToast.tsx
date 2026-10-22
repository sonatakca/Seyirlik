import { useLayoutEffect, useRef, type Ref } from "react";
import { ArrowDown, ArrowUp, Play } from "lucide-react";
import {
  QUALITY_TOAST_TIMING,
  formatQualityHeight,
  swapFrameAt,
  type LinePaint,
  type PlayingQuality,
  type QualityChange,
} from "./qualityToastModel";

function applyLine(line: HTMLElement | null, paint: LinePaint) {
  if (!line) return;
  line.style.transform = `scale(${paint.scale})`;
  const value = line.querySelector<HTMLElement>("[data-quality-value]");
  if (value) value.style.backgroundImage = paint.backgroundImage;
  const hdr = line.querySelector<HTMLElement>("[data-quality-hdr]");
  if (hdr) hdr.style.color = `rgba(255,255,255,${paint.hdrAlpha.toFixed(3)})`;
}

function QualityLine({
  quality,
  lineRef,
}: {
  quality: PlayingQuality;
  lineRef?: Ref<HTMLSpanElement>;
}) {
  return (
    <span ref={lineRef} className="quality-toast-line">
      <span data-quality-value className="quality-toast-value">
        {formatQualityHeight(quality)}
      </span>
      {quality.hdr ? (
        <span data-quality-hdr className="quality-toast-hdr">
          HDR
        </span>
      ) : null}
    </span>
  );
}

/**
 * The toast itself. Enter and exit are CSS animations; the swap — the light
 * travelling between the values, the values trading size, the arrow leaving
 * the ring — is painted per frame from `swapFrameAt`, because a light that
 * lives only inside the glyphs is a gradient clipped to text, and that
 * gradient has to be recomputed as it moves.
 */
export function QualityChangeToast({
  change,
  leaving,
  reduceMotion,
  label,
}: {
  change: QualityChange;
  leaving: boolean;
  reduceMotion: boolean;
  /** What a screen reader hears; the toast itself shows only the values. */
  label: string;
}) {
  const topRef = useRef<HTMLSpanElement>(null);
  const bottomRef = useRef<HTMLSpanElement>(null);
  const arrowOutRef = useRef<HTMLSpanElement>(null);
  const arrowInRef = useRef<HTMLSpanElement>(null);
  const { kind, from, to } = change;

  useLayoutEffect(() => {
    if (kind === "start") return undefined;
    const paint = (elapsedMs: number) => {
      const frame = swapFrameAt(kind, elapsedMs);
      applyLine(topRef.current, frame.top);
      applyLine(bottomRef.current, frame.bottom);
      if (arrowOutRef.current) {
        arrowOutRef.current.style.transform = `translateY(${frame.arrowOutY}px)`;
      }
      if (arrowInRef.current) {
        arrowInRef.current.style.transform = `translateY(${frame.arrowInY}px)`;
      }
    };
    const { swapMs, swapAtMs, continuedSwapAtMs } = QUALITY_TOAST_TIMING;
    if (reduceMotion) {
      paint(swapMs);
      return undefined;
    }
    // Before the light sets off, the value that was playing is the lit one.
    paint(-swapMs);
    const swapStart =
      performance.now() + (change.continued ? continuedSwapAtMs : swapAtMs);
    let frameId = 0;
    const tick = (now: number) => {
      const elapsed = now - swapStart;
      paint(elapsed);
      if (elapsed < swapMs) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
    // One run per change; the change's id is what identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.id, reduceMotion]);

  const motionClass = leaving
    ? "quality-toast-leaving"
    : "quality-toast-entering";
  const Arrow = kind === "down" ? ArrowDown : ArrowUp;
  // The higher quality always sits on top: an upgrade reads bottom → top, a downgrade top → bottom.
  const [top, bottom] =
    kind === "up" ? [to, from] : kind === "down" ? [from, to] : [to, null];

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-[calc(max(1rem,env(safe-area-inset-bottom))+5.8rem)] right-[max(1rem,env(safe-area-inset-right))] z-40"
    >
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className={`quality-toast ${kind === "start" ? "quality-toast-single" : ""} ${motionClass}`}
      >
        <span className="quality-toast-ring">
          {kind === "start" ? (
            <span className="quality-toast-arrow">
              <Play
                size={9}
                fill="currentColor"
                strokeWidth={0}
                className="ml-px"
              />
            </span>
          ) : (
            <>
              <span ref={arrowOutRef} className="quality-toast-arrow">
                <Arrow size={12} strokeWidth={2.6} />
              </span>
              <span ref={arrowInRef} className="quality-toast-arrow">
                <Arrow size={12} strokeWidth={2.6} />
              </span>
            </>
          )}
        </span>
        <span className="quality-toast-stack">
          {top ? <QualityLine quality={top} lineRef={topRef} /> : null}
          {bottom ? <QualityLine quality={bottom} lineRef={bottomRef} /> : null}
        </span>
      </div>
    </div>
  );
}
