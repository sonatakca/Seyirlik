import { useEffect, useRef, useState } from "react";
import {
  getPrimaryImageUrl,
  getShareCardImage,
  type ShareCardImage,
} from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";

/** The step the lock screen and headphone skip buttons move by. */
export const MEDIA_SESSION_SKIP_SECONDS = 10;

export interface MediaSessionMetadataInput {
  /** The title's own name in the site's language; an episode's is its own. */
  name: string;
  item: Pick<
    MediaItem,
    | "Id"
    | "Type"
    | "SeriesId"
    | "SeriesName"
    | "IndexNumber"
    | "ParentIndexNumber"
    | "ProductionYear"
    | "Genres"
    | "ImageTags"
  >;
  /**
   * The title's share card. Undefined while it is still being asked for, null
   * when the title has none and the plain cover stands in.
   */
  card?: ShareCardImage | null;
}

/** What an episode TMDB has not named is called: no name at all. */
const PLACEHOLDER_EPISODE_NAME = /^(episode|bölüm)\s*#?\d+$/i;

/** The item whose card an episode is shown with: its series'. */
export function mediaSessionCardItemId(
  item: Pick<MediaItem, "Id" | "Type" | "SeriesId">,
): string {
  return item.Type === "Episode" && item.SeriesId ? item.SeriesId : item.Id;
}

/**
 * What the operating system shows for the title on the lock screen, in the
 * Now Playing widget and on a watch.
 *
 * An episode leads with its own name, which is what changes from one to the
 * next, and is placed under its series by the second line ("House of the
 * Dragon · S1E1"). A film's second line is its year and first genre. The
 * picture is the title's card — the cover with its logo, as a shared link
 * shows it — and an episode is shown with its series' card: its own still is
 * a frame from the middle of it and reads as nothing at that size.
 */
export function describeMediaSessionMetadata({
  name,
  item,
  card,
}: MediaSessionMetadataInput): MediaMetadataInit {
  const isEpisode = item.Type === "Episode";
  const artwork: MediaImage[] =
    card === undefined
      ? []
      : card
        ? [
            {
              src: card.src,
              sizes: `${card.width}x${card.height}`,
              type: "image/jpeg",
            },
          ]
        : [
            {
              src: getPrimaryImageUrl(
                mediaSessionCardItemId(item),
                isEpisode ? undefined : item.ImageTags?.Primary,
                512,
              ),
              sizes: "512x768",
              type: "image/webp",
            },
          ];

  if (isEpisode) {
    const series = item.SeriesName?.trim() || "Seyirlik";
    const position = [
      item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : "",
      item.IndexNumber != null ? `E${item.IndexNumber}` : "",
    ].join("");
    const episodeName = name.trim();
    const named =
      episodeName.length > 0 && !PLACEHOLDER_EPISODE_NAME.test(episodeName);
    return {
      // Unnamed, the series is the title and the position tells it apart.
      title: named ? episodeName : series,
      artist: named
        ? [series, position].filter(Boolean).join(" · ")
        : position || series,
      album: "Seyirlik",
      artwork,
    };
  }

  const genre = item.Genres?.find((value) => value.trim().length > 0)?.trim();
  return {
    title: name,
    artist:
      [item.ProductionYear ? String(item.ProductionYear) : "", genre ?? ""]
        .filter(Boolean)
        .join(" · ") || "Seyirlik",
    album: "Seyirlik",
    artwork,
  };
}

interface MediaSessionControlsOptions extends Omit<
  MediaSessionMetadataInput,
  "card"
> {
  /** A party owns the media keys while it runs; see `usePartyPlayback`. */
  enabled: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onNextTrack?: () => void;
}

function mediaSessionOf(): MediaSession | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.mediaSession;
}

/**
 * Lock screen, Control Center, Bluetooth headphones and keyboard media keys.
 *
 * Without this the operating system only knows "a video is playing on
 * seyirlik.org": no title, no artwork, and on iOS the skip buttons do nothing.
 */
export function useMediaSessionControls({
  enabled,
  name,
  item,
  isPlaying,
  currentTime,
  duration,
  onTogglePlay,
  onSeekTo,
  onSeekBy,
  onNextTrack,
}: MediaSessionControlsOptions): void {
  const actionsRef = useRef({ onTogglePlay, onSeekTo, onSeekBy, onNextTrack });
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    actionsRef.current = { onTogglePlay, onSeekTo, onSeekBy, onNextTrack };
    isPlayingRef.current = isPlaying;
  });
  const hasNextTrack = Boolean(onNextTrack);

  const {
    Id,
    Type,
    SeriesId,
    SeriesName,
    IndexNumber,
    ParentIndexNumber,
    ProductionYear,
  } = item;
  const primaryTag = item.ImageTags?.Primary;
  const genre = item.Genres?.find((value) => value.trim().length > 0);

  // The card is asked for once per title; the next episode of a series finds
  // its series' answer already there and changes picture with no gap.
  const cardItemId = mediaSessionCardItemId({ Id, Type, SeriesId });
  const [cardLookup, setCardLookup] = useState<{
    itemId: string;
    card: ShareCardImage | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void getShareCardImage(cardItemId).then((card) => {
      if (current) setCardLookup({ itemId: cardItemId, card });
    });
    return () => {
      current = false;
    };
  }, [cardItemId]);
  // Until it answers the title shows with no picture rather than flashing the
  // plain cover and then swapping it.
  const card = cardLookup?.itemId === cardItemId ? cardLookup.card : undefined;

  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession || typeof MediaMetadata === "undefined") return;
    mediaSession.metadata = new MediaMetadata(
      describeMediaSessionMetadata({
        name,
        item: {
          Id,
          Type,
          SeriesId,
          SeriesName,
          IndexNumber,
          ParentIndexNumber,
          ProductionYear,
          Genres: genre ? [genre] : undefined,
          ImageTags: primaryTag ? { Primary: primaryTag } : undefined,
        },
        card,
      }),
    );
  }, [
    Id,
    IndexNumber,
    ParentIndexNumber,
    ProductionYear,
    SeriesId,
    SeriesName,
    Type,
    card,
    genre,
    name,
    primaryTag,
  ]);

  useEffect(
    () => () => {
      const mediaSession = mediaSessionOf();
      if (!mediaSession) return;
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
    },
    [],
  );

  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession) return;
    mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Whole seconds are enough for a scrubber the size of a lock screen, and
  // keep this from running on every timeupdate.
  const wholeSecond = Math.floor(currentTime);
  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!mediaSession?.setPositionState) return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      mediaSession.setPositionState({
        duration,
        // The player has no speed control; only a party catch-up nudges the
        // rate, and briefly.
        playbackRate: 1,
        position: Math.min(Math.max(0, wholeSecond), duration),
      });
    } catch {
      // Safari throws on a position past a duration it has not caught up to.
    }
  }, [duration, wholeSecond]);

  useEffect(() => {
    const mediaSession = mediaSessionOf();
    if (!enabled || !mediaSession) return undefined;

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      [
        "play",
        () => !isPlayingRef.current && actionsRef.current.onTogglePlay(),
      ],
      [
        "pause",
        () => isPlayingRef.current && actionsRef.current.onTogglePlay(),
      ],
      [
        "seekto",
        (details) => {
          if (typeof details.seekTime === "number") {
            actionsRef.current.onSeekTo(details.seekTime);
          }
        },
      ],
      [
        "seekbackward",
        (details) =>
          actionsRef.current.onSeekBy(
            -(details.seekOffset ?? MEDIA_SESSION_SKIP_SECONDS),
          ),
      ],
      [
        "seekforward",
        (details) =>
          actionsRef.current.onSeekBy(
            details.seekOffset ?? MEDIA_SESSION_SKIP_SECONDS,
          ),
      ],
    ];
    if (hasNextTrack) {
      handlers.push(["nexttrack", () => actionsRef.current.onNextTrack?.()]);
    }

    for (const [action, handler] of handlers) {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Not every browser supports every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [enabled, hasNextTrack]);
}
