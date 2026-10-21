import { mkdtemp, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSourceFingerprint,
  createEmptyRenditionRegistry,
  loadRenditionRegistry,
  RenditionRegistryUnreadableError,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "./registry";

describe("persistent rendition registry", () => {
  it("does not merge separate unprobeable sources that use the unknown fingerprint", () => {
    const registry = createEmptyRenditionRegistry();
    const first = upsertRegistrySource(registry, {
      relativePath: "Movies/one.mkv",
      size: 1,
      mtimeMs: 1,
      sourceFingerprint: "0".repeat(64),
    });
    const second = upsertRegistrySource(registry, {
      relativePath: "Movies/two.mkv",
      size: 1,
      mtimeMs: 1,
      sourceFingerprint: "0".repeat(64),
    });

    expect(second.id).not.toBe(first.id);
    expect(registry.items).toHaveLength(2);
  });

  it("keeps a stable UUID when a source changes at the same relative path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-"));
    const sourcePath = path.join(root, "film.mkv");
    await writeFile(sourcePath, "first version");
    const firstStat = await import("node:fs/promises").then(({ stat }) =>
      stat(sourcePath),
    );
    const firstFingerprint = await computeSourceFingerprint(
      sourcePath,
      firstStat,
    );
    const registry = createEmptyRenditionRegistry();
    const first = upsertRegistrySource(registry, {
      relativePath: "Movies/film.mkv",
      size: firstStat.size,
      mtimeMs: firstStat.mtimeMs,
      sourceFingerprint: firstFingerprint,
    });

    await writeFile(sourcePath, "second and longer version");
    await utimes(sourcePath, new Date(), new Date(Date.now() + 2_000));
    const secondStat = await import("node:fs/promises").then(({ stat }) =>
      stat(sourcePath),
    );
    const second = upsertRegistrySource(registry, {
      relativePath: "Movies/film.mkv",
      size: secondStat.size,
      mtimeMs: secondStat.mtimeMs,
      sourceFingerprint: await computeSourceFingerprint(sourcePath, secondStat),
    });

    expect(second.id).toBe(first.id);
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it("reuses identity after a move when the fingerprint still matches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-move-"));
    const originalPath = path.join(root, "original.mkv");
    const movedPath = path.join(root, "moved.mkv");
    await writeFile(originalPath, "stable source bytes");
    const originalStat = await import("node:fs/promises").then(({ stat }) =>
      stat(originalPath),
    );
    const fingerprint = await computeSourceFingerprint(
      originalPath,
      originalStat,
    );
    const registry = createEmptyRenditionRegistry();
    const original = upsertRegistrySource(registry, {
      relativePath: "Movies/original.mkv",
      size: originalStat.size,
      mtimeMs: originalStat.mtimeMs,
      sourceFingerprint: fingerprint,
    });

    await rename(originalPath, movedPath);
    const movedStat = await import("node:fs/promises").then(({ stat }) =>
      stat(movedPath),
    );
    const moved = upsertRegistrySource(registry, {
      relativePath: "Movies/moved.mkv",
      size: movedStat.size,
      mtimeMs: movedStat.mtimeMs,
      sourceFingerprint: await computeSourceFingerprint(movedPath, movedStat),
    });

    expect(moved.id).toBe(original.id);
    expect(registry.items).toHaveLength(1);
    expect(registry.items[0]?.relativePath).toBe("Movies/moved.mkv");
  });

  it("preserves adaptive readiness when only the legacy profile changes", () => {
    const registry = createEmptyRenditionRegistry();
    const fingerprint = "a".repeat(64);
    const first = upsertRegistrySource(registry, {
      relativePath: "Movies/film.mkv",
      size: 10,
      mtimeMs: 1,
      sourceFingerprint: fingerprint,
    });
    first.adaptiveStatus = "ready";
    first.adaptiveProfileVersion = "cmaf-hls-aligned-v1";
    registry.profileVersion = "future-legacy-profile";

    const updated = upsertRegistrySource(registry, {
      relativePath: "Movies/film.mkv",
      size: 10,
      mtimeMs: 1,
      sourceFingerprint: fingerprint,
    });

    expect(updated.status).toBe("stale");
    expect(updated.adaptiveStatus).toBe("ready");
    expect(updated.adaptiveProfileVersion).toBe("cmaf-hls-aligned-v1");
  });

  it("never reads an empty registry file as an empty registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-"));
    const registryPath = path.join(root, "registry.json");
    await writeFile(registryPath, "");

    await expect(loadRenditionRegistry(registryPath)).rejects.toBeInstanceOf(
      RenditionRegistryUnreadableError,
    );
  });

  it("waits out a registry that reads back empty for a moment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-"));
    const registryPath = path.join(root, "registry.json");
    const saved = createEmptyRenditionRegistry();
    upsertRegistrySource(saved, {
      relativePath: "Movies/Dune.mp4",
      size: 1,
      mtimeMs: 1,
      sourceFingerprint: "a".repeat(64),
    });
    await saveRenditionRegistry(registryPath, saved);
    const full = await readFile(registryPath, "utf8");
    await writeFile(registryPath, "");

    let reported = 0;
    const loading = loadRenditionRegistry(registryPath, {
      unreadableWaitMs: 5_000,
      unreadablePollMs: 20,
      onUnreadable: () => {
        reported += 1;
      },
    });
    setTimeout(() => void writeFile(registryPath, full), 60);

    const loaded = await loading;
    expect(loaded.items.map((item) => item.relativePath)).toEqual([
      "Movies/Dune.mp4",
    ]);
    expect(reported).toBe(1);
  });

  it("gives up once the wait is over", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-"));
    const registryPath = path.join(root, "registry.json");
    await writeFile(registryPath, "{\"schemaVersion\": 1, \"ite");

    await expect(
      loadRenditionRegistry(registryPath, {
        unreadableWaitMs: 60,
        unreadablePollMs: 20,
      }),
    ).rejects.toThrow(/could not be read \(.*JSON/);
  });
});
