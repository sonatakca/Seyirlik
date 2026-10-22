// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createImportService, type ImportService } from "./importService";
import { createImportOperations, identityOf } from "./importOperations";
import { createNodeReadFileSystem } from "./importFileSystem";
import {
  createMemoryRepository,
  withFault,
  type Fault,
  type MemoryRepository,
} from "./importTestHarness";
import type { DestinationTarget } from "./importDestination";
import type { StrategyPolicy } from "./importOperations";

let workspace: string;
let sourceRoot: string;
let libraryRoot: string;
let repository: MemoryRepository;

const RELEASE = "Dune.Part.Two.2024.1080p.WEB-DL";
const TARGET: DestinationTarget = {
  kind: "movie",
  title: "Dune Part Two",
  year: 2024,
};
const DESTINATION = "Dune Part Two (2024)/src/Dune Part Two (2024).mkv";
const CONTENTS = "pretend this is eight gigabytes of film";

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-import-svc-"));
  sourceRoot = path.join(workspace, "downloads");
  libraryRoot = path.join(workspace, "library");
  await mkdir(path.join(sourceRoot, RELEASE), { recursive: true });
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, RELEASE, "dune.part.two.mkv"),
    CONTENTS,
  );
  repository = createMemoryRepository();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function service(
  fault: Fault | null = null,
  policy?: StrategyPolicy,
): ImportService {
  return createImportService({
    repository,
    operationsFor: (source, library) =>
      withFault(createImportOperations(source, library), fault),
    sourceFileSystemFor: (root) => createNodeReadFileSystem(root),
    targetFor: async () => TARGET,
    ...(policy ? { policy } : {}),
  });
}

async function newImport(): Promise<string> {
  const created = await repository.create({
    target: { kind: "movie", title: "Dune Part Two", year: 2024 },
    sourceRoot,
    libraryRoot,
    sourceRelative: RELEASE,
  });
  return created.id;
}

async function libraryFiles(): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), next);
      } else {
        found.push(next);
      }
    }
  }
  await walk(libraryRoot, "");
  return found.sort();
}

describe("an import that goes to plan", () => {
  it("plans, executes and commits", async () => {
    const importId = await newImport();
    const svc = service();

    expect((await svc.plan(importId)).state).toBe("staging");
    expect((await svc.execute(importId)).state).toBe("committed");

    expect(await libraryFiles()).toEqual([DESTINATION]);
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      CONTENTS,
    );
  });

  it("passes through the states in the protocol's order", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    await svc.cleanup(importId);

    /*
     * Two `staging` entries and two `committed` ones: the import's own state,
     * and the file's. The file is claimed before it is staged, which is what
     * stops a second worker discarding a half-written staging file.
     */
    expect(repository.trail(importId)).toEqual([
      "planned",
      "validating",
      "staging", // the import
      "staging", // the file, claimed
      "staged",
      "committing",
      "committed", // the file
      "committed", // the import
      "cleaning",
      "complete",
    ]);
  });

  it("declares `committing` before the first activation", async () => {
    /*
     * The ordering the state machine exists to enforce. If the declaration
     * came after the rename, a crash between them would leave a row saying
     * nothing had started beside a library that had already changed.
     */
    const importId = await newImport();
    const svc = service({ operation: "activate" });
    await svc.plan(importId);
    await svc.execute(importId);
    const trail = repository.trail(importId);
    expect(trail).toContain("committing");
    // Staging exists beside the destination; no library file does.
    expect(
      (await libraryFiles()).filter((name) => !name.includes(".seyirlik")),
    ).toEqual([]);
  });

  it("uses a hardlink when the roots share a filesystem", async () => {
    const importId = await newImport();
    await service().plan(importId);
    expect((await repository.get(importId))?.strategy).toBe("hardlink");

    await service().execute(importId);
    const [from, to] = await Promise.all([
      identityOf(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")),
      identityOf(path.join(libraryRoot, DESTINATION)),
    ]);
    expect(to?.key).toBe(from?.key);
  });

  it("copies instead when an operator asked for copies", async () => {
    const importId = await newImport();
    const svc = service(null, { retainSource: false, forceCopy: true });
    await svc.plan(importId);
    expect((await repository.get(importId))?.strategy).toBe("copy");
    await svc.execute(importId);
    const [from, to] = await Promise.all([
      identityOf(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")),
      identityOf(path.join(libraryRoot, DESTINATION)),
    ]);
    expect(to?.key).not.toBe(from?.key);
  });

  it("carries subtitles beside the film, sharing its stem", async () => {
    await mkdir(path.join(sourceRoot, RELEASE, "Subs"), { recursive: true });
    await writeFile(
      path.join(sourceRoot, RELEASE, "Subs", "2_English.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nhello\n",
    );
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);

    expect(await libraryFiles()).toEqual([
      "Dune Part Two (2024)/src/Dune Part Two (2024).english.srt",
      DESTINATION,
    ]);
  });

  it("leaves the sample, the artwork and the leftovers in the download", async () => {
    await mkdir(path.join(sourceRoot, RELEASE, "Sample"), { recursive: true });
    await writeFile(path.join(sourceRoot, RELEASE, "Sample", "s.mkv"), "x");
    await writeFile(path.join(sourceRoot, RELEASE, "poster.jpg"), "x");
    await writeFile(path.join(sourceRoot, RELEASE, "release.nfo"), "x");
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);

    expect(await libraryFiles()).toEqual([DESTINATION]);
    expect(
      await stat(path.join(sourceRoot, RELEASE, "poster.jpg")),
    ).toBeTruthy();
  });
});

describe("running the same import more than once", () => {
  it("produces one library object when executed twice", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    await svc.execute(importId);

    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("produces one library object when two workers run it at once", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    const [a, b] = await Promise.allSettled([
      svc.execute(importId),
      svc.execute(importId),
    ]);
    expect([a.status, b.status]).not.toContain("rejected");
    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("lets only one of two planners claim the import", async () => {
    const importId = await newImport();
    const svc = service();
    const [a, b] = await Promise.all([svc.plan(importId), svc.plan(importId)]);
    const staged = [a, b].filter((outcome) => outcome.state === "staging");
    expect(staged).toHaveLength(1);
  });

  it("does not stage a second copy beside a finished destination", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    await svc.execute(importId);

    const inTitle = await readdir(
      path.join(libraryRoot, "Dune Part Two (2024)", "src"),
    );
    expect(inTitle).toEqual(["Dune Part Two (2024).mkv"]);
  });
});

describe("dying at each boundary", () => {
  async function crashThenRecover(fault: Fault): Promise<void> {
    const importId = await newImport();
    await service().plan(importId);
    // The crash.
    await service(fault)
      .execute(importId)
      .catch(() => undefined);
    // A new process, with no memory of what the last one was doing.
    await recoverFully(importId);
  }

  /**
   * Everything a restarted system would do, including the one step that needs
   * a person: a `failed` import is a checked claim, so it waits to be retried.
   */
  async function recoverFully(importId: string): Promise<void> {
    const recovery = service();
    for (let pass = 0; pass < 3; pass += 1) {
      const record = await repository.get(importId);
      if (!record || record.state === "complete") return;
      if (record.state === "failed") {
        await repository.update(
          importId,
          "failed",
          { state: "planned" },
          "Retried.",
        );
        await recovery.plan(importId);
      }
      await recovery.reconcile(importId);
      await recovery.execute(importId);
    }
  }

  it("recovers from a crash while staging", async () => {
    await crashThenRecover({ operation: "copy", afterEffect: true });
    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("recovers from a crash between staging and the declaration", async () => {
    await crashThenRecover({ operation: "identity", onCall: 1 });
    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("recovers from a crash before the activation", async () => {
    await crashThenRecover({ operation: "activate" });
    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("recovers from a crash after the activation and before recording it", async () => {
    /*
     * The case the identity is recorded for. The rename happened; the process
     * died before it could say so; and the next one has to decide whether the
     * file at the destination is its own work or somebody else's.
     */
    await crashThenRecover({ operation: "activate", afterEffect: true });
    expect(await libraryFiles()).toEqual([DESTINATION]);
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      CONTENTS,
    );
  });

  it("ends with exactly one committed file after any of those crashes", async () => {
    for (const fault of [
      { operation: "copy", afterEffect: true },
      { operation: "activate" },
      { operation: "activate", afterEffect: true },
      { operation: "ensureDirectory" },
    ] as Fault[]) {
      await rm(libraryRoot, { recursive: true, force: true });
      await mkdir(libraryRoot, { recursive: true });
      await writeFile(
        path.join(sourceRoot, RELEASE, "dune.part.two.mkv"),
        CONTENTS,
      );
      repository = createMemoryRepository();

      const importId = await newImport();
      await service().plan(importId);
      await service(fault)
        .execute(importId)
        .catch(() => undefined);
      await recoverFully(importId);

      const files = await repository.listFiles(importId);
      expect(files.filter((file) => file.state === "committed")).toHaveLength(
        1,
      );
      expect(await libraryFiles()).toEqual([DESTINATION]);
    }
  });

  it("never leaves staging behind once the import is finished", async () => {
    const importId = await newImport();
    await service().plan(importId);
    await service({ operation: "activate" })
      .execute(importId)
      .catch(() => undefined);
    const recovery = service();
    await recovery.reconcile(importId);
    await recovery.execute(importId);

    const inTitle = await readdir(
      path.join(libraryRoot, "Dune Part Two (2024)", "src"),
    );
    expect(inTitle.filter((name) => name.startsWith(".seyirlik"))).toEqual([]);
  });
});

describe("an outcome nobody knows", () => {
  it("says uncertain rather than failed when the filesystem is ambiguous", async () => {
    const importId = await newImport();
    await service().plan(importId);
    const outcome = await service({
      operation: "activate",
      code: "EIO",
    }).execute(importId);
    expect(outcome.state).toBe("uncertain");
    expect((await repository.get(importId))?.state).toBe("uncertain");
  });

  it("never records failed from an in-flight commit", async () => {
    /*
     * `failed` asserts that no destination exists and the source is untouched.
     * Nothing in the activation path is allowed to make that claim without
     * having looked.
     */
    const importId = await newImport();
    await service().plan(importId);
    await service({ operation: "activate", code: "EIO" }).execute(importId);
    expect(repository.trail(importId)).not.toContain("failed");
  });

  it("resolves an uncertain import by looking at the filesystem", async () => {
    const importId = await newImport();
    await service().plan(importId);
    await service({ operation: "activate", afterEffect: true })
      .execute(importId)
      .catch(() => undefined);

    // The row says nothing useful; the disk does.
    const outcome = await service().reconcile(importId);
    expect(outcome.state).toBe("committed");
    expect(await libraryFiles()).toEqual([DESTINATION]);
  });

  it("sends an import to a person when the destination is a stranger's", async () => {
    const importId = await newImport();
    await service().plan(importId);
    await mkdir(path.join(libraryRoot, "Dune Part Two (2024)", "src"), {
      recursive: true,
    });
    await writeFile(
      path.join(libraryRoot, DESTINATION),
      "somebody else's film",
    );

    const outcome = await service().execute(importId);
    expect(outcome.state).toBe("needs_attention");
    // And it is still theirs.
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      "somebody else's film",
    );
  });
});

describe("what happens to the download afterwards", () => {
  it("removes the source only after the destination is durable", async () => {
    const importId = await newImport();
    const svc = service();
    await svc.plan(importId);
    await svc.execute(importId);
    // Still there: committed is not complete.
    expect(
      await stat(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")),
    ).toBeTruthy();

    await svc.cleanup(importId);
    expect(
      await stat(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")).catch(
        () => null,
      ),
    ).toBeNull();
    // The film is still in the library: cleanup removed a name, not the bytes.
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      CONTENTS,
    );
  });

  it("keeps the source when the policy says to", async () => {
    const importId = await newImport();
    const svc = service(null, { retainSource: true });
    await svc.plan(importId);
    await svc.execute(importId);
    await svc.cleanup(importId);
    expect(
      await stat(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")),
    ).toBeTruthy();
  });

  it("still completes when the source refuses to be removed", async () => {
    /*
     * A cleanup failure says nothing about the library object, which is
     * exactly as valid either way. Reporting the import as broken because a
     * download folder would not delete is the failure this separation exists
     * to prevent.
     */
    const importId = await newImport();
    await service().plan(importId);
    await service().execute(importId);
    const outcome = await service({ operation: "removeSource" }).cleanup(
      importId,
    );
    expect(outcome.state).toBe("complete");
    expect(await readFile(path.join(libraryRoot, DESTINATION), "utf8")).toBe(
      CONTENTS,
    );
  });

  it("does not clean up an import that has not committed", async () => {
    const importId = await newImport();
    await service().plan(importId);
    const outcome = await service().cleanup(importId);
    expect(outcome.state).toBe("staging");
    expect(
      await stat(path.join(sourceRoot, RELEASE, "dune.part.two.mkv")),
    ).toBeTruthy();
  });
});

describe("what it refuses to start", () => {
  it("asks for a person when the download has no media in it", async () => {
    await rm(path.join(sourceRoot, RELEASE, "dune.part.two.mkv"));
    await writeFile(path.join(sourceRoot, RELEASE, "release.rar"), "x");
    const importId = await newImport();
    const outcome = await service().plan(importId);
    expect(outcome.state).toBe("needs_attention");
  });

  it("asks for a person when the download is gone", async () => {
    await rm(path.join(sourceRoot, RELEASE), { recursive: true });
    const importId = await newImport();
    expect((await service().plan(importId)).state).toBe("needs_attention");
  });

  it("refuses a plan whose two files would share one name", async () => {
    // Two features in one download that both resolve to `Title (Year).mkv`.
    await writeFile(path.join(sourceRoot, RELEASE, "second.mkv"), "another");
    const importId = await newImport();
    const outcome = await service().plan(importId);
    expect(outcome.state).toBe("needs_attention");
    expect(await libraryFiles()).toEqual([]);
  });

  it("writes nothing to the library when planning refuses", async () => {
    await rm(path.join(sourceRoot, RELEASE), { recursive: true });
    const importId = await newImport();
    await service().plan(importId);
    expect(await libraryFiles()).toEqual([]);
  });
});

describe("a season pack", () => {
  const PACK = "Lilyhammer.S01.WEBRip.EAC3.5.1.1080p.x265-iVy";

  it("files every episode of the pack under its own name", async () => {
    await mkdir(
      path.join(sourceRoot, PACK, "Subs", "Lilyhammer.S01E02.WEBRip"),
      {
        recursive: true,
      },
    );
    for (const episode of ["01", "02"]) {
      await writeFile(
        path.join(
          sourceRoot,
          PACK,
          `Lilyhammer.S01E${episode}.WEBRip.x265-iVy.mkv`,
        ),
        `episode ${episode}`,
      );
    }
    await writeFile(
      path.join(sourceRoot, PACK, "Lilyhammer.Behind.The.Scenes.mkv"),
      "an extra",
    );
    await writeFile(
      path.join(
        sourceRoot,
        PACK,
        "Subs",
        "Lilyhammer.S01E02.WEBRip",
        "2_English.srt",
      ),
      "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    );
    const created = await repository.create({
      target: { kind: "season", title: "Lilyhammer", year: 2012, season: 1 },
      sourceRoot,
      libraryRoot,
      sourceRelative: PACK,
    });
    const svc = createImportService({
      repository,
      operationsFor: (source, library) =>
        createImportOperations(source, library),
      sourceFileSystemFor: (root) => createNodeReadFileSystem(root),
      targetFor: async () => ({
        kind: "season",
        title: "Lilyhammer",
        year: 2012,
        season: 1,
      }),
    });

    expect((await svc.plan(created.id)).state).toBe("staging");
    expect((await svc.execute(created.id)).state).toBe("committed");
    expect(await libraryFiles()).toEqual([
      "Lilyhammer/Season 1/src/Lilyhammer - S01E01.mkv",
      "Lilyhammer/Season 1/src/Lilyhammer - S01E02.english.srt",
      "Lilyhammer/Season 1/src/Lilyhammer - S01E02.mkv",
    ]);
    // The extra is not the season's, and stays where it was downloaded.
    await svc.cleanup(created.id);
    expect(await readdir(path.join(sourceRoot, PACK))).toContain(
      "Lilyhammer.Behind.The.Scenes.mkv",
    );
  });
});
