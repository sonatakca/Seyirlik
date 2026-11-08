import type {
  ProcessingSeason,
  ProcessingSeries,
  ProcessingTitle,
} from "../../lib/processingApi";

/**
 * The status chips under the Titles tab's search.
 *
 * Every chip reads the overview's own per-title projection — the same
 * snapshot the series tree and the queue are drawn from — rather than the
 * per-title previews, which arrive one ffprobe at a time and would make the
 * counts climb for minutes after the page opens.
 *
 * The chips are predicates, not a partition. A finished film whose source
 * was deleted is both "complete" and "source missing", and filtering by either
 * should find it; forcing it into one bucket would hide it from the other.
 */
export type ProcessingStatusFilter =
  | "all"
  | "queued"
  | "running"
  | "paused"
  | "unprocessed"
  | "partial"
  | "complete"
  | "sourceMissing";

export const PROCESSING_STATUS_FILTERS: readonly ProcessingStatusFilter[] = [
  "all",
  "queued",
  "running",
  "paused",
  "unprocessed",
  "partial",
  "complete",
  "sourceMissing",
];

/** The fields a chip reads; both films and episodes carry them. */
export type StatusFacts = Pick<
  ProcessingTitle,
  "activeJobId" | "activeJobState" | "packageState" | "sourceAvailable"
>;

export function matchesStatus(
  title: StatusFacts,
  filter: ProcessingStatusFilter,
): boolean {
  const active = title.activeJobId !== null;
  switch (filter) {
    case "all":
      return true;
    case "queued":
      return (
        active &&
        (title.activeJobState === "pending" ||
          title.activeJobState === "queued")
      );
    case "running":
      return active && title.activeJobState === "running";
    case "paused":
      return active && title.activeJobState === "paused";
    /*
     * The three package states describe titles nobody is working on. A queued
     * title has no package yet either, but it already has its own chip, and
     * "not processed" is a question about what still needs a press.
     */
    case "unprocessed":
      return !active && title.packageState === "none";
    case "partial":
      return (
        !active &&
        (title.packageState === "partial" || title.packageState === "stale")
      );
    case "complete":
      return !active && title.packageState === "complete";
    case "sourceMissing":
      return !title.sourceAvailable;
  }
}

export type StatusCounts = Record<ProcessingStatusFilter, number>;

export function countStatuses(
  titles: Iterable<StatusFacts | undefined>,
): StatusCounts {
  const counts = Object.fromEntries(
    PROCESSING_STATUS_FILTERS.map((filter) => [filter, 0]),
  ) as StatusCounts;
  for (const title of titles) {
    counts.all += 1;
    // A title the overview has not described yet counts only towards "all".
    if (!title) continue;
    for (const filter of PROCESSING_STATUS_FILTERS) {
      if (filter !== "all" && matchesStatus(title, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/**
 * Films narrowed to a chip.
 *
 * The cards are library items and the facts are the overview's movie
 * projection, joined by item id. A film the overview does not describe —
 * an older server, or one added since the last poll — is kept under "all" and
 * left out of every other chip rather than guessed at.
 */
export function filterByStatus<T>(
  items: readonly T[],
  factsOf: (item: T) => StatusFacts | undefined,
  filter: ProcessingStatusFilter,
): T[] {
  if (filter === "all") return [...items];
  return items.filter((item) => {
    const facts = factsOf(item);
    return facts ? matchesStatus(facts, filter) : false;
  });
}

/** Every episode of a (possibly already searched) tree, for the counts. */
export function seriesEpisodes(
  series: readonly ProcessingSeries[],
): ProcessingTitle[] {
  return series.flatMap((show) =>
    show.seasons.flatMap((season) => season.episodes),
  );
}

/**
 * The tree narrowed to the episodes a chip matches, with emptied seasons and
 * shows dropped. Unchanged branches keep their identity, so a poll that
 * returns the same tree re-renders nothing.
 */
export function filterSeriesByStatus(
  series: readonly ProcessingSeries[],
  filter: ProcessingStatusFilter,
): ProcessingSeries[] {
  if (filter === "all") return [...series];
  const filtered: ProcessingSeries[] = [];
  for (const show of series) {
    const seasons: ProcessingSeason[] = [];
    for (const season of show.seasons) {
      const episodes = season.episodes.filter((episode) =>
        matchesStatus(episode, filter),
      );
      if (episodes.length === 0) continue;
      seasons.push(
        episodes.length === season.episodes.length
          ? season
          : { ...season, episodes },
      );
    }
    if (seasons.length === 0) continue;
    filtered.push(
      seasons.length === show.seasons.length &&
        seasons.every((season, index) => season === show.seasons[index])
        ? show
        : { ...show, seasons },
    );
  }
  return filtered;
}
