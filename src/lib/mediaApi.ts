import {
  OwnApiClientError,
  ownApiClient,
  ownApiUrl,
} from "../api/ownApi/client";
import { nextProgressSequence } from "./progressSequence";
import type { CuratedEntry, CuratedList, CuratedSurface } from "./curation";
import {
  toMediaItem,
  toMediaItems,
  toMediaLibrary,
  toMediaSource,
  ticksToMs,
} from "../api/ownApi/adapters";
import type {
  ChapterDto,
  HomeDto,
  ItemDto,
  ItemPersonDto,
  ItemStreamsDto,
  LibraryDto,
  PlaybackSessionDto,
  SegmentDto,
  TaskDto,
} from "../api/ownApi/dto";
import { buildClientCapabilities } from "./playback-planner/clientCapabilities";
import { CARD_LOGO_OVERLAY_VARIANT, type LogoLayout } from "./logoLayout";
import type {
  MediaItem,
  MediaLibrary,
  MediaSource,
  MediaUser,
  MediaUserPolicy,
  MetadataRefreshOptions,
  NormalizedMediaSegment,
  PlaybackInfoResponse,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "./types";

/**
 * The application's media API.
 *
 * Every call here reaches Seyirlik's own `/ownAPI/v1` surface. Identifiers are
 * opaque, durations cross the wire in milliseconds and are converted to ticks by
 * the adapter layer, and the session cookie is the only credential — there is no
 * access token in local storage and no server URL to configure.
 */

export const SERVER_UNAVAILABLE_EVENT = "seyirlik:server-unavailable";

/**
 * Emitted when the API cannot be reached. There is no server URL: Seyirlik now
 * talks to its own backend at the same origin, so the only useful diagnostics
 * are what the failed request reported.
 */
export interface ServerUnavailableEventDetail {
  reason?: string;
  status?: number;
  statusText?: string;
  code?: string;
  message?: string;
  requestUrl?: string;
}

export type ServerUnavailableEvent = CustomEvent<ServerUnavailableEventDetail>;

const TICKS_PER_SECOND = 10_000_000;

export function ticksFromSeconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

/**
 * Hides the session id in a playback URL while keeping the rest intact.
 *
 * A session id is a capability, so it must not reach a log or a diagnostics
 * panel — but the origin, path and remaining query are exactly what makes those
 * panels useful, so they are preserved.
 */
export function redactPlaybackUrl(playbackUrl: string): string {
  const redactSession = (value: string): string =>
    value.replace(
      /\/playback\/sessions\/[^/?#]+/g,
      "/playback/sessions/[redacted]",
    );

  try {
    return redactSession(
      new URL(playbackUrl, window.location.origin).toString(),
    );
  } catch {
    return redactSession(playbackUrl);
  }
}

// ---------------------------------------------------------------- artwork

function imageUrl(
  itemId: string,
  imageType: string,
  tag: string | undefined,
  maxWidth: number,
): string {
  const query = new URLSearchParams();
  // The content hash busts the browser cache when artwork is replaced; the
  // server validates with an ETag regardless.
  if (tag) query.set("tag", tag);
  if (maxWidth) query.set("maxWidth", String(maxWidth));
  // Separates optimized artwork URLs from the old endpoints that returned the
  // full original file under the same maxWidth query.
  if (maxWidth) query.set("variant", "webp-v1");
  const suffix = query.toString();
  return ownApiUrl(
    `/ownAPI/v1/items/${encodeURIComponent(itemId)}/images/${imageType}${
      suffix ? `?${suffix}` : ""
    }`,
  );
}

export function getPrimaryImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 500,
): string {
  // `Primary` is the legacy view-model name. The native catalogue calls the
  // title-owned file what it is: the cover.
  return imageUrl(itemId, "cover", tag, maxWidth);
}

export function getBackdropImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 1600,
): string {
  return imageUrl(itemId, "backdrop", tag, maxWidth);
}

export function getLogoImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 900,
): string {
  return imageUrl(itemId, "logo", tag, maxWidth);
}

/**
 * Turns an own-API logo URL into a transparent, full-poster layer containing
 * the placed logo and its already-rasterized shadow. Other image providers do
 * not understand this variant, so callers retain their CSS fallback for them.
 */
export function getCardLogoOverlayImageUrl(
  logoUrl: string,
  layoutItemId: string,
  layout: LogoLayout,
  maxWidth: number,
): string | null {
  try {
    const parsed = new URL(logoUrl, window.location.href);
    if (!/\/ownAPI\/v1\/items\/[^/]+\/images\/logo$/.test(parsed.pathname)) {
      return null;
    }

    parsed.searchParams.set("maxWidth", String(maxWidth));
    parsed.searchParams.set("variant", CARD_LOGO_OVERLAY_VARIANT);
    parsed.searchParams.set("layoutItemId", layoutItemId);
    // The server reads the authoritative layout from the catalogue. This value
    // only changes the browser URL when the operator moves or reshades a logo,
    // so a week-long private image cache cannot retain the previous drawing.
    parsed.searchParams.set(
      "layout",
      [layout.x, layout.y, layout.width, layout.shadow]
        .map((value) => value.toFixed(6))
        .join(","),
    );
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getThumbImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 900,
): string {
  return imageUrl(itemId, "thumb", tag, maxWidth);
}

// -------------------------------------------------------------- catalogue

export async function getUserViews(): Promise<MediaLibrary[]> {
  const libraries = await ownApiClient.request<LibraryDto[]>("/libraries");
  return libraries.map(toMediaLibrary);
}

/** Drains a cursor-paginated collection into a single list. */
async function collectAll(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ limit: "200", ...searchParams });
    if (cursor) query.set("cursor", cursor);

    const page = await ownApiClient.requestCollection<ItemDto>(
      `${path}?${query.toString()}`,
    );
    items.push(...toMediaItems(page.data));
    cursor = page.pagination?.nextCursor ?? null;
  } while (cursor);

  return items;
}

export async function getItem(itemId: string): Promise<MediaItem> {
  return toMediaItem(
    await ownApiClient.request<ItemDto>(`/items/${encodeURIComponent(itemId)}`),
  );
}

/**
 * Loads the item together with its sources and their tracks.
 *
 * Catalogue items intentionally do not expose filesystem paths, and a book's
 * display title normally has no extension. The source endpoint supplies the
 * safe, path-free container value (for example `epub` or `pdf`) so the reader
 * does not mistake every book for an unsupported generic file. A download
 * keeps the same, so a stored film knows its audio and subtitle tracks with
 * no playback session to learn them from.
 */
export async function getItemWithSources(itemId: string): Promise<MediaItem> {
  const encodedItemId = encodeURIComponent(itemId);
  const [item, streams] = await Promise.all([
    ownApiClient.request<ItemDto>(`/items/${encodedItemId}`),
    ownApiClient.request<ItemStreamsDto>(`/items/${encodedItemId}/streams`),
  ]);

  return {
    ...toMediaItem(item),
    MediaSources: streams.sources.map(toMediaSource),
  };
}

export const getReaderItem = getItemWithSources;

export async function getItemsForLibrary(
  libraryId: string,
): Promise<MediaItem[]> {
  return collectAll(`/libraries/${encodeURIComponent(libraryId)}/items`);
}

/**
 * Children of an item of any kind.
 *
 * Distinct from {@link getItemsForLibrary}: a library is not an item, and an
 * item is not a library. A leaf such as a film has no children, which this
 * reports as an empty list rather than a missing-item error.
 */
export async function getItemChildren(itemId: string): Promise<MediaItem[]> {
  return collectAll(`/items/${encodeURIComponent(itemId)}/children`);
}

export async function getTopLevelItemsForLibrary(
  libraryId: string,
  // The native library endpoint already returns the top-level kinds, so the
  // collection type the caller passes is no longer needed to choose a query.
  _collectionType?: string,
): Promise<MediaItem[]> {
  return getItemsForLibrary(libraryId);
}

export async function getVideoItemsForLibrary(
  libraryId: string,
): Promise<MediaItem[]> {
  return getItemsForLibrary(libraryId);
}

export async function getAllMovieItems(): Promise<MediaItem[]> {
  return collectAll("/movies");
}

export async function getAllSeriesItems(): Promise<MediaItem[]> {
  return collectAll("/series");
}

export async function getAllBookItems(): Promise<MediaItem[]> {
  return collectAll("/books");
}

export async function getAllMovieAndSeriesItems(): Promise<MediaItem[]> {
  const [movies, series] = await Promise.all([
    getAllMovieItems(),
    getAllSeriesItems(),
  ]);
  return [...movies, ...series];
}

/**
 * Every title an administrator can dress, including the ones not on disk yet:
 * a wanted film's artwork is worth choosing before it arrives.
 */
export async function getAllArtworkItems(): Promise<MediaItem[]> {
  const withMissing = { includeMissing: "true" };
  const [movies, series, books] = await Promise.all([
    collectAll("/movies", withMissing),
    collectAll("/series", withMissing),
    collectAll("/books", withMissing),
  ]);
  return [...movies, ...series, ...books];
}

export async function getAllVideoItems(): Promise<MediaItem[]> {
  return getAllMovieAndSeriesItems();
}

export async function getAllBoxSetItems(): Promise<MediaItem[]> {
  return collectAll("/collections");
}

export async function getBoxSetItems(boxSetId: string): Promise<MediaItem[]> {
  return getItemChildren(boxSetId);
}

export async function getSeriesSeasons(seriesId: string): Promise<MediaItem[]> {
  const seasons = await ownApiClient.request<ItemDto[]>(
    `/series/${encodeURIComponent(seriesId)}/seasons`,
  );
  return toMediaItems(seasons);
}

export async function getSeasonEpisodes(
  _seriesId: string,
  seasonId: string,
): Promise<MediaItem[]> {
  const episodes = await ownApiClient.request<ItemDto[]>(
    `/seasons/${encodeURIComponent(seasonId)}/episodes`,
  );
  return toMediaItems(episodes);
}

export async function getAllSeriesEpisodes(
  seriesId: string,
): Promise<MediaItem[]> {
  const episodes = await ownApiClient.request<ItemDto[]>(
    `/series/${encodeURIComponent(seriesId)}/episodes`,
  );
  return toMediaItems(episodes);
}

export async function getNextEpisodeInSeason(
  currentEpisode: MediaItem,
): Promise<MediaItem | null> {
  const next = await ownApiClient.request<ItemDto | null>(
    `/episodes/${encodeURIComponent(currentEpisode.Id)}/next`,
  );
  return next ? toMediaItem(next) : null;
}

export async function getLocalTrailers(itemId: string): Promise<MediaItem[]> {
  const trailers = await ownApiClient.request<ItemDto[]>(
    `/items/${encodeURIComponent(itemId)}/trailers`,
  );
  return toMediaItems(trailers);
}

/** Cast in billing order, then crew; one entry per credited role. */
export async function getItemPeople(itemId: string): Promise<ItemPersonDto[]> {
  return ownApiClient.request<ItemPersonDto[]>(
    `/items/${encodeURIComponent(itemId)}/people`,
  );
}

export async function getSimilarItems(
  itemId: string,
  limit = 18,
): Promise<MediaItem[]> {
  const item = await getItem(itemId);
  const genre = item.Genres?.[0];
  if (!genre) return [];

  // Similarity is genre-based rather than provider-supplied, so a title stays
  // discoverable even when it was never matched against a provider.
  const page = await ownApiClient.requestCollection<ItemDto>(
    `/movies?limit=${limit + 1}&genre=${encodeURIComponent(genre)}`,
  );
  return toMediaItems(page.data).filter((candidate) => candidate.Id !== itemId);
}

export async function getLatestMediaItems(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/latest?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getContinueWatchingItems(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/continue-watching?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getNextUpEpisodes(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/next-up?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getHome(): Promise<HomeDto> {
  return ownApiClient.request<HomeDto>("/home");
}

export async function searchItems(query: string): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    `/search?q=${encodeURIComponent(query)}`,
  );
  return toMediaItems(page.data);
}

export async function getFavouriteItems(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>("/favourites");
  return toMediaItems(page.data);
}

// ------------------------------------------------------------- user state

export async function markItemPlayed(itemId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/items/${encodeURIComponent(itemId)}/played`,
    { method: "POST" },
  );
}

export async function markItemUnplayed(itemId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/items/${encodeURIComponent(itemId)}/played`,
    { method: "DELETE" },
  );
}

/** Clears progress for an item and everything beneath it in one request. */
export async function resetItemWatchedStatus(itemId: string): Promise<void> {
  await ownApiClient.request<{ affected: number }>(
    `/items/${encodeURIComponent(itemId)}/watched/reset`,
    { method: "POST", body: {} },
  );
}

/** Marks an item and everything beneath it watched in one request. */
export async function markItemWatchedStatus(itemId: string): Promise<void> {
  await ownApiClient.request<{ affected: number }>(
    `/items/${encodeURIComponent(itemId)}/watched/mark`,
    { method: "POST", body: {} },
  );
}

export async function setItemFavourite(
  itemId: string,
  isFavourite: boolean,
): Promise<void> {
  await ownApiClient.request<void>(
    `/favourites/${encodeURIComponent(itemId)}`,
    { method: isFavourite ? "POST" : "DELETE" },
  );
}

async function writeProgress(
  itemId: string,
  positionTicks: number,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  try {
    await ownApiClient.request<unknown>(
      `/progress/${encodeURIComponent(itemId)}`,
      {
        method: "PUT",
        keepalive: options.keepalive,
        body: {
          positionMs: ticksToMs(positionTicks),
          sequence: nextProgressSequence(),
        },
      },
    );
  } catch (error) {
    // A rejected stale write is expected during normal playback and must not
    // surface as a player error.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "PROGRESS_STALE"
    ) {
      return;
    }
    throw error;
  }
}

export async function reportPlaybackStart(
  source: PlaybackSourceCandidate,
  positionTicks = 0,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
}

export async function reportPlaybackProgress(
  source: PlaybackSourceCandidate,
  positionTicks: number,
  // Pause state is not part of native progress: the resume position is what
  // matters, and the player already knows whether it is paused.
  _isPaused?: boolean,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
}

/**
 * Records where the viewer stopped.
 *
 * Deliberately does not end the server session. "Stopped" fires when playback
 * reaches the end of a title, and the media element is still attached and still
 * seekable at that point: a viewer who scrubs back into the film needs the same
 * session to keep serving bytes. Ending it here meant the first request after
 * the credits returned 404 and the element died with
 * `PIPELINE_ERROR_READ: FFmpegDemuxer: data source error`, with no way back
 * short of reloading the page.
 *
 * Session lifetime belongs to the lease, which ends a session once nothing is
 * attached to it any more, and to the explicit page-exit path.
 */
export async function reportPlaybackStopped(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
}

/**
 * Fired from `pagehide`/`beforeunload`, where a normal request is cancelled.
 * A `keepalive` request outlives the page like `sendBeacon` does, but unlike a
 * beacon it can be a PUT and carry the CSRF header, which the progress route
 * requires — the beacon this replaced was refused with 405 on every exit.
 */
export function reportPlaybackStoppedBeforeUnload(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): void {
  writeProgress(source.itemId, positionTicks, { keepalive: true }).catch(() => {
    // The page is going away; there is no one left to tell.
  });
}

// Audit reporting used to be a separate session channel on the old backend. Native
// progress already records everything the audit page reads, so these remain as
// no-ops to keep the player's call sites unchanged.
export async function reportAuditPlaybackStart(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}
export async function reportAuditPlaybackProgress(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}
export async function reportAuditPlaybackStopped(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}

// --------------------------------------------------------------- playback

export async function getMediaSegments(
  itemId: string,
): Promise<NormalizedMediaSegment[]> {
  const segments = await ownApiClient.request<SegmentDto[]>(
    `/items/${encodeURIComponent(itemId)}/segments`,
  );
  return segments.map((segment) => ({
    id: segment.id,
    type: segment.type,
    startSeconds: segment.startMs / 1_000,
    endSeconds: segment.endMs / 1_000,
  }));
}

export async function getChapters(itemId: string): Promise<ChapterDto[]> {
  return ownApiClient.request<ChapterDto[]>(
    `/items/${encodeURIComponent(itemId)}/chapters`,
  );
}

/**
 * Creates a playback session and adapts it to the response shape the player
 * already consumes.
 */
export async function getPlaybackInfo(
  itemId: string,
  settings: PlaybackSourceSettings = {},
): Promise<PlaybackInfoResponse> {
  const capabilities = await buildClientCapabilities();
  const session = await ownApiClient.request<PlaybackSessionDto>(
    "/playback/sessions",
    {
      method: "POST",
      body: {
        itemId,
        clientCapabilities: capabilities,
        ...(settings.audioStreamIndex === undefined
          ? {}
          : { audioStreamIndex: settings.audioStreamIndex }),
        ...(settings.maxHeight === undefined
          ? {}
          : { maxHeight: settings.maxHeight }),
        ...(settings.qualityHeight === undefined
          ? {}
          : { qualityHeight: settings.qualityHeight }),
        ...(settings.maxStreamingBitrate === undefined
          ? {}
          : { maxBitrateBps: settings.maxStreamingBitrate }),
        ...(settings.startTimeMs === undefined
          ? {}
          : { startTimeMs: settings.startTimeMs }),
      },
    },
  );

  const streams = await ownApiClient.request<ItemStreamsDto>(
    `/items/${encodeURIComponent(itemId)}/streams`,
  );
  const primary =
    streams.sources.find((source) => source.id === session.mediaFileId) ??
    streams.sources[0];

  const mediaSource: MediaSource = {
    ...(primary ? toMediaSource(primary) : { Id: session.mediaFileId }),
    SupportsDirectPlay: session.plan.mode === "DIRECT_PLAY",
    SupportsDirectStream: session.plan.mode !== "TRANSCODE",
    SupportsTranscoding: true,
    TranscodingReasons: session.plan.reasonCodes,
    ...(session.delivery.type === "hls"
      ? {
          TranscodingUrl: ownApiUrl(session.delivery.url),
          TranscodingSubProtocol: "hls",
        }
      : { DirectStreamUrl: ownApiUrl(session.delivery.url) }),
  };

  return {
    MediaSources: [mediaSource],
    PlaySessionId: session.sessionId,
    sessionPlan: session.plan,
    // Rendition URLs are server-relative for the same reason the delivery URL
    // is: a deployment that serves the app and the API from different hosts has
    // to send the browser to the API's origin, not its own.
    ...(session.qualityManifest
      ? {
          qualityManifest: {
            ...session.qualityManifest,
            ...(session.qualityManifest.adaptive
              ? {
                  adaptive: {
                    ...session.qualityManifest.adaptive,
                    playbackUrl: ownApiUrl(
                      session.qualityManifest.adaptive.playbackUrl,
                    ),
                  },
                }
              : {}),
            qualities: session.qualityManifest.qualities.map((quality) => ({
              ...quality,
              playbackUrl: ownApiUrl(quality.playbackUrl),
            })),
          },
        }
      : {}),
  };
}

function sessionPlanUsesAudioTranscode(
  playbackInfo: PlaybackInfoResponse,
): boolean {
  const plan = playbackInfo.sessionPlan;
  return plan?.audio.action === "transcode" && plan.video.action === "copy";
}

export function buildPlaybackCandidates(
  itemId: string,
  playbackInfo: PlaybackInfoResponse,
): PlaybackSourceCandidate[] {
  const mediaSource = playbackInfo.MediaSources?.[0];
  if (!mediaSource) return [];

  const isHls = Boolean(mediaSource.TranscodingUrl);
  const adaptive = playbackInfo.qualityManifest?.adaptive;
  const deliveryUrl =
    mediaSource.TranscodingUrl ?? mediaSource.DirectStreamUrl ?? "";
  /**
   * The server's delivery URL is the authority, not the package manifest.
   *
   * The manifest describes the pre-generated package and is sent alongside
   * every plan, including the plans where the server deliberately chose a live
   * session because the package cannot serve this request — asking for an
   * audio track the retention policy dropped is the ordinary case. Preferring
   * the manifest there played the package instead of the stream the server
   * planned: the requested track never came on, and re-attaching the same URL
   * restarted the title from the beginning.
   */
  const usesAdaptiveRendition =
    Boolean(adaptive) && deliveryUrl === adaptive?.playbackUrl;
  const url = deliveryUrl || (adaptive?.playbackUrl ?? "");
  const mode = mediaSource.SupportsDirectPlay
    ? "DirectPlay"
    : mediaSource.SupportsDirectStream
      ? "DirectStream"
      : "Transcoding";

  return [
    {
      id: `${itemId}-native`,
      itemId,
      ...(mediaSource.Id ? { mediaSourceId: mediaSource.Id } : {}),
      ...(playbackInfo.PlaySessionId
        ? { playSessionId: playbackInfo.PlaySessionId }
        : {}),
      mode: usesAdaptiveRendition ? "DirectPlay" : mode,
      url,
      isHls: isHls || usesAdaptiveRendition,
      ...(isHls || usesAdaptiveRendition
        ? {
            hlsKind: usesAdaptiveRendition
              ? ("adaptive-rendition" as const)
              : sessionPlanUsesAudioTranscode(playbackInfo)
                ? ("audio-transcode" as const)
                : ("forced-transcode" as const),
            usingHlsJs: true,
          }
        : {}),
      ...(isHls || usesAdaptiveRendition
        ? { mimeType: "application/vnd.apple.mpegurl" }
        : mediaSource.Container
          ? { mimeType: `video/${mediaSource.Container}` }
          : {}),
      label: usesAdaptiveRendition
        ? "Pre-generated adaptive stream"
        : isHls
          ? "Adaptive stream"
          : "Original file",
      mediaSource,
      playbackInfo,
      ...(playbackInfo.qualityManifest
        ? { qualityManifest: playbackInfo.qualityManifest }
        : {}),
      reason: usesAdaptiveRendition
        ? "Validated aligned CMAF renditions are available without live transcoding."
        : isHls
          ? "The server is repackaging this title for your browser."
          : "Your browser can play this file directly.",
      ...(mediaSource.TranscodingReasons
        ? { transcodeReasons: mediaSource.TranscodingReasons }
        : {}),
      priority: 0,
    },
  ];
}

/**
 * Re-plans the same item under an explicit quality ceiling. Native playback
 * changes quality by creating a new session, so unlike the URL-rewriting this
 * replaces, it is asynchronous.
 */
export async function buildConfiguredHlsPlaybackSource(
  source: PlaybackSourceCandidate,
  settings: PlaybackSourceSettings,
  label = "Custom quality",
): Promise<PlaybackSourceCandidate | null> {
  const playbackInfo = await getPlaybackInfo(source.itemId, settings);
  const [candidate] = buildPlaybackCandidates(source.itemId, playbackInfo);
  return candidate ? { ...candidate, label } : null;
}

const QUALITY_LADDER: Array<{
  height: number;
  label: string;
  bitrate: number;
}> = [
  { height: 2160, label: "4K", bitrate: 60_000_000 },
  { height: 1080, label: "1080p", bitrate: 12_000_000 },
  { height: 720, label: "720p", bitrate: 6_000_000 },
  { height: 480, label: "480p", bitrate: 3_000_000 },
];

export function getManualQualityOptions(
  mediaSource: MediaSource,
): PlaybackQualityOption[] {
  const video = mediaSource.MediaStreams?.find(
    (stream) => stream.Type === "Video",
  );
  const sourceHeight = video?.Height ?? 1080;

  // Never offer a rung above the source: upscaling costs a transcode and gains
  // nothing.
  return QUALITY_LADDER.filter((rung) => rung.height <= sourceHeight).map(
    (rung) => ({
      id: `h${rung.height}`,
      label: rung.label,
      subtitle: `${Math.round(rung.bitrate / 1_000_000)} Mbps`,
      maxHeight: rung.height,
      maxStreamingBitrate: rung.bitrate,
    }),
  );
}

export function buildSubtitleStreamUrl(
  sessionId: string,
  subtitleStreamIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/playback/sessions/${encodeURIComponent(
      sessionId,
    )}/subtitles/${subtitleStreamIndex}.vtt`,
  );
}

/**
 * The frame at `atSeconds`, cut from the original file at full resolution.
 *
 * Fetched rather than linked: the API can live on another origin, where an
 * `<a download>` navigates instead of saving and drops the session cookie.
 */
export async function fetchOriginalFrame(
  sessionId: string,
  atSeconds: number,
): Promise<Blob> {
  const frameUrl = `${ownApiUrl(
    `/ownAPI/v1/playback/sessions/${encodeURIComponent(sessionId)}/frame.png`,
  )}?at=${atSeconds.toFixed(3)}`;
  const response = await fetch(frameUrl, { credentials: "include" });

  if (!response.ok) {
    throw new Error(`Frame request failed with ${response.status}`);
  }

  return response.blob();
}

export function getItemFileUrl(sessionId: string): string {
  return ownApiUrl(
    `/ownAPI/v1/playback/sessions/${encodeURIComponent(sessionId)}/file`,
  );
}

/**
 * The file behind a book, by item.
 *
 * A book has no playback session — there is nothing to plan or transcode — so
 * it is read straight from the catalogue. The reader was calling
 * `getItemFileUrl` with an item id, which asks the playback route for a session
 * that could never exist and gets a 404 for its trouble.
 */
export function getBookFileUrl(itemId: string): string {
  return ownApiUrl(`/ownAPI/v1/items/${encodeURIComponent(itemId)}/file`);
}

export function getItemDownloadUrl(sessionId: string): string {
  return getItemFileUrl(sessionId);
}

export async function getHeroPreviewUrl(
  _item?: MediaItem,
): Promise<string | null> {
  // Hero preview clips are not part of the native catalogue yet; the hero falls
  // back to its backdrop rather than silently playing the feature.
  return null;
}

export async function stopActiveTranscodeSession(
  playSessionId?: string,
): Promise<void> {
  if (!playSessionId) return;
  await ownApiClient
    .request<void>(`/playback/sessions/${encodeURIComponent(playSessionId)}`, {
      method: "DELETE",
    })
    .catch(() => undefined);
}

/**
 * Live transcoding reasons for a session, or `null` once that session is gone.
 *
 * The distinction matters to the caller that polls this. A session is retired
 * whenever the source is replaced — an audio change, a quality change, leaving
 * the page — and a poller keyed to the old id would otherwise ask for it every
 * few seconds forever, filling the console with 404s that describe nothing the
 * viewer can act on. `null` means "stop asking"; an empty array still means
 * "asked, nothing to report".
 */
export async function getActiveTranscodingReasons(
  _itemId: string,
  playSessionId?: string,
): Promise<string[] | null> {
  if (!playSessionId) return [];
  try {
    const session = await ownApiClient.request<{ reasonCodes: string[] }>(
      `/playback/sessions/${encodeURIComponent(playSessionId)}`,
    );
    return session.reasonCodes;
  } catch (error) {
    if (error instanceof OwnApiClientError && error.status === 404) {
      return null;
    }
    return [];
  }
}

// -------------------------------------------------------------- trickplay

export interface TrickplayInfo {
  setId: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  intervalMs: number;
  thumbnailCount: number;
  spriteCount: number;
}

export async function getTrickplayInfo(
  itemId: string,
): Promise<TrickplayInfo | null> {
  try {
    return await ownApiClient.request<TrickplayInfo>(
      `/items/${encodeURIComponent(itemId)}/trickplay`,
    );
  } catch {
    return null;
  }
}

export function getTrickplayImageUrl(
  setId: string,
  spriteIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/trickplay/${encodeURIComponent(setId)}/sprites/${spriteIndex}`,
  );
}

/**
 * Sprite URL addressed by item rather than by set. The seek bar knows an item,
 * and this URL stays valid when sheets are regenerated under a new set id.
 */
export function getItemTrickplayImageUrl(
  itemId: string,
  spriteIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/items/${encodeURIComponent(itemId)}/trickplay/sprites/${spriteIndex}`,
  );
}

// ------------------------------------------------------------------ admin

export async function getUsers(): Promise<MediaUser[]> {
  const users = await ownApiClient.request<
    Array<{
      id: string;
      username: string;
      displayName: string;
      isAdministrator: boolean;
      isDisabled: boolean;
      lastLoginAt: string | null;
      maxContentAge?: number | null;
      allowUnratedContent?: boolean;
      allowPlayback?: boolean;
      allowDownloads?: boolean;
      allowAllLibraries?: boolean;
    }>
  >("/admin/users");

  return users.map((user) => ({
    Id: user.id,
    Name: user.displayName,
    HasPassword: true,
    ...(user.lastLoginAt ? { LastLoginDate: user.lastLoginAt } : {}),
    Policy: {
      IsAdministrator: user.isAdministrator,
      IsDisabled: user.isDisabled,
      // Read back so an edit starts from what is stored. Without these the
      // form fell back to "on" for all three and saving any user granted
      // downloads nobody had chosen.
      ...(user.allowPlayback === undefined
        ? {}
        : { EnableMediaPlayback: user.allowPlayback }),
      ...(user.allowDownloads === undefined
        ? {}
        : { EnableContentDownloading: user.allowDownloads }),
      ...(user.allowAllLibraries === undefined
        ? {}
        : { EnableAllFolders: user.allowAllLibraries }),
      MaxContentAge: user.maxContentAge ?? null,
      AllowUnratedContent: user.allowUnratedContent ?? false,
    },
  }));
}

export async function getUserById(userId: string): Promise<MediaUser> {
  const users = await getUsers();
  const user = users.find((candidate) => candidate.Id === userId);
  if (!user) throw new Error("The requested user could not be found.");
  return user;
}

export async function createUser(
  name: string,
  password: string,
): Promise<MediaUser> {
  const created = await ownApiClient.request<{
    id: string;
    displayName: string;
  }>("/admin/users", {
    method: "POST",
    body: { username: name, password, displayName: name },
  });

  return { Id: created.id, Name: created.displayName, HasPassword: true };
}

export async function updateUser(user: MediaUser): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/users/${encodeURIComponent(user.Id)}`,
    { method: "PATCH", body: { displayName: user.Name } },
  );
}

export async function updateUserPolicy(
  userId: string,
  policy: MediaUserPolicy,
): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      body: {
        ...(policy.IsAdministrator === undefined
          ? {}
          : { isAdministrator: policy.IsAdministrator }),
        ...(policy.IsDisabled === undefined
          ? {}
          : { isDisabled: policy.IsDisabled }),
        ...(policy.EnableMediaPlayback === undefined
          ? {}
          : { allowPlayback: policy.EnableMediaPlayback }),
        ...(policy.EnableContentDownloading === undefined
          ? {}
          : { allowDownloads: policy.EnableContentDownloading }),
        ...(policy.EnableAllFolders === undefined
          ? {}
          : { allowAllLibraries: policy.EnableAllFolders }),
        ...(policy.MaxContentAge === undefined
          ? {}
          : { maxContentAge: policy.MaxContentAge }),
        ...(policy.AllowUnratedContent === undefined
          ? {}
          : { allowUnratedContent: policy.AllowUnratedContent }),
      },
    },
  );
}

export async function updateUserPassword(
  userId: string,
  options: { newPassword: string; resetPassword?: boolean },
): Promise<void> {
  await ownApiClient.request<void>(
    `/admin/users/${encodeURIComponent(userId)}/password`,
    { method: "PUT", body: { password: options.newPassword } },
  );
}

export async function deleteUser(userId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

/**
 * The Library Maintenance action group.
 *
 * Every one of these returns as soon as the durable jobs exist — the browser
 * never waits for a scan, an FFmpeg run or a filesystem move — so the reply
 * carries what was accepted, not what was completed.
 */
export type MaintenanceAction =
  | "all"
  | "scan-movies"
  | "scan-shows"
  | "scan-books"
  | "trickplay"
  | "segments"
  | "enrich"
  | "rename"
  | "organize";

export interface MaintenanceAcceptance {
  action: MaintenanceAction;
  taskIds: string[];
  /** Libraries the action applied to; zero is a successful no-op. */
  libraries: number;
}

export async function runLibraryMaintenance(
  action: MaintenanceAction,
): Promise<MaintenanceAcceptance> {
  return ownApiClient.request<MaintenanceAcceptance>(
    `/admin/maintenance/${encodeURIComponent(action)}`,
    { method: "POST", body: {} },
  );
}

export async function scanLibrary(libraryId: string): Promise<string> {
  const task = await ownApiClient.request<{ taskId: string }>(
    `/admin/libraries/${encodeURIComponent(libraryId)}/scan`,
    { method: "POST", body: {} },
  );
  return task.taskId;
}

export async function refreshItemMetadata(
  itemId: string,
  _options: MetadataRefreshOptions = {},
): Promise<void> {
  await ownApiClient.request<{ taskId: string }>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata/refresh`,
    { method: "POST", body: {} },
  );
}

export interface TaskObservation {
  tasks: TaskDto[];
  observedAt: string;
}

/** Read every bounded page before committing a successful observation. */
export async function getTaskObservation(
  since?: string,
): Promise<TaskObservation> {
  const tasks = new Map<string, TaskDto>();
  let after: string | null = null;
  let observedAt: string | undefined;
  do {
    const query = new URLSearchParams({ observe: "true", limit: "200" });
    if (since) query.set("since", since);
    if (after) query.set("after", after);
    const page: TaskObservation & { next: string | null } =
      await ownApiClient.request(`/admin/tasks?${query}`, {
        background: true,
      });
    observedAt ??= page.observedAt;
    for (const task of page.tasks) tasks.set(task.id, task);
    if (page.next !== null && after !== null && page.next <= after) {
      throw new Error("Task observation cursor did not advance.");
    }
    after = page.next;
  } while (after !== null);
  return { tasks: [...tasks.values()], observedAt: observedAt! };
}

export async function getTasks(): Promise<TaskDto[]> {
  return ownApiClient.request<TaskDto[]>("/admin/tasks");
}

/*
 * Hand-placed ordering for the home shelves and the library grids.
 *
 * Server-side and shared: the order is a property of the house's library, not
 * of the browser looking at it, so it has to survive a cleared cache and be the
 * same on the television as on the phone.
 */
function curationPath(surface: CuratedSurface, libraryId?: string): string {
  const path = `/curation/${encodeURIComponent(surface)}`;
  return libraryId
    ? `${path}?libraryId=${encodeURIComponent(libraryId)}`
    : path;
}

export async function getCuratedList(
  surface: CuratedSurface,
  libraryId?: string,
): Promise<CuratedList> {
  return ownApiClient.request<CuratedList>(curationPath(surface, libraryId));
}

export async function saveCuratedList(
  surface: CuratedSurface,
  entries: CuratedEntry[],
  libraryId?: string,
): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/curation/${encodeURIComponent(surface)}`,
    {
      method: "PUT",
      body: { ...(libraryId ? { libraryId } : {}), entries },
    },
  );
}

export async function clearCuratedList(
  surface: CuratedSurface,
  libraryId?: string,
): Promise<void> {
  const query = libraryId ? `?libraryId=${encodeURIComponent(libraryId)}` : "";
  await ownApiClient.request<void>(
    `/admin/curation/${encodeURIComponent(surface)}${query}`,
    { method: "DELETE" },
  );
}
