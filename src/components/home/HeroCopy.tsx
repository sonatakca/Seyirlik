import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useBake } from "../../lib/timeline/bake";
import type { ValueSource } from "../../lib/timeline/curve";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatRuntime } from "../../lib/format";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import {
  logoShadowFor,
  measureBackdropLuminance,
  type SampleRegion,
} from "../../lib/logoShadow";
import { getPlayTargetForItem } from "../../lib/playTarget";
import { getRouteForItem } from "../../lib/routes";
import type { MediaItem } from "../../lib/types";
import { getStageImageCandidates } from "../hero/heroModel";
import { Tooltip } from "../ui/Tooltip";
import { HeroActions, heroPlayState } from "./HeroActions";
import { sampleUrl } from "./logoShadowStyle";
import { copyShadowFor } from "./heroCopyShadow";
import {
  measureWords,
  useReportedSize,
  type DrawnSize,
} from "./useReportedSize";
import {
  COPY_ROWS,
  HERO_MOTION,
  heroDock,
  queueSlots,
  type HeroLayout,
  type StageSize,
} from "./homeHeroModel";

/**
 * The copy that sits under a hero's title, bottom-left: the facts, the
 * overview on request, and the ways in. Shared by the home hero and a
 * title's own page, so both read and behave alike.
 */

/** Room the hover target keeps around the copy and the title it covers. */
const HOVER_ROOM_PX = { side: 16, top: 12 };

/**
 * The title and its copy, as one hover target, no wider than the overview's
 * lines or the title as drawn and no taller than the drawn title. It reaches
 * up over the resting title, so resting the pointer on it opens the
 * overview; once open it also covers the risen, grown title.
 */
export function HeroCopyBlock({
  stage,
  layout,
  item,
  overview,
  isOverviewOpen,
  onHoverIntent,
  onFocusWithin,
  onToggleOverview,
  onShowDetails,
  reduceMotion,
  smartContinueItems,
  titleSize,
  withQueue = true,
  dockAside,
}: {
  stage: StageSize;
  layout: HeroLayout;
  /** False on a title's own page: no queue, so the dock stands at the right. */
  withQueue?: boolean;
  /**
   * A bar over the dock, flush with its right edge (a title page's watched
   * button and trailer controls). It keeps its place while the dock is away
   * for the trailer.
   */
  dockAside?: ReactNode;
  /** The title the copy describes; null while it is between titles. */
  item: MediaItem | null;
  /**
   * The title as drawn at full size, once measured; until then the target
   * covers the title's whole box.
   */
  titleSize?: DrawnSize | null;
  overview: ValueSource;
  isOverviewOpen: boolean;
  /** The pointer has rested on the title (true), or left it (false). */
  onHoverIntent: (open: boolean) => void;
  onFocusWithin: (focused: boolean) => void;
  onToggleOverview: () => void;
  /** Where "Details" goes when the title's details are further down this page. */
  onShowDetails?: () => void;
  reduceMotion: boolean;
  smartContinueItems: MediaItem[];
}) {
  const overviewId = useId();
  const dock = heroDock(stage, { withQueue });
  // The dock is taller with "start over"; the bar over it follows its real
  // height, and keeps the last one while the dock is gone.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = dockRef.current;
    if (!node || !dockAside) return undefined;
    const measure = () => {
      if (node.offsetHeight > 0) setDockHeight(node.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [dockAside, layout.form]);
  const [copyWidth, setCopyWidth] = useState<number | null>(null);
  const title = titleSize ?? layout.title;
  const titleScale = isOverviewOpen
    ? layout.titleScale.open
    : layout.titleScale.rest;
  return (
    <>
      <div
        className="absolute z-[6]"
        style={{
          left: layout.copy.left - HOVER_ROOM_PX.side,
          bottom: layout.copy.bottom,
          width:
            Math.max(copyWidth ?? layout.copy.width, title.width * titleScale) +
            HOVER_ROOM_PX.side * 2,
          // The resting title and its copy; while open, the risen, full-size
          // title too, so the pointer can move onto it without closing it.
          height:
            layout.title.bottom -
            layout.copy.bottom +
            HOVER_ROOM_PX.top +
            title.height * titleScale +
            (isOverviewOpen ? layout.overviewLift : 0),
          pointerEvents: item ? "auto" : "none",
        }}
        onMouseEnter={() => onHoverIntent(true)}
        onMouseLeave={() => onHoverIntent(false)}
        onFocus={(event) => {
          if (event.target.matches(":focus-visible")) onFocusWithin(true);
        }}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            onFocusWithin(false);
        }}
      >
        {/* The copy's rows are as wide as its column and reach past the
            target's edge; only the target itself answers the pointer. */}
        <div
          className="pointer-events-none absolute"
          style={{
            left: HOVER_ROOM_PX.side,
            bottom: 0,
            width: layout.copy.width,
            height: layout.copy.height,
          }}
        >
          <AnimatePresence mode="wait">
            {item ? (
              <HeroCopy
                key={item.Id}
                item={item}
                stage={stage}
                layout={layout}
                factsRegion={{
                  left: layout.copy.left / stage.width,
                  top:
                    1 -
                    (layout.copy.bottom + layout.copy.height) / stage.height,
                  width: Math.min(layout.factsWidth, 340) / stage.width,
                  height: COPY_ROWS.factsPx / stage.height,
                }}
                overviewId={overviewId}
                overview={overview}
                isOverviewOpen={isOverviewOpen}
                onToggleOverview={onToggleOverview}
                onShowDetails={onShowDetails}
                reduceMotion={reduceMotion}
                smartContinueItems={smartContinueItems}
                onLinesWidth={setCopyWidth}
              />
            ) : null}
          </AnimatePresence>
        </div>
      </div>
      {layout.form === "wide" ? (
        <div
          ref={dockRef}
          className="absolute z-[6]"
          style={{
            left: dock.left,
            top: withQueue ? queueSlots(stage)[0]?.y : undefined,
            bottom: withQueue ? undefined : dock.bottom,
            width: dock.width,
          }}
        >
          <AnimatePresence mode="wait">
            {item ? (
              <HeroDock
                key={item.Id}
                item={item}
                smartContinueItems={smartContinueItems}
                compact={dock.compact}
                reduceMotion={reduceMotion}
                overviewId={overviewId}
                isOverviewOpen={isOverviewOpen}
                onToggleOverview={onToggleOverview}
                onShowDetails={onShowDetails}
              />
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
      {layout.form === "wide" && dockAside ? (
        <div
          className="absolute z-[6]"
          style={{
            right: stage.width - dock.left - dock.width,
            bottom:
              dock.bottom + (dockHeight ?? dock.height) + DOCK_ASIDE_GAP_PX,
          }}
        >
          {dockAside}
        </div>
      ) : null}
    </>
  );
}

/** Between the dock and the bar over it. */
export const DOCK_ASIDE_GAP_PX = 10;

export function HeroControlButton({
  label,
  onClick,
  disabled,
  touch = false,
  className = "",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A phone's control: a full 44px touch target. */
  touch?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label} placement="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={`${touch ? "h-11 w-11" : "h-9 w-9"} ${className} flex items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.12] hover:text-white active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * Room around the overview's reveal for its text's shade: the sides and top
 * get the shade's full reach, the foot only as much as the gap above the
 * actions allows.
 *
 * The reveal still needs an edge there, because the overview rises from
 * under the facts and must not show below them over the actions, but the
 * edge is a fade, not a cut: the foot fades out over its whole height, so a
 * line rising through it fades in, and the last line's shadow at rest thins
 * out instead of stopping in a straight line. The text itself ends where the
 * fade begins, so it is never dimmed at rest.
 */
const OVERVIEW_SHADE_ROOM_PX = 40;
const OVERVIEW_SHADE_FOOT_PX = 12;
const OVERVIEW_REVEAL_MASK = `linear-gradient(to bottom, #000 calc(100% - ${OVERVIEW_SHADE_FOOT_PX}px), transparent 100%)`;

/**
 * How bright the copy under the title needs to be, 0–1, from the brightness
 * of the artwork behind its facts line: resting over a dark picture, full
 * over a white sky. It starts in the middle, so nothing flashes unreadable while
 * the artwork is measured.
 */
function useCopyShade(
  item: MediaItem,
  stage: StageSize,
  layout: HeroLayout,
  region: SampleRegion,
): number {
  const [shade, setShade] = useState(0.5);
  const url = getStageImageCandidates(item, layout.form, stage.width)[0]?.url;
  const { left, top, width, height } = region;
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    void measureBackdropLuminance(sampleUrl(url), {
      left,
      top,
      width,
      height,
    }).then((luminance) => {
      if (cancelled) return;
      setShade(luminance === null ? 0.5 : logoShadowFor(1, luminance).strength);
    });
    return () => {
      cancelled = true;
    };
  }, [url, left, top, width, height]);
  // On a tall stage the copy stands where the picture has sunk into the
  // room, so it needs little more than its resting shadow.
  return layout.form === "tall" ? Math.min(shade, 0.35) : shade;
}

/**
 * White copy set straight on the artwork, brighter the more the picture
 * behind it needs, always on a black cloud of its own shape. The cloud
 * follows the letters, so it shades the words and nothing around them.
 *
 * Over bright art the cloud is denser; over dark art lighter and wider. A
 * one-pixel black edge was tried and read as an outline, too heavy and too
 * sharp on a real screen. Which one comes from the brightness measured
 * behind the facts line (`useCopyShade`), and until that arrives the copy
 * stands on the dark-art one.
 *
 * It is a filter, not a text shadow, because a filter is drawn after the
 * text is truncated and clamped: a text shadow is clipped with the text, and
 * ends in a rectangle. The widest blur, 20px, fits the overview's room
 * (OVERVIEW_SHADE_ROOM_PX).
 */
function copyTextStyle(shade: number, restingAlpha: number): CSSProperties {
  const a = (value: number) => value.toFixed(3);
  return {
    color: `rgba(255,255,255,${a(restingAlpha + (0.97 - restingAlpha) * shade)})`,
    filter: copyShadowFor(shade),
  };
}

/** What to show under the title: facts, a few lines of story, and the ways in. */
function HeroCopy({
  item,
  stage,
  layout,
  factsRegion,
  overviewId,
  overview,
  isOverviewOpen,
  onToggleOverview,
  onShowDetails,
  reduceMotion,
  smartContinueItems,
  onLinesWidth,
}: {
  item: MediaItem;
  stage: StageSize;
  layout: HeroLayout;
  /** How wide the copy's lines are drawn: the overview's, or the facts'. */
  onLinesWidth: (width: number) => void;
  /** Where the facts line lies over the artwork, as shares of it. */
  factsRegion: SampleRegion;
  overviewId: string;
  /** 0–1: the overview opening under the facts. */
  overview: ValueSource;
  isOverviewOpen: boolean;
  onToggleOverview: () => void;
  /** Where "Details" goes when the title's details are further down this page. */
  onShowDetails?: () => void;
  reduceMotion: boolean;
  smartContinueItems: MediaItem[];
}) {
  const { language, t } = useLanguage();
  const shade = useCopyShade(item, stage, layout, factsRegion);
  const metadata = getItemDisplayMetadata(item, language);
  const reportWidth = (size: DrawnSize) => onLinesWidth(size.width);
  // The overview wraps within its own measure, so its box is its lines'
  // width; the facts line is a block as wide as the copy, so its words are
  // measured.
  const overviewRef = useReportedSize<HTMLParagraphElement>(
    metadata.overview ? reportWidth : undefined,
  );
  const factsRef = useReportedSize<HTMLParagraphElement>(
    metadata.overview ? undefined : reportWidth,
    measureWords,
  );
  const labels = {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  };
  const runtime = formatRuntime(item.RunTimeTicks, labels);
  const facts = [
    item.ProductionYear,
    runtime,
    item.Genres?.filter(Boolean).slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");

  // The facts ride up with the title as the overview opens, and the
  // overview comes up from under them as they rise off it: both baked from
  // the overview's course, so the compositor plays them.
  const factsRowRef = useRef<HTMLDivElement>(null);
  const overviewTextRef = useRef<HTMLParagraphElement | null>(null);
  const overviewTravel = layout.overviewHeight + OVERVIEW_SHADE_FOOT_PX;
  useBake(
    [overview],
    (at) => {
      const value = overview.get(at);
      return [
        [
          factsRowRef.current,
          { transform: `translateY(${-value * layout.overviewLift}px)` },
        ],
        [
          overviewTextRef.current,
          {
            transform: `translateY(${overviewTravel * (1 - value)}px)`,
            opacity: value,
          },
        ],
      ];
    },
    [layout.overviewLift, overviewTravel, Boolean(metadata.overview)],
  );

  // The copy changes with the title by fading in place: only the title and
  // the artwork travel.
  const line = (index: number) => ({
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: {
        duration: reduceMotion ? 0.2 : HERO_MOTION.copyEnterS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyEnterStaggerS,
        ease: "easeOut" as const,
      },
    },
    exit: {
      opacity: 0,
      transition: {
        duration: reduceMotion ? 0.15 : HERO_MOTION.copyExitS,
        delay: reduceMotion ? 0 : index * HERO_MOTION.copyExitStaggerS,
        ease: "easeIn" as const,
      },
    },
  });

  return (
    <motion.div
      className="relative h-full"
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {/* Fixed rows: the title above sits at the same height for every
          title. The facts ride up with the title as the overview opens. */}
      <div
        ref={factsRowRef}
        className="absolute inset-x-0 top-0"
        style={{ height: COPY_ROWS.factsPx }}
      >
        <motion.p
          ref={factsRef}
          variants={line(0)}
          className="truncate text-[0.8125rem] font-bold leading-5 tracking-[0.04em]"
          style={{ ...copyTextStyle(shade, 0.72), maxWidth: layout.factsWidth }}
        >
          {facts}
        </motion.p>
      </div>
      {metadata.overview ? (
        <div
          id={overviewId}
          className="pointer-events-none absolute overflow-hidden"
          style={{
            // The reveal's clip, widened by the room the text's shade needs,
            // and soft along the foot (see OVERVIEW_SHADE_FOOT_PX).
            WebkitMaskImage: OVERVIEW_REVEAL_MASK,
            maskImage: OVERVIEW_REVEAL_MASK,
            left: -OVERVIEW_SHADE_ROOM_PX,
            right: -OVERVIEW_SHADE_ROOM_PX,
            bottom:
              (layout.form === "wide"
                ? 0
                : COPY_ROWS.actionsPx + layout.actionsGap) -
              OVERVIEW_SHADE_FOOT_PX,
            height:
              layout.overviewHeight +
              OVERVIEW_SHADE_ROOM_PX +
              OVERVIEW_SHADE_FOOT_PX,
            padding: `${OVERVIEW_SHADE_ROOM_PX}px ${OVERVIEW_SHADE_ROOM_PX}px ${OVERVIEW_SHADE_FOOT_PX}px`,
          }}
        >
          <p
            ref={(element) => {
              overviewRef(element);
              overviewTextRef.current = element;
            }}
            className="line-clamp-3 max-w-[46ch] font-semibold"
            style={{
              ...copyTextStyle(shade, 0.8),
              fontSize: layout.overviewFontPx,
              lineHeight: COPY_ROWS.overviewLineHeight,
            }}
          >
            {metadata.overview}
          </p>
        </div>
      ) : null}
      {layout.form === "tall" ? (
        <div
          className="pointer-events-auto absolute bottom-0"
          style={{
            width: heroDock(stage).width,
            left: (layout.copy.width - heroDock(stage).width) / 2,
          }}
        >
          <HeroDock
            item={item}
            smartContinueItems={smartContinueItems}
            compact
            reduceMotion={reduceMotion}
            overviewId={overviewId}
            isOverviewOpen={isOverviewOpen}
            onToggleOverview={onToggleOverview}
            onShowDetails={onShowDetails}
          />
        </div>
      ) : null}
    </motion.div>
  );
}

/** The centre dock has its own hit area, independent of the logo's hover. */
function HeroDock({
  item,
  smartContinueItems,
  compact,
  reduceMotion,
  overviewId,
  isOverviewOpen,
  onToggleOverview,
  onShowDetails,
}: {
  item: MediaItem;
  smartContinueItems: MediaItem[];
  compact: boolean;
  reduceMotion: boolean;
  overviewId: string;
  isOverviewOpen: boolean;
  onToggleOverview: () => void;
  onShowDetails?: () => void;
}) {
  const { language, t } = useLanguage();
  const navigate = useNavigate();
  const { playItem, playLabel, shortPlayLabel, canStartOver, progress } =
    heroPlayState(item, smartContinueItems, t);
  const playTo =
    playItem.Type === "Series"
      ? getRouteForItem(playItem)
      : `/watch/${playItem.Id}`;
  const handlePlay = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(await getPlayTargetForItem(playItem));
  };
  const fade = {
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: { duration: reduceMotion ? 0 : HERO_MOTION.copyEnterS },
    },
    exit: {
      opacity: 0,
      transition: { duration: reduceMotion ? 0 : HERO_MOTION.copyExitS },
    },
  };
  return (
    <motion.div initial="initial" animate="animate" exit="exit">
      <HeroActions
        item={item}
        playTo={playTo}
        playLabel={playLabel}
        shortPlayLabel={shortPlayLabel}
        onPlay={handlePlay}
        startOverTo={
          canStartOver
            ? `${playTo}${playTo.includes("?") ? "&" : "?"}start=0`
            : null
        }
        detailsTo={getRouteForItem(item)}
        progress={progress}
        overviewId={overviewId}
        hasOverview={Boolean(getItemDisplayMetadata(item, language).overview)}
        isOverviewOpen={isOverviewOpen}
        onToggleOverview={onToggleOverview}
        onShowDetails={onShowDetails}
        compact={compact}
        fade={fade}
      />
    </motion.div>
  );
}
