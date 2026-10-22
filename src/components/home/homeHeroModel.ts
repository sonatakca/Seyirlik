/**
 * The home hero's geometry and timing, kept pure so the choreography's rules
 * can be tested without a browser.
 *
 * The hero is a stage with its queue in view. Every featured title is drawn as
 * one composition — backdrop, scrim, logo — at the stage's full size. On stage
 * it sits at scale 1; waiting in the queue it is the same composition scaled
 * down into a slot, with a shorter crop on tablets. That is what lets a
 * title travel between the two as a single transform: the miniature is not a
 * thumbnail of the title, it is the title, smaller.
 */

export interface StageSize {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many upcoming titles wait in view. */
export const QUEUE_LENGTH = 2;

/** Two desktop previews, one on a landscape tablet; tall frames keep their stack. */
export function queueCount(stage: StageSize): number {
  return heroForm(stage) === "tall" ? 3 : stage.width >= 1200 ? 2 : 1;
}

/** A wide stage's side margin: the copy's on the left, the queue's on the right. */
function wideInset(stage: StageSize): number {
  return stage.width < 1200 ? 40 : 56;
}

/**
 * The dock and tablet preview share their vertical rhythm. With a queue the
 * dock stands centred between the copy and the queue; a title's own page has
 * no queue, so its dock takes the queue's place on the right.
 */
export function heroDock(
  stage: StageSize,
  { withQueue = true }: { withQueue?: boolean } = {},
) {
  const compact = heroForm(stage) === "tall" || stage.width < 1200;
  const width = Math.min(compact ? 264 : 300, stage.width - 32);
  const isAside = !withQueue && heroForm(stage) === "wide";
  return {
    width,
    left: isAside
      ? stage.width - wideInset(stage) - width
      : (stage.width - width) / 2,
    height: compact ? 102 : 113,
    bottom:
      heroForm(stage) === "tall"
        ? Math.min(36, Math.max(18, stage.height * 0.026))
        : compact
          ? 16
          : 26,
    compact,
  };
}

/**
 * Timing, in one place. Every trip of one kind takes the same time wherever it
 * starts, so lifting the third miniature feels like lifting the first.
 */
export const HERO_MOTION = {
  /**
   * A title lifting from the queue to the stage, or back. Sine in-out: of the
   * smooth curves it has the lowest peak speed (π/2 × the average), and on
   * the longest trip the peak is what sets how short the trip can be.
   */
  travelS: 0.5,
  overviewS: 0.24,
  travelEase: [0.37, 0, 0.63, 1] as [number, number, number, number],
  /**
   * The queue sliding along: every miniature in it, the ones closing up and
   * the ones arriving from beyond the edge, on one shared clock.
   */
  slideS: 0.45,
  slideDelayS: 0.06,
  slideEase: [0.35, 0, 0.25, 1] as [number, number, number, number],
  /** A title skipped over in the queue, sinking out of it. */
  dropS: 0.26,
  settleEase: [0.61, 1, 0.88, 1] as [number, number, number, number],
  /** What the outgoing title does under the incoming one: it recedes. */
  pushBackScale: 0.95,
  pushBackDim: 0.5,
  /** The first arrival: the copy fades up, then the queue rises in. */
  openCopyDelayS: 0.25,
  openQueueDelayS: 0.4,
  /** Copy under the title fading out and back in as the title changes. */
  copyExitS: 0.18,
  copyExitStaggerS: 0.025,
  copyEnterS: 0.34,
  copyEnterStaggerS: 0.05,
  /** Share of the lift after which the new title's copy starts rising. */
  copyLeadIn: 0.72,
} as const;

/** Time on stage before the next title lifts off. */
export const HERO_DWELL_MS = 11_000;
/** With a trailer: how long the artwork and copy hold before it starts. */
export const HERO_TRAILER_DELAY_MS = 6_000;

/**
 * The fastest any edge may move, in px per frame at 60 fps on a 1080-tall
 * canvas, scaled with the canvas. A lift from the far end of the queue to the
 * full frame is the longest trip; with the sine lift this keeps it near half
 * a second on any desktop, the fastest frames still a sweep and not a jump.
 */
export const MAX_TRAVEL_PX_PER_FRAME_AT_1080 = 84;

export function travelBudgetPxPerFrame(stage: StageSize): number {
  return (MAX_TRAVEL_PX_PER_FRAME_AT_1080 * stage.height) / 1080;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** The next `count` titles after `stageIndex`, wrapping, never the stage itself. */
export function queueIndices(
  stageIndex: number,
  total: number,
  count = QUEUE_LENGTH,
): number[] {
  if (total <= 1) return [];
  const length = Math.min(count, total - 1);
  return Array.from(
    { length },
    (_, offset) => (stageIndex + 1 + offset) % total,
  );
}

/** The title before `stageIndex`, wrapping. */
export function previousIndex(stageIndex: number, total: number): number {
  return (stageIndex - 1 + total) % total;
}

/**
 * The stage's shape decides its layout, not the device: a landscape stage
 * (any desktop, a phone on its side) keeps the queue beside the copy; a
 * portrait one (a phone, a tablet upright, a tall desktop window) stacks the
 * actions under both, because a row of actions and a row of miniatures no
 * longer fit side by side.
 */
export type HeroForm = "wide" | "tall";

/**
 * How tall a hero stands. "screen" is the desktop's full screen. "mobile"
 * is the screen above the phone and tablet tab bar (5rem and the home
 * indicator's inset), so the actions never sit under it; on its side, where
 * the tab bar is hidden, the hero takes the whole screen again.
 */
export type HeroFit = "screen" | "mobile";

export const HERO_HEIGHT_CLASS: Record<HeroFit, string> = {
  screen: "h-[calc(100svh-1.5rem)] min-h-[36rem]",
  mobile: "aspect-video min-h-[20rem]",
};

export function heroForm(stage: StageSize): HeroForm {
  return stage.height > stage.width * 1.05 ? "tall" : "wide";
}

/**
 * A tall stage's frame: its margins, the actions row along its foot, and the
 * queue above that row on the right.
 */
interface TallFrame {
  inset: number;
  bottom: number;
  actionsTop: number;
  slotWidth: number;
  slotHeight: number;
  slotGap: number;
  slotY: number;
}

/** Below the queue: its progress line, then room above the actions. */
const TALL_QUEUE_FOOT_PX = 26;

function tallFrame(stage: StageSize): TallFrame {
  const inset = clamp(stage.width * 0.042, 16, 44);
  const bottom = clamp(stage.height * 0.026, 18, 36);
  const actionsTop = stage.height - bottom - COPY_ROWS.actionsPx;
  const slotWidth = clamp(stage.width * 0.11, 42, 112);
  const slotHeight = (slotWidth * stage.height) / stage.width;
  return {
    inset,
    bottom,
    actionsTop,
    slotWidth,
    slotHeight,
    slotGap: clamp(stage.width * 0.016, 6, 12),
    slotY: actionsTop - TALL_QUEUE_FOOT_PX - slotHeight,
  };
}

/**
 * Where the queue's slots sit, left to right, in stage coordinates. Their
 * aspect ratio is the stage's, so a slot holds a whole composition.
 */
export function queueSlots(
  stage: StageSize,
  count = queueCount(stage),
): SlotRect[] {
  if (heroForm(stage) === "tall") {
    const frame = tallFrame(stage);
    const { slotWidth: width, slotGap: gap } = frame;
    return Array.from({ length: count }, (_, index) => ({
      x:
        stage.width -
        frame.inset -
        (count - index) * width -
        (count - 1 - index) * gap,
      y: frame.slotY,
      width,
      height: frame.slotHeight,
    }));
  }
  const compact = stage.width < 1200;
  const dock = heroDock(stage);
  const width = compact
    ? Math.min(252, stage.width * 0.24)
    : clamp(stage.width * (192 / 1408), 164, 256);
  const height = compact ? dock.height : (width * 9) / 16;
  const gap = 12;
  const right = wideInset(stage);
  const bottom = compact ? dock.bottom : 24;
  const y = stage.height - bottom - height;
  return Array.from({ length: count }, (_, index) => ({
    x:
      stage.width - right - (count - index) * width - (count - 1 - index) * gap,
    y,
    width,
    height,
  }));
}

export function stagePlacement(): Placement {
  return { x: 0, y: 0, scale: 1 };
}

export function slotPlacement(stage: StageSize, slot: SlotRect): Placement {
  return { x: slot.x, y: slot.y, scale: slot.width / stage.width };
}

/** Distance between neighbouring slots' left edges. */
export function slotPitch(stage: StageSize): number {
  const [first, second] = queueSlots(stage, 2);
  return second!.x - first!.x;
}

/**
 * Where the `order`-th title joining the queue waits: beyond the right edge,
 * in line with the queue and spaced like its slots. Arrivals line up behind
 * one another, so as the row slides in on one clock nothing can overtake.
 */
export function arrivalPlacement(stage: StageSize, order = 0): Placement {
  const slots = queueSlots(stage);
  const last = slots[slots.length - 1]!;
  const gap = slotPitch(stage) - last.width;
  return {
    x: stage.width + gap + order * slotPitch(stage),
    y: last.y,
    scale: last.width / stage.width,
  };
}

/** Below the frame: where a title skipped over in the queue leaves to. */
export function droppedPlacement(stage: StageSize, slot: SlotRect): Placement {
  return { x: slot.x, y: stage.height + 24, scale: slot.width / stage.width };
}

/** The receding position of a title another one is covering. */
export function pushedBackPlacement(stage: StageSize): Placement {
  const scale = HERO_MOTION.pushBackScale;
  return {
    x: (stage.width * (1 - scale)) / 2,
    y: (stage.height * (1 - scale)) / 2,
    scale,
  };
}

/** The steepest slope of a CSS cubic-bézier easing, sampled. */
export function easePeakFactor(
  ease: readonly [number, number, number, number],
): number {
  const [x1, y1, x2, y2] = ease;
  const at = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  let peak = 0;
  let previous = { x: 0, y: 0 };
  for (let step = 1; step <= 2000; step += 1) {
    const t = step / 2000;
    const point = { x: at(t, x1, x2), y: at(t, y1, y2) };
    const dx = point.x - previous.x;
    if (dx > 1e-9) peak = Math.max(peak, (point.y - previous.y) / dx);
    previous = point;
  }
  return peak;
}

/** How far the farthest-moving edge of a composition goes between placements. */
export function edgeDistance(
  stage: StageSize,
  from: Placement,
  to: Placement,
): number {
  const edges = (p: Placement) => [
    p.x,
    p.y,
    p.x + stage.width * p.scale,
    p.y + stage.height * p.scale,
  ];
  const a = edges(from);
  const b = edges(to);
  return Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
}

/** The fastest any edge moves on a trip, in px per frame at 60 fps. */
export function peakTravelPxPerFrame(
  stage: StageSize,
  from: Placement,
  to: Placement,
  durationS: number,
  ease: readonly [number, number, number, number] = HERO_MOTION.travelEase,
): number {
  const averagePerFrame = edgeDistance(stage, from, to) / durationS / 60;
  return easePeakFactor(ease) * averagePerFrame;
}

/**
 * How long a set of moves that share one clock takes: the base time,
 * lengthened only as far as the fastest edge of the longest move needs.
 */
export function sharedDurationS(
  stage: StageSize,
  trips: Array<{ from: Placement; to: Placement }>,
  baseS: number,
  ease: readonly [number, number, number, number],
): number {
  const budget = travelBudgetPxPerFrame(stage);
  return trips.reduce((duration, { from, to }) => {
    const peak = peakTravelPxPerFrame(stage, from, to, baseS, ease);
    return Math.max(duration, peak <= budget ? baseS : (baseS * peak) / budget);
  }, baseS);
}

/**
 * How long a lift between the stage and the queue takes. It is the same for
 * every slot — the time the farthest one needs — so which miniature was
 * chosen never changes how fast the title arrives.
 */
export function liftDurationS(stage: StageSize): number {
  return sharedDurationS(
    stage,
    queueSlots(stage).map((slot) => ({
      from: slotPlacement(stage, slot),
      to: stagePlacement(),
    })),
    HERO_MOTION.travelS,
    HERO_MOTION.travelEase,
  );
}

/**
 * Where the copy block and the title above it sit: both anchored bottom-left,
 * the actions level with the bottom of the queue. At rest the copy is the
 * facts line and the actions; the overview opens between them only when
 * asked for, and the facts and the title rise by `overviewLift` to make room.
 */
export interface HeroLayout {
  form: HeroForm;
  copy: { left: number; bottom: number; width: number; height: number };
  title: { left: number; bottom: number; width: number; height: number };
  /** The facts line's width: on a tall stage it shares its row with the queue. */
  factsWidth: number;
  /** Between the facts and the actions. */
  actionsGap: number;
  /**
   * How the actions are set: "full" as on a desktop, "compact" where the row
   * is a phone's width, play taking what the round buttons leave.
   */
  actions: "full" | "compact";
  /** The title's own scale at rest, open, and under a trailer. */
  titleScale: TitleScale;
  /** How far below the stage's top a fully open logo may reach. */
  menuClearance: number;
  overviewFontPx: number;
  /** Height of the overview's three lines. */
  overviewHeight: number;
  /** How far the facts and the title rise while the overview is open. */
  overviewLift: number;
}

export interface TitleScale {
  rest: number;
  open: number;
  trailer: number;
}

/**
 * The title's size within its box, grown from its bottom-left corner. It
 * rests small so the artwork leads, grows to full size as the overview opens
 * under it, and steps further back while a trailer plays.
 */
export const TITLE_SCALE = {
  rest: 1,
  open: 1.2,
  trailer: 0.77,
} as const;

/**
 * On a tall stage the title's box is already the narrow column beside the
 * queue, so it rests at full size and the overview only lifts it: there is no
 * pointer to rest on it, and nothing to grow into.
 */
export const TALL_TITLE_SCALE: TitleScale = {
  rest: 1,
  open: 1,
  trailer: 0.82,
};

/** Fixed rows, so the title's place never depends on a title's own copy. */
export const COPY_ROWS = {
  factsPx: 20,
  /** Between the facts and the overview. */
  factsGapPx: 12,
  overviewLines: 3,
  overviewLineHeight: 1.55,
  /** Above the actions, under whatever sits there. */
  actionsGapPx: 20,
  actionsPx: 102,
} as const;

/**
 * The tall layout, from the foot up: the actions across the full width; above
 * them the facts on the left, level with the foot of the queue on the right;
 * the title above the facts, in the column the queue leaves. With nothing
 * queued (a title's own page) the column is the stage's, less a margin, so a
 * logo is not drawn edge to edge.
 */
function tallLayout(stage: StageSize, withQueue: boolean): HeroLayout {
  const frame = tallFrame(stage);
  const width = stage.width - frame.inset * 2;
  const queueWidth =
    frame.slotWidth * queueCount(stage) +
    frame.slotGap * (queueCount(stage) - 1);
  const columnGap = clamp(stage.width * 0.03, 14, 28);
  const column = withQueue ? width - queueWidth - columnGap : width;
  const actionsGap = TALL_QUEUE_FOOT_PX;
  const height = COPY_ROWS.factsPx + actionsGap + COPY_ROWS.actionsPx;
  const overviewFontPx = stage.width >= 700 ? 15 : 14;
  const overviewHeight = Math.ceil(
    overviewFontPx * COPY_ROWS.overviewLineHeight * COPY_ROWS.overviewLines,
  );
  const titleHeight = clamp(stage.height * 0.15, 84, 190);
  return {
    form: "tall",
    copy: { left: frame.inset, bottom: frame.bottom, width, height },
    title: {
      left: frame.inset,
      bottom: frame.bottom + height + clamp(stage.height * 0.014, 10, 18),
      // Led by the stage's height, so a wide logo on an upright tablet
      // carries the weight the stage gives it, not a phone's.
      width: Math.min(column, stage.width * 0.6, titleHeight * 2.6),
      height: titleHeight,
    },
    factsWidth: column,
    actionsGap,
    actions: stage.width < 600 ? "compact" : "full",
    titleScale: TALL_TITLE_SCALE,
    menuClearance: stage.width < 1024 ? 92 : LOGO_MENU_CLEARANCE_PX,
    overviewFontPx,
    overviewHeight,
    overviewLift: overviewHeight + COPY_ROWS.factsGapPx,
  };
}

export function heroLayout(
  stage: StageSize,
  { withQueue = true }: { withQueue?: boolean } = {},
): HeroLayout {
  if (heroForm(stage) === "tall") return tallLayout(stage, withQueue);
  const compact = stage.width < 1200;
  const bottom = compact ? 20 : 30;
  const left = wideInset(stage);
  const overviewFontPx = compact ? 14 : 15.5;
  const overviewHeight = Math.ceil(
    overviewFontPx * COPY_ROWS.overviewLineHeight * COPY_ROWS.overviewLines,
  );
  const dock = heroDock(stage, { withQueue });
  const width = Math.max(
    160,
    Math.min(stage.width * 0.34, 600, dock.left - left - 20),
  );
  return {
    form: "wide",
    copy: { left, bottom, width, height: COPY_ROWS.factsPx },
    title: {
      left,
      bottom: bottom + COPY_ROWS.factsPx + 16,
      width: Math.min(compact ? 260 : 300, stage.width * 0.3),
      height: 150,
    },
    factsWidth: width,
    actionsGap: COPY_ROWS.actionsGapPx,
    actions: "full",
    titleScale: TITLE_SCALE,
    menuClearance: stage.width < 1024 ? 92 : LOGO_MENU_CLEARANCE_PX,
    overviewFontPx,
    overviewHeight,
    overviewLift: overviewHeight + COPY_ROWS.factsGapPx,
  };
}

/**
 * Where a title's logo sits inside a queue miniature, as shares of the frame:
 * bottom-left and far larger than true to scale, so a miniature can be read
 * at its size. On stage the logo is at its own place and size; between the
 * two it is interpolated with the frame's scale.
 */
export const QUEUE_TITLE_BOX = {
  left: 0.07,
  bottom: 0.1,
  width: 0.4,
  height: 0.21,
} as const;

export interface TitleTransform {
  /** Move of the title box's bottom-left corner, in frame px. */
  x: number;
  y: number;
  /** Scale about that corner. */
  scale: number;
}

/** What turns the stage's title box into the queue's, in the frame's own px. */
export function queueTitleTransform(
  stage: StageSize,
  title: HeroLayout["title"],
): TitleTransform {
  const box = {
    left: stage.width * QUEUE_TITLE_BOX.left,
    bottom: stage.height * QUEUE_TITLE_BOX.bottom,
    width: stage.width * QUEUE_TITLE_BOX.width,
    height: stage.height * QUEUE_TITLE_BOX.height,
  };
  return {
    x: box.left - title.left,
    y: title.bottom - box.bottom,
    scale: Math.min(box.width / title.width, box.height / title.height),
  };
}

/**
 * How far a frame is from being a miniature: 0 in a slot, 1 by the time it
 * nearly fills the stage (a receding title, at 0.95, stays at 1).
 */
export function stageness(scale: number, slotScale: number): number {
  const end = 0.9;
  if (end <= slotScale) return 1;
  return Math.min(1, Math.max(0, (scale - slotScale) / (end - slotScale)));
}

/** The frame's local radius; multiply by scale to get its visible corner. */
export function heroFrameRadius(scale: number, slotScale: number): number {
  const safeScale = Math.max(0.001, scale);
  const onStage = Math.min(
    1,
    Math.max(0, (safeScale - slotScale) / (1 - slotScale)),
  );
  return (12 + 4 * onStage) / safeScale;
}

/** Quartic ease-in (alpha = t⁴) from clear to the page's background. */
export const HANDOVER_GRADIENT =
  "linear-gradient(180deg, rgba(5,6,7,0) 0%, rgba(5,6,7,0.008) 30%, rgba(5,6,7,0.041) 45%, rgba(5,6,7,0.13) 60%, rgba(5,6,7,0.24) 70%, rgba(5,6,7,0.41) 80%, rgba(5,6,7,0.573) 87%, rgba(5,6,7,0.748) 93%, #050607 100%)";

/** The fall's shape: [share of the way from clear to solid, alpha]. */
const TALL_FOOT_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.17, 0.08],
  [0.31, 0.25],
  [0.44, 0.48],
  [0.54, 0.68],
  [0.65, 0.83],
  [0.75, 0.93],
  [0.88, 0.98],
  [1, 1],
];

/**
 * A tall stage's foot: clear above, then the picture sinks into the room and
 * is solid by the top of the logo's box, so the logo, facts and actions never
 * sit over a poster's printed lettering. The fall spans 40% of the stage,
 * eased so it has no visible start.
 */
export function tallFootGradient(
  stage: StageSize,
  title: HeroLayout["title"],
  titleRest = 1,
): string {
  const logoTop = title.bottom + title.height * titleRest;
  const solid = clamp(1 - logoTop / stage.height, 0.5, 0.95);
  const clear = Math.max(0.25, solid - 0.4);
  const at = (share: number) =>
    `${((clear + (solid - clear) * share) * 100).toFixed(1)}%`;
  const stops = TALL_FOOT_STOPS.map(([share, alpha]) =>
    alpha >= 1 ? `#050607 ${at(share)}` : `rgba(5,6,7,${alpha}) ${at(share)}`,
  );
  return `linear-gradient(180deg, rgba(5,6,7,0) 0%, ${stops.join(", ")})`;
}

/**
 * How far below the stage's top a fully open logo may reach: the menu's
 * height and a margin under it.
 */
export const LOGO_MENU_CLEARANCE_PX = 112;

/** A title page's back button: under the menu, on the copy's left edge. */
export const TITLE_BACK_TOP_PX = 88;
