import type {
  MediaItem,
  MediaLibrary,
  MediaUserData,
  MediaSource,
  MediaStream,
} from "../../lib/types";
import type {
  ItemDto,
  LibraryDto,
  MediaSourceDto,
  MediaStreamDto,
  UserItemStateDto,
} from "./dto";

/**
 * Bridges the native wire format to the view models the UI renders.
 *
 * The view model keeps its existing field names and tick-based durations so the
 * player's arithmetic and every component prop stay unchanged. This is the only
 * module allowed to know both shapes: the API contract is native and free to
 * evolve, and the UI is insulated from it.
 */

/** One tick is 100 nanoseconds, the unit the player and progress code use. */
const TICKS_PER_MILLISECOND = 10_000;

export function msToTicks(
  milliseconds: number | undefined,
): number | undefined {
  return milliseconds === undefined
    ? undefined
    : Math.round(milliseconds * TICKS_PER_MILLISECOND);
}

export function ticksToMs(ticks: number | undefined): number {
  return ticks === undefined ? 0 : Math.round(ticks / TICKS_PER_MILLISECOND);
}

const KIND_TO_TYPE: Record<string, string> = {
  movie: "Movie",
  series: "Series",
  season: "Season",
  episode: "Episode",
  book: "Book",
  collection: "BoxSet",
  trailer: "Trailer",
};

const KIND_TO_MEDIA_TYPE: Record<string, string> = {
  movie: "Video",
  episode: "Video",
  trailer: "Video",
  book: "Book",
};

function toUserData(
  state: UserItemStateDto | undefined,
): MediaUserData | undefined {
  if (!state) return undefined;

  return {
    PlaybackPositionTicks: msToTicks(state.positionMs) ?? 0,
    PlayCount: state.playCount,
    IsFavorite: state.isFavourite,
    Played: state.played,
    ...(state.playedPercentage === undefined
      ? {}
      : { PlayedPercentage: state.playedPercentage }),
    LastPlayedDate: state.lastPlayedAt ?? null,
  };
}

function toMediaStream(stream: MediaStreamDto): MediaStream {
  const type =
    stream.kind === "video"
      ? "Video"
      : stream.kind === "audio"
        ? "Audio"
        : stream.kind === "subtitle"
          ? "Subtitle"
          : stream.kind;

  return {
    Index: stream.index,
    Type: type,
    ...(stream.codec === null ? {} : { Codec: stream.codec }),
    ...(stream.profile === null ? {} : { Profile: stream.profile }),
    ...(stream.level === null ? {} : { Level: stream.level }),
    ...(stream.language === null ? {} : { Language: stream.language }),
    ...(stream.title === null ? {} : { Title: stream.title }),
    IsDefault: stream.isDefault,
    IsForced: stream.isForced,
    IsExternal: stream.isExternal,
    IsTextSubtitleStream: stream.isTextSubtitle,
    ...(stream.channels === null ? {} : { Channels: stream.channels }),
    ...(stream.bitrateBps === null ? {} : { BitRate: stream.bitrateBps }),
    ...(stream.width === null ? {} : { Width: stream.width }),
    ...(stream.height === null ? {} : { Height: stream.height }),
    ...(stream.frameRate === null
      ? {}
      : { AverageFrameRate: stream.frameRate }),
    ...(stream.videoRange === null ? {} : { VideoRange: stream.videoRange }),
    // Existing player code distinguishes HDR by the display title as well as
    // the range, so the derived label is preserved.
    ...(stream.language || stream.title
      ? {
          DisplayTitle: [stream.title, stream.language]
            .filter(Boolean)
            .join(" "),
        }
      : {}),
  };
}

export function toMediaSource(source: MediaSourceDto): MediaSource {
  return {
    Id: source.id,
    Protocol: "File",
    ...(source.container === null ? {} : { Container: source.container }),
    Size: source.sizeBytes,
    ...(source.bitrateBps === null ? {} : { Bitrate: source.bitrateBps }),
    ...(source.durationMs === null
      ? {}
      : { RunTimeTicks: msToTicks(source.durationMs) }),
    MediaStreams: source.streams.map(toMediaStream),
  };
}

/**
 * Artwork is addressed by item and type rather than by a provider tag, so the
 * URL builders stay stable while the underlying image is replaced. The content
 * hash rides along as a cache-busting query value.
 */
export function toMediaItem(item: ItemDto): MediaItem {
  const images = item.images;

  return {
    Id: item.id,
    Name: item.title,
    SortName: item.sortTitle,
    Type: KIND_TO_TYPE[item.kind] ?? item.kind,
    ...(KIND_TO_MEDIA_TYPE[item.kind]
      ? { MediaType: KIND_TO_MEDIA_TYPE[item.kind] as string }
      : {}),
    ...(item.originalTitle ? { OriginalTitle: item.originalTitle } : {}),
    ...(item.overview ? { Overview: item.overview } : {}),
    ...(item.tagline ? { Taglines: [item.tagline] } : {}),
    ...(item.productionYear === undefined
      ? {}
      : { ProductionYear: item.productionYear }),
    ...(item.premiereDate ? { PremiereDate: item.premiereDate } : {}),
    DateCreated: item.dateCreated,
    ...(item.officialRating ? { OfficialRating: item.officialRating } : {}),
    ...(item.communityRating === undefined
      ? {}
      : { CommunityRating: item.communityRating }),
    ...(item.runtimeMs === undefined
      ? {}
      : { RunTimeTicks: msToTicks(item.runtimeMs) }),
    ...(item.indexNumber === undefined
      ? {}
      : { IndexNumber: item.indexNumber }),
    ...(item.parentIndexNumber === undefined
      ? {}
      : { ParentIndexNumber: item.parentIndexNumber }),
    ...(item.parentId ? { ParentId: item.parentId } : {}),
    ...(item.seriesId ? { SeriesId: item.seriesId } : {}),
    ...(item.seriesTitle ? { SeriesName: item.seriesTitle } : {}),
    ...(item.seasonId ? { SeasonId: item.seasonId } : {}),
    ...(item.seasonTitle ? { SeasonName: item.seasonTitle } : {}),
    Genres: item.genres,
    ProviderIds: item.providerIds,
    ...(item.logoLayout ? { LogoLayout: item.logoLayout } : {}),
    ...(item.seriesLogoLayout
      ? { SeriesLogoLayout: item.seriesLogoLayout }
      : {}),
    ...(item.childCount === undefined ? {} : { ChildCount: item.childCount }),
    ...(item.recursiveItemCount === undefined
      ? {}
      : { RecursiveItemCount: item.recursiveItemCount }),
    ImageTags: {
      ...(images.cover ? { Primary: images.cover.tag } : {}),
      ...(images.logo ? { Logo: images.logo.tag } : {}),
      ...(images.thumb ? { Thumb: images.thumb.tag } : {}),
      ...(images.banner ? { Banner: images.banner.tag } : {}),
    },
    BackdropImageTags: images.backdrops.map((backdrop) => backdrop.tag),
    // Inherited artwork lets an episode card fall back to its series poster
    // without the component knowing where it came from.
    ...(images.parentCover
      ? { SeriesPrimaryImageTag: images.parentCover.tag }
      : {}),
    ...(images.parentLogo && item.seriesId
      ? {
          ParentLogoItemId: item.seriesId,
          ParentLogoImageTag: images.parentLogo.tag,
        }
      : {}),
    ...(images.parentBackdrops &&
    images.parentBackdrops.length > 0 &&
    item.seriesId
      ? {
          ParentBackdropItemId: item.seriesId,
          ParentBackdropImageTags: images.parentBackdrops.map(
            (backdrop) => backdrop.tag,
          ),
        }
      : {}),
    ...(item.userState ? { UserData: toUserData(item.userState) } : {}),
  };
}

export function toMediaItems(items: ItemDto[]): MediaItem[] {
  return items.map(toMediaItem);
}

export function toMediaLibrary(library: LibraryDto): MediaLibrary {
  return {
    Id: library.id,
    Name: library.name,
    Type: "CollectionFolder",
    CollectionType:
      library.kind === "movies"
        ? "movies"
        : library.kind === "series"
          ? "tvshows"
          : library.kind === "books"
            ? "books"
            : library.kind,
    ChildCount: library.itemCount,
    ImageTags: {},
  };
}
