import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Check,
  ChevronsDown,
  ChevronsUp,
  EyeOff,
  GripVertical,
  RotateCcw,
  Save,
  Search,
} from "lucide-react";
import { Button } from "../../components/Button";
import { ErrorMessage } from "../../components/ErrorMessage";
import { LoadingSpinner } from "../../components/LoadingSpinner";
import { Tooltip } from "../../components/ui/Tooltip";
import { useLanguage } from "../../i18n/LanguageContext";
import { isAdministrator } from "../../lib/authStorage";
import {
  buildHomeCarouselPool,
  emptyCuratedList,
  type CuratedList,
} from "../../lib/curation";
import { getDisplayTitle, getItemSubtitle } from "../../lib/format";
import { orderByNewest } from "../../lib/homeShelves";
import {
  refreshLibraryRoutes,
  type LibraryRouteRegistry,
} from "../../lib/libraryRoutes";
import {
  clearCuratedList,
  getAllBookItems,
  getAllMovieItems,
  getAllSeriesItems,
  getBackdropImageUrl,
  getCuratedList,
  getPrimaryImageUrl,
  saveCuratedList,
} from "../../lib/mediaApi";
import { setPageTitle } from "../../lib/pageTitle";
import { matchesSearchText, titleSearchNames } from "../../lib/searchModel";
import type { MediaItem } from "../../lib/types";
import {
  applyVisibleOrder,
  draftFromPool,
  entriesFromDraft,
  isDraftDirty,
  moveId,
  moveIdToIndex,
  moveIdsToBack,
  moveIdsToFront,
  toggleId,
  type CurationSection,
  type SectionDraft,
} from "./curationEditorModel";
import { useQueueSortable } from "./useQueueSortable";
import type { TranslationKey } from "../../i18n/translations";

/**
 * How many rows a shelf renders before the operator asks for more.
 *
 * A library runs to hundreds of titles and nobody hand-ranks that many; the
 * realistic move is to search for one title and send it to the top, so the page
 * shows the head of the shelf — the part anyone actually sees — and lets search
 * reach the rest. A drag rearranges the window and leaves the tail untouched.
 */
const VISIBLE_ROW_LIMIT = 60;

interface SectionDefinition extends CurationSection {
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  pool: MediaItem[];
  /** Wide when the shelf renders backdrops, so the thumbnail matches the slide. */
  artwork: "poster" | "backdrop";
}

interface CurationData {
  sections: SectionDefinition[];
  lists: Record<string, CuratedList>;
}

type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "error"; message: string };

const EMPTY_DRAFT: SectionDraft = { orderedIds: [], hiddenIds: [] };

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function getBackdropUrl(item: MediaItem): string {
  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 520);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      520,
    );
  }

  return "";
}

/**
 * The artwork the shelf itself will use.
 *
 * The carousel renders a full-bleed backdrop, so the editor shows backdrops:
 * ranking hero slides by their posters would be judging the wrong picture, and
 * a title with a fine poster and no backdrop is exactly the one that must look
 * wrong here.
 */
function getItemArtworkUrl(item: MediaItem, preferBackdrop: boolean): string {
  const backdrop = getBackdropUrl(item);
  const poster = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 360)
    : "";

  return preferBackdrop ? backdrop || poster : poster || backdrop;
}

function getItemTypeLabel(
  item: MediaItem,
  t: ReturnType<typeof useLanguage>["t"],
): string {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Series") return t("common.series");
  return item.Type ?? t("common.unknown");
}

function itemMatchesQuery(
  item: MediaItem,
  query: string,
  t: ReturnType<typeof useLanguage>["t"],
): boolean {
  return matchesSearchText(query, [
    getDisplayTitle(item),
    ...titleSearchNames(item),
    item.SortName,
    item.SeriesName,
    item.ProductionYear,
    getItemTypeLabel(item, t),
    item.Id,
  ]);
}

interface CurationItemRowProps {
  item: MediaItem;
  artwork: "poster" | "backdrop";
  position: number;
  hidden: boolean;
  selected: boolean;
  held: boolean;
  lifted: boolean;
  groupSize: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleSelected: () => void;
  onToggleHidden: () => void;
  onGrab: (event: React.PointerEvent<HTMLElement>) => void;
  onNudge: (direction: -1 | 1) => void;
  onMoveToTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToBottom: () => void;
}

function CurationItemRow({
  item,
  artwork,
  position,
  hidden,
  selected,
  held,
  lifted,
  groupSize,
  canMoveUp,
  canMoveDown,
  onToggleSelected,
  onToggleHidden,
  onGrab,
  onNudge,
  onMoveToTop,
  onMoveUp,
  onMoveDown,
  onMoveToBottom,
}: CurationItemRowProps) {
  const { t } = useLanguage();
  const artworkUrl = getItemArtworkUrl(item, artwork === "backdrop");
  const title = getDisplayTitle(item, {
    season: t("media.seasonNumber"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  });
  const subtitle = [
    getItemTypeLabel(item, t),
    item.ProductionYear,
    getItemSubtitle(item, {
      season: t("media.seasonNumber"),
      hourShort: t("format.hourShort"),
      minuteShort: t("format.minuteShort"),
    }),
  ].filter(Boolean);

  const moveButtons: Array<{
    label: string;
    icon: React.ReactNode;
    disabled: boolean;
    onClick: () => void;
  }> = [
    {
      label: formatTemplate(t("curation.moveTopItem"), { title }),
      icon: <ArrowUpToLine size={16} />,
      disabled: !canMoveUp,
      onClick: onMoveToTop,
    },
    {
      label: formatTemplate(t("curation.moveUpItem"), { title }),
      icon: <ArrowUp size={16} />,
      disabled: !canMoveUp,
      onClick: onMoveUp,
    },
    {
      label: formatTemplate(t("curation.moveDownItem"), { title }),
      icon: <ArrowDown size={16} />,
      disabled: !canMoveDown,
      onClick: onMoveDown,
    },
    {
      label: formatTemplate(t("curation.moveBottomItem"), { title }),
      icon: <ArrowDownToLine size={16} />,
      disabled: !canMoveDown,
      onClick: onMoveToBottom,
    },
  ];

  return (
    <div
      className={`grid gap-3 rounded-2xl border p-3 transition-colors sm:grid-cols-[auto_auto_auto_1fr_auto] sm:items-center ${
        lifted
          ? "border-white/25 bg-black/40 shadow-[0_20px_45px_-18px_rgba(0,0,0,0.9)]"
          : selected
            ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
            : hidden
              ? "border-white/[0.07] bg-black/18 opacity-58"
              : "border-white/10 bg-black/32"
      }`}
    >
      <div className="flex items-center gap-1">
        {/*
         * The tick that makes a group, and the handle that carries it. A
         * checkbox rather than a click on the row: these rows carry buttons of
         * their own, and a list where clicking a card might mean "select" and
         * might mean "open" is a list nobody trusts.
         */}
        <label className="-m-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={formatTemplate(t("curation.select"), { title })}
            className={`h-5 w-5 cursor-pointer appearance-none rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              selected
                ? "border-[var(--accent)] bg-[var(--accent)] shadow-[inset_0_0_0_3px_rgba(0,0,0,0.6)]"
                : "border-white/25 bg-transparent hover:border-white/50"
            }`}
          />
        </label>

        <button
          type="button"
          aria-label={
            selected && groupSize > 1
              ? formatTemplate(t("curation.groupHandle"), {
                  count: groupSize,
                  title,
                })
              : formatTemplate(t("curation.handle"), {
                  title,
                  position: position + 1,
                })
          }
          title={t("curation.handleHint")}
          onPointerDown={onGrab}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onNudge(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onNudge(1);
            }
          }}
          className={`inline-flex h-9 w-9 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg border text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white/70 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
            held
              ? "cursor-grabbing border-white/25 bg-white/[0.1] text-white/80"
              : "border-white/10"
          }`}
        >
          <GripVertical size={20} aria-hidden="true" />
        </button>
      </div>

      <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] px-2 text-xs font-black tabular-nums text-white/62">
        {position + 1}
      </span>

      <div
        className={`overflow-hidden rounded-xl bg-white/[0.08] ${
          artwork === "backdrop"
            ? "h-16 w-28 sm:h-[3.75rem] sm:w-[6.7rem]"
            : "h-20 w-14 sm:h-24 sm:w-16"
        }`}
      >
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs font-black text-white/28">
            {item.Type?.slice(0, 2).toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-base font-black text-white">
            {title}
          </h2>
          {hidden ? (
            <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-[0.68rem] font-black uppercase tracking-[0.12em] text-white/38">
              {t("curation.hiddenBadge")}
            </span>
          ) : null}
        </div>

        <p className="mt-1 truncate text-sm font-semibold text-white/48">
          {subtitle.join(" · ")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2 sm:justify-end">
        {moveButtons.map((button) => (
          <Tooltip key={button.label} content={button.label}>
            <button
              type="button"
              onClick={button.onClick}
              disabled={button.disabled}
              aria-label={button.label}
              className="inline-flex min-h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/72 transition hover:bg-white/[0.12] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              {button.icon}
            </button>
          </Tooltip>
        ))}

        <Tooltip content={t("curation.hideHint")}>
          <button
            type="button"
            onClick={onToggleHidden}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-full border px-3 text-sm font-black transition ${
              hidden
                ? "border-white/10 bg-white/[0.06] text-white/62 hover:bg-white/[0.12] hover:text-white"
                : "border-emerald-300/18 bg-emerald-300/10 text-emerald-50 hover:bg-emerald-300/16"
            }`}
          >
            {hidden ? <EyeOff size={15} /> : <Check size={15} />}
            {hidden ? t("curation.stateHidden") : t("curation.stateVisible")}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Builds the shelf list from what the catalogue actually holds.
 *
 * One section per library, not one per place a library appears: the film
 * library's order is read by both the film grid and the Latest films row, so
 * arranging it once arranges both. A section only appears when a library is
 * assigned to that route — an editor for a shelf the site does not show would
 * be an editor for nothing.
 *
 * The pools are seeded newest-first, which is where a Latest row starts and
 * where curation usually begins. The grids keep Name, Year and Latest beside
 * Custom, so nothing is lost there.
 */
function buildSections(
  moviePool: MediaItem[],
  seriesPool: MediaItem[],
  bookPool: MediaItem[],
  libraries: LibraryRouteRegistry,
): SectionDefinition[] {
  const libraryOf = (
    id: string,
    libraryId: string | undefined,
    labelKey: TranslationKey,
    descriptionKey: TranslationKey,
    pool: MediaItem[],
  ): SectionDefinition[] =>
    libraryId
      ? [
          {
            id,
            surface: "library",
            libraryId,
            labelKey,
            descriptionKey,
            pool: orderByNewest(pool),
            artwork: "poster",
          },
        ]
      : [];

  return [
    {
      id: "home-hero",
      surface: "home-hero",
      labelKey: "curation.section.carousel",
      descriptionKey: "curation.section.carouselDescription",
      pool: buildHomeCarouselPool([...moviePool, ...seriesPool]),
      artwork: "backdrop",
    },
    ...libraryOf(
      "library-movies",
      libraries.movies?.id,
      "curation.section.movies",
      "curation.section.moviesDescription",
      moviePool,
    ),
    ...libraryOf(
      "library-shows",
      libraries.shows?.id,
      "curation.section.shows",
      "curation.section.showsDescription",
      seriesPool,
    ),
    ...libraryOf(
      "library-books",
      libraries.books?.id,
      "curation.section.books",
      "curation.section.booksDescription",
      bookPool,
    ),
  ];
}

export function CurationPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<CurationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeSectionId, setActiveSectionId] = useState("home-hero");
  const [drafts, setDrafts] = useState<Record<string, SectionDraft>>({});
  const [baselines, setBaselines] = useState<Record<string, SectionDraft>>({});
  const [saveState, setSaveState] = useState<SaveState>({ state: "idle" });
  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_ROW_LIMIT);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /**
   * The window's order held still for the length of a drag, so a re-render
   * cannot re-sort the list out from under the pointer.
   */
  const [dragFreeze, setDragFreeze] = useState<string[] | null>(null);
  const canEdit = isAdministrator();

  useEffect(() => {
    setPageTitle(`${t("curation.title")} · Seyirlik`, {
      canonicalPath: "/dev/curation",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadCuration() {
      setError(null);

      try {
        const [movies, series, books, libraries] = await Promise.all([
          getAllMovieItems(),
          getAllSeriesItems(),
          getAllBookItems().catch(() => [] as MediaItem[]),
          refreshLibraryRoutes().catch((): LibraryRouteRegistry => ({})),
        ]);

        const sections = buildSections(movies, series, books, libraries);

        const lists = await Promise.all(
          sections.map((section) =>
            getCuratedList(section.surface, section.libraryId).catch(() =>
              emptyCuratedList(section.surface, section.libraryId ?? null),
            ),
          ),
        );

        if (!isMounted) return;

        const listBySection: Record<string, CuratedList> = {};
        const loadedDrafts: Record<string, SectionDraft> = {};

        sections.forEach((section, index) => {
          const list = lists[index];
          listBySection[section.id] = list;
          loadedDrafts[section.id] = draftFromPool(section.pool, list);
        });

        setData({ sections, lists: listBySection });
        setDrafts(loadedDrafts);
        setBaselines(loadedDrafts);
      } catch (loadError) {
        if (!isMounted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("curation.loadFailed"),
        );
      }
    }

    void loadCuration();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const activeSection = useMemo(
    () =>
      data?.sections.find((section) => section.id === activeSectionId) ??
      data?.sections[0],
    [data, activeSectionId],
  );

  const activeDraft = activeSection
    ? (drafts[activeSection.id] ?? EMPTY_DRAFT)
    : EMPTY_DRAFT;
  const activeBaseline = activeSection
    ? (baselines[activeSection.id] ?? EMPTY_DRAFT)
    : EMPTY_DRAFT;
  const isDirty = isDraftDirty(activeDraft, activeBaseline);

  const orderedItems = useMemo(() => {
    if (!activeSection) return [];
    const itemById = new Map(
      activeSection.pool.map((item) => [item.Id, item] as const),
    );
    return activeDraft.orderedIds
      .map((itemId) => itemById.get(itemId))
      .filter((item): item is MediaItem => Boolean(item));
  }, [activeSection, activeDraft.orderedIds]);

  const matchedItems = useMemo(
    () =>
      orderedItems
        .map((item, index) => ({ item, index }))
        .filter((entry) => itemMatchesQuery(entry.item, query, t)),
    [orderedItems, query, t],
  );

  /**
   * The rows on screen, frozen for the length of a drag.
   *
   * A drag rearranges this window and nothing else; `applyVisibleOrder` puts
   * the result back into the whole shelf, so the tail below the window keeps
   * its places exactly.
   */
  const visibleItems = matchedItems.slice(0, visibleLimit);
  const visibleIds = useMemo(
    () => visibleItems.map((entry) => entry.item.Id),
    [visibleItems],
  );
  const rowIds = dragFreeze ?? visibleIds;
  const hiddenIds = new Set(activeDraft.hiddenIds);
  const entryByItemId = useMemo(
    () => new Map(matchedItems.map((entry) => [entry.item.Id, entry] as const)),
    [matchedItems],
  );
  /**
   * The shelf positions the window occupies, ascending.
   *
   * A drag permutes the window's rows among exactly these slots, so a preview
   * position is read out of here rather than counted from the top of the
   * window — which would be wrong the moment a search made the window
   * non-contiguous.
   */
  const windowPositions = useMemo(
    () =>
      rowIds
        .map((itemId) => entryByItemId.get(itemId)?.index ?? 0)
        .sort((left, right) => left - right),
    [rowIds, entryByItemId],
  );

  const updateDraft = useCallback(
    (update: (current: SectionDraft) => SectionDraft): void => {
      if (!activeSection) return;
      setSaveState({ state: "idle" });
      setDrafts((current) => ({
        ...current,
        [activeSection.id]: update(current[activeSection.id] ?? EMPTY_DRAFT),
      }));
    },
    [activeSection],
  );

  const commitVisibleOrder = useCallback(
    (nextVisibleIds: string[]) => {
      updateDraft((current) => ({
        ...current,
        orderedIds: applyVisibleOrder(current.orderedIds, nextVisibleIds),
      }));
    },
    [updateDraft],
  );

  const sortable = useQueueSortable({
    ids: rowIds,
    onCommit: commitVisibleOrder,
    onDragStart: setDragFreeze,
    onDragEnd: () => setDragFreeze(null),
    disabled: !canEdit,
  });

  /** The selection in shelf order, which is the order a group move uses. */
  const selectedInOrder = useMemo(
    () => activeDraft.orderedIds.filter((itemId) => selectedIds.has(itemId)),
    [activeDraft.orderedIds, selectedIds],
  );

  /**
   * The rows a press should carry: the selection when the row is part of it,
   * and the row alone when it is not. Grabbing an unticked row is not a
   * mistake to correct — it is the ordinary single-row drag.
   */
  const blockFor = useCallback(
    (itemId: string) =>
      selectedIds.has(itemId) && selectedInOrder.length > 1
        ? selectedInOrder
        : undefined,
    [selectedIds, selectedInOrder],
  );

  const toggleSelected = useCallback((itemId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  }, []);

  function resetSection(sectionId: string): void {
    setActiveSectionId(sectionId);
    setVisibleLimit(VISIBLE_ROW_LIMIT);
    setSaveState({ state: "idle" });
    setSelectedIds(new Set());
  }

  async function handleSave(): Promise<void> {
    if (!activeSection) return;
    setSaveState({ state: "saving" });

    try {
      const entries = entriesFromDraft(activeDraft, activeSection.pool);
      await saveCuratedList(
        activeSection.surface,
        entries,
        activeSection.libraryId,
      );

      // The saved draft becomes the new baseline, so the page stops reporting
      // changes that are now on the server.
      setBaselines((current) => ({
        ...current,
        [activeSection.id]: activeDraft,
      }));
      setData((current) =>
        current
          ? {
              ...current,
              lists: {
                ...current.lists,
                [activeSection.id]: {
                  ...emptyCuratedList(
                    activeSection.surface,
                    activeSection.libraryId ?? null,
                  ),
                  updatedAt: new Date().toISOString(),
                  entries,
                },
              },
            }
          : current,
      );
      setSaveState({ state: "saved" });
    } catch (saveError) {
      setSaveState({
        state: "error",
        message:
          saveError instanceof Error
            ? saveError.message
            : t("curation.saveFailed"),
      });
    }
  }

  async function handleClear(): Promise<void> {
    if (!activeSection) return;
    setSaveState({ state: "saving" });

    try {
      await clearCuratedList(activeSection.surface, activeSection.libraryId);

      const cleared = draftFromPool(activeSection.pool, null);
      setDrafts((current) => ({ ...current, [activeSection.id]: cleared }));
      setBaselines((current) => ({ ...current, [activeSection.id]: cleared }));
      setData((current) =>
        current
          ? {
              ...current,
              lists: {
                ...current.lists,
                [activeSection.id]: emptyCuratedList(
                  activeSection.surface,
                  activeSection.libraryId ?? null,
                ),
              },
            }
          : current,
      );
      setSaveState({ state: "saved" });
    } catch (clearError) {
      setSaveState({
        state: "error",
        message:
          clearError instanceof Error
            ? clearError.message
            : t("curation.saveFailed"),
      });
    }
  }

  if (error) {
    return (
      <div className="w-full">
        <ErrorMessage title={t("curation.unavailable")} message={error} />
      </div>
    );
  }

  if (!data || !activeSection) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-sm font-semibold text-white/50">
            {t("curation.loading")}
          </p>
        </div>
      </div>
    );
  }

  const previewOrder = sortable.previewOrder;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <div className="mt-5">
          <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
            {t("curation.eyebrow")}
          </p>
          <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
            {t("curation.title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/55">
            {t("curation.description")}
          </p>
          {canEdit ? null : (
            <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100/85">
              {t("curation.readOnly")}
            </p>
          )}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => resetSection(section.id)}
            className={`rounded-2xl border p-4 text-left transition ${
              section.id === activeSection.id
                ? "border-[var(--accent)]/50 bg-[var(--accent)]/12"
                : "border-white/10 bg-black/24 hover:bg-white/[0.06]"
            }`}
          >
            <span className="block text-base font-black text-white">
              {t(section.labelKey)}
            </span>
            <span className="mt-1 block text-sm font-semibold text-white/48">
              {t(section.descriptionKey)}
            </span>
            <span className="mt-2 block text-xs font-black uppercase tracking-[0.12em] text-white/38">
              {formatTemplate(t("curation.sectionCount"), {
                count: section.pool.length,
              })}
            </span>
          </button>
        ))}
      </section>

      <section className="rounded-3xl border border-white/10 bg-black/30 p-4 shadow-2xl backdrop-blur-xl sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative block flex-1">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/35"
            />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleLimit(VISIBLE_ROW_LIMIT);
              }}
              placeholder={t("curation.searchPlaceholder")}
              aria-label={t("curation.searchLabel")}
              className="min-h-12 w-full rounded-2xl border border-white/10 bg-white/[0.06] pl-11 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/32 focus:border-[var(--accent)]/55 focus:bg-white/[0.09]"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <p
              className="px-1 text-xs font-bold text-white/38"
              role="status"
              aria-live="polite"
            >
              {saveState.state === "error"
                ? saveState.message
                : saveState.state === "saving"
                  ? t("curation.saving")
                  : isDirty
                    ? t("curation.unsavedChanges")
                    : saveState.state === "saved"
                      ? t("curation.saved")
                      : t("curation.upToDate")}
            </p>
            <Button
              type="button"
              variant="secondary"
              className="rounded-full"
              disabled={!isDirty || saveState.state === "saving"}
              onClick={() =>
                setDrafts((current) => ({
                  ...current,
                  [activeSection.id]: activeBaseline,
                }))
              }
            >
              <RotateCcw size={16} />
              {t("curation.revert")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="rounded-full"
              disabled={!canEdit || saveState.state === "saving"}
              onClick={() => void handleClear()}
            >
              {t("curation.clearOrder")}
            </Button>
            <Button
              type="button"
              className="rounded-full"
              disabled={!canEdit || !isDirty || saveState.state === "saving"}
              onClick={() => void handleSave()}
            >
              <Save size={16} />
              {t("curation.save")}
            </Button>
          </div>
        </div>

        {/*
         * The selection's controls, on a line of their own and always present.
         * A row that appears when a box is ticked would push every card below
         * it down at the moment the operator is aiming at one.
         */}
        <div className="mt-4 flex h-9 items-center justify-end gap-2 overflow-x-auto">
          {selectedInOrder.length > 0 ? (
            <div className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] px-2">
              <span className="px-1 text-xs font-bold tabular-nums text-white/80">
                {formatTemplate(t("curation.selectedCount"), {
                  count: selectedInOrder.length,
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    orderedIds: moveIdsToFront(
                      current.orderedIds,
                      selectedInOrder,
                    ),
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <ChevronsUp size={12} aria-hidden="true" />
                {t("curation.groupToTop")}
              </button>
              <button
                type="button"
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    orderedIds: moveIdsToBack(
                      current.orderedIds,
                      selectedInOrder,
                    ),
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <ChevronsDown size={12} aria-hidden="true" />
                {t("curation.groupToBottom")}
              </button>
              <button
                type="button"
                onClick={() =>
                  updateDraft((current) => {
                    const hiding = new Set(current.hiddenIds);
                    const allHidden = selectedInOrder.every((itemId) =>
                      hiding.has(itemId),
                    );
                    for (const itemId of selectedInOrder) {
                      if (allHidden) hiding.delete(itemId);
                      else hiding.add(itemId);
                    }
                    return { ...current, hiddenIds: [...hiding] };
                  })
                }
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/10 bg-black/20 px-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <EyeOff size={12} aria-hidden="true" />
                {t("curation.groupHide")}
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="h-7 rounded-lg px-2 text-xs font-semibold text-white/55 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {t("curation.clearSelection")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSelectedIds(new Set(visibleIds))}
              className="h-9 shrink-0 rounded-xl px-2 text-xs font-semibold text-white/40 transition hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {t("curation.selectAllVisible")}
            </button>
          )}
        </div>

        <ul className="mt-3 space-y-3">
          {rowIds.length > 0 ? (
            rowIds.map((itemId) => {
              const entry = entryByItemId.get(itemId);
              if (!entry) return null;

              const { item, index } = entry;
              /*
               * The number on the card is the number a drop would give it,
               * read from the drag's own preview rather than from the draft.
               * Reading it from the draft is what makes badges disagree with
               * the order under the cursor.
               */
              const slot = previewOrder
                ? (windowPositions[previewOrder.indexOf(itemId)] ?? index)
                : index;
              const held = sortable.isActive(itemId);

              return (
                <li
                  key={itemId}
                  ref={sortable.registerRow(itemId)}
                  style={sortable.rowStyle(itemId)}
                  data-curation-slot={slot + 1}
                >
                  <CurationItemRow
                    item={item}
                    artwork={activeSection.artwork}
                    position={slot}
                    hidden={hiddenIds.has(item.Id)}
                    selected={selectedIds.has(item.Id)}
                    held={held}
                    lifted={held || sortable.isSettling(item.Id)}
                    groupSize={selectedInOrder.length}
                    canMoveUp={index > 0}
                    canMoveDown={index < orderedItems.length - 1}
                    onToggleSelected={() => toggleSelected(item.Id)}
                    onGrab={(event) =>
                      sortable.startDrag(event, item.Id, blockFor(item.Id))
                    }
                    onNudge={(direction) =>
                      updateDraft((current) => ({
                        ...current,
                        orderedIds: moveId(
                          current.orderedIds,
                          item.Id,
                          direction,
                        ),
                      }))
                    }
                    onToggleHidden={() =>
                      updateDraft((current) => ({
                        ...current,
                        hiddenIds: toggleId(current.hiddenIds, item.Id),
                      }))
                    }
                    onMoveToTop={() =>
                      updateDraft((current) => ({
                        ...current,
                        orderedIds: moveIdToIndex(
                          current.orderedIds,
                          item.Id,
                          0,
                        ),
                      }))
                    }
                    onMoveUp={() =>
                      updateDraft((current) => ({
                        ...current,
                        orderedIds: moveId(current.orderedIds, item.Id, -1),
                      }))
                    }
                    onMoveDown={() =>
                      updateDraft((current) => ({
                        ...current,
                        orderedIds: moveId(current.orderedIds, item.Id, 1),
                      }))
                    }
                    onMoveToBottom={() =>
                      updateDraft((current) => ({
                        ...current,
                        orderedIds: moveIdToIndex(
                          current.orderedIds,
                          item.Id,
                          current.orderedIds.length - 1,
                        ),
                      }))
                    }
                  />
                </li>
              );
            })
          ) : (
            <li className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-semibold text-white/48">
              {t("curation.noMatches")}
            </li>
          )}
        </ul>

        {matchedItems.length > rowIds.length ? (
          <Button
            type="button"
            variant="secondary"
            className="mt-3 w-full rounded-2xl"
            onClick={() =>
              setVisibleLimit((current) => current + VISIBLE_ROW_LIMIT)
            }
          >
            {formatTemplate(t("curation.showMore"), {
              remaining: matchedItems.length - rowIds.length,
            })}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
