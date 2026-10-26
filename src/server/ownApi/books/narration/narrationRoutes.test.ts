// @vitest-environment node
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteDefinition, RoutePrincipal } from "../../api/router";
import type { CatalogueRepository } from "../../catalogue/catalogueRepository";
import type { OwnApiError } from "../../ownApiHandler";
import { epub } from "../epubFixture";
import type {
  BookNarration,
  NarrationRepository,
  NarrationSection,
} from "./narrationRepository";
import {
  createNarrationRoutes,
  createNarratorResolver,
  hashNarratorKey,
  newNarratorKey,
} from "./narrationRoutes";
import { createNarrationStore } from "./narrationStore";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const READER = "55555555-5555-4555-8555-555555555555";
const BOOK = "22222222-2222-4222-8222-222222222222";
const HIDDEN = "44444444-4444-4444-8444-444444444444";
const MAC = {
  keyId: "66666666-6666-4666-8666-666666666666",
  label: "MacBook Pro",
};
const OTHER = { keyId: "77777777-7777-4777-8777-777777777777", label: "Spare" };

const audio = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypM4A "),
  Buffer.alloc(5000, 3),
]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const person = (userId: string, isAdministrator: boolean): RoutePrincipal => ({
  userId,
  username: "u",
  displayName: "u",
  isAdministrator,
  sessionId: "s",
  sessionTokenHash: Buffer.alloc(32),
});

/** The repository's rules as the integration test proves them in SQL, kept to what these routes rely on. */
function memoryNarrations() {
  let narration: BookNarration | null = null;
  const sections = new Map<number, NarrationSection>();
  const repository: NarrationRepository = {
    get: async (itemId) =>
      narration && narration.itemId === itemId
        ? {
            narration,
            sections: [...sections.values()].sort(
              (a, b) => a.section - b.section,
            ),
          }
        : null,
    request: async (itemId) => {
      if (narration && narration.state !== "failed") return false;
      narration = {
        itemId,
        state: "queued",
        requestedAt: new Date(),
        voice: narration?.voice ?? null,
        scriptVersion: narration?.scriptVersion ?? null,
        narratorKeyId: null,
        heartbeatAt: null,
        bookFileId: narration?.bookFileId ?? null,
        bookFingerprint: narration?.bookFingerprint ?? null,
        progress: null,
        error: null,
        finishedAt: null,
      };
      return true;
    },
    remove: async () => {
      const had = narration !== null;
      narration = null;
      sections.clear();
      return had;
    },
    claim: async ({ keyId, voice, scriptVersion, bookOf }) => {
      if (!narration || !["queued", "narrating"].includes(narration.state))
        return null;
      if (narration.state === "narrating" && narration.narratorKeyId !== keyId)
        return null;
      const book = await bookOf(narration.itemId);
      if (!book) return null;
      narration = {
        ...narration,
        state: "narrating",
        narratorKeyId: keyId,
        heartbeatAt: new Date(),
        voice,
        scriptVersion,
        bookFileId: book.fileId,
        bookFingerprint: book.fingerprint,
      };
      return { narration, sections: [...sections.values()], reset: false };
    },
    heartbeat: async (itemId, keyId, progress) => {
      if (narration?.state !== "narrating" || narration.narratorKeyId !== keyId)
        return false;
      narration = { ...narration, progress };
      return true;
    },
    commitSection: async (itemId, keyId, row) => {
      if (narration?.state !== "narrating" || narration.narratorKeyId !== keyId)
        return null;
      const before = sections.get(row.section)?.audioSha256 ?? null;
      sections.set(row.section, { ...row, uploadedAt: new Date() });
      return { replaced: before === row.audioSha256 ? null : before };
    },
    finish: async (itemId, keyId, outcome) => {
      if (narration?.state !== "narrating" || narration.narratorKeyId !== keyId)
        return false;
      if (outcome.ready && outcome.sections.some((n) => !sections.has(n)))
        return false;
      narration = {
        ...narration,
        state: outcome.ready ? "ready" : "failed",
        error: outcome.ready ? null : outcome.error,
      };
      return true;
    },
    findKey: async () => null,
    touchKey: async () => undefined,
    createKey: async () => {
      throw new Error("not here");
    },
    listKeys: async () => [],
    revokeKey: async () => false,
    lastSeen: async () => new Date("2026-10-26T18:00:00Z"),
  };
  return {
    repository,
    takeAway: () => {
      if (narration) narration = { ...narration, narratorKeyId: OTHER.keyId };
    },
  };
}

class Sink extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
  }
  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  get json() {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
  }
}

describe("narration routes", () => {
  let root: string;
  let media: string;
  let fingerprint: string;
  let routes: RouteDefinition[];
  let narrations: ReturnType<typeof memoryNarrations>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "narration-routes-"));
    media = path.join(root, "media");
    await mkdir(path.join(media, "books"), { recursive: true });
    await writeFile(
      path.join(media, "books", "kurk.epub"),
      epub([
        {
          id: "one",
          href: "one.xhtml",
          body: "<h1>BİR</h1><p>Pansiyondaki Hollandalı dul.</p>",
        },
        { id: "two", href: "two.xhtml", body: "<p>Frau Tiedemann güldü.</p>" },
      ]),
    );
    fingerprint = "edition-1";
    narrations = memoryNarrations();
    const catalogue = {
      getItem: async (_userId: string, itemId: string) =>
        itemId === BOOK ? { kind: "book" } : null,
      getItemKind: async (itemId: string) =>
        itemId === BOOK || itemId === HIDDEN ? "book" : null,
      getPrimaryFile: async (itemId: string) =>
        itemId === BOOK
          ? {
              id: "88888888-8888-4888-8888-888888888888",
              itemId,
              relativePath: "books/kurk.epub",
              fingerprint,
              missingSince: null,
            }
          : null,
    } as unknown as CatalogueRepository;
    routes = createNarrationRoutes({
      narrations: narrations.repository,
      store: createNarrationStore(path.join(root, "narrations")),
      catalogue,
      mediaRoot: media,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function call(
    method: string,
    template: string,
    options: {
      params?: Record<string, string>;
      as?: RoutePrincipal | null;
      narrator?: typeof MAC | null;
      json?: unknown;
      bytes?: Buffer;
      query?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const route = routes.find(
      (r) => r.method === method && r.path === template,
    );
    if (!route) throw new Error(`no route ${method} ${template}`);
    const body =
      options.bytes ??
      (options.json === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(options.json)));
    const request = Object.assign(Readable.from([body]), {
      method,
      headers: {
        "content-length": String(body.length),
        ...(options.headers ?? {}),
      },
    }) as unknown as IncomingMessage;
    const response = new Sink();
    const principal =
      options.as === undefined ? person(ADMIN, true) : options.as;
    let error: OwnApiError | null = null;
    try {
      await route.handle({
        request,
        response: response as unknown as ServerResponse,
        requestId: "r",
        url: new URL(`https://seyirlik.test/x${options.query ?? ""}`),
        params: { itemId: BOOK, ...(options.params ?? {}) },
        method,
        principal,
        narrator: options.narrator ?? null,
        requirePrincipal: () => {
          if (!principal) throw new Error("no principal");
          return principal;
        },
        readJson: async () => options.json,
      });
    } catch (caught) {
      error = caught as OwnApiError;
    }
    return { response, error };
  }

  const narrator = (
    method: string,
    template: string,
    options: Parameters<typeof call>[2] = {},
  ) => call(method, template, { as: null, narrator: MAC, ...options });

  /** A narration requested and taken by the Mac. */
  async function claimed() {
    await call("POST", "/books/:itemId/narration");
    const claim = await narrator("POST", "/narrator/claim", {
      json: { voice: "mk" },
    });
    return claim.response.json.data.job;
  }

  async function upload(section: number, bytes = audio) {
    for (let offset = 0; offset < bytes.length; offset += 2048) {
      const part = bytes.subarray(offset, offset + 2048);
      const sent = await narrator(
        "PUT",
        "/narrator/jobs/:itemId/sections/:section/audio",
        {
          params: { section: String(section) },
          bytes: part,
          query: `?offset=${offset}`,
        },
      );
      expect(sent.error).toBeNull();
    }
  }

  const commit = (section: number, words: unknown, bytes = audio) =>
    narrator("POST", "/narrator/jobs/:itemId/sections/:section", {
      params: { section: String(section) },
      json: { sha256: sha(bytes), duration: 3, words },
    });

  it("answers a hidden book, or one without a narration, as missing", async () => {
    expect(
      (
        await call("GET", "/books/:itemId/narration", {
          params: { itemId: HIDDEN },
        })
      ).error?.statusCode,
    ).toBe(404);
    const none = await call("GET", "/books/:itemId/narration", {
      as: person(READER, false),
    });
    expect(none.error?.code).toBe("NARRATION_NOT_FOUND");
  });

  it("queues a request once, and tells only an administrator when a narrator was last there", async () => {
    const requested = await call("POST", "/books/:itemId/narration");
    expect(requested.response.statusCode).toBe(202);
    expect(requested.response.json.data).toMatchObject({
      state: "queued",
      sections: [],
    });
    expect((await call("POST", "/books/:itemId/narration")).error?.code).toBe(
      "NARRATION_EXISTS",
    );

    const admin = await call("GET", "/books/:itemId/narration");
    expect(admin.response.json.data.narratorSeenAt).toBe(
      "2026-10-26T18:00:00.000Z",
    );
    const reader = await call("GET", "/books/:itemId/narration", {
      as: person(READER, false),
    });
    expect(reader.response.json.data).not.toHaveProperty("narratorSeenAt");
  });

  it("tells an administrator whether a narrator is there before any book is asked for", async () => {
    const presence = await call("GET", "/admin/narrator");
    expect(presence.response.json.data).toEqual({
      seenAt: "2026-10-26T18:00:00.000Z",
    });
  });

  it("hands the narrator the book's script, and its reports go on the narration", async () => {
    const job = await claimed();
    expect(job).toMatchObject({ itemId: BOOK, voice: "mk", sections: [] });

    const script = await narrator("GET", "/narrator/jobs/:itemId/script");
    expect(
      script.response.json.data.sections.map(
        (s: { section: number }) => s.section,
      ),
    ).toEqual([0, 1]);

    const progress = {
      fraction: 0.4,
      sectionsDone: 0,
      sectionsTotal: 2,
      etaSeconds: 1200,
      activity: "reading",
    };
    expect(
      (
        await narrator("POST", "/narrator/jobs/:itemId/progress", {
          json: progress,
        })
      ).response.statusCode,
    ).toBe(204);
    expect(
      (await call("GET", "/books/:itemId/narration")).response.json.data
        .progress,
    ).toEqual(progress);
    expect(
      (
        await narrator("POST", "/narrator/jobs/:itemId/progress", {
          json: { ...progress, fraction: 2 },
        })
      ).error?.statusCode,
    ).toBe(422);
  });

  it("takes a section's audio in parts with its words, and the reader can play it", async () => {
    await claimed();
    await upload(0);
    const done = await commit(0, [[0, 0, 3, 100, 600]]);
    expect(done.error).toBeNull();

    const narration = (
      await call("GET", "/books/:itemId/narration", {
        as: person(READER, false),
      })
    ).response.json.data;
    expect(narration.sections).toEqual([
      { section: 0, duration: 3, version: sha(audio).slice(0, 16) },
    ]);

    const words = await call(
      "GET",
      "/books/:itemId/narration/sections/:section/words",
      {
        as: person(READER, false),
        params: { section: "0" },
      },
    );
    expect(words.response.json.data).toEqual({
      version: 1,
      section: 0,
      duration: 3,
      words: [[0, 0, 3, 100, 600]],
    });

    const played = await call(
      "GET",
      "/books/:itemId/narration/sections/:section/audio",
      {
        as: person(READER, false),
        params: { section: "0" },
        headers: { range: "bytes=0-11" },
      },
    );
    expect(played.response.statusCode).toBe(206);
    expect(played.response.headers["content-type"]).toBe("audio/mp4");
    expect(Buffer.concat(played.response.chunks)).toEqual(
      audio.subarray(0, 12),
    );
  });

  it("asks for a part again from where the upload stands", async () => {
    await claimed();
    await narrator("PUT", "/narrator/jobs/:itemId/sections/:section/audio", {
      params: { section: "0" },
      bytes: audio.subarray(0, 100),
      query: "?offset=0",
    });
    const skipped = await narrator(
      "PUT",
      "/narrator/jobs/:itemId/sections/:section/audio",
      {
        params: { section: "0" },
        bytes: audio.subarray(500, 600),
        query: "?offset=500",
      },
    );
    expect(skipped.error?.code).toBe("NARRATION_PART_OFFSET");
    const staged = await narrator(
      "GET",
      "/narrator/jobs/:itemId/sections/:section/staged",
      { params: { section: "0" } },
    );
    expect(staged.response.json.data).toEqual({ size: 100 });
  });

  it("refuses words that are not the script's, and audio that is not what was sent", async () => {
    await claimed();
    await upload(1);
    // Block 0 of section 1 is "Frau Tiedemann güldü.": 21 characters.
    expect((await commit(1, [[0, 0, 40, 0, 100]])).error?.code).toBe(
      "NARRATION_TIMINGS_REJECTED",
    );
    expect((await commit(1, [[3, 0, 4, 0, 100]])).error?.code).toBe(
      "NARRATION_TIMINGS_REJECTED",
    );
    expect(
      (await commit(1, [[0, 0, 4, 0, 100]], Buffer.from("other"))).error?.code,
    ).toBe("NARRATION_AUDIO_REJECTED");
    expect((await commit(7, [])).error?.code).toBe("NARRATION_SECTION_UNKNOWN");
  });

  it("keeps a narrator that lost the book out, and leaves no files of its upload", async () => {
    await claimed();
    await upload(0);
    narrations.takeAway();

    expect((await commit(0, [[0, 0, 3, 0, 100]])).error?.code).toBe(
      "NARRATION_NOT_HELD",
    );
    expect(
      (await narrator("GET", "/narrator/jobs/:itemId/script")).error?.code,
    ).toBe("NARRATION_NOT_HELD");
    expect(
      (
        await narrator("POST", "/narrator/jobs/:itemId/progress", {
          json: {
            fraction: 0,
            sectionsDone: 0,
            sectionsTotal: 2,
            etaSeconds: null,
            activity: null,
          },
        })
      ).error?.code,
    ).toBe("NARRATION_NOT_HELD");
  });

  it("is ready only with every section, and a new upload replaces the old files", async () => {
    await claimed();
    await upload(0);
    await commit(0, [[0, 0, 3, 0, 100]]);
    expect(
      (
        await narrator("POST", "/narrator/jobs/:itemId/finish", {
          json: { ready: true },
        })
      ).error?.code,
    ).toBe("NARRATION_INCOMPLETE");

    const retake = Buffer.concat([audio, Buffer.from("retake")]);
    await upload(0, retake);
    await commit(0, [[0, 0, 3, 0, 100]], retake);
    const files = await readdir(path.join(root, "narrations", BOOK));
    expect(files.filter((name) => name.startsWith("0-")).sort()).toEqual([
      `0-${sha(retake)}.m4a`,
      `0-${sha(retake)}.words.json`,
    ]);

    await upload(1);
    await commit(1, [[0, 0, 4, 0, 100]]);
    const finished = await narrator("POST", "/narrator/jobs/:itemId/finish", {
      json: { ready: true },
    });
    expect(finished.response.statusCode).toBe(204);
    expect(
      (await call("GET", "/books/:itemId/narration")).response.json.data.state,
    ).toBe("ready");
  });

  it("stops serving a narration once the book's file is another edition", async () => {
    await claimed();
    await upload(0);
    await commit(0, [[0, 0, 3, 0, 100]]);
    fingerprint = "edition-2";

    const narration = (await call("GET", "/books/:itemId/narration")).response
      .json.data;
    expect(narration).toMatchObject({ state: "outdated", sections: [] });
    const audioNow = await call(
      "GET",
      "/books/:itemId/narration/sections/:section/audio",
      { params: { section: "0" } },
    );
    expect(audioNow.error?.statusCode).toBe(404);
  });

  it("removes a narration and its files", async () => {
    await claimed();
    await upload(0);
    await commit(0, [[0, 0, 3, 0, 100]]);

    expect(
      (await call("DELETE", "/books/:itemId/narration")).response.statusCode,
    ).toBe(204);
    await expect(
      readdir(path.join(root, "narrations", BOOK)),
    ).rejects.toThrow();
    expect(
      (await call("GET", "/books/:itemId/narration")).error?.statusCode,
    ).toBe(404);
  });
});

describe("narrator keys", () => {
  it("knows a key by its hash, and nothing that is not a narrator key", async () => {
    const key = newNarratorKey();
    const stored = hashNarratorKey(key);
    const resolve = createNarratorResolver({
      findKey: async (hash) =>
        hash.equals(stored)
          ? {
              id: MAC.keyId,
              label: MAC.label,
              createdAt: new Date(),
              lastSeenAt: null,
              revokedAt: null,
            }
          : null,
    });
    const asking = (authorization?: string) =>
      resolve({
        headers: authorization ? { authorization } : {},
      } as IncomingMessage);

    expect(key).toMatch(/^snk_[A-Za-z0-9_-]{43}$/);
    expect(await asking(`Bearer ${key}`)).toEqual(MAC);
    expect(await asking(`Bearer ${newNarratorKey()}`)).toBeNull();
    expect(await asking(key)).toBeNull();
    expect(await asking("Bearer not-a-narrator-key")).toBeNull();
    expect(await asking()).toBeNull();
  });
});
