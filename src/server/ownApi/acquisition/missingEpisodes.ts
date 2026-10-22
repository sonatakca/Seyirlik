/**
 * Searching for what a series is missing, and nothing else.
 *
 * "Missing" is what the season strip draws red: an episode that has aired,
 * is not held, and is neither downloading nor importing. The plan is read
 * from the same title detail the strip is drawn from, so the button and the
 * strip cannot disagree about which episodes it means.
 *
 * The search itself runs as a job. Each episode is one indexer search, and a
 * season of them takes longer than a request may stay open behind
 * Cloudflare. It is not one of `ACQUISITION_JOB_TYPES`, which the helper's
 * heavy worker claims next to SABnzbd: searching an indexer and writing rows
 * needs neither, so the server's own worker runs it.
 */
import type { JobHandler } from "../tasks/worker";
import { PermanentJobError } from "../tasks/worker";
import type { LibraryTitleDetail } from "../catalogue/libraryAdmin";
import type {
  AcquisitionFallback,
  MissingEpisodePlan,
} from "./acquisitionFallback";

export const MISSING_SEARCH_JOB_TYPE = "acquisition.searchMissing";

/** One search per series and scope at a time; a second press joins the first. */
export function missingSearchDedupeKey(itemId: string, season?: number) {
  return `${MISSING_SEARCH_JOB_TYPE}:${itemId}:${season ?? "all"}`;
}

type Episode = LibraryTitleDetail["seasons"][number]["episodes"][number];

function isMissing(episode: Episode): boolean {
  return (
    !episode.hasMedia &&
    episode.downloading === 0 &&
    episode.importing === 0 &&
    episode.status !== "unaired"
  );
}

/**
 * The missing episodes of a series, or of one of its seasons.
 *
 * Specials are left out: TMDB's season 0 is a grab bag that indexers rarely
 * number the same way. An episode the catalogue has no row for is searched
 * under its series' item, which is where its import will file it.
 */
export function missingEpisodePlan(
  detail: Pick<LibraryTitleDetail, "id" | "title" | "year" | "seasons">,
  season?: number,
): MissingEpisodePlan {
  return {
    seriesItemId: detail.id,
    title: detail.title,
    ...(detail.year === null ? {} : { year: detail.year }),
    seasons: detail.seasons
      .filter(
        (candidate) =>
          candidate.seasonNumber > 0 &&
          (season === undefined || candidate.seasonNumber === season),
      )
      .map((candidate) => {
        const numbered = candidate.episodes.filter(
          (episode) => episode.episodeNumber > 0,
        );
        const missing = numbered.filter(isMissing);
        const aired = numbered.filter(
          (episode) => episode.status !== "unaired",
        );
        return {
          season: candidate.seasonNumber,
          whole: missing.length > 0 && missing.length === aired.length,
          episodes: missing.map((episode) => ({
            episode: episode.episodeNumber,
            itemId: episode.id ?? detail.id,
          })),
        };
      })
      .filter((candidate) => candidate.episodes.length > 0),
  };
}

export function countMissing(plan: MissingEpisodePlan): number {
  return plan.seasons.reduce((sum, season) => sum + season.episodes.length, 0);
}

function readPlan(payload: Record<string, unknown>): MissingEpisodePlan {
  const plan = payload.plan as MissingEpisodePlan | undefined;
  if (
    !plan ||
    typeof plan.seriesItemId !== "string" ||
    typeof plan.title !== "string" ||
    !Array.isArray(plan.seasons)
  ) {
    throw new PermanentJobError("The task payload names no missing episodes.");
  }
  return plan;
}

export function createMissingSearchJobHandler(
  fallback: AcquisitionFallback,
): JobHandler {
  return async ({ job, reportProgress }) => {
    const plan = readPlan(job.payload);
    const profileId = job.payload.profileId;
    if (typeof profileId !== "string") {
      throw new PermanentJobError("The task payload names no quality profile.");
    }
    const policy = await fallback.policyFor(profileId);
    if (!policy) {
      throw new PermanentJobError("The quality profile no longer exists.");
    }
    const result = await fallback.acquireMissing(
      plan,
      policy,
      async (season, index) =>
        reportProgress(
          index / plan.seasons.length,
          `Searching season ${season} of ${plan.title}`,
        ),
    );
    await reportProgress(1, `Started ${result.started.length} downloads`);
    return {
      started: result.started.length,
      nothingAcceptable: result.nothing.length,
      alreadyComing: result.covered.length,
      startedReleases: result.started,
      nothingFor: result.nothing,
      coveredBy: result.covered,
    };
  };
}
