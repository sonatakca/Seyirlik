/**
 * OpenSubtitles (opensubtitles.com), asked when TürkçeAltyazı has nothing.
 *
 * It ranks below TürkçeAltyazı, and the pipeline asks providers one at a time
 * in rank order, so it is reached only after TürkçeAltyazı had nothing it could
 * install — no listing, a challenge, or an outage.
 *
 * The REST API wants an API key on every request (a person creates one on the
 * site's consumers page) and a signed-in account for downloads, which are
 * counted per account per day. Searching is free; downloading is the scarce
 * thing. So a search costs one request, the pipeline is told to measure fewer
 * downloads here than elsewhere (`downloadsPerSearch`), and the accounts are
 * spent in slot order: when one has used its day, the next one downloads.
 *
 * What the API answers, as other clients have found it: 401 is a refused
 * username or password, 406 a token that has expired, 407 a day's downloads
 * used up, 429 too many requests too quickly. A successful download says how
 * many remain and when the count renews.
 */
import { parseRelease } from "../releases/parseRelease";
import { toUtf8 } from "./subtitleArchive";
import type {
  ProviderResult,
  SubtitleCandidate,
  SubtitlePayload,
  SubtitleProvider,
  SubtitleQuery,
} from "./subtitleProvider";

export const OPENSUBTITLES_ID = "opensubtitles";
export const OPENSUBTITLES_API = "https://api.opensubtitles.com/api/v1";
/** Where a person creates the API key. */
export const OPENSUBTITLES_CONSUMERS =
  "https://www.opensubtitles.com/en/consumers";
/** The API refuses requests that do not name the application and its version. */
export const OPENSUBTITLES_USER_AGENT = "Seyirlik v1.0";

/** A signed-in account, holding a password that must never be logged. */
export interface OpenSubtitlesAccount {
  readonly slot: number;
  /** Changes whenever the stored sign-in does; a cached token is good for one. */
  readonly version: string;
  readonly username: string;
  revealPassword(): string;
  toJSON(): string;
  toString(): string;
}

export interface OpenSubtitlesCredentials {
  apiKey(): Promise<string | null>;
  /** Signed-in accounts, in the order to spend them. */
  accounts(): Promise<readonly OpenSubtitlesAccount[]>;
  /** The far end refused this sign-in: drop it, so nothing retries a wrong password. */
  reject(slot: number, version: string, reason: string): Promise<void>;
  /** For the operator: this account's downloads are spent until `until`. Null clears it. */
  noteQuota(slot: number, until: Date | null): Promise<void>;
}

/* Our three-letter codes, as the API spells them. */
const API_LANGUAGES: Readonly<Record<string, string>> = {
  ara: "ar",
  deu: "de",
  eng: "en",
  fra: "fr",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nld: "nl",
  por: "pt-br,pt-pt",
  rus: "ru",
  spa: "es",
  tur: "tr",
  zho: "zh-cn,zh-tw",
};

/** A day, when the API does not say when a spent account renews. */
const DEFAULT_RENEWAL_MS = 24 * 60 * 60 * 1000;
/** Tokens are honoured for a day; renewing a little early avoids a failed download. */
const TOKEN_LIFETIME_MS = 23 * 60 * 60 * 1000;

function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function imdbNumber(id: string | null | undefined): number | null {
  const match = /^tt(\d{1,10})$/.exec(id ?? "");
  return match ? Number(match[1]) : null;
}

/** The API base a login names, when it is one of the API's own hosts. */
function apiBase(host: unknown): string {
  return typeof host === "string" &&
    /^[a-z0-9-]{1,63}\.opensubtitles\.(?:com|org)$/.test(host)
    ? `https://${host}/api/v1`
    : OPENSUBTITLES_API;
}

/** Download links are fetched without credentials, but only from the provider. */
function isProviderLink(link: unknown): link is string {
  if (typeof link !== "string") return false;
  try {
    const url = new URL(link);
    return (
      url.protocol === "https:" &&
      /(?:^|\.)opensubtitles\.(?:com|org)$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function retryAfterMs(headers: Headers): number | null {
  const seconds = Number(headers.get("retry-after") ?? "");
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export type OpenSubtitlesLogin =
  | {
      readonly outcome: "ok";
      readonly token: string;
      readonly baseUrl: string;
      /** The account's daily allowance, when the API says. */
      readonly allowedDownloads: number | null;
    }
  | { readonly outcome: "refused"; readonly reason: string }
  | { readonly outcome: "key-refused"; readonly reason: string }
  | { readonly outcome: "rate-limited"; readonly retryAfterMs: number | null }
  | { readonly outcome: "error"; readonly reason: string };

/** Signs one account in. Used to check a sign-in before it is saved, and to renew tokens. */
export async function openSubtitlesLogin(input: {
  apiKey: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OpenSubtitlesLogin> {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${OPENSUBTITLES_API}/login`, {
      method: "POST",
      headers: {
        "api-key": input.apiKey,
        "user-agent": OPENSUBTITLES_USER_AGENT,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return { outcome: "error", reason: "OpenSubtitles could not be reached." };
  }
  if (response.status === 401)
    return {
      outcome: "refused",
      reason: "OpenSubtitles refused this username and password.",
    };
  if (response.status === 403)
    return {
      outcome: "key-refused",
      reason: "OpenSubtitles refused the API key.",
    };
  if (response.status === 429)
    return {
      outcome: "rate-limited",
      retryAfterMs: retryAfterMs(response.headers),
    };
  const body = await readJson(response);
  if (!response.ok || typeof body.token !== "string" || !body.token)
    return {
      outcome: "error",
      reason: `OpenSubtitles answered the sign-in with ${response.status}.`,
    };
  const user = (body.user ?? {}) as Record<string, unknown>;
  return {
    outcome: "ok",
    token: body.token,
    baseUrl: apiBase(body.base_url),
    allowedDownloads:
      typeof user.allowed_downloads === "number"
        ? user.allowed_downloads
        : null,
  };
}

interface ListedFile {
  file_id?: unknown;
}
interface ListedSubtitle {
  attributes?: {
    language?: unknown;
    download_count?: unknown;
    hearing_impaired?: unknown;
    foreign_parts_only?: unknown;
    machine_translated?: unknown;
    fps?: unknown;
    release?: unknown;
    files?: ListedFile[];
    feature_details?: {
      title?: unknown;
      year?: unknown;
      imdb_id?: unknown;
      parent_title?: unknown;
      parent_imdb_id?: unknown;
      season_number?: unknown;
      episode_number?: unknown;
    };
  };
}

/** Whether the listing says it is for the title, season and episode searched for. */
function isFor(
  query: SubtitleQuery,
  details: NonNullable<ListedSubtitle["attributes"]>["feature_details"],
): boolean {
  if (!details) return false;
  const wantedImdb = imdbNumber(query.imdbId);
  if (query.season !== null) {
    if (
      details.season_number !== query.season ||
      details.episode_number !== query.episode
    )
      return false;
    return wantedImdb !== null
      ? details.parent_imdb_id === wantedImdb
      : typeof details.parent_title === "string" &&
          titleKey(details.parent_title) === titleKey(query.title);
  }
  return wantedImdb !== null
    ? details.imdb_id === wantedImdb
    : typeof details.title === "string" &&
        titleKey(details.title) === titleKey(query.title) &&
        details.year === query.year;
}

export function parseSearchResponse(
  query: SubtitleQuery,
  body: Record<string, unknown>,
): SubtitleCandidate[] {
  const rows = Array.isArray(body.data) ? (body.data as ListedSubtitle[]) : [];
  const candidates: SubtitleCandidate[] = [];
  for (const row of rows) {
    const attributes = row.attributes;
    if (!attributes || attributes.machine_translated === true) continue;
    // A subtitle split over several files is not one this pipeline can install.
    const files = Array.isArray(attributes.files) ? attributes.files : [];
    const fileId = files.length === 1 ? files[0]!.file_id : null;
    if (typeof fileId !== "number" || !Number.isSafeInteger(fileId)) continue;
    const release =
      typeof attributes.release === "string"
        ? attributes.release.slice(0, 300)
        : null;
    const facts = release ? parseRelease(release) : null;
    const fps = Number(attributes.fps);
    candidates.push({
      providerId: OPENSUBTITLES_ID,
      candidateId: String(fileId),
      language:
        typeof attributes.language === "string" ? attributes.language : "und",
      format: null,
      forced: attributes.foreign_parts_only === true,
      hearingImpaired: attributes.hearing_impaired === true,
      releaseTitle: release,
      releaseGroup: facts?.releaseGroup ?? null,
      source: facts && facts.source !== "unknown" ? facts.source : null,
      resolution:
        facts && facts.resolution !== "unknown" ? facts.resolution : null,
      hashMatched: false,
      providerRating:
        typeof attributes.download_count === "number"
          ? attributes.download_count
          : null,
      frameRate: Number.isFinite(fps) && fps > 0 ? fps : null,
      // Claimed only on evidence; the scorer's gate compares it to the catalogue.
      ...(isFor(query, attributes.feature_details)
        ? {
            identity: {
              title: query.title,
              year: query.year,
              season: query.season,
              episode: query.episode,
            },
          }
        : {}),
    });
  }
  return candidates;
}

/** The query string, sorted and lower-case: the API redirects any other spelling. */
export function searchParameters(
  query: SubtitleQuery,
  languages: string,
): string {
  const imdb = imdbNumber(query.imdbId);
  const parameters: Record<string, string> = { languages };
  if (query.season !== null) {
    parameters.season_number = String(query.season);
    if (query.episode !== null)
      parameters.episode_number = String(query.episode);
    if (imdb !== null) parameters.parent_imdb_id = String(imdb);
    else parameters.query = query.title;
  } else if (imdb !== null) parameters.imdb_id = String(imdb);
  else {
    parameters.query = query.title;
    if (query.year !== null) parameters.year = String(query.year);
  }
  return new URLSearchParams(
    Object.keys(parameters)
      .sort()
      .map((name) => [name, parameters[name]!.toLowerCase()]),
  ).toString();
}

export function createOpenSubtitlesProvider(options: {
  credentials: OpenSubtitlesCredentials;
  fetchImpl?: typeof fetch;
  /** Minimum spacing between requests. */
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): SubtitleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const spacingMs = options.spacingMs ?? 300;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const credentials = options.credentials;
  let last = 0;
  const pace = async () => {
    const wait = last + spacingMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
  };

  /* What this process knows about each account. Lost on restart, which costs one refused download. */
  const tokens = new Map<
    number,
    { version: string; token: string; baseUrl: string; issuedAt: number }
  >();
  const spentUntil = new Map<number, number>();
  /* Accounts whose quota note this process has already cleared or written. */
  const noted = new Set<number>();

  const needsKey = (): ProviderResult<never> => ({
    outcome: "needs-authentication",
    reason: "Add an OpenSubtitles API key.",
    authenticateAt: OPENSUBTITLES_CONSUMERS,
  });
  const needsAccount = (): ProviderResult<never> => ({
    outcome: "needs-authentication",
    reason: "Sign in to an OpenSubtitles account.",
    authenticateAt: null,
  });

  const spend = async (slot: number, until: number) => {
    spentUntil.set(slot, until);
    noted.add(slot);
    await credentials.noteQuota(slot, new Date(until)).catch(() => undefined);
  };

  type Attempt =
    | { kind: "payload"; payload: SubtitlePayload }
    | { kind: "spent"; until: number }
    | { kind: "refused"; reason: string }
    | { kind: "key-refused" }
    | { kind: "stale" }
    | { kind: "rate-limited"; retryAfterMs: number | null }
    | { kind: "error"; reason: string };

  async function downloadWith(
    apiKey: string,
    account: OpenSubtitlesAccount,
    candidate: SubtitleCandidate,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    let token = tokens.get(account.slot);
    if (
      !token ||
      token.version !== account.version ||
      now() - token.issuedAt > TOKEN_LIFETIME_MS
    ) {
      await pace();
      const login = await openSubtitlesLogin({
        apiKey,
        username: account.username,
        password: account.revealPassword(),
        fetchImpl,
        ...(signal ? { signal } : {}),
      });
      if (login.outcome === "refused")
        return { kind: "refused", reason: login.reason };
      if (login.outcome === "key-refused") return { kind: "key-refused" };
      if (login.outcome === "rate-limited")
        return { kind: "rate-limited", retryAfterMs: login.retryAfterMs };
      if (login.outcome === "error")
        return { kind: "error", reason: login.reason };
      token = {
        version: account.version,
        token: login.token,
        baseUrl: login.baseUrl,
        issuedAt: now(),
      };
      tokens.set(account.slot, token);
    }
    await pace();
    let response: Response;
    try {
      response = await fetchImpl(`${token.baseUrl}/download`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          authorization: `Bearer ${token.token}`,
          "user-agent": OPENSUBTITLES_USER_AGENT,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          file_id: Number(candidate.candidateId),
          sub_format: "srt",
        }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      return { kind: "error", reason: "OpenSubtitles could not be reached." };
    }
    if (response.status === 401 || response.status === 406) {
      tokens.delete(account.slot);
      return { kind: "stale" };
    }
    if (response.status === 403) return { kind: "key-refused" };
    if (response.status === 429)
      return {
        kind: "rate-limited",
        retryAfterMs: retryAfterMs(response.headers),
      };
    const body = await readJson(response);
    const renews = Date.parse(String(body.reset_time_utc ?? ""));
    const until = Number.isFinite(renews) ? renews : now() + DEFAULT_RENEWAL_MS;
    if (response.status === 407) return { kind: "spent", until };
    if (!response.ok)
      return {
        kind: "error",
        reason: `OpenSubtitles answered the download with ${response.status}.`,
      };
    if (!isProviderLink(body.link))
      return typeof body.remaining === "number" && body.remaining < 0
        ? { kind: "spent", until }
        : { kind: "error", reason: "OpenSubtitles offered no download link." };
    let file: Response;
    try {
      file = await fetchImpl(body.link, {
        headers: { "user-agent": OPENSUBTITLES_USER_AGENT },
        redirect: "follow",
        ...(signal ? { signal } : {}),
      });
    } catch {
      return { kind: "error", reason: "OpenSubtitles could not be reached." };
    }
    if (!file.ok)
      return {
        kind: "error",
        reason: `OpenSubtitles answered the file with ${file.status}.`,
      };
    const bytes = new Uint8Array(await file.arrayBuffer());
    // That was the last one for today: the next download goes to the next account.
    if (typeof body.remaining === "number" && body.remaining <= 0)
      await spend(account.slot, until);
    else if (!noted.has(account.slot)) {
      noted.add(account.slot);
      await credentials.noteQuota(account.slot, null).catch(() => undefined);
    }
    return {
      kind: "payload",
      payload: {
        bytes: toUtf8(bytes, candidate.language),
        declaredFormat: null,
        declaredFileName: null,
      },
    };
  }

  return {
    id: OPENSUBTITLES_ID,
    label: "OpenSubtitles",
    // Its credentials are its own, read from the account store, not a browser session.
    requiresSession: false,
    // Below TürkçeAltyazı, so it is asked only after TürkçeAltyazı had nothing.
    rank: 0,
    languages: Object.keys(API_LANGUAGES),
    downloadsPerSearch: 2,

    async search(query, _session, signal) {
      const languages = API_LANGUAGES[query.language];
      if (!languages) return { outcome: "empty" };
      const apiKey = await credentials.apiKey();
      if (!apiKey) return needsKey();
      // A search without an account to download with only finds what cannot be had.
      if ((await credentials.accounts()).length === 0) return needsAccount();
      await pace();
      let response: Response;
      try {
        response = await fetchImpl(
          `${OPENSUBTITLES_API}/subtitles?${searchParameters(query, languages)}`,
          {
            headers: {
              "api-key": apiKey,
              "user-agent": OPENSUBTITLES_USER_AGENT,
              accept: "application/json",
            },
            redirect: "follow",
            ...(signal ? { signal } : {}),
          },
        );
      } catch {
        return {
          outcome: "error",
          reason: "OpenSubtitles could not be reached.",
          retryable: true,
        };
      }
      if (response.status === 401 || response.status === 403)
        return {
          outcome: "needs-authentication",
          reason: "OpenSubtitles refused the API key.",
          authenticateAt: OPENSUBTITLES_CONSUMERS,
        };
      if (response.status === 429)
        return {
          outcome: "rate-limited",
          retryAfterMs: retryAfterMs(response.headers),
        };
      if (!response.ok)
        return {
          outcome: "error",
          reason: `OpenSubtitles answered ${response.status}.`,
          retryable: response.status >= 500,
        };
      const candidates = parseSearchResponse(query, await readJson(response));
      return candidates.length
        ? { outcome: "ok", value: candidates }
        : { outcome: "empty" };
    },

    async download(candidate, _session, signal) {
      if (!/^\d{1,12}$/.test(candidate.candidateId))
        return {
          outcome: "error",
          reason: "The candidate id is not one this provider issued.",
          retryable: false,
        };
      const apiKey = await credentials.apiKey();
      if (!apiKey) return needsKey();
      const accounts = await credentials.accounts();
      let renewsAt: number | null = null;
      let failure: ProviderResult<never> | null = null;
      for (const account of accounts) {
        const spent = spentUntil.get(account.slot);
        if (spent !== undefined && spent > now()) {
          renewsAt = renewsAt === null ? spent : Math.min(renewsAt, spent);
          continue;
        }
        let attempt = await downloadWith(apiKey, account, candidate, signal);
        // An expired token: sign in again once, then believe the answer.
        if (attempt.kind === "stale")
          attempt = await downloadWith(apiKey, account, candidate, signal);
        switch (attempt.kind) {
          case "payload":
            return { outcome: "ok", value: attempt.payload };
          case "spent":
            await spend(account.slot, attempt.until);
            renewsAt =
              renewsAt === null
                ? attempt.until
                : Math.min(renewsAt, attempt.until);
            continue;
          case "refused":
            tokens.delete(account.slot);
            await credentials
              .reject(account.slot, account.version, attempt.reason)
              .catch(() => undefined);
            continue;
          case "key-refused":
            return {
              outcome: "needs-authentication",
              reason: "OpenSubtitles refused the API key.",
              authenticateAt: OPENSUBTITLES_CONSUMERS,
            };
          case "rate-limited":
            return {
              outcome: "rate-limited",
              retryAfterMs: attempt.retryAfterMs,
            };
          case "stale":
            failure = {
              outcome: "error",
              reason: "OpenSubtitles refused a fresh sign-in token.",
              retryable: true,
            };
            continue;
          case "error":
            failure = {
              outcome: "error",
              reason: attempt.reason,
              retryable: true,
            };
            continue;
        }
      }
      // Every account has used its day: try again when the first one renews.
      if (renewsAt !== null)
        return {
          outcome: "rate-limited",
          retryAfterMs: Math.max(0, renewsAt - now()),
        };
      return failure ?? needsAccount();
    },
  };
}
