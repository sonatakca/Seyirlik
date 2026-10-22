import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Curve } from "../../lib/timeline/curve";
import { Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getHeroPreviewUrl } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import {
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "../hero/heroModel";
import { HeroComposition, createCompositionMotion } from "./HeroComposition";
import { NavbarVeil } from "./NavbarVeil";
import { BackButton } from "../BackButton";
import { HeroControlButton, HeroCopyBlock } from "./HeroCopy";
import type { DrawnSize } from "./useReportedSize";
import {
  HERO_HEIGHT_CLASS,
  HERO_MOTION,
  HERO_TRAILER_DELAY_MS,
  TITLE_BACK_TOP_PX,
  TITLE_SCALE,
  heroDock,
  heroLayout,
  queueSlots,
  stagePlacement,
  type HeroFit,
  type StageSize,
} from "./homeHeroModel";
import { useSmartContinueItems } from "./useSmartContinueItems";
import { useHeroCentreDock } from "./heroCentreDock";

/**
 * A title's own hero, on its film or series page: the home hero's stage with
 * nothing queued. The same composition, bands, logo, copy and actions, the
 * overview on request and the trailer after a while; there is no rotation,
 * so there is nothing to travel.
 */
export function TitleHero({
  item,
  onShowDetails,
  isRevealed = true,
  fit = "screen",
  trailers = true,
  backTo,
  onWatchedSlot,
}: {
  item: MediaItem;
  /** Where the back button goes with no history to return through. */
  backTo?: string;
  /** Receives the place, beside the dock, for the page's watched button. */
  onWatchedSlot?: (slot: HTMLSpanElement | null) => void;
  /** The screen, or (phone and tablet) the screen above the tab bar. */
  fit?: HeroFit;
  /** Whether the title's trailer may start once its artwork has had a moment. */
  trailers?: boolean;
  /** Scrolls to the title's details further down its page. */
  onShowDetails: () => void;
  /**
   * False while the page keeps the hero hidden behind its skeleton. Nothing
   * fades in until then, or the fades would play unseen and the artwork
   * would arrive at full strength the moment the skeleton goes.
   */
  isRevealed?: boolean;
}) {
  const { t } = useLanguage();
  const reduceMotion = Boolean(useReducedMotion());
  const renderCentreDock = useHeroCentreDock();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  const [isArtworkLoaded, setIsArtworkLoaded] = useState(false);
  const isArtworkReady = isArtworkLoaded && isRevealed;
  const smartContinueItems = useSmartContinueItems();
  // One composition for as long as the page shows this title; the page
  // mounts a new hero for a new title.
  const [composition] = useState(() =>
    createCompositionMotion(stagePlacement(), 0),
  );

  // ---------------------------------------------------------------- measure
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const measure = () => {
      const next = { width: section.clientWidth, height: section.clientHeight };
      setStage((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  const layout = stage ? heroLayout(stage, { withQueue: false }) : null;
  const titleScale = layout?.titleScale ?? TITLE_SCALE;
  const slotScale =
    stage && layout ? queueSlots(stage)[0]!.width / stage.width : 0.12;

  // --------------------------------------------------------- the overview
  const [isOverviewHovered, setIsOverviewHovered] = useState(false);
  /** The title as drawn, for the copy's hover target. */
  const [titleSize, setTitleSize] = useState<
    (DrawnSize & { id: string }) | null
  >(null);
  const [isOverviewPinned, setIsOverviewPinned] = useState(false);
  const [isOverviewFocused, setIsOverviewFocused] = useState(false);
  const isOverviewOpen =
    isOverviewHovered || isOverviewPinned || isOverviewFocused;
  const [overview] = useState(() => new Curve(0));
  const overviewLift = layout?.overviewLift ?? 0;
  const closeOverview = useCallback(() => {
    setIsOverviewHovered(false);
    setIsOverviewPinned(false);
    setIsOverviewFocused(false);
  }, []);
  // The composition is made before the stage is measured; once its shape is
  // known the title takes that shape's resting size and rise.
  useEffect(() => {
    const value = overview.get();
    composition.titleY.set(-value * overviewLift);
    composition.titleScale.set(
      titleScale.rest + (titleScale.open - titleScale.rest) * value,
    );
  }, [composition, overview, overviewLift, titleScale]);
  // One course drives the title's rise and growth and the copy's, as at home:
  // each is linear in the overview, so it is tweened on the same duration and
  // curve from where it stands.
  useEffect(() => {
    const open = isOverviewOpen ? 1 : 0;
    const options = {
      duration: reduceMotion ? 0 : HERO_MOTION.overviewS,
      ease: HERO_MOTION.travelEase,
    };
    const controls = overview.tween(open, options);
    composition.titleY.tween(-open * overviewLift, options);
    composition.titleScale.tween(
      titleScale.rest + (titleScale.open - titleScale.rest) * open,
      options,
    );
    return () => controls.stop();
    // Only the overview opening or closing sets it moving; a new shape is
    // taken up by the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOverviewOpen, overview, reduceMotion]);

  // ---------------------------------------------------------- the trailer
  const [areTrailersEnabled, setAreTrailersEnabled] = useState(
    readHeroTrailersEnabledPreference,
  );
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  const [isTrailerMuted, setIsTrailerMuted] = useState(true);
  const [hasTrailerPlayed, setHasTrailerPlayed] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    let cancelled = false;
    if (!trailers) return undefined;
    void getHeroPreviewUrl(item)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [item, trailers]);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) =>
        setIsInView(
          Boolean(entry?.isIntersecting && entry.intersectionRatio > 0.35),
        ),
      { threshold: [0, 0.35, 0.6] },
    );
    observer.observe(section);
    const onVisibility = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Artwork and copy first; then, once, the title steps back and the picture
  // starts moving. Reading the overview holds it off.
  useEffect(() => {
    if (
      !trailerUrl ||
      !areTrailersEnabled ||
      hasTrailerPlayed ||
      !isArtworkReady ||
      isOverviewOpen
    )
      return undefined;
    const timer = window.setTimeout(() => {
      setHasTrailerPlayed(true);
      setIsTrailerPlaying(true);
    }, HERO_TRAILER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    areTrailersEnabled,
    hasTrailerPlayed,
    isArtworkReady,
    isOverviewOpen,
    trailerUrl,
  ]);

  useEffect(() => {
    const options = {
      duration: reduceMotion ? 0 : 0.8,
      ease: HERO_MOTION.travelEase,
    };
    void composition.trailer.tween(isTrailerPlaying ? 1 : 0, options);
    void composition.titleScale.tween(
      isTrailerPlaying ? titleScale.trailer : titleScale.rest,
      options,
    );
  }, [composition, isTrailerPlaying, reduceMotion, titleScale]);

  const endTrailer = useCallback(() => setIsTrailerPlaying(false), []);
  const copyItem = isArtworkReady && !isTrailerPlaying ? item : null;

  const sideBar = (
    <motion.div
      className="hero-dock-bar text-white"
      data-hide-empty
      initial={{ opacity: 0 }}
      animate={{ opacity: isArtworkReady ? 1 : 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.5, ease: "easeOut" }}
    >
      {onWatchedSlot ? <span ref={onWatchedSlot} className="contents" /> : null}
      {trailerUrl ? (
        <HeroControlButton
          label={
            areTrailersEnabled
              ? t("hero.disableTrailers")
              : t("hero.enableTrailers")
          }
          onClick={() => {
            const next = !areTrailersEnabled;
            saveHeroTrailersEnabledPreference(next);
            setAreTrailersEnabled(next);
            if (!next) setIsTrailerPlaying(false);
          }}
        >
          {areTrailersEnabled ? <Video size={16} /> : <VideoOff size={16} />}
        </HeroControlButton>
      ) : null}
      {trailerUrl && isTrailerPlaying ? (
        <HeroControlButton
          label={isTrailerMuted ? t("player.unmute") : t("player.mute")}
          onClick={() => setIsTrailerMuted((current) => !current)}
        >
          {isTrailerMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </HeroControlButton>
      ) : null}
    </motion.div>
  );

  // --------------------------------------------------------------- render
  return (
    <section
      ref={sectionRef}
      className={`seyirlik-hero-stage relative mx-4 mt-2 mb-4 w-[calc(100%-2rem)] rounded-2xl overflow-hidden bg-[#050607] ${HERO_HEIGHT_CLASS[fit]}`}
    >
      <NavbarVeil />
      {stage && layout ? (
        <HeroComposition
          item={item}
          stage={stage}
          titleBox={layout.title}
          logoMaxHeight={
            stage.height -
            layout.menuClearance -
            layout.title.bottom -
            layout.overviewLift
          }
          motion={composition}
          slotScale={slotScale}
          titleRestScale={titleScale.rest}
          zIndex={1}
          isStage
          trailerUrl={trailerUrl}
          isTrailerPlaying={isTrailerPlaying && isInView && isDocumentVisible}
          isTrailerMuted={isTrailerMuted}
          onTrailerEnded={endTrailer}
          onArtworkReady={() => setIsArtworkLoaded(true)}
          onTitleSize={(size) => setTitleSize({ id: item.Id, ...size })}
          isRevealed={isRevealed}
        />
      ) : null}

      {layout && stage ? (
        <HeroCopyBlock
          stage={stage}
          layout={layout}
          item={copyItem}
          titleSize={titleSize?.id === item.Id ? titleSize : null}
          overview={overview}
          isOverviewOpen={isOverviewOpen}
          onHoverIntent={setIsOverviewHovered}
          onFocusWithin={setIsOverviewFocused}
          onToggleOverview={() => {
            if (isOverviewOpen) closeOverview();
            else setIsOverviewPinned(true);
          }}
          onShowDetails={onShowDetails}
          reduceMotion={reduceMotion}
          smartContinueItems={smartContinueItems}
          withQueue={false}
          dockAside={sideBar}
        />
      ) : null}

      {backTo && layout ? (
        <BackButton
          variant="dock"
          fallbackTo={backTo}
          className="absolute z-[6]"
          style={{ left: layout.copy.left, top: TITLE_BACK_TOP_PX }}
        />
      ) : null}

      {/* A centre dock the page asked for (an administrator's tools), level
          with the watch dock: its width and its foot, in the stage's middle. */}
      {renderCentreDock && layout && stage && layout.form === "wide"
        ? (() => {
            const dock = heroDock(stage, { withQueue: false });
            return (
              <div
                className="absolute z-[7]"
                style={{
                  left: (stage.width - dock.width) / 2,
                  bottom: dock.bottom,
                  width: dock.width,
                }}
              >
                {renderCentreDock({
                  width: dock.width,
                  compact: dock.compact,
                  stageHeight: stage.height,
                })}
              </div>
            );
          })()
        : null}

      {/* The title's lesser actions, on the dock's glass: over the dock
          where it stands at the right, else under the menu at the right. */}
      {layout && layout.form === "tall" ? (
        <div
          className="absolute z-[6]"
          style={{ right: layout.copy.left, top: TITLE_BACK_TOP_PX }}
        >
          {sideBar}
        </div>
      ) : null}
    </section>
  );
}
