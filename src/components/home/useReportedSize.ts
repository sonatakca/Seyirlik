import { useCallback, useEffect, useRef } from "react";

export interface DrawnSize {
  width: number;
  height: number;
}

/**
 * A block's words as laid out, for text in a block wider than itself (a
 * line that only truncates, lettering that fills its box), with any scale
 * drawn around it taken back out.
 */
export function measureWords(element: HTMLElement): DrawnSize {
  const range = document.createRange();
  range.selectNodeContents(element);
  const scale = element.getBoundingClientRect().width / element.offsetWidth;
  const words = range.getBoundingClientRect().width;
  return {
    width: scale > 0 ? Math.min(element.offsetWidth, words / scale) : 0,
    height: element.offsetHeight,
  };
}

/**
 * A ref that reports its element's layout size, before any transform, each
 * time it changes. An element with no size yet (an image still loading)
 * reports nothing.
 */
export function useReportedSize<T extends Element>(
  onSize: ((size: DrawnSize) => void) | undefined,
  measure: (element: T) => DrawnSize = (element) => ({
    width: (element as unknown as HTMLElement).offsetWidth,
    height: (element as unknown as HTMLElement).offsetHeight,
  }),
) {
  const onSizeRef = useRef(onSize);
  const measureRef = useRef(measure);
  useEffect(() => {
    onSizeRef.current = onSize;
    measureRef.current = measure;
  });
  const observerRef = useRef<ResizeObserver | null>(null);
  const isReporting = Boolean(onSize);
  return useCallback(
    (element: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!element || !isReporting || typeof ResizeObserver === "undefined")
        return;
      const report = () => {
        const size = measureRef.current(element);
        if (size.width > 0 && size.height > 0) onSizeRef.current?.(size);
      };
      observerRef.current = new ResizeObserver(report);
      observerRef.current.observe(element);
      report();
    },
    [isReporting],
  );
}
