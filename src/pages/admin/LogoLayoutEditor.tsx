import { useCallback, useRef, useState, type PointerEvent } from "react";
import {
  LOGO_NUDGE_STEP,
  clampLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
  moveLogoLayout,
  resizeLogoLayout,
  type LogoLayout,
  type ResizeCorner,
} from "../../lib/logoLayout";
import { useLanguage } from "../../i18n/LanguageContext";

interface LogoLayoutEditorProps {
  posterUrl: string;
  logoUrl: string;
  title: string;
  layout: LogoLayout;
  onChange: (layout: LogoLayout) => void;
  disabled?: boolean;
  /**
   * When false, the outline and corner handles stay out of the picture until a
   * drag or resize is under way, so the card can be judged as it will be shown.
   * The corners keep their hit areas and resize cursors while hidden.
   */
  showGuides?: boolean;
}

const CORNERS: ResizeCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

const CORNER_CLASSES: Record<ResizeCorner, string> = {
  "top-left": "-left-1.5 -top-1.5 cursor-nwse-resize",
  "top-right": "-right-1.5 -top-1.5 cursor-nesw-resize",
  "bottom-left": "-bottom-1.5 -left-1.5 cursor-nesw-resize",
  "bottom-right": "-bottom-1.5 -right-1.5 cursor-nwse-resize",
};

/**
 * Direct manipulation of a logo over the card it will actually appear on.
 *
 * Presets could only ever approximate: a logo that reads at the foot of one
 * poster lands on a face on the next, and how large it should be depends on how
 * busy the artwork behind it is. Both are judgements about a specific picture,
 * so they are made by looking at that picture.
 */
export function LogoLayoutEditor({
  posterUrl,
  logoUrl,
  title,
  layout,
  onChange,
  disabled = false,
  showGuides = true,
}: LogoLayoutEditorProps) {
  const { t } = useLanguage();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [activeGesture, setActiveGesture] = useState<
    "move" | ResizeCorner | null
  >(null);
  const guidesVisible = showGuides || activeGesture !== null;
  const shadowFrame = getLogoShadowFrameStyle(layout.shadow);
  const shadowBackdropStyle = getLogoShadowBackdropStyle(layout.shadow);

  /**
   * The gesture reads from a ref rather than from props, because a pointer move
   * fires far more often than React re-renders and each one has to build on the
   * previous position rather than on whatever was last painted.
   */
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    layout: LogoLayout;
  } | null>(null);

  const cardBounds = useCallback(() => {
    const rect = cardRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const beginGesture = useCallback(
    (event: PointerEvent<HTMLElement>, gesture: "move" | ResizeCorner) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gestureRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        layout,
      };
      setActiveGesture(gesture);
    },
    [disabled, layout],
  );

  const continueGesture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || !activeGesture) return;

      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      onChange(
        activeGesture === "move"
          ? moveLogoLayout(gesture.layout, deltaX, deltaY, cardBounds())
          : resizeLogoLayout(
              gesture.layout,
              activeGesture,
              deltaX,
              cardBounds(),
            ),
      );
    },
    [activeGesture, cardBounds, onChange],
  );

  const endGesture = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    setActiveGesture(null);
  }, []);

  /** Keyboard nudging, so placement does not require a pointer at all. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (disabled) return;

      const step = event.shiftKey ? LOGO_NUDGE_STEP * 5 : LOGO_NUDGE_STEP;
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = moves[event.key];

      if (move) {
        event.preventDefault();
        onChange(
          clampLogoLayout({
            ...layout,
            x: layout.x + move[0],
            y: layout.y + move[1],
          }),
        );
        return;
      }

      if (event.key === "+" || event.key === "=" || event.key === "-") {
        event.preventDefault();
        const direction = event.key === "-" ? -1 : 1;
        onChange(
          clampLogoLayout({
            ...layout,
            width: layout.width + direction * LOGO_NUDGE_STEP * 2,
          }),
        );
      }
    },
    [disabled, layout, onChange],
  );

  return (
    <div
      ref={cardRef}
      className="relative aspect-[2/3] w-full max-w-[18rem] select-none overflow-hidden rounded-xl border border-white/10 bg-zinc-900"
    >
      <img
        src={posterUrl}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Nothing over the artwork: the card has no scrim, so a preview with one
          would show the logo more legible than it will ever be. */}

      {/* Padded by the shadow's reach so a layer made of it holds the whole
          shadow (see getLogoLayoutStyle); the handle inside is the logo's
          own box, and the only part that takes the pointer. */}
      <div
        style={getLogoLayoutStyle(layout, getLogoShadowReach(layout.shadow))}
        className="pointer-events-none absolute"
      >
        <div
          role="application"
          tabIndex={disabled ? -1 : 0}
          aria-label={t("logoLayout.dragHandleLabel")}
          onPointerDown={(event) => beginGesture(event, "move")}
          onPointerMove={continueGesture}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onKeyDown={handleKeyDown}
          className={`pointer-events-auto relative flow-root touch-none outline-none ring-offset-2 ring-offset-black focus-visible:ring-2 focus-visible:ring-sky-300 ${
            disabled ? "cursor-default" : "cursor-move"
          } ${
            activeGesture
              ? "ring-2 ring-sky-300"
              : guidesVisible
                ? "ring-1 ring-white/30"
                : ""
          }`}
        >
          {shadowBackdropStyle ? (
            <span
              aria-hidden="true"
              data-logo-shadow-backdrop="true"
              style={shadowBackdropStyle}
              className="pointer-events-none absolute inset-[6%] rounded-[45%]"
            />
          ) : null}

          <div
            data-logo-shadow="true"
            style={shadowFrame}
            className="pointer-events-none relative z-10"
          >
            <img
              src={logoUrl}
              alt={title}
              draggable={false}
              className="block h-auto w-full object-contain"
            />
          </div>

          {!disabled
            ? CORNERS.map((corner) => (
                <span
                  key={corner}
                  role="presentation"
                  data-logo-guide="corner"
                  onPointerDown={(event) => beginGesture(event, corner)}
                  onPointerMove={continueGesture}
                  onPointerUp={endGesture}
                  onPointerCancel={endGesture}
                  className={`absolute z-20 h-3 w-3 touch-none rounded-full border border-black/60 bg-sky-300 ${
                    guidesVisible ? "" : "opacity-0"
                  } ${CORNER_CLASSES[corner]}`}
                />
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
