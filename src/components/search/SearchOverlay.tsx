import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "framer-motion";
import { move, REST, settle } from "../../lib/compositorMotion";
import { Loader2, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import type { Language } from "../../i18n/translations";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import { getItemDisplayMetadata } from "../../lib/itemMetadataPreferences";
import { formatTemplate } from "../../lib/format";
import {
  DEFAULT_LOGO_SHADOW,
  getLogoLayout,
  getLogoLayoutStyle,
  getLogoShadowBackdropStyle,
  getLogoShadowFrameStyle,
  getLogoShadowReach,
} from "../../lib/logoLayout";
import { getMediaArtwork } from "../../lib/mediaArtwork";
import { getLatestMediaItems, searchItems } from "../../lib/mediaApi";
import { getRouteForItem } from "../../lib/routes";
import {
  SEARCH_DEBOUNCE_MS,
  flattenSearchGroups,
  groupSearchResults,
  isSearchableQuery,
  type SearchGroup,
  type SearchGroupId,
} from "../../lib/searchModel";
import type { MediaItem } from "../../lib/types";

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

type SearchStatus = "idle" | "loading" | "ready" | "failed";

/** Enough to fill the panel without turning the overlay into a browse page. */
const SUGGESTION_COUNT = 12;

/** Prefers the viewer's language, the way cards and detail pages do. */
function getResultTitle(item: MediaItem, language: Language): string {
  const localizedTitle =
    item.Type === "Episode"
      ? getEpisodeDisplayMetadata(item, language).title
      : getItemDisplayMetadata(item, language).title;

  return localizedTitle ?? item.Name ?? "";
}

function getResultSubtitle(item: MediaItem): string {
  if (item.Type === "Episode") {
    const seasonNumber = item.ParentIndexNumber;
    const episodeNumber = item.IndexNumber;
    const numbering =
      typeof seasonNumber === "number" && typeof episodeNumber === "number"
        ? `S${seasonNumber}·E${episodeNumber}`
        : null;

    return [item.SeriesName, numbering].filter(Boolean).join(" · ");
  }

  return item.ProductionYear ? String(item.ProductionYear) : "";
}

/**
 * The artwork tile's frame: 16:9 for an episode still, 2:3 for a poster. On a
 * shelf every tile is a poster, large enough for its logo to be read.
 */
function tileSize(isStill: boolean, onShelf = false): string {
  if (onShelf) return "aspect-[2/3] w-28 sm:w-[8.5rem]";
  return isStill ? "aspect-video w-28 sm:w-36" : "aspect-[2/3] w-14 sm:w-16";
}

/**
 * Titles (films, series, books) sit side by side on a shelf, the way a console
 * shelves them; episodes stay rows, since a still needs its words beside it.
 */
function isShelfGroup(group: SearchGroup): boolean {
  return group.items.every((item) => item.Type !== "Episode");
}

// Focus pops in place with a touch of overshoot and lets go faster than it
// arrived; nothing travels between results.
const FOCUS_IN = "220ms cubic-bezier(0.2, 0.9, 0.25, 1.18)";
const FOCUS_OUT = "140ms cubic-bezier(0.4, 0, 1, 1)";

function focusTransition(active: boolean): string {
  return active
    ? `transform ${FOCUS_IN}, opacity 160ms ease-out`
    : `transform ${FOCUS_OUT}, opacity ${FOCUS_OUT}`;
}

/**
 * The focused artwork grows toward the viewer, outlined with a gap and lifted
 * off the panel by a dark shadow. Transform and opacity only, so the
 * compositor plays it.
 */
function FocusLift({
  active,
  origin,
  scale,
  children,
}: {
  active: boolean;
  origin: string;
  scale: number;
  children: ReactNode;
}) {
  const layer = {
    opacity: active ? 1 : 0,
    transition: focusTransition(active),
  };
  return (
    <span
      className="relative block shrink-0 motion-reduce:!transition-none"
      style={{
        transformOrigin: origin,
        transform: active ? `scale(${scale})` : "scale(1)",
        transition: focusTransition(active),
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-lg shadow-[0_10px_24px_rgba(0,0,0,0.7)]"
        style={layer}
      />
      <span
        aria-hidden="true"
        data-search-focus-ring="true"
        className="pointer-events-none absolute -inset-[4px] rounded-[0.7rem] border-2 border-white"
        style={layer}
      />
      {children}
    </span>
  );
}

/**
 * The focused title's whole name, under its shelf, where it never has to be
 * cut short to fit a poster's width. When focus is elsewhere the shelf keeps
 * naming, dimmed, the title focus will return to, so it never sits blank.
 */
function ShelfCaption({
  item,
  resting,
  language,
}: {
  item: MediaItem | undefined;
  resting: boolean;
  language: Language;
}) {
  const subtitle = item ? getResultSubtitle(item) : "";
  return (
    <div aria-hidden="true" className="min-h-[2.25rem] px-3 pb-1">
      {item ? (
        <p
          key={item.Id}
          data-resting={resting ? "true" : undefined}
          className="search-caption-in flex flex-wrap items-baseline gap-x-2.5 text-base font-black leading-snug text-white transition-opacity duration-200 motion-reduce:transition-none"
          style={{ opacity: resting ? 0.4 : 1 }}
        >
          <span>{getResultTitle(item, language)}</span>
          {subtitle ? (
            <span className="text-[0.7rem] font-bold uppercase tracking-[0.1em] text-white/45">
              {subtitle}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Words beside a lifted still step aside with it; resting ones recede. */
function focusTextStyle(active: boolean, shift: number): CSSProperties {
  return {
    transform: active ? `translateX(${shift}px)` : "translateX(0)",
    opacity: active ? 1 : 0.72,
    transition: focusTransition(active),
  };
}

/** An image that arrives fades in over its placeholder rather than popping. */
function fadeIn(done: boolean): string {
  return `transition-opacity duration-300 motion-reduce:transition-none ${
    done ? "opacity-100" : "opacity-0"
  }`;
}

/**
 * Whether an image has arrived. React listens for `load` before it sets
 * `src`, so an image the browser already holds reports in too.
 */
function useImageLoaded() {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  return {
    done,
    failed,
    onLoad: () => setDone(true),
    onError: () => setFailed(true),
  };
}

/**
 * Rows standing where results will be, while the first ones are on their way:
 * the panel keeps its shape instead of sitting empty under a spinner.
 */
function ResultsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="px-1">
      <span
        aria-hidden="true"
        className="shimmer mx-2 mb-3 mt-2 block h-2.5 w-16 rounded-full"
      />
      {/* Titles land on a shelf first, so the skeleton is one. */}
      <ul
        aria-hidden="true"
        className="-mx-3 flex gap-4 overflow-hidden px-5 pb-3 pt-7"
      >
        {[0, 1, 2, 3, 4].map((index) => (
          <li
            key={index}
            className={`shimmer block shrink-0 rounded-lg ${tileSize(false, true)}`}
          />
        ))}
      </ul>
      <span
        aria-hidden="true"
        className="shimmer mx-2 mb-3 block h-3.5 w-48 rounded-full"
      />
    </div>
  );
}

/**
 * The logo laid over a poster, honouring the placement stored by the artwork
 * editor. The layout is expressed in fractions of the artwork, so the same
 * numbers that position it on a full-size card also position it here.
 */
function ResultLogo({
  item,
  logoUrl,
  posterShown,
}: {
  item: MediaItem;
  logoUrl: string;
  /** A logo over a tile still shimmering would float on nothing. */
  posterShown: boolean;
}) {
  const logoLayout = getLogoLayout(item);
  const loaded = useImageLoaded();
  const logoShadowFrame = getLogoShadowFrameStyle(
    logoLayout?.shadow ?? DEFAULT_LOGO_SHADOW,
  );

  if (!logoLayout) {
    // Never adjusted, so it sits where an untouched card draws it.
    return (
      <span
        data-logo-shadow="true"
        style={logoShadowFrame}
        className="pointer-events-none absolute inset-0 flex items-end justify-center"
      >
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          onLoad={loaded.onLoad}
          className={`mb-1.5 h-auto max-h-[42%] w-auto max-w-[82%] object-contain ${fadeIn(loaded.done && posterShown)}`}
        />
      </span>
    );
  }

  const logoShadowBackdropStyle = getLogoShadowBackdropStyle(logoLayout.shadow);

  return (
    <span
      data-logo-layout="true"
      style={getLogoLayoutStyle(
        logoLayout,
        getLogoShadowReach(logoLayout.shadow),
      )}
      className="pointer-events-none absolute block"
    >
      <span className="relative flow-root">
        {logoShadowBackdropStyle ? (
          <span
            aria-hidden="true"
            data-logo-shadow-backdrop="true"
            style={logoShadowBackdropStyle}
            className="absolute inset-[6%] rounded-[45%]"
          />
        ) : null}
        <span
          data-logo-shadow="true"
          style={logoShadowFrame}
          className="relative block"
        >
          <img
            src={logoUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            onLoad={loaded.onLoad}
            className={`block h-auto w-full object-contain ${fadeIn(loaded.done && posterShown)}`}
          />
        </span>
      </span>
    </span>
  );
}

/**
 * The artwork tile, composed the way a media card composes it.
 *
 * Episodes get a 16:9 frame so the still is not cropped into a poster shape it
 * was never framed for, and no logo: the series wordmark says nothing about
 * which episode this is, and the title sits right beside it anyway.
 */
function ResultArtwork({
  item,
  language,
  onShelf = false,
}: {
  item: MediaItem;
  language: Language;
  onShelf?: boolean;
}) {
  const { shape, imageUrl, logoUrl } = getMediaArtwork(item, language, {
    posterWidth: onShelf ? 360 : 240,
    stillWidth: 440,
    logoWidth: 320,
  });
  const isStill = shape === "still";
  const image = useImageLoaded();
  const waiting = Boolean(imageUrl) && !image.done && !image.failed;

  return (
    <span
      className={`relative block shrink-0 overflow-hidden rounded-lg bg-white/[0.06] ${tileSize(
        isStill,
        onShelf,
      )}`}
    >
      {waiting ? (
        <span aria-hidden="true" className="shimmer absolute inset-0" />
      ) : null}
      {imageUrl && !image.failed ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={image.onLoad}
          onError={image.onError}
          className={`absolute inset-0 h-full w-full object-cover ${fadeIn(image.done)}`}
        />
      ) : (
        <span className="absolute inset-0 bg-[linear-gradient(145deg,#27272a,#09090b)]" />
      )}

      {logoUrl && (onShelf || !isStill) ? (
        <ResultLogo item={item} logoUrl={logoUrl} posterShown={!waiting} />
      ) : null}
    </span>
  );
}

export function SearchOverlay({ isOpen, onClose }: SearchOverlayProps) {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  // Guards against a slow request for an old query overwriting a newer one.
  const requestSequenceRef = useRef(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<MediaItem[]>([]);
  const [suggestions, setSuggestions] = useState<MediaItem[]>([]);
  // Settled once the first read of suggestions answers, either way.
  const [suggestionsSettled, setSuggestionsSettled] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const hasQuery = isSearchableQuery(query);

  // Before anything is typed the overlay is a shortcut into the library rather
  // than an empty box, so recently added titles stand in for results. They stay
  // one list: splitting a dozen suggestions by kind is noise, not structure.
  const groups: SearchGroup[] = useMemo(() => {
    if (hasQuery) return groupSearchResults(results);

    return suggestions.length > 0
      ? [{ id: "other", labelKey: "search.suggestions", items: suggestions }]
      : [];
  }, [hasQuery, results, suggestions]);
  const flatResults = useMemo(() => flattenSearchGroups(groups), [groups]);
  // Position of each result in keyboard order, across groups.
  const flatIndexById = useMemo(
    () => new Map(flatResults.map((item, index) => [item.Id, index])),
    [flatResults],
  );
  // Keyboard rows in flat-index terms: a shelf is one row, each episode its own.
  const rows = useMemo(() => {
    const out: { shelf?: SearchGroup; indices: number[] }[] = [];
    let index = 0;
    for (const group of groups) {
      if (isShelfGroup(group)) {
        out.push({ shelf: group, indices: group.items.map(() => index++) });
      } else {
        for (let i = 0; i < group.items.length; i++) {
          out.push({ indices: [index++] });
        }
      }
    }
    return out;
  }, [groups]);
  // The title focus last stood on in each shelf: stepping back onto the shelf
  // returns there, and the shelf's caption names it while focus is away.
  const [shelfPlaces, setShelfPlaces] = useState<
    Partial<Record<SearchGroupId, string>>
  >({});
  // Left/Right move the caret until the person starts moving through results.
  const browsingRef = useRef(false);
  // Only keyboard moves scroll the list; a pointer is already where it looks.
  const pointerFocusRef = useRef(false);

  /** Where a shelf stands: its remembered title if still on it, else its first. */
  const shelfPlace = (shelf: SearchGroup): MediaItem | undefined => {
    const id = shelfPlaces[shelf.id];
    return shelf.items.find((entry) => entry.Id === id) ?? shelf.items[0];
  };

  /** Moves focus, and remembers it as its shelf's place when it is on one. */
  const focusResult = (index: number) => {
    setActiveIndex(index);
    const item = flatResults[index];
    const shelf = groups.find(
      (group) => isShelfGroup(group) && item && group.items.includes(item),
    );
    if (shelf && item) {
      setShelfPlaces((places) =>
        places[shelf.id] === item.Id
          ? places
          : { ...places, [shelf.id]: item.Id },
      );
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setQuery("");
    setResults([]);
    setStatus("idle");
    setActiveIndex(0);

    // The input mounts with the overlay, so focus has to wait for paint.
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || suggestions.length > 0) {
      return;
    }

    let isMounted = true;

    void getLatestMediaItems()
      .then((items) => {
        if (isMounted) setSuggestions(items.slice(0, SUGGESTION_COUNT));
      })
      // Suggestions are a convenience. Losing them leaves an empty box, which
      // is exactly what the overlay looked like before, so there is nothing to
      // report to the user.
      .catch(() => undefined)
      .finally(() => {
        if (isMounted) setSuggestionsSettled(true);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, suggestions.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!isSearchableQuery(query)) {
      requestSequenceRef.current += 1;
      setResults([]);
      setStatus("idle");
      return;
    }

    const sequence = ++requestSequenceRef.current;
    setStatus("loading");

    const timeoutId = window.setTimeout(() => {
      void searchItems(query.trim())
        .then((items) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }

          setResults(items);
          setActiveIndex(0);
          setStatus("ready");
        })
        .catch((error: unknown) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }

          console.warn("[Seyirlik Search] Search failed", error);
          setResults([]);
          setStatus("failed");
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isOpen, query]);

  const openResult = useCallback(
    (item: MediaItem) => {
      onClose();
      navigate(getRouteForItem(item));
    },
    [navigate, onClose],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (flatResults.length === 0) {
      return;
    }

    const rowIndex = Math.max(
      0,
      rows.findIndex((row) => row.indices.includes(activeIndex)),
    );
    const row = rows[rowIndex]?.indices ?? [];

    const focus = (index: number) => {
      pointerFocusRef.current = false;
      focusResult(index);
    };

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      browsingRef.current = true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = rows[(rowIndex + step + rows.length) % rows.length];
      const place = next.shelf ? shelfPlace(next.shelf) : undefined;
      focus(
        place
          ? (flatIndexById.get(place.Id) ?? next.indices[0])
          : next.indices[0],
      );
      return;
    }

    if (
      (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
      row.length > 1
    ) {
      const input = event.target as HTMLInputElement;
      const caretAtEnd =
        input.value === undefined ||
        (input.selectionStart === input.value.length &&
          input.selectionEnd === input.value.length);
      // Right at the end of the text has nothing to move, so it starts browsing.
      if (!browsingRef.current && !(event.key === "ArrowRight" && caretAtEnd)) {
        return;
      }
      event.preventDefault();
      browsingRef.current = true;
      const place = row.indexOf(activeIndex);
      const next = row[place + (event.key === "ArrowRight" ? 1 : -1)];
      if (next !== undefined) focus(next);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const item = flatResults[activeIndex];

      if (item) {
        openResult(item);
      }
    }
  };

  useEffect(() => {
    if (pointerFocusRef.current) return;
    const activeElement = listRef.current?.querySelector<HTMLElement>(
      '[data-search-active="true"]',
    );

    // Guarded because scrollIntoView is absent in non-browser DOMs.
    if (typeof activeElement?.scrollIntoView === "function") {
      // Each result carries a scroll margin as deep as its neighbour, so the
      // list moves while there is still one more result in view past focus:
      // what comes next is always visible before it is reached.
      activeElement.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: shouldReduceMotion ? "auto" : "smooth",
      });
    }
  }, [activeIndex, shouldReduceMotion]);

  if (typeof document === "undefined") {
    return null;
  }

  // The panel drops from where the search control lives, and leaves faster
  // than it arrived; with reduced motion it only fades.
  const panelMotion: HTMLMotionProps<"div"> = shouldReduceMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        initial: { opacity: 0, transform: move({ y: -18, scale: 0.97 }) },
        animate: {
          opacity: 1,
          ...settle,
          transition: { type: "spring", bounce: 0, duration: 0.38 },
        },
        exit: {
          opacity: 0,
          transform: [REST, move({ y: -10, scale: 0.985 })],
          transition: { duration: 0.14, ease: [0.4, 0, 1, 1] as const },
        },
      };

  return createPortal(
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          key="search-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.16, delay: 0.04 } }}
          role="dialog"
          aria-modal="true"
          aria-label={t("search.title")}
          onKeyDown={handleKeyDown}
          className="fixed inset-0 z-[200] flex justify-center bg-black/72 p-4 pt-[max(env(safe-area-inset-top),4rem)] backdrop-brightness-90"
        >
          {/*
        A sibling backdrop button rather than a click handler on the dialog, so
        clicking away is reachable by pointer without swallowing keyboard focus
        or making the dialog itself a control.
      */}
          <button
            type="button"
            aria-label={t("search.close")}
            onClick={onClose}
            className="absolute inset-0 z-0 cursor-default"
          />

          <motion.div
            {...panelMotion}
            style={{ transformOrigin: "50% 0%" }}
            className="relative z-10 flex h-fit max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.97)] shadow-[0_32px_120px_rgba(0,0,0,0.75)]"
          >
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <Search size={18} className="shrink-0 text-white/45" />

              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(event) => {
                  browsingRef.current = false;
                  setQuery(event.target.value);
                }}
                placeholder={t("search.placeholder")}
                aria-label={t("search.placeholder")}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-base font-semibold text-white outline-none placeholder:font-medium placeholder:text-white/35 [&::-webkit-search-cancel-button]:hidden"
              />

              <AnimatePresence initial={false}>
                {status === "loading" ? (
                  <motion.span
                    key="search-loading"
                    initial={{ opacity: 0, transform: move({ scale: 0.6 }) }}
                    animate={{ opacity: 1, ...settle }}
                    exit={{
                      opacity: 0,
                      transform: [REST, move({ scale: 0.6 })],
                    }}
                    transition={{ duration: 0.16 }}
                    className="flex shrink-0"
                  >
                    <Loader2 size={16} className="animate-spin text-white/45" />
                  </motion.span>
                ) : null}
              </AnimatePresence>

              <button
                type="button"
                onClick={onClose}
                aria-label={t("search.close")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
              >
                <X size={17} />
              </button>
            </div>

            <div
              ref={listRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
            >
              {flatResults.length === 0 &&
              (hasQuery ? status === "loading" : !suggestionsSettled) ? (
                <ResultsSkeleton label={t("search.searching")} />
              ) : !hasQuery && flatResults.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm font-semibold text-white/45">
                  {t("search.hint")}
                </p>
              ) : hasQuery && status === "failed" ? (
                <p className="px-3 py-8 text-center text-sm font-semibold text-rose-300">
                  {t("search.failed")}
                </p>
              ) : hasQuery && flatResults.length === 0 && status === "ready" ? (
                <p className="px-3 py-8 text-center text-sm font-semibold text-white/45">
                  {formatTemplate(t("search.noResults"), {
                    query: query.trim(),
                  })}
                </p>
              ) : (
                <div className="relative">
                  {groups.map((group) => {
                    const onShelf = isShelfGroup(group);
                    return (
                      <div key={group.id} className="relative mb-2 last:mb-0">
                        <p className="px-3 py-2 text-[0.68rem] font-black uppercase tracking-[0.16em] text-[var(--accent)]">
                          {t(group.labelKey)}
                        </p>

                        <ul
                          className={
                            onShelf
                              ? // Edge to edge, with room above for a lifted poster.
                                "-mx-2 flex gap-4 overflow-x-auto overscroll-x-contain px-5 pb-3 pt-4 scrollbar-none"
                              : "space-y-1"
                          }
                        >
                          {group.items.map((item) => {
                            const flatIndex = flatIndexById.get(item.Id) ?? 0;
                            const isActive = flatIndex === activeIndex;
                            const subtitle = getResultSubtitle(item);
                            // A list arriving as a list: capped, so the twelfth
                            // result is not still waiting after the first has
                            // been read.
                            const delay = Math.min(flatIndex * 0.024, 0.2);
                            const takeFocus = () => {
                              browsingRef.current = true;
                              if (isActive) return;
                              pointerFocusRef.current = true;
                              focusResult(flatIndex);
                            };

                            return (
                              <motion.li
                                key={item.Id}
                                className={onShelf ? "shrink-0" : undefined}
                                initial={
                                  shouldReduceMotion
                                    ? { opacity: 0 }
                                    : {
                                        opacity: 0,
                                        transform: move(
                                          onShelf ? { x: 12 } : { y: 8 },
                                        ),
                                      }
                                }
                                animate={{
                                  opacity: 1,
                                  ...(shouldReduceMotion ? {} : settle),
                                  transition: {
                                    duration: 0.26,
                                    delay,
                                    ease: [0.22, 1, 0.36, 1],
                                  },
                                }}
                              >
                                {onShelf ? (
                                  <button
                                    type="button"
                                    data-search-active={
                                      isActive ? "true" : undefined
                                    }
                                    data-search-shelf="true"
                                    onClick={() => openResult(item)}
                                    onPointerMove={takeFocus}
                                    className="block w-28 scroll-mx-28 scroll-mb-32 scroll-mt-12 rounded-lg pt-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:w-[8.5rem]"
                                  >
                                    <FocusLift
                                      active={isActive}
                                      origin="50% 100%"
                                      scale={1.08}
                                    >
                                      <ResultArtwork
                                        item={item}
                                        language={language}
                                        onShelf
                                      />
                                    </FocusLift>
                                    {/* The poster and its logo name the title; the full name is read out here and shown under the shelf. */}
                                    <span className="sr-only">
                                      {[
                                        getResultTitle(item, language),
                                        subtitle,
                                      ]
                                        .filter(Boolean)
                                        .join(", ")}
                                    </span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    data-search-active={
                                      isActive ? "true" : undefined
                                    }
                                    onClick={() => openResult(item)}
                                    onPointerMove={takeFocus}
                                    className="relative flex w-full scroll-my-24 items-center gap-3 rounded-xl px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                                  >
                                    <FocusLift
                                      active={isActive}
                                      origin="0% 50%"
                                      scale={1.1}
                                    >
                                      <ResultArtwork
                                        item={item}
                                        language={language}
                                      />
                                    </FocusLift>

                                    <span
                                      className="relative flex min-w-0 flex-1 flex-col gap-0.5"
                                      style={focusTextStyle(isActive, 14)}
                                    >
                                      <span className="truncate text-sm font-black text-white sm:text-base">
                                        {getResultTitle(item, language)}
                                      </span>
                                      {subtitle ? (
                                        <span className="truncate text-[0.7rem] font-bold uppercase tracking-[0.1em] text-white/45">
                                          {subtitle}
                                        </span>
                                      ) : null}
                                    </span>
                                  </button>
                                )}
                              </motion.li>
                            );
                          })}
                        </ul>

                        {onShelf ? (
                          <ShelfCaption
                            item={
                              group.items.find(
                                (entry) =>
                                  flatIndexById.get(entry.Id) === activeIndex,
                              ) ?? shelfPlace(group)
                            }
                            resting={
                              !group.items.some(
                                (entry) =>
                                  flatIndexById.get(entry.Id) === activeIndex,
                              )
                            }
                            language={language}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
