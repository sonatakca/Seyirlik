/**
 * A change of language, played on everything it changes.
 *
 * The language button rewrites every word on the page at once. Instead of
 * wrapping each of those words in a component, the switch itself is played:
 * before the new language is committed, every text on screen and every box
 * around it is measured; the commit runs; and then whatever the commit
 * changed is carried from how it was drawn to how it is laid out now.
 *
 * - Words that leave shrink and blur away; words that arrive grow out of a
 *   blur. Both are drawn by a stand-in (a "ghost") holding the words, laid
 *   in the same box as the real text, while the real text is hidden; the
 *   ghost of the new words hands back to the real ones when it lands.
 * - Every box the change moves is a FLIP: carried by `translate` from where
 *   it was drawn to where layout puts it, so nothing is laid out per frame.
 * - Every painted box the change resizes (a pill, a card, a menu) stretches
 *   in both directions without squashing its corners: its fill is drawn
 *   through four nested clips, each rounding one corner, moved by the width
 *   and height of the moment (see `stretch`).
 *
 * Only `translate`, `scale`, `opacity` and `filter` animate. Beneath a
 * drop-shadow they animate through registered custom properties instead (see
 * `play`), so the shadow keeps drawing the words.
 */
import { flushSync } from "react-dom";

export const LANGUAGE_MORPH_MS = 420;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Words leave quickly, and the new ones arrive as they go. */
const OUT_MS = 200;
const IN_DELAY_MS = 70;
const IN_MS = LANGUAGE_MORPH_MS - IN_DELAY_MS;
const OUT_SCALE = 0.72;
const IN_SCALE = 0.72;
const BLUR_PX = 9;

/** Text this far outside the viewport is switched without being played. */
const VIEWPORT_MARGIN = 80;

/** True while a switch is being committed: the old per-label animations stand down. */
let committing = false;
export function isLanguageMorphCommitting(): boolean {
  return committing;
}

/** What a change can move: boxes, and the inline SVG icons beside words. */
type Box = HTMLElement | SVGElement;

interface TextBefore {
  node: Text;
  parent: HTMLElement;
  text: string;
  /** Where the words start: the first line's left and top. */
  start: { left: number; top: number };
  rect: DOMRect;
}

interface Drawn {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Running {
  animations: Animation[];
  cleanups: Array<() => void>;
}

let current: Running | null = null;

/**
 * Commits a change of language and plays it. `commit` must change the DOM
 * synchronously; it is run inside `flushSync`.
 */
export function morphLanguage(commit: () => void): void {
  finishRunning();
  if (!canMorph()) {
    commit();
    return;
  }

  shadowCache = new Map();
  const texts = collectTexts();
  const drawn = new Map<Box, Drawn>();
  // Where each box hung: an element React replaces is detached by the commit,
  // and this is the only way back to the place it left.
  const parentOf = new Map<Box, HTMLElement | null>();
  const boxesFor = (parent: HTMLElement) => {
    for (const box of reach(parent)) {
      if (drawn.has(box)) continue;
      drawn.set(box, measure(box));
      parentOf.set(box, box.parentElement);
    }
  };
  for (const text of texts) boxesFor(text.parent);
  const selects = collectSelects();
  for (const select of selects) boxesFor(select.element);

  committing = true;
  try {
    flushSync(commit);
  } finally {
    committing = false;
  }

  // What changed: a text node now holding other words, or no longer there.
  const changedParents = new Set<HTMLElement>();
  for (const text of texts) {
    if (!text.node.isConnected || text.node.data !== text.text) {
      if (text.parent.isConnected) changedParents.add(text.parent);
    }
  }
  // Elements React replaced rather than rewrote (a list keyed by its words):
  // the old one leaves where it stood, the new one arrives where it stands.
  const removed = new Map<HTMLElement, HTMLElement>();
  for (const text of texts) {
    if (text.node.isConnected || text.parent.isConnected) continue;
    let root: HTMLElement = text.parent;
    while (root.parentElement) root = root.parentElement;
    const host = parentOf.get(root);
    if (host?.isConnected && drawn.has(root)) removed.set(root, host);
  }
  const known = new Set<Text>(texts.map((text) => text.node));
  const arrived = new Set<HTMLElement>();
  for (const node of visibleTextNodes()) {
    if (known.has(node)) continue;
    let root = node.parentElement;
    if (!root || drawn.has(root)) continue;
    while (
      root.parentElement &&
      root.parentElement !== document.body &&
      !drawn.has(root.parentElement)
    ) {
      root = root.parentElement;
    }
    if (root.parentElement && drawn.has(root.parentElement)) arrived.add(root);
  }

  const changedSelects = selects.filter(
    (select) =>
      select.element.isConnected &&
      selectedText(select.element) !== select.text,
  );
  if (
    changedParents.size === 0 &&
    changedSelects.length === 0 &&
    removed.size === 0 &&
    arrived.size === 0
  ) {
    return;
  }

  const running: Running = { animations: [], cleanups: [] };
  current = running;

  // Reads first: where every affected box is laid out now.
  const affected = new Set<Box>();
  for (const parent of [
    ...changedParents,
    ...changedSelects.map((select) => select.element),
    ...removed.values(),
    ...[...arrived].map((root) => root.parentElement!),
  ]) {
    for (const box of reach(parent)) if (drawn.has(box)) affected.add(box);
  }
  const selectsAfter = changedSelects.map((select) => ({
    ...select,
    next: selectedText(select.element),
    to: select.element.getBoundingClientRect(),
  }));
  const after = new Map<Box, Drawn>();
  for (const box of affected) {
    if (box.isConnected) after.set(box, measure(box));
  }
  const textsAfter = new Map<HTMLElement, TextAfter[]>();
  for (const parent of changedParents) {
    textsAfter.set(parent, readTexts(parent));
  }
  const offsets = new Map<Box, { x: number; y: number }>();
  for (const [box, to] of after) {
    const from = drawn.get(box)!;
    const scale = screenScale(box.parentElement);
    offsets.set(box, {
      x: (from.left - to.left) / scale,
      y: (from.top - to.top) / scale,
    });
  }
  const paints = new Map<HTMLElement, CSSStyleDeclaration>();
  for (const [box, to] of after) {
    const from = drawn.get(box)!;
    if (
      Math.abs(from.width - to.width) < 0.5 &&
      Math.abs(from.height - to.height) < 0.5
    ) {
      continue;
    }
    if (!(box instanceof HTMLElement)) continue;
    const style = getComputedStyle(box);
    if (painted(style)) paints.set(box, style);
  }

  // Which of them sit beneath a drop-shadow, read before any of them moves.
  for (const [box] of after) sheltered(box);
  for (const parent of changedParents) shelteredWithin(parent);
  for (const select of selectsAfter) sheltered(select.element);
  for (const host of removed.values()) shelteredWithin(host);
  for (const root of arrived) sheltered(root);

  // The words first: they still read the layout, and their writes (ghosts
  // out of the flow, a hidden fill) never move it. Animations started before
  // them would show in what they read.
  const byParent = new Map<HTMLElement, TextBefore[]>();
  for (const text of texts) {
    if (!changedParents.has(text.parent)) continue;
    const list = byParent.get(text.parent) ?? [];
    list.push(text);
    byParent.set(text.parent, list);
  }
  const plans: WordsPlan[] = [];
  for (const [parent, before] of byParent) {
    const plan = planWords(
      parent,
      before,
      textsAfter.get(parent) ?? [],
      movable(parent)
        ? (offsets.get(parent) ?? carriedBy(parent, offsets))
        : carriedBy(parent, offsets),
    );
    if (plan) plans.push(plan);
  }
  const ghosts = plans.flatMap((plan) => placeWords(running, plan));
  settleGhosts(running, ghosts);

  for (const select of selectsAfter) {
    playSelect(
      running,
      select,
      offsets.get(select.element) ?? carriedBy(select.element, offsets),
    );
  }

  for (const [root, host] of removed) {
    if (!host.isConnected) continue;
    leave(
      running,
      root,
      host,
      drawn.get(root)!,
      movable(host)
        ? (offsets.get(host) ?? carriedBy(host, offsets))
        : carriedBy(host, offsets),
    );
  }
  for (const root of arrived) arrive(running, root);

  // Then the boxes.
  for (const [box] of after) {
    const own = offsets.get(box)!;
    const carried = carriedBy(box, offsets);
    const x = own.x - carried.x;
    const y = own.y - carried.y;
    if ((Math.abs(x) >= 0.25 || Math.abs(y) >= 0.25) && movable(box)) {
      glide(running, box, x, y);
    }
  }
  for (const [box, style] of paints) {
    const from = drawn.get(box)!;
    const to = after.get(box)!;
    stretch(running, box, style, from, to);
  }

  const done = running.animations.map((animation) =>
    animation.finished.catch(() => undefined),
  );
  void Promise.all(done).then(() => {
    if (current === running) finishRunning();
  });
  // A paused page or a stalled frame clock must not leave the ghosts up.
  window.setTimeout(() => {
    if (current === running) finishRunning();
  }, LANGUAGE_MORPH_MS + 400);
}

/** Ends whatever is still playing, at once. */
function finishRunning(): void {
  const running = current;
  if (!running) return;
  current = null;
  for (const animation of running.animations) animation.cancel();
  for (const cleanup of running.cleanups.splice(0).reverse()) cleanup();
}

interface TextAfter {
  node: Text;
  start: { left: number; top: number };
  rect: DOMRect;
}

interface WordsPlan {
  parent: HTMLElement;
  before: TextBefore[];
  after: TextAfter[];
  parentOffset: { x: number; y: number };
  style: CSSStyleDeclaration;
  fill: string;
  lineHeight: number;
  fontSize: number;
  contentLeft: number;
  contentWidth: number;
  /** In a flex or grid box: ghosts placed by coordinates. */
  padding: { left: number; top: number } | null;
  staticPosition: boolean;
  clipped: HTMLElement[];
  /** Beneath a drop-shadow: its ghosts animate where the shadow reaches. */
  sheltered: boolean;
  /** The words' own text-shadow, which hiding them takes away. */
  textShadow: string;
}

/** One stand-in, and where its first glyph must start (layout coordinates). */
interface Ghost {
  element: HTMLElement;
  target: { left: number; top: number };
  base: { x: number; y: number };
  role: "in" | "out" | "still";
  sheltered: boolean;
}

/**
 * Everything an element's words need read before any ghost is written, so
 * that a switch lays the page out once rather than once per element.
 */
function planWords(
  parent: HTMLElement,
  before: TextBefore[],
  after: TextAfter[],
  parentOffset: { x: number; y: number },
): WordsPlan | null {
  const style = getComputedStyle(parent);
  if (/text/.test(style.backgroundClip)) return null;
  // In a flex or grid box a text run is an anonymous item, and an absolute
  // box's static position is the container's start, not the run's: there
  // the ghosts are placed by coordinates instead.
  const placed = /flex|grid/.test(style.display);
  const content = contentBox(parent);
  return {
    parent,
    before,
    after,
    parentOffset,
    style,
    fill: style.webkitTextFillColor || style.color,
    lineHeight: parseFloat(style.lineHeight) || 0,
    fontSize: parseFloat(style.fontSize) || 16,
    contentLeft: content.left,
    contentWidth: content.width,
    padding: placed ? paddingBox(parent) : null,
    staticPosition: style.position === "static",
    clipped: clippingLabels(parent),
    sheltered: shelteredWithin(parent),
    textShadow: style.textShadow === "none" ? "" : style.textShadow,
  };
}

/**
 * Writes an element's ghosts: the new words over the hidden real ones, the
 * old words where they were drawn relative to their (gliding) parent, and a
 * still copy of any words that did not change but share the hidden element.
 */
function placeWords(running: Running, plan: WordsPlan): Ghost[] {
  const { parent, before, after, parentOffset, style, fill, padding } = plan;
  const lines = (rect: DOMRect) =>
    rect.height > plan.lineHeight * 1.5 || rect.height > plan.fontSize * 2.2;
  const ghosts: Ghost[] = [];

  if (padding && plan.staticPosition) {
    const saved = parent.style.position;
    parent.style.position = "relative";
    running.cleanups.push(() => {
      parent.style.position = saved;
    });
  }
  for (const target of plan.clipped) unclipOne(running, target);
  // The real words, hidden. Their text-shadow goes too, since a shadow still
  // draws under transparent words; the element's own children keep their
  // colour and get the shadow back through this property (index.css).
  parent.setAttribute("data-language-morph-hidden", "");
  if (plan.textShadow) {
    parent.style.setProperty("--language-morph-text-shadow", plan.textShadow);
  }
  running.cleanups.push(() => {
    parent.removeAttribute("data-language-morph-hidden");
    parent.style.removeProperty("--language-morph-text-shadow");
  });

  const place = (
    ghost: HTMLElement,
    start: { left: number; top: number },
    rect: DOMRect,
    offset: { x: number; y: number },
  ) => {
    if (!padding) return;
    ghost.style.left = `${start.left - offset.x - padding.left}px`;
    ghost.style.top = `${rect.top - offset.y - padding.top}px`;
    ghost.style.width = `${Math.ceil(rect.width) + 1}px`;
  };

  for (const text of after) {
    const ghost = makeGhost(style, fill, plan.textShadow, text.node.data, {
      multiline: lines(text.rect) && !padding,
      indent: text.start.left - plan.contentLeft,
      width: plan.contentWidth,
    });
    place(ghost, text.start, text.rect, { x: 0, y: 0 });
    parent.insertBefore(ghost, text.node);
    running.cleanups.push(() => ghost.remove());
    const changed = !before.some(
      (old) => old.node === text.node && old.text === text.node.data,
    );
    ghosts.push({
      element: ghost,
      target: text.start,
      base: { x: 0, y: 0 },
      role: changed ? "in" : "still",
      sheltered: plan.sheltered,
    });
  }

  const anchor = after[0]?.node ?? null;
  const anchorStart = after[0]?.start ?? null;
  for (const old of before) {
    if (old.node.isConnected && old.node.data === old.text) continue;
    const ghost = makeGhost(style, fill, plan.textShadow, old.text, {
      multiline: lines(old.rect) && !padding,
      indent: old.start.left - (plan.contentLeft + parentOffset.x),
      width: plan.contentWidth,
    });
    ghost.setAttribute("data-language-morph-out", "");
    if (anchor && anchor.parentNode === parent) {
      parent.insertBefore(ghost, anchor);
    } else {
      parent.appendChild(ghost);
    }
    running.cleanups.push(() => ghost.remove());
    let base = { x: 0, y: 0 };
    if (padding) {
      place(ghost, old.start, old.rect, parentOffset);
    } else {
      // The ghost sits at the new words' start; the old ones began elsewhere.
      const startNow = anchorStart ?? {
        left: plan.contentLeft,
        top: old.start.top,
      };
      base = {
        x: old.start.left - parentOffset.x - startNow.left,
        y: old.start.top - parentOffset.y - startNow.top,
      };
      ghost.style.translate = `${base.x}px ${base.y}px`;
    }
    ghosts.push({
      element: ghost,
      target: {
        left: old.start.left - parentOffset.x,
        top: old.start.top - parentOffset.y,
      },
      base,
      role: "out",
      sheltered: plan.sheltered,
    });
  }
  return ghosts;
}

/**
 * Puts every ghost's first glyph exactly where the real one is, then plays it.
 *
 * Where a ghost's glyphs fall inside its box depends on the font's leading and
 * on how the box was placed, and a guess is off by the half-leading: 2px in a
 * menu row, enough to show as the words dropping when the switch starts and
 * jumping back up when the real words return. So each ghost is measured once
 * it is in place (one layout for all of them) and moved by what it is off.
 */
function settleGhosts(running: Running, ghosts: Ghost[]): void {
  const range = document.createRange();
  const measured = ghosts.map((ghost) => {
    const text = ghost.element.firstChild;
    if (!text) return null;
    range.selectNodeContents(text);
    const first = range.getClientRects()[0];
    const all = range.getBoundingClientRect();
    const box = ghost.element.getBoundingClientRect();
    return first ? { first, all, box } : null;
  });

  ghosts.forEach((ghost, index) => {
    const found = measured[index];
    const element = ghost.element;
    if (found) {
      const dx = ghost.target.left - found.first.left;
      const dy = ghost.target.top - found.first.top;
      if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
        element.style.translate = `${ghost.base.x + dx}px ${ghost.base.y + dy}px`;
      }
      // Grows and shrinks around the middle of its words.
      element.style.transformOrigin = `${found.all.left + found.all.width / 2 - found.box.left}px ${
        found.all.top + found.all.height / 2 - found.box.top
      }px`;
    }
    if (ghost.role === "in") {
      grow(running, element, { sheltered: ghost.sheltered });
    } else if (ghost.role === "out") {
      shrink(running, element, { sheltered: ghost.sheltered });
    }
  });
}

/** What one frame of a played element looks like. */
interface Look {
  opacity?: number;
  scale?: number;
  blur?: number;
  x?: number;
  y?: number;
}

const OUT_TIMING: KeyframeAnimationOptions = {
  duration: OUT_MS,
  easing: "cubic-bezier(0.4, 0, 1, 1)",
  fill: "forwards",
};
const IN_TIMING: KeyframeAnimationOptions = {
  duration: IN_MS,
  delay: IN_DELAY_MS,
  easing: EASE,
  fill: "backwards",
};

/** Leaving: shrinks into a blur and fades. */
function shrink(
  running: Running,
  element: HTMLElement,
  options: { sheltered: boolean; own?: string },
): void {
  play(
    running,
    element,
    [
      { opacity: 1, scale: 1, blur: 0 },
      { opacity: 0, scale: OUT_SCALE, blur: BLUR_PX },
    ],
    OUT_TIMING,
    options,
  );
}

/** Arriving: grows out of a blur. An inline box takes no scale. */
function grow(
  running: Running,
  element: HTMLElement,
  options: { sheltered: boolean; own?: string; inline?: boolean },
): void {
  play(
    running,
    element,
    [
      {
        opacity: 0,
        scale: options.inline ? undefined : IN_SCALE,
        blur: BLUR_PX,
      },
      { opacity: 1, scale: options.inline ? undefined : 1, blur: 0 },
    ],
    IN_TIMING,
    options,
  );
}

/** Carries a box back from (x, y) to where layout put it. */
function glide(running: Running, box: Box, x: number, y: number): void {
  play(
    running,
    box,
    [
      { x, y },
      { x: 0, y: 0 },
    ],
    { duration: LANGUAGE_MORPH_MS, easing: EASE },
    { sheltered: sheltered(box) },
  );
}

/**
 * Plays an element from one look to another.
 *
 * Normally the properties themselves animate, and the browser runs them on
 * its compositor. Beneath a drop-shadow filter that cannot be: Safari gives
 * a compositor animation a layer of its own, and an ancestor's drop-shadow
 * leaves such layers out, so the navbar's words lost their shadow for exactly
 * as long as they played and it snapped back at the end. There the element's
 * style reads registered custom properties and those animate instead: same
 * keyframes, same timing, painted with the page, so every shadow above it
 * draws it as it does at rest.
 */
function play(
  running: Running,
  element: Box,
  frames: [Look, Look],
  timing: KeyframeAnimationOptions,
  options: { sheltered: boolean; own?: string },
): void {
  const own = options.own ?? "";
  const moves = frames[0].x !== undefined;
  const svg = element instanceof SVGElement;
  const svgRest = svg ? svgTransform(element) : "";

  if (options.sheltered && registerLookProperties()) {
    const style = element.style;
    const saved = {
      opacity: style.opacity,
      scale: style.scale,
      filter: style.filter,
      translate: style.translate,
      transform: style.transform,
    };
    const [from] = frames;
    if (from.opacity !== undefined)
      style.opacity = "var(--language-morph-opacity)";
    if (from.scale !== undefined) style.scale = "var(--language-morph-scale)";
    if (from.blur !== undefined) {
      style.filter = `${own} blur(var(--language-morph-blur))`.trim();
    }
    if (moves && svg) {
      style.transform = `translate(var(--language-morph-x), var(--language-morph-y))${svgRest}`;
    } else if (moves) {
      // A ghost's own static nudge (where its glyphs land) rides on top.
      const nudge = saved.translate ? saved.translate.split(/\s+/) : [];
      const [nx = "0px", ny = "0px"] = nudge;
      style.translate = `calc(var(--language-morph-x) + ${nx}) calc(var(--language-morph-y) + ${ny})`;
    }
    const custom = frames.map((look) => ({
      ...(look.opacity !== undefined && {
        "--language-morph-opacity": `${look.opacity}`,
      }),
      ...(look.scale !== undefined && {
        "--language-morph-scale": `${look.scale}`,
      }),
      ...(look.blur !== undefined && {
        "--language-morph-blur": `${look.blur}px`,
      }),
      ...(moves && {
        "--language-morph-x": `${look.x}px`,
        "--language-morph-y": `${look.y}px`,
      }),
    }));
    running.animations.push(element.animate(custom as Keyframe[], timing));
    running.cleanups.push(() => {
      Object.assign(style, saved);
    });
    return;
  }

  const plain = frames.map((look) => ({
    ...(look.opacity !== undefined && { opacity: look.opacity }),
    ...(look.scale !== undefined && { scale: `${look.scale}` }),
    ...(look.blur !== undefined && {
      filter: `${own} blur(${look.blur}px)`.trim(),
    }),
    // Chromium will not hand an SVG element's `translate` to the compositor,
    // so an icon moves by its `transform`, ahead of the one it has.
    ...(moves &&
      (svg
        ? { transform: `translate(${look.x}px, ${look.y}px)${svgRest}` }
        : { translate: `${look.x}px ${look.y}px` })),
  }));
  running.animations.push(element.animate(plain, timing));
}

function svgTransform(element: SVGElement): string {
  const own = getComputedStyle(element).transform;
  return own === "none" ? "" : ` ${own}`;
}

let lookProperties: boolean | null = null;

/** The custom properties a sheltered element animates, registered once. */
function registerLookProperties(): boolean {
  if (lookProperties !== null) return lookProperties;
  if (
    typeof CSS === "undefined" ||
    typeof CSS.registerProperty !== "function"
  ) {
    return (lookProperties = false);
  }
  const register = (name: string, syntax: string, initialValue: string) => {
    try {
      CSS.registerProperty({ name, syntax, inherits: false, initialValue });
    } catch {
      // Registered already (a second copy of this module, a hot reload).
    }
  };
  register("--language-morph-opacity", "<number>", "1");
  register("--language-morph-scale", "<number>", "1");
  register("--language-morph-blur", "<length>", "0px");
  register("--language-morph-x", "<length>", "0px");
  register("--language-morph-y", "<length>", "0px");
  return (lookProperties = true);
}

/**
 * How far a text-shadow reaches past the glyphs, at most: every offset and
 * blur in it added up. Generous on purpose; the room is invisible.
 */
function shadowRoom(textShadow: string): number {
  if (!textShadow || textShadow === "none") return 0;
  const lengths = textShadow.match(/-?[\d.]+px/g) ?? [];
  const reach = lengths.reduce(
    (sum, length) => sum + Math.abs(parseFloat(length)),
    0,
  );
  return Math.min(64, Math.ceil(reach));
}

/** An element's own filter, as written in a filter list. */
function ownFilter(element: Element): string {
  const filter = getComputedStyle(element).filter;
  return filter && filter !== "none" ? filter : "";
}

const DROP_SHADOW = /drop-shadow\((?:[^()]|\([^()]*\))*\)/g;

/**
 * True when a drop-shadow filter on the element or above it draws what is
 * inside: there, what the switch plays must stay inside that painting.
 */
function shelteredWithin(element: HTMLElement): boolean {
  return inheritedShadows(element) !== "";
}

/** True when a drop-shadow filter above the element draws it. */
function sheltered(element: Element): boolean {
  const parent = element.parentElement;
  return parent ? shelteredWithin(parent) : false;
}

/**
 * The drop-shadows every ancestor's filter draws an element with, innermost
 * first: the order the browser applies them in.
 */
function inheritedShadows(element: HTMLElement): string {
  const cached = shadowCache.get(element);
  if (cached !== undefined) return cached;
  let value = "";
  if (element !== document.body) {
    const filter = getComputedStyle(element).filter;
    const own =
      filter && filter !== "none" ? (filter.match(DROP_SHADOW) ?? []) : [];
    const above = element.parentElement
      ? inheritedShadows(element.parentElement)
      : "";
    value = [...own, above].filter(Boolean).join(" ");
  }
  shadowCache.set(element, value);
  return value;
}

/** Read once per switch, before anything it animates changes a filter. */
let shadowCache = new Map<Element, string>();

/**
 * The label boxes that would clip leaving words: a `truncate` label that the
 * new words made narrower would cut the old ones short. Only label-sized
 * boxes: a card or a poster frame keeps its clip.
 */
function clippingLabels(parent: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  let element: HTMLElement | null = parent;
  for (let level = 0; element && level < 4; level += 1) {
    const style = getComputedStyle(element);
    const clips = /hidden|clip/.test(`${style.overflowX} ${style.overflowY}`);
    const lineHeight =
      parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 20;
    if (clips && element.offsetHeight <= lineHeight * 2.6) found.push(element);
    element = element.parentElement;
  }
  return found;
}

function unclipOne(running: Running, target: HTMLElement): void {
  if (target.hasAttribute("data-language-morph-unclipped")) return;
  const saved = {
    overflow: target.style.overflow,
    textOverflow: target.style.textOverflow,
  };
  target.setAttribute("data-language-morph-unclipped", "");
  target.style.overflow = "visible";
  target.style.textOverflow = "clip";
  running.cleanups.push(() => {
    target.removeAttribute("data-language-morph-unclipped");
    target.style.overflow = saved.overflow;
    target.style.textOverflow = saved.textOverflow;
  });
}

/**
 * A stand-in for a run of words, placed where the real run starts: an
 * absolutely placed box with no offsets of its own sits at its static
 * position, which is exactly where the text node after it begins.
 */
function makeGhost(
  style: CSSStyleDeclaration,
  fill: string,
  textShadow: string,
  words: string,
  layout: { multiline: boolean; indent: number; width: number },
): HTMLElement {
  const ghost = document.createElement("span");
  ghost.textContent = words;
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-language-morph-ghost", "");
  const inlineParent = style.display === "inline";
  // Room for the words' text-shadow inside the ghost's own box: while its
  // filter animates, Safari paints nothing past that box, and the shadow
  // below the words was cut off. The margin takes the room back out, so the
  // words stay where they are.
  const room = shadowRoom(textShadow);
  Object.assign(ghost.style, {
    position: "absolute",
    pointerEvents: "none",
    userSelect: "none",
    boxSizing: "content-box",
    margin: `${-room}px`,
    padding: `${room}px`,
    border: "0",
    background: "none",
    webkitTextFillColor: fill,
    textShadow: textShadow || "none",
    whiteSpace: layout.multiline ? style.whiteSpace : "pre",
    zIndex: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  if (layout.multiline && !inlineParent) {
    // Wraps in the parent's width, its first line starting where the run did.
    ghost.style.width = `${layout.width}px`;
    ghost.style.marginLeft = `${-layout.indent - room}px`;
    ghost.style.textIndent = `${layout.indent}px`;
  }
  return ghost;
}

interface SelectBefore {
  element: HTMLSelectElement;
  text: string;
  rect: DOMRect;
}

/** A closed select draws its chosen option itself, out of reach of the DOM. */
function collectSelects(): SelectBefore[] {
  const found: SelectBefore[] = [];
  for (const element of Array.from(document.querySelectorAll("select"))) {
    if (element.closest("[data-language-morph='off']")) continue;
    const rect = element.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      continue;
    }
    found.push({ element, text: selectedText(element), rect });
  }
  return found;
}

function selectedText(element: HTMLSelectElement): string {
  return element.selectedOptions[0]?.textContent?.trim() ?? "";
}

/**
 * A select's words, played by ghosts laid over it: its own text is hidden,
 * and the ghosts sit beside it in its parent, at its text's place.
 */
function playSelect(
  running: Running,
  select: SelectBefore & { next: string; to: DOMRect },
  offset: { x: number; y: number },
): void {
  const element = select.element;
  const parent = element.parentElement;
  if (!parent) return;
  const style = getComputedStyle(element);
  const color = style.color;
  const shelter = sheltered(element);
  // Only the words: the select's arrow is drawn in its `color`.
  const saved = element.style.webkitTextFillColor;
  element.style.webkitTextFillColor = "transparent";
  running.cleanups.push(() => {
    element.style.webkitTextFillColor = saved;
  });

  const inset =
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.paddingLeft) || 0);
  const make = (
    words: string,
    rect: DOMRect,
    shift: { x: number; y: number },
  ) => {
    const ghost = document.createElement("span");
    ghost.textContent = words;
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("data-language-morph-ghost", "");
    Object.assign(ghost.style, {
      position: "absolute",
      display: "flex",
      alignItems: "center",
      pointerEvents: "none",
      whiteSpace: "pre",
      font: style.font,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform,
      color,
      webkitTextFillColor: color,
      textShadow: style.textShadow,
      boxSizing: "content-box",
      padding: `${shadowRoom(style.textShadow)}px`,
      margin: `${-shadowRoom(style.textShadow)}px`,
      height: `${rect.height}px`,
      zIndex: "1",
    } satisfies Partial<CSSStyleDeclaration>);
    element.after(ghost);
    running.cleanups.push(() => ghost.remove());
    const holder = ghost.offsetParent as HTMLElement | null;
    const base = holder ? paddingBox(holder) : { left: 0, top: 0 };
    ghost.style.left = `${rect.left + inset - shift.x - base.left}px`;
    ghost.style.top = `${rect.top - shift.y - base.top}px`;
    ghost.style.transformOrigin = "left center";
    return ghost;
  };

  shrink(running, make(select.text, select.rect, offset), {
    sheltered: shelter,
  });
  grow(running, make(select.next, select.to, { x: 0, y: 0 }), {
    sheltered: shelter,
  });
}

/**
 * A replaced element, put back where it stood and played out. Its host is
 * made the box it is placed in, so a host gliding on its own carries it.
 */
function leave(
  running: Running,
  root: HTMLElement,
  host: HTMLElement,
  from: Drawn,
  hostOffset: { x: number; y: number },
): void {
  const style = getComputedStyle(host);
  if (style.display === "inline" || style.display === "contents") return;
  const pad = paddingBox(host);
  const shelter = shelteredWithin(host);
  if (style.position === "static") {
    const saved = host.style.position;
    host.style.position = "relative";
    running.cleanups.push(() => {
      host.style.position = saved;
    });
  }
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("data-language-morph-ghost", "");
  Object.assign(root.style, {
    position: "absolute",
    left: `${from.left - hostOffset.x - pad.left}px`,
    top: `${from.top - hostOffset.y - pad.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    boxSizing: "border-box",
    pointerEvents: "none",
    translate: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  host.appendChild(root);
  running.cleanups.push(() => root.remove());
  // Its own filter (a pill's shadow) stays on while it blurs away.
  shrink(running, root, { sheltered: shelter, own: ownFilter(root) });
}

/** A new element, grown out of a blur where it stands. */
function arrive(running: Running, root: HTMLElement): void {
  grow(running, root, {
    sheltered: sheltered(root),
    own: ownFilter(root),
    inline: getComputedStyle(root).display === "inline",
  });
}

/** Every text node on screen now. */
function visibleTextNodes(): Text[] {
  return collectTexts().map((text) => text.node);
}

/** Every visible text node, with where its words are drawn. */
function collectTexts(): TextBefore[] {
  const found: TextBefore[] = [];
  const width = window.innerWidth;
  const height = window.innerHeight;
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    range.selectNodeContents(text);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (
      rect.bottom < -VIEWPORT_MARGIN ||
      rect.top > height + VIEWPORT_MARGIN ||
      rect.right < -VIEWPORT_MARGIN ||
      rect.left > width + VIEWPORT_MARGIN
    ) {
      continue;
    }
    const parent = text.parentElement!;
    if (
      typeof parent.checkVisibility === "function" &&
      !parent.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      continue;
    }
    const first = range.getClientRects()[0] ?? rect;
    found.push({
      node: text,
      parent,
      text: text.data,
      start: { left: first.left, top: first.top },
      rect,
    });
  }
  return found;
}

function readTexts(parent: HTMLElement): TextAfter[] {
  const range = document.createRange();
  const found: TextAfter[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType !== Node.TEXT_NODE || !child.nodeValue?.trim()) {
      continue;
    }
    range.selectNodeContents(child);
    const rect = range.getBoundingClientRect();
    const first = range.getClientRects()[0] ?? rect;
    found.push({
      node: child as Text,
      start: { left: first.left, top: first.top },
      rect,
    });
  }
  return found;
}

const SKIP = [
  "script",
  "style",
  "noscript",
  "textarea",
  "input",
  "select",
  "svg",
  "[contenteditable='true']",
  "[data-language-morph='off']",
  "[data-language-morph-ghost]",
].join(",");

/** How many ancestors above a text a change of its size can reach. */
const MAX_LEVELS = 12;

/**
 * The text's element, its ancestors, and the children of each: everything a
 * change of the words' size can move or resize.
 */
function reach(element: HTMLElement): Box[] {
  const found: Box[] = [element];
  // What sits beside the words inside their own element: an icon, a logo.
  for (const child of Array.from(element.children)) {
    if (isBox(child)) found.push(child);
  }
  let parent = element.parentElement;
  for (let level = 0; parent && level < MAX_LEVELS; level += 1) {
    if (parent === document.body || parent.hasAttribute("data-morph-root")) {
      break;
    }
    found.push(parent);
    for (const child of Array.from(parent.children)) {
      if (isBox(child)) found.push(child);
    }
    parent = parent.parentElement;
  }
  return found;
}

function isBox(element: Element): element is Box {
  return (
    element instanceof HTMLElement ||
    (element instanceof SVGElement && element.ownerSVGElement === null)
  );
}

function measure(box: Box): Drawn {
  const rect = box.getBoundingClientRect();
  const html = box instanceof HTMLElement;
  return {
    left: rect.left,
    top: rect.top,
    width: (html && box.offsetWidth) || rect.width,
    height: (html && box.offsetHeight) || rect.height,
  };
}

function movable(box: Box): boolean {
  if (box.hasAttribute("data-language-morph-ghost")) return false;
  const style = getComputedStyle(box);
  return (
    style.display !== "inline" &&
    style.display !== "none" &&
    style.display !== "contents" &&
    style.position !== "fixed"
  );
}

function carriedBy(
  element: Box,
  offsets: Map<Box, { x: number; y: number }>,
): { x: number; y: number } {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const found = offsets.get(node);
    if (found && movable(node)) return found;
  }
  return { x: 0, y: 0 };
}

/** The padding box's corner, which an absolute child's offsets start from. */
function paddingBox(element: HTMLElement): { left: number; top: number } {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    left: rect.left + (parseFloat(style.borderLeftWidth) || 0),
    top: rect.top + (parseFloat(style.borderTopWidth) || 0),
  };
}

/** Screen pixels per layout pixel inside `element`, for a scaled ancestor. */
function screenScale(element: HTMLElement | null): number {
  if (!element || element.offsetWidth === 0) return 1;
  const scale = element.getBoundingClientRect().width / element.offsetWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function contentBox(element: HTMLElement): { left: number; width: number } {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const left =
    rect.left +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.paddingLeft) || 0);
  const width =
    element.clientWidth -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0);
  return { left, width: Math.max(0, width) };
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
  return parseFloat(alpha[1]!) > 0;
}

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
 * Draws a painted box from its old size to its new one, top-left corner fixed,
 * without laying anything out.
 *
 * The fill is one layer inside four nested clips, one per corner. The first
 * stays at the box's corner and rounds the top left; the second moves right by
 * the width of the moment and rounds the top right; the third moves down by
 * the height and rounds the bottom left; the fourth rounds the bottom right.
 * The fill moves back by both, so it never moves. Every translate is linear in
 * the width or the height, so with one easing they agree at every frame.
 */
function stretch(
  running: Running,
  host: HTMLElement,
  paint: CSSStyleDeclaration,
  from: Drawn,
  to: Drawn,
): void {
  const spanX = Math.ceil(Math.max(from.width, to.width)) + 1;
  const spanY = Math.ceil(Math.max(from.height, to.height)) + 1;
  const borderLeft = parseFloat(paint.borderLeftWidth) || 0;
  const borderTop = parseFloat(paint.borderTopWidth) || 0;
  const read = (key: string) =>
    (paint as unknown as Record<string, string>)[key] ?? "";

  const layer = (styles: Partial<CSSStyleDeclaration>) => {
    const element = document.createElement("span");
    Object.assign(element.style, {
      position: "absolute",
      boxSizing: "border-box",
      pointerEvents: "none",
      width: `${spanX}px`,
      height: `${spanY}px`,
      ...styles,
    });
    return element;
  };

  const topLeft = layer({
    left: `${-borderLeft}px`,
    top: `${-borderTop}px`,
    overflow: "hidden",
    zIndex: "-1",
    borderTopLeftRadius: read("borderTopLeftRadius"),
  });
  topLeft.setAttribute("aria-hidden", "true");
  topLeft.setAttribute("data-language-morph-ghost", "");
  // Covers [w - X, w] across: moved right by w.
  const topRight = layer({
    left: `${-spanX}px`,
    top: "0px",
    overflow: "hidden",
    borderTopRightRadius: read("borderTopRightRadius"),
  });
  // Covers [h - Y, h] down, back at the left edge: moved by (-w, h).
  const bottomLeft = layer({
    left: `${spanX}px`,
    top: `${-spanY}px`,
    overflow: "hidden",
    borderBottomLeftRadius: read("borderBottomLeftRadius"),
  });
  // Covers [w - X, w] across: moved right by w again.
  const bottomRight = layer({
    left: `${-spanX}px`,
    top: "0px",
    overflow: "hidden",
    borderBottomRightRadius: read("borderBottomRightRadius"),
  });
  const fill = layer({ left: `${spanX}px`, top: `${spanY}px` });
  const fillStyle = fill.style as unknown as Record<string, string>;
  for (const key of FILL) fillStyle[key] = read(key);
  bottomRight.appendChild(fill);
  bottomLeft.appendChild(bottomRight);
  topRight.appendChild(bottomLeft);
  topLeft.appendChild(topRight);
  const layers = [topLeft];

  const outlined =
    paint.boxShadow !== "none" ||
    (parseFloat(paint.borderTopWidth) > 0 &&
      visibleColor(paint.borderTopColor));
  let outline: HTMLElement | null = null;
  if (outlined) {
    outline = layer({
      left: `${-borderLeft}px`,
      top: `${-borderTop}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
      zIndex: "-1",
      transformOrigin: "left top",
    });
    outline.setAttribute("aria-hidden", "true");
    outline.setAttribute("data-language-morph-ghost", "");
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
  set("transition", "none");
  for (const [key, value] of Object.entries(HANDED_OVER)) set(key, value);
  const style = getComputedStyle(host);
  if (style.position === "static") set("position", "relative");
  set("isolation", "isolate");
  const shrinks = from.width > to.width || from.height > to.height;
  if (shrinks && style.overflow !== "visible") set("overflow", "visible");
  for (const added of [...layers].reverse()) host.prepend(added);

  const timing = {
    duration: LANGUAGE_MORPH_MS,
    easing: EASE,
    fill: "forwards" as const,
  };
  const slide = (
    target: HTMLElement,
    at: (width: number, height: number) => string,
  ) =>
    target.animate(
      [
        { translate: at(from.width, from.height) },
        { translate: at(to.width, to.height) },
      ],
      timing,
    );
  running.animations.push(
    slide(topRight, (w) => `${w}px 0px`),
    slide(bottomLeft, (w, h) => `${-w}px ${h}px`),
    slide(bottomRight, (w) => `${w}px 0px`),
    slide(fill, (w, h) => `${-w}px ${-h}px`),
  );
  if (outline && to.width > 0 && to.height > 0) {
    running.animations.push(
      outline.animate(
        [
          { scale: `${from.width / to.width} ${from.height / to.height}` },
          { scale: "1 1" },
        ],
        timing,
      ),
    );
  }

  running.cleanups.push(() => {
    for (const added of layers) added.remove();
    for (const [key, value] of saved) {
      if (key !== "transition") hostStyle[key] = value;
    }
    void getComputedStyle(host).backgroundColor;
    hostStyle.transition = saved.get("transition") ?? "";
  });
}

function canMorph(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof HTMLElement.prototype.animate === "function" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}
