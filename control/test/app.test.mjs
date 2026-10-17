// @vitest-environment node
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../lib/app.mjs";
import {
  createSessions,
  hashPassword,
  isAllowedHost,
  isAllowedPeer,
} from "../lib/auth.mjs";
import { createConfigStore } from "../lib/configStore.mjs";
import { devPlatform } from "../lib/platform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = "correct horse battery";
const TMDB = "tmdb-key-0123456789abcdef";
let dir;
let server;
let base;
let hash;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "seyirlik-control-app-"));
  await fs.mkdir(path.join(dir, "logs"));
  await fs.writeFile(
    path.join(dir, "settings.env"),
    `SEYIRLIK_MEDIA_ROOT=${path.join(dir, "media")}\n`,
  );
  await fs.writeFile(
    path.join(dir, "secrets.env"),
    `SEYIRLIK_TMDB_API_KEY=${TMDB}\n`,
  );
  await fs.writeFile(path.join(dir, "logs", "server.log"), "line 1\nline 2\n");
  await fs.writeFile(path.join(dir, "outside.log"), "should not be readable");
  hash ??= await hashPassword(PASSWORD);
  const config = {
    listen: ["127.0.0.1"],
    port: 0,
    services: ["SeyirlikServer", "SeyirlikWorker"],
    restartOnApply: ["SeyirlikServer"],
    logsDir: path.join(dir, "logs"),
  };
  const app = createApp({
    config,
    store: createConfigStore({
      files: {
        settings: path.join(dir, "settings.env"),
        secrets: path.join(dir, "secrets.env"),
      },
      dataDir: path.join(dir, "control"),
    }),
    sessions: createSessions(),
    platform: devPlatform(config.services),
    publicDir: path.join(here, "..", "public"),
    passwordHash: async () => hash,
    log: () => {},
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

function call(
  pathname,
  { method = "GET", body, cookie, csrf = true, headers = {} } = {},
) {
  return fetch(base + pathname, {
    method,
    headers: {
      ...(csrf && method !== "GET" ? { "x-seyirlik-control": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function login() {
  const response = await call("/api/login", {
    method: "POST",
    body: { password: PASSWORD },
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie").split(";")[0];
}

describe("the gate", () => {
  it("refuses every API call without a session", async () => {
    for (const p of [
      "/api/config",
      "/api/overview",
      "/api/logs",
      "/api/activity",
      "/api/history?file=secrets",
    ]) {
      expect((await call(p)).status, p).toBe(401);
    }
  });

  it("refuses a wrong password, then throttles", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await call("/api/login", {
            method: "POST",
            body: { password: "nope" },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await call("/api/login", {
          method: "POST",
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(429);
  });

  it("refuses state changes without the CSRF header or from another origin", async () => {
    const cookie = await login();
    expect(
      (await call("/api/logout", { method: "POST", cookie, csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (
        await call("/api/login", {
          method: "POST",
          body: { password: PASSWORD },
          csrf: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/api/logout", {
          method: "POST",
          cookie,
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("refuses a Host it does not answer to (DNS rebinding)", async () => {
    // fetch will not let us forge Host, so the check itself is exercised.
    const config = { listen: ["100.100.12.34"] };
    expect(isAllowedHost("evil.example", config)).toBe(false);
    expect(isAllowedHost("100.100.12.34:43200", config)).toBe(true);
    expect(
      isAllowedHost(
        `${os.hostname().toLowerCase()}.tail1234.ts.net:43200`,
        config,
      ),
    ).toBe(true);
    expect(
      isAllowedHost(`${os.hostname().toLowerCase()}.evil.example`, config),
    ).toBe(false);
  });

  it("only admits Tailscale and loopback peers", () => {
    for (const ip of [
      "127.0.0.1",
      "::1",
      "100.101.2.3",
      "::ffff:100.64.0.1",
      "fd7a:115c:a1e0::1",
    ])
      expect(isAllowedPeer(ip), ip).toBe(true);
    for (const ip of [
      "192.168.1.10",
      "100.128.0.1",
      "8.8.8.8",
      "::ffff:10.0.0.1",
      "",
      undefined,
    ])
      expect(isAllowedPeer(ip), String(ip)).toBe(false);
  });

  it("sends the session as an HttpOnly, SameSite=Strict cookie", async () => {
    const response = await call("/api/login", {
      method: "POST",
      body: { password: PASSWORD },
    });
    expect(response.headers.get("set-cookie")).toMatch(
      /HttpOnly; SameSite=Strict/,
    );
  });
});

describe("configuration over HTTP", () => {
  it("never returns a secret, in any response", async () => {
    const cookie = await login();
    const responses = await Promise.all(
      [
        "/api/config",
        "/api/overview",
        "/api/activity",
        "/api/history?file=secrets",
      ].map((p) => call(p, { cookie }).then((r) => r.text())),
    );
    for (const text of responses) expect(text).not.toContain(TMDB);
  });

  it("saves a change and restarts the configured services", async () => {
    const cookie = await login();
    const config = await (await call("/api/config", { cookie })).json();
    const response = await call("/api/config/apply", {
      method: "POST",
      cookie,
      body: {
        file: "settings",
        baseVersion: config.files.settings.version,
        set: { SEYIRLIK_PORT: "43111" },
        restart: true,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      changed: true,
      restarted: [{ name: "SeyirlikServer", ok: true }],
    });
    expect(await fs.readFile(path.join(dir, "settings.env"), "utf8")).toContain(
      "SEYIRLIK_PORT=43111",
    );
  });

  it("answers a stale version with 409 and an invalid value with 422", async () => {
    const cookie = await login();
    const stale = await call("/api/config/apply", {
      method: "POST",
      cookie,
      body: {
        file: "settings",
        baseVersion: "old",
        set: { SEYIRLIK_PORT: "1" },
      },
    });
    expect(stale.status).toBe(409);
    const config = await (await call("/api/config", { cookie })).json();
    const bad = await call("/api/config/apply", {
      method: "POST",
      cookie,
      body: {
        file: "settings",
        baseVersion: config.files.settings.version,
        set: { SEYIRLIK_PORT: "x" },
      },
    });
    expect(bad.status).toBe(422);
  });

  it("only acts on services it manages", async () => {
    const cookie = await login();
    expect(
      (
        await call("/api/services/action", {
          method: "POST",
          cookie,
          body: { name: "WinDefend", action: "stop" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/api/services/action", {
          method: "POST",
          cookie,
          body: { name: "SeyirlikWorker", action: "restart" },
        })
      ).status,
    ).toBe(200);
  });

  it("reads logs only from the log folder", async () => {
    const cookie = await login();
    const ok = await call("/api/logs/tail?name=server.log", { cookie });
    expect((await ok.json()).text).toContain("line 2");
    for (const name of [
      "../outside.log",
      "..\\outside.log",
      "/etc/passwd",
      "outside.log",
    ]) {
      expect(
        (
          await call(`/api/logs/tail?name=${encodeURIComponent(name)}`, {
            cookie,
          })
        ).status,
        name,
      ).toBe(404);
    }
  });

  it("serves the page with a strict content security policy", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
