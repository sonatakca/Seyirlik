import { useEffect, useId, useState } from "react";
import { useLanguage } from "../../i18n/LanguageContext";
import { getEpisodeDisplayMetadata } from "../../lib/episodeMetadataPreferences";
import { formatRuntime, formatTemplate } from "../../lib/format";
import { getMediaArtwork } from "../../lib/mediaArtwork";
import type { MediaItem } from "../../lib/types";
import { isItemCompleted } from "../../lib/watchStatus";
import { WatchedStatusButton } from "../WatchedStatusButton";
import type { PlayerQueueTranslate } from "./PlayerQueueItemButton";

interface PlayerEpisodeRowProps {
  item: MediaItem;
  isCurrent: boolean;
  t: PlayerQueueTranslate;
  onPlayItem?: (item: MediaItem) => void;
}

/** How far into an unfinished episode the viewer got, as a 0–1 fraction. */
function partialProgress(item: MediaItem): number {
  if (isItemCompleted(item)) return 0;
  const percent = item.UserData?.PlayedPercentage;
  return typeof percent === "number" && percent > 1
    ? Math.min(1, percent / 100)
    : 0;
}

/**
 * One episode in the player's episode list.
 *
 * Laid out the way an episode is chosen: by its still first, then its number
 * and title, then a line of what happens in it. The still is the episode's own
 * frame (stored as a thumb, never a poster), falling back to the series
 * poster, so a list of a show's episodes is never a column of empty boxes.
 * The still is shown as it is, and every row reads the same: which episode
 * is playing is said by the row's background alone.
 */
export function PlayerEpisodeRow({
  item,
  isCurrent,
  t,
  onPlayItem,
}: PlayerEpisodeRowProps) {
  const { language } = useLanguage();
  const metadata = getEpisodeDisplayMetadata(item, language);
  const title = metadata.title ?? item.Name;
  const overview = metadata.overview;
  const { imageUrl } = getMediaArtwork(item, language, { stillWidth: 400 });
  // Keyed by URL, so a new still gets its own chance to load.
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const runtime = formatRuntime(item.RunTimeTicks, {
    season: t("format.season"),
    hourShort: t("format.hourShort"),
    minuteShort: t("format.minuteShort"),
  });
  const number =
    typeof item.IndexNumber === "number"
      ? formatTemplate(t("media.episodeNumber"), { number: item.IndexNumber })
      : null;
  const progress = partialProgress(item);

  const [watchedItem, setWatchedItem] = useState(item);
  const [showWatched, setShowWatched] = useState(() => isItemCompleted(item));
  useEffect(() => {
    setWatchedItem(item);
    setShowWatched(isItemCompleted(item));
  }, [item]);

  const id = useId();
  const titleId = `${id}-title`;
  const metaId = `${id}-meta`;
  const showImage = Boolean(imageUrl) && failedImageUrl !== imageUrl;

  return (
    <div
      className={`group relative flex items-stretch gap-3 rounded-xl p-2 transition-colors duration-200 ${
        isCurrent ? "bg-white/[0.11]" : "hover:bg-white/[0.05]"
      }`}
    >
      {/*
        The row's action is an overlay rather than a wrapper, so the watched
        control can sit beside it instead of inside it: nested buttons are
        invalid HTML and unreachable by keyboard.
      */}
      <button
        type="button"
        onClick={() => {
          if (!isCurrent) onPlayItem?.(item);
        }}
        aria-disabled={isCurrent ? "true" : undefined}
        aria-current={isCurrent ? "true" : undefined}
        aria-labelledby={`${titleId} ${metaId}`}
        className={`absolute inset-0 z-10 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          isCurrent ? "cursor-default" : "cursor-pointer"
        }`}
      />

      {/*
        Nothing is drawn over the still: it is the episode's own frame, and the
        row's background is what says which episode is playing. Progress sits
        just under the picture, in the row's padding, so no row changes height.
      */}
      <span className="relative w-[7.5rem] shrink-0 self-center sm:w-[8.75rem]">
        <span className="block aspect-video overflow-hidden rounded-lg bg-zinc-900">
          {showImage ? (
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              onError={() => setFailedImageUrl(imageUrl)}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-[radial-gradient(120%_90%_at_30%_20%,#3f3f46,#09090b)] text-2xl font-black tabular-nums text-white/25">
              {item.IndexNumber ?? ""}
            </span>
          )}
        </span>
        {progress > 0 ? (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-[calc(100%+4px)] h-[3px] overflow-hidden rounded-full bg-white/15"
          >
            <span
              className="block h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${progress * 100}%` }}
            />
          </span>
        ) : null}
      </span>

      <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
        <span
          id={metaId}
          className="flex items-center gap-1.5 text-[0.64rem] font-black uppercase tracking-[0.14em] text-white/45"
        >
          {number ? <span>{number}</span> : null}
          {runtime ? (
            <>
              <span aria-hidden="true" className="text-white/25">
                ·
              </span>
              <span className="tabular-nums">{runtime}</span>
            </>
          ) : null}
          {showWatched ? (
            <WatchedStatusButton
              scope="item"
              action={isItemCompleted(watchedItem) ? "remove" : "mark"}
              item={watchedItem}
              iconSize={12}
              onReset={(changedItems) => {
                const updated = changedItems.find(
                  (changed) => changed.Id === item.Id,
                );
                if (updated) {
                  setWatchedItem(updated);
                  // Stays visible after un-marking, so it can be undone.
                  setShowWatched(true);
                }
              }}
              className={`relative z-20 ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-[background-color,color] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
                isItemCompleted(watchedItem)
                  ? "bg-emerald-400/90 text-emerald-950 hover:bg-rose-500 hover:text-white"
                  : "bg-white/15 text-white hover:bg-emerald-400 hover:text-emerald-950"
              }`}
            />
          ) : null}
        </span>
        <span
          id={titleId}
          className="mt-0.5 line-clamp-2 text-[0.9rem] font-black leading-snug text-white"
        >
          {title}
        </span>
        {overview ? (
          <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/50">
            {overview}
          </span>
        ) : null}
      </span>
    </div>
  );
}
