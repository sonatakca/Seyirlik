/**
 * What one build of the frontend is, stamped in at build time.
 *
 * The same object is compiled into the bundle (`__SEYIRLIK_BUILD__`), written
 * beside it as `/version.json`, and named in index.html's
 * `<meta name="seyirlik-build">`. A tab compares the first with the second to
 * learn a newer build is live, and reads the third out of the service worker's
 * precache to learn whether that precache would still serve the old one.
 */
export interface BuildInfo {
  /** What a person reads: the build date, then the commit when known. */
  version: string;
  /** Unique to this build; the only field compared. */
  buildId: string;
  commit: string | null;
  builtAt: string;
  /** What this release changed (`release-note.json`); absent on older builds. */
  note?: ReleaseNote | null;
}

/**
 * What a release changed, in a few words, in both of the site's languages:
 * "Faster imports during encodes". Written by whoever ships, in
 * `release-note.json` at the repository root; `deploy/ship.sh` refuses a
 * release whose note is missing, too long, or the one already live.
 */
export interface ReleaseNote {
  en: string;
  tr: string;
}

export const RELEASE_NOTE_FILE = "release-note.json";
const NOTE_MIN_WORDS = 2;
const NOTE_MAX_WORDS = 5;
const NOTE_MAX_CHARACTERS = 40;

/** Why this cannot be a release note, or null when it can. */
export function releaseNoteProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 'it must be {"en": "...", "tr": "..."}';
  }
  for (const language of ["en", "tr"] as const) {
    const text = (value as Record<string, unknown>)[language];
    if (typeof text !== "string" || !text.trim()) {
      return `"${language}" is missing`;
    }
    const words = text.trim().split(/\s+/).length;
    if (words < NOTE_MIN_WORDS || words > NOTE_MAX_WORDS) {
      return `"${language}" has ${words} word${words === 1 ? "" : "s"}; it needs ${NOTE_MIN_WORDS} to ${NOTE_MAX_WORDS}`;
    }
    if (text.trim().length > NOTE_MAX_CHARACTERS) {
      return `"${language}" is longer than ${NOTE_MAX_CHARACTERS} characters`;
    }
    // The hash is shown beside it already; the note says what changed.
    if (/\b[0-9a-f]{7,40}\b/i.test(text)) {
      return `"${language}" names a commit; say what changed instead`;
    }
  }
  return null;
}

/** The note in a release-note file, or null when it is not a usable one. */
export function parseReleaseNote(text: string): ReleaseNote | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (releaseNoteProblem(value) !== null) return null;
  const note = value as ReleaseNote;
  return { en: note.en.trim(), tr: note.tr.trim() };
}

export const BUILD_META_NAME = "seyirlik-build";

interface BuildFacts {
  commit: string | null;
  /** Tracked files differed from the commit when this was built. */
  dirty: boolean;
  builtAt: Date;
  note?: ReleaseNote | null;
}

export function describeBuild({
  commit,
  dirty,
  builtAt,
  note = null,
}: BuildFacts): BuildInfo {
  const date = builtAt.toISOString().slice(0, 10).replaceAll("-", ".");
  const shortCommit = commit ? commit.slice(0, 7) : null;
  const source = shortCommit ? `${shortCommit}${dirty ? "+dirty" : ""}` : null;

  return {
    version: source ? `${date} · ${source}` : date,
    // Two builds of one commit can still differ (a dirty tree, another
    // environment), so the build time is part of the identity.
    buildId: `${source ?? "nogit"}-${builtAt.getTime().toString(36)}`,
    commit,
    builtAt: builtAt.toISOString(),
    note,
  };
}

/** The build named by an index.html, or null when it names none. */
export function readBuildIdFromHtml(html: string): string | null {
  const match = new RegExp(
    `<meta\\s+name="${BUILD_META_NAME}"\\s+content="([^"]+)"`,
  ).exec(html);
  return match ? match[1] : null;
}

/**
 * How a build is named to a person: the commit, then the day, month and time
 * it was built, in their own time zone — "259b523 · 5 Ekim 19:54". Several
 * builds can go out in one day, so the time is what tells them apart.
 */
export function formatBuildLabel(
  build: Pick<BuildInfo, "builtAt" | "commit">,
  language: "en" | "tr",
  timeZone?: string,
): string {
  const builtAt = new Date(build.builtAt);
  const parts = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
    day: "numeric",
    // "Ekim" in Turkish is already short; English abbreviates to "Oct".
    month: language === "tr" ? "long" : "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(builtAt);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const when = `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}`;
  return build.commit ? `${build.commit.slice(0, 7)} · ${when}` : when;
}
