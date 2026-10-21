import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  animate,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { useLocation, useNavigate } from "react-router-dom";
import { useLanguage } from "../../../i18n/LanguageContext";
import {
  BookGlyph,
  FilmGlyph,
  HomeGlyph,
  ListGlyph,
  ShowsGlyph,
  type GlyphProps,
} from "./TabBarGlyphs";

export interface TabDef {
  key: string;
  to: string;
  label: string;
  Glyph: ComponentType<GlyphProps>;
}

export function useTabs(): TabDef[] {
  const { t } = useLanguage();
  return [
    { key: "home", to: "/home", label: t("nav.home"), Glyph: HomeGlyph },
    { key: "movies", to: "/movies", label: t("nav.movies"), Glyph: FilmGlyph },
    { key: "shows", to: "/shows", label: t("nav.series"), Glyph: ShowsGlyph },
    { key: "books", to: "/books", label: t("nav.books"), Glyph: BookGlyph },
    { key: "list", to: "/my-list", label: t("myList.title"), Glyph: ListGlyph },
  ];
}

/** The tab a path belongs to, as NavLink would decide it: the tab's own path or below it. */
export function activeTabIndex(tabs: TabDef[], pathname: string): number {
  return tabs.findIndex(
    (tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`),
  );
}

/** A tab's [left, right] in the bar's own pixels: equal slots inside the inset. */
export function slotEdges(
  width: number,
  inset: number,
  count: number,
  index: number,
): [number, number] {
  const slot = (width - inset * 2) / count;
  return [inset + index * slot, inset + (index + 1) * slot];
}

// A sine ease-out: it leaves at a little over one and a half times its mean
// speed, so it sets off briskly without snapping away.
const glide = [0.61, 1, 0.88, 1] as const;

// Every trip takes the same time, one tab or four: a longer one simply
// travels faster. The leading edge arrives first, the trailing edge after.
const LEAD = 0.36;
const LAG = 0.48;

export interface TabBarMotion {
  barRef: RefObject<HTMLElement>;
  width: number;
  /** The indicator's two edges. The leading one leaves first, the trailing one follows. */
  left: MotionValue<number>;
  right: MotionValue<number>;
  /** The indicator's centre, for anything carried along with it. */
  centre: MotionValue<number>;
  activeIndex: number;
  /** The tab under a scrubbing finger, or the active one. */
  litIndex: number;
  scrubbing: boolean;
  hidden: boolean;
  reduced: boolean;
  handlers: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  };
  onTabClick: (event: MouseEvent<HTMLAnchorElement>, index: number) => void;
}

interface Options {
  tabs: TabDef[];
  /** Space either side of the row of tabs, in px. */
  inset: number;
}

const SCRUB_THRESHOLD = 10;

export function useTabBarMotion({ tabs, inset }: Options): TabBarMotion {
  const location = useLocation();
  const navigate = useNavigate();
  const reduced = Boolean(useReducedMotion());
  const barRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const left = useMotionValue(0);
  const right = useMotionValue(0);
  const centre = useTransform(() => (left.get() + right.get()) / 2);
  const activeIndex = activeTabIndex(tabs, location.pathname);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const placedRef = useRef<{ index: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => setWidth(bar.clientWidth));
    observer.observe(bar);
    setWidth(bar.clientWidth);
    return () => observer.disconnect();
  }, []);

  const target = useCallback(
    (index: number) => slotEdges(width, inset, tabs.length, index),
    [inset, tabs.length, width],
  );

  // Sends the indicator to a tab. The edge on the side it is heading leaves
  // at once and the other follows, so it stretches along its path and
  // gathers itself on arrival, rather than gliding as a rigid block.
  const sendTo = useCallback(
    (index: number, instant: boolean) => {
      const [toLeft, toRight] = target(index);
      const fromLeft = left.get();
      if (instant || reduced) {
        left.set(toLeft);
        right.set(toRight);
        return;
      }
      const rightward = toLeft > fromLeft;
      animate(left, toLeft, { duration: rightward ? LAG : LEAD, ease: glide });
      animate(right, toRight, {
        duration: rightward ? LEAD : LAG,
        ease: glide,
      });
    },
    [left, reduced, right, target],
  );

  useLayoutEffect(() => {
    if (!width || activeIndex < 0 || scrubIndex !== null) return;
    const placed = placedRef.current;
    const first = !placed;
    const resized = placed !== null && placed.width !== width;
    if (placed && placed.index === activeIndex && !resized) return;
    sendTo(activeIndex, first || resized);
    placedRef.current = { index: activeIndex, width };
  }, [activeIndex, scrubIndex, sendTo, width]);

  // Hides on a deliberate scroll down the page and returns on any scroll
  // up, at the top, or on arriving somewhere new.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let travelled = 0;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - last;
      last = y;
      if (y < 80) {
        travelled = 0;
        setHidden(false);
        return;
      }
      travelled =
        Math.sign(delta) === Math.sign(travelled) ? travelled + delta : delta;
      if (travelled > 48) setHidden(true);
      else if (travelled < -24) setHidden(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => setHidden(false), [location.pathname]);

  // Scrubbing: a finger that slides along the bar carries the indicator
  // with it, lighting each tab it crosses; lifting it goes there.
  const gesture = useRef<{
    id: number;
    startX: number;
    scrubbing: boolean;
    suppressClick: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const indexAt = useCallback(
    (x: number) => {
      for (let i = 0; i < tabs.length - 1; i += 1) {
        if (x < target(i)[1]) return i;
      }
      return tabs.length - 1;
    },
    [tabs.length, target],
  );

  const localX = (event: PointerEvent<HTMLElement>) => {
    const rect = barRef.current!.getBoundingClientRect();
    return event.clientX - rect.left;
  };

  const handlers: TabBarMotion["handlers"] = {
    onPointerDown(event) {
      if (event.button !== 0 || !barRef.current) return;
      gesture.current = {
        id: event.pointerId,
        startX: localX(event),
        scrubbing: false,
        suppressClick: false,
      };
    },
    onPointerMove(event) {
      const g = gesture.current;
      if (!g || g.id !== event.pointerId) return;
      const x = localX(event);
      if (!g.scrubbing) {
        if (Math.abs(x - g.startX) < SCRUB_THRESHOLD) return;
        g.scrubbing = true;
        barRef.current?.setPointerCapture(event.pointerId);
      }
      const [l, r] = target(Math.max(0, activeIndex));
      const half = (r - l) / 2;
      const clamped = Math.min(width - inset - half, Math.max(inset + half, x));
      left.stop();
      right.stop();
      left.set(clamped - half);
      right.set(clamped + half);
      const next = indexAt(x);
      setScrubIndex((current) => (current === next ? current : next));
    },
    onPointerUp(event) {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.id !== event.pointerId || !g.scrubbing) return;
      suppressClickRef.current = true;
      const index = indexAt(localX(event));
      setScrubIndex(null);
      placedRef.current = { index, width };
      sendTo(index, false);
      if (index !== activeIndex) navigate(tabs[index]!.to);
    },
    onPointerCancel() {
      if (gesture.current?.scrubbing) {
        setScrubIndex(null);
        if (activeIndex >= 0) sendTo(activeIndex, false);
      }
      gesture.current = null;
    },
    onClickCapture(event) {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  // A tap on the tab you are already on takes you back to its top.
  const onTabClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, index: number) => {
      if (index !== activeIndex || location.pathname !== tabs[index]!.to)
        return;
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    },
    [activeIndex, location.pathname, reduced, tabs],
  );

  return {
    barRef,
    width,
    left,
    right,
    centre,
    activeIndex,
    litIndex: scrubIndex ?? activeIndex,
    scrubbing: scrubIndex !== null,
    hidden,
    reduced,
    handlers,
    onTabClick,
  };
}
