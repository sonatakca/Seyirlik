import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Download, ExternalLink, Trash2, X } from "lucide-react";
import type { NavItem } from "epubjs";
import { TitlePoster } from "../../components/admin/TitlePoster";
import { useLanguage } from "../../i18n/LanguageContext";
import { getLogoLayout } from "../../lib/logoLayout";
import type { MediaItem } from "../../lib/types";
import { BOOK_SANS, BOOK_SERIF } from "./epubTypography";
import { formatDuration, formatPercent, splitNumber } from "./readerText";
import { ReaderSearch } from "./ReaderSearch";
import type { BookSearchFound, BookSearchHit } from "../../lib/bookSearchApi";
import {
  FONT_SCALE_STEPS,
  HIGHLIGHT_COLORS,
  LINE_HEIGHT_PRESETS,
  LINE_REACH_PRESETS,
  PARAGRAPH_REACH_PRESETS,
  READER_LIGHT_SHAPES,
  READER_SPOTLIGHTS,
  READER_THEMES,
  READER_THEME_LABEL_KEYS,
  WIDTH_PRESETS,
  highlightSwatch,
  highlightWash,
  isHighlight,
  minutesForLocations,
  nearest,
  themePalettes,
  type HighlightColor,
  type ReaderBookmark,
  type ReaderSettings,
} from "./readerModel";
import type { BookChapter, BookMap } from "./readingLight";

function SegmentButtons<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="rd-seg">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          disabled={disabled}
          aria-pressed={option.value === value}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  );
}

function LinesIcon({ gaps }: { gaps: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={`M5 ${12 - gaps}h14M5 12h14M5 ${12 + gaps}h14`} />
    </svg>
  );
}

function MeasureIcon({ half }: { half: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path
        d={`M${12 - half} 7h${half * 2}M${12 - half} 12h${half * 2}M${12 - half} 17h${half * 2}`}
      />
    </svg>
  );
}

/** Five rules, the middle one lit, the others dimmed as far as the reach would leave them. */
function ReachIcon({ step }: { step: number }) {
  const spread = [0.6, 0.9, 1.3, 1.8, 2.6, 4, 8][step];

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {[-2, -1, 0, 1, 2].map((offset) => (
        <path
          key={offset}
          d={`M5 ${12 + offset * 4}h14`}
          strokeOpacity={1 - 0.8 * Math.min(1, Math.abs(offset) / spread)}
        />
      ))}
    </svg>
  );
}

export const ReaderSettingsPanel = forwardRef<
  HTMLElement,
  {
    open: boolean;
    settings: ReaderSettings;
    showReadingLight: boolean;
    onChange: (patch: Partial<ReaderSettings>) => void;
    onClose: () => void;
  }
>(function ReaderSettingsPanel(
  { open, settings, showReadingLight, onChange, onClose },
  ref,
) {
  const { t, language } = useLanguage();
  const sheetRef = useRef<HTMLElement | null>(null);
  const grabDrag = useSheetDrag(sheetRef, onClose);
  const lightOff = settings.spotlight === "off";
  const reachPresets =
    settings.lightShape === "line"
      ? LINE_REACH_PRESETS
      : PARAGRAPH_REACH_PRESETS;
  const reach =
    settings.lightShape === "line"
      ? settings.lineReach
      : settings.paragraphReach;
  const sizeIndex = FONT_SCALE_STEPS.indexOf(
    nearest(FONT_SCALE_STEPS, settings.fontScale),
  );
  const sizePercent = (sizeIndex / (FONT_SCALE_STEPS.length - 1)) * 100;

  return (
    <>
      {/* Phones only: the sheet covers most of the page, so a tap on what
          is left of it closes the sheet, as the contents drawer's does. */}
      <div
        className="rd-scrim rd-sheet-scrim"
        data-open={open || undefined}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        ref={(node) => {
          sheetRef.current = node;
          if (typeof ref === "function") {
            ref(node);
          } else if (ref) {
            ref.current = node;
          }
        }}
        role="dialog"
        aria-label={t("reader.appearance")}
        aria-hidden={!open}
        data-open={open || undefined}
        className="rd-surface rd-popover rd-settings"
      >
        <div className="rd-grab-zone" aria-hidden="true" {...grabDrag}>
          <div className="rd-grab" />
        </div>
        <div className="rd-settings-body">
          <div className="rd-row">
            <p className="rd-label">{t("reader.theme")}</p>
            <div
              className="rd-themes"
              role="group"
              aria-label={t("reader.theme")}
            >
              {READER_THEMES.map((theme) => {
                const palette = themePalettes[theme];

                return (
                  <button
                    key={theme}
                    type="button"
                    className="rd-theme"
                    aria-pressed={settings.theme === theme}
                    onClick={() => onChange({ theme })}
                  >
                    <span
                      className="rd-theme-swatch"
                      style={{ background: palette.ground, color: palette.ink }}
                      aria-hidden="true"
                    >
                      Aa
                    </span>
                    <span className="rd-theme-name">
                      {t(READER_THEME_LABEL_KEYS[theme])}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rd-row">
            <p className="rd-label">{t("reader.typeface")}</p>
            <div
              className="rd-faces"
              role="group"
              aria-label={t("reader.typeface")}
            >
              {(
                [
                  [
                    "serif",
                    "Literata",
                    t("reader.face.serifNote"),
                    BOOK_SERIF,
                    450,
                  ],
                  [
                    "sans",
                    "Archivo",
                    t("reader.face.sansNote"),
                    BOOK_SANS,
                    650,
                  ],
                ] as const
              ).map(([face, name, note, family, weight]) => (
                <button
                  key={face}
                  type="button"
                  className="rd-face"
                  aria-pressed={settings.face === face}
                  onClick={() => onChange({ face })}
                >
                  <span
                    className="rd-face-sample"
                    style={{ fontFamily: family, fontWeight: weight }}
                    aria-hidden="true"
                  >
                    Ağ
                  </span>
                  <span className="rd-face-name">{name}</span>
                  <span className="rd-face-note">{note}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rd-row">
            <label className="rd-label" htmlFor="rd-font-size">
              {t("reader.fontSize")}
              <output htmlFor="rd-font-size">{`${settings.fontScale}%`}</output>
            </label>
            <div className="rd-size">
              <span aria-hidden="true">A</span>
              <input
                id="rd-font-size"
                className="rd-range"
                type="range"
                min={0}
                max={FONT_SCALE_STEPS.length - 1}
                step={1}
                value={sizeIndex}
                aria-valuetext={`${settings.fontScale}%`}
                style={{ "--pct": `${sizePercent}%` } as CSSProperties}
                onChange={(event) =>
                  onChange({
                    fontScale:
                      FONT_SCALE_STEPS[Number(event.currentTarget.value)],
                  })
                }
              />
              <span aria-hidden="true">A</span>
            </div>
          </div>

          <div className="rd-row rd-pair">
            <div>
              <p className="rd-label">{t("reader.lineHeight")}</p>
              <SegmentButtons
                label={t("reader.lineHeight")}
                value={nearest(LINE_HEIGHT_PRESETS, settings.lineHeight)}
                onChange={(lineHeight) => onChange({ lineHeight })}
                options={[
                  {
                    value: LINE_HEIGHT_PRESETS[0],
                    label: t("reader.spacing.tight"),
                    icon: <LinesIcon gaps={4} />,
                  },
                  {
                    value: LINE_HEIGHT_PRESETS[1],
                    label: t("reader.spacing.normal"),
                    icon: <LinesIcon gaps={5.5} />,
                  },
                  {
                    value: LINE_HEIGHT_PRESETS[2],
                    label: t("reader.spacing.loose"),
                    icon: <LinesIcon gaps={7.5} />,
                  },
                ]}
              />
            </div>
            <div>
              <p className="rd-label">{t("reader.column")}</p>
              <SegmentButtons
                label={t("reader.column")}
                value={nearest(WIDTH_PRESETS, settings.width)}
                onChange={(width) => onChange({ width })}
                options={[
                  {
                    value: WIDTH_PRESETS[0],
                    label: t("reader.width.narrow"),
                    icon: <MeasureIcon half={3} />,
                  },
                  {
                    value: WIDTH_PRESETS[1],
                    label: t("reader.width.medium"),
                    icon: <MeasureIcon half={5} />,
                  },
                  {
                    value: WIDTH_PRESETS[2],
                    label: t("reader.width.wide"),
                    icon: <MeasureIcon half={8} />,
                  },
                ]}
              />
            </div>
          </div>

          {showReadingLight ? (
            <div className="rd-row">
              <p className="rd-label">{t("reader.readingLight")}</p>
              <SegmentButtons
                label={t("reader.readingLight")}
                value={settings.spotlight}
                onChange={(spotlight) => onChange({ spotlight })}
                options={READER_SPOTLIGHTS.map((spotlight) => ({
                  value: spotlight,
                  label: t(`reader.light.${spotlight}`),
                }))}
              />
              <div className="rd-light-pair" data-off={lightOff || undefined}>
                <SegmentButtons
                  label={t("reader.light.shape")}
                  value={settings.lightShape}
                  onChange={(lightShape) => onChange({ lightShape })}
                  disabled={lightOff}
                  options={READER_LIGHT_SHAPES.map((shape) => ({
                    value: shape,
                    label: t(`reader.light.shape.${shape}`),
                  }))}
                />
                <SegmentButtons
                  label={t("reader.light.reach")}
                  value={nearest(reachPresets, reach)}
                  onChange={(value) =>
                    onChange(
                      settings.lightShape === "line"
                        ? { lineReach: value }
                        : { paragraphReach: value },
                    )
                  }
                  disabled={lightOff}
                  options={reachPresets.map((value, step) => ({
                    value,
                    label: `${t("reader.light.reach")} ${formatPercent(value, language)}`,
                    icon: <ReachIcon step={step} />,
                  }))}
                />
              </div>
            </div>
          ) : null}

          {showReadingLight ? (
            <div className="rd-row">
              <p className="rd-label">{t("reader.margin")}</p>
              <div
                role="group"
                aria-label={t("reader.margin")}
                className="rd-seg rd-toggles"
              >
                <button
                  type="button"
                  className="rd-toggle-ruler"
                  aria-pressed={settings.showRuler}
                  onClick={() => onChange({ showRuler: !settings.showRuler })}
                >
                  {t("reader.margin.ruler")}
                </button>
                <button
                  type="button"
                  aria-pressed={settings.showTimeLeft}
                  onClick={() =>
                    onChange({ showTimeLeft: !settings.showTimeLeft })
                  }
                >
                  {t("reader.margin.timeLeft")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
});

/** Past this, or flicked faster than SHEET_FLICK px/ms, a drag closes the sheet. */
const SHEET_DISMISS_PX = 96;
const SHEET_FLICK = 0.5;

/**
 * The phone sheet's grab handle: the sheet follows a downward drag one to one,
 * then closes or settles back from wherever the finger let go (the stylesheet's
 * own transitions carry it from there).
 */
function useSheetDrag(
  sheetRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const drag = useRef<{
    id: number;
    startY: number;
    lastY: number;
    lastAt: number;
    velocity: number;
  } | null>(null);

  const release = (closing: boolean) => {
    const sheet = sheetRef.current;
    drag.current = null;
    if (closing) {
      onClose();
    }
    if (sheet) {
      sheet.style.transform = "";
      sheet.style.transition = "";
    }
  };

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        id: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastAt: event.timeStamp,
        velocity: 0,
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      const sheet = sheetRef.current;
      if (!current || current.id !== event.pointerId || !sheet) {
        return;
      }
      const elapsed = event.timeStamp - current.lastAt;
      if (elapsed > 0) {
        current.velocity = (event.clientY - current.lastY) / elapsed;
      }
      current.lastY = event.clientY;
      current.lastAt = event.timeStamp;
      sheet.style.transition = "none";
      sheet.style.transform = `translateY(${Math.max(0, event.clientY - current.startY)}px)`;
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) {
        return;
      }
      const distance = event.clientY - current.startY;
      release(distance > SHEET_DISMISS_PX || current.velocity > SHEET_FLICK);
    },
    onPointerCancel: () => release(false),
  };
}

export const ReaderMoreMenu = forwardRef<
  HTMLDivElement,
  {
    open: boolean;
    fileUrl: string;
    downloadUrl: string;
    sizeLabel: string | null;
    finishedControl: ReactNode;
    onClose: () => void;
  }
>(function ReaderMoreMenu(
  { open, fileUrl, downloadUrl, sizeLabel, finishedControl, onClose },
  ref,
) {
  const { t } = useLanguage();

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t("reader.more")}
      aria-hidden={!open}
      data-open={open || undefined}
      className="rd-surface rd-popover rd-menu"
    >
      {finishedControl}
      <a
        role="menuitem"
        className="rd-menu-item"
        href={fileUrl}
        target="_blank"
        rel="noreferrer"
        onClick={onClose}
      >
        <ExternalLink size={18} aria-hidden="true" />
        {t("reader.openOriginal")}
      </a>
      <a
        role="menuitem"
        className="rd-menu-item"
        href={downloadUrl}
        download
        onClick={onClose}
      >
        <Download size={18} aria-hidden="true" />
        {t("reader.downloadBook")}
        {sizeLabel ? <small>{sizeLabel}</small> : null}
      </a>
    </div>
  );
});

const HIGHLIGHT_LABEL_KEYS = {
  yellow: "reader.highlightColor.yellow",
  green: "reader.highlightColor.green",
  blue: "reader.highlightColor.blue",
  pink: "reader.highlightColor.pink",
  purple: "reader.highlightColor.purple",
} as const;

/**
 * The marker's colours, floating by the text the reader selected or the
 * highlight they tapped. The page places it (see `placeHighlightMenu`).
 */
export const ReaderHighlightMenu = forwardRef<
  HTMLDivElement,
  {
    open: boolean;
    current: HighlightColor | null;
    onPick: (color: HighlightColor) => void;
    onRemove: (() => void) | null;
  }
>(function ReaderHighlightMenu({ open, current, onPick, onRemove }, ref) {
  const { t } = useLanguage();

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t("reader.highlight")}
      aria-hidden={!open}
      data-open={open || undefined}
      className="rd-surface rd-highlight-menu"
      // A press here must not take focus from the book, or the selection it
      // is about to mark goes with it.
      onPointerDown={(event) => event.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className="rd-swatch"
          aria-label={t(HIGHLIGHT_LABEL_KEYS[color])}
          aria-pressed={current === color}
          tabIndex={open ? 0 : -1}
          style={{ "--rd-swatch": highlightSwatch(color) } as CSSProperties}
          onClick={() => onPick(color)}
        />
      ))}
      {onRemove ? (
        <>
          <i className="rd-highlight-rule" aria-hidden="true" />
          <button
            type="button"
            className="rd-icon-button"
            aria-label={t("reader.removeHighlight")}
            tabIndex={open ? 0 : -1}
            onClick={onRemove}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
});

type TocEntry = NavItem & { depth: number };

interface ContentsRow {
  entry: TocEntry;
  start: number | null;
  end: number | null;
}

function buildRows(
  toc: TocEntry[],
  map: BookMap | null,
  spineIndexOf: (href: string) => number | null,
): ContentsRow[] {
  if (!map) {
    return toc.map((entry) => ({ entry, start: null, end: null }));
  }

  const starts = toc.map((entry) => {
    const index = spineIndexOf(entry.href);
    return index === null ? null : (map.sectionStarts[index] ?? null);
  });

  return toc.map((entry, index) => {
    const start = starts[index];

    if (start === null) {
      return { entry, start: null, end: null };
    }

    let end = map.total;

    for (let next = index + 1; next < toc.length; next += 1) {
      const nextStart = starts[next];

      if (nextStart !== null && nextStart > start) {
        end = nextStart;
        break;
      }
    }

    return { entry, start, end };
  });
}

export type ReaderContentsTab = "contents" | "bookmarks" | "search";

export function ReaderContentsDrawer({
  open,
  tab,
  onTab,
  title,
  author,
  item,
  toc,
  map,
  location,
  currentHref,
  bookmarks,
  scheme,
  spineIndexOf,
  onNavigate,
  onShowPassage,
  onRemoveBookmark,
  onClose,
}: {
  open: boolean;
  tab: ReaderContentsTab;
  onTab: (tab: ReaderContentsTab) => void;
  title: string;
  author: string;
  item: MediaItem;
  toc: TocEntry[];
  map: BookMap | null;
  location: number | null;
  currentHref: string | null;
  bookmarks: ReaderBookmark[];
  /** The theme's ground, which sets how strongly a highlight's colour shows. */
  scheme: "dark" | "light";
  spineIndexOf: (href: string) => number | null;
  onNavigate: (target: string) => void;
  onShowPassage: (hit: BookSearchHit, found: BookSearchFound) => void;
  onRemoveBookmark: (id: string) => void;
  onClose: () => void;
}) {
  const { t, language } = useLanguage();
  const drawerRef = useRef<HTMLElement | null>(null);
  const rows = useMemo(
    () => buildRows(toc, map, spineIndexOf),
    [map, spineIndexOf, toc],
  );
  // The contents list is in reading order: a section belongs to the last
  // chapter that starts at or before it. Chapters are the top level, as the
  // margin counts them (buildBookMap), so a part numbered "1" inside a
  // chapter is never named on its own.
  const chapterOf = useCallback(
    (section: number) => {
      const topLevel = toc.filter((entry) => entry.depth === 0);
      let label: string | null = null;
      for (const entry of topLevel.length >= 2 ? topLevel : toc) {
        const at = spineIndexOf(entry.href);
        if (at !== null && at <= section) label = entry.label.trim();
      }
      return label;
    },
    [spineIndexOf, toc],
  );
  // A search hit's place in the whole book, in the reader's own measure: its
  // section's share of the book's locations, and its place in that section.
  const bookPlaceOf = useCallback(
    (section: number, place: number) => {
      if (!map) return null;
      const start = map.sectionStarts[section];
      if (start === undefined) return null;
      const end = map.sectionStarts[section + 1] ?? map.total;
      return Math.min(1, (start + (end - start) * place) / map.total);
    },
    [map],
  );
  const longest = Math.max(
    1,
    ...rows.map((row) =>
      row.start !== null && row.end !== null ? row.end - row.start : 0,
    ),
  );
  const currentIndex = useMemo(() => {
    if (location !== null) {
      let found = -1;
      rows.forEach((row, index) => {
        if (row.start !== null && row.start <= location) {
          found = index;
        }
      });
      return found;
    }

    // Before the book is measured: the last chapter starting at or before the
    // section on screen.
    const here = currentHref ? spineIndexOf(currentHref) : null;
    if (here === null) {
      return -1;
    }
    let found = -1;
    rows.forEach((row, index) => {
      const spine = spineIndexOf(row.entry.href);
      if (spine !== null && spine <= here) {
        found = index;
      }
    });
    return found;
  }, [currentHref, location, rows, spineIndexOf]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const drawer = drawerRef.current;
    // Not the field of a tab kept out of sight.
    const autofocus = Array.from(
      drawer?.querySelectorAll<HTMLElement>("[data-autofocus]") ?? [],
    ).find((element) => !element.closest("[hidden]"));
    const focusTarget =
      autofocus ??
      drawer?.querySelector<HTMLElement>('[aria-current="true"]') ??
      drawer?.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
    focusTarget?.scrollIntoView({ block: "center" });
  }, [open, tab]);

  const progress = map && location !== null ? location / map.total : null;

  return (
    <>
      <div
        className="rd-scrim"
        data-open={open || undefined}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("reader.contents")}
        aria-hidden={!open}
        data-open={open || undefined}
        className="rd-surface rd-drawer"
      >
        <div className="rd-drawer-head">
          {item.ImageTags?.Primary ? (
            <ReaderBookCover
              item={item}
              width={72}
              className="rd-drawer-cover"
            />
          ) : (
            <span />
          )}
          <div>
            <h2 className="rd-drawer-title">{title}</h2>
            {author ? <div className="rd-drawer-author">{author}</div> : null}
            {progress !== null && map ? (
              <div className="rd-drawer-progress">
                <span>
                  {t("reader.percentRead").replace(
                    "{percent}",
                    formatPercent(progress, language),
                  )}
                </span>
                <span>
                  {t("reader.timeLeftInBook").replace(
                    "{time}",
                    formatDuration(
                      minutesForLocations(map.total - (location ?? 0)),
                      t,
                    ),
                  )}
                </span>
              </div>
            ) : (
              <div className="rd-drawer-progress" data-pending>
                <span>{t("reader.measuring")}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="rd-icon-button rd-drawer-close"
            aria-label={t("reader.closeContents")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="rd-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "contents"}
            onClick={() => onTab("contents")}
          >
            {t("reader.contents")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bookmarks"}
            onClick={() => onTab("bookmarks")}
          >
            {t("reader.bookmarks")}
            {bookmarks.length > 0 ? (
              <span className="rd-count">{bookmarks.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "search"}
            onClick={() => onTab("search")}
          >
            {t("reader.search")}
          </button>
        </div>

        {/* Kept while another tab is shown, so a search and its results
            are still there on the way back. */}
        <ReaderSearch
          itemId={item.Id}
          active={open && tab === "search"}
          hidden={tab !== "search"}
          chapterOf={chapterOf}
          bookPlaceOf={bookPlaceOf}
          onShow={onShowPassage}
        />
        {tab === "search" ? null : tab === "contents" ? (
          rows.length > 0 ? (
            <ol className="rd-list" role="tabpanel">
              {rows.map((row, index) => {
                const { number, title: rowTitle } = splitNumber(
                  row.entry.label,
                );
                const length =
                  row.start !== null && row.end !== null
                    ? row.end - row.start
                    : null;
                const read =
                  length !== null && location !== null && row.start !== null
                    ? Math.min(
                        1,
                        Math.max(
                          0,
                          (location - row.start) / Math.max(1, length),
                        ),
                      )
                    : 0;
                const isCurrent = index === currentIndex;

                return (
                  <li key={`${row.entry.href}-${index}`}>
                    <button
                      type="button"
                      className="rd-chapter"
                      data-depth={Math.min(row.entry.depth, 2)}
                      aria-current={isCurrent || undefined}
                      style={{
                        paddingLeft: `${0.75 + Math.min(row.entry.depth, 2) * 0.75}rem`,
                      }}
                      onClick={() => onNavigate(row.entry.href)}
                    >
                      <span className="rd-chapter-n" aria-hidden="true">
                        {number || <span className="rd-chapter-dot" />}
                      </span>
                      <span className="rd-chapter-t">
                        {number ? (
                          <span className="sr-only">{number} </span>
                        ) : null}
                        {rowTitle}
                      </span>
                      <span className="rd-chapter-time">
                        {length !== null && length > 0 ? (
                          formatDuration(minutesForLocations(length), t)
                        ) : map ? (
                          ""
                        ) : (
                          <span className="rd-pending-bit" aria-hidden="true" />
                        )}
                      </span>
                      {length !== null && length > 0 ? (
                        <span className="rd-chapter-len" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.max(3, (length / longest) * 100)}%`,
                            }}
                          />
                          <span
                            style={{
                              width: `${Math.max(3, (length / longest) * 100) * read}%`,
                            }}
                          />
                        </span>
                      ) : map ? null : (
                        <span
                          className="rd-chapter-len"
                          data-pending
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="rd-empty">{t("reader.noChapters")}</p>
          )
        ) : bookmarks.length > 0 ? (
          <ul className="rd-list" role="tabpanel">
            {bookmarks.map((bookmark) => (
              <li
                key={bookmark.id}
                className="rd-bookmark"
                data-highlight={bookmark.color}
                style={
                  isHighlight(bookmark)
                    ? ({
                        "--rd-wash": highlightWash(bookmark.color, scheme),
                        "--rd-swatch": highlightSwatch(bookmark.color),
                      } as CSSProperties)
                    : undefined
                }
              >
                <button
                  type="button"
                  className="rd-bookmark-go"
                  onClick={() => onNavigate(bookmark.cfi)}
                >
                  {bookmark.excerpt ? (
                    <span className="rd-bookmark-excerpt">
                      {isHighlight(bookmark) ? (
                        <mark>{bookmark.excerpt}</mark>
                      ) : (
                        bookmark.excerpt
                      )}
                    </span>
                  ) : null}
                  <span className="rd-bookmark-label">
                    <span>{bookmark.label}</span>
                    {bookmark.progress !== null ? (
                      <b>{formatPercent(bookmark.progress, language)}</b>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="rd-icon-button"
                  aria-label={
                    isHighlight(bookmark)
                      ? t("reader.removeHighlight")
                      : t("reader.removeBookmark")
                  }
                  onClick={() => onRemoveBookmark(bookmark.id)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rd-empty" role="tabpanel">
            {t("reader.noBookmarks")}
          </p>
        )}
      </aside>
    </>
  );
}

/**
 * The book as the library draws it — cover, and the logo in the place, at the
 * width and with the shadow it was adjusted to — bound like a book: a spine
 * fold down the left edge and a lift under it. `width` is in pixels; the
 * logo's shadow is scaled to it, as on every other poster.
 */
export function ReaderBookCover({
  item,
  width,
  className = "",
}: {
  item: MediaItem;
  width: number;
  className?: string;
}) {
  const coverTag = item.ImageTags?.Primary ?? null;

  if (!coverTag) {
    return null;
  }

  return (
    <TitlePoster
      itemId={item.Id}
      title={item.Name ?? ""}
      artwork={{
        coverTag,
        logoTag: item.ImageTags?.Logo ?? null,
        logoLayout: getLogoLayout(item),
      }}
      width={width}
      className={`rd-book ${className}`}
    />
  );
}

/** How long the margin takes to fade across a chapter change or a leap. */
export const RULER_FADE_MS = 180;

/**
 * A drag on the ruler: pressed, moved, let go (or taken away); or a turn of
 * the wheel over it, which moves the same way with no press.
 */
export type RulerSeekPhase = "start" | "move" | "end" | "wheel";

interface MarginChapter {
  chapter: BookChapter;
  next: BookChapter | null;
  chapterNumber: string;
}

/**
 * The right margin: how long is left in the chapter, and the chapter as a
 * ruler beneath it. Either can be turned off. The marker is moved by the page
 * directly; when the chapter changes, the names and the scale fade out and
 * back in with the new chapter rather than snapping, in step with the marker.
 *
 * The ruler is also a handle, held anywhere along it: it reports how far the
 * pointer moves up or down, as a share of the ruler, and the page moves the
 * reading line through the chapter by that much from where it was.
 */
export const ReaderMargin = forwardRef<
  HTMLDivElement,
  MarginChapter & {
    covered: boolean;
    showRuler: boolean;
    timeLeft: string | null;
    bookLanguage: string;
    onSeek: (phase: RulerSeekPhase, delta: number) => void;
  }
>(function ReaderMargin(
  {
    chapter,
    next,
    chapterNumber,
    covered,
    showRuler,
    timeLeft,
    bookLanguage,
    onSeek,
  },
  markerRef,
) {
  const { t } = useLanguage();
  const marginRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  // Read by the pointer handlers: a release and the lost capture that
  // follows it arrive before the state has re-rendered.
  const draggingRef = useRef(false);
  const lastYRef = useRef(0);
  /** The pointer's move since the last event, as a share of the ruler's height. */
  const moveFrom = (clientY: number) => {
    const height = marginRef.current?.getBoundingClientRect().height ?? 0;
    const delta = height > 0 ? (clientY - lastYRef.current) / height : 0;
    lastYRef.current = clientY;
    return delta;
  };
  // While dragged, the book's frames take no pointer: a drag that strays over
  // the text must not lose its events to them.
  const setDrag = (on: boolean) => {
    draggingRef.current = on;
    setDragging(on);
    if (on) {
      document.documentElement.dataset.rulerDrag = "true";
    } else {
      delete document.documentElement.dataset.rulerDrag;
    }
  };
  useEffect(
    () => () => {
      delete document.documentElement.dataset.rulerDrag;
    },
    [],
  );
  const pressRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || covered) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    lastYRef.current = event.clientY;
    setDrag(true);
    onSeek("start", 0);
  };
  const dragRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      onSeek("move", moveFrom(event.clientY));
    }
  };
  const releaseRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) {
      return;
    }
    onSeek("move", moveFrom(event.clientY));
    setDrag(false);
    onSeek("end", 0);
  };
  // The wheel over the ruler turns it like a volume control, by as much as a
  // drag of the same distance would. Not passive: the page must not scroll
  // (and bounce) under it.
  const gripRef = useRef<HTMLDivElement | null>(null);
  const onSeekRef = useRef(onSeek);
  useEffect(() => {
    onSeekRef.current = onSeek;
  });
  useEffect(() => {
    const grip = gripRef.current;
    if (!grip) {
      return undefined;
    }
    const turn = (event: WheelEvent) => {
      event.preventDefault();
      const height = marginRef.current?.getBoundingClientRect().height ?? 0;
      if (draggingRef.current || height <= 0 || event.ctrlKey) {
        return;
      }
      const lines =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? height
            : 1;
      onSeekRef.current("wheel", (event.deltaY * lines) / height);
    };
    grip.addEventListener("wheel", turn, { passive: false });
    return () => grip.removeEventListener("wheel", turn);
  }, [showRuler]);
  // The chapter on display lags a change by one fade: while the keys differ
  // the old chapter fades out, then the new one takes its place and fades in.
  const [shown, setShown] = useState<MarginChapter>({
    chapter,
    next,
    chapterNumber,
  });
  const incomingKey = `${chapter.start}:${chapter.label}`;
  const fading =
    incomingKey !== `${shown.chapter.start}:${shown.chapter.label}`;
  const display = fading ? shown : { chapter, next, chapterNumber };

  useEffect(() => {
    if (!fading) {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setShown({ chapter, next, chapterNumber }),
      RULER_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [chapter, chapterNumber, fading, incomingKey, next]);

  const ticks = useMemo(() => {
    const length = Math.max(1, display.chapter.end - display.chapter.start);
    // About one tick per two locations (roughly a printed page), but always a
    // graduated scale: a short chapter still reads as a ruler, not a few notches.
    const count = Math.min(80, Math.max(40, Math.round(length / 2)));

    return Array.from({ length: count + 1 }, (_, index) => ({
      at: index / count,
      major: index % 10 === 0,
    }));
  }, [display.chapter.end, display.chapter.start]);

  return (
    <div
      ref={marginRef}
      className="rd-margin"
      data-covered={covered || undefined}
      data-ruler={showRuler || undefined}
      data-dragging={dragging || undefined}
      aria-hidden="true"
    >
      {timeLeft ? (
        <div className="rd-margin-time" data-fading={fading || undefined}>
          {t("reader.toChapterEnd")} <b>≈ {timeLeft}</b>
        </div>
      ) : null}
      {showRuler ? (
        <>
          <div className="rd-ruler-line" />
          <div className="rd-ruler-scale" data-fading={fading || undefined}>
            {ticks.map((tick) => (
              <span
                key={tick.at}
                className="rd-ruler-tick"
                data-major={tick.major || undefined}
                style={{ top: `${tick.at * 100}%` }}
              />
            ))}
            <span
              className="rd-ruler-cap"
              data-edge="top"
              lang={bookLanguage || undefined}
            >
              {display.chapterNumber ? `${display.chapterNumber} · ` : ""}
              {splitNumber(display.chapter.label).title}
            </span>
            {display.next ? (
              <span
                className="rd-ruler-cap"
                data-edge="bottom"
                lang={bookLanguage || undefined}
              >
                {splitNumber(display.next.label).title}
              </span>
            ) : null}
          </div>
          <div ref={markerRef} className="rd-ruler-marker">
            <span />
          </div>
          <div
            ref={gripRef}
            className="rd-ruler-grip"
            onPointerDown={pressRuler}
            onPointerMove={dragRuler}
            onPointerUp={releaseRuler}
            onPointerCancel={releaseRuler}
            onLostPointerCapture={releaseRuler}
          />
        </>
      ) : null}
    </div>
  );
});
