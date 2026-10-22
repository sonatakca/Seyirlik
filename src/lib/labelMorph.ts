/**
 * A label's change of size, carried on the compositor.
 *
 * When a label swaps its words (a language switch, "Play" becoming "Resume"),
 * its width changes, and with it the button around it, the button's fill and
 * everything laid out after it. Animating `width` re-lays all of that out on
 * the main thread every frame, which Safari holds to 60 fps and which stalls
 * whenever the page is busy.
 *
 * So layout takes its new shape at once, and nothing is ever laid out again
 * until the next change. What moves is drawn there by transforms alone:
 *
 * - Every box the change displaces — the label, the icon beside it, the
 *   buttons after it — is a FLIP: measured where it is drawn before the
 *   change, measured where layout puts it after, and carried from one to the
 *   other by the `translate` property. `translate` is its own property, so it
 *   never fights a framer-motion or Tailwind `transform` on the same element.
 * - A box with a visible fill (a pill button) cannot be scaled to its new
 *   width without squashing its rounded ends. Its fill moves into one layer
 *   inside two nested clips, one rounding each end; only the right-hand clip
 *   moves, to the width of the moment. Nothing is resized, so the fill
 *   stretches at full frame rate with its corners untouched (see `stretch`).
 *
 * Changes made in one React commit are measured together: every snapshot is
 * read before React touches the DOM, every new position after, and only then
 * is anything written. Two labels in one navbar therefore see the same
 * "before", and neither measures the other half-moved.
 *
 * A change that arrives mid-flight sets off from where things are drawn at that
 * moment, so an interruption never jumps.
 */

/** The navbar's sliding indicator uses the same glide, so the two travel together. */
export const MORPH_MS = 380;
export const MORPH_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** How many ancestors above the label a change of width can reach. */
const MAX_LEVELS = 6;

/** What a change can move: boxes, and the inline SVG icons beside labels. */
type Moved = HTMLElement | SVGElement;

interface Drawn {
  left: number;
  top: number;
  /** The visible width: mid-stretch that is the stretch's, not the layout's. */
  width: number;
}

export interface MorphSnapshot {
  drawn: Map<Moved, Drawn>;
}

interface Stretch {
  host: HTMLElement;
  layers: HTMLElement[];
  /** The moving clip, whose translate is always the drawn width. */
  edge: HTMLElement;
  animations: Animation[];
  restore: () => void;
}

interface Running {
  move?: Animation;
  stretch?: Stretch;
}

const running = new WeakMap<Moved, Running>();

let pending: MorphSnapshot[] = [];

/** Every animation this module or AnimatedText has running. */
const live = new Set<Animation>();
let caughtUp = false;

/** Registers an animation that `catchUp` may need to bring up to date. */
export function track(animation: Animation): Animation {
  live.add(animation);
  const drop = () => live.delete(animation);
  animation.addEventListener("finish", drop);
  animation.addEventListener("cancel", drop);
  return animation;
}

/**
 * Brings running animations up to the present before anything is measured.
 *
 * While React renders a change, the page's animation clock stands at the last
 * frame, but the compositor keeps playing. Measured as it is, a box mid-glide
 * would be read where it was a render ago, and the next glide would set off
 * from there: a step backwards. Once per task.
 */
export function catchUp(): void {
  if (caughtUp) return;
  caughtUp = true;
  queueMicrotask(() => {
    caughtUp = false;
  });
  const frame = document.timeline?.currentTime;
  if (typeof frame !== "number") return;
  const lag = performance.now() - frame;
  if (lag < 1) return;
  for (const animation of live) {
    if (
      animation.playState === "running" &&
      typeof animation.currentTime === "number"
    ) {
      animation.currentTime += lag;
    }
  }
}

/**
 * Records where everything a label's change can move is drawn now. Call it
 * before the DOM changes: in React, from getSnapshotBeforeUpdate.
 */
export function captureMorph(anchor: HTMLElement): MorphSnapshot | null {
  if (!canMorph(anchor)) return null;
  catchUp();
  const drawn = new Map<Moved, Drawn>();
  for (const element of reach(anchor)) {
    const rect = element.getBoundingClientRect();
    const stretch = running.get(element)?.stretch;
    drawn.set(element, {
      left: rect.left,
      top: rect.top,
      width: stretch
        ? stretchWidth(stretch) * screenScale(element.parentElement)
        : rect.width,
    });
  }
  return { drawn };
}

/**
 * Carries everything from where `captureMorph` saw it to where layout now puts
 * it. Call it after the DOM has changed: in React, from componentDidUpdate.
 * Snapshots handed over in the same task play together.
 */
export function playMorph(snapshot: MorphSnapshot | null): void {
  if (!snapshot) return;
  pending.push(snapshot);
  if (pending.length === 1) queueMicrotask(flush);
}

function flush(): void {
  const snapshots = pending;
  pending = [];

  const before = new Map<Moved, Drawn>();
  for (const snapshot of snapshots) {
    for (const [element, drawn] of snapshot.drawn) {
      if (element.isConnected && !before.has(element)) {
        before.set(element, drawn);
      }
    }
  }
  if (before.size === 0) return;

  // Writes that do not move layout: stop what was in flight, so what is read
  // next is where layout puts each box, not where it is drawn.
  for (const element of before.keys()) stop(element);

  // Reads: one layout for every label in the commit.
  type Plan = {
    element: Moved;
    from: Drawn;
    to: DOMRect;
    scale: number;
    paint: CSSStyleDeclaration | null;
    width: number;
  };
  const plans: Plan[] = [];
  for (const [element, from] of before) {
    const style = getComputedStyle(element);
    if (!movable(style)) continue;
    const to = element.getBoundingClientRect();
    const scale = screenScale(element.parentElement);
    plans.push({
      element,
      from,
      to,
      scale,
      // Only a box has a fill to stretch; an icon is only ever moved.
      paint: element instanceof HTMLElement && painted(style) ? style : null,
      width: element instanceof HTMLElement ? element.offsetWidth : 0,
    });
  }

  // Each box's own share of the journey: what it moves less what the nearest
  // moving box around it already carries it.
  const offset = new Map<Moved, { x: number; y: number }>();
  for (const plan of plans) {
    offset.set(plan.element, {
      x: (plan.from.left - plan.to.left) / plan.scale,
      y: (plan.from.top - plan.to.top) / plan.scale,
    });
  }

  for (const plan of plans) {
    const own = offset.get(plan.element)!;
    const carried = carriedBy(plan.element, offset);
    const x = own.x - carried.x;
    const y = own.y - carried.y;
    const state: Running = {};

    if (Math.abs(x) >= 0.25 || Math.abs(y) >= 0.25) {
      state.move = glide(plan.element, x, y);
    }

    const fromWidth = plan.from.width / plan.scale;
    if (
      plan.paint &&
      plan.element instanceof HTMLElement &&
      Math.abs(fromWidth - plan.width) >= 0.5
    ) {
      state.stretch = stretch(plan.element, plan.paint, fromWidth, plan.width);
    }

    if (state.move || state.stretch) running.set(plan.element, state);
  }
}

/**
 * The anchor, its ancestors up to the first one whose width cannot depend on
 * its content, and the siblings at every level between: everything a change of
 * the anchor's width can move.
 */
function reach(anchor: HTMLElement): Moved[] {
  const found: Moved[] = [];
  let parent = anchor.parentElement;
  for (let level = 0; parent && level < MAX_LEVELS; level += 1) {
    for (const child of Array.from(parent.children)) {
      if (child instanceof HTMLElement || child instanceof SVGElement) {
        found.push(child);
      }
    }
    if (fixedWidth(parent)) break;
    parent = parent.parentElement;
  }
  return found;
}

/**
 * True when a box's width is settled by what contains it, not by its content:
 * a block-level box in ordinary flow. Nothing above it can be moved by the
 * label, so the reach stops there.
 */
function fixedWidth(element: HTMLElement): boolean {
  if (element.hasAttribute("data-morph-scope")) return true;
  if (element === document.body) return true;
  const display = getComputedStyle(element).display;
  if (display.startsWith("inline") || display === "contents") return false;
  const parent = element.parentElement;
  if (!parent) return true;
  const outer = getComputedStyle(parent).display;
  return !/flex|grid|inline|contents/.test(outer);
}

function movable(style: CSSStyleDeclaration): boolean {
  // An inline box takes no transform, and an out-of-flow one is not moved by
  // its neighbours' widths; both keep their own place.
  return (
    style.display !== "inline" &&
    style.display !== "none" &&
    style.display !== "contents" &&
    style.position !== "absolute" &&
    style.position !== "fixed"
  );
}

function carriedBy(
  element: Moved,
  offset: Map<Moved, { x: number; y: number }>,
): { x: number; y: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const found = offset.get(node);
    if (found) return found;
  }
  return { x: 0, y: 0 };
}

function glide(element: Moved, x: number, y: number): Animation {
  const animation = track(
    element.animate(journey(element, x, y), {
      duration: MORPH_MS,
      easing: MORPH_EASE,
    }),
  );
  animation.addEventListener("finish", () => {
    const state = running.get(element);
    if (state?.move === animation) state.move = undefined;
  });
  return animation;
}

/**
 * The keyframes that carry a box back from (x, y). Chromium will not hand an
 * SVG element's `translate` to the compositor, so an icon moves by its
 * `transform` instead, ahead of whatever transform it already has.
 */
function journey(element: Moved, x: number, y: number): Keyframe[] {
  if (!(element instanceof SVGElement)) {
    return [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }];
  }
  const own = getComputedStyle(element).transform;
  const rest = own === "none" ? "" : ` ${own}`;
  return [
    { transform: `translate(${x}px, ${y}px)${rest}` },
    { transform: `translate(0px, 0px)${rest}` },
  ];
}

function stop(element: Moved): void {
  const state = running.get(element);
  if (!state) return;
  state.move?.cancel();
  if (state.stretch) teardown(state.stretch);
  running.delete(element);
}

/** True when the box draws something of its own: fill, edge, shadow or blur. */
function painted(style: CSSStyleDeclaration): boolean {
  const backdrop =
    style.backdropFilter ||
    (style as unknown as { webkitBackdropFilter?: string })
      .webkitBackdropFilter;
  return (
    visibleColor(style.backgroundColor) ||
    style.backgroundImage !== "none" ||
    style.boxShadow !== "none" ||
    (backdrop !== undefined && backdrop !== "" && backdrop !== "none") ||
    (parseFloat(style.borderTopWidth) > 0 && visibleColor(style.borderTopColor))
  );
}

function visibleColor(color: string): boolean {
  if (!color || color === "transparent") return false;
  const alpha = color.match(/rgba?\([^)]*?[,/]\s*([\d.]+%?)\s*\)$/);
  if (!alpha) return true;
  const value = alpha[1]!;
  return parseFloat(value) > 0;
}

/** The host's fill, which the stretch draws through its two clips. */
const FILL = [
  "backgroundColor",
  "backgroundImage",
  "backgroundSize",
  "backgroundPosition",
  "backgroundRepeat",
  "backgroundClip",
  "backgroundOrigin",
  "backdropFilter",
  "webkitBackdropFilter",
] as const;

/** The host's edge and shadow, which the stretch draws on a scaled outline. */
const OUTLINE = [
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "boxShadow",
] as const;

/** What the host gives up while the stretch draws it. */
const HANDED_OVER: Record<string, string> = {
  backgroundColor: "transparent",
  backgroundImage: "none",
  borderTopColor: "transparent",
  borderRightColor: "transparent",
  borderBottomColor: "transparent",
  borderLeftColor: "transparent",
  boxShadow: "none",
  backdropFilter: "none",
  webkitBackdropFilter: "none",
};

/**
 * Draws a filled box from `from` to `to` pixels wide, left edge fixed, without
 * laying anything out.
 *
 * The fill is one layer, so it has no seam: a translucent fill drawn in two
 * pieces doubles up wherever their edges round to the same pixel. It sits
 * inside two nested clips. The outer clip starts at the host's left edge and
 * rounds the left end; the inner one ends at the drawn width w and rounds the
 * right end, so only it moves, by w, while the fill inside it moves back by w
 * and stays put. Both translates are linear in w, so with one easing they agree
 * at every frame.
 *
 * The edge and shadow cannot be clipped to the shape, since the shadow lies
 * outside it. They go on an outline at the new width, scaled from the old one:
 * a soft shadow and a hairline edge take a brief horizontal stretch without it
 * showing.
 */
function stretch(
  host: HTMLElement,
  paint: CSSStyleDeclaration,
  from: number,
  to: number,
): Stretch {
  const span = Math.ceil(Math.max(from, to)) + 1;
  const height = host.offsetHeight;
  const borderLeft = parseFloat(paint.borderLeftWidth) || 0;
  const borderTop = parseFloat(paint.borderTopWidth) || 0;
  const read = (key: string) =>
    (paint as unknown as Record<string, string>)[key] ?? "";

  const layer = (styles: Partial<CSSStyleDeclaration>) => {
    const element = document.createElement("span");
    Object.assign(element.style, {
      position: "absolute",
      top: "0px",
      height: `${height}px`,
      boxSizing: "border-box",
      pointerEvents: "none",
      ...styles,
    });
    return element;
  };

  // Outer clip: [0, span], rounding the left end.
  const outer = layer({
    top: `${-borderTop}px`,
    left: `${-borderLeft}px`,
    width: `${span}px`,
    overflow: "hidden",
    zIndex: "-1",
    borderTopLeftRadius: read("borderTopLeftRadius"),
    borderBottomLeftRadius: read("borderBottomLeftRadius"),
  });
  outer.setAttribute("aria-hidden", "true");
  outer.setAttribute("data-morph-paint", "");
  // Inner clip: [w - span, w], rounding the right end. Moved by w.
  const edge = layer({
    left: `${-span}px`,
    width: `${span}px`,
    overflow: "hidden",
    borderTopRightRadius: read("borderTopRightRadius"),
    borderBottomRightRadius: read("borderBottomRightRadius"),
  });
  edge.setAttribute("data-morph-edge", "");
  // The fill at [0, span], moved back by w so it never moves.
  const fill = layer({
    left: `${span}px`,
    width: `${span}px`,
    borderTopLeftRadius: read("borderTopLeftRadius"),
    borderBottomLeftRadius: read("borderBottomLeftRadius"),
  });
  const fillStyle = fill.style as unknown as Record<string, string>;
  for (const key of FILL) fillStyle[key] = read(key);
  edge.appendChild(fill);
  outer.appendChild(edge);
  const layers = [outer];

  const outlined =
    paint.boxShadow !== "none" ||
    (parseFloat(paint.borderTopWidth) > 0 &&
      visibleColor(paint.borderTopColor));
  let outline: HTMLElement | null = null;
  if (outlined) {
    outline = layer({
      top: `${-borderTop}px`,
      left: `${-borderLeft}px`,
      width: `${to}px`,
      zIndex: "-1",
      transformOrigin: "left center",
    });
    outline.setAttribute("aria-hidden", "true");
    outline.setAttribute("data-morph-paint", "");
    const outlineStyle = outline.style as unknown as Record<string, string>;
    for (const key of OUTLINE) outlineStyle[key] = read(key);
    layers.push(outline);
  }

  const saved = new Map<string, string>();
  const hostStyle = host.style as unknown as Record<string, string>;
  const set = (key: string, value: string) => {
    if (!saved.has(key)) saved.set(key, hostStyle[key] ?? "");
    hostStyle[key] = value;
  };

  // The host's own transitions would otherwise fade its fill out, and back in.
  set("transition", "none");
  for (const [key, value] of Object.entries(HANDED_OVER)) set(key, value);
  const style = getComputedStyle(host);
  if (style.position === "static") set("position", "relative");
  // The layers sit behind the content but in front of what is behind the host.
  set("isolation", "isolate");
  // A clipping host that shrinks would cut its own wider fill. One that grows
  // keeps its clip, which may be shaping something inside it (a progress fill).
  if (from > to && style.overflow !== "visible") set("overflow", "visible");

  for (const added of [...layers].reverse()) host.prepend(added);

  const timing = {
    duration: MORPH_MS,
    easing: MORPH_EASE,
    fill: "forwards" as const,
  };
  const slide = (target: HTMLElement, at: (width: number) => string) =>
    track(
      target.animate([{ translate: at(from) }, { translate: at(to) }], timing),
    );
  const animations = [
    slide(edge, (width) => `${width}px 0px`),
    slide(fill, (width) => `${-width}px 0px`),
  ];
  if (outline && to > 0) {
    animations.push(
      track(
        outline.animate(
          [{ scale: `${from / to} 1` }, { scale: "1 1" }],
          timing,
        ),
      ),
    );
  }

  const state: Stretch = {
    host,
    layers,
    edge,
    animations,
    restore: () => {
      for (const [key, value] of saved) {
        if (key !== "transition") hostStyle[key] = value;
      }
      // Settle the restored fill before transitions return, so it does not
      // fade back in.
      void getComputedStyle(host).backgroundColor;
      hostStyle.transition = saved.get("transition") ?? "";
    },
  };

  animations[0]!.addEventListener("finish", () => {
    const current = running.get(host);
    if (current?.stretch !== state) return;
    teardown(state);
    current.stretch = undefined;
    if (!current.move) running.delete(host);
  });

  return state;
}

function teardown(stretch: Stretch): void {
  for (const animation of stretch.animations) animation.cancel();
  for (const layer of stretch.layers) layer.remove();
  stretch.restore();
}

/** The width a stretch is drawing right now: where its moving clip ends. */
function stretchWidth(stretch: Stretch): number {
  const x = parseFloat(getComputedStyle(stretch.edge).translate);
  return Number.isFinite(x) ? x : stretch.host.offsetWidth;
}

/** Screen pixels per layout pixel inside `element`, for a scaled ancestor. */
function screenScale(element: HTMLElement | null): number {
  if (!element || element.offsetWidth === 0) return 1;
  const scale = element.getBoundingClientRect().width / element.offsetWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function canMorph(anchor: HTMLElement): boolean {
  return (
    typeof anchor.animate === "function" &&
    typeof queueMicrotask === "function" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
