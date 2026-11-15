// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createDriveFolders,
  driveFoldersConfigFromEnvironment,
} from "./driveFolders";

const config = {
  url: "http://127.0.0.1:5572",
  user: "u",
  pass: "p",
  mountRoot: "D:\\",
  remote: "gdrive:Rescue",
};

/** A fake rclone daemon over a set of folder paths under the remote. */
function daemon(folders: string[], options: { dirMove?: boolean } = {}) {
  const present = new Set(folders);
  const calls: { command: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const command = url.slice(config.url.length + 1);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ command, body });
    const answer = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    const relative = (fs: unknown) => String(fs).slice("gdrive:Rescue/".length);
    switch (command) {
      case "fscache/clear":
        return answer({});
      case "operations/stat":
        return answer({
          item: present.has(String(body.remote)) ? { IsDir: true } : null,
        });
      case "sync/move":
        if (options.dirMove === false)
          return answer({ error: "can't move" }, 500);
        present.delete(relative(body.srcFs));
        present.add(relative(body.dstFs));
        return answer({});
      case "operations/purge":
        present.delete(String(body.remote));
        return answer({});
      default:
        return answer({ error: "unknown" }, 404);
    }
  }) as unknown as typeof fetch;
  return { present, calls, folders: createDriveFolders(config, fetchImpl) };
}

describe("the Drive folders a title removal moves and trashes", () => {
  it("reads its settings only when they name a remote", () => {
    expect(driveFoldersConfigFromEnvironment({})).toBeNull();
    expect(
      driveFoldersConfigFromEnvironment({
        SEYIRLIK_DRIVE_REMOTE: JSON.stringify({ ...config, remote: "Rescue" }),
      }),
    ).toBeNull();
    expect(
      driveFoldersConfigFromEnvironment({
        SEYIRLIK_DRIVE_REMOTE: JSON.stringify({
          ...config,
          url: "http://127.0.0.1:5572/",
          remote: "gdrive:Rescue/",
        }),
      }),
    ).toEqual(config);
  });

  it("finds a title folder under the mount, and nothing above it", async () => {
    const { folders } = daemon([]);
    expect(await folders.locate("D:\\media\\Series\\Sponge (1999)")).toBe(
      "media/Series/Sponge (1999)",
    );
    expect(await folders.locate("D:\\media")).toBeNull();
    expect(await folders.locate("C:\\media\\Series\\Sponge (1999)")).toBeNull();
  });

  it("moves a folder beside itself in one call, with no filter, and checks it moved", async () => {
    const { folders, calls, present } = daemon(["media/Series/Sponge"]);
    await folders.move(
      "media/Series/Sponge",
      "media/Series/.seyirlik-removing-1",
    );
    expect([...present]).toEqual(["media/Series/.seyirlik-removing-1"]);
    const move = calls.find((call) => call.command === "sync/move")!;
    expect(move.body).toMatchObject({
      srcFs: "gdrive:Rescue/media/Series/Sponge",
      dstFs: "gdrive:Rescue/media/Series/.seyirlik-removing-1",
      _filter: {},
    });
  });

  it("refuses a destination that exists, or one anywhere but beside the folder", async () => {
    const { folders, calls } = daemon(["media/Series/A", "media/Series/B"]);
    await expect(
      folders.move("media/Series/A", "media/Series/B"),
    ).rejects.toThrow(/already exists/);
    await expect(
      folders.move("media/Series/A", "media/Movies/A"),
    ).rejects.toThrow(/beside itself/);
    expect(calls.some((call) => call.command === "sync/move")).toBe(false);
  });

  it("reports a move Drive refused", async () => {
    const { folders, present } = daemon(["media/Series/A"], {
      dirMove: false,
    });
    await expect(
      folders.move("media/Series/A", "media/Series/.x"),
    ).rejects.toThrow(/sync\/move answered 500: can't move/);
    expect([...present]).toEqual(["media/Series/A"]);
  });

  it("trashes a folder in one call, and treats an absent one as done", async () => {
    const { folders, calls, present } = daemon(["media/Series/.x"]);
    await folders.trash("media/Series/.x");
    await folders.trash("media/Series/.x");
    expect(present.size).toBe(0);
    expect(
      calls.filter((call) => call.command === "operations/purge"),
    ).toHaveLength(1);
  });

  it("never touches the remote's root or a top-level folder", async () => {
    const { folders, calls } = daemon(["media"]);
    await expect(folders.trash("media")).rejects.toThrow(/Refusing/);
    await expect(folders.trash("")).rejects.toThrow(/Refusing/);
    await expect(folders.trash("media/../x")).rejects.toThrow(/Refusing/);
    expect(calls).toEqual([]);
  });
});
