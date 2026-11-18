/**
 * The dashboard's HTTP surface.
 *
 * Every request passes the same gate before any route sees it: a Tailscale or
 * loopback peer, a Host this machine answers to, and — for everything but the
 * login itself — a live session. Requests that change anything must also
 * carry the CSRF header. There is no second entry point that skips the gate.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  CSRF_HEADER,
  clearedCookie,
  isAllowedHost,
  isAllowedPeer,
  readCookie,
  sessionCookie,
  verifyPassword,
} from "./auth.mjs";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./configStore.mjs";
import { isAbsolutePath } from "./catalog.mjs";
import { inspectPaths, listLogs, readHealth, tailLog } from "./platform.mjs";

const MAX_BODY = 64 * 1024;
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{
 *   listen: string[],
 *   port: number,
 *   allowedHosts?: string[],
 *   logsDir?: string,
 *   healthUrl?: string,
 *   services: string[],
 *   restartOnApply: string[],
 * }} AppConfig
 */

/**
 * @param {{
 *   config: AppConfig,
 *   store: ReturnType<typeof import("./configStore.mjs").createConfigStore>,
 *   sessions: ReturnType<typeof import("./auth.mjs").createSessions>,
 *   platform: import("./platform.mjs").Platform,
 *   publicDir: string,
 *   passwordHash: () => Promise<string | undefined>,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createApp({
  config,
  store,
  sessions,
  platform,
  publicDir,
  passwordHash,
  log = console.log,
}) {
  let lastHash = /** @type {string | undefined} */ (undefined);

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  return async function handle(req, res) {
    const ip = req.socket.remoteAddress ?? "";
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://control.invalid");
    try {
      if (!isAllowedPeer(ip))
        throw new HttpError(403, "Only reachable over Tailscale.");
      if (!isAllowedHost(req.headers.host, config))
        throw new HttpError(421, "Unrecognised host.");

      const asset = STATIC[/** @type {keyof typeof STATIC} */ (url.pathname)];
      if (req.method === "GET" && asset) {
        const body = await fs.readFile(path.join(publicDir, asset[0]));
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": asset[1],
          "Cache-Control": "no-cache",
        });
        res.end(body);
        return;
      }
      if (!url.pathname.startsWith("/api/"))
        throw new HttpError(404, "Not found.");

      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (mutating) checkCsrf(req);
      const token = readCookie(req.headers.cookie);
      const session = sessions.check(token);

      if (url.pathname === "/api/session" && req.method === "GET") {
        return send(res, 200, {
          authenticated: Boolean(session),
          platform: platform.name,
          configured: Boolean(await passwordHash()),
        });
      }
      if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        const hash = await passwordHash();
        if (!hash)
          throw new HttpError(
            503,
            "No password is set. Run set-password on the server first.",
          );
        if (lastHash !== undefined && lastHash !== hash) sessions.clear();
        lastHash = hash;
        if (!sessions.canAttempt(ip))
          throw new HttpError(
            429,
            "Too many failed attempts. Wait 15 minutes.",
          );
        if (!(await verifyPassword(String(body.password ?? ""), hash))) {
          sessions.recordFailure(ip);
          await store.record({ action: "login-failed", actor: { ip } });
          throw new HttpError(401, "Wrong password.");
        }
        res.setHeader("Set-Cookie", sessionCookie(sessions.create(ip)));
        await store.record({ action: "login", actor: { ip } });
        return send(res, 200, { authenticated: true });
      }
      if (!session) throw new HttpError(401, "Sign in first.");
      const actor = { ip };

      if (url.pathname === "/api/logout" && req.method === "POST") {
        sessions.destroy(token);
        res.setHeader("Set-Cookie", clearedCookie());
        return send(res, 200, { authenticated: false });
      }

      if (url.pathname === "/api/overview" && req.method === "GET") {
        const snapshot = await store.snapshot();
        const storagePaths = snapshot.entries
          .filter(
            (e) =>
              e.kind === "path" &&
              e.visibility === "visible" &&
              e.value &&
              !e.overridden,
          )
          .map((e) => ({
            key: e.key,
            label: e.label,
            path: /** @type {string} */ (e.value),
          }));
        const [services, health, drives, paths] = await Promise.all([
          platform
            .services(config.services)
            .catch((error) => ({ error: message(error) })),
          config.healthUrl
            ? readHealth(config.healthUrl)
            : Promise.resolve(null),
          platform.drives().catch((error) => ({ error: message(error) })),
          inspectPaths([...new Set(storagePaths.map((p) => p.path))]),
        ]);
        const byPath = new Map(paths.map((p) => [p.path, p]));
        return send(res, 200, {
          services,
          health,
          drives,
          paths: storagePaths.map((p) => ({ ...p, ...byPath.get(p.path) })),
          missing: snapshot.missing,
          restartOnApply: config.restartOnApply,
          checkedAt: new Date().toISOString(),
        });
      }

      if (url.pathname === "/api/config" && req.method === "GET") {
        return send(res, 200, await store.snapshot());
      }
      if (url.pathname === "/api/config/plan" && req.method === "POST") {
        const body = await readJson(req);
        const id = store.fileId(String(body.file));
        return send(
          res,
          200,
          await store.plan(id, {
            set: body.set ?? {},
            unset: body.unset ?? [],
          }),
        );
      }
      if (url.pathname === "/api/config/apply" && req.method === "POST") {
        const body = await readJson(req);
        const id = store.fileId(String(body.file));
        const result = await store.apply(
          id,
          {
            set: body.set ?? {},
            unset: body.unset ?? [],
            baseVersion: String(body.baseVersion ?? ""),
          },
          actor,
        );
        const restarted =
          body.restart && result.changed ? await restartAll(actor) : [];
        return send(res, 200, { ...result, restarted });
      }

      if (url.pathname === "/api/history" && req.method === "GET") {
        const id = store.fileId(String(url.searchParams.get("file")));
        return send(res, 200, { history: await store.history(id) });
      }
      if (url.pathname === "/api/history/restore" && req.method === "POST") {
        const body = await readJson(req);
        const id = store.fileId(String(body.file));
        const result = await store.restore(
          id,
          String(body.id ?? ""),
          String(body.baseVersion ?? ""),
          actor,
        );
        const restarted = body.restart ? await restartAll(actor) : [];
        return send(res, 200, { ...result, restarted });
      }

      if (url.pathname === "/api/services/action" && req.method === "POST") {
        const body = await readJson(req);
        const name = String(body.name ?? "");
        const action = String(body.action ?? "");
        if (!config.services.includes(name))
          throw new HttpError(404, "Not a service this dashboard manages.");
        if (!["start", "stop", "restart"].includes(action))
          throw new HttpError(400, "Unknown action.");
        await store.record({
          action: `service-${action}`,
          service: name,
          actor,
        });
        await platform.serviceAction(
          name,
          /** @type {"start" | "stop" | "restart"} */ (action),
        );
        return send(res, 200, {
          services: await platform.services(config.services),
        });
      }

      if (url.pathname === "/api/logs" && req.method === "GET") {
        return send(res, 200, {
          logs: config.logsDir ? await listLogs(config.logsDir) : [],
        });
      }
      if (url.pathname === "/api/logs/tail" && req.method === "GET") {
        if (!config.logsDir)
          throw new HttpError(404, "No log folder is configured.");
        const tail = await tailLog(
          config.logsDir,
          String(url.searchParams.get("name") ?? ""),
          Number(url.searchParams.get("bytes")),
        );
        if (!tail) throw new HttpError(404, "No such log.");
        return send(res, 200, tail);
      }

      if (url.pathname === "/api/paths/check" && req.method === "POST") {
        const body = await readJson(req);
        const list = Array.isArray(body.paths)
          ? body.paths
              .filter((p) => typeof p === "string" && isAbsolutePath(p))
              .slice(0, 20)
          : [];
        return send(res, 200, { paths: await inspectPaths(list) });
      }

      if (url.pathname === "/api/activity" && req.method === "GET") {
        const entries = await store.readAudit();
        return send(res, 200, { activity: entries.slice(-100).reverse() });
      }

      throw new HttpError(404, "Not found.");
    } catch (error) {
      const [status, body] = describeError(error);
      if (status >= 500)
        log(
          `error ${req.method} ${url.pathname}: ${error instanceof Error ? error.stack : String(error)}`,
        );
      if (!res.headersSent) send(res, status, body);
    } finally {
      log(
        `${new Date().toISOString()} ${ip} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`,
      );
    }
  };

  /** @param {{ ip: string }} actor */
  async function restartAll(actor) {
    const results = [];
    for (const name of config.restartOnApply) {
      try {
        await store.record({
          action: "service-restart",
          service: name,
          actor,
          reason: "configuration changed",
        });
        await platform.serviceAction(name, "restart");
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, error: message(error) });
      }
    }
    return results;
  }

  /** @param {import("node:http").IncomingMessage} req */
  function checkCsrf(req) {
    if (req.headers[CSRF_HEADER] !== "1")
      throw new HttpError(403, "Missing request header.");
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        throw new HttpError(403, "Bad origin.");
      }
      if (host !== req.headers.host)
        throw new HttpError(403, "Cross-origin request refused.");
    }
  }
}

/** @param {import("node:http").IncomingMessage} req */
async function readJson(req) {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json"))
    throw new HttpError(415, "Send JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

/** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
function send(res, status, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** @param {unknown} error @returns {[number, Record<string, unknown>]} */
function describeError(error) {
  if (error instanceof HttpError)
    return [error.status, { error: error.message }];
  if (error instanceof ValidationError)
    return [422, { error: "The change was not saved.", errors: error.errors }];
  if (error instanceof ConflictError) return [409, { error: error.message }];
  if (error instanceof NotFoundError) return [404, { error: error.message }];
  return [500, { error: message(error) }];
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}
