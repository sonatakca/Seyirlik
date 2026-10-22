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
import warmRedShadow from "../assets/navbar-wordmark/shadow/warm-red.webp";
import amberShadow from "../assets/navbar-wordmark/shadow/amber.webp";
import goldShadow from "../assets/navbar-wordmark/shadow/gold.webp";
import oliveShadow from "../assets/navbar-wordmark/shadow/olive.webp";
import greenShadow from "../assets/navbar-wordmark/shadow/green.webp";
import tealShadow from "../assets/navbar-wordmark/shadow/teal.webp";
import { ACCENT_THEMES } from "../lib/accentTheme";
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
const FRAMES = [
  { accent: "Warm Red", src: warmRed, shadow: warmRedShadow },
  { accent: "Amber", src: amber, shadow: amberShadow },
  { accent: "Gold", src: gold, shadow: goldShadow },
  { accent: "Olive", src: olive, shadow: oliveShadow },
  { accent: "Green", src: green, shadow: greenShadow },
  { accent: "Teal", src: teal, shadow: tealShadow },
].map((frame) => ({ ...frame, luminance: accentLuminance(frame.accent) }));

/** The letters' luminance: each frame is drawn in its accent's colour. */
function accentLuminance(name: string): number {
  const hex = ACCENT_THEMES.find((theme) => theme.name === name)?.accent;
  if (!hex) return 0;
  const value = Number.parseInt(hex.slice(1), 16);
  return relativeLuminance(value >> 16, (value >> 8) & 255, value & 255);
}

// One full lap in half a second, the pace of the brand loading animation.
export const WORDMARK_FRAME_MS = 500 / FRAMES.length;

// How long the cycle keeps going after loading has finished.
export const WORDMARK_LOADING_TAIL_MS = 2500;

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
 * The wordmark in the current accent colour. While anything is loading it
 * cycles through the palette, and keeps cycling for a further 2.5 seconds
 * once loading ends. Then it carries on until it comes round to the accent
 * colour again, so it never stops on a stranger's colour and never jumps.
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
    timerRef.current = window.setInterval(() => {
      const latest = latestRef.current;
      const loadEndedAt = loadEndedAtRef.current;
      const inTail =
        loadEndedAt !== null &&
        Date.now() - loadEndedAt < WORDMARK_LOADING_TAIL_MS;
      const settled =
        !latest.isLoading && !inTail && shownRef.current === latest.accentIndex;

      if (settled || latest.reduceMotion) {
        window.clearInterval(timerRef.current ?? undefined);
        timerRef.current = null;
        setCycleIndex(null);
        return;
      }

      shownRef.current = (shownRef.current + 1) % FRAMES.length;
      setCycleIndex(shownRef.current);
    }, WORDMARK_FRAME_MS);
  }, [isLoading, reduceMotion]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    },
    [],
  );

  const shownIndex = cycleIndex ?? accentIndex;
  const backdropLuminances = useBackdropUnder(rootRef, overArtwork);
  const shadowStrength = backdropLuminances
    ? wordmarkShadowStrength(FRAMES[shownIndex].luminance, backdropLuminances)
    : 1;

  return (
    <span
      ref={rootRef}
      data-wordmark-accent={FRAMES[shownIndex].accent}
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
          style={{ opacity: index === shownIndex ? 1 : 0 }}
        />
      ))}
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
