import { useEffect, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import type { ReaderImage } from "./readerImage";

/** How far past its own pixels the first, fitted view may enlarge a picture. */
const MAX_FIT_UPSCALE = 3;
/** Deepest zoom: a picture's pixel drawn at most this many CSS pixels wide. */
const MAX_PIXEL_ZOOM = 4;
const TAP_ZOOM = 2.5;
const TAP_SLOP_PX = 8;
const TAP_MS = 320;
const DISMISS_DRAG_PX = 96;
/** A move's base length; longer only when an edge would outrun the budget. */
const MOVE_MS = 360;
/** No edge travels more than this per 60 fps frame on a 1080-tall window. */
const PX_PER_FRAME_AT_1080 = 84;

type View = { s: number; x: number; y: number; ground: number };
type Rect = { left: number; top: number; width: number; height: number };

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

/** Where an element inside a book's frame sits in this window's viewport. */
function viewportRectOf(element: Element): Rect | null {
  const frame = element.ownerDocument.defaultView?.frameElement;
  const inner = element.getBoundingClientRect();
  const outer = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const rect = {
    left: outer.left + inner.left,
    top: outer.top + inner.top,
    width: inner.width,
    height: inner.height,
  };
  const visible =
    rect.width > 0 &&
    rect.top + rect.height > 0 &&
    rect.top < window.innerHeight &&
    rect.left + rect.width > 0 &&
    rect.left < window.innerWidth;
  return visible ? rect : null;
}

/** Hides or shows the page's own copy of the picture. */
function setShown(element: HTMLElement, shown: boolean) {
  element.style.visibility = shown ? "" : "hidden";
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/**
 * A book's illustration enlarged over the page. It grows out of the spot it
 * occupies in the text and returns there when closed. Tap or click the
 * picture to zoom in on that point and again to fit it; pinch, ctrl-scroll or
 * the trackpad's pinch zoom freely; drag to look around; drag a fitted picture
 * down, tap beside it, or press Escape to put it back.
 */
export function ReaderImageViewer({
  image,
  label,
  closeLabel,
  onClosed,
}: {
  image: ReaderImage;
  label: string;
  closeLabel: string;
  onClosed: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const groundRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  });

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const ground = groundRef.current!;
    const picture = pictureRef.current!;
    const source = image.element;
    const returnFocus = document.activeElement as HTMLElement | null;
    const reduced = prefersReducedMotion();

    // The fitted box: the picture's own pixels, enlarged up to three times,
    // as large as the window allows with a margin. Every zoom is a transform
    // of this box from its top-left corner.
    let box = { left: 0, top: 0, width: 0, height: 0 };
    // Past this, zooming only enlarges blur. A small drawing already fitted
    // at three times its size may have little or no room left.
    let maxScale = 1;
    const layout = () => {
      const margin = window.innerWidth < 640 ? 12 : 32;
      const fit = Math.min(
        (window.innerWidth - margin * 2) / image.naturalWidth,
        (window.innerHeight - margin * 2) / image.naturalHeight,
        MAX_FIT_UPSCALE,
      );
      const width = image.naturalWidth * fit;
      const height = image.naturalHeight * fit;
      box = {
        left: (window.innerWidth - width) / 2,
        top: (window.innerHeight - height) / 2,
        width,
        height,
      };
      maxScale = Math.max(1, (MAX_PIXEL_ZOOM * image.naturalWidth) / width);
      root.dataset.zoomable = maxScale > 1.2 ? "true" : "false";
      Object.assign(picture.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    };

    let view: View = { s: 1, x: 0, y: 0, ground: 0 };
    let closing = false;
    let frame = 0;

    const apply = (next: View) => {
      view = next;
      picture.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.s})`;
      ground.style.opacity = String(next.ground);
      root.dataset.zoomed = next.s > 1.01 ? "true" : "false";
    };

    // The view that puts the fitted box exactly over a rectangle on screen.
    const viewOver = (rect: Rect, ground: number): View => ({
      s: rect.width / box.width,
      x: rect.left - box.left,
      y: rect.top - box.top,
      ground,
    });

    // Bounds for a scale: a picture narrower than the window stays centred,
    // a wider one may not leave a gap at either edge.
    const clampView = (next: View): View => {
      const fit = (
        offset: number,
        size: number,
        extent: number,
        span: number,
      ) => {
        const scaled = size * next.s;
        if (scaled <= span) {
          return (size - scaled) / 2;
        }
        return Math.min(-offset, Math.max(span - offset - scaled, extent));
      };
      return {
        ...next,
        x: fit(box.left, box.width, next.x, window.innerWidth),
        y: fit(box.top, box.height, next.y, window.innerHeight),
      };
    };

    // Zoom by `factor` keeping the point under (px, py) where it is.
    const zoomAt = (
      from: View,
      scale: number,
      px: number,
      py: number,
    ): View => {
      const s = Math.min(maxScale, Math.max(1, scale));
      const contentX = (px - box.left - from.x) / from.s;
      const contentY = (py - box.top - from.y) / from.s;
      return clampView({
        ...from,
        s,
        x: px - box.left - contentX * s,
        y: py - box.top - contentY * s,
      });
    };

    // One sine in-out move, lengthened only so that no edge of the picture
    // outruns the frame budget at the curve's fastest point (π/2 × average).
    const animate = (to: View, done?: () => void, base = MOVE_MS) => {
      cancelAnimationFrame(frame);
      const from = view;
      const edge = (v: View) => [
        box.left + v.x,
        box.top + v.y,
        box.left + v.x + box.width * v.s,
        box.top + v.y + box.height * v.s,
      ];
      const a = edge(from);
      const b = edge(to);
      const travel = Math.max(
        ...a.map((value, index) => Math.abs(value - b[index])),
      );
      const budget = (PX_PER_FRAME_AT_1080 * window.innerHeight) / 1080;
      const duration = reduced
        ? 0
        : Math.max(base, ((travel * Math.PI) / 2 / budget) * (1000 / 60));

      if (duration === 0) {
        apply(to);
        done?.();
        return;
      }

      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const k = easeInOutSine(t);
        apply({
          s: from.s + (to.s - from.s) * k,
          x: from.x + (to.x - from.x) * k,
          y: from.y + (to.y - from.y) * k,
          ground: from.ground + (to.ground - from.ground) * k,
        });
        if (t < 1) {
          frame = requestAnimationFrame(step);
        } else {
          done?.();
        }
      };
      frame = requestAnimationFrame(step);
    };

    // Nothing behind the viewer may take focus while it is open.
    const behind = [...(root.parentElement?.children ?? [])].filter(
      (child) => child !== root,
    );
    behind.forEach((child) => child.setAttribute("inert", ""));
    const release = () => {
      behind.forEach((child) => child.removeAttribute("inert"));
      setShown(source, true);
    };

    const finishClose = () => {
      release();
      returnFocus?.focus?.({ preventScroll: true });
      onClosedRef.current();
    };

    const close = () => {
      if (closing) {
        return;
      }
      closing = true;
      root.dataset.closing = "true";
      const home = viewportRectOf(source);

      if (home) {
        animate(viewOver(home, 0), finishClose);
        return;
      }

      // The picture's place has gone from the screen: fade it where it is.
      picture.style.transition = reduced ? "" : "opacity 240ms linear";
      picture.style.opacity = "0";
      animate({ ...view, ground: 0 }, finishClose, 240);
    };

    layout();
    const home = viewportRectOf(source);
    if (home) {
      apply(viewOver(home, 0));
      // The page's copy steps aside, so the picture seems to lift out of it.
      setShown(source, false);
    } else {
      apply({ s: 1, x: 0, y: 0, ground: 0 });
    }
    animate({ s: 1, x: 0, y: 0, ground: 1 });
    // Focus moves in for keyboards and screen readers, without a ring
    // drawn over the corner after a tap.
    closeRef.current?.focus({
      preventScroll: true,
      focusVisible: false,
    } as FocusOptions);

    /* ---------- Pointer: tap, drag, pinch ---------- */
    const pointers = new Map<number, { x: number; y: number }>();
    let gesture:
      | {
          kind: "press";
          id: number;
          x: number;
          y: number;
          at: number;
          view: View;
          onPicture: boolean;
        }
      | { kind: "pan"; id: number; x: number; y: number; view: View }
      | {
          kind: "dismiss";
          id: number;
          x: number;
          y: number;
          at: number;
          view: View;
        }
      | { kind: "pinch"; distance: number; mx: number; my: number; view: View }
      | null = null;

    const pinchOf = () => {
      const [a, b] = [...pointers.values()];
      return {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    };

    const settle = () => {
      const target = clampView({
        ...view,
        s: Math.min(maxScale, Math.max(1, view.s)),
        ground: 1,
      });
      if (
        target.s !== view.s ||
        target.x !== view.x ||
        target.y !== view.y ||
        view.ground !== 1
      ) {
        animate(target);
      }
    };

    const onDown = (event: PointerEvent) => {
      if (closing || (event.target as Element).closest(".rd-zoom-close")) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      cancelAnimationFrame(frame);
      root.setPointerCapture?.(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 2) {
        gesture = { kind: "pinch", ...pinchOf(), view };
      } else if (pointers.size === 1) {
        gesture = {
          kind: "press",
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: performance.now(),
          view,
          onPicture: event.target === picture,
        };
      }
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || !gesture) {
        return;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (gesture.kind === "pinch" && pointers.size >= 2) {
        const now = pinchOf();
        const start = gesture.view;
        const s = Math.min(
          maxScale * 1.15,
          Math.max(0.75, (start.s * now.distance) / gesture.distance),
        );
        const contentX = (gesture.mx - box.left - start.x) / start.s;
        const contentY = (gesture.my - box.top - start.y) / start.s;
        apply({
          s,
          x: now.mx - box.left - contentX * s,
          y: now.my - box.top - contentY * s,
          ground: 1,
        });
        return;
      }

      if (gesture.kind === "pinch" || event.pointerId !== gesture.id) {
        return;
      }

      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;

      if (gesture.kind === "press") {
        if (Math.hypot(dx, dy) <= TAP_SLOP_PX) {
          return;
        }
        gesture =
          gesture.view.s > 1.01
            ? {
                kind: "pan",
                id: gesture.id,
                x: gesture.x,
                y: gesture.y,
                view: gesture.view,
              }
            : {
                kind: "dismiss",
                id: gesture.id,
                x: gesture.x,
                y: gesture.y,
                at: gesture.at,
                view: gesture.view,
              };
      }

      if (gesture.kind === "pan") {
        // Past an edge the picture follows at a third of the finger's pace.
        const free = {
          ...gesture.view,
          x: gesture.view.x + dx,
          y: gesture.view.y + dy,
        };
        const held = clampView(free);
        apply({
          ...free,
          x: held.x + (free.x - held.x) / 3,
          y: held.y + (free.y - held.y) / 3,
        });
      } else if (gesture.kind === "dismiss") {
        const pull = Math.min(1, Math.abs(dy) / (window.innerHeight * 0.45));
        apply({
          ...gesture.view,
          x: dx * 0.35,
          y: dy,
          ground: 1 - pull * 0.85,
        });
      }
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId) || !gesture) {
        return;
      }

      if (gesture.kind === "pinch") {
        if (pointers.size === 1) {
          // One finger stays: carry on as a pan from here.
          const [[id, point]] = [...pointers.entries()];
          gesture = { kind: "pan", id, x: point.x, y: point.y, view };
        } else if (pointers.size === 0) {
          gesture = null;
          settle();
        }
        return;
      }

      if (event.pointerId !== gesture.id) {
        return;
      }

      const ended = gesture;
      gesture = null;

      if (ended.kind === "press") {
        if (
          event.type === "pointercancel" ||
          performance.now() - ended.at > TAP_MS
        ) {
          return;
        }
        if (!ended.onPicture || (maxScale <= 1.2 && view.s <= 1.01)) {
          close();
        } else if (view.s > 1.01) {
          animate({ s: 1, x: 0, y: 0, ground: 1 });
        } else {
          animate({
            ...zoomAt(
              view,
              Math.min(TAP_ZOOM, maxScale),
              event.clientX,
              event.clientY,
            ),
            ground: 1,
          });
        }
        return;
      }

      if (ended.kind === "dismiss") {
        const dy = event.clientY - ended.y;
        const speed = Math.abs(dy) / Math.max(1, performance.now() - ended.at);
        if (
          event.type !== "pointercancel" &&
          (Math.abs(dy) > DISMISS_DRAG_PX || speed > 0.6)
        ) {
          close();
        } else {
          animate({ s: 1, x: 0, y: 0, ground: 1 });
        }
        return;
      }

      settle();
    };

    /* ---------- Wheel: pinch on a trackpad arrives as ctrl + wheel ---------- */
    let settleTimer = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (closing) {
        return;
      }
      cancelAnimationFrame(frame);
      const lines = event.deltaMode === 1 ? 16 : 1;
      const dx = event.deltaX * lines;
      const dy = event.deltaY * lines;

      if (event.ctrlKey || event.metaKey || view.s <= 1.01) {
        const factor = Math.exp(-dy * (event.ctrlKey ? 0.01 : 0.002));
        apply({
          ...zoomAt(view, view.s * factor, event.clientX, event.clientY),
          ground: 1,
        });
      } else {
        apply({
          ...clampView({ ...view, x: view.x - dx, y: view.y - dy }),
          ground: 1,
        });
      }
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, 140);
    };

    /* ---------- Keyboard ---------- */
    // Captured before the reader's own keys, which would otherwise scroll
    // the book underneath. Enter and Space still press the close button.
    const onKey = (event: KeyboardEvent) => {
      const middle = [window.innerWidth / 2, window.innerHeight / 2] as const;
      const zoomBy = (factor: number) =>
        animate({ ...zoomAt(view, view.s * factor, ...middle), ground: 1 });
      const panBy = (x: number, y: number) =>
        animate({
          ...clampView({ ...view, x: view.x + x, y: view.y + y }),
          ground: 1,
        });
      const keys: Record<string, () => void> = {
        Escape: close,
        "+": () => zoomBy(1.5),
        "=": () => zoomBy(1.5),
        "-": () => zoomBy(1 / 1.5),
        "0": () => animate({ s: 1, x: 0, y: 0, ground: 1 }),
        ArrowLeft: () => panBy(80, 0),
        ArrowRight: () => panBy(-80, 0),
        ArrowUp: () => panBy(0, 80),
        ArrowDown: () => panBy(0, -80),
        // The close button is the only stop: focus stays in the viewer.
        Tab: () => closeRef.current?.focus(),
        " ": () => undefined,
        PageUp: () => undefined,
        PageDown: () => undefined,
        Home: () => undefined,
        End: () => undefined,
      };
      const run = keys[event.key];
      if (!run || (event.key === " " && event.target === closeRef.current)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!closing) {
        run();
      }
    };

    const onResize = () => {
      cancelAnimationFrame(frame);
      layout();
      apply({ s: 1, x: 0, y: 0, ground: 1 });
    };

    // A touch is followed by a compatibility mousedown, which lands on the
    // viewer that just opened under the finger and would take focus off the
    // close button.
    const keepFocus = (event: MouseEvent) => event.preventDefault();

    const closeButton = closeRef.current!;
    closeButton.addEventListener("click", close);
    root.addEventListener("mousedown", keepFocus);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      release();
      closeButton.removeEventListener("click", close);
      root.removeEventListener("mousedown", keepFocus);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [image]);

  return (
    <div
      ref={rootRef}
      className="rd-zoom"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-zoomed="false"
    >
      <div ref={groundRef} className="rd-zoom-ground" aria-hidden="true" />
      <img
        ref={pictureRef}
        className="rd-zoom-picture"
        src={image.src}
        alt={image.alt}
        draggable={false}
      />
      <button
        ref={closeRef}
        type="button"
        className="rd-zoom-close"
        aria-label={closeLabel}
      >
        <X size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
