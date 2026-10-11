/**
 * Search, and say what would be chosen.
 *
 * The join between Phase 2's discovery and Phase 3's judgement. It still stops
 * short of acquiring anything: there is no route here that fetches an NZB or
 * hands one to a download client, and the decision it returns names a winner
 * without doing anything about it.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  optionalBodyStringArray,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import {
  IndexerError,
  type IndexerSearchQuery,
} from "../indexers/indexerTypes";
import type { IndexerSearchService } from "../indexers/searchService";
import {
  selectRelease,
  type CandidateDecision,
  type MediaTarget,
} from "./decide";
import { parseQualityId } from "./quality";
import { qualityLabel } from "./quality";
import type { PolicyRepository } from "./policyRepository";
import type { BlocklistRepository } from "./blocklistRepository";
import type { TmdbClient } from "../metadata/tmdbClient";
import type { AggregatedSearch } from "../indexers/searchService";
import {
  identityNames,
  indexerTerm,
  resolveTitleIdentity,
  type IdentityResolution,
  type TitleIdentity,
} from "./titleIdentity";

/** Above this a limit is a typo, not a policy: no release is a terabyte. */
const MAX_SIZE_LIMIT_BYTES = 1_000_000_000_000;

const BODY_KEYS = [
  "kind",
  "title",
  "year",
  "season",
  "episode",
  "profileId",
  "indexerIds",
  "limit",
  "currentQualityId",
  "currentFormatScore",
  "tmdbId",
] as const;

/**
 * What a decision looks like on the wire.
 *
 * Built from the release DTO rather than the release, so the credential-bearing
 * download URL has no path to a client here either — the same single
 * conversion that Phase 2 established, reused rather than re-implemented.
 */
interface DecisionDto {
  readonly guid: string;
  readonly indexerId: string;
  readonly title: string;
  readonly quality: string;
  readonly accepted: boolean;
  readonly rank: number | null;
  readonly score: number;
  readonly rejection?: string;
  readonly reasons: ReadonlyArray<{ code: string; detail: string }>;
  readonly sizeBytes?: number;
  readonly publishedAt?: string;
}

function toDecisionDto(decision: CandidateDecision): DecisionDto {
  return {
    guid: decision.release.guid,
    indexerId: decision.release.indexerId,
    title: decision.release.title,
    quality: qualityLabel(decision.quality),
    accepted: decision.accepted,
    rank: decision.rank,
    score: decision.score,
    ...(decision.rejection === undefined
      ? {}
      : { rejection: decision.rejection }),
    reasons: decision.reasons.map((reason) => ({
      code: reason.code,
      detail: reason.detail,
    })),
    ...(decision.release.sizeBytes === undefined
      ? {}
      : { sizeBytes: decision.release.sizeBytes }),
    ...(decision.release.publishedAtMs === undefined
      ? {}
      : {
          publishedAt: new Date(decision.release.publishedAtMs).toISOString(),
        }),
  };
}

function parseTarget(body: Record<string, unknown>): MediaTarget {
  const kind = optionalBodyString(body, "kind") ?? "movie";
  const title = requireBodyString(body, "title", { maxLength: 300 }).trim();
  if (!title) throw validationError("A title is required.");

  if (kind === "movie") {
    const year = optionalBodyInteger(body, "year", { min: 1870, max: 2200 });
    return { kind: "movie", title, ...(year === undefined ? {} : { year }) };
  }
  const season = optionalBodyInteger(body, "season", { min: 0, max: 10_000 });
  if (season === undefined) {
    throw validationError("A television target needs a season.");
  }
  if (kind === "season") return { kind: "season", title, season };
  if (kind === "episode") {
    const episode = optionalBodyInteger(body, "episode", {
      min: 0,
      max: 10_000,
    });
    if (episode === undefined) {
      throw validationError("An episode target needs an episode number.");
    }
    return { kind: "episode", title, season, episode };
  }
  throw validationError("The kind must be movie, season or episode.");
}

/**
 * The search that would find candidates for this target.
 *
 * The term is folded to plain words: an indexer given "Joker: Folie à Deux"
 * finds nothing that it finds for "Joker Folie a Deux". A title with no Latin
 * letters at all is sent as written, since folding would leave nothing.
 */
export function searchFor(
  target: MediaTarget,
  limit: number | undefined,
): IndexerSearchQuery {
  const base = {
    term: indexerTerm(target.title) || target.title,
    ...(limit === undefined ? {} : { limit }),
  };
  if (target.kind === "movie") return { kind: "movie", ...base };
  if (target.kind === "season") {
    return { kind: "tv", ...base, season: target.season };
  }
  return {
    kind: "tv",
    ...base,
    season: target.season,
    episode: target.episode,
  };
}

/**
 * The searches to try for a target, best first; the first that finds
 * anything is the one judged.
 *
 * A film with an IMDb id is asked for by that id, which no spelling can
 * miss. After it, each name the title goes by — English, then original, then
 * as typed — because which of them a release group used is not knowable in
 * advance, and most titles answer to the first.
 */
export function searchPlan(
  target: MediaTarget,
  identity: TitleIdentity | null,
  limit: number | undefined,
): IndexerSearchQuery[] {
  const plan: IndexerSearchQuery[] = [];
  if (target.kind === "movie" && identity?.imdbId) {
    plan.push({
      kind: "movie",
      imdbId: identity.imdbId,
      ...(limit === undefined ? {} : { limit }),
    });
  }
  const names = identity
    ? [identity.englishTitle, identity.originalTitle, target.title]
    : [target.title];
  const tried = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const key = (indexerTerm(name) || name).toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    plan.push(searchFor({ ...target, title: name }, limit));
  }
  return plan;
}

/** Where the identity came from never changes what the operator typed. */
function withIdentity(
  target: MediaTarget,
  identity: TitleIdentity | null,
): MediaTarget {
  if (!identity) return target;
  const aliases = identityNames(identity).filter(
    (name) => name !== target.title,
  );
  if (target.kind === "movie") {
    return {
      ...target,
      aliases,
      // A remake shares its title; the year is what tells them apart.
      ...(target.year === undefined && identity.year !== undefined
        ? { year: identity.year }
        : {}),
    };
  }
  return { ...target, aliases };
}

function searchedForDto(query: IndexerSearchQuery) {
  return query.imdbId ? { imdbId: query.imdbId } : { term: query.term ?? "" };
}

export interface CreateReleaseRoutesOptions {
  readonly search: IndexerSearchService;
  readonly policies: PolicyRepository;
  readonly blocklist: BlocklistRepository;
  /** Without it titles are searched exactly as typed, only folded. */
  readonly tmdb?: TmdbClient;
}

export function createReleaseRoutes({
  search,
  policies,
  blocklist,
  tmdb,
}: CreateReleaseRoutesOptions): RouteDefinition[] {
  /*
   * A TMDB outage must not take release search down with it: the words are
   * then searched as typed, which is what happened before TMDB was asked.
   * An explicit tmdbId is different — the operator chose that title, and a
   * search for something else would answer a question they did not ask.
   */
  async function resolve(
    target: MediaTarget,
    tmdbId: string | undefined,
  ): Promise<IdentityResolution> {
    const none = { identity: null, alternatives: [] };
    if (!tmdb) return none;
    const query = {
      kind: target.kind === "movie" ? ("movie" as const) : ("tv" as const),
      title: target.title,
      ...(target.kind === "movie" && target.year !== undefined
        ? { year: target.year }
        : {}),
      ...(tmdbId ? { tmdbId } : {}),
    };
    try {
      return await resolveTitleIdentity(tmdb, query);
    } catch {
      if (tmdbId) {
        throw new OwnApiError(
          "TITLE_NOT_RESOLVED",
          "TMDB could not describe the chosen title.",
          502,
        );
      }
      return none;
    }
  }

  return [
    {
      method: "GET",
      path: "/releases/profiles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          profiles: await policies.listProfiles(),
        });
      },
    },
    {
      /**
       * The largest release a profile accepts.
       *
       * The one part of a profile editable here, because it is the one part
       * that is a plain number: the qualities and preferences were migrated
       * and are edited where they came from.
       */
      method: "PATCH",
      path: "/releases/profiles/:profileId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const profileId = requireUuid(context.params.profileId, "profileId");
        const body = asObjectBody(await context.readJson(), ["maxSizeBytes"]);
        const raw = body.maxSizeBytes;
        if (
          raw !== null &&
          (!Number.isInteger(raw) ||
            (raw as number) < 1 ||
            (raw as number) > MAX_SIZE_LIMIT_BYTES)
        ) {
          throw validationError("maxSizeBytes is invalid.");
        }
        const maxSizeBytes = raw as number | null;
        if (!(await policies.setMaxSize(profileId, maxSizeBytes))) {
          throw new OwnApiError(
            "PROFILE_NOT_FOUND",
            "No such quality profile.",
            404,
          );
        }
        sendData(context.response, context.requestId, {
          profile: { id: profileId, maxSizeBytes },
        });
      },
    },
    {
      method: "GET",
      path: "/releases/blocklist",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        // The guid is left out: some indexers put a download URL in it.
        sendData(context.response, context.requestId, {
          entries: (await blocklist.list()).map((entry) => ({
            id: entry.id,
            indexerId: entry.indexerId,
            releaseTitle: entry.releaseTitle,
            ...(entry.targetTitle ? { targetTitle: entry.targetTitle } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
            createdAt: new Date(entry.createdAtMs).toISOString(),
          })),
        });
      },
    },
    {
      method: "DELETE",
      path: "/releases/blocklist/:entryId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.entryId, "entryId");
        if (!(await blocklist.remove(id))) {
          throw new OwnApiError("NOT_FOUND", "No such blocklist entry.", 404);
        }
        sendNoContent(context.response);
      },
    },
    {
      /**
       * Search for a target and judge everything found.
       *
       * Named `evaluate` rather than `grab` deliberately: it answers "what
       * would be chosen", and choosing is as far as this phase goes.
       */
      method: "POST",
      path: "/releases/evaluate",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), BODY_KEYS);
        const typed = parseTarget(body);
        const tmdbId = optionalBodyString(body, "tmdbId", { maxLength: 16 });
        if (tmdbId !== undefined && !/^\d{1,12}$/.test(tmdbId)) {
          throw validationError("The tmdbId is not a TMDB identifier.");
        }
        const profileId = requireBodyString(body, "profileId", {
          maxLength: 64,
        });
        const indexerIds = optionalBodyStringArray(body, "indexerIds");
        const limit = optionalBodyInteger(body, "limit", { min: 1, max: 200 });

        const policy = await policies.load(profileId);
        if (!policy) {
          throw new OwnApiError(
            "PROFILE_NOT_FOUND",
            "No such quality profile.",
            404,
          );
        }

        const currentQualityId = optionalBodyString(body, "currentQualityId", {
          maxLength: 64,
        });
        const currentQuality =
          currentQualityId === undefined
            ? undefined
            : parseQualityId(currentQualityId);
        if (currentQualityId !== undefined && !currentQuality) {
          throw validationError("The currentQualityId is not a quality.");
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        context.request.once("aborted", abort);
        context.request.once("close", abort);
        try {
          const resolution = await resolve(typed, tmdbId);
          const target = withIdentity(typed, resolution.identity);
          const plan = searchPlan(target, resolution.identity, limit);
          let found: AggregatedSearch | undefined;
          let searchedFor = plan[0]!;
          for (const query of plan) {
            searchedFor = query;
            found = await search.search(query, {
              ...(indexerIds?.length ? { indexerIds } : {}),
              signal: controller.signal,
            });
            if (found.releases.length > 0) break;
          }
          if (!found) throw new Error("A search plan is never empty.");
          const isBlocklisted = await blocklist.matcherFor(found.releases);
          const result = selectRelease(target, found.releases, {
            profile: policy.profile,
            preferences: policy.preferences,
            isBlocklisted,
            current: currentQuality
              ? {
                  quality: currentQuality,
                  formatScore:
                    optionalBodyInteger(body, "currentFormatScore", {
                      min: -100_000,
                      max: 100_000,
                    }) ?? 0,
                }
              : null,
          });

          sendData(context.response, context.requestId, {
            target,
            resolved: resolution.identity,
            alternatives: resolution.alternatives,
            searchedFor: searchedForDto(searchedFor),
            profile: { id: policy.profile.id, name: policy.profile.name },
            indexers: found.outcomes,
            partial: found.partial,
            candidates: result.candidates.map(toDecisionDto),
            // The whole point, and still only a statement: nothing is fetched.
            winner:
              result.winner === undefined ? null : toDecisionDto(result.winner),
          });
        } catch (error) {
          if (error instanceof IndexerError) {
            throw new OwnApiError(
              "INDEXER_UNAVAILABLE",
              error.message,
              error.kind === "auth" ? 502 : 503,
            );
          }
          throw error;
        } finally {
          context.request.off("aborted", abort);
          context.request.off("close", abort);
        }
      },
    },
  ];
}
