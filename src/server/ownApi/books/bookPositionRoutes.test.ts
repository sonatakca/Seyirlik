import { describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { OwnApiError } from "../ownApiHandler";
import type {
  BookPosition,
  BookPositionRepository,
  ReadingSession,
} from "./bookPositionRepository";
import { createBookPositionRoutes } from "./bookPositionRoutes";

const READER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 5, 18);

function setup() {
  const kinds: Record<string, string> = { [BOOK]: "book", [MOVIE]: "movie" };
  const catalogue = {
    // A hidden item is indistinguishable from a missing one: visibility is the
    // repository's decision, made per user.
    getItem: async (_userId: string, itemId: string) =>
      itemId === HIDDEN || !kinds[itemId] ? null : { kind: kinds[itemId] },
  } as unknown as CatalogueRepository;

  const stored = new Map<string, BookPosition>();
  const sessions = new Map<string, ReadingSession>();
  const saves: BookPosition[] = [];
  const claims: ReadingSession[] = [];
  // The rule as user_book_sessions applies it, opened last keeps the place;
  // the SQL itself is proven against PostgreSQL in the integration test.
  const claim = (key: string, session: ReadingSession) => {
    claims.push(session);
    const current = sessions.get(key);
    if (
      !current ||
      current.sessionId === session.sessionId ||
      session.openedAt > current.openedAt
    ) {
      sessions.set(key, session);
    }
    const now = sessions.get(key) as ReadingSession;
    return { owner: now.sessionId === session.sessionId, session: now };
  };
  const positions: BookPositionRepository = {
    get: async (userId, itemId) => stored.get(`${userId}:${itemId}`) ?? null,
    claim: async (userId, itemId, session) =>
      claim(`${userId}:${itemId}`, session),
    save: async (userId, itemId, position, session) => {
      const key = `${userId}:${itemId}`;
      if (session) {
        const result = claim(key, session);
        if (!result.owner) {
          return {
            accepted: false,
            position: stored.get(key) ?? null,
            superseded: result.session,
          };
        }
      }
      saves.push(position);
      const current = stored.get(key);
      const accepted = !current || position.readAt >= current.readAt;
      if (accepted) stored.set(key, position);
      return { accepted, position: stored.get(key) ?? null, superseded: null };
    },
  };

  const routes = createBookPositionRoutes({ positions, catalogue });
  const route = (method: string, path = "/books/:itemId/position") =>
    routes.find(
      (entry) => entry.method === method && entry.path === path,
    ) as RouteDefinition;

  async function call(
    method: "GET" | "PUT",
    itemId: string,
    body?: unknown,
    path = "/books/:itemId/position",
  ) {
    const captured: { status: number; body: unknown } = {
      status: 0,
      body: null,
    };
    const context = {
      request: { headers: {} },
      response: {
        setHeader: () => undefined,
        end: (chunk?: string) => {
          captured.body = chunk ? JSON.parse(chunk) : null;
        },
        set statusCode(status: number) {
          captured.status = status;
        },
        get statusCode() {
          return captured.status;
        },
      },
      requestId: "req",
      url: new URL(`http://localhost/ownAPI/v1/books/${itemId}/position`),
      params: { itemId },
      method,
      requirePrincipal: () => ({ userId: READER, isAdministrator: false }),
      readJson: async () => body,
    } as unknown as RouteContext;

    try {
      await route(method, path).handle(context);
      return { ...captured, error: undefined as OwnApiError | undefined };
    } catch (error) {
      return { ...captured, error: error as OwnApiError };
    }
  }

  return { call, route, saves, claims };
}

const SESSION_PATH = "/books/:itemId/session";
const DESK = "66666666-6666-4666-8666-666666666666";
const PHONE = "77777777-7777-4777-8777-777777777777";

const place = { section: 3, block: 0, offset: -184 };

describe("book reading positions", () => {
  it("is for signed-in readers, and a write needs the CSRF token", () => {
    const { route } = setup();
    expect(route("GET").access).toBe("authenticated");
    expect(route("PUT").access).toBe("authenticated");
    expect(route("PUT").skipCsrf).toBeUndefined();
  });

  it("has nothing until a place is saved, then returns it", async () => {
    const { call } = setup();
    expect((await call("GET", BOOK)).body).toMatchObject({ data: null });

    const saved = await call("PUT", BOOK, {
      cfi: "epubcfi(/6/8!/4/2/1:0)",
      place,
      fraction: 0.02,
      readAt: NOW,
    });
    expect(saved.error).toBeUndefined();
    expect(saved.body).toMatchObject({
      data: {
        accepted: true,
        position: {
          cfi: "epubcfi(/6/8!/4/2/1:0)",
          place,
          fraction: 0.02,
          readAt: new Date(NOW).toISOString(),
        },
      },
    });
    expect((await call("GET", BOOK)).body).toMatchObject({
      data: { place, fraction: 0.02 },
    });
  });

  it("answers a late save with the place that beat it, not an error", async () => {
    const { call } = setup();
    await call("PUT", BOOK, { place, fraction: 0.3, readAt: NOW });
    const late = await call("PUT", BOOK, {
      place: { section: 1, block: 0, offset: 0 },
      fraction: 0.01,
      readAt: NOW - 60_000,
    });

    expect(late.error).toBeUndefined();
    expect(late.body).toMatchObject({
      data: { accepted: false, position: { place, fraction: 0.3 } },
    });
  });

  it("takes a plain document's fraction alone", async () => {
    const { call, saves } = setup();
    const saved = await call("PUT", BOOK, { fraction: 0.5, readAt: NOW });
    expect(saved.error).toBeUndefined();
    expect(saves[0]).toMatchObject({ cfi: null, place: null, fraction: 0.5 });
  });

  it("answers for a film, a hidden book and a missing one exactly alike", async () => {
    const { call, saves } = setup();
    for (const itemId of [
      MOVIE,
      HIDDEN,
      "55555555-5555-4555-8555-555555555555",
    ]) {
      for (const method of ["GET", "PUT"] as const) {
        const { error } = await call(method, itemId, {
          fraction: 0.5,
          readAt: NOW,
        });
        expect(error?.statusCode).toBe(404);
        expect(error?.code).toBe("ITEM_NOT_FOUND");
      }
    }
    expect(saves).toHaveLength(0);
  });

  it("refuses a malformed position before storing anything", async () => {
    const { call, saves } = setup();
    const bad = [
      { fraction: 1.5, readAt: NOW },
      { fraction: -0.1, readAt: NOW },
      { fraction: "0.5", readAt: NOW },
      { readAt: NOW },
      { fraction: 0.5 },
      { fraction: 0.5, readAt: 12 },
      { fraction: 0.5, readAt: NOW + 0.5 },
      { fraction: 0.5, readAt: NOW, cfi: "/6/8!/4" },
      { fraction: 0.5, readAt: NOW, cfi: `epubcfi(${"x".repeat(2_100)})` },
      { fraction: 0.5, readAt: NOW, place: { section: 1, block: 2 } },
      {
        fraction: 0.5,
        readAt: NOW,
        place: { section: -1, block: 0, offset: 0 },
      },
      {
        fraction: 0.5,
        readAt: NOW,
        place: { section: 1, block: 0, offset: 0, extra: 1 },
      },
      { fraction: 0.5, readAt: NOW, place: [1, 2, 3] },
      { fraction: 0.5, readAt: NOW, userId: READER },
      null,
    ];
    for (const body of bad) {
      const { error } = await call("PUT", BOOK, body);
      expect(error?.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(saves).toHaveLength(0);
  });

  it("rejects an id that is not a UUID", async () => {
    const { call } = setup();
    expect((await call("GET", "nope")).error?.statusCode).toBe(422);
  });

  it("lets the copy opened last keep the place, and tells an older one who has it", async () => {
    const { call, route } = setup();
    expect(route("PUT", SESSION_PATH).access).toBe("authenticated");
    expect(route("PUT", SESSION_PATH).skipCsrf).toBeUndefined();

    const desk = await call(
      "PUT",
      BOOK,
      { id: DESK, openedAt: NOW, device: "mac" },
      SESSION_PATH,
    );
    expect(desk.body).toMatchObject({
      data: { owner: true, session: { id: DESK, device: "mac" } },
    });

    const phone = await call(
      "PUT",
      BOOK,
      { id: PHONE, openedAt: NOW + 60_000, device: "iphone" },
      SESSION_PATH,
    );
    expect(phone.body).toMatchObject({ data: { owner: true } });

    const deskAgain = await call(
      "PUT",
      BOOK,
      { id: DESK, openedAt: NOW, device: "mac" },
      SESSION_PATH,
    );
    expect(deskAgain.error).toBeUndefined();
    expect(deskAgain.body).toMatchObject({
      data: {
        owner: false,
        session: {
          id: PHONE,
          openedAt: new Date(NOW + 60_000).toISOString(),
          device: "iphone",
        },
      },
    });
  });

  it("refuses a save from a copy opened before the one that keeps the place", async () => {
    const { call, saves } = setup();
    await call(
      "PUT",
      BOOK,
      { id: PHONE, openedAt: NOW + 60_000, device: "iphone" },
      SESSION_PATH,
    );
    const stale = await call("PUT", BOOK, {
      place,
      fraction: 0.1,
      readAt: NOW + 120_000,
      session: { id: DESK, openedAt: NOW, device: "mac" },
    });
    expect(stale.error).toBeUndefined();
    expect(stale.body).toMatchObject({
      data: {
        accepted: false,
        position: null,
        superseded: { id: PHONE, device: "iphone" },
      },
    });
    expect(saves).toHaveLength(0);

    const owner = await call("PUT", BOOK, {
      place,
      fraction: 0.2,
      readAt: NOW + 120_000,
      session: { id: PHONE, openedAt: NOW + 60_000, device: "iphone" },
    });
    expect(owner.body).toMatchObject({
      data: { accepted: true, superseded: null },
    });
  });

  it("refuses a malformed session before claiming anything", async () => {
    const { call, claims } = setup();
    const bad = [
      { id: "nope", openedAt: NOW },
      { id: DESK },
      { id: DESK, openedAt: 12 },
      { id: DESK, openedAt: NOW, device: "toaster" },
      { id: DESK, openedAt: NOW, extra: 1 },
      [DESK],
      null,
    ];
    for (const body of bad) {
      const { error } = await call("PUT", BOOK, body, SESSION_PATH);
      expect(error?.statusCode, JSON.stringify(body)).toBe(422);
      const save = await call("PUT", BOOK, {
        fraction: 0.5,
        readAt: NOW,
        session: body,
      });
      expect(save.error?.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(claims).toHaveLength(0);
    expect(
      (await call("PUT", MOVIE, { id: DESK, openedAt: NOW }, SESSION_PATH))
        .error?.statusCode,
    ).toBe(404);
  });
});
