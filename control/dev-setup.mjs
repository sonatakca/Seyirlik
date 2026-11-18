#!/usr/bin/env node
/**
 * Prepares a throwaway setup for running the dashboard on a development
 * machine: sample env files with fake values, simulated services, loopback
 * only. Everything goes in control/.dev/, which git ignores.
 *
 *   node control/dev-setup.mjs
 *   node control/server.mjs set-password --config control/.dev/control.json
 *   node control/server.mjs --config control/.dev/control.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".dev");
const at = (...parts) => path.join(root, ...parts);

await fs.mkdir(at("config"), { recursive: true });
await fs.mkdir(at("secrets"), { recursive: true });
await fs.mkdir(at("logs"), { recursive: true });
await fs.mkdir(at("generated"), { recursive: true });

async function writeOnce(file, text) {
  try {
    await fs.writeFile(file, text, { flag: "wx" });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

await writeOnce(
  at("config", "settings.env"),
  [
    "# Sample settings for the dashboard's development mode. Not real.",
    `SEYIRLIK_MEDIA_ROOT=${at("media-drive-that-is-missing")}`,
    `SEYIRLIK_GENERATED_STORAGE=${at("generated")}`,
    "SEYIRLIK_PORT=43111",
    "SEYIRLIK_RESTART_MODE=supervisor",
    "SEYIRLIK_RUN_WORKER=false",
    'SEYIRLIK_LIBRARIES=\'[{"slug":"films","kind":"movies","roots":["movies"]}]\'',
    'SEYIRLIK_SABNZBD=\'{"baseUrl":"http://127.0.0.1:8080/sabnzbd/api?apikey=fake-key-in-url","category":"seyirlik"}\'',
    "SEYIRLIK_ALLOWED_ORIGINS=https://seyirlik.org,https://www.seyirlik.org",
    "",
  ].join("\n"),
);
await writeOnce(
  at("secrets", "secrets.env"),
  [
    "DATABASE_URL=postgresql://seyirlik:not-a-real-password@127.0.0.1:5432/seyirlik",
    "SEYIRLIK_SESSION_HASH_SECRET=dev-only-session-secret-0123456789abcdef",
    "SEYIRLIK_CSRF_SECRET=dev-only-csrf-secret-0123456789abcdefghij",
    "SEYIRLIK_TMDB_API_KEY=dev-only-tmdb-key",
    "",
  ].join("\n"),
);
await writeOnce(
  at("logs", "server.log"),
  "2026-10-17T08:30:50Z startup: media-storage degraded: SEYIRLIK_MEDIA_ROOT must point to an existing media directory.\n",
);
await writeOnce(
  at("control.json"),
  JSON.stringify(
    {
      listen: ["127.0.0.1"],
      port: 43200,
      settingsFile: at("config", "settings.env"),
      secretsFile: at("secrets", "secrets.env"),
      dataDir: at("control"),
      logsDir: at("logs"),
      healthUrl:
        process.env.SEYIRLIK_CONTROL_HEALTH_URL ??
        "http://127.0.0.1:43111/ownAPI/v1/health",
      services: ["SeyirlikServer", "SeyirlikWorker", "SeyirlikPostgres"],
      restartOnApply: ["SeyirlikServer", "SeyirlikWorker"],
      platform: "dev",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `\nNext:\n  node control/server.mjs set-password --config ${path.relative(process.cwd(), at("control.json"))}\n  node control/server.mjs --config ${path.relative(process.cwd(), at("control.json"))}`,
);
