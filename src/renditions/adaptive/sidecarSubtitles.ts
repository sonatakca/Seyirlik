import { readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeLanguage, UNKNOWN_LANGUAGE } from "../processing/languages";
import { SUPPORTED_VIDEO_EXTENSIONS, isDerivativeFileName } from "../policy";

/**
 * Subtitle files that sit beside a source rather than inside it.
 *
 * A library filled by hand or by an automation is mostly subtitled this way:
 * the container carries the film and a `.srt` next to it carries the
 * translation. Reading only the embedded streams reports such a title as having
 * no subtitles in the retained language at all, which is how a library where
 * nearly every film has a Turkish `.srt` can look like it has almost none.
 */

/** Extensions that hold text subtitles ffmpeg can turn into WebVTT. */
export const SIDECAR_SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".srt",
  ".vtt",
  ".ass",
  ".ssa",
  ".sub",
]);

/**
 * Where synthetic stream indexes for sidecars begin.
 *
 * A rendition id is `subtitle-<sourceStreamIndex>`, and the manifest checks the
 * two agree, so a sidecar needs an index of its own. Starting well above any
 * plausible stream count keeps sidecar ids from ever colliding with a real
 * stream's, and keeps the id scheme and its validation unchanged.
 */
export const SIDECAR_STREAM_INDEX_BASE = 1000;

/** Tags that mark a track as being for viewers who cannot hear the audio. */
const HEARING_IMPAIRED_TAGS = new Set(["hi", "sdh", "cc"]);
const FORCED_TAGS = new Set(["forced", "foreign"]);

/**
 * A tag that could be a language code at all.
 *
 * Purely alphabetic and two or three letters. Release names are full of tokens
 * that a looser check reads as languages — `mx]` out of `[YTS.MX]`, `4k`, `1`.
 */
const LANGUAGE_SHAPED_TAG = /^[a-z]{2,3}$/;
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], {
  type: "language",
  fallback: "none",
});

export interface SidecarSubtitleTags {
  /** Normalised language, or the unknown marker when the name carries none. */
  language: string;
  isForced: boolean;
  isHearingImpaired: boolean;
}

/**
 * What a sidecar's filename says about the track.
 *
 * When the names match, only the part after the source's own name is read.
 * Dots, hyphens, underscores and spaces separate subtitle tags, including
 * release-style names such as `LAMA-tr-synced.srt`. `Dune (2021) [438631]` is
 * the title, not a description of the subtitle, and it is full of tokens — a
 * year, a bracketed id — that would otherwise be mistaken for tags.
 */
export function parseSidecarSubtitleTags(
  fileName: string,
  sourceStem: string,
): SidecarSubtitleTags {
  const withoutExtension = fileName.slice(0, -path.extname(fileName).length);
  const remainder = withoutExtension
    .toLowerCase()
    .startsWith(sourceStem.toLowerCase())
    ? withoutExtension.slice(sourceStem.length)
    : withoutExtension;

  const tags = remainder
    .split(/[.\s_-]+/)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0);

  let language = UNKNOWN_LANGUAGE;
  let isForced = false;
  let isHearingImpaired = false;

  for (const tag of tags) {
    if (HEARING_IMPAIRED_TAGS.has(tag)) {
      isHearingImpaired = true;
      continue;
    }
    if (FORCED_TAGS.has(tag)) {
      isForced = true;
      continue;
    }
    /*
     * The *last* language-shaped tag wins, and only a purely alphabetic one is
     * considered, and it must name a known language: `HDR` and `The` are release
     * or title words, even though the container normalizer accepts any three
     * letters. These rules exist because a sidecar is often named after the
     * release rather than the title, so the tags are a whole release string:
     * `...AAC5.1-[YTS.MX].tur.srt` offers `mx]` before it offers `tur`, and
     * the convention everywhere is that the language sits last, just before
     * the flags and the extension.
     */
    if (!LANGUAGE_SHAPED_TAG.test(tag)) continue;
    const candidate = normalizeLanguage(tag);
    if (candidate !== UNKNOWN_LANGUAGE && LANGUAGE_NAMES.of(candidate)) {
      language = candidate;
    }
  }

  return { language, isForced, isHearingImpaired };
}

export interface SidecarSubtitle extends SidecarSubtitleTags {
  /** Absolute path to the subtitle file. */
  filePath: string;
  fileName: string;
  /** The synthetic index this sidecar is packaged under. */
  streamIndex: number;
  /** Hash of the filename and bytes; indexes alone change when files are added. */
  sidecarFingerprint?: string;
}

/** Legacy packages have no sidecar identity and are refreshed once. */
export function sidecarSubtitleIsCurrent(
  sidecar: SidecarSubtitle,
  rendition: { sidecarFingerprint?: string } | undefined,
): boolean {
  return (
    sidecar.sidecarFingerprint !== undefined &&
    sidecar.sidecarFingerprint === rendition?.sidecarFingerprint
  );
}

/**
 * Subtitle files beside `sourcePath` that belong to it.
 *
 * A title folder holds one film, so a subtitle in it belongs to that film even
 * when its name came from a different release than the video's. Requiring the
 * names to match would discard exactly the hand-added translations this is for.
 *
 * A season folder is the case that breaks the premise. It holds ten sources and
 * ten `.tr.srt` files, and taking every subtitle in the directory gave each
 * episode all ten — nine of them the wrong translation, presented as if they
 * were alternate tracks. So the permissive rule is applied where its reason
 * holds, in a folder with a single video, and a shared folder matches subtitles
 * to the source by name instead. That is the only thing that can tell the two
 * apart there, and it is what the naming convention in such a folder is for.
 *
 * A source that is no longer there breaks the premise too. Once a processed
 * title's source is removed only its sidecars stay behind, so a season's `src/`
 * folder can hold thirteen `.tur.srt` files and no video at all — and counting
 * videos would call that one film's folder and hand every episode all thirteen.
 * The folder's video count says nothing about a source missing from it, so an
 * absent source is matched by name, whatever is left beside it.
 */
export async function discoverSidecarSubtitles(
  sourcePath: string,
  options: { readDirectory?: typeof readdir } = {},
): Promise<SidecarSubtitle[]> {
  const directory = path.dirname(sourcePath);
  const sourceStem = path.basename(sourcePath, path.extname(sourcePath));
  const read = options.readDirectory ?? readdir;

  let entries: string[];
  try {
    entries = await read(directory);
  } catch {
    // A source whose directory cannot be listed still packages; it simply
    // contributes no sidecars.
    return [];
  }

  /*
   * Whether this directory belongs to one title or is shared. Counted from the
   * videos actually in it rather than from the library layout, so it is right
   * for a season folder, a movie folder, and the flat folder someone keeps
   * three films in alike.
   */
  const videoSiblings = entries.filter(
    (name) =>
      !name.startsWith("._") &&
      SUPPORTED_VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) &&
      !isDerivativeFileName(name),
  );
  const sourceName = path.basename(sourcePath).toLowerCase();
  const sourcePresent = entries.some(
    (name) => name.toLowerCase() === sourceName,
  );
  const directoryIsShared = !sourcePresent || videoSiblings.length > 1;
  const belongsToSource = (name: string): boolean =>
    name.toLowerCase().startsWith(sourceStem.toLowerCase());

  return (
    entries
      .filter((name) =>
        SIDECAR_SUBTITLE_EXTENSIONS.has(path.extname(name).toLowerCase()),
      )
      // AppleDouble companions carry no subtitle text, only resource-fork
      // metadata the volume wrote beside the real file.
      .filter((name) => !name.startsWith("._"))
      .filter((name) => !directoryIsShared || belongsToSource(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name, index) => ({
        ...parseSidecarSubtitleTags(name, sourceStem),
        filePath: path.join(directory, name),
        fileName: name,
        streamIndex: SIDECAR_STREAM_INDEX_BASE + index,
      }))
  );
}
