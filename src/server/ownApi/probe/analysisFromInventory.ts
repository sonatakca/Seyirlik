import type {
  AudioStreamAnalysis,
  MediaAnalysis,
  SubtitleStreamAnalysis,
  VideoStreamAnalysis,
} from "../../../lib/playback-planner/types";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";

/**
 * Rebuilds the planner's `MediaAnalysis` from the stored inventory.
 *
 * This is the payoff of persisting probe results: starting playback becomes a
 * database read instead of an ffprobe process, so the decision is available
 * before the user has finished clicking.
 */

/**
 * Containers a browser can play from a plain URL. Matroska and the transport
 * containers are excluded even though the codecs inside them are often fine —
 * the container itself is what the browser cannot demux.
 */
const BROWSER_DIRECT_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm"]);

const IMAGE_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "dvd_subtitle",
  "dvdsub",
  "dvb_subtitle",
  "xsub",
]);

export interface InventoryAnalysisInput {
  file: MediaFileRow;
  streams: MediaStreamRow[];
  /** Absolute path; required by FFmpeg but never included in any response. */
  filePath: string;
  chapters?: Array<{ index: number; startMs: string; name: string | null }>;
}

function toVideo(stream: MediaStreamRow): VideoStreamAnalysis {
  return {
    index: stream.streamIndex,
    codecName: stream.codec ?? "",
    ...(stream.profile === null ? {} : { profile: stream.profile }),
    ...(stream.level === null ? {} : { level: stream.level }),
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    ...(stream.frameRate === null ? {} : { framerate: stream.frameRate }),
    ...(stream.bitrateBps === null
      ? {}
      : { bitrate: Number(stream.bitrateBps) }),
    ...(stream.pixelFormat === null ? {} : { pixFmt: stream.pixelFormat }),
    ...(stream.bitDepth === null ? {} : { bitDepth: stream.bitDepth }),
    ...(stream.colorSpace === null ? {} : { colorSpace: stream.colorSpace }),
    ...(stream.colorTransfer === null
      ? {}
      : { colorTransfer: stream.colorTransfer }),
    ...(stream.colorPrimaries === null
      ? {}
      : { colorPrimaries: stream.colorPrimaries }),
    isHdr: stream.videoRange === "HDR" || stream.videoRange === "DOVI",
    hasDolbyVision: stream.videoRange === "DOVI",
  };
}

function toAudio(stream: MediaStreamRow): AudioStreamAnalysis {
  return {
    index: stream.streamIndex,
    codecName: stream.codec ?? "",
    ...(stream.channels === null ? {} : { channels: stream.channels }),
    ...(stream.sampleRate === null ? {} : { sampleRate: stream.sampleRate }),
    ...(stream.bitrateBps === null
      ? {}
      : { bitrate: Number(stream.bitrateBps) }),
    ...(stream.language === null ? {} : { language: stream.language }),
    ...(stream.title === null ? {} : { title: stream.title }),
    isDefault: stream.isDefault,
  };
}

function toSubtitle(stream: MediaStreamRow): SubtitleStreamAnalysis {
  const codecName = stream.codec ?? "";
  return {
    index: stream.streamIndex,
    ...(stream.isExternal ? { isExternal: true } : {}),
    codecName,
    ...(stream.language === null ? {} : { language: stream.language }),
    ...(stream.title === null ? {} : { title: stream.title }),
    isDefault: stream.isDefault,
    isForced: stream.isForced,
    // Trust the stored flag, falling back to the codec when an older row
    // predates the flag.
    isImageBased: stream.isTextSubtitle
      ? false
      : IMAGE_SUBTITLE_CODECS.has(codecName.toLowerCase()),
  };
}

export function buildAnalysisFromInventory({
  file,
  streams,
  filePath,
  chapters = [],
}: InventoryAnalysisInput): MediaAnalysis {
  const container = (file.container ?? "").toLowerCase();
  const durationSeconds =
    file.durationMs === null ? 0 : Number(file.durationMs) / 1_000;

  return {
    mediaId: file.id,
    filePath,
    container: {
      formatName: container,
      ...(container ? { extension: container } : {}),
      isBrowserDirectPlayableContainer:
        BROWSER_DIRECT_CONTAINERS.has(container),
    },
    durationSeconds,
    ...(file.bitrateBps === null
      ? {}
      : { overallBitrate: Number(file.bitrateBps) }),
    videoStreams: streams
      .filter((stream) => stream.kind === "video")
      .map(toVideo),
    audioStreams: streams
      .filter((stream) => stream.kind === "audio")
      .map(toAudio),
    subtitleStreams: streams
      .filter((stream) => stream.kind === "subtitle")
      .map(toSubtitle),
    ...(chapters.length === 0
      ? {}
      : {
          chapters: chapters.map((chapter, index) => {
            const startSeconds = Number(chapter.startMs) / 1_000;
            const next = chapters[index + 1];
            return {
              id: chapter.index,
              startSeconds,
              endSeconds: next
                ? Number(next.startMs) / 1_000
                : durationSeconds || startSeconds,
              ...(chapter.name === null ? {} : { title: chapter.name }),
            };
          }),
        }),
    analysedAt: new Date().toISOString(),
  };
}
