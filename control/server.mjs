#!/usr/bin/env node
/**
 * Seyirlik Control: a small dashboard for the server's configuration and
 * services, reachable over Tailscale only.
 *
 *   node server.mjs --config <control.json>                 run the dashboard
 *   node server.mjs set-password --config <control.json>    set or change the password
 *
 * It is its own process and its own Windows service on purpose. The media
 * server cannot be the thing that repairs the media server: when its drive is
 * missing or its database is down, it is not able to serve an admin page, and
 * that is exactly when someone needs to change a path and restart it.
 *
 * No dependencies beyond Node itself, so it runs from its own folder and is
 * not affected by a broken release or a half-finished `npm install`.
 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSessions,
  hashPassword,
  MIN_PASSWORD_LENGTH,
} from "./lib/auth.mjs";
import { createApp } from "./lib/app.mjs";
import { createConfigStore, writeAtomic } from "./lib/configStore.mjs";
import { devPlatform, windowsPlatform } from "./lib/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RETRY_LISTEN_MS = 10_000;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = {
    command: "serve",
    config: process.env.SEYIRLIK_CONTROL_CONFIG ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") args.config = argv[++i] ?? "";
    else if (!argv[i].startsWith("-")) args.command = argv[i];
  }
  if (!args.config) throw new Error("Pass --config <path to control.json>.");
  args.config = path.resolve(args.config);
  return args;
}

/**
 * Windows PowerShell 5.1 writes UTF-8 with a byte-order mark, which
 * JSON.parse rejects. A hand-edited control.json should not stop the service.
 *
 * @param {string} file
 */
async function readJsonFile(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

/** @param {string} file */
async function loadConfig(file) {
  const raw = await readJsonFile(file);
  const required = ["listen", "port", "settingsFile", "secretsFile", "dataDir"];
  for (const key of required) {
    if (raw[key] === undefined) throw new Error(`${file} is missing "${key}".`);
  }
  if (!Array.isArray(raw.listen) || raw.listen.length === 0)
    throw new Error(`"listen" must list at least one address.`);
  return {
    listen: raw.listen.map(String),
    port: Number(raw.port),
    allowedHosts: Array.isArray(raw.allowedHosts)
      ? raw.allowedHosts.map(String)
      : [],
    settingsFile: String(raw.settingsFile),
    secretsFile: String(raw.secretsFile),
    dataDir: String(raw.dataDir),
    logsDir: raw.logsDir ? String(raw.logsDir) : undefined,
    healthUrl: raw.healthUrl ? String(raw.healthUrl) : undefined,
    services: Array.isArray(raw.services) ? raw.services.map(String) : [],
    restartOnApply: Array.isArray(raw.restartOnApply)
      ? raw.restartOnApply.map(String)
      : [],
    platform:
      raw.platform === "dev"
        ? "dev"
        : process.platform === "win32"
          ? "windows"
          : "dev",
    passwordHash:
      typeof raw.passwordHash === "string" ? raw.passwordHash : undefined,
  };
}

async function serve(configPath) {
  const config = await loadConfig(configPath);
  const unknown = config.restartOnApply.filter(
    (name) => !config.services.includes(name),
  );
  if (unknown.length > 0)
    throw new Error(
      `restartOnApply names services not in "services": ${unknown.join(", ")}`,
    );

  const platform =
    config.platform === "windows"
      ? windowsPlatform()
      : devPlatform(config.services);
  const store = createConfigStore({
    files: { settings: config.settingsFile, secrets: config.secretsFile },
    dataDir: config.dataDir,
    copyAcl: platform.copyAcl,
  });
  await store.cleanup();

  const handler = createApp({
    config,
    store,
    sessions: createSessions(),
    platform,
    publicDir: path.join(here, "public"),
    // Read on every login, so set-password takes effect without a restart.
    passwordHash: async () => (await loadConfig(configPath)).passwordHash,
  });

  for (const address of config.listen) listenOn(address, config.port, handler);
  console.log(
    `seyirlik-control (${platform.name}) settings=${config.settingsFile} secrets=${config.secretsFile}`,
  );
}

/**
 * Binds one address, retrying until it exists. At boot this service can start
 * before Tailscale has brought its interface up, and a service that exits on
 * that would leave the dashboard down until someone noticed.
 */
function listenOn(address, port, handler) {
  const server = createServer(handler);
  server.headersTimeout = 15_000;
  server.requestTimeout = 180_000;
  server.on("error", (error) => {
    console.error(
      `cannot listen on ${address}:${port} (${error.code ?? error.message}); retrying in ${RETRY_LISTEN_MS / 1000}s`,
    );
    server.close();
    setTimeout(() => listenOn(address, port, handler), RETRY_LISTEN_MS);
  });
  server.listen(port, address, () => {
    const host = address.includes(":") ? `[${address}]` : address;
    console.log(`listening on http://${host}:${port}`);
  });
}

async function setPassword(configPath) {
  const raw = await readJsonFile(configPath);
  const first = await prompt(
    `New password (at least ${MIN_PASSWORD_LENGTH} characters): `,
  );
  if (process.stdin.isTTY) {
    const second = await prompt("Again: ");
    if (first !== second)
      throw new Error("The two passwords differ. Nothing was changed.");
  }
  raw.passwordHash = await hashPassword(first);
  await writeAtomic(configPath, JSON.stringify(raw, null, 2) + "\n", null);
  console.log(
    "Password set. Existing dashboard sessions end at their next sign-in check.",
  );
}

/** Reads a line without echoing it when attached to a terminal. */
function prompt(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => (data += chunk));
      stdin.on("end", () => resolve(data.split(/\r?\n/)[0]));
      stdin.on("error", reject);
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (/** @type {string} */ chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "set-password") await setPassword(args.config);
  else if (args.command === "serve") await serve(args.config);
  else throw new Error(`Unknown command ${args.command}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
