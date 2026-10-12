import {
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getItemTrickplayImageUrl } from "../../lib/mediaApi";

interface SeekBarProps {
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  itemId: string;
  mediaSourceId?: string;
  checkpointSeconds?: number | null;
  previewAspectRatio?: number;
  onSeek: (seconds: number) => void;
  onSeekPreview?: (seconds: number) => void;
  /** The scrub ended without a seek, so its preview should go. */
  onSeekPreviewCancel?: () => void;
  pointerAxis?: SeekPointerAxis;
  compactPreview?: boolean;
}

export type SeekPointerAxis =
  | "horizontal"
  | "vertical-forward"
  | "vertical-reverse";

interface HoverPreviewState {
  isVisible: boolean;
  percent: number;
  seconds: number;
  displaySeconds: number;
}

const TRICKPLAY_INTERVAL_SECONDS = 10;

const TRICKPLAY_COLUMNS = 10;
const TRICKPLAY_ROWS = 10;
const TRICKPLAY_IMAGES_PER_SHEET = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;

const SEEK_DRAG_THRESHOLD_PX = 6;
const SEEK_TRACK_HIT_SLOP_PX = 10;
const SEEK_HOVER_RANGE_OVERLAP_PERCENT = 0.35;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getDisplaySeekPoint(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || duration <= 0) {
    return 0;
  }

  return clamp(seconds, 0, duration);
}

function getSafeSeekTargetSeconds(
  displaySeconds: number,
  duration: number,
): number {
  if (!Number.isFinite(displaySeconds) || duration <= 0) {
    return 0;
  }

  return clamp(displaySeconds, 0, duration);
}

function getSpritePositionPercent(index: number, count: number): number {
  if (count <= 1) {
    return 0;
  }

  return (index / (count - 1)) * 100;
}

export function SeekBar({
  currentTime,
  duration,
  bufferedEnd,
  itemId,
  mediaSourceId,
  checkpointSeconds = null,
  previewAspectRatio,
  onSeek,
  onSeekPreview,
  onSeekPreviewCancel,
  pointerAxis = "horizontal",
  compactPreview = false,
}: SeekBarProps) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerDownSeekStateRef = useRef<HoverPreviewState | null>(null);
  const pointerStartRef = useRef<{
    pointerId: number;
    axisCoordinate: number;
    didPassDragThreshold: boolean;
  } | null>(null);

  const [isSeeking, setIsSeeking] = useState(false);
  const [loadedTrickplayImageUrl, setLoadedTrickplayImageUrl] = useState<
    string | null
  >(null);
  const [brokenTrickplayImageUrls, setBrokenTrickplayImageUrls] = useState<
    Set<string>
  >(() => new Set());

  const [hoverPreview, setHoverPreview] = useState<HoverPreviewState>({
    isVisible: false,
    percent: 0,
    seconds: 0,
    displaySeconds: 0,
  });

  const previewSeconds = isSeeking ? hoverPreview.displaySeconds : currentTime;
  const playedPercent =
    duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0;
  const progressPercent =
    duration > 0 ? clamp((previewSeconds / duration) * 100, 0, 100) : 0;
  const bufferedPercent =
    duration > 0 ? clamp((bufferedEnd / duration) * 100, 0, 100) : 0;
  const hoverRangeStartPercent =
    hoverPreview.isVisible && hoverPreview.percent > playedPercent
      ? clamp(
          playedPercent - SEEK_HOVER_RANGE_OVERLAP_PERCENT,
          0,
          hoverPreview.percent,
        )
      : playedPercent;
  const hoverRangeWidthPercent =
    duration > 0
      ? Math.max(0, hoverPreview.percent - hoverRangeStartPercent)
      : 0;
  const isHoverRangeVisible =
    hoverPreview.isVisible && hoverRangeWidthPercent > 0.25;
  const previewImageWrapStyle =
    typeof previewAspectRatio === "number" &&
    Number.isFinite(previewAspectRatio) &&
    previewAspectRatio > 0
      ? { aspectRatio: String(previewAspectRatio) }
      : undefined;
  const checkpointPercent =
    checkpointSeconds !== null &&
    Number.isFinite(checkpointSeconds) &&
    Number.isFinite(duration) &&
    duration > 0
      ? clamp((checkpointSeconds / duration) * 100, 0, 100)
      : null;

  const getPointerAxisCoordinate = (clientX: number, clientY: number) =>
    pointerAxis === "horizontal" ? clientX : clientY;

  const isPointerInsideVisibleTrack = (
    clientX: number,
    clientY: number,
  ): boolean => {
    const trackBounds = trackRef.current?.getBoundingClientRect();

    if (!trackBounds) {
      return false;
    }

    return (
      clientX >= trackBounds.left &&
      clientX <= trackBounds.right &&
      clientY >= trackBounds.top - SEEK_TRACK_HIT_SLOP_PX &&
      clientY <= trackBounds.bottom + SEEK_TRACK_HIT_SLOP_PX
    );
  };

  const getPointerSeekState = (
    clientX: number,
    clientY: number,
  ): HoverPreviewState | null => {
    const bounds = rootRef.current?.getBoundingClientRect();

    if (!bounds || duration <= 0) {
      return null;
    }

    const horizontalPercent = ((clientX - bounds.left) / bounds.width) * 100;
    const verticalPercent = ((clientY - bounds.top) / bounds.height) * 100;
    const rawPercent =
      pointerAxis === "horizontal"
        ? horizontalPercent
        : pointerAxis === "vertical-forward"
          ? verticalPercent
          : 100 - verticalPercent;
    const percent = clamp(rawPercent, 0, 100);
    const rawSeconds = (percent / 100) * duration;
    const displaySeconds = getDisplaySeekPoint(rawSeconds, duration);
    const seconds = getSafeSeekTargetSeconds(displaySeconds, duration);

    return {
      isVisible: true,
      percent,
      seconds,
      displaySeconds,
    };
  };

  const trickplay = useMemo(() => {
    if (!hoverPreview.isVisible || !itemId || !mediaSourceId || duration <= 0) {
      return null;
    }

    const globalTileIndex = Math.max(
      0,
      Math.floor(hoverPreview.displaySeconds / TRICKPLAY_INTERVAL_SECONDS),
    );

    const sheetIndex = Math.floor(globalTileIndex / TRICKPLAY_IMAGES_PER_SHEET);
    const tileIndexOnSheet = globalTileIndex % TRICKPLAY_IMAGES_PER_SHEET;

    const column = tileIndexOnSheet % TRICKPLAY_COLUMNS;
    const row = Math.floor(tileIndexOnSheet / TRICKPLAY_COLUMNS);

    return {
      imageUrl: getItemTrickplayImageUrl(itemId, sheetIndex),
      column,
      row,
    };
  }, [
    duration,
    hoverPreview.displaySeconds,
    hoverPreview.isVisible,
    itemId,
    mediaSourceId,
  ]);

  const hasUsableTrickplayImage = Boolean(
    trickplay?.imageUrl &&
    loadedTrickplayImageUrl === trickplay.imageUrl &&
    !brokenTrickplayImageUrls.has(trickplay.imageUrl),
  );

  const updateHoverPreview = (event: MouseEvent<HTMLDivElement>) => {
    if (!isPointerInsideVisibleTrack(event.clientX, event.clientY)) {
      hideHoverPreview();
      return;
    }

    const nextHoverPreview = getPointerSeekState(event.clientX, event.clientY);

    if (!nextHoverPreview) {
      return;
    }

    setHoverPreview(nextHoverPreview);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPointerInsideVisibleTrack(event.clientX, event.clientY)) {
      return;
    }

    const nextSeekState = getPointerSeekState(event.clientX, event.clientY);

    if (!nextSeekState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    pointerStartRef.current = {
      pointerId: event.pointerId,
      axisCoordinate: getPointerAxisCoordinate(event.clientX, event.clientY),
      didPassDragThreshold: false,
    };
    pointerDownSeekStateRef.current = nextSeekState;

    setIsSeeking(true);
    setHoverPreview(nextSeekState);
    onSeekPreview?.(nextSeekState.displaySeconds);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeeking) {
      return;
    }

    const nextSeekState = getPointerSeekState(event.clientX, event.clientY);

    if (!nextSeekState) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    setHoverPreview(nextSeekState);

    const pointerStart = pointerStartRef.current;

    if (!pointerStart || pointerStart.pointerId !== event.pointerId) {
      return;
    }

    const movedDistance = Math.abs(
      getPointerAxisCoordinate(event.clientX, event.clientY) -
        pointerStart.axisCoordinate,
    );

    if (
      !pointerStart.didPassDragThreshold &&
      movedDistance < SEEK_DRAG_THRESHOLD_PX
    ) {
      return;
    }

    pointerStart.didPassDragThreshold = true;
    pointerDownSeekStateRef.current = nextSeekState;
    onSeekPreview?.(nextSeekState.displaySeconds);
  };

  const finishPointerSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSeeking) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const pointerStart = pointerStartRef.current;
    const nextSeekState = pointerStart?.didPassDragThreshold
      ? (getPointerSeekState(event.clientX, event.clientY) ??
        pointerDownSeekStateRef.current)
      : pointerDownSeekStateRef.current;

    if (nextSeekState) {
      setHoverPreview(nextSeekState);
      onSeekPreview?.(nextSeekState.displaySeconds);
      onSeek(nextSeekState.seconds);
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerStartRef.current = null;
    pointerDownSeekStateRef.current = null;
    setIsSeeking(false);
  };

  const cancelPointerSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pointerStartRef.current = null;
    pointerDownSeekStateRef.current = null;
    setIsSeeking(false);
    onSeekPreviewCancel?.();
  };

  const hideHoverPreview = () => {
    if (isSeeking) {
      return;
    }

    setHoverPreview((current) => ({
      ...current,
      isVisible: false,
    }));
  };

  const previewLeftPercent = clamp(
    hoverPreview.percent,
    compactPreview ? 11 : 6,
    compactPreview ? 89 : 94,
  );

  return (
    <div
      ref={rootRef}
      className="relative h-7 w-full touch-none"
      onMouseMove={updateHoverPreview}
      onMouseEnter={updateHoverPreview}
      onMouseLeave={hideHoverPreview}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerSeek}
      onPointerCancel={cancelPointerSeek}
      role="slider"
      tabIndex={0}
      aria-label={t("player.seek")}
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={Math.min(currentTime, duration || 0)}
      onKeyDown={(event) => {
        if (duration <= 0) {
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          const displaySeconds = getDisplaySeekPoint(currentTime - 5, duration);
          onSeek(getSafeSeekTargetSeconds(displaySeconds, duration));
        }

        if (event.key === "ArrowRight") {
          event.preventDefault();
          const displaySeconds = getDisplaySeekPoint(currentTime + 5, duration);
          onSeek(getSafeSeekTargetSeconds(displaySeconds, duration));
        }
      }}
    >
      {hoverPreview.isVisible && duration > 0 ? (
        <div
          className={`seyirlik-trickplay-preview ${
            hasUsableTrickplayImage
              ? ""
              : "seyirlik-trickplay-preview--timeOnly"
          } ${compactPreview ? "seyirlik-trickplay-preview--compact" : ""}`}
          style={{ left: `${previewLeftPercent}%` }}
        >
          <div
            className="seyirlik-trickplay-preview__imageWrap"
            style={previewImageWrapStyle}
          >
            {trickplay?.imageUrl ? (
              <>
                <img
                  src={trickplay.imageUrl}
                  alt=""
                  className="hidden"
                  onLoad={() => {
                    setLoadedTrickplayImageUrl(trickplay.imageUrl);
                    setBrokenTrickplayImageUrls((currentUrls) => {
                      if (!currentUrls.has(trickplay.imageUrl)) {
                        return currentUrls;
                      }

                      const nextUrls = new Set(currentUrls);
                      nextUrls.delete(trickplay.imageUrl);
                      return nextUrls;
                    });
                  }}
                  onError={() => {
                    setLoadedTrickplayImageUrl((currentUrl) =>
                      currentUrl === trickplay.imageUrl ? null : currentUrl,
                    );
                    setBrokenTrickplayImageUrls((currentUrls) => {
                      if (currentUrls.has(trickplay.imageUrl)) {
                        return currentUrls;
                      }

                      const nextUrls = new Set(currentUrls);
                      nextUrls.add(trickplay.imageUrl);
                      return nextUrls;
                    });
                  }}
                />

                {hasUsableTrickplayImage ? (
                  <div
                    className="seyirlik-trickplay-preview__image"
                    style={{
                      backgroundImage: `url("${trickplay.imageUrl}")`,
                      backgroundSize: `${TRICKPLAY_COLUMNS * 100}% ${
                        TRICKPLAY_ROWS * 100
                      }%`,
                      backgroundPosition: `${getSpritePositionPercent(
                        trickplay.column,
                        TRICKPLAY_COLUMNS,
                      )}% ${getSpritePositionPercent(
                        trickplay.row,
                        TRICKPLAY_ROWS,
                      )}%`,
                      backgroundRepeat: "no-repeat",
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>

          <div className="seyirlik-trickplay-preview__time">
            {formatTime(hoverPreview.displaySeconds)}
          </div>

          {/* <span className="seyirlik-trickplay-preview__pointer" /> */}
        </div>
      ) : null}

      <div
        aria-hidden="true"
        className="absolute left-0 right-0 top-1/2 z-[64] h-[26px] -translate-y-1/2 cursor-pointer"
      />

      <div
        ref={trackRef}
        className="absolute left-0 right-0 top-1/2 z-[60] h-1.5 -translate-y-1/2 cursor-pointer overflow-hidden rounded-full bg-white/20"
      >
        <div
          className="pointer-events-none h-full rounded-full bg-white/30"
          style={{ width: `${bufferedPercent}%` }}
        />
      </div>

      {duration > 0 ? (
        <div
          className="pointer-events-none absolute top-1/2 z-[61] h-1.5 -translate-y-1/2 rounded-full bg-white/50 opacity-0 transition-opacity duration-150 ease-out"
          style={{
            left: `${hoverRangeStartPercent}%`,
            width: `${hoverRangeWidthPercent}%`,
            opacity: isHoverRangeVisible ? 1 : 0,
          }}
        />
      ) : null}

      <div
        className="pointer-events-none absolute left-0 top-1/2 z-[62] h-1.5 -translate-y-1/2 rounded-full bg-[var(--accent)]"
        style={{ width: `${progressPercent}%` }}
      />

      {checkpointPercent !== null ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 z-[63] h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]"
          style={{ left: `${checkpointPercent}%` }}
        />
      ) : null}
    </div>
  );
}
