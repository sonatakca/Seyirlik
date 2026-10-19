import {
  providersFor,
  sessionIsExpired,
  type ProviderResult,
  type ProviderSession,
  type ProviderSessionManager,
  type ScoredCandidate,
  type SubtitleProvider,
  type SubtitleQuery,
} from "./subtitleProvider";
import { assessCandidate, orderCandidates } from "./subtitleSelection";
import {
  normalizeWant,
  wantIsSatisfiedBy,
  type SubtitleFailureClass,
  type SubtitleTrack,
  type SubtitleWant,
} from "./subtitleState";
import { validateSubtitle } from "./subtitlePayload";
import {
  StorageFailure,
  type SubtitleInstallOutcome,
  type SubtitleStorage,
} from "./subtitleStorage";

export type SubtitleProgress = {
  phase:
    | "detecting"
    | "searching"
    | "downloading"
    | "validating"
    | "installing";
  completed: number;
  total: number;
};
export type SubtitlePipelineResult =
  | (SubtitleInstallOutcome & { selection?: ScoredCandidate })
  | { outcome: "existing" }
  /** Nothing usable was offered. `reason` says what the last candidate lacked. */
  | { outcome: "unavailable"; reason?: string }
  | { outcome: "needs-authentication"; providerId: string };
class CallFailure extends Error {
  constructor(
    readonly failure: "provider-timeout" | "provider-error" | "cancelled",
  ) {
    super(failure);
  }
}

/** Bounds even an adapter that ignores abort. Late responses cannot reach storage. */
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<T> {
  if (outer?.aborted) throw new CallFailure("cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new CallFailure("cancelled"));
      controller.abort();
    };
    outer?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      reject(new CallFailure("provider-timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      interrupted,
      Promise.resolve().then(() => operation(controller.signal)),
    ]);
  } catch (error) {
    throw error instanceof CallFailure
      ? error
      : new CallFailure("provider-error");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", cancel);
  }
}

/** Server-only orchestration. The caller supplies a catalogue ID, never a destination. */
export async function runSubtitlePipeline(input: {
  mediaFileId: string;
  query: SubtitleQuery;
  want: SubtitleWant;
  embeddedTracks: readonly SubtitleTrack[];
  providers: readonly SubtitleProvider[];
  sessions: ProviderSessionManager;
  /*
   * Only the two operations a search performs. Narrowed rather than taking the
   * whole writer, because retiming an existing subtitle is a different feature
   * with a different authority, and a pipeline that could reach it would be one
   * refusal away from rewriting a file it was only ever meant to add beside.
   */
  storage: Pick<SubtitleStorage, "inspect" | "install">;
  timeoutMs: number;
  replace?: boolean;
  signal?: AbortSignal;
  progress?: (event: SubtitleProgress) => void | Promise<void>;
  resumeCandidate?: ScoredCandidate;
  selected?: (candidate: ScoredCandidate) => Promise<void>;
}): Promise<SubtitlePipelineResult> {
  if (
    !Number.isFinite(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > 300_000
  )
    throw new Error("Invalid provider timeout.");
  const want = normalizeWant(input.want);
  const query = {
    ...input.query,
    language: want.language,
    wantForced: want.forced,
  };
  const phase = (
    phase: SubtitleProgress["phase"],
    completed: number,
    total: number,
  ) => input.progress?.({ phase, completed, total });
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>) =>
    bounded(operation, input.timeoutMs, input.signal);
  const providerCall = async <T>(
    provider: SubtitleProvider,
    operation: (
      session: ProviderSession | null,
      signal: AbortSignal,
    ) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> => {
    let session: ProviderSession | null = null;
    if (provider.requiresSession) {
      const acquired = await call(() => input.sessions.acquire(provider.id));
      if (
        acquired.outcome !== "ready" ||
        acquired.session.providerId !== provider.id ||
        sessionIsExpired(acquired.session, Date.now())
      )
        return {
          outcome: "needs-authentication",
          reason: "Interactive login required.",
          authenticateAt: null,
        };
      session = acquired.session;
    }
    const result = await call((signal) => operation(session, signal));
    if (result.outcome === "needs-authentication" && provider.requiresSession) {
      // A broken session store must not erase the provider's authentication state.
      await call(() =>
        input.sessions.invalidate(provider.id, "Session rejected."),
      ).catch(() => undefined);
    }
    return result;
  };
  try {
    if (input.signal?.aborted) return { outcome: "cancelled" };
    await phase("detecting", 0, 1);
    const tracks = [
      ...input.embeddedTracks.filter((t) => t.origin === "embedded"),
      ...(await input.storage.inspect(input.mediaFileId)),
    ];
    await phase("detecting", 1, 1);
    if (tracks.some((t) => wantIsSatisfiedBy(want, t)) && !input.replace)
      return { outcome: "existing" };
    const providers = providersFor(input.providers, want.language);
    if (!providers.length) {
      return {
        outcome: "error",
        failure: "no-provider",
        reason: "No configured provider carries this language.",
      };
    }
    const candidates: ScoredCandidate[] = input.resumeCandidate
      ? [input.resumeCandidate]
      : [];
    let pendingAuth: string | undefined;
    let failure: SubtitleFailureClass | undefined;
    /* Why the last candidate was turned down, for the operator-facing reason. */
    let lastRejection: string | undefined;
    await phase("searching", 0, providers.length);
    for (let i = 0; i < (input.resumeCandidate ? 0 : providers.length); i++) {
      const provider = providers[i]!;
      try {
        const result = await providerCall(provider, (session, signal) =>
          provider.search(query, session, signal),
        );
        if (result.outcome === "needs-authentication")
          pendingAuth ??= provider.id;
        else if (result.outcome === "error") failure = "provider-error";
        else if (result.outcome === "rate-limited")
          failure = "provider-rate-limited";
        else if (result.outcome === "ok") {
          for (const candidate of result.value) {
            const assessment = assessCandidate(
              query,
              want,
              candidate,
              provider,
            );
            if (assessment.accepted) candidates.push(assessment.scored);
            else lastRejection = assessment.reason;
          }
        }
      } catch (error) {
        if (error instanceof CallFailure && error.failure === "cancelled")
          throw error;
        failure =
          error instanceof CallFailure
            ? (error.failure as SubtitleFailureClass)
            : "provider-error";
      }
      await phase("searching", i + 1, providers.length);
    }
    const ordered = orderCandidates(candidates);
    const seen = new Set<string>();
    for (let i = 0; i < ordered.length; i++) {
      const selected = ordered[i]!;
      const key = JSON.stringify([
        selected.candidate.providerId,
        selected.candidate.candidateId,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = providers.find(
        (p) => p.id === selected.candidate.providerId,
      )!;
      try {
        await input.selected?.(selected);
        await phase("downloading", i, ordered.length);
        const result = await providerCall(provider, (session, signal) =>
          provider.download(selected.candidate, session, signal),
        );
        if (result.outcome === "needs-authentication") {
          pendingAuth ??= provider.id;
          continue;
        }
        if (result.outcome !== "ok") {
          if (result.outcome !== "empty")
            failure =
              result.outcome === "rate-limited"
                ? "provider-rate-limited"
                : "provider-error";
          continue;
        }
        await phase("validating", 0, 1);
        try {
          validateSubtitle(result.value);
        } catch {
          failure = "payload-invalid";
          continue;
        }
        await phase("validating", 1, 1);
        if (input.signal?.aborted) return { outcome: "cancelled" };
        await phase("installing", 0, 1);
        const installed = await input.storage.install({
          mediaFileId: input.mediaFileId,
          language: want.language,
          flags: selected.candidate,
          payload: result.value,
          replace: input.replace === true,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (
          installed.outcome === "installed" ||
          installed.outcome === "duplicate"
        )
          await phase("installing", 1, 1);
        return installed.outcome === "installed" ||
          installed.outcome === "duplicate"
          ? { ...installed, selection: selected }
          : installed;
      } catch (error) {
        if (error instanceof CallFailure && error.failure === "cancelled")
          throw error;
        failure =
          error instanceof CallFailure
            ? (error.failure as SubtitleFailureClass)
            : "provider-error";
      }
    }
    if (input.signal?.aborted) return { outcome: "cancelled" };
    if (pendingAuth)
      return { outcome: "needs-authentication", providerId: pendingAuth };
    return failure
      ? {
          outcome: "error",
          failure,
          reason: `Every provider was tried; the last failed with ${failure}.`,
        }
      : {
          outcome: "unavailable",
          ...(lastRejection === undefined ? {} : { reason: lastRejection }),
        };
  } catch (error) {
    if (error instanceof CallFailure)
      return error.failure === "cancelled"
        ? { outcome: "cancelled" }
        : {
            outcome: "error",
            failure: error.failure,
            reason: `The search stopped with ${error.failure}.`,
          };
    // Inspecting beside a source that is not on the disk: say so, not "unknown".
    if (error instanceof StorageFailure)
      return { outcome: "error", failure: error.failure, reason: error.reason };
    return {
      outcome: "error",
      failure: "unknown",
      reason: "The subtitle search failed for a reason it could not classify.",
    };
  }
}
