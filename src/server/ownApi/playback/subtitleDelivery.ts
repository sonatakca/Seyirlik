import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import type {
  MediaFileRow,
  MediaStreamRow,
} from "../catalogue/catalogueRepository";
import type { PackagedSubtitle } from "../../renditionService";
import { collectFfmpegOutput } from "./ffmpegOutput";

const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024;
const SUBTITLE_EXTRACTION_TIMEOUT_MS = 60_000;

export function buildSubtitleExtractionArgs(
  inputPath: string,
  streamIndex: number,
): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    "pipe:1",
  ];
}

/** Extracts one text subtitle without ever exposing its filesystem path. */
export function extractSubtitleAsWebVtt(
  inputPath: string,
  streamIndex: number,
  ffmpegPath = "ffmpeg",
): Promise<Buffer> {
  return collectFfmpegOutput(
    ffmpegPath,
    buildSubtitleExtractionArgs(inputPath, streamIndex),
    {
      label: "Subtitle extraction",
      maxBytes: MAX_SUBTITLE_BYTES,
      timeoutMs: SUBTITLE_EXTRACTION_TIMEOUT_MS,
    },
  );
}

/**
 * Where one text subtitle of `file` is read from: the file itself, or the
 * sidecar the stream came from. Null when the index names no text subtitle of
 * that file, or when its path would leave the media root.
 */
export function resolveTextSubtitleInput(
  file: Pick<MediaFileRow, "relativePath">,
  streams: readonly MediaStreamRow[],
  streamIndex: number,
  mediaRoot: string,
): { inputPath: string; inputStreamIndex: number } | null {
  const stream = streams.find(
    (candidate) =>
      candidate.kind === "subtitle" &&
      candidate.streamIndex === streamIndex &&
      candidate.isTextSubtitle,
  );
  if (!stream) return null;
  const relativeInputPath = stream.isExternal
    ? stream.externalRelativePath
    : file.relativePath;
  if (!relativeInputPath) return null;
  const inputPath = path.resolve(mediaRoot, ...relativeInputPath.split("/"));
  if (!isPathInsideRoot(mediaRoot, inputPath)) return null;
  return {
    inputPath,
    inputStreamIndex: stream.isExternal ? 0 : stream.streamIndex,
  };
}

/**
 * A file's streams with the subtitles its package carries and the catalogue
 * does not.
 *
 * The catalogue only knows what is in the source file and beside it now. A
 * package keeps what was there when it was built: every track of a title whose
 * source has since been removed, and a subtitle installed later and packaged
 * from a sidecar the catalogue never recorded. Those were playable bytes no
 * picker ever offered. A package track is added only where the catalogue has
 * no stream at that index, so nothing it already describes is renamed.
 */
export function withPackagedSubtitles(
  streams: readonly MediaStreamRow[],
  packaged: readonly PackagedSubtitle[],
): MediaStreamRow[] {
  const taken = new Set(streams.map((stream) => stream.streamIndex));
  return [
    ...streams,
    ...packaged
      .filter((subtitle) => !taken.has(subtitle.streamIndex))
      .map(
        (subtitle): MediaStreamRow => ({
          streamIndex: subtitle.streamIndex,
          kind: "subtitle",
          codec: "webvtt",
          profile: null,
          level: null,
          language: subtitle.language ?? null,
          title: subtitle.title ?? null,
          isDefault: subtitle.isDefault,
          isForced: subtitle.isForced,
          isExternal: false,
          isTextSubtitle: true,
          externalRelativePath: null,
          channels: null,
          sampleRate: null,
          bitrateBps: null,
          width: null,
          height: null,
          pixelFormat: null,
          frameRate: null,
          videoRange: null,
          colorTransfer: null,
          colorPrimaries: null,
          colorSpace: null,
          bitDepth: null,
        }),
      ),
  ];
}

/**
 * The package's converted copy of one subtitle track, when it is that track.
 *
 * Preferred over extracting from the source, which reads the whole file and
 * for a large film outlasts every limit in front of it. Taken only when the
 * catalogue has nothing else at that index, or a subtitle in the same language
 * — a later sidecar could have been given an index a removed one used to have.
 */
export function packagedSubtitleFor(
  streams: readonly MediaStreamRow[],
  packaged: readonly PackagedSubtitle[],
  streamIndex: number,
): PackagedSubtitle | null {
  const subtitle = packaged.find(
    (candidate) => candidate.streamIndex === streamIndex,
  );
  if (!subtitle) return null;
  const catalogued = streams.find(
    (stream) => stream.streamIndex === streamIndex,
  );
  if (!catalogued) return subtitle;
  if (catalogued.kind !== "subtitle" || catalogued.isExternal) return null;
  return !catalogued.language ||
    !subtitle.language ||
    catalogued.language === subtitle.language
    ? subtitle
    : null;
}
