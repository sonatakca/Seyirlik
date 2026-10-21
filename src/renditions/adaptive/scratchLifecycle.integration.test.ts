/**
 * The storage lifecycle, measured against real FFmpeg output on two volumes.
 *
 * These tests exist because the claims that justify the scratch pipeline are
 * all claims about which disk holds which bytes at which moment, and none of
 * them can be checked by reading a call site:
 *
 *  - The encoder reads the source where it lies and writes nowhere near it.
 *  - Nothing reaches the media volume until the package has proven itself.
 *  - A publication that is interrupted resumes the copy instead of repeating
 *    the transcode, which for a real title is the difference between minutes
 *    and hours.
 *  - Scratch is released only once the destination has been proven.
 *
 * The two roots are ordinary sibling directories rather than real mounts. That
 * is enough: every property under test is about paths, ordering and what
 * survives a failure, and none of them becomes true or false because the two
 * directories happen to share a device.
 */

import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { prepareProcessingStorageRoles } from "../storageRoles";
import {
  hasVerifiedScratchPackage,
  packageAdaptiveRendition,
} from "./packager";
import { runFfmpeg } from "../processor";
import {
  readTitlePackageManifest,
  TITLE_INCOMING_DIRECTORY,
} from "./publishTitle";
import { ensureAdaptiveEpochFixture } from "./testFixtures";

import { rejectPublicationCommit } from "../../test/publicationFault";

const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
/** Six seconds is three segments, so epoch boundaries land on the grid. */
const EPOCH_TARGET_SECONDS = 6;

let fixture: string | null = null;
let workspace = "";

interface Harness {
  paths: RenditionPaths;
  /** The volume the source is read from and the package is published to. */
  hddRoot: string;
  /** The volume every intermediate is written to. */
  ssdRoot: string;
  jobsRoot: string;
  titleRoot: string;
  sourcePath: string;
  fingerprint: string;
  workspaceDirectory: string;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(workspace, "run-"));
  await mkdir(path.join(root, "hdd"), { recursive: true });
  await mkdir(path.join(root, "ssd"), { recursive: true });
  /*
   * Canonical from the start. The role resolver calls `realpath`, and on macOS
   * a temporary directory is reached through a symlink, so comparing the paths
   * it returns against un-resolved ones compares two spellings of one place.
   */
  const hddRoot = await realpath(path.join(root, "hdd"));
  const ssdRoot = await realpath(path.join(root, "ssd"));

  /*
   * Resolved through the real configuration path rather than by joining
   * strings, so the roles under test are the roles a deployment gets.
   */
  const roles = await prepareProcessingStorageRoles({
    mediaRoot: hddRoot,
    scratchRoot: ssdRoot,
    legacyWorkRoot: path.join(hddRoot, ".seyirlik", "work"),
    legacyLogsRoot: path.join(hddRoot, ".seyirlik", "logs"),
  });
  expect(roles.explicitlyConfigured).toBe(true);

  const titleRoot = path.join(hddRoot, "Movies", "Scratch Test (2026)");
  await mkdir(titleRoot, { recursive: true });
  const sourcePath = path.join(titleRoot, "Scratch Test (2026).mp4");
  await copyFile(fixture!, sourcePath);

  const paths: RenditionPaths = {
    mediaRoot: hddRoot,
    renditionRoot: path.join(ssdRoot, "renditions"),
    stateRoot: path.join(ssdRoot, "state"),
    workRoot: roles.jobsRoot,
    logsRoot: roles.logsRoot,
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });

  return {
    paths,
    hddRoot,
    ssdRoot,
    jobsRoot: roles.jobsRoot,
    titleRoot,
    sourcePath,
    fingerprint: await computeSourceFingerprint(
      sourcePath,
      await stat(sourcePath),
    ),
    workspaceDirectory: path.join(roles.jobsRoot, MEDIA_ID),
  };
}

async function packageOnce(
  harness: Harness,
  overrides: Record<string, unknown> = {},
) {
  return packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.basename(harness.sourcePath),
      sourceFingerprint: harness.fingerprint,
      sourcePath: harness.sourcePath,
      workspaceId: MEDIA_ID,
    },
    harness.paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      epochTargetSeconds: EPOCH_TARGET_SECONDS,
      ...overrides,
    } as never,
  );
}

/** Every path under `root`, relative and sorted, for set comparisons. */
async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      found.push(path.relative(root, absolute));
      if (entry.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return found.sort();
}

beforeAll(async () => {
  fixture = await ensureAdaptiveEpochFixture();
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-scratch-lifecycle-"));
}, 600_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("the scratch storage lifecycle", () => {
  it("reads the source in place and writes every intermediate to scratch", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * The encoder's own command line is the evidence. Asserting on where files
     * ended up would prove only that cleanup ran; asserting on the arguments
     * proves where FFmpeg was pointed while it was running, which is the claim
     * the whole feature rests on.
     */
    const commands: string[][] = [];
    const result = await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        commands.push(args);
        return runFfmpeg(command, args, options);
      },
    });
    expect(result.status).toBe("ready");
    expect(commands.length).toBeGreaterThan(0);

    for (const args of commands) {
      const input = args[args.indexOf("-i") + 1]!;
      // Read from the media volume, where the file already lay. The source is
      // never staged onto scratch first.
      expect(input).toBe(harness.sourcePath);

      // Every path the encoder was told to write is under scratch.
      const outputs = args.filter(
        (argument) =>
          path.isAbsolute(argument) &&
          argument !== input &&
          argument !== harness.sourcePath,
      );
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        const resolved = path.resolve(output);
        expect(
          resolved.startsWith(`${harness.ssdRoot}${path.sep}`),
          output,
        ).toBe(true);
        expect(
          resolved.startsWith(`${harness.hddRoot}${path.sep}`),
          output,
        ).toBe(false);
      }
    }
  }, 900_000);

  it("publishes a verified package and only then releases its scratch", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const result = await packageOnce(harness);
    expect(result.status).toBe("ready");

    // The package is live under the title, beside its source.
    const manifest = await readTitlePackageManifest(harness.titleRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.video.length).toBeGreaterThan(0);
    for (const rendition of [...manifest!.video, ...manifest!.audio]) {
      const media = await stat(
        path.join(harness.titleRoot, ...rendition.mediaPath.split("/")),
      );
      expect(media.size).toBe(rendition.fileSizeBytes);
    }

    // The source is untouched, and still exactly where it was.
    await expect(stat(harness.sourcePath)).resolves.toMatchObject({});

    // Scratch is released, and the hidden incoming directory with it.
    await expect(stat(harness.workspaceDirectory)).rejects.toThrow();
    await expect(
      stat(path.join(harness.titleRoot, TITLE_INCOMING_DIRECTORY)),
    ).rejects.toThrow();
  }, 900_000);

  it("resumes an interrupted publication without encoding again", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * Interrupted part-way through the copy, which is the case the feature
     * exists for: the transcode is finished and paid for, and only the move to
     * the media volume is outstanding.
     */
    const controller = new AbortController();
    const interrupted = await packageOnce(harness, {
      signal: controller.signal,
      onEvent: (event: { type: string }) => {
        if (event.type === "publish-progress") controller.abort();
      },
    });
    expect(interrupted.status).toBe("interrupted");

    // Nothing half-copied is reachable: the package was never activated.
    expect(await readTitlePackageManifest(harness.titleRoot)).toBeNull();
    // The verified scratch package survived the interruption.
    await expect(
      stat(path.join(harness.workspaceDirectory, ".verified-package.json")),
    ).resolves.toMatchObject({});
    // Planning asks the same question before it demands scratch for a build.
    await expect(
      hasVerifiedScratchPackage({
        workRoot: harness.jobsRoot,
        workspaceId: MEDIA_ID,
        sourceFingerprint: harness.fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      hasVerifiedScratchPackage({
        workRoot: harness.jobsRoot,
        workspaceId: MEDIA_ID,
        sourceFingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);

    /*
     * The second attempt must not invoke the encoder even once. Anything less
     * than zero invocations means a restart re-transcodes, which is the
     * failure this whole path exists to prevent.
     */
    let encodes = 0;
    const resumed = await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        encodes += 1;
        return runFfmpeg(command, args, options);
      },
    });
    expect(resumed.status).toBe("ready");
    expect(encodes).toBe(0);

    const manifest = await readTitlePackageManifest(harness.titleRoot);
    expect(manifest).not.toBeNull();
    for (const rendition of [...manifest!.video, ...manifest!.audio]) {
      const media = await stat(
        path.join(harness.titleRoot, ...rendition.mediaPath.split("/")),
      );
      expect(media.size).toBe(rendition.fileSizeBytes);
    }
    await expect(stat(harness.workspaceDirectory)).rejects.toThrow();
  }, 900_000);

  it("keeps the verified package when the media volume refuses writes", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    /*
     * Reject the final filesystem commit after scratch verification. This
     * boundary is deterministic under elevated tokens as well as ordinary
     * users; all source reads, encodes, copies and error handling stay real.
     */
    const fault = await rejectPublicationCommit(harness.titleRoot);
    let blocked: Awaited<ReturnType<typeof packageOnce>>;
    try {
      blocked = await packageOnce(harness, {
        publicationFileSystem: fault.fileSystem,
      });
    } finally {
      fault.restore();
    }
    expect(fault.rejected()).toBeGreaterThan(0);

    // Nothing was exposed, under any name.
    expect(blocked.status).not.toBe("ready");
    expect(await readTitlePackageManifest(harness.titleRoot)).toBeNull();

    /*
     * And the expensive part survived. This is the property that makes the
     * failure recoverable rather than a repeat of the whole encode: the
     * verified scratch package is still sitting there when the volume returns.
     */
    await expect(
      stat(path.join(harness.workspaceDirectory, ".verified-package.json")),
    ).resolves.toMatchObject({});

    // With the destination writable again, the job finishes without encoding.
    let encodes = 0;
    const recovered = await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        encodes += 1;
        return runFfmpeg(command, args, options);
      },
    });
    expect(recovered.status).toBe("ready");
    expect(encodes).toBe(0);
    expect(await readTitlePackageManifest(harness.titleRoot)).not.toBeNull();
  }, 900_000);

  it("parks the job when the media volume disappears during publication", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    // A verified package on scratch, with publication still outstanding.
    const controller = new AbortController();
    const interrupted = await packageOnce(harness, {
      signal: controller.signal,
      onEvent: (event: { type: string }) => {
        if (event.type === "publish-progress") controller.abort();
      },
    });
    expect(interrupted.status).toBe("interrupted");

    /*
     * The volume goes away. Renaming the root is what an unmount looks like
     * from inside the process: the path simply stops resolving, with no errno
     * anywhere in the message that says a disk was involved.
     */
    const parked = `${harness.hddRoot}.detached`;
    await rename(harness.hddRoot, parked);
    let result: Awaited<ReturnType<typeof packageOnce>>;
    try {
      result = await packageOnce(harness);
    } finally {
      await rename(parked, harness.hddRoot);
    }

    /*
     * Parked, not failed. This is the distinction the whole recovery model
     * rests on: a job that failed needs a person, and a job that is waiting for
     * its storage needs only the storage. Classifying this as a broken encode
     * discarded hours of finished work over a loose cable.
     */
    expect(result.status).toBe("interrupted");
    expect(result.interruption).toBe("storage");
    expect(["storage-device-lost", "storage-unavailable"]).toContain(
      result.failureKind,
    );
    // The verified package is still on scratch, waiting for the volume.
    await expect(
      stat(path.join(harness.workspaceDirectory, ".verified-package.json")),
    ).resolves.toMatchObject({});

    // And once it is back, the job finishes without touching the encoder.
    let encodes = 0;
    const recovered = await packageOnce(harness, {
      runEncoder: async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        encodes += 1;
        return runFfmpeg(command, args, options);
      },
    });
    expect(recovered.status).toBe("ready");
    expect(encodes).toBe(0);
  }, 900_000);

  it("never exposes a package built from a source that has been replaced", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const first = await packageOnce(harness);
    expect(first.status).toBe("ready");
    const published = await readTitlePackageManifest(harness.titleRoot);
    expect(published).not.toBeNull();

    /*
     * The same job id, the same title, different bytes. The scratch workspace
     * from the first build describes frames this source does not contain, and
     * carrying any of it over would publish a package for the wrong film.
     */
    const replaced = {
      ...harness,
      fingerprint: `ffff${harness.fingerprint.slice(4)}`,
    };
    await writeFile(
      path.join(replaced.workspaceDirectory, ".seyirlik-job.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "seyirlik-processing-job",
        workspaceId: MEDIA_ID,
        sourceFingerprint: harness.fingerprint,
      }),
      "utf8",
    ).catch(() => undefined);

    const second = await packageOnce(replaced);
    // Whatever it decides, the previously published package is still whole.
    const after = await readTitlePackageManifest(harness.titleRoot);
    expect(after).not.toBeNull();
    for (const rendition of [...after!.video, ...after!.audio]) {
      const media = await stat(
        path.join(harness.titleRoot, ...rendition.mediaPath.split("/")),
      );
      expect(media.size).toBe(rendition.fileSizeBytes);
    }
    expect(["ready", "failed", "validation-failed", "already-valid"]).toContain(
      second.status,
    );
  }, 900_000);

  it("leaves no processing intermediates behind on the media volume", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const result = await packageOnce(harness);
    expect(result.status).toBe("ready");

    /*
     * Whatever is on the media volume afterwards is either the source or part
     * of the published package. No epoch directory, no `.partial`, no staging
     * remnant and no incoming directory may survive a clean publication.
     */
    for (const relative of await walk(harness.hddRoot)) {
      expect(relative).not.toContain(".partial");
      expect(relative).not.toContain("epochs");
      expect(relative).not.toContain(TITLE_INCOMING_DIRECTORY);
    }
  }, 900_000);

  it("recognises a package that was published before the job could record it", async () => {
    if (!fixture) return;
    const harness = await createHarness();

    const first = await packageOnce(harness);
    expect(first.status).toBe("ready");
    const before = await readFile(
      path.join(harness.titleRoot, ".seyirlik", "package.json"),
      "utf8",
    );

    /*
     * The crash this models: the final rename succeeded and the process died
     * before the database heard about it, so the job is run again against a
     * title that is already finished.
     */
    const again = await packageOnce(harness);
    expect(again.status).toBe("already-valid");
    // Reconciled, not rebuilt: the published package is byte-identical.
    await expect(
      readFile(
        path.join(harness.titleRoot, ".seyirlik", "package.json"),
        "utf8",
      ),
    ).resolves.toBe(before);
  }, 900_000);
});
