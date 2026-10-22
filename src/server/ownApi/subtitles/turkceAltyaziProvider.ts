/**
 * TürkçeAltyazı (turkcealtyazi.org), the provider this subsystem was shaped for.
 *
 * The site has no API. A title's page lists every subtitle with its language,
 * frame rate, download count and the release groups it was timed for; each
 * subtitle's own page carries the full release names and a one-time form that
 * `POST /ind` turns into a ZIP. Pages are answered to anonymous requests most of
 * the time. When Cloudflare decides otherwise it answers with a challenge, and
 * that is reported as `needs-authentication` — a person then signs in in their
 * own browser and pastes the session (see `providerSessionVault.ts`).
 *
 * Identity comes from IMDb: the site's `/mov/<n>/` id *is* the IMDb number, so
 * a title found under the catalogue's own `tt…` id is the same title however
 * either side spells its name. Without an IMDb id the name and year must agree.
 *
 * Politeness is part of correctness here: requests are sequential, spaced,
 * and a search fetches the detail pages of only the few best-looking rows.
 */
import { parseRelease } from "../releases/parseRelease";
import {
  ArchiveUnsupportedError,
  subtitleEntries,
  toUtf8,
  type ArchiveEntry,
} from "./subtitleArchive";
import type {
  ProviderResult,
  ProviderSession,
  SubtitleCandidate,
  SubtitlePayload,
  SubtitleProvider,
  SubtitleQuery,
} from "./subtitleProvider";

export const TURKCE_ALTYAZI_ID = "turkcealtyazi";
export const TURKCE_ALTYAZI_ORIGIN = "https://turkcealtyazi.org";

/** How this server introduces itself when it has no browser session to borrow. */
export const SEYIRLIK_USER_AGENT = "Seyirlik/1.0 (+https://www.seyirlik.org)";

const FLAG_LANGUAGE: Record<string, string> = {
  flagtr: "tur",
  flagen: "eng",
};

/* ------------------------------------------------------------ page parsing */

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(+code))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface TitleSearchResult {
  imdbNumber: number;
  path: string;
  title: string;
  year: number | null;
}

/** `find.php` results: one entry per title, in the site's order. */
export function parseSearchResults(html: string): TitleSearchResult[] {
  const results = new Map<number, TitleSearchResult>();
  const link =
    /<a href="(\/mov\/(\d+)\/[a-z0-9-]+\.html)" title="([^"]*)"><span[^>]*><strong>[\s\S]*?<\/a>\s*<span[^>]*>\((\d{4})\)<\/span>/g;
  for (const match of html.matchAll(link)) {
    const imdbNumber = Number(match[2]);
    if (results.has(imdbNumber)) continue;
    results.set(imdbNumber, {
      imdbNumber,
      path: match[1]!,
      title: decodeEntities(match[3]!),
      year: Number(match[4]),
    });
  }
  return [...results.values()];
}

/** One row of a title page's subtitle list. */
export interface ListedSubtitle {
  id: string;
  path: string;
  language: string;
  /** Null for a film; for a series, the season and the episode (null for a pack). */
  season: number | null;
  episode: number | null;
  pack: boolean;
  cdCount: number | null;
  frameRate: number | null;
  downloads: number;
  releaseGroups: string[];
}

export function parseTitlePage(html: string): {
  imdbNumber: number | null;
  title: string | null;
  year: number | null;
  subtitles: ListedSubtitle[];
} {
  const heading = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  // "Türkçe adı - Original Title (1999) - TurkceAltyazi.org"
  const named = /^(.*?)\s*\((\d{4})\)\s*-\s*TurkceAltyazi/i.exec(
    decodeEntities(heading),
  );
  const names = named?.[1]?.split(" - ") ?? [];
  // Only the canonical link says which title this is; the sidebars link to others.
  const canonical = /<link rel="canonical" href="[^"]*\/mov\/(\d+)\//.exec(
    html,
  )?.[1];

  const subtitles: ListedSubtitle[] = [];
  const blocks = html.split(/<div class="altsonsez\d\b/).slice(1);
  for (const block of blocks) {
    const anchor = /href="(\/sub\/(\d+)\/[a-z0-9-]+\.html)"/.exec(block);
    const flag = /class="aldil"><span class="(\w+)"/.exec(block)?.[1];
    if (!anchor || !flag || !FLAG_LANGUAGE[flag]) continue;
    const cd = text(/class="alcd">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");
    const season = /S\s*(\d{1,3})/i.exec(cd);
    const episode = /E\s*(\d{1,4})/i.exec(cd);
    const fps = Number(
      (/class="alfps">([^<]*)</.exec(block)?.[1] ?? "").replace(",", "."),
    );
    const downloads = Number(
      (/class="alindirme">([^<]*)</.exec(block)?.[1] ?? "").replace(
        /[^0-9]/g,
        "",
      ),
    );
    const rip = text(/class="ripdiv">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "");
    subtitles.push({
      id: anchor[2]!,
      path: anchor[1]!,
      language: FLAG_LANGUAGE[flag]!,
      season: season ? Number(season[1]) : null,
      episode: episode ? Number(episode[1]) : null,
      pack: /paket/i.test(cd),
      cdCount: !season && /^\d+$/.test(cd) ? Number(cd) : null,
      frameRate: Number.isFinite(fps) && fps > 0 ? fps : null,
      downloads: Number.isFinite(downloads) ? downloads : 0,
      releaseGroups: rip
        .split("/")
        .map((group) => group.replace(/\(.*?\)/g, "").trim())
        .filter(Boolean),
    });
  }
  return {
    imdbNumber: canonical ? Number(canonical) : null,
    title: names.length ? names[names.length - 1]!.trim() : null,
    year: named?.[2] ? Number(named[2]) : null,
    subtitles,
  };
}

export interface SubtitleDetail {
  releaseNames: string[];
  hearingImpaired: boolean;
  form: { idid: string; altid: string; sidid: string } | null;
}

/** A subtitle's own page: its release names, its HI flag, and the download form. */
export function parseSubtitlePage(html: string): SubtitleDetail {
  const plain = text(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  const description =
    /Açıklama:\s*(.*?)\s*(?:Altyazı içeriğini göster|$)/.exec(plain)?.[1] ?? "";
  // Release names are dotted tokens with a year or a resolution in them.
  const releaseNames = [
    ...new Set(
      (description.match(/[A-Za-z0-9][\w.()+-]*\.[\w.()+-]+/g) ?? []).filter(
        (name) => /\.(?:19|20)\d{2}\.|\d{3,4}p|S\d{2}E?\d*/i.test(name),
      ),
    ),
  ].slice(0, 20);
  const input = (name: string) =>
    new RegExp(`name="${name}" value="([A-Za-z0-9]{1,64})"`).exec(html)?.[1];
  const idid = input("idid");
  const altid = input("altid");
  const sidid = input("sidid");
  return {
    releaseNames,
    hearingImpaired: /İşitme Engelliler İçin:\s*Evet/i.test(plain),
    form: idid && altid && sidid ? { idid, altid, sidid } : null,
  };
}

/**
 * Which episode a file in a season pack is.
 *
 * `S01E02` and `1x02` name both numbers. Packs often name only the episode —
 * `Chernobyl.2019.E02.Please.Remain.Calm…` — and then the season is the pack's.
 */
export function episodeOf(
  name: string,
  packSeason: number,
): { season: number; episode: number } | null {
  const full =
    /S(\d{1,3})[\s._-]*E(\d{1,4})/i.exec(name) ??
    /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?=[\s._-]|$)/i.exec(name);
  if (full) return { season: Number(full[1]), episode: Number(full[2]) };
  const bare = /(?:^|[\s._-])E(?:p|pisode)?[\s._-]?(\d{1,3})(?=[\s._-])/i.exec(
    name,
  );
  return bare ? { season: packSeason, episode: Number(bare[1]) } : null;
}

/**
 * The one file in a download that answers this candidate, or null.
 *
 * A film's download must hold exactly one subtitle: two are CD1 and CD2, and
 * either alone is half a film. A season pack is filtered to this episode, and
 * when it still holds several — the same episode timed for two releases — the
 * one named for the candidate's release group is taken. Byte-identical copies
 * are one file. Anything still ambiguous is refused rather than guessed.
 */
export function chooseEntry(
  entries: readonly ArchiveEntry[],
  candidate: Pick<SubtitleCandidate, "identity" | "releaseGroup">,
): ArchiveEntry | null {
  const identity = candidate.identity;
  const season = identity?.season ?? null;
  const matching =
    season === null
      ? entries
      : entries.filter((entry) => {
          const found = episodeOf(entry.name, season);
          return (
            found?.season === season && found.episode === identity!.episode
          );
        });
  const distinct = matching.filter(
    (entry, index) =>
      matching.findIndex((other) => sameBytes(other.bytes, entry.bytes)) ===
      index,
  );
  if (distinct.length === 1) return distinct[0]!;
  if (season === null || distinct.length === 0 || !candidate.releaseGroup)
    return null;
  const group = candidate.releaseGroup.toLowerCase();
  const named = distinct.filter(
    (entry) =>
      parseRelease(
        entry.name.replace(/\.(srt|vtt)$/i, ""),
      ).releaseGroup?.toLowerCase() === group,
  );
  return named.length === 1 ? named[0]! : null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/* ------------------------------------------------------------------ http */

type Answer =
  | { ok: true; response: Response; body: Uint8Array }
  | { ok: false; result: ProviderResult<never> };

/**
 * A Cloudflare challenge, as distinct from an ordinary refusal.
 *
 * Normal pages load Cloudflare's own script too, so the script's presence
 * proves nothing; a challenge is a 403/503 carrying `cf-mitigated`, or the
 * interstitial page.
 */
function isChallenge(response: Response, body: string): boolean {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  return (
    (response.status === 403 || response.status === 503) &&
    /<title>Just a moment|cf-chl-|challenge-platform\/h\//i.test(body)
  );
}

export function createTurkceAltyaziProvider(
  options: {
    fetchImpl?: typeof fetch;
    origin?: string;
    /** Detail pages fetched per search. */
    maxDetails?: number;
    /** Minimum spacing between requests. */
    spacingMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): SubtitleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? TURKCE_ALTYAZI_ORIGIN;
  const maxDetails = options.maxDetails ?? 5;
  const spacingMs = options.spacingMs ?? 800;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last = 0;

  async function request(
    path: string,
    session: ProviderSession | null,
    signal: AbortSignal | undefined,
    init: {
      method?: "GET" | "POST";
      form?: Record<string, string>;
      referer?: string;
    } = {},
  ): Promise<Answer> {
    const wait = last + spacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const headers: Record<string, string> = {
      ...(session?.revealHeaders() ?? { "user-agent": SEYIRLIK_USER_AGENT }),
      accept: "text/html,application/xhtml+xml,application/zip,*/*",
      "accept-language": "tr,en;q=0.8",
      ...(init.referer ? { referer: `${origin}${init.referer}` } : {}),
      ...(init.form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    };
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.form
          ? { body: new URLSearchParams(init.form).toString() }
          : {}),
        redirect: "follow",
        ...(signal ? { signal } : {}),
      });
    } catch {
      return {
        ok: false,
        result: {
          outcome: "error",
          reason: "TürkçeAltyazı could not be reached.",
          retryable: true,
        },
      };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const head = new TextDecoder("utf-8").decode(body.subarray(0, 16_384));
    if (isChallenge(response, head))
      return {
        ok: false,
        result: {
          outcome: "needs-authentication",
          reason: "TürkçeAltyazı answered with a Cloudflare check.",
          authenticateAt: `${origin}/`,
        },
      };
    if (response.status === 429)
      return {
        ok: false,
        result: {
          outcome: "rate-limited",
          retryAfterMs:
            Number(response.headers.get("retry-after") ?? "") * 1000 || null,
        },
      };
    if (response.status === 404)
      return { ok: false, result: { outcome: "empty" } };
    if (!response.ok)
      return {
        ok: false,
        result: {
          outcome: "error",
          reason: `TürkçeAltyazı answered ${response.status}.`,
          retryable: response.status >= 500,
        },
      };
    return { ok: true, response, body };
  }

  const html = (body: Uint8Array) => new TextDecoder("utf-8").decode(body);

  /** The title's page, found by IMDb id when there is one, by name and year otherwise. */
  async function locate(
    query: SubtitleQuery,
    session: ProviderSession | null,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; page: ReturnType<typeof parseTitlePage>; byImdb: boolean }
    | { ok: false; result: ProviderResult<never> }
  > {
    const imdbNumber = query.imdbId ? Number(query.imdbId.slice(2)) : null;
    const term = query.imdbId ?? query.title;
    const found = await request(
      `/find.php?${new URLSearchParams({ cat: "sub", find: term })}`,
      session,
      signal,
    );
    if (!found.ok) return found;
    let page = parseTitlePage(html(found.body));
    if (page.imdbNumber === null) {
      // A results list rather than a title: choose by IMDb number, else name and year.
      const results = parseSearchResults(html(found.body));
      const chosen =
        (imdbNumber !== null &&
          results.find((result) => result.imdbNumber === imdbNumber)) ||
        (imdbNumber === null &&
          results.find(
            (result) =>
              titleKey(result.title) === titleKey(query.title) &&
              result.year === query.year,
          ));
      if (!chosen) return { ok: false, result: { outcome: "empty" } };
      const opened = await request(chosen.path, session, signal);
      if (!opened.ok) return opened;
      page = parseTitlePage(html(opened.body));
      page.imdbNumber ??= chosen.imdbNumber;
    }
    if (imdbNumber !== null && page.imdbNumber !== imdbNumber)
      return { ok: false, result: { outcome: "empty" } };
    return { ok: true, page, byImdb: imdbNumber !== null };
  }

  const provider: SubtitleProvider = {
    id: TURKCE_ALTYAZI_ID,
    label: "TürkçeAltyazı",
    requiresSession: true,
    rank: 1,
    languages: ["tur", "eng"],

    async search(query, session, signal) {
      const located = await locate(query, session, signal);
      if (!located.ok) return located.result;
      const { page, byImdb } = located;
      /*
       * Identity is claimed only on evidence: the IMDb number agreed, or the
       * page's own title and year did. The scorer's gate then compares what
       * is claimed here against the catalogue.
       */
      const identified =
        byImdb ||
        (page.title !== null &&
          titleKey(page.title) === titleKey(query.title) &&
          page.year === query.year);
      if (!identified) return { outcome: "empty" };

      const wanted = parseRelease(query.releaseTitle ?? "");
      const rows = page.subtitles.filter((row) => {
        if (row.language !== query.language) return false;
        if (query.season === null)
          return (
            row.season === null && row.cdCount !== null && row.cdCount <= 1
          );
        return (
          row.season === query.season &&
          (row.pack || row.episode === query.episode)
        );
      });
      if (rows.length === 0) return { outcome: "empty" };

      // Which rows are worth a detail page: likeliest to fit first.
      const promise = (row: ListedSubtitle) =>
        (wanted.releaseGroup &&
        row.releaseGroups.some(
          (group) => group.toLowerCase() === wanted.releaseGroup!.toLowerCase(),
        )
          ? 4
          : 0) +
        (query.frameRate &&
        row.frameRate &&
        Math.abs(query.frameRate - row.frameRate) < 0.01
          ? 2
          : 0) +
        (row.episode !== null ? 1 : 0);
      const ordered = [...rows].sort(
        (a, b) => promise(b) - promise(a) || b.downloads - a.downloads,
      );

      const candidates: SubtitleCandidate[] = [];
      for (const [index, row] of ordered.entries()) {
        let detail: SubtitleDetail | null = null;
        if (index < maxDetails) {
          const opened = await request(row.path, session, signal);
          if (!opened.ok) {
            if (opened.result.outcome === "needs-authentication")
              return opened.result;
          } else detail = parseSubtitlePage(html(opened.body));
        }
        // The release this subtitle was made for that is closest to ours.
        const names = detail?.releaseNames ?? [];
        const releaseTitle =
          names.find(
            (name) =>
              wanted.releaseGroup &&
              parseRelease(name).releaseGroup?.toLowerCase() ===
                wanted.releaseGroup.toLowerCase(),
          ) ??
          names[0] ??
          null;
        const facts = releaseTitle ? parseRelease(releaseTitle) : null;
        const group =
          row.releaseGroups.find(
            (name) =>
              wanted.releaseGroup &&
              name.toLowerCase() === wanted.releaseGroup.toLowerCase(),
          ) ??
          facts?.releaseGroup ??
          row.releaseGroups[0] ??
          null;
        candidates.push({
          providerId: TURKCE_ALTYAZI_ID,
          // `<id>.<slug>`: the id names the subtitle, the slug is its page.
          candidateId: `${row.id}.${row.path
            .split("/")
            .pop()!
            .replace(/\.html$/, "")}`,
          language: row.language,
          format: null,
          forced: false,
          hearingImpaired: detail?.hearingImpaired ?? false,
          releaseTitle,
          releaseGroup: group,
          source: facts && facts.source !== "unknown" ? facts.source : null,
          resolution:
            facts && facts.resolution !== "unknown" ? facts.resolution : null,
          hashMatched: false,
          providerRating: row.downloads,
          frameRate: row.frameRate,
          identity: {
            title: query.title,
            year: query.year,
            season: query.season,
            episode: query.episode,
          },
        });
      }
      return { outcome: "ok", value: candidates };
    },

    async download(candidate, session, signal) {
      const match = /^(\d{1,9})\.([a-z0-9-]{1,200})$/.exec(
        candidate.candidateId,
      );
      if (!match)
        return {
          outcome: "error",
          reason: "The candidate id is not one this provider issued.",
          retryable: false,
        };
      const path = `/sub/${match[1]}/${match[2]}.html`;
      const page = await request(path, session, signal);
      if (!page.ok) return page.result;
      const detail = parseSubtitlePage(html(page.body));
      if (!detail.form)
        return {
          outcome: "needs-authentication",
          reason: "TürkçeAltyazı did not offer the download; sign in again.",
          authenticateAt: `${origin}/`,
        };
      const file = await request("/ind", session, signal, {
        method: "POST",
        form: detail.form,
        referer: path,
      });
      if (!file.ok) return file.result;
      const type = file.response.headers.get("content-type") ?? "";
      /*
       * A bare sentence rather than a page is the site refusing this one file
       * ("İlginç hatalar oluştu!", 25 bytes, for every single-episode Sopranos
       * upload tried anonymously while its season packs downloaded fine). That
       * is this candidate failing, not the session: calling it authentication
       * would park a search the next candidate can answer.
       */
      if (/text\/html/i.test(type) && file.body.length < 512)
        return {
          outcome: "error",
          reason: "TürkçeAltyazı could not serve this file.",
          retryable: false,
        };
      if (/text\/html/i.test(type))
        return {
          outcome: "needs-authentication",
          reason:
            "TürkçeAltyazı answered the download with a page; sign in again.",
          authenticateAt: `${origin}/`,
        };

      let entries;
      try {
        entries = subtitleEntries(file.body, `${match[1]}.srt`);
      } catch (error) {
        return {
          outcome: "error",
          reason:
            error instanceof ArchiveUnsupportedError
              ? error.message
              : "The download could not be read.",
          retryable: false,
        };
      }
      const entry = chooseEntry(entries, candidate);
      // A film split over two files, or a pack without this episode, is not an answer.
      if (!entry) return { outcome: "empty" };
      const payload: SubtitlePayload = {
        bytes: toUtf8(entry.bytes, candidate.language),
        declaredFormat: null,
        declaredFileName: entry.name,
      };
      return { outcome: "ok", value: payload };
    },
  };
  return provider;
}
