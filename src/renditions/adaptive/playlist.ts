/**
 * Media-playlist parsing and master-playlist generation.
 *
 * The parser exists because two very different consumers need to agree about
 * what a packaged playlist claims: the validator, which checks those claims
 * against the bytes on disk, and the delivery route, which must never serve a
 * range the playlist did not describe. A single parser means a playlist cannot
 * be read permissively in one place and strictly in the other.
 *
 * The master generator exists because FFmpeg's own master is close but not
 * sufficient — it has no `FRAME-RATE`, no `VIDEO-RANGE`, and its `BANDWIDTH`
 * figures come from encoder hints rather than the bytes that were actually
 * written. The `CODECS` strings are the one thing it derives from the real
 * bitstream, so those are carried across verbatim.
 */

import { ADAPTIVE_AUDIO_GROUP } from "./encoding";
import type {
  AdaptiveAudioRenditionMetadata,
  AdaptiveSubtitleRenditionMetadata,
  AdaptiveVideoRenditionMetadata,
} from "./metadata";

export const ADAPTIVE_SUBTITLE_GROUP = "seyirlik-subtitles";

export interface PlaylistByteRange {
  length: number;
  offset: number;
}

export interface PlaylistSegment {
  durationSeconds: number;
  uri: string;
  byteRange: PlaylistByteRange;
}

export interface ParsedMediaPlaylist {
  version: number;
  targetDuration: number;
  independentSegments: boolean;
  playlistType?: string;
  map: { uri: string; byteRange: PlaylistByteRange };
  segments: PlaylistSegment[];
  hasEndList: boolean;
  totalDurationSeconds: number;
}

function parseByteRange(
  value: string,
  previousEnd: number,
): PlaylistByteRange | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] === undefined ? previousEnd : Number(match[2]);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return null;
  }
  return { length, offset };
}

/**
 * Parses a VOD media playlist.
 *
 * Rejects anything it does not fully understand rather than skipping it. A tag
 * this does not know about in a packaged playlist means the packager and the
 * reader disagree about the format, and continuing would validate a package
 * whose real structure nothing has inspected.
 */
/**
 * Names that are unique inside one EXT-X-MEDIA group.
 *
 * RFC 8216 §4.3.4.1 requires every rendition in a group to carry a different
 * NAME. A title with three English subtitle tracks — a plain one, an alternate
 * and a forced one — has nothing but the language to name them by, so all three
 * came out as "eng" and the group violated the spec. macOS Safari plays such a
 * master regardless; a stricter client is entitled not to, and gives no reason
 * when it declines.
 *
 * Only collisions are touched, so a title whose tracks were already
 * distinguishable keeps the names it had.
 */
export function uniqueRenditionNames(names: readonly string[]): string[] {
  const taken = new Set<string>();

  return names.map((name) => {
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }

    // The suffix stays outside the first word so that language matching, which
    // reads the leading token, still recognises "eng 2" as English.
    let ordinal = 2;
    let candidate = `${name} ${ordinal}`;
    while (taken.has(candidate)) {
      ordinal += 1;
      candidate = `${name} ${ordinal}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

export function parseMediaPlaylist(text: string): ParsedMediaPlaylist {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "#EXTM3U") {
    throw new Error("Media playlist does not start with #EXTM3U.");
  }

  let version = 0;
  let targetDuration = 0;
  let independentSegments = false;
  let playlistType: string | undefined;
  let map: ParsedMediaPlaylist["map"] | undefined;
  let hasEndList = false;
  const segments: PlaylistSegment[] = [];

  let pendingDuration: number | undefined;
  let pendingRange: PlaylistByteRange | undefined;
  let previousEnd = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;

    if (!line.startsWith("#")) {
      if (pendingDuration === undefined) {
        throw new Error(`Segment URI at line ${index + 1} has no #EXTINF.`);
      }
      if (!pendingRange) {
        throw new Error(
          `Segment URI at line ${index + 1} has no #EXT-X-BYTERANGE; single-file packaging requires one.`,
        );
      }
      segments.push({
        durationSeconds: pendingDuration,
        uri: line,
        byteRange: pendingRange,
      });
      previousEnd = pendingRange.offset + pendingRange.length;
      pendingDuration = undefined;
      pendingRange = undefined;
      continue;
    }

    const separator = line.indexOf(":");
    const tag = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);

    switch (tag) {
      case "#EXT-X-VERSION":
        version = Number(value);
        if (!Number.isInteger(version) || version < 1) {
          throw new Error("#EXT-X-VERSION is not a positive integer.");
        }
        break;
      case "#EXT-X-TARGETDURATION":
        targetDuration = Number(value);
        if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
          throw new Error("#EXT-X-TARGETDURATION is not a positive number.");
        }
        break;
      case "#EXT-X-INDEPENDENT-SEGMENTS":
        independentSegments = true;
        break;
      case "#EXT-X-PLAYLIST-TYPE":
        playlistType = value.trim();
        break;
      case "#EXT-X-MEDIA-SEQUENCE":
      case "#EXT-X-DISCONTINUITY-SEQUENCE":
        break;
      case "#EXT-X-MAP": {
        const uriMatch = /URI="([^"]+)"/.exec(value);
        const rangeMatch = /BYTERANGE="?([^",]+)"?/.exec(value);
        if (!uriMatch || !rangeMatch) {
          throw new Error("#EXT-X-MAP must carry both URI and BYTERANGE.");
        }
        const range = parseByteRange(rangeMatch[1], 0);
        if (!range) throw new Error("#EXT-X-MAP BYTERANGE is malformed.");
        map = { uri: uriMatch[1], byteRange: range };
        previousEnd = range.offset + range.length;
        break;
      }
      case "#EXTINF": {
        const duration = Number(value.split(",")[0]);
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error(
            `#EXTINF at line ${index + 1} is not a positive duration.`,
          );
        }
        pendingDuration = duration;
        break;
      }
      case "#EXT-X-BYTERANGE": {
        const range = parseByteRange(value, previousEnd);
        if (!range) {
          throw new Error(
            `#EXT-X-BYTERANGE at line ${index + 1} is malformed.`,
          );
        }
        pendingRange = range;
        break;
      }
      case "#EXT-X-ENDLIST":
        hasEndList = true;
        break;
      case "#EXT-X-DISCONTINUITY":
        throw new Error(
          "A packaged adaptive playlist must not contain #EXT-X-DISCONTINUITY.",
        );
      default:
        throw new Error(`Unsupported playlist tag ${tag}.`);
    }
  }

  if (!map) throw new Error("Media playlist has no #EXT-X-MAP initialization.");
  if (segments.length === 0) throw new Error("Media playlist has no segments.");
  if (!hasEndList)
    throw new Error("Media playlist is not terminated by #EXT-X-ENDLIST.");

  return {
    version,
    targetDuration,
    independentSegments,
    ...(playlistType === undefined ? {} : { playlistType }),
    map,
    segments,
    hasEndList,
    totalDurationSeconds: segments.reduce(
      (total, segment) => total + segment.durationSeconds,
      0,
    ),
  };
}

/**
 * Codec strings FFmpeg derived from the real bitstream, keyed by the rendition
 * directory name it wrote them against.
 */
export function parseCodecsFromGeneratedMaster(
  text: string,
): Map<string, string> {
  const byPath = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const codecs = /CODECS="([^"]+)"/.exec(line)?.[1];
    let uri: string | undefined;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (candidate === "") continue;
      if (candidate.startsWith("#")) break;
      uri = candidate;
      break;
    }
    if (codecs && uri) byPath.set(uri, codecs);
  }

  return byPath;
}

function escapeAttribute(value: string): string {
  // Quoted-string attribute values may contain neither a double quote nor a
  // line break. Titles come from source metadata, so they are untrusted input
  // to a format that has no escape sequence for either.
  return value
    .replace(/[\r\n"]/g, " ")
    .trim()
    .slice(0, 120);
}

function videoRangeFor(rendition: AdaptiveVideoRenditionMetadata): string {
  if (rendition.hdr === "hdr10") return "PQ";
  if (rendition.hdr === "hlg") return "HLG";
  return "SDR";
}

export interface MasterPlaylistInput {
  videoRenditions: AdaptiveVideoRenditionMetadata[];
  audioRenditions: AdaptiveAudioRenditionMetadata[];
  subtitleRenditions?: AdaptiveSubtitleRenditionMetadata[];
  /** Subtitle/audio-only scratch for an incremental update, never publication. */
  allowMissingVideo?: boolean;
  /** RFC 6381 video codec string per rendition id, from the real bitstream. */
  videoCodecStrings: Map<string, string>;
  audioCodecStrings: Map<string, string>;
}

/**
 * Builds the master playlist that ships.
 *
 * Bandwidth figures are measured: `BANDWIDTH` is the peak segment rate and
 * `AVERAGE-BANDWIDTH` the mean across the rendition, both with the default
 * audio rendition folded in, because a variant's advertised bandwidth is what a
 * player has to fetch to play it — and that includes the audio it is paired
 * with. Advertising the video rate alone makes every rung look cheaper than it
 * is and is exactly how an ABR ladder settles one rung too high and stalls.
 */
export function buildMasterPlaylist({
  videoRenditions,
  audioRenditions,
  subtitleRenditions = [],
  allowMissingVideo = false,
  videoCodecStrings,
  audioCodecStrings,
}: MasterPlaylistInput): string {
  if (!allowMissingVideo && videoRenditions.length === 0) {
    throw new Error("A master playlist needs at least one video rendition.");
  }
  /*
   * A master with no audio is legitimate for a work directory.
   *
   * An incremental run that adds a video rung to a title whose audio is
   * already published produces no audio, and the validator still needs a
   * master describing what that run made. The published master is built from
   * the merged package record, which carries the existing audio, so dropping
   * this guard cannot publish a silent package — and the packager already
   * refuses a source with no audio outright.
   */
  if (
    videoRenditions.length +
      audioRenditions.length +
      subtitleRenditions.length ===
    0
  ) {
    throw new Error("A master playlist needs at least one rendition.");
  }

  const defaultAudio =
    audioRenditions.find((rendition) => rendition.isDefault) ??
    audioRenditions[0];
  const defaultAudioCodec = defaultAudio
    ? audioCodecStrings.get(defaultAudio.id)
    : undefined;
  if (defaultAudio && !defaultAudioCodec) {
    throw new Error(
      `No codec string was measured for audio rendition ${defaultAudio.id}.`,
    );
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "",
  ];

  const audioNames = uniqueRenditionNames(
    audioRenditions.map((audio) => audio.title ?? audio.language ?? audio.id),
  );

  for (const [audioIndex, audio] of audioRenditions.entries()) {
    const attributes = [
      "TYPE=AUDIO",
      `GROUP-ID="${ADAPTIVE_AUDIO_GROUP}"`,
      `NAME="${escapeAttribute(audioNames[audioIndex]!)}"`,
      ...(audio.language
        ? [`LANGUAGE="${escapeAttribute(audio.language)}"`]
        : []),
      `DEFAULT=${audio.isDefault ? "YES" : "NO"}`,
      `AUTOSELECT=${audio.isDefault ? "YES" : "NO"}`,
      ...(audio.isForced ? ["FORCED=YES"] : []),
      `CHANNELS="${audio.channels}"`,
      `X-SEYIRLIK-STREAM-INDEX=${audio.sourceStreamIndex}`,
      `URI="${audio.playlistPath}"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attributes.join(",")}`);
  }

  const subtitleNames = uniqueRenditionNames(
    subtitleRenditions.map(
      (subtitle) => subtitle.title ?? subtitle.language ?? subtitle.id,
    ),
  );

  for (const [subtitleIndex, subtitle] of subtitleRenditions.entries()) {
    const attributes = [
      "TYPE=SUBTITLES",
      `GROUP-ID="${ADAPTIVE_SUBTITLE_GROUP}"`,
      `NAME="${escapeAttribute(subtitleNames[subtitleIndex]!)}"`,
      ...(subtitle.language
        ? [`LANGUAGE="${escapeAttribute(subtitle.language)}"`]
        : []),
      `DEFAULT=${subtitle.isDefault ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      ...(subtitle.isForced ? ["FORCED=YES"] : []),
      `URI="${subtitle.playlistPath}"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attributes.join(",")}`);
  }

  lines.push("");

  const ascending = [...videoRenditions].sort(
    (left, right) => left.averageBitrate - right.averageBitrate,
  );
  /*
   * The opening rung leads, then the rest in ascending order.
   *
   * A native player — Safari, AVPlayer, anything on iOS or tvOS — begins on the
   * first variant listed, because at that moment it has measured no bandwidth to
   * choose by. Listing the ladder purely in ascending order therefore started
   * every title on the smallest rung, and on a link whose estimate settles
   * slowly it stayed there: the picture opened at 144p and crawled up, which
   * reads as Auto being broken while a manual pick looks perfect. hls.js is
   * unaffected either way, since it picks by `startLevel` and ignores order —
   * which is why this only ever showed on the native path.
   *
   * The opener is the highest rung at or below 720p: high enough to look like a
   * considered choice on a large display, small enough that a modest connection
   * is not committed to something it cannot sustain before ABR has any evidence.
   */
  const OPENING_RUNG_CEILING = 720;
  const opener =
    [...ascending]
      .reverse()
      .find((video) => video.height <= OPENING_RUNG_CEILING) ?? ascending[0];
  const ordered = opener
    ? [opener, ...ascending.filter((video) => video !== opener)]
    : [];

  for (const video of ordered) {
    const videoCodec = videoCodecStrings.get(video.id);
    if (!videoCodec) {
      throw new Error(
        `No codec string was measured for video rendition ${video.id}.`,
      );
    }
    /*
     * A variant only advertises audio when the master actually carries an
     * audio group. Naming a group with no members would be a master that
     * refers to something it does not define, which is invalid and would fail
     * validation for an incremental run that adds video to published audio.
     */
    const audioBitrate = defaultAudio?.averageBitrate ?? 0;
    const attributes = [
      `BANDWIDTH=${Math.round(video.peakBitrate + audioBitrate)}`,
      `AVERAGE-BANDWIDTH=${Math.round(video.averageBitrate + audioBitrate)}`,
      `RESOLUTION=${video.width}x${video.height}`,
      `FRAME-RATE=${video.frameRate.toFixed(3)}`,
      `CODECS="${[videoCodec, defaultAudioCodec].filter(Boolean).join(",")}"`,
      `VIDEO-RANGE=${videoRangeFor(video)}`,
      ...(defaultAudio ? [`AUDIO="${ADAPTIVE_AUDIO_GROUP}"`] : []),
      ...(subtitleRenditions.length > 0
        ? [`SUBTITLES="${ADAPTIVE_SUBTITLE_GROUP}"`]
        : []),
    ];
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
    lines.push(video.playlistPath);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export interface ParsedMasterVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  resolution?: { width: number; height: number };
  frameRate?: number;
  codecs: string;
  videoRange?: string;
  audioGroup?: string;
}

export interface ParsedMasterPlaylist {
  independentSegments: boolean;
  variants: ParsedMasterVariant[];
  audioRenditions: Array<{
    groupId: string;
    name: string;
    language?: string;
    isDefault: boolean;
    uri: string;
  }>;
  subtitleRenditions: Array<{
    groupId: string;
    name: string;
    language?: string;
    isDefault: boolean;
    isForced: boolean;
    uri: string;
  }>;
}

function attributeValue(attributes: string, key: string): string | undefined {
  const quoted = new RegExp(`(?:^|,)${key}="([^"]*)"`).exec(attributes);
  if (quoted) return quoted[1];
  const bare = new RegExp(`(?:^|,)${key}=([^,]*)`).exec(attributes);
  return bare?.[1];
}

export function parseMasterPlaylist(
  text: string,
  { allowMissingVideo = false }: { allowMissingVideo?: boolean } = {},
): ParsedMasterPlaylist {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "#EXTM3U") {
    throw new Error("Master playlist does not start with #EXTM3U.");
  }

  let independentSegments = false;
  const variants: ParsedMasterVariant[] = [];
  const audioRenditions: ParsedMasterPlaylist["audioRenditions"] = [];
  const subtitleRenditions: ParsedMasterPlaylist["subtitleRenditions"] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;

    if (line === "#EXT-X-INDEPENDENT-SEGMENTS") {
      independentSegments = true;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = line.slice("#EXT-X-MEDIA:".length);
      const type = attributeValue(attributes, "TYPE");
      if (type !== "AUDIO" && type !== "SUBTITLES") continue;
      const groupId = attributeValue(attributes, "GROUP-ID");
      const uri = attributeValue(attributes, "URI");
      if (!groupId || !uri) {
        throw new Error("#EXT-X-MEDIA is missing GROUP-ID or URI.");
      }
      const language = attributeValue(attributes, "LANGUAGE");
      const rendition = {
        groupId,
        name: attributeValue(attributes, "NAME") ?? "",
        ...(language ? { language } : {}),
        isDefault: attributeValue(attributes, "DEFAULT") === "YES",
        uri,
      };
      if (type === "AUDIO") audioRenditions.push(rendition);
      else {
        subtitleRenditions.push({
          ...rendition,
          isForced: attributeValue(attributes, "FORCED") === "YES",
        });
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attributes = line.slice("#EXT-X-STREAM-INF:".length);
      let uri: string | undefined;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next].trim();
        if (candidate === "") continue;
        if (candidate.startsWith("#")) break;
        uri = candidate;
        break;
      }
      if (!uri) throw new Error("#EXT-X-STREAM-INF has no variant URI.");

      const bandwidth = Number(attributeValue(attributes, "BANDWIDTH"));
      const codecs = attributeValue(attributes, "CODECS");
      if (!Number.isFinite(bandwidth) || bandwidth <= 0 || !codecs) {
        throw new Error(
          "#EXT-X-STREAM-INF needs a positive BANDWIDTH and CODECS.",
        );
      }
      const resolution = attributeValue(attributes, "RESOLUTION");
      const resolutionMatch = resolution
        ? /^(\d+)x(\d+)$/.exec(resolution)
        : null;
      const averageBandwidth = Number(
        attributeValue(attributes, "AVERAGE-BANDWIDTH"),
      );
      const frameRate = Number(attributeValue(attributes, "FRAME-RATE"));
      const videoRange = attributeValue(attributes, "VIDEO-RANGE");
      const audioGroup = attributeValue(attributes, "AUDIO");

      variants.push({
        uri,
        bandwidth,
        ...(Number.isFinite(averageBandwidth) && averageBandwidth > 0
          ? { averageBandwidth }
          : {}),
        ...(resolutionMatch
          ? {
              resolution: {
                width: Number(resolutionMatch[1]),
                height: Number(resolutionMatch[2]),
              },
            }
          : {}),
        ...(Number.isFinite(frameRate) && frameRate > 0 ? { frameRate } : {}),
        codecs,
        ...(videoRange ? { videoRange } : {}),
        ...(audioGroup ? { audioGroup } : {}),
      });
    }
  }

  if (
    variants.length === 0 &&
    (!allowMissingVideo ||
      audioRenditions.length + subtitleRenditions.length === 0)
  ) {
    throw new Error("Master playlist contains no variants.");
  }

  return {
    independentSegments,
    variants,
    audioRenditions,
    subtitleRenditions,
  };
}
