import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useReducedMotion } from "framer-motion";
import warmRed from "../assets/navbar-wordmark/warm-red.webp";
import amber from "../assets/navbar-wordmark/amber.webp";
import gold from "../assets/navbar-wordmark/gold.webp";
import olive from "../assets/navbar-wordmark/olive.webp";
import green from "../assets/navbar-wordmark/green.webp";
import teal from "../assets/navbar-wordmark/teal.webp";
import warmRedWhite from "../assets/navbar-wordmark/white/warm-red.webp";
import amberWhite from "../assets/navbar-wordmark/white/amber.webp";
import goldWhite from "../assets/navbar-wordmark/white/gold.webp";
import oliveWhite from "../assets/navbar-wordmark/white/olive.webp";
import greenWhite from "../assets/navbar-wordmark/white/green.webp";
import tealWhite from "../assets/navbar-wordmark/white/teal.webp";
import warmRedShadow from "../assets/navbar-wordmark/shadow/warm-red.webp";
import amberShadow from "../assets/navbar-wordmark/shadow/amber.webp";
import goldShadow from "../assets/navbar-wordmark/shadow/gold.webp";
import oliveShadow from "../assets/navbar-wordmark/shadow/olive.webp";
import greenShadow from "../assets/navbar-wordmark/shadow/green.webp";
import tealShadow from "../assets/navbar-wordmark/shadow/teal.webp";
import { ACCENT_THEMES } from "../lib/accentTheme";
import { HERO_MOTION, heroMotionDefaults } from "./home/homeHeroModel";
import {
  isLoadingActivityPending,
  subscribeLoadingActivity,
} from "../lib/loadingActivity";
import { relativeLuminance } from "../lib/logoShadow";
import {
  measureBackdropUnder,
  useNavbarBackdrop,
  type NavbarBackdrop,
} from "../lib/navbarBackdrop";
import {
  getWordmarkShadowFrameStyle,
  wordmarkShadowStrength,
} from "./navbarWordmarkShadow";

// Palette order, which is also the cycle order. Names match ACCENT_THEMES.
// The frames are not the same letters recoloured: each is drawn on its own,
// so each has its own white, with exactly its own shape.
const FRAMES = [
  { accent: "Warm Red", src: warmRed, white: warmRedWhite, shadow: warmRedShadow },
  { accent: "Amber", src: amber, white: amberWhite, shadow: amberShadow },
  { accent: "Gold", src: gold, white: goldWhite, shadow: goldShadow },
  { accent: "Olive", src: olive, white: oliveWhite, shadow: oliveShadow },
  { accent: "Green", src: green, white: greenWhite, shadow: greenShadow },
  { accent: "Teal", src: teal, white: tealWhite, shadow: tealShadow },
].map((frame) => ({ ...frame, luminance: accentLuminance(frame.accent) }));

/** The letters' luminance: each frame is drawn in its accent's colour. */
function accentLuminance(name: string): number {
  const hex = ACCENT_THEMES.find((theme) => theme.name === name)?.accent;
  if (!hex) return 0;
  const value = Number.parseInt(hex.slice(1), 16);
  return relativeLuminance(value >> 16, (value >> 8) & 255, value & 255);
}

// Its timings live with the home hero's (`HERO_MOTION.logo*`), where the
// motion lab can tune them; each is read as a cycle starts. A lap is one turn
// through the palette; the cycle keeps going for some laps after loading
// ends; then it holds the accent colour, and fades to white.
const frameMs = () => (HERO_MOTION.logoLapS * 1000) / FRAMES.length;
const tailMs = () => HERO_MOTION.logoTailLaps * HERO_MOTION.logoLapS * 1000;

const DEFAULTS = heroMotionDefaults();
export const WORDMARK_FRAME_MS = (DEFAULTS.logoLapS * 1000) / FRAMES.length;
export const WORDMARK_LOADING_TAIL_MS =
  DEFAULTS.logoTailLaps * DEFAULTS.logoLapS * 1000;
export const WORDMARK_ACCENT_HOLD_MS = DEFAULTS.logoHoldS * 1000;
export const WORDMARK_WHITE_FADE_MS = DEFAULTS.logoFadeS * 1000;

function subscribeAccentTheme(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-accent-theme"],
  });
  return () => observer.disconnect();
}

function getAccentThemeName(): string | undefined {
  return document.documentElement.dataset.accentTheme;
}

/**
 * A soft dark shadow under the letters, as much of it as the backdrop needs:
 * all of it off artwork and over anything as dark as the letters, none where
 * the letters are already well darker than the artwork behind them. Baked
 * into images that overhang the box by its reach, never a CSS filter: see
 * `navbarWordmarkShadow.ts`.
 */
const SHADOW_FRAME_STYLE = getWordmarkShadowFrameStyle();

/**
 * The white's reveal: a mask three times the wordmark's width, opaque on its
 * left third, clear on its right third, with a soft edge between. Moved from
 * its right end to its left, the edge crosses the letters from left to right.
 */
const WHITE_SWEEP_MASK = {
  WebkitMaskImage:
    "linear-gradient(to right, #000 33.333%, transparent 66.667%)",
  maskImage: "linear-gradient(to right, #000 33.333%, transparent 66.667%)",
  WebkitMaskSize: "300% 100%",
  maskSize: "300% 100%",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
} as const;

/**
 * The wordmark, white at rest. While anything is loading it cycles through
 * the palette, and keeps cycling for a further 2.5 seconds once loading ends.
 * Then it carries on until it comes round to the accent colour again, so it
 * never stops on a stranger's colour and never jumps, holds that colour for a
 * second, and fades to white: that frame's own letters in white, over it, so
 * the shape never changes.
 */
export function NavbarWordmark({
  className = "",
  overArtwork = false,
}: {
  className?: string;
  /** True while the bar is clear over a hero's artwork. */
  overArtwork?: boolean;
}) {
  const accentName = useSyncExternalStore(
    subscribeAccentTheme,
    getAccentThemeName,
    () => undefined,
  );
  const isLoading = useSyncExternalStore(
    subscribeLoadingActivity,
    isLoadingActivityPending,
    () => false,
  );
  const reduceMotion = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLSpanElement>(null);
  const accentIndex = Math.max(
    0,
    FRAMES.findIndex((frame) => frame.accent === accentName),
  );

  // Null while resting on the accent colour.
  const [cycleIndex, setCycleIndex] = useState<number | null>(null);
  // White over the accent: from the start, and a second after each cycle.
  const [isWhite, setIsWhite] = useState(true);
  // The white has finished fading in, so the colour under it can go: its
  // soft edges would otherwise tint the white's.
  const [isWhiteCovering, setIsWhiteCovering] = useState(true);
  const whiteTimerRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const shownRef = useRef(accentIndex);
  const latestRef = useRef({ accentIndex, isLoading, reduceMotion });
  useEffect(() => {
    latestRef.current = { accentIndex, isLoading, reduceMotion };
  });
  // When the most recent load finished; null while one is in progress.
  const loadEndedAtRef = useRef<number | null>(null);
  useEffect(() => {
    loadEndedAtRef.current = isLoading ? null : Date.now();
  }, [isLoading]);

  useEffect(() => {
    if (!isLoading || reduceMotion || timerRef.current !== null) return;

    shownRef.current = latestRef.current.accentIndex;
    if (whiteTimerRef.current !== null) {
      window.clearTimeout(whiteTimerRef.current);
      whiteTimerRef.current = null;
    }
    setIsWhite(false);
    setIsWhiteCovering(false);
    timerRef.current = window.setInterval(() => {
      const latest = latestRef.current;
      const loadEndedAt = loadEndedAtRef.current;
      const inTail =
        loadEndedAt !== null &&
        Date.now() - loadEndedAt < tailMs();
      const settled =
        !latest.isLoading && !inTail && shownRef.current === latest.accentIndex;

      if (settled || latest.reduceMotion) {
        window.clearInterval(timerRef.current ?? undefined);
        timerRef.current = null;
        setCycleIndex(null);
        whiteTimerRef.current = window.setTimeout(() => {
          whiteTimerRef.current = null;
          setIsWhite(true);
        }, HERO_MOTION.logoHoldS * 1000);
        return;
      }

      shownRef.current = (shownRef.current + 1) % FRAMES.length;
      setCycleIndex(shownRef.current);
    }, frameMs());
  }, [isLoading, reduceMotion]);

  // Cleared and forgotten, so a remount (as React's development mode does
  // at once) can start a cycle again instead of taking the old timer for a
  // running one.
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (whiteTimerRef.current !== null)
        window.clearTimeout(whiteTimerRef.current);
      timerRef.current = null;
      whiteTimerRef.current = null;
    },
    [],
  );

  const shownIndex = cycleIndex ?? accentIndex;
  const backdropLuminances = useBackdropUnder(rootRef, overArtwork);
  const shadowStrength = backdropLuminances
    ? wordmarkShadowStrength(
        isWhite ? 1 : FRAMES[shownIndex].luminance,
        backdropLuminances,
      )
    : 1;

  return (
    <span
      ref={rootRef}
      data-wordmark-accent={isWhite ? "White" : FRAMES[shownIndex].accent}
      data-shadow-strength={shadowStrength.toFixed(2)}
      className={`relative block aspect-[430/176] ${className}`}
    >
      {/* Every frame and shadow stays mounted so a colour change never
          waits on a decode. The shadows fade together, by strength; within
          them, as among the letters, a colour change is a plain swap. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-500 ease-out"
        style={{ opacity: shadowStrength }}
      >
        {FRAMES.map((frame, index) => (
          <img
            key={frame.accent}
            src={frame.shadow}
            alt=""
            draggable={false}
            decoding="async"
            className="absolute max-w-none"
            style={{
              ...SHADOW_FRAME_STYLE,
              opacity: index === shownIndex ? 1 : 0,
            }}
          />
        ))}
      </span>
      {FRAMES.map((frame, index) => (
        <img
          key={frame.accent}
          src={frame.src}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          className="pointer-events-none absolute inset-0 h-full w-full max-w-none"
          style={{
            opacity: index === shownIndex && !isWhiteCovering ? 1 : 0,
          }}
        />
      ))}
      {/* Each frame's white over it: the shown one sweeps in from the left
          once a cycle has landed, a soft edge crossing the letters, and is
          gone at once when the next begins. */}
      {FRAMES.map((frame, index) => {
        const isOn = isWhite && index === shownIndex;
        const sweep = isOn ? `${HERO_MOTION.logoFadeS * 1000}ms ease-out` : "0ms";
        return (
          <img
            key={`${frame.accent} white`}
            src={frame.white}
            alt=""
            aria-hidden="true"
            draggable={false}
            decoding="async"
            className="pointer-events-none absolute inset-0 h-full w-full max-w-none"
            style={{
              ...WHITE_SWEEP_MASK,
              opacity: index === shownIndex ? 1 : 0,
              WebkitMaskPosition: isOn ? "0% 0" : "100% 0",
              maskPosition: isOn ? "0% 0" : "100% 0",
              transition: `-webkit-mask-position ${sweep}, mask-position ${sweep}`,
            }}
            onTransitionEnd={() => {
              if (isOn) setIsWhiteCovering(true);
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * The artwork behind the wordmark, as luminances on a small grid, while the
 * bar is clear over a hero that registered its stage; null otherwise.
 */
function useBackdropUnder(
  rootRef: RefObject<HTMLElement | null>,
  overArtwork: boolean,
): number[] | null {
  const backdrop = useNavbarBackdrop();
  const [measured, setMeasured] = useState<{
    backdrop: NavbarBackdrop;
    values: number[] | null;
  } | null>(null);
  useEffect(() => {
    if (!overArtwork || !backdrop) return;
    let cancelled = false;
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      void measureBackdropUnder(backdrop, root.getBoundingClientRect()).then(
        (values) => {
          if (!cancelled) setMeasured({ backdrop, values });
        },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", measure);
    };
  }, [backdrop, overArtwork, rootRef]);
  if (!overArtwork || !backdrop || measured?.backdrop !== backdrop) return null;
  return measured.values;
}
