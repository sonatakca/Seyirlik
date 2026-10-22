import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useReducedMotion } from "framer-motion";

interface SlidingIndicatorProps {
  /** The positioned element the indicator lives in and measures against. */
  containerRef: RefObject<HTMLElement>;
  /** Selects the element the indicator should sit on, inside the container. */
  activeSelector: string;
  /** Changes whenever the active element may have changed. */
  measureKey: unknown;
  className?: string;
  children?: ReactNode;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A tween, not a spring: it lands exactly on time instead of creeping the
// last few pixels, and a retarget mid-flight simply sets off from where it is.
const GLIDE_MS = 380;
const GLIDE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * One indicator that travels from the old active element to the new one,
 * rather than one that vanishes here and reappears there.
 *
 * Positions come from offsetLeft/offsetTop, which ignore transforms and page
 * scroll, so a fixed navbar and a scrolled list measure the same way. Size
 * changes of the active element (a label swapping language, a tab growing) are
 * followed through a ResizeObserver.
 *
 * The journey is a FLIP: the indicator takes its new size and place at once,
 * and one compositor animation carries it there from where it was drawn —
 * a translate, with a scale for the change of size. The compositor plays it at
 * the display's full rate; animating width and height instead re-laid it out
 * on the main thread every frame.
 */
export function SlidingIndicator({
  containerRef,
  activeSelector,
  measureKey,
  className = "",
  children,
}: SlidingIndicatorProps) {
  const shouldReduceMotion = useReducedMotion();
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<Box | null>(null);
  const glideRef = useRef<Animation | null>(null);

  const place = useCallback(
    (instant: boolean) => {
      const container = containerRef.current;
      const indicator = indicatorRef.current;
      if (!indicator) return;
      const target = container?.querySelector<HTMLElement>(activeSelector);

      if (!container || !target) {
        indicator.style.transition = "opacity 180ms ease";
        indicator.style.opacity = "0";
        boxRef.current = null;
        return;
      }

      // offsetLeft is relative to the offsetParent; walk up to the container
      // so a target nested inside a list item still measures correctly.
      let left = 0;
      let top = 0;
      let node: HTMLElement | null = target;
      while (node && node !== container) {
        left += node.offsetLeft;
        top += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
      }
      const next: Box = {
        x: left,
        y: top,
        width: target.offsetWidth,
        height: target.offsetHeight,
      };

      const previous = boxRef.current;
      const from =
        previous && !instant && !shouldReduceMotion
          ? drawnBox(indicator, container, previous)
          : null;
      glideRef.current?.cancel();
      glideRef.current = null;

      indicator.style.width = `${next.width}px`;
      indicator.style.height = `${next.height}px`;
      indicator.style.transform = `translate(${next.x}px, ${next.y}px)`;
      boxRef.current = next;

      if (
        from &&
        next.width > 0 &&
        next.height > 0 &&
        typeof indicator.animate === "function" &&
        !sameBox(from, next)
      ) {
        glideRef.current = indicator.animate(
          [
            {
              transform: `translate(${from.x}px, ${from.y}px) scale(${
                from.width / next.width
              }, ${from.height / next.height})`,
            },
            {
              transform: `translate(${next.x}px, ${next.y}px) scale(1, 1)`,
            },
          ],
          { duration: GLIDE_MS, easing: GLIDE_EASE },
        );
      }

      indicator.style.transition = `opacity ${previous ? 120 : 220}ms ease`;
      indicator.style.opacity = "1";
    },
    [activeSelector, containerRef, shouldReduceMotion],
  );

  useLayoutEffect(() => {
    place(false);
  }, [measureKey, place]);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    // Follows the active element while it resizes; a resize is a correction,
    // not a journey, so it glides only if the indicator is already placed.
    const observer = new ResizeObserver(() => place(false));
    observer.observe(container);
    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [containerRef, place]);

  return (
    <span
      ref={indicatorRef}
      aria-hidden="true"
      className={`pointer-events-none absolute left-0 top-0 origin-top-left ${className}`}
      style={{ opacity: 0, width: 0, height: 0 }}
    >
      {children}
    </span>
  );
}

/**
 * Where the indicator is drawn now, in the container's coordinates: mid-glide
 * that is part way along, so a retarget sets off from there.
 */
function drawnBox(
  indicator: HTMLElement,
  container: HTMLElement,
  resting: Box,
): Box {
  const drawn = indicator.getBoundingClientRect();
  const frame = container.getBoundingClientRect();
  if (drawn.width === 0 && drawn.height === 0) return resting;
  return {
    x: drawn.left - frame.left + container.scrollLeft - container.clientLeft,
    y: drawn.top - frame.top + container.scrollTop - container.clientTop,
    width: drawn.width,
    height: drawn.height,
  };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
