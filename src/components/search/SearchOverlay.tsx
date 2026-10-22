import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../../lib/searchModel";
import type { MediaItem } from "../../lib/types";
import { SlidingIndicator } from "../ui/SlidingIndicator";

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
 * The logo laid over a poster, honouring the placement stored by the artwork
 * editor. The layout is expressed in fractions of the artwork, so the same
 * numbers that position it on a full-size card also position it here.
 */
function ResultLogo({ item, logoUrl }: { item: MediaItem; logoUrl: string }) {
  const logoLayout = getLogoLayout(item);
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
          className="mb-1.5 h-auto max-h-[42%] w-auto max-w-[82%] object-contain"
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
            className="block h-auto w-full object-contain"
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
}: {
  item: MediaItem;
  language: Language;
}) {
  const { shape, imageUrl, logoUrl } = getMediaArtwork(item, language, {
    posterWidth: 240,
    stillWidth: 440,
    logoWidth: 320,
  });
  const isStill = shape === "still";

  return (
    <span
      className={`relative block shrink-0 overflow-hidden rounded-lg bg-white/[0.06] ${
        isStill ? "aspect-video w-28 sm:w-36" : "aspect-[2/3] w-14 sm:w-16"
      }`}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 bg-[linear-gradient(145deg,#27272a,#09090b)]" />
      )}

      {logoUrl && !isStill ? (
        <ResultLogo item={item} logoUrl={logoUrl} />
      ) : null}
    </span>
  );
}

export function SearchOverlay({ isOpen, onClose }: SearchOverlayProps) {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  // Guards against a slow request for an old query overwriting a newer one.
  const requestSequenceRef = useRef(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<MediaItem[]>([]);
  const [suggestions, setSuggestions] = useState<MediaItem[]>([]);
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
      .catch(() => undefined);

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

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % flatResults.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + flatResults.length) % flatResults.length,
      );
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
    const activeElement = listRef.current?.querySelector<HTMLElement>(
      '[data-search-active="true"]',
    );

    // Guarded because scrollIntoView is absent in non-browser DOMs.
    if (typeof activeElement?.scrollIntoView === "function") {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  if (typeof document === "undefined") {
    return null;
  }

  // Position of each result in keyboard order, across groups.
  const flatIndexById = new Map(
    flatResults.map((item, index) => [item.Id, index]),
  );
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
                onChange={(event) => setQuery(event.target.value)}
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
              {!hasQuery && flatResults.length === 0 ? (
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
                <div ref={resultsRef} className="relative">
                  {/* One highlight that follows the arrow keys from row to row. */}
                  <SlidingIndicator
                    containerRef={resultsRef}
                    activeSelector='[data-search-active="true"]'
                    measureKey={`${activeIndex}:${flatResults.length}:${query}`}
                    className="rounded-xl bg-white/[0.12]"
                  />
                  {groups.map((group) => (
                    <div key={group.id} className="relative mb-2 last:mb-0">
                      <p className="px-3 py-2 text-[0.68rem] font-black uppercase tracking-[0.16em] text-[var(--accent)]">
                        {t(group.labelKey)}
                      </p>

                      <ul className="space-y-1">
                        {group.items.map((item) => {
                          const flatIndex = flatIndexById.get(item.Id) ?? 0;
                          const isActive = flatIndex === activeIndex;
                          const subtitle = getResultSubtitle(item);
                          // A list arriving as a list: capped, so the twelfth row
                          // is not still waiting after the first has been read.
                          const delay = Math.min(flatIndex * 0.024, 0.2);

                          return (
                            <motion.li
                              key={item.Id}
                              initial={
                                shouldReduceMotion
                                  ? { opacity: 0 }
                                  : { opacity: 0, transform: move({ y: 8 }) }
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
                              <button
                                type="button"
                                data-search-active={
                                  isActive ? "true" : undefined
                                }
                                onClick={() => openResult(item)}
                                className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
                                  isActive ? "" : "hover:bg-white/[0.08]"
                                }`}
                              >
                                <ResultArtwork
                                  item={item}
                                  language={language}
                                />

                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                            </motion.li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
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
