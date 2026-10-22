// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubtitlePayload } from "./subtitleProvider";
import { createSubtitleStorage, type SubtitleStorage } from "./subtitleStorage";

/*
 * Only `link` is controllable, and only while `failLinkWith` is set. Everything
 * else is the real filesystem, so the file these tests produce is a real file
 * and the passing case proves the bytes landed.
 *
 * The deployed media volume is exFAT, which has no hardlinks at all: it answers
 * `EISDIR` on two operands that are plainly files. Every development and CI
 * machine has them, so the fallback this exercises is otherwise reachable only
 * in production — where an unconditional link refused every upload with "The
 * subtitle could not be written."
 */
let failLinkWith: NodeJS.ErrnoException | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (async (...args: Parameters<typeof actual.link>) => {
      if (failLinkWith) throw failLinkWith;
      return actual.link(...args);
    }) as typeof actual.link,
  };
});

const fsError = (code: string, syscall: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: mock, ${syscall}`), { code, syscall });

const SRT = ["1", "00:00:01,000 --> 00:00:03,500", "Merhaba.", "", ""].join(
  "\n",
);

describe("installing where the filesystem has no hardlinks", () => {
  let root = "";
  let storage: SubtitleStorage;
  const mediaRelative = "Movies/Dune (2021)/Dune (2021).mkv";
  const directory = () => path.join(root, "Movies", "Dune (2021)");

  beforeEach(async () => {
    failLinkWith = null;
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-subtitle-linkless-"));
    await mkdir(directory(), { recursive: true });
    await writeFile(path.join(root, ...mediaRelative.split("/")), "video");
    storage = createSubtitleStorage({
      libraryRoot: root,
      resolveMedia: async () => mediaRelative,
      managedDigest: async () => null,
    });
  });

  afterEach(async () => {
    failLinkWith = null;
    if (root) await rm(root, { recursive: true, force: true });
  });

  const install = () =>
    storage.install({
      mediaFileId: "media-1",
      language: "tur",
      flags: { forced: false, hearingImpaired: false },
      payload: {
        bytes: new TextEncoder().encode(SRT),
        declaredFormat: "srt",
        declaredFileName: null,
      } satisfies SubtitlePayload,
      replace: false,
    });

  it("installs the whole subtitle when the volume refuses hardlinks", async () => {
    failLinkWith = fsError("EISDIR", "link");
    expect(await install()).toMatchObject({
      outcome: "installed",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
    });
    expect(
      await readFile(path.join(directory(), "Dune (2021).tur.srt"), "utf8"),
    ).toBe(SRT);
  });

  it("installs on the Google Drive mount, which answers ENOTSUP", async () => {
    failLinkWith = fsError("ENOTSUP", "link");
    expect(await install()).toMatchObject({ outcome: "installed" });
    expect(
      await readFile(path.join(directory(), "Dune (2021).tur.srt"), "utf8"),
    ).toBe(SRT);
  });

  it("leaves no temporary or lock behind", async () => {
    failLinkWith = fsError("EISDIR", "link");
    await install();
    expect((await readdir(directory())).sort()).toEqual([
      "Dune (2021).mkv",
      "Dune (2021).tur.srt",
    ]);
  });

  it("still refuses when the link fails for a reason that is not the filesystem", async () => {
    failLinkWith = fsError("EPERM", "link");
    expect(await install()).toMatchObject({ outcome: "error" });
    expect(await readdir(directory())).toEqual(["Dune (2021).mkv"]);
  });
});
