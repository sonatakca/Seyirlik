/**
 * The quality toast: a small notice, bottom right, that names the quality on
 * screen when playback starts and whenever it changes.
 *
 * A change is drawn as two stacked values with the higher quality always on
 * top, so an upgrade reads bottom → top and a downgrade top → bottom. A soft
 * white light travels from the value that was playing to the one now playing.
 * The light lives only inside the letters (background-clip: text); nothing
 * about the toast may glow onto the picture, which is also why it enters and
 * leaves without the party toast's blur.
 */

/** The rendition actually on screen, as far as the player can tell. */
export interface PlayingQuality {
  /** Stable per rung or file; a new id with the same class is not a change. */
  id: string;
  /** The rung's class (a 2.39:1 2160p rung is 2160 here, not 1608). */
  height: number;
  hdr: boolean;
}

export type QualityChangeKind = "start" | "up" | "down";

export interface QualityChange {
  /** Increments per change, so a repeat of the same values still restarts. */
  id: number;
  kind: QualityChangeKind;
  from: PlayingQuality | null;
  to: PlayingQuality;
  /**
   * The previous toast was still up when this one arrived. The pill stays
   * where it is and only the values move, rather than leaving and re-entering.
   */
  continued: boolean;
}

/** Up, down, the first quality of a title, or nothing a viewer would read as a change. */
export function classifyQualityChange(
  previous: PlayingQuality | null,
  next: PlayingQuality,
): QualityChangeKind | null {
  if (!previous) return "start";
  if (next.height !== previous.height) {
    return next.height > previous.height ? "up" : "down";
  }
  if (next.hdr !== previous.hdr) return next.hdr ? "up" : "down";
  return null;
}

export const formatQualityHeight = (quality: PlayingQuality) =>
  `${quality.height}p`;

/** Milliseconds, measured from the moment the toast appears. */
export const QUALITY_TOAST_TIMING = {
  enterMs: 520,
  /** When the light sets off: after the enter has settled and "from" was readable. */
  swapAtMs: 1_000,
  /** Where a continued toast's swap starts, since there is no enter to wait for. */
  continuedSwapAtMs: 240,
  swapMs: 820,
  /** How long the toast stays up before it starts to leave. */
  visibleMs: 3_400,
  exitMs: 420,
} as const;

/* ---------- the travelling light ---------- */

export const LINE_HEIGHT_PX = 16;
export const LINE_GAP_PX = 1;
/** The resting size of the value that is not playing, relative to the one that is. */
export const RESTING_SCALE = 11 / 13;
/** Alpha of a value at rest when it is not the one playing. */
export const DIM_ALPHA = 0.4;

const GLOW_CORE_PX = 3;
const GLOW_FALLOFF_PX = 17;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;

export function smoothstep(edge0: number, edge1: number, value: number) {
  const k = clamp01((value - edge0) / (edge1 - edge0));
  return k * k * (3 - 2 * k);
}

/** The light's strength at a distance from its centre: no flat core, no visible edge. */
export function glowAt(distancePx: number): number {
  return (
    1 -
    smoothstep(
      GLOW_CORE_PX,
      GLOW_CORE_PX + GLOW_FALLOFF_PX,
      Math.abs(distancePx),
    )
  );
}

/** A cubic-bezier easing, as CSS defines it. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) break;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    return sampleY(clamp01(t));
  };
}

/** The light travelling between the lines. */
const GLIDE = cubicBezier(0.65, 0, 0.35, 1);
/** The arriving value growing into place, with a slight settle. */
const SETTLE = cubicBezier(0.34, 1.32, 0.64, 1);
/** The arrow leaving the ring ahead of the light: cause, then effect. */
const LIFT = cubicBezier(0.5, 0, 0.1, 1);

export interface LinePaint {
  scale: number;
  /** A vertical gradient in the line's own pixels, painted through its glyphs. */
  backgroundImage: string;
  /** The HDR mark is too small to carry a gradient; it takes one alpha. */
  hdrAlpha: number;
}

export interface SwapFrame {
  top: LinePaint;
  bottom: LinePaint;
  /** Offsets, in px, of the leaving and arriving arrows inside the ring. */
  arrowOutY: number;
  arrowInY: number;
}

function paintLine(
  lineTop: number,
  scale: number,
  centre: number,
  rest: number,
  envelope: number,
): LinePaint {
  const stops: string[] = [];
  for (let y = -6; y <= LINE_HEIGHT_PX + 6; y += 1) {
    // The line's local pixel, through its own scale about its centre, in stack px.
    const stackY =
      lineTop + LINE_HEIGHT_PX / 2 + (y - LINE_HEIGHT_PX / 2) * scale;
    // At rest a line is flat white or flat dim; the glow only exists while the light travels.
    const light = lerp(rest, glowAt(stackY - centre), envelope);
    stops.push(
      `rgba(255,255,255,${lerp(DIM_ALPHA, 1, light).toFixed(3)}) ${y}px`,
    );
  }
  const hdrLight = lerp(rest, glowAt(lineTop + 4 - centre), envelope);
  return {
    scale,
    backgroundImage: `linear-gradient(to bottom, ${stops.join(", ")})`,
    hdrAlpha: lerp(0.28, 0.6, hdrLight),
  };
}

/**
 * Everything that moves during a change, at `elapsedMs` after the swap began.
 * Negative before the swap, past `swapMs` after it; both clamp to rest.
 */
export function swapFrameAt(
  kind: Exclude<QualityChangeKind, "start">,
  elapsedMs: number,
): SwapFrame {
  const { swapMs } = QUALITY_TOAST_TIMING;
  const up = kind === "up";
  const progress = clamp01(elapsedMs / swapMs);
  const glide = GLIDE(progress);

  const topCentre = LINE_HEIGHT_PX / 2;
  const bottomCentre = LINE_HEIGHT_PX + LINE_GAP_PX + LINE_HEIGHT_PX / 2;
  const centre = up
    ? lerp(bottomCentre, topCentre, glide)
    : lerp(topCentre, bottomCentre, glide);

  const arrive = SETTLE(clamp01((elapsedMs - swapMs * 0.35) / (swapMs * 0.75)));
  const leave = GLIDE(clamp01(elapsedMs / (swapMs * 0.8)));
  const topScale = up
    ? lerp(RESTING_SCALE, 1, arrive)
    : lerp(1, RESTING_SCALE, leave);
  const bottomScale = up
    ? lerp(1, RESTING_SCALE, leave)
    : lerp(RESTING_SCALE, 1, arrive);

  // The glow takes over from the flat rest colours as it sets off and hands back as it lands.
  const envelope =
    smoothstep(0, 0.22, progress) * (1 - smoothstep(0.78, 1, progress));
  const topRest = (up ? progress >= 0.5 : progress < 0.5) ? 1 : 0;

  const lift = LIFT(clamp01((elapsedMs + 60) / (swapMs * 0.85)));
  const direction = up ? -1 : 1;

  return {
    top: paintLine(0, topScale, centre, topRest, envelope),
    bottom: paintLine(
      LINE_HEIGHT_PX + LINE_GAP_PX,
      bottomScale,
      centre,
      1 - topRest,
      envelope,
    ),
    arrowOutY: direction * 20 * lift,
    arrowInY: -direction * 20 * (1 - lift),
  };
}
