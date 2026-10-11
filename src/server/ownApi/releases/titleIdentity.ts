/**
 * Which film or series a typed title means, in the names releases carry.
 *
 * Usenet releases are named in a title's original or English form —
 * `The.Dark.Knight.2008`, never `Kara.Sovalye` — and an indexer's text search
 * matches words, not meanings. Asked for "Kara Şövalye", NZBgeek returns
 * nothing; asked for "Joker: Folie à Deux" it also returns nothing, because
 * of the colon and the accent, where "Joker Folie a Deux" returns a hundred.
 *
 * TMDB knows every name a title goes by, in Turkish and in English, and holds
 * the IMDb id that lets an indexer be asked by identity rather than by words.
 * So the words are resolved there first, and the release search follows from
 * what they resolved to.
 */
import {
  selectBestMatch,
  titleSimilarity,
  type MatchCandidate,
} from "../metadata/matcher";
import type { TmdbClient } from "../metadata/tmdbClient";

/** The language Seyirlik's users type titles in. */
const LOCAL_LANGUAGE = "tr-TR";
const ENGLISH = "en-US";

/**
 * Below this the nearest TMDB title is a different title, and searching for
 * it would replace the operator's words with a guess. "joker" against "Joker:
 * Folie à Deux" scores 0.4 and is left alone.
 */
const MIN_TITLE_SIMILARITY = 0.75;

const MAX_ALTERNATIVES = 4;

export interface TitleChoice {
  readonly tmdbId: string;
  /** As Seyirlik shows it: the Turkish title where TMDB has one. */
  readonly title: string;
  readonly originalTitle?: string;
  readonly year?: number;
}

export interface TitleIdentity extends TitleChoice {
  readonly englishTitle: string;
  readonly imdbId?: string;
}

export interface IdentityResolution {
  readonly identity: TitleIdentity | null;
  /**
   * Other titles the same words could mean. "Kara Şövalye" is both The Dark
   * Knight and Black Knight; the more popular is searched, and the rest are
   * offered rather than silently discarded.
   */
  readonly alternatives: readonly TitleChoice[];
}

export interface IdentityQuery {
  readonly kind: "movie" | "tv";
  readonly title: string;
  readonly year?: number;
  /** The operator, or the page that linked here, already knows which. */
  readonly tmdbId?: string;
}

/**
 * Latin letters without their marks: "Şövalye" is "Sovalye", "Kılıç" is
 * "Kilic". NFKD separates most marks; the letters it cannot decompose are
 * spelled out.
 */
const UNDECOMPOSED: Readonly<Record<string, string>> = {
  ı: "i",
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
};

export function foldLatin(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ıßæÆœŒøØłŁđĐ]/g, (letter) => UNDECOMPOSED[letter] ?? letter);
}

/**
 * A title as words an indexer can match: no marks, no punctuation, and an
 * apostrophe closed up the way release names close it ("Ocean's Eleven" is
 * `Oceans.Eleven`). Empty for a title with no Latin letters in it at all.
 */
export function indexerTerm(title: string): string {
  return foldLatin(title)
    .replace(/['’`]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
}

function yearOf(date: string | undefined): number | undefined {
  const year = Number(date?.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

async function describe(
  tmdb: TmdbClient,
  kind: IdentityQuery["kind"],
  tmdbId: string,
  localTitle: string | undefined,
): Promise<TitleIdentity> {
  const details =
    kind === "movie"
      ? await tmdb.getMovie(tmdbId, ENGLISH)
      : await tmdb.getSeries(tmdbId, ENGLISH);
  const year = yearOf(details.releaseDate);
  return {
    tmdbId,
    title: localTitle ?? details.title,
    englishTitle: details.title,
    ...(details.originalTitle ? { originalTitle: details.originalTitle } : {}),
    ...(year === undefined ? {} : { year }),
    ...(details.imdbId ? { imdbId: details.imdbId } : {}),
  };
}

interface Found {
  readonly tmdbId: string;
  readonly names: string[];
  localTitle?: string;
  originalTitle?: string;
  readonly year?: number;
  readonly popularity?: number;
}

/**
 * The title the words name, or null when TMDB has nothing close enough.
 *
 * Searched in Turkish and in English at once: TMDB's search only reads the
 * titles of the language it is asked in, so "kara sovalye" finds The Dark
 * Knight in Turkish and does not find it in English, while "Spirited Away"
 * is the other way round.
 */
export async function resolveTitleIdentity(
  tmdb: TmdbClient,
  query: IdentityQuery,
): Promise<IdentityResolution> {
  if (query.tmdbId) {
    return {
      identity: await describe(tmdb, query.kind, query.tmdbId, undefined),
      alternatives: [],
    };
  }

  const search = (language: string) =>
    query.kind === "movie"
      ? tmdb.searchMovies(query.title, query.year, language)
      : tmdb.searchSeries(query.title, query.year, language);
  const [local, english] = await Promise.all([
    search(LOCAL_LANGUAGE),
    search(ENGLISH),
  ]);

  const found = new Map<string, Found>();
  const add = (candidate: MatchCandidate, isLocal: boolean) => {
    const entry: Found = found.get(candidate.providerId) ?? {
      tmdbId: candidate.providerId,
      names: [],
      ...(candidate.year === undefined ? {} : { year: candidate.year }),
      ...(candidate.popularity === undefined
        ? {}
        : { popularity: candidate.popularity }),
    };
    entry.names.push(
      candidate.title,
      ...(candidate.originalTitle ? [candidate.originalTitle] : []),
    );
    if (isLocal) entry.localTitle = candidate.title;
    if (candidate.originalTitle) entry.originalTitle = candidate.originalTitle;
    found.set(candidate.providerId, entry);
  };
  for (const candidate of local) add(candidate, true);
  for (const candidate of english) add(candidate, false);

  const plausible = [...found.values()]
    .map((entry) => {
      const [name, similarity] = entry.names
        .map((value) => [value, titleSimilarity(query.title, value)] as const)
        .reduce((best, next) => (next[1] > best[1] ? next : best));
      return { entry, name, similarity };
    })
    .filter(({ similarity }) => similarity >= MIN_TITLE_SIMILARITY);

  const best = selectBestMatch(
    { title: query.title, ...(query.year ? { year: query.year } : {}) },
    plausible.map(({ entry, name }) => ({
      providerId: entry.tmdbId,
      title: name,
      ...(entry.year === undefined ? {} : { year: entry.year }),
      ...(entry.popularity === undefined
        ? {}
        : { popularity: entry.popularity }),
    })),
  );
  if (!best) return { identity: null, alternatives: [] };

  const chosen = found.get(best.candidate.providerId)!;
  const choice = (entry: Found): TitleChoice => {
    const title = entry.localTitle ?? entry.names[0]!;
    return {
      tmdbId: entry.tmdbId,
      title,
      ...(entry.originalTitle && entry.originalTitle !== title
        ? { originalTitle: entry.originalTitle }
        : {}),
      ...(entry.year === undefined ? {} : { year: entry.year }),
    };
  };

  return {
    identity: await describe(
      tmdb,
      query.kind,
      chosen.tmdbId,
      chosen.localTitle,
    ),
    alternatives: plausible
      .filter(({ entry }) => entry !== chosen)
      .sort(
        (left, right) =>
          (right.entry.popularity ?? 0) - (left.entry.popularity ?? 0),
      )
      .slice(0, MAX_ALTERNATIVES)
      .map(({ entry }) => choice(entry)),
  };
}

/** Every name a release for this title may legitimately carry. */
export function identityNames(identity: TitleIdentity): string[] {
  return [
    identity.title,
    identity.englishTitle,
    ...(identity.originalTitle ? [identity.originalTitle] : []),
  ];
}
