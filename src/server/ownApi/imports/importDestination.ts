/**
 * What a file will be called once it is in the library, and where.
 *
 * The layout is the one the repository already uses, not a second one invented
 * here — `Title (Year)/src/Title (Year).mkv` for a film, and
 * `Series/Season 1/src/Series - S01E01 - Episode.mkv` for an episode. `src/` is
 * transparent to the scanner, so a source inside the bucket belongs to the
 * folder above it.
 *
 * The rest of this module is about names a filesystem will actually accept.
 * Windows refuses more than POSIX does, and refuses some of it in ways that
 * look like success — a trailing space is silently dropped, so `Dune ` and
 * `Dune` become the same file — which is why every name is normalised here
 * rather than being handed to the filesystem to see what happens.
 */
import { parseEpisodeName, splitExtension } from "../scanner/nameParser";
import type { ImportFailureClass } from "./importState";

/** The bucket a title's originals live in. Mirrors the scanner's layout. */
export const SOURCE_BUCKET = "src";

/**
 * Everything Windows refuses in a path segment, plus the control range.
 *
 * `:` and `\` are here for a second reason beyond being illegal: they are how
 * a drive-relative path (`C:file`) or a UNC path (`\\server\share`) would be
 * smuggled in through what is supposed to be a single name.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const ILLEGAL_SEGMENT_CHARACTERS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * Names Windows reserves for devices, whatever extension follows them.
 *
 * `CON.mkv` is not a file on Windows; it is the console. The check is against
 * the stem, because the reservation ignores the extension entirely.
 */
const RESERVED_DEVICE_NAMES =
  /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** How long one path segment may be. Comfortably inside every filesystem. */
const MAX_SEGMENT_LENGTH = 180;

/**
 * How long the whole library-relative path may be.
 *
 * Windows' classic limit is 260 characters for the *absolute* path. Node is
 * not bound by it — it passes long paths with the `\\?\` prefix, and on the
 * target host, with `LongPathsEnabled` set to `0`, it wrote a 297-character
 * path without complaint. Ordinary Win32 applications still obey the limit,
 * so a library file written past it is one Explorer, most players and most
 * backup tools cannot open.
 *
 * The ceiling here is therefore what everything *else* can read, not what this
 * process can write. Budgeting the relative part leaves room for a library
 * root without having to know where the library will be.
 */
const MAX_RELATIVE_LENGTH = 200;

export interface DestinationTarget {
  readonly kind: "movie" | "season" | "episode";
  /** The film's title, or the series' title. */
  readonly title: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
  /** The last episode of a file that holds a run of them. */
  readonly endEpisode?: number;
  readonly episodeTitle?: string;
}

export interface PlannedDestination {
  /** `/`-separated and relative to the library root, on every platform. */
  readonly relative: string;
  /** The identity the database holds a destination by. */
  readonly key: string;
}

export interface DestinationRefusal {
  readonly problem: ImportFailureClass;
  readonly detail: string;
}

export type DestinationOutcome = PlannedDestination | DestinationRefusal;

export function isRefusal<T extends object>(
  outcome: T | DestinationRefusal,
): outcome is DestinationRefusal {
  return "problem" in outcome;
}

/**
 * One path segment, made safe without being made unrecognisable.
 *
 * Illegal characters are removed rather than substituted, because a title with
 * `?` in it reads better without the character than with an underscore where
 * it was. Trailing dots and spaces go because Windows drops them silently,
 * which would otherwise make two different plans resolve to one file.
 */
export function safeSegment(value: string): string {
  const cleaned = value
    // Compose first: `é` written as `e` plus a combining accent and `é` as one
    // code point are the same name to a person and to most filesystems.
    .normalize("NFC")
    .replace(ILLEGAL_SEGMENT_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_SEGMENT_LENGTH)
    .trim()
    .replace(/[.\s]+$/, "");

  if (!cleaned) return "";
  // A reserved device name is kept legible rather than dropped.
  const { stem } = splitExtension(cleaned);
  return RESERVED_DEVICE_NAMES.test(stem) ? `_${cleaned}` : cleaned;
}

/** The extension, lower-cased and stripped of anything a segment may not hold. */
function safeExtension(fileName: string): string {
  const { extension } = splitExtension(fileName);
  const cleaned = extension.replace(ILLEGAL_SEGMENT_CHARACTERS, "").trim();
  return cleaned ? `.${cleaned.toLowerCase()}` : "";
}

function episodeCode(
  season: number,
  episode: number,
  endEpisode?: number,
): string {
  const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return endEpisode === undefined
    ? code
    : `${code}-E${String(endEpisode).padStart(2, "0")}`;
}

/**
 * The stem every file of this title shares.
 *
 * One function for the film and the episode because the subtitle beside a
 * media file has to agree with it exactly; deriving the two separately is how
 * they come to disagree.
 */
export function canonicalStem(target: DestinationTarget): string {
  const title = safeSegment(target.title);
  if (!title) return "";

  if (target.kind === "movie") {
    return target.year ? safeSegment(`${title} (${target.year})`) : title;
  }

  if (target.season === undefined) return "";
  if (target.episode === undefined) {
    // A whole season with no episode number of its own has no file stem.
    return "";
  }

  const code = episodeCode(target.season, target.episode, target.endEpisode);
  const episodeTitle = safeSegment(target.episodeTitle ?? "");
  return safeSegment(
    episodeTitle
      ? `${title} - ${code} - ${episodeTitle}`
      : `${title} - ${code}`,
  );
}

/** The folder that owns the title, relative to the library root. */
export function titleDirectory(target: DestinationTarget): string {
  const title = safeSegment(target.title);
  if (!title) return "";
  if (target.kind === "movie") {
    return target.year ? safeSegment(`${title} (${target.year})`) : title;
  }
  if (target.season === undefined) return "";
  return `${title}/${safeSegment(`Season ${target.season}`)}`;
}

function refuse(detail: string): DestinationRefusal {
  return { problem: "name-unrepresentable", detail };
}

/** What a season pack's names say one file is. */
type PackFileIdentity =
  | { readonly episode: number; readonly endEpisode?: number }
  | { readonly otherSeason: number }
  | null;

/**
 * Which episode one file of a season pack is, from its names alone.
 *
 * The file's own name is asked first, then the folders above it, nearest
 * first, because packs disagree about where the episode is written: flat
 * (`Show.S01E03.mkv`), one folder per episode (`Show.S01E03/abc123.mkv`), or
 * subtitles under `Subs/Show.S01E03/2_English.srt`. A video named only by a
 * leading number (`03 - Title.mkv`) is taken at its word, because inside a
 * season it can mean nothing else; that is asked last, of videos only, since
 * a subtitle's leading number is its track (`2_English.srt`).
 */
function identifyPackFile(
  season: number,
  sourceRelative: string,
  isMedia: boolean,
): PackFileIdentity {
  const segments = sourceRelative.split("/");
  const { stem } = splitExtension(segments.at(-1) ?? sourceRelative);
  for (const name of [stem, ...segments.slice(0, -1).reverse()]) {
    const parsed = parseEpisodeName(name, { folderSeasonNumber: season });
    if (parsed.episodeNumber === undefined) continue;
    if (parsed.seasonNumber !== undefined && parsed.seasonNumber !== season) {
      return { otherSeason: parsed.seasonNumber };
    }
    return {
      episode: parsed.episodeNumber,
      ...(parsed.endEpisodeNumber === undefined
        ? {}
        : { endEpisode: parsed.endEpisodeNumber }),
    };
  }
  const leading = isMedia && /^(\d{1,2})(?:[\s._-]|$)/.exec(stem.trim());
  return leading ? { episode: Number(leading[1]) } : null;
}

export interface PackFile {
  readonly relative: string;
  readonly role: string;
}

export interface FileTargets<F extends PackFile> {
  /** Each file to import, with the one-file target it is filed under. */
  readonly files: ReadonlyArray<{
    readonly file: F;
    readonly target: DestinationTarget;
  }>;
  /** What the download holds that is not this target's, and why. */
  readonly leftBehind: ReadonlyArray<{
    readonly relative: string;
    readonly reason: string;
  }>;
}

/**
 * What each file of a download is filed as.
 *
 * A film or an episode is one file's target already. A season is downloaded
 * as one release and filed one file per episode, and no two packs are laid out
 * alike, so the pack is explored rather than trusted: every video says which
 * episode it is or is left behind — an extra with no episode in its name,
 * another season a complete-series pack brought along — and a subtitle goes
 * with an episode being imported or not at all. Left-behind files stay in
 * the download; cleanup only ever removes what was committed.
 *
 * A pack in which not one video is an episode of the season is refused, since
 * importing nothing and calling it done would hide that the download was wrong.
 */
export function fileTargetsFor<F extends PackFile>(
  target: DestinationTarget,
  media: readonly F[],
  subtitles: readonly F[],
): FileTargets<F> | DestinationRefusal {
  if (target.kind !== "season" || target.episode !== undefined) {
    return {
      files: [...media, ...subtitles].map((file) => ({ file, target })),
      leftBehind: [],
    };
  }
  const season = target.season;
  if (season === undefined) {
    return refuse("The season target has no season number.");
  }

  const files: { file: F; target: DestinationTarget }[] = [];
  const leftBehind: { relative: string; reason: string }[] = [];
  const episodes = new Set<number>();
  for (const file of [...media, ...subtitles]) {
    const isMedia = file.role === "media";
    const identity = identifyPackFile(season, file.relative, isMedia);
    if (!identity) {
      leftBehind.push({ relative: file.relative, reason: "names no episode" });
    } else if ("otherSeason" in identity) {
      leftBehind.push({
        relative: file.relative,
        reason: `belongs to season ${identity.otherSeason}`,
      });
    } else if (!isMedia && !episodes.has(identity.episode)) {
      leftBehind.push({
        relative: file.relative,
        reason: `is for episode ${identity.episode}, which is not imported`,
      });
    } else {
      if (isMedia) episodes.add(identity.episode);
      files.push({
        file,
        target: {
          ...target,
          kind: "episode",
          episode: identity.episode,
          ...(identity.endEpisode === undefined
            ? {}
            : { endEpisode: identity.endEpisode }),
        },
      });
    }
  }

  if (episodes.size === 0) {
    return refuse(
      `None of the ${media.length} video file(s) in the download names an episode of season ${season}.`,
    );
  }
  return { files, leftBehind };
}

function within(relative: string): DestinationOutcome | undefined {
  if (relative.length > MAX_RELATIVE_LENGTH) {
    return refuse(
      `The destination path is ${relative.length} characters, past the ${MAX_RELATIVE_LENGTH} an import will write.`,
    );
  }
  return undefined;
}

/**
 * Where the feature file goes.
 *
 * The extension comes from the source and everything else from the target, so
 * a badly named download cannot name a library file.
 */
export function planMediaDestination(
  target: DestinationTarget,
  sourceFileName: string,
): DestinationOutcome {
  const directory = titleDirectory(target);
  const stem = canonicalStem(target);
  if (!directory || !stem) {
    return refuse("The target does not supply a name for the library.");
  }
  const extension = safeExtension(sourceFileName);
  if (!extension) {
    return refuse("The source file has no usable extension.");
  }

  const relative = `${directory}/${SOURCE_BUCKET}/${stem}${extension}`;
  return within(relative) ?? { relative, key: "" };
}

/**
 * The language-ish part of a subtitle's name, if it has one.
 *
 * Two shapes are handled because both are common: `Movie.tr.forced.srt` from a
 * subtitle manager, and `2_English.srt` from inside a release's `Subs` folder.
 * Nothing is invented — a subtitle whose name says nothing gets no suffix, and
 * two that say the same thing collide, which the caller is told about rather
 * than silently renamed around.
 */
export function subtitleSuffix(sourceFileName: string): string {
  const { stem } = splitExtension(sourceFileName);
  const dotted = /\.([A-Za-z]{2,3}(?:\.(?:forced|default|sdh|cc|hi))*)$/i.exec(
    stem,
  );
  if (dotted) return dotted[1]!.toLowerCase();

  // `2_English`, `3_Turkish`: the ordinal is the release's, not a fact.
  const numbered = /^\d+[_-]\s*([A-Za-z][A-Za-z ]{1,30})$/.exec(stem.trim());
  if (numbered) return safeSegment(numbered[1]!.trim()).toLowerCase();

  return "";
}

/**
 * Where a subtitle goes: beside its media, sharing its stem.
 *
 * Sharing the stem is what makes a player find it, so the stem is taken from
 * the media plan rather than derived again.
 */
export function planSubtitleDestination(
  target: DestinationTarget,
  sourceFileName: string,
): DestinationOutcome {
  const directory = titleDirectory(target);
  const stem = canonicalStem(target);
  if (!directory || !stem) {
    return refuse("The target does not supply a name for the library.");
  }
  const extension = safeExtension(sourceFileName);
  if (!extension) {
    return refuse("The subtitle has no usable extension.");
  }

  const suffix = subtitleSuffix(sourceFileName);
  const named = suffix ? `${stem}.${suffix}` : stem;
  const relative = `${directory}/${SOURCE_BUCKET}/${named}${extension}`;
  return within(relative) ?? { relative, key: "" };
}

/**
 * The identity a destination is held by, across every import.
 *
 * Case-folded because the library lives on a case-insensitive filesystem,
 * where `Dune.mkv` and `DUNE.MKV` are one file; separators normalised so the
 * same destination reads the same whichever host planned it. The library root
 * is part of the key, because two libraries may legitimately hold the same
 * relative path.
 */
export function destinationKey(libraryRoot: string, relative: string): string {
  const normalised = `${libraryRoot.replace(/[\\/]+$/, "")}/${relative}`
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .normalize("NFC");
  return normalised.toLocaleLowerCase("en-US");
}

/** Fills in the key a planned destination is stored under. */
export function withKey(
  libraryRoot: string,
  outcome: DestinationOutcome,
): DestinationOutcome {
  if (isRefusal(outcome)) return outcome;
  return {
    relative: outcome.relative,
    key: destinationKey(libraryRoot, outcome.relative),
  };
}
