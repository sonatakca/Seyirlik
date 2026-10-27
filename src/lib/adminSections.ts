/**
 * The administration surface, as one list rather than several.
 *
 * Before this there were two descriptions of what administration contains: a
 * grid of cards on one page, and the route table. Adding a section meant
 * editing both, and forgetting either produced a link to nothing or a page
 * nobody could reach. This module is the description; the page renders it and
 * a test holds the route table to it.
 *
 * The translation keys are typed rather than left as strings, so a section
 * naming a key that does not exist fails to compile instead of rendering the
 * key to an operator.
 *
 * It is also grouped, which is the point of the exercise. Twenty equally
 * prominent cards are unreadable, and worse, they ask the reader to know which
 * subsystem owns a task before they can find it. The groups are errands
 * instead: the reader chooses between seven kinds of work, and the vocabulary
 * of the backend never has to be learned.
 */

import type { TranslationKey } from "../i18n/translations";

/**
 * What a section is for, which is what decides where it is listed.
 *
 * The groups name tasks an operator already has a word for, not the
 * subsystems behind them. "Wanted & downloads" is one group because wanting a
 * film, choosing a release for it and downloading it is one errand — it was
 * three groups' worth of vocabulary (monitoring, decisions, acquisitions)
 * before anyone could find where to ask for a film.
 */
export type AdminGroupId =
  /** The catalogue itself: scanning it, describing it, taking things into it. */
  | "library"
  /** Asking for something and getting it: wanted, releases, downloads. */
  | "downloads"
  /** Subtitles, which are their own errand and their own failure modes. */
  | "subtitles"
  /** Playing things: what broke, what is being prepared, what the defaults are. */
  | "playback"
  /** The machine and who may use it. */
  | "system"
  /** What the library looks like to someone browsing it. */
  | "curation"
  /**
   * Building Seyirlik, not running it.
   *
   * Deliberately last and deliberately its own group: "Wanted features" is a
   * development backlog and must never be mistaken for wanted *media*, which
   * lives under downloads.
   */
  | "development";

export interface AdminSection {
  /** Stable identity, independent of the route or the title. */
  readonly id: string;
  readonly group: AdminGroupId;
  /** The route this section lives at. */
  readonly path: string;
  /** Translation keys; the registry holds no display text of its own. */
  readonly titleKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
  readonly tagKey: TranslationKey;
  /** Named rather than imported, so this module pulls in no icon set. */
  readonly icon: AdminIconName;
  /**
   * Only shown in a development build.
   *
   * The one section that is genuinely not for an operator; kept in the
   * registry rather than special-cased at the page, so the list of what exists
   * stays in one place.
   */
  readonly devOnly?: boolean;
}

/** Icons the administration page knows how to draw. */
export type AdminIconName =
  | "activity"
  | "bug"
  | "database"
  | "databaseZap"
  | "download"
  | "fileVideo"
  | "hardDrive"
  | "headphones"
  | "heartPulse"
  | "images"
  | "languages"
  | "lightbulb"
  | "listOrdered"
  | "panelsTopLeft"
  | "plug"
  | "save"
  | "serverCog"
  | "shieldAlert"
  | "subtitles"
  | "target"
  | "users";

export interface AdminGroup {
  readonly id: AdminGroupId;
  readonly titleKey: TranslationKey;
  readonly descriptionKey: TranslationKey;
}

export const ADMIN_GROUPS: readonly AdminGroup[] = [
  {
    id: "library",
    titleKey: "admin.group.library.title",
    descriptionKey: "admin.group.library.description",
  },
  {
    id: "downloads",
    titleKey: "admin.group.downloads.title",
    descriptionKey: "admin.group.downloads.description",
  },
  {
    id: "subtitles",
    titleKey: "admin.group.subtitles.title",
    descriptionKey: "admin.group.subtitles.description",
  },
  {
    id: "playback",
    titleKey: "admin.group.playback.title",
    descriptionKey: "admin.group.playback.description",
  },
  {
    id: "system",
    titleKey: "admin.group.system.title",
    descriptionKey: "admin.group.system.description",
  },
  {
    id: "curation",
    titleKey: "admin.group.curation.title",
    descriptionKey: "admin.group.curation.description",
  },
  {
    id: "development",
    titleKey: "admin.group.development.title",
    descriptionKey: "admin.group.development.description",
  },
];

/*
 * Existing sections keep the routes they already had. Renaming `/dev/...` to
 * `/admin/...` would break every bookmark and every link back from a dozen
 * pages, for a gain that is entirely cosmetic — the grouping and the naming on
 * the page are what make this an operations surface rather than a toolbox.
 *
 * Order within a group is the order an operator meets the work, not
 * alphabetical: scan the library before describing what is in it, want a film
 * before choosing a release for it, choose a release before downloading it.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  // ---- library: every title, and the work done across all of them
  {
    id: "library",
    group: "library",
    path: "/admin/library",
    titleKey: "library.title",
    descriptionKey: "library.pageDescription",
    tagKey: "library.tag",
    icon: "database",
  },
  {
    id: "library-maintenance",
    group: "library",
    path: "/dev/library-maintenance",
    titleKey: "devtools.card.libraryMaintenance.title",
    descriptionKey: "devtools.card.libraryMaintenance.description",
    tagKey: "devtools.card.libraryMaintenance.tag",
    icon: "databaseZap",
  },
  {
    // Listening through a book read aloud for the lines the voice got wrong,
    // and putting them right: a word's pronunciation, a line read again.
    id: "narration",
    group: "library",
    path: "/admin/narration",
    titleKey: "admin.narration.title",
    descriptionKey: "admin.narration.description",
    tagKey: "admin.narration.tag",
    icon: "headphones",
  },
  {
    // Going down the whole list choosing covers and logos is its own errand;
    // the title workspace edits one title at a time.
    id: "tmdb-artwork",
    group: "library",
    path: "/dev/tmdb-artwork",
    titleKey: "devtools.card.tmdbArtwork.title",
    descriptionKey: "devtools.card.tmdbArtwork.description",
    tagKey: "devtools.card.tmdbArtwork.tag",
    icon: "images",
  },

  // ---- downloads: choose a release, fetch it, take it in
  {
    id: "decisions",
    group: "downloads",
    path: "/admin/decisions",
    titleKey: "admin.decisions.title",
    descriptionKey: "admin.decisions.description",
    tagKey: "admin.decisions.tag",
    icon: "listOrdered",
  },
  {
    id: "acquisitions",
    group: "downloads",
    path: "/admin/acquisitions",
    titleKey: "admin.acquisitions.title",
    descriptionKey: "admin.acquisitions.description",
    tagKey: "admin.acquisitions.tag",
    icon: "download",
  },
  {
    id: "imports",
    group: "downloads",
    path: "/admin/imports",
    titleKey: "admin.imports.title",
    descriptionKey: "admin.imports.description",
    tagKey: "admin.imports.tag",
    icon: "hardDrive",
  },

  // ---- subtitles
  {
    id: "subtitles",
    group: "subtitles",
    path: "/admin/subtitles",
    titleKey: "admin.subtitles.title",
    descriptionKey: "admin.subtitles.description",
    tagKey: "admin.subtitles.tag",
    icon: "subtitles",
  },

  // ---- playback: why something will not play, and what is being prepared
  {
    id: "playback-diagnostics",
    group: "playback",
    path: "/dev/playback",
    titleKey: "devtools.card.playbackDiagnostics.title",
    descriptionKey: "devtools.card.playbackDiagnostics.description",
    tagKey: "devtools.card.playbackDiagnostics.tag",
    icon: "activity",
  },
  {
    id: "media-processing",
    group: "playback",
    path: "/dev/media-processing",
    titleKey: "devtools.card.mediaProcessing.title",
    descriptionKey: "devtools.card.mediaProcessing.description",
    tagKey: "devtools.card.mediaProcessing.tag",
    icon: "fileVideo",
  },

  // ---- system: the machine, what it is wired to, and who may use it
  {
    id: "health",
    group: "system",
    path: "/admin/health",
    titleKey: "admin.health.title",
    descriptionKey: "admin.health.description",
    tagKey: "admin.health.tag",
    icon: "heartPulse",
  },
  {
    id: "integrations",
    group: "system",
    path: "/admin/integrations",
    titleKey: "admin.integrations.title",
    descriptionKey: "admin.integrations.description",
    tagKey: "admin.integrations.tag",
    icon: "plug",
  },
  {
    id: "alerts",
    group: "system",
    // Outside the admin area on purpose: it has to open while the server is
    // down, which the admin area cannot.
    path: "/alerts",
    titleKey: "admin.alerts.title",
    descriptionKey: "admin.alerts.description",
    tagKey: "admin.alerts.tag",
    icon: "shieldAlert",
  },
  {
    id: "users",
    group: "system",
    path: "/dev/users",
    titleKey: "devtools.card.userManagement.title",
    descriptionKey: "devtools.card.userManagement.description",
    tagKey: "devtools.card.userManagement.tag",
    icon: "users",
  },

  // ---- curation
  {
    id: "curation",
    group: "curation",
    path: "/dev/curation",
    titleKey: "devtools.card.curation.title",
    descriptionKey: "devtools.card.curation.description",
    tagKey: "devtools.card.curation.tag",
    icon: "listOrdered",
  },

  // ---- development: building Seyirlik, not running it
  {
    id: "skeleton-lab",
    group: "development",
    path: "/dev/skeleton-lab",
    titleKey: "devtools.card.skeletonLab.title",
    descriptionKey: "devtools.card.skeletonLab.description",
    tagKey: "devtools.card.skeletonLab.tag",
    icon: "panelsTopLeft",
    devOnly: true,
  },
];

/**
 * Tools that were merged into another, and where their address now leads.
 *
 * Monitoring and Content Explorer became the Library and its title
 * workspace; Playback Audit and Playback Health became the two tabs of
 * Playback diagnostics; Server Control became a section of Health. Playback
 * Defaults saved nothing the server kept, and the two development boards were
 * notes held in one browser's storage, so they were removed rather than moved.
 */
export const ADMIN_REDIRECTS: Readonly<Record<string, string>> = {
  "/admin/monitoring": "/admin/library",
  "/dev/content": "/admin/library",
  "/dev/playback-defaults": "/admin/library",
  "/dev/playback-audit": "/dev/playback?tab=titles",
  "/dev/playback-health": "/dev/playback?tab=network",
  "/dev/server-control": "/admin/health",
  "/dev/known-bugs": "/admin",
  "/dev/wanted-features": "/admin",
};

/** The sections of one group, in registry order. */
export function sectionsInGroup(
  group: AdminGroupId,
  { includeDevOnly }: { includeDevOnly: boolean },
): AdminSection[] {
  return ADMIN_SECTIONS.filter(
    (section) =>
      section.group === group && (includeDevOnly || section.devOnly !== true),
  );
}

/** Groups that have something to show, so an empty heading is never drawn. */
export function visibleGroups({
  includeDevOnly,
}: {
  includeDevOnly: boolean;
}): Array<{ group: AdminGroup; sections: AdminSection[] }> {
  return ADMIN_GROUPS.map((group) => ({
    group,
    sections: sectionsInGroup(group.id, { includeDevOnly }),
  })).filter((entry) => entry.sections.length > 0);
}

/**
 * Routes that render a section they are not named after.
 *
 * `/dev/home-curation` is the curation editor under the name it had when it
 * only edited the home page. It is kept so old links land somewhere real, and
 * mapped here so opening it still highlights Curation in the navigation
 * instead of highlighting nothing.
 */
export const ADMIN_PATH_ALIASES: Readonly<Record<string, string>> = {
  "/dev/home-curation": "/dev/curation",
};

/** Routes that render the administration index rather than a section. */
export const ADMIN_INDEX_PATHS: readonly string[] = ["/admin", "/dev"];

/** Strips a trailing slash so `/admin/health/` matches `/admin/health`. */
function normalisePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The section a route belongs to, or undefined for the index and for anything else. */
export function sectionForPath(pathname: string): AdminSection | undefined {
  const normalised = normalisePath(pathname);
  const resolved = ADMIN_PATH_ALIASES[normalised] ?? normalised;
  return (
    ADMIN_SECTIONS.find((section) => section.path === resolved) ??
    // A page beneath a section — one title under Library — belongs to it.
    ADMIN_SECTIONS.find((section) => resolved.startsWith(`${section.path}/`))
  );
}

/** Whether a route is the administration index itself. */
export function isAdminIndexPath(pathname: string): boolean {
  return ADMIN_INDEX_PATHS.includes(normalisePath(pathname));
}

/** The group a section sits in, for a breadcrumb that names where you are. */
export function groupForSection(section: AdminSection): AdminGroup {
  const group = ADMIN_GROUPS.find(
    (candidate) => candidate.id === section.group,
  );
  /* istanbul ignore next -- the registry test proves every group exists. */
  if (!group) throw new Error(`Unknown administration group: ${section.group}`);
  return group;
}
