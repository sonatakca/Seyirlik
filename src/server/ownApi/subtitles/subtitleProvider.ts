/**
 * Where subtitles come from, and how a provider that wants a person is handled.
 *
 * The shape of this file is decided by one provider in particular.
 * TürkçeAltyazılar does not issue API keys; it issues short-lived sessions to a
 * browser that has passed a Cloudflare challenge. That has three consequences
 * which the rest of the subsystem has to be built around rather than patched
 * for later:
 *
 *  1. **A request can fail for a reason no retry fixes and no operator report
 *     helps.** The answer is a person completing a challenge in a window. So
 *     `needs-authentication` is a *result*, not an exception — the pipeline
 *     pauses on it and resumes the same attempt afterwards.
 *  2. **Session material is the most dangerous thing this subsystem holds.** A
 *     leaked cookie is somebody's account. So a session is unprintable by
 *     construction: it does not serialise, it does not appear in a template
 *     string, and the material is reachable only through a method that says so
 *     in its name.
 *  3. **The session belongs to a browser profile, not to this process.** Cookie,
 *     user agent and the storage that goes with them have to stay consistent or
 *     the far end sees a different client and challenges again. They therefore
 *     travel together as one object and are never assembled piecemeal.
 *
 * Explicit non-goals, because the absence of these is a design decision rather
 * than an omission: **no CAPTCHA solving, no challenge bypass, no fingerprint
 * or stealth evasion, and no long-lived hard-coded cookie.** The user completes
 * the challenge. This code carries the result of that and nothing else.
 */

import type {
  SubtitleFlags,
  SubtitleFormat,
  SubtitleScore,
} from "./subtitleState";

/* --------------------------------------------------------------- sessions */

/**
 * A provider session, holding material that must never be logged.
 *
 * The material lives in a closure rather than on a property, so there is no
 * field for a spread, a serializer or a debugger snapshot to reach. `toJSON`
 * and `toString` are overridden rather than merely absent, because the default
 * `[object Object]` is harmless but `JSON.stringify` of a plain object is not,
 * and a structured logger reaches for `toJSON` first.
 */
export interface ProviderSession {
  readonly providerId: string;
  /** When the far end will stop honouring this, if the provider says. */
  readonly expiresAtMs: number | null;
  /**
   * The headers to send. Named so that no one calls it by accident, and so a
   * review can grep for every place session material is touched.
   */
  revealHeaders(): Readonly<Record<string, string>>;
  toJSON(): string;
  toString(): string;
}

const REDACTED = "[provider session withheld]";

/**
 * Builds a session from the material a browser profile yielded.
 *
 * Cookie and user agent are taken together and kept together: sending one
 * without the other is what makes a far end decide this is a different client
 * and challenge again.
 */
export function createProviderSession(input: {
  providerId: string;
  cookie: string;
  userAgent: string;
  extraHeaders?: Readonly<Record<string, string>>;
  expiresAtMs?: number | null;
}): ProviderSession {
  const headers: Record<string, string> = {
    ...(input.extraHeaders ?? {}),
    // An anonymous session is a user agent and no cookie at all, never an
    // empty `cookie:` header.
    ...(input.cookie ? { cookie: input.cookie } : {}),
    "user-agent": input.userAgent,
  };
  return {
    providerId: input.providerId,
    expiresAtMs: input.expiresAtMs ?? null,
    revealHeaders: () => ({ ...headers }),
    toJSON: () => REDACTED,
    toString: () => REDACTED,
  };
}

/** Whether a session has aged out, given the clock. */
export function sessionIsExpired(
  session: ProviderSession,
  nowMs: number,
): boolean {
  return session.expiresAtMs !== null && session.expiresAtMs <= nowMs;
}

/**
 * What a session lookup can say.
 *
 * `needs-authentication` carries a `reason` an operator can read and, where the
 * provider offers one, the URL a person should be sent to. It never carries
 * anything from the failed session.
 */
export type SessionLookup =
  | { readonly outcome: "ready"; readonly session: ProviderSession }
  | {
      readonly outcome: "needs-authentication";
      readonly providerId: string;
      readonly reason: string;
      readonly authenticateAt: string | null;
    };

/**
 * Where sessions come from.
 *
 * The implementation is `providerSessionVault.ts`: a person signs in in their
 * own browser and pastes the session, which is sealed in the database. There
 * is no embedded browser; the boundary would take one without the pipeline
 * noticing.
 */
export interface ProviderSessionManager {
  /**
   * The current session for a provider, or the fact that a person is needed.
   *
   * Never throws for a missing or expired session: that is an answer, and
   * turning it into an exception is what would make the pipeline fail rather
   * than pause.
   */
  acquire(providerId: string): Promise<SessionLookup>;
  /**
   * Tells the manager the far end rejected this session after all.
   *
   * Expiry is not always announced, so the first evidence is often a 403 on a
   * request that should have worked. Reporting it lets the next `acquire`
   * answer `needs-authentication` instead of handing back the same dead cookie.
   */
  invalidate(providerId: string, reason: string): Promise<void>;
}

/* -------------------------------------------------------------- providers */

/** What is being looked for. Facts about the media, never a path. */
export interface SubtitleQuery {
  readonly title: string;
  readonly year: number | null;
  /** Absent for a film. */
  readonly season: number | null;
  readonly episode: number | null;
  readonly language: string;
  readonly wantForced: boolean;
  /** The release this file came from, where the catalogue knows it. */
  readonly releaseTitle: string | null;
  readonly releaseGroup: string | null;
  readonly source: string | null;
  readonly resolution: string | null;
  /**
   * A provider-specific hash of the video, for providers that match on one.
   * Computed by the caller; a provider never receives a path to compute it
   * from, because a provider must not be able to name a file this system reads.
   */
  readonly videoHash: string | null;
  readonly durationSeconds: number | null;
  /** The IMDb id (`tt…`) of the film or series, when the catalogue has one. */
  readonly imdbId?: string | null;
  /** Frames per second of the video, which decides whether cue times line up. */
  readonly frameRate?: number | null;
}

/** One subtitle a provider says it has. */
export interface SubtitleCandidate extends SubtitleFlags {
  /** Explicit evidence from the provider; absent evidence cannot win a search. */
  readonly identity?: Pick<
    SubtitleQuery,
    "title" | "year" | "season" | "episode"
  >;
  readonly providerId: string;
  /** Opaque to everything but the provider that issued it. */
  readonly candidateId: string;
  readonly language: string;
  readonly format: SubtitleFormat | null;
  /** The provider's own name for the release. Untrusted display text. */
  readonly releaseTitle: string | null;
  readonly releaseGroup: string | null;
  readonly source: string | null;
  readonly resolution: string | null;
  /** True when the provider matched on the video hash rather than the name. */
  readonly hashMatched: boolean;
  /** Whatever the provider says about popularity or rating, for tie-breaks. */
  readonly providerRating: number | null;
  /** The frame rate the subtitle was timed against, when the provider says. */
  readonly frameRate?: number | null;
}

/** A candidate with the score this deployment gave it. */
export interface ScoredCandidate {
  readonly candidate: SubtitleCandidate;
  readonly score: SubtitleScore;
}

/**
 * What a provider call can produce.
 *
 * Errors are values here for the same reason the session lookup is: the
 * difference between "this provider had nothing", "this provider is broken" and
 * "this provider wants a person" decides three different behaviours, and an
 * exception collapses them into one.
 */
export type ProviderResult<T> =
  | { readonly outcome: "ok"; readonly value: T }
  | { readonly outcome: "empty" }
  | {
      readonly outcome: "needs-authentication";
      readonly reason: string;
      readonly authenticateAt: string | null;
    }
  | {
      readonly outcome: "rate-limited";
      readonly retryAfterMs: number | null;
    }
  | {
      readonly outcome: "error";
      /** Safe for a log and an operator. Never a provider's raw body. */
      readonly reason: string;
      readonly retryable: boolean;
    };

/** A downloaded subtitle, before anything has decided it is one. */
export interface SubtitlePayload {
  readonly bytes: Uint8Array;
  /** What the provider claimed, which is not what will be believed. */
  readonly declaredFormat: SubtitleFormat | null;
  readonly declaredFileName: string | null;
}

export interface SubtitleProvider {
  readonly id: string;
  /** Shown to a person. */
  readonly label: string;
  /**
   * Whether this provider needs a browser session at all.
   *
   * An API-key provider answers `false` and never reaches the session manager,
   * which keeps the pause machinery out of the path of providers that do not
   * need it.
   */
  readonly requiresSession: boolean;
  /**
   * How much this deployment trusts it, for the `providerRank` score
   * component. Higher is better; the scale is local and has no meaning outside
   * this installation.
   */
  readonly rank: number;
  /** Languages it is worth asking, or `null` for "ask about anything". */
  readonly languages: readonly string[] | null;
  /**
   * The most downloads one search may spend measuring candidates here. Set by
   * a provider that counts downloads against a daily allowance, where every
   * candidate measured is one fewer subtitle for another title.
   */
  readonly downloadsPerSearch?: number;

  search(
    query: SubtitleQuery,
    session: ProviderSession | null,
    signal?: AbortSignal,
  ): Promise<ProviderResult<readonly SubtitleCandidate[]>>;

  download(
    candidate: SubtitleCandidate,
    session: ProviderSession | null,
    signal?: AbortSignal,
  ): Promise<ProviderResult<SubtitlePayload>>;
}

/**
 * Whether it is worth asking this provider for this language.
 *
 * A provider that only carries Turkish should not be asked for German: the
 * request costs a round trip, and on a session-based provider it costs part of
 * a rate limit that the language it *can* answer will need.
 */
export function providerCoversLanguage(
  provider: Pick<SubtitleProvider, "languages">,
  language: string,
): boolean {
  return provider.languages === null || provider.languages.includes(language);
}

/**
 * The providers worth asking, in the order to ask them.
 *
 * The pipeline asks them one at a time and stops at the first that yields a
 * subtitle, so rank is priority: a lower-ranked provider is a fallback.
 * Highest rank first, and ties broken by id so the order is stable across
 * restarts — an unstable order makes two runs of the same search return
 * different subtitles, which is the kind of thing that looks like a bug in
 * scoring.
 */
export function providersFor(
  providers: readonly SubtitleProvider[],
  language: string,
): SubtitleProvider[] {
  return providers
    .filter((provider) => providerCoversLanguage(provider, language))
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
}
