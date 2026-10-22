// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chooseStrategy,
  classifyFsError,
  createImportOperations,
  identityOf,
  ImportOperationError,
  isStagingName,
  stagingNameFor,
  type ImportOperations,
} from "./importOperations";
import { dispositionFor } from "./importState";

/*
 * Real files throughout. What a hardlink is, what a rename does to an existing
 * destination, and what a partial copy leaves behind are all questions about
 * the operating system, and a double can only repeat what this module already
 * assumes about them.
 */
let workspace: string;
let sourceRoot: string;
let libraryRoot: string;
let operations: ImportOperations;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-import-ops-"));
  sourceRoot = path.join(workspace, "downloads");
  libraryRoot = path.join(workspace, "library");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(path.join(sourceRoot, "Dune.2021"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, "Dune.2021", "Dune.mkv"),
    "pretend this is eight gigabytes",
  );
  operations = createImportOperations(sourceRoot, libraryRoot);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const SOURCE = "Dune.2021/Dune.mkv";
const DESTINATION = "Dune (2021)/src/Dune (2021).mkv";

describe("what this pair of roots can actually do", () => {
  it("proves a hardlink rather than assuming one", async () => {
    /*
     * Both roots are inside one temp directory here, so this is a same-volume
     * probe and it must say yes. The point is that it *measured* it.
     */
    expect(await operations.probeHardlink()).toBe(true);
  });

  it("leaves nothing behind after probing", async () => {
    await operations.probeHardlink();
    const [sources, libraries] = await Promise.all([
      import("node:fs/promises").then((fs) => fs.readdir(sourceRoot)),
      import("node:fs/promises").then((fs) => fs.readdir(libraryRoot)),
    ]);
    expect(sources.filter((name) => name.includes("probe"))).toEqual([]);
    expect(libraries.filter((name) => name.includes("probe"))).toEqual([]);
  });

  it("measures once and reuses the answer", async () => {
    const first = await operations.probeHardlink();
    const second = await operations.probeHardlink();
    expect(second).toBe(first);
  });

  it("says no when the library root cannot be linked into", async () => {
    // A root that does not exist stands in for any filesystem that refuses.
    const impossible = createImportOperations(
      sourceRoot,
      path.join(workspace, "not-there"),
    );
    expect(await impossible.probeHardlink()).toBe(false);
  });

  it("proves a rename separately from a link", async () => {
    // Same volume here, so both are true. They are measured apart because a
    // filesystem can refuse one and allow the other.
    expect(await operations.probeRename()).toBe(true);
  });

  it("says no when the download cannot be renamed into the library", async () => {
    const impossible = createImportOperations(
      sourceRoot,
      path.join(workspace, "not-there"),
    );
    expect(await impossible.probeRename()).toBe(false);
  });

  it("leaves nothing behind after probing a rename", async () => {
    await operations.probeRename();
    const fs = await import("node:fs/promises");
    const [sources, libraries] = await Promise.all([
      fs.readdir(sourceRoot),
      fs.readdir(libraryRoot),
    ]);
    expect(sources.filter((name) => name.includes("probe"))).toEqual([]);
    expect(libraries.filter((name) => name.includes("probe"))).toEqual([]);
  });
});

describe("choosing the operation from that fact", () => {
  /*
   * The download directory sits on the system disk and the library on external
   * media, so a move is a rename across a volume boundary. That produced EXDEV
   * at the moment of writing — after the plan was recorded and the destination
   * directory created — and no acquisition could be imported at all.
   */
  it("copies rather than moving when the download cannot be renamed across", () => {
    const choice = chooseStrategy(false, { retainSource: false }, false);
    expect(choice.strategy).toBe("copy");
    expect(choice.reason).toContain("cannot be renamed");
  });

  it("still moves when a rename is possible", () => {
    expect(chooseStrategy(false, { retainSource: false }, true).strategy).toBe(
      "move",
    );
  });

  it("prefers a link even where a rename would also work", () => {
    expect(chooseStrategy(true, { retainSource: false }, true).strategy).toBe(
      "hardlink",
    );
  });

  it("keeps the source when asked, whatever a rename could do", () => {
    expect(chooseStrategy(false, { retainSource: true }, false).strategy).toBe(
      "copy",
    );
    expect(chooseStrategy(false, { retainSource: true }, true).strategy).toBe(
      "copy",
    );
  });

  it("links when links work", () => {
    expect(chooseStrategy(true, { retainSource: false }).strategy).toBe(
      "hardlink",
    );
  });

  it("copies when they do not and the download is being kept", () => {
    expect(chooseStrategy(false, { retainSource: true }).strategy).toBe("copy");
  });

  it("moves only when no link is possible and nothing wants the source", () => {
    // The one choice that cannot be undone by deleting what it created.
    expect(chooseStrategy(false, { retainSource: false }).strategy).toBe(
      "move",
    );
  });

  it("never moves a source that must survive", () => {
    for (const supported of [true, false]) {
      expect(
        chooseStrategy(supported, { retainSource: true }).strategy,
      ).not.toBe("move");
    }
  });

  it("obeys an operator who asked for real copies", () => {
    expect(
      chooseStrategy(true, { retainSource: false, forceCopy: true }).strategy,
    ).toBe("copy");
  });

  it("says why, so the record can be read afterwards", () => {
    expect(chooseStrategy(true, { retainSource: false }).reason).toMatch(
      /filesystem/,
    );
  });
});

describe("hardlinking", () => {
  it("makes a second name for the same bytes", async () => {
    await operations.ensureDirectory(DESTINATION);
    await operations.hardlink(SOURCE, DESTINATION);

    const [from, to] = await Promise.all([
      identityOf(path.join(sourceRoot, SOURCE)),
      identityOf(path.join(libraryRoot, DESTINATION)),
    ]);
    expect(to?.key).toBe(from?.key);
  });

  it("keeps the data when the download's name is removed", async () => {
    /*
     * The property the whole strategy rests on: cleanup after a hardlink
     * removes a directory entry, not the film.
     */
    await operations.ensureDirectory(DESTINATION);
    await operations.hardlink(SOURCE, DESTINATION);
    await operations.removeSource(SOURCE);

    const contents = await readFile(
      path.join(libraryRoot, DESTINATION),
      "utf8",
    );
    expect(contents).toBe("pretend this is eight gigabytes");
  });

  it("refuses to replace whatever is already at the destination", async () => {
    await operations.ensureDirectory(DESTINATION);
    await writeFile(path.join(libraryRoot, DESTINATION), "someone else's film");
    await expect(
      operations.hardlink(SOURCE, DESTINATION),
    ).rejects.toMatchObject({ failure: "destination-occupied" });
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "someone else's film",
    );
  });

  it("says the source is missing rather than inventing one", async () => {
    await operations.ensureDirectory(DESTINATION);
    await expect(
      operations.hardlink("Dune.2021/gone.mkv", DESTINATION),
    ).rejects.toMatchObject({ failure: "source-missing" });
  });
});

describe("copying", () => {
  it("writes the bytes and leaves the source alone", async () => {
    await operations.ensureDirectory(DESTINATION);
    await operations.copy(SOURCE, DESTINATION);
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "pretend this is eight gigabytes",
    );
    expect(await stat(path.join(sourceRoot, SOURCE))).toBeTruthy();
  });

  it("produces a different file, not a second name", async () => {
    await operations.ensureDirectory(DESTINATION);
    await operations.copy(SOURCE, DESTINATION);
    const [from, to] = await Promise.all([
      identityOf(path.join(sourceRoot, SOURCE)),
      identityOf(path.join(libraryRoot, DESTINATION)),
    ]);
    expect(to?.key).not.toBe(from?.key);
  });

  it("refuses to overwrite an existing destination", async () => {
    await operations.ensureDirectory(DESTINATION);
    await writeFile(path.join(libraryRoot, DESTINATION), "someone else's film");
    await expect(operations.copy(SOURCE, DESTINATION)).rejects.toMatchObject({
      failure: "destination-occupied",
    });
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "someone else's film",
    );
  });

  it("leaves no half-written file behind when it fails", async () => {
    // A partial copy a reader could find is worse than no copy at all.
    await operations.ensureDirectory(DESTINATION);
    await expect(
      operations.copy("Dune.2021/gone.mkv", DESTINATION),
    ).rejects.toThrow();
    expect(
      await stat(path.join(libraryRoot, DESTINATION)).catch(() => null),
    ).toBeNull();
  });
});

describe("moving", () => {
  it("takes the file out of the download", async () => {
    await operations.ensureDirectory(DESTINATION);
    await operations.move(SOURCE, DESTINATION);
    expect(await stat(path.join(libraryRoot, DESTINATION))).toBeTruthy();
    expect(
      await stat(path.join(sourceRoot, SOURCE)).catch(() => null),
    ).toBeNull();
  });

  it("refuses to replace an existing destination", async () => {
    /*
     * `rename` replaces silently on POSIX. This check is the only thing
     * standing between an import and somebody's existing film.
     */
    await operations.ensureDirectory(DESTINATION);
    await writeFile(path.join(libraryRoot, DESTINATION), "someone else's film");
    await expect(operations.move(SOURCE, DESTINATION)).rejects.toMatchObject({
      failure: "destination-occupied",
    });
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "someone else's film",
    );
    // And the source is still there, so nothing was lost either way.
    expect(await stat(path.join(sourceRoot, SOURCE))).toBeTruthy();
  });
});

describe("staging and activation", () => {
  it("names staging after the import that owns it", () => {
    const staged = stagingNameFor("seyirlik-import-abc", DESTINATION);
    expect(staged).toBe(
      "Dune (2021)/src/.seyirlik-import-seyirlik-import-abc-Dune (2021).mkv",
    );
    expect(isStagingName(staged)).toBe(true);
    expect(isStagingName(DESTINATION)).toBe(false);
  });

  it("stages beside the destination so activation is one directory's rename", () => {
    // A rename within a directory is the only form that is atomic on every
    // filesystem this runs on.
    const staged = stagingNameFor("k", DESTINATION);
    expect(staged.split("/").slice(0, -1)).toEqual(
      DESTINATION.split("/").slice(0, -1),
    );
  });

  it("activates staging into the final name", async () => {
    const staged = stagingNameFor("k", DESTINATION);
    await operations.ensureDirectory(DESTINATION);
    await operations.copy(SOURCE, staged);
    await operations.activate(staged, DESTINATION);
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "pretend this is eight gigabytes",
    );
    expect(await operations.exists(staged)).toBe(false);
  });

  it("refuses to activate over an existing file", async () => {
    const staged = stagingNameFor("k", DESTINATION);
    await operations.ensureDirectory(DESTINATION);
    await operations.copy(SOURCE, staged);
    await writeFile(path.join(libraryRoot, DESTINATION), "someone else's film");
    await expect(
      operations.activate(staged, DESTINATION),
    ).rejects.toMatchObject({ failure: "destination-occupied" });
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "someone else's film",
    );
  });

  it("will only discard a file it staged itself", async () => {
    /*
     * A deletion helper that accepts any path is a deletion helper that will
     * eventually be handed the wrong one.
     */
    await operations.ensureDirectory(DESTINATION);
    await writeFile(path.join(libraryRoot, DESTINATION), "a real film");
    await expect(operations.discardStaging(DESTINATION)).rejects.toBeInstanceOf(
      ImportOperationError,
    );
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "a real film",
    );
  });

  it("discards its own staging without complaint when it is already gone", async () => {
    const staged = stagingNameFor("k", DESTINATION);
    await operations.ensureDirectory(DESTINATION);
    await expect(operations.discardStaging(staged)).resolves.toBeUndefined();
  });
});

describe("what an error means", () => {
  it.each([
    ["ENOENT", "source-missing", false],
    ["EXDEV", "cross-volume", false],
    ["EPERM", "permission-denied", false],
    ["EACCES", "permission-denied", false],
    ["EBUSY", "destination-locked", false],
    ["ENOSPC", "disk-full", false],
    ["EMLINK", "hardlink-unsupported", false],
    ["EEXIST", "destination-occupied", false],
    ["EIO", "commit-ambiguous", true],
    ["ETIMEDOUT", "commit-ambiguous", true],
    ["ESOMETHING", "unknown", false],
  ] as const)("reads %s as %s", (code, failure, ambiguous) => {
    const error = Object.assign(new Error("boom"), { code });
    const classified = classifyFsError(error);
    expect(classified.failure).toBe(failure);
    expect(classified.ambiguous).toBe(ambiguous);
  });

  /**
   * Measured on Windows 11, on both exFAT and NTFS, against a real open handle:
   *
   *   fs.rename over a destination another process holds open
   *     -> { code: "EPERM", syscall: "rename" }
   *
   * for a holder that shares deletion and for one that does not. `EBUSY` did
   * not occur at all. That matters because the two codes lead opposite ways:
   * `destination-locked` is retried, `permission-denied` asks a person. A
   * player or a scanner holding a file open for a few seconds is the single
   * commonest reason an upgrade cannot be written, and it was being escalated
   * to a human instead of being tried again.
   *
   * The distinction is the syscall, which is on every Node filesystem error. An
   * `EPERM` from anything but a rename keeps its old meaning.
   */
  it("reads a rename refused by an open destination as a lock, not a permission", () => {
    const locked = classifyFsError(
      Object.assign(new Error("EPERM: operation not permitted, rename"), {
        code: "EPERM",
        syscall: "rename",
      }),
    );
    expect(locked.failure).toBe("destination-locked");
    expect(dispositionFor(locked.failure)).toBe("retry");
  });

  it.each(["open", "unlink", "mkdir", "copyfile"] as const)(
    "still reads EPERM from %s as a permission problem",
    (syscall) => {
      const denied = classifyFsError(
        Object.assign(new Error("EPERM"), { code: "EPERM", syscall }),
      );
      expect(denied.failure).toBe("permission-denied");
    },
  );

  it("keeps EACCES a permission problem even on a rename", () => {
    // Windows distinguishes them, and only EPERM carries the sharing meaning.
    const denied = classifyFsError(
      Object.assign(new Error("EACCES"), { code: "EACCES", syscall: "rename" }),
    );
    expect(denied.failure).toBe("permission-denied");
  });

  /**
   * Also measured, on a synthetic exFAT volume with the same 128 KB cluster
   * size as the real media disk:
   *
   *   fs.link on exFAT -> { code: "EISDIR", syscall: "link" }
   *
   * on two operands that are both plainly files. It is Windows' way of saying
   * the filesystem has no hardlinks at all, and it was not in the list of codes
   * that mean that — `EMLINK`, `ENOSYS`, `EOPNOTSUPP`. The capability probe
   * catches everything and answers `false`, so strategy selection was never
   * wrong; this is about the classification being truthful when a link fails
   * anywhere else.
   */
  it("reads a link refused by the filesystem as an unsupported hardlink", () => {
    const unsupported = classifyFsError(
      Object.assign(
        new Error("EISDIR: illegal operation on a directory, link"),
        {
          code: "EISDIR",
          syscall: "link",
        },
      ),
    );
    expect(unsupported.failure).toBe("hardlink-unsupported");
  });

  it("reads ENOTSUP from a link as an unsupported hardlink", () => {
    // Measured on the rclone Google Drive mount the Windows host serves from.
    const refused = Object.assign(
      new Error("ENOTSUP: operation not supported on socket, link"),
      { code: "ENOTSUP", syscall: "link" },
    );
    expect(classifyFsError(refused).failure).toBe("hardlink-unsupported");
  });

  it("leaves EISDIR from anything else alone", () => {
    expect(
      classifyFsError(
        Object.assign(new Error("EISDIR"), { code: "EISDIR", syscall: "read" }),
      ).failure,
    ).toBe("unknown");
  });

  it("marks only the genuinely unknowable as ambiguous", () => {
    /*
     * An I/O error during a rename may have been raised after the directory
     * entry was written. Everything else here failed before it did anything.
     */
    const ambiguous = (["EIO", "ETIMEDOUT"] as const).map(
      (code) =>
        classifyFsError(Object.assign(new Error(""), { code })).ambiguous,
    );
    expect(ambiguous).toEqual([true, true]);
    expect(
      classifyFsError(Object.assign(new Error(""), { code: "ENOENT" }))
        .ambiguous,
    ).toBe(false);
  });
});

describe("staying inside the two roots", () => {
  it("refuses a source outside the download root", async () => {
    await expect(
      operations.hardlink("../library/anything.mkv", DESTINATION),
    ).rejects.toThrow();
  });

  it("refuses a destination outside the library root", async () => {
    await expect(
      operations.hardlink(SOURCE, "../downloads/escaped.mkv"),
    ).rejects.toThrow();
  });

  it("refuses to remove a source outside the download root", async () => {
    await expect(operations.removeSource("../library/x")).rejects.toThrow();
  });

  it("treats an already-absent source as the desired end state", async () => {
    await expect(
      operations.removeSource("Dune.2021/never-existed.mkv"),
    ).resolves.toBeUndefined();
  });
});
