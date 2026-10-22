import { Rendition } from "epubjs";

/**
 * The book's sections as a window that moves with the reader: the sections on
 * screen, the one before and the one after, and whatever else lies within two
 * screens, are kept laid out and ready; the rest of the book is not in the page
 * at all. The bytes are the whole book, fetched once; what the window saves is
 * frames, layout and memory.
 *
 * epub.js's own continuous manager reaches for a section only when the reader
 * is 500px from the end of what is loaded, and tears a section's frame down as
 * soon as it is 500px off screen. Scrolling back therefore ran into empty space
 * (a whole screen of it while the section above was rebuilt) and then jumped
 * when it arrived. This one keeps the neighbours ready before they are needed,
 * and gives sections up only when the reader rests.
 *
 * Nothing that changes height may move the text being read. The block at the
 * top of the screen is the anchor: whenever any frame changes height (a section
 * added above, fonts landing, pictures loading, hyphenation), the anchor's
 * place in the book is measured again and the scroll moves by exactly what it
 * moved, before the frame is painted.
 */

/** How far past each edge of the screen sections are kept ready, in screens. */
const LOOKAHEAD_SCREENS = 2;
/** The lookahead on a short screen, in px. */
const MIN_LOOKAHEAD_PX = 1200;
/** Sections are given up only this many lookaheads past the screen. */
const KEEP_LOOKAHEADS = 2;
/** The reader has rested once the scroll has been still this long, in ms. */
const REST_MS = 250;
/** How far below the top of the screen the anchor is looked for, px. */
const ANCHOR_PROBES_PX = [1, 12, 32, 64, 128];
/** While the reader scrolls, how often the window is checked, in ms. */
const SCROLL_CHECK_MS = 100;

/** The parts of an epub.js view this manager reads or drives. */
interface WindowView {
  section: { index: number; prev(): unknown; next(): unknown };
  element: HTMLElement;
  iframe?: HTMLIFrameElement;
  displayed: boolean;
  display(request: unknown): Promise<WindowView>;
  show(): void;
  hide(): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

interface ViewList {
  all(): WindowView[];
  first(): WindowView | undefined;
  last(): WindowView | undefined;
  displayed(): WindowView[];
  remove(view: WindowView): void;
  length: number;
}

interface Queue {
  enqueue<T>(task: () => T | Promise<T>): Promise<T>;
}

/** The parts of epub.js's continuous manager this one builds on. */
interface ContinuousManager {
  settings: { axis?: string };
  views: ViewList;
  container: HTMLElement;
  q: Queue;
  request: unknown;
  ignore: boolean;
  isVisible(
    view: WindowView,
    offsetPrev: number,
    offsetNext: number,
    container: DOMRect,
  ): boolean;
  bounds(): DOMRect;
  scrollBy(x: number, y: number, silent?: boolean): void;
  scrollTo(x: number, y: number, silent?: boolean): void;
  append(section: unknown): WindowView;
  prepend(section: unknown): WindowView;
  createView(section: unknown, forceRight?: boolean): WindowView;
  afterDisplayed(view: WindowView): void;
  clear(): void;
  onScroll(): void;
  destroy(): void;
}

type ContinuousManagerClass = new (options: unknown) => ContinuousManager;

// Taken from epub.js itself rather than imported from its sources, so the
// bundle carries one copy of it.
const ContinuousViewManager = (
  Rendition.prototype as unknown as {
    requireManager(name: string): ContinuousManagerClass;
  }
).requireManager("continuous");

/** A block of text, where it stood in the book when last measured. */
interface Anchor {
  element: Element;
  frame: HTMLIFrameElement;
  /** Its top in the scroller's content, px: unchanged by scrolling. */
  y: number;
  height: number;
}

/** Settles once the page is cleared under whatever is waiting on it. */
function clearing() {
  let settle = () => {};
  const promise = new Promise<false>((resolve) => {
    settle = () => resolve(false);
  });
  return { promise, settle };
}

export class WindowedViewManager extends ContinuousViewManager {
  private anchor: Anchor | null = null;
  private cleared = clearing();
  private lastScrollAt = 0;
  private restTimer = 0;
  private lastCheckAt = 0;
  private checkPending = false;

  /** How far past the screen sections are kept ready, px. */
  private lookahead() {
    return Math.max(
      MIN_LOOKAHEAD_PX,
      this.container.clientHeight * LOOKAHEAD_SCREENS,
    );
  }

  private scrolling() {
    return performance.now() - this.lastScrollAt < REST_MS;
  }

  /** The first and last index of the views on screen, or null. */
  private onScreen(bounds: DOMRect): [number, number] | null {
    const views = this.views.all();
    let first = -1;
    let last = -1;

    views.forEach((view, index) => {
      if (this.isVisible(view, 0, 0, bounds)) {
        if (first < 0) first = index;
        last = index;
      }
    });

    return first < 0 ? null : [first, last];
  }

  /**
   * Adds the section after the last one once the loaded text ends within the
   * lookahead, or once that last section is on screen; the same for the
   * section before. Text added above moves the scroll to hold the reader's
   * place, and a scroll moved under a finger cuts an iPhone fling short, so
   * while the reader scrolls the section above waits until it is needed.
   *
   * Resolves true while it added a section, which makes epub.js's fill() ask
   * again.
   */
  check(): Promise<unknown> {
    const bounds = this.bounds();
    const lookahead = this.lookahead();
    const top = this.container.scrollTop;
    const height = this.container.clientHeight;
    const contentHeight = this.container.scrollHeight;
    const first = this.views.first();
    const last = this.views.last();
    const added: WindowView[] = [];

    if (
      last &&
      (top + height + lookahead >= contentHeight ||
        this.isVisible(last, 0, 0, bounds))
    ) {
      const next = last.section.next();
      if (next) added.push(this.append(next));
    }

    if (
      first &&
      (top - lookahead < 0 ||
        (!this.scrolling() && this.isVisible(first, 0, 0, bounds)))
    ) {
      const prev = first.section.prev();
      if (prev) added.push(this.prepend(prev));
    }

    if (!added.length) {
      void this.q.enqueue(() => this.update());
      return Promise.resolve(false);
    }

    return this.unlessCleared(
      Promise.all(added.map((view) => view.display(this.request)))
        .then(() => this.check())
        .then(
          () => this.update(),
          (error: unknown) => error,
        )
        .then(() => true),
    );
  }

  /**
   * A section taken out while it loads never finishes loading, and epub.js's
   * queue waits on whatever it was given. A jump clears the page (it may do
   * so mid-drag, between two checks); what was waiting on the old page lets
   * the queue go on to the new one, or the window would never fill again.
   */
  private unlessCleared<T>(work: Promise<T>): Promise<T | false> {
    return Promise.race([work, this.cleared.promise]);
  }

  clear() {
    this.cleared.settle();
    this.cleared = clearing();
    super.clear();
  }

  /**
   * Lays out every section that should be live and shows it. Sections that
   * should not be are left alone here; they are given up when the reader
   * rests (prune).
   */
  update(): Promise<unknown> {
    const bounds = this.bounds();
    const lookahead = this.lookahead();
    const screen = this.onScreen(bounds);
    const pending: Array<Promise<unknown>> = [];

    this.views.all().forEach((view, index) => {
      const live =
        this.isVisible(view, lookahead, lookahead, bounds) ||
        (screen !== null && index >= screen[0] - 1 && index <= screen[1] + 1);

      if (!live) return;

      if (view.displayed) {
        view.show();
        return;
      }

      pending.push(
        view.display(this.request).then(
          (shown) => shown.show(),
          () => view.hide(),
        ),
      );
    });

    return this.unlessCleared(Promise.all(pending));
  }

  /**
   * Takes out the sections far from the reader, from the ends inwards so the
   * rest stay one run of the book. Above the reader only at rest: taking one
   * out there moves the scroll, which would cut a fling short.
   */
  private prune() {
    const bounds = this.bounds();
    const screen = this.onScreen(bounds);
    if (!screen) return;

    const far = this.lookahead() * KEEP_LOOKAHEADS;
    // A copy: epub.js's own list shrinks as sections are taken out.
    const views = this.views.all().slice();
    const gone = (view: WindowView, index: number) =>
      (index < screen[0] - 1 || index > screen[1] + 1) &&
      !this.isVisible(view, far, far, bounds);

    // The scroll is set from where it stood before, not measured after: a
    // page that has just lost its top can be shorter than the scroll, and the
    // browser clamps it first.
    for (let index = 0; index < screen[0] && !this.scrolling(); index++) {
      if (!gone(views[index], index)) break;
      const top = this.container.scrollTop;
      const { height } = views[index].element.getBoundingClientRect();
      this.views.remove(views[index]);
      this.scrollTo(0, top - height, true);
      this.anchor = this.readAnchor();
    }

    for (let index = views.length - 1; index > screen[1]; index--) {
      if (!gone(views[index], index)) break;
      this.views.remove(views[index]);
    }
  }

  private scheduleRest() {
    window.clearTimeout(this.restTimer);
    this.restTimer = window.setTimeout(() => {
      void this.q
        .enqueue(() => this.check())
        .then(() => this.q.enqueue(() => this.prune()));
    }, REST_MS);
  }

  onScroll() {
    // epub.js marks its own scrolls (moving to a target, holding the place)
    // to be ignored; only the reader's scrolls count as scrolling.
    const programmatic = this.ignore;
    super.onScroll();
    this.holdPlace();

    if (!programmatic) {
      const now = performance.now();
      this.lastScrollAt = now;
      this.scheduleRest();

      // epub.js checks only once the scroll stops, so a long scroll could
      // run through the whole lookahead into empty space.
      if (!this.checkPending && now - this.lastCheckAt >= SCROLL_CHECK_MS) {
        this.lastCheckAt = now;
        this.checkPending = true;
        void this.q
          .enqueue(() => this.check())
          .then(() => this.q.enqueue(() => this.prune()))
          .finally(() => {
            this.checkPending = false;
          });
      }
    }
  }

  /**
   * Every frame holds the reader's place when its height changes, and loads
   * once however often it is asked. epub.js loads a frame again when asked
   * twice, and the first load's promise then never settles: a jump that asked
   * for its section while the window was laying it out never finished, and
   * the ruler went on waiting for it.
   */
  createView(section: unknown, forceRight?: boolean): WindowView {
    const view = super.createView(section, forceRight);
    const display = view.display.bind(view);
    let loading: Promise<WindowView> | null = null;

    view.display = (request) => {
      if (view.displayed) return display(request);
      loading ??= display(request).finally(() => {
        loading = null;
      });
      return loading;
    };

    view.on("resized", ((size: { height: number; heightDelta: number }) =>
      this.holdPlace(view, size)) as (...args: never[]) => void);

    return view;
  }

  /** Replaced by holdPlace, which every view calls when it resizes. */
  counter() {}

  /**
   * A frame's text can reflow without the frame changing size yet (epub.js
   * resizes it a frame later); its own document reports that before paint.
   */
  afterDisplayed(view: WindowView) {
    const frameWindow = view.iframe?.contentWindow as
      | (Window & typeof globalThis)
      | null
      | undefined;
    const root = view.iframe?.contentDocument?.documentElement;

    if (frameWindow?.ResizeObserver && root) {
      new frameWindow.ResizeObserver(() => this.holdPlace()).observe(root);
    }

    super.afterDisplayed(view);
  }

  /**
   * Keeps the anchor where it was on screen: moves the scroll by however far
   * the anchor has moved in the book since it was last measured, then takes
   * the block now at the top of the screen as the anchor. With no anchor on
   * screen, a section that changed size wholly above the screen is made up
   * for by its own change.
   */
  private holdPlace(
    view?: WindowView,
    size?: { height: number; heightDelta: number },
  ) {
    const top = this.container.scrollTop;
    const height = this.container.clientHeight;
    const anchor = this.anchor;

    if (
      anchor &&
      anchor.element.isConnected &&
      anchor.frame.isConnected &&
      anchor.y + anchor.height >= top - 1 &&
      anchor.y <= top + height + 1
    ) {
      const y = this.bookY(anchor.element, anchor.frame);
      const moved = y - anchor.y;

      if (Math.abs(moved) >= 0.5) {
        this.scrollBy(0, moved, true);
      }
    } else if (view && size && size.heightDelta) {
      // Only a section above text already laid out: the first section of a
      // jump also starts at the top with no height, and is the target itself.
      const views = this.views.all();
      const above = views
        .slice(views.indexOf(view) + 1)
        .some((later) => later.displayed);
      const viewTop =
        view.element.getBoundingClientRect().top -
        this.container.getBoundingClientRect().top +
        top;

      if (above && viewTop + size.height - size.heightDelta <= top) {
        this.scrollBy(0, size.heightDelta, true);
      }
    }

    this.anchor = this.readAnchor();
  }

  /** Where an element in a frame stands in the scroller's content, px. */
  private bookY(element: Element, frame: HTMLIFrameElement) {
    return (
      frame.getBoundingClientRect().top +
      element.getBoundingClientRect().top -
      this.container.getBoundingClientRect().top +
      this.container.scrollTop
    );
  }

  /**
   * The block at the top of the screen, as the reader's saved place is: the
   * first one that has not yet scrolled off. A jump puts its target there, so
   * nothing that arrives afterwards moves it.
   */
  private readAnchor(): Anchor | null {
    const box = this.container.getBoundingClientRect();
    const x = box.left + box.width / 2;

    let edge: Anchor | null = null;

    // The edge itself can fall between two blocks; a little lower finds one.
    for (const below of ANCHOR_PROBES_PX) {
      const y = box.top + below;
      const view = this.views.displayed().find((candidate) => {
        const rect = candidate.iframe?.getBoundingClientRect();
        return rect && y >= rect.top && y < rect.bottom;
      });
      const frame = view?.iframe;
      const document = frame?.contentDocument;

      if (!frame || !document?.body) continue;

      const rect = frame.getBoundingClientRect();
      // An inline box with no height falls to the block around it.
      let element: Element | null = document.elementFromPoint(
        x - rect.left,
        y - rect.top,
      );
      while (
        element &&
        element !== document.body &&
        element.getBoundingClientRect().height <= 0
      ) {
        element = element.parentElement;
      }

      if (
        element &&
        element !== document.body &&
        element !== document.documentElement
      ) {
        return {
          element,
          frame,
          y: this.bookY(element, frame),
          height: element.getBoundingClientRect().height,
        };
      }

      // Only margin up here, a chapter's opening space: the frame itself
      // holds the place until a block comes under the edge.
      edge ??= {
        element: document.body,
        frame,
        y: this.bookY(document.body, frame),
        height: rect.height,
      };
    }

    return edge;
  }

  destroy() {
    window.clearTimeout(this.restTimer);
    this.anchor = null;
    super.destroy();
  }
}
