import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronDown,
  Languages,
  Move,
  Plus,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import {
  applyItemArtwork,
  clearItemArtwork,
  getItemArtwork,
  getLocalizedMetadataPreview,
  identifyItem,
  saveItemDisplayMetadata,
  searchMetadataCandidates,
  setBackdropFocus,
  setLogoLayout,
  setSearchNames,
  uploadCustomArtwork,
  type ArtworkCandidate,
  type ArtworkKind,
  type ArtworkOverview,
  type MetadataCandidate,
} from "../lib/artworkApi";
import {
  getAllArtworkItems,
  getItem,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";
import { getDisplayTitle, formatTemplate } from "../lib/format";
import { setPageTitle } from "../lib/pageTitle";
import {
  INITIAL_LOGO_LAYOUT,
  MAX_LOGO_SHADOW,
  MIN_LOGO_SHADOW,
  clampLogoLayout,
  getLogoLayout,
  type LogoLayout,
} from "../lib/logoLayout";
import { LogoLayoutEditor } from "./admin/LogoLayoutEditor";
import { BackdropFocusSection } from "./admin/tmdbArtwork/BackdropFocusSection";
import { notify } from "../lib/notifications/notificationStore";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { describeErrorDetail } from "../lib/userFacingError";
import { TitlePoster } from "../components/admin/TitlePoster";
import {
  ARTWORK_KINDS,
  ARTWORK_PAGE_SIZE,
  getArtworkErrorKey,
  getKindLabelKey,
  getStatusClasses,
  findStoredArtwork,
  getStoredArtworkTag,
  isArtworkEligible,
  languageName,
  nextVisibleCount,
  supportsTmdbArtwork,
  type ActionStatus,
  type ImageLanguageFilter,
  addSearchAlias,
  titleSearchNameChoices,
} from "./admin/tmdbArtworkModel";
import { ArtworkTitleList } from "./admin/tmdbArtwork/ArtworkTitleList";
import { ArtworkKindSection } from "./admin/tmdbArtwork/ArtworkKindSection";
import { LanguageChips } from "./admin/tmdbArtwork/LanguageChips";

/** The languages names and descriptions can be loaded in from TMDB. */
const METADATA_LANGUAGES = ["tr-TR", "en-US"] as const;

const ALL_LANGUAGES: Record<ArtworkKind, ImageLanguageFilter> = {
  poster: "all",
  backdrop: "all",
  logo: "all",
};

/** A per-viewer preference, so storage that throws or is empty means "on". */
const LAYOUT_GUIDES_STORAGE_KEY = "seyirlik-logo-layout-guides";

function readLayoutGuides(): boolean {
  try {
    return localStorage.getItem(LAYOUT_GUIDES_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeLayoutGuides(show: boolean) {
  try {
    localStorage.setItem(LAYOUT_GUIDES_STORAGE_KEY, show ? "on" : "off");
  } catch {
    // Unavailable storage only costs remembering the choice.
  }
}

function errorCodeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

function messageOf(
  error: unknown,
  t: (key: TranslationKey) => string,
  fallback: string,
): string {
  return describeErrorDetail(error, t) || fallback;
}

const sectionCard = "rounded-3xl border border-white/10 bg-white/[0.03] p-5";
const quietButton =
  "inline-flex items-center gap-2 rounded-2xl border border-white/15 px-4 py-2 text-sm font-black text-white/70 transition hover:border-white/30 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const saveButton =
  "inline-flex items-center gap-2 rounded-2xl bg-emerald-400/20 px-4 py-2 text-sm font-black text-emerald-100 transition hover:bg-emerald-400/30 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const field =
  "w-full rounded-2xl border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white outline-none placeholder:text-white/25 focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/**
 * Covers, backdrops, logos and names, one title after another.
 *
 * The list of titles stays beside the editor while the page scrolls through a
 * title's artwork, and each thumbnail in it is drawn as the title's card is, so
 * a change shows in the list the moment it is saved — for that title alone,
 * never by reloading the whole library. Each artwork set chooses its own
 * language.
 *
 * Given an `itemId` this is that title's editor inside the title workspace,
 * with no list of its own.
 */
export default function TmdbArtworkPage({ itemId }: { itemId?: string } = {}) {
  const { t, language: uiLanguage } = useLanguage();

  const [titles, setTitles] = useState<MediaItem[]>([]);
  const [titlesStatus, setTitlesStatus] = useState<ActionStatus>({
    tone: "busy",
    message: t("tmdbArtwork.loadingItems"),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [artwork, setArtwork] = useState<ArtworkOverview | null>(null);
  const [artworkStatus, setArtworkStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });
  const [languages, setLanguages] =
    useState<Record<ArtworkKind, ImageLanguageFilter>>(ALL_LANGUAGES);
  const [busyKind, setBusyKind] = useState<ArtworkKind | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<
    Partial<Record<ArtworkKind, number>>
  >({});
  /** Null until the title is adjusted, matching how the card reads it. */
  const [layout, setLayout] = useState<LogoLayout | null>(null);
  const [showLayoutGuides, setShowLayoutGuides] = useState(readLayoutGuides);
  const [layoutStatus, setLayoutStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });

  const [matchOpen, setMatchOpen] = useState(false);
  const [tmdbQuery, setTmdbQuery] = useState("");
  const [matches, setMatches] = useState<MetadataCandidate[]>([]);
  const [matchStatus, setMatchStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });

  const [display, setDisplay] = useState({
    title: "",
    originalTitle: "",
    overview: "",
    tagline: "",
  });
  const [displayLanguage, setDisplayLanguage] = useState<string | null>(null);
  const [displayStatus, setDisplayStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });

  useEffect(() => {
    if (!itemId)
      setPageTitle(`${t("tmdbArtwork.title")} · Seyirlik`, {
        canonicalPath: "/dev/tmdb-artwork",
        robots: "noindex, nofollow",
      });
  }, [itemId, t]);

  /*
   * The library is read once, and deliberately not keyed on the translator.
   *
   * `t` is only wanted here for the wording of a failure, but naming it as a
   * dependency makes the whole library reload every time its identity changes
   * — which for a page that reads two hundred titles is a real fetch on every
   * language switch, and, given a translator rebuilt per render, a reload that
   * schedules the next one forever. So the effect runs on mount and reads the
   * current translator through a ref.
   */
  const translate = useRef(t);
  useEffect(() => {
    translate.current = t;
  }, [t]);
  useEffect(() => {
    let isMounted = true;
    void (async () => {
      try {
        const items = await getAllArtworkItems();
        if (!isMounted) return;
        setTitles(items.filter(isArtworkEligible));
        setTitlesStatus({ tone: "success", message: "" });
      } catch (error) {
        if (!isMounted) return;
        setTitlesStatus({
          tone: "error",
          message: messageOf(
            error,
            translate.current,
            translate.current("tmdbArtwork.couldNotLoadItems"),
          ),
        });
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const selectedTitle = useMemo(
    () => titles.find((item) => item.Id === selectedId),
    [titles, selectedId],
  );

  /**
   * One title, read again and written back into the list in place.
   *
   * What the list shows for a title — its cover, its logo, where the logo sits
   * and how strong its shadow is — comes from this read, so after any change
   * only that row redraws, and the other two hundred are not fetched again.
   */
  const refreshTitle = useCallback(async (id: string) => {
    try {
      const fresh = await getItem(id);
      setTitles((current) =>
        current.map((entry) =>
          entry.Id === id
            ? {
                ...entry,
                ImageTags: fresh.ImageTags,
                LogoLayout: fresh.LogoLayout ?? null,
                Name: fresh.Name ?? entry.Name,
                OriginalTitle: fresh.OriginalTitle,
                LocalizedTitles: fresh.LocalizedTitles,
                SearchAliases: fresh.SearchAliases,
              }
            : entry,
        ),
      );
    } catch {
      // The editor already reflects the change; the thumbnail waits for the
      // next visit rather than showing an error for a cosmetic refresh.
    }
  }, []);

  const loadArtwork = useCallback(
    async (id: string) => {
      setArtworkStatus({
        tone: "busy",
        message: t("tmdbArtwork.loadingImages"),
      });
      try {
        const overview = await getItemArtwork(id);
        setArtwork(overview);
        setVisibleCounts({});
        setArtworkStatus({ tone: "idle", message: "" });
      } catch (error) {
        setArtwork(null);
        setArtworkStatus({
          tone: "error",
          message: t(getArtworkErrorKey(errorCodeOf(error))),
        });
      }
    },
    [t],
  );

  const selectTitle = useCallback(
    (item: MediaItem) => {
      setSelectedId(item.Id);
      setArtwork(null);
      setLanguages(ALL_LANGUAGES);
      setMatches([]);
      setMatchOpen(false);
      setTmdbQuery(item.Name ?? "");
      setMatchStatus({ tone: "idle", message: "" });
      setDisplay({
        title: item.Name ?? "",
        originalTitle: item.OriginalTitle ?? "",
        overview: item.Overview ?? "",
        tagline: item.Taglines?.[0] ?? "",
      });
      setDisplayLanguage(null);
      setDisplayStatus({ tone: "idle", message: "" });
      setLayout(getLogoLayout(item));
      setLayoutStatus({ tone: "idle", message: "" });
      void loadArtwork(item.Id);
      // Opening a title shows it as it is now, not as the list was loaded.
      void refreshTitle(item.Id);
    },
    [loadArtwork, refreshTitle],
  );

  // Embedded: the workspace names the title, so it is chosen here once loaded.
  const embeddedTitle = itemId
    ? titles.find((item) => item.Id === itemId)
    : undefined;
  useEffect(() => {
    if (embeddedTitle && selectedId !== embeddedTitle.Id)
      selectTitle(embeddedTitle);
  }, [embeddedTitle, selectedId, selectTitle]);

  const selectedSupportsTmdb = supportsTmdbArtwork(selectedTitle);
  const coverTag = artwork
    ? (getStoredArtworkTag(artwork.current, "poster") ?? null)
    : (selectedTitle?.ImageTags?.Primary ?? null);
  const logoTag = artwork
    ? (getStoredArtworkTag(artwork.current, "logo") ?? null)
    : (selectedTitle?.ImageTags?.Logo ?? null);
  // The backdrop the focus is chosen on; until the overview loads, the one
  // the title list knows about.
  const backdrop = artwork
    ? (findStoredArtwork(artwork.current, "backdrop") ?? null)
    : selectedTitle?.BackdropImageTags?.[0]
      ? {
          contentHash: selectedTitle.BackdropImageTags[0],
          focus: selectedTitle.BackdropFocus ?? null,
        }
      : null;

  /**
   * Saves the focus and keeps the page's copy of the stored backdrop in step,
   * so leaving and coming back to the section shows what was saved.
   */
  async function handleSaveFocus(next: { x: number; y: number } | null) {
    if (!selectedId) return;
    const id = selectedId;
    await setBackdropFocus(id, next);
    setArtwork((current) =>
      current && current.item.id === id
        ? {
            ...current,
            current: current.current.map((image) =>
              image.imageType === "backdrop" && image.imageIndex === 0
                ? { ...image, focus: next }
                : image,
            ),
          }
        : current,
    );
    await refreshTitle(id);
  }

  async function handleTmdbSearch(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    if (!tmdbQuery.trim()) {
      setMatchStatus({
        tone: "error",
        message: t("tmdbArtwork.searchRequired"),
      });
      return;
    }
    setMatchStatus({ tone: "busy", message: t("tmdbArtwork.searchingTmdb") });
    try {
      const result = await searchMetadataCandidates(selectedId, tmdbQuery);
      setMatches(result.candidates);
      setMatchStatus({
        tone: result.candidates.length > 0 ? "success" : "idle",
        message:
          result.candidates.length > 0
            ? formatTemplate(t("tmdbArtwork.searchResults"), {
                count: result.candidates.length,
              })
            : t("tmdbArtwork.noSearchResults"),
      });
    } catch (error) {
      setMatchStatus({
        tone: "error",
        message: messageOf(error, t, t("tmdbArtwork.couldNotSearch")),
      });
    }
  }

  async function handleIdentify(providerId: string) {
    if (!selectedId) return;
    setMatchStatus({ tone: "busy", message: t("tmdbArtwork.identifying") });
    try {
      await identifyItem(selectedId, providerId);
      setMatchStatus({
        tone: "success",
        message: t("tmdbArtwork.identifySaved"),
      });
      setMatches([]);
      setMatchOpen(false);
      await loadArtwork(selectedId);
      await refreshTitle(selectedId);
    } catch (error) {
      setMatchStatus({
        tone: "error",
        message: messageOf(error, t, t("tmdbArtwork.couldNotIdentify")),
      });
    }
  }

  /** Every artwork change ends the same way: reload the sets, redraw this row. */
  async function changeArtwork(
    kind: ArtworkKind,
    busyMessage: string,
    work: (id: string) => Promise<unknown>,
    doneMessage: string,
    failMessage: string,
  ) {
    if (!selectedId) return;
    const id = selectedId;
    setBusyKind(kind);
    setArtworkStatus({ tone: "busy", message: busyMessage });
    try {
      await work(id);
      await loadArtwork(id);
      await refreshTitle(id);
      setArtworkStatus({ tone: "success", message: doneMessage });
    } catch (error) {
      const message = messageOf(error, t, failMessage);
      setArtworkStatus({ tone: "error", message });
      notify({
        tone: "error",
        title: t("feedback.artworkFailed"),
        description: message,
      });
    } finally {
      setBusyKind(null);
    }
  }

  const handleApply = (kind: ArtworkKind, candidate: ArtworkCandidate) =>
    changeArtwork(
      kind,
      t("tmdbArtwork.savingArtwork"),
      (id) => applyItemArtwork(id, { kind, filePath: candidate.filePath }),
      t("tmdbArtwork.artworkApplied"),
      t("tmdbArtwork.couldNotSaveArtwork"),
    );
  const handleRevert = (kind: ArtworkKind) =>
    changeArtwork(
      kind,
      t("tmdbArtwork.revertingArtwork"),
      (id) => clearItemArtwork(id, kind),
      t("tmdbArtwork.artworkReverted"),
      t("tmdbArtwork.couldNotRevertArtwork"),
    );
  const handleUpload = (kind: ArtworkKind, file: File) =>
    changeArtwork(
      kind,
      t("tmdbArtwork.uploadingCustom"),
      (id) => uploadCustomArtwork(id, kind, file),
      t("tmdbArtwork.customArtworkSaved"),
      t("tmdbArtwork.customArtworkFailed"),
    );

  async function handleLoadLocalized(language: string) {
    if (!selectedId) return;
    setDisplayLanguage(language);
    setDisplayStatus({
      tone: "busy",
      message: t("tmdbArtwork.loadingItemMetadata"),
    });
    try {
      const preview = await getLocalizedMetadataPreview(selectedId, language);
      setDisplay({
        title: preview.title,
        originalTitle: preview.originalTitle ?? "",
        overview: preview.overview ?? "",
        tagline: preview.tagline ?? "",
      });
      setDisplayStatus({
        tone: "success",
        message: t("tmdbArtwork.itemMetadataLoaded"),
      });
    } catch (error) {
      setDisplayStatus({
        tone: "error",
        message:
          errorCodeOf(error) === "PROVIDER_ID_MISSING"
            ? t("tmdbArtwork.itemMetadataRequiresMatch")
            : messageOf(error, t, t("tmdbArtwork.couldNotLoadItemMetadata")),
      });
    }
  }

  /**
   * Saves on release rather than on every pointer move: a drag produces
   * hundreds of positions and only the one it ends on is a decision.
   */
  async function handleSaveLayout(next: LogoLayout | null) {
    if (!selectedId) return;
    const id = selectedId;
    setLayoutStatus({ tone: "busy", message: t("logoLayout.saving") });
    try {
      await setLogoLayout(id, next);
      setLayout(next);
      setTitles((current) =>
        current.map((entry) =>
          entry.Id === id ? { ...entry, LogoLayout: next } : entry,
        ),
      );
      setLayoutStatus({
        tone: "success",
        message: next ? t("logoLayout.saved") : t("logoLayout.cleared"),
      });
    } catch (error) {
      setLayoutStatus({
        tone: "error",
        message: messageOf(error, t, t("logoLayout.couldNotSave")),
      });
    }
  }

  /** Saves the title's own search names and keeps the list the server kept. */
  async function handleSaveSearchNames(names: string[]) {
    if (!selectedId) return;
    const id = selectedId;
    const kept = await setSearchNames(id, names);
    setTitles((current) =>
      current.map((entry) =>
        entry.Id === id ? { ...entry, SearchAliases: kept } : entry,
      ),
    );
  }

  async function handleSaveDisplay(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    const id = selectedId;
    setDisplayStatus({
      tone: "busy",
      message: t("tmdbArtwork.savingItemMetadata"),
    });
    try {
      await saveItemDisplayMetadata(id, {
        ...(display.title.trim() ? { title: display.title.trim() } : {}),
        ...(display.originalTitle.trim()
          ? { originalTitle: display.originalTitle.trim() }
          : {}),
        ...(display.overview.trim()
          ? { overview: display.overview.trim() }
          : {}),
        ...(display.tagline.trim() ? { tagline: display.tagline.trim() } : {}),
        // Locking is what makes the edit stick: without it the next refresh
        // writes the provider's own wording back over it.
        lockFields: ["title", "overview", "tagline"],
      });
      setDisplayStatus({
        tone: "success",
        message: t("tmdbArtwork.itemMetadataSaved"),
      });
      await refreshTitle(id);
    } catch (error) {
      setDisplayStatus({
        tone: "error",
        message: messageOf(error, t, t("tmdbArtwork.couldNotLoadItemMetadata")),
      });
    }
  }

  const current = layout ?? INITIAL_LOGO_LAYOUT;
  const sections: Array<{ id: string; label: string }> = [
    ...ARTWORK_KINDS.map((kind) => ({
      id: `artwork-${kind}`,
      label: t(getKindLabelKey(kind)),
    })),
    { id: "artwork-placement", label: t("logoLayout.title") },
    { id: "artwork-focus", label: t("backdropFocus.title") },
    { id: "artwork-names", label: t("tmdbArtwork.itemMetadata") },
  ];

  const editor = !selectedTitle ? (
    <p className={`${sectionCard} text-sm font-bold text-white/40`}>
      {itemId && titlesStatus.tone === "success"
        ? t("library.noArtwork")
        : t("tmdbArtwork.noItemSelected")}
    </p>
  ) : (
    <div className="min-w-0 space-y-6">
      {/* The title as its card will look, with the placement being edited. */}
      <section className={`${sectionCard} flex flex-wrap gap-5`}>
        <TitlePoster
          itemId={selectedTitle.Id}
          title={getDisplayTitle(selectedTitle)}
          artwork={{ coverTag, logoTag, logoLayout: layout }}
          width={128}
          className="rounded-2xl"
        />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-2xl font-black text-white">
            {getDisplayTitle(selectedTitle)}
            {selectedTitle.ProductionYear ? (
              <span className="font-bold text-white/40">
                {" "}
                ({selectedTitle.ProductionYear})
              </span>
            ) : null}
          </h2>
          {artwork?.item.providerId ? (
            <p className="mt-1 text-xs font-bold text-emerald-300/80">
              {formatTemplate(t("tmdbArtwork.selectedTmdb"), {
                id: artwork.item.providerId,
              })}
            </p>
          ) : null}
          {artworkStatus.message ? (
            <p
              role={artworkStatus.tone === "error" ? "alert" : "status"}
              className={`mt-2 text-xs font-bold ${getStatusClasses(artworkStatus.tone)}`}
            >
              {artworkStatus.message}
            </p>
          ) : null}

          {selectedSupportsTmdb ? (
            <div className="mt-3">
              <button
                type="button"
                aria-expanded={matchOpen}
                onClick={() => setMatchOpen((open) => !open)}
                className={quietButton}
              >
                <ChevronDown
                  className={`h-4 w-4 transition ${matchOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
                {t("tmdbArtwork.changeMatch")}
              </button>
              {matchOpen ? (
                <div className="mt-3 space-y-2">
                  <form onSubmit={handleTmdbSearch} className="flex gap-2">
                    <label className="sr-only" htmlFor="tmdb-query">
                      {t("tmdbArtwork.searchQuery")}
                    </label>
                    <input
                      id="tmdb-query"
                      value={tmdbQuery}
                      onChange={(event) => setTmdbQuery(event.target.value)}
                      placeholder={t("tmdbArtwork.tmdbSearchPlaceholder")}
                      className={`${field} flex-1`}
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-2xl bg-sky-400/20 px-4 py-2 text-sm font-black text-sky-100 transition hover:bg-sky-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <Search className="h-4 w-4" aria-hidden="true" />
                      {t("tmdbArtwork.searchQuery")}
                    </button>
                  </form>
                  {matchStatus.message ? (
                    <p
                      className={`text-xs font-bold ${getStatusClasses(matchStatus.tone)}`}
                    >
                      {matchStatus.message}
                    </p>
                  ) : null}
                  <ul className="space-y-1">
                    {matches.map((match) => (
                      <li key={match.providerId}>
                        <button
                          type="button"
                          onClick={() => void handleIdentify(match.providerId)}
                          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 px-3 py-2 text-left transition hover:border-sky-300/40 hover:bg-sky-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold">
                              {match.title}
                              {match.year ? ` (${match.year})` : ""}
                            </span>
                            <span className="block text-xs font-semibold text-white/35">
                              TMDB {match.providerId}
                              {match.originalTitle
                                ? ` · ${match.originalTitle}`
                                : ""}
                            </span>
                          </span>
                          <Check
                            className="h-4 w-4 shrink-0 text-white/30"
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm font-bold text-white/40">
              {t("tmdbArtwork.tmdbUnavailableForBooks")}
            </p>
          )}

          <nav
            aria-label={t("tmdbArtwork.jumpTo")}
            className="mt-4 flex flex-wrap gap-1.5"
          >
            {sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-white/60 transition hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {section.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      {artwork ? (
        ARTWORK_KINDS.map((kind) => (
          <ArtworkKindSection
            key={kind}
            kind={kind}
            artwork={artwork}
            language={languages[kind]}
            onLanguage={(value) => {
              setLanguages((all) => ({ ...all, [kind]: value }));
              // A new language draws a new pool, so how far the previous one
              // had been paged through no longer means anything.
              setVisibleCounts((counts) => ({ ...counts, [kind]: undefined }));
            }}
            visible={visibleCounts[kind] ?? ARTWORK_PAGE_SIZE}
            onMore={() =>
              setVisibleCounts((counts) => ({
                ...counts,
                [kind]: nextVisibleCount(
                  counts[kind] ?? ARTWORK_PAGE_SIZE,
                  artwork.candidates.length,
                ),
              }))
            }
            busyKind={busyKind}
            onApply={(candidate) => void handleApply(kind, candidate)}
            onRevert={() => void handleRevert(kind)}
            onUpload={(file) => void handleUpload(kind, file)}
          />
        ))
      ) : artworkStatus.tone === "busy" ? (
        <p
          role="status"
          className={`${sectionCard} text-sm font-bold text-white/40`}
        >
          {t("tmdbArtwork.loadingImages")}
        </p>
      ) : null}

      <section
        id="artwork-placement"
        aria-labelledby="artwork-placement-title"
        className={`${sectionCard} scroll-mt-28`}
      >
        <h2
          id="artwork-placement-title"
          className="flex items-center gap-2 text-base font-black text-white"
        >
          <Move className="h-4 w-4 text-white/35" aria-hidden="true" />
          {t("logoLayout.title")}
        </h2>
        <p className="mt-1 text-xs font-semibold text-white/40">
          {t("logoLayout.description")}
        </p>
        {!logoTag ? (
          <p className="mt-3 text-sm font-bold text-white/40">
            {t("logoLayout.noLogo")}
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-start gap-6">
            <LogoLayoutEditor
              posterUrl={getPrimaryImageUrl(
                selectedTitle.Id,
                coverTag ?? undefined,
                600,
              )}
              logoUrl={getLogoImageUrl(selectedTitle.Id, logoTag, 520)}
              title={getDisplayTitle(selectedTitle)}
              layout={current}
              onChange={setLayout}
              disabled={layoutStatus.tone === "busy"}
              showGuides={showLayoutGuides}
            />
            <div className="min-w-[16rem] flex-1">
              <p className="text-xs font-semibold leading-6 text-white/45">
                {t("logoLayout.instructions")}
              </p>
              <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                {(
                  [
                    ["logoLayout.horizontal", current.x],
                    ["logoLayout.vertical", current.y],
                    ["logoLayout.size", current.width],
                    ["logoLayout.shadow", current.shadow / MAX_LOGO_SHADOW],
                  ] as const
                ).map(([labelKey, value]) => (
                  <div
                    key={labelKey}
                    className="rounded-2xl border border-white/10 bg-black/40 px-2 py-2"
                  >
                    <dt className="text-[0.62rem] font-black uppercase tracking-[0.1em] text-white/35">
                      {t(labelKey)}
                    </dt>
                    <dd className="mt-0.5 text-sm font-black tabular-nums text-white/80">
                      {Math.round(value * 100)}%
                    </dd>
                  </div>
                ))}
              </dl>
              <label className="mt-4 block">
                <span className="text-[0.62rem] font-black uppercase tracking-[0.1em] text-white/35">
                  {t("logoLayout.shadowStrength")}
                </span>
                <input
                  type="range"
                  min={MIN_LOGO_SHADOW}
                  max={MAX_LOGO_SHADOW}
                  step={0.05}
                  value={current.shadow}
                  disabled={layoutStatus.tone === "busy"}
                  onChange={(event) =>
                    setLayout(
                      clampLogoLayout({
                        ...current,
                        shadow: Number(event.target.value),
                      }),
                    )
                  }
                  className="mt-1 w-full accent-sky-300"
                />
                <span className="text-[0.68rem] font-semibold text-white/40">
                  {t("logoLayout.shadowHint")}
                </span>
              </label>
              <div className="mt-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <span className="text-[0.62rem] font-black uppercase tracking-[0.1em] text-white/35">
                    {t("logoLayout.guides")}
                  </span>
                  <p className="text-[0.68rem] font-semibold text-white/40">
                    {t("logoLayout.guidesHint")}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showLayoutGuides}
                  aria-label={t("logoLayout.guides")}
                  onClick={() => {
                    const next = !showLayoutGuides;
                    setShowLayoutGuides(next);
                    writeLayoutGuides(next);
                  }}
                  className={`relative h-6 w-11 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 ${
                    showLayoutGuides
                      ? "border-sky-300/60 bg-sky-300"
                      : "border-white/15 bg-white/10"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      showLayoutGuides
                        ? "translate-x-[22px]"
                        : "translate-x-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={layoutStatus.tone === "busy"}
                  onClick={() => void handleSaveLayout(current)}
                  className={saveButton}
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {t("logoLayout.save")}
                </button>
                <button
                  type="button"
                  disabled={layoutStatus.tone === "busy" || !layout}
                  onClick={() => void handleSaveLayout(null)}
                  className={quietButton}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  {t("logoLayout.reset")}
                </button>
              </div>
              {layoutStatus.message ? (
                <p
                  className={`mt-2 text-xs font-bold ${getStatusClasses(layoutStatus.tone)}`}
                >
                  {layoutStatus.message}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <BackdropFocusSection
        key={`${selectedTitle.Id}:${backdrop?.contentHash ?? ""}`}
        itemId={selectedTitle.Id}
        backdropTag={backdrop?.contentHash ?? null}
        savedFocus={backdrop?.focus ?? null}
        onSave={handleSaveFocus}
        className={sectionCard}
      />

      <section
        id="artwork-names"
        aria-labelledby="artwork-names-title"
        className={`${sectionCard} scroll-mt-28`}
      >
        <h2
          id="artwork-names-title"
          className="text-base font-black text-white"
        >
          {t("tmdbArtwork.itemMetadata")}
        </h2>
        <p className="mt-1 text-xs font-semibold text-white/40">
          {t("tmdbArtwork.itemLanguagesDescription")}
        </p>
        {selectedSupportsTmdb ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Languages className="h-4 w-4 text-white/35" aria-hidden="true" />
            <LanguageChips
              label={t("tmdbArtwork.metadataLanguage")}
              value={displayLanguage ?? ""}
              onChange={(value) => void handleLoadLocalized(value)}
              options={METADATA_LANGUAGES.map((language) => ({
                value: language,
                count: 0,
              }))}
              describe={(value) => languageName(value.slice(0, 2), uiLanguage)}
            />
          </div>
        ) : null}
        {displayStatus.message ? (
          <p
            role={displayStatus.tone === "error" ? "alert" : "status"}
            className={`mt-2 text-xs font-bold ${getStatusClasses(displayStatus.tone)}`}
          >
            {displayStatus.message}
          </p>
        ) : null}
        <form onSubmit={handleSaveDisplay} className="mt-4 space-y-3">
          <label className="block text-xs font-bold text-white/50">
            {t("tmdbArtwork.fieldTitle")}
            <input
              value={display.title}
              onChange={(event) =>
                setDisplay((value) => ({ ...value, title: event.target.value }))
              }
              className={`${field} mt-1`}
            />
          </label>
          {selectedTitle ? (
            <TitleSearchNames
              key={selectedTitle.Id}
              item={selectedTitle}
              providerNames={selectedSupportsTmdb}
              current={display.title}
              onUse={(name) =>
                setDisplay((value) => ({ ...value, title: name }))
              }
              onSave={handleSaveSearchNames}
            />
          ) : null}
          <label className="block text-xs font-bold text-white/50">
            {t("tmdbArtwork.fieldTagline")}
            <input
              value={display.tagline}
              onChange={(event) =>
                setDisplay((value) => ({
                  ...value,
                  tagline: event.target.value,
                }))
              }
              className={`${field} mt-1`}
            />
          </label>
          <label className="block text-xs font-bold text-white/50">
            {t("tmdbArtwork.fieldOverview")}
            <textarea
              value={display.overview}
              onChange={(event) =>
                setDisplay((value) => ({
                  ...value,
                  overview: event.target.value,
                }))
              }
              rows={5}
              className={`${field} mt-1 leading-6`}
            />
          </label>
          <button type="submit" className={saveButton}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {t("tmdbArtwork.saveItemDisplay")}
          </button>
        </form>
      </section>
    </div>
  );

  if (itemId) return <div className="text-white">{editor}</div>;

  return (
    <div className="w-full space-y-6 text-white">
      <header>
        <h1 className="text-3xl font-black text-white">
          {t("tmdbArtwork.title")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm font-semibold text-white/50">
          {t("tmdbArtwork.description")}
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <ArtworkTitleList
          titles={titles}
          status={titlesStatus}
          selectedId={selectedId}
          onSelect={selectTitle}
        />
        {editor}
      </div>
    </div>
  );
}

/**
 * The names search finds a title by besides the one it is shown under.
 *
 * Typing a title of one's own replaces the shown one and nothing else: search
 * keeps the original and TMDB's Turkish and English names. Listing them here
 * says so, and each one is a shortcut to showing it instead.
 *
 * TMDB lists one name per language, so a film released under another title
 * elsewhere ("Salazar's Revenge" for "Dead Men Tell No Tales") is added here
 * by hand. Those names are saved as soon as they are added or removed, apart
 * from the title form below, and no TMDB refresh touches them.
 */
function TitleSearchNames({
  item,
  providerNames,
  current,
  onUse,
  onSave,
}: {
  item: MediaItem;
  /** Whether the title has TMDB names to list: films and series do. */
  providerNames: boolean;
  current: string;
  onUse: (name: string) => void;
  onSave: (names: string[]) => Promise<void>;
}) {
  const { t, language: uiLanguage } = useLanguage();
  const names = providerNames ? titleSearchNameChoices(item) : [];
  const added = item.SearchAliases ?? [];
  const read = Object.keys(item.LocalizedTitles ?? {}).length > 0;
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });
  const saving = status.tone === "busy";

  async function save(next: string[]): Promise<boolean> {
    setStatus({ tone: "busy", message: t("tmdbArtwork.savingSearchNames") });
    try {
      await onSave(next);
      setStatus({ tone: "success", message: t("tmdbArtwork.searchNamesSaved") });
      return true;
    } catch (error) {
      setStatus({
        tone: "error",
        message: messageOf(error, t, t("tmdbArtwork.couldNotSaveSearchNames")),
      });
      return false;
    }
  }

  function add() {
    const addition = addSearchAlias(item, draft);
    if (addition.kind === "empty") return;
    if (addition.kind === "known") {
      setStatus({ tone: "error", message: t("tmdbArtwork.searchNameKnown") });
      return;
    }
    void save(addition.names).then((saved) => {
      if (saved) setDraft("");
    });
  }

  const chip = (chosen: boolean) =>
    `inline-flex max-w-full items-stretch rounded-xl border text-xs font-semibold transition ${
      chosen
        ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-100"
        : "border-white/10 bg-black/30 text-white/80 hover:border-white/25 hover:text-white"
    }`;
  const useButton =
    "inline-flex min-w-0 items-baseline gap-1.5 rounded-xl px-2.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
  const sourceLabel =
    "shrink-0 text-[0.62rem] font-black uppercase tracking-[0.08em] text-white/40";

  return (
    <div className="-mt-1">
      <p className="text-xs font-bold text-white/50">
        {t("tmdbArtwork.searchNames")}
      </p>
      {names.length > 0 || added.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {names.map((name) => {
            const chosen = current.trim() === name.value;
            return (
              <li
                key={`${name.source}:${name.value}`}
                className={`min-w-0 ${chip(chosen)}`}
              >
                <button
                  type="button"
                  onClick={() => onUse(name.value)}
                  aria-pressed={chosen}
                  aria-label={formatTemplate(t("tmdbArtwork.useAsTitle"), {
                    name: name.value,
                  })}
                  className={useButton}
                >
                  <span className={sourceLabel}>
                    {name.source === "original"
                      ? t("tmdbArtwork.searchNameOriginal")
                      : languageName(name.source, uiLanguage)}
                  </span>
                  <span className="min-w-0 break-words">{name.value}</span>
                </button>
              </li>
            );
          })}
          {added.map((name) => {
            const chosen = current.trim() === name;
            return (
              <li key={`added:${name}`} className={`min-w-0 ${chip(chosen)}`}>
                <button
                  type="button"
                  onClick={() => onUse(name)}
                  aria-pressed={chosen}
                  aria-label={formatTemplate(t("tmdbArtwork.useAsTitle"), {
                    name,
                  })}
                  className={useButton}
                >
                  <span className={sourceLabel}>
                    {t("tmdbArtwork.searchNameAdded")}
                  </span>
                  <span className="min-w-0 break-words">{name}</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void save(added.filter((entry) => entry !== name))
                  }
                  aria-label={formatTemplate(
                    t("tmdbArtwork.removeSearchName"),
                    { name },
                  )}
                  className="grid shrink-0 place-items-center rounded-xl px-1.5 text-white/40 transition hover:text-rose-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="mt-2 flex gap-2">
        <label className="sr-only" htmlFor="search-name-draft">
          {t("tmdbArtwork.addSearchName")}
        </label>
        <input
          id="search-name-draft"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // The field sits inside the title form; Enter adds the name rather
            // than saving the title.
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!saving) add();
          }}
          placeholder={t("tmdbArtwork.addSearchName")}
          className={`${field} flex-1 py-1.5 text-xs`}
        />
        <button
          type="button"
          disabled={saving || !draft.trim()}
          onClick={add}
          className="inline-flex items-center gap-1.5 rounded-2xl border border-white/15 px-3 py-1.5 text-xs font-black text-white/70 transition hover:border-white/30 hover:text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t("tmdbArtwork.addSearchNameButton")}
        </button>
      </div>
      {status.message ? (
        <p
          role={status.tone === "error" ? "alert" : "status"}
          className={`mt-1.5 text-xs font-bold ${getStatusClasses(status.tone)}`}
        >
          {status.message}
        </p>
      ) : null}
      <p className="mt-1.5 text-[0.7rem] font-semibold leading-5 text-white/35">
        {providerNames
          ? `${t(
              read
                ? "tmdbArtwork.searchNamesHint"
                : "tmdbArtwork.searchNamesMissing",
            )} ${t("tmdbArtwork.searchNamesAddedHint")}`
          : t("tmdbArtwork.searchNamesAddedHint")}
      </p>
    </div>
  );
}
