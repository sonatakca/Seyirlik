import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Captions,
  ChevronDown,
  Download,
  Images,
  Timer,
  Trash2,
} from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  getLibraryTitle,
  importMissingArtwork,
  listLibraryTitles,
  toneOf,
  type HoldingTone,
  type LibraryTitle,
  type LibraryTitleDetail,
  type LibraryTitleKind,
} from "../../lib/libraryAdminApi";
import { releaseSearchUrl } from "../../lib/wantedApi";
import { downloadInventory } from "../../lib/inventoryExport";
import { RemoveTitleDialog } from "./RemoveTitleDialog";
import { onTitleRemoved } from "./titleRemovalProgress";
import { TitlePoster } from "./TitlePoster";
import { Tooltip } from "../ui/Tooltip";
import { TitleSeasons } from "./TitleSeasons";
import {
  SubtitleUploadButton,
  SubtitleUploadPolicyFields,
  type SubtitleUploadPolicy,
} from "./SubtitleUploadControl";
import { SubtitleSyncPanel } from "./SubtitleSyncPanel";
import { Facts, NoticeLine, StatusPill } from "./libraryPresentation";
import { actionButton, TONE_STYLE } from "./libraryStyle";
import { useTitleActions } from "./useTitleActions";

/**
 * Everything the library holds or wants.
 *
 * The list is the way into a title: its name opens the title's workspace,
 * where everything that can be done to one film or show lives. The quick
 * actions here are the ones worth doing without opening it.
 */

const KINDS: LibraryTitleKind[] = ["movie", "series", "book"];
const TONES: HoldingTone[] = ["held", "downloading", "wanted", "absent"];
const KIND_LABEL: Record<LibraryTitleKind, TranslationKey> = {
  movie: "library.movies",
  series: "library.shows",
  book: "library.books",
};

type Titles = Record<LibraryTitleKind, LibraryTitle[] | null>;

async function fetchAll({ background = false } = {}): Promise<Titles> {
  const [movie, series, book] = await Promise.all(
    KINDS.map((kind) => listLibraryTitles(kind, { background })),
  );
  return { movie: movie!, series: series!, book: book! };
}

function SeasonsInline({
  title,
  actions,
  uploadPolicy,
}: {
  title: LibraryTitle;
  actions: ReturnType<typeof useTitleActions>;
  uploadPolicy: SubtitleUploadPolicy;
}) {
  const { t } = useLanguage();
  const [detail, setDetail] = useState<LibraryTitleDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getLibraryTitle(title.id)
      .then((value) => !cancelled && setDetail(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [title.id]);
  if (failed)
    return (
      <p role="alert" className="text-xs text-red-200">
        {t("library.detailFailed")}
      </p>
    );
  if (!detail)
    return (
      <p role="status" className="text-xs text-white/50">
        {t("library.loading")}
      </p>
    );
  return (
    <TitleSeasons
      detail={detail}
      actions={{
        busy: actions.busy !== null,
        onSubtitles: (itemId) => void actions.findSubtitles(itemId),
        onTrickplay: (itemId) => void actions.trickplay(itemId),
        onUploadSubtitle: (itemId, file) =>
          void actions.uploadSubtitle(itemId, file, uploadPolicy),
        onSynced: () => getLibraryTitle(title.id).then(setDetail),
      }}
    />
  );
}

export function LibraryBoard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { t } = useLanguage();
  const [kind, setKind] = useState<LibraryTitleKind>("movie");
  /*
   * Chosen once for the board rather than on every row. Subtitles are added a
   * file at a time to a season being worked through, and asking for the
   * language again on each of them is the same answer typed ten times.
   */
  const [uploadPolicy, setUploadPolicy] = useState<SubtitleUploadPolicy>({
    language: "tur",
    forced: false,
    replace: false,
  });
  const [titles, setTitles] = useState<Titles>({
    movie: null,
    series: null,
    book: null,
  });
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<HoldingTone | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryTitle | null>(null);
  /** The film whose subtitle sync panel is open under its row. */
  const [syncing, setSyncing] = useState<string | null>(null);

  const reload = async () => {
    try {
      setTitles(await fetchAll());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  const actions = useTitleActions(reload);

  // The row goes as soon as the catalogue lets go, however the dialog was left.
  useEffect(
    () =>
      onTitleRemoved((itemId) => {
        setOpen((current) => (current === itemId ? null : current));
        setTitles((current) => ({
          movie: current.movie?.filter((title) => title.id !== itemId) ?? null,
          series:
            current.series?.filter((title) => title.id !== itemId) ?? null,
          book: current.book?.filter((title) => title.id !== itemId) ?? null,
        }));
      }),
    [],
  );

  /*
   * Once per visit: a matched title with no readable cover gets its TMDB
   * artwork. The server dedupes the refreshes, so a second visit while they
   * run queues nothing, and the list's own polling shows the posters arrive.
   */
  const artworkAsked = useRef(false);
  const missingArtwork = KINDS.flatMap((value) => titles[value] ?? []).filter(
    (title) => title.kind !== "book" && title.tmdbId && title.artwork.missing,
  ).length;
  useEffect(() => {
    if (artworkAsked.current || missingArtwork === 0) return;
    artworkAsked.current = true;
    void importMissingArtwork()
      .then(({ queued }) => {
        if (queued > 0)
          actions.setNotice({
            tone: "ok",
            text: `${t("library.artworkImporting")} ${queued}`,
          });
      })
      .catch(() => undefined);
  }, [actions, missingArtwork, t]);

  useEffect(() => {
    let cancelled = false;
    const refresh = (background: boolean) =>
      void fetchAll({ background })
        .then((value) => {
          if (cancelled) return;
          setTitles(value);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    refresh(false);
    const interval = window.setInterval(() => refresh(true), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey]);

  const current = titles[kind];
  const counts = useMemo(() => {
    const result: Record<HoldingTone, number> = {
      held: 0,
      downloading: 0,
      wanted: 0,
      absent: 0,
      unaired: 0,
    };
    for (const title of current ?? [])
      result[toneOf(title, title.desired)] += 1;
    return result;
  }, [current]);
  const visible = (current ?? []).filter(
    (title) =>
      (filter === "all" || toneOf(title, title.desired) === filter) &&
      title.title
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const everything = KINDS.flatMap((value) => titles[value] ?? []);

  return (
    <section
      className="space-y-4 border-t border-white/10 pt-6"
      aria-labelledby="library-board-title"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="library-board-title" className="text-xl font-bold text-white">
            {t("library.title")}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-white/65">
            {t("library.description")}
          </p>
        </div>
        <div className="flex gap-2">
          {(["csv", "json"] as const).map((format) => (
            <Tooltip
              key={format}
              content={t(
                format === "csv" ? "library.exportCsv" : "library.exportJson",
              )}
            >
              <button
                type="button"
                className={actionButton}
                disabled={everything.length === 0}
                onClick={() => downloadInventory(everything, format)}
              >
                <Download size={13} aria-hidden="true" />
                {format.toUpperCase()}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label={t("library.title")}
      >
        {KINDS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              setKind(value);
              setOpen(null);
            }}
            className={`min-h-11 rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              kind === value
                ? "bg-white/15 ring-1 ring-white/50"
                : "bg-black/30"
            }`}
          >
            {t(KIND_LABEL[value])}{" "}
            <span className="tabular-nums text-white/55">
              {titles[value]?.length ?? "…"}
            </span>
          </button>
        ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t("media.statusFilter")}
      >
        <button
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
          className={`rounded-full px-3 py-1 text-xs font-bold ${filter === "all" ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`}
        >
          {t("wanted.allStatuses")}
        </button>
        {TONES.map((tone) => (
          <button
            key={tone}
            type="button"
            aria-pressed={filter === tone}
            onClick={() => setFilter(filter === tone ? "all" : tone)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${filter === tone ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`}
          >
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${TONE_STYLE[tone].dot}`}
            />
            {t(`library.tone.${tone}` as TranslationKey)}
            <span className="tabular-nums text-white/45">{counts[tone]}</span>
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("library.filter")}
          aria-label={t("library.filter")}
          className="ml-auto min-h-9 w-full max-w-xs rounded-lg border border-white/15 bg-black/30 px-3 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:w-auto"
        />
      </div>

      {kind !== "book" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <Captions size={14} aria-hidden="true" className="text-white/40" />
          <span className="text-xs font-black uppercase tracking-[0.12em] text-white/45">
            {t("library.uploadSubtitle")}
          </span>
          <SubtitleUploadPolicyFields
            policy={uploadPolicy}
            onChange={setUploadPolicy}
            disabled={actions.busy !== null}
          />
          <p className="w-full text-xs font-semibold text-white/35">
            {t("library.uploadSubtitleHint")}
          </p>
        </div>
      ) : null}

      <NoticeLine notice={actions.notice} />

      {failed ? (
        <p role="alert" className="text-red-200">
          {t("library.loadFailed")}
        </p>
      ) : current === null ? (
        <p role="status" className="text-white/60">
          {t("library.loading")}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-white/55">{t("library.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((title) => {
            const tone = toneOf(title, title.desired);
            const expanded = open === title.id;
            return (
              <li
                key={title.id}
                className={`rounded-xl border p-3 ${TONE_STYLE[tone].card}`}
              >
                <div className="flex gap-3">
                  <TitlePoster
                    itemId={title.id}
                    title={title.title}
                    artwork={title.artwork}
                    width={48}
                    className="rounded-md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="break-words font-bold text-white">
                        <Link
                          to={`/admin/library/${title.id}`}
                          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                        >
                          {title.title}
                        </Link>
                        {title.year ? (
                          <span className="font-semibold text-white/50">
                            {" "}
                            ({title.year})
                          </span>
                        ) : null}
                      </h3>
                      <StatusPill tone={tone} />
                      {title.kind === "series" && title.episodeCount > 0 ? (
                        <span className="text-xs font-bold tabular-nums text-white/55">
                          {title.availableEpisodeCount}/{title.episodeCount}{" "}
                          {t("library.episodes")}
                        </span>
                      ) : null}
                      {tone === "held" && title.downloading > 0 ? (
                        <StatusPill tone="downloading" />
                      ) : null}
                    </div>
                    <Facts facts={title} />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {title.kind === "series" ? (
                        <button
                          type="button"
                          className={actionButton}
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : title.id)}
                        >
                          <ChevronDown
                            size={13}
                            aria-hidden="true"
                            className={expanded ? "rotate-180" : ""}
                          />
                          {t("library.seasons")}
                        </button>
                      ) : null}
                      {title.kind !== "book" ? (
                        <>
                          <button
                            type="button"
                            className={actionButton}
                            disabled={actions.busy !== null}
                            onClick={() =>
                              void actions.toggleWanted(title.id, title.desired)
                            }
                          >
                            {t(
                              title.desired ? "wanted.unmonitor" : "wanted.add",
                            )}
                          </button>
                          <Link
                            className={actionButton}
                            to={releaseSearchUrl({
                              ...title,
                              kind: title.kind as "movie" | "series",
                              year: title.year ?? undefined,
                            })}
                          >
                            {t("wanted.releases")}
                          </Link>
                        </>
                      ) : null}
                      {title.files > 0 ? (
                        <>
                          <button
                            type="button"
                            className={actionButton}
                            disabled={actions.busy !== null}
                            onClick={() => void actions.trickplay(title.id)}
                          >
                            <Images size={13} aria-hidden="true" />
                            {t("library.generateTrickplay")}
                          </button>
                          <button
                            type="button"
                            className={actionButton}
                            disabled={actions.busy !== null}
                            onClick={() => void actions.findSubtitles(title.id)}
                          >
                            <Captions size={13} aria-hidden="true" />
                            {t("library.findTurkish")}
                          </button>
                          {/*
                            A film is one video, so a subtitle can be dropped on
                            it here. A show is many, and its episodes carry their
                            own buttons under Seasons — dropping one on the show
                            would file it against whichever episode sorted first.
                          */}
                          {title.kind === "series" ? null : (
                            <>
                              <SubtitleUploadButton
                                disabled={actions.busy !== null}
                                label={`${t("library.uploadSubtitle")} · ${title.title}`}
                                onPick={(file) =>
                                  void actions.uploadSubtitle(
                                    title.id,
                                    file,
                                    uploadPolicy,
                                  )
                                }
                              />
                              <button
                                type="button"
                                className={actionButton}
                                aria-expanded={syncing === title.id}
                                aria-label={`${t("library.syncSubtitle")} · ${title.title}`}
                                onClick={() =>
                                  setSyncing(
                                    syncing === title.id ? null : title.id,
                                  )
                                }
                              >
                                <Timer size={13} aria-hidden="true" />
                                {t("library.syncSubtitle")}
                              </button>
                            </>
                          )}
                        </>
                      ) : null}
                      <button
                        type="button"
                        className={`${actionButton} ml-auto border-rose-400/25 text-rose-200 hover:bg-rose-400/10 hover:text-rose-100`}
                        onClick={() => setRemoving(title)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        {t("library.remove")}
                      </button>
                    </div>
                  </div>
                </div>
                {/*
                  Opened under the row it belongs to, so the film being
                  corrected is never in doubt; one at a time, because each
                  panel follows its own running task.
                */}
                {syncing === title.id && title.kind !== "series" ? (
                  <SubtitleSyncPanel
                    itemId={title.id}
                    initiallyOpen
                    onSynced={reload}
                  />
                ) : null}
                {expanded ? (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    <SeasonsInline
                      title={title}
                      actions={actions}
                      uploadPolicy={uploadPolicy}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {removing ? (
        <RemoveTitleDialog title={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </section>
  );
}
