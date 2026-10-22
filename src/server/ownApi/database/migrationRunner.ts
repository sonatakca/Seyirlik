import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";

const MIGRATION_FILE_PATTERN = /^\d{3,}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = "7610294835701";
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("./migrations", import.meta.url),
);

export interface MigrationResult {
  applied: string[];
}

interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
}

async function loadMigrationFiles(
  migrationsDirectory: string,
): Promise<MigrationFile[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
      return {
        version: path.basename(file, ".sql"),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

/** The schema a database is actually carrying. */
export interface SchemaState {
  /** How many migrations the database has recorded. */
  readonly applied: number;
  /** The newest one, or null for a database that has never been migrated. */
  readonly latest: string | null;
  /** True when the recorded set matches the migrations shipped with this code. */
  readonly current: boolean;
  /** Shipped but not recorded. Non-empty means the code is ahead of the schema. */
  readonly pending: string[];
}

/**
 * Reads the schema state, for reporting rather than for gating.
 *
 * The name of the table matters more than it looks. Operational scripts have
 * asked `schema_migrations` — which has never existed here — and got an empty
 * answer back, so a restore-verification step that reported a migration count
 * as its evidence was reporting nothing at all. Any caller that needs this
 * figure should take it from here rather than writing the query again.
 */
export async function readSchemaState(
  database: Pick<Pool, "query">,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<SchemaState> {
  const shipped = await loadMigrationFiles(migrationsDirectory);
  let recorded: string[];
  try {
    const result = await database.query<{ version: string }>(
      "SELECT version FROM seyirlik_migrations ORDER BY version",
    );
    recorded = result.rows.map((row) => row.version);
  } catch {
    // A database that has never been migrated has no table to read, which is a
    // state to report rather than an error to raise.
    recorded = [];
  }

  const applied = new Set(recorded);
  const pending = shipped
    .map((file) => file.version)
    .filter((version) => !applied.has(version));

  return {
    applied: recorded.length,
    latest: recorded.length > 0 ? recorded[recorded.length - 1]! : null,
    current: pending.length === 0,
    pending,
  };
}

/**
 * Refuses to start code whose schema the database does not carry.
 *
 * Every migration this release ships must be recorded, in order, with the
 * checksum of the file shipped. Migrations recorded *after* those are allowed:
 * they belong to a newer release, and an older one has to keep running beside
 * them — the worker finishing its last job on the old release while the new
 * server runs (`releaseHandoff.ts`), MSI switched on after a ship that
 * migrated, or a rollback. That is safe because migrations only add; see
 * `migrationsAreAdditive.test.ts`, which holds them to it.
 *
 * It used to demand an exact match, which made every older worker unbootable
 * the moment a newer release migrated, and made activation's own rollback
 * fail on the step it existed for.
 */
export async function validateMigrationsApplied(
  database: Pick<Pool, "query">,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<void> {
  const expected = await loadMigrationFiles(migrationsDirectory);
  let rows: Array<{ version: string; checksum: string }>;
  try {
    const result = await database.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM seyirlik_migrations ORDER BY version",
    );
    rows = result.rows;
  } catch {
    throw new Error("Native identity database migrations are not current.");
  }

  if (
    rows.length < expected.length ||
    expected.some(
      (migration, index) =>
        rows[index]?.version !== migration.version ||
        rows[index]?.checksum !== migration.checksum,
    )
  ) {
    throw new Error("Native identity database migrations are not current.");
  }
}

export async function runMigrations(
  pool: Pick<Pool, "connect">,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Promise<MigrationResult> {
  const migrations = await loadMigrationFiles(migrationsDirectory);
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS seyirlik_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const { version, sql, checksum } of migrations) {
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM seyirlik_migrations WHERE version = $1",
        [version],
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${version} has changed.`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO seyirlik_migrations (version, checksum) VALUES ($1, $2)",
          [version, checksum],
        );
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return { applied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    client.release();
  }
}
