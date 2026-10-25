import path from "node:path";
import {
  checkpointRoot,
  listCompletedEpochIndexes,
  readEpochManifest,
  readEpochPlanFile,
  type EpochCheckpointManifest,
} from "../../../renditions/adaptive/epochs/checkpoints";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import { formatClock } from "../../../renditions/adaptive/epochs/engine";
import {
  createFileRenditionRegistryStore,
  upsertRegistrySource,
  type RenditionRegistryStore,
} from "../../../renditions/registry";
import type { RenditionPaths } from "../../../renditions/analysis";

/**
 * What a job may truthfully be told it recovered.
 *
 * The message that motivated this file said:
 *
 *   "Storage is available again; encoding continues from the last durable
 *    checkpoint. Only the five-minute epoch that was interrupted is built
 *    again."
 *
 * It was emitted unconditionally, by a requeue path, immediately after
 * `beginAttempt` had reset `completed_epochs`, `epoch_index`,
 * `protected_seconds` and `encoded_seconds` to zero. So the sentence was not
 * merely optimistic, it was the opposite of the row it sat next to. An operator
 * reading the history saw two hours of protected work described where the
 * canonical state recorded none, and nothing anywhere had looked at a
 * checkpoint to decide either way.
 *
 * The correction is not to soften the wording. It is to *ask the disk*, which
 * is where durable progress actually lives, and to say what it answers. The
 * checkpoint store below has always been trustworthy — an epoch becomes durable
 * by an atomic rename performed after its manifest is written, and validating
 * one re-checks every file it names for presence and size. Nothing consulted it
 * at recovery time.
 *
 * Cheap by construction: one directory listing and a small JSON file per
 * completed epoch. It never opens a media file, which matters because this runs
 * at exactly the moment a volume is least worth exercising.
 */

export interface CheckpointRecovery {
  /** Epochs with a manifest on disk, in order. */
  completedEpochs: number[];
  /** Media time those epochs cover, from their own manifests. */
  protectedSeconds: number;
  /** The first epoch that must be encoded. */
  nextEpochIndex: number;
  /** Where the next epoch starts on the source timeline, when it is known. */
  resumeAtSeconds: number | null;
  /** Epochs the plan contains, when a plan is on disk. */
  plannedEpochs: number | null;
  /** Manifests that named a salvaged interval, so a recovery cannot hide one. */
  salvagedEpochs: number[];
  /** The directory inspected. Never shown to a browser. */
  root: string;
  /** True when no checkpoint root exists at all. */
  absent: boolean;
}

export interface CheckpointTruthInput {
  paths: Pick<RenditionPaths, "workRoot" | "stateRoot">;
  /** Stable processing-job id; older/offline workspaces use the media id. */
  workspaceId?: string;
  relativePath: string;
  sourceFingerprint: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Where the registry is kept; `<stateRoot>/registry.json` when omitted. */
  registry?: RenditionRegistryStore;
}

/**
 * Reads what is genuinely on disk for a job.
 *
 * Returns an empty recovery rather than throwing when the work root is not
 * reachable. A volume that has gone is a volume with no recoverable
 * checkpoints *as far as anyone can currently tell*, and the honest thing to
 * say then is "none", never "the last one".
 */
export async function readCheckpointRecovery({
  paths,
  workspaceId,
  relativePath,
  sourceFingerprint,
  sizeBytes,
  mtimeMs,
  registry: registryStore = createFileRenditionRegistryStore(
    path.join(paths.stateRoot, "registry.json"),
  ),
}: CheckpointTruthInput): Promise<CheckpointRecovery> {
  /*
   * The media id is the registry's, because that is the id the checkpoint root
   * was named with. Deriving it any other way would look in a directory the
   * encoder never wrote to and conclude, wrongly but confidently, that no work
   * survived.
   */
  const registry = await registryStore.read().catch(() => null);
  if (!registry) {
    return {
      completedEpochs: [],
      protectedSeconds: 0,
      nextEpochIndex: 0,
      resumeAtSeconds: null,
      plannedEpochs: null,
      salvagedEpochs: [],
      root: "",
      absent: true,
    };
  }
  const item = upsertRegistrySource(registry, {
    relativePath,
    size: sizeBytes,
    mtimeMs,
    sourceFingerprint,
  });

  const root = checkpointRoot(
    paths.workRoot,
    workspaceId ?? item.id,
    ADAPTIVE_PROFILE_VERSION,
    sourceFingerprint,
  );

  const plan = await readEpochPlanFile(root).catch(() => null);
  const indexes = await listCompletedEpochIndexes(root).catch(
    (): number[] => [],
  );

  /*
   * Only a *prefix* counts. Epochs 0,1,2,7 are four directories and two hours
   * of nothing: the encode resumes at the first gap, so 7 is work that will be
   * done again, and counting it as protected would restate the same lie in
   * arithmetic instead of prose.
   */
  const contiguous: number[] = [];
  for (let index = 0; indexes.includes(index); index += 1) {
    contiguous.push(index);
  }

  const manifests: EpochCheckpointManifest[] = [];
  for (const index of contiguous) {
    const manifest = await readEpochManifest(root, index).catch(() => null);
    /*
     * A directory whose manifest cannot be read is not a checkpoint, whatever
     * its name says. The prefix ends here rather than skipping it, because
     * everything after a gap is unreachable anyway.
     */
    if (!manifest) break;
    manifests.push(manifest);
  }

  const completedEpochs = manifests.map((manifest) => manifest.epochIndex);
  const protectedSeconds = manifests.reduce(
    (total, manifest) => total + manifest.actualDurationSeconds,
    0,
  );
  const nextEpochIndex = manifests.length;
  const last = manifests[manifests.length - 1];

  return {
    completedEpochs,
    protectedSeconds,
    nextEpochIndex,
    /*
     * The next epoch's start comes from the previous one's recorded end, which
     * is an exact presentation time taken from the plan, rather than from
     * summing durations — which accumulates rounding and would put a resume
     * message a frame or two away from where the encoder actually resumes.
     */
    resumeAtSeconds: last?.endSeconds ?? (manifests.length > 0 ? null : 0),
    plannedEpochs: plan?.epochs.length ?? null,
    salvagedEpochs: manifests
      .filter((manifest) => manifest.salvage !== undefined)
      .map((manifest) => manifest.epochIndex),
    root,
    absent: plan === null && indexes.length === 0,
  };
}

/**
 * The sentence a recovery is allowed to say.
 *
 * Every branch is a statement the caller has just verified against the disk.
 * There is deliberately no wording here for "resuming from a checkpoint" that
 * can be reached without a manifest having been read, because the defect this
 * replaces was precisely a sentence that could.
 */
export function describeCheckpointRecovery(
  recovery: CheckpointRecovery,
): string {
  if (recovery.completedEpochs.length === 0) {
    return "The previous attempt was interrupted before its first durable checkpoint; processing will restart from the beginning.";
  }
  const count = recovery.completedEpochs.length;
  const noun = count === 1 ? "checkpoint" : "checkpoints";
  const salvaged =
    recovery.salvagedEpochs.length > 0
      ? ` ${recovery.salvagedEpochs.length} of them replaced an unreadable stretch of the source and are not clean film.`
      : "";
  const from =
    recovery.resumeAtSeconds === null
      ? ""
      : ` Processing resumes from ${formatClock(recovery.resumeAtSeconds)}.`;
  return `Recovered ${count} durable ${noun}.${from}${salvaged}`;
}

/**
 * The counters a job row may carry after recovery, taken from the same reading.
 *
 * `beginAttempt` zeroes the epoch position, correctly — the previous attempt's
 * figures describe an attempt that has ended. What it cannot do is know what
 * the *next* attempt will inherit, so the verified figures are written back
 * here, after the reset, and only ever from manifests that were actually read.
 */
export function checkpointCountersFor(recovery: CheckpointRecovery): {
  completedEpochs: number;
  protectedSeconds: number;
  encodedSeconds: number;
  epochIndex: number | null;
} {
  return {
    completedEpochs: recovery.completedEpochs.length,
    protectedSeconds: recovery.protectedSeconds,
    /*
     * Encoded equals protected at this instant, and saying anything else would
     * be describing an epoch that is not running yet. The figures diverge again
     * the moment the encoder reports its first sample.
     */
    encodedSeconds: recovery.protectedSeconds,
    epochIndex:
      recovery.completedEpochs.length > 0 ? recovery.nextEpochIndex : null,
  };
}
