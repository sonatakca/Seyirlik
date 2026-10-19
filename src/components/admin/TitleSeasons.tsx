import { Captions, Images } from "lucide-react";
import { useLanguage } from "../../i18n/LanguageContext";
import type { TranslationKey } from "../../i18n/translations";
import {
  episodeStage,
  toneOf,
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

/**
 * One episode in the season strip.
 *
 * Without a file the pill is one colour, since nothing after the download can
 * exist yet. Once there is a file it splits into the file's step, Turkish
 * subtitles and trickplay, the last two filling in whichever order they come.
 * A finished episode is one green pill again.
 */
function StripPill({ episode }: { episode: LibraryEpisode }) {
  const { t } = useLanguage();
  const stage = episodeStage(episode, true);
  const code = `E${String(episode.episodeNumber).padStart(2, "0")}`;
  let bar;
  let facts: string[];
  if ("tone" in stage.file) {
    const { tone } = stage.file;
    bar = <span className={`h-1.5 rounded-full ${TONE_STYLE[tone].dot}`} />;
    facts = [
      tone === "wanted"
        ? t("library.missingEpisode")
        : t(`library.tone.${tone}` as TranslationKey),
    ];
  } else {
    const { held } = stage.file;
    bar = stage.complete ? (
      <span className="h-1.5 rounded-full bg-emerald-400" />
    ) : (
      <span className="flex h-1.5 gap-px overflow-hidden rounded-full">
        <span className={`flex-[2] ${PROCESS_STYLE[held]}`} />
        <span className={`flex-1 ${TURKISH_STYLE[stage.turkish]}`} />
        <span
          className={`flex-1 ${stage.trickplay ? "bg-pink-400" : "bg-white/10"}`}
        />
      </span>
    );
    facts = stage.complete
      ? [t("library.stage.complete")]
      : [
          t(`library.stage.${held}`),
          t(`library.stage.turkish.${stage.turkish}`),
          t(
            stage.trickplay
              ? "library.stage.trickplay.yes"
              : "library.stage.trickplay.no",
          ),
        ];
  }
  return (
    <Tooltip content={[code, ...facts].join(" · ")}>
      <span className="flex min-w-0 max-w-7 flex-1 flex-col gap-1">
        <span className="text-center text-[9px] font-bold leading-none tabular-nums text-white/40">
          {episode.episodeNumber}
        </span>
        {bar}
      </span>
    </Tooltip>
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
