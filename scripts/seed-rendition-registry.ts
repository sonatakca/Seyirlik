/** One-time, backed-up import after old writers have been drained. */
import { constants } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { loadRenditionRegistry } from "../src/renditions/registry";
import { importRenditionRegistry } from "../src/server/ownApi/processing/renditionRegistryStore";

const pool = createDatabasePool(parseDatabaseConfig());
try {
  const existing = await pool.query("SELECT 1 FROM rendition_registry");
  if (existing.rowCount) {
    console.info("REGISTRY_IMPORT=already present");
  } else {
    const active = await pool.query(
      "SELECT 1 FROM processing_jobs WHERE state = 'running' LIMIT 1",
    );
    if (active.rowCount)
      throw new Error(
        "Drain or pause running encodes before importing the rendition registry.",
      );
    const backupRoot = process.argv[2];
    const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;
    if (!backupRoot || !mediaRoot)
      throw new Error(
        "A local backup directory and SEYIRLIK_MEDIA_ROOT are required.",
      );
    const source = path.join(
      process.env.SEYIRLIK_RENDITION_STATE_ROOT ||
        path.join(mediaRoot, ".seyirlik", "state"),
      "registry.json",
    );
    await stat(source); // A missing mount is not an empty library.
    await mkdir(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, "rendition-registry.json");
    await copyFile(source, backup, constants.COPYFILE_EXCL);
    const registry = await loadRenditionRegistry(backup);
    const result = await importRenditionRegistry(pool, registry, {
      source: backup,
      writer: "deployment import",
    });
    console.info(
      `REGISTRY_IMPORT=${result.importedItems} items; backup=${backup}`,
    );
  }
} finally {
  await pool.end();
}
