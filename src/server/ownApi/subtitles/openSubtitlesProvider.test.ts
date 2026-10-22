// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createOpenSubtitlesProvider,
  OPENSUBTITLES_API,
  searchParameters,
  type OpenSubtitlesAccount,
  type OpenSubtitlesCredentials,
} from "./openSubtitlesProvider";
import type { SubtitleCandidate, SubtitleQuery } from "./subtitleProvider";

const query: SubtitleQuery = {
  title: "House of the Dragon",
  year: 2022,
  season: 1,
  episode: 8,
  language: "tur",
  wantForced: false,
  releaseTitle: null,
  releaseGroup: null,
  source: null,
  resolution: null,
  videoHash: null,
  durationSeconds: null,
  imdbId: "tt11198330",
};

const candidate: SubtitleCandidate = {
  providerId: "opensubtitles",
  candidateId: "4242",
  language: "tr",
  format: null,
  forced: false,
  hearingImpaired: false,
  releaseTitle: null,
  releaseGroup: null,
  source: null,
  resolution: null,
  hashMatched: false,
  providerRating: null,
};

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nMerhaba\n";

function account(slot: number, username = `user${slot}`): OpenSubtitlesAccount {
  return {
    slot,
    version: `v${slot}`,
    username,
    revealPassword: () => `secret-${slot}`,
    toJSON: () => "[withheld]",
    toString: () => "[withheld]",
  };
}

function credentials(
  accounts: OpenSubtitlesAccount[] = [account(1), account(2)],
  apiKey: string | null = "key-123456",
) {
  return {
    apiKey: vi.fn(async () => apiKey),
    accounts: vi.fn(async () => accounts),
    reject: vi.fn<OpenSubtitlesCredentials["reject"]>(async () => {}),
    noteQuota: vi.fn<OpenSubtitlesCredentials["noteQuota"]>(async () => {}),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A fake API: `login` answers per username, `download` per bearer token, and
 * the file link answers the subtitle.
 */
function api(options: {
  login?: (username: string) => Response;
  download?: (token: string, call: number) => Response;
  search?: () => Response;
}) {
  const calls: {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
  }[] = [];
  let downloads = 0;
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, method: init?.method ?? "GET", headers, body });
      if (href === `${OPENSUBTITLES_API}/login`) {
        const username = (body as { username: string }).username;
        return (
          options.login?.(username) ??
          json(200, {
            token: `token-${username}`,
            base_url: "api.opensubtitles.com",
            user: { allowed_downloads: 20 },
          })
        );
      }
      if (href === `${OPENSUBTITLES_API}/download`) {
        const token = headers.get("authorization")!.replace("Bearer ", "");
        return (
          options.download?.(token, ++downloads) ??
          json(200, {
            link: "https://www.opensubtitles.com/download/abc/subfile/x.srt",
            remaining: 10,
            reset_time_utc: "2026-10-23T00:00:00.000Z",
          })
        );
      }
      if (href.startsWith(`${OPENSUBTITLES_API}/subtitles?`))
        return options.search?.() ?? json(200, { data: [] });
      if (href.startsWith("https://www.opensubtitles.com/download/"))
        return new Response(SRT, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function provider(
  creds: ReturnType<typeof credentials>,
  fake: ReturnType<typeof api>,
) {
  return createOpenSubtitlesProvider({
    credentials: creds,
    fetchImpl: fake.fetchImpl,
    spacingMs: 0,
    now: () => NOW,
  });
}

describe("OpenSubtitles search", () => {
  it("asks for the series' episode with sorted, lower-case parameters", () => {
    expect(searchParameters(query, "tr")).toBe(
      "episode_number=8&languages=tr&parent_imdb_id=11198330&season_number=1",
    );
    expect(
      searchParameters(
        { ...query, season: null, episode: null, imdbId: null, title: "Up" },
        "tr",
      ),
    ).toBe("languages=tr&query=up&year=2022");
  });

  it("claims identity only for listings of this episode, and drops machine translations", async () => {
    const fake = api({
      search: () =>
        json(200, {
          data: [
            {
              attributes: {
                language: "tr",
                download_count: 900,
                fps: 23.976,
                release: "House.of.the.Dragon.S01E08.1080p.WEB.H264-CAKES",
                files: [{ file_id: 11 }],
                feature_details: {
                  parent_imdb_id: 11198330,
                  season_number: 1,
                  episode_number: 8,
                },
              },
            },
            {
              attributes: {
                language: "tr",
                files: [{ file_id: 12 }],
                feature_details: {
                  parent_imdb_id: 11198330,
                  season_number: 1,
                  episode_number: 9,
                },
              },
            },
            {
              attributes: {
                language: "tr",
                machine_translated: true,
                files: [{ file_id: 13 }],
                feature_details: {
                  parent_imdb_id: 11198330,
                  season_number: 1,
                  episode_number: 8,
                },
              },
            },
            {
              attributes: {
                language: "tr",
                files: [{ file_id: 14 }, { file_id: 15 }],
                feature_details: {
                  parent_imdb_id: 11198330,
                  season_number: 1,
                  episode_number: 8,
                },
              },
            },
          ],
        }),
    });
    const result = await provider(credentials(), fake).search(query, null);
    expect(result.outcome).toBe("ok");
    const found = result.outcome === "ok" ? result.value : [];
    expect(found.map((c) => c.candidateId)).toEqual(["11", "12"]);
    expect(found[0]).toMatchObject({
      providerRating: 900,
      frameRate: 23.976,
      releaseGroup: "CAKES",
      identity: { title: "House of the Dragon", season: 1, episode: 8 },
    });
    // Episode 9 is listed, but nothing claims it is episode 8.
    expect(found[1]!.identity).toBeUndefined();
    expect(fake.calls[0]!.headers.get("api-key")).toBe("key-123456");
    expect(fake.calls[0]!.headers.get("user-agent")).toBe("Seyirlik v1.0");
  });

  it("waits for a person when there is no API key or no account", async () => {
    const fake = api({});
    expect(
      await provider(credentials(undefined, null), fake).search(query, null),
    ).toMatchObject({ outcome: "needs-authentication" });
    expect(
      await provider(credentials([]), fake).search(query, null),
    ).toMatchObject({ outcome: "needs-authentication" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("OpenSubtitles downloads across accounts", () => {
  it("downloads with the first account", async () => {
    const creds = credentials();
    const fake = api({});
    const result = await provider(creds, fake).download(candidate, null);
    expect(result).toMatchObject({ outcome: "ok" });
    if (result.outcome === "ok")
      expect(new TextDecoder().decode(result.value.bytes)).toBe(SRT);
    const download = fake.calls.find((c) => c.url.endsWith("/download"))!;
    expect(download.headers.get("authorization")).toBe("Bearer token-user1");
    expect(download.body).toEqual({ file_id: 4242, sub_format: "srt" });
    // The password goes to the login and nowhere else.
    expect(
      fake.calls.filter((c) => JSON.stringify(c.body ?? "").includes("secret")),
    ).toHaveLength(1);
  });

  it("moves to the second account when the first has used its day, and stays there", async () => {
    const creds = credentials();
    const fake = api({
      download: (token) =>
        token === "token-user1"
          ? json(407, { reset_time_utc: "2026-10-23T03:00:00.000Z" })
          : json(200, {
              link: "https://www.opensubtitles.com/download/abc/subfile/x.srt",
              remaining: 5,
            }),
    });
    const os = provider(creds, fake);
    expect(await os.download(candidate, null)).toMatchObject({ outcome: "ok" });
    expect(creds.noteQuota).toHaveBeenCalledWith(
      1,
      new Date("2026-10-23T03:00:00.000Z"),
    );
    const before = fake.calls.length;
    expect(await os.download(candidate, null)).toMatchObject({ outcome: "ok" });
    // The spent account is not asked again before it renews.
    const again = fake.calls
      .slice(before)
      .filter((c) => c.url.endsWith("/download"));
    expect(again.map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer token-user2",
    ]);
  });

  it("treats the last download of the day as spending the account", async () => {
    const creds = credentials();
    const fake = api({
      download: (token) =>
        json(200, {
          link: "https://www.opensubtitles.com/download/abc/subfile/x.srt",
          remaining: token === "token-user1" ? 0 : 3,
          reset_time_utc: "2026-10-23T01:00:00.000Z",
        }),
    });
    const os = provider(creds, fake);
    await os.download(candidate, null);
    const before = fake.calls.length;
    await os.download(candidate, null);
    expect(
      fake.calls
        .slice(before)
        .filter((c) => c.url.endsWith("/download"))
        .map((c) => c.headers.get("authorization")),
    ).toEqual(["Bearer token-user2"]);
  });

  it("answers rate-limited until the first renewal once every account is spent", async () => {
    const fake = api({
      download: (token) =>
        json(407, {
          reset_time_utc:
            token === "token-user1"
              ? "2026-10-23T03:00:00.000Z"
              : "2026-10-22T18:00:00.000Z",
        }),
    });
    expect(
      await provider(credentials(), fake).download(candidate, null),
    ).toEqual({
      outcome: "rate-limited",
      retryAfterMs: 6 * 60 * 60 * 1000,
    });
  });

  it("drops a refused password and uses the next account", async () => {
    const creds = credentials();
    const fake = api({
      login: (username) =>
        username === "user1"
          ? json(401, { message: "invalid" })
          : json(200, { token: "token-user2" }),
    });
    expect(await provider(creds, fake).download(candidate, null)).toMatchObject(
      {
        outcome: "ok",
      },
    );
    expect(creds.reject).toHaveBeenCalledWith(1, "v1", expect.any(String));
  });

  it("signs in again once when a token has expired", async () => {
    const fake = api({
      download: (_token, call) =>
        call === 1
          ? json(406, {})
          : json(200, {
              link: "https://www.opensubtitles.com/download/abc/subfile/x.srt",
              remaining: 4,
            }),
    });
    expect(
      await provider(credentials(), fake).download(candidate, null),
    ).toMatchObject({
      outcome: "ok",
    });
    expect(fake.calls.filter((c) => c.url.endsWith("/login"))).toHaveLength(2);
  });

  it("refuses a download link that is not the provider's", async () => {
    const fake = api({
      download: () =>
        json(200, { link: "https://evil.example/x.srt", remaining: 4 }),
    });
    const result = await provider(credentials([account(1)]), fake).download(
      candidate,
      null,
    );
    expect(result).toMatchObject({ outcome: "error" });
    expect(fake.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  it("waits for a person when no account is signed in", async () => {
    expect(
      await provider(credentials([]), api({})).download(candidate, null),
    ).toMatchObject({ outcome: "needs-authentication" });
  });

  it("never prints a password", () => {
    expect(JSON.stringify({ a: account(1) })).not.toContain("secret");
    expect(`${account(1)}`).not.toContain("secret");
  });
});
