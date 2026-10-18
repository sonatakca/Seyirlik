/**
 * Acquisitions over HTTP.
 *
 * A caller names a target and a release the search already returned — never a
 * URL. The URL that fetches an NZB carries the provider's key, and an endpoint
 * that accepted one would be an endpoint that fetches anything a client asks
 * for, on the server's network, with the server's credentials.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  optionalBodyInteger,
  optionalBodyString,
  parseLimit,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import { ACQUISITION_JOB_TYPES } from "./acquisitionJobs";
import {
  createAcquisitionFallback,
  mediaTargetOf,
  type AcquisitionFallbackOptions,
} from "./acquisitionFallback";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
} from "./acquisitionRepository";
import {
  BLOCKLISTABLE_STATES,
  type AcquisitionService,
} from "./acquisitionService";
import type { IndexerRegistry } from "../indexers/indexerRegistry";
import type { SabJob, SabnzbdClient } from "./sabnzbd";
import { SabError } from "./sabnzbd";
import { IndexerError } from "../indexers/indexerTypes";
import type { IndexerSearchService } from "../indexers/searchService";
import type { PolicyRepository } from "../releases/policyRepository";
import type { BlocklistRepository } from "../releases/blocklistRepository";

const CREATE_KEYS = [
  "kind",
  "title",
  "year",
  "season",
  "episode",
  "itemId",
  "indexerId",
  "releaseGuid",
  "releaseTitle",
  "profileId",
  "profileName",
  "score",
  "reasons",
] as const;

/**
 * One queued submission per acquisition.
 *
 * The queue collapses this onto a job that is queued or already running, so
 * asking twice cannot put the same release in front of two workers. It does
 * not collapse onto a finished job, which is what leaves a retry free to run.
 */
function submitDedupeKey(acquisitionId: string): string {
  return `acquisition.submit:${acquisitionId}`;
}

interface AcquisitionDto {
  readonly id: string;
  readonly state: string;
  readonly origin: string;
  readonly target: { kind: string; title: string };
  readonly indexerId: string;
  readonly releaseTitle: string;
  readonly attempt: number;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly sizeBytes?: number;
  /** Whether this release is on the blocklist, whichever row put it there. */
  readonly releaseBlocklisted?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The wire shape.
 *
 * Carries neither the release's download URL nor SABnzbd's job identifier: the
 * first is credential-bearing and the second is an internal handle a client
 * has no use for and could otherwise quote back at a cancellation.
 *
 * Nor the download path. It names a directory on the operator's disk, and
 * neither a list of acquisitions nor one acquisition's history has any use for
 * it — so carrying it there disclosed a filesystem layout to nobody's benefit.
 * The one endpoint whose whole purpose is that handoff says so itself.
 */
function toDto(
  summary: AcquisitionSummary,
  releaseBlocklisted = false,
): AcquisitionDto {
  return {
    id: summary.id,
    state: summary.state,
    origin: summary.origin,
    target: { kind: summary.targetKind, title: summary.targetTitle },
    indexerId: summary.indexerId,
    releaseTitle: summary.releaseTitle,
    attempt: summary.attempt,
    ...(summary.failureClass ? { failureClass: summary.failureClass } : {}),
    ...(summary.failureDetail ? { failureDetail: summary.failureDetail } : {}),
    ...(summary.sizeBytes === undefined
      ? {}
      : { sizeBytes: summary.sizeBytes }),
    ...(releaseBlocklisted ? { releaseBlocklisted: true } : {}),
    createdAt: new Date(summary.createdAtMs).toISOString(),
    updatedAt: new Date(summary.updatedAtMs).toISOString(),
  };
}

/** How the blocklist names a release, from an acquisition row. */
function releaseOf(summary: AcquisitionSummary) {
  return {
    indexerId: summary.indexerId,
    guid: summary.releaseGuid,
    title: summary.releaseTitle,
  };
}

/** One running acquisition, as SABnzbd currently sees it. */
interface ProgressDto {
  readonly acquisitionId: string;
  readonly stage:
    | "queued"
    | "paused"
    | "downloading"
    | "processing"
    | "done"
    | "failed";
  /** SABnzbd's own word: "Downloading", "Repairing", "Extracting"… */
  readonly statusText?: string;
  readonly percent?: number;
  readonly totalBytes?: number;
  readonly downloadedBytes?: number;
  readonly speedBytesPerSecond?: number;
  readonly etaSeconds?: number;
  /** 1 is next. Only while waiting. */
  readonly queuePosition?: number;
  /** The post-processing step, as SABnzbd words it. */
  readonly detail?: string;
}

function progressOf(
  acquisitionId: string,
  job: SabJob,
  speedBytesPerSecond: number | undefined,
  queuePaused: boolean,
): ProgressDto {
  // A queue-wide pause stops waiting and downloading jobs, while history
  // post-processing can still run. SABnzbd leaves slot statuses unchanged.
  const paused =
    job.state === "paused" ||
    (queuePaused &&
      job.source === "queue" &&
      (job.state === "queued" || job.state === "downloading"));
  const stage: ProgressDto["stage"] =
    job.state === "completed"
      ? "done"
      : job.state === "failed"
        ? "failed"
        : paused
          ? "paused"
          : job.state === "queued"
            ? "queued"
            : job.state === "processing"
              ? "processing"
              : "downloading";
  const total = job.sizeBytes;
  const downloaded =
    total === undefined
      ? undefined
      : job.remainingBytes !== undefined
        ? Math.max(0, total - job.remainingBytes)
        : job.percentage !== undefined
          ? Math.round((total * job.percentage) / 100)
          : undefined;
  const percent =
    total && downloaded !== undefined
      ? Math.min(100, (downloaded / total) * 100)
      : job.percentage;
  return {
    acquisitionId,
    stage,
    ...(job.statusText ? { statusText: job.statusText } : {}),
    ...(percent === undefined
      ? {}
      : { percent: Math.round(percent * 10) / 10 }),
    ...(total === undefined ? {} : { totalBytes: total }),
    ...(downloaded === undefined ? {} : { downloadedBytes: downloaded }),
    ...(stage === "downloading" && speedBytesPerSecond
      ? { speedBytesPerSecond }
      : {}),
    ...(stage === "downloading" && job.timeLeftSeconds !== undefined
      ? { etaSeconds: job.timeLeftSeconds }
      : {}),
    ...(stage === "queued" && job.queuePosition !== undefined
      ? { queuePosition: job.queuePosition + 1 }
      : {}),
    ...(job.actionLine ? { detail: job.actionLine } : {}),
  };
}

/** The decision engine's view of what an acquisition was for. */
export interface CreateAcquisitionRoutesOptions {
  readonly repository: AcquisitionRepository;
  readonly service: AcquisitionService;
  readonly indexers: IndexerRegistry;
  readonly queue: JobQueue;
  readonly sab: SabnzbdClient;
  readonly search: IndexerSearchService;
  readonly policies: PolicyRepository;
  readonly blocklist: BlocklistRepository;
  /**
   * The episodes of a series' season, for replacing a season pack episode by
   * episode. Without it a season with no other pack stays failed.
   */
  readonly episodesOf?: AcquisitionFallbackOptions["episodesOf"];
}

export function createAcquisitionRoutes({
  repository,
  service,
  indexers,
  queue,
  sab,
  search,
  policies,
  blocklist,
  episodesOf = async () => [],
}: CreateAcquisitionRoutesOptions): RouteDefinition[] {
  const fallback = createAcquisitionFallback({
    repository,
    search,
    policies,
    blocklist,
    queue,
    episodesOf,
    submitJobType: ACQUISITION_JOB_TYPES.submit,
  });
  return [
    {
      method: "GET",
      path: "/acquisitions",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"));
        const rows = await repository.list(limit);
        const isBlocklisted = await blocklist.matcherFor(rows.map(releaseOf));
        sendData(context.response, context.requestId, {
          acquisitions: rows.map((row) =>
            toDto(row, isBlocklisted(releaseOf(row))),
          ),
        });
      },
    },
    {
      /**
       * How far each running download has got, read from SABnzbd now.
       *
       * Live rather than stored: the reconciler writes state every thirty
       * seconds, which is right for "what is it doing" and far too coarse for
       * a progress bar. One queue read and one history read answer it for
       * every acquisition at once.
       *
       * An unreachable SABnzbd is reported as such, not as an error: the
       * acquisitions themselves are still listed from the database.
       */
      method: "GET",
      path: "/acquisitions/progress",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const active = await repository.listActive();
        if (active.length === 0) {
          sendData(context.response, context.requestId, {
            reachable: true,
            paused: false,
            progress: [],
          });
          return;
        }
        let queue;
        let history: SabJob[];
        try {
          [queue, history] = await Promise.all([
            sab.queueSnapshot(),
            sab.listHistory(50),
          ]);
        } catch {
          sendData(context.response, context.requestId, {
            reachable: false,
            paused: false,
            progress: [],
          });
          return;
        }

        // Queue first: a job present in both is still running.
        const byId = new Map<string, SabJob>();
        const byName = new Map<string, SabJob>();
        for (const job of [...history, ...queue.jobs]) {
          byId.set(job.nzoId, job);
          if (job.name) byName.set(job.name, job);
        }
        /*
         * SABnzbd gives one speed for the whole queue. It belongs to the job
         * actually moving, which is the first one downloading, and to no
         * other — attributing it to every row would invent several speeds.
         */
        const moving = queue.paused
          ? undefined
          : queue.jobs
              .filter((job) => job.state === "downloading")
              .sort(
                (a, b) =>
                  (a.queuePosition ?? Infinity) - (b.queuePosition ?? Infinity),
              )[0];

        const progress: ProgressDto[] = [];
        for (const record of active) {
          const job =
            (record.externalId ? byId.get(record.externalId) : undefined) ??
            byName.get(record.idempotencyKey);
          if (!job) continue;
          progress.push(
            progressOf(
              record.id,
              job,
              job === moving ? queue.speedBytesPerSecond : undefined,
              queue.paused,
            ),
          );
        }
        sendData(context.response, context.requestId, {
          reachable: true,
          paused: queue.paused,
          ...(queue.paused || queue.speedBytesPerSecond === undefined
            ? {}
            : { speedBytesPerSecond: queue.speedBytesPerSecond }),
          progress,
        });
      },
    },
    {
      method: "GET",
      path: "/acquisitions/:acquisitionId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const detail = await repository.detail(id);
        if (!detail) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        sendData(context.response, context.requestId, {
          acquisition: toDto(detail.acquisition),
          /*
           * Why this release, in the words the decision engine used at the
           * time. Without it an operator can see that a download happened and
           * not why it was this release rather than another one.
           */
          decision: detail.decision
            ? {
                profileName: detail.decision.profileName,
                score: detail.decision.score,
                reasons: detail.decision.reasons,
                rejected: detail.decision.rejected,
                decidedAt: new Date(detail.decision.decidedAtMs).toISOString(),
              }
            : null,
          // The audit trail: every state it passed through, and why.
          events: detail.events.map((event) => ({
            fromState: event.fromState,
            toState: event.toState,
            ...(event.failureClass ? { failureClass: event.failureClass } : {}),
            ...(event.detail ? { detail: event.detail } : {}),
            at: new Date(event.atMs).toISOString(),
          })),
        });
      },
    },
    {
      /**
       * The handoff the import phase reads. Nothing here acts on it.
       *
       * The only place the download path is published, because it is the only
       * place it is the point. Admin-only, like everything else here.
       */
      method: "GET",
      path: "/acquisitions/ready-for-import",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          ready: (await repository.listReadyForImport()).map((summary) => ({
            ...toDto(summary),
            ...(summary.downloadPath
              ? { downloadPath: summary.downloadPath }
              : {}),
          })),
        });
      },
    },
    {
      method: "POST",
      path: "/acquisitions",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), CREATE_KEYS);

        const kind = optionalBodyString(body, "kind") ?? "movie";
        if (kind !== "movie" && kind !== "season" && kind !== "episode") {
          throw validationError("The kind must be movie, season or episode.");
        }
        const title = requireBodyString(body, "title", {
          maxLength: 500,
        }).trim();
        if (!title) throw validationError("A title is required.");
        const indexerId = requireBodyString(body, "indexerId", {
          maxLength: 64,
        });
        // Only a configured indexer. A client cannot name somewhere else to
        // fetch from, which is the point of taking an id rather than a URL.
        if (!indexers.get(indexerId)) {
          throw validationError("That indexer is not configured.");
        }
        const releaseGuid = requireBodyString(body, "releaseGuid", {
          maxLength: 500,
        });
        const releaseTitle = requireBodyString(body, "releaseTitle", {
          maxLength: 500,
        });

        const itemId = optionalBodyString(body, "itemId", { maxLength: 64 });
        const season = optionalBodyInteger(body, "season", {
          min: 0,
          max: 10_000,
        });
        const episode = optionalBodyInteger(body, "episode", {
          min: 0,
          max: 10_000,
        });
        const year = optionalBodyInteger(body, "year", {
          min: 1870,
          max: 2200,
        });
        if (kind !== "movie" && season === undefined) {
          throw validationError("A television acquisition needs a season.");
        }

        const acquisition = await repository.create({
          target: {
            kind,
            title,
            ...(itemId ? { itemId } : {}),
            ...(year === undefined ? {} : { year }),
            ...(season === undefined ? {} : { season }),
            ...(episode === undefined ? {} : { episode }),
          },
          indexerId,
          releaseGuid,
          releaseTitle,
          origin: "manual",
          evidence: {
            ...(optionalBodyString(body, "profileId", { maxLength: 64 })
              ? { profileId: optionalBodyString(body, "profileId")! }
              : {}),
            profileName:
              optionalBodyString(body, "profileName", { maxLength: 200 }) ??
              "Chosen by hand",
            policySnapshot: {},
            releaseFacts: {},
            score:
              optionalBodyInteger(body, "score", {
                min: -1_000_000,
                max: 1_000_000,
              }) ?? 0,
            reasons: body.reasons ?? [],
            rejected: [],
          },
        });

        await repository.supersedeFailedFor(acquisition.id);

        /*
         * The work happens on the durable queue, so it survives a restart of
         * whichever process happens to be serving this request. The key is the
         * acquisition itself: a double-clicked button queues one submission,
         * and the caller is handed the id of the job that already exists.
         */
        const taskId = await queue.enqueue({
          jobType: ACQUISITION_JOB_TYPES.submit,
          payload: { acquisitionId: acquisition.id },
          dedupeKey: submitDedupeKey(acquisition.id),
        });
        sendData(
          context.response,
          context.requestId,
          { acquisition: toDto(acquisition), taskId },
          202,
        );
      },
    },
    {
      method: "POST",
      path: "/acquisitions/:acquisitionId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const existing = await repository.get(id);
        if (!existing) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        try {
          // The service removes only the job this acquisition owns; a client
          // never names a SABnzbd identifier, so it cannot reach another one.
          await service.cancel(id);
        } catch (error) {
          throw new OwnApiError(
            "ACQUISITION_COMPLETED",
            error instanceof Error ? error.message : "It cannot be cancelled.",
            409,
          );
        }
        sendNoContent(context.response);
      },
    },
    {
      method: "POST",
      path: "/acquisitions/:acquisitionId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const existing = await repository.get(id);
        if (!existing) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        if (existing.state !== "failed") {
          throw new OwnApiError(
            "ACQUISITION_NOT_RETRYABLE",
            `An acquisition in ${existing.state} cannot be retried.`,
            409,
          );
        }
        const isBlocklisted = await blocklist.matcherFor([releaseOf(existing)]);
        if (
          existing.failureClass === "blocklisted" ||
          isBlocklisted(releaseOf(existing))
        ) {
          // Trying it again is exactly what the blocklist is there to stop.
          throw new OwnApiError(
            "ACQUISITION_NOT_RETRYABLE",
            "This release is blocklisted; search again for another.",
            409,
          );
        }
        await repository.update(
          id,
          "failed",
          { state: "awaiting_retry", retryAfterMs: null },
          "Retried by hand.",
        );
        const taskId = await queue.enqueue({
          jobType: ACQUISITION_JOB_TYPES.submit,
          payload: { acquisitionId: id },
          dedupeKey: submitDedupeKey(id),
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },
    {
      /**
       * Never this release again — and, if asked, the next best one instead.
       *
       * The release goes on the blocklist first, so whatever happens after,
       * no search recommends it again. Then the download stops, and only then
       * is the search repeated: with the profile the original was chosen
       * against, for the target it was for, so the replacement is the answer
       * the first decision would have given without this release in it.
       *
       * A search that fails leaves the acquisition failed and blocklisted,
       * which is the honest state, and asking again repeats only the search.
       */
      method: "POST",
      path: "/acquisitions/:acquisitionId/blocklist",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const body = asObjectBody(await context.readJson(), ["searchAgain"]);
        const searchAgain = optionalBodyBoolean(body, "searchAgain") ?? false;

        const existing = await repository.get(id);
        const searchContext = await repository.searchContext(id);
        if (!existing || !searchContext) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        if (!BLOCKLISTABLE_STATES.includes(existing.state)) {
          throw new OwnApiError(
            "ACQUISITION_NOT_BLOCKLISTABLE",
            `An acquisition in ${existing.state} cannot be blocklisted.`,
            409,
          );
        }

        await blocklist.add({
          indexerId: existing.indexerId,
          releaseGuid: existing.releaseGuid,
          releaseTitle: existing.releaseTitle,
          targetKind: existing.targetKind,
          targetTitle: existing.targetTitle,
          ...(existing.failureClass ? { reason: existing.failureClass } : {}),
          acquisitionId: id,
        });

        let stopped: boolean;
        try {
          stopped = await service.blocklist(id);
        } catch (error) {
          throw new OwnApiError(
            "ACQUISITION_NOT_BLOCKLISTABLE",
            error instanceof Error ? error.message : "It cannot be stopped.",
            409,
          );
        }
        if (!stopped) {
          throw new OwnApiError(
            "ACQUISITION_CHANGED",
            "The acquisition changed while it was being blocklisted.",
            409,
          );
        }

        if (!searchAgain) {
          sendData(context.response, context.requestId, {
            searched: false,
            replacement: null,
          });
          return;
        }

        const policy = searchContext.profileId
          ? await policies.load(searchContext.profileId)
          : null;
        if (!mediaTargetOf(searchContext.target) || !policy) {
          // Nothing recorded to repeat the decision with. The Releases page
          // can still be used by hand.
          sendData(context.response, context.requestId, {
            searched: false,
            replacement: null,
            reason: "no-profile",
          });
          return;
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        context.request.once("aborted", abort);
        context.request.once("close", abort);
        let choice;
        try {
          // The release is already on the blocklist, so the search cannot
          // recommend it again; a season with no other pack falls back to its
          // episodes (see acquisitionFallback.ts).
          choice = await fallback.choose(
            searchContext.target,
            policy,
            null,
            controller.signal,
          );
        } catch (error) {
          if (error instanceof IndexerError) {
            throw new OwnApiError(
              "INDEXER_UNAVAILABLE",
              "The release is blocklisted, but the search failed.",
              error.kind === "auth" ? 502 : 503,
            );
          }
          throw error;
        } finally {
          context.request.off("aborted", abort);
          context.request.off("close", abort);
        }

        if (choice.kind === "none") {
          await repository.update(
            id,
            "failed",
            {
              failureClass: "blocklisted",
              failureDetail:
                "Blocklisted; the search found nothing else acceptable.",
            },
            "Searched again; nothing else acceptable.",
          );
          sendData(context.response, context.requestId, {
            searched: true,
            replacement: null,
          });
          return;
        }

        const applied = await fallback.apply(id, choice, policy);
        if (!applied) {
          throw new OwnApiError(
            "ACQUISITION_CHANGED",
            "The acquisition changed while it was being searched again.",
            409,
          );
        }
        sendData(
          context.response,
          context.requestId,
          {
            searched: true,
            replacement: toDto(applied.created[0]!),
            replacements: applied.created.map((created) => toDto(created)),
            taskId: applied.taskIds[0],
          },
          202,
        );
      },
    },
    {
      /**
       * Whether the download client is reachable.
       *
       * Separate from the server's own readiness on purpose: a media server
       * whose downloader is down can still serve everything it already has,
       * and making playback depend on SABnzbd would be a worse outage than the
       * one it reports.
       */
      method: "GET",
      path: "/acquisitions/client/status",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        try {
          sendData(context.response, context.requestId, {
            reachable: true,
            version: await sab.version(),
          });
        } catch (error) {
          sendData(context.response, context.requestId, {
            reachable: false,
            reason: error instanceof SabError ? error.kind : "unavailable",
            detail:
              error instanceof Error ? error.message : "The client failed.",
          });
        }
      },
    },
  ];
}
