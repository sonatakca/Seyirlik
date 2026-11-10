import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { getPrimaryImageUrl, getThumbImageUrl } from "../../lib/mediaApi";
import type {
  ProcessingEpisode,
  ProcessingSeason,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../lib/processingApi";
import {
  episodeAction,
  rungBreakdown,
  summariseCounts,
  canDeleteEpisodeSource,
  canDeleteSeasonSources,
  canDeleteSeriesSources,
  sourceDeletionTargets,
  formatSourceDeletionSize,
  sourceDeletionBytes,
  episodeDisplayTitle,
} from "./processingSeriesModel";
import { formatTemplate } from "./libraryMaintenanceModel";
import { formatBytes } from "./processingModel";
import type { Language } from "../../i18n/translations";

/**
 * A show, its seasons and its episodes, as three collapsed levels.
 *
 * The reason this is a tree and not a list: The Sopranos is eighty-six titles.
 * Rendering eighty-six expanded cards is not a page anyone can use, and it is
 * not a truthful shape either — a season is a real thing in this library, with
 * its own folder and its own answer to "is this done".
 *
 * Nothing here owns state. Which rows are open, what the search is, and which
 * request is in flight all live above, so a poll that replaces the data cannot
 * close a season under the operator's hand.
 */

const LABEL =
  "text-[11px] font-black uppercase tracking-[0.14em] text-white/40";
const CARD = "rounded-2xl border border-white/10 bg-white/[0.03]";

type Translate = (key: string) => string;

function CountsLine({
  counts,
  t,
}: {
  counts: ProcessingStateCounts;
  t: Translate;
}) {
  const summary = summariseCounts(counts, t, formatTemplate);
  if (!summary) return null;
  return <span className="text-xs text-white/45">{summary}</span>;
}

/** The rungs an episode has, and the ones a run would add, in one strip. */
function RungStrip({
  episode,
  t,
}: {
  episode: ProcessingEpisode;
  t: Translate;
}) {
  const { present, planned } = rungBreakdown(episode);
  const owned = new Set(present);
  /*
   * With no source there is nothing that could be added, so only what exists
   * is shown. Listing a ladder beside a title that can never be given one
   * reads as pending work that is not pending and never will be.
   */
  const rungs = episode.sourceAvailable ? planned : present;
  if (rungs.length === 0) {
    return (
      <span className="text-[11px] text-white/35">
        {t("processing.noPackage")}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {rungs.map((height) => {
        const kept = owned.has(height);
        return (
          <span
            key={height}
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
              kept
                ? "border-emerald-400/25 bg-emerald-400/15 text-emerald-200"
                : "border-amber-400/30 bg-amber-400/15 text-amber-100"
            }`}
          >
            <span aria-hidden="true" className="text-[9px] leading-none">
              {kept ? "✓" : "+"}
            </span>
            {height}p
          </span>
        );
      })}
    </div>
  );
}

function SourceDeleteAction({
  label,
  confirmLabel,
  sizeLabel,
  armed,
  deleting,
  onArm,
  onConfirm,
  onCancel,
  t,
}: {
  label: string;
  confirmLabel: string;
  sizeLabel: string;
  armed: boolean;
  deleting: boolean;
  onArm: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  if (!armed) {
    return (
      <button
        type="button"
        onClick={onArm}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-400/[0.12] px-3 py-2 text-xs font-black text-rose-100 transition hover:bg-rose-400/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <Trash2 size={14} aria-hidden="true" />
        <span>{label}</span>
        <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-[0.6875rem] font-black tabular-nums opacity-80">
          {sizeLabel}
        </span>
      </button>
    );
  }

  return (
    <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:max-w-[18rem]">
      <button
        type="button"
        onClick={onConfirm}
        disabled={deleting}
        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-500 px-3 py-2 text-xs font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        {deleting ? (
          <Loader2
            size={14}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <AlertTriangle size={14} aria-hidden="true" />
        )}

        <span>{confirmLabel}</span>
        <span className="rounded-md bg-black/20 px-1.5 py-0.5 text-[0.6875rem] font-black tabular-nums opacity-80">
          {sizeLabel}
        </span>
      </button>

      <p className="text-[11px] leading-snug text-white/45">
        {t("processing.tv.deleteSourcesHint")}
      </p>

      <button
        type="button"
        onClick={onCancel}
        disabled={deleting}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs font-bold text-white/70 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        {t("processing.tv.deleteSourcesCancel")}
      </button>
    </div>
  );
}

function EpisodeRow({
  episode,
  starting,
  onStart,
  confirmingDeleteKey,
  deletingDeleteKey,
  onArmDelete,
  onCancelDelete,
  onDeleteSource,
  language,
  t,
}: {
  episode: ProcessingEpisode;
  starting: boolean;
  onStart: (episode: ProcessingEpisode) => void;
  confirmingDeleteKey: string | null;
  deletingDeleteKey: string | null;
  onArmDelete: (key: string) => void;
  onCancelDelete: () => void;
  onDeleteSource: (episode: ProcessingEpisode) => void;
  language?: Language;
  t: Translate;
}) {
  const action = episodeAction(episode);
  const deleteKey = episode.itemId;
  const canDeleteSource = canDeleteEpisodeSource(episode);
  const stateLabel =
    action === "unavailable"
      ? t("processing.sourceMissing")
      : action === "active"
        ? t("processing.activeJob")
        : action === "unprobed"
          ? t("processing.tv.episodeUnprobed")
          : episode.packageState === "complete"
            ? t("processing.tv.episodeComplete")
            : episode.packageState === "unknown"
              ? t("processing.tv.episodeUnknown")
              : episode.packageState === "none"
                ? t("processing.tv.episodeUnprocessed")
                : t("processing.tv.episodePartial");

  return (
    <li
      data-testid="processing-episode"
      data-episode-code={episode.code}
      className="grid grid-cols-[6rem,minmax(0,1fr),auto] items-start gap-3 rounded-xl border border-white/[0.07] bg-black/25 p-3 sm:grid-cols-[7rem,minmax(0,1fr),auto]"
    >
      {/*
       * Episodes use their own 16:9 still rather than the series poster.
       * Keep it deliberately small: this is processing metadata, not a
       * media-browser card.
       */}
      <div className="relative aspect-video w-24 self-start overflow-hidden rounded-lg border border-white/[0.08] bg-[var(--surface)] sm:w-28">
        {/*
         * What the still falls back to when there is no artwork, and only
         * that: the code is already written beside it, so a reader that took
         * this one too would announce the episode twice.
         */}
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] px-2 text-center text-[0.6875rem] font-bold text-white/45"
        >
          {episode.code}
        </div>

        <img
          src={getThumbImageUrl(episode.itemId, undefined, 320)}
          alt=""
          loading="lazy"
          decoding="async"
          className="relative h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11px] font-black tabular-nums text-white/70">
            {episode.code}
          </span>
          <span className="truncate text-sm font-bold text-white">
            {episodeDisplayTitle(episode, language)}
          </span>
          <span className="text-[11px] text-white/40">{stateLabel}</span>
        </div>

        {episode.source ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/45">
            <span className="tabular-nums">
              {episode.source.width}×{episode.source.height}
            </span>
            <span>{episode.source.dynamicRange}</span>
            {episode.plan ? <span>{episode.plan.videoEncoder}</span> : null}
            {episode.plan ? (
              <span className="tabular-nums">
                {formatBytes(episode.plan.estimatedOutputBytes)}
              </span>
            ) : null}
            {episode.source.audioTracks > 0 ? (
              <span className="tabular-nums">
                {episode.source.audioTracks} · {t("processing.audioKept")}
              </span>
            ) : null}
            {episode.source.subtitleTracks + episode.source.externalSubtitles >
            0 ? (
              <span className="tabular-nums">
                {episode.source.subtitleTracks +
                  episode.source.externalSubtitles}{" "}
                · {t("processing.subtitlesKept")}
              </span>
            ) : null}
            {/*
             * An episode that ships as two containers says so. The catalogue
             * picks one as canonical and only that one is ever processed, but
             * an operator looking at a season folder with both files in it
             * deserves to know why they see one row.
             */}
            {episode.fileCount > 1 ? (
              <span>
                {formatTemplate(t("processing.tv.alternateSource"), {
                  count: String(episode.fileCount),
                })}
              </span>
            ) : null}
          </div>
        ) : null}

        <RungStrip episode={episode} t={t} />
      </div>

      {canDeleteSource ? (
        <SourceDeleteAction
          label={t("processing.deleteSource")}
          confirmLabel={t("processing.tv.deleteEpisodeSourceConfirm")}
          sizeLabel={formatSourceDeletionSize(sourceDeletionBytes([episode]))}
          armed={confirmingDeleteKey === deleteKey}
          deleting={deletingDeleteKey === deleteKey}
          onArm={() => onArmDelete(deleteKey)}
          onConfirm={() => onDeleteSource(episode)}
          onCancel={onCancelDelete}
          t={t}
        />
      ) : (
        <button
          type="button"
          onClick={() => onStart(episode)}
          disabled={starting || action !== "start"}
          aria-label={`${t("processing.start")} ${episode.code}`}
          className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-black text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {starting ? (
            <Loader2
              size={14}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Play size={14} aria-hidden="true" />
          )}

          {action === "active"
            ? t("processing.activeJob")
            : action === "unavailable"
              ? t("processing.sourceMissing")
              : action === "complete"
                ? t("processing.tv.nothingToDo")
                : t("processing.start")}
        </button>
      )}
    </li>
  );
}

function SeasonBlock({
  series,
  season,
  expanded,
  onToggle,
  onProcessSeason,
  onStartEpisode,
  busySeasonId,
  startingItemId,
  onDeleteEpisodeSource,
  onDeleteSeasonSources,
  confirmingDeleteKey,
  deletingDeleteKey,
  onArmDelete,
  onCancelDelete,
  language,
  t,
}: {
  series: ProcessingSeries;
  season: ProcessingSeason;
  expanded: boolean;
  onToggle: (seasonId: string) => void;
  onProcessSeason: (season: ProcessingSeason) => void;
  onStartEpisode: (episode: ProcessingEpisode) => void;
  busySeasonId: string | null;
  startingItemId: string | null;
  onDeleteEpisodeSource: (episode: ProcessingEpisode) => void;
  onDeleteSeasonSources: (season: ProcessingSeason) => void;
  confirmingDeleteKey: string | null;
  deletingDeleteKey: string | null;
  onArmDelete: (key: string) => void;
  onCancelDelete: () => void;
  language?: Language;
  t: Translate;
}) {
  const busy = busySeasonId === season.seasonId;
  const canDeleteSources = canDeleteSeasonSources(season);
  const deleteTargets = sourceDeletionTargets(season.episodes);
  const deleteKey = `season:${season.seasonId}`;
  const seasonTitle =
    season.seasonNumber === 0
      ? t("processing.tv.specials")
      : formatTemplate(t("processing.tv.season"), {
          number: String(season.seasonNumber),
        });

  return (
    <li
      data-testid="processing-season"
      data-season-number={String(season.seasonNumber)}
      className="rounded-xl border border-white/[0.07] bg-black/20"
    >
      <div className="flex flex-wrap items-center gap-2 rounded-xl p-3 transition-colors has-[.season-toggle:hover]:bg-white/[0.08]">
        <button
          type="button"
          onClick={() => onToggle(season.seasonId)}
          aria-expanded={expanded}
          aria-label={formatTemplate(
            t(
              expanded
                ? "processing.tv.collapseSeason"
                : "processing.tv.expandSeason",
            ),
            { title: `${series.title} ${seasonTitle}` },
          )}
          className="season-toggle cursor-pointer inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {expanded ? (
            <ChevronDown size={16} aria-hidden="true" className="shrink-0" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" className="shrink-0" />
          )}
          <span className="truncate text-sm font-black text-white">
            {seasonTitle}
          </span>
          <span className="shrink-0 text-xs text-white/40 tabular-nums">
            {formatTemplate(
              t(
                season.episodes.length === 1
                  ? "processing.tv.episodeCountOne"
                  : "processing.tv.episodeCount",
              ),
              { count: String(season.episodes.length) },
            )}
          </span>
          <CountsLine counts={season.counts} t={t} />
        </button>

        {canDeleteSources ? (
          <SourceDeleteAction
            label={t("processing.tv.deleteSeasonSources")}
            confirmLabel={formatTemplate(
              t("processing.tv.deleteBulkSourcesConfirm"),
              { count: String(deleteTargets.length) },
            )}
            sizeLabel={formatSourceDeletionSize(
              sourceDeletionBytes(season.episodes),
            )}
            armed={confirmingDeleteKey === deleteKey}
            deleting={deletingDeleteKey === deleteKey}
            onArm={() => onArmDelete(deleteKey)}
            onConfirm={() => onDeleteSeasonSources(season)}
            onCancel={onCancelDelete}
            t={t}
          />
        ) : (
          <button
            type="button"
            onClick={() => onProcessSeason(season)}
            disabled={busy || season.counts.eligible === 0}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {busy ? (
              <Loader2
                size={13}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}

            {season.counts.eligible === 0
              ? t("processing.tv.nothingToDo")
              : t("processing.tv.processSeason")}
          </button>
        )}
      </div>

      {expanded ? (
        <ul
          className="flex flex-col gap-2 border-t border-white/[0.06] p-3"
          onClick={(event) => event.stopPropagation()}
        >
          {season.episodes.map((episode) => (
            <EpisodeRow
              key={episode.itemId}
              episode={episode}
              starting={startingItemId === episode.itemId}
              onStart={onStartEpisode}
              confirmingDeleteKey={confirmingDeleteKey}
              deletingDeleteKey={deletingDeleteKey}
              onArmDelete={onArmDelete}
              onCancelDelete={onCancelDelete}
              onDeleteSource={onDeleteEpisodeSource}
              language={language}
              t={t}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ProcessingSeriesTree({
  series,
  expandedSeriesIds,
  expandedSeasonIds,
  onToggleSeries,
  onToggleSeason,
  onProcessSeries,
  onProcessSeason,
  onStartEpisode,
  busySeriesId,
  busySeasonId,
  startingItemId,
  onDeleteEpisodeSource,
  onDeleteSeasonSources,
  onDeleteSeriesSources,
  confirmingDeleteKey,
  deletingDeleteKey,
  onArmDelete,
  onCancelDelete,
  language,
  t,
}: {
  series: readonly ProcessingSeries[];
  expandedSeriesIds: ReadonlySet<string>;
  expandedSeasonIds: ReadonlySet<string>;
  onToggleSeries: (seriesId: string) => void;
  onToggleSeason: (seasonId: string) => void;
  onProcessSeries: (series: ProcessingSeries) => void;
  onProcessSeason: (season: ProcessingSeason) => void;
  onStartEpisode: (episode: ProcessingEpisode) => void;
  busySeriesId: string | null;
  busySeasonId: string | null;
  startingItemId: string | null;
  onDeleteEpisodeSource: (episode: ProcessingEpisode) => void;
  onDeleteSeasonSources: (season: ProcessingSeason) => void;
  onDeleteSeriesSources: (series: ProcessingSeries) => void;
  confirmingDeleteKey: string | null;
  deletingDeleteKey: string | null;
  onArmDelete: (key: string) => void;
  onCancelDelete: () => void;
  /** The site's language, for episode names. */
  language?: Language;
  t: Translate;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {series.map((show) => {
        const expanded = expandedSeriesIds.has(show.seriesId);
        const busy = busySeriesId === show.seriesId;
        const canDeleteSources = canDeleteSeriesSources(show);
        const deleteTargets = sourceDeletionTargets(
          show.seasons.flatMap((season) => season.episodes),
        );
        const deleteKey = `series:${show.seriesId}`;
        return (
          /*
           * Keyed by the catalogue's own id, never by an array index. A poll
           * that reorders or replaces the list must not make React reuse one
           * show's open seasons for another's.
           */
          <li
            key={show.seriesId}
            data-testid="processing-series"
            data-series-title={show.title}
            onClick={(event) => {
              const target = event.target as Element;
              if (!target.closest(".series-toggle")) return;
              if (target.closest("button")) return;
              onToggleSeries(show.seriesId);
            }}
            className={`${CARD} p-3 transition-colors has-[.series-toggle:hover]:bg-white/[0.06] sm:p-4`}
          >
            <div className="grid grid-cols-[4rem,minmax(0,1fr)] gap-3 sm:grid-cols-[5rem,minmax(0,1fr)] sm:gap-4">
              {/*
              Series artwork mirrors the movie processing card: a 2:3 poster,
              96px wide normally and 112px at sm+.

              `series-toggle` intentionally lives on the poster too. The
              existing delegated click handler therefore expands/collapses the
              show when the poster is clicked, and the existing :has hover rule
              illuminates the whole series card while the poster is hovered.
            */}
              <div className="series-toggle media-card-cinematic relative aspect-[2/3] w-16 cursor-pointer self-start sm:w-[5rem] overflow-hidden rounded-xl border border-white/10 bg-[var(--surface)] sm:w-28">
                {/* The poster's fallback, and decorative for the same reason
                    the poster is: the show is named in full beside it. */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(145deg,#27272a,#09090b)] p-3 text-center text-xs font-bold text-white/80"
                >
                  {show.title}
                </div>

                <img
                  src={getPrimaryImageUrl(show.seriesId, undefined, 360)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="relative h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onToggleSeries(show.seriesId)}
                    aria-expanded={expanded}
                    aria-label={formatTemplate(
                      t(
                        expanded
                          ? "processing.tv.collapseSeries"
                          : "processing.tv.expandSeries",
                      ),
                      { title: show.title },
                    )}
                    className="series-toggle cursor-pointer inline-flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {expanded ? (
                      <ChevronDown
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                    ) : (
                      <ChevronRight
                        size={18}
                        aria-hidden="true"
                        className="shrink-0"
                      />
                    )}
                    <span className="truncate text-base font-black text-white sm:text-lg">
                      {show.title}
                    </span>
                    {show.productionYear ? (
                      <span className="shrink-0 text-xs text-white/40 tabular-nums">
                        {show.productionYear}
                      </span>
                    ) : null}
                  </button>

                  {canDeleteSources ? (
                    <SourceDeleteAction
                      label={t("processing.tv.deleteSeriesSources")}
                      confirmLabel={formatTemplate(
                        t("processing.tv.deleteBulkSourcesConfirm"),
                        { count: String(deleteTargets.length) },
                      )}
                      sizeLabel={formatSourceDeletionSize(
                        sourceDeletionBytes(
                          show.seasons.flatMap((season) => season.episodes),
                        ),
                      )}
                      armed={confirmingDeleteKey === deleteKey}
                      deleting={deletingDeleteKey === deleteKey}
                      onArm={() => onArmDelete(deleteKey)}
                      onConfirm={() => onDeleteSeriesSources(show)}
                      onCancel={onCancelDelete}
                      t={t}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onProcessSeries(show)}
                      disabled={busy || show.counts.eligible === 0}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-white/80 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      {busy ? (
                        <Loader2
                          size={13}
                          className="animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : null}

                      {show.counts.eligible === 0
                        ? t("processing.tv.nothingToDo")
                        : t("processing.tv.processSeries")}
                    </button>
                  )}
                </div>

                <div className="series-toggle mt-1 flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 pl-7">
                  <span className={LABEL}>
                    {formatTemplate(
                      t(
                        show.seasonCount === 1
                          ? "processing.tv.seasonCountOne"
                          : "processing.tv.seasonCount",
                      ),
                      { count: String(show.seasonCount) },
                    )}
                  </span>
                  <span className="text-xs text-white/40 tabular-nums">
                    {formatTemplate(
                      t(
                        show.episodeCount === 1
                          ? "processing.tv.episodeCountOne"
                          : "processing.tv.episodeCount",
                      ),
                      { count: String(show.episodeCount) },
                    )}
                  </span>
                  <CountsLine counts={show.counts} t={t} />
                </div>
              </div>
            </div>
            {expanded ? (
              <ul
                className="mt-3 flex flex-col gap-2"
                onClick={(event) => event.stopPropagation()}
              >
                {show.seasons.map((season) => (
                  <SeasonBlock
                    key={season.seasonId}
                    series={show}
                    season={season}
                    expanded={expandedSeasonIds.has(season.seasonId)}
                    onToggle={onToggleSeason}
                    onProcessSeason={onProcessSeason}
                    onStartEpisode={onStartEpisode}
                    busySeasonId={busySeasonId}
                    startingItemId={startingItemId}
                    onDeleteEpisodeSource={onDeleteEpisodeSource}
                    onDeleteSeasonSources={onDeleteSeasonSources}
                    confirmingDeleteKey={confirmingDeleteKey}
                    deletingDeleteKey={deletingDeleteKey}
                    onArmDelete={onArmDelete}
                    onCancelDelete={onCancelDelete}
                    language={language}
                    t={t}
                  />
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
