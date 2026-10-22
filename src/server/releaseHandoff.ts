import { realpath } from "node:fs/promises";

import type { WorkerControl } from "./ownApi/tasks/worker";

/**
 * A worker that moves itself onto a newer release between jobs.
 *
 * Both Windows hosts start the worker from a `current` junction: NSSM's
 * AppDirectory on the server, `-WorkingDirectory` in MSI's Start Seyirlik
 * window. Deploying is switching that junction. The worker used to learn about
 * it by being killed, which on a machine that starts the next encode the moment
 * one ends meant either losing an encode or holding the whole queue by hand.
 *
 * So the worker watches the pointer it was started from. When it resolves
 * somewhere else, the worker takes no new job, lets the ones it holds finish,
 * and exits cleanly; both supervisors start it again within seconds, and the
 * pointer now names the new release. A clean exit with nothing held is the one
 * restart that leaves no `running` row behind, so it raises no recovery hold.
 *
 * If the pointer comes back while it waits — an activation that rolled back —
 * the worker takes work again as if nothing had happened.
 *
 * Where the pointer is not a link (the Mac runs from its checkout) it never
 * resolves anywhere new, and this does nothing.
 */
export interface ReleaseHandoffOptions {
  /** The path the process was started from: `current`, not where it points. */
  pointer: string;
  worker: WorkerControl;
  /** Ends the process. Called once, with nothing held. */
  exit(): void | Promise<void>;
  intervalMs?: number;
  resolve?: (path: string) => Promise<string>;
  logger?: Pick<Console, "info" | "warn">;
}

export interface ReleaseHandoff {
  /** The release this process loaded, or null when the pointer could not be read. */
  readonly release: string | null;
  stop(): void;
  /** One look at the pointer; what the timer runs, exposed for tests. */
  check(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 15_000;

export async function watchReleaseHandoff({
  pointer,
  worker,
  exit,
  intervalMs = DEFAULT_INTERVAL_MS,
  resolve = (path) => realpath(path),
  logger = console,
}: ReleaseHandoffOptions): Promise<ReleaseHandoff> {
  let release: string | null;
  try {
    release = await resolve(pointer);
  } catch {
    release = null;
  }
  if (release === null) {
    logger.warn(
      "[Seyirlik Worker] release.handoff.off: the start directory could not be resolved.",
    );
    return { release, stop: () => undefined, check: async () => undefined };
  }
  const own = release;

  /*
   * Bumped each time a wait for idle starts or is called off, so a wait that
   * finishes after the pointer came back cannot act on the old decision.
   */
  let generation = 0;
  let paused = false;
  let exiting = false;
  let checking = false;

  async function target(): Promise<string | null> {
    try {
      return await resolve(pointer);
    } catch {
      // Activation deletes the junction and makes it again; between the two
      // it resolves nowhere, which is not a release to move to.
      return null;
    }
  }

  function cancel(): void {
    generation += 1;
    paused = false;
    worker.resume();
    logger.info(
      "[Seyirlik Worker] release.handoff.cancelled: the start directory points back at this release.",
    );
  }

  async function finish(mine: number): Promise<void> {
    if (mine !== generation || exiting) return;
    // One last look: an activation that rolled back while the last job was
    // finishing must not cost this process a restart.
    const now = await target();
    if (mine !== generation || exiting) return;
    if (now === own) {
      cancel();
      return;
    }
    if (now === null) {
      // Caught between the junction's removal and its replacement; a restart
      // now could start from nothing.
      setTimeout(() => void finish(mine), 1_000).unref();
      return;
    }
    exiting = true;
    clearInterval(timer);
    logger.info(
      `[Seyirlik Worker] release.handoff.exit: nothing is running; restarting on ${now}.`,
    );
    await exit();
  }

  async function check(): Promise<void> {
    if (exiting || checking) return;
    checking = true;
    try {
      const next = await target();
      if (next === null) return;
      if (next === own) {
        if (paused) cancel();
        return;
      }
      // Already waiting: a second switch during the wait ends in the same exit.
      if (paused) return;

      paused = true;
      generation += 1;
      const mine = generation;
      worker.pause();
      const held = worker.activeJobs();
      logger.info(
        `[Seyirlik Worker] release.handoff.pending: ${next} is current; ` +
          (held.length === 0
            ? "nothing is running, switching now."
            : `switching after ${held.map((job) => `${job.jobType} ${job.id}`).join(", ")}.`),
      );
      void worker.whenIdle().then(() => finish(mine));
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();

  return {
    release: own,
    stop: () => clearInterval(timer),
    check,
  };
}
