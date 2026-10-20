import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  Captions,
  FileVideo,
  Images,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react";
import { setPageTitle } from "../../lib/pageTitle";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  getLibraryTitle,
  isMissingEpisode,
  toneOf,
  type LibraryTitleDetail,
} from "../../lib/libraryAdminApi";
import { refreshItemMetadata } from "../../lib/mediaApi";
import { releaseSearchUrl } from "../../lib/wantedApi";
import { RemoveTitleDialog } from "../../components/admin/RemoveTitleDialog";
import { onTitleRemoved } from "../../components/admin/titleRemovalProgress";
import { TitleSeasons } from "../../components/admin/TitleSeasons";
import { TitlePoster } from "../../components/admin/TitlePoster";
import {
  SubtitleUploadButton,
  SubtitleUploadPolicyFields,
  type SubtitleUploadPolicy,
} from "../../components/admin/SubtitleUploadControl";
import { SeriesMonitoringPanel } from "../../components/admin/SeriesMonitoringPanel";
import { SubtitleSyncPanel } from "../../components/admin/SubtitleSyncPanel";
import {
  Facts,
  NoticeLine,
  StatusPill,
} from "../../components/admin/libraryPresentation";
import { actionButton, languages } from "../../components/admin/libraryStyle";
import { useTitleActions } from "../../components/admin/useTitleActions";

const ArtworkEditor = lazy(() => import("../TmdbArtworkPage"));

type Tab = "overview" | "episodes" | "artwork" | "monitoring";

/**
 * Everything that can be done to one title, in one place.
 *
 * Before this a film's trickplay was generated from a library-wide button, its
 * artwork from one tool, its metadata from another, its monitoring from a
 * third with its own title picker, and its subtitles from a fourth. Each asked
 * the operator to find the same title again. This page is reached from the
 * library list, and every one of those errands is a tab or a button on it —
 * for the film, and for a show's seasons and episodes individually.
 */
/** How often an open title page asks again what it holds. */
const LIVE_REFRESH_MS = 5_000;

export function TitlePage() {
  const { t } = useLanguage();
  const { itemId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [detail, setDetail] = useState<LibraryTitleDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await getLibraryTitle(itemId));
    } catch (error) {
      if ((error as { status?: number }).status === 404) setMissing(true);
    }
  }, [itemId]);
  const actions = useTitleActions(load);
  /** Chosen once and applied to whichever film or episode a file is dropped on. */
  const [uploadPolicy, setUploadPolicy] = useState<SubtitleUploadPolicy>({
    language: "tur",
    forced: false,
    replace: false,
  });

  useEffect(() => {
    let cancelled = false;
    getLibraryTitle(itemId)
      .then((value) => !cancelled && setDetail(value))
      .catch(
        (error: { status?: number }) =>
          !cancelled && error.status === 404 && setMissing(true),
      );
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Live while it is looked at: a subtitle found, an encode or trickplay
  // finished, a download landed. Unchanged answers keep the same object, so
  // nothing re-renders for a poll that found nothing new.
  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    const tick = async () => {
      window.clearTimeout(timer);
      if (running || stopped) return;
      running = true;
      try {
        if (document.visibilityState === "visible") {
          const next = await getLibraryTitle(itemId, { background: true });
          if (!stopped)
            setDetail((previous) =>
              previous && JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next,
            );
        }
      } catch {
        // A missed refresh is retried by the next one.
      } finally {
        running = false;
        if (!stopped) timer = window.setTimeout(tick, LIVE_REFRESH_MS);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    timer = window.setTimeout(tick, LIVE_REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [itemId]);

  // Leaves for the list once this title is gone, but only while it is open.
  useEffect(
    () =>
      onTitleRemoved((removed) => {
        if (removed === itemId) navigate("/admin/library", { replace: true });
      }),
    [itemId, navigate],
  );

  useEffect(() => {
    setPageTitle(`${detail?.title ?? t("library.title")} · Seyirlik`, {
      canonicalPath: `/admin/library/${itemId}`,
      robots: "noindex, nofollow",
    });
  }, [detail?.title, itemId, t]);

  const tabs: Tab[] =
    detail?.kind === "series"
      ? ["overview", "episodes", "artwork", "monitoring"]
      : ["overview", "artwork"];
  const requested = searchParams.get("tab") as Tab | null;
  const tab: Tab =
    requested && tabs.includes(requested) ? requested : "overview";

  if (missing)
    return (
      <div className="space-y-4">
        <Link to="/admin/library" className={actionButton}>
          <ArrowLeft size={13} aria-hidden="true" />
          {t("library.title")}
        </Link>
        <p className="text-white/65">{t("library.titleMissing")}</p>
      </div>
    );
  if (!detail)
    return (
      <p role="status" className="text-white/60">
        {t("library.loading")}
      </p>
    );

  const tone = toneOf(detail, detail.desired);
  const busy = actions.busy !== null;
  const searchingMissing = actions.searchingMissing(detail.id);
  const missingEpisodes = detail.seasons.reduce(
    (sum, season) => sum + season.episodes.filter(isMissingEpisode).length,
    0,
  );

  return (
    <div className="w-full space-y-6">
      <Link to="/admin/library" className={actionButton}>
        <ArrowLeft size={13} aria-hidden="true" />
        {t("library.title")}
      </Link>

      <header className="flex gap-4">
        <TitlePoster
          itemId={detail.id}
          title={detail.title}
          artwork={detail.artwork}
          width={96}
          className="rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-3xl font-black text-white">
            {detail.title}
            {detail.year ? (
              <span className="font-bold text-white/45"> ({detail.year})</span>
            ) : null}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <StatusPill tone={tone} />
            {detail.kind === "series" && detail.episodeCount > 0 ? (
              <span className="text-xs font-bold tabular-nums text-white/55">
                {detail.availableEpisodeCount}/{detail.episodeCount}{" "}
                {t("library.episodes")}
              </span>
            ) : null}
          </div>
          <Facts facts={detail} />
          <div className="mt-3 flex flex-wrap gap-2">
            {detail.kind !== "book" ? (
              <>
                <button
                  type="button"
                  className={actionButton}
                  disabled={busy}
                  onClick={() =>
                    void actions.toggleWanted(detail.id, detail.desired)
                  }
                >
                  {t(detail.desired ? "wanted.unmonitor" : "wanted.add")}
                </button>
                <Link
                  className={actionButton}
                  to={releaseSearchUrl({
                    ...detail,
                    kind: detail.kind as "movie" | "series",
                    year: detail.year ?? undefined,
                  })}
                >
                  {t("wanted.releases")}
                </Link>
                {missingEpisodes > 0 ? (
                  <button
                    type="button"
                    className={actionButton}
                    disabled={busy || searchingMissing}
                    onClick={() => void actions.searchMissing(detail.id)}
                  >
                    <Search size={13} aria-hidden="true" />
                    {searchingMissing
                      ? t("library.searchingMissing")
                      : `${t("library.searchMissing")} · ${missingEpisodes}`}
                  </button>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className={`${actionButton} ml-auto border-rose-400/25 text-rose-200 hover:bg-rose-400/10 hover:text-rose-100`}
              onClick={() => setRemoving(true)}
            >
              <Trash2 size={13} aria-hidden="true" />
              {t("library.remove")}
            </button>
          </div>
        </div>
      </header>

      <NoticeLine notice={actions.notice} />

      <div
        role="tablist"
        aria-label={detail.title}
        className="inline-flex flex-wrap rounded-2xl border border-white/10 bg-black/30 p-1"
      >
        {tabs.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            onClick={() =>
              setSearchParams(
                candidate === "overview" ? {} : { tab: candidate },
              )
            }
            className={`rounded-xl px-4 py-2 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
              tab === candidate
                ? "bg-[var(--accent)] text-black"
                : "text-white/55 hover:text-white"
            }`}
          >
            {t(`library.tab.${candidate}` as TranslationKey)}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {detail.files > 0 ? (
            <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <h2 className="flex items-center gap-2 font-black text-white">
                <Images size={16} aria-hidden="true" />
                {t("library.trickplay")}
              </h2>
              <p className="mt-1 text-sm tabular-nums text-white/60">
                {detail.trickplayFiles}/{detail.files}{" "}
                {t("library.trickplayCoverage")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={actionButton}
                  disabled={busy || detail.trickplayFiles >= detail.files}
                  onClick={() => void actions.trickplay(detail.id)}
                >
                  {t("library.generateMissing")}
                </button>
                <button
                  type="button"
                  className={actionButton}
                  disabled={busy}
                  onClick={() => void actions.trickplay(detail.id, true)}
                >
                  {t("library.rebuildAll")}
                </button>
              </div>
            </section>
          ) : null}

          {detail.files > 0 ? (
            <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <h2 className="flex items-center gap-2 font-black text-white">
                <Captions size={16} aria-hidden="true" />
                {t("library.subtitles")}
              </h2>
              <p className="mt-1 text-sm text-white/60">
                {languages(detail.subtitleLanguages, 12) || "—"}
                {detail.pendingSubtitles.length
                  ? ` · ${t("library.lookingFor")} ${languages(detail.pendingSubtitles)}`
                  : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={actionButton}
                  disabled={busy}
                  onClick={() => void actions.findSubtitles(detail.id)}
                >
                  {t("library.findTurkish")}
                </button>
                <Link className={actionButton} to="/admin/subtitles">
                  {t("admin.subtitles.title")}
                </Link>
              </div>
              {/*
                A subtitle belongs to one video. A film is one video, so it can
                be uploaded here; a show is many, and choosing one on the
                operator's behalf would file the file against whichever episode
                sorted first — so a show is sent to its episodes instead.
              */}
              {detail.kind === "series" ? (
                <p className="mt-3 text-xs font-semibold text-white/35">
                  {t("library.uploadPerEpisode")}
                </p>
              ) : (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <SubtitleUploadPolicyFields
                      policy={uploadPolicy}
                      onChange={setUploadPolicy}
                      disabled={busy}
                    />
                    <SubtitleUploadButton
                      disabled={busy}
                      label={t("library.uploadSubtitle")}
                      onPick={(file) =>
                        actions.uploadSubtitle(detail.id, file, uploadPolicy)
                      }
                    />
                  </div>
                  <p className="mt-2 text-xs font-semibold text-white/35">
                    {t("library.uploadSubtitleHint")}
                  </p>
                  <div className="mt-3">
                    <SubtitleSyncPanel itemId={detail.id} onSynced={load} />
                  </div>
                </>
              )}
            </section>
          ) : null}

          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <h2 className="flex items-center gap-2 font-black text-white">
              <RefreshCcw size={16} aria-hidden="true" />
              {t("library.metadata")}
            </h2>
            <p className="mt-1 text-sm text-white/60">
              {t("library.metadataHint")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={actionButton}
                disabled={busy}
                onClick={() =>
                  void refreshItemMetadata(detail.id).then(
                    () =>
                      actions.setNotice({
                        tone: "ok",
                        text: t("library.metadataQueued"),
                      }),
                    () =>
                      actions.setNotice({
                        tone: "error",
                        text: t("library.actionFailed"),
                      }),
                  )
                }
              >
                {t("library.refreshMetadata")}
              </button>
              <button
                type="button"
                className={actionButton}
                onClick={() => setSearchParams({ tab: "artwork" })}
              >
                {t("library.tab.artwork")}
              </button>
            </div>
          </section>

          {detail.kind !== "book" && detail.files > 0 ? (
            <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <h2 className="flex items-center gap-2 font-black text-white">
                <FileVideo size={16} aria-hidden="true" />
                {t("library.processingTitle")}
              </h2>
              <p className="mt-1 break-all text-sm text-white/60">
                {detail.fileName ?? t("library.processingHint")}
              </p>
              <div className="mt-3">
                <Link className={actionButton} to="/dev/media-processing">
                  {t("devtools.card.mediaProcessing.title")}
                </Link>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "episodes" ? (
        <>
          {/*
            One policy for the whole list. Subtitles are added to a season an
            episode at a time, and choosing the language again on every row
            would be the same answer typed ten times.
          */}
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <Captions size={16} aria-hidden="true" className="text-white/45" />
            <span className="text-xs font-black uppercase tracking-[0.12em] text-white/45">
              {t("library.uploadSubtitle")}
            </span>
            <SubtitleUploadPolicyFields
              policy={uploadPolicy}
              onChange={setUploadPolicy}
              disabled={busy}
            />
            <p className="w-full text-xs font-semibold text-white/35">
              {t("library.uploadSubtitleHint")}
            </p>
          </div>
          <TitleSeasons
            detail={detail}
            actions={{
              busy,
              onSubtitles: (id) => void actions.findSubtitles(id),
              onTrickplay: (id) => void actions.trickplay(id),
              onUploadSubtitle: (id, file) =>
                void actions.uploadSubtitle(id, file, uploadPolicy),
              onSearchMissing: (season) =>
                void actions.searchMissing(detail.id, season),
              searchingMissing,
            }}
          />
        </>
      ) : null}

      {tab === "artwork" ? (
        <Suspense
          fallback={
            <p role="status" className="text-white/60">
              {t("library.loading")}
            </p>
          }
        >
          <ArtworkEditor itemId={detail.id} />
        </Suspense>
      ) : null}

      {tab === "monitoring" ? (
        <SeriesMonitoringPanel itemId={detail.id} />
      ) : null}

      {removing ? (
        <RemoveTitleDialog title={detail} onClose={() => setRemoving(false)} />
      ) : null}
    </div>
  );
}
