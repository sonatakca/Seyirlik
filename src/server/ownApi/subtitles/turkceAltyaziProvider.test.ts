import { describe, expect, it } from "vitest";
import { createProviderSession } from "./subtitleProvider";
import type { SubtitleQuery } from "./subtitleProvider";
import {
  chooseEntry,
  createTurkceAltyaziProvider,
  episodeOf,
  parseSearchResults,
  parseSubtitlePage,
  parseTitlePage,
  SEYIRLIK_USER_AGENT,
} from "./turkceAltyaziProvider";
import { buildZip } from "./zipFixture";

/* Synthetic pages in the shape the site serves; the content is invented. */

function row(input: {
  id: string;
  slug: string;
  flag?: string;
  cd: string;
  fps?: string;
  downloads?: string;
  rip?: string;
}) {
  return `<div><div class="altsonsez2 row-class1"><div class="alisim"><div class="fl">
    <a itemprop="url" class="underline" id="${input.id}" href="/sub/${input.id}/${input.slug}.html"><strong>X</strong></a></div></div>
    <div class="aldil"><span class="${input.flag ?? "flagtr"}"></span></div>
    <div class="alcd"> ${input.cd} </div>
    <div class="alfps">${input.fps ?? "23.976"}</div>
    <div class="alindirme">${input.downloads ?? "1,000"}</div>
    <div class="ta-container"><div class="ripdiv"><span class="rps r1"></span> ${input.rip ?? "GRP"} </div>
    <div class="datediv">1 yıl önce</div></div></div></div>`;
}

function titlePage(input: { imdb: string; heading: string; rows: string[] }) {
  return `<html><head><title>${input.heading} - TurkceAltyazi.org</title>
    <link rel="canonical" href="https://turkcealtyazi.org/mov/${input.imdb}/film.html" /></head>
    <body><a href="/mov/9999999/unrelated.html">sidebar</a>
    <div id="altyazilar">${input.rows.join("\n")}</div></body></html>`;
}

function subPage(input: { description: string; hi?: boolean; form?: boolean }) {
  return `<html><body><div>Altyazı Dili: Türkçe Fps: 23.976 fps
    İşitme Engelliler İçin: ${input.hi ? "Evet" : "Hayır"} Açıklama: ${input.description}
    Altyazı içeriğini göster</div>
    ${
      input.form === false
        ? ""
        : `<form method="post" action="/ind"><input type="hidden" name="idid" value="11" />
    <input type="hidden" name="altid" value="22" /><input type="hidden" name="sidid" value="abc123" /></form>`
    }</body></html>`;
}

const FILM_PAGE = titlePage({
  imdb: "0137523",
  heading: "Dövüş Kulübü - Fight Club (1999)",
  rows: [
    row({
      id: "100",
      slug: "fight-club",
      cd: "1",
      rip: "YIFY",
      downloads: "40,000",
    }),
    row({
      id: "101",
      slug: "fight-club",
      cd: "1",
      rip: "SPARKS / ETRG",
      downloads: "900",
    }),
    row({ id: "102", slug: "fight-club", cd: "2", rip: "SPARKS" }),
    row({
      id: "103",
      slug: "fight-club",
      cd: "1",
      flag: "flagen",
      rip: "SPARKS",
    }),
    row({ id: "104", slug: "fight-club", cd: "1", fps: "25", rip: "PAL" }),
  ],
});

const SERIES_PAGE = titlePage({
  imdb: "7366338",
  heading: "Chernobyl (2019)",
  rows: [
    row({
      id: "200",
      slug: "chernobyl",
      cd: "S<b>01</b> <b>Paket</b>",
      rip: "DON",
    }),
    row({
      id: "201",
      slug: "chernobyl",
      cd: "S<b>01</b> | E<b>02</b>",
      rip: "NTb",
    }),
    row({
      id: "202",
      slug: "chernobyl",
      cd: "S<b>01</b> | E<b>03</b>",
      rip: "NTb",
    }),
  ],
});

const query = (overrides: Partial<SubtitleQuery> = {}): SubtitleQuery => ({
  title: "Fight Club",
  year: 1999,
  season: null,
  episode: null,
  language: "tur",
  wantForced: false,
  releaseTitle: "Fight.Club.1999.1080p.BluRay.x264-SPARKS",
  releaseGroup: null,
  source: null,
  resolution: null,
  videoHash: null,
  durationSeconds: null,
  imdbId: "tt0137523",
  frameRate: 23.976,
  ...overrides,
});

type Handler = (url: URL, init: RequestInit) => Response;

function fakeSite(handler: Handler) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const provider = createTurkceAltyaziProvider({
    fetchImpl,
    spacingMs: 0,
    sleep: async () => {},
  });
  return { provider, requests };
}

const html = (body: string, status = 200, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });

describe("TürkçeAltyazı page parsing", () => {
  it("reads a title's identity from its canonical link, not its sidebar", () => {
    const page = parseTitlePage(FILM_PAGE);
    expect(page.imdbNumber).toBe(137523);
    expect(page.title).toBe("Fight Club");
    expect(page.year).toBe(1999);
    expect(page.subtitles.map((subtitle) => subtitle.id)).toEqual([
      "100",
      "101",
      "102",
      "103",
      "104",
    ]);
    expect(page.subtitles[1]).toMatchObject({
      language: "tur",
      cdCount: 1,
      frameRate: 23.976,
      downloads: 900,
      releaseGroups: ["SPARKS", "ETRG"],
    });
  });

  it("reads season packs and single episodes", () => {
    const [pack, episode] = parseTitlePage(SERIES_PAGE).subtitles;
    expect(pack).toMatchObject({ season: 1, episode: null, pack: true });
    expect(episode).toMatchObject({ season: 1, episode: 2, pack: false });
  });

  it("reads a results list", () => {
    const results = parseSearchResults(
      `<a href="/mov/441773/kung-fu-panda.html" title="Kung Fu Panda"><span style="x"><strong>Kung Fu Panda</strong></span></a> <span style="y">(2008)</span> Film`,
    );
    expect(results).toEqual([
      {
        imdbNumber: 441773,
        path: "/mov/441773/kung-fu-panda.html",
        title: "Kung Fu Panda",
        year: 2008,
      },
    ]);
  });

  it("reads release names, the HI flag and the download form", () => {
    const detail = parseSubtitlePage(
      subPage({
        description:
          "Fight.Club.1999.1080p.BluRay.x264-SPARKS Fight.Club.1999.720p.BluRay-ETRG teşekkürler",
        hi: true,
      }),
    );
    expect(detail.releaseNames).toEqual([
      "Fight.Club.1999.1080p.BluRay.x264-SPARKS",
      "Fight.Club.1999.720p.BluRay-ETRG",
    ]);
    expect(detail.hearingImpaired).toBe(true);
    expect(detail.form).toEqual({ idid: "11", altid: "22", sidid: "abc123" });
  });

  it("finds an episode in a pack however the file names it", () => {
    expect(episodeOf("Show.S02E05.1080p.srt", 1)).toEqual({
      season: 2,
      episode: 5,
    });
    expect(episodeOf("Show 3x07.srt", 1)).toEqual({ season: 3, episode: 7 });
    expect(episodeOf("Show.2019.E04.Name.srt", 1)).toEqual({
      season: 1,
      episode: 4,
    });
    expect(episodeOf("Show.Extras.srt", 1)).toBeNull();
  });
});

describe("choosing a file out of a download", () => {
  const file = (name: string, text = name) => ({
    name,
    bytes: new TextEncoder().encode(text),
  });
  const episode = (episode: number, releaseGroup: string | null = null) => ({
    releaseGroup,
    identity: { title: "The Sopranos", year: 1999, season: 1, episode },
  });
  // The names of a real thirteen-file pack (TürkçeAltyazı 375975).
  const pack = Array.from({ length: 13 }, (_, i) =>
    file(
      `The.Sopranos.S01E${String(i + 1).padStart(2, "0")}.720p.BluRay.x264-UNIT3D.srt`,
    ),
  );

  it("takes this episode out of a season pack", () => {
    expect(chooseEntry(pack, episode(12))?.name).toBe(
      "The.Sopranos.S01E12.720p.BluRay.x264-UNIT3D.srt",
    );
  });

  it("refuses a pack that does not hold this episode", () => {
    expect(chooseEntry(pack, episode(14))).toBeNull();
  });

  it("takes the release group's copy when a pack times one episode twice", () => {
    const twice = [
      file("Show.S01E02.720p.BluRay.x264-DON.srt"),
      file("Show.S01E02.INTERNAL.BDRip.x264-ARCHiViST.srt"),
    ];
    expect(chooseEntry(twice, episode(2, "archivist"))?.name).toBe(
      "Show.S01E02.INTERNAL.BDRip.x264-ARCHiViST.srt",
    );
    expect(chooseEntry(twice, episode(2, "NTb"))).toBeNull();
    expect(chooseEntry(twice, episode(2))).toBeNull();
  });

  it("treats byte-identical copies as one file", () => {
    const copies = [
      file("Show.S01E02.srt", "same"),
      file("Show/S01/Show.S01E02.srt", "same"),
    ];
    expect(chooseEntry(copies, episode(2))?.name).toBe("Show.S01E02.srt");
  });

  it("never takes half of a film split over two files", () => {
    const film = {
      releaseGroup: "SPARKS",
      identity: { title: "Film", year: 1999, season: null, episode: null },
    };
    expect(
      chooseEntry(
        [file("Film.CD1-SPARKS.srt"), file("Film.CD2-SPARKS.srt")],
        film,
      ),
    ).toBeNull();
    expect(chooseEntry([file("Film-SPARKS.srt")], film)?.name).toBe(
      "Film-SPARKS.srt",
    );
  });
});

describe("TürkçeAltyazı search", () => {
  it("finds a film by IMDb id and offers only same-language single-file subtitles", async () => {
    const { provider, requests } = fakeSite((url) => {
      if (url.pathname === "/find.php") return html(FILM_PAGE);
      return html(
        subPage({ description: "Fight.Club.1999.1080p.BluRay.x264-SPARKS" }),
      );
    });
    const result = await provider.search(query(), null);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(requests[0]!.url.searchParams.get("find")).toBe("tt0137523");
    // An honest user agent when there is no browser session to borrow.
    expect(
      (requests[0]!.init.headers as Record<string, string>)["user-agent"],
    ).toBe(SEYIRLIK_USER_AGENT);
    expect(result.value.map((candidate) => candidate.candidateId)).toEqual([
      // The row naming our release group is looked at first…
      "101.fight-club",
      "100.fight-club",
      "104.fight-club",
    ]);
    const best = result.value[0]!;
    expect(best).toMatchObject({
      releaseGroup: "SPARKS",
      releaseTitle: "Fight.Club.1999.1080p.BluRay.x264-SPARKS",
      frameRate: 23.976,
      providerRating: 900,
      identity: {
        title: "Fight Club",
        year: 1999,
        season: null,
        episode: null,
      },
    });
  });

  it("does not claim a title whose IMDb number disagrees", async () => {
    const { provider } = fakeSite(() => html(FILM_PAGE));
    expect(
      (await provider.search(query({ imdbId: "tt0000001" }), null)).outcome,
    ).toBe("empty");
  });

  it("chooses from a results list by name and year when there is no IMDb id", async () => {
    const { provider, requests } = fakeSite((url) => {
      if (url.pathname === "/find.php")
        return html(
          `<a href="/mov/137523/fight-club.html" title="Fight Club"><span><strong>Fight Club</strong></span></a> <span>(1999)</span>
           <a href="/mov/1/fight-club-2.html" title="Fight Club"><span><strong>Fight Club</strong></span></a> <span>(2004)</span>`,
        );
      if (url.pathname.startsWith("/mov/")) return html(FILM_PAGE);
      return html(subPage({ description: "" }));
    });
    const result = await provider.search(query({ imdbId: null }), null);
    expect(result.outcome).toBe("ok");
    expect(requests[1]!.url.pathname).toBe("/mov/137523/fight-club.html");
  });

  it("offers a season pack and the exact episode, not other episodes", async () => {
    const { provider } = fakeSite((url) =>
      url.pathname === "/find.php"
        ? html(SERIES_PAGE)
        : html(subPage({ description: "" })),
    );
    const result = await provider.search(
      query({
        title: "Chernobyl",
        year: 2019,
        season: 1,
        episode: 2,
        imdbId: "tt7366338",
        releaseTitle: null,
      }),
      null,
    );
    expect(
      result.outcome === "ok" && result.value.map((c) => c.candidateId),
    ).toEqual(["201.chernobyl", "200.chernobyl"]);
  });

  it("reports a Cloudflare challenge as needing a person, not as an error", async () => {
    const { provider } = fakeSite(() =>
      html("<title>Just a moment...</title>", 403, {
        "cf-mitigated": "challenge",
      }),
    );
    const result = await provider.search(query(), null);
    expect(result.outcome).toBe("needs-authentication");
  });

  it("sends a pasted session's cookie and user agent together", async () => {
    const { provider, requests } = fakeSite(() => html(FILM_PAGE));
    await provider.search(
      query(),
      createProviderSession({
        providerId: "turkcealtyazi",
        cookie: "cf_clearance=abc; phpbb=1",
        userAgent: "Mozilla/5.0 Test",
      }),
    );
    expect(requests[0]!.init.headers).toMatchObject({
      cookie: "cf_clearance=abc; phpbb=1",
      "user-agent": "Mozilla/5.0 Test",
    });
  });
});

describe("TürkçeAltyazı download", () => {
  const candidate = {
    providerId: "turkcealtyazi",
    candidateId: "200.chernobyl",
    language: "tur",
    format: null,
    forced: false,
    hearingImpaired: false,
    releaseTitle: null,
    releaseGroup: null,
    source: null,
    resolution: null,
    hashMatched: false,
    providerRating: null,
    identity: { title: "Chernobyl", year: 2019, season: 1, episode: 2 },
  };
  const cue = (text: string) =>
    Buffer.from(`1\r\n00:00:01,000 --> 00:00:02,000\r\n${text}\r\n`, "latin1");

  it("posts the page's form and takes this episode out of the pack, as UTF-8", async () => {
    const zip = buildZip([
      { name: "Chernobyl.2019.E01.srt", content: cue("one") },
      // "Işık" in Windows-1254.
      {
        name: "Chernobyl.2019.E02.srt",
        content: Buffer.concat([
          Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\n"),
          Buffer.from([0x49, 0xfe, 0xfd, 0x6b]),
          Buffer.from("\r\n"),
        ]),
      },
    ]);
    const { provider, requests } = fakeSite((url) =>
      url.pathname === "/ind"
        ? new Response(new Uint8Array(zip), {
            headers: { "content-type": "application/zip" },
          })
        : html(subPage({ description: "" })),
    );
    const result = await provider.download(candidate, null);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(requests[0]!.url.pathname).toBe("/sub/200/chernobyl.html");
    expect(requests[1]!.init.method).toBe("POST");
    expect(String(requests[1]!.init.body)).toBe(
      "idid=11&altid=22&sidid=abc123",
    );
    expect(result.value.declaredFileName).toBe("Chernobyl.2019.E02.srt");
    expect(new TextDecoder().decode(result.value.bytes)).toContain("Işık");
  });

  it("answers empty when the pack does not hold this episode", async () => {
    const zip = buildZip([
      { name: "Chernobyl.2019.E01.srt", content: cue("one") },
    ]);
    const { provider } = fakeSite((url) =>
      url.pathname === "/ind"
        ? new Response(new Uint8Array(zip), {
            headers: { "content-type": "application/zip" },
          })
        : html(subPage({ description: "" })),
    );
    expect((await provider.download(candidate, null)).outcome).toBe("empty");
  });

  it("asks for a sign-in when the page offers no download form", async () => {
    const { provider } = fakeSite(() =>
      html(subPage({ description: "", form: false })),
    );
    expect((await provider.download(candidate, null)).outcome).toBe(
      "needs-authentication",
    );
  });

  it("treats a one-line refusal of the file as this candidate failing, not the session", async () => {
    const { provider } = fakeSite((url) =>
      url.pathname === "/ind"
        ? html("İlginç hatalar oluştu!")
        : html(subPage({ description: "" })),
    );
    expect(await provider.download(candidate, null)).toMatchObject({
      outcome: "error",
      retryable: false,
    });
  });

  it("refuses a candidate id it did not issue", async () => {
    const { provider, requests } = fakeSite(() => html(""));
    const result = await provider.download(
      { ...candidate, candidateId: "../../admin" },
      null,
    );
    expect(result.outcome).toBe("error");
    expect(requests).toHaveLength(0);
  });
});
