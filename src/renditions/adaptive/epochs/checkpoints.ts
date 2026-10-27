/**
 * The durable checkpoint store.
 *
 * The contract is small and absolute: a directory named `000011` is a finished,
 * validated, immutable epoch, and a directory named `000011.partial-<pid>-<id>`
 * is work in progress that nobody may read. Nothing moves from the second name
 * to the first except an atomic rename performed after the epoch has been
 * validated and its manifest written, so a crash at any instant leaves either a
 * complete checkpoint or an obviously incomplete one — never something that
 * looks complete and is not.
 *
 * Everything else in the recovery story is built on that one invariant.
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EPOCH_AUDIO_DIRECTORY,
  EPOCH_CHECKPOINT_SCHEMA_VERSION,
  EPOCH_DIRECTORY,
  EPOCH_MANIFEST_FILE,
  EPOCH_PLAN_FILE,
  EPOCH_SUBTITLE_DIRECTORY,
  epochDirectoryName,
  parseCompletedEpochDirectory,
  parsePartialEpochDirectory,
  partialEpochDirectoryName,
} from "./policy";
import { parseEpochPlan, planMatches, type EpochPlan } from "./plan";
import type { EpochJoinKey } from "./fragments";
import type { EpochSalvageManifest, SourceInterval } from "./salvage";

/** Written inside a `.partial` directory so ownership can be established. */
export const EPOCH_OWNER_FILE = "OWNER.json";

/** How long a partial epoch may go without a heartbeat before it is abandoned. */
export const PARTIAL_LEASE_TIMEOUT_MS = 90_000;

export interface EpochOwner {
  pid: number;
  hostname: string;
  /** Distinguishes two attempts by the same long-lived server process. */
  attemptId: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface EpochRenditionRecord {
  id: string;
  qualityHeight: number;
  width: number;
  height: number;
  codec: string;
  codecString?: string;
  pixelFormat?: string;
  hdr: string;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  frameRate: number;
  /** Path of the media file relative to the epoch directory. */
  mediaPath: string;
  playlistPath: string;
  fileSizeBytes: number;
  segmentCount: number;
  /** Media time the packaged fragments actually cover, from their own boxes. */
  measuredDurationSeconds: number;
  /** Media timescale the fragments are expressed in. */
  mediaTimescale: number;
  /** SHA-256 of the whole initialisation segment. Recorded, not load-bearing. */
  initDigest: string;
  /**
   * What has to match for this epoch's fragments to join another's.
   *
   * Optional because checkpoints written before joinability was distinguished
   * from byte equality do not carry it; those are re-derived from the media
   * itself, which costs one read of a kilobyte and keeps every checkpoint an
   * operator already has valid.
   */
  joinKey?: EpochJoinKey;
}

export interface EpochCheckpointManifest {
  schemaVersion: number;
  mediaId: string;
  sourceFingerprint: string;
  adaptiveProfileVersion: string;
  timelinePolicyVersion: string;
  epochIndex: number;
  /** Exact first-frame presentation time this epoch owns, from the plan. */
  startSeconds: number;
  /** Exact first-frame presentation time of the next epoch, if there is one. */
  endSeconds: number | null;
  expectedDurationSeconds: number;
  actualDurationSeconds: number;
  encoder: string;
  renditions: EpochRenditionRecord[];
  totalBytes: number;
  checks: string[];
  /**
   * Present only on an epoch whose source could not be read.
   *
   * Its absence is what says a checkpoint holds real film. It is written into
   * the same immutable manifest as everything else so a restart, a resume or a
   * status command rediscovers *why* a stretch of the title is synthetic
   * without needing the job record that ran at the time — and so nothing can
   * quietly promote a replacement into an ordinary checkpoint.
   */
  salvage?: EpochSalvageManifest;
  completedAt: string;
}

export interface AuxiliaryStageManifest {
  schemaVersion: number;
  mediaId: string;
  sourceFingerprint: string;
  adaptiveProfileVersion: string;
  stage: "audio" | "subtitles";
  /** Identifies exactly what this stage produced, so a changed plan rebuilds. */
  streamIndexes: number[];
  /**
   * Source intervals this stage replaced with silence, if any.
   *
   * Part of the stage's identity, not a footnote: a stage built around a hole
   * must not be reused for a run that no longer believes in that hole, and a
   * healthy stage must not be reused once one has been found.
   */
  damagedIntervals?: SourceInterval[];
  /**
   * Where the audio was cut to end with the video, if it was. Part of the
   * identity too: audio that runs to the container's end must be rebuilt once
   * the video end is known.
   */
  endSeconds?: number;
  totalBytes: number;
  completedAt: string;
}

export interface CheckpointIdentity {
  mediaId: string;
  sourceFingerprint: string;
  adaptiveProfileVersion: string;
  timelinePolicyVersion: string;
}

/**
 * The directory a build's checkpoints live in.
 *
 * Keyed by profile version and source fingerprint so a re-encode after the
 * source is replaced, or after the ladder policy changes, cannot land on top of
 * the previous build's epochs.
 */
export function checkpointRoot(
  workRoot: string,
  mediaId: string,
  profileVersion: string,
  sourceFingerprint: string,
): string {
  return path.join(
    workRoot,
    mediaId,
    `${profileVersion}-${sourceFingerprint.slice(0, 16)}`,
  );
}

export function epochsRoot(root: string): string {
  return path.join(root, EPOCH_DIRECTORY);
}

export function completedEpochPath(root: string, index: number): string {
  return path.join(epochsRoot(root), epochDirectoryName(index));
}

export function audioStagePath(root: string): string {
  return path.join(root, EPOCH_AUDIO_DIRECTORY);
}

export function subtitleStagePath(root: string): string {
  return path.join(root, EPOCH_SUBTITLE_DIRECTORY);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function readEpochPlanFile(
  root: string,
): Promise<EpochPlan | null> {
  const text = await readFile(path.join(root, EPOCH_PLAN_FILE), "utf8").catch(
    () => null,
  );
  if (text === null) return null;
  try {
    return parseEpochPlan(text);
  } catch {
    return null;
  }
}

export async function writeEpochPlanFile(
  root: string,
  plan: EpochPlan,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeJsonAtomic(path.join(root, EPOCH_PLAN_FILE), plan);
}

/**
 * Loads the plan a build should use, reusing the one on disk when it belongs to
 * this build and replacing it when it does not.
 *
 * Replacing a plan discards every epoch under it: boundaries that moved make
 * the existing checkpoints unjoinable, and quietly mixing the two is precisely
 * the corruption the identity check exists to prevent.
 */
export async function reconcilePlan({
  root,
  plan,
  expected,
}: {
  root: string;
  plan: EpochPlan;
  expected: Parameters<typeof planMatches>[1];
}): Promise<{ plan: EpochPlan; reused: boolean; discardedReason?: string }> {
  const existing = await readEpochPlanFile(root);
  if (existing) {
    const verdict = planMatches(existing, expected);
    if (verdict.ok) return { plan: existing, reused: true };
    await rm(epochsRoot(root), { recursive: true, force: true });
    await rm(audioStagePath(root), { recursive: true, force: true });
    await rm(subtitleStagePath(root), { recursive: true, force: true });
    await writeEpochPlanFile(root, plan);
    return { plan, reused: false, discardedReason: verdict.reason };
  }
  await writeEpochPlanFile(root, plan);
  return { plan, reused: false };
}

export function manifestMatchesIdentity(
  manifest: EpochCheckpointManifest,
  identity: CheckpointIdentity,
): { ok: true } | { ok: false; reason: string } {
  if (manifest.schemaVersion !== EPOCH_CHECKPOINT_SCHEMA_VERSION) {
    return { ok: false, reason: "checkpoint-schema-version" };
  }
  if (manifest.mediaId !== identity.mediaId) {
    return { ok: false, reason: "media-id" };
  }
  if (manifest.sourceFingerprint !== identity.sourceFingerprint) {
    return { ok: false, reason: "source-fingerprint" };
  }
  if (manifest.adaptiveProfileVersion !== identity.adaptiveProfileVersion) {
    return { ok: false, reason: "profile-version" };
  }
  if (manifest.timelinePolicyVersion !== identity.timelinePolicyVersion) {
    return { ok: false, reason: "timeline-policy-version" };
  }
  return { ok: true };
}

export type EpochCheckpointState =
  | { status: "complete"; manifest: EpochCheckpointManifest }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

/**
 * Whether a completed epoch directory is genuinely usable.
 *
 * A manifest is not taken on trust. Every file it names is checked for presence
 * and size, because the failure this whole design exists to survive — storage
 * disappearing mid-write — is perfectly capable of leaving a manifest behind
 * and taking the media with it.
 */
export async function inspectCompletedEpoch({
  root,
  index,
  identity,
  requiredRenditionIds,
}: {
  root: string;
  index: number;
  identity: CheckpointIdentity;
  requiredRenditionIds: readonly string[];
}): Promise<EpochCheckpointState> {
  const directory = completedEpochPath(root, index);
  const manifest = await readJson<EpochCheckpointManifest>(
    path.join(directory, EPOCH_MANIFEST_FILE),
  );
  if (!manifest) {
    const present = await stat(directory).catch(() => undefined);
    return present
      ? { status: "invalid", reason: "missing-manifest" }
      : { status: "missing" };
  }
  const verdict = manifestMatchesIdentity(manifest, identity);
  if (!verdict.ok) return { status: "invalid", reason: verdict.reason };

  const present = new Set(manifest.renditions.map((entry) => entry.id));
  for (const required of requiredRenditionIds) {
    if (!present.has(required)) {
      return { status: "invalid", reason: `missing-rendition:${required}` };
    }
  }

  for (const rendition of manifest.renditions) {
    for (const relative of [rendition.mediaPath, rendition.playlistPath]) {
      const stats = await stat(
        path.join(directory, ...relative.split("/")),
      ).catch(() => undefined);
      if (!stats?.isFile() || stats.size === 0) {
        return { status: "invalid", reason: `missing-file:${relative}` };
      }
    }
    const mediaStats = await stat(
      path.join(directory, ...rendition.mediaPath.split("/")),
    );
    if (mediaStats.size !== rendition.fileSizeBytes) {
      return { status: "invalid", reason: `size-changed:${rendition.id}` };
    }
  }

  return { status: "complete", manifest };
}

export interface PartialEpochRecord {
  index: number;
  directory: string;
  name: string;
  owner: EpochOwner | null;
  active: boolean;
}

function ownerIsAlive(owner: EpochOwner | null): boolean {
  if (!owner) return false;
  if (owner.hostname !== os.hostname()) {
    // Another machine's work cannot be judged from here; leaving it alone is
    // the only safe answer, and a shared work root is not a supported layout.
    return true;
  }
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (
    Number.isFinite(heartbeat) &&
    Date.now() - heartbeat > PARTIAL_LEASE_TIMEOUT_MS
  ) {
    return false;
  }
  if (owner.pid === process.pid) {
    // This process wrote it. If the attempt were still running it would be the
    // one asking, so anything found here belongs to an attempt that has ended.
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function listPartialEpochs(
  root: string,
): Promise<PartialEpochRecord[]> {
  const directory = epochsRoot(root);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const records: PartialEpochRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const parsed = parsePartialEpochDirectory(entry.name);
    if (!parsed) continue;
    const full = path.join(directory, entry.name);
    const owner = await readJson<EpochOwner>(path.join(full, EPOCH_OWNER_FILE));
    records.push({
      index: parsed.index,
      directory: full,
      name: entry.name,
      owner,
      active: ownerIsAlive(owner),
    });
  }
  return records;
}

export async function listCompletedEpochIndexes(
  root: string,
): Promise<number[]> {
  const entries = await readdir(epochsRoot(root), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => parseCompletedEpochDirectory(entry.name))
    .filter((index): index is number => index !== null)
    .sort((left, right) => left - right);
}

/**
 * A workspace for one epoch, and the means to make it durable.
 *
 * The heartbeat is what lets a later reconciliation tell a live writer from a
 * dead one; it is refreshed on a timer rather than on progress so that an epoch
 * whose FFmpeg has stalled still reads as owned rather than as abandoned.
 */
export interface PartialEpochHandle {
  index: number;
  directory: string;
  /** Stops the heartbeat. Safe to call more than once. */
  release(): void;
  /** Validated, manifested and renamed into place. */
  promote(manifest: EpochCheckpointManifest): Promise<string>;
  /** Removes the workspace without touching anything already complete. */
  discard(): Promise<void>;
}

export async function beginPartialEpoch({
  root,
  index,
  attemptId = randomUUID(),
  heartbeatIntervalMs = 15_000,
  assertStorage,
}: {
  root: string;
  index: number;
  attemptId?: string;
  heartbeatIntervalMs?: number;
  /**
   * Proof that this checkpoint store is still on the filesystem it was.
   *
   * Called twice, and both matter. Before the epoch's working directory is
   * created, because `mkdir` with `recursive` rebuilds a vanished scratch path
   * on whatever filesystem the mount point sits on and FFmpeg would then write
   * a whole epoch there. And again before the rename that promotes the epoch,
   * because that is the moment the result becomes durable state.
   */
  assertStorage?: () => void | Promise<void>;
}): Promise<PartialEpochHandle> {
  const token = randomUUID().slice(0, 8);
  const directory = path.join(
    epochsRoot(root),
    partialEpochDirectoryName(index, process.pid, token),
  );
  await assertStorage?.();
  await mkdir(directory, { recursive: true });
  const ownerPath = path.join(directory, EPOCH_OWNER_FILE);
  const owner: EpochOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    attemptId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");

  const heartbeat = setInterval(() => {
    void writeFile(
      ownerPath,
      `${JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
      // A failing heartbeat is the mechanism working: the storage has gone, the
      // lease ages out and the next attempt reclaims the workspace.
    ).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
  };

  return {
    index,
    directory,
    release,
    async promote(manifest) {
      await assertStorage?.();
      const target = completedEpochPath(root, index);
      /*
       * The manifest is written last and inside the partial directory, so the
       * rename that publishes the epoch publishes its proof at the same
       * instant. Writing it after the rename would leave a window in which a
       * completed-looking directory has nothing to validate it.
       */
      await writeJsonAtomic(
        path.join(directory, EPOCH_MANIFEST_FILE),
        manifest,
      );
      await rm(path.join(directory, EPOCH_OWNER_FILE), { force: true });
      /*
       * A completed epoch already sitting at the target is either this same
       * work done twice or a checkpoint that was just invalidated. Either way
       * the fresh one is the one to keep, and rename onto a non-empty directory
       * fails, so the old one goes first.
       */
      await rm(target, { recursive: true, force: true });
      await rename(directory, target);
      release();
      return target;
    },
    async discard() {
      release();
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}

export interface ReconciliationOutcome {
  /** Epoch indexes with a valid, reusable checkpoint. */
  complete: number[];
  /** Epoch indexes that must be encoded. */
  pending: number[];
  /** Checkpoints that existed but could not be trusted, with the reason. */
  invalidated: Array<{ index: number; reason: string }>;
  /** Partial workspaces removed because nothing was still writing them. */
  abandoned: string[];
  /** Partial workspaces left alone because another attempt owns them. */
  active: string[];
}

/**
 * Brings disk state and plan into agreement before any work starts.
 *
 * Idempotent by construction: it only ever removes partial workspaces nobody
 * owns and checkpoints that failed their own identity or presence checks, so
 * running it twice in a row does the same thing as running it once.
 */
/**
 * One epoch's encoder configuration, as a single comparable string.
 *
 * Every rendition's join key in plan order, because a ladder can disagree on
 * one rung and agree on the rest — the 1440p rung is where this was found, and
 * checking only the first rung would have let a 480p difference through to the
 * same failure two hours later.
 *
 * `null` when the epoch predates join keys being recorded. Those are compared
 * by nothing and kept, which is the existing contract: they are re-derived from
 * the media itself at assembly time.
 */
function encoderConfigSignature(
  manifest: EpochCheckpointManifest,
): string | null {
  const parts: string[] = [];
  for (const rendition of manifest.renditions) {
    const key = rendition.joinKey;
    if (!key) return null;
    parts.push(
      [
        rendition.id,
        key.mediaTimescale,
        key.sampleFormat,
        key.width,
        key.height,
        key.configDigest,
      ].join(":"),
    );
  }
  return parts.length > 0 ? parts.join("|") : null;
}

/**
 * Drops checkpoints an encoder change has left unjoinable.
 *
 * A checkpointed encode assumes the encoder's configuration is stable for the
 * life of the job, and nothing enforced that. Deploying a performance change
 * mid-job is enough to break it: measured on this system, a QSV preset change
 * landed at 02:57 between epoch 2 and epoch 3 of a twenty-two epoch title, and
 * the new parameter sets gave epochs 3-21 a different `configDigest` from
 * epochs 0-2. Every epoch encoded successfully. The job then spent two hours
 * finishing, reached assembly, and failed — "epoch 3 wrote 1440p with a
 * different decoder configuration from the reference" — four times over,
 * because the only thing that ever compared the two groups was the assembler,
 * and by then all the work was already paid for.
 *
 * So the comparison moves to the front, where it costs nothing: the manifests
 * already record each rendition's join key, so the groups are visible before a
 * single frame is re-encoded.
 *
 * **The newest group wins**, not the largest. Both rules keep epochs 3-21 here,
 * and only this one converges: the newest epochs were written by the most
 * recent configuration, which is the one this attempt is about to use, so the
 * epochs that survive are the ones the next ones will match. Keeping the
 * largest group would discard nineteen good epochs whenever the *first* few
 * happened to outnumber them, and could oscillate between two attempts.
 */
async function dropEpochsFromAnotherEncoderConfiguration(
  root: string,
  complete: readonly number[],
): Promise<Array<{ index: number; reason: string }>> {
  if (complete.length < 2) return [];

  const groups = new Map<string, { indexes: number[]; newest: string }>();
  for (const index of complete) {
    const manifest = await readEpochManifest(root, index);
    if (!manifest) continue;
    const signature = encoderConfigSignature(manifest);
    // Not comparable, so not evidence of a change. Left exactly as it is.
    if (signature === null) return [];
    const group = groups.get(signature);
    if (group) {
      group.indexes.push(index);
      if (manifest.completedAt > group.newest)
        group.newest = manifest.completedAt;
    } else {
      groups.set(signature, {
        indexes: [index],
        newest: manifest.completedAt,
      });
    }
  }

  if (groups.size < 2) return [];

  let keep: { indexes: number[]; newest: string } | undefined;
  for (const group of groups.values()) {
    if (!keep || group.newest > keep.newest) keep = group;
  }

  const dropped: Array<{ index: number; reason: string }> = [];
  for (const group of groups.values()) {
    if (group === keep) continue;
    for (const index of group.indexes) {
      await rm(completedEpochPath(root, index), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      dropped.push({ index, reason: "encoder-config-changed" });
    }
  }
  return dropped;
}

export async function reconcileCheckpoints({
  root,
  plan,
  identity,
  requiredRenditionIds,
}: {
  root: string;
  plan: EpochPlan;
  identity: CheckpointIdentity;
  requiredRenditionIds: readonly string[];
}): Promise<ReconciliationOutcome> {
  await mkdir(epochsRoot(root), { recursive: true });

  const outcome: ReconciliationOutcome = {
    complete: [],
    pending: [],
    invalidated: [],
    abandoned: [],
    active: [],
  };

  for (const partial of await listPartialEpochs(root)) {
    if (partial.active) {
      outcome.active.push(partial.name);
      continue;
    }
    await rm(partial.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    outcome.abandoned.push(partial.name);
  }

  for (const epoch of plan.epochs) {
    const state = await inspectCompletedEpoch({
      root,
      index: epoch.index,
      identity,
      requiredRenditionIds,
    });
    if (state.status === "complete") {
      outcome.complete.push(epoch.index);
      continue;
    }
    if (state.status === "invalid") {
      outcome.invalidated.push({ index: epoch.index, reason: state.reason });
      await rm(completedEpochPath(root, epoch.index), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    outcome.pending.push(epoch.index);
  }

  /*
   * Every surviving checkpoint is individually valid by this point. What is not
   * yet established is whether they agree with *each other* about how they were
   * encoded — which is a different question, and the one that costs a whole job
   * when it is left to the assembler to ask.
   */
  const stale = await dropEpochsFromAnotherEncoderConfiguration(
    root,
    outcome.complete,
  );
  if (stale.length > 0) {
    const dropped = new Set(stale.map((entry) => entry.index));
    outcome.complete = outcome.complete.filter((index) => !dropped.has(index));
    outcome.pending = [...outcome.pending, ...dropped].sort((a, b) => a - b);
    outcome.invalidated.push(...stale);
  }

  /*
   * Epochs beyond the plan belong to a previous, longer plan for the same
   * source and profile — a ladder that gained a rung, say. They are not
   * reusable and they are not the current build's to keep.
   */
  for (const index of await listCompletedEpochIndexes(root)) {
    if (index >= plan.epochs.length) {
      await rm(completedEpochPath(root, index), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      outcome.invalidated.push({ index, reason: "beyond-plan" });
    }
  }

  return outcome;
}

/** Reads a promoted epoch's manifest, or null when it is not there. */
export async function readEpochManifest(
  root: string,
  index: number,
): Promise<EpochCheckpointManifest | null> {
  return readJson<EpochCheckpointManifest>(
    path.join(completedEpochPath(root, index), EPOCH_MANIFEST_FILE),
  );
}

/** Invalidates exactly one checkpoint, leaving every other one untouched. */
export async function invalidateEpoch(
  root: string,
  index: number,
): Promise<void> {
  await rm(completedEpochPath(root, index), { recursive: true, force: true });
}

export async function readAuxiliaryStage(
  directory: string,
): Promise<AuxiliaryStageManifest | null> {
  return readJson<AuxiliaryStageManifest>(
    path.join(directory, EPOCH_MANIFEST_FILE),
  );
}

export async function writeAuxiliaryStage(
  directory: string,
  manifest: AuxiliaryStageManifest,
): Promise<void> {
  await writeJsonAtomic(path.join(directory, EPOCH_MANIFEST_FILE), manifest);
}

/** Bytes a checkpoint root currently holds, for the storage panel. */
export async function checkpointBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
      else if (entry.isFile()) {
        const stats = await stat(full).catch(() => undefined);
        if (stats) total += stats.size;
      }
    }
  };
  await walk(root);
  return total;
}
