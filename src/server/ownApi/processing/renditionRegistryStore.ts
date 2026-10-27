import type { Pool } from "pg";
import {
  createEmptyRenditionRegistry,
  loadRenditionRegistry,
  parseRenditionRegistry,
  type RenditionRegistry,
  type RenditionRegistryStore,
} from "../../../renditions/registry";
import { withTransaction } from "../database/transaction";

export interface DatabaseRenditionRegistryStoreOptions {
  /** Recorded on each write, so the row says which machine changed it last. */
  writer?: string;
  /**
   * The old `registry.json`, imported if the row does not exist yet.
   *
   * Only a file that reads as a whole, valid registry is imported. A missing
   * file is a new library and starts empty; an empty or cut-short one is an
   * error, never an empty registry, because that is exactly what the Drive
   * mount serves while it is catching up.
   */
  seedFrom?: string;
  /** Running services require a deliberate import before first use. */
  requireExisting?: boolean;
}

/**
 * The rendition registry in PostgreSQL; see migration 041.
 *
 * Both machines write it, and each change runs in a transaction that holds the
 * row, so two writers queue rather than overwrite each other.
 */
export function createDatabaseRenditionRegistryStore(
  pool: Pick<Pool, "query" | "connect">,
  options: DatabaseRenditionRegistryStoreOptions = {},
): RenditionRegistryStore {
  let present = false;

  const ensureRow = async () => {
    if (present) return;
    const existing = await pool.query("SELECT 1 FROM rendition_registry");
    if (existing.rowCount === 0) {
      if (options.requireExisting)
        throw new Error(
          "The rendition registry has not been imported into PostgreSQL. Run scripts/rendition-registry.ts import before starting services.",
        );
      const initial = options.seedFrom
        ? await loadRenditionRegistry(options.seedFrom)
        : createEmptyRenditionRegistry();
      const inserted = await pool.query(
        `INSERT INTO rendition_registry (document, updated_by, imported_from)
         VALUES ($1::jsonb, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [
          JSON.stringify(parseRenditionRegistry(initial)),
          options.writer ?? null,
          options.seedFrom ?? null,
        ],
      );
      if (inserted.rowCount === 1)
        console.warn("rendition_registry.seeded", {
          from: options.seedFrom ?? null,
          items: initial.items.length,
        });
    }
    present = true;
  };

  return {
    async read() {
      await ensureRow();
      const result = await pool.query<{ document: unknown }>(
        "SELECT document FROM rendition_registry",
      );
      return parseRenditionRegistry(result.rows[0]?.document);
    },

    async update<T>(mutate: (registry: RenditionRegistry) => T): Promise<T> {
      await ensureRow();
      return withTransaction(pool, async (client) => {
        const current = await client.query<{ document: unknown }>(
          "SELECT document FROM rendition_registry FOR UPDATE",
        );
        const registry = parseRenditionRegistry(current.rows[0]?.document);
        const value = mutate(registry);
        registry.updatedAt = new Date().toISOString();
        await client.query(
          `UPDATE rendition_registry
              SET document = $1::jsonb, revision = revision + 1,
                  updated_at = now(), updated_by = $2`,
          [
            JSON.stringify(parseRenditionRegistry(registry)),
            options.writer ?? null,
          ],
        );
        return value;
      });
    },

    async revision() {
      const result = await pool.query<{ revision: string }>(
        "SELECT revision::text AS revision FROM rendition_registry",
      );
      return result.rows[0]?.revision ?? "missing";
    },
  };
}

export interface RenditionRegistryImportResult {
  /** Items in the row before the import; null when there was no row. */
  previousItems: number | null;
  importedItems: number;
  written: boolean;
}

/**
 * Puts a registry read from a file into the database, for the one-off move
 * from `registry.json` and for restoring a copy.
 *
 * An existing row is replaced only when asked, because it is newer than any
 * file by construction once the services run on the database.
 */
export async function importRenditionRegistry(
  pool: Pick<Pool, "connect">,
  registry: RenditionRegistry,
  options: { source: string; replace?: boolean; writer?: string },
): Promise<RenditionRegistryImportResult> {
  const document = JSON.stringify(parseRenditionRegistry(registry));
  return withTransaction(pool, async (client) => {
    const current = await client.query<{ document: unknown }>(
      "SELECT document FROM rendition_registry FOR UPDATE",
    );
    const existing = current.rows[0];
    const previousItems = existing
      ? parseRenditionRegistry(existing.document).items.length
      : null;
    const result = {
      previousItems,
      importedItems: registry.items.length,
    };
    if (!existing) {
      await client.query(
        `INSERT INTO rendition_registry (document, updated_by, imported_from)
         VALUES ($1::jsonb, $2, $3)`,
        [document, options.writer ?? null, options.source],
      );
      return { ...result, written: true };
    }
    if (!options.replace) return { ...result, written: false };
    await client.query(
      `UPDATE rendition_registry
          SET document = $1::jsonb, revision = revision + 1, updated_at = now(),
              updated_by = $2, imported_from = $3`,
      [document, options.writer ?? null, options.source],
    );
    return { ...result, written: true };
  });
}
