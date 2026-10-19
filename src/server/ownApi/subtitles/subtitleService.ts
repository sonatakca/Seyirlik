import {
  createPlaybackRefreshBoundary,
  type PlaybackRefreshBoundary,
} from "../playback/playbackRefresh";
import type { SubtitleConfig } from "./subtitleConfig";
import type {
  SubtitleExecutionRepository,
  SubtitleWork,
} from "./subtitleExecution";
import { runSubtitlePipeline, type SubtitleProgress } from "./subtitlePipeline";
import type {
  ProviderSessionManager,
  ScoredCandidate,
  SubtitleProvider,
} from "./subtitleProvider";
import type { SubtitleState } from "./subtitleState";
import {
  createSubtitleStorage,
  type SubtitleStorageOptions,
  type SubtitleStorage,
} from "./subtitleStorage";

export interface SubtitleRunOptions {
  resume?: boolean;
  replace?: boolean;
  progress?: (event: SubtitleProgress) => Promise<void>;
  isCancelled?: () => Promise<boolean>;
}
export interface SubtitleService {
  run(
    attemptId: string,
    options?: SubtitleRunOptions,
  ): Promise<Record<string, unknown>>;
}

/** Persist only the provider contract's known fields, never arbitrary adapter properties. */
function checkpointCandidate(selected: ScoredCandidate): ScoredCandidate {
  const c = selected.candidate;
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.providerId) ||
    !/^[a-zA-Z0-9._-]{1,256}$/.test(c.candidateId)
  )
    throw new Error("The provider candidate needs a safe opaque identifier.");
  return {
    score: {
      total: selected.score.total,
      maximum: selected.score.maximum,
      reasons: [...selected.score.reasons],
      components: selected.score.components.map((c) => ({
        dimension: c.dimension,
        weight: c.weight,
        matched: c.matched,
        detail: c.detail,
      })),
    },
    candidate: {
      providerId: c.providerId,
      candidateId: c.candidateId,
      language: c.language,
      format: c.format,
      forced: c.forced,
      hearingImpaired: c.hearingImpaired,
      releaseTitle: c.releaseTitle,
      releaseGroup: c.releaseGroup,
      source: c.source,
      resolution: c.resolution,
      hashMatched: c.hashMatched,
      providerRating: c.providerRating,
      ...(c.frameRate ? { frameRate: c.frameRate } : {}),
      ...(c.identity
        ? {
            identity: {
              title: c.identity.title,
              year: c.identity.year,
              season: c.identity.season,
              episode: c.identity.episode,
            },
          }
        : {}),
    },
  };
}

export function createSubtitleService(dependencies: {
  config: SubtitleConfig;
  execution: SubtitleExecutionRepository;
  providers: readonly SubtitleProvider[];
  sessions: ProviderSessionManager;
  playback?: PlaybackRefreshBoundary;
  storageFactory?: (options: SubtitleStorageOptions) => SubtitleStorage;
}): SubtitleService {
  const playback = dependencies.playback ?? createPlaybackRefreshBoundary();
  return {
    async run(attemptId, options = {}) {
      const result = await dependencies.execution.withAttempt(
        attemptId,
        async (work) => {
          const move = async (
            to: SubtitleState,
            extra: Partial<
              Parameters<SubtitleWork["repository"]["moveAttempt"]>[0]
            > = {},
          ) => {
            work.attempt = await work.repository.moveAttempt({
              ...extra,
              attemptId,
              from: work.attempt.state,
              to,
            });
          };
          if (
            !work.want.active ||
            ["installed", "superseded", "unavailable", "failed"].includes(
              work.attempt.state,
            )
          )
            return { state: work.attempt.state };
          if (await options.isCancelled?.())
            return { state: work.attempt.state, cancelled: true };
          if (work.attempt.state === "needs-authentication") {
            if (!options.resume)
              return {
                state: "needs-authentication",
                providerId: work.attempt.awaitingProviderId,
              };
            await work.transaction(async () => {
              await move(
                work.resumeStage === "downloading" && work.selected
                  ? "downloading"
                  : "searching",
              );
              await work.event("authentication-resumed");
            });
          }
          const storage = (
            dependencies.storageFactory ?? createSubtitleStorage
          )({
            libraryRoot: dependencies.config.libraryRoot,
            operationId: attemptId,
            resolveMedia: async (id) => {
              if (id !== work.want.mediaFileId)
                throw new Error("Unknown subtitle media ID.");
              return work.relativePath;
            },
            managedDigest: (id, relative) =>
              work.repository.managedDigest(id, relative),
            prepare: async (intent) => {
              if (work.signal.aborted || (await options.isCancelled?.()))
                throw new Error("Subtitle execution cancelled.");
              await work.transaction(async () => {
                await work.checkpoint({ intent });
                if (work.attempt.state !== "validating")
                  await move("validating");
              });
            },
          });
          const finish = async (outcome: {
            outcome: "installed" | "duplicate";
            relativePath: string;
            sha256: string;
          }) => {
            await work.transaction(async () => {
              if (outcome.outcome === "installed") {
                if (!work.intent || work.intent.sha256 !== outcome.sha256)
                  throw new Error("Installation has no durable receipt.");
                const i = work.intent;
                await work.repository.recordInstallation({
                  mediaFileId: i.mediaFileId,
                  wantId: work.want.id,
                  attemptId,
                  relativePath: outcome.relativePath,
                  language: i.language,
                  forced: i.flags.forced,
                  hearingImpaired: i.flags.hearingImpaired,
                  format: i.format,
                  sha256: i.sha256,
                  sizeBytes: i.sizeBytes,
                  cueCount: i.cueCount,
                  providerId: work.selected?.candidate.providerId ?? null,
                  syncState: work.selected?.candidate.hashMatched
                    ? "assumed-in-sync"
                    : "unknown",
                });
              }
              // Duplicate content satisfies the want, but does not confer ownership.
              if (work.attempt.state !== "validating") await move("validating");
              await move("installed");
              await work.repository.deactivateWant(work.want.id);
              await work.event("installed", {
                duplicate: outcome.outcome === "duplicate",
              });
            });
            const refreshed = await playback.request({
              mediaFileId: work.want.mediaFileId,
              kind: "subtitles",
            });
            await work
              .event("playback-refresh", { outcome: refreshed.outcome })
              .catch(() => undefined);
            return {
              state: "installed",
              duplicate: outcome.outcome === "duplicate",
              playback: refreshed.outcome,
            };
          };
          if (work.attempt.state === "validating") {
            if (work.intent && storage.reconcile) {
              const recovered = await storage.reconcile(work.intent);
              if (recovered.outcome === "installed") return finish(recovered);
            }
            await work.event("operator-attention", {
              failure: "commit-ambiguous",
            });
            return { state: "validating", attention: "commit-ambiguous" };
          }
          if (work.attempt.state === "wanted") {
            await work.checkpoint({ replace: options.replace === true });
            await move("searching", { countsAsAttempt: true });
          }
          if (work.attempt.state === "selected") await move("downloading");
          await work.event("search-started");
          const outcome = await runSubtitlePipeline({
            mediaFileId: work.want.mediaFileId,
            query: work.query,
            want: work.want,
            embeddedTracks: work.embedded,
            storage,
            providers: dependencies.providers.filter((p) =>
              dependencies.config.providerIds.includes(p.id),
            ),
            sessions: dependencies.sessions,
            timeoutMs: dependencies.config.timeoutMs,
            replace: work.replace,
            signal: work.signal,
            ...(work.attempt.state === "downloading" && work.selected
              ? { resumeCandidate: work.selected }
              : {}),
            selected: async (selected) => {
              await work.transaction(async () => {
                await work.checkpoint({
                  selected: checkpointCandidate(selected),
                  resumeStage: "downloading",
                });
                if (work.attempt.state === "searching") await move("selected");
                if (work.attempt.state === "selected")
                  await move("downloading");
                await work.event("candidate-selected", {
                  score: selected.score.total,
                });
              });
            },
            progress: async (event) => {
              if (await options.isCancelled?.())
                throw new Error("Subtitle execution cancelled.");
              // Notifications are observational; their failure must not erase a commit.
              await options.progress?.(event).catch(() => undefined);
            },
          });
          if (
            outcome.outcome === "installed" ||
            outcome.outcome === "duplicate"
          )
            return finish(outcome);
          if (outcome.outcome === "needs-authentication") {
            await work.transaction(async () => {
              await work.checkpoint({
                resumeStage: work.selected ? "downloading" : "searching",
              });
              await move("needs-authentication", {
                awaitingProviderId: outcome.providerId,
                failureClass: "authentication-required",
                failureDetail:
                  "Interactive provider authentication is required.",
              });
              await work.event("authentication-required", {
                providerId: outcome.providerId,
              });
            });
            return {
              state: "needs-authentication",
              providerId: outcome.providerId,
            };
          }
          if (outcome.outcome === "existing") {
            await work.transaction(async () => {
              await move("superseded");
              await work.repository.deactivateWant(work.want.id);
              await work.event("existing");
            });
            return { state: "superseded", existing: true };
          }
          if (
            outcome.outcome === "unavailable" &&
            (work.attempt.state === "searching" ||
              (work.attempt.state as SubtitleState) === "downloading")
          ) {
            await work.transaction(async () => {
              await move("unavailable");
              await work.event("unavailable");
            });
            return { state: "unavailable" };
          }
          if (
            (work.attempt.state as SubtitleState) === "validating" &&
            (outcome.outcome !== "error" ||
              outcome.failure === "commit-ambiguous")
          )
            return { state: "validating", attention: "commit-ambiguous" };
          const failure =
            outcome.outcome === "error" ? outcome.failure : "unknown";
          await work.transaction(async () => {
            await move("failed", {
              failureClass: failure,
              failureDetail: `Subtitle operation stopped: ${failure}.`,
            });
            await work.event("failed", { failure });
          });
          return { state: "failed", failure };
        },
      );
      return result ?? { state: "busy" };
    },
  };
}
