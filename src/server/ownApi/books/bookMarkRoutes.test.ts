import { describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { OwnApiError } from "../ownApiHandler";
import type {
  BookMark,
  BookMarkChange,
  BookMarkRepository,
} from "./bookMarkRepository";
import { createBookMarkRoutes } from "./bookMarkRoutes";

const READER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 8, 18);

function setup() {
  const kinds: Record<string, string> = { [BOOK]: "book", [MOVIE]: "movie" };
  const catalogue = {
    getItem: async (_userId: string, itemId: string) =>
      itemId === HIDDEN || !kinds[itemId] ? null : { kind: kinds[itemId] },
  } as unknown as CatalogueRepository;

  const stored = new Map<string, BookMark>();
  const applied: BookMarkChange[][] = [];
  const marks: BookMarkRepository = {
    list: async () => [...stored.values()],
    apply: async (_userId, _itemId, changes) => {
      applied.push([...changes]);
      for (const { id, changedAt, mark } of changes) {
        if (mark) stored.set(id, { id, changedAt, ...mark });
        else stored.delete(id);
      }
      return [...stored.values()];
    },
  };

  const routes = createBookMarkRoutes({ marks, catalogue });
  const route = (method: string) =>
    routes.find(
      (entry) =>
        entry.method === method && entry.path === "/books/:itemId/marks",
    ) as RouteDefinition;

  async function call(method: "GET" | "POST", itemId: string, body?: unknown) {
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
      url: new URL(`http://localhost/ownAPI/v1/books/${itemId}/marks`),
      params: { itemId },
      method,
      requirePrincipal: () => ({ userId: READER, isAdministrator: false }),
      readJson: async () => body,
    } as unknown as RouteContext;

    try {
      await route(method).handle(context);
      return { ...captured, error: undefined as OwnApiError | undefined };
    } catch (error) {
      return { ...captured, error: error as OwnApiError };
    }
  }

  return { call, route, applied };
}

const highlight = {
  cfi: "epubcfi(/6/4!/4/2,/1:0,/1:12)",
  label: "Bir",
  excerpt: "Vurgulanan cümle.",
  progress: 0.1,
  color: "green",
  createdAt: NOW - 60_000,
};

describe("book marks", () => {
  it("is for signed-in readers, and a write needs the CSRF token", () => {
    const { route } = setup();
    expect(route("GET").access).toBe("authenticated");
    expect(route("POST").access).toBe("authenticated");
    expect(route("POST").skipCsrf).toBeUndefined();
  });

  it("stores a highlight and a bookmark, removes one, and answers with what is kept", async () => {
    const { call } = setup();
    expect((await call("GET", BOOK)).body).toMatchObject({ data: [] });

    const saved = await call("POST", BOOK, {
      changes: [
        { id: "mh-1", changedAt: NOW, mark: highlight },
        {
          id: "mb-2",
          changedAt: NOW,
          mark: {
            ...highlight,
            cfi: "epubcfi(/6/8!/4/2/1:0)",
            progress: null,
            color: null,
          },
        },
      ],
    });
    expect(saved.error).toBeUndefined();
    expect(saved.body).toMatchObject({
      data: [
        {
          id: "mh-1",
          color: "green",
          excerpt: "Vurgulanan cümle.",
          changedAt: NOW,
          createdAt: NOW - 60_000,
        },
        { id: "mb-2", color: null, progress: null },
      ],
    });

    const removed = await call("POST", BOOK, {
      changes: [{ id: "mb-2", changedAt: NOW + 1, mark: null }],
    });
    expect(removed.body).toMatchObject({ data: [{ id: "mh-1" }] });
  });

  it("answers for a film, a hidden book and a missing one exactly alike", async () => {
    const { call, applied } = setup();
    for (const itemId of [
      MOVIE,
      HIDDEN,
      "55555555-5555-4555-8555-555555555555",
    ]) {
      for (const method of ["GET", "POST"] as const) {
        const { error } = await call(method, itemId, {
          changes: [{ id: "a", changedAt: NOW, mark: highlight }],
        });
        expect(error?.statusCode).toBe(404);
        expect(error?.code).toBe("ITEM_NOT_FOUND");
      }
    }
    expect(applied).toHaveLength(0);
  });

  it("refuses a malformed change before storing anything", async () => {
    const { call, applied } = setup();
    const one = (change: unknown) => ({ changes: [change] });
    const bad = [
      null,
      {},
      { changes: [] },
      {
        changes: Array.from({ length: 21 }, (_, i) => ({
          id: `m${i}`,
          changedAt: NOW,
          mark: null,
        })),
      },
      {
        changes: [
          { id: "a", changedAt: NOW, mark: null },
          { id: "a", changedAt: NOW, mark: null },
        ],
      },
      { changes: [], userId: READER },
      one({ id: "a b", changedAt: NOW, mark: null }),
      one({ id: "x".repeat(65), changedAt: NOW, mark: null }),
      one({ id: 7, changedAt: NOW, mark: null }),
      one({ id: "a", changedAt: 12, mark: null }),
      one({ id: "a", changedAt: NOW + 0.5, mark: null }),
      one({ id: "a", mark: null }),
      one({ id: "a", changedAt: NOW }),
      one({ id: "a", changedAt: NOW, mark: null, userId: READER }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, cfi: "/6/4!/4" } }),
      one({
        id: "a",
        changedAt: NOW,
        mark: { ...highlight, cfi: `epubcfi(${"x".repeat(4_100)})` },
      }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, color: "teal" } }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, progress: 1.5 } }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, progress: "0.5" } }),
      one({
        id: "a",
        changedAt: NOW,
        mark: { ...highlight, excerpt: "x".repeat(10_001) },
      }),
      one({
        id: "a",
        changedAt: NOW,
        mark: { ...highlight, label: undefined },
      }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, createdAt: 3 } }),
      one({ id: "a", changedAt: NOW, mark: { ...highlight, owner: READER } }),
      one({ id: "a", changedAt: NOW, mark: [] }),
    ];
    for (const body of bad) {
      const { error } = await call("POST", BOOK, body);
      expect(error?.statusCode, JSON.stringify(body)?.slice(0, 200)).toBe(422);
    }
    expect(applied).toHaveLength(0);
  });

  it("rejects an id that is not a UUID", async () => {
    const { call } = setup();
    expect((await call("GET", "nope")).error?.statusCode).toBe(422);
  });
});
