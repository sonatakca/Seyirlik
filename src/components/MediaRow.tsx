import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../i18n/LanguageContext";
import { formatTemplate } from "../lib/format";
import type { MediaItem } from "../lib/types";
import { MediaCard } from "./MediaCard";
import { AnimatedText } from "./AnimatedText";
import { AnimatedWidth } from "./AnimatedWidth";
import { MotionReveal } from "./MotionReveal";
import { useFlipLayout } from "../hooks/useFlipLayout";
import { move, REST } from "../lib/compositorMotion";

interface MediaRowProps {
  title: string;
  items: MediaItem[];
  getItemTo: (item: MediaItem) => string;
  variant?: "poster" | "landscape";
  emptyMessage?: string;
  viewAllTo?: string;
  showRestartWatching?: boolean;
  onClearContinueWatching?: (item: MediaItem) => void;
}

export function MediaRow({
  title,
  items,
  getItemTo,
  variant = "poster",
  emptyMessage,
  viewAllTo,
  showRestartWatching = false,
  onClearContinueWatching,
}: MediaRowProps) {
  const { t } = useLanguage();
  const shouldReduceMotion = useReducedMotion();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  // A cleared card leaves its neighbours to close the gap: a measured FLIP on
  // the compositor. framer-motion's layout projection did this on the main
  // thread, and re-ran over every card whenever the row's gutter was measured.
  useFlipLayout(cardsRef, items.map((item) => item.Id).join("|"));
  const headerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canScrollLeftRef = useRef(false);
  const canScrollRightRef = useRef(false);
  const scrollStateFrameRef = useRef<number | null>(null);
  const hasAlignedInitialScrollRef = useRef(false);
  const [rowGutter, setRowGutter] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const scroller = scrollerRef.current;

    if (!scroller) {
      if (canScrollLeftRef.current) {
        canScrollLeftRef.current = false;
        setCanScrollLeft(false);
      }

      if (canScrollRightRef.current) {
        canScrollRightRef.current = false;
        setCanScrollRight(false);
      }

      return;
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const nextCanScrollLeft = scroller.scrollLeft > 2;
    const nextCanScrollRight = scroller.scrollLeft < maxScrollLeft - 2;

    if (canScrollLeftRef.current !== nextCanScrollLeft) {
      canScrollLeftRef.current = nextCanScrollLeft;
      setCanScrollLeft(nextCanScrollLeft);
    }

    if (canScrollRightRef.current !== nextCanScrollRight) {
      canScrollRightRef.current = nextCanScrollRight;
      setCanScrollRight(nextCanScrollRight);
    }
  }, []);

  const scheduleScrollStateUpdate = useCallback(() => {
    if (scrollStateFrameRef.current !== null) {
      return;
    }

    scrollStateFrameRef.current = window.requestAnimationFrame(() => {
      scrollStateFrameRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  const updateRowGutter = useCallback(() => {
    const header = headerRef.current;
    const viewport = viewportRef.current;

    if (!header || !viewport) {
      return;
    }

    const headerLeft = header.getBoundingClientRect().left;
    const viewportLeft = viewport.getBoundingClientRect().left;
    const nextGutter = Math.max(0, headerLeft - viewportLeft);

    setRowGutter((currentGutter) =>
      Math.abs(currentGutter - nextGutter) < 0.5 ? currentGutter : nextGutter,
    );
  }, []);

  useLayoutEffect(() => {
    updateRowGutter();

    const header = headerRef.current;
    const viewport = viewportRef.current;

    if (!header || !viewport) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(updateRowGutter);

    resizeObserver.observe(header);
    resizeObserver.observe(viewport);

    window.addEventListener("resize", updateRowGutter);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateRowGutter);
    };
  }, [updateRowGutter]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;

    if (!scroller || rowGutter <= 0 || hasAlignedInitialScrollRef.current) {
      return undefined;
    }

    hasAlignedInitialScrollRef.current = true;

    // Prevent the browser from preserving the first card's old position
    // after the leading gutter is inserted.
    scroller.scrollLeft = 0;

    const animationFrame = window.requestAnimationFrame(() => {
      scroller.scrollLeft = 0;
      updateScrollState();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [rowGutter, updateScrollState]);

  useEffect(() => {
    updateScrollState();

    const scroller = scrollerRef.current;

    if (!scroller) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(scroller);

    window.addEventListener("resize", updateScrollState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [items.length, updateScrollState, variant]);

  const scrollByCards = useCallback(
    (direction: "left" | "right") => {
      const scroller = scrollerRef.current;

      if (!scroller) {
        return;
      }

      const cards = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-media-row-card]"),
      );

      if (cards.length === 0) {
        return;
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const currentScrollLeft = scroller.scrollLeft;
      const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;

      const desiredDistance = scroller.clientWidth * 0.82;
      const approximateTarget =
        currentScrollLeft +
        (direction === "left" ? -desiredDistance : desiredDistance);

      const cardTargets = cards.map((card) => {
        const cardRect = card.getBoundingClientRect();

        const alignedScrollLeft =
          currentScrollLeft + (cardRect.left - scrollerRect.left) - rowGutter;

        return Math.max(0, Math.min(alignedScrollLeft, maxScrollLeft));
      });

      const directionalTargets = cardTargets.filter((target) =>
        direction === "left"
          ? target < currentScrollLeft - 2
          : target > currentScrollLeft + 2,
      );

      if (directionalTargets.length === 0) {
        return;
      }

      const closestTarget = directionalTargets.reduce((closest, target) =>
        Math.abs(target - approximateTarget) <
        Math.abs(closest - approximateTarget)
          ? target
          : closest,
      );

      scroller.scrollTo({
        left: closestTarget,
        behavior: shouldReduceMotion ? "auto" : "smooth",
      });
    },
    [rowGutter, shouldReduceMotion],
  );

  // Below every hook on purpose. A row is empty until its data arrives, so
  // returning earlier than this changed the number of hooks between renders
  // the moment the items loaded.
  if (items.length === 0 && !emptyMessage) {
    return null;
  }

  return (
    <MotionReveal className="py-4 sm:py-6" direction="up">
      <div
        ref={headerRef}
        className="mb-0 flex items-end justify-between gap-4"
      >
        <h2 className="text-lg font-black text-white sm:text-2xl">
          <AnimatedWidth value={title}>
            <AnimatedText value={title} />
          </AnimatedWidth>
        </h2>
        {viewAllTo ? (
          <Link
            to={viewAllTo}
            className="text-sm font-bold text-white/[0.55] transition hover:text-white"
          >
            <AnimatedWidth value={t("common.viewAll")}>
              <AnimatedText value={t("common.viewAll")} />
            </AnimatedWidth>
          </Link>
        ) : null}
      </div>
      {items.length > 0 ? (
        <div
          ref={viewportRef}
          className={`group/viewport media-row-edge-fade relative isolate ml-[calc(50%_-_50dvw)] w-[100dvw] ${
            canScrollLeft ? "media-row-edge-fade--left" : ""
          } ${canScrollRight ? "media-row-edge-fade--right" : ""}`}
        >
          <div
            ref={scrollerRef}
            onScroll={scheduleScrollStateUpdate}
            className="media-row-scroll media-scroll relative z-10 snap-x snap-mandatory overflow-x-auto overflow-y-visible [overflow-anchor:none]"
            style={{
              scrollPaddingInlineStart: `${rowGutter}px`,
              scrollPaddingInlineEnd: `${rowGutter}px`,
            }}
          >
            <div className="media-row-scroll-track flex w-max min-w-full pb-6 pt-4 sm:pb-8 sm:pt-6">
              <div
                aria-hidden="true"
                className="flex-none"
                style={{ width: `${rowGutter}px` }}
              />

              <div ref={cardsRef} className="relative flex gap-3 sm:gap-5">
                {/* A leaving card steps out of the row at once, so the rest
                    close up together with its exit. */}
                <AnimatePresence initial={false} mode="popLayout">
                  {items.map((item, index) => (
                    <motion.div
                      key={item.Id}
                      data-media-row-card
                      exit={
                        onClearContinueWatching
                          ? {
                              opacity: 0,
                              transform: shouldReduceMotion
                                ? REST
                                : [REST, move({ x: -36, scale: 0.96 })],
                            }
                          : undefined
                      }
                      className="snap-start"
                    >
                      <MediaCard
                        item={item}
                        to={getItemTo(item)}
                        variant={variant}
                        index={index}
                        animateIn
                        showRestartWatching={showRestartWatching}
                        onClearContinueWatching={onClearContinueWatching}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div
                aria-hidden="true"
                className="flex-none"
                style={{ width: `${rowGutter}px` }}
              />
            </div>
          </div>
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 z-[60] w-36 bg-[linear-gradient(to_right,rgba(0,0,0,0.76)_0%,rgba(0,0,0,0.58)_18%,rgba(0,0,0,0.36)_38%,rgba(0,0,0,0.17)_60%,rgba(0,0,0,0.05)_80%,transparent_100%)] transition-opacity duration-300 ease-out lg:w-52 ${
              canScrollLeft ? "opacity-100" : "opacity-0"
            }`}
          />

          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-0 z-[60] w-36 bg-[linear-gradient(to_left,rgba(0,0,0,0.76)_0%,rgba(0,0,0,0.58)_18%,rgba(0,0,0,0.36)_38%,rgba(0,0,0,0.17)_60%,rgba(0,0,0,0.05)_80%,transparent_100%)] transition-opacity duration-300 ease-out lg:w-52 ${
              canScrollRight ? "opacity-100" : "opacity-0"
            }`}
          />
          <button
            type="button"
            onClick={() => scrollByCards("left")}
            className={`absolute left-3 top-[calc(50%-0.75rem)] z-[90] hidden h-20 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-gray-700/90 text-white shadow-[0_0_70px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] lg:flex ${
              canScrollLeft
                ? "pointer-events-auto opacity-0 group-hover/viewport:opacity-100 focus:opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            aria-label={formatTemplate(t("common.scrollLeft"), { title })}
            aria-hidden={!canScrollLeft}
            tabIndex={canScrollLeft ? 0 : -1}
          >
            <ChevronLeft size={30} />
          </button>
          <button
            type="button"
            onClick={() => scrollByCards("right")}
            className={`absolute right-3 top-[calc(50%-0.75rem)] z-[90] hidden h-20 w-12 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-gray-700/90 text-white shadow-[0_18px_70px_rgba(0,0,0,0.72),0_0_0_1px_rgba(255,255,255,0.06)] transition-[opacity,transform,background-color] duration-200 ease-out hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] lg:flex ${
              canScrollRight
                ? "pointer-events-auto opacity-0 group-hover/viewport:opacity-100 focus:opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            aria-label={formatTemplate(t("common.scrollRight"), { title })}
            aria-hidden={!canScrollRight}
            tabIndex={canScrollRight ? 0 : -1}
          >
            <ChevronRight size={30} />
          </button>
        </div>
      ) : (
        <p className="rounded-xl border border-white/10 bg-[var(--surface)] p-5 text-sm text-white/[0.62]">
          {emptyMessage ? (
            <AnimatedWidth value={emptyMessage}>
              <AnimatedText value={emptyMessage} />
            </AnimatedWidth>
          ) : null}
        </p>
      )}
    </MotionReveal>
  );
}
