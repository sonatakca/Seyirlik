/**
 * Imports on the existing leased job queue.
 *
 * Not a second background system. The queue already has durable leases,
 * heartbeats, restart recovery and per-lane concurrency, and an import that
 * survives a service restart is exactly what those were built for.
 *
 * Two handlers. One carries a single import as far as it can get; the other
 * sweeps the rows whose filesystem outcome nobody knows. (A third, beside
 * them, hands what was imported to processing.) Everything else —
 * retry, backoff, escalation — is a consequence of those two running again,
 * which is what makes the pair safe to re-run at any moment.
 */
import type { JobHandler } from "../tasks/worker";
import { PermanentJobError } from "../tasks/worker";
import type { ImportRecord, ImportRepository } from "./importRepository";
import type { ImportProcessingSweepResult } from "./importProcessing";
import type { ImportService } from "./importService";
import {
  dispositionFor,
  planImportRetry,
  type ImportFailureClass,
} from "./importState";

export const IMPORT_JOB_TYPES = {
  run: "import.run",
  reconcile: "import.reconcile",
  handoff: "import.handoff",
  process: "import.process",
} as const;

export interface ImportJobExtras {
  /**
   * Plans an import for every finished download that has none yet.
   *
   * Absent when there is no download client: then nothing finishes
   * downloading, and there is nothing to hand off.
   */
  readonly handOff?: () => Promise<{ started: number; refused: number }>;
  /**
   * Told once an import has put its files in the library, so the library can
   * be read again. Failing here does not fail the import: the files are
   * already where they belong.
   */
  readonly onImported?: (record: ImportRecord) => Promise<void>;
  /**
   * Queues processing for imported files the library has registered.
   *
   * Absent when automatic processing is switched off, or when this process
   * does not run the encoder.
   */
  readonly queueProcessing?: () => Promise<ImportProcessingSweepResult>;
}

export function createImportJobHandlers(
  service: ImportService,
  repository: ImportRepository,
  { handOff, onImported, queueProcessing }: ImportJobExtras = {},
): Record<string, JobHandler> {
  const announce = async (record: ImportRecord | null) => {
    if (!record || !onImported) return;
    if (record.state !== "committed" && record.state !== "complete") return;
    await onImported(record).catch(() => undefined);
  };

  const run: JobHandler = async ({ job, reportProgress }) => {
    const importId = job.payload.importId;
    if (typeof importId !== "string") {
      throw new PermanentJobError("The task payload names no import.");
    }
    const record = await repository.get(importId);
    // A deleted import is not a transient fault; retrying cannot make it
    // exist, and the queue would otherwise keep trying.
    if (!record) throw new PermanentJobError("The import no longer exists.");

    /*
     * Progress is reported by phase and by files finished, never as a
     * percentage of bytes. `copyFile` gives no byte-level progress, and a
     * fraction invented from the file count would claim a precision the
     * operation does not have.
     */
    await reportProgress(0, "Reading the download");
    if (record.state === "planned" || record.state === "failed") {
      await service.plan(importId);
    }

    await reportProgress(0.2, "Putting files beside their destinations");
    const executed = await service.execute(importId);

    const after = await repository.get(importId);
    const total = (await repository.listFiles(importId)).length || 1;
    await reportProgress(
      Math.min(0.9, 0.2 + (0.7 * executed.committed) / total),
      `Committed ${executed.committed} of ${total} file(s)`,
    );

    if (after?.state === "committed") {
      await reportProgress(0.95, "Tidying the download");
      await service.cleanup(importId);
    }

    const finished = await repository.get(importId);
    await announce(finished);
    return {
      state: finished?.state ?? executed.state,
      committed: executed.committed,
      ...(finished?.failureClass
        ? { failureClass: finished.failureClass }
        : {}),
    };
  };

  const reconcile: JobHandler = async ({ reportProgress }) => {
    await reportProgress(0, "Checking imports whose outcome is unknown");
    const unknown = await repository.listUncertain();

    let resolved = 0;
    let stillUnknown = 0;
    for (const record of unknown) {
      const outcome = await service.reconcile(record.id);
      if (outcome.state === "committed" || outcome.state === "complete") {
        resolved += 1;
        await announce(await repository.get(record.id));
      } else if (
        outcome.state === "uncertain" ||
        outcome.state === "committing"
      ) {
        stillUnknown += 1;
      }
    }

    /*
     * Deciding what to do about a failure happens here, once, after the facts
     * are in — so a row cannot be retried by the reconciler and by a failure
     * handler at the same time.
     */
    let retried = 0;
    let escalated = 0;
    for (const record of await repository.list(200)) {
      if (record.state !== "failed" || !record.failureClass) continue;
      const failure = record.failureClass as ImportFailureClass;
      if (dispositionFor(failure) === "terminal") continue;
      const plan = planImportRetry(failure, record.attempt);
      if (plan.action === "retry") {
        if (
          await repository.update(
            record.id,
            "failed",
            { state: "planned", retryAfterMs: Date.now() + plan.delayMs },
            plan.detail,
          )
        ) {
          retried += 1;
        }
      } else if (plan.action === "attention") {
        if (
          await repository.update(
            record.id,
            "failed",
            {
              state: "needs_attention",
              failureClass: failure,
              failureDetail: plan.detail,
            },
            plan.detail,
          )
        ) {
          escalated += 1;
        }
      }
    }

    return {
      examined: unknown.length,
      resolved,
      stillUnknown,
      retried,
      escalated,
    };
  };

  const handoff: JobHandler = async ({ reportProgress }) => {
    if (!handOff) return { started: 0, refused: 0 };
    await reportProgress(0, "Handing finished downloads to the importer");
    return handOff();
  };

  const processImported: JobHandler = async ({ reportProgress }) => {
    if (!queueProcessing) return { examined: 0 };
    await reportProgress(0, "Queueing imported files for processing");
    return { ...(await queueProcessing()) };
  };

  return {
    [IMPORT_JOB_TYPES.run]: run,
    [IMPORT_JOB_TYPES.reconcile]: reconcile,
    [IMPORT_JOB_TYPES.handoff]: handoff,
    [IMPORT_JOB_TYPES.process]: processImported,
  };
}
