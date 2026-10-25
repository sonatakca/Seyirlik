import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { fetchOriginalFrame } from "../../lib/mediaApi";

/** How long each outcome stays up; saving is held until it has one. */
const SHOWN_MS = {
  "pause-first": 3200,
  saved: 4600,
  // Long enough to reach Try again.
  failed: 7000,
} as const;

/** The exit animation's length, so the toast is removed after it, not during. */
export const FRAME_CAPTURE_EXIT_MS = 280;

/** Finder and Explorer both refuse these characters in a file name. */
function toFileSafeName(name: string | null | undefined): string {
  const safeName = (name ?? "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return safeName || "Seyirlik";
}

/** `1-04-44` rather than `1:04:44`, which Finder shows with slashes. */
function formatFrameTimestamp(seconds: number): string {
  const wholeSeconds = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(wholeSeconds / 3600)}-${pad(
    Math.floor((wholeSeconds % 3600) / 60),
  )}-${pad(wholeSeconds % 60)}`;
}

/**
 * Hands a blob to the browser's download flow. The object URL is revoked
 * later rather than at once, because Safari may read it after the click
 * handler has returned.
 */
function saveBlobToDevice(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

interface FrameCaptureOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  playSessionId: string | undefined;
  itemName: string | null | undefined;
  revealPlayerChrome: () => void;
}

/**
 * What the frame toast is showing. Each press gets a new id, so a second save
 * replays the entrance rather than editing the first one in place.
 */
export type FrameCapture =
  | { id: number; status: "pause-first" }
  | { id: number; status: "saving"; atSeconds: number }
  | { id: number; status: "saved"; atSeconds: number; imageUrl: string }
  | { id: number; status: "failed"; atSeconds: number };

/** Saving the paused frame at the original's full resolution, and saying how it went. */
export function useFrameCapture({
  videoRef,
  playSessionId,
  itemName,
  revealPlayerChrome,
}: FrameCaptureOptions) {
  const [capture, setCapture] = useState<FrameCapture | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [isSavingFrame, setIsSavingFrame] = useState(false);
  const nextIdRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  // The saved still shown in the toast; a URL of its own, apart from the download's.
  const imageUrlRef = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const releaseImage = useCallback(() => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
  }, []);

  const show = useCallback(
    (next: FrameCapture) => {
      clearTimers();
      if (next.status !== "saved") releaseImage();
      setLeaving(false);
      setCapture(next);
      if (next.status === "saving") return;
      timersRef.current.push(
        window.setTimeout(() => {
          setLeaving(true);
          timersRef.current.push(
            window.setTimeout(() => {
              setCapture(null);
              setLeaving(false);
              releaseImage();
            }, FRAME_CAPTURE_EXIT_MS),
          );
        }, SHOWN_MS[next.status]),
      );
    },
    [clearTimers, releaseImage],
  );

  useEffect(
    () => () => {
      clearTimers();
      releaseImage();
    },
    [clearTimers, releaseImage],
  );

  /**
   * Saves the paused frame from the original file rather than from the
   * element: the element holds whichever quality rung Auto chose, and in
   * Safari it streams from another origin, so its pixels cannot be exported.
   * Refused while playing, because the picture moves on before the capture
   * returns and the viewer would get a frame they never chose.
   */
  const handleSaveFrame = useCallback(async () => {
    revealPlayerChrome();
    if (isSavingFrame) return;
    const id = ++nextIdRef.current;

    const video = videoRef.current;
    if (!video || !video.paused) {
      show({ id, status: "pause-first" });
      return;
    }

    const atSeconds = Math.max(0, video.currentTime);
    const sessionId = playSessionId;
    if (!sessionId) {
      show({ id, status: "failed", atSeconds });
      return;
    }

    setIsSavingFrame(true);
    // Held until the capture answers: a 4K HEVC frame can take a few seconds.
    show({ id, status: "saving", atSeconds });

    try {
      const frame = await fetchOriginalFrame(sessionId, atSeconds);
      saveBlobToDevice(
        frame,
        `${toFileSafeName(itemName)} ${formatFrameTimestamp(atSeconds)}.png`,
      );
      releaseImage();
      const imageUrl = URL.createObjectURL(frame);
      imageUrlRef.current = imageUrl;
      show({ id, status: "saved", atSeconds, imageUrl });
    } catch (frameError) {
      console.warn("[Seyirlik Player] Could not save the frame", frameError);
      show({ id, status: "failed", atSeconds });
    } finally {
      setIsSavingFrame(false);
    }
  }, [
    playSessionId,
    isSavingFrame,
    itemName,
    releaseImage,
    revealPlayerChrome,
    show,
    videoRef,
  ]);

  return { capture, leaving, isSavingFrame, handleSaveFrame };
}
