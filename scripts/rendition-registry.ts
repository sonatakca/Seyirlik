/**
 * Moves the rendition registry between `registry.json` and the database.
 *
 *   rendition-registry import <registry.json>              what would happen
 *   rendition-registry import <registry.json> --apply      create the row
 *   rendition-registry import <registry.json> --apply --replace
 *                                                          overwrite the row
 *   rendition-registry export <registry.json>              write the row out
 *
 * The services read the registry from the database since migration 040. Run
 * the import once, on the server, before either machine starts on a release
 * that has it; otherwise the first service to start seeds the row from
 * whatever its own mount serves at that moment. Export to local disk, not to
 * the Drive mount.
 */
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
} from "../src/renditions/registry";
import {
  createDatabaseRenditionRegistryStore,
  importRenditionRegistry,
} from "../src/server/ownApi/processing/renditionRegistryStore";

function counts(items: { adaptiveStatus?: string }[]) {
  const ready = items.filter((item) => item.adaptiveStatus === "ready").length;
  return `${items.length} items, ${ready} adaptive-ready`;
}

async function main(): Promise<void> {
  const [command, file, ...flags] = process.argv.slice(2);
  if ((command !== "import" && command !== "export") || !file) {
    throw new Error(
      "Usage: rendition-registry import|export <registry.json> [--apply] [--replace]",
    );
  }
  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");
  const pool = createDatabasePool(config);
  const filePath = path.resolve(file);
  try {
    if (command === "export") {
      const registry = await createDatabaseRenditionRegistryStore(pool).read();
      await saveRenditionRegistry(filePath, registry);
      console.info(`Exported ${counts(registry.items)} to ${filePath}.`);
      return;
    }

    // Throws on an empty or cut-short file rather than importing nothing.
    await stat(filePath); // Missing mount input must never become an empty import.
    const registry = await loadRenditionRegistry(filePath);
    console.info(`${filePath}: ${counts(registry.items)}.`);
    if (!flags.includes("--apply")) {
      const existing = await pool.query<{ document: { items: unknown[] } }>(
        "SELECT document FROM rendition_registry",
      );
      const row = existing.rows[0];
      console.info(
        row
          ? `The database already holds ${row.document.items.length} items; --apply --replace would overwrite them.`
          : "The database holds no registry yet; --apply would import this file.",
      );
      return;
    }
    const result = await importRenditionRegistry(pool, registry, {
      source: filePath,
      replace: flags.includes("--replace"),
      writer: `rendition-registry import on ${hostname()}`,
    });
    console.info(
      result.written
        ? `Imported ${result.importedItems} items` +
            (result.previousItems === null
              ? "."
              : `, replacing ${result.previousItems}.`)
        : `Left the database's ${result.previousItems} items alone; pass --replace to overwrite them.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "rendition-registry failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
