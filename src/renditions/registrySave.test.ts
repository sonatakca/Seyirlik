import { mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptyRenditionRegistry,
  loadRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "./registry";

function registryWith(relativePath: string) {
  const registry = createEmptyRenditionRegistry();
  upsertRegistrySource(registry, {
    relativePath,
    size: 1,
    mtimeMs: 1,
    sourceFingerprint: "a".repeat(64),
  });
  return registry;
}

describe("saving the rendition registry", () => {
  for (const writeMode of ["rename", "in-place"] as const) {
    it(`replaces the registry and leaves nothing beside it (${writeMode})`, async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "seyirlik-registry-save-"),
      );
      const registryPath = path.join(root, "state", "registry.json");
      await saveRenditionRegistry(registryPath, registryWith("Movies/a.mkv"), {
        writeMode,
      });
      await saveRenditionRegistry(registryPath, registryWith("Movies/b.mkv"), {
        writeMode,
      });

      const saved = await loadRenditionRegistry(registryPath);
      expect(saved.items.map((item) => item.relativePath)).toEqual([
        "Movies/b.mkv",
      ]);
      expect(await readdir(path.dirname(registryPath))).toEqual([
        "registry.json",
      ]);
    });
  }

  /*
   * rclone's Drive mount, given a rename onto a file it still holds open,
   * reports success and then serves an empty file. A file that swallows its
   * writes is the nearest local stand-in.
   */
  it.skipIf(process.platform === "win32")(
    "fails a save whose file does not read back as written",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "seyirlik-registry-save-"),
      );
      const registryPath = path.join(root, "registry.json");
      await symlink("/dev/null", registryPath);

      await expect(
        saveRenditionRegistry(registryPath, registryWith("Movies/a.mkv"), {
          writeMode: "in-place",
        }),
      ).rejects.toThrow(
        /did not land: .*registry\.json reads back 0 characters/,
      );
    },
  );
});
