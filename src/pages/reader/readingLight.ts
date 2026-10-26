import type { Book, NavItem } from "epubjs";
import { DROP_CAP_LINES } from "./epubTypography";
import {
  DEFAULT_READER_SETTINGS,
  READING_LINE,
  clamp,
  type ReaderLightShape,
} from "./readerModel";

/** One line of a block, in px from the block's top, and the ink it carries. */
interface LitSlot {
  top: number;
  bottom: number;
  value: number;
  /** Where the current fade started, where it is going, and when it began (0: settled). */
  from: number;
  goal: number;
  target: number;
  start: number;
}

interface LitBlock {
  element: HTMLElement;
  top: number;
  bottom: number;
  /** One slot until the block comes near the light and its lines are measured. */
  slots: LitSlot[];
  measured: boolean;
  /**
   * The drop cap's box, lit exactly as the paragraph's first line: it is that
   * line's first letter, so it never splits into the bands of the lines it
   * stands beside. `firstLine` is the middle of that line, in px from the top.
   */
  dropCap: {
    left: number;
    top: number;
    width: number;
    height: number;
    firstLine: number;
  } | null;
  /** The opacity and mask last written, so unchanged ink is not written again. */
  written: string;
  /** Its geometry changed, so its mask is rewritten even if no ink moved. */
  dirty: boolean;
}

interface LitDocument {
  sectionIndex: number;
  height: number;
  /** Its faces were still loading when it was last measured. */
  fontsLoading: boolean;
  blocks: LitBlock[];
  resting: boolean;
}

export interface ReadingLinePosition {
  sectionIndex: number;
  /** How far through the section the reading line is, 0 to 1. */
  fraction: number;
}

/** The ink fades between values the way the block opacity used to: 0.35s, sine in-out. */
const FADE_MS = 350;
const easeSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

const slot = (top: number, bottom: number, value: number): LitSlot => ({
  top,
  bottom,
  value,
  from: value,
  goal: value,
  target: value,
  start: 0,
});

/** A text line of a block, in px from the block's top and left edges. */
interface Row {
  top: number;
  bottom: number;
  left: number;
}

/**
 * A block's top in its document as laid out, before any transform. Blocks
 * fade in with a lift of 0.6rem, and a rect read then puts a block up to half a
 * line from where it comes to rest; lines measured against that put every step
 * of the light through the middle of a line.
 */
function layoutTop(element: HTMLElement) {
  let top = 0;

  for (
    let node: HTMLElement | null = element;
    node;
    node = node.offsetParent as HTMLElement | null
  ) {
    top += node.offsetTop;
  }

  return top;
}

/**
 * The boxes a range gives for a drop cap's letter (and any punctuation set with
 * it), which are not a line of text: WebKit gives the glyph's box, three lines
 * tall, and Chromium a one-line box sitting above the first line.
 */
function dropCapBoxes(element: HTMLElement): DOMRect[] {
  if (!element.classList.contains("seyirlik-dropcap")) {
    return [];
  }

  const document = element.ownerDocument;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const letter = /^(\s*)[\p{P}\s]*[\p{L}\p{N}]/u.exec(text);

    if (!letter) {
      if (text.trim()) {
        return [];
      }

      continue;
    }

    const range = document.createRange();
    range.setStart(node, letter[1].length);
    range.setEnd(node, letter[0].length);
    return Array.from(range.getClientRects());
  }

  return [];
}

/**
 * The lines a block is set in, from the boxes of its text, or null when the
 * block is set tighter than its own type (a chapter numeral, a display
 * heading): its ink overruns its lines, so it is lit as one, since stepping it
 * would need a mask and a mask would crop that ink. Boxes taller than a line
 * and a half (an inline image) are left out so they do not merge three lines
 * into one, and so is a drop cap's letter, which has its own layer.
 *
 * Boxes are read against the block's own box as it stands now, so a transform
 * on the block moves both alike and cancels out.
 */
function measureRows(element: HTMLElement): Row[] | null {
  const document = element.ownerDocument;
  const style = document.defaultView?.getComputedStyle(element);
  const lineHeight =
    parseFloat(style?.lineHeight ?? "") ||
    parseFloat(style?.fontSize ?? "16") * 1.5;
  const fontSize = parseFloat(style?.fontSize ?? "16");

  if (lineHeight < fontSize * 1.15) {
    return null;
  }

  const origin = element.getBoundingClientRect();
  const cap = dropCapBoxes(element);
  const isCap = (box: DOMRect) =>
    cap.some(
      (other) =>
        Math.abs(other.top - box.top) < 0.5 &&
        Math.abs(other.left - box.left) < 0.5 &&
        Math.abs(other.height - box.height) < 0.5,
    );
  const range = document.createRange();
  range.selectNodeContents(element);
  const boxes = Array.from(range.getClientRects())
    .filter(
      (box) =>
        box.width > 0 &&
        box.height > 0 &&
        box.height <= lineHeight * 1.6 &&
        !isCap(box),
    )
    .map((box) => ({
      top: box.top - origin.top,
      bottom: box.bottom - origin.top,
      left: box.left - origin.left,
    }))
    .sort((a, b) => a.top - b.top);
  const rows: Row[] = [];

  for (const box of boxes) {
    const last = rows[rows.length - 1];
    const overlap = last
      ? Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top)
      : 0;

    if (
      last &&
      overlap > Math.min(last.bottom - last.top, box.bottom - box.top) * 0.5
    ) {
      last.top = Math.min(last.top, box.top);
      last.bottom = Math.max(last.bottom, box.bottom);
      last.left = Math.min(last.left, box.left);
    } else {
      rows.push({ ...box });
    }
  }

  return rows;
}

/**
 * Each line's slot reaches halfway into the leading on either side, so the
 * slots tile the block without gaps.
 */
function slotsFor(rows: Row[] | null, height: number): LitSlot[] {
  if (!rows || rows.length === 0) {
    return [slot(0, height, 1)];
  }

  return rows.map((row, index) =>
    slot(
      index === 0 ? 0 : (rows[index - 1].bottom + row.top) / 2,
      index === rows.length - 1
        ? height
        : (row.bottom + rows[index + 1].top) / 2,
      1,
    ),
  );
}

/**
 * The drop cap's box, for its own layer of light: the whole of the lines it
 * stands beside, from the block's left edge to where their text begins. The
 * cap is a pseudo-element, and a range over its character returns either the
 * glyph's box or a small placeholder at the left edge of the first line, so
 * the width is the furthest any of those lines is indented, which a
 * placeholder cannot pull in. The number of lines is the reader's own
 * (`DROP_CAP_LINES`), not the computed style, which Safari does not report for
 * the pseudo-element.
 */
function measureDropCap(
  element: HTMLElement,
  rows: Row[] | null,
  slots: LitSlot[],
) {
  if (!element.classList.contains("seyirlik-dropcap") || !rows?.length) {
    return null;
  }

  const view = element.ownerDocument.defaultView;
  const supported =
    view?.CSS?.supports?.("initial-letter", String(DROP_CAP_LINES)) ||
    view?.CSS?.supports?.("-webkit-initial-letter", String(DROP_CAP_LINES));

  // Without initial-letter the first letter is ordinary text on the first line.
  if (!supported) {
    return null;
  }

  const beside = rows.slice(0, DROP_CAP_LINES);
  const width = Math.max(...beside.map((row) => row.left));
  const height = slots[beside.length - 1].bottom;
  const firstLine = (slots[0].top + slots[0].bottom) / 2;

  return width > 0 && height > 0
    ? { left: 0, top: 0, width, height, firstLine }
    : null;
}

const ink = (value: number) => `rgba(0,0,0,${value.toFixed(3)})`;

interface BlockMask {
  image: string;
  /** Per-layer placement, or "" for one layer over the whole block. */
  position: string;
  size: string;
  repeat: string;
}

const flat = (image: string): BlockMask => ({
  image,
  position: "",
  size: "",
  repeat: "",
});

/**
 * The light on a block as a mask: a hard step at each line's slot edge, which
 * falls in the leading, so every line carries one even ink. Paragraph mode and
 * unmeasured blocks have one slot, a flat mask.
 *
 * A drop cap adds a second layer over the cap's own box. Its placement goes in
 * mask-position / -size / -repeat: written inside mask-image (shorthand syntax)
 * the browser rejects the whole value, and a chapter's first paragraph lost its
 * mask and lit as one block whenever the light touched any of its lines.
 */
function blockMask(block: LitBlock): BlockMask {
  const { slots } = block;

  if (slots.length === 1) {
    return flat(
      `linear-gradient(${ink(slots[0].value)}, ${ink(slots[0].value)})`,
    );
  }

  /** The lines as one vertical gradient, for a layer that starts `offset` px down. */
  const lines = (offset: number) =>
    `linear-gradient(180deg, ${slots
      .map(
        (line) =>
          `${ink(line.value)} ${(line.top - offset).toFixed(1)}px, ${ink(line.value)} ${(line.bottom - offset).toFixed(1)}px`,
      )
      .join(", ")})`;

  if (!block.dropCap) {
    return flat(lines(0));
  }

  /*
   * Three layers that never overlap, so nothing adds up: the cap's box in the
   * first line's ink, the text beside it, and the column beneath it. A single
   * line layer under the cap would show a lit line through it.
   */
  const cap = block.dropCap;
  const value = (
    slots.find(
      (line) => cap.firstLine >= line.top && cap.firstLine < line.bottom,
    ) ?? slots[0]
  ).value;
  const w = cap.width.toFixed(1);
  const h = cap.height.toFixed(1);

  return {
    image: `linear-gradient(${ink(value)}, ${ink(value)}), ${lines(0)}, ${lines(cap.height)}`,
    position: `0px 0px, ${w}px 0px, 0px ${h}px`,
    size: `${w}px ${h}px, calc(100% - ${w}px) 100%, ${w}px calc(100% - ${h}px)`,
    repeat: "no-repeat, no-repeat, no-repeat",
  };
}

/** Writes a mask, standard and -webkit- (Safari), or clears it with an empty image. */
function writeMask(element: HTMLElement, mask: BlockMask) {
  const { style } = element;

  for (const prefix of ["", "-webkit-"]) {
    style.setProperty(`${prefix}mask-image`, mask.image);
    style.setProperty(`${prefix}mask-position`, mask.position);
    style.setProperty(`${prefix}mask-size`, mask.size);
    style.setProperty(`${prefix}mask-repeat`, mask.repeat);
  }
}

/**
 * The reading light, and where the reading line falls in the book.
 *
 * The light falls on the paragraph at the reading line (the default) or on the
 * line there: that unit carries full ink and the text around it falls off
 * towards a floor, like the glow of a screen. Each line or paragraph keeps one
 * even ink and fades as a whole when the light moves on, so nothing is ever
 * half-lit and the text never moves.
 *
 * Documents are epub.js iframes sized to their content, so a block's place in
 * the window is its iframe's rect plus an offset inside the document. Offsets
 * are cached per document and re-measured only when the document's height
 * changes; a block's lines are measured only once it comes near the light.
 * Each scroll frame sets the ink each line should carry, eases it there over
 * 0.35s, and writes only the blocks whose ink moved.
 */
export class ReadingLight {
  private readonly documents = new Map<Document, LitDocument>();
  private floor = 1;
  private shape: ReaderLightShape = DEFAULT_READER_SETTINGS.lightShape;
  private reach = DEFAULT_READER_SETTINGS.lineReach;
  private fading = false;
  /** The blocks given a layer of their own last frame (see `frame`). */
  private layered = new Set<HTMLElement>();
  /** The next frame sets every line's ink at once, without its fade. */
  private snapping = false;

  constructor(private readonly viewport: HTMLElement) {}

  add(document: Document, sectionIndex: number, elements: HTMLElement[]) {
    this.documents.set(document, {
      sectionIndex,
      height: -1,
      fontsLoading: false,
      resting: false,
      blocks: elements.map((element) => ({
        element,
        top: 0,
        bottom: 0,
        slots: [slot(0, 0, 1)],
        measured: false,
        dropCap: null,
        written: "|",
        dirty: false,
      })),
    });
  }

  /**
   * The floor the light falls to (1: no light), what it lights, and how far
   * from the lit line or paragraph it has fallen off, as a share of the
   * viewport.
   */
  setLight(floor: number, shape: ReaderLightShape, reach: number) {
    if (floor === this.floor && shape === this.shape && reach === this.reach) {
      return;
    }

    const reshaped = shape !== this.shape;
    this.floor = floor;
    this.shape = shape;
    this.reach = reach;
    this.documents.forEach((entry) => {
      entry.resting = false;

      if (reshaped) {
        entry.height = -1;
      }
    });
  }

  /**
   * The next frame puts every line at its ink at once. The read-along hands
   * the light over this way: the page takes the voice's ink in the same
   * frame, so a fade would show the text dipping or flaring on the way.
   */
  snapNext() {
    this.snapping = true;
    this.documents.forEach((entry) => {
      entry.resting = false;
    });
  }

  /** True while some line is still fading towards its ink; the caller runs another frame. */
  get isFading() {
    return this.fading;
  }

  clear() {
    this.documents.clear();
    this.layered.clear();
  }

  /** Lights the text for the current scroll position and reports where the reading line is. */
  frame(): ReadingLinePosition | null {
    const view = this.viewport.getBoundingClientRect();
    const line = view.top + view.height * READING_LINE;
    const unlit = this.floor >= 1;
    const byLine = this.shape === "line";
    const span = Math.max(1, view.height * this.reach);
    const now = performance.now();
    const snap = this.snapping;
    this.snapping = false;
    let position: ReadingLinePosition | null = null;
    const near: Array<{ block: LitBlock; top: number; entry: LitDocument }> =
      [];
    const visited: Array<{ entry: LitDocument; far: boolean }> = [];
    const stillFading = new Set<LitDocument>();

    this.fading = false;

    this.documents.forEach((entry, document) => {
      const frame = document.defaultView?.frameElement as HTMLElement | null;

      if (!frame?.isConnected) {
        this.documents.delete(document);
        return;
      }

      const rect = frame.getBoundingClientRect();

      if (rect.height > 0 && line >= rect.top && line < rect.bottom) {
        position = {
          sectionIndex: entry.sectionIndex,
          fraction: clamp((line - rect.top) / rect.height, 0, 1),
        };
      }

      const height = document.body?.scrollHeight ?? 0;
      // A face that arrives (or fails, and falls back) after the lines were
      // measured can move them without changing the document's height: the
      // drop cap's face sets how far the lines beside it are indented. Font
      // events do not reach a listener reliably in WebKit, so the set's status
      // is read instead.
      const fontsLoading = document.fonts?.status === "loading";
      const fontsArrived = entry.fontsLoading && !fontsLoading;
      entry.fontsLoading = fontsLoading;

      if (height !== entry.height || fontsArrived) {
        entry.height = height;
        entry.resting = false;
        for (const block of entry.blocks) {
          block.top = layoutTop(block.element);
          block.bottom = block.top + block.element.offsetHeight;
          block.measured = false;
          block.dirty = true;

          if (!byLine || block.slots.length === 1) {
            const value = block.slots[0]?.value ?? 1;
            block.slots = [slot(0, block.bottom - block.top, value)];
            block.dropCap = null;
          }
        }
      }

      const far =
        rect.bottom < view.top - span || rect.top > view.bottom + span;

      if ((far || unlit) && entry.resting) {
        return;
      }

      for (const block of entry.blocks) {
        const top = rect.top + block.top;
        const bottom = rect.top + block.bottom;

        if (unlit) {
          block.slots.forEach((line) => {
            line.target = 1;
          });
          near.push({ block, top, entry });
          continue;
        }

        if (
          byLine &&
          !block.measured &&
          bottom > view.top - span &&
          top < view.bottom + span
        ) {
          // Lines keep the ink they had where they were, so a reflow does not flash.
          const before = block.slots;
          const rows = measureRows(block.element);
          block.slots = slotsFor(rows, block.bottom - block.top);
          block.slots.forEach((slot) => {
            const middle = (slot.top + slot.bottom) / 2;
            const was =
              before.find((old) => middle >= old.top && middle < old.bottom) ??
              before[before.length - 1];
            slot.value = slot.from = slot.goal = slot.target = was.value;
          });
          block.dirty = true;
          block.dropCap = measureDropCap(block.element, rows, block.slots);
          block.measured = true;
        }

        near.push({ block, top, entry });
      }

      visited.push({ entry, far });
    });

    if (!unlit) {
      // The lit line: the one the reading line falls in, or the nearest one
      // when it falls between blocks.
      let lit = line;
      let nearest = Infinity;

      if (byLine) {
        for (const { block, top } of near) {
          for (const slot of block.slots) {
            const distance = Math.max(
              0,
              top + slot.top - line,
              line - (top + slot.bottom),
            );

            if (distance < nearest) {
              nearest = distance;
              lit = top + (slot.top + slot.bottom) / 2;
            }
          }
        }
      }

      for (const { block, top } of near) {
        for (const slot of block.slots) {
          let t: number;

          if (byLine) {
            const distance = Math.abs(top + (slot.top + slot.bottom) / 2 - lit);
            // Ease-out: the lines beside the lit one already step down, so it
            // reads as one line lit rather than a soft wash.
            const x = Math.min(1, distance / span);
            t = 1 - (1 - x) * (1 - x);
          } else {
            const distance = Math.max(
              0,
              top + slot.top - line,
              line - (top + slot.bottom),
            );
            const x = Math.min(1, distance / span);
            t = x * x * (3 - 2 * x);
          }

          slot.target = 1 - (1 - this.floor) * t;
        }
      }
    }

    for (const { block, entry } of near) {
      let changed = false;

      for (const slot of block.slots) {
        // A new target restarts the fade from wherever the ink is now.
        if (Math.abs(slot.target - slot.goal) > 0.005) {
          slot.from = slot.value;
          slot.goal = slot.target;
          slot.start = now;
        }

        if (slot.start === 0) {
          continue;
        }

        const progress = snap ? 1 : Math.min(1, (now - slot.start) / FADE_MS);
        slot.value = slot.from + (slot.goal - slot.from) * easeSine(progress);
        changed = true;

        if (progress >= 1) {
          slot.value = slot.goal;
          slot.start = 0;
        } else {
          this.fading = true;
          stillFading.add(entry);
        }
      }

      if (changed || block.dirty) {
        block.dirty = false;
        // One even ink is opacity, as the paragraph light always was. A mask
        // clips everything to the block's box, and a tightly set heading's
        // ink (the dot of an İ) stands above it; only lines that step need one.
        const first = block.slots[0].value;
        const even = block.slots.every(
          (slot) => Math.abs(slot.value - first) < 0.001,
        );
        const mask = even ? flat("") : blockMask(block);
        const opacity = even && first < 0.999 ? first.toFixed(3) : "";
        const written = `${opacity}|${mask.image}|${mask.position}|${mask.size}`;

        if (written !== block.written) {
          block.written = written;
          block.element.style.opacity = opacity;
          writeMask(block.element, mask);
        }
      }
    }

    /*
     * Safari repaints a block's text whenever its mask or opacity changes, and
     * with a long paragraph near a far-reaching light that was most of every
     * frame: the light stepped at a few frames a second after each scroll.
     * While the light is on, every block within its reach gets a layer, so a
     * change repaints only its mask (opacity alone is pure compositing). The
     * layer goes with reach, not with ink: a block that came to full ink and
     * gave its layer up would be painted back into the page, a long frame
     * every time. It is given up only well out of reach, where its ink no
     * longer moves, so a book read through does not hold a layer for every
     * paragraph passed, and a block at the edge does not flip between the two.
     */
    const layered = new Set<HTMLElement>();
    if (!unlit) {
      const margin = span + view.height * 0.5;
      for (const { block, top } of near) {
        const reach = this.layered.has(block.element)
          ? margin + view.height * 0.5
          : margin;
        if (
          top + block.bottom - block.top > view.top - reach &&
          top < view.bottom + reach
        ) {
          layered.add(block.element);
        }
      }
    }
    for (const element of this.layered) {
      if (!layered.has(element)) {
        element.style.removeProperty("will-change");
      }
    }
    for (const element of layered) {
      if (!this.layered.has(element)) {
        element.style.setProperty("will-change", "transform");
      }
    }
    this.layered = layered;

    // A document rests once it is out of the light and none of its lines is
    // still fading there.
    for (const { entry, far } of visited) {
      entry.resting = (far || unlit) && !stillFading.has(entry);
    }

    return position;
  }
}

export interface BookChapter {
  label: string;
  href: string;
  depth: number;
  spineIndex: number;
  start: number;
  end: number;
}

export interface BookMap {
  /** Generated locations in the whole book. */
  total: number;
  /** First location of each spine section. */
  sectionStarts: number[];
  chapters: BookChapter[];
}

function getSpineItems(
  book: Book,
): Array<{ index: number; cfiBase: string; href: string }> {
  const spine = book.spine as unknown as {
    spineItems?: Array<{ index: number; cfiBase: string; href: string }>;
  };

  return spine.spineItems ?? [];
}

function getSpineIndex(book: Book, href: string): number | null {
  const section = book.spine.get(href.split("#")[0]) as unknown as {
    index?: number;
  } | null;

  return typeof section?.index === "number" ? section.index : null;
}

/**
 * Maps the book onto its generated locations (roughly 1200 characters each),
 * so a chapter has a length, a reading line has a place in it, and time left
 * can be estimated. Only built once epub.js has generated locations; until
 * then the reader shows no estimate rather than a guessed one.
 */
export function buildBookMap(
  book: Book,
  toc: Array<NavItem & { depth: number }>,
): BookMap | null {
  let locations: string[];

  try {
    locations = JSON.parse(book.locations.save()) as string[];
  } catch {
    return null;
  }

  if (!Array.isArray(locations) || locations.length === 0) {
    return null;
  }

  const spineItems = getSpineItems(book);
  const firstByBase = new Map<string, number>();

  locations.forEach((cfi, index) => {
    const base = cfi.slice("epubcfi(".length, cfi.indexOf("!"));

    if (!firstByBase.has(base)) {
      firstByBase.set(base, index);
    }
  });

  const total = locations.length;
  const sectionStarts = new Array<number>(spineItems.length).fill(total);

  for (let index = spineItems.length - 1; index >= 0; index -= 1) {
    const start = firstByBase.get(spineItems[index].cfiBase);
    sectionStarts[index] =
      start ??
      (index + 1 < spineItems.length ? sectionStarts[index + 1] : total);
  }

  const topLevel = toc.filter((entry) => entry.depth === 0);
  const entries = topLevel.length >= 2 ? topLevel : toc;
  const located = entries
    .map((entry) => ({ entry, spineIndex: getSpineIndex(book, entry.href) }))
    .filter(
      (
        candidate,
      ): candidate is {
        entry: NavItem & { depth: number };
        spineIndex: number;
      } => candidate.spineIndex !== null,
    )
    .sort((a, b) => a.spineIndex - b.spineIndex);

  const chapters: BookChapter[] = located.map(
    ({ entry, spineIndex }, index) => {
      const nextSpine = located[index + 1]?.spineIndex;

      return {
        label: entry.label.trim(),
        href: entry.href,
        depth: entry.depth,
        spineIndex,
        start: sectionStarts[spineIndex] ?? total,
        end:
          nextSpine !== undefined ? (sectionStarts[nextSpine] ?? total) : total,
      };
    },
  );

  return { total, sectionStarts, chapters };
}

/** The reading line's place in the book, in locations. */
export function locateInBook(
  map: BookMap,
  position: ReadingLinePosition,
): number {
  const start = map.sectionStarts[position.sectionIndex] ?? 0;
  const end = map.sectionStarts[position.sectionIndex + 1] ?? map.total;

  return start + (end - start) * position.fraction;
}

export function chapterAt(map: BookMap, sectionIndex: number): number {
  let found = -1;

  map.chapters.forEach((chapter, index) => {
    if (chapter.spineIndex <= sectionIndex) {
      found = index;
    }
  });

  return found;
}
