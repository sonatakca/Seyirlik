import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ePub, {
  EpubCFI,
  type Book,
  type Contents,
  type Location as EpubLocation,
  type NavItem,
  type Rendition,
} from "epubjs";
import type Section from "epubjs/types/section";
import {
  BookCheck,
  Bookmark,
  BookmarkCheck,
  Download,
  ExternalLink,
  ListTree,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { useParams } from "react-router-dom";
import { BackButton } from "../components/BackButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { WatchedStatusButton } from "../components/WatchedStatusButton";
import {
  SegmentedIconToolbar,
  type SegmentedIconToolbarAction,
} from "../components/ui/SegmentedIconToolbar";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getBookFileUrl,
  getPrimaryImageUrl,
  getReaderItem,
} from "../lib/mediaApi";
import { setPageTitle } from "../lib/pageTitle";
import { neutraliseBookScripts } from "./reader/epubSafety";
import {
  getMediaOwnerRouteForItem,
  shouldOpenReaderForItem,
} from "../lib/routes";
import type { MediaItem } from "../lib/types";
import { describeErrorForUser } from "../lib/userFacingError";
import { isItemCompleted } from "../lib/watchStatus";
import {
  EPUB_STATIC_CSS,
  enhanceSection,
  getBookFontCss,
  getEpubBlocks,
  getEpubThemeCss,
  hyphenateDocument,
  readLiveAccent,
} from "./reader/epubTypography";
import { ReaderImageViewer } from "./reader/ReaderImageViewer";
import { zoomableImageAt, type ReaderImage } from "./reader/readerImage";
import {
  RULER_FADE_MS,
  ReaderBookCover,
  ReaderMargin,
  ReaderContentsDrawer,
  type ReaderContentsTab,
  ReaderHighlightMenu,
  ReaderMoreMenu,
  ReaderSettingsPanel,
  type RulerSeekPhase,
} from "./reader/ReaderPanels";
import {
  guardCfiLocation,
  settleFailedDisplays,
} from "./reader/epubDisplayGuard";
import { WindowedViewManager } from "./reader/epubWindow";
import {
  formatDuration,
  formatPercent,
  splitNumber,
} from "./reader/readerText";
import {
  CHARS_PER_LOCATION,
  EPUB_DISPLAY_LIMIT_MS,
  EPUB_PREPARATION_TIMEOUT_MS,
  EPUB_REQUEST_CREDENTIALS,
  READER_SETTINGS_KEY,
  READING_LINE,
  SPOTLIGHT_FLOOR,
  clamp,
  flattenToc,
  getFormatLabel,
  getReaderFormat,
  HIGHLIGHT_COLORS,
  highlightName,
  isHighlight,
  minutesForLocations,
  isReaderPlace,
  readReaderProgress,
  readStoredReaderSettings,
  themePalettes,
  writeJsonStorage,
  writeReaderProgress,
  type EpubContentView,
  type HighlightColor,
  type ReaderBookmark,
  type ReaderPalette,
  type ReaderPlace,
  type ReaderSettings,
} from "./reader/readerModel";
import { READER_SYNC_MS, useReaderMarks } from "./reader/readerMarks";
import { randomUuid } from "../lib/randomId";
import {
  claimBookSession,
  getBookPosition,
  readerDevice,
  saveBookPosition,
  type ReadingSession,
  type BookPosition,
} from "../lib/bookPositionApi";
import type { BookSearchFound, BookSearchHit } from "../lib/bookSearchApi";
import { epubBlockText } from "../lib/epubBlocks";
import { findOnPage, markFoundWords } from "./reader/searchMarks";
import { shimmerPassage } from "./reader/searchShimmer";
import {
  ReadingLight,
  buildBookMap,
  chapterAt,
  locateInBook,
  type BookMap,
} from "./reader/readingLight";

/** The reading light the settings ask for: its floor, its shape and its reach. */
function lightFromSettings(light: ReadingLight, settings: ReaderSettings) {
  light.setLight(
    SPOTLIGHT_FLOOR[settings.spotlight],
    settings.lightShape,
    settings.lightShape === "line"
      ? settings.lineReach
      : settings.paragraphReach,
  );
}

type Panel = "settings" | "contents" | "more" | null;

/** The text the reader has selected, or the highlight they tapped. */
type HighlightTarget =
  | {
      kind: "selection";
      cfi: string;
      text: string;
      section: number;
      progress: number | null;
      range: Range;
    }
  | { kind: "highlight"; id: string; range: Range };

/** A highlight's text as the list shows it: no soft hyphens, one line. */
function highlightText(range: Range): string {
  const text = range
    .toString()
    .replace(/\u00ad/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 800 ? `${text.slice(0, 799).trimEnd()}…` : text;
}

function rangeDocument(range: Range): Document | null {
  return range.startContainer.ownerDocument;
}
type TocEntry = NavItem & { depth: number };

interface ReadingState {
  chapterIndex: number;
  location: number;
  minutesLeftInChapter: number;
  bookFraction: number;
}

interface ColumnBox {
  left: number;
  right: number;
  viewport: number;
}

/**
 * Room the right margin needs beside the column: the ruler and its names
 * against the window's edge, with a clear gap to the text. Narrower windows
 * dock the time left at the foot instead.
 */
const MARGIN_ROOM = 264;

function paletteVariables(palette: ReaderPalette): CSSProperties {
  return {
    "--rd-ground": palette.ground,
    "--rd-ink": palette.ink,
    "--rd-ink2": palette.ink2,
    "--rd-ink3": palette.ink3,
    "--rd-ink4": palette.ink4,
    "--rd-hair": palette.hair,
    "--rd-mark": palette.mark,
    "--rd-glass": palette.glass,
    "--rd-glass-solid": palette.glassSolid,
    "--rd-glass-edge": palette.glassEdge,
    "--rd-glass-highlight": palette.glassHighlight,
    "--rd-lift": palette.lift,
    "--rd-selection": palette.selection,
    "--rd-scheme": palette.scheme,
  } as CSSProperties;
}

function glassStyle(palette: ReaderPalette): CSSProperties {
  return {
    backgroundColor: palette.glass,
    color: palette.ink,
    boxShadow: `0 0 0 1px ${palette.glassEdge}, inset 0 1px 0 ${palette.glassHighlight}, 0 8px 28px rgba(0, 0, 0, 0.18)`,
  };
}

function formatFileSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) {
    return null;
  }

  if (bytes < 1e6) {
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function buildHtmlDocument(
  html: string,
  settings: ReaderSettings,
  palette: ReaderPalette,
): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      ${getBookFontCss()}
      ${EPUB_STATIC_CSS}
      ${getEpubThemeCss(settings, palette, readLiveAccent())}
      body > * { max-width: ${settings.width}ch; margin-left: auto; margin-right: auto; }
    </style>
  </head>
  <body>${html}</body>
</html>`;
}

function getTextBlocks(content: string): string[] {
  const blocks = content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.length > 0 ? blocks : [content];
}

function getRenditionContents(rendition: Rendition): EpubContentView[] {
  const contents = rendition.getContents() as unknown;

  if (Array.isArray(contents)) {
    return contents.filter(Boolean) as EpubContentView[];
  }

  return contents ? [contents as EpubContentView] : [];
}

function getScrollProgress(scrollElement: HTMLElement): number {
  const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
  return maxScroll > 0 ? clamp(scrollElement.scrollTop / maxScroll, 0, 1) : 0;
}

function getEpubSpineLength(book: Book): number {
  const spine = book.spine as unknown as {
    length?: number;
    spineItems?: unknown[];
  };

  return spine.length ?? spine.spineItems?.length ?? 0;
}

function getEpubProgressFromLocation(
  book: Book,
  location: EpubLocation | null | undefined,
  cfi: string | undefined,
  useGeneratedLocations: boolean,
): number | null {
  if (useGeneratedLocations && cfi) {
    const percentage = book.locations.percentageFromCfi(cfi) as number | null;

    if (typeof percentage === "number" && Number.isFinite(percentage)) {
      return clamp(percentage, 0, 1);
    }
  }

  const start = location?.start;
  const spineLength = getEpubSpineLength(book);

  if (!start || spineLength <= 0) {
    return null;
  }

  const displayedPage = start.displayed?.page ?? 1;
  const displayedTotal = Math.max(1, start.displayed?.total ?? 1);
  const sectionProgress = clamp((displayedPage - 1) / displayedTotal, 0, 1);

  return clamp((start.index + sectionProgress) / spineLength, 0, 1);
}

/**
 * Resolves once the book's scroll height has held still briefly, or after
 * `limitMs`. Sections loaded around a target reflow after epub.js has already
 * scrolled to it: their content hook awaits hyphenation, then fonts land.
 * Timers, not frames, so a background tab still settles.
 */
function waitForLayoutToSettle(
  host: HTMLElement,
  limitMs = 2500,
): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    let lastHeight = -1;
    let stableSince = started;

    const tick = () => {
      const height =
        host.querySelector<HTMLElement>(".epub-container")?.scrollHeight ?? 0;
      const now = performance.now();

      if (height !== lastHeight) {
        lastHeight = height;
        stableSince = now;
      }

      if (now - stableSince >= 300 || now - started >= limitMs) {
        resolve();
        return;
      }

      window.setTimeout(tick, 50);
    };

    tick();
  });
}

/** A place to open the book at, and when the reader was there (ms). */
interface Target {
  cfi: string | null;
  place: ReaderPlace | null;
  readAt: number;
}

/** Device names are the makers' own, in every language. */
const READER_DEVICE_NAMES: Record<
  NonNullable<ReadingSession["device"]>,
  string
> = {
  iphone: "iPhone",
  ipad: "iPad",
  android: "Android",
  mac: "Mac",
  windows: "Windows",
  linux: "Linux",
};

/** A place saved this many ms after the reader stops moving goes to the server. */
const POSITION_SEND_DELAY_MS = 1500;
/** How long opening a book waits for the place saved on other devices. */
const POSITION_FETCH_LIMIT_MS = 2000;
/**
 * Another device's place is taken only once the reader has left the page
 * alone this long: a book never moves under someone who is scrolling.
 */
const CATCH_UP_IDLE_MS = 5000;

/** Two saves of the same place have the same key, so a re-save is not a move. */
function positionKey({
  cfi,
  place,
}: {
  cfi: string | null;
  place: ReaderPlace | null;
}): string {
  return place
    ? `${place.section}:${place.block}:${place.offset}`
    : (cfi ?? "");
}

/**
 * Where the screen stands in the book, as the first block whose bottom is
 * below the top of the scroller and the distance from that block's top to the
 * scroller's top. A CFI names a character, and epub.js displays one at the very
 * top of the screen, so reopening at the CFI alone dropped the space above a
 * chapter opener and landed a few lines away from where the reader had been.
 */
function readPlace(
  scroller: HTMLElement,
  contents: EpubContentView[],
  blocksOf: WeakMap<Document, HTMLElement[]>,
): ReaderPlace | null {
  const top = scroller.getBoundingClientRect().top;
  const ordered = [...contents].sort(
    (a, b) => (a.sectionIndex ?? 0) - (b.sectionIndex ?? 0),
  );

  for (const content of ordered) {
    const frame = content.document.defaultView?.frameElement;
    const blocks = blocksOf.get(content.document);

    if (!frame || !blocks?.length || content.sectionIndex === undefined) {
      continue;
    }

    const frameTop = frame.getBoundingClientRect().top;
    const bottomOf = (index: number) =>
      frameTop + blocks[index].getBoundingClientRect().bottom;

    if (bottomOf(blocks.length - 1) <= top) {
      continue;
    }

    // Blocks run down the page in order, so the first one still showing is
    // found by halving.
    let low = 0;
    let high = blocks.length - 1;

    while (low < high) {
      const middle = (low + high) >> 1;

      if (bottomOf(middle) > top) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    return {
      section: content.sectionIndex,
      block: low,
      offset: Math.round(
        top - (frameTop + blocks[low].getBoundingClientRect().top),
      ),
    };
  }

  return null;
}

/** Scrolls so the screen stands where `readPlace` found it; false if that block is not rendered. */
function returnToPlace(
  scroller: HTMLElement,
  contents: EpubContentView[],
  blocksOf: WeakMap<Document, HTMLElement[]>,
  place: ReaderPlace,
): boolean {
  const content = contents.find(
    (candidate) => candidate.sectionIndex === place.section,
  );
  const frame = content?.document.defaultView?.frameElement;
  const block = content ? blocksOf.get(content.document)?.[place.block] : null;

  if (!frame || !block) {
    return false;
  }

  const blockTop =
    frame.getBoundingClientRect().top + block.getBoundingClientRect().top;
  scroller.scrollTop +=
    blockTop - (scroller.getBoundingClientRect().top - place.offset);

  return true;
}

/** A press that moved less than this and lasted less than TAP_MS is a tap. */
const TAP_SLOP_PX = 10;
const TAP_MS = 600;
/** A tap this soon after a scroll only stopped the scroll; it asks for nothing. */
const TAP_AFTER_SCROLL_MS = 250;

/**
 * Calls `onTap` for a press and release that stayed put: a click, or a tap on
 * a touchscreen. Pointer events rather than `click`, because iOS and iPadOS
 * Safari send no click for a tap on plain text (an element with no handler or
 * pointer cursor of its own), so a reader on an iPhone or iPad could never
 * bring the bar back. A press the browser turns into a scroll is cancelled,
 * and a long press (selecting a word) is not a tap.
 */
function listenForTaps(
  target: Document | HTMLElement,
  onTap: (target: EventTarget | null, release: PointerEvent) => void,
  scrolledRecently: () => boolean,
): () => void {
  let start: { x: number; y: number; at: number; id: number } | null = null;
  const down = (event: Event) => {
    const press = event as PointerEvent;
    start =
      press.isPrimary && press.button === 0
        ? {
            x: press.clientX,
            y: press.clientY,
            at: performance.now(),
            id: press.pointerId,
          }
        : null;
  };
  const cancel = () => {
    start = null;
  };
  const up = (event: Event) => {
    const release = event as PointerEvent;
    const press = start;
    start = null;

    if (
      !press ||
      release.pointerId !== press.id ||
      Math.hypot(release.clientX - press.x, release.clientY - press.y) >
        TAP_SLOP_PX ||
      performance.now() - press.at > TAP_MS ||
      scrolledRecently()
    ) {
      return;
    }

    onTap(release.target, release);
  };

  target.addEventListener("pointerdown", down, { passive: true });
  target.addEventListener("pointercancel", cancel, { passive: true });
  target.addEventListener("pointerup", up, { passive: true });

  return () => {
    target.removeEventListener("pointerdown", down);
    target.removeEventListener("pointercancel", cancel);
    target.removeEventListener("pointerup", up);
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

export function BookReaderPage() {
  const { itemId } = useParams<{ itemId?: string }>();
  const { t, language } = useLanguage();
  const [item, setItem] = useState<MediaItem | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(
    readStoredReaderSettings,
  );
  const [panel, setPanel] = useState<Panel>(null);
  const [zoomedImage, setZoomedImage] = useState<ReaderImage | null>(null);
  const [contentsTab, setContentsTab] = useState<ReaderContentsTab>("contents");
  const [chromeHidden, setChromeHidden] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookMap, setBookMap] = useState<BookMap | null>(null);
  const [bookMeta, setBookMeta] = useState({ author: "", language: "" });
  const [reading, setReading] = useState<ReadingState | null>(null);
  const [columnBox, setColumnBox] = useState<ColumnBox | null>(null);
  // The account's, on every device it reads on.
  const { marks: bookmarks, commit: commitBookmarks } = useReaderMarks(
    item?.Id,
  );
  const [highlightTarget, setHighlightTarget] =
    useState<HighlightTarget | null>(null);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [epubReady, setEpubReady] = useState(false);
  // The book faded out while a chapter not yet on the page loads for a jump.
  const [jumping, setJumping] = useState(false);
  const [epubProgress, setEpubProgress] = useState(0);
  const [readerError, setReaderError] = useState<string | null>(null);
  /** The copy of the book, opened later on some device, that now keeps the place. */
  const [takenBy, setTakenBy] = useState<ReadingSession | null>(null);
  const [takingBack, setTakingBack] = useState<"idle" | "busy" | "failed">(
    "idle",
  );
  /** Makes this copy keep the place again, at the latest place; true if it does. */
  const continueHereRef = useRef<() => Promise<boolean>>(async () => false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  // The book on the opening screen: about a quarter of the screen's height,
  // large enough to read as a book in the hand, never a poster.
  const [openingCoverWidth] = useState(() =>
    Math.round(Math.min(232, Math.max(176, window.innerHeight * 0.26))),
  );

  const epubHostRef = useRef<HTMLDivElement | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  const lightRef = useRef<ReadingLight | null>(null);
  const scheduleFrameRef = useRef<() => void>(() => undefined);
  /** Opens the book at a search hit; set while a book is open. */
  const showPassageRef = useRef<
    (hit: BookSearchHit, found: BookSearchFound) => Promise<void>
  >(async () => undefined);
  const measureColumnRef = useRef<() => void>(() => undefined);
  const markerRef = useRef<HTMLDivElement | null>(null);
  // The margin mounts after the frame that charted the chapter, so a new
  // marker asks for a frame of its own rather than waiting for a scroll.
  const attachMarker = useCallback((marker: HTMLDivElement | null) => {
    markerRef.current = marker;
    if (marker) {
      scheduleFrameRef.current();
    }
  }, []);
  /** Brings the reading line to a share of a chapter; set while a book is open. */
  const seekChapterRef = useRef<
    (chapterIndex: number, fraction: number) => void
  >(() => undefined);
  /** The chapter the ruler is being dragged through, or -1 when it is not. */
  const rulerDragRef = useRef(-1);
  /** Where the reading line stands in its chapter (0–1), and where a drag has taken it. */
  const chapterFractionRef = useRef(0);
  const rulerFractionRef = useRef(0);
  /** Ends a run of wheel turns over the ruler once they stop. */
  const rulerWheelTimerRef = useRef(0);
  const settingsRef = useRef(settings);
  const panelRef = useRef<Panel>(null);
  const languageRef = useRef(language);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const readerKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const highlightMenuRef = useRef<HTMLDivElement | null>(null);
  const highlightTargetRef = useRef<HighlightTarget | null>(null);
  const highlightsRef = useRef<ReaderBookmark[]>([]);
  const paintHighlightsRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    settingsRef.current = settings;
    panelRef.current = panel;
    languageRef.current = language;
    highlightTargetRef.current = highlightTarget;
  });

  /**
   * Sets the colour menu beside its text: below it, clear of the callout the
   * system puts above a selection, or above it when there is no room below.
   * Called again as the book scrolls under it.
   */
  const placeHighlightMenu = useCallback(() => {
    const menu = highlightMenuRef.current;
    const target = highlightTargetRef.current;

    if (!menu || !target) {
      return;
    }

    const frame = rangeDocument(target.range)?.defaultView?.frameElement;
    const rects = Array.from(target.range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );

    if (!frame || rects.length === 0) {
      menu.style.visibility = "hidden";
      return;
    }

    const frameBox = frame.getBoundingClientRect();
    const box = target.range.getBoundingClientRect();
    const top = frameBox.top + rects[0].top;
    const bottom = frameBox.top + rects[rects.length - 1].bottom;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const edge = 8;
    const gap = 12;
    const fitsBelow = bottom + gap + height <= window.innerHeight - edge;
    const y = fitsBelow ? bottom + gap : top - gap - height;
    const x = frameBox.left + (box.left + box.right) / 2 - width / 2;

    menu.style.visibility =
      bottom < 0 || top > window.innerHeight ? "hidden" : "";
    menu.dataset.placement = fitsBelow ? "below" : "above";
    menu.style.left = `${clamp(x, edge, window.innerWidth - width - edge)}px`;
    menu.style.top = `${clamp(y, edge, window.innerHeight - height - edge)}px`;
  }, []);

  useLayoutEffect(placeHighlightMenu, [highlightTarget, placeHighlightMenu]);

  // Highlights are painted into every section on screen whenever they change.
  useLayoutEffect(() => {
    highlightsRef.current = bookmarks.filter(isHighlight);
    paintHighlightsRef.current();
  }, [bookmarks]);

  const palette = themePalettes[settings.theme];

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeJsonStorage(READER_SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const showChrome = useCallback(() => setChromeHidden(false), []);

  /*
   * The bar comes when it is asked for — the pointer at the top edge, a tap or
   * click on the text that selects nothing, keyboard focus — and goes when
   * reading resumes. Scrolling only ever hides it: bringing it back on every
   * scroll up put chrome over the text exactly when the reader looked back.
   */
  const barRef = useRef<HTMLElement | null>(null);
  const barHoverRef = useRef(false);
  const barHideTimerRef = useRef(0);
  const holdBar = useCallback(() => {
    window.clearTimeout(barHideTimerRef.current);
    barHoverRef.current = true;
    setChromeHidden(false);
  }, []);
  const releaseBar = useCallback((event: ReactPointerEvent) => {
    barHoverRef.current = false;
    if (event.pointerType === "touch") {
      return;
    }
    window.clearTimeout(barHideTimerRef.current);
    barHideTimerRef.current = window.setTimeout(() => {
      if (
        !barHoverRef.current &&
        panelRef.current === null &&
        // Keyboard focus holds the bar; a button merely left focused by a
        // click does not.
        !barRef.current?.querySelector(":focus-visible")
      ) {
        setChromeHidden(true);
      }
    }, 900);
  }, []);
  useEffect(() => () => window.clearTimeout(barHideTimerRef.current), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const togglePanel = useCallback((next: Exclude<Panel, null>) => {
    setPanel((current) => (current === next ? null : next));
    setHighlightTarget(null);
    setChromeHidden(false);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setItemError(t("reader.missingItemId"));
        return;
      }

      setItem(null);
      setItemError(null);
      setReaderError(null);

      try {
        const nextItem = await getReaderItem(itemId);

        if (isMounted) {
          setItem(nextItem);
        }
      } catch (error) {
        if (isMounted) {
          setItemError(
            describeErrorForUser(error, t, "reader.couldNotLoadItem"),
          );
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, t]);

  const format = useMemo(
    () => (item ? getReaderFormat(item) : "fallback"),
    [item],
  );
  const fileUrl = useMemo(() => (item ? getBookFileUrl(item.Id) : ""), [item]);
  const ownerRoute = useMemo(() => {
    if (!item) {
      return "/home";
    }

    const route = getMediaOwnerRouteForItem(item);
    return route.startsWith("/read/") ? "/home" : route;
  }, [item]);

  const coverUrl = item?.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 540)
    : "";
  const isReaderItem = item ? shouldOpenReaderForItem(item) : true;
  const title = item?.Name ?? t("reader.title");
  const isCompleted = item ? isItemCompleted(item) : false;
  const activeItemId = item?.Id;

  useEffect(() => {
    setPageTitle(item ? `${item.Name} · Seyirlik` : "Reader · Seyirlik", {
      canonicalPath: item
        ? `/read/${item.Id}`
        : itemId
          ? `/read/${itemId}`
          : "/read",
      robots: "noindex, nofollow",
    });
  }, [item, itemId]);

  useEffect(() => {
    setToc([]);
    setBookMap(null);
    setBookMeta({ author: "", language: "" });
    setReading(null);
    setColumnBox(null);
    setPanel(null);
    setChromeHidden(false);
    setCurrentCfi(null);
    setCurrentHref(null);
    setEpubReady(false);
    setEpubProgress(0);
    setReaderError(null);
    setTextContent(null);
    setScrollProgress(0);
    setHighlightTarget(null);
  }, [activeItemId]);

  /* ---------------- EPUB ---------------- */
  useEffect(() => {
    if (
      format !== "epub" ||
      !fileUrl ||
      !epubHostRef.current ||
      !activeItemId
    ) {
      return undefined;
    }

    let isMounted = true;
    const host = epubHostRef.current;
    host.innerHTML = "";
    setEpubReady(false);
    setReaderError(null);

    const book = ePub(fileUrl, {
      openAs: "epub",
      requestCredentials: EPUB_REQUEST_CREDENTIALS,
    });
    // Every section is cleaned of the book's own scripts and carries a policy
    // that forbids them, before it reaches a frame (see epubSafety.ts)...
    //
    // Registered once the book has opened, so it runs after epub.js's own
    // resource substitution (registered while opening): that hook rewrites
    // section.output from the markup it was handed, and run after this one it
    // threw the cleaned markup away. This one cleans section.output as it is
    // by then, the markup that will actually be shown.
    void book.opened.then(() => {
      book.spine.hooks.serialize.register(
        (_output: string, section: { output: string }) => {
          section.output = neutraliseBookScripts(section.output);
        },
      );
    });
    guardCfiLocation();
    const rendition = book.renderTo(host, {
      // A window of sections around the reader, not the whole book in the
      // page, that holds the reader's place as sections come and go.
      manager: WindowedViewManager,
      width: "100%",
      height: "100%",
      flow: "scrolled-continuous",
      spread: "none",
      resizeOnOrientationChange: true,
      // ...so the frame may allow scripts: WebKit delivers no events, even to
      // the reader's own listeners, inside a frame sandboxed without it, and a
      // tap on the book could never show the bar on an iPhone or iPad.
      allowScriptedContent: true,
    });
    const stopSettlingDisplays = settleFailedDisplays(rendition);
    const light = new ReadingLight(host);
    const savedProgress = readReaderProgress(activeItemId);
    const savedPlace = isReaderPlace(savedProgress?.place)
      ? savedProgress.place
      : null;
    // The place this device saved, and the one every device shares, fetched
    // while the book loads; whichever the reader reached last wins.
    const localPosition: Target = {
      cfi: savedProgress?.cfi ?? null,
      place: savedPlace,
      readAt: savedProgress?.readAt ?? savedProgress?.updatedAt ?? 0,
    };
    const remotePosition = getBookPosition(activeItemId).catch(() => null);
    let currentCfiValue = savedProgress?.cfi;
    /** Each section's blocks, in order, once its typography is in. */
    const blocksOf = new WeakMap<Document, HTMLElement[]>();
    /** Each section's highlights as ranges, to find the one under a tap. */
    const highlightsIn = new WeakMap<
      Document,
      Array<{ id: string; range: Range }>
    >();
    // Until the reader is back where they left off, the places epub.js passes
    // through on the way are not written over the saved one. The same holds
    // while catching up with a place read on another device.
    let restoring = true;
    /** The place last saved or taken from another device, and when it was read. */
    let known = { key: "", readAt: 0 };
    /** A place not yet on the server, sent a moment after the reader stops. */
    let unsent: BookPosition | null = null;
    /**
     * This opening of the book. The copy opened last, on any device, keeps
     * the place; once another has, this one saves nothing until the reader
     * takes the book back here.
     */
    let session: ReadingSession = {
      id: randomUuid(),
      openedAt: Date.now(),
      device: readerDevice(),
    };
    let superseded = false;
    let sendTimer = 0;
    let scrollElement: HTMLElement | null = null;
    let lastScrollTop = 0;
    let lastScrollAt = 0;
    const scrolledRecently = () =>
      performance.now() - lastScrollAt < TAP_AFTER_SCROLL_MS;
    const tapListeners: Array<() => void> = [];
    let frameId = 0;
    let measureTimer = 0;
    let progressFrame = 0;
    let hasLocations = false;
    let navigationToc: TocEntry[] | null = null;
    let map: BookMap | null = null;
    let resolveFirstContent: () => void = () => undefined;
    const firstContent = new Promise<void>((resolve) => {
      resolveFirstContent = resolve;
    });

    bookRef.current = book;
    renditionRef.current = rendition;
    lightRef.current = light;
    lightFromSettings(light, settingsRef.current);
    /**
     * The ruler's marker follows the reading line, but a leap — a new chapter,
     * or a jump across most of this one — fades it out, moves it, and fades it
     * back in, rather than sweeping it the length of the ruler.
     */
    let markerState: {
      element: HTMLElement | null;
      chapterIndex: number;
      fraction: number;
      switching: boolean;
      pending: { top: string; text: string } | null;
    } = {
      element: null,
      chapterIndex: -1,
      fraction: 0,
      switching: false,
      pending: null,
    };
    let markerTimer = 0;

    const placeMarker = (marker: HTMLElement, top: string, text: string) => {
      marker.style.top = top;
      const label = marker.firstElementChild;
      if (label) {
        label.textContent = text;
      }
    };

    const runFrame = () => {
      const position = light.frame();

      if (light.isFading) {
        scheduleFrame();
      }

      if (!position || !map) {
        return;
      }

      const location = locateInBook(map, position);
      const chapterIndex = chapterAt(map, position.sectionIndex);
      const chapter = map.chapters[chapterIndex];
      const chapterFraction = chapter
        ? clamp(
            (location - chapter.start) /
              Math.max(1, chapter.end - chapter.start),
            0,
            1,
          )
        : 0;
      const marker = markerRef.current;
      chapterFractionRef.current = chapterFraction;

      if (marker && rulerDragRef.current >= 0) {
        // Dragged, the marker moves with the pointer (seekRuler places it);
        // the text catches up behind it.
        markerState.chapterIndex = chapterIndex;
        markerState.fraction = chapterFraction;
      } else if (marker) {
        const top = `${chapterFraction * 100}%`;
        const text = formatPercent(chapterFraction, languageRef.current);

        if (marker !== markerState.element) {
          markerState = {
            element: marker,
            chapterIndex,
            fraction: chapterFraction,
            switching: false,
            pending: null,
          };
          placeMarker(marker, top, text);
        } else if (
          markerState.switching ||
          chapterIndex !== markerState.chapterIndex ||
          Math.abs(chapterFraction - markerState.fraction) > 0.25
        ) {
          markerState.pending = { top, text };

          if (!markerState.switching) {
            markerState.switching = true;
            marker.dataset.switching = "true";
            markerTimer = window.setTimeout(() => {
              const pending = markerState.pending;
              marker.style.transition = "none";
              if (pending) {
                placeMarker(marker, pending.top, pending.text);
              }
              void marker.offsetHeight;
              marker.style.transition = "";
              delete marker.dataset.switching;
              markerState.switching = false;
              markerState.pending = null;
            }, RULER_FADE_MS);
          }
        } else {
          placeMarker(marker, top, text);
        }

        markerState.chapterIndex = chapterIndex;
        markerState.fraction = chapterFraction;
      }

      const next: ReadingState = {
        chapterIndex,
        location: Math.round(location),
        minutesLeftInChapter: chapter
          ? minutesForLocations(chapter.end - location)
          : 0,
        bookFraction: clamp(location / map.total, 0, 1),
      };

      setReading((previous) =>
        previous &&
        previous.chapterIndex === next.chapterIndex &&
        previous.location === next.location &&
        previous.minutesLeftInChapter === next.minutesLeftInChapter
          ? previous
          : next,
      );
    };

    const scheduleFrame = () => {
      if (frameId) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        runFrame();
      });
    };

    /** Where the text column sits on screen, for the margin ruler and time left. */
    const measureColumn = () => {
      window.clearTimeout(measureTimer);
      measureTimer = window.setTimeout(() => {
        if (!isMounted) {
          return;
        }

        const content = getRenditionContents(rendition)[0];
        const body = content?.document.body;
        const frame = content?.document.defaultView?.frameElement;

        if (!body || !frame) {
          return;
        }

        const frameRect = frame.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const style = content.document.defaultView!.getComputedStyle(body);
        const next: ColumnBox = {
          left: Math.round(
            frameRect.left + bodyRect.left + parseFloat(style.paddingLeft),
          ),
          right: Math.round(
            frameRect.left + bodyRect.right - parseFloat(style.paddingRight),
          ),
          viewport: window.innerWidth,
        };

        setColumnBox((previous) =>
          previous &&
          previous.left === next.left &&
          previous.right === next.right &&
          previous.viewport === next.viewport
            ? previous
            : next,
        );
        scheduleFrame();
      }, 60);
    };

    scheduleFrameRef.current = scheduleFrame;
    measureColumnRef.current = measureColumn;

    /**
     * Paints the section's highlights with the CSS Custom Highlight API, which
     * marks ranges without touching the markup: a highlight wrapped in an
     * element would shift every CFI saved after it. Only a section whose soft
     * hyphens are in, as they were when its CFIs were made.
     */
    const paintHighlights = (view: EpubContentView) => {
      const frameWindow = view.document.defaultView as
        | (Window & typeof globalThis)
        | null;
      const registry = frameWindow?.CSS?.highlights;

      if (
        !frameWindow ||
        !registry ||
        typeof frameWindow.Highlight !== "function" ||
        !blocksOf.has(view.document)
      ) {
        return;
      }

      const byColor = new Map<HighlightColor, Range[]>();
      const found: Array<{ id: string; range: Range }> = [];

      for (const highlight of highlightsRef.current) {
        if (!highlight.color) {
          continue;
        }

        try {
          const cfi = new EpubCFI(highlight.cfi);

          if (cfi.spinePos !== view.sectionIndex) {
            continue;
          }

          const range = cfi.toRange(view.document);

          if (range && !range.collapsed) {
            byColor.set(highlight.color, [
              ...(byColor.get(highlight.color) ?? []),
              range,
            ]);
            found.push({ id: highlight.id, range });
          }
        } catch {
          // A range this section cannot resolve stays in the list, unpainted.
        }
      }

      HIGHLIGHT_COLORS.forEach((color) => {
        const ranges = byColor.get(color);

        if (ranges?.length) {
          registry.set(
            highlightName(color),
            new frameWindow.Highlight(...ranges),
          );
        } else {
          registry.delete(highlightName(color));
        }
      });
      highlightsIn.set(view.document, found);
    };

    paintHighlightsRef.current = () =>
      getRenditionContents(rendition).forEach(paintHighlights);

    /** The highlight under a point in a section's frame, the latest on top. */
    const highlightAt = (document: Document, x: number, y: number) =>
      [...(highlightsIn.get(document) ?? [])]
        .reverse()
        .find(({ range }) =>
          Array.from(range.getClientRects()).some(
            (rect) =>
              x >= rect.left &&
              x <= rect.right &&
              y >= rect.top &&
              y <= rect.bottom,
          ),
        ) ?? null;

    /**
     * Offers the colours once a selection has settled: after the mouse button
     * is up, or when a touch selection's handles stop moving.
     */
    const listenForSelection = (view: EpubContentView, contents: Contents) => {
      const document = view.document;
      let pressed = false;
      let timer = 0;

      const read = () => {
        if (!isMounted) {
          return;
        }

        const selection = document.getSelection();

        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setHighlightTarget((current) =>
            current?.kind === "selection" &&
            rangeDocument(current.range) === document
              ? null
              : current,
          );
          return;
        }

        if (
          pressed ||
          view.sectionIndex === undefined ||
          !blocksOf.has(document)
        ) {
          return;
        }

        const range = selection.getRangeAt(0);
        const text = highlightText(range);

        if (!text) {
          return;
        }

        let cfi: string;

        try {
          cfi = contents.cfiFromRange(range);
        } catch {
          return;
        }

        const percentage = hasLocations
          ? (book.locations.percentageFromCfi(cfi) as number | null)
          : null;
        setHighlightTarget({
          kind: "selection",
          cfi,
          text,
          section: view.sectionIndex,
          progress:
            typeof percentage === "number" && Number.isFinite(percentage)
              ? clamp(percentage, 0, 1)
              : null,
          range: range.cloneRange(),
        });
      };
      const soon = (delay: number) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(read, delay);
      };
      const changed = () => soon(220);
      const press = (event: Event) => {
        pressed = (event as PointerEvent).pointerType === "mouse";
      };
      const release = () => {
        if (pressed) {
          pressed = false;
          soon(0);
        }
      };

      document.addEventListener("selectionchange", changed);
      document.addEventListener("pointerdown", press, { passive: true });
      document.addEventListener("pointerup", release, { passive: true });
      document.addEventListener("pointercancel", release, { passive: true });
      // A drag that ends outside the frame lets go over the page.
      window.addEventListener("pointerup", release, { passive: true });

      return () => {
        window.clearTimeout(timer);
        document.removeEventListener("selectionchange", changed);
        document.removeEventListener("pointerdown", press);
        document.removeEventListener("pointerup", release);
        document.removeEventListener("pointercancel", release);
        window.removeEventListener("pointerup", release);
      };
    };

    const buildMapIfReady = () => {
      if (!isMounted || !hasLocations || !navigationToc) {
        return;
      }

      map = buildBookMap(book, navigationToc);
      setBookMap(map);
      scheduleFrame();
    };

    rendition.hooks.content.register(async (contents: Contents) => {
      const view = contents as unknown as EpubContentView;
      tapListeners.push(
        listenForTaps(
          view.document,
          (target, release) => handleTap(target, release),
          scrolledRecently,
        ),
        listenForSelection(view, contents),
      );
      view.addStylesheetCss(getBookFontCss(), "seyirlik-fonts");
      view.addStylesheetCss(EPUB_STATIC_CSS, "seyirlik-static");
      view.addStylesheetCss(
        getEpubThemeCss(
          settingsRef.current,
          themePalettes[settingsRef.current.theme],
          readLiveAccent(),
        ),
        "seyirlik-theme",
      );

      const bookLanguage =
        (book.packaging?.metadata?.language as string | undefined) ?? "";
      const textLanguage = await hyphenateDocument(view.document, bookLanguage);

      // A Turkish book labelled English: the interface's chapter names follow
      // the text, so their capitals are Turkish too.
      if (
        isMounted &&
        /^tr\b/i.test(textLanguage) &&
        !/^tr\b/i.test(bookLanguage)
      ) {
        setBookMeta((meta) =>
          /^tr\b/i.test(meta.language) ? meta : { ...meta, language: "tr" },
        );
      }

      if (!isMounted) {
        return;
      }

      const blocks = getEpubBlocks(view.document);
      enhanceSection(blocks);
      blocksOf.set(view.document, blocks);
      paintHighlights(view);
      light.add(view.document, view.sectionIndex ?? 0, blocks);
      resolveFirstContent();
      measureColumn();
      scheduleFrame();
    });

    const saveLocation = (location?: EpubLocation | null) => {
      if (!isMounted) {
        return;
      }

      const currentLocation =
        location ??
        (rendition.currentLocation() as unknown as EpubLocation | undefined);
      const nextCfi = currentLocation?.start?.cfi ?? currentCfiValue;
      const nextProgress = getEpubProgressFromLocation(
        book,
        currentLocation,
        nextCfi,
        hasLocations,
      );

      if (currentLocation?.start?.href) {
        setCurrentHref(currentLocation.start.href);
      }

      if (nextProgress === null) {
        return;
      }

      currentCfiValue = nextCfi;
      setCurrentCfi(nextCfi ?? null);
      setEpubProgress(nextProgress);

      // Nobody reads a hidden page: whatever moves it then (a font landing, the
      // book being measured) is not the reader, and must not outrank a place
      // they have since reached on another device.
      if (restoring || superseded || document.visibilityState === "hidden") {
        return;
      }

      const scroller = host.querySelector<HTMLElement>(".epub-container");
      const place = scroller
        ? readPlace(scroller, getRenditionContents(rendition), blocksOf)
        : null;
      const key = positionKey({ cfi: nextCfi ?? null, place });
      const readAt = key === known.key ? known.readAt : Date.now();
      writeReaderProgress(activeItemId, {
        ...(nextCfi ? { cfi: nextCfi } : {}),
        scrollRatio: nextProgress,
        place: place ?? undefined,
        readAt,
      });

      if (key !== known.key) {
        known = { key, readAt };
        unsent = {
          cfi: nextCfi ?? null,
          place,
          fraction: nextProgress,
          readAt,
        };
        window.clearTimeout(sendTimer);
        sendTimer = window.setTimeout(sendPosition, POSITION_SEND_DELAY_MS);
      }
    };

    /**
     * Another copy of the book, opened later, keeps the place now: this one
     * stops saving and says so, and the reader decides where to go on.
     */
    const supersede = (by: ReadingSession | null) => {
      if (!isMounted || superseded) {
        return;
      }
      superseded = true;
      unsent = null;
      window.clearTimeout(sendTimer);
      setTakingBack("idle");
      setTakenBy(by ?? { id: "", openedAt: Date.now(), device: null });
    };

    /** Says this copy is open: true if it keeps the place, null if unknown. */
    const claim = async (): Promise<boolean | null> => {
      const asked = session;
      try {
        const result = await claimBookSession(activeItemId, asked);
        // An answer for a copy this page has since replaced says nothing.
        if (asked !== session) {
          return null;
        }
        if (!result.owner) {
          supersede(result.session);
        }
        return result.owner;
      } catch {
        return null;
      }
    };

    const sendPosition = (options: { keepalive?: boolean } = {}) => {
      window.clearTimeout(sendTimer);
      const position = unsent;

      if (!position || superseded) {
        return;
      }

      unsent = null;
      const sentAs = session;
      void saveBookPosition(activeItemId, position, {
        ...options,
        session: sentAs,
      }).then(
        (result) => {
          if (result.superseded && sentAs === session) {
            supersede(result.superseded);
          }
        },
        () => {
          // Offline or refused: keep it for the next send, unless the reader
          // has moved on since, which is newer anyway.
          unsent ??= position;
        },
      );
    };

    const handleScroll = () => {
      scheduleFrame();
      placeHighlightMenu();
      lastScrollAt = performance.now();

      if (scrollElement) {
        const top = scrollElement.scrollTop;
        const delta = top - lastScrollTop;
        lastScrollTop = top;

        if (
          Math.abs(delta) > 4 &&
          panelRef.current === null &&
          !barHoverRef.current
        ) {
          setChromeHidden(true);
        }
      }

      if (!progressFrame) {
        progressFrame = window.setTimeout(() => {
          progressFrame = 0;
          saveLocation();
        }, 180);
      }
    };

    const attachScroll = () => {
      if (!isMounted) {
        return;
      }

      scrollElement = host.querySelector<HTMLElement>(".epub-container");
      scrollElement?.addEventListener("scroll", handleScroll, {
        passive: true,
      });
      lastScrollTop = scrollElement?.scrollTop ?? 0;
      saveLocation();
      measureColumn();
    };

    const handleRelocated = (location: EpubLocation) => {
      currentCfiValue = location.start.cfi;
      saveLocation(location);
    };

    // A tap or click on the page that selects nothing shows or hides the bar;
    // on an illustration it opens the picture full size instead, and on a
    // highlight it offers its colours.
    const handleTap = (tapped: EventTarget | null, release: PointerEvent) => {
      const target = tapped as Element | null;
      const selection = target?.ownerDocument?.getSelection();

      if ((selection && !selection.isCollapsed) || target?.closest?.("a")) {
        return;
      }

      if (highlightTargetRef.current !== null) {
        setHighlightTarget(null);
        return;
      }

      if (panelRef.current !== null) {
        setPanel(null);
        return;
      }

      const highlight = target?.ownerDocument
        ? highlightAt(target.ownerDocument, release.clientX, release.clientY)
        : null;
      if (highlight) {
        setHighlightTarget({ kind: "highlight", ...highlight });
        return;
      }

      const image = zoomableImageAt(target);
      if (image) {
        setZoomedImage(image);
        return;
      }

      setChromeHidden((hidden) => !hidden);
    };

    const handleKey = (event: KeyboardEvent) => readerKeyRef.current(event);

    rendition.on("relocated", handleRelocated);
    rendition.on("keydown", handleKey);

    const resizeObserver = new ResizeObserver(() => {
      measureColumn();
      scheduleFrame();
      placeHighlightMenu();
    });
    resizeObserver.observe(host);

    const preparationTimeoutId = window.setTimeout(() => {
      if (isMounted) {
        setReaderError(t("reader.epubTimedOut"));
      }
    }, EPUB_PREPARATION_TIMEOUT_MS);

    void book.loaded.navigation
      .then((navigation) => {
        if (!isMounted) {
          return;
        }

        navigationToc = flattenToc(navigation.toc).slice(0, 240);
        setToc(navigationToc);
        buildMapIfReady();
      })
      .catch(() => undefined);

    void book.loaded.metadata
      .then((metadata) => {
        if (isMounted) {
          setBookMeta({
            author: metadata.creator ?? "",
            language: metadata.language ?? "",
          });
        }
      })
      .catch(() => undefined);

    const backToPlace = (place: ReaderPlace) => {
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      return scroller
        ? returnToPlace(
            scroller,
            getRenditionContents(rendition),
            blocksOf,
            place,
          )
        : false;
    };

    /**
     * Shows `to`, or reports that it could not: a display that fails or never
     * finishes is let go (a new display releases epub.js's queue from it).
     */
    const displayWithin = (to: string | undefined) =>
      Promise.race([
        rendition.display(to).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) =>
          window.setTimeout(() => resolve(false), EPUB_DISPLAY_LIMIT_MS),
        ),
      ]);

    /**
     * Takes the screen to a saved place: its section first, then, once the
     * book's typography has settled (it lands in the content hook, after
     * epub.js has scrolled), the same block at the same distance from the
     * top, which a CFI alone cannot say. Sections loading around it can still
     * shift it, so it is set once more after they settle. Older saves have
     * only a CFI.
     *
     * A way in that will not display gives way to the start of its section,
     * then of the book: the reader opens somewhere rather than nowhere.
     */
    const goTo = async (target: Target, opening: boolean) => {
      // The spine is read only once the book has opened: asked before, it has
      // no sections, and the place fell back to its CFI, which epub.js then
      // resolved against a section not yet hyphenated.
      await book.opened;
      const sectionOf = (key: number | string | null | undefined) =>
        key === null || key === undefined
          ? undefined
          : (book.spine.get(key) as Section | null)?.href;
      const start =
        (target.place ? sectionOf(target.place.section) : undefined) ??
        target.cfi ??
        undefined;
      const ways = [...new Set([start, sectionOf(target.cfi), undefined])];
      let shown: string | undefined | null = null;

      for (const way of ways) {
        if (!isMounted) {
          return;
        }

        if (await displayWithin(way)) {
          shown = way;
          break;
        }
      }

      if (shown === null) {
        throw new Error("The book could not be displayed");
      }

      if (opening) {
        await Promise.race([
          firstContent,
          new Promise((resolve) => window.setTimeout(resolve, 2500)),
        ]);
      }

      if (shown && isMounted) {
        await waitForLayoutToSettle(host);
      }

      if (target.place && isMounted && backToPlace(target.place)) {
        await waitForLayoutToSettle(host);
        backToPlace(target.place);
      } else if (target.cfi && isMounted) {
        await displayWithin(target.cfi);
      }

      // Known as this screen measures it once there: a place saved on a
      // narrower screen lands a block or a few px apart here, and that must
      // not count as the reader moving, or catching up would save it again
      // as a new reading.
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      const landed = scroller
        ? readPlace(scroller, getRenditionContents(rendition), blocksOf)
        : null;
      known = {
        key: positionKey(landed ? { cfi: null, place: landed } : target),
        readAt: target.readAt,
      };
    };

    /** Takes away what showing a search hit put on the page. */
    let putOutShimmer = () => undefined as void;

    /** The book fading out and back, so a jump never shows where it passed. */
    let veil: Animation | null = null;
    const veilTo = (opacity: number, duration: number) => {
      const from = getComputedStyle(host).opacity;
      veil?.cancel();
      veil = host.animate([{ opacity: from }, { opacity }], {
        duration,
        easing: "cubic-bezier(0.37, 0, 0.63, 1)",
        fill: "forwards",
      });
      return veil.finished.then(
        () => undefined,
        () => undefined,
      );
    };

    /**
     * Opens the book at a search hit: its section, then the words it was
     * found by, their line on the reading line, where the light falls (a hit
     * found by meaning alone, its first line). The found words stay marked,
     * and the reader's colour runs through the passage from their block once
     * so the eye finds it (searchMarks.ts, searchShimmer.ts).
     *
     * The server counted the blocks the way this page does, but the page is
     * the one that knows, so the block must hold the passage's opening words;
     * if it does not, the section's first block that does is used instead.
     */
    showPassageRef.current = async (hit, found) => {
      await book.opened;
      const href = (book.spine.get(hit.section) as Section | null)?.href;
      if (!href || !isMounted) {
        return;
      }
      // A chapter already on the page is scrolled to directly. One that is
      // not can only be displayed from its start, so the book fades out
      // first and comes back at the passage: the start is never seen.
      const rendered = getRenditionContents(rendition).some(
        (content) =>
          content.sectionIndex === hit.section &&
          blocksOf.has(content.document),
      );
      if (!rendered) {
        setJumping(true);
        await veilTo(0, 140);
        if (!isMounted) {
          return;
        }
        if (!(await displayWithin(href))) {
          setJumping(false);
          await veilTo(1, 220);
          veil?.cancel();
          return;
        }
        await waitForLayoutToSettle(host);
      }

      const blocks = getRenditionContents(rendition)
        .filter((content) => content.sectionIndex === hit.section)
        .map((content) => blocksOf.get(content.document))[0];
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      if (!blocks || !scroller || !isMounted) {
        setJumping(false);
        await veilTo(1, 220);
        veil?.cancel();
        return;
      }
      const holds = (index: number) =>
        epubBlockText(blocks[index]?.textContent ?? "").includes(hit.anchor);
      const start = holds(hit.block)
        ? hit.block
        : blocks.findIndex((_, index) => holds(index));
      const block = start >= 0 ? start : Math.min(hit.block, blocks.length - 1);
      if (!blocks[block]) {
        setJumping(false);
        await veilTo(1, 220);
        veil?.cancel();
        return;
      }

      // The passage's blocks: its text is theirs, one per line, in order.
      const passage = [blocks[block]!];
      for (const part of hit.text.split("\n").slice(1)) {
        const next = blocks[block + passage.length];
        if (
          !next ||
          !epubBlockText(next.textContent ?? "").startsWith(part.slice(0, 40))
        )
          break;
        passage.push(next);
      }
      const onPage = findOnPage(passage, hit.text, found);
      const focusBlock = onPage.focus?.block ?? 0;

      // The found words' line (or the passage's first) centred on the
      // reading line, so the light falls on them. Measured each time it is
      // set: sections loading around it can still move it.
      const placeNow = () => {
        const target = passage[focusBlock]!;
        const top = target.getBoundingClientRect().top;
        let middle: number;
        const words = onPage.focus?.range.getClientRects()[0];
        if (words) {
          middle = words.top + words.height / 2 - top;
        } else {
          const lineHeight = Number.parseFloat(
            getComputedStyle(target).lineHeight,
          );
          middle = Number.isFinite(lineHeight) ? lineHeight / 2 : 0;
        }
        return {
          section: hit.section,
          block: block + focusBlock,
          offset: Math.round(middle - scroller.clientHeight * READING_LINE),
        };
      };

      backToPlace(placeNow());
      await waitForLayoutToSettle(host);
      backToPlace(placeNow());
      scheduleFrame();
      if (!rendered) {
        setJumping(false);
        await veilTo(1, 240);
        veil?.cancel();
        if (!isMounted) {
          return;
        }
      }

      const frame = passage[0]!.ownerDocument.defaultView?.frameElement;
      if (!frame || !isMounted) {
        return;
      }
      const frameTop = frame.getBoundingClientRect().top;
      const view = scroller.getBoundingClientRect();
      const palette = themePalettes[settingsRef.current.theme];
      putOutShimmer();
      const putOutWords = markFoundWords(onPage.ranges, palette);
      const putOutColour = shimmerPassage(passage.slice(focusBlock), {
        mark: palette.mark,
        ink: palette.ink,
        scheme: palette.scheme,
        visible: { top: view.top - frameTop, bottom: view.bottom - frameTop },
      });
      putOutShimmer = () => {
        putOutWords();
        putOutColour();
      };
    };

    /**
     * Brings the reading line to `fraction` of a chapter, as the ruler's
     * marker would show it: the inverse of the marker's placement. A section
     * already on the page is scrolled to directly. One that is not (a chapter
     * spread over several) is displayed first, one at a time, and the latest
     * place asked for meanwhile is taken once it is there.
     */
    let seekShowing = false;
    let seekWanted: { chapterIndex: number; fraction: number } | null = null;
    const seekChapter = (
      chapterIndex: number,
      fraction: number,
      retries = 2,
    ) => {
      if (seekShowing) {
        seekWanted = { chapterIndex, fraction };
        return;
      }
      const chapter = map?.chapters[chapterIndex];
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      if (!map || !chapter || !scroller || chapter.end <= chapter.start) {
        return;
      }
      // Never quite the end: that is the next chapter's first line.
      const location = Math.min(
        chapter.start + (chapter.end - chapter.start) * fraction,
        chapter.end - 0.01,
      );
      let section = chapter.spineIndex;
      while (
        section + 1 < map.sectionStarts.length &&
        map.sectionStarts[section + 1] <= location
      ) {
        section += 1;
      }
      const start = map.sectionStarts[section] ?? 0;
      const end = map.sectionStarts[section + 1] ?? map.total;
      const within =
        end > start ? clamp((location - start) / (end - start), 0, 1) : 0;
      const frame = getRenditionContents(rendition).find(
        (content) => content.sectionIndex === section,
      )?.document.defaultView?.frameElement;

      if (frame) {
        const rect = frame.getBoundingClientRect();
        const view = host.getBoundingClientRect();
        const target =
          scroller.scrollTop +
          rect.top +
          rect.height * within -
          (view.top + view.height * READING_LINE);
        scroller.scrollTop = target;
        scheduleFrame();

        // The page ended before the place: epub.js adds the next section as
        // the scroll reaches the end, and the seek is made again once it has.
        if (Math.abs(scroller.scrollTop - target) > 1 && retries > 0) {
          const height = scroller.scrollHeight;
          const started = performance.now();
          seekShowing = true;
          seekWanted = { chapterIndex, fraction };
          const wait = () => {
            if (
              isMounted &&
              scroller.scrollHeight === height &&
              performance.now() - started < 600
            ) {
              window.setTimeout(wait, 50);
              return;
            }
            seekShowing = false;
            const wanted = seekWanted;
            seekWanted = null;
            if (wanted && isMounted) {
              seekChapter(wanted.chapterIndex, wanted.fraction, retries - 1);
            }
          };
          window.setTimeout(wait, 50);
        }
        return;
      }

      const href = (book.spine.get(section) as Section | null)?.href;
      if (!href) {
        return;
      }
      seekShowing = true;
      seekWanted = { chapterIndex, fraction };
      void displayWithin(href).then(async (shown) => {
        if (shown && isMounted) {
          await waitForLayoutToSettle(host);
        }
        seekShowing = false;
        const wanted = seekWanted;
        seekWanted = null;
        const there = getRenditionContents(rendition).some(
          (content) => content.sectionIndex === section,
        );
        // Shown and still not on the page: asking again would never end.
        if (wanted && isMounted && there) {
          seekChapter(wanted.chapterIndex, wanted.fraction);
        }
      });
    };
    seekChapterRef.current = seekChapter;

    /**
     * Back on this page after reading elsewhere: if another device has since
     * saved a later place, the book moves there before anything here is saved.
     */
    let catchingUp = false;
    const catchUp = async ({ force = false } = {}) => {
      if (restoring || catchingUp || !isMounted) {
        return;
      }

      catchingUp = true;
      restoring = true;

      try {
        const remote = await getBookPosition(activeItemId).catch(() => null);

        // Forced when this copy takes the book back: the place the other
        // copy reached is the latest whatever its device's clock said.
        if (
          remote &&
          isMounted &&
          (force || remote.readAt > known.readAt) &&
          positionKey(remote) !== known.key
        ) {
          unsent = null;
          window.clearTimeout(sendTimer);
          await goTo(remote, false);
          writeReaderProgress(activeItemId, {
            ...(remote.cfi ? { cfi: remote.cfi } : {}),
            scrollRatio: remote.fraction,
            place: remote.place ?? undefined,
            readAt: remote.readAt,
          });
          scheduleFrame();
        }
      } finally {
        restoring = false;
        catchingUp = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        sendPosition({ keepalive: true });
      } else if (!superseded) {
        // Opened elsewhere meanwhile: say so here rather than move on.
        void claim().then((owner) => {
          if (owner !== false) {
            void catchUp();
          }
        });
      }
    };
    const handlePageHide = () => sendPosition({ keepalive: true });
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);

    /**
     * The place keeps in step with the account while the book is open, not
     * only when the page is left: a send that failed is sent again, a place
     * reached during a long read goes out without waiting for the reader to
     * stop, and a place read since on another device is taken, so a window
     * left open never saves its old place over a newer one. A page that is
     * never hidden (a desktop window behind another) would otherwise not
     * hear of it until the reader scrolled it, too late.
     */
    const syncPosition = () => {
      if (
        document.visibilityState === "hidden" ||
        !isMounted ||
        restoring ||
        superseded
      ) {
        return;
      }
      void claim().then((owner) => {
        if (owner === false || !isMounted) {
          return;
        }
        sendPosition();
        const selecting = getRenditionContents(rendition).some(
          (content) => !(content.document.getSelection()?.isCollapsed ?? true),
        );
        if (
          !selecting &&
          rulerDragRef.current < 0 &&
          performance.now() - lastScrollAt >= CATCH_UP_IDLE_MS
        ) {
          void catchUp();
        }
      });
    };

    continueHereRef.current = async () => {
      const next: ReadingSession = {
        id: randomUuid(),
        openedAt: Date.now(),
        device: readerDevice(),
      };
      const result = await claimBookSession(activeItemId, next);
      if (!isMounted) {
        return false;
      }
      if (!result.owner) {
        // Opened somewhere else again in the meantime.
        setTakenBy(result.session);
        return false;
      }
      session = next;
      await catchUp({ force: true });
      superseded = false;
      setTakenBy(null);
      return true;
    };
    const syncTimer = window.setInterval(syncPosition, READER_SYNC_MS);
    // Back to this window, back from the browser's page cache, or back online.
    window.addEventListener("focus", syncPosition);
    window.addEventListener("pageshow", syncPosition);
    window.addEventListener("online", syncPosition);

    void (async () => {
      try {
        const remote = await Promise.race([
          remotePosition,
          new Promise<null>((resolve) =>
            window.setTimeout(() => resolve(null), POSITION_FETCH_LIMIT_MS),
          ),
        ]);
        const target =
          remote && remote.readAt > localPosition.readAt
            ? remote
            : localPosition;
        await goTo(target, true);

        restoring = false;
        // Opening the book here makes this the copy that keeps the place.
        void claim();
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setEpubReady(true);
          window.requestAnimationFrame(attachScroll);
        }
      } catch (error: unknown) {
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setReaderError(describeErrorForUser(error, t, "reader.couldNotOpen"));
        }
      }
    })();

    void book.ready
      .then(() => book.locations.generate(CHARS_PER_LOCATION))
      .then(() => {
        if (!isMounted) {
          return;
        }

        hasLocations = true;
        saveLocation();
        buildMapIfReady();
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
      window.clearTimeout(preparationTimeoutId);
      window.clearTimeout(measureTimer);
      window.clearTimeout(markerTimer);
      window.clearTimeout(progressFrame);
      window.cancelAnimationFrame(frameId);
      // Leaving the book inside the app is leaving it too.
      sendPosition({ keepalive: true });
      window.clearInterval(syncTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("focus", syncPosition);
      window.removeEventListener("pageshow", syncPosition);
      window.removeEventListener("online", syncPosition);
      resizeObserver.disconnect();
      scrollElement?.removeEventListener("scroll", handleScroll);
      rendition.off("relocated", handleRelocated);
      tapListeners.forEach((stop) => stop());
      rendition.off("keydown", handleKey);
      stopSettlingDisplays();
      light.clear();
      rendition.destroy();
      book.destroy();
      scheduleFrameRef.current = () => undefined;
      showPassageRef.current = async () => undefined;
      seekChapterRef.current = () => undefined;
      putOutShimmer();
      measureColumnRef.current = () => undefined;
      paintHighlightsRef.current = () => undefined;

      if (renditionRef.current === rendition) {
        renditionRef.current = null;
      }

      if (bookRef.current === book) {
        bookRef.current = null;
      }

      if (lightRef.current === light) {
        lightRef.current = null;
      }
    };
  }, [activeItemId, fileUrl, format, placeHighlightMenu, t]);

  // Settings apply live to every rendered section of the book.
  useEffect(() => {
    const rendition = renditionRef.current;

    if (!rendition || format !== "epub") {
      return undefined;
    }

    if (lightRef.current) {
      lightFromSettings(lightRef.current, settings);
    }

    const css = getEpubThemeCss(settings, palette, readLiveAccent());
    getRenditionContents(rendition).forEach((content) =>
      content.addStylesheetCss(css, "seyirlik-theme"),
    );

    // Sections reflow and the iframes resize a moment after the new rules land.
    const timers = [60, 260, 700].map((delay) =>
      window.setTimeout(() => {
        measureColumnRef.current();
        scheduleFrameRef.current();
        placeHighlightMenu();
      }, delay),
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [format, palette, placeHighlightMenu, settings]);

  /* ---------------- Plain text, HTML, images ---------------- */
  const shouldFetchText = format === "text" || format === "html";

  useEffect(() => {
    if (!shouldFetchText || !fileUrl) {
      return undefined;
    }

    const controller = new AbortController();
    setTextContent(null);
    setReaderError(null);

    void fetch(fileUrl, {
      headers: {
        Accept:
          format === "html"
            ? "text/html,application/xhtml+xml,text/plain;q=0.8"
            : "text/plain,text/markdown,*/*;q=0.4",
      },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        return response.text();
      })
      .then((content) => setTextContent(content))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setReaderError(describeErrorForUser(error, t, "reader.textLoadFailed"));
      });

    return () => controller.abort();
  }, [fileUrl, format, shouldFetchText, t]);

  const tracksScrollHost =
    format === "text" || format === "image" || format === "fallback";

  useEffect(() => {
    const scrollElement = scrollHostRef.current;

    if (!item || !tracksScrollHost || !scrollElement) {
      return undefined;
    }

    let lastTop = scrollElement.scrollTop;
    let lastScrollAt = 0;
    const stopTaps = listenForTaps(
      scrollElement,
      (tapped) => {
        const target = tapped as Element | null;
        if (
          target?.closest?.("a, button") ||
          !(window.getSelection()?.isCollapsed ?? true)
        ) {
          return;
        }
        if (panelRef.current !== null) {
          setPanel(null);
          return;
        }
        setChromeHidden((hidden) => !hidden);
      },
      () => performance.now() - lastScrollAt < TAP_AFTER_SCROLL_MS,
    );
    const handleScroll = () => {
      lastScrollAt = performance.now();
      const nextProgress = getScrollProgress(scrollElement);
      const delta = scrollElement.scrollTop - lastTop;
      lastTop = scrollElement.scrollTop;

      if (
        Math.abs(delta) > 4 &&
        panelRef.current === null &&
        !barHoverRef.current
      ) {
        setChromeHidden(true);
      }

      setScrollProgress(nextProgress);
      writeReaderProgress(item.Id, { scrollRatio: nextProgress });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    const saved = readReaderProgress(item.Id)?.scrollRatio;
    const restoreTimer = saved
      ? window.setTimeout(() => {
          const maxScroll =
            scrollElement.scrollHeight - scrollElement.clientHeight;
          scrollElement.scrollTo({ top: Math.max(0, maxScroll * saved) });
        }, 80)
      : 0;

    return () => {
      window.clearTimeout(restoreTimer);
      stopTaps();
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [item, textContent, tracksScrollHost]);

  /* ---------------- Keyboard ---------------- */
  useLayoutEffect(() => {
    readerKeyRef.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === "Escape") {
        if (highlightTargetRef.current !== null) {
          setHighlightTarget(null);
        } else if (panelRef.current !== null) {
          setPanel(null);
        }
        return;
      }

      if (
        panelRef.current !== null ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const scroller =
        format === "epub"
          ? epubHostRef.current?.querySelector<HTMLElement>(".epub-container")
          : scrollHostRef.current;

      if (!scroller) {
        return;
      }

      const page = scroller.clientHeight * 0.85;
      const step =
        event.key === " " || event.key === "PageDown"
          ? event.shiftKey && event.key === " "
            ? -page
            : page
          : event.key === "PageUp"
            ? -page
            : event.key === "ArrowDown"
              ? 72
              : event.key === "ArrowUp"
                ? -72
                : 0;

      if (step === 0) {
        return;
      }

      event.preventDefault();
      scroller.scrollBy({
        top: step,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    };
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => readerKeyRef.current(event);
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // A pointer press outside an open popover closes it.
  useEffect(() => {
    if (panel !== "settings" && panel !== "more") {
      return undefined;
    }

    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        settingsPanelRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        (target instanceof Element && target.closest(".rd-bar-end"))
      ) {
        return;
      }

      setPanel(null);
    };

    window.addEventListener("pointerdown", handlePointer);
    return () => window.removeEventListener("pointerdown", handlePointer);
  }, [panel]);

  /* ---------------- Navigation and bookmarks ---------------- */
  // Same settle-then-return as opening the book: the first display lands
  // before the sections around the target have taken our typography.
  const navigateTo = useCallback((target: string) => {
    const rendition = renditionRef.current;
    const host = epubHostRef.current;
    setPanel(null);

    if (!rendition || !host) {
      return;
    }

    void rendition
      .display(target)
      .then(() => waitForLayoutToSettle(host))
      .then(() =>
        renditionRef.current === rendition
          ? rendition.display(target)
          : undefined,
      )
      .then(() => scheduleFrameRef.current())
      .catch(() => undefined);
  }, []);

  const showPassage = useCallback(
    (hit: BookSearchHit, found: BookSearchFound) => {
      setPanel(null);
      void showPassageRef.current(hit, found).catch(() => undefined);
    },
    [],
  );

  const spineIndexOf = useCallback((href: string) => {
    const section = bookRef.current?.spine.get(
      href.split("#")[0],
    ) as unknown as { index?: number } | null | undefined;
    return typeof section?.index === "number" ? section.index : null;
  }, []);

  // A book whose contents list has one entry (often "Start") has no chapters
  // to speak of: the ruler and "chapter ends in" would describe the whole book.
  const hasChapters = bookMap ? bookMap.chapters.length >= 2 : toc.length >= 2;
  const currentChapter =
    hasChapters && bookMap && reading && reading.chapterIndex >= 0
      ? bookMap.chapters[reading.chapterIndex]
      : null;
  const fallbackChapterLabel = useMemo(() => {
    const base = currentHref?.split("#")[0];
    if (!base || !hasChapters) {
      return "";
    }
    let label = "";
    toc.forEach((entry) => {
      if (entry.href.split("#")[0] === base) {
        label ||= entry.label;
      }
    });
    return label.trim();
  }, [currentHref, hasChapters, toc]);
  const chapterLabel = currentChapter?.label ?? fallbackChapterLabel;
  const bookFraction =
    format === "epub"
      ? (reading?.bookFraction ?? epubProgress)
      : scrollProgress;

  const isBookmarked = useMemo(
    () =>
      bookmarks.some(
        (bookmark) =>
          !isHighlight(bookmark) &&
          ((currentCfi !== null && bookmark.cfi === currentCfi) ||
            (bookmark.progress !== null &&
              Math.abs(bookmark.progress - bookFraction) < 0.0025)),
      ),
    [bookFraction, bookmarks, currentCfi],
  );

  const toggleBookmark = useCallback(async () => {
    if (!activeItemId || !currentCfi) {
      return;
    }

    if (isBookmarked) {
      commitBookmarks((current) =>
        current.filter(
          (bookmark) =>
            isHighlight(bookmark) ||
            (bookmark.cfi !== currentCfi &&
              !(
                bookmark.progress !== null &&
                Math.abs(bookmark.progress - bookFraction) < 0.0025
              )),
        ),
      );
      return;
    }

    let excerpt = "";

    try {
      const range = await bookRef.current?.getRange(currentCfi);
      const node = range?.startContainer;
      const text = (node?.textContent ?? "").replace(/­/g, "");
      excerpt = text
        .slice(
          node?.nodeType === Node.TEXT_NODE ? (range?.startOffset ?? 0) : 0,
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    } catch {
      excerpt = "";
    }

    const bookmark: ReaderBookmark = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      cfi: currentCfi,
      label: splitNumber(chapterLabel).title || title,
      excerpt,
      progress: bookFraction,
      createdAt: Date.now(),
    };
    commitBookmarks((current) => [...current, bookmark]);
  }, [
    activeItemId,
    bookFraction,
    chapterLabel,
    commitBookmarks,
    currentCfi,
    isBookmarked,
    title,
  ]);

  const removeBookmark = useCallback(
    (id: string) => {
      if (!activeItemId) {
        return;
      }
      commitBookmarks((current) =>
        current.filter((bookmark) => bookmark.id !== id),
      );
    },
    [activeItemId, commitBookmarks],
  );

  const highlightColor =
    highlightTarget === null
      ? null
      : (bookmarks.find((bookmark) =>
          highlightTarget.kind === "highlight"
            ? bookmark.id === highlightTarget.id
            : isHighlight(bookmark) && bookmark.cfi === highlightTarget.cfi,
        )?.color ?? null);

  /** Marks the selection in a colour, or gives a tapped highlight a new one. */
  const pickHighlightColor = useCallback(
    (color: HighlightColor) => {
      const target = highlightTarget;

      if (!target || !activeItemId) {
        return;
      }

      const isTarget = (bookmark: ReaderBookmark) =>
        target.kind === "highlight"
          ? bookmark.id === target.id
          : isHighlight(bookmark) && bookmark.cfi === target.cfi;

      if (bookmarks.some(isTarget)) {
        commitBookmarks((current) =>
          current.map((bookmark) =>
            isTarget(bookmark) ? { ...bookmark, color } : bookmark,
          ),
        );
      } else if (target.kind === "selection") {
        const chapterIndex =
          hasChapters && bookMap ? chapterAt(bookMap, target.section) : -1;
        const highlight: ReaderBookmark = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          cfi: target.cfi,
          label:
            splitNumber(bookMap?.chapters[chapterIndex]?.label ?? chapterLabel)
              .title || title,
          excerpt: target.text,
          progress: target.progress ?? bookFraction,
          createdAt: Date.now(),
          color,
        };
        commitBookmarks((current) => [...current, highlight]);
      } else {
        return;
      }

      if (target.kind === "selection") {
        rangeDocument(target.range)?.getSelection()?.removeAllRanges();
      }

      setHighlightTarget(null);
    },
    [
      activeItemId,
      bookFraction,
      bookMap,
      bookmarks,
      chapterLabel,
      commitBookmarks,
      hasChapters,
      highlightTarget,
      title,
    ],
  );

  /* ---------------- Rendering ---------------- */
  if (itemError) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <div className="mx-auto w-full max-w-3xl py-10">
          <BackButton fallbackTo="/home" className="mb-4" />
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={itemError}
          />
        </div>
      </main>
    );
  }

  if (!item) {
    return (
      <main
        className="seyirlik-reader-shell flex items-center justify-center"
        style={paletteVariables(palette)}
      >
        <LoadingSpinner label="" className="text-current opacity-70" />
      </main>
    );
  }

  if (!isReaderItem) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <div className="mx-auto w-full max-w-3xl py-10">
          <BackButton fallbackTo={ownerRoute} className="mb-4" />
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={t("reader.notBook")}
          />
        </div>
      </main>
    );
  }

  const glass = glassStyle(palette);
  const inkStyle: CSSProperties = { color: palette.ink };
  const activeItemStyle: CSSProperties = {
    backgroundColor: palette.ink,
    color: palette.ground,
  };
  const chapterNumber = currentChapter
    ? splitNumber(currentChapter.label).number
    : "";
  const nextChapter =
    bookMap && reading
      ? (bookMap.chapters[reading.chapterIndex + 1] ?? null)
      : null;
  const charted =
    format === "epub" &&
    epubReady &&
    currentChapter !== null &&
    reading !== null;
  const marginFits =
    charted &&
    columnBox !== null &&
    columnBox.viewport - columnBox.right >= MARGIN_ROOM;
  // The settings panel and the menu open over the right margin, and on a
  // phone the sheet opens over the foot.
  const marginCovered = panel === "settings" || panel === "more";
  const readingChapter = reading?.chapterIndex ?? -1;
  // A drag stays in the chapter it began in, whatever the reading line
  // crosses on the way.
  // A drag is relative, like a video's progress bar held anywhere: it starts
  // from where the reader is, and only how far the pointer moves up or down
  // says how far to go. A press alone goes nowhere.
  const seekRuler = (phase: RulerSeekPhase, delta: number) => {
    if (phase === "start") {
      rulerDragRef.current = readingChapter;
      rulerFractionRef.current = chapterFractionRef.current;
      return;
    }
    if (phase === "end") {
      rulerDragRef.current = -1;
      return;
    }
    // Wheel turns run together until they pause, as one drag would.
    if (phase === "wheel") {
      if (rulerDragRef.current < 0) {
        rulerDragRef.current = readingChapter;
        rulerFractionRef.current = chapterFractionRef.current;
      }
      window.clearTimeout(rulerWheelTimerRef.current);
      rulerWheelTimerRef.current = window.setTimeout(() => {
        rulerDragRef.current = -1;
      }, 250);
    }
    if (rulerDragRef.current < 0 || delta === 0) {
      return;
    }
    const fraction = clamp(rulerFractionRef.current + delta, 0, 1);
    rulerFractionRef.current = fraction;
    const marker = markerRef.current;
    if (marker) {
      marker.style.top = `${fraction * 100}%`;
      const label = marker.firstElementChild;
      if (label) {
        label.textContent = formatPercent(fraction, language);
      }
    }
    seekChapterRef.current(rulerDragRef.current, fraction);
  };
  const continueHere = async () => {
    setTakingBack("busy");
    try {
      await continueHereRef.current();
      setTakingBack("idle");
    } catch {
      // Not reachable: the notice stays, and asking again may work.
      setTakingBack("failed");
    }
  };
  const takenAtText = takenBy
    ? new Intl.DateTimeFormat(
        language,
        new Date(takenBy.openedAt).toDateString() === new Date().toDateString()
          ? { hour: "2-digit", minute: "2-digit" }
          : {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            },
      ).format(takenBy.openedAt)
    : "";
  const takenDevice = takenBy?.device
    ? READER_DEVICE_NAMES[takenBy.device]
    : t("reader.taken.anotherDevice");
  const timeLeftText = reading
    ? formatDuration(reading.minutesLeftInChapter, t)
    : "";
  // Without a margin (phones, narrow windows) the time left docks at the foot
  // of the screen and comes and goes with the bar; the ruler stays away.
  const timeLeftDocked =
    charted && !marginFits && settings.showTimeLeft && !marginCovered;
  const sizeLabel = formatFileSize(item.MediaSources?.[0]?.Size);

  const toolbarActions: SegmentedIconToolbarAction[] = [
    ...(format === "epub"
      ? [
          {
            id: "contents",
            type: "button" as const,
            label: t("reader.contents"),
            icon: <ListTree />,
            active: panel === "contents" && contentsTab !== "search",
            tooltip: panel !== "contents",
            onClick: () => {
              if (contentsTab === "search") {
                setContentsTab("contents");
                if (panel === "contents") return;
              }
              togglePanel("contents");
            },
          },
          {
            id: "search",
            type: "button" as const,
            label: t("reader.search.label"),
            icon: <Search />,
            active: panel === "contents" && contentsTab === "search",
            tooltip: !(panel === "contents" && contentsTab === "search"),
            onClick: () => {
              if (contentsTab !== "search") {
                setContentsTab("search");
                if (panel === "contents") return;
              }
              togglePanel("contents");
            },
          },
          {
            id: "bookmark",
            type: "button" as const,
            label: isBookmarked
              ? t("reader.removeBookmark")
              : t("reader.addBookmark"),
            icon: isBookmarked ? (
              <BookmarkCheck style={{ color: "var(--accent, #467a6c)" }} />
            ) : (
              <Bookmark />
            ),
            disabled: !currentCfi,
            className: "rd-bookmark-action",
            onClick: () => void toggleBookmark(),
          },
        ]
      : []),
    {
      id: "appearance",
      type: "button",
      label: t("reader.appearance"),
      icon: (
        <span className="rd-aa" aria-hidden="true">
          <span>A</span>
          <span>a</span>
        </span>
      ),
      active: panel === "settings",
      tooltip: panel !== "settings",
      onClick: () => togglePanel("settings"),
    },
    {
      id: "more",
      type: "button",
      label: t("reader.more"),
      icon: <MoreHorizontal />,
      active: panel === "more",
      tooltip: panel !== "more",
      onClick: () => togglePanel("more"),
    },
  ];

  const renderReaderContent = () => {
    if (readerError) {
      return (
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={readerError}
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }

    if (format === "epub") {
      return (
        <div className="seyirlik-epub-viewport absolute inset-0 overflow-hidden">
          <div
            className="rd-preparing"
            style={{ opacity: epubReady ? 0 : 1, pointerEvents: "none" }}
            aria-hidden={epubReady}
          >
            {coverUrl ? (
              <ReaderBookCover item={item} width={openingCoverWidth} />
            ) : (
              <LoadingSpinner label="" className="text-current opacity-70" />
            )}
            <p role="status">{t("reader.preparingBook")}</p>
          </div>
          <div
            ref={epubHostRef}
            className={`h-full w-full ${epubReady ? "seyirlik-reader-fade-in" : "opacity-0"}`}
          />
          <div className="rd-jumping" data-on={jumping || undefined}>
            <span className="rd-jumping-ring" />
          </div>
        </div>
      );
    }

    if (format === "pdf") {
      return (
        <iframe
          title={title}
          src={fileUrl}
          className="seyirlik-reader-fade-in absolute inset-0 h-full w-full border-0 bg-white pt-16"
        />
      );
    }

    if (format === "image") {
      return (
        <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center px-5 pb-10 pt-20 sm:px-8">
            <img
              src={fileUrl}
              alt={title}
              className="seyirlik-reader-fade-in max-h-[calc(100dvh-8rem)] max-w-full rounded-lg object-contain shadow-artwork-glow"
            />
          </div>
        </div>
      );
    }

    if (format === "html") {
      return textContent === null ? (
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner label="" className="text-current opacity-70" />
        </div>
      ) : (
        <iframe
          title={title}
          sandbox=""
          srcDoc={buildHtmlDocument(textContent, settings, palette)}
          className="seyirlik-reader-fade-in absolute inset-0 h-full w-full border-0"
          style={{ background: palette.ground }}
        />
      );
    }

    if (format === "text") {
      return (
        <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
          {textContent === null ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner label="" className="text-current opacity-70" />
            </div>
          ) : (
            <article
              className="rd-plain-text seyirlik-reader-fade-in mx-auto min-h-full px-5 pb-24 pt-20 sm:px-10"
              style={{
                maxWidth: `${settings.width}ch`,
                fontSize: `${settings.fontScale}%`,
                lineHeight: settings.lineHeight,
              }}
            >
              {getTextBlocks(textContent).map((block, index) => (
                <pre
                  key={`${index}-${block.slice(0, 24)}`}
                  className="m-0 mb-[1em] whitespace-pre-wrap break-words font-[inherit]"
                >
                  {block}
                </pre>
              ))}
            </article>
          )}
        </div>
      );
    }

    return (
      <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
        <div className="seyirlik-reader-fade-in mx-auto grid min-h-full w-full max-w-5xl items-center gap-8 px-5 pb-16 pt-24 md:grid-cols-[18rem_1fr]">
          {coverUrl ? (
            <ReaderBookCover
              item={item}
              width={288}
              className="justify-self-center md:justify-self-start"
            />
          ) : (
            <div
              className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-xl p-6 text-center text-xl font-black"
              style={{
                boxShadow: `0 0 0 1px ${palette.hair}`,
                background: palette.ink4,
              }}
            >
              {title}
            </div>
          )}
          <div>
            <p
              className="text-[0.6875rem] font-black uppercase tracking-[0.14em]"
              style={{ color: palette.ink3 }}
            >
              {getFormatLabel(format)}
            </p>
            <h1 className="mt-3 text-3xl font-black sm:text-5xl">
              {t("reader.unsupportedTitle")}
            </h1>
            <p
              className="mt-4 max-w-2xl text-base leading-7"
              style={{ color: palette.ink2 }}
            >
              {t("reader.unsupportedMessage")}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-black"
                style={activeItemStyle}
              >
                <ExternalLink size={17} />
                {t("reader.openOriginal")}
              </a>
              <a
                href={fileUrl}
                download
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-black"
                style={glass}
              >
                <Download size={17} />
                {t("reader.downloadBook")}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main
      className="seyirlik-reader-shell"
      data-chrome={chromeHidden && panel === null ? "hidden" : "shown"}
      style={paletteVariables(palette)}
      lang={language}
    >
      <div className="rd-stage">{renderReaderContent()}</div>

      <div className="rd-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${clamp(bookFraction, 0, 1)})` }} />
      </div>

      <div
        className="rd-hover-strip"
        onPointerEnter={showChrome}
        onPointerLeave={releaseBar}
        aria-hidden="true"
      />

      <header
        ref={barRef}
        className="rd-bar"
        onFocusCapture={showChrome}
        onPointerEnter={holdBar}
        onPointerLeave={releaseBar}
      >
        <div className="rd-bar-start">
          <BackButton
            fallbackTo={ownerRoute}
            className="shrink-0 p-[0.05rem]"
            style={glass}
            buttonStyle={inkStyle}
            label=""
            noYShift
          />
        </div>

        <div className="rd-titles" lang={bookMeta.language || undefined}>
          <h1 className="rd-title">{title}</h1>
          {bookMeta.author || chapterLabel ? (
            <div className="rd-subtitle">
              {bookMeta.author ? (
                <span className="rd-subtitle-author">{bookMeta.author}</span>
              ) : null}
              {bookMeta.author && chapterLabel ? (
                <i aria-hidden="true" />
              ) : null}
              {chapterLabel ? (
                <span>{splitNumber(chapterLabel).title}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rd-bar-end">
          <SegmentedIconToolbar
            actions={toolbarActions}
            ariaLabel={t("reader.settings")}
            size="md"
            style={glass}
            itemStyle={inkStyle}
            activeItemStyle={activeItemStyle}
            inactiveItemStyle={inkStyle}
            activeItemClassName="shadow-sm"
            inactiveItemClassName="hover:bg-[var(--rd-ink4)]"
          />
        </div>
      </header>

      {marginFits &&
      currentChapter &&
      (settings.showRuler || settings.showTimeLeft) ? (
        <ReaderMargin
          ref={attachMarker}
          chapter={currentChapter}
          next={nextChapter}
          chapterNumber={chapterNumber}
          covered={marginCovered}
          showRuler={settings.showRuler}
          timeLeft={settings.showTimeLeft ? timeLeftText : null}
          bookLanguage={bookMeta.language}
          onSeek={seekRuler}
        />
      ) : null}

      {timeLeftDocked ? (
        <div className="rd-timeleft" data-docked>
          {t("reader.toChapterEnd")} <b>≈ {timeLeftText}</b>
        </div>
      ) : null}

      <ReaderSettingsPanel
        ref={settingsPanelRef}
        open={panel === "settings"}
        settings={settings}
        showReadingLight={format === "epub"}
        onChange={updateSettings}
        onClose={closePanel}
      />

      <ReaderMoreMenu
        ref={menuRef}
        open={panel === "more"}
        fileUrl={fileUrl}
        downloadUrl={fileUrl}
        sizeLabel={
          sizeLabel ? `${getFormatLabel(format)} · ${sizeLabel}` : null
        }
        onClose={closePanel}
        finishedControl={
          <WatchedStatusButton
            scope="item"
            action={isCompleted ? "remove" : "mark"}
            item={item}
            showLabel
            iconSize={18}
            icon={<BookCheck size={18} />}
            label={
              isCompleted
                ? t("reader.markUnfinished")
                : t("reader.markFinished")
            }
            className="rd-menu-item"
            onReset={(items) => {
              const updated = items.find((changed) => changed.Id === item.Id);
              if (updated) {
                setItem(updated);
              }
            }}
          />
        }
      />

      {format === "epub" ? (
        <ReaderHighlightMenu
          ref={highlightMenuRef}
          open={highlightTarget !== null && panel === null}
          current={highlightColor}
          onPick={pickHighlightColor}
          onRemove={
            highlightTarget?.kind === "highlight"
              ? () => {
                  removeBookmark(highlightTarget.id);
                  setHighlightTarget(null);
                }
              : null
          }
        />
      ) : null}

      {format === "epub" ? (
        <ReaderContentsDrawer
          open={panel === "contents"}
          tab={contentsTab}
          onTab={setContentsTab}
          title={title}
          author={bookMeta.author}
          item={item}
          toc={toc}
          map={bookMap}
          location={reading?.location ?? null}
          currentHref={currentHref}
          bookmarks={bookmarks}
          scheme={palette.scheme}
          spineIndexOf={spineIndexOf}
          onNavigate={navigateTo}
          onShowPassage={showPassage}
          onRemoveBookmark={removeBookmark}
          onClose={closePanel}
        />
      ) : null}

      {takenBy ? (
        <div
          className="rd-taken"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rd-taken-title"
          aria-describedby="rd-taken-text"
        >
          <div className="rd-taken-card">
            <h2 id="rd-taken-title">{t("reader.taken.title")}</h2>
            <p className="rd-taken-where">
              {takenDevice} · {takenAtText}
            </p>
            <p id="rd-taken-text">{t("reader.taken.text")}</p>
            <div className="rd-taken-actions">
              <button
                type="button"
                className="rd-taken-continue"
                autoFocus
                disabled={takingBack === "busy"}
                onClick={() => void continueHere()}
              >
                {t("reader.taken.continue")}
              </button>
              <BackButton fallbackTo={ownerRoute} noYShift />
            </div>
            {takingBack === "failed" ? (
              <p className="rd-taken-failed" role="status">
                {t("reader.taken.failed")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {zoomedImage ? (
        <ReaderImageViewer
          image={zoomedImage}
          label={t("reader.image")}
          closeLabel={t("reader.closeImage")}
          onClosed={() => setZoomedImage(null)}
        />
      ) : null}
    </main>
  );
}
