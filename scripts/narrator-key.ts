/**
 * Makes, lists and revokes the keys a narrator (the Mac that reads books
 * aloud) signs in with. Run it where the server's database settings are:
 *
 *   node --env-file=<settings.env> --env-file=<secrets.env> --import tsx scripts/narrator-key.ts create "MacBook Pro"
 *   ... scripts/narrator-key.ts list
 *   ... scripts/narrator-key.ts revoke <id>
 *
 * A new key is printed once and never stored: only its SHA-256 is kept. Give
 * it to the narrator with `python -m seyirlik_narrator.service connect`.
 */

import { randomUUID } from "node:crypto";

import { createNarrationRepository } from "../src/server/ownApi/books/narration/narrationRepository";
import {
  hashNarratorKey,
  newNarratorKey,
} from "../src/server/ownApi/books/narration/narrationRoutes";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const config = parseDatabaseConfig({ ...process.env });
  if (!config) throw new Error("Native database configuration is unavailable.");
  const pool = createDatabasePool(config);
  const narrations = createNarrationRepository(pool);

  try {
    if (command === "create") {
      const label = (argument ?? "").trim();
      if (!label || label.length > 100)
        throw new Error('Name the narrator: create "MacBook Pro".');
      const key = newNarratorKey();
      const created = await narrations.createKey(
        randomUUID(),
        label,
        hashNarratorKey(key),
      );
      console.info(
        `Narrator key for ${created.label} (${created.id}):\n\n  ${key}\n`,
      );
      console.info(
        "It is shown only now. Keep it in the narrator, not in a file.",
      );
    } else if (command === "list") {
      for (const key of await narrations.listKeys()) {
        const state = key.revokedAt
          ? `revoked ${key.revokedAt.toISOString()}`
          : `last seen ${key.lastSeenAt?.toISOString() ?? "never"}`;
        console.info(`${key.id}  ${key.label}  ${state}`);
      }
    } else if (command === "revoke" && argument) {
      console.info(
        (await narrations.revokeKey(argument))
          ? "Revoked: that narrator can no longer sign in."
          : "No active key has that id.",
      );
    } else {
      throw new Error("Use: create <name> | list | revoke <id>");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown error");
  process.exitCode = 1;
});
