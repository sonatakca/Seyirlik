/**
 * Getting a chosen release into SABnzbd, exactly once.
 *
 * The hard part is not sending the NZB; it is not sending it twice. A response
 * lost after SABnzbd accepted the file looks identical, from here, to one that
 * never arrived — and the naive repair, sending it again, is precisely how a
 * download appears in the queue twice.
 *
 * The answer is a name only this acquisition would ever use, written to the
 * database *before* anything is sent, and given to SABnzbd as the job name. A
 * lost response is then not a question about what happened; it is a question
 * about what SABnzbd currently holds, and that has an answer.
 *
 * So: persist `submitting`, look before sending, and never treat "I do not
 * know" as "it did not happen".
 */
import {
  assertTransition,
  planRetry,
  type AcquisitionState,
  type FailureClass,
} from "./acquisitionState";

/**
 * Where an acquisition may be blocklisted from.
 *
 * Not `resolving` or `submitting`: a worker holding the row may be handing the
 * NZB to SABnzbd at that moment, and a job it creates after this stops would
 * belong to nobody. Those last seconds; the operator can ask again.
 */
export const BLOCKLISTABLE_STATES: readonly AcquisitionState[] = [
  "planned",
  "queued",
  "downloading",
  "processing",
  "awaiting_retry",
  "failed",
];
import {
  classifySabFailure,
  SabError,
  type SabJob,
  type SabnzbdClient,
} from "./sabnzbd";
import { IndexerError } from "../indexers/indexerTypes";
import type { IndexerRegistry } from "../indexers/indexerRegistry";

export interface AcquisitionRecord {
  readonly id: string;
  readonly state: AcquisitionState;
  readonly indexerId: string;
  readonly releaseGuid: string;
  readonly releaseTitle: string;
  readonly idempotencyKey: string;
  readonly externalId?: string;
  readonly attempt: number;
  /** When an `awaiting_retry` row is due; absent means now. */
  readonly retryAfterMs?: number;
  readonly downloadPath?: string;
  readonly sizeBytes?: number;
  /** When the row entered its current state; the submit grace period uses it. */
  readonly updatedAtMs: number;
}

export interface AcquisitionPatch {
  state?: AcquisitionState;
  externalId?: string;
  attempt?: number;
  failureClass?: FailureClass | null;
  failureDetail?: string | null;
  downloadPath?: string;
  sizeBytes?: number;
  retryAfterMs?: number | null;
}

export interface AcquisitionStore {
  get(id: string): Promise<AcquisitionRecord | null>;
  /** Rows the reconciler is responsible for. */
  listActive(): Promise<AcquisitionRecord[]>;
  /**
   * Applies a change and records the transition.
   *
   * Returns false when the row is no longer in `expectedState`, which is how
   * two workers holding the same acquisition are resolved: the second one
   * loses and does nothing.
   */
  update(
    id: string,
    expectedState: AcquisitionState,
    patch: AcquisitionPatch,
    detail?: string,
  ): Promise<boolean>;
}

export interface AcquisitionServiceOptions {
  readonly store: AcquisitionStore;
  readonly indexers: IndexerRegistry;
  readonly sab: SabnzbdClient;
  /** The SABnzbd category Seyirlik's jobs are filed under. */
  readonly category: string;
  readonly now?: () => number;
  /**
   * How long a row may sit in `submitting` before an absent job is taken as
   * proof the submission never landed.
   *
   * Not zero. SABnzbd does not necessarily list a job the instant it accepts
   * it, and concluding "it is not there" too early is how the duplicate this
   * design prevents gets created anyway.
   */
  readonly submitGraceMs?: number;
}

const DEFAULT_SUBMIT_GRACE_MS = 60_000;

/**
 * SABnzbd's state, as an acquisition state.
 *
 * A completed job is `downloaded` only once SABnzbd names where it put it.
 * History can say "Completed" a moment before `storage` is filled, and a row
 * that reached `downloaded` then would never be read again: the reconciler
 * stops at `downloaded` and the import hand-off needs the path, so the file
 * would sit on disk unimported. Until the path appears it is still processing.
 */
export function stateFromSabJob(job: SabJob): AcquisitionState {
  switch (job.state) {
    case "queued":
    case "paused":
      return "queued";
    case "downloading":
      return "downloading";
    case "processing":
      return "processing";
    case "completed":
      return job.storagePath ? "downloaded" : "processing";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

export interface AcquisitionService {
  /** Resolves the release and hands it to SABnzbd, at most once. */
  submit(acquisitionId: string, signal?: AbortSignal): Promise<void>;
  /** Brings every active acquisition into agreement with SABnzbd. */
  reconcile(
    signal?: AbortSignal,
  ): Promise<{ examined: number; changed: number }>;
  /** Removes the SABnzbd job this acquisition owns, if any, and cancels it. */
  cancel(acquisitionId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Stops this acquisition because its release is blocklisted.
   *
   * Ends in `failed`, not `cancelled`: the thing it was for is still wanted,
   * and a failure is what keeps it in front of the operator. False when the
   * row moved under it; throws when it is in a state that cannot be stopped.
   */
  blocklist(acquisitionId: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Holds or releases the job this acquisition owns in SABnzbd's queue.
   * Throws `AcquisitionControlError` when it has no job waiting there.
   */
  setPaused(
    acquisitionId: string,
    paused: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Moves the job this acquisition owns to a place in SABnzbd's queue, from
   * 0, and returns the place it was given. Same error as `setPaused`.
   */
  move(
    acquisitionId: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

/** Why a queue control could not be applied to an acquisition. */
export class AcquisitionControlError extends Error {
  readonly kind: "not-found" | "not-in-queue";

  constructor(kind: "not-found" | "not-in-queue", message: string) {
    super(message);
    this.name = "AcquisitionControlError";
    this.kind = kind;
  }
}

export function createAcquisitionService({
  store,
  indexers,
  sab,
  category,
  now = Date.now,
  submitGraceMs = DEFAULT_SUBMIT_GRACE_MS,
}: AcquisitionServiceOptions): AcquisitionService {
  /**
   * Adopts a job SABnzbd already has.
   *
   * The single most important function here. Everything that could have gone
   * wrong during submission ends up asking this question, and it answers it
   * from SABnzbd's own state rather than from what Seyirlik believed.
   */
  async function adopt(
    record: AcquisitionRecord,
    job: SabJob,
    detail: string,
  ): Promise<boolean> {
    const next = stateFromSabJob(job);
    const patch: AcquisitionPatch = {
      state: next,
      externalId: job.nzoId,
      ...(job.sizeBytes === undefined ? {} : { sizeBytes: job.sizeBytes }),
      ...(job.storagePath === undefined
        ? {}
        : { downloadPath: job.storagePath }),
      ...(next === "failed"
        ? {
            failureClass: classifySabFailure(job.failMessage),
            failureDetail: job.failMessage ?? "SABnzbd reported a failure.",
          }
        : { failureClass: null, failureDetail: null }),
    };
    assertTransition(record.state, next);
    return store.update(record.id, record.state, patch, detail);
  }

  /**
   * The queue job this acquisition owns, or an error saying why there is none.
   *
   * Owned means what the ownership rule says everywhere else: filed under
   * Seyirlik's category and named with this row's key. A job that is only in
   * history has finished downloading, and holding or moving it means nothing.
   */
  async function ownedQueueJob(
    acquisitionId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ job: SabJob; queueLength: number }> {
    const record = await store.get(acquisitionId);
    if (!record) {
      throw new AcquisitionControlError("not-found", "No such acquisition.");
    }
    const queue = await sab.listQueue(signal);
    const job =
      (record.externalId
        ? queue.find((entry) => entry.nzoId === record.externalId)
        : undefined) ??
      queue.find((entry) => entry.name === record.idempotencyKey);
    if (
      !job ||
      job.name !== record.idempotencyKey ||
      (job.category !== undefined && job.category !== category)
    ) {
      throw new AcquisitionControlError(
        "not-in-queue",
        "This download is not waiting in the download client's queue.",
      );
    }
    return { job, queueLength: queue.length };
  }

  async function fail(
    record: AcquisitionRecord,
    failureClass: FailureClass,
    detail: string,
  ): Promise<void> {
    await store.update(
      record.id,
      record.state,
      { state: "failed", failureClass, failureDetail: detail },
      detail,
    );
  }

  /**
   * Parks a transient failure until its next attempt is due.
   *
   * The time is what makes `awaiting_retry` true: the reconciler submits the
   * row again once it has passed. A release that has used its attempts fails
   * instead, so the row says it needs a person rather than waiting forever.
   */
  async function retryLater(
    record: AcquisitionRecord,
    failureClass: FailureClass,
    detail: string,
  ): Promise<boolean> {
    const plan = planRetry(failureClass, record.attempt);
    return store.update(
      record.id,
      record.state,
      plan.action === "retry"
        ? {
            state: "awaiting_retry",
            failureClass,
            failureDetail: detail,
            retryAfterMs: now() + plan.delayMs,
          }
        : { state: "failed", failureClass, failureDetail: detail },
      detail,
    );
  }

  return {
    async submit(acquisitionId, signal) {
      const record = await store.get(acquisitionId);
      if (!record) return;
      if (record.state !== "planned" && record.state !== "awaiting_retry") {
        // Already in flight or finished. A second worker arriving here is the
        // normal case, not an error.
        return;
      }

      /*
       * Claim it first. `update` fails if another worker already moved the row,
       * so exactly one worker proceeds past this line for a given acquisition.
       */
      if (
        !(await store.update(
          record.id,
          record.state,
          { state: "resolving", attempt: record.attempt + 1 },
          "Resolving the release.",
        ))
      ) {
        return;
      }
      const claimed: AcquisitionRecord = {
        ...record,
        state: "resolving",
        attempt: record.attempt + 1,
      };

      // Look before sending. A previous attempt may have landed even though
      // this row does not know it.
      let existing: SabJob | undefined;
      try {
        existing = await sab.findByName(claimed.idempotencyKey, signal);
      } catch (error) {
        if (error instanceof SabError && error.kind === "auth") {
          await fail(claimed, "sab-auth", error.message);
          return;
        }
        await retryLater(
          claimed,
          "sab-unavailable",
          "SABnzbd could not be asked whether the job already exists.",
        );
        return;
      }
      if (existing) {
        await adopt(claimed, existing, "SABnzbd already had this job.");
        return;
      }

      let payload: { bytes: Uint8Array; filename?: string };
      try {
        const provider = indexers.get(claimed.indexerId);
        if (!provider) {
          throw new IndexerError(
            "not-found",
            "That indexer is not configured.",
          );
        }
        payload = await provider.fetchRelease(claimed.releaseGuid, signal);
      } catch (error) {
        const indexerError =
          error instanceof IndexerError
            ? error
            : new IndexerError(
                "unavailable",
                "The indexer could not be reached.",
              );
        const failureClass: FailureClass =
          indexerError.kind === "auth"
            ? "indexer-auth"
            : indexerError.kind === "not-found"
              ? "nzb-unavailable"
              : "indexer-unavailable";
        if (failureClass === "indexer-unavailable") {
          await retryLater(claimed, failureClass, indexerError.message);
        } else {
          await fail(claimed, failureClass, indexerError.message);
        }
        return;
      }

      /*
       * The uncertain window opens here and is recorded before it opens. If
       * this process dies on the next line, the row says `submitting` and the
       * reconciler knows to look for the job rather than to send it again.
       */
      if (
        !(await store.update(
          claimed.id,
          "resolving",
          { state: "submitting" },
          "Handing the NZB to SABnzbd.",
        ))
      ) {
        return;
      }
      const submitting: AcquisitionRecord = { ...claimed, state: "submitting" };

      let nzoId: string | undefined;
      try {
        nzoId = await sab.submit(
          {
            bytes: payload.bytes,
            name: submitting.idempotencyKey,
            category,
            ...(payload.filename ? { filename: payload.filename } : {}),
          },
          signal,
        );
      } catch (error) {
        const sabError =
          error instanceof SabError
            ? error
            : new SabError("unavailable", "SABnzbd failed.");
        if (sabError.kind === "auth") {
          await fail(submitting, "sab-auth", sabError.message);
          return;
        }
        if (sabError.kind === "rejected") {
          // SABnzbd looked at the file and refused it. Sending it again will
          // not change its mind; another release might.
          await fail(submitting, "nzb-unavailable", sabError.message);
          return;
        }
        /*
         * Left in `submitting` on purpose. A timeout or a dropped connection
         * says nothing about whether SABnzbd accepted the file, and the only
         * safe next step is to look — which is what the reconciler does.
         */
        return;
      }

      if (nzoId) {
        await store.update(
          submitting.id,
          "submitting",
          {
            state: "queued",
            externalId: nzoId,
            failureClass: null,
            failureDetail: null,
          },
          "SABnzbd accepted the job.",
        );
        return;
      }

      // Accepted without an identifier. Recover it by the name we chose.
      const found = await sab
        .findByName(submitting.idempotencyKey, signal)
        .catch(() => undefined);
      if (found) {
        await adopt(
          submitting,
          found,
          "Recovered the job by name after submission.",
        );
      }
      // Otherwise leave it in `submitting`; the reconciler will look again.
    },

    async reconcile(signal) {
      const active = await store.listActive();
      if (active.length === 0) return { examined: 0, changed: 0 };

      /*
       * Two list calls for the whole batch rather than two per acquisition.
       * SABnzbd is one process on one machine and a queue read is cheap, but
       * asking it once per row turns a backlog into a stampede.
       */
      let queue: SabJob[];
      let history: SabJob[];
      try {
        [queue, history] = await Promise.all([
          sab.listQueue(signal),
          sab.listHistory(200, signal),
        ]);
      } catch {
        // SABnzbd being briefly unreachable is not evidence about any job.
        // Nothing is marked failed for it.
        return { examined: active.length, changed: 0 };
      }

      const byId = new Map<string, SabJob>();
      const byName = new Map<string, SabJob>();
      // Queue first, then history: a job present in both is still running.
      for (const job of [...history, ...queue]) {
        byId.set(job.nzoId, job);
        if (job.name) byName.set(job.name, job);
      }

      let changed = 0;
      for (const record of active) {
        const job =
          (record.externalId ? byId.get(record.externalId) : undefined) ??
          byName.get(record.idempotencyKey);

        if (job) {
          const next = stateFromSabJob(job);
          if (next === record.state && record.externalId === job.nzoId)
            continue;
          if (await adopt(record, job, "Reconciled with SABnzbd."))
            changed += 1;
          continue;
        }

        if (record.state === "submitting") {
          // Not there. Only conclude the submission never landed once SABnzbd
          // has had time to list it.
          if (now() - record.updatedAtMs < submitGraceMs) continue;
          if (
            await retryLater(
              record,
              "submission-timeout",
              "SABnzbd never showed the job; it will be offered again.",
            )
          ) {
            changed += 1;
          }
          continue;
        }

        if (record.externalId) {
          // We knew its identifier and now SABnzbd does not. Somebody removed
          // it, and re-sending would fight whoever did.
          if (
            await store.update(
              record.id,
              record.state,
              {
                state: "failed",
                failureClass: "removed-externally",
                failureDetail: "The SABnzbd job is gone.",
              },
              "The SABnzbd job is gone.",
            )
          ) {
            changed += 1;
          }
        }
      }
      return { examined: active.length, changed };
    },

    async blocklist(acquisitionId, signal) {
      const record = await store.get(acquisitionId);
      if (!record) return false;
      if (!BLOCKLISTABLE_STATES.includes(record.state)) {
        throw new Error(
          `An acquisition in ${record.state} cannot be blocklisted.`,
        );
      }
      /*
       * Claim the row before touching SABnzbd. Once it reads `failed` the
       * reconciler stops looking at it, so a job that vanishes in the next
       * line is not mistaken for one somebody else removed.
       */
      if (
        !(await store.update(
          record.id,
          record.state,
          {
            state: "failed",
            failureClass: "blocklisted",
            failureDetail: "The release is on the blocklist.",
          },
          "Blocklisted.",
        ))
      ) {
        return false;
      }
      if (record.externalId) {
        // Only ever the job this acquisition owns, and its partial files.
        await sab
          .remove(record.externalId, {
            deleteFiles: true,
            ...(signal ? { signal } : {}),
          })
          .catch(() => undefined);
      }
      return true;
    },

    async setPaused(acquisitionId, paused, signal) {
      const { job } = await ownedQueueJob(acquisitionId, signal);
      await (paused
        ? sab.pauseJob(job.nzoId, signal)
        : sab.resumeJob(job.nzoId, signal));
    },

    async move(acquisitionId, index, signal) {
      const { job, queueLength } = await ownedQueueJob(acquisitionId, signal);
      // Past the end means last; SABnzbd itself refuses a place it lacks.
      const place = Math.max(0, Math.min(index, queueLength - 1));
      // SABnzbd answers a move onto its own place as a failure.
      if (job.queuePosition === place) return place;
      return sab.moveJob(job.nzoId, place, signal);
    },

    async cancel(acquisitionId, signal) {
      const record = await store.get(acquisitionId);
      if (!record) return;
      if (record.state === "downloaded") {
        // The bytes exist. Pretending otherwise would be a lie the filesystem
        // could contradict.
        throw new Error("A completed acquisition cannot be cancelled.");
      }
      if (record.externalId) {
        // Only ever the job this acquisition owns.
        await sab
          .remove(record.externalId, {
            deleteFiles: true,
            ...(signal ? { signal } : {}),
          })
          .catch(() => undefined);
      }
      await store.update(
        record.id,
        record.state,
        { state: "cancelled", failureClass: "cancelled" },
        "Cancelled.",
      );
    },
  };
}
