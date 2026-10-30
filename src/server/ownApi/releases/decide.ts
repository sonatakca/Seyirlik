/**
 * Which release would be acquired, and why every other one would not.
 *
 * Deterministic by construction. The same candidates, profile, preferences and
 * held state always produce the same winner, and the ladder that breaks a tie
 * ends in a stable identifier so provider ordering can never decide it. That
 * matters more than it sounds: an indexer returns results in whatever order it
 * likes, and a comparison that returns 0 for two genuinely different releases
 * silently hands the choice to that order.
 *
 * Nothing here acquires anything. It names a winner; a later phase decides
 * what to do about it.
 */
import type { IndexerRelease } from "../indexers/indexerTypes";
import { parseRelease } from "./parseRelease";
import { qualityOf, type Quality } from "./quality";
import {
  breakQualityTie,
  evaluateQuality,
  evaluateUpgrade,
  type QualityProfile,
  type Reason,
} from "./qualityProfile";
import { scoreRelease, scoreReasons, type PreferenceRule } from "./preferences";
import type { ReleaseFacts } from "./releaseFacts";
import { foldLatin } from "./titleIdentity";

/**
 * `aliases` are the other names the same work goes by — its English and
 * original titles when `title` is the Turkish one — so a release named
 * `The.Dark.Knight` is recognised as "Kara Şövalye".
 */
export type MediaTarget =
  | {
      readonly kind: "movie";
      readonly title: string;
      readonly aliases?: readonly string[];
      readonly year?: number;
    }
  | {
      readonly kind: "episode";
      readonly title: string;
      readonly aliases?: readonly string[];
      readonly season: number;
      readonly episode: number;
    }
  | {
      readonly kind: "season";
      readonly title: string;
      readonly aliases?: readonly string[];
      readonly season: number;
    }
  | {
      /**
       * Every season at once, in one release. `seasons` are the ones that
       * must be in it; without them a pack must at least span two seasons
       * or call itself complete.
       */
      readonly kind: "series";
      readonly title: string;
      readonly aliases?: readonly string[];
      readonly seasons?: readonly number[];
    };

/** Words a release uses to say it holds every season. */
const COMPLETE_SERIES = /\b(?:complete|all[\s._-]?seasons|integrale)\b/i;

/**
 * A pack that says it is missing episodes. Taking it stops the episode
 * search that would have found them, and its gaps are found only once it
 * is imported.
 */
const INCOMPLETE = /\b(?:incomplete|partial)\b/i;

const INCOMPLETE_PACK = {
  ok: false,
  code: "incomplete-pack",
  detail:
    "Says it is incomplete; its episodes are searched one by one instead.",
} as const;

export type RejectionCode =
  | "title-mismatch"
  | "wrong-year"
  | "wrong-season"
  | "wrong-episode"
  | "wrong-kind"
  | "quality-not-allowed"
  | "quality-unknown"
  | "below-format-score"
  | "too-large"
  | "blocklisted"
  | "incomplete-pack"
  | "upgrade-not-wanted";

export interface CandidateDecision {
  readonly release: IndexerRelease;
  readonly facts: ReleaseFacts;
  readonly quality: Quality;
  readonly accepted: boolean;
  readonly rank: number | null;
  readonly score: number;
  readonly rejection?: RejectionCode;
  readonly reasons: readonly Reason[];
}

export interface SelectionResult {
  readonly target: MediaTarget;
  /** Every candidate, accepted first then rejected — none silently dropped. */
  readonly candidates: readonly CandidateDecision[];
  readonly winner?: CandidateDecision;
}

export interface DecisionPolicy {
  readonly profile: QualityProfile;
  readonly preferences: readonly PreferenceRule[];
  /** What is already held for this target, if anything. */
  readonly current?: {
    readonly quality: Quality;
    readonly formatScore: number;
  } | null;
  /** Releases already known to be broken. They are never chosen again. */
  readonly isBlocklisted?: (release: IndexerRelease) => boolean;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Marks, punctuation and articles removed, so "The Expanse" matches
 * `Expanse`, "Folie à Deux" matches `Folie.a.Deux` and "Ocean's Eleven"
 * matches `Oceans.Eleven`.
 */
function comparableTitle(value: string): string {
  return foldLatin(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two titles name the same work.
 *
 * This used to accept either title as a prefix of the other, and that is not
 * an identity test in either direction. A season search for `Chernobyl`
 * accepted — and recommended — `Chernobyl.Inside.the.Meltdown.S01`, a
 * different programme entirely; the same rule would take `Gladiator II` for
 * `Gladiator`, and in the other direction `Pirates of the Caribbean` for a
 * specific film in that series. A film target usually survived it only
 * because the year check caught the impostor afterwards, and a season target
 * has no year to be caught by.
 *
 * Equality is the right rule here precisely because the comparison does not
 * run on raw release names. `parseRelease` has already lifted out the year,
 * the season and episode, the edition, the source, the resolution, the codec
 * and the release group, and `comparableTitle` then removes punctuation and
 * articles. A word still standing after all of that is part of the title, and
 * a title with an extra word in it is a different title.
 *
 * So this rejects extra words while leaving every legitimate decoration to be
 * stripped where it is already understood, rather than tolerated here.
 */
function titlesMatch(candidate: string, wanted: string): boolean {
  const left = comparableTitle(candidate);
  const right = comparableTitle(wanted);
  if (left === "" || right === "") return false;
  return left === right;
}

/**
 * Whether the release is of the thing that was asked for.
 *
 * A year may differ by one: a film released in December is routinely tagged
 * with the following year by one indexer and the previous by another. Two
 * years apart is a different film.
 */
function matchTarget(
  facts: ReleaseFacts,
  target: MediaTarget,
): { ok: true } | { ok: false; code: RejectionCode; detail: string } {
  const names = [target.title, ...(target.aliases ?? [])];
  if (!names.some((name) => titlesMatch(facts.normalizedTitle, name))) {
    return {
      ok: false,
      code: "title-mismatch",
      detail: `Reads as "${facts.normalizedTitle}", not "${target.title}".`,
    };
  }

  if (target.kind === "movie") {
    if (facts.kind === "episode" || facts.kind === "season") {
      return {
        ok: false,
        code: "wrong-kind",
        detail: "This is a television release.",
      };
    }
    if (target.year !== undefined && facts.year !== undefined) {
      const drift = Math.abs(facts.year - target.year);
      if (drift > 1) {
        return {
          ok: false,
          code: "wrong-year",
          detail: `Dated ${facts.year}, not ${target.year}.`,
        };
      }
    }
    return { ok: true };
  }

  if (target.kind === "series") return matchSeries(facts, target);

  const range = facts.episodeRanges.find(
    (entry) => entry.season === target.season,
  );
  if (!range) {
    return {
      ok: false,
      code: "wrong-season",
      detail:
        facts.episodeRanges.length === 0
          ? "Names no season."
          : `Covers season ${facts.episodeRanges.map((r) => r.season).join(", ")}, not ${target.season}.`,
    };
  }

  if (target.kind === "season") {
    // A pack satisfies a season; a single episode does not.
    if (range.episodes.length > 0) {
      return {
        ok: false,
        code: "wrong-kind",
        detail: "This is an episode, not a season.",
      };
    }
    return INCOMPLETE.test(facts.rawTitle) ? INCOMPLETE_PACK : { ok: true };
  }

  // A whole-season pack contains the episode; otherwise it must be listed.
  if (range.episodes.length === 0 || range.episodes.includes(target.episode)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "wrong-episode",
    detail: `Covers episode ${range.episodes.join(", ")}, not ${target.episode}.`,
  };
}

/**
 * Whether a release is the whole series.
 *
 * Either it names its seasons as packs (`S01-S10`) and they include every
 * season wanted, or it names none and says it is complete. A release that
 * names no season and does not say so is more likely a special or a film
 * of the same name than the series.
 */
function matchSeries(
  facts: ReleaseFacts,
  target: Extract<MediaTarget, { kind: "series" }>,
): { ok: true } | { ok: false; code: RejectionCode; detail: string } {
  if (facts.episodeRanges.some((range) => range.episodes.length > 0)) {
    return {
      ok: false,
      code: "wrong-kind",
      detail: "This is an episode, not the whole series.",
    };
  }
  if (INCOMPLETE.test(facts.rawTitle)) return INCOMPLETE_PACK;
  const covered = facts.episodeRanges.map((range) => range.season);
  if (covered.length === 0) {
    return COMPLETE_SERIES.test(facts.rawTitle)
      ? { ok: true }
      : {
          ok: false,
          code: "wrong-season",
          detail: "Names no season and does not say it is complete.",
        };
  }
  const wanted = target.seasons ?? [];
  const absent = wanted.filter((season) => !covered.includes(season));
  if (absent.length > 0) {
    return {
      ok: false,
      code: "wrong-season",
      detail: `Covers season ${covered.join(", ")}; season ${absent.join(", ")} is not in it.`,
    };
  }
  if (wanted.length === 0 && covered.length < 2) {
    return {
      ok: false,
      code: "wrong-kind",
      detail: `This is season ${covered[0]}, not the whole series.`,
    };
  }
  return { ok: true };
}

function judge(
  release: IndexerRelease,
  target: MediaTarget,
  policy: DecisionPolicy,
): CandidateDecision {
  const facts = parseRelease(release.title);
  const quality = qualityOf(facts);
  const score = scoreRelease(facts, policy.preferences);

  // Before anything else: a release that already failed for a reason of its
  // own is not a candidate however well it matches.
  if (policy.isBlocklisted?.(release)) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: null,
      score: score.total,
      rejection: "blocklisted",
      reasons: [
        { code: "blocklisted", detail: "This release is on the blocklist." },
      ],
    };
  }

  const match = matchTarget(facts, target);
  if (!match.ok) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: null,
      score: score.total,
      rejection: match.code,
      reasons: [{ code: match.code, detail: match.detail }],
    };
  }

  /*
   * A release that does not say how large it is passes: refusing it would
   * refuse every indexer that omits the size, and the size is checked against
   * what the indexer claimed, not what would land on disk.
   */
  const maxSizeBytes = policy.profile.maxSizeBytes;
  if (
    maxSizeBytes !== undefined &&
    release.sizeBytes !== undefined &&
    release.sizeBytes > maxSizeBytes
  ) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: null,
      score: score.total,
      rejection: "too-large",
      reasons: [
        {
          code: "too-large",
          detail: `${formatGigabytes(release.sizeBytes)} is larger than the ${formatGigabytes(maxSizeBytes)} ${policy.profile.name} allows.`,
        },
      ],
    };
  }

  const verdict = evaluateQuality(quality, policy.profile, score.total);
  const reasons: Reason[] = [...verdict.reasons, ...scoreReasons(score)];
  if (!verdict.allowed) {
    const rejection = verdict.reasons.find((reason) =>
      ["quality-not-allowed", "quality-unknown", "below-format-score"].includes(
        reason.code,
      ),
    );
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: verdict.rank,
      score: score.total,
      rejection: (rejection?.code ?? "quality-not-allowed") as RejectionCode,
      reasons,
    };
  }

  const upgrade = evaluateUpgrade(
    verdict,
    policy.current ?? null,
    policy.profile,
    score.total,
  );
  if (!upgrade.wanted) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: verdict.rank,
      score: score.total,
      rejection: "upgrade-not-wanted",
      reasons: [...reasons, ...upgrade.reasons],
    };
  }

  return {
    release,
    facts,
    quality,
    accepted: true,
    rank: verdict.rank,
    score: score.total,
    reasons: [...reasons, ...upgrade.reasons],
  };
}

/**
 * The order two accepted candidates are preferred in.
 *
 * Each rung is a claim that can be defended on its own:
 *
 * 1. profile rank — the user said which quality they want
 * 2. preference score — then what they said they like
 * 3. revision — a PROPER exists because the first attempt was broken
 * 4. intrinsic quality — separates qualities the profile grouped together
 * 5. size — at identical quality, more bits is less compression
 * 6. identifier — so the answer is stable when nothing else distinguishes them
 *
 * Never returns 0 for two different releases, which is the point: a zero here
 * would let the provider's response order pick the winner.
 */
export function compareCandidates(
  left: CandidateDecision,
  right: CandidateDecision,
): number {
  if (left.accepted !== right.accepted) return left.accepted ? -1 : 1;
  const byRank = (right.rank ?? -1) - (left.rank ?? -1);
  if (byRank !== 0) return byRank;
  const byScore = right.score - left.score;
  if (byScore !== 0) return byScore;
  const byRevision = right.facts.revision - left.facts.revision;
  if (byRevision !== 0) return byRevision;
  const byQuality = breakQualityTie(left.quality, right.quality);
  if (byQuality !== 0) return byQuality;
  const bySize = (right.release.sizeBytes ?? 0) - (left.release.sizeBytes ?? 0);
  if (bySize !== 0) return bySize;
  if (left.release.guid === right.release.guid) return 0;
  return left.release.guid < right.release.guid ? -1 : 1;
}

export function selectRelease(
  target: MediaTarget,
  candidates: readonly IndexerRelease[],
  policy: DecisionPolicy,
): SelectionResult {
  const decided = candidates.map((release) => judge(release, target, policy));
  const ordered = [...decided].sort(compareCandidates);
  const winner = ordered.find((candidate) => candidate.accepted);
  return {
    target,
    candidates: ordered,
    ...(winner === undefined ? {} : { winner }),
  };
}
