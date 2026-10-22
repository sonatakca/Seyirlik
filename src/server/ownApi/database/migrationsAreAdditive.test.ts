// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { additiveViolations } from "./migrationsAreAdditive";

/*
 * Releases overlap. A worker on the previous release keeps running until its
 * job ends, MSI may be switched on days after a ship, and a rollback runs the
 * previous code against the newer schema (`validateMigrationsApplied`). All of
 * that is only safe while a migration never takes away what older code reads
 * or writes, so every migration after the rule was made is held to it here.
 *
 * Where a change really must remove something, it takes two releases: one that
 * stops using it, and a later one that removes it with a `-- contract:` line
 * saying which release stopped using it.
 */
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
/** The last migration written before the rule; 005 and 015 predate it. */
const BASELINE = 39;

describe("migrations only add", () => {
  it("holds every migration after the baseline to it", async () => {
    const files = (await readdir(MIGRATIONS))
      .filter((file) => /^\d{3,}_.*\.sql$/.test(file))
      .filter((file) => Number.parseInt(file, 10) > BASELINE);
    const found: string[] = [];
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS, file), "utf8");
      for (const violation of additiveViolations(sql)) {
        found.push(`${path.basename(file)}: ${violation}`);
      }
    }
    expect(found).toEqual([]);
  });

  it.each([
    ["ALTER TABLE jobs DROP COLUMN result;", "drops a column"],
    ["DROP TABLE IF EXISTS old_things;", "drops a table"],
    ["ALTER TABLE jobs RENAME COLUMN result TO outcome;", "renames"],
    ["ALTER TABLE jobs RENAME TO tasks;", "renames"],
    ["ALTER TABLE jobs ALTER COLUMN priority TYPE bigint;", "changes a type"],
    ["ALTER TABLE jobs ALTER COLUMN result SET NOT NULL;", "SET NOT NULL"],
    [
      "ALTER TABLE jobs ADD COLUMN owner text NOT NULL;",
      "NOT NULL with no DEFAULT",
    ],
  ])("refuses %s", (sql, reason) => {
    expect(additiveViolations(sql).join(" ")).toContain(reason);
  });

  it.each([
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner text;",
    "ALTER TABLE jobs ADD COLUMN owner text NOT NULL DEFAULT '';",
    "CREATE TABLE things (id uuid PRIMARY KEY, name text NOT NULL);",
    "CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs (owner);",
    "-- the old code used to DROP COLUMN this; it no longer does\nSELECT 1;",
    "ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_owner_check;",
  ])("allows %s", (sql) => {
    expect(additiveViolations(sql)).toEqual([]);
  });

  it("allows a removal that says which release stopped using it", () => {
    expect(
      additiveViolations(
        "-- contract: 2026.11.02-1 stopped reading result\nALTER TABLE jobs DROP COLUMN result;",
      ),
    ).toEqual([]);
  });
});
