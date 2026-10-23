// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { releaseIdFromGuid } from "./releaseId";
import { createNewznabProvider } from "./newznabProvider";
import { IndexerError } from "./indexerTypes";

describe("turning a guid back into a provider identifier", () => {
  it.each([
    ["abc123", "abc123"],
    ["https://api.example.invalid/details/abc123", "abc123"],
    ["https://api.example.invalid/details/abc123/", "abc123"],
    ["https://api.example.invalid/api?t=details&id=abc123", "abc123"],
    ["  abc123  ", "abc123"],
    ["a-b_c.d~e", "a-b_c.d~e"],
  ])("reads %s as %s", (guid, expected) => {
    expect(releaseIdFromGuid(guid)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not a valid id", "spaces"],
    ["../../etc/passwd", "traversal"],
    ["abc&apikey=stolen", "an extra parameter"],
    ["abc#fragment", "a fragment"],
    ["https://", "a URL with no path"],
    ["ht!tp://broken", "a malformed URL"],
    ["a".repeat(500), "absurd length"],
  ])("refuses %s (%s)", (guid) => {
    expect(releaseIdFromGuid(guid)).toBeUndefined();
  });

  it("refuses anything that could smuggle a second parameter", () => {
    /*
     * This value becomes a query parameter on a request that carries the
     * provider's API key. Accepting `&` or `?` would let a caller reshape that
     * request, so the identifier is restricted to characters that cannot.
     */
    for (const hostile of ["a&b", "a?b", "a=b", "a b", "a/b", "a%26b"]) {
      expect(releaseIdFromGuid(hostile)).toBeUndefined();
    }
  });
});

describe("fetching the payload for a release", () => {
  const KEY = "0123456789abcdef0123456789abcdef";
  const NZB = '<?xml version="1.0"?><nzb><file subject="x"/></nzb>';

  function provider(fetchImpl: typeof fetch) {
    return createNewznabProvider({
      id: "ix",
      name: "Indexer",
      baseUrl: "https://api.example.invalid",
      apiPath: "/api",
      apiKey: KEY,
      fetchImpl,
      sleep: async () => undefined,
    });
  }

  it("asks the provider by identifier, with the key added at the last moment", async () => {
    let seen: URL | undefined;
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      seen = new URL(String(input));
      return new Response(NZB, { status: 200 });
    }) as unknown as typeof fetch;

    const payload = await provider(fetchImpl).fetchRelease(
      "https://api.example.invalid/details/abc123",
    );
    expect(new TextDecoder().decode(payload.bytes)).toBe(NZB);
    expect(seen?.searchParams.get("t")).toBe("get");
    expect(seen?.searchParams.get("id")).toBe("abc123");
    expect(seen?.searchParams.get("apikey")).toBe(KEY);
  });

  it("returns bytes rather than a string", async () => {
    // An NZB is a payload to hand on untouched; decoding it to a string and
    // back would corrupt the first one that is not UTF-8.
    const bytes = new Uint8Array([0x3c, 0x6e, 0x7a, 0x62, 0xff, 0xfe]);
    const fetchImpl = vi.fn(
      async () => new Response(bytes, { status: 200 }),
    ) as unknown as typeof fetch;
    const payload = await provider(fetchImpl).fetchRelease("abc123");
    expect(Array.from(payload.bytes)).toEqual(Array.from(bytes));
  });

  it("accepts the NZB of a release far larger than a search page", async () => {
    // A 2160p Blu-ray season pack's NZB runs to tens of megabytes; the
    // search page's ceiling refused one as "implausibly large".
    const bytes = new Uint8Array(24 * 1024 * 1024).fill(0x20);
    const fetchImpl = vi.fn(
      async () => new Response(bytes, { status: 200 }),
    ) as unknown as typeof fetch;
    const payload = await provider(fetchImpl).fetchRelease("abc");
    expect(payload.bytes.byteLength).toBe(bytes.byteLength);
  });

  it("still refuses an NZB no release could need", async () => {
    const bytes = new Uint8Array(65 * 1024 * 1024);
    const fetchImpl = vi.fn(
      async () => new Response(bytes, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchRelease("abc")).rejects.toMatchObject(
      { kind: "malformed-response" },
    );
  });

  it("reads the filename the provider suggested", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(NZB, {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="Some.Release.nzb"',
          },
        }),
    ) as unknown as typeof fetch;
    expect((await provider(fetchImpl).fetchRelease("abc")).filename).toBe(
      "Some.Release.nzb",
    );
  });

  it("refuses a guid it cannot turn into an identifier, without asking", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      provider(fetchImpl).fetchRelease("../../etc/passwd"),
    ).rejects.toMatchObject({ kind: "bad-request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("raises a refusal that arrived as HTTP 200", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          '<?xml version="1.0"?><error code="100" description="Bad key"/>',
          {
            status: 200,
          },
        ),
    ) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchRelease("abc")).rejects.toMatchObject(
      {
        kind: "auth",
        providerCode: "100",
      },
    );
  });

  it.each([
    [404, "not-found"],
    [401, "auth"],
    [429, "rate-limited"],
    [503, "unavailable"],
  ])("classifies HTTP %s as %s", async (status, kind) => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status }),
    ) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchRelease("abc")).rejects.toMatchObject(
      { kind },
    );
  });

  it("treats an empty body as nothing found", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(new ArrayBuffer(0), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider(fetchImpl).fetchRelease("abc")).rejects.toMatchObject(
      {
        kind: "not-found",
      },
    );
  });

  it("never lets the key reach the error a caller sees", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      throw new Error(`ECONNREFUSED ${String(input)}`);
    }) as unknown as typeof fetch;
    const error: unknown = await provider(fetchImpl)
      .fetchRelease("abc")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(IndexerError);
    const failure = error as IndexerError;
    expect(
      JSON.stringify({ m: failure.message, s: failure.stack }),
    ).not.toContain(KEY);
  });
});
