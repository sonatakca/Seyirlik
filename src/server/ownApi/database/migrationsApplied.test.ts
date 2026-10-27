// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { validateMigrationsApplied } from "./migrationRunner";

/*
 * The gate every service passes at startup, against a fake table.
 *
 * What changed is the one case that used to be refused: a database that has
 * migrations this release does not ship. An older worker finishing its last job
 * beside a newer server, and a rollback, both start exactly there.
 */
const FILES = ["001_first.sql", "002_second.sql"];
let migrations: string;

function checksum(name: string): string {
  return createHash("sha256").update(`-- ${name}\n`).digest("hex");
}

beforeAll(async () => {
  migrations = await mkdtemp(path.join(tmpdir(), "seyirlik-applied-"));
  for (const name of FILES) {
    await writeFile(path.join(migrations, name), `-- ${name}\n`);
  }
});

afterAll(async () => {
  await rm(migrations, { recursive: true, force: true });
});

function database(
  rows: Array<{ version: string; checksum: string }>,
): Pick<Pool, "query"> {
  return {
    query: async () => ({ rows }),
  } as unknown as Pick<Pool, "query">;
}

const shipped = FILES.map((file) => ({
  version: path.basename(file, ".sql"),
  checksum: checksum(file),
}));

describe("whether this release's schema is in the database", () => {
  it("accepts exactly the migrations it ships", async () => {
    await expect(
      validateMigrationsApplied(database(shipped), migrations),
    ).resolves.toBeUndefined();
  });

  it("accepts a database a newer release has migrated further", async () => {
    await expect(
      validateMigrationsApplied(
        database([...shipped, { version: "003_newer", checksum: "x" }]),
        migrations,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a database that is behind it", async () => {
    await expect(
      validateMigrationsApplied(database(shipped.slice(0, 1)), migrations),
    ).rejects.toThrow("migrations are not current");
  });

  it("refuses a migration recorded with another file's checksum", async () => {
    await expect(
      validateMigrationsApplied(
        database([shipped[0]!, { ...shipped[1]!, checksum: "edited" }]),
        migrations,
      ),
    ).rejects.toThrow("migrations are not current");
  });

  it("refuses a newer migration recorded in the middle of its own", async () => {
    // Versions sort, so a gap in this release's run means a version it does
    // not know was recorded before one it does: not "ahead", just different.
    await expect(
      validateMigrationsApplied(
        database([
          shipped[0]!,
          { version: "001_other", checksum: "x" },
          shipped[1]!,
        ]),
        migrations,
      ),
    ).rejects.toThrow("migrations are not current");
  });
});
