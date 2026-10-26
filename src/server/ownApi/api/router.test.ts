import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createOwnApiRouter, type RoutePrincipal } from "./router";
import { createCsrfToken } from "../auth/csrf";
import { OwnApiError, sendOwnApiJson } from "../ownApiHandler";

const CSRF_SECRET = "x".repeat(32);
const SESSION_TOKEN_HASH = createHmac("sha256", "k").update("t").digest();

function principal(isAdministrator = false): RoutePrincipal {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    username: "viewer",
    displayName: "Viewer",
    isAdministrator,
    sessionId: "22222222-2222-4222-8222-222222222222",
    sessionTokenHash: SESSION_TOKEN_HASH,
  };
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function createRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): { request: IncomingMessage; response: ServerResponse; sent: FakeResponse } {
  const sent: FakeResponse = { statusCode: 200, headers: {}, body: "" };
  const request = {
    method,
    url: path,
    headers: { host: "seyirlik.test", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  const response = {
    get statusCode() {
      return sent.statusCode;
    },
    set statusCode(value: number) {
      sent.statusCode = value;
    },
    setHeader(name: string, value: string | string[]) {
      sent.headers[name] = value;
    },
    getHeader(name: string) {
      return sent.headers[name];
    },
    end(chunk?: string) {
      sent.body = chunk ?? "";
    },
  } as unknown as ServerResponse;

  return { request, response, sent };
}

function buildRouter(
  session: RoutePrincipal | null,
  trustedOrigins?: ReadonlySet<string>,
) {
  const seen: Array<Record<string, string>> = [];
  const router = createOwnApiRouter({
    csrfSecret: CSRF_SECRET,
    csrfCookieName: "seyirlik_csrf",
    publicOrigin: "https://seyirlik.test",
    ...(trustedOrigins ? { trustedOrigins } : {}),
    resolveSession: async () => session,
    routes: [
      {
        method: "GET",
        path: "/health-probe",
        access: "public",
        handle: async ({ response, requestId }) => {
          sendOwnApiJson(response, 200, { data: { ok: true }, requestId });
        },
      },
      {
        method: "GET",
        path: "/items/:itemId/images/:imageType",
        access: "authenticated",
        handle: async ({ params, response, requestId }) => {
          seen.push({ ...params });
          sendOwnApiJson(response, 200, { data: params, requestId });
        },
      },
      {
        method: "POST",
        path: "/items/:itemId/played",
        access: "authenticated",
        handle: async ({ response }) => {
          response.statusCode = 204;
          response.end();
        },
      },
      {
        method: "GET",
        path: "/admin/users",
        access: "admin",
        handle: async ({ response, requestId }) => {
          sendOwnApiJson(response, 200, { data: [], requestId });
        },
      },
    ],
  });
  return { router, seen };
}

async function run(
  router: ReturnType<typeof buildRouter>["router"],
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const { request, response, sent } = createRequest(method, path, headers);
  const url = new URL(path, "https://seyirlik.test");
  let error: unknown;
  let handled = false;
  try {
    handled = await router.handler(request, response, {
      requestId: "req-1",
      url,
    });
  } catch (caught) {
    error = caught;
  }
  return { sent, error, handled };
}

describe("own API router", () => {
  it("decodes path parameters and rejects encoded separators", async () => {
    const { router, seen } = buildRouter(principal());

    const ok = await run(
      router,
      "GET",
      "/ownAPI/v1/items/abc-123/images/cover",
    );
    expect(ok.handled).toBe(true);
    expect(seen).toEqual([{ itemId: "abc-123", imageType: "cover" }]);

    const traversal = await run(
      router,
      "GET",
      "/ownAPI/v1/items/a%2Fb/images/cover",
    );
    expect(traversal.handled).toBe(false);
  });

  it("returns 401 for authenticated routes without a session", async () => {
    const { router } = buildRouter(null);
    const result = await run(router, "GET", "/ownAPI/v1/items/x/images/cover");
    expect((result.error as OwnApiError).statusCode).toBe(401);
    expect((result.error as OwnApiError).code).toBe("AUTH_REQUIRED");
  });

  it("returns 403 for admin routes when the user is not an administrator", async () => {
    const { router } = buildRouter(principal(false));
    const result = await run(router, "GET", "/ownAPI/v1/admin/users");
    expect((result.error as OwnApiError).statusCode).toBe(403);
  });

  it("allows admin routes for administrators", async () => {
    const { router } = buildRouter(principal(true));
    const result = await run(router, "GET", "/ownAPI/v1/admin/users");
    expect(result.handled).toBe(true);
    expect(result.sent.statusCode).toBe(200);
  });

  it("requires a matching origin and CSRF token on mutations", async () => {
    const { router } = buildRouter(principal());

    const noOrigin = await run(router, "POST", "/ownAPI/v1/items/x/played");
    expect((noOrigin.error as OwnApiError).code).toBe("CSRF_REJECTED");

    const wrongOrigin = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "https://evil.test",
    });
    expect((wrongOrigin.error as OwnApiError).code).toBe("CSRF_REJECTED");

    const noToken = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "https://seyirlik.test",
    });
    expect((noToken.error as OwnApiError).code).toBe("CSRF_REJECTED");

    const csrfToken = createCsrfToken(SESSION_TOKEN_HASH, CSRF_SECRET, (size) =>
      randomBytes(size),
    );
    const accepted = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "https://seyirlik.test",
      cookie: `seyirlik_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    });
    expect(accepted.handled).toBe(true);
    expect(accepted.sent.statusCode).toBe(204);
  });

  it("accepts a mutation from an explicitly allowed origin", async () => {
    // CORS already grants these origins credentialed access, so refusing them
    // here would only mean a deployment could not be driven from the
    // development origin it was told to trust.
    const { router } = buildRouter(
      principal(),
      new Set(["http://localhost:5173"]),
    );
    const csrfToken = createCsrfToken(SESSION_TOKEN_HASH, CSRF_SECRET);

    const result = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "http://localhost:5173",
      cookie: `seyirlik_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    });

    expect(result.handled).toBe(true);
    expect(result.sent.statusCode).toBe(204);
  });

  it("still rejects an origin that was never allowed", async () => {
    const { router } = buildRouter(
      principal(),
      new Set(["http://localhost:5173"]),
    );
    const csrfToken = createCsrfToken(SESSION_TOKEN_HASH, CSRF_SECRET);

    const result = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "https://evil.test",
      cookie: `seyirlik_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    });

    expect((result.error as OwnApiError).code).toBe("CSRF_REJECTED");
  });

  it("rejects a CSRF token that is not bound to the active session", async () => {
    const { router } = buildRouter(principal());
    const otherSessionToken = createCsrfToken(
      createHmac("sha256", "k").update("other").digest(),
      CSRF_SECRET,
    );

    const result = await run(router, "POST", "/ownAPI/v1/items/x/played", {
      origin: "https://seyirlik.test",
      cookie: `seyirlik_csrf=${otherSessionToken}`,
      "x-csrf-token": otherSessionToken,
    });
    expect((result.error as OwnApiError).code).toBe("CSRF_REJECTED");
  });

  it("answers 405 with an Allow header when only the method differs", async () => {
    const { router } = buildRouter(principal());
    const result = await run(router, "DELETE", "/ownAPI/v1/admin/users");
    expect((result.error as OwnApiError).statusCode).toBe(405);
    expect(result.sent.headers.Allow).toBe("GET, HEAD, OPTIONS");
  });

  it("resolves fixed route templates for logging", () => {
    const { router } = buildRouter(principal());
    expect(
      router.resolveTemplate("/ownAPI/v1/items/secret-id/images/cover"),
    ).toBe("/ownAPI/v1/items/:itemId/images/:imageType");
    expect(router.resolveTemplate("/ownAPI/v1/unknown")).toBeUndefined();
  });
});

describe("narrator routes", () => {
  function buildNarratorRouter(
    session: RoutePrincipal | null,
    withResolver = true,
  ) {
    const calls: Array<{ narrator: unknown; principal: unknown }> = [];
    const router = createOwnApiRouter({
      csrfSecret: CSRF_SECRET,
      csrfCookieName: "seyirlik_csrf",
      publicOrigin: "https://seyirlik.test",
      resolveSession: async () => session,
      ...(withResolver
        ? {
            resolveNarrator: async (request: IncomingMessage) =>
              request.headers.authorization === "Bearer good-key"
                ? { keyId: "key-1", label: "MacBook Pro" }
                : null,
          }
        : {}),
      routes: [
        {
          method: "POST",
          path: "/narrator/claim",
          access: "narrator",
          handle: async ({ response, requestId, narrator, principal }) => {
            calls.push({ narrator, principal });
            sendOwnApiJson(response, 200, { data: {}, requestId });
          },
        },
        {
          method: "GET",
          path: "/items/:itemId/images/:imageType",
          access: "authenticated",
          handle: async ({ response, requestId }) => {
            sendOwnApiJson(response, 200, { data: {}, requestId });
          },
        },
      ],
    });
    return { router, calls };
  }

  it("answers only a narrator key, never a signed-in session", async () => {
    const { router, calls } = buildNarratorRouter(principal(true));

    const result = await run(router, "POST", "/ownAPI/v1/narrator/claim", {
      origin: "https://seyirlik.test",
    });
    expect((result.error as OwnApiError).statusCode).toBe(401);
    expect((result.error as OwnApiError).code).toBe("NARRATOR_KEY_REQUIRED");

    const wrong = await run(router, "POST", "/ownAPI/v1/narrator/claim", {
      authorization: "Bearer guessed-key",
    });
    expect((wrong.error as OwnApiError).code).toBe("NARRATOR_KEY_REQUIRED");
    expect(calls).toEqual([]);
  });

  it("takes a key with no origin or CSRF token, and passes on who it is", async () => {
    const { router, calls } = buildNarratorRouter(null);

    const result = await run(router, "POST", "/ownAPI/v1/narrator/claim", {
      authorization: "Bearer good-key",
    });
    expect(result.handled).toBe(true);
    expect(result.sent.statusCode).toBe(200);
    expect(calls).toEqual([
      { narrator: { keyId: "key-1", label: "MacBook Pro" }, principal: null },
    ]);
  });

  it("answers no narrator at all without a way to check keys", async () => {
    const { router } = buildNarratorRouter(null, false);
    const result = await run(router, "POST", "/ownAPI/v1/narrator/claim", {
      authorization: "Bearer good-key",
    });
    expect((result.error as OwnApiError).statusCode).toBe(401);
  });

  it("gives a narrator key nothing of a person's", async () => {
    const { router } = buildNarratorRouter(null);
    const result = await run(router, "GET", "/ownAPI/v1/items/x/images/cover", {
      authorization: "Bearer good-key",
    });
    expect((result.error as OwnApiError).code).toBe("AUTH_REQUIRED");
  });
});
