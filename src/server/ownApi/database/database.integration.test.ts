// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "./databasePool";
import { runMigrations, validateMigrationsApplied } from "./migrationRunner";
import { withTransaction } from "./transaction";
import { createUserRepository } from "../users/userRepository";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL native identity persistence", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const users = createUserRepository(pool);

  beforeAll(async () => {
    // Reset the whole schema rather than a list of tables. Dropping only the
    // identity tables left the catalogue ones from later migrations behind, so
    // re-running the migrations failed on a table that already existed.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs migrations on a clean database and safely re-runs them", async () => {
    // Deliberately not a hard-coded list: this asserted a single migration and
    // started failing the moment the catalogue migrations were added.
    const first = await runMigrations(pool);
    expect(first.applied[0]).toBe("001_native_identity");
    expect(first.applied.length).toBeGreaterThan(0);

    await expect(runMigrations(pool)).resolves.toEqual({ applied: [] });

    const migrationRows = await pool.query<{ version: string }>(
      "SELECT version FROM seyirlik_migrations ORDER BY version",
    );
    expect(migrationRows.rows.map((row) => row.version)).toEqual(
      [...first.applied].sort(),
    );
    await expect(validateMigrationsApplied(pool)).resolves.toBeUndefined();

    const original = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM seyirlik_migrations WHERE version = $1",
      ["001_native_identity"],
    );
    await pool.query(
      "UPDATE seyirlik_migrations SET checksum = $2 WHERE version = $1",
      ["001_native_identity", "tampered"],
    );
    await expect(validateMigrationsApplied(pool)).rejects.toThrow(
      "Native identity database migrations are not current.",
    );
    await pool.query(
      "UPDATE seyirlik_migrations SET checksum = $2 WHERE version = $1",
      ["001_native_identity", original.rows[0]?.checksum],
    );
  });

  it("rejects duplicate normalized usernames", async () => {
    const normalizedUsername = `person-${randomUUID()}`;
    const create = () =>
      users.create({
        id: randomUUID(),
        normalizedUsername,
        displayName: "Person",
        passwordHash: "$argon2id$test-only-placeholder",
        isAdministrator: false,
      });

    await create();
    await expect(create()).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls transactions back on failure", async () => {
    const id = randomUUID();

    await expect(
      withTransaction(pool, async (transaction) => {
        await transaction.query(
          `INSERT INTO native_users (
            id, normalized_username, display_name, password_hash, is_administrator
          ) VALUES ($1, $2, $3, $4, $5)`,
          [id, `rollback-${id}`, "Rollback", "$argon2id$test-only", false],
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    await expect(users.findById(id)).resolves.toBeNull();
  });
});
