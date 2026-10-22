import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OWN_API_V1_BASE_PATH,
  OwnApiError,
  sendOwnApiJson,
  type OwnApiRouteHandler,
} from "../ownApiHandler";
import {
  appendSetCookie,
  headerValue,
  methodNotAllowed,
  parseCookies,
  readJsonBody,
  remoteAddress,
  requireMutationOrigin,
  serializeCookie as serializeApiCookie,
  uniqueCookie,
} from "../api/http";
import type {
  NativeAuthService,
  NativeAuthenticatedSession,
  NativeSessionResult,
} from "./authService";
import { normalizeLoginUsername } from "./authService";
import { createCsrfToken, verifyCsrfToken } from "./csrf";
import {
  createBoundedRateLimiter,
  type BoundedRateLimiter,
} from "./rateLimiter";

const AUTH_BASE_PATH = `${OWN_API_V1_BASE_PATH}/auth`;
// The session cookie is scoped to the versioned API: every catalogue, image and
// media request is authorized by it, and nothing outside that namespace needs
// it. Being HttpOnly, it only ever has to be *sent*.
const SESSION_COOKIE_PATH = OWN_API_V1_BASE_PATH;

// The CSRF cookie is different. It is a double-submit token the browser must be
// able to *read* in order to echo it back in a header, and `document.cookie`
// only exposes cookies whose path matches the current page. Scoping it to the
// API namespace made it invisible to every page in the app, so no mutation
// could ever be verified.
const CSRF_COOKIE_PATH = "/";
const MAX_JSON_BODY_BYTES = 16 * 1_024;

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    expires: Date;
    maxAgeSeconds: number;
    path: string;
    domain?: string;
  },
): string {
  return serializeApiCookie(name, value, options);
}
const MAX_USERNAME_INPUT_LENGTH = 128;
const MAX_PASSWORD_INPUT_BYTES = 256;
const MAX_DEVICE_DESCRIPTION_LENGTH = 200;

export interface NativeAuthHttpHandlerOptions {
  auth: NativeAuthService;
  csrfSecret: string;
  secureCookies: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  cookieDomain?: string;
  publicOrigin?: string;
  trustedOrigins?: ReadonlySet<string>;
  loginLimiter?: BoundedRateLimiter;
  refreshLimiter?: BoundedRateLimiter;
  now?: () => Date;
}

interface LoginBody {
  username: string;
  password: string;
  deviceDescription?: string;
}

/**
 * The cookie Domain to use for this particular request, if any.
 *
 * A Domain attribute the request host does not belong to makes the browser
 * discard the cookie outright — so a deployment configured to share cookies
 * across `seyirlik.org` subdomains would silently issue no session at all when
 * reached as `localhost` or by LAN address, which is exactly how the dev server
 * is used. Login would answer 200 and the next request would be anonymous.
 *
 * Omitting the attribute is the correct fallback: the cookie is then scoped to
 * the exact host that set it, which is all a single-host origin needs.
 */
export function applicableCookieDomain(
  request: IncomingMessage,
  cookieDomain: string | undefined,
): string | undefined {
  if (!cookieDomain) return undefined;

  const host = request.headers.host?.split(":")[0]?.toLowerCase();
  if (!host) return undefined;

  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  return host === domain || host.endsWith(`.${domain}`)
    ? cookieDomain
    : undefined;
}

function setSessionCookies(
  request: IncomingMessage,
  response: ServerResponse,
  session: NativeSessionResult,
  authenticated: NativeAuthenticatedSession,
  options: NativeAuthHttpHandlerOptions,
): void {
  const csrfToken = createCsrfToken(
    authenticated.tokenHash,
    options.csrfSecret,
  );
  const maxAgeSeconds = Math.max(
    0,
    (session.expiresAt.getTime() - (options.now?.() ?? new Date()).getTime()) /
      1_000,
  );
  const cookieDomain = applicableCookieDomain(request, options.cookieDomain);
  appendSetCookie(response, [
    serializeCookie(options.sessionCookieName, session.token, {
      httpOnly: true,
      secure: options.secureCookies,
      expires: session.expiresAt,
      maxAgeSeconds,
      path: SESSION_COOKIE_PATH,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    }),
    serializeCookie(options.csrfCookieName, csrfToken, {
      httpOnly: false,
      secure: options.secureCookies,
      expires: session.expiresAt,
      maxAgeSeconds,
      path: CSRF_COOKIE_PATH,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    }),
    // A CSRF cookie written at the API path by an earlier build is a distinct
    // cookie from the one above, and the browser would send both. Duplicate
    // names are treated as absent, so the stale one has to be expired or every
    // mutation keeps failing after the upgrade.
    serializeCookie(options.csrfCookieName, "", {
      httpOnly: false,
      secure: options.secureCookies,
      expires: new Date(0),
      maxAgeSeconds: 0,
      path: SESSION_COOKIE_PATH,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    }),
  ]);
}

function clearSessionCookies(
  request: IncomingMessage,
  response: ServerResponse,
  options: NativeAuthHttpHandlerOptions,
): void {
  const expired = new Date(0);
  const cookieDomain = applicableCookieDomain(request, options.cookieDomain);
  appendSetCookie(response, [
    serializeCookie(options.sessionCookieName, "", {
      httpOnly: true,
      secure: options.secureCookies,
      expires: expired,
      maxAgeSeconds: 0,
      path: SESSION_COOKIE_PATH,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    }),
    serializeCookie(options.csrfCookieName, "", {
      httpOnly: false,
      secure: options.secureCookies,
      expires: expired,
      maxAgeSeconds: 0,
      path: CSRF_COOKIE_PATH,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    }),
  ]);
}

function parseLoginBody(value: unknown): LoginBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "The login request is invalid.",
      422,
    );
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["username", "password", "deviceDescription"]);
  const hasUnknownKey = Object.keys(candidate).some(
    (key) => !allowedKeys.has(key),
  );
  if (
    hasUnknownKey ||
    typeof candidate.username !== "string" ||
    candidate.username.length < 1 ||
    candidate.username.length > MAX_USERNAME_INPUT_LENGTH ||
    // An empty password signs in to a passwordless account.
    typeof candidate.password !== "string" ||
    Buffer.byteLength(candidate.password, "utf8") > MAX_PASSWORD_INPUT_BYTES ||
    (candidate.deviceDescription !== undefined &&
      (typeof candidate.deviceDescription !== "string" ||
        candidate.deviceDescription.length > MAX_DEVICE_DESCRIPTION_LENGTH))
  ) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "The login request is invalid.",
      422,
    );
  }
  return {
    username: candidate.username,
    password: candidate.password,
    ...(typeof candidate.deviceDescription === "string"
      ? { deviceDescription: candidate.deviceDescription }
      : {}),
  };
}

function mapAuthError(error: unknown): OwnApiError {
  if (error instanceof OwnApiError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "statusCode" in error &&
    typeof error.code === "string" &&
    typeof error.statusCode === "number" &&
    ["INVALID_CREDENTIALS", "AUTH_REQUIRED", "SESSION_TOKEN_REUSED"].includes(
      error.code,
    )
  ) {
    const message =
      error.code === "INVALID_CREDENTIALS"
        ? "The username or password is invalid."
        : error.code === "SESSION_TOKEN_REUSED"
          ? "The session can no longer be refreshed."
          : "Authentication is required.";
    return new OwnApiError(error.code, message, error.statusCode);
  }
  throw error;
}

async function currentSession(
  auth: NativeAuthService,
  token: string | undefined,
): Promise<NativeAuthenticatedSession> {
  if (!token)
    throw new OwnApiError("AUTH_REQUIRED", "Authentication is required.", 401);
  try {
    return await auth.getCurrentSession(token);
  } catch (error) {
    throw mapAuthError(error);
  }
}

function requireCsrf(
  request: IncomingMessage,
  cookies: Map<string, string[]>,
  session: NativeAuthenticatedSession,
  options: NativeAuthHttpHandlerOptions,
): void {
  if (
    !verifyCsrfToken({
      cookieToken: uniqueCookie(cookies, options.csrfCookieName),
      headerToken: headerValue(request.headers["x-csrf-token"]),
      sessionTokenHash: session.tokenHash,
      secret: options.csrfSecret,
    })
  ) {
    throw new OwnApiError(
      "CSRF_REJECTED",
      "The request could not be verified.",
      403,
    );
  }
}

function sendUser(
  response: ServerResponse,
  requestId: string,
  user: NativeAuthenticatedSession["user"],
): void {
  sendOwnApiJson(response, 200, { data: { user }, requestId });
}

export function createNativeAuthHttpHandler(
  options: NativeAuthHttpHandlerOptions,
): OwnApiRouteHandler {
  const loginLimiter =
    options.loginLimiter ??
    createBoundedRateLimiter({
      maxAttempts: 5,
      windowMs: 5 * 60_000,
      maxEntries: 10_000,
    });
  const refreshLimiter =
    options.refreshLimiter ??
    createBoundedRateLimiter({
      maxAttempts: 30,
      windowMs: 60_000,
      maxEntries: 10_000,
    });

  return async (request, response, { requestId, url }) => {
    if (!url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
    const cookies = parseCookies(request);
    const sessionToken = uniqueCookie(cookies, options.sessionCookieName);

    if (url.pathname === `${AUTH_BASE_PATH}/login`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(
        request,
        options.publicOrigin,
        options.trustedOrigins,
      );
      const body = parseLoginBody(
        await readJsonBody(request, MAX_JSON_BODY_BYTES),
      );
      const limiterKey = `${remoteAddress(request)}|${normalizeLoginUsername(body.username).slice(0, 64)}`;
      const decision = loginLimiter.consume(limiterKey);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfterSeconds));
        throw new OwnApiError(
          "AUTH_RATE_LIMITED",
          "Too many authentication attempts.",
          429,
        );
      }

      let session: NativeSessionResult;
      try {
        session = await options.auth.login(body);
      } catch (error) {
        throw mapAuthError(error);
      }
      loginLimiter.reset(limiterKey);

      try {
        const authenticated = await options.auth.getCurrentSession(
          session.token,
        );
        setSessionCookies(request, response, session, authenticated, options);
      } catch (error) {
        await options.auth.logout(session.token).catch(() => undefined);
        throw mapAuthError(error);
      }
      sendOwnApiJson(response, 200, {
        data: { user: session.user },
        requestId,
      });
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/me`) {
      if (request.method !== "GET") methodNotAllowed(response, "GET, OPTIONS");
      const session = await currentSession(options.auth, sessionToken);
      sendUser(response, requestId, session.user);
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/csrf`) {
      if (request.method !== "GET") methodNotAllowed(response, "GET, OPTIONS");
      const session = await currentSession(options.auth, sessionToken);
      const csrfToken = createCsrfToken(session.tokenHash, options.csrfSecret);
      const maxAgeSeconds = Math.max(
        0,
        (session.expiresAt.getTime() -
          (options.now?.() ?? new Date()).getTime()) /
          1_000,
      );
      const cookieDomain = applicableCookieDomain(
        request,
        options.cookieDomain,
      );
      appendSetCookie(response, [
        serializeCookie(options.csrfCookieName, csrfToken, {
          httpOnly: false,
          secure: options.secureCookies,
          expires: session.expiresAt,
          maxAgeSeconds,
          path: CSRF_COOKIE_PATH,
          ...(cookieDomain ? { domain: cookieDomain } : {}),
        }),
      ]);
      sendOwnApiJson(response, 200, {
        data: { csrfToken },
        requestId,
      });
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/refresh`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(
        request,
        options.publicOrigin,
        options.trustedOrigins,
      );
      const limiterKey = `${remoteAddress(request)}|refresh`;
      const decision = refreshLimiter.consume(limiterKey);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfterSeconds));
        throw new OwnApiError(
          "AUTH_RATE_LIMITED",
          "Too many session refresh attempts.",
          429,
        );
      }
      const current = await currentSession(options.auth, sessionToken);
      requireCsrf(request, cookies, current, options);

      try {
        const refreshed = await options.auth.refresh(current.token);
        const authenticated = await options.auth.getCurrentSession(
          refreshed.token,
        );
        refreshLimiter.reset(limiterKey);
        setSessionCookies(request, response, refreshed, authenticated, options);
        sendUser(response, requestId, refreshed.user);
      } catch (error) {
        clearSessionCookies(request, response, options);
        throw mapAuthError(error);
      }
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/logout`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(
        request,
        options.publicOrigin,
        options.trustedOrigins,
      );
      if (sessionToken) {
        try {
          const current = await currentSession(options.auth, sessionToken);
          requireCsrf(request, cookies, current, options);
          await options.auth.logout(sessionToken);
        } catch (error) {
          const mapped = mapAuthError(error);
          if (mapped.code !== "AUTH_REQUIRED") throw mapped;
        }
      }
      clearSessionCookies(request, response, options);
      response.statusCode = 204;
      response.end();
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/logout-all`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(
        request,
        options.publicOrigin,
        options.trustedOrigins,
      );
      const current = await currentSession(options.auth, sessionToken);
      requireCsrf(request, cookies, current, options);
      try {
        await options.auth.logoutAll(current.token);
      } catch (error) {
        throw mapAuthError(error);
      }
      clearSessionCookies(request, response, options);
      response.statusCode = 204;
      response.end();
      return true;
    }

    return false;
  };
}
