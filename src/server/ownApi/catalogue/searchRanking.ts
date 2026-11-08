/**
 * Typo-tolerant ranking for catalogue search.
 *
 * The SQL pass is a substring match, which is fast and exact and finds nothing
 * at all when somebody drops a letter. This module scores candidates in memory
 * so "oppenhimer" still reaches Oppenheimer, and so a Turkish library is
 * searchable from an ASCII keyboard.
 */

export interface SearchCandidate {
  id: string;
  kind: string;
  title: string;
  originalTitle: string | null;
  /**
   * The title's other names: the provider's in other languages, and any an
   * administrator added.
   */
  alternateTitles?: readonly string[];
  seriesTitle: string | null;
}

/** Fields are worth different amounts: an episode matched only through its
 * series name is a weaker hit than one matched on its own title. */
const TITLE_WEIGHT = 1;
const ORIGINAL_TITLE_WEIGHT = 0.95;
/** Another language's name is as good a hit as the original title. */
const ALTERNATE_TITLE_WEIGHT = 0.95;
const SERIES_TITLE_WEIGHT = 0.55;

/** Nudges whole titles above episodes when both match equally well. */
const KIND_BONUS: Record<string, number> = {
  movie: 6,
  series: 6,
  book: 6,
  season: 2,
  episode: 0,
};

/**
 * Folds a string to a bare lowercase ASCII skeleton.
 *
 * Turkish needs explicit care: NFD decomposes ş, ğ, ç, ö, ü and İ into a base
 * letter plus a combining mark, but dotless ı is its own letter and survives
 * decomposition, so it is mapped by hand. Without that, "Işık" typed as "isik"
 * matches nothing.
 */
export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);

  return normalized ? normalized.split(" ") : [];
}

/**
 * How far a token may stray before it stops being a typo. Short words get no
 * slack, because at three letters almost anything is within one edit of
 * anything else.
 */
export function allowedEditDistance(token: string): number {
  if (token.length <= 3) return 0;
  if (token.length <= 5) return 1;
  if (token.length <= 9) return 2;
  return 3;
}

/**
 * Damerau-Levenshtein distance, abandoned as soon as it exceeds maxDistance.
 *
 * Transpositions count as one edit rather than two, which matters because
 * swapped letters are the most common typing mistake there is.
 */
export function boundedEditDistance(
  left: string,
  right: string,
  maxDistance: number,
): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }
  if (maxDistance <= 0) return 1;

  let previousPrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current: number[] = [];

  for (let i = 1; i <= left.length; i += 1) {
    current = new Array<number>(right.length + 1);
    current[0] = i;
    let bestInRow = current[0];

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;

      let value = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );

      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }

      current[j] = value;
      bestInRow = Math.min(bestInRow, value);
    }

    // Every remaining row can only add to the best score in this one, so once
    // the whole row is out of budget the answer is settled.
    if (bestInRow > maxDistance) return maxDistance + 1;

    previousPrevious = previous;
    previous = current;
  }

  return previous[right.length];
}

/**
 * Scores one field, or returns null when it is not a match at all.
 *
 * The tiers are ordered so a real substring always outranks a guess: an exact
 * title beats a prefix, a prefix beats a substring, and only then does the
 * fuzzy pass get a say.
 */
export function scoreSearchField(
  normalizedQuery: string,
  queryTokens: string[],
  fieldValue: string | null,
): number | null {
  if (!fieldValue) return null;

  const field = normalizeSearchText(fieldValue);
  if (!field || queryTokens.length === 0) return null;

  if (field === normalizedQuery) return 1000;
  if (field.startsWith(normalizedQuery)) return 900;

  const substringIndex = field.indexOf(normalizedQuery);
  if (substringIndex >= 0) {
    // An earlier match is a better one, but never enough to overtake a prefix.
    return 820 - Math.min(substringIndex, 60);
  }

  const fieldTokens = field.split(" ");

  if (
    queryTokens.every((queryToken) =>
      fieldTokens.some((fieldToken) => fieldToken.startsWith(queryToken)),
    )
  ) {
    return 740;
  }

  let totalDistance = 0;

  for (const queryToken of queryTokens) {
    const budget = allowedEditDistance(queryToken);

    if (budget === 0) return null;

    let bestDistance = budget + 1;

    for (const fieldToken of fieldTokens) {
      const distance = boundedEditDistance(queryToken, fieldToken, budget);

      if (distance < bestDistance) bestDistance = distance;
      if (bestDistance === 0) break;
    }

    if (bestDistance > budget) return null;

    totalDistance += bestDistance;
  }

  return 700 - totalDistance * 40;
}

export function scoreSearchCandidate(
  normalizedQuery: string,
  queryTokens: string[],
  candidate: SearchCandidate,
): number | null {
  const scores = [
    weigh(
      scoreSearchField(normalizedQuery, queryTokens, candidate.title),
      TITLE_WEIGHT,
    ),
    weigh(
      scoreSearchField(normalizedQuery, queryTokens, candidate.originalTitle),
      ORIGINAL_TITLE_WEIGHT,
    ),
    ...(candidate.alternateTitles ?? []).map((name) =>
      weigh(
        scoreSearchField(normalizedQuery, queryTokens, name),
        ALTERNATE_TITLE_WEIGHT,
      ),
    ),
    weigh(
      scoreSearchField(normalizedQuery, queryTokens, candidate.seriesTitle),
      SERIES_TITLE_WEIGHT,
    ),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) return null;

  return Math.max(...scores) + (KIND_BONUS[candidate.kind] ?? 0);
}

function weigh(score: number | null, weight: number): number | null {
  return score === null ? null : score * weight;
}

/** Best matches first, ties broken by title so the order is never arbitrary. */
export function rankSearchCandidates(
  query: string,
  candidates: SearchCandidate[],
  limit: number,
): SearchCandidate[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = normalizedQuery ? normalizedQuery.split(" ") : [];

  if (queryTokens.length === 0) return [];

  const scored: Array<{ candidate: SearchCandidate; score: number }> = [];

  for (const candidate of candidates) {
    const score = scoreSearchCandidate(normalizedQuery, queryTokens, candidate);

    if (score !== null) scored.push({ candidate, score });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.title.localeCompare(right.candidate.title),
  );

  return scored.slice(0, limit).map((entry) => entry.candidate);
}
