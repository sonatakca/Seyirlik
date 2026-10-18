/**
 * Choosing what replaces a release that cannot be downloaded.
 *
 * Two callers share this. An operator presses "blocklist and search again",
 * and the reconciler asks for it on its own when SABnzbd reports a release
 * that will never complete (missing articles, a failed repair). Either way
 * the replacement is what the original decision would have chosen without
 * the failed release in it: the same target, the same quality profile.
 *
 * A season adds one step. Older shows are often only posted episode by
 * episode, so when no acceptable season pack is left, each episode the
 * catalogue knows of is searched and chosen on its own, and the season
 * acquisition is replaced by one acquisition per episode.
 */
import type { DatabasePool } from "../database/databasePool";
import type { JobQueue } from "../tasks/jobQueue";
import type { IndexerSearchService } from "../indexers/searchService";
import type { IndexerRelease } from "../indexers/indexerTypes";
import { selectRelease, type MediaTarget } from "../releases/decide";
import { searchFor } from "../releases/releaseRoutes";
import type {
  AcquisitionPolicy,
  PolicyRepository,
} from "../releases/policyRepository";
import type { BlocklistRepository } from "../releases/blocklistRepository";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
  AcquisitionTarget,
} from "./acquisitionRepository";

/** Replacements an automatic fallback may make for one title. */
export const MAX_AUTOMATIC_REPLACEMENTS = 3;

/** One episode of a season, as the catalogue knows it. */
export interface SeasonEpisode {
  readonly itemId: string;
  readonly episode: number;
}

export interface AcquisitionFallbackOptions {
  readonly repository: AcquisitionRepository;
  readonly search: IndexerSearchService;
  readonly policies: PolicyRepository;
  readonly blocklist: BlocklistRepository;
  readonly queue: JobQueue;
  /** The episodes of a series' season, from the catalogue. */
  readonly episodesOf: (
    seriesItemId: string,
    season: number,
  ) => Promise<SeasonEpisode[]>;
  /** The job that hands an acquisition to the download client. */
  readonly submitJobType: string;
}

type Selected = NonNullable<ReturnType<typeof selectRelease>["winner"]>;

export type ReplacementChoice =
  | {
      readonly kind: "release";
      readonly target: AcquisitionTarget;
      readonly winner: Selected;
      readonly rejected: ReturnType<typeof selectRelease>["candidates"];
    }
  | {
      readonly kind: "episodes";
      readonly picks: ReadonlyArray<{
        readonly target: AcquisitionTarget;
        readonly winner: Selected;
      }>;
      /** Episodes searched that had nothing acceptable. */
      readonly missing: readonly number[];
    }
  | { readonly kind: "none" };

export interface ReplacementResult {
  readonly created: AcquisitionSummary[];
  readonly taskIds: string[];
}

export function mediaTargetOf(target: AcquisitionTarget): MediaTarget | null {
  if (target.kind === "movie") {
    return {
      kind: "movie",
      title: target.title,
      ...(target.year === undefined ? {} : { year: target.year }),
    };
  }
  if (target.season === undefined) return null;
  if (target.kind === "season") {
    return { kind: "season", title: target.title, season: target.season };
  }
  if (target.episode === undefined) return null;
  return {
    kind: "episode",
    title: target.title,
    season: target.season,
    episode: target.episode,
  };
}

export function createAcquisitionFallback({
  repository,
  search,
  policies,
  blocklist,
  queue,
  episodesOf,
  submitJobType,
}: AcquisitionFallbackOptions) {
  async function best(
    target: MediaTarget,
    policy: AcquisitionPolicy,
    exclude: { indexerId: string; releaseGuid: string } | null,
    signal?: AbortSignal,
  ) {
    const found = await search.search(searchFor(target, undefined), {
      ...(signal ? { signal } : {}),
    });
    const releases: readonly IndexerRelease[] = exclude
      ? found.releases.filter(
          (release) =>
            !(
              release.indexerId === exclude.indexerId &&
              release.guid === exclude.releaseGuid
            ),
        )
      : found.releases;
    return selectRelease(target, releases, {
      profile: policy.profile,
      preferences: policy.preferences,
      isBlocklisted: await blocklist.matcherFor(releases),
      current: null,
    });
  }

  /**
   * What would replace this acquisition, without changing anything.
   *
   * Searching first and committing after is what lets an automatic caller
   * leave the row exactly as it was when the indexer is unreachable: nothing
   * is blocklisted or superseded on the strength of a search that failed.
   */
  async function choose(
    target: AcquisitionTarget,
    policy: AcquisitionPolicy,
    exclude: { indexerId: string; releaseGuid: string } | null,
    signal?: AbortSignal,
  ): Promise<ReplacementChoice> {
    const media = mediaTargetOf(target);
    if (!media) return { kind: "none" };
    const result = await best(media, policy, exclude, signal);
    if (result.winner) {
      return {
        kind: "release",
        target,
        winner: result.winner,
        rejected: result.candidates,
      };
    }
    if (
      target.kind !== "season" ||
      target.season === undefined ||
      !target.itemId
    ) {
      return { kind: "none" };
    }

    const episodes = await episodesOf(target.itemId, target.season);
    const picks: Array<{ target: AcquisitionTarget; winner: Selected }> = [];
    const missing: number[] = [];
    for (const episode of episodes) {
      const episodeTarget: AcquisitionTarget = {
        kind: "episode",
        // The episode's own item. Two episodes sharing the series' id would
        // read as the same target, and starting one would retire the other's
        // failure (`supersedeFailedFor` matches on the item first).
        itemId: episode.itemId,
        title: target.title,
        ...(target.year === undefined ? {} : { year: target.year }),
        season: target.season,
        episode: episode.episode,
      };
      if (await repository.hasLiveAcquisitionFor(episodeTarget)) continue;
      const episodeResult = await best(
        mediaTargetOf(episodeTarget)!,
        policy,
        null,
        signal,
      );
      if (episodeResult.winner) {
        picks.push({ target: episodeTarget, winner: episodeResult.winner });
      } else {
        missing.push(episode.episode);
      }
    }
    return picks.length > 0
      ? { kind: "episodes", picks, missing }
      : { kind: "none" };
  }

  async function plan(
    target: AcquisitionTarget,
    winner: Selected,
    policy: AcquisitionPolicy,
    rejected: ReturnType<typeof selectRelease>["candidates"],
  ) {
    const created = await repository.create({
      target,
      indexerId: winner.release.indexerId,
      releaseGuid: winner.release.guid,
      releaseTitle: winner.release.title,
      origin: "fallback",
      evidence: {
        profileId: policy.profile.id,
        profileName: policy.profile.name,
        policySnapshot: {},
        releaseFacts: winner.facts,
        score: winner.score,
        reasons: winner.reasons,
        rejected: rejected
          .filter((candidate) => !candidate.accepted)
          .slice(0, 50)
          .map((candidate) => ({
            title: candidate.release.title,
            reason: candidate.rejection,
          })),
      },
    });
    const taskId = await queue.enqueue({
      jobType: submitJobType,
      payload: { acquisitionId: created.id },
      dedupeKey: `${submitJobType}:${created.id}`,
    });
    return { created, taskId };
  }

  /**
   * Replaces a failed acquisition with what `choose` found.
   *
   * Superseding the original is the claim: when two callers race, only the
   * one that moves the row out of `failed` creates anything. Returns null
   * when it lost that race.
   */
  async function apply(
    acquisitionId: string,
    choice: Exclude<ReplacementChoice, { kind: "none" }>,
    policy: AcquisitionPolicy,
  ): Promise<ReplacementResult | null> {
    const detail =
      choice.kind === "release"
        ? `Replaced by ${choice.winner.release.title}.`
        : `No other season pack; replaced by ${choice.picks.length} episode download${
            choice.picks.length === 1 ? "" : "s"
          }${
            choice.missing.length > 0
              ? ` (nothing acceptable for episode ${choice.missing.join(", ")})`
              : ""
          }.`;
    if (
      !(await repository.update(
        acquisitionId,
        "failed",
        { state: "superseded" },
        detail,
      ))
    ) {
      return null;
    }

    const created: AcquisitionSummary[] = [];
    const taskIds: string[] = [];
    if (choice.kind === "release") {
      const made = await plan(
        choice.target,
        choice.winner,
        policy,
        choice.rejected,
      );
      created.push(made.created);
      taskIds.push(made.taskId);
      await repository.supersedeFailedFor(made.created.id);
    } else {
      for (const pick of choice.picks) {
        const made = await plan(pick.target, pick.winner, policy, []);
        created.push(made.created);
        taskIds.push(made.taskId);
        await repository.supersedeFailedFor(made.created.id);
      }
    }
    return { created, taskIds };
  }

  return { choose, apply, policyFor: (id: string) => policies.load(id) };
}

export type AcquisitionFallback = ReturnType<typeof createAcquisitionFallback>;

/**
 * A season's episodes from the catalogue, in order.
 *
 * Only episodes the catalogue knows are searched for: guessing numbers past
 * the last known episode would fetch what the indexer happens to have, which
 * for a show still airing is a season that does not exist yet.
 */
export function createCatalogueEpisodeLookup(
  pool: DatabasePool,
): AcquisitionFallbackOptions["episodesOf"] {
  return async (seriesItemId, season) => {
    const result = await pool.query<{ id: string; index_number: number }>(
      `SELECT id, index_number FROM items
        WHERE series_id = $1 AND kind = 'episode'
          AND parent_index_number = $2 AND index_number IS NOT NULL
        ORDER BY index_number`,
      [seriesItemId, season],
    );
    return result.rows.map((row) => ({
      itemId: row.id,
      episode: row.index_number,
    }));
  };
}
