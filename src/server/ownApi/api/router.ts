import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OWN_API_V1_BASE_PATH,
  OwnApiError,
  type OwnApiRouteHandler,
} from "../ownApiHandler";
import { verifyCsrfToken } from "../auth/csrf";
import {
  parseCookies,
  requireMutationOrigin,
  uniqueCookie,
  readJsonBody,
} from "./http";

/**
 * `narrator` routes are for the narrator (the computer that reads books
 * aloud), never a person: they take a narrator key as a bearer token and
 * nothing else, no session cookie. A browser never sends that header on its
 * own, so a page elsewhere cannot make one of these requests with a key it
 * does not have, and they need neither an origin nor a CSRF token.
 */
export type RouteAccess = "public" | "authenticated" | "admin" | "narrator";

/** The narrator a `narrator` route's key belongs to. */
export interface RouteNarrator {
  keyId: string;
  label: string;
}

export interface RoutePrincipal {
  userId: string;
  username: string;
  displayName: string;
  isAdministrator: boolean;
  sessionId: string;
  /** Present only for cookie-authenticated requests; used to bind CSRF tokens. */
  sessionTokenHash: Buffer;
}

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  url: URL;
  params: Readonly<Record<string, string>>;
  method: string;
  /** Null on `public` and `narrator` routes. */
  principal: RoutePrincipal | null;
  /** Set on `narrator` routes only. */
  narrator?: RouteNarrator | null;
  /** Throws `AUTH_REQUIRED` instead of returning null. */
  requirePrincipal(): RoutePrincipal;
  readJson(maxBytes?: number): Promise<unknown>;
}

export interface RouteDefinition {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `/items/:itemId/images/:imageType` — parameters are single path segments. */
  path: string;
  access: RouteAccess;
  /**
   * Set for routes whose body is a media stream rather than JSON, or that are
   * reached by an element (`<img>`, `<video>`) that cannot send a CSRF header.
   * Only safe methods may opt out.
   */
  skipCsrf?: boolean;
  handle(context: RouteContext): Promise<void>;
}

export type RouteSessionResolver = (
  request: IncomingMessage,
) => Promise<RoutePrincipal | null>;

export interface CreateRouterOptions {
  routes: RouteDefinition[];
  resolveSession: RouteSessionResolver;
  /** The narrator a request's bearer key names; without one no narrator route answers. */
  resolveNarrator?: (request: IncomingMessage) => Promise<RouteNarrator | null>;
  csrfSecret: string;
  csrfCookieName: string;
  publicOrigin?: string;
  /** Origins explicitly configured as allowed, trusted for mutations too. */
  trustedOrigins?: ReadonlySet<string>;
}

interface CompiledRoute extends RouteDefinition {
  segments: string[];
  paramNames: string[];
  template: string;
  /**
   * Literal segments outrank parameters, left to right. `/sessions/:id/file`
   * must win over `/sessions/:id/:segment`, otherwise registration order would
   * silently decide which handler serves a request.
   */
  specificity: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function compile(route: RouteDefinition): CompiledRoute {
  const template = `${OWN_API_V1_BASE_PATH}${route.path}`;
  const segments = route.path
    .split("/")
    .filter((segment) => segment.length > 0);
  const paramNames = segments
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));

  if (new Set(paramNames).size !== paramNames.length) {
    throw new Error(`Route ${route.path} declares duplicate parameters.`);
  }
  if (!route.skipCsrf && SAFE_METHODS.has(route.method)) {
    // Safe methods never require CSRF; flagging them would be misleading.
  }
  if (route.skipCsrf && !SAFE_METHODS.has(route.method)) {
    throw new Error(`Route ${route.path} cannot skip CSRF on ${route.method}.`);
  }

  const specificity = segments
    .map((segment) => (segment.startsWith(":") ? "0" : "1"))
    .join("");

  return { ...route, segments, paramNames, template, specificity };
}

function matchSegments(
  route: CompiledRoute,
  pathSegments: string[],
): Record<string, string> | null {
  if (route.segments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const routeSegment = route.segments[index] as string;
    const pathSegment = pathSegments[index] as string;

    if (routeSegment.startsWith(":")) {
      if (pathSegment.length === 0) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathSegment);
      } catch {
        return null;
      }
      if (decoded.includes("\0") || decoded.includes("/")) return null;
      params[routeSegment.slice(1)] = decoded;
      continue;
    }

    if (routeSegment !== pathSegment) return null;
  }

  return params;
}

export interface OwnApiRouter {
  handler: OwnApiRouteHandler;
  /**
   * Resolves a request path to its fixed route template so structured logs never
   * contain caller-controlled identifiers.
   */
  resolveTemplate(pathname: string): string | undefined;
}

export function createOwnApiRouter({
  routes,
  resolveSession,
  resolveNarrator,
  csrfSecret,
  csrfCookieName,
  publicOrigin,
  trustedOrigins,
}: CreateRouterOptions): OwnApiRouter {
  const compiled = routes
    .map(compile)
    .sort((left, right) => right.specificity.localeCompare(left.specificity));

  function findMatches(pathname: string): {
    matched: Array<{ route: CompiledRoute; params: Record<string, string> }>;
  } {
    if (!pathname.startsWith(`${OWN_API_V1_BASE_PATH}/`)) {
      return { matched: [] };
    }
    const relative = pathname.slice(OWN_API_V1_BASE_PATH.length);
    const pathSegments = relative.split("/").filter((s) => s.length > 0);

    const matched: Array<{
      route: CompiledRoute;
      params: Record<string, string>;
    }> = [];
    for (const route of compiled) {
      const params = matchSegments(route, pathSegments);
      if (params) matched.push({ route, params });
    }
    return { matched };
  }

  const handler: OwnApiRouteHandler = async (
    request,
    response,
    { requestId, url },
  ) => {
    const { matched } = findMatches(url.pathname);
    if (matched.length === 0) return false;

    const method = (request.method ?? "GET").toUpperCase();
    // HEAD falls back to the GET route so range/metadata handling is shared.
    const effectiveMethod = method === "HEAD" ? "HEAD" : method;
    const exact =
      matched.find((entry) => entry.route.method === effectiveMethod) ??
      (method === "HEAD"
        ? matched.find((entry) => entry.route.method === "GET")
        : undefined);

    if (!exact) {
      const allowed = new Set<string>(
        matched.map((entry) => entry.route.method),
      );
      if (allowed.has("GET")) allowed.add("HEAD");
      allowed.add("OPTIONS");
      response.setHeader("Allow", [...allowed].sort().join(", "));
      throw new OwnApiError(
        "METHOD_NOT_ALLOWED",
        "HTTP method is not allowed for this route.",
        405,
      );
    }

    const { route, params } = exact;
    let principal: RoutePrincipal | null = null;
    let narrator: RouteNarrator | null = null;

    if (route.access === "narrator") {
      narrator = resolveNarrator ? await resolveNarrator(request) : null;
      if (!narrator) {
        throw new OwnApiError(
          "NARRATOR_KEY_REQUIRED",
          "A narrator key is required.",
          401,
        );
      }
    } else if (route.access !== "public") {
      principal = await resolveSession(request);
      if (!principal) {
        throw new OwnApiError(
          "AUTH_REQUIRED",
          "Authentication is required.",
          401,
        );
      }
      if (route.access === "admin" && !principal.isAdministrator) {
        throw new OwnApiError(
          "FORBIDDEN",
          "Administrator permission is required.",
          403,
        );
      }
    }

    if (!SAFE_METHODS.has(method) && route.access !== "narrator") {
      requireMutationOrigin(request, publicOrigin, trustedOrigins);

      if (principal) {
        const cookies = parseCookies(request);
        const headerToken = request.headers["x-csrf-token"];
        if (
          !verifyCsrfToken({
            cookieToken: uniqueCookie(cookies, csrfCookieName),
            headerToken:
              typeof headerToken === "string" ? headerToken : undefined,
            sessionTokenHash: principal.sessionTokenHash,
            secret: csrfSecret,
          })
        ) {
          throw new OwnApiError(
            "CSRF_REJECTED",
            "The request could not be verified.",
            403,
          );
        }
      }
    }

    await route.handle({
      request,
      response,
      requestId,
      url,
      params,
      method,
      principal,
      narrator,
      requirePrincipal: () => {
        if (!principal) {
          throw new OwnApiError(
            "AUTH_REQUIRED",
            "Authentication is required.",
            401,
          );
        }
        return principal;
      },
      readJson: (maxBytes) => readJsonBody(request, maxBytes),
    });

    return true;
  };

  return {
    handler,
    resolveTemplate: (pathname) =>
      findMatches(pathname).matched[0]?.route.template,
  };
}
