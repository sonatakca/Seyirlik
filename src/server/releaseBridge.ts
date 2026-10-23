import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkerControl } from "./ownApi/tasks/worker";

/**
 * A second worker that takes the short jobs while the old release finishes an
 * encode.
 *
 * A worker that sees a new release stops claiming and waits for what it holds
 * (`releaseHandoff.ts`). On the helper laptop what it holds is usually an
 * encode, hours long, and for all of that time nothing else ran: finished
 * downloads were not imported, failed ones were not replaced, and a fix that
 * had just shipped for exactly that work waited behind the encode as well.
 *
 * So while the old worker waits on long work, it starts one bridge from the
 * new release: the same Node, flags and settings, started in the `current`
 * pointer, which now names the new release. The bridge claims the role's short
 * lanes and nothing that holds or owns the encoder (`workerLanes`' `bridge`
 * option), and it runs none of the encoder owner's bookkeeping, which would
 * mistake the encode still running beside it for an interrupted one.
 *
 * The bridge ends itself. When its parent has exited, the supervisor is
 * already starting a full worker on the new release, so the bridge finishes
 * what it holds and exits. When `current` moves away from it — a rollback, or
 * a newer release — its own hand-off watcher drains it the same way. Nothing
 * supervises it beyond that: a bridge that dies is started again while the
 * wait lasts, and otherwise the short jobs simply wait for the encode, as
 * they did before.
 *
 * It writes to a log of its own. Inheriting the worker's output would hand it
 * the worker's log file, which the supervisor reopens to restart the worker
 * while the bridge may still be draining — and on Windows a file another
 * process holds open can refuse that, which would stop the restart.
 */
export const BRIDGE_ENV = "SEYIRLIK_WORKER_BRIDGE";
export const BRIDGE_PARENT_ENV = "SEYIRLIK_WORKER_BRIDGE_PARENT";

const RESTART_DELAY_MS = 30_000;
const MAX_RESTARTS = 5;

type Logger = Pick<Console, "info" | "warn">;

export interface ReleaseBridgeOptions {
  /** The pointer the old worker started from: `current`, unresolved. */
  pointer: string;
  /** The worker's entry point, as the process was started with it. */
  entry: string;
  execPath?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  parentPid?: number;
  spawn?: typeof spawnProcess;
  /** Where the bridge's output goes; appended to. */
  logFile?: string;
  restartDelayMs?: number;
  logger?: Logger;
}

export interface ReleaseBridge {
  /** Makes sure a bridge for this release is running. */
  start(release: string): void;
}

/**
 * The entry point relative to the pointer, so that started in the pointer it
 * resolves inside the new release. Null when the entry is not inside it, as on
 * a Mac running from its checkout, where there is no release to bridge to.
 */
export function bridgeEntry(pointer: string, entry: string): string | null {
  const relative = path.relative(pointer, path.resolve(pointer, entry));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

export function createReleaseBridge({
  pointer,
  entry,
  execPath = process.execPath,
  execArgv = process.execArgv,
  env = process.env,
  parentPid = process.pid,
  spawn = spawnProcess,
  logFile = path.join(tmpdir(), "seyirlik-worker-bridge.log"),
  restartDelayMs = RESTART_DELAY_MS,
  logger = console,
}: ReleaseBridgeOptions): ReleaseBridge {
  const script = bridgeEntry(pointer, entry);
  let child: ChildProcess | null = null;
  let release: string | null = null;
  let restarts = 0;

  function launch(): void {
    if (!script) return;
    const forRelease = release;
    const output = openSync(logFile, "a");
    let started: ChildProcess;
    try {
      started = spawn(execPath, [...execArgv, script], {
        cwd: pointer,
        env: {
          ...env,
          [BRIDGE_ENV]: "1",
          [BRIDGE_PARENT_ENV]: String(parentPid),
        },
        stdio: ["ignore", output, output],
        windowsHide: true,
      });
    } finally {
      // The child holds its own handle; this one is only for handing over.
      closeSync(output);
    }
    child = started;
    started.unref();
    logger.info(
      `[Seyirlik Worker] release.bridge.start: pid ${started.pid} takes short jobs on ${forRelease} while this release finishes its long work; its log is ${logFile}.`,
    );
    started.once("error", (error) => {
      logger.warn(`[Seyirlik Worker] release.bridge.error: ${error.message}`);
    });
    started.once("exit", (code) => {
      if (child === started) child = null;
      // A bridge that drained and stopped by itself has nothing to come back
      // for; one that died while the wait goes on does.
      if (code === 0 || release !== forRelease) return;
      if (restarts >= MAX_RESTARTS) {
        logger.warn(
          `[Seyirlik Worker] release.bridge.gave-up: it stopped ${restarts + 1} times; short jobs wait for this release to finish.`,
        );
        return;
      }
      restarts += 1;
      logger.warn(
        `[Seyirlik Worker] release.bridge.stopped: exit ${code}; starting it again in ${Math.round(restartDelayMs / 1000)} s.`,
      );
      setTimeout(() => {
        if (release === forRelease && child === null) launch();
      }, restartDelayMs).unref();
    });
  }

  return {
    start(next) {
      if (!script) {
        logger.info(
          "[Seyirlik Worker] release.bridge.off: the worker was not started from inside its release.",
        );
        return;
      }
      if (release === next && child !== null) return;
      // A newer release: the bridge for the older one drains itself once the
      // pointer has moved past it, so this one simply starts.
      release = next;
      restarts = 0;
      launch();
    },
  };
}

export interface BridgeParentOptions {
  parentPid: number;
  worker: Pick<WorkerControl, "pause" | "whenIdle">;
  /** Ends the process. Called once, with nothing held. */
  exit(): void | Promise<void>;
  isAlive?: (pid: number) => boolean;
  intervalMs?: number;
  logger?: Logger;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is simply not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The bridge's side: once the worker that started it has gone, its full
 * replacement is on the way, so the bridge takes nothing more, lets what it
 * holds finish and exits.
 */
export function watchBridgeParent({
  parentPid,
  worker,
  exit,
  isAlive = processIsAlive,
  intervalMs = 5_000,
  logger = console,
}: BridgeParentOptions): { stop(): void; check(): Promise<void> } {
  let leaving = false;

  async function check(): Promise<void> {
    if (leaving || isAlive(parentPid)) return;
    leaving = true;
    clearInterval(timer);
    worker.pause();
    logger.info(
      `[Seyirlik Worker] release.bridge.parent-gone: pid ${parentPid} has exited; finishing held jobs and stopping.`,
    );
    await worker.whenIdle();
    await exit();
  }

  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), check };
}
