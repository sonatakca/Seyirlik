import type { MediaQualityManifest } from "../../renditions/contracts";

/**
 * Native API response shapes.
 *
 * These mirror the server's DTOs exactly. They are intentionally separate from
 * the view models the components consume: the wire format is Seyirlik's own
 * contract and is allowed to change independently of the UI, with
 * `adapters.ts` as the single place that bridges the two.
 */

export type ItemKind =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "book"
  | "collection"
  | "trailer";

export interface ImageRefDto {
  id: string;
  tag: string;
  width?: number;
  height?: number;
}

export interface ItemImagesDto {
  cover?: ImageRefDto;
  logo?: ImageRefDto;
  thumb?: ImageRefDto;
  banner?: ImageRefDto;
  backdrops: ImageRefDto[];
  parentCover?: ImageRefDto;
  parentBackdrops?: ImageRefDto[];
  parentLogo?: ImageRefDto;
}

export interface UserItemStateDto {
  positionMs: number;
  played: boolean;
  playCount: number;
  isFavourite: boolean;
  lastPlayedAt?: string;
  playedPercentage?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
}

export interface ItemDto {
  id: string;
  kind: ItemKind;
  libraryId: string;
  title: string;
  sortTitle: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  productionYear?: number;
  premiereDate?: string;
  officialRating?: string;
  communityRating?: number;
  runtimeMs?: number;
  indexNumber?: number;
  parentIndexNumber?: number;
  endIndexNumber?: number;
  parentId?: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonId?: string;
  seasonTitle?: string;
  genres: string[];
  providerIds: Record<string, string>;
  childCount?: number;
  recursiveItemCount?: number;
  dateCreated: string;
  isMissing: boolean;
  /** Fine logo placement on the card, or null when never adjusted. */
  logoLayout: { x: number; y: number; width: number; shadow: number } | null;
  seriesLogoLayout?: { x: number; y: number; width: number; shadow: number };
  images: ItemImagesDto;
  userState?: UserItemStateDto;
}

export interface LibraryDto {
  id: string;
  slug: string;
  name: string;
  kind: string;
  sortOrder: number;
  itemCount: number;
}

export interface MediaStreamDto {
  index: number;
  kind: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec: string | null;
  profile: string | null;
  level: number | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  isExternal: boolean;
  isTextSubtitle: boolean;
  channels: number | null;
  sampleRate: number | null;
  bitrateBps: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoRange: string | null;
  bitDepth: number | null;
}

export interface MediaSourceDto {
  id: string;
  container: string | null;
  sizeBytes: number;
  durationMs: number | null;
  bitrateBps: number | null;
  isPrimary: boolean;
  probeState: "pending" | "probed" | "failed" | "packaged";
  streams: MediaStreamDto[];
}

export interface ItemStreamsDto {
  sources: MediaSourceDto[];
}

export interface ItemPersonDto {
  id: string;
  name: string;
  role: "actor" | "director" | "writer" | "producer" | "composer" | "guest";
  character?: string;
  /** A TMDB headshot, when TMDB has one. */
  imageUrl?: string;
}

export interface ChapterDto {
  index: number;
  startMs: number;
  name: string | null;
}

export interface SegmentDto {
  id: string;
  type: string;
  startMs: number;
  endMs: number;
}

export type PlaybackMode =
  | "DIRECT_PLAY"
  | "REMUX"
  | "DIRECT_STREAM"
  | "TRANSCODE";

export interface PlaybackPlanDto {
  mode: PlaybackMode;
  reasonCodes: string[];
  reasons: Array<{ code?: string; message?: string } | string>;
  requiresTranscode: boolean;
  preservesOriginalVideoQuality: boolean;
  expectedStartup: "instant" | "fast" | "slow";
  container: { input: string; output: string; action: string };
  video: {
    inputCodec: string;
    outputCodec?: string;
    action: string;
    reason?: string;
  };
  audio: {
    inputCodec?: string;
    outputCodec?: string;
    action: string;
    reason?: string;
  };
  subtitles: { inputCodec?: string; action: string; reason?: string };
  selected: {
    videoStreamIndex: number;
    audioStreamIndex?: number;
    subtitleStreamIndex?: number;
  };
}

export interface PlaybackSessionDto {
  sessionId: string;
  itemId: string;
  mediaFileId: string;
  plan: PlaybackPlanDto;
  delivery: { type: "file" | "hls"; url: string };
  /** Absent when the offline processor has produced nothing for this file. */
  qualityManifest?: MediaQualityManifest;
}

export interface HomeDto {
  libraries: Array<{
    id: string;
    name: string;
    kind: string;
    itemCount: number;
  }>;
  continueWatching: ItemDto[];
  nextUp: ItemDto[];
  latestByLibrary: Array<{ id: string; title: string; items: ItemDto[] }>;
}

export interface TaskDto {
  presentation?: import("../../lib/notifications/taskPresentation").TaskPresentation;
  /** Queue fraction, 0..1. Convert to a UI percentage only in describeTask. */
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  progressMessage: string | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  result: Record<string, unknown> | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
