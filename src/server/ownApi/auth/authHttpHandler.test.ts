// @vitest-environment node
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOwnApiRequestHandler,
  createStaticHealthService,
} from "../ownApiHandler";
import type {
  NativeAuthService,
  NativeAuthenticatedSession,
  NativeSessionResult,
} from "./authService";
import { createCsrfToken } from "./csrf";
import { createNativeAuthHttpHandler } from "./authHttpHandler";
import { createBoundedRateLimiter } from "./rateLimiter";

const servers: Server[] = [];
const sessionTokenA = "a".repeat(43);
const sessionTokenB = "b".repeat(43);
const expiresAt = new Date("2030-01-01T00:00:00.000Z");
const csrfSecret = "test-csrf-secret-at-least-thirty-two-bytes";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "person",
  displayName: "Person",
  isAdministrator: true,
};

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function authenticated(token: string): NativeAuthenticatedSession {
  return {
    sessionId: token === sessionTokenA ? "session-a" : "session-b",
    familyId: "family-1",
    token,
    tokenHash: tokenHash(token),
    expiresAt,
    user,
  };
}

function result(token: string): NativeSessionResult {
  return { token, sessionId: authenticated(token).sessionId, expiresAt, user };
}

function fakeAuth(): NativeAuthService {
  return {
    login: vi.fn(async ({ username, password }) => {
      if (username !== "person" || password !== "correct password") {
        const error = new Error(
          "The username or password is invalid.",
        ) as Error & {
          code: string;
          statusCode: number;
        };
        error.code = "INVALID_CREDENTIALS";
        error.statusCode = 401;
        throw error;
      }
      return result(sessionTokenA);
    }),
    getCurrentSession: vi.fn(async (token) => {
      if (token !== sessionTokenA && token !== sessionTokenB) {
        const error = new Error("Authentication is required.") as Error & {
          code: string;
          statusCode: number;
        };
        error.code = "AUTH_REQUIRED";
        error.statusCode = 401;
        throw error;
      }
      return authenticated(token);
    }),
    refresh: vi.fn(async () => result(sessionTokenB)),
    logout: vi.fn(async () => undefined),
    logoutAll: vi.fn(async () => undefined),
    cleanupExpiredSessions: vi.fn(async () => 0),
  };
}

function healthService() {
  return createStaticHealthService({
    database: "available",
    jobs: "disabled",
    ffmpeg: "available",
    ffprobe: "available",
    mediaStorage: "available",
    generatedStorage: "writable",
  });
}

async function startAuthServer(
  options: {
    auth?: NativeAuthService;
    secureCookies?: boolean;
    loginLimiter?: ReturnType<typeof createBoundedRateLimiter>;
    refreshLimiter?: ReturnType<typeof createBoundedRateLimiter>;
  } = {},
): Promise<{ baseUrl: string; auth: NativeAuthService }> {
  const auth = options.auth ?? fakeAuth();
  const authHandler = createNativeAuthHttpHandler({
    auth,
    csrfSecret,
    secureCookies: options.secureCookies ?? true,
    sessionCookieName:
      options.secureCookies === false
        ? "seyirlik_session"
        : "__Secure-seyirlik_session",
    csrfCookieName:
      options.secureCookies === false
        ? "seyirlik_csrf"
        : "__Secure-seyirlik_csrf",
    loginLimiter: options.loginLimiter,
    refreshLimiter: options.refreshLimiter,
    now: () => new Date("2029-12-01T00:00:00.000Z"),
  });
  const handler = createOwnApiRequestHandler({
    healthService: healthService(),
    routeHandlers: [authHandler],
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, auth };
}

function setCookies(response: Response): string[] {
  return (
    (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? []
  );
}

/**
 * Models what a browser would send back. An expired cookie is a deletion, not a
 * value to replay — the server emits one to clear a CSRF cookie left at the old
 * path by an earlier build.
 */
function cookieHeader(cookies: string[]): string {
  return cookies
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

function cookieValue(cookies: string[], name: string): string {
  const prefix = `${name}=`;
  const pair = cookies
    .map((cookie) => cookie.split(";", 1)[0] ?? "")
    .find((cookie) => cookie.startsWith(prefix) && cookie !== prefix);
  return pair?.slice(prefix.length) ?? "";
}

afterEach(async () => {
  const current = servers.splice(0);
  await Promise.all(
    current.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe("native authentication HTTP endpoints", () => {
  it("logs in, returns a minimal user, and sets production-safe cookies", async () => {
    const { baseUrl } = await startAuthServer();
    const response = await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        "X-Request-Id": "login-request",
      },
      body: JSON.stringify({
        username: "person",
        password: "correct password",
        deviceDescription: "Browser",
      }),
    });
    const payload = await response.json();
    const cookies = setCookies(response);
    const sessionCookie = cookies.find((cookie) =>
      cookie.startsWith("__Secure-seyirlik_session="),
    );
    const csrfCookie = cookies.find((cookie) =>
      cookie.startsWith("__Secure-seyirlik_csrf="),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("login-request");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({ data: { user }, requestId: "login-request" });
    expect(JSON.stringify(payload)).not.toContain("password");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/ownAPI/v1;");
    // The CSRF cookie must be readable by script from any page in the app, so
    // it is scoped to the site root rather than to the API namespace.
    expect(csrfCookie).toContain("Path=/;");
    // Host-only unless a deployment splits app and API across hosts.
    expect(sessionCookie).not.toContain("Domain=");
    expect(sessionCookie).toContain("Expires=");
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie).not.toContain("HttpOnly");
  });

  it("uses explicitly non-Secure cookies only in development mode", async () => {
    const { baseUrl } = await startAuthServer({ secureCookies: false });
    const response = await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        username: "person",
        password: "correct password",
      }),
    });
    const cookies = setCookies(response);

    expect(
      cookies.some((cookie) => cookie.startsWith("seyirlik_session=")),
    ).toBe(true);
    expect(cookies.join("\n")).not.toContain("; Secure");
  });

  it("serves me, rotates refresh, and logs out with correlated 204", async () => {
    const auth = fakeAuth();
    const { baseUrl } = await startAuthServer({ auth, secureCookies: false });
    const login = await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({
        username: "person",
        password: "correct password",
      }),
    });
    const loginCookies = setCookies(login);
    const loginCookieHeader = cookieHeader(loginCookies);
    const csrfToken = cookieValue(loginCookies, "seyirlik_csrf");

    const me = await fetch(`${baseUrl}/ownAPI/v1/auth/me`, {
      headers: { Cookie: loginCookieHeader, "X-Request-Id": "me-request" },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      data: { user },
      requestId: "me-request",
    });

    const refresh = await fetch(`${baseUrl}/ownAPI/v1/auth/refresh`, {
      method: "POST",
      headers: {
        Cookie: loginCookieHeader,
        Origin: baseUrl,
        "X-CSRF-Token": csrfToken,
      },
    });
    expect(refresh.status).toBe(200);
    expect(cookieValue(setCookies(refresh), "seyirlik_session")).toBe(
      sessionTokenB,
    );

    const logout = await fetch(`${baseUrl}/ownAPI/v1/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: loginCookieHeader,
        Origin: baseUrl,
        "X-CSRF-Token": csrfToken,
        "X-Request-Id": "logout-request",
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("x-request-id")).toBe("logout-request");
    expect(setCookies(logout).join("\n")).toContain("Max-Age=0");
    expect(auth.logout).toHaveBeenCalledWith(sessionTokenA);
  });

  it("rejects missing, invalid, and cross-session CSRF tokens", async () => {
    const { baseUrl } = await startAuthServer({ secureCookies: false });
    const validCsrf = createCsrfToken(tokenHash(sessionTokenA), csrfSecret);
    const otherCsrf = createCsrfToken(tokenHash(sessionTokenB), csrfSecret);
    const sessionCookie = `seyirlik_session=${sessionTokenA}`;

    const rejectedHeaders: Array<Record<string, string>> = [
      { Cookie: sessionCookie, Origin: baseUrl },
      {
        Cookie: `${sessionCookie}; seyirlik_csrf=${validCsrf}`,
        Origin: baseUrl,
        "X-CSRF-Token": "invalid",
      },
      {
        Cookie: `${sessionCookie}; seyirlik_csrf=${otherCsrf}`,
        Origin: baseUrl,
        "X-CSRF-Token": otherCsrf,
      },
    ];

    for (const headers of rejectedHeaders) {
      const response = await fetch(`${baseUrl}/ownAPI/v1/auth/refresh`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "CSRF_REJECTED" },
      });
    }
  });

  it("rejects unsupported content types, malformed JSON, and oversized bodies", async () => {
    const { baseUrl } = await startAuthServer();
    const request = (contentType: string, body: string) =>
      fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": contentType, Origin: baseUrl },
        body,
      });

    expect((await request("text/plain", "not json")).status).toBe(415);
    expect((await request("application/json", "{not-json")).status).toBe(400);
    expect(
      (
        await request(
          "application/json",
          JSON.stringify({ value: "x".repeat(20_000) }),
        )
      ).status,
    ).toBe(413);
  });

  it("hands an empty password to the service, for a passwordless account", async () => {
    const auth = fakeAuth();
    const { baseUrl } = await startAuthServer({ auth });
    const response = await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ username: "person", password: "" }),
    });

    // The fake only knows "correct password", so this is the service's
    // refusal, not the request validator's.
    expect(response.status).toBe(401);
    expect(auth.login).toHaveBeenCalledWith(
      expect.objectContaining({ username: "person", password: "" }),
    );
  });

  it("does not trust forwarded headers for origin or rate-limit identity", async () => {
    const limiter = createBoundedRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      maxEntries: 20,
    });
    const { baseUrl } = await startAuthServer({ loginLimiter: limiter });
    const crossOrigin = await fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
        "X-Forwarded-Host": new URL(baseUrl).host,
        "X-Forwarded-Proto": "http",
      },
      body: JSON.stringify({ username: "person", password: "wrong" }),
    });
    expect(crossOrigin.status).toBe(403);

    const attempt = (spoofedAddress: string) =>
      fetch(`${baseUrl}/ownAPI/v1/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: baseUrl,
          "X-Forwarded-For": spoofedAddress,
        },
        body: JSON.stringify({ username: "person", password: "wrong" }),
      });
    expect((await attempt("198.51.100.1")).status).toBe(401);
    const throttled = await attempt("198.51.100.2");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
  });

  it("limits invalid refresh traffic before repeated database session lookups", async () => {
    const { baseUrl } = await startAuthServer({
      refreshLimiter: createBoundedRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        maxEntries: 10,
      }),
    });
    const invalidSession = "z".repeat(43);
    const attempt = (spoofedAddress: string) =>
      fetch(`${baseUrl}/ownAPI/v1/auth/refresh`, {
        method: "POST",
        headers: {
          Cookie: `seyirlik_session=${invalidSession}`,
          Origin: baseUrl,
          "X-Forwarded-For": spoofedAddress,
        },
      });

    expect((await attempt("198.51.100.1")).status).toBe(401);
    expect((await attempt("203.0.113.2")).status).toBe(429);
  });
});
