import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * The full-frame picture shown for a seek before the player can show the
 * real one.
 *
 * Two phases, because they mean different things to the viewer:
 * - `scrubbing`: the finger or pointer is still on the bar. Nothing is
 *   loading; the picture simply follows the bar.
 * - `landing`: the seek has been made and the element is fetching the new
 *   position. The picture stays until the real frame at that position has
 *   been painted underneath it, then dissolves into it.
 *
 * The old version hid the picture on a 3.5 s timer whatever the element was
 * doing. A seek over the tunnel routinely takes longer than that, so the
 * preview vanished onto the stale frame from before the seek — which reads as
 * a freeze even when playback is about to resume — and the same timer pulled
 * the preview from under a viewer holding the scrubber still.
 */
export type SeekPreviewPhase = "scrubbing" | "landing";

export interface SeekPreviewState {
  seconds: number;
  phase: SeekPreviewPhase;
  /**
   * Whether the picture is up. A scrub always shows it. A jump — an arrow
   * key, a skip button, a double tap — holds it back until the seek has
   * failed to land at once, so a seek into what is buffered never puts a
   * thumbnail over a frame that was about to be there anyway.
   */
  shown: boolean;
}

/** How close the element must be to the target for its frame to count. */
const LANDED_TOLERANCE_SECONDS = 1.5;

/**
 * Last resort for a landing nothing ever reports.
 *
 * Long on purpose: the preview with the loading mark is the honest picture of
 * a seek still loading, and taking it away early only swaps it for a stale
 * frame. This exists so a missed event cannot leave it up for good.
 */
const LANDING_CEILING_MS = 20_000;

/**
 * Same, for a scrub whose bar went away without a pointer-up or cancel — the
 * chrome unmounting mid-drag, for instance.
 */
const SCRUB_IDLE_CEILING_MS = 30_000;

/**
 * `requestVideoFrameCallback` only fires for a frame presented after it was
 * asked for. A paused element that presented its seeked frame a moment before
 * the request was made never presents another, so the wait is bounded.
 */
const FRAME_CALLBACK_WAIT_MS = 250;

/**
 * How long a jump may take before its preview comes up over the frame it
 * left. A buffered seek lands within a few frames; past this the old frame
 * is visibly standing still where the viewer asked to be elsewhere.
 */
export const JUMP_PREVIEW_REVEAL_MS = 120;

interface UseSeekPreviewOptions {
  videoRef: RefObject<HTMLVideoElement>;
  /** Changes when the active element is replaced (quality handoff). */
  deckEpoch: number;
  /** A new title or source starts with no preview. */
  resetKey: string;
}

export function useSeekPreview({
  videoRef,
  deckEpoch,
  resetKey,
}: UseSeekPreviewOptions) {
  const [preview, setPreview] = useState<SeekPreviewState | null>(null);
  const previewRef = useRef<SeekPreviewState | null>(null);
  const ceilingTimerRef = useRef<number | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  // Every change bumps this, so an in-flight "frame painted" wait that
  // belongs to an earlier seek cannot clear a later one.
  const generationRef = useRef(0);

  const clearCeiling = useCallback(() => {
    if (ceilingTimerRef.current !== null) {
      window.clearTimeout(ceilingTimerRef.current);
      ceilingTimerRef.current = null;
    }
  }, []);

  const clearReveal = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  const apply = useCallback(
    (next: SeekPreviewState | null) => {
      generationRef.current += 1;
      previewRef.current = next;
      setPreview(next);
      clearCeiling();
      if (!next || next.shown) clearReveal();

      if (!next) return;

      const generation = generationRef.current;
      ceilingTimerRef.current = window.setTimeout(
        () => {
          if (generationRef.current !== generation) return;
          generationRef.current += 1;
          previewRef.current = null;
          setPreview(null);
        },
        next.phase === "landing" ? LANDING_CEILING_MS : SCRUB_IDLE_CEILING_MS,
      );
    },
    [clearCeiling, clearReveal],
  );

  const showScrub = useCallback(
    (seconds: number) => {
      const current = previewRef.current;
      if (current?.phase === "scrubbing" && current.seconds === seconds) return;
      apply({ seconds, phase: "scrubbing", shown: true });
    },
    [apply],
  );

  const checkLandedRef = useRef<() => void>(() => undefined);

  const land = useCallback(
    (seconds: number) => {
      const current = previewRef.current;
      if (current?.phase === "scrubbing" || current?.shown) {
        apply({ seconds, phase: "landing", shown: true });
      } else {
        // A jump. Putting the picture up at once flashed a thumbnail over
        // the frame on every arrow press, so it waits to be needed. Presses
        // that follow before then keep the first one's deadline: a held key
        // re-seeks faster than any seek lands and would otherwise put the
        // reveal off for as long as the key is down.
        apply({ seconds, phase: "landing", shown: false });
        if (revealTimerRef.current === null) {
          revealTimerRef.current = window.setTimeout(() => {
            revealTimerRef.current = null;
            const pending = previewRef.current;
            if (pending?.phase !== "landing" || pending.shown) return;
            // Not through `apply`: the seek is the same one, and a new
            // generation would orphan a frame wait already under way.
            const revealed = { ...pending, shown: true };
            previewRef.current = revealed;
            setPreview(revealed);
          }, JUMP_PREVIEW_REVEAL_MS);
        }
      }
      // A seek to where the element already is raises no `seeked`; a paused
      // element then raises nothing at all. Look once the seek has been made.
      window.setTimeout(() => checkLandedRef.current(), 0);
    },
    [apply],
  );

  const cancel = useCallback(() => apply(null), [apply]);

  useEffect(() => {
    apply(null);
  }, [apply, resetKey]);

  useEffect(
    () => () => {
      clearCeiling();
      clearReveal();
    },
    [clearCeiling, clearReveal],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let frameWaitTimer: number | null = null;
    let frameCallbackId: number | null = null;
    let waitingForGeneration: number | null = null;
    const videoWithFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    const stopFrameWait = () => {
      if (frameWaitTimer !== null) window.clearTimeout(frameWaitTimer);
      frameWaitTimer = null;
      if (frameCallbackId !== null) {
        videoWithFrameCallback.cancelVideoFrameCallback?.(frameCallbackId);
      }
      frameCallbackId = null;
      waitingForGeneration = null;
    };

    const handleFrameReady = () => {
      const current = previewRef.current;
      if (!current || current.phase !== "landing") return;
      if (
        video.seeking ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      )
        return;
      const currentTime = Number.isFinite(video.currentTime)
        ? video.currentTime
        : 0;
      if (
        !video.ended &&
        Math.abs(currentTime - current.seconds) > LANDED_TOLERANCE_SECONDS
      ) {
        return;
      }

      // Nothing is up to dissolve: the element has the frame, and the
      // preview it was holding in reserve is no longer needed.
      if (!current.shown) {
        stopFrameWait();
        apply(null);
        return;
      }

      const generation = generationRef.current;
      // `timeupdate` keeps arriving while the wait runs; restarting the wait
      // on each one could postpone it indefinitely.
      if (waitingForGeneration === generation) return;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        stopFrameWait();
        // One more frame so the compositor has the new picture before the
        // preview starts to dissolve into it.
        window.requestAnimationFrame(() => {
          if (generationRef.current !== generation) return;
          apply(null);
        });
      };

      stopFrameWait();
      waitingForGeneration = generation;
      if (videoWithFrameCallback.requestVideoFrameCallback) {
        frameCallbackId = videoWithFrameCallback.requestVideoFrameCallback(
          () => {
            frameCallbackId = null;
            finish();
          },
        );
      }
      frameWaitTimer = window.setTimeout(finish, FRAME_CALLBACK_WAIT_MS);
    };

    checkLandedRef.current = handleFrameReady;
    video.addEventListener("seeked", handleFrameReady);
    video.addEventListener("canplay", handleFrameReady);
    video.addEventListener("playing", handleFrameReady);
    video.addEventListener("timeupdate", handleFrameReady);

    return () => {
      stopFrameWait();
      checkLandedRef.current = () => undefined;
      video.removeEventListener("seeked", handleFrameReady);
      video.removeEventListener("canplay", handleFrameReady);
      video.removeEventListener("playing", handleFrameReady);
      video.removeEventListener("timeupdate", handleFrameReady);
    };
  }, [apply, deckEpoch, videoRef]);

  return { seekPreview: preview, showScrub, land, cancel };
}

/**
 * How long a wait has to last before it is shown as loading.
 *
 * A seek into what is already buffered lands in a frame or two, and so does
 * the brief `waiting` every seek raises while playing. Showing the loading
 * mark for those flashed it on every seek: in for a frame, out again, over a
 * picture that never actually stopped.
 */
export const LOADING_REVEAL_DELAY_MS = 260;

/** True once `active` has held for `delayMs`; false the moment it stops. */
export function useLoadingReveal(
  active: boolean,
  delayMs = LOADING_REVEAL_DELAY_MS,
): boolean {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(() => setRevealed(true), delayMs);
    return () => {
      window.clearTimeout(timer);
      setRevealed(false);
    };
  }, [active, delayMs]);

  return active && revealed;
}
