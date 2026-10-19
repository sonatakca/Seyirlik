/**
 * What Seyirlik means by a subtitle.
 *
 * This is the domain Bazarr occupies today, and the point of writing it out is
 * that Seyirlik should own the *product* question — does this file have the
 * translation somebody wants, and if not, what happened — rather than inherit
 * another program's model of it. Bazarr is a migration reference here and
 * nothing more; none of its internal shapes appear below.
 *
 * Three decisions run through everything else:
 *
 *  - **A subtitle belongs to a video file, not to a title.** A film kept as a
 *    theatrical cut and a director's cut is one item and two files, and a
 *    translation timed to one of them is wrong against the other. The library
 *    already discovers sidecars per source file for exactly this reason.
 *  - **Where a track lives is part of what it is.** An embedded stream and a
 *    `.srt` beside the video answer the same question for a viewer and are
 *    completely different objects to a downloader, a packager and a file
 *    system. Collapsing them loses the distinction at the moment it matters.
 *  - **Authentication is a pause, not a failure.** The provider this was
 *    designed against issues short-lived browser sessions, and a session
 *    expiring mid-search is an ordinary event. A job that fails permanently
 *    because a cookie aged out would teach an operator to ignore the state.
 */

import {
  normalizeLanguage,
  UNKNOWN_LANGUAGE,
} from "../../../renditions/processing/languages";

/* ------------------------------------------------------------------ tracks */

/**
 * Where a subtitle physically is.
 *
 * `embedded` is a stream inside the container; `external` is a file beside it.
 * Seyirlik writes only external ones — rewriting a container to add a track
 * would rewrite the media, which is not something a subtitle search should ever
 * do.
 */
export type SubtitleOrigin = "embedded" | "external";

/**
 * The formats this system will handle.
 *
 * Text only, and deliberately the same set the packager already accepts as
 * sidecars, so a subtitle that is downloaded is a subtitle that can be played.
 * Image-based formats — VobSub, PGS — are read where they are already embedded
 * but are never a download target: they cannot be restyled, resynchronised or
 * converted to WebVTT without OCR, and a search that returned one would produce
 * a track the player cannot use.
 */
export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa" | "sub";

export const DOWNLOADABLE_SUBTITLE_FORMATS: readonly SubtitleFormat[] = [
  "srt",
  "vtt",
  "ass",
  "ssa",
];

export function isDownloadableFormat(format: SubtitleFormat): boolean {
  return DOWNLOADABLE_SUBTITLE_FORMATS.includes(format);
}

const EXTENSION_FORMATS: ReadonlyMap<string, SubtitleFormat> = new Map([
  [".srt", "srt"],
  [".vtt", "vtt"],
  [".ass", "ass"],
  [".ssa", "ssa"],
  [".sub", "sub"],
]);

/** The format a filename claims, or `null` when it claims none this handles. */
export function formatFromExtension(extension: string): SubtitleFormat | null {
  return EXTENSION_FORMATS.get(extension.toLowerCase()) ?? null;
}

/**
 * The two flags that change which track a viewer wants, rather than how good it
 * is.
 *
 * They are modelled together because they are asked together and because a
 * request for one is not satisfied by the other: somebody who needs SDH is not
 * served by a forced track, and somebody watching a mostly-English film for the
 * Klingon scenes is not served by a full transcript.
 */
export interface SubtitleFlags {
  /** Covers only untranslated foreign dialogue, not the whole soundtrack. */
  readonly forced: boolean;
  /** Carries sound effects and speaker labels — SDH, HI, CC. */
  readonly hearingImpaired: boolean;
}

export const NO_SUBTITLE_FLAGS: SubtitleFlags = {
  forced: false,
  hearingImpaired: false,
};

/** A subtitle track that exists, wherever it lives. */
export interface SubtitleTrack extends SubtitleFlags {
  readonly origin: SubtitleOrigin;
  /** ISO-639 as `normalizeLanguage` produces it, or `und`. */
  readonly language: string;
  readonly format: SubtitleFormat | null;
  /**
   * Library-relative POSIX path for an external track; `null` for an embedded
   * one. Relative because it is what the catalogue stores and what survives the
   * volume being mounted somewhere else.
   */
  readonly relativePath: string | null;
  /** Stream index for an embedded track; `null` for an external one. */
  readonly streamIndex: number | null;
  /** Present when Seyirlik put this file there, absent for anything it found. */
  readonly managed: boolean;
}

/**
 * Whether two tracks would satisfy the same request.
 *
 * Language and both flags, and nothing else. Format is deliberately excluded:
 * a Turkish `.srt` and a Turkish `.ass` are the same answer to "is this film
 * subtitled in Turkish", and treating them as different is how a library
 * accumulates four copies of one translation.
 */
export function satisfiesSameWant(
  left: Pick<SubtitleTrack, "language" | "forced" | "hearingImpaired">,
  right: Pick<SubtitleTrack, "language" | "forced" | "hearingImpaired">,
): boolean {
  return (
    left.language === right.language &&
    left.forced === right.forced &&
    left.hearingImpaired === right.hearingImpaired
  );
}

/* ------------------------------------------------------------------- wants */

/**
 * A translation somebody wants for a file.
 *
 * `hearingImpaired` is a *preference* rather than a requirement, which is the
 * one place this differs from the flags on a track. Most languages have far
 * more ordinary subtitles than SDH ones, and refusing every non-SDH result
 * leaves a viewer with nothing rather than with something imperfect. So it
 * scores rather than filters — see `SCORE_DIMENSIONS`.
 */
export interface SubtitleWant {
  readonly language: string;
  /** A forced track is a different want, never a lesser version of a full one. */
  readonly forced: boolean;
  readonly hearingImpaired: "prefer" | "avoid" | "indifferent";
}

export function normalizeWant(want: {
  language: string;
  forced?: boolean;
  hearingImpaired?: SubtitleWant["hearingImpaired"];
}): SubtitleWant {
  return {
    language: normalizeLanguage(want.language),
    forced: want.forced ?? false,
    hearingImpaired: want.hearingImpaired ?? "indifferent",
  };
}

/**
 * Whether an existing track already answers a want.
 *
 * The hearing-impaired preference does not enter: a want is satisfied by a
 * track in the right language with the right forced status, and preferring SDH
 * is a reason to pick one candidate over another, not a reason to keep
 * searching after something usable is already installed. Searching for ever
 * because the only Turkish subtitle on disk is not the SDH one is how a
 * provider gets hammered for a file that is already watchable.
 */
export function wantIsSatisfiedBy(
  want: SubtitleWant,
  track: Pick<SubtitleTrack, "language" | "forced">,
): boolean {
  if (want.language === UNKNOWN_LANGUAGE) return false;
  return track.language === want.language && track.forced === want.forced;
}

/* ------------------------------------------------------------------ states */

/**
 * Where one subtitle acquisition has got to.
 *
 * Modelled as explicitly as an import, and for the same reason: the states a
 * restart can land in are the ones worth naming, because a worker that dies
 * between downloading and installing has to be able to say which of the two
 * happened.
 */
export type SubtitleState =
  /** Wanted, nothing attempted yet. */
  | "wanted"
  /** Providers are being queried. */
  | "searching"
  /** Candidates scored and one chosen; nothing fetched yet. */
  | "selected"
  /** Bytes are being fetched. */
  | "downloading"
  /** Fetched, being checked before anything is written beside the media. */
  | "validating"
  /** Written and recorded. The only success. */
  | "installed"
  /**
   * A provider needs a person before this can continue.
   *
   * Not a failure: the search is intact, the candidate may still be there, and
   * the job resumes once a session exists. See `SubtitleDisposition`.
   */
  | "needs-authentication"
  /** Every provider answered, and none of them had it. */
  | "unavailable"
  /** Ended badly enough to stop. `failureClass` says how. */
  | "failed"
  /** A better subtitle replaced this one; kept for history. */
  | "superseded";

export const SUBTITLE_STATES: readonly SubtitleState[] = [
  "wanted",
  "searching",
  "selected",
  "downloading",
  "validating",
  "installed",
  "needs-authentication",
  "unavailable",
  "failed",
  "superseded",
];

export const TERMINAL_SUBTITLE_STATES: readonly SubtitleState[] = [
  "installed",
  "unavailable",
  "failed",
  "superseded",
];

/**
 * States in which bytes may exist that nothing has recorded.
 *
 * A crash in any of these leaves a partial download or a written file the
 * database does not know about, and reconciliation has to look at the disk
 * rather than trust the row.
 */
export const UNCERTAIN_SUBTITLE_STATES: readonly SubtitleState[] = [
  "downloading",
  "validating",
];

const TRANSITIONS: Record<SubtitleState, readonly SubtitleState[]> = {
  wanted: ["searching", "failed", "superseded"],
  searching: [
    "selected",
    "unavailable",
    "needs-authentication",
    "failed",
    "superseded",
  ],
  selected: ["downloading", "needs-authentication", "failed", "superseded"],
  /* `unavailable`: every chosen download held nothing for this episode. */
  downloading: [
    "validating",
    "unavailable",
    "needs-authentication",
    "failed",
    "superseded",
  ],
  validating: ["installed", "failed", "superseded"],
  /*
   * Back to whichever step asked for the session. The state carries no memory
   * of where it came from, so the resume is explicit: the caller says what it
   * was doing, and an attempt that cannot say goes back to `searching`, which
   * is correct if wasteful.
   */
  "needs-authentication": [
    "searching",
    "selected",
    "downloading",
    "failed",
    "superseded",
  ],
  installed: ["superseded"],
  unavailable: ["wanted", "superseded"],
  failed: ["wanted", "superseded"],
  superseded: [],
};

export class SubtitleTransitionError extends Error {
  readonly from: SubtitleState;
  readonly to: SubtitleState;
  constructor(from: SubtitleState, to: SubtitleState) {
    super(`A subtitle cannot go from ${from} to ${to}.`);
    this.name = "SubtitleTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: SubtitleState, to: SubtitleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: SubtitleState, to: SubtitleState): void {
  if (!canTransition(from, to)) throw new SubtitleTransitionError(from, to);
}

export function isTerminal(state: SubtitleState): boolean {
  return TERMINAL_SUBTITLE_STATES.includes(state);
}

export function needsReconciliation(state: SubtitleState): boolean {
  return UNCERTAIN_SUBTITLE_STATES.includes(state);
}

/* --------------------------------------------------------------- failures */

export type SubtitleFailureClass =
  /** The video this was for is no longer where the catalogue says. */
  | "media-missing"
  /** No provider is configured that could answer for this language. */
  | "no-provider"
  /** A provider was reachable but refused or errored. */
  | "provider-error"
  /** A provider took too long. */
  | "provider-timeout"
  /** A provider needs a browser session a person must establish. */
  | "authentication-required"
  /** A provider said no, repeatedly and deliberately. */
  | "provider-rate-limited"
  /** Downloaded bytes are not a subtitle this system will install. */
  | "payload-invalid"
  /** The payload was a subtitle but not in a format worth installing. */
  | "payload-unsupported-format"
  /** The destination is held open, or momentarily unwritable. */
  | "destination-locked"
  /** The destination holds something Seyirlik did not put there. */
  | "destination-occupied"
  /** A path resolved outside the root it was authorised against. */
  | "path-escape"
  /** The name could not be made safe for this filesystem. */
  | "name-unrepresentable"
  | "disk-full"
  /** A write reported failure but may have happened. */
  | "commit-ambiguous"
  | "unknown";

/**
 * What to do about a failure.
 *
 * `paused` is the one this system needed that an import did not. A provider
 * session that has expired is not a fault of the media, the request or the
 * software: it is a thing a person fixes in a browser, after which the same
 * attempt continues. Filing it under `attention` would be honest but would put
 * it in the same queue as a corrupt payload, and the two want completely
 * different handling.
 */
export type SubtitleDisposition =
  /** Worth trying again unchanged. */
  | "retry"
  /** Waiting on a person to authenticate, then resumes by itself. */
  | "paused"
  /** Reality must be read before anything else is attempted. */
  | "reconcile"
  /** A person should look, and the attempt will not proceed alone. */
  | "attention"
  /** Nothing further will be attempted for this want. */
  | "terminal";

const DISPOSITIONS: Record<SubtitleFailureClass, SubtitleDisposition> = {
  "provider-timeout": "retry",
  "provider-error": "retry",
  "provider-rate-limited": "retry",
  "destination-locked": "retry",
  "disk-full": "retry",
  "authentication-required": "paused",
  "commit-ambiguous": "reconcile",
  "media-missing": "attention",
  "destination-occupied": "attention",
  "name-unrepresentable": "attention",
  "no-provider": "attention",
  /*
   * A payload that is not a subtitle is a fact about that candidate, not about
   * the want. The search may still succeed with another one, so the *attempt*
   * is terminal and the want is not — the caller picks the next candidate.
   */
  "payload-invalid": "terminal",
  "payload-unsupported-format": "terminal",
  "path-escape": "terminal",
  unknown: "terminal",
};

export function dispositionFor(
  failure: SubtitleFailureClass,
): SubtitleDisposition {
  return DISPOSITIONS[failure];
}

/**
 * How many times one want may be attempted before a person is asked.
 *
 * Larger than an import's three, because the commonest subtitle failures are a
 * provider being briefly unreachable or rate-limiting, and both clear on their
 * own. A paused attempt does not consume one of these: waiting for a person is
 * not an attempt.
 */
export const MAX_SUBTITLE_ATTEMPTS = 5;

export interface SubtitleRetryPlan {
  readonly action: SubtitleDisposition;
  readonly delayMs: number;
  readonly detail: string;
}

/**
 * Backs off, but not for ever, and not at all for the two cases where waiting
 * is the wrong response.
 */
export function planSubtitleRetry(
  failure: SubtitleFailureClass,
  attempt: number,
): SubtitleRetryPlan {
  const action = dispositionFor(failure);
  if (action === "paused") {
    return {
      action,
      delayMs: 0,
      detail: "Waiting for a provider session a person must establish.",
    };
  }
  if (action !== "retry") {
    return { action, delayMs: 0, detail: `Not retryable: ${failure}.` };
  }
  if (attempt >= MAX_SUBTITLE_ATTEMPTS) {
    return {
      action: "attention",
      delayMs: 0,
      detail: `Gave up after ${MAX_SUBTITLE_ATTEMPTS} attempts: ${failure}.`,
    };
  }
  /*
   * Doubling from ten seconds, capped at ten minutes. A rate limit measured in
   * minutes is the reason for the cap; a provider that is simply down is the
   * reason there is a ceiling at all rather than an ever-growing wait.
   */
  const delayMs = Math.min(10_000 * 2 ** (attempt - 1), 600_000);
  return { action, delayMs, detail: `Retrying after ${failure}.` };
}

/* ------------------------------------------------------------------ syncing */

/**
 * Whether the installed subtitle is timed to the video it sits beside.
 *
 * Deliberately small. Seyirlik does not resynchronise anything yet, and the
 * states that exist are the ones a caller can currently produce; adding
 * `drift-detected` before anything measures drift would be inventing a fact.
 */
export type SubtitleSyncState =
  /** Nobody has checked, which is true of everything found on disk. */
  | "unknown"
  /** Taken as timed to this release, because it was matched to it. */
  | "assumed-in-sync"
  /** A person said it is wrong. */
  | "reported-out-of-sync";

/* ----------------------------------------------------------------- scoring */

/**
 * The dimensions a candidate is judged on.
 *
 * Weights are stated here, once, so a score can be explained rather than
 * asserted — every selection carries the components that produced it. They are
 * not Bazarr's numbers and are not meant to be: what matters is the ordering
 * they imply, which is that a subtitle for the wrong release of the right
 * episode beats a subtitle for the right release of the wrong one, and that
 * nothing outranks the language actually being the one that was asked for.
 */
export const SCORE_DIMENSIONS = {
  /** Same film, same episode. Without it nothing else is worth anything. */
  identity: 100,
  /** The provider matched on a hash of the video itself. */
  hashMatch: 60,
  /** Same release group. */
  releaseGroup: 25,
  /**
   * Timed against the same frame rate. A 25 fps subtitle on a 23.976 fps film
   * drifts by four percent — a minute off by the end — however good it is.
   */
  frameRate: 20,
  /** Same source — BluRay, WEB-DL, HDTV. */
  source: 15,
  /** Same resolution. */
  resolution: 10,
  /** The hearing-impaired preference was met. */
  hearingImpaired: 8,
  /** The provider is one this deployment trusts more than the others. */
  providerRank: 5,
} as const;

export type ScoreDimension = keyof typeof SCORE_DIMENSIONS;

export interface ScoreComponent {
  readonly dimension: ScoreDimension;
  readonly weight: number;
  readonly matched: boolean;
  /** Why, in words an operator can read. Never a provider's own text. */
  readonly detail: string;
}

export interface SubtitleScore {
  readonly total: number;
  readonly maximum: number;
  readonly components: readonly ScoreComponent[];
  /** The matched components' details, in weight order. */
  readonly reasons: readonly string[];
}

/**
 * Adds a candidate's components up, and keeps the reasons.
 *
 * A score with no explanation is a number nobody can argue with, which is
 * exactly the wrong property for a decision that silently changes what somebody
 * watches. `maximum` travels with the total because 148 means nothing on its
 * own and "148 of a possible 223" means quite a lot.
 */
export function scoreOf(components: readonly ScoreComponent[]): SubtitleScore {
  const total = components
    .filter((c) => c.matched)
    .reduce((sum, c) => sum + c.weight, 0);
  const maximum = components.reduce((sum, c) => sum + c.weight, 0);
  const reasons = [...components]
    .filter((c) => c.matched)
    .sort((a, b) => b.weight - a.weight)
    .map((c) => c.detail);
  return { total, maximum, components, reasons };
}

/**
 * Whether a candidate is worth installing at all.
 *
 * Identity is not negotiable — a subtitle for a different episode is worse than
 * no subtitle, because it looks like the feature working. Everything else is a
 * matter of degree.
 */
export function isAcceptable(score: SubtitleScore): boolean {
  return score.components.some((c) => c.dimension === "identity" && c.matched);
}
