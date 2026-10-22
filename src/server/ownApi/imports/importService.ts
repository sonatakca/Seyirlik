/**
 * Carrying out an import, and finding out what happened when it was
 * interrupted.
 *
 * The commit protocol is the whole of this file, and it exists because a
 * filesystem and a database cannot be committed together. The ordering below
 * is chosen so that every point at which the process can die leaves evidence a
 * later process can read and act on without guessing.
 *
 *   1  stage      link, copy or move every source to a name beside its
 *                 destination that only this import would have used
 *   2  remember   record each staged file's identity, while it is still staged
 *   3  declare    write `committing` — before the first activation, never after
 *   4  activate   rename staging to the destination, refusing to replace
 *   5  commit     record each file committed; the unique index decides
 *   6  conclude   write `committed` once every file has been
 *
 * Step 2 is what makes the rest recoverable. A rename preserves a file's
 * identity, so the identity of the staged file *is* the identity the
 * destination will have. A process that restarts inside step 4, with no idea
 * whether the rename happened, can therefore look at the destination and know
 * from one `stat` whether the file there is its own work or a stranger's.
 *
 * Step 3 sits before step 4 for the reason the state machine is shaped the way
 * it is: a crash between them has to look like "this may have happened", and a
 * crash after them must never look like "this never started".
 *
 * Staging is deliberately a separate pass over every file rather than being
 * interleaved with activation. It means the window in which the library is
 * half-written is as short as the renames, not as long as the copies.
 */
import {
  fileTargetsFor,
  isRefusal,
  planMediaDestination,
  planSubtitleDestination,
  withKey,
  type DestinationTarget,
} from "./importDestination";
import {
  chooseStrategy,
  ImportOperationError,
  isStagingName,
  retirementNameFor,
  stagingNameFor,
  type ImportOperations,
  type StrategyPolicy,
} from "./importOperations";
import { inspectSource, type RootedReadFileSystem } from "./importSource";
import type { ImportFileRecord, ImportRepository } from "./importRepository";
import { DestinationAlreadyCommittedError } from "./importRepository";
import {
  isImported,
  retainsSourceBytes,
  type ImportFailureClass,
  type ImportState,
  type ImportStrategy,
} from "./importState";

export interface ImportServiceOptions {
  readonly repository: ImportRepository;
  /** Built per import, from the roots frozen onto its row. */
  readonly operationsFor: (
    sourceRoot: string,
    libraryRoot: string,
  ) => ImportOperations;
  readonly sourceFileSystemFor: (sourceRoot: string) => RootedReadFileSystem;
  /** What the target will be called in the library. */
  readonly targetFor: (importId: string) => Promise<DestinationTarget | null>;
  readonly policy?: StrategyPolicy;
}

export interface ImportOutcome {
  readonly state: string;
  readonly committed: number;
  readonly failed: number;
  readonly detail?: string;
}

export interface ImportService {
  /** Reads the download and writes the file plan. Mutates no media. */
  plan(importId: string): Promise<ImportOutcome>;
  /** Carries out the plan. Safe to call again after any interruption. */
  execute(importId: string): Promise<ImportOutcome>;
  /**
   * Decides what actually happened to an import whose outcome is unknown.
   *
   * Reads the filesystem; the only media it may write is an activation it can
   * prove was already this import's own remaining work.
   */
  reconcile(importId: string): Promise<ImportOutcome>;
  /** Removes source data, once the destination is proven durable. */
  cleanup(importId: string): Promise<ImportOutcome>;
}

const DEFAULT_POLICY: StrategyPolicy = { retainSource: false };

export function createImportService({
  repository,
  operationsFor,
  sourceFileSystemFor,
  targetFor,
  policy = DEFAULT_POLICY,
}: ImportServiceOptions): ImportService {
  async function settle(
    importId: string,
    from: ImportState,
    to: "failed" | "needs_attention",
    failure: ImportFailureClass,
    detail: string,
  ): Promise<ImportOutcome> {
    await repository.update(
      importId,
      from,
      { state: to, failureClass: failure, failureDetail: detail },
      detail,
    );
    return { state: to, committed: 0, failed: 1, detail };
  }

  function operationalFrom(error: unknown): ImportOperationError {
    return error instanceof ImportOperationError
      ? error
      : new ImportOperationError(
          "unknown",
          error instanceof Error ? error.message : String(error),
        );
  }

  /**
   * Removes the staging this import created, and nothing else.
   *
   * Staging is inert — no reader can mistake it for library media — but an
   * import that gave up is not entitled to leave litter in somebody's library,
   * and a later attempt would discard it anyway. Only ever called before the
   * declaration, so there is nothing here that a destination might depend on.
   */
  async function discardStagingFor(
    operations: ImportOperations,
    idempotencyKey: string,
    files: readonly ImportFileRecord[],
  ): Promise<void> {
    for (const file of files) {
      if (!file.destinationRelative || file.state === "committed") continue;
      await operations
        .discardStaging(
          stagingNameFor(idempotencyKey, file.destinationRelative),
        )
        .catch(() => undefined);
      await operations
        .discardStaging(
          retirementNameFor(idempotencyKey, file.destinationRelative),
        )
        .catch(() => undefined);
    }
  }

  /**
   * Puts one file beside its destination and records what it now is.
   *
   * Claims the row first. Staging is the only phase with no other lock on it,
   * and without a claim a second worker discards the first one's half-written
   * staging file — after which the first activates nothing and the library
   * ends up empty rather than merely duplicated. Returns false when another
   * worker holds the file.
   */
  async function stageFile(
    operations: ImportOperations,
    idempotencyKey: string,
    file: ImportFileRecord,
    strategy: ImportStrategy,
  ): Promise<boolean> {
    if (
      !(await repository.updateFile(
        file.id,
        "planned",
        { state: "staging", strategy },
        "Claimed for staging.",
      ))
    ) {
      return false;
    }

    const destination = file.destinationRelative!;
    const staged = stagingNameFor(idempotencyKey, destination);
    await operations.ensureDirectory(destination);

    /*
     * Any staging left by an interrupted attempt is discarded rather than
     * built upon. Its length is not evidence that its contents are complete.
     */
    if (await operations.exists(staged)) {
      await operations.discardStaging(staged);
    }

    if (strategy === "hardlink") {
      await operations.hardlink(file.sourceRelative, staged);
    } else if (strategy === "copy") {
      await operations.copy(file.sourceRelative, staged);
    } else {
      await operations.move(file.sourceRelative, staged);
    }

    const identity = await operations.identity(staged);
    if (!identity) {
      throw new ImportOperationError(
        "commit-ambiguous",
        "The staged file could not be identified after it was written.",
        true,
      );
    }
    await repository.updateFile(
      file.id,
      "staging",
      { state: "staged", strategy, destinationIdentity: identity.key },
      "Staged beside its destination.",
    );
    return true;
  }

  /**
   * Renames one staged file into place, or adopts the work if it is done.
   *
   * The adoption branch is what makes a retry after an unknown outcome safe:
   * the destination is examined before anything is written, and a file whose
   * identity matches this import's staged file is this import's own activation
   * rather than an obstacle.
   */
  async function activateFile(
    operations: ImportOperations,
    idempotencyKey: string,
    file: ImportFileRecord,
    strategy: ImportStrategy,
    upgrade: boolean,
  ): Promise<"committed" | "occupied" | "replaced"> {
    const destination = file.destinationRelative!;
    const staged = stagingNameFor(idempotencyKey, destination);

    const retired = retirementNameFor(idempotencyKey, destination);

    /*
     * An interrupted replacement is finished rather than restarted. The old
     * file is already aside under a name that says which import moved it, so
     * the only thing left is to put the new one in place.
     */
    const present = await operations.identity(destination);
    if (present) {
      if (
        file.destinationIdentity &&
        present.key === file.destinationIdentity
      ) {
        try {
          await repository.commitFile(
            file.id,
            file.state,
            present.key,
            strategy,
          );
        } catch (error) {
          if (!(error instanceof DestinationAlreadyCommittedError)) throw error;
        }
        // Whatever was staged is now redundant; the destination is the file.
        await operations.discardStaging(staged).catch(() => undefined);
        await operations.discardStaging(retired).catch(() => undefined);
        return "committed";
      }

      /*
       * Something else is at the destination. Whether that may be replaced is
       * not this function's judgement: an import replaces media only when it
       * was told the release is an upgrade, and only when the file it would
       * replace is one Seyirlik itself put there.
       */
      if (!upgrade) return "occupied";
      const owner = file.destinationKey
        ? await repository.findCommittedDestination(file.destinationKey)
        : null;
      if (!owner) return "occupied";

      /*
       * Aside, not deleted. The old bytes stay whole under a retirement name
       * until the replacement is recorded, so a crash in the two syscalls
       * between here and the activation leaves both files on disk under names
       * that say exactly what they are.
       */
      await operations.retire(destination, retired);
    }

    const identity =
      file.destinationIdentity ?? (await operations.identity(staged))?.key;
    if (!identity) {
      throw new ImportOperationError(
        "commit-ambiguous",
        "The staged file vanished before it could be activated.",
        true,
      );
    }

    const replacing = await operations.exists(retired);
    if (replacing && file.destinationKey) {
      /*
       * The row for the file just renamed aside still claims this destination,
       * and the unique index counts only committed rows — so until it is
       * superseded the replacement cannot be recorded at all.
       */
      await repository.supersedeCommittedDestination(
        file.destinationKey,
        file.id,
      );
    }
    await operations.activate(staged, destination);
    try {
      await repository.commitFile(file.id, file.state, identity, strategy);
    } catch (error) {
      if (error instanceof DestinationAlreadyCommittedError) {
        /*
         * Another import owns this destination in the record even though this
         * one just wrote it. Not resolved here and not undone here: a person
         * is shown two imports claiming one file.
         */
        return "occupied";
      }
      throw error;
    }
    /*
     * Only now. The replacement is recorded, so the file it replaced is no
     * longer the library's last valid copy of anything.
     */
    if (replacing) {
      await operations.discardStaging(retired).catch(() => undefined);
      return "replaced";
    }
    return "committed";
  }

  const service: ImportService = {
    async plan(importId) {
      const record = await repository.get(importId);
      if (!record) return { state: "missing", committed: 0, failed: 0 };
      // The optimistic claim. A second worker's update matches no row, so it
      // stops here before reading anything.
      if (
        !(await repository.update(
          record.id,
          record.state,
          { state: "validating", attempt: record.attempt + 1 },
          "Reading the download.",
        ))
      ) {
        return { state: record.state, committed: 0, failed: 0 };
      }

      const inspection = await inspectSource({
        fileSystem: sourceFileSystemFor(record.sourceRoot),
        relative: record.sourceRelative,
      });
      if (inspection.problem) {
        const detail = inspection.detail ?? "The download cannot be imported.";
        const wantsAPerson =
          inspection.problem === "no-media-found" ||
          inspection.problem === "source-missing";
        return settle(
          record.id,
          "validating",
          wantsAPerson ? "needs_attention" : "failed",
          inspection.problem,
          detail,
        );
      }

      const target = await targetFor(record.id);
      if (!target) {
        return settle(
          record.id,
          "validating",
          "needs_attention",
          "name-unrepresentable",
          "The import names no target to file this under.",
        );
      }

      const operations = operationsFor(record.sourceRoot, record.libraryRoot);
      const choice = chooseStrategy(
        await operations.probeHardlink(),
        policy,
        await operations.probeRename(),
      );

      // Which file is filed as what. For a season pack this is where the
      // pack is explored, and anything not the season's is left in place.
      const targets = fileTargetsFor(
        target,
        inspection.media.filter((file) => isImported(file.role)),
        inspection.subtitles.filter((file) => isImported(file.role)),
      );
      if (isRefusal(targets)) {
        return settle(
          record.id,
          "validating",
          "needs_attention",
          targets.problem,
          targets.detail,
        );
      }

      const planned = [];
      for (const { file, target: fileTarget } of targets.files) {
        const name = file.relative.split("/").at(-1) ?? file.relative;
        const outcome = withKey(
          record.libraryRoot,
          file.role === "media"
            ? planMediaDestination(fileTarget, name)
            : planSubtitleDestination(fileTarget, name),
        );
        if (isRefusal(outcome)) {
          return settle(
            record.id,
            "validating",
            "needs_attention",
            outcome.problem,
            outcome.detail,
          );
        }
        planned.push({
          role: file.role,
          sourceRelative: file.relative,
          destinationRelative: outcome.relative,
          destinationKey: outcome.key,
          sizeBytes: file.sizeBytes,
          sourceMtimeMs: file.mtimeMs,
        });
      }

      /*
       * Two files planned onto one destination is a plan that cannot be
       * carried out, and saying so now is better than finding out after half
       * of it has been.
       */
      if (
        new Set(planned.map((file) => file.destinationKey)).size !==
        planned.length
      ) {
        return settle(
          record.id,
          "validating",
          "needs_attention",
          "destination-occupied",
          "Two files in this download would be filed under one name.",
        );
      }

      /*
       * A re-plan supersedes the previous one rather than adding to it. An
       * operator retrying a failed import would otherwise get two rows per
       * file — and against the real schema, a unique violation.
       */
      const existing = await repository.listFiles(record.id);
      const known = new Set(
        existing.map((file) => file.destinationKey ?? file.sourceRelative),
      );
      const fresh = planned.filter(
        (file) => !known.has(file.destinationKey ?? file.sourceRelative),
      );
      if (fresh.length > 0) await repository.addFiles(record.id, fresh);
      // Anything that failed last time is offered to this attempt again.
      for (const file of existing) {
        // `staging` here is a claim whose worker never came back.
        if (file.state === "failed" || file.state === "staging") {
          await repository.updateFile(
            file.id,
            file.state,
            { state: "planned" },
            "Re-planned.",
          );
        }
      }
      const leftBehind = targets.leftBehind
        .map((file) => `${file.relative} ${file.reason}`)
        .join("; ");
      await repository.update(
        record.id,
        "validating",
        { state: "staging", strategy: choice.strategy },
        leftBehind
          ? `${choice.reason} Left in the download: ${leftBehind}.`
          : choice.reason,
      );
      return {
        state: "staging",
        committed: 0,
        failed: 0,
        detail: choice.reason,
      };
    },

    async execute(importId) {
      const record = await repository.get(importId);
      if (!record) return { state: "missing", committed: 0, failed: 0 };
      /*
       * `committing` is accepted as well as `staging`, because a process that
       * died inside step 4 left the row there and the remaining work is the
       * same work. Every other state belongs to somebody else.
       */
      if (record.state !== "staging" && record.state !== "committing") {
        return { state: record.state, committed: 0, failed: 0 };
      }

      const operations = operationsFor(record.sourceRoot, record.libraryRoot);
      const strategy = (record.strategy ?? "copy") as ImportStrategy;

      // ---- steps 1 and 2: stage everything, and remember what it is.
      if (record.state === "staging") {
        for (const file of await repository.listFiles(importId)) {
          if (file.state !== "planned" || !file.destinationRelative) continue;
          try {
            await stageFile(operations, record.idempotencyKey, file, strategy);
          } catch (error) {
            const operational = operationalFrom(error);
            if (operational.ambiguous) {
              await repository.update(
                importId,
                "staging",
                {
                  state: "uncertain",
                  failureClass: "commit-ambiguous",
                  failureDetail: operational.message,
                },
                "The filesystem gave no usable answer while staging.",
              );
              return { state: "uncertain", committed: 0, failed: 1 };
            }
            await repository.updateFile(
              file.id,
              file.state,
              {
                state: "failed",
                failureClass: operational.failure,
                failureDetail: operational.message,
              },
              operational.message,
            );
            /*
             * Nothing has been activated yet, so this really is a failure and
             * saying so is a claim that has been checked. The staging this
             * attempt created goes with it.
             */
            await discardStagingFor(
              operations,
              record.idempotencyKey,
              await repository.listFiles(importId),
            );
            return settle(
              importId,
              "staging",
              operational.failure === "destination-occupied"
                ? "needs_attention"
                : "failed",
              operational.failure,
              operational.message,
            );
          }
        }

        /*
         * The declaration waits for every file, including any another worker
         * is still staging. Declaring while a file is half-copied would let
         * this worker activate an incomplete file.
         */
        const ready = await repository.listFiles(importId);
        if (
          ready.some(
            (file) =>
              file.destinationRelative &&
              file.state !== "staged" &&
              file.state !== "committed" &&
              file.state !== "skipped",
          )
        ) {
          return { state: "staging", committed: 0, failed: 0 };
        }

        // ---- step 3: the declaration, before the first rename.
        if (
          !(await repository.update(
            importId,
            "staging",
            { state: "committing" },
            "Everything is staged; activating.",
          ))
        ) {
          return { state: "staging", committed: 0, failed: 0 };
        }
      }

      /*
       * Every destination is judged before any of them is written.
       *
       * Deciding per file as the loop reached it meant a subtitle could be
       * published beside a film the import turned out not to own, because the
       * subtitle sorted first. An import either claims the whole release or
       * leaves the library exactly as it found it.
       */
      const pending = await repository.listFiles(importId);
      for (const file of pending) {
        if (file.state === "committed" || !file.destinationRelative) continue;
        const present = await operations.identity(file.destinationRelative);
        if (!present) continue;
        if (present.key === file.destinationIdentity) continue;
        const owner = file.destinationKey
          ? await repository.findCommittedDestination(file.destinationKey)
          : null;
        // Replaceable only if this system put it there and was told to.
        if (record.isUpgrade && owner) continue;
        await discardStagingFor(operations, record.idempotencyKey, pending);
        return settle(
          importId,
          "committing",
          "needs_attention",
          "destination-occupied",
          "A destination holds a file this import did not put there.",
        );
      }

      // ---- steps 4 and 5: activate, and record each as committed.
      let committed = 0;
      let occupied = 0;
      for (const file of await repository.listFiles(importId)) {
        if (file.state === "committed") {
          committed += 1;
          continue;
        }
        if (!file.destinationRelative) continue;
        try {
          const result = await activateFile(
            operations,
            record.idempotencyKey,
            file,
            strategy,
            record.isUpgrade,
          );
          if (result === "occupied") occupied += 1;
          else committed += 1;
        } catch (error) {
          const operational = operationalFrom(error);
          if (operational.ambiguous) {
            await repository.update(
              importId,
              "committing",
              {
                state: "uncertain",
                failureClass: "commit-ambiguous",
                failureDetail: operational.message,
              },
              "The filesystem gave no usable answer while activating.",
            );
            return { state: "uncertain", committed, failed: 1 };
          }
          if (operational.failure === "destination-occupied") {
            occupied += 1;
            continue;
          }
          /*
           * Not `failed`: the row is in `committing`, so some activation may
           * already have happened and only reconciliation may say otherwise.
           */
          await repository.update(
            importId,
            "committing",
            {
              state: "uncertain",
              failureClass: operational.failure,
              failureDetail: operational.message,
            },
            operational.message,
          );
          return { state: "uncertain", committed, failed: 1 };
        }
      }

      if (occupied > 0) {
        await discardStagingFor(
          operations,
          record.idempotencyKey,
          await repository.listFiles(importId),
        );
        return settle(
          importId,
          "committing",
          "needs_attention",
          "destination-occupied",
          "A destination holds a file this import did not put there.",
        );
      }

      await repository.update(
        importId,
        "committing",
        { state: "committed", committed: true },
        "Every file is at its destination.",
      );
      return { state: "committed", committed, failed: 0 };
    },

    async reconcile(importId) {
      const record = await repository.get(importId);
      if (!record) return { state: "missing", committed: 0, failed: 0 };
      if (record.state !== "committing" && record.state !== "uncertain") {
        return { state: record.state, committed: 0, failed: 0 };
      }

      const operations = operationsFor(record.sourceRoot, record.libraryRoot);
      const strategy = (record.strategy ?? "copy") as ImportStrategy;
      const files = await repository.listFiles(importId);
      let committed = 0;
      let unactivated = 0;
      let occupied = false;

      for (const file of files) {
        if (file.state === "committed") {
          committed += 1;
          continue;
        }
        if (!file.destinationRelative || !file.destinationIdentity) {
          // Never staged, so no rename can have happened for it.
          unactivated += 1;
          continue;
        }

        const actual = await operations.identity(file.destinationRelative);
        if (actual === null) {
          unactivated += 1;
          continue;
        }
        if (actual.key === file.destinationIdentity) {
          /*
           * This import's own work, finished by a process that died before it
           * could say so. Resolved by recording what is already true.
           */
          try {
            await repository.commitFile(
              file.id,
              file.state,
              actual.key,
              (file.strategy ?? strategy) as ImportStrategy,
            );
            /*
             * The staging and any retired file are now redundant: the
             * destination is the file, and it is recorded as such.
             */
            for (const spent of [
              stagingNameFor(record.idempotencyKey, file.destinationRelative),
              retirementNameFor(
                record.idempotencyKey,
                file.destinationRelative,
              ),
            ]) {
              await operations.discardStaging(spent).catch(() => undefined);
            }
            committed += 1;
          } catch (error) {
            if (error instanceof DestinationAlreadyCommittedError) {
              occupied = true;
            } else {
              throw error;
            }
          }
          continue;
        }
        // Present, and not ours. Never overwritten and never counted as done.
        occupied = true;
      }

      if (occupied) {
        return settle(
          importId,
          record.state,
          "needs_attention",
          "destination-occupied",
          "The destination holds a file this import did not put there.",
        );
      }

      if (unactivated > 0) {
        /*
         * Some file was never renamed, so the import is not finished. It goes
         * back to work rather than being called failed — which would be a
         * claim about a destination that demonstrably does not exist, made by
         * the one function that actually looked.
         */
        const to = record.state === "committing" ? "uncertain" : "staging";
        await repository.update(
          importId,
          record.state,
          { state: to },
          "Not every destination was activated; the rest can be repeated.",
        );
        return { state: to, committed, failed: unactivated };
      }

      await repository.update(
        importId,
        record.state,
        { state: "committed", committed: true },
        "Every destination was already in place.",
      );
      return { state: "committed", committed, failed: 0 };
    },

    async cleanup(importId) {
      const record = await repository.get(importId);
      if (!record) return { state: "missing", committed: 0, failed: 0 };
      if (record.state !== "committed") {
        return { state: record.state, committed: 0, failed: 0 };
      }
      if (
        !(await repository.update(
          importId,
          "committed",
          { state: "cleaning" },
          "Tidying the download.",
        ))
      ) {
        return { state: record.state, committed: 0, failed: 0 };
      }

      const operations = operationsFor(record.sourceRoot, record.libraryRoot);
      const strategy = (record.strategy ?? "copy") as ImportStrategy;
      const files = await repository.listFiles(importId);

      /*
       * Cleanup failure is reported against the source and never against the
       * commit. The library object is exactly as valid either way, and an
       * import that called itself broken because a download folder would not
       * delete is the failure this separation exists to prevent.
       */
      let removed = 0;
      let refused = 0;
      if (retainsSourceBytes(strategy) && !policy.retainSource) {
        for (const file of files) {
          if (file.state !== "committed") continue;
          try {
            await operations.removeSource(file.sourceRelative);
            removed += 1;
          } catch {
            refused += 1;
          }
        }
      }

      await repository.update(
        importId,
        "cleaning",
        { state: "complete" },
        refused === 0
          ? `Cleanup removed ${removed} source file(s).`
          : `Cleanup removed ${removed} source file(s); ${refused} could not be removed and were left.`,
      );
      return {
        state: "complete",
        committed: files.filter((file) => file.state === "committed").length,
        failed: 0,
      };
    },
  };

  return service;
}

/** Whether a path is one an import may delete inside the library. */
export const mayDiscard = isStagingName;
