import {
  providersFor,
  type SubtitlePayload,
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
  fitClass,
  fitCorrection,
  fitNeedsRetiming,
  retimeToFit,
  type SubtitleFit,
  type SubtitleFitter,
} from "./subtitleFit";
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
/** What the audio said about the installed subtitle, for the attempt's record. */
export interface SubtitleFitSummary {
  /** How many downloaded candidates were measured before choosing. */
  readonly measured: number;
  readonly confidence: number;
  readonly rate: number;
  readonly offsetSeconds: number;
  readonly trusted: boolean;
  /** True when the cues were moved onto the audio before installing. */
  readonly retimed: boolean;
  /** The piecewise verdict, and how much of the subtitle it placed. */
  readonly verdict: string;
  readonly coverage: number;
  /** Corrected regions; more than one means the subtitle was for another cut. */
  readonly regions: number;
  readonly unresolved: number;
  readonly unmatched: number;
}
export type SubtitlePipelineResult =
  | (SubtitleInstallOutcome & {
      selection?: ScoredCandidate;
      fit?: SubtitleFitSummary;
    })
  | { outcome: "existing" }
  /**
   * A provider refused for now. `retryAfterMs` is when the soonest one said
   * it would answer again — a download allowance renewing, for one.
   */
  | {
      outcome: "error";
      failure: "provider-rate-limited";
      reason: string;
      retryAfterMs?: number;
    }
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

/**
 * Within this much coverage two fits explain the episode equally well. The
 * same translation timed for several releases scores identically against the
 * audio (The Sopranos S02E05: three packs alike), and coverage alone would then
 * pick by download order, not by which one is already on time.
 */
const COVERAGE_TIE = 0.02;

/**
 * Better class first (in sync, then correctable unreviewed, then needing
 * review), then more of the episode matched, then less correction needed.
 */
function fitsBetter(candidate: SubtitleFit, incumbent: SubtitleFit): boolean {
  const classes = fitClass(candidate) - fitClass(incumbent);
  if (classes !== 0) return classes > 0;
  const coverage = candidate.alignment.coverage - incumbent.alignment.coverage;
  if (Math.abs(coverage) > COVERAGE_TIE) return coverage > 0;
  return fitCorrection(candidate) < fitCorrection(incumbent);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
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
  /**
   * Measures each download against the title's own audio. With it, several
   * candidates are downloaded and the best-fitting one is installed, moved onto
   * the audio when it is measurably off. Without it, or once the audio cannot
   * be read, the first candidate that downloads cleanly is installed, as the
   * metadata ranked it.
   */
  fit?: SubtitleFitter;
  /** How many valid downloads to measure before choosing. */
  fitCandidates?: number;
  /**
   * Keeps what was installed, and the provider's own bytes when they were
   * retimed first, so the version a person downloaded is never only in
   * memory. Called after the install commits; its failure is the caller's to
   * report and cannot un-install anything.
   */
  preserve?: (installed: {
    relativePath: string;
    downloaded: Uint8Array;
    installed: Uint8Array;
    retimed: boolean;
    provenance: Record<string, unknown>;
  }) => Promise<void>;
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
    let pendingAuth: string | undefined;
    let failure: SubtitleFailureClass | undefined;
    /* The soonest a rate-limited provider said it would answer again. */
    let retryAfterMs: number | undefined;
    const rateLimited = (after: number | null) => {
      failure = "provider-rate-limited";
      if (after !== null)
        retryAfterMs =
          retryAfterMs === undefined ? after : Math.min(retryAfterMs, after);
    };
    /* Why the last candidate was turned down, for the operator-facing reason. */
    let lastRejection: string | undefined;
    const seen = new Set<string>();
    let fitter = input.fit;
    const downloaded: {
      selected: ScoredCandidate;
      payload: SubtitlePayload;
      fit: SubtitleFit | null;
    }[] = [];
    let lastSelected: ScoredCandidate | undefined;
    /*
     * One provider at a time, in rank order, stopping at the first that yields
     * a subtitle: a lower-ranked provider is a fallback, asked only when every
     * provider above it had nothing it could install. A resumed attempt already
     * holds its candidate and searches nothing.
     */
    const rounds: (SubtitleProvider | null)[] = input.resumeCandidate
      ? [null]
      : providers;
    await phase("searching", 0, providers.length);
    for (let round = 0; round < rounds.length && !downloaded.length; round++) {
      const searched = rounds[round];
      const candidates: ScoredCandidate[] = searched
        ? []
        : [input.resumeCandidate!];
      if (searched) {
        const provider = searched;
        try {
          const result = await providerCall(provider, (session, signal) =>
            provider.search(query, session, signal),
          );
          if (result.outcome === "needs-authentication")
            pendingAuth ??= provider.id;
          else if (result.outcome === "error") failure = "provider-error";
          else if (result.outcome === "rate-limited")
            rateLimited(result.retryAfterMs);
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
        await phase("searching", round + 1, providers.length);
      }
      const ordered = orderCandidates(candidates);
      /*
       * Downloads worth choosing between. Without a fitter the first is the
       * answer, exactly as before; with one, up to `fitCandidates` are measured
       * against the audio and the best fit wins — fewer where the provider
       * counts its downloads. A candidate the audio could not be read for keeps
       * its metadata rank.
       */
      const limit = input.fit
        ? Math.max(
            1,
            Math.min(
              input.fitCandidates ?? 5,
              searched?.downloadsPerSearch ?? Infinity,
            ),
          )
        : 1;
      for (let i = 0; i < ordered.length && downloaded.length < limit; i++) {
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
          lastSelected = selected;
          await phase("downloading", i, ordered.length);
          const result = await providerCall(provider, (session, signal) =>
            provider.download(selected.candidate, session, signal),
          );
          if (result.outcome === "needs-authentication") {
            pendingAuth ??= provider.id;
            continue;
          }
          if (result.outcome !== "ok") {
            if (result.outcome === "rate-limited")
              rateLimited(result.retryAfterMs);
            else if (result.outcome !== "empty") failure = "provider-error";
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
          // The same bytes from another listing measure the same; keep the first.
          if (
            downloaded.some((entry) =>
              sameBytes(entry.payload.bytes, result.value.bytes),
            )
          )
            continue;
          let fit: SubtitleFit | null = null;
          if (fitter) {
            try {
              fit = await fitter.measure(result.value.bytes);
            } catch {
              if (input.signal?.aborted) return { outcome: "cancelled" };
              // No audio to listen to: rank by metadata alone from here on.
              fitter = undefined;
            }
          }
          downloaded.push({ selected, payload: result.value, fit });
          if (!fitter) break;
        } catch (error) {
          if (error instanceof CallFailure && error.failure === "cancelled")
            throw error;
          failure =
            error instanceof CallFailure
              ? (error.failure as SubtitleFailureClass)
              : "provider-error";
        }
      }
    }
    const chosen = downloaded.reduce<(typeof downloaded)[number] | undefined>(
      (best, entry) =>
        best === undefined ||
        (entry.fit !== null &&
          (best.fit === null || fitsBetter(entry.fit, best.fit)))
          ? entry
          : best,
      undefined,
    );
    if (chosen) {
      if (input.signal?.aborted) return { outcome: "cancelled" };
      // The checkpoint names what is installed, so a resume downloads that one.
      if (chosen.selected !== lastSelected)
        await input.selected?.(chosen.selected);
      const retimed = chosen.fit !== null && fitNeedsRetiming(chosen.fit);
      const payload: SubtitlePayload = retimed
        ? {
            ...chosen.payload,
            bytes: retimeToFit(chosen.payload.bytes, chosen.fit!),
          }
        : chosen.payload;
      await phase("installing", 0, 1);
      const installed = await input.storage.install({
        mediaFileId: input.mediaFileId,
        language: want.language,
        flags: chosen.selected.candidate,
        payload,
        replace: input.replace === true,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        installed.outcome !== "installed" &&
        installed.outcome !== "duplicate"
      )
        return installed;
      if (installed.outcome === "installed")
        await input
          .preserve?.({
            relativePath: installed.relativePath,
            downloaded: chosen.payload.bytes,
            installed: payload.bytes,
            retimed,
            provenance: {
              providerId: chosen.selected.candidate.providerId,
              candidateId: chosen.selected.candidate.candidateId,
              ...(chosen.fit
                ? {
                    verdict: chosen.fit.alignment.verdict,
                    coverage: chosen.fit.alignment.coverage,
                    aligner: chosen.fit.alignment.version,
                    segments: chosen.fit.alignment.segments.length,
                  }
                : {}),
            },
          })
          .catch(() => undefined);
      await phase("installing", 1, 1);
      return {
        ...installed,
        selection: chosen.selected,
        ...(chosen.fit
          ? {
              fit: {
                measured: downloaded.filter((entry) => entry.fit !== null)
                  .length,
                confidence: chosen.fit.confidence,
                rate: chosen.fit.rate,
                offsetSeconds: chosen.fit.offsetSeconds,
                trusted: chosen.fit.trusted,
                retimed,
                verdict: chosen.fit.alignment.verdict,
                coverage: chosen.fit.alignment.coverage,
                regions: chosen.fit.alignment.segments.filter(
                  (segment) => segment.status === "corrected",
                ).length,
                unresolved: chosen.fit.alignment.counts.unresolved,
                unmatched: chosen.fit.alignment.counts.unmatched,
              },
            }
          : {}),
      };
    }
    if (input.signal?.aborted) return { outcome: "cancelled" };
    if (pendingAuth)
      return { outcome: "needs-authentication", providerId: pendingAuth };
    return failure
      ? {
          outcome: "error",
          failure,
          reason: `Every provider was tried; the last failed with ${failure}.`,
          ...(failure === "provider-rate-limited" && retryAfterMs !== undefined
            ? { retryAfterMs }
            : {}),
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
