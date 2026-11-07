/**
 * Choosing what replaces a release that cannot be downloaded.
 *
 * Two callers share this. An operator presses "blocklist and search again",
 * and the reconciler asks for it on its own when SABnzbd reports a release
 * that will never complete (missing articles, a failed repair). Either way
 * the replacement is what the original decision would have chosen without
 * the failed release in it: the same target, the same quality profile.
 *
 * A pack adds steps. Older shows are often only posted season by season or
 * episode by episode, so a whole series falls back to its seasons and a
 * season to its episodes. When the series' missing episodes can be read
 * (`missingPlanOf`), that step down is the missing-episode search, queued:
 * it takes one indexer search per episode, longer than a request or a
 * replacement job should wait. Without it, a season is replaced by each
 * episode the catalogue knows of, chosen here.
 */
import type { DatabasePool } from "../database/databasePool";
import type { JobQueue } from "../tasks/jobQueue";
import type { IndexerSearchService } from "../indexers/searchService";
import type { IndexerRelease } from "../indexers/indexerTypes";
import { selectRelease, type MediaTarget } from "../releases/decide";
import {
  runSearchPlan,
  searchPlan,
  withIdentity,
} from "../releases/releaseRoutes";
import {
  resolveTitleIdentity,
  type TitleIdentity,
} from "../releases/titleIdentity";
import type { TmdbClient } from "../metadata/tmdbClient";
import {
  MISSING_SEARCH_JOB_TYPE,
  countMissing,
  missingSearchDedupeKey,
} from "./missingEpisodes";
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
  /**
   * What a series, or one season of it, is missing: the plan the
   * missing-episode search runs. Null when the item is not a series.
   */
  readonly missingPlanOf?: (
    seriesItemId: string,
    season?: number,
  ) => Promise<MissingEpisodePlan | null>;
  /**
   * What TMDB says the title is: its original and English names and, for a
   * film, its IMDb id. Catalogue titles are Turkish, and releases are never
   * posted under them, so without this a search by itself finds nothing.
   * Null, or absent, searches the target's own title as before.
   */
  readonly identify?: (query: TitleQuery) => Promise<TitleIdentity | null>;
}

/** The title a search is for: a film, or the series an episode belongs to. */
export interface TitleQuery {
  readonly kind: "movie" | "tv";
  readonly title: string;
  readonly year?: number;
  /** The film, series or episode item; the series' identity is used for an episode. */
  readonly itemId?: string;
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
  | {
      /** No other pack: the missing-episode search takes over from here. */
      readonly kind: "missing";
      readonly seriesItemId: string;
      /** Absent for a whole series. */
      readonly season?: number;
    }
  | { readonly kind: "none" };

/**
 * A series' missing episodes, grouped by season: what the season strip
 * shows red, and nothing already held or on its way.
 */
export interface MissingEpisodePlan {
  readonly seriesItemId: string;
  readonly title: string;
  readonly year?: number;
  /**
   * Nothing of any aired season is held or coming, so one release of the
   * whole series is asked for before any season.
   */
  readonly complete?: boolean;
  readonly seasons: ReadonlyArray<{
    readonly season: number;
    /** Nothing of the season is held or coming, so a pack is asked for first. */
    readonly whole: boolean;
    readonly episodes: ReadonlyArray<{
      readonly episode: number;
      /** The episode's own item, or the series' when it has none yet. */
      readonly itemId: string;
    }>;
  }>;
}

export interface MissingSearchResult {
  /** A null episode is a season pack; a null season, the whole series. */
  readonly started: Array<{
    season: number | null;
    episode: number | null;
    release: string;
  }>;
  /** Searched, and nothing acceptable under the quality profile. */
  readonly nothing: Array<{ season: number; episode: number }>;
  /**
   * Not searched: a download of it is already under way. A null episode is
   * a season; a null season, the whole series.
   */
  readonly covered: Array<{ season: number | null; episode: number | null }>;
}

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
  if (target.kind === "series") return { kind: "series", title: target.title };
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
  missingPlanOf,
  identify,
}: AcquisitionFallbackOptions) {
  /** Never fails a search: without an identity the title is searched as held. */
  async function identityOf(query: TitleQuery): Promise<TitleIdentity | null> {
    if (!identify) return null;
    try {
      return await identify(query);
    } catch {
      return null;
    }
  }

  function titleQueryOf(target: AcquisitionTarget): TitleQuery {
    return {
      kind: target.kind === "movie" ? "movie" : "tv",
      title: target.title,
      ...(target.year === undefined ? {} : { year: target.year }),
      ...(target.itemId ? { itemId: target.itemId } : {}),
    };
  }

  async function best(
    typed: MediaTarget,
    policy: AcquisitionPolicy,
    exclude: { indexerId: string; releaseGuid: string } | null,
    identity: TitleIdentity | null,
    signal?: AbortSignal,
  ) {
    const target = withIdentity(typed, identity);
    const { found } = await runSearchPlan(
      search,
      target,
      searchPlan(target, identity, undefined),
      signal ? { signal } : {},
    );
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

  /** The seasons a whole-series release must hold: every one still missing. */
  async function seasonsMissing(
    seriesItemId: string,
  ): Promise<{ seasons?: number[] }> {
    const plan = await missingPlanOf?.(seriesItemId);
    return plan && plan.seasons.length > 0
      ? { seasons: plan.seasons.map((entry) => entry.season) }
      : {};
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
    /** Skip another release of the same kind and go straight a step down. */
    { stepDownOnly = false }: { stepDownOnly?: boolean } = {},
  ): Promise<ReplacementChoice> {
    const media = mediaTargetOf(target);
    if (!media) return { kind: "none" };
    const identity = await identityOf(titleQueryOf(target));
    if (!stepDownOnly) {
      const result = await best(
        media.kind === "series" && target.itemId
          ? { ...media, ...(await seasonsMissing(target.itemId)) }
          : media,
        policy,
        exclude,
        identity,
        signal,
      );
      if (result.winner) {
        return {
          kind: "release",
          target,
          winner: result.winner,
          rejected: result.candidates,
        };
      }
    }
    if (
      (target.kind === "season" || target.kind === "series") &&
      target.itemId &&
      missingPlanOf
    ) {
      return {
        kind: "missing",
        seriesItemId: target.itemId,
        ...(target.kind === "season" && target.season !== undefined
          ? { season: target.season }
          : {}),
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
    const { picks, missing } = await chooseEpisodes(
      target,
      target.season,
      episodes,
      policy,
      identity,
      signal,
    );
    return picks.length > 0
      ? { kind: "episodes", picks, missing }
      : { kind: "none" };
  }

  /**
   * The best release for each episode, searched one at a time.
   *
   * An episode already downloading is skipped rather than searched, so a
   * second pass over the same season starts nothing twice.
   */
  async function chooseEpisodes(
    series: Pick<AcquisitionTarget, "title" | "year">,
    season: number,
    episodes: ReadonlyArray<{
      readonly itemId?: string;
      readonly episode: number;
    }>,
    policy: AcquisitionPolicy,
    identity: TitleIdentity | null,
    signal?: AbortSignal,
  ) {
    const picks: Array<{ target: AcquisitionTarget; winner: Selected }> = [];
    const missing: number[] = [];
    /** Skipped because a download of them is already under way. */
    const covered: number[] = [];
    for (const episode of episodes) {
      const episodeTarget: AcquisitionTarget = {
        kind: "episode",
        // The episode's own item, or its series' when the catalogue has no
        // row for it yet. The matching compares season and episode as well,
        // so episodes that share their series' id stay apart.
        ...(episode.itemId ? { itemId: episode.itemId } : {}),
        title: series.title,
        ...(series.year === undefined ? {} : { year: series.year }),
        season,
        episode: episode.episode,
      };
      if (await repository.hasLiveAcquisitionFor(episodeTarget)) {
        covered.push(episode.episode);
        continue;
      }
      const episodeResult = await best(
        mediaTargetOf(episodeTarget)!,
        policy,
        null,
        identity,
        signal,
      );
      if (episodeResult.winner) {
        picks.push({ target: episodeTarget, winner: episodeResult.winner });
      } else {
        missing.push(episode.episode);
      }
    }
    return { picks, missing, covered };
  }

  async function plan(
    target: AcquisitionTarget,
    winner: Selected,
    policy: AcquisitionPolicy,
    rejected: ReturnType<typeof selectRelease>["candidates"],
    origin: "fallback" | "automatic" = "fallback",
  ) {
    const created = await repository.create({
      target,
      indexerId: winner.release.indexerId,
      releaseGuid: winner.release.guid,
      releaseTitle: winner.release.title,
      origin,
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
   * Queues the missing-episode search for a series, or one season of it.
   * Null when nothing is missing any more, so there is nothing to search.
   */
  async function searchMissingLater(
    seriesItemId: string,
    season: number | undefined,
    policy: AcquisitionPolicy,
  ): Promise<string | null> {
    const plan = await missingPlanOf?.(seriesItemId, season);
    if (!plan || countMissing(plan) === 0) return null;
    return queue.enqueue({
      jobType: MISSING_SEARCH_JOB_TYPE,
      payload: { plan, profileId: policy.profile.id },
      // Not the key a press of the button uses: that search may be the one
      // still running, and folding this into it would lose the new plan.
      dedupeKey: `${missingSearchDedupeKey(seriesItemId, season)}:fallback`,
    });
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
        : choice.kind === "missing"
          ? choice.season === undefined
            ? "No other release of the whole series; searching season by season, then episode by episode."
            : "No other season pack; searching episode by episode."
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
    } else if (choice.kind === "missing") {
      // Planned now that the failed pack is superseded, so every episode it
      // was to bring reads as missing again.
      const taskId = await searchMissingLater(
        choice.seriesItemId,
        choice.season,
        policy,
      );
      if (taskId) taskIds.push(taskId);
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

  /**
   * Searches for each missing episode and starts the best release found.
   *
   * Biggest first. A series with nothing held asks for one release of every
   * season; failing that, a season with nothing held asks for its pack, as a
   * search by hand would; any other season, or one with no pack, is searched
   * episode by episode, so what is already held is never fetched again. A
   * pack already on its way covers its episodes, and they are left alone.
   */
  async function acquireMissing(
    missingPlan: MissingEpisodePlan,
    policy: AcquisitionPolicy,
    onSeason?: (season: number, index: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<MissingSearchResult> {
    const series = {
      title: missingPlan.title,
      ...(missingPlan.year === undefined ? {} : { year: missingPlan.year }),
    };
    const started: MissingSearchResult["started"] = [];
    const nothing: MissingSearchResult["nothing"] = [];
    const covered: MissingSearchResult["covered"] = [];
    // One identity for the whole series: every episode is posted under it.
    const identity = await identityOf({
      kind: "tv",
      ...series,
      itemId: missingPlan.seriesItemId,
    });

    if (missingPlan.complete && missingPlan.seasons.length > 1) {
      const seriesTarget: AcquisitionTarget = {
        kind: "series",
        itemId: missingPlan.seriesItemId,
        ...series,
      };
      if (await repository.hasLiveAcquisitionFor(seriesTarget)) {
        return {
          started,
          nothing,
          covered: [{ season: null, episode: null }],
        };
      }
      const whole = await best(
        {
          kind: "series",
          title: missingPlan.title,
          seasons: missingPlan.seasons.map((entry) => entry.season),
        },
        policy,
        null,
        identity,
        signal,
      );
      if (whole.winner) {
        const made = await plan(
          seriesTarget,
          whole.winner,
          policy,
          whole.candidates,
          "automatic",
        );
        await repository.supersedeFailedFor(made.created.id);
        return {
          started: [
            {
              season: null,
              episode: null,
              release: whole.winner.release.title,
            },
          ],
          nothing,
          covered,
        };
      }
    }

    for (const [
      index,
      { season, whole, episodes },
    ] of missingPlan.seasons.entries()) {
      await onSeason?.(season, index);
      const seasonTarget: AcquisitionTarget = {
        kind: "season",
        itemId: missingPlan.seriesItemId,
        ...series,
        season,
      };
      if (await repository.hasLiveAcquisitionFor(seasonTarget)) {
        covered.push({ season, episode: null });
        continue;
      }
      if (whole) {
        const pack = await best(
          mediaTargetOf(seasonTarget)!,
          policy,
          null,
          identity,
          signal,
        );
        if (pack.winner) {
          const made = await plan(
            seasonTarget,
            pack.winner,
            policy,
            pack.candidates,
            "automatic",
          );
          await repository.supersedeFailedFor(made.created.id);
          started.push({
            season,
            episode: null,
            release: pack.winner.release.title,
          });
          continue;
        }
      }
      const {
        picks,
        missing,
        covered: coming,
      } = await chooseEpisodes(
        series,
        season,
        episodes,
        policy,
        identity,
        signal,
      );
      for (const pick of picks) {
        const made = await plan(
          pick.target,
          pick.winner,
          policy,
          [],
          "automatic",
        );
        await repository.supersedeFailedFor(made.created.id);
        started.push({
          season,
          episode: pick.target.episode ?? null,
          release: pick.winner.release.title,
        });
      }
      nothing.push(...missing.map((episode) => ({ season, episode })));
      covered.push(...coming.map((episode) => ({ season, episode })));
    }
    return { started, nothing, covered };
  }

  return {
    choose,
    apply,
    acquireMissing,
    policyFor: (id: string) => policies.load(id),
  };
}

export type AcquisitionFallback = ReturnType<typeof createAcquisitionFallback>;

/**
 * What TMDB says a catalogue title is.
 *
 * The item's own TMDB id where the catalogue holds one — the series' for an
 * episode, whose own id is an episode's — so the answer is the title that was
 * linked, not the nearest match to its Turkish name. Without an id the title
 * is resolved by its words, as the release search page does.
 */
export function createCatalogueTitleIdentifier(
  pool: DatabasePool,
  tmdb: TmdbClient,
): NonNullable<AcquisitionFallbackOptions["identify"]> {
  return async (query) => {
    const tmdbId = query.itemId
      ? (
          await pool.query<{ tmdb: string | null }>(
            `SELECT COALESCE(series.provider_ids->>'tmdb', item.provider_ids->>'tmdb') AS tmdb
               FROM items item LEFT JOIN items series ON series.id = item.series_id
              WHERE item.id::text = $1`,
            [query.itemId],
          )
        ).rows[0]?.tmdb
      : null;
    const { identity } = await resolveTitleIdentity(tmdb, {
      kind: query.kind,
      title: query.title,
      ...(query.year === undefined ? {} : { year: query.year }),
      ...(tmdbId ? { tmdbId } : {}),
    });
    return identity;
  };
}

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
