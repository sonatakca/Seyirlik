import { useEffect, useRef, useState } from "react";
import {
  QUALITY_TOAST_TIMING,
  classifyQualityChange,
  type PlayingQuality,
  type QualityChange,
} from "./qualityToastModel";

interface ShownChange {
  change: QualityChange;
  leaving: boolean;
}

/** How long a change stays up: the same hold after the swap, however soon the swap began. */
function visibleMsFor(change: QualityChange) {
  const { visibleMs, swapAtMs, continuedSwapAtMs } = QUALITY_TOAST_TIMING;
  if (change.kind === "start") return visibleMs;
  return change.continued
    ? visibleMs - (swapAtMs - continuedSwapAtMs)
    : visibleMs;
}

/**
 * Watches the quality on screen and turns each change into a toast.
 *
 * The baseline survives the quality briefly becoming unknown — a re-attach
 * for an audio track reports nothing for a moment and then the same rung, and
 * that must not announce itself as a fresh start. It resets only when the
 * title does.
 */
export function useQualityChangeToast(
  itemId: string,
  playing: PlayingQuality | null,
  suppressed: boolean,
) {
  const [shown, setShown] = useState<ShownChange | null>(null);
  const baselineRef = useRef<{
    itemId: string;
    quality: PlayingQuality | null;
  }>({ itemId, quality: null });
  const nextIdRef = useRef(1);

  const playingId = playing?.id;
  const playingHeight = playing?.height;
  const playingHdr = playing?.hdr;

  useEffect(() => {
    if (baselineRef.current.itemId !== itemId) {
      baselineRef.current = { itemId, quality: null };
      setShown(null);
    }
    if (
      playingId === undefined ||
      playingHeight === undefined ||
      playingHdr === undefined
    ) {
      return;
    }
    const next = { id: playingId, height: playingHeight, hdr: playingHdr };
    const previous = baselineRef.current.quality;
    if (previous?.id === next.id) return;
    baselineRef.current.quality = next;

    const kind = classifyQualityChange(previous, next);
    if (!kind || suppressed) return;
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setShown((current) => ({
      change: {
        id,
        kind,
        from: previous,
        to: next,
        continued: current !== null && !current.leaving,
      },
      leaving: false,
    }));
  }, [itemId, playingId, playingHeight, playingHdr, suppressed]);

  useEffect(() => {
    if (!shown) return undefined;
    const { id } = shown.change;
    const delay = shown.leaving
      ? QUALITY_TOAST_TIMING.exitMs
      : // The skip button or next-episode card arrived: give them the corner now.
        suppressed
        ? 0
        : visibleMsFor(shown.change);
    const timer = window.setTimeout(
      () =>
        setShown((current) => {
          if (current?.change.id !== id) return current;
          return current.leaving ? null : { ...current, leaving: true };
        }),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [shown, suppressed]);

  return shown;
}
