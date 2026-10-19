import { Captions, Images } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  episodeStage,
  toneOf,
  type EpisodeStage,
  type HoldingTone,
  type LibraryEpisode,
  type LibraryTitleDetail,
} from "../../lib/libraryAdminApi";
import { Facts } from "./libraryPresentation";
import { actionButton, TONE_STYLE } from "./libraryStyle";
import { Tooltip } from "../ui/Tooltip";
import { SubtitleUploadButton } from "./SubtitleUploadControl";
import { getThumbImageUrl } from "../../lib/mediaApi";

/** The episode's own still when the catalogue has one, TMDB's when it does not. */
function EpisodeStill({ episode }: { episode: LibraryEpisode }) {
  const src =
    episode.id && episode.hasThumb
      ? getThumbImageUrl(episode.id, undefined, 320)
      : episode.stillUrl;
  return (
    <div className="aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-white/[0.04]">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
        />
      ) : null}
    </div>
  );
}

export interface SeasonActions {
  busy: boolean;
  onSubtitles: (itemId: string) => void;
  onTrickplay: (itemId: string) => void;
  /**
   * A subtitle file for one episode, under the policy chosen above the list.
   *
   * Absent where there is nowhere to choose that policy — the library board
   * shows the same rows without the workspace's controls — and the row then
   * offers no upload rather than guessing a language.
   */
  onUploadSubtitle?: (itemId: string, file: File) => void;
}

function EpisodeRow({
  episode,
  wanted,
  actions,
}: {
  episode: LibraryEpisode;
  wanted: boolean;
  actions: SeasonActions;
}) {
  const { t } = useLanguage();
  // A show's aired episode that is not on disk is missing, whatever the
  // show's own wanted flag says; only one unmonitored on purpose is grey.
  const tone = toneOf(
    episode,
    wanted || episode.monitored || !episode.hasMedia,
  );
  const label =
    !episode.hasMedia && tone === "wanted"
      ? t("library.missingEpisode")
      : t(`library.tone.${tone}` as TranslationKey);
  const code = `E${String(episode.episodeNumber).padStart(2, "0")}`;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      <EpisodeStill episode={episode} />
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_STYLE[tone].dot}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white/85">
          <span className="tabular-nums text-white/50">{code}</span>{" "}
          {episode.title ?? ""}
          <span className="sr-only"> · {label}</span>
        </p>
        {episode.hasMedia ? (
          <Facts facts={episode} />
        ) : (
          <p
            className={`mt-0.5 text-xs ${tone === "wanted" ? "text-red-200/80" : "text-white/40"}`}
          >
            {label}
            {episode.airDate ? ` · ${episode.airDate}` : ""}
          </p>
        )}
      </div>
      {episode.id && episode.mediaFileId ? (
        <div className="flex gap-1.5">
          <Tooltip content={t("library.generateTrickplay")}>
            <button
              type="button"
              className={actionButton}
              disabled={actions.busy}
              onClick={() => actions.onTrickplay(episode.id!)}
              aria-label={`${t("library.generateTrickplay")} · ${code}`}
            >
              <Images size={13} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t("library.findTurkish")}>
            <button
              type="button"
              className={actionButton}
              disabled={actions.busy}
              onClick={() => actions.onSubtitles(episode.id!)}
              aria-label={`${t("library.findTurkish")} · ${code}`}
            >
              <Captions size={13} aria-hidden="true" />
              TR
            </button>
          </Tooltip>
          {actions.onUploadSubtitle ? (
            <SubtitleUploadButton
              iconOnly
              disabled={actions.busy}
              label={`${t("library.uploadSubtitle")} · ${code}`}
              onPick={(file) => actions.onUploadSubtitle?.(episode.id!, file)}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const PROCESS_STYLE = {
  unprocessed: "bg-orange-400",
  processing: "bg-orange-400",
  processed: "bg-white/60",
} as const;

const TURKISH_STYLE = {
  found: "bg-blue-400",
  searching: "bg-blue-400/35",
  none: "bg-white/10",
} as const;

const TRICKPLAY_STYLE = {
  found: "bg-pink-400",
  queued: "bg-pink-400/35",
  none: "bg-white/10",
} as const;

/**
 * An episode's pill in the season strip.
 *
 * Without a file the pill is one colour, since nothing after the download can
 * exist yet. Once there is a file it splits into the file's step, Turkish
 * subtitles and trickplay, the last two filling in whichever order they come.
 * A finished episode is one green pill again.
 */
function StripBar({ stage }: { stage: EpisodeStage }) {
  if ("tone" in stage.file) {
    return (
      <span
        className={`h-1.5 rounded-full ${TONE_STYLE[stage.file.tone].dot}`}
      />
    );
  }
  if (stage.complete) {
    return <span className="h-1.5 rounded-full bg-emerald-400" />;
  }
  return (
    <span className="flex h-1.5 gap-px overflow-hidden rounded-full">
      <span className={`flex-[2] ${PROCESS_STYLE[stage.file.held]}`} />
      <span className={`flex-1 ${TURKISH_STYLE[stage.turkish]}`} />
      <span className={`flex-1 ${TRICKPLAY_STYLE[stage.trickplay]}`} />
    </span>
  );
}

function toneLabel(tone: HoldingTone, t: (key: TranslationKey) => string) {
  return tone === "wanted"
    ? t("library.missingEpisode")
    : t(`library.tone.${tone}` as TranslationKey);
}

/** One episode in the season strip: its number over its pill. */
function StripPill({ episode }: { episode: LibraryEpisode }) {
  const { t } = useLanguage();
  const stage = episodeStage(episode, true);
  const code = `E${String(episode.episodeNumber).padStart(2, "0")}`;
  const facts =
    "tone" in stage.file
      ? [toneLabel(stage.file.tone, t)]
      : stage.complete
        ? [t("library.stage.complete")]
        : [
            t(`library.stage.${stage.file.held}`),
            t(`library.stage.turkish.${stage.turkish}`),
            t(`library.stage.trickplay.${stage.trickplay}`),
          ];
  return (
    <Tooltip content={[code, ...facts].join(" · ")}>
      <span className="flex min-w-0 max-w-7 flex-1 flex-col gap-1">
        <span className="text-center text-[9px] font-bold leading-none tabular-nums text-white/40">
          {episode.episodeNumber}
        </span>
        <StripBar stage={stage} />
      </span>
    </Tooltip>
  );
}

const held = (
  file: "unprocessed" | "processed",
  turkish: EpisodeStage["turkish"] = "none",
  trickplay: EpisodeStage["trickplay"] = "none",
): EpisodeStage => ({
  file: { held: file },
  turkish,
  trickplay,
  complete: false,
});

/**
 * What each pill means, drawn with the pills themselves, so where a colour
 * sits in a split pill is part of what it says.
 */
const LEGEND: Array<{
  stage: EpisodeStage;
  label: TranslationKey | HoldingTone;
}> = [
  {
    stage: {
      file: { tone: "wanted" },
      turkish: "none",
      trickplay: "none",
      complete: false,
    },
    label: "wanted",
  },
  {
    stage: {
      file: { tone: "downloading" },
      turkish: "none",
      trickplay: "none",
      complete: false,
    },
    label: "downloading",
  },
  { stage: held("unprocessed"), label: "library.stage.unprocessed" },
  { stage: held("processed"), label: "library.stage.processed" },
  { stage: held("processed", "found"), label: "library.stage.turkish.found" },
  {
    stage: held("processed", "searching"),
    label: "library.stage.turkish.searching",
  },
  {
    stage: held("processed", "none", "found"),
    label: "library.stage.trickplay.found",
  },
  {
    stage: held("processed", "none", "queued"),
    label: "library.stage.trickplay.queued",
  },
  {
    stage: {
      file: { held: "processed" },
      turkish: "found",
      trickplay: "found",
      complete: true,
    },
    label: "library.stage.complete",
  },
];

function StripLegend({ seasons }: { seasons: LibraryTitleDetail["seasons"] }) {
  const { t } = useLanguage();
  // Grey and outlined pills are rare; they are explained only where they show.
  const rare = (["absent", "unaired"] as const).filter((tone) =>
    seasons.some((season) =>
      season.episodes.some((episode) => {
        const { file } = episodeStage(episode, true);
        return "tone" in file && file.tone === tone;
      }),
    ),
  );
  const entries = [
    ...LEGEND,
    ...rare.map((tone) => ({
      stage: {
        file: { tone },
        turkish: "none",
        trickplay: "none",
        complete: false,
      } satisfies EpisodeStage,
      label: tone,
    })),
  ];
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-[11px] font-bold text-white/55">
      {entries.map(({ stage, label }) => (
        <li key={label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="flex w-7 flex-col">
            <StripBar stage={stage} />
          </span>
          {label.startsWith("library.")
            ? t(label as TranslationKey)
            : toneLabel(label as HoldingTone, t)}
        </li>
      ))}
    </ul>
  );
}

/** A show's seasons, with what each season and episode holds and can be asked for. */
export function TitleSeasons({
  detail,
  actions,
}: {
  detail: LibraryTitleDetail;
  actions: SeasonActions;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-3">
      {!detail.catalogueComplete ? (
        <p className="text-xs text-amber-200">
          {t("library.catalogueOffline")}
        </p>
      ) : null}
      <StripLegend seasons={detail.seasons} />
      {detail.seasons.map((season) => {
        const held = season.episodes.filter((e) => e.hasMedia).length;
        // Counted the way the strip is coloured: green is finished.
        const finished = season.episodes.filter(
          (e) => episodeStage(e, true).complete,
        ).length;
        const label =
          season.seasonNumber === 0
            ? t("library.specials")
            : `${t("library.season")} ${season.seasonNumber}`;
        return (
          <details
            key={season.seasonNumber}
            className="rounded-xl border border-white/10 bg-black/20"
            open={detail.seasons.length === 1}
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-2 text-sm font-black text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
              <span>{label}</span>
              <span className="min-w-10 text-xs font-bold tabular-nums text-white/50">
                {finished}/{season.episodes.length}
              </span>
              {/* One pill per episode: the season at a glance. */}
              <span aria-hidden="true" className="flex min-w-16 flex-1 gap-1">
                {season.episodes.map((episode) => (
                  <StripPill
                    key={`${episode.episodeNumber}:${episode.id ?? ""}`}
                    episode={episode}
                  />
                ))}
              </span>
              {season.id && held > 0 ? (
                <span className="flex gap-1.5">
                  <Tooltip content={t("library.generateTrickplaySeason")}>
                    <button
                      type="button"
                      className={actionButton}
                      disabled={actions.busy}
                      onClick={(event) => {
                        event.preventDefault();
                        actions.onTrickplay(season.id!);
                      }}
                      aria-label={`${t("library.generateTrickplay")} · ${label}`}
                    >
                      <Images size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content={t("library.findTurkishSeason")}>
                    <button
                      type="button"
                      className={actionButton}
                      disabled={actions.busy}
                      onClick={(event) => {
                        event.preventDefault();
                        actions.onSubtitles(season.id!);
                      }}
                      aria-label={`${t("library.findTurkish")} · ${label}`}
                    >
                      <Captions size={13} aria-hidden="true" />
                      TR
                    </button>
                  </Tooltip>
                </span>
              ) : null}
            </summary>
            <ul className="divide-y divide-white/5 px-3">
              {season.episodes.map((episode) => (
                <EpisodeRow
                  key={`${episode.seasonNumber}:${episode.episodeNumber}:${episode.id ?? ""}`}
                  episode={episode}
                  wanted={detail.desired}
                  actions={actions}
                />
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
