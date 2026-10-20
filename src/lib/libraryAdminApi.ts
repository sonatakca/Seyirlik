/**
 * The administrator's library: every movie and show, including the ones with
 * nothing to play yet. Browse pages never see a title without a source; this
 * is where those are managed.
 */
import { OwnApiClientError, ownApiClient } from "../api/ownApi/client";

export type LibraryTitleKind = "movie" | "series" | "book";

export interface HoldingFacts {
  status: string;
  hasMedia: boolean;
  downloading: number;
  importing: number;
  processing: number;
  sizeBytes: number;
  resolution: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  pendingSubtitles: string[];
  files: number;
  trickplayFiles: number;
  /** Playable titles whose trickplay is queued or being generated. */
  pendingTrickplay: number;
}

export interface LibraryTitle extends HoldingFacts {
  id: string;
  kind: LibraryTitleKind;
  title: string;
  year: number | null;
  desired: boolean;
  tmdbId: string | null;
  imdbId: string | null;
  episodeCount: number;
  availableEpisodeCount: number;
  artwork: TitleArtwork;
}

export interface TitleArtwork {
  coverTag: string | null;
  logoTag: string | null;
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  /** No cover, or its file is gone; TMDB can fill it in. */
  missing: boolean;
}

export interface LibraryEpisode extends HoldingFacts {
  id: string | null;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: string | null;
  mediaFileId: string | null;
  fileName: string | null;
  monitored: boolean;
  hasThumb: boolean;
  stillUrl: string | null;
}

export interface LibraryTitleDetail extends LibraryTitle {
  mediaFileId: string | null;
  fileName: string | null;
  seasons: Array<{
    id: string | null;
    seasonNumber: number;
    episodes: LibraryEpisode[];
  }>;
  catalogueComplete: boolean;
}

export interface TitleRemovalReport {
  itemId: string;
  title: string;
  folder: string | null;
  /**
   * `removing` until the catalogue lets go, `deleting` while the files go,
   * `done`; `failed` stopped before anything was deleted.
   */
  state: "removing" | "deleting" | "done" | "failed";
  failure?: "not-found" | "confirmation" | "busy" | "unsafe" | "error";
  filesRemoved: number;
  downloadsCancelled: number;
  leftovers: string[];
}

export async function listLibraryTitles(
  kind: LibraryTitleKind,
  { background = false } = {},
): Promise<LibraryTitle[]> {
  const { items } = await ownApiClient.request<{ items: LibraryTitle[] }>(
    `/library/titles?${new URLSearchParams({ kind })}`,
    background ? { background } : undefined,
  );
  return items;
}

export function getLibraryTitle(
  itemId: string,
  { background = false } = {},
): Promise<LibraryTitleDetail> {
  return ownApiClient.request<LibraryTitleDetail>(
    `/library/titles/${encodeURIComponent(itemId)}`,
    background ? { background } : undefined,
  );
}

/** Irreversible. The server refuses unless `confirmTitle` repeats the title exactly. */
export function removeLibraryTitle(
  itemId: string,
  confirmTitle: string,
): Promise<TitleRemovalReport> {
  return ownApiClient.request<TitleRemovalReport>(
    `/library/titles/${encodeURIComponent(itemId)}/remove`,
    { method: "POST", body: { confirmTitle } },
  );
}

/** A removal's file deletion; null once the server no longer knows of it. */
export async function getTitleRemoval(
  itemId: string,
): Promise<TitleRemovalReport | null> {
  try {
    return await ownApiClient.request<TitleRemovalReport>(
      `/library/removals/${encodeURIComponent(itemId)}`,
      { background: true },
    );
  } catch (error) {
    if (error instanceof OwnApiClientError && error.status === 404) return null;
    throw error;
  }
}

/** Looks for subtitles for a film, or for every episode file of a show or season. */
export function requestTitleSubtitles(
  itemId: string,
  language: string,
): Promise<{ files: number; queued: number }> {
  return ownApiClient.request(
    `/subtitles/items/${encodeURIComponent(itemId)}`,
    {
      method: "POST",
      body: { language },
    },
  );
}

/** Four megabytes, matching the ceiling the server writes subtitles under. */
/** What the server accepts; Cloudflare refuses a larger body before it arrives. */
export const MAX_BOOK_UPLOAD_BYTES = 95 * 1024 * 1024;

export interface BookUploadReport {
  outcome: "added" | "duplicate";
  relativePath: string;
  title: string | null;
  author: string | null;
}

/**
 * Hands an EPUB from this computer to the server's Books library.
 *
 * The name is sent only as a fallback title; where the book lands is decided
 * on the server from the book's own metadata. It becomes a title once the scan
 * the upload queues has read the library.
 */
export function uploadBook(file: File): Promise<BookUploadReport> {
  if (!/\.epub$/i.test(file.name)) {
    throw new Error("Only EPUB files can be added as books.");
  }
  if (file.size === 0 || file.size > MAX_BOOK_UPLOAD_BYTES) {
    throw new Error("Upload an EPUB no larger than 95 MB.");
  }
  const query = new URLSearchParams({ name: file.name });
  return ownApiClient.request<BookUploadReport>(
    `/library/books/upload?${query}`,
    { method: "POST", binaryBody: file },
  );
}

export const MAX_SUBTITLE_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface SubtitleUploadReport {
  outcome: "installed" | "duplicate";
  relativePath: string;
  /** What the file was renamed to, which is the part worth showing. */
  fileName: string;
  language: string;
  cueCount: number | null;
  /** Whether the player can offer it now, or only after the next scan. */
  attached: boolean;
}

/**
 * Hands over a subtitle file for one film or one episode.
 *
 * The file's own name is deliberately not sent. Where it lands and what it is
 * called are derived on the server from the media file the item resolves to,
 * so a subtitle named `[YTS] dune.2021.tr.srt` still arrives as
 * `Dune (2021).tur.srt` beside the film.
 */
export function uploadTitleSubtitle(
  itemId: string,
  file: File,
  policy: { language: "tur" | "eng"; forced?: boolean; replace?: boolean },
): Promise<SubtitleUploadReport> {
  if (file.size === 0 || file.size > MAX_SUBTITLE_UPLOAD_BYTES) {
    throw new Error("Upload a subtitle file no larger than 4 MiB.");
  }
  const query = new URLSearchParams({ language: policy.language });
  if (policy.forced) query.set("forced", "true");
  if (policy.replace) query.set("replace", "true");
  return ownApiClient.request<SubtitleUploadReport>(
    `/subtitles/items/${encodeURIComponent(itemId)}/upload?${query}`,
    { method: "POST", binaryBody: file },
  );
}

export interface SubtitleSyncTrack {
  streamIndex: number;
  language: string | null;
  title: string | null;
  forced: boolean;
  external: boolean;
  fileName: string | null;
  /** A subtitle inside the video can be timed *against*, never re-timed. */
  retimable: boolean;
}

export interface SubtitleSyncAudioTrack {
  streamIndex: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  isDefault: boolean;
}

export interface SubtitleSyncTracks {
  mediaFileId: string;
  subtitles: SubtitleSyncTrack[];
  audio: SubtitleSyncAudioTrack[];
}

/** Which subtitle of one film can be corrected, and what it can be timed against. */
export function getSubtitleSyncTracks(
  itemId: string,
): Promise<SubtitleSyncTracks> {
  return ownApiClient.request<SubtitleSyncTracks>(
    `/subtitles/items/${encodeURIComponent(itemId)}/sync`,
  );
}

/**
 * Moves one subtitle onto the film's timeline.
 *
 * Queued rather than awaited. Reading a film's audio is minutes of work on the
 * media volume, so the answer — how far it moved, how sure the server was, and
 * whether it wrote anything — arrives on the task card rather than here.
 */
export function syncTitleSubtitle(
  itemId: string,
  request: {
    targetStreamIndex: number;
    reference: { kind: "subtitle" | "audio"; streamIndex: number };
    /** Apply exactly this instead of working one out. */
    offsetSeconds?: number;
    rate?: number;
    /** Report the correction without writing it. */
    dryRun?: boolean;
  },
): Promise<{ taskId: string }> {
  return ownApiClient.request(
    `/subtitles/items/${encodeURIComponent(itemId)}/sync`,
    { method: "POST", body: request },
  );
}

/** What a finished sync did, or why it did nothing. */
export type SubtitleSyncOutcome =
  | {
      outcome: "applied" | "analysed" | "unchanged";
      fileName: string;
      referenceKind: "subtitle" | "audio";
      referenceLabel: string;
      offsetSeconds: number;
      rate: number;
      /** How far above chance the alignment stands, 0 to 1. */
      confidence: number;
      matchedCues: number;
      consideredCues: number;
      cueCount: number;
      droppedCues: number;
      clampedCues: number;
    }
  | { outcome: "refused"; failure: string; reason: string };

export interface SubtitleSyncTask {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** What a running sync is doing now, in a sentence. */
  message: string | null;
  result: SubtitleSyncOutcome | null;
}

export function getSubtitleSyncTask(
  itemId: string,
  taskId: string,
): Promise<SubtitleSyncTask> {
  return ownApiClient.request<SubtitleSyncTask>(
    `/subtitles/items/${encodeURIComponent(itemId)}/sync/${encodeURIComponent(taskId)}`,
    { background: true },
  );
}

/** Fetches TMDB artwork for every matched title whose cover is missing. */
export function importMissingArtwork(): Promise<{ queued: number }> {
  return ownApiClient.request("/library/titles/artwork", {
    method: "POST",
    body: {},
  });
}

/**
 * Trickplay for a film, an episode, a season or a whole show. Without `force`
 * only what has no sheets yet is generated.
 */
export function generateTrickplay(
  itemId: string,
  force = false,
): Promise<{ queued: number; alreadyGenerated: number; notReady: number }> {
  return ownApiClient.request(
    `/admin/items/${encodeURIComponent(itemId)}/trickplay`,
    { method: "POST", body: { force } },
  );
}

/**
 * The colour a title is shown in.
 *
 * Green when there is something to play, purple while a download or import is
 * moving, red when it is wanted and absent, grey when nobody asked for it.
 */
export type HoldingTone =
  | "held"
  | "downloading"
  | "wanted"
  | "absent"
  | "unaired";

export function toneOf(
  facts: Pick<
    HoldingFacts,
    "hasMedia" | "downloading" | "importing" | "status"
  >,
  wanted: boolean,
): HoldingTone {
  if (facts.hasMedia) return "held";
  if (facts.downloading > 0 || facts.importing > 0) return "downloading";
  if (facts.status === "unaired") return "unaired";
  return wanted ? "wanted" : "absent";
}

/**
 * How far an episode has come, for the season strip.
 *
 * The file walks one way: absent, downloading, held, processed. Turkish
 * subtitles and trickplay only exist once there is a file, and arrive in
 * either order, so they are reported apart rather than as further steps.
 */
export interface EpisodeStage {
  /** The file's own step; `tone` while there is no file to speak of. */
  file:
    | { tone: HoldingTone }
    | { held: "unprocessed" | "processing" | "processed" };
  turkish: "found" | "searching" | "none";
  trickplay: "found" | "queued" | "none";
  /** Processed, with Turkish subtitles and trickplay: nothing left to do. */
  complete: boolean;
}

export function episodeStage(
  episode: Pick<
    HoldingFacts,
    | "hasMedia"
    | "downloading"
    | "importing"
    | "processing"
    | "status"
    | "subtitleLanguages"
    | "pendingSubtitles"
    | "trickplayFiles"
    | "pendingTrickplay"
  >,
  wanted: boolean,
): EpisodeStage {
  if (!episode.hasMedia) {
    return {
      file: { tone: toneOf(episode, wanted) },
      turkish: "none",
      trickplay: "none",
      complete: false,
    };
  }
  const held =
    episode.status === "ready"
      ? "processed"
      : episode.processing > 0 ||
          episode.status === "processing" ||
          episode.status === "paused"
        ? "processing"
        : "unprocessed";
  const turkish = episode.subtitleLanguages.includes("tur")
    ? "found"
    : episode.pendingSubtitles.includes("tur")
      ? "searching"
      : "none";
  const trickplay =
    episode.trickplayFiles > 0
      ? "found"
      : episode.pendingTrickplay > 0
        ? "queued"
        : "none";
  return {
    file: { held },
    turkish,
    trickplay,
    complete:
      held === "processed" && turkish === "found" && trickplay === "found",
  };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** power;
  return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/**
 * An episode the season strip draws red: aired, not held, and neither
 * downloading nor importing. The server plans its search by the same rule.
 */
export function isMissingEpisode(
  episode: Pick<
    LibraryEpisode,
    | "seasonNumber"
    | "episodeNumber"
    | "hasMedia"
    | "downloading"
    | "importing"
    | "status"
  >,
): boolean {
  return (
    episode.seasonNumber > 0 &&
    episode.episodeNumber > 0 &&
    !episode.hasMedia &&
    episode.downloading === 0 &&
    episode.importing === 0 &&
    episode.status !== "unaired"
  );
}

export interface MissingSearch {
  /** Null when nothing was missing, so nothing was queued. */
  taskId: string | null;
  episodes: number;
}

export interface MissingSearchState {
  status: string;
  message: string | null;
  result: {
    /** A null episode is a season pack. */
    started: Array<{ season: number; episode: number | null; release: string }>;
    nothing: Array<{ season: number; episode: number }>;
  } | null;
}

/** Searches for a series' missing episodes, or one season's, and starts the best of each. */
export function searchMissingEpisodes(itemId: string, season?: number) {
  return ownApiClient.request<MissingSearch>("/acquisitions/missing", {
    method: "POST",
    body: { itemId, ...(season === undefined ? {} : { season }) },
  });
}

export function getMissingSearch(taskId: string) {
  return ownApiClient.request<MissingSearchState>(
    `/acquisitions/missing/${encodeURIComponent(taskId)}`,
    { background: true },
  );
}
