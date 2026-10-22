import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { DwellClock } from "../../lib/dwellClock";
import { formatRuntime } from "../../lib/format";
import {
  getItemDisplayMetadata,
  getItemLogoUrlById,
} from "../../lib/itemMetadataPreferences";
import {
  INITIAL_LOGO_LAYOUT,
  LOGO_SHADOW_REFERENCE_WIDTH,
  getLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
} from "../../lib/logoLayout";
import {
  getBackdropImageUrl,
  getHeroPreviewUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../../lib/mediaApi";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { FavouriteButton } from "../FavouriteButton";
import { readHeroTrailersEnabledPreference } from "../hero/heroModel";
import { heroPlayState } from "../home/HeroActions";
import { HERO_DWELL_MS, HERO_TRAILER_DELAY_MS } from "../home/homeHeroModel";
import { AMBIENT_SOURCE_WIDTH } from "../../lib/ambientBlur";
import { useBakedAmbient } from "./useBakedAmbient";
import {
  ACTIONS,
  CARD_GAP_PX,
  CARD_WIDTH,
  CardShell,
  FACTS,
  PROGRESS,
  PhoneHeroFrame,
  PhoneHomeHeroSkeleton,
  ROUND,
  SIDE_SCALE,
  SIDE_SHADE,
} from "./phoneHomeHeroFrame";

/**
 * The phone's home hero: a deck of posters. The one in front is a poster
 * card as the library draws it, only larger: its logo where the artwork tool
 * placed it, at that size and shadow. Its neighbours stand behind it at the
 * sides, so the deck shows there is more, and a finger moves the whole deck
 * with it and lets it settle on a spring at the speed it was thrown.
 *
 * Under the deck, off the artwork, are what the poster cannot carry without
 * hiding itself: how long the card has left, the title's facts, and play,
 * My List and pause. A preview, where the title has one, plays inside the
 * front card once it has rested.
 *
 * Its loading state is built from the same frame (`PhoneHomeHeroSkeleton`),
 * so every placeholder is the size of, and where, the piece that replaces it.
 */

/** A drag past this share of a card, or a flick, moves the deck one card. */
const SWIPE_SHARE = 0.18;
const SWIPE_VELOCITY_PX_MS = 0.35;
/** Settles with a trace of overshoot, from the speed the finger left it at. */
const DECK_SPRING = { type: "spring", stiffness: 240, damping: 30 } as const;
const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/**
 * The round buttons' glass: lighter than the desktop's smoke, because it
 * stands on the room's dark foot rather than on open artwork.
 */
const GLASS =
  "border border-white/[0.16] bg-white/[0.1] backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_24px_-10px_rgba(0,0,0,0.7)]";
const FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050607]";

function getPosterUrl(
  item: MediaItem,
  coverWidth = 900,
  backdropWidth = 1280,
): string {
  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    return getPrimaryImageUrl(
      item.SeriesId,
      item.SeriesPrimaryImageTag,
      coverWidth,
    );
  }
  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, coverWidth);
  }
  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      backdropWidth,
    );
  }
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.Id,
      item.BackdropImageTags[0],
      backdropWidth,
    );
  }
  return "";
}

/** The poster at the size its baked light is made from. */
const getAmbientSource = (item: MediaItem | undefined) =>
  item ? getPosterUrl(item, AMBIENT_SOURCE_WIDTH, AMBIENT_SOURCE_WIDTH) : "";

/**
 * The light's look: what `blur-3xl saturate-150` on the full poster gave.
 * The field spans the hero and the 4rem it bleeds past each side.
 */
const AMBIENT_BLUR_PX = 64;
const AMBIENT_SATURATION = 1.5;
const AMBIENT_BLEED_PX = 128;

const mod = (value: number, length: number) =>
  ((value % length) + length) % length;

/** One poster in the deck, placed from the deck's position. */
function DeckCard({
  item,
  slot,
  position,
  step,
  isFront,
  preview,
  onSelect,
  wasDragRef,
}: {
  item: MediaItem;
  /** Where this card stands in the deck, counted from the first card. */
  slot: number;
  position: MotionValue<number>;
  step: number;
  isFront: boolean;
  preview: ReactNode;
  onSelect: () => void;
  wasDragRef: { current: boolean };
}) {
  const { language } = useLanguage();
  const x = useTransform(position, (p) => (slot - p) * step);
  const distance = useTransform(position, (p) =>
    Math.min(1.5, Math.abs(slot - p)),
  );
  const scale = useTransform(distance, [0, 1], [1, SIDE_SCALE]);
  const shade = useTransform(distance, [0, 1], [0, SIDE_SHADE]);
  const zIndex = useTransform(distance, (d) => Math.round(10 - d * 4));

  const title = getItemDisplayMetadata(item, language).title ?? item.Name;
  const posterUrl = getPosterUrl(item);
  const fallbackLogoUrl = item.ImageTags?.Logo
    ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 620)
    : item.ParentLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 620)
      : "";
  const logoUrl = getItemLogoUrlById(
    item.Type === "Episode"
      ? (item.SeriesId ?? item.ParentLogoItemId)
      : item.Id,
    language,
    fallbackLogoUrl,
  );
  // Where the artwork tool placed the logo on this poster. A title never
  // placed there opens where the tool itself would open on it.
  const stored = getLogoLayout(item);
  const layout = stored ?? INITIAL_LOGO_LAYOUT;
  // The tool's shadow is measured on a 200px card; this one is larger.
  const shadowScale = step > 0 ? step / LOGO_SHADOW_REFERENCE_WIDTH : 1;
  const logoShadow = getLogoShadowFrameStyle(layout.shadow, shadowScale);
  const logoBackdrop = stored
    ? getLogoShadowBackdropStyle(stored.shadow, shadowScale)
    : undefined;

  return (
    <motion.div
      className="absolute inset-0"
      style={{ x, scale, zIndex }}
      aria-hidden={isFront ? undefined : true}
    >
      <CardShell>
        {posterUrl ? (
          <img
            src={posterUrl}
            alt=""
            loading="eager"
            fetchPriority={isFront ? "high" : "auto"}
            decoding="async"
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover"
          />
        ) : null}

        {preview}

        {logoUrl ? (
          <div
            className="pointer-events-none absolute z-20"
            style={getLogoLayoutStyle(
              layout,
              getLogoShadowReach(layout.shadow, shadowScale),
            )}
          >
            <div className="relative flow-root">
              {logoBackdrop ? (
                <span
                  aria-hidden="true"
                  style={logoBackdrop}
                  className="absolute inset-[6%] rounded-[45%]"
                />
              ) : null}
              <div
                data-logo-shadow="true"
                style={logoShadow}
                className="relative z-10"
              >
                <img
                  src={logoUrl}
                  alt=""
                  draggable={false}
                  className="block h-auto w-full select-none object-contain"
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-cinematic-title pointer-events-none absolute inset-x-0 bottom-[8%] z-20 line-clamp-2 px-5 text-center text-[2rem] font-black uppercase leading-[0.9] text-white drop-shadow-[0_10px_22px_rgba(0,0,0,0.95)]">
            {title}
          </p>
        )}

        {/* A neighbour stands in shade, and lightens as it comes forward. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-30 bg-black"
          style={{ opacity: shade }}
        />

        <Link
          to={getRouteForItem(item)}
          aria-label={title}
          tabIndex={isFront ? undefined : -1}
          draggable={false}
          onClick={(event) => {
            // The end of a drag is not a tap, and a tap on a neighbour brings
            // it forward rather than opening it.
            if (wasDragRef.current || !isFront) {
              event.preventDefault();
              if (!wasDragRef.current) onSelect();
            }
          }}
          className={`absolute inset-0 z-40 rounded-[calc(2rem-1px)] ${FOCUS}`}
        />
      </CardShell>
    </motion.div>
  );
}

export function PhoneHomeHero({
  items,
  smartContinueItems,
}: {
  items: MediaItem[];
  /** What the viewer is part-way through, so play can resume it. */
  smartContinueItems: MediaItem[];
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion() ?? false;
  const regionRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(0);
  const position = useMotionValue(0);
  /** The card in front, counted without wrapping, so the deck never jumps. */
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const [clock] = useState(() => new DwellClock(HERO_DWELL_MS));
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    startPosition: number;
    lastX: number;
    lastAt: number;
    velocity: number;
    axis: "x" | "y" | null;
  } | null>(null);
  const wasDragRef = useRef(false);
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  const [isTrailerMuted, setIsTrailerMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trailersSeen = useRef(new Set<string>());

  const count = items.length;
  const step = cardWidth + CARD_GAP_PX;
  const itemsKey = items.map((item) => item.Id).join("|");
  const frontItem = count > 0 ? items[mod(front, count)] : undefined;
  const hasItems = count > 0;

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return undefined;
    const measure = () => setCardWidth(sizer.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(sizer);
    return () => observer.disconnect();
  }, [hasItems]);

  // A new set of titles starts again from the first.
  useEffect(() => {
    position.set(0);
    frontRef.current = 0;
    setFront(0);
    clock.reset();
  }, [itemsKey, position, clock]);

  // Out of view, or behind another tab, the deck and its preview wait.
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof IntersectionObserver === "undefined")
      return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setIsInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.35 },
    );
    observer.observe(region);
    return () => observer.disconnect();
  }, [hasItems]);
  useEffect(() => {
    const onVisibility = () => setIsPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const goTo = useCallback(
    (target: number, velocity = 0) => {
      frontRef.current = target;
      setFront(target);
      clock.reset();
      setIsTrailerPlaying(false);
      void animate(
        position,
        target,
        reduceMotion ? { duration: 0 } : { ...DECK_SPRING, velocity },
      );
    },
    [position, clock, reduceMotion],
  );

  // The front card's time: it runs while the deck rests in view, holds
  // while a finger or a preview has it, and moves the deck on at its end.
  const isRunning =
    count > 1 &&
    !isPaused &&
    !isDragging &&
    !isTrailerPlaying &&
    isInView &&
    isPageVisible;
  useEffect(() => {
    if (!isRunning) return undefined;
    return clock.start(() => goTo(frontRef.current + 1));
  }, [isRunning, front, clock, goTo]);

  // The preview: asked for once the card is in front, played once per visit,
  // after the poster has had its moment.
  useEffect(() => {
    let cancelled = false;
    setTrailerUrl(null);
    setIsTrailerPlaying(false);
    if (!frontItem || !readHeroTrailersEnabledPreference()) return undefined;
    void getHeroPreviewUrl(frontItem)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [frontItem]);
  useEffect(() => {
    if (!trailerUrl || !frontItem || reduceMotion) return undefined;
    if (trailersSeen.current.has(frontItem.Id)) return undefined;
    return clock.onReach(HERO_TRAILER_DELAY_MS / HERO_DWELL_MS, () => {
      trailersSeen.current.add(frontItem.Id);
      setIsTrailerPlaying(true);
    });
  }, [frontItem, clock, reduceMotion, trailerUrl]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isTrailerPlaying && isInView && isPageVisible) {
      video.muted = isTrailerMuted;
      void video.play().catch(() => setIsTrailerPlaying(false));
    } else {
      video.pause();
    }
  }, [isInView, isPageVisible, isTrailerMuted, isTrailerPlaying]);

  const ambientUrl = useBakedAmbient(
    getAmbientSource(frontItem),
    count > 1
      ? [front + 1, front - 1].map((slot) =>
          getAmbientSource(items[mod(slot, count)]),
        )
      : [],
    {
      blurPx: AMBIENT_BLUR_PX,
      saturation: AMBIENT_SATURATION,
      drawnWidth:
        (typeof window === "undefined" ? 390 : window.innerWidth) +
        AMBIENT_BLEED_PX,
    },
  );

  if (!frontItem) return <PhoneHomeHeroSkeleton />;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (count <= 1 || (event.pointerType === "mouse" && event.button !== 0))
      return;
    position.stop();
    wasDragRef.current = false;
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: position.get(),
      lastX: event.clientX,
      lastAt: performance.now(),
      velocity: 0,
      axis: null,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId || step <= 0) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.axis && Math.hypot(dx, dy) > 8) {
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (drag.axis === "x") {
        wasDragRef.current = true;
        setIsDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
    if (drag.axis !== "x") return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastAt);
    drag.velocity =
      0.6 * drag.velocity + 0.4 * ((event.clientX - drag.lastX) / dt);
    drag.lastX = event.clientX;
    drag.lastAt = now;
    // The deck is under the finger, card for card.
    position.set(drag.startPosition - dx / step);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (drag.axis !== "x") return;
    setIsDragging(false);
    const dx = event.clientX - drag.startX;
    const thrown =
      Math.abs(drag.velocity) >= SWIPE_VELOCITY_PX_MS
        ? -Math.sign(drag.velocity)
        : Math.abs(dx) >= step * SWIPE_SHARE
          ? -Math.sign(dx)
          : 0;
    // The spring starts at the finger's own speed, in cards per second.
    goTo(frontRef.current + thrown, (-drag.velocity * 1000) / step);
    // Let the click that ends this drag see it, then forget it.
    window.setTimeout(() => {
      wasDragRef.current = false;
    }, 0);
  };

  const metadata = getItemDisplayMetadata(frontItem, language);
  const facts = [
    frontItem.ProductionYear,
    formatRuntime(frontItem.RunTimeTicks, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
    frontItem.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  const play = heroPlayState(frontItem, smartContinueItems, t);
  const canPlay =
    frontItem.Type === "Movie" ||
    frontItem.Type === "Episode" ||
    frontItem.Type === "Series" ||
    frontItem.MediaType === "Video";
  const title = metadata.title ?? frontItem.Name;
  const slots =
    count > 1 ? [front - 2, front - 1, front, front + 1, front + 2] : [front];

  // The baked field, cross-faded: the turn moves only opacity, never a filter.
  const ambient = (
    <AnimatePresence mode="sync" initial={false}>
      {ambientUrl ? (
        <motion.div
          key={ambientUrl}
          className="absolute -inset-16 overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE_OUT }}
        >
          <img
            src={ambientUrl}
            alt=""
            decoding="async"
            className="h-full w-full scale-125 object-cover opacity-72"
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  const preview = trailerUrl ? (
    <motion.video
      ref={videoRef}
      src={trailerUrl}
      muted={isTrailerMuted}
      playsInline
      preload="metadata"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full object-cover"
      initial={false}
      animate={{ opacity: isTrailerPlaying ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.8, ease: EASE_OUT }}
      onEnded={() => {
        setIsTrailerPlaying(false);
        goTo(frontRef.current + 1);
      }}
      onError={() => setIsTrailerPlaying(false)}
    />
  ) : null;

  return (
    <PhoneHeroFrame ambient={ambient}>
      <div
        ref={regionRef}
        role="region"
        aria-roledescription="carousel"
        aria-label={t("hero.featured")}
        className="relative"
        style={{ width: CARD_WIDTH }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") goTo(frontRef.current + 1);
          if (event.key === "ArrowLeft") goTo(frontRef.current - 1);
        }}
      >
        <div
          ref={sizerRef}
          className="relative aspect-[2/3] w-full touch-pan-y select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {cardWidth > 0
            ? slots.map((slot) => (
                <DeckCard
                  key={slot}
                  item={items[mod(slot, count)]!}
                  slot={slot}
                  position={position}
                  step={step}
                  isFront={slot === front}
                  preview={slot === front ? preview : null}
                  onSelect={() => goTo(slot)}
                  wasDragRef={wasDragRef}
                />
              ))
            : null}

          {/* Sound for the preview, while it plays. */}
          <AnimatePresence>
            {isTrailerPlaying ? (
              <motion.button
                type="button"
                aria-label={
                  isTrailerMuted ? t("player.unmute") : t("player.mute")
                }
                onClick={() => setIsTrailerMuted((current) => !current)}
                className={`absolute right-3 top-3 z-50 ${ROUND} ${GLASS} text-white ${FOCUS}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {isTrailerMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>

        {/* How long the front card has left. */}
        <div className={PROGRESS} aria-hidden="true">
          <div
            ref={clock.attach}
            className="h-full origin-left rounded-full bg-[var(--accent)] [transform:scaleX(0)]"
          />
        </div>

        {/* The copy crossfades in place as the next card arrives: the two
            stand on the same spot for a moment, so the rows never empty. */}
        <div className="relative h-[5.5rem]">
          <AnimatePresence initial={false}>
            <motion.div
              key={frontItem.Id}
              className="absolute inset-x-0 top-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.28,
                ease: "easeOut",
              }}
            >
              <p className={FACTS}>{facts}</p>
              <div className={ACTIONS}>
                {canPlay ? (
                  <a
                    href={`/watch/${play.playItem.Id}`}
                    aria-label={play.playLabel}
                    onClick={(event) => {
                      event.preventDefault();
                      void getPlayTargetForItem(play.playItem).then((target) =>
                        navigate(target),
                      );
                    }}
                    className={`relative inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-white px-4 text-[0.9375rem] font-bold text-zinc-950 shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_14px_32px_-10px_rgba(0,0,0,0.65),0_2px_8px_rgba(0,0,0,0.25)] transition-transform duration-200 active:scale-[0.97] ${FOCUS}`}
                  >
                    <Play size={18} fill="currentColor" className="shrink-0" />
                    <span className="truncate">{play.shortPlayLabel}</span>
                    {play.progress ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-6 bottom-[6px] h-[2px] overflow-hidden rounded-full bg-zinc-950/[0.12]"
                      >
                        <span
                          className="block h-full rounded-full bg-zinc-950"
                          style={{
                            width: `${Math.max(3, play.progress.share * 100)}%`,
                          }}
                        />
                      </span>
                    ) : null}
                  </a>
                ) : (
                  <Link
                    to={getRouteForItem(frontItem)}
                    className={`inline-flex h-11 min-w-0 flex-1 items-center justify-center rounded-full bg-white px-4 text-[0.9375rem] font-bold text-zinc-950 ${FOCUS}`}
                  >
                    <span className="truncate">{t("common.details")}</span>
                  </Link>
                )}
                <FavouriteButton
                  item={frontItem}
                  iconSize={19}
                  className={`${ROUND} ${GLASS} text-white ${FOCUS}`}
                />
                {count > 1 ? (
                  <button
                    type="button"
                    aria-label={isPaused ? t("hero.resume") : t("hero.pause")}
                    onClick={() => setIsPaused((current) => !current)}
                    className={`${ROUND} ${GLASS} text-white ${FOCUS}`}
                  >
                    {isPaused ? (
                      <Play size={16} fill="currentColor" />
                    ) : (
                      <Pause size={16} fill="currentColor" />
                    )}
                  </button>
                ) : null}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* For a keyboard and assistive technology, which cannot swipe; they
            show themselves while they hold the focus. */}
        {count > 1 ? (
          <div className="absolute inset-x-0 top-1/3 z-50 flex justify-between px-2">
            <button
              type="button"
              aria-label={t("hero.previous")}
              onClick={() => goTo(frontRef.current - 1)}
              className={`sr-only focus-visible:not-sr-only ${ROUND} ${GLASS} text-white ${FOCUS}`}
            >
              <ChevronLeft size={18} strokeWidth={2.4} />
            </button>
            <button
              type="button"
              aria-label={t("hero.next")}
              onClick={() => goTo(frontRef.current + 1)}
              className={`sr-only focus-visible:not-sr-only ${ROUND} ${GLASS} text-white ${FOCUS}`}
            >
              <ChevronRight size={18} strokeWidth={2.4} />
            </button>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {`${mod(front, count) + 1} / ${count}: ${title}`}
        </p>
      </div>
    </PhoneHeroFrame>
  );
}
