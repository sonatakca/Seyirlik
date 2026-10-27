// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_ENV,
  BRIDGE_PARENT_ENV,
  bridgeEntry,
  createReleaseBridge,
  watchBridgeParent,
} from "./releaseBridge";

const quiet = { info: () => undefined, warn: () => undefined };
const logFile = path.join(tmpdir(), `seyirlik-bridge-test-${process.pid}.log`);

/** A spawn that records what it was asked to start and lets the test end it. */
function fakeSpawn() {
  const started: Array<{
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    exit(code: number): void;
  }> = [];
  const spawn = vi.fn(
    (
      _command: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 1000 + started.length,
        unref: () => undefined,
      });
      started.push({
        args,
        cwd: options.cwd,
        env: options.env,
        exit: (code) => void child.emit("exit", code),
      });
      return child;
    },
  );
  return { spawn: spawn as never, started };
}

describe("the bridge a waiting worker starts", () => {
  it("names the entry point inside the pointer, and nothing outside it", () => {
    const pointer = path.resolve("/app/current");
    expect(
      bridgeEntry(
        pointer,
        path.join(pointer, "src", "server", "mediaWorker.ts"),
      ),
    ).toBe(path.join("src", "server", "mediaWorker.ts"));
    expect(bridgeEntry(pointer, "src/server/mediaWorker.ts")).toBe(
      path.join("src", "server", "mediaWorker.ts"),
    );
    // A Mac runs from its checkout; there is no release to bridge to.
    expect(
      bridgeEntry(pointer, "/Users/me/Media-Server/src/server/mediaWorker.ts"),
    ).toBeNull();
  });

  it("starts one bridge in the pointer, as a bridge, for its parent", () => {
    const { spawn, started } = fakeSpawn();
    const bridge = createReleaseBridge({
      logFile,
      pointer: "/app/current",
      entry: "/app/current/src/server/mediaWorker.ts",
      execPath: "node",
      execArgv: ["--env-file=settings.env", "--import", "tsx"],
      env: { KEEP: "yes" },
      parentPid: 42,
      spawn,
      logger: quiet,
    });

    bridge.start("/app/releases/2");
    bridge.start("/app/releases/2");

    expect(started).toHaveLength(1);
    expect(started[0]!.cwd).toBe("/app/current");
    expect(started[0]!.args).toEqual([
      "--env-file=settings.env",
      "--import",
      "tsx",
      path.join("src", "server", "mediaWorker.ts"),
    ]);
    expect(started[0]!.env).toMatchObject({
      KEEP: "yes",
      [BRIDGE_ENV]: "1",
      [BRIDGE_PARENT_ENV]: "42",
    });
  });

  it("starts a bridge that died again, and leaves one that finished", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, started } = fakeSpawn();
      const bridge = createReleaseBridge({
        logFile,
        pointer: "/app/current",
        entry: "/app/current/src/server/mediaWorker.ts",
        spawn,
        restartDelayMs: 1_000,
        logger: quiet,
      });

      bridge.start("/app/releases/2");
      started[0]!.exit(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(started).toHaveLength(2);

      started[1]!.exit(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(started).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh bridge for a newer release", () => {
    const { spawn, started } = fakeSpawn();
    const bridge = createReleaseBridge({
      logFile,
      pointer: "/app/current",
      entry: "/app/current/src/server/mediaWorker.ts",
      spawn,
      logger: quiet,
    });
    bridge.start("/app/releases/2");
    bridge.start("/app/releases/3");
    expect(started).toHaveLength(2);
  });

  /*
   * Started in the pointer, the bridge has to run the release the pointer
   * names now, not the one the old worker loaded.
   */
  it("runs the release a real link names when it starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-bridge-"));
    try {
      for (const release of ["1", "2"]) {
        await mkdir(path.join(root, release, "src"), { recursive: true });
        await writeFile(
          path.join(root, release, "src", "worker.mjs"),
          `process.stdout.write(${JSON.stringify(release)} + " " + process.env.${BRIDGE_PARENT_ENV});`,
        );
      }
      const current = path.join(root, "current");
      await symlink(path.join(root, "2"), current, "junction");

      const { spawn: realSpawn } = await import("node:child_process");
      let output = "";
      const done = new Promise<void>((resolve) => {
        const bridge = createReleaseBridge({
          logFile,
          pointer: current,
          entry: path.join(current, "src", "worker.mjs"),
          execArgv: [],
          parentPid: 7,
          spawn: ((command: string, args: string[], options: object) => {
            const child = realSpawn(command, args, {
              ...options,
              stdio: "pipe",
            });
            child.stdout?.on("data", (chunk) => (output += String(chunk)));
            child.on("exit", () => resolve());
            return child;
          }) as never,
          logger: quiet,
        });
        bridge.start(path.join(root, "2"));
      });
      await done;
      expect(output).toBe("2 7");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a bridge watching the worker that started it", () => {
  it("keeps working while its parent lives, then drains and exits", async () => {
    let alive = true;
    let finish: () => void = () => undefined;
    const idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const calls: string[] = [];
    const exit = vi.fn();
    const watch = watchBridgeParent({
      parentPid: 42,
      worker: {
        pause: () => void calls.push("pause"),
        whenIdle: () => idle,
      },
      exit,
      isAlive: () => alive,
      logger: quiet,
    });

    await watch.check();
    expect(calls).toEqual([]);

    alive = false;
    const leaving = watch.check();
    await Promise.resolve();
    expect(calls).toEqual(["pause"]);
    expect(exit).not.toHaveBeenCalled();

    finish();
    await leaving;
    expect(exit).toHaveBeenCalledTimes(1);

    // Only once, however often it is asked.
    await watch.check();
    expect(exit).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
