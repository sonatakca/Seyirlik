import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import { DwellClock } from "../../lib/dwellClock";
import { useBake } from "../../lib/timeline/bake";
import { Curve, derive, type TweenControls } from "../../lib/timeline/curve";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import { getHeroPreviewUrl } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";
import { HeroControlButton, HeroCopyBlock } from "./HeroCopy";
import type { DrawnSize } from "./useReportedSize";
import { NavbarVeil } from "./NavbarVeil";
import { useSmartContinueItems } from "./useSmartContinueItems";
import {
  getHeroImageCandidates,
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "../hero/heroModel";
import {
  HomeHeroSkeletonBackdrop,
  HomeHeroSkeletonPieces,
} from "./HomeHeroSkeleton";
import {
  HeroComposition,
  createCompositionMotion,
  type CompositionMotion,
} from "./HeroComposition";
import {
  HERO_DWELL_MS,
  HERO_HEIGHT_CLASS,
  HERO_MOTION,
  HERO_TRAILER_DELAY_MS,
  QUEUE_LENGTH,
  TITLE_SCALE,
  arrivalPlacement,
  droppedPlacement,
  heroLayout,
  liftDurationS,
  previousIndex,
  pushedBackPlacement,
  queueCount,
  queueIndices,
  queueSlots,
  sharedDurationS,
  slotPlacement,
  stagePlacement,
  type HeroFit,
  type Placement,
  type StageSize,
  type TitleScale,
} from "./homeHeroModel";

/**
 * The home page's hero: a stage with its queue in view.
 *
 * The title on stage fills the frame; the next three wait bottom-right as the
 * same compositions, scaled down. When a title's time is up the first of them
 * lifts out of the queue and grows over the stage while the one it replaces
 * recedes beneath it, and the queue closes up behind, a newcomer sliding in
 * from beyond the frame's edge. Going back is the same move reversed: the
 * title on stage shrinks back into the head of the queue, uncovering the one
 * before it. Nothing is swapped in place; every change is something moving
 * from where it was to where it goes.
 */

type Role = "stage" | "under" | "rising" | "queue" | "leaving";

interface Layer {
  id: string;
  role: Role;
}

const Z: Record<Role, number> = {
  under: 1,
  stage: 2,
  rising: 3,
  queue: 4,
  leaving: 4,
};

/** The queue's resting shade: none, the miniatures show their artwork clean. */
const QUEUE_DIM = 0;

/**
 * A swipe across the stage: how far a finger must travel, and how much more
 * sideways than up or down, before it changes the title. While it moves the
 * title on stage gives a little way under it, at a fraction of the finger's
 * travel and never past `SWIPE_GIVE_MAX_PX`, so the stage is felt to be the
 * thing being pushed.
 */
const SWIPE_DISTANCE_PX = 56;
const SWIPE_VELOCITY_PX_PER_MS = 0.45;
const SWIPE_GIVE = 0.22;
const SWIPE_GIVE_MAX_PX = 44;

interface HomeHeroProps {
  items: MediaItem[];
  onReady?: () => void;
  /**
   * How tall the hero stands: the whole screen, or (the phone and tablet
   * pages) the screen above the tab bar, so the actions are never under it.
   */
  fit?: HeroFit;
  /** Whether a title's trailer may start after its artwork has had a moment. */
  trailers?: boolean;
}

function uniqueById(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) =>
    seen.has(item.Id) ? false : (seen.add(item.Id), true),
  );
}

interface Timing {
  duration: number;
  delay?: number;
  ease: [number, number, number, number];
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function run(controls: TweenControls): Promise<void> {
  return controls.finished.then(
    () => undefined,
    () => undefined,
  );
}

export function HomeHero({
  items: rawItems,
  onReady,
  fit = "screen",
  trailers = true,
}: HomeHeroProps) {
  const { language, t } = useLanguage();
  const reduceMotion = Boolean(useReducedMotion());
  // The page recomputes its pool as the catalogue arrives, often to the same
  // titles in the same order. The hero keys on which titles, not on which
  // array, or every recomputation would restart it.
  const itemsKey = rawItems.map((item) => item.Id).join("|");
  const itemsRef = useRef<MediaItem[]>([]);
  const items = useMemo(() => {
    itemsRef.current = uniqueById(rawItems);
    return itemsRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);
  const total = items.length;
  const itemsById = useMemo(
    () => new Map(items.map((item) => [item.Id, item])),
    [items],
  );

  const sectionRef = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<StageSize | null>(null);
  const stageRef = useRef<StageSize | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const stageIndexRef = useRef(0);
  const [layers, setLayers] = useState<Layer[]>([]);
  const motions = useRef(new Map<string, CompositionMotion>());
  const busyRef = useRef(false);
  const [copyItemId, setCopyItemId] = useState<string | null>(null);
  const [hasOpened, setHasOpened] = useState(false);
  // The loading skeleton stays over the hero until the first artwork is in,
  // then fades; its pieces sit exactly where the real ones do.
  const [isArtworkReady, setIsArtworkReady] = useState(false);
  const [isSkeletonGone, setIsSkeletonGone] = useState(false);
  const [isTravelling, setIsTravelling] = useState(false);
  const readyRef = useRef(false);

  const [isPaused, setIsPaused] = useState(false);
  const [isInView, setIsInView] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );
  const [clock] = useState(() => new DwellClock(HERO_DWELL_MS));

  const [areTrailersEnabled, setAreTrailersEnabled] = useState(
    readHeroTrailersEnabledPreference,
  );
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [isTrailerPlaying, setIsTrailerPlaying] = useState(false);
  const [isTrailerMuted, setIsTrailerMuted] = useState(true);
  const trailerDoneRef = useRef(false);
  /** Titles whose trailer has already played on this visit to the page. */
  const trailersSeen = useRef(new Set<string>());

  // The overview opens only when asked for: a pointer resting on the title,
  // focus inside its copy, or its button. It closes whenever the title leaves.
  const [isOverviewHovered, setIsOverviewHovered] = useState(false);
  /** The stage title as drawn, for the copy's hover target. */
  const [stageTitle, setStageTitle] = useState<
    (DrawnSize & { id: string }) | null
  >(null);
  const [isOverviewPinned, setIsOverviewPinned] = useState(false);
  const [isOverviewFocused, setIsOverviewFocused] = useState(false);
  const isOverviewOpen =
    isOverviewHovered || isOverviewPinned || isOverviewFocused;
  const [overview] = useState(() => new Curve(0));
  const overviewLiftRef = useRef(0);
  // On a tall stage the overview opens across the queue's row, so the queue
  // steps aside for it on the same value.
  const isTallRef = useRef(false);
  const queueFade = useMemo(
    () => derive([overview], (value) => (isTallRef.current ? 1 - value : 1)),
    [overview],
  );
  const closeOverview = useCallback(() => {
    setIsOverviewHovered(false);
    setIsOverviewPinned(false);
    setIsOverviewFocused(false);
  }, []);

  // The title's scales depend on the stage's shape; the choreography reads
  // them from here, where the last render left them.
  const titleScaleRef = useRef<TitleScale>(TITLE_SCALE);

  const stageItem = items[stageIndex];
  // Once for the hero, not once per title: each title's copy asking again put
  // a page-loading bar on screen at every change.
  const smartContinueItems = useSmartContinueItems();

  // ---------------------------------------------------------------- measure
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const measure = () => {
      const next = { width: section.clientWidth, height: section.clientHeight };
      stageRef.current = next;
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

  const motionFor = useCallback((id: string, placement: Placement, dim = 0) => {
    let entry = motions.current.get(id);
    if (!entry) {
      entry = createCompositionMotion(
        placement,
        dim,
        titleScaleRef.current.rest,
      );
      motions.current.set(id, entry);
    }
    return entry;
  }, []);

  const place = (entry: CompositionMotion, placement: Placement) => {
    entry.x.set(placement.x);
    entry.y.set(placement.y);
    entry.scale.set(placement.scale);
  };

  // ------------------------------------------------- a new pool, or first run
  const stageReady = stage !== null;
  useEffect(() => {
    const size = stageRef.current;
    if (!size || total === 0) return;
    const slots = queueSlots(size);

    // Once the hero has opened, a new pool never restarts it: the pool grows
    // as the catalogue arrives, usually a few seconds in, and whatever is on
    // stage stays there while the queue re-forms around it.
    if (readyRef.current) {
      const currentId = layers.find((layer) => layer.role === "stage")?.id;
      const kept = currentId
        ? items.findIndex((item) => item.Id === currentId)
        : -1;
      const index = kept >= 0 ? kept : 0;
      const queueIds = queueIndices(index, total, queueCount(size)).map(
        (i) => items[i]!.Id,
      );
      const stageId = items[index]!.Id;
      for (const id of [...motions.current.keys()]) {
        if (id !== stageId && !queueIds.includes(id))
          motions.current.delete(id);
      }
      motionFor(stageId, stagePlacement());
      queueIds.forEach((id, position) => {
        const target = slotPlacement(size, slots[position]!);
        const existing = motions.current.get(id);
        if (existing) {
          const options = {
            duration: reduceMotion ? 0 : HERO_MOTION.slideS,
            ease: HERO_MOTION.slideEase,
          };
          void existing.x.tween(target.x, options);
          void existing.y.tween(target.y, options);
          void existing.scale.tween(target.scale, options);
        } else {
          const entry = motionFor(id, target, 1);
          void entry.dim.tween(QUEUE_DIM, {
            duration: reduceMotion ? 0 : 0.4,
            ease: "linear",
          });
        }
      });
      stageIndexRef.current = index;
      setStageIndex(index);
      setLayers([
        { id: stageId, role: "stage" },
        ...queueIds.map((id) => ({ id, role: "queue" as Role })),
      ]);
      return;
    }

    busyRef.current = false;
    motions.current.clear();
    stageIndexRef.current = 0;
    setStageIndex(0);
    const queue = queueIndices(0, total, queueCount(size));
    const first = items[0]!;
    motionFor(first.Id, stagePlacement());
    queue.forEach((index, position) => {
      motionFor(items[index]!.Id, slotPlacement(size, slots[position]!), 1);
    });
    setLayers([
      { id: first.Id, role: "stage" },
      ...queue.map((index) => ({
        id: items[index]!.Id,
        role: "queue" as Role,
      })),
    ]);
    setCopyItemId(null);
    clock.reset();
    // Only a different pool (or the first measurement) re-forms the hero;
    // `layers` is read, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, stageReady]);

  // A resize moves everything to where it now belongs, without animating.
  useEffect(() => {
    if (!stage || busyRef.current) return;
    const slots = queueSlots(stage);
    const queue = queueIndices(stageIndexRef.current, total, queueCount(stage));
    const stageId = items[stageIndexRef.current]?.Id;
    if (stageId) {
      const entry = motions.current.get(stageId);
      if (entry) place(entry, stagePlacement());
    }
    queue.forEach((index, position) => {
      const entry = motionFor(
        items[index]!.Id,
        slotPlacement(stage, slots[position]!),
        QUEUE_DIM,
      );
      place(entry, slotPlacement(stage, slots[position]!));
    });
    if (stageId)
      setLayers([
        { id: stageId, role: "stage" },
        ...queue.map((index) => ({
          id: items[index]!.Id,
          role: "queue" as Role,
        })),
      ]);
  }, [hasOpened, isTravelling, items, motionFor, stage, total]);

  // ------------------------------------------------------------ the opening
  const open = useCallback(async () => {
    const size = stageRef.current;
    if (!size || hasOpened || busyRef.current) return;
    busyRef.current = true;
    const slots = queueSlots(size);
    const queue = queueIndices(0, total, queueCount(size));
    const first = items[0];
    // No ceremony: the skeleton fades off as the artwork fades in, and the
    // copy and the queue fade up in the places their placeholders held.
    window.setTimeout(
      () => setCopyItemId(first?.Id ?? null),
      reduceMotion ? 0 : HERO_MOTION.openCopyDelayS * 1000,
    );
    queue.forEach((index, position) => {
      const entry = motions.current.get(items[index]!.Id);
      if (!entry) return;
      place(entry, slotPlacement(size, slots[position]!));
      void entry.dim.tween(QUEUE_DIM, {
        duration: reduceMotion ? 0 : 0.5,
        delay: reduceMotion ? 0 : HERO_MOTION.openQueueDelayS + position * 0.06,
        ease: "easeOut",
      });
    });
    await wait(reduceMotion ? 0 : (HERO_MOTION.openQueueDelayS + 0.7) * 1000);
    setHasOpened(true);
    busyRef.current = false;
  }, [hasOpened, items, reduceMotion, total]);

  const handleArtworkReady = useCallback(
    (id: string) => {
      if (id !== items[0]?.Id || readyRef.current) return;
      readyRef.current = true;
      setIsArtworkReady(true);
      onReady?.();
      void open();
    },
    [items, onReady, open],
  );

  // ------------------------------------------------------------ travelling
  const travel = useCallback(
    async (direction: "forward" | "backward", queuePosition = 0) => {
      const size = stageRef.current;
      if (!size || busyRef.current || total < 2 || !hasOpened) return;
      busyRef.current = true;
      setIsTravelling(true);
      setIsTrailerPlaying(false);
      closeOverview();
      clock.reset();

      const fromIndex = stageIndexRef.current;
      const oldQueue = queueIndices(fromIndex, total, queueCount(size));
      const toIndex =
        direction === "forward"
          ? oldQueue[Math.min(queuePosition, oldQueue.length - 1)]!
          : previousIndex(fromIndex, total);
      const newQueue = queueIndices(toIndex, total, queueCount(size));
      const slots = queueSlots(size);
      const outgoing = items[fromIndex]!;
      const incoming = items[toIndex]!;
      const newQueueIds = newQueue.map((index) => items[index]!.Id);
      const oldQueueIds = oldQueue.map((index) => items[index]!.Id);

      // Copy leaves a line at a time while the lift starts under it.
      setCopyItemId(null);
      const lift = reduceMotion ? 0 : liftDurationS(size);
      const liftOptions = { duration: lift, ease: HERO_MOTION.travelEase };
      const copyTimer = window.setTimeout(
        () => setCopyItemId(incoming.Id),
        lift * HERO_MOTION.copyLeadIn * 1000,
      );

      const animations: Array<Promise<void>> = [];
      const current = (entry: CompositionMotion): Placement => ({
        x: entry.x.get(),
        y: entry.y.get(),
        scale: entry.scale.get(),
      });
      const moveTo = (
        entry: CompositionMotion,
        to: Placement,
        options: Timing,
      ) => {
        animations.push(run(entry.x.tween(to.x, options)));
        void entry.y.tween(to.y, options);
        void entry.scale.tween(to.scale, options);
      };
      /**
       * The queue slides as one row: every miniature that moves along it,
       * closing up or arriving from beyond the edge, shares one start, one
       * duration and one curve. Starting in order and ending in order, none
       * can pass another on the way.
       */
      const slide = (
        moves: Array<{ entry: CompositionMotion; to: Placement }>,
      ) => {
        if (moves.length === 0) return;
        const duration = reduceMotion
          ? 0
          : sharedDurationS(
              size,
              moves.map(({ entry, to }) => ({ from: current(entry), to })),
              HERO_MOTION.slideS,
              HERO_MOTION.slideEase,
            );
        const options = {
          duration,
          delay: reduceMotion ? 0 : HERO_MOTION.slideDelayS,
          ease: HERO_MOTION.slideEase,
        };
        for (const { entry, to } of moves) {
          moveTo(entry, to, options);
          void entry.dim.tween(QUEUE_DIM, options);
        }
      };
      /** A title joining the queue, waiting in line beyond the right edge. */
      const arrival = (id: string, order: number) => {
        const start = arrivalPlacement(size, order);
        const entry = motionFor(id, start, QUEUE_DIM);
        place(entry, start);
        entry.dim.set(QUEUE_DIM);
        entry.titleScale.set(titleScaleRef.current.rest);
        entry.titleY.set(0);
        entry.trailer.set(0);
        return entry;
      };

      if (direction === "forward") {
        const leaving = oldQueueIds.filter(
          (id) => id !== incoming.Id && !newQueueIds.includes(id),
        );
        setLayers([
          { id: outgoing.Id, role: "under" },
          { id: incoming.Id, role: "rising" },
          ...newQueueIds
            .filter((id) => id !== outgoing.Id)
            .map((id) => ({ id, role: "queue" as Role })),
          ...leaving.map((id) => ({ id, role: "leaving" as Role })),
        ]);

        // The incoming title grows out of its slot over the stage.
        const rising = motions.current.get(incoming.Id)!;
        moveTo(rising, stagePlacement(), liftOptions);
        void rising.dim.tween(0, { duration: lift * 0.5, ease: "linear" });

        // The outgoing one recedes beneath it.
        const under = motions.current.get(outgoing.Id)!;
        void under.x.tween(pushedBackPlacement(size).x, liftOptions);
        void under.y.tween(pushedBackPlacement(size).y, liftOptions);
        void under.scale.tween(pushedBackPlacement(size).scale, liftOptions);
        void under.dim.tween(HERO_MOTION.pushBackDim, liftOptions);

        // Titles jumped over sink out of the queue.
        for (const id of leaving) {
          const entry = motions.current.get(id);
          const position = oldQueueIds.indexOf(id);
          if (!entry || position < 0) continue;
          const options = {
            duration: reduceMotion ? 0 : HERO_MOTION.dropS,
            ease: HERO_MOTION.travelEase,
          };
          void entry.y.tween(
            droppedPlacement(size, slots[position]!).y,
            options,
          );
          void entry.dim.tween(1, options);
        }

        // The rest close up, and newcomers line up behind them.
        let arrivals = 0;
        slide(
          newQueueIds.flatMap((id, position) => {
            if (id === outgoing.Id) return [];
            const entry = oldQueueIds.includes(id)
              ? motions.current.get(id)
              : arrival(id, arrivals++);
            return entry
              ? [{ entry, to: slotPlacement(size, slots[position]!) }]
              : [];
          }),
        );

        await Promise.all(animations);

        // The outgoing title, if it is due again soon, joins the queue's end.
        const outgoingPosition = newQueueIds.indexOf(outgoing.Id);
        if (outgoingPosition >= 0) {
          setLayers((layers) => [
            ...layers.filter((layer) => layer.id !== outgoing.Id),
            { id: outgoing.Id, role: "queue" },
          ]);
          slide([
            {
              entry: arrival(outgoing.Id, 0),
              to: slotPlacement(size, slots[outgoingPosition]!),
            },
          ]);
          await Promise.all(animations);
        }
      } else {
        // Backward: the title on stage shrinks back into the head of the
        // queue, uncovering the one before it, which comes forward.
        const previous = motionFor(
          incoming.Id,
          pushedBackPlacement(size),
          HERO_MOTION.pushBackDim,
        );
        place(previous, pushedBackPlacement(size));
        previous.dim.set(HERO_MOTION.pushBackDim);
        previous.titleScale.set(titleScaleRef.current.rest);
        const leavingId = oldQueueIds.find((id) => !newQueueIds.includes(id));
        setLayers([
          { id: incoming.Id, role: "stage" },
          { id: outgoing.Id, role: "rising" },
          ...oldQueueIds
            .filter((id) => id !== leavingId && id !== incoming.Id)
            .map((id) => ({ id, role: "queue" as Role })),
          ...(leavingId ? [{ id: leavingId, role: "leaving" as Role }] : []),
        ]);
        const shrinking = motions.current.get(outgoing.Id)!;
        moveTo(shrinking, slotPlacement(size, slots[0]!), liftOptions);
        void shrinking.dim.tween(QUEUE_DIM, liftOptions);
        void shrinking.titleScale.tween(
          titleScaleRef.current.rest,
          liftOptions,
        );
        void shrinking.trailer.tween(0, liftOptions);
        moveTo(previous, stagePlacement(), liftOptions);
        void previous.dim.tween(0, liftOptions);

        // The queue makes room at its head; its last title slides out past
        // the edge, on the same clock, so the row stays a row.
        slide(
          oldQueueIds.flatMap((id, position) => {
            if (id === incoming.Id) return [];
            const entry = motions.current.get(id);
            if (!entry) return [];
            const to =
              id === leavingId || !slots[position + 1]
                ? arrivalPlacement(size, 0)
                : slotPlacement(size, slots[position + 1]!);
            return [{ entry, to }];
          }),
        );
        await Promise.all(animations);
      }
      window.clearTimeout(copyTimer);

      // Settle: the incoming title owns the stage; everything else is queue.
      for (const [id] of motions.current) {
        if (id !== incoming.Id && !newQueueIds.includes(id))
          motions.current.delete(id);
      }
      setLayers([
        { id: incoming.Id, role: "stage" },
        ...newQueueIds.map((id) => ({ id, role: "queue" as Role })),
      ]);
      stageIndexRef.current = toIndex;
      setStageIndex(toIndex);
      setCopyItemId(incoming.Id);
      setIsTravelling(false);
      busyRef.current = false;
    },
    [closeOverview, hasOpened, items, motionFor, clock, reduceMotion, total],
  );

  // The overview opening: one course drives the title's rise and growth, the
  // facts' rise and the text coming up under them, so none can disagree. Each
  // is linear in the overview, so tweening it on the same duration and curve
  // from where it stands keeps it exactly in step. It lifts whichever title
  // holds the stage, so a closing overview carries the outgoing title's logo
  // back down with it.
  useEffect(() => {
    const open = isOverviewOpen ? 1 : 0;
    const options = {
      duration: reduceMotion ? 0 : HERO_MOTION.overviewS,
      ease: HERO_MOTION.travelEase,
    };
    const controls = overview.tween(open, options);
    const id = items[stageIndexRef.current]?.Id;
    const entry = id ? motions.current.get(id) : undefined;
    if (entry) {
      const scales = titleScaleRef.current;
      entry.titleY.tween(-open * overviewLiftRef.current, options);
      entry.titleScale.tween(
        scales.rest + (scales.open - scales.rest) * open,
        options,
      );
    }
    return () => controls.stop();
    // `items` is read for the stage's title at the moment the overview moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOverviewOpen, overview, reduceMotion]);

  // Artwork for the titles about to arrive, fetched before they slide in, so
  // no newcomer crosses the frame as an empty card.
  useEffect(() => {
    if (total < 2) return;
    for (let offset = 1; offset <= QUEUE_LENGTH * 2; offset += 1) {
      const item = items[(stageIndex + offset) % total];
      const url = item ? getHeroImageCandidates(item)[0]?.url : undefined;
      if (url) new Image().src = url;
    }
  }, [items, stageIndex, total]);

  // ------------------------------------------------------------- the clock
  const isRunning =
    hasOpened &&
    !isPaused &&
    isInView &&
    isDocumentVisible &&
    !isTravelling &&
    !isTrailerPlaying &&
    !isOverviewOpen &&
    total > 1;

  useEffect(() => {
    if (!isRunning) return undefined;
    return clock.start(() => void travel("forward"));
  }, [isRunning, clock, travel]);

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

  // ----------------------------------------------------------- the trailer
  useEffect(() => {
    let cancelled = false;
    setTrailerUrl(null);
    setIsTrailerPlaying(false);
    trailerDoneRef.current = stageItem
      ? trailersSeen.current.has(stageItem.Id)
      : false;
    if (!stageItem || !trailers) return undefined;
    void getHeroPreviewUrl(stageItem)
      .then((url) => {
        if (!cancelled) setTrailerUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [stageItem, trailers]);

  // Artwork and copy first; then, if there is a trailer, the title steps back
  // and the picture starts moving.
  useEffect(() => {
    if (!trailerUrl || !areTrailersEnabled || trailerDoneRef.current)
      return undefined;
    return clock.onReach(HERO_TRAILER_DELAY_MS / HERO_DWELL_MS, () => {
      if (trailerDoneRef.current) return;
      trailerDoneRef.current = true;
      if (stageItem) trailersSeen.current.add(stageItem.Id);
      setIsTrailerPlaying(true);
    });
  }, [areTrailersEnabled, clock, stageItem, trailerUrl]);

  useEffect(() => {
    if (!stageItem) return;
    const entry = motions.current.get(stageItem.Id);
    if (!entry) return;
    const options = {
      duration: reduceMotion ? 0 : 0.8,
      ease: HERO_MOTION.travelEase,
    };
    void entry.trailer.tween(isTrailerPlaying ? 1 : 0, options);
    void entry.titleScale.tween(
      isTrailerPlaying
        ? titleScaleRef.current.trailer
        : titleScaleRef.current.rest,
      options,
    );
    if (isTrailerPlaying) setCopyItemId(null);
    else if (!busyRef.current && hasOpened) setCopyItemId(stageItem.Id);
  }, [hasOpened, isTrailerPlaying, reduceMotion, stageItem]);

  const endTrailer = useCallback(() => setIsTrailerPlaying(false), []);

  // ----------------------------------------------------------- the swipe
  const swipeRef = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    axis: "x" | "y" | null;
  } | null>(null);
  const swipedAtRef = useRef(0);
  const stageEntry = () => {
    const id = items[stageIndexRef.current]?.Id;
    return id ? motions.current.get(id) : undefined;
  };
  const endSwipe = (clientX: number, completed: boolean) => {
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe || swipe.axis !== "x") return;
    swipedAtRef.current = performance.now();
    const dx = clientX - swipe.x;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - swipe.at);
    const isSwipe =
      completed &&
      total > 1 &&
      (Math.abs(dx) >= SWIPE_DISTANCE_PX ||
        (Math.abs(dx) >= 24 && speed >= SWIPE_VELOCITY_PX_PER_MS));
    if (isSwipe && !busyRef.current) {
      void travel(dx < 0 ? "forward" : "backward");
      return;
    }
    const entry = stageEntry();
    if (entry)
      void entry.x.tween(0, {
        duration: reduceMotion ? 0 : 0.32,
        ease: HERO_MOTION.settleEase,
      });
  };

  // --------------------------------------------------------------- render
  const slots = stage ? queueSlots(stage) : [];
  const slotScale = stage && slots[0] ? slots[0].width / stage.width : 0.12;
  const layout = stage ? heroLayout(stage) : null;
  overviewLiftRef.current = layout?.overviewLift ?? 0;
  titleScaleRef.current = layout?.titleScale ?? TITLE_SCALE;
  const isTall = layout?.form === "tall";
  isTallRef.current = isTall;
  const isCompact = layout?.actions === "compact";
  // While the overview spans the queue's row, the queue takes no taps.
  const isQueueAside = isTall && isOverviewOpen;
  const queueIds = queueIndices(
    stageIndex,
    total,
    stage ? queueCount(stage) : QUEUE_LENGTH,
  ).map((index) => items[index]!.Id);
  const headSlot = slots[0];
  // A phone's pill holds touch-sized buttons, so it stands taller.
  const controlsTop = headSlot ? headSlot.y - (isCompact ? 62 : 54) : 0;
  const copyItem = copyItemId ? (itemsById.get(copyItemId) ?? null) : null;

  // The queue's furniture steps aside with the queue, on the same course.
  const furnitureRef = useRef<HTMLDivElement>(null);
  useBake(
    [queueFade],
    (at) => [[furnitureRef.current, { opacity: queueFade.get(at) }]],
    [isTall, hasOpened],
  );

  const hover = (id: string, active: boolean) => {
    if (busyRef.current) return;
    const entry = motions.current.get(id);
    if (!entry || !stage) return;
    const position = queueIds.indexOf(id);
    const slot = slots[position];
    if (!slot) return;
    const lift = active ? slot.height * 0.06 : 0;
    const options = {
      duration: reduceMotion ? 0 : 0.3,
      ease: HERO_MOTION.settleEase,
    };
    void entry.y.tween(slot.y - lift, options);
  };

  if (total === 0) {
    return (
      <section
        ref={sectionRef}
        className={`seyirlik-hero-stage relative mx-4 mt-2 mb-4 w-[calc(100%-2rem)] rounded-2xl bg-[#050607] ${HERO_HEIGHT_CLASS[fit]}`}
      />
    );
  }

  return (
    <section
      ref={sectionRef}
      className={`seyirlik-home-hero seyirlik-hero-stage relative mx-4 mt-2 mb-4 w-[calc(100%-2rem)] rounded-2xl touch-pan-y overflow-hidden bg-[#050607] ${HERO_HEIGHT_CLASS[fit]}`}
      aria-roledescription="carousel"
      aria-label={t("hero.featured")}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") void travel("forward");
        if (event.key === "ArrowLeft") void travel("backward");
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" || !hasOpened || busyRef.current)
          return;
        swipeRef.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: performance.now(),
          axis: null,
        };
      }}
      onPointerMove={(event) => {
        const swipe = swipeRef.current;
        if (!swipe || swipe.id !== event.pointerId) return;
        const dx = event.clientX - swipe.x;
        const dy = event.clientY - swipe.y;
        if (!swipe.axis && Math.hypot(dx, dy) > 10)
          swipe.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
        if (swipe.axis !== "x" || busyRef.current) return;
        const give = Math.max(
          -SWIPE_GIVE_MAX_PX,
          Math.min(SWIPE_GIVE_MAX_PX, dx * SWIPE_GIVE),
        );
        stageEntry()?.x.set(give);
      }}
      onPointerUp={(event) => endSwipe(event.clientX, true)}
      onPointerCancel={(event) => endSwipe(event.clientX, false)}
      // A swipe that ends on a button or link is not a tap on it.
      onClickCapture={(event) => {
        if (performance.now() - swipedAtRef.current < 350) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <NavbarVeil />
      {stage
        ? layers.map((layer) => {
            const item = itemsById.get(layer.id);
            const entry = motions.current.get(layer.id);
            if (!item || !entry) return null;
            const isStage = layer.role === "stage";
            return (
              <HeroComposition
                key={layer.id}
                item={item}
                stage={stage}
                titleBox={layout!.title}
                logoMaxHeight={
                  stage.height -
                  layout!.menuClearance -
                  layout!.title.bottom -
                  layout!.overviewLift
                }
                motion={entry}
                slotScale={slotScale}
                slotHeight={slots[0]?.height}
                titleRestScale={layout!.titleScale.rest}
                opacity={
                  isTall && (layer.role === "queue" || layer.role === "leaving")
                    ? queueFade
                    : undefined
                }
                zIndex={Z[layer.role]}
                isStage={isStage}
                trailerUrl={isStage ? trailerUrl : null}
                isTrailerPlaying={
                  isStage && isTrailerPlaying && isInView && isDocumentVisible
                }
                isTrailerMuted={isTrailerMuted}
                onTrailerEnded={endTrailer}
                onArtworkReady={() => handleArtworkReady(layer.id)}
                onTitleSize={
                  isStage
                    ? (size) => setStageTitle({ id: layer.id, ...size })
                    : undefined
                }
              />
            );
          })
        : null}

      {/* The title and its copy, bottom-left. */}
      {layout && stage ? (
        <HeroCopyBlock
          stage={stage}
          layout={layout}
          item={copyItem}
          titleSize={
            stageTitle && stageTitle.id === copyItem?.Id ? stageTitle : null
          }
          overview={overview}
          isOverviewOpen={isOverviewOpen}
          onHoverIntent={(open) => {
            if (!open || !busyRef.current) setIsOverviewHovered(open);
          }}
          onFocusWithin={setIsOverviewFocused}
          onToggleOverview={() => {
            if (isOverviewOpen) closeOverview();
            else setIsOverviewPinned(true);
          }}
          reduceMotion={reduceMotion}
          smartContinueItems={smartContinueItems}
        />
      ) : null}

      {/* The queue's furniture: its hit targets, the head's clock and the
          controls. One layer, so on a tall stage all of it steps aside
          together while the overview is open across its row. */}
      {/* Stepped aside for the overview, the queue is out of reach
          altogether: no focus, nothing for assistive technology. */}
      <div
        ref={furnitureRef}
        className="pointer-events-none absolute inset-0 z-[6]"
        {...(isQueueAside ? { inert: "" } : {})}
      >
        {stage && hasOpened
          ? queueIds.map((id, position) => {
              const slot = slots[position];
              const item = itemsById.get(id);
              if (!slot || !item) return null;
              const title =
                getItemDisplayMetadata(item, language).title ?? item.Name;
              return (
                <button
                  key={id}
                  type="button"
                  className="absolute z-[5] rounded-[12px] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-default"
                  style={{
                    left: slot.x,
                    top: slot.y,
                    width: slot.width,
                    height: slot.height,
                    pointerEvents: isQueueAside ? "none" : "auto",
                  }}
                  aria-label={title}
                  tabIndex={isQueueAside ? -1 : undefined}
                  disabled={isTravelling}
                  onMouseEnter={() => hover(id, true)}
                  onMouseLeave={() => hover(id, false)}
                  onFocus={() => hover(id, true)}
                  onBlur={() => hover(id, false)}
                  onClick={(event) => {
                    hover(id, false);
                    // The card it was focused on is about to leave the queue.
                    event.currentTarget.blur();
                    void travel("forward", position);
                  }}
                />
              );
            })
          : null}

        {stage && headSlot ? (
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute z-[5] h-[2px] overflow-hidden rounded-full bg-white/15"
            style={{
              left: headSlot.x,
              top: headSlot.y + headSlot.height + 10,
              width: headSlot.width,
            }}
            initial={{ opacity: 0 }}
            animate={{
              opacity:
                isArtworkReady && !isTravelling && !isTrailerPlaying ? 1 : 0,
            }}
            transition={{ duration: reduceMotion ? 0 : 0.35 }}
          >
            <div
              ref={clock.attach}
              className="h-full origin-left bg-[var(--accent)] [transform:scaleX(0)]"
            />
          </motion.div>
        ) : null}

        {stage && headSlot && total > 1 ? (
          <motion.div
            className="absolute z-[6] flex items-center gap-1 rounded-full border border-white/[0.14] bg-black/60 p-1 text-white shadow-[0_18px_60px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl"
            style={{
              right:
                stage.width -
                (slots[slots.length - 1]!.x + slots[slots.length - 1]!.width),
              top: controlsTop,
              pointerEvents: isQueueAside ? "none" : "auto",
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: isArtworkReady ? 1 : 0 }}
            transition={{
              duration: reduceMotion ? 0 : 0.5,
              delay: reduceMotion ? 0 : HERO_MOTION.openQueueDelayS,
              ease: "easeOut",
            }}
          >
            {trailerUrl ? (
              <>
                {isTrailerPlaying ? (
                  <HeroControlButton
                    label={
                      isTrailerMuted ? t("player.unmute") : t("player.mute")
                    }
                    onClick={() => setIsTrailerMuted((current) => !current)}
                  >
                    {isTrailerMuted ? (
                      <VolumeX size={16} />
                    ) : (
                      <Volume2 size={16} />
                    )}
                  </HeroControlButton>
                ) : null}
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
                  {areTrailersEnabled ? (
                    <Video size={16} />
                  ) : (
                    <VideoOff size={16} />
                  )}
                </HeroControlButton>
                <span
                  className="mx-0.5 h-5 w-px bg-white/15"
                  aria-hidden="true"
                />
              </>
            ) : null}
            {/* A phone's pill has room for the clock alone: a swipe or a tap on
              a miniature moves the queue there. Previous and next stay for
              a keyboard and assistive technology, which have neither, and
              show themselves while they hold the focus. */}
            <HeroControlButton
              label={t("hero.previous")}
              onClick={() => void travel("backward")}
              disabled={isTravelling}
              touch={isCompact}
              className={isCompact ? "sr-only focus-visible:not-sr-only" : ""}
            >
              <ChevronLeft size={18} strokeWidth={2.4} />
            </HeroControlButton>
            <HeroControlButton
              label={isPaused ? t("hero.resume") : t("hero.pause")}
              onClick={() => setIsPaused((current) => !current)}
              touch={isCompact}
            >
              {isPaused ? (
                <Play size={15} fill="currentColor" />
              ) : (
                <Pause size={15} fill="currentColor" />
              )}
            </HeroControlButton>
            <HeroControlButton
              label={t("hero.next")}
              onClick={() => void travel("forward")}
              disabled={isTravelling}
              touch={isCompact}
              className={isCompact ? "sr-only focus-visible:not-sr-only" : ""}
            >
              <ChevronRight size={18} strokeWidth={2.4} />
            </HeroControlButton>
            <span
              className={`text-xs font-black tabular-nums tracking-[0.08em] text-white/70 ${
                isCompact ? "pl-1 pr-3" : "px-2.5"
              }`}
              aria-live="polite"
            >
              {String(stageIndex + 1).padStart(2, "0")}
              <span className="text-white/35">
                {" "}
                / {String(total).padStart(2, "0")}
              </span>
            </span>
          </motion.div>
        ) : null}
      </div>

      {/* Loading: the skeleton, piece for piece where the hero's own pieces
          will be, fading off as the first artwork fades in. */}
      {stage && !isSkeletonGone ? (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[7]"
          initial={false}
          animate={{ opacity: isArtworkReady ? 0 : 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.5, ease: "easeOut" }}
          onAnimationComplete={() => {
            if (isArtworkReady) setIsSkeletonGone(true);
          }}
        >
          <HomeHeroSkeletonBackdrop />
          <HomeHeroSkeletonPieces
            stage={stage}
            withControls={total > 1}
            item={stageItem}
            smartContinueItems={smartContinueItems}
          />
        </motion.div>
      ) : null}
    </section>
  );
}
